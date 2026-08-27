import { describe, expect, it, vi } from 'vitest'
import { previewWorkbook } from '../../worker/core/workbooks.js'
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
    const loadPanelState = vi.fn(async ({ centreId, rows }) => {
      expect(centreId).toBe('centre_1')
      expect(rows.map(({ id }) => id)).toEqual(['fin_panel_edit', 'fin_panel_void'])
      return {
        fieldsByType: { finance_entry: { amountGrosze: { type: 'cents' } } },
        rows: [{
          id: 'fin_panel_edit', type: 'finance_entry', version: 4,
          values: { amountGrosze: 18_000 },
        }, {
          id: 'fin_panel_void', type: 'finance_entry', version: 2,
          values: { amountGrosze: 5_000 },
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
        rows: [{
          id: 'fin_conflict', type: 'finance_entry', version: 5,
          values: { amountGrosze: 19_000 },
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
