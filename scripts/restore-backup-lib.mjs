import { chmod, lstat, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  backupObjectKeys,
  canonicalJson,
  expectedObjectMetadata,
  openBackupManifest,
  parseCanonicalManifest,
} from '../worker/operations/backup-format.js'

const TARGET = /^bearwithme-restore-[a-z0-9][a-z0-9-]{0,62}$/
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ACCOUNT_ID = /^[0-9a-f]{32}$/
const DATABASE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/
const MIGRATION_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/
const MIGRATION_NAME_MAX_BYTES = 255
const MANIFEST_KEY = /^backups\/(v1|v2)\/\d{4}\/(?:0[1-9]|1[0-2])\/(bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123})\.manifest\.json$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const RESTORE_BINDING = 'RESTORE_TARGET'
const WRANGLER_OUTPUT_MAX_BYTES = 1024 * 1024

const refused = () => { throw new Error('RESTORE_REFUSED') }
const failed = () => { throw new Error('RESTORE_FAILED') }
const ownObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exactObject = (value, keys) => ownObject(value)
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const exactStringList = (value, pattern) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || !pattern.test(entry) || seen.has(entry)) return false
    seen.add(entry)
  }
  return true
}
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const validOpaque = (value) => typeof value === 'string' && value.length > 0
  && value.length <= 1024 && value === value.trim()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)

function parseWranglerOutput(stdout, operation) {
  if (typeof stdout !== 'string'
    || new TextEncoder().encode(stdout).byteLength > WRANGLER_OUTPUT_MAX_BYTES) failed()
  let parsed
  try { parsed = JSON.parse(stdout) } catch { failed() }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !ownObject(parsed[0])) failed()
  const entry = parsed[0]
  const entryKeys = operation === 'import'
    ? ['results', 'success', 'finalBookmark', 'meta']
    : ['results', 'success', 'meta']
  if (!exactObject(entry, entryKeys) || entry.success !== true
    || !ownObject(entry.meta) || !Array.isArray(entry.results)) failed()
  return entry
}

function migrationRows(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) failed()
  const rows = []
  const names = new Set()
  let previous = 0
  for (const row of value) {
    let encodedName
    try {
      if (!exactObject(row, ['id', 'name'])
        || !Number.isSafeInteger(row.id) || row.id <= previous
        || typeof row.name !== 'string' || !MIGRATION_NAME.test(row.name)
        || names.has(row.name)) failed()
      encodedName = new TextEncoder().encode(row.name)
      if (encodedName.byteLength > MIGRATION_NAME_MAX_BYTES) failed()
    } finally {
      encodedName?.fill(0)
    }
    previous = row.id
    names.add(row.name)
    rows.push({ id: row.id, name: row.name })
  }
  return rows
}

function importResult(entry) {
  if (!validOpaque(entry.finalBookmark) || entry.results.length !== 1) failed()
  const row = entry.results[0]
  const keys = ['Total queries executed', 'Rows read', 'Rows written', 'Database size (MB)']
  if (!exactObject(row, keys)
    || !Number.isSafeInteger(row['Total queries executed']) || row['Total queries executed'] < 1
    || !Number.isSafeInteger(row['Rows read']) || row['Rows read'] < 0
    || !Number.isSafeInteger(row['Rows written']) || row['Rows written'] < 0
    || typeof row['Database size (MB)'] !== 'string'
    || !/^\d+(?:\.\d+)?$/.test(row['Database size (MB)'])) failed()
  return { imported: true, finalBookmark: entry.finalBookmark }
}

function sentinelResult(entry) {
  if (entry.results.length !== 1) failed()
  const row = entry.results[0]
  const keys = ['id', 'local_day', 'local_month', 'retention_class', 'status', 'version', 'created_at']
  if (!exactObject(row, keys) || !BACKUP_ID.test(row.id)) failed()
  return {
    sentinel: {
      kind: 'backup_run_v1',
      backupId: row.id,
      createdAt: row.created_at,
      localDay: row.local_day,
      localMonth: row.local_month,
      retentionClass: row.retention_class,
      status: row.status,
      version: row.version,
    },
  }
}

async function privateDirectory(root, prefix) {
  const rootStats = await lstat(root)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) failed()
  const directory = await mkdtemp(join(root, prefix))
  const before = await lstat(directory)
  if (before.isSymbolicLink() || !before.isDirectory()) failed()
  await chmod(directory, 0o700)
  const after = await stat(directory)
  if (!after.isDirectory() || (after.mode & 0o077) !== 0) failed()
  return directory
}

export function createPinnedWranglerRunner(input) {
  if (!exactObject(input, ['tempRoot', 'wranglerPath', 'execute'])
    || typeof input.tempRoot !== 'string' || input.tempRoot.length === 0
    || typeof input.wranglerPath !== 'string' || input.wranglerPath.length === 0
    || typeof input.execute !== 'function') refused()
  let directory = null
  let configPath = null
  let pinnedTarget = null
  let pinnedTargetId = null

  const ensureConfig = async (command) => {
    if (pinnedTarget !== null) {
      if (command.target !== pinnedTarget || command.targetId !== pinnedTargetId) failed()
      return configPath
    }
    if (typeof command.target !== 'string' || !TARGET.test(command.target)
      || typeof command.targetId !== 'string' || !DATABASE_ID.test(command.targetId)) failed()
    directory = await privateDirectory(input.tempRoot, 'bearwithme-restore-wrangler-')
    configPath = join(directory, 'wrangler.json')
    await writeFile(configPath, `${JSON.stringify({
      compatibility_date: '2026-08-27',
      d1_databases: [{
        binding: RESTORE_BINDING,
        database_id: command.targetId,
        database_name: command.target,
      }],
      name: 'bearwithme-restore-operator',
    })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const configStats = await stat(configPath)
    if (!configStats.isFile() || (configStats.mode & 0o077) !== 0) failed()
    pinnedTarget = command.target
    pinnedTargetId = command.targetId
    return configPath
  }

  const runCommand = async (command) => {
    const operation = command?.operation
    const keys = operation === 'import'
      ? ['operation', 'target', 'targetId', 'filePath']
      : operation === 'sentinel'
        ? ['operation', 'target', 'targetId', 'backupId']
        : ['operation', 'target', 'targetId']
    if (!exactObject(command, keys) || !['import', 'migrations', 'sentinel'].includes(operation)
      || (operation === 'import' && (typeof command.filePath !== 'string' || command.filePath.length === 0))
      || (operation === 'sentinel' && (typeof command.backupId !== 'string' || !BACKUP_ID.test(command.backupId)))) failed()
    const path = await ensureConfig(command)
    const common = [
      input.wranglerPath,
      'd1',
      'execute',
      RESTORE_BINDING,
      '--config', path,
      '--remote',
      '--json',
      '--x-provision=false',
      '--x-auto-create=false',
      '--install-skills=false',
    ]
    let args
    if (operation === 'import') args = [...common, '--file', command.filePath]
    else if (operation === 'migrations') {
      args = [...common, '--command', 'SELECT id,name FROM d1_migrations ORDER BY id LIMIT 257']
    } else {
      args = [...common, '--command', `SELECT id,local_day,local_month,retention_class,status,version,created_at FROM backup_runs WHERE id='${command.backupId}'`]
    }
    let child
    try { child = await input.execute(args) } catch { failed() }
    if (!ownObject(child) || typeof child.stdout !== 'string') failed()
    const entry = parseWranglerOutput(child.stdout, operation)
    if (operation === 'import') return importResult(entry)
    if (operation === 'migrations') return { migrations: migrationRows(entry.results) }
    return sentinelResult(entry)
  }

  const cleanup = async () => {
    if (directory === null) return
    const owned = directory
    directory = null
    configPath = null
    pinnedTarget = null
    pinnedTargetId = null
    try { await rm(owned, { recursive: true, force: true }) } catch { failed() }
  }

  return Object.freeze({ runCommand, cleanup })
}

export function validateRestoreRequest(input) {
  if (!exactObject(input, ['request', 'sourceDatabaseNames', 'sourceDatabaseIds', 'productionDatabaseNames', 'productionDatabaseIds'])
    || !exactObject(input.request, ['manifestKey', 'target', 'allowLegacyUnverified'])
    || !exactStringList(input.sourceDatabaseNames, DATABASE_NAME)
    || !exactStringList(input.sourceDatabaseIds, DATABASE_ID)
    || !exactStringList(input.productionDatabaseNames, DATABASE_NAME)
    || !exactStringList(input.productionDatabaseIds, DATABASE_ID)) refused()
  const { manifestKey, target, allowLegacyUnverified } = input.request
  const match = typeof manifestKey === 'string' ? MANIFEST_KEY.exec(manifestKey) : null
  if (!match || typeof target !== 'string' || !TARGET.test(target)
    || target === 'bearwithme-restore-'
    || typeof allowLegacyUnverified !== 'boolean'
    || (match[1] === 'v1' && allowLegacyUnverified !== true)
    || input.sourceDatabaseNames.includes(target) || input.sourceDatabaseIds.includes(target)
    || input.productionDatabaseNames.includes(target) || input.productionDatabaseIds.includes(target)) refused()
  return { manifestKey, target, allowLegacyUnverified }
}

function expectedSourceValue(value) {
  if (!exactObject(value, ['accountId', 'appEnv', 'dataMode', 'databaseId'])
    || !ACCOUNT_ID.test(value.accountId) || value.appEnv !== 'staging'
    || value.dataMode !== 'fictional' || !DATABASE_ID.test(value.databaseId)) refused()
  return value
}

function validateTarget(value, request, policy) {
  if (!exactObject(value, ['name', 'id', 'jurisdiction'])
    || value.name !== request.target || !DATABASE_ID.test(value.id)
    || value.jurisdiction !== 'eu'
    || policy.sourceDatabaseNames.includes(value.name) || policy.sourceDatabaseIds.includes(value.id)
    || policy.productionDatabaseNames.includes(value.name) || policy.productionDatabaseIds.includes(value.id)) refused()
  return value
}

function validateHead(value, manifest) {
  const expected = expectedObjectMetadata(manifest)
  if (!exactObject(value, ['etag', 'size', 'customMetadata'])
    || value.etag !== manifest.objectEtag || value.size !== manifest.objectSize
    || !exactObject(value.customMetadata, Object.keys(expected))) failed()
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value.customMetadata[key] !== expectedValue) failed()
  }
}

function exactVerifiedSourceRow(value, manifest, manifestKey) {
  const keys = [
    'id', 'status', 'version', 'localDay', 'localMonth', 'retentionClass',
    'objectKey', 'manifestKey', 'objectEtag', 'objectSize', 'completedAt',
    'lastErrorCode', 'createdAt',
  ]
  return exactObject(value, keys)
    && value.id === manifest.backupId
    && value.status === 'restore_verified'
    && value.version === 4
    && value.localDay === manifest.localDay
    && value.localMonth === manifest.localMonth
    && value.retentionClass === manifest.retentionClass
    && value.objectKey === manifest.objectKey
    && value.manifestKey === manifestKey
    && value.objectEtag === manifest.objectEtag
    && value.objectSize === manifest.objectSize
    && validInstant(value.completedAt)
    && value.lastErrorCode === null
    && value.createdAt === manifest.createdAt
}

export async function writeRestoreStream(handle, stream, expectedSize) {
  if (!handle || typeof handle.write !== 'function' || !(stream instanceof ReadableStream)
    || !Number.isSafeInteger(expectedSize) || expectedSize < 0) failed()
  let total = 0
  const reader = stream.getReader()
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0
        || part.value.byteLength > expectedSize - total) failed()
      let offset = 0
      while (offset < part.value.byteLength) {
        const remaining = part.value.byteLength - offset
        const written = await handle.write(part.value, offset, remaining, null)
        if (!Number.isSafeInteger(written?.bytesWritten)
          || written.bytesWritten <= 0 || written.bytesWritten > remaining) failed()
        offset += written.bytesWritten
        total += written.bytesWritten
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (total !== expectedSize) failed()
}

async function writeStream0600(directory, stream, expectedSize) {
  const filePath = join(directory, 'restore.sql')
  const handle = await open(filePath, 'wx', 0o600)
  try { await writeRestoreStream(handle, stream, expectedSize) } finally { await handle.close() }
  const fileStats = await stat(filePath)
  if (!fileStats.isFile() || (fileStats.mode & 0o077) !== 0) failed()
  return filePath
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value))
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    try { return [...digest].map((part) => part.toString(16).padStart(2, '0')).join('') } finally { digest.fill(0) }
  } finally { bytes.fill(0) }
}

export async function restoreBackup(input) {
  const required = [
    'request', 'expectedSource', 'sourceDatabaseNames', 'sourceDatabaseIds',
    'productionDatabaseNames', 'productionDatabaseIds', 'tempRoot', 'keyring',
    'provider', 'runCommand', 'log',
  ]
  const keys = input && Reflect.ownKeys(input).includes('signal') ? [...required, 'signal'] : required
  if (!exactObject(input, keys) || typeof input.tempRoot !== 'string' || input.tempRoot.length === 0
    || !input.keyring || typeof input.keyring.getBackupKek !== 'function'
    || !input.provider || typeof input.provider.describeDatabase !== 'function'
    || typeof input.provider.getManifest !== 'function' || typeof input.provider.headObject !== 'function'
    || typeof input.provider.getObject !== 'function' || typeof input.provider.markRestoreVerified !== 'function'
    || typeof input.provider.readSourceBackup !== 'function'
    || typeof input.runCommand !== 'function' || typeof input.log !== 'function'
    || (Object.hasOwn(input, 'signal') && !(input.signal instanceof AbortSignal))) refused()
  const policy = {
    sourceDatabaseNames: input.sourceDatabaseNames,
    sourceDatabaseIds: input.sourceDatabaseIds,
    productionDatabaseNames: input.productionDatabaseNames,
    productionDatabaseIds: input.productionDatabaseIds,
  }
  const request = validateRestoreRequest({ request: input.request, ...policy })
  const expectedSource = expectedSourceValue(input.expectedSource)
  let temporaryDirectory = null
  let rawSsecKey
  const checkpoint = () => { if (input.signal?.aborted === true) failed() }
  try {
    checkpoint()
    const restoredTarget = validateTarget(await input.provider.describeDatabase(request.target), request, policy)
    checkpoint()
    const rawManifest = await input.provider.getManifest(request.manifestKey)
    checkpoint()
    if (!(rawManifest instanceof Uint8Array)) failed()
    const manifest = parseCanonicalManifest(rawManifest)
    const version = manifest.format === 'bwm-d1-sql-v1' ? 1 : 2
    if (version === 1 && request.allowLegacyUnverified !== true) refused()
    const expectedKeys = backupObjectKeys({ backupId: manifest.backupId, localMonth: manifest.localMonth, version })
    if (expectedKeys.manifestKey !== request.manifestKey || expectedKeys.objectKey !== manifest.objectKey) failed()
    if (version === 2 && canonicalJson(manifest.source) !== canonicalJson(expectedSource)) refused()
    const opened = await openBackupManifest({ bytes: rawManifest, keyring: input.keyring })
    rawSsecKey = opened.rawSsecKey
    validateHead(await input.provider.headObject({ key: manifest.objectKey, ssecKey: rawSsecKey }), manifest)
    checkpoint()
    const body = await input.provider.getObject({ key: manifest.objectKey, ssecKey: rawSsecKey })
    checkpoint()
    temporaryDirectory = await privateDirectory(input.tempRoot, 'bearwithme-restore-')
    const filePath = await writeStream0600(temporaryDirectory, body, manifest.objectSize)
    const imported = await input.runCommand({ operation: 'import', target: restoredTarget.name, targetId: restoredTarget.id, filePath })
    checkpoint()
    if (!exactObject(imported, ['imported', 'finalBookmark']) || imported.imported !== true || !validOpaque(imported.finalBookmark)) failed()
    const migrationResponse = await input.runCommand({ operation: 'migrations', target: restoredTarget.name, targetId: restoredTarget.id })
    checkpoint()
    if (!exactObject(migrationResponse, ['migrations'])) failed()
    const migrations = migrationRows(migrationResponse.migrations)
    if (version === 1) {
      const result = { backupId: manifest.backupId, migrationCount: migrations.length, status: 'legacy_unverified', target: restoredTarget.name }
      await input.log({ ...result })
      return result
    }
    if (canonicalJson(migrations) !== canonicalJson(manifest.appliedMigrations)) failed()
    const sentinelResponse = await input.runCommand({
      operation: 'sentinel', target: restoredTarget.name, targetId: restoredTarget.id, backupId: manifest.backupId,
    })
    checkpoint()
    if (!exactObject(sentinelResponse, ['sentinel'])
      || canonicalJson(sentinelResponse.sentinel) !== canonicalJson(manifest.restoreSentinel)) failed()
    const markFacts = {
      backupId: manifest.backupId,
      manifestKey: request.manifestKey,
      objectEtag: manifest.objectEtag,
      objectKey: manifest.objectKey,
      objectSize: manifest.objectSize,
    }
    let marked
    try {
      marked = await input.provider.markRestoreVerified(markFacts)
    } catch {
      const observed = await input.provider.readSourceBackup({ backupId: manifest.backupId })
      if (!exactVerifiedSourceRow(observed, manifest, request.manifestKey)) failed()
      marked = { updated: true }
    }
    checkpoint()
    if (!exactObject(marked, ['updated']) || marked.updated !== true) failed()
    const result = {
      backupId: manifest.backupId,
      migrationCount: migrations.length,
      migrationSetSha256: await sha256(migrations),
      status: 'restore_verified',
      target: restoredTarget.name,
    }
    await input.log({ ...result })
    return result
  } catch (error) {
    if (error?.message === 'RESTORE_REFUSED') throw error
    throw new Error('RESTORE_FAILED')
  } finally {
    if (rawSsecKey instanceof Uint8Array) rawSsecKey.fill(0)
    if (temporaryDirectory !== null) {
      try { await rm(temporaryDirectory, { recursive: true, force: true }) } catch { throw new Error('RESTORE_FAILED') }
    }
  }
}
