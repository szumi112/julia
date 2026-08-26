import { isD1OutboxOperationGuardFailure } from '../db/errors.js'
import { decryptOutboxPayload } from '../jobs/outbox.js'

const BACKUP_JOB_LIMIT = 1
const BACKUP_LEASE_MS = 12 * 60 * 1000
const BACKUP_MAX_ATTEMPTS = 8
const OUTER_KEYS = Object.freeze([
  'db', 'cryptoContext', 'config', 'bindings', 'schedulerRun', 'now', 'wait',
  'idFactory', 'leaseOwnerFactory', 'nonceFactory', 'providers',
])
const SCHEDULER_KEYS = Object.freeze([
  'runId', 'attemptCount', 'leaseOwner', 'leaseExpiresAt',
])
const JOB_COLUMNS = Object.freeze([
  'id', 'type', 'aggregate_type', 'aggregate_id', 'payload_envelope',
  'idempotency_key', 'status', 'attempt_count', 'max_attempts', 'scheduled_at',
  'lease_owner', 'lease_expires_at', 'last_error_code', 'created_at', 'updated_at',
])
const BACKUP_COLUMNS = Object.freeze([
  'id', 'local_day', 'local_month', 'retention_class', 'status', 'version',
  'export_bookmark', 'object_key', 'manifest_key', 'ssec_key_version',
  'wrapped_ssec_key_b64', 'wrap_nonce_b64', 'object_etag', 'object_size',
  'started_at', 'completed_at', 'expires_at', 'restore_verified_at',
  'last_error_code', 'created_at', 'updated_at',
])
const ATTEMPT_COLUMNS = Object.freeze([
  'id', 'job_id', 'attempt_number', 'started_at', 'completed_at', 'result',
  'error_code', 'provider_reference',
])
const COUNT_COLUMNS = Object.freeze([
  'attempt_rows', 'open_attempt_rows', 'min_attempt_number', 'max_attempt_number',
  'invalid_terminal_attempt_rows',
])
const CANDIDATE_KEYS = Object.freeze([
  ...JOB_COLUMNS.map((column) => `job_${column}`),
  ...BACKUP_COLUMNS.map((column) => `backup_${column}`),
  ...ATTEMPT_COLUMNS.map((column) => `old_attempt_${column}`),
  ...COUNT_COLUMNS,
])
const BACKUP_NULL_COLUMNS = Object.freeze([
  'export_bookmark', 'object_key', 'manifest_key', 'ssec_key_version',
  'wrapped_ssec_key_b64', 'wrap_nonce_b64', 'object_etag', 'object_size',
  'completed_at', 'expires_at', 'restore_verified_at', 'last_error_code',
])
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_MONTH = /^\d{4}-\d{2}$/

const invalid = () => { throw new Error('BACKUP_STATE_INVALID') }
const ownRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => ownRecord(value)
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const validId = (value) => typeof value === 'string' && OPAQUE_ID.test(value)
const validBackupId = (value) => typeof value === 'string' && BACKUP_ID.test(value)
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const validLocalDay = (value) => typeof value === 'string' && LOCAL_DAY.test(value)
  && validInstant(`${value}T00:00:00.000Z`)
const validLocalMonth = (value) => typeof value === 'string' && LOCAL_MONTH.test(value)
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0

const invalidTerminalAttemptCondition = (terminal, next) => `(
  ${terminal}.result IS NULL OR ${terminal}.result<>'retry'
  OR ${terminal}.error_code IS NULL
  OR ${terminal}.error_code<>'OUTBOX_LEASE_EXPIRED'
  OR ${terminal}.provider_reference IS NOT NULL
  OR ${next}.id IS NULL
  OR ${next}.started_at IS NULL
  OR ${terminal}.completed_at<>${next}.started_at
)`

const invalidTerminalAttemptRows = (jobExpression) => `
  SELECT count(*)
  FROM outbox_attempts AS terminal
  LEFT JOIN outbox_attempts AS next_attempt
    ON next_attempt.job_id=terminal.job_id
   AND next_attempt.attempt_number=terminal.attempt_number+1
  WHERE terminal.job_id=${jobExpression}
    AND terminal.completed_at IS NOT NULL
    AND ${invalidTerminalAttemptCondition('terminal', 'next_attempt')}`

const noInvalidTerminalAttempts = (jobExpression) => `NOT EXISTS (
  SELECT 1
  FROM outbox_attempts AS terminal
  LEFT JOIN outbox_attempts AS next_attempt
    ON next_attempt.job_id=terminal.job_id
   AND next_attempt.attempt_number=terminal.attempt_number+1
  WHERE terminal.job_id=${jobExpression}
    AND terminal.completed_at IS NOT NULL
    AND ${invalidTerminalAttemptCondition('terminal', 'next_attempt')}
)`

function descriptorSnapshot(value, keys) {
  if (!ownRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (!exactKeys(descriptors, keys)) invalid()
  const result = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalid()
    result[key] = descriptor.value
  }
  return result
}

function dataSnapshot(value, keys) {
  if (!ownRecord(value)) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (!exactKeys(descriptors, keys)) invalid()
  const result = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalid()
    result[key] = descriptor.value
  }
  return result
}

function dataProperty(value, key) {
  if (!ownRecord(value)) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const descriptor = descriptors[key]
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalid()
  return descriptor.value
}

function fixedArray(value, expectedLength = null) {
  if (!Array.isArray(value)) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const lengthDescriptor = descriptors.length
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || (expectedLength !== null && lengthDescriptor.value !== expectedLength)
    || Reflect.ownKeys(descriptors).length !== lengthDescriptor.value + 1) invalid()
  const result = []
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) invalid()
    result.push(descriptor.value)
  }
  return result
}

function instantFromMs(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  let instant
  try { instant = new Date(value).toISOString() } catch { invalid() }
  if (!validInstant(instant) || Date.parse(instant) !== value) invalid()
  return instant
}

function generatedId(factory) {
  if (typeof factory !== 'function') invalid()
  const value = factory()
  if (!validId(value)) invalid()
  return value
}

function captureInput(input) {
  const outer = descriptorSnapshot(input, OUTER_KEYS)
  if (!outer.db || typeof outer.db.prepare !== 'function' || typeof outer.db.batch !== 'function'
    || typeof outer.now !== 'function'
    || typeof outer.idFactory !== 'function'
    || typeof outer.leaseOwnerFactory !== 'function') invalid()
  const nowMs = outer.now()
  const claimNow = instantFromMs(nowMs)
  if (!Number.isSafeInteger(nowMs + BACKUP_LEASE_MS)) invalid()
  const leaseExpiresAt = instantFromMs(nowMs + BACKUP_LEASE_MS)
  const scheduler = descriptorSnapshot(outer.schedulerRun, SCHEDULER_KEYS)
  if (!validId(scheduler.runId)
    || !positiveInteger(scheduler.attemptCount)
    || !validId(scheduler.leaseOwner)
    || !validInstant(scheduler.leaseExpiresAt)
    || scheduler.leaseExpiresAt <= claimNow) invalid()
  return { ...outer, scheduler, nowMs, claimNow, leaseExpiresAt }
}

const candidateProjection = () => [
  ...JOB_COLUMNS.map((column) => `j.${column} AS job_${column}`),
  ...BACKUP_COLUMNS.map((column) => `b.${column} AS backup_${column}`),
  ...ATTEMPT_COLUMNS.map((column) => `a.${column} AS old_attempt_${column}`),
  `(SELECT count(*) FROM outbox_attempts AS ar WHERE ar.job_id=j.id) AS attempt_rows`,
  `(SELECT count(*) FROM outbox_attempts AS ao
    WHERE ao.job_id=j.id AND ao.completed_at IS NULL) AS open_attempt_rows`,
  `(SELECT min(am.attempt_number) FROM outbox_attempts AS am
    WHERE am.job_id=j.id) AS min_attempt_number`,
  `(SELECT max(ax.attempt_number) FROM outbox_attempts AS ax
    WHERE ax.job_id=j.id) AS max_attempt_number`,
  `(${invalidTerminalAttemptRows('j.id')}) AS invalid_terminal_attempt_rows`,
].join(',\n       ')

async function readCandidate(db, claimNow) {
  const response = await db.prepare(
    `WITH candidate AS (
       SELECT id
       FROM outbox_jobs
       WHERE type='backup.create'
         AND scheduled_at<=?
         AND (
           status='queued'
           OR (status='processing' AND lease_expires_at<?)
         )
       ORDER BY scheduled_at ASC, created_at ASC, id ASC
       LIMIT ${BACKUP_JOB_LIMIT}
     )
     SELECT
       ${candidateProjection()}
     FROM candidate AS c
     JOIN outbox_jobs AS j ON j.id=c.id
     LEFT JOIN backup_runs AS b
       ON b.id=j.aggregate_id AND j.aggregate_type='backup_run'
     LEFT JOIN outbox_attempts AS a
       ON a.job_id=j.id AND a.completed_at IS NULL
     ORDER BY a.attempt_number ASC, a.id ASC`
  ).bind(claimNow, claimNow).all()
  const rows = fixedArray(dataProperty(response, 'results'))
  if (rows.length === 0) return null
  if (rows.length !== 1) invalid()
  return dataSnapshot(rows[0], CANDIDATE_KEYS)
}

const recordFrom = (row, prefix, columns) => Object.fromEntries(
  columns.map((column) => [column, row[`${prefix}_${column}`]])
)

function validateCommon(row, claimNow) {
  const job = recordFrom(row, 'job', JOB_COLUMNS)
  const backup = recordFrom(row, 'backup', BACKUP_COLUMNS)
  if (!validId(job.id)
    || job.type !== 'backup.create'
    || job.aggregate_type !== 'backup_run'
    || !validBackupId(job.aggregate_id)
    || job.max_attempts !== BACKUP_MAX_ATTEMPTS
    || !validInstant(job.scheduled_at)
    || !validInstant(job.created_at)
    || !validInstant(job.updated_at)
    || job.scheduled_at > claimNow
    || job.scheduled_at !== job.created_at
    || job.created_at > job.updated_at
    || backup.id !== job.aggregate_id
    || !validBackupId(backup.id)
    || !validLocalDay(backup.local_day)
    || !validLocalMonth(backup.local_month)
    || backup.local_month !== backup.local_day.slice(0, 7)
    || !['daily', 'monthly'].includes(backup.retention_class)
    || !Number.isSafeInteger(backup.version) || backup.version < 1
    || !validInstant(backup.created_at)
    || !validInstant(backup.updated_at)
    || backup.created_at !== job.created_at
    || backup.created_at > backup.updated_at
    || job.idempotency_key !== `backup.create:${backup.local_day}:${backup.id}`
    || BACKUP_NULL_COLUMNS.some((column) => backup[column] !== null)) invalid()
  return { job, backup }
}

function validateInitial(row, common) {
  const { job, backup } = common
  if (job.status !== 'queued'
    || job.attempt_count !== 0
    || job.lease_owner !== null
    || job.lease_expires_at !== null
    || job.last_error_code !== null
    || job.updated_at !== job.created_at
    || backup.status !== 'queued'
    || backup.version !== 1
    || backup.started_at !== null
    || backup.updated_at !== backup.created_at
    || row.attempt_rows !== 0
    || row.open_attempt_rows !== 0
    || row.min_attempt_number !== null
    || row.max_attempt_number !== null
    || row.invalid_terminal_attempt_rows !== 0
    || ATTEMPT_COLUMNS.some((column) => row[`old_attempt_${column}`] !== null)) invalid()
  return { ...common, oldAttempt: null, nextAttempt: 1 }
}

function validateReclaim(row, common, claimNow) {
  const { job, backup } = common
  const oldAttempt = recordFrom(row, 'old_attempt', ATTEMPT_COLUMNS)
  if (job.status !== 'processing'
    || !Number.isSafeInteger(job.attempt_count)
    || job.attempt_count < 1 || job.attempt_count > BACKUP_MAX_ATTEMPTS
    || !validId(job.lease_owner)
    || !validInstant(job.lease_expires_at)
    || job.lease_expires_at >= claimNow
    || job.lease_expires_at <= job.updated_at
    || ![null, 'OUTBOX_LEASE_EXPIRED'].includes(job.last_error_code)
    || backup.status !== 'exporting'
    || backup.version !== 2
    || !validInstant(backup.started_at)
    || backup.started_at !== backup.updated_at
    || backup.updated_at < backup.created_at
    || backup.updated_at > job.updated_at
    || row.attempt_rows !== job.attempt_count
    || row.open_attempt_rows !== 1
    || row.min_attempt_number !== 1
    || row.max_attempt_number !== job.attempt_count
    || row.invalid_terminal_attempt_rows !== 0
    || !validId(oldAttempt.id)
    || oldAttempt.job_id !== job.id
    || oldAttempt.attempt_number !== job.attempt_count
    || !validInstant(oldAttempt.started_at)
    || oldAttempt.started_at !== job.updated_at
    || oldAttempt.completed_at !== null
    || oldAttempt.result !== null
    || oldAttempt.error_code !== null
    || oldAttempt.provider_reference !== null) invalid()
  if (job.attempt_count >= job.max_attempts) invalid()
  return { ...common, oldAttempt, nextAttempt: job.attempt_count + 1 }
}

async function validateCandidate(row, cryptoContext, claimNow) {
  const common = validateCommon(row, claimNow)
  const validated = common.job.status === 'queued'
    ? validateInitial(row, common)
    : validateReclaim(row, common, claimNow)
  const payload = await decryptOutboxPayload(cryptoContext, validated.job)
  if (!exactKeys(payload, ['backupId']) || payload.backupId !== validated.backup.id) invalid()
  return validated
}

const schedulerFence = (alias = 's') => `${alias}.id=?
  AND ${alias}.status='running'
  AND ${alias}.attempt_count=?
  AND ${alias}.lease_owner=?
  AND ${alias}.lease_expires_at=?
  AND ${alias}.completed_at IS NULL
  AND ${alias}.lease_expires_at>?`

const schedulerBindings = (input) => [
  input.scheduler.runId,
  input.scheduler.attemptCount,
  input.scheduler.leaseOwner,
  input.scheduler.leaseExpiresAt,
  input.claimNow,
]

const backupNullPredicate = (alias) => BACKUP_NULL_COLUMNS
  .map((column) => `${alias}.${column} IS NULL`).join('\n  AND ')

const initialBackupPredicate = (alias = 'b') => `${alias}.id=?
  AND ${alias}.local_day=?
  AND ${alias}.local_month=?
  AND ${alias}.retention_class=?
  AND ${alias}.status='queued'
  AND ${alias}.version=1
  AND ${backupNullPredicate(alias)}
  AND ${alias}.started_at IS NULL
  AND ${alias}.created_at=?
  AND ${alias}.updated_at=?`

const initialBackupBindings = (backup) => [
  backup.id,
  backup.local_day,
  backup.local_month,
  backup.retention_class,
  backup.created_at,
  backup.updated_at,
]

const exportingBackupPredicate = (alias = 'b') => `${alias}.id=?
  AND ${alias}.local_day=?
  AND ${alias}.local_month=?
  AND ${alias}.retention_class=?
  AND ${alias}.status='exporting'
  AND ${alias}.version=2
  AND ${backupNullPredicate(alias)}
  AND ${alias}.started_at=?
  AND ${alias}.created_at=?
  AND ${alias}.updated_at=?`

const exportingBackupBindings = (backup) => [
  backup.id,
  backup.local_day,
  backup.local_month,
  backup.retention_class,
  backup.started_at,
  backup.created_at,
  backup.updated_at,
]

const queuedJobPredicate = (alias = 'j') => `${alias}.id=?
  AND ${alias}.type='backup.create'
  AND ${alias}.aggregate_type='backup_run'
  AND ${alias}.aggregate_id=?
  AND ${alias}.payload_envelope=?
  AND ${alias}.idempotency_key=?
  AND ${alias}.status='queued'
  AND ${alias}.attempt_count=0
  AND ${alias}.max_attempts=8
  AND ${alias}.scheduled_at=?
  AND ${alias}.lease_owner IS NULL
  AND ${alias}.lease_expires_at IS NULL
  AND ${alias}.last_error_code IS NULL
  AND ${alias}.created_at=?
  AND ${alias}.updated_at=?`

const queuedJobBindings = (job) => [
  job.id,
  job.aggregate_id,
  job.payload_envelope,
  job.idempotency_key,
  job.scheduled_at,
  job.created_at,
  job.updated_at,
]

const processingJobPredicate = (alias = 'j', errorPredicate = `${alias}.last_error_code IS NULL`) => `${alias}.id=?
  AND ${alias}.type='backup.create'
  AND ${alias}.aggregate_type='backup_run'
  AND ${alias}.aggregate_id=?
  AND ${alias}.payload_envelope=?
  AND ${alias}.idempotency_key=?
  AND ${alias}.status='processing'
  AND ${alias}.attempt_count=?
  AND ${alias}.max_attempts=8
  AND ${alias}.scheduled_at=?
  AND ${alias}.lease_owner=?
  AND ${alias}.lease_expires_at=?
  AND ${errorPredicate}
  AND ${alias}.created_at=?
  AND ${alias}.updated_at=?`

const processingJobBindings = (job, attemptNumber, leaseOwner, leaseExpiresAt, updatedAt) => [
  job.id,
  job.aggregate_id,
  job.payload_envelope,
  job.idempotency_key,
  attemptNumber,
  job.scheduled_at,
  leaseOwner,
  leaseExpiresAt,
  job.created_at,
  updatedAt,
]

const oldProcessingJobPredicate = (alias = 'j') => processingJobPredicate(
  alias,
  `(${alias}.last_error_code IS NULL OR ${alias}.last_error_code='OUTBOX_LEASE_EXPIRED')`,
)

const operationGuard = (db, operationId, predicate, bindings) => db.prepare(
  `INSERT INTO outbox_operation_guard_failures (operation_id)
   SELECT ? WHERE NOT (${predicate})`
).bind(operationId, ...bindings)

function initialStatements(db, input, candidate, generated) {
  const { job, backup } = candidate
  const newJobPredicate = processingJobPredicate('j')
  const newJobBindings = processingJobBindings(
    job,
    generated.attemptNumber,
    generated.leaseOwner,
    input.leaseExpiresAt,
    input.claimNow,
  )
  const newBackupBindings = [
    backup.id,
    backup.local_day,
    backup.local_month,
    backup.retention_class,
    input.claimNow,
    backup.created_at,
    input.claimNow,
  ]
  return [
    db.prepare(
      `UPDATE outbox_jobs
       SET status='processing',attempt_count=1,lease_owner=?,lease_expires_at=?,
           updated_at=?,last_error_code=NULL
       WHERE ${queuedJobPredicate('outbox_jobs')}
         AND scheduled_at<=?
         AND EXISTS (
           SELECT 1 FROM backup_runs AS b WHERE ${initialBackupPredicate('b')}
         )
         AND EXISTS (
           SELECT 1 FROM scheduler_runs AS s WHERE ${schedulerFence('s')}
         )
         AND NOT EXISTS (
           SELECT 1 FROM outbox_jobs AS owned WHERE owned.lease_owner=?
         )`
    ).bind(
      generated.leaseOwner,
      input.leaseExpiresAt,
      input.claimNow,
      ...queuedJobBindings(job),
      input.claimNow,
      ...initialBackupBindings(backup),
      ...schedulerBindings(input),
      generated.leaseOwner,
    ),
    db.prepare(
      `INSERT INTO outbox_attempts
       (id,job_id,attempt_number,started_at,completed_at,result,error_code,provider_reference)
       SELECT ?,?,?,?,NULL,NULL,NULL,NULL WHERE changes()=1`
    ).bind(generated.attemptId, job.id, generated.attemptNumber, input.claimNow),
    db.prepare(
      `UPDATE backup_runs
       SET status='exporting',version=2,started_at=?,updated_at=?
       WHERE changes()=1
         AND ${initialBackupPredicate('backup_runs')}
         AND EXISTS (
           SELECT 1 FROM outbox_jobs AS j WHERE ${newJobPredicate}
         )`
    ).bind(
      input.claimNow,
      input.claimNow,
      ...initialBackupBindings(backup),
      ...newJobBindings,
    ),
    operationGuard(
      db,
      `backup_claim_${job.id}_${generated.attemptId}`,
      `changes()=1
       AND EXISTS (
         SELECT 1 FROM scheduler_runs AS s WHERE ${schedulerFence('s')}
       )
       AND EXISTS (
         SELECT 1 FROM outbox_jobs AS j WHERE ${newJobPredicate}
       )
       AND EXISTS (
         SELECT 1 FROM outbox_attempts AS a
         WHERE a.id=? AND a.job_id=? AND a.attempt_number=1 AND a.started_at=?
           AND a.completed_at IS NULL AND a.result IS NULL
           AND a.error_code IS NULL AND a.provider_reference IS NULL
       )
       AND EXISTS (
         SELECT 1 FROM backup_runs AS b WHERE ${exportingBackupPredicate('b')}
       )
       AND (SELECT count(*) FROM outbox_jobs
            WHERE status='processing' AND lease_owner=?)=1
       AND (SELECT count(*) FROM outbox_attempts WHERE job_id=?)=1
       AND (SELECT count(*) FROM outbox_attempts
            WHERE job_id=? AND completed_at IS NULL)=1
       AND (SELECT min(attempt_number) FROM outbox_attempts WHERE job_id=?)=1
       AND (SELECT max(attempt_number) FROM outbox_attempts WHERE job_id=?)=1
       AND ${noInvalidTerminalAttempts('?')}`,
      [
        ...schedulerBindings(input),
        ...newJobBindings,
        generated.attemptId,
        job.id,
        input.claimNow,
        ...newBackupBindings,
        generated.leaseOwner,
        job.id,
        job.id,
        job.id,
        job.id,
        job.id,
      ],
    ),
  ]
}

function reclaimStatements(db, input, candidate, generated) {
  const { job, backup, oldAttempt } = candidate
  const oldJobBindings = processingJobBindings(
    job,
    job.attempt_count,
    job.lease_owner,
    job.lease_expires_at,
    job.updated_at,
  )
  const newJobPredicate = processingJobPredicate('j', "j.last_error_code='OUTBOX_LEASE_EXPIRED'")
  const newJobBindings = processingJobBindings(
    job,
    generated.attemptNumber,
    generated.leaseOwner,
    input.leaseExpiresAt,
    input.claimNow,
  )
  return [
    db.prepare(
      `UPDATE outbox_attempts
       SET completed_at=?,result='retry',error_code='OUTBOX_LEASE_EXPIRED',
           provider_reference=NULL
       WHERE id=? AND job_id=? AND attempt_number=? AND started_at=?
         AND completed_at IS NULL AND result IS NULL
         AND error_code IS NULL AND provider_reference IS NULL`
    ).bind(
      input.claimNow,
      oldAttempt.id,
      job.id,
      oldAttempt.attempt_number,
      oldAttempt.started_at,
    ),
    db.prepare(
      `UPDATE outbox_jobs
       SET attempt_count=?,lease_owner=?,lease_expires_at=?,updated_at=?,
           last_error_code='OUTBOX_LEASE_EXPIRED'
       WHERE changes()=1
         AND ${oldProcessingJobPredicate('outbox_jobs')}
         AND lease_expires_at<?
         AND EXISTS (
           SELECT 1 FROM scheduler_runs AS s WHERE ${schedulerFence('s')}
         )
         AND EXISTS (
           SELECT 1 FROM backup_runs AS b WHERE ${exportingBackupPredicate('b')}
         )
         AND NOT EXISTS (
           SELECT 1 FROM outbox_jobs AS owned WHERE owned.lease_owner=?
         )`
    ).bind(
      generated.attemptNumber,
      generated.leaseOwner,
      input.leaseExpiresAt,
      input.claimNow,
      ...oldJobBindings,
      input.claimNow,
      ...schedulerBindings(input),
      ...exportingBackupBindings(backup),
      generated.leaseOwner,
    ),
    db.prepare(
      `INSERT INTO outbox_attempts
       (id,job_id,attempt_number,started_at,completed_at,result,error_code,provider_reference)
       SELECT ?,?,?,?,NULL,NULL,NULL,NULL WHERE changes()=1`
    ).bind(generated.attemptId, job.id, generated.attemptNumber, input.claimNow),
    operationGuard(
      db,
      `backup_reclaim_${job.id}_${generated.attemptId}`,
      `changes()=1
       AND EXISTS (
         SELECT 1 FROM scheduler_runs AS s WHERE ${schedulerFence('s')}
       )
       AND EXISTS (
         SELECT 1 FROM outbox_jobs AS j WHERE ${newJobPredicate}
       )
       AND EXISTS (
         SELECT 1 FROM backup_runs AS b WHERE ${exportingBackupPredicate('b')}
       )
       AND EXISTS (
         SELECT 1 FROM outbox_attempts AS old
         WHERE old.id=? AND old.job_id=? AND old.attempt_number=? AND old.started_at=?
           AND old.completed_at=? AND old.result='retry'
           AND old.error_code='OUTBOX_LEASE_EXPIRED'
           AND old.provider_reference IS NULL
       )
       AND EXISTS (
         SELECT 1 FROM outbox_attempts AS current
         WHERE current.id=? AND current.job_id=? AND current.attempt_number=?
           AND current.started_at=? AND current.completed_at IS NULL
           AND current.result IS NULL AND current.error_code IS NULL
           AND current.provider_reference IS NULL
       )
       AND (SELECT count(*) FROM outbox_jobs
            WHERE status='processing' AND lease_owner=?)=1
       AND (SELECT count(*) FROM outbox_attempts WHERE job_id=?)=?
       AND (SELECT count(*) FROM outbox_attempts
            WHERE job_id=? AND completed_at IS NULL)=1
       AND (SELECT min(attempt_number) FROM outbox_attempts WHERE job_id=?)=1
       AND (SELECT max(attempt_number) FROM outbox_attempts WHERE job_id=?)=?
       AND ${noInvalidTerminalAttempts('?')}`,
      [
        ...schedulerBindings(input),
        ...newJobBindings,
        ...exportingBackupBindings(backup),
        oldAttempt.id,
        job.id,
        oldAttempt.attempt_number,
        oldAttempt.started_at,
        input.claimNow,
        generated.attemptId,
        job.id,
        generated.attemptNumber,
        input.claimNow,
        generated.leaseOwner,
        job.id,
        generated.attemptNumber,
        job.id,
        job.id,
        job.id,
        generated.attemptNumber,
        job.id,
      ],
    ),
  ]
}

async function claimCandidate(input, candidate) {
  const attemptId = generatedId(input.idFactory)
  const leaseOwner = generatedId(input.leaseOwnerFactory)
  const claim = {
    jobId: candidate.job.id,
    backupId: candidate.backup.id,
    attemptId,
    attemptNumber: candidate.nextAttempt,
    leaseOwner,
    leaseExpiresAt: input.leaseExpiresAt,
    recoveryOnly: candidate.nextAttempt === candidate.job.max_attempts,
  }
  const statements = candidate.oldAttempt === null
    ? initialStatements(input.db, input, candidate, claim)
    : reclaimStatements(input.db, input, candidate, claim)
  const results = await input.db.batch(statements)
  const fixedResults = fixedArray(results, 4)
  if (fixedResults.some((result) => dataProperty(result, 'success') !== true)) invalid()
  return claim
}

async function processCaptured(input) {
  const row = await readCandidate(input.db, input.claimNow)
  if (row === null) return { claimed: false, schedulerRun: input.scheduler }
  const candidate = await validateCandidate(row, input.cryptoContext, input.claimNow)
  await claimCandidate(input, candidate)
  return { claimed: true, schedulerRun: input.scheduler }
}

export async function processNextBackupCreate(input) {
  try {
    return await processCaptured(captureInput(input))
  } catch (error) {
    let guardFailure = false
    try { guardFailure = isD1OutboxOperationGuardFailure(error) === true } catch {}
    if (guardFailure) throw new Error('BACKUP_LEASE_LOST')
    throw new Error('BACKUP_STATE_INVALID')
  }
}

const EXPORT_INPUT_KEYS = Object.freeze([
  'accountId', 'databaseId', 'token', 'fetch', 'wait', 'now', 'signal',
])
const DOWNLOAD_INPUT_KEYS = Object.freeze(['downloadUrl', 'fetch', 'signal'])
const EXPORT_ACCOUNT_ID = /^[0-9a-f]{32}$/
const EXPORT_DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EXPORT_TOKEN_PLACEHOLDERS = new Set([
  'change-me', 'changeme', 'example', 'placeholder', 'replace-me', 'replaceme',
  'todo', 'your-token-here',
])
const EXPORT_ENDPOINT_ORIGIN = 'https://api.cloudflare.com/client/v4'
const EXPORT_DEADLINE_MS = 5 * 60 * 1000
const EXPORT_POLL_INTERVAL_MS = 10 * 1000
const EXPORT_POLL_LIMIT = 30
const EXPORT_JSON_LIMIT_BYTES = 64 * 1024
const EXPORT_BOOKMARK_LIMIT_BYTES = 1024
const EXPORT_FILENAME_LIMIT_BYTES = 1024
const EXPORT_URL_LIMIT_BYTES = 8192
const EXPORT_JSON_DEPTH_LIMIT = 64
const JSON_MEDIA_TYPE = /^application\/json(?:[ \t]*;[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]*=[ \t]*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[^"\\\r\n]|\\[\t -~])*"))*[ \t]*$/i
const adapterErrors = new WeakMap()
const activeAdapterCaptures = new WeakSet()
const reenteredAdapterCaptures = new WeakSet()

function adapterFail(code) {
  const error = new Error(code)
  adapterErrors.set(error, code)
  throw error
}

function rethrowAdapter(error, fallback = 'BACKUP_EXPORT_RESPONSE_INVALID') {
  const code = adapterErrors.get(error)
  throw new Error(code ?? fallback)
}

function strictAdapterSnapshot(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  if (activeAdapterCaptures.has(value)) {
    reenteredAdapterCaptures.add(value)
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  activeAdapterCaptures.add(value)
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const names = Reflect.ownKeys(descriptors)
    if (names.length !== keys.length
      || names.some((name) => typeof name !== 'string')
      || !keys.every((key) => Object.hasOwn(descriptors, key))) {
      adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    }
    const snapshot = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      }
      snapshot[key] = descriptor.value
    }
    if (reenteredAdapterCaptures.has(value)) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    return snapshot
  } catch (error) {
    if (adapterErrors.has(error)) throw error
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  } finally {
    activeAdapterCaptures.delete(value)
    reenteredAdapterCaptures.delete(value)
  }
}

function boundedUtf8(value, limit) {
  if (typeof value !== 'string' || value.length > limit) return false
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0)
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes > limit) return false
  }
  return true
}

function validExportToken(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 4096
    && boundedUtf8(value, 4096)
    && value === value.trim()
    && !/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    && !EXPORT_TOKEN_PLACEHOLDERS.has(value.replaceAll('_', '-').toLowerCase())
}

function captureAbortSignal(signal) {
  const AbortSignalImpl = globalThis.AbortSignal
  const EventTargetImpl = globalThis.EventTarget
  if (typeof AbortSignalImpl !== 'function'
    || typeof EventTargetImpl !== 'function'
    || !(signal instanceof AbortSignalImpl)) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignalImpl.prototype, 'aborted')?.get
  const add = EventTargetImpl.prototype.addEventListener
  const remove = EventTargetImpl.prototype.removeEventListener
  if (typeof abortedGetter !== 'function' || typeof add !== 'function' || typeof remove !== 'function') {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  const aborted = () => {
    let value
    try { value = abortedGetter.call(signal) } catch { adapterFail('BACKUP_EXPORT_RESPONSE_INVALID') }
    if (typeof value !== 'boolean') adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    return value
  }
  aborted()
  return {
    signal,
    aborted,
    add(listener) {
      try { add.call(signal, 'abort', listener, { once: true }) } catch {
        adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      }
    },
    remove(listener) {
      try { remove.call(signal, 'abort', listener) } catch {
        adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      }
    },
  }
}

function captureClock(now) {
  let previous = null
  return () => {
    let value
    try { value = now() } catch { adapterFail('BACKUP_EXPORT_RESPONSE_INVALID') }
    if (!Number.isSafeInteger(value) || value < 0 || (previous !== null && value < previous)) {
      adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    }
    previous = value
    return value
  }
}

function captureExportInput(input) {
  const snapshot = strictAdapterSnapshot(input, EXPORT_INPUT_KEYS)
  if (typeof snapshot.fetch !== 'function'
    || typeof snapshot.wait !== 'function'
    || typeof snapshot.now !== 'function'
    || typeof snapshot.accountId !== 'string'
    || !EXPORT_ACCOUNT_ID.test(snapshot.accountId)
    || snapshot.accountId === '0'.repeat(32)
    || typeof snapshot.databaseId !== 'string'
    || !EXPORT_DATABASE_ID.test(snapshot.databaseId)
    || snapshot.databaseId === '00000000-0000-0000-0000-000000000000'
    || snapshot.databaseId === '00000000-0000-0000-0000-000000000001'
    || !validExportToken(snapshot.token)) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  return {
    ...snapshot,
    caller: captureAbortSignal(snapshot.signal),
    readNow: captureClock(snapshot.now),
  }
}

function canonicalDownloadUrl(value) {
  if (!boundedUtf8(value, EXPORT_URL_LIMIT_BYTES)
    || /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false
  try {
    const parsed = new URL(value)
    return parsed.href === value
      && parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.hash === ''
      && parsed.hostname !== ''
  } catch {
    return false
  }
}

function captureDownloadInput(input) {
  const snapshot = strictAdapterSnapshot(input, DOWNLOAD_INPUT_KEYS)
  if (typeof snapshot.fetch !== 'function' || !canonicalDownloadUrl(snapshot.downloadUrl)) {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  return { ...snapshot, caller: captureAbortSignal(snapshot.signal) }
}

function terminalOutcome(factory, isActive) {
  let dependency
  try {
    dependency = factory()
  } catch {
    return Promise.resolve(isActive() ? { kind: 'rejected' } : { kind: 'lost' })
  }
  return Promise.resolve(dependency).then(
    (value) => (isActive() ? { kind: 'fulfilled', value } : { kind: 'lost' }),
    () => (isActive() ? { kind: 'rejected' } : { kind: 'lost' }),
  )
}

async function boundedDependency({
  caller,
  deadlineMs,
  beforeMs,
  readNow,
  factory,
  rejectionCode,
}) {
  if (beforeMs >= deadlineMs) adapterFail('BACKUP_EXPORT_TIMEOUT')
  if (caller.aborted()) adapterFail(rejectionCode)
  let settleBoundary
  let active = true
  const boundary = new Promise((resolve) => { settleBoundary = resolve })
  const onAbort = () => {
    active = false
    settleBoundary('caller')
  }
  caller.add(onAbort)
  const timer = setTimeout(() => {
    active = false
    settleBoundary('deadline')
  }, deadlineMs - beforeMs)
  const observed = terminalOutcome(factory, () => active)
  try {
    const winner = await Promise.race([
      observed,
      boundary.then((source) => ({ kind: 'boundary', source })),
    ])
    active = false
    const observedNow = readNow()
    if (observedNow >= deadlineMs) adapterFail('BACKUP_EXPORT_TIMEOUT')
    if (caller.aborted()) adapterFail(rejectionCode)
    if (winner.kind === 'boundary') adapterFail(rejectionCode)
    if (winner.kind === 'rejected') adapterFail(rejectionCode)
    return { value: winner.value, observedNow }
  } finally {
    active = false
    clearTimeout(timer)
    caller.remove(onAbort)
  }
}

function requestDeadlineScope(runtime, deadlineMs, beforeMs) {
  if (beforeMs >= deadlineMs) adapterFail('BACKUP_EXPORT_TIMEOUT')
  if (runtime.caller.aborted()) adapterFail('BACKUP_EXPORT_START_FAILED')
  const controller = new AbortController()
  let settleBoundary
  let deactivateCurrent = null
  let closed = false
  const boundary = new Promise((resolve) => { settleBoundary = resolve })
  const onAbort = () => {
    deactivateCurrent?.()
    try { controller.abort() } catch {}
    settleBoundary('caller')
  }
  runtime.caller.add(onAbort)
  const timer = setTimeout(() => {
    deactivateCurrent?.()
    try { controller.abort() } catch {}
    settleBoundary('deadline')
  }, deadlineMs - beforeMs)
  return {
    signal: controller.signal,
    async run(factory, rejectionCode, operationMs) {
      if (closed) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      if (operationMs >= deadlineMs) adapterFail('BACKUP_EXPORT_TIMEOUT')
      if (runtime.caller.aborted()) adapterFail(rejectionCode)
      let active = true
      const deactivate = () => { active = false }
      deactivateCurrent = deactivate
      const observed = terminalOutcome(factory, () => active)
      try {
        const winner = await Promise.race([
          observed,
          boundary.then((source) => ({ kind: 'boundary', source })),
        ])
        active = false
        const observedNow = runtime.readNow()
        if (observedNow >= deadlineMs) adapterFail('BACKUP_EXPORT_TIMEOUT')
        if (runtime.caller.aborted()) adapterFail('BACKUP_EXPORT_START_FAILED')
        if (winner.kind === 'boundary') adapterFail('BACKUP_EXPORT_START_FAILED')
        if (winner.kind === 'rejected') adapterFail(rejectionCode)
        return winner.value
      } finally {
        active = false
        if (deactivateCurrent === deactivate) deactivateCurrent = null
      }
    },
    close() {
      if (closed) return
      closed = true
      clearTimeout(timer)
      runtime.caller.remove(onAbort)
    },
  }
}

function responseTransportFacts(response) {
  if (response === null || (typeof response !== 'object' && typeof response !== 'function')) {
    adapterFail('BACKUP_EXPORT_START_FAILED')
  }
  let redirected
  let ok
  let status
  try {
    redirected = response.redirected
    ok = response.ok
    status = response.status
  } catch {
    adapterFail('BACKUP_EXPORT_START_FAILED')
  }
  if (redirected !== false
    || typeof ok !== 'boolean'
    || !Number.isInteger(status) || status < 100 || status > 599
    || ok !== (status >= 200 && status < 300)
    || !ok) adapterFail('BACKUP_EXPORT_START_FAILED')
  return response
}

function responseBodyFacts(response) {
  let headers
  let body
  try {
    headers = response.headers
    body = response.body
  } catch {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  let getHeader
  try { getHeader = headers?.get } catch { adapterFail('BACKUP_EXPORT_RESPONSE_INVALID') }
  if (typeof getHeader !== 'function') adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  let contentType
  let contentLength
  try {
    contentType = getHeader.call(headers, 'content-type')
    contentLength = getHeader.call(headers, 'content-length')
  } catch {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  if (typeof contentType !== 'string' || !JSON_MEDIA_TYPE.test(contentType)) {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  if (contentLength !== null) {
    if (typeof contentLength !== 'string' || !/^(?:0|[1-9]\d*)$/.test(contentLength)) {
      adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    }
    const declared = Number(contentLength)
    if (!Number.isSafeInteger(declared) || declared > EXPORT_JSON_LIMIT_BYTES) {
      adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    }
  }
  let locked
  let getReader
  try {
    locked = body?.locked
    getReader = body?.getReader
  } catch {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  if (body === null || locked !== false || typeof getReader !== 'function') {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  return { body, getReader }
}

function readerResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  let descriptors
  try { descriptors = Object.getOwnPropertyDescriptors(result) } catch {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== 2 || !keys.includes('done') || !keys.includes('value')
    || keys.some((key) => typeof key !== 'string')) {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  const doneDescriptor = descriptors.done
  const valueDescriptor = descriptors.value
  if (!doneDescriptor?.enumerable || !Object.hasOwn(doneDescriptor, 'value')
    || typeof doneDescriptor.value !== 'boolean'
    || (valueDescriptor && (!valueDescriptor.enumerable || !Object.hasOwn(valueDescriptor, 'value')))) {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  return { done: doneDescriptor.value, value: valueDescriptor?.value }
}

function scanJsonString(text, start, decode) {
  let index = start + 1
  let value = ''
  while (index < text.length) {
    const character = text[index]
    if (character === '"') return { index: index + 1, value }
    if (character.charCodeAt(0) < 0x20) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    if (character !== '\\') {
      if (decode) value += character
      index += 1
      continue
    }
    index += 1
    if (index >= text.length) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    const escape = text[index]
    const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
    if (Object.hasOwn(simple, escape)) {
      if (decode) value += simple[escape]
      index += 1
      continue
    }
    if (escape !== 'u' || !/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
      adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    }
    if (decode) value += String.fromCharCode(Number.parseInt(text.slice(index + 1, index + 5), 16))
    index += 5
  }
  adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
}

function rejectDuplicateEnvelopeKeys(text) {
  let index = 0
  const skipSpace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[index])) index += 1
  }
  const scanValue = (watch, depth) => {
    if (depth > EXPORT_JSON_DEPTH_LIMIT) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    skipSpace()
    if (text[index] === '{') {
      scanObject(watch, depth + 1)
      return
    }
    if (text[index] === '[') {
      index += 1
      skipSpace()
      if (text[index] === ']') { index += 1; return }
      while (index < text.length) {
        scanValue(null, depth + 1)
        skipSpace()
        if (text[index] === ']') { index += 1; return }
        if (text[index] !== ',') adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
        index += 1
      }
      adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    }
    if (text[index] === '"') {
      index = scanJsonString(text, index, false).index
      return
    }
    const start = index
    while (index < text.length && !/[\u0009\u000a\u000d\u0020,\]}]/.test(text[index])) index += 1
    if (index === start) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  const scanObject = (watch, depth) => {
    index += 1
    const keys = watch ? new Set() : null
    skipSpace()
    if (text[index] === '}') { index += 1; return }
    while (index < text.length) {
      skipSpace()
      if (text[index] !== '"') adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      const scanned = scanJsonString(text, index, true)
      const key = scanned.value
      index = scanned.index
      if (keys?.has(key)) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      keys?.add(key)
      skipSpace()
      if (text[index] !== ':') adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      index += 1
      scanValue(watch === 'top' && key === 'result' ? 'result' : null, depth)
      skipSpace()
      if (text[index] === '}') { index += 1; return }
      if (text[index] !== ',') adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      index += 1
    }
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  scanValue('top', 0)
  skipSpace()
  if (index !== text.length) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
}

async function boundedJson(response, runtime, deadlineMs, requestScope) {
  const { body, getReader } = responseBodyFacts(response)
  let reader
  const chunks = []
  let total = 0
  let completed = false
  try {
    try { reader = getReader.call(body) } catch { adapterFail('BACKUP_EXPORT_RESPONSE_INVALID') }
    if (reader === null || (typeof reader !== 'object' && typeof reader !== 'function')) {
      adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    }
    let read
    try { read = reader.read } catch { adapterFail('BACKUP_EXPORT_RESPONSE_INVALID') }
    if (typeof read !== 'function') adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    while (true) {
      const beforeMs = runtime.readNow()
      const raw = await requestScope.run(
        () => read.call(reader),
        'BACKUP_EXPORT_RESPONSE_INVALID',
        beforeMs,
      )
      const part = readerResult(raw)
      if (part.done) break
      if (!(part.value instanceof Uint8Array)) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      if (part.value.byteLength === 0) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      total += part.value.byteLength
      if (total > EXPORT_JSON_LIMIT_BYTES) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
      chunks.push(part.value)
    }
    completed = true
  } finally {
    if (reader) {
      if (!completed) {
        try {
          const cancellation = reader.cancel?.()
          Promise.resolve(cancellation).then(() => undefined, () => undefined)
        } catch {}
      }
      try { reader.releaseLock?.() } catch {}
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  } finally {
    bytes.fill(0)
  }
  rejectDuplicateEnvelopeKeys(text)
  try {
    return JSON.parse(text)
  } catch {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
}

function parsedExactObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const names = Reflect.ownKeys(descriptors)
  if (names.length !== keys.length || names.some((name) => typeof name !== 'string')
    || !keys.every((key) => Object.hasOwn(descriptors, key))) {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  const result = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    }
    result[key] = descriptor.value
  }
  return result
}

function validBookmark(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= EXPORT_BOOKMARK_LIMIT_BYTES
    && /^[\x00-\x7f]+$/.test(value)
}

function validFilename(value) {
  return typeof value === 'string'
    && value.length >= 1
    && boundedUtf8(value, EXPORT_FILENAME_LIMIT_BYTES)
    && !/[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
}

function exportEnvelope(value, firstBookmark) {
  const envelope = parsedExactObject(value, ['errors', 'messages', 'result', 'success'])
  if (!Array.isArray(envelope.errors) || !Array.isArray(envelope.messages)
    || typeof envelope.success !== 'boolean') adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  if (envelope.success !== true) adapterFail('BACKUP_EXPORT_START_FAILED')
  const resultKeys = Reflect.ownKeys(envelope.result ?? {})
  if (resultKeys.length === 1 && resultKeys[0] === 'at_bookmark') {
    const result = parsedExactObject(envelope.result, ['at_bookmark'])
    if (!validBookmark(result.at_bookmark)
      || (firstBookmark !== null && result.at_bookmark !== firstBookmark)) {
      adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    }
    return { complete: false, atBookmark: result.at_bookmark }
  }
  const result = parsedExactObject(envelope.result, ['at_bookmark', 'filename', 'signed_url'])
  if (!validBookmark(result.at_bookmark)
    || (firstBookmark !== null && result.at_bookmark !== firstBookmark)
    || !validFilename(result.filename)
    || !canonicalDownloadUrl(result.signed_url)) adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  return { complete: true, atBookmark: result.at_bookmark, downloadUrl: result.signed_url }
}

async function exportRequest(runtime, endpoint, body, deadlineMs, beforeMs, firstBookmark) {
  const scope = requestDeadlineScope(runtime, deadlineMs, beforeMs)
  try {
    const response = await scope.run(() => Reflect.apply(runtime.fetch, undefined, [
      endpoint,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: scope.signal,
      },
    ]), 'BACKUP_EXPORT_START_FAILED', beforeMs)
    responseTransportFacts(response)
    return exportEnvelope(
      await boundedJson(response, runtime, deadlineMs, scope),
      firstBookmark,
    )
  } finally {
    scope.close()
  }
}

async function pollCaptured(runtime) {
  const endpoint = `${EXPORT_ENDPOINT_ORIGIN}/accounts/${runtime.accountId}/d1/database/${runtime.databaseId}/export`
  const startBody = '{"output_format":"polling"}'
  const startMs = runtime.readNow()
  if (!Number.isSafeInteger(startMs + EXPORT_DEADLINE_MS)) {
    adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
  }
  const deadlineMs = startMs + EXPORT_DEADLINE_MS
  let response = await exportRequest(runtime, endpoint, startBody, deadlineMs, startMs, null)
  const firstBookmark = response.atBookmark
  let pollCount = 0
  while (!response.complete) {
    const beforeWait = runtime.readNow()
    if (beforeWait >= deadlineMs || deadlineMs - beforeWait < EXPORT_POLL_INTERVAL_MS) {
      adapterFail('BACKUP_EXPORT_TIMEOUT')
    }
    const waited = await boundedDependency({
      caller: runtime.caller,
      deadlineMs,
      beforeMs: beforeWait,
      readNow: runtime.readNow,
      factory: () => Reflect.apply(runtime.wait, undefined, [EXPORT_POLL_INTERVAL_MS]),
      rejectionCode: 'BACKUP_EXPORT_START_FAILED',
    })
    if (waited.observedNow - beforeWait < EXPORT_POLL_INTERVAL_MS) {
      adapterFail('BACKUP_EXPORT_RESPONSE_INVALID')
    }
    if (pollCount >= EXPORT_POLL_LIMIT) adapterFail('BACKUP_EXPORT_TIMEOUT')
    const beforeFetch = runtime.readNow()
    if (beforeFetch >= deadlineMs) adapterFail('BACKUP_EXPORT_TIMEOUT')
    pollCount += 1
    const pollBody = JSON.stringify({
      current_bookmark: firstBookmark,
      output_format: 'polling',
    })
    response = await exportRequest(
      runtime,
      endpoint,
      pollBody,
      deadlineMs,
      beforeFetch,
      firstBookmark,
    )
  }
  return { downloadUrl: response.downloadUrl, atBookmark: response.atBookmark }
}

export async function pollD1Export(input) {
  try {
    return await pollCaptured(captureExportInput(input))
  } catch (error) {
    rethrowAdapter(error)
  }
}

async function downloadCaptured(runtime) {
  if (runtime.caller.aborted()) adapterFail('BACKUP_EXPORT_DOWNLOAD_FAILED')
  let active = true
  let settleAbort
  const aborted = new Promise((resolve) => { settleAbort = resolve })
  const onAbort = () => {
    active = false
    settleAbort({ kind: 'aborted' })
  }
  runtime.caller.add(onAbort)
  const observed = terminalOutcome(() => Reflect.apply(runtime.fetch, undefined, [
    runtime.downloadUrl,
    {
      method: 'GET',
      redirect: 'error',
      signal: runtime.signal,
    },
  ]), () => active)
  let winner
  try {
    winner = await Promise.race([observed, aborted])
  } finally {
    active = false
    runtime.caller.remove(onAbort)
  }
  if (winner.kind !== 'fulfilled') adapterFail('BACKUP_EXPORT_DOWNLOAD_FAILED')
  const response = winner.value
  if (response === null || (typeof response !== 'object' && typeof response !== 'function')) {
    adapterFail('BACKUP_EXPORT_DOWNLOAD_FAILED')
  }
  let redirected
  let ok
  let status
  let body
  let bodyUsed
  try {
    redirected = response.redirected
    ok = response.ok
    status = response.status
    body = response.body
    bodyUsed = response.bodyUsed
  } catch {
    adapterFail('BACKUP_EXPORT_DOWNLOAD_FAILED')
  }
  if (redirected === true) adapterFail('BACKUP_EXPORT_REDIRECTED')
  if (redirected !== false
    || typeof ok !== 'boolean'
    || !Number.isInteger(status) || status < 100 || status > 599
    || ok !== (status >= 200 && status < 300)
    || !ok
    || bodyUsed !== false
    || !(body instanceof ReadableStream)) adapterFail('BACKUP_EXPORT_DOWNLOAD_FAILED')
  let locked
  try { locked = body.locked } catch { adapterFail('BACKUP_EXPORT_DOWNLOAD_FAILED') }
  if (locked !== false) adapterFail('BACKUP_EXPORT_DOWNLOAD_FAILED')
  return { body }
}

export async function downloadD1Export(input) {
  try {
    return await downloadCaptured(captureDownloadInput(input))
  } catch (error) {
    rethrowAdapter(error)
  }
}
