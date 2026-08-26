export const FINANCE_METHODS = Object.freeze([
  'blik', 'card', 'cash', 'monthly', 'other', 'transfer', 'unknown',
])
export const SETTLEMENT_STATES = Object.freeze(['paid', 'partial', 'unknown', 'unpaid'])
export const INVOICE_STATES = Object.freeze([
  'action_required', 'issued', 'not_issued', 'not_required', 'unknown',
])

const KINDS = new Set(['expense', 'income'])
const RECORD_TYPES = new Set(['english', 'expense', 'income', 'tus'])
const METHODS = new Set(FINANCE_METHODS)
const SETTLEMENTS = new Set(SETTLEMENT_STATES)
const INVOICES = new Set(INVOICE_STATES)
const FINGERPRINT = /^[0-9a-f]{64}$/
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const IDS = Object.freeze({
  appointment: /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  batch: /^fib_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  entry: /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  specialist: /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/,
  staff: /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
})
const encoder = new TextEncoder()

const fail = (field) => { throw new TypeError(`VALIDATION_FAILED/${field}`) }

const exact = (value, keys, field = 'body') => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(field)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length || !keys.every((key) => actual.includes(key))) fail(field)
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(field)
      captured[key] = descriptor.value
    }
    return captured
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('VALIDATION_FAILED/')) throw error
    fail(field)
  }
}

const boundedText = (value, field, { min = 0, max }) => {
  if (typeof value !== 'string' || value !== value.trim() || value !== value.normalize('NFC')) fail(field)
  const bytes = encoder.encode(value).byteLength
  if (bytes < min || bytes > max) fail(field)
  return value
}

const integer = (value, field, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(field)
  return value
}

const civilDate = (value, field) => {
  if (value === null) return null
  const match = typeof value === 'string' ? CIVIL_DATE.exec(value) : null
  if (!match) fail(field)
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (date.toISOString().slice(0, 10) !== value) fail(field)
  return value
}

const month = (value) => {
  if (value === null) return null
  if (typeof value !== 'string' || !MONTH.test(value)) fail('accountingMonth')
  return value
}

const instant = (value, field) => {
  if (typeof value !== 'string' || !INSTANT.test(value)
    || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) fail(field)
  return value
}

const identifier = (value, type, { nullable = false, field = `${type}Id` } = {}) => {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !IDS[type]?.test(value)) fail(field)
  return value
}

const safeRaw = (value) => {
  const captured = exact(value, Object.keys(value ?? {}), 'source')
  const raw = {}
  for (const [key, item] of Object.entries(captured)) {
    boundedText(key, 'source', { min: 1, max: 120 })
    if (!(item === null || typeof item === 'string' || typeof item === 'number'
      || typeof item === 'boolean') || (typeof item === 'number' && !Number.isFinite(item))) fail('source')
    raw[key] = typeof item === 'string'
      ? boundedText(item, 'source', { max: 1000 })
      : item
  }
  if (encoder.encode(JSON.stringify(raw)).byteLength > 16_384) fail('source')
  return Object.freeze(raw)
}

const validateSource = (value) => {
  if (value === null) return null
  const captured = exact(value, ['batchId', 'sourceKey', 'sheet', 'rowNumber', 'raw'], 'source')
  identifier(captured.batchId, 'batch')
  boundedText(captured.sourceKey, 'source', { min: 1, max: 512 })
  boundedText(captured.sheet, 'source', { min: 1, max: 120 })
  integer(captured.rowNumber, 'source', 1, 100_000)
  return Object.freeze({ ...captured, raw: safeRaw(captured.raw) })
}

const ENTRY_KEYS = Object.freeze([
  'kind', 'recordType', 'accountingMonth', 'occurredOn', 'amountGrosze',
  'paidAmountGrosze', 'paymentMethod', 'settlementStatus', 'invoiceStatus',
  'counterparty', 'sourceLabel', 'invoiceNote', 'specialistId', 'lessonCount',
  'source',
])

export function validateFinanceImport(value) {
  const captured = exact(value, ['filename', 'fingerprint', 'formatVersion', 'totalRows'])
  const filename = boundedText(captured.filename, 'filename', { min: 1, max: 255 })
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) fail('filename')
  if (typeof captured.fingerprint !== 'string' || !FINGERPRINT.test(captured.fingerprint)) {
    fail('fingerprint')
  }
  if (captured.formatVersion !== 1) fail('formatVersion')
  integer(captured.totalRows, 'totalRows', 1, 10_000)
  return Object.freeze({ ...captured })
}

export function validateFinanceEntryInput(value) {
  const captured = exact(value, ENTRY_KEYS)
  if (!KINDS.has(captured.kind)) fail('kind')
  if (!RECORD_TYPES.has(captured.recordType)) fail('recordType')
  if ((captured.recordType === 'expense') !== (captured.kind === 'expense')) fail('kind')
  month(captured.accountingMonth)
  civilDate(captured.occurredOn, 'occurredOn')
  const amountMinimum = captured.recordType === 'english' ? 0 : 1
  integer(captured.amountGrosze, 'amountGrosze', amountMinimum, 100_000_000)
  integer(captured.paidAmountGrosze, 'paidAmountGrosze', 0, captured.amountGrosze)
  if (!METHODS.has(captured.paymentMethod)) fail('paymentMethod')
  if (!SETTLEMENTS.has(captured.settlementStatus)) fail('settlementStatus')
  if (!INVOICES.has(captured.invoiceStatus)) fail('invoiceStatus')
  if ((captured.settlementStatus === 'paid' && captured.paidAmountGrosze !== captured.amountGrosze)
    || (['unpaid', 'unknown'].includes(captured.settlementStatus) && captured.paidAmountGrosze !== 0)
    || (captured.settlementStatus === 'partial'
      && (captured.paidAmountGrosze <= 0 || captured.paidAmountGrosze >= captured.amountGrosze))) {
    fail('settlementStatus')
  }
  boundedText(captured.counterparty, 'counterparty', { max: 320 })
  boundedText(captured.sourceLabel, 'sourceLabel', { min: 1, max: 200 })
  boundedText(captured.invoiceNote, 'invoiceNote', { max: 1000 })
  identifier(captured.specialistId, 'specialist', { nullable: true })
  if (captured.recordType === 'english') integer(captured.lessonCount, 'lessonCount', 0, 1000)
  else if (captured.lessonCount !== null) fail('lessonCount')
  const source = validateSource(captured.source)
  return Object.freeze({ ...captured, source })
}

export function financeSourceKey(value) {
  const captured = exact(value, ['fingerprint', 'sheet', 'rowNumber', 'block'], 'sourceKey')
  if (typeof captured.fingerprint !== 'string' || !FINGERPRINT.test(captured.fingerprint)) fail('sourceKey')
  const sheet = boundedText(captured.sheet, 'sourceKey', { min: 1, max: 120 })
  if (sheet.includes(':')) fail('sourceKey')
  integer(captured.rowNumber, 'sourceKey', 1, 100_000)
  if (captured.block !== null) integer(captured.block, 'sourceKey', 1, 1000)
  return `${captured.fingerprint}:${sheet}:${captured.rowNumber}${captured.block === null ? '' : `:${captured.block}`}`
}

export function financeEntryDto(value) {
  const captured = exact(value, [
    'id', ...ENTRY_KEYS, 'appointmentId', 'version', 'createdByStaffId', 'createdAt',
    'updatedAt',
  ])
  identifier(captured.id, 'entry', { field: 'id' })
  const body = validateFinanceEntryInput(Object.fromEntries(ENTRY_KEYS.map((key) => [key, captured[key]])))
  identifier(captured.appointmentId, 'appointment', { nullable: true })
  integer(captured.version, 'version', 1, Number.MAX_SAFE_INTEGER)
  identifier(captured.createdByStaffId, 'staff')
  instant(captured.createdAt, 'createdAt')
  instant(captured.updatedAt, 'updatedAt')
  if (captured.updatedAt < captured.createdAt) fail('updatedAt')
  return Object.freeze({
    id: captured.id,
    ...body,
    appointmentId: captured.appointmentId,
    version: captured.version,
    createdByStaffId: captured.createdByStaffId,
    createdAt: captured.createdAt,
    updatedAt: captured.updatedAt,
  })
}

export function financeMonthSummary(values, wantedMonth) {
  if (!Array.isArray(values) || !(wantedMonth === null
    || (typeof wantedMonth === 'string' && MONTH.test(wantedMonth)))) fail('entries')
  const entries = values.map((value) => Object.hasOwn(value ?? {}, 'id')
    ? financeEntryDto(value)
    : validateFinanceEntryInput(value))
    .filter((value) => value.accountingMonth === wantedMonth)
  const revenueGrosze = entries.filter(({ kind }) => kind === 'income')
    .reduce((total, value) => total + value.amountGrosze, 0)
  const expensesGrosze = entries.filter(({ kind }) => kind === 'expense')
    .reduce((total, value) => total + value.amountGrosze, 0)
  const collectedGrosze = entries.filter(({ kind }) => kind === 'income')
    .reduce((total, value) => total + value.paidAmountGrosze, 0)
  return Object.freeze({
    month: wantedMonth,
    revenueGrosze,
    expensesGrosze,
    balanceGrosze: revenueGrosze - expensesGrosze,
    collectedGrosze,
    outstandingGrosze: revenueGrosze - collectedGrosze,
    invoiceActionCount: entries.filter(({ invoiceStatus }) => (
      ['action_required', 'not_issued'].includes(invoiceStatus)
    )).length,
    entryCount: entries.length,
  })
}
