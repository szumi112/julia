import assert from 'node:assert/strict'
import test from 'node:test'
import {
  financeEntryDto,
  financeMonthSummary,
  financeSourceKey,
  validateFinanceEntryInput,
  validateFinanceImport,
} from '../../src/finance-records.js'

const source = Object.freeze({
  batchId: 'fib_import_one',
  sourceKey: 'source.xlsx:Wrzesień:2:0123456789abcdef',
  sheet: 'Wrzesień',
  rowNumber: 2,
  raw: Object.freeze({ Cena: 180, Klient: 'Klient Testowy' }),
})

const entry = (patch = {}) => ({
  kind: 'income',
  recordType: 'income',
  accountingMonth: '2025-09',
  occurredOn: '2025-09-08',
  amountGrosze: 18000,
  paidAmountGrosze: 18000,
  paymentMethod: 'card',
  settlementStatus: 'paid',
  invoiceStatus: 'issued',
  counterparty: 'Klient Testowy',
  sourceLabel: 'Konsultacja psychologiczna',
  invoiceNote: 'Wystawiona',
  specialistId: null,
  lessonCount: null,
  source,
  ...patch,
})

test('validates and freezes exact import metadata', () => {
  const value = validateFinanceImport({
    filename: 'Przychody 2024_2025_2026.xlsx',
    fingerprint: 'a'.repeat(64),
    formatVersion: 1,
    totalRows: 2232,
  })
  assert.deepEqual(value, {
    filename: 'Przychody 2024_2025_2026.xlsx',
    fingerprint: 'a'.repeat(64),
    formatVersion: 1,
    totalRows: 2232,
  })
  assert.equal(Object.isFrozen(value), true)
  assert.throws(() => validateFinanceImport({
    filename: '../source.xlsx',
    fingerprint: 'a'.repeat(64),
    formatVersion: 1,
    totalRows: 2232,
  }), /VALIDATION_FAILED\/filename/)
  assert.throws(() => validateFinanceImport({
    filename: 'source.xlsx',
    fingerprint: 'A'.repeat(64),
    formatVersion: 1,
    totalRows: 2232,
  }), /VALIDATION_FAILED\/fingerprint/)
})

test('accepts complete income and preserves an explicit unknown period', () => {
  const complete = validateFinanceEntryInput(entry())
  assert.deepEqual(complete, entry())
  assert.equal(Object.isFrozen(complete), true)
  assert.equal(Object.isFrozen(complete.source), true)
  assert.equal(Object.isFrozen(complete.source.raw), true)

  const unknownPeriod = validateFinanceEntryInput(entry({
    accountingMonth: null,
    occurredOn: null,
    paidAmountGrosze: 0,
    paymentMethod: 'unknown',
    settlementStatus: 'unknown',
    invoiceStatus: 'unknown',
  }))
  assert.equal(unknownPeriod.accountingMonth, null)
  assert.equal(unknownPeriod.occurredOn, null)
})

test('accepts zero-value English months but requires positive finance amounts', () => {
  assert.deepEqual(validateFinanceEntryInput(entry({
    amountGrosze: 0,
    paidAmountGrosze: 0,
    recordType: 'english',
    settlementStatus: 'unknown',
    lessonCount: 0,
  })).lessonCount, 0)
  assert.throws(() => validateFinanceEntryInput(entry({
    amountGrosze: 0,
    paidAmountGrosze: 0,
  })), /VALIDATION_FAILED\/amountGrosze/)
})

test('enforces kind, settlement, and activity relationships', () => {
  for (const invalid of [
    entry({ kind: 'expense', recordType: 'income' }),
    entry({ paidAmountGrosze: 17000, settlementStatus: 'paid' }),
    entry({ paidAmountGrosze: 0, settlementStatus: 'partial' }),
    entry({ paidAmountGrosze: 18000, settlementStatus: 'unpaid' }),
    entry({ lessonCount: 4 }),
    entry({ recordType: 'english', lessonCount: null }),
    entry({ accountingMonth: '2025-13' }),
    entry({ occurredOn: '2025-02-30' }),
  ]) assert.throws(() => validateFinanceEntryInput(invalid), /VALIDATION_FAILED/)
})

test('rejects extra keys, unsafe source objects, and malformed identifiers', () => {
  assert.throws(() => validateFinanceEntryInput({ ...entry(), extra: true }), /VALIDATION_FAILED\/body/)
  assert.throws(() => validateFinanceEntryInput(entry({
    source: { ...source, raw: { __proto__: { polluted: true } } },
  })), /VALIDATION_FAILED\/source/)
  assert.throws(() => validateFinanceEntryInput(entry({ specialistId: 'specialist-one' })), /VALIDATION_FAILED\/specialistId/)
})

test('builds stable source keys without accepting path or separator ambiguity', () => {
  assert.equal(financeSourceKey({
    fingerprint: 'b'.repeat(64),
    sheet: 'Wrzesień',
    rowNumber: 12,
    block: 3,
  }), `${'b'.repeat(64)}:Wrzesień:12:3`)
  assert.throws(() => financeSourceKey({
    fingerprint: 'b'.repeat(64), sheet: 'Bad:Sheet', rowNumber: 12, block: null,
  }), /VALIDATION_FAILED\/sourceKey/)
})

test('validates the exact persisted DTO and deeply freezes source data', () => {
  const dto = financeEntryDto({
    id: 'fin_entry_one',
    ...entry(),
    appointmentId: null,
    version: 1,
    createdByStaffId: 'stf_owner_one',
    createdAt: '2026-08-27T10:00:00.000Z',
    updatedAt: '2026-08-27T10:00:00.000Z',
  })
  assert.equal(dto.id, 'fin_entry_one')
  assert.equal(Object.isFrozen(dto), true)
  assert.equal(Object.isFrozen(dto.source.raw), true)
  assert.throws(() => financeEntryDto({ ...dto, version: 0 }), /VALIDATION_FAILED\/version/)
})

test('summarizes one month without double-counting unknown periods', () => {
  const entries = [
    entry(),
    entry({
      amountGrosze: 30000,
      paidAmountGrosze: 0,
      paymentMethod: 'transfer',
      settlementStatus: 'unpaid',
      invoiceStatus: 'action_required',
      sourceLabel: 'Warsztaty',
    }),
    entry({
      kind: 'expense',
      recordType: 'expense',
      amountGrosze: 220000,
      paidAmountGrosze: 220000,
      paymentMethod: 'transfer',
      settlementStatus: 'paid',
      invoiceStatus: 'not_required',
      counterparty: '',
      sourceLabel: 'Wynajem',
    }),
    entry({ accountingMonth: null, occurredOn: null }),
  ].map(validateFinanceEntryInput)

  assert.deepEqual(financeMonthSummary(entries, '2025-09'), {
    month: '2025-09',
    revenueGrosze: 48000,
    expensesGrosze: 220000,
    balanceGrosze: -172000,
    collectedGrosze: 18000,
    outstandingGrosze: 30000,
    invoiceActionCount: 1,
    entryCount: 3,
  })
  assert.deepEqual(financeMonthSummary(entries, null), {
    month: null,
    revenueGrosze: 18000,
    expensesGrosze: 0,
    balanceGrosze: 18000,
    collectedGrosze: 18000,
    outstandingGrosze: 0,
    invoiceActionCount: 0,
    entryCount: 1,
  })
})
