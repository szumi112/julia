// Exact request identity for canonical workspace windows. Presentation state must
// follow the range a view renders, never the provider's global request status.
export const workspaceLoadRequestKey = (range) => `${range.from}|${range.to}`

export const isWorkspaceRangePending = (pendingRanges, range) => (
  pendingRanges instanceof Set && pendingRanges.has(workspaceLoadRequestKey(range))
)

export const startWorkspaceRangePending = (counts, key) => {
  const next = new Map(counts)
  next.set(key, (next.get(key) ?? 0) + 1)
  return next
}

export const finishWorkspaceRangePending = (counts, key) => {
  const next = new Map(counts)
  const remaining = (next.get(key) ?? 0) - 1
  if (remaining > 0) next.set(key, remaining)
  else next.delete(key)
  return next
}

export const workspacePendingRangeKeys = (counts) => new Set(counts.keys())

// One provider can have several views interested in the same canonical range.
// Keep their request identity here so the repository sees one fetch while each
// view still receives the shared result.
export const createWorkspaceRangeLoadCoordinator = () => {
  let authorityGeneration = 0
  const requests = new Map()

  const reset = () => {
    authorityGeneration += 1
    requests.clear()
  }

  const load = ({ range, request, onStart, onFulfilled, onRejected, onSettled }) => {
    const key = workspaceLoadRequestKey(range)
    const existing = requests.get(key)
    if (existing) return existing

    const generation = authorityGeneration
    const context = onStart?.(key)
    let pending
    pending = Promise.resolve()
      .then(request)
      .then(
        (value) => {
          if (authorityGeneration === generation) onFulfilled?.(key, context)
          return value
        },
        (error) => {
          if (authorityGeneration === generation) onRejected?.(key, context)
          throw error
        },
      )
      .finally(() => {
        if (requests.get(key) === pending) requests.delete(key)
        if (authorityGeneration === generation) onSettled?.(key, context)
      })
    requests.set(key, pending)
    return pending
  }

  return Object.freeze({ load, reset })
}
