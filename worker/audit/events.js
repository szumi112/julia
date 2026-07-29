const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ACTIONS = new Set(['identity.activation', 'identity.denied', 'identity.reindex'])
const RESULTS = new Set(['success', 'denied', 'failure'])
const ENTITY_TYPES = new Set(['staff_user', 'staff_invitation'])

const validId = (value) => typeof value === 'string' && ID.test(value)
const validInstant = (value) => {
  try { return typeof value === 'string' && INSTANT.test(value) && new Date(value).toISOString() === value } catch { return false }
}

function metadataJson(metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('AUDIT_EVENT_INVALID')
  const entries = Object.entries(metadata)
  if (entries.some(([key, value]) => !/^[a-z][a-zA-Z0-9]{0,63}$/.test(key)
    || !Number.isSafeInteger(value) || value < 0)) throw new Error('AUDIT_EVENT_INVALID')
  return JSON.stringify(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))))
}

// This is the shared append-only event shape used by identity and later HTTP work.
export function auditEventStatement(db, event) {
  const keys = ['id', 'occurredAt', 'actorStaffId', 'action', 'entityType', 'entityId', 'result', 'correlationId', 'metadata']
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some((key) => !keys.includes(key))) throw new Error('AUDIT_EVENT_INVALID')
  const { id, occurredAt, actorStaffId = null, action, entityType, entityId, result, correlationId, metadata } = event ?? {}
  if (!db?.prepare || !validId(id) || !validInstant(occurredAt) || (actorStaffId !== null && !validId(actorStaffId))
    || !ACTIONS.has(action) || !ENTITY_TYPES.has(entityType) || !validId(entityId)
    || !RESULTS.has(result) || !validId(correlationId)) throw new Error('AUDIT_EVENT_INVALID')
  return db.prepare(
    `INSERT INTO audit_events
     (id, occurred_at, actor_staff_id, action, entity_type, entity_id, result, reason_envelope, correlation_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).bind(id, occurredAt, actorStaffId, action, entityType, entityId, result, correlationId, metadataJson(metadata))
}
