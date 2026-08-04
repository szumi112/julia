import {
  createAppointment,
  editAppointment,
  validateCreateAppointmentBody,
  validateEditAppointmentBody,
} from '../core/appointments.js'
import { AppError } from '../http/errors.js'

const BASE_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const EDIT_KEYS = Object.freeze([...BASE_KEYS.slice(0, 7), 'appointmentId', ...BASE_KEYS.slice(7)])
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/

const capture = (value, baseKeys = BASE_KEYS, serviceKey = 'create') => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INTERNAL_ERROR')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    const expected = keys.includes(serviceKey) ? [...baseKeys, serviceKey] : baseKeys
    if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
      throw new Error('INTERNAL_ERROR')
    }
    const result = {}
    for (const key of expected) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
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

const validationMessage = (error) => {
  try {
    if (error instanceof TypeError) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
      if (descriptor && Object.hasOwn(descriptor, 'value')) return descriptor.value
    }
  } catch { throw new Error('INTERNAL_ERROR') }
  return null
}

export async function postAppointment(input) {
  const captured = capture(input)
  const service = captured.create ?? createAppointment
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  try {
    validateCreateAppointmentBody(captured.body)
    return await service(Object.fromEntries(BASE_KEYS.map((key) => [key, captured[key]])))
  } catch (error) {
    const message = validationMessage(error)
    const match = typeof message === 'string'
      ? /^VALIDATION_FAILED\/(body|clientId|specialistId|serviceId|dateTime|durationMinutes|expectedAmountGrosze|location|status)$/.exec(message)
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}

export async function postAppointmentEdit(input) {
  const captured = capture(input, EDIT_KEYS, 'edit')
  const service = captured.edit ?? editAppointment
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  try {
    if (typeof captured.appointmentId !== 'string'
      || !APPOINTMENT_ID.test(captured.appointmentId)) {
      throw new TypeError('VALIDATION_FAILED/appointmentId')
    }
    validateEditAppointmentBody(captured.body)
    return await service(Object.fromEntries(EDIT_KEYS.map((key) => [key, captured[key]])))
  } catch (error) {
    const message = validationMessage(error)
    const match = typeof message === 'string'
      ? /^VALIDATION_FAILED\/(body|appointmentId|specialistId|serviceId|dateTime|durationMinutes|expectedAmountGrosze|location|status|expectedVersion)$/.exec(message)
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}
