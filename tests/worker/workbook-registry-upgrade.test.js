import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import { selectCoreMigrationStage } from '../../scripts/core-migration-stages.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW = '2027-06-15T10:00:00.000Z'
const run = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).run()
let stageE

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  stageE = selectCoreMigrationStage(env.TEST_STAGE_E_MIGRATIONS, 'stage-e')
  await applyD1Migrations(env.DB, stageE.filter(({ name }) => (
    name !== '0021_finance_reporting_registry.sql'
  )))
})

describe('0021 workbook registry upgrade', () => {
  it('backfills zero for pre-0021 proposed mappings without mutating plans', async () => {
    await run(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'stf_registry_upgrade', 'registry_upgrade_lookup', '{}', '{}', 'owner', 'active',
    'registry-upgrade-subject', null, 1, NOW, null, NOW, NOW)
    await run(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,professional_title_envelope,
       standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    'sp_registry_upgrade', null, '{}', '{}', 18_000, 'active', 1, null, NOW, NOW)
    await run(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,
       materializer_version,object_key,content_nonce_b64,workbook_kek_version,
       metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wba_registry_upgrade', 'centre_1', 'staging', 'a'.repeat(64), 1024, 2, 2,
    'workbook-objects/wbo_registry_upgrade_opaque', 'A'.repeat(16), 1, 1,
    'B'.repeat(43), 'stf_registry_upgrade', NOW)
    await run(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'wbi_registry_upgrade', 'wba_registry_upgrade', 'C'.repeat(43), 'ready', 0, 0,
    'corr_registry_upgrade', 'stf_registry_upgrade', 1, NOW, NOW, null)
    await run(`INSERT INTO workbook_import_plans
      (import_id,workbook_kind,plan_version,plan_envelope,created_at)
      VALUES (?,?,?,?,?)`, 'wbi_registry_upgrade', 'legacy', 1, '{}', NOW)
    const resolution = (id, digest) => run(`INSERT INTO workbook_resolutions
      (id,import_id,source_record_id,kind,resolution_code,specialist_id,
       source_value_kind,source_value_digest,source_value_hmac_version,
       source_value_envelope,resolved_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, 'wbi_registry_upgrade', null, 'specialist_mapping', 'explicit_match',
    'sp_registry_upgrade', 'explicit_name', digest, 1,
    '{"algorithm":"A256GCM","ciphertext":"opaque","dataKeyId":"key_registry_upgrade","dataKeyVersion":1,"format":1,"nonce":"AAAAAAAAAAAAAAAA"}',
    'stf_registry_upgrade', NOW)
    await resolution('wbr_registry_upgrade_one', 'D'.repeat(43))
    await resolution('wbr_registry_upgrade_two', 'E'.repeat(43))

    const migration = stageE.find(({ name }) => name === '0021_finance_reporting_registry.sql')
    await applyD1Migrations(env.DB, [migration])

    expect(await env.DB.prepare(`SELECT mapping_conflict_count
      FROM workbook_import_plan_summaries WHERE import_id='wbi_registry_upgrade'`)
      .first('mapping_conflict_count')).toBe(0)
    await expect(run(`UPDATE workbook_import_plans SET plan_envelope='{}'
      WHERE import_id='wbi_registry_upgrade'`)).rejects.toThrow(/append_only/)
  })
})
