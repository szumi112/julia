import {
  assertCanonicalUtc,
  assertClientIdentity,
  assertLocation,
  isAppointmentId,
  isAssignmentId,
  isChargeId,
  isClientId,
  isOpaqueId,
  isSpecialistId,
  isVersionId,
} from '../../src/core-records.js'
import { SERVICE_BY_ID } from '../../src/services.js'
import { encryptForScope } from '../security/envelope.js'
import {
  assertClientKeyScope,
  createOwnershipBoundVersionFacade,
} from './crypto.js'

const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const CLIENT_STATUSES = new Set(['active', 'paused', 'archived'])
const APPOINTMENT_STATUSES = new Set(['scheduled', 'completed', 'cancelled', 'noshow'])
const PAYMENT_STATUSES = new Set(['paid', 'partial', 'unpaid'])
const MAX_GROSZE = 1_000_000
const DATA_KEY_KEYS = Object.freeze([
  'id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64',
  'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at',
])

const fail = () => { throw new Error('CRYPTO_FAILURE') }
const captureExact = (value, keys) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length || !keys.every((key) => actual.includes(key))) fail()
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail()
      captured[key] = descriptor.value
    }
    return Object.freeze(captured)
  } catch { fail() }
}
const positive = (value) => Number.isSafeInteger(value) && value >= 1
const grosze = (value, { zero = false } = {}) => Number.isSafeInteger(value)
  && value >= (zero ? 0 : 1) && value <= MAX_GROSZE
const instant = (value) => {
  try { return assertCanonicalUtc(value) === value } catch { return false }
}
const service = (value) => typeof value === 'string' && Boolean(SERVICE_BY_ID[value])

function requireContext(context, clientId) {
  const captured = captureExact(context, ['keyring', 'dataKey', 'scope'])
  if (!captured.keyring || !captured.dataKey) fail()
  const scope = assertClientKeyScope(captured.scope)
  const dataKey = captureExact(captured.dataKey, DATA_KEY_KEYS)
  if (scope.id !== clientId
    || dataKey.scope_type !== scope.type
    || dataKey.scope_id !== scope.id
    || dataKey.purpose !== scope.purpose) fail()
  return Object.freeze({ keyring: captured.keyring, dataKey, scope })
}

function clientSnapshot(entity) {
  const row = captureExact(entity, [
    'id', 'name', 'age', 'status', 'version', 'archivedAt', 'createdAt', 'updatedAt',
  ])
  if (!isClientId(row.id) || !CLIENT_STATUSES.has(row.status)
    || !positive(row.version) || !instant(row.createdAt) || !instant(row.updatedAt)
    || row.createdAt > row.updatedAt
    || !((row.status === 'archived' && instant(row.archivedAt))
      || (row.status !== 'archived' && row.archivedAt === null))) fail()
  let identity
  try { identity = assertClientIdentity({ name: row.name, age: row.age }) } catch { fail() }
  return {
    age: identity.age,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    id: row.id,
    name: identity.name,
    schema: 'client.v1',
    status: row.status,
    updatedAt: row.updatedAt,
    version: row.version,
  }
}

function assignmentSnapshot(entity) {
  const row = captureExact(entity, [
    'id', 'clientId', 'specialistId', 'startsAt', 'endsAt', 'assignedByStaffId',
    'version', 'createdAt', 'updatedAt',
  ])
  if (!isAssignmentId(row.id) || !isClientId(row.clientId)
    || !isSpecialistId(row.specialistId) || typeof row.assignedByStaffId !== 'string'
    || !STAFF_ID.test(row.assignedByStaffId)
    || !instant(row.startsAt) || (row.endsAt !== null
      && (!instant(row.endsAt) || row.endsAt <= row.startsAt))
    || !positive(row.version) || !instant(row.createdAt) || !instant(row.updatedAt)
    || row.createdAt > row.updatedAt) fail()
  return {
    assignedByStaffId: row.assignedByStaffId,
    clientId: row.clientId,
    createdAt: row.createdAt,
    endsAt: row.endsAt,
    id: row.id,
    schema: 'client_assignment.v1',
    specialistId: row.specialistId,
    startsAt: row.startsAt,
    updatedAt: row.updatedAt,
    version: row.version,
  }
}

function paymentAggregate(value) {
  const aggregate = captureExact(value, ['status', 'collectedGrosze', 'outstandingGrosze'])
  if (!PAYMENT_STATUSES.has(aggregate.status)
    || !grosze(aggregate.collectedGrosze, { zero: true })
    || !grosze(aggregate.outstandingGrosze, { zero: true })
    || (aggregate.status === 'unpaid' && aggregate.collectedGrosze !== 0)
    || (aggregate.status === 'paid' && aggregate.outstandingGrosze !== 0)
    || (aggregate.status === 'partial'
      && (aggregate.collectedGrosze === 0 || aggregate.outstandingGrosze === 0))) fail()
  return {
    collectedGrosze: aggregate.collectedGrosze,
    outstandingGrosze: aggregate.outstandingGrosze,
    status: aggregate.status,
  }
}

function appointmentSnapshot(entity) {
  const row = captureExact(entity, [
    'id', 'clientId', 'specialistId', 'serviceId', 'startsAt', 'endsAt', 'timeZone',
    'location', 'status', 'source', 'version', 'cancelledAt', 'createdAt', 'updatedAt',
    'paymentAggregate',
  ])
  if (!isAppointmentId(row.id) || !isClientId(row.clientId)
    || !isSpecialistId(row.specialistId) || !service(row.serviceId)
    || !instant(row.startsAt) || !instant(row.endsAt) || row.endsAt <= row.startsAt
    || row.timeZone !== 'Europe/Warsaw' || !APPOINTMENT_STATUSES.has(row.status)
    || row.source !== 'panel' || !positive(row.version)
    || !instant(row.createdAt) || !instant(row.updatedAt) || row.createdAt > row.updatedAt
    || !((row.status === 'cancelled' && instant(row.cancelledAt))
      || (row.status !== 'cancelled' && row.cancelledAt === null))) fail()
  try { assertLocation(row.location) } catch { fail() }
  return {
    cancelledAt: row.cancelledAt,
    clientId: row.clientId,
    createdAt: row.createdAt,
    endsAt: row.endsAt,
    id: row.id,
    location: row.location,
    paymentAggregate: paymentAggregate(row.paymentAggregate),
    schema: 'appointment.v1',
    serviceId: row.serviceId,
    source: row.source,
    specialistId: row.specialistId,
    startsAt: row.startsAt,
    status: row.status,
    timeZone: row.timeZone,
    updatedAt: row.updatedAt,
    version: row.version,
  }
}

function chargeSnapshot(entity) {
  const row = captureExact(entity, [
    'id', 'appointmentId', 'serviceId', 'expectedAmountGrosze', 'currency',
    'version', 'createdAt', 'updatedAt',
  ])
  if (!isChargeId(row.id) || !isAppointmentId(row.appointmentId)
    || !service(row.serviceId) || !grosze(row.expectedAmountGrosze)
    || row.currency !== 'PLN' || !positive(row.version)
    || !instant(row.createdAt) || !instant(row.updatedAt)
    || row.createdAt > row.updatedAt) fail()
  return {
    appointmentId: row.appointmentId,
    createdAt: row.createdAt,
    currency: row.currency,
    expectedAmountGrosze: row.expectedAmountGrosze,
    id: row.id,
    schema: 'session_charge.v1',
    serviceId: row.serviceId,
    updatedAt: row.updatedAt,
    version: row.version,
  }
}

function snapshotFor(entityType, entity, clientId, ownerFact, verifiedChargeOwner) {
  if (entityType === 'client') {
    if (ownerFact !== null || verifiedChargeOwner !== null) fail()
    const snapshot = clientSnapshot(entity)
    if (snapshot.id !== clientId) fail()
    return snapshot
  }
  if (entityType === 'client_assignment') {
    if (ownerFact !== null || verifiedChargeOwner !== null) fail()
    const snapshot = assignmentSnapshot(entity)
    if (snapshot.clientId !== clientId) fail()
    return snapshot
  }
  if (entityType === 'appointment') {
    if (ownerFact !== null || verifiedChargeOwner !== null) fail()
    const snapshot = appointmentSnapshot(entity)
    if (snapshot.clientId !== clientId) fail()
    return snapshot
  }
  if (entityType === 'session_charge') {
    if (verifiedChargeOwner === null) fail()
    const snapshot = chargeSnapshot(entity)
    if (verifiedChargeOwner.clientId !== clientId
      || verifiedChargeOwner.appointmentId !== snapshot.appointmentId) fail()
    return snapshot
  }
  fail()
}

async function buildRecordVersion(db, context, input, verifiedChargeOwner) {
  try {
    if (!db?.prepare) fail()
    const captured = captureExact(input, [
      'clientId', 'versionId', 'entityType', 'entity', 'changedByStaffId',
      'changedAt', 'correlationId', 'ownerFact',
    ])
    if (!isClientId(captured.clientId) || !isVersionId(captured.versionId)
      || (captured.changedByStaffId !== null
        && (typeof captured.changedByStaffId !== 'string'
          || !STAFF_ID.test(captured.changedByStaffId)))
      || !instant(captured.changedAt) || !isOpaqueId(captured.correlationId)) fail()
    const current = requireContext(context, captured.clientId)
    const snapshot = snapshotFor(
      captured.entityType, captured.entity, captured.clientId, captured.ownerFact,
      verifiedChargeOwner,
    )
    const snapshotEnvelope = JSON.stringify(await encryptForScope(
      current.keyring,
      current.dataKey,
      {
        expectedScope: current.scope,
        recordId: snapshot.id,
        field: 'record_version',
        plaintext: JSON.stringify(snapshot),
      },
    ))
    const row = Object.freeze({
      id: captured.versionId,
      entity_type: captured.entityType,
      entity_id: snapshot.id,
      version: snapshot.version,
      snapshot_envelope: snapshotEnvelope,
      changed_by_staff_id: captured.changedByStaffId,
      changed_at: captured.changedAt,
      correlation_id: captured.correlationId,
    })
    const statement = db.prepare(
      `INSERT INTO record_versions
       (id, entity_type, entity_id, version, snapshot_envelope,
        changed_by_staff_id, changed_at, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id, row.entity_type, row.entity_id, row.version, row.snapshot_envelope,
      row.changed_by_staff_id, row.changed_at, row.correlation_id,
    )
    return Object.freeze({ row, statement })
  } catch { fail() }
}

export function createRecordVersionBuilder(...args) {
  try {
    if (args.length !== 1) fail()
    return createOwnershipBoundVersionFacade(args[0], buildRecordVersion)
  } catch { fail() }
}
