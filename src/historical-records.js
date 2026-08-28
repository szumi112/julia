import { compareUtf16CodeUnits } from './code-unit-order.js'
import { SERVICE_BY_ID } from './services.js'

const HISTORICAL_CLIENT_ID = /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const HISTORICAL_COUNTERPARTY_ID = /^hcp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const HISTORICAL_OCCURRENCE_ID = /^hoc_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const HISTORICAL_CONFLICT_ID = /^hcf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ACTIVE_CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const SOURCE_ID = /^wbs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MONTH = /^(\d{4})-(\d{2})$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

const invalid = (kind) => { throw new TypeError(`Invalid historical ${kind}`) }

const exact = (value, keys, kind) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalid(kind)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid(kind)
    const result = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(kind)
      result[key] = descriptor.value
    }
    return result
  } catch (error) {
    if (error instanceof TypeError && error.message === `Invalid historical ${kind}`) throw error
    invalid(kind)
  }
}

const frozen = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

const canonicalInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

const civilDay = (value) => {
  if (typeof value !== 'string') return false
  const match = DAY.exec(value)
  if (!match || match[1] === '0000') return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
}

const civilMonth = (value) => {
  const match = typeof value === 'string' ? MONTH.exec(value) : null
  return Boolean(match && match[1] !== '0000' && Number(match[2]) >= 1 && Number(match[2]) <= 12)
}

const safeText = (value, maximum = 160) => {
  if (typeof value !== 'string' || value !== value.trim() || value !== value.normalize('NFC')
    || !value.length || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return false
  const bytes = new TextEncoder().encode(value)
  const valid = bytes.byteLength <= maximum
  bytes.fill(0)
  return valid
}

export const isHistoricalClientId = (value) => typeof value === 'string'
  && HISTORICAL_CLIENT_ID.test(value)
export const isHistoricalCounterpartyId = (value) => typeof value === 'string'
  && HISTORICAL_COUNTERPARTY_ID.test(value)
export const isHistoricalOccurrenceId = (value) => typeof value === 'string'
  && HISTORICAL_OCCURRENCE_ID.test(value)

export function canonicalHistoricalName(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) invalid('name')
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ')
  if (!safeText(normalized, 160)) invalid('name')
  return normalized.toLocaleLowerCase('pl-PL')
}

export const historicalNamesMatchExactly = (left, right) => {
  try { return canonicalHistoricalName(left) === canonicalHistoricalName(right) } catch { return false }
}

const reviewForm = (value) => canonicalHistoricalName(value)
  .normalize('NFD').replace(/\p{M}+/gu, '')
const tokenForm = (value) => reviewForm(value).split(' ').sort(compareUtf16CodeUnits).join(' ')
const editDistanceAtMostOne = (left, right) => {
  if (Math.abs(left.length - right.length) > 1) return false
  let leftIndex = 0
  let rightIndex = 0
  let edits = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1
      rightIndex += 1
      continue
    }
    edits += 1
    if (edits > 1) return false
    if (left.length > right.length) leftIndex += 1
    else if (right.length > left.length) rightIndex += 1
    else {
      leftIndex += 1
      rightIndex += 1
    }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1
}

export const historicalNamesRequireReview = (left, right) => {
  try {
    if (historicalNamesMatchExactly(left, right)) return false
    const leftReview = reviewForm(left)
    const rightReview = reviewForm(right)
    return leftReview === rightReview || tokenForm(left) === tokenForm(right)
      || (Math.min(leftReview.length, rightReview.length) >= 5
        && editDistanceAtMostOne(leftReview, rightReview))
  } catch { return false }
}

const ORGANIZATION = /\b(szkoła|przedszkole|fundacja|stowarzyszenie|spółka|centrum|poradnia|firma|gabinet|placówka|zespół|s\.a\.|sp\. z o\.o\.)\b/iu
const SUPERVISION = /\bsuperwiz/iu
const PERSON_TOKEN = /^[\p{L}][\p{L}'’-]*(?:-[\p{L}'’-]+)*$/u

export function classifyHistoricalSubject(input) {
  const value = exact(input, ['counterparty', 'serviceLabel'], 'classification input')
  if (!safeText(value.counterparty) || !safeText(value.serviceLabel, 240)) return 'review'
  if (SUPERVISION.test(value.serviceLabel) || ORGANIZATION.test(value.counterparty)) {
    return 'counterparty'
  }
  const tokens = value.counterparty.split(/\s+/u)
  return tokens.length >= 2 && tokens.length <= 4 && tokens.every((token) => PERSON_TOKEN.test(token))
    ? 'person' : 'review'
}

export function captureHistoricalPeriod(value) {
  const period = exact(value, ['precision', 'day', 'month'], 'period')
  const valid = (period.precision === 'day' && civilDay(period.day)
      && period.month === period.day.slice(0, 7))
    || (period.precision === 'month' && period.day === null && civilMonth(period.month))
    || (period.precision === 'unknown' && period.day === null && period.month === null)
  if (!valid) invalid('period')
  return frozen(period)
}

export function captureHistoricalClient(value) {
  const result = exact(value, [
    'id', 'name', 'status', 'activeClientId', 'version', 'createdAt', 'updatedAt',
  ], 'client')
  if (!isHistoricalClientId(result.id) || !safeText(result.name)
    || !['historical', 'activated'].includes(result.status)
    || !Number.isSafeInteger(result.version) || result.version < 1
    || !canonicalInstant(result.createdAt) || !canonicalInstant(result.updatedAt)
    || result.createdAt > result.updatedAt
    || (result.status === 'historical' ? result.activeClientId !== null
      : !(result.activeClientId === null || (typeof result.activeClientId === 'string'
        && ACTIVE_CLIENT_ID.test(result.activeClientId))))) {
    invalid('client')
  }
  return frozen(result)
}

export function captureHistoricalOccurrence(value) {
  const result = exact(value, [
    'id', 'historicalClientId', 'counterparty', 'specialistId', 'serviceId',
    'serviceLabel', 'period', 'status', 'version', 'sourceRecordId', 'createdAt',
    'updatedAt',
  ], 'occurrence')
  const client = result.historicalClientId !== null && isHistoricalClientId(result.historicalClientId)
  let counterparty = null
  if (result.counterparty !== null) {
    counterparty = exact(result.counterparty, ['id', 'name'], 'occurrence')
    if (!isHistoricalCounterpartyId(counterparty.id) || !safeText(counterparty.name)) {
      invalid('occurrence')
    }
  }
  if (!isHistoricalOccurrenceId(result.id) || client === Boolean(counterparty)
    || typeof result.specialistId !== 'string' || !SPECIALIST_ID.test(result.specialistId)
    || !(result.serviceId === null || (typeof result.serviceId === 'string'
      && Object.hasOwn(SERVICE_BY_ID, result.serviceId)))
    || !safeText(result.serviceLabel, 240)
    || !['recorded', 'voided'].includes(result.status)
    || !Number.isSafeInteger(result.version) || result.version < 1
    || typeof result.sourceRecordId !== 'string' || !SOURCE_ID.test(result.sourceRecordId)
    || !canonicalInstant(result.createdAt) || !canonicalInstant(result.updatedAt)
    || result.createdAt > result.updatedAt) invalid('occurrence')
  result.period = captureHistoricalPeriod(result.period)
  result.counterparty = counterparty
  return frozen(result)
}

export function captureHistoricalResolution(value) {
  const result = exact(value, [
    'expectedJobVersion', 'conflictId', 'classification', 'existingSubjectId', 'serviceId',
  ], 'resolution')
  if (!Number.isSafeInteger(result.expectedJobVersion) || result.expectedJobVersion < 1
    || typeof result.conflictId !== 'string' || !HISTORICAL_CONFLICT_ID.test(result.conflictId)
    || !['person', 'counterparty', 'exclude'].includes(result.classification)
    || !(result.existingSubjectId === null || isHistoricalClientId(result.existingSubjectId)
      || isHistoricalCounterpartyId(result.existingSubjectId))
    || !(result.serviceId === null || (typeof result.serviceId === 'string'
      && Object.hasOwn(SERVICE_BY_ID, result.serviceId)))) invalid('resolution')
  if ((result.classification === 'person' && result.existingSubjectId !== null
      && !isHistoricalClientId(result.existingSubjectId))
    || (result.classification === 'counterparty' && result.existingSubjectId !== null
      && !isHistoricalCounterpartyId(result.existingSubjectId))
    || (result.classification === 'exclude'
      && (result.existingSubjectId !== null || result.serviceId !== null))) {
    invalid('resolution')
  }
  return frozen(result)
}

const occurrenceSortKey = (value) => value.period?.precision === 'day'
  ? `0:${value.period.day}`
  : value.period?.precision === 'month' ? `1:${value.period.month}` : '2:'

export const compareHistoricalOccurrences = (left, right) => (
  compareUtf16CodeUnits(occurrenceSortKey(left), occurrenceSortKey(right))
  || compareUtf16CodeUnits(left.id, right.id)
)

export const compareHistoricalClients = (left, right) => (
  compareUtf16CodeUnits(canonicalHistoricalName(left.name), canonicalHistoricalName(right.name))
  || compareUtf16CodeUnits(left.id, right.id)
)
