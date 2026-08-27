import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const cli = new URL('../../scripts/restore-backup.mjs', import.meta.url)

test('restore CLI refuses an unsafe target before provider access and emits only a fixed status', () => {
  const secret = 'operator-secret@example.test'
  const result = spawnSync(process.execPath, [
    cli.pathname,
    '--manifest',
    'backups/v1/2044/07/bkp_cli_safe.manifest.json',
    '--target',
    'bearwithme-panel-production',
    '--sentinel',
    'opaque_restore_sentinel',
  ], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      BWM_BACKUP_KEK_V1: secret,
      R2_SECRET_ACCESS_KEY: secret,
    },
  })

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '{"status":"refused"}\n')
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /operator-secret|example\.test/)
})
