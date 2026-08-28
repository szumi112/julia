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
const progressFor = (patch = {}) => ({
  accepted: 7,
  accountingMonthsCorrected: 0,
  candidateCount: 9,
  financeBatchId: null,
  fixedRevenuesInserted: 0,
  formulaGhostsVoided: 0,
  inserted: 7,
  linked: 7,
  quarantined: 1,
  quarantinedVoided: 1,
  specialistAssignmentsCorrected: 0,
  textAmountVisitsInserted: 0,
  voided: 1,
  ...patch,
})

const stateStatements = ({
  suffix, fingerprint, previewDigest, importStatus, jobStatus, progress,
}) => {
  const importId = `wbi_workbook_discovery_${suffix}`
  const artifactId = `wba_workbook_discovery_${suffix}`
  const importComplete = importStatus === 'complete'
  const jobComplete = jobStatus === 'complete'
  return [
    env.DB.prepare(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,
       materializer_version,object_key,content_nonce_b64,workbook_kek_version,
       metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      artifactId, 'centre_1', 'staging', fingerprint, 2048, 2, 2,
      `workbook-objects/wbo_workbook_discovery_${suffix}_00000000`,
      'A'.repeat(16), 1, 1, 'B'.repeat(43), OPERATOR.id, NOW,
    ),
    env.DB.prepare(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      importId, artifactId, previewDigest, importStatus, 9, 1,
      `corr_workbook_discovery_${suffix}`, OPERATOR.id, 1, NOW, NOW,
      importComplete ? NOW : null,
    ),
    env.DB.prepare(`INSERT INTO workbook_materialization_jobs
      (id,import_id,phase,status,cursor,total_records,processed_records,progress_json,
       summary_json,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      `wbj_workbook_discovery_${suffix}`, importId,
      jobComplete ? 'complete' : 'apply_finance', jobStatus,
      jobComplete ? 9 : 8, 9, jobComplete ? 9 : 8, JSON.stringify(progress),
      jobComplete ? '{}' : null, OPERATOR.id, 1, NOW, NOW, jobComplete ? NOW : null,
    ),
  ]
}

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
      'running', 8, 9, 8, JSON.stringify(progressFor()), null,
      OPERATOR.id, 2, NOW, NOW, null,
    ),
    ...stateStatements({
      suffix: 'invalid_pair', fingerprint: 'a'.repeat(64), previewDigest: 'D'.repeat(43),
      importStatus: 'ready', jobStatus: 'running', progress: progressFor(),
    }),
    ...stateStatements({
      suffix: 'corrupt_terminal', fingerprint: 'b'.repeat(64),
      previewDigest: 'E'.repeat(43), importStatus: 'complete', jobStatus: 'complete',
      progress: progressFor({ accepted: -1 }),
    }),
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

  it('fails closed on ambiguous rows and rechecks current authority', async () => {
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

  it.each([
    ['a missing progress field', JSON.stringify(Object.fromEntries(
      Object.entries(progressFor()).filter(([key]) => key !== 'accepted'),
    ))],
    ['an extra progress field', JSON.stringify({ ...progressFor(), unexpected: 0 })],
    ['a non-integer progress count', JSON.stringify(progressFor({ candidateCount: 1.5 }))],
    ['an invalid finance batch id', JSON.stringify(progressFor({ financeBatchId: 'fib_' }))],
    ['a non-string finance batch id', JSON.stringify(progressFor({
      financeBatchId: ['fib_workbook_discovery'],
    }))],
  ])('fails closed on malformed rows with %s', async (_case, progressJson) => {
    const actual = (await env.DB.prepare(`SELECT import.id,import.artifact_id,
      import.status,import.version,job.status AS job_status,job.progress_json
      FROM workbook_imports AS import
      JOIN workbook_artifacts AS artifact ON artifact.id=import.artifact_id
      JOIN workbook_materialization_jobs AS job ON job.import_id=import.id
      WHERE import.created_by_staff_id=? AND artifact.centre_id='centre_1'
        AND artifact.fingerprint=? LIMIT 2`).bind(OPERATOR.id, FINGERPRINT).all()).results[0]
    const malformedDb = {
      prepare(sql) {
        if (sql.includes('FROM workbook_imports AS import')) return {
          bind() { return this },
          async all() { return { results: [{ ...actual, progress_json: progressJson }] } },
        }
        return env.DB.prepare(sql)
      },
    }
    await expect(workbookCore.discoverWorkbookImport({
      db: malformedDb, actor: OPERATOR, nowMs: NOW_MS, fingerprint: FINGERPRINT,
    })).rejects.toThrow(/^INTERNAL_ERROR$/)
  })

  it('rejects an impossible D1 import and materialization status pairing', async () => {
    await expect(workbookCore.discoverWorkbookImport({
      db: env.DB, actor: OPERATOR, nowMs: NOW_MS, fingerprint: 'a'.repeat(64),
    })).rejects.toThrow(/^INTERNAL_ERROR$/)
    await expect(workbookCore.getWorkbookImport({
      db: env.DB, actor: OPERATOR, nowMs: NOW_MS,
      importId: 'wbi_workbook_discovery_invalid_pair',
    })).rejects.toThrow(/^INTERNAL_ERROR$/)
  })

  it('rejects corrupt terminal progress through discovery and direct status', async () => {
    await expect(workbookCore.discoverWorkbookImport({
      db: env.DB, actor: OPERATOR, nowMs: NOW_MS, fingerprint: 'b'.repeat(64),
    })).rejects.toThrow(/^INTERNAL_ERROR$/)
    await expect(workbookCore.getWorkbookImport({
      db: env.DB, actor: OPERATOR, nowMs: NOW_MS,
      importId: 'wbi_workbook_discovery_corrupt_terminal',
    })).rejects.toThrow(/^INTERNAL_ERROR$/)
  })
})
