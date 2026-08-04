import { encodeBase64Url } from '../security/encoding.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectStoredScopeIdempotency,
  recoverStoredScopeIdempotencyAfterCollision,
} from '../db/unit-of-work.js'
import { isD1CoreDirectoryInvariantFailure, isD1IdentityCollision } from '../db/errors.js'
import { auditEventStatement } from '../audit/events.js'
import { createOwnershipCapabilityBoundary } from './crypto.js'
import { createRecordVersionBuilder } from './versions.js'
import {
  appointmentLedgerDto,
  loadAuthenticatedAppointmentLedger,
  paymentAggregateFor,
} from './appointments.js'
import {
  isAppointmentId,
  isAuditId,
  isOpaqueId,
  isPaymentId,
  isVersionId,
} from '../../src/core-records.js'

const BODY_KEYS = Object.freeze(['expectedVersion', 'amountGrosze', 'method', 'receivedAt'])
const METHODS = Object.freeze(['cash', 'card', 'transfer', 'monthly'])
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'appointmentId', 'body', 'idempotencyKey',
])
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPERATION = 'appointments.payment'
const DAY_MS = 86_400_000
const ownership = createOwnershipCapabilityBoundary()
const versionBuilder = createRecordVersionBuilder(ownership.consumer)

const validation = (field) => { throw new TypeError(`VALIDATION_FAILED/${field}`) }
const notFound = () => { throw new Error('NOT_FOUND') }
const cryptoFailure = () => { throw new Error('CRYPTO_FAILURE') }
const versionConflict = (currentVersion) => {
  const error = new Error('VERSION_CONFLICT')
  error.details = Object.freeze({ currentVersion })
  throw error
}

const captureExact = (value, keys, fail = () => validation('body')) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length || !keys.every((key) => actual.includes(key))) fail()
    const result = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail()
      result[key] = descriptor.value
    }
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof TypeError && /^VALIDATION_FAILED\//.test(error.message)) throw error
    fail()
  }
}

const canonicalInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

export function validateRecordPaymentBody(value) {
  const body = captureExact(value, BODY_KEYS)
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    validation('expectedVersion')
  }
  if (!Number.isSafeInteger(body.amountGrosze)
    || body.amountGrosze < 1 || body.amountGrosze > 1_000_000) validation('amountGrosze')
  if (!METHODS.includes(body.method)) validation('method')
  if (!canonicalInstant(body.receivedAt)) validation('receivedAt')
  return body
}

const digestNormalized = async (appointmentId, body) => {
  const encoded = new TextEncoder().encode(JSON.stringify({
    body: {
      amountGrosze: body.amountGrosze,
      expectedVersion: body.expectedVersion,
      method: body.method,
      receivedAt: body.receivedAt,
    },
    route: `POST /api/v1/appointments/${appointmentId}/payments`,
  }))
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
    return encodeBase64Url(digest)
  } finally {
    encoded.fill(0)
    digest?.fill(0)
  }
}

export async function digestRecordPaymentRequest(appointmentId, value) {
  if (typeof appointmentId !== 'string' || !isAppointmentId(appointmentId)) {
    validation('appointmentId')
  }
  return digestNormalized(appointmentId, validateRecordPaymentBody(value))
}

const captureCommand = (input) => {
  const command = captureExact(input, INPUT_KEYS)
  if (!command.db?.prepare || !command.db?.batch || !command.recoveryDb?.prepare
    || !command.keyring || typeof command.idFactory !== 'function'
    || !Number.isSafeInteger(command.nowMs) || command.nowMs < 0
    || typeof command.correlationId !== 'string' || !CORRELATION_ID.test(command.correlationId)
    || typeof command.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey)) validation('body')
  if (typeof command.appointmentId !== 'string'
    || !isAppointmentId(command.appointmentId)) validation('appointmentId')
  return Object.freeze({ ...command, body: validateRecordPaymentBody(command.body) })
}

const actorFact = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('FORBIDDEN')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actor = {}
    for (const key of ['id', 'role', 'specialistId']) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('FORBIDDEN')
      actor[key] = descriptor.value
    }
    if (typeof actor.id !== 'string' || !STAFF_ID.test(actor.id)
      || !['owner', 'coordinator', 'specialist'].includes(actor.role)
      || (actor.specialistId !== null && typeof actor.specialistId !== 'string')
      || (actor.role === 'specialist' && actor.specialistId === null)) {
      throw new Error('FORBIDDEN')
    }
    return Object.freeze(actor)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') throw error
    throw new Error('FORBIDDEN')
  }
}

const generated = (factory, prefix, predicate, used) => {
  let suffix
  try { suffix = factory() } catch { throw new Error('INTERNAL_ERROR') }
  if (typeof suffix !== 'string' || !isOpaqueId(suffix)) throw new Error('INTERNAL_ERROR')
  const id = `${prefix}_${suffix}`
  if (!predicate(id) || used.has(id)) throw new Error('INTERNAL_ERROR')
  used.add(id)
  return id
}

const validateReplay = (value, appointmentId, request) => {
  const replay = captureExact(value, ['status', 'body'], cryptoFailure)
  const body = captureExact(replay.body, ['data'], cryptoFailure)
  const data = captureExact(body.data, ['appointment'], cryptoFailure)
  const appointment = captureExact(data.appointment, [
    'id', 'clientId', 'specialistId', 'serviceId', 'startsAt', 'endsAt', 'timeZone',
    'location', 'status', 'source', 'version', 'cancelledAt', 'createdAt', 'updatedAt',
    'charge', 'payment', 'paymentEntries',
  ], cryptoFailure)
  const charge = captureExact(appointment.charge, [
    'id', 'serviceId', 'expectedAmountGrosze', 'currency', 'version',
  ], cryptoFailure)
  const payment = captureExact(appointment.payment, [
    'status', 'collectedGrosze', 'outstandingGrosze', 'latestMethod', 'latestReceivedAt',
  ], cryptoFailure)
  if (replay.status !== 200 || appointment.id !== appointmentId
    || appointment.version !== request.expectedVersion + 1
    || !['completed', 'noshow'].includes(appointment.status)
    || appointment.cancelledAt !== null || appointment.source !== 'panel'
    || charge.currency !== 'PLN' || !Number.isSafeInteger(charge.expectedAmountGrosze)
    || charge.expectedAmountGrosze < 1 || charge.expectedAmountGrosze > 1_000_000
    || !Array.isArray(appointment.paymentEntries) || appointment.paymentEntries.length < 1
    || appointment.paymentEntries.length > 1_000) cryptoFailure()
  const ids = new Set()
  let collected = 0
  let latest = null
  let matching = 0
  const entries = appointment.paymentEntries.map((candidate) => {
    const entry = captureExact(candidate, [
      'id', 'amountGrosze', 'method', 'receivedAt', 'correctedAt', 'replacementEntryId',
    ], cryptoFailure)
    if (!isPaymentId(entry.id) || ids.has(entry.id)
      || !Number.isSafeInteger(entry.amountGrosze) || entry.amountGrosze < 1
      || entry.amountGrosze > 1_000_000 || !METHODS.includes(entry.method)
      || !canonicalInstant(entry.receivedAt)
      || (entry.correctedAt !== null && !canonicalInstant(entry.correctedAt))
      || (entry.replacementEntryId !== null && !isPaymentId(entry.replacementEntryId))) {
      cryptoFailure()
    }
    if (latest && (latest.receivedAt > entry.receivedAt
      || (latest.receivedAt === entry.receivedAt && latest.id >= entry.id))) cryptoFailure()
    ids.add(entry.id)
    if (entry.correctedAt === null) {
      collected += entry.amountGrosze
      latest = entry
      if (entry.amountGrosze === request.amountGrosze && entry.method === request.method
        && entry.receivedAt === request.receivedAt) matching += 1
    }
    return Object.freeze(entry)
  })
  if (!Number.isSafeInteger(collected) || collected > charge.expectedAmountGrosze
    || matching < 1 || payment.collectedGrosze !== collected
    || payment.outstandingGrosze !== charge.expectedAmountGrosze - collected
    || payment.status !== (collected === charge.expectedAmountGrosze ? 'paid' : 'partial')
    || payment.latestMethod !== latest?.method
    || payment.latestReceivedAt !== latest?.receivedAt) cryptoFailure()
  return Object.freeze({ status: 200, body: Object.freeze({ data: Object.freeze({
    appointment: appointmentLedgerDto(appointment, charge, Object.freeze({
      ...payment, entries: Object.freeze(entries),
    })),
  }) }) })
}

const conditionalVersionStatement = (db, version, appointment) => db.prepare(
  `INSERT INTO record_versions
   (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
    changed_at,correlation_id)
   SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (
     SELECT 1 FROM appointments WHERE id=? AND version=? AND updated_at=?)`
).bind(
  version.row.id, version.row.entity_type, version.row.entity_id, version.row.version,
  version.row.snapshot_envelope, version.row.changed_by_staff_id,
  version.row.changed_at, version.row.correlation_id,
  appointment.id, appointment.version, appointment.updatedAt,
)

const paymentGuard = (db, values) => db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'appointment_payment_postcondition' WHERE NOT (
     EXISTS (SELECT 1 FROM payment_entries WHERE id=? AND appointment_id=?
       AND amount_grosze=? AND method=? AND received_at=? AND recorded_by_staff_id=?
       AND external_reference_envelope IS NULL AND created_at=?)
     AND EXISTS (SELECT 1 FROM appointments WHERE id=? AND client_id=?
       AND specialist_id=? AND service_id=? AND starts_at=? AND ends_at=?
       AND time_zone='Europe/Warsaw' AND location IS ? AND status=? AND source='panel'
       AND version=? AND cancelled_at IS NULL AND created_at=? AND updated_at=?)
     AND EXISTS (SELECT 1 FROM session_charges WHERE id=? AND appointment_id=?
       AND service_id=? AND expected_amount_grosze=? AND currency='PLN' AND version=?
       AND created_at=? AND updated_at=?)
     AND (SELECT count(*) FROM session_charges WHERE appointment_id=?)=1
     AND (SELECT count(*) FROM payment_entries WHERE appointment_id=?)=?
     AND NOT EXISTS (SELECT 1 FROM payment_entries AS payment WHERE payment.appointment_id=?
       AND (payment.amount_grosze NOT BETWEEN 1 AND 1000000
         OR payment.method NOT IN ('cash','card','transfer','monthly')
         OR payment.external_reference_envelope IS NOT NULL))
     AND (SELECT coalesce(sum(payment.amount_grosze),0) FROM payment_entries AS payment
       WHERE payment.appointment_id=? AND NOT EXISTS (SELECT 1 FROM payment_corrections
         WHERE reversed_entry_id=payment.id))=?
     AND NOT EXISTS (SELECT 1 FROM payment_corrections AS correction
       JOIN payment_entries AS payment ON payment.id=correction.reversed_entry_id
       WHERE payment.appointment_id=? AND (
         correction.replacement_entry_id=correction.reversed_entry_id
         OR NOT json_valid(correction.reason_envelope)
         OR json_extract(CASE WHEN json_valid(correction.reason_envelope)
              THEN correction.reason_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
         OR json_extract(CASE WHEN json_valid(correction.reason_envelope)
              THEN correction.reason_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1
         OR (correction.replacement_entry_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM payment_entries AS replacement
           WHERE replacement.id=correction.replacement_entry_id
             AND replacement.appointment_id=payment.appointment_id))))
     AND EXISTS (SELECT 1 FROM payment_entries AS latest
       WHERE latest.id=? AND latest.appointment_id=? AND latest.method=?
         AND latest.received_at=? AND NOT EXISTS (SELECT 1 FROM payment_corrections
           WHERE reversed_entry_id=latest.id)
         AND NOT EXISTS (SELECT 1 FROM payment_entries AS later
           WHERE later.appointment_id=latest.appointment_id
             AND NOT EXISTS (SELECT 1 FROM payment_corrections
               WHERE reversed_entry_id=later.id)
             AND (later.received_at>latest.received_at
               OR (later.received_at=latest.received_at AND later.id>latest.id))))
     AND EXISTS (SELECT 1 FROM record_versions WHERE id=? AND entity_type='appointment'
       AND entity_id=? AND version=? AND changed_by_staff_id=? AND changed_at=?
       AND correlation_id=? AND json_extract(snapshot_envelope,'$.dataKeyId')=?)
     AND NOT EXISTS (SELECT 1 FROM record_versions WHERE entity_id=?
       AND entity_type!='appointment')
     AND (SELECT count(*) FROM record_versions
       WHERE entity_type='appointment' AND entity_id=?)=?
     AND (SELECT min(version) FROM record_versions
       WHERE entity_type='appointment' AND entity_id=?)=1
     AND (SELECT max(version) FROM record_versions
       WHERE entity_type='appointment' AND entity_id=?)=?
     AND (SELECT count(*) FROM record_versions
       WHERE entity_type='session_charge' AND entity_id=?)=?
     AND (SELECT min(version) FROM record_versions
       WHERE entity_type='session_charge' AND entity_id=?)=1
     AND (SELECT max(version) FROM record_versions
       WHERE entity_type='session_charge' AND entity_id=?)=?
     AND EXISTS (SELECT 1 FROM audit_events WHERE id=? AND actor_staff_id=?
       AND action='payment.recorded' AND entity_type='appointment' AND entity_id=?
       AND result='success' AND reason_envelope IS NULL AND correlation_id=?
       AND metadata_json=?)
     AND EXISTS (SELECT 1 FROM idempotency_records WHERE actor_id=? AND operation=?
       AND idempotency_key=? AND resource_type='client' AND resource_id=?
       AND json_extract(request_hash,'$.dataKeyId')=?
       AND json_extract(response_envelope,'$.dataKeyId')=?)
     AND EXISTS (SELECT 1 FROM data_keys WHERE id=? AND scope_type='client'
       AND scope_id=? AND purpose='identity' AND dek_version=1 AND retired_at IS NULL)
     AND EXISTS (SELECT 1 FROM clients WHERE id=? AND identity_envelope=?
       AND status IN ('active','paused') AND archived_at IS NULL AND version=?)
     AND (SELECT count(*) FROM record_versions
       WHERE entity_type='client' AND entity_id=?)=?
     AND NOT EXISTS (SELECT 1 FROM client_assignments AS retained
       WHERE retained.client_id=? AND (
         (SELECT count(*) FROM record_versions AS history
           WHERE history.entity_type='client_assignment'
             AND history.entity_id=retained.id)!=retained.version
         OR (SELECT min(version) FROM record_versions AS history
           WHERE history.entity_type='client_assignment'
             AND history.entity_id=retained.id)!=1
         OR (SELECT max(version) FROM record_versions AS history
           WHERE history.entity_type='client_assignment'
             AND history.entity_id=retained.id)!=retained.version))
     AND (SELECT count(*) FROM client_assignments WHERE client_id=?
       AND specialist_id=? AND starts_at<=? AND (ends_at IS NULL OR ?<ends_at))=1
     AND NOT EXISTS (SELECT 1 FROM record_versions WHERE entity_id=?
       AND entity_type!='session_charge')
     AND NOT EXISTS (SELECT 1 FROM payment_entries WHERE id IN (?,?) AND id!=?)
     AND NOT EXISTS (SELECT 1 FROM record_versions WHERE id IN (?,?) OR entity_id=?)
     AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id IN (?,?))
   )`
).bind(
  values.paymentId, values.appointment.id, values.body.amountGrosze, values.body.method,
  values.body.receivedAt, values.actorId, values.now,
  values.appointment.id, values.client.id, values.appointment.specialistId,
  values.appointment.serviceId, values.appointment.startsAt, values.appointment.endsAt,
  values.appointment.location, values.appointment.status, values.appointment.version,
  values.appointment.createdAt, values.now,
  values.charge.id, values.appointment.id, values.charge.serviceId,
  values.charge.expectedAmountGrosze, values.charge.version,
  values.charge.createdAt, values.charge.updatedAt, values.appointment.id,
  values.appointment.id, values.entryCount, values.appointment.id,
  values.appointment.id, values.collectedGrosze,
  values.appointment.id, values.dataKeyId,
  values.latest.id, values.appointment.id, values.latest.method, values.latest.receivedAt,
  values.versionId, values.appointment.id, values.appointment.version,
  values.actorId, values.now, values.correlationId, values.dataKeyId,
  values.appointment.id,
  values.appointment.id, values.appointment.version,
  values.appointment.id, values.appointment.id, values.appointment.version,
  values.charge.id, values.charge.version,
  values.charge.id, values.charge.id, values.charge.version,
  values.auditId, values.actorId, values.appointment.id, values.correlationId,
  JSON.stringify({ appointmentVersion: values.appointment.version,
    paymentEntryId: values.paymentId }),
  values.actorId, OPERATION, values.idempotencyKey, values.client.id,
  values.dataKeyId, values.dataKeyId,
  values.dataKeyId, values.client.id,
  values.client.id, values.client.identityEnvelope, values.client.version,
  values.client.id, values.client.version, values.client.id,
  values.client.id, values.appointment.specialistId, values.appointment.startsAt,
  values.appointment.startsAt, values.charge.id,
  values.versionId, values.auditId, values.paymentId,
  values.paymentId, values.auditId, values.paymentId,
  values.paymentId, values.versionId,
)

const collisionProof = (db, values) => db.prepare(
  `SELECT CASE WHEN EXISTS (SELECT 1 FROM idempotency_records
       WHERE actor_id=? AND operation=? AND idempotency_key=?) THEN 1 ELSE 0 END AS stored,
   CASE WHEN EXISTS (SELECT 1 FROM payment_entries WHERE id=?)
       OR EXISTS (SELECT 1 FROM record_versions WHERE id=?)
       OR EXISTS (SELECT 1 FROM audit_events WHERE id=?) THEN 1 ELSE 0 END AS generated_collision`
).bind(
  values.actorId, OPERATION, values.idempotencyKey,
  values.paymentId, values.versionId, values.auditId,
).first()

const reproveRace = async (command, actor, prior, originalError) => {
  let fresh
  try { fresh = await loadAuthenticatedAppointmentLedger(command, actor) } catch {
    throw originalError
  }
  const onlyPaymentChanged = fresh.appointment.version > prior.appointment.version
    && fresh.appointment.clientId === prior.appointment.clientId
    && fresh.appointment.specialistId === prior.appointment.specialistId
    && fresh.appointment.serviceId === prior.appointment.serviceId
    && fresh.appointment.startsAt === prior.appointment.startsAt
    && fresh.appointment.endsAt === prior.appointment.endsAt
    && fresh.appointment.status === prior.appointment.status
    && fresh.charge.id === prior.charge.id
    && fresh.charge.version === prior.charge.version
    && fresh.charge.expectedAmountGrosze === prior.charge.expectedAmountGrosze
  if (onlyPaymentChanged
    && fresh.payment.collectedGrosze + command.body.amountGrosze
      > fresh.charge.expectedAmountGrosze) throw new Error('PAYMENT_AMOUNT_CONFLICT')
  if (fresh.appointment.version !== prior.appointment.version) {
    versionConflict(fresh.appointment.version)
  }
  if (!['completed', 'noshow'].includes(fresh.appointment.status)
    || fresh.payment.collectedGrosze + command.body.amountGrosze
      > fresh.charge.expectedAmountGrosze) throw new Error('PAYMENT_AMOUNT_CONFLICT')
  throw originalError
}

export async function recordAppointmentPayment(input) {
  const command = captureCommand(input)
  const actor = actorFact(command.actor)
  const requestDigest = await digestNormalized(command.appointmentId, command.body)
  const idem = Object.freeze({
    actorId: actor.id, operation: OPERATION,
    idempotencyKey: command.idempotencyKey, requestDigest,
    resourceType: 'client', scopeType: 'client', scopePurpose: 'identity',
  })
  const replay = await inspectStoredScopeIdempotency(command.db, command.keyring, idem)
  if (replay) return validateReplay(replay, command.appointmentId, command.body)
  const current = await loadAuthenticatedAppointmentLedger(command, actor)
  if (command.body.expectedVersion !== current.appointment.version) {
    versionConflict(current.appointment.version)
  }
  if (!['completed', 'noshow'].includes(current.appointment.status)
    || current.payment.entries.length >= 1_000
    || current.payment.collectedGrosze + command.body.amountGrosze
      > current.charge.expectedAmountGrosze) throw new Error('PAYMENT_AMOUNT_CONFLICT')
  let now
  try { now = new Date(command.nowMs).toISOString() } catch { throw new Error('INTERNAL_ERROR') }
  if (now <= current.appointment.updatedAt) throw new Error('INTERNAL_ERROR')
  const used = new Set()
  const paymentId = generated(command.idFactory, 'pay', isPaymentId, used)
  const versionId = generated(command.idFactory, 'ver', isVersionId, used)
  const auditId = generated(command.idFactory, 'aud', isAuditId, used)
  const collectedGrosze = current.payment.collectedGrosze + command.body.amountGrosze
  const aggregate = paymentAggregateFor(
    current.appointment.status, current.charge.expectedAmountGrosze, collectedGrosze,
  )
  const appointment = Object.freeze({
    ...current.appointment, version: current.appointment.version + 1, updatedAt: now,
    paymentAggregate: aggregate,
  })
  const entries = Object.freeze([...current.payment.entries, Object.freeze({
    id: paymentId, amountGrosze: command.body.amountGrosze, method: command.body.method,
    receivedAt: command.body.receivedAt, correctedAt: null, replacementEntryId: null,
  })].sort((left, right) => (left.receivedAt < right.receivedAt ? -1
    : left.receivedAt > right.receivedAt ? 1 : 0)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)))
  const latest = entries.filter(({ correctedAt }) => correctedAt === null).at(-1)
  const responsePayment = Object.freeze({
    ...aggregate, latestMethod: latest.method,
    latestReceivedAt: latest.receivedAt, entries,
  })
  const response = Object.freeze({ status: 200, body: Object.freeze({
    data: Object.freeze({
      appointment: appointmentLedgerDto(appointment, current.charge, responsePayment),
    }),
  }) })
  const appointmentVersion = await versionBuilder.build(command.db, current.context, {
    clientId: current.client.id, versionId, entityType: 'appointment',
    entity: appointment, changedByStaffId: actor.id, changedAt: now,
    correlationId: command.correlationId, ownerFact: null,
  })
  const idempotency = await createIdempotencyStatement(command.db, current.context, {
    actorId: actor.id, operation: OPERATION, idempotencyKey: command.idempotencyKey,
    requestDigest, expectedScope: current.context.scope, resourceType: 'client',
    resourceId: current.client.id, response, createdAt: now,
    expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  })
  const values = Object.freeze({
    appointment, charge: current.charge, client: current.client, body: command.body,
    actorId: actor.id, paymentId, versionId, auditId, now,
    correlationId: command.correlationId, idempotencyKey: command.idempotencyKey,
    dataKeyId: current.context.dataKey.id, collectedGrosze,
    entryCount: entries.length, latest,
  })
  const uow = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  uow.domain(command.db.prepare(
    `INSERT INTO payment_entries
     (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
      external_reference_envelope,created_at)
     SELECT ?,?,?,?,?,?,NULL,? WHERE EXISTS (
       SELECT 1 FROM appointments AS appointment
       JOIN session_charges AS charge ON charge.appointment_id=appointment.id
       WHERE appointment.id=? AND appointment.client_id=?
         AND appointment.specialist_id=? AND appointment.status IN ('completed','noshow')
         AND appointment.version=? AND appointment.cancelled_at IS NULL
         AND charge.id=? AND charge.version=? AND charge.expected_amount_grosze=?
         AND (SELECT count(*) FROM session_charges WHERE appointment_id=appointment.id)=1
         AND (SELECT count(*) FROM payment_entries WHERE appointment_id=appointment.id)<1000
         AND (SELECT coalesce(sum(payment.amount_grosze),0)
           FROM payment_entries AS payment WHERE payment.appointment_id=appointment.id
             AND NOT EXISTS (SELECT 1 FROM payment_corrections
               WHERE reversed_entry_id=payment.id)) + ? <= charge.expected_amount_grosze)`
  ).bind(
    paymentId, appointment.id, command.body.amountGrosze, command.body.method,
    command.body.receivedAt, actor.id, now,
    current.appointment.id, current.client.id, current.appointment.specialistId,
    current.appointment.version, current.charge.id, current.charge.version,
    current.charge.expectedAmountGrosze, command.body.amountGrosze,
  ))
  uow.domain(command.db.prepare(
    `UPDATE appointments SET version=?,updated_at=? WHERE id=? AND client_id=?
       AND version=? AND status IN ('completed','noshow') AND cancelled_at IS NULL
       AND EXISTS (SELECT 1 FROM payment_entries WHERE id=? AND appointment_id=appointments.id)
       AND (SELECT coalesce(sum(payment.amount_grosze),0)
         FROM payment_entries AS payment WHERE payment.appointment_id=appointments.id
           AND NOT EXISTS (SELECT 1 FROM payment_corrections
             WHERE reversed_entry_id=payment.id))=?`
  ).bind(
    appointment.version, now, appointment.id, current.client.id,
    current.appointment.version, paymentId, collectedGrosze,
  ))
  uow.version(conditionalVersionStatement(command.db, appointmentVersion, appointment))
  uow.audit(auditEventStatement(command.db, {
    id: auditId, occurredAt: now, actorStaffId: actor.id,
    action: 'payment.recorded', entityType: 'appointment', entityId: appointment.id,
    result: 'success', correlationId: command.correlationId,
    metadata: { appointmentVersion: appointment.version, paymentEntryId: paymentId },
    reasonEnvelope: null,
  }))
  uow.idempotency(idempotency)
  uow.guard(paymentGuard(command.db, values))
  try {
    await uow.commit()
    return response
  } catch (originalError) {
    if (isD1IdentityCollision(originalError)) {
      let collision
      try {
        collision = captureExact(await collisionProof(command.db, values),
          ['stored', 'generated_collision'], cryptoFailure)
      } catch { throw originalError }
      if (![0, 1].includes(collision.stored)
        || ![0, 1].includes(collision.generated_collision)) throw originalError
      if (collision.stored === 1 && collision.generated_collision === 0) {
        const winner = await recoverStoredScopeIdempotencyAfterCollision(
          command.recoveryDb, command.keyring, idem, originalError,
        )
        return validateReplay(winner, command.appointmentId, command.body)
      }
    }
    if (isD1CoreDirectoryInvariantFailure(originalError)) {
      return reproveRace(command, actor, current, originalError)
    }
    throw originalError
  }
}
