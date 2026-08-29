import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import { loadFinanceWindow as loadFinanceWindowCore } from '../../worker/core/finance-reporting.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2027-06-15T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const OWNER = authorityActor({ id: 'stf_finance_window_owner', role: 'owner' })
const COORDINATOR = authorityActor({ id: 'stf_finance_window_coordinator', role: 'coordinator' })
const SPECIALIST = authorityActor({
  id: 'stf_finance_window_specialist', role: 'specialist',
  specialistId: 'sp_finance_window',
})
const run = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).run()
const IDENTITY_SCOPE = Object.freeze({
  type: 'staff_directory', id: 'centre_1', purpose: 'identity',
})
let keyring
const loadFinanceWindow = (input) => loadFinanceWindowCore({ ...input, keyring })

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  keyring = await createKeyring(env, {
    activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
  })
  const identityKey = await getOrCreateDataKey(env.DB, keyring, IDENTITY_SCOPE, {
    id: 'key_finance_window_identity', createdAt: NOW,
  })
  const specialistNameEnvelope = JSON.stringify(await encryptForScope(
    keyring, identityKey, {
      expectedScope: IDENTITY_SCOPE, recordId: SPECIALIST.specialistId,
      field: 'display_name', plaintext: 'Anna Finansowa',
    },
  ))
  await run(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  OWNER.id, 'finance_window_owner_lookup', '{}', '{}', 'owner', 'active',
  'finance-window-owner-subject', null, 1, NOW, null, NOW, NOW)
  await run(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  COORDINATOR.id, 'finance_window_coordinator_lookup', '{}', '{}', 'coordinator', 'active',
  'finance-window-coordinator-subject', null, 1, NOW, null, NOW, NOW)
  await run(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  SPECIALIST.id, 'finance_window_specialist_lookup', '{}', '{}', 'specialist', 'active',
  'finance-window-specialist-subject', SPECIALIST.specialistId, 1, NOW, null, NOW, NOW)
  await run(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,professional_title_envelope,
     standard_rate_grosze,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
  SPECIALIST.specialistId, SPECIALIST.id, specialistNameEnvelope, '{}',
  18_000, 'active', 1, null, NOW, NOW)
  await run(`INSERT INTO clients
    (id,identity_envelope,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`,
  'cl_finance_window', '{}', 'active', 1, null, NOW, NOW)
  await run(`INSERT INTO appointments
    (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
     status,source,version,cancelled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'apt_finance_window', 'cl_finance_window', SPECIALIST.specialistId, 'zajecia',
  '2027-06-03T08:00:00.000Z', '2027-06-03T08:50:00.000Z', 'Europe/Warsaw',
  null, 'completed', 'panel', 1, null, NOW, NOW)
  await run(`INSERT INTO session_charges
    (id,appointment_id,service_id,expected_amount_grosze,currency,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`,
  'chg_finance_window', 'apt_finance_window', 'zajecia', 18_000, 'PLN', 1, NOW, NOW)
  await run(`INSERT INTO appointments
    (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
     status,source,version,cancelled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'apt_finance_window_may', 'cl_finance_window', SPECIALIST.specialistId, 'zajecia',
  '2027-05-03T08:00:00.000Z', '2027-05-03T08:50:00.000Z', 'Europe/Warsaw',
  null, 'completed', 'panel', 1, null, NOW, NOW)
  await run(`INSERT INTO session_charges
    (id,appointment_id,service_id,expected_amount_grosze,currency,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`,
  'chg_finance_window_may', 'apt_finance_window_may', 'zajecia', 18_000,
  'PLN', 1, NOW, NOW)
  await run(`INSERT INTO payment_entries
    (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
     external_reference_envelope,created_at) VALUES (?,?,?,?,?,?,?,?)`,
  'pay_finance_window_old', 'apt_finance_window', 7_000, 'card', NOW,
  OWNER.id, null, NOW)
  await run(`INSERT INTO payment_entries
    (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
     external_reference_envelope,created_at) VALUES (?,?,?,?,?,?,?,?)`,
  'pay_finance_window_cash', 'apt_finance_window', 5_000, 'cash', NOW,
  OWNER.id, null, NOW)
  await run(`INSERT INTO payment_corrections
    (id,reversed_entry_id,replacement_entry_id,reason_envelope,recorded_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?)`,
  'cor_finance_window', 'pay_finance_window_old', 'pay_finance_window_cash', '{}',
  OWNER.id, NOW)
  await run(`INSERT INTO payment_entries
    (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
     external_reference_envelope,created_at) VALUES (?,?,?,?,?,?,?,?)`,
  'pay_finance_window_transfer', 'apt_finance_window', 7_000, 'transfer', NOW,
  OWNER.id, null, NOW)
})

describe('server-owned FinanceWindow', () => {
  it('does not expose a pre-floor row as the latest populated month', async () => {
    await run(`INSERT INTO appointments
      (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
       status,source,version,cancelled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'apt_finance_window_prefloor', 'cl_finance_window', SPECIALIST.specialistId, 'zajecia',
    '2000-05-03T08:00:00.000Z', '2000-05-03T08:50:00.000Z', 'Europe/Warsaw',
    null, 'completed', 'panel', 1, null, NOW, NOW)
    await run(`INSERT INTO session_charges
      (id,appointment_id,service_id,expected_amount_grosze,currency,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`,
    'chg_finance_window_prefloor', 'apt_finance_window_prefloor', 'zajecia',
    18_000, 'PLN', 1, NOW, NOW)

    const result = await loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: Date.parse('2000-06-15T10:00:00.000Z'),
      selectedMonth: '2000-06',
    })
    expect(result.data.rows).toEqual([])
    expect(result.data.latestPopulatedMonth).toBeNull()
  })

  it('allows the coordinator centre-read branch and reports an older latest month for an empty current month', async () => {
    const julyMs = Date.parse('2027-07-15T10:00:00.000Z')
    const result = await loadFinanceWindow({
      db: env.DB, actor: COORDINATOR, nowMs: julyMs, selectedMonth: '2027-07',
    })
    expect(result.data.currentMonth).toBe('2027-07')
    expect(result.data.selectedMonth).toBe('2027-07')
    expect(result.data.rows).toEqual([])
    expect(result.data.latestPopulatedMonth).toBe('2027-06')
  })

  it('returns an exact six-month complete DTO using effective payment events', async () => {
    const result = await loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-06',
    })

    expect(Object.keys(result.data)).toEqual([
      'currentMonth', 'selectedMonth', 'fromMonth', 'toMonth', 'months',
      'latestPopulatedMonth', 'kpis', 'trend', 'splits', 'specialistLabels', 'rows', 'coverage',
      'unknownPeriodCount', 'complete',
    ])
    expect(result.data.specialistLabels).toEqual([{
      id: SPECIALIST.specialistId, label: 'Anna Finansowa',
    }])
    expect(result.data.currentMonth).toBe('2027-06')
    expect(result.data.fromMonth).toBe('2027-01')
    expect(result.data.toMonth).toBe('2027-06')
    expect(result.data.months).toEqual([
      '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06',
    ])
    expect(result.data.kpis).toEqual({
      revenueGrosze: 18_000,
      collectedGrosze: 12_000,
      outstandingGrosze: 6_000,
      expensesGrosze: 0,
      incomeGrosze: 18_000,
    })
    expect(result.data.splits.payment).toEqual({
      cash: 5_000,
      outstanding: 6_000,
      transfer: 7_000,
    })
    expect(result.data.latestPopulatedMonth).toBe('2027-06')
    expect(result.data.coverage).toEqual({
      dateOnlyCount: 0, monthOnlyCount: 0, timedCount: 1, unknownCount: 0,
    })
    expect(result.data.rows).toHaveLength(1)
    expect(Object.keys(result.data.rows[0])).toEqual([
      'id', 'sourceKind', 'appointmentId', 'accountingMonth', 'occurredOn', 'kind',
      'recordType', 'revenueGrosze', 'receivableGrosze', 'collectedGrosze',
      'expenseGrosze', 'specialistId', 'serviceId', 'program', 'paymentMethod',
      'invoiceStatus', 'version',
    ])
    expect(JSON.stringify(result)).not.toMatch(/"(?:raw|source|sourceKey|filename)"/)
  })

  it('fails closed for own-scope-only actors and future Warsaw months', async () => {
    await expect(loadFinanceWindow({
      db: env.DB, actor: SPECIALIST, nowMs: NOW_MS, selectedMonth: '2027-06',
    })).rejects.toThrow(/^NOT_FOUND$/)
    await expect(loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-07',
    })).rejects.toThrow(/^VALIDATION_FAILED\/selectedMonth$/)
    await expect(loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, selectedMonth: '0099-06',
    })).rejects.toThrow(/^VALIDATION_FAILED\/selectedMonth$/)
    await expect(loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2000-05',
    })).rejects.toThrow(/^VALIDATION_FAILED\/selectedMonth$/)
  })

  it('does not synthesize an appointment after its imported authority is voided', async () => {
    await run(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fin_finance_window_voided', null, null, 'income', 'income', '2027-05',
    '2027-05-03', 18_000, 0, 'unknown', 'unpaid', 'not_required',
    SPECIALIST.specialistId, 'apt_finance_window_may', null, '{}', null, 1,
    OWNER.id, NOW, NOW)
    await run(`INSERT INTO finance_manual_voids
      (id,finance_entry_id,expected_entry_version,reason_envelope,
       voided_by_staff_id,created_at) VALUES (?,?,?,?,?,?)`,
    'fmv_finance_window_voided', 'fin_finance_window_voided', 1, '{}', OWNER.id, NOW)
    expect(await env.DB.prepare(`SELECT released_at,version
      FROM finance_appointment_authority_claims
      WHERE finance_entry_id='fin_finance_window_voided'`).first()).toEqual({
      released_at: NOW, version: 2,
    })

    const result = await loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-05',
    })
    expect(result.data.kpis.revenueGrosze).toBe(0)
    expect(result.data.rows).toEqual([])
  })

  it('uses only the effective imported collection revision, including zero', async () => {
    await run(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fin_finance_window_collection', null, null, 'income', 'income', '2027-04',
    '2027-04-03', 18_000, 5_000, 'cash', 'partial', 'not_required',
    SPECIALIST.specialistId, null, null, '{}', null, 1, OWNER.id, NOW, NOW)
    await run(`UPDATE finance_entries SET paid_amount_grosze=7000,payment_method='transfer',
      version=version+1,updated_at=? WHERE id='fin_finance_window_collection'`, NOW)
    await run(`UPDATE finance_entries SET paid_amount_grosze=0,payment_method='unknown',
      settlement_status='unpaid',version=version+1,updated_at=?
      WHERE id='fin_finance_window_collection'`, NOW)

    const result = await loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-04',
    })
    expect(result.data.kpis).toEqual({
      revenueGrosze: 18_000, collectedGrosze: 0, outstandingGrosze: 18_000,
      expensesGrosze: 0, incomeGrosze: 18_000,
    })
    expect(result.data.splits.payment).toEqual({ outstanding: 18_000 })
  })

  it('keeps a paid expense out of revenue collection and payment-method splits', async () => {
    await run(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fin_finance_window_expense', null, null, 'expense', 'expense', '2027-03',
    '2027-03-03', 4_000, 4_000, 'transfer', 'paid', 'not_required', null, null,
    null, '{}', null, 1, OWNER.id, NOW, NOW)

    const result = await loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-03',
    })
    expect(result.data.kpis).toEqual({
      revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0,
      expensesGrosze: 4_000, incomeGrosze: -4_000,
    })
    expect(result.data.splits.payment).toEqual({ outstanding: 0 })
    expect(result.data.coverage).toEqual({
      dateOnlyCount: 1, monthOnlyCount: 0, timedCount: 0, unknownCount: 0,
    })
    expect(Object.values(result.data.coverage).reduce((sum, value) => sum + value, 0))
      .toBe(result.data.rows.length)
  })

  it('uses durable historical service classification while appointment authority wins precedence', async () => {
    await run(`INSERT INTO historical_clients
      (id,identity_envelope,status,active_client_id,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`,
    'hcl_finance_window_service', '{}', 'historical', null, 1, NOW, NOW)
    await run(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,
       materializer_version,object_key,content_nonce_b64,workbook_kek_version,
       metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wba_finance_window_service', 'centre_1', 'staging', '6'.repeat(64), 4096, 2, 2,
    'workbook-objects/wbo_finance_window_service', 'A'.repeat(16), 1, 1,
    'B'.repeat(43), OWNER.id, NOW)
    await run(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbi_finance_window_service', 'wba_finance_window_service', 'C'.repeat(43),
    'ready', 2, 0, 'corr_finance_window_service', OWNER.id, 1, NOW, NOW, null)
    for (const [suffix, rowNumber] of [['historical', 2], ['appointment', 3]]) {
      await run(`INSERT INTO workbook_source_records
        (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
         record_type,disposition,accounting_month,occurred_on,period_precision,
         period_month,amount_grosze,payment_method,settlement_status,invoice_status,
         initial_paid_amount_grosze,record_digest,record_digest_hmac_version,
         specialist_source_digest,specialist_source_hmac_version,warning_codes_json,
         source_payload_version,source_payload_envelope,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `wbs_finance_window_${suffix}`, 'wbi_finance_window_service',
      `workbook:v1:0:${rowNumber}:0`, 0, 'Luty', rowNumber, 0, 'income', 'accepted',
      '2027-02', '2027-02-15', 'day', '2027-02', suffix === 'historical' ? 13_000 : 18_000,
      'unknown', 'unpaid', 'not_required', 0,
      (suffix === 'historical' ? 'D' : 'E').repeat(43), 1, 'F'.repeat(43), 1,
      '[]', 1, '{}', NOW)
      await run(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,
         invoice_status,specialist_id,appointment_id,counterparty_lookup,
         details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `fin_finance_window_${suffix}`, null, null, 'income', 'income', '2027-02',
      '2027-02-15', suffix === 'historical' ? 13_000 : 18_000, 0, 'unknown',
      'unpaid', 'not_required', SPECIALIST.specialistId,
      suffix === 'appointment' ? 'apt_finance_window' : null,
      null, '{}', null, 1, OWNER.id, NOW, NOW)
      await run(`INSERT INTO finance_source_links
        (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?)`, `fsl_finance_window_${suffix}`,
      `wbs_finance_window_${suffix}`, `fin_finance_window_${suffix}`,
      'materialized', OWNER.id, NOW)
      await run(`INSERT INTO historical_client_source_links
        (id,historical_client_id,source_record_id,created_at) VALUES (?,?,?,?)`,
      `hcs_finance_window_${suffix}`, 'hcl_finance_window_service',
      `wbs_finance_window_${suffix}`, NOW)
      await run(`INSERT INTO historical_service_occurrences
        (id,source_record_id,historical_client_id,counterparty_id,specialist_id,
         service_id,service_label_envelope,period_precision,occurred_on,occurred_month,
         status,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `hoc_finance_window_${suffix}`, `wbs_finance_window_${suffix}`,
      'hcl_finance_window_service', null, SPECIALIST.specialistId, 'konsultacja',
      '{}', 'day', '2027-02-15', '2027-02', 'recorded', 1, NOW, NOW)
    }

    expect((await env.DB.prepare(`SELECT finance_entry_id,service_id,classification_source
      FROM finance_reporting_classifications
      WHERE finance_entry_id IN ('fin_finance_window_historical',
        'fin_finance_window_appointment') ORDER BY finance_entry_id`).all()).results)
      .toEqual([
        { finance_entry_id: 'fin_finance_window_appointment', service_id: 'zajecia', classification_source: 'appointment' },
        { finance_entry_id: 'fin_finance_window_historical', service_id: 'konsultacja', classification_source: 'historical' },
      ])
    const result = await loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-02',
    })
    expect(result.data.splits.service).toEqual({ konsultacja: 13_000, zajecia: 18_000 })
    expect(result.data.coverage).toEqual({
      dateOnlyCount: 2, monthOnlyCount: 0, timedCount: 0, unknownCount: 0,
    })

    const correctedAt = new Date(NOW_MS + 1_000).toISOString()
    await expect(run(`UPDATE historical_service_occurrences
      SET service_id='plan',version=version+1,updated_at=?
      WHERE id='hoc_finance_window_historical'`, correctedAt))
      .rejects.toThrow(/immutable_historical_occurrence_provenance/)
    expect(await env.DB.prepare(`SELECT service_id,classification_source
      FROM finance_reporting_classifications
      WHERE finance_entry_id='fin_finance_window_historical'`).first()).toEqual({
      service_id: 'konsultacja', classification_source: 'historical',
    })
  })

  it('uses cap+1 and refuses an incomplete aggregate instead of truncating', async () => {
    const statements = []
    for (let index = 0; index < 1_001; index += 1) {
      statements.push(env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,
         invoice_status,specialist_id,appointment_id,counterparty_lookup,
         details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        `fin_cap_${String(index).padStart(4, '0')}`, null, null, 'income', 'english',
        '2027-05', null, 1, 0, 'unknown', 'unpaid', 'not_required', null, null,
        null, '{}', null, 1, OWNER.id, NOW, NOW,
      ))
      if (statements.length === 50 || index === 1_000) {
        await env.DB.batch(statements.splice(0))
      }
    }

    await expect(loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-06',
    })).rejects.toThrow(/^FINANCE_WINDOW_LIMIT$/)
  })
})
