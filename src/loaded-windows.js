import {
  captureHistoricalClient,
  captureHistoricalOccurrence,
} from './historical-records.js'

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const CIVIL_MONTH = /^(\d{4})-(\d{2})$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const ASSIGNMENT_ID = /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CHARGE_ID = /^chg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const HISTORICAL_CLIENT_ID = /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const HISTORICAL_OCCURRENCE_ID = /^hoc_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const STATE_KEYS = Object.freeze([
  'loadedRanges', 'specialistsById', 'clientsById', 'appointmentsById',
  'historicalClientsById', 'historicalOccurrencesById', 'latestPopulatedMonth',
  'authorityGeneration', 'writeEpoch',
])

const warsawDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const fail = (message) => {
  throw new TypeError(message)
}

const captureExactObject = (value, keys, label) => {
  let descriptors
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`Invalid ${label}`)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail(`Invalid ${label}`)
  }
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    fail(`Invalid ${label}`)
  }
  const captured = Object.create(null)
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail(`Invalid ${label}`)
    }
    captured[key] = descriptor.value
  }
  return captured
}

const captureDenseArray = (value, label) => {
  let descriptors
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      fail(`Invalid ${label}`)
    }
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail(`Invalid ${label}`)
  }
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0
    || Reflect.ownKeys(descriptors).length !== length + 1) fail(`Invalid ${label}`)
  const result = new Array(length)
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail(`Invalid ${label}`)
    }
    result[index] = descriptor.value
  }
  return result
}

const daysInMonth = (year, month) => {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

// Proleptic Gregorian day number for the supported civil years 0001..9999.
const civilOrdinal = (value) => {
  if (typeof value !== 'string') return null
  const match = CIVIL_DATE.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)) return null
  const adjustedYear = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(adjustedYear / 400)
  const yearOfEra = adjustedYear - era * 400
  const adjustedMonth = month + (month > 2 ? -3 : 9)
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra
}

const captureRange = (value, label = 'workspace range') => {
  const captured = captureExactObject(value, ['from', 'to'], label)
  const fromOrdinal = civilOrdinal(captured.from)
  const toOrdinal = civilOrdinal(captured.to)
  if (fromOrdinal === null || toOrdinal === null || fromOrdinal > toOrdinal) fail(`Invalid ${label}`)
  return Object.freeze({ from: captured.from, to: captured.to })
}

const captureSerializable = (value, seen = new WeakSet()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Invalid canonical entity')
    return value
  }
  if (typeof value !== 'object' || seen.has(value)) fail('Invalid canonical entity')
  seen.add(value)
  if (Array.isArray(value)) {
    const items = captureDenseArray(value, 'canonical entity array')
      .map((item) => captureSerializable(item, seen))
    seen.delete(value)
    return Object.freeze(items)
  }
  let descriptors
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail('Invalid canonical entity')
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail('Invalid canonical entity')
  }
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== 'string' || UNSAFE_KEYS.has(key))) {
    fail('Invalid canonical entity')
  }
  const result = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail('Invalid canonical entity')
    }
    Object.defineProperty(result, key, {
      value: captureSerializable(descriptor.value, seen),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  seen.delete(value)
  return Object.freeze(result)
}

const safeProperty = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined

const captureEntityArray = (raw, label, idPattern, validate) => {
  const source = captureDenseArray(raw, label)
  const result = []
  const ids = new Set()
  for (const item of source) {
    const captured = captureSerializable(item)
    const id = safeProperty(captured, 'id')
    if (typeof id !== 'string' || !idPattern.test(id) || ids.has(id) || !validate(captured)) {
      fail(`Invalid ${label}`)
    }
    ids.add(id)
    result.push(captured)
  }
  return result
}

const validSpecialist = (value) => ['active', 'archived'].includes(
  safeProperty(value, 'status'),
)

const validClient = (value) => {
  const status = safeProperty(value, 'status')
  const readOnly = safeProperty(value, 'readOnly')
  const assignment = safeProperty(value, 'assignment')
  if (!['active', 'paused', 'archived'].includes(status)) return false
  if (status === 'archived') return readOnly === true && assignment === null
  if (readOnly !== false) return false
  return assignment === null || (
    assignment !== null && typeof assignment === 'object'
    && typeof safeProperty(assignment, 'id') === 'string'
    && ASSIGNMENT_ID.test(safeProperty(assignment, 'id'))
    && typeof safeProperty(assignment, 'specialistId') === 'string'
    && SPECIALIST_ID.test(safeProperty(assignment, 'specialistId'))
  )
}

const validInstant = (value) => {
  if (typeof value !== 'string' || !INSTANT.test(value) || value.startsWith('0000-')) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}

const validAppointment = (value) => {
  const clientId = safeProperty(value, 'clientId')
  const specialistId = safeProperty(value, 'specialistId')
  const startsAt = safeProperty(value, 'startsAt')
  const charge = safeProperty(value, 'charge')
  const paymentEntries = safeProperty(value, 'paymentEntries')
  return typeof clientId === 'string' && CLIENT_ID.test(clientId)
    && typeof specialistId === 'string' && SPECIALIST_ID.test(specialistId)
    && validInstant(startsAt)
    && charge !== null && typeof charge === 'object'
    && typeof safeProperty(charge, 'id') === 'string'
    && CHARGE_ID.test(safeProperty(charge, 'id'))
    && Array.isArray(paymentEntries)
    && paymentEntries.every((entry) => entry !== null && typeof entry === 'object'
      && typeof safeProperty(entry, 'id') === 'string'
      && PAYMENT_ID.test(safeProperty(entry, 'id')))
}

const validHistoricalClient = (value) => {
  try { captureHistoricalClient(value); return true } catch { return false }
}

const validHistoricalOccurrence = (value) => {
  try { captureHistoricalOccurrence(value); return true } catch { return false }
}

const mapFrom = (values) => {
  const result = Object.create(null)
  for (const value of values) result[safeProperty(value, 'id')] = value
  return Object.freeze(result)
}

const historicalSpecialistSnapshot = (value) => {
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'accessStatus') result[key] = item
  }
  result.status = 'archived'
  return Object.freeze(result)
}

const stateFrom = ({
  loadedRanges,
  specialistsById,
  clientsById,
  appointmentsById,
  historicalClientsById,
  historicalOccurrencesById,
  latestPopulatedMonth,
  authorityGeneration,
  writeEpoch,
}) => Object.freeze({
  loadedRanges: Object.freeze(loadedRanges),
  specialistsById,
  clientsById,
  appointmentsById,
  historicalClientsById,
  historicalOccurrencesById,
  latestPopulatedMonth,
  authorityGeneration,
  writeEpoch,
})

const normalizeRanges = (ranges, added) => {
  const all = [...ranges, added].map((item) => ({
    from: item.from,
    to: item.to,
    fromOrdinal: civilOrdinal(item.from),
    toOrdinal: civilOrdinal(item.to),
  })).sort((left, right) => left.fromOrdinal - right.fromOrdinal)
  const normalized = []
  for (const item of all) {
    const previous = normalized.at(-1)
    if (!previous || item.fromOrdinal > previous.toOrdinal + 1) {
      normalized.push({ ...item })
    } else if (item.toOrdinal > previous.toOrdinal) {
      previous.toOrdinal = item.toOrdinal
      previous.to = item.to
    }
  }
  return normalized.map((item) => Object.freeze({ from: item.from, to: item.to }))
}

const warsawCivilDate = (instant) => {
  if (!validInstant(instant)) fail('Invalid appointment start')
  const parts = Object.fromEntries(warsawDateFormatter.formatToParts(new Date(instant))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`
}

const inRange = (date, rangeValue) => date >= rangeValue.from && date <= rangeValue.to

const validMonth = (value) => {
  const match = typeof value === 'string' ? CIVIL_MONTH.exec(value) : null
  return Boolean(match && Number(match[1]) >= 1
    && Number(match[2]) >= 1 && Number(match[2]) <= 12)
}

const monthInRange = (month, rangeValue) => month >= rangeValue.from.slice(0, 7)
  && month <= rangeValue.to.slice(0, 7)

const historicalPeriod = (value) => safeProperty(value, 'period')

const historicalCoveredBy = (value, rangeValue) => {
  const period = historicalPeriod(value)
  if (safeProperty(period, 'precision') === 'day') {
    return inRange(safeProperty(period, 'day'), rangeValue)
  }
  if (safeProperty(period, 'precision') === 'month') {
    return monthInRange(safeProperty(period, 'month'), rangeValue)
  }
  return true
}

const historicalCoveredByRanges = (value, ranges) => {
  const period = historicalPeriod(value)
  if (safeProperty(period, 'precision') === 'unknown') return true
  return ranges.some((rangeValue) => historicalCoveredBy(value, rangeValue))
}

const recordedHistoricalMonth = (value) => {
  if (safeProperty(value, 'status') !== 'recorded') return null
  const period = historicalPeriod(value)
  return safeProperty(period, 'precision') === 'unknown'
    ? null : safeProperty(period, 'month')
}

const maxRecordedHistoricalMonth = (values) => values.reduce((latest, value) => {
  const month = recordedHistoricalMonth(value)
  return month !== null && (latest === null || month > latest) ? month : latest
}, null)

const structurallyEqual = (left, right) => {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && structurallyEqual(left[key], right[key]))
}

const capturePayload = (payload, capture) => {
  const raw = captureExactObject(
    payload, [
      'window', 'specialists', 'clients', 'appointments', 'historicalClients',
      'historicalOccurrences', 'latestPopulatedMonth',
    ], 'workspace payload',
  )
  const windowValue = captureExactObject(
    raw.window, ['from', 'to', 'timeZone', 'complete'], 'workspace payload window',
  )
  const windowRange = captureRange({ from: windowValue.from, to: windowValue.to })
  if (windowRange.from !== capture.from || windowRange.to !== capture.to
    || windowValue.timeZone !== 'Europe/Warsaw' || windowValue.complete !== true) {
    fail('Invalid workspace payload window')
  }
  const specialists = captureEntityArray(
    raw.specialists, 'workspace specialists', SPECIALIST_ID, validSpecialist,
  )
  const clients = captureEntityArray(raw.clients, 'workspace clients', CLIENT_ID, validClient)
  const appointments = captureEntityArray(
    raw.appointments, 'workspace appointments', APPOINTMENT_ID, validAppointment,
  )
  const historicalClients = captureEntityArray(
    raw.historicalClients, 'workspace historical clients', HISTORICAL_CLIENT_ID,
    validHistoricalClient,
  )
  const historicalOccurrences = captureEntityArray(
    raw.historicalOccurrences, 'workspace historical occurrences', HISTORICAL_OCCURRENCE_ID,
    validHistoricalOccurrence,
  )
  const latestPopulatedMonth = raw.latestPopulatedMonth
  if (latestPopulatedMonth !== null && !validMonth(latestPopulatedMonth)) {
    fail('Invalid workspace latest populated month')
  }
  const allIds = new Set()
  const registerId = (id) => {
    if (allIds.has(id)) fail('Cross-type entity ID collision')
    allIds.add(id)
  }
  for (const entity of [
    ...specialists, ...clients, ...appointments, ...historicalClients,
    ...historicalOccurrences,
  ]) {
    registerId(safeProperty(entity, 'id'))
  }
  for (const value of clients) {
    const assignment = safeProperty(value, 'assignment')
    if (assignment !== null) registerId(safeProperty(assignment, 'id'))
  }
  for (const value of appointments) {
    registerId(safeProperty(safeProperty(value, 'charge'), 'id'))
    for (const entry of safeProperty(value, 'paymentEntries')) {
      registerId(safeProperty(entry, 'id'))
    }
  }
  const specialistIds = new Set(specialists.map((value) => safeProperty(value, 'id')))
  for (const value of clients) {
    const assignment = safeProperty(value, 'assignment')
    if (assignment !== null
      && !specialistIds.has(safeProperty(assignment, 'specialistId'))) {
      fail('Client assignment does not resolve')
    }
  }
  const clientIds = new Set(clients.map((value) => safeProperty(value, 'id')))
  for (const value of appointments) {
    if (!clientIds.has(safeProperty(value, 'clientId'))
      || !inRange(warsawCivilDate(safeProperty(value, 'startsAt')), windowRange)) {
      fail('Appointment relationship does not resolve')
    }
  }
  const historicalClientIds = new Set(historicalClients
    .map((value) => safeProperty(value, 'id')))
  const historicalSources = new Set()
  const historicalCounterparties = new Map()
  const referencedHistoricalClients = new Set()
  const referencedHistoricalSpecialists = new Set()
  for (const value of historicalOccurrences) {
    if (!specialistIds.has(safeProperty(value, 'specialistId'))
      || !historicalCoveredBy(value, windowRange)) {
      fail('Historical occurrence relationship does not resolve')
    }
    referencedHistoricalSpecialists.add(safeProperty(value, 'specialistId'))
    const sourceId = safeProperty(value, 'sourceRecordId')
    if (historicalSources.has(sourceId)) fail('Historical source identity collision')
    historicalSources.add(sourceId)
    const historicalClientId = safeProperty(value, 'historicalClientId')
    if (historicalClientId !== null) {
      if (!historicalClientIds.has(historicalClientId)) {
        fail('Historical occurrence subject does not resolve')
      }
      referencedHistoricalClients.add(historicalClientId)
    } else {
      const counterparty = safeProperty(value, 'counterparty')
      const counterpartyId = safeProperty(counterparty, 'id')
      const counterpartyName = safeProperty(counterparty, 'name')
      const prior = historicalCounterparties.get(counterpartyId)
      if (prior !== undefined && prior !== counterpartyName) {
        fail('Historical counterparty identity changed')
      }
      historicalCounterparties.set(counterpartyId, counterpartyName)
    }
  }
  if (specialists.some((value) => safeProperty(value, 'status') === 'archived'
    && !referencedHistoricalSpecialists.has(safeProperty(value, 'id')))) {
    fail('Unreferenced archived specialist')
  }
  if (historicalClients.some((value) => (
    !referencedHistoricalClients.has(safeProperty(value, 'id'))
    || (safeProperty(value, 'activeClientId') !== null
      && !clientIds.has(safeProperty(value, 'activeClientId')))
  ))) fail('Historical client relationship does not resolve')
  const visibleLatest = maxRecordedHistoricalMonth(historicalOccurrences)
  if (visibleLatest !== null
    && (latestPopulatedMonth === null || latestPopulatedMonth < visibleLatest)) {
    fail('Historical latest populated month is inconsistent')
  }
  return {
    windowRange, specialists, clients, appointments, historicalClients,
    historicalOccurrences, latestPopulatedMonth,
  }
}

const captureLoad = (capture) => {
  const raw = captureExactObject(
    capture, ['from', 'to', 'authorityGeneration', 'writeEpoch'], 'load capture',
  )
  const capturedRange = captureRange({ from: raw.from, to: raw.to })
  if (!Number.isSafeInteger(raw.authorityGeneration) || raw.authorityGeneration < 0
    || !Number.isSafeInteger(raw.writeEpoch) || raw.writeEpoch < 0) fail('Invalid load capture')
  return Object.freeze({
    ...capturedRange,
    authorityGeneration: raw.authorityGeneration,
    writeEpoch: raw.writeEpoch,
  })
}

const assertFrozenSerializable = (value, seen = new WeakSet()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Invalid loaded workspace state entity')
    return
  }
  if (typeof value !== 'object' || seen.has(value)) fail('Invalid loaded workspace state entity')
  seen.add(value)
  let descriptors
  try {
    if (!Object.isFrozen(value)) fail('Mutable loaded workspace state entity')
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail('Invalid state entity array')
      descriptors = Object.getOwnPropertyDescriptors(value)
      const length = descriptors.length?.value
      if (!Number.isSafeInteger(length) || length < 0
        || Reflect.ownKeys(descriptors).length !== length + 1) fail('Invalid state entity array')
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
          fail('Invalid state entity array')
        }
        assertFrozenSerializable(descriptor.value, seen)
      }
      seen.delete(value)
      return
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) fail('Invalid state entity object')
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail('Invalid loaded workspace state entity')
  }
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== 'string' || UNSAFE_KEYS.has(key))) {
    fail('Invalid loaded workspace state entity')
  }
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail('Invalid loaded workspace state entity')
    }
    assertFrozenSerializable(descriptor.value, seen)
  }
  seen.delete(value)
}

const captureFrozenMap = (value, label, idPattern, validate) => {
  let descriptors
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== null || !Object.isFrozen(value)) fail(`Invalid ${label}`)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail(`Invalid ${label}`)
  }
  const result = []
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || UNSAFE_KEYS.has(key) || !idPattern.test(key)) fail(`Invalid ${label}`)
    const descriptor = descriptors[key]
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(`Invalid ${label}`)
    const entity = descriptor.value
    assertFrozenSerializable(entity)
    if (safeProperty(entity, 'id') !== key || !validate(entity)) fail(`Invalid ${label}`)
    result.push(entity)
  }
  return result
}

const captureFrozenRanges = (value) => {
  let raw
  try {
    if (!Object.isFrozen(value)) fail('Mutable loaded ranges')
    raw = captureDenseArray(value, 'loaded ranges')
  } catch {
    fail('Invalid loaded ranges')
  }
  let previous = null
  raw.forEach((item) => {
    if (!Object.isFrozen(item)) fail('Mutable loaded range')
    const captured = captureRange(item, 'loaded range')
    const fromOrdinal = civilOrdinal(captured.from)
    const toOrdinal = civilOrdinal(captured.to)
    if (previous && fromOrdinal <= previous.toOrdinal + 1) fail('Unnormalized loaded ranges')
    previous = { toOrdinal }
  })
  return value
}

const authenticateState = (state) => {
  let raw
  try {
    if (!Object.isFrozen(state)) fail('Mutable loaded workspace state')
    raw = captureExactObject(state, STATE_KEYS, 'loaded workspace state')
  } catch {
    fail('Invalid loaded workspace state')
  }
  if (!Number.isSafeInteger(raw.authorityGeneration) || raw.authorityGeneration < 0
    || !Number.isSafeInteger(raw.writeEpoch) || raw.writeEpoch < 0) {
    fail('Invalid loaded workspace state')
  }
  const loadedRanges = captureFrozenRanges(raw.loadedRanges)
  const specialists = captureFrozenMap(
    raw.specialistsById, 'state specialists', SPECIALIST_ID, validSpecialist,
  )
  const clients = captureFrozenMap(raw.clientsById, 'state clients', CLIENT_ID, validClient)
  const appointments = captureFrozenMap(
    raw.appointmentsById, 'state appointments', APPOINTMENT_ID, validAppointment,
  )
  const historicalClients = captureFrozenMap(
    raw.historicalClientsById, 'state historical clients', HISTORICAL_CLIENT_ID,
    validHistoricalClient,
  )
  const historicalOccurrences = captureFrozenMap(
    raw.historicalOccurrencesById, 'state historical occurrences',
    HISTORICAL_OCCURRENCE_ID, validHistoricalOccurrence,
  )
  if (raw.latestPopulatedMonth !== null && !validMonth(raw.latestPopulatedMonth)) {
    fail('Invalid state latest populated month')
  }
  const allIds = new Set()
  const registerId = (id) => {
    if (allIds.has(id)) fail('State entity ID collision')
    allIds.add(id)
  }
  for (const value of [
    ...specialists, ...clients, ...appointments, ...historicalClients,
    ...historicalOccurrences,
  ]) {
    registerId(safeProperty(value, 'id'))
  }
  const specialistIds = new Set(specialists.map((value) => safeProperty(value, 'id')))
  for (const value of clients) {
    const assignment = safeProperty(value, 'assignment')
    if (assignment !== null) {
      registerId(safeProperty(assignment, 'id'))
      if (!specialistIds.has(safeProperty(assignment, 'specialistId'))) {
        fail('State assignment does not resolve')
      }
    }
  }
  const clientIds = new Set(clients.map((value) => safeProperty(value, 'id')))
  const referencedClients = new Set()
  for (const value of appointments) {
    const charge = safeProperty(value, 'charge')
    const paymentEntries = safeProperty(value, 'paymentEntries')
    registerId(safeProperty(charge, 'id'))
    for (const entry of paymentEntries) registerId(safeProperty(entry, 'id'))
    if (!clientIds.has(safeProperty(value, 'clientId'))) {
      fail('State appointment client does not resolve')
    }
    referencedClients.add(safeProperty(value, 'clientId'))
    const date = warsawCivilDate(safeProperty(value, 'startsAt'))
    if (!loadedRanges.some((loaded) => inRange(date, loaded))) {
      fail('State appointment is outside loaded coverage')
    }
  }
  for (const value of clients) {
    if (safeProperty(value, 'status') === 'archived'
      && !referencedClients.has(safeProperty(value, 'id'))) {
      fail('State contains unreferenced archived client')
    }
  }
  const historicalClientIds = new Set(historicalClients
    .map((value) => safeProperty(value, 'id')))
  const historicalReferences = new Set()
  const historicalSpecialistReferences = new Set()
  const historicalSources = new Set()
  const historicalCounterparties = new Map()
  for (const value of historicalOccurrences) {
    if (!specialistIds.has(safeProperty(value, 'specialistId'))
      || !historicalCoveredByRanges(value, loadedRanges)) {
      fail('State historical occurrence is outside loaded coverage')
    }
    historicalSpecialistReferences.add(safeProperty(value, 'specialistId'))
    const sourceId = safeProperty(value, 'sourceRecordId')
    if (historicalSources.has(sourceId)) fail('State historical source collision')
    historicalSources.add(sourceId)
    const historicalClientId = safeProperty(value, 'historicalClientId')
    if (historicalClientId !== null) {
      if (!historicalClientIds.has(historicalClientId)) {
        fail('State historical client does not resolve')
      }
      historicalReferences.add(historicalClientId)
    } else {
      const counterparty = safeProperty(value, 'counterparty')
      const id = safeProperty(counterparty, 'id')
      const name = safeProperty(counterparty, 'name')
      const prior = historicalCounterparties.get(id)
      if (prior !== undefined && prior !== name) fail('State counterparty identity changed')
      historicalCounterparties.set(id, name)
    }
  }
  if (specialists.some((value) => safeProperty(value, 'status') === 'archived'
    && !historicalSpecialistReferences.has(safeProperty(value, 'id')))) {
    fail('State contains unreferenced archived specialist')
  }
  if (historicalClients.some((value) => (
    !historicalReferences.has(safeProperty(value, 'id'))
    || (safeProperty(value, 'activeClientId') !== null
      && !clientIds.has(safeProperty(value, 'activeClientId')))
  ))) fail('State historical client relationship does not resolve')
  const visibleHistoricalLatest = maxRecordedHistoricalMonth(historicalOccurrences)
  if (visibleHistoricalLatest !== null
    && (raw.latestPopulatedMonth === null
      || raw.latestPopulatedMonth < visibleHistoricalLatest)) {
    fail('State historical latest populated month is inconsistent')
  }
  return Object.freeze({
    state,
    loadedRanges,
    specialistsById: raw.specialistsById,
    clientsById: raw.clientsById,
    appointmentsById: raw.appointmentsById,
    historicalClientsById: raw.historicalClientsById,
    historicalOccurrencesById: raw.historicalOccurrencesById,
    latestPopulatedMonth: raw.latestPopulatedMonth,
    authorityGeneration: raw.authorityGeneration,
    writeEpoch: raw.writeEpoch,
  })
}

export const createLoadedWorkspaceState = () => stateFrom({
  loadedRanges: [],
  specialistsById: Object.freeze(Object.create(null)),
  clientsById: Object.freeze(Object.create(null)),
  appointmentsById: Object.freeze(Object.create(null)),
  historicalClientsById: Object.freeze(Object.create(null)),
  historicalOccurrencesById: Object.freeze(Object.create(null)),
  latestPopulatedMonth: null,
  authorityGeneration: 0,
  writeEpoch: 0,
})

export const resetLoadedWorkspaceAuthority = (state) => {
  const current = authenticateState(state)
  if (current.authorityGeneration === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Authority generation exhausted')
  }
  return stateFrom({
    loadedRanges: [],
    specialistsById: Object.freeze(Object.create(null)),
    clientsById: Object.freeze(Object.create(null)),
    appointmentsById: Object.freeze(Object.create(null)),
    historicalClientsById: Object.freeze(Object.create(null)),
    historicalOccurrencesById: Object.freeze(Object.create(null)),
    latestPopulatedMonth: null,
    authorityGeneration: current.authorityGeneration + 1,
    writeEpoch: 0,
  })
}

export const captureLoadedWorkspaceLoad = (state, requested) => {
  const current = authenticateState(state)
  const captured = captureRange(requested)
  return Object.freeze({
    ...captured,
    authorityGeneration: current.authorityGeneration,
    writeEpoch: current.writeEpoch,
  })
}

export const recordLoadedWorkspaceWrite = (state) => {
  const current = authenticateState(state)
  if (current.writeEpoch === Number.MAX_SAFE_INTEGER) throw new RangeError('Write epoch exhausted')
  return stateFrom({
    loadedRanges: current.loadedRanges,
    specialistsById: current.specialistsById,
    clientsById: current.clientsById,
    appointmentsById: current.appointmentsById,
    historicalClientsById: current.historicalClientsById,
    historicalOccurrencesById: current.historicalOccurrencesById,
    latestPopulatedMonth: current.latestPopulatedMonth,
    authorityGeneration: current.authorityGeneration,
    writeEpoch: current.writeEpoch + 1,
  })
}

export const isWorkspaceWindowLoaded = (state, requested) => {
  const current = authenticateState(state)
  const wanted = captureRange(requested)
  return current.loadedRanges.some((loaded) => (
    loaded.from <= wanted.from && loaded.to >= wanted.to
  ))
}

export const mergeLoadedWorkspaceLoad = (state, rawCapture, rawPayload) => {
  const current = authenticateState(state)
  const capture = captureLoad(rawCapture)
  const payload = capturePayload(rawPayload, capture)
  if (capture.authorityGeneration !== current.authorityGeneration) {
    return Object.freeze({ state, outcome: 'ignored-authority', refetch: false })
  }
  if (capture.writeEpoch !== current.writeEpoch) {
    return Object.freeze({ state, outcome: 'stale-write', refetch: true })
  }

  const retainedAppointments = Object.values(current.appointmentsById)
    .filter((value) => !inRange(
      warsawCivilDate(safeProperty(value, 'startsAt')), payload.windowRange,
    ))
  const appointmentIds = new Set(retainedAppointments.map((value) => safeProperty(value, 'id')))
  for (const value of payload.appointments) {
    if (appointmentIds.has(safeProperty(value, 'id'))) {
      fail('Appointment ID collides outside replaced window')
    }
    appointmentIds.add(safeProperty(value, 'id'))
    retainedAppointments.push(value)
  }
  const retainedLedgerIds = new Set()
  for (const value of retainedAppointments) {
    const chargeId = safeProperty(safeProperty(value, 'charge'), 'id')
    const paymentIds = safeProperty(value, 'paymentEntries')
      .map((entry) => safeProperty(entry, 'id'))
    for (const id of [chargeId, ...paymentIds]) {
      if (retainedLedgerIds.has(id)) fail('Retained ledger ID collision')
      retainedLedgerIds.add(id)
    }
  }

  const activeClients = payload.clients
    .filter((value) => safeProperty(value, 'status') !== 'archived')
  const activeClientIds = new Set(activeClients.map((value) => safeProperty(value, 'id')))
  const archivedById = Object.create(null)
  for (const value of Object.values(current.clientsById)) {
    if (safeProperty(value, 'status') === 'archived') {
      archivedById[safeProperty(value, 'id')] = value
    }
  }
  if (activeClients.some((value) => archivedById[safeProperty(value, 'id')])) {
    fail('Archived client cannot return to the active directory')
  }
  for (const value of payload.clients
    .filter((item) => safeProperty(item, 'status') === 'archived')) {
    const id = safeProperty(value, 'id')
    if (activeClientIds.has(id)) fail('Archived client collides with active directory')
    if (archivedById[id] && !structurallyEqual(archivedById[id], value)) {
      fail('Archived client identity changed')
    }
    archivedById[id] = value
  }

  const referencedClientIds = new Set(retainedAppointments
    .map((value) => safeProperty(value, 'clientId')))
  const payloadArchivedIds = new Set(payload.clients
    .filter((value) => safeProperty(value, 'status') === 'archived')
    .map((value) => safeProperty(value, 'id')))
  for (const id of payloadArchivedIds) {
    if (!referencedClientIds.has(id)) fail('Unreferenced archived client')
  }
  const retainedClients = [...activeClients]
  for (const [id, value] of Object.entries(archivedById)) {
    if (referencedClientIds.has(id)) retainedClients.push(value)
  }
  const retainedClientIds = new Set(retainedClients.map((value) => safeProperty(value, 'id')))
  for (const value of retainedAppointments) {
    if (!retainedClientIds.has(safeProperty(value, 'clientId'))) {
      fail('Retained appointment has no client')
    }
  }

  const retainedHistoricalOccurrences = Object.values(current.historicalOccurrencesById)
    .filter((value) => !historicalCoveredBy(value, payload.windowRange))
  const historicalOccurrenceIds = new Set(retainedHistoricalOccurrences
    .map((value) => safeProperty(value, 'id')))
  const historicalSourceIds = new Set(retainedHistoricalOccurrences
    .map((value) => safeProperty(value, 'sourceRecordId')))
  for (const value of payload.historicalOccurrences) {
    if (historicalOccurrenceIds.has(safeProperty(value, 'id'))) {
      fail('Historical occurrence ID collides outside replaced coverage')
    }
    if (historicalSourceIds.has(safeProperty(value, 'sourceRecordId'))) {
      fail('Historical source identity collides outside replaced coverage')
    }
    historicalOccurrenceIds.add(safeProperty(value, 'id'))
    historicalSourceIds.add(safeProperty(value, 'sourceRecordId'))
    retainedHistoricalOccurrences.push(value)
  }
  const historicalCounterparties = new Map()
  const referencedHistoricalIds = new Set()
  const referencedHistoricalSpecialistIds = new Set()
  for (const value of retainedHistoricalOccurrences) {
    referencedHistoricalSpecialistIds.add(safeProperty(value, 'specialistId'))
    const historicalClientId = safeProperty(value, 'historicalClientId')
    if (historicalClientId !== null) {
      referencedHistoricalIds.add(historicalClientId)
      continue
    }
    const counterparty = safeProperty(value, 'counterparty')
    const id = safeProperty(counterparty, 'id')
    const name = safeProperty(counterparty, 'name')
    const prior = historicalCounterparties.get(id)
    if (prior !== undefined && prior !== name) fail('Retained counterparty identity changed')
    historicalCounterparties.set(id, name)
  }
  const payloadSpecialistsById = new Map(payload.specialists
    .map((value) => [safeProperty(value, 'id'), value]))
  const retainedSpecialists = payload.specialists.filter(
    (value) => safeProperty(value, 'status') === 'active',
  )
  const retainedSpecialistIds = new Set(retainedSpecialists
    .map((value) => safeProperty(value, 'id')))
  for (const id of referencedHistoricalSpecialistIds) {
    const payloadSource = payloadSpecialistsById.get(id)
    const priorSource = current.specialistsById[id]
    const source = payloadSource ?? (priorSource && safeProperty(priorSource, 'status') === 'active'
      ? historicalSpecialistSnapshot(priorSource)
      : priorSource)
    if (!source) fail('Retained historical occurrence has no specialist')
    if (!retainedSpecialistIds.has(id)) {
      retainedSpecialistIds.add(id)
      retainedSpecialists.push(source)
    }
  }
  const payloadHistoricalClients = new Map(payload.historicalClients
    .map((value) => [safeProperty(value, 'id'), value]))
  const retainedHistoricalClients = []
  for (const id of referencedHistoricalIds) {
    const source = payloadHistoricalClients.get(id) ?? current.historicalClientsById[id]
    if (!source) fail('Retained historical occurrence has no client')
    const activeClientId = safeProperty(source, 'activeClientId')
    retainedHistoricalClients.push(activeClientId === null || retainedClientIds.has(activeClientId)
      ? source
      : Object.freeze({ ...source, activeClientId: null }))
  }
  const visibleHistoricalLatest = maxRecordedHistoricalMonth(retainedHistoricalOccurrences)
  if (visibleHistoricalLatest !== null
    && (payload.latestPopulatedMonth === null
      || payload.latestPopulatedMonth < visibleHistoricalLatest)) {
    fail('Merged historical latest populated month is inconsistent')
  }

  const nextState = stateFrom({
    loadedRanges: normalizeRanges(current.loadedRanges, payload.windowRange),
    specialistsById: mapFrom(retainedSpecialists),
    clientsById: mapFrom(retainedClients),
    appointmentsById: mapFrom(retainedAppointments),
    historicalClientsById: mapFrom(retainedHistoricalClients),
    historicalOccurrencesById: mapFrom(retainedHistoricalOccurrences),
    latestPopulatedMonth: payload.latestPopulatedMonth,
    authorityGeneration: current.authorityGeneration,
    writeEpoch: current.writeEpoch,
  })
  return Object.freeze({ state: nextState, outcome: 'merged', refetch: false })
}
