import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import { createKeyring } from '../../worker/security/keyring.js'
import { getOrCreateDataKey, decryptForScope, encryptForScope } from '../../worker/security/envelope.js'
import { FINANCE_SCOPE } from '../../worker/core/finance.js'
import { ACTIVITY_SCOPE, encryptActivityIdentity } from '../../worker/core/activity-crypto.js'
import { authorityActor } from './fixtures.js'
import { completeCoreDirectoryStageA, applyCoreDirectoryStageB, applyFinanceStageC,
  applySpecialistProfilesStageD, applyWorkbookRegistryStageE } from './apply-migrations.js'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
import { voidFinanceEntry } from '../../worker/core/finance-reporting.js'
import { createActivityCharge } from '../../worker/core/activity-billing.js'
import { createApp } from '../../worker/app.js'
import { adjustFinanceEntry } from '../../worker/core/finance-entry-commands.js'
import { readActivityWorkspace } from '../../worker/core/activities.js'
import { createLoadedActivitiesState, captureLoadedActivitiesLoad,
  mergeLoadedActivitiesLoad } from '../../src/loaded-activities.js'

const nowMs = Date.parse('2027-06-15T10:00:00.000Z')
const now = new Date(nowMs).toISOString()
const actor = authorityActor({ id: 'stf_activity_billing', role: 'owner' })
const specialistId = 'sp_activity_billing'
let keyring, activityKey, financeKey
const run = (sql, ...values) => env.DB.prepare(sql).bind(...values).run()
beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  keyring = await createKeyring(env, {
    activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
  })
  activityKey = await getOrCreateDataKey(env.DB, keyring, ACTIVITY_SCOPE, {
    id: 'key_activity_billing', createdAt: now,
  })
  financeKey = await getOrCreateDataKey(env.DB, keyring, FINANCE_SCOPE, {
    id: 'key_activity_billing_finance', createdAt: now,
  })
  await run(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, actor.id, 'activity_billing_lookup', '{}', '{}',
  'owner', 'active', 'activity-billing-subject', null, 1, now, null, now, now)
  await run(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,professional_title_envelope,standard_rate_grosze,
     status,version,archived_at,created_at,updated_at) VALUES (?,NULL,'{}','{}',18000,'active',1,NULL,?,?)`,
  specialistId, now, now)
})
const fixture = async (suffix, program = 'tus', grouped = true) => {
  const participantId = `acp_billing_${suffix}`
  const groupId = grouped ? `agr_billing_${suffix}` : null
  const membershipId = grouped ? `amb_billing_${suffix}` : null
  const programId = `apg_${program}`
  const identity = await encryptActivityIdentity(keyring, activityKey, {
    kind: 'participant', id: participantId, programId, value: 'Fikcyjny uczestnik',
  })
  await run(`INSERT INTO activity_participants
    (id,program_id,identity_envelope,client_id,historical_client_id,status,version,created_at,updated_at)
    VALUES (?,?,?,NULL,NULL,'active',1,?,?)`, participantId, programId, identity, now, now)
  if (grouped) {
    const label = await encryptActivityIdentity(keyring, activityKey, {
      kind: 'group', id: groupId, programId, value: 'Fikcyjna grupa',
    })
    await run(`INSERT INTO activity_groups (id,program_id,label_envelope,details_envelope,
      status,version,created_at,updated_at) VALUES (?,?,?,NULL,'active',1,?,?)`,
    groupId, programId, label, now, now)
    await run(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,observed_on,
       observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES (?,?,?,?,'interval','unknown',NULL,NULL,'2027-01-01',NULL,'active',1,?,?)`,
    membershipId, participantId, programId, groupId, now, now)
  }
  return { participantId, groupId, membershipId, responsibleSpecialistId: specialistId,
    accountingMonth: '2027-06', amountGrosze: program === 'tus' ? 34000 : 24000,
    lessonCount: program === 'tus' ? null : 4, paidAmountGrosze: 0,
    paymentMethod: 'unknown', settlementStatus: 'unpaid', invoiceStatus: 'not_required' }
}
const command = (body, key, db = env.DB) => ({ db, actor, keyring, nowMs,
  correlationId: '00000000-0000-4000-8000-000000000411',
  idFactory: () => crypto.randomUUID(), body, idempotencyKey: key })
const create = createActivityCharge

it('creates monthly TUS finance authority and linked charge once with encrypted labels and audit', async () => {
  const body = await fixture('tus')
  const budget = createD1QueryBudget(env.DB)
  const input = command(body, 'activity_billing_tus', budget.work)
  const result = await create(input)
  expect(result.status).toBe(201)
  const { chargeId, entryId, version } = result.body.data
  expect(version).toBe(1)
  expect(await create(command(body, 'activity_billing_tus'))).toEqual(result)
  const charge = await env.DB.prepare('SELECT * FROM activity_charges WHERE id=?').bind(chargeId).first()
  expect(charge).toMatchObject({ participant_id: body.participantId, group_id: body.groupId,
    membership_id: body.membershipId, finance_entry_id: entryId, period_precision: 'month',
    occurred_on: null, lesson_count: null, accounting_month: '2027-06' })
  const finance = await env.DB.prepare('SELECT * FROM finance_entries WHERE id=?').bind(entryId).first()
  expect(finance).toMatchObject({ kind: 'income', record_type: 'tus', amount_grosze: 34000,
    paid_amount_grosze: 0, settlement_status: 'unpaid', batch_id: null, source_row_envelope: null })
  const details = JSON.parse(await decryptForScope(keyring, financeKey, {
    expectedScope: FINANCE_SCOPE, recordId: entryId, field: 'details',
    envelope: JSON.parse(finance.details_envelope),
  }))
  expect(details.counterparty).toBe('Fikcyjny uczestnik')
  expect(details.sourceLabel).toContain('Fikcyjna grupa')
  expect(finance.details_envelope).not.toContain('Fikcyjny')
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='activity.charge.created' AND entity_id=?")
    .bind(chargeId).first('count')).toBe(1)
  expect(budget.usage().used).toBeLessThanOrEqual(45)
})

it('creates individual English monthly charges with explicit lesson and payment amounts', async () => {
  const body = { ...await fixture('english', 'english', false), paidAmountGrosze: 6000,
    paymentMethod: 'transfer', settlementStatus: 'partial' }
  const { body: { data } } = await create(command(body, 'activity_billing_english'))
  expect(await env.DB.prepare('SELECT lesson_count,group_id FROM activity_charges WHERE id=?').bind(data.chargeId).first())
    .toEqual({ lesson_count: 4, group_id: null })
  expect(await env.DB.prepare('SELECT amount_grosze FROM finance_collection_events WHERE finance_entry_id=?').bind(data.entryId).first('amount_grosze')).toBe(6000)
})

it('accepts the full canonical specialist identifier length', async () => {
  const body = await fixture('long_specialist', 'english', false)
  const id = `sp_${'s'.repeat(125)}`
  await run(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,professional_title_envelope,standard_rate_grosze,
     status,version,archived_at,created_at,updated_at) VALUES (?,NULL,'{}','{}',18000,'active',1,NULL,?,?)`, id, now, now)
  expect((await create(command({ ...body, responsibleSpecialistId: id }, 'activity_long_specialist'))).status).toBe(201)
})

it('rejects grouped English because the live activity read model supports individual English bills only', async () => {
  const body = await fixture('grouped_english', 'english')
  await expect(create(command(body, 'activity_grouped_english'))).rejects.toThrow('VALIDATION_FAILED')
})

it('preserves the voided monthly bill when a corrected amount is billed as a replacement', async () => {
  const body = await fixture('replacement')
  const first = await create(command(body, 'activity_billing_replacement_first'))
  const voidInput = command(null, 'activity_billing_replacement_void')
  delete voidInput.body
  await voidFinanceEntry({ ...voidInput, entryId: first.body.data.entryId,
    expectedVersion: 1, reason: 'Błędna kwota naliczenia' })
  const replacement = await create(command({ ...body, amountGrosze: 30000 }, 'activity_billing_replacement_second'))
  expect(replacement.body.data.entryId).not.toBe(first.body.data.entryId)
  const rows = (await env.DB.prepare(`SELECT charge.id,charge.status,finance.amount_grosze
    FROM activity_charges AS charge JOIN finance_entries AS finance ON finance.id=charge.finance_entry_id
    WHERE charge.participant_id=? ORDER BY finance.amount_grosze`).bind(body.participantId).all()).results
  expect(rows.map(({ status, amount_grosze }) => ({ status, amount_grosze }))).toEqual([
    { status: 'active', amount_grosze: 30000 }, { status: 'inactive', amount_grosze: 34000 },
  ])
})

it('rejects duplicate monthly bills across different keys, including concurrent attempts', async () => {
  const body = await fixture('duplicate')
  const results = await Promise.allSettled([
    create(command(body, 'activity_billing_duplicate_a')),
    create(command(body, 'activity_billing_duplicate_b')),
  ])
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(results.find(({ status }) => status === 'rejected').reason.message).toBe('ACTIVITY_CHARGE_EXISTS')
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM activity_charges WHERE participant_id=?')
    .bind(body.participantId).first('count')).toBe(1)
})

it('does not bill a month again when a preserved day-precision charge already exists', async () => {
  const body = await fixture('day')
  const entryId = 'fin_activity_billing_day'
  const details = JSON.stringify(await encryptForScope(keyring, financeKey, {
    expectedScope: FINANCE_SCOPE, recordId: entryId, field: 'details',
    plaintext: JSON.stringify({ schema: 'finance_entry_details.v1', counterparty: 'Fikcyjny uczestnik',
      sourceLabel: 'Historyczny TUS', invoiceNote: '', lessonCount: null }),
  }))
  await run(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
     specialist_id,appointment_id,counterparty_lookup,details_envelope,source_row_envelope,
     version,created_by_staff_id,created_at,updated_at)
    VALUES (?,NULL,NULL,'income','tus','2027-06','2027-06-02',34000,0,'unknown','unknown',
      'not_required',?,NULL,NULL,?,NULL,1,?,?,?)`, entryId, specialistId, details, actor.id, now, now)
  await run(`INSERT INTO activity_charges
    (id,participant_id,program_id,group_id,membership_id,period_precision,occurred_on,
     accounting_month,lesson_count,responsible_specialist_id,finance_entry_id,status,version,created_at,updated_at)
    VALUES ('ach_activity_billing_day',?,'apg_tus',?,?,'day','2027-06-02','2027-06',NULL,?,?,'active',1,?,?)`,
  body.participantId, body.groupId, body.membershipId, specialistId, entryId, now, now)
  await expect(create(command(body, 'activity_billing_day_duplicate'))).rejects.toThrow('ACTIVITY_CHARGE_EXISTS')
  expect(await env.DB.prepare('SELECT version,details_envelope FROM finance_entries WHERE id=?')
    .bind(entryId).first()).toEqual({ version: 1, details_envelope: details })
})

it('rejects wrong membership, uncovered month, malformed payments and unauthorized actors', async () => {
  const body = await fixture('validation')
  const other = await fixture('other')
  for (const patch of [{ membershipId: other.membershipId }, { accountingMonth: '2026-12' },
    { groupId: null, membershipId: null }, { paidAmountGrosze: 35000 }, { lessonCount: 2 },
    { accountingMonth: '2000-05' }, { accountingMonth: '2027-07' }]) {
    await expect(create(command({ ...body, ...patch }, `activity_bad_${crypto.randomUUID()}`))).rejects.toThrow()
  }
  await expect(create({ ...command(body, 'activity_billing_denied'), actor: authorityActor({
    id: 'stf_denied_activity', role: 'specialist', specialistId,
  }) })).rejects.toThrow('NOT_FOUND')
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM activity_charges WHERE participant_id=?')
    .bind(body.participantId).first('count')).toBe(0)
})

it('rolls back finance, charge, audit and replay when membership changes before commit', async () => {
  const body = await fixture('race')
  const countBefore = await env.DB.prepare('SELECT COUNT(*) AS count FROM finance_entries').first('count')
  const auditsBefore = await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='activity.charge.created'").first('count')
  const db = { prepare: (...args) => env.DB.prepare(...args), batch: async (statements) => {
    await run("UPDATE activity_memberships SET ends_on='2027-05-31',version=version+1,updated_at=? WHERE id=?", now, body.membershipId)
    return env.DB.batch(statements)
  } }
  await expect(create(command(body, 'activity_billing_race', db))).rejects.toThrow('VERSION_CONFLICT')
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM finance_entries').first('count')).toBe(countBefore)
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='activity.charge.created'").first('count')).toBe(auditsBefore)
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM activity_charges WHERE participant_id=?')
    .bind(body.participantId).first('count')).toBe(0)
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key='activity_billing_race'").first('count')).toBe(0)
})

it('retries a first-use finance key race without duplicating the charge', async () => {
  const body = await fixture('key_race')
  let firstRead = true
  const db = { batch: (statements) => env.DB.batch(statements), prepare(sql) {
    const statement = env.DB.prepare(sql)
    if (!sql.includes('WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1')) return statement
    return { bind(...values) {
      const bound = statement.bind(...values)
      return { async first() {
        if (firstRead) { firstRead = false; return null }
        return bound.first()
      } }
    } }
  } }
  const result = await create(command(body, 'activity_billing_key_race', db))
  expect(result.status).toBe(201)
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM activity_charges WHERE participant_id=?')
    .bind(body.participantId).first('count')).toBe(1)
})

it('serves authenticated charge creation, replay and duplicate conflicts through HTTP', async () => {
  const body = await fixture('http')
  const app = createApp({ db: env.DB,
    config: { appEnv: 'staging', appOrigin: 'https://panel.example', dataMode: 'fictional' },
    cryptoContext: { keyring, dataKey: {}, scope: {} },
    resolveAccessPrincipal: async () => ({ kind: 'human', subject: 'activity-billing-subject',
      issuedAt: Math.floor(nowMs / 1000) - 60, expiresAt: Math.floor(nowMs / 1000) + 3600,
      normalizedEmail: 'activity-billing@example.test' }),
    resolveActor: async () => actor, verifyCsrfToken: async () => true,
    readJsonBodyOnce: async (request) => request.json(), now: () => nowMs,
  })
  const request = (idempotencyKey, data = body) => app.request('/api/v1/activities/charges', {
    method: 'POST', headers: { origin: 'https://panel.example', 'content-type': 'application/json',
      'x-csrf-token': 'valid', 'idempotency-key': idempotencyKey }, body: JSON.stringify(data),
  })
  const response = await request('activity_billing_http_create')
  expect(response.status).toBe(201)
  const created = await response.json()
  expect((await request('activity_billing_http_create')).status).toBe(201)
  expect(await (await request('activity_billing_http_create')).json()).toEqual(created)
  const duplicate = await request('activity_billing_http_duplicate')
  expect(duplicate.status).toBe(409)
  expect((await duplicate.json()).error.code).toBe('ACTIVITY_CHARGE_EXISTS')
  const invalid = await request('activity_billing_http_invalid', { ...body, source: {} })
  expect(invalid.status).toBe(400)
})

it('refreshes cached charge settlement after finance edits without writing charge provenance', async () => {
  const readSpecialist = 'sp_activity_read_revision'
  await run(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,professional_title_envelope,standard_rate_grosze,
     status,version,archived_at,created_at,updated_at) VALUES (?,NULL,'{}','{}',18000,'active',1,NULL,?,?)`,
  readSpecialist, now, now)
  const body = { ...await fixture('read_revision', 'english', false), responsibleSpecialistId: readSpecialist }
  const created = await create(command(body, 'activity_read_revision_create'))
  const { chargeId, entryId } = created.body.data
  const window = { from: '2027-06', to: '2027-06' }
  const read = () => readActivityWorkspace({ db: env.DB, actor, keyring, nowMs, window })
  const initial = (await read()).data
  let cache = createLoadedActivitiesState()
  cache = mergeLoadedActivitiesLoad(cache, captureLoadedActivitiesLoad(cache, window), initial).state
  const editedAt = new Date(nowMs + 1000).toISOString()
  await run("UPDATE specialists SET status='archived',archived_at=?,version=version+1,updated_at=? WHERE id=?",
    editedAt, editedAt, readSpecialist)
  await adjustFinanceEntry({ ...command({ expectedVersion: 1, reason: 'Potwierdzono wpłatę',
    accountingMonth: '2027-06', paidAmountGrosze: 6000, paymentMethod: 'transfer',
    settlementStatus: 'partial', invoiceStatus: 'issued' }, 'activity_read_revision_adjust'),
  entryId, nowMs: nowMs + 1000 })
  const updated = (await read()).data
  const charge = updated.charges.find(({ id }) => id === chargeId)
  expect(charge.version).toBe(2)
  expect(charge.updatedAt).toBe(editedAt)
  const merged = mergeLoadedActivitiesLoad(cache, captureLoadedActivitiesLoad(cache, window), updated)
  expect(merged.state.chargesById[chargeId].finance.paidAmountGrosze).toBe(6000)
  expect(merged.state.chargesById[chargeId].finance.settlementStatus).toBe('partial')
  expect(await env.DB.prepare('SELECT version,updated_at FROM activity_charges WHERE id=?')
    .bind(chargeId).first()).toEqual({ version: 1, updated_at: now })
})
