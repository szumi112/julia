import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  continueWorkbookImport,
  createWorkbookImport,
  previewWorkbook,
} from '../../worker/core/workbooks.js'
import { FINANCE_SCOPE } from '../../worker/core/finance.js'
import { listFinanceEntries } from '../../worker/core/finance.js'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
import {
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const APPROVED = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const NOW_MS = Date.parse('2027-02-10T08:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const FINANCE_BATCH = 'fib_workbook_materialization_current'
const actor = Object.freeze({
  id: 'stf_workbook_materialization_owner', role: 'owner', specialistId: null, version: 1,
})
const otherOwner = Object.freeze({
  id: 'stf_workbook_materialization_other', role: 'owner', specialistId: null, version: 1,
})
const config = Object.freeze({
  appEnv: 'staging', dataMode: 'fictional',
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
  activeWorkbookKekVersion: 1,
  activeWorkbookHmacVersion: 1,
})
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const sourceKey = (index) => `workbook:v1:${Math.floor(index / 1000)}:${index + 2}:0`
const canonical = Array.from({ length: 2_232 }, (_, index) => {
  const recordType = index >= 2_042 && index < 2_067
    ? 'tus'
    : index >= 2_067 ? 'english' : index >= 1_997 && index < 2_039 ? 'expense' : 'income'
  const monthOnly = recordType === 'english' || recordType === 'expense'
    || (recordType === 'tus' && index >= 2_044)
  return {
    sourceKey: sourceKey(index),
    sheet: 'Styczeń 2025',
    rowNumber: index + 2,
    recordType,
    accountingMonth: index < 45 ? (index < 3 ? '2024-08' : '2024-09') : '2025-01',
    occurredOn: monthOnly ? null : '2025-01-15',
    periodPrecision: monthOnly ? 'month' : 'day',
    periodMonth: '2025-01',
    amountGrosze: index >= 2_067 ? 34_000 : 18_000,
    counterparty: `Fikcyjna osoba ${index + 1}`,
    sourceLabel: `Fikcyjna usługa ${index + 1}`,
    paymentMethod: 'cash',
    settlementStatus: 'paid',
    invoiceStatus: 'not_required',
    invoiceNote: '',
    specialistName: index === 100 ? 'Anna Janowska' : index === 101 ? 'Justyna J-J' : null,
    lessonCount: index >= 2_067 ? 1 : null,
    warningCodes: [],
    raw: { Cena: index >= 2_067 ? 340 : 180 },
  }
})
Object.assign(canonical[2_039], {
  recordType: 'income', sheet: 'Stałe koszty', sourceLabel: 'TUS (5-6 lat)',
  occurredOn: null, periodPrecision: 'month', periodMonth: '2025-01',
})
Object.assign(canonical[2_040], {
  recordType: 'income', sheet: 'Stałe koszty', sourceLabel: 'TUS (7-9 lat)',
  occurredOn: null, periodPrecision: 'month', periodMonth: '2025-01',
})
Object.assign(canonical[2_041], {
  recordType: 'income', sheet: 'Stałe koszty', sourceLabel: 'TUS (10-12 lat)',
  occurredOn: null, periodPrecision: 'month', periodMonth: '2025-01',
})
Object.assign(canonical[1_000], {
  sourceLabel: 'Konsultacja tekstowa pierwsza', warningCodes: ['AMOUNT_STORED_AS_TEXT'],
})
Object.assign(canonical[1_001], {
  sourceLabel: 'Konsultacja tekstowa druga', warningCodes: ['AMOUNT_STORED_AS_TEXT'],
})
const quarantined = [{
  sourceKey: 'workbook:v1:90:10:0', sheet: 'Wrzesień 2025', rowNumber: 10,
  recordType: 'income', accountingMonth: '2025-09', occurredOn: null,
  periodPrecision: 'unknown', periodMonth: null,
  amountGrosze: 18_000, reasonCode: 'SERVICE_DATE_MISSING',
  reasonCodes: ['SERVICE_DATE_MISSING'], raw: { Cena: 180 },
}, {
  sourceKey: 'workbook:v1:90:11:0', sheet: 'Wrzesień 2025', rowNumber: 11,
  recordType: 'income', accountingMonth: '2025-09', occurredOn: null,
  periodPrecision: 'unknown', periodMonth: null,
  amountGrosze: 18_000, reasonCode: 'SERVICE_DATE_INVALID',
  reasonCodes: ['SERVICE_DATE_INVALID'], raw: { Cena: 180 },
}, {
  sourceKey: 'workbook:v1:91:10:0', sheet: 'Stałe koszty', rowNumber: 10,
  recordType: 'expense', accountingMonth: null, occurredOn: null,
  periodPrecision: 'unknown', periodMonth: null,
  amountGrosze: 12_000, reasonCode: 'ORPHAN_AMOUNT',
  reasonCodes: ['ORPHAN_AMOUNT'], raw: { Kwota: 120 },
}]
const parsed = Object.freeze({
  formatVersion: 1,
  parserVersion: 2,
  materializerVersion: 2,
  fingerprint: APPROVED,
  filename: 'approved-fictional.xlsx',
  counts: Object.freeze({
    englishRows: 165, financeRows: 2_022, fixedRows: 45, tusRows: 25,
  }),
  warnings: Object.freeze([{ code: 'AMOUNT_STORED_AS_TEXT', count: 2 }]),
  rows: Object.freeze(canonical),
  quarantinedRows: Object.freeze(quarantined),
  reconciliation: Object.freeze({
    sourceCandidates: 2_235,
    acceptedRows: 2_232,
    quarantinedRows: 3,
    excludedFormulaBlocks: 5,
    excludedFormulaRows: 5,
  }),
})

let keyring
let financeKey
let sequence = 0
const idFactory = () => `materialization_${++sequence}`
const sealFinance = async (recordId, field, value) => JSON.stringify(await encryptForScope(
  keyring,
  financeKey,
  { expectedScope: FINANCE_SCOPE, recordId, field, plaintext: JSON.stringify(value) },
))

const insertStaff = (staff) => env.DB.prepare(`INSERT INTO staff_users
  (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
   specialist_id,version,activated_at,disabled_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
  staff.id, `${staff.id}_lookup`, '{}', '{}', 'owner', 'active', `${staff.id}_subject`,
  null, 1, NOW, null, NOW, NOW,
).run()

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await insertStaff(actor)
  await insertStaff(otherOwner)
  for (const [id, name] of [
    ['sp_staging_workbook_anna_janowska', 'Anna'],
    ['sp_staging_workbook_julia_wolanin', 'Julia'],
    ['sp_staging_workbook_justyna_j_j', 'Justyna'],
  ]) await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
     archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    id, null, JSON.stringify({ name }), 18_000, 'active', 1, null, NOW, NOW,
  ).run()
  keyring = await createKeyring({
    BWM_DATA_KEK_V1: key(1),
    BWM_LOOKUP_HMAC_V1: key(2),
    BWM_WORKBOOK_KEK_V1: key(9),
    BWM_WORKBOOK_HMAC_V1: key(10),
  }, config)
  financeKey = await getOrCreateDataKey(env.DB, keyring, FINANCE_SCOPE, {
    id: 'key_workbook_materialization_finance', createdAt: NOW,
  })
  await env.DB.prepare(`INSERT INTO finance_import_batches
    (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
     created_by_staff_id,version,created_at,updated_at,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    FINANCE_BATCH, APPROVED, '{}', 1, 2_234, 2_234, 'committed', actor.id,
    1, NOW, NOW, NOW,
  ).run()

  const existing = [
    ...canonical.map((row, index) => ({ row, index })).filter(({ index }) => ![
      1_000, 1_001, 2_039, 2_040, 2_041,
    ].includes(index)).map(({ row, index }) => ({
      row,
      id: `fin_materialized_existing_${index}`,
      accountingMonth: index < 45 ? '2026-08' : row.accountingMonth,
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      row: {
        ...canonical[index],
        sourceKey: `workbook:v1:99:${index + 2}:0`,
        sourceLabel: `Cache formuły ${index + 1}`,
      },
      id: `fin_materialized_formula_${index}`,
      accountingMonth: '2025-09',
    })),
    ...quarantined.slice(0, 2).map((row, index) => ({
      row: {
        ...row,
        occurredOn: '2025-09-01',
        counterparty: `Fikcyjna kwarantanna ${index + 1}`,
        sourceLabel: `Błędny wpis ${index + 1}`,
        paymentMethod: 'cash', settlementStatus: 'paid', invoiceStatus: 'not_required',
        invoiceNote: '', specialistName: null, lessonCount: null,
      },
      id: `fin_materialized_quarantine_${index}`,
      accountingMonth: '2025-09',
    })),
  ]
  const stored = []
  for (const { row, id, accountingMonth } of existing) {
    stored.push({
      id,
      sourceKey: `legacy-safe-${id}`,
      kind: row.recordType === 'expense' ? 'expense' : 'income',
      recordType: row.recordType,
      accountingMonth,
      occurredOn: row.occurredOn,
      amountGrosze: row.amountGrosze,
      paidAmountGrosze: row.amountGrosze,
      paymentMethod: row.paymentMethod ?? 'cash',
      settlementStatus: 'paid',
      invoiceStatus: row.invoiceStatus ?? 'not_required',
      detailsEnvelope: await sealFinance(id, 'details', {
        schema: 'finance_entry_details.v1',
        counterparty: row.counterparty ?? '',
        sourceLabel: row.sourceLabel,
        invoiceNote: row.invoiceNote ?? '',
        lessonCount: row.lessonCount ?? null,
      }),
      sourceEnvelope: await sealFinance(id, 'source_row', {
        schema: 'finance_entry_source.v1',
        source: {
          batchId: FINANCE_BATCH,
          sourceKey: row.sourceKey,
          sheet: row.sheet,
          rowNumber: row.rowNumber,
          raw: row.raw,
        },
      }),
    })
  }
  for (let offset = 0; offset < stored.length; offset += 250) {
    await env.DB.prepare(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,
       created_at,updated_at)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.sourceKey'),
             json_extract(value,'$.kind'),json_extract(value,'$.recordType'),
             json_extract(value,'$.accountingMonth'),json_extract(value,'$.occurredOn'),
             json_extract(value,'$.amountGrosze'),json_extract(value,'$.paidAmountGrosze'),
             json_extract(value,'$.paymentMethod'),json_extract(value,'$.settlementStatus'),
             json_extract(value,'$.invoiceStatus'),NULL,NULL,NULL,
             json_extract(value,'$.detailsEnvelope'),json_extract(value,'$.sourceEnvelope'),
             1,?,?,?
      FROM json_each(?)`).bind(
      FINANCE_BATCH, actor.id, NOW, NOW, JSON.stringify(stored.slice(offset, offset + 250)),
    ).run()
  }
})

describe('approved workbook materialization', () => {
  it('atomically preserves 2,232 accepted/3 quarantine while reconciling exact finance facts once', async () => {
    expect(Object.fromEntries(['english', 'expense', 'income', 'tus'].map((type) => [
      type, canonical.filter(({ recordType }) => recordType === type).length,
    ]))).toEqual({ english: 165, expense: 42, income: 2_000, tus: 25 })
    const bytes = new TextEncoder().encode('approved-fictional-workbook-materialization')
    const preview = await previewWorkbook({
      bytes, filename: 'approved-fictional.xlsx', actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS, parse: async () => parsed,
      readPanel: async () => ({ edits: [], kind: 'legacy', metadata: null, voidIds: [] }),
      nonceFactory: () => new Uint8Array(16).fill(7),
    })
    const importBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    const imported = await createWorkbookImport({
      db: importBudget.work, bucket: env.ARCHIVE, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 1_000, correlationId: 'corr_workbook_materialization_import',
      idFactory, bytes, filename: 'approved-fictional.xlsx',
      previewToken: preview.data.previewToken,
      idempotencyKey: 'workbook-materialization-import',
      parse: async () => parsed,
      readPanel: async () => ({ edits: [], kind: 'legacy', metadata: null, voidIds: [] }),
      storeArtifact: async ({ objectKey }) => ({
        environment: 'staging', centreId: 'centre_1', objectKey,
        fingerprint: APPROVED, byteSize: bytes.byteLength,
        parserVersion: 2, materializerVersion: 2,
        contentNonce: 'A'.repeat(16), workbookKekVersion: 1,
        metadataHmacVersion: 1, metadataSignature: 'B'.repeat(43),
      }),
    })
    expect(importBudget.usage().used).toBeLessThanOrEqual(42)
    await expect(continueWorkbookImport({
      db: env.DB, actor: otherOwner, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 2_000, correlationId: 'corr_workbook_materialization_other',
      idFactory, importId: imported.body.data.import.id,
      expectedVersion: 1, idempotencyKey: 'workbook-materialization-other',
    })).rejects.toThrow(/^NOT_FOUND$/)

    const continuation = {
      db: env.DB, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 2_000, correlationId: 'corr_workbook_materialization_continue',
      idFactory, importId: imported.body.data.import.id,
      expectedVersion: 1, idempotencyKey: 'workbook-materialization-continue',
    }
    let maximumRequestQueries = 0
    const continueWithinBudget = async (input) => {
      const budget = createD1QueryBudget(env.DB, {
        totalLimit: 50, recoveryReserve: 8,
      })
      const result = await continueWorkbookImport({ ...input, db: budget.work })
      maximumRequestQueries = Math.max(maximumRequestQueries, budget.usage().used)
      return result
    }
    const [firstLeft, firstRight] = await Promise.all([
      continueWithinBudget(continuation),
      continueWithinBudget(continuation),
    ])
    expect(firstLeft.body).toEqual(firstRight.body)
    expect(firstLeft.body.data.import).toMatchObject({ status: 'materializing', version: 2 })
    expect(firstLeft.body.data.job).toMatchObject({
      phase: 'index_finance', status: 'running', cursor: 64, totalRecords: 2_234,
    })
    const interrupted = await env.DB.prepare(`SELECT job.phase,job.cursor,job.version,
        import.status AS import_status
      FROM workbook_materialization_jobs AS job
      JOIN workbook_imports AS import ON import.id=job.import_id
      WHERE job.import_id=?`).bind(imported.body.data.import.id).first()
    expect(interrupted).toEqual({
      phase: 'index_finance', cursor: 64, version: 2, import_status: 'materializing',
    })

    let left = firstLeft
    const observedPhases = [left.body.data.job.phase]
    for (let step = 1; left.body.data.import.status !== 'complete' && step < 180; step += 1) {
      const previous = left.body.data.job
      left = await continueWithinBudget({
        ...continuation,
        expectedVersion: left.body.data.import.version,
        idempotencyKey: `workbook-materialization-step-${step}`,
        correlationId: `corr_workbook_materialization_step_${step}`,
      })
      const current = left.body.data.job
      if (current.phase === previous.phase) {
        expect(current.cursor - previous.cursor).toBeGreaterThan(0)
        expect(current.cursor - previous.cursor).toBeLessThanOrEqual(64)
      } else {
        observedPhases.push(current.phase)
        if (current.phase !== 'complete') expect(current.cursor).toBeLessThanOrEqual(64)
      }
    }
    expect(observedPhases).toEqual([
      'index_finance', 'reconcile_sources', 'reconcile_unmatched', 'apply_finance', 'complete',
    ])
    expect(left.body.data.import.status).toBe('complete')
    expect(left.body.data.reconciliation).toEqual({
      accepted: 2_232,
      quarantined: 3,
      linked: 2_232,
      voided: 7,
      inserted: 5,
      accountingMonthsCorrected: 45,
      specialistAssignmentsCorrected: 2_227,
      fixedRevenuesInserted: 3,
      formulaGhostsVoided: 5,
      quarantinedVoided: 2,
      textAmountVisitsInserted: 2,
    })
    expect(left.body.data.import).toMatchObject({ status: 'complete', version: 3 })
    expect(maximumRequestQueries).toBeGreaterThan(0)
    expect(maximumRequestQueries).toBeLessThanOrEqual(42)

    const active = await env.DB.prepare(`SELECT count(*) AS count
      FROM finance_entries AS entry
      LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
      WHERE entry.batch_id=? AND void.id IS NULL`).bind(FINANCE_BATCH).first()
    expect(active.count).toBe(2_232)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM finance_entry_voids',
    ).first()).count).toBe(7)
    expect((await env.DB.prepare(`SELECT reason_code,count(*) AS count
      FROM finance_entry_voids GROUP BY reason_code ORDER BY reason_code`).all()).results)
      .toEqual([
        { reason_code: 'formula_cache', count: 5 },
        { reason_code: 'quarantined', count: 2 },
      ])
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM finance_source_links',
    ).first()).count).toBe(2_232)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM finance_adjustments',
    ).first()).count).toBe(2_227)
    const september = await listFinanceEntries({
      db: env.DB, actor, keyring, nowMs: NOW_MS + 4_000, month: '2025-09', kind: null,
    })
    expect(september.data.entries).toEqual([])
    expect(september.data.summary.entryCount).toBe(0)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM finance_entries
      WHERE batch_id=? AND version=2`).bind(FINANCE_BATCH).first()).count).toBe(2_227)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM finance_entries
      WHERE batch_id=? AND version=1 AND id LIKE 'fin_materialization_%'`).bind(
      FINANCE_BATCH,
    ).first()).count).toBe(5)
    expect((await env.DB.prepare(`SELECT count(*) AS count
      FROM finance_entries AS entry
      JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
      WHERE entry.batch_id=? AND entry.version=1`).bind(FINANCE_BATCH).first()).count).toBe(7)

    const sourceFacts = (await env.DB.prepare(`SELECT source.sheet_name,source.record_type,
        source.warning_codes_json
      FROM finance_source_links AS link
      JOIN workbook_source_records AS source ON source.id=link.source_record_id
      JOIN finance_entries AS entry ON entry.id=link.finance_entry_id
      WHERE entry.id LIKE 'fin_materialization_%'
        AND (source.sheet_name='Stałe koszty' OR source.warning_codes_json!='[]')
      ORDER BY source.source_key`).all()).results
    expect(sourceFacts.filter(({ sheet_name: sheet }) => sheet === 'Stałe koszty')).toHaveLength(3)
    expect(sourceFacts.filter(({ warning_codes_json: warnings }) => (
      warnings === '["AMOUNT_STORED_AS_TEXT"]'
    ))).toHaveLength(2)
    expect((await env.DB.prepare(`SELECT disposition,record_type,period_precision,
        count(*) AS count
      FROM workbook_source_records WHERE import_id=?
      GROUP BY disposition,record_type,period_precision
      ORDER BY disposition,record_type,period_precision`).bind(
      imported.body.data.import.id,
    ).all()).results).toEqual([
      { disposition: 'accepted', record_type: 'english', period_precision: 'month', count: 165 },
      { disposition: 'accepted', record_type: 'expense', period_precision: 'month', count: 42 },
      { disposition: 'accepted', record_type: 'income', period_precision: 'day', count: 1_997 },
      { disposition: 'accepted', record_type: 'income', period_precision: 'month', count: 3 },
      { disposition: 'accepted', record_type: 'tus', period_precision: 'day', count: 2 },
      { disposition: 'accepted', record_type: 'tus', period_precision: 'month', count: 23 },
      { disposition: 'quarantined', record_type: 'expense', period_precision: 'unknown', count: 1 },
      { disposition: 'quarantined', record_type: 'income', period_precision: 'unknown', count: 2 },
    ])

    const adjusted = await env.DB.prepare(`SELECT adjustment.id,adjustment.reason_envelope,
        adjustment.before_envelope,adjustment.after_envelope
      FROM finance_adjustments AS adjustment
      JOIN finance_entries AS entry ON entry.id=adjustment.finance_entry_id
      WHERE entry.accounting_month='2024-08' ORDER BY adjustment.id LIMIT 1`).first()
    const reason = JSON.parse(await decryptForScope(keyring, financeKey, {
      expectedScope: FINANCE_SCOPE, recordId: adjusted.id, field: 'reason',
      envelope: JSON.parse(adjusted.reason_envelope),
    }))
    const before = JSON.parse(await decryptForScope(keyring, financeKey, {
      expectedScope: FINANCE_SCOPE, recordId: adjusted.id, field: 'before',
      envelope: JSON.parse(adjusted.before_envelope),
    }))
    const after = JSON.parse(await decryptForScope(keyring, financeKey, {
      expectedScope: FINANCE_SCOPE, recordId: adjusted.id, field: 'after',
      envelope: JSON.parse(adjusted.after_envelope),
    }))
    expect(reason).toEqual({ code: 'workbook_reconciliation', importId: imported.body.data.import.id })
    expect(before.accountingMonth).toBe('2026-08')
    expect(after.accountingMonth).toBe('2024-08')

    const beforeReplayCounts = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM finance_adjustments) AS adjustments,
      (SELECT count(*) FROM finance_entry_voids) AS voids,
      (SELECT count(*) FROM finance_source_links) AS links`).first()
    const replay = await continueWithinBudget(continuation)
    expect(replay.body).toEqual(left.body)
    expect(await env.DB.prepare(`SELECT
      (SELECT count(*) FROM finance_adjustments) AS adjustments,
      (SELECT count(*) FROM finance_entry_voids) AS voids,
      (SELECT count(*) FROM finance_source_links) AS links`).first()).toEqual(beforeReplayCounts)
  }, 30_000)
})
