import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountingMonthForOccurredOn, accountingMonthOptions, activityChargeCommand, activityChargeFieldErrors, activityMembershipForParticipant, activitySettlementDraft, draftWithOccurredOn, draftWithSettlementFromPaid, financeEntryDraft, financeEntryCommand, financePaidAmountError, manualFinanceEntryErrors } from '../../src/finance-entry-form.js'

const entry = { id: 'fin_test', version: 2, kind: 'income', recordType: 'income',
  accountingMonth: null, occurredOn: null, amountGrosze: 12345, paidAmountGrosze: 0,
  paymentMethod: 'unknown', settlementStatus: 'unknown', invoiceStatus: 'unknown' }

test('accounting month options run from the current month back to the finance window minimum', () => {
  const months = accountingMonthOptions('2000-08')
  assert.deepEqual(months, ['2000-08', '2000-07', '2000-06'])
})

test('a new manual entry follows its date until the accounting month is chosen deliberately', () => {
  const fresh = financeEntryDraft(null, '2026-08')
  assert.equal(accountingMonthForOccurredOn('2026-09-13'), '2026-09')
  assert.equal(accountingMonthForOccurredOn('2026-02-29'), null)
  assert.deepEqual(draftWithOccurredOn(fresh, '2026-09-13'), {
    ...fresh, occurredOn: '2026-09-13', accountingMonth: '2026-09',
  })
  const manuallyClassified = { ...fresh, accountingMonth: '2026-07' }
  assert.deepEqual(draftWithOccurredOn(manuallyClassified, '2026-09-13', true), {
    ...manuallyClassified, occurredOn: '2026-09-13',
  })
})

test('a new income derives its payment status from the paid amount until chosen by hand', () => {
  const fresh = { ...financeEntryDraft(null, '2026-08'), amount: '180' }
  assert.equal(draftWithSettlementFromPaid({ ...fresh, paidAmount: '0' }).settlementStatus, 'unpaid')
  assert.equal(draftWithSettlementFromPaid({ ...fresh, paidAmount: '90,50' }).settlementStatus, 'partial')
  assert.equal(draftWithSettlementFromPaid({ ...fresh, paidAmount: '180' }).settlementStatus, 'paid')
  const unreadable = { ...fresh, paidAmount: '10,001' }
  assert.equal(draftWithSettlementFromPaid(unreadable), unreadable)
  const chosen = { ...fresh, paidAmount: '180', settlementStatus: 'unknown' }
  assert.equal(draftWithSettlementFromPaid(chosen, true), chosen)
})

test('an existing entry draft preserves its recorded accounting classification', () => {
  const recorded = { ...entry, accountingMonth: '2026-07', occurredOn: '2026-07-29' }
  assert.equal(financeEntryDraft(recorded).accountingMonth, '2026-07')
})

test('manual finance errors identify the blank description and malformed amount together', () => {
  assert.deepEqual(manualFinanceEntryErrors({ sourceLabel: ' ', amount: '180,500', paidAmount: '0' }), {
    sourceLabel: 'Wpisz, za co jest ta pozycja',
    amount: 'Wpisz kwotę, np. 180 albo 180,50',
  })
})

test('paid amount errors identify malformed values before a command is requested', () => {
  assert.equal(financePaidAmountError('10.001'), 'Wpisz kwotę, np. 180 albo 180,50')
  assert.equal(financePaidAmountError('180,50'), null)
})

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
  const expense = { ...entry, kind: 'expense', recordType: 'expense', paidAmountGrosze: 2000,
    paymentMethod: 'cash', settlementStatus: 'partial', invoiceStatus: 'issued' }
  const draft = { ...financeEntryDraft(expense), accountingMonth: '2026-08', reason: 'Ustalono okres' }
  assert.deepEqual(financeEntryCommand(draft, expense, '2026-09'), {
    expectedVersion: 2, reason: 'Ustalono okres', accountingMonth: '2026-08',
    paidAmountGrosze: 2000, paymentMethod: 'cash', settlementStatus: 'partial', invoiceStatus: 'issued',
  })
})

test('manual expense keeps a compact form contract and ignores hidden payment fields', () => {
  const draft = { ...financeEntryDraft(null, '2026-08'), kind: 'expense',
    sourceLabel: 'Materiały', amount: '120', paidAmount: 'niepoprawne',
    paymentMethod: 'cash', settlementStatus: 'paid', invoiceStatus: 'issued' }
  assert.deepEqual(manualFinanceEntryErrors(draft), {})
  assert.deepEqual(financeEntryCommand(draft, null, '2026-09'), {
    kind: 'expense', recordType: 'expense', accountingMonth: '2026-08', occurredOn: null,
    amountGrosze: 12000, paidAmountGrosze: 0, paymentMethod: 'unknown',
    settlementStatus: 'unpaid', invoiceStatus: 'not_required', counterparty: '',
    sourceLabel: 'Materiały', invoiceNote: '', specialistId: null, lessonCount: null, source: null,
  })
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

test('a group settlement starts in the viewed month and uses an unambiguous membership and leader', () => {
  const draft = activitySettlementDraft({
    selectedMonth: '2026-08', groupId: 'agr_tus', leaderSpecialistIds: ['sp_anna'],
  })
  assert.deepEqual(draft, {
    ...financeEntryDraft(null, '2026-08'), participantId: '', groupId: 'agr_tus', membershipId: '',
    responsibleSpecialistId: 'sp_anna', lessonCount: '',
  })
  assert.equal(activityMembershipForParticipant([
    { membership: { id: 'amb_anna', participantId: 'acp_anna' } },
  ], 'acp_anna'), 'amb_anna')
  assert.equal(activityMembershipForParticipant([
    { membership: { id: 'amb_anna', participantId: 'acp_anna' } },
    { membership: { id: 'amb_druga', participantId: 'acp_anna' } },
  ], 'acp_anna'), null)
})

test('activity settlement reports visible required fields before building a command', () => {
  assert.deepEqual(activityChargeFieldErrors({
    ...financeEntryDraft(null, '2026-08'), participantId: '', groupId: 'agr_tus', membershipId: '',
    responsibleSpecialistId: '', lessonCount: '',
  }, 'apg_tus'), {
    participantId: 'Wybierz uczestnika', membershipId: 'Wybierz przypisanie do grupy',
    amount: 'Wpisz kwotę, np. 180 albo 180,50', responsibleSpecialistId: 'Wybierz osobę prowadzącą',
  })
})

test('activity settlement reports amount and lesson count domain boundaries at their fields', () => {
  const tus = { ...financeEntryDraft(null, '2026-08'), participantId: 'acp_child', groupId: 'agr_tus',
    membershipId: 'amb_child', responsibleSpecialistId: 'sp_anna', amount: '0' }
  assert.equal(activityChargeFieldErrors(tus, 'apg_tus').amount, 'Wpisz kwotę, np. 180 albo 180,50')
  assert.equal(activityChargeFieldErrors({ ...tus, amount: '1000000,01' }, 'apg_tus').amount,
    'Wpisz kwotę, np. 180 albo 180,50')

  const english = { ...financeEntryDraft(null, '2026-08'), participantId: 'acp_child', groupId: '',
    membershipId: '', responsibleSpecialistId: 'sp_anna', amount: '0', lessonCount: '1001' }
  const errors = activityChargeFieldErrors(english, 'apg_english')
  assert.equal(errors.amount, undefined)
  assert.equal(errors.lessonCount, 'Podaj liczbę lekcji od 0 do 1000')
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
