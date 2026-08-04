import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  digestRecordPaymentRequest,
  recordAppointmentPayment,
  validateRecordPaymentBody,
} from '../../worker/core/payments.js'
import { postAppointmentPayment } from '../../worker/routes/appointments.js'
import { createAppointment } from '../../worker/core/appointments.js'
import { createClient } from '../../worker/core/clients.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { encryptForScope, loadDataKey } from '../../worker/security/envelope.js'
import { clientKeyScope } from '../../worker/core/crypto.js'
import {
  areSiblingD1QueryBudgetViews,
  createD1QueryBudget,
  usageForD1QueryBudgetViews,
} from '../../worker/db/query-budget.js'
import { createApp } from '../../worker/app.js'
import {
  applyCoreDirectoryStageB,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const BODY = Object.freeze({
  expectedVersion: 1,
  amountGrosze: 10_000,
  method: 'card',
  receivedAt: '2027-01-15T08:30:00.000Z',
})
const BASE = Object.freeze({
  db: {}, recoveryDb: {},
  actor: { id: 'stf_payment_owner', role: 'owner', specialistId: null },
  keyring: {}, nowMs: Date.parse('2027-01-15T09:00:00.000Z'),
  correlationId: '00000000-0000-4000-8000-000000000022',
  idFactory: () => 'fixture', appointmentId: 'apt_payment_fixture',
  body: BODY, idempotencyKey: 'payment-command-key-0001',
})
const NOW_MS = BASE.nowMs
const OWNER = BASE.actor
const ring = () => createKeyring(env, {
  activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
})
let sequence = 0
let appointmentSequence = 0
const suffixes = (label) => {
  let index = 0
  return () => `${label}_${++index}`
}

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  const now = new Date(NOW_MS).toISOString()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      OWNER.id, 'lookup_payment_owner', '{}', '{}', 'owner', 'active',
      'access-payment-owner', null, 1, now, null, now, now,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_payment_target', 'lookup_payment_target', '{}', '{}', 'specialist',
      'active', 'access-payment-target', 'sp_payment_target', 1, now, null, now, now,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_payment_target', 'stf_payment_target', 19_500, 'active', 1, null, now, now,
    ),
    env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      'ver_payment_target', 'specialist', 'sp_payment_target', 1, '{}', null,
      now, BASE.correlationId,
    ),
  ])
})

const seedAppointment = async (status = 'completed') => {
  const marker = `payment_fixture_${++sequence}`
  const slot = appointmentSequence++
  const client = (await createClient({
    db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(), nowMs: NOW_MS,
    correlationId: BASE.correlationId, idFactory: suffixes(`${marker}_client`),
    body: { name: `Fikcyjna Płatność ${sequence}`, age: 12, status: 'active',
      specialistId: 'sp_payment_target' },
    idempotencyKey: `${marker}-client-key`,
  })).body.data.client
  return (await createAppointment({
    db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(), nowMs: NOW_MS,
    correlationId: BASE.correlationId, idFactory: suffixes(`${marker}_appointment`),
    body: {
      clientId: client.id, specialistId: 'sp_payment_target', serviceId: 'zajecia',
      date: `2027-03-${String(Math.floor(slot / 12) + 1).padStart(2, '0')}`,
      time: `${String(8 + (slot % 12)).padStart(2, '0')}:00`,
      durationMinutes: 50, expectedAmountGrosze: 19_500, location: null, status,
    },
    idempotencyKey: `${marker}-appointment-key`,
  })).body.data.appointment
}

const paymentInput = async (appointment, overrides = {}) => {
  const marker = `payment_command_${++sequence}`
  return {
    db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
    nowMs: NOW_MS + sequence * 1_000, correlationId: BASE.correlationId,
    idFactory: suffixes(marker), appointmentId: appointment.id,
    body: { ...BODY, expectedVersion: appointment.version },
    idempotencyKey: `${marker}-key`, ...overrides,
  }
}

const ledgerSnapshot = async () => Object.fromEntries(await Promise.all(Object.entries({
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
}).map(async ([key, sql]) => [key, (await env.DB.prepare(sql).all()).results])))

const seedPaymentGraph = async (appointment, entries, corrections = []) => {
  const client = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
    .bind(appointment.clientId).first()
  const scope = clientKeyScope(appointment.clientId)
  const dataKey = await loadDataKey(env.DB, {
    envelope: JSON.parse(client.identity_envelope), expectedScope: scope,
  })
  const changedAt = new Date(NOW_MS + 500).toISOString()
  const statements = entries.map((entry) => env.DB.prepare(`INSERT INTO payment_entries
    (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
     external_reference_envelope,created_at) VALUES (?,?,?,?,?,?,NULL,?)`).bind(
    entry.id, appointment.id, entry.amountGrosze, entry.method, entry.receivedAt,
    OWNER.id, entry.createdAt ?? changedAt,
  ))
  for (const correction of corrections) {
    const envelope = await encryptForScope(await ring(), dataKey, {
      expectedScope: scope, recordId: correction.id, field: 'reason',
      plaintext: 'Fikcyjna korekta',
    })
    statements.push(env.DB.prepare(`INSERT INTO payment_corrections
      (id,reversed_entry_id,replacement_entry_id,reason_envelope,
       recorded_by_staff_id,created_at) VALUES (?,?,?,?,?,?)`).bind(
      correction.id, correction.reversedEntryId, correction.replacementEntryId,
      JSON.stringify(envelope), OWNER.id, correction.createdAt ?? changedAt,
    ))
  }
  for (let offset = 0; offset < statements.length; offset += 100) {
    await env.DB.batch(statements.slice(offset, offset + 100))
  }
  await env.DB.prepare('UPDATE appointments SET version=2,updated_at=? WHERE id=? AND version=1')
    .bind(changedAt, appointment.id).run()
  const reversed = new Set(corrections.map(({ reversedEntryId }) => reversedEntryId))
  const collected = entries.filter(({ id }) => !reversed.has(id))
    .reduce((sum, { amountGrosze }) => sum + amountGrosze, 0)
  const snapshot = {
    cancelledAt: null, clientId: appointment.clientId, createdAt: appointment.createdAt,
    endsAt: appointment.endsAt, id: appointment.id, location: appointment.location,
    paymentAggregate: {
      collectedGrosze: collected,
      outstandingGrosze: appointment.charge.expectedAmountGrosze - collected,
      status: collected === 0 ? 'unpaid'
        : collected === appointment.charge.expectedAmountGrosze ? 'paid' : 'partial',
    },
    schema: 'appointment.v1', serviceId: appointment.serviceId, source: 'panel',
    specialistId: appointment.specialistId, startsAt: appointment.startsAt,
    status: appointment.status, timeZone: 'Europe/Warsaw', updatedAt: changedAt, version: 2,
  }
  const envelope = await encryptForScope(await ring(), dataKey, {
    expectedScope: scope, recordId: appointment.id, field: 'record_version',
    plaintext: JSON.stringify(snapshot),
  })
  await env.DB.prepare(`INSERT INTO record_versions
    (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
     changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
    `ver_payment_graph_${++sequence}`, 'appointment', appointment.id, 2,
    JSON.stringify(envelope), OWNER.id, changedAt, BASE.correlationId,
  ).run()
  return Object.freeze({ ...appointment, version: 2, updatedAt: changedAt })
}

describe('appointment payment capture', () => {
  it('strictly captures the exact payment body and canonical digest', async () => {
    expect(validateRecordPaymentBody(BODY)).toEqual(BODY)
    await expect(digestRecordPaymentRequest(BASE.appointmentId, BODY))
      .resolves.toMatch(/^[A-Za-z0-9_-]{43}$/)
    for (const [field, value] of [
      ['expectedVersion', 0], ['amountGrosze', 0], ['amountGrosze', 1_000_001],
      ['method', 'blik'], ['receivedAt', '2027-01-15'],
      ['receivedAt', '2027-01-15T08:30:00Z'],
    ]) {
      expect(() => validateRecordPaymentBody({ ...BODY, [field]: value }))
        .toThrow(`VALIDATION_FAILED/${field}`)
    }
    expect(() => validateRecordPaymentBody({ ...BODY, extra: true }))
      .toThrow('VALIDATION_FAILED/body')
    const getter = vi.fn(() => BODY.amountGrosze)
    const hostile = { ...BODY }
    Object.defineProperty(hostile, 'amountGrosze', { enumerable: true, get: getter })
    expect(() => validateRecordPaymentBody(hostile)).toThrow('VALIDATION_FAILED/body')
    expect(getter).not.toHaveBeenCalled()
  })

  it('maps only closed payment validation fields through the route adapter', async () => {
    const service = vi.fn(async () => ({ status: 200, body: { data: { appointment: {} } } }))
    await expect(postAppointmentPayment({ ...BASE, recordPayment: service }))
      .resolves.toMatchObject({ status: 200 })
    expect(service).toHaveBeenCalledOnce()
    await expect(postAppointmentPayment({
      ...BASE, body: { ...BODY, method: 'blik' }, recordPayment: service,
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', details: { field: 'method' },
    })
  })

  it('atomically appends a partial payment, advances only appointment, audits, and replays first', async () => {
    const appointment = await seedAppointment()
    const input = await paymentInput(appointment)
    const chargeBefore = await env.DB.prepare('SELECT * FROM session_charges WHERE id=?')
      .bind(appointment.charge.id).first()
    const result = await recordAppointmentPayment(input)
    expect(result).toMatchObject({ status: 200, body: { data: { appointment: {
      id: appointment.id, version: 2,
      charge: { id: appointment.charge.id, version: 1 },
      payment: { status: 'partial', collectedGrosze: 10_000,
        outstandingGrosze: 9_500, latestMethod: 'card',
        latestReceivedAt: BODY.receivedAt },
      paymentEntries: [{ amountGrosze: 10_000, method: 'card',
        receivedAt: BODY.receivedAt, correctedAt: null, replacementEntryId: null }],
    } } } })
    expect(await env.DB.prepare('SELECT * FROM session_charges WHERE id=?')
      .bind(appointment.charge.id).first()).toEqual(chargeBefore)
    const paymentId = result.body.data.appointment.paymentEntries[0].id
    expect(await env.DB.prepare(`SELECT appointment_id,amount_grosze,method,received_at,
      recorded_by_staff_id,external_reference_envelope,created_at FROM payment_entries WHERE id=?`)
      .bind(paymentId).first()).toEqual({
      appointment_id: appointment.id, amount_grosze: 10_000, method: 'card',
      received_at: BODY.receivedAt, recorded_by_staff_id: OWNER.id,
      external_reference_envelope: null,
      created_at: new Date(input.nowMs).toISOString(),
    })
    expect(await env.DB.prepare(`SELECT action,entity_type,entity_id,reason_envelope,metadata_json
      FROM audit_events WHERE action='payment.recorded' AND entity_id=?`)
      .bind(appointment.id).first()).toEqual({
      action: 'payment.recorded', entity_type: 'appointment', entity_id: appointment.id,
      reason_envelope: null,
      metadata_json: JSON.stringify({ appointmentVersion: 2, paymentEntryId: paymentId }),
    })
    const replayFactory = vi.fn()
    await expect(recordAppointmentPayment({ ...input, idFactory: replayFactory,
      nowMs: input.nowMs + 1 })).resolves.toEqual(result)
    expect(replayFactory).not.toHaveBeenCalled()
    await expect(recordAppointmentPayment({ ...input, idFactory: vi.fn(), body: {
      ...input.body, amountGrosze: input.body.amountGrosze + 1,
    } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    await expect(recordAppointmentPayment({ ...input, keyring: {}, idFactory: vi.fn() }))
      .rejects.toThrow('CRYPTO_FAILURE')
    const client = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(appointment.clientId).first()
    await env.DB.prepare('UPDATE data_keys SET retired_at=? WHERE id=?').bind(
      new Date(input.nowMs + 2).toISOString(), JSON.parse(client.identity_envelope).dataKeyId,
    ).run()
    await expect(recordAppointmentPayment({ ...input, idFactory: vi.fn(),
      nowMs: input.nowMs + 2 })).resolves.toEqual(result)
  })

  it('supports exact remainder and derives latest by received time rather than insertion', async () => {
    const appointment = await seedAppointment('noshow')
    const firstInput = await paymentInput(appointment, { body: {
      ...BODY, expectedVersion: 1, amountGrosze: 9_500, method: 'cash',
      receivedAt: '2027-01-15T08:45:00.000Z',
    } })
    const first = await recordAppointmentPayment(firstInput)
    const secondInput = await paymentInput(first.body.data.appointment, { body: {
      ...BODY, expectedVersion: 2, amountGrosze: 10_000, method: 'transfer',
      receivedAt: '2027-01-15T08:15:00.000Z',
    } })
    const second = await recordAppointmentPayment(secondInput)
    expect(second.body.data.appointment.payment).toEqual({
      status: 'paid', collectedGrosze: 19_500, outstandingGrosze: 0,
      latestMethod: 'cash', latestReceivedAt: '2027-01-15T08:45:00.000Z',
    })
    expect(second.body.data.appointment.paymentEntries.map(({ method }) => method))
      .toEqual(['transfer', 'cash'])
  })

  it('preserves corrected rows and appends at the exact 1,000-row boundary', async () => {
    const correctedAppointment = await seedAppointment()
    const correctedAt = new Date(NOW_MS + 500).toISOString()
    const correctedMarker = sequence
    const corrected = await seedPaymentGraph(correctedAppointment, [
      { id: `pay_corrected_${correctedMarker}`, amountGrosze: 2_000, method: 'cash',
        receivedAt: '2027-01-15T07:00:00.000Z', createdAt: correctedAt },
      { id: `pay_replacement_${correctedMarker}`, amountGrosze: 3_000, method: 'transfer',
        receivedAt: '2027-01-15T07:30:00.000Z', createdAt: correctedAt },
    ], [{ id: `cor_payment_${correctedMarker}`,
      reversedEntryId: `pay_corrected_${correctedMarker}`,
      replacementEntryId: `pay_replacement_${correctedMarker}`, createdAt: correctedAt }])
    const correctedResult = await recordAppointmentPayment(await paymentInput(corrected, {
      nowMs: NOW_MS + 2_000,
      body: { ...BODY, expectedVersion: 2, amountGrosze: 1_000, method: 'card' },
    }))
    expect(correctedResult.body.data.appointment.payment.collectedGrosze).toBe(4_000)
    expect(correctedResult.body.data.appointment.paymentEntries[0]).toMatchObject({
      correctedAt, replacementEntryId: `pay_replacement_${correctedMarker}`,
    })

    const boundaryAppointment = await seedAppointment()
    const receivedAt = '2027-01-15T07:00:00.000Z'
    const entries = Array.from({ length: 999 }, (_, index) => ({
      id: `pay_boundary_${sequence}_${String(index).padStart(4, '0')}`,
      amountGrosze: 1, method: 'cash', receivedAt,
    }))
    const boundary = await seedPaymentGraph(boundaryAppointment, entries)
    const result = await recordAppointmentPayment(await paymentInput(boundary, {
      nowMs: NOW_MS + 3_000,
      body: { ...BODY, expectedVersion: 2, amountGrosze: 1 },
    }))
    expect(result.body.data.appointment.paymentEntries).toHaveLength(1_000)
    const idFactory = vi.fn()
    await expect(recordAppointmentPayment(await paymentInput(
      result.body.data.appointment, {
        nowMs: NOW_MS + 4_000, idFactory,
        body: { ...BODY, expectedVersion: 3, amountGrosze: 1 },
      },
    ))).rejects.toThrow('PAYMENT_AMOUNT_CONFLICT')
    expect(idFactory).not.toHaveBeenCalled()
  })

  it('rejects stale, nonbillable, overpay, guessed, and unauthorized targets before IDs', async () => {
    for (const status of ['scheduled']) {
      const appointment = await seedAppointment(status)
      const idFactory = vi.fn()
      await expect(recordAppointmentPayment(await paymentInput(appointment, { idFactory })))
        .rejects.toThrow('PAYMENT_AMOUNT_CONFLICT')
      expect(idFactory).not.toHaveBeenCalled()
    }
    const appointment = await seedAppointment()
    for (const overrides of [
      { appointmentId: 'apt_absent' },
      { actor: { id: 'stf_payment_target', role: 'specialist', specialistId: 'sp_other' } },
      { body: { ...BODY, expectedVersion: 2 } },
      { body: { ...BODY, amountGrosze: 19_501 } },
    ]) {
      const idFactory = vi.fn()
      const expectation = expect(recordAppointmentPayment(
        await paymentInput(appointment, { ...overrides, idFactory }),
      )).rejects
      if (overrides.body?.expectedVersion === 2) await expectation.toMatchObject({
        message: 'VERSION_CONFLICT', details: { currentVersion: 1 },
      })
      else if (overrides.body?.amountGrosze) await expectation.toThrow('PAYMENT_AMOUNT_CONFLICT')
      else await expectation.toThrow('NOT_FOUND')
      expect(idFactory).not.toHaveBeenCalled()
    }
  })

  it('allows owner, coordinator, and the exact specialist under payment.manage', async () => {
    const actors = [
      OWNER,
      { id: OWNER.id, role: 'coordinator', specialistId: null },
      { id: 'stf_payment_target', role: 'specialist', specialistId: 'sp_payment_target' },
    ]
    for (const actor of actors) {
      const appointment = await seedAppointment()
      const result = await recordAppointmentPayment(await paymentInput(appointment, { actor }))
      expect(result.status).toBe(200)
    }
  })

  it('accepts the loaded actor authority revision and fails closed on generated ID collisions', async () => {
    const appointment = await seedAppointment()
    await expect(recordAppointmentPayment(await paymentInput(appointment, {
      actor: { ...OWNER, version: 1 },
    }))).resolves.toMatchObject({ status: 200 })
    const collisionTarget = await seedAppointment()
    await env.DB.prepare(`INSERT INTO payment_entries
      (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
       external_reference_envelope,created_at) VALUES (?,?,?,?,?,?,NULL,?)`).bind(
      'pay_forced_collision', appointment.id, 1, 'cash', BODY.receivedAt,
      OWNER.id, new Date(NOW_MS + 1).toISOString(),
    ).run()
    let index = 0
    const idFactory = () => ['forced_collision', 'unused_version', 'unused_audit'][index++]
    await expect(recordAppointmentPayment(await paymentInput(collisionTarget, { idFactory })))
      .rejects.toThrow(/identity_collision/)
    expect(await env.DB.prepare('SELECT count(*) AS count FROM payment_entries WHERE appointment_id=?')
      .bind(collisionTarget.id).first()).toEqual({ count: 0 })
  })

  it('classifies concurrent overpay with at most one winner and no failed residue', async () => {
    const appointment = await seedAppointment()
    const left = await paymentInput(appointment, {
      body: { ...BODY, amountGrosze: 12_000 }, idempotencyKey: `payment-race-left-${sequence}`,
    })
    const right = await paymentInput(appointment, {
      body: { ...BODY, amountGrosze: 12_000 }, idempotencyKey: `payment-race-right-${sequence}`,
    })
    const settled = await Promise.allSettled([
      recordAppointmentPayment(left), recordAppointmentPayment(right),
    ])
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const loser = settled.find(({ status }) => status === 'rejected')
    expect(loser.reason).toMatchObject({ message: 'PAYMENT_AMOUNT_CONFLICT' })
    expect(await env.DB.prepare('SELECT count(*) AS count FROM payment_entries WHERE appointment_id=?')
      .bind(appointment.id).first()).toEqual({ count: 1 })
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM idempotency_records
      WHERE operation='appointments.payment' AND resource_id=?`).bind(appointment.clientId).first())
      .toEqual({ count: 1 })
  })

  it('rolls back every one of the exact six batch statements byte-for-byte', async () => {
    for (let failedAt = 0; failedAt < 6; failedAt += 1) {
      const appointment = await seedAppointment()
      const before = await ledgerSnapshot()
      const db = {
        prepare: (sql) => env.DB.prepare(sql),
        batch: (statements) => env.DB.batch(statements.map((statement, index) => (
          index === failedAt
            ? env.DB.prepare("INSERT INTO core_directory_invariant_failures (failure_kind) VALUES ('forced')")
            : statement
        ))),
      }
      await expect(recordAppointmentPayment(await paymentInput(appointment, { db })))
        .rejects.toThrow()
      expect(await ledgerSnapshot()).toEqual(before)
    }
  })

  it('stays within the frozen normal work and full-route budgets', async () => {
    const appointment = await seedAppointment()
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    await recordAppointmentPayment(await paymentInput(appointment, {
      db: budget.work, recoveryDb: budget.recovery,
    }))
    const usage = usageForD1QueryBudgetViews(budget.work, budget.recovery)
    expect(usage).toEqual({ used: 14, remaining: 36, workRemaining: 28,
      totalLimit: 50, recoveryReserve: 8 })

    const httpAppointment = await seedAppointment()
    let views
    const app = createApp({
      config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl',
        dataMode: 'fictional' },
      db: env.DB, cryptoContext: { keyring: await ring(), dataKey: {}, scope: {} },
      resolveAccessPrincipal: vi.fn(async () => ({ kind: 'human',
        subject: 'access-payment-owner', normalizedEmail: 'owner@example.test' })),
      resolveActor: vi.fn(async () => ({ ...OWNER, version: 1 })),
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
      postAppointmentPayment: async (input) => {
        views = { work: input.db, recovery: input.recoveryDb }
        return postAppointmentPayment(input)
      },
      idFactory: suffixes(`payment_http_${++sequence}`), now: () => NOW_MS + 20_000,
    })
    const response = await app.request(
      `/api/v1/appointments/${httpAppointment.id}/payments`, {
        method: 'POST', headers: {
          origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
          'idempotency-key': `payment-http-${sequence}-key`, 'x-csrf-token': 'valid',
          'x-correlation-id': BASE.correlationId,
        }, body: JSON.stringify(BODY),
      },
    )
    expect(response.status).toBe(200)
    expect(areSiblingD1QueryBudgetViews(views.work, views.recovery)).toBe(true)
    expect(usageForD1QueryBudgetViews(views.work, views.recovery).used)
      .toBeLessThanOrEqual(23)
  })
})
