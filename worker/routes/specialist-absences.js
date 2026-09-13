import {
  cancelSpecialistAbsence,
  createSpecialistAbsence,
  listSpecialistAbsences,
} from '../core/specialist-absences.js'
import { AppError } from '../http/errors.js'

const BASE_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const READ_KEYS = Object.freeze(['db', 'actor', 'keyring', 'nowMs', 'url'])
const CANCEL_KEYS = Object.freeze([...BASE_KEYS.slice(0, 7), 'absenceId', ...BASE_KEYS.slice(7)])
const ABSENCE_ID = /^abs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/

const capture = (value, keys) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INTERNAL_ERROR')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length || actual.some((key) => (
    typeof key !== 'string' || !keys.includes(key)
    || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')
  ))) throw new Error('INTERNAL_ERROR')
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])))
}

const validationMessage = (error) => error instanceof TypeError
  && typeof error.message === 'string' ? error.message : null

const mapValidation = (error) => {
  const message = validationMessage(error)
  const match = typeof message === 'string'
    ? /^VALIDATION_FAILED\/(body|specialistId|dateRange|allDay|query|absenceId|expectedVersion)$/.exec(message)
    : null
  if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
  throw error
}

export async function getSpecialistAbsences(input) {
  const captured = capture(input, READ_KEYS)
  try { return await listSpecialistAbsences(captured) } catch (error) { return mapValidation(error) }
}

export async function postSpecialistAbsence(input) {
  const captured = capture(input, Object.hasOwn(input ?? {}, 'create')
    ? [...BASE_KEYS, 'create'] : BASE_KEYS)
  try {
    return await (captured.create ?? createSpecialistAbsence)(Object.freeze(
      Object.fromEntries(BASE_KEYS.map((key) => [key, captured[key]])),
    ))
  } catch (error) { return mapValidation(error) }
}

export async function postSpecialistAbsenceCancellation(input) {
  const captured = capture(input, Object.hasOwn(input ?? {}, 'cancel')
    ? [...CANCEL_KEYS, 'cancel'] : CANCEL_KEYS)
  if (typeof captured.absenceId !== 'string' || !ABSENCE_ID.test(captured.absenceId)) {
    throw new AppError('VALIDATION_FAILED', { field: 'absenceId' })
  }
  try {
    return await (captured.cancel ?? cancelSpecialistAbsence)(Object.freeze(
      Object.fromEntries(CANCEL_KEYS.map((key) => [key, captured[key]])),
    ))
  } catch (error) { return mapValidation(error) }
}
