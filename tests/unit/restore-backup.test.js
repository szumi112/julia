import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import * as restoreModule from '../../scripts/restore-backup-lib.mjs'
import { BACKUP_SQL_IMPORT_MAX_BYTES } from '../../worker/operations/backup-limits.js'
import {
  createPinnedWranglerRunner,
  createRestoreSourceStore,
  prepareD1RestoreImportFile,
  removeRestoreTemporaryDirectory,
  restoreBackup,
  validateRestoreRequest,
  writeRestoreStream,
} from '../../scripts/restore-backup-lib.mjs'
import recoveryRow from '../fixtures/backup-recovery-workbook-row.json' with { type: 'json' }

const fixtureV1 = JSON.parse(readFileSync(new URL('../fixtures/backup-format-v1.json', import.meta.url), 'utf8'))
const fixtureV2 = JSON.parse(readFileSync(new URL('../fixtures/backup-format-v2.json', import.meta.url), 'utf8'))
const fixtureV3Public = JSON.parse(readFileSync(new URL('../fixtures/backup-format-v3.json', import.meta.url), 'utf8'))
const bytesFor = (fixture) => Uint8Array.from(Buffer.from(fixture.canonicalManifestBase64Url, 'base64url'))
const restoreFixtureV3 = (variant) => ({
  canonicalManifestBase64Url: variant.canonicalManifestBase64Url,
  manifest: JSON.parse(Buffer.from(variant.canonicalManifestBase64Url, 'base64url')),
  metadata: variant.metadata,
  objectKeys: variant.objectKeys,
  sqlBase64Url: variant.sqlBase64Url,
})
const fixtureV3Core = restoreFixtureV3(fixtureV3Public.variants.core)
const fixtureV3Workbook = restoreFixtureV3(fixtureV3Public.variants.workbook)
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
      if (args.includes('--file')) return {
        stdout: `├ Checking if file needs uploading\n│\n${JSON.stringify([{
          results: [{ 'Total queries executed': 15, 'Rows read': 2, 'Rows written': 3, 'Database size (MB)': '1.25' }],
          success: true,
          finalBookmark: 'restore-final-bookmark',
          meta: { opaque: true },
        }])}`,
      }
      if (args.includes('PRAGMA foreign_keys')) return { stdout: JSON.stringify([{
        results: [{ foreign_keys: 1 }],
        success: true,
        meta: { opaque: true },
      }]) }
      if (args.includes('PRAGMA quick_check')) return { stdout: JSON.stringify([{
        results: [{ quick_check: 'ok' }],
        success: true,
        meta: { opaque: true },
      }]) }
      if (args.includes('PRAGMA foreign_key_check')) return { stdout: JSON.stringify([{
        results: [],
        success: true,
        meta: { opaque: true },
      }]) }
      if (args.some((value) => value.includes('WITH migration_snapshot'))) return { stdout: JSON.stringify([{
        results: [structuredClone(recoveryRow)],
        success: true,
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
    assert.deepEqual(await runner.runCommand({ operation: 'integrity', target: target.name, targetId: target.id }), { valid: true })
    assert.deepEqual(await runner.runCommand({ operation: 'migrations', target: target.name, targetId: target.id }), { migrations: fixtureV2.manifest.appliedMigrations })
    assert.deepEqual(await runner.runCommand({ operation: 'sentinel', target: target.name, targetId: target.id, backupId: fixtureV2.manifest.backupId }), { sentinel: fixtureV2.manifest.restoreSentinel })
    assert.equal((await runner.runCommand({ operation: 'recovery', target: target.name, targetId: target.id })).recoveryFacts.kind, 'workbook_roundtrip_v1')
  } finally {
    await runner.cleanup()
  }
  assert.equal(invocations.length, 7)
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

test('Wrangler restore integrity rejects every reported foreign-key violation', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bwm-restore-runner-fk-invalid-'))
  const runner = createPinnedWranglerRunner({
    tempRoot,
    wranglerPath: '/opaque/wrangler.js',
    async execute(args) {
      const results = args.includes('PRAGMA foreign_keys')
        ? [{ foreign_keys: 1 }]
        : args.includes('PRAGMA quick_check')
          ? [{ quick_check: 'ok' }]
          : [{ table: 'child', rowid: 1, parent: 'parent', fkid: 0 }]
      return { stdout: JSON.stringify([{ results, success: true, meta: { opaque: true } }]) }
    },
  })
  try {
    await assert.rejects(runner.runCommand({
      operation: 'integrity', target: target.name, targetId: target.id,
    }), /^Error: RESTORE_FAILED$/)
  } finally {
    await runner.cleanup()
    rmSync(tempRoot, { recursive: true, force: true })
  }
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

test('Wrangler import parsing rejects unknown, ambiguous, and control-bearing progress output', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bwm-restore-runner-import-invalid-'))
  const valid = JSON.stringify([{
    results: [{ 'Total queries executed': 15, 'Rows read': 2, 'Rows written': 3, 'Database size (MB)': '1.25' }],
    success: true,
    finalBookmark: 'restore-final-bookmark',
    meta: { opaque: true },
  }])
  const outputs = [
    `unexpected progress\n${valid}`,
    `├ Checking if file needs uploading\n│\n[]\n${valid}`,
    `├ {"hidden":true}\n│\n${valid}`,
    `├ Checking if file needs uploading\u001b[0m\n│\n${valid}`,
  ]
  try {
    for (const stdout of outputs) {
      const runner = createPinnedWranglerRunner({ tempRoot, wranglerPath: '/opaque/wrangler.js', execute: async () => ({ stdout }) })
      await assert.rejects(runner.runCommand({ operation: 'import', target: target.name, targetId: target.id, filePath: '/opaque/restore.sql' }), /^Error: RESTORE_FAILED$/)
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

function executeReorderedRestore(source) {
  assert.equal(typeof restoreModule.reorderD1RestoreSql, 'function')
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('PRAGMA foreign_keys=ON; BEGIN;')
    database.exec(restoreModule.reorderD1RestoreSql(source))
    database.exec('COMMIT;')
    return database
  } catch (error) {
    try { database.exec('ROLLBACK;') } catch {}
    database.close()
    throw error
  }
}

test('restore import ordering preserves one exact AUTOINCREMENT sequence row', () => {
  const database = executeReorderedRestore([
    'PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE auto_record (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);',
    'INSERT INTO auto_record VALUES (7, \'restored\');',
    'DELETE FROM sqlite_sequence;',
    'INSERT INTO "sqlite_sequence" VALUES (\'auto_record\', 7);',
  ].join('\n'))
  try {
    assert.deepEqual(database.prepare(
      "SELECT name,seq FROM sqlite_sequence WHERE name='auto_record'",
    ).all().map((row) => ({ ...row })), [{ name: 'auto_record', seq: 7 }])
    database.exec("INSERT INTO auto_record(value) VALUES ('next');")
    assert.equal(database.prepare("SELECT id FROM auto_record WHERE value='next'").get().id, 8)
  } finally { database.close() }
})

test('restore import ordering treats SQLite identifiers case-insensitively', () => {
  const database = executeReorderedRestore([
    'PRAGMA defer_foreign_keys=ON;',
    'CREATE TABLE "CaseRecord" (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);',
    'INSERT INTO caserecord VALUES (7, \'restored\');',
    'DELETE FROM sqlite_sequence;',
    'INSERT INTO "SQLITE_SEQUENCE" VALUES (\'CaseRecord\', 7);',
  ].join('\n'))
  try {
    assert.equal(database.prepare('SELECT value FROM CASErecord WHERE id=7').get().value, 'restored')
    assert.deepEqual(database.prepare(
      "SELECT name,seq FROM sqlite_sequence WHERE name='CaseRecord'",
    ).all().map((row) => ({ ...row })), [{ name: 'CaseRecord', seq: 7 }])
  } finally { database.close() }
})

test('restore import ordering compiles valid views and triggers before remote import', () => {
  const database = executeReorderedRestore([
    'PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE record (id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
    "INSERT INTO record VALUES (1, 'restored');",
    'CREATE VIEW record_values AS SELECT value FROM record;',
    'CREATE TRIGGER record_value_guard BEFORE UPDATE OF value ON record BEGIN SELECT RAISE(ABORT, \'guarded\'); END;',
  ].join('\n'))
  try {
    assert.deepEqual(database.prepare('SELECT value FROM record_values').all().map((row) => ({ ...row })), [
      { value: 'restored' },
    ])
    assert.throws(() => database.exec("UPDATE record SET value='changed' WHERE id=1"), /guarded/)
  } finally { database.close() }
})

test('restore import ordering rejects invalid inserts, views, and triggers locally', () => {
  const prefix = [
    'PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE record (id INTEGER PRIMARY KEY);',
    'INSERT INTO record VALUES (1);',
  ]
  for (const statement of [
    'INSERT INTO record VALUES (2, 3);',
    'CREATE VIEW broken_view AS SELECT FROM record;',
    'CREATE TRIGGER broken_trigger AFTER INSERT ON record BEGIN SELECT FROM; END;',
  ]) {
    assert.throws(
      () => restoreModule.reorderD1RestoreSql([...prefix, statement].join('\n')),
      /^Error: RESTORE_FAILED$/,
    )
  }
})

test('restore rewrite has a separate bounded ceiling for normalized statement separators', () => {
  const source = [
    'PRAGMA defer_foreign_keys=TRUE',
    'CREATE TABLE record(id INTEGER PRIMARY KEY)',
    'INSERT INTO record VALUES(1)',
  ].join(';')
  const output = restoreModule.reorderD1RestoreSql(source)
  assert.ok(Buffer.byteLength(output) > Buffer.byteLength(source))
  assert.ok(Buffer.byteLength(output) <= BACKUP_SQL_IMPORT_MAX_BYTES)
})

test('production restore preparation enforces private files, exact size, UTF-8, and symlink boundaries', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'bwm-restore-prepare-'))
  const secure = join(outer, 'secure')
  mkdirSync(secure, { mode: 0o700 })
  const sourcePath = join(secure, 'restore.sql')
  const source = [
    'PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE record(id INTEGER PRIMARY KEY);',
    'INSERT INTO record VALUES(1);',
  ].join('\n')
  writeFileSync(sourcePath, source, { mode: 0o600 })
  try {
    const prepared = await prepareD1RestoreImportFile({
      directory: secure,
      sourcePath,
      expectedSize: Buffer.byteLength(source),
    })
    assert.equal(prepared.filePath, join(secure, 'restore-import.sql'))
    assert.equal(statSync(prepared.filePath).mode & 0o777, 0o600)
    assert.match(readFileSync(prepared.filePath, 'utf8'), /INSERT INTO record VALUES\(1\);/)
    rmSync(prepared.filePath)

    await assert.rejects(prepareD1RestoreImportFile({
      directory: secure, sourcePath, expectedSize: Buffer.byteLength(source) + 1,
    }), /^Error: RESTORE_FAILED$/)
    writeFileSync(sourcePath, new Uint8Array([0xc3, 0x28]), { flag: 'w', mode: 0o600 })
    await assert.rejects(prepareD1RestoreImportFile({
      directory: secure, sourcePath, expectedSize: 2,
    }), /^Error: RESTORE_FAILED$/)

    rmSync(sourcePath)
    const outside = join(outer, 'outside.sql')
    writeFileSync(outside, source, { mode: 0o600 })
    symlinkSync(outside, sourcePath)
    await assert.rejects(prepareD1RestoreImportFile({
      directory: secure, sourcePath, expectedSize: Buffer.byteLength(source),
    }), /^Error: RESTORE_FAILED$/)
    rmSync(sourcePath)
    writeFileSync(sourcePath, source, { mode: 0o600 })
    chmodSync(secure, 0o755)
    await assert.rejects(prepareD1RestoreImportFile({
      directory: secure, sourcePath, expectedSize: Buffer.byteLength(source),
    }), /^Error: RESTORE_FAILED$/)
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test('restore import ordering supports populated self-referencing foreign keys', () => {
  const database = executeReorderedRestore([
    'PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE node (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES node(id));',
    'INSERT INTO node VALUES (1, 1);',
  ].join('\n'))
  try { assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []) } finally { database.close() }
})

test('restore import ordering supports populated mutual foreign-key cycles', () => {
  const database = executeReorderedRestore([
    'PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE left_node (id INTEGER PRIMARY KEY, right_id INTEGER REFERENCES right_node(id));',
    'INSERT INTO left_node VALUES (1, 1);',
    'CREATE TABLE right_node (id INTEGER PRIMARY KEY, left_id INTEGER REFERENCES left_node(id));',
    'INSERT INTO right_node VALUES (1, 1);',
  ].join('\n'))
  try { assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []) } finally { database.close() }
})

test('restore import ordering creates standalone UNIQUE parent indexes before child data', () => {
  const source = [
    'PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE child (parent_code TEXT REFERENCES parent(code));',
    "INSERT INTO child VALUES ('one');",
    'CREATE TABLE parent (code TEXT NOT NULL);',
    "INSERT INTO parent VALUES ('one');",
    'CREATE UNIQUE INDEX parent_code_unique ON parent(code);',
  ].join('\n')
  const reordered = restoreModule.reorderD1RestoreSql(source)
  assert.ok(reordered.indexOf("INSERT INTO parent VALUES ('one')")
    < reordered.indexOf("INSERT INTO child VALUES ('one')"))
  const database = executeReorderedRestore(source)
  try { assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []) } finally { database.close() }
})

test('restore imports only the private prepared copy after authenticating the source bytes', async () => {
  const setup = restoreInput({
    fixture: fixtureV3Core,
    expectedSource: fixtureV3Core.manifest.source,
  })
  let prepared = false
  setup.input.prepareImport = async ({ directory, sourcePath, expectedSize }) => {
    prepared = true
    assert.equal(expectedSize, fixtureV3Core.manifest.objectSize)
    assert.equal(statSync(sourcePath).size, expectedSize)
    const importPath = join(directory, 'restore-import.sql')
    writeFileSync(importPath, readFileSync(sourcePath), { flag: 'wx', mode: 0o600 })
    return { filePath: importPath }
  }
  try {
    await restoreBackup(setup.input)
    assert.equal(prepared, true)
    assert.match(setup.readImportedPath(), /restore-import\.sql$/)
    assert.equal(existsSync(setup.readImportedPath()), false)
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})

function restoreInput({
  fixture = fixtureV2,
  allowLegacyUnverified = false,
  expectedSource = fixtureV2.manifest.source,
  migrations = fixture.manifest.appliedMigrations ?? fixtureV2.manifest.appliedMigrations,
  sentinel = fixture.manifest.restoreSentinel,
  recoveryFacts = fixture.manifest.recoveryFacts,
  describedTarget = target,
  fresh = true,
  integrity = { valid: true },
  removeTemporaryDirectory,
  signal,
} = {}) {
  const sql = fixture.sqlBase64Url
    ? Buffer.from(fixture.sqlBase64Url, 'base64url')
    : Buffer.alloc(fixture.manifest.objectSize, 0x2d)
  const calls = []
  let importedPath = null
  let observedSsecKey = null
  const provider = {
    async describeDatabase() { calls.push({ operation: 'describe' }); return describedTarget },
    async headManifest({ key }) {
      calls.push({ operation: 'head-manifest', key })
      return { etag: 'manifest-head-etag-public', size: bytesFor(fixture).byteLength }
    },
    async getManifest(value) {
      calls.push({ operation: 'get-manifest', value })
      return {
        etag: 'manifest-head-etag-public',
        size: bytesFor(fixture).byteLength,
        bytes: bytesFor(fixture),
      }
    },
    async headObject({ ssecKey }) {
      calls.push({ operation: 'head-object' })
      observedSsecKey = ssecKey
      return { etag: fixture.manifest.objectEtag, size: fixture.manifest.objectSize, customMetadata: fixture.metadata }
    },
    async getObject(value) {
      calls.push({ operation: 'get-object', value })
      return {
        etag: fixture.manifest.objectEtag,
        size: fixture.manifest.objectSize,
        body: new ReadableStream({ start(controller) { controller.enqueue(sql); controller.close() } }),
      }
    },
    async markRestoreVerified(value) { calls.push({ operation: 'mark', value }); return { updated: true } },
    async readSourceBackup() { calls.push({ operation: 'read-source' }); return null },
  }
  const runCommand = async (command) => {
    calls.push(command)
    if (command.operation === 'freshness') return { fresh }
    if (command.operation === 'import') {
      importedPath = command.filePath
      assert.equal(statSync(command.filePath).mode & 0o777, 0o600)
      assert.deepEqual(readFileSync(command.filePath), sql)
      return { imported: true, finalBookmark: 'restore-final-bookmark' }
    }
    if (command.operation === 'integrity') return integrity
    if (command.operation === 'migrations') return { migrations }
    if (command.operation === 'recovery') {
      return { appliedMigrations: migrations, recoveryFacts }
    }
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
    async prepareImport({ directory, sourcePath, expectedSize }) {
      calls.push({ operation: 'prepare-import', expectedSize })
      assert.equal(statSync(sourcePath).size, expectedSize)
      const importPath = join(directory, 'restore-import.sql')
      writeFileSync(importPath, readFileSync(sourcePath), { flag: 'wx', mode: 0o600 })
      return { filePath: importPath }
    },
    removeTemporaryDirectory: removeTemporaryDirectory ?? removeRestoreTemporaryDirectory,
    runCommand,
    async cleanupTarget() {
      calls.push({ operation: 'cleanup-target' })
      if (importedPath !== null) assert.equal(existsSync(importedPath), false)
    },
    ...(signal ? { signal } : {}),
  }
  return {
    calls,
    input,
    readImportedPath: () => importedPath,
    readObservedSsecKey: () => observedSsecKey,
  }
}

const verifiedSourceRow = (fixture, verifiedAt, overrides = {}) => ({
  id: fixture.manifest.backupId,
  status: 'restore_verified',
  version: 4,
  localDay: fixture.manifest.localDay,
  localMonth: fixture.manifest.localMonth,
  retentionClass: fixture.manifest.retentionClass,
  exportBookmark: fixture.manifest.atBookmark,
  objectKey: fixture.manifest.objectKey,
  manifestKey: fixture.objectKeys.manifestKey,
  ssecKeyVersion: fixture.manifest.wrappedSsecKey.kekVersion,
  wrappedSsecKeyB64: fixture.manifest.wrappedSsecKey.ciphertext,
  wrapNonceB64: fixture.manifest.wrappedSsecKey.nonce,
  objectEtag: fixture.manifest.objectEtag,
  objectSize: fixture.manifest.objectSize,
  completedAt: '2026-08-27T13:00:00.000Z',
  restoreVerifiedAt: verifiedAt,
  lastErrorCode: null,
  createdAt: fixture.manifest.createdAt,
  updatedAt: verifiedAt,
  ...overrides,
})

const snakeSourceRow = (row) => ({
  id: row.id,
  status: row.status,
  version: row.version,
  local_day: row.localDay,
  local_month: row.localMonth,
  retention_class: row.retentionClass,
  export_bookmark: row.exportBookmark,
  object_key: row.objectKey,
  manifest_key: row.manifestKey,
  ssec_key_version: row.ssecKeyVersion,
  wrapped_ssec_key_b64: row.wrappedSsecKeyB64,
  wrap_nonce_b64: row.wrapNonceB64,
  object_etag: row.objectEtag,
  object_size: row.objectSize,
  completed_at: row.completedAt,
  restore_verified_at: row.restoreVerifiedAt,
  last_error_code: row.lastErrorCode,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
})

test('D1 REST source store binds the full immutable backup identity and exact finalized row', async () => {
  const verifiedAt = '2044-08-28T12:34:56.789Z'
  const row = verifiedSourceRow(fixtureV2, verifiedAt)
  const calls = []
  let nextRows = [snakeSourceRow(row)]
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values })
          return { async all() { return { meta: {}, results: nextRows, success: true } } }
        },
      }
    },
  }
  const store = createRestoreSourceStore({ db })
  const facts = {
    backupId: fixtureV2.manifest.backupId,
    localDay: fixtureV2.manifest.localDay,
    localMonth: fixtureV2.manifest.localMonth,
    retentionClass: fixtureV2.manifest.retentionClass,
    createdAt: fixtureV2.manifest.createdAt,
    exportBookmark: fixtureV2.manifest.atBookmark,
    objectKey: fixtureV2.manifest.objectKey,
    manifestKey: fixtureV2.objectKeys.manifestKey,
    objectEtag: fixtureV2.manifest.objectEtag,
    objectSize: fixtureV2.manifest.objectSize,
    ssecKeyVersion: fixtureV2.manifest.wrappedSsecKey.kekVersion,
    wrappedSsecKeyB64: fixtureV2.manifest.wrappedSsecKey.ciphertext,
    wrapNonceB64: fixtureV2.manifest.wrappedSsecKey.nonce,
    verifiedAt,
  }
  assert.deepEqual(await store.markRestoreVerified(facts), { updated: true })
  assert.match(calls[0].sql, /status='stored' AND version=3/)
  for (const field of [
    'local_day', 'local_month', 'retention_class', 'created_at', 'export_bookmark',
    'object_key', 'manifest_key', 'object_etag', 'object_size', 'ssec_key_version',
    'wrapped_ssec_key_b64', 'wrap_nonce_b64', 'restore_verified_at IS NULL',
  ]) assert.match(calls[0].sql, new RegExp(field))
  assert.deepEqual(calls[0].values, [
    verifiedAt, verifiedAt, facts.backupId, facts.localDay, facts.localMonth,
    facts.retentionClass, facts.createdAt, facts.exportBookmark, facts.objectKey,
    facts.manifestKey, facts.objectEtag, facts.objectSize, facts.ssecKeyVersion,
    facts.wrappedSsecKeyB64, facts.wrapNonceB64,
  ])

  nextRows = [snakeSourceRow({ ...row, exportBookmark: 'wrong-public-bookmark' })]
  assert.deepEqual(await store.markRestoreVerified(facts), { updated: false })
  nextRows = [snakeSourceRow(row)]
  assert.deepEqual(await store.readSourceBackup({ backupId: facts.backupId }), row)
})

test('v2 restore verifies only manifest-bound migrations and intrinsic exported-row sentinel, then marks source', async () => {
  const setup = restoreInput()
  try {
    assert.deepEqual(await restoreBackup(setup.input), {
      backupId: fixtureV2.manifest.backupId,
      format: 'bwm-d1-sql-v2',
      migrationCount: fixtureV2.manifest.appliedMigrations.length,
      migrationSetSha256: await migrationDigest(fixtureV2.manifest.appliedMigrations),
      recoveryKind: null,
      target: target.name,
      manifestAuthenticated: true,
      objectReadbackVerified: true,
      migrationsVerified: true,
      recoveryFactsVerified: false,
      restoreSentinelVerified: true,
      sourceMarkedVerified: true,
      targetFreshVerified: true,
    })
    assert.deepEqual(setup.calls.map(({ operation }) => operation), [
      'describe', 'freshness', 'head-manifest', 'get-manifest', 'head-object',
      'get-object', 'prepare-import', 'import', 'integrity', 'migrations',
      'sentinel', 'cleanup-target', 'mark',
    ])
    assert.deepEqual(setup.calls[10], { operation: 'sentinel', target: target.name, targetId: target.id, backupId: fixtureV2.manifest.backupId })
    assert.deepEqual(setup.calls[12].value, {
      backupId: fixtureV2.manifest.backupId,
      localDay: fixtureV2.manifest.localDay,
      localMonth: fixtureV2.manifest.localMonth,
      retentionClass: fixtureV2.manifest.retentionClass,
      createdAt: fixtureV2.manifest.createdAt,
      exportBookmark: fixtureV2.manifest.atBookmark,
      manifestKey: fixtureV2.objectKeys.manifestKey,
      objectEtag: fixtureV2.manifest.objectEtag,
      objectKey: fixtureV2.manifest.objectKey,
      objectSize: fixtureV2.manifest.objectSize,
      ssecKeyVersion: fixtureV2.manifest.wrappedSsecKey.kekVersion,
      wrappedSsecKeyB64: fixtureV2.manifest.wrappedSsecKey.ciphertext,
      wrapNonceB64: fixtureV2.manifest.wrappedSsecKey.nonce,
      verifiedAt: setup.calls[12].value.verifiedAt,
    })
    assert.match(setup.calls[12].value.verifiedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(existsSync(setup.readImportedPath()), false)
    assert.deepEqual(setup.readObservedSsecKey(), new Uint8Array(32))
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})

test('v3 restore authenticates exact core and workbook recovery facts before the final source CAS', async () => {
  for (const fixture of [fixtureV3Core, fixtureV3Workbook]) {
    const setup = restoreInput({ fixture, expectedSource: fixture.manifest.source })
    try {
      const result = await restoreBackup(setup.input)
      assert.deepEqual(result, {
        backupId: fixture.manifest.backupId,
        format: 'bwm-d1-sql-v3',
        migrationCount: fixture.manifest.appliedMigrations.length,
        migrationSetSha256: await migrationDigest(fixture.manifest.appliedMigrations),
        recoveryKind: fixture.manifest.recoveryFacts.kind,
        target: target.name,
        manifestAuthenticated: true,
        objectReadbackVerified: true,
        migrationsVerified: true,
        recoveryFactsVerified: true,
        restoreSentinelVerified: true,
        sourceMarkedVerified: true,
        targetFreshVerified: true,
      })
      assert.deepEqual(setup.calls.map(({ operation }) => operation), [
        'describe', 'freshness', 'head-manifest', 'get-manifest', 'head-object',
        'get-object', 'prepare-import', 'import', 'integrity', 'migrations',
        'sentinel', 'recovery', 'cleanup-target', 'mark',
      ])
      assert.deepEqual(setup.calls[3].value, {
        key: fixture.objectKeys.manifestKey,
        ifMatch: 'manifest-head-etag-public',
      })
      assert.equal(setup.calls[5].value.ifMatch, fixture.manifest.objectEtag)
      assert.equal(existsSync(setup.readImportedPath()), false)
      assert.deepEqual(setup.readObservedSsecKey(), new Uint8Array(32))
    } finally {
      rmSync(setup.input.tempRoot, { recursive: true, force: true })
    }
  }
})

test('v3 target recovery mismatches and plaintext digest drift prevent the source mark', async () => {
  const factMutations = [
    (facts) => { facts.artifact.byteSize += 1 },
    (facts) => { facts.import.version += 1 },
    (facts) => { facts.finance.reportingRevision += 1 },
    (facts) => { facts.historical.occurrenceCount -= 1 },
    (facts) => { facts.activity.physicalLinkCount -= 1 },
    (facts) => { facts.reconciliation.ledgerLinksUnique = false },
  ]
  for (const mutate of factMutations) {
    const recoveryFacts = structuredClone(fixtureV3Workbook.manifest.recoveryFacts)
    mutate(recoveryFacts)
    const setup = restoreInput({
      fixture: fixtureV3Workbook,
      expectedSource: fixtureV3Workbook.manifest.source,
      recoveryFacts,
    })
    try {
      await assert.rejects(restoreBackup(setup.input), /^Error: RESTORE_FAILED$/)
      assert.equal(setup.calls.some(({ operation }) => operation === 'mark'), false)
    } finally {
      rmSync(setup.input.tempRoot, { recursive: true, force: true })
    }
  }

  const digestSetup = restoreInput({
    fixture: fixtureV3Core,
    expectedSource: fixtureV3Core.manifest.source,
  })
  digestSetup.input.provider.getObject = async () => ({
    etag: fixtureV3Core.manifest.objectEtag,
    size: fixtureV3Core.manifest.objectSize,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(fixtureV3Core.manifest.objectSize).fill(1))
        controller.close()
      },
    }),
  })
  try {
    await assert.rejects(restoreBackup(digestSetup.input), /^Error: RESTORE_FAILED$/)
    assert.equal(digestSetup.calls.some(({ operation }) => operation === 'import'), false)
    assert.equal(digestSetup.calls.some(({ operation }) => operation === 'mark'), false)
  } finally {
    rmSync(digestSetup.input.tempRoot, { recursive: true, force: true })
  }
})

test('post-import integrity failure prevents every restore-verification claim', async () => {
  const setup = restoreInput({
    fixture: fixtureV3Core,
    expectedSource: fixtureV3Core.manifest.source,
    integrity: { valid: false },
  })
  try {
    await assert.rejects(restoreBackup(setup.input), /^Error: RESTORE_FAILED$/)
    assert.equal(setup.calls.some(({ operation }) => operation === 'integrity'), true)
    assert.equal(setup.calls.some(({ operation }) => operation === 'mark'), false)
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})

test('fresh-target preflight is first and a non-empty target blocks every archive read', async () => {
  const setup = restoreInput({ fresh: false })
  try {
    await assert.rejects(restoreBackup(setup.input), /^Error: RESTORE_FAILED$/)
    assert.deepEqual(setup.calls.map(({ operation }) => operation), [
      'describe', 'freshness', 'cleanup-target',
    ])
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})

test('a v1 restore is explicit legacy_unverified and can never mark recovery evidence', async () => {
  const setup = restoreInput({ fixture: fixtureV1, allowLegacyUnverified: true, migrations: [{ id: 1, name: '0001_security_primitives.sql' }], sentinel: undefined })
  try {
    assert.deepEqual(await restoreBackup(setup.input), {
      backupId: fixtureV1.manifest.backupId,
      format: 'bwm-d1-sql-v1',
      migrationCount: 1,
      migrationSetSha256: await migrationDigest([{ id: 1, name: '0001_security_primitives.sql' }]),
      recoveryKind: null,
      target: target.name,
      manifestAuthenticated: true,
      objectReadbackVerified: true,
      migrationsVerified: false,
      recoveryFactsVerified: false,
      restoreSentinelVerified: false,
      sourceMarkedVerified: false,
      targetFreshVerified: true,
    })
    assert.deepEqual(setup.calls.map(({ operation }) => operation), [
      'describe', 'freshness', 'head-manifest', 'get-manifest', 'head-object',
      'get-object', 'prepare-import', 'import', 'integrity', 'migrations',
      'cleanup-target',
    ])
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})

test('restore refuses caller-supplied trust facts, unapproved legacy, unsafe keys, and protected targets', () => {
  const base = { manifestKey: fixtureV2.objectKeys.manifestKey, target: 'bearwithme-restore-safe', allowLegacyUnverified: false }
  assert.deepEqual(validateRestoreRequest({ request: base, ...policy }), base)
  const v3 = { ...base, manifestKey: 'backups/v3/2044/07/bkp_restore_v3.manifest.json' }
  assert.deepEqual(validateRestoreRequest({ request: v3, ...policy }), v3)
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
  let verifiedAt = null
  setup.input.provider.markRestoreVerified = async (value) => {
    setup.calls.push({ operation: 'mark-timeout', value })
    verifiedAt = value.verifiedAt
    throw new Error('provider timeout marker')
  }
  setup.input.provider.readSourceBackup = async ({ backupId }) => {
    setup.calls.push({ operation: 'read-source', backupId })
    return verifiedSourceRow(fixtureV2, verifiedAt)
  }
  try {
    const result = await restoreBackup(setup.input)
    assert.equal(result.sourceMarkedVerified, true)
    assert.deepEqual(setup.calls.slice(-2).map(({ operation }) => operation), ['mark-timeout', 'read-source'])

    setup.input.provider.readSourceBackup = async () => verifiedSourceRow(
      fixtureV2,
      verifiedAt,
      { objectEtag: 'tampered-etag-public' },
    )
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

test('restore retries transient private-directory cleanup before marking the source', async () => {
  let attempts = 0
  const setup = restoreInput({
    async removeTemporaryDirectory({ directory, filePath }) {
      attempts += 1
      if (attempts === 1) throw new Error('TRANSIENT_REMOVE_FAILURE')
      rmSync(directory, { recursive: true, force: true })
      assert.equal(existsSync(filePath), false)
      assert.equal(existsSync(directory), false)
    },
  })
  try {
    const result = await restoreBackup(setup.input)
    assert.equal(result.sourceMarkedVerified, true)
    assert.equal(attempts, 2)
    assert.equal(setup.calls.some(({ operation }) => operation === 'mark'), true)
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})

test('persistent private-directory cleanup failure stops after two attempts and never marks the source', async () => {
  let attempts = 0
  const setup = restoreInput({
    async removeTemporaryDirectory() {
      attempts += 1
      throw new Error('PERSISTENT_REMOVE_FAILURE')
    },
  })
  try {
    await assert.rejects(restoreBackup(setup.input), /^Error: RESTORE_FAILED$/)
    assert.equal(attempts, 2)
    assert.equal(setup.calls.some(({ operation }) => operation === 'mark'), false)
  } finally {
    rmSync(setup.input.tempRoot, { recursive: true, force: true })
  }
})
