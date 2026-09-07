// Strict browser contracts for ordinary finance entries and explicit corrections.
import { FINANCE_METHODS, INVOICE_STATES, SETTLEMENT_STATES, validateFinanceEntryInput } from './finance-records.js'
import { isActivityChargeId, isActivityGroupId, isActivityMembershipId, isActivityParticipantId } from './activity-records.js'

const invalid = () => { throw new TypeError('CLIENT_INPUT_INVALID') }
const exact = (raw, keys) => {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(raw)
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid()
  const result = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    result[key] = descriptor.value
  }
  return result
}
export const isFinanceEntryId = (value) => typeof value === 'string'
  && /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(value)
const version = (value) => Number.isSafeInteger(value) && value > 0
const month = (value) => value === null || (typeof value === 'string'
  && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value))
const safeText = (value, min, max) => typeof value === 'string' && value.length >= min
  && value.length <= max && value === value.trim() && value === value.normalize('NFC')
  && value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value)
const SETTLEMENT_KEYS = ['accountingMonth', 'paidAmountGrosze', 'paymentMethod', 'settlementStatus', 'invoiceStatus']
const captureSettlement = (raw, amount = 100_000_000) => {
  const value = exact(raw, SETTLEMENT_KEYS)
  if (!month(value.accountingMonth) || !Number.isSafeInteger(value.paidAmountGrosze)
    || value.paidAmountGrosze < 0 || value.paidAmountGrosze > amount
    || !FINANCE_METHODS.includes(value.paymentMethod)
    || !SETTLEMENT_STATES.includes(value.settlementStatus)
    || !INVOICE_STATES.includes(value.invoiceStatus)
    || (['unknown', 'unpaid'].includes(value.settlementStatus) && value.paidAmountGrosze !== 0)
    || (value.settlementStatus === 'partial' && value.paidAmountGrosze === 0)) invalid()
  return Object.freeze(value)
}
export const captureCreateFinanceEntry = (raw) => {
  const value = validateFinanceEntryInput(raw)
  if (value.source !== null || !['expense', 'income'].includes(value.recordType)
    || !value.accountingMonth || !month(value.accountingMonth) || value.accountingMonth < '2000-06'
    || !safeText(value.counterparty, 0, 320) || !safeText(value.sourceLabel, 1, 200)
    || !safeText(value.invoiceNote, 0, 1000)) invalid()
  return value
}
export const captureFinanceAdjustment = (raw) => {
  const value = exact(raw, ['expectedVersion', 'reason', ...SETTLEMENT_KEYS])
  if (!version(value.expectedVersion) || value.expectedVersion >= Number.MAX_SAFE_INTEGER
    || !safeText(value.reason, 3, 500)) invalid()
  const { expectedVersion, reason, ...settlement } = value
  captureSettlement(settlement)
  return Object.freeze({ expectedVersion, reason, ...settlement })
}
export const captureFinanceCommandResult = (raw, entryId = null, expectedVersion = 0) => {
  const value = exact(raw, ['entryId', 'version'])
  if (!isFinanceEntryId(value.entryId) || (entryId !== null && value.entryId !== entryId)
    || value.version !== expectedVersion + 1) invalid()
  return Object.freeze(value)
}
export const captureCreateActivityCharge = (raw) => {
  const value = exact(raw, ['participantId', 'groupId', 'membershipId', 'responsibleSpecialistId',
    'accountingMonth', 'amountGrosze', 'lessonCount', 'paidAmountGrosze', 'paymentMethod',
    'settlementStatus', 'invoiceStatus'])
  const grouped = value.groupId !== null
  if (!isActivityParticipantId(value.participantId)
    || (grouped ? !isActivityGroupId(value.groupId) || !isActivityMembershipId(value.membershipId)
      : value.membershipId !== null)
    || !value.accountingMonth || !month(value.accountingMonth) || value.accountingMonth < '2000-06'
    || (grouped ? value.lessonCount !== null : !Number.isSafeInteger(value.lessonCount))) invalid()
  validateFinanceEntryInput({ kind: 'income', recordType: grouped ? 'tus' : 'english',
    accountingMonth: value.accountingMonth, occurredOn: null, amountGrosze: value.amountGrosze,
    paidAmountGrosze: value.paidAmountGrosze, paymentMethod: value.paymentMethod,
    settlementStatus: value.settlementStatus, invoiceStatus: value.invoiceStatus,
    counterparty: '', sourceLabel: 'Activity charge', invoiceNote: '',
    specialistId: value.responsibleSpecialistId, lessonCount: value.lessonCount, source: null })
  if (value.responsibleSpecialistId === null) invalid()
  return Object.freeze(value)
}
export const captureActivityChargeResult = (raw) => {
  const value = exact(raw, ['chargeId', 'entryId', 'version'])
  if (!isActivityChargeId(value.chargeId) || !isFinanceEntryId(value.entryId) || value.version !== 1) invalid()
  return Object.freeze(value)
}
export const captureFinanceEntryDetail = (raw, entryId) => {
  const value = exact(raw, ['entry', 'adjustments', 'historyTruncated'])
  const entry = exact(value.entry, ['id', 'version', 'kind', 'recordType', 'accountingMonth',
    'occurredOn', 'amountGrosze', 'paidAmountGrosze', 'paymentMethod', 'settlementStatus',
    'invoiceStatus', 'appointmentId', 'counterparty', 'sourceLabel'])
  if (!isFinanceEntryId(entry.id) || entry.id !== entryId || !version(entry.version)
    || !(entry.appointmentId === null || (typeof entry.appointmentId === 'string'
      && /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(entry.appointmentId)))
    || !safeText(entry.counterparty, 0, 320) || !safeText(entry.sourceLabel, 1, 200)) invalid()
  const { id, version: _version, appointmentId, ...financeFields } = entry
  validateFinanceEntryInput({ ...financeFields, invoiceNote: '', specialistId: null,
    lessonCount: entry.recordType === 'english' ? 0 : null, source: null })
  if (!Array.isArray(value.adjustments) || Object.getPrototypeOf(value.adjustments) !== Array.prototype
    || value.adjustments.length > 50 || Reflect.ownKeys(value.adjustments).length !== value.adjustments.length + 1
    || typeof value.historyTruncated !== 'boolean'
    || (value.historyTruncated && value.adjustments.length !== 50)) invalid()
  const seen = new Set()
  const adjustments = Array.from({ length: value.adjustments.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value.adjustments, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    const item = exact(descriptor.value, ['id', 'createdAt', 'reason', 'before', 'after'])
    if (typeof item.id !== 'string' || !/^fadj_[A-Za-z0-9][A-Za-z0-9_-]{0,122}$/.test(item.id)
      || seen.has(item.id) || !safeText(item.reason, 3, 500)
      || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
      || new Date(item.createdAt).toISOString() !== item.createdAt) invalid()
    seen.add(item.id)
    return Object.freeze({ ...item, before: captureSettlement(item.before), after: captureSettlement(item.after) })
  })
  if (adjustments.some((item, index) => index > 0
    && (item.createdAt > adjustments[index - 1].createdAt
      || (item.createdAt === adjustments[index - 1].createdAt && item.id >= adjustments[index - 1].id)))) invalid()
  return Object.freeze({ entry: Object.freeze(entry), adjustments: Object.freeze(adjustments),
    historyTruncated: value.historyTruncated })
}
