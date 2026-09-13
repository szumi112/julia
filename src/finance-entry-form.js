import { validateFinanceEntryInput } from './finance-records.js'
import { FINANCE_WINDOW_MIN_MONTH } from './finance-reporting.js'

const fail = (message) => { throw new Error(message) }
const cents = (value) => {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) fail('Podaj kwotę z najwyżej dwoma miejscami po przecinku.')
  const [whole, fraction = ''] = value.replace(',', '.').split('.')
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(result)) fail('Kwota jest zbyt duża.')
  return result
}
const text = (value) => {
  const normalized = value.trim().normalize('NFC')
  if (!normalized.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    fail('Usuń niewidoczne znaki sterujące z tekstu i spróbuj ponownie.')
  }
  return normalized
}

export function accountingMonthOptions(currentMonth) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(currentMonth) || currentMonth < FINANCE_WINDOW_MIN_MONTH) return []
  const months = []
  let month = currentMonth
  while (month >= FINANCE_WINDOW_MIN_MONTH) {
    months.push(month)
    const [year, number] = month.split('-').map(Number)
    month = `${number === 1 ? year - 1 : year}-${String(number === 1 ? 12 : number - 1).padStart(2, '0')}`
  }
  return months
}

export function manualFinanceEntryErrors(draft) {
  const errors = {}
  if (!String(draft.sourceLabel ?? '').trim()) errors.sourceLabel = 'Wpisz, za co jest ta pozycja'
  try {
    const amount = cents(String(draft.amount ?? ''))
    if (amount < 1 || amount > 100_000_000) throw new Error('amount')
  } catch {
    errors.amount = 'Wpisz kwotę, np. 180 albo 180,50'
  }
  if (draft.kind !== 'expense') {
    const paidAmountError = financePaidAmountError(draft.paidAmount)
    if (paidAmountError) errors.paidAmount = paidAmountError
  }
  return errors
}

export function financePaidAmountError(value) {
  try {
    if (cents(String(value ?? '')) > 100_000_000) throw new Error('paidAmount')
    return null
  } catch {
    return 'Wpisz kwotę, np. 180 albo 180,50'
  }
}

export function activityChargeFieldErrors(draft, programId) {
  const errors = {}
  if (!draft.participantId) errors.participantId = 'Wybierz uczestnika'
  if (programId === 'apg_tus' && !draft.membershipId) errors.membershipId = 'Wybierz przypisanie do grupy'
  if (!draft.responsibleSpecialistId) errors.responsibleSpecialistId = 'Wybierz osobę prowadzącą'
  try {
    const amount = cents(String(draft.amount ?? ''))
    const minimum = programId === 'apg_english' ? 0 : 1
    if (amount < minimum || amount > 100_000_000) throw new Error('amount')
  } catch {
    errors.amount = 'Wpisz kwotę, np. 180 albo 180,50'
  }
  if (programId === 'apg_english' && (!/^\d+$/.test(draft.lessonCount ?? '')
    || Number(draft.lessonCount) > 1000)) {
    errors.lessonCount = 'Podaj liczbę lekcji od 0 do 1000'
  }
  return errors
}

export function activityChargeCommand(draft, programId, currentMonth) {
  const english = programId === 'apg_english'
  const groupId = draft.groupId || null
  const membershipId = draft.membershipId || null
  if (!['apg_tus', 'apg_english'].includes(programId) || !draft.participantId
    || !draft.responsibleSpecialistId || Boolean(groupId) !== Boolean(membershipId)
    || (!english && !membershipId) || (english && groupId)) fail('Wybierz uczestnika, przypisanie do grupy i odpowiedzialnego specjalistę.')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(draft.accountingMonth ?? '')
    || draft.accountingMonth < FINANCE_WINDOW_MIN_MONTH || draft.accountingMonth > currentMonth) {
    fail('Wybierz miesiąc od czerwca 2000 do bieżącego miesiąca.')
  }
  if (english && !/^\d+$/.test(draft.lessonCount)) fail('Podaj liczbę lekcji, również gdy wynosi zero.')
  const command = {
    participantId: draft.participantId, groupId, membershipId,
    responsibleSpecialistId: draft.responsibleSpecialistId, accountingMonth: draft.accountingMonth,
    amountGrosze: cents(draft.amount), lessonCount: english ? Number(draft.lessonCount) : null,
    paidAmountGrosze: cents(draft.paidAmount), paymentMethod: draft.paymentMethod,
    settlementStatus: draft.settlementStatus, invoiceStatus: draft.invoiceStatus,
  }
  try {
    validateFinanceEntryInput({ kind: 'income', recordType: english ? 'english' : 'tus',
      accountingMonth: command.accountingMonth, occurredOn: null, amountGrosze: command.amountGrosze,
      paidAmountGrosze: command.paidAmountGrosze, paymentMethod: command.paymentMethod,
      settlementStatus: command.settlementStatus, invoiceStatus: command.invoiceStatus,
      counterparty: '', sourceLabel: 'Activity', invoiceNote: '',
      specialistId: command.responsibleSpecialistId, lessonCount: command.lessonCount, source: null })
  } catch { fail('Sprawdź kwoty, liczbę lekcji oraz status płatności.') }
  return command
}

export const financeEntryDraft = (entry, selectedMonth = '') => ({
  kind: entry?.kind ?? 'income', accountingMonth: entry ? entry.accountingMonth ?? '' : selectedMonth,
  occurredOn: entry?.occurredOn ?? '', amount: entry ? (entry.amountGrosze / 100).toFixed(2) : '',
  paidAmount: entry ? (entry.paidAmountGrosze / 100).toFixed(2) : '0',
  paymentMethod: entry?.paymentMethod ?? 'unknown', settlementStatus: entry?.settlementStatus ?? 'unpaid',
  invoiceStatus: entry?.invoiceStatus ?? 'not_required', counterparty: entry?.counterparty ?? '',
  sourceLabel: entry?.sourceLabel ?? '', reason: '',
})

export const activityMembershipForParticipant = (memberships, participantId) => {
  const matches = (Array.isArray(memberships) ? memberships : [])
    .map(({ membership }) => membership)
    .filter((membership) => membership?.participantId === participantId)
  return matches.length === 1 ? matches[0].id : null
}

export const activitySettlementDraft = ({
  selectedMonth, groupId = null, leaderSpecialistIds = [], currentSpecialistId = null,
}) => {
  const leaders = [...new Set(leaderSpecialistIds.filter((id) => typeof id === 'string'))]
  const responsibleSpecialistId = leaders.includes(currentSpecialistId)
    ? currentSpecialistId
    : leaders[0] ?? ''
  return {
    ...financeEntryDraft(null, selectedMonth), participantId: '', groupId: groupId ?? '',
    membershipId: '', responsibleSpecialistId, lessonCount: '',
  }
}

export function accountingMonthForOccurredOn(occurredOn) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(occurredOn ?? '')) return null
  const date = new Date(`${occurredOn}T12:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== occurredOn
    ? null : occurredOn.slice(0, 7)
}

export function draftWithOccurredOn(draft, occurredOn, accountingMonthManuallySelected = false) {
  const accountingMonth = accountingMonthForOccurredOn(occurredOn)
  return {
    ...draft,
    occurredOn,
    ...(!accountingMonthManuallySelected && accountingMonth ? { accountingMonth } : {}),
  }
}

export function financeEntryCommand(draft, entry, currentMonth) {
  const accountingMonth = draft.accountingMonth || null
  const unchangedUnknown = entry && entry.accountingMonth === null && accountingMonth === null
  if (!unchangedUnknown && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(accountingMonth ?? '')
    || accountingMonth < FINANCE_WINDOW_MIN_MONTH || accountingMonth > currentMonth)) {
    fail('Wybierz miesiąc od czerwca 2000 do bieżącego miesiąca.')
  }
  if (entry?.kind === 'income' && accountingMonth !== entry.accountingMonth) {
    fail('Miesiąc przychodu pozostaje zgodny z pozycją źródłową.')
  }
  const expenseDefaults = !entry && draft.kind === 'expense'
    ? { paidAmount: '0', paymentMethod: 'unknown', settlementStatus: 'unpaid', invoiceStatus: 'not_required' }
    : null
  const settlement = expenseDefaults ?? draft
  const paidAmountGrosze = cents(settlement.paidAmount)
  const amountGrosze = entry?.amountGrosze ?? cents(draft.amount)
  const body = {
    kind: entry?.kind ?? draft.kind, recordType: entry?.recordType ?? draft.kind,
    accountingMonth, occurredOn: entry?.occurredOn ?? (draft.occurredOn || null),
    amountGrosze, paidAmountGrosze, paymentMethod: settlement.paymentMethod,
    settlementStatus: settlement.settlementStatus, invoiceStatus: settlement.invoiceStatus,
    counterparty: text(draft.counterparty), sourceLabel: entry ? 'Adjustment' : text(draft.sourceLabel),
    invoiceNote: '', specialistId: null, lessonCount: entry?.recordType === 'english' ? 0 : null, source: null,
  }
  try { validateFinanceEntryInput(body) } catch {
    fail('Sprawdź opis, datę, kwoty i status płatności. Wpłacona kwota musi odpowiadać statusowi i nie może przekraczać należności.')
  }
  if (!entry) return body
  const reason = text(draft.reason)
  if (reason.length < 3 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    fail('Podaj powód korekty (od 3 do 500 znaków).')
  }
  return { expectedVersion: entry.version, reason, accountingMonth, paidAmountGrosze,
    paymentMethod: settlement.paymentMethod, settlementStatus: settlement.settlementStatus, invoiceStatus: settlement.invoiceStatus }
}
