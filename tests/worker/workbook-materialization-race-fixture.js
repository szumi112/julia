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

export const APPROVED = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
export const NOW_MS = Date.parse('2027-03-01T09:00:00.000Z')
export const NOW = new Date(NOW_MS).toISOString()
export const RACE_NOW = new Date(NOW_MS + 1_000).toISOString()
export const actor = Object.freeze({
  id: 'stf_workbook_race_owner', role: 'owner', specialistId: null, version: 1,
})
export const config = Object.freeze({
  appEnv: 'staging', dataMode: 'fictional',
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
  activeWorkbookKekVersion: 1,
  activeWorkbookHmacVersion: 1,
})

const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const sourceScope = Object.freeze({
  type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
})
const progress = () => JSON.stringify({
  accepted: 0,
  accountingMonthsCorrected: 0,
  candidateCount: 0,
  financeBatchId: 'fib_workbook_race',
  fixedRevenuesInserted: 0,
  formulaGhostsVoided: 0,
  inserted: 0,
  linked: 0,
  quarantined: 0,
  quarantinedVoided: 0,
  specialistAssignmentsCorrected: 0,
  textAmountVisitsInserted: 0,
  voided: 0,
})

export async function setupRaceEnvironment() {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    actor.id, 'workbook_race_owner_lookup', '{}', '{}', 'owner', 'active',
    'workbook-race-owner-subject', null, 1, NOW, null, NOW, NOW,
  ).run()
  const keyring = await createKeyring({
    BWM_DATA_KEK_V1: key(1),
    BWM_LOOKUP_HMAC_V1: key(2),
    BWM_WORKBOOK_KEK_V1: key(9),
    BWM_WORKBOOK_HMAC_V1: key(10),
  }, config)
  const financeKey = await getOrCreateDataKey(env.DB, keyring, FINANCE_SCOPE, {
    id: 'key_workbook_race_finance', createdAt: NOW,
  })
  await env.DB.prepare(`INSERT INTO finance_import_batches
    (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
     created_by_staff_id,version,created_at,updated_at,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fib_workbook_race', 'd'.repeat(64), '{}', 1, 10, 10, 'committed',
    actor.id, 1, NOW, NOW, NOW,
  ).run()
  return { financeKey, keyring }
}

export async function insertFinanceEntry({ financeKey, keyring, id, sourceKey }) {
  const sourceEnvelope = JSON.stringify(await encryptForScope(keyring, financeKey, {
    expectedScope: FINANCE_SCOPE,
    recordId: id,
    field: 'source_row',
    plaintext: JSON.stringify({
      schema: 'finance_entry_source.v1',
      source: {
        batchId: 'fib_workbook_race', sourceKey, sheet: 'Fikcyjny arkusz',
        rowNumber: 2, raw: {},
      },
    }),
  }))
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,
     created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, 'fib_workbook_race', `stored-${sourceKey}`, 'income', 'income', '2027-03',
    '2027-03-01', 18_000, 18_000, 'cash', 'paid', 'not_required', null, null, null,
    '{}', sourceEnvelope, 1, actor.id, NOW, NOW,
  ).run()
}

const insertImportShell = async ({
  keyring, marker, workbookKind, fingerprint, panel, totalRecords = 1,
}) => {
  const importId = `wbi_${marker}`
  const artifactId = `wba_${marker}`
  const sourceKey = await getOrCreateDataKey(env.DB, keyring, sourceScope, {
    id: `key_${marker}_source`, createdAt: NOW,
  })
  const planEnvelope = JSON.stringify(await encryptForScope(keyring, sourceKey, {
    expectedScope: sourceScope,
    recordId: importId,
    field: 'materialization_plan',
    plaintext: JSON.stringify({
      schema: 'workbook_import_plan.v1',
      workbookKind,
      previewPlanDigest: `v1_${'A'.repeat(43)}`,
      panel,
    }),
  }))
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,
       materializer_version,object_key,content_nonce_b64,workbook_kek_version,
       metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      artifactId, 'centre_1', 'staging', fingerprint, 32, 2, 2,
      `workbook-objects/wbo_${marker}_opaque_0000000000000000`,
      'A'.repeat(16), 1, 1, 'B'.repeat(43), actor.id, NOW,
    ),
    env.DB.prepare(`INSERT INTO workbook_templates
      (id,artifact_id,format,source_kind,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?)`).bind(
      `wbt_${marker}`, artifactId, workbookKind,
      workbookKind === 'legacy' ? 'approved_import' : 'panel_round_trip', actor.id, NOW,
    ),
    env.DB.prepare(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      importId, artifactId, marker.padEnd(43, 'C').slice(0, 43), 'ready', 0, 0,
      `corr_${marker}`, actor.id, 1, NOW, NOW, null,
    ),
    env.DB.prepare(`INSERT INTO workbook_import_plans
      (import_id,workbook_kind,plan_version,plan_envelope,created_at)
      VALUES (?,?,?,?,?)`).bind(importId, workbookKind, 1, planEnvelope, NOW),
    env.DB.prepare(`INSERT INTO workbook_materialization_jobs
      (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
       created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      `wbj_${marker}`, importId, 'apply_finance', 'ready', 0, totalRecords, 0,
      progress(), actor.id, 1, NOW, NOW, null,
    ),
  ])
  return { importId, sourceKey }
}

export async function seedLegacyAction({
  keyring, marker, action, financeEntryId, sourceRecordId = null,
}) {
  const result = await insertImportShell({
    keyring,
    marker,
    workbookKind: 'legacy',
    fingerprint: APPROVED,
    panel: { updates: [], voids: [] },
  })
  if (sourceRecordId) {
    await env.DB.prepare(`INSERT INTO workbook_source_records
      (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
       record_type,disposition,accounting_month,occurred_on,period_precision,
       period_month,amount_grosze,payment_method,settlement_status,invoice_status,
       initial_paid_amount_grosze,record_digest,record_digest_hmac_version,
       specialist_source_digest,specialist_source_hmac_version,warning_codes_json,
       source_payload_version,source_payload_envelope,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      sourceRecordId, result.importId, 'workbook:v1:0:2:0', 0, 'Fikcyjny arkusz', 2, 0,
      'income', 'accepted', '2027-03', '2027-03-01', 'day', '2027-03', 18_000,
      'cash', 'paid', 'not_required', 18_000, 'D'.repeat(43), 1, 'E'.repeat(43), 1,
      '[]', 1, '{}', NOW,
    ).run()
  }
  await env.DB.prepare(`INSERT INTO workbook_finance_decisions
    (id,import_id,source_record_id,finance_entry_id,action,reason_code,
     target_accounting_month,target_specialist_id,expected_finance_version,
     accounting_month_changed,specialist_changed,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    `wfd_${marker}`, result.importId, sourceRecordId, financeEntryId, action,
    action === 'void' ? 'formula_cache' : null,
    action === 'link_update' ? '2027-03' : null, null, 1, 0, 0, NOW,
  ).run()
  return result
}

export async function seedPanelVoid({ keyring, marker, financeEntryId }) {
  return insertImportShell({
    keyring,
    marker,
    workbookKind: 'panel-v2',
    fingerprint: 'e'.repeat(64),
    panel: {
      updates: [],
      voids: [{
        expectedVersion: 1, id: financeEntryId, type: 'finance_entry',
      }],
    },
  })
}

export async function seedPanelUpdate({ keyring, marker, financeEntryId, values }) {
  return insertImportShell({
    keyring,
    marker,
    workbookKind: 'panel-v2',
    fingerprint: 'f'.repeat(64),
    panel: {
      updates: [{
        expectedVersion: 1, id: financeEntryId, type: 'finance_entry', values,
      }],
      voids: [],
    },
  })
}

export const racingDb = (beforeBatch) => {
  let raced = false
  return {
    prepare: (...args) => env.DB.prepare(...args),
    batch: async (statements) => {
      if (!raced) {
        raced = true
        await beforeBatch()
      }
      return env.DB.batch(statements)
    },
  }
}

export const continuationFor = ({ db, keyring, importId, marker }) => ({
  db,
  actor,
  keyring,
  config,
  centreId: 'centre_1',
  nowMs: NOW_MS + 2_000,
  correlationId: `corr_continue_${marker}`,
  idFactory: (() => {
    let sequence = 0
    return () => `${marker}_${++sequence}`
  })(),
  importId,
  expectedVersion: 1,
  idempotencyKey: `continue-${marker}`,
})
