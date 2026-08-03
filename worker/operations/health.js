import { isD1IdentityCollision, isD1OutboxOperationGuardFailure } from '../db/errors.js'
import { decodeBase64Url } from '../security/encoding.js'
import { decryptForScope, encryptForScope } from '../security/envelope.js'
import { partsInWarsaw } from './clock.js'

const SNAPSHOT_KEY = 'health.snapshot'
const IDENTITY_SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const ACCESS_KEYS = Object.freeze(['access.applied_generation', 'access.desired_generation'])
const ORDINARY_TYPES = Object.freeze([
  'staff.access.reconcile',
  'staff.invitation.email',
  'staff.invitation.expire',
])
const CAPABILITIES = Object.freeze([
  'operations.health.read',
  'security.audit.read',
  'staff.manage',
])
const REASON_CAPABILITY = new Map([
  ['operations.health.read denied', 'operations.health.read'],
  ['security.audit.read denied', 'security.audit.read'],
  ['staff.manage denied', 'staff.manage'],
])
const SCHEDULER_STALE_MS = 900_000
const BACKUP_STALE_MS = 129_600_000
const DENIAL_WINDOW_MS = 900_000
const DENIAL_THRESHOLD = 10
const CHECK_COLLATOR = new Intl.Collator('pl-PL', { sensitivity: 'base', numeric: true })
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/
const ENVELOPE_KEYS = Object.freeze([
  'format', 'algorithm', 'dataKeyId', 'dataKeyVersion', 'nonce', 'ciphertext',
])
const ACTION_KEYS = Object.freeze([
  'id', 'fingerprint', 'kind', 'severity', 'status', 'entity_type', 'entity_id',
  'details_envelope', 'version', 'created_at', 'updated_at', 'resolved_at',
])
const CHECKS = Object.freeze([
  Object.freeze({ id: 'outbox.processing', label: 'Kolejka zadań' }),
  Object.freeze({ id: 'backup.freshness', label: 'Kopie zapasowe' }),
  Object.freeze({ id: 'access.reconciliation', label: 'Synchronizacja dostępu' }),
  Object.freeze({ id: 'scheduler.runs', label: 'Zadania cykliczne' }),
])
const SNAPSHOT_PAIRS = Object.freeze({
  'outbox.processing': Object.freeze([
    'ok:OUTBOX_HEALTHY', 'critical:OUTBOX_DEAD',
  ]),
  'backup.freshness': Object.freeze([
    'ok:BACKUP_NOT_DUE', 'ok:BACKUP_FRESH', 'warning:BACKUP_PENDING',
    'critical:BACKUP_FAILED', 'critical:BACKUP_STALE',
  ]),
  'access.reconciliation': Object.freeze([
    'ok:ACCESS_CURRENT', 'critical:ACCESS_RECONCILIATION_LAG',
  ]),
  'scheduler.runs': Object.freeze([
    'warning:SCHEDULER_STARTING', 'critical:SCHEDULER_STALE', 'ok:SCHEDULER_HEALTHY',
  ]),
})

const invalid = () => { throw new Error('HEALTH_INVALID') }
const invalidState = () => { throw new Error('HEALTH_STATE_INVALID') }
const invalidDenial = () => { throw new Error('AUTHORIZATION_DENIAL_STATE_INVALID') }
const ownershipLost = () => { throw new Error('HEALTH_OWNERSHIP_LOST') }
const conflict = () => { throw new Error('HEALTH_SNAPSHOT_CONFLICT') }
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => plainObject(value)
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const validId = (value) => typeof value === 'string' && OPAQUE_ID.test(value)
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const safeCount = (value) => Number.isSafeInteger(value) && value >= 0

function snapshotExact(value, keys) {
  if (!plainObject(value)) invalid()
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) invalid()
  const snapshot = {}
  for (const key of keys) snapshot[key] = Reflect.get(value, key)
  return Object.freeze(snapshot)
}

function normalizeInput(build) {
  try { return build() } catch { invalid() }
}

function captureDb(db) {
  if (!db || (typeof db !== 'object' && typeof db !== 'function')) invalid()
  const prepare = Reflect.get(db, 'prepare')
  const batch = Reflect.get(db, 'batch')
  if (typeof prepare !== 'function' || typeof batch !== 'function') invalid()
  return Object.freeze({
    prepare: (...args) => Reflect.apply(prepare, db, args),
    batch: (...args) => Reflect.apply(batch, db, args),
  })
}

function validEncodedLength(value, length) {
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

function canonicalValue(value, failure = invalidState) {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, failure))
  if (plainObject(value)) return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key], failure)]),
  )
  if (value === null || ['string', 'boolean'].includes(typeof value)
    || (typeof value === 'number' && Number.isFinite(value))) return value
  failure()
}

const canonicalJson = (value, failure = invalidState) => JSON.stringify(canonicalValue(value, failure))

function parseCanonicalJson(text, failure = invalidState) {
  if (typeof text !== 'string') failure()
  let parsed
  try { parsed = JSON.parse(text) } catch { failure() }
  if (canonicalJson(parsed, failure) !== text) failure()
  return parsed
}

function instantFromMs(nowMs, failure = invalid) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) failure()
  return instantFromSignedMs(nowMs, failure)
}

function instantFromSignedMs(valueMs, failure) {
  if (!Number.isSafeInteger(valueMs)) failure()
  let value
  try { value = new Date(valueMs).toISOString() } catch { failure() }
  if (Date.parse(value) !== valueMs || !validInstant(value)) failure()
  return value
}

function validateEnvelopeText(text, failure = invalidState) {
  if (typeof text !== 'string') failure()
  let envelope
  try { envelope = JSON.parse(text) } catch { failure() }
  if (!exactKeys(envelope, ENVELOPE_KEYS)
    || JSON.stringify(envelope) !== text
    || envelope.format !== 1
    || envelope.algorithm !== 'A256GCM'
    || !validId(envelope.dataKeyId)
    || !positiveInteger(envelope.dataKeyVersion)
    || typeof envelope.nonce !== 'string'
    || typeof envelope.ciphertext !== 'string') failure()
  return envelope
}

function captureCryptoContext(value) {
  const cryptoContext = snapshotExact(value, ['keyring', 'dataKey', 'scope'])
  const scope = snapshotExact(cryptoContext.scope, ['type', 'id', 'purpose'])
  const dataKey = snapshotExact(cryptoContext.dataKey, [
    'id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64',
    'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at',
  ])
  const rawKeyring = cryptoContext.keyring
  if (!rawKeyring || (typeof rawKeyring !== 'object' && typeof rawKeyring !== 'function')) invalid()
  const getDataKek = Reflect.get(rawKeyring, 'getDataKek')
  if (typeof getDataKek !== 'function'
    || scope.type !== IDENTITY_SCOPE.type
    || scope.id !== IDENTITY_SCOPE.id
    || scope.purpose !== IDENTITY_SCOPE.purpose
    || !validId(dataKey.id)
    || dataKey.scope_type !== IDENTITY_SCOPE.type
    || dataKey.scope_id !== IDENTITY_SCOPE.id
    || dataKey.purpose !== IDENTITY_SCOPE.purpose
    || !positiveInteger(dataKey.dek_version)
    || !positiveInteger(dataKey.kek_version)
    || !validEncodedLength(dataKey.wrapped_key_b64, 48)
    || !validEncodedLength(dataKey.wrap_nonce_b64, 12)
    || !validInstant(dataKey.created_at)
    || dataKey.retired_at !== null) invalid()
  const kek = Reflect.apply(getDataKek, rawKeyring, [dataKey.kek_version])
  if (!kek) invalid()
  const keyring = Object.freeze({
    getDataKek: (version) => version === dataKey.kek_version ? kek : null,
  })
  return Object.freeze({ keyring, dataKey, scope })
}

function captureEvaluationInput(input) {
  return normalizeInput(() => {
    const value = snapshotExact(input, [
      'db', 'cryptoContext', 'nowMs', 'prospectiveSchedulerRun',
    ])
    const db = captureDb(value.db)
    const cryptoContext = captureCryptoContext(value.cryptoContext)
    const nowMs = value.nowMs
    const generatedAt = instantFromMs(nowMs)
    let prospectiveSchedulerRun = null
    if (value.prospectiveSchedulerRun !== null) {
      prospectiveSchedulerRun = snapshotExact(
        value.prospectiveSchedulerRun, ['id', 'completedAt'],
      )
      if (!validId(prospectiveSchedulerRun.id)
        || !validInstant(prospectiveSchedulerRun.completedAt)) invalid()
    }
    return Object.freeze({
      db,
      cryptoContext,
      nowMs,
      prospectiveSchedulerRun,
      generatedAt,
    })
  })
}

function validFingerprint(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false
  let bytes
  try {
    bytes = decodeBase64Url(value)
    return bytes.byteLength === 32
  } catch {
    return false
  } finally {
    bytes?.fill(0)
  }
}

async function readAccess(db) {
  const rows = (await db.prepare(
    `SELECT key,value_json,version,updated_at
     FROM system_state
     WHERE key IN ('access.applied_generation','access.desired_generation')
     ORDER BY key`
  ).all())?.results
  if (!Array.isArray(rows) || rows.length !== 2) invalidState()
  const [appliedRow, desiredRow] = rows
  for (const row of rows) {
    if (!exactKeys(row, ['key', 'value_json', 'version', 'updated_at'])
      || !ACCESS_KEYS.includes(row.key)
      || !positiveInteger(row.version)
      || !validInstant(row.updated_at)) invalidState()
  }
  if (appliedRow.key !== ACCESS_KEYS[0] || desiredRow.key !== ACCESS_KEYS[1]) invalidState()
  const applied = parseCanonicalJson(appliedRow.value_json)
  const desired = parseCanonicalJson(desiredRow.value_json)
  if (!exactKeys(applied, ['fingerprint', 'generation'])
    || !exactKeys(desired, ['generation'])
    || !validFingerprint(applied.fingerprint)
    || !safeCount(applied.generation)
    || !safeCount(desired.generation)
    || applied.generation > desired.generation) invalidState()
  return {
    appliedGeneration: applied.generation,
    desiredGeneration: desired.generation,
    updatedAt: appliedRow.updated_at,
  }
}

async function readEarliestScheduler(db) {
  const row = await db.prepare(
    `SELECT id,scheduled_for
     FROM scheduler_runs
     ORDER BY scheduled_for ASC,id ASC LIMIT 1`
  ).first()
  if (row === null) return null
  if (!exactKeys(row, ['id', 'scheduled_for'])
    || !validId(row.id) || !validInstant(row.scheduled_for)) invalidState()
  return row
}

function validateBackupRow(row, selectedSuccess = false) {
  if (!exactKeys(row, [
    'id', 'status', 'completed_at', 'last_error_code', 'created_at', 'updated_at',
  ])
    || typeof row.id !== 'string' || !BACKUP_ID.test(row.id)
    || !['queued', 'exporting', 'stored', 'failed', 'restore_verified', 'pruned'].includes(row.status)
    || !validInstant(row.created_at)
    || !validInstant(row.updated_at)
    || row.updated_at < row.created_at) invalidState()
  if (selectedSuccess && !['stored', 'restore_verified'].includes(row.status)) invalidState()
  if (['queued', 'exporting'].includes(row.status)) {
    if (row.completed_at !== null || row.last_error_code !== null) invalidState()
  } else {
    if (!validInstant(row.completed_at) || row.completed_at > row.updated_at) invalidState()
    if (['stored', 'restore_verified'].includes(row.status) && row.last_error_code !== null) invalidState()
    if (row.status === 'failed'
      && (typeof row.last_error_code !== 'string' || !ERROR_CODE.test(row.last_error_code))) invalidState()
    if (row.status === 'pruned'
      && row.last_error_code !== null
      && (typeof row.last_error_code !== 'string' || !ERROR_CODE.test(row.last_error_code))) invalidState()
  }
  return row
}

async function readBackupFacts(db) {
  const latest = await db.prepare(
    `SELECT id,status,completed_at,last_error_code,created_at,updated_at
     FROM backup_runs
     ORDER BY created_at DESC,id DESC LIMIT 1`
  ).first()
  const success = await db.prepare(
    `SELECT id,status,completed_at,last_error_code,created_at,updated_at
     FROM backup_runs INDEXED BY backup_runs_success_completed_id_idx
     WHERE status IN ('stored','restore_verified')
     ORDER BY completed_at DESC,id DESC LIMIT 1`
  ).first()
  return {
    latest: latest === null ? null : validateBackupRow(latest),
    success: success === null ? null : validateBackupRow(success, true),
  }
}

function firstBackupDueMs(anchor) {
  const anchorMs = Date.parse(anchor)
  const firstMinute = Math.ceil(anchorMs / 60_000) * 60_000
  const limit = firstMinute + 26 * 3_600_000
  for (let candidate = firstMinute; candidate <= limit; candidate += 60_000) {
    const local = partsInWarsaw(candidate)
    if (local.hour === 3 && local.minute === 15) return candidate
  }
  invalidState()
}

function backupHealth(nowMs, baselineMs, facts) {
  const lastSuccessAt = facts.success?.completed_at ?? null
  if (baselineMs === null || nowMs < baselineMs) {
    return { status: 'ok', detailCode: 'BACKUP_NOT_DUE', lastSuccessAt, candidate: null }
  }
  if (facts.latest?.status === 'failed') return {
    status: 'critical',
    detailCode: 'BACKUP_FAILED',
    lastSuccessAt,
    candidate: {
      fingerprint: `backup.failed:${facts.latest.id}`,
      kind: 'backup_failed',
      severity: 'critical',
      entityType: 'backup_run',
      entityId: facts.latest.id,
      details: { backupId: facts.latest.id, errorCode: 'BACKUP_FAILED' },
    },
  }
  if (!facts.success && nowMs - baselineMs > BACKUP_STALE_MS) return {
    status: 'critical',
    detailCode: 'BACKUP_STALE',
    lastSuccessAt: null,
    candidate: {
      fingerprint: 'backup.stale',
      kind: 'backup_stale',
      severity: 'critical',
      entityType: 'centre',
      entityId: 'centre_1',
      details: { errorCode: 'BACKUP_STALE', thresholdHours: 36 },
    },
  }
  if (facts.success && nowMs - Date.parse(facts.success.completed_at) > BACKUP_STALE_MS) return {
    status: 'critical',
    detailCode: 'BACKUP_STALE',
    lastSuccessAt,
    candidate: {
      fingerprint: 'backup.stale',
      kind: 'backup_stale',
      severity: 'critical',
      entityType: 'centre',
      entityId: 'centre_1',
      details: { errorCode: 'BACKUP_STALE', thresholdHours: 36 },
    },
  }
  if (facts.success) return {
    status: 'ok', detailCode: 'BACKUP_FRESH', lastSuccessAt, candidate: null,
  }
  return {
    status: 'warning', detailCode: 'BACKUP_PENDING', lastSuccessAt: null, candidate: null,
  }
}

function validateOutboxFact(row, status) {
  if (!exactKeys(row, ['id', 'type', 'status', 'updated_at'])
    || !validId(row.id)
    || !ORDINARY_TYPES.includes(row.type)
    || row.status !== status
    || !validInstant(row.updated_at)) invalidState()
  return row
}

async function readOutboxFacts(db) {
  const dead = await db.prepare(
    `SELECT id,type,status,updated_at
     FROM outbox_jobs
     WHERE type IN ('staff.access.reconcile','staff.invitation.email','staff.invitation.expire')
       AND status='dead'
     ORDER BY updated_at DESC,id DESC LIMIT 1`
  ).first()
  const succeeded = await db.prepare(
    `SELECT id,type,status,updated_at
     FROM outbox_jobs
     WHERE type IN ('staff.access.reconcile','staff.invitation.email','staff.invitation.expire')
       AND status='succeeded'
     ORDER BY updated_at DESC,id DESC LIMIT 1`
  ).first()
  return {
    dead: dead === null ? null : validateOutboxFact(dead, 'dead'),
    succeeded: succeeded === null ? null : validateOutboxFact(succeeded, 'succeeded'),
  }
}

async function readLatestSchedulerSuccess(db) {
  const row = await db.prepare(
    `SELECT id,scheduled_for,completed_at,status
     FROM scheduler_runs
     WHERE status='succeeded'
     ORDER BY completed_at DESC,id DESC LIMIT 1`
  ).first()
  if (row === null) return null
  if (!exactKeys(row, ['id', 'scheduled_for', 'completed_at', 'status'])
    || !validId(row.id)
    || !validInstant(row.scheduled_for)
    || !validInstant(row.completed_at)
    || row.status !== 'succeeded') invalidState()
  return row
}

function schedulerHealth(nowMs, stored, prospective) {
  if (prospective) return {
    status: 'ok',
    detailCode: 'SCHEDULER_HEALTHY',
    lastSuccessAt: prospective.completedAt,
    candidate: stored && nowMs - Date.parse(stored.completed_at) > SCHEDULER_STALE_MS
      ? {
          fingerprint: 'scheduler.stale',
          kind: 'scheduler_stale',
          severity: 'critical',
          entityType: 'scheduler_run',
          entityId: stored.id,
          details: {
            errorCode: 'SCHEDULER_STALE',
            schedulerRunId: stored.id,
            thresholdMinutes: 15,
          },
        }
      : null,
  }
  if (!stored) return {
    status: 'warning', detailCode: 'SCHEDULER_STARTING', lastSuccessAt: null, candidate: null,
  }
  if (nowMs - Date.parse(stored.completed_at) > SCHEDULER_STALE_MS) return {
    status: 'critical',
    detailCode: 'SCHEDULER_STALE',
    lastSuccessAt: stored.completed_at,
    candidate: {
      fingerprint: 'scheduler.stale',
      kind: 'scheduler_stale',
      severity: 'critical',
      entityType: 'scheduler_run',
      entityId: stored.id,
      details: {
        errorCode: 'SCHEDULER_STALE',
        schedulerRunId: stored.id,
        thresholdMinutes: 15,
      },
    },
  }
  return {
    status: 'ok', detailCode: 'SCHEDULER_HEALTHY', lastSuccessAt: stored.completed_at, candidate: null,
  }
}

function denialMetadata(text) {
  const value = parseCanonicalJson(text, invalidDenial)
  if (!exactKeys(value, ['version']) || !positiveInteger(value.version)) invalidDenial()
}

async function decryptText(cryptoContext, id, field, envelopeText, failure = invalidState) {
  const envelope = validateEnvelopeText(envelopeText, failure)
  try {
    return await decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
      expectedScope: IDENTITY_SCOPE,
      recordId: id,
      field,
      envelope,
    })
  } catch {
    failure()
  }
}

function validateDenialRow(row, lowerAt, upperAt) {
  if (!exactKeys(row, [
    'id', 'occurred_at', 'actor_staff_id', 'action', 'entity_type', 'entity_id',
    'result', 'reason_envelope', 'correlation_id', 'metadata_json',
  ])
    || !validId(row.id)
    || !validInstant(row.occurred_at)
    || row.occurred_at < lowerAt
    || row.occurred_at > upperAt
    || !validId(row.actor_staff_id)
    || row.action !== 'authorization.denied'
    || row.entity_type !== 'staff_user'
    || row.entity_id !== row.actor_staff_id
    || row.result !== 'denied'
    || !validId(row.correlation_id)) invalidDenial()
  denialMetadata(row.metadata_json)
  return row
}

function validateActionIdentity(row, status) {
  if (!exactKeys(row, ACTION_KEYS)
    || !validId(row.id)
    || typeof row.fingerprint !== 'string' || row.fingerprint.length < 1 || row.fingerprint.length > 512
    || !validId(row.entity_id)
    || !validInstant(row.created_at)
    || !validInstant(row.updated_at)
    || row.status !== status) invalidState()
  if (status === 'open') {
    if (row.version !== 1 || row.updated_at !== row.created_at || row.resolved_at !== null) invalidState()
  } else if (status === 'resolved') {
    if (row.version !== 2 || !validInstant(row.resolved_at)
      || row.updated_at !== row.resolved_at || row.resolved_at < row.created_at) invalidState()
  } else invalidState()
  return row
}

function parseActionDetails(plaintext) {
  const details = parseCanonicalJson(plaintext)
  if (!plainObject(details)) invalidState()
  return details
}

function validateActionDetails(row, details) {
  if (row.kind === 'access_reconciliation_lag') {
    if (row.fingerprint !== 'access.reconciliation_lag'
      || row.severity !== 'critical' || row.entity_type !== 'access_group' || row.entity_id !== 'centre_1'
      || !exactKeys(details, ['appliedGeneration', 'desiredGeneration', 'errorCode'])
      || !safeCount(details.appliedGeneration) || !safeCount(details.desiredGeneration)
      || details.appliedGeneration >= details.desiredGeneration
      || details.errorCode !== 'ACCESS_RECONCILIATION_LAG') invalidState()
  } else if (row.kind === 'backup_failed') {
    if (row.fingerprint !== `backup.failed:${row.entity_id}`
      || row.severity !== 'critical' || row.entity_type !== 'backup_run'
      || !BACKUP_ID.test(row.entity_id)
      || !exactKeys(details, ['backupId', 'errorCode'])
      || details.backupId !== row.entity_id || details.errorCode !== 'BACKUP_FAILED') invalidState()
  } else if (row.kind === 'backup_stale') {
    if (row.fingerprint !== 'backup.stale'
      || row.severity !== 'critical' || row.entity_type !== 'centre' || row.entity_id !== 'centre_1'
      || !exactKeys(details, ['errorCode', 'thresholdHours'])
      || details.errorCode !== 'BACKUP_STALE' || details.thresholdHours !== 36) invalidState()
  } else if (row.kind === 'scheduler_stale') {
    if (row.fingerprint !== 'scheduler.stale'
      || row.severity !== 'critical' || row.entity_type !== 'scheduler_run'
      || !exactKeys(details, ['errorCode', 'schedulerRunId', 'thresholdMinutes'])
      || details.errorCode !== 'SCHEDULER_STALE'
      || details.schedulerRunId !== row.entity_id || details.thresholdMinutes !== 15) invalidState()
  } else if (row.kind === 'authorization_denial_spike') {
    if (row.severity !== 'warning' || row.entity_type !== 'staff_user'
      || !exactKeys(details, ['actorId', 'capability', 'count', 'errorCode', 'threshold'])
      || details.actorId !== row.entity_id
      || !CAPABILITIES.includes(details.capability)
      || row.fingerprint !== `security.authorization_denials:${row.entity_id}:${details.capability}`
      || !safeCount(details.count) || details.count < DENIAL_THRESHOLD
      || details.errorCode !== 'AUTHORIZATION_DENIAL_SPIKE'
      || details.threshold !== DENIAL_THRESHOLD) invalidState()
  } else invalidState()
  return details
}

async function validateStoredAction(cryptoContext, row, status, fingerprint) {
  validateActionIdentity(row, status)
  if (row.fingerprint !== fingerprint) invalidState()
  const plaintext = await decryptText(cryptoContext, row.id, 'action_details', row.details_envelope)
  validateActionDetails(row, parseActionDetails(plaintext))
  return row
}

async function latestResolvedDenial(db, cryptoContext, fingerprint) {
  const row = await db.prepare(
    `SELECT id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
            version,created_at,updated_at,resolved_at
     FROM operational_actions
     WHERE fingerprint=? AND status='resolved'
     ORDER BY resolved_at DESC,id DESC LIMIT 1`
  ).bind(fingerprint).first()
  if (row === null) return null
  await validateStoredAction(cryptoContext, row, 'resolved', fingerprint)
  if (row.kind !== 'authorization_denial_spike') invalidState()
  return row
}

async function denialCandidates(db, cryptoContext, nowMs, generatedAt) {
  const lowerAt = instantFromSignedMs(nowMs - DENIAL_WINDOW_MS, invalidState)
  const rows = (await db.prepare(
    `SELECT id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
            reason_envelope,correlation_id,metadata_json
     FROM audit_events
     WHERE occurred_at>=? AND occurred_at<=?
       AND action='authorization.denied'
       AND actor_staff_id IS NOT NULL
     ORDER BY occurred_at ASC,id ASC`
  ).bind(lowerAt, generatedAt).all())?.results
  if (!Array.isArray(rows)) invalidState()
  const groups = new Map()
  for (const raw of rows) {
    const row = validateDenialRow(raw, lowerAt, generatedAt)
    const reason = await decryptText(
      cryptoContext, row.id, 'reason', row.reason_envelope, invalidDenial,
    )
    if (reason === 'staff invitation rate limit') continue
    const capability = REASON_CAPABILITY.get(reason)
    if (!capability) invalidDenial()
    const key = `${row.actor_staff_id}\u0000${capability}`
    const group = groups.get(key) ?? {
      actorId: row.actor_staff_id, capability, events: [],
    }
    group.events.push(row)
    groups.set(key, group)
  }
  const candidates = []
  for (const group of groups.values()) {
    const fingerprint = `security.authorization_denials:${group.actorId}:${group.capability}`
    const resolution = await latestResolvedDenial(db, cryptoContext, fingerprint)
    const effective = resolution && resolution.resolved_at > lowerAt
      ? group.events.filter(({ occurred_at: occurredAt }) => occurredAt > resolution.resolved_at)
      : group.events
    if (effective.length >= DENIAL_THRESHOLD) candidates.push({
      fingerprint,
      kind: 'authorization_denial_spike',
      severity: 'warning',
      entityType: 'staff_user',
      entityId: group.actorId,
      details: {
        actorId: group.actorId,
        capability: group.capability,
        count: effective.length,
        errorCode: 'AUTHORIZATION_DENIAL_SPIKE',
        threshold: DENIAL_THRESHOLD,
      },
    })
  }
  return candidates
}

async function readOpenAction(db, cryptoContext, fingerprint) {
  const rows = (await db.prepare(
    `SELECT id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
            version,created_at,updated_at,resolved_at
     FROM operational_actions
     WHERE fingerprint=? AND status='open'
     ORDER BY id`
  ).bind(fingerprint).all())?.results
  if (!Array.isArray(rows) || rows.length > 1) invalidState()
  if (rows.length === 0) return null
  return validateStoredAction(cryptoContext, rows[0], 'open', fingerprint)
}

const compareCandidates = (left, right) => left.fingerprint < right.fingerprint
  ? -1
  : left.fingerprint > right.fingerprint
    ? 1
    : left.kind < right.kind
      ? -1
      : left.kind > right.kind ? 1 : 0

const makeCheck = (id, label, health) => ({
  id,
  label,
  status: health.status,
  lastSuccessAt: health.lastSuccessAt,
  detailCode: health.detailCode,
})

async function evaluateCaptured(input) {
  const generatedAt = input.generatedAt
  const [access, earliest, backups, outbox, scheduler] = await Promise.all([
    readAccess(input.db),
    readEarliestScheduler(input.db),
    readBackupFacts(input.db),
    readOutboxFacts(input.db),
    readLatestSchedulerSuccess(input.db),
  ])
  const anchor = earliest?.scheduled_for ?? input.prospectiveSchedulerRun?.completedAt ?? null
  const backup = backupHealth(
    input.nowMs,
    anchor === null ? null : firstBackupDueMs(anchor),
    backups,
  )
  const schedulerState = schedulerHealth(
    input.nowMs, scheduler, input.prospectiveSchedulerRun,
  )
  const accessLag = access.appliedGeneration < access.desiredGeneration
  const accessState = {
    status: accessLag ? 'critical' : 'ok',
    detailCode: accessLag ? 'ACCESS_RECONCILIATION_LAG' : 'ACCESS_CURRENT',
    lastSuccessAt: access.updatedAt,
  }
  const outboxState = {
    status: outbox.dead ? 'critical' : 'ok',
    detailCode: outbox.dead ? 'OUTBOX_DEAD' : 'OUTBOX_HEALTHY',
    lastSuccessAt: outbox.succeeded?.updated_at ?? null,
  }
  const checks = [
    makeCheck('access.reconciliation', 'Synchronizacja dostępu', accessState),
    makeCheck('backup.freshness', 'Kopie zapasowe', backup),
    makeCheck('outbox.processing', 'Kolejka zadań', outboxState),
    makeCheck('scheduler.runs', 'Zadania cykliczne', schedulerState),
  ].sort((left, right) => CHECK_COLLATOR.compare(left.label, right.label)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const candidates = []
  if (accessLag) candidates.push({
    fingerprint: 'access.reconciliation_lag',
    kind: 'access_reconciliation_lag',
    severity: 'critical',
    entityType: 'access_group',
    entityId: 'centre_1',
    details: {
      appliedGeneration: access.appliedGeneration,
      desiredGeneration: access.desiredGeneration,
      errorCode: 'ACCESS_RECONCILIATION_LAG',
    },
  })
  if (backup.candidate) candidates.push(backup.candidate)
  if (schedulerState.candidate) candidates.push(schedulerState.candidate)
  candidates.push(...await denialCandidates(input.db, input.cryptoContext, input.nowMs, generatedAt))
  candidates.sort(compareCandidates)
  const actionCandidates = []
  const existingActions = []
  for (const candidate of candidates) {
    const existing = await readOpenAction(input.db, input.cryptoContext, candidate.fingerprint)
    if (existing) existingActions.push(existing)
    else actionCandidates.push(candidate)
  }
  return {
    snapshot: { generatedAt, checks },
    actionCandidates,
    existingActions,
  }
}

export async function evaluateStoredOperationalState(input) {
  const result = await evaluateCaptured(captureEvaluationInput(input))
  return { snapshot: result.snapshot, actionCandidates: result.actionCandidates }
}

function validateSnapshot(snapshot) {
  if (!exactKeys(snapshot, ['checks', 'generatedAt'])
    || !validInstant(snapshot.generatedAt)
    || !Array.isArray(snapshot.checks)
    || snapshot.checks.length !== CHECKS.length) invalidState()
  for (let index = 0; index < CHECKS.length; index += 1) {
    const row = snapshot.checks[index]
    const expected = CHECKS[index]
    if (!exactKeys(row, ['detailCode', 'id', 'label', 'lastSuccessAt', 'status'])
      || row.id !== expected.id
      || row.label !== expected.label
      || !SNAPSHOT_PAIRS[row.id]?.includes(`${row.status}:${row.detailCode}`)
      || (row.lastSuccessAt !== null && !validInstant(row.lastSuccessAt))) invalidState()
  }
  return snapshot
}

async function readSnapshot(db) {
  const row = await db.prepare(
    `SELECT key,value_json,version,updated_at
     FROM system_state WHERE key='health.snapshot'`
  ).first()
  if (row === null) return null
  if (!exactKeys(row, ['key', 'value_json', 'version', 'updated_at'])
    || row.key !== SNAPSHOT_KEY
    || !positiveInteger(row.version)
    || !validInstant(row.updated_at)) invalidState()
  const snapshot = validateSnapshot(parseCanonicalJson(row.value_json))
  if (row.updated_at !== snapshot.generatedAt) invalidState()
  return { ...row, snapshot }
}

function capturePublisherInput(input) {
  return normalizeInput(() => {
    const value = snapshotExact(input, ['db', 'cryptoContext', 'run', 'idFactory', 'now'])
    const db = captureDb(value.db)
    const cryptoContext = captureCryptoContext(value.cryptoContext)
    const run = snapshotExact(value.run, [
      'id', 'scheduledFor', 'attemptCount', 'leaseOwner', 'leaseExpiresAt',
      'claimedJobs', 'succeededJobs', 'failedJobs',
    ])
    if (typeof value.idFactory !== 'function'
      || typeof value.now !== 'function'
      || !validId(run.id)
      || !validInstant(run.scheduledFor)
      || !positiveInteger(run.attemptCount)
      || !validId(run.leaseOwner)
      || !validInstant(run.leaseExpiresAt)
      || !safeCount(run.claimedJobs)
      || !safeCount(run.succeededJobs)
      || !safeCount(run.failedJobs)) invalid()
    return Object.freeze({
      db,
      cryptoContext,
      run,
      idFactory: value.idFactory,
      now: value.now,
    })
  })
}

function observe(now) {
  let nowMs
  try { nowMs = now() } catch { invalidState() }
  return { nowMs, completedAt: instantFromMs(nowMs, invalidState) }
}

async function readFence(db, run, completedAt, requireOwnership = true) {
  const row = await db.prepare(
    `SELECT id,scheduled_for,status,attempt_count,lease_owner,lease_expires_at
     FROM scheduler_runs WHERE id=?`
  ).bind(run.id).first()
  if (row === null) {
    if (requireOwnership) ownershipLost()
    return null
  }
  if (!exactKeys(row, [
    'id', 'scheduled_for', 'status', 'attempt_count', 'lease_owner', 'lease_expires_at',
  ])
    || !validId(row.id)
    || !validInstant(row.scheduled_for)
    || !['running', 'succeeded', 'failed'].includes(row.status)
    || !positiveInteger(row.attempt_count)
    || !validId(row.lease_owner)
    || !validInstant(row.lease_expires_at)) invalidState()
  const owned = row.id === run.id
    && row.scheduled_for === run.scheduledFor
    && row.status === 'running'
    && row.attempt_count === run.attemptCount
    && row.lease_owner === run.leaseOwner
    && row.lease_expires_at === run.leaseExpiresAt
    && row.lease_expires_at > completedAt
  if (requireOwnership && !owned) ownershipLost()
  return { row, owned }
}

function actionIdFrom(factory) {
  let id
  try { id = factory() } catch { invalidState() }
  if (!validId(id)) invalidState()
  return id
}

async function prepareNewActions(db, cryptoContext, candidates, completedAt, idFactory) {
  const actions = []
  for (const candidate of candidates) {
    const id = actionIdFrom(idFactory)
    const plaintext = canonicalJson(candidate.details)
    const envelope = JSON.stringify(await encryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: IDENTITY_SCOPE,
        recordId: id,
        field: 'action_details',
        plaintext,
      },
    ))
    validateEnvelopeText(envelope)
    actions.push({
      id,
      fingerprint: candidate.fingerprint,
      kind: candidate.kind,
      severity: candidate.severity,
      status: 'open',
      entity_type: candidate.entityType,
      entity_id: candidate.entityId,
      details_envelope: envelope,
      version: 1,
      created_at: completedAt,
      updated_at: completedAt,
      resolved_at: null,
    })
  }
  return actions
}

const actionInsert = (db, action) => db.prepare(
  `INSERT INTO operational_actions
   (id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
    version,created_at,updated_at,resolved_at)
   SELECT ?,?,?,?,'open',?,?,?,1,?,?,NULL
   WHERE NOT EXISTS (
     SELECT 1 FROM operational_actions WHERE fingerprint=? AND status='open'
   )`
).bind(
  action.id,
  action.fingerprint,
  action.kind,
  action.severity,
  action.entity_type,
  action.entity_id,
  action.details_envelope,
  action.created_at,
  action.updated_at,
  action.fingerprint,
)

function snapshotStatement(db, existing, valueJson, completedAt) {
  if (!existing) return db.prepare(
    `INSERT INTO system_state (key,value_json,version,updated_at)
     SELECT 'health.snapshot',?,1,?
     WHERE NOT EXISTS (SELECT 1 FROM system_state WHERE key='health.snapshot')`
  ).bind(valueJson, completedAt)
  return db.prepare(
    `UPDATE system_state
     SET value_json=?,version=version+1,updated_at=?
     WHERE key='health.snapshot' AND version=?`
  ).bind(valueJson, completedAt, existing.version)
}

const schedulerSuccessStatement = (db, run, completedAt) => db.prepare(
  `UPDATE scheduler_runs
   SET status='succeeded',completed_at=?,claimed_jobs=?,succeeded_jobs=?,
       failed_jobs=?,error_code=NULL
   WHERE id=? AND scheduled_for=? AND status='running' AND attempt_count=?
     AND lease_owner=? AND lease_expires_at=? AND lease_expires_at>?
     AND changes()=1`
).bind(
  completedAt,
  run.claimedJobs,
  run.succeededJobs,
  run.failedJobs,
  run.id,
  run.scheduledFor,
  run.attemptCount,
  run.leaseOwner,
  run.leaseExpiresAt,
  completedAt,
)

function publicationGuard(db, run, completedAt, valueJson, snapshotVersion, actions, attempt) {
  const predicates = [
    `changes()=1`,
    `EXISTS (
       SELECT 1 FROM scheduler_runs
       WHERE id=? AND scheduled_for=? AND status='succeeded' AND attempt_count=?
         AND lease_owner=? AND lease_expires_at=? AND completed_at=?
         AND claimed_jobs=? AND succeeded_jobs=? AND failed_jobs=? AND error_code IS NULL
     )`,
    `EXISTS (
       SELECT 1 FROM system_state
       WHERE key='health.snapshot' AND value_json=? AND version=? AND updated_at=?
     )`,
  ]
  const bindings = [
    run.id,
    run.scheduledFor,
    run.attemptCount,
    run.leaseOwner,
    run.leaseExpiresAt,
    completedAt,
    run.claimedJobs,
    run.succeededJobs,
    run.failedJobs,
    valueJson,
    snapshotVersion,
    completedAt,
  ]
  for (const action of actions) {
    predicates.push(`(
      SELECT count(*) FROM operational_actions
      WHERE id=? AND fingerprint=? AND kind=? AND severity=? AND status='open'
        AND entity_type=? AND entity_id=? AND details_envelope=? AND version=1
        AND created_at=? AND updated_at=? AND resolved_at IS NULL
    )=1`)
    bindings.push(
      action.id,
      action.fingerprint,
      action.kind,
      action.severity,
      action.entity_type,
      action.entity_id,
      action.details_envelope,
      action.created_at,
      action.updated_at,
    )
  }
  return db.prepare(
    `INSERT INTO outbox_operation_guard_failures (operation_id)
     SELECT ? WHERE NOT (${predicates.join('\n       AND ')})`
  ).bind(`health_publish_${run.id}_${attempt}`, ...bindings)
}

const sameObservedSnapshot = (left, right) => left === null
  ? right === null
  : right !== null && left.version === right.version

async function classifyMechanicalConflict({
  db,
  cryptoContext,
  run,
  completedAt,
  observedSnapshot,
  proposedActions,
}) {
  const fence = await readFence(db, run, completedAt, false)
  if (!fence?.owned) ownershipLost()
  const freshSnapshot = await readSnapshot(db)
  let race = !sameObservedSnapshot(observedSnapshot, freshSnapshot)
  for (const action of proposedActions) {
    const fresh = await readOpenAction(db, cryptoContext, action.fingerprint)
    if (fresh) race = true
  }
  return race
}

export async function publishScheduledOperationalState(input) {
  const validated = capturePublisherInput(input)
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const current = observe(validated.now)
    await readFence(validated.db, validated.run, current.completedAt)
    const evaluated = await evaluateCaptured({
      db: validated.db,
      cryptoContext: validated.cryptoContext,
      nowMs: current.nowMs,
      prospectiveSchedulerRun: {
        id: validated.run.id,
        completedAt: current.completedAt,
      },
      generatedAt: current.completedAt,
    })
    const existingSnapshot = await readSnapshot(validated.db)
    const valueJson = canonicalJson(evaluated.snapshot)
    const snapshotVersion = existingSnapshot ? existingSnapshot.version + 1 : 1
    if (!positiveInteger(snapshotVersion)) invalidState()
    const proposedActions = await prepareNewActions(
      validated.db,
      validated.cryptoContext,
      evaluated.actionCandidates,
      current.completedAt,
      validated.idFactory,
    )
    const guardedActions = [...evaluated.existingActions, ...proposedActions]
    const statements = [
      ...proposedActions.map((action) => actionInsert(validated.db, action)),
      snapshotStatement(validated.db, existingSnapshot, valueJson, current.completedAt),
      schedulerSuccessStatement(validated.db, validated.run, current.completedAt),
      publicationGuard(
        validated.db,
        validated.run,
        current.completedAt,
        valueJson,
        snapshotVersion,
        guardedActions,
        attempt,
      ),
    ]
    try {
      await validated.db.batch(statements)
      return {
        completedAt: current.completedAt,
        snapshot: evaluated.snapshot,
        snapshotVersion,
        createdActions: proposedActions.length,
        publicationAttempts: attempt,
      }
    } catch (error) {
      if (!isD1OutboxOperationGuardFailure(error) && !isD1IdentityCollision(error)) throw error
      const raced = await classifyMechanicalConflict({
        db: validated.db,
        cryptoContext: validated.cryptoContext,
        run: validated.run,
        completedAt: current.completedAt,
        observedSnapshot: existingSnapshot,
        proposedActions,
      })
      if (!raced) invalidState()
      if (attempt === 2) conflict()
    }
  }
  conflict()
}
