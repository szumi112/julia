import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseWorkbookFile } from '../src/workbook-import.js'

export const AUTHORITATIVE_WORKBOOK_FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'

export const AUTHORITATIVE_WORKBOOK_RECONCILIATION = Object.freeze({
  monthlyCandidates: 1_999,
  monthlyAccepted: 1_997,
  monthlyQuarantined: 2,
  fixedExpenses: 42,
  fixedRevenues: 3,
  tusRows: 25,
  englishRows: 165,
  acceptedTotal: 2_232,
  quarantinedTotal: 2,
  combinedAugustVisits: 3,
  combinedSeptemberVisits: 40,
  datedTusRows: 2,
  formulaGhostsExcluded: 5,
  amountStoredAsTextWarnings: 2,
})

const fail = (code) => { throw new TypeError(code) }

const normalizedName = (value) => String(value ?? '').trim().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replaceAll('ł', 'l')
  .toLowerCase()

const exactReconciliation = (actual, expected) => {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    fail('WORKBOOK_AUDIT_CONTRACT_INVALID')
  }
  const actualKeys = Object.keys(actual)
  const expectedKeys = Object.keys(expected)
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key) => !Object.hasOwn(expected, key) || actual[key] !== expected[key])) {
    fail('WORKBOOK_AUDIT_RECONCILIATION_MISMATCH')
  }
}

export const workbookAuditSummary = (preview) => {
  const fixed = preview.rows.filter(({ sheet }) => normalizedName(sheet).includes('stale koszty'))
  const monthly = preview.rows.filter(({ recordType, sheet }) => (
    recordType === 'income' && !normalizedName(sheet).includes('stale koszty')
  ))
  const monthlyQuarantine = preview.quarantinedRows.filter(({ recordType, sheet }) => (
    recordType === 'income' && !normalizedName(sheet).includes('stale koszty')
  ))
  const combined = monthly.filter(({ sheet }) => normalizedName(sheet).includes('sierpienwrzesien'))
  const tus = preview.rows.filter(({ recordType }) => recordType === 'tus')
  return Object.freeze({
    monthlyCandidates: monthly.length + monthlyQuarantine.length,
    monthlyAccepted: monthly.length,
    monthlyQuarantined: monthlyQuarantine.length,
    fixedExpenses: fixed.filter(({ recordType }) => recordType === 'expense').length,
    fixedRevenues: fixed.filter(({ recordType }) => recordType === 'income').length,
    tusRows: tus.length,
    englishRows: preview.rows.filter(({ recordType }) => recordType === 'english').length,
    acceptedTotal: preview.rows.length,
    quarantinedTotal: preview.quarantinedRows.length,
    combinedAugustVisits: combined.filter(({ accountingMonth }) => accountingMonth === '2024-08').length,
    combinedSeptemberVisits: combined.filter(({ accountingMonth }) => accountingMonth === '2024-09').length,
    datedTusRows: tus.filter(({ occurredOn }) => occurredOn !== null).length,
    formulaGhostsExcluded: preview.reconciliation.excludedFormulaRows,
    amountStoredAsTextWarnings: preview.warnings.find(({ code }) => (
      code === 'AMOUNT_STORED_AS_TEXT'
    ))?.count ?? 0,
  })
}

export async function auditWorkbook({ sourcePath, expectedFingerprint,
  approvedFingerprint = AUTHORITATIVE_WORKBOOK_FINGERPRINT,
  expected = AUTHORITATIVE_WORKBOOK_RECONCILIATION } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath
    || typeof expectedFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(expectedFingerprint)
    || typeof approvedFingerprint !== 'string'
    || expectedFingerprint !== approvedFingerprint) {
    fail('WORKBOOK_AUDIT_FINGERPRINT_REFUSED')
  }
  const bytes = await readFile(sourcePath)
  const preview = await parseWorkbookFile(bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ), { filename: basename(sourcePath) })
  if (preview.fingerprint !== expectedFingerprint) fail('WORKBOOK_AUDIT_FINGERPRINT_MISMATCH')
  const reconciliation = workbookAuditSummary(preview)
  exactReconciliation(reconciliation, expected)
  return Object.freeze({
    fingerprint: preview.fingerprint,
    parserVersion: preview.parserVersion,
    materializerVersion: preview.materializerVersion,
    reconciliation,
  })
}
