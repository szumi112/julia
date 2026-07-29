import { encryptForScope } from '../security/envelope.js'
import { decodeBase64Url } from '../security/encoding.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_REASON_PLAINTEXT_BYTES = 2048
const descriptors = new WeakMap()
const fields = ['id', 'occurredAt', 'actorStaffId', 'action', 'entityType', 'entityId', 'result', 'correlationId', 'metadata', 'reasonEnvelope']
const schemas = Object.freeze({
  'identity.activation': Object.freeze({ entityTypes: ['staff_user'], result: 'success', metadata: Object.freeze({ staffVersion: 'version', invitationVersion: 'version' }), reasonPolicy: 'null' }),
  'identity.denied': Object.freeze({ entityTypes: ['staff_user'], result: 'denied', metadata: Object.freeze({ version: 'version' }), reasonPolicy: 'null' }),
  'identity.reindex': Object.freeze({ entityTypes: ['staff_user', 'staff_invitation'], result: 'success', metadata: Object.freeze({ version: 'version' }), reasonPolicy: 'null' }),
  'data_key.rewrapped': Object.freeze({ entityTypes: ['data_key'], result: 'success', metadata: Object.freeze({ oldKekVersion: 'version', newKekVersion: 'version' }), reasonPolicy: 'null' }),
  'authorization.denied': Object.freeze({ entityTypes: ['staff_user'], result: 'denied', metadata: Object.freeze({ version: 'version' }), reasonPolicy: 'encrypted' }),
})

const own = (object, key) => Object.hasOwn(object, key)
const validId = (value) => typeof value === 'string' && ID.test(value)
const validInstant = (value) => {
  try { return typeof value === 'string' && INSTANT.test(value) && new Date(value).toISOString() === value } catch { return false }
}
const exactObject = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every((key) => own(value, key))

function metadataJson(action, metadata) {
  const schema = schemas[action]?.metadata
  if (!exactObject(metadata, Object.keys(schema ?? {})) || Object.keys(metadata).length > 8) throw new Error('AUDIT_EVENT_INVALID')
  for (const [key, type] of Object.entries(schema)) {
    const value = metadata[key]
    if ((type === 'version' && (!Number.isSafeInteger(value) || value < 1))
      || (type === 'count' && (!Number.isSafeInteger(value) || value < 0))
      || (type === 'id' && !validId(value))) throw new Error('AUDIT_EVENT_INVALID')
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
  const reasonValid = schema?.reasonPolicy === 'null'
    ? reasonEnvelope === null
    : schema?.reasonPolicy === 'encrypted' && validReasonEnvelope(reasonEnvelope)
  if (!validId(id) || !validInstant(occurredAt) || (actorStaffId !== null && !validId(actorStaffId)) || !schema
    || !schema.entityTypes.includes(entityType) || schema.result !== result || !validId(entityId)
    || !validId(correlationId) || !reasonValid) throw new Error('AUDIT_EVENT_INVALID')
  const statement = db.prepare(
    `INSERT INTO audit_events
     (id, occurred_at, actor_staff_id, action, entity_type, entity_id, result, reason_envelope, correlation_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, occurredAt, actorStaffId, action, entityType, entityId, result, reasonEnvelope, correlationId, metadataJson(action, metadata))
  descriptors.set(statement, Object.freeze({ id, action, entityType, entityId, result, actorStaffId, correlationId }))
  return statement
}

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
