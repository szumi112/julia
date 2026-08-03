import { describe, expect, it } from 'vitest'
import {
  D1_QUERY_BUDGET_EXCEEDED,
  createD1QueryBudget,
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
