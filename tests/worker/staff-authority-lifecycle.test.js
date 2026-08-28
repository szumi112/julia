import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  changeStaffRole,
  deactivateStaff,
  inviteStaff,
} from '../../worker/identity/invitations.js'
import {
  resolveActor,
  resolveCurrentAuthorityActor,
} from '../../worker/identity/staff.js'
import { replaceCapabilityOverrides } from '../../worker/identity/capability-overrides.js'
import {
  blindEmailIndex,
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { NOW_MS } from './fixtures.js'

const NOW = new Date(NOW_MS).toISOString()
const LATER = new Date(NOW_MS + 1_000).toISOString()
const EXPIRES = new Date(NOW_MS + 24 * 60 * 60 * 1_000).toISOString()
const SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})
const CORRELATION_ID = '88888888-8888-4888-8888-888888888888'
let serial = 0

const ids = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
})

async function context() {
  serial += 1
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: `key_staff_authority_lifecycle_${serial}`,
    createdAt: NOW,
  })
  return { keyring, dataKey, scope: SCOPE }
}

const encrypted = async (cryptoContext, recordId, field, plaintext) => JSON.stringify(
  await encryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
    expectedScope: SCOPE,
    recordId,
    field,
    plaintext,
  }),
)

async function seedStaff(cryptoContext, {
  id,
  role,
  status = 'active',
  version = 1,
  displayName = 'Fikcyjna Osoba',
  email = `${id}@example.test`,
}) {
  const specialistId = role === 'specialist' ? `sp_${id.slice(4)}` : null
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id,
    await blindEmailIndex(email, cryptoContext.keyring),
    await encrypted(cryptoContext, id, 'email', email),
    await encrypted(cryptoContext, id, 'display_name', displayName),
    role,
    status,
    status === 'active' ? `subject_${id}` : null,
    specialistId,
    version,
    status === 'active' ? NOW : null,
    status === 'disabled' ? NOW : null,
    NOW,
    NOW,
  ).run()
  if (specialistId) {
    await env.DB.prepare(
      `INSERT INTO specialists
       (id,staff_user_id,display_name_envelope,professional_title_envelope,
        standard_rate_grosze,status,version,archived_at,created_at,updated_at)
       VALUES (?,?,?,NULL,18000,?,1,?,?,?)`,
    ).bind(
      specialistId,
      status === 'disabled' ? null : id,
      await encrypted(cryptoContext, specialistId, 'display_name', displayName),
      status === 'disabled' ? 'active' : status,
      null,
      NOW,
      NOW,
    ).run()
    await env.DB.prepare(
      `INSERT INTO record_versions
       (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
        changed_at,correlation_id)
       VALUES (?,'specialist',?,1,?,NULL,?,?)`,
    ).bind(
      `ver_${id}`,
      specialistId,
      await encrypted(cryptoContext, specialistId, 'record_version', JSON.stringify({
        archivedAt: null,
        createdAt: NOW,
        id: specialistId,
        schema: 'specialist.v3',
        staffUserId: status === 'disabled' ? null : id,
        standardRateGrosze: 18000,
        status: status === 'disabled' ? 'active' : status,
        updatedAt: NOW,
        version: 1,
        displayName,
        professionalTitle: 'Specjalistka',
      })),
      NOW,
      CORRELATION_ID,
    ).run()
  }
  return env.DB.prepare('SELECT * FROM staff_users WHERE id=?').bind(id).first()
}

async function actorFor(staffId) {
  const row = await env.DB.prepare(
    'SELECT id,role,specialist_id,version FROM staff_users WHERE id=?',
  ).bind(staffId).first()
  return resolveCurrentAuthorityActor(env.DB, row)
}

async function seedPendingInvitation(cryptoContext, {
  id,
  staff,
  inviterId,
  email,
  status = 'pending',
}) {
  await env.DB.prepare(
    `INSERT INTO staff_invitations
     (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,
      inviter_id,expires_at,access_allowed_at,email_sent_at,version,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,1,?,?)`,
  ).bind(
    id,
    staff.id,
    await blindEmailIndex(email, cryptoContext.keyring),
    await encrypted(cryptoContext, id, 'email', email),
    await encrypted(cryptoContext, id, 'display_name', 'Fikcyjna Oczekująca'),
    staff.role,
    status,
    inviterId,
    EXPIRES,
    status === 'pending' ? NOW : null,
    NOW,
    NOW,
  ).run()
  return env.DB.prepare('SELECT * FROM staff_invitations WHERE id=?').bind(id).first()
}

async function seedOverrides(staffId, changedByStaffId) {
  const changes = [
    ['client.manage', 'deny', `cph_seed_client_${staffId.slice(4)}`],
    ['finance.import', 'allow', `cph_seed_finance_${staffId.slice(4)}`],
  ]
  const statements = []
  for (const [capability, decision, historyId] of changes) {
    statements.push(env.DB.prepare(
      `INSERT INTO staff_capability_overrides
       (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
       VALUES (?,?,?,1,?,?,?)`,
    ).bind(staffId, capability, decision, changedByStaffId, NOW, NOW))
    statements.push(env.DB.prepare(
      `INSERT INTO staff_capability_override_history
       (id,staff_id,capability,role_at_change,decision,override_version,
        authority_revision,changed_by_staff_id,reason,changed_at)
       SELECT ?,staff.id,?,staff.role,?,1,2,?,'owner_update',?
       FROM staff_users AS staff WHERE staff.id=?`,
    ).bind(historyId, capability, decision, changedByStaffId, NOW, staffId))
  }
  statements.push(env.DB.prepare(
    `UPDATE staff_authorities SET revision=2,updated_at=?
     WHERE staff_id=? AND revision=1`,
  ).bind(NOW, staffId))
  await env.DB.batch(statements)
}

async function authorityFacts(staffId, actorId) {
  const [staff, overrides, history, revisions, audit, idempotency, outbox] = await Promise.all([
    env.DB.prepare('SELECT role,status,version FROM staff_users WHERE id=?')
      .bind(staffId).first(),
    env.DB.prepare(
      `SELECT capability,decision,version,changed_by_staff_id,updated_at
       FROM staff_capability_overrides WHERE staff_id=? ORDER BY capability`,
    ).bind(staffId).all(),
    env.DB.prepare(
      `SELECT capability,decision,override_version,authority_revision,
              changed_by_staff_id,reason,role_at_change
       FROM staff_capability_override_history WHERE staff_id=?
       ORDER BY capability,override_version`,
    ).bind(staffId).all(),
    env.DB.prepare(
      `SELECT staff_id,revision FROM staff_authorities
       WHERE staff_id IN (?,?) ORDER BY staff_id`,
    ).bind(staffId, actorId).all(),
    env.DB.prepare(
      `SELECT action,entity_id,metadata_json FROM audit_events
       WHERE entity_id=? AND action IN ('staff.role.updated','staff.deactivated')`,
    ).bind(staffId).all(),
    env.DB.prepare(
      `SELECT operation,resource_id FROM idempotency_records
       WHERE actor_id=? AND resource_id=?`,
    ).bind(actorId, staffId).all(),
    env.DB.prepare(
      `SELECT type,aggregate_id FROM outbox_jobs
       WHERE type='staff.access.reconcile' AND aggregate_id='centre_1'`,
    ).all(),
  ])
  return {
    staff,
    overrides: overrides.results,
    history: history.results,
    revisions: revisions.results,
    audit: audit.results,
    idempotency: idempotency.results,
    outbox: outbox.results,
  }
}

function batchBarrier() {
  let waiting = 0
  let release
  const ready = new Promise((resolve) => { release = resolve })
  return Object.freeze({
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements) {
      waiting += 1
      if (waiting === 2) release()
      if (waiting <= 2) await ready
      return env.DB.batch(statements)
    },
  })
}

function invitationVersionRace(invitationId) {
  let advanced = false
  return Object.freeze({
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements) {
      if (!advanced) {
        advanced = true
        await env.DB.prepare(
          `UPDATE staff_invitations
           SET status='pending',access_allowed_at=?,email_sent_at=?,
               version=version+1,updated_at=?
           WHERE id=? AND status='provisioning' AND version=1`,
        ).bind(LATER, LATER, LATER, invitationId).run()
      }
      return env.DB.batch(statements)
    },
  })
}

function selfTargetAuthorityReadBarrier(staffId) {
  let entered
  let release
  const arrived = new Promise((resolve) => { entered = resolve })
  const resumed = new Promise((resolve) => { release = resolve })
  let paused = false
  return Object.freeze({
    prepare(sql) {
      const statement = env.DB.prepare(sql)
      if (!sql.includes('FROM staff_authorities AS authority')
        || sql.includes('JOIN staff_users AS current')) return statement
      return Object.freeze({
        bind(...bindings) {
          const bound = statement.bind(...bindings)
          return Object.freeze({
            async all() {
              if (!paused && bindings[0] === staffId) {
                paused = true
                entered()
                await resumed
              }
              return bound.all()
            },
          })
        },
      })
    },
    batch: env.DB.batch.bind(env.DB),
    arrived,
    release,
  })
}

async function expectSelfTargetLifecycleRaceToLeaveOnlyWinningOverride({
  operation,
  lifecycle,
}) {
  const cryptoContext = await context()
  const owner = await seedStaff(cryptoContext, {
    id: `stf_self_${operation}_owner_${serial}`,
    role: 'owner',
  })
  await seedStaff(cryptoContext, {
    id: `stf_self_${operation}_other_owner_${serial}`,
    role: 'owner',
  })
  const actor = await actorFor(owner.id)
  const before = await Promise.all([
    env.DB.prepare("SELECT value_json,version FROM system_state WHERE key='access.desired_generation'").first(),
    env.DB.prepare("SELECT count(*) AS count FROM outbox_jobs WHERE type='staff.access.reconcile'").first(),
  ])
  const db = selfTargetAuthorityReadBarrier(owner.id)
  const losing = lifecycle({ db, cryptoContext, actor, owner })

  await db.arrived
  const winning = await replaceCapabilityOverrides({
    db: env.DB,
    cryptoContext,
    actor,
    staffId: owner.id,
    input: {
      expectedAuthorityRevision: actor.authorityRevision,
      allow: [],
      deny: ['staff.manage'],
    },
    idempotencyKey: `self-${operation}-override-${serial}`,
    correlationId: CORRELATION_ID,
    nowMs: NOW_MS,
    idFactory: ids(`self_${operation}_override_${serial}`),
  })
  expect(winning.data.authority).toMatchObject({
    staffId: owner.id,
    authorityRevision: actor.authorityRevision + 1,
    deny: ['staff.manage'],
  })

  db.release()
  await expect(losing).rejects.toThrow(/^FORBIDDEN$/)

  expect(await env.DB.prepare(
    'SELECT role,status,version FROM staff_users WHERE id=?',
  ).bind(owner.id).first()).toEqual({ role: 'owner', status: 'active', version: owner.version })
  expect(await env.DB.prepare(
    'SELECT revision FROM staff_authorities WHERE staff_id=?',
  ).bind(owner.id).first()).toEqual({ revision: actor.authorityRevision + 1 })
  expect(await env.DB.prepare(
    `SELECT capability,decision,version FROM staff_capability_overrides
     WHERE staff_id=? ORDER BY capability`,
  ).bind(owner.id).all()).toMatchObject({ results: [{
    capability: 'staff.manage', decision: 'deny', version: 1,
  }] })
  expect(await env.DB.prepare(
    `SELECT reason,authority_revision FROM staff_capability_override_history
     WHERE staff_id=? ORDER BY authority_revision`,
  ).bind(owner.id).all()).toMatchObject({ results: [{
    reason: 'owner_update', authority_revision: actor.authorityRevision + 1,
  }] })
  expect(await env.DB.prepare(
    `SELECT action FROM audit_events WHERE entity_id=?
     AND action IN ('staff.capabilities.updated','staff.role.updated','staff.deactivated')
     ORDER BY action`,
  ).bind(owner.id).all()).toMatchObject({ results: [{ action: 'staff.capabilities.updated' }] })
  expect(await env.DB.prepare(
    `SELECT operation FROM idempotency_records WHERE actor_id=? AND resource_id=?
     ORDER BY operation`,
  ).bind(owner.id, owner.id).all()).toMatchObject({ results: [{
    operation: 'staff.capabilities.update',
  }] })
  expect(await Promise.all([
    env.DB.prepare("SELECT value_json,version FROM system_state WHERE key='access.desired_generation'").first(),
    env.DB.prepare("SELECT count(*) AS count FROM outbox_jobs WHERE type='staff.access.reconcile'").first(),
    env.DB.prepare(
      `SELECT count(*) AS count FROM specialist_account_links
       WHERE staff_user_id=? AND lifecycle IN ('created','released')`,
    ).bind(owner.id).first(),
  ])).toEqual([before[0], before[1], { count: 0 }])
}

describe('staff authority lifecycle transitions', () => {
  it('changes role and atomically clears overrides with contiguous role history', async () => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_role_owner_${serial}`,
      role: 'owner',
      displayName: 'Fikcyjna Właścicielka',
    })
    const target = await seedStaff(cryptoContext, {
      id: `stf_role_target_${serial}`,
      role: 'coordinator',
      displayName: 'Fikcyjna Koordynatorka',
    })
    await seedOverrides(target.id, owner.id)
    const actor = await actorFor(owner.id)

    const result = await changeStaffRole({
      db: env.DB,
      cryptoContext,
      actor,
      staffId: target.id,
      input: { expectedVersion: target.version, role: 'owner' },
      idempotencyKey: `role-change-key-${serial}`,
      correlationId: CORRELATION_ID,
      nowMs: NOW_MS,
      idFactory: ids(`role_change_${serial}`),
    })

    expect(result.data.staff).toMatchObject({
      id: target.id,
      role: 'owner',
      status: 'active',
      version: 2,
    })
    const facts = await authorityFacts(target.id, owner.id)
    expect(facts.staff).toEqual({ role: 'owner', status: 'active', version: 2 })
    expect(facts.overrides).toEqual([
      {
        capability: 'client.manage', decision: 'cleared', version: 2,
        changed_by_staff_id: owner.id, updated_at: NOW,
      },
      {
        capability: 'finance.import', decision: 'cleared', version: 2,
        changed_by_staff_id: owner.id, updated_at: NOW,
      },
    ])
    expect(facts.history.filter(({ reason }) => reason === 'role_change')).toEqual([
      {
        capability: 'client.manage', decision: 'cleared', override_version: 2,
        authority_revision: 3, changed_by_staff_id: owner.id,
        reason: 'role_change', role_at_change: 'coordinator',
      },
      {
        capability: 'finance.import', decision: 'cleared', override_version: 2,
        authority_revision: 3, changed_by_staff_id: owner.id,
        reason: 'role_change', role_at_change: 'coordinator',
      },
    ])
    expect(facts.revisions).toEqual([
      { staff_id: owner.id, revision: 2 },
      { staff_id: target.id, revision: 3 },
    ].sort((left, right) => left.staff_id.localeCompare(right.staff_id)))
    expect(facts.audit).toHaveLength(1)
    expect(JSON.parse(facts.audit[0].metadata_json)).toMatchObject({
      actorAuthorityRevision: 2,
      targetAuthorityRevision: 3,
      staffVersion: 2,
    })
    expect(facts.idempotency).toEqual([{
      operation: 'staff.role.update', resource_id: target.id,
    }])
    expect(facts.outbox).toHaveLength(1)
  })

  it('changes a pending invitation role atomically and activates with that role', async () => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_pending_role_owner_${serial}`,
      role: 'owner',
    })
    const email = `pending-role-${serial}@example.test`
    const target = await seedStaff(cryptoContext, {
      id: `stf_pending_role_target_${serial}`,
      role: 'coordinator',
      status: 'pending',
      email,
    })
    const invitation = await seedPendingInvitation(cryptoContext, {
      id: `inv_pending_role_${serial}`,
      staff: target,
      inviterId: owner.id,
      email,
    })
    const actor = await actorFor(owner.id)

    const result = await changeStaffRole({
      db: env.DB,
      cryptoContext,
      actor,
      staffId: target.id,
      input: { expectedVersion: target.version, role: 'owner' },
      idempotencyKey: `pending-role-change-${serial}`,
      correlationId: CORRELATION_ID,
      nowMs: NOW_MS + 1_000,
      idFactory: ids(`pending_role_change_${serial}`),
    })

    expect(result.data.staff).toMatchObject({
      id: target.id,
      role: 'owner',
      status: 'pending',
      version: 2,
    })
    expect(await env.DB.prepare(
      'SELECT role,status,version,updated_at FROM staff_invitations WHERE id=?',
    ).bind(invitation.id).first()).toEqual({
      role: 'owner',
      status: 'pending',
      version: 2,
      updated_at: LATER,
    })
    const invitationVersion = await env.DB.prepare(
      `SELECT snapshot_envelope,changed_by_staff_id,changed_at
       FROM record_versions
       WHERE entity_type='staff_invitation' AND entity_id=? AND version=2`,
    ).bind(invitation.id).first()
    expect(invitationVersion).toMatchObject({
      changed_by_staff_id: owner.id,
      changed_at: LATER,
    })
    const invitationSnapshot = JSON.parse(await decryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: SCOPE,
        recordId: invitation.id,
        field: 'record_version',
        envelope: JSON.parse(invitationVersion.snapshot_envelope),
      },
    ))
    expect(invitationSnapshot).toMatchObject({
      id: invitation.id,
      role: 'owner',
      status: 'pending',
      version: 2,
      updated_at: LATER,
    })
    const roleAudit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action='staff.role.updated' AND entity_id=?`,
    ).bind(target.id).first()
    expect(JSON.parse(roleAudit.metadata_json)).toMatchObject({
      invitationVersion: 2,
      staffVersion: 2,
    })

    const activated = await resolveActor(env.DB, {
      kind: 'human',
      subject: `subject_pending_role_${serial}`,
      normalizedEmail: email,
    }, cryptoContext, {
      nowMs: NOW_MS + 2_000,
      correlationId: '88888888-8888-4888-8888-888888888883',
      idFactory: ids(`pending_role_activation_${serial}`),
    })
    expect(activated).toMatchObject({
      id: target.id,
      role: 'owner',
      version: 3,
      authorityRevision: 2,
    })
    expect(await env.DB.prepare(
      'SELECT role,status,version FROM staff_invitations WHERE id=?',
    ).bind(invitation.id).first()).toEqual({
      role: 'owner',
      status: 'activated',
      version: 3,
    })
  })

  it('rolls back a pending role change when the invitation version advances', async () => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_pending_race_owner_${serial}`,
      role: 'owner',
    })
    const email = `pending-race-${serial}@example.test`
    const target = await seedStaff(cryptoContext, {
      id: `stf_pending_race_target_${serial}`,
      role: 'coordinator',
      status: 'pending',
      email,
    })
    const invitation = await seedPendingInvitation(cryptoContext, {
      id: `inv_pending_race_${serial}`,
      staff: target,
      inviterId: owner.id,
      email,
      status: 'provisioning',
    })
    const actor = await actorFor(owner.id)
    const before = await Promise.all([
      env.DB.prepare("SELECT value_json,version FROM system_state WHERE key='access.desired_generation'").first(),
      env.DB.prepare("SELECT count(*) AS count FROM outbox_jobs WHERE type='staff.access.reconcile'").first(),
    ])

    await expect(changeStaffRole({
      db: invitationVersionRace(invitation.id),
      recoveryDb: env.DB,
      cryptoContext,
      actor,
      staffId: target.id,
      input: { expectedVersion: target.version, role: 'owner' },
      idempotencyKey: `pending-role-race-${serial}`,
      correlationId: CORRELATION_ID,
      nowMs: NOW_MS,
      idFactory: ids(`pending_role_race_${serial}`),
    })).rejects.toThrow(/^IDENTITY_FAILURE$/)

    expect(await env.DB.prepare(
      'SELECT role,status,version,updated_at FROM staff_users WHERE id=?',
    ).bind(target.id).first()).toEqual({
      role: 'coordinator',
      status: 'pending',
      version: 1,
      updated_at: NOW,
    })
    expect(await env.DB.prepare(
      `SELECT role,status,email_sent_at,version,updated_at
       FROM staff_invitations WHERE id=?`,
    ).bind(invitation.id).first()).toEqual({
      role: 'coordinator',
      status: 'pending',
      email_sent_at: LATER,
      version: 2,
      updated_at: LATER,
    })
    const residue = await Promise.all([
      env.DB.prepare(
        `SELECT count(*) AS count FROM record_versions
         WHERE entity_type='staff_user' AND entity_id=? AND version=2`,
      ).bind(target.id).first(),
      env.DB.prepare(
        `SELECT count(*) AS count FROM record_versions
         WHERE entity_type='staff_invitation' AND entity_id=? AND version=2`,
      ).bind(invitation.id).first(),
      env.DB.prepare(
        "SELECT count(*) AS count FROM audit_events WHERE action='staff.role.updated' AND entity_id=?",
      ).bind(target.id).first(),
      env.DB.prepare(
        `SELECT count(*) AS count FROM idempotency_records
         WHERE operation='staff.role.update' AND resource_id=?`,
      ).bind(target.id).first(),
      env.DB.prepare(
        "SELECT count(*) AS count FROM staff_capability_override_history WHERE staff_id=? AND reason='role_change'",
      ).bind(target.id).first(),
      env.DB.prepare(
        'SELECT revision FROM staff_authorities WHERE staff_id=?',
      ).bind(target.id).first(),
      env.DB.prepare(
        'SELECT revision FROM staff_authorities WHERE staff_id=?',
      ).bind(owner.id).first(),
      env.DB.prepare("SELECT value_json,version FROM system_state WHERE key='access.desired_generation'").first(),
      env.DB.prepare("SELECT count(*) AS count FROM outbox_jobs WHERE type='staff.access.reconcile'").first(),
    ])
    expect(residue.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => ({ count: 0 })))
    expect(residue[5]).toEqual({ revision: 1 })
    expect(residue[6]).toEqual({ revision: 1 })
    expect(residue[7]).toEqual(before[0])
    expect(residue[8]).toEqual(before[1])
  })

  it('deactivation clears active overrides with status history and bumps each authority once', async () => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_disable_owner_${serial}`,
      role: 'owner',
    })
    const target = await seedStaff(cryptoContext, {
      id: `stf_disable_target_${serial}`,
      role: 'coordinator',
    })
    await seedOverrides(target.id, owner.id)
    const actor = await actorFor(owner.id)

    await deactivateStaff({
      db: env.DB,
      cryptoContext,
      actor,
      staffId: target.id,
      version: target.version,
      idempotencyKey: `authority-disable-${serial}`,
      correlationId: CORRELATION_ID,
      nowMs: NOW_MS,
      idFactory: ids(`authority_disable_${serial}`),
    })

    const facts = await authorityFacts(target.id, owner.id)
    expect(facts.staff).toEqual({ role: 'coordinator', status: 'disabled', version: 2 })
    expect(facts.overrides.every(({ decision, version }) => (
      decision === 'cleared' && version === 2
    ))).toBe(true)
    expect(facts.history.filter(({ reason }) => reason === 'status_change')).toEqual([
      expect.objectContaining({
        capability: 'client.manage', decision: 'cleared', override_version: 2,
        authority_revision: 3, changed_by_staff_id: owner.id,
        role_at_change: 'coordinator',
      }),
      expect.objectContaining({
        capability: 'finance.import', decision: 'cleared', override_version: 2,
        authority_revision: 3, changed_by_staff_id: owner.id,
        role_at_change: 'coordinator',
      }),
    ])
    expect(facts.revisions).toEqual([
      { staff_id: owner.id, revision: 2 },
      { staff_id: target.id, revision: 3 },
    ].sort((left, right) => left.staff_id.localeCompare(right.staff_id)))
  })

  it('disabled-row reuse clears stale grants in the invitation unit of work', async () => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_reuse_owner_${serial}`,
      role: 'owner',
    })
    const target = await seedStaff(cryptoContext, {
      id: `stf_reuse_target_${serial}`,
      role: 'coordinator',
      status: 'disabled',
      email: `reuse-${serial}@example.test`,
    })
    await seedOverrides(target.id, owner.id)
    const actor = await actorFor(owner.id)

    await inviteStaff({
      db: env.DB,
      cryptoContext,
      actor,
      input: {
        displayName: 'Fikcyjna Ponownie Zaproszona',
        email: `reuse-${serial}@example.test`,
        role: 'owner',
      },
      idempotencyKey: `authority-reuse-${serial}`,
      correlationId: CORRELATION_ID,
      nowMs: NOW_MS,
      dataMode: 'fictional',
      idFactory: ids(`authority_reuse_${serial}`),
    })

    const facts = await authorityFacts(target.id, owner.id)
    expect(facts.staff).toEqual({ role: 'owner', status: 'pending', version: 2 })
    expect(facts.overrides.every(({ decision, version }) => (
      decision === 'cleared' && version === 2
    ))).toBe(true)
    expect(facts.history.filter(({ reason }) => reason === 'status_change'))
      .toHaveLength(2)
    expect(facts.revisions).toEqual([
      { staff_id: owner.id, revision: 2 },
      { staff_id: target.id, revision: 3 },
    ].sort((left, right) => left.staff_id.localeCompare(right.staff_id)))
  })

  it('leaves no lifecycle residue when the optimistic role version is stale', async () => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_stale_owner_${serial}`,
      role: 'owner',
    })
    const target = await seedStaff(cryptoContext, {
      id: `stf_stale_target_${serial}`,
      role: 'coordinator',
    })
    await seedOverrides(target.id, owner.id)
    const actor = await actorFor(owner.id)
    const before = await authorityFacts(target.id, owner.id)

    await expect(changeStaffRole({
      db: env.DB,
      cryptoContext,
      actor,
      staffId: target.id,
      input: { expectedVersion: target.version + 1, role: 'owner' },
      idempotencyKey: `role-stale-key-${serial}`,
      correlationId: CORRELATION_ID,
      nowMs: NOW_MS,
      idFactory: ids(`role_stale_${serial}`),
    })).rejects.toMatchObject({
      message: 'VERSION_CONFLICT',
      details: { currentVersion: target.version },
    })
    expect(await authorityFacts(target.id, owner.id)).toEqual(before)
  })

  it('keeps one owner and no loser residue under concurrent owner downgrades', async () => {
    const cryptoContext = await context()
    const first = await seedStaff(cryptoContext, {
      id: `stf_race_first_${serial}`,
      role: 'owner',
    })
    const second = await seedStaff(cryptoContext, {
      id: `stf_race_second_${serial}`,
      role: 'owner',
    })
    await env.DB.prepare(
      `UPDATE staff_users
       SET role='coordinator',version=version+1,updated_at=?
       WHERE role='owner' AND status='active' AND id NOT IN (?,?)`,
    ).bind(NOW, first.id, second.id).run()
    const ownerCount = await env.DB.prepare(
      "SELECT count(*) AS count FROM staff_users WHERE role='owner' AND status='active'",
    ).first()
    expect(ownerCount).toEqual({ count: 2 })
    await seedOverrides(first.id, second.id)
    await seedOverrides(second.id, first.id)
    const [firstActor, secondActor] = await Promise.all([
      actorFor(first.id),
      actorFor(second.id),
    ])
    const before = await Promise.all([
      env.DB.prepare(
        `SELECT count(*) AS count FROM staff_capability_override_history
         WHERE reason='role_change' AND staff_id IN (?,?)`,
      ).bind(first.id, second.id).first(),
      env.DB.prepare(
        `SELECT count(*) AS count FROM audit_events
         WHERE action='staff.role.updated' AND entity_id IN (?,?)`,
      ).bind(first.id, second.id).first(),
      env.DB.prepare(
        `SELECT count(*) AS count FROM idempotency_records
         WHERE operation='staff.role.update' AND resource_id IN (?,?)`,
      ).bind(first.id, second.id).first(),
      env.DB.prepare(
        `SELECT count(*) AS count FROM outbox_jobs
         WHERE type='staff.access.reconcile'`,
      ).first(),
    ])
    const db = batchBarrier()
    const settled = await Promise.allSettled([
      changeStaffRole({
        db,
        recoveryDb: env.DB,
        cryptoContext,
        actor: firstActor,
        staffId: second.id,
        input: { expectedVersion: second.version, role: 'coordinator' },
        idempotencyKey: `role-race-first-${serial}`,
        correlationId: '88888888-8888-4888-8888-888888888881',
        nowMs: NOW_MS,
        idFactory: ids(`role_race_first_${serial}`),
      }),
      changeStaffRole({
        db,
        recoveryDb: env.DB,
        cryptoContext,
        actor: secondActor,
        staffId: first.id,
        input: { expectedVersion: first.version, role: 'coordinator' },
        idempotencyKey: `role-race-second-${serial}`,
        correlationId: '88888888-8888-4888-8888-888888888882',
        nowMs: NOW_MS,
        idFactory: ids(`role_race_second_${serial}`),
      }),
    ])

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(settled.find(({ status }) => status === 'rejected').reason)
      .toMatchObject({ message: 'LAST_ACTIVE_OWNER' })
    const staff = (await env.DB.prepare(
      `SELECT id,role,status,version FROM staff_users
       WHERE id IN (?,?) ORDER BY id`,
    ).bind(first.id, second.id).all()).results
    expect(staff.filter(({ role, status }) => role === 'owner' && status === 'active'))
      .toHaveLength(1)
    expect(staff.filter(({ role }) => role === 'coordinator')).toHaveLength(1)
    const after = await Promise.all([
      env.DB.prepare(
        `SELECT count(*) AS count FROM staff_capability_override_history
         WHERE reason='role_change' AND staff_id IN (?,?)`,
      ).bind(first.id, second.id).first(),
      env.DB.prepare(
        `SELECT count(*) AS count FROM audit_events
         WHERE action='staff.role.updated' AND entity_id IN (?,?)`,
      ).bind(first.id, second.id).first(),
      env.DB.prepare(
        `SELECT count(*) AS count FROM idempotency_records
         WHERE operation='staff.role.update' AND resource_id IN (?,?)`,
      ).bind(first.id, second.id).first(),
      env.DB.prepare(
        `SELECT count(*) AS count FROM outbox_jobs
         WHERE type='staff.access.reconcile'`,
      ).first(),
    ])
    expect(after.map(({ count }, index) => count - before[index].count))
      .toEqual([2, 1, 1, 1])
    const currentOverrides = (await env.DB.prepare(
      `SELECT staff_id,decision,count(*) AS count
       FROM staff_capability_overrides WHERE staff_id IN (?,?)
       GROUP BY staff_id,decision ORDER BY staff_id,decision`,
    ).bind(first.id, second.id).all()).results
    const ownerId = staff.find(({ role }) => role === 'owner').id
    const coordinatorId = staff.find(({ role }) => role === 'coordinator').id
    expect(currentOverrides).toEqual([
      { staff_id: ownerId, decision: 'allow', count: 1 },
      { staff_id: ownerId, decision: 'deny', count: 1 },
      { staff_id: coordinatorId, decision: 'cleared', count: 2 },
    ].sort((left, right) => (
      left.staff_id.localeCompare(right.staff_id)
      || left.decision.localeCompare(right.decision)
    )))
  })

  it('fails closed when a self-target owner role change loses its authority revision', async () => {
    await expectSelfTargetLifecycleRaceToLeaveOnlyWinningOverride({
      operation: 'role',
      lifecycle: ({ db, cryptoContext, actor, owner }) => changeStaffRole({
        db,
        recoveryDb: env.DB,
        cryptoContext,
        actor,
        staffId: owner.id,
        input: { expectedVersion: owner.version, role: 'coordinator' },
        idempotencyKey: `self-role-lifecycle-${serial}`,
        correlationId: CORRELATION_ID,
        nowMs: NOW_MS,
        idFactory: ids(`self_role_lifecycle_${serial}`),
      }),
    })
  })

  it('fails closed when a self-target owner deactivation loses its authority revision', async () => {
    await expectSelfTargetLifecycleRaceToLeaveOnlyWinningOverride({
      operation: 'deactivate',
      lifecycle: ({ db, cryptoContext, actor, owner }) => deactivateStaff({
        db,
        recoveryDb: env.DB,
        cryptoContext,
        actor,
        staffId: owner.id,
        version: owner.version,
        idempotencyKey: `self-deactivate-lifecycle-${serial}`,
        correlationId: CORRELATION_ID,
        nowMs: NOW_MS,
        idFactory: ids(`self_deactivate_lifecycle_${serial}`),
      }),
    })
  })
})
