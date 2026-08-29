import {
  createSpecialistProfile,
  updateSpecialistProfile,
} from '../core/specialist-profiles.js'
import { linkSpecialistAccount } from '../core/specialist-account-links.js'
import { AppError } from '../http/errors.js'

const KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const LINK_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'specialistId', 'body', 'idempotencyKey',
])

export async function postSpecialistProfile(input) {
  try {
    const service = input?.create ?? createSpecialistProfile
    if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
    return await service(Object.fromEntries(KEYS.map((key) => [key, input?.[key]])))
  } catch (error) {
    const match = error instanceof TypeError
      ? /^VALIDATION_FAILED\/(body|displayName|professionalTitle|standardRateGrosze)$/.exec(error.message)
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
      ? /^VALIDATION_FAILED\/(body|displayName|professionalTitle|standardRateGrosze|expectedVersion)$/.exec(error.message)
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}

export async function postSpecialistAccountLink(input) {
  try {
    const service = input?.link ?? linkSpecialistAccount
    if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
    return await service(Object.fromEntries(LINK_KEYS.map((key) => [key, input?.[key]])))
  } catch (error) {
    const match = error instanceof TypeError
      ? /^VALIDATION_FAILED\/(body|staffId|expectedSpecialistVersion|expectedStaffVersion)$/.exec(
          error.message,
        )
      : null
    if (match) throw new AppError('VALIDATION_FAILED', { field: match[1] })
    throw error
  }
}
