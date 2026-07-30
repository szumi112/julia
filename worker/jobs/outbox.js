import { auditEventStatement } from '../audit/events.js'
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
const EMAIL_LOOKUP = /^v[1-9]\d*:[A-Za-z0-9_-]{43}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const PROVIDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_ATTEMPTS = 8
const CLAIM_LIMIT = 10
const CLAIM_SCAN_LIMIT = 100
const LEASE_MS = 60_000
const MAX_PAYLOAD_BYTES = 1024
const statementDescriptors = new WeakMap()
const OUTBOX_JOB_ROW_KEYS = Object.freeze([
  'id',
  'type',
  'aggregate_type',
  'aggregate_id',
  'payload_envelope',
  'idempotency_key',
  'status',
  'attempt_count',
  'max_attempts',
  'scheduled_at',
  'lease_owner',
  'lease_expires_at',
  'last_error_code',
  'created_at',
  'updated_at',
])
const OUTBOX_ATTEMPT_ROW_KEYS = Object.freeze([
  'id',
  'job_id',
  'attempt_number',
  'started_at',
  'completed_at',
  'result',
  'error_code',
  'provider_reference',
])

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
const nullableInstant = (value) => value === null || validInstant(value)
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
const emailJobKey = (invitationId, version) => (
  `staff.invitation.email:${invitationId}:${version}`
)
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

export async function decryptOutboxPayload(cryptoContext, job) {
  if (!validStaffCryptoContext(cryptoContext)
    || !ownObject(job)
    || !validId(job.id)
    || !isAllowedType(job.type)
    || !TYPE.test(job.aggregate_type ?? '')
    || !validId(job.aggregate_id)
    || !validEnvelope(job.payload_envelope)) invalid()
  let plaintext
  let payload
  try {
    plaintext = await decryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: cryptoContext.scope,
        recordId: job.id,
        field: 'job_payload',
        envelope: JSON.parse(job.payload_envelope),
      },
    )
    payload = JSON.parse(plaintext)
    const canonical = validatePayload(
      job.type,
      job.aggregate_type,
      job.aggregate_id,
      payload,
    )
    if (canonical !== plaintext) invalid()
    return JSON.parse(canonical)
  } catch (error) {
    if (error?.message === 'OUTBOX_INVALID') throw error
    invalid()
  }
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

export function validProcessingJob(row, { allowUnknownType = false } = {}) {
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

function validateAcceptedEmailInput(input) {
  const required = [
    'jobId',
    'leaseOwner',
    'attemptNumber',
    'nowMs',
    'providerId',
    'idFactory',
  ]
  if (!ownObject(input)
    || !required.every((key) => Object.hasOwn(input, key))
    || Object.keys(input).some((key) => !required.includes(key) && key !== 'nowFactory')
    || !validId(input.jobId)
    || !validId(input.leaseOwner)
    || !Number.isSafeInteger(input.attemptNumber)
    || input.attemptNumber < 1
    || !PROVIDER_UUID.test(input.providerId ?? '')
    || typeof input.idFactory !== 'function'
    || (input.nowFactory !== undefined && typeof input.nowFactory !== 'function')) invalid()
  return {
    now: instantFromMs(input.nowMs),
    nowFactory: input.nowFactory ?? Date.now,
  }
}

export async function finalizeAcceptedInvitationEmail(db, cryptoContext, input = {}) {
  if (!db?.prepare || !db?.batch || !validStaffCryptoContext(cryptoContext)) invalid()
  const validated = validateAcceptedEmailInput(input)
  const job = await db.prepare('SELECT * FROM outbox_jobs WHERE id=?')
    .bind(input.jobId).first()
  if (!job
    || !exactKeys(job, OUTBOX_JOB_ROW_KEYS)
    || !validProcessingJob(job)
    || job.type !== 'staff.invitation.email'
    || job.aggregate_type !== 'staff_invitation'
    || job.lease_owner !== input.leaseOwner
    || job.attempt_count !== input.attemptNumber
    || !validInstant(job.scheduled_at)
    || job.scheduled_at > validated.now
    || !validInstant(job.created_at)
    || !validInstant(job.updated_at)
    || job.updated_at < job.created_at
    || (job.last_error_code !== null && !validErrorCode(job.last_error_code))
    || job.lease_expires_at <= validated.now) return false
  const attempt = await db.prepare(
    `SELECT id,job_id,attempt_number,started_at,completed_at,result,error_code,
            provider_reference
     FROM outbox_attempts
     WHERE job_id=? AND attempt_number=?`
  ).bind(job.id, input.attemptNumber).first()
  if (!exactKeys(attempt, [
    'id',
    'job_id',
    'attempt_number',
    'started_at',
    'completed_at',
    'result',
    'error_code',
    'provider_reference',
  ])
    || !validId(attempt.id)
    || attempt.job_id !== job.id
    || attempt.attempt_number !== input.attemptNumber
    || !validInstant(attempt.started_at)
    || attempt.completed_at !== null
    || attempt.result !== null
    || attempt.error_code !== null
    || attempt.provider_reference !== null) return false

  let payload
  try {
    payload = await decryptOutboxPayload(cryptoContext, job)
  } catch {
    return false
  }
  const actor = await db.prepare('SELECT id FROM staff_users WHERE id=?')
    .bind(payload.actorId).first()
  if (!exactKeys(actor, ['id']) || actor.id !== payload.actorId) return false
  const invitation = await db.prepare('SELECT * FROM staff_invitations WHERE id=?')
    .bind(payload.invitationId).first()
  if (!exactKeys(invitation, [
    'id',
    'staff_id',
    'email_lookup',
    'email_envelope',
    'display_name_envelope',
    'role',
    'status',
    'inviter_id',
    'expires_at',
    'access_allowed_at',
    'email_sent_at',
    'activated_at',
    'revoked_at',
    'version',
    'created_at',
    'updated_at',
  ])
    || !INVITATION_ID.test(invitation.id ?? '')
    || invitation.id !== job.aggregate_id
    || !STAFF_ID.test(invitation.staff_id ?? '')
    || !STAFF_ID.test(invitation.inviter_id ?? '')
    || !EMAIL_LOOKUP.test(invitation.email_lookup ?? '')
    || !validEnvelope(invitation.email_envelope)
    || !validEnvelope(invitation.display_name_envelope)
    || !['owner', 'coordinator', 'specialist'].includes(invitation.role)
    || invitation.status !== 'pending'
    || !validInstant(invitation.expires_at)
    || invitation.expires_at <= validated.now
    || !validInstant(invitation.access_allowed_at)
    || invitation.email_sent_at !== null
    || !nullableInstant(invitation.activated_at)
    || !nullableInstant(invitation.revoked_at)
    || invitation.activated_at !== null
    || invitation.revoked_at !== null
    || !validInstant(invitation.created_at)
    || !validInstant(invitation.updated_at)
    || invitation.updated_at < invitation.created_at
    || !Number.isSafeInteger(invitation.version)
    || invitation.version < 1
    || invitation.version >= Number.MAX_SAFE_INTEGER
    || job.idempotency_key !== emailJobKey(invitation.id, invitation.version)) return false
  const staff = await db.prepare(
    'SELECT id,email_lookup,status,version FROM staff_users WHERE id=?'
  ).bind(invitation.staff_id).first()
  if (!exactKeys(staff, ['id', 'email_lookup', 'status', 'version'])
    || !STAFF_ID.test(staff.id ?? '')
    || staff.id !== invitation.staff_id
    || !EMAIL_LOOKUP.test(staff.email_lookup ?? '')
    || staff.status !== 'pending'
    || !Number.isSafeInteger(staff.version)
    || staff.version < 1
    || invitation.email_lookup !== staff.email_lookup) return false

  const nextInvitation = {
    ...invitation,
    email_sent_at: validated.now,
    version: invitation.version + 1,
    updated_at: validated.now,
  }
  const deliveryId = idFrom(input.idFactory)
  const versionId = idFrom(input.idFactory)
  const auditId = idFrom(input.idFactory)
  const snapshot = JSON.stringify(await encryptForScope(
    cryptoContext.keyring,
    cryptoContext.dataKey,
    {
      expectedScope: cryptoContext.scope,
      recordId: invitation.id,
      field: 'record_version',
      plaintext: JSON.stringify(nextInvitation),
    },
  ))
  const metadata = JSON.stringify({ invitationVersion: nextInvitation.version })
  const observedNowMs = validated.nowFactory()
  if (!Number.isSafeInteger(observedNowMs) || observedNowMs < 0) invalid()
  const guardNow = instantFromMs(Math.max(input.nowMs, observedNowMs))
  if (job.lease_expires_at <= guardNow || invitation.expires_at <= guardNow) return false
  const statements = [
    db.prepare(
      `INSERT INTO delivery_attempts
       (id,outbox_job_id,provider,provider_reference,status,error_code,attempted_at)
       VALUES (?,?,'scaleway_tem',?,'accepted',NULL,?)`
    ).bind(deliveryId, job.id, input.providerId, validated.now),
    db.prepare(
      `UPDATE staff_invitations
       SET email_sent_at=?,version=version+1,updated_at=?
       WHERE id=? AND staff_id=? AND email_lookup=? AND status='pending'
         AND expires_at=? AND expires_at>? AND access_allowed_at=?
         AND email_sent_at IS NULL AND version=?
         AND EXISTS (
           SELECT 1 FROM staff_users
           WHERE id=? AND email_lookup=? AND status='pending' AND version=?
         )
         AND EXISTS (
           SELECT 1 FROM staff_users WHERE id=?
         )
         AND EXISTS (
           SELECT 1 FROM outbox_jobs
           WHERE id=? AND type='staff.invitation.email'
             AND aggregate_type='staff_invitation' AND aggregate_id=?
             AND idempotency_key=?
             AND payload_envelope=? AND status='processing' AND attempt_count=?
             AND lease_owner=? AND lease_expires_at=? AND lease_expires_at>?
         )
         AND EXISTS (
           SELECT 1 FROM outbox_attempts
           WHERE id=? AND job_id=? AND attempt_number=?
             AND completed_at IS NULL AND result IS NULL
             AND error_code IS NULL AND provider_reference IS NULL
         )`
    ).bind(
      validated.now,
      validated.now,
      invitation.id,
      invitation.staff_id,
      invitation.email_lookup,
      invitation.expires_at,
      guardNow,
      invitation.access_allowed_at,
      invitation.version,
      staff.id,
      staff.email_lookup,
      staff.version,
      payload.actorId,
      job.id,
      invitation.id,
      job.idempotency_key,
      job.payload_envelope,
      input.attemptNumber,
      input.leaseOwner,
      job.lease_expires_at,
      guardNow,
      attempt.id,
      job.id,
      input.attemptNumber,
    ),
    db.prepare(
      `INSERT INTO record_versions
       (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
        changed_at,correlation_id)
       SELECT ?,'staff_invitation',?,?,?,?,?,? WHERE changes()=1`
    ).bind(
      versionId,
      invitation.id,
      nextInvitation.version,
      snapshot,
      payload.actorId,
      validated.now,
      job.id,
    ),
    auditEventStatement(db, {
      id: auditId,
      occurredAt: validated.now,
      actorStaffId: payload.actorId,
      action: 'staff.invitation.email_accepted',
      entityType: 'staff_invitation',
      entityId: invitation.id,
      result: 'success',
      correlationId: job.id,
      metadata: { invitationVersion: nextInvitation.version },
      reasonEnvelope: null,
    }),
    db.prepare(
      `UPDATE outbox_attempts
       SET completed_at=?,result='succeeded',error_code=NULL,provider_reference=?
       WHERE id=? AND job_id=? AND attempt_number=?
         AND completed_at IS NULL AND result IS NULL
         AND error_code IS NULL AND provider_reference IS NULL
         AND EXISTS (
           SELECT 1 FROM staff_invitations
           WHERE id=? AND status='pending' AND version=?
             AND email_sent_at=? AND updated_at=?
         )
         AND EXISTS (
           SELECT 1 FROM delivery_attempts
           WHERE id=? AND outbox_job_id=? AND provider='scaleway_tem'
             AND provider_reference=? AND status='accepted'
             AND error_code IS NULL AND attempted_at=?
         )
         AND EXISTS (
           SELECT 1 FROM record_versions
           WHERE id=? AND entity_type='staff_invitation' AND entity_id=?
             AND version=? AND snapshot_envelope=? AND changed_by_staff_id=?
             AND changed_at=? AND correlation_id=?
         )
         AND EXISTS (
           SELECT 1 FROM audit_events
           WHERE id=? AND actor_staff_id=?
             AND action='staff.invitation.email_accepted'
             AND entity_type='staff_invitation' AND entity_id=?
             AND result='success' AND reason_envelope IS NULL
             AND correlation_id=? AND metadata_json=?
         )`
    ).bind(
      validated.now,
      input.providerId,
      attempt.id,
      job.id,
      input.attemptNumber,
      invitation.id,
      nextInvitation.version,
      validated.now,
      validated.now,
      deliveryId,
      job.id,
      input.providerId,
      validated.now,
      versionId,
      invitation.id,
      nextInvitation.version,
      snapshot,
      payload.actorId,
      validated.now,
      job.id,
      auditId,
      payload.actorId,
      invitation.id,
      job.id,
      metadata,
    ),
    db.prepare(
      `UPDATE outbox_jobs
       SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,
           last_error_code=NULL,updated_at=?
       WHERE id=? AND type='staff.invitation.email'
         AND aggregate_type='staff_invitation' AND aggregate_id=?
         AND idempotency_key=?
         AND payload_envelope=? AND status='processing' AND attempt_count=?
         AND lease_owner=? AND lease_expires_at=? AND lease_expires_at>?
         AND EXISTS (
           SELECT 1 FROM outbox_attempts
           WHERE id=? AND job_id=? AND attempt_number=? AND completed_at=?
             AND result='succeeded' AND error_code IS NULL
             AND provider_reference=?
         )`
    ).bind(
      validated.now,
      job.id,
      invitation.id,
      job.idempotency_key,
      job.payload_envelope,
      input.attemptNumber,
      input.leaseOwner,
      job.lease_expires_at,
      guardNow,
      attempt.id,
      job.id,
      input.attemptNumber,
      validated.now,
      input.providerId,
    ),
    operationGuard(
      db,
      `finalize_email_${job.id}`,
      `changes()=1
       AND EXISTS (
         SELECT 1 FROM outbox_jobs
         WHERE id=? AND type='staff.invitation.email'
           AND aggregate_type='staff_invitation' AND aggregate_id=?
           AND idempotency_key=?
           AND payload_envelope=? AND status='succeeded' AND attempt_count=?
           AND lease_owner IS NULL AND lease_expires_at IS NULL
           AND last_error_code IS NULL AND updated_at=?
       )
       AND EXISTS (
         SELECT 1 FROM outbox_attempts
         WHERE id=? AND job_id=? AND attempt_number=? AND completed_at=?
           AND result='succeeded' AND error_code IS NULL
           AND provider_reference=?
       )
       AND (
         SELECT count(*) FROM outbox_attempts
         WHERE job_id=? AND completed_at IS NULL
       )=0
       AND EXISTS (
         SELECT 1 FROM delivery_attempts
         WHERE id=? AND outbox_job_id=? AND provider='scaleway_tem'
           AND provider_reference=? AND status='accepted'
           AND error_code IS NULL AND attempted_at=?
       )
       AND (
         SELECT count(*) FROM delivery_attempts WHERE outbox_job_id=?
       )=1
       AND EXISTS (
         SELECT 1 FROM staff_invitations
         WHERE id=? AND staff_id=? AND email_lookup=? AND status='pending'
           AND expires_at=? AND expires_at>? AND access_allowed_at=?
           AND email_sent_at=? AND version=? AND updated_at=?
       )
       AND EXISTS (
         SELECT 1 FROM staff_users
         WHERE id=? AND email_lookup=? AND status='pending' AND version=?
       )
       AND EXISTS (
         SELECT 1 FROM staff_users WHERE id=?
       )
       AND EXISTS (
         SELECT 1 FROM record_versions
         WHERE id=? AND entity_type='staff_invitation' AND entity_id=?
           AND version=? AND snapshot_envelope=? AND changed_by_staff_id=?
           AND changed_at=? AND correlation_id=?
       )
       AND EXISTS (
         SELECT 1 FROM audit_events
         WHERE id=? AND actor_staff_id=?
           AND action='staff.invitation.email_accepted'
           AND entity_type='staff_invitation' AND entity_id=?
           AND result='success' AND reason_envelope IS NULL
           AND correlation_id=? AND metadata_json=?
       )`,
      [
        job.id,
        invitation.id,
        job.idempotency_key,
        job.payload_envelope,
        input.attemptNumber,
        validated.now,
        attempt.id,
        job.id,
        input.attemptNumber,
        validated.now,
        input.providerId,
        job.id,
        deliveryId,
        job.id,
        input.providerId,
        validated.now,
        job.id,
        invitation.id,
        invitation.staff_id,
        invitation.email_lookup,
        invitation.expires_at,
        guardNow,
        invitation.access_allowed_at,
        validated.now,
        nextInvitation.version,
        validated.now,
        staff.id,
        staff.email_lookup,
        staff.version,
        payload.actorId,
        versionId,
        invitation.id,
        nextInvitation.version,
        snapshot,
        payload.actorId,
        validated.now,
        job.id,
        auditId,
        payload.actorId,
        invitation.id,
        job.id,
        metadata,
      ],
    ),
  ]
  try {
    await db.batch(statements)
    return true
  } catch (error) {
    if (isD1OutboxOperationGuardFailure(error)) return false
    const current = await db.prepare('SELECT status FROM outbox_jobs WHERE id=?')
      .bind(job.id).first()
    if (current?.status === 'succeeded') return false
    throw error
  }
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
  if (exactKeys(outcome, ['result', 'providerId'])
    && outcome.result === 'email-accepted'
    && PROVIDER_UUID.test(outcome.providerId ?? '')) {
    return Object.freeze({
      result: 'email-accepted',
      providerId: outcome.providerId,
    })
  }
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
          nowFactory: currentMs,
        }))
      } catch (error) {
        outcome = thrownOutcome(error)
      }
    }
    if (outcome.result === 'email-accepted'
      && currentClaim.type === 'staff.invitation.email') {
      let finalized = false
      try {
        finalized = await finalizeAcceptedInvitationEmail(input.db, input.cryptoContext, {
          jobId: claim.id,
          leaseOwner: claim.leaseOwner,
          attemptNumber: claim.attemptNumber,
          nowMs: currentMs(),
          providerId: outcome.providerId,
          idFactory: input.idFactory,
          nowFactory: currentMs,
        })
      } catch {
        // Accepted delivery stays unresolved for the expired-email-lease reaper.
      }
      if (finalized) completed.push({ id: claim.id, result: 'succeeded' })
      continue
    }
    if (outcome.result === 'email-accepted') {
      outcome = {
        result: 'dead',
        errorCode: 'OUTBOX_HANDLER_FAILURE',
        providerReference: null,
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

const targetInvalid = () => {
  throw new Error('OUTBOX_TARGET_INVALID')
}

function validateTargetProcessorInput(input) {
  const required = [
    'db',
    'cryptoContext',
    'jobId',
    'nowMs',
    'idFactory',
    'leaseOwnerFactory',
    'dispatch',
  ]
  const optional = [
    'bindings',
    'config',
    'correlationIdFactory',
    'leaseNonceFactory',
    'nowFactory',
  ]
  if (!ownObject(input)
    || !required.every((key) => Object.hasOwn(input, key))
    || Object.keys(input).some((key) => !required.includes(key) && !optional.includes(key))
    || !input.db?.prepare
    || !input.db?.batch
    || !validStaffCryptoContext(input.cryptoContext)
    || !validId(input.jobId)
    || !Number.isSafeInteger(input.nowMs)
    || input.nowMs < 0
    || typeof input.idFactory !== 'function'
    || typeof input.leaseOwnerFactory !== 'function'
    || typeof input.dispatch !== 'function'
    || (input.leaseNonceFactory !== undefined
      && typeof input.leaseNonceFactory !== 'function')
    || (input.correlationIdFactory !== undefined
      && typeof input.correlationIdFactory !== 'function')
    || (input.nowFactory !== undefined && typeof input.nowFactory !== 'function')) {
    targetInvalid()
  }
}

const validAccessTarget = (row) => ownObject(row)
  && exactKeys(row, OUTBOX_JOB_ROW_KEYS)
  && validId(row.id)
  && row.type === 'staff.access.reconcile'
  && row.aggregate_type === 'access_group'
  && row.aggregate_id === 'centre_1'
  && /^staff\.access\.reconcile:(?:0|[1-9]\d*)$/.test(row.idempotency_key ?? '')
  && Number.isSafeInteger(Number(row.idempotency_key.slice('staff.access.reconcile:'.length)))
  && Number.isSafeInteger(row.attempt_count)
  && row.attempt_count >= 0
  && row.max_attempts === MAX_ATTEMPTS
  && validInstant(row.scheduled_at)
  && validInstant(row.created_at)
  && validInstant(row.updated_at)
  && row.created_at <= row.updated_at
  && validEnvelope(row.payload_envelope)

const targetGeneration = (row) => {
  const raw = row.idempotency_key.slice('staff.access.reconcile:'.length)
  const generation = Number(raw)
  if (!Number.isSafeInteger(generation) || generation < 0 || String(generation) !== raw) {
    targetInvalid()
  }
  return generation
}

const retryDueAt = (attempt) => {
  if (attempt.error_code === 'OUTBOX_LEASE_EXPIRED') {
    return attempt.completed_at
  }
  if (attempt.error_code !== 'OUTBOX_HANDLER_RETRY') targetInvalid()
  const delay = retryDelayMs(attempt.attempt_number)
  if (delay === null) targetInvalid()
  return instantFromMs(Date.parse(attempt.completed_at) + delay)
}

const completedTargetAttempt = (attempt, row, number, notBefore) => {
  if (!exactKeys(attempt, OUTBOX_ATTEMPT_ROW_KEYS)
    || !validId(attempt.id)
    || attempt.job_id !== row.id
    || attempt.attempt_number !== number
    || !validInstant(attempt.started_at)
    || !validInstant(attempt.completed_at)
    || attempt.started_at < row.created_at
    || attempt.started_at < notBefore
    || attempt.completed_at < attempt.started_at
    || attempt.result !== 'retry'
    || !['OUTBOX_HANDLER_RETRY', 'OUTBOX_LEASE_EXPIRED'].includes(attempt.error_code)
    || attempt.provider_reference !== null) targetInvalid()
  return retryDueAt(attempt)
}

async function validateAccessTargetEvidence(db, cryptoContext, row) {
  if (!validAccessTarget(row)) targetInvalid()
  const generation = targetGeneration(row)
  let payload
  try {
    payload = await decryptOutboxPayload(cryptoContext, row)
  } catch {
    targetInvalid()
  }
  if (!exactKeys(payload, ['actorId', 'generation'])
    || payload.generation !== generation) targetInvalid()
  const [actor, desired, attemptResult] = await Promise.all([
    db.prepare('SELECT id FROM staff_users WHERE id=?').bind(payload.actorId).first(),
    db.prepare(
      `SELECT key,value_json,version,updated_at
       FROM system_state WHERE key='access.desired_generation'`
    ).first(),
    db.prepare(
      `SELECT id,job_id,attempt_number,started_at,completed_at,result,error_code,
              provider_reference
       FROM outbox_attempts WHERE job_id=? ORDER BY attempt_number,id`
    ).bind(row.id).all(),
  ])
  if (!exactKeys(actor, ['id']) || actor.id !== payload.actorId
    || !exactKeys(desired, ['key', 'value_json', 'version', 'updated_at'])
    || desired.key !== 'access.desired_generation'
    || desired.value_json !== JSON.stringify({ generation })
    || !Number.isSafeInteger(desired.version)
    || desired.version < 1
    || !validInstant(desired.updated_at)
    || !Array.isArray(attemptResult?.results)
    || attemptResult.results.length !== row.attempt_count
    || row.attempt_count > 7) targetInvalid()

  const attempts = attemptResult.results
  let notBefore = row.created_at
  const completedCount = row.status === 'processing'
    ? row.attempt_count - 1
    : row.attempt_count
  if (!['queued', 'processing'].includes(row.status)
    || completedCount < 0) targetInvalid()
  for (let index = 0; index < completedCount; index += 1) {
    notBefore = completedTargetAttempt(attempts[index], row, index + 1, notBefore)
  }

  if (row.status === 'queued') {
    if (row.lease_owner !== null || row.lease_expires_at !== null) targetInvalid()
    if (row.attempt_count === 0) {
      if (row.last_error_code !== null
        || row.scheduled_at !== row.created_at
        || row.updated_at !== row.created_at) targetInvalid()
    } else {
      const last = attempts.at(-1)
      if (row.last_error_code !== last.error_code
        || row.scheduled_at !== notBefore
        || row.updated_at !== last.completed_at) targetInvalid()
    }
    return Object.freeze({ generation, payload })
  }

  if (!validProcessingJob(row)
    || row.attempt_count < 1
    || row.last_error_code !== (completedCount === 0
      ? null
      : attempts[completedCount - 1].error_code)) targetInvalid()
  const open = attempts.at(-1)
  if (!exactKeys(open, OUTBOX_ATTEMPT_ROW_KEYS)
    || !validId(open.id)
    || open.job_id !== row.id
    || open.attempt_number !== row.attempt_count
    || !validInstant(open.started_at)
    || open.started_at < notBefore
    || open.started_at !== row.updated_at
    || open.completed_at !== null
    || open.result !== null
    || open.error_code !== null
    || open.provider_reference !== null
    || row.scheduled_at > open.started_at
    || row.lease_expires_at !== instantFromMs(Date.parse(open.started_at) + LEASE_MS)) {
    targetInvalid()
  }
  return Object.freeze({ generation, payload })
}

async function claimTargetJob(db, row, input, nowMs) {
  const now = instantFromMs(nowMs)
  const expiry = instantFromMs(nowMs + LEASE_MS)
  if (!validAccessTarget(row)
    || row.status !== 'queued'
    || row.scheduled_at > now
    || row.attempt_count >= row.max_attempts
    || row.lease_owner !== null
    || row.lease_expires_at !== null) targetInvalid()
  const leaseOwner = idFrom(input.leaseOwnerFactory)
  const attemptId = idFrom(input.idFactory)
  const attemptNumber = row.attempt_count + 1
  try {
    await db.batch([
      db.prepare(
        `UPDATE outbox_jobs
         SET status='processing',lease_owner=?,lease_expires_at=?,
             attempt_count=attempt_count+1,updated_at=?
         WHERE id=? AND type='staff.access.reconcile'
           AND aggregate_type='access_group' AND aggregate_id='centre_1'
           AND idempotency_key=? AND status='queued'
           AND attempt_count=? AND max_attempts=8
           AND scheduled_at=? AND scheduled_at<=?
           AND lease_owner IS NULL AND lease_expires_at IS NULL`
      ).bind(
        leaseOwner,
        expiry,
        now,
        row.id,
        row.idempotency_key,
        row.attempt_count,
        row.scheduled_at,
        now,
      ),
      db.prepare(
        `INSERT INTO outbox_attempts
         (id,job_id,attempt_number,started_at)
         SELECT ?,?,?,? WHERE changes()=1`
      ).bind(attemptId, row.id, attemptNumber, now),
      operationGuard(
        db,
        `target_claim_${row.id}`,
        `changes()=1
         AND EXISTS (
           SELECT 1 FROM outbox_jobs
           WHERE id=? AND type='staff.access.reconcile'
             AND aggregate_type='access_group' AND aggregate_id='centre_1'
             AND idempotency_key=? AND status='processing'
             AND attempt_count=? AND lease_owner=? AND lease_expires_at=?
             AND updated_at=?
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
          row.idempotency_key,
          attemptNumber,
          leaseOwner,
          expiry,
          now,
          attemptId,
          row.id,
          attemptNumber,
          now,
          row.id,
        ],
      ),
    ])
  } catch (error) {
    if (isD1OutboxOperationGuardFailure(error)) return null
    throw error
  }
  return {
    ...row,
    attempt_count: attemptNumber,
    attemptId,
    attemptNumber,
    lease_expires_at: expiry,
    lease_owner: leaseOwner,
    leaseOwner,
    status: 'processing',
    updated_at: now,
  }
}

export async function processOutboxJobById(input = {}) {
  validateTargetProcessorInput(input)
  const nowFactory = input.nowFactory ?? Date.now
  const currentMs = () => {
    const value = nowFactory()
    if (!Number.isSafeInteger(value) || value < 0) targetInvalid()
    return Math.max(input.nowMs, value)
  }
  let row = await input.db.prepare('SELECT * FROM outbox_jobs WHERE id=?')
    .bind(input.jobId).first()
  await validateAccessTargetEvidence(input.db, input.cryptoContext, row)
  const initialNow = instantFromMs(input.nowMs)
  if (row.status === 'processing') {
    if (row.lease_expires_at > initialNow) {
      return Object.freeze({ jobId: row.id, result: 'busy' })
    }
    await reapOne(
      input.db,
      input.cryptoContext,
      row,
      initialNow,
      input.idFactory,
    )
    row = await input.db.prepare('SELECT * FROM outbox_jobs WHERE id=?')
      .bind(input.jobId).first()
    await validateAccessTargetEvidence(input.db, input.cryptoContext, row)
  }
  if (row.status !== 'queued') targetInvalid()
  if (row.scheduled_at > initialNow) {
    return Object.freeze({ jobId: row.id, result: 'retry' })
  }
  const claim = await claimTargetJob(input.db, row, input, input.nowMs)
  if (!claim) {
    const current = await input.db.prepare('SELECT * FROM outbox_jobs WHERE id=?')
      .bind(input.jobId).first()
    await validateAccessTargetEvidence(input.db, input.cryptoContext, current)
    if (current.status === 'processing' && current.lease_expires_at > initialNow) {
      return Object.freeze({ jobId: current.id, result: 'busy' })
    }
    return Object.freeze({ jobId: row.id, result: 'retry' })
  }
  const dispatchNowMs = currentMs()
  const currentClaim = await currentOwnedClaim(input.db, claim, dispatchNowMs)
  if (!currentClaim) {
    return Object.freeze({ jobId: row.id, result: 'retry' })
  }
  let outcome
  try {
    outcome = normalizedOutcome(await input.dispatch({
      bindings: input.bindings,
      config: input.config,
      correlationIdFactory: input.correlationIdFactory,
      cryptoContext: input.cryptoContext,
      db: input.db,
      idFactory: input.idFactory,
      job: currentClaim,
      leaseNonceFactory: input.leaseNonceFactory,
      leaseOwnerFactory: input.leaseOwnerFactory,
      nowFactory: currentMs,
      nowMs: dispatchNowMs,
    }))
  } catch (error) {
    outcome = thrownOutcome(error)
  }
  if (outcome.result === 'email-accepted') {
    outcome = {
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      providerReference: null,
      result: 'dead',
    }
  }
  const finalized = await finalizeOutboxJob(input.db, input.cryptoContext, {
    attemptNumber: claim.attemptNumber,
    errorCode: outcome.errorCode,
    idFactory: input.idFactory,
    jobId: claim.id,
    leaseOwner: claim.leaseOwner,
    nowMs: currentMs(),
    providerReference: outcome.providerReference,
    result: outcome.result,
  })
  return Object.freeze({
    jobId: row.id,
    result: finalized ? outcome.result : 'retry',
  })
}
