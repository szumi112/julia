import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityChargeCommand, financeEntryDraft, financeEntryCommand } from '../../src/finance-entry-form.js'

const entry = { id: 'fin_test', version: 2, kind: 'income', recordType: 'income',
  accountingMonth: null, occurredOn: null, amountGrosze: 12345, paidAmountGrosze: 0,
  paymentMethod: 'unknown', settlementStatus: 'unknown', invoiceStatus: 'unknown' }

test('manual income uses exact cents and carries no source or activity classification', () => {
  const draft = { ...financeEntryDraft(null, '2026-08'), sourceLabel: '  Materiały  ',
    amount: '123,45', paidAmount: '23,45', settlementStatus: 'partial', paymentMethod: 'cash' }
  assert.deepEqual(financeEntryCommand(draft, null, '2026-09'), {
    kind: 'income', recordType: 'income', accountingMonth: '2026-08', occurredOn: null,
    amountGrosze: 12345, paidAmountGrosze: 2345, settlementStatus: 'partial', paymentMethod: 'cash',
    invoiceStatus: 'not_required', counterparty: '', sourceLabel: 'Materiały', invoiceNote: '',
    specialistId: null, lessonCount: null, source: null,
  })
})

test('manual entries reject fractional cents, overpayments and hidden accounting months', () => {
  const draft = { ...financeEntryDraft(null, '2026-08'), sourceLabel: 'Usługa', amount: '10', paidAmount: '0' }
  for (const patch of [{ amount: '10.001' }, { paidAmount: '11' },
    { accountingMonth: '2000-05' }, { accountingMonth: '2026-10' }, { accountingMonth: '' }]) {
    assert.throws(() => financeEntryCommand({ ...draft, ...patch }, null, '2026-09'))
  }
})

test('pasted invisible controls are rejected before an entry command is cached for retry', () => {
  const draft = { ...financeEntryDraft(null, '2026-08'), sourceLabel: 'Opłata', amount: '10' }
  for (const field of ['counterparty', 'sourceLabel']) {
    assert.throws(() => financeEntryCommand({ ...draft, [field]: 'Opłata\u200b za zajęcia' }, null, '2026-09'), /niewidoczne/)
  }
  assert.throws(() => financeEntryCommand({ ...financeEntryDraft(entry), reason: 'Wpłata\u200b potwierdzona' }, entry, '2026-09'), /niewidoczne/)
})

test('adjustment preserves unknown income period and requires a reason and coherent payment state', () => {
  const draft = { ...financeEntryDraft(entry), paidAmount: '123,45', settlementStatus: 'paid',
    paymentMethod: 'transfer', invoiceStatus: 'issued', reason: 'Potwierdzono przelew' }
  assert.deepEqual(financeEntryCommand(draft, entry, '2026-09'), {
    expectedVersion: 2, accountingMonth: null, paidAmountGrosze: 12345,
    settlementStatus: 'paid', paymentMethod: 'transfer', invoiceStatus: 'issued', reason: 'Potwierdzono przelew',
  })
  assert.throws(() => financeEntryCommand({ ...draft, reason: '' }, entry, '2026-09'))
  assert.throws(() => financeEntryCommand({ ...draft, paidAmount: '1' }, entry, '2026-09'))
  assert.throws(() => financeEntryCommand({ ...draft, accountingMonth: '2026-08' }, entry, '2026-09'))
})

test('expense adjustment assigns an unknown period without changing the original amount', () => {
  const expense = { ...entry, kind: 'expense', recordType: 'expense' }
  const draft = { ...financeEntryDraft(expense), accountingMonth: '2026-08', reason: 'Ustalono okres' }
  assert.equal(financeEntryCommand(draft, expense, '2026-09').accountingMonth, '2026-08')
  assert.equal(financeEntryCommand(draft, expense, '2026-09').paidAmountGrosze, 0)
})

test('TUS monthly billing requires a chosen membership and specialist with exact explicit amounts', () => {
  const draft = { ...financeEntryDraft(null, '2026-08'), amount: '340', paidAmount: '0',
    participantId: 'acp_child', groupId: 'agr_tus', membershipId: 'amb_child',
    responsibleSpecialistId: 'sp_anna', lessonCount: '' }
  assert.deepEqual(activityChargeCommand(draft, 'apg_tus', '2026-09'), {
    participantId: 'acp_child', groupId: 'agr_tus', membershipId: 'amb_child',
    responsibleSpecialistId: 'sp_anna', accountingMonth: '2026-08', amountGrosze: 34000,
    lessonCount: null, paidAmountGrosze: 0, paymentMethod: 'unknown', settlementStatus: 'unpaid', invoiceStatus: 'not_required',
  })
  assert.throws(() => activityChargeCommand({ ...draft, membershipId: '' }, 'apg_tus', '2026-09'))
  assert.throws(() => activityChargeCommand({ ...draft, responsibleSpecialistId: '' }, 'apg_tus', '2026-09'))
})

test('English billing permits ungrouped zero lessons while rejecting mismatched group membership', () => {
  const draft = { ...financeEntryDraft(null, '2026-08'), amount: '0', paidAmount: '0',
    participantId: 'acp_child', groupId: '', membershipId: '', responsibleSpecialistId: 'sp_anna', lessonCount: '0' }
  assert.equal(activityChargeCommand(draft, 'apg_english', '2026-09').lessonCount, 0)
  assert.equal(activityChargeCommand(draft, 'apg_english', '2026-09').groupId, null)
  assert.throws(() => activityChargeCommand({ ...draft, groupId: 'agr_english' }, 'apg_english', '2026-09'))
  assert.throws(() => activityChargeCommand({ ...draft, groupId: 'agr_english', membershipId: 'amb_child' }, 'apg_english', '2026-09'))
  assert.throws(() => activityChargeCommand({ ...draft, lessonCount: '' }, 'apg_english', '2026-09'))
})
