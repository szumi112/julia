import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { restoreBackup, validateRestoreRequest } from '../../scripts/restore-backup-lib.mjs'

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/backup-format-v1.json', import.meta.url),
  'utf8',
))
const manifestBytes = Uint8Array.from(
  Buffer.from(fixture.canonicalManifestBase64Url, 'base64url'),
)
const derive = (seed) => Uint8Array.from(
  { length: 32 },
  (_, index) => (seed + (index * 29)) & 0xff,
)
const keyring = Object.freeze({
  getBackupKek: async (version) => version === 1
    ? crypto.subtle.importKey(
      'raw',
      derive(fixture.publicDerivationSeeds.backupKek),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
    : null,
})

test('guarded restore authenticates R2 facts, imports through 0600, verifies migrations and sentinel, then cleans up', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bwm-restore-test-'))
  const sql = Buffer.alloc(fixture.manifest.objectSize, 0x2d)
  sql.set(Buffer.from('CREATE TABLE opaque_restore_fixture(value TEXT);\n'), 0)
  const sentinel = 'restore_sentinel_opaque_2044'
  const commands = []
  const logs = []
  let importedPath = null

  const result = await restoreBackup({
    request: {
      manifestKey: fixture.objectKeys.manifestKey,
      target: 'bearwithme-restore-drill-2044',
      sentinel,
    },
    sourceDatabaseNames: ['bearwithme-panel-staging-v3'],
    sourceDatabaseIds: ['df9375e3-b5a8-4fe2-83b2-52acf78beb17'],
    productionDatabaseNames: ['bearwithme-panel-production'],
    productionDatabaseIds: ['6f1eef07-18e5-4ecd-81d9-43e191f3ca72'],
    expectedMigrations: ['0001_identity_operations.sql', '0002_core_records.sql'],
    tempRoot,
    keyring,
    provider: {
      async describeDatabase(target) {
        return {
          name: target,
          id: '11111111-2222-4333-8444-555555555555',
          jurisdiction: 'eu',
        }
      },
      async getManifest(key) {
        assert.equal(key, fixture.objectKeys.manifestKey)
        return manifestBytes
      },
      async headObject({ key, ssecKey }) {
        assert.equal(key, fixture.manifest.objectKey)
        assert.deepEqual(ssecKey, derive(fixture.publicDerivationSeeds.rawSsecKey))
        return {
          etag: fixture.manifest.objectEtag,
          size: fixture.manifest.objectSize,
          customMetadata: fixture.metadata,
        }
      },
      async getObject({ key, ssecKey }) {
        assert.equal(key, fixture.manifest.objectKey)
        assert.deepEqual(ssecKey, derive(fixture.publicDerivationSeeds.rawSsecKey))
        return new ReadableStream({
          start(controller) {
            controller.enqueue(sql)
            controller.close()
          },
        })
      },
    },
    async runCommand(command) {
      commands.push(command)
      if (command.operation === 'import') {
        importedPath = command.filePath
        assert.equal(statSync(command.filePath).mode & 0o777, 0o600)
        assert.deepEqual(readFileSync(command.filePath), sql)
        return { imported: true }
      }
      if (command.operation === 'migrations') {
        return { migrations: ['0001_identity_operations.sql', '0002_core_records.sql'] }
      }
      if (command.operation === 'sentinel') return { sentinel }
      throw new Error('unexpected operation')
    },
    log(event) { logs.push(event) },
  })

  assert.deepEqual(result, {
    backupId: fixture.manifest.backupId,
    migrationCount: 2,
    status: 'restore_verified',
    target: 'bearwithme-restore-drill-2044',
  })
  assert.deepEqual(commands.map(({ operation }) => operation), [
    'import', 'migrations', 'sentinel',
  ])
  assert.ok(importedPath)
  assert.equal(existsSync(importedPath), false)
  assert.equal(existsSync(tempRoot), true)
  assert.deepEqual(logs, [{
    backupId: fixture.manifest.backupId,
    migrationCount: 2,
    status: 'restore_verified',
    target: 'bearwithme-restore-drill-2044',
  }])
  rmSync(tempRoot, { recursive: true, force: true })
})

test('restore request hard-refuses source, production, and non-restore targets', () => {
  const base = {
    manifestKey: fixture.objectKeys.manifestKey,
    target: 'bearwithme-restore-safe',
    sentinel: 'opaque_sentinel',
  }
  const policy = {
    sourceDatabaseNames: ['bearwithme-panel-staging-v3'],
    sourceDatabaseIds: ['source-id'],
    productionDatabaseNames: ['bearwithme-panel-production'],
    productionDatabaseIds: ['production-id'],
  }
  for (const target of [
    'bearwithme-panel-staging-v3',
    'bearwithme-panel-production',
    'other-restore-safe',
    'bearwithme-restore-',
  ]) {
    assert.throws(
      () => validateRestoreRequest({ request: { ...base, target }, ...policy }),
      /^Error: RESTORE_REFUSED$/,
    )
  }
  assert.deepEqual(validateRestoreRequest({ request: base, ...policy }), base)
})

test('guarded restore aborts between commands and always removes the plaintext temporary file', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bwm-restore-abort-test-'))
  const sql = Buffer.alloc(fixture.manifest.objectSize, 0x41)
  const controller = new AbortController()
  let importedPath = null
  const marker = 'signal-secret@example.test'

  await assert.rejects(restoreBackup({
    request: {
      manifestKey: fixture.objectKeys.manifestKey,
      target: 'bearwithme-restore-abort-drill',
      sentinel: 'restore_sentinel_abort',
    },
    sourceDatabaseNames: ['bearwithme-panel-staging-v3'],
    sourceDatabaseIds: ['source-database-id'],
    productionDatabaseNames: ['bearwithme-panel-production'],
    productionDatabaseIds: ['production-database-id'],
    expectedMigrations: ['0001_identity_operations.sql'],
    tempRoot,
    keyring,
    provider: {
      async describeDatabase(target) {
        return { name: target, id: 'target-abort-id', jurisdiction: 'eu' }
      },
      async getManifest() { return manifestBytes },
      async headObject() {
        return {
          etag: fixture.manifest.objectEtag,
          size: fixture.manifest.objectSize,
          customMetadata: fixture.metadata,
        }
      },
      async getObject() {
        return new ReadableStream({
          start(streamController) {
            streamController.enqueue(sql)
            streamController.close()
          },
        })
      },
    },
    async runCommand(command) {
      importedPath = command.filePath
      controller.abort(marker)
      return { imported: true }
    },
    log() {},
    signal: controller.signal,
  }), (error) => {
    assert.equal(error.message, 'RESTORE_FAILED')
    assert.doesNotMatch(error.message, /signal-secret|example\.test/)
    return true
  })

  assert.ok(importedPath)
  assert.equal(existsSync(importedPath), false)
  rmSync(tempRoot, { recursive: true, force: true })
})
