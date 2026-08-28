import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createActivityClass,
  createActivityGroup,
  createActivityMembership,
  createActivityParticipant,
  editActivityClass,
  editActivityGroup,
  editActivityMembership,
  editActivityParticipant,
  setActivityAttendance,
} from '../../worker/core/activities.js'
import { openActivityPayload } from '../../worker/core/activity-crypto.js'
import {
  createD1QueryBudget,
  usageForD1QueryBudgetViews,
} from '../../worker/db/query-budget.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = Date.parse('2027-03-05T08:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const CORRELATION_ID = '1a9faee7-33ef-4e35-a7dc-d8e0d31a4fb9'
const owner = Object.freeze({
  id: 'stf_activity_commands_owner', role: 'owner', specialistId: null, version: 1,
})
const coordinator = Object.freeze({
  id: 'stf_activity_commands_coordinator', role: 'coordinator',
  specialistId: null, version: 1,
})
const therapist = Object.freeze({
  id: 'stf_activity_commands_specialist', role: 'specialist',
  specialistId: 'sp_activity_commands_alpha', version: 1,
})
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
let keyring
let serial = 0
let groupResult
const idFactory = () => `activity_command_${++serial}`

const input = (overrides = {}) => ({
  db: env.DB,
  recoveryDb: env.DB,
  actor: owner,
  keyring,
  nowMs: NOW_MS,
  correlationId: CORRELATION_ID,
  idFactory,
  idempotencyKey: 'activity-group-create-0001',
  body: {
    programId: 'apg_tus',
    label: 'Fikcyjna grupa Komety',
    details: 'Grupa popołudniowa',
    leaderSpecialistIds: [
      'sp_activity_commands_beta', 'sp_activity_commands_alpha',
    ],
  },
  ...overrides,
})

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  keyring = await createKeyring({
    BWM_DATA_KEK_V1: key(41), BWM_LOOKUP_HMAC_V1: key(42),
  }, { activeDataKekVersion: 1, activeLookupKeyVersion: 1 })
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,'activity_commands_owner_lookup','{}','{}','owner','active',
       'activity-commands-owner',NULL,1,?,NULL,?,?)`).bind(owner.id, NOW, NOW, NOW),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,'activity_commands_specialist_lookup','{}','{}','specialist','active',
       'activity-commands-specialist','sp_activity_commands_alpha',1,?,NULL,?,?)`)
      .bind(therapist.id, NOW, NOW, NOW),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,'activity_commands_coordinator_lookup','{}','{}','coordinator','active',
       'activity-commands-coordinator',NULL,1,?,NULL,?,?)`)
      .bind(coordinator.id, NOW, NOW, NOW),
  ])
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
       archived_at,created_at,updated_at)
      VALUES ('sp_activity_commands_alpha',?,'{}',18000,'active',1,NULL,?,?)`)
      .bind(therapist.id, NOW, NOW),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
       archived_at,created_at,updated_at)
      VALUES ('sp_activity_commands_beta',NULL,'{}',18000,'active',1,NULL,?,?)`)
      .bind(NOW, NOW),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
       archived_at,created_at,updated_at)
      VALUES ('sp_activity_commands_archived',NULL,'{}',18000,'archived',1,?, ?,?)`)
      .bind(NOW, NOW, NOW),
  ])
  await env.DB.batch(Array.from({ length: 18 }, (_, index) => env.DB.prepare(
    `INSERT INTO specialists
     (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
      archived_at,created_at,updated_at)
     VALUES (?,NULL,'{}',18000,'active',1,NULL,?,?)`,
  ).bind(
    `sp_activity_commands_${String(index + 1).padStart(2, '0')}`, NOW, NOW,
  )))
})

describe('native activity commands', () => {
  it('creates one encrypted group graph atomically and replays the exact 201 response', async () => {
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const created = await createActivityGroup(input({
      db: budget.work, recoveryDb: budget.recovery,
    }))
    groupResult = created.body.data
    expect(created).toMatchObject({
      status: 201,
      body: { data: {
        group: {
          programId: 'apg_tus', label: 'Fikcyjna grupa Komety',
          details: 'Grupa popołudniowa', status: 'active', version: 1,
        },
      } },
    })
    expect(created.body.data.groupLeaders.map(({ specialistId }) => specialistId))
      .toEqual(['sp_activity_commands_alpha', 'sp_activity_commands_beta'])
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery).used)
      .toBeLessThanOrEqual(42)

    const persisted = await env.DB.prepare(`SELECT label_envelope,details_envelope
      FROM activity_groups WHERE id=?`).bind(created.body.data.group.id).first()
    expect(JSON.stringify(persisted)).not.toContain('Fikcyjna grupa Komety')
    expect(JSON.stringify(persisted)).not.toContain('Grupa popołudniowa')
    const versions = (await env.DB.prepare(`SELECT entity_type,entity_id,snapshot_envelope
      FROM record_versions WHERE entity_id=? OR entity_id IN (
        SELECT id FROM activity_group_leaders WHERE group_id=?
      ) ORDER BY entity_type,entity_id`).bind(
      created.body.data.group.id, created.body.data.group.id,
    ).all()).results
    expect(versions).toHaveLength(3)
    const leaderVersion = versions.find(({ entity_type }) => (
      entity_type === 'activity_group_leader'
    ))
    const dataKey = await env.DB.prepare(`SELECT id,scope_type,scope_id,purpose,
      dek_version,wrapped_key_b64,wrap_nonce_b64,kek_version,created_at,retired_at
      FROM data_keys WHERE id=json_extract(?,'$.dataKeyId')`)
      .bind(leaderVersion.snapshot_envelope).first()
    await expect(openActivityPayload(keyring, dataKey, {
      recordId: leaderVersion.entity_id,
      field: 'record_version',
      envelope: leaderVersion.snapshot_envelope,
    })).resolves.toMatchObject({ schema: 'activity_group_leader.v1', version: 1 })
    expect(await env.DB.prepare(`SELECT action,entity_type,entity_id,metadata_json
      FROM audit_events WHERE entity_id=?`).bind(created.body.data.group.id).first())
      .toEqual({
        action: 'activity.group.created', entity_type: 'activity_group',
        entity_id: created.body.data.group.id,
        metadata_json: '{"groupVersion":1,"leaderCount":2}',
      })

    const replayBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    await expect(createActivityGroup(input({
      db: replayBudget.work, recoveryDb: replayBudget.recovery,
    }))).resolves.toEqual(created)
    expect(usageForD1QueryBudgetViews(
      replayBudget.work, replayBudget.recovery,
    ).used).toBeLessThanOrEqual(8)
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM activity_groups
      WHERE id=?`).bind(created.body.data.group.id).first()).toEqual({ count: 1 })

    await expect(createActivityGroup(input({
      body: { ...input().body, details: 'Inna treść' },
    }))).rejects.toThrow(/^IDEMPOTENCY_CONFLICT$/)
  })

  it('denies specialist creation and rejects inactive leader authority before writes', async () => {
    await expect(createActivityGroup(input({
      actor: therapist, idempotencyKey: 'activity-group-create-denied-0001',
    }))).rejects.toThrow(/^FORBIDDEN$/)
    await expect(createActivityGroup(input({
      idempotencyKey: 'activity-group-create-archived-0001',
      body: {
        ...input().body,
        label: 'Fikcyjna grupa z błędnym prowadzącym',
        leaderSpecialistIds: ['sp_activity_commands_archived'],
      },
    }))).rejects.toThrow(/^NOT_FOUND$/)
  })

  it('orders created leaders by durable ID even when generation order is non-monotonic', async () => {
    const generated = [
      'ordered_key', 'ordered_group', 'z_leader', 'a_leader',
      'version_group', 'version_z', 'version_a', 'audit_ordered',
    ]
    let fallback = 0
    const reverseIdFactory = () => generated.shift() ?? `ordered_fallback_${++fallback}`
    const command = input({
      idFactory: reverseIdFactory,
      idempotencyKey: 'activity-group-create-ordered-0001',
      body: {
        ...input().body,
        label: 'Fikcyjna grupa uporządkowana',
      },
    })
    const created = await createActivityGroup(command)
    const leaderIds = created.body.data.groupLeaders.map(({ id }) => id)
    expect(leaderIds).toEqual([...leaderIds].sort((left, right) => left.localeCompare(right)))
    expect(created.body.data.groupLeaders.map(({ specialistId }) => specialistId).sort())
      .toEqual([...command.body.leaderSpecialistIds].sort())
    await expect(createActivityGroup(command)).resolves.toEqual(created)
  })

  it('runs every versioned native activity lifecycle without a money command', async () => {
    const groupEditCommand = input({
      groupId: groupResult.group.id,
      idempotencyKey: 'activity-group-edit-0001',
      body: {
        expectedVersion: 1,
        label: 'Fikcyjna grupa Komety — starsi',
        details: null,
        status: 'active',
        leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    })
    const editedGroup = await editActivityGroup(groupEditCommand)
    expect(editedGroup).toMatchObject({
      status: 200,
      body: { data: {
        group: { id: groupResult.group.id, version: 2, details: null },
        groupLeaders: [{ specialistId: 'sp_activity_commands_alpha' }],
      } },
    })
    await expect(editActivityGroup(groupEditCommand)).resolves.toEqual(editedGroup)

    const participant = (await createActivityParticipant(input({
      idempotencyKey: 'activity-participant-create-0001',
      body: {
        programId: 'apg_tus', name: 'Fikcyjna Alicja Kometowa',
        clientId: null, historicalClientId: null,
      },
    }))).body.data.participant
    expect(participant).toMatchObject({
      programId: 'apg_tus', status: 'active', version: 1,
    })
    const participantEditCommand = input({
      participantId: participant.id,
      idempotencyKey: 'activity-participant-edit-0001',
      body: {
        expectedVersion: 1, name: 'Fikcyjna Alicja Kometowa Nowa',
        clientId: null, historicalClientId: null, status: 'active',
      },
    })
    const participantEditResponse = await editActivityParticipant(participantEditCommand)
    const editedParticipant = participantEditResponse.body.data.participant
    expect(editedParticipant).toMatchObject({ version: 2, status: 'active' })
    await expect(editActivityParticipant(participantEditCommand))
      .resolves.toEqual(participantEditResponse)

    const membership = (await createActivityMembership(input({
      idempotencyKey: 'activity-membership-create-0001',
      body: {
        participantId: participant.id, groupId: groupResult.group.id,
        startsOn: '2027-03-01', endsOn: '2027-06-30',
      },
    }))).body.data.membership
    expect(membership).toMatchObject({
      participantId: participant.id, groupId: groupResult.group.id,
      membershipKind: 'interval', status: 'active', version: 1,
    })
    await expect(editActivityParticipant(input({
      actor: therapist,
      participantId: participant.id,
      idempotencyKey: 'activity-participant-specialist-relink-0001',
      body: {
        expectedVersion: 2, name: 'Fikcyjna Alicja Kometowa Nowa',
        clientId: 'cl_guessed_centre_client', historicalClientId: null,
        status: 'active',
      },
    }))).rejects.toThrow(/^FORBIDDEN$/)

    const activityClass = (await createActivityClass(input({
      idempotencyKey: 'activity-class-create-0001',
      body: {
        groupId: groupResult.group.id, date: '2027-04-01', time: '16:00',
        durationMinutes: 60, topic: 'Fikcyjna współpraca', status: 'scheduled',
      },
    }))).body.data.class
    expect(activityClass).toMatchObject({ version: 1, status: 'scheduled' })

    const firstAttendance = (await setActivityAttendance(input({
      classId: activityClass.id,
      idempotencyKey: 'activity-attendance-create-0001',
      body: { participantId: participant.id, status: 'present', expectedVersion: 0 },
    }))).body.data.attendance
    expect(firstAttendance).toMatchObject({ status: 'present', version: 1 })
    const secondAttendance = (await setActivityAttendance(input({
      classId: activityClass.id,
      idempotencyKey: 'activity-attendance-edit-0001',
      body: { participantId: participant.id, status: 'excused', expectedVersion: 1 },
    }))).body.data.attendance
    expect(secondAttendance).toMatchObject({
      id: firstAttendance.id, status: 'excused', version: 2,
    })

    const completedClass = (await editActivityClass(input({
      classId: activityClass.id,
      idempotencyKey: 'activity-class-edit-0001',
      body: {
        expectedVersion: 1, date: '2027-04-01', time: '16:00',
        durationMinutes: 60, topic: 'Fikcyjna współpraca zakończona',
        status: 'completed',
      },
    }))).body.data.class
    expect(completedClass).toMatchObject({ status: 'completed', version: 2 })
    const closedMembership = (await editActivityMembership(input({
      membershipId: membership.id,
      idempotencyKey: 'activity-membership-edit-0001',
      body: {
        expectedVersion: 1, startsOn: '2027-03-01', endsOn: '2027-04-01',
        status: 'inactive',
      },
    }))).body.data.membership
    expect(closedMembership).toMatchObject({ status: 'inactive', version: 2 })

    const archivedParticipant = (await editActivityParticipant(input({
      participantId: participant.id,
      idempotencyKey: 'activity-participant-archive-0001',
      body: {
        expectedVersion: 2, name: 'Fikcyjna Alicja Kometowa Nowa',
        clientId: null, historicalClientId: null, status: 'inactive',
      },
    }))).body.data.participant
    expect(archivedParticipant).toMatchObject({ status: 'inactive', version: 3 })
    const correctedHistoricalAttendance = (await setActivityAttendance(input({
      classId: activityClass.id,
      idempotencyKey: 'activity-attendance-historical-edit-0001',
      body: { participantId: participant.id, status: 'absent', expectedVersion: 2 },
    }))).body.data.attendance
    expect(correctedHistoricalAttendance).toMatchObject({
      id: firstAttendance.id, status: 'absent', version: 3,
    })
    const archivedGroup = await editActivityGroup(input({
      groupId: groupResult.group.id,
      idempotencyKey: 'activity-group-archive-0001',
      body: {
        expectedVersion: 2, label: 'Fikcyjna grupa Komety — starsi', details: null,
        status: 'inactive', leaderSpecialistIds: [],
      },
    }))
    expect(archivedGroup).toMatchObject({
      body: { data: { group: { status: 'inactive', version: 3 }, groupLeaders: [] } },
    })

    const actionCounts = (await env.DB.prepare(`SELECT action,count(*) AS count
      FROM audit_events WHERE action LIKE 'activity.%'
        AND action!='activity.projection.advanced' GROUP BY action ORDER BY action`).all()).results
    expect(actionCounts).toEqual([
      { action: 'activity.attendance.set', count: 3 },
      { action: 'activity.class.created', count: 1 },
      { action: 'activity.class.updated', count: 1 },
      { action: 'activity.group.created', count: 2 },
      { action: 'activity.group.updated', count: 2 },
      { action: 'activity.membership.created', count: 1 },
      { action: 'activity.membership.updated', count: 1 },
      { action: 'activity.participant.created', count: 1 },
      { action: 'activity.participant.updated', count: 2 },
    ])
    expect(await env.DB.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name='activity_payments'`).first()).toBeNull()
    expect(await env.DB.prepare(`SELECT count(*) AS count
      FROM activity_group_lookup_aliases WHERE group_id=?`).bind(
      groupResult.group.id,
    ).first()).toEqual({ count: 2 })
    expect(await env.DB.prepare(`SELECT count(*) AS count
      FROM activity_participant_lookup_aliases WHERE participant_id=?`).bind(
      participant.id,
    ).first()).toEqual({ count: 2 })
  })

  it('preserves expired leader history and opens a new current assignment', async () => {
    const historicalNowMs = Date.parse('2026-01-05T08:00:00.000Z')
    const created = await createActivityGroup(input({
      nowMs: historicalNowMs,
      idempotencyKey: 'activity-group-create-expired-leader-0001',
      body: {
        programId: 'apg_tus', label: 'Fikcyjna grupa historyczna', details: null,
        leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    }))
    const group = created.body.data.group
    const expired = created.body.data.groupLeaders[0]
    await env.DB.prepare(`UPDATE activity_group_leaders SET ends_on='2026-12-31',
      version=2,updated_at=? WHERE id=?`).bind(NOW, expired.id).run()

    const edited = await editActivityGroup(input({
      groupId: group.id,
      idempotencyKey: 'activity-group-edit-expired-leader-0001',
      body: {
        expectedVersion: 1, label: 'Fikcyjna grupa historyczna wznowiona',
        details: null, status: 'active',
        leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    }))
    expect(edited.body.data.groupLeaders).toHaveLength(1)
    expect(edited.body.data.groupLeaders[0]).toMatchObject({
      specialistId: 'sp_activity_commands_alpha', startsOn: '2027-03-05',
      endsOn: null, status: 'active', version: 1,
    })
    expect(edited.body.data.groupLeaders[0].id).not.toBe(expired.id)
    expect(await env.DB.prepare(`SELECT ends_on,status,version,updated_at
      FROM activity_group_leaders WHERE id=?`).bind(expired.id).first()).toEqual({
      ends_on: '2026-12-31', status: 'active', version: 2, updated_at: NOW,
    })
    const unscopedParticipant = (await createActivityParticipant(input({
      idempotencyKey: 'activity-participant-create-unscoped-0001',
      body: {
        programId: 'apg_tus', name: 'Fikcyjna osoba spoza zakresu',
        clientId: null, historicalClientId: null,
      },
    }))).body.data.participant
    await expect(createActivityMembership(input({
      actor: therapist,
      idempotencyKey: 'activity-membership-specialist-leak-0001',
      body: {
        participantId: unscopedParticipant.id, groupId: group.id,
        startsOn: '2027-03-05', endsOn: null,
      },
    }))).rejects.toThrow(/^NOT_FOUND$/)
    const archived = await editActivityGroup(input({
      groupId: group.id,
      idempotencyKey: 'activity-group-archive-expired-leader-0001',
      body: {
        expectedVersion: 2, label: 'Fikcyjna grupa historyczna wznowiona',
        details: null, status: 'inactive', leaderSpecialistIds: [],
      },
    }))
    expect(archived.body.data).toMatchObject({
      group: { status: 'inactive', version: 3 }, groupLeaders: [],
    })
    expect(await env.DB.prepare(`SELECT ends_on,status,version FROM
      activity_group_leaders WHERE id=?`).bind(expired.id).first()).toEqual({
      ends_on: '2026-12-31', status: 'inactive', version: 3,
    })
    expect(await env.DB.prepare(`SELECT ends_on,status,version FROM
      activity_group_leaders WHERE id=?`).bind(
      edited.body.data.groupLeaders[0].id,
    ).first()).toEqual({
      ends_on: '2027-03-05', status: 'inactive', version: 2,
    })
  })

  it('keeps 20-leader create and edit within the ordinary 42-query allowance', async () => {
    const leaderSpecialistIds = [
      ...Array.from({ length: 18 }, (_, index) => (
        `sp_activity_commands_${String(index + 1).padStart(2, '0')}`
      )),
      'sp_activity_commands_alpha', 'sp_activity_commands_beta',
    ].sort()
    const createBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    const created = await createActivityGroup(input({
      db: createBudget.work, recoveryDb: createBudget.recovery,
      idempotencyKey: 'activity-group-create-twenty-leaders-0001',
      body: {
        programId: 'apg_tus', label: 'Fikcyjna grupa dwudziestu prowadzących',
        details: null, leaderSpecialistIds,
      },
    }))
    expect(created.body.data.groupLeaders).toHaveLength(20)
    expect(usageForD1QueryBudgetViews(createBudget.work, createBudget.recovery).used)
      .toBeLessThanOrEqual(42)

    const editBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    const edited = await editActivityGroup(input({
      db: editBudget.work, recoveryDb: editBudget.recovery,
      groupId: created.body.data.group.id,
      idempotencyKey: 'activity-group-edit-twenty-leaders-0001',
      body: {
        expectedVersion: 1, label: 'Fikcyjna grupa jednego prowadzącego',
        details: null, status: 'active',
        leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    }))
    expect(edited.body.data.groupLeaders).toHaveLength(1)
    expect(usageForD1QueryBudgetViews(editBudget.work, editBudget.recovery).used)
      .toBeLessThanOrEqual(42)
  })

  it('reauthorizes a direct-ID replay after specialist scope is revoked', async () => {
    const created = await createActivityGroup(input({
      idempotencyKey: 'activity-group-create-replay-scope-0001',
      body: {
        programId: 'apg_tus', label: 'Fikcyjna grupa autoryzacji', details: null,
        leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    }))
    const group = created.body.data.group
    const specialistEdit = input({
      actor: therapist, groupId: group.id,
      idempotencyKey: 'activity-group-edit-replay-scope-0001',
      body: {
        expectedVersion: 1, label: 'Fikcyjna grupa po edycji specjalistki',
        details: null, status: 'active',
        leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    })
    await expect(editActivityGroup(specialistEdit)).resolves.toMatchObject({
      body: { data: { group: { version: 2 } } },
    })
    await editActivityGroup(input({
      groupId: group.id,
      idempotencyKey: 'activity-group-edit-revoke-scope-0001',
      body: {
        expectedVersion: 2, label: 'Fikcyjna grupa bez prowadzącej',
        details: null, status: 'active', leaderSpecialistIds: [],
      },
    }))
    await expect(editActivityGroup(specialistEdit)).rejects.toThrow(/^NOT_FOUND$/)
  })

  it('conceals class creation when specialist leadership excludes the target date', async () => {
    const created = await createActivityGroup(input({
      idempotencyKey: 'activity-group-create-class-date-scope-0001',
      body: {
        programId: 'apg_tus', label: 'Fikcyjna grupa zakresu daty zajęć',
        details: null, leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    }))
    await env.DB.prepare(`UPDATE activity_group_leaders SET ends_on='2027-03-10',
      version=2,updated_at=? WHERE id=?`).bind(
      NOW, created.body.data.groupLeaders[0].id,
    ).run()

    await expect(createActivityClass(input({
      actor: therapist,
      idempotencyKey: 'activity-class-create-date-scope-denied-0001',
      body: {
        groupId: created.body.data.group.id, date: '2027-03-11', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      },
    }))).rejects.toThrow(/^NOT_FOUND$/)
  })

  it('conceals class edit when leadership covers the existing date but not target date', async () => {
    const created = await createActivityGroup(input({
      idempotencyKey: 'activity-group-create-class-edit-target-scope-0001',
      body: {
        programId: 'apg_tus', label: 'Fikcyjna grupa zakresu daty docelowej',
        details: null, leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    }))
    await env.DB.prepare(`UPDATE activity_group_leaders SET ends_on='2027-03-10',
      version=2,updated_at=? WHERE id=?`).bind(
      NOW, created.body.data.groupLeaders[0].id,
    ).run()
    const activityClass = (await createActivityClass(input({
      idempotencyKey: 'activity-class-create-edit-target-scope-0001',
      body: {
        groupId: created.body.data.group.id, date: '2027-03-06', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      },
    }))).body.data.class

    await expect(editActivityClass(input({
      actor: therapist, classId: activityClass.id,
      idempotencyKey: 'activity-class-edit-target-scope-denied-0001',
      body: {
        expectedVersion: 1, date: '2027-03-11', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      },
    }))).rejects.toThrow(/^NOT_FOUND$/)
  })

  it('conceals class edit when leadership covers the target date but not existing date', async () => {
    const created = await createActivityGroup(input({
      idempotencyKey: 'activity-group-create-class-edit-existing-scope-0001',
      body: {
        programId: 'apg_tus', label: 'Fikcyjna grupa zakresu daty istniejącej',
        details: null, leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    }))
    const activityClass = (await createActivityClass(input({
      idempotencyKey: 'activity-class-create-edit-existing-scope-0001',
      body: {
        groupId: created.body.data.group.id, date: '2027-03-04', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      },
    }))).body.data.class

    await expect(editActivityClass(input({
      actor: therapist, classId: activityClass.id,
      idempotencyKey: 'activity-class-edit-existing-scope-denied-0001',
      body: {
        expectedVersion: 1, date: '2027-03-06', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      },
    }))).rejects.toThrow(/^NOT_FOUND$/)
  })

  it('keeps owner and coordinator class commands centre-scoped across leadership dates', async () => {
    const created = await createActivityGroup(input({
      idempotencyKey: 'activity-group-create-class-centre-scope-0001',
      body: {
        programId: 'apg_tus', label: 'Fikcyjna grupa zakresu centrum',
        details: null, leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    }))
    await env.DB.prepare(`UPDATE activity_group_leaders SET ends_on='2027-03-10',
      version=2,updated_at=? WHERE id=?`).bind(
      NOW, created.body.data.groupLeaders[0].id,
    ).run()
    const activityClass = (await createActivityClass(input({
      actor: coordinator,
      idempotencyKey: 'activity-class-create-coordinator-centre-scope-0001',
      body: {
        groupId: created.body.data.group.id, date: '2027-03-11', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      },
    }))).body.data.class

    await expect(editActivityClass(input({
      actor: owner, classId: activityClass.id,
      idempotencyKey: 'activity-class-edit-owner-centre-scope-0001',
      body: {
        expectedVersion: 1, date: '2027-03-12', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      },
    }))).resolves.toMatchObject({ body: { data: { class: { version: 2 } } } })
  })

  it('authorizes attendance for a former leader who led on the class date', async () => {
    const historicalNowMs = Date.parse('2027-02-01T08:00:00.000Z')
    const created = await createActivityGroup(input({
      nowMs: historicalNowMs,
      idempotencyKey: 'activity-group-create-former-leader-attendance-0001',
      body: {
        programId: 'apg_tus', label: 'Fikcyjna grupa dawnej prowadzącej',
        details: null, leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    }))
    await env.DB.prepare(`UPDATE activity_group_leaders SET ends_on='2027-02-28',
      version=2,updated_at=? WHERE id=?`).bind(
      NOW, created.body.data.groupLeaders[0].id,
    ).run()
    const participant = (await createActivityParticipant(input({
      idempotencyKey: 'activity-participant-create-former-leader-attendance-0001',
      body: {
        programId: 'apg_tus', name: 'Fikcyjna uczestniczka dawnej grupy',
        clientId: null, historicalClientId: null,
      },
    }))).body.data.participant
    await createActivityMembership(input({
      idempotencyKey: 'activity-membership-create-former-leader-attendance-0001',
      body: {
        participantId: participant.id, groupId: created.body.data.group.id,
        startsOn: '2027-02-01', endsOn: '2027-02-28',
      },
    }))
    const activityClass = (await createActivityClass(input({
      idempotencyKey: 'activity-class-create-former-leader-attendance-0001',
      body: {
        groupId: created.body.data.group.id, date: '2027-02-15', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      },
    }))).body.data.class

    await expect(setActivityAttendance(input({
      actor: therapist, classId: activityClass.id,
      idempotencyKey: 'activity-attendance-former-leader-authorized-0001',
      body: { participantId: participant.id, status: 'present', expectedVersion: 0 },
    }))).resolves.toMatchObject({
      status: 201, body: { data: { attendance: { status: 'present', version: 1 } } },
    })
  })

  it('conceals attendance from a current leader who did not lead on the class date', async () => {
    const created = await createActivityGroup(input({
      idempotencyKey: 'activity-group-create-current-only-attendance-0001',
      body: {
        programId: 'apg_tus', label: 'Fikcyjna grupa obecnej prowadzącej',
        details: null, leaderSpecialistIds: ['sp_activity_commands_alpha'],
      },
    }))
    const participant = (await createActivityParticipant(input({
      idempotencyKey: 'activity-participant-create-current-only-attendance-0001',
      body: {
        programId: 'apg_tus', name: 'Fikcyjna uczestniczka wcześniejszych zajęć',
        clientId: null, historicalClientId: null,
      },
    }))).body.data.participant
    await createActivityMembership(input({
      idempotencyKey: 'activity-membership-create-current-only-attendance-0001',
      body: {
        participantId: participant.id, groupId: created.body.data.group.id,
        startsOn: '2027-02-01', endsOn: null,
      },
    }))
    const activityClass = (await createActivityClass(input({
      idempotencyKey: 'activity-class-create-current-only-attendance-0001',
      body: {
        groupId: created.body.data.group.id, date: '2027-02-15', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      },
    }))).body.data.class

    await expect(setActivityAttendance(input({
      actor: therapist, classId: activityClass.id,
      idempotencyKey: 'activity-attendance-current-only-denied-0001',
      body: { participantId: participant.id, status: 'present', expectedVersion: 0 },
    }))).rejects.toThrow(/^NOT_FOUND$/)
  })
})
