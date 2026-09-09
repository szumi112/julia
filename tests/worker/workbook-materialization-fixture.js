import { env } from 'cloudflare:workers'
import { FINANCE_SCOPE } from '../../worker/core/finance.js'
import { encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

export const APPROVED = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
export const NOW_MS = Date.parse('2027-02-10T08:00:00.000Z')
export const NOW = new Date(NOW_MS).toISOString()
export const FINANCE_BATCH = 'fib_workbook_materialization_current'
export const IDENTITY_SCOPE = Object.freeze({
  type: 'staff_directory', id: 'centre_1', purpose: 'identity',
})
export const actor = authorityActor({ id: 'stf_workbook_materialization_owner', role: 'owner' })
export const otherOwner = authorityActor({
  id: 'stf_workbook_materialization_other', role: 'owner',
})
export const config = Object.freeze({
  appEnv: 'staging', dataMode: 'fictional',
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
  activeWorkbookKekVersion: 1,
  activeWorkbookHmacVersion: 1,
})
export const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
export const sourceKey = (index) => `workbook:v1:${Math.floor(index / 1000)}:${index + 2}:0`
export const canonical = Array.from({ length: 2_232 }, (_, index) => {
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
export const quarantined = [{
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
export const parsed = Object.freeze({
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


const sealFinanceWith = (keyring, financeKey) => async (recordId, field, value) => JSON.stringify(await encryptForScope(
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

// Seeds migrations, staff, specialists, keys and the approved finance batch.
// batchShape selects which legacy batch the materializer reconciles against.
export async function seedMaterializationEnvironment({ batchShape = 'legacy' } = {}) {
  if (!['legacy', 'complete'].includes(batchShape)) throw new TypeError('batchShape')
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await insertStaff(actor)
  await insertStaff(otherOwner)
  const keyring = await createKeyring({
    BWM_DATA_KEK_V1: key(1),
    BWM_LOOKUP_HMAC_V1: key(2),
    BWM_WORKBOOK_KEK_V1: key(9),
    BWM_WORKBOOK_HMAC_V1: key(10),
  }, config)
  const identityKey = await getOrCreateDataKey(env.DB, keyring, IDENTITY_SCOPE, {
    id: 'key_workbook_materialization_identity', createdAt: NOW,
  })
  for (const [id, name] of [
    ['sp_staging_workbook_anna_janowska', 'Anna Janowska'],
    ['sp_generated_workbook_julia', 'Julia Wolanin'],
    ['sp_staging_workbook_justyna_j_j', 'Justyna J-J'],
  ]) await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
     archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    id, null, JSON.stringify(await encryptForScope(keyring, identityKey, {
      expectedScope: IDENTITY_SCOPE, recordId: id, field: 'display_name', plaintext: name,
    })), 18_000, 'active', 1, null, NOW, NOW,
  ).run()
  const financeKey = await getOrCreateDataKey(env.DB, keyring, FINANCE_SCOPE, {
    id: 'key_workbook_materialization_finance', createdAt: NOW,
  })
  await env.DB.prepare(`INSERT INTO finance_import_batches
    (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
     created_by_staff_id,version,created_at,updated_at,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    FINANCE_BATCH, APPROVED, '{}', 1, 2_234, 2_234, 'committed', actor.id,
    1, NOW, NOW, NOW,
  ).run()

  // 'legacy': the batch the materializer was calibrated against - it lacks the
  // fixed revenues and text-amount visits and carries five formula-cache ghosts.
  // 'complete': a batch that already stores every accepted row and no ghosts,
  // which is what the staging finance import produced.
  const omitted = batchShape === 'legacy' ? [1_000, 1_001, 2_039, 2_040, 2_041] : []
  const ghosts = batchShape === 'legacy' ? 5 : 0
  const existing = [
    ...canonical.map((row, index) => ({ row, index })).filter(({ index }) => (
      !omitted.includes(index)
    )).map(({ row, index }) => ({
      row,
      id: `fin_materialized_existing_${index}`,
      accountingMonth: index < 45 ? '2026-08' : row.accountingMonth,
    })),
    ...Array.from({ length: ghosts }, (_, index) => ({
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
  const sealFinance = sealFinanceWith(keyring, financeKey)
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
  return { keyring, financeKey }
}
