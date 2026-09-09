import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  continueWorkbookImport,
  createWorkbookImport,
  previewWorkbook as previewWorkbookCore,
} from '../../worker/core/workbooks.js'
import { FINANCE_SCOPE, listFinanceEntries } from '../../worker/core/finance.js'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
import { decryptForScope } from '../../worker/security/envelope.js'
import {
  APPROVED, FINANCE_BATCH, NOW, NOW_MS, actor, canonical, config, otherOwner, parsed,
  seedMaterializationEnvironment,
} from './workbook-materialization-fixture.js'

let keyring
let financeKey
let sequence = 0
const idFactory = () => `materialization_${++sequence}`
const previewWorkbook = (input) => previewWorkbookCore({ db: env.DB, ...input })

beforeAll(async () => {
  ({ keyring, financeKey } = await seedMaterializationEnvironment({ batchShape: 'legacy' }))
})

describe('approved workbook materialization', () => {
  it('refuses a materialization job whose creator differs from its import creator', async () => {
    const progress = JSON.stringify({
      accepted: 0,
      accountingMonthsCorrected: 0,
      candidateCount: 0,
      financeBatchId: null,
      fixedRevenuesInserted: 0,
      formulaGhostsVoided: 0,
      inserted: 0,
      linked: 0,
      quarantined: 0,
      quarantinedVoided: 0,
      specialistAssignmentsCorrected: 0,
      textAmountVisitsInserted: 0,
      voided: 0,
    })
    const first = vi.fn(async () => ({
      import_id: 'wbi_creator_mismatch',
      artifact_id: 'wba_creator_mismatch',
      import_status: 'ready',
      accepted_records: 0,
      quarantined_records: 0,
      created_by_staff_id: actor.id,
      import_version: 1,
      import_created_at: NOW,
      import_updated_at: NOW,
      import_completed_at: null,
      job_id: 'wbj_creator_mismatch',
      phase: 'apply_finance',
      job_status: 'ready',
      cursor: 0,
      total_records: 0,
      processed_records: 0,
      progress_json: progress,
      summary_json: null,
      job_created_by_staff_id: otherOwner.id,
      job_version: 1,
      job_updated_at: NOW,
      job_completed_at: null,
      workbook_kind: 'panel-v2',
      plan_version: 1,
      plan_envelope: '{}',
      fingerprint: 'a'.repeat(64),
    }))
    const statement = { bind: vi.fn(() => statement), first }
    const db = {
      prepare: vi.fn(() => statement),
      batch: vi.fn(async () => { throw new Error('BATCH_MUST_NOT_RUN') }),
    }

    await expect(continueWorkbookImport({
      db, actor, keyring, config, centreId: 'centre_1', nowMs: NOW_MS,
      correlationId: 'corr_workbook_creator_mismatch', idFactory,
      importId: 'wbi_creator_mismatch', expectedVersion: 1,
      idempotencyKey: 'workbook-creator-mismatch',
    })).rejects.toThrow(/^NOT_FOUND$/)
    expect(first).toHaveBeenCalledOnce()
    expect(db.batch).not.toHaveBeenCalled()
  })

  it('atomically preserves 2,232 accepted/3 quarantine while reconciling exact finance facts once', async () => {
    expect(Object.fromEntries(['english', 'expense', 'income', 'tus'].map((type) => [
      type, canonical.filter(({ recordType }) => recordType === type).length,
    ]))).toEqual({ english: 165, expense: 42, income: 2_000, tus: 25 })
    const bytes = new TextEncoder().encode('approved-fictional-workbook-materialization')
    const preview = await previewWorkbook({
      bytes, filename: 'approved-fictional.xlsx', actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS, parse: async () => parsed,
      readPanel: async () => ({ edits: [], kind: 'legacy', metadata: null, voidIds: [] }),
      nonceFactory: () => new Uint8Array(16).fill(7),
    })
    expect(preview.data.proposedMappings.find(({ sourceValue }) => sourceValue === ''))
      .toMatchObject({ specialistId: 'sp_generated_workbook_julia' })
    const artifactDescriptor = ({ objectKey }) => ({
      environment: 'staging', centreId: 'centre_1', objectKey,
      fingerprint: APPROVED, byteSize: bytes.byteLength,
      parserVersion: 2, materializerVersion: 2,
      contentNonce: 'A'.repeat(16), workbookKekVersion: 1,
      metadataHmacVersion: 1, metadataSignature: 'B'.repeat(43),
    })
    await expect(createWorkbookImport({
      db: env.DB, bucket: env.ARCHIVE, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 500, correlationId: 'corr_workbook_materialization_directory_race',
      idFactory, bytes, filename: 'approved-fictional.xlsx',
      previewToken: preview.data.previewToken,
      idempotencyKey: 'workbook-materialization-directory-race',
      parse: async () => parsed,
      readPanel: async () => ({ edits: [], kind: 'legacy', metadata: null, voidIds: [] }),
      storeArtifact: async (input) => {
        await env.DB.prepare(`UPDATE specialists SET version=version+1,updated_at=?
          WHERE id=?`).bind(
          new Date(NOW_MS + 500).toISOString(), 'sp_generated_workbook_julia',
        ).run()
        return artifactDescriptor(input)
      },
    })).rejects.toThrow(/^WORKBOOK_IMPORT_CONFLICT$/)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM workbook_artifacts
      WHERE fingerprint=?`).bind(APPROVED).first()).count).toBe(0)
    const importBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    for (let index = 0; index < 3; index += 1) {
      await importBudget.work.prepare(`SELECT ${index} AS value`).first()
    }
    const imported = await createWorkbookImport({
      db: importBudget.work, bucket: env.ARCHIVE, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 1_000, correlationId: 'corr_workbook_materialization_import',
      idFactory, bytes, filename: 'approved-fictional.xlsx',
      previewToken: preview.data.previewToken,
      idempotencyKey: 'workbook-materialization-import',
      parse: async () => parsed,
      readPanel: async () => ({ edits: [], kind: 'legacy', metadata: null, voidIds: [] }),
      storeArtifact: async (input) => artifactDescriptor(input),
    })
    expect(importBudget.usage().workRemaining).toBeGreaterThanOrEqual(2)
    expect(await env.DB.prepare(`SELECT specialist_id FROM workbook_resolutions
      WHERE import_id=? AND kind='specialist_mapping' AND source_value_kind='blank'`).bind(
      imported.body.data.import.id,
    ).first('specialist_id')).toBe('sp_generated_workbook_julia')
    await expect(continueWorkbookImport({
      db: env.DB, actor: otherOwner, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 2_000, correlationId: 'corr_workbook_materialization_other',
      idFactory, importId: imported.body.data.import.id,
      expectedVersion: 1, idempotencyKey: 'workbook-materialization-other',
    })).rejects.toThrow(/^NOT_FOUND$/)

    const continuation = {
      db: env.DB, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 2_000, correlationId: 'corr_workbook_materialization_continue',
      idFactory, importId: imported.body.data.import.id,
      expectedVersion: 1, idempotencyKey: 'workbook-materialization-continue',
    }
    let maximumRequestQueries = 0
    const continueWithinBudget = async (input) => {
      const budget = createD1QueryBudget(env.DB, {
        totalLimit: 50, recoveryReserve: 8,
      })
      const result = await continueWorkbookImport({ ...input, db: budget.work })
      maximumRequestQueries = Math.max(maximumRequestQueries, budget.usage().used)
      return result
    }
    const [firstLeft, firstRight] = await Promise.all([
      continueWithinBudget(continuation),
      continueWithinBudget(continuation),
    ])
    expect(firstLeft.body).toEqual(firstRight.body)
    expect(firstLeft.body.data.import).toMatchObject({ status: 'materializing', version: 2 })
    expect(firstLeft.body.data.job).toMatchObject({
      phase: 'index_finance', status: 'running', cursor: 64, totalRecords: 2_234,
    })
    const interrupted = await env.DB.prepare(`SELECT job.phase,job.cursor,job.version,
        import.status AS import_status
      FROM workbook_materialization_jobs AS job
      JOIN workbook_imports AS import ON import.id=job.import_id
      WHERE job.import_id=?`).bind(imported.body.data.import.id).first()
    expect(interrupted).toEqual({
      phase: 'index_finance', cursor: 64, version: 2, import_status: 'materializing',
    })

    let left = firstLeft
    const observedPhases = [left.body.data.job.phase]
    for (let step = 1; left.body.data.import.status !== 'complete' && step < 180; step += 1) {
      const previous = left.body.data.job
      left = await continueWithinBudget({
        ...continuation,
        expectedVersion: left.body.data.import.version,
        idempotencyKey: `workbook-materialization-step-${step}`,
        correlationId: `corr_workbook_materialization_step_${step}`,
      })
      const current = left.body.data.job
      if (current.phase === previous.phase) {
        expect(current.cursor - previous.cursor).toBeGreaterThan(0)
        expect(current.cursor - previous.cursor).toBeLessThanOrEqual(64)
      } else {
        observedPhases.push(current.phase)
        if (current.phase !== 'complete') expect(current.cursor).toBeLessThanOrEqual(64)
      }
    }
    expect(observedPhases).toEqual([
      'index_finance', 'reconcile_sources', 'reconcile_unmatched', 'apply_finance', 'complete',
    ])
    expect(left.body.data.import.status).toBe('complete')
    expect(left.body.data.reconciliation).toEqual({
      accepted: 2_232,
      quarantined: 3,
      linked: 2_232,
      voided: 7,
      inserted: 5,
      accountingMonthsCorrected: 45,
      specialistAssignmentsCorrected: 2_227,
      fixedRevenuesInserted: 3,
      formulaGhostsVoided: 5,
      quarantinedVoided: 2,
      textAmountVisitsInserted: 2,
    })
    expect(left.body.data.import).toMatchObject({ status: 'complete', version: 3 })
    expect(maximumRequestQueries).toBeGreaterThan(0)
    expect(maximumRequestQueries).toBeLessThanOrEqual(42)

    const active = await env.DB.prepare(`SELECT count(*) AS count
      FROM finance_entries AS entry
      LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
      WHERE entry.batch_id=? AND void.id IS NULL`).bind(FINANCE_BATCH).first()
    expect(active.count).toBe(2_232)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM finance_entry_voids',
    ).first()).count).toBe(7)
    expect((await env.DB.prepare(`SELECT reason_code,count(*) AS count
      FROM finance_entry_voids GROUP BY reason_code ORDER BY reason_code`).all()).results)
      .toEqual([
        { reason_code: 'formula_cache', count: 5 },
        { reason_code: 'quarantined', count: 2 },
      ])
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM finance_source_links',
    ).first()).count).toBe(2_232)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM finance_adjustments',
    ).first()).count).toBe(2_227)
    const september = await listFinanceEntries({
      db: env.DB, actor, keyring, nowMs: NOW_MS + 4_000, month: '2025-09', kind: null,
    })
    expect(september.data.entries).toEqual([])
    expect(september.data.summary.entryCount).toBe(0)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM finance_entries
      WHERE batch_id=? AND version=2`).bind(FINANCE_BATCH).first()).count).toBe(2_227)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM finance_entries
      WHERE batch_id=? AND version=1 AND id LIKE 'fin_materialization_%'`).bind(
      FINANCE_BATCH,
    ).first()).count).toBe(5)
    expect((await env.DB.prepare(`SELECT count(*) AS count
      FROM finance_entries AS entry
      JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
      WHERE entry.batch_id=? AND entry.version=1`).bind(FINANCE_BATCH).first()).count).toBe(7)

    const sourceFacts = (await env.DB.prepare(`SELECT source.sheet_name,source.record_type,
        source.warning_codes_json
      FROM finance_source_links AS link
      JOIN workbook_source_records AS source ON source.id=link.source_record_id
      JOIN finance_entries AS entry ON entry.id=link.finance_entry_id
      WHERE entry.id LIKE 'fin_materialization_%'
        AND (source.sheet_name='Stałe koszty' OR source.warning_codes_json!='[]')
      ORDER BY source.source_key`).all()).results
    expect(sourceFacts.filter(({ sheet_name: sheet }) => sheet === 'Stałe koszty')).toHaveLength(3)
    expect(sourceFacts.filter(({ warning_codes_json: warnings }) => (
      warnings === '["AMOUNT_STORED_AS_TEXT"]'
    ))).toHaveLength(2)
    expect((await env.DB.prepare(`SELECT disposition,record_type,period_precision,
        count(*) AS count
      FROM workbook_source_records WHERE import_id=?
      GROUP BY disposition,record_type,period_precision
      ORDER BY disposition,record_type,period_precision`).bind(
      imported.body.data.import.id,
    ).all()).results).toEqual([
      { disposition: 'accepted', record_type: 'english', period_precision: 'month', count: 165 },
      { disposition: 'accepted', record_type: 'expense', period_precision: 'month', count: 42 },
      { disposition: 'accepted', record_type: 'income', period_precision: 'day', count: 1_997 },
      { disposition: 'accepted', record_type: 'income', period_precision: 'month', count: 3 },
      { disposition: 'accepted', record_type: 'tus', period_precision: 'day', count: 2 },
      { disposition: 'accepted', record_type: 'tus', period_precision: 'month', count: 23 },
      { disposition: 'quarantined', record_type: 'expense', period_precision: 'unknown', count: 1 },
      { disposition: 'quarantined', record_type: 'income', period_precision: 'unknown', count: 2 },
    ])

    const adjusted = await env.DB.prepare(`SELECT adjustment.id,adjustment.reason_envelope,
        adjustment.before_envelope,adjustment.after_envelope
      FROM finance_adjustments AS adjustment
      JOIN finance_entries AS entry ON entry.id=adjustment.finance_entry_id
      WHERE entry.accounting_month='2024-08' ORDER BY adjustment.id LIMIT 1`).first()
    const reason = JSON.parse(await decryptForScope(keyring, financeKey, {
      expectedScope: FINANCE_SCOPE, recordId: adjusted.id, field: 'reason',
      envelope: JSON.parse(adjusted.reason_envelope),
    }))
    const before = JSON.parse(await decryptForScope(keyring, financeKey, {
      expectedScope: FINANCE_SCOPE, recordId: adjusted.id, field: 'before',
      envelope: JSON.parse(adjusted.before_envelope),
    }))
    const after = JSON.parse(await decryptForScope(keyring, financeKey, {
      expectedScope: FINANCE_SCOPE, recordId: adjusted.id, field: 'after',
      envelope: JSON.parse(adjusted.after_envelope),
    }))
    expect(reason).toEqual({ code: 'workbook_reconciliation', importId: imported.body.data.import.id })
    expect(before.accountingMonth).toBe('2026-08')
    expect(after.accountingMonth).toBe('2024-08')

    const beforeReplayCounts = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM finance_adjustments) AS adjustments,
      (SELECT count(*) FROM finance_entry_voids) AS voids,
      (SELECT count(*) FROM finance_source_links) AS links`).first()
    const replay = await continueWithinBudget(continuation)
    expect(replay.body).toEqual(left.body)
    expect(await env.DB.prepare(`SELECT
      (SELECT count(*) FROM finance_adjustments) AS adjustments,
      (SELECT count(*) FROM finance_entry_voids) AS voids,
      (SELECT count(*) FROM finance_source_links) AS links`).first()).toEqual(beforeReplayCounts)

    const revokedDb = {
      prepare(sql) {
        if (sql.includes('FROM staff_authorities AS authority')) return {
          bind() { return this },
          async all() { return { results: [] } },
        }
        return env.DB.prepare(sql)
      },
      batch(statements) { return env.DB.batch(statements) },
    }
    await expect(continueWorkbookImport({
      ...continuation, db: revokedDb,
    })).rejects.toThrow(/^NOT_FOUND$/)
    await expect(continueWorkbookImport({
      ...continuation,
      db: revokedDb,
      expectedVersion: left.body.data.import.version,
      idempotencyKey: 'workbook-materialization-complete-revoked',
      correlationId: 'corr_workbook_materialization_complete_revoked',
    })).rejects.toThrow(/^NOT_FOUND$/)
  }, 30_000)
})
