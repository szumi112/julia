import {
  captureHistoricalClient,
  captureHistoricalOccurrence,
  compareHistoricalClients,
  compareHistoricalOccurrences,
} from './historical-records.js'
import { captureLoadedActivitiesState } from './loaded-activities.js'
import { assertProfessionalTitle } from './core-records.js'

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const CIVIL_MONTH = /^(\d{4})-(\d{2})$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const PRESENTATION_COLORS = Object.freeze([
  'var(--pink-deep)', 'var(--sky-deep)', 'var(--amber-deep)', 'var(--coral-deep)',
])

const warsawDateTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23',
})

const fail = (label) => {
  throw new TypeError(`Invalid ${label}`)
}

const cloneCanonicalActivityValue = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isSafeInteger(value))) return value
  let descriptors
  try {
    if (!value || typeof value !== 'object') fail('activity projection')
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail('activity projection')
      descriptors = Object.getOwnPropertyDescriptors(value)
      const length = descriptors.length?.value
      if (!Number.isSafeInteger(length) || length < 0
        || Reflect.ownKeys(descriptors).length !== length + 1) fail('activity projection')
      const result = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          fail('activity projection')
        }
        result.push(cloneCanonicalActivityValue(descriptor.value))
      }
      return Object.freeze(result)
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) fail('activity projection')
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch { fail('activity projection') }
  const result = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (typeof key !== 'string' || !descriptor?.enumerable
      || !Object.hasOwn(descriptor, 'value')) fail('activity projection')
    result[key] = cloneCanonicalActivityValue(descriptor.value)
  }
  return Object.freeze(result)
}

const projectedActivityMap = (map) => {
  const descriptors = Object.getOwnPropertyDescriptors(map)
  const result = []
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (typeof key !== 'string' || !descriptor?.enumerable
      || !Object.hasOwn(descriptor, 'value')) fail('activity projection')
    result.push(cloneCanonicalActivityValue(descriptor.value))
  }
  return Object.freeze(result.sort((left, right) => left.id.localeCompare(right.id)))
}

export const projectLoadedActivities = (source) => {
  const state = captureLoadedActivitiesState(source)
  return Object.freeze({
    loadedMonths: cloneCanonicalActivityValue(state.loadedMonths),
    latestPopulatedMonths: cloneCanonicalActivityValue(state.latestPopulatedMonths),
    programs: projectedActivityMap(state.programsById),
    groups: projectedActivityMap(state.groupsById),
    groupLeaders: projectedActivityMap(state.groupLeadersById),
    participants: projectedActivityMap(state.participantsById),
    memberships: projectedActivityMap(state.membershipsById),
    classes: projectedActivityMap(state.classesById),
    attendance: projectedActivityMap(state.attendanceById),
    charges: projectedActivityMap(state.chargesById),
    payments: projectedActivityMap(state.paymentsById),
  })
}

const daysInMonth = (year, month) => {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

const civilParts = (value, label = 'workspace date') => {
  if (typeof value !== 'string') fail(label)
  const match = CIVIL_DATE.exec(value)
  if (!match) fail(label)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    fail(label)
  }
  return { year, month, day }
}

const civilOrdinal = (value, label) => {
  const { year, month, day } = civilParts(value, label)
  const adjustedYear = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(adjustedYear / 400)
  const yearOfEra = adjustedYear - era * 400
  const adjustedMonth = month + (month > 2 ? -3 : 9)
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1
  return era * 146097 + yearOfEra * 365 + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100) + dayOfYear
}

const civilString = ({ year, month, day }) => (
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
)

const addCivilDays = (value, amount) => {
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > 366) fail('workspace day offset')
  const parts = civilParts(value)
  const step = amount < 0 ? -1 : 1
  for (let remaining = Math.abs(amount); remaining > 0; remaining -= 1) {
    parts.day += step
    if (parts.day > daysInMonth(parts.year, parts.month)) {
      parts.day = 1
      parts.month += 1
      if (parts.month > 12) {
        parts.month = 1
        parts.year += 1
      }
    } else if (parts.day < 1) {
      parts.month -= 1
      if (parts.month < 1) {
        parts.month = 12
        parts.year -= 1
      }
      if (parts.year < 1) fail('workspace date')
      parts.day = daysInMonth(parts.year, parts.month)
    }
    if (parts.year > 9999) fail('workspace date')
  }
  return civilString(parts)
}

const exactDataObject = (value, label) => {
  let descriptors
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) fail(label)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail(label)
  }
  const result = Object.create(null)
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(label)
    }
    result[key] = descriptor.value
  }
  return result
}

const frozenMapValues = (value, label) => {
  let descriptors
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== null || !Object.isFrozen(value)) fail(label)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail(label)
  }
  const result = []
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(label)
    }
    const item = exactDataObject(descriptor.value, label)
    if (item.id !== key) fail(label)
    result.push(item)
  }
  return result
}

const safeInteger = (value, minimum, maximum, label) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(label)
  return value
}

const safeText = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) fail(label)
  return value
}

const frozenRecord = (value) => Object.freeze(value)

const presentationColor = (id) => {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash + id.charCodeAt(index)) % 4
  return PRESENTATION_COLORS[hash]
}

const professionalTitle = (value) => {
  try { return assertProfessionalTitle(value) } catch { fail('workspace specialist') }
}

const warsawParts = (value, label) => {
  if (typeof value !== 'string' || !INSTANT.test(value)) fail(label)
  const instant = new Date(value)
  if (!Number.isFinite(instant.valueOf()) || instant.toISOString() !== value) fail(label)
  const parts = Object.fromEntries(warsawDateTime.formatToParts(instant)
    .filter(({ type }) => type !== 'literal').map(({ type, value: part }) => [type, part]))
  return frozenRecord({
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    epoch: instant.valueOf(),
  })
}

const projectSpecialist = (item) => frozenRecord({
  id: safeText(item.id, 'workspace specialist'),
  name: safeText(item.displayName, 'workspace specialist'),
  professionalTitle: professionalTitle(item.professionalTitle),
  rate: safeInteger(item.standardRateGrosze, 1, 1_000_000, 'workspace specialist') / 100,
  color: presentationColor(item.id),
  status: ['active', 'archived'].includes(item.status)
    ? item.status : fail('workspace specialist'),
  version: safeInteger(item.version, 1, Number.MAX_SAFE_INTEGER, 'workspace specialist'),
  staffVersion: item.staffVersion === null ? null
    : safeInteger(item.staffVersion, 1, Number.MAX_SAFE_INTEGER, 'workspace specialist'),
  ...(Object.hasOwn(item, 'accessStatus') ? {
    accessStatus: ['unclaimed', 'invited', 'enabled'].includes(item.accessStatus)
      ? item.accessStatus : fail('workspace specialist'),
  } : {}),
})

const projectClient = (item) => {
  const status = ['active', 'paused', 'archived'].includes(item.status)
    ? item.status
    : fail('workspace client')
  const readOnly = typeof item.readOnly === 'boolean' ? item.readOnly : fail('workspace client')
  let psychId = null
  if (item.assignment !== null) {
    const assignment = exactDataObject(item.assignment, 'workspace assignment')
    psychId = safeText(assignment.specialistId, 'workspace assignment')
  }
  if ((status === 'archived') !== readOnly || (status === 'archived' && psychId !== null)) {
    fail('workspace client')
  }
  return frozenRecord({
    id: safeText(item.id, 'workspace client'),
    name: safeText(item.name, 'workspace client'),
    age: item.age === null ? null : safeInteger(item.age, 1, 26, 'workspace client'),
    status,
    psychId,
    version: safeInteger(item.version, 1, Number.MAX_SAFE_INTEGER, 'workspace client'),
    readOnly,
    since: warsawParts(item.createdAt, 'workspace client').date,
  })
}

const projectAppointment = (item, clientIds, specialistIds, clientsById) => {
  const start = warsawParts(item.startsAt, 'workspace appointment')
  const end = warsawParts(item.endsAt, 'workspace appointment')
  const duration = (end.epoch - start.epoch) / 60_000
  safeInteger(duration, 1, 1_440, 'workspace appointment')
  const charge = exactDataObject(item.charge, 'workspace charge')
  const payment = exactDataObject(item.payment, 'workspace payment')
  const clientId = safeText(item.clientId, 'workspace appointment')
  const specialistId = safeText(item.specialistId, 'workspace appointment')
  const status = ['scheduled', 'completed', 'cancelled', 'noshow'].includes(item.status)
    ? item.status
    : fail('workspace appointment')
  const paidDate = payment.latestReceivedAt === null
    ? null
    : warsawParts(payment.latestReceivedAt, 'workspace payment').date
  const client = clientsById.get(clientId)
  return frozenRecord({
    id: safeText(item.id, 'workspace appointment'),
    clientId,
    psychId: specialistId,
    service: safeText(item.serviceId, 'workspace appointment'),
    date: start.date,
    time: start.time,
    duration,
    amount: safeInteger(charge.expectedAmountGrosze, 1, 1_000_000, 'workspace charge') / 100,
    location: item.location === null || typeof item.location === 'string'
      ? item.location
      : fail('workspace appointment'),
    status,
    version: safeInteger(item.version, 1, 4_096, 'workspace appointment'),
    payment: ['paid', 'unpaid', 'partial'].includes(payment.status)
      ? payment.status
      : fail('workspace payment'),
    paidAmount: safeInteger(payment.collectedGrosze, 0, 1_000_000, 'workspace payment') / 100,
    method: payment.latestMethod === null || typeof payment.latestMethod === 'string'
      ? payment.latestMethod
      : fail('workspace payment'),
    paidDate,
    readOnly: !clientIds.has(clientId) || !specialistIds.has(specialistId) || client?.readOnly === true,
  })
}

const projectHistoricalClient = (item) => {
  try { return captureHistoricalClient({ ...item }) } catch { fail('workspace historical client') }
}

const projectHistoricalOccurrence = (item) => {
  try { return captureHistoricalOccurrence({ ...item }) } catch { fail('workspace historical occurrence') }
}

export const projectLoadedWorkspace = (state) => {
  const captured = exactDataObject(state, 'loaded workspace')
  const specialists = frozenMapValues(captured.specialistsById, 'workspace specialists')
    .map(projectSpecialist)
    .toSorted((left, right) => left.name.localeCompare(right.name, 'pl') || left.id.localeCompare(right.id))
  const activeSpecialists = specialists.filter(({ status }) => status === 'active')
  const allClients = frozenMapValues(captured.clientsById, 'workspace clients').map(projectClient)
  const rawAppointments = frozenMapValues(captured.appointmentsById, 'workspace appointments')
  const referencedClientIds = new Set(rawAppointments.map((item) => safeText(item.clientId, 'workspace appointment')))
  const clients = allClients
    .filter((item) => item.status !== 'archived' || referencedClientIds.has(item.id))
    .toSorted((left, right) => left.name.localeCompare(right.name, 'pl') || left.id.localeCompare(right.id))
  const clientIds = new Set(clients.map(({ id }) => id))
  const specialistIds = new Set(specialists.map(({ id }) => id))
  const clientsById = new Map(clients.map((item) => [item.id, item]))
  const sessions = rawAppointments
    .map((item) => projectAppointment(item, clientIds, specialistIds, clientsById))
    .toSorted((left, right) => `${left.date}${left.time}${left.id}`.localeCompare(`${right.date}${right.time}${right.id}`))
  const historicalClients = frozenMapValues(
    captured.historicalClientsById, 'workspace historical clients',
  ).map(projectHistoricalClient).toSorted(compareHistoricalClients)
  const historicalOccurrences = frozenMapValues(
    captured.historicalOccurrencesById, 'workspace historical occurrences',
  ).map(projectHistoricalOccurrence).toSorted(compareHistoricalOccurrences)
  const historicalClientIds = new Set(historicalClients.map(({ id }) => id))
  const referencedHistoricalClientIds = new Set()
  const referencedHistoricalSpecialistIds = new Set()
  const historicalCounterparties = new Map()
  for (const occurrence of historicalOccurrences) {
    if (!specialistIds.has(occurrence.specialistId)) fail('workspace historical occurrence')
    referencedHistoricalSpecialistIds.add(occurrence.specialistId)
    if (occurrence.historicalClientId !== null) {
      if (!historicalClientIds.has(occurrence.historicalClientId)) {
        fail('workspace historical occurrence')
      }
      referencedHistoricalClientIds.add(occurrence.historicalClientId)
    } else {
      const previous = historicalCounterparties.get(occurrence.counterparty.id)
      if (previous !== undefined && previous !== occurrence.counterparty.name) {
        fail('workspace historical occurrence')
      }
      historicalCounterparties.set(occurrence.counterparty.id, occurrence.counterparty.name)
    }
  }
  if (historicalClients.some((item) => !referencedHistoricalClientIds.has(item.id)
    || (item.activeClientId !== null && !clientIds.has(item.activeClientId)))) {
    fail('workspace historical client')
  }
  const latestPopulatedMonth = captured.latestPopulatedMonth
  if (latestPopulatedMonth !== null) captureMonth(latestPopulatedMonth)
  const latestVisibleMonth = historicalOccurrences.reduce((latest, occurrence) => {
    const month = occurrence.status === 'recorded' && occurrence.period.precision !== 'unknown'
      ? occurrence.period.month : null
    return month !== null && (latest === null || month > latest) ? month : latest
  }, null)
  if (latestVisibleMonth !== null
    && (latestPopulatedMonth === null || latestPopulatedMonth < latestVisibleMonth)) {
    fail('workspace latest populated month')
  }
  const historicalSpecialists = specialists.filter(({ id }) => (
    referencedHistoricalSpecialistIds.has(id)
  ))
  return frozenRecord({
    psychologists: Object.freeze(activeSpecialists),
    historicalSpecialists: Object.freeze(historicalSpecialists),
    clients: Object.freeze(clients),
    sessions: Object.freeze(sessions),
    historicalClients: Object.freeze(historicalClients),
    historicalOccurrences: Object.freeze(historicalOccurrences),
    latestPopulatedMonth,
  })
}

const identityList = (items, label) => {
  if (!Array.isArray(items)) fail(label)
  return items
}

export const clientIdentityFor = (clients, id) => {
  const item = identityList(clients, 'workspace clients').find((candidate) => candidate.id === id)
  return frozenRecord(item
    ? { name: item.name, available: true, readOnly: item.readOnly === true }
    : { name: 'Klient niedostępny', available: false, readOnly: true })
}

export const specialistIdentityFor = (specialists, id) => {
  const item = identityList(specialists, 'workspace specialists').find((candidate) => candidate.id === id)
  return frozenRecord(item
    ? { name: item.name, color: item.color, available: true }
    : { name: 'Specjalistka niedostępna', color: null, available: false })
}

const captureMonth = (value) => {
  if (typeof value !== 'string') fail('workspace month')
  const match = CIVIL_MONTH.exec(value)
  if (!match) fail('workspace month')
  const year = Number(match[1])
  const month = Number(match[2])
  if (year < 1 || month < 1 || month > 12) fail('workspace month')
  return { year, month }
}

export const monthWorkspaceRange = (value) => {
  const { year, month } = captureMonth(value)
  return frozenRecord({
    from: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`,
    to: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${daysInMonth(year, month)}`,
  })
}

export const weekWorkspaceRange = (value) => {
  const ordinal = civilOrdinal(value, 'workspace week')
  const mondayOrdinal = civilOrdinal('1970-01-05', 'workspace week')
  const offset = ((ordinal - mondayOrdinal) % 7 + 7) % 7
  const from = addCivilDays(value, -offset)
  return frozenRecord({ from, to: addCivilDays(from, 6) })
}

export const rollingWorkspaceRange = (value, days = 93) => {
  civilParts(value, 'workspace rolling window')
  if (!Number.isSafeInteger(days) || days < 1 || days > 93) fail('workspace rolling window')
  return frozenRecord({ from: addCivilDays(value, -(days - 1)), to: value })
}

const captureRange = (value, label = 'workspace range') => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(label)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== 2 || !keys.includes('from') || !keys.includes('to')) fail(label)
  for (const key of keys) {
    if (typeof key !== 'string' || !descriptors[key]?.enumerable
      || !Object.hasOwn(descriptors[key], 'value')) fail(label)
  }
  const from = descriptors.from.value
  const to = descriptors.to.value
  const fromOrdinal = civilOrdinal(from, label)
  const toOrdinal = civilOrdinal(to, label)
  if (fromOrdinal > toOrdinal) fail(label)
  return { from, to, fromOrdinal, toOrdinal }
}

export const isWorkspaceRangeCovered = (ranges, requested) => {
  if (!Array.isArray(ranges)) fail('loaded ranges')
  const target = captureRange(requested)
  const normalized = ranges.map((item) => captureRange(item, 'loaded range'))
    .toSorted((left, right) => left.fromOrdinal - right.fromOrdinal)
  let cursor = target.fromOrdinal
  for (const item of normalized) {
    if (item.toOrdinal < cursor) continue
    if (item.fromOrdinal > cursor) return false
    cursor = item.toOrdinal + 1
    if (cursor > target.toOrdinal) return true
  }
  return false
}

export const workspaceRangeState = (status, ranges, requested) => {
  const covered = isWorkspaceRangeCovered(ranges, requested)
  if (covered) return 'ready'
  if (status === 'read-only-error') return 'unavailable'
  if (status === 'ready' || status === 'loading') return 'loading'
  fail('workspace status')
}
