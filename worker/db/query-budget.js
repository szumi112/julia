export const D1_QUERY_BUDGET_EXCEEDED = 'D1_QUERY_BUDGET_EXCEEDED'

const invalid = () => { throw new Error('D1_QUERY_BUDGET_INVALID') }
const exceeded = () => { throw new Error(D1_QUERY_BUDGET_EXCEEDED) }

export function createD1QueryBudget(db, options = {}) {
  const totalLimit = options.totalLimit ?? 50
  const recoveryReserve = options.recoveryReserve ?? 5
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function'
    || !Number.isSafeInteger(totalLimit) || totalLimit < 1
    || !Number.isSafeInteger(recoveryReserve) || recoveryReserve < 0
    || recoveryReserve >= totalLimit) invalid()

  const workLimit = totalLimit - recoveryReserve
  const statements = new WeakMap()
  let used = 0

  const admit = (count, limit) => {
    if (!Number.isSafeInteger(count) || count < 0 || count > limit - used) exceeded()
    used += count
  }

  const wrapStatement = (inner, limit) => {
    const terminal = (method, args) => {
      admit(1, limit)
      return inner[method](...args)
    }
    const wrapper = {
      bind(...values) {
        return wrapStatement(inner.bind(...values), limit)
      },
      run(...args) { return terminal('run', args) },
      first(...args) { return terminal('first', args) },
      all(...args) { return terminal('all', args) },
      raw(...args) { return terminal('raw', args) },
    }
    statements.set(wrapper, inner)
    return Object.freeze(wrapper)
  }

  const view = (limit) => Object.freeze({
    prepare(...args) {
      return wrapStatement(db.prepare(...args), limit)
    },
    batch(batchStatements) {
      if (!Array.isArray(batchStatements)) invalid()
      const delegated = batchStatements.map((statement) => statements.get(statement) ?? statement)
      admit(batchStatements.length, limit)
      return db.batch(delegated)
    },
  })

  return Object.freeze({
    work: view(workLimit),
    recovery: view(totalLimit),
    usage: () => Object.freeze({
      used,
      remaining: totalLimit - used,
      workRemaining: Math.max(0, workLimit - used),
      totalLimit,
      recoveryReserve,
    }),
  })
}
