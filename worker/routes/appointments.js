import { createAppointment, validateCreateAppointmentBody } from '../core/appointments.js'
import { AppError } from '../http/errors.js'

const BASE_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])

const capture = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INTERNAL_ERROR')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    const expected = keys.includes('create') ? [...BASE_KEYS, 'create'] : BASE_KEYS
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

export async function postAppointment(input) {
  const captured = capture(input)
  const service = captured.create ?? createAppointment
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  try {
    validateCreateAppointmentBody(captured.body)
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
      ? /^VALIDATION_FAILED\/(body|clientId|specialistId|serviceId|dateTime|durationMinutes|expectedAmountGrosze|location|status)$/.exec(message)
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}
