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
