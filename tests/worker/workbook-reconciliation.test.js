import { describe, expect, it } from 'vitest'
import { planWorkbookFinanceReconciliation } from '../../worker/core/workbook-reconciliation.js'

const sourceKey = (index) => `workbook:v1:${Math.floor(index / 1000)}:${index + 2}:0`
const canonical = Array.from({ length: 2_232 }, (_, index) => ({
  sourceKey: sourceKey(index),
  recordType: index >= 2_042 && index < 2_067
    ? 'tus'
    : index >= 2_067 ? 'english' : index >= 1_997 && index < 2_039 ? 'expense' : 'income',
  accountingMonth: index < 45 ? (index < 3 ? '2024-08' : '2024-09') : '2025-01',
  specialistName: index === 100 ? 'Anna Janowska' : index === 101 ? 'Justyna J-J' : null,
  sheet: 'Styczeń 2025',
  sourceLabel: `Fikcyjna usługa ${index + 1}`,
  warningCodes: [],
}))
Object.assign(canonical[2_039], {
  recordType: 'income', sheet: 'Stałe koszty', sourceLabel: 'TUS (5-6 lat)',
})
Object.assign(canonical[2_040], {
  recordType: 'income', sheet: 'Stałe koszty', sourceLabel: 'TUS (7-9 lat)',
})
Object.assign(canonical[2_041], {
  recordType: 'income', sheet: 'Stałe koszty', sourceLabel: 'TUS (10-12 lat)',
})
Object.assign(canonical[1_000], {
  recordType: 'income', sourceLabel: 'Konsultacja tekstowa pierwsza',
  warningCodes: ['AMOUNT_STORED_AS_TEXT'],
})
Object.assign(canonical[1_001], {
  recordType: 'income', sourceLabel: 'Konsultacja tekstowa druga',
  warningCodes: ['AMOUNT_STORED_AS_TEXT'],
})
const quarantined = [
  { sourceKey: 'workbook:v1:8:10:0', reasonCode: 'SERVICE_DATE_MISSING' },
  { sourceKey: 'workbook:v1:8:11:0', reasonCode: 'SERVICE_DATE_INVALID' },
  { sourceKey: 'workbook:v1:9:10:0', reasonCode: 'ORPHAN_AMOUNT' },
]
const missingKeys = new Set([
  canonical[1_000].sourceKey,
  canonical[1_001].sourceKey,
  canonical[2_039].sourceKey,
  canonical[2_040].sourceKey,
  canonical[2_041].sourceKey,
])
const existing = [
  ...canonical.filter((row) => !missingKeys.has(row.sourceKey)).map((row) => ({
    id: `fin_existing_${row.rowNumber ?? row.sourceKey.replaceAll(':', '_')}`,
    sourceKey: row.sourceKey,
    accountingMonth: Number(row.sourceKey.split(':')[3]) - 2 < 45
      ? '2026-08' : row.accountingMonth,
    specialistId: null,
  })),
  ...Array.from({ length: 5 }, (_, index) => ({
    id: `fin_noncanonical_${index}`,
    sourceKey: `workbook:v1:99:${index + 2}:0`,
    accountingMonth: '2025-09',
    specialistId: null,
  })),
  ...quarantined.slice(0, 2).map((row, index) => ({
    id: `fin_noncanonical_${index + 5}`,
    sourceKey: row.sourceKey,
    accountingMonth: '2025-09',
    specialistId: null,
  })),
]

describe('approved workbook finance reconciliation', () => {
  it('conservatively derives the audited 7 voids, 5 inserts, 45 month fixes and specialist assignments', () => {
    const plan = planWorkbookFinanceReconciliation({
      acceptedRows: canonical,
      quarantinedRows: quarantined,
      existingEntries: existing,
      specialistMappings: {
        '': 'sp_julia',
        'Anna Janowska': 'sp_anna',
        'Justyna J-J': 'sp_justyna',
      },
    })

    expect(plan.counts).toEqual({
      accepted: 2_232,
      quarantined: 3,
      linked: 2_227,
      voided: 7,
      inserted: 5,
      accountingMonthsCorrected: 45,
      specialistAssignmentsCorrected: 2_227,
      fixedRevenuesInserted: 3,
      formulaGhostsVoided: 5,
      quarantinedVoided: 2,
      textAmountVisitsInserted: 2,
    })
    expect(plan.voids.map(({ entryId }) => entryId)).toEqual([
      'fin_noncanonical_0', 'fin_noncanonical_1', 'fin_noncanonical_2',
      'fin_noncanonical_3', 'fin_noncanonical_4', 'fin_noncanonical_5',
      'fin_noncanonical_6',
    ])
    expect(plan.inserts.map(({ sourceKey: key }) => key)).toEqual([
      canonical[1_000].sourceKey,
      canonical[1_001].sourceKey,
      canonical[2_039].sourceKey,
      canonical[2_040].sourceKey,
      canonical[2_041].sourceKey,
    ])
    expect(plan.inserts.map(({ recordType, sheet, sourceLabel, warningCodes }) => ({
      recordType, sheet, sourceLabel, warningCodes,
    }))).toEqual([
      { recordType: 'income', sheet: 'Styczeń 2025', sourceLabel: 'Konsultacja tekstowa pierwsza', warningCodes: ['AMOUNT_STORED_AS_TEXT'] },
      { recordType: 'income', sheet: 'Styczeń 2025', sourceLabel: 'Konsultacja tekstowa druga', warningCodes: ['AMOUNT_STORED_AS_TEXT'] },
      { recordType: 'income', sheet: 'Stałe koszty', sourceLabel: 'TUS (5-6 lat)', warningCodes: [] },
      { recordType: 'income', sheet: 'Stałe koszty', sourceLabel: 'TUS (7-9 lat)', warningCodes: [] },
      { recordType: 'income', sheet: 'Stałe koszty', sourceLabel: 'TUS (10-12 lat)', warningCodes: [] },
    ])
    expect(plan.voids.map(({ reasonCode }) => reasonCode)).toEqual([
      'formula_cache', 'formula_cache', 'formula_cache', 'formula_cache',
      'formula_cache', 'quarantined', 'quarantined',
    ])
    expect(plan.updates.filter(({ accountingMonthChanged }) => accountingMonthChanged))
      .toHaveLength(45)
    expect(plan.links).toHaveLength(2_227)
    expect(plan.adjustments.filter(({ before, after }) => (
      before.accountingMonth !== after.accountingMonth
    ))).toHaveLength(45)
    expect(plan.updates.find(({ sourceKey: key }) => key === sourceKey(100)).specialistId)
      .toBe('sp_anna')
    expect(plan.updates.find(({ sourceKey: key }) => key === sourceKey(101)).specialistId)
      .toBe('sp_justyna')
    expect(plan.updates.find(({ sourceKey: key }) => key === sourceKey(2_050)).specialistId)
      .toBe('sp_julia')
  })

  it('fails closed on duplicate coordinates, quarantine overlap or unresolved source specialist values', () => {
    const base = {
      acceptedRows: canonical.slice(0, 2),
      quarantinedRows: [],
      existingEntries: existing.slice(0, 2),
      specialistMappings: { '': 'sp_julia' },
    }
    expect(() => planWorkbookFinanceReconciliation({
      ...base, acceptedRows: [canonical[0], canonical[0]],
    })).toThrow(/^WORKBOOK_RECONCILIATION_INVALID$/)
    expect(() => planWorkbookFinanceReconciliation({
      ...base, quarantinedRows: [{ sourceKey: canonical[0].sourceKey }],
    })).toThrow(/^WORKBOOK_RECONCILIATION_INVALID$/)
    expect(() => planWorkbookFinanceReconciliation({
      ...base,
      acceptedRows: [{ ...canonical[0], specialistName: 'Unmapped Specialist' }],
    })).toThrow(/^WORKBOOK_RECONCILIATION_CONFLICT$/)
  })
})
