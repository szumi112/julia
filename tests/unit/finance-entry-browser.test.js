import test from 'node:test'
import assert from 'node:assert/strict'
import * as commands from '../../src/finance-entry-browser.js'

const entry = { kind: 'expense', recordType: 'expense', accountingMonth: '2026-09',
  occurredOn: '2026-09-05', amountGrosze: 20000, paidAmountGrosze: 0,
  paymentMethod: 'unknown', settlementStatus: 'unknown', invoiceStatus: 'not_required',
  counterparty: 'Fikcyjny dostawca', sourceLabel: 'Materiały', invoiceNote: '',
  specialistId: null, lessonCount: null, source: null }
const adjustment = { expectedVersion: 2, reason: 'Potwierdzenie wpłaty', accountingMonth: '2026-09',
  paidAmountGrosze: 20000, paymentMethod: 'transfer', settlementStatus: 'paid', invoiceStatus: 'issued' }

test('ordinary creation rejects imported/activity records and unassigned months before sending', () => {
  assert.equal(typeof commands.captureCreateFinanceEntry, 'function')
  assert.deepEqual(commands.captureCreateFinanceEntry(entry), entry)
  assert.throws(() => commands.captureCreateFinanceEntry({ ...entry, accountingMonth: null }))
  assert.throws(() => commands.captureCreateFinanceEntry({ ...entry, accountingMonth: '2000-05' }))
  assert.throws(() => commands.captureCreateFinanceEntry({ ...entry, kind: 'income', recordType: 'tus' }))
})

test('detail validates settlement totals, exact entry binding and newest-first bounded correction history', () => {
  const { invoiceNote, specialistId, lessonCount, source, ...fields } = entry
  const detail = { entry: { id: 'fin_test', version: 3, ...fields, appointmentId: null },
    adjustments: [], historyTruncated: false }
  assert.deepEqual(commands.captureFinanceEntryDetail(detail, 'fin_test'), detail)
  assert.throws(() => commands.captureFinanceEntryDetail(detail, 'fin_other'))
  assert.throws(() => commands.captureFinanceEntryDetail({ ...detail, entry: {
    ...detail.entry, settlementStatus: 'paid', paidAmountGrosze: 19999,
  } }, 'fin_test'))
  const snapshot = { accountingMonth: '2026-09', paidAmountGrosze: 0,
    paymentMethod: 'unknown', settlementStatus: 'unknown', invoiceStatus: 'unknown' }
  const older = { id: 'fadj_old', createdAt: '2026-09-01T10:00:00.000Z', reason: 'Korekta wpisu', before: snapshot, after: snapshot }
  const newer = { ...older, id: 'fadj_new', createdAt: '2026-09-02T10:00:00.000Z' }
  assert.throws(() => commands.captureFinanceEntryDetail({ ...detail, adjustments: [older, newer] }, 'fin_test'))
  assert.throws(() => commands.captureFinanceEntryDetail({ ...detail, historyTruncated: true }, 'fin_test'))
  assert.deepEqual(commands.captureFinanceEntryDetail({ ...detail, adjustments: [newer, older] }, 'fin_test').adjustments,
    [newer, older])
})

test('adjustments capture exact explicit settlement, invoice and month decisions without invoking getters', () => {
  assert.equal(typeof commands.captureFinanceAdjustment, 'function')
  assert.deepEqual(commands.captureFinanceAdjustment(adjustment), adjustment)
  assert.throws(() => commands.captureFinanceAdjustment({ ...adjustment, reason: '' }))
  assert.throws(() => commands.captureFinanceAdjustment({ ...adjustment, settlementStatus: 'unknown' }))
  assert.throws(() => commands.captureFinanceAdjustment({ ...adjustment, expectedVersion: Number.MAX_SAFE_INTEGER }))
  let read = 0
  assert.throws(() => commands.captureFinanceAdjustment({ ...adjustment, get reason() { read++; return 'Reason' } }))
  assert.equal(read, 0)
})

test('activity billing captures an explicit monthly charge and rejects mismatched membership and settlement', () => {
  const input = { participantId: 'acp_test', groupId: 'agr_test', membershipId: 'amb_test',
    responsibleSpecialistId: 'sp_test', accountingMonth: '2026-09', amountGrosze: 34000,
    lessonCount: null, paidAmountGrosze: 0, paymentMethod: 'unknown', settlementStatus: 'unpaid',
    invoiceStatus: 'not_required' }
  assert.equal(typeof commands.captureCreateActivityCharge, 'function')
  assert.deepEqual(commands.captureCreateActivityCharge(input), input)
  assert.throws(() => commands.captureCreateActivityCharge({ ...input, membershipId: null }))
  assert.throws(() => commands.captureCreateActivityCharge({ ...input, settlementStatus: 'paid' }))
  assert.throws(() => commands.captureCreateActivityCharge({ ...input, lessonCount: 3 }))
  const english = { ...input, groupId: null, membershipId: null, lessonCount: 0,
    amountGrosze: 0, settlementStatus: 'paid' }
  assert.deepEqual(commands.captureCreateActivityCharge(english), english)
})
