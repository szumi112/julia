import {
  createSpecialistProfile,
  updateSpecialistProfile,
} from '../core/specialist-profiles.js'
import { AppError } from '../http/errors.js'

const KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])

export async function postSpecialistProfile(input) {
  try {
    const service = input?.create ?? createSpecialistProfile
    if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
    return await service(Object.fromEntries(KEYS.map((key) => [key, input?.[key]])))
  } catch (error) {
    const match = error instanceof TypeError
      ? /^VALIDATION_FAILED\/(body|displayName|standardRateGrosze)$/.exec(error.message)
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}

export async function postSpecialistProfileEdit(input) {
  try {
    const service = input?.edit ?? updateSpecialistProfile
    if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
    return await service({
      ...Object.fromEntries(KEYS.map((key) => [key, input?.[key]])),
      specialistId: input?.specialistId,
    })
  } catch (error) {
    const match = error instanceof TypeError
      ? /^VALIDATION_FAILED\/(body|displayName|standardRateGrosze|expectedVersion)$/.exec(error.message)
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}
