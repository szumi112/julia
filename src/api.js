import { APP_MODE } from './app-mode.js'
import { isWellFormedUnicode } from './core-records.js'
import { SERVICE_BY_ID } from './services.js'
import {
  captureCoreAuditEvent,
  captureCoreAuditMetadata,
  CORE_AUDIT_SCHEMAS,
  isCoreAuditAction,
} from './core-audit-contract.js'

const API_ROOT = '/api/v1'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CSRF_TOKEN = /^v1\.([1-9]\d*)\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const ASSIGNMENT_ID = /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CHARGE_ID = /^chg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CORRECTION_ID = /^cor_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const OUTBOX_TYPE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/
const AUDIT_CURSOR = /^v1\.([1-9]\d*)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const INVALID_TEXT = /[\p{Cc}\p{Cf}]/u
const workspaceCollator = new Intl.Collator('pl-PL', { sensitivity: 'base', usage: 'sort' })
const WORKSPACE_SERVICE_IDS = new Set(Object.keys(SERVICE_BY_ID))
const workspaceDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

const SERVER_STATUS = Object.freeze({
  INVALID_CONTENT_LENGTH: 400,
  INVALID_JSON: 400,
  VALIDATION_FAILED: 400,
  ACCESS_ASSERTION_INVALID: 401,
  ACCESS_DENIED: 403,
  FORBIDDEN: 403,
  ORIGIN_INVALID: 403,
  FETCH_METADATA_INVALID: 403,
  CSRF_INVALID: 403,
  CSRF_EXPIRED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  IDEMPOTENCY_CONFLICT: 409,
  WORKSPACE_RESULT_LIMIT: 409,
  CLIENT_STATUS_CONFLICT: 409,
  CLIENT_ASSIGNMENT_CONFLICT: 409,
  CLIENT_ARCHIVE_CONFLICT: 409,
  APPOINTMENT_OVERLAP: 409,
  APPOINTMENT_PAYMENT_CONFLICT: 409,
  PAYMENT_AMOUNT_CONFLICT: 409,
  PAYMENT_CORRECTION_CONFLICT: 409,
  STAFF_INVITATION_CONFLICT: 409,
  LAST_ACTIVE_OWNER: 409,
  VERSION_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  ACCESS_KEYSET_UNAVAILABLE: 503,
})
const CLIENT_CODES = new Set([
  'CLIENT_INPUT_INVALID',
  'INVALID_RESPONSE',
  'NETWORK_ERROR',
  'SESSION_REQUIRED',
])
const AUTH_DENIAL_CODES = new Set(['ACCESS_ASSERTION_INVALID', 'ACCESS_DENIED'])
const VALIDATION_FIELDS = new Set([
  'body', 'displayName', 'email', 'role', 'version', 'name', 'age', 'status',
  'specialistId', 'clientId', 'serviceId', 'dateTime', 'durationMinutes',
  'expectedAmountGrosze', 'location', 'amountGrosze', 'method', 'receivedAt',
  'paidDate', 'reason', 'replacement', 'expectedVersion', 'from', 'to',
  'specialists', 'clients', 'appointments', 'paymentEntries',
])
const WORKSPACE_FIELDS = new Set(['specialists', 'clients', 'appointments', 'paymentEntries'])
const CAPABILITIES = Object.freeze([
  'appointment.charge.read',
  'appointment.manage',
  'centre.manage',
  'chat.direct',
  'chat.general',
  'client.manage',
  'client.operational.read',
  'clinical.read',
  'finance.centre.read',
  'operations.health.read',
  'payment.manage',
  'security.audit.read',
  'specialist.directory.read',
  'staff.manage',
  'tus.manage',
])
const CAPABILITY_VOCABULARY = new Set(CAPABILITIES)
const ROLE_CAPABILITIES = Object.freeze({
  owner: CAPABILITIES,
  coordinator: Object.freeze([
    'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
    'client.manage', 'client.operational.read', 'finance.centre.read',
    'operations.health.read', 'payment.manage', 'specialist.directory.read', 'tus.manage',
  ]),
  specialist: Object.freeze([
    'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
    'client.manage', 'client.operational.read', 'clinical.read', 'payment.manage',
    'specialist.directory.read', 'tus.manage',
  ]),
})
const ROLES = new Set(['owner', 'coordinator', 'specialist'])
const STAFF_STATUSES = new Set(['active', 'disabled', 'pending'])
const INVITATION_STATUSES = new Set(['pending', 'provisioning'])
const ENVIRONMENTS = new Set(['development', 'staging', 'production'])
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
const AUDIT_SCHEMAS = Object.freeze({
  ...Object.fromEntries(Object.entries(CORE_AUDIT_SCHEMAS).map(([action, schema]) => [action,
    Object.freeze({ entityTypes: Object.freeze([schema.entityType]), result: 'success', metadata: schema.metadata })
  ])),
  'authorization.denied': Object.freeze({ entityTypes: ['staff_user'], result: 'denied', metadata: { version: 'version' } }),
  'backup.pruned': Object.freeze({ entityTypes: ['backup_run'], result: 'success', metadata: { backupVersion: 'version' }, system: true }),
  'data_key.rewrapped': Object.freeze({ entityTypes: ['data_key'], result: 'success', metadata: { newKekVersion: 'version', oldKekVersion: 'version' } }),
  'identity.activation': Object.freeze({ entityTypes: ['staff_user'], result: 'success', metadata: { invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { invitationVersion: 'version', staffVersion: 'version' } }),
  'identity.denied': Object.freeze({ entityTypes: ['staff_user'], result: 'denied', metadata: { version: 'version' } }),
  'identity.reindex': Object.freeze({ entityTypes: ['staff_invitation', 'staff_user'], result: 'success', metadata: { version: 'version' } }),
  'operational_action.resolved': Object.freeze({ entityTypes: ['operational_action'], result: 'success', metadata: { actionVersion: 'version' } }),
  'staff.access.reconciled': Object.freeze({ entityTypes: ['access_group'], result: 'success', metadata: { appliedGeneration: 'version', desiredGeneration: 'version', invitationCount: 'count' } }),
  'staff.bootstrap': Object.freeze({ entityTypes: ['staff_user'], result: 'success', metadata: { desiredGeneration: 'version', invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', invitationVersion: 'version', staffVersion: 'version' } }),
  'staff.deactivated': Object.freeze({ entityTypes: ['staff_user'], result: 'success', metadata: { desiredGeneration: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', staffVersion: 'version' } }),
  'staff.invitation.email_accepted': Object.freeze({ entityTypes: ['staff_invitation'], result: 'success', metadata: { invitationVersion: 'version' } }),
  'staff.invitation.expired': Object.freeze({ entityTypes: ['staff_invitation'], result: 'success', metadata: { desiredGeneration: 'version', invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', invitationVersion: 'version', staffVersion: 'version' } }),
  'staff.invited': Object.freeze({ entityTypes: ['staff_invitation'], result: 'success', metadata: { desiredGeneration: 'version', invitationVersion: 'version', specialistVersion: 'nullableVersion', staffVersion: 'version' }, legacyMetadata: { desiredGeneration: 'version', invitationVersion: 'version', staffVersion: 'version' } }),
  'specialist.backfilled': Object.freeze({ entityTypes: ['specialist'], result: 'success', metadata: { specialistVersion: 'version', stateVersion: 'version' }, system: true }),
  'core_directory.upgrade.advanced': Object.freeze({ entityTypes: ['system_state'], result: 'success', metadata: { createdCount: 'count', processedCount: 'count', stateVersion: 'version' }, system: true }),
})

const plainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const validId = (value) => typeof value === 'string' && ID.test(value)
const validText = (value, maxBytes) => typeof value === 'string' && value.length > 0
  && value === value.normalize('NFC') && value === value.trim() && !INVALID_TEXT.test(value)
  && new TextEncoder().encode(value).byteLength <= maxBytes
const validIso = (value) => {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && validIso(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0
const safeCount = (value) => Number.isSafeInteger(value) && value >= 0
const exactObject = (value, keys) => {
  if (!plainObject(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
}
const captureExactObject = (value, keys) => {
  if (!exactObject(value, keys)) return null
  const captured = {}
  for (const key of keys) captured[key] = value[key]
  return captured
}
const captureArray = (value, maximum) => {
  if (!Array.isArray(value)) return null
  const length = value.length
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null
  const captured = new Array(length)
  for (let index = 0; index < length; index += 1) captured[index] = value[index]
  return captured
}

const captureDataObject = (value, keys) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) return null
    const captured = Object.create(null)
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

const captureDenseArray = (value, maximum) => {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum
      || Reflect.ownKeys(descriptors).length !== length + 1) return null
    const captured = new Array(length)
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null
      captured[index] = descriptor.value
    }
    return captured
  } catch {
    return null
  }
}

const workspaceCivil = (value) => {
  if (typeof value !== 'string') return null
  const match = CIVIL_DATE.exec(value)
  if (!match) return null
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const date = new Date(epoch)
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    ? Object.freeze({ value, epoch })
    : null
}

const acceptedWorkspaceOptions = (options) => {
  const captured = captureDataObject(options, ['from', 'to'])
  const from = captured && workspaceCivil(captured.from)
  const to = captured && workspaceCivil(captured.to)
  if (!from || !to) return null
  const days = Math.floor((to.epoch - from.epoch) / 86_400_000) + 1
  return days >= 1 && days <= 93
    ? Object.freeze({ from: from.value, to: to.value })
    : null
}

const workspaceOffsetAt = (epoch) => {
  const fields = Object.fromEntries(workspaceDayFormatter.formatToParts(new Date(epoch))
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, Number(value)]))
  return Date.UTC(fields.year, fields.month - 1, fields.day,
    fields.hour, fields.minute, fields.second) - epoch
}

const workspaceMidnight = (civil) => {
  let instant = civil.epoch - workspaceOffsetAt(civil.epoch)
  instant = civil.epoch - workspaceOffsetAt(instant)
  return new Date(instant).toISOString()
}

const workspaceBounds = (requested) => {
  const from = workspaceCivil(requested.from)
  const to = workspaceCivil(requested.to)
  if (!from || !to) return null
  const after = Object.freeze({ epoch: to.epoch + 86_400_000 })
  return Object.freeze({ lower: workspaceMidnight(from), upper: workspaceMidnight(after) })
}

const workspacePositive = (value, maximum = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && value >= 1 && value <= maximum
)
const workspaceNullableInstant = (value) => value === null || validInstant(value)
const validWorkspaceText = (value, maxBytes) => typeof value === 'string'
  && isWellFormedUnicode(value) && validText(value, maxBytes)
const workspaceLocation = (value) => value === null || validWorkspaceText(value, 80)
const workspaceIdentity = (name, age) => validWorkspaceText(name, 120)
  && (age === null || (Number.isSafeInteger(age) && age >= 1 && age <= 26))

const captureWorkspaceSpecialist = (raw) => {
  const value = captureDataObject(raw, [
    'id', 'displayName', 'standardRateGrosze', 'status', 'version', 'staffVersion',
  ])
  if (!value || typeof value.id !== 'string' || !SPECIALIST_ID.test(value.id)
    || !validWorkspaceText(value.displayName, 120)
    || !workspacePositive(value.standardRateGrosze, 1_000_000)
    || value.status !== 'active' || !workspacePositive(value.version)
    || !workspacePositive(value.staffVersion)) return null
  return Object.freeze({
    id: value.id,
    displayName: value.displayName,
    standardRateGrosze: value.standardRateGrosze,
    status: 'active',
    version: value.version,
    staffVersion: value.staffVersion,
  })
}

const captureWorkspaceAssignment = (raw) => {
  const value = captureDataObject(raw, ['id', 'specialistId', 'startsAt', 'version'])
  if (!value || typeof value.id !== 'string' || !ASSIGNMENT_ID.test(value.id)
    || typeof value.specialistId !== 'string' || !SPECIALIST_ID.test(value.specialistId)
    || !validInstant(value.startsAt) || !workspacePositive(value.version)) return null
  return Object.freeze({
    id: value.id,
    specialistId: value.specialistId,
    startsAt: value.startsAt,
    version: value.version,
  })
}

const captureWorkspaceClient = (raw) => {
  const value = captureDataObject(raw, [
    'id', 'name', 'age', 'status', 'version', 'archivedAt', 'createdAt', 'updatedAt',
    'readOnly', 'assignment',
  ])
  if (!value || typeof value.id !== 'string' || !CLIENT_ID.test(value.id)
    || !workspaceIdentity(value.name, value.age)
    || !['active', 'paused', 'archived'].includes(value.status)
    || !workspacePositive(value.version) || !workspaceNullableInstant(value.archivedAt)
    || !validInstant(value.createdAt) || !validInstant(value.updatedAt)
    || value.createdAt > value.updatedAt
    || (value.status === 'archived') !== (value.archivedAt !== null)
    || value.readOnly !== (value.status === 'archived')) return null
  const assignment = value.assignment === null ? null : captureWorkspaceAssignment(value.assignment)
  if ((value.assignment !== null && !assignment)
    || (value.status === 'archived' && assignment !== null)
    || (value.archivedAt !== null
      && (value.archivedAt < value.createdAt || value.archivedAt > value.updatedAt))
    || (assignment !== null
      && (assignment.startsAt < value.createdAt || assignment.startsAt > value.updatedAt))) return null
  return Object.freeze({
    id: value.id,
    name: value.name,
    age: value.age,
    status: value.status,
    version: value.version,
    archivedAt: value.archivedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    readOnly: value.readOnly,
    assignment,
  })
}

const CLIENT_INPUT_KEYS = Object.freeze(['name', 'age', 'status', 'specialistId'])
const CLIENT_STATUSES = new Set(['active', 'paused'])

const captureClientInput = (raw) => {
  const value = captureDataObject(raw, CLIENT_INPUT_KEYS)
  if (!value || !workspaceIdentity(value.name, value.age)
    || !CLIENT_STATUSES.has(value.status)
    || typeof value.specialistId !== 'string' || !SPECIALIST_ID.test(value.specialistId)) {
    return null
  }
  return Object.freeze({
    name: value.name,
    age: value.age,
    status: value.status,
    specialistId: value.specialistId,
  })
}

const captureClientOptions = (raw) => {
  const empty = captureDataObject(raw, [])
  if (empty) return Object.freeze({ idempotencyKey: undefined })
  const value = captureDataObject(raw, ['idempotencyKey'])
  return value && acceptedKey(value.idempotencyKey)
    ? Object.freeze({ idempotencyKey: value.idempotencyKey })
    : null
}

const captureClientEnvelope = (payload) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, ['client'])
  return data ? captureWorkspaceClient(data.client) : null
}

const acceptedCreatedClient = (payload, status, requested) => {
  const client = status === 201 ? captureClientEnvelope(payload) : null
  if (!client || client.name !== requested.name || client.age !== requested.age
    || client.status !== requested.status || client.version !== 1
    || client.archivedAt !== null || client.readOnly !== false
    || client.updatedAt !== client.createdAt || client.assignment === null
    || client.assignment.specialistId !== requested.specialistId
    || client.assignment.startsAt !== client.createdAt
    || client.assignment.version !== 1) return null
  return client
}

const acceptedEditedClient = (payload, status, clientId, expectedVersion, requested) => {
  const client = status === 200 ? captureClientEnvelope(payload) : null
  if (!client || client.id !== clientId || client.name !== requested.name
    || client.age !== requested.age || client.status !== requested.status
    || client.version !== expectedVersion + 1 || client.archivedAt !== null
    || client.readOnly !== false || client.assignment === null
    || client.assignment.specialistId !== requested.specialistId
    || client.assignment.version !== 1) return null
  return client
}

const acceptedArchivedClient = (payload, status, clientId, expectedVersion) => {
  const client = status === 200 ? captureClientEnvelope(payload) : null
  if (!client || client.id !== clientId || client.version !== expectedVersion + 1
    || client.status !== 'archived' || client.archivedAt === null
    || client.updatedAt !== client.archivedAt || client.createdAt >= client.archivedAt
    || client.readOnly !== true || client.assignment !== null) return null
  return client
}

const captureWorkspacePaymentEntry = (raw) => {
  const value = captureDataObject(raw, [
    'id', 'amountGrosze', 'method', 'receivedAt', 'correctedAt', 'replacementEntryId',
  ])
  if (!value || typeof value.id !== 'string' || !PAYMENT_ID.test(value.id)
    || !workspacePositive(value.amountGrosze, 1_000_000)
    || !['cash', 'card', 'transfer', 'monthly'].includes(value.method)
    || !validInstant(value.receivedAt) || !workspaceNullableInstant(value.correctedAt)
    || (value.replacementEntryId !== null
      && (typeof value.replacementEntryId !== 'string'
        || !PAYMENT_ID.test(value.replacementEntryId)))
    || (value.correctedAt === null && value.replacementEntryId !== null)) return null
  return Object.freeze({
    id: value.id,
    amountGrosze: value.amountGrosze,
    method: value.method,
    receivedAt: value.receivedAt,
    correctedAt: value.correctedAt,
    replacementEntryId: value.replacementEntryId,
  })
}

const captureWorkspaceAppointment = (raw, bounds) => {
  const value = captureDataObject(raw, [
    'id', 'clientId', 'specialistId', 'serviceId', 'startsAt', 'endsAt', 'timeZone',
    'location', 'status', 'source', 'version', 'cancelledAt', 'createdAt', 'updatedAt',
    'charge', 'payment', 'paymentEntries',
  ])
  if (!value || typeof value.id !== 'string' || !APPOINTMENT_ID.test(value.id)
    || typeof value.clientId !== 'string' || !CLIENT_ID.test(value.clientId)
    || typeof value.specialistId !== 'string' || !SPECIALIST_ID.test(value.specialistId)
    || typeof value.serviceId !== 'string' || !WORKSPACE_SERVICE_IDS.has(value.serviceId)
    || !validInstant(value.startsAt) || !validInstant(value.endsAt)
    || value.startsAt < bounds.lower || value.startsAt >= bounds.upper
    || value.endsAt <= value.startsAt || value.timeZone !== 'Europe/Warsaw'
    || !workspaceLocation(value.location)
    || !['scheduled', 'completed', 'cancelled', 'noshow'].includes(value.status)
    || value.source !== 'panel' || !workspacePositive(value.version)
    || !workspaceNullableInstant(value.cancelledAt)
    || (value.status === 'cancelled') !== (value.cancelledAt !== null)
    || !validInstant(value.createdAt) || !validInstant(value.updatedAt)
    || value.createdAt > value.updatedAt
    || (value.cancelledAt !== null
      && (value.cancelledAt < value.createdAt || value.cancelledAt > value.updatedAt))) return null

  const charge = captureDataObject(value.charge, [
    'id', 'serviceId', 'expectedAmountGrosze', 'currency', 'version',
  ])
  if (!charge || typeof charge.id !== 'string' || !CHARGE_ID.test(charge.id)
    || charge.serviceId !== value.serviceId
    || !workspacePositive(charge.expectedAmountGrosze, 1_000_000)
    || charge.currency !== 'PLN' || !workspacePositive(charge.version)) return null

  const payment = captureDataObject(value.payment, [
    'status', 'collectedGrosze', 'outstandingGrosze', 'latestMethod', 'latestReceivedAt',
  ])
  const rawEntries = captureDenseArray(value.paymentEntries, 1_000)
  if (!payment || !rawEntries) return null
  const entries = rawEntries.map(captureWorkspacePaymentEntry)
  if (entries.some((entry) => !entry)) return null
  const ids = new Set()
  let previous = null
  for (const entry of entries) {
    if (ids.has(entry.id)
      || (previous && (previous.receivedAt > entry.receivedAt
        || (previous.receivedAt === entry.receivedAt
          && previous.id.localeCompare(entry.id) >= 0)))) return null
    ids.add(entry.id)
    previous = entry
    if (entry.correctedAt !== null
      && (entry.correctedAt < value.createdAt || entry.correctedAt > value.updatedAt)) return null
  }
  const replacementTargets = new Set()
  const replacementLinks = new Map()
  for (const entry of entries) {
    if (entry.replacementEntryId === null) continue
    if (entry.replacementEntryId === entry.id || !ids.has(entry.replacementEntryId)
      || replacementTargets.has(entry.replacementEntryId)) return null
    replacementTargets.add(entry.replacementEntryId)
    replacementLinks.set(entry.id, entry.replacementEntryId)
  }
  for (const start of replacementLinks.keys()) {
    const path = new Set()
    let current = start
    while (replacementLinks.has(current)) {
      if (path.has(current)) return null
      path.add(current)
      current = replacementLinks.get(current)
    }
  }
  let collected = 0
  const effective = []
  for (const entry of entries) {
    if (entry.correctedAt !== null) continue
    collected += entry.amountGrosze
    if (!Number.isSafeInteger(collected)) return null
    effective.push(entry)
  }
  const billable = value.status === 'completed' || value.status === 'noshow'
  const expectedStatus = collected === 0 ? 'unpaid'
    : collected === charge.expectedAmountGrosze ? 'paid' : 'partial'
  const latest = effective.at(-1) ?? null
  if (collected > charge.expectedAmountGrosze || (!billable && collected !== 0)
    || payment.status !== expectedStatus || payment.collectedGrosze !== collected
    || payment.outstandingGrosze !== (billable ? charge.expectedAmountGrosze - collected : 0)
    || payment.latestMethod !== (latest?.method ?? null)
    || payment.latestReceivedAt !== (latest?.receivedAt ?? null)) return null

  return Object.freeze({
    id: value.id,
    clientId: value.clientId,
    specialistId: value.specialistId,
    serviceId: value.serviceId,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    timeZone: 'Europe/Warsaw',
    location: value.location,
    status: value.status,
    source: 'panel',
    version: value.version,
    cancelledAt: value.cancelledAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    charge: Object.freeze({
      id: charge.id,
      serviceId: charge.serviceId,
      expectedAmountGrosze: charge.expectedAmountGrosze,
      currency: 'PLN',
      version: charge.version,
    }),
    payment: Object.freeze({
      status: payment.status,
      collectedGrosze: payment.collectedGrosze,
      outstandingGrosze: payment.outstandingGrosze,
      latestMethod: payment.latestMethod,
      latestReceivedAt: payment.latestReceivedAt,
    }),
    paymentEntries: Object.freeze(entries),
  })
}

const acceptedWorkspace = (payload, requested) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, [
    'window', 'specialists', 'clients', 'appointments',
  ])
  const window = data && captureDataObject(data.window, ['from', 'to', 'timeZone', 'complete'])
  const specialists = data && captureDenseArray(data.specialists, 50)
  const clients = data && captureDenseArray(data.clients, 200)
  const appointments = data && captureDenseArray(data.appointments, 500)
  const bounds = workspaceBounds(requested)
  if (!window || !specialists || !clients || !appointments || !bounds
    || window.from !== requested.from || window.to !== requested.to
    || window.timeZone !== 'Europe/Warsaw' || window.complete !== true) return null
  const acceptedSpecialists = specialists.map(captureWorkspaceSpecialist)
  const acceptedClients = clients.map(captureWorkspaceClient)
  const acceptedAppointments = appointments.map((value) => (
    captureWorkspaceAppointment(value, bounds)
  ))
  if (acceptedSpecialists.some((value) => !value)
    || acceptedClients.some((value) => !value)
    || acceptedAppointments.some((value) => !value)) return null
  const specialistIds = new Set()
  let previousSpecialist = null
  for (const specialist of acceptedSpecialists) {
    if (specialistIds.has(specialist.id)
      || (previousSpecialist && (workspaceCollator.compare(
        previousSpecialist.displayName, specialist.displayName,
      ) > 0 || (workspaceCollator.compare(
        previousSpecialist.displayName, specialist.displayName,
      ) === 0 && previousSpecialist.id.localeCompare(specialist.id) >= 0)))) return null
    specialistIds.add(specialist.id)
    previousSpecialist = specialist
  }
  const clientIds = new Set()
  let previousClient = null
  for (const client of acceptedClients) {
    if (clientIds.has(client.id)
      || (previousClient && (workspaceCollator.compare(previousClient.name, client.name) > 0
        || (workspaceCollator.compare(previousClient.name, client.name) === 0
          && previousClient.id.localeCompare(client.id) >= 0)))
      || (client.assignment !== null && !specialistIds.has(client.assignment.specialistId))) return null
    clientIds.add(client.id)
    previousClient = client
  }
  const appointmentIds = new Set()
  const chargeIds = new Set()
  const paymentIds = new Set()
  let paymentEntryCount = 0
  let previousAppointment = null
  const referencedClients = new Set()
  for (const appointment of acceptedAppointments) {
    if (appointmentIds.has(appointment.id) || chargeIds.has(appointment.charge.id)
      || !clientIds.has(appointment.clientId)
      || (previousAppointment && (previousAppointment.startsAt > appointment.startsAt
        || (previousAppointment.startsAt === appointment.startsAt
          && previousAppointment.id.localeCompare(appointment.id) >= 0)))) return null
    appointmentIds.add(appointment.id)
    chargeIds.add(appointment.charge.id)
    referencedClients.add(appointment.clientId)
    previousAppointment = appointment
    paymentEntryCount += appointment.paymentEntries.length
    if (paymentEntryCount > 1_000) return null
    for (const entry of appointment.paymentEntries) {
      if (paymentIds.has(entry.id)) return null
      paymentIds.add(entry.id)
    }
  }
  if (acceptedClients.some((client) => (
    (client.status === 'archived' || client.assignment === null)
      && !referencedClients.has(client.id)
  ))) return null
  return Object.freeze({
    window: Object.freeze({ ...window }),
    specialists: Object.freeze(acceptedSpecialists),
    clients: Object.freeze(acceptedClients),
    appointments: Object.freeze(acceptedAppointments),
  })
}
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const canonicalBase64Url = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)
    || value.length % 4 === 1) return false
  const remainder = value.length % 4
  if (remainder === 0) return true
  const tail = BASE64URL_ALPHABET.indexOf(value.at(-1))
  return remainder === 2 ? (tail & 15) === 0 : (tail & 3) === 0
}
const validCursor = (value) => {
  if (typeof value !== 'string' || value.length > 1024) return false
  const match = AUDIT_CURSOR.exec(value)
  if (!match || !canonicalBase64Url(match[2]) || !canonicalBase64Url(match[3])) return false
  const version = Number(match[1])
  return positive(version) && String(version) === match[1]
}
const safeCode = (code) => Object.hasOwn(SERVER_STATUS, code) || CLIENT_CODES.has(code)
  ? code
  : 'INTERNAL_ERROR'

const safeDetails = (code, details) => {
  try {
    if (!plainObject(details)) return undefined
    const value = (key) => Object.hasOwn(details, key) ? Reflect.get(details, key) : undefined
    if (code === 'VALIDATION_FAILED') {
      const field = value('field')
      return VALIDATION_FIELDS.has(field) ? { field } : undefined
    }
    if (code === 'VERSION_CONFLICT') {
      const currentVersion = value('currentVersion')
      return positive(currentVersion) ? { currentVersion } : undefined
    }
    if (code === 'WORKSPACE_RESULT_LIMIT') {
      const field = value('field')
      const limit = value('limit')
      return WORKSPACE_FIELDS.has(field) && Number.isSafeInteger(limit) && limit >= 0
        ? { field, limit }
        : undefined
    }
    if (code === 'RATE_LIMITED') {
      const retryAfterSeconds = value('retryAfterSeconds')
      return Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 0
        ? { retryAfterSeconds }
        : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

export class ApiError extends Error {
  constructor(code, {
    status = 0,
    details,
    correlationId,
    idempotencyKey,
  } = {}) {
    const acceptedCode = safeCode(code)
    super(acceptedCode)
    this.name = 'ApiError'
    this.code = acceptedCode
    this.status = Number.isSafeInteger(status) && status >= 0 && status <= 599 ? status : 0
    const acceptedDetails = safeDetails(acceptedCode, details)
    if (acceptedDetails) this.details = acceptedDetails
    if (UUID.test(correlationId ?? '')) this.correlationId = correlationId
    if (IDEMPOTENCY_KEY.test(idempotencyKey ?? '')) this.idempotencyKey = idempotencyKey
  }
}

const clientError = (code, options) => new ApiError(code, options)

const acceptedActor = (value) => {
  const actor = captureExactObject(value, [
    'id', 'displayName', 'role', 'specialistId', 'version',
  ])
  if (!actor || !STAFF_ID.test(actor.id) || !validText(actor.displayName, 120)
    || !ROLES.has(actor.role) || !positive(actor.version)
    || (actor.specialistId !== null && !SPECIALIST_ID.test(actor.specialistId))
    || (actor.role === 'specialist' && !SPECIALIST_ID.test(actor.specialistId))) {
    return null
  }
  return Object.freeze({
    id: actor.id,
    displayName: actor.displayName,
    role: actor.role,
    specialistId: actor.specialistId,
    version: actor.version,
  })
}

const acceptedSession = (payload) => {
  try {
    const envelope = captureExactObject(payload, ['data'])
    const value = captureExactObject(envelope?.data, [
      'actor', 'capabilities', 'csrfToken', 'csrfExpiresAt', 'environment', 'dataMode',
    ])
    const actor = acceptedActor(value?.actor)
    const capabilities = captureArray(value?.capabilities, CAPABILITIES.length)
    const expectedCapabilities = actor ? ROLE_CAPABILITIES[actor.role] : null
    if (!actor || !capabilities || capabilities.length !== expectedCapabilities.length
      || capabilities.some((capability) => (
        typeof capability !== 'string' || !CAPABILITY_VOCABULARY.has(capability)
      ))
      || new Set(capabilities).size !== capabilities.length
      || capabilities.some((capability, index) => capability !== expectedCapabilities[index])
      || !ENVIRONMENTS.has(value.environment) || value.dataMode !== 'fictional'
      || !validIso(value.csrfExpiresAt)) return null
    const match = typeof value.csrfToken === 'string' ? CSRF_TOKEN.exec(value.csrfToken) : null
    const expiresUnix = Number(match?.[1])
    if (!match || !Number.isSafeInteger(expiresUnix)
      || Date.parse(value.csrfExpiresAt) / 1000 !== expiresUnix) return null
    const session = Object.freeze({
      actor,
      capabilities: Object.freeze(capabilities),
      csrfExpiresAt: value.csrfExpiresAt,
      environment: value.environment,
      dataMode: value.dataMode,
    })
    return Object.freeze({ csrfToken: value.csrfToken, session })
  } catch {
    return null
  }
}

const acceptedInvitation = (value) => {
  if (!plainObject(value) || !validId(value.id) || !INVITATION_STATUSES.has(value.status)
    || !validIso(value.expiresAt)
    || (value.emailSentAt !== null && !validIso(value.emailSentAt))
    || !Number.isSafeInteger(value.version) || value.version < 1) {
    return null
  }
  return Object.freeze({
    id: value.id,
    status: value.status,
    expiresAt: value.expiresAt,
    emailSentAt: value.emailSentAt,
    version: value.version,
  })
}

const acceptedStaff = (value, withInvitation) => {
  if (!plainObject(value) || !validId(value.id) || !validText(value.displayName, 120)
    || !validText(value.email, 320) || !ROLES.has(value.role)
    || !STAFF_STATUSES.has(value.status)
    || !Number.isSafeInteger(value.version) || value.version < 1
    || (value.specialistId !== null && !validId(value.specialistId))
    || (value.role === 'specialist' && !validId(value.specialistId))) {
    return null
  }
  const invitation = withInvitation && value.invitation !== null
    ? acceptedInvitation(value.invitation)
    : null
  if (withInvitation && value.invitation !== null && !invitation) return null
  return Object.freeze({
    id: value.id,
    displayName: value.displayName,
    email: value.email,
    role: value.role,
    status: value.status,
    version: value.version,
    specialistId: value.specialistId,
    ...(withInvitation ? { invitation } : {}),
  })
}

const acceptedStaffList = (payload) => {
  const values = plainObject(payload) && plainObject(payload.data)
    ? payload.data.staff
    : null
  if (!Array.isArray(values)) return null
  const staff = values.map((value) => acceptedStaff(value, true))
  if (staff.some((value) => value === null)) return null
  return Object.freeze({ staff: Object.freeze(staff) })
}

const acceptedInvitationResult = (payload) => {
  const value = plainObject(payload) && plainObject(payload.data) ? payload.data : null
  const staff = acceptedStaff(value?.staff, false)
  const invitation = acceptedInvitation(value?.invitation)
  return staff && invitation ? Object.freeze({ staff, invitation }) : null
}

const acceptedDeactivationResult = (payload) => {
  const value = plainObject(payload) && plainObject(payload.data) ? payload.data : null
  const staff = acceptedStaff(value?.staff, false)
  return staff ? Object.freeze({ staff }) : null
}

const acceptedHealth = (payload) => {
  const outer = captureExactObject(payload, ['data'])
  const data = outer && captureExactObject(outer.data, ['generatedAt', 'checks'])
  const values = data && captureArray(data.checks, HEALTH_CHECKS.length)
  if (!data || !validInstant(data.generatedAt)
    || !values || values.length !== HEALTH_CHECKS.length) return null
  const checks = []
  for (let index = 0; index < HEALTH_CHECKS.length; index += 1) {
    const value = captureExactObject(values[index], [
      'id', 'label', 'status', 'lastSuccessAt', 'detailCode',
    ])
    const expected = HEALTH_CHECKS[index]
    if (!value || value.id !== expected.id || value.label !== expected.label
      || !expected.pairs.has(`${value.status}:${value.detailCode}`)
      || (value.lastSuccessAt !== null
        && (!validInstant(value.lastSuccessAt)
          || value.lastSuccessAt > data.generatedAt))) return null
    checks.push(Object.freeze({
      id: value.id,
      label: value.label,
      status: value.status,
      lastSuccessAt: value.lastSuccessAt,
      detailCode: value.detailCode,
    }))
  }
  return Object.freeze({
    generatedAt: data.generatedAt,
    checks: Object.freeze(checks),
  })
}

const acceptedActionDetails = (action) => {
  let keys
  if (action.kind === 'access_reconciliation_lag') {
    keys = ['appliedGeneration', 'desiredGeneration', 'errorCode']
  } else if (action.kind === 'authorization_denial_spike') {
    keys = action.entityType === 'centre'
      ? ['errorCode', 'minimumCount', 'threshold', 'windowMinutes']
      : ['actorId', 'capability', 'count', 'errorCode', 'threshold']
  } else if (action.kind === 'backup_failed') {
    keys = ['backupId', 'errorCode']
  } else if (action.kind === 'backup_stale') {
    keys = ['errorCode', 'thresholdHours']
  } else if (action.kind === 'outbox_job_failed') {
    keys = ['errorCode', 'jobId', 'outboxType']
  } else if (action.kind === 'scheduler_stale') {
    keys = ['errorCode', 'schedulerRunId', 'thresholdMinutes']
  } else return null
  const details = captureExactObject(action.details, keys)
  if (!details) return null
  if (action.kind === 'access_reconciliation_lag') {
    if (action.severity !== 'critical' || action.entityType !== 'access_group'
      || action.entityId !== 'centre_1'
      || !safeCount(details.appliedGeneration) || !safeCount(details.desiredGeneration)
      || details.appliedGeneration >= details.desiredGeneration
      || details.errorCode !== 'ACCESS_RECONCILIATION_LAG') return null
  } else if (action.kind === 'authorization_denial_spike') {
    if (action.entityType === 'centre') {
      if (action.severity !== 'critical' || action.entityId !== 'centre_1'
        || details.errorCode !== 'AUTHORIZATION_DENIAL_OVERFLOW'
        || details.minimumCount !== 101 || details.threshold !== 100
        || details.windowMinutes !== 15) return null
    } else if (action.severity !== 'warning' || action.entityType !== 'staff_user'
      || !validId(action.entityId)
      || details.actorId !== action.entityId || !DENIAL_CAPABILITIES.has(details.capability)
      || !safeCount(details.count) || details.count < 10
      || details.errorCode !== 'AUTHORIZATION_DENIAL_SPIKE' || details.threshold !== 10) return null
  } else if (action.kind === 'backup_failed') {
    if (action.severity !== 'critical' || action.entityType !== 'backup_run'
      || !BACKUP_ID.test(action.entityId)
      || details.backupId !== action.entityId || details.errorCode !== 'BACKUP_FAILED') return null
  } else if (action.kind === 'backup_stale') {
    if (action.severity !== 'critical' || action.entityType !== 'centre'
      || action.entityId !== 'centre_1'
      || details.errorCode !== 'BACKUP_STALE' || details.thresholdHours !== 36) return null
  } else if (action.kind === 'outbox_job_failed') {
    if (action.severity !== 'critical' || action.entityType !== 'outbox_job'
      || !validId(action.entityId)
      || details.jobId !== action.entityId) return null
    const known = ORDINARY_OUTBOX_TYPES.has(details.outboxType)
      && OUTBOX_FAILURE_CODES.has(details.errorCode)
    const unknown = !ORDINARY_OUTBOX_TYPES.has(details.outboxType)
      && details.outboxType !== 'backup.create'
      && OUTBOX_TYPE.test(details.outboxType ?? '')
      && details.errorCode === 'OUTBOX_TYPE_INVALID'
    if (!known && !unknown) return null
  } else if (action.kind === 'scheduler_stale') {
    if (action.severity !== 'critical' || action.entityType !== 'scheduler_run'
      || !validId(action.entityId)
      || details.errorCode !== 'SCHEDULER_STALE'
      || details.schedulerRunId !== action.entityId || details.thresholdMinutes !== 15) return null
  } else return null
  return Object.freeze({ ...details })
}

const acceptedActions = (payload) => {
  const outer = captureExactObject(payload, ['data'])
  const data = outer && captureExactObject(outer.data, ['actions', 'truncated'])
  const values = data && captureArray(data.actions, 100)
  if (!data || !values || typeof data.truncated !== 'boolean'
    || (data.truncated && values.length < 100)) return null
  const actions = []
  const ids = new Set()
  let previous = null
  for (const raw of values) {
    const value = captureExactObject(raw, [
      'id', 'kind', 'severity', 'entityType', 'entityId', 'details', 'version',
      'createdAt', 'updatedAt',
    ])
    if (!value || !validId(value.id) || !validId(value.entityId) || value.version !== 1
      || !validInstant(value.createdAt) || value.updatedAt !== value.createdAt
      || ids.has(value.id)
      || (previous && (previous.createdAt < value.createdAt
        || (previous.createdAt === value.createdAt && previous.id <= value.id)))) return null
    const details = acceptedActionDetails(value)
    if (!details) return null
    ids.add(value.id)
    previous = value
    actions.push(Object.freeze({
      id: value.id,
      kind: value.kind,
      severity: value.severity,
      entityType: value.entityType,
      entityId: value.entityId,
      details,
      version: value.version,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }))
  }
  return Object.freeze({
    actions: Object.freeze(actions),
    truncated: data.truncated,
  })
}

const acceptedResolution = (payload, actionId, version) => {
  const outer = captureExactObject(payload, ['data'])
  const data = outer && captureExactObject(outer.data, ['action'])
  const value = data && captureExactObject(data.action, [
    'id', 'status', 'version', 'resolvedAt', 'updatedAt',
  ])
  if (!value || value.id !== actionId || value.status !== 'resolved'
    || value.version !== version + 1 || !validInstant(value.resolvedAt)
    || value.updatedAt !== value.resolvedAt) return null
  return Object.freeze({
    action: Object.freeze({
      id: value.id,
      status: value.status,
      version: value.version,
      resolvedAt: value.resolvedAt,
      updatedAt: value.updatedAt,
    }),
  })
}

const acceptedAuditMetadata = (action, value, schema) => {
  if (isCoreAuditAction(action)) return captureCoreAuditMetadata(action, value)
  const schemaKeys = Object.keys(schema.metadata)
  const legacyKeys = Object.keys(schema.legacyMetadata ?? {})
  let types = schema.metadata
  let metadata = captureExactObject(value, schemaKeys)
  let legacy = false
  if (!metadata && schema.legacyMetadata) {
    metadata = captureExactObject(value, legacyKeys)
    types = schema.legacyMetadata
    legacy = metadata !== null
  }
  if (!metadata) return null
  for (const key of Object.keys(types)) {
    const accepted = types[key] === 'count'
      ? safeCount(metadata[key])
      : types[key] === 'nullableVersion'
        ? metadata[key] === null || positive(metadata[key])
        : types[key] === 'assignmentId'
          ? typeof metadata[key] === 'string' && ASSIGNMENT_ID.test(metadata[key])
          : types[key] === 'paymentId'
            ? typeof metadata[key] === 'string' && PAYMENT_ID.test(metadata[key])
            : types[key] === 'correctionId'
              ? typeof metadata[key] === 'string' && CORRECTION_ID.test(metadata[key])
              : types[key] === 'nullablePaymentId'
                ? metadata[key] === null
                  || (typeof metadata[key] === 'string' && PAYMENT_ID.test(metadata[key]))
                : positive(metadata[key])
    if (!accepted) return null
  }
  return Object.freeze(legacy ? { ...metadata, specialistVersion: null } : metadata)
}

const acceptedAudit = (payload, limit) => {
  const outer = captureExactObject(payload, ['data'])
  const data = outer && captureExactObject(outer.data, ['events', 'nextCursor'])
  const values = data && captureArray(data.events, limit)
  if (!data || !values
    || (data.nextCursor !== null && !validCursor(data.nextCursor))
    || (values.length < limit && data.nextCursor !== null)) return null
  const events = []
  const ids = new Set()
  let previous = null
  for (const raw of values) {
    const value = captureExactObject(raw, [
      'id', 'occurredAt', 'actorStaffId', 'action', 'entityType', 'entityId',
      'result', 'correlationId', 'metadata',
    ])
    if (!value) return null
    const schema = AUDIT_SCHEMAS[value.action]
    if (!validId(value.id) || !validInstant(value.occurredAt)
      || (value.actorStaffId !== null && !validId(value.actorStaffId))
      || !schema || !schema.entityTypes.includes(value.entityType)
      || !validId(value.entityId) || value.result !== schema.result
      || !validId(value.correlationId) || ids.has(value.id)
      || (previous && (previous.occurredAt < value.occurredAt
        || (previous.occurredAt === value.occurredAt && previous.id <= value.id)))) return null
    if (schema.system && value.actorStaffId !== null) return null
    if (schema.entityId && !schema.entityId.test(value.entityId)) return null
    if (value.action === 'backup.pruned' && !BACKUP_ID.test(value.entityId)) return null
    if (value.action === 'specialist.backfilled' && !SPECIALIST_ID.test(value.entityId)) return null
    if (value.action === 'core_directory.upgrade.advanced'
      && value.entityId !== 'core_directory_specialist_backfill_v1') return null
    const metadata = acceptedAuditMetadata(value.action, value.metadata, schema)
    if (!metadata) return null
    if (isCoreAuditAction(value.action) && !browserCoreAuditEvent({
      action: value.action,
      actorStaffId: value.actorStaffId,
      entityType: value.entityType,
      entityId: value.entityId,
      result: value.result,
      metadata,
    })) return null
    ids.add(value.id)
    previous = value
    events.push(Object.freeze({
      id: value.id,
      occurredAt: value.occurredAt,
      actorStaffId: value.actorStaffId,
      action: value.action,
      entityType: value.entityType,
      entityId: value.entityId,
      result: value.result,
      correlationId: value.correlationId,
      metadata,
    }))
  }
  return Object.freeze({
    events: Object.freeze(events),
    nextCursor: data.nextCursor,
  })
}

export const BROWSER_CORE_AUDIT_SCHEMAS = CORE_AUDIT_SCHEMAS
export const browserCoreAuditEvent = captureCoreAuditEvent

const acceptedInviteInput = (input) => plainObject(input)
  && Object.keys(input).length === 3
  && Object.hasOwn(input, 'displayName')
  && Object.hasOwn(input, 'email')
  && Object.hasOwn(input, 'role')
  && validText(input.displayName, 120)
  && validText(input.email, 320)
  && ROLES.has(input.role)

const acceptedKey = (value) => typeof value === 'string' && IDEMPOTENCY_KEY.test(value)

const idempotencyOptions = (options) => {
  try {
    if (!plainObject(options)) return null
    return { idempotencyKey: options.idempotencyKey }
  } catch {
    return null
  }
}

const serverError = (payload, status, idempotencyKey) => {
  if (!plainObject(payload) || !Object.hasOwn(payload, 'error')) {
    return clientError('INVALID_RESPONSE', { status, idempotencyKey })
  }
  const value = payload.error
  if (!plainObject(value) || !Object.hasOwn(value, 'code')) {
    return clientError('INVALID_RESPONSE', { status, idempotencyKey })
  }
  const captured = { code: value.code }
  for (const key of ['details', 'correlationId']) {
    if (Object.hasOwn(value, key)) captured[key] = value[key]
  }
  if (!Object.hasOwn(SERVER_STATUS, captured.code)
    || SERVER_STATUS[captured.code] !== status) {
    return clientError('INVALID_RESPONSE', { status, idempotencyKey })
  }
  return new ApiError(captured.code, {
    status,
    details: captured.details,
    correlationId: captured.correlationId,
    idempotencyKey: status >= 500 ? idempotencyKey : undefined,
  })
}

const responseStatus = (response) => {
  const status = response?.status
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? status
    : 0
}

const defaultFetch = (...args) => globalThis.fetch(...args)
const defaultIdempotencyKey = () => globalThis.crypto?.randomUUID?.()

const makeApiClient = ({ fetchImpl, idempotencyKeyFactory, localIdentity }) => {
  if (typeof fetchImpl !== 'function' || typeof idempotencyKeyFactory !== 'function') {
    throw clientError('CLIENT_INPUT_INVALID')
  }

  let csrfToken = null
  let sessionRequest = null
  let sessionGeneration = 0
  const listeners = new Set()
  const baseHeaders = () => ({
    Accept: 'application/json',
    ...(localIdentity ? { 'X-BWM-Local-Identity': localIdentity } : {}),
  })
  const notifySession = (session) => {
    for (const listener of [...listeners]) {
      try {
        const result = listener(session)
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {})
        }
      } catch {
        // A consumer cannot change authentication or request classification.
      }
    }
  }
  const clearSession = () => {
    sessionGeneration += 1
    sessionRequest = null
    csrfToken = null
    notifySession(null)
  }
  const requestJson = async (path, init, {
    validate,
    idempotencyKey,
    onAuthDenial = clearSession,
  } = {}) => {
    let response
    try {
      response = await fetchImpl(path, init)
    } catch {
      throw clientError('NETWORK_ERROR', {
        idempotencyKey,
      })
    }
    let status
    let ok
    let parseJson
    try {
      status = responseStatus(response)
      ok = response?.ok
      parseJson = response?.json
    } catch {
      throw clientError('INVALID_RESPONSE', { idempotencyKey })
    }
    if (!status || typeof ok !== 'boolean' || typeof parseJson !== 'function') {
      throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    }
    let payload
    try {
      payload = await parseJson.call(response)
    } catch {
      throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    }
    if (!ok) {
      let error
      try {
        error = serverError(payload, status, idempotencyKey)
      } catch {
        throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
      }
      if (AUTH_DENIAL_CODES.has(error.code)) onAuthDenial()
      throw error
    }
    let result
    try {
      result = validate(payload, status)
    } catch {
      throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    }
    if (!result) throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    return result
  }
  const getSession = () => {
    if (sessionRequest) return sessionRequest
    const generation = sessionGeneration
    const request = requestJson(`${API_ROOT}/session`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: baseHeaders(),
    }, {
      validate: acceptedSession,
      onAuthDenial: () => {
        if (sessionGeneration === generation) clearSession()
      },
    }).then((accepted) => {
      if (sessionGeneration === generation) {
        csrfToken = accepted.csrfToken
        notifySession(accepted.session)
      }
      return accepted.session
    })
    sessionRequest = request
    const clearRequest = () => {
      if (sessionRequest === request) sessionRequest = null
    }
    void request.then(clearRequest, clearRequest)
    return request
  }
  const listStaff = () => requestJson(`${API_ROOT}/staff`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: baseHeaders(),
  }, {
    validate: acceptedStaffList,
  })
  const loadWorkspaceWindow = (options) => {
    const accepted = acceptedWorkspaceOptions(options)
    if (!accepted) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    return requestJson(
      `${API_ROOT}/workspace?from=${accepted.from}&to=${accepted.to}`,
      {
        method: 'GET',
        credentials: 'same-origin',
        headers: baseHeaders(),
      },
      { validate: (payload) => acceptedWorkspace(payload, accepted) },
    )
  }
  const getOperationsHealth = () => requestJson(`${API_ROOT}/operations/health`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: baseHeaders(),
  }, {
    validate: acceptedHealth,
  })
  const getOperationalActions = () => requestJson(`${API_ROOT}/operations/actions`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: baseHeaders(),
  }, {
    validate: acceptedActions,
  })
  const getSecurityAudit = (options = {}) => {
    let cursor
    let limit
    try {
      if (!plainObject(options)) throw new Error('invalid')
      const keys = Reflect.ownKeys(options)
      if (keys.some((key) => key !== 'cursor' && key !== 'limit')
        || keys.length > 2) throw new Error('invalid')
      cursor = keys.includes('cursor') ? options.cursor : undefined
      limit = keys.includes('limit') ? options.limit : undefined
      if ((cursor !== undefined && !validCursor(cursor))
        || (limit !== undefined
          && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))) {
        throw new Error('invalid')
      }
    } catch {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    const query = new URLSearchParams()
    if (cursor !== undefined) query.append('cursor', cursor)
    if (limit !== undefined) query.append('limit', String(limit))
    const suffix = query.size > 0 ? `?${query}` : ''
    const requestedLimit = limit ?? 50
    return requestJson(`${API_ROOT}/security/audit${suffix}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: baseHeaders(),
    }, {
      validate: (payload) => acceptedAudit(payload, requestedLimit),
    })
  }
  const createIdempotencyKey = () => {
    let value
    try {
      value = idempotencyKeyFactory()
    } catch {
      throw clientError('CLIENT_INPUT_INVALID')
    }
    if (!acceptedKey(value)) throw clientError('CLIENT_INPUT_INVALID')
    return value
  }
  const mutation = async (path, body, validate, suppliedKey) => {
    const idempotencyKey = suppliedKey === undefined
      ? createIdempotencyKey()
      : suppliedKey
    if (!acceptedKey(idempotencyKey)) throw clientError('CLIENT_INPUT_INVALID')
    if (!csrfToken) throw clientError('SESSION_REQUIRED')
    const send = () => requestJson(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        ...baseHeaders(),
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'Idempotency-Key': idempotencyKey,
      },
      body,
    }, {
      validate,
      idempotencyKey,
    })
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'CSRF_EXPIRED') throw error
    }
    await getSession()
    return send()
  }
  const createClient = (input, options = {}) => {
    const requested = captureClientInput(input)
    const acceptedOptions = captureClientOptions(options)
    if (!requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    const body = JSON.stringify({
      name: requested.name,
      age: requested.age,
      status: requested.status,
      specialistId: requested.specialistId,
    })
    return mutation(
      `${API_ROOT}/clients`,
      body,
      (payload, status) => acceptedCreatedClient(payload, status, requested),
      acceptedOptions.idempotencyKey,
    )
  }
  const editClient = (clientId, expectedVersion, input, options = {}) => {
    const requested = captureClientInput(input)
    const acceptedOptions = captureClientOptions(options)
    if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)
      || !positive(expectedVersion) || expectedVersion >= Number.MAX_SAFE_INTEGER
      || !requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    const body = JSON.stringify({
      expectedVersion,
      name: requested.name,
      age: requested.age,
      status: requested.status,
      specialistId: requested.specialistId,
    })
    return mutation(
      `${API_ROOT}/clients/${clientId}/edits`,
      body,
      (payload, status) => acceptedEditedClient(
        payload, status, clientId, expectedVersion, requested,
      ),
      acceptedOptions.idempotencyKey,
    )
  }
  const archiveClient = (clientId, expectedVersion, options = {}) => {
    const acceptedOptions = captureClientOptions(options)
    if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)
      || !positive(expectedVersion) || expectedVersion >= Number.MAX_SAFE_INTEGER
      || !acceptedOptions) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/clients/${clientId}/archive`,
      JSON.stringify({ expectedVersion }),
      (payload, status) => acceptedArchivedClient(payload, status, clientId, expectedVersion),
      acceptedOptions.idempotencyKey,
    )
  }
  const inviteStaff = (input, options = {}) => {
    const acceptedOptions = idempotencyOptions(options)
    if (!acceptedOptions) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    const { idempotencyKey } = acceptedOptions
    if (idempotencyKey !== undefined && !acceptedKey(idempotencyKey)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    let body
    try {
      if (!acceptedInviteInput(input)) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
      body = JSON.stringify(input)
    } catch {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    return mutation(
      `${API_ROOT}/staff/invitations`,
      body,
      acceptedInvitationResult,
      idempotencyKey,
    )
  }
  const deactivateStaff = (staffId, version, options = {}) => {
    const acceptedOptions = idempotencyOptions(options)
    if (!acceptedOptions) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    const { idempotencyKey } = acceptedOptions
    if (idempotencyKey !== undefined && !acceptedKey(idempotencyKey)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    if (typeof staffId !== 'string' || !STAFF_ID.test(staffId)
      || !Number.isSafeInteger(version) || version < 1) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    return mutation(
      `${API_ROOT}/staff/${staffId}/deactivation`,
      JSON.stringify({ version }),
      acceptedDeactivationResult,
      idempotencyKey,
    )
  }
  const resolveOperationalAction = (actionId, version, options) => {
    let idempotencyKey
    try {
      const acceptedOptions = captureExactObject(options, ['idempotencyKey'])
      if (typeof actionId !== 'string' || !ID.test(actionId)
        || !positive(version) || version >= Number.MAX_SAFE_INTEGER
        || !acceptedOptions) throw new Error('invalid')
      idempotencyKey = acceptedOptions.idempotencyKey
      if (!acceptedKey(idempotencyKey)) throw new Error('invalid')
    } catch {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    return mutation(
      `${API_ROOT}/operations/actions/${actionId}/resolution`,
      JSON.stringify({ version }),
      (payload) => acceptedResolution(payload, actionId, version),
      idempotencyKey,
    )
  }
  const subscribeSession = (listener) => {
    if (typeof listener !== 'function') throw clientError('CLIENT_INPUT_INVALID')
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return Object.freeze({
    getSession,
    listStaff,
    loadWorkspaceWindow,
    getOperationsHealth,
    getOperationalActions,
    getSecurityAudit,
    createClient,
    editClient,
    archiveClient,
    inviteStaff,
    deactivateStaff,
    resolveOperationalAction,
    createIdempotencyKey,
    clearSession,
    subscribeSession,
  })
}

export function createApiClient(options = {}) {
  let fetchImpl
  let idempotencyKeyFactory
  try {
    if (!plainObject(options)) throw clientError('CLIENT_INPUT_INVALID')
    fetchImpl = options.fetchImpl === undefined ? defaultFetch : options.fetchImpl
    idempotencyKeyFactory = options.idempotencyKeyFactory === undefined
      ? defaultIdempotencyKey
      : options.idempotencyKeyFactory
  } catch {
    throw clientError('CLIENT_INPUT_INVALID')
  }
  return makeApiClient({
    fetchImpl,
    idempotencyKeyFactory,
    localIdentity: null,
  })
}

const viteLocalIdentity = import.meta.env?.DEV === true
  && APP_MODE === 'app'
  && typeof import.meta.env?.VITE_BWM_LOCAL_IDENTITY === 'string'
  && import.meta.env.VITE_BWM_LOCAL_IDENTITY.trim()
  ? import.meta.env.VITE_BWM_LOCAL_IDENTITY.trim()
  : null

export const apiClient = makeApiClient({
  fetchImpl: defaultFetch,
  idempotencyKeyFactory: defaultIdempotencyKey,
  localIdentity: viteLocalIdentity,
})
