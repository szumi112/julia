import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createAppointment,
  digestCreateAppointmentRequest,
  validateCreateAppointmentBody,
} from '../../worker/core/appointments.js'
import { postAppointment } from '../../worker/routes/appointments.js'
import { createClient } from '../../worker/core/clients.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { decryptForScope, loadDataKey } from '../../worker/security/envelope.js'
import { clientKeyScope } from '../../worker/core/crypto.js'
import { createD1QueryBudget, usageForD1QueryBudgetViews } from '../../worker/db/query-budget.js'
import { createApp } from '../../worker/app.js'
import {
  applyCoreDirectoryStageB,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = Date.parse('2027-01-15T09:00:00.000Z')
const CORRELATION_ID = '00000000-0000-4000-8000-000000000019'
const OWNER = Object.freeze({ id: 'stf_appointment_owner', role: 'owner', specialistId: null })
const BODY = Object.freeze({
  clientId: 'cl_replaced', specialistId: 'sp_appointment_target', serviceId: 'zajecia',
  date: '2027-01-16', time: '10:00', durationMinutes: 50,
  expectedAmountGrosze: 19_500, location: null, status: 'scheduled',
})
const ring = () => createKeyring(env, {
  activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
})

let sequence = 0
const suffixes = (label) => {
  let index = 0
  return () => `${label}_${++index}`
}

beforeAll(async () => {
  expect(await completeCoreDirectoryStageA()).toMatchObject({ status: 'complete' })
  await applyCoreDirectoryStageB()
  const now = new Date(NOW_MS).toISOString()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      OWNER.id, 'lookup_appointment_owner', '{}', '{}', 'owner', 'active',
      'access-appointment-owner', null, 1, now, null, now, now,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_appointment_target', 'lookup_appointment_target', '{}', '{}', 'coordinator',
      'active', 'access-appointment-target', 'sp_appointment_target', 1,
      now, null, now, now,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_appointment_target', 'stf_appointment_target', 19_500, 'active', 1,
      null, now, now,
    ),
    env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      'ver_appointment_target', 'specialist', 'sp_appointment_target', 1, '{}', null,
      now, CORRELATION_ID,
    ),
  ])
})

const seedClient = async (specialistId = 'sp_appointment_target') => {
  const marker = `appointment_client_${++sequence}`
  const factory = suffixes(marker)
  return (await createClient({
    db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(), nowMs: NOW_MS,
    correlationId: CORRELATION_ID, idFactory: factory,
    body: { name: `Fikcyjny ${sequence}`, age: 12, status: 'active', specialistId },
    idempotencyKey: `${marker}-create-key`,
  })).body.data.client
}

const create = async (client, overrides = {}) => {
  const marker = `appointment_command_${++sequence}`
  return createAppointment({
    db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(), nowMs: NOW_MS,
    correlationId: CORRELATION_ID, idFactory: suffixes(marker),
    body: { ...BODY, clientId: client.id }, idempotencyKey: `${marker}-key`,
    ...overrides,
  })
}

const ledgerSnapshot = async () => {
  const queries = {
    appointments: 'SELECT * FROM appointments ORDER BY id',
    audit: 'SELECT * FROM audit_events ORDER BY id',
    assignments: 'SELECT * FROM client_assignments ORDER BY id',
    charges: 'SELECT * FROM session_charges ORDER BY id',
    clients: 'SELECT * FROM clients ORDER BY id',
    corrections: 'SELECT * FROM payment_corrections ORDER BY id',
    idempotency: 'SELECT * FROM idempotency_records ORDER BY actor_id,operation,idempotency_key',
    keys: 'SELECT * FROM data_keys ORDER BY id',
    payments: 'SELECT * FROM payment_entries ORDER BY id',
    versions: 'SELECT * FROM record_versions ORDER BY id',
  }
  return Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([key, sql]) => [
    key, (await env.DB.prepare(sql).all()).results,
  ])))
}

describe('persistent appointment creation', () => {
  it('strictly captures the nine fields and converts only unique Warsaw wall instants', async () => {
    expect(validateCreateAppointmentBody(BODY)).toEqual({
      clientId: BODY.clientId, specialistId: BODY.specialistId, serviceId: BODY.serviceId,
      durationMinutes: BODY.durationMinutes, expectedAmountGrosze: BODY.expectedAmountGrosze,
      location: BODY.location, status: BODY.status, date: BODY.date, time: BODY.time,
      startsAt: '2027-01-16T09:00:00.000Z', endsAt: '2027-01-16T09:50:00.000Z',
      timeZone: 'Europe/Warsaw',
    })
    expect(validateCreateAppointmentBody({ ...BODY, date: '2027-07-16' }).startsAt)
      .toBe('2027-07-16T08:00:00.000Z')
    for (const body of [
      { ...BODY, date: '2027-03-28', time: '02:30' },
      { ...BODY, date: '2027-10-31', time: '02:30' },
    ]) expect(() => validateCreateAppointmentBody(body)).toThrow('VALIDATION_FAILED/dateTime')
    const getter = vi.fn(() => BODY.clientId)
    const hostile = { ...BODY }
    Object.defineProperty(hostile, 'clientId', { enumerable: true, get: getter })
    expect(() => validateCreateAppointmentBody(hostile)).toThrow('VALIDATION_FAILED/body')
    expect(getter).not.toHaveBeenCalled()
    await expect(digestCreateAppointmentRequest(BODY)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('creates one atomic appointment/charge ledger with canonical billable and nonbillable DTOs', async () => {
    for (const [index, [status, outstanding]] of [['scheduled', 0], ['completed', 19_500], ['noshow', 19_500]].entries()) {
      const client = await seedClient()
      const result = await create(client, { body: { ...BODY, clientId: client.id, status,
        time: `${String(11 + index).padStart(2, '0')}:00` } })
      expect(result.status).toBe(201)
      expect(result.body).toEqual({ data: { appointment: {
        id: expect.stringMatching(/^apt_/), clientId: client.id,
        specialistId: 'sp_appointment_target', serviceId: 'zajecia',
        startsAt: `2027-01-16T${String(10 + index).padStart(2, '0')}:00:00.000Z`,
        endsAt: `2027-01-16T${String(10 + index).padStart(2, '0')}:50:00.000Z`,
        timeZone: 'Europe/Warsaw', location: null, status, source: 'panel', version: 1,
        cancelledAt: null, createdAt: new Date(NOW_MS).toISOString(),
        updatedAt: new Date(NOW_MS).toISOString(),
        charge: { id: expect.stringMatching(/^chg_/), serviceId: 'zajecia',
          expectedAmountGrosze: 19_500, currency: 'PLN', version: 1 },
        payment: { status: 'unpaid', collectedGrosze: 0, outstandingGrosze: outstanding,
          latestMethod: null, latestReceivedAt: null },
        paymentEntries: [],
      } } })
      const appointment = result.body.data.appointment
      expect(await env.DB.prepare('SELECT count(*) AS count FROM appointments WHERE id=?')
        .bind(appointment.id).first()).toEqual({ count: 1 })
      expect(await env.DB.prepare('SELECT count(*) AS count FROM session_charges WHERE appointment_id=?')
        .bind(appointment.id).first()).toEqual({ count: 1 })
      expect((await env.DB.prepare('SELECT entity_type,version FROM record_versions WHERE entity_id IN (?,?) ORDER BY entity_type')
        .bind(appointment.id, appointment.charge.id).all()).results).toEqual([
        { entity_type: 'appointment', version: 1 },
        { entity_type: 'session_charge', version: 1 },
      ])
    }
  })

  it('enforces effective assignment and role scope before IDs', async () => {
    const client = await seedClient()
    for (const [actor, specialistId] of [
      [{ id: 'stf_other_specialist', role: 'specialist', specialistId: 'sp_other' }, 'sp_appointment_target'],
      [OWNER, 'sp_absent'],
    ]) {
      const idFactory = vi.fn()
      await expect(create(client, {
        actor, idFactory, body: { ...BODY, clientId: client.id, specialistId },
        idempotencyKey: `appointment-scope-${++sequence}-key`,
      })).rejects.toThrow('NOT_FOUND')
      expect(idFactory).not.toHaveBeenCalled()
    }
  })

  it('allows every active role within its exact appointment scope independent of target staff role', async () => {
    for (const [index, actor] of [
      OWNER,
      { id: 'stf_appointment_owner', role: 'coordinator', specialistId: null },
      { id: 'stf_appointment_target', role: 'specialist', specialistId: 'sp_appointment_target' },
    ].entries()) {
      const client = await seedClient()
      const result = await create(client, { actor,
        body: { ...BODY, clientId: client.id, date: `2027-02-0${index + 1}` },
        idempotencyKey: `appointment-role-${index}-key`,
      })
      expect(result.status).toBe(201)
    }
  })

  it('uses half-open overlap, ignores cancelled visits, and replays before facts or IDs', async () => {
    const client = await seedClient()
    const visit = { ...BODY, clientId: client.id, date: '2027-01-17' }
    const first = await create(client, { body: visit })
    await expect(create(client, {
      body: { ...visit, time: '10:20' },
    })).rejects.toThrow('APPOINTMENT_OVERLAP')
    const backToBack = await create(client, {
      body: { ...visit, time: '10:50' },
    })
    expect(backToBack.status).toBe(201)
    const replayFactory = vi.fn(() => { throw new Error('must not generate') })
    expect(await createAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(), nowMs: NOW_MS + 99_999,
      correlationId: CORRELATION_ID, idFactory: replayFactory,
      body: visit,
      idempotencyKey: `appointment_command_${sequence - 2}-key`,
    })).toEqual(first)
    expect(replayFactory).not.toHaveBeenCalled()
  })

  it('does not let a cancelled interval block and contains concurrent overlap to one winner', async () => {
    const client = await seedClient()
    const startsAt = '2027-02-10T09:00:00.000Z'
    await env.DB.prepare(`INSERT INTO appointments
      (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,status,
       source,version,cancelled_at,created_at,updated_at)
      VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'cancelled','panel',1,?,?,?)`
    ).bind('apt_cancelled_fixture', client.id, 'sp_appointment_target', startsAt,
      '2027-02-10T09:50:00.000Z', startsAt, new Date(NOW_MS).toISOString(),
      new Date(NOW_MS).toISOString()).run()
    expect((await create(client, { body: { ...BODY, clientId: client.id,
      date: '2027-02-10' } })).status).toBe(201)

    const second = await seedClient()
    const commands = [0, 1].map((index) => create(second, {
      body: { ...BODY, clientId: second.id, date: '2027-02-11' },
      idempotencyKey: `appointment-concurrent-${sequence}-${index}`,
    }))
    const settled = await Promise.allSettled(commands)
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter(({ status }) => status === 'rejected')[0].reason.message)
      .toBe('APPOINTMENT_OVERLAP')
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM appointments
      WHERE specialist_id='sp_appointment_target'
        AND starts_at='2027-02-11T09:00:00.000Z'`).first()).toEqual({ count: 1 })
  })

  it('returns one canonical winner to same-key concurrent retries without duplicate visits', async () => {
    const client = await seedClient()
    const body = { ...BODY, clientId: client.id, date: '2027-02-13' }
    const key = `appointment-same-key-${sequence}`
    const keyring = await ring()
    const command = () => createAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: suffixes(`same_key_${++sequence}`),
      body, idempotencyKey: key,
    })
    const [first, second] = await Promise.all([command(), command()])
    expect(second).toEqual(first)
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM appointments
      WHERE specialist_id='sp_appointment_target'
        AND starts_at='2027-02-13T09:00:00.000Z'`).first()).toEqual({ count: 1 })
  })

  it('stores authenticated client-key histories, exact audit metadata, and closed replay', async () => {
    const client = await seedClient()
    const result = await create(client, { body: { ...BODY, clientId: client.id,
      date: '2027-02-12', status: 'completed', location: 'Gabinet 2' } })
    const appointment = result.body.data.appointment
    const clientRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(client.id).first()
    const scope = clientKeyScope(client.id)
    const dataKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(clientRow.identity_envelope), expectedScope: scope,
    })
    for (const [entityId, schema] of [[appointment.id, 'appointment.v1'], [appointment.charge.id, 'session_charge.v1']]) {
      const row = await env.DB.prepare('SELECT snapshot_envelope FROM record_versions WHERE entity_id=? AND version=1')
        .bind(entityId).first()
      expect(row.snapshot_envelope).not.toContain('Gabinet 2')
      const plaintext = await decryptForScope(await ring(), dataKey, {
        expectedScope: scope, recordId: entityId, field: 'record_version',
        envelope: JSON.parse(row.snapshot_envelope),
      })
      expect(JSON.parse(plaintext).schema).toBe(schema)
    }
    expect(await env.DB.prepare(`SELECT action,entity_type,entity_id,reason_envelope,metadata_json
      FROM audit_events WHERE entity_id=? AND action='appointment.created'`).bind(appointment.id).first())
      .toEqual({ action: 'appointment.created', entity_type: 'appointment',
        entity_id: appointment.id, reason_envelope: null,
        metadata_json: JSON.stringify({ appointmentVersion: 1, chargeVersion: 1 }) })
    const keyId = JSON.parse(clientRow.identity_envelope).dataKeyId
    await env.DB.prepare('UPDATE data_keys SET retired_at=? WHERE id=?')
      .bind(new Date(NOW_MS + 1).toISOString(), keyId).run()
    const replay = await createAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(), nowMs: NOW_MS + 1,
      correlationId: CORRELATION_ID, idFactory: vi.fn(),
      body: { ...BODY, clientId: client.id, date: '2027-02-12', status: 'completed', location: 'Gabinet 2' },
      idempotencyKey: `appointment_command_${sequence}-key`,
    })
    expect(replay).toEqual(result)
  })

  it('fails closed for conflicting replay digests and unavailable owning keys', async () => {
    const client = await seedClient()
    const body = { ...BODY, clientId: client.id, date: '2027-02-14' }
    const result = await create(client, { body })
    const key = `appointment_command_${sequence}-key`
    await expect(createAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(), nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: vi.fn(),
      body: { ...body, expectedAmountGrosze: 19_501 }, idempotencyKey: key,
    })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    await expect(createAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: {}, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: vi.fn(), body, idempotencyKey: key,
    })).rejects.toThrow('CRYPTO_FAILURE')
    expect(result.status).toBe(201)
  })

  it('rolls back every one of the exact seven batch statements and stays within budget', async () => {
    for (let failedAt = 0; failedAt < 7; failedAt += 1) {
      const client = await seedClient()
      const before = await ledgerSnapshot()
      const db = {
        prepare: (sql) => env.DB.prepare(sql),
        batch: (statements) => env.DB.batch(statements.map((statement, index) => index === failedAt
          ? env.DB.prepare("INSERT INTO core_directory_invariant_failures (failure_kind) VALUES ('forced')")
          : statement)),
      }
      await expect(create(client, { db,
        body: { ...BODY, clientId: client.id, date: `2027-01-${String(18 + failedAt).padStart(2, '0')}` },
        idempotencyKey: `appointment-rollback-${sequence}-${failedAt}` }))
        .rejects.toThrow()
      expect(await ledgerSnapshot()).toEqual(before)
    }
    const client = await seedClient()
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    await create(client, { db: budget.work, recoveryDb: budget.recovery,
      body: { ...BODY, clientId: client.id, date: '2027-01-26' } })
    const usage = usageForD1QueryBudgetViews(budget.work, budget.recovery)
    expect(usage).toEqual({ used: 13, remaining: 37, workRemaining: 29,
      totalLimit: 50, recoveryReserve: 8 })
  })

  it('keeps the route adapter exact and maps only safe validation fields', async () => {
    const service = vi.fn(async () => ({ status: 201, body: { data: { appointment: {} } } }))
    const input = { db: {}, recoveryDb: {}, actor: OWNER, keyring: {}, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: vi.fn(), body: BODY,
      idempotencyKey: 'appointment-adapter-key-0001', create: service }
    expect((await postAppointment(input)).status).toBe(201)
    await expect(postAppointment({ ...input, body: { ...BODY, durationMinutes: 60 } }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'durationMinutes' } })
  })

  it('serves create through HTTP while later ledger routes remain inactive', async () => {
    const service = vi.fn(async () => ({ status: 201, body: { data: { appointment: { id: 'apt_http' } } } }))
    const app = createApp({
      config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl', dataMode: 'fictional' },
      db: env.DB, cryptoContext: { keyring: await ring(), dataKey: {}, scope: {} },
      resolveAccessPrincipal: vi.fn(async () => ({ kind: 'human', subject: 'access-http', normalizedEmail: 'http@example.test' })),
      resolveActor: vi.fn(async () => ({ ...OWNER, version: 1 })),
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
      createAppointment: service, safeLog: vi.fn(), now: () => NOW_MS,
    })
    const request = (path) => app.request(path, { method: 'POST', headers: {
      origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
      'idempotency-key': 'appointment-http-key-0001', 'x-csrf-token': 'valid',
      'x-correlation-id': CORRELATION_ID,
    }, body: JSON.stringify(BODY) })
    expect((await request('/api/v1/appointments')).status).toBe(201)
    expect(service).toHaveBeenCalledOnce()
    const later = await app.request('/api/v1/appointments/apt_http/edits', {
      method: 'POST', headers: {
        origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
        'idempotency-key': 'appointment-http-key-0002', 'x-csrf-token': 'valid',
      },
      body: JSON.stringify({ expectedVersion: 1, specialistId: BODY.specialistId,
        serviceId: BODY.serviceId, date: BODY.date, time: BODY.time,
        durationMinutes: BODY.durationMinutes, expectedAmountGrosze: BODY.expectedAmountGrosze,
        location: BODY.location, status: BODY.status }),
    })
    expect(later.status).toBe(404)
  })
})
