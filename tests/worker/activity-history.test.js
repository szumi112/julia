import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'
import { CORE_ROUTE_DESCRIPTORS, createApp } from '../../worker/app.js'
import { auditEventStatement } from '../../worker/audit/events.js'
import { activityDetailStatement, decryptActivityDetails } from '../../worker/audit/activity-history.js'
import { cancelAppointment, createAppointment, editAppointment } from '../../worker/core/appointments.js'
import { createClient, editClient } from '../../worker/core/clients.js'
import { encryptClientIdentity } from '../../worker/core/crypto.js'
import { adjustFinanceEntry, createFinanceEntry } from '../../worker/core/finance-entry-commands.js'
import { voidFinanceEntry } from '../../worker/core/finance-reporting.js'
import { correctAppointmentPayment, recordAppointmentPayment } from '../../worker/core/payments.js'
import { listActivityHistory } from '../../worker/routes/activity-history.js'
import { encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { selectCoreMigrationStage } from '../../scripts/core-migration-stages.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = Date.parse('2026-09-23T12:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const SCOPE = { type: 'staff_directory', id: 'centre_1', purpose: 'identity' }
const correlationId = '99999999-9999-4999-8999-999999999998'
let cryptoContext
const actors = []
const clients = []
const ids = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

const addAudit = (id, occurredAt, actor, action, entityType, entityId, metadata) => (
  auditEventStatement(env.DB, {
    id, occurredAt, actorStaffId: actor.id, action, entityType, entityId,
    result: 'success', correlationId, metadata, reasonEnvelope: null,
  }).run()
)

const request = (actor, query = new URLSearchParams()) => listActivityHistory({
  db: env.DB, cryptoContext, actor, nowMs: NOW_MS, query,
})

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  const stageD = selectCoreMigrationStage(env.TEST_STAGE_D_MIGRATIONS, 'stage-d')
  await applyD1Migrations(env.DB, [stageD.find(({ name }) => (
    name === '0015_unclaimed_specialist_profiles.sql'
  ))])
  await applyWorkbookRegistryStageE()
  const stageF = selectCoreMigrationStage(env.TEST_STAGE_F_MIGRATIONS, 'stage-f')
  await applyD1Migrations(env.DB, stageF.filter(({ name }) => [
    '0026_assignment_starts_at.sql',
    '0027_appointment_cancellation_reason.sql',
    '0028_activity_history.sql',
  ].includes(name)))
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_activity_history_staff', createdAt: NOW,
  })
  cryptoContext = { keyring, dataKey, scope: SCOPE }
  for (const [id, name, role] of [
    ['stf_history_owner', 'Żaneta Właścicielka', 'owner'],
    ['stf_history_coord', 'Ala Koordynatorka', 'coordinator'],
  ]) {
    const nameEnvelope = JSON.stringify(await encryptForScope(keyring, dataKey, {
      expectedScope: SCOPE, recordId: id, field: 'display_name', plaintext: name,
    }))
    await env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,
       access_subject,specialist_id,version,activated_at,created_at,updated_at)
      VALUES (?,?,'{}',?,?,'active',?,NULL,1,?,?,?)`)
      .bind(id, `lookup_${id}`, nameEnvelope, role, `subject_${id}`, NOW, NOW, NOW)
      .run()
    actors.push({
      id, role, specialistId: null, version: 1, authorityRevision: 1,
      capabilities: ROLE_DEFAULT_CAPABILITIES[role],
    })
  }
  const specialistId = 'sp_history_writer'
  const specialistStaffId = 'stf_history_writer'
  const specialistName = 'Maria Specjalistka'
  const specialistNameEnvelope = JSON.stringify(await encryptForScope(keyring, dataKey, {
    expectedScope: SCOPE, recordId: specialistStaffId,
    field: 'display_name', plaintext: specialistName,
  }))
  const profileNameEnvelope = JSON.stringify(await encryptForScope(keyring, dataKey, {
    expectedScope: SCOPE, recordId: specialistId,
    field: 'display_name', plaintext: specialistName,
  }))
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,
     access_subject,specialist_id,version,activated_at,created_at,updated_at)
    VALUES (?,?,'{}',?,'specialist','active',?,?,1,?,?,?)`)
    .bind(specialistStaffId, `lookup_${specialistStaffId}`, specialistNameEnvelope,
      `subject_${specialistStaffId}`, specialistId, NOW, NOW, NOW).run()
  await env.DB.prepare(`INSERT INTO specialists
    (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
     archived_at,created_at,updated_at)
    VALUES (?,?,?,18000,'active',1,NULL,?,?)`)
    .bind(specialistId, specialistStaffId, profileNameEnvelope, NOW, NOW).run()
  await env.DB.prepare(`INSERT INTO record_versions
    (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
     changed_at,correlation_id)
    VALUES ('ver_history_writer','specialist',?,1,'{}',NULL,?,?)`)
    .bind(specialistId, NOW, correlationId).run()
  for (const [id, name] of [
    ['cl_history_zoja', 'Żofia Fikcyjna'],
    ['cl_history_anna', 'Anna Fikcyjna'],
  ]) {
    const scope = { type: 'client', id, purpose: 'identity' }
    const clientKey = await getOrCreateDataKey(env.DB, keyring, scope, {
      id: `key_${id}`, createdAt: NOW,
    })
    const identityEnvelope = await encryptClientIdentity({
      keyring, dataKey: clientKey, scope,
    }, { clientId: id, name, age: 10 })
    await env.DB.prepare(`INSERT INTO clients
      (id,identity_envelope,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,'active',1,NULL,?,?)`)
      .bind(id, identityEnvelope, NOW, NOW).run()
    clients.push({ id, name })
  }
  await addAudit('aud_history_early', '2026-09-22T21:30:00.000Z', actors[0],
    'client.created', 'client', clients[0].id,
    { assignmentId: 'asg_history_zoja', assignmentVersion: 1, clientVersion: 1 })
  await addAudit('aud_history_late', '2026-09-22T22:30:00.000Z', actors[1],
    'client.updated', 'client', clients[1].id, { clientVersion: 2 })
  await addAudit('aud_history_import', '2026-09-22T22:40:00.000Z', actors[0],
    'finance.import.started', 'finance_import', 'fib_history',
    { batchVersion: 1, rowCount: 1 })
  await env.DB.prepare(`INSERT INTO audit_events
    (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
     reason_envelope,correlation_id,metadata_json)
    VALUES ('aud_history_note','2026-09-22T22:50:00.000Z',?,
      'client.note.created','client',?,'success',NULL,?,'{}')`)
    .bind(actors[0].id, clients[0].id, correlationId).run()
})

it('shows only human business events with current names and stable complete filter options', async () => {
  const data = (await request(actors[0])).data
  expect(data.items.map(({ id }) => id)).toEqual(['aud_history_late', 'aud_history_early'])
  expect(data.items[0]).toEqual({
    id: 'aud_history_late', occurredAt: '2026-09-22T22:30:00.000Z',
    kind: 'client', actorName: 'Ala Koordynatorka', clientName: 'Anna Fikcyjna',
    summary: 'Zmieniono dane klienta', details: [],
  })
  expect(data.filters).toEqual({
    actors: [
      { id: actors[1].id, label: 'Ala Koordynatorka' },
      { id: actors[0].id, label: 'Żaneta Właścicielka' },
    ],
    clients: [
      { id: clients[1].id, label: 'Anna Fikcyjna' },
      { id: clients[0].id, label: 'Żofia Fikcyjna' },
    ],
  })
  expect(JSON.stringify(data)).not.toMatch(/correlation|metadata|finance\.import|client\.note|lookup_/)
})

it('filters by Warsaw day, actor, client and kind, and binds the signed cursor to every filter', async () => {
  const first = (await request(actors[0], new URLSearchParams({ limit: '1' }))).data
  expect(first.items.map(({ id }) => id)).toEqual(['aud_history_late'])
  expect(first.nextCursor).toMatch(/^v1\./)
  const second = (await request(actors[0], new URLSearchParams({
    limit: '1', cursor: first.nextCursor,
  }))).data
  expect(second.items.map(({ id }) => id)).toEqual(['aud_history_early'])
  expect(second.nextCursor).toBeNull()
  const filtered = (await request(actors[1], new URLSearchParams({
    actor: actors[1].id, client: clients[1].id, kind: 'client',
    from: '2026-09-23', to: '2026-09-23',
  }))).data
  expect(filtered.items.map(({ id }) => id)).toEqual(['aud_history_late'])
  expect(filtered.filters).toEqual(first.filters)
  await expect(request(actors[0], new URLSearchParams({
    limit: '1', actor: actors[0].id, cursor: first.nextCursor,
  }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  await expect(request(actors[0], new URLSearchParams({
    limit: '1', cursor: `${first.nextCursor.slice(0, -1)}A`,
  }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
})

it('denies the feed without activity.read and rejects malformed query syntax', async () => {
  const specialist = {
    id: 'stf_history_specialist', role: 'specialist', specialistId: 'sp_history_specialist',
    version: 1, authorityRevision: 1,
    capabilities: ROLE_DEFAULT_CAPABILITIES.specialist,
  }
  await expect(request(specialist)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(request(actors[0], new URLSearchParams('kind=client&kind=payment')))
    .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  await expect(request(actors[0], new URLSearchParams('from=2026-02-30')))
    .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
})

it('serves the history through the authenticated HTTP route and its capability descriptor', async () => {
  expect(CORE_ROUTE_DESCRIPTORS.find(({ id }) => id === 'activity.history')).toMatchObject({
    path: '/api/v1/activity', capability: 'activity.read',
    methods: ['GET', 'HEAD', 'OPTIONS'], queryMode: 'handler',
  })
  const appFor = (actor) => createApp({
    config: { appEnv: 'staging', appOrigin: 'https://panel.example', dataMode: 'fictional' },
    db: env.DB, cryptoContext,
    resolveAccessPrincipal: async () => ({ kind: 'human', subject: `subject_${actor.id}`,
      normalizedEmail: 'history@example.test' }),
    resolveActor: async () => actor, now: () => NOW_MS, safeLog: () => {},
  })
  const response = await appFor(actors[1]).request('/api/v1/activity?kind=client')
  expect(response.status).toBe(200)
  expect((await response.json()).data.items.map(({ summary }) => summary)).toEqual([
    'Zmieniono dane klienta', 'Dodano klienta',
  ])
  const invalid = await appFor(actors[0]).request('/api/v1/activity?kind=client&kind=payment')
  expect(invalid.status).toBe(400)
  const specialist = {
    id: 'stf_history_specialist', role: 'specialist', specialistId: 'sp_history_specialist',
    version: 1, authorityRevision: 1,
    capabilities: ROLE_DEFAULT_CAPABILITIES.specialist,
  }
  const denied = await appFor(specialist).request('/api/v1/activity')
  expect(denied.status).toBe(403)
})

it('paginates human staff events whose existing audit IDs have no aud_ prefix', async () => {
  for (const [id, occurredAt, invitationId] of [
    ['88888888-8888-4888-8888-888888888801', '2026-09-23T11:00:00.000Z', 'inv_history_one'],
    ['88888888-8888-4888-8888-888888888802', '2026-09-23T11:01:00.000Z', 'inv_history_two'],
  ]) await addAudit(id, occurredAt, actors[0], 'staff.invited', 'staff_invitation',
    invitationId, {
      staffVersion: 1, invitationVersion: 1, desiredGeneration: 1,
      specialistVersion: null,
    })
  const first = (await request(actors[0], new URLSearchParams({
    kind: 'team', limit: '1',
  }))).data
  expect(first.items).toMatchObject([{ id: '88888888-8888-4888-8888-888888888802',
    summary: 'Zaproszono osobę do zespołu' }])
  expect(first.nextCursor).toMatch(/^v1\./)
  const second = (await request(actors[0], new URLSearchParams({
    kind: 'team', limit: '1', cursor: first.nextCursor,
  }))).data
  expect(second.items).toMatchObject([{ id: '88888888-8888-4888-8888-888888888801' }])
  expect(second.nextCursor).toBeNull()
})

it('stores only allow-listed differences encrypted under the existing finance key', async () => {
  const scope = { type: 'centre_finance', id: 'centre_1', purpose: 'ledger' }
  const dataKey = await getOrCreateDataKey(env.DB, cryptoContext.keyring, scope, {
    id: 'key_activity_history_finance', createdAt: NOW,
  })
  await addAudit('aud_history_finance', '2026-09-23T09:00:00.000Z', actors[0],
    'finance.entry.created', 'finance_entry', 'fin_history', { entryVersion: 1 })
  const statement = await activityDetailStatement(env.DB, {
    auditId: 'aud_history_finance', action: 'finance.entry.created',
    keyring: cryptoContext.keyring, dataKey, scope,
    changes: [{ field: 'amount', before: null, after: 12000 }],
  })
  await statement.run()
  const raw = await env.DB.prepare(
    `SELECT details_envelope FROM activity_history_details
     WHERE audit_id='aud_history_finance'`,
  ).first()
  expect(raw.details_envelope).not.toMatch(/12000|Kwota|amount/)
  expect(await decryptActivityDetails({
    keyring: cryptoContext.keyring, dataKey, scope,
    auditId: 'aud_history_finance', action: 'finance.entry.created',
    envelope: raw.details_envelope,
  })).toEqual([{ field: 'amount', before: null, after: 12000 }])
  await expect(activityDetailStatement(env.DB, {
    auditId: 'aud_history_rejected', action: 'client.updated',
    keyring: cryptoContext.keyring, dataKey, scope,
    changes: [{ field: 'amount', before: null, after: 12000 }],
  })).rejects.toThrow('ACTIVITY_DETAILS_INVALID')
  await expect(activityDetailStatement(env.DB, {
    auditId: 'aud_history_rejected', action: 'finance.entry.created',
    keyring: cryptoContext.keyring, dataKey, scope,
    changes: [{ field: 'notes', before: null, after: 'private' }],
  })).rejects.toThrow('ACTIVITY_DETAILS_INVALID')
})

it('writes appointment creation and edit details atomically and resolves them in the feed', async () => {
  const client = (await createClient({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 1000,
    correlationId, idFactory: ids('history_client'),
    body: { name: 'Nowy Fikcyjny', age: 12, status: 'active',
      specialistId: 'sp_history_writer' },
    idempotencyKey: 'history-client-create-key',
  })).body.data.client
  const body = {
    clientId: client.id, specialistId: 'sp_history_writer', serviceId: 'zajecia',
    date: '2026-09-24', time: '10:00', durationMinutes: 50,
    expectedAmountGrosze: 18000, location: 'PRIVATE PLACE', status: 'scheduled',
  }
  const appointment = (await createAppointment({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 2000,
    correlationId, idFactory: ids('history_appointment'),
    body, idempotencyKey: 'history-appointment-create-key',
  })).body.data.appointment
  const { clientId: unusedClientId, ...editBody } = body
  void unusedClientId
  const edited = (await editAppointment({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 3000,
    correlationId, idFactory: ids('history_edit'), appointmentId: appointment.id,
    body: { ...editBody, expectedVersion: appointment.version, time: '11:00',
      location: 'OTHER PRIVATE PLACE' },
    idempotencyKey: 'history-appointment-edit-key',
  })).body.data.appointment
  expect(edited.version).toBe(2)
  const detailRows = (await env.DB.prepare(`SELECT audit.action,detail.details_envelope
    FROM audit_events AS audit
    LEFT JOIN activity_history_details AS detail ON detail.audit_id=audit.id
    WHERE audit.entity_id=? AND audit.action IN ('appointment.created','appointment.updated')
    ORDER BY audit.occurred_at`).bind(appointment.id).all()).results
  expect(detailRows).toHaveLength(2)
  expect(detailRows.every(({ details_envelope }) => typeof details_envelope === 'string')).toBe(true)
  expect(JSON.stringify(detailRows)).not.toMatch(/PRIVATE PLACE|OTHER PRIVATE PLACE|18000|2026-09-24T/)
  const feed = (await request(actors[0], new URLSearchParams({
    client: client.id, kind: 'appointment',
  }))).data
  expect(feed.items.map(({ summary }) => summary)).toEqual(['Zmieniono sesję', 'Dodano sesję'])
  expect(feed.items[0].details).toEqual([{
    field: 'Termin', before: expect.any(String), after: expect.any(String),
  }])
  expect(feed.items[0].details[0].before).not.toEqual(feed.items[0].details[0].after)
})

it('creates, edits and cancels appointments after the client contact snapshot becomes v2', async () => {
  const client = (await createClient({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 10_000,
    correlationId, idFactory: ids('history_contact_client'),
    body: { name: 'Kontakt Fikcyjny', age: 11, status: 'active',
      specialistId: 'sp_history_writer' },
    idempotencyKey: 'history-contact-client-create-key',
  })).body.data.client
  const withContacts = (await editClient({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 11_000,
    correlationId, idFactory: ids('history_contact_edit'), clientId: client.id,
    body: {
      expectedVersion: client.version, name: client.name, age: client.age,
      status: client.status, specialistId: client.assignment.specialistId,
      assignmentStartsAt: null, guardianPhone: '+48 600 100 200',
      guardianEmail: 'opiekun@example.test', receptionNotes: 'Fikcyjna informacja',
    },
    idempotencyKey: 'history-contact-client-edit-key',
  })).body.data.client
  expect(withContacts.version).toBe(2)
  const body = {
    clientId: client.id, specialistId: 'sp_history_writer', serviceId: 'zajecia',
    date: '2026-09-25', time: '10:00', durationMinutes: 50,
    expectedAmountGrosze: 18000, location: 'Gabinet 1', status: 'scheduled',
  }
  const appointment = (await createAppointment({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 12_000,
    correlationId, idFactory: ids('history_contact_appointment'),
    body, idempotencyKey: 'history-contact-appointment-create-key',
  })).body.data.appointment
  const { clientId: unusedClientId, ...editBody } = body
  void unusedClientId
  const edited = (await editAppointment({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 13_000,
    correlationId, idFactory: ids('history_contact_appointment_edit'),
    appointmentId: appointment.id,
    body: { ...editBody, expectedVersion: appointment.version, time: '11:00' },
    idempotencyKey: 'history-contact-appointment-edit-key',
  })).body.data.appointment
  const cancelled = (await cancelAppointment({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 14_000,
    correlationId, idFactory: ids('history_contact_appointment_cancel'),
    appointmentId: appointment.id,
    body: { expectedVersion: edited.version, reason: 'client' },
    idempotencyKey: 'history-contact-appointment-cancel-key',
  })).body.data.appointment
  expect(cancelled.status).toBe('cancelled')
  const feed = (await request(actors[0], new URLSearchParams({
    client: client.id, kind: 'appointment',
  }))).data
  expect(feed.items.map(({ summary }) => summary)).toEqual([
    'Odwołano sesję', 'Zmieniono sesję', 'Dodano sesję',
  ])
  expect(JSON.stringify(feed)).not.toMatch(/600 100 200|opiekun@|Fikcyjna informacja/)
})

it('records only encrypted payment amount changes for a new payment and correction', async () => {
  const client = (await createClient({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 20_000,
    correlationId, idFactory: ids('history_payment_client'),
    body: { name: 'Płatność Fikcyjna', age: 9, status: 'active',
      specialistId: 'sp_history_writer' },
    idempotencyKey: 'history-payment-client-create-key',
  })).body.data.client
  const appointment = (await createAppointment({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 21_000,
    correlationId, idFactory: ids('history_payment_appointment'),
    body: {
      clientId: client.id, specialistId: 'sp_history_writer', serviceId: 'zajecia',
      date: '2026-09-26', time: '10:00', durationMinutes: 50,
      expectedAmountGrosze: 18000, location: null, status: 'completed',
    },
    idempotencyKey: 'history-payment-appointment-create-key',
  })).body.data.appointment
  const recorded = (await recordAppointmentPayment({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 22_000,
    correlationId, idFactory: ids('history_payment_record'),
    appointmentId: appointment.id,
    body: { expectedVersion: appointment.version, amountGrosze: 8000,
      method: 'card', receivedAt: NOW },
    idempotencyKey: 'history-payment-record-key',
  })).body.data.appointment
  const paymentId = recorded.paymentEntries[0].id
  await correctAppointmentPayment({
    db: env.DB, recoveryDb: env.DB, actor: actors[0],
    keyring: cryptoContext.keyring, nowMs: NOW_MS + 23_000,
    correlationId, idFactory: ids('history_payment_correct'), paymentId,
    body: { expectedVersion: recorded.version, reason: 'Fikcyjna korekta',
      replacement: { amountGrosze: 6000, method: 'transfer', receivedAt: NOW } },
    idempotencyKey: 'history-payment-correct-key',
  })
  const rows = (await env.DB.prepare(`SELECT audit.action,detail.details_envelope
    FROM audit_events AS audit
    LEFT JOIN activity_history_details AS detail ON detail.audit_id=audit.id
    WHERE audit.action IN ('payment.recorded','payment.corrected')
      AND (audit.entity_id=? OR audit.entity_id=?)
    ORDER BY audit.occurred_at`).bind(appointment.id, paymentId).all()).results
  expect(rows).toHaveLength(2)
  expect(rows.every(({ details_envelope }) => typeof details_envelope === 'string')).toBe(true)
  expect(JSON.stringify(rows)).not.toMatch(/8000|6000|Fikcyjna korekta/)
  const feed = (await request(actors[0], new URLSearchParams({
    client: client.id, kind: 'payment',
  }))).data
  expect(feed.items.map(({ summary }) => summary)).toEqual([
    'Poprawiono wpłatę', 'Zapisano wpłatę',
  ])
  expect(feed.items.map(({ details }) => details[0])).toEqual([
    { field: 'Kwota', before: '80,00 zł', after: '60,00 zł' },
    { field: 'Kwota', before: 'Brak', after: '80,00 zł' },
  ])
  expect(JSON.stringify(feed)).not.toContain('Fikcyjna korekta')
})

it('stores finance entry amount details without showing the counterparty or adjustment reason', async () => {
  const financeInput = (body, idFactory, idempotencyKey) => ({
    db: env.DB, actor: actors[0], keyring: cryptoContext.keyring,
    nowMs: NOW_MS + 30_000, correlationId, idFactory, body, idempotencyKey,
  })
  const entry = {
    kind: 'expense', recordType: 'expense', accountingMonth: '2026-09',
    occurredOn: '2026-09-23', amountGrosze: 12500, paidAmountGrosze: 0,
    paymentMethod: 'unknown', settlementStatus: 'unknown', invoiceStatus: 'unknown',
    counterparty: 'PRYWATNY DOSTAWCA', sourceLabel: 'Materiały', invoiceNote: '',
    specialistId: null, lessonCount: null, source: null,
  }
  const created = await createFinanceEntry(financeInput(
    entry, ids('history_finance_create'), 'history-finance-create-key',
  ))
  const entryId = created.body.data.entryId
  await adjustFinanceEntry({
    ...financeInput({
      expectedVersion: 1, reason: 'PRYWATNY POWÓD', accountingMonth: '2026-09',
      paidAmountGrosze: 12500, paymentMethod: 'transfer',
      settlementStatus: 'paid', invoiceStatus: 'issued',
    }, ids('history_finance_adjust'), 'history-finance-adjust-key'),
    nowMs: NOW_MS + 31_000, entryId,
  })
  await voidFinanceEntry({
    db: env.DB, actor: actors[0], keyring: cryptoContext.keyring,
    nowMs: NOW_MS + 32_000, correlationId,
    idFactory: ids('history_finance_void'), entryId, expectedVersion: 2,
    reason: 'PRYWATNY POWÓD UNIEWAŻNIENIA',
    idempotencyKey: 'history-finance-void-key',
  })
  const rows = (await env.DB.prepare(`SELECT audit.action,detail.details_envelope
    FROM audit_events AS audit
    LEFT JOIN activity_history_details AS detail ON detail.audit_id=audit.id
    WHERE audit.entity_id=? AND audit.action IN (
      'finance.entry.created','finance.entry.adjusted','finance.entry.voided')
    ORDER BY audit.occurred_at`).bind(entryId).all()).results
  expect(rows).toHaveLength(3)
  expect(rows.every(({ details_envelope }) => typeof details_envelope === 'string')).toBe(true)
  expect(JSON.stringify(rows)).not.toMatch(/12500|PRYWATNY/)
  const feed = (await request(actors[0], new URLSearchParams({ kind: 'finance' }))).data
  expect(feed.items.slice(0, 3).map(({ summary }) => summary)).toEqual([
    'Unieważniono wpis finansowy', 'Poprawiono wpis finansowy', 'Dodano wpis finansowy',
  ])
  expect(feed.items.slice(0, 3).map(({ details }) => details[0])).toEqual([
    { field: 'Kwota', before: '125,00 zł', after: '0,00 zł' },
    { field: 'Kwota', before: '0,00 zł', after: '125,00 zł' },
    { field: 'Kwota', before: 'Brak', after: '125,00 zł' },
  ])
  expect(JSON.stringify(feed)).not.toMatch(/PRYWATNY/)
})

it('voids a supported zero-value English entry without an empty detail envelope', async () => {
  const scope = { type: 'centre_finance', id: 'centre_1', purpose: 'ledger' }
  await getOrCreateDataKey(env.DB, cryptoContext.keyring, scope, {
    id: 'key_history_zero_finance', createdAt: NOW,
  })
  const entryId = 'fin_history_zero_english'
  await env.DB.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
     specialist_id,appointment_id,counterparty_lookup,details_envelope,source_row_envelope,
     version,created_by_staff_id,created_at,updated_at)
    VALUES (?,NULL,NULL,'income','english','2026-09','2026-09-23',
      0,0,'unknown','paid','not_required',NULL,NULL,NULL,'{}',NULL,1,?,?,?)`)
    .bind(entryId, actors[0].id, NOW, NOW).run()
  await voidFinanceEntry({
    db: env.DB, actor: actors[0], keyring: cryptoContext.keyring,
    nowMs: NOW_MS + 40_000, correlationId,
    idFactory: ids('history_zero_void'), entryId, expectedVersion: 1,
    reason: 'Fikcyjne unieważnienie', idempotencyKey: 'history-zero-void-key',
  })
  const row = await env.DB.prepare(`SELECT detail.details_envelope
    FROM audit_events AS audit
    LEFT JOIN activity_history_details AS detail ON detail.audit_id=audit.id
    WHERE audit.action='finance.entry.voided' AND audit.entity_id=?`)
    .bind(entryId).first()
  expect(row.details_envelope).toBeNull()
  const feed = (await request(actors[0], new URLSearchParams({ kind: 'finance' }))).data
  expect(feed.items.find(({ summary, occurredAt }) => (
    summary === 'Unieważniono wpis finansowy'
      && occurredAt === new Date(NOW_MS + 40_000).toISOString()
  ))?.details).toEqual([])
})
