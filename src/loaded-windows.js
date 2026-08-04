const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const ASSIGNMENT_ID = /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CHARGE_ID = /^chg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/

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

// Proleptic Gregorian day number; unlike Date construction it also handles year 0000.
const civilOrdinal = (value) => {
  if (typeof value !== 'string') return null
  const match = CIVIL_DATE.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
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
  if (keys.some((key) => typeof key !== 'string')) fail('Invalid canonical entity')
  const result = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail('Invalid canonical entity')
    }
    result[key] = captureSerializable(descriptor.value, seen)
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

const validSpecialist = (value) => value.status === 'active'

const validClient = (value) => {
  if (!['active', 'paused', 'archived'].includes(value.status)) return false
  if (value.status === 'archived') return value.readOnly === true && value.assignment === null
  if (value.readOnly !== false) return false
  return value.assignment === null || (
    value.assignment !== null && typeof value.assignment === 'object'
    && typeof value.assignment.id === 'string'
    && ASSIGNMENT_ID.test(value.assignment.id)
    && typeof value.assignment.specialistId === 'string'
    && SPECIALIST_ID.test(value.assignment.specialistId)
  )
}

const validInstant = (value) => {
  if (typeof value !== 'string' || !INSTANT.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}

const validAppointment = (value) => typeof value.clientId === 'string'
  && CLIENT_ID.test(value.clientId)
  && typeof value.specialistId === 'string'
  && SPECIALIST_ID.test(value.specialistId)
  && validInstant(value.startsAt)
  && value.charge !== null && typeof value.charge === 'object'
  && typeof value.charge.id === 'string' && CHARGE_ID.test(value.charge.id)
  && Array.isArray(value.paymentEntries)
  && value.paymentEntries.every((entry) => entry !== null && typeof entry === 'object'
    && typeof entry.id === 'string' && PAYMENT_ID.test(entry.id))

const mapFrom = (values) => {
  const result = Object.create(null)
  for (const value of values) result[value.id] = value
  return Object.freeze(result)
}

const stateFrom = ({
  loadedRanges,
  specialistsById,
  clientsById,
  appointmentsById,
  authorityGeneration,
  writeEpoch,
}) => Object.freeze({
  loadedRanges: Object.freeze(loadedRanges),
  specialistsById,
  clientsById,
  appointmentsById,
  authorityGeneration,
  writeEpoch,
})

const assertState = (state) => {
  if (state === null || typeof state !== 'object'
    || !Number.isSafeInteger(state.authorityGeneration) || state.authorityGeneration < 0
    || !Number.isSafeInteger(state.writeEpoch) || state.writeEpoch < 0
    || !Array.isArray(state.loadedRanges)
    || state.specialistsById === null || typeof state.specialistsById !== 'object'
    || state.clientsById === null || typeof state.clientsById !== 'object'
    || state.appointmentsById === null || typeof state.appointmentsById !== 'object') {
    fail('Invalid loaded workspace state')
  }
}

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
  return `${parts.year}-${parts.month}-${parts.day}`
}

const inRange = (date, rangeValue) => date >= rangeValue.from && date <= rangeValue.to

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
    payload, ['window', 'specialists', 'clients', 'appointments'], 'workspace payload',
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
  const allIds = new Set()
  const registerId = (id) => {
    if (allIds.has(id)) fail('Cross-type entity ID collision')
    allIds.add(id)
  }
  for (const entity of [...specialists, ...clients, ...appointments]) registerId(entity.id)
  for (const value of clients) {
    if (value.assignment !== null) registerId(value.assignment.id)
  }
  for (const value of appointments) {
    registerId(value.charge.id)
    for (const entry of value.paymentEntries) registerId(entry.id)
  }
  const specialistIds = new Set(specialists.map((value) => value.id))
  for (const value of clients) {
    if (value.assignment !== null && !specialistIds.has(value.assignment.specialistId)) {
      fail('Client assignment does not resolve')
    }
  }
  const clientIds = new Set(clients.map((value) => value.id))
  for (const value of appointments) {
    if (!clientIds.has(value.clientId)
      || !inRange(warsawCivilDate(value.startsAt), windowRange)) {
      fail('Appointment relationship does not resolve')
    }
  }
  return { windowRange, specialists, clients, appointments }
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

export const createLoadedWorkspaceState = () => stateFrom({
  loadedRanges: [],
  specialistsById: Object.freeze(Object.create(null)),
  clientsById: Object.freeze(Object.create(null)),
  appointmentsById: Object.freeze(Object.create(null)),
  authorityGeneration: 0,
  writeEpoch: 0,
})

export const resetLoadedWorkspaceAuthority = (state) => {
  assertState(state)
  if (state.authorityGeneration === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Authority generation exhausted')
  }
  return stateFrom({
    loadedRanges: [],
    specialistsById: Object.freeze(Object.create(null)),
    clientsById: Object.freeze(Object.create(null)),
    appointmentsById: Object.freeze(Object.create(null)),
    authorityGeneration: state.authorityGeneration + 1,
    writeEpoch: 0,
  })
}

export const captureLoadedWorkspaceLoad = (state, requested) => {
  assertState(state)
  const captured = captureRange(requested)
  return Object.freeze({
    ...captured,
    authorityGeneration: state.authorityGeneration,
    writeEpoch: state.writeEpoch,
  })
}

export const recordLoadedWorkspaceWrite = (state) => {
  assertState(state)
  if (state.writeEpoch === Number.MAX_SAFE_INTEGER) throw new RangeError('Write epoch exhausted')
  return stateFrom({
    ...state,
    writeEpoch: state.writeEpoch + 1,
  })
}

export const isWorkspaceWindowLoaded = (state, requested) => {
  assertState(state)
  const wanted = captureRange(requested)
  return state.loadedRanges.some((loaded) => (
    loaded.from <= wanted.from && loaded.to >= wanted.to
  ))
}

export const mergeLoadedWorkspaceLoad = (state, rawCapture, rawPayload) => {
  assertState(state)
  const capture = captureLoad(rawCapture)
  const payload = capturePayload(rawPayload, capture)
  if (capture.authorityGeneration !== state.authorityGeneration) {
    return Object.freeze({ state, outcome: 'ignored-authority', refetch: false })
  }
  if (capture.writeEpoch !== state.writeEpoch) {
    return Object.freeze({ state, outcome: 'stale-write', refetch: true })
  }

  const retainedAppointments = Object.values(state.appointmentsById)
    .filter((value) => !inRange(warsawCivilDate(value.startsAt), payload.windowRange))
  const appointmentIds = new Set(retainedAppointments.map((value) => value.id))
  for (const value of payload.appointments) {
    if (appointmentIds.has(value.id)) fail('Appointment ID collides outside replaced window')
    appointmentIds.add(value.id)
    retainedAppointments.push(value)
  }
  const retainedLedgerIds = new Set()
  for (const value of retainedAppointments) {
    for (const id of [value.charge.id, ...value.paymentEntries.map((entry) => entry.id)]) {
      if (retainedLedgerIds.has(id)) fail('Retained ledger ID collision')
      retainedLedgerIds.add(id)
    }
  }

  const activeClients = payload.clients.filter((value) => value.status !== 'archived')
  const activeClientIds = new Set(activeClients.map((value) => value.id))
  const archivedById = Object.create(null)
  for (const value of Object.values(state.clientsById)) {
    if (value.status === 'archived') archivedById[value.id] = value
  }
  if (activeClients.some((value) => archivedById[value.id])) {
    fail('Archived client cannot return to the active directory')
  }
  for (const value of payload.clients.filter((item) => item.status === 'archived')) {
    if (activeClientIds.has(value.id)) fail('Archived client collides with active directory')
    if (archivedById[value.id] && !structurallyEqual(archivedById[value.id], value)) {
      fail('Archived client identity changed')
    }
    archivedById[value.id] = value
  }

  const referencedClientIds = new Set(retainedAppointments.map((value) => value.clientId))
  const payloadArchivedIds = new Set(payload.clients
    .filter((value) => value.status === 'archived').map((value) => value.id))
  for (const id of payloadArchivedIds) {
    if (!referencedClientIds.has(id)) fail('Unreferenced archived client')
  }
  const retainedClients = [...activeClients]
  for (const [id, value] of Object.entries(archivedById)) {
    if (referencedClientIds.has(id)) retainedClients.push(value)
  }
  const retainedClientIds = new Set(retainedClients.map((value) => value.id))
  for (const value of retainedAppointments) {
    if (!retainedClientIds.has(value.clientId)) fail('Retained appointment has no client')
  }

  const nextState = stateFrom({
    loadedRanges: normalizeRanges(state.loadedRanges, payload.windowRange),
    specialistsById: mapFrom(payload.specialists),
    clientsById: mapFrom(retainedClients),
    appointmentsById: mapFrom(retainedAppointments),
    authorityGeneration: state.authorityGeneration,
    writeEpoch: state.writeEpoch,
  })
  return Object.freeze({ state: nextState, outcome: 'merged', refetch: false })
}
