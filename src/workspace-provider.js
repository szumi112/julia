import {
  captureLoadedWorkspaceLoad,
  createLoadedWorkspaceState,
  mergeLoadedWorkspaceLoad,
  recordLoadedWorkspaceWrite,
  resetLoadedWorkspaceAuthority,
} from './loaded-windows.js'

const AUTHORITY_KEYS = Object.freeze([
  'repositoryMode', 'dataMode', 'actorId', 'actorVersion', 'role', 'specialistId',
  'capabilities', 'demoRoleId',
])
const REPOSITORY_METHODS = Object.freeze([
  'loadWindow', 'createClient', 'editClient', 'archiveClient', 'createAppointment',
  'editAppointment', 'cancelAppointment', 'recordPayment', 'correctPayment',
])
const WORKSPACE_METHODS = Object.freeze(REPOSITORY_METHODS.filter((name) => name !== 'loadWindow'))
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
      && (typeof value.demoRoleId !== 'string' || value.demoRoleId.length === 0))) {
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
  ])
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

const readOnlyError = () => {
  const error = new Error('WORKSPACE_READ_ONLY')
  error.code = 'WORKSPACE_READ_ONLY'
  return error
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
  let repositoryFactory = captured.repositoryFactory
  let repository = repositoryFrom(repositoryFactory, captured.dispatch, captured.getState)
  let loadedState = createLoadedWorkspaceState()
  let pendingLoads = 0
  let readOnly = false
  let infrastructureError = null
  let snapshot
  const listeners = new Set()

  const status = () => readOnly ? 'read-only-error' : pendingLoads > 0 ? 'loading' : 'ready'
  const publish = () => {
    snapshot = Object.freeze({
      loadedState,
      workspace: Object.freeze({
        status: status(),
        loadedRanges: loadedState.loadedRanges,
        loadWindow,
        createClient: commands.createClient,
        editClient: commands.editClient,
        archiveClient: commands.archiveClient,
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
    let capture = captureLoadedWorkspaceLoad(loadedState, requested)
    const generation = capture.authorityGeneration
    pendingLoads += 1
    publish()
    try {
      let refetches = 0
      while (true) {
        let rawPayload
        try {
          rawPayload = await repository.loadWindow(Object.freeze({
            from: capture.from,
            to: capture.to,
          }))
        } catch (error) {
          if (infrastructureFailure(error)) enterReadOnly(error, generation)
          throw error
        }
        if (loadedState.authorityGeneration !== generation) return rawPayload
        let merged
        try {
          merged = mergeLoadedWorkspaceLoad(loadedState, capture, rawPayload)
        } catch (error) {
          enterReadOnly(error, generation)
          throw error
        }
        loadedState = merged.state
        if (!merged.refetch || refetches === 1) {
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
      if (readOnly) throw readOnlyError()
      const generation = loadedState.authorityGeneration
      try {
        const result = await repository[name](...args)
        if (loadedState.authorityGeneration === generation) {
          loadedState = recordLoadedWorkspaceWrite(loadedState)
          publish()
        }
        return result
      } catch (error) {
        if (infrastructureFailure(error)) enterReadOnly(error, generation)
        throw error
      }
    },
  ]))

  const resetAuthority = (nextAuthorityKey) => {
    if (typeof nextAuthorityKey !== 'string') fail('Invalid workspace authority key')
    if (nextAuthorityKey === authorityKey) return false
    const nextRepository = repositoryFrom(
      repositoryFactory, captured.dispatch, captured.getState,
    )
    authorityKey = nextAuthorityKey
    repository = nextRepository
    loadedState = resetLoadedWorkspaceAuthority(loadedState)
    pendingLoads = 0
    readOnly = false
    infrastructureError = null
    captured.clearToasts()
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
