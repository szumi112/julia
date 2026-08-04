// Pure compatibility adapters between canonical core records and the current demo reducer.
import {
  addElapsedMinutes,
  assertAppointmentPaymentTransition,
  assertCivilDate,
  assertCorrectionReason,
  assertId,
  clientDto,
  paymentAggregate,
  specialistDto,
  validateAppointmentInput,
  validateClientInput,
  validatePaymentInput,
  validateWarsawDateWindow,
  warsawDateTimeFromUtc,
  warsawDateTimeToUtc,
  warsawNoonToUtc,
} from './core-records.js'
import { isBillable } from './format.js'

const API_METHODS = Object.freeze([
  'loadWorkspaceWindow', 'createClient', 'editClient', 'archiveClient',
  'createAppointment', 'editAppointment', 'cancelAppointment', 'recordPayment',
  'correctPayment', 'createIdempotencyKey',
])
const REPOSITORY_METHODS = Object.freeze([
  'loadWindow', 'createClient', 'editClient', 'archiveClient', 'createAppointment',
  'editAppointment', 'cancelAppointment', 'recordPayment', 'correctPayment',
])
const CLIENT_KEYS = Object.freeze(['name', 'age', 'status', 'specialistId'])
const APPOINTMENT_KEYS = Object.freeze([
  'clientId', 'specialistId', 'serviceId', 'date', 'time', 'durationMinutes',
  'expectedAmountGrosze', 'location', 'status',
])
const APPOINTMENT_EDIT_KEYS = Object.freeze(APPOINTMENT_KEYS.filter((key) => key !== 'clientId'))
const PAYMENT_KEYS = Object.freeze(['amountGrosze', 'method', 'paidDate'])
const CORRECTION_KEYS = Object.freeze(['reason', 'replacement'])
const STATE_KEYS = Object.freeze(['psychologists', 'clients', 'sessions'])
const collator = new Intl.Collator('pl-PL', { sensitivity: 'base', usage: 'sort' })
const actionKey = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/

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
    if (error instanceof TypeError && String(error.message).startsWith('VALIDATION_FAILED/')) throw error
    fail(field)
  }
}

const captureFunctionRecord = (value, keys, field) => {
  const captured = captureRecord(value, keys, field)
  for (const key of keys) if (typeof captured[key] !== 'function') fail(field)
  return captured
}

const positiveVersion = (value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 4_096) fail('expectedVersion')
  return value
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
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
  assertCivilDate(captured.paidDate, 'paidDate')
  return captured
}

const captureCorrection = (input) => {
  const captured = captureRecord(input, CORRECTION_KEYS, 'body')
  assertCorrectionReason(captured.reason)
  return {
    reason: captured.reason,
    replacement: captured.replacement === null ? null : capturePayment(captured.replacement),
  }
}

const captureWindow = (input) => {
  const captured = captureRecord(input, ['from', 'to'], 'window')
  validateWarsawDateWindow(captured.from, captured.to)
  return captured
}

const capturedId = (value, kind, field) => assertId(value, kind, field)

const makeRepository = (methods) => {
  const repository = {}
  for (const name of REPOSITORY_METHODS) repository[name] = methods[name]
  return Object.freeze(repository)
}

export function createApiWorkspaceRepository(options) {
  const { api: source } = captureRecord(options, ['api'], 'repository')
  const api = captureFunctionRecord(source, API_METHODS, 'api')
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
      positiveVersion(expectedVersion)
      const requested = captureClient(input)
      return action((options) => api.editClient(id, expectedVersion, requested, options))
    },
    async archiveClient(id, expectedVersion) {
      capturedId(id, 'client')
      positiveVersion(expectedVersion)
      return action((options) => api.archiveClient(id, expectedVersion, options))
    },
    async createAppointment(input) {
      const requested = captureAppointment(input)
      return action((options) => api.createAppointment(requested, options))
    },
    async editAppointment(id, expectedVersion, input) {
      capturedId(id, 'appointment')
      positiveVersion(expectedVersion)
      const requested = captureAppointmentEdit(input)
      return action((options) => api.editAppointment(id, expectedVersion, requested, options))
    },
    async cancelAppointment(id, expectedVersion) {
      capturedId(id, 'appointment')
      positiveVersion(expectedVersion)
      return action((options) => api.cancelAppointment(id, expectedVersion, options))
    },
    async recordPayment(id, expectedVersion, input) {
      capturedId(id, 'appointment')
      positiveVersion(expectedVersion)
      const requested = capturePayment(input)
      const canonical = validatePaymentInput({
        amountGrosze: requested.amountGrosze,
        method: requested.method,
        receivedAt: warsawNoonToUtc(requested.paidDate),
      })
      return action((options) => api.recordPayment(id, expectedVersion, canonical, options))
    },
    async correctPayment(id, expectedVersion, input) {
      capturedId(id, 'payment')
      positiveVersion(expectedVersion)
      const requested = captureCorrection(input)
      const canonical = {
        reason: requested.reason,
        replacement: requested.replacement === null ? null : validatePaymentInput({
          amountGrosze: requested.replacement.amountGrosze,
          method: requested.replacement.method,
          receivedAt: warsawNoonToUtc(requested.replacement.paidDate),
        }),
      }
      return action((options) => api.correctPayment(id, expectedVersion, canonical, options))
    },
  })
}

const demoId = (kind, legacyId) => `${kind}_demo_${legacyId}`
const newId = (kind, sequence) => `${kind}_demo_new_${sequence}`
const legacyDate = (instant) => warsawDateTimeFromUtc(instant).date

const stateSnapshot = (getState) => {
  let raw
  try { raw = getState() } catch { fail('state') }
  const state = captureRecord(raw, STATE_KEYS, 'state', { allowAdditional: true })
  for (const key of STATE_KEYS) {
    if (!Array.isArray(state[key]) || state[key].length > (key === 'sessions' ? 500 : 200)
      || Array.from({ length: state[key].length }, (_, index) => index)
        .some((index) => !Object.hasOwn(state[key], index))) fail('state')
  }
  return state
}

const legacyRecord = (value, required, field) => captureRecord(
  value, required, field, { allowAdditional: true },
)

const initialInstant = (date) => warsawNoonToUtc(assertCivilDate(date, 'date'))
const sameClientRequest = (pending, item) => pending !== null
  && pending.name === item.name && pending.age === item.age
  && pending.status === item.status && pending.psychId === item.psychId
const sameAppointmentRequest = (pending, item) => pending !== null
  && pending.clientId === item.clientId && pending.psychId === item.psychId
  && pending.service === item.service && pending.date === item.date
  && pending.time === item.time && pending.duration === item.duration
  && pending.amount === item.amount && pending.status === item.status

export function createDemoWorkspaceRepository(options) {
  const dependencies = captureFunctionRecord(options, ['dispatch', 'getState'], 'repository')
  const { dispatch, getState } = dependencies
  const specialists = new Map()
  const clients = new Map()
  const appointments = new Map()
  const payments = new Map()
  let clientSequence = 0
  let appointmentSequence = 0
  let paymentSequence = 0
  let logicalTime = Date.now()

  const commandInstant = (after = null) => {
    logicalTime = Math.max(logicalTime + 1, after === null ? 0 : new Date(after).getTime() + 1)
    return new Date(logicalTime).toISOString()
  }

  const syncDirectories = (state) => {
    for (const raw of state.psychologists) {
      const item = legacyRecord(raw, ['id', 'name', 'rate'], 'specialist')
      if (typeof item.id !== 'string' || item.id.length === 0) fail('specialist')
      const coreId = demoId('sp', item.id)
      specialists.set(coreId, { legacyId: item.id })
    }
    for (const raw of state.clients) {
      const item = legacyRecord(raw, ['id', 'name', 'age', 'psychId', 'since', 'status'], 'client')
      if (typeof item.id !== 'string' || item.id.length === 0) fail('client')
      const existing = [...clients.entries()].find(([, meta]) => meta.legacyId === item.id)
      if (!existing) {
        const awaiting = [...clients.values()].find((meta) => meta.legacyId === null
          && sameClientRequest(meta.pending, item))
        if (awaiting) {
          awaiting.legacyId = item.id
          awaiting.pending = null
          continue
        }
        if (clients.size >= 200) fail('clients')
        const coreId = demoId('cl', item.id)
        const createdAt = initialInstant(item.since)
        clients.set(coreId, {
          legacyId: item.id, version: 1, createdAt, updatedAt: createdAt,
          archivedAt: null, assignmentId: demoId('asg', item.id),
          assignmentStartsAt: createdAt, assignmentVersion: 1, pending: null,
        })
      }
    }
    for (const raw of state.sessions) {
      const item = legacyRecord(raw, [
        'id', 'clientId', 'psychId', 'service', 'date', 'time', 'duration', 'amount',
        'status', 'payment', 'method',
      ], 'appointment')
      if (typeof item.id !== 'string' || item.id.length === 0) fail('appointment')
      const existing = [...appointments.entries()].find(([, meta]) => meta.legacyId === item.id)
      if (!existing) {
        const awaiting = [...appointments.values()].find((meta) => meta.legacyId === null
          && sameAppointmentRequest(meta.pending, item))
        if (awaiting) {
          awaiting.legacyId = item.id
          awaiting.pending = null
          continue
        }
        if (appointments.size >= 500) fail('appointments')
        const coreId = demoId('apt', item.id)
        const createdAt = warsawDateTimeToUtc(item.date, item.time)
        const meta = {
          legacyId: item.id, version: 1, chargeVersion: 1, createdAt,
          updatedAt: createdAt, cancelledAt: item.status === 'cancelled' ? createdAt : null,
          entries: [], corrections: [], pending: null,
        }
        const paidAmount = Number(item.paidAmount) || 0
        if (paidAmount > 0) {
          const paymentId = demoId('pay', `${item.id}_1`)
          const receivedAt = initialInstant(typeof item.paidDate === 'string' ? item.paidDate : item.date)
          meta.entries.push({
            id: paymentId, appointmentId: coreId, amountGrosze: Math.round(paidAmount * 100),
            method: item.method, receivedAt,
          })
          payments.set(paymentId, { appointmentId: coreId, entryIndex: 0 })
        }
        appointments.set(coreId, meta)
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
    positiveVersion(expected)
    if (actual !== expected) fail('expectedVersion', 'VERSION_CONFLICT')
  }

  const specialistProjection = (raw) => {
    const item = legacyRecord(raw, ['id', 'name', 'rate'], 'specialist')
    return specialistDto({
      id: demoId('sp', item.id), displayName: item.name,
      standardRateGrosze: Math.round(item.rate * 100), status: 'active',
      version: 1, staffVersion: 1,
    })
  }

  const clientProjection = (coreId, raw, meta) => {
    const item = legacyRecord(raw, ['name', 'age', 'psychId', 'status'], 'client')
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
    const item = legacyRecord(raw, [
      'clientId', 'psychId', 'service', 'date', 'time', 'duration', 'amount', 'status',
    ], 'appointment')
    const startsAt = warsawDateTimeToUtc(item.date, item.time)
    const status = meta.cancelledAt === null ? item.status : 'cancelled'
    const expectedAmountGrosze = Math.round(item.amount * 100)
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
      timeZone: 'Europe/Warsaw', location: null, status, source: 'panel',
      version: meta.version, cancelledAt: meta.cancelledAt, createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      charge: { id: `chg_${coreId.slice(4)}`, serviceId: item.service, expectedAmountGrosze, currency: 'PLN', version: meta.chargeVersion },
      payment, paymentEntries: entries,
    })
  }

  function findClient(state, meta) {
    for (const raw of state.clients) {
      const item = legacyRecord(raw, ['id'], 'client')
      if (item.id === meta.legacyId) return item
    }
    return undefined
  }

  function findAppointment(state, meta) {
    for (const raw of state.sessions) {
      const item = legacyRecord(raw, ['id'], 'appointment')
      if (item.id === meta.legacyId) return item
    }
    return undefined
  }

  const locateAdded = (before, after, key) => {
    const ids = new Set(before.map((item) => legacyRecord(item, ['id'], key).id))
    const added = after.map((item) => legacyRecord(item, ['id'], key))
      .filter((item) => !ids.has(item.id))
    if (added.length > 1) fail(key)
    return added[0] ?? null
  }

  const patchAggregate = (coreId, raw, meta) => {
    const amount = Math.round(Number(raw.amount) * 100)
    const aggregate = paymentAggregate({
      appointmentId: coreId, status: raw.status, expectedAmountGrosze: amount,
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
      const specialistDtos = state.psychologists.map(specialistProjection)
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
      return deepFreeze({
        window: { ...requested, timeZone: 'Europe/Warsaw', complete: true },
        specialists: specialistDtos, clients: clientDtos, appointments: appointmentDtos,
      })
    },
    async createClient(input) {
      const requested = captureClient(input)
      const state = currentState()
      const psychId = legacySpecialist(requested.specialistId)
      if (clients.size >= 200) fail('clients')
      const before = [...state.clients]
      const createdAt = commandInstant()
      dispatch({
        type: 'ADD_CLIENT',
        client: {
          name: requested.name, age: requested.age, status: requested.status, psychId,
          since: legacyDate(createdAt), email: '', phone: '', notes: [], familyId: null,
          familyRole: null,
        },
      })
      const after = stateSnapshot(getState)
      const added = locateAdded(before, after.clients, 'client')
      const coreId = newId('cl', ++clientSequence)
      const meta = {
        legacyId: added?.id ?? null, version: 1, createdAt, updatedAt: createdAt,
        archivedAt: null, assignmentId: `asg_${coreId.slice(3)}`,
        assignmentStartsAt: createdAt, assignmentVersion: 1,
        pending: added ? null : { ...requested, psychId },
      }
      clients.set(coreId, meta)
      const projected = added ?? { ...requested, psychId }
      return deepFreeze(clientProjection(coreId, projected, meta))
    },
    async editClient(id, expectedVersion, input) {
      const requested = captureClient(input)
      const state = currentState()
      const meta = clientMeta(id, state)
      assertVersion(meta.version, expectedVersion)
      const psychId = legacySpecialist(requested.specialistId)
      const raw = findClient(state, meta)
      const reassigned = raw.psychId !== psychId
      if (raw.name === requested.name && raw.age === requested.age
        && raw.status === requested.status && !reassigned) fail('body')
      const updatedAt = commandInstant(meta.updatedAt)
      dispatch({ type: 'UPDATE_CLIENT', id: meta.legacyId, patch: { name: requested.name, age: requested.age, status: requested.status, psychId } })
      meta.version += 1
      meta.updatedAt = updatedAt
      if (reassigned) {
        meta.assignmentId = `asg_${id.slice(3)}_${meta.version}`
        meta.assignmentStartsAt = updatedAt
        meta.assignmentVersion = 1
      }
      return deepFreeze(clientProjection(id, { ...raw, ...requested, psychId }, meta))
    },
    async archiveClient(id, expectedVersion) {
      const state = currentState()
      const meta = clientMeta(id, state)
      assertVersion(meta.version, expectedVersion)
      const raw = findClient(state, meta)
      const archivedAt = commandInstant(meta.updatedAt)
      dispatch({ type: 'DELETE_CLIENT', id: meta.legacyId })
      meta.version += 1
      meta.updatedAt = archivedAt
      meta.archivedAt = archivedAt
      return deepFreeze(clientProjection(id, raw, meta))
    },
    async createAppointment(input) {
      const requested = captureAppointment(input)
      const state = currentState()
      const client = clientMeta(requested.clientId, state)
      const psychId = legacySpecialist(requested.specialistId)
      if (appointments.size >= 500) fail('appointments')
      const before = [...state.sessions]
      const createdAt = commandInstant()
      dispatch({
        type: 'ADD_SESSION',
        session: {
          clientId: client.legacyId, psychId, service: requested.serviceId,
          date: requested.date, time: requested.time, duration: requested.durationMinutes,
          amount: requested.expectedAmountGrosze / 100, status: requested.status,
          payment: 'unpaid', paidAmount: 0, method: null, paidDate: null, note: '',
        },
      })
      const after = stateSnapshot(getState)
      const added = locateAdded(before, after.sessions, 'appointment')
      const coreId = newId('apt', ++appointmentSequence)
      const meta = {
        legacyId: added?.id ?? null, version: 1, chargeVersion: 1, createdAt,
        updatedAt: createdAt, cancelledAt: null, entries: [], corrections: [],
        pending: added ? null : {
          clientId: client.legacyId, psychId, service: requested.serviceId,
          date: requested.date, time: requested.time, duration: requested.durationMinutes,
          amount: requested.expectedAmountGrosze / 100, status: requested.status,
        },
      }
      appointments.set(coreId, meta)
      const projected = added ?? {
        clientId: client.legacyId, psychId, service: requested.serviceId,
        date: requested.date, time: requested.time, duration: requested.durationMinutes,
        amount: requested.expectedAmountGrosze / 100, status: requested.status,
      }
      return appointmentProjection(coreId, projected, meta)
    },
    async editAppointment(id, expectedVersion, input) {
      const requested = captureAppointmentEdit(input)
      const state = currentState()
      const meta = appointmentMeta(id, state)
      assertVersion(meta.version, expectedVersion)
      const psychId = legacySpecialist(requested.specialistId)
      const raw = findAppointment(state, meta)
      const chargeChanged = raw.service !== requested.serviceId
        || Math.round(raw.amount * 100) !== requested.expectedAmountGrosze
      const changed = raw.psychId !== psychId || chargeChanged
        || raw.date !== requested.date || raw.time !== requested.time
        || raw.duration !== requested.durationMinutes || raw.status !== requested.status
      if (!changed) fail('body')
      const aggregate = paymentAggregate({
        appointmentId: id, status: raw.status,
        expectedAmountGrosze: Math.round(raw.amount * 100), paymentEntries: meta.entries,
        corrections: meta.corrections,
      })
      if (raw.status !== requested.status) {
        assertAppointmentPaymentTransition({
          fromStatus: raw.status, toStatus: requested.status,
          previousAmountGrosze: Math.round(raw.amount * 100),
          nextAmountGrosze: requested.expectedAmountGrosze,
          collectedGrosze: aggregate.collectedGrosze,
        })
      } else if (requested.expectedAmountGrosze < Math.round(raw.amount * 100)
        && aggregate.collectedGrosze !== 0) fail('payment', 'APPOINTMENT_PAYMENT_CONFLICT')
      const updatedAt = commandInstant(meta.updatedAt)
      const patch = {
        psychId, service: requested.serviceId, date: requested.date, time: requested.time,
        duration: requested.durationMinutes, amount: requested.expectedAmountGrosze / 100,
        status: requested.status,
      }
      dispatch({ type: 'UPDATE_SESSION', id: meta.legacyId, patch })
      meta.version += 1
      if (chargeChanged) meta.chargeVersion += 1
      meta.updatedAt = updatedAt
      return appointmentProjection(id, { ...raw, ...patch }, meta)
    },
    async cancelAppointment(id, expectedVersion) {
      const state = currentState()
      const meta = appointmentMeta(id, state)
      assertVersion(meta.version, expectedVersion)
      const raw = findAppointment(state, meta)
      const aggregate = paymentAggregate({
        appointmentId: id, status: raw.status, expectedAmountGrosze: Math.round(raw.amount * 100),
        paymentEntries: meta.entries, corrections: meta.corrections,
      })
      if (aggregate.collectedGrosze !== 0) fail('payment', 'APPOINTMENT_PAYMENT_CONFLICT')
      const cancelledAt = commandInstant(meta.updatedAt)
      dispatch({ type: 'DELETE_SESSION', id: meta.legacyId })
      meta.version += 1
      meta.updatedAt = cancelledAt
      meta.cancelledAt = cancelledAt
      return appointmentProjection(id, { ...raw, status: 'cancelled' }, meta)
    },
    async recordPayment(id, expectedVersion, input) {
      const requested = capturePayment(input)
      const canonical = validatePaymentInput({
        amountGrosze: requested.amountGrosze, method: requested.method,
        receivedAt: warsawNoonToUtc(requested.paidDate),
      })
      const state = currentState()
      const meta = appointmentMeta(id, state)
      assertVersion(meta.version, expectedVersion)
      const raw = findAppointment(state, meta)
      if (!isBillable(raw)) fail('payment', 'APPOINTMENT_PAYMENT_CONFLICT')
      if (payments.size >= 1_000) fail('paymentEntries')
      const entryId = newId('pay', paymentSequence + 1)
      const entry = { id: entryId, appointmentId: id, ...canonical }
      const proposed = [...meta.entries, entry]
      paymentAggregate({
        appointmentId: id, status: raw.status, expectedAmountGrosze: Math.round(raw.amount * 100),
        paymentEntries: proposed, corrections: meta.corrections,
      })
      const updatedAt = commandInstant(meta.updatedAt)
      const previousEntries = meta.entries
      meta.entries = proposed
      const patch = patchAggregate(id, raw, meta)
      try { dispatch({ type: 'UPDATE_SESSION', id: meta.legacyId, patch }) } catch (error) {
        meta.entries = previousEntries
        throw error
      }
      meta.version += 1
      meta.updatedAt = updatedAt
      paymentSequence += 1
      payments.set(entryId, { appointmentId: id, entryIndex: meta.entries.length - 1 })
      return appointmentProjection(id, { ...raw, ...patch }, meta)
    },
    async correctPayment(id, expectedVersion, input) {
      capturedId(id, 'payment')
      const requested = captureCorrection(input)
      const state = currentState()
      const link = payments.get(id)
      if (!link) fail('paymentId', 'NOT_FOUND')
      const meta = appointmentMeta(link.appointmentId, state)
      assertVersion(meta.version, expectedVersion)
      if (meta.corrections.some((item) => item.reversedEntryId === id)) {
        fail('payment', 'PAYMENT_CORRECTION_CONFLICT')
      }
      const raw = findAppointment(state, meta)
      if (requested.replacement !== null && payments.size >= 1_000) fail('paymentEntries')
      const replacement = requested.replacement === null ? null : {
        id: newId('pay', paymentSequence + 1), appointmentId: link.appointmentId,
        amountGrosze: requested.replacement.amountGrosze,
        method: requested.replacement.method,
        receivedAt: warsawNoonToUtc(requested.replacement.paidDate),
      }
      const createdAt = commandInstant(meta.updatedAt)
      const correction = {
        id: newId('cor', meta.corrections.length + 1), reversedEntryId: id,
        replacementEntryId: replacement?.id ?? null, createdAt,
      }
      const entries = replacement === null ? meta.entries : [...meta.entries, replacement]
      const corrections = [...meta.corrections, correction]
      paymentAggregate({
        appointmentId: link.appointmentId, status: raw.status,
        expectedAmountGrosze: Math.round(raw.amount * 100), paymentEntries: entries,
        corrections,
      })
      const previousEntries = meta.entries
      const previousCorrections = meta.corrections
      meta.entries = entries
      meta.corrections = corrections
      const patch = patchAggregate(link.appointmentId, raw, meta)
      try { dispatch({ type: 'UPDATE_SESSION', id: meta.legacyId, patch }) } catch (error) {
        meta.entries = previousEntries
        meta.corrections = previousCorrections
        throw error
      }
      meta.version += 1
      meta.updatedAt = createdAt
      if (replacement) {
        paymentSequence += 1
        payments.set(replacement.id, { appointmentId: link.appointmentId, entryIndex: entries.length - 1 })
      }
      return appointmentProjection(link.appointmentId, { ...raw, ...patch }, meta)
    },
  })
}
