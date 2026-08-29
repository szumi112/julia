import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import { loadFinanceWindow as loadFinanceWindowCore } from '../../worker/core/finance-reporting.js'

const loadFinanceWindow = (input) => loadFinanceWindowCore({ ...input, keyring: {} })
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2027-06-15T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const OWNER = authorityActor({ id: 'stf_finance_cap_owner', role: 'owner' })

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
    OWNER.id, 'finance_cap_owner_lookup', '{}', '{}', 'owner', 'active',
    'finance-cap-owner-subject', null, 1, NOW, null, NOW, NOW,
  ).run()
  const statements = []
  for (let index = 0; index < 1_000; index += 1) {
    statements.push(env.DB.prepare(`INSERT INTO finance_entries
      (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
       amount_grosze,paid_amount_grosze,payment_method,settlement_status,
       invoice_status,specialist_id,appointment_id,counterparty_lookup,
       details_envelope,source_row_envelope,version,created_by_staff_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      `fin_exact_cap_${String(index).padStart(4, '0')}`, null, null, 'income',
      'income', '2027-06', '2027-06-15', 2, 1, 'cash', 'partial',
      'not_required', null, null, null, '{}', null, 1, OWNER.id, NOW, NOW,
    ))
    if (statements.length === 40 || index === 999) await env.DB.batch(statements.splice(0))
  }
})

describe('FinanceWindow exact cap and chunked collection reads', () => {
  it('accepts exactly 1000 ledger and effective collection rows without truncation', async () => {
    const result = await loadFinanceWindow({
      db: env.DB, actor: OWNER, nowMs: NOW_MS, selectedMonth: '2027-06',
    })
    expect(result.data.rows).toHaveLength(1_000)
    expect(result.data.kpis).toEqual({
      revenueGrosze: 2_000, collectedGrosze: 1_000, outstandingGrosze: 1_000,
      expensesGrosze: 0, incomeGrosze: 2_000,
    })
    expect(result.data.splits.payment).toEqual({ cash: 1_000, outstanding: 1_000 })
  })
})
