import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createPinnedWranglerRunner,
  restoreBackup,
  validateRestoreRequest,
  writeRestoreStream,
} from '../../scripts/restore-backup-lib.mjs'

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

test('Wrangler restore commands use only a temporary binding pinned to the validated database UUID', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bwm-restore-runner-test-'))
  const target = 'bearwithme-restore-pinned'
  const targetId = '11111111-2222-4333-8444-555555555555'
  const invocations = []
  let configPath = null
  const runner = createPinnedWranglerRunner({
    tempRoot,
    wranglerPath: '/opaque/wrangler.js',
    async execute(args) {
      invocations.push(args)
      const configIndex = args.indexOf('--config')
      assert.notEqual(configIndex, -1)
      configPath = args[configIndex + 1]
      assert.equal(statSync(configPath).mode & 0o777, 0o600)
      assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
        compatibility_date: '2026-08-27',
        d1_databases: [{
          binding: 'RESTORE_TARGET',
          database_id: targetId,
          database_name: target,
        }],
        name: 'bearwithme-restore-operator',
      })
      if (args.includes('--file')) return { stdout: '[]' }
      if (args.some((value) => value.includes('d1_migrations'))) {
        return { stdout: '[{"results":[{"name":"0001_identity_operations.sql"}]}]' }
      }
      return { stdout: '[{"results":[{"sentinel":"opaque_sentinel"}]}]' }
    },
  })

  try {
    assert.deepEqual(await runner.runCommand({
      operation: 'import', target, targetId, filePath: '/opaque/restore.sql',
    }), { imported: true })
    assert.deepEqual(await runner.runCommand({
      operation: 'migrations', target, targetId,
    }), { migrations: ['0001_identity_operations.sql'] })
    assert.deepEqual(await runner.runCommand({
      operation: 'sentinel', target, targetId,
    }), { sentinel: 'opaque_sentinel' })
  } finally {
    await runner.cleanup()
  }

  assert.equal(invocations.length, 3)
  for (const args of invocations) {
    assert.deepEqual(args.slice(0, 4), [
      '/opaque/wrangler.js', 'd1', 'execute', 'RESTORE_TARGET',
    ])
    assert.equal(args.includes(target), false)
    assert.equal(args.includes(targetId), false)
  }
  assert.ok(configPath)
  assert.equal(existsSync(configPath), false)
  rmSync(tempRoot, { recursive: true, force: true })
})

test('restore stream retries short file writes and counts only confirmed bytes', async () => {
  const written = []
  const writes = []
  const handle = {
    async write(bytes, offset, length, position) {
      assert.equal(position, null)
      const bytesWritten = Math.min(2, length)
      writes.push({ offset, length, bytesWritten })
      written.push(...bytes.subarray(offset, offset + bytesWritten))
      return { bytesWritten, buffer: bytes }
    },
  }
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]))
      controller.enqueue(new Uint8Array([6]))
      controller.close()
    },
  })

  await assert.doesNotReject(writeRestoreStream(handle, stream, 6))
  assert.deepEqual(written, [1, 2, 3, 4, 5, 6])
  assert.deepEqual(writes, [
    { offset: 0, length: 5, bytesWritten: 2 },
    { offset: 2, length: 3, bytesWritten: 2 },
    { offset: 4, length: 1, bytesWritten: 1 },
    { offset: 0, length: 1, bytesWritten: 1 },
  ])
})

test('restore stream rejects a zero-progress file write', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1]))
      controller.close()
    },
  })
  await assert.rejects(writeRestoreStream({
    async write(bytes) { return { bytesWritten: 0, buffer: bytes } },
  }, stream, 1), /^Error: RESTORE_FAILED$/)
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
        return {
          name: target,
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          jurisdiction: 'eu',
        }
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
