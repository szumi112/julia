import { loadConfig } from '../config.js'
import { isD1IdentityCollision, isD1OutboxOperationGuardFailure } from '../db/errors.js'
import { dispatchOutboxJob as dispatchJob } from '../jobs/handlers.js'
import {
  decryptOutboxPayload,
  enqueueOutboxStatement as enqueueStatement,
  outboxStatementDescriptorFor,
  processOutboxBatch as processBatch,
} from '../jobs/outbox.js'
import { safeLog as writeSafeLog } from '../logging/safe-log.js'
import { decodeBase64Url } from '../security/encoding.js'
import { createKeyring as buildKeyring } from '../security/keyring.js'
import { backupDue as calculateBackupDue, partsInWarsaw } from './clock.js'

const IDENTITY_SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const SCHEDULER_LEASE_MS = 900_000
const ORDINARY_LIMIT = 10
const BACKUP_MAX_ATTEMPTS = 8
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SCHEDULER_ROW_KEYS = Object.freeze([
  'id',
  'scheduled_for',
  'started_at',
  'completed_at',
  'status',
  'attempt_count',
  'lease_owner',
  'lease_expires_at',
  'claimed_jobs',
  'succeeded_jobs',
  'failed_jobs',
  'error_code',
])
const DATA_KEY_ROW_KEYS = Object.freeze([
  'id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64',
  'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at',
])
const BACKUP_ROW_KEYS = Object.freeze([
  'id', 'local_day', 'local_month', 'retention_class', 'status', 'version',
  'export_bookmark', 'object_key', 'manifest_key', 'ssec_key_version',
  'wrapped_ssec_key_b64', 'wrap_nonce_b64', 'object_etag', 'object_size',
  'started_at', 'completed_at', 'expires_at', 'restore_verified_at',
  'last_error_code', 'created_at', 'updated_at',
])
const OUTBOX_ROW_KEYS = Object.freeze([
  'id', 'type', 'aggregate_type', 'aggregate_id', 'payload_envelope',
  'idempotency_key', 'status', 'attempt_count', 'max_attempts', 'scheduled_at',
  'lease_owner', 'lease_expires_at', 'last_error_code', 'created_at', 'updated_at',
])
const DEPENDENCY_FUNCTIONS = Object.freeze([
  'now',
  'createKeyring',
  'backupDue',
  'enqueueOutboxStatement',
  'processOutboxBatch',
  'dispatchOutboxJob',
  'safeLog',
  'idFactory',
  'backupIdFactory',
  'leaseOwnerFactory',
  'leaseNonceFactory',
  'correlationIdFactory',
])
const DEPENDENCY_KEYS = Object.freeze([
  ...DEPENDENCY_FUNCTIONS,
  'cryptoContext',
  'providers',
])

const invalid = () => { throw new Error('SCHEDULER_INVALID') }
const invalidState = () => { throw new Error('SCHEDULER_STATE_INVALID') }
const invalidBackupState = () => { throw new Error('BACKUP_STATE_INVALID') }
const ownObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const validOpaqueId = (value) => typeof value === 'string' && OPAQUE_ID.test(value)
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const validCount = (value) => Number.isSafeInteger(value) && value >= 0
const validEncodedLength = (value, length) => {
  let decoded
  try {
    decoded = decodeBase64Url(value)
    return decoded.byteLength === length
  } catch {
    return false
  } finally {
    decoded?.fill(0)
  }
}

const instantFromMs = (value, error = invalid) => {
  if (!Number.isSafeInteger(value) || value < 0) error()
  let instant
  try { instant = new Date(value).toISOString() } catch { error() }
  if (new Date(instant).getTime() !== value || !validInstant(instant)) error()
  return instant
}

const randomId = (prefix) => `${prefix}${crypto.randomUUID().replaceAll('-', '')}`

function validateInvocation(input) {
  try {
    if (!ownObject(input)) invalid()
    const inputKeys = Reflect.ownKeys(input)
    if (!Object.hasOwn(input, 'scheduledTime')
      || !Object.hasOwn(input, 'env')
      || inputKeys.some((key) => typeof key !== 'string'
        || !['scheduledTime', 'env', 'deps'].includes(key))) invalid()

    const scheduledTime = input.scheduledTime
    const env = input.env
    const rawDeps = Object.hasOwn(input, 'deps') ? input.deps : undefined
    if (!env || typeof env !== 'object') invalid()
    const db = env.DB
    if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function'
      || (rawDeps !== undefined && !ownObject(rawDeps))) invalid()

    const deps = {}
    if (rawDeps !== undefined) {
      const dependencyKeys = Reflect.ownKeys(rawDeps)
      if (dependencyKeys.some((key) => typeof key !== 'string'
        || !DEPENDENCY_KEYS.includes(key))) invalid()
      for (const key of dependencyKeys) deps[key] = rawDeps[key]
    }
    for (const key of DEPENDENCY_FUNCTIONS) {
      if (deps[key] !== undefined && typeof deps[key] !== 'function') invalid()
    }
    if (deps.cryptoContext !== undefined && !ownObject(deps.cryptoContext)) invalid()
    if (deps.providers !== undefined && !ownObject(deps.providers)) invalid()

    const scheduledFor = instantFromMs(scheduledTime)
    const config = loadConfig(env)
    return { scheduledTime, scheduledFor, env, db, deps, config }
  } catch {
    invalid()
  }
}

function dependencies(deps) {
  return {
    now: deps.now ?? Date.now,
    cryptoContext: deps.cryptoContext,
    createKeyring: deps.createKeyring ?? buildKeyring,
    backupDue: deps.backupDue ?? calculateBackupDue,
    enqueueOutboxStatement: deps.enqueueOutboxStatement ?? enqueueStatement,
    processOutboxBatch: deps.processOutboxBatch ?? processBatch,
    dispatchOutboxJob: deps.dispatchOutboxJob ?? dispatchJob,
    safeLog: deps.safeLog ?? writeSafeLog,
    providers: deps.providers ?? {},
    idFactory: deps.idFactory ?? (() => randomId('sch_')),
    backupIdFactory: deps.backupIdFactory ?? (() => randomId('bkp_')),
    leaseOwnerFactory: deps.leaseOwnerFactory ?? (() => randomId('lease_')),
    leaseNonceFactory: deps.leaseNonceFactory ?? (() => randomId('nonce_')),
    correlationIdFactory: deps.correlationIdFactory ?? (() => crypto.randomUUID()),
  }
}

const observation = (now) => {
  let value
  try { value = now() } catch { invalidState() }
  const instant = instantFromMs(value, invalidState)
  return { ms: value, instant }
}

const idFrom = (factory, pattern = OPAQUE_ID) => {
  let value
  try { value = factory() } catch { invalidState() }
  if (typeof value !== 'string' || !pattern.test(value)) invalidState()
  return value
}

function validateSchedulerRow(row) {
  if (!exactKeys(row, SCHEDULER_ROW_KEYS)
    || !validOpaqueId(row.id)
    || !validInstant(row.scheduled_for)
    || !validInstant(row.started_at)
    || !validOpaqueId(row.lease_owner)
    || !validInstant(row.lease_expires_at)
    || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 1
    || !validCount(row.claimed_jobs)
    || !validCount(row.succeeded_jobs)
    || !validCount(row.failed_jobs)
    || row.claimed_jobs > ORDINARY_LIMIT
    || row.succeeded_jobs + row.failed_jobs > row.claimed_jobs) invalidState()
  if (row.status === 'running') {
    if (row.completed_at !== null || row.error_code !== null) invalidState()
  } else if (row.status === 'succeeded') {
    if (!validInstant(row.completed_at) || row.error_code !== null) invalidState()
  } else if (row.status === 'failed') {
    if (!validInstant(row.completed_at)
      || row.error_code !== 'SCHEDULER_COORDINATOR_FAILED') invalidState()
  } else invalidState()
  return row
}

async function readSchedulerRow(db, scheduledFor) {
  const row = await db.prepare(
    `SELECT id,scheduled_for,started_at,completed_at,status,attempt_count,lease_owner,
            lease_expires_at,claimed_jobs,succeeded_jobs,failed_jobs,error_code
     FROM scheduler_runs WHERE scheduled_for=?`
  ).bind(scheduledFor).first()
  if (row === null) return null
  validateSchedulerRow(row)
  if (row.scheduled_for !== scheduledFor) invalidState()
  return row
}

const skipResult = (row, reason) => ({
  status: 'skipped',
  reason,
  runId: row.id,
  claimedJobs: 0,
  succeededJobs: 0,
  failedJobs: 0,
  backupEnqueued: false,
})

function collisionDecision(row, now) {
  if (row.status === 'succeeded') return { kind: 'skip', reason: 'already_succeeded' }
  if (row.status === 'running' && row.lease_expires_at > now) {
    return { kind: 'skip', reason: 'live_lease' }
  }
  if (row.status === 'failed'
    || (row.status === 'running' && row.lease_expires_at <= now)) return { kind: 'reclaim' }
  invalidState()
}

const operationGuard = (db, id, predicate, bindings) => db.prepare(
  `INSERT INTO outbox_operation_guard_failures (operation_id)
   SELECT ? WHERE NOT (${predicate})`
).bind(id, ...bindings)

async function reclaimOnce(db, row, scheduledFor, deps) {
  const current = observation(deps.now)
  const leaseOwner = idFrom(deps.leaseOwnerFactory)
  const leaseExpiresAt = instantFromMs(current.ms + SCHEDULER_LEASE_MS, invalidState)
  const nextAttempt = row.attempt_count + 1
  if (!Number.isSafeInteger(nextAttempt)) invalidState()
  const statements = [
    db.prepare(
      `UPDATE scheduler_runs
       SET started_at=?,completed_at=NULL,status='running',attempt_count=?,lease_owner=?,
           lease_expires_at=?,claimed_jobs=0,succeeded_jobs=0,failed_jobs=0,error_code=NULL
       WHERE id=? AND scheduled_for=? AND status=? AND attempt_count=? AND lease_owner=?
         AND lease_expires_at=? AND started_at=? AND completed_at IS ?
         AND claimed_jobs=? AND succeeded_jobs=? AND failed_jobs=? AND error_code IS ?`
    ).bind(
      current.instant,
      nextAttempt,
      leaseOwner,
      leaseExpiresAt,
      row.id,
      scheduledFor,
      row.status,
      row.attempt_count,
      row.lease_owner,
      row.lease_expires_at,
      row.started_at,
      row.completed_at,
      row.claimed_jobs,
      row.succeeded_jobs,
      row.failed_jobs,
      row.error_code,
    ),
    operationGuard(
      db,
      `scheduler_reclaim_${row.id}_${nextAttempt}`,
      `changes()=1 AND EXISTS (
         SELECT 1 FROM scheduler_runs
         WHERE id=? AND scheduled_for=? AND started_at=? AND completed_at IS NULL
           AND status='running' AND attempt_count=? AND lease_owner=? AND lease_expires_at=?
           AND claimed_jobs=0 AND succeeded_jobs=0 AND failed_jobs=0 AND error_code IS NULL
       )`,
      [row.id, scheduledFor, current.instant, nextAttempt, leaseOwner, leaseExpiresAt],
    ),
  ]
  try {
    await db.batch(statements)
  } catch (error) {
    if (isD1OutboxOperationGuardFailure(error)) return null
    throw error
  }
  const owned = await readSchedulerRow(db, scheduledFor)
  if (!owned
    || owned.id !== row.id
    || owned.status !== 'running'
    || owned.attempt_count !== nextAttempt
    || owned.lease_owner !== leaseOwner
    || owned.lease_expires_at !== leaseExpiresAt
    || owned.started_at !== current.instant
    || owned.completed_at !== null
    || owned.claimed_jobs !== 0
    || owned.succeeded_jobs !== 0
    || owned.failed_jobs !== 0
    || owned.error_code !== null) invalidState()
  return {
    runId: row.id,
    attemptCount: nextAttempt,
    leaseOwner,
    leaseExpiresAt,
  }
}

async function claimScheduler(validated, deps) {
  const current = observation(deps.now)
  const runId = idFrom(deps.idFactory)
  const leaseOwner = idFrom(deps.leaseOwnerFactory)
  const leaseExpiresAt = instantFromMs(current.ms + SCHEDULER_LEASE_MS, invalidState)
  try {
    await validated.db.prepare(
      `INSERT INTO scheduler_runs
       (id,scheduled_for,started_at,completed_at,status,attempt_count,lease_owner,
        lease_expires_at,claimed_jobs,succeeded_jobs,failed_jobs,error_code)
       VALUES (?,?,?,NULL,'running',1,?,?,0,0,0,NULL)`
    ).bind(
      runId,
      validated.scheduledFor,
      current.instant,
      leaseOwner,
      leaseExpiresAt,
    ).run()
    const row = await readSchedulerRow(validated.db, validated.scheduledFor)
    if (!row
      || row.id !== runId
      || row.status !== 'running'
      || row.attempt_count !== 1
      || row.lease_owner !== leaseOwner
      || row.lease_expires_at !== leaseExpiresAt
      || row.started_at !== current.instant
      || row.completed_at !== null
      || row.claimed_jobs !== 0
      || row.succeeded_jobs !== 0
      || row.failed_jobs !== 0
      || row.error_code !== null) invalidState()
    return { owned: { runId, attemptCount: 1, leaseOwner, leaseExpiresAt } }
  } catch (error) {
    if (!isD1IdentityCollision(error)) throw error
  }

  let row = await readSchedulerRow(validated.db, validated.scheduledFor)
  if (!row) invalidState()
  let decision = collisionDecision(row, observation(deps.now).instant)
  if (decision.kind === 'skip') return { skipped: skipResult(row, decision.reason), row }
  let owned = await reclaimOnce(validated.db, row, validated.scheduledFor, deps)
  if (owned) return { owned }

  row = await readSchedulerRow(validated.db, validated.scheduledFor)
  if (!row) invalidState()
  decision = collisionDecision(row, observation(deps.now).instant)
  if (decision.kind === 'skip') return { skipped: skipResult(row, decision.reason), row }
  owned = await reclaimOnce(validated.db, row, validated.scheduledFor, deps)
  if (owned) return { owned }
  invalidState()
}

async function ownershipCheckpoint(db, scheduledFor, owned, now) {
  const current = observation(now)
  const row = await readSchedulerRow(db, scheduledFor)
  if (!row
    || row.id !== owned.runId
    || row.status !== 'running'
    || row.attempt_count !== owned.attemptCount
    || row.lease_owner !== owned.leaseOwner
    || row.lease_expires_at !== owned.leaseExpiresAt
    || row.lease_expires_at <= current.instant) invalidState()
  return current
}

function validateDataKey(row) {
  if (!exactKeys(row, DATA_KEY_ROW_KEYS)
    || !validOpaqueId(row.id)
    || row.scope_type !== IDENTITY_SCOPE.type
    || row.scope_id !== IDENTITY_SCOPE.id
    || row.purpose !== IDENTITY_SCOPE.purpose
    || row.dek_version !== 1
    || !validEncodedLength(row.wrapped_key_b64, 48)
    || !validEncodedLength(row.wrap_nonce_b64, 12)
    || !Number.isSafeInteger(row.kek_version) || row.kek_version < 1
    || !validInstant(row.created_at)
    || row.retired_at !== null) invalidState()
  return row
}

async function identityCryptoContext(validated, deps) {
  if (deps.cryptoContext !== undefined) return deps.cryptoContext
  const keyring = await deps.createKeyring(validated.env, validated.config)
  if (!keyring || typeof keyring !== 'object' || typeof keyring.getDataKek !== 'function') invalidState()
  const dataKey = await validated.db.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
            kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1`
  ).bind(IDENTITY_SCOPE.type, IDENTITY_SCOPE.id, IDENTITY_SCOPE.purpose).first()
  if (!dataKey) invalidState()
  const activeDataKey = validateDataKey(dataKey)
  let kek
  try { kek = keyring.getDataKek(activeDataKey.kek_version) } catch { invalidState() }
  if (!kek) invalidState()
  return { keyring, dataKey: activeDataKey, scope: { ...IDENTITY_SCOPE } }
}

async function dueFacts(db, scheduledTime) {
  const local = partsInWarsaw(scheduledTime)
  const row = await db.prepare(
    `SELECT
       EXISTS (
         SELECT 1 FROM backup_runs
         WHERE local_day=?
           AND status IN ('queued','exporting','stored','restore_verified')
       ) AS has_live_day,
       EXISTS (
         SELECT 1 FROM backup_runs
         WHERE local_month=? AND retention_class='monthly'
           AND status IN ('queued','exporting','stored','restore_verified')
       ) AS has_live_monthly,
       EXISTS (
         SELECT 1 FROM backup_runs
         WHERE local_month=? AND retention_class='monthly'
           AND status IN ('stored','restore_verified')
       ) AS has_stored_monthly`
  ).bind(local.day, local.month, local.month).first()
  if (!exactKeys(row, ['has_live_day', 'has_live_monthly', 'has_stored_monthly'])
    || ![row.has_live_day, row.has_live_monthly, row.has_stored_monthly]
      .every((value) => value === 0 || value === 1)) invalidState()
  return {
    local,
    facts: {
      hasLiveBackupForLocalDay: row.has_live_day === 1,
      hasLiveMonthlyBackupForLocalMonth: row.has_live_monthly === 1,
      hasStoredMonthlyBackupForLocalMonth: row.has_stored_monthly === 1,
    },
  }
}

function validateDue(value, local) {
  if (value === false) return false
  if (!exactKeys(value, ['localDay', 'localMonth', 'retentionClass'])
    || value.localDay !== local.day
    || value.localMonth !== local.month
    || !['daily', 'monthly'].includes(value.retentionClass)) invalidState()
  return value
}

function backupInsert(db, input) {
  return db.prepare(
    `INSERT INTO backup_runs
     (id,local_day,local_month,retention_class,status,version,export_bookmark,
      object_key,manifest_key,ssec_key_version,wrapped_ssec_key_b64,wrap_nonce_b64,
      object_etag,object_size,started_at,completed_at,expires_at,restore_verified_at,
      last_error_code,created_at,updated_at)
     VALUES (?,?,?,?,'queued',1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
             NULL,NULL,?,?)`
  ).bind(
    input.backupId,
    input.due.localDay,
    input.due.localMonth,
    input.due.retentionClass,
    input.now,
    input.now,
  )
}

function backupPublicationGuard(db, input) {
  const monthly = input.due.retentionClass === 'monthly' ? 1 : 0
  return operationGuard(
    db,
    `scheduler_backup_${input.runId}_${input.attemptCount}`,
    `changes()=1
     AND EXISTS (
       SELECT 1 FROM scheduler_runs
       WHERE id=? AND scheduled_for=? AND status='running' AND attempt_count=?
         AND lease_owner=? AND lease_expires_at=? AND lease_expires_at>?
     )
     AND EXISTS (
       SELECT 1 FROM backup_runs
       WHERE id=? AND local_day=? AND local_month=? AND retention_class=?
         AND status='queued' AND version=1
         AND export_bookmark IS NULL AND object_key IS NULL AND manifest_key IS NULL
         AND ssec_key_version IS NULL AND wrapped_ssec_key_b64 IS NULL
         AND wrap_nonce_b64 IS NULL AND object_etag IS NULL AND object_size IS NULL
         AND started_at IS NULL AND completed_at IS NULL AND expires_at IS NULL
         AND restore_verified_at IS NULL AND last_error_code IS NULL
         AND created_at=? AND updated_at=?
     )
     AND (
       SELECT count(*) FROM backup_runs
       WHERE local_day=? AND status IN ('queued','exporting','stored','restore_verified')
     )=1
     AND (?=0 OR (
       (
         SELECT count(*) FROM backup_runs
         WHERE local_month=? AND retention_class='monthly'
           AND status IN ('queued','exporting','stored','restore_verified')
       )=1
       AND EXISTS (
         SELECT 1 FROM backup_runs
         WHERE id=? AND local_month=? AND retention_class='monthly'
           AND status IN ('queued','exporting','stored','restore_verified')
       )
     ))
     AND EXISTS (
       SELECT 1 FROM outbox_jobs AS o
       WHERE o.id=? AND o.type='backup.create' AND o.aggregate_type='backup_run'
         AND o.aggregate_id=? AND o.idempotency_key=? AND o.status='queued'
         AND o.attempt_count=0 AND o.max_attempts=8 AND o.scheduled_at=?
         AND o.lease_owner IS NULL AND o.lease_expires_at IS NULL
         AND o.last_error_code IS NULL AND o.created_at=? AND o.updated_at=?
         AND json_valid(o.payload_envelope)
         AND (SELECT count(*) FROM json_each(o.payload_envelope))=6
         AND json_extract(o.payload_envelope,'$.format')=1
         AND json_extract(o.payload_envelope,'$.algorithm')='A256GCM'
         AND json_type(o.payload_envelope,'$.dataKeyId')='text'
         AND json_type(o.payload_envelope,'$.dataKeyVersion')='integer'
         AND json_extract(o.payload_envelope,'$.dataKeyVersion')>0
         AND json_type(o.payload_envelope,'$.nonce')='text'
         AND json_type(o.payload_envelope,'$.ciphertext')='text'
     )
     AND (
       SELECT count(*) FROM outbox_jobs
       WHERE type='backup.create' AND aggregate_type='backup_run' AND aggregate_id=?
     )=1`,
    [
      input.runId,
      input.scheduledFor,
      input.attemptCount,
      input.leaseOwner,
      input.leaseExpiresAt,
      input.fenceNow,
      input.backupId,
      input.due.localDay,
      input.due.localMonth,
      input.due.retentionClass,
      input.now,
      input.now,
      input.due.localDay,
      monthly,
      input.due.localMonth,
      input.backupId,
      input.due.localMonth,
      input.jobId,
      input.backupId,
      `backup.create:${input.due.localDay}:${input.backupId}`,
      input.now,
      input.now,
      input.now,
      input.backupId,
    ],
  )
}

function validateBackupWinner(row, due) {
  if (!exactKeys(row, BACKUP_ROW_KEYS)
    || !BACKUP_ID.test(row.id ?? '')
    || row.local_day !== due.localDay
    || row.local_month !== due.localMonth
    || row.retention_class !== due.retentionClass
    || row.status !== 'queued'
    || row.version !== 1
    || !validInstant(row.created_at)
    || row.updated_at !== row.created_at
    || [
      'export_bookmark', 'object_key', 'manifest_key', 'ssec_key_version',
      'wrapped_ssec_key_b64', 'wrap_nonce_b64', 'object_etag', 'object_size',
      'started_at', 'completed_at', 'expires_at', 'restore_verified_at',
      'last_error_code',
    ].some((key) => row[key] !== null)) invalidBackupState()
  return row
}

function validateWinnerJob(row, winner) {
  if (!exactKeys(row, OUTBOX_ROW_KEYS)
    || !validOpaqueId(row.id)
    || row.type !== 'backup.create'
    || row.aggregate_type !== 'backup_run'
    || row.aggregate_id !== winner.id
    || row.idempotency_key !== `backup.create:${winner.local_day}:${winner.id}`
    || row.status !== 'queued'
    || row.attempt_count !== 0
    || row.max_attempts !== BACKUP_MAX_ATTEMPTS
    || row.scheduled_at !== winner.created_at
    || row.created_at !== winner.created_at
    || row.updated_at !== winner.created_at
    || row.lease_owner !== null
    || row.lease_expires_at !== null
    || row.last_error_code !== null
    || typeof row.payload_envelope !== 'string') invalidBackupState()
  return row
}

async function recoverBackupWinner(db, cryptoContext, due) {
  const rows = (await db.prepare(
    `SELECT id,local_day,local_month,retention_class,status,version,export_bookmark,
            object_key,manifest_key,ssec_key_version,wrapped_ssec_key_b64,wrap_nonce_b64,
            object_etag,object_size,started_at,completed_at,expires_at,
            restore_verified_at,last_error_code,created_at,updated_at
     FROM backup_runs
     WHERE (local_day=? AND status IN ('queued','exporting','stored','restore_verified'))
        OR (?='monthly' AND local_month=? AND retention_class='monthly'
            AND status IN ('queued','exporting','stored','restore_verified'))
     ORDER BY id`
  ).bind(due.localDay, due.retentionClass, due.localMonth).all()).results
  if (!Array.isArray(rows) || rows.length !== 1) invalidBackupState()
  const winner = validateBackupWinner(rows[0], due)
  const jobs = (await db.prepare(
    `SELECT id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
            attempt_count,max_attempts,scheduled_at,lease_owner,lease_expires_at,
            last_error_code,created_at,updated_at
     FROM outbox_jobs
     WHERE type='backup.create' AND aggregate_type='backup_run' AND aggregate_id=?
     ORDER BY id`
  ).bind(winner.id).all()).results
  if (!Array.isArray(jobs) || jobs.length !== 1) invalidBackupState()
  const job = validateWinnerJob(jobs[0], winner)
  let payload
  try { payload = await decryptOutboxPayload(cryptoContext, job) } catch { invalidBackupState() }
  if (!exactKeys(payload, ['backupId']) || payload.backupId !== winner.id) invalidBackupState()
  return winner
}

async function publishBackup(validated, deps, cryptoContext, owned, due, checkpoint) {
  const backupId = idFrom(deps.backupIdFactory, BACKUP_ID)
  const jobId = idFrom(deps.idFactory)
  const input = {
    id: jobId,
    type: 'backup.create',
    aggregateType: 'backup_run',
    aggregateId: backupId,
    payload: { backupId },
    idempotencyKey: `backup.create:${due.localDay}:${backupId}`,
    scheduledAt: checkpoint.instant,
    nowMs: checkpoint.ms,
    maxAttempts: BACKUP_MAX_ATTEMPTS,
  }
  const outboxStatement = await deps.enqueueOutboxStatement(validated.db, cryptoContext, input)
  if (!outboxStatement || typeof outboxStatement !== 'object'
    || typeof outboxStatement.run !== 'function') invalidState()
  const descriptor = outboxStatementDescriptorFor(outboxStatement)
  if (!exactKeys(descriptor, ['conditional', 'type'])
    || descriptor.conditional !== false
    || descriptor.type !== 'backup.create') invalidState()
  const commitCheckpoint = await ownershipCheckpoint(
    validated.db,
    validated.scheduledFor,
    owned,
    deps.now,
  )
  const publication = {
    ...owned,
    scheduledFor: validated.scheduledFor,
    due,
    backupId,
    jobId,
    now: input.scheduledAt,
    fenceNow: commitCheckpoint.instant,
  }
  try {
    await validated.db.batch([
      backupInsert(validated.db, publication),
      outboxStatement,
      backupPublicationGuard(validated.db, publication),
    ])
    return true
  } catch (error) {
    if (!isD1IdentityCollision(error)) throw error
    await recoverBackupWinner(validated.db, cryptoContext, due)
    return false
  }
}

function validateOutcomes(value) {
  if (!Array.isArray(value) || value.length > ORDINARY_LIMIT) invalidState()
  const ids = new Set()
  let succeededJobs = 0
  let failedJobs = 0
  for (const outcome of value) {
    if (!exactKeys(outcome, ['id', 'result'])
      || !validOpaqueId(outcome.id)
      || !['succeeded', 'retry', 'dead'].includes(outcome.result)
      || ids.has(outcome.id)) invalidState()
    ids.add(outcome.id)
    if (outcome.result === 'succeeded') succeededJobs += 1
    else failedJobs += 1
  }
  return { claimedJobs: value.length, succeededJobs, failedJobs }
}

async function closeScheduler(db, scheduledFor, owned, counts, now) {
  const current = observation(now)
  const statements = [
    db.prepare(
      `UPDATE scheduler_runs
       SET status='succeeded',completed_at=?,claimed_jobs=?,succeeded_jobs=?,
           failed_jobs=?,error_code=NULL
       WHERE id=? AND scheduled_for=? AND status='running' AND attempt_count=?
         AND lease_owner=? AND lease_expires_at=? AND lease_expires_at>?`
    ).bind(
      current.instant,
      counts.claimedJobs,
      counts.succeededJobs,
      counts.failedJobs,
      owned.runId,
      scheduledFor,
      owned.attemptCount,
      owned.leaseOwner,
      owned.leaseExpiresAt,
      current.instant,
    ),
    operationGuard(
      db,
      `scheduler_close_${owned.runId}_${owned.attemptCount}`,
      `changes()=1 AND EXISTS (
         SELECT 1 FROM scheduler_runs
         WHERE id=? AND scheduled_for=? AND status='succeeded' AND attempt_count=?
           AND lease_owner=? AND lease_expires_at=? AND completed_at=?
           AND claimed_jobs=? AND succeeded_jobs=? AND failed_jobs=? AND error_code IS NULL
       )`,
      [
        owned.runId,
        scheduledFor,
        owned.attemptCount,
        owned.leaseOwner,
        owned.leaseExpiresAt,
        current.instant,
        counts.claimedJobs,
        counts.succeededJobs,
        counts.failedJobs,
      ],
    ),
  ]
  await db.batch(statements)
}

async function failScheduler(db, scheduledFor, owned, counts, now) {
  const current = observation(now)
  const statements = [
    db.prepare(
      `UPDATE scheduler_runs
       SET status='failed',completed_at=?,claimed_jobs=?,succeeded_jobs=?,failed_jobs=?,
           error_code='SCHEDULER_COORDINATOR_FAILED'
       WHERE id=? AND scheduled_for=? AND status='running' AND attempt_count=?
         AND lease_owner=? AND lease_expires_at=? AND lease_expires_at>?`
    ).bind(
      current.instant,
      counts.claimedJobs,
      counts.succeededJobs,
      counts.failedJobs,
      owned.runId,
      scheduledFor,
      owned.attemptCount,
      owned.leaseOwner,
      owned.leaseExpiresAt,
      current.instant,
    ),
    operationGuard(
      db,
      `scheduler_fail_${owned.runId}_${owned.attemptCount}`,
      `changes()=1 AND EXISTS (
         SELECT 1 FROM scheduler_runs
         WHERE id=? AND scheduled_for=? AND status='failed' AND attempt_count=?
           AND lease_owner=? AND lease_expires_at=? AND completed_at=?
           AND claimed_jobs=? AND succeeded_jobs=? AND failed_jobs=?
           AND error_code='SCHEDULER_COORDINATOR_FAILED'
       )`,
      [
        owned.runId,
        scheduledFor,
        owned.attemptCount,
        owned.leaseOwner,
        owned.leaseExpiresAt,
        current.instant,
        counts.claimedJobs,
        counts.succeededJobs,
        counts.failedJobs,
      ],
    ),
  ]
  await db.batch(statements)
}

const logFields = (event, result, owned, counts, error = false) => ({
  event,
  result,
  ...(owned ? { runId: owned.runId, attemptCount: owned.attemptCount } : {}),
  ...counts,
  ...(error ? { errorCode: 'SCHEDULER_COORDINATOR_FAILED' } : {}),
})

const emitLog = async (log, level, fields) => {
  try { await log(level, fields) } catch { /* Logging never owns coordinator state. */ }
}

export async function runScheduled(input) {
  const validated = validateInvocation(input)
  const deps = dependencies(validated.deps)
  let owned = null
  let backupEnqueued = false
  let counts = { claimedJobs: 0, succeededJobs: 0, failedJobs: 0 }
  try {
    const claim = await claimScheduler(validated, deps)
    if (claim.skipped) {
      await emitLog(deps.safeLog, 'info', logFields(
        'scheduler.skipped',
        'skipped',
        { runId: claim.row.id, attemptCount: claim.row.attempt_count },
        counts,
      ))
      return claim.skipped
    }
    owned = claim.owned
    await emitLog(deps.safeLog, 'info', logFields('scheduler.started', 'started', owned, counts))

    await ownershipCheckpoint(validated.db, validated.scheduledFor, owned, deps.now)
    const cryptoContext = await identityCryptoContext(validated, deps)
    await ownershipCheckpoint(validated.db, validated.scheduledFor, owned, deps.now)

    const snapshot = await dueFacts(validated.db, validated.scheduledTime)
    const due = validateDue(
      await deps.backupDue(validated.scheduledTime, { ...snapshot.facts }),
      snapshot.local,
    )
    if (due) {
      const checkpoint = await ownershipCheckpoint(
        validated.db,
        validated.scheduledFor,
        owned,
        deps.now,
      )
      backupEnqueued = await publishBackup(
        validated,
        deps,
        cryptoContext,
        owned,
        due,
        checkpoint,
      )
    }

    const processorCheckpoint = await ownershipCheckpoint(
      validated.db,
      validated.scheduledFor,
      owned,
      deps.now,
    )
    const outcomes = await deps.processOutboxBatch({
      db: validated.db,
      cryptoContext,
      config: validated.config,
      nowMs: processorCheckpoint.ms,
      nowFactory: deps.now,
      idFactory: deps.idFactory,
      leaseOwnerFactory: deps.leaseOwnerFactory,
      limit: ORDINARY_LIMIT,
      beforeDispatch: () => ownershipCheckpoint(
        validated.db,
        validated.scheduledFor,
        owned,
        deps.now,
      ),
      dispatch: async (dispatchInput) => {
        if (dispatchInput?.job?.type === 'backup.create') invalidState()
        return deps.dispatchOutboxJob({
          ...dispatchInput,
          env: validated.env,
          bindings: validated.env,
          providers: deps.providers,
          idFactory: deps.idFactory,
          leaseOwnerFactory: deps.leaseOwnerFactory,
          leaseNonceFactory: deps.leaseNonceFactory,
          correlationIdFactory: deps.correlationIdFactory,
        })
      },
    })
    counts = validateOutcomes(outcomes)

    await ownershipCheckpoint(validated.db, validated.scheduledFor, owned, deps.now)
    await closeScheduler(validated.db, validated.scheduledFor, owned, counts, deps.now)
    await emitLog(deps.safeLog, 'info', logFields('scheduler.completed', 'completed', owned, counts))
    return {
      status: 'succeeded',
      reason: null,
      runId: owned.runId,
      ...counts,
      backupEnqueued,
    }
  } catch {
    if (owned) {
      try {
        await ownershipCheckpoint(validated.db, validated.scheduledFor, owned, deps.now)
        await failScheduler(validated.db, validated.scheduledFor, owned, counts, deps.now)
      } catch {
        // A stale or expired owner cannot mutate the current scheduler row.
      }
    }
    await emitLog(deps.safeLog, 'error', logFields('scheduler.failed', 'failure', owned, counts, true))
    return {
      status: 'failed',
      reason: 'coordinator_failed',
      runId: owned?.runId ?? null,
      ...counts,
      backupEnqueued,
    }
  }
}
