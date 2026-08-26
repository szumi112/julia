const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ASSIGNMENT_ID = /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CORRECTION_ID = /^cor_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/

const schema = (entityType, entityIdKind, metadata) => Object.freeze({
  entityType,
  entityIdKind,
  metadata: Object.freeze(metadata),
})

export const CORE_AUDIT_SCHEMAS = Object.freeze({
  'appointment.cancelled': schema('appointment', 'appointmentId', { appointmentVersion: 'version', chargeVersion: 'version' }),
  'appointment.created': schema('appointment', 'appointmentId', { appointmentVersion: 'version', chargeVersion: 'version' }),
  'appointment.updated': schema('appointment', 'appointmentId', { appointmentVersion: 'version', chargeVersion: 'version' }),
  'client.archived': schema('client', 'clientId', { assignmentId: 'assignmentId', assignmentVersion: 'version', clientVersion: 'version' }),
  'client.assignment.changed': schema('client', 'clientId', { clientVersion: 'version', closedAssignmentId: 'assignmentId', closedAssignmentVersion: 'version', newAssignmentId: 'assignmentId', newAssignmentVersion: 'version' }),
  'client.created': schema('client', 'clientId', { assignmentId: 'assignmentId', assignmentVersion: 'version', clientVersion: 'version' }),
  'client.updated': schema('client', 'clientId', { clientVersion: 'version' }),
  'payment.corrected': schema('payment_entry', 'paymentId', { appointmentVersion: 'version', correctionId: 'correctionId', replacementEntryId: 'nullablePaymentId', reversedEntryId: 'paymentId' }),
  'payment.recorded': schema('appointment', 'appointmentId', { appointmentVersion: 'version', paymentEntryId: 'paymentId' }),
})

export const CORE_AUDIT_ACTIONS = Object.freeze(Object.keys(CORE_AUDIT_SCHEMAS))

export const isCoreAuditAction = (action) => typeof action === 'string'
  && Object.hasOwn(CORE_AUDIT_SCHEMAS, action)

const captureExactDataObject = (value, keys) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return null
    const captured = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
      captured[key] = descriptor.value
    }
    return captured
  } catch {
    return null
  }
}

const acceptsType = (type, value) => {
  if (type === 'version') return Number.isSafeInteger(value) && value > 0
  if (type === 'assignmentId') return typeof value === 'string' && ASSIGNMENT_ID.test(value)
  if (type === 'correctionId') return typeof value === 'string' && CORRECTION_ID.test(value)
  if (type === 'paymentId') return typeof value === 'string' && PAYMENT_ID.test(value)
  return type === 'nullablePaymentId'
    && (value === null || (typeof value === 'string' && PAYMENT_ID.test(value)))
}

export const captureCoreAuditMetadata = (action, value) => {
  const metadataSchema = typeof action === 'string'
    ? CORE_AUDIT_SCHEMAS[action]?.metadata
    : null
  if (!metadataSchema) return null
  const captured = captureExactDataObject(value, Object.keys(metadataSchema))
  if (!captured || Object.entries(metadataSchema)
    .some(([key, type]) => !acceptsType(type, captured[key]))) return null
  return Object.freeze(captured)
}

const acceptsEntityId = (kind, value) => typeof value === 'string' && ({
  appointmentId: APPOINTMENT_ID,
  clientId: CLIENT_ID,
  paymentId: PAYMENT_ID,
})[kind].test(value)

export const captureCoreAuditEvent = (value) => {
  const captured = captureExactDataObject(value, [
    'action', 'actorStaffId', 'entityType', 'entityId', 'result', 'metadata',
  ])
  const eventSchema = captured && typeof captured.action === 'string'
    ? CORE_AUDIT_SCHEMAS[captured.action]
    : null
  const metadata = eventSchema && captureCoreAuditMetadata(captured.action, captured.metadata)
  if (!eventSchema || typeof captured.actorStaffId !== 'string'
    || !STAFF_ID.test(captured.actorStaffId) || captured.entityType !== eventSchema.entityType
    || !acceptsEntityId(eventSchema.entityIdKind, captured.entityId)
    || captured.result !== 'success' || !metadata) return null
  return Object.freeze({ ...captured, metadata })
}
