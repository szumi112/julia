import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW = '2027-03-01T08:00:00.000Z'

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
})

describe('historical workspace migration', () => {
  it('adds the projection, encrypted subjects, occurrences, conflicts, and resolution tables', async () => {
    const rows = (await env.DB.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'historical_%' ORDER BY name`).all()).results
    expect(rows.map(({ name }) => name)).toEqual([
      'historical_client_lookup_aliases',
      'historical_client_source_links',
      'historical_clients',
      'historical_conflict_resolutions',
      'historical_counterparties',
      'historical_counterparty_lookup_aliases',
      'historical_counterparty_source_links',
      'historical_projection_conflicts',
      'historical_projection_jobs',
      'historical_request_replays',
      'historical_service_occurrences',
    ])
  })

  it('enforces subject xor, source precision, immutable provenance, and one-way activation', async () => {
    await env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES ('stf_historical_owner','lookup_historical_owner','{}','{}','owner','active',
       'historical-owner',NULL,1,?,NULL,?,?)`).bind(NOW, NOW, NOW).run()
    await env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
       archived_at,created_at,updated_at)
      VALUES ('sp_historical_one',NULL,'{}',18000,'active',1,NULL,?,?)`)
      .bind(NOW, NOW).run()
    await env.DB.prepare(`INSERT INTO historical_clients
      (id,identity_envelope,status,active_client_id,version,created_at,updated_at)
      VALUES ('hcl_migration_one','{}','historical',NULL,1,?,?)`).bind(NOW, NOW).run()
    await env.DB.prepare(`INSERT INTO historical_counterparties
      (id,identity_envelope,version,created_at,updated_at)
      VALUES ('hcp_migration_one','{}',1,?,?)`).bind(NOW, NOW).run()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_artifacts
        (id,centre_id,environment,fingerprint,byte_size,parser_version,
         materializer_version,object_key,content_nonce_b64,workbook_kek_version,
         metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
        VALUES ('wba_historical_migration','centre_1','staging',?,4096,2,2,
          'workbook-objects/wbo_historical_migration','AAAAAAAAAAAAAAAA',1,1,?,?,?)`).bind(
        'a'.repeat(64), 'A'.repeat(43), 'stf_historical_owner', NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_imports
        (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
         correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES ('wbi_historical_migration','wba_historical_migration',?,'ready',4,0,
          'historical_migration','stf_historical_owner',1,?,?,NULL)`).bind(
        'B'.repeat(43), NOW, NOW,
      ),
    ])
    for (const [suffix, rowNumber] of [
      ['one', 2], ['two', 3], ['three', 4], ['four', 5],
    ]) {
      await env.DB.prepare(`INSERT INTO workbook_source_records
        (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
         record_type,disposition,accounting_month,occurred_on,period_precision,
         period_month,amount_grosze,payment_method,settlement_status,invoice_status,
         initial_paid_amount_grosze,record_digest,record_digest_hmac_version,
         specialist_source_digest,specialist_source_hmac_version,warning_codes_json,
         source_payload_version,source_payload_envelope,created_at)
        VALUES (?, 'wbi_historical_migration',?,0,'Styczeń',?,0,'income','accepted',
          '2025-01','2025-01-15','day','2025-01',18000,'cash','paid','not_required',
          18000,?,1,?,1,'[]',1,'{}',?)`).bind(
        `wbs_historical_migration_${suffix}`, `workbook:v1:0:${rowNumber}:0`, rowNumber,
        String.fromCharCode(66 + rowNumber).repeat(43), 'E'.repeat(43), NOW,
      ).run()
      await env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,
         invoice_status,specialist_id,appointment_id,counterparty_lookup,
         details_envelope,source_row_envelope,version,created_by_staff_id,
         created_at,updated_at)
        VALUES (?,NULL,NULL,'income','income','2025-01','2025-01-15',18000,18000,
          'cash','paid','not_required','sp_historical_one',NULL,NULL,'{}',NULL,1,
          'stf_historical_owner',?,?)`).bind(
        `fin_historical_migration_${suffix}`, NOW, NOW,
      ).run()
      await env.DB.prepare(`INSERT INTO finance_source_links
        (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
        VALUES (?,?,?,'materialized','stf_historical_owner',?)`).bind(
        `fsl_historical_migration_${suffix}`, `wbs_historical_migration_${suffix}`,
        `fin_historical_migration_${suffix}`, NOW,
      ).run()
    }
    await env.DB.prepare(`INSERT INTO historical_client_source_links
      (id,historical_client_id,source_record_id,created_at)
      VALUES ('hcs_migration_one','hcl_migration_one',
        'wbs_historical_migration_one',?)`).bind(NOW).run()
    await env.DB.prepare(`INSERT INTO historical_service_occurrences
      (id,source_record_id,historical_client_id,counterparty_id,specialist_id,
       service_id,service_label_envelope,period_precision,occurred_on,occurred_month,
       status,version,created_at,updated_at)
      VALUES ('hoc_migration_one','wbs_historical_migration_one','hcl_migration_one',NULL,
       'sp_historical_one','zajecia','{}','day','2025-01-15','2025-01',
       'recorded',1,?,?)`).bind(NOW, NOW).run()
    await expect(env.DB.prepare(`INSERT INTO finance_entry_voids
      (id,finance_entry_id,workbook_import_id,workbook_source_record_id,
       reason_code,voided_by_staff_id,created_at)
      VALUES ('fev_recorded_occurrence','fin_historical_migration_one',
       'wbi_historical_migration','wbs_historical_migration_one','reconciliation',
       'stf_historical_owner',?)`).bind(NOW).run())
      .rejects.toThrow(/recorded_historical_occurrence/)
    await env.DB.prepare(`UPDATE historical_service_occurrences
      SET status='voided',version=2,updated_at='2027-03-01T08:00:01.000Z'
      WHERE id='hoc_migration_one'`).run()
    await env.DB.prepare(`INSERT INTO finance_entry_voids
      (id,finance_entry_id,workbook_import_id,workbook_source_record_id,
       reason_code,voided_by_staff_id,created_at)
      VALUES ('fev_voided_occurrence','fin_historical_migration_one',
       'wbi_historical_migration','wbs_historical_migration_one','reconciliation',
       'stf_historical_owner','2027-03-01T08:00:01.000Z')`).run()
    await expect(env.DB.prepare(`INSERT INTO historical_counterparty_source_links
      (id,counterparty_id,source_record_id,created_at)
      VALUES ('hps_bad_cross_link','hcp_migration_one',
        'wbs_historical_migration_one',?)`).bind(NOW).run())
      .rejects.toThrow(/historical_source_subject_conflict/)
    await env.DB.prepare(`INSERT INTO historical_counterparty_source_links
      (id,counterparty_id,source_record_id,created_at)
      VALUES ('hps_migration_one','hcp_migration_one',
        'wbs_historical_migration_two',?)`).bind(NOW).run()
    await expect(env.DB.prepare(`INSERT INTO historical_client_source_links
      (id,historical_client_id,source_record_id,created_at)
      VALUES ('hcs_bad_cross_link','hcl_migration_one',
        'wbs_historical_migration_two',?)`).bind(NOW).run())
      .rejects.toThrow(/historical_source_subject_conflict/)
    for (const suffix of ['three', 'four']) {
      await env.DB.prepare(`INSERT INTO finance_entry_voids
        (id,finance_entry_id,workbook_import_id,workbook_source_record_id,
         reason_code,voided_by_staff_id,created_at)
        VALUES (?,?, 'wbi_historical_migration',?,'reconciliation',
          'stf_historical_owner',?)`).bind(
        `fev_migration_${suffix}`, `fin_historical_migration_${suffix}`,
        `wbs_historical_migration_${suffix}`, NOW,
      ).run()
    }
    await expect(env.DB.prepare(`INSERT INTO historical_client_source_links
      (id,historical_client_id,source_record_id,created_at)
      VALUES ('hcs_voided_person','hcl_migration_one',
        'wbs_historical_migration_three',?)`).bind(NOW).run())
      .rejects.toThrow(/invalid_historical_source/)
    await expect(env.DB.prepare(`INSERT INTO historical_counterparty_source_links
      (id,counterparty_id,source_record_id,created_at)
      VALUES ('hps_voided_counterparty','hcp_migration_one',
        'wbs_historical_migration_four',?)`).bind(NOW).run())
      .rejects.toThrow(/invalid_historical_source/)
    await expect(env.DB.prepare(`INSERT INTO historical_service_occurrences
      (id,source_record_id,historical_client_id,counterparty_id,specialist_id,
       service_id,service_label_envelope,period_precision,occurred_on,occurred_month,
       status,version,created_at,updated_at)
      VALUES ('hoc_bad_xor','wbs_missing','hcl_migration_one','hcp_migration_one',
       'sp_historical_one',NULL,'{}','unknown',NULL,NULL,'recorded',1,?,?)`)
      .bind(NOW, NOW).run()).rejects.toThrow()
    await expect(env.DB.prepare(`UPDATE historical_clients
      SET status='historical',active_client_id=NULL,version=2,updated_at=?
      WHERE id='hcl_migration_one'`).bind(NOW).run()).rejects.toThrow(/invalid_historical_client_transition/)
    await expect(env.DB.prepare(
      `DELETE FROM historical_clients WHERE id='hcl_migration_one'`,
    ).run()).rejects.toThrow(/no_routine_delete/)
  })
})
