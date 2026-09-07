import { createActivityCharge } from '../core/activity-billing.js'
import { AppError } from '../http/errors.js'

export async function postActivityCharge(input) {
  try { return await createActivityCharge(input) } catch (error) {
    if (error?.message?.startsWith('VALIDATION_FAILED/')) {
      throw new AppError('VALIDATION_FAILED', { field: 'body' })
    }
    throw error
  }
}
