import { encryptForScope } from '../security/envelope.js'
import { decodeBase64Url } from '../security/encoding.js'
import {
  captureCoreAuditEvent,
  captureCoreAuditMetadata,
  CORE_AUDIT_SCHEMAS,
  isCoreAuditAction,
} from '../../src/core-audit-contract.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const ASSIGNMENT_ID = /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CORRECTION_ID = /^cor_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_REASON_PLAINTEXT_BYTES = 2048
const descriptors = new WeakMap()
const fields = ['id', 'occurredAt', 'actorStaffId', 'action', 'entityType', 'entityId', 'result', 'correlationId', 'metadata', 'reasonEnvelope']
const schemas = Object.freeze({
  ...Object.fromEntries(Object.entries(CORE_AUDIT_SCHEMAS).map(([action, schema]) => [action,
    Object.freeze({ entityTypes: Object.freeze([schema.entityType]), result: 'success', metadata: schema.metadata, reasonPolicy: 'null', human: true })
  ])),
  'identity.activation': Object.freeze({ entityTypes: ['staff_user'], result: 'success', metadata: Object.freeze({ staffVersion: 'version', invitationVersion: 'version', specialistVersion: 'nullableVersion' }), reasonPolicy: 'null' }),
  'identity.denied': Object.freeze({ entityTypes: ['staff_user'], result: 'denied', metadata: Object.freeze({ version: 'version' }), reasonPolicy: 'null' }),
  'identity.reindex': Object.freeze({ entityTypes: ['staff_user', 'staff_invitation'], result: 'success', metadata: Object.freeze({ version: 'version' }), reasonPolicy: 'null' }),
  'data_key.rewrapped': Object.freeze({ entityTypes: ['data_key'], result: 'success', metadata: Object.freeze({ oldKekVersion: 'version', newKekVersion: 'version' }), reasonPolicy: 'null' }),
  'authorization.denied': Object.freeze({ entityTypes: ['staff_user'], result: 'denied', metadata: Object.freeze({ version: 'version' }), reasonPolicy: 'encrypted' }),
  'operational_action.resolved': Object.freeze({ entityTypes: ['operational_action'], result: 'success', metadata: Object.freeze({ actionVersion: 'version' }), reasonPolicy: 'null' }),
  'staff.invited': Object.freeze({ entityTypes: ['staff_invitation'], result: 'success', metadata: Object.freeze({ staffVersion: 'version', invitationVersion: 'version', desiredGeneration: 'version', specialistVersion: 'nullableVersion' }), reasonPolicy: 'null' }),
  'staff.deactivated': Object.freeze({ entityTypes: ['staff_user'], result: 'success', metadata: Object.freeze({ staffVersion: 'version', desiredGeneration: 'version', specialistVersion: 'nullableVersion' }), reasonPolicy: 'null' }),
  'staff.invitation.expired': Object.freeze({ entityTypes: ['staff_invitation'], result: 'success', metadata: Object.freeze({ staffVersion: 'version', invitationVersion: 'version', desiredGeneration: 'version', specialistVersion: 'nullableVersion' }), reasonPolicy: 'null' }),
  'staff.access.reconciled': Object.freeze({ entityTypes: ['access_group'], result: 'success', metadata: Object.freeze({ desiredGeneration: 'version', appliedGeneration: 'version', invitationCount: 'count' }), reasonPolicy: 'null' }),
  'staff.bootstrap': Object.freeze({ entityTypes: ['staff_user'], result: 'success', metadata: Object.freeze({ staffVersion: 'version', invitationVersion: 'version', desiredGeneration: 'version', specialistVersion: 'nullableVersion' }), reasonPolicy: 'null' }),
  'staff.invitation.email_accepted': Object.freeze({ entityTypes: ['staff_invitation'], result: 'success', metadata: Object.freeze({ invitationVersion: 'version' }), reasonPolicy: 'null' }),
  'specialist.backfilled': Object.freeze({ entityTypes: ['specialist'], entityId: (value) => SPECIALIST_ID.test(value), result: 'success', metadata: Object.freeze({ specialistVersion: 'version', stateVersion: 'version' }), reasonPolicy: 'null', system: true }),
  'core_directory.upgrade.advanced': Object.freeze({ entityTypes: ['system_state'], entityId: (value) => value === 'core_directory_specialist_backfill_v1', result: 'success', metadata: Object.freeze({ stateVersion: 'version', processedCount: 'count', createdCount: 'count' }), reasonPolicy: 'null', system: true }),
  'backup.pruned': Object.freeze({ entityTypes: ['backup_run'], result: 'success', metadata: Object.freeze({ backupVersion: 'version' }), reasonPolicy: 'null', system: true }),
})

const own = (object, key) => Object.hasOwn(object, key)
const validId = (value) => typeof value === 'string' && ID.test(value)
const validInstant = (value) => {
  try { return typeof value === 'string' && INSTANT.test(value) && new Date(value).toISOString() === value } catch { return false }
}
const exactObject = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every((key) => own(value, key))

function metadataJson(action, metadata) {
  if (isCoreAuditAction(action)) {
    const captured = captureCoreAuditMetadata(action, metadata)
    if (!captured) throw new Error('AUDIT_EVENT_INVALID')
    return JSON.stringify(Object.fromEntries(Object.entries(captured)
      .sort(([left], [right]) => left.localeCompare(right))))
  }
  const schema = schemas[action]?.metadata
  if (!exactObject(metadata, Object.keys(schema ?? {})) || Object.keys(metadata).length > 8) throw new Error('AUDIT_EVENT_INVALID')
  for (const [key, type] of Object.entries(schema)) {
    const value = metadata[key]
    if ((type === 'version' && (!Number.isSafeInteger(value) || value < 1))
      || (type === 'nullableVersion' && value !== null
        && (!Number.isSafeInteger(value) || value < 1))
      || (type === 'count' && (!Number.isSafeInteger(value) || value < 0))
      || (type === 'id' && !validId(value))
      || (type === 'assignmentId' && (typeof value !== 'string' || !ASSIGNMENT_ID.test(value)))
      || (type === 'paymentId' && (typeof value !== 'string' || !PAYMENT_ID.test(value)))
      || (type === 'correctionId' && (typeof value !== 'string' || !CORRECTION_ID.test(value)))
      || (type === 'nullablePaymentId' && value !== null
        && (typeof value !== 'string' || !PAYMENT_ID.test(value)))) throw new Error('AUDIT_EVENT_INVALID')
  }
  const text = JSON.stringify(Object.fromEntries(Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right))))
  if (text.length > 512) throw new Error('AUDIT_EVENT_INVALID')
  return text
}

function validReasonEnvelope(value) {
  if (typeof value !== 'string' || value.length > 8192) return false
  let nonce
  let ciphertext
  try {
    const parsed = JSON.parse(value)
    if (!(exactObject(parsed, ['format', 'algorithm', 'dataKeyId', 'dataKeyVersion', 'nonce', 'ciphertext'])
      && parsed.format === 1 && parsed.algorithm === 'A256GCM' && validId(parsed.dataKeyId)
      && Number.isSafeInteger(parsed.dataKeyVersion) && parsed.dataKeyVersion > 0
      && typeof parsed.nonce === 'string' && typeof parsed.ciphertext === 'string')) return false
    nonce = decodeBase64Url(parsed.nonce)
    ciphertext = decodeBase64Url(parsed.ciphertext)
    return nonce.byteLength === 12 && ciphertext.byteLength >= 16
  } catch {
    return false
  } finally {
    nonce?.fill(0)
    ciphertext?.fill(0)
  }
}

export function auditDescriptorFor(statement) {
  return descriptors.get(statement) ?? null
}

export function auditEventStatement(db, event) {
  if (!exactObject(event, fields) || !db?.prepare) throw new Error('AUDIT_EVENT_INVALID')
  const { id, occurredAt, actorStaffId, action, entityType, entityId, result, correlationId, metadata, reasonEnvelope } = event
  const schema = schemas[action]
  if (isCoreAuditAction(action) && !writerCoreAuditEvent({
    action, actorStaffId, entityType, entityId, result, metadata,
  })) throw new Error('AUDIT_EVENT_INVALID')
  const reasonValid = schema?.reasonPolicy === 'null'
    ? reasonEnvelope === null
    : schema?.reasonPolicy === 'encrypted' && validReasonEnvelope(reasonEnvelope)
  if (!validId(id) || !validInstant(occurredAt) || (actorStaffId !== null && !validId(actorStaffId)) || !schema
    || !schema.entityTypes.includes(entityType) || schema.result !== result || !validId(entityId)
    || (schema.entityId && !schema.entityId(entityId))
    || (schema.system && actorStaffId !== null)
    || (schema.human && (typeof actorStaffId !== 'string' || !STAFF_ID.test(actorStaffId)))
    || !validId(correlationId) || !reasonValid) throw new Error('AUDIT_EVENT_INVALID')
  const statement = db.prepare(
    `INSERT INTO audit_events
     (id, occurred_at, actor_staff_id, action, entity_type, entity_id, result, reason_envelope, correlation_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, occurredAt, actorStaffId, action, entityType, entityId, result, reasonEnvelope, correlationId, metadataJson(action, metadata))
  descriptors.set(statement, Object.freeze({ id, action, entityType, entityId, result, actorStaffId, correlationId }))
  return statement
}

export const WRITER_CORE_AUDIT_SCHEMAS = CORE_AUDIT_SCHEMAS
export const writerCoreAuditEvent = captureCoreAuditEvent

export async function encryptAuditReason(input = {}) {
  const keys = ['keyring', 'dataKey', 'expectedScope', 'auditEventId', 'plaintext']
  if (!exactObject(input, keys) || !validId(input.auditEventId) || typeof input.plaintext !== 'string') throw new Error('AUDIT_EVENT_INVALID')
  const { keyring, dataKey, expectedScope, auditEventId, plaintext } = input
  const encoded = new TextEncoder().encode(plaintext)
  try {
    if (encoded.byteLength < 1 || encoded.byteLength > MAX_REASON_PLAINTEXT_BYTES) throw new Error('AUDIT_EVENT_INVALID')
    const serialized = JSON.stringify(await encryptForScope(keyring, dataKey, {
      expectedScope, recordId: auditEventId, field: 'reason', plaintext,
    }))
    if (!validReasonEnvelope(serialized)) throw new Error('AUDIT_EVENT_INVALID')
    return serialized
  } finally {
    encoded.fill(0)
  }
}

export async function enforceAuditRateLimit(db, { actorId, action, limit, since } = {}) {
  if (!db?.prepare || !validId(actorId) || !Object.hasOwn(schemas, action)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000 || !validInstant(since)) {
    throw new Error('AUDIT_EVENT_INVALID')
  }
  const row = await db.prepare(
    `SELECT count(*) AS count
     FROM audit_events
     WHERE actor_staff_id=? AND action=? AND occurred_at>=?`
  ).bind(actorId, action, since).first()
  const count = row?.count
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('AUDIT_EVENT_INVALID')
  if (count >= limit) throw new Error('RATE_LIMITED')
  return count
}
