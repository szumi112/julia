import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { continueWorkbookImport } from '../../worker/core/workbooks.js'
import {
  RACE_NOW,
  continuationFor,
  insertFinanceEntry,
  racingDb,
  seedLegacyAction,
  setupRaceEnvironment,
} from './workbook-materialization-race-fixture.js'

let fixture

beforeAll(async () => { fixture = await setupRaceEnvironment() })

describe('legacy workbook link CAS', () => {
  it('does not link an unchanged entry that changes after selection', async () => {
    const financeEntryId = 'fin_legacy_link_race'
    const sourceRecordId = 'wbs_legacy_link_race'
    await insertFinanceEntry({
      ...fixture, id: financeEntryId, sourceKey: 'workbook:v1:0:2:0',
    })
    const { importId } = await seedLegacyAction({
      keyring: fixture.keyring,
      marker: 'legacy_link_race',
      action: 'link_update',
      financeEntryId,
      sourceRecordId,
    })
    const db = racingDb(async () => {
      await env.DB.prepare(`UPDATE finance_entries
        SET accounting_month='2027-04',version=version+1,updated_at=?
        WHERE id=? AND version=1`).bind(RACE_NOW, financeEntryId).run()
    })

    await expect(continueWorkbookImport(continuationFor({
      db, keyring: fixture.keyring, importId, marker: 'legacy-link-race',
    }))).rejects.toThrow(/core_directory_invariant_failed/)
    expect(await env.DB.prepare(
      'SELECT accounting_month,version FROM finance_entries WHERE id=?',
    ).bind(financeEntryId).first()).toEqual({ accounting_month: '2027-04', version: 2 })
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM finance_source_links WHERE source_record_id=?',
    ).bind(sourceRecordId).first()).count).toBe(0)
    expect(await env.DB.prepare(
      'SELECT status,version FROM workbook_imports WHERE id=?',
    ).bind(importId).first()).toEqual({ status: 'ready', version: 1 })
  })
})
