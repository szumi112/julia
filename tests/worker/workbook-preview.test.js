import { describe, expect, it, vi } from 'vitest'
import { createWorkbookImport, previewWorkbook } from '../../worker/core/workbooks.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import {
  createWorkbookPanelMetadataCallbacks,
  verifyWorkbookPreviewToken,
} from '../../worker/security/workbook-artifacts.js'

const APPROVED = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const config = Object.freeze({
  appEnv: 'staging',
  dataMode: 'fictional',
  activeWorkbookKekVersion: 1,
  activeWorkbookHmacVersion: 1,
})
const owner = Object.freeze({
  id: 'stf_workbook_preview_owner', role: 'owner', specialistId: null, version: 1,
})
const panelFinanceValues = (patch = {}) => ({
  accountingMonth: '2025-09',
  occurredOn: '2025-09-02',
  amountGrosze: 18_000,
  paidAmountGrosze: 18_000,
  paymentMethod: 'cash',
  settlementStatus: 'paid',
  invoiceStatus: 'not_required',
  specialistId: null,
  ...patch,
})
const key = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const ring = () => createKeyring({
  BWM_WORKBOOK_KEK_V1: key(9),
  BWM_WORKBOOK_HMAC_V1: key(10),
}, config)
const row = (patch = {}) => ({
  sourceKey: 'workbook:v1:0:2:0',
  sheet: 'Wrzesień 2025',
  rowNumber: 2,
  recordType: 'income',
  accountingMonth: '2025-09',
  occurredOn: '2025-09-02',
  amountGrosze: 18000,
  counterparty: 'Fikcyjna Osoba',
  sourceLabel: 'Fikcyjna konsultacja',
  paymentMethod: 'cash',
  settlementStatus: 'paid',
  invoiceStatus: 'not_required',
  invoiceNote: '',
  specialistName: null,
  lessonCount: null,
  raw: { Cena: 180 },
  ...patch,
})
const parsed = (fingerprint = APPROVED) => Object.freeze({
  formatVersion: 1,
  parserVersion: 2,
  materializerVersion: 2,
  fingerprint,
  filename: 'fictional.xlsx',
  counts: Object.freeze({ financeRows: 2 }),
  warnings: Object.freeze([{ code: 'AMOUNT_STORED_AS_TEXT', count: 1 }]),
  rows: Object.freeze([
    row({ specialistName: 'Anna Janowska' }),
    row({ sourceKey: 'workbook:v1:0:3:0', rowNumber: 3, recordType: 'tus' }),
  ]),
  quarantinedRows: Object.freeze([
    row({
      sourceKey: 'workbook:v1:0:4:0', rowNumber: 4,
      reasonCode: 'SERVICE_DATE_INVALID', reasonCodes: ['SERVICE_DATE_INVALID'],
    }),
  ]),
  reconciliation: Object.freeze({
    sourceCandidates: 3,
    acceptedRows: 2,
    quarantinedRows: 1,
    excludedFormulaBlocks: 0,
    excludedFormulaRows: 0,
  }),
})

describe('no-write workbook preview', () => {
  it('returns the signed exact-file contract, proposed source mappings, conflicts and every quarantine row', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const parse = vi.fn(async (buffer, options) => {
      expect(new Uint8Array(buffer)).toEqual(bytes)
      expect(options).toEqual({ filename: 'fictional.xlsx' })
      return parsed()
    })
    const readPanel = vi.fn(async () => ({
      edits: [], kind: 'legacy', metadata: null, voidIds: [],
    }))
    const keyring = await ring()
    const result = await previewWorkbook({
      bytes,
      filename: 'fictional.xlsx',
      actor: owner,
      keyring,
      config,
      centreId: 'centre_1',
      nowMs: 1_800_000_000_000,
      parse,
      readPanel,
      nonceFactory: () => new Uint8Array(16).fill(12),
    })

    expect(parse).toHaveBeenCalledOnce()
    expect(readPanel).toHaveBeenCalledOnce()
    expect(result.data).toEqual({
      fingerprint: APPROVED,
      parserVersion: 2,
      materializerVersion: 2,
      planDigest: expect.stringMatching(/^v1_[A-Za-z0-9_-]{43}$/),
      previewToken: expect.stringMatching(/^v1\.1\./),
      counts: { financeRows: 2 },
      warnings: [{ code: 'AMOUNT_STORED_AS_TEXT', count: 1 }],
      reconciliation: {
        sourceCandidates: 3,
        acceptedRows: 2,
        quarantinedRows: 1,
        excludedFormulaBlocks: 0,
        excludedFormulaRows: 0,
      },
      proposedMappings: [
        {
          displayName: 'Anna Janowska',
          resolutionCode: 'explicit_match',
          sourceValue: 'Anna Janowska',
          sourceValueKind: 'explicit_name',
          specialistId: 'sp_staging_workbook_anna_janowska',
        },
        {
          displayName: 'Julia Wolanin',
          resolutionCode: 'blank_assigned_to_julia',
          sourceValue: '',
          sourceValueKind: 'blank',
          specialistId: 'sp_staging_workbook_julia_wolanin',
        },
      ],
      conflicts: [],
      quarantine: [parsed().quarantinedRows[0]],
      workbookKind: 'legacy',
    })
    await expect(verifyWorkbookPreviewToken({
      token: result.data.previewToken,
      keyring,
      config,
      expected: {
        centreId: 'centre_1',
        actorId: owner.id,
        fingerprint: APPROVED,
        byteSize: bytes.byteLength,
        parserVersion: 2,
        materializerVersion: 2,
        planDigest: result.data.planDigest,
      },
      nowMs: 1_800_000_100_000,
    })).resolves.toMatchObject({ fingerprint: APPROVED })
    expect(JSON.stringify(result)).not.toContain('BWM_')
  })

  it('rejects the cd66 legacy artifact and never accepts unknown explicit specialist names', async () => {
    const keyring = await ring()
    await expect(previewWorkbook({
      bytes: new Uint8Array([1]), filename: 'other.xlsx', actor: owner, keyring, config,
      centreId: 'centre_1', nowMs: 1_800_000_000_000,
      parse: async () => parsed(`cd66${'0'.repeat(60)}`),
      readPanel: async () => ({ edits: [], kind: 'legacy', metadata: null, voidIds: [] }),
    })).rejects.toThrow(/^WORKBOOK_FINGERPRINT_REJECTED$/)

    const unknown = await previewWorkbook({
      bytes: new Uint8Array([1]), filename: 'other.xlsx', actor: owner, keyring, config,
      centreId: 'centre_1', nowMs: 1_800_000_000_000,
      parse: async () => ({
        ...parsed(),
        rows: [row({ specialistName: 'Nieznana Osoba' })],
        quarantinedRows: [],
      }),
      readPanel: async () => ({ edits: [], kind: 'legacy', metadata: null, voidIds: [] }),
    })
    expect(unknown.data.proposedMappings).toEqual([])
    expect(unknown.data.conflicts).toEqual([{
      code: 'SPECIALIST_MAPPING_REQUIRED',
      sourceValue: 'Nieznana Osoba',
    }])
  })

  it('has no D1, R2, audit or outbox dependency surface', async () => {
    await expect(previewWorkbook({
      bytes: new Uint8Array([1]), filename: 'fictional.xlsx', actor: owner,
      keyring: await ring(),
      config, centreId: 'centre_1', nowMs: 1_800_000_000_000,
      parse: async () => parsed(),
      readPanel: async () => ({ edits: [], kind: 'legacy', metadata: null, voidIds: [] }),
      db: { prepare: () => { throw new Error('WRITE_TRAP') } },
    })).rejects.toThrow(/^WORKBOOK_PREVIEW_INVALID$/)
  })

  it('normalizes malformed parser input at the public preview boundary', async () => {
    const readPanel = vi.fn()
    await expect(previewWorkbook({
      bytes: new Uint8Array([80, 75, 0]),
      filename: 'malformed.xlsx',
      actor: owner,
      keyring: await ring(),
      config,
      centreId: 'centre_1',
      nowMs: 1_800_000_000_000,
      parse: async () => { throw new TypeError('WORKBOOK_ARCHIVE_INVALID') },
      readPanel,
    })).rejects.toThrow(/^WORKBOOK_PREVIEW_INVALID$/)
    expect(readPanel).not.toHaveBeenCalled()
  })

  it('three-way merges a literal signed Panel edit and explicit void against current D1 state', async () => {
    const keyring = await ring()
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring, config, centreId: 'centre_1',
    })
    const editDigest = await callbacks.digestField({
      rowType: 'finance_entry', rowId: 'fin_panel_edit', field: 'amountGrosze',
      value: 18_000,
    })
    const voidDigest = await callbacks.digestField({
      rowType: 'finance_entry', rowId: 'fin_panel_void', field: 'amountGrosze',
      value: 5_000,
    })
    const missingButNotVoidedDigest = await callbacks.digestField({
      rowType: 'finance_entry', rowId: 'fin_panel_missing', field: 'amountGrosze',
      value: 7_000,
    })
    const metadata = {
      format: 'Panel-v2',
      scope: { id: 'centre_1', type: 'centre' },
      rows: [{
        id: 'fin_panel_edit', type: 'finance_entry', baseVersion: 4,
        fieldDigests: { amountGrosze: editDigest },
      }, {
        id: 'fin_panel_missing', type: 'finance_entry', baseVersion: 1,
        fieldDigests: { amountGrosze: missingButNotVoidedDigest },
      }, {
        id: 'fin_panel_void', type: 'finance_entry', baseVersion: 2,
        fieldDigests: { amountGrosze: voidDigest },
      }],
      voidIds: ['fin_panel_void'],
    }
    const loadPanelState = vi.fn(async ({ centreId, rows, specialistIds }) => {
      expect(centreId).toBe('centre_1')
      expect(rows.map(({ id }) => id)).toEqual(['fin_panel_edit', 'fin_panel_void'])
      expect(specialistIds).toEqual([])
      return {
        fieldsByType: { finance_entry: { amountGrosze: { type: 'cents' } } },
        specialistIds: [],
        rows: [{
          id: 'fin_panel_edit', type: 'finance_entry', version: 4,
          kind: 'income', recordType: 'income',
          values: panelFinanceValues(),
        }, {
          id: 'fin_panel_void', type: 'finance_entry', version: 2,
          kind: 'income', recordType: 'income',
          values: panelFinanceValues({ amountGrosze: 5_000, paidAmountGrosze: 5_000 }),
        }],
      }
    })
    const result = await previewWorkbook({
      bytes: new Uint8Array([8, 9]), filename: 'panel.xlsx', actor: owner, keyring, config,
      centreId: 'centre_1', nowMs: 1_800_000_000_000,
      parse: async () => parsed(),
      readPanel: async () => ({
        edits: [{
          id: 'fin_panel_edit', sheet: 'Panel — Wizyty', values: { amountGrosze: 20_000 },
        }],
        kind: 'panel-v2',
        metadata,
        voidIds: ['fin_panel_void'],
      }),
      loadPanelState,
    })

    expect(loadPanelState).toHaveBeenCalledOnce()
    expect(result.data.conflicts).toEqual([])
    expect(result.data.panelChanges).toEqual({
      unchangedIds: [],
      updates: [{
        id: 'fin_panel_edit', type: 'finance_entry', values: { amountGrosze: 20_000 },
      }],
      voidIds: ['fin_panel_void'],
    })
  })

  it.each([
    ['accountingMonth', '2025-13', 'accountingMonth'],
    ['occurredOn', '2025-02-30', 'occurredOn'],
    ['amountGrosze', 0, 'amountGrosze'],
    ['amountGrosze', 100_000_001, 'amountGrosze'],
    ['paidAmountGrosze', 18_001, 'paidAmountGrosze'],
    ['paymentMethod', 'wire', 'paymentMethod'],
    ['settlementStatus', 'partial', 'settlementStatus'],
    ['invoiceStatus', 'pending', 'invoiceStatus'],
    ['specialistId', 'sp_missing_panel_specialist', 'specialistId'],
    ['specialistId', 'bad-id', 'specialistId'],
  ])('returns a stable conflict for invalid prospective Panel %s', async (
    editedField, editedValue, conflictField,
  ) => {
    const keyring = await ring()
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring, config, centreId: 'centre_1',
    })
    const currentValues = {
      accountingMonth: '2025-09',
      occurredOn: '2025-09-02',
      amountGrosze: 18_000,
      paidAmountGrosze: 18_000,
      paymentMethod: 'cash',
      settlementStatus: 'paid',
      invoiceStatus: 'not_required',
      specialistId: 'sp_existing_panel_specialist',
    }
    const metadata = {
      format: 'Panel-v2',
      scope: { id: 'centre_1', type: 'centre' },
      rows: [{
        id: 'fin_panel_validation', type: 'finance_entry', baseVersion: 3,
        fieldDigests: {
          [editedField]: await callbacks.digestField({
            rowType: 'finance_entry', rowId: 'fin_panel_validation',
            field: editedField, value: currentValues[editedField],
          }),
        },
      }],
      voidIds: [],
    }
    const result = await previewWorkbook({
      bytes: new Uint8Array([8, 9]), filename: 'panel.xlsx', actor: owner, keyring, config,
      centreId: 'centre_1', nowMs: 1_800_000_000_000,
      parse: async () => parsed(),
      readPanel: async () => ({
        edits: [{
          id: 'fin_panel_validation', sheet: 'Panel — Wizyty',
          values: { [editedField]: editedValue },
        }],
        kind: 'panel-v2', metadata, voidIds: [],
      }),
      loadPanelState: async ({ specialistIds }) => {
        expect(specialistIds).toEqual(editedField === 'specialistId'
          && editedValue === 'sp_missing_panel_specialist'
          ? ['sp_missing_panel_specialist'] : [])
        return {
          fieldsByType: {
            finance_entry: {
              accountingMonth: { type: 'text' },
              occurredOn: { type: 'date' },
              amountGrosze: { type: 'cents' },
              paidAmountGrosze: { type: 'cents' },
              paymentMethod: { type: 'enum', values: ['cash'] },
              settlementStatus: { type: 'enum', values: ['paid', 'partial'] },
              invoiceStatus: { type: 'enum', values: ['not_required'] },
              specialistId: { type: 'text' },
            },
          },
          specialistIds: ['sp_existing_panel_specialist'],
          rows: [{
            id: 'fin_panel_validation', type: 'finance_entry', version: 3,
            kind: 'income', recordType: 'income', values: currentValues,
          }],
        }
      },
    })

    expect(result.data.panelChanges).toEqual({
      unchangedIds: [], updates: [], voidIds: [],
    })
    expect(result.data.conflicts).toEqual([{
      code: 'PANEL_VALUE_INVALID', field: conflictField,
      recordId: 'fin_panel_validation',
    }])
  })

  it('rejects a malformed Panel specialist at exact-file commit before D1 or R2 writes', async () => {
    const keyring = await ring()
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring, config, centreId: 'centre_1',
    })
    const currentValues = panelFinanceValues({
      specialistId: 'sp_existing_panel_specialist',
    })
    const metadata = {
      format: 'Panel-v2',
      scope: { id: 'centre_1', type: 'centre' },
      rows: [{
        id: 'fin_panel_bad_specialist', type: 'finance_entry', baseVersion: 3,
        fieldDigests: {
          specialistId: await callbacks.digestField({
            rowType: 'finance_entry', rowId: 'fin_panel_bad_specialist',
            field: 'specialistId', value: currentValues.specialistId,
          }),
        },
      }],
      voidIds: [],
    }
    const readPanel = async () => ({
      edits: [{
        id: 'fin_panel_bad_specialist', sheet: 'Panel — Wizyty',
        values: { specialistId: 'bad-id' },
      }],
      kind: 'panel-v2', metadata, voidIds: [],
    })
    const loadedState = {
      fieldsByType: { finance_entry: { specialistId: { type: 'text' } } },
      specialistIds: ['sp_existing_panel_specialist'],
      rows: [{
        id: 'fin_panel_bad_specialist', type: 'finance_entry', version: 3,
        kind: 'income', recordType: 'income', values: currentValues,
      }],
    }
    const bytes = new Uint8Array([8, 9])
    const preview = await previewWorkbook({
      bytes, filename: 'panel.xlsx', actor: owner, keyring, config,
      centreId: 'centre_1', nowMs: 1_800_000_000_000,
      parse: async () => parsed(), readPanel,
      loadPanelState: async () => loadedState,
    })
    expect(preview.data.conflicts).toEqual([{
      code: 'PANEL_VALUE_INVALID', field: 'specialistId',
      recordId: 'fin_panel_bad_specialist',
    }])
    const db = {
      prepare: vi.fn(() => { throw new Error('D1_WRITE_TRAP') }),
      batch: vi.fn(async () => { throw new Error('D1_WRITE_TRAP') }),
    }
    const bucket = {
      delete: vi.fn(async () => { throw new Error('R2_WRITE_TRAP') }),
      put: vi.fn(async () => { throw new Error('R2_WRITE_TRAP') }),
    }

    await expect(createWorkbookImport({
      db,
      bucket,
      actor: owner,
      keyring,
      config,
      centreId: 'centre_1',
      nowMs: 1_800_000_000_100,
      correlationId: 'corr_panel_bad_specialist',
      idFactory: () => 'panel_bad_specialist',
      bytes,
      filename: 'panel.xlsx',
      previewToken: preview.data.previewToken,
      idempotencyKey: 'panel-bad-specialist',
      parse: async () => parsed(),
      readPanel,
      loadPanelState: async ({ specialistIds }) => {
        expect(specialistIds).toEqual([])
        return loadedState
      },
    })).rejects.toThrow(/^WORKBOOK_IMPORT_CONFLICT$/)
    expect(db.prepare).not.toHaveBeenCalled()
    expect(db.batch).not.toHaveBeenCalled()
    expect(bucket.delete).not.toHaveBeenCalled()
    expect(bucket.put).not.toHaveBeenCalled()
  })

  it('orders authenticated Panel actions by UTF-16 code units', async () => {
    const keyring = await ring()
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring, config, centreId: 'centre_1',
    })
    const ids = ['fin_a', 'fin_A_', 'fin_A-', 'fin_A']
    const metadataRows = await Promise.all(ids.map(async (id) => ({
      id, type: 'finance_entry', baseVersion: 1,
      fieldDigests: {
        amountGrosze: await callbacks.digestField({
          rowType: 'finance_entry', rowId: id, field: 'amountGrosze', value: 18_000,
        }),
      },
    })))
    const observed = []
    const result = await previewWorkbook({
      bytes: new Uint8Array([8, 9]), filename: 'panel.xlsx', actor: owner, keyring, config,
      centreId: 'centre_1', nowMs: 1_800_000_000_000,
      parse: async () => parsed(),
      readPanel: async () => ({
        edits: ids.map((id, index) => ({
          id, sheet: 'Panel — Wizyty', values: { amountGrosze: 19_000 + index },
        })),
        kind: 'panel-v2',
        metadata: {
          format: 'Panel-v2', scope: { id: 'centre_1', type: 'centre' },
          rows: metadataRows, voidIds: [],
        },
        voidIds: [],
      }),
      loadPanelState: async ({ rows, specialistIds }) => {
        observed.push(...rows.map(({ id }) => id))
        expect(specialistIds).toEqual([])
        return {
          fieldsByType: { finance_entry: { amountGrosze: { type: 'cents' } } },
          specialistIds: [],
          rows: rows.map(({ id }) => ({
            id, type: 'finance_entry', version: 1, kind: 'income', recordType: 'income',
            values: {
              accountingMonth: '2025-09', occurredOn: '2025-09-02',
              amountGrosze: 18_000, paidAmountGrosze: 18_000,
              paymentMethod: 'cash', settlementStatus: 'paid',
              invoiceStatus: 'not_required', specialistId: null,
            },
          })),
        }
      },
    })

    expect(observed).toEqual(['fin_A', 'fin_A-', 'fin_A_', 'fin_a'])
    expect(result.data.panelChanges.updates.map(({ id }) => id)).toEqual(observed)
  })

  it('keeps digest/base conflicts and only permits signed voidIds, never missing rows', async () => {
    const keyring = await ring()
    const callbacks = createWorkbookPanelMetadataCallbacks({
      keyring, config, centreId: 'centre_1',
    })
    const digestFor = (id, value) => callbacks.digestField({
      rowType: 'finance_entry', rowId: id, field: 'amountGrosze', value,
    })
    const metadata = {
      format: 'Panel-v2', scope: { id: 'centre_1', type: 'centre' },
      rows: [{
        id: 'fin_conflict', type: 'finance_entry', baseVersion: 4,
        fieldDigests: { amountGrosze: await digestFor('fin_conflict', 18_000) },
      }, {
        id: 'fin_missing_plain', type: 'finance_entry', baseVersion: 1,
        fieldDigests: { amountGrosze: await digestFor('fin_missing_plain', 7_000) },
      }, {
        id: 'fin_missing_void', type: 'finance_entry', baseVersion: 2,
        fieldDigests: { amountGrosze: await digestFor('fin_missing_void', 5_000) },
      }],
      voidIds: ['fin_missing_void'],
    }
    const result = await previewWorkbook({
      bytes: new Uint8Array([8, 9]), filename: 'panel.xlsx', actor: owner, keyring, config,
      centreId: 'centre_1', nowMs: 1_800_000_000_000,
      parse: async () => parsed(),
      readPanel: async () => ({
        edits: [{
          id: 'fin_conflict', sheet: 'Panel — Wizyty', values: { amountGrosze: 20_000 },
        }],
        kind: 'panel-v2', metadata, voidIds: ['fin_missing_void'],
      }),
      loadPanelState: async () => ({
        fieldsByType: { finance_entry: { amountGrosze: { type: 'cents' } } },
        specialistIds: [],
        rows: [{
          id: 'fin_conflict', type: 'finance_entry', version: 5,
          kind: 'income', recordType: 'income',
          values: panelFinanceValues({ amountGrosze: 19_000, paidAmountGrosze: 19_000 }),
        }],
      }),
    })

    expect(result.data.panelChanges).toEqual({
      unchangedIds: [], updates: [], voidIds: [],
    })
    expect(result.data.conflicts).toEqual([{
      code: 'PANEL_CONCURRENT_EDIT',
      current: 19_000,
      edited: 20_000,
      field: 'amountGrosze',
      recordId: 'fin_conflict',
    }, {
      code: 'PANEL_ROW_MISSING',
      field: null,
      recordId: 'fin_missing_void',
    }])
  })
})
