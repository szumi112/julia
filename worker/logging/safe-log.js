const ALLOWED = new Set([
  'actorId', 'correlationId', 'durationMs', 'entityId', 'entityType',
  'errorCode', 'event', 'jobId', 'result',
])

export function safeLog(level, fields) {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => ALLOWED.has(key) && value != null)
  )
  console[level](JSON.stringify(safe))
}
