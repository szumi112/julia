import { encodeBase64Url } from '../security/encoding.js'
import { decryptForScope } from '../security/envelope.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectStoredScopeIdempotency,
  recoverStoredScopeIdempotencyAfterCollision,
} from '../db/unit-of-work.js'
import { isD1IdentityCollision } from '../db/errors.js'
import { authorize } from '../identity/policy.js'
import { specialistPostcondition } from '../identity/specialists.js'
import { auditEventStatement } from '../audit/events.js'
import {
  createOwnershipCapabilityBoundary,
  decryptClientIdentity,
  loadClientCryptoContext,
} from './crypto.js'
import { createRecordVersionBuilder } from './versions.js'
import {
  assertClientIdentity,
  assertLocation,
  isAppointmentId,
  isAssignmentId,
  isAuditId,
  isChargeId,
  isClientId,
  isOpaqueId,
  isSpecialistId,
  isVersionId,
  validateAppointmentInput,
} from '../../src/core-records.js'

const BODY_KEYS = Object.freeze([
  'clientId', 'specialistId', 'serviceId', 'date', 'time', 'durationMinutes',
  'expectedAmountGrosze', 'location', 'status',
])
const INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPERATION = 'appointments.create'
const ROUTE_TARGET = 'POST /api/v1/appointments'
const PROSPECTIVE_APPOINTMENT_ID = 'apt_authorization_target'
const DAY_MS = 86_400_000
const ownership = createOwnershipCapabilityBoundary()
const versionBuilder = createRecordVersionBuilder(ownership.consumer)

const validation = (field) => { throw new TypeError(`VALIDATION_FAILED/${field}`) }
const notFound = () => { throw new Error('NOT_FOUND') }
const cryptoFailure = () => { throw new Error('CRYPTO_FAILURE') }

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
    if (error instanceof Error && /^(?:VALIDATION_FAILED\/|NOT_FOUND|CRYPTO_FAILURE)/.test(error.message)) throw error
    fail()
  }
}

export function validateCreateAppointmentBody(value) {
  const captured = captureExact(value, BODY_KEYS)
  try {
    const validated = validateAppointmentInput(captured)
    return Object.freeze({ ...validated, date: captured.date, time: captured.time })
  } catch (error) {
    const message = error instanceof Error
      ? Object.getOwnPropertyDescriptor(error, 'message')?.value
      : null
    if (typeof message === 'string' && /^VALIDATION_FAILED\//.test(message)) throw error
    validation('body')
  }
}

const digestNormalized = async (body) => {
  const encoded = new TextEncoder().encode(JSON.stringify({
    body: {
      clientId: body.clientId,
      date: body.date,
      durationMinutes: body.durationMinutes,
      endsAt: body.endsAt,
      expectedAmountGrosze: body.expectedAmountGrosze,
      location: body.location,
      serviceId: body.serviceId,
      specialistId: body.specialistId,
      startsAt: body.startsAt,
      status: body.status,
      time: body.time,
      timeZone: body.timeZone,
    },
    route: ROUTE_TARGET,
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

export async function digestCreateAppointmentRequest(value) {
  return digestNormalized(validateCreateAppointmentBody(value))
}

const captureCommand = (input) => {
  const captured = captureExact(input, INPUT_KEYS)
  if (!captured.db?.prepare || !captured.db?.batch || !captured.recoveryDb?.prepare
    || !captured.keyring || typeof captured.idFactory !== 'function'
    || !Number.isSafeInteger(captured.nowMs) || captured.nowMs < 0
    || typeof captured.correlationId !== 'string' || !CORRELATION_ID.test(captured.correlationId)
    || typeof captured.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(captured.idempotencyKey)) {
    validation('body')
  }
  return Object.freeze({ ...captured, body: validateCreateAppointmentBody(captured.body) })
}

const actorFact = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('FORBIDDEN')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result = {}
    for (const key of ['id', 'role', 'specialistId']) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('FORBIDDEN')
      result[key] = descriptor.value
    }
    if (typeof result.id !== 'string' || !STAFF_ID.test(result.id)
      || !['owner', 'coordinator', 'specialist'].includes(result.role)
      || (result.specialistId !== null && !isSpecialistId(result.specialistId))
      || (result.role === 'specialist' && result.specialistId === null)) throw new Error('FORBIDDEN')
    return Object.freeze(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') throw error
    throw new Error('FORBIDDEN')
  }
}

const canonicalInstant = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

const generated = (factory, prefix, predicate, used) => {
  let suffix
  try { suffix = factory() } catch { throw new Error('INTERNAL_ERROR') }
  if (typeof suffix !== 'string' || !isOpaqueId(suffix)) throw new Error('INTERNAL_ERROR')
  const id = `${prefix}_${suffix}`
  if (!predicate(id) || used.has(id)) throw new Error('INTERNAL_ERROR')
  used.add(id)
  return id
}

const scopedRow = (value, body) => {
  const row = captureExact(value, [
    'client_id', 'identity_envelope', 'client_status', 'client_version', 'archived_at',
    'client_created_at', 'client_updated_at', 'assignment_id', 'specialist_id',
    'starts_at', 'ends_at', 'assigned_by_staff_id', 'assignment_version',
    'assignment_created_at', 'assignment_updated_at', 'practitioner_staff_id',
  ], notFound)
  if (row.client_id !== body.clientId || !isClientId(row.client_id)
    || typeof row.identity_envelope !== 'string'
    || !['active', 'paused'].includes(row.client_status)
    || !Number.isSafeInteger(row.client_version) || row.client_version < 1
    || row.archived_at !== null || !canonicalInstant(row.client_created_at)
    || !canonicalInstant(row.client_updated_at) || row.client_created_at > row.client_updated_at
    || !isAssignmentId(row.assignment_id) || row.specialist_id !== body.specialistId
    || !canonicalInstant(row.starts_at)
    || (row.ends_at !== null && (!canonicalInstant(row.ends_at) || row.ends_at <= row.starts_at))
    || !(row.starts_at <= body.startsAt && (row.ends_at === null || body.startsAt < row.ends_at))
    || typeof row.assigned_by_staff_id !== 'string' || !STAFF_ID.test(row.assigned_by_staff_id)
    || !Number.isSafeInteger(row.assignment_version) || row.assignment_version < 1
    || !canonicalInstant(row.assignment_created_at) || !canonicalInstant(row.assignment_updated_at)
    || typeof row.practitioner_staff_id !== 'string' || !STAFF_ID.test(row.practitioner_staff_id)) notFound()
  return Object.freeze({
    id: row.client_id, identityEnvelope: row.identity_envelope,
    status: row.client_status, version: row.client_version, archivedAt: null,
    createdAt: row.client_created_at, updatedAt: row.client_updated_at,
    assignment: Object.freeze({
      id: row.assignment_id, clientId: row.client_id, specialistId: row.specialist_id,
      startsAt: row.starts_at, endsAt: row.ends_at,
      assignedByStaffId: row.assigned_by_staff_id, version: row.assignment_version,
      createdAt: row.assignment_created_at, updatedAt: row.assignment_updated_at,
    }),
    practitionerStaffId: row.practitioner_staff_id,
  })
}

const loadScopedClient = async (db, body, actor) => db.prepare(
  `SELECT client.id AS client_id, client.identity_envelope,
          client.status AS client_status, client.version AS client_version,
          client.archived_at, client.created_at AS client_created_at,
          client.updated_at AS client_updated_at, assignment.id AS assignment_id,
          assignment.specialist_id, assignment.starts_at, assignment.ends_at,
          assignment.assigned_by_staff_id, assignment.version AS assignment_version,
          assignment.created_at AS assignment_created_at,
          assignment.updated_at AS assignment_updated_at,
          specialist.staff_user_id AS practitioner_staff_id
   FROM clients AS client
   JOIN client_assignments AS assignment ON assignment.client_id=client.id
     AND assignment.specialist_id=? AND assignment.starts_at<=?
     AND (assignment.ends_at IS NULL OR ?<assignment.ends_at)
   JOIN specialists AS specialist ON specialist.id=assignment.specialist_id
   JOIN staff_users AS staff ON staff.id=specialist.staff_user_id
     AND staff.specialist_id=specialist.id
   WHERE client.id=? AND client.status IN ('active','paused') AND client.archived_at IS NULL
     AND specialist.id=? AND specialist.status='active' AND staff.status='active'
     AND (? IN ('owner','coordinator') OR (?='specialist' AND specialist.id=?))
     AND (SELECT count(*) FROM client_assignments AS effective
       WHERE effective.client_id=client.id AND effective.starts_at<=?
         AND (effective.ends_at IS NULL OR ?<effective.ends_at))=1`
).bind(
  body.specialistId, body.startsAt, body.startsAt, body.clientId, body.specialistId,
  actor.role, actor.role, actor.specialistId, body.startsAt, body.startsAt,
).first()

const resultRows = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) notFound()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (!keys.includes('results') || keys.some((key) => typeof key !== 'string'
      || !['results', 'success', 'meta'].includes(key))) notFound()
    const descriptor = descriptors.results
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
      || !Array.isArray(descriptor.value) || descriptor.value.length > 256) notFound()
    return descriptor.value
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') throw error
    notFound()
  }
}

const loadClientVersions = (db, clientId) => db.prepare(
  `SELECT id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
          changed_at,correlation_id
   FROM record_versions WHERE entity_type='client' AND entity_id=?
   ORDER BY version,id LIMIT 257`
).bind(clientId).all()

const authenticateClientVersions = async (context, current, identity, value) => {
  const rows = resultRows(value)
  if (rows.length !== current.version || rows.length < 1) notFound()
  const ids = new Set()
  let previousUpdatedAt = null
  for (let index = 0; index < rows.length; index += 1) {
    const row = captureExact(rows[index], [
      'id', 'entity_type', 'entity_id', 'version', 'snapshot_envelope',
      'changed_by_staff_id', 'changed_at', 'correlation_id',
    ], notFound)
    if (!isVersionId(row.id) || ids.has(row.id) || row.entity_type !== 'client'
      || row.entity_id !== current.id || row.version !== index + 1
      || typeof row.snapshot_envelope !== 'string'
      || typeof row.changed_by_staff_id !== 'string' || !STAFF_ID.test(row.changed_by_staff_id)
      || !canonicalInstant(row.changed_at) || typeof row.correlation_id !== 'string'
      || !isOpaqueId(row.correlation_id)) notFound()
    ids.add(row.id)
    let snapshot
    try {
      const plaintext = await decryptForScope(context.keyring, context.dataKey, {
        expectedScope: context.scope, recordId: current.id, field: 'record_version',
        envelope: JSON.parse(row.snapshot_envelope),
      })
      snapshot = JSON.parse(plaintext)
    } catch { notFound() }
    const fact = captureExact(snapshot, [
      'age', 'archivedAt', 'createdAt', 'id', 'name', 'schema', 'status',
      'updatedAt', 'version',
    ], notFound)
    try { assertClientIdentity({ name: fact.name, age: fact.age }) } catch { notFound() }
    if (fact.id !== current.id || fact.schema !== 'client.v1' || fact.version !== row.version
      || !['active', 'paused'].includes(fact.status) || fact.archivedAt !== null
      || fact.createdAt !== current.createdAt || !canonicalInstant(fact.updatedAt)
      || fact.updatedAt !== row.changed_at
      || (previousUpdatedAt !== null && fact.updatedAt <= previousUpdatedAt)) notFound()
    previousUpdatedAt = fact.updatedAt
    if (index === rows.length - 1 && (fact.name !== identity.name || fact.age !== identity.age
      || fact.status !== current.status || fact.archivedAt !== null
      || fact.createdAt !== current.createdAt || fact.updatedAt !== current.updatedAt)) notFound()
  }
}

const loadAssignmentVersions = (db, clientId) => db.prepare(
  `SELECT assignment.id,assignment.client_id,assignment.specialist_id,
          assignment.starts_at,assignment.ends_at,assignment.assigned_by_staff_id,
          assignment.version AS assignment_version,assignment.created_at,
          assignment.updated_at,version.id AS record_version_id,
          version.entity_type AS record_version_type,
          version.entity_id AS record_version_entity_id,
          version.version AS record_version_number,version.snapshot_envelope,
          version.changed_by_staff_id,version.changed_at,version.correlation_id
   FROM client_assignments AS assignment
   LEFT JOIN record_versions AS version ON version.entity_id=assignment.id
   WHERE assignment.client_id=?
   ORDER BY assignment.starts_at,assignment.id,version.version,version.id LIMIT 257`
).bind(clientId).all()

const authenticateAssignmentVersions = async (context, current, value) => {
  const rows = resultRows(value)
  if (rows.length < 1) notFound()
  const groups = new Map()
  const versionIds = new Set()
  for (const candidate of rows) {
    const row = captureExact(candidate, [
      'id', 'client_id', 'specialist_id', 'starts_at', 'ends_at',
      'assigned_by_staff_id', 'assignment_version', 'created_at', 'updated_at',
      'record_version_id', 'record_version_type', 'record_version_entity_id',
      'record_version_number', 'snapshot_envelope', 'changed_by_staff_id',
      'changed_at', 'correlation_id',
    ], notFound)
    if (!isAssignmentId(row.id) || row.client_id !== current.id
      || !isSpecialistId(row.specialist_id) || !canonicalInstant(row.starts_at)
      || (row.ends_at !== null && (!canonicalInstant(row.ends_at) || row.ends_at <= row.starts_at))
      || typeof row.assigned_by_staff_id !== 'string' || !STAFF_ID.test(row.assigned_by_staff_id)
      || ![1, 2].includes(row.assignment_version)
      || !canonicalInstant(row.created_at) || !canonicalInstant(row.updated_at)
      || !isVersionId(row.record_version_id) || versionIds.has(row.record_version_id)
      || row.record_version_type !== 'client_assignment'
      || row.record_version_entity_id !== row.id
      || !Number.isSafeInteger(row.record_version_number) || row.record_version_number < 1
      || typeof row.snapshot_envelope !== 'string'
      || typeof row.changed_by_staff_id !== 'string' || !STAFF_ID.test(row.changed_by_staff_id)
      || !canonicalInstant(row.changed_at) || typeof row.correlation_id !== 'string'
      || !isOpaqueId(row.correlation_id)) notFound()
    versionIds.add(row.record_version_id)
    const immutable = JSON.stringify([
      row.client_id, row.specialist_id, row.starts_at, row.ends_at,
      row.assigned_by_staff_id, row.assignment_version, row.created_at, row.updated_at,
    ])
    const group = groups.get(row.id) ?? { row, immutable, versions: [] }
    if (group.immutable !== immutable) notFound()
    group.versions.push(row)
    groups.set(row.id, group)
  }
  if (!groups.has(current.assignment.id)) notFound()
  const ordered = [...groups.values()].sort((left, right) =>
    left.row.starts_at.localeCompare(right.row.starts_at) || left.row.id.localeCompare(right.row.id))
  for (let groupIndex = 0; groupIndex < ordered.length; groupIndex += 1) {
    const group = ordered[groupIndex]
    const isCurrent = group.row.id === current.assignment.id
    if ((isCurrent && (group.row.ends_at !== null || group.row.assignment_version !== 1))
      || (!isCurrent && (group.row.ends_at === null || group.row.assignment_version !== 2))
      || (groupIndex > 0 && ordered[groupIndex - 1].row.ends_at !== group.row.starts_at)) notFound()
    if (group.versions.length !== group.row.assignment_version) notFound()
    for (let index = 0; index < group.versions.length; index += 1) {
      const version = group.versions[index]
      if (version.record_version_number !== index + 1) notFound()
      let snapshot
      try {
        const plaintext = await decryptForScope(context.keyring, context.dataKey, {
          expectedScope: context.scope, recordId: group.row.id, field: 'record_version',
          envelope: JSON.parse(version.snapshot_envelope),
        })
        snapshot = JSON.parse(plaintext)
      } catch { notFound() }
      const fact = captureExact(snapshot, [
        'assignedByStaffId', 'clientId', 'createdAt', 'endsAt', 'id', 'schema',
        'specialistId', 'startsAt', 'updatedAt', 'version',
      ], notFound)
      const isLatest = index === group.versions.length - 1
      if (fact.id !== group.row.id || fact.schema !== 'client_assignment.v1'
        || fact.clientId !== current.id || fact.specialistId !== group.row.specialist_id
        || fact.assignedByStaffId !== group.row.assigned_by_staff_id
        || fact.startsAt !== group.row.starts_at || fact.createdAt !== group.row.created_at
        || fact.version !== index + 1
        || fact.updatedAt !== version.changed_at
        || (isLatest && (fact.endsAt !== group.row.ends_at
          || fact.updatedAt !== group.row.updated_at))
        || (!isLatest && (fact.endsAt !== null || fact.updatedAt !== group.row.created_at))) notFound()
    }
  }
  const selected = ordered.find(({ row }) => row.id === current.assignment.id)?.row
  if (!selected || selected.client_id !== current.assignment.clientId
    || selected.specialist_id !== current.assignment.specialistId
    || selected.starts_at !== current.assignment.startsAt
    || selected.ends_at !== current.assignment.endsAt
    || selected.assigned_by_staff_id !== current.assignment.assignedByStaffId
    || selected.assignment_version !== current.assignment.version
    || selected.created_at !== current.assignment.createdAt
    || selected.updated_at !== current.assignment.updatedAt) notFound()
}

const overlapFact = (value) => {
  if (value === null) return false
  const row = captureExact(value, ['blocked'], notFound)
  if (row.blocked !== 1) notFound()
  return true
}

const loadOverlap = (db, body) => db.prepare(
  `SELECT 1 AS blocked FROM appointments
   WHERE specialist_id=? AND status!='cancelled' AND starts_at<? AND ?<ends_at LIMIT 1`
).bind(body.specialistId, body.endsAt, body.startsAt).first()

const paymentFor = (status, amount) => Object.freeze({
  status: 'unpaid', collectedGrosze: 0,
  outstandingGrosze: ['completed', 'noshow'].includes(status) ? amount : 0,
  latestMethod: null, latestReceivedAt: null,
})

const appointmentDto = (appointment, charge) => Object.freeze({
  id: appointment.id, clientId: appointment.clientId,
  specialistId: appointment.specialistId, serviceId: appointment.serviceId,
  startsAt: appointment.startsAt, endsAt: appointment.endsAt,
  timeZone: appointment.timeZone, location: appointment.location,
  status: appointment.status, source: appointment.source, version: appointment.version,
  cancelledAt: null, createdAt: appointment.createdAt, updatedAt: appointment.updatedAt,
  charge: Object.freeze({
    id: charge.id, serviceId: charge.serviceId,
    expectedAmountGrosze: charge.expectedAmountGrosze,
    currency: charge.currency, version: charge.version,
  }),
  payment: paymentFor(appointment.status, charge.expectedAmountGrosze),
  paymentEntries: Object.freeze([]),
})

const replayObject = (value, keys) => captureExact(value, keys, cryptoFailure)
const validateReplay = (value, request) => {
  const stored = replayObject(value, ['status', 'body'])
  const body = replayObject(stored.body, ['data'])
  const data = replayObject(body.data, ['appointment'])
  const appointment = replayObject(data.appointment, [
    'id', 'clientId', 'specialistId', 'serviceId', 'startsAt', 'endsAt', 'timeZone',
    'location', 'status', 'source', 'version', 'cancelledAt', 'createdAt', 'updatedAt',
    'charge', 'payment', 'paymentEntries',
  ])
  const charge = replayObject(appointment.charge, [
    'id', 'serviceId', 'expectedAmountGrosze', 'currency', 'version',
  ])
  const payment = replayObject(appointment.payment, [
    'status', 'collectedGrosze', 'outstandingGrosze', 'latestMethod', 'latestReceivedAt',
  ])
  const expectedPayment = paymentFor(request.status, request.expectedAmountGrosze)
  if (stored.status !== 201 || !isAppointmentId(appointment.id)
    || appointment.clientId !== request.clientId
    || appointment.specialistId !== request.specialistId
    || appointment.serviceId !== request.serviceId
    || appointment.startsAt !== request.startsAt || appointment.endsAt !== request.endsAt
    || appointment.timeZone !== 'Europe/Warsaw' || appointment.location !== request.location
    || appointment.status !== request.status || appointment.source !== 'panel'
    || appointment.version !== 1 || appointment.cancelledAt !== null
    || !canonicalInstant(appointment.createdAt) || appointment.updatedAt !== appointment.createdAt
    || !isChargeId(charge.id) || charge.serviceId !== request.serviceId
    || charge.expectedAmountGrosze !== request.expectedAmountGrosze
    || charge.currency !== 'PLN' || charge.version !== 1
    || JSON.stringify(payment) !== JSON.stringify(expectedPayment)
    || !Array.isArray(appointment.paymentEntries) || appointment.paymentEntries.length !== 0) cryptoFailure()
  const dto = appointmentDto(appointment, charge)
  return Object.freeze({ status: 201, body: Object.freeze({ data: Object.freeze({ appointment: dto }) }) })
}

const guardStatement = (db, values) => {
  const lifecycle = specialistPostcondition(values.practitionerStaffId)
  return db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'appointment_create_postcondition'
     WHERE NOT (
       EXISTS (SELECT 1 FROM appointments WHERE id=? AND client_id=? AND specialist_id=?
         AND service_id=? AND starts_at=? AND ends_at=? AND time_zone='Europe/Warsaw'
         AND location IS ? AND status=? AND source='panel' AND version=1
         AND cancelled_at IS NULL AND created_at=? AND updated_at=?)
       AND EXISTS (SELECT 1 FROM session_charges WHERE id=? AND appointment_id=?
         AND service_id=? AND expected_amount_grosze=? AND currency='PLN' AND version=1
         AND created_at=? AND updated_at=?)
       AND (SELECT count(*) FROM session_charges WHERE appointment_id=?)=1
       AND (SELECT count(*) FROM appointments WHERE id=?)=1
       AND (SELECT count(*) FROM record_versions
         WHERE entity_type='appointment' AND entity_id=?)=1
       AND (SELECT count(*) FROM record_versions
         WHERE entity_type='session_charge' AND entity_id=?)=1
       AND EXISTS (SELECT 1 FROM record_versions WHERE id=? AND entity_type='appointment'
         AND entity_id=? AND version=1 AND json_extract(snapshot_envelope,'$.dataKeyId')=?
         AND json_extract(snapshot_envelope,'$.dataKeyVersion')=1)
       AND EXISTS (SELECT 1 FROM record_versions WHERE id=? AND entity_type='session_charge'
         AND entity_id=? AND version=1 AND json_extract(snapshot_envelope,'$.dataKeyId')=?
         AND json_extract(snapshot_envelope,'$.dataKeyVersion')=1)
       AND EXISTS (SELECT 1 FROM audit_events WHERE id=? AND actor_staff_id=?
         AND action='appointment.created' AND entity_type='appointment' AND entity_id=?
         AND result='success' AND reason_envelope IS NULL AND correlation_id=?
         AND metadata_json=?)
       AND EXISTS (SELECT 1 FROM idempotency_records WHERE actor_id=? AND operation=?
         AND idempotency_key=? AND resource_type='client' AND resource_id=?
         AND json_extract(request_hash,'$.dataKeyId')=?
         AND json_extract(request_hash,'$.dataKeyVersion')=1
         AND json_extract(response_envelope,'$.dataKeyId')=?
         AND json_extract(response_envelope,'$.dataKeyVersion')=1)
       AND EXISTS (SELECT 1 FROM data_keys WHERE id=? AND scope_type='client'
         AND scope_id=? AND purpose='identity' AND dek_version=1)
       AND (SELECT count(*) FROM client_assignments WHERE client_id=? AND specialist_id=?
         AND starts_at<=? AND (ends_at IS NULL OR ?<ends_at))=1
       AND EXISTS (SELECT 1 FROM clients WHERE id=? AND status IN ('active','paused')
         AND archived_at IS NULL AND version=? AND identity_envelope=?)
       AND (SELECT count(*) FROM record_versions
         WHERE entity_type='client' AND entity_id=?)=?
       AND (SELECT min(version) FROM record_versions
         WHERE entity_type='client' AND entity_id=?)=1
       AND (SELECT max(version) FROM record_versions
         WHERE entity_type='client' AND entity_id=?)=?
       AND NOT EXISTS (SELECT 1 FROM record_versions
         WHERE entity_type='client' AND entity_id=? AND (
           NOT json_valid(snapshot_envelope)
           OR json_extract(CASE WHEN json_valid(snapshot_envelope)
                THEN snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
           OR json_extract(CASE WHEN json_valid(snapshot_envelope)
                THEN snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1))
       AND NOT EXISTS (SELECT 1 FROM client_assignments AS retained
         WHERE retained.client_id=? AND (
           (SELECT count(*) FROM record_versions AS history
             WHERE history.entity_type='client_assignment'
               AND history.entity_id=retained.id)!=retained.version
           OR (SELECT min(history.version) FROM record_versions AS history
             WHERE history.entity_type='client_assignment'
               AND history.entity_id=retained.id)!=1
           OR (SELECT max(history.version) FROM record_versions AS history
             WHERE history.entity_type='client_assignment'
               AND history.entity_id=retained.id)!=retained.version))
       AND NOT EXISTS (SELECT 1 FROM record_versions AS history
         JOIN client_assignments AS retained ON retained.id=history.entity_id
         WHERE retained.client_id=? AND (history.entity_type!='client_assignment'
           OR NOT json_valid(history.snapshot_envelope)
           OR json_extract(CASE WHEN json_valid(history.snapshot_envelope)
                THEN history.snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
           OR json_extract(CASE WHEN json_valid(history.snapshot_envelope)
                THEN history.snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1))
       AND EXISTS (SELECT 1 FROM specialists AS specialist JOIN staff_users AS staff
         ON staff.id=specialist.staff_user_id AND staff.specialist_id=specialist.id
         WHERE specialist.id=? AND specialist.staff_user_id=?
           AND specialist.status='active' AND staff.status='active')
       AND NOT EXISTS (SELECT 1 FROM appointments AS other WHERE other.specialist_id=?
         AND other.id!=? AND other.status!='cancelled' AND other.starts_at<? AND ?<other.ends_at)
       AND NOT EXISTS (SELECT 1 FROM payment_entries WHERE appointment_id=?)
       AND (${lifecycle.sql})
     )`
  ).bind(
    values.appointment.id, values.client.id, values.appointment.specialistId,
    values.appointment.serviceId, values.appointment.startsAt, values.appointment.endsAt,
    values.appointment.location, values.appointment.status, values.now, values.now,
    values.charge.id, values.appointment.id, values.charge.serviceId,
    values.charge.expectedAmountGrosze, values.now, values.now, values.appointment.id,
    values.appointment.id, values.appointment.id, values.charge.id,
    values.appointmentVersionId, values.appointment.id, values.dataKeyId,
    values.chargeVersionId, values.charge.id, values.dataKeyId,
    values.auditId, values.actorId, values.appointment.id, values.correlationId,
    JSON.stringify({ appointmentVersion: 1, chargeVersion: 1 }),
    values.actorId, OPERATION, values.idempotencyKey, values.client.id,
    values.dataKeyId, values.dataKeyId, values.dataKeyId, values.client.id,
    values.client.id, values.appointment.specialistId, values.appointment.startsAt,
    values.appointment.startsAt, values.client.id, values.client.version,
    values.client.identityEnvelope,
    values.client.id, values.client.version, values.client.id,
    values.client.id, values.client.version, values.client.id, values.dataKeyId,
    values.client.id, values.client.id, values.dataKeyId,
    values.appointment.specialistId,
    values.practitionerStaffId, values.appointment.specialistId, values.appointment.id,
    values.appointment.endsAt, values.appointment.startsAt, values.appointment.id,
    ...lifecycle.bindings,
  )
}

const overlapProof = async (db, values) => {
  const lifecycle = specialistPostcondition(values.practitionerStaffId)
  return db.prepare(
    `SELECT CASE WHEN
     EXISTS (SELECT 1 FROM appointments WHERE specialist_id=? AND status!='cancelled'
       AND starts_at<? AND ?<ends_at)
     AND NOT EXISTS (SELECT 1 FROM appointments WHERE id=?)
     AND NOT EXISTS (SELECT 1 FROM session_charges WHERE id=? OR appointment_id=?)
     AND NOT EXISTS (SELECT 1 FROM record_versions WHERE id IN (?,?))
     AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id=?)
     AND NOT EXISTS (SELECT 1 FROM idempotency_records WHERE actor_id=? AND operation=?
       AND idempotency_key=?)
     AND EXISTS (SELECT 1 FROM clients WHERE id=? AND status IN ('active','paused')
       AND archived_at IS NULL AND version=? AND identity_envelope=?)
     AND EXISTS (SELECT 1 FROM data_keys WHERE id=? AND scope_type='client'
       AND scope_id=? AND purpose='identity' AND dek_version=1)
     AND (SELECT count(*) FROM record_versions
       WHERE entity_type='client' AND entity_id=?)=?
     AND (SELECT min(version) FROM record_versions
       WHERE entity_type='client' AND entity_id=?)=1
     AND (SELECT max(version) FROM record_versions
       WHERE entity_type='client' AND entity_id=?)=?
     AND NOT EXISTS (SELECT 1 FROM record_versions
       WHERE entity_type='client' AND entity_id=? AND (
         NOT json_valid(snapshot_envelope)
         OR json_extract(CASE WHEN json_valid(snapshot_envelope)
              THEN snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
         OR json_extract(CASE WHEN json_valid(snapshot_envelope)
              THEN snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1))
     AND NOT EXISTS (SELECT 1 FROM client_assignments AS retained
       WHERE retained.client_id=? AND (
         (SELECT count(*) FROM record_versions AS history
           WHERE history.entity_type='client_assignment'
             AND history.entity_id=retained.id)!=retained.version
         OR (SELECT min(history.version) FROM record_versions AS history
           WHERE history.entity_type='client_assignment'
             AND history.entity_id=retained.id)!=1
         OR (SELECT max(history.version) FROM record_versions AS history
           WHERE history.entity_type='client_assignment'
             AND history.entity_id=retained.id)!=retained.version))
     AND NOT EXISTS (SELECT 1 FROM record_versions AS history
       JOIN client_assignments AS retained ON retained.id=history.entity_id
       WHERE retained.client_id=? AND (history.entity_type!='client_assignment'
         OR NOT json_valid(history.snapshot_envelope)
         OR json_extract(CASE WHEN json_valid(history.snapshot_envelope)
              THEN history.snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
         OR json_extract(CASE WHEN json_valid(history.snapshot_envelope)
              THEN history.snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1))
     AND (SELECT count(*) FROM client_assignments WHERE client_id=? AND specialist_id=?
       AND starts_at<=? AND (ends_at IS NULL OR ?<ends_at))=1
     AND EXISTS (SELECT 1 FROM specialists AS specialist JOIN staff_users AS staff
       ON staff.id=specialist.staff_user_id AND staff.specialist_id=specialist.id
       WHERE specialist.id=? AND specialist.staff_user_id=?
         AND specialist.status='active' AND staff.status='active')
     AND (${lifecycle.sql})
     THEN 1 ELSE 0 END AS proven`
  ).bind(
    values.appointment.specialistId, values.appointment.endsAt, values.appointment.startsAt,
    values.appointment.id, values.charge.id, values.appointment.id,
    values.appointmentVersionId, values.chargeVersionId, values.auditId,
    values.actorId, OPERATION, values.idempotencyKey,
    values.client.id, values.client.version, values.client.identityEnvelope,
    values.dataKeyId, values.client.id,
    values.client.id, values.client.version, values.client.id,
    values.client.id, values.client.version, values.client.id, values.dataKeyId,
    values.client.id, values.client.id, values.dataKeyId,
    values.client.id, values.appointment.specialistId, values.appointment.startsAt,
    values.appointment.startsAt, values.appointment.specialistId,
    values.practitionerStaffId, ...lifecycle.bindings,
  ).first()
}

const idempotencyCollisionProof = async (db, values) => db.prepare(
  `SELECT CASE WHEN EXISTS (SELECT 1 FROM idempotency_records
       WHERE actor_id=? AND operation=? AND idempotency_key=?)
     THEN 1 ELSE 0 END AS stored,
   CASE WHEN EXISTS (SELECT 1 FROM appointments WHERE id=?)
       OR EXISTS (SELECT 1 FROM session_charges WHERE id=? OR appointment_id=?)
       OR EXISTS (SELECT 1 FROM record_versions WHERE id IN (?,?))
       OR EXISTS (SELECT 1 FROM audit_events WHERE id=?)
     THEN 1 ELSE 0 END AS generated_collision`
).bind(
  values.actorId, OPERATION, values.idempotencyKey,
  values.appointment.id, values.charge.id, values.appointment.id,
  values.appointmentVersionId, values.chargeVersionId, values.auditId,
).first()

export async function createAppointment(input) {
  const command = captureCommand(input)
  const actor = actorFact(command.actor)
  const requestDigest = await digestNormalized(command.body)
  const idem = Object.freeze({
    actorId: actor.id, operation: OPERATION, idempotencyKey: command.idempotencyKey,
    requestDigest, resourceType: 'client', scopeType: 'client', scopePurpose: 'identity',
  })
  const replay = await inspectStoredScopeIdempotency(command.db, command.keyring, idem)
  if (replay) return validateReplay(replay, command.body)

  const current = scopedRow(await loadScopedClient(command.db, command.body, actor), command.body)
  if (!authorize(actor, 'appointment.manage', {
    kind: 'appointment', appointmentId: PROSPECTIVE_APPOINTMENT_ID,
    specialistId: command.body.specialistId,
  }, { nowMs: command.nowMs })) notFound()
  const context = await loadClientCryptoContext(command.db, command.keyring, {
    clientId: current.id, envelope: current.identityEnvelope,
  })
  const identity = await decryptClientIdentity(context, {
    clientId: current.id, envelope: current.identityEnvelope,
  })
  await authenticateClientVersions(
    context, current, identity, await loadClientVersions(command.db, current.id),
  )
  await authenticateAssignmentVersions(
    context, current, await loadAssignmentVersions(command.db, current.id),
  )
  if (overlapFact(await loadOverlap(command.db, command.body))) {
    throw new Error('APPOINTMENT_OVERLAP')
  }

  let now
  try { now = new Date(command.nowMs).toISOString() } catch { throw new Error('INTERNAL_ERROR') }
  const used = new Set()
  const appointmentId = generated(command.idFactory, 'apt', isAppointmentId, used)
  const chargeId = generated(command.idFactory, 'chg', isChargeId, used)
  const appointmentVersionId = generated(command.idFactory, 'ver', isVersionId, used)
  const chargeVersionId = generated(command.idFactory, 'ver', isVersionId, used)
  const auditId = generated(command.idFactory, 'aud', isAuditId, used)
  const appointment = Object.freeze({
    id: appointmentId, clientId: current.id, specialistId: command.body.specialistId,
    serviceId: command.body.serviceId, startsAt: command.body.startsAt,
    endsAt: command.body.endsAt, timeZone: 'Europe/Warsaw', location: command.body.location,
    status: command.body.status, source: 'panel', version: 1, cancelledAt: null,
    createdAt: now, updatedAt: now,
    paymentAggregate: Object.freeze({
      status: 'unpaid', collectedGrosze: 0,
      outstandingGrosze: ['completed', 'noshow'].includes(command.body.status)
        ? command.body.expectedAmountGrosze : 0,
    }),
  })
  const charge = Object.freeze({
    id: chargeId, appointmentId, serviceId: command.body.serviceId,
    expectedAmountGrosze: command.body.expectedAmountGrosze,
    currency: 'PLN', version: 1, createdAt: now, updatedAt: now,
  })
  const appointmentVersion = await versionBuilder.build(command.db, context, {
    clientId: current.id, versionId: appointmentVersionId, entityType: 'appointment',
    entity: appointment, changedByStaffId: actor.id, changedAt: now,
    correlationId: command.correlationId, ownerFact: null,
  })
  const chargeOwner = ownership.issuer.issueCharge(Object.freeze({
    clientId: current.id, appointmentId,
  }))
  const chargeVersion = await versionBuilder.build(command.db, context, {
    clientId: current.id, versionId: chargeVersionId, entityType: 'session_charge',
    entity: charge, changedByStaffId: actor.id, changedAt: now,
    correlationId: command.correlationId, ownerFact: chargeOwner,
  })
  const response = Object.freeze({ status: 201, body: Object.freeze({
    data: Object.freeze({ appointment: appointmentDto(appointment, charge) }),
  }) })
  const idempotency = await createIdempotencyStatement(command.db, context, {
    actorId: actor.id, operation: OPERATION, idempotencyKey: command.idempotencyKey,
    requestDigest, expectedScope: context.scope, resourceType: 'client',
    resourceId: current.id, response, createdAt: now,
    expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  })
  const guardValues = {
    appointment, charge, client: current, now, actorId: actor.id,
    practitionerStaffId: current.practitionerStaffId, appointmentVersionId,
    chargeVersionId, auditId, correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey, dataKeyId: context.dataKey.id,
  }
  const uow = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  uow.domain(command.db.prepare(
    `INSERT INTO appointments
     (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,status,
      source,version,cancelled_at,created_at,updated_at)
     SELECT ?,?,?,?,?,?,'Europe/Warsaw',?,?,'panel',1,NULL,?,?
     WHERE NOT EXISTS (SELECT 1 FROM appointments WHERE specialist_id=?
       AND status!='cancelled' AND starts_at<? AND ?<ends_at)`
  ).bind(
    appointment.id, current.id, appointment.specialistId, appointment.serviceId,
    appointment.startsAt, appointment.endsAt, appointment.location, appointment.status,
    now, now, appointment.specialistId, appointment.endsAt, appointment.startsAt,
  ))
  uow.domain(command.db.prepare(
    `INSERT INTO session_charges
     (id,appointment_id,service_id,expected_amount_grosze,currency,version,created_at,updated_at)
     SELECT ?,?,?,?,'PLN',1,?,? WHERE EXISTS (SELECT 1 FROM appointments WHERE id=?)`
  ).bind(charge.id, appointment.id, charge.serviceId, charge.expectedAmountGrosze,
    now, now, appointment.id))
  uow.version(appointmentVersion.statement)
  uow.version(chargeVersion.statement)
  uow.audit(auditEventStatement(command.db, {
    id: auditId, occurredAt: now, actorStaffId: actor.id, action: 'appointment.created',
    entityType: 'appointment', entityId: appointment.id, result: 'success',
    correlationId: command.correlationId,
    metadata: { appointmentVersion: 1, chargeVersion: 1 }, reasonEnvelope: null,
  }))
  uow.idempotency(idempotency)
  uow.guard(guardStatement(command.db, guardValues))
  try {
    await uow.commit()
    return response
  } catch (originalError) {
    if (isD1IdentityCollision(originalError)) {
      let collision
      try {
        collision = captureExact(
          await idempotencyCollisionProof(command.db, guardValues),
          ['stored', 'generated_collision'], cryptoFailure,
        )
      } catch { throw originalError }
      if (![0, 1].includes(collision.stored)
        || ![0, 1].includes(collision.generated_collision)) throw originalError
      if (collision.stored === 1 && collision.generated_collision === 0) {
        const recovered = await recoverStoredScopeIdempotencyAfterCollision(
          command.recoveryDb, command.keyring, idem, originalError,
        )
        return validateReplay(recovered, command.body)
      }
    }
    let proof
    try { proof = await overlapProof(command.db, guardValues) } catch { throw originalError }
    const fact = captureExact(proof, ['proven'], cryptoFailure)
    if (fact.proven === 1) throw new Error('APPOINTMENT_OVERLAP')
    throw originalError
  }
}
