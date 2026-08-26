export const D1_QUERY_BUDGET_EXCEEDED = 'D1_QUERY_BUDGET_EXCEEDED'

const invalid = () => { throw new Error('D1_QUERY_BUDGET_INVALID') }
const exceeded = () => { throw new Error(D1_QUERY_BUDGET_EXCEEDED) }
const recoveryForWork = new WeakMap()
const usageForWork = new WeakMap()
const issuedViewMethods = new WeakSet()
const VIEW_PROVENANCE = Symbol('D1_QUERY_BUDGET_VIEW')

const method = (target, name) => {
  let value
  try { value = Reflect.get(target, name) } catch { invalid() }
  if (typeof value !== 'function') invalid()
  return value
}

const rejectNestedView = (candidate) => {
  let current = candidate
  const seen = new Set()
  try {
    for (let depth = 0; current !== null && depth < 64; depth += 1) {
      if ((typeof current !== 'object' && typeof current !== 'function') || seen.has(current)) invalid()
      seen.add(current)
      if (Object.getOwnPropertySymbols(current).includes(VIEW_PROVENANCE)) invalid()
      current = Object.getPrototypeOf(current)
    }
    if (current !== null) invalid()
  } catch { invalid() }
}

const denseBatch = (value) => {
  let descriptors
  try {
    if (!Array.isArray(value)) invalid()
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch { invalid() }
  const lengthDescriptor = descriptors.length
  const length = lengthDescriptor?.value
  if (!Object.hasOwn(lengthDescriptor ?? {}, 'value')
    || lengthDescriptor.enumerable !== false
    || !Number.isSafeInteger(length) || length < 0) invalid()
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== length + 1 || !keys.includes('length')) invalid()
  const captured = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) invalid()
    captured.push(descriptor.value)
  }
  return captured
}

export const areSiblingD1QueryBudgetViews = (work, recovery) => (
  (typeof work === 'object' || typeof work === 'function') && work !== null
  && recoveryForWork.get(work) === recovery
)

export const usageForD1QueryBudgetViews = (work, recovery) => {
  if (!areSiblingD1QueryBudgetViews(work, recovery)) return null
  return usageForWork.get(work)?.() ?? null
}

export function createD1QueryBudget(db, options = {}) {
  const totalLimit = options.totalLimit ?? 50
  const recoveryReserve = options.recoveryReserve ?? 5
  if (!db || (typeof db !== 'object' && typeof db !== 'function')
    || !Number.isSafeInteger(totalLimit) || totalLimit < 1
    || !Number.isSafeInteger(recoveryReserve) || recoveryReserve < 0
    || recoveryReserve >= totalLimit) invalid()
  rejectNestedView(db)
  const rawPrepare = method(db, 'prepare')
  const rawBatch = method(db, 'batch')
  if (issuedViewMethods.has(rawPrepare) || issuedViewMethods.has(rawBatch)) invalid()

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
    const result = {
      prepare(...args) {
        return wrapStatement(rawPrepare.apply(db, args), limit)
      },
      batch(batchStatements) {
        const captured = denseBatch(batchStatements)
        const delegated = captured.map((statement) => {
          const inner = statements.get(statement)
          if (!inner) invalid()
          return inner
        })
        admit(captured.length, limit)
        return rawBatch.call(db, delegated)
      },
    }
    issuedViewMethods.add(result.prepare)
    issuedViewMethods.add(result.batch)
    Object.defineProperty(result, VIEW_PROVENANCE, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    })
    Object.freeze(result)
    return result
  }

  const work = view(workLimit)
  const recovery = view(totalLimit)
  const usage = () => Object.freeze({
    used,
    remaining: totalLimit - used,
    workRemaining: Math.max(0, workLimit - used),
    totalLimit,
    recoveryReserve,
  })
  recoveryForWork.set(work, recovery)
  usageForWork.set(work, usage)
  return Object.freeze({
    work,
    recovery,
    usage,
  })
}
