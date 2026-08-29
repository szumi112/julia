import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { unstable_splitSqlQuery } from 'wrangler'
import {
  BACKUP_SQL_IMPORT_MAX_BYTES,
  BACKUP_SQL_MAX_BYTES,
} from '../worker/operations/backup-limits.js'
import {
  backupObjectKeys,
  canonicalJson,
  expectedObjectMetadata,
  openBackupManifest,
} from '../worker/operations/backup-format.js'
import { readBackupRecoverySnapshotWithQuery } from '../worker/operations/backup-recovery.js'

const TARGET = /^bearwithme-restore-[a-z0-9][a-z0-9-]{0,62}$/
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ACCOUNT_ID = /^[0-9a-f]{32}$/
const DATABASE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/
const MIGRATION_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/
const MIGRATION_NAME_MAX_BYTES = 255
const MANIFEST_KEY = /^backups\/(v1|v2|v3)\/\d{4}\/(?:0[1-9]|1[0-2])\/(bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123})\.manifest\.json$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const RESTORE_BINDING = 'RESTORE_TARGET'
const WRANGLER_OUTPUT_MAX_BYTES = 1024 * 1024
const MANIFEST_MAX_BYTES = 64 * 1024
const FRESH_TARGET_SQL = `SELECT count(*) AS application_object_count
FROM sqlite_schema
WHERE name NOT GLOB 'sqlite_*'
  AND name NOT GLOB '_cf_*'`
const FOREIGN_KEYS_SQL = 'PRAGMA foreign_keys'
const INTEGRITY_SQL = 'PRAGMA quick_check'
const FOREIGN_KEY_CHECK_SQL = 'PRAGMA foreign_key_check'
const SOURCE_ROW_KEYS = Object.freeze([
  'id', 'status', 'version', 'localDay', 'localMonth', 'retentionClass',
  'exportBookmark', 'objectKey', 'manifestKey', 'ssecKeyVersion',
  'wrappedSsecKeyB64', 'wrapNonceB64', 'objectEtag', 'objectSize', 'completedAt',
  'restoreVerifiedAt', 'lastErrorCode', 'createdAt', 'updatedAt',
])

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

export function reorderD1RestoreSql(source) {
  if (typeof source !== 'string'
    || new TextEncoder().encode(source).byteLength > BACKUP_SQL_MAX_BYTES) failed()
  let statements
  try { statements = unstable_splitSqlQuery(source) } catch { failed() }
  if (!Array.isArray(statements) || statements.length < 1) failed()
  const groups = {
    pragmas: [],
    tables: [],
    sequence: [],
    inserts: [],
    indexes: [],
    views: [],
    triggers: [],
  }
  for (const statement of statements) {
    if (typeof statement !== 'string' || statement.length === 0) failed()
    const normalized = statement.trimStart()
    if (/^PRAGMA\s+defer_foreign_keys\s*=\s*(?:TRUE|ON|1);?\s*$/i.test(normalized)) {
      groups.pragmas.push(statement)
    } else if (/^CREATE TABLE\s/i.test(normalized)) {
      groups.tables.push(statement)
    } else if (/^DELETE FROM\s+sqlite_sequence;?\s*$/i.test(normalized)) {
      groups.sequence.push(statement)
    } else if (/^INSERT INTO\s/i.test(normalized)) {
      groups.inserts.push(statement)
    } else if (/^CREATE (?:UNIQUE )?INDEX\s/i.test(normalized)) {
      groups.indexes.push(statement)
    } else if (/^CREATE VIEW\s/i.test(normalized)) {
      groups.views.push(statement)
    } else if (/^CREATE TRIGGER\s/i.test(normalized)) {
      groups.triggers.push(statement)
    } else {
      failed()
    }
  }
  if (groups.pragmas.length !== 1 || groups.tables.length < 1
    || groups.inserts.length < 1 || groups.sequence.length > 1) failed()
  const terminated = (statement) => {
    const trimmed = statement.trimEnd()
    return trimmed.endsWith(';') ? trimmed : `${trimmed};`
  }
  const insertTable = (statement) => {
    const match = statement.trimStart().match(
      /^INSERT INTO\s+(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))\s+/i,
    )
    if (!match) failed()
    return match[1] === undefined ? match[2] : match[1].replaceAll('""', '"')
  }
  const identifierKey = (value) => value.replace(/[A-Z]/g, (character) => character.toLowerCase())
  const ordinaryInserts = []
  const sequenceInserts = []
  for (const statement of groups.inserts) {
    const name = insertTable(statement)
    if (identifierKey(name) === 'sqlite_sequence') sequenceInserts.push(statement)
    else ordinaryInserts.push({ name: identifierKey(name), statement })
  }
  if (sequenceInserts.length > 0 && groups.sequence.length !== 1) failed()
  const insertsByTable = new Map()
  for (const entry of ordinaryInserts) {
    const entries = insertsByTable.get(entry.name) ?? []
    entries.push(entry)
    insertsByTable.set(entry.name, entries)
  }
  let database
  let orderedInserts
  try {
    database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys=OFF;')
    const tableNames = new Map()
    for (const statement of groups.tables) {
      const before = new Set(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
      ).all().map(({ name }) => name))
      database.exec(terminated(statement))
      const added = database.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
      ).all().map(({ name }) => name).filter((name) => !before.has(name))
      const addedKey = added.length === 1 ? identifierKey(added[0]) : null
      if (addedKey === null || tableNames.has(addedKey)) failed()
      tableNames.set(addedKey, added[0])
    }
    for (const statement of groups.indexes) database.exec(terminated(statement))
    if (ordinaryInserts.some(({ name }) => !tableNames.has(name))) failed()
    const dependencies = new Map()
    for (const [key, name] of tableNames) {
      const quoted = name.replaceAll('"', '""')
      const rows = database.prepare(`PRAGMA foreign_key_list("${quoted}")`).all()
      const parents = new Set()
      for (const row of rows) {
        if (typeof row.table !== 'string') failed()
        const parent = identifierKey(row.table)
        if (!tableNames.has(parent)) failed()
        if (insertsByTable.has(parent)) parents.add(parent)
      }
      dependencies.set(key, parents)
    }
    const orderedTables = []
    const visiting = new Set()
    const visited = new Set()
    const visit = (key) => {
      if (visited.has(key) || visiting.has(key)) return
      visiting.add(key)
      for (const dependency of dependencies.get(key) ?? []) visit(dependency)
      visiting.delete(key)
      visited.add(key)
      orderedTables.push(key)
    }
    for (const key of insertsByTable.keys()) visit(key)
    orderedInserts = orderedTables.flatMap((key) => insertsByTable.get(key))
    if (orderedInserts.length !== ordinaryInserts.length) failed()
    database.exec('PRAGMA foreign_keys=ON; BEGIN;')
    for (const statement of groups.pragmas) database.exec(terminated(statement))
    for (const { statement } of orderedInserts) database.exec(terminated(statement))
    for (const statement of groups.sequence) database.exec(terminated(statement))
    for (const statement of sequenceInserts) database.exec(terminated(statement))
    for (const statement of groups.views) database.exec(terminated(statement))
    for (const statement of groups.triggers) database.exec(terminated(statement))
    database.exec('COMMIT;')
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) failed()
  } catch {
    try { database?.exec('ROLLBACK;') } catch {}
    failed()
  } finally {
    try { database?.close() } catch { failed() }
  }
  const result = [
    ...groups.pragmas,
    ...groups.tables,
    ...groups.indexes,
    ...orderedInserts.map(({ statement }) => statement),
    ...groups.sequence,
    ...sequenceInserts,
    ...groups.views,
    ...groups.triggers,
  ].map(terminated).join('\n') + '\n'
  if (new TextEncoder().encode(result).byteLength > BACKUP_SQL_IMPORT_MAX_BYTES) failed()
  return result
}

function parseWranglerOutput(stdout, operation) {
  if (typeof stdout !== 'string'
    || new TextEncoder().encode(stdout).byteLength > WRANGLER_OUTPUT_MAX_BYTES) failed()
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    if (operation !== 'import') failed()
    const candidates = []
    for (let index = 0; index < stdout.length; index += 1) {
      if (stdout[index] === '[' && (index === 0 || stdout[index - 1] === '\n')) candidates.push(index)
    }
    if (candidates.length !== 1 || candidates[0] === 0) failed()
    const prefix = stdout.slice(0, candidates[0])
    if (!prefix.endsWith('\n') || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(prefix.replaceAll('\n', ''))) failed()
    const lines = prefix.slice(0, -1).split('\n')
    if (lines.length < 1 || lines.length > 32
      || lines.some((line) => line.length > 512
        || !/^(?:├ [^\[\]{}"\\\r\n]{1,512}|│(?: [^\[\]{}"\\\r\n]{1,512})?)$/u.test(line))) failed()
    try { parsed = JSON.parse(stdout.slice(candidates[0])) } catch { failed() }
  }
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

  const executeSql = async (command, operation, sql = null) => {
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
    else args = [...common, '--command', sql]
    let child
    try { child = await input.execute(args) } catch { failed() }
    if (!ownObject(child) || typeof child.stdout !== 'string') failed()
    const entry = parseWranglerOutput(child.stdout, operation)
    if (operation === 'import') return importResult(entry)
    return entry.results
  }

  const runCommand = async (command) => {
    const operation = command?.operation
    const keys = operation === 'import'
      ? ['operation', 'target', 'targetId', 'filePath']
      : operation === 'sentinel'
        ? ['operation', 'target', 'targetId', 'backupId']
        : ['operation', 'target', 'targetId']
    if (!exactObject(command, keys)
      || !['freshness', 'import', 'integrity', 'migrations', 'recovery', 'sentinel'].includes(operation)
      || (operation === 'import'
        && (typeof command.filePath !== 'string' || command.filePath.length === 0))
      || (operation === 'sentinel'
        && (typeof command.backupId !== 'string' || !BACKUP_ID.test(command.backupId)))) failed()
    if (operation === 'import') return executeSql(command, operation)
    if (operation === 'freshness') {
      const rows = await executeSql(command, operation, FRESH_TARGET_SQL)
      if (!Array.isArray(rows) || rows.length !== 1
        || !exactObject(rows[0], ['application_object_count'])
        || rows[0].application_object_count !== 0) failed()
      return { fresh: true }
    }
    if (operation === 'integrity') {
      const foreignKeys = await executeSql(command, operation, FOREIGN_KEYS_SQL)
      if (!Array.isArray(foreignKeys) || foreignKeys.length !== 1
        || !exactObject(foreignKeys[0], ['foreign_keys'])
        || foreignKeys[0].foreign_keys !== 1) failed()
      const integrity = await executeSql(command, operation, INTEGRITY_SQL)
      if (!Array.isArray(integrity) || integrity.length !== 1
        || !exactObject(integrity[0], ['quick_check'])
        || integrity[0].quick_check !== 'ok') failed()
      const foreignKeyCheck = await executeSql(command, operation, FOREIGN_KEY_CHECK_SQL)
      if (!Array.isArray(foreignKeyCheck) || foreignKeyCheck.length !== 0) failed()
      return { valid: true }
    }
    if (operation === 'migrations') {
      const rows = await executeSql(
        command,
        operation,
        'SELECT id,name FROM d1_migrations ORDER BY id LIMIT 257',
      )
      return { migrations: migrationRows(rows) }
    }
    if (operation === 'sentinel') {
      const rows = await executeSql(
        command,
        operation,
        `SELECT id,local_day,local_month,retention_class,status,version,created_at FROM backup_runs WHERE id='${command.backupId}'`,
      )
      return sentinelResult({ results: rows })
    }
    return readBackupRecoverySnapshotWithQuery((sql) => executeSql(command, operation, sql))
  }

  const cleanup = async () => {
    if (directory === null) return
    const owned = directory
    try { await rm(owned, { recursive: true, force: true }) } catch { failed() }
    directory = null
    configPath = null
    pinnedTarget = null
    pinnedTargetId = null
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

function validateManifestHead(value) {
  if (!exactObject(value, ['etag', 'size']) || !validOpaque(value.etag)
    || !Number.isSafeInteger(value.size) || value.size < 1
    || value.size > MANIFEST_MAX_BYTES) failed()
  return value
}

function validateManifestGet(value, head) {
  if (!exactObject(value, ['etag', 'size', 'bytes'])
    || value.etag !== head.etag || value.size !== head.size
    || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength !== head.size) failed()
  return value.bytes
}

function validateObjectHead(value, manifest) {
  const expected = expectedObjectMetadata(manifest)
  if (!exactObject(value, ['etag', 'size', 'customMetadata'])
    || value.etag !== manifest.objectEtag || value.size !== manifest.objectSize
    || !exactObject(value.customMetadata, Object.keys(expected))) failed()
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value.customMetadata[key] !== expectedValue) failed()
  }
  return value
}

function validateObjectGet(value, head) {
  if (!exactObject(value, ['etag', 'size', 'body'])
    || value.etag !== head.etag || value.size !== head.size
    || !(value.body instanceof ReadableStream)) failed()
  return value.body
}

function exactVerifiedSourceRow(value, manifest, manifestKey, verifiedAt) {
  return exactObject(value, SOURCE_ROW_KEYS)
    && value.id === manifest.backupId
    && value.status === 'restore_verified'
    && value.version === 4
    && value.localDay === manifest.localDay
    && value.localMonth === manifest.localMonth
    && value.retentionClass === manifest.retentionClass
    && value.exportBookmark === manifest.atBookmark
    && value.objectKey === manifest.objectKey
    && value.manifestKey === manifestKey
    && value.ssecKeyVersion === manifest.wrappedSsecKey.kekVersion
    && value.wrappedSsecKeyB64 === manifest.wrappedSsecKey.ciphertext
    && value.wrapNonceB64 === manifest.wrappedSsecKey.nonce
    && value.objectEtag === manifest.objectEtag
    && value.objectSize === manifest.objectSize
    && validInstant(value.completedAt)
    && value.restoreVerifiedAt === verifiedAt
    && value.lastErrorCode === null
    && value.createdAt === manifest.createdAt
    && value.updatedAt === verifiedAt
}

const SOURCE_SELECT = `id,status,version,local_day,local_month,retention_class,
export_bookmark,object_key,manifest_key,ssec_key_version,wrapped_ssec_key_b64,
wrap_nonce_b64,object_etag,object_size,completed_at,restore_verified_at,
last_error_code,created_at,updated_at`

function sourceRow(value) {
  const keys = SOURCE_SELECT.replaceAll('\n', '').split(',')
  if (!exactObject(value, keys) || !BACKUP_ID.test(value.id)) failed()
  return {
    id: value.id,
    status: value.status,
    version: value.version,
    localDay: value.local_day,
    localMonth: value.local_month,
    retentionClass: value.retention_class,
    exportBookmark: value.export_bookmark,
    objectKey: value.object_key,
    manifestKey: value.manifest_key,
    ssecKeyVersion: value.ssec_key_version,
    wrappedSsecKeyB64: value.wrapped_ssec_key_b64,
    wrapNonceB64: value.wrap_nonce_b64,
    objectEtag: value.object_etag,
    objectSize: value.object_size,
    completedAt: value.completed_at,
    restoreVerifiedAt: value.restore_verified_at,
    lastErrorCode: value.last_error_code,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}

function responseRows(value) {
  if (!exactObject(value, ['meta', 'results', 'success'])
    || value.success !== true || !ownObject(value.meta)
    || !Array.isArray(value.results) || value.results.length > 1) failed()
  return value.results
}

export function createRestoreSourceStore(input) {
  if (!exactObject(input, ['db']) || typeof input.db?.prepare !== 'function') refused()
  const readSourceBackup = async ({ backupId } = {}) => {
    if (typeof backupId !== 'string' || !BACKUP_ID.test(backupId)) failed()
    const response = await input.db.prepare(
      `SELECT ${SOURCE_SELECT} FROM backup_runs WHERE id=? LIMIT 2`,
    ).bind(backupId).all()
    const rows = responseRows(response)
    return rows.length === 0 ? null : sourceRow(rows[0])
  }
  const markRestoreVerified = async (facts) => {
    const keys = [
      'backupId', 'localDay', 'localMonth', 'retentionClass', 'createdAt',
      'exportBookmark', 'objectKey', 'manifestKey', 'objectEtag', 'objectSize',
      'ssecKeyVersion', 'wrappedSsecKeyB64', 'wrapNonceB64', 'verifiedAt',
    ]
    if (!exactObject(facts, keys) || !BACKUP_ID.test(facts.backupId)
      || !validInstant(facts.createdAt) || !validInstant(facts.verifiedAt)
      || !Number.isSafeInteger(facts.objectSize) || facts.objectSize < 1
      || !Number.isSafeInteger(facts.ssecKeyVersion) || facts.ssecKeyVersion < 1
      || !['daily', 'monthly'].includes(facts.retentionClass)
      || !validOpaque(facts.exportBookmark) || !validOpaque(facts.objectKey)
      || !validOpaque(facts.manifestKey) || !validOpaque(facts.objectEtag)
      || !validOpaque(facts.wrappedSsecKeyB64) || !validOpaque(facts.wrapNonceB64)) failed()
    const response = await input.db.prepare(
      `UPDATE backup_runs
       SET status='restore_verified',version=4,restore_verified_at=?,updated_at=?
       WHERE id=? AND local_day=? AND local_month=? AND retention_class=?
         AND status='stored' AND version=3 AND created_at=? AND last_error_code IS NULL
         AND export_bookmark=? AND object_key=? AND manifest_key=? AND object_etag=?
         AND object_size=? AND ssec_key_version=? AND wrapped_ssec_key_b64=?
         AND wrap_nonce_b64=? AND restore_verified_at IS NULL
       RETURNING ${SOURCE_SELECT}`,
    ).bind(
      facts.verifiedAt,
      facts.verifiedAt,
      facts.backupId,
      facts.localDay,
      facts.localMonth,
      facts.retentionClass,
      facts.createdAt,
      facts.exportBookmark,
      facts.objectKey,
      facts.manifestKey,
      facts.objectEtag,
      facts.objectSize,
      facts.ssecKeyVersion,
      facts.wrappedSsecKeyB64,
      facts.wrapNonceB64,
    ).all()
    const rows = responseRows(response)
    if (rows.length === 0) return { updated: false }
    const row = sourceRow(rows[0])
    return { updated: exactVerifiedSourceRow(row, {
      backupId: facts.backupId,
      localDay: facts.localDay,
      localMonth: facts.localMonth,
      retentionClass: facts.retentionClass,
      createdAt: facts.createdAt,
      atBookmark: facts.exportBookmark,
      objectKey: facts.objectKey,
      objectEtag: facts.objectEtag,
      objectSize: facts.objectSize,
      wrappedSsecKey: {
        kekVersion: facts.ssecKeyVersion,
        ciphertext: facts.wrappedSsecKeyB64,
        nonce: facts.wrapNonceB64,
      },
    }, facts.manifestKey, facts.verifiedAt) }
  }
  return Object.freeze({ markRestoreVerified, readSourceBackup })
}

export async function writeRestoreStream(handle, stream, expectedSize) {
  if (!handle || typeof handle.write !== 'function' || !(stream instanceof ReadableStream)
    || !Number.isSafeInteger(expectedSize) || expectedSize < 0) failed()
  let total = 0
  const reader = stream.getReader()
  const hash = createHash('sha256')
  let completed = false
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
      hash.update(part.value)
    }
    if (total !== expectedSize) failed()
    completed = true
    return { byteCount: total, plaintextSqlSha256: hash.digest('hex') }
  } finally {
    if (!completed) {
      try { await reader.cancel() } catch {}
      try { hash.destroy() } catch {}
    }
    try { reader.releaseLock() } catch {}
  }
}

async function writeStream0600(directory, stream, expectedSize) {
  const filePath = join(directory, 'restore.sql')
  const handle = await open(filePath, 'wx', 0o600)
  let evidence
  try { evidence = await writeRestoreStream(handle, stream, expectedSize) } finally { await handle.close() }
  const fileStats = await stat(filePath)
  if (!fileStats.isFile() || (fileStats.mode & 0o077) !== 0) failed()
  return { filePath, ...evidence }
}

export async function prepareD1RestoreImportFile(input) {
  if (!exactObject(input, ['directory', 'sourcePath', 'expectedSize'])
    || typeof input.directory !== 'string' || input.directory.length === 0
    || input.sourcePath !== join(input.directory, 'restore.sql')
    || !Number.isSafeInteger(input.expectedSize) || input.expectedSize < 1
    || input.expectedSize > BACKUP_SQL_MAX_BYTES) failed()
  const directoryStats = await lstat(input.directory)
  const sourceStats = await lstat(input.sourcePath)
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()
    || (directoryStats.mode & 0o077) !== 0 || sourceStats.isSymbolicLink()
    || !sourceStats.isFile() || (sourceStats.mode & 0o077) !== 0
    || sourceStats.size !== input.expectedSize) failed()
  let sourceBytes
  let importBytes
  try {
    sourceBytes = await readFile(input.sourcePath)
    if (sourceBytes.byteLength !== input.expectedSize) failed()
    let source
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes) } catch { failed() }
    importBytes = new TextEncoder().encode(reorderD1RestoreSql(source))
    if (importBytes.byteLength < 1 || importBytes.byteLength > BACKUP_SQL_IMPORT_MAX_BYTES) failed()
    const importPath = join(input.directory, 'restore-import.sql')
    await writeFile(importPath, importBytes, { flag: 'wx', mode: 0o600 })
    const importStats = await lstat(importPath)
    if (importStats.isSymbolicLink() || !importStats.isFile()
      || (importStats.mode & 0o077) !== 0 || importStats.size !== importBytes.byteLength) failed()
    return { filePath: importPath }
  } finally {
    sourceBytes?.fill(0)
    importBytes?.fill(0)
  }
}

export async function removeRestoreTemporaryDirectory(input) {
  if (!exactObject(input, ['directory', 'filePath'])
    || typeof input.directory !== 'string' || input.directory.length === 0
    || !(input.filePath === null
      || input.filePath === join(input.directory, 'restore.sql')
      || input.filePath === join(input.directory, 'restore-import.sql'))) failed()
  await rm(input.directory, { recursive: true, force: true })
  if (input.filePath !== null) await proveAbsent(input.filePath)
  await proveAbsent(input.directory)
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value))
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    try { return [...digest].map((part) => part.toString(16).padStart(2, '0')).join('') } finally { digest.fill(0) }
  } finally { bytes.fill(0) }
}

async function proveAbsent(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    failed()
  }
  failed()
}

function restoreResult({ manifest, migrations, migrationSetSha256, recoveryKind, target,
  migrationsVerified, recoveryFactsVerified, restoreSentinelVerified,
  sourceMarkedVerified }) {
  return {
    backupId: manifest.backupId,
    format: manifest.format,
    migrationCount: migrations.length,
    migrationSetSha256,
    recoveryKind,
    target,
    manifestAuthenticated: true,
    objectReadbackVerified: true,
    migrationsVerified,
    recoveryFactsVerified,
    restoreSentinelVerified,
    sourceMarkedVerified,
    targetFreshVerified: true,
  }
}

export async function restoreBackup(input) {
  const required = [
    'request', 'expectedSource', 'sourceDatabaseNames', 'sourceDatabaseIds',
    'productionDatabaseNames', 'productionDatabaseIds', 'tempRoot', 'keyring',
    'provider', 'prepareImport', 'removeTemporaryDirectory', 'runCommand',
    'cleanupTarget',
  ]
  const keys = input && Reflect.ownKeys(input).includes('signal') ? [...required, 'signal'] : required
  if (!exactObject(input, keys) || typeof input.tempRoot !== 'string' || input.tempRoot.length === 0
    || !input.keyring || typeof input.keyring.getBackupKek !== 'function'
    || !input.provider || typeof input.provider.describeDatabase !== 'function'
    || typeof input.provider.headManifest !== 'function'
    || typeof input.provider.getManifest !== 'function'
    || typeof input.provider.headObject !== 'function'
    || typeof input.provider.getObject !== 'function' || typeof input.provider.markRestoreVerified !== 'function'
    || typeof input.provider.readSourceBackup !== 'function'
    || typeof input.prepareImport !== 'function'
    || typeof input.removeTemporaryDirectory !== 'function'
    || typeof input.runCommand !== 'function' || typeof input.cleanupTarget !== 'function'
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
  let filePath = null
  let rawSsecKey
  let targetCleaned = false
  let temporaryRemovalAttempts = 0
  const checkpoint = () => { if (input.signal?.aborted === true) failed() }
  const cleanupBeforeBoundary = async () => {
    let cleanupFailed = false
    if (rawSsecKey instanceof Uint8Array) rawSsecKey.fill(0)
    rawSsecKey = undefined
    if (temporaryDirectory !== null) {
      const ownedDirectory = temporaryDirectory
      const ownedFile = filePath
      let removed = false
      while (temporaryRemovalAttempts < 2 && !removed) {
        temporaryRemovalAttempts += 1
        try {
          await input.removeTemporaryDirectory({
            directory: ownedDirectory,
            filePath: ownedFile,
          })
          removed = true
        } catch { /* Retain ownership and retry once. */ }
      }
      if (removed) {
        temporaryDirectory = null
        filePath = null
      } else cleanupFailed = true
    }
    if (!targetCleaned) {
      try {
        await input.cleanupTarget()
        targetCleaned = true
      } catch { cleanupFailed = true }
    }
    if (cleanupFailed) failed()
  }
  try {
    checkpoint()
    const restoredTarget = validateTarget(await input.provider.describeDatabase(request.target), request, policy)
    checkpoint()
    const freshness = await input.runCommand({
      operation: 'freshness', target: restoredTarget.name, targetId: restoredTarget.id,
    })
    if (!exactObject(freshness, ['fresh']) || freshness.fresh !== true) failed()
    checkpoint()
    const manifestHead = validateManifestHead(await input.provider.headManifest({
      key: request.manifestKey,
    }))
    checkpoint()
    const rawManifest = validateManifestGet(await input.provider.getManifest({
      key: request.manifestKey,
      ifMatch: manifestHead.etag,
    }), manifestHead)
    checkpoint()
    const opened = await openBackupManifest({ bytes: rawManifest, keyring: input.keyring })
    const manifest = opened.manifest
    rawSsecKey = opened.rawSsecKey
    const version = {
      'bwm-d1-sql-v1': 1,
      'bwm-d1-sql-v2': 2,
      'bwm-d1-sql-v3': 3,
    }[manifest.format]
    if (!version) failed()
    if (version === 1 && request.allowLegacyUnverified !== true) refused()
    const expectedKeys = backupObjectKeys({ backupId: manifest.backupId, localMonth: manifest.localMonth, version })
    if (expectedKeys.manifestKey !== request.manifestKey || expectedKeys.objectKey !== manifest.objectKey) failed()
    if (version >= 2 && canonicalJson(manifest.source) !== canonicalJson(expectedSource)) refused()
    const objectHead = validateObjectHead(await input.provider.headObject({
      key: manifest.objectKey,
      ssecKey: rawSsecKey,
    }), manifest)
    checkpoint()
    const body = validateObjectGet(await input.provider.getObject({
      key: manifest.objectKey,
      ssecKey: rawSsecKey,
      ifMatch: objectHead.etag,
    }), objectHead)
    checkpoint()
    temporaryDirectory = await privateDirectory(input.tempRoot, 'bearwithme-restore-')
    const written = await writeStream0600(temporaryDirectory, body, manifest.objectSize)
    filePath = written.filePath
    if (version === 3 && written.plaintextSqlSha256 !== manifest.plaintextSqlSha256) failed()
    const prepared = await input.prepareImport({
      directory: temporaryDirectory,
      sourcePath: filePath,
      expectedSize: manifest.objectSize,
    })
    if (!exactObject(prepared, ['filePath'])
      || prepared.filePath !== join(temporaryDirectory, 'restore-import.sql')) failed()
    filePath = prepared.filePath
    const imported = await input.runCommand({ operation: 'import', target: restoredTarget.name, targetId: restoredTarget.id, filePath })
    checkpoint()
    if (!exactObject(imported, ['imported', 'finalBookmark']) || imported.imported !== true || !validOpaque(imported.finalBookmark)) failed()
    const integrity = await input.runCommand({
      operation: 'integrity', target: restoredTarget.name, targetId: restoredTarget.id,
    })
    checkpoint()
    if (!exactObject(integrity, ['valid']) || integrity.valid !== true) failed()
    const migrationResponse = await input.runCommand({
      operation: 'migrations',
      target: restoredTarget.name,
      targetId: restoredTarget.id,
    })
    checkpoint()
    if (!exactObject(migrationResponse, ['migrations'])) failed()
    const migrations = migrationRows(migrationResponse.migrations)
    if (version >= 2
      && canonicalJson(migrations) !== canonicalJson(manifest.appliedMigrations)) failed()
    if (version >= 2) {
      const sentinelResponse = await input.runCommand({
        operation: 'sentinel', target: restoredTarget.name, targetId: restoredTarget.id,
        backupId: manifest.backupId,
      })
      checkpoint()
      if (!exactObject(sentinelResponse, ['sentinel'])
        || canonicalJson(sentinelResponse.sentinel)
          !== canonicalJson(manifest.restoreSentinel)) failed()
    }
    if (version === 3) {
      const recoveryResponse = await input.runCommand({
        operation: 'recovery', target: restoredTarget.name, targetId: restoredTarget.id,
      })
      checkpoint()
      if (!exactObject(recoveryResponse, ['appliedMigrations', 'recoveryFacts'])) failed()
      const recoveryMigrations = migrationRows(recoveryResponse.appliedMigrations)
      if (canonicalJson(recoveryMigrations) !== canonicalJson(manifest.appliedMigrations)
        || canonicalJson(recoveryResponse.recoveryFacts)
          !== canonicalJson(manifest.recoveryFacts)) failed()
    }
    const migrationSetSha256 = await sha256(migrations)
    const result = restoreResult({
      manifest,
      migrations,
      migrationSetSha256,
      recoveryKind: version === 3 ? manifest.recoveryFacts.kind : null,
      target: restoredTarget.name,
      migrationsVerified: version >= 2,
      recoveryFactsVerified: version === 3,
      restoreSentinelVerified: version >= 2,
      sourceMarkedVerified: version >= 2,
    })
    await cleanupBeforeBoundary()
    checkpoint()
    if (version === 1) return result
    const verifiedAt = new Date().toISOString()
    if (!validInstant(verifiedAt)) failed()
    const markFacts = {
      backupId: manifest.backupId,
      localDay: manifest.localDay,
      localMonth: manifest.localMonth,
      retentionClass: manifest.retentionClass,
      createdAt: manifest.createdAt,
      exportBookmark: manifest.atBookmark,
      manifestKey: request.manifestKey,
      objectEtag: manifest.objectEtag,
      objectKey: manifest.objectKey,
      objectSize: manifest.objectSize,
      ssecKeyVersion: manifest.wrappedSsecKey.kekVersion,
      wrappedSsecKeyB64: manifest.wrappedSsecKey.ciphertext,
      wrapNonceB64: manifest.wrappedSsecKey.nonce,
      verifiedAt,
    }
    let marked
    try {
      marked = await input.provider.markRestoreVerified(markFacts)
    } catch {
      const observed = await input.provider.readSourceBackup({ backupId: manifest.backupId })
      if (!exactVerifiedSourceRow(observed, manifest, request.manifestKey, verifiedAt)) failed()
      marked = { updated: true }
    }
    if (!exactObject(marked, ['updated']) || marked.updated !== true) failed()
    return result
  } catch (error) {
    if (error?.message === 'RESTORE_REFUSED') throw error
    throw new Error('RESTORE_FAILED')
  } finally {
    if (rawSsecKey instanceof Uint8Array || temporaryDirectory !== null || !targetCleaned) {
      try { await cleanupBeforeBoundary() } catch { throw new Error('RESTORE_FAILED') }
    }
  }
}
