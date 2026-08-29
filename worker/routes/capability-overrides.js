import {
  getCapabilityOverrides,
  listCapabilityTargets,
  replaceCapabilityOverrides,
} from '../identity/capability-overrides.js'
import { AppError } from '../http/errors.js'

const LIST_KEYS = Object.freeze(['db', 'cryptoContext', 'actor', 'nowMs'])
const READ_KEYS = Object.freeze([...LIST_KEYS, 'staffId'])
const REPLACE_KEYS = Object.freeze([
  'db', 'recoveryDb', 'cryptoContext', 'actor', 'staffId', 'input',
  'idempotencyKey', 'correlationId', 'nowMs', 'idFactory',
])

const exactInput = (input, keys) => Object.fromEntries(
  keys.map((key) => [key, input?.[key]]),
)

const translateValidation = (error) => {
  const match = error instanceof TypeError
    ? /^VALIDATION_FAILED\/(body|allow|deny|expectedAuthorityRevision)$/.exec(error.message)
    : null
  if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
  throw error
}

export async function getCapabilityTargets(input) {
  try {
    const service = input?.list ?? listCapabilityTargets
    if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
    return await service(exactInput(input, LIST_KEYS))
  } catch (error) {
    return translateValidation(error)
  }
}

export async function getCapabilityOverride(input) {
  try {
    const service = input?.read ?? getCapabilityOverrides
    if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
    return await service(exactInput(input, READ_KEYS))
  } catch (error) {
    return translateValidation(error)
  }
}

export async function postCapabilityOverride(input) {
  try {
    const service = input?.replace ?? replaceCapabilityOverrides
    if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
    return await service(exactInput(input, REPLACE_KEYS))
  } catch (error) {
    return translateValidation(error)
  }
}
