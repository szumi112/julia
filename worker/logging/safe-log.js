const ALLOWED = new Set([
  'actorId', 'attemptCount', 'claimedJobs', 'correlationId', 'durationMs',
  'entityId', 'entityType', 'errorCode', 'event', 'failedJobs', 'jobId',
  'method', 'result', 'routeId', 'runId', 'status', 'succeededJobs',
])
const LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INTERNAL_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const INTERNAL_NAME = /^[a-z][a-z0-9_]{0,63}$/
const EVENT = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/
const RESULTS = new Set(['success', 'failure', 'skipped', 'started', 'completed'])
const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'CONNECT'])
const ROUTES = new Set([
  'health.live',
  'operations.action-resolution',
  'operations.actions',
  'operations.health',
  'security.audit',
  'session',
  'staff.deactivation',
  'staff.invitations',
  'staff.list',
  'unmatched',
])

export const isCorrelationId = (value) => typeof value === 'string' && UUID.test(value)

const isOpaqueId = (value) => typeof value === 'string' && OPAQUE_ID.test(value)

const isSafeValue = (key, value) => {
  if (value == null || typeof value === 'object') return false
  if (key === 'correlationId') return isCorrelationId(value)
  if (key === 'attemptCount') return Number.isSafeInteger(value) && value >= 0
  if (key === 'claimedJobs' || key === 'succeededJobs' || key === 'failedJobs') {
    return Number.isSafeInteger(value) && value >= 0 && value <= 10
  }
  if (key === 'durationMs') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000
  if (key === 'actorId' || key === 'entityId' || key === 'jobId' || key === 'runId') return isOpaqueId(value)
  if (key === 'errorCode') return typeof value === 'string' && INTERNAL_CODE.test(value)
  if (key === 'event') return typeof value === 'string' && EVENT.test(value) && value.length <= 64
  if (key === 'entityType') return typeof value === 'string' && INTERNAL_NAME.test(value)
  if (key === 'method') return typeof value === 'string' && METHODS.has(value)
  if (key === 'result') return typeof value === 'string' && RESULTS.has(value)
  if (key === 'routeId') return typeof value === 'string' && ROUTES.has(value)
  if (key === 'status') return Number.isSafeInteger(value) && value >= 100 && value <= 599
  return false
}

export function safeLog(level, fields) {
  if (!LEVELS.has(level) || !fields || typeof fields !== 'object' || Array.isArray(fields)) return
  const safe = Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => ALLOWED.has(key) && isSafeValue(key, value))
  )
  console[level](JSON.stringify(safe))
}
