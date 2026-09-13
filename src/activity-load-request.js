export const activityWindowRetry = ({ status, range, recover, schedule }) => {
  if (status === 'read-only-error') recover()
  schedule(range)
}

export const trackActivityWindowLoad = ({ key, requested, load, onRejected }) => {
  requested.add(key)
  return Promise.resolve().then(load).then(
    (value) => {
      requested.delete(key)
      return value
    },
    (error) => {
      onRejected(key)
      requested.delete(key)
      throw error
    },
  )
}

export const clearActivityWindowRejection = (rejectedKey, key) => (
  rejectedKey === key ? null : rejectedKey
)

export const shouldLoadActivityWindow = ({
  enabled, hasActivities, hasRange, readOnly, covered, key, rejectedKey, requested, forceKey,
}) => {
  if (!enabled || !hasActivities || !hasRange || readOnly || requested) return false
  if (forceKey === key) return true
  return !covered && rejectedKey !== key
}

export const activityWindowLoadOutcome = ({
  enabled, hasActivities, hasRange, readOnly, covered, key, rejectedKey,
}) => {
  if (!enabled || !hasActivities || !hasRange) return 'ready'
  if (readOnly) return 'unavailable'
  if (covered) return 'ready'
  return rejectedKey === key ? 'unavailable' : 'loading'
}
