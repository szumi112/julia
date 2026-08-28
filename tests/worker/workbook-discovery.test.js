import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'
import * as workbookCore from '../../worker/core/workbooks.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2027-01-15T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const FINGERPRINT = '6'.repeat(64)
const OPERATOR = authorityActor({
  id: 'stf_workbook_discovery_operator',
  role: 'coordinator',
  authorityRevision: 2,
  capabilities: ['finance.import'],
})
const OTHER_OPERATOR = authorityActor({
  id: 'stf_workbook_discovery_other',
  role: 'coordinator',
  authorityRevision: 2,
  capabilities: ['finance.import'],
})
const DISCOVERED = Object.freeze({
  artifactId: 'wba_workbook_discovery_operator',
  converged: false,
  createdRecords: 7,
  importId: 'wbi_workbook_discovery_operator',
  status: 'materializing',
  version: 2,
  voidedRecords: 1,
})

const seedFinanceImportOperator = async (actor, suffix) => {
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    actor.id, `workbook_discovery_${suffix}_lookup`, '{}', '{}', actor.role, 'active',
    `workbook-discovery-${suffix}-subject`, null, 1, NOW, null, NOW, NOW,
  ).run()
  for (const capability of ROLE_DEFAULT_CAPABILITIES.coordinator) {
    await env.DB.prepare(`INSERT INTO staff_capability_overrides
      (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
      VALUES (?,?,?,1,?,?,?)`).bind(
      actor.id, capability, 'deny', actor.id, NOW, NOW,
    ).run()
  }
  await env.DB.prepare(`INSERT INTO staff_capability_overrides
    (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
    VALUES (?,'finance.import','allow',1,?,?,?)`).bind(actor.id, actor.id, NOW, NOW).run()
  await env.DB.prepare(`UPDATE staff_authorities
    SET revision=2,updated_at=? WHERE staff_id=?`).bind(NOW, actor.id).run()
}

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await seedFinanceImportOperator(OPERATOR, 'operator')
  await seedFinanceImportOperator(OTHER_OPERATOR, 'other')
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,
       materializer_version,object_key,content_nonce_b64,workbook_kek_version,
       metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      DISCOVERED.artifactId, 'centre_1', 'staging', FINGERPRINT, 2048, 2, 2,
      'workbook-objects/wbo_workbook_discovery_operator_00000000',
      'A'.repeat(16), 1, 1, 'B'.repeat(43), OPERATOR.id, NOW,
    ),
    env.DB.prepare(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      DISCOVERED.importId, DISCOVERED.artifactId, 'C'.repeat(43),
      DISCOVERED.status, 9, 1, 'corr_workbook_discovery_operator',
      OPERATOR.id, DISCOVERED.version, NOW, NOW, null,
    ),
    env.DB.prepare(`INSERT INTO workbook_materialization_jobs
      (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
       summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'wbj_workbook_discovery_operator', DISCOVERED.importId, 'apply_finance',
      'running', 8, 9, 8, JSON.stringify({ inserted: 7, voided: 1 }), null,
      OPERATOR.id, 2, NOW, NOW, null,
    ),
  ])
})

describe('creator-bound workbook restart discovery', () => {
  it('discovers exact state for a finance.import-only actor and returns null for other creators', async () => {
    expect(typeof workbookCore.discoverWorkbookImport).toBe('function')
    await expect(workbookCore.discoverWorkbookImport({
      db: env.DB, actor: OPERATOR, nowMs: NOW_MS, fingerprint: FINGERPRINT,
    })).resolves.toEqual({ data: { import: DISCOVERED } })
    await expect(workbookCore.discoverWorkbookImport({
      db: env.DB, actor: OTHER_OPERATOR, nowMs: NOW_MS, fingerprint: FINGERPRINT,
    })).resolves.toEqual({ data: { import: null } })
    await expect(workbookCore.discoverWorkbookImport({
      db: env.DB, actor: OPERATOR, nowMs: NOW_MS, fingerprint: '7'.repeat(64),
    })).resolves.toEqual({ data: { import: null } })
  })

  it('fails closed on ambiguous or malformed rows and rechecks current authority', async () => {
    const actual = (await env.DB.prepare(`SELECT import.id,import.artifact_id,
      import.status,import.version,job.status AS job_status,job.progress_json
      FROM workbook_imports AS import
      JOIN workbook_artifacts AS artifact ON artifact.id=import.artifact_id
      JOIN workbook_materialization_jobs AS job ON job.import_id=import.id
      WHERE import.created_by_staff_id=? AND artifact.centre_id='centre_1'
        AND artifact.fingerprint=? LIMIT 2`).bind(OPERATOR.id, FINGERPRINT).all()).results[0]
    const ambiguousDb = {
      prepare(sql) {
        if (sql.includes('FROM workbook_imports AS import')) return {
          bind() { return this },
          async all() { return { results: [actual, actual] } },
        }
        return env.DB.prepare(sql)
      },
    }
    await expect(workbookCore.discoverWorkbookImport({
      db: ambiguousDb, actor: OPERATOR, nowMs: NOW_MS, fingerprint: FINGERPRINT,
    })).rejects.toThrow(/^INTERNAL_ERROR$/)

    const malformedDb = {
      prepare(sql) {
        if (sql.includes('FROM workbook_imports AS import')) return {
          bind() { return this },
          async all() { return { results: [{ ...actual, progress_json: '{}' }] } },
        }
        return env.DB.prepare(sql)
      },
    }
    await expect(workbookCore.discoverWorkbookImport({
      db: malformedDb, actor: OPERATOR, nowMs: NOW_MS, fingerprint: FINGERPRINT,
    })).rejects.toThrow(/^INTERNAL_ERROR$/)

    const revokedDb = {
      prepare(sql) {
        if (sql.includes('FROM staff_authorities AS authority')) return {
          bind() { return this },
          async all() { return { results: [] } },
        }
        return env.DB.prepare(sql)
      },
    }
    await expect(workbookCore.discoverWorkbookImport({
      db: revokedDb, actor: OPERATOR, nowMs: NOW_MS, fingerprint: FINGERPRINT,
    })).rejects.toThrow(/^NOT_FOUND$/)
  })
})
