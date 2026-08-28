import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
const preStageNames = exactNames.slice(0, 15)

test('migration status returns fixed exact pre-stage and post-stage evidence', async () => {
  const cases = [
    ['pre-stage', preStageNames, 'e16e136ee03ef9e15ba9b73e2ba986505b4ea6d04add1dd2bbf8d39ac51b77fc'],
    ['post-stage', exactNames, 'f96af3398c37002ac216d95cab9fb8577cb44090f8405c4970019ee6c763ea73'],
  ]
  for (const [expectation, names, migrationSetSha256] of cases) {
    const result = await migrationStatusEvidence(names.map((name, index) => ({
      id: index + 1, name,
    })), expectation)

    assert.deepEqual(result, {
      migrationNames: names,
      migrationCount: names.length,
      migrationSetSha256,
      expectation,
      status: 'ok',
    })
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.migrationNames), true)
  }
})

test('migration status refuses arbitrary expectations, gaps, unknowns, extras and cross-mode lists', async () => {
  for (const [rows, expectation] of [
    [[{ id: 2, name: '0002_identity_operations.sql' }], 'pre-stage'],
    [[
      { id: 1, name: '0001_security_primitives.sql' },
      { id: 3, name: '0003_rate_limit_guard.sql' },
    ], 'pre-stage'],
    [[{ id: 1, name: '9999_unknown.sql' }], 'pre-stage'],
    [[{ id: 1, name: '0001_security_primitives.sql', source: 'forbidden' }], 'pre-stage'],
    [exactNames.slice(0, 14).map((name, index) => ({ id: index + 1, name })), 'pre-stage'],
    [exactNames.slice(0, 16).map((name, index) => ({ id: index + 1, name })), 'pre-stage'],
    [preStageNames.map((name, index) => ({ id: index + 1, name })), 'post-stage'],
    [exactNames.map((name, index) => ({ id: index + 1, name })), 'operator-list'],
  ]) {
    await assert.rejects(
      migrationStatusEvidence(rows, expectation),
      /^Error: MIGRATION_STATUS_STAGING_FAILED$/,
    )
  }
})

test('migration status CLI accepts only fixed pre-stage or post-stage grammar', () => {
  for (const [args, environment, status] of [
    [['pre-stage'], { APP_ENV: 'production', DATA_MODE: 'fictional' }, 'refused'],
    [['post-stage'], { APP_ENV: 'staging', DATA_MODE: 'real' }, 'refused'],
    [['pre-stage'], {
      APP_ENV: 'staging', DATA_MODE: 'fictional',
      BWM_CONFIRM_PRODUCTION_DATABASE: 'must-not-print',
    }, 'refused'],
    [[], { APP_ENV: 'staging', DATA_MODE: 'fictional' }, 'refused'],
    [['operator-list'], { APP_ENV: 'staging', DATA_MODE: 'fictional' }, 'refused'],
    [['pre-stage', 'must-not-print'], {
      APP_ENV: 'staging', DATA_MODE: 'fictional',
    }, 'refused'],
    [['pre-stage'], { APP_ENV: 'staging', DATA_MODE: 'fictional' }, 'failed'],
    [['post-stage'], { APP_ENV: 'staging', DATA_MODE: 'fictional' }, 'failed'],
  ]) {
    const result = run(args, environment)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, `${JSON.stringify({ status })}\n`)
    assert.doesNotMatch(result.stderr, /must-not-print|CLOUDFLARE|TOKEN|database|Users\//i)
  }
})

test('package scripts expose unambiguous fixed staging migration expectations', () => {
  const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).scripts
  assert.equal(scripts['migration:status:staging:pre-stage'],
    'APP_ENV=staging DATA_MODE=fictional node scripts/migration-status-staging.mjs pre-stage')
  assert.equal(scripts['migration:status:staging:post-stage'],
    'APP_ENV=staging DATA_MODE=fictional node scripts/migration-status-staging.mjs post-stage')
  assert.equal(Object.hasOwn(scripts, 'migration:status:staging'), false)
})
