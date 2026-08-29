import { apiClient } from './api.js'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const CURSOR = /^c_(?:0|[1-9]\d{0,5})_r[1-9]\d*$/
const IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ENTRY_ID = /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const CONFLICT_ID = /^wmc_[A-Za-z0-9_-]{1,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const PREVIEW_TOKEN = /^v1\.[1-9]\d*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/
const VERSIONED_DIGEST = /^v[1-9]\d*_[A-Za-z0-9_-]{43}$/
const INVALID_TEXT = /[\p{Cc}\p{Cf}]/u

const PUBLIC_METHODS = Object.freeze([
  'loadFinanceWindow', 'loadRegistryPage', 'loadRegistryDetail', 'previewWorkbook',
  'createWorkbookImport', 'continueWorkbookImport', 'getWorkbookImport',
  'recordWorkbookResolutions', 'exportWorkbook', 'voidLedgerEntry',
])
const DEPENDENCIES = Object.freeze({
  loadFinanceWindow: 'loadFinanceWindow',
  loadRegistryPage: 'loadWorkbookRegistry',
  loadRegistryDetail: 'loadWorkbookRegistryDetail',
  previewWorkbook: 'previewWorkbook',
  createWorkbookImport: 'createWorkbookImport',
  continueWorkbookImport: 'continueWorkbookImport',
  getWorkbookImport: 'getWorkbookImport',
  recordWorkbookResolutions: 'recordWorkbookResolutions',
  exportWorkbook: 'exportWorkbook',
  voidLedgerEntry: 'voidLedgerEntry',
})

const invalidInput = () => new TypeError('CLIENT_INPUT_INVALID')

const captureObject = (raw, keys) => {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) return null
    const descriptors = Object.getOwnPropertyDescriptors(raw)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) return null
    const result = Object.create(null)
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      result[key] = descriptor.value
    }
    return result
  } catch {
    return null
  }
}

const captureOptions = (raw, { idempotency = false } = {}) => {
  if (raw === undefined) return Object.freeze({
    ...(idempotency ? { idempotencyKey: undefined } : {}), signal: undefined,
  })
  const allowed = idempotency ? ['idempotencyKey', 'signal'] : ['signal']
  let keys
  try { keys = Reflect.ownKeys(raw) } catch { return null }
  const value = captureObject(raw, keys)
  let validSignal = false
  try {
    validSignal = value?.signal === undefined
      || (typeof AbortSignal === 'function' && value.signal instanceof AbortSignal)
  } catch { return null }
  if (!value || keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
    || (idempotency && value.idempotencyKey !== undefined
      && (typeof value.idempotencyKey !== 'string'
        || !IDEMPOTENCY_KEY.test(value.idempotencyKey)))
    || !validSignal) return null
  return Object.freeze({
    ...(idempotency ? { idempotencyKey: value.idempotencyKey } : {}),
    signal: value.signal,
  })
}

const captureFile = (raw) => {
  try {
    return typeof File === 'function' && raw instanceof File
      && Number.isSafeInteger(raw.size) && raw.size >= 1 && raw.size <= MAX_WORKBOOK_BYTES
      && typeof raw.name === 'string' && raw.name.length >= 6 && raw.name.length <= 255
      && raw.name === raw.name.trim() && raw.name === raw.name.normalize('NFC')
      && raw.name.toLowerCase().endsWith('.xlsx') && !raw.name.includes('/')
      && !raw.name.includes('\\') && !INVALID_TEXT.test(raw.name)
      && ['', XLSX_MIME].includes(raw.type)
      ? raw
      : null
  } catch {
    return null
  }
}

const captureResolutions = (raw, { requireOne = false } = {}) => {
  let descriptors
  let length
  try {
    descriptors = Object.getOwnPropertyDescriptors(raw)
    length = descriptors.length?.value
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
      || !Number.isSafeInteger(length) || length < 0 || length > 100
      || Reflect.ownKeys(descriptors).length !== length + 1
      || (requireOne && length < 1)) return null
  } catch { return null }
  const result = []
  const ids = new Set()
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    const value = captureObject(descriptor.value, ['conflictId', 'specialistId'])
    if (!value || typeof value.conflictId !== 'string' || !CONFLICT_ID.test(value.conflictId)
      || typeof value.specialistId !== 'string' || !SPECIALIST_ID.test(value.specialistId)
      || ids.has(value.conflictId)) return null
    ids.add(value.conflictId)
    result.push(Object.freeze({
      conflictId: value.conflictId, specialistId: value.specialistId,
    }))
  }
  return Object.freeze(result)
}

const captureResult = (raw, state = { count: 0 }, depth = 0) => {
  state.count += 1
  if (state.count > 30_000 || depth > 12) throw new TypeError('CLIENT_RESULT_INVALID')
  if (raw === null || typeof raw === 'boolean' || typeof raw === 'string') return raw
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new TypeError('CLIENT_RESULT_INVALID')
    return raw
  }
  if (Array.isArray(raw)) {
    let descriptors
    let length
    try {
      descriptors = Object.getOwnPropertyDescriptors(raw)
      length = descriptors.length?.value
      if (Object.getPrototypeOf(raw) !== Array.prototype
        || !Number.isSafeInteger(length) || length < 0 || length > 10_000
        || Reflect.ownKeys(descriptors).length !== length + 1) {
        throw new TypeError('CLIENT_RESULT_INVALID')
      }
    } catch { throw new TypeError('CLIENT_RESULT_INVALID') }
    const result = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('CLIENT_RESULT_INVALID')
      }
      result.push(captureResult(descriptor.value, state, depth + 1))
    }
    return Object.freeze(result)
  }
  const keys = (() => {
    try {
      if (raw === null || typeof raw !== 'object'
        || Object.getPrototypeOf(raw) !== Object.prototype) return null
      return Reflect.ownKeys(raw)
    } catch { return null }
  })()
  if (!keys || keys.length > 128 || keys.some((key) => typeof key !== 'string'
    || ['__proto__', 'constructor', 'prototype'].includes(key))) {
    throw new TypeError('CLIENT_RESULT_INVALID')
  }
  const captured = captureObject(raw, keys)
  if (!captured) throw new TypeError('CLIENT_RESULT_INVALID')
  const result = {}
  for (const key of keys) {
    result[key] = captureResult(captured[key], state, depth + 1)
  }
  return Object.freeze(result)
}

const captureDependencies = (raw) => {
  try {
    if (raw === null || typeof raw !== 'object') throw new Error('invalid')
    const descriptors = Object.getOwnPropertyDescriptors(raw)
    const result = {}
    for (const dependency of Object.values(DEPENDENCIES)) {
      const descriptor = descriptors[dependency]
      if (!descriptor || !Object.hasOwn(descriptor, 'value')
        || typeof descriptor.value !== 'function') throw new Error('invalid')
      result[dependency] = descriptor.value
    }
    return Object.freeze(result)
  } catch {
    throw new TypeError('CLIENT_DEPENDENCY_INVALID')
  }
}

export const createFinanceRepository = (rawDependencies) => {
  const dependencies = captureDependencies(rawDependencies)
  const capture = async (promise) => captureResult(await promise)
  const repository = {
    async loadFinanceWindow(input, options) {
      const value = captureObject(input, ['selectedMonth'])
      const acceptedOptions = captureOptions(options)
      if (!value || typeof value.selectedMonth !== 'string' || !MONTH.test(value.selectedMonth)
        || value.selectedMonth < '2000-06'
        || !acceptedOptions) throw invalidInput()
      return capture(dependencies.loadFinanceWindow(
        Object.freeze({ selectedMonth: value.selectedMonth }), acceptedOptions,
      ))
    },
    async loadRegistryPage(input, options) {
      const value = captureObject(input, ['cursor', 'section'])
      const acceptedOptions = captureOptions(options)
      if (!value || !['all', 'imports', 'exports', 'entries', 'unknown'].includes(value.section)
        || !(value.cursor === null || (typeof value.cursor === 'string'
          && CURSOR.test(value.cursor))) || !acceptedOptions) throw invalidInput()
      return capture(dependencies.loadWorkbookRegistry(Object.freeze({
        cursor: value.cursor, section: value.section,
      }), acceptedOptions))
    },
    async loadRegistryDetail(input, options) {
      const value = captureObject(input, ['importId', 'section', 'cursor'])
      const acceptedOptions = captureOptions(options)
      if (!value || typeof value.importId !== 'string' || !IMPORT_ID.test(value.importId)
        || !['source', 'quarantine', 'conflicts', 'duplicates', 'resolutions', 'entries']
          .includes(value.section)
        || !(value.cursor === null || (typeof value.cursor === 'string'
          && CURSOR.test(value.cursor))) || !acceptedOptions) throw invalidInput()
      return capture(dependencies.loadWorkbookRegistryDetail(Object.freeze({
        importId: value.importId, section: value.section, cursor: value.cursor,
      }), acceptedOptions))
    },
    async previewWorkbook(rawFile, options) {
      const file = captureFile(rawFile)
      const acceptedOptions = captureOptions(options)
      if (!file || !acceptedOptions) throw invalidInput()
      return capture(dependencies.previewWorkbook(file, acceptedOptions))
    },
    async createWorkbookImport(rawFile, previewToken, rawResolutions, options) {
      const file = captureFile(rawFile)
      const resolutions = captureResolutions(rawResolutions)
      const acceptedOptions = captureOptions(options, { idempotency: true })
      if (!file || typeof previewToken !== 'string' || previewToken.length > 4_096
        || !PREVIEW_TOKEN.test(previewToken) || !resolutions || !acceptedOptions) {
        throw invalidInput()
      }
      return capture(dependencies.createWorkbookImport(
        file, previewToken, resolutions, acceptedOptions,
      ))
    },
    async continueWorkbookImport(importId, expectedVersion, options) {
      const acceptedOptions = captureOptions(options, { idempotency: true })
      if (typeof importId !== 'string' || !IMPORT_ID.test(importId)
        || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
        || !acceptedOptions) throw invalidInput()
      return capture(dependencies.continueWorkbookImport(
        importId, expectedVersion, acceptedOptions,
      ))
    },
    async getWorkbookImport(importId, options) {
      const acceptedOptions = captureOptions(options)
      if (typeof importId !== 'string' || !IMPORT_ID.test(importId)
        || !acceptedOptions) throw invalidInput()
      return capture(dependencies.getWorkbookImport(importId, acceptedOptions))
    },
    async recordWorkbookResolutions(importId, input, options) {
      const value = captureObject(input, ['expectedVersion', 'planDigest', 'resolutions'])
      const resolutions = value && captureResolutions(value.resolutions, { requireOne: true })
      const acceptedOptions = captureOptions(options, { idempotency: true })
      if (typeof importId !== 'string' || !IMPORT_ID.test(importId) || !value
        || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 0
        || typeof value.planDigest !== 'string' || !VERSIONED_DIGEST.test(value.planDigest)
        || !resolutions || !acceptedOptions) throw invalidInput()
      return capture(dependencies.recordWorkbookResolutions(importId, Object.freeze({
        expectedVersion: value.expectedVersion, planDigest: value.planDigest, resolutions,
      }), acceptedOptions))
    },
    async exportWorkbook(input, options) {
      const value = captureObject(input, ['format'])
      const acceptedOptions = captureOptions(options)
      if (!value || !['legacy', 'panel-v2'].includes(value.format)
        || !acceptedOptions) throw invalidInput()
      const exported = await dependencies.exportWorkbook(
        Object.freeze({ format: value.format }), acceptedOptions,
      )
      const result = captureObject(exported, ['bytes', 'filename'])
      const bytes = result?.bytes instanceof Uint8Array ? result.bytes : null
      try {
        if (!bytes || bytes.byteLength < 1 || bytes.byteLength > 10 * 1024 * 1024
          || typeof result.filename !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.xlsx$/.test(result.filename)) {
          throw new TypeError('CLIENT_RESULT_INVALID')
        }
        let blob
        try {
          blob = new Blob([bytes], { type: XLSX_MIME })
        } catch {
          throw new TypeError('CLIENT_RESULT_INVALID')
        }
        return Object.freeze({ blob, filename: result.filename })
      } finally {
        bytes?.fill(0)
      }
    },
    async voidLedgerEntry(entryId, expectedVersion, reason, options) {
      const acceptedOptions = captureOptions(options, { idempotency: true })
      if (typeof entryId !== 'string' || !ENTRY_ID.test(entryId)
        || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
        || typeof reason !== 'string' || reason.length < 3 || reason.length > 500
        || reason !== reason.trim() || reason !== reason.normalize('NFC')
        || INVALID_TEXT.test(reason) || !acceptedOptions) throw invalidInput()
      return capture(dependencies.voidLedgerEntry(
        entryId, expectedVersion, reason, acceptedOptions,
      ))
    },
  }
  if (Object.keys(repository).some((name, index) => name !== PUBLIC_METHODS[index])) {
    throw new TypeError('CLIENT_DEPENDENCY_INVALID')
  }
  return Object.freeze(repository)
}

export const financeRepository = createFinanceRepository(apiClient)
