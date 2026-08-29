const SOURCE_KEY = /^workbook:v1:\d{1,4}:\d{1,7}:\d{1,5}$/
const FINANCE_ID = /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/

const invalid = () => { throw new Error('WORKBOOK_RECONCILIATION_INVALID') }
const conflict = () => { throw new Error('WORKBOOK_RECONCILIATION_CONFLICT') }

const mappingSnapshot = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const result = new Map()
  for (const sourceName of Object.keys(value)) {
    const specialistId = value[sourceName]
    if (typeof sourceName !== 'string' || sourceName !== sourceName.trim().normalize('NFC')
      || !SPECIALIST_ID.test(specialistId)) invalid()
    result.set(sourceName, specialistId)
  }
  return result
}

const sourceRecords = (rows, kind) => {
  if (!Array.isArray(rows)) invalid()
  const result = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.sourceKey !== 'string' || !SOURCE_KEY.test(row.sourceKey)
      || result.has(row.sourceKey)) invalid()
    if (kind === 'accepted') {
      if (!['income', 'expense', 'tus', 'english'].includes(row.recordType)
        || (row.accountingMonth !== null
          && (typeof row.accountingMonth !== 'string' || !MONTH.test(row.accountingMonth)))
        || (row.specialistName !== null
          && (typeof row.specialistName !== 'string'
            || row.specialistName !== row.specialistName.trim().normalize('NFC')))) invalid()
    }
    result.set(row.sourceKey, row)
  }
  return result
}

const existingRecords = (rows) => {
  if (!Array.isArray(rows)) invalid()
  const bySource = new Map()
  const ids = new Set()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.id !== 'string' || !FINANCE_ID.test(row.id) || ids.has(row.id)
      || typeof row.sourceKey !== 'string' || !SOURCE_KEY.test(row.sourceKey)
      || bySource.has(row.sourceKey)
      || (row.accountingMonth !== null
        && (typeof row.accountingMonth !== 'string' || !MONTH.test(row.accountingMonth)))
      || (row.specialistId !== null
        && (typeof row.specialistId !== 'string' || !SPECIALIST_ID.test(row.specialistId)))
    ) invalid()
    ids.add(row.id)
    bySource.set(row.sourceKey, row)
  }
  return bySource
}

export function planWorkbookFinanceReconciliation({
  acceptedRows,
  quarantinedRows,
  existingEntries,
  specialistMappings,
} = {}) {
  const accepted = sourceRecords(acceptedRows, 'accepted')
  const quarantined = sourceRecords(quarantinedRows, 'quarantined')
  if ([...quarantined.keys()].some((sourceKey) => accepted.has(sourceKey))) invalid()
  const existing = existingRecords(existingEntries)
  const mappings = mappingSnapshot(specialistMappings)
  const targetSpecialist = new Map()
  for (const [sourceKey, row] of accepted) {
    const sourceName = row.specialistName ?? ''
    const specialistId = mappings.get(sourceName)
    if (!specialistId) conflict()
    targetSpecialist.set(sourceKey, specialistId)
  }

  const voids = []
  const links = []
  const updates = []
  for (const [sourceKey, entry] of existing) {
    const row = accepted.get(sourceKey)
    if (!row) {
      voids.push(Object.freeze({
        entryId: entry.id,
        sourceKey,
        reasonCode: quarantined.has(sourceKey) ? 'quarantined' : 'formula_cache',
      }))
      continue
    }
    const specialistId = targetSpecialist.get(sourceKey)
    const accountingMonthChanged = entry.accountingMonth !== row.accountingMonth
    const specialistChanged = entry.specialistId !== specialistId
    links.push(Object.freeze({ entryId: entry.id, sourceKey }))
    updates.push(Object.freeze({
      entryId: entry.id,
      sourceKey,
      accountingMonth: row.accountingMonth,
      accountingMonthChanged,
      specialistId,
      specialistChanged,
    }))
  }

  const inserts = []
  for (const [sourceKey, row] of accepted) {
    if (!existing.has(sourceKey)) inserts.push(Object.freeze({
      ...row,
      sourceKey,
      specialistId: targetSpecialist.get(sourceKey),
    }))
  }
  const adjustments = updates.filter(({ accountingMonthChanged, specialistChanged }) => (
    accountingMonthChanged || specialistChanged
  )).map((update) => {
    const existingRow = existing.get(update.sourceKey)
    return Object.freeze({
      entryId: update.entryId,
      sourceKey: update.sourceKey,
      before: Object.freeze({
        accountingMonth: existingRow.accountingMonth,
        specialistId: existingRow.specialistId,
      }),
      after: Object.freeze({
        accountingMonth: update.accountingMonth,
        specialistId: update.specialistId,
      }),
    })
  })
  return Object.freeze({
    counts: Object.freeze({
      accepted: accepted.size,
      quarantined: quarantined.size,
      linked: links.length,
      voided: voids.length,
      inserted: inserts.length,
      accountingMonthsCorrected: updates.filter(({ accountingMonthChanged }) => (
        accountingMonthChanged
      )).length,
      specialistAssignmentsCorrected: updates.filter(({ specialistChanged }) => (
        specialistChanged
      )).length,
      fixedRevenuesInserted: inserts.filter((row) => (
        row.recordType === 'income' && row.sheet === 'Stałe koszty'
      )).length,
      formulaGhostsVoided: voids.filter(({ reasonCode }) => reasonCode === 'formula_cache').length,
      quarantinedVoided: voids.filter(({ reasonCode }) => reasonCode === 'quarantined').length,
      textAmountVisitsInserted: inserts.filter((row) => (
        row.recordType === 'income'
        && Array.isArray(row.warningCodes)
        && row.warningCodes.includes('AMOUNT_STORED_AS_TEXT')
      )).length,
    }),
    adjustments: Object.freeze(adjustments),
    inserts: Object.freeze(inserts),
    links: Object.freeze(links),
    updates: Object.freeze(updates),
    voids: Object.freeze(voids),
  })
}
