const STATUS_BY_CODE = Object.freeze({
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
  WORKBOOK_REGISTRY_LIMIT: 409,
  WORKBOOK_REGISTRY_RETRY: 409,
  WORKBOOK_RECONCILIATION_CONFLICT: 409,
  FINANCE_IMPORT_CLOSED: 409,
  FINANCE_IMPORT_DUPLICATE: 409,
  FINANCE_IMPORT_INCOMPLETE: 409,
  FINANCE_IMPORT_OVERFLOW: 409,
  FINANCE_ENTRY_VOIDED: 409,
  FINANCE_ENTRY_NOT_READY: 409,
  FINANCE_ENTRY_DEPENDENCY_CONFLICT: 409,
  FINANCE_WINDOW_LIMIT: 409,
  FINANCE_WINDOW_RETRY: 409,
  STAFF_INVITATION_CONFLICT: 409,
  SPECIALIST_LINK_CONFLICT: 409,
  LAST_ACTIVE_OWNER: 409,
  VERSION_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  ACCESS_KEYSET_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
})

const VALIDATION_FIELDS = new Set([
  'body', 'displayName', 'email', 'role', 'version', 'name', 'age', 'status',
  'specialistId', 'clientId', 'serviceId', 'dateTime', 'durationMinutes',
  'expectedAmountGrosze', 'location', 'amountGrosze', 'method', 'receivedAt',
  'paidDate', 'reason', 'replacement', 'expectedVersion', 'from', 'to',
  'specialists', 'clients', 'appointments', 'paymentEntries',
  'filename', 'fingerprint', 'formatVersion', 'totalRows', 'batchId', 'sequence',
  'entries', 'accountingMonth', 'kind',
  'professionalTitle', 'standardRateGrosze', 'staffId',
  'expectedSpecialistVersion', 'expectedStaffVersion',
  'allow', 'deny', 'expectedAuthorityRevision',
  'historicalClientId', 'importId', 'expectedJobVersion', 'conflictId',
  'classification', 'existingSubjectId',
  'programId', 'label', 'details', 'leaderSpecialistIds', 'participantId',
  'groupId', 'membershipId', 'classId', 'startsOn', 'endsOn', 'date', 'time',
  'topic', 'month', 'registry', 'registryDetail', 'resolutions',
])
const WORKSPACE_FIELDS = new Set([
  'specialists', 'clients', 'appointments', 'paymentEntries',
  'historicalClients', 'historicalOccurrences',
])
const ACTIVITY_FIELDS = new Set([
  'programs', 'groups', 'groupLeaders', 'participants', 'memberships', 'classes',
  'attendance', 'charges', 'payments',
])
const EXACT_INTERNAL_MESSAGES = new Set(Object.keys(STATUS_BY_CODE))

const safeDetails = (code, details) => {
  try {
    if (!details || typeof details !== 'object' || Array.isArray(details)
      || Object.getPrototypeOf(details) !== Object.prototype) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(details)
    const value = (key) => {
      const descriptor = descriptors[key]
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
    }
    if (code === 'VALIDATION_FAILED') {
      const field = value('field')
      return VALIDATION_FIELDS.has(field) ? { field } : undefined
    }
    if (code === 'VERSION_CONFLICT') {
      const currentVersion = value('currentVersion')
      return Number.isSafeInteger(currentVersion) && currentVersion >= 0
        ? { currentVersion }
        : undefined
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

export class AppError extends Error {
  constructor(code, details = null) {
    const safeCode = Object.hasOwn(STATUS_BY_CODE, code) ? code : 'INTERNAL_ERROR'
    super(safeCode)
    this.code = safeCode
    this.status = STATUS_BY_CODE[safeCode]
    this.details = safeDetails(safeCode, details)
  }
}

export function publicError(error) {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(error)
    const data = (key) => Object.hasOwn(descriptors[key] ?? {}, 'value')
      ? descriptors[key].value
      : undefined
    if (error instanceof AppError) return new AppError(data('code'), data('details'))
    const message = data('message')
    if (error instanceof Error && EXACT_INTERNAL_MESSAGES.has(message)) {
      return new AppError(message, data('details'))
    }
  } catch {
    return new AppError('INTERNAL_ERROR')
  }
  return new AppError('INTERNAL_ERROR')
}

export const apiError = (error, correlationId, headers = undefined) => {
  const mapped = publicError(error)
  return Response.json(
    {
      error: {
        code: mapped.code,
        correlationId,
        ...(mapped.details ? { details: mapped.details } : {}),
      },
    },
    {
      status: mapped.status,
      headers: {
        'cache-control': 'no-store',
        ...(headers ?? {}),
      },
    }
  )
}

export const statusForErrorCode = (code) => STATUS_BY_CODE[code] ?? 500
