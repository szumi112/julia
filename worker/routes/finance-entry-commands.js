import { createFinanceEntry, adjustFinanceEntry, loadFinanceEntry } from '../core/finance-entry-commands.js'
import { AppError } from '../http/errors.js'

const call = async (service, input) => {
  try { return await service(input) } catch (error) {
    if (error?.message?.startsWith('VALIDATION_FAILED/')) {
      throw new AppError('VALIDATION_FAILED', { field: 'body' })
    }
    throw error
  }
}
export const postFinanceEntry = (input) => call(createFinanceEntry, input)
export const postFinanceAdjustment = (input) => call(adjustFinanceEntry, input)
export const getFinanceEntry = (input) => call(loadFinanceEntry, input)
