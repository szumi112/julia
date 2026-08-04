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
import { assertClientKeyScope } from './crypto.js'

const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const CLIENT_STATUSES = new Set(['active', 'paused', 'archived'])
const APPOINTMENT_STATUSES = new Set(['scheduled', 'completed', 'cancelled', 'noshow'])
const PAYMENT_STATUSES = new Set(['paid', 'partial', 'unpaid'])
const MAX_GROSZE = 1_000_000

const fail = () => { throw new Error('CRYPTO_FAILURE') }
const exactObject = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const positive = (value) => Number.isSafeInteger(value) && value >= 1
const grosze = (value, { zero = false } = {}) => Number.isSafeInteger(value)
  && value >= (zero ? 0 : 1) && value <= MAX_GROSZE
const instant = (value) => {
  try { return assertCanonicalUtc(value) === value } catch { return false }
}
const service = (value) => typeof value === 'string' && Boolean(SERVICE_BY_ID[value])

function requireContext(context, clientId) {
  if (!exactObject(context, ['keyring', 'dataKey', 'scope']) || !context.keyring
    || !context.dataKey) fail()
  const scope = assertClientKeyScope(context.scope)
  if (scope.id !== clientId
    || context.dataKey.scope_type !== scope.type
    || context.dataKey.scope_id !== scope.id
    || context.dataKey.purpose !== scope.purpose) fail()
  return { keyring: context.keyring, dataKey: context.dataKey, scope }
}

function clientSnapshot(entity) {
  if (!exactObject(entity, [
    'id', 'name', 'age', 'status', 'version', 'archivedAt', 'createdAt', 'updatedAt',
  ]) || !isClientId(entity.id) || !CLIENT_STATUSES.has(entity.status)
    || !positive(entity.version) || !instant(entity.createdAt) || !instant(entity.updatedAt)
    || entity.createdAt > entity.updatedAt
    || !((entity.status === 'archived' && instant(entity.archivedAt))
      || (entity.status !== 'archived' && entity.archivedAt === null))) fail()
  let identity
  try { identity = assertClientIdentity({ name: entity.name, age: entity.age }) } catch { fail() }
  return {
    age: identity.age,
    archivedAt: entity.archivedAt,
    createdAt: entity.createdAt,
    id: entity.id,
    name: identity.name,
    schema: 'client.v1',
    status: entity.status,
    updatedAt: entity.updatedAt,
    version: entity.version,
  }
}

function assignmentSnapshot(entity) {
  if (!exactObject(entity, [
    'id', 'clientId', 'specialistId', 'startsAt', 'endsAt', 'assignedByStaffId',
    'version', 'createdAt', 'updatedAt',
  ]) || !isAssignmentId(entity.id) || !isClientId(entity.clientId)
    || !isSpecialistId(entity.specialistId) || !STAFF_ID.test(entity.assignedByStaffId ?? '')
    || !instant(entity.startsAt) || (entity.endsAt !== null
      && (!instant(entity.endsAt) || entity.endsAt <= entity.startsAt))
    || !positive(entity.version) || !instant(entity.createdAt) || !instant(entity.updatedAt)
    || entity.createdAt > entity.updatedAt) fail()
  return {
    assignedByStaffId: entity.assignedByStaffId,
    clientId: entity.clientId,
    createdAt: entity.createdAt,
    endsAt: entity.endsAt,
    id: entity.id,
    schema: 'client_assignment.v1',
    specialistId: entity.specialistId,
    startsAt: entity.startsAt,
    updatedAt: entity.updatedAt,
    version: entity.version,
  }
}

function paymentAggregate(value) {
  if (!exactObject(value, ['status', 'collectedGrosze', 'outstandingGrosze'])
    || !PAYMENT_STATUSES.has(value.status)
    || !grosze(value.collectedGrosze, { zero: true })
    || !grosze(value.outstandingGrosze, { zero: true })
    || (value.status === 'unpaid' && value.collectedGrosze !== 0)
    || (value.status === 'paid' && value.outstandingGrosze !== 0)
    || (value.status === 'partial'
      && (value.collectedGrosze === 0 || value.outstandingGrosze === 0))) fail()
  return {
    collectedGrosze: value.collectedGrosze,
    outstandingGrosze: value.outstandingGrosze,
    status: value.status,
  }
}

function appointmentSnapshot(entity) {
  if (!exactObject(entity, [
    'id', 'clientId', 'specialistId', 'serviceId', 'startsAt', 'endsAt', 'timeZone',
    'location', 'status', 'source', 'version', 'cancelledAt', 'createdAt', 'updatedAt',
    'paymentAggregate',
  ]) || !isAppointmentId(entity.id) || !isClientId(entity.clientId)
    || !isSpecialistId(entity.specialistId) || !service(entity.serviceId)
    || !instant(entity.startsAt) || !instant(entity.endsAt) || entity.endsAt <= entity.startsAt
    || entity.timeZone !== 'Europe/Warsaw' || !APPOINTMENT_STATUSES.has(entity.status)
    || entity.source !== 'panel' || !positive(entity.version)
    || !instant(entity.createdAt) || !instant(entity.updatedAt) || entity.createdAt > entity.updatedAt
    || !((entity.status === 'cancelled' && instant(entity.cancelledAt))
      || (entity.status !== 'cancelled' && entity.cancelledAt === null))) fail()
  try { assertLocation(entity.location) } catch { fail() }
  return {
    cancelledAt: entity.cancelledAt,
    clientId: entity.clientId,
    createdAt: entity.createdAt,
    endsAt: entity.endsAt,
    id: entity.id,
    location: entity.location,
    paymentAggregate: paymentAggregate(entity.paymentAggregate),
    schema: 'appointment.v1',
    serviceId: entity.serviceId,
    source: entity.source,
    specialistId: entity.specialistId,
    startsAt: entity.startsAt,
    status: entity.status,
    timeZone: entity.timeZone,
    updatedAt: entity.updatedAt,
    version: entity.version,
  }
}

function chargeSnapshot(entity) {
  if (!exactObject(entity, [
    'id', 'appointmentId', 'serviceId', 'expectedAmountGrosze', 'currency',
    'version', 'createdAt', 'updatedAt',
  ]) || !isChargeId(entity.id) || !isAppointmentId(entity.appointmentId)
    || !service(entity.serviceId) || !grosze(entity.expectedAmountGrosze)
    || entity.currency !== 'PLN' || !positive(entity.version)
    || !instant(entity.createdAt) || !instant(entity.updatedAt)
    || entity.createdAt > entity.updatedAt) fail()
  return {
    appointmentId: entity.appointmentId,
    createdAt: entity.createdAt,
    currency: entity.currency,
    expectedAmountGrosze: entity.expectedAmountGrosze,
    id: entity.id,
    schema: 'session_charge.v1',
    serviceId: entity.serviceId,
    updatedAt: entity.updatedAt,
    version: entity.version,
  }
}

function snapshotFor(entityType, entity, clientId) {
  if (entityType === 'client') {
    const snapshot = clientSnapshot(entity)
    if (snapshot.id !== clientId) fail()
    return snapshot
  }
  if (entityType === 'client_assignment') {
    const snapshot = assignmentSnapshot(entity)
    if (snapshot.clientId !== clientId) fail()
    return snapshot
  }
  if (entityType === 'appointment') {
    const snapshot = appointmentSnapshot(entity)
    if (snapshot.clientId !== clientId) fail()
    return snapshot
  }
  if (entityType === 'session_charge') return chargeSnapshot(entity)
  fail()
}

export async function buildRecordVersion(db, context, input) {
  try {
    if (!db?.prepare || !exactObject(input, [
      'clientId', 'versionId', 'entityType', 'entity', 'changedByStaffId',
      'changedAt', 'correlationId',
    ]) || !isClientId(input.clientId) || !isVersionId(input.versionId)
      || (input.changedByStaffId !== null && !STAFF_ID.test(input.changedByStaffId ?? ''))
      || !instant(input.changedAt) || !isOpaqueId(input.correlationId)) fail()
    const current = requireContext(context, input.clientId)
    const snapshot = snapshotFor(input.entityType, input.entity, input.clientId)
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
      id: input.versionId,
      entity_type: input.entityType,
      entity_id: snapshot.id,
      version: snapshot.version,
      snapshot_envelope: snapshotEnvelope,
      changed_by_staff_id: input.changedByStaffId,
      changed_at: input.changedAt,
      correlation_id: input.correlationId,
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
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}
