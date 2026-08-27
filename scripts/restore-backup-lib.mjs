import {
  chmod,
  mkdtemp,
  open,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  backupObjectKeys,
  expectedObjectMetadata,
  openBackupManifest,
  parseCanonicalManifest,
} from '../worker/operations/backup-format.js'

const TARGET = /^bearwithme-restore-[a-z0-9][a-z0-9-]{0,62}$/
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RESTORE_BINDING = 'RESTORE_TARGET'

const refused = () => { throw new Error('RESTORE_REFUSED') }
const failed = () => { throw new Error('RESTORE_FAILED') }
const exactObject = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))

const stringList = (value) => Array.isArray(value)
  && value.every((entry) => typeof entry === 'string' && entry.length > 0)

const recursiveValue = (value, key) => {
  if (!value || typeof value !== 'object') return null
  if (Object.hasOwn(value, key)) return value[key]
  for (const child of Object.values(value)) {
    const found = recursiveValue(child, key)
    if (found !== null) return found
  }
  return null
}

const recursiveValues = (value, key, result = []) => {
  if (!value || typeof value !== 'object') return result
  if (Object.hasOwn(value, key)) result.push(value[key])
  for (const child of Object.values(value)) recursiveValues(child, key, result)
  return result
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
    directory = await mkdtemp(join(input.tempRoot, 'bearwithme-restore-wrangler-'))
    await chmod(directory, 0o700)
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
    pinnedTarget = command.target
    pinnedTargetId = command.targetId
    return configPath
  }

  const runCommand = async (command) => {
    const importOperation = command?.operation === 'import'
    const keys = importOperation
      ? ['operation', 'target', 'targetId', 'filePath']
      : ['operation', 'target', 'targetId']
    if (!exactObject(command, keys)
      || !['import', 'migrations', 'sentinel'].includes(command.operation)
      || (importOperation && (typeof command.filePath !== 'string' || command.filePath.length === 0))) failed()
    const path = await ensureConfig(command)
    const common = [
      input.wranglerPath,
      'd1',
      'execute',
      RESTORE_BINDING,
      '--config',
      path,
      '--remote',
      '--json',
    ]
    let args
    if (command.operation === 'import') args = [...common, '--file', command.filePath]
    else if (command.operation === 'migrations') {
      args = [...common, '--command', 'SELECT name FROM d1_migrations ORDER BY id']
    } else {
      args = [...common, '--command', "SELECT json_extract(value_json,'$.sentinel') AS sentinel FROM system_state WHERE key='restore.sentinel'"]
    }
    const child = await input.execute(args)
    if (!child || typeof child !== 'object' || typeof child.stdout !== 'string') failed()
    let parsed
    try { parsed = JSON.parse(child.stdout) } catch { failed() }
    if (command.operation === 'import') return { imported: true }
    if (command.operation === 'migrations') return { migrations: recursiveValues(parsed, 'name') }
    return { sentinel: recursiveValue(parsed, 'sentinel') }
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
  if (!exactObject(input, [
    'request',
    'sourceDatabaseNames',
    'sourceDatabaseIds',
    'productionDatabaseNames',
    'productionDatabaseIds',
  ]) || !exactObject(input.request, ['manifestKey', 'target', 'sentinel'])
    || !stringList(input.sourceDatabaseNames)
    || !stringList(input.sourceDatabaseIds)
    || !stringList(input.productionDatabaseNames)
    || !stringList(input.productionDatabaseIds)) refused()
  const { manifestKey, target, sentinel } = input.request
  if (typeof manifestKey !== 'string'
    || !/^backups\/v1\/\d{4}\/(?:0[1-9]|1[0-2])\/bkp_[A-Za-z0-9_-]+\.manifest\.json$/.test(manifestKey)
    || typeof target !== 'string' || !TARGET.test(target)
    || target === 'bearwithme-restore-'
    || typeof sentinel !== 'string' || !OPAQUE.test(sentinel)
    || input.sourceDatabaseNames.includes(target)
    || input.sourceDatabaseIds.includes(target)
    || input.productionDatabaseNames.includes(target)
    || input.productionDatabaseIds.includes(target)) refused()
  return { manifestKey, target, sentinel }
}

function validateTarget(value, request, policy) {
  if (!exactObject(value, ['name', 'id', 'jurisdiction'])
    || value.name !== request.target
    || typeof value.id !== 'string' || !DATABASE_ID.test(value.id)
    || value.jurisdiction !== 'eu'
    || policy.sourceDatabaseNames.includes(value.name)
    || policy.sourceDatabaseIds.includes(value.id)
    || policy.productionDatabaseNames.includes(value.name)
    || policy.productionDatabaseIds.includes(value.id)) refused()
  return value
}

function validateHead(value, manifest) {
  if (!exactObject(value, ['etag', 'size', 'customMetadata'])
    || value.etag !== manifest.objectEtag
    || value.size !== manifest.objectSize
    || !exactObject(value.customMetadata, ['backupId', 'format', 'retentionClass'])) failed()
  const expected = expectedObjectMetadata(manifest)
  if (value.customMetadata.backupId !== expected.backupId
    || value.customMetadata.format !== expected.format
    || value.customMetadata.retentionClass !== expected.retentionClass) failed()
}

export async function writeRestoreStream(handle, stream, expectedSize) {
  if (!handle || typeof handle.write !== 'function'
    || !(stream instanceof ReadableStream)
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
        const bytesWritten = written?.bytesWritten
        if (!Number.isSafeInteger(bytesWritten)
          || bytesWritten <= 0 || bytesWritten > remaining) failed()
        offset += bytesWritten
        total += bytesWritten
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
  try {
    await writeRestoreStream(handle, stream, expectedSize)
  } finally {
    await handle.close()
  }
  return filePath
}

export async function restoreBackup(input) {
  const requiredKeys = [
    'request', 'sourceDatabaseNames', 'sourceDatabaseIds',
    'productionDatabaseNames', 'productionDatabaseIds', 'expectedMigrations',
    'tempRoot', 'keyring',
    'provider', 'runCommand', 'log',
  ]
  const inputKeys = input && typeof input === 'object' ? Reflect.ownKeys(input) : []
  const hasSignal = inputKeys.includes('signal')
  const keys = hasSignal ? [...requiredKeys, 'signal'] : requiredKeys
  if (!exactObject(input, keys)
    || typeof input.tempRoot !== 'string' || input.tempRoot.length === 0
    || !Array.isArray(input.expectedMigrations) || input.expectedMigrations.length === 0
    || new Set(input.expectedMigrations).size !== input.expectedMigrations.length
    || input.expectedMigrations.some((name) => (
      typeof name !== 'string' || !/^\d{4}_[a-z0-9_-]+\.sql$/.test(name)
    ))
    || !input.keyring || typeof input.keyring.getBackupKek !== 'function'
    || !input.provider || typeof input.provider.describeDatabase !== 'function'
    || typeof input.provider.getManifest !== 'function'
    || typeof input.provider.headObject !== 'function'
    || typeof input.provider.getObject !== 'function'
    || typeof input.runCommand !== 'function'
    || typeof input.log !== 'function'
    || (hasSignal && !(input.signal instanceof AbortSignal))) refused()
  const policy = {
    sourceDatabaseNames: input.sourceDatabaseNames,
    sourceDatabaseIds: input.sourceDatabaseIds,
    productionDatabaseNames: input.productionDatabaseNames,
    productionDatabaseIds: input.productionDatabaseIds,
  }
  const request = validateRestoreRequest({ request: input.request, ...policy })
  let temporaryDirectory = null
  let rawSsecKey
  const checkpoint = () => {
    if (input.signal?.aborted === true) failed()
  }
  try {
    checkpoint()
    const target = validateTarget(
      await input.provider.describeDatabase(request.target),
      request,
      policy,
    )
    checkpoint()
    const rawManifest = await input.provider.getManifest(request.manifestKey)
    checkpoint()
    if (!(rawManifest instanceof Uint8Array)) failed()
    const manifest = parseCanonicalManifest(rawManifest)
    const expectedKeys = backupObjectKeys({
      backupId: manifest.backupId,
      localMonth: manifest.localMonth,
    })
    if (expectedKeys.manifestKey !== request.manifestKey
      || expectedKeys.objectKey !== manifest.objectKey) failed()
    const opened = await openBackupManifest({ bytes: rawManifest, keyring: input.keyring })
    rawSsecKey = opened.rawSsecKey
    validateHead(await input.provider.headObject({
      key: manifest.objectKey,
      ssecKey: rawSsecKey,
    }), manifest)
    checkpoint()
    const body = await input.provider.getObject({
      key: manifest.objectKey,
      ssecKey: rawSsecKey,
    })
    checkpoint()
    temporaryDirectory = await mkdtemp(join(input.tempRoot, 'bearwithme-restore-'))
    await chmod(temporaryDirectory, 0o700)
    const filePath = await writeStream0600(
      temporaryDirectory,
      body,
      manifest.objectSize,
    )
    const imported = await input.runCommand({
      operation: 'import',
      target: target.name,
      targetId: target.id,
      filePath,
    })
    checkpoint()
    if (!exactObject(imported, ['imported']) || imported.imported !== true) failed()
    const migrations = await input.runCommand({
      operation: 'migrations',
      target: target.name,
      targetId: target.id,
    })
    checkpoint()
    if (!exactObject(migrations, ['migrations'])
      || !Array.isArray(migrations.migrations)
      || migrations.migrations.length !== input.expectedMigrations.length
      || migrations.migrations.some((name, index) => name !== input.expectedMigrations[index])) failed()
    const sentinel = await input.runCommand({
      operation: 'sentinel',
      target: target.name,
      targetId: target.id,
    })
    checkpoint()
    if (!exactObject(sentinel, ['sentinel']) || sentinel.sentinel !== request.sentinel) failed()
    const result = {
      backupId: manifest.backupId,
      migrationCount: migrations.migrations.length,
      status: 'restore_verified',
      target: target.name,
    }
    await input.log({ ...result })
    return result
  } catch (error) {
    if (error?.message === 'RESTORE_REFUSED') throw error
    throw new Error('RESTORE_FAILED')
  } finally {
    if (rawSsecKey instanceof Uint8Array) rawSsecKey.fill(0)
    if (temporaryDirectory !== null) {
      try {
        await rm(temporaryDirectory, { recursive: true, force: true })
      } catch {
        throw new Error('RESTORE_FAILED')
      }
    }
  }
}
