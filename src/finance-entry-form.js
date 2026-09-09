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
  const paidAmountGrosze = cents(draft.paidAmount)
  const amountGrosze = entry?.amountGrosze ?? cents(draft.amount)
  const body = {
    kind: entry?.kind ?? draft.kind, recordType: entry?.recordType ?? draft.kind,
    accountingMonth, occurredOn: entry?.occurredOn ?? (draft.occurredOn || null),
    amountGrosze, paidAmountGrosze, paymentMethod: draft.paymentMethod,
    settlementStatus: draft.settlementStatus, invoiceStatus: draft.invoiceStatus,
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
    paymentMethod: draft.paymentMethod, settlementStatus: draft.settlementStatus, invoiceStatus: draft.invoiceStatus }
}
