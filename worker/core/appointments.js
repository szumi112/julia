import { encodeBase64Url } from '../security/encoding.js'
import { decryptForScope } from '../security/envelope.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectStoredScopeIdempotency,
  recoverStoredScopeIdempotencyAfterCollision,
} from '../db/unit-of-work.js'
import { isD1CoreDirectoryInvariantFailure, isD1IdentityCollision } from '../db/errors.js'
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
  isCorrectionId,
  isOpaqueId,
  isPaymentId,
  isSpecialistId,
  isVersionId,
  validateAppointmentInput,
} from '../../src/core-records.js'
import { SERVICE_BY_ID } from '../../src/services.js'

const BODY_KEYS = Object.freeze([
  'clientId', 'specialistId', 'serviceId', 'date', 'time', 'durationMinutes',
  'expectedAmountGrosze', 'location', 'status',
])
const EDIT_BODY_KEYS = Object.freeze(['expectedVersion', ...BODY_KEYS.slice(1)])
const CANCEL_BODY_KEYS = Object.freeze(['expectedVersion'])
const INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPERATION = 'appointments.create'
const EDIT_OPERATION = 'appointments.edit'
const CANCEL_OPERATION = 'appointments.cancel'
const ROUTE_TARGET = 'POST /api/v1/appointments'
const PROSPECTIVE_APPOINTMENT_ID = 'apt_authorization_target'
const DAY_MS = 86_400_000
const ownership = createOwnershipCapabilityBoundary()
const versionBuilder = createRecordVersionBuilder(ownership.consumer)

const validation = (field) => { throw new TypeError(`VALIDATION_FAILED/${field}`) }
const notFound = () => { throw new Error('NOT_FOUND') }
const cryptoFailure = () => { throw new Error('CRYPTO_FAILURE') }
const binaryCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0

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

export function validateEditAppointmentBody(value) {
  const captured = captureExact(value, EDIT_BODY_KEYS)
  if (!Number.isSafeInteger(captured.expectedVersion) || captured.expectedVersion < 1) {
    validation('expectedVersion')
  }
  const appointment = validateCreateAppointmentBody(Object.freeze({
    clientId: 'cl_edit_validation',
    specialistId: captured.specialistId,
    serviceId: captured.serviceId,
    date: captured.date,
    time: captured.time,
    durationMinutes: captured.durationMinutes,
    expectedAmountGrosze: captured.expectedAmountGrosze,
    location: captured.location,
    status: captured.status,
  }))
  return Object.freeze({
    expectedVersion: captured.expectedVersion,
    specialistId: appointment.specialistId,
    serviceId: appointment.serviceId,
    date: appointment.date,
    time: appointment.time,
    durationMinutes: appointment.durationMinutes,
    expectedAmountGrosze: appointment.expectedAmountGrosze,
    location: appointment.location,
    status: appointment.status,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    timeZone: appointment.timeZone,
  })
}

export function validateCancelAppointmentBody(value) {
  const captured = captureExact(value, CANCEL_BODY_KEYS)
  if (!Number.isSafeInteger(captured.expectedVersion) || captured.expectedVersion < 1) {
    validation('expectedVersion')
  }
  return Object.freeze({ expectedVersion: captured.expectedVersion })
}

const digestCancelNormalized = async (appointmentId, body) => {
  const encoded = new TextEncoder().encode(JSON.stringify({
    body: { expectedVersion: body.expectedVersion },
    route: `POST /api/v1/appointments/${appointmentId}/cancellation`,
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

export async function digestCancelAppointmentRequest(appointmentId, value) {
  if (typeof appointmentId !== 'string' || !isAppointmentId(appointmentId)) {
    validation('appointmentId')
  }
  return digestCancelNormalized(appointmentId, validateCancelAppointmentBody(value))
}

const digestEditNormalized = async (appointmentId, body) => {
  const encoded = new TextEncoder().encode(JSON.stringify({
    body: {
      date: body.date,
      durationMinutes: body.durationMinutes,
      endsAt: body.endsAt,
      expectedAmountGrosze: body.expectedAmountGrosze,
      expectedVersion: body.expectedVersion,
      location: body.location,
      serviceId: body.serviceId,
      specialistId: body.specialistId,
      startsAt: body.startsAt,
      status: body.status,
      time: body.time,
      timeZone: body.timeZone,
    },
    route: `POST /api/v1/appointments/${appointmentId}/edits`,
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

export async function digestEditAppointmentRequest(appointmentId, value) {
  if (typeof appointmentId !== 'string' || !isAppointmentId(appointmentId)) {
    validation('appointmentId')
  }
  return digestEditNormalized(appointmentId, validateEditAppointmentBody(value))
}

export function assertAppointmentPaymentTransition(value) {
  const fact = captureExact(value, [
    'currentStatus', 'currentAmountGrosze', 'proposedStatus',
    'proposedAmountGrosze', 'collectedGrosze',
  ], () => { throw new Error('INTERNAL_ERROR') })
  if (!['scheduled', 'completed', 'noshow'].includes(fact.currentStatus)
    || !['scheduled', 'completed', 'noshow'].includes(fact.proposedStatus)
    || !Number.isSafeInteger(fact.currentAmountGrosze) || fact.currentAmountGrosze < 1
    || !Number.isSafeInteger(fact.proposedAmountGrosze) || fact.proposedAmountGrosze < 1
    || !Number.isSafeInteger(fact.collectedGrosze) || fact.collectedGrosze < 0) {
    throw new Error('INTERNAL_ERROR')
  }
  if (fact.collectedGrosze > 0
    && (!['completed', 'noshow'].includes(fact.proposedStatus)
      || fact.proposedAmountGrosze < fact.currentAmountGrosze
      || fact.proposedAmountGrosze < fact.collectedGrosze)) {
    throw new Error('APPOINTMENT_PAYMENT_CONFLICT')
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

const resultRows = (value, maxRows) => {
  try {
    if (!Number.isSafeInteger(maxRows) || maxRows < 0 || maxRows > 1_001) notFound()
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) notFound()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (!keys.includes('results') || keys.some((key) => typeof key !== 'string'
      || !['results', 'success', 'meta'].includes(key))) notFound()
    const descriptor = descriptors.results
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
      || !Array.isArray(descriptor.value)
      || Object.getPrototypeOf(descriptor.value) !== Array.prototype) notFound()
    const rowDescriptors = Object.getOwnPropertyDescriptors(descriptor.value)
    const rowKeys = Reflect.ownKeys(rowDescriptors)
    const lengthDescriptor = rowDescriptors.length
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
      || lengthDescriptor.value > maxRows || rowKeys.length !== lengthDescriptor.value + 1
      || rowKeys.some((key) => typeof key !== 'string'
        || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) notFound()
    const rows = []
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const rowDescriptor = rowDescriptors[index]
      if (!rowDescriptor || !Object.hasOwn(rowDescriptor, 'value')
        || !rowDescriptor.enumerable) notFound()
      rows.push(rowDescriptor.value)
    }
    return Object.freeze(rows)
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') throw error
    notFound()
  }
}

const loadClientVersions = (db, clientId) => db.prepare(
  `SELECT id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
          changed_at,correlation_id
   FROM record_versions WHERE entity_id=?
   ORDER BY version,id LIMIT 257`
).bind(clientId).all()

const authenticateClientVersions = async (context, current, identity, value) => {
  const rows = resultRows(value, 256)
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
  const rows = resultRows(value, 256)
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
      || row.created_at !== row.starts_at
      || row.updated_at !== (row.ends_at ?? row.created_at)
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
    binaryCompare(left.row.starts_at, right.row.starts_at)
      || binaryCompare(left.row.id, right.row.id))
  if (ordered.filter(({ row }) => row.ends_at === null).length !== 1
    || ordered.at(-1)?.row.ends_at !== null) notFound()
  for (let groupIndex = 0; groupIndex < ordered.length; groupIndex += 1) {
    const group = ordered[groupIndex]
    const isTerminalOpen = groupIndex === ordered.length - 1
    if ((isTerminalOpen && (group.row.ends_at !== null || group.row.assignment_version !== 1))
      || (!isTerminalOpen && (group.row.ends_at === null || group.row.assignment_version !== 2))
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

const loadStoredOperationPresence = (db, input) => db.prepare(
  `SELECT 1 AS stored FROM idempotency_records
   WHERE actor_id=? AND operation=? AND idempotency_key=? LIMIT 1`
).bind(input.actorId, input.operation, input.idempotencyKey).first()

const storedOperationExists = (value) => {
  if (value === null) return false
  const row = captureExact(value, ['stored'], cryptoFailure)
  if (row.stored !== 1) cryptoFailure()
  return true
}

// Constructed only after the bounded work read proves the exact authoritative
// actor/operation/key row exists, adapting that proven identity collision to the
// frozen two-read reserve recovery helper.
const identityCollisionSignal = () => new Error(
  'identity_collision: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)'
)

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

const assignmentChainPostcondition = (clientId, specialistId, startsAt) => Object.freeze({
  sql: `(SELECT count(*) FROM client_assignments AS root
      WHERE root.client_id=? AND (SELECT count(*) FROM client_assignments AS predecessor
        WHERE predecessor.client_id=root.client_id
          AND predecessor.ends_at=root.starts_at)=0)=1
    AND (SELECT count(*) FROM client_assignments
      WHERE client_id=? AND ends_at IS NULL)=1
    AND NOT EXISTS (SELECT 1 FROM client_assignments AS retained
      WHERE retained.client_id=? AND (
        (retained.ends_at IS NULL AND retained.version!=1)
        OR (retained.ends_at IS NOT NULL AND retained.version!=2)
        OR retained.created_at!=retained.starts_at
        OR retained.updated_at!=coalesce(retained.ends_at,retained.created_at)
        OR (SELECT count(*) FROM client_assignments AS predecessor
          WHERE predecessor.client_id=retained.client_id
            AND predecessor.ends_at=retained.starts_at)>1
        OR (retained.ends_at IS NOT NULL AND
          (SELECT count(*) FROM client_assignments AS successor
            WHERE successor.client_id=retained.client_id
              AND successor.starts_at=retained.ends_at)!=1)))
    AND (SELECT count(*) FROM client_assignments
      WHERE client_id=? AND starts_at<=?
        AND (ends_at IS NULL OR ?<ends_at))=1
    AND (SELECT count(*) FROM client_assignments
      WHERE client_id=? AND specialist_id=? AND starts_at<=?
        AND (ends_at IS NULL OR ?<ends_at))=1`,
  bindings: Object.freeze([
    clientId, clientId, clientId,
    clientId, startsAt, startsAt,
    clientId, specialistId, startsAt, startsAt,
  ]),
})

const guardStatement = (db, values) => {
  const lifecycle = specialistPostcondition(values.practitionerStaffId)
  const assignmentChain = assignmentChainPostcondition(
    values.client.id, values.appointment.specialistId, values.appointment.startsAt,
  )
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
       AND NOT EXISTS (SELECT 1 FROM record_versions WHERE
         (entity_id=? AND entity_type!='appointment')
         OR (entity_id=? AND entity_type!='session_charge'))
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
       AND EXISTS (SELECT 1 FROM clients WHERE id=? AND status IN ('active','paused')
         AND archived_at IS NULL AND version=? AND identity_envelope=?)
       AND (SELECT count(*) FROM record_versions
         WHERE entity_type='client' AND entity_id=?)=?
       AND (SELECT min(version) FROM record_versions
         WHERE entity_type='client' AND entity_id=?)=1
       AND (SELECT max(version) FROM record_versions
         WHERE entity_type='client' AND entity_id=?)=?
       AND NOT EXISTS (SELECT 1 FROM record_versions
         WHERE entity_id=? AND entity_type!='client')
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
       AND (${assignmentChain.sql})
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
    values.appointment.id, values.charge.id,
    values.appointmentVersionId, values.appointment.id, values.dataKeyId,
    values.chargeVersionId, values.charge.id, values.dataKeyId,
    values.auditId, values.actorId, values.appointment.id, values.correlationId,
    JSON.stringify({ appointmentVersion: 1, chargeVersion: 1 }),
    values.actorId, OPERATION, values.idempotencyKey, values.client.id,
    values.dataKeyId, values.dataKeyId, values.dataKeyId, values.client.id,
    values.client.id, values.client.version,
    values.client.identityEnvelope,
    values.client.id, values.client.version, values.client.id,
    values.client.id, values.client.version, values.client.id,
    values.client.id, values.dataKeyId,
    values.client.id, values.client.id, values.dataKeyId,
    ...assignmentChain.bindings,
    values.appointment.specialistId,
    values.practitionerStaffId, values.appointment.specialistId, values.appointment.id,
    values.appointment.endsAt, values.appointment.startsAt, values.appointment.id,
    ...lifecycle.bindings,
  )
}

const overlapProof = async (db, values) => {
  const lifecycle = specialistPostcondition(values.practitionerStaffId)
  const assignmentChain = assignmentChainPostcondition(
    values.client.id, values.appointment.specialistId, values.appointment.startsAt,
  )
  return db.prepare(
    `SELECT CASE WHEN
     EXISTS (SELECT 1 FROM appointments WHERE specialist_id=? AND status!='cancelled'
       AND starts_at<? AND ?<ends_at)
     AND NOT EXISTS (SELECT 1 FROM appointments WHERE id=?)
     AND NOT EXISTS (SELECT 1 FROM session_charges WHERE id=? OR appointment_id=?)
     AND NOT EXISTS (SELECT 1 FROM record_versions
       WHERE id IN (?,?) OR entity_id IN (?,?))
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
       WHERE entity_id=? AND entity_type!='client')
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
     AND (${assignmentChain.sql})
     AND EXISTS (SELECT 1 FROM specialists AS specialist JOIN staff_users AS staff
       ON staff.id=specialist.staff_user_id AND staff.specialist_id=specialist.id
       WHERE specialist.id=? AND specialist.staff_user_id=?
         AND specialist.status='active' AND staff.status='active')
     AND (${lifecycle.sql})
     THEN 1 ELSE 0 END AS proven`
  ).bind(
    values.appointment.specialistId, values.appointment.endsAt, values.appointment.startsAt,
    values.appointment.id, values.charge.id, values.appointment.id,
    values.appointmentVersionId, values.chargeVersionId,
    values.appointment.id, values.charge.id, values.auditId,
    values.actorId, OPERATION, values.idempotencyKey,
    values.client.id, values.client.version, values.client.identityEnvelope,
    values.dataKeyId, values.client.id,
    values.client.id, values.client.version, values.client.id,
    values.client.id, values.client.version, values.client.id,
    values.client.id, values.dataKeyId,
    values.client.id, values.client.id, values.dataKeyId,
    ...assignmentChain.bindings,
    values.appointment.specialistId,
    values.practitionerStaffId, ...lifecycle.bindings,
  ).first()
}

const idempotencyCollisionProof = async (db, values) => db.prepare(
  `SELECT CASE WHEN EXISTS (SELECT 1 FROM idempotency_records
       WHERE actor_id=? AND operation=? AND idempotency_key=?)
     THEN 1 ELSE 0 END AS stored,
   CASE WHEN EXISTS (SELECT 1 FROM appointments WHERE id=?)
       OR EXISTS (SELECT 1 FROM session_charges WHERE id=? OR appointment_id=?)
       OR EXISTS (SELECT 1 FROM record_versions
         WHERE id IN (?,?) OR entity_id IN (?,?))
       OR EXISTS (SELECT 1 FROM audit_events WHERE id=?)
     THEN 1 ELSE 0 END AS generated_collision`
).bind(
  values.actorId, OPERATION, values.idempotencyKey,
  values.appointment.id, values.charge.id, values.appointment.id,
  values.appointmentVersionId, values.chargeVersionId,
  values.appointment.id, values.charge.id, values.auditId,
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
    if (storedOperationExists(await loadStoredOperationPresence(command.db, idem))) {
      const winner = await recoverStoredScopeIdempotencyAfterCollision(
        command.recoveryDb, command.keyring, idem, identityCollisionSignal(),
      )
      return validateReplay(winner, command.body)
    }
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

const EDIT_INPUT_KEYS = Object.freeze([
  ...INPUT_KEYS.slice(0, 7), 'appointmentId', ...INPUT_KEYS.slice(7),
])

const captureEditCommand = (input) => {
  const captured = captureExact(input, EDIT_INPUT_KEYS)
  if (!captured.db?.prepare || !captured.db?.batch || !captured.recoveryDb?.prepare
    || !captured.keyring || typeof captured.idFactory !== 'function'
    || !Number.isSafeInteger(captured.nowMs) || captured.nowMs < 0
    || typeof captured.correlationId !== 'string' || !CORRELATION_ID.test(captured.correlationId)
    || typeof captured.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(captured.idempotencyKey)) validation('body')
  if (typeof captured.appointmentId !== 'string'
    || !isAppointmentId(captured.appointmentId)) validation('appointmentId')
  return Object.freeze({
    ...captured,
    body: validateEditAppointmentBody(captured.body),
  })
}

const versionConflict = (currentVersion) => {
  const error = new Error('VERSION_CONFLICT')
  Object.defineProperty(error, 'details', {
    enumerable: true,
    value: Object.freeze({ currentVersion }),
  })
  throw error
}

const loadScopedAppointmentForEdit = (db, appointmentId, body, actor) => db.prepare(
  `SELECT appointment.id,appointment.client_id,appointment.specialist_id,
          appointment.service_id,appointment.starts_at,appointment.ends_at,
          appointment.time_zone,appointment.location,appointment.status,
          appointment.source,appointment.version,appointment.cancelled_at,
          appointment.created_at,appointment.updated_at,
          charge.id AS charge_id,charge.appointment_id AS charge_appointment_id,
          charge.service_id AS charge_service_id,
          charge.expected_amount_grosze,charge.currency,
          charge.version AS charge_version,charge.created_at AS charge_created_at,
          charge.updated_at AS charge_updated_at,
          client.identity_envelope,client.status AS client_status,
          client.version AS client_version,client.archived_at,
          client.created_at AS client_created_at,client.updated_at AS client_updated_at,
          assignment.id AS assignment_id,assignment.specialist_id AS assignment_specialist_id,
          assignment.starts_at AS assignment_starts_at,assignment.ends_at AS assignment_ends_at,
          assignment.assigned_by_staff_id,assignment.version AS assignment_version,
          assignment.created_at AS assignment_created_at,
          assignment.updated_at AS assignment_updated_at,
          practitioner.staff_user_id AS practitioner_staff_id
   FROM appointments AS appointment
   JOIN session_charges AS charge ON charge.appointment_id=appointment.id
   JOIN clients AS client ON client.id=appointment.client_id
   JOIN client_assignments AS assignment ON assignment.client_id=client.id
     AND assignment.specialist_id=? AND assignment.starts_at<=?
     AND (assignment.ends_at IS NULL OR ?<assignment.ends_at)
   JOIN specialists AS practitioner ON practitioner.id=assignment.specialist_id
     AND practitioner.status='active'
   JOIN staff_users AS practitioner_staff
     ON practitioner_staff.id=practitioner.staff_user_id
    AND practitioner_staff.specialist_id=practitioner.id
    AND practitioner_staff.status='active'
   WHERE appointment.id=? AND appointment.status IN ('scheduled','completed','noshow')
     AND appointment.cancelled_at IS NULL
     AND client.status IN ('active','paused') AND client.archived_at IS NULL
     AND (? IN ('owner','coordinator')
       OR (?='specialist' AND ?=practitioner.id))
     AND (SELECT count(*) FROM session_charges AS exact_charge
       WHERE exact_charge.appointment_id=appointment.id)=1
     AND (SELECT count(*) FROM client_assignments AS effective
       WHERE effective.client_id=client.id AND effective.starts_at<=?
         AND (effective.ends_at IS NULL OR ?<effective.ends_at))=1`
).bind(
  body.specialistId, body.startsAt, body.startsAt, appointmentId,
  actor.role, actor.role, actor.specialistId, body.startsAt, body.startsAt,
).first()

const editScopedFact = (value, appointmentId, body) => {
  const row = captureExact(value, [
    'id', 'client_id', 'specialist_id', 'service_id', 'starts_at', 'ends_at',
    'time_zone', 'location', 'status', 'source', 'version', 'cancelled_at',
    'created_at', 'updated_at', 'charge_id', 'charge_appointment_id',
    'charge_service_id', 'expected_amount_grosze', 'currency', 'charge_version',
    'charge_created_at', 'charge_updated_at', 'identity_envelope', 'client_status',
    'client_version', 'archived_at', 'client_created_at', 'client_updated_at',
    'assignment_id', 'assignment_specialist_id', 'assignment_starts_at',
    'assignment_ends_at', 'assigned_by_staff_id', 'assignment_version',
    'assignment_created_at', 'assignment_updated_at', 'practitioner_staff_id',
  ], notFound)
  try { assertLocation(row.location) } catch { notFound() }
  if (row.id !== appointmentId || !isClientId(row.client_id)
    || !isSpecialistId(row.specialist_id) || !SERVICE_BY_ID[row.service_id]
    || !canonicalInstant(row.starts_at) || !canonicalInstant(row.ends_at)
    || row.ends_at <= row.starts_at || row.time_zone !== 'Europe/Warsaw'
    || !['scheduled', 'completed', 'noshow'].includes(row.status)
    || row.source !== 'panel' || !Number.isSafeInteger(row.version) || row.version < 1
    || row.cancelled_at !== null || !canonicalInstant(row.created_at)
    || !canonicalInstant(row.updated_at) || row.updated_at < row.created_at
    || !isChargeId(row.charge_id) || row.charge_appointment_id !== appointmentId
    || row.charge_service_id !== row.service_id
    || !Number.isSafeInteger(row.expected_amount_grosze)
    || row.expected_amount_grosze < 1 || row.expected_amount_grosze > 1_000_000
    || row.currency !== 'PLN' || !Number.isSafeInteger(row.charge_version)
    || row.charge_version < 1 || !canonicalInstant(row.charge_created_at)
    || !canonicalInstant(row.charge_updated_at)
    || row.charge_updated_at < row.charge_created_at
    || typeof row.identity_envelope !== 'string'
    || !['active', 'paused'].includes(row.client_status)
    || !Number.isSafeInteger(row.client_version) || row.client_version < 1
    || row.archived_at !== null || !canonicalInstant(row.client_created_at)
    || !canonicalInstant(row.client_updated_at)
    || !isAssignmentId(row.assignment_id)
    || row.assignment_specialist_id !== body.specialistId
    || !canonicalInstant(row.assignment_starts_at)
    || (row.assignment_ends_at !== null
      && (!canonicalInstant(row.assignment_ends_at)
        || row.assignment_ends_at <= row.assignment_starts_at))
    || !(row.assignment_starts_at <= body.startsAt
      && (row.assignment_ends_at === null || body.startsAt < row.assignment_ends_at))
    || typeof row.assigned_by_staff_id !== 'string' || !STAFF_ID.test(row.assigned_by_staff_id)
    || !Number.isSafeInteger(row.assignment_version) || row.assignment_version < 1
    || !canonicalInstant(row.assignment_created_at)
    || !canonicalInstant(row.assignment_updated_at)
    || typeof row.practitioner_staff_id !== 'string'
    || !STAFF_ID.test(row.practitioner_staff_id)) notFound()
  return Object.freeze({
    appointment: Object.freeze({
      id: row.id, clientId: row.client_id, specialistId: row.specialist_id,
      serviceId: row.service_id, startsAt: row.starts_at, endsAt: row.ends_at,
      timeZone: row.time_zone, location: row.location, status: row.status,
      source: row.source, version: row.version, cancelledAt: null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }),
    charge: Object.freeze({
      id: row.charge_id, appointmentId: row.id, serviceId: row.charge_service_id,
      expectedAmountGrosze: row.expected_amount_grosze, currency: row.currency,
      version: row.charge_version, createdAt: row.charge_created_at,
      updatedAt: row.charge_updated_at,
    }),
    client: Object.freeze({
      id: row.client_id, identityEnvelope: row.identity_envelope,
      status: row.client_status, version: row.client_version, archivedAt: null,
      createdAt: row.client_created_at, updatedAt: row.client_updated_at,
      assignment: Object.freeze({
        id: row.assignment_id, clientId: row.client_id,
        specialistId: row.assignment_specialist_id, startsAt: row.assignment_starts_at,
        endsAt: row.assignment_ends_at, assignedByStaffId: row.assigned_by_staff_id,
        version: row.assignment_version, createdAt: row.assignment_created_at,
        updatedAt: row.assignment_updated_at,
      }),
    }),
    practitionerStaffId: row.practitioner_staff_id,
  })
}

const loadEntityVersions = (db, entityId) => db.prepare(
  `SELECT id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
          changed_at,correlation_id
   FROM record_versions WHERE entity_id=? ORDER BY version,id LIMIT 258`
).bind(entityId).all()

const retainedVersionRows = (value, entityType, entityId, currentVersion) => {
  const rows = resultRows(value, 257)
  if (rows.length !== currentVersion || rows.length < 1 || rows.length > 257) notFound()
  const ids = new Set()
  return rows.map((candidate, index) => {
    const row = captureExact(candidate, [
      'id', 'entity_type', 'entity_id', 'version', 'snapshot_envelope',
      'changed_by_staff_id', 'changed_at', 'correlation_id',
    ], notFound)
    if (!isVersionId(row.id) || ids.has(row.id) || row.entity_type !== entityType
      || row.entity_id !== entityId || row.version !== index + 1
      || typeof row.snapshot_envelope !== 'string'
      || typeof row.changed_by_staff_id !== 'string' || !STAFF_ID.test(row.changed_by_staff_id)
      || !canonicalInstant(row.changed_at) || typeof row.correlation_id !== 'string'
      || !isOpaqueId(row.correlation_id)) notFound()
    ids.add(row.id)
    return Object.freeze(row)
  })
}

const decryptRetainedSnapshot = async (context, entityId, envelope) => {
  try {
    const plaintext = await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope, recordId: entityId, field: 'record_version',
      envelope: JSON.parse(envelope),
    })
    const parsed = JSON.parse(plaintext)
    if (JSON.stringify(parsed) !== plaintext) notFound()
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') throw error
    notFound()
  }
}

const paymentAggregateFor = (status, amount, collected) => Object.freeze({
  status: collected === 0 ? 'unpaid' : collected === amount ? 'paid' : 'partial',
  collectedGrosze: collected,
  outstandingGrosze: ['completed', 'noshow'].includes(status) ? amount - collected : 0,
})

const authenticateAppointmentVersions = async (context, current, aggregate, value) => {
  const rows = retainedVersionRows(value, 'appointment', current.id, current.version)
  let previousUpdatedAt = null
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const snapshot = captureExact(
      await decryptRetainedSnapshot(context, current.id, row.snapshot_envelope),
      [
        'cancelledAt', 'clientId', 'createdAt', 'endsAt', 'id', 'location',
        'paymentAggregate', 'schema', 'serviceId', 'source', 'specialistId',
        'startsAt', 'status', 'timeZone', 'updatedAt', 'version',
      ],
      notFound,
    )
    const payment = captureExact(snapshot.paymentAggregate, [
      'collectedGrosze', 'outstandingGrosze', 'status',
    ], notFound)
    try { assertLocation(snapshot.location) } catch { notFound() }
    if (snapshot.schema !== 'appointment.v1' || snapshot.id !== current.id
      || snapshot.clientId !== current.clientId || snapshot.source !== current.source
      || snapshot.createdAt !== current.createdAt || snapshot.version !== row.version
      || !isSpecialistId(snapshot.specialistId) || !SERVICE_BY_ID[snapshot.serviceId]
      || !canonicalInstant(snapshot.startsAt) || !canonicalInstant(snapshot.endsAt)
      || snapshot.endsAt <= snapshot.startsAt || snapshot.timeZone !== 'Europe/Warsaw'
      || !['scheduled', 'completed', 'noshow', 'cancelled'].includes(snapshot.status)
      || ((snapshot.status === 'cancelled') !== (snapshot.cancelledAt !== null))
      || (snapshot.cancelledAt !== null
        && (!canonicalInstant(snapshot.cancelledAt)
          || snapshot.cancelledAt !== snapshot.updatedAt
          || index !== rows.length - 1))
      || snapshot.updatedAt !== row.changed_at
      || (previousUpdatedAt !== null && snapshot.updatedAt <= previousUpdatedAt)
      || !['unpaid', 'partial', 'paid'].includes(payment.status)
      || !Number.isSafeInteger(payment.collectedGrosze) || payment.collectedGrosze < 0
      || !Number.isSafeInteger(payment.outstandingGrosze) || payment.outstandingGrosze < 0) {
      notFound()
    }
    previousUpdatedAt = snapshot.updatedAt
    if (index === rows.length - 1 && (
      snapshot.specialistId !== current.specialistId
      || snapshot.serviceId !== current.serviceId || snapshot.startsAt !== current.startsAt
      || snapshot.endsAt !== current.endsAt || snapshot.location !== current.location
      || snapshot.status !== current.status || snapshot.cancelledAt !== current.cancelledAt
      || snapshot.updatedAt !== current.updatedAt
      || payment.status !== aggregate.status
      || payment.collectedGrosze !== aggregate.collectedGrosze
      || payment.outstandingGrosze !== aggregate.outstandingGrosze
    )) notFound()
  }
}

const authenticateChargeVersions = async (context, current, value) => {
  const rows = retainedVersionRows(value, 'session_charge', current.id, current.version)
  let previousUpdatedAt = null
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const snapshot = captureExact(
      await decryptRetainedSnapshot(context, current.id, row.snapshot_envelope),
      [
        'appointmentId', 'createdAt', 'currency', 'expectedAmountGrosze', 'id',
        'schema', 'serviceId', 'updatedAt', 'version',
      ],
      notFound,
    )
    if (snapshot.schema !== 'session_charge.v1' || snapshot.id !== current.id
      || snapshot.appointmentId !== current.appointmentId
      || snapshot.currency !== 'PLN' || snapshot.createdAt !== current.createdAt
      || snapshot.version !== row.version || !SERVICE_BY_ID[snapshot.serviceId]
      || !Number.isSafeInteger(snapshot.expectedAmountGrosze)
      || snapshot.expectedAmountGrosze < 1 || snapshot.expectedAmountGrosze > 1_000_000
      || snapshot.updatedAt !== row.changed_at
      || (previousUpdatedAt !== null && snapshot.updatedAt <= previousUpdatedAt)) notFound()
    previousUpdatedAt = snapshot.updatedAt
    if (index === rows.length - 1 && (
      snapshot.serviceId !== current.serviceId
      || snapshot.expectedAmountGrosze !== current.expectedAmountGrosze
      || snapshot.updatedAt !== current.updatedAt
    )) notFound()
  }
}

const loadPaymentHistory = (db, appointmentId) => db.prepare(
  `SELECT payment.id,payment.appointment_id,payment.amount_grosze,payment.method,
          payment.received_at,payment.recorded_by_staff_id,
          payment.external_reference_envelope,payment.created_at AS payment_created_at,
          correction.id AS correction_id,correction.reversed_entry_id,
          correction.replacement_entry_id,correction.reason_envelope,
          correction.recorded_by_staff_id AS correction_recorded_by_staff_id,
          correction.created_at AS corrected_at
   FROM payment_entries AS payment
   LEFT JOIN payment_corrections AS correction ON correction.reversed_entry_id=payment.id
   WHERE payment.appointment_id=? ORDER BY payment.received_at,payment.id LIMIT 1001`
).bind(appointmentId).all()

const authenticatePaymentHistory = async (
  context, appointment, charge, value, allowNonbillableCollected = false,
) => {
  const rows = resultRows(value, 1_001)
  if (rows.length > 1_000) notFound()
  const ids = new Set()
  const corrections = new Set()
  const replacements = new Set()
  const captured = []
  for (const candidate of rows) {
    const row = captureExact(candidate, [
      'id', 'appointment_id', 'amount_grosze', 'method', 'received_at',
      'recorded_by_staff_id', 'external_reference_envelope', 'payment_created_at',
      'correction_id', 'reversed_entry_id', 'replacement_entry_id', 'reason_envelope',
      'correction_recorded_by_staff_id', 'corrected_at',
    ], notFound)
    if (!isPaymentId(row.id) || ids.has(row.id) || row.appointment_id !== appointment.id
      || !Number.isSafeInteger(row.amount_grosze) || row.amount_grosze < 1
      || row.amount_grosze > 1_000_000
      || !['cash', 'card', 'transfer', 'monthly'].includes(row.method)
      || !canonicalInstant(row.received_at) || !canonicalInstant(row.payment_created_at)
      || row.payment_created_at < appointment.createdAt
      || row.payment_created_at > appointment.updatedAt
      || typeof row.recorded_by_staff_id !== 'string' || !STAFF_ID.test(row.recorded_by_staff_id)
      || row.external_reference_envelope !== null) notFound()
    ids.add(row.id)
    const nullCorrection = row.correction_id === null && row.reversed_entry_id === null
      && row.replacement_entry_id === null && row.reason_envelope === null
      && row.correction_recorded_by_staff_id === null && row.corrected_at === null
    if (!nullCorrection) {
      if (!isCorrectionId(row.correction_id) || corrections.has(row.correction_id)
        || row.reversed_entry_id !== row.id
        || (row.replacement_entry_id !== null && (!isPaymentId(row.replacement_entry_id)
          || replacements.has(row.replacement_entry_id)))
        || typeof row.reason_envelope !== 'string'
        || typeof row.correction_recorded_by_staff_id !== 'string'
        || !STAFF_ID.test(row.correction_recorded_by_staff_id)
        || !canonicalInstant(row.corrected_at)
        || row.corrected_at < row.payment_created_at
        || row.corrected_at > appointment.updatedAt) notFound()
      corrections.add(row.correction_id)
      if (row.replacement_entry_id !== null) replacements.add(row.replacement_entry_id)
      try {
        const reason = await decryptForScope(context.keyring, context.dataKey, {
          expectedScope: context.scope, recordId: row.correction_id, field: 'reason',
          envelope: JSON.parse(row.reason_envelope),
        })
        const encoded = new TextEncoder().encode(reason)
        const valid = typeof reason === 'string' && reason === reason.trim()
          && reason === reason.normalize('NFC') && encoded.byteLength >= 1
          && encoded.byteLength <= 500
        encoded.fill(0)
        if (!valid) notFound()
      } catch (error) {
        if (error instanceof Error && error.message === 'NOT_FOUND') throw error
        notFound()
      }
    }
    captured.push(Object.freeze(row))
  }
  for (const row of captured) {
    if (row.replacement_entry_id !== null) {
      const replacement = captured.find(({ id }) => id === row.replacement_entry_id)
      if (!replacement || replacement.id === row.id
        || replacement.payment_created_at !== row.corrected_at) notFound()
    }
  }
  const links = new Map(captured.filter(({ replacement_entry_id }) => replacement_entry_id !== null)
    .map((row) => [row.id, row.replacement_entry_id]))
  for (const start of links.keys()) {
    const visited = new Set()
    let cursor = start
    while (links.has(cursor)) {
      if (visited.has(cursor)) notFound()
      visited.add(cursor)
      cursor = links.get(cursor)
    }
  }
  const effective = captured.filter(({ correction_id }) => correction_id === null)
  const collectedGrosze = effective.reduce((sum, row) => {
    const next = sum + row.amount_grosze
    if (!Number.isSafeInteger(next)) notFound()
    return next
  }, 0)
  if (collectedGrosze > charge.expectedAmountGrosze
    || (!allowNonbillableCollected
      && !['completed', 'noshow'].includes(appointment.status)
      && collectedGrosze !== 0)) notFound()
  const latest = effective.at(-1) ?? null
  const aggregate = paymentAggregateFor(
    appointment.status, charge.expectedAmountGrosze, collectedGrosze,
  )
  return Object.freeze({
    ...aggregate,
    latestMethod: latest?.method ?? null,
    latestReceivedAt: latest?.received_at ?? null,
    entries: Object.freeze(captured.map((row) => Object.freeze({
      id: row.id, amountGrosze: row.amount_grosze, method: row.method,
      receivedAt: row.received_at, correctedAt: row.corrected_at,
      replacementEntryId: row.replacement_entry_id,
    }))),
  })
}

const editAppointmentDto = (appointment, charge, payment) => Object.freeze({
  id: appointment.id, clientId: appointment.clientId,
  specialistId: appointment.specialistId, serviceId: appointment.serviceId,
  startsAt: appointment.startsAt, endsAt: appointment.endsAt,
  timeZone: appointment.timeZone, location: appointment.location,
  status: appointment.status, source: appointment.source, version: appointment.version,
  cancelledAt: appointment.cancelledAt, createdAt: appointment.createdAt,
  updatedAt: appointment.updatedAt,
  charge: Object.freeze({
    id: charge.id, serviceId: charge.serviceId,
    expectedAmountGrosze: charge.expectedAmountGrosze,
    currency: charge.currency, version: charge.version,
  }),
  payment: Object.freeze({
    status: payment.status, collectedGrosze: payment.collectedGrosze,
    outstandingGrosze: payment.outstandingGrosze,
    latestMethod: payment.latestMethod, latestReceivedAt: payment.latestReceivedAt,
  }),
  paymentEntries: Object.freeze(payment.entries.map((entry) => Object.freeze({ ...entry }))),
})

const validateEditReplay = (value, appointmentId, request) => {
  const replay = replayObject(value, ['status', 'body'])
  const body = replayObject(replay.body, ['data'])
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
  if (replay.status !== 200 || appointment.id !== appointmentId
    || !isClientId(appointment.clientId) || appointment.specialistId !== request.specialistId
    || appointment.serviceId !== request.serviceId || appointment.startsAt !== request.startsAt
    || appointment.endsAt !== request.endsAt || appointment.timeZone !== 'Europe/Warsaw'
    || appointment.location !== request.location || appointment.status !== request.status
    || appointment.source !== 'panel' || appointment.version !== request.expectedVersion + 1
    || appointment.cancelledAt !== null || !canonicalInstant(appointment.createdAt)
    || !canonicalInstant(appointment.updatedAt) || appointment.updatedAt < appointment.createdAt
    || !isChargeId(charge.id) || charge.serviceId !== request.serviceId
    || charge.expectedAmountGrosze !== request.expectedAmountGrosze
    || charge.currency !== 'PLN' || !Number.isSafeInteger(charge.version) || charge.version < 1
    || !['unpaid', 'partial', 'paid'].includes(payment.status)
    || !Number.isSafeInteger(payment.collectedGrosze) || payment.collectedGrosze < 0
    || payment.collectedGrosze > charge.expectedAmountGrosze
    || payment.outstandingGrosze !== (['completed', 'noshow'].includes(request.status)
      ? charge.expectedAmountGrosze - payment.collectedGrosze : 0)
    || payment.status !== (payment.collectedGrosze === 0 ? 'unpaid'
      : payment.collectedGrosze === charge.expectedAmountGrosze ? 'paid' : 'partial')
    || (payment.latestMethod !== null
      && !['cash', 'card', 'transfer', 'monthly'].includes(payment.latestMethod))
    || (payment.latestReceivedAt !== null && !canonicalInstant(payment.latestReceivedAt))
    || !Array.isArray(appointment.paymentEntries)
    || appointment.paymentEntries.length > 1_000
    || Reflect.ownKeys(Object.getOwnPropertyDescriptors(appointment.paymentEntries)).length
      !== appointment.paymentEntries.length + 1) cryptoFailure()
  const ids = new Set()
  const entries = appointment.paymentEntries.map((candidate) => {
    const entry = replayObject(candidate, [
      'id', 'amountGrosze', 'method', 'receivedAt', 'correctedAt', 'replacementEntryId',
    ])
    if (!isPaymentId(entry.id) || ids.has(entry.id)
      || !Number.isSafeInteger(entry.amountGrosze) || entry.amountGrosze < 1
      || entry.amountGrosze > 1_000_000
      || !['cash', 'card', 'transfer', 'monthly'].includes(entry.method)
      || !canonicalInstant(entry.receivedAt)
      || (entry.correctedAt !== null && !canonicalInstant(entry.correctedAt))
      || (entry.replacementEntryId !== null && !isPaymentId(entry.replacementEntryId))
      || (entry.correctedAt === null && entry.replacementEntryId !== null)
      || (entry.correctedAt !== null
        && (entry.correctedAt < appointment.createdAt
          || entry.correctedAt > appointment.updatedAt))) {
      cryptoFailure()
    }
    ids.add(entry.id)
    return Object.freeze(entry)
  })
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].receivedAt > entries[index].receivedAt
      || (entries[index - 1].receivedAt === entries[index].receivedAt
        && binaryCompare(entries[index - 1].id, entries[index].id) >= 0)) cryptoFailure()
  }
  const replacementTargets = new Set()
  const replacementLinks = new Map()
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]))
  for (const entry of entries) {
    if (entry.replacementEntryId === null) continue
    const replacement = entriesById.get(entry.replacementEntryId)
    if (!replacement || entry.replacementEntryId === entry.id
      || replacementTargets.has(entry.replacementEntryId)
      || (replacement.correctedAt !== null
        && replacement.correctedAt < entry.correctedAt)) cryptoFailure()
    replacementTargets.add(entry.replacementEntryId)
    replacementLinks.set(entry.id, entry.replacementEntryId)
  }
  for (const start of replacementLinks.keys()) {
    const path = new Set()
    let current = start
    while (replacementLinks.has(current)) {
      if (path.has(current)) cryptoFailure()
      path.add(current)
      current = replacementLinks.get(current)
    }
  }
  const effective = entries.filter(({ correctedAt }) => correctedAt === null)
  const collected = effective.reduce((sum, { amountGrosze }) => {
    const next = sum + amountGrosze
    if (!Number.isSafeInteger(next)) cryptoFailure()
    return next
  }, 0)
  const latest = effective.at(-1) ?? null
  if ((!['completed', 'noshow'].includes(request.status) && collected !== 0)
    || collected > charge.expectedAmountGrosze
    || collected !== payment.collectedGrosze
    || (latest?.method ?? null) !== payment.latestMethod
    || (latest?.receivedAt ?? null) !== payment.latestReceivedAt) cryptoFailure()
  const normalizedPayment = Object.freeze({ ...payment, entries: Object.freeze(entries) })
  return Object.freeze({ status: 200, body: Object.freeze({
    data: Object.freeze({ appointment: editAppointmentDto(appointment, charge, normalizedPayment) }),
  }) })
}

const conditionalVersionStatement = (db, version, conditionSql, bindings) => db.prepare(
  `INSERT INTO record_versions
   (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
    changed_at,correlation_id)
   SELECT ?,?,?,?,?,?,?,? WHERE ${conditionSql}`
).bind(
  version.row.id, version.row.entity_type, version.row.entity_id, version.row.version,
  version.row.snapshot_envelope, version.row.changed_by_staff_id,
  version.row.changed_at, version.row.correlation_id, ...bindings,
)

const editGuardStatement = (db, values) => {
  const assignmentChain = assignmentChainPostcondition(
    values.client.id, values.appointment.specialistId, values.appointment.startsAt,
  )
  const lifecycle = specialistPostcondition(values.practitionerStaffId)
  return db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'appointment_edit_postcondition'
     WHERE NOT (
       EXISTS (SELECT 1 FROM appointments WHERE id=? AND client_id=?
         AND specialist_id=? AND service_id=? AND starts_at=? AND ends_at=?
         AND time_zone='Europe/Warsaw' AND location IS ? AND status=?
         AND source=? AND version=? AND cancelled_at IS NULL
         AND created_at=? AND updated_at=?)
       AND (SELECT count(*) FROM appointments WHERE id=?)=1
       AND EXISTS (SELECT 1 FROM session_charges WHERE id=? AND appointment_id=?
         AND service_id=? AND expected_amount_grosze=? AND currency='PLN'
         AND version=? AND created_at=? AND updated_at=?)
       AND (SELECT count(*) FROM session_charges WHERE appointment_id=?)=1
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
       AND NOT EXISTS (SELECT 1 FROM record_versions WHERE
         (entity_id=? AND entity_type!='appointment')
         OR (entity_id=? AND entity_type!='session_charge'))
       AND EXISTS (SELECT 1 FROM record_versions WHERE id=?
         AND entity_type='appointment' AND entity_id=? AND version=?
         AND changed_by_staff_id=? AND changed_at=? AND correlation_id=?
         AND json_extract(snapshot_envelope,'$.dataKeyId')=?
         AND json_extract(snapshot_envelope,'$.dataKeyVersion')=1)
       ${values.chargeChanged ? `AND EXISTS (SELECT 1 FROM record_versions WHERE id=?
         AND entity_type='session_charge' AND entity_id=? AND version=?
         AND changed_by_staff_id=? AND changed_at=? AND correlation_id=?
         AND json_extract(snapshot_envelope,'$.dataKeyId')=?
         AND json_extract(snapshot_envelope,'$.dataKeyVersion')=1)` : ''}
       AND NOT EXISTS (SELECT 1 FROM record_versions WHERE
         (entity_id IN (?,?) AND (NOT json_valid(snapshot_envelope)
           OR json_extract(CASE WHEN json_valid(snapshot_envelope)
                THEN snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
           OR json_extract(CASE WHEN json_valid(snapshot_envelope)
                THEN snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1)))
       AND EXISTS (SELECT 1 FROM audit_events WHERE id=? AND actor_staff_id=?
         AND action='appointment.updated' AND entity_type='appointment' AND entity_id=?
         AND result='success' AND reason_envelope IS NULL AND correlation_id=?
         AND metadata_json=?)
       AND EXISTS (SELECT 1 FROM idempotency_records WHERE actor_id=? AND operation=?
         AND idempotency_key=? AND resource_type='client' AND resource_id=?
         AND json_extract(request_hash,'$.dataKeyId')=?
         AND json_extract(request_hash,'$.dataKeyVersion')=1
         AND json_extract(response_envelope,'$.dataKeyId')=?
         AND json_extract(response_envelope,'$.dataKeyVersion')=1)
       AND EXISTS (SELECT 1 FROM data_keys WHERE id=? AND scope_type='client'
         AND scope_id=? AND purpose='identity' AND dek_version=1 AND retired_at IS NULL)
       AND EXISTS (SELECT 1 FROM clients WHERE id=? AND identity_envelope=?
         AND status IN ('active','paused') AND archived_at IS NULL AND version=?)
       AND (SELECT count(*) FROM record_versions
         WHERE entity_type='client' AND entity_id=?)=?
       AND NOT EXISTS (SELECT 1 FROM record_versions
         WHERE entity_id=? AND entity_type!='client')
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
       AND (${assignmentChain.sql})
       AND EXISTS (SELECT 1 FROM specialists AS specialist JOIN staff_users AS staff
         ON staff.id=specialist.staff_user_id AND staff.specialist_id=specialist.id
         WHERE specialist.id=? AND specialist.staff_user_id=?
           AND specialist.status='active' AND staff.status='active')
       AND NOT EXISTS (SELECT 1 FROM appointments AS other WHERE other.specialist_id=?
         AND other.id!=? AND other.status!='cancelled'
         AND other.starts_at<? AND ?<other.ends_at)
       AND (SELECT count(*) FROM payment_entries WHERE appointment_id=?)=?
       AND NOT EXISTS (SELECT 1 FROM payment_entries AS payment
         WHERE payment.appointment_id=? AND (
           payment.amount_grosze<1 OR payment.amount_grosze>1000000
           OR payment.method NOT IN ('cash','card','transfer','monthly')
           OR payment.external_reference_envelope IS NOT NULL
           OR NOT EXISTS (SELECT 1 FROM staff_users WHERE id=payment.recorded_by_staff_id)))
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
       AND (SELECT coalesce(sum(payment.amount_grosze),0) FROM payment_entries AS payment
         WHERE payment.appointment_id=? AND NOT EXISTS (SELECT 1 FROM payment_corrections
           WHERE reversed_entry_id=payment.id))=?
       AND (?=0 OR (? IN ('completed','noshow') AND ?>=?))
       AND (${lifecycle.sql})
     )`
  ).bind(
    values.appointment.id, values.client.id, values.appointment.specialistId,
    values.appointment.serviceId, values.appointment.startsAt, values.appointment.endsAt,
    values.appointment.location, values.appointment.status, values.appointment.source,
    values.appointment.version, values.appointment.createdAt, values.now,
    values.appointment.id,
    values.charge.id, values.appointment.id, values.charge.serviceId,
    values.charge.expectedAmountGrosze, values.charge.version,
    values.charge.createdAt, values.charge.updatedAt, values.appointment.id,
    values.appointment.id, values.appointment.version,
    values.appointment.id, values.appointment.id, values.appointment.version,
    values.charge.id, values.charge.version, values.charge.id, values.charge.id,
    values.charge.version, values.appointment.id, values.charge.id,
    values.appointmentVersionId, values.appointment.id, values.appointment.version,
    values.actorId, values.now, values.correlationId, values.dataKeyId,
    ...(values.chargeChanged ? [
      values.chargeVersionId, values.charge.id, values.charge.version,
      values.actorId, values.now, values.correlationId, values.dataKeyId,
    ] : []),
    values.appointment.id, values.charge.id, values.dataKeyId,
    values.auditId, values.actorId, values.appointment.id, values.correlationId,
    JSON.stringify({
      appointmentVersion: values.appointment.version,
      chargeVersion: values.charge.version,
    }),
    values.actorId, EDIT_OPERATION, values.idempotencyKey, values.client.id,
    values.dataKeyId, values.dataKeyId,
    values.dataKeyId, values.client.id,
    values.client.id, values.client.identityEnvelope, values.client.version,
    values.client.id, values.client.version, values.client.id, values.client.id,
    ...assignmentChain.bindings,
    values.appointment.specialistId, values.practitionerStaffId,
    values.appointment.specialistId, values.appointment.id,
    values.appointment.endsAt, values.appointment.startsAt,
    values.appointment.id, values.payment.entries.length,
    values.appointment.id, values.appointment.id, values.dataKeyId,
    values.appointment.id, values.payment.collectedGrosze,
    values.payment.collectedGrosze, values.appointment.status,
    values.charge.expectedAmountGrosze, values.currentCharge.expectedAmountGrosze,
    ...lifecycle.bindings,
  )
}

const loadEditOverlap = (db, body, appointmentId) => db.prepare(
  `SELECT 1 AS blocked FROM appointments
   WHERE specialist_id=? AND id!=? AND status!='cancelled'
     AND starts_at<? AND ?<ends_at LIMIT 1`
).bind(body.specialistId, appointmentId, body.endsAt, body.startsAt).first()

const editCollisionProof = (db, values) => db.prepare(
  `SELECT CASE WHEN EXISTS (SELECT 1 FROM idempotency_records
       WHERE actor_id=? AND operation=? AND idempotency_key=?)
     THEN 1 ELSE 0 END AS stored,
   CASE WHEN EXISTS (SELECT 1 FROM record_versions WHERE id IN (?,?))
       OR EXISTS (SELECT 1 FROM audit_events WHERE id=?)
     THEN 1 ELSE 0 END AS generated_collision`
).bind(
  values.actorId, EDIT_OPERATION, values.idempotencyKey,
  values.appointmentVersionId, values.chargeVersionId ?? '', values.auditId,
).first()

const retainedEditState = async (command, actor) => {
  const retained = editScopedFact(
    await loadScopedAppointmentForEdit(
      command.db, command.appointmentId, command.body, actor,
    ),
    command.appointmentId,
    command.body,
  )
  if (!authorize(actor, 'appointment.manage', {
    kind: 'appointment', appointmentId: retained.appointment.id,
    specialistId: command.body.specialistId,
  }, { nowMs: command.nowMs })) notFound()
  const context = await loadClientCryptoContext(command.db, command.keyring, {
    clientId: retained.client.id, envelope: retained.client.identityEnvelope,
  })
  const identity = await decryptClientIdentity(context, {
    clientId: retained.client.id, envelope: retained.client.identityEnvelope,
  })
  await authenticateClientVersions(
    context, retained.client, identity,
    await loadClientVersions(command.db, retained.client.id),
  )
  await authenticateAssignmentVersions(
    context, retained.client,
    await loadAssignmentVersions(command.db, retained.client.id),
  )
  const payment = await authenticatePaymentHistory(
    context, retained.appointment, retained.charge,
    await loadPaymentHistory(command.db, retained.appointment.id),
  )
  await authenticateAppointmentVersions(
    context,
    retained.appointment,
    paymentAggregateFor(
      retained.appointment.status,
      retained.charge.expectedAmountGrosze,
      payment.collectedGrosze,
    ),
    await loadEntityVersions(command.db, retained.appointment.id),
  )
  await authenticateChargeVersions(
    context, retained.charge,
    await loadEntityVersions(command.db, retained.charge.id),
  )
  return Object.freeze({ ...retained, context, payment })
}

const loadRaceClientState = (db, clientId, startsAt) => db.prepare(
  `SELECT client.id AS client_id,client.identity_envelope,
          client.status AS client_status,client.version AS client_version,
          client.archived_at,client.created_at AS client_created_at,
          client.updated_at AS client_updated_at,assignment.id AS assignment_id,
          assignment.specialist_id,assignment.starts_at,assignment.ends_at,
          assignment.assigned_by_staff_id,assignment.version AS assignment_version,
          assignment.created_at AS assignment_created_at,
          assignment.updated_at AS assignment_updated_at,
          specialist.staff_user_id AS practitioner_staff_id,
          specialist.status AS practitioner_status,
          staff.specialist_id AS staff_specialist_id,staff.status AS staff_status
   FROM clients AS client
   JOIN client_assignments AS assignment ON assignment.client_id=client.id
     AND assignment.starts_at<=? AND (assignment.ends_at IS NULL OR ?<assignment.ends_at)
   LEFT JOIN specialists AS specialist ON specialist.id=assignment.specialist_id
   LEFT JOIN staff_users AS staff ON staff.id=specialist.staff_user_id
   WHERE client.id=? AND client.status IN ('active','paused')
     AND client.archived_at IS NULL
     AND (SELECT count(*) FROM client_assignments AS effective
       WHERE effective.client_id=client.id AND effective.starts_at<=?
         AND (effective.ends_at IS NULL OR ?<effective.ends_at))=1`
).bind(startsAt, startsAt, clientId, startsAt, startsAt).first()

const raceClientFact = (value, clientId, startsAt) => {
  const row = captureExact(value, [
    'client_id', 'identity_envelope', 'client_status', 'client_version', 'archived_at',
    'client_created_at', 'client_updated_at', 'assignment_id', 'specialist_id',
    'starts_at', 'ends_at', 'assigned_by_staff_id', 'assignment_version',
    'assignment_created_at', 'assignment_updated_at', 'practitioner_staff_id',
    'practitioner_status', 'staff_specialist_id', 'staff_status',
  ], notFound)
  if (row.client_id !== clientId || typeof row.identity_envelope !== 'string'
    || !['active', 'paused'].includes(row.client_status)
    || !Number.isSafeInteger(row.client_version) || row.client_version < 1
    || row.archived_at !== null || !canonicalInstant(row.client_created_at)
    || !canonicalInstant(row.client_updated_at) || !isAssignmentId(row.assignment_id)
    || !isSpecialistId(row.specialist_id) || !canonicalInstant(row.starts_at)
    || (row.ends_at !== null && (!canonicalInstant(row.ends_at) || row.ends_at <= row.starts_at))
    || !(row.starts_at <= startsAt && (row.ends_at === null || startsAt < row.ends_at))
    || typeof row.assigned_by_staff_id !== 'string' || !STAFF_ID.test(row.assigned_by_staff_id)
    || !Number.isSafeInteger(row.assignment_version) || row.assignment_version < 1
    || !canonicalInstant(row.assignment_created_at)
    || !canonicalInstant(row.assignment_updated_at)
    || (row.practitioner_staff_id !== null
      && (typeof row.practitioner_staff_id !== 'string'
        || !STAFF_ID.test(row.practitioner_staff_id)))
    || !['active', 'pending', 'archived'].includes(row.practitioner_status)
    || (row.staff_specialist_id !== null && !isSpecialistId(row.staff_specialist_id))
    || !['active', 'pending', 'disabled'].includes(row.staff_status)) notFound()
  return Object.freeze({
    client: Object.freeze({
      id: row.client_id, identityEnvelope: row.identity_envelope,
      status: row.client_status, version: row.client_version, archivedAt: null,
      createdAt: row.client_created_at, updatedAt: row.client_updated_at,
      assignment: Object.freeze({
        id: row.assignment_id, clientId: row.client_id, specialistId: row.specialist_id,
        startsAt: row.starts_at, endsAt: row.ends_at,
        assignedByStaffId: row.assigned_by_staff_id, version: row.assignment_version,
        createdAt: row.assignment_created_at, updatedAt: row.assignment_updated_at,
      }),
    }),
    joined: row.practitioner_staff_id !== null
      && row.staff_specialist_id === row.specialist_id,
    active: row.practitioner_status === 'active' && row.staff_status === 'active',
  })
}

const classifyAssignmentOrPractitionerRace = async (command, prior, originalError) => {
  let fresh
  try {
    fresh = raceClientFact(
      await loadRaceClientState(
        command.db, prior.client.id, command.body.startsAt,
      ),
      prior.client.id,
      command.body.startsAt,
    )
    const identity = await decryptClientIdentity(prior.context, {
      clientId: fresh.client.id, envelope: fresh.client.identityEnvelope,
    })
    await authenticateClientVersions(
      prior.context, fresh.client, identity,
      await loadClientVersions(command.db, fresh.client.id),
    )
    await authenticateAssignmentVersions(
      prior.context, fresh.client,
      await loadAssignmentVersions(command.db, fresh.client.id),
    )
  } catch { throw originalError }
  if (fresh.client.assignment.specialistId !== command.body.specialistId
    || !fresh.joined || !fresh.active) notFound()
  throw originalError
}

const reproveEditRace = async (command, actor, prior, originalError) => {
  let fresh
  try { fresh = await retainedEditState(command, actor) } catch (error) {
    let message
    try { message = error instanceof Error
      ? Object.getOwnPropertyDescriptor(error, 'message')?.value : null } catch {}
    if (message === 'NOT_FOUND') {
      return classifyAssignmentOrPractitionerRace(command, prior, originalError)
    }
    throw originalError
  }
  if (fresh.appointment.version !== prior.appointment.version) {
    versionConflict(fresh.appointment.version)
  }
  try {
    assertAppointmentPaymentTransition({
      currentStatus: fresh.appointment.status,
      currentAmountGrosze: fresh.charge.expectedAmountGrosze,
      proposedStatus: command.body.status,
      proposedAmountGrosze: command.body.expectedAmountGrosze,
      collectedGrosze: fresh.payment.collectedGrosze,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'APPOINTMENT_PAYMENT_CONFLICT') throw error
    throw originalError
  }
  let overlap
  try {
    overlap = overlapFact(await loadEditOverlap(
      command.db, command.body, command.appointmentId,
    ))
  } catch { throw originalError }
  if (overlap) throw new Error('APPOINTMENT_OVERLAP')
  throw originalError
}

export async function editAppointment(input) {
  const command = captureEditCommand(input)
  const actor = actorFact(command.actor)
  const requestDigest = await digestEditNormalized(
    command.appointmentId, command.body,
  )
  const idem = Object.freeze({
    actorId: actor.id, operation: EDIT_OPERATION,
    idempotencyKey: command.idempotencyKey, requestDigest,
    resourceType: 'client', scopeType: 'client', scopePurpose: 'identity',
  })
  const replay = await inspectStoredScopeIdempotency(command.db, command.keyring, idem)
  if (replay) return validateEditReplay(replay, command.appointmentId, command.body)

  const current = await retainedEditState(command, actor)
  if (command.body.expectedVersion !== current.appointment.version) {
    versionConflict(current.appointment.version)
  }
  const chargeChanged = command.body.serviceId !== current.charge.serviceId
    || command.body.expectedAmountGrosze !== current.charge.expectedAmountGrosze
  if (command.body.specialistId === current.appointment.specialistId
    && command.body.serviceId === current.appointment.serviceId
    && command.body.startsAt === current.appointment.startsAt
    && command.body.endsAt === current.appointment.endsAt
    && command.body.location === current.appointment.location
    && command.body.status === current.appointment.status
    && !chargeChanged) validation('body')
  assertAppointmentPaymentTransition({
    currentStatus: current.appointment.status,
    currentAmountGrosze: current.charge.expectedAmountGrosze,
    proposedStatus: command.body.status,
    proposedAmountGrosze: command.body.expectedAmountGrosze,
    collectedGrosze: current.payment.collectedGrosze,
  })
  if (overlapFact(await loadEditOverlap(
    command.db, command.body, command.appointmentId,
  ))) {
    if (storedOperationExists(await loadStoredOperationPresence(command.db, idem))) {
      const winner = await recoverStoredScopeIdempotencyAfterCollision(
        command.recoveryDb, command.keyring, idem, identityCollisionSignal(),
      )
      return validateEditReplay(winner, command.appointmentId, command.body)
    }
    throw new Error('APPOINTMENT_OVERLAP')
  }

  let now
  try { now = new Date(command.nowMs).toISOString() } catch { throw new Error('INTERNAL_ERROR') }
  if (now <= current.appointment.updatedAt
    || (chargeChanged && now <= current.charge.updatedAt)) throw new Error('INTERNAL_ERROR')
  const used = new Set()
  const appointmentVersionId = generated(command.idFactory, 'ver', isVersionId, used)
  const chargeVersionId = chargeChanged
    ? generated(command.idFactory, 'ver', isVersionId, used)
    : null
  const auditId = generated(command.idFactory, 'aud', isAuditId, used)
  const proposedAggregate = paymentAggregateFor(
    command.body.status,
    command.body.expectedAmountGrosze,
    current.payment.collectedGrosze,
  )
  const appointment = Object.freeze({
    id: current.appointment.id, clientId: current.appointment.clientId,
    specialistId: command.body.specialistId, serviceId: command.body.serviceId,
    startsAt: command.body.startsAt, endsAt: command.body.endsAt,
    timeZone: 'Europe/Warsaw', location: command.body.location,
    status: command.body.status, source: current.appointment.source,
    version: current.appointment.version + 1, cancelledAt: null,
    createdAt: current.appointment.createdAt, updatedAt: now,
    paymentAggregate: proposedAggregate,
  })
  const charge = Object.freeze({
    id: current.charge.id, appointmentId: current.appointment.id,
    serviceId: command.body.serviceId,
    expectedAmountGrosze: command.body.expectedAmountGrosze,
    currency: current.charge.currency,
    version: current.charge.version + (chargeChanged ? 1 : 0),
    createdAt: current.charge.createdAt,
    updatedAt: chargeChanged ? now : current.charge.updatedAt,
  })
  const appointmentVersion = await versionBuilder.build(command.db, current.context, {
    clientId: current.client.id, versionId: appointmentVersionId,
    entityType: 'appointment', entity: appointment,
    changedByStaffId: actor.id, changedAt: now,
    correlationId: command.correlationId, ownerFact: null,
  })
  const chargeOwner = ownership.issuer.issueCharge(Object.freeze({
    clientId: current.client.id, appointmentId: appointment.id,
  }))
  const chargeVersion = chargeChanged
    ? await versionBuilder.build(command.db, current.context, {
        clientId: current.client.id, versionId: chargeVersionId,
        entityType: 'session_charge', entity: charge,
        changedByStaffId: actor.id, changedAt: now,
        correlationId: command.correlationId, ownerFact: chargeOwner,
      })
    : null
  const responsePayment = Object.freeze({
    status: proposedAggregate.status,
    collectedGrosze: proposedAggregate.collectedGrosze,
    outstandingGrosze: proposedAggregate.outstandingGrosze,
    latestMethod: current.payment.latestMethod,
    latestReceivedAt: current.payment.latestReceivedAt,
    entries: current.payment.entries,
  })
  const response = Object.freeze({ status: 200, body: Object.freeze({
    data: Object.freeze({
      appointment: editAppointmentDto(appointment, charge, responsePayment),
    }),
  }) })
  const idempotency = await createIdempotencyStatement(command.db, current.context, {
    actorId: actor.id, operation: EDIT_OPERATION,
    idempotencyKey: command.idempotencyKey, requestDigest,
    expectedScope: current.context.scope, resourceType: 'client',
    resourceId: current.client.id, response, createdAt: now,
    expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  })
  const values = Object.freeze({
    appointment, charge, currentCharge: current.charge, chargeChanged,
    client: current.client, payment: responsePayment,
    practitionerStaffId: current.practitionerStaffId,
    now, actorId: actor.id, appointmentVersionId, chargeVersionId,
    auditId, correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey,
    dataKeyId: current.context.dataKey.id,
  })
  const uow = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  uow.domain(command.db.prepare(
    `UPDATE appointments SET specialist_id=?,service_id=?,starts_at=?,ends_at=?,
       location=?,status=?,version=?,updated_at=?
     WHERE id=? AND client_id=? AND version=? AND specialist_id=? AND service_id=?
       AND starts_at=? AND ends_at=? AND time_zone='Europe/Warsaw'
       AND location IS ? AND status=? AND source=? AND cancelled_at IS NULL
       AND created_at=? AND updated_at=?
       AND EXISTS (SELECT 1 FROM client_assignments AS assignment
         JOIN specialists AS specialist ON specialist.id=assignment.specialist_id
           AND specialist.status='active'
         JOIN staff_users AS staff ON staff.id=specialist.staff_user_id
           AND staff.specialist_id=specialist.id AND staff.status='active'
         WHERE assignment.client_id=? AND assignment.specialist_id=?
           AND assignment.starts_at<=?
           AND (assignment.ends_at IS NULL OR ?<assignment.ends_at))
       AND (SELECT count(*) FROM client_assignments
         WHERE client_id=? AND starts_at<=?
           AND (ends_at IS NULL OR ?<ends_at))=1
       AND NOT EXISTS (SELECT 1 FROM appointments AS other
         WHERE other.specialist_id=? AND other.id!=? AND other.status!='cancelled'
           AND other.starts_at<? AND ?<other.ends_at)
       AND (SELECT coalesce(sum(payment.amount_grosze),0)
         FROM payment_entries AS payment
         WHERE payment.appointment_id=? AND NOT EXISTS
           (SELECT 1 FROM payment_corrections WHERE reversed_entry_id=payment.id))=?`
  ).bind(
    appointment.specialistId, appointment.serviceId, appointment.startsAt,
    appointment.endsAt, appointment.location, appointment.status,
    appointment.version, now,
    current.appointment.id, current.client.id, current.appointment.version,
    current.appointment.specialistId, current.appointment.serviceId,
    current.appointment.startsAt, current.appointment.endsAt,
    current.appointment.location, current.appointment.status,
    current.appointment.source, current.appointment.createdAt,
    current.appointment.updatedAt,
    current.client.id, appointment.specialistId, appointment.startsAt,
    appointment.startsAt, current.client.id, appointment.startsAt,
    appointment.startsAt, appointment.specialistId, appointment.id,
    appointment.endsAt, appointment.startsAt, appointment.id,
    current.payment.collectedGrosze,
  ))
  if (chargeChanged) {
    uow.domain(command.db.prepare(
      `UPDATE session_charges SET service_id=?,expected_amount_grosze=?,version=?,updated_at=?
       WHERE id=? AND appointment_id=? AND service_id=? AND expected_amount_grosze=?
         AND currency='PLN' AND version=? AND created_at=? AND updated_at=?
         AND EXISTS (SELECT 1 FROM appointments WHERE id=? AND version=?
           AND service_id=? AND updated_at=?)`
    ).bind(
      charge.serviceId, charge.expectedAmountGrosze, charge.version, now,
      current.charge.id, current.appointment.id, current.charge.serviceId,
      current.charge.expectedAmountGrosze, current.charge.version,
      current.charge.createdAt, current.charge.updatedAt,
      appointment.id, appointment.version, appointment.serviceId, now,
    ))
  }
  uow.version(conditionalVersionStatement(
    command.db, appointmentVersion,
    'EXISTS (SELECT 1 FROM appointments WHERE id=? AND version=? AND updated_at=?)',
    [appointment.id, appointment.version, now],
  ))
  if (chargeChanged) {
    uow.version(conditionalVersionStatement(
      command.db, chargeVersion,
      'EXISTS (SELECT 1 FROM appointments WHERE id=? AND version=? AND updated_at=?) AND EXISTS (SELECT 1 FROM session_charges WHERE id=? AND version=? AND updated_at=?)',
      [appointment.id, appointment.version, now, charge.id, charge.version, now],
    ))
  }
  uow.audit(auditEventStatement(command.db, {
    id: auditId, occurredAt: now, actorStaffId: actor.id,
    action: 'appointment.updated', entityType: 'appointment', entityId: appointment.id,
    result: 'success', correlationId: command.correlationId,
    metadata: { appointmentVersion: appointment.version, chargeVersion: charge.version },
    reasonEnvelope: null,
  }))
  uow.idempotency(idempotency)
  uow.guard(editGuardStatement(command.db, values))
  try {
    await uow.commit()
    return response
  } catch (originalError) {
    if (isD1IdentityCollision(originalError)) {
      let collision
      try {
        collision = captureExact(
          await editCollisionProof(command.db, values),
          ['stored', 'generated_collision'],
          cryptoFailure,
        )
      } catch { throw originalError }
      if (![0, 1].includes(collision.stored)
        || ![0, 1].includes(collision.generated_collision)) throw originalError
      if (collision.stored === 1 && collision.generated_collision === 0) {
        const winner = await recoverStoredScopeIdempotencyAfterCollision(
          command.recoveryDb, command.keyring, idem, originalError,
        )
        return validateEditReplay(winner, command.appointmentId, command.body)
      }
    }
    if (isD1CoreDirectoryInvariantFailure(originalError)) {
      return reproveEditRace(command, actor, current, originalError)
    }
    throw originalError
  }
}

const CANCEL_INPUT_KEYS = Object.freeze([
  ...INPUT_KEYS.slice(0, 7), 'appointmentId', ...INPUT_KEYS.slice(7),
])

const captureCancelCommand = (input) => {
  const captured = captureExact(input, CANCEL_INPUT_KEYS)
  if (!captured.db?.prepare || !captured.db?.batch || !captured.recoveryDb?.prepare
    || !captured.keyring || typeof captured.idFactory !== 'function'
    || !Number.isSafeInteger(captured.nowMs) || captured.nowMs < 0
    || typeof captured.correlationId !== 'string' || !CORRELATION_ID.test(captured.correlationId)
    || typeof captured.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(captured.idempotencyKey)) validation('body')
  if (typeof captured.appointmentId !== 'string'
    || !isAppointmentId(captured.appointmentId)) validation('appointmentId')
  return Object.freeze({ ...captured, body: validateCancelAppointmentBody(captured.body) })
}

const loadScopedAppointmentForCancellation = (db, appointmentId, actor, terminal = false) => db.prepare(
  `SELECT appointment.id,appointment.client_id,appointment.specialist_id,
          appointment.service_id,appointment.starts_at,appointment.ends_at,
          appointment.time_zone,appointment.location,appointment.status,
          appointment.source,appointment.version,appointment.cancelled_at,
          appointment.created_at,appointment.updated_at,
          charge.id AS charge_id,charge.appointment_id AS charge_appointment_id,
          charge.service_id AS charge_service_id,
          charge.expected_amount_grosze,charge.currency,
          charge.version AS charge_version,charge.created_at AS charge_created_at,
          charge.updated_at AS charge_updated_at,
          client.identity_envelope,client.status AS client_status,
          client.version AS client_version,client.archived_at,
          client.created_at AS client_created_at,client.updated_at AS client_updated_at,
          assignment.id AS assignment_id,assignment.specialist_id AS assignment_specialist_id,
          assignment.starts_at AS assignment_starts_at,assignment.ends_at AS assignment_ends_at,
          assignment.assigned_by_staff_id,assignment.version AS assignment_version,
          assignment.created_at AS assignment_created_at,
          assignment.updated_at AS assignment_updated_at
   FROM appointments AS appointment
   JOIN session_charges AS charge ON charge.appointment_id=appointment.id
   JOIN clients AS client ON client.id=appointment.client_id
   JOIN client_assignments AS assignment ON assignment.client_id=client.id
     AND assignment.specialist_id=appointment.specialist_id
     AND assignment.starts_at<=appointment.starts_at
     AND (assignment.ends_at IS NULL OR appointment.starts_at<assignment.ends_at)
   WHERE appointment.id=? AND ${terminal
    ? "appointment.status='cancelled' AND appointment.cancelled_at IS NOT NULL"
    : "appointment.status IN ('scheduled','completed','noshow') AND appointment.cancelled_at IS NULL"}
     AND client.status IN ('active','paused') AND client.archived_at IS NULL
     AND (? IN ('owner','coordinator')
       OR (?='specialist' AND ?=appointment.specialist_id))
     AND (SELECT count(*) FROM session_charges AS exact_charge
       WHERE exact_charge.appointment_id=appointment.id)=1
     AND (SELECT count(*) FROM client_assignments AS effective
       WHERE effective.client_id=client.id
         AND effective.starts_at<=appointment.starts_at
         AND (effective.ends_at IS NULL
           OR appointment.starts_at<effective.ends_at))=1`
).bind(appointmentId, actor.role, actor.role, actor.specialistId).first()

const cancellationScopedFact = (value, appointmentId, terminal = false) => {
  const row = captureExact(value, [
    'id', 'client_id', 'specialist_id', 'service_id', 'starts_at', 'ends_at',
    'time_zone', 'location', 'status', 'source', 'version', 'cancelled_at',
    'created_at', 'updated_at', 'charge_id', 'charge_appointment_id',
    'charge_service_id', 'expected_amount_grosze', 'currency', 'charge_version',
    'charge_created_at', 'charge_updated_at', 'identity_envelope', 'client_status',
    'client_version', 'archived_at', 'client_created_at', 'client_updated_at',
    'assignment_id', 'assignment_specialist_id', 'assignment_starts_at',
    'assignment_ends_at', 'assigned_by_staff_id', 'assignment_version',
    'assignment_created_at', 'assignment_updated_at',
  ], notFound)
  try { assertLocation(row.location) } catch { notFound() }
  if (row.id !== appointmentId || !isClientId(row.client_id)
    || !isSpecialistId(row.specialist_id) || !SERVICE_BY_ID[row.service_id]
    || !canonicalInstant(row.starts_at) || !canonicalInstant(row.ends_at)
    || row.ends_at <= row.starts_at || row.time_zone !== 'Europe/Warsaw'
    || !(terminal ? row.status === 'cancelled'
      : ['scheduled', 'completed', 'noshow'].includes(row.status))
    || row.source !== 'panel' || !Number.isSafeInteger(row.version) || row.version < 1
    || (terminal
      ? (!canonicalInstant(row.cancelled_at) || row.cancelled_at !== row.updated_at)
      : row.cancelled_at !== null)
    || !canonicalInstant(row.created_at)
    || !canonicalInstant(row.updated_at) || row.updated_at < row.created_at
    || !isChargeId(row.charge_id) || row.charge_appointment_id !== appointmentId
    || row.charge_service_id !== row.service_id
    || !Number.isSafeInteger(row.expected_amount_grosze)
    || row.expected_amount_grosze < 1 || row.expected_amount_grosze > 1_000_000
    || row.currency !== 'PLN' || !Number.isSafeInteger(row.charge_version)
    || row.charge_version < 1 || !canonicalInstant(row.charge_created_at)
    || !canonicalInstant(row.charge_updated_at)
    || row.charge_updated_at < row.charge_created_at
    || typeof row.identity_envelope !== 'string'
    || !['active', 'paused'].includes(row.client_status)
    || !Number.isSafeInteger(row.client_version) || row.client_version < 1
    || row.archived_at !== null || !canonicalInstant(row.client_created_at)
    || !canonicalInstant(row.client_updated_at)
    || !isAssignmentId(row.assignment_id)
    || !isSpecialistId(row.assignment_specialist_id)
    || !canonicalInstant(row.assignment_starts_at)
    || (row.assignment_ends_at !== null
      && (!canonicalInstant(row.assignment_ends_at)
        || row.assignment_ends_at <= row.assignment_starts_at))
    || !(row.assignment_starts_at <= row.starts_at
      && (row.assignment_ends_at === null || row.starts_at < row.assignment_ends_at))
    || row.assignment_specialist_id !== row.specialist_id
    || typeof row.assigned_by_staff_id !== 'string' || !STAFF_ID.test(row.assigned_by_staff_id)
    || row.assignment_version !== (row.assignment_ends_at === null ? 1 : 2)
    || !canonicalInstant(row.assignment_created_at)
    || !canonicalInstant(row.assignment_updated_at)) notFound()
  return Object.freeze({
    appointment: Object.freeze({
      id: row.id, clientId: row.client_id, specialistId: row.specialist_id,
      serviceId: row.service_id, startsAt: row.starts_at, endsAt: row.ends_at,
      timeZone: row.time_zone, location: row.location, status: row.status,
      source: row.source, version: row.version, cancelledAt: row.cancelled_at,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }),
    charge: Object.freeze({
      id: row.charge_id, appointmentId: row.id, serviceId: row.charge_service_id,
      expectedAmountGrosze: row.expected_amount_grosze, currency: row.currency,
      version: row.charge_version, createdAt: row.charge_created_at,
      updatedAt: row.charge_updated_at,
    }),
    client: Object.freeze({
      id: row.client_id, identityEnvelope: row.identity_envelope,
      status: row.client_status, version: row.client_version, archivedAt: null,
      createdAt: row.client_created_at, updatedAt: row.client_updated_at,
      assignment: Object.freeze({
        id: row.assignment_id, clientId: row.client_id,
        specialistId: row.assignment_specialist_id, startsAt: row.assignment_starts_at,
        endsAt: row.assignment_ends_at, assignedByStaffId: row.assigned_by_staff_id,
        version: row.assignment_version, createdAt: row.assignment_created_at,
        updatedAt: row.assignment_updated_at,
      }),
    }),
  })
}

const retainedCancellationState = async (command, actor, terminal = false) => {
  const retained = cancellationScopedFact(
    await loadScopedAppointmentForCancellation(
      command.db, command.appointmentId, actor, terminal,
    ),
    command.appointmentId,
    terminal,
  )
  if (!authorize(actor, 'appointment.manage', {
    kind: 'appointment', appointmentId: retained.appointment.id,
    specialistId: retained.appointment.specialistId,
  }, { nowMs: command.nowMs })) notFound()
  const context = await loadClientCryptoContext(command.db, command.keyring, {
    clientId: retained.client.id, envelope: retained.client.identityEnvelope,
  })
  const identity = await decryptClientIdentity(context, {
    clientId: retained.client.id, envelope: retained.client.identityEnvelope,
  })
  await authenticateClientVersions(
    context, retained.client, identity,
    await loadClientVersions(command.db, retained.client.id),
  )
  await authenticateAssignmentVersions(
    context, retained.client,
    await loadAssignmentVersions(command.db, retained.client.id),
  )
  const payment = await authenticatePaymentHistory(
    context, retained.appointment, retained.charge,
    await loadPaymentHistory(command.db, retained.appointment.id),
    true,
  )
  await authenticateAppointmentVersions(
    context, retained.appointment,
    paymentAggregateFor(
      retained.appointment.status,
      retained.charge.expectedAmountGrosze,
      payment.collectedGrosze,
    ),
    await loadEntityVersions(command.db, retained.appointment.id),
  )
  await authenticateChargeVersions(
    context, retained.charge,
    await loadEntityVersions(command.db, retained.charge.id),
  )
  return Object.freeze({ ...retained, context, payment })
}

const assertCancellationPaymentTransition = (current) => {
  if (!['scheduled', 'completed', 'noshow'].includes(current.appointment.status)
    || !Number.isSafeInteger(current.payment.collectedGrosze)
    || current.payment.collectedGrosze < 0) throw new Error('INTERNAL_ERROR')
  if (current.payment.collectedGrosze !== 0) {
    throw new Error('APPOINTMENT_PAYMENT_CONFLICT')
  }
}

const validateCancelReplay = (value, appointmentId, request) => {
  const replay = replayObject(value, ['status', 'body'])
  const body = replayObject(replay.body, ['data'])
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
  if (replay.status !== 200 || appointment.id !== appointmentId
    || !isClientId(appointment.clientId) || !isSpecialistId(appointment.specialistId)
    || !SERVICE_BY_ID[appointment.serviceId] || !canonicalInstant(appointment.startsAt)
    || !canonicalInstant(appointment.endsAt) || appointment.endsAt <= appointment.startsAt
    || appointment.timeZone !== 'Europe/Warsaw' || appointment.status !== 'cancelled'
    || appointment.source !== 'panel' || appointment.version !== request.expectedVersion + 1
    || !canonicalInstant(appointment.cancelledAt)
    || appointment.updatedAt !== appointment.cancelledAt
    || !canonicalInstant(appointment.createdAt) || appointment.createdAt > appointment.updatedAt
    || !isChargeId(charge.id) || charge.serviceId !== appointment.serviceId
    || !Number.isSafeInteger(charge.expectedAmountGrosze)
    || charge.expectedAmountGrosze < 1 || charge.expectedAmountGrosze > 1_000_000
    || charge.currency !== 'PLN' || !Number.isSafeInteger(charge.version) || charge.version < 1
    || payment.status !== 'unpaid' || payment.collectedGrosze !== 0
    || payment.outstandingGrosze !== 0 || payment.latestMethod !== null
    || payment.latestReceivedAt !== null || !Array.isArray(appointment.paymentEntries)
    || appointment.paymentEntries.length > 1_000
    || Reflect.ownKeys(Object.getOwnPropertyDescriptors(appointment.paymentEntries)).length
      !== appointment.paymentEntries.length + 1) cryptoFailure()
  try { assertLocation(appointment.location) } catch { cryptoFailure() }
  const ids = new Set()
  const entries = appointment.paymentEntries.map((candidate) => {
    const entry = replayObject(candidate, [
      'id', 'amountGrosze', 'method', 'receivedAt', 'correctedAt', 'replacementEntryId',
    ])
    if (!isPaymentId(entry.id) || ids.has(entry.id)
      || !Number.isSafeInteger(entry.amountGrosze) || entry.amountGrosze < 1
      || entry.amountGrosze > 1_000_000
      || !['cash', 'card', 'transfer', 'monthly'].includes(entry.method)
      || !canonicalInstant(entry.receivedAt) || !canonicalInstant(entry.correctedAt)
      || (entry.replacementEntryId !== null && !isPaymentId(entry.replacementEntryId))
      || entry.correctedAt < appointment.createdAt
      || entry.correctedAt > appointment.updatedAt) cryptoFailure()
    ids.add(entry.id)
    return Object.freeze(entry)
  })
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].receivedAt > entries[index].receivedAt
      || (entries[index - 1].receivedAt === entries[index].receivedAt
        && binaryCompare(entries[index - 1].id, entries[index].id) >= 0)) cryptoFailure()
  }
  const replacementTargets = new Set()
  const replacementLinks = new Map()
  for (const entry of entries) {
    if (entry.replacementEntryId === null) continue
    const replacement = entries.find(({ id }) => id === entry.replacementEntryId)
    if (!replacement || entry.replacementEntryId === entry.id
      || replacementTargets.has(entry.replacementEntryId)
      || replacement.correctedAt < entry.correctedAt) cryptoFailure()
    replacementTargets.add(entry.replacementEntryId)
    replacementLinks.set(entry.id, entry.replacementEntryId)
  }
  for (const start of replacementLinks.keys()) {
    const path = new Set()
    let cursor = start
    while (replacementLinks.has(cursor)) {
      if (path.has(cursor)) cryptoFailure()
      path.add(cursor)
      cursor = replacementLinks.get(cursor)
    }
  }
  return Object.freeze({ status: 200, body: Object.freeze({
    data: Object.freeze({ appointment: editAppointmentDto(
      appointment, charge, Object.freeze({ ...payment, entries: Object.freeze(entries) }),
    ) }),
  }) })
}

const cancellationGuardStatement = (db, values) => {
  const assignmentChain = assignmentChainPostcondition(
    values.client.id, values.appointment.specialistId,
    values.appointment.startsAt,
  )
  return db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'appointment_cancellation_postcondition'
     WHERE NOT (
       EXISTS (SELECT 1 FROM appointments WHERE id=? AND client_id=?
         AND specialist_id=? AND service_id=? AND starts_at=? AND ends_at=?
         AND time_zone='Europe/Warsaw' AND location IS ? AND status='cancelled'
         AND source=? AND version=? AND cancelled_at=? AND created_at=? AND updated_at=?)
       AND (SELECT count(*) FROM appointments WHERE id=?)=1
       AND EXISTS (SELECT 1 FROM session_charges WHERE id=? AND appointment_id=?
         AND service_id=? AND expected_amount_grosze=? AND currency='PLN'
         AND version=? AND created_at=? AND updated_at=?)
       AND (SELECT count(*) FROM session_charges WHERE appointment_id=?)=1
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
       AND NOT EXISTS (SELECT 1 FROM record_versions WHERE
         (entity_id=? AND entity_type!='appointment')
         OR (entity_id=? AND entity_type!='session_charge'))
       AND EXISTS (SELECT 1 FROM record_versions WHERE id=?
         AND entity_type='appointment' AND entity_id=? AND version=?
         AND changed_by_staff_id=? AND changed_at=? AND correlation_id=?
         AND json_extract(snapshot_envelope,'$.dataKeyId')=?
         AND json_extract(snapshot_envelope,'$.dataKeyVersion')=1)
       AND NOT EXISTS (SELECT 1 FROM record_versions WHERE
         entity_id IN (?,?) AND (NOT json_valid(snapshot_envelope)
           OR json_extract(CASE WHEN json_valid(snapshot_envelope)
                THEN snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
           OR json_extract(CASE WHEN json_valid(snapshot_envelope)
                THEN snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1))
       AND EXISTS (SELECT 1 FROM audit_events WHERE id=? AND actor_staff_id=?
         AND action='appointment.cancelled' AND entity_type='appointment' AND entity_id=?
         AND result='success' AND reason_envelope IS NULL AND correlation_id=?
         AND metadata_json=?)
       AND (SELECT count(*) FROM audit_events
         WHERE action='appointment.cancelled' AND entity_type='appointment'
           AND entity_id=? AND result='success')=1
       AND EXISTS (SELECT 1 FROM idempotency_records WHERE actor_id=? AND operation=?
         AND idempotency_key=? AND resource_type='client' AND resource_id=?
         AND json_extract(request_hash,'$.dataKeyId')=?
         AND json_extract(response_envelope,'$.dataKeyId')=?)
       AND EXISTS (SELECT 1 FROM data_keys WHERE id=? AND scope_type='client'
         AND scope_id=? AND purpose='identity' AND dek_version=1 AND retired_at IS NULL)
       AND EXISTS (SELECT 1 FROM clients WHERE id=? AND identity_envelope=?
         AND status=? AND archived_at IS NULL AND version=?
         AND created_at=? AND updated_at=?)
       AND (SELECT count(*) FROM record_versions
         WHERE entity_type='client' AND entity_id=?)=?
       AND NOT EXISTS (SELECT 1 FROM record_versions
         WHERE entity_id=? AND entity_type!='client')
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
         WHERE retained.client_id=? AND history.entity_type!='client_assignment')
       AND (${assignmentChain.sql})
       AND (SELECT count(*) FROM payment_entries WHERE appointment_id=?)=?
       AND NOT EXISTS (SELECT 1 FROM payment_entries AS payment
         WHERE payment.appointment_id=? AND (payment.amount_grosze<1
           OR payment.amount_grosze>1000000
           OR payment.method NOT IN ('cash','card','transfer','monthly')
           OR payment.external_reference_envelope IS NOT NULL
           OR NOT EXISTS (SELECT 1 FROM staff_users WHERE id=payment.recorded_by_staff_id)))
       AND NOT EXISTS (SELECT 1 FROM payment_corrections AS correction
         JOIN payment_entries AS payment ON payment.id=correction.reversed_entry_id
         WHERE payment.appointment_id=? AND (correction.replacement_entry_id=correction.reversed_entry_id
           OR NOT json_valid(correction.reason_envelope)
           OR json_extract(CASE WHEN json_valid(correction.reason_envelope)
                THEN correction.reason_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
           OR json_extract(CASE WHEN json_valid(correction.reason_envelope)
                THEN correction.reason_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1
           OR (correction.replacement_entry_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM payment_entries AS replacement
             WHERE replacement.id=correction.replacement_entry_id
               AND replacement.appointment_id=payment.appointment_id))))
       AND (SELECT coalesce(sum(payment.amount_grosze),0) FROM payment_entries AS payment
         WHERE payment.appointment_id=? AND NOT EXISTS (SELECT 1 FROM payment_corrections
           WHERE reversed_entry_id=payment.id))=0
     )`
  ).bind(
    values.appointment.id, values.client.id, values.appointment.specialistId,
    values.appointment.serviceId, values.appointment.startsAt, values.appointment.endsAt,
    values.appointment.location, values.appointment.source, values.appointment.version,
    values.now, values.appointment.createdAt, values.now, values.appointment.id,
    values.charge.id, values.appointment.id, values.charge.serviceId,
    values.charge.expectedAmountGrosze, values.charge.version,
    values.charge.createdAt, values.charge.updatedAt, values.appointment.id,
    values.appointment.id, values.appointment.version,
    values.appointment.id, values.appointment.id, values.appointment.version,
    values.charge.id, values.charge.version,
    values.charge.id, values.charge.id, values.charge.version,
    values.appointment.id, values.charge.id,
    values.appointmentVersionId, values.appointment.id, values.appointment.version,
    values.actorId, values.now, values.correlationId, values.dataKeyId,
    values.appointment.id, values.charge.id, values.dataKeyId,
    values.auditId, values.actorId, values.appointment.id, values.correlationId,
    JSON.stringify({
      appointmentVersion: values.appointment.version,
      chargeVersion: values.charge.version,
    }),
    values.appointment.id,
    values.actorId, CANCEL_OPERATION, values.idempotencyKey, values.client.id,
    values.dataKeyId, values.dataKeyId,
    values.dataKeyId, values.client.id,
    values.client.id, values.client.identityEnvelope, values.client.status,
    values.client.version, values.client.createdAt, values.client.updatedAt,
    values.client.id, values.client.version, values.client.id, values.client.id,
    values.client.id,
    ...assignmentChain.bindings,
    values.appointment.id, values.payment.entries.length,
    values.appointment.id, values.appointment.id, values.dataKeyId,
    values.appointment.id,
  )
}

const cancellationCollisionProof = (db, values) => db.prepare(
  `SELECT CASE WHEN EXISTS (SELECT 1 FROM idempotency_records
       WHERE actor_id=? AND operation=? AND idempotency_key=?)
     THEN 1 ELSE 0 END AS stored,
   CASE WHEN EXISTS (SELECT 1 FROM record_versions WHERE id=?)
       OR EXISTS (SELECT 1 FROM audit_events WHERE id=?)
     THEN 1 ELSE 0 END AS generated_collision`
).bind(
  values.actorId, CANCEL_OPERATION, values.idempotencyKey,
  values.appointmentVersionId, values.auditId,
).first()

const loadTerminalCancellationProof = (db, appointment, charge, dataKeyId) => db.prepare(
  `SELECT stored.actor_id,stored.idempotency_key,stored.request_hash,
          stored.response_envelope,stored.created_at
   FROM audit_events AS audit
   JOIN idempotency_records AS stored
     ON stored.actor_id=audit.actor_staff_id
    AND stored.created_at=audit.occurred_at
   WHERE audit.action='appointment.cancelled' AND audit.entity_type='appointment'
     AND audit.entity_id=? AND audit.result='success' AND audit.reason_envelope IS NULL
     AND audit.metadata_json=?
     AND stored.operation=? AND stored.resource_type='client' AND stored.resource_id=?
     AND json_extract(stored.request_hash,'$.dataKeyId')=?
     AND json_extract(stored.request_hash,'$.dataKeyVersion')=1
     AND json_extract(stored.response_envelope,'$.dataKeyId')=?
     AND json_extract(stored.response_envelope,'$.dataKeyVersion')=1
   ORDER BY stored.actor_id,stored.idempotency_key LIMIT 2`
).bind(
  appointment.id,
  JSON.stringify({ appointmentVersion: appointment.version, chargeVersion: charge.version }),
  CANCEL_OPERATION,
  appointment.clientId,
  dataKeyId,
  dataKeyId,
).all()

const cancellationIdempotencyRecordId = async (actorId, idempotencyKey) => {
  const encoded = new TextEncoder().encode(
    ['bwm:idempotency:record:v1', actorId, CANCEL_OPERATION, idempotencyKey].join('\n'),
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

const authenticateTerminalCancellationProof = async (
  context, appointment, charge, value,
) => {
  const rows = resultRows(value, 2)
  if (rows.length !== 1) cryptoFailure()
  const row = captureExact(rows[0], [
    'actor_id', 'idempotency_key', 'request_hash', 'response_envelope', 'created_at',
  ], cryptoFailure)
  if (typeof row.actor_id !== 'string' || !STAFF_ID.test(row.actor_id)
    || typeof row.idempotency_key !== 'string' || !IDEMPOTENCY_KEY.test(row.idempotency_key)
    || typeof row.request_hash !== 'string' || typeof row.response_envelope !== 'string'
    || row.created_at !== appointment.updatedAt) cryptoFailure()
  const recordId = await cancellationIdempotencyRecordId(
    row.actor_id, row.idempotency_key,
  )
  const expectedDigest = await digestCancelNormalized(appointment.id, {
    expectedVersion: appointment.version - 1,
  })
  let storedDigest
  let plaintext
  try {
    storedDigest = await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope, recordId, field: 'idempotency_request_hash',
      envelope: JSON.parse(row.request_hash),
    })
    if (storedDigest !== expectedDigest) cryptoFailure()
    plaintext = await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope, recordId, field: 'idempotency_response',
      envelope: JSON.parse(row.response_envelope),
    })
    const parsed = JSON.parse(plaintext)
    if (JSON.stringify(parsed) !== plaintext) cryptoFailure()
    validateCancelReplay(parsed, appointment.id, {
      expectedVersion: appointment.version - 1,
    })
    return true
  } catch (error) {
    if (error instanceof Error && error.message === 'CRYPTO_FAILURE') throw error
    cryptoFailure()
  }
}

const reproveCancellationRace = async (command, actor, prior, originalError) => {
  let fresh
  try { fresh = await retainedCancellationState(command, actor) } catch {
    let terminal
    try { terminal = await retainedCancellationState(command, actor, true) } catch {
      throw originalError
    }
    try {
      await authenticateTerminalCancellationProof(
        terminal.context, terminal.appointment, terminal.charge,
        await loadTerminalCancellationProof(
          command.db, terminal.appointment, terminal.charge,
          terminal.context.dataKey.id,
        ),
      )
    } catch { throw originalError }
    if (terminal.appointment.version === prior.appointment.version + 1
      && terminal.appointment.clientId === prior.appointment.clientId
      && terminal.appointment.specialistId === prior.appointment.specialistId
      && terminal.appointment.serviceId === prior.appointment.serviceId
      && terminal.appointment.startsAt === prior.appointment.startsAt
      && terminal.appointment.endsAt === prior.appointment.endsAt
      && terminal.appointment.timeZone === prior.appointment.timeZone
      && terminal.appointment.location === prior.appointment.location
      && terminal.appointment.source === prior.appointment.source
      && terminal.appointment.createdAt === prior.appointment.createdAt
      && terminal.charge.id === prior.charge.id
      && terminal.charge.serviceId === prior.charge.serviceId
      && terminal.charge.expectedAmountGrosze === prior.charge.expectedAmountGrosze
      && terminal.charge.currency === prior.charge.currency
      && terminal.charge.version === prior.charge.version
      && terminal.charge.createdAt === prior.charge.createdAt
      && terminal.charge.updatedAt === prior.charge.updatedAt
      && terminal.payment.collectedGrosze === 0) notFound()
    throw originalError
  }
  if (fresh.appointment.version !== prior.appointment.version) {
    versionConflict(fresh.appointment.version)
  }
  try { assertCancellationPaymentTransition(fresh) } catch (error) {
    if (error instanceof Error && error.message === 'APPOINTMENT_PAYMENT_CONFLICT') throw error
    throw originalError
  }
  throw originalError
}

export async function cancelAppointment(input) {
  const command = captureCancelCommand(input)
  const actor = actorFact(command.actor)
  const requestDigest = await digestCancelNormalized(command.appointmentId, command.body)
  const idem = Object.freeze({
    actorId: actor.id, operation: CANCEL_OPERATION,
    idempotencyKey: command.idempotencyKey, requestDigest,
    resourceType: 'client', scopeType: 'client', scopePurpose: 'identity',
  })
  const replay = await inspectStoredScopeIdempotency(command.db, command.keyring, idem)
  if (replay) return validateCancelReplay(replay, command.appointmentId, command.body)

  const current = await retainedCancellationState(command, actor)
  if (command.body.expectedVersion !== current.appointment.version) {
    versionConflict(current.appointment.version)
  }
  assertCancellationPaymentTransition(current)
  let now
  try { now = new Date(command.nowMs).toISOString() } catch { throw new Error('INTERNAL_ERROR') }
  if (now <= current.appointment.updatedAt) throw new Error('INTERNAL_ERROR')
  const used = new Set()
  const appointmentVersionId = generated(command.idFactory, 'ver', isVersionId, used)
  const auditId = generated(command.idFactory, 'aud', isAuditId, used)
  const appointment = Object.freeze({
    ...current.appointment, status: 'cancelled', version: current.appointment.version + 1,
    cancelledAt: now, updatedAt: now,
    paymentAggregate: paymentAggregateFor('cancelled', current.charge.expectedAmountGrosze, 0),
  })
  const responsePayment = Object.freeze({
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
    latestMethod: null, latestReceivedAt: null, entries: current.payment.entries,
  })
  const response = Object.freeze({ status: 200, body: Object.freeze({
    data: Object.freeze({
      appointment: editAppointmentDto(appointment, current.charge, responsePayment),
    }),
  }) })
  const appointmentVersion = await versionBuilder.build(command.db, current.context, {
    clientId: current.client.id, versionId: appointmentVersionId,
    entityType: 'appointment', entity: appointment,
    changedByStaffId: actor.id, changedAt: now,
    correlationId: command.correlationId, ownerFact: null,
  })
  const idempotency = await createIdempotencyStatement(command.db, current.context, {
    actorId: actor.id, operation: CANCEL_OPERATION,
    idempotencyKey: command.idempotencyKey, requestDigest,
    expectedScope: current.context.scope, resourceType: 'client',
    resourceId: current.client.id, response, createdAt: now,
    expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  })
  const values = Object.freeze({
    appointment, charge: current.charge, client: current.client,
    payment: responsePayment, now, actorId: actor.id,
    appointmentVersionId, auditId, correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey, dataKeyId: current.context.dataKey.id,
  })
  const uow = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  uow.domain(command.db.prepare(
    `UPDATE appointments SET status='cancelled',version=?,cancelled_at=?,updated_at=?
     WHERE id=? AND client_id=? AND specialist_id=? AND service_id=?
       AND starts_at=? AND ends_at=? AND time_zone='Europe/Warsaw'
       AND location IS ? AND status=? AND source='panel' AND version=?
       AND cancelled_at IS NULL AND created_at=? AND updated_at=?
       AND EXISTS (SELECT 1 FROM session_charges WHERE id=? AND appointment_id=?
         AND service_id=? AND expected_amount_grosze=? AND currency='PLN'
         AND version=? AND created_at=? AND updated_at=?)
       AND (SELECT count(*) FROM session_charges WHERE appointment_id=?)=1
       AND (SELECT coalesce(sum(payment.amount_grosze),0)
         FROM payment_entries AS payment WHERE payment.appointment_id=?
           AND NOT EXISTS (SELECT 1 FROM payment_corrections
             WHERE reversed_entry_id=payment.id))=0`
  ).bind(
    appointment.version, now, now, current.appointment.id, current.client.id,
    current.appointment.specialistId, current.appointment.serviceId,
    current.appointment.startsAt, current.appointment.endsAt,
    current.appointment.location, current.appointment.status,
    current.appointment.version, current.appointment.createdAt,
    current.appointment.updatedAt, current.charge.id, current.appointment.id,
    current.charge.serviceId, current.charge.expectedAmountGrosze,
    current.charge.version, current.charge.createdAt, current.charge.updatedAt,
    current.appointment.id, current.appointment.id,
  ))
  uow.version(conditionalVersionStatement(
    command.db, appointmentVersion,
    "EXISTS (SELECT 1 FROM appointments WHERE id=? AND status='cancelled' AND version=? AND cancelled_at=? AND updated_at=?)",
    [appointment.id, appointment.version, now, now],
  ))
  uow.audit(auditEventStatement(command.db, {
    id: auditId, occurredAt: now, actorStaffId: actor.id,
    action: 'appointment.cancelled', entityType: 'appointment', entityId: appointment.id,
    result: 'success', correlationId: command.correlationId,
    metadata: { appointmentVersion: appointment.version, chargeVersion: current.charge.version },
    reasonEnvelope: null,
  }))
  uow.idempotency(idempotency)
  uow.guard(cancellationGuardStatement(command.db, values))
  try {
    await uow.commit()
    return response
  } catch (originalError) {
    if (isD1IdentityCollision(originalError)) {
      let collision
      try {
        collision = captureExact(
          await cancellationCollisionProof(command.db, values),
          ['stored', 'generated_collision'], cryptoFailure,
        )
      } catch { throw originalError }
      if (![0, 1].includes(collision.stored)
        || ![0, 1].includes(collision.generated_collision)) throw originalError
      if (collision.stored === 1 && collision.generated_collision === 0) {
        const winner = await recoverStoredScopeIdempotencyAfterCollision(
          command.recoveryDb, command.keyring, idem, originalError,
        )
        return validateCancelReplay(winner, command.appointmentId, command.body)
      }
    }
    if (isD1CoreDirectoryInvariantFailure(originalError)) {
      return reproveCancellationRace(command, actor, current, originalError)
    }
    throw originalError
  }
}
