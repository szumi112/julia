import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const CREATED = '2027-06-15T10:00:00.000Z'
const UPDATED = '2027-06-15T10:00:01.000Z'

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyD1Migrations(env.DB, env.TEST_STAGE_E_MIGRATIONS.filter(({ name }) => (
    name !== '0021_finance_reporting_registry.sql'
  )))
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'stf_finance_backfill', 'finance_backfill_lookup', '{}', '{}', 'owner', 'active',
    'finance-backfill-subject', null, 1, CREATED, null, CREATED, CREATED,
  ).run()
  await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,professional_title_envelope,
     standard_rate_grosze,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
    'sp_finance_backfill', null, '{}', '{}', 18_000, 'active', 1, null,
    CREATED, CREATED,
  ).run()
  await env.DB.prepare(`INSERT INTO clients
    (id,identity_envelope,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).bind(
    'cl_finance_backfill', '{}', 'active', 1, null, CREATED, CREATED,
  ).run()
  await env.DB.prepare(`INSERT INTO appointments
    (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
     status,source,version,cancelled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'apt_finance_backfill', 'cl_finance_backfill', 'sp_finance_backfill',
    'zajecia', '2027-06-15T08:00:00.000Z', '2027-06-15T08:50:00.000Z',
    'Europe/Warsaw', null, 'completed', 'panel', 1, null, CREATED, CREATED,
  ).run()
  for (const [id, kind, amount, paid] of [
    ['fin_finance_backfill_income', 'income', 18_000, 7_000],
    ['fin_finance_backfill_expense', 'expense', 4_000, 4_000],
  ]) await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, null, null, kind, kind, '2027-06', '2027-06-15', amount, paid, 'transfer',
    paid === amount ? 'paid' : 'partial', 'not_required', null, null, null, '{}', null, 2,
    'stf_finance_backfill', CREATED, UPDATED,
  ).run()
  for (const [id, createdAt] of [
    ['fin_finance_backfill_claim_void', CREATED],
    ['fin_finance_backfill_claim_active', UPDATED],
  ]) await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, null, null, 'income', 'income', '2027-06', '2027-06-15', 18_000, 0,
    'unknown', 'unpaid', 'not_required', 'sp_finance_backfill',
    'apt_finance_backfill', null, '{}', null, 1, 'stf_finance_backfill',
    createdAt, createdAt,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_artifacts
    (id,centre_id,environment,fingerprint,byte_size,parser_version,
     materializer_version,object_key,content_nonce_b64,workbook_kek_version,
     metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'wba_finance_backfill', 'centre_1', 'staging', 'a'.repeat(64), 1, 2, 2,
    'workbook-objects/wbo_finance_backfill', 'A'.repeat(16), 1, 1,
    'B'.repeat(43), 'stf_finance_backfill', CREATED,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_imports
    (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
     correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'wbi_finance_backfill', 'wba_finance_backfill', 'C'.repeat(43), 'complete',
    2, 0, 'corr_finance_backfill', 'stf_finance_backfill', 2, CREATED, UPDATED,
    UPDATED,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entry_voids
    (id,finance_entry_id,workbook_import_id,workbook_source_record_id,
     reason_code,voided_by_staff_id,created_at) VALUES (?,?,?,?,?,?,?)`).bind(
    'fev_finance_backfill', 'fin_finance_backfill_claim_void',
    'wbi_finance_backfill', null, 'reconciliation', 'stf_finance_backfill',
    UPDATED,
  ).run()
  const migration = env.TEST_STAGE_E_MIGRATIONS.find(({ name }) => (
    name === '0021_finance_reporting_registry.sql'
  ))
  await applyD1Migrations(env.DB, [migration])
})

describe('0021 derived-authority backfill', () => {
  it('binds the current imported income version/timestamp and omits expenses', async () => {
    expect((await env.DB.prepare(`SELECT finance_entry_id,entry_version,amount_grosze,
      method,created_at FROM finance_collection_events ORDER BY finance_entry_id`).all()).results)
      .toEqual([{
        finance_entry_id: 'fin_finance_backfill_income', entry_version: 2,
        amount_grosze: 7_000, method: 'transfer', created_at: UPDATED,
      }])
  })

  it('releases an existing workbook void and classifies every appointment-linked duplicate', async () => {
    expect((await env.DB.prepare(`SELECT finance_entry_id,appointment_id,released_at,version
      FROM finance_appointment_authority_claims
      WHERE appointment_id='apt_finance_backfill' ORDER BY finance_entry_id`).all()).results)
      .toEqual([
        {
          finance_entry_id: 'fin_finance_backfill_claim_active',
          appointment_id: 'apt_finance_backfill', released_at: null, version: 1,
        },
        {
          finance_entry_id: 'fin_finance_backfill_claim_void',
          appointment_id: 'apt_finance_backfill', released_at: UPDATED, version: 2,
        },
      ])
    expect((await env.DB.prepare(`SELECT finance_entry_id,service_id,classification_source
      FROM finance_reporting_classifications WHERE finance_entry_id LIKE 'fin_finance_backfill_claim_%'
      ORDER BY finance_entry_id`).all()).results).toEqual([
      {
        finance_entry_id: 'fin_finance_backfill_claim_active', service_id: 'zajecia',
        classification_source: 'appointment',
      },
      {
        finance_entry_id: 'fin_finance_backfill_claim_void', service_id: 'zajecia',
        classification_source: 'appointment',
      },
    ])
  })
})
