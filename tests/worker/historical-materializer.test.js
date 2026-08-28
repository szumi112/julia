import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  continueHistoricalProjection,
  getHistoricalProjection,
  resolveHistoricalConflict,
} from '../../worker/core/historical-materializer.js'
import { activateHistoricalClient } from '../../worker/core/historical-clients.js'
import { buildHistoricalIdentity } from '../../worker/core/historical-crypto.js'
import { parseWorkspaceQuery, readWorkspace } from '../../worker/core/workspace.js'
import { encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  createD1QueryBudget,
  usageForD1QueryBudgetViews,
} from '../../worker/db/query-budget.js'
import {
  digestWorkbookSourcePayload,
  digestWorkbookSourceValue,
} from '../../worker/security/workbook-artifacts.js'
import {
  loadAuthenticatedWorkbookSpecialistMappings,
  loadWorkbookSourceDataKey,
  openAuthenticatedWorkbookSource,
  resolveAuthenticatedWorkbookSpecialist,
  WORKBOOK_SOURCE_SCOPE,
} from '../../worker/core/workbook-source-registry.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2027-03-02T08:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const IMPORT_ID = 'wbi_historical_materializer'
const CONFLICT_IMPORT_ID = 'wbi_historical_conflict'
const CORRELATION = 'historical_projection_original'
const actor = authorityActor({ id: 'stf_historical_materializer', role: 'owner' })
const config = Object.freeze({
  appEnv: 'staging', dataMode: 'fictional', activeDataKekVersion: 1,
  activeLookupKeyVersion: 1, activeWorkbookKekVersion: 1,
  activeWorkbookHmacVersion: 1,
})
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
let keyring
let serial = 0
const idFactory = () => `historical_${++serial}`

const sealSource = async (dataKey, recordId, field, value) => JSON.stringify(
  await encryptForScope(keyring, dataKey, {
    expectedScope: WORKBOOK_SOURCE_SCOPE, recordId, field,
    plaintext: JSON.stringify(value),
  }),
)

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  keyring = await createKeyring({
    BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V1: key(2),
    BWM_WORKBOOK_KEK_V1: key(3), BWM_WORKBOOK_HMAC_V1: key(4),
  }, config)
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,'active',?,NULL,1,?,NULL,?,?)`).bind(
    actor.id, 'historical_materializer_lookup', '{}', '{}', 'owner',
    'historical-materializer-subject', NOW, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
     archived_at,created_at,updated_at)
    VALUES ('sp_historical_materializer',NULL,'{}',18000,'active',1,NULL,?,?)`)
    .bind(NOW, NOW).run()
  await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
     archived_at,created_at,updated_at)
    VALUES ('sp_historical_other',NULL,'{}',18000,'active',1,NULL,?,?)`)
    .bind(NOW, NOW).run()
  for (const suffix of ['activation', 'broken', 'disabled']) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO staff_users
        (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
         specialist_id,version,activated_at,disabled_at,created_at,updated_at)
        VALUES (?,?, '{}','{}','specialist','active',?,?,1,?,NULL,?,?)`).bind(
        `stf_historical_${suffix}`, `historical_${suffix}_lookup`,
        `historical-${suffix}-subject`, `sp_historical_${suffix}`, NOW, NOW, NOW,
      ),
      env.DB.prepare(`INSERT INTO specialists
        (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
         archived_at,created_at,updated_at)
        VALUES (?,?, '{}',18000,'active',1,NULL,?,?)`).bind(
        `sp_historical_${suffix}`, `stf_historical_${suffix}`, NOW, NOW,
      ),
      env.DB.prepare(`INSERT INTO record_versions
        (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
         changed_at,correlation_id) VALUES (?,'specialist',?,1,'{}',NULL,?,?)`).bind(
        `ver_historical_${suffix}`, `sp_historical_${suffix}`, NOW, CORRELATION,
      ),
    ])
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE staff_users SET specialist_id='sp_historical_broken_backlink',
      version=2,updated_at=? WHERE id='stf_historical_broken'`).bind(NOW),
    env.DB.prepare(`UPDATE staff_users SET status='disabled',disabled_at=?,version=2,
      updated_at=? WHERE id='stf_historical_disabled'`).bind(NOW, NOW),
  ])
  await env.DB.prepare(`INSERT INTO workbook_artifacts
    (id,centre_id,environment,fingerprint,byte_size,parser_version,materializer_version,
     object_key,content_nonce_b64,workbook_kek_version,metadata_hmac_version,
     metadata_signature,created_by_staff_id,created_at)
    VALUES ('wba_historical_materializer','centre_1','staging',?,4096,2,2,
      'workbook-objects/wbo_historical_materializer','AAAAAAAAAAAAAAAA',1,1,?,?,?)`).bind(
    'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
    'A'.repeat(43), actor.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_artifacts
    (id,centre_id,environment,fingerprint,byte_size,parser_version,materializer_version,
     object_key,content_nonce_b64,workbook_kek_version,metadata_hmac_version,
     metadata_signature,created_by_staff_id,created_at)
    VALUES ('wba_historical_conflict','centre_1','staging',?,4096,2,2,
      'workbook-objects/wbo_historical_conflict','BBBBBBBBBBBBBBBB',1,1,?,?,?)`).bind(
    'e4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99b',
    'E'.repeat(43), actor.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_imports
    (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
     correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES (?,'wba_historical_materializer',?,'complete',2,0,?,?,2,?,?,?)`).bind(
    IMPORT_ID, 'B'.repeat(43), CORRELATION, actor.id, NOW, NOW, NOW,
  ).run()
  const sourceKey = await getOrCreateDataKey(env.DB, keyring, WORKBOOK_SOURCE_SCOPE, {
    id: 'key_historical_source_registry', createdAt: NOW,
  })
  await env.DB.prepare(`INSERT INTO workbook_import_plans
    (import_id,workbook_kind,plan_version,plan_envelope,created_at)
    VALUES (?,'legacy',1,?,?)`).bind(
    IMPORT_ID, await sealSource(sourceKey, IMPORT_ID, 'materialization_plan', {
      schema: 'workbook_import_plan.v1',
    }), NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_materialization_jobs
    (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
     summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES ('wbj_historical_materializer',?,'complete','complete',2,2,2,'{}','{}',
      ?,2,?,?,?)`).bind(IMPORT_ID, actor.id, NOW, NOW, NOW).run()
  const normalized = Object.freeze({
    sourceKey: 'workbook:v1:0:2:0', sheet: 'Styczeń 2025', rowNumber: 2,
    recordType: 'income', accountingMonth: '2025-01', occurredOn: '2025-01-15',
    periodPrecision: 'day', periodMonth: '2025-01', amountGrosze: 18000,
    counterparty: 'Ola Fikcyjna', sourceLabel: 'Zajęcia psychologiczne',
    paymentMethod: 'cash', settlementStatus: 'paid', invoiceStatus: 'not_required',
    invoiceNote: '', specialistName: null, lessonCount: null, warningCodes: [],
  })
  const payload = Object.freeze({
    schema: 'workbook_source_payload.v1', normalized, raw: Object.freeze({ Cena: 180 }),
  })
  const sourceDigest = await digestWorkbookSourcePayload({
    keyring, config, centreId: 'centre_1', sourceKey: normalized.sourceKey, payload,
  })
  const specialistDigest = await digestWorkbookSourceValue({
    keyring, config, centreId: 'centre_1', sourceValueKind: 'blank', sourceValue: '',
  })
  await env.DB.prepare(`INSERT INTO workbook_source_records
    (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
     disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
     payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
     record_digest,record_digest_hmac_version,specialist_source_digest,
     specialist_source_hmac_version,warning_codes_json,source_payload_version,
     source_payload_envelope,created_at)
    VALUES ('wbs_historical_materializer',?,?,0,'Styczeń 2025',2,0,'income','accepted',
      '2025-01','2025-01-15','day','2025-01',18000,'cash','paid','not_required',18000,
      ?,1,?,1,'[]',1,?,?)`).bind(
    IMPORT_ID, normalized.sourceKey, sourceDigest.digest, specialistDigest.digest,
    await sealSource(sourceKey, 'wbs_historical_materializer', 'source_payload', payload), NOW,
  ).run()
  const secondNormalized = Object.freeze({
    ...normalized,
    sourceKey: 'workbook:v1:0:3:0', rowNumber: 3, occurredOn: '2025-01-16',
    counterparty: 'Maja Fikcyjna',
  })
  const secondPayload = Object.freeze({
    schema: 'workbook_source_payload.v1', normalized: secondNormalized,
    raw: Object.freeze({ Cena: 180 }),
  })
  const secondDigest = await digestWorkbookSourcePayload({
    keyring, config, centreId: 'centre_1', sourceKey: secondNormalized.sourceKey,
    payload: secondPayload,
  })
  await env.DB.prepare(`INSERT INTO workbook_source_records
    (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
     disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
     payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
     record_digest,record_digest_hmac_version,specialist_source_digest,
     specialist_source_hmac_version,warning_codes_json,source_payload_version,
     source_payload_envelope,created_at)
    VALUES ('wbs_historical_materializer_two',?,?,0,'Styczeń 2025',3,0,'income','accepted',
      '2025-01','2025-01-16','day','2025-01',18000,'cash','paid','not_required',18000,
      ?,1,?,1,'[]',1,?,?)`).bind(
    IMPORT_ID, secondNormalized.sourceKey, secondDigest.digest, specialistDigest.digest,
    await sealSource(sourceKey, 'wbs_historical_materializer_two', 'source_payload',
      secondPayload), NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_resolutions
    (id,import_id,source_record_id,kind,resolution_code,specialist_id,
     source_value_kind,source_value_digest,source_value_hmac_version,
     source_value_envelope,resolved_by_staff_id,created_at)
    VALUES ('wbr_historical_materializer',?,NULL,'specialist_mapping',
      'blank_assigned_to_julia','sp_historical_materializer','blank',?,1,?,?,?)`).bind(
    IMPORT_ID, specialistDigest.digest,
    await sealSource(sourceKey, 'wbr_historical_materializer', 'source_value', {
      schema: 'workbook_specialist_source.v1', sourceValue: '',
    }), actor.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_import_batches
    (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
     created_by_staff_id,version,created_at,updated_at,committed_at)
    VALUES ('fib_historical_materializer',?,'{}',1,2,2,'committed',?,1,?,?,?)`).bind(
    'c'.repeat(64), actor.id, NOW, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
     specialist_id,appointment_id,counterparty_lookup,details_envelope,
     source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES ('fin_historical_materializer','fib_historical_materializer','source-historical',
      'income','income','2025-01','2025-01-15',18000,18000,'cash','paid','not_required',
      'sp_historical_materializer',NULL,NULL,'{}','{}',1,?,?,?)`).bind(
    actor.id, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_source_links
    (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
    VALUES ('fsl_historical_materializer','wbs_historical_materializer',
      'fin_historical_materializer','materialized',?,?)`).bind(actor.id, NOW).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
     specialist_id,appointment_id,counterparty_lookup,details_envelope,
     source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES ('fin_historical_materializer_two','fib_historical_materializer','source-historical-two',
      'income','income','2025-01','2025-01-16',18000,18000,'cash','paid','not_required',
      'sp_historical_materializer',NULL,NULL,'{}','{}',1,?,?,?)`).bind(
    actor.id, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_source_links
    (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
    VALUES ('fsl_historical_materializer_two','wbs_historical_materializer_two',
      'fin_historical_materializer_two','materialized',?,?)`).bind(actor.id, NOW).run()

  await env.DB.prepare(`INSERT INTO workbook_imports
    (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
     correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES (?,'wba_historical_conflict',?,'complete',1,0,?,?,2,?,?,?)`).bind(
    CONFLICT_IMPORT_ID, 'D'.repeat(43), 'historical_conflict_original', actor.id,
    NOW, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_import_plans
    (import_id,workbook_kind,plan_version,plan_envelope,created_at)
    VALUES (?,'legacy',1,?,?)`).bind(
    CONFLICT_IMPORT_ID, await sealSource(
      sourceKey, CONFLICT_IMPORT_ID, 'materialization_plan', {
        schema: 'workbook_import_plan.v1',
      },
    ), NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_materialization_jobs
    (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
     summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES ('wbj_historical_conflict',?,'complete','complete',1,1,1,'{}','{}',
      ?,2,?,?,?)`).bind(CONFLICT_IMPORT_ID, actor.id, NOW, NOW, NOW).run()
  const conflictNormalized = Object.freeze({
    ...normalized,
    sourceKey: 'workbook:v1:0:4:0', rowNumber: 4, occurredOn: null,
    periodPrecision: 'unknown', periodMonth: null, counterparty: 'Pacjent',
  })
  const conflictPayload = Object.freeze({
    schema: 'workbook_source_payload.v1', normalized: conflictNormalized,
    raw: Object.freeze({ Cena: 180 }),
  })
  const conflictDigest = await digestWorkbookSourcePayload({
    keyring, config, centreId: 'centre_1', sourceKey: conflictNormalized.sourceKey,
    payload: conflictPayload,
  })
  await env.DB.prepare(`INSERT INTO workbook_source_records
    (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
     disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
     payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
     record_digest,record_digest_hmac_version,specialist_source_digest,
     specialist_source_hmac_version,warning_codes_json,source_payload_version,
     source_payload_envelope,created_at)
    VALUES ('wbs_historical_conflict',?,?,0,'Styczeń 2025',4,0,'income','accepted',
      '2025-01',NULL,'unknown',NULL,18000,'cash','paid','not_required',18000,
      ?,1,?,1,'[]',1,?,?)`).bind(
    CONFLICT_IMPORT_ID, conflictNormalized.sourceKey, conflictDigest.digest,
    specialistDigest.digest,
    await sealSource(sourceKey, 'wbs_historical_conflict', 'source_payload', conflictPayload),
    NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_resolutions
    (id,import_id,source_record_id,kind,resolution_code,specialist_id,
     source_value_kind,source_value_digest,source_value_hmac_version,
     source_value_envelope,resolved_by_staff_id,created_at)
    VALUES ('wbr_historical_conflict',?,NULL,'specialist_mapping',
      'blank_assigned_to_julia','sp_historical_materializer','blank',?,1,?,?,?)`).bind(
    CONFLICT_IMPORT_ID, specialistDigest.digest,
    await sealSource(sourceKey, 'wbr_historical_conflict', 'source_value', {
      schema: 'workbook_specialist_source.v1', sourceValue: '',
    }), actor.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_import_batches
    (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
     created_by_staff_id,version,created_at,updated_at,committed_at)
    VALUES ('fib_historical_conflict',?,'{}',1,1,1,'committed',?,1,?,?,?)`).bind(
    'd'.repeat(64), actor.id, NOW, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
     specialist_id,appointment_id,counterparty_lookup,details_envelope,
     source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES ('fin_historical_conflict','fib_historical_conflict','source-historical-conflict',
      'income','income','2025-01',NULL,18000,18000,'cash','paid','not_required',
      'sp_historical_materializer',NULL,NULL,'{}','{}',1,?,?,?)`).bind(
    actor.id, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_source_links
    (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
    VALUES ('fsl_historical_conflict','wbs_historical_conflict',
      'fin_historical_conflict','materialized',?,?)`).bind(actor.id, NOW).run()
})

describe('historical projection materializer', () => {
  it('bounds specialist mapping reads before materializing a corrupt result set', async () => {
    let sql = null
    let bindings = null
    const db = {
      prepare(value) {
        sql = value
        return {
          bind(...values) {
            bindings = values
            return {
              async all() { return { results: Array.from({ length: 101 }, () => ({})) } },
            }
          },
        }
      },
    }

    await expect(loadAuthenticatedWorkbookSpecialistMappings({
      db, keyring: {}, dataKey: {}, importId: 'wbi_bounded_mappings',
      config: {}, centreId: 'centre_1',
    })).rejects.toThrow(/CRYPTO_FAILURE/)
    expect(sql).toMatch(/LIMIT \?$/)
    expect(bindings).toEqual(['wbi_bounded_mappings', 101])
  })

  it('creates, projects, and completes a creator/correlation-bound idempotent job', async () => {
    const command = (expectedVersion, idempotencyKey, db = env.DB) => ({
      db, actor, keyring, config, centreId: 'centre_1', importId: IMPORT_ID,
      expectedVersion, idempotencyKey, idFactory, nowMs: NOW_MS,
      correlationId: 'caller_must_not_override',
    })
    const [created, concurrentCreate] = await Promise.all([
      continueHistoricalProjection(command(0, 'historical-create-0001')),
      continueHistoricalProjection(command(0, 'historical-create-0001')),
    ])
    expect(concurrentCreate).toEqual(created)
    expect(created).toMatchObject({ status: 201, body: { data: { projection: {
      status: 'ready', totalRecords: 2, version: 1,
    } } } })
    const createReplay = await continueHistoricalProjection(
      command(0, 'historical-create-0001'),
    )
    expect(createReplay).toEqual({ status: 200, body: created.body })
    await env.DB.prepare(`UPDATE finance_entries SET specialist_id='sp_historical_other',
      version=2,updated_at=? WHERE id='fin_historical_materializer'`).bind(NOW).run()
    await expect(continueHistoricalProjection(command(1, 'historical-mismatch-0001')))
      .rejects.toThrow(/CRYPTO_FAILURE/)
    await env.DB.prepare(`UPDATE finance_entries SET specialist_id='sp_historical_materializer',
      version=3,updated_at=? WHERE id='fin_historical_materializer'`).bind(NOW).run()
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const projected = await continueHistoricalProjection(command(
      1, 'historical-project-0001', budget.work,
    ))
    expect(projected.body.data.projection).toMatchObject({
      status: 'running', processedRecords: 2, projectedRecords: 2, version: 2,
    })
    const projectionUsage = usageForD1QueryBudgetViews(budget.work, budget.recovery)
    expect(projectionUsage).toEqual({
      used: 28, remaining: 22, workRemaining: 14,
      totalLimit: 50, recoveryReserve: 8,
    })
    await expect(continueHistoricalProjection(command(1, 'historical-project-0001')))
      .resolves.toEqual(projected)
    const completed = await continueHistoricalProjection(command(2, 'historical-complete-0001'))
    expect(completed.body.data.projection).toMatchObject({
      status: 'complete', processedRecords: 2, projectedRecords: 2, version: 3,
    })
    await expect(continueHistoricalProjection(
      command(2, 'historical-complete-stale-0001'),
    )).rejects.toThrow(/VERSION_CONFLICT/)
    const occurrence = await env.DB.prepare(
      `SELECT period_precision,occurred_on,occurred_month,historical_client_id,
              counterparty_id,service_id FROM historical_service_occurrences`,
    ).first()
    expect(occurrence).toEqual({
      period_precision: 'day', occurred_on: '2025-01-15', occurred_month: '2025-01',
      historical_client_id: expect.stringMatching(/^hcl_/), counterparty_id: null,
      service_id: 'zajecia',
    })
    const historical = await env.DB.prepare(
      `SELECT identity_envelope FROM historical_clients`,
    ).first()
    expect(historical.identity_envelope).not.toContain('Ola')
    const versions = (await env.DB.prepare(
      `SELECT entity_type,correlation_id FROM record_versions
       WHERE entity_type LIKE 'historical_%' ORDER BY entity_type`,
    ).all()).results
    expect(versions).toEqual([
      { entity_type: 'historical_client', correlation_id: CORRELATION },
      { entity_type: 'historical_client', correlation_id: CORRELATION },
      { entity_type: 'historical_service_occurrence', correlation_id: CORRELATION },
      { entity_type: 'historical_service_occurrence', correlation_id: CORRELATION },
    ])
    await expect(getHistoricalProjection({ db: env.DB, actor, importId: IMPORT_ID }))
      .resolves.toMatchObject({ data: { projection: { status: 'complete' } } })
  })

  it('normalizes a different-key continuation CAS loser to VERSION_CONFLICT', async () => {
    const importId = 'wbi_historical_cas_race'
    const plan = await env.DB.prepare(
      `SELECT plan_envelope FROM workbook_import_plans WHERE import_id=?`,
    ).bind(IMPORT_ID).first()
    const sourceKey = await loadWorkbookSourceDataKey(env.DB, plan.plan_envelope)
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_artifacts
        (id,centre_id,environment,fingerprint,byte_size,parser_version,materializer_version,
         object_key,content_nonce_b64,workbook_kek_version,metadata_hmac_version,
         metadata_signature,created_by_staff_id,created_at)
        VALUES ('wba_historical_cas_race','centre_1','staging',?,4096,2,2,
          'workbook-objects/wbo_historical_cas_race','CCCCCCCCCCCCCCCC',1,1,?,?,?)`).bind(
        'a4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99c',
        'F'.repeat(43), actor.id, NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_imports
        (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
         correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,'wba_historical_cas_race',?,'complete',0,0,
          'historical_cas_race',?,2,?,?,?)`).bind(
        importId, 'G'.repeat(43), actor.id, NOW, NOW, NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_import_plans
        (import_id,workbook_kind,plan_version,plan_envelope,created_at)
        VALUES (?,'legacy',1,?,?)`).bind(
        importId, await sealSource(sourceKey, importId, 'materialization_plan', {
          schema: 'workbook_import_plan.v1',
        }), NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_materialization_jobs
        (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
         summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES ('wbj_historical_cas_race',?,'complete','complete',0,0,0,'{}','{}',
          ?,2,?,?,?)`).bind(importId, actor.id, NOW, NOW, NOW),
    ])
    const input = (db, expectedVersion, idempotencyKey) => ({
      db, actor, keyring, config, centreId: 'centre_1', importId,
      expectedVersion, idempotencyKey, idFactory, nowMs: NOW_MS,
    })
    await continueHistoricalProjection(input(
      env.DB, 0, 'historical-cas-create-0001',
    ))

    let arrivals = 0
    let release
    const barrier = new Promise((resolve) => { release = resolve })
    const racingDb = () => Object.freeze({
      prepare: (...args) => env.DB.prepare(...args),
      batch: async (statements) => {
        arrivals += 1
        if (arrivals === 2) release()
        await barrier
        return env.DB.batch(statements)
      },
    })
    const results = await Promise.allSettled([
      continueHistoricalProjection(input(
        racingDb(), 1, 'historical-cas-winner-a-0001',
      )),
      continueHistoricalProjection(input(
        racingDb(), 1, 'historical-cas-winner-b-0001',
      )),
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(({ status }) => status === 'rejected')
    expect(rejected?.reason).toEqual(new Error('VERSION_CONFLICT'))
  })

  it('backfills lookup aliases before retiring an old key and never duplicates the subject', async () => {
    const overlapConfig = Object.freeze({ ...config, activeLookupKeyVersion: 2 })
    const overlapKeyring = await createKeyring({
      BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V1: key(2),
      BWM_LOOKUP_HMAC_V2: key(5), BWM_WORKBOOK_KEK_V1: key(3),
      BWM_WORKBOOK_HMAC_V1: key(4),
    }, overlapConfig)
    const retiredKeyring = await createKeyring({
      BWM_DATA_KEK_V1: key(1), BWM_LOOKUP_HMAC_V2: key(5),
      BWM_WORKBOOK_KEK_V1: key(3), BWM_WORKBOOK_HMAC_V1: key(4),
    }, overlapConfig)
    const identity = await buildHistoricalIdentity(env.DB, keyring, {
      kind: 'person', id: 'hcl_rotation_one', dataKeyId: 'key_historical_rotation_one',
      name: 'Rotacyjna Osoba', createdAt: NOW,
    })
    await env.DB.batch([
      identity.keyStatement,
      env.DB.prepare(`INSERT INTO historical_clients
        (id,identity_envelope,status,active_client_id,version,created_at,updated_at)
        VALUES ('hcl_rotation_one',?,'historical',NULL,1,?,?)`).bind(
        identity.identityEnvelope, NOW, NOW,
      ),
      env.DB.prepare(`INSERT INTO historical_client_lookup_aliases
        (historical_client_id,domain,hmac_version,lookup_digest,created_at)
        VALUES ('hcl_rotation_one',?,?,?,?)`).bind(
        identity.lookups[0].domain, identity.lookups[0].version,
        identity.lookups[0].digest, NOW,
      ),
    ])
    const plan = await env.DB.prepare(
      `SELECT plan_envelope FROM workbook_import_plans WHERE import_id=?`,
    ).bind(IMPORT_ID).first()
    const sourceKey = await loadWorkbookSourceDataKey(env.DB, plan.plan_envelope)
    const seedImport = async (suffix, rowNumber) => {
      const importId = `wbi_historical_rotation_${suffix}`
      const sourceRecordId = `wbs_historical_rotation_${suffix}`
      const normalized = Object.freeze({
        sourceKey: `workbook:v1:1:${rowNumber}:0`, sheet: 'Styczeń 2025', rowNumber,
        recordType: 'income', accountingMonth: '2025-01',
        occurredOn: `2025-01-${rowNumber}`, periodPrecision: 'day',
        periodMonth: '2025-01', amountGrosze: 18000,
        counterparty: 'Rotacyjna Osoba', sourceLabel: 'Zajęcia psychologiczne',
        paymentMethod: 'cash', settlementStatus: 'paid', invoiceStatus: 'not_required',
        invoiceNote: '', specialistName: null, lessonCount: null, warningCodes: [],
      })
      const payload = Object.freeze({
        schema: 'workbook_source_payload.v1', normalized, raw: Object.freeze({ Cena: 180 }),
      })
      const sourceDigest = await digestWorkbookSourcePayload({
        keyring: overlapKeyring, config: overlapConfig, centreId: 'centre_1',
        sourceKey: normalized.sourceKey, payload,
      })
      const specialistDigest = await digestWorkbookSourceValue({
        keyring: overlapKeyring, config: overlapConfig, centreId: 'centre_1',
        sourceValueKind: 'blank', sourceValue: '',
      })
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO workbook_artifacts
          (id,centre_id,environment,fingerprint,byte_size,parser_version,
           materializer_version,object_key,content_nonce_b64,workbook_kek_version,
           metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
          VALUES (?,'centre_1','staging',?,4096,2,2,?,
            'DDDDDDDDDDDDDDDD',1,1,?,?,?)`).bind(
          `wba_historical_rotation_${suffix}`, suffix === 'overlap' ? 'b'.repeat(64) : 'c'.repeat(64),
          `workbook-objects/wbo_historical_rotation_${suffix}`, 'H'.repeat(43), actor.id, NOW,
        ),
        env.DB.prepare(`INSERT INTO workbook_imports
          (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
           correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
          VALUES (?,?,?,'complete',1,0,?,?,2,?,?,?)`).bind(
          importId, `wba_historical_rotation_${suffix}`,
          (suffix === 'overlap' ? 'I' : 'J').repeat(43),
          `historical_rotation_${suffix}`, actor.id, NOW, NOW, NOW,
        ),
        env.DB.prepare(`INSERT INTO workbook_import_plans
          (import_id,workbook_kind,plan_version,plan_envelope,created_at)
          VALUES (?,'legacy',1,?,?)`).bind(
          importId, await sealSource(sourceKey, importId, 'materialization_plan', {
            schema: 'workbook_import_plan.v1',
          }), NOW,
        ),
        env.DB.prepare(`INSERT INTO workbook_materialization_jobs
          (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
           summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
          VALUES (? ,?,'complete','complete',1,1,1,'{}','{}',?,2,?,?,?)`).bind(
          `wbj_historical_rotation_${suffix}`, importId, actor.id, NOW, NOW, NOW,
        ),
        env.DB.prepare(`INSERT INTO workbook_source_records
          (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
           disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
           payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
           record_digest,record_digest_hmac_version,specialist_source_digest,
           specialist_source_hmac_version,warning_codes_json,source_payload_version,
           source_payload_envelope,created_at)
          VALUES (?,?,?,1,'Styczeń 2025',?,0,'income','accepted','2025-01',?,
            'day','2025-01',18000,'cash','paid','not_required',18000,?,1,?,1,
            '[]',1,?,?)`).bind(
          sourceRecordId, importId, normalized.sourceKey, rowNumber, normalized.occurredOn,
          sourceDigest.digest, specialistDigest.digest,
          await sealSource(sourceKey, sourceRecordId, 'source_payload', payload), NOW,
        ),
        env.DB.prepare(`INSERT INTO workbook_resolutions
          (id,import_id,source_record_id,kind,resolution_code,specialist_id,
           source_value_kind,source_value_digest,source_value_hmac_version,
           source_value_envelope,resolved_by_staff_id,created_at)
          VALUES (?, ?,NULL,'specialist_mapping','blank_assigned_to_julia',
            'sp_historical_materializer','blank',?,1,?,?,?)`).bind(
          `wbr_historical_rotation_${suffix}`, importId, specialistDigest.digest,
          await sealSource(sourceKey, `wbr_historical_rotation_${suffix}`, 'source_value', {
            schema: 'workbook_specialist_source.v1', sourceValue: '',
          }), actor.id, NOW,
        ),
        env.DB.prepare(`INSERT INTO finance_import_batches
          (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
           created_by_staff_id,version,created_at,updated_at,committed_at)
          VALUES (?,?,'{}',1,1,1,'committed',?,1,?,?,?)`).bind(
          `fib_historical_rotation_${suffix}`,
          suffix === 'overlap' ? 'f'.repeat(64) : '9'.repeat(64), actor.id, NOW, NOW, NOW,
        ),
        env.DB.prepare(`INSERT INTO finance_entries
          (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
           amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
           specialist_id,appointment_id,counterparty_lookup,details_envelope,
           source_row_envelope,version,created_by_staff_id,created_at,updated_at)
          VALUES (?,?,?,'income','income','2025-01',?,18000,18000,'cash','paid',
            'not_required','sp_historical_materializer',NULL,NULL,'{}','{}',1,?,?,?)`).bind(
          `fin_historical_rotation_${suffix}`, `fib_historical_rotation_${suffix}`,
          `source-historical-rotation-${suffix}`, normalized.occurredOn, actor.id, NOW, NOW,
        ),
        env.DB.prepare(`INSERT INTO finance_source_links
          (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
          VALUES (?,?,?,'materialized',?,?)`).bind(
          `fsl_historical_rotation_${suffix}`, sourceRecordId,
          `fin_historical_rotation_${suffix}`, actor.id, NOW,
        ),
      ])
      return { importId, sourceRecordId }
    }
    const project = async ({ importId }, projectionKeyring, projectionConfig, prefix) => {
      const input = (expectedVersion, idempotencyKey) => ({
        db: env.DB, actor, keyring: projectionKeyring, config: projectionConfig,
        centreId: 'centre_1', importId, expectedVersion, idempotencyKey,
        idFactory, nowMs: NOW_MS,
      })
      await continueHistoricalProjection(input(0, `${prefix}-create-0001`))
      await continueHistoricalProjection(input(1, `${prefix}-project-0001`))
      await continueHistoricalProjection(input(2, `${prefix}-complete-0001`))
    }

    const overlap = await seedImport('overlap', 17)
    await project(overlap, overlapKeyring, overlapConfig, 'historical-rotation-overlap')
    expect(await env.DB.prepare(`SELECT historical_client_id FROM
      historical_client_lookup_aliases WHERE hmac_version=2
      AND historical_client_id='hcl_rotation_one'`).first()).toEqual({
      historical_client_id: 'hcl_rotation_one',
    })
    const retired = await seedImport('retired', 18)
    await project(retired, retiredKeyring, overlapConfig, 'historical-rotation-retired')
    expect((await env.DB.prepare(`SELECT historical_client_id,source_record_id
      FROM historical_client_source_links WHERE source_record_id IN (?,?)
      ORDER BY source_record_id`).bind(overlap.sourceRecordId, retired.sourceRecordId)
      .all()).results).toEqual([
      { historical_client_id: 'hcl_rotation_one', source_record_id: overlap.sourceRecordId },
      { historical_client_id: 'hcl_rotation_one', source_record_id: retired.sourceRecordId },
    ])
  })

  it('binds the source row specialist digest and version to the decrypted mapping', async () => {
    const plan = await env.DB.prepare(
      `SELECT plan_envelope FROM workbook_import_plans WHERE import_id=?`,
    ).bind(IMPORT_ID).first()
    const dataKey = await loadWorkbookSourceDataKey(env.DB, plan.plan_envelope)
    const mappings = await loadAuthenticatedWorkbookSpecialistMappings({
      db: env.DB, keyring, dataKey, importId: IMPORT_ID, config, centreId: 'centre_1',
    })
    const row = await env.DB.prepare(`SELECT id AS source_record_id,source_key,sheet_name,
      row_number,record_type,occurred_on,period_precision,period_month,record_digest,
      record_digest_hmac_version,specialist_source_digest,specialist_source_hmac_version,
      source_payload_envelope FROM workbook_source_records
      WHERE id='wbs_historical_materializer'`).first()
    const payload = await openAuthenticatedWorkbookSource({
      keyring, dataKey, row, config, centreId: 'centre_1',
    })
    await expect(resolveAuthenticatedWorkbookSpecialist({
      keyring, config, centreId: 'centre_1', mappings, row, payload,
    })).resolves.toBe('sp_historical_materializer')
    await expect(resolveAuthenticatedWorkbookSpecialist({
      keyring, config, centreId: 'centre_1', mappings,
      row: { ...row, specialist_source_digest: 'Z'.repeat(43) }, payload,
    })).rejects.toThrow(/CRYPTO_FAILURE/)
    await expect(resolveAuthenticatedWorkbookSpecialist({
      keyring, config, centreId: 'centre_1', mappings,
      row: { ...row, specialist_source_hmac_version: 2 }, payload,
    })).rejects.toThrow(/CRYPTO_FAILURE/)
    await expect(openAuthenticatedWorkbookSource({
      keyring, dataKey, config, centreId: 'centre_1',
      row: { ...row, occurred_on: '2025-01-16' },
    })).rejects.toThrow(/CRYPTO_FAILURE/)
  })

  it('returns only authenticated unresolved conflict context from its creator-bound status', async () => {
    const command = (expectedVersion, idempotencyKey) => ({
      db: env.DB, actor, keyring, config, centreId: 'centre_1',
      importId: CONFLICT_IMPORT_ID, expectedVersion, idempotencyKey,
      idFactory, nowMs: NOW_MS,
    })
    await continueHistoricalProjection(command(0, 'historical-conflict-create-0001'))
    const blocked = await continueHistoricalProjection(
      command(1, 'historical-conflict-project-0001'),
    )
    expect(blocked.body.data.projection).toMatchObject({
      status: 'conflicts', processedRecords: 1, projectedRecords: 0,
      conflictCount: 1, version: 2,
    })
    const status = await getHistoricalProjection({
      db: env.DB, actor, keyring, config, centreId: 'centre_1',
      importId: CONFLICT_IMPORT_ID,
    })
    expect(status.data.conflicts).toEqual([{
      id: expect.stringMatching(/^hcf_/),
      sourceRecordId: 'wbs_historical_conflict',
      kind: 'classification',
      context: {
        counterparty: 'Pacjent',
        serviceLabel: 'Zajęcia psychologiczne',
        proposedClassification: 'review',
        proposedServiceId: 'zajecia',
        nearSubjectIds: [],
      },
    }])
    const conflictId = status.data.conflicts[0].id
    const resolution = {
      ...command(2, 'historical-conflict-resolve-0001'),
      body: {
        expectedJobVersion: 2, conflictId, classification: 'person',
        existingSubjectId: null, serviceId: null,
      },
    }
    const [resolved, concurrentResolution] = await Promise.all([
      resolveHistoricalConflict(resolution), resolveHistoricalConflict(resolution),
    ])
    expect(concurrentResolution).toEqual(resolved)
    expect(resolved).toMatchObject({ status: 201, body: { data: { projection: {
      status: 'running', version: 3,
    } } } })
    const replayed = await resolveHistoricalConflict(resolution)
    expect(replayed).toEqual({ status: 200, body: resolved.body })
    await expect(resolveHistoricalConflict({
      ...resolution,
      idempotencyKey: 'historical-conflict-resolve-0002',
    })).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await getHistoricalProjection({
      db: env.DB, actor, keyring, importId: CONFLICT_IMPORT_ID,
    })).data.conflicts).toEqual([])
    const materialized = await continueHistoricalProjection(
      command(3, 'historical-conflict-after-resolution-0001'),
    )
    expect(materialized.body.data.projection).toMatchObject({
      status: 'running', projectedRecords: 1, version: 4,
    })
    await continueHistoricalProjection(command(4, 'historical-conflict-complete-0001'))
    expect(await env.DB.prepare(`SELECT service_id FROM historical_service_occurrences
      WHERE source_record_id='wbs_historical_conflict'`).first()).toEqual({ service_id: null })
  })

  it('activates once with immutable provenance, exact replay, versions, and audit', async () => {
    const historical = await env.DB.prepare(
      `SELECT historical.id,historical.version FROM historical_clients AS historical
       JOIN historical_client_source_links AS source
         ON source.historical_client_id=historical.id
       WHERE historical.status='historical'
         AND source.source_record_id='wbs_historical_materializer'`,
    ).first()
    const input = {
      db: env.DB, actor, keyring, historicalClientId: historical.id,
      body: { expectedVersion: historical.version, specialistId: 'sp_historical_activation' },
      idempotencyKey: 'historical-activate-0001', correlationId: 'activation_request',
      idFactory, nowMs: NOW_MS,
    }
    for (const specialistId of [
      'sp_historical_materializer', 'sp_historical_broken', 'sp_historical_disabled',
    ]) {
      await expect(activateHistoricalClient({
        ...input,
        body: { ...input.body, specialistId },
        idempotencyKey: `historical-reject-${specialistId}-0001`,
      })).rejects.toThrow(/NOT_FOUND/)
    }
    const activated = await activateHistoricalClient(input)
    expect(activated).toMatchObject({ status: 201, body: { data: {
      historicalClient: { id: historical.id, status: 'activated', version: 2 },
      client: { id: expect.stringMatching(/^cl_/), name: 'Ola Fikcyjna', age: null,
        status: 'active', version: 1 },
    } } })
    await expect(activateHistoricalClient(input)).resolves.toEqual(activated)
    await expect(activateHistoricalClient({
      ...input, idempotencyKey: 'historical-activate-0002',
    })).rejects.toThrow(/VERSION_CONFLICT/)
    const sources = (await env.DB.prepare(
      `SELECT source_record_id FROM historical_client_source_links
       WHERE historical_client_id=?`,
    ).bind(historical.id).all()).results
    expect(sources).toEqual([{ source_record_id: 'wbs_historical_materializer' }])
    const audit = await env.DB.prepare(`SELECT action,entity_id,metadata_json
      FROM audit_events WHERE action='historical_client.activated'`).first()
    expect(audit).toMatchObject({ action: 'historical_client.activated', entity_id: historical.id })
    expect(JSON.parse(audit.metadata_json)).toEqual({
      activeClientId: activated.body.data.client.id,
      activeClientVersion: 1,
      assignmentId: activated.body.data.client.assignment.id,
      assignmentVersion: 1,
      historicalClientVersion: 2,
    })
  })

  it('reads encrypted historical occurrences in D1 scope before revealing activation links', async () => {
    const window = parseWorkspaceQuery(
      'https://panel.example/api/v1/workspace?from=2025-01-01&to=2025-01-31',
    )
    const read = (scopedActor) => {
      const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
      return readWorkspace({
        db: budget.work,
        actor: scopedActor,
        cryptoContext: { keyring, dataKey: {}, scope: {} },
        window,
        decryptSpecialist: async ({ recordId }) => `Fikcyjna ${recordId}`,
        decryptClient: async () => ({ name: 'Aktywna Fikcyjna', age: null }),
      })
    }
    const ownerWorkspace = await read(actor)
    expect(ownerWorkspace.data.historicalOccurrences.map(({ sourceRecordId }) => (
      sourceRecordId
    ))).toEqual([
      'wbs_historical_materializer',
      'wbs_historical_materializer_two',
      'wbs_historical_rotation_overlap',
      'wbs_historical_rotation_retired',
      'wbs_historical_conflict',
    ])
    expect(ownerWorkspace.data.latestPopulatedMonth).toBe('2025-01')
    expect(ownerWorkspace.data.historicalClients.find(({ status }) => status === 'activated'))
      .toMatchObject({ activeClientId: expect.stringMatching(/^cl_/) })

    const specialistWorkspace = await read(authorityActor({
      id: actor.id, role: 'specialist', specialistId: 'sp_historical_materializer',
    }))
    expect(specialistWorkspace.data.historicalOccurrences).toHaveLength(5)
    expect(specialistWorkspace.data.historicalClients.find(({ status }) => status === 'activated'))
      .toMatchObject({ activeClientId: null })

    const otherWorkspace = await read(authorityActor({
      id: actor.id, role: 'specialist', specialistId: 'sp_historical_other',
    }))
    expect(otherWorkspace.data.historicalClients).toEqual([])
    expect(otherWorkspace.data.historicalOccurrences).toEqual([])
    expect(otherWorkspace.data.latestPopulatedMonth).toBeNull()
  })
})
