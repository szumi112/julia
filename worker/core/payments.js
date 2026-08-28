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
import { captureAuthorityActor } from '../identity/authority-actor.js'
import { encryptForScope } from '../security/envelope.js'
import {
  APPOINTMENT_VERSION_CAP,
  appointmentLedgerDto,
  CHARGE_VERSION_CAP,
  loadAuthenticatedAppointmentLedger,
  loadAuthenticatedAppointmentLedgerForCorrection,
  paymentAggregateFor,
  retainedAssignmentLedgerPostcondition,
} from './appointments.js'
import {
  assertLocation,
  assertCorrectionReason,
  isAppointmentId,
  isAuditId,
  isChargeId,
  isClientId,
  isCorrectionId,
  isOpaqueId,
  isPaymentId,
  isSpecialistId,
  isVersionId,
} from '../../src/core-records.js'
import { SERVICE_BY_ID } from '../../src/services.js'

const BODY_KEYS = Object.freeze(['expectedVersion', 'amountGrosze', 'method', 'receivedAt'])
const CORRECTION_BODY_KEYS = Object.freeze(['expectedVersion', 'reason', 'replacement'])
const REPLACEMENT_KEYS = Object.freeze(['amountGrosze', 'method', 'receivedAt'])
const METHODS = Object.freeze(['cash', 'card', 'transfer', 'monthly'])
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'appointmentId', 'body', 'idempotencyKey',
])
const CORRECTION_INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'paymentId', 'body', 'idempotencyKey',
])
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPERATION = 'appointments.payment'
const CORRECTION_OPERATION = 'payments.correct'
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

const validateReplacement = (value) => {
  const replacement = captureExact(value, REPLACEMENT_KEYS, () => validation('replacement'))
  if (!Number.isSafeInteger(replacement.amountGrosze)
    || replacement.amountGrosze < 1 || replacement.amountGrosze > 1_000_000) {
    validation('amountGrosze')
  }
  if (!METHODS.includes(replacement.method)) validation('method')
  if (!canonicalInstant(replacement.receivedAt)) validation('receivedAt')
  return replacement
}

export function validateCorrectPaymentBody(value) {
  const body = captureExact(value, CORRECTION_BODY_KEYS)
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1
    || body.expectedVersion >= APPOINTMENT_VERSION_CAP) validation('expectedVersion')
  try { assertCorrectionReason(body.reason) } catch { validation('reason') }
  return Object.freeze({
    expectedVersion: body.expectedVersion,
    reason: body.reason,
    replacement: body.replacement === null ? null : validateReplacement(body.replacement),
  })
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

const digestCorrectionNormalized = async (paymentId, body) => {
  const encoded = new TextEncoder().encode(JSON.stringify({
    body: {
      expectedVersion: body.expectedVersion,
      reason: body.reason,
      replacement: body.replacement,
    },
    route: `POST /api/v1/payments/${paymentId}/corrections`,
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

export async function digestCorrectPaymentRequest(paymentId, value) {
  if (typeof paymentId !== 'string' || !isPaymentId(paymentId)) validation('paymentId')
  return digestCorrectionNormalized(paymentId, validateCorrectPaymentBody(value))
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

const captureCorrectionCommand = (input) => {
  const command = captureExact(input, CORRECTION_INPUT_KEYS)
  if (!command.db?.prepare || !command.db?.batch || !command.recoveryDb?.prepare
    || !command.keyring || typeof command.idFactory !== 'function'
    || !Number.isSafeInteger(command.nowMs) || command.nowMs < 0
    || typeof command.correlationId !== 'string' || !CORRELATION_ID.test(command.correlationId)
    || typeof command.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey)) validation('body')
  if (typeof command.paymentId !== 'string' || !isPaymentId(command.paymentId)) {
    validation('paymentId')
  }
  return Object.freeze({ ...command, body: validateCorrectPaymentBody(command.body) })
}

const actorFact = (value) => {
  const actor = captureAuthorityActor(value)
  if (!actor) throw new Error('FORBIDDEN')
  return actor
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
    || !isAppointmentId(appointment.id) || !isClientId(appointment.clientId)
    || !isSpecialistId(appointment.specialistId) || !SERVICE_BY_ID[appointment.serviceId]
    || !canonicalInstant(appointment.startsAt) || !canonicalInstant(appointment.endsAt)
    || appointment.endsAt <= appointment.startsAt || appointment.timeZone !== 'Europe/Warsaw'
    || !Number.isSafeInteger(appointment.version) || appointment.version < 2
    || request.expectedVersion >= APPOINTMENT_VERSION_CAP
    || appointment.version > APPOINTMENT_VERSION_CAP
    || appointment.version !== request.expectedVersion + 1
    || !['completed', 'noshow'].includes(appointment.status)
    || appointment.cancelledAt !== null || appointment.source !== 'panel'
    || !canonicalInstant(appointment.createdAt) || !canonicalInstant(appointment.updatedAt)
    || appointment.updatedAt <= appointment.createdAt
    || !isChargeId(charge.id) || charge.serviceId !== appointment.serviceId
    || !SERVICE_BY_ID[charge.serviceId] || charge.currency !== 'PLN'
    || !Number.isSafeInteger(charge.version) || charge.version < 1
    || charge.version > CHARGE_VERSION_CAP
    || !Number.isSafeInteger(charge.expectedAmountGrosze)
    || charge.expectedAmountGrosze < 1 || charge.expectedAmountGrosze > 1_000_000
    || !Array.isArray(appointment.paymentEntries) || appointment.paymentEntries.length < 1
    || appointment.paymentEntries.length > 1_000
    || Reflect.ownKeys(Object.getOwnPropertyDescriptors(appointment.paymentEntries)).length
      !== appointment.paymentEntries.length + 1) cryptoFailure()
  try { assertLocation(appointment.location) } catch { cryptoFailure() }
  const ids = new Set()
  let collected = 0
  let latest = null
  let matching = 0
  let previous = null
  const entries = appointment.paymentEntries.map((candidate) => {
    const entry = captureExact(candidate, [
      'id', 'amountGrosze', 'method', 'receivedAt', 'correctedAt', 'replacementEntryId',
    ], cryptoFailure)
    if (!isPaymentId(entry.id) || ids.has(entry.id)
      || !Number.isSafeInteger(entry.amountGrosze) || entry.amountGrosze < 1
      || entry.amountGrosze > 1_000_000 || !METHODS.includes(entry.method)
      || !canonicalInstant(entry.receivedAt)
      || (entry.correctedAt !== null && !canonicalInstant(entry.correctedAt))
      || (entry.replacementEntryId !== null && !isPaymentId(entry.replacementEntryId))
      || (entry.correctedAt === null && entry.replacementEntryId !== null)
      || (entry.correctedAt !== null
        && (entry.correctedAt < appointment.createdAt
          || entry.correctedAt > appointment.updatedAt))) {
      cryptoFailure()
    }
    if (previous && (previous.receivedAt > entry.receivedAt
      || (previous.receivedAt === entry.receivedAt && previous.id >= entry.id))) cryptoFailure()
    ids.add(entry.id)
    previous = entry
    if (entry.correctedAt === null) {
      collected += entry.amountGrosze
      latest = entry
      if (entry.amountGrosze === request.amountGrosze && entry.method === request.method
        && entry.receivedAt === request.receivedAt) matching += 1
    }
    return Object.freeze(entry)
  })
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const replacementTargets = new Set()
  const links = new Map()
  for (const entry of entries) {
    if (entry.replacementEntryId === null) continue
    const replacement = byId.get(entry.replacementEntryId)
    if (!replacement || replacement.id === entry.id
      || replacementTargets.has(replacement.id)
      || (replacement.correctedAt !== null
        && replacement.correctedAt < entry.correctedAt)) cryptoFailure()
    replacementTargets.add(replacement.id)
    links.set(entry.id, replacement.id)
  }
  for (const start of links.keys()) {
    const path = new Set()
    let cursor = start
    while (links.has(cursor)) {
      if (path.has(cursor)) cryptoFailure()
      path.add(cursor)
      cursor = links.get(cursor)
    }
  }
  if (!Number.isSafeInteger(collected) || collected > charge.expectedAmountGrosze
    || matching < 1 || payment.collectedGrosze !== collected
    || payment.outstandingGrosze !== charge.expectedAmountGrosze - collected
    || payment.status !== (collected === charge.expectedAmountGrosze ? 'paid' : 'partial')
    || !METHODS.includes(payment.latestMethod)
    || !canonicalInstant(payment.latestReceivedAt)
    || payment.latestMethod !== latest?.method
    || payment.latestReceivedAt !== latest?.receivedAt) cryptoFailure()
  return Object.freeze({ status: 200, body: Object.freeze({ data: Object.freeze({
    appointment: appointmentLedgerDto(appointment, charge, Object.freeze({
      ...payment, entries: Object.freeze(entries),
    })),
  }) }) })
}

const validateCorrectionReplay = (value, paymentId, request) => {
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
  if (replay.status !== 200 || !isAppointmentId(appointment.id)
    || !isClientId(appointment.clientId) || !isSpecialistId(appointment.specialistId)
    || !SERVICE_BY_ID[appointment.serviceId] || !canonicalInstant(appointment.startsAt)
    || !canonicalInstant(appointment.endsAt) || appointment.endsAt <= appointment.startsAt
    || appointment.timeZone !== 'Europe/Warsaw' || !['completed', 'noshow'].includes(appointment.status)
    || appointment.source !== 'panel' || appointment.cancelledAt !== null
    || appointment.version !== request.expectedVersion + 1
    || appointment.version > APPOINTMENT_VERSION_CAP
    || !canonicalInstant(appointment.createdAt) || !canonicalInstant(appointment.updatedAt)
    || appointment.updatedAt <= appointment.createdAt
    || !isChargeId(charge.id) || charge.serviceId !== appointment.serviceId
    || charge.currency !== 'PLN' || !Number.isSafeInteger(charge.version)
    || charge.version < 1 || charge.version > CHARGE_VERSION_CAP
    || !Number.isSafeInteger(charge.expectedAmountGrosze)
    || charge.expectedAmountGrosze < 1 || charge.expectedAmountGrosze > 1_000_000
    || !Array.isArray(appointment.paymentEntries) || appointment.paymentEntries.length < 1
    || appointment.paymentEntries.length > 1_000
    || Reflect.ownKeys(Object.getOwnPropertyDescriptors(appointment.paymentEntries)).length
      !== appointment.paymentEntries.length + 1) cryptoFailure()
  try { assertLocation(appointment.location) } catch { cryptoFailure() }
  const ids = new Set()
  let previous = null
  let target = null
  let latest = null
  let collected = 0
  const entries = appointment.paymentEntries.map((candidate) => {
    const entry = captureExact(candidate, [
      'id', 'amountGrosze', 'method', 'receivedAt', 'correctedAt', 'replacementEntryId',
    ], cryptoFailure)
    if (!isPaymentId(entry.id) || ids.has(entry.id)
      || !Number.isSafeInteger(entry.amountGrosze) || entry.amountGrosze < 1
      || entry.amountGrosze > 1_000_000 || !METHODS.includes(entry.method)
      || !canonicalInstant(entry.receivedAt)
      || (entry.correctedAt !== null && !canonicalInstant(entry.correctedAt))
      || (entry.replacementEntryId !== null && !isPaymentId(entry.replacementEntryId))
      || (entry.correctedAt === null && entry.replacementEntryId !== null)
      || (entry.correctedAt !== null
        && (entry.correctedAt < appointment.createdAt || entry.correctedAt > appointment.updatedAt))
      || (previous && (previous.receivedAt > entry.receivedAt
        || (previous.receivedAt === entry.receivedAt && previous.id >= entry.id)))) cryptoFailure()
    ids.add(entry.id)
    previous = entry
    if (entry.id === paymentId) target = entry
    if (entry.correctedAt === null) {
      collected += entry.amountGrosze
      latest = entry
    }
    return Object.freeze(entry)
  })
  if (!target || target.correctedAt !== appointment.updatedAt
    || ((request.replacement === null) !== (target.replacementEntryId === null))) cryptoFailure()
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const replacements = new Set()
  const links = new Map()
  for (const entry of entries) {
    if (entry.replacementEntryId === null) continue
    const replacement = byId.get(entry.replacementEntryId)
    if (!replacement || replacement.id === entry.id || replacements.has(replacement.id)
      || (replacement.correctedAt !== null
        && replacement.correctedAt < entry.correctedAt)) {
      cryptoFailure()
    }
    replacements.add(replacement.id)
    links.set(entry.id, replacement.id)
  }
  for (const start of links.keys()) {
    const path = new Set()
    let cursor = start
    while (links.has(cursor)) {
      if (path.has(cursor)) cryptoFailure()
      path.add(cursor)
      cursor = links.get(cursor)
    }
  }
  if (request.replacement !== null) {
    const replacement = byId.get(target.replacementEntryId)
    if (!replacement || replacement.amountGrosze !== request.replacement.amountGrosze
      || replacement.method !== request.replacement.method
      || replacement.receivedAt !== request.replacement.receivedAt
      || replacement.correctedAt !== null) cryptoFailure()
  }
  const aggregate = paymentAggregateFor(
    appointment.status, charge.expectedAmountGrosze, collected,
  )
  if (!Number.isSafeInteger(collected) || collected > charge.expectedAmountGrosze
    || payment.status !== aggregate.status || payment.collectedGrosze !== collected
    || payment.outstandingGrosze !== aggregate.outstandingGrosze
    || payment.latestMethod !== (latest?.method ?? null)
    || payment.latestReceivedAt !== (latest?.receivedAt ?? null)) cryptoFailure()
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
       AND version=? AND version<=? AND cancelled_at IS NULL
       AND created_at=? AND updated_at=?)
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
  APPOINTMENT_VERSION_CAP, values.appointment.createdAt, values.now,
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
  if (current.appointment.version >= APPOINTMENT_VERSION_CAP) notFound()
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
         AND appointment.version=? AND appointment.version<?
         AND appointment.cancelled_at IS NULL
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
    current.appointment.version, APPOINTMENT_VERSION_CAP,
    current.charge.id, current.charge.version,
    current.charge.expectedAmountGrosze, command.body.amountGrosze,
  ))
  uow.domain(command.db.prepare(
    `UPDATE appointments SET version=?,updated_at=? WHERE id=? AND client_id=?
       AND version=? AND version<? AND ?<=? AND status IN ('completed','noshow')
       AND cancelled_at IS NULL
       AND EXISTS (SELECT 1 FROM payment_entries WHERE id=? AND appointment_id=appointments.id)
       AND (SELECT coalesce(sum(payment.amount_grosze),0)
         FROM payment_entries AS payment WHERE payment.appointment_id=appointments.id
           AND NOT EXISTS (SELECT 1 FROM payment_corrections
             WHERE reversed_entry_id=payment.id))=?`
  ).bind(
    appointment.version, now, appointment.id, current.client.id,
    current.appointment.version, APPOINTMENT_VERSION_CAP,
    appointment.version, APPOINTMENT_VERSION_CAP, paymentId, collectedGrosze,
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

const resolveCorrectionTarget = async (db, paymentId) => {
  let result
  try {
    result = await db.prepare(
      'SELECT appointment_id FROM payment_entries WHERE id=? LIMIT 2',
    ).bind(paymentId).all()
  } catch { notFound() }
  let rows
  try {
    if (result === null || typeof result !== 'object' || Array.isArray(result)
      || !Array.isArray(result.results) || result.results.length !== 1) notFound()
    rows = result.results
  } catch { notFound() }
  const row = captureExact(rows[0], ['appointment_id'], notFound)
  if (!isAppointmentId(row.appointment_id)) notFound()
  return row.appointment_id
}

const correctionIdempotencyRecordId = async (actorId, idempotencyKey) => {
  const encoded = new TextEncoder().encode(
    ['bwm:idempotency:record:v1', actorId, CORRECTION_OPERATION, idempotencyKey].join('\n'),
  )
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
    return `idem_${encodeBase64Url(digest)}`
  } finally {
    encoded.fill(0)
    digest?.fill(0)
  }
}

const generatedCollisionPredicate = (values) => Object.freeze({
  sql: `EXISTS (SELECT 1 FROM json_each(?) AS expected,staff_users AS occupied
      WHERE occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.specialist_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,specialists AS occupied
      WHERE occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.staff_user_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,clients AS occupied
      WHERE occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,client_assignments AS occupied
      WHERE occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.client_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.specialist_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.assigned_by_staff_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,appointments AS occupied
      WHERE occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.client_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.specialist_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,session_charges AS occupied
      WHERE occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.appointment_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,payment_entries AS occupied
      WHERE (occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
          AND occupied.id IS NOT json_extract(expected.value,'$.replacementId'))
        OR occupied.appointment_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.recorded_by_staff_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,payment_corrections AS occupied
      WHERE (occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
          AND occupied.id!=json_extract(expected.value,'$.correctionId'))
        OR occupied.reversed_entry_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR (occupied.replacement_entry_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
          AND NOT (occupied.id=json_extract(expected.value,'$.correctionId')
            AND occupied.replacement_entry_id IS json_extract(expected.value,'$.replacementId')))
        OR occupied.recorded_by_staff_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,record_versions AS occupied
      WHERE (occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
          AND occupied.id!=json_extract(expected.value,'$.versionId'))
        OR occupied.entity_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.changed_by_staff_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,audit_events AS occupied
      WHERE (occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
          AND occupied.id!=json_extract(expected.value,'$.auditId'))
        OR occupied.entity_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.actor_staff_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,data_keys AS occupied
      WHERE occupied.id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.scope_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids'))))
    OR EXISTS (SELECT 1 FROM json_each(?) AS expected,idempotency_records AS occupied
      WHERE occupied.actor_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR occupied.resource_id IN (SELECT value FROM json_each(json_extract(expected.value,'$.ids')))
        OR (occupied.idempotency_key=json_extract(expected.value,'$.idempotencyKey')
          AND NOT (occupied.actor_id=json_extract(expected.value,'$.actorId')
            AND occupied.operation=json_extract(expected.value,'$.operation'))))`,
  bindings: (() => {
    const fact = JSON.stringify([{
      actorId: values.actorId,
      auditId: values.auditId,
      correctionId: values.correctionId,
      idempotencyKey: values.idempotencyKey,
      ids: [
        values.correctionId, values.replacementId, values.versionId, values.auditId,
        values.idempotencyRecordId, values.idempotencyKey,
      ].filter((id) => id !== null),
      operation: CORRECTION_OPERATION,
      replacementId: values.replacementId,
      versionId: values.versionId,
    }])
    return Object.freeze(Array.from({ length: 12 }, () => fact))
  })(),
})

const correctionGuard = (db, values) => {
  const assignmentLedger = retainedAssignmentLedgerPostcondition(
    values.client.id, values.appointment.specialistId,
    values.appointment.startsAt, values.dataKeyId,
  )
  const generatedCollision = generatedCollisionPredicate(values)
  return db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'appointment_payment_correction_postcondition' WHERE NOT (
     EXISTS (SELECT 1 FROM payment_corrections WHERE id=? AND reversed_entry_id=?
       AND replacement_entry_id IS ? AND reason_envelope=?
       AND recorded_by_staff_id=? AND created_at=?)
     AND (? IS NULL OR EXISTS (SELECT 1 FROM payment_entries WHERE id=?
       AND appointment_id=? AND amount_grosze=? AND method=? AND received_at=?
       AND recorded_by_staff_id=? AND external_reference_envelope IS NULL AND created_at=?))
     AND EXISTS (SELECT 1 FROM appointments WHERE id=? AND client_id=?
       AND specialist_id=? AND service_id=? AND starts_at=? AND ends_at=?
       AND time_zone='Europe/Warsaw' AND location IS ? AND status=? AND source='panel'
       AND version=? AND version<=? AND cancelled_at IS NULL
       AND created_at=? AND updated_at=?)
     AND EXISTS (SELECT 1 FROM session_charges WHERE id=? AND appointment_id=?
       AND service_id=? AND expected_amount_grosze=? AND currency='PLN' AND version=?
       AND created_at=? AND updated_at=?)
     AND (SELECT count(*) FROM session_charges WHERE appointment_id=?)=1
     AND (SELECT count(*) FROM payment_entries WHERE appointment_id=?)=?
     AND NOT EXISTS (SELECT 1 FROM payment_entries AS payment WHERE payment.appointment_id=?
       AND (payment.amount_grosze NOT BETWEEN 1 AND 1000000
         OR payment.method NOT IN ('cash','card','transfer','monthly')
         OR payment.external_reference_envelope IS NOT NULL))
     AND NOT EXISTS (SELECT 1 FROM payment_corrections AS correction
       JOIN payment_entries AS reversed ON reversed.id=correction.reversed_entry_id
       WHERE reversed.appointment_id=? AND (correction.replacement_entry_id=correction.reversed_entry_id
         OR NOT json_valid(correction.reason_envelope)
         OR json_extract(CASE WHEN json_valid(correction.reason_envelope)
              THEN correction.reason_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
         OR json_extract(CASE WHEN json_valid(correction.reason_envelope)
              THEN correction.reason_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1
         OR (correction.replacement_entry_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM payment_entries AS replacement
           WHERE replacement.id=correction.replacement_entry_id
             AND replacement.appointment_id=reversed.appointment_id))))
     AND (SELECT coalesce(sum(payment.amount_grosze),0) FROM payment_entries AS payment
       WHERE payment.appointment_id=? AND NOT EXISTS (SELECT 1 FROM payment_corrections
         WHERE reversed_entry_id=payment.id))=?
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
     AND NOT EXISTS (SELECT 1 FROM record_versions WHERE entity_id=?
       AND entity_type!='session_charge')
     AND EXISTS (SELECT 1 FROM audit_events WHERE id=? AND actor_staff_id=?
       AND action='payment.corrected' AND entity_type='payment_entry' AND entity_id=?
       AND result='success' AND reason_envelope IS NULL AND correlation_id=?
       AND metadata_json=?)
     AND (SELECT count(*) FROM audit_events WHERE action='payment.corrected'
       AND entity_type='payment_entry' AND entity_id=? AND result='success')=1
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
     AND (${assignmentLedger.sql})
     AND NOT (${generatedCollision.sql})
   )`
).bind(
  values.correctionId, values.paymentId, values.replacementId,
  values.reasonEnvelope, values.actorId, values.now,
  values.replacementId, values.replacementId, values.appointment.id,
  values.replacement?.amountGrosze ?? 1, values.replacement?.method ?? 'cash',
  values.replacement?.receivedAt ?? values.now, values.actorId, values.now,
  values.appointment.id, values.client.id, values.appointment.specialistId,
  values.appointment.serviceId, values.appointment.startsAt, values.appointment.endsAt,
  values.appointment.location, values.appointment.status, values.appointment.version,
  APPOINTMENT_VERSION_CAP, values.appointment.createdAt, values.now,
  values.charge.id, values.appointment.id, values.charge.serviceId,
  values.charge.expectedAmountGrosze, values.charge.version,
  values.charge.createdAt, values.charge.updatedAt, values.appointment.id,
  values.appointment.id, values.entryCount, values.appointment.id,
  values.appointment.id, values.dataKeyId,
  values.appointment.id, values.collectedGrosze,
  values.versionId, values.appointment.id, values.appointment.version,
  values.actorId, values.now, values.correlationId, values.dataKeyId,
  values.appointment.id,
  values.appointment.id, values.appointment.version,
  values.appointment.id, values.appointment.id, values.appointment.version,
  values.charge.id, values.charge.version,
  values.charge.id, values.charge.id, values.charge.version, values.charge.id,
  values.auditId, values.actorId, values.paymentId, values.correlationId,
  values.metadataJson, values.paymentId,
  values.actorId, CORRECTION_OPERATION, values.idempotencyKey, values.client.id,
  values.dataKeyId, values.dataKeyId,
  values.dataKeyId, values.client.id,
  values.client.id, values.client.identityEnvelope, values.client.version,
  values.client.id, values.client.version,
  ...assignmentLedger.bindings,
  ...generatedCollision.bindings,
  )
}

const correctionCollisionProof = (db, values) => {
  const generatedCollision = generatedCollisionPredicate(values)
  return db.prepare(
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM idempotency_records
       WHERE actor_id=? AND operation=? AND idempotency_key=?) THEN 1 ELSE 0 END AS stored,
   CASE WHEN (${generatedCollision.sql})
     THEN 1 ELSE 0 END AS generated_collision`
  ).bind(
    values.actorId, CORRECTION_OPERATION, values.idempotencyKey,
    ...generatedCollision.bindings,
  ).first()
}

const reproveCorrectionRace = async (command, actor, prior, originalError) => {
  let appointmentId
  let fresh
  try {
    appointmentId = await resolveCorrectionTarget(command.db, command.paymentId)
    fresh = await loadAuthenticatedAppointmentLedger({ ...command, appointmentId }, actor)
  } catch { throw originalError }
  const target = fresh.payment.entries.find(({ id }) => id === command.paymentId)
  if (!target || target.correctedAt !== null) notFound()
  const replacementAmount = command.body.replacement?.amountGrosze ?? 0
  const nextTotal = fresh.payment.collectedGrosze - target.amountGrosze + replacementAmount
  const onlyLedgerChanged = fresh.appointment.version > prior.appointment.version
    && fresh.appointment.clientId === prior.appointment.clientId
    && fresh.appointment.specialistId === prior.appointment.specialistId
    && fresh.appointment.serviceId === prior.appointment.serviceId
    && fresh.appointment.startsAt === prior.appointment.startsAt
    && fresh.appointment.endsAt === prior.appointment.endsAt
    && fresh.appointment.status === prior.appointment.status
    && fresh.charge.id === prior.charge.id && fresh.charge.version === prior.charge.version
    && fresh.charge.expectedAmountGrosze === prior.charge.expectedAmountGrosze
  if (onlyLedgerChanged && (nextTotal < 0 || nextTotal > fresh.charge.expectedAmountGrosze)) {
    throw new Error('PAYMENT_CORRECTION_CONFLICT')
  }
  if (fresh.appointment.version !== prior.appointment.version) {
    versionConflict(fresh.appointment.version)
  }
  if (nextTotal < 0 || nextTotal > fresh.charge.expectedAmountGrosze) {
    throw new Error('PAYMENT_CORRECTION_CONFLICT')
  }
  throw originalError
}

export async function correctAppointmentPayment(input) {
  const command = captureCorrectionCommand(input)
  const actor = actorFact(command.actor)
  const requestDigest = await digestCorrectionNormalized(command.paymentId, command.body)
  const idem = Object.freeze({
    actorId: actor.id, operation: CORRECTION_OPERATION,
    idempotencyKey: command.idempotencyKey, requestDigest,
    resourceType: 'client', scopeType: 'client', scopePurpose: 'identity',
  })
  const replay = await inspectStoredScopeIdempotency(command.db, command.keyring, idem)
  if (replay) return validateCorrectionReplay(replay, command.paymentId, command.body)
  const appointmentId = await resolveCorrectionTarget(command.db, command.paymentId)
  const current = await loadAuthenticatedAppointmentLedgerForCorrection(
    { ...command, appointmentId }, actor,
  )
  const target = current.payment.entries.find(({ id }) => id === command.paymentId)
  if (!target || target.correctedAt !== null) notFound()
  if (command.body.expectedVersion !== current.appointment.version) {
    versionConflict(current.appointment.version)
  }
  if (current.appointment.version >= APPOINTMENT_VERSION_CAP) notFound()
  const replacementAmount = command.body.replacement?.amountGrosze ?? 0
  const collectedGrosze = current.payment.collectedGrosze - target.amountGrosze
    + replacementAmount
  if (!Number.isSafeInteger(collectedGrosze) || collectedGrosze < 0
    || collectedGrosze > current.charge.expectedAmountGrosze
    || (command.body.replacement !== null && current.payment.entries.length >= 1_000)) {
    throw new Error('PAYMENT_CORRECTION_CONFLICT')
  }
  let now
  try { now = new Date(command.nowMs).toISOString() } catch { throw new Error('INTERNAL_ERROR') }
  if (now <= current.appointment.updatedAt) throw new Error('INTERNAL_ERROR')
  const used = new Set()
  const correctionId = generated(command.idFactory, 'cor', isCorrectionId, used)
  const replacementId = command.body.replacement === null ? null
    : generated(command.idFactory, 'pay', isPaymentId, used)
  const versionId = generated(command.idFactory, 'ver', isVersionId, used)
  const auditId = generated(command.idFactory, 'aud', isAuditId, used)
  const reasonEnvelope = JSON.stringify(await encryptForScope(
    command.keyring, current.context.dataKey, {
      expectedScope: current.context.scope, recordId: correctionId,
      field: 'reason', plaintext: command.body.reason,
    },
  ))
  const aggregate = paymentAggregateFor(
    current.appointment.status, current.charge.expectedAmountGrosze, collectedGrosze,
  )
  const appointment = Object.freeze({
    ...current.appointment, version: current.appointment.version + 1, updatedAt: now,
    paymentAggregate: aggregate,
  })
  const entries = current.payment.entries.map((entry) => entry.id === command.paymentId
    ? Object.freeze({ ...entry, correctedAt: now, replacementEntryId: replacementId })
    : entry)
  if (command.body.replacement !== null) entries.push(Object.freeze({
    id: replacementId, ...command.body.replacement,
    correctedAt: null, replacementEntryId: null,
  }))
  entries.sort((left, right) => (left.receivedAt < right.receivedAt ? -1
    : left.receivedAt > right.receivedAt ? 1 : 0)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const latest = entries.filter(({ correctedAt }) => correctedAt === null).at(-1) ?? null
  const responsePayment = Object.freeze({
    ...aggregate, latestMethod: latest?.method ?? null,
    latestReceivedAt: latest?.receivedAt ?? null, entries: Object.freeze(entries),
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
    actorId: actor.id, operation: CORRECTION_OPERATION,
    idempotencyKey: command.idempotencyKey, requestDigest,
    expectedScope: current.context.scope, resourceType: 'client',
    resourceId: current.client.id, response, createdAt: now,
    expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  })
  const metadata = Object.freeze({
    appointmentVersion: appointment.version, correctionId,
    reversedEntryId: command.paymentId, replacementEntryId: replacementId,
  })
  const idempotencyRecordId = await correctionIdempotencyRecordId(
    actor.id, command.idempotencyKey,
  )
  const values = Object.freeze({
    appointment, charge: current.charge, client: current.client,
    actorId: actor.id, paymentId: command.paymentId, correctionId, replacementId,
    replacement: command.body.replacement, reasonEnvelope, versionId, auditId, now,
    correlationId: command.correlationId, idempotencyKey: command.idempotencyKey,
    idempotencyRecordId,
    dataKeyId: current.context.dataKey.id, collectedGrosze,
    entryCount: entries.length, metadataJson: JSON.stringify({
      appointmentVersion: appointment.version, correctionId,
      replacementEntryId: replacementId, reversedEntryId: command.paymentId,
    }),
  })
  const uow = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  if (command.body.replacement !== null) {
    uow.domain(command.db.prepare(
      `INSERT INTO payment_entries
       (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
        external_reference_envelope,created_at)
       SELECT ?,?,?,?,?,?,NULL,? WHERE EXISTS (
         SELECT 1 FROM payment_entries AS target
         JOIN appointments AS appointment ON appointment.id=target.appointment_id
         JOIN session_charges AS charge ON charge.appointment_id=appointment.id
         WHERE target.id=? AND target.appointment_id=? AND appointment.client_id=?
           AND appointment.version=? AND appointment.version<?
           AND charge.id=? AND charge.version=?
           AND NOT EXISTS (SELECT 1 FROM payment_corrections WHERE reversed_entry_id=target.id)
           AND (SELECT count(*) FROM payment_entries WHERE appointment_id=appointment.id)<1000
           AND (SELECT coalesce(sum(payment.amount_grosze),0)
             FROM payment_entries AS payment WHERE payment.appointment_id=appointment.id
               AND NOT EXISTS (SELECT 1 FROM payment_corrections
                 WHERE reversed_entry_id=payment.id))-target.amount_grosze+?
               BETWEEN 0 AND charge.expected_amount_grosze)`
    ).bind(
      replacementId, appointment.id, command.body.replacement.amountGrosze,
      command.body.replacement.method, command.body.replacement.receivedAt,
      actor.id, now, command.paymentId, appointment.id, current.client.id,
      current.appointment.version, APPOINTMENT_VERSION_CAP,
      current.charge.id, current.charge.version, command.body.replacement.amountGrosze,
    ))
  }
  uow.domain(command.db.prepare(
    `INSERT INTO payment_corrections
     (id,reversed_entry_id,replacement_entry_id,reason_envelope,
      recorded_by_staff_id,created_at)
     SELECT ?,?,?,?,?,? FROM payment_entries AS target
     JOIN appointments AS appointment ON appointment.id=target.appointment_id
     JOIN session_charges AS charge ON charge.appointment_id=appointment.id
     WHERE target.id=? AND target.appointment_id=? AND appointment.client_id=?
       AND appointment.version=? AND appointment.version<?
       AND charge.id=? AND charge.version=?
       AND NOT EXISTS (SELECT 1 FROM payment_corrections WHERE reversed_entry_id=target.id)
       AND ((? IS NULL AND ? IS NULL) OR EXISTS (SELECT 1 FROM payment_entries
         WHERE id=? AND appointment_id=appointment.id AND created_at=?))
       AND (SELECT coalesce(sum(payment.amount_grosze),0)
         FROM payment_entries AS payment WHERE payment.appointment_id=appointment.id
           AND NOT EXISTS (SELECT 1 FROM payment_corrections
             WHERE reversed_entry_id=payment.id))-target.amount_grosze+?
           BETWEEN 0 AND charge.expected_amount_grosze`
  ).bind(
    correctionId, command.paymentId, replacementId, reasonEnvelope, actor.id, now,
    command.paymentId, appointment.id, current.client.id,
    current.appointment.version, APPOINTMENT_VERSION_CAP,
    current.charge.id, current.charge.version,
    replacementId, replacementId, replacementId, now, replacementAmount,
  ))
  uow.domain(command.db.prepare(
    `UPDATE appointments SET version=?,updated_at=? WHERE id=? AND client_id=?
       AND version=? AND version<? AND EXISTS (SELECT 1 FROM payment_corrections
         WHERE id=? AND reversed_entry_id=? AND replacement_entry_id IS ?)
       AND (SELECT coalesce(sum(payment.amount_grosze),0)
         FROM payment_entries AS payment WHERE payment.appointment_id=appointments.id
           AND NOT EXISTS (SELECT 1 FROM payment_corrections
             WHERE reversed_entry_id=payment.id))=?`
  ).bind(
    appointment.version, now, appointment.id, current.client.id,
    current.appointment.version, APPOINTMENT_VERSION_CAP,
    correctionId, command.paymentId, replacementId, collectedGrosze,
  ))
  uow.version(conditionalVersionStatement(command.db, appointmentVersion, appointment))
  uow.audit(auditEventStatement(command.db, {
    id: auditId, occurredAt: now, actorStaffId: actor.id,
    action: 'payment.corrected', entityType: 'payment_entry', entityId: command.paymentId,
    result: 'success', correlationId: command.correlationId,
    metadata, reasonEnvelope: null,
  }))
  uow.idempotency(idempotency)
  uow.guard(correctionGuard(command.db, values))
  try {
    await uow.commit()
    return response
  } catch (originalError) {
    if (isD1IdentityCollision(originalError)) {
      let collision
      try {
        collision = captureExact(await correctionCollisionProof(command.db, values),
          ['stored', 'generated_collision'], cryptoFailure)
      } catch { throw originalError }
      if (![0, 1].includes(collision.stored)
        || ![0, 1].includes(collision.generated_collision)) throw originalError
      if (collision.stored === 1 && collision.generated_collision === 0) {
        const winner = await recoverStoredScopeIdempotencyAfterCollision(
          command.recoveryDb, command.keyring, idem, originalError,
        )
        return validateCorrectionReplay(winner, command.paymentId, command.body)
      }
      if (collision.stored === 0 && collision.generated_collision === 0) {
        return reproveCorrectionRace(command, actor, current, originalError)
      }
    }
    if (isD1CoreDirectoryInvariantFailure(originalError)) {
      return reproveCorrectionRace(command, actor, current, originalError)
    }
    throw originalError
  }
}
