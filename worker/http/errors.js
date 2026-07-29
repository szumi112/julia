const STATUS_BY_CODE = Object.freeze({
  INVALID_CONTENT_LENGTH: 400,
  INVALID_JSON: 400,
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
  VERSION_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  ACCESS_KEYSET_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
})

const DETAIL_FIELDS = new Set(['displayName', 'email', 'role', 'specialistId', 'version'])
const EXACT_INTERNAL_MESSAGES = new Set(Object.keys(STATUS_BY_CODE))

const safeDetails = (details) => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
  const result = {}
  if (DETAIL_FIELDS.has(details.field)) result.field = details.field
  if (Number.isSafeInteger(details.currentVersion) && details.currentVersion >= 0) result.currentVersion = details.currentVersion
  if (Number.isSafeInteger(details.limit) && details.limit >= 0) result.limit = details.limit
  if (Number.isSafeInteger(details.retryAfterSeconds) && details.retryAfterSeconds >= 0) {
    result.retryAfterSeconds = details.retryAfterSeconds
  }
  return Object.keys(result).length ? result : undefined
}

export class AppError extends Error {
  constructor(code, details = null) {
    const safeCode = Object.hasOwn(STATUS_BY_CODE, code) ? code : 'INTERNAL_ERROR'
    super(safeCode)
    this.code = safeCode
    this.status = STATUS_BY_CODE[safeCode]
    this.details = safeDetails(details)
  }
}

export function publicError(error) {
  if (error instanceof AppError) return error
  if (error instanceof Error && EXACT_INTERNAL_MESSAGES.has(error.message)) {
    return new AppError(error.message)
  }
  return new AppError('INTERNAL_ERROR')
}

export const apiError = (error, correlationId, headers = undefined) => {
  const mapped = error instanceof AppError ? error : publicError(error)
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
