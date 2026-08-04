import { encodeBase64Url } from '../security/encoding.js'
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
  buildClientDataKey,
  createOwnershipCapabilityBoundary,
  encryptClientIdentity,
} from './crypto.js'
import { createRecordVersionBuilder } from './versions.js'
import { isWellFormedUnicode } from '../../src/core-records.js'

const BODY_KEYS = Object.freeze(['name', 'age', 'status', 'specialistId'])
const INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const OPERATION = 'clients.create'
const ROUTE_TARGET = 'POST /api/v1/clients'
const PROSPECTIVE_CLIENT_ID = 'cl_authorization_target'
const DAY_MS = 24 * 60 * 60 * 1000
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const ASSIGNMENT_ID = /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const VERSION_ID = /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const AUDIT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ownership = createOwnershipCapabilityBoundary()
const versionBuilder = createRecordVersionBuilder(ownership.consumer)

const validation = (field) => { throw new TypeError(`VALIDATION_FAILED/${field}`) }
const forbidden = () => { throw new Error('FORBIDDEN') }
const notFound = () => { throw new Error('NOT_FOUND') }

const captureExact = (value, keys, field = 'body') => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) validation(field)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length || !keys.every((key) => actual.includes(key))) validation(field)
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) validation(field)
      captured[key] = descriptor.value
    }
    return Object.freeze(captured)
  } catch (error) {
    if (error instanceof TypeError && /^VALIDATION_FAILED\//.test(error.message)) throw error
    validation(field)
  }
}

const validName = (value) => {
  if (typeof value !== 'string' || value !== value.trim() || value !== value.normalize('NFC')
    || !isWellFormedUnicode(value)) return false
  const encoded = new TextEncoder().encode(value)
  const valid = encoded.byteLength >= 1 && encoded.byteLength <= 120
  encoded.fill(0)
  return valid
}

export function validateCreateClientBody(value) {
  const body = captureExact(value, BODY_KEYS)
  if (!validName(body.name)) validation('name')
  if (body.age !== null && (!Number.isSafeInteger(body.age) || body.age < 1 || body.age > 26)) validation('age')
  if (!['active', 'paused'].includes(body.status)) validation('status')
  if (typeof body.specialistId !== 'string' || !SPECIALIST_ID.test(body.specialistId)) validation('specialistId')
  return body
}

export async function digestCreateClientRequest(value) {
  const body = validateCreateClientBody(value)
  const plaintext = JSON.stringify({
    route: ROUTE_TARGET,
    body: {
      age: body.age,
      name: body.name,
      specialistId: body.specialistId,
      status: body.status,
    },
  })
  const encoded = new TextEncoder().encode(plaintext)
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
    return encodeBase64Url(digest)
  } finally {
    encoded.fill(0)
    digest?.fill(0)
  }
}

const captureCommand = (input) => {
  const captured = captureExact(input, INPUT_KEYS)
  if (!captured.db?.prepare || !captured.db?.batch || !captured.recoveryDb?.prepare
    || !captured.keyring || typeof captured.idFactory !== 'function'
    || !Number.isSafeInteger(captured.nowMs) || captured.nowMs < 0
    || typeof captured.correlationId !== 'string'
    || !CORRELATION_ID.test(captured.correlationId)
    || !IDEMPOTENCY_KEY.test(captured.idempotencyKey ?? '')) validation('body')
  return Object.freeze({ ...captured, body: validateCreateClientBody(captured.body) })
}

const actorFact = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) forbidden()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const data = {}
    for (const key of ['id', 'role', 'specialistId']) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) forbidden()
      data[key] = descriptor.value
    }
    if (typeof data.id !== 'string' || !STAFF_ID.test(data.id)
      || !['owner', 'coordinator', 'specialist'].includes(data.role)
      || (data.specialistId !== null
        && (typeof data.specialistId !== 'string' || !SPECIALIST_ID.test(data.specialistId)))
      || (data.role === 'specialist' && data.specialistId === null)) forbidden()
    return Object.freeze(data)
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') throw error
    forbidden()
  }
}

const practitionerFact = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) notFound()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(descriptors).length !== 2) notFound()
    const id = descriptors.id
    const staff = descriptors.staff_user_id
    if (!id || !staff || !Object.hasOwn(id, 'value') || !Object.hasOwn(staff, 'value')
      || typeof id.value !== 'string' || !SPECIALIST_ID.test(id.value)
      || typeof staff.value !== 'string' || !STAFF_ID.test(staff.value)) notFound()
    return Object.freeze({ id: id.value, staffUserId: staff.value })
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') throw error
    notFound()
  }
}

const generated = (factory, prefix, grammar, used) => {
  let suffix
  try { suffix = factory() } catch { throw new Error('INTERNAL_ERROR') }
  if (typeof suffix !== 'string' || !ID.test(suffix)) throw new Error('INTERNAL_ERROR')
  const value = `${prefix}_${suffix}`
  if (!grammar.test(value) || used.has(value)) throw new Error('INTERNAL_ERROR')
  used.add(value)
  return value
}

const clientDto = (client, assignment) => Object.freeze({
  id: client.id,
  name: client.name,
  age: client.age,
  status: client.status,
  version: client.version,
  archivedAt: client.archivedAt,
  createdAt: client.createdAt,
  updatedAt: client.updatedAt,
  readOnly: false,
  assignment: Object.freeze({
    id: assignment.id,
    specialistId: assignment.specialistId,
    startsAt: assignment.startsAt,
    version: assignment.version,
  }),
})

const replayFailure = () => { throw new Error('CRYPTO_FAILURE') }
const replayObject = (value, keys) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) replayFailure()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length || !keys.every((key) => actual.includes(key))) replayFailure()
    const result = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) replayFailure()
      result[key] = descriptor.value
    }
    return result
  } catch (error) {
    if (error instanceof Error && error.message === 'CRYPTO_FAILURE') throw error
    replayFailure()
  }
}

const canonicalInstant = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

const validateCreateReplay = (value, request) => {
  const replay = replayObject(value, ['status', 'body'])
  const body = replayObject(replay.body, ['data'])
  const data = replayObject(body.data, ['client'])
  const client = replayObject(data.client, [
    'id', 'name', 'age', 'status', 'version', 'archivedAt', 'createdAt', 'updatedAt',
    'readOnly', 'assignment',
  ])
  const assignment = replayObject(client.assignment, [
    'id', 'specialistId', 'startsAt', 'version',
  ])
  if (replay.status !== 201 || !CLIENT_ID.test(client.id)
    || client.name !== request.name || client.age !== request.age
    || client.status !== request.status || client.version !== 1
    || client.archivedAt !== null || client.readOnly !== false
    || !canonicalInstant(client.createdAt) || client.updatedAt !== client.createdAt
    || !ASSIGNMENT_ID.test(assignment.id)
    || assignment.specialistId !== request.specialistId
    || assignment.startsAt !== client.createdAt || assignment.version !== 1) replayFailure()
  return Object.freeze({
    status: 201,
    body: Object.freeze({ data: Object.freeze({
      client: clientDto(client, {
        id: assignment.id,
        specialistId: assignment.specialistId,
        startsAt: assignment.startsAt,
        version: assignment.version,
      }),
    }) }),
  })
}

const guardStatement = (db, values) => {
  const lifecycle = specialistPostcondition(values.practitionerStaffId)
  return db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'client_create_postcondition'
   WHERE NOT (
     EXISTS (SELECT 1 FROM data_keys
       WHERE id=? AND scope_type='client' AND scope_id=? AND purpose='identity'
         AND dek_version=1 AND retired_at IS NULL)
     AND EXISTS (SELECT 1 FROM clients
       WHERE id=? AND status=? AND version=1 AND archived_at IS NULL
         AND created_at=? AND updated_at=?
         AND json_extract(identity_envelope,'$.dataKeyId')=?
         AND json_extract(identity_envelope,'$.dataKeyVersion')=1)
     AND EXISTS (SELECT 1 FROM client_assignments
       WHERE id=? AND client_id=? AND specialist_id=? AND starts_at=? AND ends_at IS NULL
         AND assigned_by_staff_id=? AND version=1 AND created_at=? AND updated_at=?)
     AND (SELECT count(*) FROM record_versions
       WHERE ((id=? AND entity_type='client' AND entity_id=? AND version=1)
          OR (id=? AND entity_type='client_assignment' AND entity_id=? AND version=1))
         AND json_extract(snapshot_envelope,'$.dataKeyId')=?
         AND json_extract(snapshot_envelope,'$.dataKeyVersion')=1)=2
     AND EXISTS (SELECT 1 FROM audit_events
       WHERE id=? AND actor_staff_id=? AND action='client.created'
         AND entity_type='client' AND entity_id=? AND result='success'
         AND reason_envelope IS NULL AND correlation_id=? AND metadata_json=?)
     AND EXISTS (SELECT 1 FROM idempotency_records
       WHERE actor_id=? AND operation=? AND idempotency_key=?
         AND resource_type='client' AND resource_id=?
         AND json_extract(request_hash,'$.dataKeyId')=?
         AND json_extract(request_hash,'$.dataKeyVersion')=1
         AND json_extract(response_envelope,'$.dataKeyId')=?
         AND json_extract(response_envelope,'$.dataKeyVersion')=1)
     AND EXISTS (SELECT 1 FROM specialists AS specialist
       JOIN staff_users AS staff
         ON staff.id=specialist.staff_user_id AND staff.specialist_id=specialist.id
       WHERE specialist.id=? AND specialist.staff_user_id=?
         AND specialist.status='active' AND staff.status='active')
     AND (${lifecycle.sql})
   )`
  ).bind(
    values.dataKeyId, values.client.id,
    values.client.id, values.client.status, values.now, values.now, values.dataKeyId,
    values.assignment.id, values.client.id, values.assignment.specialistId, values.now,
    values.actorId, values.now, values.now,
    values.clientVersionId, values.client.id,
    values.assignmentVersionId, values.assignment.id, values.dataKeyId,
    values.auditId, values.actorId, values.client.id, values.correlationId,
    JSON.stringify({ assignmentId: values.assignment.id, assignmentVersion: 1, clientVersion: 1 }),
    values.actorId, OPERATION, values.idempotencyKey, values.client.id,
    values.dataKeyId, values.dataKeyId,
    values.assignment.specialistId, values.practitionerStaffId,
    ...lifecycle.bindings,
  )
}

const loadActivePractitioner = async (db, specialistId, actor) => db.prepare(
  `SELECT specialist.id, specialist.staff_user_id
   FROM specialists AS specialist
   JOIN staff_users AS staff
     ON staff.id=specialist.staff_user_id AND staff.specialist_id=specialist.id
   WHERE specialist.id=?
     AND specialist.status='active'
     AND staff.status='active'
     AND (
       ? IN ('owner','coordinator')
       OR (?='specialist' AND specialist.id=?)
     )`
).bind(specialistId, actor.role, actor.role, actor.specialistId).first()

export async function createClient(input) {
  const command = captureCommand(input)
  const actor = actorFact(command.actor)
  const requestDigest = await digestCreateClientRequest(command.body)
  const idem = Object.freeze({
    actorId: actor.id,
    operation: OPERATION,
    idempotencyKey: command.idempotencyKey,
    requestDigest,
    resourceType: 'client',
    scopeType: 'client',
    scopePurpose: 'identity',
  })
  const replay = await inspectStoredScopeIdempotency(command.db, command.keyring, idem)
  if (replay) return validateCreateReplay(replay, command.body)
  const practitioner = practitionerFact(
    await loadActivePractitioner(command.db, command.body.specialistId, actor)
  )
  if (practitioner.id !== command.body.specialistId
    || !authorize(actor, 'client.manage', {
      kind: 'client',
      clientId: PROSPECTIVE_CLIENT_ID,
      assignment: {
        kind: 'client_assignment', clientId: PROSPECTIVE_CLIENT_ID,
        specialistId: command.body.specialistId, status: 'active',
      },
    }, { nowMs: command.nowMs })) notFound()

  let now
  try { now = new Date(command.nowMs).toISOString() } catch { throw new Error('INTERNAL_ERROR') }
  const used = new Set()
  const clientId = generated(command.idFactory, 'cl', CLIENT_ID, used)
  const assignmentId = generated(command.idFactory, 'asg', ASSIGNMENT_ID, used)
  const clientVersionId = generated(command.idFactory, 'ver', VERSION_ID, used)
  const assignmentVersionId = generated(command.idFactory, 'ver', VERSION_ID, used)
  const auditId = generated(command.idFactory, 'aud', AUDIT_ID, used)
  const dataKeyId = generated(command.idFactory, 'key', ID, used)

  const built = await buildClientDataKey(command.db, command.keyring, {
    clientId, dataKeyId, createdAt: now,
  })
  const context = Object.freeze({ keyring: command.keyring, dataKey: built.row, scope: built.scope })
  const client = Object.freeze({
    id: clientId, name: command.body.name, age: command.body.age,
    status: command.body.status, version: 1, archivedAt: null,
    createdAt: now, updatedAt: now,
  })
  const assignment = Object.freeze({
    id: assignmentId, clientId, specialistId: practitioner.id, startsAt: now,
    endsAt: null, assignedByStaffId: actor.id, version: 1,
    createdAt: now, updatedAt: now,
  })
  const identityEnvelope = await encryptClientIdentity(context, {
    clientId, name: client.name, age: client.age,
  })
  const clientVersion = await versionBuilder.build(command.db, context, {
    clientId, versionId: clientVersionId, entityType: 'client', entity: client,
    changedByStaffId: actor.id, changedAt: now, correlationId: command.correlationId,
    ownerFact: null,
  })
  const assignmentVersion = await versionBuilder.build(command.db, context, {
    clientId, versionId: assignmentVersionId, entityType: 'client_assignment',
    entity: assignment, changedByStaffId: actor.id, changedAt: now,
    correlationId: command.correlationId, ownerFact: null,
  })
  const body = Object.freeze({ data: Object.freeze({ client: clientDto(client, assignment) }) })
  const response = Object.freeze({ status: 201, body })
  const expiresAt = new Date(command.nowMs + 7 * DAY_MS).toISOString()
  const idempotency = await createIdempotencyStatement(command.db, context, {
    actorId: idem.actorId,
    operation: idem.operation,
    idempotencyKey: idem.idempotencyKey,
    requestDigest: idem.requestDigest,
    expectedScope: built.scope,
    resourceType: 'client',
    resourceId: clientId,
    response,
    createdAt: now,
    expiresAt,
  })
  const uow = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  uow.domain(built.statement)
  uow.domain(command.db.prepare(
    `INSERT INTO clients
     (id,identity_envelope,status,version,archived_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(clientId, identityEnvelope, client.status, 1, null, now, now))
  uow.domain(command.db.prepare(
    `INSERT INTO client_assignments
     (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
      version,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(assignmentId, clientId, practitioner.id, now, null, actor.id, 1, now, now))
  uow.version(clientVersion.statement)
  uow.version(assignmentVersion.statement)
  uow.audit(auditEventStatement(command.db, {
    id: auditId, occurredAt: now, actorStaffId: actor.id, action: 'client.created',
    entityType: 'client', entityId: clientId, result: 'success',
    correlationId: command.correlationId,
    metadata: { clientVersion: 1, assignmentId, assignmentVersion: 1 },
    reasonEnvelope: null,
  }))
  uow.idempotency(idempotency)
  uow.guard(guardStatement(command.db, {
    dataKeyId, client, assignment, now, actorId: actor.id, clientVersionId,
    assignmentVersionId, auditId, correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey, practitionerStaffId: practitioner.staffUserId,
  }))
  try {
    await uow.commit()
    return response
  } catch (originalError) {
    if (!isD1IdentityCollision(originalError)) throw originalError
    const recovered = await recoverStoredScopeIdempotencyAfterCollision(
      command.recoveryDb, command.keyring, idem, originalError,
    )
    return validateCreateReplay(recovered, command.body)
  }
}
