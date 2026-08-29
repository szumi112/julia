import {
  auditEventStatement,
  encryptAuditReason,
} from '../audit/events.js'
import {
  captureCoreAuditEvent,
  captureCoreAuditMetadata,
  CORE_AUDIT_SCHEMAS,
  isCoreAuditAction,
} from '../../src/core-audit-contract.js'
import {
  captureSystemAuditEvent,
  captureSystemAuditMetadata,
  isSystemAuditAction,
  SYSTEM_AUDIT_SCHEMAS,
} from '../../src/system-audit-contract.js'
import { isD1IdentityCollision } from '../db/errors.js'
import { createUnitOfWork } from '../db/unit-of-work.js'
import { authorize } from '../identity/policy.js'
import { captureAuthorityActor } from '../identity/authority-actor.js'
import { resolveCurrentAuthorityActor } from '../identity/staff.js'
import { isCorrelationId } from '../logging/safe-log.js'
import { requestOutboxRecovery } from '../operations/outbox-recovery.js'
import { decodeBase64Url, encodeBase64Url } from '../security/encoding.js'
import { decryptForScope } from '../security/envelope.js'

const IDENTITY_SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})
const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const ASSIGNMENT_ID = /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CORRECTION_ID = /^cor_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const OUTBOX_TYPE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CURSOR_MAC_PREFIX = 'bwm.security-audit.cursor.v1'
const MAX_CURSOR_POSITION_BYTES = 177
const MAX_CURSOR_POSITION_TEXT = 236
const DENIAL_CAPABILITIES = new Set([
  'operations.health.read',
  'security.audit.read',
  'staff.manage',
])
const ORDINARY_OUTBOX_TYPES = new Set([
  'staff.access.reconcile',
  'staff.invitation.email',
  'staff.invitation.expire',
])
const OUTBOX_FAILURE_CODES = new Set([
  'OUTBOX_HANDLER_FAILURE',
  'OUTBOX_HANDLER_RETRY',
  'OUTBOX_LEASE_EXPIRED',
  'EMAIL_DELIVERY_AMBIGUOUS',
])
const INPUT_KEYS = Object.freeze([
  'db', 'cryptoContext', 'actor', 'nowMs', 'correlationId', 'idFactory',
])
const DATA_KEY_KEYS = Object.freeze([
  'id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64',
  'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at',
])
const ACTOR_ROW_KEYS = Object.freeze([
  'id', 'role', 'status', 'specialist_id', 'version',
])
const HEALTH_ROW_KEYS = Object.freeze(['key', 'value_json', 'version', 'updated_at'])
const CHECK_KEYS = Object.freeze(['id', 'label', 'status', 'lastSuccessAt', 'detailCode'])
const ACTION_ROW_KEYS = Object.freeze([
  'id', 'fingerprint', 'kind', 'severity', 'status', 'entity_type', 'entity_id',
  'details_envelope', 'version', 'created_at', 'updated_at', 'resolved_at',
])
const RECOVERY_STATE_ROW_KEYS = Object.freeze([
  'action_id', 'source_job_id', 'source_type', 'source_aggregate_type',
  'source_aggregate_id', 'source_status', 'source_attempt_count',
  'source_max_attempts', 'source_error_code', 'source_updated_at',
  'source_lease_owner',
  'source_lease_expires_at', 'attempt_job_id', 'attempt_number',
  'attempt_completed_at', 'attempt_result', 'attempt_error_code',
  'attempt_provider_reference',
  'recovery_id', 'replacement_job_id', 'replacement_status',
  'accepted_delivery', 'other_live_email',
])
const ENVELOPE_KEYS = Object.freeze([
  'format', 'algorithm', 'dataKeyId', 'dataKeyVersion', 'nonce', 'ciphertext',
])
const AUDIT_ROW_KEYS = Object.freeze([
  'id', 'occurred_at', 'actor_staff_id', 'action', 'entity_type', 'entity_id',
  'result', 'reason_envelope', 'correlation_id', 'metadata_json',
])
const AUDIT_SCHEMAS = Object.freeze({
  ...Object.fromEntries(Object.entries(CORE_AUDIT_SCHEMAS).map(([action, schema]) => [action,
    Object.freeze({ entityTypes: Object.freeze([schema.entityType]), result: 'success', metadata: schema.metadata, reason: 'null' })
  ])),
  ...Object.fromEntries(Object.entries(SYSTEM_AUDIT_SCHEMAS).map(([action, schema]) => [action,
    Object.freeze({ entityTypes: Object.freeze([schema.entityType]), result: 'success', metadata: schema.metadata, reason: 'null', system: true })
  ])),
  'authorization.denied': Object.freeze({ entityTypes: ['staff_user'], result: 'denied', metadata: { version: 'version' }, reason: 'encrypted' }),
  'backup.pruned': Object.freeze({ entityTypes: ['backup_run'], result: 'success', metadata: { backupVersion: 'version' }, reason: 'null', system: true }),
  'data_key.rewrapped': Object.freeze({ entityTypes: ['data_key'], result: 'success', metadata: { newKekVersion: 'version', oldKekVersion: 'version' }, reason: 'null' }),
  'identity.activation': Object.freeze({ entityTypes: ['staff_user'], result: 'success', metadata: { invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { invitationVersion: 'version', staffVersion: 'version' }, reason: 'null' }),
  'identity.denied': Object.freeze({ entityTypes: ['staff_user'], result: 'denied', metadata: { version: 'version' }, reason: 'null' }),
  'identity.reindex': Object.freeze({ entityTypes: ['staff_invitation', 'staff_user'], result: 'success', metadata: { version: 'version' }, reason: 'null' }),
  'operational_action.resolved': Object.freeze({ entityTypes: ['operational_action'], result: 'success', metadata: { actionVersion: 'version' }, reason: 'null' }),
  'outbox.recovery.requested': Object.freeze({ entityTypes: ['outbox_job'], result: 'success', metadata: { actionVersion: 'version', desiredGeneration: 'nullableVersion', invitationVersion: 'nullableVersion', replacementJobId: 'id' }, reason: 'null', human: true }),
  'staff.access.reconciled': Object.freeze({ entityTypes: ['access_group'], result: 'success', metadata: { appliedGeneration: 'version', desiredGeneration: 'version', invitationCount: 'count' }, reason: 'null' }),
  'staff.bootstrap': Object.freeze({ entityTypes: ['staff_user'], result: 'success', metadata: { desiredGeneration: 'version', invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', invitationVersion: 'version', staffVersion: 'version' }, reason: 'null' }),
  'staff.deactivated': Object.freeze({ entityTypes: ['staff_user'], result: 'success', metadata: { desiredGeneration: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', staffVersion: 'version' }, reason: 'null' }),
  'staff.invitation.email_accepted': Object.freeze({ entityTypes: ['staff_invitation'], result: 'success', metadata: { invitationVersion: 'version' }, reason: 'null' }),
  'staff.invitation.expired': Object.freeze({ entityTypes: ['staff_invitation'], result: 'success', metadata: { desiredGeneration: 'version', invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', invitationVersion: 'version', staffVersion: 'version' }, reason: 'null' }),
  'staff.invited': Object.freeze({ entityTypes: ['staff_invitation'], result: 'success', metadata: { desiredGeneration: 'version', invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', invitationVersion: 'version', staffVersion: 'version' }, reason: 'null' }),
  'specialist.backfilled': Object.freeze({ entityTypes: ['specialist'], result: 'success', metadata: { specialistVersion: 'version', stateVersion: 'version' }, reason: 'null', system: true }),
  'core_directory.upgrade.advanced': Object.freeze({ entityTypes: ['system_state'], result: 'success', metadata: { createdCount: 'count', processedCount: 'count', stateVersion: 'version' }, reason: 'null', system: true }),
})
const HEALTH_CHECKS = Object.freeze([
  Object.freeze({
    id: 'outbox.processing',
    label: 'Kolejka zadań',
    pairs: new Set([
      'ok:OUTBOX_HEALTHY',
      'critical:OUTBOX_DEAD',
      'critical:OUTBOX_DRAIN_FAILED',
      'critical:OUTBOX_DRAIN_STALE',
    ]),
  }),
  Object.freeze({
    id: 'backup.freshness',
    label: 'Kopie zapasowe',
    pairs: new Set([
      'ok:BACKUP_NOT_DUE',
      'ok:BACKUP_FRESH',
      'warning:BACKUP_PENDING',
      'critical:BACKUP_FAILED',
      'critical:BACKUP_STALE',
    ]),
  }),
  Object.freeze({
    id: 'access.reconciliation',
    label: 'Synchronizacja dostępu',
    pairs: new Set(['ok:ACCESS_CURRENT', 'critical:ACCESS_RECONCILIATION_LAG']),
  }),
  Object.freeze({
    id: 'scheduler.runs',
    label: 'Zadania cykliczne',
    pairs: new Set([
      'ok:SCHEDULER_HEALTHY',
      'warning:SCHEDULER_STARTING',
      'critical:SCHEDULER_STALE',
    ]),
  }),
])

const invalid = () => { throw new Error('OPERATIONS_INVALID') }
const invalidState = () => { throw new Error('OPERATIONS_STATE_INVALID') }
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const validId = (value) => typeof value === 'string' && ID.test(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const safeCount = (value) => Number.isSafeInteger(value) && value >= 0

function encodedLength(value, length, minimum = false) {
  let decoded
  try {
    decoded = decodeBase64Url(value)
    return minimum ? decoded.byteLength >= length : decoded.byteLength === length
  } catch {
    return false
  } finally {
    decoded?.fill(0)
  }
}

function validCryptoKey(value, algorithm, usages) {
  try {
    if (typeof CryptoKey !== 'function' || !(value instanceof CryptoKey)
      || value.type !== 'secret' || value.extractable !== false || !Array.isArray(value.usages)
      || value.usages.length !== usages.length
      || !usages.every((usage) => value.usages.includes(usage))) return false
    if (algorithm === 'AES-GCM') {
      return value.algorithm?.name === 'AES-GCM' && value.algorithm?.length === 256
    }
    return algorithm === 'HMAC' && value.algorithm?.name === 'HMAC'
      && value.algorithm?.length === 256 && value.algorithm?.hash?.name === 'SHA-256'
  } catch {
    return false
  }
}

function captureAllRows(value, maximum) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Object.hasOwn(value, 'results')) invalidState()
    const source = Reflect.get(value, 'results')
    if (!Array.isArray(source)) invalidState()
    const length = Reflect.get(source, 'length')
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) invalidState()
    const rows = []
    for (let index = 0; index < length; index += 1) {
      const key = String(index)
      if (!Object.hasOwn(source, key)) invalidState()
      rows.push(Reflect.get(source, key))
    }
    return Object.freeze(rows)
  } catch {
    invalidState()
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (plainObject(value)) return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])
  )
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value
  invalidState()
}

const canonicalJson = (value) => JSON.stringify(canonicalValue(value))

function parseCanonicalJson(text) {
  if (typeof text !== 'string') invalidState()
  let parsed
  try { parsed = JSON.parse(text) } catch { invalidState() }
  if (canonicalJson(parsed) !== text) invalidState()
  return parsed
}

function exactSnapshot(value, keys, failure = invalid) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) failure()
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
      failure()
    }
    const result = {}
    for (const key of keys) result[key] = Reflect.get(value, key)
    return result
  } catch {
    failure()
  }
}

function captureDb(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) invalid()
  let prepare
  let batch
  try {
    prepare = Reflect.get(value, 'prepare')
    batch = Reflect.get(value, 'batch')
  } catch {
    invalid()
  }
  if (typeof prepare !== 'function' || typeof batch !== 'function') invalid()
  return Object.freeze({
    prepare: (...args) => Reflect.apply(prepare, value, args),
    batch: (...args) => Reflect.apply(batch, value, args),
  })
}

function captureActor(value, failure = invalid) {
  const actor = captureAuthorityActor(value)
  if (!actor) failure()
  return actor
}

function captureCryptoContext(value) {
  const context = exactSnapshot(value, ['keyring', 'dataKey', 'scope'])
  const scope = exactSnapshot(context.scope, ['type', 'id', 'purpose'])
  const dataKey = exactSnapshot(context.dataKey, DATA_KEY_KEYS)
  if (scope.type !== IDENTITY_SCOPE.type || scope.id !== IDENTITY_SCOPE.id
    || scope.purpose !== IDENTITY_SCOPE.purpose
    || dataKey.scope_type !== scope.type || dataKey.scope_id !== scope.id
    || dataKey.purpose !== scope.purpose || !validId(dataKey.id)
    || !positive(dataKey.dek_version) || !positive(dataKey.kek_version)
    || !validInstant(dataKey.created_at)
    || dataKey.retired_at !== null
    || !context.keyring || (typeof context.keyring !== 'object' && typeof context.keyring !== 'function')) invalid()
  if (!encodedLength(dataKey.wrapped_key_b64, 48)
    || !encodedLength(dataKey.wrap_nonce_b64, 12)) invalid()
  let getDataKek
  let getLookupHmac
  let activeLookupKeyVersion
  let lookupKeyVersions
  try {
    getDataKek = Reflect.get(context.keyring, 'getDataKek')
    getLookupHmac = Reflect.get(context.keyring, 'getLookupHmac')
    activeLookupKeyVersion = Reflect.get(context.keyring, 'activeLookupKeyVersion')
    lookupKeyVersions = Reflect.get(context.keyring, 'lookupKeyVersions')
  } catch {
    invalid()
  }
  let capturedLookupVersions
  try {
    if (typeof getDataKek !== 'function' || typeof getLookupHmac !== 'function'
      || !positive(activeLookupKeyVersion) || !Array.isArray(lookupKeyVersions)) invalid()
    const length = Reflect.get(lookupKeyVersions, 'length')
    const ownKeys = Reflect.ownKeys(lookupKeyVersions)
    if (!Number.isSafeInteger(length) || length < 1
      || ownKeys.length !== length + 1 || !ownKeys.includes('length')) invalid()
    capturedLookupVersions = []
    for (let index = 0; index < length; index += 1) {
      const key = String(index)
      if (!Object.hasOwn(lookupKeyVersions, key)) invalid()
      capturedLookupVersions.push(Reflect.get(lookupKeyVersions, key))
    }
  } catch { invalid() }
  if (capturedLookupVersions.some((version) => !positive(version))
    || new Set(capturedLookupVersions).size !== capturedLookupVersions.length
    || !capturedLookupVersions.includes(activeLookupKeyVersion)) invalid()
  let dataKek
  const lookupKeys = new Map()
  try {
    dataKek = Reflect.apply(getDataKek, context.keyring, [dataKey.kek_version])
    for (const version of capturedLookupVersions) {
      const key = Reflect.apply(getLookupHmac, context.keyring, [version])
      if (!key) invalid()
      lookupKeys.set(version, key)
    }
  } catch { invalid() }
  if (!validCryptoKey(dataKek, 'AES-GCM', ['decrypt', 'encrypt'])
    || [...lookupKeys.values()].some((key) => !validCryptoKey(key, 'HMAC', ['sign']))) invalid()
  const stableKeyring = Object.freeze({
    activeLookupKeyVersion,
    lookupKeyVersions: Object.freeze(capturedLookupVersions),
    getDataKek: (version) => version === dataKey.kek_version ? dataKek : null,
    getLookupHmac: (version) => lookupKeys.get(version) ?? null,
  })
  return Object.freeze({
    keyring: stableKeyring,
    dataKey: Object.freeze(dataKey),
    scope: Object.freeze(scope),
  })
}

function captureInput(value, extraKeys = []) {
  const raw = exactSnapshot(value, [...INPUT_KEYS, ...extraKeys])
  const db = captureDb(raw.db)
  const cryptoContext = captureCryptoContext(raw.cryptoContext)
  const actor = captureActor(raw.actor)
  if (!Number.isSafeInteger(raw.nowMs) || raw.nowMs < 0
    || !isCorrelationId(raw.correlationId) || typeof raw.idFactory !== 'function') invalid()
  let now
  try { now = new Date(raw.nowMs).toISOString() } catch { invalid() }
  if (Date.parse(now) !== raw.nowMs) invalid()
  return Object.freeze({ ...raw, db, cryptoContext, actor, now })
}

function actionIdFrom(factory) {
  let value
  try { value = Reflect.apply(factory, undefined, []) } catch { invalid() }
  if (!validId(value)) invalid()
  return value
}

function actorFromRow(row) {
  const captured = exactSnapshot(row, ACTOR_ROW_KEYS, invalidState)
  if (!['pending', 'active', 'disabled'].includes(captured.status)) invalidState()
  return Object.freeze(captured)
}

async function readCurrentActor(input) {
  const result = await input.db.prepare(
    `SELECT id,role,status,specialist_id,version
     FROM staff_users WHERE id=?`
  ).bind(input.actor.id).all()
  const rows = captureAllRows(result, 1)
  if (rows.length !== 1) return null
  const row = actorFromRow(rows[0])
  if (row.status !== 'active') return Object.freeze({ ...row, actor: null })
  let actor
  try { actor = await resolveCurrentAuthorityActor(input.db, row) } catch { invalidState() }
  return Object.freeze({ ...row, actor })
}

const sameActor = (row, actor) => row.id === actor.id
  && row.role === actor.role
  && row.specialist_id === actor.specialistId
  && row.version === actor.version
  && row.actor.authorityRevision === actor.authorityRevision
  && row.actor.capabilities.length === actor.capabilities.length
  && row.actor.capabilities.every((capability, index) => (
    capability === actor.capabilities[index]
  ))

async function persistDenial(input, capability) {
  const auditId = actionIdFrom(input.idFactory)
  const plaintext = `${capability} denied`
  const reasonEnvelope = await encryptAuditReason({
    keyring: input.cryptoContext.keyring,
    dataKey: input.cryptoContext.dataKey,
    expectedScope: input.cryptoContext.scope,
    auditEventId: auditId,
    plaintext,
  })
  const unit = createUnitOfWork(input.db, {
    mode: 'denial',
    actorId: input.actor.id,
    correlationId: input.correlationId,
  })
  unit.audit(auditEventStatement(input.db, {
    id: auditId,
    occurredAt: input.now,
    actorStaffId: input.actor.id,
    action: 'authorization.denied',
    entityType: 'staff_user',
    entityId: input.actor.id,
    result: 'denied',
    correlationId: input.correlationId,
    metadata: { version: input.actor.version },
    reasonEnvelope,
  }))
  await unit.commit()
  throw new Error('FORBIDDEN')
}

async function requireCapability(input, capability) {
  const initiallyAllowed = authorize(input.actor, capability, CENTRE, { nowMs: input.nowMs })
  const current = await readCurrentActor(input)
  if (!initiallyAllowed || current === null || current.status !== 'active'
    || !sameActor(current, input.actor)
    || !authorize(current.actor, capability, CENTRE, { nowMs: input.nowMs })) {
    return persistDenial(input, capability)
  }
  return current
}

function validateHealthSnapshot(row) {
  const state = exactSnapshot(row, HEALTH_ROW_KEYS, invalidState)
  if (state.key !== 'health.snapshot' || !positive(state.version)
    || !validInstant(state.updated_at)) invalidState()
  const snapshot = parseCanonicalJson(state.value_json)
  const root = exactSnapshot(snapshot, ['generatedAt', 'checks'], invalidState)
  if (root.generatedAt !== state.updated_at || !Array.isArray(root.checks)
    || root.checks.length !== HEALTH_CHECKS.length) invalidState()
  const checks = root.checks.map((value, index) => {
    const check = exactSnapshot(value, CHECK_KEYS, invalidState)
    const expected = HEALTH_CHECKS[index]
    if (check.id !== expected.id || check.label !== expected.label
      || !expected.pairs.has(`${check.status}:${check.detailCode}`)
      || (check.lastSuccessAt !== null
        && (!validInstant(check.lastSuccessAt) || check.lastSuccessAt > root.generatedAt))) invalidState()
    return {
      id: check.id,
      label: check.label,
      status: check.status,
      lastSuccessAt: check.lastSuccessAt,
      detailCode: check.detailCode,
    }
  })
  return { generatedAt: root.generatedAt, checks }
}

async function readHealthSnapshot(input) {
  const result = await input.db.prepare(
    `SELECT key,value_json,version,updated_at
     FROM system_state WHERE key='health.snapshot'`
  ).all()
  const rows = captureAllRows(result, 1)
  if (rows.length !== 1) invalidState()
  return validateHealthSnapshot(rows[0])
}

function parseEnvelopeText(text) {
  if (typeof text !== 'string') invalidState()
  let envelope
  try { envelope = JSON.parse(text) } catch { invalidState() }
  const captured = exactSnapshot(envelope, ENVELOPE_KEYS, invalidState)
  if (JSON.stringify(captured) !== text || captured.format !== 1
    || captured.algorithm !== 'A256GCM' || !validId(captured.dataKeyId)
    || !positive(captured.dataKeyVersion)
    || !encodedLength(captured.nonce, 12)
    || !encodedLength(captured.ciphertext, 16, true)) invalidState()
  return captured
}

async function decryptActionDetails(input, row) {
  let plaintext
  try {
    plaintext = await decryptForScope(input.cryptoContext.keyring, input.cryptoContext.dataKey, {
      expectedScope: input.cryptoContext.scope,
      recordId: row.id,
      field: 'action_details',
      envelope: parseEnvelopeText(row.details_envelope),
    })
  } catch {
    invalidState()
  }
  const details = parseCanonicalJson(plaintext)
  if (!plainObject(details)) invalidState()
  return details
}

function validateActionIdentity(value, expectedStatus) {
  const row = exactSnapshot(value, ACTION_ROW_KEYS, invalidState)
  return validateCapturedActionIdentity(row, expectedStatus)
}

function validateCapturedActionIdentity(row, expectedStatus) {
  if (!validId(row.id) || typeof row.fingerprint !== 'string'
    || row.fingerprint.length < 1 || row.fingerprint.length > 512
    || !validId(row.entity_id) || !validInstant(row.created_at)
    || !validInstant(row.updated_at) || row.status !== expectedStatus) invalidState()
  if (expectedStatus === 'open') {
    if (row.version !== 1 || row.created_at !== row.updated_at || row.resolved_at !== null) {
      invalidState()
    }
  } else if (expectedStatus === 'resolved') {
    if (row.version !== 2 || !validInstant(row.resolved_at)
      || row.updated_at !== row.resolved_at || row.resolved_at < row.created_at) invalidState()
  } else invalidState()
  return row
}

function validateAnyActionIdentity(value) {
  const row = exactSnapshot(value, ACTION_ROW_KEYS, invalidState)
  if (row.status !== 'open' && row.status !== 'resolved') invalidState()
  return validateCapturedActionIdentity(row, row.status)
}

function validateActionDetails(row, details) {
  if (row.kind === 'access_reconciliation_lag') {
    if (row.fingerprint !== 'access.reconciliation_lag' || row.severity !== 'critical'
      || row.entity_type !== 'access_group' || row.entity_id !== 'centre_1'
      || !exactSnapshot(details, ['appliedGeneration', 'desiredGeneration', 'errorCode'], invalidState)
      || !safeCount(details.appliedGeneration) || !safeCount(details.desiredGeneration)
      || details.appliedGeneration >= details.desiredGeneration
      || details.errorCode !== 'ACCESS_RECONCILIATION_LAG') invalidState()
  } else if (row.kind === 'authorization_denial_spike') {
    if (row.entity_type === 'centre') {
      if (row.fingerprint !== 'security.authorization_denials:overflow'
        || row.severity !== 'critical' || row.entity_id !== 'centre_1'
        || !exactSnapshot(
          details,
          ['errorCode', 'minimumCount', 'threshold', 'windowMinutes'],
          invalidState,
        )
        || details.errorCode !== 'AUTHORIZATION_DENIAL_OVERFLOW'
        || details.minimumCount !== 101 || details.threshold !== 100
        || details.windowMinutes !== 15) invalidState()
    } else if (row.severity !== 'warning' || row.entity_type !== 'staff_user'
      || !exactSnapshot(details, ['actorId', 'capability', 'count', 'errorCode', 'threshold'], invalidState)
      || details.actorId !== row.entity_id || !DENIAL_CAPABILITIES.has(details.capability)
      || row.fingerprint !== `security.authorization_denials:${row.entity_id}:${details.capability}`
      || !safeCount(details.count) || details.count < 10
      || details.errorCode !== 'AUTHORIZATION_DENIAL_SPIKE' || details.threshold !== 10) invalidState()
  } else if (row.kind === 'backup_failed') {
    if (row.fingerprint !== `backup.failed:${row.entity_id}` || row.severity !== 'critical'
      || row.entity_type !== 'backup_run' || !BACKUP_ID.test(row.entity_id)
      || !exactSnapshot(details, ['backupId', 'errorCode'], invalidState)
      || details.backupId !== row.entity_id || details.errorCode !== 'BACKUP_FAILED') invalidState()
  } else if (row.kind === 'backup_stale') {
    if (row.fingerprint !== 'backup.stale' || row.severity !== 'critical'
      || row.entity_type !== 'centre' || row.entity_id !== 'centre_1'
      || !exactSnapshot(details, ['errorCode', 'thresholdHours'], invalidState)
      || details.errorCode !== 'BACKUP_STALE' || details.thresholdHours !== 36) invalidState()
  } else if (row.kind === 'outbox_job_failed') {
    const exact = exactSnapshot(details, ['errorCode', 'jobId', 'outboxType'], invalidState)
    const known = ORDINARY_OUTBOX_TYPES.has(exact.outboxType)
      && OUTBOX_FAILURE_CODES.has(exact.errorCode)
    const unknown = !ORDINARY_OUTBOX_TYPES.has(exact.outboxType)
      && exact.outboxType !== 'backup.create'
      && OUTBOX_TYPE.test(exact.outboxType ?? '')
      && exact.errorCode === 'OUTBOX_TYPE_INVALID'
    if (row.fingerprint !== `outbox.dead:${row.entity_id}` || row.severity !== 'critical'
      || row.entity_type !== 'outbox_job' || exact.jobId !== row.entity_id
      || (!known && !unknown)) invalidState()
  } else if (row.kind === 'scheduler_stale') {
    if (row.fingerprint !== 'scheduler.stale' || row.severity !== 'critical'
      || row.entity_type !== 'scheduler_run'
      || !exactSnapshot(details, ['errorCode', 'schedulerRunId', 'thresholdMinutes'], invalidState)
      || details.errorCode !== 'SCHEDULER_STALE'
      || details.schedulerRunId !== row.entity_id || details.thresholdMinutes !== 15) invalidState()
  } else invalidState()
  return details
}

const publicAction = ({ row, details, recovery = null }) => ({
  id: row.id,
  kind: row.kind,
  severity: row.severity,
  entityType: row.entity_type,
  entityId: row.entity_id,
  details,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  recovery,
})

function requireNewestFirst(previous, current) {
  if (previous.created_at < current.created_at
    || (previous.created_at === current.created_at && previous.id <= current.id)) invalidState()
}

async function readRecoveryStates(input, actions) {
  const eligible = new Map(actions.filter(ownerRecoveryDisposition).map((action) => (
    [action.row.id, action]
  )))
  if (eligible.size === 0) return new Map()
  let result
  try {
    result = await input.db.prepare(
      `SELECT source_action.id AS action_id,source.id AS source_job_id,
              source.type AS source_type,
              source.aggregate_type AS source_aggregate_type,
              source.aggregate_id AS source_aggregate_id,
              source.status AS source_status,
              source.attempt_count AS source_attempt_count,
              source.max_attempts AS source_max_attempts,
              source.last_error_code AS source_error_code,
              source.updated_at AS source_updated_at,
              source.lease_owner AS source_lease_owner,
              source.lease_expires_at AS source_lease_expires_at,
              attempt.job_id AS attempt_job_id,
              attempt.attempt_number AS attempt_number,
              attempt.completed_at AS attempt_completed_at,
              attempt.result AS attempt_result,
              attempt.error_code AS attempt_error_code,
              attempt.provider_reference AS attempt_provider_reference,
              recovery.id AS recovery_id,
              recovery.replacement_job_id AS replacement_job_id,
              replacement.status AS replacement_status,
              EXISTS (
                SELECT 1
                FROM delivery_attempts AS delivery
                JOIN outbox_jobs AS delivery_job
                  ON delivery_job.id=delivery.outbox_job_id
                WHERE delivery_job.type='staff.invitation.email'
                  AND delivery_job.aggregate_type='staff_invitation'
                  AND delivery_job.aggregate_id=source.aggregate_id
                  AND delivery.status='accepted'
              ) AS accepted_delivery,
              EXISTS (
                SELECT 1 FROM outbox_jobs AS other
                WHERE other.type='staff.invitation.email'
                  AND other.aggregate_type='staff_invitation'
                  AND other.aggregate_id=source.aggregate_id
                  AND other.id!=source.id
                  AND (recovery.replacement_job_id IS NULL
                    OR other.id!=recovery.replacement_job_id)
                  AND other.status IN ('queued','processing','succeeded')
              ) AS other_live_email
       FROM outbox_jobs AS source
       JOIN operational_actions AS source_action
         ON source_action.entity_type='outbox_job'
        AND source_action.entity_id=source.id
       JOIN outbox_attempts AS attempt
         ON attempt.job_id=source.id
        AND attempt.attempt_number=source.attempt_count
       LEFT JOIN outbox_job_recoveries AS recovery
         ON recovery.source_job_id=source.id
        AND recovery.operational_action_id=source_action.id
       LEFT JOIN outbox_jobs AS replacement
         ON replacement.id=recovery.replacement_job_id
       WHERE source_action.status='open'
         AND source_action.kind='outbox_job_failed'
         AND source.type IN ('staff.access.reconcile','staff.invitation.email')
       ORDER BY source_action.created_at DESC,source_action.id DESC
       LIMIT 101`,
    ).all()
  } catch (error) {
    if (String(error?.message ?? '').includes('no such table: outbox_job_recoveries')) {
      invalidState()
    }
    throw error
  }
  const rows = captureAllRows(result, 101)
  const states = new Map()
  for (const value of rows) {
    const row = exactSnapshot(value, RECOVERY_STATE_ROW_KEYS, invalidState)
    const action = eligible.get(row.action_id)
    if (!action) continue
    if (states.has(row.action_id)
      || row.source_job_id !== action.row.entity_id
      || row.source_type !== action.details.outboxType
      || row.source_status !== 'dead'
      || !positive(row.source_attempt_count)
      || row.source_max_attempts !== 8
      || row.source_attempt_count > 8
      || !validInstant(row.source_updated_at)
      || row.source_lease_owner !== null
      || row.source_lease_expires_at !== null
      || row.source_error_code !== action.details.errorCode
      || row.attempt_job_id !== row.source_job_id
      || row.attempt_number !== row.source_attempt_count
      || !validInstant(row.attempt_completed_at)
      || row.attempt_completed_at !== row.source_updated_at
      || row.attempt_result !== 'dead'
      || row.attempt_error_code !== row.source_error_code
      || row.attempt_provider_reference !== null
      || ![0, 1].includes(row.accepted_delivery)
      || ![0, 1].includes(row.other_live_email)) invalidState()
    const kind = row.source_type === 'staff.access.reconcile' ? 'access' : 'email'
    if ((kind === 'access'
        && (row.source_aggregate_type !== 'access_group'
          || row.source_aggregate_id !== 'centre_1'
          || !['OUTBOX_HANDLER_FAILURE', 'OUTBOX_HANDLER_RETRY',
            'OUTBOX_LEASE_EXPIRED'].includes(row.source_error_code)
          || (['OUTBOX_HANDLER_RETRY', 'OUTBOX_LEASE_EXPIRED'].includes(
            row.source_error_code,
          ) && row.source_attempt_count !== row.source_max_attempts)))
      || (kind === 'email'
        && (row.source_aggregate_type !== 'staff_invitation'
          || !['OUTBOX_HANDLER_FAILURE', 'OUTBOX_HANDLER_RETRY',
            'EMAIL_DELIVERY_AMBIGUOUS'].includes(row.source_error_code)
          || (row.source_error_code === 'OUTBOX_HANDLER_RETRY'
            && row.source_attempt_count !== row.source_max_attempts)))) invalidState()
    const hasRecovery = row.recovery_id !== null
      || row.replacement_job_id !== null || row.replacement_status !== null
    let status
    if (hasRecovery) {
      if (!validId(row.recovery_id) || !row.recovery_id.startsWith('rcv_')
        || !validId(row.replacement_job_id)
        || !['queued', 'processing'].includes(row.replacement_status)) invalidState()
      status = row.replacement_status
    } else {
      status = kind === 'email'
        && (row.source_error_code === 'EMAIL_DELIVERY_AMBIGUOUS'
          || row.accepted_delivery === 1 || row.other_live_email === 1)
        ? 'unsafe'
        : 'available'
    }
    states.set(row.action_id, Object.freeze({ kind, status }))
  }
  if (states.size !== eligible.size) invalidState()
  return states
}

async function readOpenActions(input, canReadSecurity) {
  const securityScope = canReadSecurity
    ? ''
    : "\n       AND kind<>'authorization_denial_spike'"
  const result = await input.db.prepare(
    `SELECT id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
            version,created_at,updated_at,resolved_at
     FROM operational_actions
     WHERE status='open'${securityScope}
     ORDER BY created_at DESC,id DESC
     LIMIT ?`
  ).bind(101).all()
  const rows = captureAllRows(result, 101)
  const identities = []
  let previous = null
  for (const value of rows) {
    const row = validateActionIdentity(value, 'open')
    if (!canReadSecurity && row.kind === 'authorization_denial_spike') invalidState()
    if (previous) requireNewestFirst(previous, row)
    previous = row
    identities.push(row)
  }
  const includesSecurity = identities.some(({ kind }) => kind === 'authorization_denial_spike')
  const revalidate = async () => {
    await requireCapability(input, 'operations.health.read')
    if (includesSecurity) await requireCapability(input, 'security.audit.read')
  }
  await revalidate()
  const validated = []
  for (const row of identities) validated.push(await validateCapturedAction(input, row))
  await revalidate()
  const recoveryStates = await readRecoveryStates(input, validated)
  await revalidate()
  return Object.freeze({
    actions: validated.slice(0, 100).map((action) => publicAction({
      ...action,
      recovery: recoveryStates.get(action.row.id) ?? null,
    })),
    truncated: validated.length === 101,
  })
}

async function readActionById(input, actionId) {
  const result = await input.db.prepare(
    `SELECT id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
            version,created_at,updated_at,resolved_at
     FROM operational_actions WHERE id=?`
  ).bind(actionId).all()
  const rows = captureAllRows(result, 1)
  return rows.length === 0 ? null : validateAnyActionIdentity(rows[0])
}

async function validateCapturedAction(input, row) {
  const details = validateActionDetails(row, await decryptActionDetails(input, row))
  return { row, details }
}

const validation = (field) => {
  const error = new Error('VALIDATION_FAILED')
  error.details = { field }
  throw error
}

const versionConflict = (currentVersion) => {
  const error = new Error('VERSION_CONFLICT')
  error.details = { currentVersion }
  throw error
}

function resolutionBody(value) {
  const body = exactSnapshot(value, ['version'], () => validation('version'))
  if (!positive(body.version)) validation('version')
  return body
}

const actionCapability = (row) => row.kind === 'authorization_denial_spike'
  ? 'security.audit.read'
  : 'operations.health.read'

const ownerRecoveryDisposition = (action) => action.row.kind === 'outbox_job_failed'
  && ['staff.access.reconcile', 'staff.invitation.email'].includes(
    action.details.outboxType,
  )

const IMMUTABLE_ACTION_KEYS = Object.freeze([
  'id', 'fingerprint', 'kind', 'severity', 'entity_type', 'entity_id',
  'details_envelope', 'created_at',
])

const sameImmutableAction = (left, right) => IMMUTABLE_ACTION_KEYS
  .every((key) => left[key] === right[key])

function resolutionGuard(input, action, auditId) {
  const row = action.row
  const metadata = '{"actionVersion":2}'
  const rolePredicate = row.kind === 'authorization_denial_spike'
      || ownerRecoveryDisposition(action)
    ? `role='owner'`
    : `role IN ('owner','coordinator')`
  return input.db.prepare(
    `INSERT INTO audit_events
     (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
      reason_envelope,correlation_id,metadata_json)
     SELECT id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
            reason_envelope,correlation_id,metadata_json
     FROM audit_events
     WHERE id=? AND NOT (
       changes()=1
       AND (SELECT count(*) FROM staff_users
            WHERE id=? AND role=? AND status='active' AND specialist_id IS ?
              AND version=? AND ${rolePredicate})=1
       AND NOT EXISTS (
         SELECT 1
         FROM outbox_job_recoveries AS recovery
         JOIN outbox_jobs AS replacement
           ON replacement.id=recovery.replacement_job_id
         WHERE recovery.operational_action_id=?
           AND replacement.status IN ('queued','processing')
       )
       AND (SELECT count(*) FROM operational_actions
            WHERE id=? AND fingerprint=? AND kind=? AND severity=?
              AND status='resolved' AND entity_type=? AND entity_id=?
              AND details_envelope=? AND version=2 AND created_at=?
              AND updated_at=? AND resolved_at=? AND resolved_at>=created_at)=1
       AND (SELECT count(*) FROM audit_events
            WHERE id=? AND occurred_at=? AND actor_staff_id=?
              AND action='operational_action.resolved'
              AND entity_type='operational_action' AND entity_id=?
              AND result='success' AND reason_envelope IS NULL
              AND correlation_id=? AND metadata_json=?)=1
     )`
  ).bind(
    auditId,
    input.actor.id,
    input.actor.role,
    input.actor.specialistId,
    input.actor.version,
    row.id,
    row.id,
    row.fingerprint,
    row.kind,
    row.severity,
    row.entity_type,
    row.entity_id,
    row.details_envelope,
    row.created_at,
    input.now,
    input.now,
    auditId,
    input.now,
    input.actor.id,
    row.id,
    input.correlationId,
    metadata,
  )
}

async function attemptedAuditExists(input, auditId) {
  const result = await input.db.prepare(
    'SELECT id FROM audit_events WHERE id=?'
  ).bind(auditId).all()
  const rows = captureAllRows(result, 1)
  if (rows.length === 0) return false
  const row = exactSnapshot(rows[0], ['id'], invalidState)
  if (row.id !== auditId) invalidState()
  return true
}

async function recoverResolutionCollision(input, originalAction, auditId, error) {
  if (!isD1IdentityCollision(error)) throw error
  if (await attemptedAuditExists(input, auditId)) throw error
  await ensureNoPendingRecovery(input, originalAction.row.id)

  const currentActor = await readCurrentActor(input)
  const capability = actionCapability(originalAction.row)
  if (currentActor === null || currentActor.status !== 'active'
    || !sameActor(currentActor, input.actor)
    || !authorize(currentActor.actor, capability, CENTRE, { nowMs: input.nowMs })) {
    return persistDenial(input, capability)
  }

  const currentRow = await readActionById(input, originalAction.row.id)
  if (currentRow === null) invalidState()
  if (!sameImmutableAction(originalAction.row, currentRow)) invalidState()
  const currentAction = await validateCapturedAction(input, currentRow)
  if (currentAction.row.status !== originalAction.row.status
    || currentAction.row.version !== originalAction.row.version) {
    versionConflict(currentAction.row.version)
  }
  throw error
}

const cursorInvalid = () => { throw new Error('VALIDATION_FAILED') }

async function cursorMac(key, version, position) {
  let bytes
  let signature
  try {
    bytes = new TextEncoder().encode(`${CURSOR_MAC_PREFIX}\n${version}\n${position}`)
    signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes))
    if (signature.byteLength !== 32) cursorInvalid()
    return signature
  } catch {
    cursorInvalid()
  } finally {
    bytes?.fill(0)
  }
}

async function decodeAuditCursor(input, token) {
  if (typeof token !== 'string' || token.length < 1 || token.length > 512) cursorInvalid()
  const segments = token.split('.')
  if (segments.length !== 4 || segments[0] !== 'v1') cursorInvalid()
  const [unused, versionText, encodedPosition, encodedMac] = segments
  void unused
  if (!/^[1-9]\d*$/.test(versionText)
    || !Number.isSafeInteger(Number(versionText))
    || String(Number(versionText)) !== versionText
    || encodedPosition.length < 1 || encodedPosition.length > MAX_CURSOR_POSITION_TEXT
    || encodedMac.length !== 43) cursorInvalid()
  const version = Number(versionText)
  const key = input.cryptoContext.keyring.getLookupHmac(version)
  if (!key) cursorInvalid()

  let positionBytes
  let mac
  let expected
  try {
    positionBytes = decodeBase64Url(encodedPosition)
    mac = decodeBase64Url(encodedMac)
    if (positionBytes.byteLength < 1 || positionBytes.byteLength > MAX_CURSOR_POSITION_BYTES
      || mac.byteLength !== 32) cursorInvalid()
    expected = await cursorMac(key, version, encodedPosition)
    let difference = 0
    for (let index = 0; index < 32; index += 1) difference |= mac[index] ^ expected[index]
    if (difference !== 0) cursorInvalid()

    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(positionBytes) } catch { cursorInvalid() }
    let parsed
    try { parsed = JSON.parse(text) } catch { cursorInvalid() }
    const position = exactSnapshot(parsed, ['id', 'occurredAt'], cursorInvalid)
    if (!validId(position.id) || !validInstant(position.occurredAt)
      || canonicalJson(position) !== text) cursorInvalid()
    return Object.freeze(position)
  } catch {
    cursorInvalid()
  } finally {
    positionBytes?.fill(0)
    mac?.fill(0)
    expected?.fill(0)
  }
}

async function encodeAuditCursor(input, row) {
  const version = input.cryptoContext.keyring.activeLookupKeyVersion
  const key = input.cryptoContext.keyring.getLookupHmac(version)
  if (!positive(version) || !key) invalidState()
  const text = canonicalJson({ id: row.id, occurredAt: row.occurred_at })
  let positionBytes
  let mac
  try {
    positionBytes = new TextEncoder().encode(text)
    if (positionBytes.byteLength > MAX_CURSOR_POSITION_BYTES) invalidState()
    const position = encodeBase64Url(positionBytes)
    if (position.length > MAX_CURSOR_POSITION_TEXT) invalidState()
    mac = await cursorMac(key, version, position)
    return `v1.${version}.${position}.${encodeBase64Url(mac)}`
  } catch (error) {
    if (error instanceof Error && error.message === 'OPERATIONS_STATE_INVALID') throw error
    invalidState()
  } finally {
    positionBytes?.fill(0)
    mac?.fill(0)
  }
}

async function parseAuditQuery(input) {
  if (!(input.query instanceof URLSearchParams)) invalid()
  let pairs
  try { pairs = [...input.query.entries()] } catch { invalid() }
  if (pairs.length > 2) throw new Error('VALIDATION_FAILED')
  const values = new Map()
  for (const [key, value] of pairs) {
    if (!['cursor', 'limit'].includes(key) || value === '' || values.has(key)) {
      throw new Error('VALIDATION_FAILED')
    }
    values.set(key, value)
  }
  const limitText = values.get('limit')
  if (limitText !== undefined && !/^(?:[1-9]|[1-9]\d|100)$/.test(limitText)) {
    throw new Error('VALIDATION_FAILED')
  }
  return {
    limit: limitText === undefined ? 50 : Number(limitText),
    cursor: values.has('cursor')
      ? await decodeAuditCursor(input, values.get('cursor'))
      : null,
  }
}

function auditMetadata(action, schema, text) {
  const metadata = parseCanonicalJson(text)
  if (!plainObject(metadata)) invalidState()
  if (isCoreAuditAction(action)) {
    const captured = captureCoreAuditMetadata(action, metadata)
    if (!captured) invalidState()
    return captured
  }
  if (isSystemAuditAction(action)) {
    const captured = captureSystemAuditMetadata(action, metadata)
    if (!captured) invalidState()
    return captured
  }
  const keys = Object.keys(metadata)
  const schemaKeys = Object.keys(schema.metadata)
  const legacyKeys = Object.keys(schema.legacyMetadata ?? {})
  const exact = keys.length === schemaKeys.length
    && schemaKeys.every((key) => Object.hasOwn(metadata, key))
  const legacy = !exact && schema.legacyMetadata
    && keys.length === legacyKeys.length
    && legacyKeys.every((key) => Object.hasOwn(metadata, key))
  if (!exact && !legacy) invalidState()
  const types = legacy ? schema.legacyMetadata : schema.metadata
  const shape = exactSnapshot(metadata, Object.keys(types), invalidState)
  for (const [key, type] of Object.entries(types)) {
    if ((type === 'version' && !positive(shape[key]))
      || (type === 'nullableVersion' && shape[key] !== null && !positive(shape[key]))
      || (type === 'count' && !safeCount(shape[key]))
      || (type === 'id' && !validId(shape[key]))
      || (type === 'assignmentId' && (typeof shape[key] !== 'string' || !ASSIGNMENT_ID.test(shape[key])))
      || (type === 'paymentId' && (typeof shape[key] !== 'string' || !PAYMENT_ID.test(shape[key])))
      || (type === 'correctionId' && (typeof shape[key] !== 'string' || !CORRECTION_ID.test(shape[key])))
      || (type === 'nullablePaymentId' && shape[key] !== null
        && (typeof shape[key] !== 'string' || !PAYMENT_ID.test(shape[key])))) invalidState()
  }
  return legacy ? { ...shape, specialistVersion: null } : shape
}

function validateAuditEvent(input, value) {
  const row = exactSnapshot(value, AUDIT_ROW_KEYS, invalidState)
  const schema = AUDIT_SCHEMAS[row.action]
  if (!validId(row.id) || !validInstant(row.occurred_at)
    || (row.actor_staff_id !== null && !validId(row.actor_staff_id))
    || !schema || !schema.entityTypes.includes(row.entity_type)
    || !validId(row.entity_id) || row.result !== schema.result
    || !validId(row.correlation_id)) invalidState()
  if (schema.entityId && !schema.entityId.test(row.entity_id)) invalidState()
  if (schema.reason === 'encrypted') {
    const envelope = parseEnvelopeText(row.reason_envelope)
    if (envelope.dataKeyId !== input.cryptoContext.dataKey.id
      || envelope.dataKeyVersion !== input.cryptoContext.dataKey.dek_version) invalidState()
  } else if (row.reason_envelope !== null) invalidState()
  const metadata = auditMetadata(row.action, schema, row.metadata_json)
  if (row.action === 'outbox.recovery.requested'
    && (metadata.actionVersion !== 1
      || ((metadata.desiredGeneration === null)
        === (metadata.invitationVersion === null)))) invalidState()
  if (isCoreAuditAction(row.action) && !readerCoreAuditEvent({
    action: row.action,
    actorStaffId: row.actor_staff_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    result: row.result,
    metadata,
  })) invalidState()
  if (isSystemAuditAction(row.action) && !readerSystemAuditEvent({
    action: row.action,
    actorStaffId: row.actor_staff_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    result: row.result,
    metadata,
  })) invalidState()
  if (schema.system && row.actor_staff_id !== null) invalidState()
  if (schema.human && !STAFF_ID.test(row.actor_staff_id ?? '')) invalidState()
  if (row.action === 'backup.pruned'
    && (row.entity_type !== 'backup_run'
      || !BACKUP_ID.test(row.entity_id) || row.result !== 'success'
      || row.reason_envelope !== null)) invalidState()
  if (row.action === 'specialist.backfilled'
    && !SPECIALIST_ID.test(row.entity_id)) invalidState()
  if (row.action === 'core_directory.upgrade.advanced'
    && row.entity_id !== 'core_directory_specialist_backfill_v1') invalidState()
  return { row, metadata }
}

export const READER_CORE_AUDIT_SCHEMAS = CORE_AUDIT_SCHEMAS
export const readerCoreAuditEvent = captureCoreAuditEvent
export const READER_SYSTEM_AUDIT_SCHEMAS = SYSTEM_AUDIT_SCHEMAS
export const readerSystemAuditEvent = captureSystemAuditEvent

const publicAuditEvent = ({ row, metadata }) => ({
  id: row.id,
  occurredAt: row.occurred_at,
  actorStaffId: row.actor_staff_id,
  action: row.action,
  entityType: row.entity_type,
  entityId: row.entity_id,
  result: row.result,
  correlationId: row.correlation_id,
  metadata,
})

function requireAuditNewestFirst(previous, current) {
  if (previous.occurred_at < current.occurred_at
    || (previous.occurred_at === current.occurred_at && previous.id <= current.id)) {
    invalidState()
  }
}

async function readAuditEvents(input, query) {
  const projection = `SELECT id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
                              reason_envelope,correlation_id,metadata_json
                       FROM audit_events`
  const statement = query.cursor
    ? input.db.prepare(
      `${projection}
       WHERE (occurred_at < ? OR (occurred_at = ? AND id < ?))
       ORDER BY occurred_at DESC,id DESC
       LIMIT ?`
    ).bind(
      query.cursor.occurredAt,
      query.cursor.occurredAt,
      query.cursor.id,
      query.limit + 1,
    )
    : input.db.prepare(
      `${projection}
       ORDER BY occurred_at DESC,id DESC
       LIMIT ?`
    ).bind(query.limit + 1)
  const result = await statement.all()
  const rows = captureAllRows(result, query.limit + 1)
  const validated = []
  let previous = null
  for (const value of rows) {
    const event = validateAuditEvent(input, value)
    if (query.cursor && !(event.row.occurred_at < query.cursor.occurredAt
      || (event.row.occurred_at === query.cursor.occurredAt
        && event.row.id < query.cursor.id))) invalidState()
    if (previous) requireAuditNewestFirst(previous, event.row)
    previous = event.row
    validated.push(event)
  }
  const returned = validated.slice(0, query.limit)
  return {
    events: returned.map(publicAuditEvent),
    nextCursor: validated.length > query.limit
      ? await encodeAuditCursor(input, returned.at(-1).row)
      : null,
  }
}

async function commitResolution(input, action, requestedVersion) {
  const auditId = actionIdFrom(input.idFactory)
  const audit = auditEventStatement(input.db, {
    id: auditId,
    occurredAt: input.now,
    actorStaffId: input.actor.id,
    action: 'operational_action.resolved',
    entityType: 'operational_action',
    entityId: action.row.id,
    result: 'success',
    correlationId: input.correlationId,
    metadata: { actionVersion: requestedVersion + 1 },
    reasonEnvelope: null,
  })
  const cas = input.db.prepare(
    `UPDATE operational_actions
     SET status='resolved',resolved_at=?,updated_at=?,version=version+1
     WHERE id=? AND status='open' AND version=?`
  ).bind(input.now, input.now, action.row.id, requestedVersion)
  const unit = createUnitOfWork(input.db, {
    mode: 'mutation',
    actorId: input.actor.id,
    correlationId: input.correlationId,
  })
  unit.audit(audit).domain(cas).guard(resolutionGuard(input, action, auditId))
  try {
    await unit.commit()
  } catch (error) {
    return recoverResolutionCollision(input, action, auditId, error)
  }
  return {
    data: {
      action: {
        id: action.row.id,
        status: 'resolved',
        version: requestedVersion + 1,
        resolvedAt: input.now,
        updatedAt: input.now,
      },
    },
  }
}

async function ensureNoPendingRecovery(input, actionId) {
  let row
  try {
    const result = await input.db.prepare(
      `SELECT recovery.id AS recovery_id,
              recovery.operational_action_id AS operational_action_id,
              recovery.replacement_job_id AS replacement_job_id,
              replacement.status AS replacement_status
       FROM outbox_job_recoveries AS recovery
       JOIN outbox_jobs AS replacement
         ON replacement.id=recovery.replacement_job_id
       WHERE recovery.operational_action_id=?`,
    ).bind(actionId).all()
    const rows = captureAllRows(result, 1)
    row = rows[0] ?? null
  } catch (error) {
    if (String(error?.message ?? '').includes('no such table: outbox_job_recoveries')) return
    throw error
  }
  if (row === null) return
  const captured = exactSnapshot(row, [
    'recovery_id',
    'operational_action_id',
    'replacement_job_id',
    'replacement_status',
  ], invalidState)
  if (!validId(captured.recovery_id)
    || captured.operational_action_id !== actionId
    || !validId(captured.replacement_job_id)
    || !['queued', 'processing', 'succeeded', 'dead'].includes(
      captured.replacement_status,
    )) invalidState()
  if (['queued', 'processing'].includes(captured.replacement_status)) {
    throw new Error('OUTBOX_RECOVERY_CONFLICT')
  }
}

export async function getOperationalHealth(value) {
  const input = captureInput(value)
  await requireCapability(input, 'operations.health.read')
  return { data: await readHealthSnapshot(input) }
}

export async function listOpenOperationalActions(value) {
  const input = captureInput(value)
  await requireCapability(input, 'operations.health.read')
  const canReadSecurity = authorize(
    input.actor, 'security.audit.read', CENTRE, { nowMs: input.nowMs }
  )
  return { data: await readOpenActions(input, canReadSecurity) }
}

export async function resolveOperationalAction(value) {
  const input = captureInput(value, ['actionId', 'idempotencyKey', 'body'])
  await requireCapability(input, 'operations.health.read')
  if (!validId(input.actionId)) invalid()
  if (typeof input.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new Error('VALIDATION_FAILED')
  const row = await readActionById(input, input.actionId)
  if (row === null) throw new Error('NOT_FOUND')
  if (row.kind === 'authorization_denial_spike') {
    await requireCapability(input, 'security.audit.read')
  }
  const action = await validateCapturedAction(input, row)
  if (ownerRecoveryDisposition(action)) await requireCapability(input, 'staff.manage')
  const body = resolutionBody(input.body)
  if (row.status !== 'open' || body.version !== row.version) versionConflict(row.version)
  await ensureNoPendingRecovery(input, row.id)
  return commitResolution(input, action, body.version)
}

export async function requestOperationalActionRecovery(value) {
  const input = captureInput(value, ['actionId', 'idempotencyKey', 'body'])
  await requireCapability(input, 'operations.health.read')
  await requireCapability(input, 'staff.manage')
  return requestOutboxRecovery({
    db: input.db,
    cryptoContext: input.cryptoContext,
    actor: input.actor,
    actionId: input.actionId,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    nowMs: input.nowMs,
    idFactory: input.idFactory,
  })
}

export async function listSecurityAudit(value) {
  const input = captureInput(value, ['query'])
  await requireCapability(input, 'security.audit.read')
  const query = await parseAuditQuery(input)
  return { data: await readAuditEvents(input, query) }
}
