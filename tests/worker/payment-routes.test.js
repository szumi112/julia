import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  correctAppointmentPayment,
  digestCorrectPaymentRequest,
  digestRecordPaymentRequest,
  recordAppointmentPayment,
  validateCorrectPaymentBody,
  validateRecordPaymentBody,
} from '../../worker/core/payments.js'
import { postAppointmentPayment } from '../../worker/routes/appointments.js'
import { postPaymentCorrection } from '../../worker/routes/payments.js'
import { cancelAppointment, createAppointment } from '../../worker/core/appointments.js'
import { createClient } from '../../worker/core/clients.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { decryptForScope, encryptForScope, loadDataKey } from '../../worker/security/envelope.js'
import { clientKeyScope } from '../../worker/core/crypto.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
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
const CORRECTION_BODY = Object.freeze({
  expectedVersion: 2,
  reason: 'Błędna metoda płatności',
  replacement: Object.freeze({
    amountGrosze: 10_000,
    method: 'transfer',
    receivedAt: '2027-01-15T08:30:00.000Z',
  }),
})
const BASE = Object.freeze({
  db: {}, recoveryDb: {},
  actor: { id: 'stf_payment_owner', role: 'owner', specialistId: null },
  keyring: {}, nowMs: Date.parse('2027-01-15T09:00:00.000Z'),
  correlationId: '00000000-0000-4000-8000-000000000022',
  idFactory: () => 'fixture', appointmentId: 'apt_payment_fixture',
  body: BODY, idempotencyKey: 'payment-command-key-0001',
})
const CORRECTION_BASE = Object.freeze(Object.fromEntries(
  Object.entries(BASE).filter(([key]) => key !== 'appointmentId'),
))
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
      'stf_payment_coordinator', 'lookup_payment_coordinator', '{}', '{}',
      'coordinator', 'active', 'access-payment-coordinator', null, 1,
      now, null, now, now,
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

const correctionInput = async (appointment, paymentId, overrides = {}) => {
  const marker = `payment_correction_${++sequence}`
  return {
    db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
    nowMs: NOW_MS + sequence * 1_000, correlationId: BASE.correlationId,
    idFactory: suffixes(marker), paymentId,
    body: { ...CORRECTION_BODY, expectedVersion: appointment.version },
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
      expectedScope: scope,
      recordId: correction.reasonMode === 'wrong-aad' ? `${correction.id}_wrong` : correction.id,
      field: 'reason',
      plaintext: 'Fikcyjna korekta',
    })
    if (correction.reasonMode === 'tampered') {
      envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${
        envelope.ciphertext.endsWith('A') ? 'B' : 'A'}`
    }
    const reasonEnvelope = correction.reasonMode === 'malformed'
      ? '{'
      : correction.reasonMode === 'missing-fields' ? '{}'
        : JSON.stringify(envelope)
    statements.push(env.DB.prepare(`INSERT INTO payment_corrections
      (id,reversed_entry_id,replacement_entry_id,reason_envelope,
       recorded_by_staff_id,created_at) VALUES (?,?,?,?,?,?)`).bind(
      correction.id, correction.reversedEntryId, correction.replacementEntryId,
      reasonEnvelope, OWNER.id, correction.createdAt ?? changedAt,
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

const seedContiguousPayments = async (appointment, count) => {
  const client = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
    .bind(appointment.clientId).first()
  const scope = clientKeyScope(appointment.clientId)
  const dataKey = await loadDataKey(env.DB, {
    envelope: JSON.parse(client.identity_envelope), expectedScope: scope,
  })
  const statements = []
  let updatedAt = appointment.updatedAt
  for (let index = 1; index <= count; index += 1) {
    const version = index + 1
    updatedAt = new Date(NOW_MS + index).toISOString()
    const paymentId = `pay_contiguous_${sequence}_${String(index).padStart(4, '0')}`
    const snapshot = {
      cancelledAt: null, clientId: appointment.clientId, createdAt: appointment.createdAt,
      endsAt: appointment.endsAt, id: appointment.id, location: appointment.location,
      paymentAggregate: { collectedGrosze: index,
        outstandingGrosze: appointment.charge.expectedAmountGrosze - index,
        status: 'partial' },
      schema: 'appointment.v1', serviceId: appointment.serviceId, source: 'panel',
      specialistId: appointment.specialistId, startsAt: appointment.startsAt,
      status: appointment.status, timeZone: 'Europe/Warsaw', updatedAt, version,
    }
    const envelope = await encryptForScope(await ring(), dataKey, {
      expectedScope: scope, recordId: appointment.id, field: 'record_version',
      plaintext: JSON.stringify(snapshot),
    })
    statements.push(
      env.DB.prepare(`INSERT INTO payment_entries
        (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
         external_reference_envelope,created_at) VALUES (?,?,?,?,?,?,NULL,?)`).bind(
        paymentId, appointment.id, 1, 'cash', '2027-01-15T07:00:00.000Z',
        OWNER.id, updatedAt,
      ),
      env.DB.prepare('UPDATE appointments SET version=?,updated_at=? WHERE id=? AND version=?')
        .bind(version, updatedAt, appointment.id, version - 1),
      env.DB.prepare(`INSERT INTO record_versions
        (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
         changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
        `ver_contiguous_${sequence}_${String(version).padStart(4, '0')}`,
        'appointment', appointment.id, version, JSON.stringify(envelope), OWNER.id,
        updatedAt, BASE.correlationId,
      ),
    )
  }
  for (let offset = 0; offset < statements.length; offset +=  ninetyStatements) {
    await env.DB.batch(statements.slice(offset, offset + ninetyStatements))
  }
  return Object.freeze({ ...appointment, version: count + 1, updatedAt })
}

const seedContiguousAppointmentVersions = async (appointment, finalVersion) => {
  const client = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
    .bind(appointment.clientId).first()
  const scope = clientKeyScope(appointment.clientId)
  const keyring = await ring()
  const dataKey = await loadDataKey(env.DB, {
    envelope: JSON.parse(client.identity_envelope), expectedScope: scope,
  })
  const statements = []
  let updatedAt = appointment.updatedAt
  for (let version = 2; version <= finalVersion; version += 1) {
    updatedAt = new Date(NOW_MS + version).toISOString()
    const snapshot = {
      cancelledAt: null, clientId: appointment.clientId, createdAt: appointment.createdAt,
      endsAt: appointment.endsAt, id: appointment.id, location: appointment.location,
      paymentAggregate: { collectedGrosze: 0,
        outstandingGrosze: appointment.charge.expectedAmountGrosze, status: 'unpaid' },
      schema: 'appointment.v1', serviceId: appointment.serviceId, source: 'panel',
      specialistId: appointment.specialistId, startsAt: appointment.startsAt,
      status: appointment.status, timeZone: 'Europe/Warsaw', updatedAt, version,
    }
    const envelope = await encryptForScope(keyring, dataKey, {
      expectedScope: scope, recordId: appointment.id, field: 'record_version',
      plaintext: JSON.stringify(snapshot),
    })
    statements.push(
      env.DB.prepare('UPDATE appointments SET version=?,updated_at=? WHERE id=? AND version=?')
        .bind(version, updatedAt, appointment.id, version - 1),
      env.DB.prepare(`INSERT INTO record_versions
        (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
         changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
        `ver_bound_${sequence}_${String(version).padStart(4, '0')}`,
        'appointment', appointment.id, version, JSON.stringify(envelope), OWNER.id,
        updatedAt, BASE.correlationId,
      ),
    )
  }
  for (let offset = 0; offset < statements.length; offset += ninetyStatements) {
    await env.DB.batch(statements.slice(offset, offset + ninetyStatements))
  }
  return Object.freeze({
    appointment: Object.freeze({ ...appointment, version: finalVersion, updatedAt }),
    dataKey, keyring, scope,
  })
}

const ninetyStatements = 90

const canonicalJson = (value) => JSON.stringify(value === null
  || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map((entry) => JSON.parse(canonicalJson(entry)))
    : Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, JSON.parse(canonicalJson(value[key]))])))

const correctionIdempotencyRecordId = async (actorId, key) => {
  const encoded = new TextEncoder().encode(
    ['bwm:idempotency:record:v1', actorId, 'payments.correct', key].join('\n'),
  )
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
  try { return `idem_${encodeBase64Url(digest)}` } finally {
    encoded.fill(0)
    digest.fill(0)
  }
}

const withEncryptedPaymentReplay = async (
  clientId, idempotencyKey, response, requestDigest = null,
  operation = 'appointments.payment',
) => {
  const client = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
    .bind(clientId).first()
  const scope = clientKeyScope(clientId)
  const dataKey = await loadDataKey(env.DB, {
    envelope: JSON.parse(client.identity_envelope), expectedScope: scope,
  })
  const tuple = new TextEncoder().encode(
    ['bwm:idempotency:record:v1', OWNER.id, operation, idempotencyKey].join('\n'),
  )
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', tuple))
  const recordId = `idem_${encodeBase64Url(digest)}`
  tuple.fill(0)
  digest.fill(0)
  const responseEnvelope = JSON.stringify(await encryptForScope(await ring(), dataKey, {
    expectedScope: scope, recordId, field: 'idempotency_response',
    plaintext: canonicalJson(response),
  }))
  const requestEnvelope = requestDigest === null ? null
    : JSON.stringify(await encryptForScope(await ring(), dataKey, {
      expectedScope: scope, recordId, field: 'idempotency_request_hash',
      plaintext: requestDigest,
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
        return row === null ? null : {
          ...row, response_envelope: responseEnvelope,
          ...(requestEnvelope === null ? {} : { request_hash: requestEnvelope }),
        }
      } }
    } }
  }, batch: (statements) => env.DB.batch(statements) }
}

const withCorruptedAll = (needle, mutate) => ({
  prepare(sql) {
    const prepared = env.DB.prepare(sql)
    if (!sql.includes(needle)) return prepared
    return { bind(...bindings) {
      const bound = prepared.bind(...bindings)
      return { async all() {
        const result = await bound.all()
        return { ...result, results: result.results.map((row, index) => (
          index === 0 ? mutate({ ...row }) : row
        )) }
      } }
    } }
  },
  batch: (statements) => env.DB.batch(statements),
})

describe('appointment payment capture', () => {
  it('strictly captures correction reason and optional replacement with a canonical digest', async () => {
    expect(validateCorrectPaymentBody(CORRECTION_BODY)).toEqual(CORRECTION_BODY)
    expect(validateCorrectPaymentBody({ ...CORRECTION_BODY, replacement: null }))
      .toEqual({ ...CORRECTION_BODY, replacement: null })
    expect(validateCorrectPaymentBody({ ...CORRECTION_BODY,
      reason: `${'ą'.repeat(250)}`, replacement: null }).reason).toHaveLength(250)
    expect(validateCorrectPaymentBody({ ...CORRECTION_BODY,
      reason: 'A\u0000B', replacement: null }).reason).toBe('A\u0000B')
    await expect(digestCorrectPaymentRequest('pay_correction_fixture', CORRECTION_BODY))
      .resolves.toMatch(/^[A-Za-z0-9_-]{43}$/)
    for (const [field, value] of [
      ['expectedVersion', 0], ['expectedVersion', 4_096], ['reason', ''],
      ['reason', ' whitespace '],
      ['reason', 'e\u0301'], ['reason', '\uD800'], ['reason', 'ą'.repeat(251)],
      ['replacement', {}],
    ]) {
      expect(() => validateCorrectPaymentBody({ ...CORRECTION_BODY, [field]: value }))
        .toThrow(`VALIDATION_FAILED/${field}`)
    }
    for (const [field, value] of [
      ['amountGrosze', 0], ['amountGrosze', 1_000_001], ['method', 'blik'],
      ['receivedAt', '2027-01-15T08:30:00Z'],
    ]) {
      expect(() => validateCorrectPaymentBody({ ...CORRECTION_BODY, replacement: {
        ...CORRECTION_BODY.replacement, [field]: value,
      } })).toThrow(`VALIDATION_FAILED/${field}`)
    }
    expect(() => validateCorrectPaymentBody({ ...CORRECTION_BODY, extra: true }))
      .toThrow('VALIDATION_FAILED/body')
    const getter = vi.fn(() => CORRECTION_BODY.reason)
    const hostile = { ...CORRECTION_BODY }
    Object.defineProperty(hostile, 'reason', { enumerable: true, get: getter })
    expect(() => validateCorrectPaymentBody(hostile)).toThrow('VALIDATION_FAILED/body')
    expect(getter).not.toHaveBeenCalled()
  })

  it('maps only closed correction validation fields through the route adapter', async () => {
    const service = vi.fn(async () => ({ status: 200, body: { data: { appointment: {} } } }))
    await expect(postPaymentCorrection({
      ...CORRECTION_BASE, paymentId: 'pay_correction_fixture', body: CORRECTION_BODY,
      correctPayment: service,
    })).resolves.toMatchObject({ status: 200 })
    expect(service).toHaveBeenCalledOnce()
    await expect(postPaymentCorrection({
      ...CORRECTION_BASE, paymentId: 'pay_correction_fixture', body: {
        ...CORRECTION_BODY, reason: '',
      }, correctPayment: service,
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', details: { field: 'reason' },
    })
  })

  it('atomically reverses a payment, encrypts its reason, advances appointment only, and replays first', async () => {
    const created = await seedAppointment()
    const recorded = await recordAppointmentPayment(await paymentInput(created))
    const appointment = recorded.body.data.appointment
    const target = appointment.paymentEntries[0]
    const input = await correctionInput(appointment, target.id, {
      body: { expectedVersion: appointment.version, reason: 'Błędny wpis', replacement: null },
    })
    const chargeBefore = await env.DB.prepare('SELECT * FROM session_charges WHERE id=?')
      .bind(appointment.charge.id).first()
    const result = await correctAppointmentPayment(input)
    expect(result).toMatchObject({ status: 200, body: { data: { appointment: {
      id: appointment.id, version: appointment.version + 1,
      charge: { id: appointment.charge.id, version: appointment.charge.version },
      payment: { status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 19_500,
        latestMethod: null, latestReceivedAt: null },
      paymentEntries: [{ id: target.id, correctedAt: new Date(input.nowMs).toISOString(),
        replacementEntryId: null }],
    } } } })
    expect(await env.DB.prepare('SELECT * FROM session_charges WHERE id=?')
      .bind(appointment.charge.id).first()).toEqual(chargeBefore)
    const correction = await env.DB.prepare(`SELECT id,reversed_entry_id,replacement_entry_id,
      reason_envelope,recorded_by_staff_id,created_at FROM payment_corrections
      WHERE reversed_entry_id=?`).bind(target.id).first()
    expect(correction).toMatchObject({ reversed_entry_id: target.id,
      replacement_entry_id: null, recorded_by_staff_id: OWNER.id,
      created_at: new Date(input.nowMs).toISOString() })
    expect(correction.reason_envelope).not.toContain('Błędny wpis')
    const client = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(appointment.clientId).first()
    const scope = clientKeyScope(appointment.clientId)
    const dataKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(client.identity_envelope), expectedScope: scope,
    })
    await expect(decryptForScope(await ring(), dataKey, {
      expectedScope: scope, recordId: correction.id, field: 'reason',
      envelope: JSON.parse(correction.reason_envelope),
    })).resolves.toBe('Błędny wpis')
    await expect(decryptForScope(await ring(), dataKey, {
      expectedScope: scope, recordId: `${correction.id}_wrong`, field: 'reason',
      envelope: JSON.parse(correction.reason_envelope),
    })).rejects.toThrow('CRYPTO_FAILURE')
    const audit = await env.DB.prepare(`SELECT action,entity_type,entity_id,
      reason_envelope,metadata_json FROM audit_events WHERE action='payment.corrected'
      AND entity_id=?`).bind(target.id).first()
    expect(audit).toEqual({ action: 'payment.corrected', entity_type: 'payment_entry',
      entity_id: target.id, reason_envelope: null, metadata_json: JSON.stringify({
        appointmentVersion: appointment.version + 1,
        correctionId: correction.id,
        replacementEntryId: null,
        reversedEntryId: target.id,
      }) })
    expect(JSON.stringify(result)).not.toContain('Błędny wpis')
    const replayFactory = vi.fn()
    await expect(correctAppointmentPayment({ ...input, idFactory: replayFactory,
      nowMs: input.nowMs + 1 })).resolves.toEqual(result)
    expect(replayFactory).not.toHaveBeenCalled()
  })

  it('replaces a payment immutably on the same appointment and recomputes latest effective money', async () => {
    const created = await seedAppointment('noshow')
    const first = await recordAppointmentPayment(await paymentInput(created, { body: {
      ...BODY, expectedVersion: 1, amountGrosze: 5_000, method: 'cash',
      receivedAt: '2027-01-15T08:45:00.000Z',
    } }))
    const appointment = first.body.data.appointment
    const target = appointment.paymentEntries[0]
    const input = await correctionInput(appointment, target.id, { body: {
      expectedVersion: appointment.version, reason: 'Zmiana metody', replacement: {
        amountGrosze: 6_000, method: 'transfer', receivedAt: '2027-01-15T08:15:00.000Z',
      },
    } })
    const result = await correctAppointmentPayment(input)
    const next = result.body.data.appointment
    expect(next.version).toBe(appointment.version + 1)
    expect(next.payment).toEqual({ status: 'partial', collectedGrosze: 6_000,
      outstandingGrosze: 13_500, latestMethod: 'transfer',
      latestReceivedAt: '2027-01-15T08:15:00.000Z' })
    expect(next.paymentEntries).toHaveLength(2)
    expect(next.paymentEntries.find(({ id }) => id === target.id)).toMatchObject({
      correctedAt: new Date(input.nowMs).toISOString(),
      replacementEntryId: expect.stringMatching(/^pay_/),
    })
    const replacement = next.paymentEntries.find(({ id }) => id !== target.id)
    expect(replacement).toMatchObject({ amountGrosze: 6_000, method: 'transfer',
      receivedAt: '2027-01-15T08:15:00.000Z', correctedAt: null,
      replacementEntryId: null })
    const stored = await env.DB.prepare(`SELECT appointment_id,amount_grosze,method,
      received_at,recorded_by_staff_id,external_reference_envelope,created_at
      FROM payment_entries WHERE id=?`).bind(replacement.id).first()
    expect(stored).toEqual({ appointment_id: appointment.id, amount_grosze: 6_000,
      method: 'transfer', received_at: '2027-01-15T08:15:00.000Z',
      recorded_by_staff_id: OWNER.id, external_reference_envelope: null,
      created_at: new Date(input.nowMs).toISOString() })
  })

  it('orders correction scope, opacity, authorization, stale, and total conflicts before IDs', async () => {
    const created = await seedAppointment()
    const recorded = await recordAppointmentPayment(await paymentInput(created, { body: {
      ...BODY, expectedVersion: 1, amountGrosze: 5_000,
    } }))
    const appointment = recorded.body.data.appointment
    const target = appointment.paymentEntries[0]
    for (const overrides of [
      { paymentId: 'pay_absent' },
      { actor: { id: 'stf_payment_target', role: 'specialist', specialistId: 'sp_other' } },
    ]) {
      const idFactory = vi.fn()
      await expect(correctAppointmentPayment(await correctionInput(
        appointment, target.id, { ...overrides, idFactory },
      ))).rejects.toThrow('NOT_FOUND')
      expect(idFactory).not.toHaveBeenCalled()
    }
    const staleFactory = vi.fn()
    await expect(correctAppointmentPayment(await correctionInput(
      appointment, target.id, { idFactory: staleFactory,
        body: { ...CORRECTION_BODY, expectedVersion: appointment.version + 1 } },
    ))).rejects.toMatchObject({ message: 'VERSION_CONFLICT',
      details: { currentVersion: appointment.version } })
    expect(staleFactory).not.toHaveBeenCalled()

    const ownerResult = await correctAppointmentPayment(await correctionInput(
      appointment, target.id, { body: {
        expectedVersion: appointment.version, reason: 'Usunięcie', replacement: null,
      } },
    ))
    const alreadyFactory = vi.fn()
    await expect(correctAppointmentPayment(await correctionInput(
      ownerResult.body.data.appointment, target.id, { idFactory: alreadyFactory },
    ))).rejects.toThrow('NOT_FOUND')
    expect(alreadyFactory).not.toHaveBeenCalled()

    const conflictCreated = await seedAppointment()
    const first = await recordAppointmentPayment(await paymentInput(conflictCreated, { body: {
      ...BODY, expectedVersion: 1, amountGrosze: 5_000,
    } }))
    const second = await recordAppointmentPayment(await paymentInput(
      first.body.data.appointment, { body: {
        ...BODY, expectedVersion: 2, amountGrosze: 14_500,
        receivedAt: '2027-01-15T08:45:00.000Z',
      } },
    ))
    const conflictTarget = second.body.data.appointment.paymentEntries
      .find(({ amountGrosze }) => amountGrosze === 5_000)
    const conflictFactory = vi.fn()
    await expect(correctAppointmentPayment(await correctionInput(
      second.body.data.appointment, conflictTarget.id, { idFactory: conflictFactory,
        body: { expectedVersion: 3, reason: 'Za duża zamiana', replacement: {
          amountGrosze: 5_001, method: 'card', receivedAt: BODY.receivedAt,
        } } },
    ))).rejects.toThrow('PAYMENT_CORRECTION_CONFLICT')
    expect(conflictFactory).not.toHaveBeenCalled()
  })

  it('allows the owning specialist and keeps correction reasons out of replay and audit', async () => {
    const created = await seedAppointment()
    const recorded = await recordAppointmentPayment(await paymentInput(created))
    const appointment = recorded.body.data.appointment
    const target = appointment.paymentEntries[0]
    const input = await correctionInput(appointment, target.id, {
      actor: { id: 'stf_payment_target', role: 'specialist',
        specialistId: 'sp_payment_target' },
      body: { expectedVersion: appointment.version,
        reason: 'Poufna fikcyjna przyczyna', replacement: null },
    })
    const result = await correctAppointmentPayment(input)
    expect(JSON.stringify(result)).not.toContain('Poufna fikcyjna przyczyna')
    const rows = (await env.DB.prepare(`SELECT metadata_json,reason_envelope
      FROM audit_events WHERE action='payment.corrected' AND entity_id=?`)
      .bind(target.id).all()).results
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('Poufna fikcyjna przyczyna')
    await expect(correctAppointmentPayment({ ...input, idFactory: vi.fn(),
      nowMs: input.nowMs + 1 })).resolves.toEqual(result)
    await expect(correctAppointmentPayment({ ...input, idFactory: vi.fn(), body: {
      ...input.body, reason: 'Inna przyczyna',
    } })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    const client = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(appointment.clientId).first()
    await env.DB.prepare('UPDATE data_keys SET retired_at=? WHERE id=?').bind(
      new Date(input.nowMs + 2).toISOString(), JSON.parse(client.identity_envelope).dataKeyId,
    ).run()
    await expect(correctAppointmentPayment({ ...input, idFactory: vi.fn(),
      nowMs: input.nowMs + 2 })).resolves.toEqual(result)
  })

  it('allows a coordinator to correct any authenticated scoped payment', async () => {
    const created = await seedAppointment()
    const recorded = await recordAppointmentPayment(await paymentInput(created))
    const appointment = recorded.body.data.appointment
    const target = appointment.paymentEntries[0]
    const result = await correctAppointmentPayment(await correctionInput(
      appointment, target.id, {
        actor: { id: 'stf_payment_coordinator', role: 'coordinator', specialistId: null },
        body: { expectedVersion: appointment.version,
          reason: 'Korekta koordynatora', replacement: null },
      },
    ))
    expect(result.body.data.appointment.payment.collectedGrosze).toBe(0)
  })

  it('fails correction replay closed for missing keys, wrong scope, and tampered envelopes', async () => {
    for (const mode of ['missing-key', 'wrong-scope', 'tampered-envelope']) {
      const created = await seedAppointment()
      const recorded = await recordAppointmentPayment(await paymentInput(created))
      const appointment = recorded.body.data.appointment
      const target = appointment.paymentEntries[0]
      const input = await correctionInput(appointment, target.id, { body: {
        expectedVersion: appointment.version, reason: 'Replay poufny', replacement: null,
      } })
      await correctAppointmentPayment(input)
      const db = { prepare(sql) {
        const prepared = env.DB.prepare(sql)
        if (mode === 'missing-key' && sql.includes('FROM data_keys')) {
          return { bind() { return { first: async () => null } } }
        }
        if (!sql.includes('SELECT request_hash,resource_type,resource_id,response_envelope')) {
          return prepared
        }
        return { bind(...bindings) {
          const bound = prepared.bind(...bindings)
          return { async first() {
            const row = await bound.first()
            if (mode === 'wrong-scope') return { ...row, resource_id: created.id }
            if (mode === 'tampered-envelope') return { ...row, response_envelope: '{}' }
            return row
          } }
        } }
      }, batch: (statements) => env.DB.batch(statements) }
      await expect(correctAppointmentPayment({ ...input, db, idFactory: vi.fn() }))
        .rejects.toThrow('CRYPTO_FAILURE')
    }
  })

  it('classifies retained correction-reason corruption as crypto failure for another active target', async () => {
    for (const reasonMode of ['malformed', 'missing-fields', 'wrong-aad', 'tampered']) {
      const created = await seedAppointment()
      const at = new Date(NOW_MS + 500).toISOString()
      const marker = `correction_crypto_${++sequence}`
      const retained = await seedPaymentGraph(created, [
        { id: `pay_${marker}_reversed`, amountGrosze: 1_000, method: 'cash',
          receivedAt: '2027-01-15T07:00:00.000Z', createdAt: at },
        { id: `pay_${marker}_active`, amountGrosze: 2_000, method: 'card',
          receivedAt: '2027-01-15T08:00:00.000Z', createdAt: at },
      ], [{ id: `cor_${marker}`, reversedEntryId: `pay_${marker}_reversed`,
        replacementEntryId: null, createdAt: at, reasonMode }])
      const idFactory = vi.fn()
      await expect(correctAppointmentPayment(await correctionInput(
        retained, `pay_${marker}_active`, {
          idFactory,
          nowMs: NOW_MS + 2_000,
          body: { expectedVersion: 2, reason: 'Nowa korekta', replacement: null },
        },
      ))).rejects.toThrow('CRYPTO_FAILURE')
      expect(idFactory).not.toHaveBeenCalled()
    }
  })

  it('rejects correction replay with a reverse-time historical replacement edge', async () => {
    const created = await seedAppointment()
    const at = new Date(NOW_MS + 500).toISOString()
    const marker = `correction_replay_edge_${++sequence}`
    const retained = await seedPaymentGraph(created, [
      { id: `pay_${marker}_old`, amountGrosze: 1_000, method: 'cash',
        receivedAt: '2027-01-15T07:00:00.000Z', createdAt: at },
      { id: `pay_${marker}_replacement`, amountGrosze: 2_000, method: 'card',
        receivedAt: '2027-01-15T07:30:00.000Z', createdAt: at },
      { id: `pay_${marker}_target`, amountGrosze: 3_000, method: 'transfer',
        receivedAt: '2027-01-15T08:00:00.000Z', createdAt: at },
    ], [{ id: `cor_${marker}_old`, reversedEntryId: `pay_${marker}_old`,
      replacementEntryId: `pay_${marker}_replacement`, createdAt: at }])
    const input = await correctionInput(retained, `pay_${marker}_target`, {
      nowMs: NOW_MS + 2_000,
      body: { expectedVersion: 2, reason: 'Korekta celu', replacement: null },
    })
    const result = await correctAppointmentPayment(input)
    const hostile = structuredClone(result)
    const old = hostile.body.data.appointment.paymentEntries
      .find(({ id }) => id === `pay_${marker}_old`)
    const replacement = hostile.body.data.appointment.paymentEntries
      .find(({ id }) => id === `pay_${marker}_replacement`)
    replacement.correctedAt = new Date(NOW_MS + 400).toISOString()
    replacement.replacementEntryId = null
    hostile.body.data.appointment.payment = {
      status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 19_500,
      latestMethod: null, latestReceivedAt: null,
    }
    expect(old.correctedAt).toBe(at)
    const digest = await digestCorrectPaymentRequest(input.paymentId, input.body)
    const db = await withEncryptedPaymentReplay(
      retained.clientId, input.idempotencyKey, hostile, digest, 'payments.correct',
    )
    await expect(correctAppointmentPayment({ ...input, db, idFactory: vi.fn() }))
      .rejects.toThrow('CRYPTO_FAILURE')
  })

  it('keeps payment and correction rows append-only and rolls back every UOW position in both shapes', async () => {
    const appendCreated = await seedAppointment()
    const appendRecorded = await recordAppointmentPayment(await paymentInput(appendCreated))
    const appendTarget = appendRecorded.body.data.appointment.paymentEntries[0]
    const appendResult = await correctAppointmentPayment(await correctionInput(
      appendRecorded.body.data.appointment, appendTarget.id, { body: {
        expectedVersion: 2, reason: 'Test niezmienności', replacement: null,
      } },
    ))
    await expect(env.DB.prepare('UPDATE payment_entries SET amount_grosze=1 WHERE id=?')
      .bind(appendTarget.id).run()).rejects.toThrow()
    await expect(env.DB.prepare('DELETE FROM payment_entries WHERE id=?')
      .bind(appendTarget.id).run()).rejects.toThrow()
    const correction = await env.DB.prepare(
      'SELECT id FROM payment_corrections WHERE reversed_entry_id=?',
    ).bind(appendTarget.id).first()
    await expect(env.DB.prepare('UPDATE payment_corrections SET created_at=? WHERE id=?')
      .bind(appendResult.body.data.appointment.updatedAt, correction.id).run()).rejects.toThrow()
    await expect(env.DB.prepare('DELETE FROM payment_corrections WHERE id=?')
      .bind(correction.id).run()).rejects.toThrow()

    for (const replacement of [null, CORRECTION_BODY.replacement]) {
      const positions = replacement === null ? 6 : 7
      for (let failedAt = 0; failedAt < positions; failedAt += 1) {
        const created = await seedAppointment()
        const recorded = await recordAppointmentPayment(await paymentInput(created))
        const appointment = recorded.body.data.appointment
        const target = appointment.paymentEntries[0]
        const before = await ledgerSnapshot()
        const db = {
          prepare: (sql) => env.DB.prepare(sql),
          batch: (statements) => env.DB.batch(statements.map((statement, index) => (
            index === failedAt
              ? env.DB.prepare("INSERT INTO core_directory_invariant_failures (failure_kind) VALUES ('forced')")
              : statement
          ))),
        }
        await expect(correctAppointmentPayment(await correctionInput(
          appointment, target.id, { db, body: {
            expectedVersion: appointment.version, reason: 'Wymuszony rollback', replacement,
          } },
        ))).rejects.toThrow()
        expect(await ledgerSnapshot()).toEqual(before)
      }
    }
  })

  it('allows null reversal at 1,000 entries but rejects replacement before IDs', async () => {
    const entriesFor = (marker) => Array.from({ length: 1_000 }, (_, index) => ({
      id: `pay_cap_${marker}_${String(index).padStart(4, '0')}`,
      amountGrosze: 1, method: 'cash',
      receivedAt: `2027-01-15T08:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    }))
    const nullCreated = await seedAppointment()
    const nullEntries = entriesFor(`null_${sequence}`)
    const nullAppointment = await seedPaymentGraph(nullCreated, nullEntries)
    const nullTarget = nullEntries[0]
    const reversed = await correctAppointmentPayment(await correctionInput(
      nullAppointment, nullTarget.id, { body: {
        expectedVersion: 2, reason: 'Korekta na granicy', replacement: null,
      } },
    ))
    expect(reversed.body.data.appointment.paymentEntries).toHaveLength(1_000)
    expect(reversed.body.data.appointment.payment.collectedGrosze).toBe(999)

    const replacementCreated = await seedAppointment()
    const replacementEntries = entriesFor(`replacement_${sequence}`)
    const replacementAppointment = await seedPaymentGraph(
      replacementCreated, replacementEntries,
    )
    const idFactory = vi.fn()
    await expect(correctAppointmentPayment(await correctionInput(
      replacementAppointment, replacementEntries[0].id, { idFactory, body: {
        expectedVersion: 2, reason: 'Brak miejsca',
        replacement: { amountGrosze: 1, method: 'cash',
          receivedAt: '2027-01-15T08:00:00.000Z' },
      } },
    ))).rejects.toThrow('PAYMENT_CORRECTION_CONFLICT')
    expect(idFactory).not.toHaveBeenCalled()
  })

  it('recovers an injected same-key correction winner with exactly two reserve reads', async () => {
    const created = await seedAppointment()
    const recorded = await recordAppointmentPayment(await paymentInput(created))
    const appointment = recorded.body.data.appointment
    const target = appointment.paymentEntries[0]
    const commandNow = Date.parse(appointment.updatedAt) + 1_000
    const key = `correction-injected-winner-${sequence}`
    const body = { expectedVersion: appointment.version,
      reason: 'Jedna korekta', replacement: null }
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
          winner = await correctAppointmentPayment({
            db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
            nowMs: commandNow, correlationId: BASE.correlationId,
            idFactory: suffixes(`correction_injected_winner_${++sequence}`),
            paymentId: target.id, body, idempotencyKey: key,
          })
        }
        return budget.work.batch(statements)
      },
    }
    const loser = await correctAppointmentPayment({
      db, recoveryDb, actor: OWNER, keyring: await ring(), nowMs: commandNow,
      correlationId: BASE.correlationId,
      idFactory: suffixes(`correction_injected_loser_${++sequence}`),
      paymentId: target.id, body, idempotencyKey: key,
    })
    expect(loser).toEqual(winner)
    expect(recoveryReads).toBe(2)
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 18, remaining: 32, workRemaining: 24,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('never recovers a same-key winner when any loser-generated namespace also collides', async () => {
    for (const kind of ['correction', 'replacement', 'version', 'audit', 'idem-record', 'idem-key']) {
      const created = await seedAppointment()
      const recorded = await recordAppointmentPayment(await paymentInput(created))
      const appointment = recorded.body.data.appointment
      const target = appointment.paymentEntries[0]
      const key = `correction-hostile-winner-${kind}-${sequence}`
      const replacement = kind === 'replacement' ? {
        amountGrosze: 9_000, method: 'transfer', receivedAt: BODY.receivedAt,
      } : null
      const body = { expectedVersion: appointment.version,
        reason: `Kolizja ${kind}`, replacement }
      const ids = replacement === null
        ? [`loser_${kind}_cor_${sequence}`, `loser_${kind}_ver_${sequence}`,
          `loser_${kind}_aud_${sequence}`]
        : [`loser_${kind}_cor_${sequence}`, `loser_${kind}_pay_${sequence}`,
          `loser_${kind}_ver_${sequence}`, `loser_${kind}_aud_${sequence}`]
      const generated = {
        correction: `cor_${ids[0]}`,
        replacement: replacement === null ? null : `pay_${ids[1]}`,
        version: `ver_${ids[replacement === null ? 1 : 2]}`,
        audit: `aud_${ids[replacement === null ? 2 : 3]}`,
        'idem-record': await correctionIdempotencyRecordId(OWNER.id, key),
        'idem-key': key,
      }
      let injected = false
      const db = {
        prepare: (sql) => env.DB.prepare(sql),
        async batch(statements) {
          if (!injected) {
            injected = true
            await correctAppointmentPayment({
              db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
              nowMs: Date.parse(appointment.updatedAt) + 1_000,
              correlationId: BASE.correlationId,
              idFactory: suffixes(`correction_hostile_winner_${kind}_${++sequence}`),
              paymentId: target.id, body, idempotencyKey: key,
            })
            await env.DB.prepare(`INSERT INTO record_versions
              (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
               changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
              `ver_hostile_namespace_${kind}_${++sequence}`, 'client', generated[kind], 99,
              '{}', OWNER.id, new Date(NOW_MS + 500).toISOString(), BASE.correlationId,
            ).run()
          }
          return env.DB.batch(statements)
        },
      }
      const recoveryDb = { prepare: vi.fn(() => { throw new Error('reserve forbidden') }) }
      await expect(correctAppointmentPayment({
        db, recoveryDb, actor: OWNER, keyring: await ring(),
        nowMs: Date.parse(appointment.updatedAt) + 1_000,
        correlationId: BASE.correlationId, idFactory: () => ids.shift(),
        paymentId: target.id, body, idempotencyKey: key,
      })).rejects.toThrow(/(?:identity_collision|core_directory_invariant_failed)/)
      expect(recoveryDb.prepare).not.toHaveBeenCalled()
      expect(await env.DB.prepare(`SELECT count(*) AS count FROM payment_corrections
        WHERE reversed_entry_id=?`).bind(target.id).first(), kind).toEqual({ count: 1 })
    }
  })

  it('classifies a different-key correction loser as opaque not found after reproof', async () => {
    const created = await seedAppointment()
    const recorded = await recordAppointmentPayment(await paymentInput(created))
    const appointment = recorded.body.data.appointment
    const target = appointment.paymentEntries[0]
    const commandNow = Date.parse(appointment.updatedAt) + 1_000
    let injected = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!injected) {
          injected = true
          await correctAppointmentPayment(await correctionInput(
            appointment, target.id, { nowMs: commandNow,
              body: { expectedVersion: appointment.version,
                reason: 'Wygrywająca korekta', replacement: null } },
          ))
        }
        return env.DB.batch(statements)
      },
    }
    await expect(correctAppointmentPayment(await correctionInput(
      appointment, target.id, { db, nowMs: commandNow,
        body: { expectedVersion: appointment.version,
          reason: 'Przegrywająca korekta', replacement: null } },
    ))).rejects.toThrow('NOT_FOUND')
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM payment_corrections
      WHERE reversed_entry_id=?`).bind(target.id).first()).toEqual({ count: 1 })
  })

  it('rolls back correction races that branch, gap, or cross-type the retained assignment chain', async () => {
    for (const corruption of ['branch', 'gap', 'cross-type']) {
      const created = await seedAppointment()
      const recorded = await recordAppointmentPayment(await paymentInput(created))
      const appointment = recorded.body.data.appointment
      const target = appointment.paymentEntries[0]
      const client = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
        .bind(appointment.clientId).first()
      const dataKeyId = JSON.parse(client.identity_envelope).dataKeyId
      const marker = `correction_assignment_${corruption}_${++sequence}`
      let injected = false
      const db = {
        prepare: (sql) => env.DB.prepare(sql),
        async batch(statements) {
          if (!injected) {
            injected = true
            const open = await env.DB.prepare(`SELECT id,starts_at FROM client_assignments
              WHERE client_id=? AND ends_at IS NULL`).bind(appointment.clientId).first()
            if (corruption === 'cross-type') {
              await env.DB.prepare(`INSERT INTO record_versions
                (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
                 changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
                `ver_${marker}`, 'client', open.id, 99, '{}', OWNER.id,
                new Date(NOW_MS + 500).toISOString(), BASE.correlationId,
              ).run()
            } else {
              const starts = corruption === 'branch'
                ? [new Date(NOW_MS - 2_000).toISOString(),
                  new Date(NOW_MS - 1_000).toISOString()]
                : [new Date(NOW_MS - 2_000).toISOString()]
              for (let index = 0; index < starts.length; index += 1) {
                const assignmentId = `asg_${marker}_${index}`
                const end = corruption === 'branch'
                  ? open.starts_at : new Date(NOW_MS - 500).toISOString()
                await env.DB.prepare(`INSERT INTO client_assignments
                  (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
                   version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
                  assignmentId, appointment.clientId, appointment.specialistId,
                  starts[index], end, OWNER.id, 2, starts[index], end,
                ).run()
                for (const version of [1, 2]) {
                  await env.DB.prepare(`INSERT INTO record_versions
                    (id,entity_type,entity_id,version,snapshot_envelope,
                     changed_by_staff_id,changed_at,correlation_id)
                    VALUES (?,?,?,?,?,?,?,?)`).bind(
                    `ver_${marker}_${index}_${version}`, 'client_assignment', assignmentId,
                    version, JSON.stringify({ dataKeyId, dataKeyVersion: 1 }), OWNER.id,
                    version === 1 ? starts[index] : end, BASE.correlationId,
                  ).run()
                }
              }
            }
          }
          return env.DB.batch(statements)
        },
      }
      await expect(correctAppointmentPayment(await correctionInput(
        appointment, target.id, { db, body: {
          expectedVersion: appointment.version,
          reason: `Wyścig ${corruption}`, replacement: null,
        } },
      ))).rejects.toThrow(/core_directory_invariant_failed/)
      expect(await env.DB.prepare('SELECT version FROM appointments WHERE id=?')
        .bind(appointment.id).first()).toEqual({ version: appointment.version })
      expect(await env.DB.prepare(`SELECT count(*) AS count FROM payment_corrections
        WHERE reversed_entry_id=?`).bind(target.id).first()).toEqual({ count: 0 })
    }
  })

  it('preserves invariant precedence when assignment corruption combines with a correction winner', async () => {
    const created = await seedAppointment()
    const recorded = await recordAppointmentPayment(await paymentInput(created))
    const appointment = recorded.body.data.appointment
    const target = appointment.paymentEntries[0]
    const assignment = await env.DB.prepare(`SELECT id FROM client_assignments
      WHERE client_id=? AND ends_at IS NULL`).bind(appointment.clientId).first()
    let injected = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!injected) {
          injected = true
          await correctAppointmentPayment(await correctionInput(
            appointment, target.id, {
              nowMs: Date.parse(appointment.updatedAt) + 1_000,
              body: { expectedVersion: appointment.version,
                reason: 'Wygrywająca korekta', replacement: null },
            },
          ))
          await env.DB.prepare(`INSERT INTO record_versions
            (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
             changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
            `ver_correction_combined_${++sequence}`, 'client', assignment.id, 99,
            '{}', OWNER.id, new Date(NOW_MS + 500).toISOString(), BASE.correlationId,
          ).run()
        }
        return env.DB.batch(statements)
      },
    }
    let failure
    try {
      await correctAppointmentPayment(await correctionInput(
        appointment, target.id, { db,
          body: { expectedVersion: appointment.version,
            reason: 'Przegrywająca korekta', replacement: null } },
      ))
    } catch (error) { failure = error }
    expect(failure?.message).toMatch(/(?:identity_collision|core_directory_invariant_failed)/)
    expect(failure?.message).not.toBe('NOT_FOUND')
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM payment_corrections
      WHERE reversed_entry_id=?`).bind(target.id).first()).toEqual({ count: 1 })
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM idempotency_records
      WHERE operation='payments.correct' AND resource_id=?`).bind(appointment.clientId).first())
      .toEqual({ count: 1 })
  })

  it('stays within exact correction domain and full-route budgets', async () => {
    const created = await seedAppointment()
    const recorded = await recordAppointmentPayment(await paymentInput(created))
    const appointment = recorded.body.data.appointment
    const target = appointment.paymentEntries[0]
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    await correctAppointmentPayment(await correctionInput(
      appointment, target.id, { db: budget.work, recoveryDb: budget.recovery,
        body: { expectedVersion: appointment.version,
          reason: 'Pomiar budżetu', replacement: null } },
    ))
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 15, remaining: 35, workRemaining: 27,
      totalLimit: 50, recoveryReserve: 8,
    })

    const httpCreated = await seedAppointment()
    const httpRecorded = await recordAppointmentPayment(await paymentInput(httpCreated))
    const httpAppointment = httpRecorded.body.data.appointment
    const httpTarget = httpAppointment.paymentEntries[0]
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
      postPaymentCorrection: async (input) => {
        views = { work: input.db, recovery: input.recoveryDb }
        return postPaymentCorrection(input)
      },
      idFactory: suffixes(`correction_http_${++sequence}`),
      now: () => Date.parse(httpAppointment.updatedAt) + 1_000,
    })
    const response = await app.request(`/api/v1/payments/${httpTarget.id}/corrections`, {
      method: 'POST', headers: {
        origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
        'idempotency-key': `correction-http-${sequence}-key`, 'x-csrf-token': 'valid',
        'x-correlation-id': BASE.correlationId,
      }, body: JSON.stringify({ expectedVersion: httpAppointment.version,
        reason: 'Korekta HTTP', replacement: null }),
    })
    expect(response.status).toBe(200)
    expect(areSiblingD1QueryBudgetViews(views.work, views.recovery)).toBe(true)
    expect(usageForD1QueryBudgetViews(views.work, views.recovery)).toEqual({
      used: 15, remaining: 35, workRemaining: 27,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

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

  it('rejects every malformed authenticated payment replay DTO and correction graph', async () => {
    const appointment = await seedAppointment()
    const input = await paymentInput(appointment)
    const result = await recordAppointmentPayment(input)
    const original = result.body.data.appointment
    const correctedAt = original.updatedAt
    const correctedPrefix = [
      { id: 'pay_replay_z', amountGrosze: 1, method: 'cash',
        receivedAt: '2027-01-15T08:20:00.000Z', correctedAt,
        replacementEntryId: null },
      { id: 'pay_replay_a', amountGrosze: 1, method: 'cash',
        receivedAt: '2027-01-15T08:10:00.000Z', correctedAt,
        replacementEntryId: null },
    ]
    const cycle = [
      { ...correctedPrefix[1], id: 'pay_replay_cycle_a',
        replacementEntryId: 'pay_replay_cycle_b' },
      { ...correctedPrefix[0], id: 'pay_replay_cycle_b',
        replacementEntryId: 'pay_replay_cycle_a' },
    ]
    const malformedAppointments = [
      { ...original, clientId: 'not-a-client' },
      { ...original, specialistId: 'not-a-specialist' },
      { ...original, startsAt: original.endsAt },
      { ...original, timeZone: 'UTC' },
      { ...original, location: ' bad ' },
      { ...original, createdAt: '2027-01-15T09:00:00Z' },
      { ...original, updatedAt: original.createdAt },
      { ...original, charge: { ...original.charge, serviceId: 'konsultacja' } },
      { ...original, charge: { ...original.charge, id: 'not-a-charge' } },
      { ...original, charge: { ...original.charge, version: 258 } },
      { ...original, charge: { ...original.charge, version: Number.MAX_SAFE_INTEGER } },
      { ...original, version: input.body.expectedVersion + 2 },
      { ...original, paymentEntries: [...correctedPrefix, ...original.paymentEntries] },
      { ...original, paymentEntries: [{ ...correctedPrefix[0],
        replacementEntryId: 'pay_replay_missing' }, ...original.paymentEntries] },
      { ...original, paymentEntries: [...cycle, ...original.paymentEntries] },
      { ...original, payment: { ...original.payment, collectedGrosze: 9_999 } },
    ]
    for (const malformed of malformedAppointments) {
      const db = await withEncryptedPaymentReplay(
        appointment.clientId, input.idempotencyKey,
        { status: 200, body: { data: { appointment: malformed } } },
      )
      await expect(recordAppointmentPayment({ ...input, db, idFactory: vi.fn() }))
        .rejects.toThrow('CRYPTO_FAILURE')
    }
    for (const expectedVersion of [4_096, Number.MAX_SAFE_INTEGER]) {
      const request = { ...input.body, expectedVersion }
      const requestDigest = await digestRecordPaymentRequest(input.appointmentId, request)
      const malformed = { ...original,
        version: expectedVersion === 4_096 ? 4_097 : Number.MAX_SAFE_INTEGER }
      const db = await withEncryptedPaymentReplay(
        appointment.clientId, input.idempotencyKey,
        { status: 200, body: { data: { appointment: malformed } } }, requestDigest,
      )
      await expect(recordAppointmentPayment({ ...input, db, body: request,
        idFactory: vi.fn() })).rejects.toThrow('CRYPTO_FAILURE')
    }
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
    const boundary = await seedContiguousPayments(boundaryAppointment, 999)
    const result = await recordAppointmentPayment(await paymentInput(boundary, {
      nowMs: NOW_MS + 3_000,
      body: { ...BODY, expectedVersion: 1_000, amountGrosze: 1 },
    }))
    expect(result.body.data.appointment.paymentEntries).toHaveLength(1_000)
    expect(result.body.data.appointment.version).toBe(1_001)
    const idFactory = vi.fn()
    await expect(recordAppointmentPayment(await paymentInput(
      result.body.data.appointment, {
        nowMs: NOW_MS + 4_000, idFactory,
        body: { ...BODY, expectedVersion: 1_001, amountGrosze: 1 },
      },
    ))).rejects.toThrow('PAYMENT_AMOUNT_CONFLICT')
    expect(idFactory).not.toHaveBeenCalled()

    await env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      `ver_contiguous_gap_${sequence}`, 'appointment', boundary.id, 1_003, '{}',
      OWNER.id, new Date(NOW_MS + 4_001).toISOString(), BASE.correlationId,
    ).run()
    await expect(recordAppointmentPayment(await paymentInput(
      result.body.data.appointment, {
        nowMs: NOW_MS + 5_000, idFactory: vi.fn(),
        body: { ...BODY, expectedVersion: 1_001, amountGrosze: 1 },
      },
    ))).rejects.toThrow('NOT_FOUND')
  })

  it('treats 4,096 as terminal and rejects a valid-looking contiguous 4,097th sentinel', async () => {
    const created = await seedAppointment()
    const retained = await seedContiguousAppointmentVersions(created, 4_096)
    const idFactory = vi.fn()
    await expect(recordAppointmentPayment(await paymentInput(retained.appointment, {
      nowMs: NOW_MS + 10_000, idFactory,
      body: { ...BODY, expectedVersion: 4_096, amountGrosze: 1 },
    }))).rejects.toThrow('NOT_FOUND')
    expect(idFactory).not.toHaveBeenCalled()
    expect(await env.DB.prepare('SELECT max(version) AS version FROM record_versions WHERE entity_id=?')
      .bind(created.id).first()).toEqual({ version: 4_096 })

    const sentinelAt = new Date(NOW_MS + 4_097).toISOString()
    const sentinel = {
      cancelledAt: null, clientId: created.clientId, createdAt: created.createdAt,
      endsAt: created.endsAt, id: created.id, location: created.location,
      paymentAggregate: { collectedGrosze: 0,
        outstandingGrosze: created.charge.expectedAmountGrosze, status: 'unpaid' },
      schema: 'appointment.v1', serviceId: created.serviceId, source: 'panel',
      specialistId: created.specialistId, startsAt: created.startsAt,
      status: created.status, timeZone: 'Europe/Warsaw', updatedAt: sentinelAt,
      version: 4_097,
    }
    const envelope = await encryptForScope(retained.keyring, retained.dataKey, {
      expectedScope: retained.scope, recordId: created.id, field: 'record_version',
      plaintext: JSON.stringify(sentinel),
    })
    await env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      `ver_bound_sentinel_${sequence}`, 'appointment', created.id, 4_097,
      JSON.stringify(envelope), OWNER.id, sentinelAt, BASE.correlationId,
    ).run()
    await expect(recordAppointmentPayment(await paymentInput(retained.appointment, {
      nowMs: NOW_MS + 11_000, idFactory: vi.fn(),
      body: { ...BODY, expectedVersion: 4_096, amountGrosze: 1 },
    }))).rejects.toThrow('NOT_FOUND')
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM record_versions
      WHERE entity_id=? AND version BETWEEN 1 AND 4097`).bind(created.id).first()).count)
      .toBe(4_097)
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

    for (const kind of ['version', 'audit']) {
      const target = await seedAppointment()
      const existing = kind === 'version'
        ? (await env.DB.prepare('SELECT id FROM record_versions ORDER BY id LIMIT 1').first()).id
        : (await env.DB.prepare('SELECT id FROM audit_events ORDER BY id LIMIT 1').first()).id
      const suffix = existing.slice(4)
      const generatedIds = kind === 'version'
        ? [`payment_${kind}_${sequence}`, suffix, `payment_${kind}_audit_${sequence}`]
        : [`payment_${kind}_${sequence}`, `payment_${kind}_version_${sequence}`, suffix]
      await expect(recordAppointmentPayment(await paymentInput(target, {
        idFactory: () => generatedIds.shift(),
      }))).rejects.toThrow(/identity_collision/)
      expect(await env.DB.prepare('SELECT count(*) AS count FROM payment_entries WHERE appointment_id=?')
        .bind(target.id).first()).toEqual({ count: 0 })
    }
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

  it('preserves invariant failure precedence when an overpay race combines retained corruption', async () => {
    const appointment = await seedAppointment()
    let injected = false
    let corrupt = false
    const db = {
      prepare(sql) {
        const prepared = env.DB.prepare(sql)
        if (!sql.includes('FROM client_assignments AS assignment')) return prepared
        return { bind(...bindings) {
          const bound = prepared.bind(...bindings)
          return { async all() {
            const result = await bound.all()
            return corrupt ? { ...result, results: result.results.map((row, index) => (
              index === 0 ? { ...row, record_version_type: 'client' } : row
            )) } : result
          } }
        } }
      },
      async batch(statements) {
        if (!injected) {
          injected = true
          await recordAppointmentPayment({
            db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
            nowMs: NOW_MS + 10_000, correlationId: BASE.correlationId,
            idFactory: suffixes(`payment_combined_winner_${++sequence}`),
            appointmentId: appointment.id,
            body: { ...BODY, expectedVersion: 1, amountGrosze: 12_000 },
            idempotencyKey: `payment-combined-winner-${sequence}`,
          })
          corrupt = true
        }
        return env.DB.batch(statements)
      },
    }
    const error = await recordAppointmentPayment(await paymentInput(appointment, {
      db, nowMs: NOW_MS + 10_000,
      body: { ...BODY, expectedVersion: 1, amountGrosze: 12_000 },
      idempotencyKey: `payment-combined-loser-${sequence}`,
    })).catch((caught) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(/^D1_ERROR:/)
    expect(error.message).not.toBe('PAYMENT_AMOUNT_CONFLICT')
    expect(await env.DB.prepare('SELECT count(*) AS count FROM payment_entries WHERE appointment_id=?')
      .bind(appointment.id).first()).toEqual({ count: 1 })
  })

  it('recovers an injected same-key winner with one ordinary proof and exactly two reserve reads', async () => {
    const appointment = await seedAppointment()
    const key = `payment-injected-winner-${sequence}`
    const body = { ...BODY, expectedVersion: 1, amountGrosze: 5_000 }
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
          winner = await recordAppointmentPayment({
            db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
            nowMs: NOW_MS + 10_000, correlationId: BASE.correlationId,
            idFactory: suffixes(`payment_injected_winner_${++sequence}`),
            appointmentId: appointment.id, body, idempotencyKey: key,
          })
        }
        return budget.work.batch(statements)
      },
    }
    const loser = await recordAppointmentPayment({
      db, recoveryDb, actor: OWNER, keyring: await ring(), nowMs: NOW_MS + 10_000,
      correlationId: BASE.correlationId,
      idFactory: suffixes(`payment_injected_loser_${++sequence}`),
      appointmentId: appointment.id, body, idempotencyKey: key,
    })
    expect(loser).toEqual(winner)
    expect(recoveryReads).toBe(2)
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 17, remaining: 33, workRemaining: 25,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('fails closed for missing keys, wrong stored scope, retained corruption, and cancellation', async () => {
    const missingKeyAppointment = await seedAppointment()
    const missingInput = await paymentInput(missingKeyAppointment)
    await recordAppointmentPayment(missingInput)
    const missingKeyDb = { prepare(sql) {
      if (sql.includes('FROM data_keys')) return {
        bind() { return { first: async () => null } },
      }
      return env.DB.prepare(sql)
    }, batch: (statements) => env.DB.batch(statements) }
    await expect(recordAppointmentPayment({ ...missingInput, db: missingKeyDb,
      idFactory: vi.fn() })).rejects.toThrow('CRYPTO_FAILURE')

    const wrongScopeAppointment = await seedAppointment()
    const wrongInput = await paymentInput(wrongScopeAppointment)
    await recordAppointmentPayment(wrongInput)
    const wrongScopeDb = { prepare(sql) {
      const prepared = env.DB.prepare(sql)
      if (!sql.includes('SELECT request_hash,resource_type,resource_id,response_envelope')) {
        return prepared
      }
      return { bind(...bindings) {
        const bound = prepared.bind(...bindings)
        return { async first() {
          const row = await bound.first()
          return { ...row, resource_id: missingKeyAppointment.clientId }
        } }
      } }
    }, batch: (statements) => env.DB.batch(statements) }
    await expect(recordAppointmentPayment({ ...wrongInput, db: wrongScopeDb,
      idFactory: vi.fn() }))
      .rejects.toThrow('CRYPTO_FAILURE')

    const crossType = await seedAppointment()
    await env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      `ver_payment_cross_type_${++sequence}`, 'client', crossType.id, 99, '{}',
      OWNER.id, new Date(NOW_MS + 1).toISOString(), BASE.correlationId,
    ).run()
    await expect(recordAppointmentPayment(await paymentInput(crossType, {
      idFactory: vi.fn(),
    }))).rejects.toThrow('NOT_FOUND')

    const cancelled = await seedAppointment('scheduled')
    await cancelAppointment({
      db: env.DB, recoveryDb: env.DB, actor: OWNER, keyring: await ring(),
      nowMs: NOW_MS + 1_000, correlationId: BASE.correlationId,
      idFactory: suffixes(`payment_cancelled_${++sequence}`), appointmentId: cancelled.id,
      body: { expectedVersion: 1 }, idempotencyKey: `payment-cancelled-${sequence}-key`,
    })
    await expect(recordAppointmentPayment(await paymentInput(cancelled, {
      idFactory: vi.fn(),
    }))).rejects.toThrow('NOT_FOUND')
  })

  it('authenticates every retained client, assignment, appointment, charge, and correction row', async () => {
    const cases = [
      ['FROM record_versions WHERE entity_id=?\n   ORDER BY version,id LIMIT 257',
        (row) => ({ ...row, snapshot_envelope: '{}' })],
      ['FROM client_assignments AS assignment',
        (row) => ({ ...row, record_version_type: 'client' })],
      ['FROM record_versions WHERE entity_id=? ORDER BY version,id LIMIT 4097',
        (row) => ({ ...row, entity_type: 'client' })],
    ]
    for (const [needle, mutate] of cases) {
      const appointment = await seedAppointment()
      const idFactory = vi.fn()
      await expect(recordAppointmentPayment(await paymentInput(appointment, {
        db: withCorruptedAll(needle, mutate), idFactory,
      }))).rejects.toThrow('NOT_FOUND')
      expect(idFactory).not.toHaveBeenCalled()
    }

    const chargeAppointment = await seedAppointment()
    const chargeDb = { prepare(sql) {
      const prepared = env.DB.prepare(sql)
      if (!sql.includes('LIMIT 258')) return prepared
      return { bind(...bindings) {
        const bound = prepared.bind(...bindings)
        return { async all() {
          const result = await bound.all()
          return { ...result, results: result.results.map((row, index) => (
            index === 0 ? { ...row, entity_type: 'client' } : row
          )) }
        } }
      } }
    }, batch: (statements) => env.DB.batch(statements) }
    await expect(recordAppointmentPayment(await paymentInput(chargeAppointment, {
      db: chargeDb, idFactory: vi.fn(),
    }))).rejects.toThrow('NOT_FOUND')

    const correctionAppointment = await seedAppointment()
    const correctedAt = new Date(NOW_MS + 500).toISOString()
    const marker = sequence
    const corrected = await seedPaymentGraph(correctionAppointment, [
      { id: `pay_corrupt_reason_${marker}`, amountGrosze: 1, method: 'cash',
        receivedAt: BODY.receivedAt, createdAt: correctedAt },
    ], [{ id: `cor_corrupt_reason_${marker}`,
      reversedEntryId: `pay_corrupt_reason_${marker}`,
      replacementEntryId: null, createdAt: correctedAt }])
    await expect(recordAppointmentPayment(await paymentInput(corrected, {
      db: withCorruptedAll('FROM payment_entries AS payment',
        (row) => ({ ...row, reason_envelope: '{}' })),
      nowMs: NOW_MS + 2_000, body: { ...BODY, expectedVersion: 2, amountGrosze: 1 },
      idFactory: vi.fn(),
    }))).rejects.toThrow('NOT_FOUND')
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
    expect(usageForD1QueryBudgetViews(views.work, views.recovery)).toEqual({
      used: 14, remaining: 36, workRemaining: 28,
      totalLimit: 50, recoveryReserve: 8,
    })
  })
})
