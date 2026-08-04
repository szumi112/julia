export const D1_QUERY_BUDGET_EXCEEDED = 'D1_QUERY_BUDGET_EXCEEDED'

const invalid = () => { throw new Error('D1_QUERY_BUDGET_INVALID') }
const exceeded = () => { throw new Error(D1_QUERY_BUDGET_EXCEEDED) }
const budgetViews = new WeakSet()

const method = (target, name) => {
  let value
  try { value = Reflect.get(target, name) } catch { invalid() }
  if (typeof value !== 'function') invalid()
  return value
}

export function createD1QueryBudget(db, options = {}) {
  const totalLimit = options.totalLimit ?? 50
  const recoveryReserve = options.recoveryReserve ?? 5
  if (!db || (typeof db !== 'object' && typeof db !== 'function') || budgetViews.has(db)
    || !Number.isSafeInteger(totalLimit) || totalLimit < 1
    || !Number.isSafeInteger(recoveryReserve) || recoveryReserve < 0
    || recoveryReserve >= totalLimit) invalid()
  const rawPrepare = method(db, 'prepare')
  const rawBatch = method(db, 'batch')

  const workLimit = totalLimit - recoveryReserve
  const statements = new WeakMap()
  let used = 0

  const admit = (count, limit) => {
    if (!Number.isSafeInteger(count) || count < 0 || count > limit - used) exceeded()
    used += count
  }

  const wrapStatement = (inner, limit) => {
    if (!inner || (typeof inner !== 'object' && typeof inner !== 'function')) invalid()
    const bind = method(inner, 'bind')
    const terminals = Object.freeze(Object.fromEntries(
      ['run', 'first', 'all', 'raw'].map((name) => [name, method(inner, name)])
    ))
    const terminal = (method, args) => {
      admit(1, limit)
      return terminals[method].apply(inner, args)
    }
    const wrapper = {
      bind(...values) {
        return wrapStatement(bind.apply(inner, values), limit)
      },
      run(...args) { return terminal('run', args) },
      first(...args) { return terminal('first', args) },
      all(...args) { return terminal('all', args) },
      raw(...args) { return terminal('raw', args) },
    }
    statements.set(wrapper, inner)
    return Object.freeze(wrapper)
  }

  const view = (limit) => {
    const result = Object.freeze({
      prepare(...args) {
        return wrapStatement(rawPrepare.apply(db, args), limit)
      },
      batch(batchStatements) {
        if (!Array.isArray(batchStatements)) invalid()
        const delegated = batchStatements.map((statement) => statements.get(statement) ?? statement)
        admit(batchStatements.length, limit)
        return rawBatch.call(db, delegated)
      },
    })
    budgetViews.add(result)
    return result
  }

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
