const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/

const schema = (entityType, entityIdKind, metadata) => Object.freeze({
  entityType,
  entityIdKind,
  metadata: Object.freeze(metadata),
})

export const SYSTEM_AUDIT_SCHEMAS = Object.freeze({
  'staff.profile.updated': schema('staff_user', 'staffId', { staffVersion: 'version' }),
})

export const isSystemAuditAction = (action) => typeof action === 'string'
  && Object.hasOwn(SYSTEM_AUDIT_SCHEMAS, action)

const captureExactObject = (value, keys) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) return null
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null
      captured[key] = descriptor.value
    }
    return captured
  } catch {
    return null
  }
}

export const captureSystemAuditMetadata = (action, value) => {
  const metadataSchema = typeof action === 'string'
    ? SYSTEM_AUDIT_SCHEMAS[action]?.metadata
    : null
  if (!metadataSchema) return null
  const captured = captureExactObject(value, Object.keys(metadataSchema))
  if (!captured || Object.entries(metadataSchema).some(([key, type]) => (
    type !== 'version' || !Number.isSafeInteger(captured[key]) || captured[key] < 1
  ))) return null
  return Object.freeze(captured)
}

export const captureSystemAuditEvent = (value) => {
  const captured = captureExactObject(value, [
    'action', 'actorStaffId', 'entityType', 'entityId', 'result', 'metadata',
  ])
  const eventSchema = captured && typeof captured.action === 'string'
    ? SYSTEM_AUDIT_SCHEMAS[captured.action]
    : null
  const metadata = eventSchema
    && captureSystemAuditMetadata(captured.action, captured.metadata)
  if (!eventSchema || captured.actorStaffId !== null
    || captured.entityType !== eventSchema.entityType
    || eventSchema.entityIdKind !== 'staffId'
    || typeof captured.entityId !== 'string' || !STAFF_ID.test(captured.entityId)
    || captured.result !== 'success' || !metadata) return null
  return Object.freeze({ ...captured, metadata })
}
