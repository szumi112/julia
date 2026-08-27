import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  deactivateStaff,
  inviteStaff,
} from '../../worker/identity/invitations.js'
import { resolveActor } from '../../worker/identity/staff.js'
import { listActiveSpecialists } from '../../worker/identity/specialists.js'
import {
  blindEmailIndex,
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { NOW_MS } from './fixtures.js'

const NOW = new Date(NOW_MS).toISOString()
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const INVITE_CORRELATION = '11111111-1111-4111-8111-111111111111'
const ACTIVATION_CORRELATION = '22222222-2222-4222-8222-222222222222'
const DEACTIVATION_CORRELATION = '33333333-3333-4333-8333-333333333333'
const REINVITE_CORRELATION = '44444444-4444-4444-8444-444444444444'
const RETAINED_ACTIVATION_CORRELATION = '55555555-5555-4555-8555-555555555555'
let serial = 0

const ids = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

const encrypted = async (context, recordId, field, plaintext) => JSON.stringify(
  await encryptForScope(context.keyring, context.dataKey, {
    expectedScope: SCOPE,
    recordId,
    field,
    plaintext,
  }),
)

async function context() {
  serial += 1
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: `key_specialist_lifecycle_${serial}`,
    createdAt: NOW,
  })
  const owner = {
    id: `stf_specialist_owner_${serial}`,
    role: 'owner',
    specialistId: null,
    version: 1,
  }
  const email = `specialist-owner-${serial}@example.test`
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,NULL,1,?,NULL,?,?)`
  ).bind(
    owner.id,
    await blindEmailIndex(email, keyring),
    await encrypted({ keyring, dataKey }, owner.id, 'email', email),
    await encrypted({ keyring, dataKey }, owner.id, 'display_name', 'Owner Fikcyjny'),
    owner.role,
    `subject_${owner.id}`,
    NOW,
    NOW,
    NOW,
  ).run()
  return { keyring, dataKey, scope: SCOPE, owner }
}

const invite = (cryptoContext, input, options = {}) => inviteStaff({
  db: options.db ?? env.DB,
  cryptoContext,
  actor: cryptoContext.owner,
  input,
  idempotencyKey: options.idempotencyKey ?? `specialist-invite-${serial}`,
  correlationId: options.correlationId ?? INVITE_CORRELATION,
  nowMs: options.nowMs ?? NOW_MS,
  dataMode: 'fictional',
  idFactory: options.idFactory ?? ids(`specialist_invite_${serial}`),
})

const deactivate = (cryptoContext, staffId, version, options = {}) => deactivateStaff({
  db: options.db ?? env.DB,
  cryptoContext,
  actor: cryptoContext.owner,
  staffId,
  version,
  idempotencyKey: options.idempotencyKey ?? `specialist-deactivate-${serial}`,
  correlationId: options.correlationId ?? DEACTIVATION_CORRELATION,
  nowMs: options.nowMs ?? NOW_MS,
  idFactory: options.idFactory ?? ids(`specialist_deactivate_${serial}`),
})

const activate = (cryptoContext, email, options = {}) => resolveActor(
  options.db ?? env.DB,
  {
    kind: 'human',
    subject: options.subject ?? `access_specialist_${serial}`,
    normalizedEmail: email,
  },
  cryptoContext,
  {
    nowMs: options.nowMs ?? NOW_MS,
    correlationId: options.correlationId ?? ACTIVATION_CORRELATION,
    idFactory: options.idFactory ?? ids(`specialist_activation_${serial}`),
  },
)

const decryptSnapshot = (cryptoContext, recordId, serialized) => decryptForScope(
  cryptoContext.keyring,
  cryptoContext.dataKey,
  {
    expectedScope: SCOPE,
    recordId,
    field: 'record_version',
    envelope: JSON.parse(serialized),
  },
)

async function publishInvitation(invitationId) {
  await env.DB.prepare(
    `UPDATE staff_invitations
     SET status='pending',access_allowed_at=?,version=version+1,updated_at=?
     WHERE id=? AND status='provisioning'`
  ).bind(NOW, NOW, invitationId).run()
}

async function profileFacts(specialistId) {
  const profile = await env.DB.prepare(
    'SELECT * FROM specialists WHERE id=?'
  ).bind(specialistId).first()
  const versions = (await env.DB.prepare(
    `SELECT * FROM record_versions
     WHERE entity_type='specialist' AND entity_id=? ORDER BY version`
  ).bind(specialistId).all()).results
  return { profile, versions }
}

async function lifecycleState() {
  const tables = [
    ['staff', 'SELECT * FROM staff_users ORDER BY id'],
    ['profiles', 'SELECT * FROM specialists ORDER BY id'],
    ['invitations', 'SELECT * FROM staff_invitations ORDER BY id'],
    ['versions', 'SELECT * FROM record_versions ORDER BY id'],
    ['audits', 'SELECT * FROM audit_events ORDER BY id'],
    ['outbox', 'SELECT * FROM outbox_jobs ORDER BY id'],
    [
      'schema',
      `SELECT name,sql FROM sqlite_schema
       WHERE type='trigger'
         AND name IN ('specialists_no_delete','staff_users_version_increment')
       ORDER BY name`,
    ],
    [
      'idempotency',
      'SELECT * FROM idempotency_records ORDER BY actor_id,operation,idempotency_key',
    ],
    ['state', 'SELECT * FROM system_state ORDER BY key'],
  ]
  const rows = await Promise.all(tables.map(async ([name, sql]) => [
    name,
    (await env.DB.prepare(sql).all()).results,
  ]))
  return Object.fromEntries(rows)
}

const observeBatchDb = (capture) => ({
  prepare: env.DB.prepare.bind(env.DB),
  batch(statements) {
    capture(statements.length)
    throw new Error('INJECTED_STATEMENT_FAILURE')
  },
})

const failBatchAtDb = (failureIndex) => ({
  prepare: env.DB.prepare.bind(env.DB),
  batch(statements) {
    return env.DB.batch(statements.map((statement, index) => index === failureIndex
      ? env.DB.prepare('INSERT INTO missing_specialist_failure_table VALUES (1)')
      : statement))
  },
})

const corruptBeforeFinalGuardDb = (corruptionStatements) => ({
  prepare: env.DB.prepare.bind(env.DB),
  batch(statements) {
    return env.DB.batch([
      ...statements.slice(0, -1),
      ...corruptionStatements,
      statements.at(-1),
    ])
  },
})

async function lifecycleCorruptionCases(staffId, specialistId, prefix) {
  const staffVersionTrigger = await env.DB.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='staff_users_version_increment'"
  ).first()
  const specialistDeleteTrigger = await env.DB.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='specialists_no_delete'"
  ).first()
  expect(staffVersionTrigger?.sql).toMatch(/^CREATE TRIGGER staff_users_version_increment/)
  expect(specialistDeleteTrigger?.sql).toMatch(/^CREATE TRIGGER specialists_no_delete/)
  return [
    [
      'pointer',
      [
        env.DB.prepare('DROP TRIGGER staff_users_version_increment'),
        env.DB.prepare(
          'UPDATE staff_users SET specialist_id=? WHERE id=?'
        ).bind(`sp_${prefix}_pointer`, staffId),
        env.DB.prepare(staffVersionTrigger.sql),
      ],
    ],
    [
      'profile',
      [
        env.DB.prepare('DROP TRIGGER specialists_no_delete'),
        env.DB.prepare('DELETE FROM specialists WHERE id=?').bind(specialistId),
        env.DB.prepare(specialistDeleteTrigger.sql),
      ],
    ],
    [
      'status',
      [
        env.DB.prepare(
          `INSERT INTO record_versions
           (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
            changed_at,correlation_id)
           SELECT ?,entity_type,entity_id,version+1,snapshot_envelope,
                  changed_by_staff_id,changed_at,correlation_id
           FROM record_versions
           WHERE entity_type='specialist' AND entity_id=?
             AND version=(SELECT version FROM specialists WHERE id=?)`
        ).bind(`rv_${prefix}_status`, specialistId, specialistId),
        env.DB.prepare(
          `UPDATE specialists
           SET status=CASE status WHEN 'active' THEN 'pending' ELSE 'active' END,
               archived_at=NULL,version=version+1
           WHERE id=?`
        ).bind(specialistId),
      ],
    ],
    [
      'current snapshot',
      [env.DB.prepare(
        `UPDATE specialists
         SET standard_rate_grosze=standard_rate_grosze+1,version=version+1
         WHERE id=?`
      ).bind(specialistId)],
    ],
  ]
}

async function expectLifecycleGuardMatrix({
  before,
  invoke,
  specialistId,
  staffId,
  prefix,
}) {
  const cases = await lifecycleCorruptionCases(staffId, specialistId, prefix)
  for (const [label, corruptionStatements] of cases) {
    await expect(invoke(corruptBeforeFinalGuardDb(corruptionStatements), label))
      .rejects.toThrow(/^IDENTITY_FAILURE$/)
    expect(await lifecycleState(), label).toEqual(before)
  }
}

async function pendingPractitioner(cryptoContext, prefix) {
  const email = `${prefix}-${serial}@example.test`
  const created = await invite(cryptoContext, {
    displayName: 'Rollback Practitioner',
    email,
    role: 'specialist',
  }, {
    idempotencyKey: `${prefix}-invite-${serial}`,
    idFactory: ids(`${prefix}_invite_${serial}`),
  })
  await publishInvitation(created.data.invitation.id)
  return { created, email }
}

async function activePractitioner(cryptoContext, prefix) {
  const pending = await pendingPractitioner(cryptoContext, prefix)
  const active = await activate(cryptoContext, pending.email, {
    subject: `${prefix}_subject_${serial}`,
    idFactory: ids(`${prefix}_activation_${serial}`),
  })
  return { ...pending, active }
}

describe('retained specialist lifecycle', () => {
  it('keeps one specialist identity through invite, activation, disable, reinvite, and retained-role activation', async () => {
    const cryptoContext = await context()
    const created = await invite(cryptoContext, {
      displayName: 'Praktyczka Fikcyjna',
      email: `practitioner-${serial}@example.test`,
      role: 'specialist',
    }, { idFactory: ids(`specialist_full_${serial}`) })
    const specialistId = created.data.staff.specialistId

    let facts = await profileFacts(specialistId)
    expect(facts.profile).toMatchObject({
      id: specialistId,
      staff_user_id: created.data.staff.id,
      standard_rate_grosze: 18000,
      status: 'pending',
      version: 1,
      archived_at: null,
      created_at: NOW,
      updated_at: NOW,
    })
    expect(facts.versions).toHaveLength(1)
    const createdSnapshot = JSON.parse(await decryptSnapshot(
      cryptoContext,
      specialistId,
      facts.versions[0].snapshot_envelope,
    ))
    expect(createdSnapshot).toMatchObject({
      archivedAt: null,
      createdAt: NOW,
      id: specialistId,
      staffUserId: created.data.staff.id,
      standardRateGrosze: 18000,
      status: 'pending',
      updatedAt: NOW,
      version: 1,
    })
    expect(['specialist.v1', 'specialist.v2']).toContain(createdSnapshot.schema)
    if (createdSnapshot.schema === 'specialist.v2') {
      expect(createdSnapshot.displayName).toBe('Praktyczka Fikcyjna')
    } else {
      expect(createdSnapshot).not.toHaveProperty('displayName')
    }
    expect(JSON.parse((await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE action='staff.invited' AND entity_id=?"
    ).bind(created.data.invitation.id).first()).metadata_json)).toEqual({
      desiredGeneration: 1,
      invitationVersion: 1,
      specialistVersion: 1,
      staffVersion: 1,
    })

    await publishInvitation(created.data.invitation.id)
    const active = await resolveActor(env.DB, {
      kind: 'human',
      subject: `access_practitioner_${serial}`,
      normalizedEmail: `practitioner-${serial}@example.test`,
    }, cryptoContext, {
      nowMs: NOW_MS,
      correlationId: ACTIVATION_CORRELATION,
      idFactory: ids(`specialist_activation_${serial}`),
    })
    expect(active).toMatchObject({
      id: created.data.staff.id,
      role: 'specialist',
      specialistId,
      version: 2,
    })
    facts = await profileFacts(specialistId)
    expect(facts.profile).toMatchObject({ status: 'active', version: 2, archived_at: null })
    expect(facts.versions.map(({ version }) => version)).toEqual([1, 2])

    await deactivate(cryptoContext, active.id, active.version)
    facts = await profileFacts(specialistId)
    expect(facts.profile).toMatchObject({
      id: specialistId,
      staff_user_id: active.id,
      status: 'archived',
      version: 3,
      archived_at: NOW,
    })
    await expect(listActiveSpecialists({ db: env.DB })).resolves.not.toContainEqual(
      expect.objectContaining({ id: specialistId }),
    )

    const reinvited = await invite(cryptoContext, {
      displayName: 'Praktyczka Fikcyjna',
      email: `practitioner-${serial}@example.test`,
      role: 'owner',
    }, {
      idempotencyKey: `specialist-reinvite-${serial}`,
      correlationId: REINVITE_CORRELATION,
      idFactory: ids(`specialist_reinvite_${serial}`),
    })
    expect(reinvited.data.staff).toMatchObject({
      id: active.id,
      role: 'owner',
      specialistId,
      status: 'pending',
      version: 4,
    })
    facts = await profileFacts(specialistId)
    expect(facts.profile).toMatchObject({ status: 'pending', version: 4, archived_at: null })
    await expect(listActiveSpecialists({ db: env.DB })).resolves.not.toContainEqual(
      expect.objectContaining({ id: specialistId }),
    )

    await publishInvitation(reinvited.data.invitation.id)
    const retainedOwner = await resolveActor(env.DB, {
      kind: 'human',
      subject: `access_retained_owner_${serial}`,
      normalizedEmail: `practitioner-${serial}@example.test`,
    }, cryptoContext, {
      nowMs: NOW_MS,
      correlationId: RETAINED_ACTIVATION_CORRELATION,
      idFactory: ids(`retained_owner_activation_${serial}`),
    })
    expect(retainedOwner).toMatchObject({ role: 'owner', specialistId, version: 5 })
    facts = await profileFacts(specialistId)
    expect(facts.profile).toMatchObject({ status: 'active', version: 5, archived_at: null })
    expect(facts.versions.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5])
    await expect(listActiveSpecialists({ db: env.DB })).resolves.toContainEqual({
      id: specialistId,
      staffUserId: active.id,
      standardRateGrosze: 18000,
      version: 5,
    })
  })

  it('repairs an old retained pointer without a profile inside the staff mutation', async () => {
    const cryptoContext = await context()
    const staffId = `stf_retained_missing_${serial}`
    const specialistId = `sp_retained_missing_${serial}`
    const email = `retained-missing-${serial}@example.test`
    await env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
        specialist_id,version,activated_at,disabled_at,created_at,updated_at)
       VALUES (?,?,?,?,?,'active',?,?,1,?,NULL,?,?)`
    ).bind(
      staffId,
      await blindEmailIndex(email, cryptoContext.keyring),
      await encrypted(cryptoContext, staffId, 'email', email),
      await encrypted(cryptoContext, staffId, 'display_name', 'Retained Missing'),
      'coordinator',
      `subject_${staffId}`,
      specialistId,
      NOW,
      NOW,
      NOW,
    ).run()

    await deactivate(cryptoContext, staffId, 1, {
      idempotencyKey: `repair-missing-${serial}`,
      idFactory: ids(`repair_missing_${serial}`),
    })

    const staff = await env.DB.prepare(
      'SELECT id,specialist_id,status,version FROM staff_users WHERE id=?'
    ).bind(staffId).first()
    const facts = await profileFacts(specialistId)
    expect(staff).toEqual({ id: staffId, specialist_id: specialistId, status: 'disabled', version: 2 })
    expect(facts.profile).toMatchObject({
      id: specialistId,
      staff_user_id: staffId,
      status: 'archived',
      version: 1,
      archived_at: NOW,
    })
    expect(facts.versions).toHaveLength(1)
    expect(JSON.parse((await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE action='staff.deactivated' AND entity_id=?"
    ).bind(staffId).first()).metadata_json).specialistVersion).toBe(1)
  })

  it('retains a pending profile without versioning it during a role-only reinvite', async () => {
    const cryptoContext = await context()
    const email = `role-only-${serial}@example.test`
    const created = await invite(cryptoContext, {
      displayName: 'Role Only Practitioner',
      email,
      role: 'specialist',
    }, { idFactory: ids(`role_only_create_${serial}`) })
    await env.DB.prepare(
      `UPDATE staff_invitations
       SET status='revoked',revoked_at=?,version=version+1,updated_at=?
       WHERE id=? AND status='provisioning'`
    ).bind(NOW, NOW, created.data.invitation.id).run()

    const repeated = await invite(cryptoContext, {
      displayName: 'Role Only Practitioner',
      email,
      role: 'owner',
    }, {
      idempotencyKey: `role-only-reinvite-${serial}`,
      correlationId: REINVITE_CORRELATION,
      idFactory: ids(`role_only_reinvite_${serial}`),
    })
    expect(repeated.data.staff).toMatchObject({
      id: created.data.staff.id,
      role: 'owner',
      specialistId: created.data.staff.specialistId,
      status: 'pending',
    })
    const facts = await profileFacts(created.data.staff.specialistId)
    expect(facts.profile).toMatchObject({ status: 'pending', version: 1 })
    expect(facts.versions).toHaveLength(1)
    expect(JSON.parse((await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE action='staff.invited' AND entity_id=?"
    ).bind(repeated.data.invitation.id).first()).metadata_json).specialistVersion).toBeNull()
  })

  it('fails closed on a deterministic specialist id collision without partial writes', async () => {
    const cryptoContext = await context()
    const targetId = `stf_collision_target_${serial}`
    const otherId = `stf_collision_other_${serial}`
    const targetEmail = `collision-target-${serial}@example.test`
    for (const [id, email] of [
      [targetId, targetEmail],
      [otherId, `collision-other-${serial}@example.test`],
    ]) {
      await env.DB.prepare(
        `INSERT INTO staff_users
         (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
          specialist_id,version,activated_at,disabled_at,created_at,updated_at)
         VALUES (?,?,?,?,?,'disabled',NULL,NULL,1,NULL,?,?,?)`
      ).bind(
        id,
        await blindEmailIndex(email, cryptoContext.keyring),
        await encrypted(cryptoContext, id, 'email', email),
        await encrypted(cryptoContext, id, 'display_name', 'Collision Fixture'),
        'coordinator',
        NOW,
        NOW,
        NOW,
      ).run()
    }
    const specialistId = `sp_collision_target_${serial}`
    await env.DB.prepare(
      `INSERT INTO specialists
       (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
       VALUES (?,?,18000,'archived',1,?,?,?)`
    ).bind(specialistId, otherId, NOW, NOW, NOW).run()
    const mutationCounts = () => env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM staff_invitations) AS invitations,
         (SELECT count(*) FROM record_versions) AS versions,
         (SELECT count(*) FROM audit_events) AS audits,
         (SELECT count(*) FROM outbox_jobs) AS jobs`
    ).first()
    const before = await mutationCounts()

    await expect(invite(cryptoContext, {
      displayName: 'Collision Fixture',
      email: targetEmail,
      role: 'specialist',
    }, {
      idempotencyKey: `specialist-collision-${serial}`,
      idFactory: ids(`specialist_collision_${serial}`),
    })).rejects.toThrow(/^SPECIALIST_LIFECYCLE_INVALID$/)
    expect(await mutationCounts()).toEqual(before)
    expect(await env.DB.prepare(
      'SELECT specialist_id,status,version FROM staff_users WHERE id=?'
    ).bind(targetId).first()).toEqual({ specialist_id: null, status: 'disabled', version: 1 })
  })

  it('rolls back a new practitioner invite at every injected batch statement failure', async () => {
    const cryptoContext = await context()
    let batchLength = 0
    const observeDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch(statements) {
        batchLength = statements.length
        throw new Error('INJECTED_STATEMENT_FAILURE')
      },
    }
    await expect(invite(cryptoContext, {
      displayName: 'Observed Practitioner',
      email: `observed-practitioner-${serial}@example.test`,
      role: 'specialist',
    }, {
      db: observeDb,
      idempotencyKey: `observe-statements-${serial}`,
      idFactory: ids(`observe_statements_${serial}`),
    })).rejects.toThrow(/^INJECTED_STATEMENT_FAILURE$/)
    expect(batchLength).toBeGreaterThan(0)

    for (let failureIndex = 0; failureIndex < batchLength; failureIndex += 1) {
      const suffix = `${serial}_${failureIndex}`
      const failingDb = {
        prepare: env.DB.prepare.bind(env.DB),
        batch(statements) {
          const injected = statements.map((statement, index) => index === failureIndex
            ? env.DB.prepare('INSERT INTO missing_specialist_failure_table VALUES (1)')
            : statement)
          return env.DB.batch(injected)
        },
      }
      await expect(invite(cryptoContext, {
        displayName: `Rollback Practitioner ${failureIndex}`,
        email: `rollback-practitioner-${suffix}@example.test`,
        role: 'specialist',
      }, {
        db: failingDb,
        idempotencyKey: `rollback-statement-${suffix}`,
        idFactory: ids(`rollback_statement_${suffix}`),
      })).rejects.toThrow()
      expect(await env.DB.prepare(
        `SELECT
           (SELECT count(*) FROM staff_users WHERE id=?) AS staff_count,
           (SELECT count(*) FROM specialists WHERE id=?) AS specialist_count,
           (SELECT count(*) FROM record_versions WHERE entity_id IN (?,?)) AS version_count,
           (SELECT count(*) FROM audit_events
            WHERE correlation_id=? AND entity_id IN (?,?)) AS audit_count,
           (SELECT count(*) FROM outbox_jobs WHERE aggregate_id IN (?,?)) AS outbox_count`
      ).bind(
        `stf_rollback_statement_${suffix}_1`,
        `sp_rollback_statement_${suffix}_1`,
        `stf_rollback_statement_${suffix}_1`,
        `sp_rollback_statement_${suffix}_1`,
        INVITE_CORRELATION,
        `stf_rollback_statement_${suffix}_1`,
        `inv_rollback_statement_${suffix}_2`,
        `stf_rollback_statement_${suffix}_1`,
        `inv_rollback_statement_${suffix}_2`,
      ).first()).toEqual({
        staff_count: 0,
        specialist_count: 0,
        version_count: 0,
        audit_count: 0,
        outbox_count: 0,
      })
    }
  })

  it('rolls back practitioner activation at every injected batch statement failure', async () => {
    const cryptoContext = await context()
    const { email } = await pendingPractitioner(cryptoContext, 'rollback_activation')
    const before = await lifecycleState()
    let batchLength = 0
    await expect(activate(cryptoContext, email, {
      db: observeBatchDb((length) => { batchLength = length }),
      subject: `rollback_activation_subject_${serial}`,
      idFactory: ids(`rollback_activation_observe_${serial}`),
    })).rejects.toThrow()
    expect(batchLength).toBeGreaterThan(0)
    expect(await lifecycleState()).toEqual(before)

    for (let failureIndex = 0; failureIndex < batchLength; failureIndex += 1) {
      await expect(activate(cryptoContext, email, {
        db: failBatchAtDb(failureIndex),
        subject: `rollback_activation_subject_${serial}`,
        idFactory: ids(`rollback_activation_${serial}_${failureIndex}`),
      })).rejects.toThrow()
      expect(await lifecycleState()).toEqual(before)
    }
  })

  it('first invite guard rolls back every lifecycle invariant corruption class', async () => {
    const cryptoContext = await context()
    const prefix = `guarded_first_invite_${serial}`
    const staffId = `stf_${prefix}_1`
    const specialistId = `sp_${prefix}_1`
    const before = await lifecycleState()

    await expectLifecycleGuardMatrix({
      before,
      staffId,
      specialistId,
      prefix,
      invoke: (db, label) => invite(cryptoContext, {
        displayName: 'Guarded First Practitioner',
        email: `guarded-first-${serial}@example.test`,
        role: 'specialist',
      }, {
        db,
        idempotencyKey: `guarded-first-${label.replaceAll(' ', '-')}-${serial}`,
        idFactory: ids(prefix),
      }),
    })
  })

  it('activation guard rolls back every lifecycle invariant corruption class', async () => {
    const cryptoContext = await context()
    const { created, email } = await pendingPractitioner(
      cryptoContext,
      'guarded_activation',
    )
    const staffId = created.data.staff.id
    const specialistId = created.data.staff.specialistId
    const before = await lifecycleState()
    await expectLifecycleGuardMatrix({
      before,
      staffId,
      specialistId,
      prefix: `guarded_activation_${serial}`,
      invoke: (db, label) => activate(cryptoContext, email, {
        db,
        subject: `guarded_activation_${label.replaceAll(' ', '_')}_${serial}`,
        idFactory: ids(`guarded_activation_${label.replaceAll(/[ /]/g, '_')}_${serial}`),
      }),
    })
  })

  it('rolls back practitioner deactivation at every injected batch statement failure', async () => {
    const cryptoContext = await context()
    const { active } = await activePractitioner(cryptoContext, 'rollback_deactivation')
    const before = await lifecycleState()
    let batchLength = 0
    await expect(deactivate(cryptoContext, active.id, active.version, {
      db: observeBatchDb((length) => { batchLength = length }),
      idempotencyKey: `rollback-deactivation-observe-${serial}`,
      idFactory: ids(`rollback_deactivation_observe_${serial}`),
    })).rejects.toThrow()
    expect(batchLength).toBeGreaterThan(0)
    expect(await lifecycleState()).toEqual(before)

    for (let failureIndex = 0; failureIndex < batchLength; failureIndex += 1) {
      await expect(deactivate(cryptoContext, active.id, active.version, {
        db: failBatchAtDb(failureIndex),
        idempotencyKey: `rollback-deactivation-${serial}-${failureIndex}`,
        idFactory: ids(`rollback_deactivation_${serial}_${failureIndex}`),
      })).rejects.toThrow()
      expect(await lifecycleState()).toEqual(before)
    }
  })

  it('deactivation guard rolls back every lifecycle invariant corruption class', async () => {
    const cryptoContext = await context()
    const { active } = await activePractitioner(cryptoContext, 'guarded_deactivation')
    const staffId = active.id
    const specialistId = active.specialistId
    const before = await lifecycleState()

    await expectLifecycleGuardMatrix({
      before,
      staffId,
      specialistId,
      prefix: `guarded_deactivation_${serial}`,
      invoke: (db, label) => deactivate(cryptoContext, staffId, active.version, {
        db,
        idempotencyKey: `guarded-deactivation-${label.replaceAll(' ', '-')}-${serial}`,
        idFactory: ids(`guarded_deactivation_${label.replaceAll(' ', '_')}_${serial}`),
      }),
    })
  })

  it('rolls back retained-profile reinvite at every injected batch statement failure', async () => {
    const cryptoContext = await context()
    const { active, email } = await activePractitioner(cryptoContext, 'rollback_reinvite')
    await deactivate(cryptoContext, active.id, active.version, {
      idempotencyKey: `rollback-reinvite-disable-${serial}`,
      idFactory: ids(`rollback_reinvite_disable_${serial}`),
    })
    const before = await lifecycleState()
    const input = {
      displayName: 'Rollback Retained Practitioner',
      email,
      role: 'owner',
    }
    let batchLength = 0
    await expect(invite(cryptoContext, input, {
      db: observeBatchDb((length) => { batchLength = length }),
      idempotencyKey: `rollback-reinvite-observe-${serial}`,
      correlationId: REINVITE_CORRELATION,
      idFactory: ids(`rollback_reinvite_observe_${serial}`),
    })).rejects.toThrow()
    expect(batchLength).toBeGreaterThan(0)
    expect(await lifecycleState()).toEqual(before)

    for (let failureIndex = 0; failureIndex < batchLength; failureIndex += 1) {
      await expect(invite(cryptoContext, input, {
        db: failBatchAtDb(failureIndex),
        idempotencyKey: `rollback-reinvite-${serial}-${failureIndex}`,
        correlationId: REINVITE_CORRELATION,
        idFactory: ids(`rollback_reinvite_${serial}_${failureIndex}`),
      })).rejects.toThrow()
      expect(await lifecycleState()).toEqual(before)
    }
  })

  it('retained-profile reinvite guard rolls back every lifecycle invariant corruption class', async () => {
    const cryptoContext = await context()
    const { active, email } = await activePractitioner(cryptoContext, 'guarded_reinvite')
    await deactivate(cryptoContext, active.id, active.version, {
      idempotencyKey: `guarded-reinvite-disable-${serial}`,
      idFactory: ids(`guarded_reinvite_disable_${serial}`),
    })
    const before = await lifecycleState()
    const input = {
      displayName: 'Guarded Retained Practitioner',
      email,
      role: 'owner',
    }

    await expectLifecycleGuardMatrix({
      before,
      staffId: active.id,
      specialistId: active.specialistId,
      prefix: `guarded_reinvite_${serial}`,
      invoke: (db, label) => invite(cryptoContext, input, {
        db,
        idempotencyKey: `guarded-reinvite-${label.replaceAll(' ', '-')}-${serial}`,
        correlationId: REINVITE_CORRELATION,
        idFactory: ids(`guarded_reinvite_${label.replaceAll(' ', '_')}_${serial}`),
      }),
    })
  })
})
