// Pure compatibility adapters between canonical core records and the current demo reducer.
import {
  addElapsedMinutes,
  assertAppointmentPaymentTransition,
  assertCivilDate,
  assertCorrectionReason,
  assertId,
  assertLocation,
  assertWallTime,
  clientDto,
  paymentAggregate,
  specialistDto,
  validateAppointmentInput,
  validateClientInput,
  validatePaymentDateInput,
  validateWarsawDateWindow,
  warsawDateTimeFromUtc,
  warsawDateTimeToUtc,
  warsawNoonToUtc,
} from './core-records.js'
import { isBillable } from './format.js'
import { SERVICE_BY_ID } from './services.js'
import { createApiActivityRepository } from './activity-repository.js'

const API_METHODS = Object.freeze([
  'loadWorkspaceWindow', 'createClient', 'editClient', 'archiveClient',
  'activateHistoricalClient',
  'createAppointment', 'editAppointment', 'cancelAppointment', 'recordPayment',
  'correctPayment',
  'loadActivityWorkspace',
  'createActivityGroup', 'editActivityGroup',
  'createActivityParticipant', 'editActivityParticipant',
  'createActivityMembership', 'editActivityMembership',
  'createActivityClass', 'editActivityClass', 'setActivityAttendance',
  'createIdempotencyKey',
])
const ACTIVITY_API_METHODS = Object.freeze([
  'loadActivityWorkspace',
  'createActivityGroup', 'editActivityGroup',
  'createActivityParticipant', 'editActivityParticipant',
  'createActivityMembership', 'editActivityMembership',
  'createActivityClass', 'editActivityClass', 'setActivityAttendance',
  'createIdempotencyKey',
])
const REPOSITORY_METHODS = Object.freeze([
  'loadWindow', 'createClient', 'editClient', 'archiveClient', 'activateHistoricalClient',
  'createAppointment', 'editAppointment', 'cancelAppointment', 'recordPayment',
  'correctPayment',
])
const CLIENT_KEYS = Object.freeze(['name', 'age', 'status', 'specialistId'])
const APPOINTMENT_KEYS = Object.freeze([
  'clientId', 'specialistId', 'serviceId', 'date', 'time', 'durationMinutes',
  'expectedAmountGrosze', 'location', 'status',
])
const APPOINTMENT_EDIT_KEYS = Object.freeze(APPOINTMENT_KEYS.filter((key) => key !== 'clientId'))
const PAYMENT_KEYS = Object.freeze(['amountGrosze', 'method', 'paidDate'])
const CORRECTION_KEYS = Object.freeze(['reason', 'replacement'])
const HISTORICAL_ACTIVATION_KEYS = Object.freeze(['expectedVersion', 'specialistId'])
const STATE_KEYS = Object.freeze(['psychologists', 'clients', 'sessions'])
const collator = new Intl.Collator('pl-PL', { sensitivity: 'base', usage: 'sort' })
const actionKey = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const legacyIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const historicalClientIdPattern = /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const demoStatuses = new Set(['scheduled', 'completed', 'cancelled', 'noshow'])
const demoPaymentStatuses = new Set(['paid', 'partial', 'unpaid'])
const demoMethods = new Set(['cash', 'card', 'transfer', 'monthly'])

const fail = (field, code = 'VALIDATION_FAILED') => {
  throw new TypeError(`${code}/${field}`)
}

const captureRecord = (value, keys, field, { allowAdditional = false } = {}) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(field)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(descriptors)
    if (ownKeys.some((key) => typeof key !== 'string')
      || (!allowAdditional && ownKeys.length !== keys.length)
      || keys.some((key) => !Object.hasOwn(descriptors, key))
      || ownKeys.some((key) => !allowAdditional && !keys.includes(key))) fail(field)
    const captured = {}
    const capturedKeys = allowAdditional ? ownKeys : keys
    for (const key of capturedKeys) {
      const descriptor = descriptors[key]
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(field)
      captured[key] = descriptor.value
    }
    return captured
  } catch (error) {
    if (error instanceof TypeError && typeof error.message === 'string'
      && error.message.startsWith('VALIDATION_FAILED/')) throw error
    fail(field)
  }
}

const captureFunctionRecord = (value, keys, field) => {
  const captured = captureRecord(value, keys, field)
  for (const key of keys) if (typeof captured[key] !== 'function') fail(field)
  return captured
}

const appointmentVersion = (value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 4_096) fail('expectedVersion')
  return value
}

const clientVersion = (value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    fail('expectedVersion')
  }
  return value
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

const captureCollection = (value, maximum) => {
  try {
    if (!Array.isArray(value)) fail('state')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(descriptors)
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum
      || ownKeys.length !== length + 1 || ownKeys.some((key) => (
        key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)
          || Number(key) >= length)
      ))) fail('state')
    const captured = new Array(length)
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[index]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('state')
      captured[index] = descriptor.value
    }
    const iterated = Array.from(value)
    if (iterated.length !== captured.length
      || iterated.some((item, index) => item !== captured[index])) fail('state')
    return captured
  } catch (error) {
    if (error instanceof TypeError && typeof error.message === 'string'
      && error.message.startsWith('VALIDATION_FAILED/')) throw error
    fail('state')
  }
}

const captureClient = (input) => validateClientInput(captureRecord(input, CLIENT_KEYS, 'body'))

const captureAppointment = (input) => {
  const captured = captureRecord(input, APPOINTMENT_KEYS, 'body')
  validateAppointmentInput(captured)
  return captured
}

const captureAppointmentEdit = (input) => {
  const captured = captureRecord(input, APPOINTMENT_EDIT_KEYS, 'body')
  validateAppointmentInput({ clientId: 'cl_validation', ...captured })
  return captured
}

const capturePayment = (input) => {
  const captured = captureRecord(input, PAYMENT_KEYS, 'body')
  const canonical = validatePaymentDateInput(captured)
  return { ...captured, receivedAt: canonical.receivedAt }
}

const paymentCommandInput = ({ amountGrosze, method, receivedAt }) => ({
  amountGrosze, method, receivedAt,
})

const captureCorrection = (input) => {
  const captured = captureRecord(input, CORRECTION_KEYS, 'body')
  assertCorrectionReason(captured.reason)
  return {
    reason: captured.reason,
    replacement: captured.replacement === null ? null : capturePayment(captured.replacement),
  }
}

const captureHistoricalActivation = (input) => {
  const captured = captureRecord(input, HISTORICAL_ACTIVATION_KEYS, 'body')
  clientVersion(captured.expectedVersion)
  capturedId(captured.specialistId, 'specialist')
  return captured
}

const captureWindow = (input) => {
  const captured = captureRecord(input, ['from', 'to'], 'window')
  validateWarsawDateWindow(captured.from, captured.to)
  return captured
}

const capturedId = (value, kind, field) => assertId(value, kind, field)

const makeRepository = (methods, activities = null) => {
  const repository = {}
  for (const name of REPOSITORY_METHODS) repository[name] = methods[name]
  repository.activities = activities
  return Object.freeze(repository)
}

export function createApiWorkspaceRepository(options) {
  const { api: source } = captureRecord(options, ['api'], 'repository')
  const api = captureFunctionRecord(source, API_METHODS, 'api')
  const activityApi = Object.freeze(Object.fromEntries(
    ACTIVITY_API_METHODS.map((name) => [name, api[name]]),
  ))
  const activities = createApiActivityRepository({ api: activityApi })
  const action = async (invoke) => {
    const idempotencyKey = api.createIdempotencyKey()
    if (typeof idempotencyKey !== 'string' || !actionKey.test(idempotencyKey)) fail('idempotencyKey')
    return invoke(Object.freeze({ idempotencyKey }))
  }

  return makeRepository({
    async loadWindow(input) {
      const requested = captureWindow(input)
      return api.loadWorkspaceWindow(requested)
    },
    async createClient(input) {
      const requested = captureClient(input)
      return action((options) => api.createClient(requested, options))
    },
    async editClient(id, expectedVersion, input) {
      capturedId(id, 'client')
      clientVersion(expectedVersion)
      const requested = captureClient(input)
      return action((options) => api.editClient(id, expectedVersion, requested, options))
    },
    async archiveClient(id, expectedVersion) {
      capturedId(id, 'client')
      clientVersion(expectedVersion)
      return action((options) => api.archiveClient(id, expectedVersion, options))
    },
    async activateHistoricalClient(id, input) {
      if (typeof id !== 'string' || !historicalClientIdPattern.test(id)) {
        fail('historicalClientId')
      }
      const requested = captureHistoricalActivation(input)
      return action((options) => api.activateHistoricalClient(
        id, requested.expectedVersion, requested.specialistId, options,
      ))
    },
    async createAppointment(input) {
      const requested = captureAppointment(input)
      return action((options) => api.createAppointment(requested, options))
    },
    async editAppointment(id, expectedVersion, input) {
      capturedId(id, 'appointment')
      appointmentVersion(expectedVersion)
      const requested = captureAppointmentEdit(input)
      return action((options) => api.editAppointment(id, expectedVersion, requested, options))
    },
    async cancelAppointment(id, expectedVersion) {
      capturedId(id, 'appointment')
      appointmentVersion(expectedVersion)
      return action((options) => api.cancelAppointment(id, expectedVersion, options))
    },
    async recordPayment(id, expectedVersion, input) {
      capturedId(id, 'appointment')
      appointmentVersion(expectedVersion)
      const requested = capturePayment(input)
      const canonical = paymentCommandInput(requested)
      return action((options) => api.recordPayment(id, expectedVersion, canonical, options))
    },
    async correctPayment(id, expectedVersion, input) {
      capturedId(id, 'payment')
      appointmentVersion(expectedVersion)
      const requested = captureCorrection(input)
      const canonical = {
        reason: requested.reason,
        replacement: requested.replacement === null ? null : paymentCommandInput(requested.replacement),
      }
      return action((options) => api.correctPayment(id, expectedVersion, canonical, options))
    },
  }, activities)
}

const demoId = (kind, legacyId) => `${kind}_demo_${legacyId}`
const newId = (kind, sequence) => `${kind}_demo_new_${sequence}`
const allocateDemoId = ({ kind, after, maximum, occupied }) => {
  for (let offset = 1; offset <= maximum + 1; offset += 1) {
    const sequence = after + offset
    if (!Number.isSafeInteger(sequence)) fail(`${kind}Id`, 'DEMO_ID_EXHAUSTED')
    const id = newId(kind, sequence)
    if (!occupied(id)) return { id, sequence }
  }
  fail(`${kind}Id`, 'DEMO_ID_EXHAUSTED')
}
const legacyDate = (instant) => warsawDateTimeFromUtc(instant).date

const stateSnapshot = (getState) => {
  let raw
  try { raw = getState() } catch { fail('state') }
  const state = captureRecord(raw, STATE_KEYS, 'state', { allowAdditional: true })
  for (const key of STATE_KEYS) {
    state[key] = captureCollection(state[key], key === 'sessions' ? 500 : 200)
  }
  return state
}

const legacyRecord = (value, required, field) => captureRecord(
  value, required, field, { allowAdditional: true },
)

const assertLegacyId = (value, field) => {
  if (typeof value !== 'string' || !legacyIdPattern.test(value)) fail(field)
  return value
}

const groszeFromLegacy = (value, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(field)
  const grosze = value * 100
  if (!Number.isSafeInteger(grosze) || grosze > 1_000_000) fail(field)
  return grosze
}

const captureLegacySpecialist = (raw) => {
  const item = legacyRecord(raw, ['id', 'name', 'rate'], 'specialist')
  assertLegacyId(item.id, 'specialist')
  if (typeof item.name !== 'string') fail('specialist')
  groszeFromLegacy(item.rate, 'specialist')
  if (item.status !== undefined && item.status !== 'active' && item.status !== 'inactive') {
    fail('specialist')
  }
  return item
}

const captureLegacyClient = (raw) => {
  const item = legacyRecord(raw, ['id', 'name', 'age', 'psychId', 'since', 'status'], 'client')
  assertLegacyId(item.id, 'client')
  assertLegacyId(item.psychId, 'client')
  assertCivilDate(item.since, 'client')
  validateClientInput({
    name: item.name, age: item.age, status: item.status,
    specialistId: demoId('sp', item.psychId),
  })
  return item
}

const captureLegacyAppointment = (raw) => {
  const item = legacyRecord(raw, [
    'id', 'clientId', 'psychId', 'service', 'date', 'time', 'duration', 'amount',
    'status', 'payment', 'method',
  ], 'appointment')
  assertLegacyId(item.id, 'appointment')
  assertLegacyId(item.clientId, 'appointment')
  assertLegacyId(item.psychId, 'appointment')
  if (!demoStatuses.has(item.status) || !demoPaymentStatuses.has(item.payment)) fail('appointment')
  const expectedAmountGrosze = groszeFromLegacy(item.amount, 'appointment')
  const location = item.location === undefined ? null : assertLocation(item.location)
  assertCivilDate(item.date, 'appointment')
  assertWallTime(item.time, 'appointment')
  if (typeof item.service !== 'string' || !SERVICE_BY_ID[item.service]
    || !Number.isSafeInteger(item.duration)
    || item.duration !== SERVICE_BY_ID[item.service].duration) fail('appointment')
  const paidAmount = item.paidAmount === undefined ? 0 : item.paidAmount
  if (typeof paidAmount !== 'number' || !Number.isFinite(paidAmount) || paidAmount < 0) {
    fail('appointment')
  }
  const paidGrosze = Math.round(paidAmount * 100)
  if (!Number.isSafeInteger(paidGrosze)
    || Math.abs(paidAmount - paidGrosze / 100) > Number.EPSILON * 100) fail('appointment')
  if (item.method !== null && !demoMethods.has(item.method)) fail('appointment')
  if (item.paidDate !== undefined && item.paidDate !== null) assertCivilDate(item.paidDate, 'appointment')
  return { ...item, expectedAmountGrosze, location, paidAmount }
}

const initialInstant = (date) => warsawNoonToUtc(assertCivilDate(date, 'date'))
const sameClientRequest = (pending, item) => pending !== null
  && pending.name === item.name && pending.age === item.age
  && pending.status === item.status && pending.psychId === item.psychId
const sameAppointmentRequest = (pending, item) => pending !== null
  && pending.clientId === item.clientId && pending.psychId === item.psychId
  && pending.service === item.service && pending.date === item.date
  && pending.time === item.time && pending.duration === item.duration
  && pending.amount === item.amount && pending.status === item.status
  && pending.location === item.location

export function createDemoWorkspaceRepository(options) {
  const dependencies = captureFunctionRecord(options, ['dispatch', 'getState'], 'repository')
  const { dispatch, getState } = dependencies
  const specialists = new Map()
  const clients = new Map()
  const appointments = new Map()
  const payments = new Map()
  const paymentReservations = new Set()
  const correctionReservations = new Set()
  const clientMutationReservations = new Set()
  const appointmentMutationReservations = new Set()
  let clientSequence = 0
  let appointmentSequence = 0
  let paymentSequence = 0
  let correctionSequence = 0
  let logicalTime = Date.now()

  const commandInstant = (after = null) => {
    logicalTime = Math.max(logicalTime + 1, after === null ? 0 : new Date(after).getTime() + 1)
    return new Date(logicalTime).toISOString()
  }

  const syncDirectories = (state) => {
    const liveSpecialists = new Map()
    for (const raw of state.psychologists) {
      const item = captureLegacySpecialist(raw)
      if (item.status === 'inactive') continue
      const coreId = demoId('sp', item.id)
      if (liveSpecialists.has(coreId)) fail('specialist')
      liveSpecialists.set(coreId, { legacyId: item.id })
    }
    specialists.clear()
    for (const [id, value] of liveSpecialists) specialists.set(id, value)

    const liveClientIds = new Set()
    for (const raw of state.clients) {
      const item = captureLegacyClient(raw)
      if (liveClientIds.has(item.id)) fail('client')
      if (!specialists.has(demoId('sp', item.psychId))) fail('client')
      liveClientIds.add(item.id)
      const existing = [...clients.entries()].find(([, meta]) => meta.legacyId === item.id)
      if (!existing) {
        const awaiting = [...clients.values()].find((meta) => meta.legacyId === null
          && !meta.pending.knownIds.has(item.id) && sameClientRequest(meta.pending, item))
        if (awaiting) continue
        if (clients.size >= 200) fail('clients')
        const coreId = demoId('cl', item.id)
        const createdAt = initialInstant(item.since)
        clients.set(coreId, {
          legacyId: item.id, version: 1, createdAt, updatedAt: createdAt,
          archivedAt: null, assignmentId: demoId('asg', item.id),
          assignmentStartsAt: createdAt, assignmentVersion: 1, pending: null,
          origin: 'legacy',
        })
      }
    }
    for (const [id, meta] of clients) {
      if (meta.legacyId !== null && !liveClientIds.has(meta.legacyId)) clients.delete(id)
    }

    const liveAppointmentIds = new Set()
    for (const raw of state.sessions) {
      const item = captureLegacyAppointment(raw)
      if (liveAppointmentIds.has(item.id)) fail('appointment')
      liveAppointmentIds.add(item.id)
      const existing = [...appointments.entries()].find(([, meta]) => meta.legacyId === item.id)
      if (!existing) {
        const awaiting = [...appointments.values()].find((meta) => meta.legacyId === null
          && !meta.pending.knownIds.has(item.id) && sameAppointmentRequest(meta.pending, item))
        if (awaiting) continue
        if (appointments.size >= 500) fail('appointments')
        const coreId = demoId('apt', item.id)
        const createdAt = warsawDateTimeToUtc(item.date, item.time)
        const meta = {
          legacyId: item.id, version: 1, chargeVersion: 1, createdAt,
          updatedAt: createdAt, cancelledAt: item.status === 'cancelled' ? createdAt : null,
          entries: [], corrections: [], pending: null, origin: 'legacy',
        }
        const paidAmount = item.paidAmount
        if (paidAmount > 0) {
          const paymentId = demoId('pay', `${item.id}_1`)
          const receivedAt = initialInstant(typeof item.paidDate === 'string' ? item.paidDate : item.date)
          meta.entries.push({
            id: paymentId, appointmentId: coreId, amountGrosze: paidAmount * 100,
            method: item.method, receivedAt,
          })
          payments.set(paymentId, { appointmentId: coreId, entryIndex: 0 })
        }
        appointments.set(coreId, meta)
      }
    }
    for (const [id, meta] of appointments) {
      if (meta.legacyId !== null && !liveAppointmentIds.has(meta.legacyId)) {
        for (const entry of meta.entries) payments.delete(entry.id)
        appointments.delete(id)
      }
    }
  }

  const currentState = () => {
    const state = stateSnapshot(getState)
    syncDirectories(state)
    return state
  }

  const legacySpecialist = (coreId) => {
    capturedId(coreId, 'specialist')
    const value = specialists.get(coreId)
    if (!value) fail('specialistId', 'NOT_FOUND')
    return value.legacyId
  }

  const clientMeta = (coreId, state) => {
    capturedId(coreId, 'client')
    const meta = clients.get(coreId)
    if (!meta || meta.archivedAt !== null || findClient(state, meta) === undefined) {
      fail('clientId', 'NOT_FOUND')
    }
    return meta
  }

  const appointmentMeta = (coreId, state) => {
    capturedId(coreId, 'appointment')
    const meta = appointments.get(coreId)
    if (!meta || meta.cancelledAt !== null || findAppointment(state, meta) === undefined) {
      fail('appointmentId', 'NOT_FOUND')
    }
    return meta
  }

  const assertVersion = (actual, expected) => {
    appointmentVersion(expected)
    if (actual !== expected) fail('expectedVersion', 'VERSION_CONFLICT')
  }

  const assertDemoClientVersion = (actual, expected) => {
    clientVersion(expected)
    if (actual !== expected) fail('expectedVersion', 'VERSION_CONFLICT')
  }

  const observeState = async ({ before, inspect, snapshot }) => {
    // One immediate observation plus five macrotask turns bounds React reducer reconciliation.
    for (let turn = 0; turn <= 5; turn += 1) {
      const state = currentState()
      const accepted = inspect(state)
      if (accepted !== null) return accepted
      if (snapshot(state) !== before) fail('state', 'DEMO_STATE_MISMATCH')
      if (turn < 5) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    fail('state', 'DEMO_STATE_NOT_APPLIED')
  }

  const matchesClient = (item, requested, psychId) => item.name === requested.name
    && item.age === requested.age && item.status === requested.status
    && item.psychId === psychId

  const matchesAppointment = (item, requested, clientId, psychId) => item.clientId === clientId
    && item.psychId === psychId && item.service === requested.serviceId
    && item.date === requested.date && item.time === requested.time
    && item.duration === requested.durationMinutes
    && item.expectedAmountGrosze === requested.expectedAmountGrosze
    && item.location === requested.location && item.status === requested.status

  const matchesPaymentPatch = (item, patch) => item.payment === patch.payment
    && item.paidAmount === patch.paidAmount && item.method === patch.method
    && item.paidDate === patch.paidDate

  const paymentIdOccupied = (id) => paymentReservations.has(id) || payments.has(id)
    || [...appointments.values()].some((meta) => meta.entries.some((entry) => entry.id === id))

  const correctionIdOccupied = (id) => correctionReservations.has(id)
    || [...appointments.values()].some((meta) => meta.corrections.some((item) => item.id === id))

  const correctionCount = () => [...appointments.values()]
    .reduce((total, meta) => total + meta.corrections.length, correctionReservations.size)

  const assertMutationAvailable = (reservations, id) => {
    if (reservations.has(id)) fail('expectedVersion', 'VERSION_CONFLICT')
  }

  const serializeMutation = async (reservations, id, operation) => {
    assertMutationAvailable(reservations, id)
    reservations.add(id)
    try {
      return await operation()
    } finally {
      reservations.delete(id)
    }
  }

  const clientRowSignature = (raw) => {
    const item = captureLegacyClient(raw)
    return JSON.stringify([item.id, item.name, item.age, item.psychId, item.since, item.status])
  }

  const appointmentRowSignature = (raw) => {
    const item = captureLegacyAppointment(raw)
    return JSON.stringify([
      item.id, item.clientId, item.psychId, item.service, item.date, item.time,
      item.duration, item.expectedAmountGrosze, item.location, item.status, item.payment,
      item.paidAmount, item.method, item.paidDate ?? null,
    ])
  }

  const clientTargetSnapshot = (state, meta) => {
    const item = findClient(state, meta)
    return item === undefined ? null : clientRowSignature(item)
  }

  const appointmentTargetSnapshot = (state, meta) => {
    const item = findAppointment(state, meta)
    return item === undefined ? null : appointmentRowSignature(item)
  }

  const createdClient = (state, meta) => {
    const candidates = state.clients.map(captureLegacyClient).filter((item) => (
      !meta.pending.knownIds.has(item.id)
    ))
    const matches = candidates.filter((item) => sameClientRequest(meta.pending, item))
    const unexplained = candidates.filter((item) => !matches.includes(item)
      && ![...clients.values()].some((other) => other !== meta && other.origin === 'command'
        && (other.legacyId === item.id || sameClientRequest(other.pending, item))))
    if (matches.length > 1 || unexplained.length > 0) fail('state', 'DEMO_STATE_MISMATCH')
    if (matches.length === 0) return null
    meta.legacyId = matches[0].id
    meta.pending = null
    return matches[0]
  }

  const createdAppointment = (state, meta) => {
    const candidates = state.sessions.map(captureLegacyAppointment).filter((item) => (
      !meta.pending.knownIds.has(item.id)
    ))
    const matches = candidates.filter((item) => sameAppointmentRequest(meta.pending, item))
    const unexplained = candidates.filter((item) => !matches.includes(item)
      && ![...appointments.values()].some((other) => other !== meta && other.origin === 'command'
        && (other.legacyId === item.id || sameAppointmentRequest(other.pending, item))))
    if (matches.length > 1 || unexplained.length > 0) fail('state', 'DEMO_STATE_MISMATCH')
    if (matches.length === 0) return null
    meta.legacyId = matches[0].id
    meta.pending = null
    return matches[0]
  }

  const specialistProjection = (raw) => {
    const item = captureLegacySpecialist(raw)
    if (item.status === 'inactive') fail('specialist')
    return specialistDto({
      id: demoId('sp', item.id), displayName: item.name,
      professionalTitle: item.professionalTitle ?? 'Specjalistka',
      standardRateGrosze: groszeFromLegacy(item.rate, 'specialist'), status: 'active',
      version: 1, staffVersion: 1,
    })
  }

  const clientProjection = (coreId, raw, meta) => {
    const item = captureLegacyClient(raw)
    const archived = meta.archivedAt !== null
    return clientDto({
      id: coreId, name: item.name, age: item.age,
      status: archived ? 'archived' : item.status,
      version: meta.version, archivedAt: meta.archivedAt,
      createdAt: meta.createdAt, updatedAt: meta.updatedAt,
      assignment: archived ? null : {
        id: meta.assignmentId, specialistId: demoId('sp', item.psychId),
        startsAt: meta.assignmentStartsAt, version: meta.assignmentVersion,
      },
    })
  }

  const appointmentProjection = (coreId, raw, meta) => {
    const item = captureLegacyAppointment(raw)
    const startsAt = warsawDateTimeToUtc(item.date, item.time)
    const status = meta.cancelledAt === null ? item.status : 'cancelled'
    const expectedAmountGrosze = item.expectedAmountGrosze
    const payment = paymentAggregate({
      appointmentId: coreId, status, expectedAmountGrosze,
      paymentEntries: meta.entries, corrections: meta.corrections,
    })
    const corrections = new Map(meta.corrections.map((value) => [value.reversedEntryId, value]))
    const entries = meta.entries
      .toSorted((left, right) => left.receivedAt.localeCompare(right.receivedAt) || left.id.localeCompare(right.id))
      .map((entry) => {
        const correction = corrections.get(entry.id)
        return {
          id: entry.id, amountGrosze: entry.amountGrosze, method: entry.method,
          receivedAt: entry.receivedAt, correctedAt: correction?.createdAt ?? null,
          replacementEntryId: correction?.replacementEntryId ?? null,
        }
      })
    return deepFreeze({
      id: coreId, clientId: demoId('cl', item.clientId), specialistId: demoId('sp', item.psychId),
      serviceId: item.service, startsAt, endsAt: addElapsedMinutes(startsAt, item.duration),
      timeZone: 'Europe/Warsaw', location: item.location, status, source: 'panel',
      version: meta.version, cancelledAt: meta.cancelledAt, createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      charge: { id: `chg_${coreId.slice(4)}`, serviceId: item.service, expectedAmountGrosze, currency: 'PLN', version: meta.chargeVersion },
      payment, paymentEntries: entries,
    })
  }

  const assertWorkspaceIntegrity = ({ specialistDtos, clientDtos, appointmentDtos }) => {
    const specialistIds = new Set(specialistDtos.map(({ id }) => id))
    const clientIds = new Set(clientDtos.map(({ id }) => id))
    const appointmentIds = new Set(appointmentDtos.map(({ id }) => id))
    const paymentIds = appointmentDtos.flatMap((appointment) => (
      appointment.paymentEntries.map(({ id }) => id)
    ))
    if (specialistIds.size !== specialistDtos.length || clientIds.size !== clientDtos.length
      || appointmentIds.size !== appointmentDtos.length
      || new Set(paymentIds).size !== paymentIds.length
      || clientDtos.some((client) => client.assignment !== null
        && !specialistIds.has(client.assignment.specialistId))
      || appointmentDtos.some((appointment) => !clientIds.has(appointment.clientId))) {
      fail('workspace')
    }
  }

  function findClient(state, meta) {
    for (const raw of state.clients) {
      const item = captureLegacyClient(raw)
      if (item.id === meta.legacyId) return item
    }
    return undefined
  }

  function findAppointment(state, meta) {
    for (const raw of state.sessions) {
      const item = captureLegacyAppointment(raw)
      if (item.id === meta.legacyId) return item
    }
    return undefined
  }

  const patchAggregate = (coreId, raw, meta) => {
    const item = captureLegacyAppointment(raw)
    const amount = item.expectedAmountGrosze
    const aggregate = paymentAggregate({
      appointmentId: coreId, status: item.status, expectedAmountGrosze: amount,
      paymentEntries: meta.entries, corrections: meta.corrections,
    })
    return {
      payment: aggregate.status,
      paidAmount: aggregate.collectedGrosze / 100,
      method: aggregate.latestMethod,
      paidDate: aggregate.latestReceivedAt === null ? null : legacyDate(aggregate.latestReceivedAt),
    }
  }

  return makeRepository({
    async loadWindow(input) {
      const requested = captureWindow(input)
      const state = currentState()
      const specialistDtos = state.psychologists
        .map(captureLegacySpecialist)
        .filter((item) => item.status !== 'inactive'
          && specialists.has(demoId('sp', item.id)))
        .map(specialistProjection)
        .toSorted((left, right) => collator.compare(left.displayName, right.displayName) || left.id.localeCompare(right.id))
      const clientDtos = []
      for (const [coreId, meta] of clients) {
        const raw = findClient(state, meta)
        if (raw && meta.archivedAt === null) clientDtos.push(clientProjection(coreId, raw, meta))
      }
      clientDtos.sort((left, right) => collator.compare(left.name, right.name) || left.id.localeCompare(right.id))
      const appointmentDtos = []
      for (const [coreId, meta] of appointments) {
        const raw = findAppointment(state, meta)
        if (raw && raw.date >= requested.from && raw.date <= requested.to) {
          appointmentDtos.push(appointmentProjection(coreId, raw, meta))
        }
      }
      appointmentDtos.sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id))
      assertWorkspaceIntegrity({ specialistDtos, clientDtos, appointmentDtos })
      return deepFreeze({
        window: { ...requested, timeZone: 'Europe/Warsaw', complete: true },
        specialists: specialistDtos, clients: clientDtos, appointments: appointmentDtos,
        historicalClients: [], historicalOccurrences: [], latestPopulatedMonth: null,
      })
    },
    async activateHistoricalClient() {
      const error = new Error('WORKSPACE_READ_ONLY')
      error.code = 'WORKSPACE_READ_ONLY'
      throw error
    },
    async createClient(input) {
      const requested = captureClient(input)
      const state = currentState()
      const psychId = legacySpecialist(requested.specialistId)
      if (clients.size >= 200) fail('clients')
      const createdAt = commandInstant()
      const allocated = allocateDemoId({
        kind: 'cl', after: clientSequence, maximum: 200,
        occupied: (id) => clients.has(id),
      })
      const coreId = allocated.id
      const meta = {
        legacyId: null, version: 1, createdAt, updatedAt: createdAt,
        archivedAt: null, assignmentId: `asg_${coreId.slice(3)}`,
        assignmentStartsAt: createdAt, assignmentVersion: 1,
        origin: 'command',
        pending: {
          ...requested, psychId,
          knownIds: new Set(state.clients.map((item) => captureLegacyClient(item).id)),
        },
      }
      clients.set(coreId, meta)
      try {
        dispatch({
          type: 'ADD_CLIENT',
          client: {
            name: requested.name, age: requested.age, status: requested.status, psychId,
            since: legacyDate(createdAt), email: '', phone: '', notes: [], familyId: null,
            familyRole: null,
          },
        })
        const added = await observeState({
          before: null, snapshot: () => null,
          inspect: (next) => createdClient(next, meta),
        })
        clientSequence = Math.max(clientSequence, allocated.sequence)
        return deepFreeze(clientProjection(coreId, added, meta))
      } catch (error) {
        clients.delete(coreId)
        throw error
      }
    },
    async editClient(id, expectedVersion, input) {
      const requested = captureClient(input)
      assertMutationAvailable(clientMutationReservations, id)
      const state = currentState()
      const meta = clientMeta(id, state)
      assertDemoClientVersion(meta.version, expectedVersion)
      return serializeMutation(clientMutationReservations, id, async () => {
        const psychId = legacySpecialist(requested.specialistId)
        const raw = findClient(state, meta)
        const reassigned = raw.psychId !== psychId
        if (raw.name === requested.name && raw.age === requested.age
          && raw.status === requested.status && !reassigned) fail('body')
        const updatedAt = commandInstant(meta.updatedAt)
        const before = clientRowSignature(raw)
        dispatch({ type: 'UPDATE_CLIENT', id: meta.legacyId, patch: { name: requested.name, age: requested.age, status: requested.status, psychId } })
        const applied = await observeState({
          before, snapshot: (next) => clientTargetSnapshot(next, meta),
          inspect: (next) => {
            const item = findClient(next, meta)
            return item && matchesClient(item, requested, psychId) ? item : null
          },
        })
        meta.version += 1
        meta.updatedAt = updatedAt
        if (reassigned) {
          meta.assignmentId = `asg_${id.slice(3)}_${meta.version}`
          meta.assignmentStartsAt = updatedAt
          meta.assignmentVersion = 1
        }
        return deepFreeze(clientProjection(id, applied, meta))
      })
    },
    async archiveClient(id, expectedVersion) {
      assertMutationAvailable(clientMutationReservations, id)
      const state = currentState()
      const meta = clientMeta(id, state)
      assertDemoClientVersion(meta.version, expectedVersion)
      return serializeMutation(clientMutationReservations, id, async () => {
        const raw = findClient(state, meta)
        const archivedAt = commandInstant(meta.updatedAt)
        const before = clientRowSignature(raw)
        dispatch({ type: 'DELETE_CLIENT', id: meta.legacyId })
        await observeState({
          before, snapshot: (next) => clientTargetSnapshot(next, meta),
          inspect: (next) => findClient(next, meta) === undefined ? true : null,
        })
        meta.version += 1
        meta.updatedAt = archivedAt
        meta.archivedAt = archivedAt
        return deepFreeze(clientProjection(id, raw, meta))
      })
    },
    async createAppointment(input) {
      const requested = captureAppointment(input)
      const state = currentState()
      const client = clientMeta(requested.clientId, state)
      const psychId = legacySpecialist(requested.specialistId)
      if (appointments.size >= 500) fail('appointments')
      const createdAt = commandInstant()
      const allocated = allocateDemoId({
        kind: 'apt', after: appointmentSequence, maximum: 500,
        occupied: (id) => appointments.has(id),
      })
      const coreId = allocated.id
      const meta = {
        legacyId: null, version: 1, chargeVersion: 1, createdAt,
        updatedAt: createdAt, cancelledAt: null, entries: [], corrections: [],
        origin: 'command',
        pending: {
          clientId: client.legacyId, psychId, service: requested.serviceId,
          date: requested.date, time: requested.time, duration: requested.durationMinutes,
          amount: requested.expectedAmountGrosze / 100, location: requested.location,
          status: requested.status,
          knownIds: new Set(state.sessions.map((item) => captureLegacyAppointment(item).id)),
        },
      }
      appointments.set(coreId, meta)
      try {
        dispatch({
          type: 'ADD_SESSION',
          session: {
            clientId: client.legacyId, psychId, service: requested.serviceId,
            date: requested.date, time: requested.time, duration: requested.durationMinutes,
            amount: requested.expectedAmountGrosze / 100, location: requested.location,
            status: requested.status, payment: 'unpaid', paidAmount: 0, method: null,
            paidDate: null, note: '',
          },
        })
        const added = await observeState({
          before: null, snapshot: () => null,
          inspect: (next) => createdAppointment(next, meta),
        })
        appointmentSequence = Math.max(appointmentSequence, allocated.sequence)
        return appointmentProjection(coreId, added, meta)
      } catch (error) {
        appointments.delete(coreId)
        throw error
      }
    },
    async editAppointment(id, expectedVersion, input) {
      const requested = captureAppointmentEdit(input)
      assertMutationAvailable(appointmentMutationReservations, id)
      const state = currentState()
      const meta = appointmentMeta(id, state)
      assertVersion(meta.version, expectedVersion)
      return serializeMutation(appointmentMutationReservations, id, async () => {
        const psychId = legacySpecialist(requested.specialistId)
        const raw = findAppointment(state, meta)
        const chargeChanged = raw.service !== requested.serviceId
          || raw.expectedAmountGrosze !== requested.expectedAmountGrosze
        const changed = raw.psychId !== psychId || chargeChanged
          || raw.date !== requested.date || raw.time !== requested.time
          || raw.duration !== requested.durationMinutes || raw.location !== requested.location
          || raw.status !== requested.status
        if (!changed) fail('body')
        const aggregate = paymentAggregate({
          appointmentId: id, status: raw.status,
          expectedAmountGrosze: raw.expectedAmountGrosze, paymentEntries: meta.entries,
          corrections: meta.corrections,
        })
        if (raw.status !== requested.status) {
          assertAppointmentPaymentTransition({
            fromStatus: raw.status, toStatus: requested.status,
            previousAmountGrosze: raw.expectedAmountGrosze,
            nextAmountGrosze: requested.expectedAmountGrosze,
            collectedGrosze: aggregate.collectedGrosze,
          })
        } else if (requested.expectedAmountGrosze < raw.expectedAmountGrosze
          && aggregate.collectedGrosze !== 0) fail('payment', 'APPOINTMENT_PAYMENT_CONFLICT')
        const updatedAt = commandInstant(meta.updatedAt)
        const patch = {
          psychId, service: requested.serviceId, date: requested.date, time: requested.time,
          duration: requested.durationMinutes, amount: requested.expectedAmountGrosze / 100,
          location: requested.location, status: requested.status,
        }
        const before = appointmentRowSignature(raw)
        dispatch({ type: 'UPDATE_SESSION', id: meta.legacyId, patch })
        const applied = await observeState({
          before, snapshot: (next) => appointmentTargetSnapshot(next, meta),
          inspect: (next) => {
            const item = findAppointment(next, meta)
            return item && matchesAppointment(
              item, requested, raw.clientId, psychId,
            ) ? item : null
          },
        })
        meta.version += 1
        if (chargeChanged) meta.chargeVersion += 1
        meta.updatedAt = updatedAt
        return appointmentProjection(id, applied, meta)
      })
    },
    async cancelAppointment(id, expectedVersion) {
      assertMutationAvailable(appointmentMutationReservations, id)
      const state = currentState()
      const meta = appointmentMeta(id, state)
      assertVersion(meta.version, expectedVersion)
      return serializeMutation(appointmentMutationReservations, id, async () => {
        const raw = findAppointment(state, meta)
        const aggregate = paymentAggregate({
          appointmentId: id, status: raw.status, expectedAmountGrosze: raw.expectedAmountGrosze,
          paymentEntries: meta.entries, corrections: meta.corrections,
        })
        if (aggregate.collectedGrosze !== 0) fail('payment', 'APPOINTMENT_PAYMENT_CONFLICT')
        const cancelledAt = commandInstant(meta.updatedAt)
        const before = appointmentRowSignature(raw)
        dispatch({ type: 'DELETE_SESSION', id: meta.legacyId })
        await observeState({
          before, snapshot: (next) => appointmentTargetSnapshot(next, meta),
          inspect: (next) => findAppointment(next, meta) === undefined ? true : null,
        })
        meta.version += 1
        meta.updatedAt = cancelledAt
        meta.cancelledAt = cancelledAt
        return appointmentProjection(id, { ...raw, status: 'cancelled' }, meta)
      })
    },
    async recordPayment(id, expectedVersion, input) {
      const requested = capturePayment(input)
      const canonical = paymentCommandInput(requested)
      assertMutationAvailable(appointmentMutationReservations, id)
      const state = currentState()
      const meta = appointmentMeta(id, state)
      assertVersion(meta.version, expectedVersion)
      return serializeMutation(appointmentMutationReservations, id, async () => {
        const raw = findAppointment(state, meta)
        if (!isBillable(raw)) fail('payment', 'APPOINTMENT_PAYMENT_CONFLICT')
        if (payments.size + paymentReservations.size >= 1_000) fail('paymentEntries')
        const allocated = allocateDemoId({
          kind: 'pay', after: paymentSequence, maximum: 1_000,
          occupied: paymentIdOccupied,
        })
        const entryId = allocated.id
        paymentReservations.add(entryId)
        try {
          const entry = { id: entryId, appointmentId: id, ...canonical }
          const proposed = [...meta.entries, entry]
          paymentAggregate({
            appointmentId: id, status: raw.status, expectedAmountGrosze: raw.expectedAmountGrosze,
            paymentEntries: proposed, corrections: meta.corrections,
          })
          const updatedAt = commandInstant(meta.updatedAt)
          const patch = patchAggregate(id, raw, { ...meta, entries: proposed })
          const before = appointmentRowSignature(raw)
          dispatch({ type: 'UPDATE_SESSION', id: meta.legacyId, patch })
          const applied = await observeState({
            before, snapshot: (next) => appointmentTargetSnapshot(next, meta),
            inspect: (next) => {
              const item = findAppointment(next, meta)
              return item && matchesPaymentPatch(item, patch) ? item : null
            },
          })
          meta.entries = proposed
          meta.version += 1
          meta.updatedAt = updatedAt
          paymentSequence = Math.max(paymentSequence, allocated.sequence)
          payments.set(entryId, { appointmentId: id, entryIndex: meta.entries.length - 1 })
          paymentReservations.delete(entryId)
          return appointmentProjection(id, applied, meta)
        } catch (error) {
          paymentReservations.delete(entryId)
          throw error
        }
      })
    },
    async correctPayment(id, expectedVersion, input) {
      capturedId(id, 'payment')
      const requested = captureCorrection(input)
      const state = currentState()
      const link = payments.get(id)
      if (!link) fail('paymentId', 'NOT_FOUND')
      assertMutationAvailable(appointmentMutationReservations, link.appointmentId)
      const meta = appointmentMeta(link.appointmentId, state)
      assertVersion(meta.version, expectedVersion)
      return serializeMutation(appointmentMutationReservations, link.appointmentId, async () => {
        if (meta.corrections.some((item) => item.reversedEntryId === id)) {
          fail('payment', 'PAYMENT_CORRECTION_CONFLICT')
        }
        const raw = findAppointment(state, meta)
        if (correctionCount() >= 1_000) fail('paymentEntries')
        const correctionAllocated = allocateDemoId({
          kind: 'cor', after: correctionSequence, maximum: 1_000,
          occupied: correctionIdOccupied,
        })
        correctionReservations.add(correctionAllocated.id)
        let allocated = null
        try {
          if (requested.replacement !== null) {
            if (payments.size + paymentReservations.size >= 1_000) fail('paymentEntries')
            allocated = allocateDemoId({
              kind: 'pay', after: paymentSequence, maximum: 1_000,
              occupied: paymentIdOccupied,
            })
            paymentReservations.add(allocated.id)
          }
          const replacement = requested.replacement === null ? null : {
            id: allocated.id, appointmentId: link.appointmentId,
            amountGrosze: requested.replacement.amountGrosze,
            method: requested.replacement.method,
            receivedAt: requested.replacement.receivedAt,
          }
          const createdAt = commandInstant(meta.updatedAt)
          const correction = {
            id: correctionAllocated.id, reversedEntryId: id,
            replacementEntryId: replacement?.id ?? null, createdAt,
          }
          const entries = replacement === null ? meta.entries : [...meta.entries, replacement]
          const corrections = [...meta.corrections, correction]
          paymentAggregate({
            appointmentId: link.appointmentId, status: raw.status,
            expectedAmountGrosze: raw.expectedAmountGrosze, paymentEntries: entries,
            corrections,
          })
          const patch = patchAggregate(link.appointmentId, raw, {
            ...meta, entries, corrections,
          })
          const before = appointmentRowSignature(raw)
          dispatch({ type: 'UPDATE_SESSION', id: meta.legacyId, patch })
          const applied = await observeState({
            before, snapshot: (next) => appointmentTargetSnapshot(next, meta),
            inspect: (next) => {
              const item = findAppointment(next, meta)
              return item && matchesPaymentPatch(item, patch) ? item : null
            },
          })
          meta.entries = entries
          meta.corrections = corrections
          meta.version += 1
          meta.updatedAt = createdAt
          correctionSequence = Math.max(correctionSequence, correctionAllocated.sequence)
          correctionReservations.delete(correction.id)
          if (replacement) {
            paymentSequence = Math.max(paymentSequence, allocated.sequence)
            payments.set(replacement.id, { appointmentId: link.appointmentId, entryIndex: entries.length - 1 })
            paymentReservations.delete(replacement.id)
          }
          return appointmentProjection(link.appointmentId, applied, meta)
        } catch (error) {
          correctionReservations.delete(correctionAllocated.id)
          if (allocated) paymentReservations.delete(allocated.id)
          throw error
        }
      })
    },
  })
}
