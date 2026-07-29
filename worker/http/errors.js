export class AppError extends Error {
  constructor(code, status, details = null) {
    super(code)
    this.code = code
    this.status = status
    this.details = details
  }
}

const DETAIL_FIELDS = new Set(['displayName', 'email', 'role', 'specialistId', 'version'])

const safeDetails = (details) => {
  if (!details) return undefined
  const result = {}
  if (DETAIL_FIELDS.has(details.field)) result.field = details.field
  if (Number.isInteger(details.currentVersion)) result.currentVersion = details.currentVersion
  if (Number.isInteger(details.limit)) result.limit = details.limit
  if (Number.isInteger(details.retryAfterSeconds)) result.retryAfterSeconds = details.retryAfterSeconds
  return Object.keys(result).length ? result : undefined
}

export const apiError = (code, status, correlationId, details = undefined) => {
  const allowedDetails = safeDetails(details)
  return Response.json(
    { error: { code, correlationId, ...(allowedDetails ? { details: allowedDetails } : {}) } },
    { status, headers: { 'cache-control': 'no-store' } }
  )
}
