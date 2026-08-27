import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createPinnedWranglerRunner,
  restoreBackup,
  validateRestoreRequest,
  writeRestoreStream,
} from '../../scripts/restore-backup-lib.mjs'

const fixtureV1 = JSON.parse(readFileSync(new URL('../fixtures/backup-format-v1.json', import.meta.url), 'utf8'))
const fixtureV2 = JSON.parse(readFileSync(new URL('../fixtures/backup-format-v2.json', import.meta.url), 'utf8'))
const bytesFor = (fixture) => Uint8Array.from(Buffer.from(fixture.canonicalManifestBase64Url, 'base64url'))
const derive = (seed) => Uint8Array.from({ length: 32 }, (_, index) => (seed + (index * 29)) & 0xff)
const keyring = Object.freeze({
  getBackupKek: async (version) => version === 1
    ? crypto.subtle.importKey('raw', derive(fixtureV2.publicDerivationSeeds.backupKek), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    : null,
})
const policy = Object.freeze({
  sourceDatabaseNames: ['bearwithme-panel-staging-v3'],
  sourceDatabaseIds: [fixtureV2.manifest.source.databaseId],
  productionDatabaseNames: ['bearwithme-panel-production'],
  productionDatabaseIds: ['6f1eef07-18e5-4ecd-81d9-43e191f3ca72'],
})
const target = Object.freeze({
  name: 'bearwithme-restore-drill-2044',
  id: '22222222-2222-4222-8222-222222222222',
  jurisdiction: 'eu',
})
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const migrationDigest = async (migrations) => Buffer.from(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(migrations))),
).toString('hex')

test('Wrangler restore commands use one strict envelope and a temporary binding pinned to the validated UUID', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bwm-restore-runner-test-'))
  const invocations = []
  let configPath = null
  const runner = createPinnedWranglerRunner({
    tempRoot,
    wranglerPath: '/opaque/wrangler.js',
    async execute(args) {
      invocations.push(args)
      configPath = args[args.indexOf('--config') + 1]
      assert.equal(statSync(configPath).mode & 0o777, 0o600)
      if (args.includes('--file')) return { stdout: JSON.stringify([{
        results: [{ 'Total queries executed': 15, 'Rows read': 2, 'Rows written': 3, 'Database size (MB)': '1.25' }],
        success: true,
        finalBookmark: 'restore-final-bookmark',
        meta: { opaque: true },
      }]) }
      if (args.some((value) => value.includes('d1_migrations'))) return { stdout: JSON.stringify([{
        results: fixtureV2.manifest.appliedMigrations,
        success: true,
        meta: { opaque: true },
      }]) }
      return { stdout: JSON.stringify([{
        results: [{
          id: fixtureV2.manifest.restoreSentinel.backupId,
          local_day: fixtureV2.manifest.restoreSentinel.localDay,
          local_month: fixtureV2.manifest.restoreSentinel.localMonth,
          retention_class: fixtureV2.manifest.restoreSentinel.retentionClass,
          status: 'exporting',
          version: 2,
          created_at: fixtureV2.manifest.restoreSentinel.createdAt,
        }],
        success: true,
        meta: {},
      }]) }
    },
  })
  try {
    assert.deepEqual(await runner.runCommand({ operation: 'import', target: target.name, targetId: target.id, filePath: '/opaque/restore.sql' }), { imported: true, finalBookmark: 'restore-final-bookmark' })
    assert.deepEqual(await runner.runCommand({ operation: 'migrations', target: target.name, targetId: target.id }), { migrations: fixtureV2.manifest.appliedMigrations })
    assert.deepEqual(await runner.runCommand({ operation: 'sentinel', target: target.name, targetId: target.id, backupId: fixtureV2.manifest.backupId }), { sentinel: fixtureV2.manifest.restoreSentinel })
  } finally {
    await runner.cleanup()
  }
  assert.equal(invocations.length, 3)
  for (const args of invocations) {
    assert.deepEqual(args.slice(0, 4), ['/opaque/wrangler.js', 'd1', 'execute', 'RESTORE_TARGET'])
    for (const flag of ['--remote', '--json', '--x-provision=false', '--x-auto-create=false', '--install-skills=false']) assert.equal(args.includes(flag), true)
    assert.equal(args.includes(target.name), false)
    assert.equal(args.includes(target.id), false)
  }
  assert.ok(configPath)
  assert.equal(existsSync(configPath), false)
  rmSync(tempRoot, { recursive: true, force: true })
})

test('Wrangler parsing rejects ambiguous, recursive, oversized, and inexact success output', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bwm-restore-runner-invalid-'))
  const outputs = [
    '[]',
    '[{"success":true,"results":[],"meta":{}},{"success":true,"results":[],"meta":{}}]',
    '[{"success":true,"results":[{"nested":{"id":1,"name":"0001_fake.sql"}}],"meta":{}}]',
    '[{"success":true,"results":[{"id":1,"name":"0001_ok.sql","extra":true}],"meta":{}}]',
    'x'.repeat((1024 * 1024) + 1),
  ]
  try {
    for (const stdout of outputs) {
      const runner = createPinnedWranglerRunner({ tempRoot, wranglerPath: '/opaque/wrangler.js', execute: async () => ({ stdout }) })
      await assert.rejects(runner.runCommand({ operation: 'migrations', target: target.name, targetId: target.id }), /^Error: RESTORE_FAILED$/)
      await runner.cleanup()
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('Wrangler restore runner rejects a symlinked temporary root before child execution', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'bwm-restore-symlink-root-'))
  const real = join(outer, 'real')
  const link = join(outer, 'link')
  mkdirSync(real)
  symlinkSync(real, link, 'dir')
  let executions = 0
  const runner = createPinnedWranglerRunner({
    tempRoot: link,
    wranglerPath: '/opaque/wrangler.js',
    async execute() {
      executions += 1
      return { stdout: JSON.stringify([{ results: fixtureV2.manifest.appliedMigrations, success: true, meta: {} }]) }
    },
  })
  try {
    await assert.rejects(runner.runCommand({ operation: 'migrations', target: target.name, targetId: target.id }), /^Error: RESTORE_FAILED$/)
    assert.equal(executions, 0)
  } finally {
    await runner.cleanup()
    rmSync(outer, { recursive: true, force: true })
  }
})

test('restore stream retries short writes and rejects zero progress', async () => {
  const written = []
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4, 5])); controller.close() } })
  await writeRestoreStream({
    async write(value, offset, length) {
      const bytesWritten = Math.min(2, length)
      written.push(...value.subarray(offset, offset + bytesWritten))
      return { bytesWritten }
    },
  }, stream, 5)
  assert.deepEqual(written, [1, 2, 3, 4, 5])
  await assert.rejects(writeRestoreStream({ async write() { return { bytesWritten: 0 } } }, new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close() } }), 1), /^Error: RESTORE_FAILED$/)
})

function restoreInput({
  fixture = fixtureV2,
  allowLegacyUnverified = false,
  expectedSource = fixtureV2.manifest.source,
  migrations = fixture.manifest.appliedMigrations ?? fixtureV2.manifest.appliedMigrations,
  sentinel = fixture.manifest.restoreSentinel,
  describedTarget = target,
  signal,
} = {}) {
  const sql = Buffer.alloc(fixture.manifest.objectSize, 0x2d)
  const calls = []
  let importedPath = null
  const provider = {
    async describeDatabase() { return describedTarget },
    async getManifest() { return bytesFor(fixture) },
    async headObject() { return { etag: fixture.manifest.objectEtag, size: fixture.manifest.objectSize, customMetadata: fixture.metadata } },
    async getObject() { return new ReadableStream({ start(controller) { controller.enqueue(sql); controller.close() } }) },
    async markRestoreVerified(value) { calls.push({ operation: 'mark', value }); return { updated: true } },
    async readSourceBackup() { calls.push({ operation: 'read-source' }); return null },
  }
  const runCommand = async (command) => {
    calls.push(command)
    if (command.operation === 'import') {
      importedPath = command.filePath
      assert.equal(statSync(command.filePath).mode & 0o777, 0o600)
      assert.deepEqual(readFileSync(command.filePath), sql)
      return { imported: true, finalBookmark: 'restore-final-bookmark' }
    }
    if (command.operation === 'migrations') return { migrations }
    if (command.operation === 'sentinel') return { sentinel }
    throw new Error('unexpected operation')
  }
  const input = {
    request: { manifestKey: fixture.objectKeys.manifestKey, target: target.name, allowLegacyUnverified },
    expectedSource,
    ...policy,
    tempRoot: mkdtempSync(join(tmpdir(), 'bwm-restore-test-')),
    keyring,
    provider,
    runCommand,
    log() {},
    ...(signal ? { signal } : {}),
  }
  return { calls, input, readImportedPath: () => importedPath }
}

test('v2 restore verifies only manifest-bound migrations and intrinsic exported-row sentinel, then marks source', async () => {
  const setup = restoreInput()
  try {
    assert.deepEqual(await restoreBackup(setup.input), {
      backupId: fixtureV2.manifest.backupId,
      migrationCount: fixtureV2.manifest.appliedMigrations.length,
      migrationSetSha256: await migrationDigest(fixtureV2.manifest.appliedMigrations),
      status: 'restore_verified',
      target: target.name,
    })
    assert.deepEqual(setup.calls.map(({ operation }) => operation), ['import', 'migrations', 'sentinel', 'mark'])
    assert.deepEqual(setup.calls[2], { operation: 'sentinel', target: target.name, targetId: target.id, backupId: fixtureV2.manifest.backupId })
    assert.deepEqual(setup.calls[3].value, {
      backupId: fixtureV2.manifest.backupId,
      manifestKey: fixtureV2.objectKeys.manifestKey,
      objectEtag: fixtureV2.manifest.objectEtag,
      objectKey: fixtureV2.manifest.objectKey,
      objectSize: fixtureV2.manifest.objectSize,
    })
    assert.equal(existsSync(setup.readImportedPath()), false)
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})

test('a v1 restore is explicit legacy_unverified and can never mark recovery evidence', async () => {
  const setup = restoreInput({ fixture: fixtureV1, allowLegacyUnverified: true, migrations: [{ id: 1, name: '0001_security_primitives.sql' }], sentinel: undefined })
  try {
    assert.deepEqual(await restoreBackup(setup.input), {
      backupId: fixtureV1.manifest.backupId,
      migrationCount: 1,
      status: 'legacy_unverified',
      target: target.name,
    })
    assert.deepEqual(setup.calls.map(({ operation }) => operation), ['import', 'migrations'])
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})

test('restore refuses caller-supplied trust facts, unapproved legacy, unsafe keys, and protected targets', () => {
  const base = { manifestKey: fixtureV2.objectKeys.manifestKey, target: 'bearwithme-restore-safe', allowLegacyUnverified: false }
  assert.deepEqual(validateRestoreRequest({ request: base, ...policy }), base)
  for (const request of [
    { ...base, sentinel: 'caller-invented' },
    { ...base, expectedMigrations: ['0001_fake.sql'] },
    { ...base, manifestKey: '../backups/v2/escape.manifest.json' },
    { ...base, target: policy.sourceDatabaseNames[0] },
    { ...base, target: policy.productionDatabaseNames[0] },
    { ...base, target: 'not-a-restore-target' },
    { ...base, manifestKey: fixtureV1.objectKeys.manifestKey },
  ]) assert.throws(() => validateRestoreRequest({ request, ...policy }), /^Error: RESTORE_REFUSED$/)

  for (const invalidPolicy of [
    { ...policy, sourceDatabaseNames: [...policy.sourceDatabaseNames, policy.sourceDatabaseNames[0]] },
    { ...policy, sourceDatabaseNames: ['BearWithMe-Staging'] },
    { ...policy, sourceDatabaseIds: ['AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'] },
    { ...policy, productionDatabaseIds: ['not-a-uuid'] },
  ]) assert.throws(() => validateRestoreRequest({ request: base, ...invalidPolicy }), /^Error: RESTORE_REFUSED$/)
})

test('a timed-out restore-verification CAS succeeds only after an exact source-row reread', async () => {
  const setup = restoreInput()
  setup.input.provider.markRestoreVerified = async (value) => {
    setup.calls.push({ operation: 'mark-timeout', value })
    throw new Error('provider timeout marker')
  }
  setup.input.provider.readSourceBackup = async ({ backupId }) => {
    setup.calls.push({ operation: 'read-source', backupId })
    return {
      id: fixtureV2.manifest.backupId,
      status: 'restore_verified',
      version: 4,
      localDay: fixtureV2.manifest.localDay,
      localMonth: fixtureV2.manifest.localMonth,
      retentionClass: fixtureV2.manifest.retentionClass,
      objectKey: fixtureV2.manifest.objectKey,
      manifestKey: fixtureV2.objectKeys.manifestKey,
      objectEtag: fixtureV2.manifest.objectEtag,
      objectSize: fixtureV2.manifest.objectSize,
      completedAt: '2026-08-27T13:00:00.000Z',
      lastErrorCode: null,
      createdAt: fixtureV2.manifest.createdAt,
    }
  }
  try {
    const result = await restoreBackup(setup.input)
    assert.equal(result.status, 'restore_verified')
    assert.deepEqual(setup.calls.slice(-2).map(({ operation }) => operation), ['mark-timeout', 'read-source'])

    setup.input.provider.readSourceBackup = async () => ({
      id: fixtureV2.manifest.backupId,
      status: 'restore_verified',
      version: 4,
      localDay: fixtureV2.manifest.localDay,
      localMonth: fixtureV2.manifest.localMonth,
      retentionClass: fixtureV2.manifest.retentionClass,
      objectKey: fixtureV2.manifest.objectKey,
      manifestKey: fixtureV2.objectKeys.manifestKey,
      objectEtag: 'tampered-etag-public',
      objectSize: fixtureV2.manifest.objectSize,
      completedAt: '2026-08-27T13:00:00.000Z',
      lastErrorCode: null,
      createdAt: fixtureV2.manifest.createdAt,
    })
    await assert.rejects(restoreBackup(setup.input), /^Error: RESTORE_FAILED$/)
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})

test('v2 restore fails closed for missing/tampered migrations, sentinel, source, or target facts', async () => {
  const cases = [
    restoreInput({ migrations: fixtureV2.manifest.appliedMigrations.slice(0, 1) }),
    restoreInput({ migrations: [...fixtureV2.manifest.appliedMigrations, { id: 3, name: '0003_checkout_only.sql' }] }),
    restoreInput({ sentinel: { ...fixtureV2.manifest.restoreSentinel, version: 3 } }),
    restoreInput({ expectedSource: { ...fixtureV2.manifest.source, appEnv: 'production' } }),
    restoreInput({ describedTarget: { ...target, jurisdiction: 'wnam' } }),
  ]
  for (const setup of cases) {
    try {
      await assert.rejects(restoreBackup(setup.input), /^Error: RESTORE_(?:FAILED|REFUSED)$/)
      assert.equal(setup.calls.some(({ operation }) => operation === 'mark'), false)
    } finally {
      rmSync(setup.input.tempRoot, { recursive: true, force: true })
    }
  }
})

test('restore aborts between commands and always removes the plaintext file', async () => {
  const controller = new AbortController()
  const setup = restoreInput({ signal: controller.signal })
  const original = setup.input.runCommand
  setup.input.runCommand = async (command) => {
    const result = await original(command)
    if (command.operation === 'import') controller.abort('secret@example.test')
    return result
  }
  try {
    await assert.rejects(restoreBackup(setup.input), /^Error: RESTORE_FAILED$/)
    assert.ok(setup.readImportedPath())
    assert.equal(existsSync(setup.readImportedPath()), false)
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})
