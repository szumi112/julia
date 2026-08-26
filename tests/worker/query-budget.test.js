import { describe, expect, it } from 'vitest'
import {
  D1_QUERY_BUDGET_EXCEEDED,
  areSiblingD1QueryBudgetViews,
  createD1QueryBudget,
  usageForD1QueryBudgetViews,
} from '../../worker/db/query-budget.js'

function fakeDb() {
  const calls = []
  const statement = (sql, bindings = []) => ({
    sql,
    bind(...values) { return statement(sql, values) },
    run() {
      calls.push({ method: 'run', sql, bindings })
      return Promise.resolve({ success: true })
    },
    first(column) {
      calls.push({ method: 'first', sql, bindings, column })
      return Promise.resolve({ value: sql })
    },
    all() {
      calls.push({ method: 'all', sql, bindings })
      return Promise.resolve({ results: [] })
    },
    raw(options) {
      calls.push({ method: 'raw', sql, bindings, options })
      return Promise.resolve([])
    },
  })
  return {
    calls,
    prepare(sql) { return statement(sql) },
    batch(statements) {
      calls.push({
        method: 'batch',
        statements: statements.map((item) => item.sql),
      })
      return Promise.resolve(statements.map(() => ({ success: true })))
    },
  }
}

describe('invocation-scoped D1 query budget', () => {
  it('rejects nested budgets from either view before delegating', () => {
    const db = fakeDb()
    const budget = createD1QueryBudget(db, { totalLimit: 50, recoveryReserve: 8 })

    for (const view of [budget.work, budget.recovery]) {
      expect(() => createD1QueryBudget(view, { totalLimit: 50, recoveryReserve: 8 }))
        .toThrow('D1_QUERY_BUDGET_INVALID')
    }
    expect(db.calls).toEqual([])
  })

  it('rejects proxied and inherited nested views before touching visible DB methods', () => {
    const db = fakeDb()
    const budget = createD1QueryBudget(db, { totalLimit: 50, recoveryReserve: 8 })
    const candidates = []
    for (const view of [budget.work, budget.recovery]) {
      candidates.push(new Proxy(view, {}), Object.create(view))
      const inherited = Object.create(view)
      Object.defineProperties(inherited, {
        prepare: { get() { throw new Error('nested prepare marker') } },
        batch: { get() { throw new Error('nested batch marker') } },
      })
      candidates.push(inherited)
      candidates.push(new Proxy(view, {
        ownKeys(target) {
          return Reflect.ownKeys(target).filter((key) => typeof key !== 'symbol')
        },
      }))
      candidates.push(new Proxy(Object.create(view), {
        getPrototypeOf() { return null },
      }))
    }

    for (const candidate of candidates) {
      expect(() => createD1QueryBudget(candidate, { totalLimit: 50, recoveryReserve: 8 }))
        .toThrow('D1_QUERY_BUDGET_INVALID')
    }
    expect(db.calls).toEqual([])
  })

  it('keeps an exact frozen enumerable view surface and unforgeable sibling provenance', () => {
    const first = createD1QueryBudget(fakeDb(), { totalLimit: 50, recoveryReserve: 8 })
    const second = createD1QueryBudget(fakeDb(), { totalLimit: 50, recoveryReserve: 8 })

    expect(Object.keys(first.work)).toEqual(['prepare', 'batch'])
    expect(Object.keys(first.recovery)).toEqual(['prepare', 'batch'])
    expect(Object.isFrozen(first.work)).toBe(true)
    expect(Object.isFrozen(first.recovery)).toBe(true)
    expect(areSiblingD1QueryBudgetViews(first.work, first.recovery)).toBe(true)
    expect(usageForD1QueryBudgetViews(first.work, first.recovery)).toEqual({
      used: 0,
      remaining: 50,
      workRemaining: 42,
      totalLimit: 50,
      recoveryReserve: 8,
    })
    for (const pair of [
      [first.recovery, first.work],
      [first.work, first.work],
      [first.work, second.recovery],
      [first.work, new Proxy(first.recovery, {})],
      [Object.create(first.work), first.recovery],
      [fakeDb(), first.recovery],
    ]) expect(areSiblingD1QueryBudgetViews(...pair)).toBe(false)
    expect(usageForD1QueryBudgetViews(first.work, second.recovery)).toBeNull()
  })

  it('snapshots one exact dense batch without calling caller methods or rereading it', async () => {
    const db = fakeDb()
    const budget = createD1QueryBudget(db, { totalLimit: 5, recoveryReserve: 1 })
    const statements = [
      budget.work.prepare('SELECT stable_1'),
      budget.work.prepare('SELECT stable_2'),
    ]
    let mapCalls = 0
    Object.defineProperty(statements, 'map', {
      value() { mapCalls += 1; return [] },
      enumerable: false,
    })

    expect(() => budget.work.batch(statements)).toThrow('D1_QUERY_BUDGET_INVALID')
    expect(mapCalls).toBe(0)
    expect(budget.usage().used).toBe(0)
    expect(db.calls).toEqual([])

    await budget.work.batch([
      budget.work.prepare('SELECT exact_1'),
      budget.work.prepare('SELECT exact_2'),
    ])
    expect(db.calls).toEqual([{ method: 'batch', statements: ['SELECT exact_1', 'SELECT exact_2'] }])
    expect(budget.usage().used).toBe(2)
  })

  it.each([
    ['hole', () => new Array(1)],
    ['accessor', () => {
      const value = []
      Object.defineProperty(value, '0', { enumerable: true, get() { throw new Error('item marker') } })
      return value
    }],
    ['extra key', (statement) => Object.assign([statement], { extra: true })],
    ['symbol key', (statement) => Object.assign([statement], { [Symbol('extra')]: true })],
    ['hostile proxy', (statement) => new Proxy([statement], { ownKeys() { throw new Error('batch marker') } })],
  ])('rejects a malformed batch snapshot: %s', (_label, build) => {
    const db = fakeDb()
    const budget = createD1QueryBudget(db, { totalLimit: 5, recoveryReserve: 1 })
    const statement = budget.work.prepare('SELECT member')

    expect(() => budget.work.batch(build(statement))).toThrow('D1_QUERY_BUDGET_INVALID')
    expect(budget.usage().used).toBe(0)
    expect(db.calls).toEqual([])
  })

  it('rejects raw, foreign-budget, proxied, and cross-DB statements before admission', () => {
    const db = fakeDb()
    const budget = createD1QueryBudget(db, { totalLimit: 5, recoveryReserve: 1 })
    const foreign = createD1QueryBudget(fakeDb(), { totalLimit: 5, recoveryReserve: 1 })
    const own = budget.work.prepare('SELECT own')
    const candidates = [
      { bind() {}, run() {}, first() {}, all() {}, raw() {} },
      foreign.work.prepare('SELECT foreign'),
      new Proxy(own, {}),
    ]

    for (const candidate of candidates) {
      expect(() => budget.work.batch([candidate])).toThrow('D1_QUERY_BUDGET_INVALID')
      expect(budget.usage().used).toBe(0)
      expect(db.calls).toEqual([])
    }
  })

  it('captures the raw DB methods once and ignores later replacement', async () => {
    const db = fakeDb()
    const originalPrepare = db.prepare
    const originalBatch = db.batch
    const budget = createD1QueryBudget(db, { totalLimit: 4, recoveryReserve: 1 })
    db.prepare = () => { throw new Error('replacement prepare') }
    db.batch = () => { throw new Error('replacement batch') }

    await budget.work.prepare('SELECT stable').run()
    await budget.work.batch([budget.work.prepare('SELECT batch')])

    expect(db.calls.map((call) => call.method)).toEqual(['run', 'batch'])
    db.prepare = originalPrepare
    db.batch = originalBatch
  })

  it.each([
    null,
    {},
    { prepare() {}, batch: 1 },
    Object.defineProperty({ batch() {} }, 'prepare', { get() { throw new Error('private marker') } }),
  ])('fails closed on malformed or hostile raw DB surface %#', (db) => {
    expect(() => createD1QueryBudget(db, { totalLimit: 50, recoveryReserve: 8 }))
      .toThrow('D1_QUERY_BUDGET_INVALID')
  })

  it('counts only terminal statement methods and preserves their arguments', async () => {
    const db = fakeDb()
    const budget = createD1QueryBudget(db, { totalLimit: 8, recoveryReserve: 1 })
    const prepared = budget.work.prepare('SELECT ?').bind('bound')

    expect(budget.usage()).toEqual({
      used: 0,
      remaining: 8,
      workRemaining: 7,
      totalLimit: 8,
      recoveryReserve: 1,
    })
    await prepared.run()
    await prepared.first('value')
    await prepared.all()
    await prepared.raw({ columnNames: true })

    expect(db.calls).toEqual([
      { method: 'run', sql: 'SELECT ?', bindings: ['bound'] },
      { method: 'first', sql: 'SELECT ?', bindings: ['bound'], column: 'value' },
      { method: 'all', sql: 'SELECT ?', bindings: ['bound'] },
      {
        method: 'raw',
        sql: 'SELECT ?',
        bindings: ['bound'],
        options: { columnNames: true },
      },
    ])
    expect(budget.usage().used).toBe(4)
  })

  it('counts every batch member and delegates the underlying prepared statements', async () => {
    const db = fakeDb()
    const budget = createD1QueryBudget(db, { totalLimit: 5, recoveryReserve: 1 })

    await budget.work.batch([
      budget.work.prepare('SELECT 1'),
      budget.work.prepare('SELECT 2').bind('ignored'),
      budget.recovery.prepare('SELECT 3'),
    ])

    expect(db.calls).toEqual([{
      method: 'batch',
      statements: ['SELECT 1', 'SELECT 2', 'SELECT 3'],
    }])
    expect(budget.usage().used).toBe(3)
  })

  it('preflights a whole batch without spending or delegating when it does not fit', async () => {
    const db = fakeDb()
    const budget = createD1QueryBudget(db, { totalLimit: 5, recoveryReserve: 2 })
    await budget.work.prepare('SELECT 1').run()
    await budget.work.prepare('SELECT 2').run()

    expect(() => budget.work.batch([
      budget.work.prepare('SELECT 3'),
      budget.work.prepare('SELECT 4'),
    ])).toThrow(D1_QUERY_BUDGET_EXCEEDED)
    expect(budget.usage().used).toBe(2)
    expect(db.calls.map((call) => call.method)).toEqual(['run', 'run'])
  })

  it('counts delegated queries even when D1 rejects them', async () => {
    const db = fakeDb()
    db.prepare = (sql) => ({
      bind() { return this },
      run() {
        db.calls.push({ method: 'run', sql })
        return Promise.reject(new Error('D1_UNAVAILABLE'))
      },
      first() { return Promise.resolve(null) },
      all() { return Promise.resolve({ results: [] }) },
      raw() { return Promise.resolve([]) },
    })
    const budget = createD1QueryBudget(db, { totalLimit: 3, recoveryReserve: 1 })

    const attempt = budget.work.prepare('SELECT failure').run()
    expect(budget.usage().used).toBe(1)
    await expect(attempt).rejects.toThrow('D1_UNAVAILABLE')
    expect(budget.usage().used).toBe(1)
  })

  it('admits concurrent calls synchronously before their promises settle', async () => {
    const db = fakeDb()
    let settle
    const pending = new Promise((resolve) => { settle = resolve })
    db.prepare = (sql) => ({
      bind() { return this },
      run() {
        db.calls.push({ method: 'run', sql })
        return pending
      },
      first() { return pending },
      all() { return pending },
      raw() { return pending },
    })
    const budget = createD1QueryBudget(db, { totalLimit: 3, recoveryReserve: 1 })

    const first = budget.work.prepare('SELECT first').run()
    const second = budget.work.prepare('SELECT second').run()
    expect(() => budget.work.prepare('SELECT blocked').run())
      .toThrow(D1_QUERY_BUDGET_EXCEEDED)
    expect(db.calls).toHaveLength(2)
    expect(budget.usage().used).toBe(2)

    settle({ success: true })
    await Promise.all([first, second])
  })

  it('reserves capacity from normal work while recovery may use the total cap', async () => {
    const db = fakeDb()
    const budget = createD1QueryBudget(db, { totalLimit: 5, recoveryReserve: 2 })

    await budget.work.prepare('SELECT work_1').run()
    await budget.work.prepare('SELECT work_2').run()
    await budget.work.prepare('SELECT work_3').run()
    expect(() => budget.work.prepare('SELECT work_blocked').run())
      .toThrow(D1_QUERY_BUDGET_EXCEEDED)

    await budget.recovery.prepare('SELECT recovery_1').run()
    await budget.recovery.prepare('SELECT recovery_2').run()
    expect(() => budget.recovery.prepare('SELECT recovery_blocked').run())
      .toThrow(D1_QUERY_BUDGET_EXCEEDED)
    expect(budget.usage()).toEqual({
      used: 5,
      remaining: 0,
      workRemaining: 0,
      totalLimit: 5,
      recoveryReserve: 2,
    })
  })

  it('throws one fixed non-sensitive error without delegating over-budget work', async () => {
    const db = fakeDb()
    const budget = createD1QueryBudget(db, { totalLimit: 2, recoveryReserve: 1 })
    await budget.work.prepare('SELECT secret_payload').run()

    let error
    try {
      budget.work.prepare('SELECT another_secret').run()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('D1_QUERY_BUDGET_EXCEEDED')
    expect(error.message).not.toContain('secret')
    expect(db.calls).toHaveLength(1)
  })
})
