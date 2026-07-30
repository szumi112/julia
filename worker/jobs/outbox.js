import { isD1OutboxOperationGuardFailure } from '../db/errors.js'
import { decodeBase64Url, encodeBase64Url } from '../security/encoding.js'
import { decryptForScope, encryptForScope } from '../security/envelope.js'

export const OUTBOX_TYPES = Object.freeze([
  'staff.access.reconcile',
  'staff.invitation.email',
  'staff.invitation.expire',
])

const OUTBOX_TYPE_SET = new Set(OUTBOX_TYPES)
const RETRY_DELAYS = Object.freeze([
  60_000,
  300_000,
  900_000,
  3_600_000,
  21_600_000,
  21_600_000,
  21_600_000,
])
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const INVITATION_ID = /^inv_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const TYPE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~:-]{7,255}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_ATTEMPTS = 8
const CLAIM_LIMIT = 10
const CLAIM_SCAN_LIMIT = 100
const LEASE_MS = 60_000
const MAX_PAYLOAD_BYTES = 1024
const statementDescriptors = new WeakMap()

const invalid = () => { throw new Error('OUTBOX_INVALID') }
const invalidState = () => { throw new Error('OUTBOX_STATE_INVALID') }
const ownObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const validId = (value) => typeof value === 'string' && ID.test(value)
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const instantFromMs = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  let result
  try { result = new Date(value).toISOString() } catch { invalid() }
  return result
}
const idFrom = (factory) => {
  if (typeof factory !== 'function') invalid()
  const value = factory()
  if (!validId(value)) invalid()
  return value
}
const canonicalize = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalize)
  if (ownObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  invalid()
}
const canonicalJson = (value) => JSON.stringify(canonicalize(value))
const validErrorCode = (value) => typeof value === 'string' && ERROR_CODE.test(value)
const validProviderReference = (value) => value === null || validId(value)
const isAllowedType = (value) => OUTBOX_TYPE_SET.has(value)
const validStaffCryptoContext = (value) => value?.keyring
  && ownObject(value.dataKey)
  && ownObject(value.scope)
  && value.scope.type === 'staff_directory'
  && value.scope.purpose === 'identity'
  && value.dataKey.scope_type === value.scope.type
  && value.dataKey.scope_id === value.scope.id
  && value.dataKey.purpose === value.scope.purpose

export const retryDelayMs = (attempt) => RETRY_DELAYS[attempt - 1] ?? null

export const outboxStatementDescriptorFor = (statement) => {
  const descriptor = statementDescriptors.get(statement)
  return descriptor ? { ...descriptor } : null
}

function validatePayload(type, aggregateType, aggregateId, payload) {
  if (type === 'staff.access.reconcile') {
    if (aggregateType !== 'access_group' || aggregateId !== 'centre_1'
      || !exactKeys(payload, ['actorId', 'generation'])
      || !STAFF_ID.test(payload.actorId ?? '')
      || !Number.isSafeInteger(payload.generation) || payload.generation < 0) invalid()
  } else {
    if (aggregateType !== 'staff_invitation' || !INVITATION_ID.test(aggregateId ?? '')
      || !exactKeys(payload, ['actorId', 'invitationId'])
      || !STAFF_ID.test(payload.actorId ?? '')
      || payload.invitationId !== aggregateId) invalid()
  }
  const canonical = canonicalJson(payload)
  if (new TextEncoder().encode(canonical).byteLength > MAX_PAYLOAD_BYTES) invalid()
  return canonical
}

function validateEnqueueInput(input) {
  const required = [
    'id',
    'type',
    'aggregateType',
    'aggregateId',
    'payload',
    'idempotencyKey',
    'scheduledAt',
    'nowMs',
  ]
  const optional = ['maxAttempts', 'onlyIfPreviousStatementChanged']
  if (!ownObject(input)
    || !required.every((key) => Object.hasOwn(input, key))
    || Object.keys(input).some((key) => !required.includes(key) && !optional.includes(key))
    || !validId(input.id)
    || !isAllowedType(input.type)
    || !TYPE.test(input.aggregateType ?? '')
    || !validId(input.aggregateId)
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey ?? '')
    || !validInstant(input.scheduledAt)) invalid()
  const maxAttempts = input.maxAttempts ?? MAX_ATTEMPTS
  const conditional = input.onlyIfPreviousStatementChanged ?? false
  if (maxAttempts !== MAX_ATTEMPTS || typeof conditional !== 'boolean'
    || (conditional && input.type !== 'staff.access.reconcile')) invalid()
  const now = instantFromMs(input.nowMs)
  return {
    maxAttempts,
    conditional,
    now,
    payload: validatePayload(input.type, input.aggregateType, input.aggregateId, input.payload),
  }
}

export async function enqueueOutboxStatement(db, cryptoContext, input) {
  if (!db?.prepare || !validStaffCryptoContext(cryptoContext)) invalid()
  const validated = validateEnqueueInput(input)
  const envelope = JSON.stringify(await encryptForScope(
    cryptoContext.keyring,
    cryptoContext.dataKey,
    {
      expectedScope: cryptoContext.scope,
      recordId: input.id,
      field: 'job_payload',
      plaintext: validated.payload,
    }
  ))
  const values = validated.conditional
    ? "SELECT ?,?,?,?,?,?,'queued',0,?,?,?,? WHERE changes()=1"
    : "VALUES (?,?,?,?,?,?,'queued',0,?,?,?,?)"
  const statement = db.prepare(
    `INSERT INTO outbox_jobs
     (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
      attempt_count,max_attempts,scheduled_at,created_at,updated_at)
     ${values}`
  ).bind(
    input.id,
    input.type,
    input.aggregateType,
    input.aggregateId,
    envelope,
    input.idempotencyKey,
    validated.maxAttempts,
    input.scheduledAt,
    validated.now,
    validated.now,
  )
  statementDescriptors.set(statement, Object.freeze({
    conditional: validated.conditional,
    type: input.type,
  }))
  return statement
}

const operationGuard = (db, operationId, predicate, bindings) => db.prepare(
  `INSERT INTO outbox_operation_guard_failures (operation_id)
   SELECT ? WHERE NOT (${predicate})`
).bind(operationId, ...bindings)

function validEnvelope(value) {
  if (typeof value !== 'string' || value.length > 4096) return false
  try {
    const envelope = JSON.parse(value)
    return exactKeys(envelope, [
      'format',
      'algorithm',
      'dataKeyId',
      'dataKeyVersion',
      'nonce',
      'ciphertext',
    ])
      && envelope.format === 1
      && envelope.algorithm === 'A256GCM'
      && validId(envelope.dataKeyId)
      && Number.isSafeInteger(envelope.dataKeyVersion)
      && envelope.dataKeyVersion > 0
      && validEncodedBytes(envelope.nonce, 12, 12)
      && validEncodedBytes(envelope.ciphertext, 16)
  } catch {
    return false
  }
}

function validEncodedBytes(value, minimum, exact = null) {
  if (typeof value !== 'string') return false
  let decoded
  try {
    decoded = decodeBase64Url(value)
    return decoded.byteLength >= minimum
      && (exact === null || decoded.byteLength === exact)
      && encodeBase64Url(decoded) === value
  } catch {
    return false
  } finally {
    decoded?.fill(0)
  }
}

function validQueuedJob(row, now) {
  return ownObject(row)
    && validId(row.id)
    && TYPE.test(row.type ?? '')
    && TYPE.test(row.aggregate_type ?? '')
    && validId(row.aggregate_id)
    && validEnvelope(row.payload_envelope)
    && IDEMPOTENCY_KEY.test(row.idempotency_key ?? '')
    && row.status === 'queued'
    && Number.isSafeInteger(row.attempt_count)
    && Number.isSafeInteger(row.max_attempts)
    && row.attempt_count >= 0
    && row.attempt_count < row.max_attempts
    && row.max_attempts >= 1
    && row.max_attempts <= MAX_ATTEMPTS
    && validInstant(row.scheduled_at)
    && row.scheduled_at <= now
    && row.lease_owner === null
    && row.lease_expires_at === null
}

function validProcessingJob(row, { allowUnknownType = false } = {}) {
  return ownObject(row)
    && validId(row.id)
    && (allowUnknownType ? TYPE.test(row.type ?? '') : isAllowedType(row.type))
    && TYPE.test(row.aggregate_type ?? '')
    && validId(row.aggregate_id)
    && validEnvelope(row.payload_envelope)
    && IDEMPOTENCY_KEY.test(row.idempotency_key ?? '')
    && row.status === 'processing'
    && Number.isSafeInteger(row.attempt_count)
    && Number.isSafeInteger(row.max_attempts)
    && row.attempt_count >= 1
    && row.attempt_count <= row.max_attempts
    && row.max_attempts >= 1
    && row.max_attempts <= MAX_ATTEMPTS
    && validId(row.lease_owner)
    && validInstant(row.lease_expires_at)
}

function validateClaimInput(input) {
  if (!ownObject(input)
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || typeof input.idFactory !== 'function'
    || typeof input.leaseOwnerFactory !== 'function'
    || !Number.isSafeInteger(input.limit) || input.limit < 1) invalid()
  return {
    now: instantFromMs(input.nowMs),
    expiry: instantFromMs(input.nowMs + LEASE_MS),
    limit: Math.min(CLAIM_LIMIT, input.limit),
  }
}

export async function claimDueJobs(db, input = {}) {
  if (!db?.prepare || !db?.batch) invalid()
  const validated = validateClaimInput(input)
  const rows = (await db.prepare(
    `SELECT *
     FROM outbox_jobs
     WHERE status='queued' AND scheduled_at<=? AND attempt_count<max_attempts
     ORDER BY scheduled_at,id
     LIMIT ?`
  ).bind(validated.now, CLAIM_SCAN_LIMIT).all()).results
  const claimed = []
  const leaseOwners = new Set()
  for (const row of rows) {
    if (claimed.length >= validated.limit) break
    if (!validQueuedJob(row, validated.now)) continue
    const leaseOwner = idFrom(input.leaseOwnerFactory)
    const attemptId = idFrom(input.idFactory)
    if (leaseOwners.has(leaseOwner)) invalid()
    leaseOwners.add(leaseOwner)
    const attemptNumber = row.attempt_count + 1
    const statements = [
      db.prepare(
        `UPDATE outbox_jobs
         SET status='processing',lease_owner=?,lease_expires_at=?,
             attempt_count=attempt_count+1,updated_at=?
         WHERE id=? AND status='queued' AND attempt_count=? AND max_attempts=?
           AND scheduled_at=? AND scheduled_at<=?
           AND lease_owner IS NULL AND lease_expires_at IS NULL`
      ).bind(
        leaseOwner,
        validated.expiry,
        validated.now,
        row.id,
        row.attempt_count,
        row.max_attempts,
        row.scheduled_at,
        validated.now,
      ),
      db.prepare(
        `INSERT INTO outbox_attempts
         (id,job_id,attempt_number,started_at)
         SELECT ?,?,?,? WHERE changes()=1`
      ).bind(attemptId, row.id, attemptNumber, validated.now),
      operationGuard(
        db,
        `claim_${row.id}`,
        `changes()=1
         AND EXISTS (
           SELECT 1 FROM outbox_jobs
           WHERE id=? AND status='processing' AND attempt_count=?
             AND lease_owner=? AND lease_expires_at=? AND updated_at=?
         )
         AND EXISTS (
           SELECT 1 FROM outbox_attempts
           WHERE id=? AND job_id=? AND attempt_number=? AND started_at=?
             AND completed_at IS NULL AND result IS NULL
         )
         AND (
           SELECT count(*) FROM outbox_attempts
           WHERE job_id=? AND completed_at IS NULL
         )=1`,
        [
          row.id,
          attemptNumber,
          leaseOwner,
          validated.expiry,
          validated.now,
          attemptId,
          row.id,
          attemptNumber,
          validated.now,
          row.id,
        ],
      ),
    ]
    try {
      await db.batch(statements)
    } catch (error) {
      if (isD1OutboxOperationGuardFailure(error)) continue
      throw error
    }
    claimed.push({
      ...row,
      status: 'processing',
      attempt_count: attemptNumber,
      lease_owner: leaseOwner,
      lease_expires_at: validated.expiry,
      updated_at: validated.now,
      attemptId,
      attemptNumber,
      leaseOwner,
    })
  }
  return claimed
}

async function openAttempt(db, jobId) {
  const rows = (await db.prepare(
    `SELECT *
     FROM outbox_attempts
     WHERE job_id=? AND completed_at IS NULL
     ORDER BY attempt_number,id`
  ).bind(jobId).all()).results
  if (rows.length !== 1) {
    const current = await db.prepare(
      'SELECT status FROM outbox_jobs WHERE id=?'
    ).bind(jobId).first()
    if (current && current.status !== 'processing') return null
    invalidState()
  }
  return rows[0]
}

async function actionFor(db, cryptoContext, input) {
  if (!validStaffCryptoContext(cryptoContext)) invalid()
  const fingerprint = `outbox.dead:${input.jobId}`
  const details = canonicalJson({
    errorCode: input.errorCode,
    jobId: input.jobId,
    outboxType: input.outboxType,
  })
  const existing = await db.prepare(
    `SELECT *
     FROM operational_actions
     WHERE fingerprint=? AND status='open'`
  ).bind(fingerprint).first()
  if (existing) {
    if (!validId(existing.id)
      || existing.fingerprint !== fingerprint
      || existing.kind !== 'outbox_job_failed'
      || existing.severity !== 'critical'
      || existing.status !== 'open'
      || existing.entity_type !== 'outbox_job'
      || existing.entity_id !== input.jobId
      || !Number.isSafeInteger(existing.version) || existing.version < 1
      || !validInstant(existing.created_at)
      || !validInstant(existing.updated_at)
      || existing.updated_at < existing.created_at
      || existing.resolved_at !== null) invalidState()
    let decrypted
    try {
      decrypted = await decryptForScope(
        cryptoContext.keyring,
        cryptoContext.dataKey,
        {
          expectedScope: cryptoContext.scope,
          recordId: existing.id,
          field: 'action_details',
          envelope: JSON.parse(existing.details_envelope),
        }
      )
    } catch {
      invalidState()
    }
    if (decrypted !== details) invalidState()
    return {
      id: existing.id,
      fingerprint,
      kind: existing.kind,
      severity: existing.severity,
      status: existing.status,
      entityType: existing.entity_type,
      entityId: existing.entity_id,
      detailsEnvelope: existing.details_envelope,
      version: existing.version,
      createdAt: existing.created_at,
      updatedAt: existing.updated_at,
      statement: null,
    }
  }
  const id = idFrom(input.idFactory)
  const detailsEnvelope = JSON.stringify(await encryptForScope(
    cryptoContext.keyring,
    cryptoContext.dataKey,
    {
      expectedScope: cryptoContext.scope,
      recordId: id,
      field: 'action_details',
      plaintext: details,
    }
  ))
  return {
    id,
    fingerprint,
    kind: 'outbox_job_failed',
    severity: 'critical',
    status: 'open',
    entityType: 'outbox_job',
    entityId: input.jobId,
    detailsEnvelope,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
    statement: db.prepare(
      `INSERT INTO operational_actions
       (id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
        version,created_at,updated_at)
       SELECT ?,?,'outbox_job_failed','critical','open','outbox_job',?,?,1,?,?
       WHERE changes()=1
         AND NOT EXISTS (
           SELECT 1 FROM operational_actions WHERE fingerprint=? AND status='open'
         )`
    ).bind(
      id,
      fingerprint,
      input.jobId,
      detailsEnvelope,
      input.now,
      input.now,
      fingerprint,
    ),
  }
}

async function reapOne(db, cryptoContext, row, now, idFactory) {
  if (!validProcessingJob(row) || row.lease_expires_at > now) invalidState()
  const attempt = await openAttempt(db, row.id)
  if (!attempt) return null
  if (attempt.attempt_number !== row.attempt_count
    || !validId(attempt.id)
    || !validInstant(attempt.started_at)
    || attempt.result !== null
    || attempt.completed_at !== null) invalidState()
  const email = row.type === 'staff.invitation.email'
  const errorCode = email ? 'EMAIL_DELIVERY_AMBIGUOUS' : 'OUTBOX_LEASE_EXPIRED'
  const attemptResult = email ? 'dead' : 'retry'
  const jobStatus = email ? 'dead' : 'queued'
  const action = email
    ? await actionFor(db, cryptoContext, {
        idFactory,
        jobId: row.id,
        outboxType: row.type,
        errorCode,
        now,
      })
    : null
  const statements = [
    db.prepare(
      `UPDATE outbox_attempts
       SET completed_at=?,result=?,error_code=?,provider_reference=NULL
       WHERE id=? AND job_id=? AND attempt_number=?
         AND completed_at IS NULL AND result IS NULL`
    ).bind(now, attemptResult, errorCode, attempt.id, row.id, row.attempt_count),
  ]
  if (action?.statement) statements.push(action.statement)
  statements.push(
    db.prepare(
      `UPDATE outbox_jobs
       SET status=?,scheduled_at=?,lease_owner=NULL,lease_expires_at=NULL,
           last_error_code=?,updated_at=?
       WHERE id=? AND status='processing' AND attempt_count=?
         AND lease_owner=? AND lease_expires_at=? AND lease_expires_at<=?
         AND EXISTS (
           SELECT 1 FROM outbox_attempts
           WHERE id=? AND job_id=? AND attempt_number=? AND completed_at=?
             AND result=? AND error_code=?
         )`
    ).bind(
      jobStatus,
      email ? row.scheduled_at : now,
      errorCode,
      now,
      row.id,
      row.attempt_count,
      row.lease_owner,
      row.lease_expires_at,
      now,
      attempt.id,
      row.id,
      row.attempt_count,
      now,
      attemptResult,
      errorCode,
    ),
  )
  const actionPredicate = action
    ? `AND EXISTS (
         SELECT 1 FROM operational_actions
         WHERE id=? AND fingerprint=? AND kind=? AND severity=? AND status=?
           AND entity_type=? AND entity_id=? AND details_envelope=?
           AND version=? AND created_at=? AND updated_at=? AND resolved_at IS NULL
       )`
    : ''
  statements.push(operationGuard(
    db,
    `reap_${row.id}`,
    `changes()=1
     AND EXISTS (
       SELECT 1 FROM outbox_jobs
       WHERE id=? AND status=? AND attempt_count=? AND scheduled_at=?
         AND lease_owner IS NULL AND lease_expires_at IS NULL
         AND last_error_code=? AND updated_at=?
     )
     AND EXISTS (
       SELECT 1 FROM outbox_attempts
       WHERE id=? AND job_id=? AND attempt_number=? AND completed_at=?
         AND result=? AND error_code=? AND provider_reference IS NULL
     )
     AND (
       SELECT count(*) FROM outbox_attempts
       WHERE job_id=? AND completed_at IS NULL
     )=0
     ${actionPredicate}`,
    [
      row.id,
      jobStatus,
      row.attempt_count,
      email ? row.scheduled_at : now,
      errorCode,
      now,
      attempt.id,
      row.id,
      row.attempt_count,
      now,
      attemptResult,
      errorCode,
      row.id,
      ...(action
        ? [
            action.id,
            action.fingerprint,
            action.kind,
            action.severity,
            action.status,
            action.entityType,
            action.entityId,
            action.detailsEnvelope,
            action.version,
            action.createdAt,
            action.updatedAt,
          ]
        : []),
    ],
  ))
  try {
    await db.batch(statements)
    return { id: row.id, result: attemptResult }
  } catch (error) {
    if (isD1OutboxOperationGuardFailure(error)) return null
    throw error
  }
}

export async function reapExpiredOutboxLeases(db, cryptoContext, input = {}) {
  if (!db?.prepare || !db?.batch || !validStaffCryptoContext(cryptoContext)
    || !exactKeys(input, ['nowMs', 'idFactory'])
    || typeof input.idFactory !== 'function') invalid()
  const now = instantFromMs(input.nowMs)
  const rows = (await db.prepare(
    `SELECT *
     FROM outbox_jobs
     WHERE status='processing' AND lease_expires_at<=?
     ORDER BY lease_expires_at,id`
  ).bind(now).all()).results
  const reaped = []
  for (const row of rows) {
    const result = await reapOne(db, cryptoContext, row, now, input.idFactory)
    if (result) reaped.push(result)
  }
  return reaped
}

function validateFinalizeInput(input) {
  if (!exactKeys(input, [
    'jobId',
    'leaseOwner',
    'attemptNumber',
    'nowMs',
    'result',
    'errorCode',
    'providerReference',
    'idFactory',
  ])
    || !validId(input.jobId)
    || !validId(input.leaseOwner)
    || !Number.isSafeInteger(input.attemptNumber)
    || input.attemptNumber < 1
    || !['succeeded', 'retry', 'dead'].includes(input.result)
    || (input.errorCode !== null && !validErrorCode(input.errorCode))
    || !validProviderReference(input.providerReference)
    || typeof input.idFactory !== 'function') invalid()
  if (input.result === 'succeeded' && input.errorCode !== null) invalid()
  return { now: instantFromMs(input.nowMs) }
}

export async function finalizeOutboxJob(db, cryptoContext, input = {}) {
  if (!db?.prepare || !db?.batch || !validStaffCryptoContext(cryptoContext)) invalid()
  const validated = validateFinalizeInput(input)
  const row = await db.prepare('SELECT * FROM outbox_jobs WHERE id=?').bind(input.jobId).first()
  if (!row || row.status !== 'processing') return false
  if (!validProcessingJob(row, { allowUnknownType: true })) invalidState()
  if (row.lease_owner !== input.leaseOwner
    || row.attempt_count !== input.attemptNumber
    || row.lease_expires_at <= validated.now) return false
  const attempt = await openAttempt(db, row.id)
  if (!attempt) return false
  if (attempt.attempt_number !== input.attemptNumber || !validId(attempt.id)) invalidState()
  const retriesRemain = input.result === 'retry'
    && input.attemptNumber < row.max_attempts
    && retryDelayMs(input.attemptNumber) !== null
  const jobStatus = retriesRemain
    ? 'queued'
    : input.result === 'succeeded'
      ? 'succeeded'
      : 'dead'
  const attemptResult = jobStatus === 'queued' ? 'retry' : jobStatus
  const scheduledAt = retriesRemain
    ? instantFromMs(input.nowMs + retryDelayMs(input.attemptNumber))
    : row.scheduled_at
  const errorCode = input.errorCode
  const action = jobStatus === 'dead'
    ? await actionFor(db, cryptoContext, {
        idFactory: input.idFactory,
        jobId: row.id,
        outboxType: row.type,
        errorCode: errorCode ?? 'OUTBOX_HANDLER_FAILURE',
        now: validated.now,
      })
    : null
  const statements = [
    db.prepare(
      `UPDATE outbox_attempts
       SET completed_at=?,result=?,error_code=?,provider_reference=?
       WHERE id=? AND job_id=? AND attempt_number=?
         AND completed_at IS NULL AND result IS NULL
         AND EXISTS (
           SELECT 1 FROM outbox_jobs
           WHERE id=? AND status='processing' AND attempt_count=?
             AND lease_owner=? AND lease_expires_at>?
         )`
    ).bind(
      validated.now,
      attemptResult,
      errorCode,
      input.providerReference,
      attempt.id,
      row.id,
      input.attemptNumber,
      row.id,
      input.attemptNumber,
      input.leaseOwner,
      validated.now,
    ),
  ]
  if (action?.statement) statements.push(action.statement)
  statements.push(
    db.prepare(
      `UPDATE outbox_jobs
       SET status=?,scheduled_at=?,lease_owner=NULL,lease_expires_at=NULL,
           last_error_code=?,updated_at=?
       WHERE id=? AND status='processing' AND attempt_count=?
         AND lease_owner=? AND lease_expires_at=? AND lease_expires_at>?
         AND EXISTS (
           SELECT 1 FROM outbox_attempts
           WHERE id=? AND job_id=? AND attempt_number=? AND completed_at=?
             AND result=? AND error_code IS ? AND provider_reference IS ?
         )`
    ).bind(
      jobStatus,
      scheduledAt,
      errorCode,
      validated.now,
      row.id,
      input.attemptNumber,
      input.leaseOwner,
      row.lease_expires_at,
      validated.now,
      attempt.id,
      row.id,
      input.attemptNumber,
      validated.now,
      attemptResult,
      errorCode,
      input.providerReference,
    ),
  )
  const actionPredicate = action
    ? `AND EXISTS (
         SELECT 1 FROM operational_actions
         WHERE id=? AND fingerprint=? AND kind=? AND severity=? AND status=?
           AND entity_type=? AND entity_id=? AND details_envelope=?
           AND version=? AND created_at=? AND updated_at=? AND resolved_at IS NULL
       )`
    : ''
  statements.push(operationGuard(
    db,
    `finalize_${row.id}`,
    `changes()=1
     AND EXISTS (
       SELECT 1 FROM outbox_jobs
       WHERE id=? AND status=? AND attempt_count=? AND scheduled_at=?
         AND lease_owner IS NULL AND lease_expires_at IS NULL
         AND last_error_code IS ? AND updated_at=?
     )
     AND EXISTS (
       SELECT 1 FROM outbox_attempts
       WHERE id=? AND job_id=? AND attempt_number=? AND completed_at=?
         AND result=? AND error_code IS ? AND provider_reference IS ?
     )
     AND (
       SELECT count(*) FROM outbox_attempts
       WHERE job_id=? AND completed_at IS NULL
     )=0
     ${actionPredicate}`,
    [
      row.id,
      jobStatus,
      input.attemptNumber,
      scheduledAt,
      errorCode,
      validated.now,
      attempt.id,
      row.id,
      input.attemptNumber,
      validated.now,
      attemptResult,
      errorCode,
      input.providerReference,
      row.id,
      ...(action
        ? [
            action.id,
            action.fingerprint,
            action.kind,
            action.severity,
            action.status,
            action.entityType,
            action.entityId,
            action.detailsEnvelope,
            action.version,
            action.createdAt,
            action.updatedAt,
          ]
        : []),
    ],
  ))
  try {
    await db.batch(statements)
    return true
  } catch (error) {
    if (isD1OutboxOperationGuardFailure(error)) return false
    throw error
  }
}

export const completeOutboxJob = finalizeOutboxJob

function normalizedOutcome(outcome) {
  if (ownObject(outcome) && outcome.result === 'succeeded') {
    return { result: 'succeeded', errorCode: null, providerReference: null }
  }
  if (ownObject(outcome) && outcome.result === 'retry') {
    return { result: 'retry', errorCode: 'OUTBOX_HANDLER_RETRY', providerReference: null }
  }
  if (ownObject(outcome) && outcome.result === 'dead'
    && outcome.errorCode === 'EMAIL_DELIVERY_AMBIGUOUS') {
    return { result: 'dead', errorCode: 'EMAIL_DELIVERY_AMBIGUOUS', providerReference: null }
  }
  return { result: 'dead', errorCode: 'OUTBOX_HANDLER_FAILURE', providerReference: null }
}

function thrownOutcome(error) {
  if (error?.message === 'EMAIL_DELIVERY_AMBIGUOUS') {
    return { result: 'dead', errorCode: 'EMAIL_DELIVERY_AMBIGUOUS', providerReference: null }
  }
  if (error?.retryable === true) {
    return { result: 'retry', errorCode: 'OUTBOX_HANDLER_RETRY', providerReference: null }
  }
  return { result: 'dead', errorCode: 'OUTBOX_HANDLER_FAILURE', providerReference: null }
}

async function currentOwnedClaim(db, claim, nowMs) {
  const now = instantFromMs(nowMs)
  const row = await db.prepare('SELECT * FROM outbox_jobs WHERE id=?').bind(claim.id).first()
  if (!row
    || row.status !== 'processing'
    || row.lease_owner !== claim.leaseOwner
    || row.attempt_count !== claim.attemptNumber
    || !validInstant(row.lease_expires_at)
    || row.lease_expires_at <= now) return null
  if (!validProcessingJob(row, { allowUnknownType: true })) invalidState()
  const attempt = await openAttempt(db, row.id)
  if (!attempt) return null
  if (attempt.id !== claim.attemptId
    || attempt.attempt_number !== claim.attemptNumber
    || attempt.completed_at !== null
    || attempt.result !== null) invalidState()
  return {
    ...row,
    attemptId: claim.attemptId,
    attemptNumber: claim.attemptNumber,
    leaseOwner: claim.leaseOwner,
  }
}

export async function processOutboxBatch(input = {}) {
  if (!ownObject(input)
    || !input.db?.prepare || !input.db?.batch
    || !validStaffCryptoContext(input.cryptoContext)
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || typeof input.idFactory !== 'function'
    || typeof input.leaseOwnerFactory !== 'function'
    || typeof input.dispatch !== 'function'
    || (input.nowFactory !== undefined && typeof input.nowFactory !== 'function')) invalid()
  const nowFactory = input.nowFactory ?? Date.now
  const currentMs = () => {
    const value = nowFactory()
    if (!Number.isSafeInteger(value) || value < 0) invalid()
    return Math.max(input.nowMs, value)
  }
  await reapExpiredOutboxLeases(input.db, input.cryptoContext, {
    nowMs: input.nowMs,
    idFactory: input.idFactory,
  })
  const claims = await claimDueJobs(input.db, {
    nowMs: input.nowMs,
    idFactory: input.idFactory,
    leaseOwnerFactory: input.leaseOwnerFactory,
    limit: CLAIM_LIMIT,
  })
  const completed = []
  for (const claim of claims) {
    const dispatchNowMs = currentMs()
    const currentClaim = await currentOwnedClaim(input.db, claim, dispatchNowMs)
    if (!currentClaim) continue
    let outcome
    if (!isAllowedType(currentClaim.type)) {
      outcome = {
        result: 'dead',
        errorCode: 'OUTBOX_TYPE_INVALID',
        providerReference: null,
      }
    } else {
      try {
        outcome = normalizedOutcome(await input.dispatch({
          db: input.db,
          cryptoContext: input.cryptoContext,
          config: input.config,
          job: currentClaim,
          nowMs: dispatchNowMs,
        }))
      } catch (error) {
        outcome = thrownOutcome(error)
      }
    }
    const finalized = await finalizeOutboxJob(input.db, input.cryptoContext, {
      jobId: claim.id,
      leaseOwner: claim.leaseOwner,
      attemptNumber: claim.attemptNumber,
      nowMs: currentMs(),
      result: outcome.result,
      errorCode: outcome.errorCode,
      providerReference: outcome.providerReference,
      idFactory: input.idFactory,
    })
    if (finalized) completed.push({ id: claim.id, result: outcome.result })
  }
  return completed
}
