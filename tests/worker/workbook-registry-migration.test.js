import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW = '2027-01-15T10:00:00.000Z'
const OWNER_ID = 'stf_workbook_registry_owner'

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
  OWNER_ID, 'workbook_registry_owner_lookup', '{}', '{}', 'owner', 'active',
  'workbook-registry-owner-subject', null, 1, NOW, null, NOW, NOW)
  await run(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
     archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
  'sp_registry_julia', null, '{}', 18000, 'active', 1, null, NOW, NOW)
})

describe('workbook source registry migration', () => {
  it('creates the exact additive registry, quarantine, job, and finance provenance tables', async () => {
    const rows = (await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND (
         name LIKE 'workbook_%' OR name IN ('finance_entry_voids','finance_source_links')
       ) ORDER BY name`,
    ).all()).results

    expect(rows.map(({ name }) => name)).toEqual([
      'finance_entry_voids',
      'finance_source_links',
      'workbook_artifacts',
      'workbook_finance_candidates',
      'workbook_finance_decisions',
      'workbook_import_plans',
      'workbook_imports',
      'workbook_materialization_jobs',
      'workbook_quarantine_records',
      'workbook_request_replays',
      'workbook_resolutions',
      'workbook_source_records',
      'workbook_templates',
    ])
    expect((await env.DB.prepare(
      'PRAGMA table_info(workbook_materialization_jobs)',
    ).all()).results.find(({ name }) => name === 'summary_json')).toMatchObject({ notnull: 0 })
    expect((await env.DB.prepare(
      'PRAGMA table_info(workbook_materialization_jobs)',
    ).all()).results.find(({ name }) => name === 'progress_json')).toMatchObject({ notnull: 1 })
    expect((await env.DB.prepare(
      'PRAGMA table_info(finance_adjustments)',
    ).all()).results.find(({ name }) => name === 'workbook_import_id')).toMatchObject({
      notnull: 0,
    })
    expect((await env.DB.prepare(
      'PRAGMA table_info(finance_entry_voids)',
    ).all()).results.find(({ name }) => name === 'workbook_import_id')).toMatchObject({
      notnull: 1,
    })
    const sourceColumns = (await env.DB.prepare(
      'PRAGMA table_info(workbook_source_records)',
    ).all()).results
    expect(sourceColumns.find(({ name }) => name === 'period_precision')).toMatchObject({
      notnull: 1,
    })
    expect(sourceColumns.find(({ name }) => name === 'period_month')).toMatchObject({
      notnull: 0,
    })
    expect((await env.DB.prepare(
      'PRAGMA table_info(workbook_imports)',
    ).all()).results.find(({ name }) => name === 'correlation_id')).toMatchObject({
      notnull: 1,
    })
  })

  it('keeps artifact/source/template identity immutable and finance links one-to-one', async () => {
    await run(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,
       materializer_version,object_key,content_nonce_b64,workbook_kek_version,
       metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wba_registry_one', 'centre_1', 'staging', 'a'.repeat(64), 4096, 2, 2,
    'workbook-objects/wbo_registry_one_opaque', 'A'.repeat(16), 1, 1, 'B'.repeat(43),
    OWNER_ID, NOW)
    await run(`INSERT INTO workbook_templates
      (id,artifact_id,format,source_kind,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?)`,
    'wbt_registry_one', 'wba_registry_one', 'legacy', 'approved_import', OWNER_ID, NOW)
    await run(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbi_registry_one', 'wba_registry_one', 'C'.repeat(43), 'ready', 1, 0,
    'corr_workbook_registry_one', OWNER_ID, 1, NOW, NOW, null)
    await run(`INSERT INTO workbook_source_records
      (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
       record_type,disposition,accounting_month,occurred_on,period_precision,
       period_month,amount_grosze,
       payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
       record_digest,record_digest_hmac_version,specialist_source_digest,
       specialist_source_hmac_version,warning_codes_json,source_payload_version,
       source_payload_envelope,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbs_registry_one', 'wbi_registry_one', 'workbook:v1:0:2:0', 0, 'Wrzesień',
    2, 0, 'income', 'accepted', '2025-09', '2025-09-02', 'day', '2025-09', 18000,
    'card', 'paid', 'not_required', 18000,
    'D'.repeat(43), 1, 'F'.repeat(43), 1, '[]', 1,
    '{"algorithm":"A256GCM","ciphertext":"opaque","dataKeyId":"key_workbook_registry","dataKeyVersion":1,"format":1,"nonce":"AAAAAAAAAAAAAAAA"}',
    NOW)

    await expect(run(
      `UPDATE workbook_artifacts SET object_key=? WHERE id='wba_registry_one'`,
      'workbook-objects/wbo_replaced',
    )).rejects.toThrow()
    await expect(run(
      `UPDATE workbook_templates SET format='panel-v2' WHERE id='wbt_registry_one'`,
    )).rejects.toThrow()
    await expect(run(
      `DELETE FROM workbook_source_records WHERE id='wbs_registry_one'`,
    )).rejects.toThrow()
    await expect(run(
      `UPDATE workbook_imports SET correlation_id=?,version=2 WHERE id='wbi_registry_one'`,
      'corr_workbook_registry_replaced',
    )).rejects.toThrow(/immutable_workbook_import_identity/)

    await run(`INSERT INTO finance_import_batches
      (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
       created_by_staff_id,version,created_at,updated_at,committed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fib_registry_one', 'e'.repeat(64), '{}', 1, 1, 1, 'committed', OWNER_ID,
    1, NOW, NOW, NOW)
    await run(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,
       created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fin_registry_one', 'fib_registry_one', 'safe-registry-source', 'income', 'income',
    '2025-09', '2025-09-02', 18000, 18000, 'card', 'paid', 'not_required', null,
    null, null, '{}', '{}', 1, OWNER_ID, NOW, NOW)
    await run(`INSERT INTO finance_source_links
      (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?)`,
    'fsl_registry_one', 'wbs_registry_one', 'fin_registry_one', 'reconciled', OWNER_ID, NOW)
    await expect(run(`INSERT INTO finance_source_links
      (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?)`,
    'fsl_registry_duplicate', 'wbs_registry_one', 'fin_registry_one', 'materialized',
    OWNER_ID, NOW)).rejects.toThrow()
  })

  it('retains an encrypted D1-authoritative source payload and binds each specialist resolution to one source value', async () => {
    const sourceColumns = (await env.DB.prepare('PRAGMA table_info(workbook_source_records)').all()).results
    expect(sourceColumns.filter(({ name }) => name.startsWith('source_payload')).map(({ name }) => name))
      .toEqual(['source_payload_version', 'source_payload_envelope'])
    expect(sourceColumns.find(({ name }) => name === 'record_digest_hmac_version')).toMatchObject({
      notnull: 1,
    })
    expect(sourceColumns.find(({ name }) => name === 'specialist_source_digest')).toMatchObject({
      notnull: 1,
    })
    expect(sourceColumns.find(({ name }) => name === 'specialist_source_hmac_version'))
      .toMatchObject({ notnull: 1 })
    expect(sourceColumns.filter(({ name }) => [
      'initial_paid_amount_grosze', 'invoice_status', 'payment_method', 'settlement_status',
    ].includes(name)).map(({ name, notnull }) => ({ name, notnull }))).toEqual([
      { name: 'payment_method', notnull: 0 },
      { name: 'settlement_status', notnull: 0 },
      { name: 'invoice_status', notnull: 0 },
      { name: 'initial_paid_amount_grosze', notnull: 0 },
    ])

    await run(`INSERT INTO workbook_resolutions
      (id,import_id,source_record_id,kind,resolution_code,specialist_id,
       source_value_kind,source_value_digest,source_value_hmac_version,source_value_envelope,
       resolved_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbr_registry_mapping', 'wbi_registry_one', null, 'specialist_mapping',
    'blank_assigned_to_julia', 'sp_registry_julia', 'blank', 'E'.repeat(43), 1,
    '{"algorithm":"A256GCM","ciphertext":"opaque","dataKeyId":"key_workbook_registry","dataKeyVersion":1,"format":1,"nonce":"AAAAAAAAAAAAAAAA"}',
    OWNER_ID, NOW)
    await expect(run(`INSERT INTO workbook_resolutions
      (id,import_id,source_record_id,kind,resolution_code,specialist_id,
       source_value_kind,source_value_digest,source_value_hmac_version,source_value_envelope,
       resolved_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbr_registry_mapping_duplicate', 'wbi_registry_one', null, 'specialist_mapping',
    'blank_assigned_to_julia', 'sp_registry_julia', 'blank', 'E'.repeat(43), 1,
    '{"algorithm":"A256GCM","ciphertext":"other","dataKeyId":"key_workbook_registry","dataKeyVersion":1,"format":1,"nonce":"AAAAAAAAAAAAAAAA"}',
    OWNER_ID, NOW)).rejects.toThrow()

    const stored = await env.DB.prepare(
      `SELECT source_value_kind,source_value_digest,source_value_hmac_version,
              source_value_envelope
       FROM workbook_resolutions WHERE id='wbr_registry_mapping'`,
    ).first()
    expect(stored.source_value_kind).toBe('blank')
    expect(stored.source_value_digest).toBe('E'.repeat(43))
    expect(stored.source_value_hmac_version).toBe(1)
    expect(stored.source_value_envelope).not.toContain('Julia')
  })

  it('backstops one-way import/job state and monotonic phase cursors in D1', async () => {
    await run(`INSERT INTO workbook_materialization_jobs
      (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
       summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbj_registry_state', 'wbi_registry_one', 'index_finance', 'ready', 0, 0, 0,
    '{}', null, OWNER_ID, 1, NOW, NOW, null)
    await run(`UPDATE workbook_materialization_jobs
      SET status='running',cursor=1,total_records=2,processed_records=1,version=2
      WHERE id='wbj_registry_state'`)

    await expect(run(`UPDATE workbook_materialization_jobs
      SET cursor=0,processed_records=0,version=3 WHERE id='wbj_registry_state'`))
      .rejects.toThrow(/invalid_workbook_job_progress/)
    await expect(run(`UPDATE workbook_materialization_jobs
      SET phase='apply_finance',cursor=0,processed_records=0,version=3
      WHERE id='wbj_registry_state'`)).rejects.toThrow(/invalid_workbook_job_progress/)
    await expect(run(`UPDATE workbook_materialization_jobs
      SET cursor=2,processed_records=1,version=3 WHERE id='wbj_registry_state'`))
      .rejects.toThrow(/invalid_workbook_job_progress/)

    await run(`UPDATE workbook_materialization_jobs
      SET status='failed',version=3 WHERE id='wbj_registry_state'`)
    await expect(run(`UPDATE workbook_materialization_jobs
      SET status='ready',version=4 WHERE id='wbj_registry_state'`))
      .rejects.toThrow(/invalid_workbook_job_status_transition/)

    await run(`UPDATE workbook_imports
      SET status='complete',version=2,updated_at=?,completed_at=?
      WHERE id='wbi_registry_one'`, NOW, NOW)
    await expect(run(`UPDATE workbook_imports
      SET status='ready',version=3,updated_at=?,completed_at=NULL
      WHERE id='wbi_registry_one'`, NOW)).rejects.toThrow(/invalid_workbook_import_transition/)
  })

  it('rejects an accepted source record without a canonical amount', async () => {
    await expect(run(`INSERT INTO workbook_source_records
      (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
       record_type,disposition,accounting_month,occurred_on,period_precision,
       period_month,amount_grosze,payment_method,settlement_status,invoice_status,
       initial_paid_amount_grosze,record_digest,record_digest_hmac_version,
       specialist_source_digest,specialist_source_hmac_version,warning_codes_json,
       source_payload_version,source_payload_envelope,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbs_registry_null_amount', 'wbi_registry_one', 'workbook:v1:0:99:0', 0,
    'Wrzesień', 99, 0, 'income', 'accepted', null, null, 'unknown', null, null,
    'unknown', 'unknown', 'unknown', 0, 'G'.repeat(43), 1, 'H'.repeat(43), 1,
    '[]', 1, '{}', NOW)).rejects.toThrow(/CHECK constraint failed/)
  })

  it('discriminates specialist mapping resolution codes from quarantine outcomes', async () => {
    const insertResolution = (...values) => run(`INSERT INTO workbook_resolutions
      (id,import_id,source_record_id,kind,resolution_code,specialist_id,
       source_value_kind,source_value_digest,source_value_hmac_version,
       source_value_envelope,resolved_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ...values)
    await expect(insertResolution(
      'wbr_registry_bad_mapping', 'wbi_registry_one', null, 'specialist_mapping',
      'accepted', 'sp_registry_julia', 'blank', 'J'.repeat(43), 1, '{}', OWNER_ID, NOW,
    )).rejects.toThrow(/CHECK constraint failed/)
    await expect(insertResolution(
      'wbr_registry_wrong_explicit_code', 'wbi_registry_one', null, 'specialist_mapping',
      'blank_assigned_to_julia', 'sp_registry_julia', 'explicit_name',
      'P'.repeat(43), 1, '{}', OWNER_ID, NOW,
    )).rejects.toThrow(/CHECK constraint failed/)
    await expect(insertResolution(
      'wbr_registry_wrong_blank_code', 'wbi_registry_one', null, 'specialist_mapping',
      'explicit_match', 'sp_registry_julia', 'blank', 'Q'.repeat(43), 1, '{}',
      OWNER_ID, NOW,
    )).rejects.toThrow(/CHECK constraint failed/)
    await expect(insertResolution(
      'wbr_registry_mapping_with_source', 'wbi_registry_one', 'wbs_registry_one',
      'specialist_mapping', 'blank_assigned_to_julia', 'sp_registry_julia', 'blank',
      'R'.repeat(43), 1, '{}', OWNER_ID, NOW,
    )).rejects.toThrow(/CHECK constraint failed/)
  })

  it('allows quarantine metadata only for a quarantined source record', async () => {
    await expect(run(`INSERT INTO workbook_quarantine_records
      (id,source_record_id,primary_reason,reason_codes_json,created_at)
      VALUES (?,?,?,?,?)`,
    'wbq_registry_accepted', 'wbs_registry_one', 'SERVICE_DATE_MISSING',
    '["SERVICE_DATE_MISSING"]', NOW)).rejects.toThrow(/invalid_quarantine_source/)
  })

  it('binds quarantine resolutions to a quarantined source in the same import', async () => {
    await run(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,
       materializer_version,object_key,content_nonce_b64,workbook_kek_version,
       metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wba_registry_two', 'centre_1', 'staging', 'b'.repeat(64), 1024, 2, 2,
    'workbook-objects/wbo_registry_two_opaque', 'K'.repeat(16), 1, 1,
    'L'.repeat(43), OWNER_ID, NOW)
    await run(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbi_registry_two', 'wba_registry_two', 'M'.repeat(43), 'ready', 0, 1,
    'corr_workbook_registry_two', OWNER_ID, 1, NOW, NOW, null)
    await run(`INSERT INTO workbook_source_records
      (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
       record_type,disposition,accounting_month,occurred_on,period_precision,
       period_month,amount_grosze,payment_method,settlement_status,invoice_status,
       initial_paid_amount_grosze,record_digest,record_digest_hmac_version,
       specialist_source_digest,specialist_source_hmac_version,warning_codes_json,
       source_payload_version,source_payload_envelope,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbs_registry_quarantined', 'wbi_registry_one', 'workbook:v1:0:100:0', 0,
    'Wrzesień', 100, 0, 'income', 'quarantined', null, null, 'unknown', null, null,
    null, null, null, null, 'N'.repeat(43), 1, 'O'.repeat(43), 1,
    '["SERVICE_DATE_MISSING"]', 1, '{}', NOW)

    await expect(run(`INSERT INTO workbook_resolutions
      (id,import_id,source_record_id,kind,resolution_code,specialist_id,
       source_value_kind,source_value_digest,source_value_hmac_version,
       source_value_envelope,resolved_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbr_registry_quarantine_with_mapping', 'wbi_registry_one',
    'wbs_registry_quarantined', 'quarantine_resolution', 'accepted',
    'sp_registry_julia', null, null, null, null, OWNER_ID, NOW))
      .rejects.toThrow(/CHECK constraint failed/)
    await expect(run(`INSERT INTO workbook_resolutions
      (id,import_id,source_record_id,kind,resolution_code,specialist_id,
       source_value_kind,source_value_digest,source_value_hmac_version,
       source_value_envelope,resolved_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbr_registry_wrong_import', 'wbi_registry_two', 'wbs_registry_quarantined',
    'quarantine_resolution', 'accepted', null, null, null, null, null, OWNER_ID, NOW))
      .rejects.toThrow(/invalid_quarantine_resolution_source/)
    await expect(run(`INSERT INTO workbook_resolutions
      (id,import_id,source_record_id,kind,resolution_code,specialist_id,
       source_value_kind,source_value_digest,source_value_hmac_version,
       source_value_envelope,resolved_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbr_registry_accepted_source', 'wbi_registry_one', 'wbs_registry_one',
    'quarantine_resolution', 'rejected', null, null, null, null, null, OWNER_ID, NOW))
      .rejects.toThrow(/invalid_quarantine_resolution_source/)
    await run(`INSERT INTO workbook_resolutions
      (id,import_id,source_record_id,kind,resolution_code,specialist_id,
       source_value_kind,source_value_digest,source_value_hmac_version,
       source_value_envelope,resolved_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbr_registry_quarantined', 'wbi_registry_one', 'wbs_registry_quarantined',
    'quarantine_resolution', 'rejected', null, null, null, null, null, OWNER_ID, NOW)
  })

  it('allows finance provenance links only from accepted source records', async () => {
    await run(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,
       created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'fin_registry_quarantined', 'fib_registry_one', 'safe-registry-quarantine',
    'income', 'income', null, null, 1, 0, 'unknown', 'unknown', 'unknown', null,
    null, null, '{}', '{}', 1, OWNER_ID, NOW, NOW)

    await expect(run(`INSERT INTO finance_source_links
      (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?)`,
    'fsl_registry_quarantined', 'wbs_registry_quarantined',
    'fin_registry_quarantined', 'materialized', OWNER_ID, NOW))
      .rejects.toThrow(/invalid_finance_source_link/)
  })
})
