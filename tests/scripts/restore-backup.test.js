import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const cli = new URL('../../scripts/restore-backup.mjs', import.meta.url)
const run = (args) => spawnSync(process.execPath, [cli.pathname, ...args], {
  encoding: 'utf8',
  env: {
    PATH: process.env.PATH,
    APP_ENV: 'staging',
    DATA_MODE: 'fictional',
    BWM_BACKUP_KEK_V1: 'operator-secret@example.test',
    R2_SECRET_ACCESS_KEY: 'operator-secret@example.test',
  },
})

test('restore CLI rejects removed sentinel/migration trust flags and unsafe targets with fixed output', () => {
  for (const args of [
    ['--manifest', 'backups/v2/2044/07/bkp_cli_safe.manifest.json', '--target', 'bearwithme-restore-safe', '--sentinel', 'invented'],
    ['--manifest', 'backups/v2/2044/07/bkp_cli_safe.manifest.json', '--target', 'bearwithme-restore-safe', '--migrations', '0001_fake.sql'],
    ['--manifest', 'backups/v2/2044/07/bkp_cli_safe.manifest.json', '--target', 'bearwithme-panel-production'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '{"status":"refused"}\n')
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /operator-secret|example\.test|invented|fake/)
  }
})

test('restore CLI accepts the legacy flag only as a valueless boolean and otherwise fails before provider access', () => {
  for (const args of [
    ['--manifest', 'backups/v1/2044/07/bkp_cli_safe.manifest.json', '--target', 'bearwithme-restore-safe'],
    ['--manifest', 'backups/v1/2044/07/bkp_cli_safe.manifest.json', '--target', 'bearwithme-restore-safe', '--allow-legacy-unverified', 'true'],
    ['--allow-legacy-unverified', '--allow-legacy-unverified', '--manifest', 'backups/v1/2044/07/bkp_cli_safe.manifest.json', '--target', 'bearwithme-restore-safe'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '{"status":"refused"}\n')
  }
})
