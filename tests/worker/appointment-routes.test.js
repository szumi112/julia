import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertAppointmentPaymentTransition,
  cancelAppointment,
  createAppointment,
  digestCancelAppointmentRequest,
  editAppointment,
  digestEditAppointmentRequest,
  digestCreateAppointmentRequest,
  validateEditAppointmentBody,
  validateCancelAppointmentBody,
  validateCreateAppointmentBody,
} from '../../worker/core/appointments.js'
import {
  postAppointment,
  postAppointmentCancellation,
  postAppointmentEdit,
} from '../../worker/routes/appointments.js'
import { createClient, editClient } from '../../worker/core/clients.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { decryptForScope, encryptForScope, loadDataKey } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
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
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_appointment_second', 'lookup_appointment_second', '{}', '{}', 'owner',
      'active', 'access-appointment-second', 'sp_appointment_second', 1,
      now, null, now, now,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_appointment_second', 'stf_appointment_second', 20_000, 'active', 1,
      null, now, now,
    ),
    env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      'ver_appointment_second', 'specialist', 'sp_appointment_second', 1, '{}', null,
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

  it('selects a historical effective assignment independently of the one terminal open assignment', async () => {
    const client = await seedClient()
    const editIds = suffixes(`appointment_reassign_${++sequence}`)
    await editClient({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 2 * 60 * 60 * 1000, correlationId: CORRELATION_ID,
      idFactory: editIds, clientId: client.id,
      body: { expectedVersion: 1, name: `Fikcyjny ${sequence - 1}`, age: 12,
        status: 'active', specialistId: 'sp_appointment_second' },
      idempotencyKey: `appointment-reassign-${sequence}-key`,
    })
    const cases = [
      ['09:59', 'sp_appointment_target', false],
      ['10:00', 'sp_appointment_target', true],
      ['11:59', 'sp_appointment_target', true],
      ['12:00', 'sp_appointment_target', false],
      ['12:00', 'sp_appointment_second', true],
    ]
    for (const [index, [time, specialistId, allowed]] of cases.entries()) {
      const operation = create(client, {
        body: { ...BODY, clientId: client.id, date: '2027-01-15', time, specialistId },
        idempotencyKey: `appointment-assignment-boundary-${sequence}-${index}`,
      })
      if (allowed) expect((await operation).status).toBe(201)
      else await expect(operation).rejects.toThrow('NOT_FOUND')
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

  it('rechecks stored idempotency when a winner commits between replay and overlap preflight', async () => {
    const run = async ({ differentDigest = false, malformedRecovery = false }) => {
      const client = await seedClient()
      const date = malformedRecovery ? '2027-02-18'
        : differentDigest ? '2027-02-16' : '2027-02-15'
      const key = `appointment-overlap-replay-${sequence}-${differentDigest}-${malformedRecovery}`
      const winnerBody = { ...BODY, clientId: client.id, date }
      const loserBody = { ...winnerBody,
        expectedAmountGrosze: differentDigest ? BODY.expectedAmountGrosze + 1 : BODY.expectedAmountGrosze }
      const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
      let recoveryReads = 0
      const recoveryDb = { prepare(sql) {
        recoveryReads += 1
        const prepared = budget.recovery.prepare(sql)
        if (!malformedRecovery || recoveryReads !== 2) return prepared
        return { bind(...bindings) {
          const bound = prepared.bind(...bindings)
          return { async first() { await bound.first(); return null } }
        } }
      } }
      let injected = false
      let winner
      const db = {
        prepare(sql) {
          const prepared = budget.work.prepare(sql)
          if (!injected && sql.includes('SELECT 1 AS blocked FROM appointments')) {
            return {
              bind(...bindings) {
                const bound = prepared.bind(...bindings)
                return { async first() {
                  injected = true
                  winner = await createAppointment({
                    db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
                    nowMs: NOW_MS, correlationId: CORRELATION_ID,
                    idFactory: suffixes(`appointment_overlap_winner_${++sequence}`),
                    body: winnerBody, idempotencyKey: key,
                  })
                  return bound.first()
                } }
              },
            }
          }
          return prepared
        },
        batch: (statements) => budget.work.batch(statements),
      }
      const idFactory = vi.fn()
      const loser = createAppointment({
        db, recoveryDb, actor: OWNER, keyring: await ring(), nowMs: NOW_MS,
        correlationId: CORRELATION_ID, idFactory, body: loserBody, idempotencyKey: key,
      })
      if (malformedRecovery) await expect(loser).rejects.toThrow('CRYPTO_FAILURE')
      else if (differentDigest) await expect(loser).rejects.toThrow('IDEMPOTENCY_CONFLICT')
      else expect(await loser).toEqual(winner)
      expect(idFactory).not.toHaveBeenCalled()
      expect(recoveryReads).toBe(2)
      expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
        used: 9, remaining: 41, workRemaining: 33,
        totalLimit: 50, recoveryReserve: 8,
      })
    }
    await run({ differentDigest: false })
    await run({ differentDigest: true })
    await run({ malformedRecovery: true })
  })

  it('classifies an unrelated overlap with one work read and zero reserve reads', async () => {
    const client = await seedClient()
    const date = '2027-02-08'
    await create(client, { body: { ...BODY, clientId: client.id, date } })
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    let recoveryReads = 0
    const recoveryDb = { prepare(sql) {
      recoveryReads += 1
      return budget.recovery.prepare(sql)
    } }
    await expect(create(client, {
      db: budget.work, recoveryDb,
      body: { ...BODY, clientId: client.id, date, time: '10:10' },
      idempotencyKey: `appointment-unrelated-overlap-${sequence}`,
    })).rejects.toThrow('APPOINTMENT_OVERLAP')
    expect(recoveryReads).toBe(0)
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 7, remaining: 43, workRemaining: 35,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('fails closed on a malformed stored-operation proof without entering reserve recovery', async () => {
    const client = await seedClient()
    const date = '2027-02-09'
    await create(client, { body: { ...BODY, clientId: client.id, date } })
    let recoveryReads = 0
    const recoveryDb = { prepare(sql) {
      recoveryReads += 1
      return env.DB.prepare(sql)
    } }
    const db = {
      batch: (statements) => env.DB.batch(statements),
      prepare(sql) {
        const prepared = env.DB.prepare(sql)
        if (!sql.includes('SELECT 1 AS stored FROM idempotency_records')) return prepared
        return { bind(...bindings) {
          const bound = prepared.bind(...bindings)
          return { async first() { await bound.first(); return { stored: 2 } } }
        } }
      },
    }
    await expect(create(client, {
      db, recoveryDb,
      body: { ...BODY, clientId: client.id, date, time: '10:10' },
      idempotencyKey: `appointment-malformed-${sequence}-key`,
    })).rejects.toThrow('CRYPTO_FAILURE')
    expect(recoveryReads).toBe(0)
  })

  it('rejects cross-type retained histories before IDs and generated cross-type rows atomically', async () => {
    for (const target of ['client', 'assignment']) {
      const client = await seedClient()
      const entityId = target === 'client' ? client.id : client.assignment.id
      const source = await env.DB.prepare('SELECT snapshot_envelope FROM record_versions WHERE entity_id=? LIMIT 1')
        .bind(entityId).first()
      await env.DB.prepare(`INSERT INTO record_versions
        (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
         changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
        `ver_cross_type_${target}_${++sequence}`,
        target === 'client' ? 'client_assignment' : 'client', entityId, 99,
        source.snapshot_envelope, OWNER.id, new Date(NOW_MS).toISOString(), CORRELATION_ID,
      ).run()
      const idFactory = vi.fn()
      await expect(create(client, { idFactory,
        body: { ...BODY, clientId: client.id, date: `2027-03-0${sequence % 9 + 1}` },
        idempotencyKey: `appointment-cross-history-${target}-${sequence}`,
      })).rejects.toThrow('NOT_FOUND')
      expect(idFactory).not.toHaveBeenCalled()
    }

    const client = await seedClient()
    await env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      `ver_cross_generated_${++sequence}`, 'client', 'apt_cross_generated', 77,
      '{}', OWNER.id, new Date(NOW_MS).toISOString(), CORRELATION_ID,
    ).run()
    const before = await ledgerSnapshot()
    const values = ['cross_generated', `cross_charge_${sequence}`, `cross_apt_ver_${sequence}`,
      `cross_charge_ver_${sequence}`, `cross_audit_${sequence}`]
    await expect(create(client, {
      idFactory: () => values.shift(),
      body: { ...BODY, clientId: client.id, date: '2027-03-20' },
      idempotencyKey: `appointment-cross-generated-${sequence}`,
    })).rejects.toThrow()
    expect(await ledgerSnapshot()).toEqual(before)
  })

  it('preserves the invariant failure when an overlap race combines with a generated cross-type row', async () => {
    const client = await seedClient()
    const now = new Date(NOW_MS).toISOString()
    await env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      `ver_combined_cross_${++sequence}`, 'client', 'apt_combined_target', 88,
      '{}', OWNER.id, now, CORRELATION_ID,
    ).run()
    let raced = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!raced) {
          raced = true
          await env.DB.prepare(`INSERT INTO appointments
            (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
             status,source,version,cancelled_at,created_at,updated_at)
            VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'scheduled','panel',1,NULL,?,?)`
          ).bind('apt_combined_blocker', client.id, 'sp_appointment_target',
            '2027-03-21T09:00:00.000Z', '2027-03-21T09:50:00.000Z', now, now).run()
        }
        return env.DB.batch(statements)
      },
    }
    const values = ['combined_target', `combined_charge_${sequence}`,
      `combined_apt_ver_${sequence}`, `combined_charge_ver_${sequence}`,
      `combined_audit_${sequence}`]
    let failure
    try {
      await create(client, { db, idFactory: () => values.shift(),
        body: { ...BODY, clientId: client.id, date: '2027-03-21' },
        idempotencyKey: `appointment-combined-race-${sequence}` })
    } catch (error) { failure = error }
    expect(failure?.message).toMatch(/core_directory_invariant_failed/)
    expect(failure?.message).not.toBe('APPOINTMENT_OVERLAP')
    expect(await env.DB.prepare("SELECT count(*) AS count FROM appointments WHERE id='apt_combined_target'").first())
      .toEqual({ count: 0 })
  })

  it('rolls back concurrent assignment branches and never masks branch plus overlap corruption', async () => {
    for (const combined of [false, true]) {
      const client = await seedClient()
      const now = new Date(NOW_MS).toISOString()
      const keyRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
        .bind(client.id).first()
      const dataKeyId = JSON.parse(keyRow.identity_envelope).dataKeyId
      const marker = `branch_${combined}_${++sequence}`
      const date = combined ? '2027-03-23' : '2027-03-22'
      let raced = false
      const db = {
        prepare: (sql) => env.DB.prepare(sql),
        async batch(statements) {
          if (!raced) {
            raced = true
            const branches = [
              { id: `asg_${marker}_one`, startsAt: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString() },
              { id: `asg_${marker}_two`, startsAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString() },
            ]
            for (const branch of branches) {
              await env.DB.prepare(`INSERT INTO client_assignments
                (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
                 version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
                branch.id, client.id, 'sp_appointment_target', branch.startsAt, now,
                OWNER.id, 2, branch.startsAt, now,
              ).run()
              for (const version of [1, 2]) {
                await env.DB.prepare(`INSERT INTO record_versions
                  (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
                   changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
                  `ver_${marker}_${branch.id}_${version}`, 'client_assignment', branch.id,
                  version, JSON.stringify({ dataKeyId, dataKeyVersion: 1 }), OWNER.id,
                  version === 1 ? branch.startsAt : now, CORRELATION_ID,
                ).run()
              }
            }
            if (combined) {
              await env.DB.prepare(`INSERT INTO appointments
                (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
                 status,source,version,cancelled_at,created_at,updated_at)
                VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'scheduled','panel',1,NULL,?,?)`
              ).bind(`apt_${marker}_blocker`, client.id, 'sp_appointment_target',
                '2027-03-23T09:00:00.000Z', '2027-03-23T09:50:00.000Z', now, now).run()
            }
          }
          return env.DB.batch(statements)
        },
      }
      const generated = [`${marker}_target`, `${marker}_charge`, `${marker}_apt_ver`,
        `${marker}_charge_ver`, `${marker}_audit`]
      let failure
      try {
        await create(client, { db, idFactory: () => generated.shift(),
          body: { ...BODY, clientId: client.id, date },
          idempotencyKey: `appointment-${marker}-key` })
      } catch (error) { failure = error }
      expect(failure?.message).toMatch(/core_directory_invariant_failed/)
      expect(failure?.message).not.toBe('APPOINTMENT_OVERLAP')
      expect(await env.DB.prepare('SELECT count(*) AS count FROM appointments WHERE id=?')
        .bind(`apt_${marker}_target`).first()).toEqual({ count: 0 })
    }
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

  it('serves create through HTTP while an absent cancellation target remains opaque', async () => {
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
    const later = await app.request('/api/v1/appointments/apt_http/cancellation', {
      method: 'POST', headers: {
        origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
        'idempotency-key': 'appointment-http-key-0002', 'x-csrf-token': 'valid',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    })
    expect(later.status).toBe(404)
  })
})

describe('persistent appointment editing', () => {
  const EDIT_BODY = Object.freeze({
    expectedVersion: 1, specialistId: BODY.specialistId, serviceId: BODY.serviceId,
    date: BODY.date, time: BODY.time, durationMinutes: BODY.durationMinutes,
    expectedAmountGrosze: BODY.expectedAmountGrosze, location: BODY.location,
    status: BODY.status,
  })
  const edit = async (appointment, overrides = {}) => {
    const marker = `appointment_edit_${++sequence}`
    return editAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(), nowMs: NOW_MS + 1_000,
      correlationId: CORRELATION_ID, idFactory: suffixes(marker), appointmentId: appointment.id,
      body: { ...EDIT_BODY, expectedVersion: appointment.version },
      idempotencyKey: `${marker}-key`, ...overrides,
    })
  }
  const seedCollectedPayment = async (appointment, amountGrosze = 5_000) => {
    const clientRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(appointment.clientId).first()
    const scope = clientKeyScope(appointment.clientId)
    const dataKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(clientRow.identity_envelope), expectedScope: scope,
    })
    const changedAt = new Date(NOW_MS + 500).toISOString()
    const receivedAt = new Date(NOW_MS + 200).toISOString()
    const paymentId = `pay_edit_fixture_${++sequence}`
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO payment_entries
        (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
         external_reference_envelope,created_at) VALUES (?,?,?,?,?,?,NULL,?)`).bind(
        paymentId, appointment.id, amountGrosze, 'card', receivedAt, OWNER.id, receivedAt,
      ),
      env.DB.prepare('UPDATE appointments SET version=2,updated_at=? WHERE id=? AND version=1')
        .bind(changedAt, appointment.id),
    ])
    const snapshot = {
      cancelledAt: null,
      clientId: appointment.clientId,
      createdAt: appointment.createdAt,
      endsAt: appointment.endsAt,
      id: appointment.id,
      location: appointment.location,
      paymentAggregate: {
        collectedGrosze: amountGrosze,
        outstandingGrosze: appointment.charge.expectedAmountGrosze - amountGrosze,
        status: amountGrosze === appointment.charge.expectedAmountGrosze ? 'paid' : 'partial',
      },
      schema: 'appointment.v1',
      serviceId: appointment.serviceId,
      source: appointment.source,
      specialistId: appointment.specialistId,
      startsAt: appointment.startsAt,
      status: 'completed',
      timeZone: appointment.timeZone,
      updatedAt: changedAt,
      version: 2,
    }
    const envelope = await encryptForScope(await ring(), dataKey, {
      expectedScope: scope, recordId: appointment.id, field: 'record_version',
      plaintext: JSON.stringify(snapshot),
    })
    await env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      `ver_edit_payment_${sequence}`, 'appointment', appointment.id, 2,
      JSON.stringify(envelope), OWNER.id, changedAt, CORRELATION_ID,
    ).run()
    return Object.freeze({ ...appointment, version: 2, updatedAt: changedAt,
      payment: { status: snapshot.paymentAggregate.status, collectedGrosze: amountGrosze,
        outstandingGrosze: snapshot.paymentAggregate.outstandingGrosze,
        latestMethod: 'card', latestReceivedAt: receivedAt },
      paymentEntries: [{ id: paymentId, amountGrosze, method: 'card', receivedAt,
        correctedAt: null, replacementEntryId: null }] })
  }

  const seedPaymentHistory = async (appointment, count) => {
    const clientRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(appointment.clientId).first()
    const scope = clientKeyScope(appointment.clientId)
    const dataKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(clientRow.identity_envelope), expectedScope: scope,
    })
    const changedAt = new Date(NOW_MS + 500).toISOString()
    const receivedAt = new Date(NOW_MS + 200).toISOString()
    const marker = `edit_history_${++sequence}`
    const entries = Array.from({ length: count }, (_, index) => ({
      id: `pay_${marker}_${String(index).padStart(4, '0')}`,
      amountGrosze: 1, method: 'card', receivedAt,
      correctedAt: null, replacementEntryId: null,
    }))
    for (let offset = 0; offset < entries.length; offset += 100) {
      await env.DB.batch(entries.slice(offset, offset + 100).map((entry) => (
        env.DB.prepare(`INSERT INTO payment_entries
          (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
           external_reference_envelope,created_at) VALUES (?,?,?,?,?,?,NULL,?)`).bind(
          entry.id, appointment.id, entry.amountGrosze, entry.method, entry.receivedAt,
          OWNER.id, entry.receivedAt,
        )
      )))
    }
    await env.DB.prepare('UPDATE appointments SET version=2,updated_at=? WHERE id=? AND version=1')
      .bind(changedAt, appointment.id).run()
    const snapshot = {
      cancelledAt: null, clientId: appointment.clientId, createdAt: appointment.createdAt,
      endsAt: appointment.endsAt, id: appointment.id, location: appointment.location,
      paymentAggregate: {
        collectedGrosze: count,
        outstandingGrosze: appointment.charge.expectedAmountGrosze - count,
        status: 'partial',
      },
      schema: 'appointment.v1', serviceId: appointment.serviceId, source: appointment.source,
      specialistId: appointment.specialistId, startsAt: appointment.startsAt,
      status: 'completed', timeZone: appointment.timeZone, updatedAt: changedAt, version: 2,
    }
    const envelope = await encryptForScope(await ring(), dataKey, {
      expectedScope: scope, recordId: appointment.id, field: 'record_version',
      plaintext: JSON.stringify(snapshot),
    })
    await env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      `ver_${marker}`, 'appointment', appointment.id, 2, JSON.stringify(envelope),
      OWNER.id, changedAt, CORRELATION_ID,
    ).run()
    return Object.freeze({ ...appointment, version: 2, status: 'completed', updatedAt: changedAt,
      payment: { status: 'partial', collectedGrosze: count,
        outstandingGrosze: appointment.charge.expectedAmountGrosze - count,
        latestMethod: 'card', latestReceivedAt: receivedAt },
      paymentEntries: entries })
  }

  const canonicalJson = (value) => JSON.stringify(value === null
    || typeof value !== 'object' ? value
    : Array.isArray(value) ? value.map((entry) => JSON.parse(canonicalJson(entry)))
      : Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, JSON.parse(canonicalJson(value[key]))])))

  const withEncryptedEditReplay = async (clientId, idempotencyKey, response) => {
    const clientRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(clientId).first()
    const scope = clientKeyScope(clientId)
    const dataKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(clientRow.identity_envelope), expectedScope: scope,
    })
    const tuple = new TextEncoder().encode(
      ['bwm:idempotency:record:v1', OWNER.id, 'appointments.edit', idempotencyKey].join('\n'),
    )
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', tuple))
    const recordId = `idem_${encodeBase64Url(digest)}`
    tuple.fill(0)
    digest.fill(0)
    const responseEnvelope = JSON.stringify(await encryptForScope(await ring(), dataKey, {
      expectedScope: scope, recordId, field: 'idempotency_response',
      plaintext: canonicalJson(response),
    }))
    return { prepare(sql) {
      const prepared = env.DB.prepare(sql)
      if (!sql.includes('SELECT request_hash,resource_type,resource_id,response_envelope')) {
        return prepared
      }
      return { bind(...bindings) {
        const bound = prepared.bind(...bindings)
        return { async first() {
          const row = await bound.first()
          return row === null ? null : { ...row, response_envelope: responseEnvelope }
        } }
      } }
    }, batch: (statements) => env.DB.batch(statements) }
  }

  it('strictly captures the edit target/body and freezes the payment transition boundary', async () => {
    expect(validateEditAppointmentBody(EDIT_BODY)).toEqual({
      ...EDIT_BODY, startsAt: '2027-01-16T09:00:00.000Z',
      endsAt: '2027-01-16T09:50:00.000Z', timeZone: 'Europe/Warsaw',
    })
    expect(() => validateEditAppointmentBody({ ...EDIT_BODY, expectedVersion: 0 }))
      .toThrow('VALIDATION_FAILED/expectedVersion')
    await expect(digestEditAppointmentRequest('apt_edit_target', EDIT_BODY))
      .resolves.toMatch(/^[A-Za-z0-9_-]{43}$/)
    await expect(digestEditAppointmentRequest('apt_bad/id', EDIT_BODY))
      .rejects.toThrow('VALIDATION_FAILED/appointmentId')
    for (const [status, amount, collected, allowed] of [
      ['scheduled', 19_500, 0, true],
      ['scheduled', 19_500, 1, false],
      ['completed', 19_500, 1, true],
      ['noshow', 19_500, 1, true],
      ['completed', 19_499, 1, false],
      ['completed', 19_500, 19_500, true],
      ['completed', 20_000, 20_001, false],
    ]) {
      const invoke = () => assertAppointmentPaymentTransition({
        currentStatus: 'completed', currentAmountGrosze: 19_500,
        proposedStatus: status, proposedAmountGrosze: amount,
        collectedGrosze: collected,
      })
      if (allowed) expect(invoke()).toBeUndefined()
      else expect(invoke).toThrow('APPOINTMENT_PAYMENT_CONFLICT')
    }
  })

  it('atomically edits mutable appointment fields without advancing an unchanged charge', async () => {
    const client = await seedClient()
    const created = await create(client, { body: { ...BODY, clientId: client.id,
      date: '2027-04-01', status: 'completed' } })
    const current = created.body.data.appointment
    const result = await edit(current, { body: {
      ...EDIT_BODY, expectedVersion: 1, date: '2027-04-01', time: '11:00',
      location: 'Gabinet 3', status: 'noshow',
    } })
    expect(result).toEqual({ status: 200, body: { data: { appointment: {
      ...current, startsAt: '2027-04-01T09:00:00.000Z', endsAt: '2027-04-01T09:50:00.000Z',
      location: 'Gabinet 3', status: 'noshow', version: 2,
      updatedAt: new Date(NOW_MS + 1_000).toISOString(),
      payment: { ...current.payment, outstandingGrosze: 19_500 },
    } } } })
    expect(result.body.data.appointment.charge.version).toBe(1)
    expect((await env.DB.prepare('SELECT version FROM appointments WHERE id=?')
      .bind(current.id).first()).version).toBe(2)
    expect((await env.DB.prepare('SELECT version FROM session_charges WHERE id=?')
      .bind(current.charge.id).first()).version).toBe(1)
  })

  it('advances the charge exactly once only when service or amount changes', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: { ...BODY, clientId: client.id,
      date: '2027-04-02' } })).body.data.appointment
    const result = await edit(current, { body: {
      ...EDIT_BODY, expectedVersion: 1, date: '2027-04-02',
      serviceId: 'konsultacja', durationMinutes: 90, expectedAmountGrosze: 25_000,
      status: 'completed',
    } })
    expect(result.body.data.appointment).toMatchObject({
      id: current.id, clientId: current.clientId, source: current.source,
      createdAt: current.createdAt, version: 2, serviceId: 'konsultacja',
      status: 'completed', charge: { id: current.charge.id, serviceId: 'konsultacja',
        expectedAmountGrosze: 25_000, version: 2 },
    })
    expect((await env.DB.prepare(`SELECT entity_type,version FROM record_versions
      WHERE entity_id IN (?,?) ORDER BY entity_type,version`).bind(current.id, current.charge.id).all()).results)
      .toEqual([
        { entity_type: 'appointment', version: 1 },
        { entity_type: 'appointment', version: 2 },
        { entity_type: 'session_charge', version: 1 },
        { entity_type: 'session_charge', version: 2 },
      ])
  })

  it('orders authenticated scope before stale and stale before no-op without generating IDs', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: { ...BODY, clientId: client.id,
      date: '2027-04-03' } })).body.data.appointment
    const staleIds = vi.fn()
    await expect(edit(current, { idFactory: staleIds, body: {
      ...EDIT_BODY, expectedVersion: 2, date: '2027-04-03',
    } })).rejects.toMatchObject({ message: 'VERSION_CONFLICT', details: { currentVersion: 1 } })
    expect(staleIds).not.toHaveBeenCalled()
    const noOpIds = vi.fn()
    await expect(edit(current, { idFactory: noOpIds, body: {
      ...EDIT_BODY, expectedVersion: 1, date: '2027-04-03',
    } })).rejects.toThrow('VALIDATION_FAILED/body')
    expect(noOpIds).not.toHaveBeenCalled()
    await expect(edit({ ...current, id: 'apt_guessed_target' }, { idFactory: vi.fn(), body: {
      ...EDIT_BODY, expectedVersion: 999, date: '2027-04-03',
    } })).rejects.toThrow('NOT_FOUND')
  })

  it('excludes self from overlap, blocks another visit, and replays before facts and IDs', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: { ...BODY, clientId: client.id,
      date: '2027-04-04' } })).body.data.appointment
    const first = await edit(current, { body: {
      ...EDIT_BODY, expectedVersion: 1, date: '2027-04-04', time: '10:10',
    } })
    const replayFactory = vi.fn(() => { throw new Error('must not generate') })
    expect(await editAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 99_000, correlationId: CORRELATION_ID,
      idFactory: replayFactory, appointmentId: current.id,
      body: { ...EDIT_BODY, expectedVersion: 1, date: '2027-04-04', time: '10:10' },
      idempotencyKey: `appointment_edit_${sequence}-key`,
    })).toEqual(first)
    expect(replayFactory).not.toHaveBeenCalled()

    const otherClient = await seedClient()
    const other = (await create(otherClient, { body: { ...BODY, clientId: otherClient.id,
      date: '2027-04-05', time: '12:00' } })).body.data.appointment
    await create(client, { body: { ...BODY, clientId: client.id,
      date: '2027-04-05', time: '13:00' } })
    await expect(edit(other, { body: {
      ...EDIT_BODY, expectedVersion: 1, date: '2027-04-05', time: '13:10',
    } })).rejects.toThrow('APPOINTMENT_OVERLAP')
  })

  it('keeps the edit route adapter exact and maps only frozen safe fields', async () => {
    const service = vi.fn(async () => ({ status: 200, body: { data: { appointment: {} } } }))
    const input = {
      db: {}, recoveryDb: {}, actor: OWNER, keyring: {}, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: vi.fn(), appointmentId: 'apt_adapter_target',
      body: EDIT_BODY, idempotencyKey: 'appointment-edit-adapter-key', edit: service,
    }
    expect((await postAppointmentEdit(input)).status).toBe(200)
    expect(service).toHaveBeenCalledWith(expect.objectContaining({
      appointmentId: 'apt_adapter_target', body: EDIT_BODY,
    }))
    await expect(postAppointmentEdit({ ...input, appointmentId: 'apt_bad/id' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: undefined })
    await expect(postAppointmentEdit({ ...input, body: { ...EDIT_BODY, status: 'cancelled' } }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'status' } })
  })

  it('rolls back every statement in both edit UOW shapes and stays within exact budgets', async () => {
    for (const [shape, statementCount] of [['unchanged', 5], ['changed', 7]]) {
      for (let failedAt = 0; failedAt < statementCount; failedAt += 1) {
        const client = await seedClient()
        const current = (await create(client, { body: { ...BODY, clientId: client.id,
          date: `2027-05-${String(1 + failedAt + (shape === 'changed' ? 10 : 0)).padStart(2, '0')}`,
        } })).body.data.appointment
        const before = await ledgerSnapshot()
        const db = {
          prepare: (sql) => env.DB.prepare(sql),
          batch: (statements) => env.DB.batch(statements.map((statement, index) => index === failedAt
            ? env.DB.prepare("INSERT INTO core_directory_invariant_failures (failure_kind) VALUES ('forced')")
            : statement)),
        }
        const body = shape === 'changed'
          ? { ...EDIT_BODY, expectedVersion: 1, date: `2027-05-${String(11 + failedAt).padStart(2, '0')}`,
              serviceId: 'konsultacja', durationMinutes: 90, expectedAmountGrosze: 25_000 }
          : { ...EDIT_BODY, expectedVersion: 1,
              date: `2027-05-${String(1 + failedAt).padStart(2, '0')}`, time: '11:00' }
        await expect(edit(current, { db, body,
          idempotencyKey: `appointment-edit-rollback-${shape}-${sequence}-${failedAt}` }))
          .rejects.toThrow()
        expect(await ledgerSnapshot()).toEqual(before)
      }
    }

    for (const [shape, expectedUsed] of [['unchanged', 14], ['changed', 16]]) {
      const client = await seedClient()
      const date = shape === 'changed' ? '2027-06-02' : '2027-06-01'
      const current = (await create(client, { body: { ...BODY, clientId: client.id, date } }))
        .body.data.appointment
      const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
      const body = shape === 'changed'
        ? { ...EDIT_BODY, expectedVersion: 1, date,
            serviceId: 'konsultacja', durationMinutes: 90, expectedAmountGrosze: 25_000 }
        : { ...EDIT_BODY, expectedVersion: 1, date, time: '11:00' }
      await edit(current, { db: budget.work, recoveryDb: budget.recovery, body })
      expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
        used: expectedUsed, remaining: 50 - expectedUsed, workRemaining: 42 - expectedUsed,
        totalLimit: 50, recoveryReserve: 8,
      })
    }
  })

  it('returns one canonical winner to same-key concurrent edits with two-read reserve recovery', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: { ...BODY, clientId: client.id,
      date: '2027-06-03' } })).body.data.appointment
    const keyring = await ring()
    const key = `appointment-edit-same-key-${sequence}`
    const body = { ...EDIT_BODY, expectedVersion: 1, date: '2027-06-03', time: '11:00' }
    const command = (marker) => editAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring, nowMs: NOW_MS + 1_000,
      correlationId: CORRELATION_ID, idFactory: suffixes(marker),
      appointmentId: current.id, body, idempotencyKey: key,
    })
    const [first, second] = await Promise.all([
      command(`appointment_edit_same_a_${++sequence}`),
      command(`appointment_edit_same_b_${++sequence}`),
    ])
    expect(second).toEqual(first)
    expect((await env.DB.prepare('SELECT version FROM appointments WHERE id=?')
      .bind(current.id).first()).version).toBe(2)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM audit_events
      WHERE entity_id=? AND action='appointment.updated'`).bind(current.id).first()).count).toBe(1)
  })

  it('preserves payment entries and enforces nonbillable and charge-reduction conflicts', async () => {
    const allowedClient = await seedClient()
    const allowedCreated = (await create(allowedClient, { body: {
      ...BODY, clientId: allowedClient.id, date: '2027-06-05', status: 'completed',
    } })).body.data.appointment
    const paid = await seedCollectedPayment(allowedCreated)
    const allowed = await edit(paid, { body: {
      ...EDIT_BODY, expectedVersion: 2, date: '2027-06-05', time: '11:00',
      status: 'noshow',
    } })
    expect(allowed.body.data.appointment).toMatchObject({
      version: 3, status: 'noshow', payment: { status: 'partial', collectedGrosze: 5_000,
        outstandingGrosze: 14_500, latestMethod: 'card' },
      paymentEntries: paid.paymentEntries,
    })

    for (const [index, body] of [
      { status: 'scheduled' },
      { status: 'completed', expectedAmountGrosze: 19_499 },
    ].entries()) {
      const client = await seedClient()
      const created = (await create(client, { body: {
        ...BODY, clientId: client.id, date: `2027-06-0${6 + index}`, status: 'completed',
      } })).body.data.appointment
      const current = await seedCollectedPayment(created)
      const idFactory = vi.fn()
      await expect(edit(current, { idFactory, body: {
        ...EDIT_BODY, expectedVersion: 2, date: `2027-06-0${6 + index}`, ...body,
      } })).rejects.toThrow('APPOINTMENT_PAYMENT_CONFLICT')
      expect(idFactory).not.toHaveBeenCalled()
    }
  })

  it.each([256, 257, 1_000])(
    'accepts a real D1 payment history with %i rows within the unchanged statement budget',
    async (count) => {
      const client = await seedClient()
      const created = (await create(client, { body: {
        ...BODY, clientId: client.id, date: `2027-08-${String(count % 20 + 1).padStart(2, '0')}`,
        status: 'completed',
      } })).body.data.appointment
      const current = await seedPaymentHistory(created, count)
      const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
      const result = await edit(current, { db: budget.work, recoveryDb: budget.recovery,
        body: { ...EDIT_BODY, expectedVersion: 2,
          date: `2027-08-${String(count % 20 + 1).padStart(2, '0')}`,
          location: 'Gabinet graniczny', status: 'completed' } })
      expect(result.body.data.appointment.paymentEntries).toHaveLength(count)
      expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
        used: 14, remaining: 36, workRemaining: 28,
        totalLimit: 50, recoveryReserve: 8,
      })
    },
  )

  it('rejects the 1001st real D1 payment row at the sentinel without spending IDs', async () => {
    const client = await seedClient()
    const created = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-08-04', status: 'completed',
    } })).body.data.appointment
    const current = await seedPaymentHistory(created, 1_001)
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const idFactory = vi.fn()
    await expect(edit(current, { db: budget.work, recoveryDb: budget.recovery, idFactory,
      body: { ...EDIT_BODY, expectedVersion: 2, date: '2027-08-04', status: 'completed' },
    })).rejects.toThrow('NOT_FOUND')
    expect(idFactory).not.toHaveBeenCalled()
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 6, remaining: 44, workRemaining: 36,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('descriptor-captures payment result arrays before indexed access', async () => {
    for (const hostile of ['accessor', 'proxy-get', 'proxy-descriptor']) {
      const client = await seedClient()
      const created = (await create(client, { body: {
        ...BODY, clientId: client.id, date: `2027-08-0${5 + ['accessor', 'proxy-get', 'proxy-descriptor'].indexOf(hostile)}`,
        status: 'completed',
      } })).body.data.appointment
      const current = await seedCollectedPayment(created)
      let indexed = false
      const db = { prepare(sql) {
        const prepared = env.DB.prepare(sql)
        if (!sql.trimStart().startsWith('SELECT payment.id')) return prepared
        return { bind(...bindings) {
          const bound = prepared.bind(...bindings)
          return { async all() {
            const result = await bound.all()
            if (hostile === 'accessor') {
              const rows = [...result.results]
              Object.defineProperty(rows, '0', { enumerable: true, configurable: true,
                get() { throw new Error('escaped payment accessor') } })
              return { ...result, results: rows }
            }
            const rows = new Proxy(result.results, hostile === 'proxy-get' ? {
              get(target, key, receiver) {
                if (key === '0') { indexed = true; throw new Error('escaped proxy get') }
                return Reflect.get(target, key, receiver)
              },
            } : {
              getOwnPropertyDescriptor() { throw new Error('escaped proxy descriptor') },
            })
            return { ...result, results: rows }
          } }
        } }
      }, batch: (statements) => env.DB.batch(statements) }
      const invocation = edit(current, { db, body: {
        ...EDIT_BODY, expectedVersion: 2,
        date: `2027-08-0${5 + ['accessor', 'proxy-get', 'proxy-descriptor'].indexOf(hostile)}`,
        location: 'Gabinet deskryptorów', status: 'completed',
      } })
      if (hostile === 'proxy-get') {
        await expect(invocation).resolves.toMatchObject({ status: 200 })
        expect(indexed).toBe(false)
      } else {
        await expect(invocation).rejects.toThrow('NOT_FOUND')
      }
    }
  })

  it('requires the exact rooted assignment effective at the proposed start for every role', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-01-15', time: '10:50', status: 'completed',
    } })).body.data.appointment
    await editClient({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 2 * 60 * 60 * 1000, correlationId: CORRELATION_ID,
      idFactory: suffixes(`appointment_edit_assignment_${++sequence}`), clientId: client.id,
      body: { expectedVersion: 1, name: client.name, age: 12,
        status: 'active', specialistId: 'sp_appointment_second' },
      idempotencyKey: `appointment-edit-assignment-${sequence}-key`,
    })
    const historical = await edit(current, { actor: {
      id: 'stf_appointment_target', role: 'specialist', specialistId: 'sp_appointment_target',
    }, body: {
      ...EDIT_BODY, expectedVersion: 1, date: '2027-01-15', time: '10:50',
      status: 'completed', location: 'Gabinet historyczny',
    } })
    expect(historical.body.data.appointment.specialistId).toBe('sp_appointment_target')

    const secondClient = await seedClient()
    const secondCurrent = (await create(secondClient, { body: {
      ...BODY, clientId: secondClient.id, date: '2027-07-11',
    } })).body.data.appointment
    const idFactory = vi.fn()
    await expect(edit(secondCurrent, { idFactory, body: {
      ...EDIT_BODY, expectedVersion: 1, specialistId: 'sp_appointment_second',
      date: '2027-07-11',
    } })).rejects.toThrow('NOT_FOUND')
    expect(idFactory).not.toHaveBeenCalled()
  })

  it('authenticates complete appointment/charge histories and stores exact audit metadata', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-07-12',
    } })).body.data.appointment
    const result = await edit(current, { body: {
      ...EDIT_BODY, expectedVersion: 1, date: '2027-07-12',
      serviceId: 'konsultacja', durationMinutes: 90, expectedAmountGrosze: 25_000,
    } })
    const appointment = result.body.data.appointment
    expect(await env.DB.prepare(`SELECT action,entity_type,entity_id,reason_envelope,metadata_json
      FROM audit_events WHERE entity_id=? AND action='appointment.updated'`).bind(current.id).first())
      .toEqual({ action: 'appointment.updated', entity_type: 'appointment',
        entity_id: current.id, reason_envelope: null,
        metadata_json: JSON.stringify({ appointmentVersion: 2, chargeVersion: 2 }) })
    const clientRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(client.id).first()
    const scope = clientKeyScope(client.id)
    const dataKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(clientRow.identity_envelope), expectedScope: scope,
    })
    for (const [entityId, schema] of [[current.id, 'appointment.v1'], [current.charge.id, 'session_charge.v1']]) {
      const row = await env.DB.prepare(`SELECT snapshot_envelope FROM record_versions
        WHERE entity_id=? ORDER BY version DESC LIMIT 1`).bind(entityId).first()
      const plaintext = await decryptForScope(await ring(), dataKey, {
        expectedScope: scope, recordId: entityId, field: 'record_version',
        envelope: JSON.parse(row.snapshot_envelope),
      })
      expect(JSON.parse(plaintext)).toMatchObject({ schema, version: 2 })
    }
    expect(appointment.charge.version).toBe(2)

    await env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      `ver_edit_cross_type_${++sequence}`, 'client', current.id, 99, '{}', OWNER.id,
      new Date(NOW_MS + 2_000).toISOString(), CORRELATION_ID,
    ).run()
    const idFactory = vi.fn()
    await expect(edit(appointment, { idFactory, body: {
      ...EDIT_BODY, expectedVersion: 2, date: '2027-07-12', time: '11:00',
      serviceId: 'konsultacja', durationMinutes: 90, expectedAmountGrosze: 25_000,
    } })).rejects.toThrow('NOT_FOUND')
    expect(idFactory).not.toHaveBeenCalled()
  })

  it('recovers a winner committed between replay and UOW with exactly two reserve reads', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-07-13',
    } })).body.data.appointment
    const body = { ...EDIT_BODY, expectedVersion: 1, date: '2027-07-13', time: '11:00' }
    const key = `appointment-edit-injected-winner-${sequence}`
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    let recoveryReads = 0
    const recoveryDb = { prepare(sql) {
      recoveryReads += 1
      return budget.recovery.prepare(sql)
    } }
    let injected = false
    let winner
    const db = {
      prepare(sql) {
        const prepared = budget.work.prepare(sql)
        if (injected || !sql.includes('id!=? AND status')) return prepared
        return { bind(...bindings) {
          const bound = prepared.bind(...bindings)
          return { async first() {
            injected = true
            winner = await editAppointment({
              db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
              nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
              idFactory: suffixes(`appointment_edit_injected_${++sequence}`),
              appointmentId: current.id, body, idempotencyKey: key,
            })
            return bound.first()
          } }
        } }
      },
      batch: (statements) => budget.work.batch(statements),
    }
    const loser = await editAppointment({
      db, recoveryDb, actor: OWNER, keyring: await ring(), nowMs: NOW_MS + 1_000,
      correlationId: CORRELATION_ID,
      idFactory: suffixes(`appointment_edit_loser_${++sequence}`),
      appointmentId: current.id, body, idempotencyKey: key,
    })
    expect(loser).toEqual(winner)
    expect(recoveryReads).toBe(2)
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 17, remaining: 33, workRemaining: 25,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('keeps edit replay client-scoped across retired, conflicting, and unavailable keys', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-07-19',
    } })).body.data.appointment
    const body = { ...EDIT_BODY, expectedVersion: 1, date: '2027-07-19', time: '11:00' }
    const key = `appointment-edit-replay-key-${sequence}`
    const result = await editAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: suffixes(`appointment_edit_replay_${++sequence}`),
      appointmentId: current.id, body, idempotencyKey: key,
    })
    const row = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(client.id).first()
    await env.DB.prepare('UPDATE data_keys SET retired_at=? WHERE id=?').bind(
      new Date(NOW_MS + 2_000).toISOString(), JSON.parse(row.identity_envelope).dataKeyId,
    ).run()
    expect(await editAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 3_000, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      appointmentId: current.id, body, idempotencyKey: key,
    })).toEqual(result)
    await expect(editAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 3_000, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      appointmentId: current.id, body: { ...body, location: 'Inny gabinet' },
      idempotencyKey: key,
    })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    await expect(editAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: {},
      nowMs: NOW_MS + 3_000, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      appointmentId: current.id, body, idempotencyKey: key,
    })).rejects.toThrow('CRYPTO_FAILURE')
  })

  it('authenticates the complete frozen payment-correction graph on encrypted edit replay', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-08-09', status: 'completed',
    } })).body.data.appointment
    const body = { ...EDIT_BODY, expectedVersion: 1, date: '2027-08-09', time: '11:00',
      status: 'completed' }
    const key = `appointment-edit-hostile-replay-${++sequence}`
    const result = await editAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: suffixes(`appointment_edit_hostile_${sequence}`),
      appointmentId: current.id, body, idempotencyKey: key,
    })
    const valid = JSON.parse(JSON.stringify(result))
    const appointment = valid.body.data.appointment
    const correctedAt = new Date(NOW_MS + 500).toISOString()
    const receivedAt = new Date(NOW_MS + 200).toISOString()
    appointment.paymentEntries = [
      { id: 'pay_A-replay', amountGrosze: 50, method: 'cash', receivedAt,
        correctedAt, replacementEntryId: 'pay_A_replay' },
      { id: 'pay_A_replay', amountGrosze: 100, method: 'card', receivedAt,
        correctedAt, replacementEntryId: 'pay_a-replay' },
      { id: 'pay_a-replay', amountGrosze: 150, method: 'card', receivedAt,
        correctedAt: null, replacementEntryId: null },
      { id: 'pay_a_replay', amountGrosze: 200, method: 'transfer', receivedAt,
        correctedAt: null, replacementEntryId: null },
    ]
    appointment.payment = { status: 'partial', collectedGrosze: 350,
      outstandingGrosze: 19_150, latestMethod: 'transfer', latestReceivedAt: receivedAt }
    expect(appointment.paymentEntries[1].correctedAt)
      .toBe(appointment.paymentEntries[0].correctedAt)

    const validDb = await withEncryptedEditReplay(client.id, key, valid)
    await expect(editAppointment({
      db: validDb, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 2_000, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      appointmentId: current.id, body, idempotencyKey: key,
    })).resolves.toEqual(valid)

    const hostileCases = {
      'correctedAt/replacement coherence': (candidate) => {
        candidate.body.data.appointment.paymentEntries[3].replacementEntryId = 'pay_A-replay'
      },
      'unique replacement targets': (candidate) => {
        candidate.body.data.appointment.paymentEntries[0].replacementEntryId = 'pay_a-replay'
      },
      'correction chronology': (candidate) => {
        candidate.body.data.appointment.paymentEntries[0].correctedAt = '2027-01-15T08:59:59.999Z'
      },
      'reverse-time acyclic correction chain': (candidate) => {
        candidate.body.data.appointment.paymentEntries[0].correctedAt =
          new Date(NOW_MS + 700).toISOString()
        candidate.body.data.appointment.paymentEntries[1].correctedAt =
          new Date(NOW_MS + 500).toISOString()
      },
      'self replacement': (candidate) => {
        candidate.body.data.appointment.paymentEntries[0].replacementEntryId = 'pay_A-replay'
      },
      'replacement cycle': (candidate) => {
        candidate.body.data.appointment.paymentEntries[1].replacementEntryId = 'pay_A-replay'
      },
      'exact aggregate': (candidate) => {
        candidate.body.data.appointment.payment.collectedGrosze += 1
        candidate.body.data.appointment.payment.outstandingGrosze -= 1
      },
      'canonical order': (candidate) => {
        const entries = candidate.body.data.appointment.paymentEntries
        ;[entries[0], entries[1]] = [entries[1], entries[0]]
      },
    }
    for (const [name, mutate] of Object.entries(hostileCases)) {
      const hostile = JSON.parse(JSON.stringify(valid))
      mutate(hostile)
      const db = await withEncryptedEditReplay(client.id, key, hostile)
      await expect(editAppointment({
        db, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
        nowMs: NOW_MS + 2_000, correlationId: CORRELATION_ID, idFactory: vi.fn(),
        appointmentId: current.id, body, idempotencyKey: key,
      }), name).rejects.toThrow('CRYPTO_FAILURE')
    }
  })

  it('classifies an overlap introduced at the final guard and leaves no edit residue', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: { ...BODY, clientId: client.id,
      date: '2027-06-04' } })).body.data.appointment
    const before = await ledgerSnapshot()
    let raced = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!raced) {
          raced = true
          await env.DB.prepare(`INSERT INTO appointments
            (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
             status,source,version,cancelled_at,created_at,updated_at)
            VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'scheduled','panel',1,NULL,?,?)`
          ).bind('apt_edit_race_blocker', client.id, BODY.specialistId,
            '2027-06-04T09:30:00.000Z', '2027-06-04T10:20:00.000Z',
            new Date(NOW_MS).toISOString(), new Date(NOW_MS).toISOString()).run()
        }
        return env.DB.batch(statements)
      },
    }
    await expect(edit(current, { db, body: {
      ...EDIT_BODY, expectedVersion: 1, date: '2027-06-04', time: '11:00',
    } })).rejects.toThrow('APPOINTMENT_OVERLAP')
    const after = await ledgerSnapshot()
    expect(after.appointments.find(({ id }) => id === 'apt_edit_race_blocker'))
      .toEqual(expect.objectContaining({ id: 'apt_edit_race_blocker' }))
    expect(after.appointments.filter(({ id }) => id !== 'apt_edit_race_blocker'))
      .toEqual(before.appointments)
    for (const table of Object.keys(before).filter((key) => key !== 'appointments')) {
      expect(after[table]).toEqual(before[table])
    }
  })

  it('classifies a valid assignment race as opaque not-found without edit residue', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-07-15',
    } })).body.data.appointment
    let raced = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!raced) {
          raced = true
          await editClient({
            db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
            nowMs: Date.parse('2027-07-16T09:00:00.000Z'), correlationId: CORRELATION_ID,
            idFactory: suffixes(`appointment_edit_assignment_race_${++sequence}`),
            clientId: client.id,
            body: { expectedVersion: 1, name: client.name, age: 12,
              status: 'active', specialistId: 'sp_appointment_second' },
            idempotencyKey: `appointment-edit-assignment-race-${sequence}-key`,
          })
        }
        return env.DB.batch(statements)
      },
    }
    await expect(edit(current, { db, body: {
      ...EDIT_BODY, expectedVersion: 1, date: '2027-07-17',
    } })).rejects.toThrow('NOT_FOUND')
    expect(await env.DB.prepare('SELECT version,starts_at FROM appointments WHERE id=?')
      .bind(current.id).first()).toEqual({ version: 1, starts_at: current.startsAt })
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM audit_events
      WHERE entity_id=? AND action='appointment.updated'`).bind(current.id).first())
      .toEqual({ count: 0 })
  })

  it('preserves the invariant failure when an assignment branch races with overlap', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-07-18',
    } })).body.data.appointment
    const clientRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(client.id).first()
    const dataKeyId = JSON.parse(clientRow.identity_envelope).dataKeyId
    const marker = `edit_branch_${++sequence}`
    let raced = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!raced) {
          raced = true
          const now = new Date(NOW_MS).toISOString()
          for (const [suffix, startsAt] of [
            ['a', new Date(NOW_MS - 4 * 60 * 60 * 1000).toISOString()],
            ['b', new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString()],
          ]) {
            const assignmentId = `asg_${marker}_${suffix}`
            await env.DB.prepare(`INSERT INTO client_assignments
              (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
               version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
              assignmentId, client.id, BODY.specialistId, startsAt, now,
              OWNER.id, 2, startsAt, now,
            ).run()
            for (const version of [1, 2]) {
              await env.DB.prepare(`INSERT INTO record_versions
                (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
                 changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
                `ver_${marker}_${suffix}_${version}`, 'client_assignment', assignmentId,
                version, JSON.stringify({ dataKeyId, dataKeyVersion: 1 }), OWNER.id,
                version === 1 ? startsAt : now, CORRELATION_ID,
              ).run()
            }
          }
          await env.DB.prepare(`INSERT INTO appointments
            (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
             status,source,version,cancelled_at,created_at,updated_at)
            VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'scheduled','panel',1,NULL,?,?)`
          ).bind(`apt_${marker}_blocker`, client.id, BODY.specialistId,
            '2027-07-18T08:30:00.000Z', '2027-07-18T09:20:00.000Z', now, now).run()
        }
        return env.DB.batch(statements)
      },
    }
    let failure
    try {
      await edit(current, { db, body: {
        ...EDIT_BODY, expectedVersion: 1, date: '2027-07-18', time: '11:00',
      } })
    } catch (error) { failure = error }
    expect(failure?.message).toMatch(/core_directory_invariant_failed/)
    expect(failure?.message).not.toBe('APPOINTMENT_OVERLAP')
    expect((await env.DB.prepare('SELECT version FROM appointments WHERE id=?')
      .bind(current.id).first()).version).toBe(1)
  })
})

describe('persistent appointment cancellation', () => {
  const CANCEL_BODY = Object.freeze({ expectedVersion: 1 })
  const cancel = async (appointment, overrides = {}) => {
    const marker = `appointment_cancel_${++sequence}`
    return cancelAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: suffixes(marker), appointmentId: appointment.id,
      body: { expectedVersion: appointment.version },
      idempotencyKey: `${marker}-key`, ...overrides,
    })
  }
  const seedCollectedPaymentForCancellation = async (appointment, { corrected = false } = {}) => {
    const clientRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(appointment.clientId).first()
    const scope = clientKeyScope(appointment.clientId)
    const dataKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(clientRow.identity_envelope), expectedScope: scope,
    })
    const paymentId = `pay_cancel_fixture_${++sequence}`
    const instant = appointment.updatedAt
    const statements = [env.DB.prepare(`INSERT INTO payment_entries
      (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
       external_reference_envelope,created_at) VALUES (?,?,?,?,?,?,NULL,?)`).bind(
      paymentId, appointment.id, 5_000, 'card', instant, OWNER.id, instant,
    )]
    if (corrected) {
      const correctionId = `cor_cancel_fixture_${sequence}`
      const reason = await encryptForScope(await ring(), dataKey, {
        expectedScope: scope, recordId: correctionId, field: 'reason',
        plaintext: 'Fikcyjna korekta testowa',
      })
      statements.push(env.DB.prepare(`INSERT INTO payment_corrections
        (id,reversed_entry_id,replacement_entry_id,reason_envelope,
         recorded_by_staff_id,created_at) VALUES (?,?,NULL,?,?,?)`).bind(
        correctionId, paymentId, JSON.stringify(reason), OWNER.id, instant,
      ))
    } else {
      const changedAt = new Date(NOW_MS + 500).toISOString()
      await env.DB.prepare('UPDATE appointments SET version=2,updated_at=? WHERE id=?')
        .bind(changedAt, appointment.id).run()
      const snapshot = {
        cancelledAt: null, clientId: appointment.clientId, createdAt: appointment.createdAt,
        endsAt: appointment.endsAt, id: appointment.id, location: appointment.location,
        paymentAggregate: { collectedGrosze: 5_000,
          outstandingGrosze: ['completed', 'noshow'].includes(appointment.status)
            ? appointment.charge.expectedAmountGrosze - 5_000 : 0,
          status: 'partial' },
        schema: 'appointment.v1', serviceId: appointment.serviceId, source: appointment.source,
        specialistId: appointment.specialistId, startsAt: appointment.startsAt,
        status: appointment.status, timeZone: appointment.timeZone,
        updatedAt: changedAt, version: 2,
      }
      const envelope = await encryptForScope(await ring(), dataKey, {
        expectedScope: scope, recordId: appointment.id, field: 'record_version',
        plaintext: JSON.stringify(snapshot),
      })
      statements.push(env.DB.prepare(`INSERT INTO record_versions
        (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
         changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
        `ver_cancel_payment_${sequence}`, 'appointment', appointment.id, 2,
        JSON.stringify(envelope), OWNER.id, changedAt, CORRELATION_ID,
      ))
    }
    await env.DB.batch(statements)
    return { paymentId, version: corrected ? appointment.version : 2 }
  }

  it('strictly captures the terminal target and exact one-field body', async () => {
    expect(validateCancelAppointmentBody(CANCEL_BODY)).toEqual(CANCEL_BODY)
    for (const body of [
      {}, { expectedVersion: 0 }, { expectedVersion: 1, extra: true },
    ]) expect(() => validateCancelAppointmentBody(body)).toThrow(/VALIDATION_FAILED/)
    const getter = vi.fn(() => 1)
    const hostile = {}
    Object.defineProperty(hostile, 'expectedVersion', { enumerable: true, get: getter })
    expect(() => validateCancelAppointmentBody(hostile)).toThrow('VALIDATION_FAILED/body')
    expect(getter).not.toHaveBeenCalled()
    await expect(digestCancelAppointmentRequest('apt_cancel_target', CANCEL_BODY))
      .resolves.toMatch(/^[A-Za-z0-9_-]{43}$/)
    await expect(digestCancelAppointmentRequest('apt_bad/id', CANCEL_BODY))
      .rejects.toThrow('VALIDATION_FAILED/appointmentId')
  })

  it.each(['scheduled', 'completed', 'noshow'])(
    'atomically cancels a %s appointment while preserving charge and identity',
    async (status) => {
      const client = await seedClient()
      const current = (await create(client, { body: {
        ...BODY, clientId: client.id, date: `2027-09-${status === 'scheduled' ? '01'
          : status === 'completed' ? '02' : '03'}`, status,
      } })).body.data.appointment
      const before = await ledgerSnapshot()
      const result = await cancel(current)
      const commandNow = new Date(NOW_MS + 1_000).toISOString()
      expect(result).toEqual({ status: 200, body: { data: { appointment: {
        ...current, status: 'cancelled', version: 2, cancelledAt: commandNow,
        updatedAt: commandNow, payment: { ...current.payment, outstandingGrosze: 0 },
      } } } })
      expect(result.body.data.appointment.charge).toEqual(current.charge)
      const row = await env.DB.prepare(`SELECT status,version,cancelled_at,updated_at
        FROM appointments WHERE id=?`).bind(current.id).first()
      expect(row).toEqual({ status: 'cancelled', version: 2,
        cancelled_at: commandNow, updated_at: commandNow })
      expect(await env.DB.prepare('SELECT * FROM session_charges WHERE id=?')
        .bind(current.charge.id).first()).toEqual(
        before.charges.find(({ id }) => id === current.charge.id),
      )
      expect((await env.DB.prepare(`SELECT action,metadata_json,reason_envelope
        FROM audit_events WHERE entity_id=? AND action='appointment.cancelled'`)
        .bind(current.id).first())).toEqual({
        action: 'appointment.cancelled', reason_envelope: null,
        metadata_json: JSON.stringify({ appointmentVersion: 2, chargeVersion: 1 }),
      })
    },
  )

  it('orders scope and terminal opacity before stale and spends no IDs on failures', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-09-04',
    } })).body.data.appointment
    const staleIds = vi.fn()
    await expect(cancel(current, { idFactory: staleIds, body: { expectedVersion: 2 } }))
      .rejects.toMatchObject({ message: 'VERSION_CONFLICT', details: { currentVersion: 1 } })
    expect(staleIds).not.toHaveBeenCalled()
    await cancel(current)
    const terminalIds = vi.fn()
    await expect(cancel(current, { idFactory: terminalIds,
      idempotencyKey: `appointment-cancel-terminal-${sequence}` }))
      .rejects.toThrow('NOT_FOUND')
    expect(terminalIds).not.toHaveBeenCalled()
    await expect(cancel({ ...current, id: 'apt_guessed_target' }, {
      idFactory: vi.fn(), body: { expectedVersion: 999 },
    })).rejects.toThrow('NOT_FOUND')
  })

  it('keeps the cancellation adapter exact and maps only frozen safe fields', async () => {
    const service = vi.fn(async () => ({ status: 200,
      body: { data: { appointment: { id: 'apt_cancel_adapter' } } } }))
    const input = {
      db: {}, recoveryDb: {}, actor: OWNER, keyring: {}, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: vi.fn(),
      appointmentId: 'apt_cancel_adapter', body: CANCEL_BODY,
      idempotencyKey: 'appointment-cancel-adapter-key', cancel: service,
    }
    expect((await postAppointmentCancellation(input)).status).toBe(200)
    expect(service).toHaveBeenCalledWith(expect.objectContaining({
      appointmentId: 'apt_cancel_adapter', body: CANCEL_BODY,
    }))
    await expect(postAppointmentCancellation({ ...input, appointmentId: 'apt_bad/id' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: undefined })
    await expect(postAppointmentCancellation({ ...input, body: { expectedVersion: 1, extra: 2 } }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'body' } })
  })

  it('rejects an effective payment but allows and retains a corrected net-zero history', async () => {
    const paidClient = await seedClient()
    const paid = (await create(paidClient, { body: {
      ...BODY, clientId: paidClient.id, date: '2027-09-05', status: 'completed',
    } })).body.data.appointment
    const paidFixture = await seedCollectedPaymentForCancellation(paid)
    const ids = vi.fn()
    await expect(cancel(paid, { idFactory: ids,
      body: { expectedVersion: paidFixture.version } }))
      .rejects.toThrow('APPOINTMENT_PAYMENT_CONFLICT')
    expect(ids).not.toHaveBeenCalled()

    const scheduledClient = await seedClient()
    const scheduled = (await create(scheduledClient, { body: {
      ...BODY, clientId: scheduledClient.id, date: '2027-09-12', status: 'scheduled',
    } })).body.data.appointment
    const scheduledFixture = await seedCollectedPaymentForCancellation(scheduled)
    await expect(cancel(scheduled, {
      body: { expectedVersion: scheduledFixture.version }, idFactory: vi.fn(),
    })).rejects.toThrow('APPOINTMENT_PAYMENT_CONFLICT')

    const correctedClient = await seedClient()
    const corrected = (await create(correctedClient, { body: {
      ...BODY, clientId: correctedClient.id, date: '2027-09-06', status: 'completed',
    } })).body.data.appointment
    const correctedFixture = await seedCollectedPaymentForCancellation(corrected, {
      corrected: true,
    })
    const result = await cancel(corrected)
    expect(result.body.data.appointment).toMatchObject({
      status: 'cancelled', version: 2,
      charge: corrected.charge,
      payment: { status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
        latestMethod: null, latestReceivedAt: null },
      paymentEntries: [{ id: correctedFixture.paymentId, amountGrosze: 5_000,
        method: 'card', receivedAt: corrected.updatedAt,
        correctedAt: corrected.updatedAt, replacementEntryId: null }],
    })
  })

  it('authorizes all active roles against the current appointment specialist only', async () => {
    for (const [index, actor] of [
      OWNER,
      { id: OWNER.id, role: 'coordinator', specialistId: null },
      { id: 'stf_appointment_target', role: 'specialist',
        specialistId: 'sp_appointment_target' },
    ].entries()) {
      const client = await seedClient()
      const appointment = (await create(client, { body: {
        ...BODY, clientId: client.id, date: `2027-09-${String(7 + index).padStart(2, '0')}`,
      } })).body.data.appointment
      await expect(cancel(appointment, { actor })).resolves.toMatchObject({ status: 200 })
    }
    const client = await seedClient()
    const appointment = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-09-10',
    } })).body.data.appointment
    const ids = vi.fn()
    await expect(cancel(appointment, { actor: {
      id: 'stf_appointment_second', role: 'specialist',
      specialistId: 'sp_appointment_second',
    }, idFactory: ids })).rejects.toThrow('NOT_FOUND')
    expect(ids).not.toHaveBeenCalled()
  })

  it('authenticates the one historical assignment effective at the appointment start', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-01-15', time: '14:00',
      status: 'completed',
    } })).body.data.appointment
    await editClient({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 8 * 60 * 60 * 1000, correlationId: CORRELATION_ID,
      idFactory: suffixes(`appointment_cancel_reassign_${++sequence}`),
      clientId: client.id,
      body: { expectedVersion: 1, name: client.name, age: 12,
        status: 'active', specialistId: 'sp_appointment_second' },
      idempotencyKey: `appointment-cancel-reassign-${sequence}-key`,
    })
    const result = await cancel(current, { nowMs: NOW_MS + 9 * 60 * 60 * 1000 })
    expect(result.body.data.appointment).toMatchObject({
      id: current.id, specialistId: 'sp_appointment_target', status: 'cancelled',
    })
  })

  it('rejects mismatched, gapped, and duplicate effective assignment facts opaquely', async () => {
    const fixtures = []
    for (let index = 0; index < 3; index += 1) {
      const client = await seedClient()
      const appointment = (await create(client, { body: {
        ...BODY, clientId: client.id, date: `2027-11-0${index + 1}`,
      } })).body.data.appointment
      fixtures.push({ client, appointment })
    }
    await env.DB.prepare(`UPDATE appointments SET specialist_id=?,version=2,updated_at=?
      WHERE id=? AND version=1`).bind(
      'sp_appointment_second', new Date(NOW_MS + 500).toISOString(),
      fixtures[0].appointment.id,
    ).run()
    await env.DB.prepare(`UPDATE client_assignments SET ends_at=?,version=2,updated_at=?
      WHERE client_id=? AND ends_at IS NULL`).bind(
      '2027-11-01T00:00:00.000Z', '2027-11-01T00:00:00.000Z', fixtures[1].client.id,
    ).run()
    const duplicateClientRow = await env.DB.prepare(
      'SELECT identity_envelope FROM clients WHERE id=?',
    ).bind(fixtures[2].client.id).first()
    const duplicateScope = clientKeyScope(fixtures[2].client.id)
    const duplicateKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(duplicateClientRow.identity_envelope),
      expectedScope: duplicateScope,
    })
    const duplicateId = `asg_cancel_duplicate_${++sequence}`
    const duplicateSnapshots = [1, 2].map((version) => ({
      assignedByStaffId: OWNER.id, clientId: fixtures[2].client.id,
      createdAt: fixtures[2].appointment.createdAt,
      endsAt: version === 1 ? null : fixtures[2].appointment.endsAt, id: duplicateId,
      schema: 'client_assignment.v1', specialistId: 'sp_appointment_target',
      startsAt: fixtures[2].appointment.createdAt,
      updatedAt: version === 1
        ? fixtures[2].appointment.createdAt : fixtures[2].appointment.endsAt,
      version,
    }))
    const duplicateRing = await ring()
    const duplicateEnvelopes = await Promise.all(duplicateSnapshots.map((snapshot) =>
      encryptForScope(duplicateRing, duplicateKey, {
        expectedScope: duplicateScope, recordId: duplicateId, field: 'record_version',
        plaintext: JSON.stringify(snapshot),
      })))
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO client_assignments
        (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
         version,created_at,updated_at) VALUES (?,?,?,?,?,?,2,?,?)`).bind(
        duplicateId, fixtures[2].client.id, 'sp_appointment_target',
        fixtures[2].appointment.createdAt, fixtures[2].appointment.endsAt, OWNER.id,
        fixtures[2].appointment.createdAt, fixtures[2].appointment.endsAt,
      ),
      ...duplicateEnvelopes.map((envelope, index) => env.DB.prepare(`INSERT INTO record_versions
        (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
         changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
        `ver_cancel_duplicate_${sequence}_${index + 1}`, 'client_assignment', duplicateId,
        index + 1, JSON.stringify(envelope), OWNER.id,
        duplicateSnapshots[index].updatedAt, CORRELATION_ID,
      )),
    ])
    for (const { appointment } of fixtures) {
      const ids = vi.fn()
      await expect(cancel(appointment, { idFactory: ids })).rejects.toThrow('NOT_FOUND')
      expect(ids).not.toHaveBeenCalled()
    }
  })

  it('replays before retained facts or IDs and releases its half-open interval', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-09-11',
    } })).body.data.appointment
    const key = `appointment-cancel-replay-${sequence}`
    const first = await cancel(current, { idempotencyKey: key })
    const replayIds = vi.fn(() => { throw new Error('must not generate') })
    expect(await cancelAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 99_000, correlationId: CORRELATION_ID,
      idFactory: replayIds, appointmentId: current.id,
      body: { expectedVersion: 1 }, idempotencyKey: key,
    })).toEqual(first)
    expect(replayIds).not.toHaveBeenCalled()

    const nextClient = await seedClient()
    await expect(create(nextClient, { body: {
      ...BODY, clientId: nextClient.id, date: '2027-09-11',
    } })).resolves.toMatchObject({ status: 201 })
  })

  it('rolls back all five statements byte-for-byte and stays inside exact budgets', async () => {
    for (let failedAt = 0; failedAt < 5; failedAt += 1) {
      const client = await seedClient()
      const current = (await create(client, { body: {
        ...BODY, clientId: client.id, date: `2027-10-0${failedAt + 1}`,
      } })).body.data.appointment
      const before = await ledgerSnapshot()
      const db = {
        prepare: (sql) => env.DB.prepare(sql),
        batch: (statements) => env.DB.batch(statements.map((statement, index) =>
          index === failedAt
            ? env.DB.prepare("INSERT INTO core_directory_invariant_failures (failure_kind) VALUES ('forced')")
            : statement)),
      }
      await expect(cancel(current, { db,
        idempotencyKey: `appointment-cancel-rollback-${sequence}-${failedAt}` }))
        .rejects.toThrow()
      expect(await ledgerSnapshot()).toEqual(before)
    }

    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-10-06',
    } })).body.data.appointment
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    await cancel(current, { db: budget.work, recoveryDb: budget.recovery })
    const usage = usageForD1QueryBudgetViews(budget.work, budget.recovery)
    expect(usage).toEqual({
      used: 13, remaining: 37, workRemaining: 29,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('returns one canonical winner to same-key concurrent cancellation', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-10-07',
    } })).body.data.appointment
    const key = `appointment-cancel-same-key-${sequence}`
    const keyring = await ring()
    const command = (marker) => cancelAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring,
      nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: suffixes(marker), appointmentId: current.id,
      body: { expectedVersion: 1 }, idempotencyKey: key,
    })
    const [first, second] = await Promise.all([
      command(`appointment_cancel_same_a_${++sequence}`),
      command(`appointment_cancel_same_b_${++sequence}`),
    ])
    expect(second).toEqual(first)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM audit_events
      WHERE entity_id=? AND action='appointment.cancelled'`).bind(current.id).first()).count)
      .toBe(1)
  })

  it('classifies a different-key concurrent terminal winner as opaque not-found', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-10-08',
    } })).body.data.appointment
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    let injected = false
    const db = {
      prepare: (sql) => budget.work.prepare(sql),
      async batch(statements) {
        if (!injected) {
          injected = true
          await cancelAppointment({
            db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
            nowMs: NOW_MS + 500, correlationId: CORRELATION_ID,
            idFactory: suffixes(`appointment_cancel_race_winner_${++sequence}`),
            appointmentId: current.id, body: { expectedVersion: 1 },
            idempotencyKey: `appointment-cancel-race-winner-${sequence}`,
          })
        }
        return budget.work.batch(statements)
      },
    }
    await expect(cancel(current, { db, nowMs: NOW_MS + 1_000,
      idempotencyKey: `appointment-cancel-race-loser-${sequence}` }))
      .rejects.toThrow('NOT_FOUND')
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM audit_events
      WHERE entity_id=? AND action='appointment.cancelled'`).bind(current.id).first()).count)
      .toBe(1)
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 22, remaining: 28, workRemaining: 20,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('recovers an injected same-key winner with exactly two reserve reads', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-10-09',
    } })).body.data.appointment
    const key = `appointment-cancel-injected-${sequence}`
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    let recoveryReads = 0
    const recoveryDb = { prepare(sql) {
      recoveryReads += 1
      return budget.recovery.prepare(sql)
    } }
    let injected = false
    let winner
    const db = {
      prepare: (sql) => budget.work.prepare(sql),
      async batch(statements) {
        if (!injected) {
          injected = true
          winner = await cancelAppointment({
            db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
            nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
            idFactory: suffixes(`appointment_cancel_injected_winner_${++sequence}`),
            appointmentId: current.id, body: { expectedVersion: 1 },
            idempotencyKey: key,
          })
        }
        return budget.work.batch(statements)
      },
    }
    const loser = await cancelAppointment({
      db, recoveryDb, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: suffixes(`appointment_cancel_injected_loser_${++sequence}`),
      appointmentId: current.id, body: { expectedVersion: 1 }, idempotencyKey: key,
    })
    expect(loser).toEqual(winner)
    expect(recoveryReads).toBe(2)
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 16, remaining: 34, workRemaining: 26,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('rolls back when an assignment gains a cross-type version after preflight', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-11-04',
    } })).body.data.appointment
    const assignment = await env.DB.prepare(
      'SELECT id FROM client_assignments WHERE client_id=? AND ends_at IS NULL',
    ).bind(client.id).first()
    let injected = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!injected) {
          injected = true
          await env.DB.prepare(`INSERT INTO record_versions
            (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
             changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
            `ver_cancel_cross_type_${++sequence}`, 'client', assignment.id, 99, '{}',
            OWNER.id, new Date(NOW_MS + 500).toISOString(), CORRELATION_ID,
          ).run()
        }
        return env.DB.batch(statements)
      },
    }
    await expect(cancel(current, { db })).rejects.toThrow(/core_directory_invariant_failed/)
    expect(await env.DB.prepare('SELECT status,version FROM appointments WHERE id=?')
      .bind(current.id).first()).toEqual({ status: 'scheduled', version: 1 })
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM audit_events
      WHERE entity_id=? AND action='appointment.cancelled'`).bind(current.id).first()).count)
      .toBe(0)
  })

  it('preserves invariant precedence when assignment corruption combines with a payment race', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-11-05', status: 'completed',
    } })).body.data.appointment
    const assignment = await env.DB.prepare(
      'SELECT id FROM client_assignments WHERE client_id=? AND ends_at IS NULL',
    ).bind(client.id).first()
    let injected = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!injected) {
          injected = true
          await seedCollectedPaymentForCancellation(current)
          await env.DB.prepare(`INSERT INTO record_versions
            (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
             changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
            `ver_cancel_combined_${++sequence}`, 'client', assignment.id, 99, '{}',
            OWNER.id, new Date(NOW_MS + 600).toISOString(), CORRELATION_ID,
          ).run()
        }
        return env.DB.batch(statements)
      },
    }
    let failure
    try { await cancel(current, { db }) } catch (error) { failure = error }
    expect(failure?.message).toMatch(/core_directory_invariant_failed/)
    expect(failure?.message).not.toBe('VERSION_CONFLICT')
    expect(failure?.message).not.toBe('APPOINTMENT_PAYMENT_CONFLICT')
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM audit_events
      WHERE entity_id=? AND action='appointment.cancelled'`).bind(current.id).first()).count)
      .toBe(0)
  })

  it('does not authenticate terminal corruption with an unrelated same-client cancellation key', async () => {
    const client = await seedClient()
    const target = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-11-06', time: '10:00',
    } })).body.data.appointment
    const unrelated = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-11-06', time: '12:00',
    } })).body.data.appointment
    await cancel(unrelated, { nowMs: NOW_MS + 500,
      idempotencyKey: `appointment-cancel-unrelated-${sequence}` })
    const clientRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(client.id).first()
    const scope = clientKeyScope(client.id)
    const dataKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(clientRow.identity_envelope), expectedScope: scope,
    })
    const corruptedAt = new Date(NOW_MS + 500).toISOString()
    const corruptedSnapshot = {
      cancelledAt: corruptedAt, clientId: client.id, createdAt: target.createdAt,
      endsAt: target.endsAt, id: target.id, location: target.location,
      paymentAggregate: { collectedGrosze: 0, outstandingGrosze: 0, status: 'unpaid' },
      schema: 'appointment.v1', serviceId: target.serviceId, source: target.source,
      specialistId: target.specialistId, startsAt: target.startsAt, status: 'cancelled',
      timeZone: target.timeZone, updatedAt: corruptedAt, version: 2,
    }
    const corruptedEnvelope = await encryptForScope(await ring(), dataKey, {
      expectedScope: scope, recordId: target.id, field: 'record_version',
      plaintext: JSON.stringify(corruptedSnapshot),
    })
    let injected = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!injected) {
          injected = true
          await env.DB.batch([
            env.DB.prepare(`UPDATE appointments SET status='cancelled',version=2,
              cancelled_at=?,updated_at=? WHERE id=? AND version=1`).bind(
              corruptedAt, corruptedAt, target.id,
            ),
            env.DB.prepare(`INSERT INTO record_versions
              (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
               changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
              `ver_cancel_terminal_corrupt_${++sequence}`, 'appointment', target.id, 2,
              JSON.stringify(corruptedEnvelope), OWNER.id, corruptedAt, CORRELATION_ID,
            ),
            env.DB.prepare(`INSERT INTO audit_events
              (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
               correlation_id,metadata_json,reason_envelope)
              VALUES (?,?,?,?,?,?,?,?,?,NULL)`).bind(
              `aud_cancel_terminal_corrupt_${sequence}`, corruptedAt, OWNER.id,
              'appointment.cancelled', 'appointment', target.id, 'success',
              CORRELATION_ID,
              JSON.stringify({ appointmentVersion: 2, chargeVersion: 1 }),
            ),
          ])
        }
        return env.DB.batch(statements)
      },
    }
    await expect(cancel(target, { db, nowMs: NOW_MS + 1_000,
      idempotencyKey: `appointment-cancel-terminal-corrupt-${sequence}` }))
      .rejects.toThrow(/core_directory_invariant_failed/)
  })

  it('keeps replay client-scoped across retired, conflicting, and malformed scope state', async () => {
    const client = await seedClient()
    const current = (await create(client, { body: {
      ...BODY, clientId: client.id, date: '2027-10-10',
    } })).body.data.appointment
    const key = `appointment-cancel-replay-scope-${sequence}`
    const result = await cancel(current, { idempotencyKey: key })
    const clientRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(client.id).first()
    await env.DB.prepare('UPDATE data_keys SET retired_at=? WHERE id=?').bind(
      new Date(NOW_MS + 2_000).toISOString(),
      JSON.parse(clientRow.identity_envelope).dataKeyId,
    ).run()
    expect(await cancelAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 3_000, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      appointmentId: current.id, body: { expectedVersion: 1 }, idempotencyKey: key,
    })).toEqual(result)
    await expect(cancelAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 3_000, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      appointmentId: current.id, body: { expectedVersion: 2 }, idempotencyKey: key,
    })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    await expect(cancelAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: {},
      nowMs: NOW_MS + 3_000, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      appointmentId: current.id, body: { expectedVersion: 1 }, idempotencyKey: key,
    })).rejects.toThrow('CRYPTO_FAILURE')
    const wrongScopeDb = { prepare(sql) {
      const prepared = env.DB.prepare(sql)
      if (!sql.includes('SELECT request_hash,resource_type,resource_id,response_envelope')) {
        return prepared
      }
      return { bind(...bindings) {
        const bound = prepared.bind(...bindings)
        return { async first() {
          const row = await bound.first()
          return { ...row, resource_type: 'staff_directory' }
        } }
      } }
    }, batch: (statements) => env.DB.batch(statements) }
    await expect(cancelAppointment({
      db: wrongScopeDb, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 3_000, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      appointmentId: current.id, body: { expectedVersion: 1 }, idempotencyKey: key,
    })).rejects.toThrow('CRYPTO_FAILURE')
  })
})
