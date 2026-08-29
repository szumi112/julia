import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW = '2027-06-15T10:00:00.000Z'
const OWNER_ID = 'stf_finance_authority_owner'
const run = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).run()

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await run(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  OWNER_ID, 'finance_authority_owner_lookup', '{}', '{}', 'owner', 'active',
  'finance-authority-owner-subject', null, 1, NOW, null, NOW, NOW)
  await run(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,professional_title_envelope,
     standard_rate_grosze,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
  'sp_finance_authority', null, '{}', '{}', 18_000, 'active', 1, null, NOW, NOW)
  await run(`INSERT INTO clients
    (id,identity_envelope,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`,
  'cl_finance_authority', '{}', 'active', 1, null, NOW, NOW)
  await run(`INSERT INTO appointments
    (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
     status,source,version,cancelled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'apt_finance_authority', 'cl_finance_authority', 'sp_finance_authority', 'zajecia',
  NOW, '2027-06-15T10:50:00.000Z', 'Europe/Warsaw', null, 'completed', 'panel',
  1, null, NOW, NOW)
})

describe('finance economic and resolution revision authority', () => {
  const insertEntry = (id) => run(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, null, null, 'income', 'income', '2027-06', '2027-06-15', 18_000, 0,
  'unknown', 'unpaid', 'not_required', 'sp_finance_authority',
  'apt_finance_authority', null, '{}', null, 1, OWNER_ID, NOW, NOW)

  it('releases only the active appointment claim on void and permits a replacement authority', async () => {
    await insertEntry('fin_finance_authority_first')
    await expect(insertEntry('fin_finance_authority_blocked')).rejects.toThrow()
    await run(`INSERT INTO finance_manual_voids
      (id,finance_entry_id,expected_entry_version,reason_envelope,
       voided_by_staff_id,created_at) VALUES (?,?,?,?,?,?)`,
    'fmv_finance_authority_first', 'fin_finance_authority_first', 1, '{}', OWNER_ID, NOW)
    await insertEntry('fin_finance_authority_replacement')

    const claims = (await env.DB.prepare(
      `SELECT finance_entry_id,released_at FROM finance_appointment_authority_claims
       WHERE appointment_id='apt_finance_authority' ORDER BY finance_entry_id`,
    ).all()).results
    expect(claims).toEqual([
      { finance_entry_id: 'fin_finance_authority_first', released_at: NOW },
      { finance_entry_id: 'fin_finance_authority_replacement', released_at: null },
    ])
  })

  it('stores contiguous creator-bound resolution revisions and rejects stale versions', async () => {
    await run(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,
       materializer_version,object_key,content_nonce_b64,workbook_kek_version,
       metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wba_finance_authority', 'centre_1', 'staging', '8'.repeat(64), 2048, 2, 2,
    'workbook-objects/wbo_finance_authority', 'A'.repeat(16), 1, 1, 'B'.repeat(43),
    OWNER_ID, NOW)
    await run(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbi_finance_authority', 'wba_finance_authority', 'C'.repeat(43), 'conflicts',
    1, 0, 'corr_finance_authority', OWNER_ID, 1, NOW, NOW, null)
    const insertSet = (id, version) => run(`INSERT INTO workbook_import_resolution_sets
      (id,import_id,artifact_id,preview_token_digest,plan_digest,resolution_count,
       resolutions_envelope,created_by_staff_id,version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, 'wbi_finance_authority', 'wba_finance_authority', 'C'.repeat(43),
    'v1.' + 'D'.repeat(43), 1, '{}', OWNER_ID, version, NOW)

    await insertSet('wrs_finance_authority_v1', 1)
    await expect(insertSet('wrs_finance_authority_stale', 1)).rejects.toThrow()
    await expect(insertSet('wrs_finance_authority_gap', 3)).rejects.toThrow()
    await insertSet('wrs_finance_authority_v2', 2)
    expect(await env.DB.prepare(
      `SELECT max(version) AS version FROM workbook_import_resolution_sets
       WHERE import_id='wbi_finance_authority'`,
    ).first('version')).toBe(2)
  })

  it('rejects an import-bound void after a manual void has already won', async () => {
    await run(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fin_finance_authority_dual_void', null, null, 'income', 'income', '2027-06',
    '2027-06-15', 18_000, 0, 'unknown', 'unpaid', 'not_required', null, null,
    null, '{}', null, 1, OWNER_ID, NOW, NOW)
    await run(`INSERT INTO finance_manual_voids
      (id,finance_entry_id,expected_entry_version,reason_envelope,
       voided_by_staff_id,created_at) VALUES (?,?,?,?,?,?)`,
    'fmv_finance_authority_dual', 'fin_finance_authority_dual_void', 1, '{}',
    OWNER_ID, NOW)

    await expect(run(`INSERT INTO finance_entry_voids
      (id,finance_entry_id,workbook_import_id,workbook_source_record_id,
       reason_code,voided_by_staff_id,created_at) VALUES (?,?,?,?,?,?,?)`,
    'fev_finance_authority_dual', 'fin_finance_authority_dual_void',
    'wbi_finance_authority', null, 'reconciliation', OWNER_ID, NOW))
      .rejects.toThrow(/finance_entry_already_void/)
  })

  it('prevents appointment claim drift through finance entry updates', async () => {
    await run(`INSERT INTO appointments
      (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
       status,source,version,cancelled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'apt_finance_authority_update', 'cl_finance_authority', 'sp_finance_authority',
    'zajecia', NOW, '2027-06-15T10:50:00.000Z', 'Europe/Warsaw', null,
    'completed', 'panel', 1, null, NOW, NOW)
    await expect(run(
      `UPDATE finance_entries SET appointment_id=?,version=version+1 WHERE id=?`,
      'apt_finance_authority_update', 'fin_finance_authority_replacement',
    )).rejects.toThrow(/immutable_finance_appointment_authority/)
  })

  it('versions imported collection authority across corrections and zero transitions', async () => {
    await run(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fin_finance_collection_revision', null, null, 'income', 'income', '2027-06',
    '2027-06-15', 18_000, 5_000, 'cash', 'partial', 'not_required', null, null,
    null, '{}', null, 1, OWNER_ID, NOW, NOW)
    await run(`UPDATE finance_entries SET paid_amount_grosze=?,payment_method=?,
      settlement_status=?,version=version+1,updated_at=? WHERE id=?`,
    7_000, 'transfer', 'partial', NOW, 'fin_finance_collection_revision')
    await run(`UPDATE finance_entries SET paid_amount_grosze=?,payment_method=?,
      settlement_status=?,version=version+1,updated_at=? WHERE id=?`,
    0, 'unknown', 'unpaid', NOW, 'fin_finance_collection_revision')

    const events = (await env.DB.prepare(
      `SELECT entry_version,amount_grosze,method FROM finance_collection_events
       WHERE finance_entry_id=? ORDER BY entry_version`,
    ).bind('fin_finance_collection_revision').all()).results
    expect(events).toEqual([
      { entry_version: 1, amount_grosze: 5_000, method: 'cash' },
      { entry_version: 2, amount_grosze: 7_000, method: 'transfer' },
      { entry_version: 3, amount_grosze: 0, method: 'unknown' },
    ])
  })

  it('revisions FinanceWindow visibility when an import batch commits', async () => {
    const before = await env.DB.prepare(
      "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
    ).first('revision')
    await run(`INSERT INTO finance_import_batches
      (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,
       status,created_by_staff_id,version,created_at,updated_at,committed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fib_finance_reporting_revision', '9'.repeat(64), '{}', 1, 1, 0,
    'importing', OWNER_ID, 1, NOW, NOW, null)
    await run(`UPDATE finance_import_batches SET accepted_rows=1,status='committed',
      version=2,updated_at=?,committed_at=? WHERE id=?`,
    NOW, NOW, 'fib_finance_reporting_revision')
    expect(await env.DB.prepare(
      "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
    ).first('revision')).toBe(before + 2)
  })

  it('revisions FinanceWindow when an append-only source link changes period coverage', async () => {
    await run(`INSERT INTO workbook_source_records
      (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
       record_type,disposition,accounting_month,occurred_on,period_precision,
       period_month,amount_grosze,payment_method,settlement_status,invoice_status,
       initial_paid_amount_grosze,record_digest,record_digest_hmac_version,
       specialist_source_digest,specialist_source_hmac_version,warning_codes_json,
       source_payload_version,source_payload_envelope,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbs_finance_link_revision', 'wbi_finance_authority',
    'workbook:v1:0:91:0', 0, 'Fikcyjny arkusz', 91, 0, 'income', 'accepted',
    '2027-06', '2027-06-15', 'day', '2027-06', 18_000, 'unknown', 'unpaid',
    'not_required', 0, 'L'.repeat(43), 1, 'S'.repeat(43), 1, '[]', 1, '{}', NOW)
    await run(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fin_finance_link_revision', null, null, 'income', 'income', '2027-06',
    '2027-06-15', 18_000, 0, 'unknown', 'unpaid', 'not_required', null, null,
    null, '{}', null, 1, OWNER_ID, NOW, NOW)
    const before = await env.DB.prepare(
      "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
    ).first('revision')

    await run(`INSERT INTO finance_source_links
      (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?)`,
    'fsl_finance_link_revision', 'wbs_finance_link_revision',
    'fin_finance_link_revision', 'materialized', OWNER_ID, NOW)

    expect(await env.DB.prepare(
      "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
    ).first('revision')).toBe(before + 1)
  })

  it('revisions FinanceWindow when an encrypted specialist display label changes', async () => {
    const before = await env.DB.prepare(
      "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
    ).first('revision')

    await run(`UPDATE specialists SET display_name_envelope=?,version=version+1,updated_at=?
      WHERE id=?`, '{"renamed":true}', NOW, 'sp_finance_authority')

    expect(await env.DB.prepare(
      "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
    ).first('revision')).toBe(before + 1)
  })

  it('rejects direct derived-authority forgery and does not snapshot expenses', async () => {
    await expect(run(`INSERT INTO finance_appointment_authority_claims
      (finance_entry_id,appointment_id,claimed_at,released_at,version)
      VALUES (?,?,?,?,?)`,
    'fin_finance_authority_dual_void', 'apt_finance_authority_update', NOW, null, 1))
      .rejects.toThrow(/invalid_finance_appointment_authority/)
    await expect(run(`UPDATE finance_appointment_authority_claims
      SET released_at=?,version=2 WHERE finance_entry_id=?`,
    NOW, 'fin_finance_authority_replacement'))
      .rejects.toThrow(/invalid_finance_authority_release/)

    await run(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fin_finance_collection_expense', null, null, 'expense', 'expense', '2027-06',
    '2027-06-15', 4_000, 4_000, 'transfer', 'paid', 'not_required', null, null,
    null, '{}', null, 1, OWNER_ID, NOW, NOW)
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM finance_collection_events
      WHERE finance_entry_id='fin_finance_collection_expense'`).first('count')).toBe(0)
    await expect(run(`INSERT INTO finance_collection_events
      (id,finance_entry_id,entry_version,amount_grosze,method,created_at)
      VALUES (?,?,?,?,?,?)`, 'fce_forged_expense', 'fin_finance_collection_expense',
    1, 4_000, 'transfer', NOW)).rejects.toThrow(/invalid_finance_collection_authority/)
    await expect(run(`INSERT INTO finance_collection_events
      (id,finance_entry_id,entry_version,amount_grosze,method,created_at)
      VALUES (?,?,?,?,?,?)`, 'fce_forged_revision', 'fin_finance_collection_revision',
    4, 1, 'cash', NOW)).rejects.toThrow(/invalid_finance_collection_authority/)

    await expect(run(`UPDATE finance_reporting_classifications
      SET service_id='konsultacja',classification_source='historical',
          version=version+1,updated_at=? WHERE finance_entry_id=?`,
    NOW, 'fin_finance_authority_replacement'))
      .rejects.toThrow(/invalid_finance_reporting_classification/)
    const beforeRevision = await env.DB.prepare(
      "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
    ).first('revision')
    await run(`UPDATE finance_reporting_classifications
      SET service_id='zajecia',classification_source='appointment',
          version=version+1,updated_at=? WHERE finance_entry_id=?`,
    NOW, 'fin_finance_authority_replacement')
    expect(await env.DB.prepare(
      "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
    ).first('revision')).toBe(beforeRevision + 1)
  })

  it('keeps the reporting revision singleton monotonic and undeletable', async () => {
    const before = await env.DB.prepare(
      "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
    ).first('revision')
    await expect(run(`UPDATE finance_reporting_state SET revision=?
      WHERE authority_key='finance'`, before - 1))
      .rejects.toThrow(/invalid_finance_reporting_revision/)
    await expect(run(`UPDATE finance_reporting_state SET revision=?
      WHERE authority_key='finance'`, before + 2))
      .rejects.toThrow(/invalid_finance_reporting_revision/)
    await expect(run(`UPDATE finance_reporting_state SET authority_key='other',revision=?
      WHERE authority_key='finance'`, before + 1))
      .rejects.toThrow(/invalid_finance_reporting_revision/)
    await expect(run(`DELETE FROM finance_reporting_state
      WHERE authority_key='finance'`))
      .rejects.toThrow(/finance_reporting_state_no_delete/)
    expect(await env.DB.prepare(
      "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
    ).first('revision')).toBe(before)
  })
})
