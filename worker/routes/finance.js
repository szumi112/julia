import {
  appendFinanceImportChunk,
  commitFinanceImport,
  listFinanceEntries,
  startFinanceImport,
} from '../core/finance.js'
import { AppError } from '../http/errors.js'

const BASE_KEYS = Object.freeze([
  'db', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
])
const MUTATION_KEYS = Object.freeze([...BASE_KEYS, 'body', 'idempotencyKey'])
const BATCH_MUTATION_KEYS = Object.freeze([
  ...BASE_KEYS, 'batchId', 'body', 'idempotencyKey',
])
const READ_KEYS = Object.freeze(['db', 'actor', 'keyring', 'nowMs', 'url'])

const capture = (value, keys, serviceName) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INTERNAL_ERROR')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    const expected = actual.includes(serviceName) ? [...keys, serviceName] : keys
    if (actual.length !== expected.length || !expected.every((key) => actual.includes(key))) {
      throw new Error('INTERNAL_ERROR')
    }
    const result = {}
    for (const key of expected) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('INTERNAL_ERROR')
      }
      result[key] = descriptor.value
    }
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'INTERNAL_ERROR') throw error
    throw new Error('INTERNAL_ERROR')
  }
}

const mapped = async (operation) => {
  try { return await operation() } catch (error) {
    let message
    try {
      const descriptor = error instanceof Error
        ? Object.getOwnPropertyDescriptor(error, 'message') : null
      if (descriptor && Object.hasOwn(descriptor, 'value')) message = descriptor.value
    } catch { throw new Error('INTERNAL_ERROR') }
    const validation = typeof message === 'string'
      ? /^VALIDATION_FAILED\/(body|filename|fingerprint|formatVersion|totalRows|batchId|sequence|entries|accountingMonth|kind|expectedVersion)$/.exec(message)
      : null
    if (validation) throw new AppError('VALIDATION_FAILED', { field: validation[1] })
    throw error
  }
}

export async function getFinance(input) {
  const command = capture(input, READ_KEYS, 'list')
  const service = command.list ?? listFinanceEntries
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  let url
  try { url = new URL(command.url) } catch { throw new AppError('VALIDATION_FAILED') }
  const keys = [...url.searchParams.keys()]
  if (!url.searchParams.has('month') || keys.some((key) => !['kind', 'month'].includes(key))
    || new Set(keys).size !== keys.length) throw new AppError('VALIDATION_FAILED')
  const rawMonth = url.searchParams.get('month')
  const month = rawMonth === 'unknown' ? null : rawMonth
  const kind = url.searchParams.has('kind') ? url.searchParams.get('kind') : null
  return mapped(() => service({
    db: command.db, actor: command.actor, keyring: command.keyring,
    nowMs: command.nowMs, month, kind,
  }))
}

export async function postFinanceImport(input) {
  const command = capture(input, MUTATION_KEYS, 'start')
  const service = command.start ?? startFinanceImport
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  return mapped(() => service(Object.fromEntries(
    MUTATION_KEYS.map((key) => [key, command[key]])
  )))
}

export async function postFinanceImportChunk(input) {
  const command = capture(input, BATCH_MUTATION_KEYS, 'append')
  const service = command.append ?? appendFinanceImportChunk
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  return mapped(() => service(Object.fromEntries(
    BATCH_MUTATION_KEYS.map((key) => [key, command[key]])
  )))
}

export async function postFinanceImportCommit(input) {
  const command = capture(input, BATCH_MUTATION_KEYS, 'commit')
  const service = command.commit ?? commitFinanceImport
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  return mapped(() => service(Object.fromEntries(
    BATCH_MUTATION_KEYS.map((key) => [key, command[key]])
  )))
}
