import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  loadWorkbookRegistry,
  loadWorkbookRegistryDetail,
  recordWorkbookExport,
  recordWorkbookResolutions,
} from '../../worker/core/workbook-registry.js'
import { loadWorkbookSpecialistLabels } from '../../worker/core/workbook-specialist-options.js'
import { continueWorkbookImport } from '../../worker/core/workbooks.js'
import {
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { digestWorkbookSourcePayload } from '../../worker/security/workbook-artifacts.js'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
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
const OWNER = authorityActor({ id: 'stf_workbook_registry_owner', role: 'owner' })
const OTHER_OWNER = authorityActor({ id: 'stf_workbook_registry_other', role: 'owner' })
const CORRELATION_ID = '00000000-0000-4000-8000-000000000221'
const PLAN_DIGEST = `v1_${'P'.repeat(43)}`
const SOURCE_SCOPE = Object.freeze({
  type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
})
const IDENTITY_SCOPE = Object.freeze({
  type: 'staff_directory', id: 'centre_1', purpose: 'identity',
})
let keyring
let registryDataKey

const authorityRevokedAfter = (allowedChecks, { loseBatchResponse = false } = {}) => {
  let checks = 0
  return Object.freeze({
    prepare(sql) {
      if (sql.includes('SELECT staff.id,authority.revision FROM staff_users AS staff')) {
        checks += 1
        if (checks > allowedChecks) return {
          bind() { return this },
          async first() { return null },
        }
      }
      return env.DB.prepare(sql)
    },
    async batch(statements) {
      const result = await env.DB.batch(statements)
      if (loseBatchResponse) throw new Error('LOST_BATCH_RESPONSE')
      return result
    },
  })
}

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    OWNER.id, 'workbook_registry_owner_lookup', '{}', '{}', 'owner', 'active',
    'workbook-registry-owner-subject', null, 1, NOW, null, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    OTHER_OWNER.id, 'workbook_registry_other_lookup', '{}', '{}', 'owner', 'active',
    'workbook-registry-other-subject', null, 1, NOW, null, NOW, NOW,
  ).run()
  keyring = await createKeyring(env, {
    activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
  })
  const sourceKey = await getOrCreateDataKey(env.DB, keyring, SOURCE_SCOPE, {
    id: 'key_workbook_registry_source', createdAt: NOW,
  })
  registryDataKey = sourceKey
  const identityKey = await getOrCreateDataKey(env.DB, keyring, IDENTITY_SCOPE, {
    id: 'key_workbook_registry_identity', createdAt: NOW,
  })
  const specialistNameEnvelope = JSON.stringify(await encryptForScope(
    keyring, identityKey, {
      expectedScope: IDENTITY_SCOPE, recordId: 'sp_workbook_registry_resolution',
      field: 'display_name', plaintext: 'Anna Rejestrowa',
    },
  ))
  const archivedSpecialistNameEnvelope = JSON.stringify(await encryptForScope(
    keyring, identityKey, {
      expectedScope: IDENTITY_SCOPE, recordId: 'sp_workbook_registry_archived',
      field: 'display_name', plaintext: 'Barbara Archiwalna',
    },
  ))
  const planEnvelope = JSON.stringify(await encryptForScope(keyring, sourceKey, {
    expectedScope: SOURCE_SCOPE, recordId: 'wbi_workbook_registry',
    field: 'materialization_plan', plaintext: JSON.stringify({
      schema: 'workbook_import_plan.v1', workbookKind: 'legacy',
      previewPlanDigest: PLAN_DIGEST, panel: null,
      conflicts: [{ id: 'wmc_conflict_fictional_1',
        code: 'SPECIALIST_MAPPING_REQUIRED', kind: 'specialist_mapping',
        sourceValue: 'Fikcyjna specjalistka' }],
    }),
  }))
  await env.DB.prepare(`INSERT INTO workbook_artifacts
    (id,centre_id,environment,fingerprint,byte_size,parser_version,
     materializer_version,object_key,content_nonce_b64,workbook_kek_version,
     metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'wba_workbook_registry', 'centre_1', 'staging', '4'.repeat(64), 4096, 2, 2,
    'workbook-objects/wbo_workbook_registry', 'A'.repeat(16), 1, 1,
    'B'.repeat(43), OWNER.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_imports
    (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
     correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'wbi_workbook_registry', 'wba_workbook_registry', 'C'.repeat(43), 'conflicts',
    3, 1, 'corr_workbook_registry', OWNER.id, 2, NOW, NOW, null,
  ).run()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workbook_import_plans
      (import_id,workbook_kind,plan_version,plan_envelope,created_at)
      VALUES (?,?,?,?,?)`).bind(
      'wbi_workbook_registry', 'legacy', 1, planEnvelope, NOW,
    ),
    env.DB.prepare(`INSERT INTO workbook_import_plan_summaries
      (import_id,mapping_conflict_count) VALUES (?,?)`).bind(
      'wbi_workbook_registry', 1,
    ),
  ])
  await env.DB.prepare(`INSERT INTO workbook_materialization_jobs
    (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
     summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'wbj_workbook_registry', 'wbi_workbook_registry', 'index_finance', 'ready',
    0, 4, 0, '{}', null, OWNER.id, 1, NOW, NOW, null,
  ).run()
  await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,professional_title_envelope,
     standard_rate_grosze,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
    'sp_workbook_registry_resolution', null, specialistNameEnvelope, '{}',
    18_000, 'active', 1,
    null, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,professional_title_envelope,
     standard_rate_grosze,status,version,archived_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
    'sp_workbook_registry_archived', null, archivedSpecialistNameEnvelope, '{}',
    18_000, 'archived', 1, NOW, NOW, NOW,
  ).run()
  for (const [suffix, rowNumber, disposition] of [
    ['accepted_a', 2, 'accepted'],
    ['accepted_duplicate', 3, 'accepted'],
    ['quarantined', 4, 'quarantined'],
  ]) {
    const sourceRecordId = `wbs_registry_${suffix}`
    const payload = {
      schema: 'workbook_source_payload.v1',
      normalized: {
        sourceKey: `workbook:v1:0:${rowNumber}:0`, sheet: 'Fikcyjny arkusz',
        rowNumber, recordType: 'income', accountingMonth: '2027-06',
        occurredOn: '2027-06-15', periodPrecision: 'day',
        periodMonth: '2027-06', amountGrosze: disposition === 'accepted' ? 18_000 : null,
        paymentMethod: disposition === 'accepted' ? 'unknown' : null,
        settlementStatus: disposition === 'accepted' ? 'unpaid' : null,
        invoiceStatus: disposition === 'accepted' ? 'not_required' : null,
        specialistName: 'Fikcyjna specjalistka',
        unexpectedSecret: 'EXTRA_NORMALIZED_SENTINEL',
      },
      raw: { Sekret: 'EXTRA_RAW_SENTINEL' },
    }
    const sourcePayloadEnvelope = JSON.stringify(await encryptForScope(
      keyring, sourceKey, {
        expectedScope: SOURCE_SCOPE, recordId: sourceRecordId,
        field: 'source_payload', plaintext: JSON.stringify(payload),
      },
    ))
    const provenance = await digestWorkbookSourcePayload({
      keyring, config: { appEnv: 'staging', activeWorkbookHmacVersion: 1 },
      centreId: 'centre_1',
      sourceKey: payload.normalized.sourceKey, payload,
    })
    await env.DB.prepare(`INSERT INTO workbook_source_records
    (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
     record_type,disposition,accounting_month,occurred_on,period_precision,
     period_month,amount_grosze,payment_method,settlement_status,invoice_status,
     initial_paid_amount_grosze,record_digest,record_digest_hmac_version,
     specialist_source_digest,specialist_source_hmac_version,warning_codes_json,
     source_payload_version,source_payload_envelope,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    sourceRecordId, 'wbi_workbook_registry',
    `workbook:v1:0:${rowNumber}:0`, 0, 'Fikcyjny arkusz', rowNumber, 0, 'income',
    disposition, '2027-06', '2027-06-15', 'day', '2027-06',
    disposition === 'accepted' ? 18_000 : null,
    disposition === 'accepted' ? 'unknown' : null,
    disposition === 'accepted' ? 'unpaid' : null,
    disposition === 'accepted' ? 'not_required' : null,
    disposition === 'accepted' ? 0 : null,
    provenance.digest, provenance.hmacVersion, 'F'.repeat(43), 1, '[]', 1,
    sourcePayloadEnvelope, NOW,
  ).run()
  }
  await env.DB.prepare(`INSERT INTO workbook_quarantine_records
    (id,source_record_id,primary_reason,reason_codes_json,created_at)
    VALUES (?,?,?,?,?)`).bind(
    'wbq_workbook_registry', 'wbs_registry_quarantined', 'MISSING_AMOUNT',
    '["MISSING_AMOUNT"]', NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fin_workbook_registry', null, null, 'income', 'income', '2027-06',
    '2027-06-15', 18_000, 0, 'unknown', 'unpaid', 'not_required', null, null,
    null, '{}', null, 1, OWNER.id, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_source_links
    (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?)`).bind(
    'fsl_workbook_registry', 'wbs_registry_accepted_a', 'fin_workbook_registry',
    'materialized', OWNER.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fin_workbook_registry_unlinked_unknown', null, null, 'income', 'income', null,
    null, 8_000, 0, 'unknown', 'unpaid', 'not_required', null, null,
    null, '{}', null, 1, OWNER.id,
    '2027-06-14T09:59:59.000Z', '2027-06-14T09:59:59.000Z',
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fin_workbook_registry_unknown', null, null, 'income', 'income', null,
    null, 12_000, 0, 'unknown', 'unpaid', 'not_required', null, null,
    null, '{}', null, 1, OWNER.id, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_source_links
    (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?)`).bind(
    'fsl_workbook_registry_unknown', 'wbs_registry_accepted_duplicate',
    'fin_workbook_registry_unknown', 'materialized', OWNER.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_artifacts
    (id,centre_id,environment,fingerprint,byte_size,parser_version,
     materializer_version,object_key,content_nonce_b64,workbook_kek_version,
     metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'wba_workbook_registry_other', 'centre_1', 'staging', '5'.repeat(64), 2048,
    2, 2, 'workbook-objects/wbo_workbook_registry_other', 'A'.repeat(16), 1, 1,
    'B'.repeat(43), OTHER_OWNER.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO workbook_imports
    (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
     correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'wbi_workbook_registry_other', 'wba_workbook_registry_other', 'G'.repeat(43),
    'ready', 0, 0, 'corr_workbook_registry_other', OTHER_OWNER.id, 1,
    NOW, NOW, null,
  ).run()
})

describe('bounded centre-readable workbook registry authority', () => {
  it('resolves an exact encrypted archived specialist label for immutable history', async () => {
    await expect(loadWorkbookSpecialistLabels({
      db: env.DB, keyring, ids: ['sp_workbook_registry_archived'],
    })).resolves.toEqual([{
      id: 'sp_workbook_registry_archived', label: 'Barbara Archiwalna',
    }])
  })
  it('records creator-bound contiguous resolutions with replay and audit', async () => {
    const values = ['workbook_registry_resolutions', 'workbook_registry_resolution_audit']
    const command = {
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: () => values.shift(),
      importId: 'wbi_workbook_registry', expectedVersion: 0,
      planDigest: PLAN_DIGEST,
      resolutions: [{
        conflictId: 'wmc_conflict_fictional_1',
        specialistId: 'sp_workbook_registry_resolution',
      }],
      idempotencyKey: 'workbook-resolution-221',
    }
    const first = await recordWorkbookResolutions(command)
    const replay = await recordWorkbookResolutions({
      ...command, idFactory: () => 'must_not_generate',
    })
    expect(first).toEqual(replay)
    await expect(recordWorkbookResolutions({
      ...command, db: authorityRevokedAfter(1), idFactory: () => 'must_not_generate',
    })).rejects.toThrow(/^NOT_FOUND$/)
    await expect(continueWorkbookImport({
      db: env.DB, actor: OTHER_OWNER, keyring,
      config: {
        appEnv: 'staging', dataMode: 'fictional', activeWorkbookHmacVersion: 1,
      },
      centreId: 'centre_1', nowMs: NOW_MS, correlationId: CORRELATION_ID,
      idFactory: () => 'must_not_generate', importId: 'wbi_workbook_registry',
      expectedVersion: 3, idempotencyKey: 'workbook-continue-other-221',
    })).rejects.toThrow(/^NOT_FOUND$/)
    expect(first.body.data).toEqual({
      importId: 'wbi_workbook_registry', resolutionCount: 1,
      resolutionVersion: 1, importVersion: 3,
    })
    expect(await env.DB.prepare(`SELECT status,version FROM workbook_imports
      WHERE id='wbi_workbook_registry'`).first()).toEqual({
      status: 'materializing', version: 3,
    })
    await expect(recordWorkbookResolutions({
      ...command, idempotencyKey: 'workbook-resolution-stale-221',
      idFactory: () => 'must_not_generate',
    })).rejects.toThrow(/^VERSION_CONFLICT$/)
    await expect(recordWorkbookResolutions({
      ...command, importId: 'wbi_workbook_registry_other',
      idempotencyKey: 'workbook-resolution-other-221',
      idFactory: () => 'must_not_generate',
    })).rejects.toThrow(/^NOT_FOUND$/)
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM audit_events
      WHERE action='workbook.resolutions.recorded'`).first('count')).toBe(1)
  })

  it('loads a full resolution-history page within a fixed query budget', async () => {
    const existing = await env.DB.prepare(`SELECT count(*) AS count
      FROM workbook_import_resolution_sets WHERE import_id=?`).bind(
      'wbi_workbook_registry',
    ).first('count')
    for (let version = existing + 1; version <= 20; version += 1) {
      const id = `wrs_workbook_registry_history_${version}`
      const choices = Array.from({ length: version >= 19 ? 100 : 1 }, (_, index) => ({
        conflictId: index === 0 ? 'wmc_conflict_fictional_1'
          : `wmc_history_${version}_${String(index).padStart(3, '0')}`,
        specialistId: 'sp_workbook_registry_resolution',
      }))
      const resolutionsEnvelope = JSON.stringify(await encryptForScope(
        keyring, registryDataKey, {
          expectedScope: SOURCE_SCOPE,
          recordId: id,
          field: 'resolutions',
          plaintext: JSON.stringify({
            schema: 'workbook_resolution_set.v1',
            planDigest: PLAN_DIGEST,
            resolutions: choices,
          }),
        },
      ))
      await env.DB.prepare(`INSERT INTO workbook_import_resolution_sets
        (id,import_id,artifact_id,preview_token_digest,plan_digest,resolution_count,
         resolutions_envelope,created_by_staff_id,version,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        id, 'wbi_workbook_registry', 'wba_workbook_registry', 'C'.repeat(43),
        PLAN_DIGEST, choices.length, resolutionsEnvelope, OWNER.id, version,
        new Date(NOW_MS + version).toISOString(),
      ).run()
    }
    const budget = createD1QueryBudget(env.DB, { totalLimit: 12, recoveryReserve: 2 })
    const detail = await loadWorkbookRegistryDetail({
      db: budget.work, actor: OWNER, keyring,
      config: { appEnv: 'staging', activeWorkbookHmacVersion: 1 }, nowMs: NOW_MS,
      importId: 'wbi_workbook_registry', cursor: null, section: 'resolutions',
    })
    expect(detail.data.items).toHaveLength(1)
    expect(detail.data.complete).toBe(false)
    expect(detail.data.nextCursor).toMatch(/^c_1_r[1-9]\d*$/)
    // One bounded directory query plus its encrypted identity key read supplies
    // exact specialist labels without coupling registry review to /workspace.
    expect(budget.usage().used).toBeLessThanOrEqual(9)

    const revision = await env.DB.prepare(
      `SELECT revision FROM finance_reporting_state WHERE authority_key='finance'`,
    ).first('revision')
    for (const offset of [18, 19]) {
      const page = await loadWorkbookRegistryDetail({
        db: env.DB, actor: OWNER, keyring,
        config: { appEnv: 'staging', activeWorkbookHmacVersion: 1 }, nowMs: NOW_MS,
        importId: 'wbi_workbook_registry', cursor: `c_${offset}_r${revision}`,
        section: 'resolutions',
      })
      expect(page.data.items).toHaveLength(1)
      expect(page.data.items[0].choices).toHaveLength(100)
    }
  })

  it('records audited centre export history and returns only bounded non-source registry DTOs', async () => {
    const values = ['workbook_registry_export', 'workbook_registry_export_audit']
    const exported = await recordWorkbookExport({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, correlationId: CORRELATION_ID,
      idFactory: () => values.shift(), format: 'panel-v2', byteSize: 2048,
      filename: 'bearwithme-panel-2027-06-15.xlsx', fingerprint: 'd'.repeat(64),
      idempotencyKey: 'workbook-export-221',
    })
    expect(exported.body.data).toEqual({
      id: 'wbe_workbook_registry_export', format: 'panel-v2', scope: 'centre',
      byteSize: 2048, filename: 'bearwithme-panel-2027-06-15.xlsx', createdAt: NOW,
      version: 1,
    })
    await expect(recordWorkbookExport({
      db: authorityRevokedAfter(1), actor: OWNER, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: () => 'must_not_generate',
      format: 'panel-v2', byteSize: 2048,
      filename: 'bearwithme-panel-2027-06-15.xlsx', fingerprint: 'd'.repeat(64),
      idempotencyKey: 'workbook-export-221',
    })).rejects.toThrow(/^NOT_FOUND$/)
    await expect(recordWorkbookExport({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, correlationId: CORRELATION_ID,
      idFactory: () => 'must_not_generate', format: 'panel-v2', byteSize: 2049,
      filename: 'bearwithme-panel-2027-06-15.xlsx', fingerprint: 'e'.repeat(64),
      idempotencyKey: 'workbook-export-221',
    })).rejects.toThrow(/^IDEMPOTENCY_CONFLICT$/)
    await env.DB.prepare(`INSERT INTO workbook_export_history
      (id,format,scope,scope_specialist_id,byte_size,filename,artifact_fingerprint,
       created_by_staff_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
      'wbe_workbook_registry_other', 'panel-v2', 'centre', null, 1024,
      'other-centre.xlsx', 'f'.repeat(64), OTHER_OWNER.id,
      new Date(NOW_MS + 1).toISOString(),
    ).run()
    const registry = await loadWorkbookRegistry({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, cursor: null, section: 'all',
    })
    expect(Object.keys(registry.data)).toEqual([
      'cursor', 'nextCursor', 'imports', 'exports', 'entries', 'complete',
    ])
    expect(registry.data.imports).toHaveLength(2)
    expect(registry.data.imports.find(({ id }) => id === 'wbi_workbook_registry')).toMatchObject({
      id: 'wbi_workbook_registry', resolutionVersion: 20,
      createdByStaffId: OWNER.id,
      artifact: {
        id: 'wba_workbook_registry', fingerprint: '4'.repeat(64), byteSize: 4096,
        parserVersion: 2, materializerVersion: 2, createdAt: NOW,
      },
      phase: 'index_finance', progress: { processed: 0, total: 4 },
      summary: {
        sourceCount: 3, quarantineCount: 1, conflictCount: 1,
        duplicateCount: 0, resolutionCount: 100,
      },
    })
    expect(registry.data.imports.find(({ id }) => id === 'wbi_workbook_registry_other')).toMatchObject({
      id: 'wbi_workbook_registry_other', createdByStaffId: OTHER_OWNER.id,
      status: 'ready', phase: null, progress: null, resolutionVersion: 0,
    })
    expect(registry.data.exports).toEqual([{
      id: 'wbe_workbook_registry_other', format: 'panel-v2', scope: 'centre',
      byteSize: 1024, filename: 'other-centre.xlsx', createdAt: new Date(NOW_MS + 1).toISOString(),
      version: 1,
    }, exported.body.data])
    expect(registry.data.entries).toEqual([{
      id: 'fin_workbook_registry_unknown', importId: 'wbi_workbook_registry', state: 'active',
      voidType: null, kind: 'income', recordType: 'income', accountingMonth: null,
      amountGrosze: 12_000, version: 1,
    }, {
      id: 'fin_workbook_registry', importId: 'wbi_workbook_registry', state: 'active',
      voidType: null, kind: 'income', recordType: 'income', accountingMonth: '2027-06',
      amountGrosze: 18_000, version: 1,
    }, {
      id: 'fin_workbook_registry_unlinked_unknown', importId: null, state: 'active',
      voidType: null, kind: 'income', recordType: 'income', accountingMonth: null,
      amountGrosze: 8_000, version: 1,
    }])
    expect(JSON.stringify(registry)).not.toMatch(/source_key|sheet_name|source_payload|preview_token/)
    expect(JSON.stringify(registry)).toContain('wbi_workbook_registry_other')

    const unknown = await loadWorkbookRegistry({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, cursor: null, section: 'unknown',
    })
    expect(unknown.data.imports).toEqual([])
    expect(unknown.data.exports).toEqual([])
    expect(unknown.data.entries).toEqual([{
      id: 'fin_workbook_registry_unknown', importId: 'wbi_workbook_registry', state: 'active',
      voidType: null, kind: 'income', recordType: 'income', accountingMonth: null,
      amountGrosze: 12_000, version: 1,
    }, {
      id: 'fin_workbook_registry_unlinked_unknown', importId: null, state: 'active',
      voidType: null, kind: 'income', recordType: 'income', accountingMonth: null,
      amountGrosze: 8_000, version: 1,
    }])
  })

  it('reauthorizes export after a committed write and a lost-response winner', async () => {
    const postCommitValues = ['workbook_registry_export_post', 'workbook_registry_export_post_audit']
    await expect(recordWorkbookExport({
      db: authorityRevokedAfter(1), actor: OWNER, nowMs: NOW_MS + 1,
      correlationId: CORRELATION_ID, idFactory: () => postCommitValues.shift(),
      format: 'panel-v2', byteSize: 1024,
      filename: 'a.xlsx', fingerprint: 'a'.repeat(64),
      idempotencyKey: 'workbook-export-post-reauth',
    })).rejects.toThrow(/^NOT_FOUND$/)
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM workbook_export_history
      WHERE id='wbe_workbook_registry_export_post'`).first('count')).toBe(1)

    const winnerValues = [
      'workbook_registry_export_winner', 'workbook_registry_export_winner_audit',
    ]
    await expect(recordWorkbookExport({
      db: authorityRevokedAfter(1, { loseBatchResponse: true }),
      actor: OWNER, nowMs: NOW_MS + 2, correlationId: CORRELATION_ID,
      idFactory: () => winnerValues.shift(), format: 'panel-v2', byteSize: 1025,
      filename: 'b.xlsx', fingerprint: 'b'.repeat(64),
      idempotencyKey: 'workbook-export-winner-reauth',
    })).rejects.toThrow(/^NOT_FOUND$/)
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM workbook_export_history
      WHERE id='wbe_workbook_registry_export_winner'`).first('count')).toBe(1)
  })

  it('fails closed when a creator entry section exceeds its global bound', async () => {
    const imports = { all: async () => ({ results: [] }) }
    const entries = Array.from({ length: 1_001 }, (_, index) => ({
      id: `fin_registry_cap_${index}`, import_id: 'wbi_registry_cap', kind: 'income',
      record_type: 'income', accounting_month: '2027-06', amount_grosze: 1,
      version: 1, void_type: null,
    }))
    const fakeDb = {
      prepare(sql) {
        if (sql.includes('FROM finance_reporting_state')) return {
          first: async () => ({ revision: 1 }),
        }
        return {
          bind() {
            return sql.includes('FROM finance_entries AS entry')
              ? { all: async () => ({ results: entries }) }
              : imports
          },
        }
      },
    }
    await expect(loadWorkbookRegistry({
      db: fakeDb, actor: OWNER, nowMs: NOW_MS, cursor: null, section: 'all',
    })).rejects.toThrow(/^WORKBOOK_REGISTRY_LIMIT$/)
  })

  it('rejects a mixed registry snapshot and a cursor pinned to an older revision', async () => {
    let changed = false
    const interleavedDb = {
      prepare(sql) {
        const statement = env.DB.prepare(sql)
        if (!changed && sql.includes('FROM workbook_export_history')) return {
          bind(...bindings) {
            const bound = statement.bind(...bindings)
            return {
              async all() {
                const result = await bound.all()
                changed = true
                await env.DB.prepare(`UPDATE finance_reporting_state
                  SET revision=revision+1,updated_at=? WHERE authority_key='finance'`)
                  .bind(new Date(NOW_MS + 50).toISOString()).run()
                return result
              },
            }
          },
        }
        return statement
      },
    }
    await expect(loadWorkbookRegistry({
      db: interleavedDb, actor: OWNER, nowMs: NOW_MS, cursor: null, section: 'all',
    })).rejects.toThrow(/^WORKBOOK_REGISTRY_RETRY$/)

    await expect(loadWorkbookRegistry({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, cursor: 'c_20_r1', section: 'all',
    })).rejects.toThrow(/^WORKBOOK_REGISTRY_RETRY$/)
  })

  it('returns stable bounded centre-readable review detail without encrypted source fields', async () => {
    const detail = await loadWorkbookRegistryDetail({
      db: env.DB, actor: OTHER_OWNER, keyring,
      config: { appEnv: 'staging', activeWorkbookHmacVersion: 1 }, nowMs: NOW_MS,
      importId: 'wbi_workbook_registry', cursor: null, section: 'quarantine',
    })
    expect(detail).toEqual({ data: {
      importId: 'wbi_workbook_registry', section: 'quarantine', cursor: null,
      nextCursor: null, items: [{
        id: 'wbq_workbook_registry', sourceRecordId: 'wbs_registry_quarantined',
        primaryReason: 'MISSING_AMOUNT', reasonCodes: ['MISSING_AMOUNT'],
      }], complete: true,
    } })
    expect(JSON.stringify(detail)).not.toMatch(/source_payload|envelope|source_key|preview_token/)
    const source = await loadWorkbookRegistryDetail({
      db: env.DB, actor: OTHER_OWNER, keyring,
      config: { appEnv: 'staging', activeWorkbookHmacVersion: 1 }, nowMs: NOW_MS,
      importId: 'wbi_workbook_registry', cursor: null, section: 'source',
    })
    expect(source.data.items[0]).toMatchObject({
      id: 'wbs_registry_accepted_a', sheetName: 'Fikcyjny arkusz', rowNumber: 2,
      display: { accountingMonth: '2027-06', amountGrosze: 18_000 },
    })
    expect(JSON.stringify(source)).not.toMatch(/EXTRA_NORMALIZED_SENTINEL|EXTRA_RAW_SENTINEL/)
    const conflicts = await loadWorkbookRegistryDetail({
      db: env.DB, actor: OWNER, keyring,
      config: { appEnv: 'staging', activeWorkbookHmacVersion: 1 }, nowMs: NOW_MS,
      importId: 'wbi_workbook_registry', cursor: null, section: 'conflicts',
    })
    expect(conflicts.data.planDigest).toBe(PLAN_DIGEST)
    expect(conflicts.data.specialistOptions).toEqual([{
      id: 'sp_workbook_registry_resolution', label: 'Anna Rejestrowa',
    }])
    expect(conflicts.data.items).toContainEqual({
      id: 'wmc_conflict_fictional_1', kind: 'specialist_mapping', resolved: true,
      sourceValue: 'Fikcyjna specjalistka',
    })
    await expect(loadWorkbookRegistryDetail({
      db: env.DB, actor: OWNER, keyring,
      config: { appEnv: 'staging', activeWorkbookHmacVersion: 1 }, nowMs: NOW_MS,
      importId: 'wbi_workbook_registry_other', cursor: null, section: 'quarantine',
    })).resolves.toEqual({ data: {
      importId: 'wbi_workbook_registry_other', section: 'quarantine', cursor: null,
      nextCursor: null, items: [], complete: true,
    } })
    await expect(loadWorkbookRegistry({
      db: authorityRevokedAfter(0), actor: OWNER, nowMs: NOW_MS,
      cursor: null, section: 'imports',
    })).rejects.toThrow(/^NOT_FOUND$/)
    await expect(loadWorkbookRegistryDetail({
      db: authorityRevokedAfter(1), actor: OWNER, keyring,
      config: { appEnv: 'staging', activeWorkbookHmacVersion: 1 }, nowMs: NOW_MS,
      importId: 'wbi_workbook_registry', cursor: null, section: 'conflicts',
    })).rejects.toThrow(/^NOT_FOUND$/)
  })

  it('adds workbook mapping and historical projection conflicts in the import summary', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_artifacts
        (id,centre_id,environment,fingerprint,byte_size,parser_version,
         materializer_version,object_key,content_nonce_b64,workbook_kek_version,
         metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wba_registry_combined', 'centre_1', 'staging', '8'.repeat(64), 1024, 2, 2,
        'workbook-objects/wbo_registry_combined_0000000000000000', 'A'.repeat(16),
        1, 1, 'B'.repeat(43), OWNER.id, NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_imports
        (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
         correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wbi_registry_combined', 'wba_registry_combined', 'D'.repeat(43), 'complete',
        1, 0, 'corr_registry_combined', OWNER.id, 1, NOW, NOW, NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_import_plans
        (import_id,workbook_kind,plan_version,plan_envelope,created_at)
        VALUES (?,?,?,?,?)`).bind(
        'wbi_registry_combined', 'legacy', 1, '{}', NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_import_plan_summaries
        (import_id,mapping_conflict_count) VALUES (?,?)`).bind(
        'wbi_registry_combined', 2,
      ),
      env.DB.prepare(`INSERT INTO workbook_materialization_jobs
        (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
         summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wbj_registry_combined', 'wbi_registry_combined', 'complete', 'complete',
        1, 1, 1, '{}', '{}', OWNER.id, 1, NOW, NOW, NOW,
      ),
      env.DB.prepare(`INSERT INTO workbook_import_resolution_sets
        (id,import_id,artifact_id,preview_token_digest,plan_digest,resolution_count,
         resolutions_envelope,created_by_staff_id,version,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        'wrs_registry_combined', 'wbi_registry_combined', 'wba_registry_combined',
        'D'.repeat(43), PLAN_DIGEST, 2, '{}', OWNER.id, 1, NOW,
      ),
      env.DB.prepare(`INSERT INTO historical_projection_jobs
        (id,import_id,status,after_source_record_id,total_records,processed_records,
         projected_records,conflict_count,created_by_staff_id,correlation_id,version,
         created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'hpj_registry_combined', 'wbi_registry_combined', 'conflicts', null,
        1, 1, 0, 1, OWNER.id, 'corr_registry_combined', 1, NOW, NOW, null,
      ),
    ])
    const registry = await loadWorkbookRegistry({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, cursor: null, section: 'imports',
    })
    expect(registry.data.imports.find(({ id }) => id === 'wbi_registry_combined')
      ?.summary.conflictCount).toBe(3)
  })
})
