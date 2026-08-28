import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
import { blindEmailIndex, decryptForScope, encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import {
  reindexEmailLookupsBatch,
  resolveActiveActorReadOnly,
  resolveActor,
  resolveCurrentAuthorityActor,
  verifyNoOldEmailLookups,
} from '../../worker/identity/staff.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { NOW_MS, TEST_IDENTITIES } from './fixtures.js'

const scope = { type: 'staff_directory', id: 'centre_1', purpose: 'identity' }
const instant = new Date(NOW_MS).toISOString()
const expectedActor = ({
  id,
  role = 'owner',
  specialistId = null,
  version,
  authorityRevision = 1,
  capabilities = ROLE_DEFAULT_CAPABILITIES[role],
}) => ({ id, role, specialistId, version, authorityRevision, capabilities })
const COORDINATOR_OVERRIDE_CAPABILITIES = Object.freeze([
  'appointment.charge.read',
  'appointment.manage',
  'chat.direct',
  'chat.general',
  'client.operational.read',
  'finance.centre.read',
  'finance.import',
  'operations.health.read',
  'payment.manage',
  'specialist.directory.read',
  'tus.manage',
  'workbook.centre.export',
])

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
})

const cryptoContext = async () => {
  const keyring = await createKeyring(env, { activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1 })
  return { keyring, dataKey: await getOrCreateDataKey(env.DB, keyring, scope, { id: 'key_identity', createdAt: instant }), scope }
}

const ids = (prefix) => { let sequence = 0; return () => `${prefix}_${++sequence}` }
const fixedIds = (...values) => { let index = 0; return () => values[index++] }
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const blockedBatchDb = ({ freezeError = false } = {}) => {
  const entered = deferred()
  const release = deferred()
  const failed = deferred()
  return {
    entered: entered.promise,
    release: release.resolve,
    failed: failed.promise,
    db: {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements) => {
        entered.resolve()
        await release.promise
        try {
          return await env.DB.batch(statements)
        } catch (error) {
          failed.resolve(error)
          if (freezeError) Object.freeze(error)
          throw error
        }
      },
    },
  }
}
const cryptoContextV2 = async () => {
  const keyring = await createKeyring({
    BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
    BWM_LOOKUP_HMAC_V2: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU',
    BWM_BACKUP_KEK_V1: 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
  }, { activeDataKekVersion: 1, activeLookupKeyVersion: 2, activeBackupKekVersion: 1 })
  return { keyring, dataKey: await getOrCreateDataKey(env.DB, keyring, scope, { id: 'key_identity', createdAt: instant }), scope }
}

async function seedPending(context, { staffId = 'stf_pending', invitationId = 'inv_pending', email = TEST_IDENTITIES.owner.email, expiresAt = new Date(NOW_MS + 1_000).toISOString(), lookupVersion, invitationEmail = email, invitationStatus = 'pending', accessAllowedAt = instant, staffRole = 'owner', invitationRole = staffRole } = {}) {
  const lookup = await blindEmailIndex(email, context.keyring, lookupVersion)
  const invitationLookup = await blindEmailIndex(invitationEmail, context.keyring, lookupVersion)
  const encrypted = async (recordId, field, plaintext) => JSON.stringify(await encryptForScope(context.keyring, context.dataKey, { expectedScope: scope, recordId, field, plaintext }))
  await env.DB.prepare(`INSERT INTO staff_users (id,email_lookup,email_envelope,display_name_envelope,role,status,version,created_at,updated_at) VALUES (?,?,?,?,?,'pending',1,?,?)`)
    .bind(staffId, lookup, await encrypted(staffId, 'email', email), await encrypted(staffId, 'display_name', 'Fixture Staff'), staffRole, instant, instant).run()
  await env.DB.prepare(`INSERT INTO staff_invitations (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,inviter_id,expires_at,access_allowed_at,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`)
    .bind(invitationId, staffId, invitationLookup, await encrypted(invitationId, 'email', invitationEmail), await encrypted(invitationId, 'display_name', 'Fixture Staff'), invitationRole, invitationStatus, staffId, expiresAt, accessAllowedAt, instant, instant).run()
}

async function occupyVersionId(id) {
  await env.DB.prepare(
    `INSERT INTO record_versions
     (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,changed_at,correlation_id)
     VALUES (?,'staff_user',?,99,'{}',NULL,?,'corr_unrelated')`
  ).bind(id, `stf_unrelated_${id}`, instant).run()
}

async function occupyAuditId(id) {
  await env.DB.prepare(
    `INSERT INTO audit_events
     (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,reason_envelope,correlation_id,metadata_json)
     VALUES (?, ?, NULL, 'unrelated.action', 'staff_user', 'stf_unrelated', 'failure', NULL, 'corr_unrelated', '{}')`
  ).bind(id, instant).run()
}

const dbWithAuthorityRows = (rows) => ({
  prepare(sql) {
    if (!sql.includes('staff_authorities')) return env.DB.prepare(sql)
    return {
      bind() {
        return {
          async all() { return { results: rows } },
        }
      },
    }
  },
})

describe('D1-authoritative staff resolution', () => {
  it('never creates an actor from a valid Access identity alone', async () => {
    const context = await cryptoContext()
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-absent', normalizedEmail: 'absent@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_absent', idFactory: () => 'id_absent' })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect((await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first()).count).toBe(0)
  })

  it('keeps a prepare-only legacy active path compatible when recovery is omitted', async () => {
    const context = await cryptoContext()
    const principal = { kind: 'human', subject: 'access-prepare-only', normalizedEmail: 'prepare-only@example.test' }
    await seedPending(context, { staffId: 'stf_prepare_only', invitationId: 'inv_prepare_only', email: principal.normalizedEmail })
    await resolveActor(env.DB, principal, context, {
      nowMs: NOW_MS, correlationId: 'corr_prepare_only_seed', idFactory: ids('prepare_only_seed'),
    })
    const prepareOnly = { prepare: env.DB.prepare.bind(env.DB) }

    await expect(resolveActor(prepareOnly, principal, context, {
      nowMs: NOW_MS, correlationId: 'corr_prepare_only', idFactory: ids('prepare_only'),
    })).resolves.toEqual(expectedActor({ id: 'stf_prepare_only', version: 2 }))
  })

  it('rejects arbitrary, foreign, proxied, accessor, and inherited recovery views before D1', async () => {
    const context = await cryptoContext()
    const principal = { kind: 'human', subject: 'access-sibling', normalizedEmail: 'sibling@example.test' }
    await seedPending(context, { staffId: 'stf_sibling', invitationId: 'inv_sibling', email: principal.normalizedEmail })
    await resolveActor(env.DB, principal, context, {
      nowMs: NOW_MS, correlationId: 'corr_sibling_seed', idFactory: ids('sibling_seed'),
    })
    const first = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const second = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const arbitrary = { prepare: env.DB.prepare.bind(env.DB), batch: env.DB.batch.bind(env.DB) }
    const candidates = [arbitrary, second.recovery, new Proxy(first.recovery, {}), Object.create(first.recovery)]
    for (const recoveryDb of candidates) {
      await expect(resolveActor(first.work, principal, context, {
        nowMs: NOW_MS, correlationId: 'corr_sibling_reject', idFactory: ids('sibling_reject'), recoveryDb,
      })).rejects.toThrow(/^IDENTITY_FAILURE$/)
      expect(first.usage().used).toBe(0)
    }

    let getterCalls = 0
    const accessorOptions = {
      nowMs: NOW_MS, correlationId: 'corr_sibling_accessor', idFactory: ids('sibling_accessor'),
    }
    Object.defineProperty(accessorOptions, 'recoveryDb', {
      enumerable: true,
      get() { getterCalls += 1; return first.recovery },
    })
    await expect(resolveActor(first.work, principal, context, accessorOptions))
      .rejects.toThrow(/^IDENTITY_FAILURE$/)
    expect(getterCalls).toBe(0)

    const inheritedOptions = Object.create({ recoveryDb: first.recovery })
    Object.assign(inheritedOptions, {
      nowMs: NOW_MS, correlationId: 'corr_sibling_inherited', idFactory: ids('sibling_inherited'),
    })
    await expect(resolveActor(first.work, principal, context, inheritedOptions))
      .rejects.toThrow(/^IDENTITY_FAILURE$/)
    expect(first.usage().used).toBe(0)
  })

  it('activates exactly the pending invited staff and returns no PII', async () => {
    const context = await cryptoContext()
    await seedPending(context)
    await expect(resolveActor(env.DB, { kind: 'human', subject: TEST_IDENTITIES.owner.sub, normalizedEmail: TEST_IDENTITIES.owner.email }, context, { nowMs: NOW_MS, correlationId: 'corr_activation', idFactory: (() => { let n = 0; return () => `evt_activation_${++n}` })() }))
      .resolves.toEqual(expectedActor({ id: 'stf_pending', version: 2 }))
    expect(await env.DB.prepare("SELECT status, access_subject, version FROM staff_users WHERE id = 'stf_pending'").first()).toEqual({ status: 'active', access_subject: TEST_IDENTITIES.owner.sub, version: 2 })
    expect(await env.DB.prepare("SELECT status, version FROM staff_invitations WHERE id = 'inv_pending'").first()).toEqual({ status: 'activated', version: 2 })
    const snapshot = await env.DB.prepare("SELECT snapshot_envelope FROM record_versions WHERE entity_id='stf_pending'").first()
    const full = JSON.parse(await decryptForScope(context.keyring, context.dataKey, { expectedScope: scope, recordId: 'stf_pending', field: 'record_version', envelope: JSON.parse(snapshot.snapshot_envelope) }))
    expect(full).toMatchObject({ id: 'stf_pending', status: 'active', access_subject: TEST_IDENTITIES.owner.sub, version: 2, activated_at: instant, updated_at: instant })
    expect(JSON.stringify(snapshot)).not.toContain(TEST_IDENTITIES.owner.email)
    expect(JSON.stringify(snapshot)).not.toContain(TEST_IDENTITIES.owner.sub)
  })

  it('loads an exact frozen default authority snapshot on active and read-only resolution', async () => {
    const context = await cryptoContext()
    const principal = {
      kind: 'human',
      subject: 'access-authority-default',
      normalizedEmail: 'authority-default@example.test',
    }
    await seedPending(context, {
      staffId: 'stf_authority_default',
      invitationId: 'inv_authority_default',
      email: principal.normalizedEmail,
    })
    await resolveActor(env.DB, principal, context, {
      nowMs: NOW_MS,
      correlationId: 'corr_authority_default_activate',
      idFactory: ids('authority_default_activate'),
    })
    const readOnlyBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50,
      recoveryReserve: 8,
    })

    for (const actor of [
      await resolveActor(env.DB, principal, context, {
        nowMs: NOW_MS,
        correlationId: 'corr_authority_default_active',
        idFactory: ids('authority_default_active'),
      }),
      await resolveActiveActorReadOnly(readOnlyBudget.work, principal, context),
    ]) {
      expect(actor).toEqual(expectedActor({ id: 'stf_authority_default', version: 2 }))
      expect(Object.isFrozen(actor)).toBe(true)
      expect(Object.isFrozen(actor.capabilities)).toBe(true)
      expect(Object.keys(actor)).toEqual([
        'id', 'role', 'specialistId', 'version', 'authorityRevision', 'capabilities',
      ])
    }
    expect(readOnlyBudget.usage().used).toBe(2)
  })

  it('loads allow and deny overrides while ignoring cleared rows on active and read-only resolution', async () => {
    const context = await cryptoContext()
    const principal = {
      kind: 'human',
      subject: 'access-authority-overrides',
      normalizedEmail: 'authority-overrides@example.test',
    }
    await seedPending(context, {
      staffId: 'stf_authority_overrides',
      invitationId: 'inv_authority_overrides',
      email: principal.normalizedEmail,
      staffRole: 'coordinator',
    })
    await resolveActor(env.DB, principal, context, {
      nowMs: NOW_MS,
      correlationId: 'corr_authority_overrides_activate',
      idFactory: ids('authority_overrides_activate'),
    })
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO staff_capability_overrides
         (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind('stf_authority_overrides', 'finance.import', 'allow', 1, 'stf_authority_overrides', instant, instant),
      env.DB.prepare(
        `INSERT INTO staff_capability_overrides
         (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind('stf_authority_overrides', 'client.manage', 'deny', 1, 'stf_authority_overrides', instant, instant),
      env.DB.prepare(
        `INSERT INTO staff_capability_overrides
         (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind('stf_authority_overrides', 'chat.general', 'cleared', 1, 'stf_authority_overrides', instant, instant),
      env.DB.prepare(
        `UPDATE staff_authorities SET revision=2,updated_at=?
         WHERE staff_id='stf_authority_overrides' AND revision=1`,
      ).bind(instant),
    ])
    const expected = expectedActor({
      id: 'stf_authority_overrides',
      role: 'coordinator',
      version: 2,
      authorityRevision: 2,
      capabilities: COORDINATOR_OVERRIDE_CAPABILITIES,
    })

    await expect(resolveActor(env.DB, principal, context, {
      nowMs: NOW_MS,
      correlationId: 'corr_authority_overrides_active',
      idFactory: ids('authority_overrides_active'),
    })).resolves.toEqual(expected)
    await expect(resolveActiveActorReadOnly(env.DB, principal, context)).resolves.toEqual(expected)
  })

  it('fails the contained authority loader closed when its authenticated staff snapshot is stale', async () => {
    const context = await cryptoContext()
    const principal = {
      kind: 'human',
      subject: 'access-authority-stale-staff',
      normalizedEmail: 'authority-stale-staff@example.test',
    }
    await seedPending(context, {
      staffId: 'stf_authority_stale_staff',
      invitationId: 'inv_authority_stale_staff',
      email: principal.normalizedEmail,
    })
    await resolveActor(env.DB, principal, context, {
      nowMs: NOW_MS,
      correlationId: 'corr_authority_stale_staff_activate',
      idFactory: ids('authority_stale_staff_activate'),
    })
    const stale = await env.DB.prepare(
      `SELECT id,role,specialist_id,version
       FROM staff_users WHERE id='stf_authority_stale_staff'`,
    ).first()
    await env.DB.prepare(
      `UPDATE staff_users SET version=version+1
       WHERE id='stf_authority_stale_staff' AND version=2`,
    ).run()

    await expect(resolveCurrentAuthorityActor(env.DB, stale))
      .rejects.toThrow(/^IDENTITY_FAILURE$/)
  })

  it.each([
    ['missing authority', 'missing', []],
    ['non-positive revision', 'revision', [
      { authority_revision: 0, capability: null, decision: null },
    ]],
    ['unknown capability', 'unknown', [
      { authority_revision: 1, capability: 'unknown.capability', decision: 'allow' },
    ]],
    ['capability outside the role ceiling', 'ceiling', [
      { authority_revision: 1, capability: 'workbook.own.export', decision: 'allow' },
    ]],
    ['denied constitutional owner permission', 'constitutional', [
      { authority_revision: 1, capability: 'permissions.manage', decision: 'deny' },
    ]],
    ['malformed stored decision', 'decision', [
      { authority_revision: 1, capability: 'chat.general', decision: 'invalid' },
    ]],
    ['malformed empty override', 'empty', [
      { authority_revision: 1, capability: null, decision: 'deny' },
    ]],
  ])('fails closed on %s for active and read-only resolution', async (_label, suffix, rows) => {
    const context = await cryptoContext()
    const principal = {
      kind: 'human',
      subject: `access-authority-${suffix}`,
      normalizedEmail: `authority-${suffix}@example.test`,
    }
    await seedPending(context, {
      staffId: `stf_authority_${suffix}`,
      invitationId: `inv_authority_${suffix}`,
      email: principal.normalizedEmail,
    })
    await resolveActor(env.DB, principal, context, {
      nowMs: NOW_MS,
      correlationId: `corr_authority_${suffix}_activate`,
      idFactory: ids(`authority_${suffix}_activate`),
    })
    const db = dbWithAuthorityRows(rows)

    await expect(resolveActor(db, principal, context, {
      nowMs: NOW_MS,
      correlationId: `corr_authority_${suffix}_active`,
      idFactory: ids(`authority_${suffix}_active`),
    })).rejects.toThrow(/^IDENTITY_FAILURE$/)
    await expect(resolveActiveActorReadOnly(db, principal, context))
      .rejects.toThrow(/^IDENTITY_FAILURE$/)
  })

  it('denies exact expiry and rolls all mutations back when invitation compare-and-set loses', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_expired', invitationId: 'inv_expired', email: 'expired@example.test', expiresAt: instant })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-expired', normalizedEmail: 'expired@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_expired', idFactory: () => 'evt_expired' })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect(await env.DB.prepare("SELECT status, version FROM staff_users WHERE id = 'stf_expired'").first()).toEqual({ status: 'pending', version: 1 })
  })

  it('denies staff and invitation lookup disagreement without modifying identity records', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_mismatch', invitationId: 'inv_mismatch', email: 'staff-mismatch@example.test', invitationEmail: 'invite-mismatch@example.test' })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-mismatch', normalizedEmail: 'staff-mismatch@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_mismatch', idFactory: ids('mismatch') })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect(await env.DB.prepare("SELECT status,access_subject,version FROM staff_users WHERE id='stf_mismatch'").first()).toEqual({ status: 'pending', access_subject: null, version: 1 })
    expect(await env.DB.prepare("SELECT status,version FROM staff_invitations WHERE id='inv_mismatch'").first()).toEqual({ status: 'pending', version: 1 })
  })

  it('requires the pending invitation role to exactly match its staff row', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_role_mismatch', invitationId: 'inv_role_mismatch', email: 'role-mismatch@example.test', invitationRole: 'coordinator' })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-role-mismatch', normalizedEmail: 'role-mismatch@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_role_mismatch', idFactory: ids('role_mismatch') })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect(await env.DB.prepare("SELECT status,version FROM staff_users WHERE id='stf_role_mismatch'").first()).toEqual({ status: 'pending', version: 1 })
    expect(await env.DB.prepare("SELECT status,version FROM staff_invitations WHERE id='inv_role_mismatch'").first()).toEqual({ status: 'pending', version: 1 })
  })

  it('converges a same-subject activation once and rejects a competing subject', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_race', invitationId: 'inv_race', email: 'race@example.test' })
    const input = { kind: 'human', subject: 'access-race', normalizedEmail: 'race@example.test' }
    const options = (correlationId) => ({ nowMs: NOW_MS, correlationId, idFactory: ids(correlationId) })
    const same = await Promise.all([resolveActor(env.DB, input, context, options('corr_race_one')), resolveActor(env.DB, input, context, options('corr_race_two'))])
    expect(same).toEqual([
      expectedActor({ id: 'stf_race', version: 2 }),
      expectedActor({ id: 'stf_race', version: 2 }),
    ])
    expect((await env.DB.prepare("SELECT count(*) AS count FROM audit_events WHERE action='identity.activation' AND entity_id='stf_race'").first()).count).toBe(1)
    await expect(resolveActor(env.DB, { ...input, subject: 'access-race-other' }, context, options('corr_race_other'))).rejects.toThrow(/^ACCESS_DENIED$/)
  })

  it('uses a batch barrier so overlapping different Access subjects produce one activation and one denial', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_subject_race', invitationId: 'inv_subject_race', email: 'subject-race@example.test' })
    const firstGate = blockedBatchDb()
    const secondCommitted = deferred()
    const secondDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements) => {
        const result = await env.DB.batch(statements)
        secondCommitted.resolve()
        return result
      },
    }
    const options = (prefix) => ({ nowMs: NOW_MS, correlationId: `corr_${prefix}`, idFactory: ids(prefix) })
    const first = resolveActor(firstGate.db, { kind: 'human', subject: 'access-subject-one', normalizedEmail: 'subject-race@example.test' }, context, options('subject_one'))
    const loserExpectation = expect(first).rejects.toThrow(/^ACCESS_DENIED$/)
    await firstGate.entered
    const second = resolveActor(secondDb, { kind: 'human', subject: 'access-subject-two', normalizedEmail: 'subject-race@example.test' }, context, options('subject_two'))
    await secondCommitted.promise
    await expect(second).resolves.toEqual(expectedActor({ id: 'stf_subject_race', version: 2 }))
    firstGate.release()
    const staleCollision = await firstGate.failed
    expect(staleCollision).toBeInstanceOf(Error)
    expect(staleCollision.message).toContain('identity_collision')
    await loserExpectation
    expect((await env.DB.prepare("SELECT count(*) AS count FROM audit_events WHERE action='identity.activation' AND entity_id='stf_subject_race'").first()).count).toBe(1)
    expect((await env.DB.prepare("SELECT count(*) AS count FROM record_versions WHERE entity_id IN ('stf_subject_race','inv_subject_race')").first()).count).toBe(2)
  })

  it('converges a stale same-subject activation when D1 throws a frozen collision error', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_frozen_race', invitationId: 'inv_frozen_race', email: 'frozen-race@example.test' })
    const loserGate = blockedBatchDb({ freezeError: true })
    const budget = createD1QueryBudget(loserGate.db, { totalLimit: 50, recoveryReserve: 8 })
    const principal = { kind: 'human', subject: 'access-frozen-race', normalizedEmail: 'frozen-race@example.test' }
    const loser = resolveActor(budget.work, principal, context, {
      nowMs: NOW_MS, correlationId: 'corr_frozen_loser', idFactory: ids('frozen_loser'), recoveryDb: budget.recovery,
    })
    const loserExpectation = expect(loser).resolves.toEqual(expectedActor({ id: 'stf_frozen_race', version: 2 }))
    await loserGate.entered
    const winner = await resolveActor(env.DB, principal, context, { nowMs: NOW_MS, correlationId: 'corr_frozen_winner', idFactory: ids('frozen_winner') })
    loserGate.release()
    await loserExpectation
    expect(winner).toEqual(expectedActor({ id: 'stf_frozen_race', version: 2 }))
    expect(budget.usage()).toEqual({
      used: 21, remaining: 29, workRemaining: 21, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it.each([
    ['staff version', 0, occupyVersionId],
    ['invitation version', 1, occupyVersionId],
    ['audit', 2, occupyAuditId],
  ])('rejects an unrelated row occupying the stale activation %s ID', async (_label, occupiedIndex, occupy) => {
    const context = await cryptoContext()
    const suffix = _label.replaceAll(' ', '_')
    const staffId = `stf_activation_${suffix}`
    const invitationId = `inv_activation_${suffix}`
    const email = `activation-${suffix.replaceAll('_', '-')}@example.test`
    await seedPending(context, { staffId, invitationId, email })
    const generatedIds = [
      `activation_${suffix}_loser_staff_version`,
      `activation_${suffix}_loser_invitation_version`,
      `activation_${suffix}_loser_audit`,
    ]
    const occupiedId = generatedIds[occupiedIndex]
    await occupy(occupiedId)
    const generated = fixedIds(...generatedIds)
    const loserGate = blockedBatchDb()
    const principal = { kind: 'human', subject: `access-activation-${suffix}`, normalizedEmail: email }
    const loser = resolveActor(loserGate.db, principal, context, {
      nowMs: NOW_MS, correlationId: `corr_activation_loser_${suffix}`, idFactory: generated,
    })
    const loserExpectation = expect(loser).rejects.toThrow(/^ACCESS_DENIED$/)
    await loserGate.entered
    await resolveActor(env.DB, principal, context, {
      nowMs: NOW_MS, correlationId: `corr_activation_winner_${suffix}`, idFactory: ids(`activation_winner_${suffix}`),
    })
    loserGate.release()
    await loserExpectation
    expect((await env.DB.prepare('SELECT count(*) AS count FROM audit_events WHERE action=? AND entity_id=?').bind('identity.activation', staffId).first()).count).toBe(1)
  })

  it('stores exact full activation snapshots for staff and invitation without raw identity plaintext', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_exact_snapshot', invitationId: 'inv_exact_snapshot', email: 'exact-snapshot@example.test' })
    await resolveActor(env.DB, { kind: 'human', subject: 'access-exact-snapshot', normalizedEmail: 'exact-snapshot@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_exact_snapshot', idFactory: ids('exact_snapshot') })
    for (const [id, table] of [['stf_exact_snapshot', 'staff_users'], ['inv_exact_snapshot', 'staff_invitations']]) {
      const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first()
      const history = await env.DB.prepare('SELECT snapshot_envelope FROM record_versions WHERE entity_id=?').bind(id).first()
      const snapshot = JSON.parse(await decryptForScope(context.keyring, context.dataKey, { expectedScope: scope, recordId: id, field: 'record_version', envelope: JSON.parse(history.snapshot_envelope) }))
      expect(snapshot).toEqual(row)
      expect(JSON.stringify(history)).not.toContain('exact-snapshot@example.test')
      expect(JSON.stringify(history)).not.toContain('access-exact-snapshot')
    }
    expect(await env.DB.prepare(
      `SELECT entity_type,entity_id,version,changed_by_staff_id,changed_at,correlation_id
       FROM record_versions WHERE entity_id='stf_exact_snapshot'`
    ).first()).toEqual({
      entity_type: 'staff_user', entity_id: 'stf_exact_snapshot', version: 2,
      changed_by_staff_id: 'stf_exact_snapshot', changed_at: instant, correlation_id: 'corr_exact_snapshot',
    })
    expect(await env.DB.prepare(
      `SELECT occurred_at,actor_staff_id,action,entity_type,entity_id,result,reason_envelope,correlation_id,metadata_json
       FROM audit_events WHERE action='identity.activation' AND entity_id='stf_exact_snapshot'`
    ).first()).toEqual({
      occurred_at: instant, actor_staff_id: 'stf_exact_snapshot', action: 'identity.activation',
      entity_type: 'staff_user', entity_id: 'stf_exact_snapshot', result: 'success',
      reason_envelope: null, correlation_id: 'corr_exact_snapshot',
      metadata_json: '{"invitationVersion":2,"specialistVersion":null,"staffVersion":2}',
    })
  })

  it('allows only an exact active subject and audits an identified disabled row without changing it', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_disabled', invitationId: 'inv_disabled', email: 'disabled@example.test' })
    await env.DB.prepare("UPDATE staff_users SET status='disabled', disabled_at=?, version=2, updated_at=? WHERE id='stf_disabled'").bind(instant, instant).run()
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-disabled', normalizedEmail: 'disabled@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_disabled', idFactory: ids('disabled') })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect(await env.DB.prepare("SELECT status,access_subject,version FROM staff_users WHERE id='stf_disabled'").first()).toEqual({ status: 'disabled', access_subject: null, version: 2 })
    expect((await env.DB.prepare("SELECT count(*) AS count FROM audit_events WHERE action='identity.denied' AND entity_id='stf_disabled'").first()).count).toBe(1)
  })

  it('audits the exact subject-bound actor when its JWT email no longer matches a lookup', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_subject_only', invitationId: 'inv_subject_only', email: 'subject-only@example.test' })
    await resolveActor(env.DB, { kind: 'human', subject: 'access-subject-only', normalizedEmail: 'subject-only@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_subject_activate', idFactory: ids('subject_activate') })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-subject-only', normalizedEmail: 'wrong-email@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_subject_wrong', idFactory: ids('subject_wrong') })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect((await env.DB.prepare("SELECT count(*) AS count FROM audit_events WHERE action='identity.denied' AND entity_id='stf_subject_only'").first()).count).toBe(1)
  })

  it('uses the final batch guard to roll back a zero-row invitation CAS after staff CAS', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_guard', invitationId: 'inv_guard', email: 'guard@example.test' })
    const sabotaged = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements) => env.DB.batch([statements[0], env.DB.prepare('UPDATE staff_invitations SET version=version WHERE 0'), ...statements.slice(2)]),
    }
    await expect(resolveActor(sabotaged, { kind: 'human', subject: 'access-guard', normalizedEmail: 'guard@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_guard', idFactory: ids('guard') })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect(await env.DB.prepare("SELECT status,access_subject,version FROM staff_users WHERE id='stf_guard'").first()).toEqual({ status: 'pending', access_subject: null, version: 1 })
    expect(await env.DB.prepare("SELECT status,version FROM staff_invitations WHERE id='inv_guard'").first()).toEqual({ status: 'pending', version: 1 })
    expect((await env.DB.prepare("SELECT count(*) AS count FROM record_versions WHERE entity_id IN ('stf_guard','inv_guard')").first()).count).toBe(0)
  })

  it('sanitizes a non-collision D1 activation failure on the public identity path', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_sql_failure', invitationId: 'inv_sql_failure', email: 'sql-failure@example.test' })
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async () => { throw new Error('D1_ERROR: raw-sql-marker@example.test') },
    }
    const budget = createD1QueryBudget(db, { totalLimit: 50, recoveryReserve: 8 })
    await expect(resolveActor(budget.work, {
      kind: 'human', subject: 'access-sql-marker', normalizedEmail: 'sql-failure@example.test',
    }, context, {
      nowMs: NOW_MS, correlationId: 'corr_sql_failure', idFactory: ids('sql_failure'),
      recoveryDb: budget.recovery,
    })).rejects.toThrow(/^IDENTITY_FAILURE$/)
    expect(budget.usage().used).toBe(12)
  })

  it('keeps active, pending activation, and lazy reindex ordinary work below the 42-query ceiling', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_budget_active', invitationId: 'inv_budget_active', email: 'budget-active@example.test' })
    await resolveActor(env.DB, { kind: 'human', subject: 'access-budget-active', normalizedEmail: 'budget-active@example.test' }, context, {
      nowMs: NOW_MS, correlationId: 'corr_budget_active_seed', idFactory: ids('budget_active_seed'),
    })
    const activeBudget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    await resolveActor(activeBudget.work, { kind: 'human', subject: 'access-budget-active', normalizedEmail: 'budget-active@example.test' }, context, {
      nowMs: NOW_MS, correlationId: 'corr_budget_active', idFactory: ids('budget_active'), recoveryDb: activeBudget.recovery,
    })
    expect(activeBudget.usage().used).toBe(3)

    await seedPending(context, { staffId: 'stf_budget_pending', invitationId: 'inv_budget_pending', email: 'budget-pending@example.test' })
    const pendingBudget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    await resolveActor(pendingBudget.work, { kind: 'human', subject: 'access-budget-pending', normalizedEmail: 'budget-pending@example.test' }, context, {
      nowMs: NOW_MS, correlationId: 'corr_budget_pending', idFactory: ids('budget_pending'), recoveryDb: pendingBudget.recovery,
    })
    expect(pendingBudget.usage().used).toBe(13)

    const v2 = await cryptoContextV2()
    const reindexBudget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    await resolveActor(reindexBudget.work, { kind: 'human', subject: 'access-budget-active', normalizedEmail: 'budget-active@example.test' }, v2, {
      nowMs: NOW_MS, correlationId: 'corr_budget_reindex', idFactory: ids('budget_reindex'), recoveryDb: reindexBudget.recovery,
    })
    expect(reindexBudget.usage().used).toBe(8)
  })

  it('activates retained V1 rows under active V2 and updates both lookups with encrypted-only audit history', async () => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId: 'stf_rotate', invitationId: 'inv_rotate', email: 'rotate@example.test', lookupVersion: 1 })
    await resolveActor(env.DB, { kind: 'human', subject: 'access-rotate', normalizedEmail: 'rotate@example.test' }, v2, { nowMs: NOW_MS, correlationId: 'corr_rotate', idFactory: ids('rotate') })
    const expected = await blindEmailIndex('rotate@example.test', v2.keyring)
    expect(await env.DB.prepare("SELECT email_lookup FROM staff_users WHERE id='stf_rotate'").first()).toEqual({ email_lookup: expected })
    expect(await env.DB.prepare("SELECT email_lookup FROM staff_invitations WHERE id='inv_rotate'").first()).toEqual({ email_lookup: expected })
    const history = await env.DB.prepare("SELECT snapshot_envelope,metadata_json FROM record_versions JOIN audit_events ON 1=1 WHERE record_versions.entity_id IN ('stf_rotate','inv_rotate')").all()
    expect(JSON.stringify(history.results)).not.toContain('rotate@example.test')
    expect(JSON.stringify(history.results)).not.toContain('access-rotate')
    expect(JSON.stringify(history.results)).not.toContain(expected)
  })

  it('lazily reindexes an exact active actor under V2 without changing its Access subject', async () => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId: 'stf_lazy', invitationId: 'inv_lazy', email: 'lazy@example.test', lookupVersion: 1 })
    await resolveActor(env.DB, { kind: 'human', subject: 'access-lazy', normalizedEmail: 'lazy@example.test' }, v1, { nowMs: NOW_MS, correlationId: 'corr_lazy_activate', idFactory: ids('lazy_activate') })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-lazy', normalizedEmail: 'lazy@example.test' }, v2, { nowMs: NOW_MS, correlationId: 'corr_lazy_reindex', idFactory: ids('lazy_reindex') }))
      .resolves.toEqual(expectedActor({ id: 'stf_lazy', version: 3 }))
    expect(await env.DB.prepare("SELECT email_lookup,access_subject,version FROM staff_users WHERE id='stf_lazy'").first())
      .toEqual({ email_lookup: await blindEmailIndex('lazy@example.test', v2.keyring), access_subject: 'access-lazy', version: 3 })
  })

  it('converges concurrent active-login and bounded reindex winners with different generated IDs', async () => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId: 'stf_login_batch_race', invitationId: 'inv_login_batch_race', email: 'login-batch-race@example.test', lookupVersion: 1 })
    await resolveActor(env.DB, {
      kind: 'human', subject: 'access-login-batch-race', normalizedEmail: 'login-batch-race@example.test',
    }, v1, {
      nowMs: NOW_MS, correlationId: 'corr_login_batch_activate', idFactory: ids('login_batch_activate'),
    })
    const loginGate = blockedBatchDb()
    const login = resolveActor(loginGate.db, {
      kind: 'human', subject: 'access-login-batch-race', normalizedEmail: 'login-batch-race@example.test',
    }, v2, {
      nowMs: NOW_MS, correlationId: 'corr_login_reindex_loser', idFactory: ids('login_reindex_loser'),
    })
    const loginExpectation = expect(login).resolves.toEqual(expectedActor({ id: 'stf_login_batch_race', version: 3 }))
    await loginGate.entered
    const winner = await reindexEmailLookupsBatch(env.DB, v2, {
      table: 'staff_users', afterId: 'stf_login_batch_rac', limit: 1, nowMs: NOW_MS,
      correlationId: 'corr_batch_reindex_winner', idFactory: ids('batch_reindex_winner'),
    })
    loginGate.release()
    expect(winner.changed).toBe(1)
    await loginExpectation
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM record_versions WHERE entity_type='staff_user' AND entity_id='stf_login_batch_race' AND version=3"
    ).first()).count).toBe(1)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='identity.reindex' AND entity_id='stf_login_batch_race'"
    ).first()).count).toBe(1)
  })

  it('lets a direct reindex loser converge on a winner using different generated IDs', async () => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId: 'stf_direct_race', invitationId: 'inv_direct_race', email: 'direct-race@example.test', lookupVersion: 1 })
    const loserGate = blockedBatchDb()
    const loser = reindexEmailLookupsBatch(loserGate.db, v2, {
      table: 'staff_users', afterId: 'stf_direct_rac', limit: 1, nowMs: NOW_MS,
      correlationId: 'corr_direct_loser', idFactory: ids('direct_loser'),
    })
    const loserExpectation = expect(loser).resolves.toMatchObject({ scanned: 1, changed: 0 })
    await loserGate.entered
    const winner = await reindexEmailLookupsBatch(env.DB, v2, {
      table: 'staff_users', afterId: 'stf_direct_rac', limit: 1, nowMs: NOW_MS,
      correlationId: 'corr_direct_winner', idFactory: ids('direct_winner'),
    })
    loserGate.release()
    expect(winner.changed).toBe(1)
    await loserExpectation
  })

  it.each([
    ['version', 0, occupyVersionId],
    ['audit', 1, occupyAuditId],
  ])('rejects a direct reindex loser when its generated %s ID is occupied by an unrelated row', async (label, occupiedIndex, occupy) => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    const generatedIds = [`reindex_${label}_loser_version`, `reindex_${label}_loser_audit`]
    const occupiedId = generatedIds[occupiedIndex]
    await seedPending(v1, {
      staffId: `stf_reindex_${label}_collision`, invitationId: `inv_reindex_${label}_collision`,
      email: `${occupiedId.replaceAll('_', '-')}@example.test`, lookupVersion: 1,
    })
    await occupy(occupiedId)
    const loserGate = blockedBatchDb()
    const loser = reindexEmailLookupsBatch(loserGate.db, v2, {
      table: 'staff_users', afterId: `stf_reindex_${label}_collisio`, limit: 1, nowMs: NOW_MS,
      correlationId: `corr_${occupiedId}`, idFactory: fixedIds(...generatedIds),
    })
    const loserExpectation = expect(loser).rejects.toThrow()
    await loserGate.entered
    await reindexEmailLookupsBatch(env.DB, v2, {
      table: 'staff_users', afterId: `stf_reindex_${label}_collisio`, limit: 1, nowMs: NOW_MS,
      correlationId: `corr_winner_${occupiedId}`, idFactory: ids(`winner_${occupiedId}`),
    })
    loserGate.release()
    await loserExpectation
  })

  it.each([
    ['staff_users', 'stf_reindex_snapshot', 'inv_reindex_snapshot', 'reindex-staff-snapshot@example.test'],
    ['staff_invitations', 'stf_invitation_snapshot', 'inv_invitation_snapshot', 'reindex-invitation-snapshot@example.test'],
  ])('stores an exact final-row snapshot when reindexing %s', async (table, staffId, invitationId, email) => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId, invitationId, email, lookupVersion: 1 })
    const targetId = table === 'staff_users' ? staffId : invitationId
    const oldLookup = await blindEmailIndex(email, v1.keyring)
    const newLookup = await blindEmailIndex(email, v2.keyring)
    await reindexEmailLookupsBatch(env.DB, v2, {
      table, afterId: targetId.slice(0, -1), limit: 1, nowMs: NOW_MS,
      correlationId: `corr_snapshot_${table}`, idFactory: ids(`snapshot_${table}`),
    })
    const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(targetId).first()
    const history = await env.DB.prepare(
      'SELECT snapshot_envelope FROM record_versions WHERE entity_type=? AND entity_id=? AND version=2'
    ).bind(table === 'staff_users' ? 'staff_user' : 'staff_invitation', targetId).first()
    const snapshot = JSON.parse(await decryptForScope(v2.keyring, v2.dataKey, {
      expectedScope: scope, recordId: targetId, field: 'record_version', envelope: JSON.parse(history.snapshot_envelope),
    }))
    expect(snapshot).toEqual(row)
    const raw = await Promise.all([
      env.DB.prepare('SELECT snapshot_envelope FROM record_versions WHERE entity_id=?').bind(targetId).all(),
      env.DB.prepare("SELECT metadata_json,reason_envelope FROM audit_events WHERE action='identity.reindex' AND entity_id=?").bind(targetId).all(),
    ])
    const serialized = JSON.stringify(raw)
    for (const marker of [email, oldLookup, newLookup, 'access-reindex-snapshot']) expect(serialized).not.toContain(marker)
  })

  it('reindexes bounded staff and terminal invitations then verifies no retained old index remains', async () => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId: 'stf_reindex_a', invitationId: 'inv_reindex_a', email: 'reindex-a@example.test', lookupVersion: 1 })
    await seedPending(v1, { staffId: 'stf_reindex_b', invitationId: 'inv_reindex_b', email: 'reindex-b@example.test', lookupVersion: 1 })
    await env.DB.prepare("UPDATE staff_invitations SET status='revoked', revoked_at=?, version=2, updated_at=? WHERE id='inv_reindex_b'").bind(instant, instant).run()
    const first = await reindexEmailLookupsBatch(env.DB, v2, { table: 'staff_users', afterId: 'stf_reindex_a', limit: 1, nowMs: NOW_MS, correlationId: 'corr_reindex_staff', idFactory: ids('reindex_staff') })
    expect(first.scanned).toBe(1)
    const invitation = await reindexEmailLookupsBatch(env.DB, v2, { table: 'staff_invitations', afterId: 'inv_reindex_a', limit: 10, nowMs: NOW_MS, correlationId: 'corr_reindex_inv', idFactory: ids('reindex_inv') })
    expect(invitation.changed).toBeGreaterThanOrEqual(1)
    expect((await verifyNoOldEmailLookups(env.DB, v2)).count).toBeGreaterThanOrEqual(1)
    const drain = async (table) => {
      const next = ids(`drain_${table}`)
      let cursor = ''
      while (true) {
        const page = await reindexEmailLookupsBatch(env.DB, v2, { table, afterId: cursor, limit: 10, nowMs: NOW_MS, correlationId: `corr_drain_${table}`, idFactory: next })
        if (page.done) return
        cursor = page.afterId
      }
    }
    await drain('staff_users')
    await drain('staff_invitations')
    await expect(verifyNoOldEmailLookups(env.DB, v2)).resolves.toEqual({ complete: true, count: 0 })
  })

  it('fails closed for multiple retained-version logical staff candidates', async () => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId: 'stf_ambiguous_v1', invitationId: 'inv_ambiguous_v1', email: 'ambiguous@example.test', lookupVersion: 1 })
    await seedPending(v2, { staffId: 'stf_ambiguous_v2', invitationId: 'inv_ambiguous_v2', email: 'ambiguous@example.test', lookupVersion: 2 })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-ambiguous', normalizedEmail: 'ambiguous@example.test' }, v2, { nowMs: NOW_MS, correlationId: 'corr_ambiguous', idFactory: ids('ambiguous') })).rejects.toThrow(/^ACCESS_DENIED$/)
  })
})
