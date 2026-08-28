const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ASSIGNMENT_ID = /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CORRECTION_ID = /^cor_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const FINANCE_BATCH_ID = /^fib_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const FINANCE_ENTRY_ID = /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const WORKBOOK_IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const HISTORICAL_CLIENT_ID = /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ACTIVITY_GROUP_ID = /^agr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ACTIVITY_PARTICIPANT_ID = /^acp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ACTIVITY_MEMBERSHIP_ID = /^amb_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ACTIVITY_CLASS_ID = /^acl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ACTIVITY_ATTENDANCE_ID = /^aat_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ACTIVITY_PROJECTION_JOB_ID = /^apj_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/

const schema = (entityType, entityIdKind, metadata) => Object.freeze({
  entityType,
  entityIdKind,
  metadata: Object.freeze(metadata),
})

export const CORE_AUDIT_SCHEMAS = Object.freeze({
  'activity.attendance.set': schema('activity_attendance', 'activityAttendanceId', { attendanceVersion: 'version' }),
  'activity.class.created': schema('activity_class', 'activityClassId', { classVersion: 'version' }),
  'activity.class.updated': schema('activity_class', 'activityClassId', { classVersion: 'version' }),
  'activity.group.created': schema('activity_group', 'activityGroupId', { groupVersion: 'version', leaderCount: 'count' }),
  'activity.group.updated': schema('activity_group', 'activityGroupId', { groupVersion: 'version', leaderCount: 'count' }),
  'activity.membership.created': schema('activity_membership', 'activityMembershipId', { membershipVersion: 'version' }),
  'activity.membership.updated': schema('activity_membership', 'activityMembershipId', { membershipVersion: 'version' }),
  'activity.participant.created': schema('activity_participant', 'activityParticipantId', { participantVersion: 'version' }),
  'activity.participant.updated': schema('activity_participant', 'activityParticipantId', { participantVersion: 'version' }),
  'activity.projection.advanced': schema('activity_projection_job', 'activityProjectionJobId', { jobVersion: 'version', processedCount: 'count', projectedCount: 'count' }),
  'appointment.cancelled': schema('appointment', 'appointmentId', { appointmentVersion: 'version', chargeVersion: 'version' }),
  'appointment.created': schema('appointment', 'appointmentId', { appointmentVersion: 'version', chargeVersion: 'version' }),
  'appointment.updated': schema('appointment', 'appointmentId', { appointmentVersion: 'version', chargeVersion: 'version' }),
  'client.archived': schema('client', 'clientId', { assignmentId: 'assignmentId', assignmentVersion: 'version', clientVersion: 'version' }),
  'client.assignment.changed': schema('client', 'clientId', { clientVersion: 'version', closedAssignmentId: 'assignmentId', closedAssignmentVersion: 'version', newAssignmentId: 'assignmentId', newAssignmentVersion: 'version' }),
  'client.created': schema('client', 'clientId', { assignmentId: 'assignmentId', assignmentVersion: 'version', clientVersion: 'version' }),
  'client.updated': schema('client', 'clientId', { clientVersion: 'version' }),
  'finance.import.chunk.accepted': schema('finance_import', 'financeBatchId', { batchVersion: 'version', rowCount: 'count' }),
  'finance.import.committed': schema('finance_import', 'financeBatchId', { batchVersion: 'version', rowCount: 'count' }),
  'finance.import.started': schema('finance_import', 'financeBatchId', { batchVersion: 'version', rowCount: 'count' }),
  'payment.corrected': schema('payment_entry', 'paymentId', { appointmentVersion: 'version', correctionId: 'correctionId', replacementEntryId: 'nullablePaymentId', reversedEntryId: 'paymentId' }),
  'payment.recorded': schema('appointment', 'appointmentId', { appointmentVersion: 'version', paymentEntryId: 'paymentId' }),
  'specialist.profile.created': schema('specialist', 'specialistId', { specialistVersion: 'version' }),
  'specialist.profile.updated': schema('specialist', 'specialistId', { specialistVersion: 'version' }),
  'workbook.import.created': schema('workbook_import', 'workbookImportId', { acceptedCount: 'count', importVersion: 'version', quarantinedCount: 'count' }),
  'workbook.import.materialized': schema('workbook_import', 'workbookImportId', { accountingMonthsCorrected: 'count', importVersion: 'version', insertedCount: 'count', linkedCount: 'count', voidedCount: 'count' }),
  'historical_client.activated': schema('historical_client', 'historicalClientId', { activeClientId: 'clientId', activeClientVersion: 'version', assignmentId: 'assignmentId', assignmentVersion: 'version', historicalClientVersion: 'version' }),
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
  if (type === 'count') return Number.isSafeInteger(value) && value >= 0
  if (type === 'assignmentId') return typeof value === 'string' && ASSIGNMENT_ID.test(value)
  if (type === 'clientId') return typeof value === 'string' && CLIENT_ID.test(value)
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
  financeBatchId: FINANCE_BATCH_ID,
  financeEntryId: FINANCE_ENTRY_ID,
  paymentId: PAYMENT_ID,
  specialistId: SPECIALIST_ID,
  workbookImportId: WORKBOOK_IMPORT_ID,
  historicalClientId: HISTORICAL_CLIENT_ID,
  activityGroupId: ACTIVITY_GROUP_ID,
  activityParticipantId: ACTIVITY_PARTICIPANT_ID,
  activityMembershipId: ACTIVITY_MEMBERSHIP_ID,
  activityClassId: ACTIVITY_CLASS_ID,
  activityAttendanceId: ACTIVITY_ATTENDANCE_ID,
  activityProjectionJobId: ACTIVITY_PROJECTION_JOB_ID,
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
