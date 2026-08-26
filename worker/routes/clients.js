import {
  archiveClient,
  createClient,
  editClient,
  validateArchiveClientBody,
  validateEditClientBody,
} from '../core/clients.js'
import { AppError } from '../http/errors.js'

const BASE_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const EDIT_KEYS = Object.freeze([...BASE_KEYS.slice(0, 7), 'clientId', ...BASE_KEYS.slice(7)])
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/

const capture = (value, baseKeys = BASE_KEYS, serviceKey = 'create') => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INTERNAL_ERROR')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    const expected = keys.includes(serviceKey) ? [...baseKeys, serviceKey] : baseKeys
    if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) throw new Error('INTERNAL_ERROR')
    const result = {}
    for (const key of expected) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('INTERNAL_ERROR')
      result[key] = descriptor.value
    }
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'INTERNAL_ERROR') throw error
    throw new Error('INTERNAL_ERROR')
  }
}

export async function postClient(input) {
  const captured = capture(input)
  const service = captured.create ?? createClient
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  try {
    return await service(Object.fromEntries(BASE_KEYS.map((key) => [key, captured[key]])))
  } catch (error) {
    let message
    try {
      if (error instanceof TypeError) {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
        if (descriptor && Object.hasOwn(descriptor, 'value')) message = descriptor.value
      }
    } catch { throw new Error('INTERNAL_ERROR') }
    const match = typeof message === 'string'
      ? /^VALIDATION_FAILED\/(body|name|age|status|specialistId)$/.exec(message)
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}

export async function postClientEdit(input) {
  const captured = capture(input, EDIT_KEYS, 'edit')
  const service = captured.edit ?? editClient
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  try {
    if (typeof captured.clientId !== 'string' || !CLIENT_ID.test(captured.clientId)) {
      throw new TypeError('VALIDATION_FAILED/clientId')
    }
    validateEditClientBody(captured.body)
    return await service(Object.fromEntries(EDIT_KEYS.map((key) => [key, captured[key]])))
  } catch (error) {
    let message
    try {
      if (error instanceof TypeError) {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
        if (descriptor && Object.hasOwn(descriptor, 'value')) message = descriptor.value
      }
    } catch { throw new Error('INTERNAL_ERROR') }
    const match = typeof message === 'string'
      ? /^VALIDATION_FAILED\/(body|name|age|status|specialistId|clientId|expectedVersion)$/.exec(message)
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}

export async function postClientArchive(input) {
  const captured = capture(input, EDIT_KEYS, 'archive')
  const service = captured.archive ?? archiveClient
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  try {
    if (typeof captured.clientId !== 'string' || !CLIENT_ID.test(captured.clientId)) {
      throw new TypeError('VALIDATION_FAILED/clientId')
    }
    validateArchiveClientBody(captured.body)
    return await service(Object.fromEntries(EDIT_KEYS.map((key) => [key, captured[key]])))
  } catch (error) {
    let message
    try {
      if (error instanceof TypeError) {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
        if (descriptor && Object.hasOwn(descriptor, 'value')) message = descriptor.value
      }
    } catch { throw new Error('INTERNAL_ERROR') }
    const match = typeof message === 'string'
      ? /^VALIDATION_FAILED\/(body|clientId|expectedVersion)$/.exec(message)
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}
