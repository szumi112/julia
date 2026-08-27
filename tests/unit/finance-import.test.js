import assert from 'node:assert/strict'
import test from 'node:test'
import {
  financeImportChunks,
  financeImportEntry,
} from '../../src/finance-import.js'

const sourceRow = (patch = {}) => ({
  sourceKey: 'fictional.xlsx:Wrzesień:2:abcdef0123456789',
  sheet: 'Wrzesień',
  rowNumber: 2,
  recordType: 'income',
  accountingMonth: '2025-09',
  occurredOn: '2025-09-08',
  amountGrosze: 18_000,
  counterparty: 'Fikcyjna Klientka',
  sourceLabel: 'Konsultacja fikcyjna',
  paymentMethod: 'card',
  settlementStatus: 'paid',
  invoiceStatus: 'issued',
  invoiceNote: 'Fikcyjna faktura',
  specialistName: 'Anna Testowa',
  lessonCount: null,
  raw: { Cena: 180 },
  ...patch,
})

test('maps a workbook row to the exact protected finance input without losing its source', () => {
  assert.deepEqual(financeImportEntry(sourceRow(), 'fib_one', [
    { id: 'sp_anna', name: 'Anna Testowa' },
  ]), {
    kind: 'income', recordType: 'income', accountingMonth: '2025-09',
    occurredOn: '2025-09-08', amountGrosze: 18_000, paidAmountGrosze: 18_000,
    paymentMethod: 'card', settlementStatus: 'paid', invoiceStatus: 'issued',
    counterparty: 'Fikcyjna Klientka', sourceLabel: 'Konsultacja fikcyjna',
    invoiceNote: 'Fikcyjna faktura', specialistId: 'sp_anna', lessonCount: null,
    source: {
      batchId: 'fib_one', sourceKey: 'fictional.xlsx:Wrzesień:2:abcdef0123456789',
      sheet: 'Wrzesień', rowNumber: 2, raw: { Cena: 180 },
    },
  })
})

test('does not invent a paid amount for an ambiguous partial workbook row', () => {
  const mapped = financeImportEntry(sourceRow({ settlementStatus: 'partial' }), 'fib_one', [])
  assert.equal(mapped.settlementStatus, 'unknown')
  assert.equal(mapped.paidAmountGrosze, 0)
})

test('maps costs to expenses and splits rows into bounded stable chunks', () => {
  const rows = Array.from({ length: 41 }, (_, index) => sourceRow({
    sourceKey: `fictional.xlsx:Koszty:${index + 2}:abcdef0123456789`,
    rowNumber: index + 2,
    recordType: 'expense',
    specialistName: null,
  }))
  const chunks = financeImportChunks(rows, 'fib_one', [], 20)
  assert.deepEqual(chunks.map(({ sequence, entries }) => [sequence, entries.length]), [
    [0, 20], [1, 20], [2, 1],
  ])
  assert.equal(chunks[0].entries[0].kind, 'expense')
  assert.equal(chunks[0].entries[0].specialistId, null)
  assert.equal(Object.isFrozen(chunks), true)
})
