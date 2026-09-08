import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  continueWorkbookImport,
  createWorkbookImport,
  previewWorkbook,
} from '../../worker/core/workbooks.js'
import {
  APPROVED, FINANCE_BATCH, NOW_MS, actor, config, parsed, seedMaterializationEnvironment,
} from './workbook-materialization-fixture.js'

let keyring
let sequence = 0
const idFactory = () => `materialization_complete_${++sequence}`
const readPanel = async () => ({ edits: [], kind: 'legacy', metadata: null, voidIds: [] })

beforeAll(async () => {
  ({ keyring } = await seedMaterializationEnvironment({ batchShape: 'complete' }))
})

describe('approved workbook materialization against a complete finance batch', () => {
  it('links every accepted row without inserting rows or voiding formula ghosts', async () => {
    const bytes = new TextEncoder().encode('approved-fictional-workbook-complete-batch')
    const preview = await previewWorkbook({
      db: env.DB, bytes, filename: 'approved-fictional.xlsx', actor, keyring, config,
      centreId: 'centre_1', nowMs: NOW_MS, parse: async () => parsed, readPanel,
      nonceFactory: () => new Uint8Array(16).fill(7),
    })
    const imported = await createWorkbookImport({
      db: env.DB, bucket: env.ARCHIVE, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 1_000, correlationId: 'corr_workbook_complete_import',
      idFactory, bytes, filename: 'approved-fictional.xlsx',
      previewToken: preview.data.previewToken,
      idempotencyKey: 'workbook-complete-import',
      parse: async () => parsed, readPanel,
      storeArtifact: async ({ objectKey }) => ({
        environment: 'staging', centreId: 'centre_1', objectKey,
        fingerprint: APPROVED, byteSize: bytes.byteLength,
        parserVersion: 2, materializerVersion: 2,
        contentNonce: 'A'.repeat(16), workbookKekVersion: 1,
        metadataHmacVersion: 1, metadataSignature: 'B'.repeat(43),
      }),
    })
    const importId = imported.body.data.import.id

    let result = null
    let expectedVersion = 1
    const phases = []
    for (let step = 0; step < 180; step += 1) {
      result = await continueWorkbookImport({
        db: env.DB, actor, keyring, config, centreId: 'centre_1',
        nowMs: NOW_MS + 2_000 + step, correlationId: `corr_workbook_complete_step_${step}`,
        idFactory, importId, expectedVersion,
        idempotencyKey: `workbook-complete-step-${step}`,
      })
      const phase = result.body.data.job.phase
      if (phases.at(-1) !== phase) phases.push(phase)
      if (result.body.data.import.status === 'complete') break
      expectedVersion = result.body.data.import.version
    }

    expect(phases).toEqual([
      'index_finance', 'reconcile_sources', 'reconcile_unmatched', 'apply_finance', 'complete',
    ])
    expect(result.body.data.import.status).toBe('complete')
    expect(result.body.data.reconciliation).toEqual({
      accepted: 2_232,
      quarantined: 3,
      linked: 2_232,
      voided: 2,
      inserted: 0,
      accountingMonthsCorrected: 45,
      specialistAssignmentsCorrected: 2_232,
      fixedRevenuesInserted: 0,
      formulaGhostsVoided: 0,
      quarantinedVoided: 2,
      textAmountVisitsInserted: 0,
    })
    expect((await env.DB.prepare(`SELECT count(*) AS count
      FROM finance_entries AS entry
      LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
      WHERE entry.batch_id=? AND void.id IS NULL`).bind(FINANCE_BATCH).first()).count)
      .toBe(2_232)
    expect((await env.DB.prepare(`SELECT reason_code,count(*) AS count
      FROM finance_entry_voids GROUP BY reason_code`).all()).results)
      .toEqual([{ reason_code: 'quarantined', count: 2 }])
    expect((await env.DB.prepare(`SELECT relationship,count(*) AS count
      FROM finance_source_links GROUP BY relationship`).all()).results)
      .toEqual([{ relationship: 'reconciled', count: 2_232 }])
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM finance_entries
      WHERE batch_id=? AND version=2`).bind(FINANCE_BATCH).first()).count).toBe(2_232)
  }, 60_000)
})
