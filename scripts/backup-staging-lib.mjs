import {
  backupObjectKeys,
  canonicalJson,
  createBackupManifest,
  expectedObjectMetadata,
  openBackupManifest,
} from '../worker/operations/backup-format.js'
import { partsInWarsaw } from '../worker/operations/clock.js'
import { chmod, lstat, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'

const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const ACCOUNT_ID = /^[0-9a-f]{32}$/
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MIGRATION_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/
const MIGRATION_NAME_MAX_BYTES = 255
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const LEASE_MS = 12 * 60 * 1000
const LEASE_KEY = 'backup.demand.lease.v1'
const WRANGLER_OUTPUT_MAX_BYTES = 1024 * 1024
const SQL_MAX_BYTES = 64 * 1024
const MULTIPART_PART_BYTES = 8 * 1024 * 1024
const PROVIDER_REQUEST_MS = 60 * 1000
const LOCAL_DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
const LOCAL_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const HOST_BACKUP_FAILURE_CODES = new Set([
  'BACKUP_CREATE_FAILED',
  'BACKUP_FINALIZE_UNCERTAIN',
  'BACKUP_MIGRATION_SET_CHANGED',
  'BACKUP_OPERATOR_LEASE_EXPIRED',
  'BACKUP_OPERATOR_LEASE_LOST',
  'BACKUP_ORPHAN_CLEANUP_FAILED',
])
const BACKUP_DTO_KEYS = Object.freeze([
  'id', 'status', 'version', 'localDay', 'localMonth', 'retentionClass',
  'objectKey', 'manifestKey', 'objectEtag', 'objectSize', 'completedAt',
  'lastErrorCode', 'createdAt',
])

const refused = (code = 'BACKUP_STAGING_REFUSED') => { throw new Error(code) }
const failed = (code = 'BACKUP_STAGING_FAILED') => { throw new Error(code) }
const ownObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exactObject = (value, keys) => ownObject(value)
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const instant = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) failed()
  const result = new Date(value).toISOString()
  if (!validInstant(result)) failed()
  return result
}

function oneBinding(value, binding) {
  if (!Array.isArray(value) || value.length !== 1 || !ownObject(value[0])
    || value[0].binding !== binding) refused()
  return value[0]
}

export function validateStagingBackupConfig(input) {
  if (!exactObject(input, ['config', 'environment']) || !ownObject(input.config)
    || input.environment === null || typeof input.environment !== 'object') refused()
  const environment = input.environment
  if (environment.APP_ENV !== 'staging' || environment.DATA_MODE !== 'fictional'
    || environment.CLOUDFLARE_ENV === 'production'
    || Object.hasOwn(environment, 'BWM_CONFIRM_PRODUCTION_DATABASE')) refused()
  const staging = input.config.env?.staging
  const production = input.config.env?.production
  if (!ownObject(staging) || !ownObject(staging.vars) || !ownObject(production)) refused()
  const database = oneBinding(staging.d1_databases, 'DB')
  const archive = oneBinding(staging.r2_buckets, 'ARCHIVE')
  const productionDatabase = oneBinding(production.d1_databases, 'DB')
  const productionArchive = oneBinding(production.r2_buckets, 'ARCHIVE')
  const accountId = staging.vars.CF_ACCOUNT_ID
  const databaseId = staging.vars.CF_D1_DATABASE_ID
  const activeBackupKekVersion = Number(staging.vars.ACTIVE_BACKUP_KEK_VERSION)
  if (staging.vars.APP_ENV !== 'staging' || staging.vars.DATA_MODE !== 'fictional'
    || !ACCOUNT_ID.test(accountId) || !DATABASE_ID.test(databaseId)
    || database.database_id !== databaseId
    || typeof database.database_name !== 'string' || database.database_name.length === 0
    || archive.jurisdiction !== 'eu' || typeof archive.bucket_name !== 'string' || archive.bucket_name.length === 0
    || !positiveInteger(activeBackupKekVersion)
    || database.database_id === productionDatabase.database_id
    || database.database_name === productionDatabase.database_name
    || archive.bucket_name === productionArchive.bucket_name) refused()
  return Object.freeze({
    source: Object.freeze({ accountId, appEnv: 'staging', dataMode: 'fictional', databaseId }),
    database: Object.freeze({ id: databaseId, name: database.database_name }),
    archive: Object.freeze({ bucket: archive.bucket_name, jurisdiction: 'eu' }),
    activeBackupKekVersion,
    productionDatabaseNames: Object.freeze([productionDatabase.database_name]),
    productionDatabaseIds: Object.freeze([productionDatabase.database_id]),
  })
}

function migrationRows(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) failed()
  const migrations = []
  const names = new Set()
  let previous = 0
  for (const row of value) {
    let encodedName
    try {
      if (!exactObject(row, ['id', 'name']) || !positiveInteger(row.id) || row.id <= previous
        || typeof row.name !== 'string' || !MIGRATION_NAME.test(row.name) || names.has(row.name)) failed()
      encodedName = new TextEncoder().encode(row.name)
      if (encodedName.byteLength > MIGRATION_NAME_MAX_BYTES) failed()
    } finally {
      encodedName?.fill(0)
    }
    previous = row.id
    names.add(row.name)
    migrations.push({ id: row.id, name: row.name })
  }
  return migrations
}

async function digestMigrations(migrations) {
  const encoded = new TextEncoder().encode(canonicalJson(migrations))
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
    try { return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('') } finally { digest.fill(0) }
  } finally { encoded.fill(0) }
}

export async function migrationEvidence(value) {
  try {
    const migrations = migrationRows(value)
    return {
      migrations,
      migrationCount: migrations.length,
      migrationSetSha256: await digestMigrations(migrations),
    }
  } catch {
    throw new Error('BACKUP_STAGING_FAILED')
  }
}

function sourceValue(value) {
  if (!exactObject(value, ['accountId', 'appEnv', 'dataMode', 'databaseId'])
    || !ACCOUNT_ID.test(value.accountId) || value.appEnv !== 'staging'
    || value.dataMode !== 'fictional' || !DATABASE_ID.test(value.databaseId)) refused()
  return value
}

function leaseValue(value, backupId, owner) {
  if (!exactObject(value, ['backupId', 'owner', 'version']) || value.backupId !== backupId
    || value.owner !== owner || !positiveInteger(value.version)) failed('BACKUP_OPERATOR_LEASE_LOST')
  return value
}

async function renew(input, lease, phase) {
  const nowMs = input.now()
  const next = await input.store.renewLease({
    backupId: lease.backupId,
    owner: lease.owner,
    version: lease.version,
    phase,
    now: instant(nowMs),
    leaseExpiresAt: instant(nowMs + LEASE_MS),
  })
  return leaseValue(next, lease.backupId, lease.owner)
}

async function reread(input, lease) {
  const observed = await input.store.rereadLease({ backupId: lease.backupId, owner: lease.owner })
  return leaseValue(observed, lease.backupId, lease.owner)
}

async function cleanupArtifacts(input, lease, keys) {
  const cleanupSignal = () => AbortSignal.timeout(PROVIDER_REQUEST_MS)
  lease = await renew(input, lease, 'cleanup')
  try {
    await input.archive.abortMultipart({ key: keys.objectKey, signal: cleanupSignal() })
  } catch {
    // Deletion and absence checks remain the cleanup authority.
  }
  lease = await reread(input, lease)
  lease = await renew(input, lease, 'cleanup')
  await input.archive.deleteObject({ key: keys.manifestKey, signal: cleanupSignal() })
  lease = await reread(input, lease)
  lease = await renew(input, lease, 'cleanup')
  await input.archive.deleteObject({ key: keys.objectKey, signal: cleanupSignal() })
  lease = await reread(input, lease)
  const manifestAbsent = await input.archive.objectAbsent({ key: keys.manifestKey, signal: cleanupSignal() })
  lease = await reread(input, lease)
  const sqlAbsent = await input.archive.objectAbsent({ key: keys.objectKey, signal: cleanupSignal() })
  lease = await reread(input, lease)
  if (manifestAbsent !== true || sqlAbsent !== true) failed('BACKUP_ORPHAN_CLEANUP_FAILED')
  return lease
}

function expiryFor(localDay, retentionClass) {
  const [year, month, day] = localDay.split('-').map(Number)
  if (retentionClass === 'daily') return instant(Date.UTC(year, month - 1, day + 35))
  const targetMonth = month - 1 + 12
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate()
  return instant(Date.UTC(year, targetMonth, Math.min(day, lastDay)))
}

function stableFailure(error) {
  const value = error?.message
  return HOST_BACKUP_FAILURE_CODES.has(value) ? value : 'BACKUP_CREATE_FAILED'
}

function validateCreateInput(input) {
  const keys = [
    'source', 'store', 'archive', 'keyring', 'now', 'backupIdFactory',
    'leaseOwnerFactory', 'nonceFactory', 'rawKeyFactory', 'pollExport',
    'downloadExport', 'signal',
  ]
  if (!exactObject(input, keys)) refused()
  sourceValue(input.source)
  const storeMethods = [
    'acquireLease', 'readDayFacts', 'insertQueued', 'markExporting', 'readMigrations',
    'renewLease', 'rereadLease', 'markStored', 'readBackup', 'markFailed',
    'markStaleFailed', 'releaseLease',
  ]
  const archiveMethods = ['putSql', 'putManifest', 'headSql', 'headManifest', 'deleteObject', 'objectAbsent', 'abortMultipart']
  if (!storeMethods.every((name) => typeof input.store?.[name] === 'function')
    || !archiveMethods.every((name) => typeof input.archive?.[name] === 'function')
    || typeof input.keyring?.getBackupKek !== 'function'
    || !positiveInteger(input.keyring.activeBackupKekVersion)
    || !['now', 'backupIdFactory', 'leaseOwnerFactory', 'nonceFactory', 'rawKeyFactory', 'pollExport', 'downloadExport']
      .every((name) => typeof input[name] === 'function')
    || !(input.signal instanceof AbortSignal)) refused()
  return input
}

function exactPendingBackup(value, expected) {
  return exactObject(value, BACKUP_DTO_KEYS)
    && value.id === expected.backupId
    && value.status === expected.status
    && value.version === expected.version
    && value.localDay === expected.localDay
    && value.localMonth === expected.localMonth
    && value.retentionClass === expected.retentionClass
    && value.createdAt === expected.createdAt
    && ['objectKey', 'manifestKey', 'objectEtag', 'objectSize', 'completedAt', 'lastErrorCode']
      .every((key) => value[key] === null)
}

function exactStoredBackup(value, expected) {
  return exactObject(value, BACKUP_DTO_KEYS)
    && value.id === expected.backupId
    && value.status === 'stored'
    && value.version === 3
    && value.localDay === expected.localDay
    && value.localMonth === expected.localMonth
    && value.retentionClass === expected.retentionClass
    && value.objectKey === expected.objectKey
    && value.manifestKey === expected.manifestKey
    && value.objectEtag === expected.objectEtag
    && value.objectSize === expected.objectSize
    && value.completedAt === expected.completedAt
    && value.lastErrorCode === null
    && value.createdAt === expected.createdAt
}

export async function createStagingBackup(rawInput) {
  const input = validateCreateInput(rawInput)
  const backupId = input.backupIdFactory()
  const owner = input.leaseOwnerFactory()
  if (!BACKUP_ID.test(backupId) || !OPAQUE_ID.test(owner)) refused()
  const nowMs = input.now()
  const createdAt = instant(nowMs)
  const local = partsInWarsaw(nowMs)
  const localDay = local.day
  const localMonth = local.month
  let lease
  let exporting = null
  let keys = backupObjectKeys({ backupId, localMonth, version: 2 })
  let rawSsecKey
  let completed = false
  let rowCreated = false
  let pendingStatus = 'queued'
  let pendingVersion = 1
  let retentionClass = null
  let preserveCleanupLease = false
  try {
    const acquisition = await input.store.acquireLease({
      backupId,
      owner,
      now: createdAt,
      leaseExpiresAt: instant(nowMs + LEASE_MS),
    })
    if (!exactObject(acquisition, ['backupId', 'owner', 'version', 'stale'])) failed()
    lease = leaseValue({
      backupId: acquisition.backupId,
      owner: acquisition.owner,
      version: acquisition.version,
    }, backupId, owner)
    if (acquisition.stale !== null) {
      if (!exactObject(acquisition.stale, ['backupId', 'localMonth'])
        || !BACKUP_ID.test(acquisition.stale.backupId)
        || typeof acquisition.stale.localMonth !== 'string') failed()
      try {
        for (const version of [2, 1]) {
          const staleKeys = backupObjectKeys({
            backupId: acquisition.stale.backupId,
            localMonth: acquisition.stale.localMonth,
            version,
          })
          lease = await cleanupArtifacts(input, lease, staleKeys)
        }
        await input.store.markStaleFailed({
          staleBackupId: acquisition.stale.backupId,
          failedAt: createdAt,
          lease,
          errorCode: 'BACKUP_OPERATOR_LEASE_EXPIRED',
        })
        lease = await renew(input, lease, 'creating')
      } catch {
        try { lease = await reread(input, lease) } catch {}
        try {
          await input.store.markStaleFailed({
            staleBackupId: acquisition.stale.backupId,
            failedAt: createdAt,
            lease,
            errorCode: 'BACKUP_ORPHAN_CLEANUP_FAILED',
          })
        } catch {}
        preserveCleanupLease = true
        failed('BACKUP_ORPHAN_CLEANUP_FAILED')
      }
    }
    const dayFacts = await input.store.readDayFacts({ localDay, localMonth, lease })
    if (!exactObject(dayFacts, ['liveDayCount', 'liveMonthlyCount', 'storedMonthlyCount'])
      || ![dayFacts.liveDayCount, dayFacts.liveMonthlyCount, dayFacts.storedMonthlyCount]
        .every((value) => Number.isSafeInteger(value) && value >= 0)) failed()
    if (dayFacts.liveDayCount !== 0) {
      await input.store.releaseLease({ lease, now: createdAt })
      lease = null
      refused('LIVE_BACKUP_EXISTS')
    }
    retentionClass = dayFacts.liveMonthlyCount === 0 && dayFacts.storedMonthlyCount === 0
      ? 'monthly'
      : 'daily'
    try {
      await input.store.insertQueued({ backupId, localDay, localMonth, retentionClass, createdAt, lease })
      rowCreated = true
    } catch (insertError) {
      let observed = null
      try { observed = await input.store.readBackup({ backupId }) } catch {}
      const ownQueued = exactPendingBackup(observed, {
        backupId, localDay, localMonth, retentionClass, createdAt, status: 'queued', version: 1,
      })
      if (!ownQueued) {
        const racedFacts = await input.store.readDayFacts({ localDay, localMonth, lease })
        if (exactObject(racedFacts, ['liveDayCount', 'liveMonthlyCount', 'storedMonthlyCount'])
          && Number.isSafeInteger(racedFacts.liveDayCount) && racedFacts.liveDayCount > 0) {
          await input.store.releaseLease({ lease, now: createdAt })
          lease = null
          refused('LIVE_BACKUP_EXISTS')
        }
        throw insertError
      }
      rowCreated = true
    }
    try {
      exporting = await input.store.markExporting({ backupId, startedAt: createdAt, lease })
    } catch (exportingError) {
      let observed = null
      try { observed = await input.store.readBackup({ backupId }) } catch {}
      if (!exactPendingBackup(observed, {
        backupId, localDay, localMonth, retentionClass, createdAt, status: 'exporting', version: 2,
      })) throw exportingError
      exporting = {
        id: observed.id,
        localDay: observed.localDay,
        localMonth: observed.localMonth,
        retentionClass: observed.retentionClass,
        status: observed.status,
        version: observed.version,
        createdAt: observed.createdAt,
      }
    }
    if (!exactObject(exporting, ['id', 'localDay', 'localMonth', 'retentionClass', 'status', 'version', 'createdAt'])
      || exporting.id !== backupId || exporting.localDay !== localDay || exporting.localMonth !== localMonth
      || exporting.retentionClass !== retentionClass || exporting.status !== 'exporting'
      || exporting.version !== 2 || exporting.createdAt !== createdAt) failed()
    pendingStatus = 'exporting'
    pendingVersion = 2
    const before = await migrationEvidence(await input.store.readMigrations())
    lease = await renew(input, lease, 'creating')
    const exported = await input.pollExport({ source: input.source, signal: input.signal })
    if (!exactObject(exported, ['atBookmark', 'downloadUrl'])
      || typeof exported.atBookmark !== 'string' || exported.atBookmark.length === 0
      || typeof exported.downloadUrl !== 'string' || exported.downloadUrl.length === 0) failed()
    const after = await migrationEvidence(await input.store.readMigrations())
    lease = await renew(input, lease, 'creating')
    if (before.migrationSetSha256 !== after.migrationSetSha256
      || canonicalJson(before.migrations) !== canonicalJson(after.migrations)) {
      failed('BACKUP_MIGRATION_SET_CHANGED')
    }
    const downloaded = await input.downloadExport({ downloadUrl: exported.downloadUrl, signal: input.signal })
    if (!exactObject(downloaded, ['body']) || !(downloaded.body instanceof ReadableStream)) failed()
    rawSsecKey = input.rawKeyFactory()
    if (!(rawSsecKey instanceof Uint8Array) || rawSsecKey.byteLength !== 32) failed()
    const metadata = {
      backupId,
      format: 'bwm-d1-sql-v2',
      retentionClass,
      sourceAppEnv: input.source.appEnv,
      sourceDatabaseId: input.source.databaseId,
    }
    lease = await renew(input, lease, 'creating')
    const stored = await input.archive.putSql({
      key: keys.objectKey,
      body: downloaded.body,
      ssecKey: rawSsecKey,
      customMetadata: metadata,
      signal: input.signal,
      checkpoint: async () => {
        lease = await renew(input, lease, 'creating')
        lease = await reread(input, lease)
      },
    })
    lease = await reread(input, lease)
    if (!exactObject(stored, ['etag', 'size']) || typeof stored.etag !== 'string'
      || stored.etag.length === 0 || !Number.isSafeInteger(stored.size) || stored.size < 0) failed()
    const manifestResult = await createBackupManifest({
      facts: {
        format: 'bwm-d1-sql-v2',
        backupId,
        createdAt,
        localDay,
        localMonth,
        retentionClass,
        source: input.source,
        appliedMigrations: before.migrations,
        restoreSentinel: {
          kind: 'backup_run_v1', backupId, createdAt, localDay, localMonth,
          retentionClass, status: 'exporting', version: 2,
        },
        objectKey: keys.objectKey,
        objectEtag: stored.etag,
        objectSize: stored.size,
        atBookmark: exported.atBookmark,
      },
      rawSsecKey,
      keyring: input.keyring,
      nonceFactory: input.nonceFactory,
    })
    if (canonicalJson(expectedObjectMetadata(manifestResult.manifest)) !== canonicalJson(metadata)) failed()
    lease = await renew(input, lease, 'creating')
    const storedManifest = await input.archive.putManifest({ key: keys.manifestKey, bytes: manifestResult.bytes, signal: input.signal })
    lease = await reread(input, lease)
    if (!exactObject(storedManifest, ['etag', 'size']) || typeof storedManifest.etag !== 'string'
      || storedManifest.etag.length === 0 || storedManifest.size !== manifestResult.bytes.byteLength) failed()
    const sqlHead = await input.archive.headSql({ key: keys.objectKey, ssecKey: rawSsecKey, signal: input.signal })
    lease = await reread(input, lease)
    const manifestHead = await input.archive.headManifest({ key: keys.manifestKey, bytes: manifestResult.bytes, signal: input.signal })
    lease = await reread(input, lease)
    if (!exactObject(sqlHead, ['etag', 'size', 'customMetadata'])
      || sqlHead.etag !== stored.etag || sqlHead.size !== stored.size
      || !exactObject(sqlHead.customMetadata, Object.keys(metadata))
      || canonicalJson(sqlHead.customMetadata) !== canonicalJson(metadata)
      || !exactObject(manifestHead, ['etag', 'size'])
      || manifestHead.etag !== storedManifest.etag
      || manifestHead.size !== manifestResult.bytes.byteLength) failed()
    lease = await renew(input, lease, 'creating')
    const storedFacts = {
      backupId,
      bookmark: exported.atBookmark,
      completedAt: instant(input.now()),
      expiresAt: expiryFor(localDay, retentionClass),
      keys,
      objectEtag: stored.etag,
      objectSize: stored.size,
      databaseFields: manifestResult.databaseFields,
      lease,
    }
    let finalized
    try {
      finalized = await input.store.markStored(storedFacts)
    } catch {
      const observed = await input.store.readBackup({ backupId })
      if (exactStoredBackup(observed, {
        backupId,
        localDay,
        localMonth,
        retentionClass,
        objectKey: keys.objectKey,
        manifestKey: keys.manifestKey,
        objectEtag: stored.etag,
        objectSize: stored.size,
        completedAt: storedFacts.completedAt,
        createdAt,
      })) {
        finalized = { status: 'stored', version: 3 }
      } else {
        throw new Error('BACKUP_FINALIZE_UNCERTAIN')
      }
    }
    if (!exactObject(finalized, ['status', 'version']) || finalized.status !== 'stored' || finalized.version !== 3) failed()
    completed = true
    try { await input.store.releaseLease({ lease, now: instant(input.now()) }) } catch {
      // The stored row and authenticated artifacts are authoritative. An uncertain
      // lease release is reclaimed later without deleting a completed backup.
    }
    lease = null
    return {
      backupId,
      completedAt: storedFacts.completedAt,
      manifestKey: keys.manifestKey,
      migrationCount: before.migrationCount,
      migrationSetSha256: before.migrationSetSha256,
      objectEtag: stored.etag,
      objectSize: stored.size,
      restoreVerified: false,
      retentionClass,
      status: 'stored',
    }
  } catch (error) {
    const code = stableFailure(error)
    if (lease && rowCreated && !completed) {
      let cleanupCode = code
      let cleanupProven = false
      try {
        lease = await cleanupArtifacts(input, lease, keys)
        cleanupProven = true
      } catch {
        cleanupCode = 'BACKUP_ORPHAN_CLEANUP_FAILED'
        preserveCleanupLease = true
        try { lease = await reread(input, lease) } catch {}
      }
      const failedAt = instant(input.now())
      const expectedFailedVersion = pendingVersion + 1
      let failedRowProven = false
      let failedRow = null
      try {
        failedRow = await input.store.markFailed({
          backupId,
          errorCode: cleanupCode,
          expectedStatus: pendingStatus,
          expectedVersion: pendingVersion,
          failedAt,
          lease,
        })
      } catch {}
      failedRowProven = exactObject(failedRow, ['status', 'version'])
        && failedRow.status === 'failed'
        && failedRow.version === expectedFailedVersion
      if (!failedRowProven) {
        let observed = null
        try { observed = await input.store.readBackup({ backupId }) } catch {}
        failedRowProven = exactObject(observed, BACKUP_DTO_KEYS)
          && observed.id === backupId
          && observed.status === 'failed'
          && observed.version === expectedFailedVersion
          && observed.localDay === localDay
          && observed.localMonth === localMonth
          && observed.retentionClass === retentionClass
          && observed.objectKey === null
          && observed.manifestKey === null
          && observed.objectEtag === null
          && observed.objectSize === null
          && observed.completedAt === null
          && observed.lastErrorCode === cleanupCode
          && observed.createdAt === createdAt
      }
      if (!failedRowProven) preserveCleanupLease = true
      if (cleanupProven && failedRowProven) {
        try { await input.store.releaseLease({ lease, now: instant(input.now()) }) } catch {}
        lease = null
      }
    } else if (lease && !completed) {
      if (!preserveCleanupLease) {
        try { await input.store.releaseLease({ lease, now: instant(input.now()) }) } catch {}
        lease = null
      }
    }
    if (['LIVE_BACKUP_EXISTS', 'BACKUP_OPERATOR_BUSY', 'BACKUP_STAGING_REFUSED'].includes(error?.message)) {
      throw new Error('BACKUP_STAGING_REFUSED')
    }
    throw new Error('BACKUP_STAGING_FAILED')
  } finally {
    if (rawSsecKey instanceof Uint8Array) rawSsecKey.fill(0)
  }
}

export async function stagingMigrationStatus(input) {
  if (!exactObject(input, ['store']) || typeof input.store?.readMigrations !== 'function') refused()
  const evidence = await migrationEvidence(await input.store.readMigrations())
  return {
    migrationCount: evidence.migrationCount,
    migrationSetSha256: evidence.migrationSetSha256,
    status: 'ok',
  }
}

export async function statusStagingBackup(input) {
  if (!exactObject(input, ['backupId', 'store', 'getManifest', 'keyring', 'source']) || !BACKUP_ID.test(input.backupId)
    || typeof input.store?.readBackup !== 'function' || typeof input.getManifest !== 'function'
    || typeof input.keyring?.getBackupKek !== 'function') refused()
  sourceValue(input.source)
  try {
    const row = await input.store.readBackup({ backupId: input.backupId })
    if (!exactObject(row, BACKUP_DTO_KEYS) || row.id !== input.backupId
      || !LOCAL_DAY.test(row.localDay) || !LOCAL_MONTH.test(row.localMonth)
      || row.localMonth !== row.localDay.slice(0, 7)
      || !['daily', 'monthly'].includes(row.retentionClass)
      || !validInstant(row.createdAt) || !positiveInteger(row.version)) failed()
    if (row.status === 'failed') {
      if (!HOST_BACKUP_FAILURE_CODES.has(row.lastErrorCode)) failed()
      return {
        backupId: row.id,
        cleanupRequired: row.lastErrorCode === 'BACKUP_ORPHAN_CLEANUP_FAILED',
        errorCode: row.lastErrorCode,
        status: 'failed',
      }
    }
    if (!['stored', 'restore_verified'].includes(row.status)
      || row.lastErrorCode !== null || !validInstant(row.completedAt)
      || typeof row.objectEtag !== 'string' || row.objectEtag.length === 0
      || !Number.isSafeInteger(row.objectSize) || row.objectSize < 0) failed()
    const keys = backupObjectKeys({ backupId: row.id, localMonth: row.localMonth, version: 2 })
    if (row.objectKey !== keys.objectKey || row.manifestKey !== keys.manifestKey) failed()
    const bytes = await input.getManifest(keys.manifestKey)
    const opened = await openBackupManifest({ bytes, keyring: input.keyring })
    const manifest = opened.manifest
    try {
      if (manifest.format !== 'bwm-d1-sql-v2' || manifest.backupId !== row.id
        || manifest.createdAt !== row.createdAt || manifest.localDay !== row.localDay
        || manifest.localMonth !== row.localMonth || manifest.retentionClass !== row.retentionClass
        || manifest.objectKey !== row.objectKey || manifest.objectEtag !== row.objectEtag
        || manifest.objectSize !== row.objectSize
        || canonicalJson(manifest.source) !== canonicalJson(input.source)) failed()
      const evidence = await migrationEvidence(manifest.appliedMigrations)
      return {
        backupId: row.id,
        completedAt: row.completedAt,
        manifestKey: row.manifestKey,
        migrationCount: evidence.migrationCount,
        migrationSetSha256: evidence.migrationSetSha256,
        objectEtag: row.objectEtag,
        objectSize: row.objectSize,
        restoreVerified: row.status === 'restore_verified',
        retentionClass: row.retentionClass,
        status: row.status,
      }
    } finally {
      opened.rawSsecKey.fill(0)
    }
  } catch (error) {
    if (error?.message === 'BACKUP_STAGING_REFUSED') throw error
    throw new Error('BACKUP_STAGING_FAILED')
  }
}

function safeSqlText(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192
    || /[\0\r\n]/.test(value)) failed()
  return `'${value.replaceAll("'", "''")}'`
}

function scalarRow(row) {
  if (!ownObject(row)) failed()
  const copy = {}
  for (const [key, value] of Object.entries(row)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)
      || !(value === null || typeof value === 'string'
        || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) failed()
    copy[key] = value
  }
  return copy
}

function parseWranglerRows(stdout) {
  if (typeof stdout !== 'string'
    || new TextEncoder().encode(stdout).byteLength > WRANGLER_OUTPUT_MAX_BYTES) failed()
  let parsed
  try { parsed = JSON.parse(stdout) } catch { failed() }
  if (!Array.isArray(parsed) || parsed.length !== 1
    || !exactObject(parsed[0], ['results', 'success', 'meta'])
    || parsed[0].success !== true || !ownObject(parsed[0].meta)
    || !Array.isArray(parsed[0].results) || parsed[0].results.length > 257) failed()
  return parsed[0].results.map(scalarRow)
}

async function privateOperatorDirectory(root, prefix) {
  const rootStats = await lstat(root)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) failed()
  const directory = await mkdtemp(join(root, prefix))
  const before = await lstat(directory)
  if (!before.isDirectory() || before.isSymbolicLink()) failed()
  await chmod(directory, 0o700)
  const after = await stat(directory)
  if (!after.isDirectory() || (after.mode & 0o077) !== 0) failed()
  return directory
}

export function createPinnedSourceRunner(input) {
  if (!exactObject(input, ['tempRoot', 'wranglerPath', 'database', 'execute'])
    || typeof input.tempRoot !== 'string' || input.tempRoot.length === 0
    || typeof input.wranglerPath !== 'string' || input.wranglerPath.length === 0
    || !exactObject(input.database, ['id', 'name']) || !DATABASE_ID.test(input.database.id)
    || typeof input.database.name !== 'string' || input.database.name.length === 0
    || typeof input.execute !== 'function') refused()
  let directory = null
  let configPath = null

  const ensureConfig = async () => {
    if (configPath !== null) return configPath
    directory = await privateOperatorDirectory(input.tempRoot, 'bearwithme-backup-wrangler-')
    configPath = join(directory, 'wrangler.json')
    await writeFile(configPath, `${JSON.stringify({
      compatibility_date: '2026-08-27',
      d1_databases: [{ binding: 'BACKUP_SOURCE', database_id: input.database.id, database_name: input.database.name }],
      name: 'bearwithme-backup-operator',
    })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const file = await stat(configPath)
    if (!file.isFile() || (file.mode & 0o077) !== 0) failed()
    return configPath
  }

  const query = async (sql) => {
    if (typeof sql !== 'string' || sql !== sql.trim() || sql.length === 0
      || new TextEncoder().encode(sql).byteLength > SQL_MAX_BYTES || sql.includes('\0')) failed()
    const path = await ensureConfig()
    const args = [
      input.wranglerPath, 'd1', 'execute', 'BACKUP_SOURCE', '--config', path,
      '--remote', '--json', '--x-provision=false', '--x-auto-create=false',
      '--install-skills=false', '--command', sql,
    ]
    let child
    try { child = await input.execute(args) } catch { failed() }
    if (!ownObject(child) || typeof child.stdout !== 'string') failed()
    return parseWranglerRows(child.stdout)
  }

  const cleanup = async () => {
    if (directory === null) return
    const owned = directory
    directory = null
    configPath = null
    try { await rm(owned, { recursive: true, force: true }) } catch { failed() }
  }
  return Object.freeze({ query, cleanup })
}

const idleLease = Object.freeze({ backupId: null, leaseExpiresAt: null, leaseOwner: null, phase: 'idle' })
const leaseJson = (value) => canonicalJson(value)

function parseLeaseRow(rows) {
  if (!Array.isArray(rows) || rows.length !== 1
    || !exactObject(rows[0], ['key', 'value_json', 'version', 'updated_at'])
    || rows[0].key !== LEASE_KEY || !positiveInteger(rows[0].version)
    || !validInstant(rows[0].updated_at) || typeof rows[0].value_json !== 'string') failed()
  let value
  try { value = JSON.parse(rows[0].value_json) } catch { failed() }
  if (!exactObject(value, ['backupId', 'leaseExpiresAt', 'leaseOwner', 'phase'])
    || leaseJson(value) !== rows[0].value_json) failed()
  if (value.phase === 'idle') {
    if (value.backupId !== null || value.leaseExpiresAt !== null || value.leaseOwner !== null) failed()
  } else if (!['creating', 'cleanup'].includes(value.phase)
    || !BACKUP_ID.test(value.backupId) || !OPAQUE_ID.test(value.leaseOwner)
    || !validInstant(value.leaseExpiresAt)) failed()
  return { ...value, version: rows[0].version, updatedAt: rows[0].updated_at, valueJson: rows[0].value_json }
}

function parseReturning(rows, keys) {
  if (!Array.isArray(rows) || rows.length !== 1 || !exactObject(rows[0], keys)) failed('BACKUP_OPERATOR_LEASE_LOST')
  return rows[0]
}

function fenceSql(lease, now) {
  const value = leaseJson({
    backupId: lease.backupId,
    leaseExpiresAt: lease.leaseExpiresAt,
    leaseOwner: lease.owner,
    phase: lease.phase,
  })
  return `EXISTS (SELECT 1 FROM system_state WHERE key=${safeSqlText(LEASE_KEY)} AND version=${lease.version} AND value_json=${safeSqlText(value)} AND json_extract(value_json,'$.leaseExpiresAt')>${safeSqlText(now)})`
}

function leaseFromRow(row) {
  return {
    backupId: row.backupId,
    owner: row.leaseOwner,
    phase: row.phase,
    leaseExpiresAt: row.leaseExpiresAt,
    version: row.version,
  }
}

function backupDto(row) {
  if (!ownObject(row) || !BACKUP_ID.test(row.id)) failed()
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    localDay: row.local_day,
    localMonth: row.local_month,
    retentionClass: row.retention_class,
    objectKey: row.object_key,
    manifestKey: row.manifest_key,
    objectEtag: row.object_etag,
    objectSize: row.object_size,
    completedAt: row.completed_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
  }
}

export function createDemandBackupStore(input) {
  if (!exactObject(input, ['query']) || typeof input.query !== 'function') refused()
  const query = input.query
  const readLease = async () => {
    let rows = await query(`SELECT key,value_json,version,updated_at FROM system_state WHERE key=${safeSqlText(LEASE_KEY)}`)
    if (rows.length === 0) {
      try {
        await query(`INSERT INTO system_state (key,value_json,version,updated_at) VALUES (${safeSqlText(LEASE_KEY)},${safeSqlText(leaseJson(idleLease))},1,'1970-01-01T00:00:00.000Z') RETURNING key,value_json,version,updated_at`)
      } catch {
        // Exact reread resolves a concurrent initializer or identity-collision trigger.
      }
      rows = await query(`SELECT key,value_json,version,updated_at FROM system_state WHERE key=${safeSqlText(LEASE_KEY)}`)
    }
    return parseLeaseRow(rows)
  }
  const ownedFence = async (lease, now) => {
    const current = await readLease()
    if (current.backupId !== lease.backupId || current.leaseOwner !== lease.owner
      || current.version !== lease.version || current.leaseExpiresAt <= now) failed('BACKUP_OPERATOR_LEASE_LOST')
    return fenceSql(leaseFromRow(current), now)
  }
  const acquireLease = async ({ backupId, owner, now, leaseExpiresAt }) => {
    if (!BACKUP_ID.test(backupId) || !OPAQUE_ID.test(owner) || !validInstant(now) || !validInstant(leaseExpiresAt)) failed()
    const current = await readLease()
    if (current.phase !== 'idle' && current.leaseExpiresAt > now) refused('BACKUP_OPERATOR_BUSY')
    let stale = null
    if (current.phase !== 'idle') {
      const old = await query(`SELECT id,local_month,status,version,last_error_code FROM backup_runs WHERE id=${safeSqlText(current.backupId)}`)
      if (!Array.isArray(old) || old.length > 1) failed()
      if (old.length === 1) {
        if (!exactObject(old[0], ['id', 'local_month', 'status', 'version', 'last_error_code'])
          || old[0].id !== current.backupId || !LOCAL_MONTH.test(old[0].local_month)
          || !['queued', 'exporting', 'stored', 'failed', 'restore_verified', 'pruned'].includes(old[0].status)
          || !positiveInteger(old[0].version)
          || !(old[0].last_error_code === null || HOST_BACKUP_FAILURE_CODES.has(old[0].last_error_code))) failed()
        if (!['stored', 'restore_verified', 'pruned'].includes(old[0].status)) {
          stale = { backupId: old[0].id, localMonth: old[0].local_month }
        }
      }
    }
    const next = { backupId, leaseExpiresAt, leaseOwner: owner, phase: stale ? 'cleanup' : 'creating' }
    const rows = await query(`UPDATE system_state SET value_json=${safeSqlText(leaseJson(next))},version=version+1,updated_at=${safeSqlText(now)} WHERE key=${safeSqlText(LEASE_KEY)} AND version=${current.version} AND value_json=${safeSqlText(current.valueJson)} RETURNING key,value_json,version,updated_at`)
    const captured = parseLeaseRow(rows)
    if (captured.backupId !== backupId || captured.leaseOwner !== owner
      || captured.leaseExpiresAt !== leaseExpiresAt || captured.phase !== next.phase
      || captured.version !== current.version + 1 || captured.updatedAt !== now) {
      failed('BACKUP_OPERATOR_LEASE_LOST')
    }
    return { backupId, owner, version: captured.version, stale }
  }
  const renewLease = async ({ backupId, owner, version, phase, now, leaseExpiresAt }) => {
    const currentRows = await query(`SELECT key,value_json,version,updated_at FROM system_state WHERE key=${safeSqlText(LEASE_KEY)}`)
    const current = parseLeaseRow(currentRows)
    if (current.backupId !== backupId || current.leaseOwner !== owner || current.version !== version
      || current.leaseExpiresAt <= now || !['creating', 'cleanup'].includes(phase)) failed('BACKUP_OPERATOR_LEASE_LOST')
    const next = { backupId, leaseExpiresAt, leaseOwner: owner, phase }
    const rows = await query(`UPDATE system_state SET value_json=${safeSqlText(leaseJson(next))},version=version+1,updated_at=${safeSqlText(now)} WHERE key=${safeSqlText(LEASE_KEY)} AND version=${version} AND value_json=${safeSqlText(current.valueJson)} RETURNING key,value_json,version,updated_at`)
    const captured = parseLeaseRow(rows)
    if (captured.backupId !== backupId || captured.leaseOwner !== owner
      || captured.leaseExpiresAt !== leaseExpiresAt || captured.phase !== phase
      || captured.version !== version + 1 || captured.updatedAt !== now) {
      failed('BACKUP_OPERATOR_LEASE_LOST')
    }
    return { backupId, owner, version: captured.version }
  }
  const rereadLease = async ({ backupId, owner }) => {
    const current = await readLease()
    if (current.backupId !== backupId || current.leaseOwner !== owner) failed('BACKUP_OPERATOR_LEASE_LOST')
    return { backupId, owner, version: current.version }
  }
  const readDayFacts = async ({ localDay, localMonth }) => {
    const rows = await query(`SELECT EXISTS (SELECT 1 FROM backup_runs WHERE local_day=${safeSqlText(localDay)} AND status IN ('queued','exporting','stored','restore_verified')) AS live_day_count,EXISTS (SELECT 1 FROM backup_runs WHERE local_month=${safeSqlText(localMonth)} AND retention_class='monthly' AND status IN ('queued','exporting','stored','restore_verified')) AS live_monthly_count,EXISTS (SELECT 1 FROM backup_runs WHERE local_month=${safeSqlText(localMonth)} AND retention_class='monthly' AND status IN ('stored','restore_verified')) AS stored_monthly_count`)
    const row = parseReturning(rows, ['live_day_count', 'live_monthly_count', 'stored_monthly_count'])
    return { liveDayCount: row.live_day_count, liveMonthlyCount: row.live_monthly_count, storedMonthlyCount: row.stored_monthly_count }
  }
  const insertQueued = async ({ backupId, localDay, localMonth, retentionClass, createdAt, lease }) => {
    const fence = await ownedFence(lease, createdAt)
    const rows = await query(`INSERT INTO backup_runs (id,local_day,local_month,retention_class,status,version,created_at,updated_at) SELECT ${safeSqlText(backupId)},${safeSqlText(localDay)},${safeSqlText(localMonth)},${safeSqlText(retentionClass)},'queued',1,${safeSqlText(createdAt)},${safeSqlText(createdAt)} WHERE ${fence} RETURNING id,status,version`)
    return parseReturning(rows, ['id', 'status', 'version'])
  }
  const markExporting = async ({ backupId, startedAt, lease }) => {
    const fence = await ownedFence(lease, startedAt)
    const rows = await query(`UPDATE backup_runs SET status='exporting',version=2,started_at=${safeSqlText(startedAt)},updated_at=${safeSqlText(startedAt)} WHERE id=${safeSqlText(backupId)} AND status='queued' AND version=1 AND ${fence} RETURNING id,local_day,local_month,retention_class,status,version,created_at`)
    const row = parseReturning(rows, ['id', 'local_day', 'local_month', 'retention_class', 'status', 'version', 'created_at'])
    return { id: row.id, localDay: row.local_day, localMonth: row.local_month, retentionClass: row.retention_class, status: row.status, version: row.version, createdAt: row.created_at }
  }
  const readMigrations = async () => query('SELECT id,name FROM d1_migrations ORDER BY id LIMIT 257')
  const markStored = async (facts) => {
    const now = facts.completedAt
    const dbf = facts.databaseFields
    const fence = await ownedFence(facts.lease, now)
    const rows = await query(`UPDATE backup_runs SET status='stored',version=3,export_bookmark=${safeSqlText(facts.bookmark)},object_key=${safeSqlText(facts.keys.objectKey)},manifest_key=${safeSqlText(facts.keys.manifestKey)},ssec_key_version=${dbf.ssecKeyVersion},wrapped_ssec_key_b64=${safeSqlText(dbf.wrappedSsecKeyB64)},wrap_nonce_b64=${safeSqlText(dbf.wrapNonceB64)},object_etag=${safeSqlText(facts.objectEtag)},object_size=${facts.objectSize},completed_at=${safeSqlText(now)},expires_at=${safeSqlText(facts.expiresAt)},last_error_code=NULL,updated_at=${safeSqlText(now)} WHERE id=${safeSqlText(facts.backupId)} AND status='exporting' AND version=2 AND ${fence} RETURNING status,version`)
    return parseReturning(rows, ['status', 'version'])
  }
  const readBackup = async ({ backupId }) => {
    const rows = await query(`SELECT id,local_day,local_month,retention_class,status,version,object_key,manifest_key,object_etag,object_size,completed_at,last_error_code,created_at FROM backup_runs WHERE id=${safeSqlText(backupId)}`)
    return rows.length === 0 ? null : backupDto(parseReturning(rows, ['id', 'local_day', 'local_month', 'retention_class', 'status', 'version', 'object_key', 'manifest_key', 'object_etag', 'object_size', 'completed_at', 'last_error_code', 'created_at']))
  }
  const markFailed = async ({ backupId, errorCode, expectedStatus, expectedVersion, failedAt, lease }) => {
    if (!((expectedStatus === 'queued' && expectedVersion === 1)
      || (expectedStatus === 'exporting' && expectedVersion === 2))) failed()
    const fence = await ownedFence(lease, failedAt)
    const rows = await query(`UPDATE backup_runs SET status='failed',version=version+1,last_error_code=${safeSqlText(errorCode)},updated_at=${safeSqlText(failedAt)} WHERE id=${safeSqlText(backupId)} AND status=${safeSqlText(expectedStatus)} AND version=${expectedVersion} AND ${fence} RETURNING status,version`)
    return parseReturning(rows, ['status', 'version'])
  }
  const markStaleFailed = async ({ staleBackupId, failedAt, lease, errorCode }) => {
    const fence = await ownedFence(lease, failedAt)
    const rows = await query(`UPDATE backup_runs SET status='failed',version=version+1,last_error_code=${safeSqlText(errorCode)},updated_at=${safeSqlText(failedAt)} WHERE id=${safeSqlText(staleBackupId)} AND status IN ('queued','exporting','failed') AND ${fence} RETURNING status,version`)
    return parseReturning(rows, ['status', 'version'])
  }
  const releaseLease = async ({ lease, now }) => {
    const current = await readLease()
    if (current.backupId !== lease.backupId || current.leaseOwner !== lease.owner || current.version !== lease.version) failed('BACKUP_OPERATOR_LEASE_LOST')
    const rows = await query(`UPDATE system_state SET value_json=${safeSqlText(leaseJson(idleLease))},version=version+1,updated_at=${safeSqlText(now)} WHERE key=${safeSqlText(LEASE_KEY)} AND version=${lease.version} AND value_json=${safeSqlText(current.valueJson)} RETURNING key,value_json,version,updated_at`)
    const released = parseLeaseRow(rows)
    if (released.phase !== 'idle' || released.version !== lease.version + 1 || released.updatedAt !== now) {
      failed('BACKUP_OPERATOR_LEASE_LOST')
    }
    return { phase: released.phase }
  }
  const markRestoreVerified = async ({ backupId, manifestKey, objectEtag, objectKey, objectSize, verifiedAt }) => {
    const rows = await query(`UPDATE backup_runs SET status='restore_verified',version=4,restore_verified_at=${safeSqlText(verifiedAt)},updated_at=${safeSqlText(verifiedAt)} WHERE id=${safeSqlText(backupId)} AND status='stored' AND version=3 AND manifest_key=${safeSqlText(manifestKey)} AND object_key=${safeSqlText(objectKey)} AND object_etag=${safeSqlText(objectEtag)} AND object_size=${objectSize} RETURNING status,version`)
    const row = parseReturning(rows, ['status', 'version'])
    return { updated: row.status === 'restore_verified' && row.version === 4 }
  }
  return Object.freeze({
    acquireLease, readDayFacts, insertQueued, markExporting, readMigrations,
    renewLease, rereadLease, markStored, readBackup, markFailed, markStaleFailed,
    releaseLease, markRestoreVerified,
  })
}

function customerEncryption(ssecKey) {
  if (!(ssecKey instanceof Uint8Array) || ssecKey.byteLength !== 32) failed()
  return { SSECustomerAlgorithm: 'AES256', SSECustomerKey: Buffer.from(ssecKey).toString('base64') }
}

function normalizedEtag(value) {
  return typeof value === 'string' ? value.replace(/^"|"$/g, '') : null
}

function concatQueue(queue, length) {
  const result = new Uint8Array(length)
  let offset = 0
  while (offset < length) {
    const first = queue[0]
    const available = first.bytes.byteLength - first.offset
    const take = Math.min(available, length - offset)
    result.set(first.bytes.subarray(first.offset, first.offset + take), offset)
    first.offset += take
    offset += take
    if (first.offset === first.bytes.byteLength) {
      first.bytes.fill(0)
      queue.shift()
    }
  }
  return result
}

export function createS3BackupArchive(input) {
  if (!exactObject(input, ['client', 'bucket']) || typeof input.client?.send !== 'function'
    || typeof input.bucket !== 'string' || input.bucket.length === 0) refused()
  let activeMultipart = null
  const send = (command, signal) => input.client.send(command, {
    abortSignal: AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_REQUEST_MS)]),
  })
  const putSql = async ({ key, body, ssecKey, customMetadata, signal, checkpoint }) => {
    if (typeof key !== 'string' || !(body instanceof ReadableStream)
      || !exactObject(customMetadata, ['backupId', 'format', 'retentionClass', 'sourceAppEnv', 'sourceDatabaseId'])
      || !(signal instanceof AbortSignal) || typeof checkpoint !== 'function') failed()
    const encryption = customerEncryption(ssecKey)
    const metadata = Object.fromEntries(Object.entries(customMetadata).map(([name, value]) => [name.toLowerCase(), value]))
    const reader = body.getReader()
    const queue = []
    let pending = 0
    let total = 0
    let ended = false
    const fill = async () => {
      const part = await reader.read()
      if (part.done) { ended = true; return }
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) failed()
      queue.push({ bytes: part.value, offset: 0 })
      pending += part.value.byteLength
      total += part.value.byteLength
    }
    try {
      while (!ended && pending <= MULTIPART_PART_BYTES) await fill()
      if (ended && pending <= MULTIPART_PART_BYTES) {
        const payload = concatQueue(queue, pending)
        let response
        try {
          await checkpoint()
          response = await send(new PutObjectCommand({
            Bucket: input.bucket, Key: key, Body: payload, IfNoneMatch: '*', Metadata: metadata, ...encryption,
          }), signal)
        } finally {
          payload.fill(0)
        }
        const etag = normalizedEtag(response.ETag)
        if (!etag) failed()
        return { etag, size: total }
      }
      await checkpoint()
      const created = await send(new CreateMultipartUploadCommand({
        Bucket: input.bucket, Key: key, Metadata: metadata, ...encryption,
      }), signal)
      if (typeof created.UploadId !== 'string' || created.UploadId.length === 0) failed()
      activeMultipart = { key, uploadId: created.UploadId, encryption }
      const parts = []
      let partNumber = 1
      while (!ended || pending > 0) {
        while (!ended && pending < MULTIPART_PART_BYTES) await fill()
        const length = pending >= MULTIPART_PART_BYTES ? MULTIPART_PART_BYTES : pending
        if (length === 0) break
        const payload = concatQueue(queue, length)
        pending -= length
        let uploaded
        try {
          await checkpoint()
          uploaded = await send(new UploadPartCommand({
            Bucket: input.bucket, Key: key, UploadId: activeMultipart.uploadId,
            PartNumber: partNumber, Body: payload, ...encryption,
          }), signal)
        } finally {
          payload.fill(0)
        }
        const etag = normalizedEtag(uploaded.ETag)
        if (!etag) failed()
        parts.push({ ETag: uploaded.ETag, PartNumber: partNumber })
        partNumber += 1
        await checkpoint()
      }
      await checkpoint()
      const completed = await send(new CompleteMultipartUploadCommand({
        Bucket: input.bucket, Key: key, UploadId: activeMultipart.uploadId,
        MultipartUpload: { Parts: parts },
      }), signal)
      activeMultipart = null
      const etag = normalizedEtag(completed.ETag)
      if (!etag) failed()
      await checkpoint()
      return { etag, size: total }
    } catch (error) {
      if (activeMultipart) {
        const multipart = activeMultipart
        try {
          await send(new AbortMultipartUploadCommand({
            Bucket: input.bucket, Key: multipart.key, UploadId: multipart.uploadId,
          }), AbortSignal.timeout(PROVIDER_REQUEST_MS))
          if (activeMultipart === multipart) activeMultipart = null
        } catch {}
      }
      throw error
    } finally {
      for (const part of queue) part.bytes.fill(0)
      try { reader.releaseLock() } catch {}
    }
  }
  const putManifest = async ({ key, bytes, signal }) => {
    if (typeof key !== 'string' || !(bytes instanceof Uint8Array) || bytes.byteLength > 64 * 1024) failed()
    const response = await send(new PutObjectCommand({
      Bucket: input.bucket, Key: key, Body: bytes, IfNoneMatch: '*', ContentType: 'application/json',
    }), signal)
    const etag = normalizedEtag(response.ETag)
    if (!etag) failed()
    return { etag, size: bytes.byteLength }
  }
  const headSql = async ({ key, ssecKey, signal }) => {
    const response = await send(new HeadObjectCommand({ Bucket: input.bucket, Key: key, ...customerEncryption(ssecKey) }), signal)
    const metadataKeys = ['backupid', 'format', 'retentionclass', 'sourceappenv', 'sourcedatabaseid']
    if (!exactObject(response.Metadata, metadataKeys)) failed()
    return {
      etag: normalizedEtag(response.ETag),
      size: response.ContentLength,
      customMetadata: {
        backupId: response.Metadata.backupid,
        format: response.Metadata.format,
        retentionClass: response.Metadata.retentionclass,
        sourceAppEnv: response.Metadata.sourceappenv,
        sourceDatabaseId: response.Metadata.sourcedatabaseid,
      },
    }
  }
  const headManifest = async ({ key, signal }) => {
    const response = await send(new HeadObjectCommand({ Bucket: input.bucket, Key: key }), signal)
    return { etag: normalizedEtag(response.ETag), size: response.ContentLength }
  }
  const deleteObject = async ({ key, signal }) => { await send(new DeleteObjectCommand({ Bucket: input.bucket, Key: key }), signal) }
  const objectAbsent = async ({ key, signal }) => {
    try { await send(new HeadObjectCommand({ Bucket: input.bucket, Key: key }), signal); return false } catch (error) {
      return error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound'
    }
  }
  const abortMultipart = async ({ key, signal }) => {
    if (!activeMultipart || activeMultipart.key !== key) return
    await send(new AbortMultipartUploadCommand({
      Bucket: input.bucket, Key: key, UploadId: activeMultipart.uploadId,
    }), signal)
    activeMultipart = null
  }
  return Object.freeze({ putSql, putManifest, headSql, headManifest, deleteObject, objectAbsent, abortMultipart })
}
