import {
  captureLoadedWorkspaceLoad,
  createLoadedWorkspaceState,
  isWorkspaceWindowLoaded,
  mergeLoadedWorkspaceLoad,
  recordLoadedWorkspaceWrite,
  resetLoadedWorkspaceAuthority,
} from './loaded-windows.js'
import { isAppointmentId, isPaymentId, warsawDateFromUtc } from './core-records.js'

const AUTHORITY_KEYS = Object.freeze([
  'repositoryMode', 'dataMode', 'actorId', 'actorVersion', 'role', 'specialistId',
  'capabilities', 'demoRoleId', 'demoAuthGeneration',
])
const REPOSITORY_METHODS = Object.freeze([
  'loadWindow', 'createClient', 'editClient', 'archiveClient', 'activateHistoricalClient',
  'createAppointment', 'editAppointment', 'cancelAppointment', 'recordPayment',
  'correctPayment',
])
const WORKSPACE_METHODS = Object.freeze(REPOSITORY_METHODS.filter((name) => name !== 'loadWindow'))
const CLIENT_MUTATION_METHODS = new Set([
  'createClient', 'editClient', 'archiveClient', 'activateHistoricalClient',
])
const APPOINTMENT_MUTATION_METHODS = new Set(['createAppointment', 'editAppointment', 'cancelAppointment'])
const PAYMENT_MUTATION_METHODS = new Set(['recordPayment', 'correctPayment'])
const PAYMENT_ENTRY_KEYS = new Set([
  'id', 'amountGrosze', 'method', 'receivedAt', 'correctedAt', 'replacementEntryId',
])
const PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'monthly'])
const AUTHORITY_ACTION_KEY_LIMIT = 32
const INFRASTRUCTURE_CODES = new Set([
  'ACCESS_ASSERTION_INVALID', 'ACCESS_DENIED', 'CSRF_INVALID', 'CSRF_EXPIRED',
  'FORBIDDEN', 'INTERNAL_ERROR', 'INVALID_RESPONSE', 'NETWORK_ERROR', 'ORIGIN_INVALID',
  'SESSION_REQUIRED',
])

const fail = (message) => {
  throw new TypeError(message)
}

const captureExactRecord = (value, keys, label) => {
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
  const captured = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`Invalid ${label}`)
    captured[key] = descriptor.value
  }
  return captured
}

const captureCapabilities = (value) => {
  let descriptors
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      fail('Invalid workspace authority')
    }
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail('Invalid workspace authority')
  }
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > 64
    || Reflect.ownKeys(descriptors).length !== length + 1) fail('Invalid workspace authority')
  const result = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
      fail('Invalid workspace authority')
    }
    result.push(descriptor.value)
  }
  if (new Set(result).size !== result.length) fail('Invalid workspace authority')
  return result.sort()
}

export const createWorkspaceAuthorityKey = (input) => {
  const value = captureExactRecord(input, AUTHORITY_KEYS, 'workspace authority')
  if (!['api', 'demo'].includes(value.repositoryMode)
    || typeof value.dataMode !== 'string' || value.dataMode.length === 0
    || typeof value.actorId !== 'string' || value.actorId.length === 0
    || !Number.isSafeInteger(value.actorVersion) || value.actorVersion < 1
    || typeof value.role !== 'string' || value.role.length === 0
    || (value.specialistId !== null
      && (typeof value.specialistId !== 'string' || value.specialistId.length === 0))
    || (value.demoRoleId !== null
      && (typeof value.demoRoleId !== 'string' || value.demoRoleId.length === 0))
    || (value.demoAuthGeneration !== null
      && (!Number.isSafeInteger(value.demoAuthGeneration) || value.demoAuthGeneration < 0))) {
    fail('Invalid workspace authority')
  }
  return JSON.stringify([
    value.repositoryMode,
    value.dataMode,
    value.actorId,
    value.actorVersion,
    value.role,
    value.specialistId,
    captureCapabilities(value.capabilities),
    value.demoRoleId,
    value.demoAuthGeneration,
  ])
}

export const createAuthorityBoundDispatch = (options) => {
  const captured = captureExactRecord(options, [
    'dispatch', 'getState', 'resetAuthority', 'authorityKeyFor', 'demoRoleIds',
  ], 'authority dispatch')
  if (typeof captured.dispatch !== 'function' || typeof captured.getState !== 'function'
    || typeof captured.resetAuthority !== 'function'
    || typeof captured.authorityKeyFor !== 'function') fail('Invalid authority dispatch')
  const demoRoleIds = new Set(captureCapabilities(captured.demoRoleIds))
  return Object.freeze((action) => {
    let descriptors
    try {
      if (action === null || typeof action !== 'object' || Array.isArray(action)
        || Object.getPrototypeOf(action) !== Object.prototype) fail('Invalid authority action')
      descriptors = Object.getOwnPropertyDescriptors(action)
    } catch {
      fail('Invalid authority action')
    }
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length < 1 || keys.length > AUTHORITY_ACTION_KEY_LIMIT
      || keys.some((key) => typeof key !== 'string')) fail('Invalid authority action')
    const snapshot = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('Invalid authority action')
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    if (typeof snapshot.type !== 'string') {
      fail('Invalid authority action')
    }
    if (snapshot.type === 'SET_DEMO_ROLE') {
      if (typeof snapshot.roleId !== 'string') fail('Invalid authority action')
      if (!demoRoleIds.has(snapshot.roleId)) return captured.dispatch(snapshot)
      const state = captured.getState()
      if (state?.demoRoleId !== snapshot.roleId) {
        captured.resetAuthority(captured.authorityKeyFor({ ...state, demoRoleId: snapshot.roleId }))
      }
    }
    return captured.dispatch(snapshot)
  })
}

const repositoryFrom = (repositoryFactory, dispatch, getState) => {
  if (typeof repositoryFactory !== 'function') fail('Invalid workspace repository factory')
  const repository = repositoryFactory(Object.freeze({ dispatch, getState }))
  let descriptors
  try {
    if (repository === null || typeof repository !== 'object' || Array.isArray(repository)
      || !Object.isFrozen(repository)) fail('Invalid workspace repository')
    descriptors = Object.getOwnPropertyDescriptors(repository)
  } catch {
    fail('Invalid workspace repository')
  }
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== REPOSITORY_METHODS.length
    || keys.some((name) => typeof name !== 'string' || !REPOSITORY_METHODS.includes(name))) {
    fail('Invalid workspace repository')
  }
  for (const name of REPOSITORY_METHODS) {
    const descriptor = descriptors[name]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function') fail('Invalid workspace repository')
  }
  return repository
}

const errorCode = (error) => {
  try {
    const descriptor = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? Object.getOwnPropertyDescriptor(error, 'code')
      : null
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value
      : null
  } catch {
    return null
  }
}

const infrastructureFailure = (error) => INFRASTRUCTURE_CODES.has(errorCode(error))

const fixedError = (code) => {
  const error = new Error(code)
  error.code = code
  return error
}

const readOnlyError = () => fixedError('WORKSPACE_READ_ONLY')
const staleAuthorityError = () => fixedError('WORKSPACE_AUTHORITY_STALE')
const resetFailedError = () => fixedError('WORKSPACE_RESET_FAILED')

const paymentLockForRecord = (state, appointmentId) => {
  try {
    if (!isAppointmentId(appointmentId)) throw new TypeError('Invalid appointment ID')
    const appointmentDescriptor = Object.getOwnPropertyDescriptor(
      state.appointmentsById, appointmentId,
    )
    if (!appointmentDescriptor || !Object.hasOwn(appointmentDescriptor, 'value')) {
      throw new TypeError('Appointment is not canonically loaded')
    }
    const startDescriptor = Object.getOwnPropertyDescriptor(appointmentDescriptor.value, 'startsAt')
    if (!startDescriptor || !Object.hasOwn(startDescriptor, 'value')) {
      throw new TypeError('Appointment start is unavailable')
    }
    const date = warsawDateFromUtc(startDescriptor.value)
    captureLoadedWorkspaceLoad(state, { from: date, to: date })
    return Object.freeze({ appointmentId, date })
  } catch {
    throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  }
}

const paymentLockForCorrection = (state, paymentId) => {
  try {
    if (!isPaymentId(paymentId)) throw new TypeError('Invalid payment ID')
    const appointments = state.appointmentsById
    const descriptors = Object.getOwnPropertyDescriptors(appointments)
    const matches = []
    for (const appointmentId of Reflect.ownKeys(descriptors)) {
      if (typeof appointmentId !== 'string') throw new TypeError('Invalid appointment map')
      const descriptor = descriptors[appointmentId]
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
        || !isAppointmentId(appointmentId)) throw new TypeError('Invalid appointment map')
      const appointment = descriptor.value
      if (appointment === null || typeof appointment !== 'object' || Array.isArray(appointment)
        || Object.getPrototypeOf(appointment) !== Object.prototype) {
        throw new TypeError('Invalid appointment')
      }
      const idDescriptor = Object.getOwnPropertyDescriptor(appointment, 'id')
      const startsAtDescriptor = Object.getOwnPropertyDescriptor(appointment, 'startsAt')
      const entriesDescriptor = Object.getOwnPropertyDescriptor(appointment, 'paymentEntries')
      if (!idDescriptor || !Object.hasOwn(idDescriptor, 'value') || idDescriptor.value !== appointmentId
        || !startsAtDescriptor || !Object.hasOwn(startsAtDescriptor, 'value')
        || !entriesDescriptor || !Object.hasOwn(entriesDescriptor, 'value')
        || !Array.isArray(entriesDescriptor.value)) {
        throw new TypeError('Invalid appointment')
      }
      for (const entry of entriesDescriptor.value) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
          || Object.getPrototypeOf(entry) !== Object.prototype) {
          throw new TypeError('Invalid payment entry')
        }
        const entryId = Object.getOwnPropertyDescriptor(entry, 'id')
        const entryDescriptors = Object.getOwnPropertyDescriptors(entry)
        const entryKeys = Reflect.ownKeys(entryDescriptors)
        if (entryKeys.length !== PAYMENT_ENTRY_KEYS.size
          || entryKeys.some((key) => typeof key !== 'string' || !PAYMENT_ENTRY_KEYS.has(key))
          || !entryId || !Object.hasOwn(entryId, 'value') || !isPaymentId(entryId.value)
          || !Number.isSafeInteger(entryDescriptors.amountGrosze?.value)
          || entryDescriptors.amountGrosze.value < 1 || entryDescriptors.amountGrosze.value > 1_000_000
          || !PAYMENT_METHODS.has(entryDescriptors.method?.value)
          || typeof entryDescriptors.receivedAt?.value !== 'string'
          || (entryDescriptors.correctedAt?.value !== null
            && typeof entryDescriptors.correctedAt?.value !== 'string')
          || (entryDescriptors.replacementEntryId?.value !== null
            && !isPaymentId(entryDescriptors.replacementEntryId?.value))
          || (entryDescriptors.correctedAt?.value === null
            && entryDescriptors.replacementEntryId?.value !== null)) {
          throw new TypeError('Invalid payment entry')
        }
        warsawDateFromUtc(entryDescriptors.receivedAt.value)
        if (entryDescriptors.correctedAt.value !== null) {
          warsawDateFromUtc(entryDescriptors.correctedAt.value)
        }
        if (entryId.value === paymentId) matches.push({ appointmentId, startsAt: startsAtDescriptor.value })
      }
    }
    if (matches.length !== 1) throw new TypeError('Payment entry is unavailable')
    const { appointmentId, startsAt } = matches[0]
    const date = warsawDateFromUtc(startsAt)
    if (!isWorkspaceWindowLoaded(state, { from: date, to: date })) {
      throw new TypeError('Payment entry is not canonically loaded')
    }
    return Object.freeze({ appointmentId, date })
  } catch {
    throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  }
}

const paymentLockForCommand = (name, state, args) => {
  if (name === 'recordPayment') return paymentLockForRecord(state, args[0])
  return paymentLockForCorrection(state, args[0])
}

const paymentLockReconciledBy = (lock, capture) => lock !== null
  && lock.date !== null && capture.from <= lock.date && lock.date <= capture.to

const historicalActivationLockFor = (args) => {
  try {
    if (!Array.isArray(args) || args.length !== 2
      || typeof args[0] !== 'string'
      || !/^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(args[0])) {
      throw new TypeError('Invalid activation command')
    }
    const body = captureExactRecord(
      args[1], ['expectedVersion', 'specialistId'], 'historical activation command',
    )
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1
      || body.expectedVersion >= Number.MAX_SAFE_INTEGER
      || typeof body.specialistId !== 'string'
      || !/^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(body.specialistId)) {
      throw new TypeError('Invalid activation command')
    }
    return Object.freeze({
      historicalClientId: args[0], version: body.expectedVersion + 1,
    })
  } catch {
    throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  }
}

const historicalActivationReconciled = (state, lock) => {
  if (lock === null) return true
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      state.historicalClientsById, lock.historicalClientId,
    )
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false
    const value = descriptor.value
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return descriptors.status?.value === 'activated'
      && descriptors.version?.value >= lock.version
      && typeof descriptors.activeClientId?.value === 'string'
      && /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(descriptors.activeClientId.value)
  } catch { return false }
}

export const createWorkspaceProviderController = (options) => {
  const captured = captureExactRecord(options, [
    'repositoryFactory', 'dispatch', 'getState', 'authorityKey', 'clearToasts',
  ], 'workspace provider')
  if (typeof captured.dispatch !== 'function' || typeof captured.getState !== 'function'
    || typeof captured.clearToasts !== 'function' || typeof captured.authorityKey !== 'string') {
    fail('Invalid workspace provider')
  }

  let authorityKey = captured.authorityKey
  const repositoryFactory = captured.repositoryFactory
  let repository = repositoryFrom(repositoryFactory, captured.dispatch, captured.getState)
  let loadedState = createLoadedWorkspaceState()
  let pendingLoads = 0
  let readOnly = false
  let clientMutationLocked = false
  let historicalActivationLock = null
  let appointmentMutationLocked = false
  let paymentMutationLock = null
  let infrastructureError = null
  let snapshot
  const listeners = new Set()

  const status = () => readOnly ? 'read-only-error' : pendingLoads > 0 ? 'loading' : 'ready'
  const publish = () => {
    snapshot = Object.freeze({
      loadedState,
      clientMutationLocked,
      appointmentMutationLocked,
      paymentMutationLocked: paymentMutationLock !== null,
      workspace: Object.freeze({
        status: status(),
        loadedRanges: loadedState.loadedRanges,
        loadWindow,
        createClient: commands.createClient,
        editClient: commands.editClient,
        archiveClient: commands.archiveClient,
        activateHistoricalClient: commands.activateHistoricalClient,
        createAppointment: commands.createAppointment,
        editAppointment: commands.editAppointment,
        cancelAppointment: commands.cancelAppointment,
        recordPayment: commands.recordPayment,
        correctPayment: commands.correctPayment,
      }),
    })
    for (const listener of listeners) listener()
  }

  const enterReadOnly = (error, generation) => {
    if (loadedState.authorityGeneration !== generation) return
    readOnly = true
    infrastructureError = error
    publish()
  }

  async function loadWindow(requested) {
    if (readOnly || repository === null) throw readOnlyError()
    let capture = captureLoadedWorkspaceLoad(loadedState, requested)
    const generation = capture.authorityGeneration
    const operationRepository = repository
    pendingLoads += 1
    publish()
    try {
      let refetches = 0
      while (true) {
        let rawPayload
        try {
          rawPayload = await operationRepository.loadWindow(Object.freeze({
            from: capture.from,
            to: capture.to,
          }))
        } catch (error) {
          if (loadedState.authorityGeneration !== generation) throw staleAuthorityError()
          if (infrastructureFailure(error)) enterReadOnly(error, generation)
          throw error
        }
        if (loadedState.authorityGeneration !== generation) throw staleAuthorityError()
        let merged
        try {
          merged = mergeLoadedWorkspaceLoad(loadedState, capture, rawPayload)
        } catch (error) {
          enterReadOnly(error, generation)
          throw error
        }
        loadedState = merged.state
        if (!merged.refetch || refetches === 1) {
          if (historicalActivationReconciled(loadedState, historicalActivationLock)) {
            clientMutationLocked = false
            historicalActivationLock = null
          }
          appointmentMutationLocked = false
          if (paymentLockReconciledBy(paymentMutationLock, capture)) paymentMutationLock = null
          publish()
          return rawPayload
        }
        refetches += 1
        capture = captureLoadedWorkspaceLoad(loadedState, {
          from: capture.from,
          to: capture.to,
        })
      }
    } finally {
      if (loadedState.authorityGeneration === generation) {
        pendingLoads = Math.max(0, pendingLoads - 1)
        publish()
      }
    }
  }

  const commands = Object.fromEntries(WORKSPACE_METHODS.map((name) => [name,
    async (...args) => {
      if (readOnly || repository === null) throw readOnlyError()
      if (CLIENT_MUTATION_METHODS.has(name) && clientMutationLocked) {
        throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
      }
      if (APPOINTMENT_MUTATION_METHODS.has(name) && appointmentMutationLocked) {
        throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
      }
      if (PAYMENT_MUTATION_METHODS.has(name) && paymentMutationLock !== null) {
        throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
      }
      const generation = loadedState.authorityGeneration
      const operationRepository = repository
      const nextPaymentMutationLock = PAYMENT_MUTATION_METHODS.has(name)
        ? paymentLockForCommand(name, loadedState, args)
        : null
      const nextHistoricalActivationLock = name === 'activateHistoricalClient'
        ? historicalActivationLockFor(args)
        : null
      try {
        const result = await operationRepository[name](...args)
        if (loadedState.authorityGeneration !== generation) throw staleAuthorityError()
        if (CLIENT_MUTATION_METHODS.has(name)) clientMutationLocked = true
        if (name === 'activateHistoricalClient') {
          historicalActivationLock = nextHistoricalActivationLock
        }
        if (APPOINTMENT_MUTATION_METHODS.has(name)) appointmentMutationLocked = true
        if (PAYMENT_MUTATION_METHODS.has(name)) paymentMutationLock = nextPaymentMutationLock
        loadedState = recordLoadedWorkspaceWrite(loadedState)
        publish()
        return result
      } catch (error) {
        if (loadedState.authorityGeneration !== generation) throw staleAuthorityError()
        if (infrastructureFailure(error)) enterReadOnly(error, generation)
        throw error
      }
    },
  ]))

  const resetAuthority = (nextAuthorityKey) => {
    if (typeof nextAuthorityKey !== 'string') fail('Invalid workspace authority key')
    if (nextAuthorityKey === authorityKey) return false
    authorityKey = nextAuthorityKey
    repository = null
    loadedState = resetLoadedWorkspaceAuthority(loadedState)
    pendingLoads = 0
    readOnly = true
    clientMutationLocked = false
    historicalActivationLock = null
    appointmentMutationLocked = false
    paymentMutationLock = null
    infrastructureError = resetFailedError()
    publish()
    try {
      captured.clearToasts()
      repository = repositoryFrom(repositoryFactory, captured.dispatch, captured.getState)
    } catch {
      throw resetFailedError()
    }
    readOnly = false
    infrastructureError = null
    publish()
    return true
  }

  const subscribe = (listener) => {
    if (typeof listener !== 'function') fail('Invalid workspace subscriber')
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  publish()
  return Object.freeze({
    getSnapshot: () => snapshot,
    resetAuthority,
    subscribe,
  })
}
