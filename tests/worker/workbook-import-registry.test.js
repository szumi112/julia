import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createWorkbookImport,
  continueWorkbookImport,
  exportWorkbook,
  getWorkbookImport,
  loadWorkbookPanelState,
  previewWorkbook,
} from '../../worker/core/workbooks.js'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import {
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
  loadDataKey,
} from '../../worker/security/envelope.js'
import { FINANCE_SCOPE } from '../../worker/core/finance.js'
import { createWorkbookPanelMetadataCallbacks } from '../../worker/security/workbook-artifacts.js'
import {
  createScopedPanelWorkbook,
  readPanelWorkbook,
} from '../../src/workbook-ooxml.js'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = Date.parse('2027-01-15T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const actor = Object.freeze({
  id: 'stf_workbook_import_owner', role: 'owner', specialistId: null, version: 1,
  authorityRevision: 1, capabilities: ROLE_DEFAULT_CAPABILITIES.owner,
})
const panelFinanceValues = (patch = {}) => ({
  accountingMonth: '2025-09', occurredOn: '2025-09-02',
  amountGrosze: 18_000, paidAmountGrosze: 18_000,
  paymentMethod: 'cash', settlementStatus: 'paid',
  invoiceStatus: 'not_required',
  specialistId: 'sp_staging_workbook_anna_janowska',
  ...patch,
})
const config = Object.freeze({
  appEnv: 'staging', dataMode: 'fictional',
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
  activeWorkbookKekVersion: 1,
  activeWorkbookHmacVersion: 1,
})
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const createdObjects = []
let sequence = 0
const idFactory = () => `workbook_registry_${++sequence}`
const panel = async () => ({
  edits: [], kind: 'panel-v2',
  metadata: {
    format: 'Panel-v2', rows: [], scope: { id: 'centre_1', type: 'centre' }, voidIds: [],
  },
  voidIds: [],
})

const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map((value) => value.toString(16).padStart(2, '0')).join('')

const parser = async (arrayBuffer, { filename }) => {
  const fingerprint = await digest(arrayBuffer)
  return Object.freeze({
    formatVersion: 1,
    parserVersion: 2,
    materializerVersion: 2,
    fingerprint,
    filename,
    counts: Object.freeze({ financeRows: 1 }),
    warnings: Object.freeze([{ code: 'AMOUNT_STORED_AS_TEXT', count: 1 }]),
    rows: Object.freeze([{
      sourceKey: 'workbook:v1:0:2:0', sheet: 'Wrzesień 2025', rowNumber: 2,
      recordType: 'income', accountingMonth: '2025-09', occurredOn: '2025-09-02',
      amountGrosze: 18000, counterparty: 'Fikcyjna Osoba Registry Marker',
      sourceLabel: 'Fikcyjna konsultacja', paymentMethod: 'cash',
      settlementStatus: 'paid', invoiceStatus: 'not_required', invoiceNote: '',
      specialistName: 'Anna Janowska', lessonCount: null,
      warningCodes: ['AMOUNT_STORED_AS_TEXT'], raw: { Cena: '180 zł' },
    }]),
    quarantinedRows: Object.freeze([{
      sourceKey: 'workbook:v1:0:3:0', sheet: 'Wrzesień 2025', rowNumber: 3,
      recordType: 'income', accountingMonth: '2025-09', occurredOn: null,
      amountGrosze: 18000, reasonCode: 'SERVICE_DATE_MISSING',
      reasonCodes: ['SERVICE_DATE_MISSING'], raw: { Cena: 180 },
    }]),
    reconciliation: Object.freeze({
      sourceCandidates: 2, acceptedRows: 1, quarantinedRows: 1,
      excludedFormulaBlocks: 0, excludedFormulaRows: 0,
    }),
  })
}

let keyring
let financeKey

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
    actor.id, 'workbook_import_owner_lookup', '{}', '{}', 'owner', 'active',
    'workbook-import-owner-subject', null, 1, NOW, null, NOW, NOW,
  ).run()
  for (const [id, name] of [
    ['sp_staging_workbook_anna_janowska', 'Anna'],
    ['sp_staging_workbook_julia_wolanin', 'Julia'],
    ['sp_staging_workbook_justyna_j_j', 'Justyna'],
  ]) await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
     archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    id, null, JSON.stringify({ name }), 18000, 'active', 1, null, NOW, NOW,
  ).run()
  keyring = await createKeyring({
    BWM_DATA_KEK_V1: key(1),
    BWM_LOOKUP_HMAC_V1: key(2),
    BWM_WORKBOOK_KEK_V1: key(9),
    BWM_WORKBOOK_HMAC_V1: key(10),
  }, config)
  financeKey = await getOrCreateDataKey(env.DB, keyring, FINANCE_SCOPE, {
    id: 'key_workbook_panel_registry_finance', createdAt: NOW,
  })
  const sealFinance = async (field, value) => JSON.stringify(await encryptForScope(
    keyring,
    financeKey,
    {
      expectedScope: FINANCE_SCOPE,
      recordId: 'fin_panel_registry_edit',
      field,
      plaintext: JSON.stringify(value),
    },
  ))
  await env.DB.prepare(`INSERT INTO finance_import_batches
    (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
     created_by_staff_id,version,created_at,updated_at,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fib_workbook_panel_registry', 'a'.repeat(64), '{}', 1, 1, 1, 'committed',
    actor.id, 1, NOW, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,
     invoice_status,specialist_id,appointment_id,counterparty_lookup,
     details_envelope,source_row_envelope,version,created_by_staff_id,
     created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'fin_panel_registry_edit', 'fib_workbook_panel_registry', 'panel-registry-source',
    'income', 'income', '2025-09', '2025-09-02', 18_000, 18_000, 'cash', 'paid',
    'not_required', 'sp_staging_workbook_anna_janowska', null, null,
    await sealFinance('details', {
      schema: 'finance_entry_details.v1', counterparty: 'Fikcyjna osoba',
      sourceLabel: 'Fikcyjna konsultacja', invoiceNote: '', lessonCount: null,
    }),
    await sealFinance('source_row', {
      schema: 'finance_entry_source.v1',
      source: {
        batchId: 'fib_workbook_panel_registry', sourceKey: 'panel-registry-source',
        sheet: 'Panel — Wizyty', rowNumber: 3, raw: { Cena: 180 },
      },
    }),
    1, actor.id, NOW, NOW,
  ).run()
})

afterAll(async () => {
  await Promise.all(createdObjects.map((objectKey) => env.ARCHIVE.delete(objectKey)))
})

const previewFor = (bytes) => previewWorkbook({
  bytes, filename: 'fictional-panel.xlsx', actor, keyring, config, centreId: 'centre_1',
  nowMs: NOW_MS, parse: parser, readPanel: panel,
  nonceFactory: () => new Uint8Array(16).fill(13),
})

const command = (bytes, token, idempotencyKey) => ({
  db: env.DB,
  bucket: env.ARCHIVE,
  actor,
  keyring,
  config,
  centreId: 'centre_1',
  nowMs: NOW_MS + 1_000,
  correlationId: `corr_workbook_${idempotencyKey}`,
  idFactory,
  bytes,
  filename: 'fictional-panel.xlsx',
  previewToken: token,
  idempotencyKey,
  parse: parser,
  readPanel: panel,
  artifactNonceFactory: () => new Uint8Array(12).fill(14),
})

describe('workbook import reservation', () => {
  it('loads the maximum Panel preview scope within the 42-query Worker budget', async () => {
    const budget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    const result = await loadWorkbookPanelState({
      db: budget.work,
      keyring,
      centreId: 'centre_1',
      rows: Array.from({ length: 2_500 }, (_, index) => ({
        id: `fin_budget_${String(index).padStart(4, '0')}`,
        type: 'finance_entry',
      })),
    })

    expect(result.rows).toEqual([])
    expect(budget.usage()).toMatchObject({ used: 25, workRemaining: 17 })
  })

  it('re-hashes/re-parses exact Panel bytes, stores its R2 template without duplicating source authority, then replays safely', async () => {
    const bytes = new TextEncoder().encode('fictional-workbook-registry-one')
    const preview = await previewFor(bytes)
    const first = await createWorkbookImport(command(
      bytes, preview.data.previewToken, 'workbook-import-one',
    ))
    expect(first.status).toBe(201)
    expect(first.body.data.import).toMatchObject({
      acceptedRecords: 0,
      quarantinedRecords: 0,
      status: 'ready',
      version: 1,
      createdByStaffId: actor.id,
    })
    const artifact = await env.DB.prepare(
      `SELECT artifact.object_key,artifact.fingerprint,import.correlation_id
       FROM workbook_artifacts AS artifact
       JOIN workbook_imports AS import ON import.artifact_id=artifact.id
       WHERE artifact.id=?`,
    ).bind(first.body.data.import.artifactId).first()
    createdObjects.push(artifact.object_key)
    expect(artifact.fingerprint).toBe(await digest(bytes))
    expect(artifact.correlation_id).toBe('corr_workbook_workbook-import-one')
    const stored = await env.ARCHIVE.get(artifact.object_key)
    expect(new TextDecoder().decode(await stored.arrayBuffer()))
      .not.toContain('fictional-workbook-registry-one')

    const sources = (await env.DB.prepare(`SELECT disposition,record_digest,
        record_digest_hmac_version,source_payload_envelope
      FROM workbook_source_records WHERE import_id=? ORDER BY disposition`).bind(
      first.body.data.import.id,
    ).all()).results
    expect(sources).toEqual([])
    expect(JSON.stringify(sources)).not.toContain('Fikcyjna Osoba Registry Marker')
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_quarantine_records WHERE source_record_id IN (SELECT id FROM workbook_source_records WHERE import_id=?)',
    ).bind(first.body.data.import.id).first()).count).toBe(0)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_resolutions WHERE import_id=?',
    ).bind(first.body.data.import.id).first()).count).toBe(0)

    const replay = await createWorkbookImport(command(
      bytes, preview.data.previewToken, 'workbook-import-one',
    ))
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
    const status = await getWorkbookImport({
      db: env.DB, actor, nowMs: NOW_MS + 2_000, importId: first.body.data.import.id,
    })
    expect(status).toEqual({
      data: {
        import: first.body.data.import,
        job: {
          id: expect.stringMatching(/^wbj_/),
          phase: 'apply_finance',
          status: 'ready',
          cursor: 0,
          totalRecords: 0,
          processedRecords: 0,
          version: 1,
          updatedAt: new Date(NOW_MS + 1_000).toISOString(),
          completedAt: null,
        },
      },
    })
    expect(JSON.stringify(status)).not.toContain('sourceKey')
    expect(JSON.stringify(status)).not.toContain('planEnvelope')
  })

  it('rejects token/file swaps before any new D1 or R2 artifact write', async () => {
    const bytes = new TextEncoder().encode('fictional-workbook-registry-two')
    const preview = await previewFor(bytes)
    const beforeArtifacts = (await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_artifacts',
    ).first()).count
    const beforeObjects = (await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length
    await expect(createWorkbookImport(command(
      new TextEncoder().encode('fictional-workbook-registry-swapped'),
      preview.data.previewToken,
      'workbook-import-swapped',
    ))).rejects.toThrow(/^WORKBOOK_PREVIEW_TOKEN_INVALID$/)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_artifacts',
    ).first()).count).toBe(beforeArtifacts)
    expect((await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length)
      .toBe(beforeObjects)
  })

  it('rejects an invalid merged Panel row at preview and exact-file commit before writes', async () => {
    const bytes = new TextEncoder().encode('fictional-workbook-invalid-panel-row')
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring, config, centreId: 'centre_1',
    })
    const readPanel = async () => ({
      edits: [{
        id: 'fin_panel_registry_edit', sheet: 'Panel — Wizyty',
        values: { accountingMonth: '2025-13' },
      }],
      kind: 'panel-v2',
      metadata: {
        format: 'Panel-v2', scope: { id: 'centre_1', type: 'centre' },
        rows: [{
          id: 'fin_panel_registry_edit', type: 'finance_entry', baseVersion: 1,
          fieldDigests: {
            accountingMonth: await callbacks.digestField({
              rowType: 'finance_entry', rowId: 'fin_panel_registry_edit',
              field: 'accountingMonth', value: '2025-09',
            }),
          },
        }],
        voidIds: [],
      },
      voidIds: [],
    })
    const loadPanelState = (input) => loadWorkbookPanelState({
      db: env.DB, keyring, ...input,
    })
    const preview = await previewWorkbook({
      bytes, filename: 'fictional-panel.xlsx', actor, keyring, config,
      centreId: 'centre_1', nowMs: NOW_MS, parse: parser, readPanel, loadPanelState,
      nonceFactory: () => new Uint8Array(16).fill(13),
    })
    expect(preview.data.conflicts).toEqual([{
      code: 'PANEL_VALUE_INVALID', field: 'accountingMonth',
      recordId: 'fin_panel_registry_edit',
    }])
    const beforeArtifacts = (await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_artifacts',
    ).first()).count
    const beforeObjects = (await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length

    await expect(createWorkbookImport({
      ...command(bytes, preview.data.previewToken, 'workbook-import-invalid-panel'),
      readPanel,
      loadPanelState,
    })).rejects.toThrow(/^WORKBOOK_IMPORT_CONFLICT$/)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_artifacts',
    ).first()).count).toBe(beforeArtifacts)
    expect((await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length)
      .toBe(beforeObjects)
  })

  it('converges concurrent identical idempotency requests to one import and one object', async () => {
    const bytes = new TextEncoder().encode('fictional-workbook-registry-race')
    const preview = await previewFor(bytes)
    const beforeObjects = (await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length
    const [left, right] = await Promise.all([
      createWorkbookImport(command(bytes, preview.data.previewToken, 'workbook-import-race')),
      createWorkbookImport(command(bytes, preview.data.previewToken, 'workbook-import-race')),
    ])
    expect(left.body.data.import.id).toBe(right.body.data.import.id)
    const row = await env.DB.prepare(
      'SELECT object_key FROM workbook_artifacts WHERE id=?',
    ).bind(left.body.data.import.artifactId).first()
    createdObjects.push(row.object_key)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_request_replays WHERE operation=? AND idempotency_key=?',
    ).bind('workbooks.import', 'workbook-import-race').first()).count).toBe(1)
    expect((await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length)
      .toBe(beforeObjects + 1)
  })

  it('re-runs and commits a literal valid Panel field edit into an encrypted continuation plan', async () => {
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring, config, centreId: 'centre_1',
    })
    const panelColumns = [{
      key: 'amountGrosze', label: 'Kwota (gr)', type: 'cents', width: 16,
    }]
    const bytes = await createScopedPanelWorkbook({
      allowedRowIds: [],
      allowedSheets: [{ name: 'Panel — Wizyty', columns: panelColumns }],
      metadata: {
        format: 'Panel-v2', rows: [],
        scope: { id: 'centre_1', type: 'centre' }, voidIds: [],
      },
      sheets: [{ name: 'Panel — Wizyty', columns: panelColumns, rows: [] }],
    }, { sign: callbacks.sign })
    const metadata = {
      format: 'Panel-v2',
      scope: { id: 'centre_1', type: 'centre' },
      rows: [{
        id: 'fin_panel_registry_edit', type: 'finance_entry', baseVersion: 1,
        fieldDigests: {
          amountGrosze: await callbacks.digestField({
            rowType: 'finance_entry', rowId: 'fin_panel_registry_edit',
            field: 'amountGrosze', value: 18_000,
          }),
        },
      }],
      voidIds: [],
    }
    const readPanel = async () => ({
      edits: [{
        id: 'fin_panel_registry_edit', sheet: 'Panel — Wizyty',
        values: { amountGrosze: 20_000 },
      }],
      kind: 'panel-v2', metadata, voidIds: [],
    })
    const loadPanelState = async () => ({
      fieldsByType: { finance_entry: { amountGrosze: { type: 'cents' } } },
      specialistIds: ['sp_staging_workbook_anna_janowska'],
      rows: [{
        id: 'fin_panel_registry_edit', type: 'finance_entry', version: 1,
        kind: 'income', recordType: 'income', values: panelFinanceValues(),
      }],
    })
    const preview = await previewWorkbook({
      bytes, filename: 'fictional-panel.xlsx', actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS, parse: parser, readPanel, loadPanelState,
      nonceFactory: () => new Uint8Array(16).fill(13),
    })
    expect(preview.data.panelChanges.updates).toEqual([{
      id: 'fin_panel_registry_edit', type: 'finance_entry',
      values: { amountGrosze: 20_000 },
    }])
    const sourceCountBefore = (await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_source_records',
    ).first()).count
    const imported = await createWorkbookImport({
      ...command(bytes, preview.data.previewToken, 'workbook-import-panel-edit'),
      readPanel,
      loadPanelState,
    })
    const artifact = await env.DB.prepare(
      'SELECT object_key FROM workbook_artifacts WHERE id=?',
    ).bind(imported.body.data.import.artifactId).first()
    createdObjects.push(artifact.object_key)
    const stored = await env.DB.prepare(
      'SELECT workbook_kind,plan_envelope FROM workbook_import_plans WHERE import_id=?',
    ).bind(imported.body.data.import.id).first()
    expect(stored.workbook_kind).toBe('panel-v2')
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_source_records',
    ).first()).count).toBe(sourceCountBefore)
    expect(stored.plan_envelope).not.toContain('20000')
    const envelope = JSON.parse(stored.plan_envelope)
    const dataKey = await loadDataKey(env.DB, {
      envelope,
      expectedScope: {
        type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
      },
    })
    const plan = JSON.parse(await decryptForScope(keyring, dataKey, {
      expectedScope: {
        type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
      },
      recordId: imported.body.data.import.id,
      field: 'materialization_plan',
      envelope,
    }))
    expect(plan).toEqual({
      schema: 'workbook_import_plan.v1',
      workbookKind: 'panel-v2',
      previewPlanDigest: expect.stringMatching(/^v1_[A-Za-z0-9_-]{43}$/),
      panel: {
        updates: [{
          expectedVersion: 1,
          id: 'fin_panel_registry_edit',
          type: 'finance_entry',
          values: { amountGrosze: 20_000 },
        }],
        voids: [],
      },
    })

    const continued = await continueWorkbookImport({
      db: env.DB,
      actor,
      keyring,
      config,
      centreId: 'centre_1',
      nowMs: NOW_MS + 2_000,
      correlationId: 'corr_workbook_panel_edit_continue',
      idFactory,
      importId: imported.body.data.import.id,
      expectedVersion: 1,
      idempotencyKey: 'workbook-panel-edit-continue',
    })
    expect(continued.body.data.import).toMatchObject({ status: 'complete', version: 2 })
    expect(continued.body.data.reconciliation).toMatchObject({ inserted: 0, voided: 0 })
    expect(await env.DB.prepare(`SELECT amount_grosze,paid_amount_grosze,version
      FROM finance_entries WHERE id='fin_panel_registry_edit'`).first()).toEqual({
      amount_grosze: 20_000, paid_amount_grosze: 20_000, version: 2,
    })
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM finance_adjustments
      WHERE finance_entry_id='fin_panel_registry_edit'`).first()).count).toBe(1)
    const replayed = await continueWorkbookImport({
      db: env.DB,
      actor,
      keyring,
      config,
      centreId: 'centre_1',
      nowMs: NOW_MS + 3_000,
      correlationId: 'corr_workbook_panel_edit_continue',
      idFactory,
      importId: imported.body.data.import.id,
      expectedVersion: 1,
      idempotencyKey: 'workbook-panel-edit-continue',
    })
    expect(replayed.body).toEqual(continued.body)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM finance_adjustments
      WHERE finance_entry_id='fin_panel_registry_edit'`).first()).count).toBe(1)
    const objectCount = (await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length
    const exportBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    const exported = await exportWorkbook({
      db: exportBudget.work, bucket: env.ARCHIVE, actor, keyring, config,
      centreId: 'centre_1', nowMs: NOW_MS + 4_000, format: 'panel-v2',
    })
    expect(exportBudget.usage()).toMatchObject({ used: 4, workRemaining: 38 })
    expect(exported.filename).toBe('bear-with-me-panel-v2-2027-01-15.xlsx')
    const exportedPanel = await readPanelWorkbook(exported.bytes, { verify: callbacks.verify })
    expect(exportedPanel.kind).toBe('panel-v2')
    expect(exportedPanel.metadata.scope).toEqual({ id: 'centre_1', type: 'centre' })
    expect(exportedPanel.metadata.rows).toContainEqual({
      id: 'fin_panel_registry_edit', type: 'finance_entry', baseVersion: 2,
      fieldDigests: expect.objectContaining({
        amountGrosze: expect.stringMatching(/^v1_[A-Za-z0-9_-]{43}$/),
      }),
    })
    expect(exportedPanel.edits).toContainEqual(expect.objectContaining({
      id: 'fin_panel_registry_edit',
      sheet: 'Panel — Wizyty',
      values: expect.objectContaining({ amountGrosze: 20_000 }),
    }))
    const rePreview = await previewWorkbook({
      bytes: exported.bytes,
      filename: exported.filename,
      actor,
      keyring,
      config,
      centreId: 'centre_1',
      nowMs: NOW_MS + 5_000,
      parse: parser,
      readPanel: readPanelWorkbook,
      loadPanelState: (input) => loadWorkbookPanelState({
        db: env.DB, keyring, ...input,
      }),
      nonceFactory: () => new Uint8Array(16).fill(14),
    })
    expect(rePreview.data.conflicts).toEqual([])
    expect(rePreview.data.panelChanges.updates).toEqual([])
    expect(rePreview.data.panelChanges.voidIds).toEqual([])
    expect(rePreview.data.panelChanges.unchangedIds).toContain('fin_panel_registry_edit')
    expect((await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length)
      .toBe(objectCount)
  })

  it('invalidates a preview when current Panel base state changes before exact-file commit', async () => {
    const bytes = new TextEncoder().encode('fictional-workbook-panel-stale-preview')
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring, config, centreId: 'centre_1',
    })
    const metadata = {
      format: 'Panel-v2',
      scope: { id: 'centre_1', type: 'centre' },
      rows: [{
        id: 'fin_panel_registry_edit', type: 'finance_entry', baseVersion: 2,
        fieldDigests: {
          amountGrosze: await callbacks.digestField({
            rowType: 'finance_entry', rowId: 'fin_panel_registry_edit',
            field: 'amountGrosze', value: 20_000,
          }),
        },
      }],
      voidIds: [],
    }
    const readPanel = async () => ({
      edits: [{
        id: 'fin_panel_registry_edit', sheet: 'Panel — Wizyty',
        values: { amountGrosze: 21_000 },
      }],
      kind: 'panel-v2', metadata, voidIds: [],
    })
    const stateAt = (version) => async () => ({
      fieldsByType: { finance_entry: { amountGrosze: { type: 'cents' } } },
      specialistIds: ['sp_staging_workbook_anna_janowska'],
      rows: [{
        id: 'fin_panel_registry_edit', type: 'finance_entry', version,
        kind: 'income', recordType: 'income',
        values: panelFinanceValues({ amountGrosze: 20_000, paidAmountGrosze: 20_000 }),
      }],
    })
    const preview = await previewWorkbook({
      bytes, filename: 'fictional-panel.xlsx', actor, keyring, config,
      centreId: 'centre_1', nowMs: NOW_MS, parse: parser, readPanel,
      loadPanelState: stateAt(2),
      nonceFactory: () => new Uint8Array(16).fill(13),
    })
    await env.DB.prepare(`UPDATE finance_entries SET specialist_id=?,version=3,updated_at=?
      WHERE id=? AND version=2`).bind(
      'sp_staging_workbook_julia_wolanin',
      new Date(NOW_MS + 3_000).toISOString(),
      'fin_panel_registry_edit',
    ).run()
    const beforeArtifacts = (await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_artifacts',
    ).first()).count
    const beforeObjects = (await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length
    await expect(createWorkbookImport({
      ...command(bytes, preview.data.previewToken, 'workbook-import-stale-panel-plan'),
      readPanel,
      loadPanelState: stateAt(3),
    })).rejects.toThrow(/^WORKBOOK_PREVIEW_TOKEN_INVALID$/)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM workbook_artifacts',
    ).first()).count).toBe(beforeArtifacts)
    expect((await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length)
      .toBe(beforeObjects)
  })

  it('applies a full 64-action Panel slice within the 42-query Worker budget', async () => {
    const importId = 'wbi_panel_budget_slice'
    const artifactId = 'wba_panel_budget_slice'
    const createdAt = new Date(NOW_MS + 7_000).toISOString()
    await env.DB.prepare(`WITH RECURSIVE indexes(value) AS (
        SELECT 0 UNION ALL SELECT value+1 FROM indexes WHERE value<63
      )
      INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,
       created_at,updated_at)
      SELECT printf('fin_panel_budget_%02d',value),'fib_workbook_panel_registry',
             printf('panel-budget-%02d',value),'income','income','2025-09','2025-09-02',
             18000,18000,'cash','paid','not_required',
             'sp_staging_workbook_anna_janowska',NULL,NULL,'{}','{}',1,?,?,?
      FROM indexes`).bind(actor.id, createdAt, createdAt).run()
    const actions = Array.from({ length: 64 }, (_, index) => ({
      expectedVersion: 1,
      id: `fin_panel_budget_${String(index).padStart(2, '0')}`,
      type: 'finance_entry',
      values: { amountGrosze: 19_000 + index },
    }))
    const sourceKey = await getOrCreateDataKey(env.DB, keyring, {
      type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
    }, { id: 'key_workbook_panel_budget_source', createdAt })
    const planEnvelope = JSON.stringify(await encryptForScope(keyring, sourceKey, {
      expectedScope: {
        type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
      },
      recordId: importId,
      field: 'materialization_plan',
      plaintext: JSON.stringify({
        schema: 'workbook_import_plan.v1',
        workbookKind: 'panel-v2',
        previewPlanDigest: `v1_${'A'.repeat(43)}`,
        panel: { updates: actions, voids: [] },
      }),
    }))
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
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_artifacts
        (id,centre_id,environment,fingerprint,byte_size,parser_version,
         materializer_version,object_key,content_nonce_b64,workbook_kek_version,
         metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        artifactId, 'centre_1', 'staging', 'c'.repeat(64), 64, 2, 2,
        'workbook-objects/wbo_panel_budget_slice_0000000000000000',
        'A'.repeat(16), 1, 1, 'B'.repeat(43), actor.id, createdAt,
      ),
      env.DB.prepare(`INSERT INTO workbook_templates
        (id,artifact_id,format,source_kind,created_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?)`).bind(
        'wbt_panel_budget_slice', artifactId, 'panel-v2', 'panel_round_trip',
        actor.id, createdAt,
      ),
      env.DB.prepare(`INSERT INTO workbook_imports
        (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
         correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        importId, artifactId, 'C'.repeat(43), 'ready', 0, 0,
        'corr_workbook_panel_budget_import', actor.id, 1, createdAt, createdAt, null,
      ),
      env.DB.prepare(`INSERT INTO workbook_import_plans
        (import_id,workbook_kind,plan_version,plan_envelope,created_at)
        VALUES (?,?,?,?,?)`).bind(importId, 'panel-v2', 1, planEnvelope, createdAt),
      env.DB.prepare(`INSERT INTO workbook_materialization_jobs
        (id,import_id,phase,status,cursor,total_records,processed_records,
         progress_json,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wbj_panel_budget_slice', importId, 'apply_finance', 'ready', 0, 64, 0,
        progress, actor.id, 1, createdAt, createdAt, null,
      ),
    ])
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const result = await continueWorkbookImport({
      db: budget.work,
      actor,
      keyring,
      config,
      centreId: 'centre_1',
      nowMs: NOW_MS + 8_000,
      correlationId: 'corr_workbook_panel_budget_slice',
      idFactory,
      importId,
      expectedVersion: 1,
      idempotencyKey: 'workbook-panel-budget-slice',
    })

    expect(result.body.data.import).toMatchObject({ status: 'complete', version: 2 })
    expect(budget.usage().used).toBeLessThanOrEqual(42)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM finance_entries
      WHERE id LIKE 'fin_panel_budget_%' AND version=2
        AND paid_amount_grosze=amount_grosze`).first()).count).toBe(64)
  })
})
