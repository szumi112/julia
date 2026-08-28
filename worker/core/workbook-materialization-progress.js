import { compareUtf16CodeUnits } from '../../src/code-unit-order.js'

const PROGRESS_KEYS = Object.freeze([
  'accepted',
  'accountingMonthsCorrected',
  'candidateCount',
  'financeBatchId',
  'fixedRevenuesInserted',
  'formulaGhostsVoided',
  'inserted',
  'linked',
  'quarantined',
  'quarantinedVoided',
  'specialistAssignmentsCorrected',
  'textAmountVisitsInserted',
  'voided',
])
const CANONICAL_KEYS = [...PROGRESS_KEYS].sort(compareUtf16CodeUnits).join('\n')
const FINANCE_BATCH_ID = /^fib_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/

const invalid = () => { throw new Error('WORKBOOK_MATERIALIZATION_INVALID') }

export function parseWorkbookMaterializationProgress(value) {
  let progress
  try { progress = JSON.parse(value) } catch { invalid() }
  if (!progress || Array.isArray(progress) || typeof progress !== 'object'
    || Object.keys(progress).sort(compareUtf16CodeUnits).join('\n') !== CANONICAL_KEYS
    || PROGRESS_KEYS.filter((key) => key !== 'financeBatchId').some((key) => (
      !Number.isSafeInteger(progress[key]) || progress[key] < 0
    ))
    || !(progress.financeBatchId === null
      || (typeof progress.financeBatchId === 'string'
        && FINANCE_BATCH_ID.test(progress.financeBatchId)))) invalid()
  return { ...progress }
}
