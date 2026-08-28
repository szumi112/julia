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

export const activityWindowLoadOutcome = ({
  enabled, hasActivities, hasRange, readOnly, covered, key, rejectedKey,
}) => {
  if (!enabled || !hasActivities || !hasRange) return 'ready'
  if (readOnly) return 'unavailable'
  if (covered) return 'ready'
  return rejectedKey === key ? 'unavailable' : 'loading'
}
