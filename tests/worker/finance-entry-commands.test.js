import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import { createFinanceEntry, adjustFinanceEntry, loadFinanceEntry } from '../../worker/core/finance-entry-commands.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { authorityActor } from './fixtures.js'
import { createApp } from '../../worker/app.js'
import { loadFinanceWindow } from '../../worker/core/finance-reporting.js'
import { completeCoreDirectoryStageA, applyCoreDirectoryStageB, applyFinanceStageC, applySpecialistProfilesStageD, applyWorkbookRegistryStageE } from './apply-migrations.js'

const nowMs = Date.parse('2027-06-15T10:00:00.000Z')
const now = new Date(nowMs).toISOString()
const actor = authorityActor({ id: 'stf_finance_commands', role: 'owner' })
let keyring
beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(actor.id, 'finance_commands_lookup', '{}', '{}',
    'owner', 'active', 'finance-commands-subject', null, 1, now, null, now, now).run()
  keyring = await createKeyring(env, {
    activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
  })
})
const input = (body, idempotencyKey) => ({ db: env.DB, actor, keyring, nowMs,
  correlationId: '00000000-0000-4000-8000-000000000311',
  idFactory: () => crypto.randomUUID(), body, idempotencyKey })
const entry = () => ({ kind: 'expense', recordType: 'expense', accountingMonth: '2027-06',
  occurredOn: '2027-06-15', amountGrosze: 12500, paidAmountGrosze: 0,
  paymentMethod: 'unknown', settlementStatus: 'unknown', invoiceStatus: 'unknown',
  counterparty: 'Fikcyjny dostawca', sourceLabel: 'Materiały', invoiceNote: '',
  specialistId: null, lessonCount: null, source: null })

it('creates encrypted expenses and replays without duplicating the entry', async () => {
  const command = input(entry(), 'expense_create_001')
  const result = await createFinanceEntry(command)
  expect(result.status).toBe(201)
  expect(await createFinanceEntry(command)).toEqual(result)
  const row = await env.DB.prepare('SELECT * FROM finance_entries WHERE id=?').bind(result.body.data.entryId).first()
  expect(row.amount_grosze).toBe(12500)
  expect(row.details_envelope).not.toContain('Fikcyjny')
  expect(row.batch_id).toBeNull()
  const finance = await loadFinanceWindow({ db: env.DB, actor, keyring, nowMs, selectedMonth: '2027-06' })
  expect(finance.data.rows.find(({ id }) => id === row.id).sourceKind).toBe('panel')
})

it('records explicit settlement, period and invoice adjustments with an encrypted history', async () => {
  const created = await createFinanceEntry(input(entry(), 'expense_create_002'))
  const entryId = created.body.data.entryId
  const command = { ...input({ expectedVersion: 1, reason: 'Potwierdzono przelew i okres',
    accountingMonth: '2027-05', paidAmountGrosze: 12500, paymentMethod: 'transfer',
    settlementStatus: 'paid', invoiceStatus: 'issued' }, 'expense_adjust_001'), entryId }
  const result = await adjustFinanceEntry(command)
  expect(result.body.data.version).toBe(2)
  expect(await adjustFinanceEntry(command)).toEqual(result)
  const row = await env.DB.prepare('SELECT * FROM finance_entries WHERE id=?').bind(entryId).first()
  expect(row.accounting_month).toBe('2027-05')
  expect(row.paid_amount_grosze).toBe(12500)
  expect(row.invoice_status).toBe('issued')
  const history = await env.DB.prepare('SELECT * FROM finance_adjustments WHERE finance_entry_id=?').bind(entryId).all()
  expect(history.results).toHaveLength(1)
  expect(history.results[0].reason_envelope).not.toContain('Potwierdzono')
  const detail = await loadFinanceEntry({ db: env.DB, keyring, actor, nowMs, entryId })
  expect(detail.body.data.entry.paidAmountGrosze).toBe(12500)
  expect(detail.body.data.adjustments[0].reason).toBe('Potwierdzono przelew i okres')
  expect(detail.body.data.adjustments[0].before.paidAmountGrosze).toBe(0)
  await expect(adjustFinanceEntry({ ...command, idempotencyKey: 'expense_adjust_stale' })).rejects.toThrow('VERSION_CONFLICT')
})

it('rejects overpayment and unauthorized users without writing entries', async () => {
  await expect(createFinanceEntry(input({ ...entry(), paidAmountGrosze: 99999 }, 'expense_invalid_001'))).rejects.toThrow('VALIDATION_FAILED')
  await expect(createFinanceEntry({ ...input(entry(), 'expense_denied_001'),
    actor: authorityActor({ id: 'stf_denied', role: 'specialist', specialistId: 'sp_denied' }),
  })).rejects.toThrow('NOT_FOUND')
})

it('runs finance commands through the authenticated HTTP boundary', async () => {
  const app = createApp({ db: env.DB,
    config: { appEnv: 'staging', appOrigin: 'https://panel.example', dataMode: 'fictional' },
    cryptoContext: { keyring, dataKey: {}, scope: {} },
    resolveAccessPrincipal: async () => ({ kind: 'human', subject: 'finance-commands-subject',
      issuedAt: Math.floor(nowMs / 1000) - 60, expiresAt: Math.floor(nowMs / 1000) + 3600,
      normalizedEmail: 'finance-commands@example.test' }),
    resolveActor: async () => actor, verifyCsrfToken: async () => true,
    readJsonBodyOnce: async (request) => request.json(), now: () => nowMs,
  })
  const response = await app.request('/api/v1/finance/entries', { method: 'POST',
    headers: { origin: 'https://panel.example', 'content-type': 'application/json',
      'x-csrf-token': 'valid', 'idempotency-key': 'finance_http_create_001' },
    body: JSON.stringify(entry()),
  })
  expect(response.status).toBe(201)
  const { data } = await response.json()
  const detail = await app.request(`/api/v1/finance/entries/${data.entryId}`)
  expect(detail.status).toBe(200)
  expect((await detail.json()).data.entry.sourceLabel).toBe('Materiały')
  const adjusted = await app.request(`/api/v1/finance/entries/${data.entryId}/adjustments`, {
    method: 'POST', headers: { origin: 'https://panel.example', 'content-type': 'application/json',
      'x-csrf-token': 'valid', 'idempotency-key': 'finance_http_adjust_001' },
    body: JSON.stringify({ expectedVersion: 1, reason: 'Potwierdzono fikcyjny przelew',
      accountingMonth: '2027-06', paidAmountGrosze: 12500, paymentMethod: 'transfer',
      settlementStatus: 'paid', invoiceStatus: 'issued' }),
  })
  expect(adjusted.status).toBe(200)
  const updated = await app.request(`/api/v1/finance/entries/${data.entryId}`)
  const updatedDetail = (await updated.json()).data
  expect(updatedDetail.entry.paidAmountGrosze).toBe(12500)
  expect(updatedDetail.entry.invoiceStatus).toBe('issued')
  expect(updatedDetail.adjustments).toHaveLength(1)
})

it('rolls back an adjustment when a simultaneous edit wins at the same timestamp', async () => {
  const created = await createFinanceEntry(input(entry(), 'expense_race_create'))
  const entryId = created.body.data.entryId
  const racedDb = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements) => {
      await env.DB.prepare('UPDATE finance_entries SET invoice_status=?,version=version+1 WHERE id=?')
        .bind('not_required', entryId).run()
      return env.DB.batch(statements)
    },
  }
  await expect(adjustFinanceEntry({ ...input({ expectedVersion: 1, reason: 'Fikcyjne rozliczenie',
    accountingMonth: '2027-06', paidAmountGrosze: 12500, paymentMethod: 'transfer',
    settlementStatus: 'paid', invoiceStatus: 'issued' }, 'expense_race_adjust'),
    db: racedDb, entryId,
  })).rejects.toThrow('VERSION_CONFLICT')
  const row = await env.DB.prepare('SELECT paid_amount_grosze,invoice_status FROM finance_entries WHERE id=?')
    .bind(entryId).first()
  expect(row).toEqual({ paid_amount_grosze: 0, invoice_status: 'not_required' })
  expect((await env.DB.prepare('SELECT id FROM finance_adjustments WHERE finance_entry_id=?')
    .bind(entryId).all()).results).toHaveLength(0)
})

it('rejects unreachable accounting months and forged source provenance', async () => {
  for (const accountingMonth of ['2000-05', '2027-07']) {
    await expect(createFinanceEntry(input({ ...entry(), accountingMonth }, `invalid_${accountingMonth}`)))
      .rejects.toThrow('VALIDATION_FAILED')
  }
  await expect(createFinanceEntry(input({ ...entry(), source: {
    batchId: 'fib_forged', sourceKey: 'workbook:v1:0:2:0', sheet: 'Fikcyjny', rowNumber: 2, raw: {},
  } }, 'forged_source_001'))).rejects.toThrow('VALIDATION_FAILED')
})
