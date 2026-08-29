import {
  FINANCE_METHODS,
  INVOICE_STATES,
  SETTLEMENT_STATES,
} from '../../src/finance-records.js'

const KINDS = new Set(['expense', 'income'])
const RECORD_TYPES = new Set(['english', 'expense', 'income', 'tus'])
const METHODS = new Set(FINANCE_METHODS)
const SETTLEMENTS = new Set(SETTLEMENT_STATES)
const INVOICES = new Set(INVOICE_STATES)
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/

export const PANEL_FINANCE_FIELD_ORDER = Object.freeze([
  'accountingMonth',
  'occurredOn',
  'amountGrosze',
  'paidAmountGrosze',
  'paymentMethod',
  'settlementStatus',
  'invoiceStatus',
  'specialistId',
])

const FIELD_SET = new Set(PANEL_FINANCE_FIELD_ORDER)
const ENUMS = Object.freeze({
  invoiceStatus: INVOICES,
  paymentMethod: METHODS,
  settlementStatus: SETTLEMENTS,
})

const validCivilDate = (value) => {
  if (typeof value !== 'string' || !CIVIL_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export const normalizePanelFinanceEdits = (input) => {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    return Object.freeze({ field: null, values: null })
  }
  const keys = Object.keys(input)
  const unknown = keys.find((field) => !FIELD_SET.has(field))
  if (unknown) return Object.freeze({ field: unknown, values: null })
  const values = {}
  for (const field of PANEL_FINANCE_FIELD_ORDER) {
    if (!Object.hasOwn(input, field)) continue
    const raw = input[field]
    const value = raw === '' ? null : raw
    if (['amountGrosze', 'paidAmountGrosze'].includes(field)) {
      if (value !== null && !Number.isSafeInteger(value)) {
        return Object.freeze({ field, values: null })
      }
    } else if (field === 'occurredOn') {
      if (value !== null && !validCivilDate(value)) {
        return Object.freeze({ field, values: null })
      }
    } else if (Object.hasOwn(ENUMS, field)) {
      if (value !== null && (typeof value !== 'string' || !ENUMS[field].has(value))) {
        return Object.freeze({ field, values: null })
      }
    } else if (value !== null && typeof value !== 'string') {
      return Object.freeze({ field, values: null })
    }
    values[field] = typeof value === 'string' ? value.normalize('NFC') : value
  }
  return Object.freeze({ field: null, values: Object.freeze(values) })
}

export const prospectivePanelFinanceValues = (current, edits) => {
  const values = { ...current, ...edits }
  if (!Object.hasOwn(edits, 'paidAmountGrosze')) {
    if (values.settlementStatus === 'paid') values.paidAmountGrosze = values.amountGrosze
    else if (['unknown', 'unpaid'].includes(values.settlementStatus)) {
      values.paidAmountGrosze = 0
    }
  }
  return Object.freeze(values)
}

export const invalidPanelFinanceField = ({
  kind,
  recordType,
  values,
  specialistIds = [],
} = {}) => {
  if (!KINDS.has(kind) || !RECORD_TYPES.has(recordType)
    || ((recordType === 'expense') !== (kind === 'expense'))) return 'recordType'
  if (!(values?.accountingMonth === null
    || (typeof values?.accountingMonth === 'string' && MONTH.test(values.accountingMonth)))) {
    return 'accountingMonth'
  }
  if (!(values.occurredOn === null || validCivilDate(values.occurredOn))) return 'occurredOn'
  const minimum = recordType === 'english' ? 0 : 1
  if (!Number.isSafeInteger(values.amountGrosze)
    || values.amountGrosze < minimum || values.amountGrosze > 100_000_000) {
    return 'amountGrosze'
  }
  if (!Number.isSafeInteger(values.paidAmountGrosze)
    || values.paidAmountGrosze < 0 || values.paidAmountGrosze > values.amountGrosze) {
    return 'paidAmountGrosze'
  }
  if (!METHODS.has(values.paymentMethod)) return 'paymentMethod'
  if (!SETTLEMENTS.has(values.settlementStatus)) return 'settlementStatus'
  if (!INVOICES.has(values.invoiceStatus)) return 'invoiceStatus'
  if ((values.settlementStatus === 'paid'
      && values.paidAmountGrosze !== values.amountGrosze)
    || (['unpaid', 'unknown'].includes(values.settlementStatus)
      && values.paidAmountGrosze !== 0)
    || (values.settlementStatus === 'partial'
      && (values.paidAmountGrosze <= 0
        || values.paidAmountGrosze >= values.amountGrosze))) return 'settlementStatus'
  if (values.specialistId !== null
    && (typeof values.specialistId !== 'string'
      || !SPECIALIST_ID.test(values.specialistId)
      || !new Set(specialistIds).has(values.specialistId))) return 'specialistId'
  return null
}
