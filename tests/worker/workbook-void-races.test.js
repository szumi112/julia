import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { continueWorkbookImport } from '../../worker/core/workbooks.js'
import {
  NOW,
  actor,
  continuationFor,
  insertFinanceEntry,
  racingDb,
  seedLegacyAction,
  seedPanelUpdate,
  seedPanelVoid,
  setupRaceEnvironment,
} from './workbook-materialization-race-fixture.js'

let fixture

beforeAll(async () => { fixture = await setupRaceEnvironment() })

const competingVoid = async ({ id, financeEntryId, importId }) => env.DB.prepare(
  `INSERT INTO finance_entry_voids
   (id,finance_entry_id,workbook_import_id,workbook_source_record_id,reason_code,
    voided_by_staff_id,created_at) VALUES (?,?,?,?,?,?,?)`,
).bind(
  id, financeEntryId, importId, null, 'panel_signed_void', actor.id, NOW,
).run()

describe('workbook void CAS', () => {
  it('does not add a legacy void after another request voids the selected entry', async () => {
    const financeEntryId = 'fin_legacy_void_race'
    await insertFinanceEntry({
      ...fixture, id: financeEntryId, sourceKey: 'workbook:v1:0:9:0',
    })
    const { importId } = await seedLegacyAction({
      keyring: fixture.keyring,
      marker: 'legacy_void_race',
      action: 'void',
      financeEntryId,
    })
    const db = racingDb(() => competingVoid({
      id: 'fev_legacy_void_winner', financeEntryId, importId,
    }))

    await expect(continueWorkbookImport(continuationFor({
      db, keyring: fixture.keyring, importId, marker: 'legacy-void-race',
    }))).rejects.toThrow(/core_directory_invariant_failed/)
    expect((await env.DB.prepare(
      'SELECT id FROM finance_entry_voids WHERE finance_entry_id=?',
    ).bind(financeEntryId).all()).results).toEqual([{ id: 'fev_legacy_void_winner' }])
    expect(await env.DB.prepare(
      'SELECT status,version FROM workbook_imports WHERE id=?',
    ).bind(importId).first()).toEqual({ status: 'ready', version: 1 })
  })

  it('does not add a Panel void after another request voids the selected entry', async () => {
    const financeEntryId = 'fin_panel_void_race'
    await insertFinanceEntry({
      ...fixture, id: financeEntryId, sourceKey: 'workbook:v1:1:9:0',
    })
    const { importId } = await seedPanelVoid({
      keyring: fixture.keyring,
      marker: 'panel_void_race',
      financeEntryId,
    })
    const db = racingDb(() => competingVoid({
      id: 'fev_panel_void_winner', financeEntryId, importId,
    }))

    await expect(continueWorkbookImport(continuationFor({
      db, keyring: fixture.keyring, importId, marker: 'panel-void-race',
    }))).rejects.toThrow(/core_directory_invariant_failed/)
    expect((await env.DB.prepare(
      'SELECT id FROM finance_entry_voids WHERE finance_entry_id=?',
    ).bind(financeEntryId).all()).results).toEqual([{ id: 'fev_panel_void_winner' }])
    expect(await env.DB.prepare(
      'SELECT status,version FROM workbook_imports WHERE id=?',
    ).bind(importId).first()).toEqual({ status: 'ready', version: 1 })
  })
})

describe('Panel apply validation', () => {
  it('rejects a stored invalid prospective row without advancing the import', async () => {
    const financeEntryId = 'fin_panel_invalid_apply'
    await insertFinanceEntry({
      ...fixture, id: financeEntryId, sourceKey: 'workbook:v1:2:9:0',
    })
    const { importId } = await seedPanelUpdate({
      keyring: fixture.keyring,
      marker: 'panel_invalid_apply',
      financeEntryId,
      values: { accountingMonth: '2027-13' },
    })

    await expect(continueWorkbookImport(continuationFor({
      db: env.DB, keyring: fixture.keyring, importId, marker: 'panel-invalid-apply',
    }))).rejects.toThrow(/^WORKBOOK_IMPORT_CONFLICT$/)
    expect(await env.DB.prepare(
      'SELECT accounting_month,version FROM finance_entries WHERE id=?',
    ).bind(financeEntryId).first()).toEqual({ accounting_month: '2027-03', version: 1 })
    expect(await env.DB.prepare(
      'SELECT status,version FROM workbook_imports WHERE id=?',
    ).bind(importId).first()).toEqual({ status: 'ready', version: 1 })
  })
})
