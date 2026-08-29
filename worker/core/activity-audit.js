import { auditEventStatement } from '../audit/events.js'

const AUDIT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const JOB_ID = /^apj_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const invalid = () => { throw new Error('AUDIT_EVENT_INVALID') }

const exact = (value, keys) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid()
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
      captured[key] = descriptor.value
    }
    return captured
  } catch (error) {
    if (error?.message === 'AUDIT_EVENT_INVALID') throw error
    invalid()
  }
}

const instant = (value) => {
  try {
    return typeof value === 'string' && INSTANT.test(value)
      && new Date(value).toISOString() === value
  } catch { return false }
}

export function activityProjectionAuditStatement(input) {
  const value = exact(input, [
    'db', 'id', 'occurredAt', 'actorStaffId', 'jobId', 'correlationId',
    'jobVersion', 'processedCount', 'projectedCount',
  ])
  if (!value.db?.prepare || typeof value.id !== 'string' || !AUDIT_ID.test(value.id)
    || !instant(value.occurredAt) || typeof value.actorStaffId !== 'string'
    || !STAFF_ID.test(value.actorStaffId) || typeof value.jobId !== 'string'
    || !JOB_ID.test(value.jobId) || typeof value.correlationId !== 'string'
    || !CORRELATION_ID.test(value.correlationId)
    || !Number.isSafeInteger(value.jobVersion) || value.jobVersion < 1
    || !Number.isSafeInteger(value.processedCount) || value.processedCount < 0
    || !Number.isSafeInteger(value.projectedCount) || value.projectedCount < 0
    || value.projectedCount > value.processedCount) invalid()
  return auditEventStatement(value.db, {
    id: value.id,
    occurredAt: value.occurredAt,
    actorStaffId: value.actorStaffId,
    action: 'activity.projection.advanced',
    entityType: 'activity_projection_job',
    entityId: value.jobId,
    result: 'success',
    correlationId: value.correlationId,
    metadata: {
      jobVersion: value.jobVersion,
      processedCount: value.processedCount,
      projectedCount: value.projectedCount,
    },
    reasonEnvelope: null,
  })
}
