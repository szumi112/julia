import { APP_MODE } from './app-mode.js'
import {
  CAPABILITIES,
  acceptEffectiveCapabilities,
  effectiveCapabilitiesFor,
  isCapability,
  normalizeCapabilityOverrides,
} from './capabilities.js'
import { isWellFormedUnicode, validateAppointmentInput } from './core-records.js'
import { SERVICE_BY_ID } from './services.js'
import {
  financeEntryDto,
  financeMonthSummary,
  validateFinanceEntryInput,
  validateFinanceImport,
} from './finance-records.js'
import {
  captureCoreAuditEvent,
  captureCoreAuditMetadata,
  CORE_AUDIT_SCHEMAS,
  isCoreAuditAction,
} from './core-audit-contract.js'
import {
  captureHistoricalClient,
  captureHistoricalOccurrence,
  captureHistoricalPeriod,
  compareHistoricalClients,
  compareHistoricalOccurrences,
} from './historical-records.js'
import {
  captureActivityAttendance,
  captureActivityClass,
  captureActivityGroup,
  captureActivityGroupLeader,
  captureActivityMembership,
  captureActivityMonthWindow,
  captureActivityParticipant,
  captureActivityProjectionJob,
  captureActivityWorkspace,
  captureCreateActivityClassCommand,
  captureCreateActivityGroupCommand,
  captureCreateActivityMembershipCommand,
  captureCreateActivityParticipantCommand,
  captureEditActivityClassCommand,
  captureEditActivityGroupCommand,
  captureEditActivityMembershipCommand,
  captureEditActivityParticipantCommand,
  captureSetActivityAttendanceCommand,
  isActivityClassId,
  isActivityGroupId,
  isActivityMembershipId,
  isActivityParticipantId,
} from './activity-records.js'

const API_ROOT = '/api/v1'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CSRF_TOKEN = /^v1\.([1-9]\d*)\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const SPECIALIST_LINK_ID = /^spl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const HISTORICAL_CLIENT_ID = /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ASSIGNMENT_ID = /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CHARGE_ID = /^chg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CORRECTION_ID = /^cor_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const FINANCE_BATCH_ID = /^fib_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const FINANCE_FINGERPRINT = /^[0-9a-f]{64}$/
const FINANCE_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const WORKBOOK_IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const WORKBOOK_ARTIFACT_ID = /^wba_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const WORKBOOK_JOB_ID = /^wbj_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const WORKBOOK_PREVIEW_TOKEN = /^v1\.[1-9]\d*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/
const WORKBOOK_VERSIONED_DIGEST = /^v[1-9]\d*_[A-Za-z0-9_-]{43}$/
const WORKBOOK_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024
const MAX_WORKBOOK_EXPORT_BYTES = 10 * 1024 * 1024
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
  INVALID_MULTIPART: 400,
  VALIDATION_FAILED: 400,
  WORKBOOK_FINGERPRINT_REJECTED: 400,
  WORKBOOK_IMPORT_INVALID: 400,
  WORKBOOK_PANEL_SIGNATURE_INVALID: 400,
  WORKBOOK_PREVIEW_INVALID: 400,
  WORKBOOK_PREVIEW_TOKEN_INVALID: 400,
  WORKBOOK_SCOPE_MISMATCH: 400,
  ACCESS_ASSERTION_INVALID: 401,
  REAUTH_REQUIRED: 401,
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
  ACTIVITY_RESULT_LIMIT: 409,
  ACTIVITY_CONFLICT: 409,
  CLIENT_STATUS_CONFLICT: 409,
  CLIENT_ASSIGNMENT_CONFLICT: 409,
  CLIENT_ARCHIVE_CONFLICT: 409,
  APPOINTMENT_OVERLAP: 409,
  APPOINTMENT_PAYMENT_CONFLICT: 409,
  PAYMENT_AMOUNT_CONFLICT: 409,
  PAYMENT_CORRECTION_CONFLICT: 409,
  WORKBOOK_IMPORT_CONFLICT: 409,
  WORKBOOK_EXPORT_CONFLICT: 409,
  WORKBOOK_EXPORT_LIMIT: 409,
  WORKBOOK_RECONCILIATION_CONFLICT: 409,
  FINANCE_IMPORT_CLOSED: 409,
  FINANCE_IMPORT_DUPLICATE: 409,
  FINANCE_IMPORT_INCOMPLETE: 409,
  FINANCE_IMPORT_OVERFLOW: 409,
  STAFF_INVITATION_CONFLICT: 409,
  SPECIALIST_LINK_CONFLICT: 409,
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
  'SESSION_AUTHORITY_STALE',
  'SESSION_REQUIRED',
])
const AUTH_DENIAL_CODES = new Set(['ACCESS_ASSERTION_INVALID', 'ACCESS_DENIED', 'REAUTH_REQUIRED'])
const VALIDATION_FIELDS = new Set([
  'body', 'displayName', 'email', 'role', 'version', 'name', 'age', 'status',
  'specialistId', 'clientId', 'serviceId', 'dateTime', 'durationMinutes',
  'expectedAmountGrosze', 'location', 'amountGrosze', 'method', 'receivedAt',
  'paidDate', 'reason', 'replacement', 'expectedVersion', 'from', 'to',
  'specialists', 'clients', 'appointments', 'paymentEntries', 'historicalClients',
  'historicalOccurrences',
  'filename', 'fingerprint', 'formatVersion', 'totalRows', 'batchId', 'sequence',
  'entries', 'accountingMonth', 'kind',
  'standardRateGrosze', 'professionalTitle', 'staffId',
  'expectedSpecialistVersion', 'expectedStaffVersion',
  'programId', 'label', 'details', 'leaderSpecialistIds', 'historicalClientId',
  'participantId', 'groupId', 'membershipId', 'classId', 'startsOn', 'endsOn',
  'date', 'time', 'topic', 'importId',
])
const WORKSPACE_FIELDS = new Set([
  'specialists', 'clients', 'appointments', 'paymentEntries', 'historicalClients',
  'historicalOccurrences',
])
const ACTIVITY_FIELDS = new Set([
  'programs', 'groups', 'groupLeaders', 'participants', 'memberships', 'classes',
  'attendance', 'charges', 'payments',
])
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
const binaryCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0
const validClientIdentityText = (value) => typeof value === 'string'
  && isWellFormedUnicode(value) && value.length > 0
  && value === value.trim() && value === value.normalize('NFC')
  && new TextEncoder().encode(value).byteLength <= 120
const workspaceIdentity = (name, age) => validClientIdentityText(name)
  && (age === null || (Number.isSafeInteger(age) && age >= 1 && age <= 26))

const captureWorkspaceSpecialist = (raw) => {
  const legacyKeys = [
    'id', 'displayName', 'professionalTitle', 'standardRateGrosze', 'status',
    'version', 'staffVersion',
  ]
  const value = captureDataObject(raw, legacyKeys)
    ?? captureDataObject(raw, [...legacyKeys, 'accessStatus'])
  if (!value || typeof value.id !== 'string' || !SPECIALIST_ID.test(value.id)
    || !validWorkspaceText(value.displayName, 120)
    || !validWorkspaceText(value.professionalTitle, 120)
    || !workspacePositive(value.standardRateGrosze, 1_000_000)
    || !['active', 'archived'].includes(value.status) || !workspacePositive(value.version)
    || !(value.staffVersion === null || workspacePositive(value.staffVersion))
    || (Object.hasOwn(value, 'accessStatus')
      && (value.status !== 'active'
        || !['unclaimed', 'invited', 'enabled'].includes(value.accessStatus)))) return null
  return Object.freeze(Object.hasOwn(value, 'accessStatus') ? {
    id: value.id,
    displayName: value.displayName,
    professionalTitle: value.professionalTitle,
    standardRateGrosze: value.standardRateGrosze,
    status: value.status,
    version: value.version,
    staffVersion: value.staffVersion,
    accessStatus: value.accessStatus,
  } : {
    id: value.id,
    displayName: value.displayName,
    professionalTitle: value.professionalTitle,
    standardRateGrosze: value.standardRateGrosze,
    status: value.status,
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
  if (raw === undefined) return Object.freeze({ idempotencyKey: undefined })
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

const captureSpecialistProfileInput = (raw) => {
  const value = captureDataObject(raw, [
    'displayName', 'professionalTitle', 'standardRateGrosze',
  ])
  if (!value || !validWorkspaceText(value.displayName, 120)
    || !validWorkspaceText(value.professionalTitle, 120)
    || !workspacePositive(value.standardRateGrosze, 1_000_000)) return null
  return Object.freeze(value)
}

const acceptedSpecialistProfile = (payload, status, requested) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, ['specialist'])
  const value = data && captureDataObject(data.specialist, [
    'id', 'displayName', 'professionalTitle', 'standardRateGrosze', 'status',
    'version', 'accessStatus', 'createdAt', 'updatedAt',
  ])
  if (status !== 201 || !value || !SPECIALIST_ID.test(value.id ?? '')
    || value.displayName !== requested.displayName
    || value.professionalTitle !== requested.professionalTitle
    || value.standardRateGrosze !== requested.standardRateGrosze
    || value.status !== 'active' || value.version !== 1
    || value.accessStatus !== 'unclaimed' || !validInstant(value.createdAt)
    || value.updatedAt !== value.createdAt) return null
  return Object.freeze(value)
}

const acceptedEditedSpecialistProfile = (
  payload, status, specialistId, expectedVersion, requested,
) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, ['specialist'])
  const value = data && captureDataObject(data.specialist, [
    'id', 'displayName', 'professionalTitle', 'standardRateGrosze', 'status',
    'version', 'staffVersion', 'accessStatus', 'createdAt', 'updatedAt',
  ])
  if (status !== 200 || !value || value.id !== specialistId
    || value.displayName !== requested.displayName
    || value.professionalTitle !== requested.professionalTitle
    || value.standardRateGrosze !== requested.standardRateGrosze
    || value.status !== 'active' || value.version !== expectedVersion + 1
    || !(value.staffVersion === null || positive(value.staffVersion))
    || !['unclaimed', 'invited', 'enabled'].includes(value.accessStatus)
    || !validInstant(value.createdAt) || !validInstant(value.updatedAt)
    || value.updatedAt < value.createdAt) return null
  return Object.freeze(value)
}

const captureSpecialistAccountLinkInput = (raw) => {
  const value = captureDataObject(raw, [
    'staffId', 'expectedSpecialistVersion', 'expectedStaffVersion',
  ])
  if (!value || !STAFF_ID.test(value.staffId ?? '')
    || !positive(value.expectedSpecialistVersion)
    || value.expectedSpecialistVersion >= Number.MAX_SAFE_INTEGER
    || !positive(value.expectedStaffVersion)
    || value.expectedStaffVersion >= Number.MAX_SAFE_INTEGER) return null
  return Object.freeze(value)
}

const acceptedSpecialistAccountLink = (
  payload, status, specialistId, requested,
) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, ['link'])
  const value = data && captureDataObject(data.link, [
    'id', 'specialistId', 'staffId', 'lifecycle', 'specialistVersion',
    'staffVersion', 'createdAt',
  ])
  if (status !== 201 || !value || !SPECIALIST_LINK_ID.test(value.id ?? '')
    || value.specialistId !== specialistId || value.staffId !== requested.staffId
    || value.lifecycle !== 'activated'
    || value.specialistVersion !== requested.expectedSpecialistVersion + 1
    || value.staffVersion !== requested.expectedStaffVersion + 1
    || !validInstant(value.createdAt)) return null
  return Object.freeze({ ...value })
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

const captureWorkspaceAppointment = (raw, bounds = null) => {
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
    || (bounds !== null && (value.startsAt < bounds.lower || value.startsAt >= bounds.upper))
    || value.endsAt <= value.startsAt || value.timeZone !== 'Europe/Warsaw'
    || !workspaceLocation(value.location)
    || !['scheduled', 'completed', 'cancelled', 'noshow'].includes(value.status)
    || value.source !== 'panel' || !workspacePositive(value.version, 4_096)
    || !workspaceNullableInstant(value.cancelledAt)
    || (value.status === 'cancelled') !== (value.cancelledAt !== null)
    || !validInstant(value.createdAt) || !validInstant(value.updatedAt)
    || value.createdAt > value.updatedAt
    || new Date(value.endsAt).getTime() - new Date(value.startsAt).getTime()
      !== SERVICE_BY_ID[value.serviceId].duration * 60_000
    || (value.cancelledAt !== null
      && (value.cancelledAt < value.createdAt || value.cancelledAt > value.updatedAt))) return null

  const charge = captureDataObject(value.charge, [
    'id', 'serviceId', 'expectedAmountGrosze', 'currency', 'version',
  ])
  if (!charge || typeof charge.id !== 'string' || !CHARGE_ID.test(charge.id)
    || charge.serviceId !== value.serviceId
    || !workspacePositive(charge.expectedAmountGrosze, 1_000_000)
    || charge.currency !== 'PLN' || !workspacePositive(charge.version, 257)
    || charge.version > value.version) return null

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
          && binaryCompare(previous.id, entry.id) >= 0)))) return null
    ids.add(entry.id)
    previous = entry
    if (entry.correctedAt !== null
      && (entry.correctedAt < value.createdAt || entry.correctedAt > value.updatedAt)) return null
  }
  const replacementTargets = new Set()
  const replacementLinks = new Map()
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]))
  for (const entry of entries) {
    if (entry.replacementEntryId === null) continue
    const replacement = entriesById.get(entry.replacementEntryId)
    if (!replacement || entry.replacementEntryId === entry.id
      || replacementTargets.has(entry.replacementEntryId)
      || (replacement.correctedAt !== null
        && replacement.correctedAt <= entry.correctedAt)) return null
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
  const initialPaymentCount = entries.length - replacementTargets.size
  const correctionCount = entries.reduce(
    (count, entry) => count + (entry.correctedAt === null ? 0 : 1), 0,
  )
  const minimumVersion = 1 + initialPaymentCount + correctionCount
  if (value.version < minimumVersion
    || (value.version === 1 && (charge.version !== 1 || entries.length !== 0
      || value.cancelledAt !== null || value.createdAt !== value.updatedAt))
    || (value.version > 1 && value.updatedAt <= value.createdAt)
    || (value.status === 'cancelled' && value.version < 2)) return null
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

const APPOINTMENT_INPUT_KEYS = Object.freeze([
  'clientId', 'specialistId', 'serviceId', 'date', 'time', 'durationMinutes',
  'expectedAmountGrosze', 'location', 'status',
])
const APPOINTMENT_EDIT_KEYS = Object.freeze(APPOINTMENT_INPUT_KEYS.slice(1))
const PAYMENT_INPUT_KEYS = Object.freeze(['amountGrosze', 'method', 'receivedAt'])
const CORRECTION_INPUT_KEYS = Object.freeze(['reason', 'replacement'])
const PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'monthly'])

const captureAppointmentInput = (raw, editing = false) => {
  const keys = editing ? APPOINTMENT_EDIT_KEYS : APPOINTMENT_INPUT_KEYS
  const value = captureDataObject(raw, keys)
  if (!value) return null
  const candidate = editing
    ? Object.freeze({ clientId: 'cl_command_validation', ...value })
    : Object.freeze({ ...value })
  try {
    validateAppointmentInput(candidate)
  } catch {
    return null
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])))
}

const capturePaymentInput = (raw) => {
  const value = captureDataObject(raw, PAYMENT_INPUT_KEYS)
  if (!value || !workspacePositive(value.amountGrosze, 1_000_000)
    || !PAYMENT_METHODS.has(value.method) || !validInstant(value.receivedAt)) return null
  return Object.freeze({
    amountGrosze: value.amountGrosze,
    method: value.method,
    receivedAt: value.receivedAt,
  })
}

const validCorrectionReason = (value) => typeof value === 'string'
  && isWellFormedUnicode(value) && value.length > 0 && value === value.trim()
  && value === value.normalize('NFC')
  && new TextEncoder().encode(value).byteLength <= 500

const captureCorrectionInput = (raw) => {
  const value = captureDataObject(raw, CORRECTION_INPUT_KEYS)
  if (!value || !validCorrectionReason(value.reason)) return null
  const replacement = value.replacement === null ? null : capturePaymentInput(value.replacement)
  if (value.replacement !== null && !replacement) return null
  return Object.freeze({ reason: value.reason, replacement })
}

const captureAppointmentEnvelope = (payload) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, ['appointment'])
  return data ? captureWorkspaceAppointment(data.appointment) : null
}

const acceptedCreatedAppointment = (payload, status, requested) => {
  const appointment = status === 201 ? captureAppointmentEnvelope(payload) : null
  let normalized
  try { normalized = validateAppointmentInput(requested) } catch { return null }
  if (!appointment || appointment.clientId !== requested.clientId
    || appointment.specialistId !== requested.specialistId
    || appointment.serviceId !== requested.serviceId
    || appointment.startsAt !== normalized.startsAt || appointment.endsAt !== normalized.endsAt
    || appointment.location !== requested.location || appointment.status !== requested.status
    || appointment.version !== 1 || appointment.cancelledAt !== null
    || appointment.createdAt !== appointment.updatedAt || appointment.charge.version !== 1
    || appointment.charge.serviceId !== requested.serviceId
    || appointment.charge.expectedAmountGrosze !== requested.expectedAmountGrosze
    || appointment.paymentEntries.length !== 0
    || appointment.payment.collectedGrosze !== 0
    || appointment.payment.latestMethod !== null
    || appointment.payment.latestReceivedAt !== null) return null
  return appointment
}

const acceptedEditedAppointment = (
  payload, status, appointmentId, expectedVersion, requested,
) => {
  const appointment = status === 200 ? captureAppointmentEnvelope(payload) : null
  let normalized
  try {
    normalized = validateAppointmentInput({ clientId: 'cl_command_validation', ...requested })
  } catch {
    return null
  }
  if (!appointment || appointment.id !== appointmentId
    || appointment.specialistId !== requested.specialistId
    || appointment.serviceId !== requested.serviceId
    || appointment.startsAt !== normalized.startsAt || appointment.endsAt !== normalized.endsAt
    || appointment.location !== requested.location || appointment.status !== requested.status
    || appointment.version !== expectedVersion + 1 || appointment.cancelledAt !== null
    || appointment.updatedAt <= appointment.createdAt
    || appointment.charge.serviceId !== requested.serviceId
    || appointment.charge.expectedAmountGrosze !== requested.expectedAmountGrosze) return null
  return appointment
}

const acceptedCancelledAppointment = (payload, status, appointmentId, expectedVersion) => {
  const appointment = status === 200 ? captureAppointmentEnvelope(payload) : null
  if (!appointment || appointment.id !== appointmentId
    || appointment.version !== expectedVersion + 1 || appointment.status !== 'cancelled'
    || appointment.cancelledAt === null || appointment.cancelledAt !== appointment.updatedAt
    || appointment.updatedAt <= appointment.createdAt
    || appointment.payment.collectedGrosze !== 0
    || appointment.payment.outstandingGrosze !== 0
    || appointment.payment.latestMethod !== null
    || appointment.payment.latestReceivedAt !== null) return null
  return appointment
}

const acceptedRecordedPayment = (
  payload, status, appointmentId, expectedVersion, requested,
) => {
  const appointment = status === 200 ? captureAppointmentEnvelope(payload) : null
  if (!appointment || appointment.id !== appointmentId
    || appointment.version !== expectedVersion + 1
    || appointment.updatedAt <= appointment.createdAt
    || !['completed', 'noshow'].includes(appointment.status)) return null
  const matches = appointment.paymentEntries.filter((entry) => entry.correctedAt === null
    && entry.amountGrosze === requested.amountGrosze && entry.method === requested.method
    && entry.receivedAt === requested.receivedAt)
  return matches.length === 1 ? appointment : null
}

const acceptedCorrectedPayment = (
  payload, status, paymentId, expectedVersion, requested,
) => {
  const appointment = status === 200 ? captureAppointmentEnvelope(payload) : null
  if (!appointment || appointment.version !== expectedVersion + 1
    || appointment.updatedAt <= appointment.createdAt) return null
  const target = appointment.paymentEntries.find((entry) => entry.id === paymentId)
  if (!target || target.correctedAt !== appointment.updatedAt) return null
  if (requested.replacement === null) {
    return target.replacementEntryId === null ? appointment : null
  }
  const replacement = appointment.paymentEntries.find(
    (entry) => entry.id === target.replacementEntryId,
  )
  return replacement && replacement.correctedAt === null
    && replacement.amountGrosze === requested.replacement.amountGrosze
    && replacement.method === requested.replacement.method
    && replacement.receivedAt === requested.replacement.receivedAt
    ? appointment : null
}

const captureWorkspaceHistoricalClient = (raw) => {
  try { return captureHistoricalClient(raw) } catch { return null }
}

const captureWorkspaceHistoricalOccurrence = (raw) => {
  try { return captureHistoricalOccurrence(raw) } catch { return null }
}

const validHistoricalOccurrenceWindow = (occurrence, requested) => {
  const { period } = occurrence
  if (period.precision === 'day') {
    return period.day >= requested.from && period.day <= requested.to
  }
  if (period.precision === 'month') {
    return period.month >= requested.from.slice(0, 7)
      && period.month <= requested.to.slice(0, 7)
  }
  return true
}

const acceptedHistoricalActivation = (
  payload, status, historicalClientId, expectedVersion, specialistId,
) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, ['historicalClient', 'client'])
  const historicalClient = data
    ? captureWorkspaceHistoricalClient(data.historicalClient) : null
  const client = data ? captureWorkspaceClient(data.client) : null
  if (status !== 201 || !historicalClient || !client
    || historicalClient.id !== historicalClientId
    || historicalClient.status !== 'activated'
    || historicalClient.version !== expectedVersion + 1
    || historicalClient.activeClientId !== client.id
    || historicalClient.name !== client.name
    || historicalClient.updatedAt !== client.createdAt
    || client.age !== null || client.status !== 'active' || client.version !== 1
    || client.archivedAt !== null || client.readOnly !== false
    || client.createdAt !== client.updatedAt || client.assignment === null
    || client.assignment.specialistId !== specialistId
    || client.assignment.startsAt !== client.createdAt
    || client.assignment.version !== 1) return null
  return Object.freeze({ historicalClient, client })
}

const acceptedWorkspace = (payload, requested) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, [
    'window', 'specialists', 'clients', 'appointments', 'historicalClients',
    'historicalOccurrences', 'latestPopulatedMonth',
  ])
  const window = data && captureDataObject(data.window, ['from', 'to', 'timeZone', 'complete'])
  const specialists = data && captureDenseArray(data.specialists, 50)
  const clients = data && captureDenseArray(data.clients, 1_000)
  const appointments = data && captureDenseArray(data.appointments, 500)
  const historicalClients = data && captureDenseArray(data.historicalClients, 1_000)
  const historicalOccurrences = data && captureDenseArray(data.historicalOccurrences, 1_000)
  const bounds = workspaceBounds(requested)
  if (!window || !specialists || !clients || !appointments || !historicalClients
    || !historicalOccurrences || !bounds
    || window.from !== requested.from || window.to !== requested.to
    || window.timeZone !== 'Europe/Warsaw' || window.complete !== true) return null
  const acceptedSpecialists = specialists.map(captureWorkspaceSpecialist)
  const acceptedClients = clients.map(captureWorkspaceClient)
  const acceptedAppointments = appointments.map((value) => (
    captureWorkspaceAppointment(value, bounds)
  ))
  const acceptedHistoricalClients = historicalClients.map(captureWorkspaceHistoricalClient)
  const acceptedHistoricalOccurrences = historicalOccurrences
    .map(captureWorkspaceHistoricalOccurrence)
  if (acceptedSpecialists.some((value) => !value)
    || acceptedClients.some((value) => !value)
    || acceptedAppointments.some((value) => !value)
    || acceptedHistoricalClients.some((value) => !value)
    || acceptedHistoricalOccurrences.some((value) => !value)) return null
  const specialistIds = new Set()
  let previousSpecialist = null
  for (const specialist of acceptedSpecialists) {
    if (specialistIds.has(specialist.id)
      || (previousSpecialist && (workspaceCollator.compare(
        previousSpecialist.displayName, specialist.displayName,
      ) > 0 || (workspaceCollator.compare(
        previousSpecialist.displayName, specialist.displayName,
      ) === 0 && binaryCompare(previousSpecialist.id, specialist.id) >= 0)))) return null
    specialistIds.add(specialist.id)
    previousSpecialist = specialist
  }
  const clientIds = new Set()
  let previousClient = null
  for (const client of acceptedClients) {
    if (clientIds.has(client.id)
      || (previousClient && (workspaceCollator.compare(previousClient.name, client.name) > 0
        || (workspaceCollator.compare(previousClient.name, client.name) === 0
          && binaryCompare(previousClient.id, client.id) >= 0)))
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
          && binaryCompare(previousAppointment.id, appointment.id) >= 0)))) return null
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

  const historicalClientIds = new Set()
  let previousHistoricalClient = null
  for (const client of acceptedHistoricalClients) {
    if (historicalClientIds.has(client.id)
      || (previousHistoricalClient
        && compareHistoricalClients(previousHistoricalClient, client) >= 0)
      || (client.activeClientId !== null && !clientIds.has(client.activeClientId))) return null
    historicalClientIds.add(client.id)
    previousHistoricalClient = client
  }
  const historicalOccurrenceIds = new Set()
  const historicalSourceIds = new Set()
  const historicalCounterparties = new Map()
  const referencedHistoricalClients = new Set()
  const referencedHistoricalSpecialists = new Set()
  let previousHistoricalOccurrence = null
  let latestVisibleMonth = null
  for (const occurrence of acceptedHistoricalOccurrences) {
    if (historicalOccurrenceIds.has(occurrence.id)
      || historicalSourceIds.has(occurrence.sourceRecordId)
      || !specialistIds.has(occurrence.specialistId)
      || !validHistoricalOccurrenceWindow(occurrence, requested)
      || (previousHistoricalOccurrence
        && compareHistoricalOccurrences(previousHistoricalOccurrence, occurrence) >= 0)) return null
    referencedHistoricalSpecialists.add(occurrence.specialistId)
    if (occurrence.historicalClientId !== null) {
      if (!historicalClientIds.has(occurrence.historicalClientId)) return null
      referencedHistoricalClients.add(occurrence.historicalClientId)
    } else {
      const previousName = historicalCounterparties.get(occurrence.counterparty.id)
      if (previousName !== undefined && previousName !== occurrence.counterparty.name) return null
      historicalCounterparties.set(occurrence.counterparty.id, occurrence.counterparty.name)
    }
    if (occurrence.status === 'recorded' && occurrence.period.precision !== 'unknown') {
      const month = occurrence.period.month
      if (latestVisibleMonth === null || month > latestVisibleMonth) latestVisibleMonth = month
    }
    historicalOccurrenceIds.add(occurrence.id)
    historicalSourceIds.add(occurrence.sourceRecordId)
    previousHistoricalOccurrence = occurrence
  }
  if (acceptedSpecialists.some((specialist) => specialist.status === 'archived'
    && !referencedHistoricalSpecialists.has(specialist.id))) return null
  if (acceptedHistoricalClients.some(({ id }) => !referencedHistoricalClients.has(id))) return null
  let latestPopulatedMonth = data.latestPopulatedMonth
  if (latestPopulatedMonth !== null) {
    try {
      latestPopulatedMonth = captureHistoricalPeriod({
        precision: 'month', day: null, month: latestPopulatedMonth,
      }).month
    } catch { return null }
  }
  if ((latestVisibleMonth !== null && latestPopulatedMonth === null)
    || (latestVisibleMonth !== null && latestPopulatedMonth < latestVisibleMonth)) return null
  return Object.freeze({
    window: Object.freeze({ ...window }),
    specialists: Object.freeze(acceptedSpecialists),
    clients: Object.freeze(acceptedClients),
    appointments: Object.freeze(acceptedAppointments),
    historicalClients: Object.freeze(acceptedHistoricalClients),
    historicalOccurrences: Object.freeze(acceptedHistoricalOccurrences),
    latestPopulatedMonth,
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
    if (code === 'ACTIVITY_RESULT_LIMIT') {
      const field = value('field')
      const limit = value('limit')
      return ACTIVITY_FIELDS.has(field) && Number.isSafeInteger(limit) && limit >= 0
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
  const actor = captureDataObject(value, [
    'id', 'displayName', 'professionalTitle', 'role', 'specialistId', 'version',
  ])
  if (!actor || !STAFF_ID.test(actor.id) || !validText(actor.displayName, 120)
    || !(actor.professionalTitle === null
      || validWorkspaceText(actor.professionalTitle, 120))
    || !ROLES.has(actor.role) || !positive(actor.version)
    || (actor.specialistId !== null && !SPECIALIST_ID.test(actor.specialistId))
    || (actor.role === 'specialist' && !SPECIALIST_ID.test(actor.specialistId))
    || ((actor.professionalTitle === null) !== (actor.specialistId === null))) {
    return null
  }
  return Object.freeze({
    id: actor.id,
    displayName: actor.displayName,
    professionalTitle: actor.professionalTitle,
    role: actor.role,
    specialistId: actor.specialistId,
    version: actor.version,
  })
}

const acceptedSession = (payload) => {
  try {
    const envelope = captureDataObject(payload, ['data'])
    const value = captureDataObject(envelope?.data, [
      'actor', 'authorityRevision', 'capabilities', 'csrfToken', 'csrfExpiresAt',
      'environment', 'dataMode',
    ])
    const actor = acceptedActor(value?.actor)
    const capabilities = captureDenseArray(value?.capabilities, CAPABILITIES.length)
    const acceptedCapabilities = actor
      ? acceptEffectiveCapabilities(actor.role, capabilities)
      : null
    if (!actor || !positive(value.authorityRevision) || !acceptedCapabilities
      || !ENVIRONMENTS.has(value.environment) || value.dataMode !== 'fictional'
      || !validIso(value.csrfExpiresAt)) return null
    const match = typeof value.csrfToken === 'string' ? CSRF_TOKEN.exec(value.csrfToken) : null
    const expiresUnix = Number(match?.[1])
    if (!match || !Number.isSafeInteger(expiresUnix)
      || Date.parse(value.csrfExpiresAt) / 1000 !== expiresUnix) return null
    const session = Object.freeze({
      actor,
      authorityRevision: value.authorityRevision,
      capabilities: acceptedCapabilities,
      csrfExpiresAt: value.csrfExpiresAt,
      environment: value.environment,
      dataMode: value.dataMode,
    })
    return Object.freeze({ csrfToken: value.csrfToken, session })
  } catch {
    return null
  }
}

const sameOrderedValues = (left, right) => left.length === right.length
  && left.every((value, index) => value === right[index])

const acceptedCapabilityTarget = (raw) => {
  const value = captureDataObject(raw, [
    'staffId', 'displayName', 'role', 'status', 'authorityRevision',
  ])
  if (!value || !STAFF_ID.test(value.staffId ?? '') || !validText(value.displayName, 120)
    || !ROLES.has(value.role) || !STAFF_STATUSES.has(value.status)
    || !positive(value.authorityRevision)) return null
  return Object.freeze({
    staffId: value.staffId,
    displayName: value.displayName,
    role: value.role,
    status: value.status,
    authorityRevision: value.authorityRevision,
  })
}

const acceptedCapabilityTargets = (payload) => {
  try {
    const envelope = captureDataObject(payload, ['data'])
    const data = captureDataObject(envelope?.data, ['targets'])
    const rows = captureDenseArray(data?.targets, 1_000)
    if (!rows) return null
    const targets = rows.map(acceptedCapabilityTarget)
    if (targets.some((target) => !target)
      || new Set(targets.map((target) => target.staffId)).size !== targets.length
      || targets.some((target, index) => index > 0 && (
        workspaceCollator.compare(targets[index - 1].displayName, target.displayName) > 0
        || (workspaceCollator.compare(
          targets[index - 1].displayName, target.displayName,
        ) === 0 && targets[index - 1].staffId >= target.staffId)
      ))) return null
    return Object.freeze({ targets: Object.freeze(targets) })
  } catch {
    return null
  }
}

const acceptedCapabilityAuthorityValue = (raw) => {
  try {
    const value = captureDataObject(raw, [
      'staffId', 'displayName', 'role', 'status', 'authorityRevision',
      'allow', 'deny', 'effectiveCapabilities',
    ])
    const allow = captureDenseArray(value?.allow, CAPABILITIES.length)
    const deny = captureDenseArray(value?.deny, CAPABILITIES.length)
    const effective = captureDenseArray(value?.effectiveCapabilities, CAPABILITIES.length)
    if (!value || !STAFF_ID.test(value.staffId ?? '') || !validText(value.displayName, 120)
      || !ROLES.has(value.role) || !STAFF_STATUSES.has(value.status)
      || !positive(value.authorityRevision) || !allow || !deny || !effective) return null
    const normalized = normalizeCapabilityOverrides({ role: value.role, allow, deny })
    const calculated = effectiveCapabilitiesFor({
      role: value.role,
      allow: normalized.allow,
      deny: normalized.deny,
    })
    const acceptedEffective = acceptEffectiveCapabilities(value.role, effective)
    if (!acceptedEffective
      || !sameOrderedValues(allow, normalized.allow)
      || !sameOrderedValues(deny, normalized.deny)
      || !sameOrderedValues(acceptedEffective, calculated)) return null
    return Object.freeze({
      staffId: value.staffId,
      displayName: value.displayName,
      role: value.role,
      status: value.status,
      authorityRevision: value.authorityRevision,
      allow: normalized.allow,
      deny: normalized.deny,
      effectiveCapabilities: acceptedEffective,
    })
  } catch {
    return null
  }
}

const acceptedCapabilityAuthority = (payload) => {
  const envelope = captureDataObject(payload, ['data'])
  const data = captureDataObject(envelope?.data, ['authority'])
  const authority = acceptedCapabilityAuthorityValue(data?.authority)
  return authority ? Object.freeze({ authority }) : null
}

const captureCapabilityOverrideInput = (raw) => {
  try {
    const value = captureDataObject(raw, ['expectedAuthorityRevision', 'allow', 'deny'])
    const allow = captureDenseArray(value?.allow, CAPABILITIES.length * 4)
    const deny = captureDenseArray(value?.deny, CAPABILITIES.length * 4)
    if (!value || !positive(value.expectedAuthorityRevision) || !allow || !deny
      || allow.some((capability) => !isCapability(capability))
      || deny.some((capability) => !isCapability(capability))) return null
    const denied = new Set(deny)
    const allowed = new Set(allow.filter((capability) => !denied.has(capability)))
    return Object.freeze({
      expectedAuthorityRevision: value.expectedAuthorityRevision,
      allow: Object.freeze(CAPABILITIES.filter((capability) => allowed.has(capability))),
      deny: Object.freeze(CAPABILITIES.filter((capability) => denied.has(capability))),
    })
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

const acceptedRoleChangeResult = (
  payload,
  status,
  staffId,
  expectedVersion,
  role,
) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, ['staff'])
  const value = data && captureDataObject(data.staff, [
    'id', 'displayName', 'email', 'role', 'status', 'version', 'specialistId',
  ])
  if (status !== 200 || !value || value.id !== staffId
    || !validText(value.displayName, 120) || !validText(value.email, 320)
    || value.role !== role || !STAFF_STATUSES.has(value.status)
    || value.version !== expectedVersion + 1
    || !(value.specialistId === null || SPECIALIST_ID.test(value.specialistId))
    || (value.role === 'specialist' && !SPECIALIST_ID.test(value.specialistId ?? ''))) {
    return null
  }
  return Object.freeze({
    staff: Object.freeze({
      id: value.id,
      displayName: value.displayName,
      email: value.email,
      role: value.role,
      status: value.status,
      version: value.version,
      specialistId: value.specialistId,
    }),
  })
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

const FINANCE_ENTRY_INPUT_KEYS = Object.freeze([
  'kind', 'recordType', 'accountingMonth', 'occurredOn', 'amountGrosze',
  'paidAmountGrosze', 'paymentMethod', 'settlementStatus', 'invoiceStatus',
  'counterparty', 'sourceLabel', 'invoiceNote', 'specialistId', 'lessonCount', 'source',
])

const captureFinanceEntryInput = (raw) => {
  const captured = captureDataObject(raw, FINANCE_ENTRY_INPUT_KEYS)
  if (!captured) return null
  try { return validateFinanceEntryInput({ ...captured }) } catch { return null }
}

const captureFinanceBatch = (raw, includeFilename) => {
  const keys = [
    'id', 'fingerprint', ...(includeFilename ? ['filename'] : []), 'formatVersion',
    'totalRows', 'acceptedRows', 'status', 'version', 'createdAt', 'updatedAt',
    'committedAt',
  ]
  const value = captureDataObject(raw, keys)
  if (!value || typeof value.id !== 'string' || !FINANCE_BATCH_ID.test(value.id)
    || typeof value.fingerprint !== 'string' || !FINANCE_FINGERPRINT.test(value.fingerprint)
    || (includeFilename && !validText(value.filename, 255))
    || value.formatVersion !== 1 || !positive(value.totalRows) || value.totalRows > 10_000
    || !Number.isSafeInteger(value.acceptedRows) || value.acceptedRows < 0
    || value.acceptedRows > value.totalRows
    || !['importing', 'committed', 'failed'].includes(value.status)
    || !positive(value.version) || !validInstant(value.createdAt)
    || !validInstant(value.updatedAt) || value.updatedAt < value.createdAt
    || (value.committedAt !== null && !validInstant(value.committedAt))
    || (value.status === 'committed') !== (value.committedAt !== null)
    || (value.status === 'committed' && value.acceptedRows !== value.totalRows)) return null
  return Object.freeze({ ...value })
}

const acceptedFinanceBatch = (payload, status, includeFilename, expectedStatuses) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, ['batch'])
  const batch = data && captureFinanceBatch(data.batch, includeFilename)
  return batch && expectedStatuses.includes(status) ? batch : null
}

const acceptedFinanceList = (payload, month) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, ['entries', 'summary'])
  const values = data && captureArray(data.entries, 5_000)
  if (!values) return null
  let entries
  try { entries = values.map((value) => financeEntryDto(value)) } catch { return null }
  const expected = financeMonthSummary(entries, month)
  const summary = captureDataObject(data.summary, Object.keys(expected))
  if (!summary || Object.keys(expected).some((key) => summary[key] !== expected[key])) return null
  return Object.freeze({ entries: Object.freeze(entries), summary: expected })
}

const captureWorkbookFile = (raw) => {
  try {
    if (typeof File !== 'function' || !(raw instanceof File)
      || !Number.isSafeInteger(raw.size) || raw.size < 1 || raw.size > MAX_WORKBOOK_BYTES
      || typeof raw.name !== 'string' || raw.name.length < 6 || raw.name.length > 255
      || raw.name !== raw.name.trim() || raw.name !== raw.name.normalize('NFC')
      || !raw.name.toLowerCase().endsWith('.xlsx') || raw.name.includes('/')
      || raw.name.includes('\\') || INVALID_TEXT.test(raw.name)
      || !['', WORKBOOK_MIME].includes(raw.type)) return null
    return raw
  } catch {
    return null
  }
}

const captureWorkbookJson = (raw, state = { nodes: 0 }, depth = 0) => {
  state.nodes += 1
  if (state.nodes > 25_000 || depth > 8) return null
  if (raw === null || typeof raw === 'boolean') return raw
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && Math.abs(raw) <= Number.MAX_SAFE_INTEGER ? raw : null
  }
  if (typeof raw === 'string') {
    return raw.length <= 4_096 && isWellFormedUnicode(raw) && raw === raw.normalize('NFC')
      ? raw
      : null
  }
  if (Array.isArray(raw)) {
    const values = captureArray(raw, 5_000)
    if (!values) return null
    const captured = []
    for (const value of values) {
      const item = captureWorkbookJson(value, state, depth + 1)
      if (item === null && value !== null) return null
      captured.push(item)
    }
    return Object.freeze(captured)
  }
  if (!plainObject(raw)) return null
  const keys = Reflect.ownKeys(raw)
  if (keys.length > 64 || keys.some((key) => typeof key !== 'string'
    || key.length < 1 || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key))) {
    return null
  }
  const captured = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    const item = captureWorkbookJson(descriptor.value, state, depth + 1)
    if (item === null && descriptor.value !== null) return null
    captured[key] = item
  }
  return Object.freeze(captured)
}

const captureWorkbookImport = (raw) => {
  const value = captureDataObject(raw, [
    'id', 'artifactId', 'status', 'acceptedRecords', 'quarantinedRecords',
    'createdByStaffId', 'version', 'createdAt', 'updatedAt', 'completedAt',
  ])
  if (!value || typeof value.id !== 'string' || !WORKBOOK_IMPORT_ID.test(value.id)
    || typeof value.artifactId !== 'string' || !WORKBOOK_ARTIFACT_ID.test(value.artifactId)
    || !['uploading', 'ready', 'materializing', 'conflicts', 'complete', 'failed']
      .includes(value.status)
    || !safeCount(value.acceptedRecords) || value.acceptedRecords > 5_000
    || !safeCount(value.quarantinedRecords) || value.quarantinedRecords > 5_000
    || typeof value.createdByStaffId !== 'string' || !STAFF_ID.test(value.createdByStaffId)
    || !positive(value.version) || !validInstant(value.createdAt)
    || !validInstant(value.updatedAt) || value.updatedAt < value.createdAt
    || !(value.completedAt === null || validInstant(value.completedAt))
    || (value.status === 'complete') !== (value.completedAt !== null)) return null
  return Object.freeze({ ...value })
}

const captureWorkbookJob = (raw) => {
  const value = captureDataObject(raw, [
    'id', 'phase', 'status', 'cursor', 'totalRecords', 'processedRecords',
    'version', 'updatedAt', 'completedAt',
  ])
  if (!value || typeof value.id !== 'string' || !WORKBOOK_JOB_ID.test(value.id)
    || ![
      'index_finance', 'reconcile_sources', 'reconcile_unmatched', 'apply_finance', 'complete',
    ].includes(value.phase)
    || !['ready', 'running', 'complete', 'failed'].includes(value.status)
    || !safeCount(value.cursor) || value.cursor > 10_000
    || !safeCount(value.totalRecords) || value.totalRecords > 10_000
    || !safeCount(value.processedRecords) || value.processedRecords > value.totalRecords
    || value.cursor > value.totalRecords || !positive(value.version)
    || !validInstant(value.updatedAt)
    || !(value.completedAt === null || validInstant(value.completedAt))
    || (value.status === 'complete') !== (value.completedAt !== null)
    || (value.phase === 'complete') !== (value.status === 'complete')) return null
  return Object.freeze({ ...value })
}

const acceptedWorkbookImport = (payload, status) => {
  const outer = captureDataObject(payload, ['data'])
  const data = outer && captureDataObject(outer.data, ['import'])
  const value = data && captureWorkbookImport(data.import)
  return value && [200, 201].includes(status) ? value : null
}

const acceptedWorkbookStatus = (payload, status) => {
  const outer = captureDataObject(payload, ['data'])
  if (!outer || status !== 200 || !plainObject(outer.data)) return null
  const hasReconciliation = Object.hasOwn(outer.data, 'reconciliation')
  const data = captureDataObject(outer.data, [
    'import', 'job', ...(hasReconciliation ? ['reconciliation'] : []),
  ])
  const imported = data && captureWorkbookImport(data.import)
  const job = data && captureWorkbookJob(data.job)
  if (!imported || !job || (imported.status === 'complete') !== (job.status === 'complete')) {
    return null
  }
  const result = { import: imported, job }
  if (hasReconciliation) {
    const reconciliation = captureWorkbookJson(data.reconciliation)
    if (!reconciliation || Array.isArray(reconciliation)
      || Object.values(reconciliation).some((value) => !safeCount(value))) return null
    result.reconciliation = reconciliation
  }
  return Object.freeze(result)
}

const acceptedWorkbookPreview = (payload, status) => {
  const outer = captureDataObject(payload, ['data'])
  if (!outer || status !== 200 || !plainObject(outer.data)) return null
  const hasPanelChanges = Object.hasOwn(outer.data, 'panelChanges')
  const keys = [
    'fingerprint', 'parserVersion', 'materializerVersion', 'planDigest', 'previewToken',
    'counts', 'warnings', 'reconciliation', 'proposedMappings', 'conflicts', 'quarantine',
    'workbookKind', ...(hasPanelChanges ? ['panelChanges'] : []),
  ]
  const data = captureDataObject(outer.data, keys)
  if (!data || typeof data.fingerprint !== 'string' || !FINANCE_FINGERPRINT.test(data.fingerprint)
    || !positive(data.parserVersion) || !positive(data.materializerVersion)
    || typeof data.planDigest !== 'string' || !WORKBOOK_VERSIONED_DIGEST.test(data.planDigest)
    || typeof data.previewToken !== 'string' || data.previewToken.length > 4_096
    || !WORKBOOK_PREVIEW_TOKEN.test(data.previewToken)
    || !['legacy', 'panel-v2'].includes(data.workbookKind)) return null
  const counts = captureDataObject(data.counts, [
    'financeRows', 'datedFinanceRows', 'undatedFinanceRows', 'tusRows',
    'englishRows', 'costOrAncillaryRows',
  ])
  const reconciliation = captureDataObject(data.reconciliation, [
    'sourceCandidates', 'acceptedRows', 'quarantinedRows',
    'excludedFormulaBlocks', 'excludedFormulaRows',
  ])
  const warnings = captureArray(data.warnings, 100)
  const mappings = captureArray(data.proposedMappings, 100)
  const conflicts = captureWorkbookJson(data.conflicts)
  const quarantine = captureWorkbookJson(data.quarantine)
  if (!counts || Object.values(counts).some((value) => !safeCount(value) || value > 5_000)
    || !reconciliation
    || Object.values(reconciliation).some((value) => !safeCount(value) || value > 10_000)
    || !warnings || warnings.some((raw) => {
      const warning = captureDataObject(raw, ['code', 'count'])
      return !warning || !validText(warning.code, 128) || !positive(warning.count)
    })
    || !mappings || mappings.some((raw) => {
      const mapping = captureDataObject(raw, [
        'displayName', 'resolutionCode', 'sourceValue', 'sourceValueKind', 'specialistId',
      ])
      return !mapping || !validText(mapping.displayName, 120)
        || !validText(mapping.resolutionCode, 128)
        || typeof mapping.sourceValue !== 'string' || mapping.sourceValue.length > 120
        || !['blank', 'explicit_name'].includes(mapping.sourceValueKind)
        || typeof mapping.specialistId !== 'string' || !SPECIALIST_ID.test(mapping.specialistId)
    })
    || !Array.isArray(conflicts) || !Array.isArray(quarantine)) return null
  if (hasPanelChanges) {
    const panel = captureDataObject(data.panelChanges, ['unchangedIds', 'updates', 'voidIds'])
    if (!panel || !captureWorkbookJson(panel.unchangedIds)
      || !captureWorkbookJson(panel.updates) || !captureWorkbookJson(panel.voidIds)) return null
  }
  const captured = captureWorkbookJson(outer.data)
  return captured && !Array.isArray(captured) ? captured : null
}

const activityCapture = (capture, value) => {
  try { return capture(value) } catch { return null }
}

const acceptedActivityWorkspace = (payload, status, requested) => {
  const outer = captureDataObject(payload, ['data'])
  const workspace = outer && status === 200
    ? activityCapture(captureActivityWorkspace, outer.data)
    : null
  return workspace && workspace.from === requested.from && workspace.to === requested.to
    ? workspace
    : null
}

const activityEnvelope = (payload, status, expectedStatus, key, capture) => {
  const outer = status === expectedStatus ? captureDataObject(payload, ['data']) : null
  const data = outer && captureDataObject(outer.data, [key])
  return data ? activityCapture(capture, data[key]) : null
}

const activityLeaders = (raw, groupId, specialistIds) => {
  const values = captureDenseArray(raw, 2_000)
  if (!values) return null
  const leaders = []
  let previous = null
  for (const rawLeader of values) {
    const leader = activityCapture(captureActivityGroupLeader, rawLeader)
    if (!leader || leader.groupId !== groupId || leader.status !== 'active'
      || (previous !== null && leader.id <= previous)) return null
    previous = leader.id
    leaders.push(leader)
  }
  const returnedSpecialists = leaders.map(({ specialistId }) => specialistId).sort()
  if (returnedSpecialists.length !== specialistIds.length
    || returnedSpecialists.some((id, index) => id !== specialistIds[index])) return null
  return Object.freeze(leaders)
}

const acceptedActivityGroup = (payload, status, expectedStatus, requested, {
  id = null, expectedVersion = 0,
} = {}) => {
  const outer = status === expectedStatus ? captureDataObject(payload, ['data']) : null
  const data = outer && captureDataObject(outer.data, ['group', 'groupLeaders'])
  const group = data && activityCapture(captureActivityGroup, data.group)
  const expectedId = id === null ? group?.id : id
  const leaders = group && activityLeaders(
    data.groupLeaders, expectedId, requested.leaderSpecialistIds,
  )
  if (!group || !leaders || group.id !== expectedId
    || (id === null && (group.programId !== requested.programId || group.status !== 'active'))
    || group.label !== requested.label || group.details !== requested.details
    || (id !== null && group.status !== requested.status)
    || group.version !== expectedVersion + 1
    || (expectedVersion === 0 && group.updatedAt !== group.createdAt)) return null
  return Object.freeze({ group, groupLeaders: leaders })
}

const acceptedActivityParticipant = (payload, status, expectedStatus, requested, {
  id = null, expectedVersion = 0,
} = {}) => {
  const participant = activityEnvelope(
    payload, status, expectedStatus, 'participant', captureActivityParticipant,
  )
  if (!participant || (id !== null && participant.id !== id)
    || (id === null && (participant.programId !== requested.programId
      || participant.status !== 'active'))
    || participant.name !== requested.name || participant.clientId !== requested.clientId
    || participant.historicalClientId !== requested.historicalClientId
    || (id !== null && participant.status !== requested.status)
    || participant.version !== expectedVersion + 1
    || (expectedVersion === 0 && participant.updatedAt !== participant.createdAt)) return null
  return participant
}

const acceptedActivityMembership = (payload, status, expectedStatus, requested, {
  id = null, expectedVersion = 0,
} = {}) => {
  const membership = activityEnvelope(
    payload, status, expectedStatus, 'membership', captureActivityMembership,
  )
  if (!membership || (id !== null && membership.id !== id)
    || membership.membershipKind !== 'interval'
    || (id === null && (membership.participantId !== requested.participantId
      || membership.groupId !== requested.groupId || membership.status !== 'active'))
    || membership.startsOn !== requested.startsOn || membership.endsOn !== requested.endsOn
    || (id !== null && membership.status !== requested.status)
    || membership.version !== expectedVersion + 1
    || (expectedVersion === 0 && membership.updatedAt !== membership.createdAt)) return null
  return membership
}

const acceptedActivityClass = (payload, status, expectedStatus, requested, {
  id = null, expectedVersion = 0,
} = {}) => {
  const value = activityEnvelope(
    payload, status, expectedStatus, 'class', captureActivityClass,
  )
  if (!value || (id !== null && value.id !== id)
    || (id === null && value.groupId !== requested.groupId)
    || value.date !== requested.date || value.time !== requested.time
    || value.durationMinutes !== requested.durationMinutes || value.topic !== requested.topic
    || value.status !== requested.status || value.version !== expectedVersion + 1
    || (expectedVersion === 0 && value.updatedAt !== value.createdAt)) return null
  return value
}

const acceptedActivityAttendance = (
  payload, status, expectedStatus, classId, requested,
) => {
  const value = activityEnvelope(
    payload, status, expectedStatus, 'attendance', captureActivityAttendance,
  )
  if (!value || value.classId !== classId || value.participantId !== requested.participantId
    || value.status !== requested.status || value.version !== requested.expectedVersion + 1
    || (requested.expectedVersion === 0 && value.updatedAt !== value.createdAt)) return null
  return value
}

const NO_ACTIVITY_PROJECTION = Object.freeze({ kind: 'no-activity-projection' })

const acceptedActivityProjection = (payload, status, importId, expectedVersion = null) => {
  const expectedStatus = expectedVersion === 0 ? 201 : 200
  if (expectedVersion === null && status === 200) {
    const outer = captureDataObject(payload, ['data'])
    const data = outer && captureDataObject(outer.data, ['job'])
    if (data && data.job === null) return NO_ACTIVITY_PROJECTION
  }
  const job = activityEnvelope(
    payload, status, expectedStatus, 'job', captureActivityProjectionJob,
  )
  if (!job || job.importId !== importId
    || (expectedVersion !== null && job.version !== expectedVersion + 1)) return null
  return job
}

const idempotencyOptions = (options) => {
  try {
    if (!plainObject(options)) return null
    const keys = Reflect.ownKeys(options)
    if (keys.length === 0) return { idempotencyKey: undefined }
    if (keys.length !== 1 || keys[0] !== 'idempotencyKey') return null
    const descriptor = Object.getOwnPropertyDescriptor(options, 'idempotencyKey')
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    return { idempotencyKey: descriptor.value }
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
  let newestSessionRequest = null
  let sessionRequestSequence = 0
  let sessionGeneration = 0
  let requestAuthorityGeneration = 0
  let installedAuthority = null
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
    requestAuthorityGeneration += 1
    installedAuthority = null
    sessionRequest = null
    newestSessionRequest = null
    csrfToken = null
    notifySession(null)
  }
  const authorityFingerprintFor = (session) => JSON.stringify([
    session.actor.id,
    session.actor.version,
    session.actor.role,
    session.actor.specialistId,
    session.authorityRevision,
    session.capabilities,
  ])
  const assertCurrentRequestAuthority = (generation, idempotencyKey) => {
    if (generation !== null && generation !== requestAuthorityGeneration) {
      throw clientError('SESSION_AUTHORITY_STALE', { idempotencyKey })
    }
  }
  const requestJson = async (path, init, {
    validate,
    idempotencyKey,
    onAuthDenial = clearSession,
    authorityBound = true,
  } = {}) => {
    const authorityGeneration = authorityBound ? requestAuthorityGeneration : null
    let response
    try {
      response = await fetchImpl(path, init)
    } catch {
      assertCurrentRequestAuthority(authorityGeneration, idempotencyKey)
      throw clientError('NETWORK_ERROR', {
        idempotencyKey,
      })
    }
    assertCurrentRequestAuthority(authorityGeneration, idempotencyKey)
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
      assertCurrentRequestAuthority(authorityGeneration, idempotencyKey)
      throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    }
    assertCurrentRequestAuthority(authorityGeneration, idempotencyKey)
    if (!ok) {
      let error
      try {
        error = serverError(payload, status, idempotencyKey)
      } catch {
        throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
      }
      if (error.code === 'FORBIDDEN') {
        const eventSequence = sessionRequestSequence
        void refreshSessionAfter(eventSequence).catch(() => {})
      } else if (AUTH_DENIAL_CODES.has(error.code)) onAuthDenial()
      throw error
    }
    let result
    try {
      result = validate(payload, status)
    } catch {
      assertCurrentRequestAuthority(authorityGeneration, idempotencyKey)
      throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    }
    assertCurrentRequestAuthority(authorityGeneration, idempotencyKey)
    if (!result) throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    return result
  }
  const startSessionRequest = () => {
    const generation = sessionGeneration
    const sequence = ++sessionRequestSequence
    const request = requestJson(`${API_ROOT}/session`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: baseHeaders(),
    }, {
      validate: acceptedSession,
      onAuthDenial: () => {
        if (sessionGeneration === generation
          && sessionRequest?.sequence === sequence
          && newestSessionRequest?.sequence === sequence) clearSession()
      },
      authorityBound: false,
    }).then((accepted) => {
      if (sessionGeneration === generation && sequence === sessionRequestSequence) {
        const nextAuthority = authorityFingerprintFor(accepted.session)
        if (nextAuthority !== installedAuthority) {
          installedAuthority = nextAuthority
          requestAuthorityGeneration += 1
        }
        csrfToken = accepted.csrfToken
        notifySession(accepted.session)
      }
      return accepted.session
    }).catch((error) => {
      const newerRequest = newestSessionRequest
      if (sessionGeneration === generation
        && error instanceof ApiError
        && AUTH_DENIAL_CODES.has(error.code)
        && newerRequest?.sequence > sequence) return newerRequest.promise
      throw error
    })
    const activeRequest = Object.freeze({ promise: request, sequence })
    sessionRequest = activeRequest
    newestSessionRequest = activeRequest
    const clearRequest = () => {
      if (sessionRequest === activeRequest) sessionRequest = null
    }
    void request.then(clearRequest, clearRequest)
    return request
  }
  const getSession = () => sessionRequest?.promise ?? startSessionRequest()
  const refreshSessionAfter = (eventSequence) => (
    sessionRequest?.sequence > eventSequence
      ? sessionRequest.promise
      : startSessionRequest()
  )
  const listStaff = () => requestJson(`${API_ROOT}/staff`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: baseHeaders(),
  }, {
    validate: acceptedStaffList,
  })
  const listCapabilityTargets = () => requestJson(`${API_ROOT}/staff/capability-targets`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: baseHeaders(),
  }, {
    validate: acceptedCapabilityTargets,
  })
  const getCapabilityOverrides = (staffId) => {
    if (typeof staffId !== 'string' || !STAFF_ID.test(staffId)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    return requestJson(`${API_ROOT}/staff/${staffId}/capability-overrides`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: baseHeaders(),
    }, {
      validate: acceptedCapabilityAuthority,
    })
  }
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
  const loadActivityWorkspace = (options) => {
    const requested = activityCapture(
      captureActivityMonthWindow, options,
    )
    if (!requested) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    return requestJson(
      `${API_ROOT}/activities/workspace?from=${requested.from}&to=${requested.to}`,
      {
        method: 'GET', credentials: 'same-origin', headers: baseHeaders(),
      },
      { validate: (payload, status) => acceptedActivityWorkspace(payload, status, requested) },
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
  const listFinance = (options) => {
    const accepted = captureDataObject(options, ['month', 'kind'])
    if (!accepted || !(accepted.month === null
      || (typeof accepted.month === 'string' && FINANCE_MONTH.test(accepted.month)))
      || (accepted.kind !== null && !['expense', 'income'].includes(accepted.kind))) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    const query = new URLSearchParams({ month: accepted.month ?? 'unknown' })
    if (accepted.kind !== null) query.set('kind', accepted.kind)
    return requestJson(`${API_ROOT}/finance?${query}`, {
      method: 'GET', credentials: 'same-origin', headers: baseHeaders(),
    }, { validate: (payload) => acceptedFinanceList(payload, accepted.month) })
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
  const mutationOutcome = async (path, body, validate, suppliedKey) => {
    const idempotencyKey = suppliedKey === undefined
      ? createIdempotencyKey()
      : suppliedKey
    if (!acceptedKey(idempotencyKey)) throw clientError('CLIENT_INPUT_INVALID')
    if (!csrfToken) throw clientError('SESSION_REQUIRED')
    const send = async () => {
      const authorityGeneration = requestAuthorityGeneration
      const result = await requestJson(path, {
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
      return Object.freeze({ authorityGeneration, result })
    }
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'CSRF_EXPIRED') throw error
    }
    const eventSequence = sessionRequestSequence
    await refreshSessionAfter(eventSequence)
    return send()
  }
  const mutation = async (...args) => (await mutationOutcome(...args)).result
  const lifecycleMutation = async (path, body, validate, suppliedKey) => {
    const idempotencyKey = suppliedKey === undefined
      ? createIdempotencyKey()
      : suppliedKey
    if (!acceptedKey(idempotencyKey)) throw clientError('CLIENT_INPUT_INVALID')
    let outcome = await mutationOutcome(path, body, validate, idempotencyKey)
    for (let replayed = false; ; replayed = true) {
      const eventSequence = sessionRequestSequence
      try {
        await refreshSessionAfter(eventSequence)
      } catch (error) {
        if (error instanceof ApiError) {
          throw clientError(error.code, {
            status: error.status,
            details: error.details,
            correlationId: error.correlationId,
            idempotencyKey,
          })
        }
        throw clientError('INVALID_RESPONSE', { idempotencyKey })
      }
      if (outcome.authorityGeneration === requestAuthorityGeneration) return outcome.result
      if (replayed) throw clientError('SESSION_AUTHORITY_STALE', { idempotencyKey })
      outcome = await mutationOutcome(path, body, validate, idempotencyKey)
    }
  }
  const replaceCapabilityOverrides = async (staffId, input, options) => {
    const requested = captureCapabilityOverrideInput(input)
    const acceptedOptions = captureClientOptions(options)
    if (typeof staffId !== 'string' || !STAFF_ID.test(staffId)
      || !requested || !acceptedOptions) {
      throw clientError('CLIENT_INPUT_INVALID')
    }
    if (!csrfToken) throw clientError('SESSION_REQUIRED')
    return lifecycleMutation(
      `${API_ROOT}/staff/${staffId}/capability-overrides/edits`,
      JSON.stringify(requested),
      acceptedCapabilityAuthority,
      acceptedOptions.idempotencyKey,
    )
  }
  const multipartMutation = async (path, formFactory, validate, suppliedKey = null) => {
    if (suppliedKey !== null && !acceptedKey(suppliedKey)) {
      throw clientError('CLIENT_INPUT_INVALID')
    }
    if (!csrfToken) throw clientError('SESSION_REQUIRED')
    const send = () => requestJson(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        ...baseHeaders(),
        'X-CSRF-Token': csrfToken,
        ...(suppliedKey === null ? {} : { 'Idempotency-Key': suppliedKey }),
      },
      body: formFactory(),
    }, {
      validate,
      idempotencyKey: suppliedKey ?? undefined,
    })
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'CSRF_EXPIRED') throw error
    }
    await getSession()
    return send()
  }
  const requestWorkbookExport = async (format) => {
    const authorityGeneration = requestAuthorityGeneration
    let response
    try {
      response = await fetchImpl(`${API_ROOT}/workbooks/export?format=${format}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          ...baseHeaders(),
          Accept: WORKBOOK_MIME,
        },
      })
    } catch {
      assertCurrentRequestAuthority(authorityGeneration)
      throw clientError('NETWORK_ERROR')
    }
    assertCurrentRequestAuthority(authorityGeneration)
    const status = responseStatus(response)
    let ok
    try { ok = response?.ok } catch { throw clientError('INVALID_RESPONSE') }
    if (!status || typeof ok !== 'boolean') throw clientError('INVALID_RESPONSE', { status })
    if (!ok) {
      let payload
      try { payload = await response.json() } catch {
        assertCurrentRequestAuthority(authorityGeneration)
        throw clientError('INVALID_RESPONSE', { status })
      }
      assertCurrentRequestAuthority(authorityGeneration)
      const error = serverError(payload, status)
      if (error.code === 'FORBIDDEN') {
        void getSession().catch(() => {})
      } else if (AUTH_DENIAL_CODES.has(error.code)) clearSession()
      throw error
    }
    let filename
    let declaredLength
    try {
      if (status !== 200 || response.headers.get('content-type') !== WORKBOOK_MIME
        || response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') {
        throw new Error('invalid')
      }
      const cache = response.headers.get('cache-control')?.toLowerCase().split(',')
        .map((value) => value.trim())
      if (!cache?.includes('private') || !cache.includes('no-store')) throw new Error('invalid')
      const disposition = response.headers.get('content-disposition')
      const match = /^attachment; filename="([A-Za-z0-9][A-Za-z0-9._-]{0,127}\.xlsx)"$/
        .exec(disposition ?? '')
      if (!match) throw new Error('invalid')
      filename = match[1]
      const length = response.headers.get('content-length')
      declaredLength = length === null ? null : Number(length)
      if (declaredLength !== null && (!Number.isSafeInteger(declaredLength)
        || declaredLength < 1 || declaredLength > MAX_WORKBOOK_EXPORT_BYTES)) {
        throw new Error('invalid')
      }
    } catch {
      assertCurrentRequestAuthority(authorityGeneration)
      throw clientError('INVALID_RESPONSE', { status })
    }
    let reader
    try { reader = response.body?.getReader() } catch { /* Validated below. */ }
    if (!reader || typeof reader.read !== 'function' || typeof reader.cancel !== 'function') {
      throw clientError('INVALID_RESPONSE', { status })
    }
    const chunks = []
    let total = 0
    try {
      while (true) {
        const next = await reader.read()
        assertCurrentRequestAuthority(authorityGeneration)
        if (!next || typeof next.done !== 'boolean') throw new Error('invalid')
        if (next.done) break
        if (!(next.value instanceof Uint8Array) || next.value.byteLength < 1) {
          throw new Error('invalid')
        }
        total += next.value.byteLength
        if (total > MAX_WORKBOOK_EXPORT_BYTES
          || (declaredLength !== null && total > declaredLength)) {
          await reader.cancel()
          throw new Error('invalid')
        }
        chunks.push(next.value)
      }
    } catch {
      try { await reader.cancel() } catch { /* The response is already unusable. */ }
      assertCurrentRequestAuthority(authorityGeneration)
      throw clientError('INVALID_RESPONSE', { status })
    }
    if (total < 1 || (declaredLength !== null && declaredLength !== total)) {
      throw clientError('INVALID_RESPONSE', { status })
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    assertCurrentRequestAuthority(authorityGeneration)
    return Object.freeze({ bytes, filename })
  }
  const createClient = (input, options) => {
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
  const createActivityGroup = (input, options) => {
    const requested = activityCapture(captureCreateActivityGroupCommand, input)
    const acceptedOptions = captureClientOptions(options)
    if (!requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/activities/groups`, JSON.stringify(requested),
      (payload, status) => acceptedActivityGroup(payload, status, 201, requested),
      acceptedOptions.idempotencyKey,
    )
  }
  const editActivityGroup = (groupId, input, options) => {
    const requested = activityCapture(captureEditActivityGroupCommand, input)
    const acceptedOptions = captureClientOptions(options)
    if (!isActivityGroupId(groupId) || !requested
      || requested.expectedVersion >= Number.MAX_SAFE_INTEGER || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/activities/groups/${groupId}/edits`, JSON.stringify(requested),
      (payload, status) => acceptedActivityGroup(payload, status, 200, requested, {
        id: groupId, expectedVersion: requested.expectedVersion,
      }),
      acceptedOptions.idempotencyKey,
    )
  }
  const createActivityParticipant = (input, options) => {
    const requested = activityCapture(captureCreateActivityParticipantCommand, input)
    const acceptedOptions = captureClientOptions(options)
    if (!requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/activities/participants`, JSON.stringify(requested),
      (payload, status) => acceptedActivityParticipant(payload, status, 201, requested),
      acceptedOptions.idempotencyKey,
    )
  }
  const editActivityParticipant = (participantId, input, options) => {
    const requested = activityCapture(captureEditActivityParticipantCommand, input)
    const acceptedOptions = captureClientOptions(options)
    if (!isActivityParticipantId(participantId) || !requested
      || requested.expectedVersion >= Number.MAX_SAFE_INTEGER || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/activities/participants/${participantId}/edits`, JSON.stringify(requested),
      (payload, status) => acceptedActivityParticipant(payload, status, 200, requested, {
        id: participantId, expectedVersion: requested.expectedVersion,
      }),
      acceptedOptions.idempotencyKey,
    )
  }
  const createActivityMembership = (input, options) => {
    const requested = activityCapture(captureCreateActivityMembershipCommand, input)
    const acceptedOptions = captureClientOptions(options)
    if (!requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/activities/memberships`, JSON.stringify(requested),
      (payload, status) => acceptedActivityMembership(payload, status, 201, requested),
      acceptedOptions.idempotencyKey,
    )
  }
  const editActivityMembership = (membershipId, input, options) => {
    const requested = activityCapture(captureEditActivityMembershipCommand, input)
    const acceptedOptions = captureClientOptions(options)
    if (!isActivityMembershipId(membershipId) || !requested
      || requested.expectedVersion >= Number.MAX_SAFE_INTEGER || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/activities/memberships/${membershipId}/edits`, JSON.stringify(requested),
      (payload, status) => acceptedActivityMembership(payload, status, 200, requested, {
        id: membershipId, expectedVersion: requested.expectedVersion,
      }),
      acceptedOptions.idempotencyKey,
    )
  }
  const createActivityClass = (input, options) => {
    const requested = activityCapture(captureCreateActivityClassCommand, input)
    const acceptedOptions = captureClientOptions(options)
    if (!requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/activities/classes`, JSON.stringify(requested),
      (payload, status) => acceptedActivityClass(payload, status, 201, requested),
      acceptedOptions.idempotencyKey,
    )
  }
  const editActivityClass = (classId, input, options) => {
    const requested = activityCapture(captureEditActivityClassCommand, input)
    const acceptedOptions = captureClientOptions(options)
    if (!isActivityClassId(classId) || !requested
      || requested.expectedVersion >= Number.MAX_SAFE_INTEGER || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/activities/classes/${classId}/edits`, JSON.stringify(requested),
      (payload, status) => acceptedActivityClass(payload, status, 200, requested, {
        id: classId, expectedVersion: requested.expectedVersion,
      }),
      acceptedOptions.idempotencyKey,
    )
  }
  const setActivityAttendance = (classId, input, options) => {
    const requested = activityCapture(captureSetActivityAttendanceCommand, input)
    const acceptedOptions = captureClientOptions(options)
    if (!isActivityClassId(classId) || !requested
      || requested.expectedVersion >= Number.MAX_SAFE_INTEGER || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    const expectedStatus = requested.expectedVersion === 0 ? 201 : 200
    return mutation(
      `${API_ROOT}/activities/classes/${classId}/attendance`, JSON.stringify(requested),
      (payload, status) => acceptedActivityAttendance(
        payload, status, expectedStatus, classId, requested,
      ),
      acceptedOptions.idempotencyKey,
    )
  }
  const createSpecialistProfile = (input, options) => {
    const requested = captureSpecialistProfileInput(input)
    const acceptedOptions = captureClientOptions(options)
    if (!requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/specialists`,
      JSON.stringify(requested),
      (payload, status) => acceptedSpecialistProfile(payload, status, requested),
      acceptedOptions.idempotencyKey,
    )
  }
  const updateSpecialistProfile = (specialistId, expectedVersion, input, options) => {
    const requested = captureSpecialistProfileInput(input)
    const acceptedOptions = captureClientOptions(options)
    if (typeof specialistId !== 'string' || !SPECIALIST_ID.test(specialistId)
      || !positive(expectedVersion) || !requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/specialists/${specialistId}/edits`,
      JSON.stringify({ expectedVersion, ...requested }),
      (payload, status) => acceptedEditedSpecialistProfile(
        payload, status, specialistId, expectedVersion, requested,
      ),
      acceptedOptions.idempotencyKey,
    )
  }
  const linkSpecialistAccount = (specialistId, input, options) => {
    const requested = captureSpecialistAccountLinkInput(input)
    const acceptedOptions = captureClientOptions(options)
    if (typeof specialistId !== 'string' || !SPECIALIST_ID.test(specialistId)
      || !requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return lifecycleMutation(
      `${API_ROOT}/specialists/${specialistId}/account-links`,
      JSON.stringify(requested),
      (payload, status) => acceptedSpecialistAccountLink(
        payload, status, specialistId, requested,
      ),
      acceptedOptions.idempotencyKey,
    )
  }
  const startFinanceImport = (input, options) => {
    const acceptedOptions = captureClientOptions(options)
    let requested
    try { requested = validateFinanceImport(input) } catch { requested = null }
    if (!requested || !acceptedOptions) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/finance/imports`, JSON.stringify(requested),
      (payload, status) => acceptedFinanceBatch(payload, status, true, [201]),
      acceptedOptions.idempotencyKey,
    )
  }
  const appendFinanceImportChunk = (batchId, sequence, values, options) => {
    const acceptedOptions = captureClientOptions(options)
    const entries = Array.isArray(values) && values.length >= 1 && values.length <= 20
      ? values.map(captureFinanceEntryInput) : null
    if (typeof batchId !== 'string' || !FINANCE_BATCH_ID.test(batchId)
      || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 9999
      || !entries || entries.some((value) => !value || value.source?.batchId !== batchId)
      || !acceptedOptions) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/finance/imports/${batchId}/chunks`,
      JSON.stringify({ sequence, entries }),
      (payload, status) => acceptedFinanceBatch(payload, status, false, [200]),
      acceptedOptions.idempotencyKey,
    )
  }
  const commitFinanceImport = (batchId, expectedVersion, options) => {
    const acceptedOptions = captureClientOptions(options)
    if (typeof batchId !== 'string' || !FINANCE_BATCH_ID.test(batchId)
      || !positive(expectedVersion) || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/finance/imports/${batchId}/commit`,
      JSON.stringify({ expectedVersion }),
      (payload, status) => acceptedFinanceBatch(payload, status, false, [200]),
      acceptedOptions.idempotencyKey,
    )
  }
  const previewWorkbook = (rawFile) => {
    const file = captureWorkbookFile(rawFile)
    if (!file) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return multipartMutation(
      `${API_ROOT}/workbooks/preview`,
      () => {
        const form = new FormData()
        form.append('workbook', file, file.name)
        return form
      },
      acceptedWorkbookPreview,
    )
  }
  const createWorkbookImport = (rawFile, previewToken, options) => {
    const file = captureWorkbookFile(rawFile)
    const acceptedOptions = captureClientOptions(options)
    if (!file || typeof previewToken !== 'string' || previewToken.length > 4_096
      || !WORKBOOK_PREVIEW_TOKEN.test(previewToken) || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    const idempotencyKey = acceptedOptions.idempotencyKey ?? createIdempotencyKey()
    return multipartMutation(
      `${API_ROOT}/workbooks/imports`,
      () => {
        const form = new FormData()
        form.append('previewToken', previewToken)
        form.append('workbook', file, file.name)
        return form
      },
      acceptedWorkbookImport,
      idempotencyKey,
    )
  }
  const continueWorkbookImport = (importId, expectedVersion, options) => {
    const acceptedOptions = captureClientOptions(options)
    if (typeof importId !== 'string' || !WORKBOOK_IMPORT_ID.test(importId)
      || !positive(expectedVersion) || expectedVersion >= Number.MAX_SAFE_INTEGER
      || !acceptedOptions) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    const idempotencyKey = acceptedOptions.idempotencyKey ?? createIdempotencyKey()
    return multipartMutation(
      `${API_ROOT}/workbooks/imports/${importId}/continue`,
      () => {
        const form = new FormData()
        form.append('expectedVersion', String(expectedVersion))
        return form
      },
      acceptedWorkbookStatus,
      idempotencyKey,
    )
  }
  const getWorkbookImport = (importId) => {
    if (typeof importId !== 'string' || !WORKBOOK_IMPORT_ID.test(importId)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    return requestJson(`${API_ROOT}/workbooks/imports/${importId}`, {
      method: 'GET', credentials: 'same-origin', headers: baseHeaders(),
    }, { validate: acceptedWorkbookStatus })
  }
  const getActivityProjection = (importId) => {
    if (typeof importId !== 'string' || !WORKBOOK_IMPORT_ID.test(importId)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    return requestJson(
      `${API_ROOT}/workbooks/imports/${importId}/activity-projection`,
      { method: 'GET', credentials: 'same-origin', headers: baseHeaders() },
      { validate: (payload, status) => acceptedActivityProjection(payload, status, importId) },
    ).then((result) => result === NO_ACTIVITY_PROJECTION ? null : result)
  }
  const continueActivityProjection = (importId, expectedVersion, options) => {
    const acceptedOptions = captureClientOptions(options)
    if (typeof importId !== 'string' || !WORKBOOK_IMPORT_ID.test(importId)
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
      || expectedVersion >= Number.MAX_SAFE_INTEGER
      || !acceptedOptions) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/workbooks/imports/${importId}/activity-projection/continue`,
      JSON.stringify({ expectedVersion }),
      (payload, status) => acceptedActivityProjection(
        payload, status, importId, expectedVersion,
      ),
      acceptedOptions.idempotencyKey,
    )
  }
  const exportWorkbook = (format) => {
    if (!['legacy', 'panel-v2'].includes(format)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    return requestWorkbookExport(format)
  }
  const editClient = (clientId, expectedVersion, input, options) => {
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
  const archiveClient = (clientId, expectedVersion, options) => {
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
  const activateHistoricalClient = (
    historicalClientId, expectedVersion, specialistId, options,
  ) => {
    const acceptedOptions = captureClientOptions(options)
    if (typeof historicalClientId !== 'string'
      || !HISTORICAL_CLIENT_ID.test(historicalClientId)
      || !positive(expectedVersion) || expectedVersion >= Number.MAX_SAFE_INTEGER
      || typeof specialistId !== 'string' || !SPECIALIST_ID.test(specialistId)
      || !acceptedOptions) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/historical-clients/${historicalClientId}/activation`,
      JSON.stringify({ expectedVersion, specialistId }),
      (payload, status) => acceptedHistoricalActivation(
        payload, status, historicalClientId, expectedVersion, specialistId,
      ),
      acceptedOptions.idempotencyKey,
    )
  }
  const createAppointment = (input, options) => {
    const requested = captureAppointmentInput(input)
    const acceptedOptions = captureClientOptions(options)
    if (!requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/appointments`,
      JSON.stringify({
        clientId: requested.clientId,
        specialistId: requested.specialistId,
        serviceId: requested.serviceId,
        date: requested.date,
        time: requested.time,
        durationMinutes: requested.durationMinutes,
        expectedAmountGrosze: requested.expectedAmountGrosze,
        location: requested.location,
        status: requested.status,
      }),
      (payload, status) => acceptedCreatedAppointment(payload, status, requested),
      acceptedOptions.idempotencyKey,
    )
  }
  const editAppointment = (appointmentId, expectedVersion, input, options) => {
    const requested = captureAppointmentInput(input, true)
    const acceptedOptions = captureClientOptions(options)
    if (typeof appointmentId !== 'string' || !APPOINTMENT_ID.test(appointmentId)
      || !positive(expectedVersion) || expectedVersion >= 4_096
      || !requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/appointments/${appointmentId}/edits`,
      JSON.stringify({
        expectedVersion,
        specialistId: requested.specialistId,
        serviceId: requested.serviceId,
        date: requested.date,
        time: requested.time,
        durationMinutes: requested.durationMinutes,
        expectedAmountGrosze: requested.expectedAmountGrosze,
        location: requested.location,
        status: requested.status,
      }),
      (payload, status) => acceptedEditedAppointment(
        payload, status, appointmentId, expectedVersion, requested,
      ),
      acceptedOptions.idempotencyKey,
    )
  }
  const cancelAppointment = (appointmentId, expectedVersion, options) => {
    const acceptedOptions = captureClientOptions(options)
    if (typeof appointmentId !== 'string' || !APPOINTMENT_ID.test(appointmentId)
      || !positive(expectedVersion) || expectedVersion >= 4_096 || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/appointments/${appointmentId}/cancellation`,
      JSON.stringify({ expectedVersion }),
      (payload, status) => acceptedCancelledAppointment(
        payload, status, appointmentId, expectedVersion,
      ),
      acceptedOptions.idempotencyKey,
    )
  }
  const recordPayment = (appointmentId, expectedVersion, input, options) => {
    const requested = capturePaymentInput(input)
    const acceptedOptions = captureClientOptions(options)
    if (typeof appointmentId !== 'string' || !APPOINTMENT_ID.test(appointmentId)
      || !positive(expectedVersion) || expectedVersion >= 4_096
      || !requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/appointments/${appointmentId}/payments`,
      JSON.stringify({
        expectedVersion,
        amountGrosze: requested.amountGrosze,
        method: requested.method,
        receivedAt: requested.receivedAt,
      }),
      (payload, status) => acceptedRecordedPayment(
        payload, status, appointmentId, expectedVersion, requested,
      ),
      acceptedOptions.idempotencyKey,
    )
  }
  const correctPayment = (paymentId, expectedVersion, input, options) => {
    const requested = captureCorrectionInput(input)
    const acceptedOptions = captureClientOptions(options)
    if (typeof paymentId !== 'string' || !PAYMENT_ID.test(paymentId)
      || !positive(expectedVersion) || expectedVersion >= 4_096
      || !requested || !acceptedOptions) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return mutation(
      `${API_ROOT}/payments/${paymentId}/corrections`,
      JSON.stringify({
        expectedVersion,
        reason: requested.reason,
        replacement: requested.replacement === null ? null : {
          amountGrosze: requested.replacement.amountGrosze,
          method: requested.replacement.method,
          receivedAt: requested.replacement.receivedAt,
        },
      }),
      (payload, status) => acceptedCorrectedPayment(
        payload, status, paymentId, expectedVersion, requested,
      ),
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
    return lifecycleMutation(
      `${API_ROOT}/staff/invitations`,
      body,
      acceptedInvitationResult,
      idempotencyKey,
    )
  }
  const inviteSpecialistProfile = (specialistId, input, options = {}) => {
    const acceptedOptions = idempotencyOptions(options)
    if (!acceptedOptions || typeof specialistId !== 'string'
      || !SPECIALIST_ID.test(specialistId)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    const requested = captureDataObject(input, ['email', 'expectedVersion'])
    if (!requested || !validText(requested.email, 320)
      || !positive(requested.expectedVersion)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return lifecycleMutation(
      `${API_ROOT}/specialists/${specialistId}/invitations`,
      JSON.stringify(requested),
      acceptedInvitationResult,
      acceptedOptions.idempotencyKey,
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
    return lifecycleMutation(
      `${API_ROOT}/staff/${staffId}/deactivation`,
      JSON.stringify({ version }),
      acceptedDeactivationResult,
      idempotencyKey,
    )
  }
  const changeStaffRole = (staffId, expectedVersion, role, options = {}) => {
    const acceptedOptions = idempotencyOptions(options)
    if (!acceptedOptions || typeof staffId !== 'string' || !STAFF_ID.test(staffId)
      || !positive(expectedVersion) || expectedVersion >= Number.MAX_SAFE_INTEGER
      || typeof role !== 'string' || !ROLES.has(role)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    const { idempotencyKey } = acceptedOptions
    if (idempotencyKey !== undefined && !acceptedKey(idempotencyKey)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    return lifecycleMutation(
      `${API_ROOT}/staff/${staffId}/role`,
      JSON.stringify({ expectedVersion, role }),
      (payload, status) => acceptedRoleChangeResult(
        payload,
        status,
        staffId,
        expectedVersion,
        role,
      ),
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
    listCapabilityTargets,
    getCapabilityOverrides,
    replaceCapabilityOverrides,
    loadWorkspaceWindow,
    loadActivityWorkspace,
    getOperationsHealth,
    getOperationalActions,
    getSecurityAudit,
    listFinance,
    createClient,
    createActivityGroup,
    editActivityGroup,
    createActivityParticipant,
    editActivityParticipant,
    createActivityMembership,
    editActivityMembership,
    createActivityClass,
    editActivityClass,
    setActivityAttendance,
    activateHistoricalClient,
    createSpecialistProfile,
    updateSpecialistProfile,
    linkSpecialistAccount,
    editClient,
    archiveClient,
    startFinanceImport,
    appendFinanceImportChunk,
    commitFinanceImport,
    previewWorkbook,
    createWorkbookImport,
    continueWorkbookImport,
    getWorkbookImport,
    getActivityProjection,
    continueActivityProjection,
    exportWorkbook,
    createAppointment,
    editAppointment,
    cancelAppointment,
    recordPayment,
    correctPayment,
    inviteStaff,
    inviteSpecialistProfile,
    deactivateStaff,
    changeStaffRole,
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
