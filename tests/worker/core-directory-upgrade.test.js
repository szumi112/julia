import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { advanceCoreDirectoryUpgrade } from '../../scripts/upgrade-core-directory-core.js'
import { createWrappedDataKey, encryptForScope } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { completeCoreDirectoryStageA } from './apply-migrations.js'

const NOW = '2031-04-05T06:07:08.009Z'
const NOW_MS = Date.parse(NOW)
const STATE_KEY = 'core_directory_specialist_backfill_v1'
const SCOPE = Object.freeze({ id: 'centre_1', purpose: 'identity', type: 'staff_directory' })
const PENDING = Object.freeze({
  afterStaffId: null,
  createdCount: 0,
  processedCount: 0,
  status: 'pending',
})

const json = (value) => JSON.stringify(value)
const correlationIds = new Map()
const correlationId = (label) => {
  if (!correlationIds.has(label)) {
    correlationIds.set(
      label,
      `00000000-0000-4000-8000-${String(correlationIds.size + 100).padStart(12, '0')}`,
    )
  }
  return correlationIds.get(label)
}
const ids = (...values) => {
  let index = 0
  return () => values[index++] ?? `aud_fallback_${index}`
}

const stateRow = () => env.DB.prepare(
  'SELECT value_json,version,updated_at FROM system_state WHERE key=?'
).bind(STATE_KEY).first()

async function setUpgradeState(value) {
  const version = value.processedCount + (value.status === 'complete' ? 2 : 1)
  await forceUpgradeState(value, version)
  return version
}

async function forceUpgradeState(value, version) {
  await env.DB.prepare('DROP TRIGGER system_state_version_increment').run()
  await env.DB.prepare(
    `UPDATE system_state
     SET value_json=?,version=?,updated_at=?
     WHERE key=?`
  ).bind(json(value), version, NOW, STATE_KEY).run()
  await env.DB.prepare(
    `CREATE TRIGGER system_state_version_increment
     BEFORE UPDATE ON system_state
     WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
     BEGIN SELECT RAISE(ABORT, 'invalid_version_increment'); END`
  ).run()
}

async function cryptoContext() {
  const keyring = await createKeyring(env, {
    activeBackupKekVersion: 1,
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
  })
  const existing = await env.DB.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,
            wrap_nonce_b64,kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type='staff_directory' AND scope_id='centre_1'
       AND purpose='identity' AND dek_version=1`
  ).first()
  if (existing) return Object.freeze({ dataKey: existing, keyring, scope: SCOPE })
  const dataKey = await createWrappedDataKey(keyring, {
    createdAt: NOW,
    dekVersion: 1,
    id: 'key_upgrade_staff_directory_v1',
    scope: SCOPE,
  })
  await env.DB.prepare(
    `INSERT INTO data_keys
     (id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
      kek_version,created_at,retired_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL)`
  ).bind(
    dataKey.id,
    dataKey.scope_type,
    dataKey.scope_id,
    dataKey.purpose,
    dataKey.dek_version,
    dataKey.wrapped_key_b64,
    dataKey.wrap_nonce_b64,
    dataKey.kek_version,
    dataKey.created_at,
  ).run()
  return Object.freeze({ dataKey, keyring, scope: SCOPE })
}

async function insertStaff({
  id,
  role = 'owner',
  specialistId,
  status = 'active',
}) {
  const active = status === 'active'
  const disabled = status === 'disabled'
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`
  ).bind(
    id,
    `lookup_${id}`,
    `email_envelope_${id}`,
    `display_envelope_${id}`,
    role,
    status,
    active ? `access:${id}` : null,
    specialistId,
    active ? NOW : null,
    disabled ? NOW : null,
    NOW,
    NOW,
  ).run()
}

const profileFor = (staffId, specialistId, overrides = {}) => ({
  archived_at: null,
  created_at: NOW,
  id: specialistId,
  staff_user_id: staffId,
  standard_rate_grosze: 18000,
  status: 'active',
  updated_at: NOW,
  version: 1,
  ...overrides,
})

const snapshotFor = (profile) => ({
  archivedAt: profile.archived_at,
  createdAt: profile.created_at,
  id: profile.id,
  schema: 'specialist.v1',
  staffUserId: profile.staff_user_id,
  standardRateGrosze: profile.standard_rate_grosze,
  status: profile.status,
  updatedAt: profile.updated_at,
  version: profile.version,
})

async function insertProfile(context, profile, {
  correlationId = 'fixture_profile',
  snapshot = true,
  snapshotId = `ver_fixture_${profile.id}`,
  snapshotPlaintext = snapshotFor(profile),
} = {}) {
  await env.DB.prepare(
    `INSERT INTO specialists
     (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(
    profile.id,
    profile.staff_user_id,
    profile.standard_rate_grosze,
    profile.status,
    profile.version,
    profile.archived_at,
    profile.created_at,
    profile.updated_at,
  ).run()
  if (!snapshot) return
  const envelope = JSON.stringify(await encryptForScope(
    context.keyring,
    context.dataKey,
    {
      expectedScope: context.scope,
      field: 'record_version',
      plaintext: JSON.stringify(snapshotPlaintext),
      recordId: profile.id,
    },
  ))
  await env.DB.prepare(
    `INSERT INTO record_versions
     (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
      changed_at,correlation_id)
     VALUES (?,'specialist',?,?,?,NULL,?,?)`
  ).bind(
    snapshotId,
    profile.id,
    profile.version,
    envelope,
    NOW,
    correlationId,
  ).run()
}

const auditRows = (label) => env.DB.prepare(
  `SELECT id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
          reason_envelope,correlation_id,metadata_json
   FROM audit_events WHERE correlation_id=? ORDER BY id`
).bind(correlationId(label)).all()

const advance = (overrides = {}) => advanceCoreDirectoryUpgrade({
  correlationId: correlationId(overrides.correlationId ?? 'upgrade_test'),
  cryptoContext: null,
  db: env.DB,
  idFactory: ids('aud_upgrade_test'),
  nowMs: NOW_MS,
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'correlationId')),
})

const observedDb = ({
  afterCommit = null,
  ambiguousAfterCommit = false,
  failBatchIndex = null,
} = {}) => {
  const counts = { batch: 0, prepared: 0 }
  const db = {
    batch: async (statements) => {
      counts.batch = statements.length
      if (Number.isInteger(failBatchIndex)) {
        const forced = [...statements]
        forced[failBatchIndex] = env.DB.prepare(
          'INSERT INTO missing_upgrade_failure_table VALUES (1)'
        )
        return env.DB.batch(forced)
      }
      const result = await env.DB.batch(statements)
      if (afterCommit) await afterCommit()
      if (ambiguousAfterCommit) throw new Error('D1_EXECUTE_AMBIGUOUS')
      return result
    },
    prepare: (sql) => {
      counts.prepared += 1
      return env.DB.prepare(sql)
    },
  }
  return { counts, db }
}

beforeEach(async () => {
  for (const sql of [
    'DROP TRIGGER audit_events_no_delete',
    'DROP TRIGGER record_versions_no_delete',
    'DROP TRIGGER specialists_no_delete',
    'DROP TRIGGER staff_users_no_delete',
    'DROP TRIGGER data_keys_no_delete',
    'DROP TRIGGER system_state_version_increment',
    'DELETE FROM audit_events',
    'DELETE FROM record_versions',
    'DELETE FROM specialists',
    'DELETE FROM staff_users',
    'DELETE FROM data_keys',
    `UPDATE system_state
     SET value_json='{"afterStaffId":null,"createdCount":0,"processedCount":0,"status":"pending"}',
         version=1,
         updated_at='2026-07-31T00:00:00.000Z'
     WHERE key='core_directory_specialist_backfill_v1'`,
    `CREATE TRIGGER audit_events_no_delete
     BEFORE DELETE ON audit_events
     BEGIN SELECT RAISE(ABORT, 'append_only'); END`,
    `CREATE TRIGGER record_versions_no_delete
     BEFORE DELETE ON record_versions
     BEGIN SELECT RAISE(ABORT, 'append_only'); END`,
    `CREATE TRIGGER specialists_no_delete
     BEFORE DELETE ON specialists
     BEGIN SELECT RAISE(ABORT, 'no_routine_delete'); END`,
    `CREATE TRIGGER staff_users_no_delete
     BEFORE DELETE ON staff_users
     BEGIN SELECT RAISE(ABORT, 'no_routine_delete'); END`,
    `CREATE TRIGGER data_keys_no_delete
     BEFORE DELETE ON data_keys
     BEGIN SELECT RAISE(ABORT, 'no_routine_delete'); END`,
    `CREATE TRIGGER system_state_version_increment
     BEFORE UPDATE ON system_state
     WHEN typeof(NEW.version) != 'integer' OR NEW.version != OLD.version + 1
     BEGIN SELECT RAISE(ABORT, 'invalid_version_increment'); END`,
  ]) await env.DB.prepare(sql).run()
  await completeCoreDirectoryStageA()
})

describe('bounded core directory upgrade', () => {
  it('completes fresh stage A keylessly once before seed and makes completion idempotent', async () => {
    const state = await stateRow()
    expect(state).toMatchObject({
      value_json: '{"afterStaffId":null,"createdCount":0,"processedCount":0,"status":"complete"}',
      version: 2,
    })
    expect(await env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM staff_users) AS staff_count,
         (SELECT count(*) FROM specialists) AS specialist_count,
         (SELECT count(*) FROM data_keys) AS key_count,
         (SELECT count(*) FROM audit_events) AS audit_count`
    ).first()).toEqual({
      audit_count: 1,
      key_count: 0,
      specialist_count: 0,
      staff_count: 0,
    })
    const audit = (await env.DB.prepare(
      `SELECT actor_staff_id,action,entity_type,entity_id,result,metadata_json
       FROM audit_events`
    ).first())
    expect(audit).toEqual({
      action: 'core_directory.upgrade.advanced',
      actor_staff_id: null,
      entity_id: STATE_KEY,
      entity_type: 'system_state',
      metadata_json: '{"createdCount":0,"processedCount":0,"stateVersion":2}',
      result: 'success',
    })

    await expect(advance({ correlationId: 'fresh_noop', idFactory: ids('aud_fresh_noop') }))
      .resolves.toEqual({ createdCount: 0, processedCount: 0, status: 'complete' })
    expect((await env.DB.prepare('SELECT count(*) AS count FROM audit_events').first()).count)
      .toBe(1)
  })

  it('advances exactly one lexical row per step, validates an existing snapshot, creates mapped v1, and completes', async () => {
    const context = await cryptoContext()
    const initialVersion = await setUpgradeState(PENDING)
    await insertStaff({ id: 'stf_upgrade_a', specialistId: 'sp_upgrade_a' })
    await insertStaff({ id: 'stf_upgrade_b', specialistId: 'sp_upgrade_b' })
    await insertProfile(context, profileFor('stf_upgrade_a', 'sp_upgrade_a'))

    const firstDb = observedDb()
    await expect(advance({
      correlationId: 'upgrade_existing',
      cryptoContext: context,
      db: firstDb.db,
      idFactory: ids('aud_upgrade_existing'),
    })).resolves.toEqual({ createdCount: 0, processedCount: 1, status: 'running' })
    expect(firstDb.counts).toEqual({ batch: 3, prepared: 7 })
    expect(await stateRow()).toEqual({
      updated_at: NOW,
      value_json: '{"afterStaffId":"stf_upgrade_a","createdCount":0,"processedCount":1,"status":"running"}',
      version: initialVersion + 1,
    })
    expect((await auditRows('upgrade_existing')).results).toEqual([expect.objectContaining({
      action: 'core_directory.upgrade.advanced',
      actor_staff_id: null,
      entity_id: STATE_KEY,
      entity_type: 'system_state',
      metadata_json: `{"createdCount":0,"processedCount":1,"stateVersion":${initialVersion + 1}}`,
      reason_envelope: null,
      result: 'success',
    })])

    const secondDb = observedDb()
    await expect(advance({
      correlationId: 'upgrade_create',
      cryptoContext: context,
      db: secondDb.db,
      idFactory: ids('ver_upgrade_b', 'aud_upgrade_create'),
    })).resolves.toEqual({ createdCount: 1, processedCount: 2, status: 'running' })
    expect(secondDb.counts).toEqual({ batch: 5, prepared: 8 })
    expect(await stateRow()).toEqual({
      updated_at: NOW,
      value_json: '{"afterStaffId":"stf_upgrade_b","createdCount":1,"processedCount":2,"status":"running"}',
      version: initialVersion + 2,
    })
    expect(await env.DB.prepare(
      `SELECT id,staff_user_id,standard_rate_grosze,status,version,archived_at,
              created_at,updated_at FROM specialists WHERE id='sp_upgrade_b'`
    ).first()).toEqual(profileFor('stf_upgrade_b', 'sp_upgrade_b'))
    expect((await auditRows('upgrade_create')).results).toEqual([expect.objectContaining({
      action: 'specialist.backfilled',
      actor_staff_id: null,
      entity_id: 'sp_upgrade_b',
      entity_type: 'specialist',
      metadata_json: `{"specialistVersion":1,"stateVersion":${initialVersion + 2}}`,
      result: 'success',
    })])

    await expect(advance({
      correlationId: 'upgrade_complete',
      cryptoContext: context,
      idFactory: ids('aud_upgrade_complete'),
    })).resolves.toEqual({ createdCount: 1, processedCount: 2, status: 'complete' })
    expect(await stateRow()).toEqual({
      updated_at: NOW,
      value_json: '{"afterStaffId":"stf_upgrade_b","createdCount":1,"processedCount":2,"status":"complete"}',
      version: initialVersion + 3,
    })
  })

  it('rolls back profile, version, audit, state, and guard at every create-UOW statement', async () => {
    const context = await cryptoContext()
    await setUpgradeState(PENDING)
    await insertStaff({ id: 'stf_upgrade_rollback', specialistId: 'sp_upgrade_rollback' })
    const before = await stateRow()

    for (let failureIndex = 0; failureIndex < 5; failureIndex += 1) {
      const injected = observedDb({ failBatchIndex: failureIndex })
      await expect(advance({
        correlationId: `upgrade_rollback_${failureIndex}`,
        cryptoContext: context,
        db: injected.db,
        idFactory: ids('ver_upgrade_rollback', 'aud_upgrade_rollback'),
      })).rejects.toThrow('CORE_DIRECTORY_UPGRADE_INVALID')
      expect(injected.counts.batch).toBe(5)
      expect(await stateRow()).toEqual(before)
      expect(await env.DB.prepare(
        `SELECT
           (SELECT count(*) FROM specialists WHERE id='sp_upgrade_rollback') AS profiles,
           (SELECT count(*) FROM record_versions WHERE entity_id='sp_upgrade_rollback') AS versions,
           (SELECT count(*) FROM audit_events WHERE correlation_id LIKE 'upgrade_rollback_%') AS audits`
      ).first()).toEqual({ audits: 0, profiles: 0, versions: 0 })
    }
  })

  it('recovers one winner after an ambiguous committed batch within the 12-statement ceiling', async () => {
    const context = await cryptoContext()
    await setUpgradeState(PENDING)
    await insertStaff({ id: 'stf_upgrade_ambiguous', specialistId: 'sp_upgrade_ambiguous' })
    await insertProfile(context, profileFor('stf_upgrade_ambiguous', 'sp_upgrade_ambiguous'))
    const injected = observedDb({ ambiguousAfterCommit: true })

    await expect(advance({
      correlationId: 'upgrade_ambiguous',
      cryptoContext: context,
      db: injected.db,
      idFactory: ids('aud_upgrade_ambiguous'),
    })).resolves.toEqual({ createdCount: 0, processedCount: 1, status: 'running' })
    expect(injected.counts.prepared).toBeLessThanOrEqual(12)
    expect((await auditRows('upgrade_ambiguous')).results).toHaveLength(1)
  })

  it('recovers when the winning runner advances another lexical row before the reread', async () => {
    const context = await cryptoContext()
    await setUpgradeState(PENDING)
    await insertStaff({ id: 'stf_upgrade_race_a', specialistId: 'sp_upgrade_race_a' })
    await insertStaff({ id: 'stf_upgrade_race_b', specialistId: 'sp_upgrade_race_b' })
    await insertProfile(context, profileFor('stf_upgrade_race_a', 'sp_upgrade_race_a'))
    await insertProfile(context, profileFor('stf_upgrade_race_b', 'sp_upgrade_race_b'))
    const injected = observedDb({
      afterCommit: () => advance({
        correlationId: 'upgrade_race_followup',
        cryptoContext: context,
        idFactory: ids('aud_upgrade_race_followup'),
      }),
      ambiguousAfterCommit: true,
    })

    await expect(advance({
      correlationId: 'upgrade_race_advanced',
      cryptoContext: context,
      db: injected.db,
      idFactory: ids('aud_upgrade_race_advanced'),
    })).resolves.toEqual({ createdCount: 0, processedCount: 2, status: 'running' })
    expect(injected.counts.prepared).toBeLessThanOrEqual(12)
    expect((await auditRows('upgrade_race_advanced')).results).toHaveLength(1)
    expect((await auditRows('upgrade_race_followup')).results).toHaveLength(1)
  })

  it.each([
    ['changes the create count for the same processed row', {
      afterStaffId: 'stf_upgrade_incompatible_a',
      createdCount: 1,
      processedCount: 1,
      status: 'running',
    }],
    ['advances the cursor without advancing the processed count', {
      afterStaffId: 'stf_upgrade_incompatible_b',
      createdCount: 0,
      processedCount: 1,
      status: 'running',
    }],
    ['advances the processed count without advancing the cursor', {
      afterStaffId: 'stf_upgrade_incompatible_a',
      createdCount: 0,
      processedCount: 2,
      status: 'running',
    }],
  ])('rejects ambiguous recovery when the reloaded state %s', async (_label, winner) => {
    const context = await cryptoContext()
    await setUpgradeState(PENDING)
    await insertStaff({
      id: 'stf_upgrade_incompatible_a',
      specialistId: 'sp_upgrade_incompatible_a',
    })
    await insertProfile(
      context,
      profileFor('stf_upgrade_incompatible_a', 'sp_upgrade_incompatible_a'),
    )
    const injected = observedDb({
      afterCommit: () => forceUpgradeState(
        winner,
        winner.processedCount + (winner.status === 'complete' ? 2 : 1),
      ),
      ambiguousAfterCommit: true,
    })

    await expect(advance({
      correlationId: 'upgrade_incompatible_recovery',
      cryptoContext: context,
      db: injected.db,
      idFactory: ids('aud_upgrade_incompatible_recovery'),
    })).rejects.toThrow('CORE_DIRECTORY_UPGRADE_INVALID')
    expect(injected.counts.prepared).toBeLessThanOrEqual(12)
  })

  it('gives concurrent runners one committed row winner and lets the loser reload the cursor', async () => {
    const context = await cryptoContext()
    await setUpgradeState(PENDING)
    await insertStaff({ id: 'stf_upgrade_race', specialistId: 'sp_upgrade_race' })
    await insertProfile(context, profileFor('stf_upgrade_race', 'sp_upgrade_race'))

    const results = await Promise.all([
      advance({
        correlationId: 'upgrade_race_one',
        cryptoContext: context,
        idFactory: ids('aud_upgrade_race_one'),
      }),
      advance({
        correlationId: 'upgrade_race_two',
        cryptoContext: context,
        idFactory: ids('aud_upgrade_race_two'),
      }),
    ])
    expect(results).toEqual([
      { createdCount: 0, processedCount: 1, status: 'running' },
      { createdCount: 0, processedCount: 1, status: 'running' },
    ])
    expect(
      (await auditRows('upgrade_race_one')).results.length
      + (await auditRows('upgrade_race_two')).results.length,
    ).toBe(1)
  })

  it('resumes strictly after the committed cursor and completion stays a no-op', async () => {
    const context = await cryptoContext()
    await setUpgradeState(PENDING)
    await insertStaff({ id: 'stf_upgrade_resume_a', specialistId: 'sp_upgrade_resume_a' })
    await insertStaff({ id: 'stf_upgrade_resume_b', specialistId: 'sp_upgrade_resume_b' })
    await insertProfile(context, profileFor('stf_upgrade_resume_a', 'sp_upgrade_resume_a'))
    await insertProfile(context, profileFor('stf_upgrade_resume_b', 'sp_upgrade_resume_b'))

    await advance({
      correlationId: 'upgrade_resume_first',
      cryptoContext: context,
      idFactory: ids('aud_upgrade_resume_first'),
    })
    await advance({
      correlationId: 'upgrade_resume_second',
      cryptoContext: context,
      idFactory: ids('aud_upgrade_resume_second'),
    })
    const complete = await advance({
      correlationId: 'upgrade_resume_complete',
      cryptoContext: context,
      idFactory: ids('aud_upgrade_resume_complete'),
    })
    const beforeNoop = await stateRow()
    expect(complete).toEqual({ createdCount: 0, processedCount: 2, status: 'complete' })
    await expect(advance({
      correlationId: 'upgrade_resume_noop',
      cryptoContext: context,
      idFactory: ids('aud_upgrade_resume_noop'),
    })).resolves.toEqual(complete)
    expect(await stateRow()).toEqual(beforeNoop)
    expect((await auditRows('upgrade_resume_noop')).results).toHaveLength(0)
  })

  it.each([
    ['mismatched profile', async (context) => {
      await insertStaff({ id: 'stf_upgrade_bad', specialistId: 'sp_upgrade_expected' })
      await insertProfile(context, profileFor('stf_upgrade_bad', 'sp_upgrade_other'))
    }],
    ['status mismatch independent of role', async (context) => {
      await insertStaff({ id: 'stf_upgrade_bad', role: 'owner', specialistId: 'sp_upgrade_bad' })
      await insertProfile(context, profileFor('stf_upgrade_bad', 'sp_upgrade_bad', { status: 'pending' }))
    }],
    ['missing snapshot', async (context) => {
      await insertStaff({ id: 'stf_upgrade_bad', specialistId: 'sp_upgrade_bad' })
      await insertProfile(context, profileFor('stf_upgrade_bad', 'sp_upgrade_bad'), { snapshot: false })
    }],
    ['tampered snapshot', async (context) => {
      await insertStaff({ id: 'stf_upgrade_bad', specialistId: 'sp_upgrade_bad' })
      await insertProfile(context, profileFor('stf_upgrade_bad', 'sp_upgrade_bad'), {
        snapshotPlaintext: { schema: 'specialist.v1', status: 'active' },
      })
    }],
    ['malformed profile', async (context) => {
      await insertStaff({ id: 'stf_upgrade_bad', specialistId: 'sp_upgrade_bad' })
      await insertProfile(context, profileFor('stf_upgrade_bad', 'sp_upgrade_bad', {
        created_at: 'not-an-instant',
      }))
    }],
  ])('fails closed on %s without moving state', async (_label, arrange) => {
    const context = await cryptoContext()
    await setUpgradeState(PENDING)
    await arrange(context)
    const before = await stateRow()
    await expect(advance({
      correlationId: 'upgrade_bad_fixture',
      cryptoContext: context,
      idFactory: ids('aud_upgrade_bad_fixture'),
    })).rejects.toThrow('CORE_DIRECTORY_UPGRADE_INVALID')
    expect(await stateRow()).toEqual(before)
    expect((await auditRows('upgrade_bad_fixture')).results).toHaveLength(0)
  })

  it('requires crypto for any pointer/profile path and does not accept a missing key placeholder', async () => {
    await setUpgradeState(PENDING)
    await insertStaff({ id: 'stf_upgrade_keyless_bad', specialistId: 'sp_upgrade_keyless_bad' })
    const before = await stateRow()
    await expect(advance({
      correlationId: 'upgrade_keyless_bad',
      idFactory: ids('aud_upgrade_keyless_bad'),
    })).rejects.toThrow('CORE_DIRECTORY_CRYPTO_REQUIRED')
    expect(await stateRow()).toEqual(before)
    expect((await env.DB.prepare('SELECT count(*) AS count FROM data_keys').first()).count).toBe(0)
  })

  it('fails closed on a tampered staff-directory key without moving state', async () => {
    const context = await cryptoContext()
    await setUpgradeState(PENDING)
    await insertStaff({ id: 'stf_upgrade_wrong_key', specialistId: 'sp_upgrade_wrong_key' })
    await insertProfile(context, profileFor('stf_upgrade_wrong_key', 'sp_upgrade_wrong_key'))
    const wrongKeyring = await createKeyring({
      BWM_BACKUP_KEK_V1: env.BWM_BACKUP_KEK_V1,
      BWM_DATA_KEK_V1: encodeBase64Url(new Uint8Array(32).fill(91)),
      BWM_LOOKUP_HMAC_V1: env.BWM_LOOKUP_HMAC_V1,
    }, {
      activeBackupKekVersion: 1,
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
    })
    const before = await stateRow()
    await expect(advance({
      correlationId: 'upgrade_wrong_key',
      cryptoContext: Object.freeze({ ...context, keyring: wrongKeyring }),
      idFactory: ids('aud_upgrade_wrong_key'),
    })).rejects.toThrow('CORE_DIRECTORY_UPGRADE_INVALID')
    expect(await stateRow()).toEqual(before)
    expect((await auditRows('upgrade_wrong_key')).results).toHaveLength(0)
  })

  it('authenticates crypto before accepting a completed nonempty directory', async () => {
    const context = await cryptoContext()
    await setUpgradeState(PENDING)
    await insertStaff({ id: 'stf_upgrade_complete_key', specialistId: 'sp_upgrade_complete_key' })
    await insertProfile(
      context,
      profileFor('stf_upgrade_complete_key', 'sp_upgrade_complete_key'),
    )
    await advance({
      correlationId: 'upgrade_complete_key_scan',
      cryptoContext: context,
      idFactory: ids('aud_upgrade_complete_key_scan'),
    })
    await advance({
      correlationId: 'upgrade_complete_key_finish',
      cryptoContext: context,
      idFactory: ids('aud_upgrade_complete_key_finish'),
    })
    const wrongKeyring = await createKeyring({
      BWM_BACKUP_KEK_V1: env.BWM_BACKUP_KEK_V1,
      BWM_DATA_KEK_V1: encodeBase64Url(new Uint8Array(32).fill(92)),
      BWM_LOOKUP_HMAC_V1: env.BWM_LOOKUP_HMAC_V1,
    }, {
      activeBackupKekVersion: 1,
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
    })
    const before = await stateRow()

    await expect(advance({
      correlationId: 'upgrade_complete_wrong_key',
      cryptoContext: Object.freeze({ ...context, keyring: wrongKeyring }),
      idFactory: ids('aud_upgrade_complete_wrong_key'),
    })).rejects.toThrow('CORE_DIRECTORY_UPGRADE_INVALID')
    expect(await stateRow()).toEqual(before)
    expect((await auditRows('upgrade_complete_wrong_key')).results).toHaveLength(0)
  })

  it.each([
    ['pending', PENDING, 2],
    ['running', {
      afterStaffId: 'stf_upgrade_version',
      createdCount: 0,
      processedCount: 1,
      status: 'running',
    }, 3],
    ['complete', {
      afterStaffId: null,
      createdCount: 0,
      processedCount: 0,
      status: 'complete',
    }, 3],
  ])('rejects a canonical %s payload with an incompatible state version', async (
    _label,
    value,
    version,
  ) => {
    await forceUpgradeState(value, version)
    await expect(advance({
      correlationId: 'upgrade_bad_state_version',
      idFactory: ids('aud_upgrade_bad_state_version'),
    })).rejects.toThrow('CORE_DIRECTORY_UPGRADE_INVALID')
    expect((await auditRows('upgrade_bad_state_version')).results).toHaveLength(0)
  })

  it.each([
    ['missing_profile', async (_context) => {
      await insertStaff({ id: 'stf_upgrade_anomaly', specialistId: 'sp_upgrade_anomaly' })
    }],
    ['orphan_profile', async (context) => {
      await insertStaff({ id: 'stf_upgrade_anomaly', specialistId: null })
      await insertProfile(context, profileFor('stf_upgrade_anomaly', 'sp_upgrade_anomaly'))
    }],
    ['pointer_mismatch', async (context) => {
      await insertStaff({ id: 'stf_upgrade_anomaly', specialistId: 'sp_upgrade_expected' })
      await insertProfile(context, profileFor('stf_upgrade_anomaly', 'sp_upgrade_other'))
    }],
    ['status_mismatch', async (context) => {
      await insertStaff({ id: 'stf_upgrade_anomaly', specialistId: 'sp_upgrade_anomaly' })
      await insertProfile(context, profileFor('stf_upgrade_anomaly', 'sp_upgrade_anomaly', {
        status: 'pending',
      }))
    }],
    ['missing_version', async (context) => {
      await insertStaff({ id: 'stf_upgrade_anomaly', specialistId: 'sp_upgrade_anomaly' })
      await insertProfile(context, profileFor('stf_upgrade_anomaly', 'sp_upgrade_anomaly'), {
        snapshot: false,
      })
    }],
    ['noncontiguous_versions', async (context) => {
      await insertStaff({ id: 'stf_upgrade_anomaly', specialistId: 'sp_upgrade_anomaly' })
      await insertProfile(context, profileFor('stf_upgrade_anomaly', 'sp_upgrade_anomaly', {
        version: 2,
      }))
    }],
  ])('global completion guard rejects %s and rolls completion back', async (_kind, arrange) => {
    const context = await cryptoContext()
    await setUpgradeState({
      afterStaffId: 'stf_zzzz',
      createdCount: 0,
      processedCount: 1,
      status: 'running',
    })
    await arrange(context)
    const before = await stateRow()
    await expect(advance({
      correlationId: 'upgrade_global_anomaly',
      cryptoContext: context,
      idFactory: ids('aud_upgrade_global_anomaly'),
    })).rejects.toThrow('CORE_DIRECTORY_UPGRADE_INVALID')
    expect(await stateRow()).toEqual(before)
    expect((await auditRows('upgrade_global_anomaly')).results).toHaveLength(0)
  })
})
