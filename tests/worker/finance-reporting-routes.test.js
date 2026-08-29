import { describe, expect, it, vi } from 'vitest'

import {
  getFinanceWindow,
  postFinanceEntryVoid,
} from '../../worker/routes/finance-reporting.js'
import { authorityActor } from './fixtures.js'

const OWNER = authorityActor({ id: 'stf_finance_reporting_route', role: 'owner' })

describe('finance reporting route adapters', () => {
  it('accepts only one canonical month query and delegates exact server authority', async () => {
    const load = vi.fn(async (input) => ({ data: { selectedMonth: input.selectedMonth } }))
    const db = { prepare: vi.fn() }
    const result = await getFinanceWindow({
      db, actor: OWNER, keyring: {}, nowMs: 1_800_000_000_000,
      url: 'https://panel.example/api/v1/finance/window?month=2027-01', load,
    })
    expect(result).toEqual({ data: { selectedMonth: '2027-01' } })
    expect(load).toHaveBeenCalledWith({
      db, actor: OWNER, keyring: {}, nowMs: 1_800_000_000_000, selectedMonth: '2027-01',
    })
    await expect(getFinanceWindow({
      db, actor: OWNER, keyring: {}, nowMs: 1_800_000_000_000,
      url: 'https://panel.example/api/v1/finance/window?month=2027-01&scope=centre', load,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(getFinanceWindow({
      db, actor: OWNER, keyring: {}, nowMs: 1_800_000_000_000,
      url: 'https://panel.example/api/v1/finance/window?month=2000-05',
      load: async () => { throw new Error('VALIDATION_FAILED/selectedMonth') },
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', details: { field: 'month' },
    })
  })

  it('captures the exact optimistic void body and idempotency authority', async () => {
    const service = vi.fn(async () => ({ status: 200, body: { data: { state: 'void' } } }))
    const input = {
      db: { prepare: vi.fn(), batch: vi.fn() }, actor: OWNER, keyring: {},
      nowMs: 1_800_000_000_000, correlationId: 'corr_finance_reporting_route',
      idFactory: () => 'route', entryId: 'fin_finance_reporting_route',
      body: { expectedVersion: 2, reason: 'Fikcyjna korekta księgowania.' },
      idempotencyKey: 'finance-route-void-1', service,
    }
    expect(await postFinanceEntryVoid(input)).toEqual({
      status: 200, body: { data: { state: 'void' } },
    })
    expect(service).toHaveBeenCalledWith({
      db: input.db, actor: OWNER, keyring: {}, nowMs: input.nowMs,
      correlationId: input.correlationId, idFactory: input.idFactory,
      entryId: input.entryId, expectedVersion: 2,
      reason: 'Fikcyjna korekta księgowania.', idempotencyKey: input.idempotencyKey,
    })
    await expect(postFinanceEntryVoid({
      ...input, body: { expectedVersion: 2, reason: 'x', extra: true },
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(postFinanceEntryVoid({
      ...input,
      service: async () => { throw new Error('VALIDATION_FAILED/financeVoid') },
      body: { expectedVersion: 0, reason: 'x' },
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', details: { field: 'body' },
    })
  })
})
