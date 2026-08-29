import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createFinanceReadModel,
  financeMonthView,
  warsawMonthKey,
} from '../../src/finance-reporting.js'

const entry = (id, patch = {}) => ({
  id,
  state: 'active',
  accountingMonth: '2026-06',
  kind: 'income',
  revenueGrosze: 18_000,
  receivableGrosze: 18_000,
  collectedGrosze: 18_000,
  expenseGrosze: 0,
  specialistId: 'sp_anna',
  serviceId: 'zajecia',
  program: null,
  paymentMethod: 'card',
  invoiceStatus: 'issued',
  ...patch,
})

const model = (patch = {}) => {
  const ledgerEntries = patch.ledgerEntries ?? []
  const paymentEvents = Object.hasOwn(patch, 'paymentEvents')
    ? patch.paymentEvents
    : ledgerEntries.filter(({ collectedGrosze }) => collectedGrosze > 0).map((value) => ({
      id: `pay_${value.id.slice(4)}`,
      ledgerId: value.id,
      amountGrosze: value.collectedGrosze,
      method: value.paymentMethod,
    }))
  return createFinanceReadModel({
  ledgerEntries,
  paymentEvents,
  occurrenceLinks: [],
  activityLinks: [],
  selectedMonth: '2026-06',
  trendMonths: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'],
  specialistId: null,
  ...patch,
  ledgerEntries,
  paymentEvents,
  })
}

test('computes canonical integer-grosze KPIs once when several facts share one ledger row', () => {
  const result = model({
    ledgerEntries: [
      entry('fin_visit', { collectedGrosze: 12_000 }),
      entry('fin_tus', {
        revenueGrosze: 34_000, receivableGrosze: 34_000, collectedGrosze: 0,
        specialistId: null, serviceId: null, program: 'tus', paymentMethod: 'unknown',
        invoiceStatus: 'not_required',
      }),
      entry('fin_expense', {
        kind: 'expense', revenueGrosze: 0, receivableGrosze: 0, collectedGrosze: 0,
        expenseGrosze: 9_500, specialistId: null, serviceId: null,
        paymentMethod: 'transfer', invoiceStatus: 'issued',
      }),
    ],
    occurrenceLinks: [
      { id: 'hoc_one', ledgerId: 'fin_visit', periodPrecision: 'day', hasTime: false, amountGrosze: 999_999 },
      { id: 'hoc_two', ledgerId: 'fin_visit', periodPrecision: 'day', hasTime: true, amountGrosze: 1 },
    ],
    activityLinks: [
      { id: 'ach_one', ledgerId: 'fin_visit', program: 'english', count: 3, amountGrosze: 777_777 },
      { id: 'ach_two', ledgerId: 'fin_tus', program: 'tus', count: 1, amountGrosze: 888_888 },
    ],
  })

  assert.deepEqual(result.kpis, {
    revenueGrosze: 52_000,
    collectedGrosze: 12_000,
    outstandingGrosze: 40_000,
    expensesGrosze: 9_500,
    incomeGrosze: 42_500,
  })
  assert.equal(result.rows.length, 3)
  assert.deepEqual(result.contextsByLedgerId.fin_visit.map(({ id }) => id), [
    'hoc_one', 'hoc_two', 'ach_one',
  ])
})

test('ignores fact-side amounts and reconciles canonical reporting splits', () => {
  const ledgerEntries = [
    entry('fin_anna_card'),
    entry('fin_unknown_cash', {
      revenueGrosze: 20_000, receivableGrosze: 20_000, collectedGrosze: 5_000,
      specialistId: null, serviceId: null, program: 'english', paymentMethod: 'cash',
      invoiceStatus: 'action_required',
    }),
    entry('fin_tus_unpaid', {
      revenueGrosze: 34_000, receivableGrosze: 34_000, collectedGrosze: 0,
      specialistId: 'sp_julia', serviceId: null, program: 'tus', paymentMethod: 'unknown',
      invoiceStatus: 'not_required',
    }),
  ]
  const first = model({
    ledgerEntries,
    activityLinks: [{ id: 'ach_english', ledgerId: 'fin_unknown_cash', program: 'english', count: 4, amountGrosze: 1 }],
  })
  const second = model({
    ledgerEntries,
    activityLinks: [{ id: 'ach_english', ledgerId: 'fin_unknown_cash', program: 'english', count: 4, amountGrosze: 99_999_999 }],
  })

  assert.deepEqual(first.kpis, second.kpis)
  assert.deepEqual(first.splits.specialist, {
    'Nie ustalono': 20_000,
    sp_anna: 18_000,
    sp_julia: 34_000,
  })
  assert.deepEqual(first.splits.service, { 'Nie ustalono': 54_000, zajecia: 18_000 })
  assert.deepEqual(first.splits.payment, {
    card: 18_000,
    cash: 5_000,
    outstanding: 49_000,
  })
  assert.deepEqual(first.splits.invoice, {
    action_required: { count: 1, revenueGrosze: 20_000 },
    issued: { count: 1, revenueGrosze: 18_000 },
    not_required: { count: 1, revenueGrosze: 34_000 },
  })
  assert.deepEqual(first.splits.program, {
    english: { count: 4, revenueGrosze: 20_000 },
    tus: { count: 0, revenueGrosze: 34_000 },
  })
})

test('derives payment-method splits from canonical payment events and rejects drift', () => {
  const ledgerEntries = [entry('fin_mixed', { collectedGrosze: 12_000 })]
  const result = model({
    ledgerEntries,
    paymentEvents: [
      { id: 'pay_card', ledgerId: 'fin_mixed', amountGrosze: 7_000, method: 'card' },
      { id: 'pay_cash', ledgerId: 'fin_mixed', amountGrosze: 5_000, method: 'cash' },
    ],
  })

  assert.deepEqual(result.splits.payment, {
    card: 7_000,
    cash: 5_000,
    outstanding: 6_000,
  })
  assert.throws(() => model({
    ledgerEntries,
    paymentEvents: [
      { id: 'pay_wrong', ledgerId: 'fin_mixed', amountGrosze: 11_999, method: 'card' },
    ],
  }), /FINANCE_REPORT_INVALID/)
})

test('excludes void and unknown-period money from months and scoped latest month', () => {
  const result = model({
    ledgerEntries: [
      entry('fin_old', { accountingMonth: '2026-03' }),
      entry('fin_void', { accountingMonth: '2026-07', state: 'void', revenueGrosze: 90_000, receivableGrosze: 90_000, collectedGrosze: 90_000 }),
      entry('fin_unknown', { accountingMonth: null, revenueGrosze: 25_000, receivableGrosze: 25_000, collectedGrosze: 25_000 }),
      entry('fin_other', { accountingMonth: '2026-06', specialistId: 'sp_julia' }),
    ],
    specialistId: 'sp_anna',
  })

  assert.deepEqual(result.kpis, {
    revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0,
    expensesGrosze: 0, incomeGrosze: 0,
  })
  assert.equal(result.latestPopulatedMonth, '2026-03')
  assert.deepEqual(result.unknownPeriod.map(({ id }) => id), ['fin_unknown'])
  assert.deepEqual(result.voidEntries.map(({ id }) => id), ['fin_void'])
})

test('clamps unsafe future months and exposes latest only for an empty current month', () => {
  assert.equal(warsawMonthKey(new Date('2026-12-31T23:30:00.000Z')), '2027-01')
  assert.deepEqual(financeMonthView({
    requestedMonth: '2027-02', savedMonth: '2026-11', currentMonth: '2026-12',
    selectedMonth: '2026-12', selectedRowCount: 0, latestPopulatedMonth: '2026-09',
  }), {
    initialMonth: '2026-12',
    emptyCopy: 'Brak danych w bieżącym miesiącu',
    latestPopulatedMonth: '2026-09',
  })
  assert.deepEqual(financeMonthView({
    requestedMonth: '2026-08', savedMonth: '2026-07', currentMonth: '2026-12',
    selectedMonth: '2026-08', selectedRowCount: 0, latestPopulatedMonth: '2026-09',
  }), {
    initialMonth: '2026-08',
    emptyCopy: 'Brak danych w wybranym miesiącu',
    latestPopulatedMonth: null,
  })
})

test('clamps FinanceWindow navigation before its six-month reporting floor', () => {
  assert.equal(financeMonthView({
    requestedMonth: '2000-05', savedMonth: '2000-04', currentMonth: '2026-12',
    selectedMonth: '2026-12', selectedRowCount: 0, latestPopulatedMonth: null,
  }).initialMonth, '2026-12')
  assert.equal(financeMonthView({
    requestedMonth: '2000-06', savedMonth: null, currentMonth: '2026-12',
    selectedMonth: '2000-06', selectedRowCount: 0, latestPopulatedMonth: null,
  }).initialMonth, '2000-06')
})

test('zero-fills exactly the supplied six-month window in chronological order', () => {
  const result = model({
    ledgerEntries: [
      entry('fin_feb', { accountingMonth: '2026-02', revenueGrosze: 11_000, receivableGrosze: 11_000, collectedGrosze: 4_000 }),
      entry('fin_jun_expense', { kind: 'expense', revenueGrosze: 0, receivableGrosze: 0, collectedGrosze: 0, expenseGrosze: 3_000 }),
    ],
  })

  assert.deepEqual(result.trend, [
    { month: '2026-01', revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0, expensesGrosze: 0, incomeGrosze: 0 },
    { month: '2026-02', revenueGrosze: 11_000, collectedGrosze: 4_000, outstandingGrosze: 7_000, expensesGrosze: 0, incomeGrosze: 11_000 },
    { month: '2026-03', revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0, expensesGrosze: 0, incomeGrosze: 0 },
    { month: '2026-04', revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0, expensesGrosze: 0, incomeGrosze: 0 },
    { month: '2026-05', revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0, expensesGrosze: 0, incomeGrosze: 0 },
    { month: '2026-06', revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0, expensesGrosze: 3_000, incomeGrosze: -3_000 },
  ])
})

test('fails closed on duplicate ledger authority, dangling facts, invalid money and malformed windows', () => {
  assert.throws(() => model({ ledgerEntries: [entry('fin_dup'), entry('fin_dup')] }), /FINANCE_REPORT_INVALID/)
  assert.throws(() => model({ occurrenceLinks: [{ id: 'hoc_dangling', ledgerId: 'fin_missing', periodPrecision: 'day', hasTime: true }] }), /FINANCE_REPORT_INVALID/)
  assert.throws(() => model({ ledgerEntries: [entry('fin_float', { revenueGrosze: 1.5 })] }), /FINANCE_REPORT_INVALID/)
  assert.throws(() => model({
    ledgerEntries: [
      entry('fin_overflow_one', {
        revenueGrosze: Number.MAX_SAFE_INTEGER,
        receivableGrosze: Number.MAX_SAFE_INTEGER,
        collectedGrosze: 0,
      }),
      entry('fin_overflow_two', {
        revenueGrosze: Number.MAX_SAFE_INTEGER,
        receivableGrosze: Number.MAX_SAFE_INTEGER,
        collectedGrosze: 0,
      }),
    ],
  }), /FINANCE_REPORT_INVALID/)
  assert.throws(() => model({
    ledgerEntries: [entry('fin_missing_event')], paymentEvents: [],
  }), /FINANCE_REPORT_INVALID/)
  assert.throws(() => model({ trendMonths: ['2026-01'] }), /FINANCE_REPORT_INVALID/)
  assert.throws(() => model({
    trendMonths: ['2025-12', '2026-01', '2026-03', '2026-04', '2026-05', '2026-06'],
  }), /FINANCE_REPORT_INVALID/)
  assert.throws(() => model({ selectedMonth: '2026-13' }), /FINANCE_REPORT_INVALID/)
  assert.throws(() => model({
    selectedMonth: '0099-06',
    trendMonths: ['0099-01', '0099-02', '0099-03', '0099-04', '0099-05', '0099-06'],
  }), /FINANCE_REPORT_INVALID/)
  assert.throws(() => model({
    ledgerEntries: [entry('fin_link')],
    activityLinks: [{ id: 'ach_bad', ledgerId: 'fin_link', program: 'tus', count: -1 }],
  }), /FINANCE_REPORT_INVALID/)
  assert.throws(() => model({
    ledgerEntries: [entry('fin_link')],
    occurrenceLinks: [{ id: 'hoc_bad', ledgerId: 'fin_link', periodPrecision: 'invented', hasTime: false }],
  }), /FINANCE_REPORT_INVALID/)
})

test('omits context keys for ledger rows outside specialist scope', () => {
  const result = model({
    ledgerEntries: [
      entry('fin_visible'),
      entry('fin_hidden', { specialistId: 'sp_julia' }),
    ],
    occurrenceLinks: [
      { id: 'hoc_visible', ledgerId: 'fin_visible', periodPrecision: 'day', hasTime: true },
      { id: 'hoc_hidden', ledgerId: 'fin_hidden', periodPrecision: 'day', hasTime: true },
    ],
    specialistId: 'sp_anna',
  })

  assert.deepEqual(Object.keys(result.contextsByLedgerId), ['fin_visible'])
})
