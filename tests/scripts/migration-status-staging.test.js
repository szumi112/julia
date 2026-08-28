import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { migrationStatusEvidence } from '../../scripts/migration-status-staging-lib.mjs'

const cli = new URL('../../scripts/migration-status-staging.mjs', import.meta.url)
const run = (args, environment) => spawnSync(process.execPath, [cli.pathname, ...args], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH, ...environment },
})

const exactNames = [
  '0001_security_primitives.sql',
  '0002_identity_operations.sql',
  '0003_rate_limit_guard.sql',
  '0004_staff_provisioning_state.sql',
  '0005_outbox_operation_guard.sql',
  '0006_delivery_attempt_uniqueness.sql',
  '0007_operational_health_indexes.sql',
  '0008_outbox_drain_heartbeat.sql',
  '0009_core_directory_expand.sql',
  '0010_specialist_lifecycle_assertion.sql',
  '0011_appointment_ledger.sql',
  '0012_finance_ledger.sql',
  '0013_finance_source_deduplication.sql',
  '0014_finance_import_recovery.sql',
  '0015_unclaimed_specialist_profiles.sql',
  '0016_workbook_source_records.sql',
  '0017_historical_workspace.sql',
  '0018_activity_workspace.sql',
  '0019_dual_role_specialists.sql',
  '0020_capability_overrides.sql',
  '0021_finance_reporting_registry.sql',
]

test('migration status returns exactly ordered 0001 through 0021 with a name-array digest', async () => {
  const result = await migrationStatusEvidence(exactNames.map((name, index) => ({
    id: index + 1, name,
  })))

  assert.deepEqual(result, {
    migrationNames: exactNames,
    migrationCount: 21,
    migrationSetSha256: 'f96af3398c37002ac216d95cab9fb8577cb44090f8405c4970019ee6c763ea73',
    status: 'ok',
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.migrationNames), true)
})

test('migration status refuses gaps, unknown names, unordered ids and non-exact rows', async () => {
  for (const rows of [
    [{ id: 2, name: '0002_identity_operations.sql' }],
    [
      { id: 1, name: '0001_security_primitives.sql' },
      { id: 3, name: '0003_rate_limit_guard.sql' },
    ],
    [{ id: 1, name: '9999_unknown.sql' }],
    [{ id: 1, name: '0001_security_primitives.sql', source: 'forbidden' }],
    exactNames.slice(0, 20).map((name, index) => ({ id: index + 1, name })),
  ]) {
    await assert.rejects(migrationStatusEvidence(rows), /^Error: MIGRATION_STATUS_STAGING_FAILED$/)
  }
})

test('migration status CLI is staging-only, argument-free and emits fixed failures', () => {
  for (const [args, environment, status] of [
    [[], { APP_ENV: 'production', DATA_MODE: 'fictional' }, 'refused'],
    [[], { APP_ENV: 'staging', DATA_MODE: 'real' }, 'refused'],
    [[], {
      APP_ENV: 'staging', DATA_MODE: 'fictional',
      BWM_CONFIRM_PRODUCTION_DATABASE: 'must-not-print',
    }, 'refused'],
    [['--database', 'must-not-print'], {
      APP_ENV: 'staging', DATA_MODE: 'fictional',
    }, 'refused'],
    [[], { APP_ENV: 'staging', DATA_MODE: 'fictional' }, 'failed'],
  ]) {
    const result = run(args, environment)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, `${JSON.stringify({ status })}\n`)
    assert.doesNotMatch(result.stderr, /must-not-print|CLOUDFLARE|TOKEN|database|Users\//i)
  }
})
