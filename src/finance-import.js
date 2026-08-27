import { validateFinanceEntryInput } from './finance-records.js'
import { searchNorm } from './format.js'

const BATCH_ID = /^fib_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/

const specialistMap = (specialists) => {
  if (!Array.isArray(specialists)) throw new TypeError('FINANCE_IMPORT_INPUT_INVALID')
  const result = new Map()
  for (const specialist of specialists) {
    if (!specialist || typeof specialist.id !== 'string' || typeof specialist.name !== 'string') {
      throw new TypeError('FINANCE_IMPORT_INPUT_INVALID')
    }
    result.set(searchNorm(specialist.name), specialist.id)
  }
  return result
}

const settlement = (row) => {
  if (row.settlementStatus === 'paid') {
    return { settlementStatus: 'paid', paidAmountGrosze: row.amountGrosze }
  }
  if (row.settlementStatus === 'unpaid') {
    return { settlementStatus: 'unpaid', paidAmountGrosze: 0 }
  }
  return { settlementStatus: 'unknown', paidAmountGrosze: 0 }
}

export function financeImportEntry(row, batchId, specialists) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || typeof batchId !== 'string' || !BATCH_ID.test(batchId)) {
    throw new TypeError('FINANCE_IMPORT_INPUT_INVALID')
  }
  const byName = specialistMap(specialists)
  const paid = settlement(row)
  const value = {
    kind: row.recordType === 'expense' ? 'expense' : 'income',
    recordType: row.recordType,
    accountingMonth: row.accountingMonth,
    occurredOn: row.occurredOn,
    amountGrosze: row.amountGrosze,
    paidAmountGrosze: paid.paidAmountGrosze,
    paymentMethod: row.paymentMethod,
    settlementStatus: paid.settlementStatus,
    invoiceStatus: row.invoiceStatus,
    counterparty: row.counterparty,
    sourceLabel: row.sourceLabel,
    invoiceNote: row.invoiceNote,
    specialistId: row.specialistName
      ? byName.get(searchNorm(row.specialistName)) ?? null
      : null,
    lessonCount: row.lessonCount,
    source: {
      batchId,
      sourceKey: row.sourceKey,
      sheet: row.sheet,
      rowNumber: row.rowNumber,
      raw: { ...row.raw },
    },
  }
  return validateFinanceEntryInput(value)
}

export function financeImportChunks(rows, batchId, specialists, chunkSize = 20) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10_000
    || !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 20) {
    throw new TypeError('FINANCE_IMPORT_INPUT_INVALID')
  }
  const entries = rows.map((row) => financeImportEntry(row, batchId, specialists))
  const chunks = []
  for (let index = 0; index < entries.length; index += chunkSize) {
    chunks.push(Object.freeze({
      sequence: chunks.length,
      entries: Object.freeze(entries.slice(index, index + chunkSize)),
    }))
  }
  return Object.freeze(chunks)
}
