import {
  correctAppointmentPayment,
  loadOwnPaymentsWindow,
  validateCorrectPaymentBody,
} from '../core/payments.js'
import { AppError } from '../http/errors.js'

const KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'paymentId', 'body', 'idempotencyKey',
])
const PAYMENT_ID = /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const OWN_PAYMENT_KEYS = Object.freeze(['db', 'actor', 'url'])

const capture = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INTERNAL_ERROR')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    const expected = keys.includes('correctPayment') ? [...KEYS, 'correctPayment'] : KEYS
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

export async function getOwnPayments(input) {
  let descriptors
  try { descriptors = Object.getOwnPropertyDescriptors(input) } catch {
    throw new Error('INTERNAL_ERROR')
  }
  const keys = Reflect.ownKeys(descriptors)
  const expected = keys.includes('load') ? [...OWN_PAYMENT_KEYS, 'load'] : OWN_PAYMENT_KEYS
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new Error('INTERNAL_ERROR')
  }
  const captured = {}
  for (const key of expected) {
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error('INTERNAL_ERROR')
    }
    captured[key] = descriptor.value
  }
  const load = captured.load ?? loadOwnPaymentsWindow
  if (typeof load !== 'function' || typeof captured.url !== 'string') {
    throw new Error('INTERNAL_ERROR')
  }
  return load(Object.fromEntries(OWN_PAYMENT_KEYS.map((key) => [key, captured[key]])))
}

export async function postPaymentCorrection(input) {
  const captured = capture(input)
  const service = captured.correctPayment ?? correctAppointmentPayment
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  try {
    if (typeof captured.paymentId !== 'string' || !PAYMENT_ID.test(captured.paymentId)) {
      throw new TypeError('VALIDATION_FAILED/paymentId')
    }
    validateCorrectPaymentBody(captured.body)
    return await service(Object.fromEntries(KEYS.map((key) => [key, captured[key]])))
  } catch (error) {
    const message = validationMessage(error)
    const match = typeof message === 'string'
      ? /^VALIDATION_FAILED\/(body|paymentId|expectedVersion|reason|replacement|amountGrosze|method|receivedAt)$/.exec(message)
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}
