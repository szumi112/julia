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

describe('activity workspace migration', () => {
  it('creates the bounded activity graph, projection cursor, and replay tables', async () => {
    const rows = (await env.DB.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'activity_%' ORDER BY name`).all()).results
    expect(rows.map(({ name }) => name)).toEqual([
      'activity_attendance',
      'activity_charges',
      'activity_classes',
      'activity_group_leaders',
      'activity_group_lookup_aliases',
      'activity_groups',
      'activity_memberships',
      'activity_participant_lookup_aliases',
      'activity_participants',
      'activity_programs',
      'activity_projection_jobs',
      'activity_request_replays',
      'activity_source_links',
    ])
    const programs = (await env.DB.prepare(
      'SELECT id,code FROM activity_programs ORDER BY code',
    ).all()).results
    expect(programs).toEqual([
      { id: 'apg_english', code: 'english' },
      { id: 'apg_tus', code: 'tus' },
    ])
  })

  it('stores no monetary copies and defers payments until ownership can be proven', async () => {
    const chargeColumns = (await env.DB.prepare(
      'PRAGMA table_info(activity_charges)',
    ).all()).results.map(({ name }) => name)
    for (const forbidden of [
      'amount_grosze', 'paid_amount_grosze', 'currency', 'payment_method',
      'settlement_status',
    ]) {
      expect(chargeColumns).not.toContain(forbidden)
    }
    expect(chargeColumns).toContain('finance_entry_id')
    expect(await env.DB.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name='activity_payments'`).first()).toBeNull()
    const groupColumns = (await env.DB.prepare(
      'PRAGMA table_info(activity_groups)',
    ).all()).results.map(({ name }) => name)
    const participantColumns = (await env.DB.prepare(
      'PRAGMA table_info(activity_participants)',
    ).all()).results.map(({ name }) => name)
    expect(groupColumns).toContain('label_envelope')
    expect(groupColumns).not.toContain('label')
    expect(participantColumns).toContain('identity_envelope')
    expect(participantColumns).not.toContain('name')
  })

  it('rejects impossible and year-zero civil days and months in D1', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO specialists
        (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
         archived_at,created_at,updated_at)
        VALUES ('sp_activity_civil',NULL,'{}',18000,'active',1,NULL,?,?)`).bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_groups
        (id,program_id,label_envelope,details_envelope,status,version,created_at,updated_at)
        VALUES ('agr_activity_civil','apg_tus','{}',NULL,'active',1,?,?)`).bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_participants
        (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
         created_at,updated_at)
        VALUES ('acp_activity_civil','apg_tus','{}',NULL,NULL,'active',1,?,?)`)
        .bind(NOW, NOW),
    ])
    for (const day of ['0000-01-01', '2025-02-30']) {
      await expect(env.DB.prepare(`INSERT INTO activity_group_leaders
        (id,group_id,specialist_id,starts_on,ends_on,status,version,created_at,updated_at)
        VALUES (?, 'agr_activity_civil','sp_activity_civil',?,NULL,'active',1,?,?)`)
        .bind(`agl_activity_civil_${day.replaceAll('-', '_')}`, day, NOW, NOW).run())
        .rejects.toThrow()
      await expect(env.DB.prepare(`INSERT INTO activity_classes
        (id,group_id,occurs_on,wall_time,duration_minutes,topic_envelope,status,
         version,created_at,updated_at)
        VALUES (?, 'agr_activity_civil',?,NULL,NULL,NULL,'completed',1,?,?)`)
        .bind(`acl_activity_civil_${day.replaceAll('-', '_')}`, day, NOW, NOW).run())
        .rejects.toThrow()
      await expect(env.DB.prepare(`INSERT INTO activity_memberships
        (id,participant_id,program_id,group_id,membership_kind,period_precision,
         observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
        VALUES (?,'acp_activity_civil','apg_tus','agr_activity_civil','interval',
         'unknown',NULL,NULL,?,NULL,'active',1,?,?)`)
        .bind(`amb_activity_civil_${day.replaceAll('-', '_')}`, day, NOW, NOW).run())
        .rejects.toThrow()
    }
    await expect(env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_activity_civil_zero_month','acp_activity_civil','apg_tus',
       'agr_activity_civil','observation','month',NULL,'0000-01',NULL,NULL,
       'active',1,?,?)`).bind(NOW, NOW).run()).rejects.toThrow()
    await expect(env.DB.prepare(`INSERT INTO activity_classes
      (id,group_id,occurs_on,wall_time,duration_minutes,topic_envelope,status,
       version,created_at,updated_at)
      VALUES ('acl_activity_civil_leap','agr_activity_civil','0004-02-29',NULL,
       NULL,NULL,'completed',1,?,?)`).bind(NOW, NOW).run()).resolves.toMatchObject({
      success: true,
    })
  })

  it('keeps observations separate from native intervals and enforces program equality', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_groups
        (id,program_id,label_envelope,details_envelope,status,version,created_at,updated_at)
        VALUES ('agr_migration_tus','apg_tus','{}',NULL,'active',1,?,?)`).bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_groups
        (id,program_id,label_envelope,details_envelope,status,version,created_at,updated_at)
        VALUES ('agr_migration_english','apg_english','{}',NULL,'active',1,?,?)`)
        .bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_participants
        (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
         created_at,updated_at)
        VALUES ('acp_migration_tus','apg_tus','{}',NULL,NULL,'active',1,?,?)`)
        .bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_memberships
        (id,participant_id,program_id,group_id,membership_kind,period_precision,
         observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
        VALUES ('amb_migration_observation','acp_migration_tus','apg_tus',
         'agr_migration_tus','observation','month',NULL,'2025-01',NULL,NULL,
         'active',1,?,?)`).bind(NOW, NOW),
    ])
    await expect(env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_migration_invented','acp_migration_tus','apg_tus',
       'agr_migration_tus','observation','month',NULL,'2025-02','2025-02-01',NULL,
       'active',1,?,?)`).bind(NOW, NOW).run()).rejects.toThrow()
    await expect(env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_migration_wrong_program','acp_migration_tus','apg_tus',
       'agr_migration_english','observation','month',NULL,'2025-02',NULL,NULL,
       'active',1,?,?)`).bind(NOW, NOW).run())
      .rejects.toThrow(/activity_membership_program_mismatch/)
    await env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_migration_interval','acp_migration_tus','apg_tus',
       'agr_migration_tus','interval','unknown',NULL,NULL,'2025-03-01','2025-06-30',
       'active',1,?,?)`).bind(NOW, NOW).run()
    await expect(env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_migration_overlap','acp_migration_tus','apg_tus',
       'agr_migration_tus','interval','unknown',NULL,NULL,'2025-06-01','2025-08-31',
       'active',1,?,?)`).bind(NOW, NOW).run())
      .rejects.toThrow(/activity_membership_overlap/)
    await env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_migration_inactive_history','acp_migration_tus','apg_tus',
       'agr_migration_tus','interval','unknown',NULL,NULL,'2024-01-01','2024-06-30',
       'inactive',1,?,?)`).bind(NOW, NOW).run()
    await expect(env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_migration_overlap_inactive','acp_migration_tus','apg_tus',
       'agr_migration_tus','interval','unknown',NULL,NULL,'2024-03-01','2024-04-30',
       'active',1,?,?)`).bind(NOW, NOW).run())
      .rejects.toThrow(/activity_membership_overlap/)
    await expect(env.DB.prepare(`UPDATE activity_memberships
      SET id='amb_migration_interval_changed',version=2,updated_at=?
      WHERE id='amb_migration_interval'`).bind(NOW).run())
      .rejects.toThrow(/immutable_activity_membership_identity/)
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_classes
        (id,group_id,occurs_on,wall_time,duration_minutes,topic_envelope,status,
         version,created_at,updated_at)
        VALUES ('acl_migration_attendance','agr_migration_tus','2025-04-15',NULL,
         NULL,NULL,'completed',1,?,?)`).bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_attendance
        (id,class_id,participant_id,status,version,created_at,updated_at)
        VALUES ('aat_migration_attendance','acl_migration_attendance',
         'acp_migration_tus','present',1,?,?)`).bind(NOW, NOW),
    ])
    await expect(env.DB.prepare(`UPDATE activity_classes
      SET occurs_on='2025-07-15',version=2,updated_at=?
      WHERE id='acl_migration_attendance'`).bind(NOW).run())
      .rejects.toThrow(/activity_class_attendance_stranded/)
    await expect(env.DB.prepare(`UPDATE activity_memberships
      SET ends_on='2025-03-31',version=2,updated_at=?
      WHERE id='amb_migration_interval'`).bind(NOW).run())
      .rejects.toThrow(/activity_membership_attendance_stranded/)
    await expect(env.DB.prepare(`UPDATE activity_memberships
      SET ends_on='2025-04-15',version=2,updated_at=?
      WHERE id='amb_migration_interval'`).bind(NOW).run()).resolves.toMatchObject({
        success: true,
      })
    await expect(env.DB.prepare(`UPDATE activity_memberships
      SET status='inactive',version=3,updated_at=?
      WHERE id='amb_migration_interval'`).bind(NOW).run()).resolves.toMatchObject({
        success: true,
      })
    await env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_migration_attendance_observation','acp_migration_tus','apg_tus',
       'agr_migration_tus','observation','day','2025-04-15','2025-04',NULL,NULL,
       'active',1,?,?)`).bind(NOW, NOW).run()
    await expect(env.DB.prepare(`UPDATE activity_memberships
      SET ends_on='2025-03-31',version=4,updated_at=?
      WHERE id='amb_migration_interval'`).bind(NOW).run()).resolves.toMatchObject({
        success: true,
      })
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_participants
        (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
         created_at,updated_at)
        VALUES ('acp_migration_english','apg_english','{}',NULL,NULL,'active',1,?,?)`)
        .bind(NOW, NOW),
      env.DB.prepare(`UPDATE activity_groups SET status='inactive',version=2,updated_at=?
        WHERE id='agr_migration_english'`).bind(NOW),
    ])
    await expect(env.DB.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('amb_migration_inactive_group','acp_migration_english','apg_english',
       'agr_migration_english','interval','unknown',NULL,NULL,'2025-01-01',NULL,
       'active',1,?,?)`).bind(NOW, NOW).run())
      .rejects.toThrow(/activity_membership_inactive_graph/)
    await expect(env.DB.prepare(`INSERT INTO activity_classes
      (id,group_id,occurs_on,wall_time,duration_minutes,topic_envelope,status,
       version,created_at,updated_at)
      VALUES ('acl_migration_inactive_group','agr_migration_english','2025-04-15',
       NULL,NULL,NULL,'scheduled',1,?,?)`).bind(NOW, NOW).run())
      .rejects.toThrow(/activity_class_inactive_group/)
  })

  it('binds an imported charge to one authenticated source/finance pair and guards reverse drift', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO staff_users
        (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
         specialist_id,version,activated_at,disabled_at,created_at,updated_at)
        VALUES ('stf_activity_owner','activity_owner_lookup','{}','{}','owner','active',
         'activity-owner-subject',NULL,1,?,NULL,?,?)`).bind(NOW, NOW, NOW),
      env.DB.prepare(`INSERT INTO specialists
        (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
         archived_at,created_at,updated_at)
        VALUES ('sp_activity_julia',NULL,'{}',18000,'active',1,NULL,?,?)`).bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO specialists
        (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
         archived_at,created_at,updated_at)
        VALUES ('sp_activity_other',NULL,'{}',18000,'active',1,NULL,?,?)`).bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO finance_import_batches
        (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
         created_by_staff_id,version,created_at,updated_at,committed_at)
        VALUES ('fib_activity_import',?,'{}',1,1,1,'committed','stf_activity_owner',1,?,?,?)`)
        .bind('a'.repeat(64), NOW, NOW, NOW),
      env.DB.prepare(`INSERT INTO workbook_artifacts
        (id,centre_id,environment,fingerprint,byte_size,parser_version,materializer_version,
         object_key,content_nonce_b64,workbook_kek_version,metadata_hmac_version,
         metadata_signature,created_by_staff_id,created_at)
        VALUES ('wba_activity_import','centre_1','staging',?,4096,2,2,
         'workbook-objects/wbo_activity_import_one','AAAAAAAAAAAAAAAA',1,1,?,
         'stf_activity_owner',?)`).bind('b'.repeat(64), 'B'.repeat(43), NOW),
    ])
    await env.DB.prepare(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES ('wbi_activity_import','wba_activity_import',?,'complete',1,0,
       'activity_import_correlation','stf_activity_owner',2,?,?,?)`)
      .bind('C'.repeat(43), NOW, NOW, NOW).run()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_import_plans
        (import_id,workbook_kind,plan_version,plan_envelope,created_at)
        VALUES ('wbi_activity_import','legacy',1,'{}',?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO workbook_materialization_jobs
        (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
         summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES ('wbj_activity_import','wbi_activity_import','complete','complete',1,1,1,
         '{}','{}','stf_activity_owner',2,?,?,?)`).bind(NOW, NOW, NOW),
      env.DB.prepare(`INSERT INTO workbook_source_records
        (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
         disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
         payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
         record_digest,record_digest_hmac_version,specialist_source_digest,
         specialist_source_hmac_version,warning_codes_json,source_payload_version,
         source_payload_envelope,created_at)
        VALUES ('wbs_activity_tus','wbi_activity_import','workbook:v1:0:2:0',0,'TUS',2,0,
         'tus','accepted','2025-01',NULL,'month','2025-01',34000,'transfer','paid',
         'not_required',34000,?,1,?,1,'[]',1,'{}',?)`)
        .bind('D'.repeat(43), 'E'.repeat(43), NOW),
      env.DB.prepare(`INSERT INTO workbook_resolutions
        (id,import_id,source_record_id,kind,resolution_code,specialist_id,
         source_value_kind,source_value_digest,source_value_hmac_version,
         source_value_envelope,resolved_by_staff_id,created_at)
        VALUES ('wbr_activity_julia','wbi_activity_import',NULL,'specialist_mapping',
         'blank_assigned_to_julia','sp_activity_julia','blank',?,1,'{}',
         'stf_activity_owner',?)`).bind('E'.repeat(43), NOW),
      env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
         specialist_id,appointment_id,counterparty_lookup,details_envelope,
         source_row_envelope,version,created_by_staff_id,created_at,updated_at)
        VALUES ('fin_activity_tus','fib_activity_import','activity-tus','income','tus',
         '2025-01',NULL,34000,34000,'transfer','paid','not_required','sp_activity_julia',
         NULL,NULL,'{}','{}',1,'stf_activity_owner',?,?)`).bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_participants
        (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
         created_at,updated_at)
        VALUES ('acp_activity_date_parity','apg_english','{}',NULL,NULL,'active',1,?,?)`)
        .bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
         specialist_id,appointment_id,counterparty_lookup,details_envelope,
         source_row_envelope,version,created_by_staff_id,created_at,updated_at)
        VALUES ('fin_activity_month_date_drift',NULL,NULL,'income','tus','2025-01',
         '2025-01-15',34000,34000,'transfer','paid','not_required','sp_activity_julia',
         NULL,NULL,'{}',NULL,1,'stf_activity_owner',?,?)`).bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
         specialist_id,appointment_id,counterparty_lookup,details_envelope,
         source_row_envelope,version,created_by_staff_id,created_at,updated_at)
        VALUES ('fin_activity_day_date_drift',NULL,NULL,'income','english','2025-01',
         '2025-01-16',0,0,'transfer','paid','not_required','sp_activity_julia',NULL,NULL,
         '{}',NULL,1,'stf_activity_owner',?,?)`).bind(NOW, NOW),
    ])
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO finance_source_links
        (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
        VALUES ('fsl_activity_tus','wbs_activity_tus','fin_activity_tus','materialized',
         'stf_activity_owner',?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO activity_charges
        (id,participant_id,program_id,group_id,membership_id,period_precision,
         occurred_on,accounting_month,lesson_count,responsible_specialist_id,
         finance_entry_id,status,version,created_at,updated_at)
        VALUES ('ach_activity_tus','acp_migration_tus','apg_tus','agr_migration_tus',
         'amb_migration_observation','month',NULL,'2025-01',NULL,'sp_activity_julia',
         'fin_activity_tus','active',1,?,?)`).bind(NOW, NOW),
    ])
    const dateParityResults = await Promise.allSettled([
      env.DB.prepare(`INSERT INTO activity_charges
        (id,participant_id,program_id,group_id,membership_id,period_precision,
         occurred_on,accounting_month,lesson_count,responsible_specialist_id,
         finance_entry_id,status,version,created_at,updated_at)
        VALUES ('ach_activity_month_date_drift','acp_migration_tus','apg_tus',
         'agr_migration_tus','amb_migration_observation','month',NULL,'2025-01',NULL,
         'sp_activity_julia','fin_activity_month_date_drift','active',1,?,?)`)
        .bind(NOW, NOW).run(),
      env.DB.prepare(`INSERT INTO activity_charges
        (id,participant_id,program_id,group_id,membership_id,period_precision,
         occurred_on,accounting_month,lesson_count,responsible_specialist_id,
         finance_entry_id,status,version,created_at,updated_at)
        VALUES ('ach_activity_day_date_drift','acp_activity_date_parity','apg_english',
         NULL,NULL,'day','2025-01-15','2025-01',1,'sp_activity_julia',
         'fin_activity_day_date_drift','active',1,?,?)`).bind(NOW, NOW).run(),
    ])
    expect(dateParityResults.map(({ status }) => status)).toEqual([
      'rejected', 'rejected',
    ])
    for (const result of dateParityResults) {
      expect(result.reason).toBeInstanceOf(Error)
      expect(result.reason.message).toMatch(/activity_charge_finance_mismatch/)
    }
    await expect(env.DB.prepare(`INSERT INTO activity_source_links
      (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
      VALUES ('asl_activity_charge_early','wbs_activity_tus','charge','ach_activity_tus',
       'stf_activity_owner',?)`).bind(NOW).run())
      .rejects.toThrow(/activity_charge_source_graph_mismatch/)
    await env.DB.prepare(`INSERT INTO activity_source_links
      (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
      VALUES ('asl_activity_participant','wbs_activity_tus','participant',
       'acp_migration_tus','stf_activity_owner',?)`).bind(NOW).run()
    await env.DB.prepare(`INSERT INTO activity_source_links
      (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
      VALUES ('asl_activity_group','wbs_activity_tus','group','agr_migration_tus',
       'stf_activity_owner',?)`).bind(NOW).run()
    await env.DB.prepare(`INSERT INTO activity_source_links
      (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
      VALUES ('asl_activity_membership','wbs_activity_tus','membership_observation',
       'amb_migration_observation','stf_activity_owner',?)`).bind(NOW).run()
    await env.DB.prepare(`INSERT INTO activity_source_links
      (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
      VALUES ('asl_activity_charge','wbs_activity_tus','charge','ach_activity_tus',
       'stf_activity_owner',?)`).bind(NOW).run()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_participants
        (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
         created_at,updated_at)
        VALUES ('acp_migration_wrong','apg_tus','{}',NULL,NULL,'active',1,?,?)`)
        .bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_memberships
        (id,participant_id,program_id,group_id,membership_kind,period_precision,
         observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
        VALUES ('amb_migration_graph','acp_migration_tus','apg_tus','agr_migration_tus',
         'observation','month',NULL,'2025-02',NULL,NULL,'active',1,?,?)`)
        .bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO workbook_source_records
        (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
         disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
         payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
         record_digest,record_digest_hmac_version,specialist_source_digest,
         specialist_source_hmac_version,warning_codes_json,source_payload_version,
         source_payload_envelope,created_at)
        VALUES ('wbs_activity_graph','wbi_activity_import','workbook:v1:0:5:0',0,'TUS',5,0,
         'tus','accepted','2025-02',NULL,'month','2025-02',34000,'transfer','paid',
         'not_required',34000,?,1,?,1,'[]',1,'{}',?)`)
        .bind('L'.repeat(43), 'E'.repeat(43), NOW),
      env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
         specialist_id,appointment_id,counterparty_lookup,details_envelope,
         source_row_envelope,version,created_by_staff_id,created_at,updated_at)
        VALUES ('fin_activity_graph',NULL,NULL,'income','tus','2025-02',NULL,34000,34000,
         'transfer','paid','not_required','sp_activity_julia',NULL,NULL,'{}',NULL,1,
         'stf_activity_owner',?,?)`).bind(NOW, NOW),
    ])
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO finance_source_links
        (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
        VALUES ('fsl_activity_graph','wbs_activity_graph','fin_activity_graph',
         'materialized','stf_activity_owner',?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO activity_charges
        (id,participant_id,program_id,group_id,membership_id,period_precision,
         occurred_on,accounting_month,lesson_count,responsible_specialist_id,
         finance_entry_id,status,version,created_at,updated_at)
        VALUES ('ach_activity_graph','acp_migration_tus','apg_tus','agr_migration_tus',
         'amb_migration_graph','month',NULL,'2025-02',NULL,'sp_activity_julia',
         'fin_activity_graph','active',1,?,?)`).bind(NOW, NOW),
    ])
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_source_links
        (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
        VALUES ('asl_activity_graph_participant','wbs_activity_graph','participant',
         'acp_migration_wrong','stf_activity_owner',?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO activity_source_links
        (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
        VALUES ('asl_activity_graph_group','wbs_activity_graph','group',
         'agr_migration_tus','stf_activity_owner',?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO activity_source_links
        (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
        VALUES ('asl_activity_graph_membership','wbs_activity_graph',
         'membership_observation','amb_migration_graph','stf_activity_owner',?)`)
        .bind(NOW),
    ])
    await expect(env.DB.prepare(`INSERT INTO activity_source_links
      (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
      VALUES ('asl_activity_graph_charge','wbs_activity_graph','charge',
       'ach_activity_graph','stf_activity_owner',?)`).bind(NOW).run())
      .rejects.toThrow(/activity_charge_source_graph_mismatch/)
    await expect(env.DB.prepare(`INSERT INTO activity_source_links
      (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
      VALUES ('asl_activity_charge_two','wbs_activity_tus','charge','ach_activity_tus',
       'stf_activity_owner',?)`).bind(NOW).run()).rejects.toThrow()
    await expect(env.DB.prepare(`INSERT INTO activity_source_links
      (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
      VALUES ('asl_activity_missing','wbs_activity_tus','group','agr_missing_target',
       'stf_activity_owner',?)`).bind(NOW).run())
      .rejects.toThrow(/invalid_activity_group_source/)
    await expect(env.DB.prepare(`UPDATE activity_memberships SET observed_month='2025-02',
      version=2,updated_at=? WHERE id='amb_migration_observation'`).bind(NOW).run())
      .rejects.toThrow(/immutable_imported_activity_membership/)
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_participants
        (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
         created_at,updated_at)
        VALUES ('acp_activity_english','apg_english','{}',NULL,NULL,'active',1,?,?)`)
        .bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
         specialist_id,appointment_id,counterparty_lookup,details_envelope,
         source_row_envelope,version,created_by_staff_id,created_at,updated_at)
        VALUES ('fin_activity_wrong_type',NULL,NULL,'income','tus','2025-01',NULL,
         34000,34000,'transfer','paid','not_required','sp_activity_julia',NULL,NULL,
         '{}',NULL,1,'stf_activity_owner',?,?)`).bind(NOW, NOW),
    ])
    await expect(env.DB.prepare(`INSERT INTO activity_source_links
      (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
      VALUES ('asl_activity_cross_program','wbs_activity_tus','participant',
       'acp_activity_english','stf_activity_owner',?)`).bind(NOW).run())
      .rejects.toThrow(/invalid_activity_participant_source/)
    await expect(env.DB.prepare(`INSERT INTO activity_charges
      (id,participant_id,program_id,group_id,membership_id,period_precision,
       occurred_on,accounting_month,lesson_count,responsible_specialist_id,
       finance_entry_id,status,version,created_at,updated_at)
      VALUES ('ach_activity_wrong_type','acp_activity_english','apg_english',NULL,NULL,
       'month',NULL,'2025-01',0,'sp_activity_julia','fin_activity_wrong_type',
       'active',1,?,?)`).bind(NOW, NOW).run())
      .rejects.toThrow(/activity_charge_finance_mismatch/)
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_source_records
        (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
         disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
         payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
         record_digest,record_digest_hmac_version,specialist_source_digest,
         specialist_source_hmac_version,warning_codes_json,source_payload_version,
         source_payload_envelope,created_at)
        VALUES ('wbs_activity_wrong_mapping','wbi_activity_import','workbook:v1:0:3:0',0,
         'Angielski',3,0,'english','accepted','2025-01',NULL,'month','2025-01',0,
         'transfer','paid','not_required',0,?,1,?,1,'[]',1,'{}',?)`)
        .bind('G'.repeat(43), 'F'.repeat(43), NOW),
      env.DB.prepare(`INSERT INTO workbook_resolutions
        (id,import_id,source_record_id,kind,resolution_code,specialist_id,
         source_value_kind,source_value_digest,source_value_hmac_version,
         source_value_envelope,resolved_by_staff_id,created_at)
        VALUES ('wbr_activity_wrong_mapping','wbi_activity_import',NULL,
         'specialist_mapping','explicit_match','sp_activity_other','explicit_name',?,1,
         '{}','stf_activity_owner',?)`).bind('F'.repeat(43), NOW),
      env.DB.prepare(`INSERT INTO finance_entries
        (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
         amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
         specialist_id,appointment_id,counterparty_lookup,details_envelope,
         source_row_envelope,version,created_by_staff_id,created_at,updated_at)
        VALUES ('fin_activity_wrong_mapping',NULL,NULL,'income','english','2025-01',NULL,
         0,0,'transfer','paid','not_required','sp_activity_julia',NULL,NULL,'{}',NULL,1,
         'stf_activity_owner',?,?)`).bind(NOW, NOW),
    ])
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO finance_source_links
        (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
        VALUES ('fsl_activity_wrong_mapping','wbs_activity_wrong_mapping',
         'fin_activity_wrong_mapping','materialized','stf_activity_owner',?)`).bind(NOW),
      env.DB.prepare(`INSERT INTO activity_charges
        (id,participant_id,program_id,group_id,membership_id,period_precision,
         occurred_on,accounting_month,lesson_count,responsible_specialist_id,
         finance_entry_id,status,version,created_at,updated_at)
        VALUES ('ach_activity_wrong_mapping','acp_activity_english','apg_english',NULL,NULL,
         'month',NULL,'2025-01',0,'sp_activity_julia','fin_activity_wrong_mapping',
         'active',1,?,?)`).bind(NOW, NOW),
    ])
    await expect(env.DB.prepare(`INSERT INTO activity_source_links
      (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
      VALUES ('asl_activity_wrong_mapping','wbs_activity_wrong_mapping','charge',
       'ach_activity_wrong_mapping','stf_activity_owner',?)`).bind(NOW).run())
      .rejects.toThrow(/invalid_activity_charge_source/)
    await expect(env.DB.prepare(`UPDATE finance_entries SET amount_grosze=35000,
      paid_amount_grosze=35000,version=2,updated_at=? WHERE id='fin_activity_tus'`)
      .bind(NOW).run()).rejects.toThrow(/linked_activity_finance_drift/)
    await expect(env.DB.prepare(`UPDATE finance_entries SET specialist_id='sp_activity_other',
      version=2,updated_at=? WHERE id='fin_activity_tus'`).bind(NOW).run())
      .rejects.toThrow(/linked_activity_finance_drift/)
    await expect(env.DB.prepare(`UPDATE finance_entries SET accounting_month='2025-02',
      version=2,updated_at=? WHERE id='fin_activity_tus'`).bind(NOW).run())
      .rejects.toThrow(/linked_activity_finance_drift/)
    await expect(env.DB.prepare(`UPDATE finance_entries SET occurred_on='2025-01-15',
      version=2,updated_at=? WHERE id='fin_activity_tus'`).bind(NOW).run())
      .rejects.toThrow(/linked_activity_finance_drift/)
    await expect(env.DB.prepare(`UPDATE finance_entries SET details_envelope='{"note":"ok"}',
      version=2,updated_at=? WHERE id='fin_activity_tus'`).bind(NOW).run())
      .resolves.toMatchObject({ success: true })
    await expect(env.DB.prepare(`UPDATE finance_source_links
      SET finance_entry_id='fin_activity_wrong_mapping'
      WHERE id='fsl_activity_tus'`).run()).rejects.toThrow(/append_only/)
    await expect(env.DB.prepare(
      `DELETE FROM finance_source_links WHERE id='fsl_activity_tus'`,
    ).run()).rejects.toThrow(/no_routine_delete/)
    await expect(env.DB.prepare(`UPDATE workbook_source_records SET accounting_month='2025-02'
      WHERE id='wbs_activity_tus'`).run()).rejects.toThrow(/immutable_workbook_source_record/)
    await expect(env.DB.prepare(`INSERT INTO finance_entry_voids
      (id,finance_entry_id,workbook_import_id,workbook_source_record_id,reason_code,
       voided_by_staff_id,created_at) VALUES ('fev_activity_tus','fin_activity_tus',
       'wbi_activity_import','wbs_activity_tus','reconciliation','stf_activity_owner',?)`)
      .bind(NOW).run()).rejects.toThrow(/active_activity_charge_finance_void/)
    await env.DB.prepare(`UPDATE activity_charges SET status='inactive',version=2,updated_at=?
      WHERE id='ach_activity_tus'`).bind(NOW).run()
    await env.DB.prepare(`INSERT INTO finance_entry_voids
      (id,finance_entry_id,workbook_import_id,workbook_source_record_id,reason_code,
       voided_by_staff_id,created_at) VALUES ('fev_activity_tus','fin_activity_tus',
       'wbi_activity_import','wbs_activity_tus','reconciliation','stf_activity_owner',?)`)
      .bind(NOW).run()
    await expect(env.DB.prepare(
      `DELETE FROM activity_source_links WHERE id='asl_activity_charge'`,
    ).run()).rejects.toThrow(/append_only/)
  })

  it('keeps imported economic history valid while its operational directory is archived', async () => {
    await env.DB.prepare(`INSERT INTO activity_group_leaders
      (id,group_id,specialist_id,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ('agl_activity_historical','agr_migration_tus','sp_activity_julia',
       '2025-01-01','2025-02-28','inactive',1,?,?)`).bind(NOW, NOW).run()
    await expect(env.DB.prepare(`UPDATE activity_memberships
      SET status='inactive',version=2,updated_at=? WHERE id='amb_migration_graph'`)
      .bind(NOW).run()).resolves.toMatchObject({ success: true })
    await expect(env.DB.prepare(`UPDATE specialists
      SET status='archived',archived_at=?,version=2,updated_at=?
      WHERE id='sp_activity_julia'`).bind(NOW, NOW).run())
      .resolves.toMatchObject({ success: true })
    await expect(env.DB.prepare(`UPDATE activity_participants
      SET status='inactive',version=2,updated_at=? WHERE id='acp_migration_tus'`)
      .bind(NOW).run()).resolves.toMatchObject({ success: true })
    await expect(env.DB.prepare(`UPDATE activity_groups
      SET status='inactive',version=2,updated_at=? WHERE id='agr_migration_tus'`)
      .bind(NOW).run()).resolves.toMatchObject({ success: true })

    expect(await env.DB.prepare(`SELECT charge.status,finance.specialist_id,
      participant.status AS participant_status,activity_group.status AS group_status
      FROM activity_charges AS charge
      JOIN finance_entries AS finance ON finance.id=charge.finance_entry_id
      JOIN activity_participants AS participant ON participant.id=charge.participant_id
      JOIN activity_groups AS activity_group ON activity_group.id=charge.group_id
      WHERE charge.id='ach_activity_graph'`).first()).toEqual({
      status: 'active', specialist_id: 'sp_activity_julia',
      participant_status: 'inactive', group_status: 'inactive',
    })
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM activity_source_links
      WHERE source_record_id='wbs_activity_graph'`).first()).toEqual({ count: 3 })
  })

  it('rejects archival while current native roster or scheduled work remains', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO specialists
        (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
         archived_at,created_at,updated_at)
        VALUES ('sp_activity_lifecycle',NULL,'{}',18000,'active',1,NULL,?,?)`)
        .bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_groups
        (id,program_id,label_envelope,details_envelope,status,version,created_at,updated_at)
        VALUES ('agr_activity_lifecycle','apg_tus','{}',NULL,'active',1,?,?)`)
        .bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_participants
        (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
         created_at,updated_at)
        VALUES ('acp_activity_lifecycle','apg_tus','{}',NULL,NULL,'active',1,?,?)`)
        .bind(NOW, NOW),
    ])
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activity_group_leaders
        (id,group_id,specialist_id,starts_on,ends_on,status,version,created_at,updated_at)
        VALUES ('agl_activity_lifecycle','agr_activity_lifecycle',
         'sp_activity_lifecycle','2027-01-01','2099-12-31','active',1,?,?)`)
        .bind(NOW, NOW),
      env.DB.prepare(`INSERT INTO activity_memberships
        (id,participant_id,program_id,group_id,membership_kind,period_precision,
         observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
        VALUES ('amb_activity_lifecycle','acp_activity_lifecycle','apg_tus',
         'agr_activity_lifecycle','interval','unknown',NULL,NULL,'2027-01-01',
         '2099-12-31','active',1,?,?)`).bind(NOW, NOW),
    ])
    await expect(env.DB.prepare(`UPDATE specialists
      SET status='archived',archived_at=?,version=2,updated_at=?
      WHERE id='sp_activity_lifecycle'`).bind(NOW, NOW).run())
      .rejects.toThrow(/specialist_active_activity_dependents/)
    await expect(env.DB.prepare(`UPDATE activity_participants
      SET status='inactive',version=2,updated_at=? WHERE id='acp_activity_lifecycle'`)
      .bind(NOW).run()).rejects.toThrow(/activity_participant_active_dependents/)
    await expect(env.DB.prepare(`UPDATE activity_groups
      SET status='inactive',version=2,updated_at=? WHERE id='agr_activity_lifecycle'`)
      .bind(NOW).run()).rejects.toThrow(/activity_group_active_dependents/)

    await env.DB.batch([
      env.DB.prepare(`UPDATE activity_group_leaders
        SET ends_on='2027-03-01',status='inactive',version=2,updated_at=?
        WHERE id='agl_activity_lifecycle'`).bind(NOW),
      env.DB.prepare(`UPDATE activity_memberships
        SET ends_on='2027-03-01',status='inactive',version=2,updated_at=?
        WHERE id='amb_activity_lifecycle'`).bind(NOW),
      env.DB.prepare(`INSERT INTO activity_classes
        (id,group_id,occurs_on,wall_time,duration_minutes,topic_envelope,status,
         version,created_at,updated_at)
        VALUES ('acl_activity_lifecycle','agr_activity_lifecycle','2027-03-15',
         NULL,NULL,NULL,'scheduled',1,?,?)`).bind(NOW, NOW),
    ])
    await expect(env.DB.prepare(`UPDATE activity_groups
      SET status='inactive',version=2,updated_at=? WHERE id='agr_activity_lifecycle'`)
      .bind(NOW).run()).rejects.toThrow(/activity_group_active_dependents/)
    await env.DB.prepare(`UPDATE activity_classes
      SET status='cancelled',version=2,updated_at=? WHERE id='acl_activity_lifecycle'`)
      .bind(NOW).run()
    await expect(env.DB.prepare(`UPDATE activity_groups
      SET status='inactive',version=2,updated_at=? WHERE id='agr_activity_lifecycle'`)
      .bind(NOW).run()).resolves.toMatchObject({ success: true })
    await expect(env.DB.prepare(`UPDATE activity_participants
      SET status='inactive',version=2,updated_at=? WHERE id='acp_activity_lifecycle'`)
      .bind(NOW).run()).resolves.toMatchObject({ success: true })
    await expect(env.DB.prepare(`UPDATE specialists
      SET status='archived',archived_at=?,version=2,updated_at=?
      WHERE id='sp_activity_lifecycle'`).bind(NOW, NOW).run())
      .resolves.toMatchObject({ success: true })
  })

  it('binds projection job state and monotonic cursor progress to accepted activity rows', async () => {
    await env.DB.prepare(`INSERT INTO workbook_source_records
      (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
       disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
       payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
       record_digest,record_digest_hmac_version,specialist_source_digest,
       specialist_source_hmac_version,warning_codes_json,source_payload_version,
       source_payload_envelope,created_at)
      VALUES ('wbs_activity_quarantined','wbi_activity_import','workbook:v1:0:9:0',0,
       'TUS',9,0,'tus','quarantined','2025-03',NULL,'month','2025-03',34000,
       'transfer','paid','not_required',34000,?,1,?,1,'[]',1,'{}',?)`)
      .bind('Q'.repeat(43), 'E'.repeat(43), NOW).run()
    const accepted = (await env.DB.prepare(`SELECT id FROM workbook_source_records
      WHERE import_id='wbi_activity_import' AND disposition='accepted'
        AND record_type IN ('tus','english') ORDER BY id`).all()).results
      .map(({ id }) => id)
    expect(accepted).toHaveLength(3)

    await expect(env.DB.prepare(`INSERT INTO activity_projection_jobs
      (id,import_id,status,after_source_record_id,total_records,processed_records,
       projected_records,created_by_staff_id,correlation_id,version,created_at,
       updated_at,completed_at)
      VALUES ('apj_activity_invalid_shape','wbi_activity_import','running',NULL,3,0,0,
       'stf_activity_owner','activity_import_correlation',1,?,?,NULL)`)
      .bind(NOW, NOW).run()).rejects.toThrow()
    await expect(env.DB.prepare(`INSERT INTO activity_projection_jobs
      (id,import_id,status,after_source_record_id,total_records,processed_records,
       projected_records,created_by_staff_id,correlation_id,version,created_at,
       updated_at,completed_at)
      VALUES ('apj_activity_invalid_cursor','wbi_activity_import','running',
       'wbs_activity_quarantined',3,1,1,'stf_activity_owner',
       'activity_import_correlation',1,?,?,NULL)`).bind(NOW, NOW).run())
      .rejects.toThrow(/invalid_activity_projection_cursor/)
    await env.DB.prepare(`INSERT INTO activity_projection_jobs
      (id,import_id,status,after_source_record_id,total_records,processed_records,
       projected_records,created_by_staff_id,correlation_id,version,created_at,
       updated_at,completed_at)
      VALUES ('apj_activity_migration','wbi_activity_import','ready',NULL,3,0,0,
       'stf_activity_owner','activity_import_correlation',1,?,?,NULL)`)
      .bind(NOW, NOW).run()
    await expect(env.DB.prepare(`UPDATE activity_projection_jobs SET status='running',
      after_source_record_id=?,processed_records=1,projected_records=1,version=2,
      updated_at=? WHERE id='apj_activity_migration'`).bind(accepted[1], NOW).run())
      .rejects.toThrow(/invalid_activity_projection_cursor_progress/)
    await env.DB.prepare(`UPDATE activity_projection_jobs SET status='running',
      after_source_record_id=?,processed_records=1,projected_records=1,version=2,
      updated_at=? WHERE id='apj_activity_migration'`).bind(accepted[0], NOW).run()
    await expect(env.DB.prepare(`UPDATE activity_projection_jobs
      SET after_source_record_id=?,processed_records=2,projected_records=2,version=3,
      updated_at=? WHERE id='apj_activity_migration'`).bind(accepted[2], NOW).run())
      .rejects.toThrow(/invalid_activity_projection_cursor_progress/)
    await env.DB.prepare(`UPDATE activity_projection_jobs
      SET after_source_record_id=?,processed_records=2,projected_records=2,version=3,
      updated_at=? WHERE id='apj_activity_migration'`).bind(accepted[1], NOW).run()
    await env.DB.prepare(`UPDATE activity_projection_jobs SET status='complete',
      after_source_record_id=?,processed_records=3,projected_records=3,version=4,
      updated_at=?,completed_at=? WHERE id='apj_activity_migration'`)
      .bind(accepted[2], NOW, NOW).run()
    await expect(env.DB.prepare(`UPDATE activity_projection_jobs
      SET version=5,updated_at=? WHERE id='apj_activity_migration'`).bind(NOW).run())
      .rejects.toThrow(/terminal_activity_projection_job/)
  })
})
