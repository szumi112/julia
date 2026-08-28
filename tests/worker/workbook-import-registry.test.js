import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APPROVED_WORKBOOK_FINGERPRINT,
  createWorkbookImport,
  continueWorkbookImport,
  exportWorkbook,
  getWorkbookImport,
  loadWorkbookPanelState,
  previewWorkbook as previewWorkbookCore,
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
  patchPanelWorkbook,
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
const PANEL_FINANCE_COLUMNS = Object.freeze([
  Object.freeze({ key: 'accountingMonth', label: 'Miesiąc księgowy', type: 'text', width: 16 }),
  Object.freeze({ key: 'occurredOn', label: 'Data', type: 'date', width: 14 }),
  Object.freeze({ key: 'amountGrosze', label: 'Kwota (gr)', type: 'cents', width: 16 }),
  Object.freeze({ key: 'paidAmountGrosze', label: 'Zapłacono (gr)', type: 'cents', width: 18 }),
  Object.freeze({ key: 'paymentMethod', label: 'Sposób płatności', type: 'enum', values: ['blik', 'card', 'cash', 'monthly', 'other', 'transfer', 'unknown'], width: 18 }),
  Object.freeze({ key: 'settlementStatus', label: 'Rozliczenie', type: 'enum', values: ['paid', 'partial', 'unknown', 'unpaid'], width: 16 }),
  Object.freeze({ key: 'invoiceStatus', label: 'Faktura', type: 'enum', values: ['action_required', 'issued', 'not_issued', 'not_required', 'unknown'], width: 18 }),
  Object.freeze({ key: 'specialistId', label: 'ID specjalisty', type: 'text', width: 28 }),
])
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
let panelExportSeed
const previewDb = Object.freeze({
  prepare(sql) {
    if (sql.includes('SELECT id,display_name_envelope FROM specialists')) return {
      async all() { return { results: [] } },
    }
    return env.DB.prepare(sql)
  },
  batch(statements) { return env.DB.batch(statements) },
})
const previewWorkbook = (input) => previewWorkbookCore({ db: previewDb, ...input })

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
  for (const action of [
    'edit', 'void', 'race', 'preview_edit', 'preview_void', 'historical', 'historical_race',
  ]) {
    const entryId = `fin_panel_dependency_${action}`
    const historical = action.startsWith('historical')
    const seal = async (field, value) => JSON.stringify(await encryptForScope(
      keyring, financeKey, {
        expectedScope: FINANCE_SCOPE, recordId: entryId, field,
        plaintext: JSON.stringify(value),
      },
    ))
    await env.DB.prepare(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,
       created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      entryId, 'fib_workbook_panel_registry', `panel-dependency-${action}`,
      'income', historical ? 'income' : 'english', '2025-09', '2025-09-02',
      34_000, 0, 'unknown', 'unpaid',
      'not_required', 'sp_staging_workbook_anna_janowska', null, null,
      await seal('details', {
        schema: 'finance_entry_details.v1', counterparty: 'Fikcyjna osoba',
        sourceLabel: historical ? 'Fikcyjna konsultacja historyczna' : 'Fikcyjny angielski',
        invoiceNote: '', lessonCount: historical ? null : 1,
      }),
      await seal('source_row', {
        schema: 'finance_entry_source.v1', source: {
          batchId: 'fib_workbook_panel_registry', sourceKey: `panel-dependency-${action}`,
          sheet: 'Panel — Wizyty',
          rowNumber: action === 'edit' ? 4 : action === 'void' ? 5 : 6, raw: {},
        },
      }),
      1, actor.id, NOW, NOW,
    ).run()
    if (!historical) await env.DB.prepare(`INSERT INTO activity_participants
      (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
       created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
      `acp_panel_dependency_${action}`, 'apg_english', '{}', null, null,
      'active', 1, NOW, NOW,
    ).run()
  }
})

afterAll(async () => {
  panelExportSeed?.fill(0)
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
const exportedPanelMutation = async ({ action, entryId }) => {
  const callbacks = createWorkbookPanelMetadataCallbacks({
    keyring, config, centreId: 'centre_1',
  })
  expect(panelExportSeed).toBeInstanceOf(Uint8Array)
  const panelExport = await readPanelWorkbook(panelExportSeed, { verify: callbacks.verify })
  const source = panelExport.edits.find(({ id }) => id === entryId)
  const metadataRow = panelExport.metadata.rows.find(({ id }) => id === entryId)
  expect(source).toBeDefined()
  expect(metadataRow).toBeDefined()
  const values = action === 'edit'
    ? { ...source.values, amountGrosze: source.values.amountGrosze + 1_000 }
    : source.values
  const scoped = await createScopedPanelWorkbook({
    allowedRowIds: [entryId],
    allowedSheets: [{ name: 'Panel — Wizyty', columns: PANEL_FINANCE_COLUMNS }],
    metadata: {
      format: 'Panel-v2', rows: [metadataRow], scope: panelExport.metadata.scope,
      voidIds: action === 'void' ? [entryId] : [],
    },
    sheets: [{
      name: 'Panel — Wizyty', columns: PANEL_FINANCE_COLUMNS,
      rows: [{ id: entryId, values }],
    }],
  }, { sign: callbacks.sign })
  if (action !== 'void') return scoped
  const patched = await patchPanelWorkbook(scoped, {
    includePermissions: false,
    metadata: {
      format: 'Panel-v2', rows: [metadataRow], scope: panelExport.metadata.scope,
      voidIds: [entryId],
    },
    sheets: [{ name: 'Panel — Wizyty', columns: PANEL_FINANCE_COLUMNS, rows: [] }],
  }, { sign: callbacks.sign })
  scoped.fill(0)
  return patched
}
const addHistoricalDependency = async (entryId, suffix) => {
  const sourceImportId = await env.DB.prepare(`SELECT id FROM workbook_imports
    WHERE status='complete' ORDER BY completed_at DESC,id DESC LIMIT 1`).first('id')
  expect(sourceImportId).toMatch(/^wbi_/)
  const sourceId = `wbs_panel_dependency_${suffix}`
  await env.DB.prepare(`INSERT INTO workbook_source_records
    (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,record_type,
     disposition,accounting_month,occurred_on,period_precision,period_month,amount_grosze,
     payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
     record_digest,record_digest_hmac_version,specialist_source_digest,
     specialist_source_hmac_version,warning_codes_json,source_payload_version,
     source_payload_envelope,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    sourceId, sourceImportId, `workbook:v1:9:${suffix.length + 10}:0`, 9,
    'Fikcyjna historia', suffix.length + 10, 0, 'income', 'accepted', '2025-09',
    '2025-09-02', 'day', '2025-09', 34_000, 'unknown', 'unpaid', 'not_required', 0,
    'R'.repeat(43), 1, 'S'.repeat(43), 1, '[]', 1, '{}', NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO finance_source_links
    (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
    VALUES (?,?,?,?,?,?)`).bind(
    `fsl_panel_dependency_${suffix}`, sourceId, entryId, 'reconciled', actor.id, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO historical_clients
    (id,identity_envelope,status,active_client_id,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).bind(
    `hcl_panel_dependency_${suffix}`, '{}', 'historical', null, 1, NOW, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO historical_client_source_links
    (id,historical_client_id,source_record_id,created_at) VALUES (?,?,?,?)`).bind(
    `hcs_panel_dependency_${suffix}`, `hcl_panel_dependency_${suffix}`, sourceId, NOW,
  ).run()
  await env.DB.prepare(`INSERT INTO historical_service_occurrences
    (id,source_record_id,historical_client_id,counterparty_id,specialist_id,
     service_id,service_label_envelope,period_precision,occurred_on,occurred_month,
     status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    `hoc_panel_dependency_${suffix}`, sourceId, `hcl_panel_dependency_${suffix}`, null,
    'sp_staging_workbook_anna_janowska', 'konsultacja', '{}', 'day', '2025-09-02',
    '2025-09', 'recorded', 1, NOW, NOW,
  ).run()
}
const importWriteEvidence = async () => ({
  artifacts: (await env.DB.prepare('SELECT count(*) AS count FROM workbook_artifacts').first()).count,
  audits: (await env.DB.prepare("SELECT count(*) AS count FROM audit_events WHERE action LIKE 'workbook.%'").first()).count,
  imports: (await env.DB.prepare('SELECT count(*) AS count FROM workbook_imports').first()).count,
  objects: (await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length,
  outbox: (await env.DB.prepare('SELECT count(*) AS count FROM outbox_jobs').first()).count,
  replays: (await env.DB.prepare("SELECT count(*) AS count FROM workbook_request_replays WHERE operation='workbooks.import'").first()).count,
})
const withoutCurrentAuthority = Object.freeze({
  prepare(sql) {
    if (sql.includes('FROM staff_authorities AS authority')) return {
      bind() { return this },
      async all() { return { results: [] } },
    }
    return env.DB.prepare(sql)
  },
  batch(statements) { return env.DB.batch(statements) },
})

describe('workbook import reservation', () => {
  it('requires exact opaque mapping choices and persists an effective versioned mapping', async () => {
    const bytes = new TextEncoder().encode('fictional-legacy-mapping-resolution')
    let parses = 0
    const parseUnknown = async (arrayBuffer, options) => {
      parses += 1
      const value = await parser(arrayBuffer, options)
      return Object.freeze({
        ...value,
        fingerprint: APPROVED_WORKBOOK_FINGERPRINT,
        rows: Object.freeze([Object.freeze({
          ...value.rows[0], specialistName: 'Fikcyjna Nieznana Specjalistka',
          periodPrecision: 'day', periodMonth: '2025-09',
        })]),
        quarantinedRows: Object.freeze([]),
      })
    }
    const readLegacy = async () => ({
      edits: [], kind: 'legacy', metadata: null, voidIds: [],
    })
    const preview = await previewWorkbook({
      bytes, filename: 'fictional-legacy.xlsx', actor, keyring, config,
      centreId: 'centre_1', nowMs: NOW_MS, parse: parseUnknown,
      readPanel: readLegacy, nonceFactory: () => new Uint8Array(16).fill(13),
    })
    const conflict = preview.data.conflicts[0]
    expect(conflict).toMatchObject({
      id: expect.stringMatching(/^wmc_[A-Za-z0-9_-]{43}$/),
      code: 'SPECIALIST_MAPPING_REQUIRED',
      sourceValue: 'Fikcyjna Nieznana Specjalistka',
    })
    const storeArtifact = async ({ objectKey }) => ({
      environment: 'staging', centreId: 'centre_1', objectKey,
      fingerprint: APPROVED_WORKBOOK_FINGERPRINT, byteSize: bytes.byteLength,
      parserVersion: 2, materializerVersion: 2, contentNonce: 'A'.repeat(16),
      workbookKekVersion: 1, metadataHmacVersion: 1,
      metadataSignature: 'B'.repeat(43),
    })
    const base = {
      ...command(bytes, preview.data.previewToken, 'workbook-import-mapping'),
      filename: 'fictional-legacy.xlsx', parse: parseUnknown, readPanel: readLegacy,
      storeArtifact,
    }
    await expect(createWorkbookImport(base)).rejects.toThrow(/^WORKBOOK_IMPORT_CONFLICT$/)
    await expect(createWorkbookImport({
      ...base,
      idempotencyKey: 'workbook-import-mapping-extra',
      resolutions: [{
        conflictId: `wmc_${'x'.repeat(43)}`,
        specialistId: 'sp_staging_workbook_anna_janowska',
      }],
    })).rejects.toThrow(/^WORKBOOK_IMPORT_CONFLICT$/)
    const imported = await createWorkbookImport({
      ...base,
      resolutions: [{
        conflictId: conflict.id,
        specialistId: 'sp_staging_workbook_anna_janowska',
      }],
    })
    const afterImported = await importWriteEvidence()
    for (const resolutions of [[], [{
      conflictId: `wmc_${'x'.repeat(43)}`,
      specialistId: 'sp_staging_workbook_anna_janowska',
    }], [{
      conflictId: conflict.id,
      specialistId: 'sp_staging_workbook_julia_wolanin',
    }]]) await expect(createWorkbookImport({
      ...base,
      idFactory: () => 'must_not_generate',
      resolutions,
    })).rejects.toThrow(/^IDEMPOTENCY_CONFLICT$/)
    expect(await importWriteEvidence()).toEqual(afterImported)
    expect(parses).toBe(7)
    expect(await env.DB.prepare(`SELECT specialist_id FROM workbook_resolutions
      WHERE import_id=? AND kind='specialist_mapping'`).bind(
      imported.body.data.import.id,
    ).first('specialist_id')).toBe('sp_staging_workbook_anna_janowska')
    expect(await env.DB.prepare(`SELECT version,resolution_count
      FROM workbook_import_resolution_sets WHERE import_id=?`).bind(
      imported.body.data.import.id,
    ).first()).toEqual({ version: 1, resolution_count: 1 })
    const endedAt = new Date(NOW_MS + 2_000).toISOString()
    await env.DB.prepare(`UPDATE workbook_materialization_jobs
      SET status='failed',version=version+1,updated_at=? WHERE import_id=?`).bind(
      endedAt, imported.body.data.import.id,
    ).run()
    await env.DB.prepare(`UPDATE workbook_imports
      SET status='failed',version=version+1,updated_at=? WHERE id=?`).bind(
      endedAt, imported.body.data.import.id,
    ).run()
  })

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

  it('does not authorize a new Panel assignment to a non-active specialist', async () => {
    await env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,professional_title_envelope,
       standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      'sp_panel_pending_assignment', null, '{}', '{}', 18_000, 'pending', 1,
      null, NOW, NOW,
    ).run()
    const state = await loadWorkbookPanelState({
      db: env.DB, keyring, centreId: 'centre_1', rows: [],
      specialistIds: ['sp_panel_pending_assignment'],
    })
    expect(state.specialistIds).toEqual([])
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

    await expect(createWorkbookImport({
      ...command(bytes, preview.data.previewToken, 'workbook-import-one'),
      db: withoutCurrentAuthority,
    })).rejects.toThrow(/^NOT_FOUND$/)

    const beforeExpiredReplay = await importWriteEvidence()
    await expect(createWorkbookImport({
      ...command(bytes, preview.data.previewToken, 'workbook-import-one'),
      nowMs: NOW_MS + 10 * 60_000,
    })).rejects.toThrow(/^WORKBOOK_PREVIEW_TOKEN_INVALID$/)
    const changedToken = await previewWorkbook({
      bytes, filename: 'fictional-panel.xlsx', actor, keyring, config,
      centreId: 'centre_1', nowMs: NOW_MS + 10 * 60_000, parse: parser, readPanel: panel,
      nonceFactory: () => new Uint8Array(16).fill(12),
    })
    const replay = await createWorkbookImport({
      ...command(bytes, changedToken.data.previewToken, 'workbook-import-one'),
      nowMs: NOW_MS + 10 * 60_000 + 1,
    })
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(await importWriteEvidence()).toEqual(beforeExpiredReplay)

    let duplicateStoreCalled = false
    await expect(createWorkbookImport({
      ...command(bytes, changedToken.data.previewToken, 'workbook-import-new-key'),
      nowMs: NOW_MS + 10 * 60_000 + 1,
      async storeArtifact() {
        duplicateStoreCalled = true
        throw new Error('must not store a duplicate artifact')
      },
    })).rejects.toThrow(/^WORKBOOK_IMPORT_CONFLICT$/)
    expect(duplicateStoreCalled).toBe(false)
    expect(await importWriteEvidence()).toEqual(beforeExpiredReplay)

    await expect(createWorkbookImport({
      ...command(
        new TextEncoder().encode('fictional-workbook-registry-one-altered'),
        changedToken.data.previewToken,
        'workbook-import-one',
      ),
      nowMs: NOW_MS + 10 * 60_000 + 2,
    })).rejects.toThrow(/^WORKBOOK_PREVIEW_TOKEN_INVALID$/)
    expect(await importWriteEvidence()).toEqual(beforeExpiredReplay)
    const status = await getWorkbookImport({
      db: env.DB, actor, nowMs: NOW_MS + 2_000, importId: first.body.data.import.id,
    })
    await expect(getWorkbookImport({
      db: withoutCurrentAuthority, actor, nowMs: NOW_MS + 2_000,
      importId: first.body.data.import.id,
    })).rejects.toThrow(/^NOT_FOUND$/)
    expect(status).toEqual({
      data: {
        import: first.body.data.import,
        evidence: { createdRecords: 0, voidedRecords: 0, converged: false },
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

  it('rejects an expired preview with no replay before any D1 or R2 write', async () => {
    const bytes = new TextEncoder().encode('fictional-workbook-registry-expired')
    const preview = await previewFor(bytes)
    const before = await importWriteEvidence()

    await expect(createWorkbookImport({
      ...command(bytes, preview.data.previewToken, 'workbook-import-expired-new'),
      nowMs: NOW_MS + 10 * 60_000,
    })).rejects.toThrow(/^WORKBOOK_PREVIEW_TOKEN_INVALID$/)

    expect(await importWriteEvidence()).toEqual(before)
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

  it('preserves a committed artifact when D1 reports a lost batch response', async () => {
    const bytes = new TextEncoder().encode('fictional-workbook-commit-response-lost')
    const preview = await previewFor(bytes)
    const beforeObjects = (await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length
    let loseResponse = true
    const commitThenThrowDb = {
      prepare(sql) { return env.DB.prepare(sql) },
      async batch(statements) {
        const result = await env.DB.batch(statements)
        if (loseResponse) {
          loseResponse = false
          throw new Error('D1_RESPONSE_LOST')
        }
        return result
      },
    }
    const operation = command(bytes, preview.data.previewToken, 'workbook-import-lost-batch')
    const recovered = await createWorkbookImport({ ...operation, db: commitThenThrowDb })
    const artifact = await env.DB.prepare(
      'SELECT object_key FROM workbook_artifacts WHERE id=?',
    ).bind(recovered.body.data.import.artifactId).first()
    createdObjects.push(artifact.object_key)
    expect(await env.ARCHIVE.get(artifact.object_key)).not.toBeNull()
    expect((await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length)
      .toBe(beforeObjects + 1)
    const replayed = await createWorkbookImport(operation)
    expect(replayed.body).toEqual(recovered.body)
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
    let liveInspectionAllowed = true
    const loadPanelState = async () => {
      if (!liveInspectionAllowed) throw new Error('LIVE_LEDGER_CHANGED')
      return ({
      fieldsByType: { finance_entry: { amountGrosze: { type: 'cents' } } },
      specialistIds: ['sp_staging_workbook_anna_janowska'],
      rows: [{
        id: 'fin_panel_registry_edit', type: 'finance_entry', version: 1,
        kind: 'income', recordType: 'income', values: panelFinanceValues(),
      }],
      })
    }
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
    const recovered = await createWorkbookImport({
      ...command(bytes, preview.data.previewToken, 'workbook-import-panel-edit'),
      readPanel,
      loadPanelState,
    })
    expect(recovered.body).toEqual(imported.body)
    liveInspectionAllowed = false
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
      conflicts: [],
      appliedResolutions: [],
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
    await expect(continueWorkbookImport({
      db: env.DB,
      actor,
      keyring,
      config,
      centreId: 'centre_1',
      nowMs: NOW_MS + 3_500,
      correlationId: 'corr_workbook_panel_edit_continue',
      idFactory,
      importId: imported.body.data.import.id,
      expectedVersion: 1,
      idempotencyKey: 'workbook-panel-edit-continue-unrecorded',
    })).rejects.toThrow(/^VERSION_CONFLICT$/)
    const objectCount = (await env.ARCHIVE.list({ prefix: 'workbook-objects/' })).objects.length
    const exportBudget = createD1QueryBudget(env.DB, {
      totalLimit: 50, recoveryReserve: 8,
    })
    const exported = await exportWorkbook({
      db: exportBudget.work, bucket: env.ARCHIVE, actor, keyring, config,
      centreId: 'centre_1', nowMs: NOW_MS + 4_000, format: 'panel-v2',
    })
    panelExportSeed?.fill(0)
    panelExportSeed = exported.bytes.slice()
    expect(exportBudget.usage()).toMatchObject({ used: 6, workRemaining: 36 })
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

  it.each(['edit', 'void'])(
    'rejects a generated Panel %s when an activity dependency appears after preview',
    async (action) => {
      const entryId = `fin_panel_dependency_${action}`
      const bytes = await exportedPanelMutation({ action, entryId })
      const loadPanelState = (input) => loadWorkbookPanelState({
        db: env.DB, keyring, ...input,
      })
      const preview = await previewWorkbook({
        bytes, filename: 'fictional-panel.xlsx', actor, keyring, config, centreId: 'centre_1',
        nowMs: NOW_MS, parse: parser, readPanel: readPanelWorkbook, loadPanelState,
        nonceFactory: () => new Uint8Array(16).fill(13),
      })
      expect(preview.data.conflicts).toEqual([])
      const imported = await createWorkbookImport({
        ...command(bytes, preview.data.previewToken, `workbook-panel-dependency-${action}`),
        readPanel: readPanelWorkbook, loadPanelState,
      })
      const artifact = await env.DB.prepare(
        'SELECT object_key FROM workbook_artifacts WHERE id=?',
      ).bind(imported.body.data.import.artifactId).first()
      createdObjects.push(artifact.object_key)
      await env.DB.prepare(`INSERT INTO activity_charges
        (id,participant_id,program_id,group_id,membership_id,period_precision,
         occurred_on,accounting_month,lesson_count,responsible_specialist_id,
         finance_entry_id,status,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        `ach_panel_dependency_${action}`, `acp_panel_dependency_${action}`,
        'apg_english', null, null, 'day', '2025-09-02', '2025-09', 1,
        'sp_staging_workbook_anna_janowska', entryId, 'active', 1, NOW, NOW,
      ).run()
      await expect(continueWorkbookImport({
        db: env.DB, actor, keyring, config, centreId: 'centre_1',
        nowMs: NOW_MS + 2_000, correlationId: `corr_panel_dependency_${action}`,
        idFactory, importId: imported.body.data.import.id, expectedVersion: 1,
        idempotencyKey: `workbook-panel-dependency-continue-${action}`,
      })).rejects.toThrow(/^WORKBOOK_IMPORT_CONFLICT$/)
      expect(await env.DB.prepare(`SELECT version FROM finance_entries WHERE id=?`).bind(
        entryId,
      ).first('version')).toBe(1)
      expect(await env.DB.prepare(`SELECT status,cursor,version
        FROM workbook_materialization_jobs WHERE import_id=?`).bind(
        imported.body.data.import.id,
      ).first()).toEqual({ status: 'ready', cursor: 0, version: 1 })
    },
  )

  it.each([
    ['edit', 'preview_edit'],
    ['void', 'preview_void'],
  ])('blocks a generated activity-linked Panel %s during real preview', async (action, suffix) => {
    const entryId = `fin_panel_dependency_${suffix}`
    await env.DB.prepare(`INSERT INTO activity_charges
      (id,participant_id,program_id,group_id,membership_id,period_precision,
       occurred_on,accounting_month,lesson_count,responsible_specialist_id,
       finance_entry_id,status,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      `ach_panel_dependency_${suffix}`, `acp_panel_dependency_${suffix}`,
      'apg_english', null, null, 'day', '2025-09-02', '2025-09', 1,
      'sp_staging_workbook_anna_janowska', entryId, 'active', 1, NOW, NOW,
    ).run()
    const bytes = await exportedPanelMutation({ action, entryId })
    const preview = await previewWorkbook({
      bytes, filename: 'fictional-panel.xlsx', actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS, parse: parser, readPanel: readPanelWorkbook,
      loadPanelState: (input) => loadWorkbookPanelState({ db: env.DB, keyring, ...input }),
      nonceFactory: () => new Uint8Array(16).fill(13),
    })
    expect(preview.data.conflicts).toEqual([{
      code: 'PANEL_DEPENDENCY_CONFLICT', field: null, recordId: entryId,
    }])
    expect(preview.data.panelChanges).toEqual({
      unchangedIds: [], updates: [], voidIds: [],
    })
  })

  it('blocks a generated historical-occurrence-linked signed void during real preview', async () => {
    const entryId = 'fin_panel_dependency_historical'
    await addHistoricalDependency(entryId, 'historical')
    const bytes = await exportedPanelMutation({ action: 'void', entryId })
    const preview = await previewWorkbook({
      bytes, filename: 'fictional-panel.xlsx', actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS, parse: parser, readPanel: readPanelWorkbook,
      loadPanelState: (input) => loadWorkbookPanelState({ db: env.DB, keyring, ...input }),
      nonceFactory: () => new Uint8Array(16).fill(13),
    })
    expect(preview.data.conflicts).toEqual([{
      code: 'PANEL_DEPENDENCY_CONFLICT', field: null, recordId: entryId,
    }])
    expect(preview.data.panelChanges.voidIds).toEqual([])
  })

  it('rejects a generated signed void when a historical dependency appears after preview', async () => {
    const entryId = 'fin_panel_dependency_historical_race'
    const bytes = await exportedPanelMutation({ action: 'void', entryId })
    const loadPanelState = (input) => loadWorkbookPanelState({
      db: env.DB, keyring, ...input,
    })
    const preview = await previewWorkbook({
      bytes, filename: 'fictional-panel.xlsx', actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS, parse: parser, readPanel: readPanelWorkbook, loadPanelState,
      nonceFactory: () => new Uint8Array(16).fill(13),
    })
    expect(preview.data.conflicts).toEqual([])
    const imported = await createWorkbookImport({
      ...command(bytes, preview.data.previewToken, 'workbook-panel-historical-race'),
      readPanel: readPanelWorkbook, loadPanelState,
    })
    const artifact = await env.DB.prepare(
      'SELECT object_key FROM workbook_artifacts WHERE id=?',
    ).bind(imported.body.data.import.artifactId).first()
    createdObjects.push(artifact.object_key)
    await addHistoricalDependency(entryId, 'historical_race')
    await expect(continueWorkbookImport({
      db: env.DB, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 2_000, correlationId: 'corr_panel_historical_race',
      idFactory, importId: imported.body.data.import.id, expectedVersion: 1,
      idempotencyKey: 'workbook-panel-historical-continue-race',
    })).rejects.toThrow(/^WORKBOOK_IMPORT_CONFLICT$/)
    expect(await env.DB.prepare(`SELECT version FROM finance_entries WHERE id=?`).bind(
      entryId,
    ).first('version')).toBe(1)
    expect(await env.DB.prepare(`SELECT status,cursor,version
      FROM workbook_materialization_jobs WHERE import_id=?`).bind(
      imported.body.data.import.id,
    ).first()).toEqual({ status: 'ready', cursor: 0, version: 1 })
  })

  it('rolls back a Panel slice when an activity dependency wins the D1 race', async () => {
    const entryId = 'fin_panel_dependency_race'
    const bytes = new TextEncoder().encode('fictional-panel-dependency-race')
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring, config, centreId: 'centre_1',
    })
    const metadata = {
      format: 'Panel-v2', scope: { id: 'centre_1', type: 'centre' },
      rows: [{
        id: entryId, type: 'finance_entry', baseVersion: 1,
        fieldDigests: { amountGrosze: await callbacks.digestField({
          rowType: 'finance_entry', rowId: entryId,
          field: 'amountGrosze', value: 34_000,
        }) },
      }], voidIds: [],
    }
    const readPanel = async () => ({
      edits: [{ id: entryId, sheet: 'Panel — Wizyty', values: { amountGrosze: 35_000 } }],
      kind: 'panel-v2', metadata, voidIds: [],
    })
    const loadPanelState = (input) => loadWorkbookPanelState({
      db: env.DB, keyring, ...input,
    })
    const preview = await previewWorkbook({
      bytes, filename: 'fictional-panel.xlsx', actor, keyring, config,
      centreId: 'centre_1', nowMs: NOW_MS, parse: parser, readPanel, loadPanelState,
      nonceFactory: () => new Uint8Array(16).fill(13),
    })
    const imported = await createWorkbookImport({
      ...command(bytes, preview.data.previewToken, 'workbook-panel-dependency-race'),
      readPanel, loadPanelState,
    })
    const artifact = await env.DB.prepare(
      'SELECT object_key FROM workbook_artifacts WHERE id=?',
    ).bind(imported.body.data.import.artifactId).first()
    createdObjects.push(artifact.object_key)
    let raced = false
    const racedDb = {
      prepare(sql) { return env.DB.prepare(sql) },
      async batch(statements) {
        if (!raced) {
          raced = true
          await env.DB.prepare(`INSERT INTO activity_charges
            (id,participant_id,program_id,group_id,membership_id,period_precision,
             occurred_on,accounting_month,lesson_count,responsible_specialist_id,
             finance_entry_id,status,version,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
            'ach_panel_dependency_race', 'acp_panel_dependency_race', 'apg_english',
            null, null, 'day', '2025-09-02', '2025-09', 1,
            'sp_staging_workbook_anna_janowska', entryId, 'active', 1, NOW, NOW,
          ).run()
        }
        return env.DB.batch(statements)
      },
    }
    await expect(continueWorkbookImport({
      db: racedDb, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 2_000, correlationId: 'corr_panel_dependency_race',
      idFactory, importId: imported.body.data.import.id, expectedVersion: 1,
      idempotencyKey: 'workbook-panel-dependency-continue-race',
    })).rejects.toThrow(/^WORKBOOK_IMPORT_CONFLICT$/)
    expect(await env.DB.prepare(`SELECT amount_grosze,version FROM finance_entries
      WHERE id=?`).bind(entryId).first()).toEqual({ amount_grosze: 34_000, version: 1 })
    expect(await env.DB.prepare(`SELECT status,cursor,version
      FROM workbook_materialization_jobs WHERE import_id=?`).bind(
      imported.body.data.import.id,
    ).first()).toEqual({ status: 'ready', cursor: 0, version: 1 })
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

  it('treats a manual void as a permanent Panel tombstone at read and apply boundaries', async () => {
    const createdAt = new Date(NOW_MS + 10_000).toISOString()
    await env.DB.prepare(`INSERT INTO finance_manual_voids
      (id,finance_entry_id,expected_entry_version,reason_envelope,
       voided_by_staff_id,created_at) VALUES (?,?,?,?,?,?)`).bind(
      'fmv_panel_registry_tombstone', 'fin_panel_registry_edit', 3, '{}',
      actor.id, createdAt,
    ).run()
    const state = await loadWorkbookPanelState({
      db: env.DB, keyring, centreId: 'centre_1',
      rows: [{ id: 'fin_panel_registry_edit', type: 'finance_entry' }],
    })
    expect(state.rows).toEqual([])

    const importId = 'wbi_panel_manual_void_stale'
    const sourceKey = await getOrCreateDataKey(env.DB, keyring, {
      type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
    }, { id: 'key_panel_manual_void_stale', createdAt })
    const planEnvelope = JSON.stringify(await encryptForScope(keyring, sourceKey, {
      expectedScope: {
        type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
      },
      recordId: importId,
      field: 'materialization_plan',
      plaintext: JSON.stringify({
        schema: 'workbook_import_plan.v1', workbookKind: 'panel-v2',
        previewPlanDigest: `v1_${'M'.repeat(43)}`,
        panel: { updates: [{
          id: 'fin_panel_registry_edit', type: 'finance_entry', expectedVersion: 3,
          values: { amountGrosze: 22_000 },
        }], voids: [] },
      }),
    }))
    const progress = JSON.stringify({
      accepted: 0, accountingMonthsCorrected: 0, candidateCount: 0,
      financeBatchId: null, fixedRevenuesInserted: 0, formulaGhostsVoided: 0,
      inserted: 0, linked: 0, quarantined: 0, quarantinedVoided: 0,
      specialistAssignmentsCorrected: 0, textAmountVisitsInserted: 0, voided: 0,
    })
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_artifacts
        (id,centre_id,environment,fingerprint,byte_size,parser_version,
         materializer_version,object_key,content_nonce_b64,workbook_kek_version,
         metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wba_panel_manual_void_stale', 'centre_1', 'staging', 'd'.repeat(64), 64,
        2, 2, 'workbook-objects/wbo_panel_manual_void_stale_000000000000',
        'A'.repeat(16), 1, 1, 'B'.repeat(43), actor.id, createdAt,
      ),
      env.DB.prepare(`INSERT INTO workbook_templates
        (id,artifact_id,format,source_kind,created_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?)`).bind(
        'wbt_panel_manual_void_stale', 'wba_panel_manual_void_stale', 'panel-v2',
        'panel_round_trip', actor.id, createdAt,
      ),
      env.DB.prepare(`INSERT INTO workbook_imports
        (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
         correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        importId, 'wba_panel_manual_void_stale', 'V'.repeat(43), 'ready', 0, 0,
        'corr_panel_manual_void_stale', actor.id, 1, createdAt, createdAt, null,
      ),
      env.DB.prepare(`INSERT INTO workbook_import_plans
        (import_id,workbook_kind,plan_version,plan_envelope,created_at)
        VALUES (?,?,?,?,?)`).bind(importId, 'panel-v2', 1, planEnvelope, createdAt),
      env.DB.prepare(`INSERT INTO workbook_materialization_jobs
        (id,import_id,phase,status,cursor,total_records,processed_records,
         progress_json,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wbj_panel_manual_void_stale', importId, 'apply_finance', 'ready', 0, 1, 0,
        progress, actor.id, 1, createdAt, createdAt, null,
      ),
    ])
    await expect(continueWorkbookImport({
      db: env.DB, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 11_000, correlationId: 'corr_panel_manual_void_continue',
      idFactory, importId, expectedVersion: 1,
      idempotencyKey: 'workbook-panel-manual-void-stale',
    })).rejects.toThrow(/^VERSION_CONFLICT$/)
    expect(await env.DB.prepare(`SELECT amount_grosze,version FROM finance_entries
      WHERE id='fin_panel_registry_edit'`).first()).toEqual({
      amount_grosze: 20_000, version: 3,
    })

    const voidImportId = 'wbi_panel_manual_void_stale_void'
    const voidEnvelope = JSON.stringify(await encryptForScope(keyring, sourceKey, {
      expectedScope: {
        type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
      },
      recordId: voidImportId,
      field: 'materialization_plan',
      plaintext: JSON.stringify({
        schema: 'workbook_import_plan.v1', workbookKind: 'panel-v2',
        previewPlanDigest: `v1_${'N'.repeat(43)}`,
        panel: { updates: [], voids: [{
          id: 'fin_panel_registry_edit', type: 'finance_entry', expectedVersion: 3,
        }] },
      }),
    }))
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workbook_artifacts
        (id,centre_id,environment,fingerprint,byte_size,parser_version,
         materializer_version,object_key,content_nonce_b64,workbook_kek_version,
         metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wba_panel_manual_void_stale_void', 'centre_1', 'staging', 'e'.repeat(64), 64,
        2, 2, 'workbook-objects/wbo_panel_manual_void_stale_void_00000000',
        'A'.repeat(16), 1, 1, 'B'.repeat(43), actor.id, createdAt,
      ),
      env.DB.prepare(`INSERT INTO workbook_templates
        (id,artifact_id,format,source_kind,created_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?)`).bind(
        'wbt_panel_manual_void_stale_void', 'wba_panel_manual_void_stale_void',
        'panel-v2', 'panel_round_trip', actor.id, createdAt,
      ),
      env.DB.prepare(`INSERT INTO workbook_imports
        (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
         correlation_id,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        voidImportId, 'wba_panel_manual_void_stale_void', 'W'.repeat(43), 'ready', 0, 0,
        'corr_panel_manual_void_stale_void', actor.id, 1, createdAt, createdAt, null,
      ),
      env.DB.prepare(`INSERT INTO workbook_import_plans
        (import_id,workbook_kind,plan_version,plan_envelope,created_at)
        VALUES (?,?,?,?,?)`).bind(voidImportId, 'panel-v2', 1, voidEnvelope, createdAt),
      env.DB.prepare(`INSERT INTO workbook_import_plan_summaries
        (import_id,mapping_conflict_count) VALUES (?,0)`).bind(voidImportId),
      env.DB.prepare(`INSERT INTO workbook_materialization_jobs
        (id,import_id,phase,status,cursor,total_records,processed_records,
         progress_json,created_by_staff_id,version,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        'wbj_panel_manual_void_stale_void', voidImportId, 'apply_finance', 'ready',
        0, 1, 0, progress, actor.id, 1, createdAt, createdAt, null,
      ),
    ])
    await expect(continueWorkbookImport({
      db: env.DB, actor, keyring, config, centreId: 'centre_1',
      nowMs: NOW_MS + 12_000, correlationId: 'corr_panel_manual_void_continue_void',
      idFactory, importId: voidImportId, expectedVersion: 1,
      idempotencyKey: 'workbook-panel-manual-void-stale-void',
    })).rejects.toThrow(/^VERSION_CONFLICT$/)
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM finance_entry_voids
      WHERE finance_entry_id='fin_panel_registry_edit'`).first('count')).toBe(0)
  })
})
