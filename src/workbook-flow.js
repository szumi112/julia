const IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const CONFLICT_ID = /^wmc_[A-Za-z0-9_-]{1,123}$/
const PLAN_DIGEST = /^v[1-9]\d*_[A-Za-z0-9_-]{43}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/

export const WORKBOOK_FLOW_ACTIONS = Object.freeze({
  FILE_SELECTED: 'file-selected',
  PREVIEW_SUCCEEDED: 'preview-succeeded',
  RESOLUTION_CHANGED: 'resolution-changed',
  COMMIT_STARTED: 'commit-started',
  COMMIT_SUCCEEDED: 'commit-succeeded',
  BATCH_SELECTED: 'batch-selected',
  RESOLUTIONS_RECORDED: 'resolutions-recorded',
  CONTINUE_STARTED: 'continue-started',
  STATUS_SUCCEEDED: 'status-succeeded',
  REQUEST_FAILED: 'request-failed',
  RESET: 'reset',
  AUTHORITY_RESET: 'authority-reset',
})

const ACTION_SET = new Set(Object.values(WORKBOOK_FLOW_ACTIONS))

const invalidTransition = () => {
  throw new TypeError('WORKBOOK_FLOW_INVALID_TRANSITION')
}

const cloneFrozen = (raw, state = { count: 0 }, depth = 0) => {
  state.count += 1
  if (state.count > 25_000 || depth > 10) throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
  if (raw === null || typeof raw === 'boolean' || typeof raw === 'string') return raw
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
    return raw
  }
  if (Array.isArray(raw)) {
    let descriptors
    let length
    try {
      descriptors = Object.getOwnPropertyDescriptors(raw)
      length = descriptors.length?.value
      if (Object.getPrototypeOf(raw) !== Array.prototype
        || !Number.isSafeInteger(length) || length < 0 || length > 5_000
        || Reflect.ownKeys(descriptors).length !== length + 1) {
        throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
      }
    } catch { throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT') }
    const values = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
      }
      values.push(cloneFrozen(descriptor.value, state, depth + 1))
    }
    return Object.freeze(values)
  }
  try {
    if (raw === null || typeof raw !== 'object'
      || Object.getPrototypeOf(raw) !== Object.prototype) {
      throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
    }
    const descriptors = Object.getOwnPropertyDescriptors(raw)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length > 128 || keys.some((key) => typeof key !== 'string'
      || ['__proto__', 'constructor', 'prototype'].includes(key))) {
      throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
    }
    const result = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
      }
      result[key] = cloneFrozen(descriptor.value, state, depth + 1)
    }
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof TypeError && error.message === 'WORKBOOK_FLOW_INVALID_EVENT') throw error
    throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
  }
}

const emptyState = (generation, phase = 'idle', errorCode = null) => Object.freeze({
  generation,
  phase,
  hasSelectedFile: false,
  preview: null,
  resolutions: Object.freeze([]),
  continuation: null,
  errorCode,
})

export const createWorkbookFlowState = (generation) => {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError('WORKBOOK_FLOW_INVALID_GENERATION')
  }
  return emptyState(generation)
}

const nextState = (state, values) => Object.freeze({
  generation: state.generation,
  phase: state.phase,
  hasSelectedFile: state.hasSelectedFile,
  preview: state.preview,
  resolutions: state.resolutions,
  continuation: state.continuation,
  errorCode: state.errorCode,
  ...values,
})

const phaseForStatus = (status) => {
  if (status === 'complete') return 'complete'
  if (status === 'conflicts') return 'needs-resolution'
  if (['uploading', 'ready', 'materializing'].includes(status)) return 'materializing'
  if (status === 'failed') return 'failed'
  throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
}

const captureImported = (raw) => {
  let id
  let status
  let version
  let createdByStaffId
  let resolutionVersion
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error('invalid')
    const descriptors = Object.getOwnPropertyDescriptors(raw)
    const read = (key, fallback) => {
      const descriptor = descriptors[key]
      if (!descriptor) return fallback
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('invalid')
      }
      return descriptor.value
    }
    id = read('id')
    status = read('status')
    version = read('version')
    createdByStaffId = read('createdByStaffId')
    resolutionVersion = read('resolutionVersion', null)
  } catch {
    throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
  }
  if (typeof id !== 'string' || !IMPORT_ID.test(id)
    || !['uploading', 'ready', 'materializing', 'conflicts', 'complete', 'failed']
      .includes(status)
    || !Number.isSafeInteger(version) || version < 1
    || !(resolutionVersion === null
      || (Number.isSafeInteger(resolutionVersion) && resolutionVersion >= 0))
    || typeof createdByStaffId !== 'string' || !STAFF_ID.test(createdByStaffId)) {
    throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
  }
  return Object.freeze({ id, status, version, createdByStaffId, resolutionVersion })
}

export const matchesWorkbookContinuationImport = (
  rawImported, continuation, { requireNewer = false } = {},
) => {
  try {
    const imported = captureImported(rawImported)
    return continuation !== null && typeof continuation === 'object'
      && imported.id === continuation.importId
      && imported.createdByStaffId === continuation.createdByStaffId
      && (requireNewer
        ? imported.version > continuation.importVersion
        : imported.version >= continuation.importVersion)
  } catch { return false }
}

export const matchesWorkbookResolutionResult = (result, continuation) => {
  try {
    return result !== null && typeof result === 'object'
      && continuation !== null && typeof continuation === 'object'
      && result.importId === continuation.importId
      && Number.isSafeInteger(result.resolutionCount) && result.resolutionCount > 0
      && Number.isSafeInteger(result.importVersion)
      && result.importVersion > continuation.importVersion
      && Number.isSafeInteger(result.resolutionVersion)
      && (continuation.resolutionVersion === null
        || result.resolutionVersion > continuation.resolutionVersion)
  } catch { return false }
}

const continuationFor = (imported, planDigest, resolutionCount = null) => Object.freeze({
  importId: imported.id,
  importVersion: imported.version,
  resolutionVersion: imported.resolutionVersion,
  createdByStaffId: imported.createdByStaffId,
  status: imported.status,
  planDigest,
  resolutionCount,
})

const transitionFromImport = (state, rawImported, planDigest) => {
  const imported = captureImported(rawImported)
  const phase = phaseForStatus(imported.status)
  if (phase === 'failed') return emptyState(state.generation, 'failed', 'WORKBOOK_IMPORT_FAILED')
  return nextState(state, {
    phase,
    hasSelectedFile: false,
    preview: null,
    resolutions: Object.freeze([]),
    continuation: continuationFor(imported, planDigest),
    errorCode: null,
  })
}

const updateResolution = (state, event) => {
  const { conflictId, specialistId } = event
  if (typeof conflictId !== 'string' || !CONFLICT_ID.test(conflictId)
    || !(specialistId === null || (typeof specialistId === 'string'
      && SPECIALIST_ID.test(specialistId)))) {
    throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
  }
  const resolutions = state.resolutions.filter((item) => item.conflictId !== conflictId)
  if (specialistId !== null) {
    const item = Object.freeze({ conflictId, specialistId })
    const existing = state.resolutions.findIndex((value) => value.conflictId === conflictId)
    if (existing < 0) resolutions.push(item)
    else resolutions.splice(existing, 0, item)
  }
  return nextState(state, { resolutions: Object.freeze(resolutions) })
}

export const workbookFlowReducer = (state, event) => {
  if (!state || typeof state !== 'object' || !Object.isFrozen(state)
    || !event || typeof event !== 'object') {
    throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
  }
  let type
  let generation
  try { ({ type, generation } = event) } catch {
    throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
  }
  if (!ACTION_SET.has(type) || !Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
  }
  if (type === WORKBOOK_FLOW_ACTIONS.AUTHORITY_RESET) {
    return generation <= state.generation ? state : emptyState(generation)
  }
  if (generation !== state.generation) return state

  if (type === WORKBOOK_FLOW_ACTIONS.RESET) return emptyState(state.generation)
  if (type === WORKBOOK_FLOW_ACTIONS.REQUEST_FAILED) {
    let errorCode
    try { errorCode = event.errorCode } catch { throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT') }
    if (state.phase === 'idle' || state.phase === 'complete'
      || typeof errorCode !== 'string' || !ERROR_CODE.test(errorCode)) invalidTransition()
    if (state.phase === 'committing' && errorCode === 'WORKBOOK_COMMIT_FAILED') {
      return nextState(state, { phase: 'review', errorCode })
    }
    return emptyState(state.generation, 'failed', errorCode)
  }
  if (type === WORKBOOK_FLOW_ACTIONS.FILE_SELECTED) {
    if (!['idle', 'failed', 'complete'].includes(state.phase)) invalidTransition()
    return nextState(emptyState(state.generation), {
      phase: 'previewing', hasSelectedFile: true,
    })
  }
  if (type === WORKBOOK_FLOW_ACTIONS.PREVIEW_SUCCEEDED) {
    if (state.phase !== 'previewing') invalidTransition()
    const preview = cloneFrozen(event.preview)
    if (!preview || typeof preview !== 'object'
      || typeof preview.previewToken !== 'string' || preview.previewToken.length > 4_096
      || typeof preview.planDigest !== 'string' || !PLAN_DIGEST.test(preview.planDigest)) {
      throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
    }
    return nextState(state, { phase: 'review', preview, errorCode: null })
  }
  if (type === WORKBOOK_FLOW_ACTIONS.RESOLUTION_CHANGED) {
    if (!['review', 'needs-resolution'].includes(state.phase)) invalidTransition()
    return updateResolution(state, event)
  }
  if (type === WORKBOOK_FLOW_ACTIONS.COMMIT_STARTED) {
    if (state.phase !== 'review' || !state.hasSelectedFile || state.preview === null) {
      invalidTransition()
    }
    return nextState(state, { phase: 'committing' })
  }
  if (type === WORKBOOK_FLOW_ACTIONS.COMMIT_SUCCEEDED) {
    if (state.phase !== 'committing' || state.preview === null) invalidTransition()
    return transitionFromImport(state, event.imported, state.preview.planDigest)
  }
  if (type === WORKBOOK_FLOW_ACTIONS.BATCH_SELECTED) {
    if (!['idle', 'failed', 'complete'].includes(state.phase)) invalidTransition()
    let planDigest
    try { planDigest = event.planDigest ?? null } catch {
      throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
    }
    if (!(planDigest === null || (typeof planDigest === 'string'
      && PLAN_DIGEST.test(planDigest)))) throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
    return transitionFromImport(emptyState(state.generation), event.imported, planDigest)
  }
  if (type === WORKBOOK_FLOW_ACTIONS.RESOLUTIONS_RECORDED) {
    if (state.phase !== 'needs-resolution' || state.continuation === null) invalidTransition()
    let result
    try { result = event.result } catch { throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT') }
    if (!result || result.importId !== state.continuation.importId
      || !Number.isSafeInteger(result.resolutionCount) || result.resolutionCount < 1
      || !Number.isSafeInteger(result.importVersion) || result.importVersion < 1
      || !Number.isSafeInteger(result.resolutionVersion) || result.resolutionVersion < 1
      || (state.continuation.resolutionVersion !== null
        && result.resolutionVersion <= state.continuation.resolutionVersion)
      || result.importVersion <= state.continuation.importVersion) {
      throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
    }
    return nextState(state, {
      phase: 'materializing',
      resolutions: Object.freeze([]),
      continuation: Object.freeze({
        ...state.continuation,
        importVersion: result.importVersion,
        resolutionVersion: result.resolutionVersion,
        status: 'materializing',
        resolutionCount: result.resolutionCount,
      }),
    })
  }
  if (type === WORKBOOK_FLOW_ACTIONS.CONTINUE_STARTED) {
    if (state.phase !== 'materializing' || state.continuation === null) invalidTransition()
    return nextState(state, { phase: 'continuing' })
  }
  if (type === WORKBOOK_FLOW_ACTIONS.STATUS_SUCCEEDED) {
    if (!['materializing', 'continuing', 'needs-resolution'].includes(state.phase)
      || state.continuation === null) invalidTransition()
    const imported = captureImported(event.imported)
    if (imported.id !== state.continuation.importId
      || imported.createdByStaffId !== state.continuation.createdByStaffId
      || imported.version < state.continuation.importVersion) {
      throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
    }
    const refreshed = imported.resolutionVersion === null
      ? Object.freeze({ ...imported, resolutionVersion: state.continuation.resolutionVersion })
      : imported
    let planDigest = state.continuation.planDigest
    if (refreshed.status === 'conflicts') {
      try { planDigest = event.planDigest } catch {
        throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
      }
      if (typeof planDigest !== 'string' || !PLAN_DIGEST.test(planDigest)) {
        throw new TypeError('WORKBOOK_FLOW_INVALID_EVENT')
      }
    }
    return transitionFromImport(state, refreshed, planDigest)
  }
  return invalidTransition()
}
