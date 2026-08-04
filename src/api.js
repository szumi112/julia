import { APP_MODE } from './app-mode.js'

const API_ROOT = '/api/v1'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CSRF_TOKEN = /^v1\.([1-9]\d*)\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const OUTBOX_TYPE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/
const AUDIT_CURSOR = /^v1\.([1-9]\d*)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const INVALID_TEXT = /[\p{Cc}\p{Cf}]/u

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
const DETAIL_FIELDS = new Set(['displayName', 'email', 'role', 'version'])
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

const safeDetails = (details) => {
  try {
    if (!plainObject(details)) return undefined
    const captured = {}
    for (const key of ['field', 'currentVersion', 'limit', 'retryAfterSeconds']) {
      if (Object.hasOwn(details, key)) captured[key] = details[key]
    }
    const result = {}
    if (DETAIL_FIELDS.has(captured.field)) result.field = captured.field
    if (Number.isSafeInteger(captured.currentVersion) && captured.currentVersion >= 0) {
      result.currentVersion = captured.currentVersion
    }
    if (Number.isSafeInteger(captured.limit) && captured.limit >= 0) {
      result.limit = captured.limit
    }
    if (Number.isSafeInteger(captured.retryAfterSeconds) && captured.retryAfterSeconds >= 0) {
      result.retryAfterSeconds = captured.retryAfterSeconds
    }
    return Object.keys(result).length > 0 ? result : undefined
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
    const acceptedDetails = safeDetails(details)
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

const acceptedAuditMetadata = (value, schema) => {
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
    if (value.action === 'backup.pruned' && !BACKUP_ID.test(value.entityId)) return null
    if (value.action === 'specialist.backfilled' && !SPECIALIST_ID.test(value.entityId)) return null
    if (value.action === 'core_directory.upgrade.advanced'
      && value.entityId !== 'core_directory_specialist_backfill_v1') return null
    const metadata = acceptedAuditMetadata(value.metadata, schema)
    if (!metadata) return null
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
      result = validate(payload)
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
    getOperationsHealth,
    getOperationalActions,
    getSecurityAudit,
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
