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
  buildClientDataKey,
  createOwnershipCapabilityBoundary,
  decryptClientIdentity,
  encryptClientIdentity,
  loadClientCryptoContext,
} from './crypto.js'
import { createRecordVersionBuilder } from './versions.js'
import { isWellFormedUnicode } from '../../src/core-records.js'

const BODY_KEYS = Object.freeze(['name', 'age', 'status', 'specialistId'])
const EDIT_BODY_KEYS = Object.freeze(['expectedVersion', ...BODY_KEYS])
const INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const EDIT_INPUT_KEYS = Object.freeze([...INPUT_KEYS.slice(0, 7), 'clientId', ...INPUT_KEYS.slice(7)])
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const OPERATION = 'clients.create'
const EDIT_OPERATION = 'clients.edit'
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

export function validateEditClientBody(value) {
  const body = captureExact(value, EDIT_BODY_KEYS)
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    validation('expectedVersion')
  }
  validateCreateClientBody(Object.freeze({
    name: body.name,
    age: body.age,
    status: body.status,
    specialistId: body.specialistId,
  }))
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

export async function digestEditClientRequest(clientId, value) {
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) validation('clientId')
  const body = validateEditClientBody(value)
  const plaintext = JSON.stringify({
    route: `POST /api/v1/clients/${clientId}/edits`,
    body: {
      age: body.age,
      expectedVersion: body.expectedVersion,
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

const captureEditCommand = (input) => {
  const captured = captureExact(input, EDIT_INPUT_KEYS)
  if (!captured.db?.prepare || !captured.db?.batch || !captured.recoveryDb?.prepare
    || !captured.keyring || typeof captured.idFactory !== 'function'
    || !Number.isSafeInteger(captured.nowMs) || captured.nowMs < 0
    || typeof captured.correlationId !== 'string'
    || !CORRELATION_ID.test(captured.correlationId)
    || !IDEMPOTENCY_KEY.test(captured.idempotencyKey ?? '')) validation('body')
  if (typeof captured.clientId !== 'string' || !CLIENT_ID.test(captured.clientId)) validation('clientId')
  return Object.freeze({ ...captured, body: validateEditClientBody(captured.body) })
}

const loadScopedClient = async (db, clientId, actor) => db.prepare(
  `SELECT client.id,
          client.identity_envelope,
          client.status,
          client.version,
          client.archived_at,
          client.created_at,
          client.updated_at,
          assignment.id AS assignment_id,
          assignment.specialist_id,
          assignment.starts_at,
          assignment.ends_at,
          assignment.assigned_by_staff_id,
          assignment.version AS assignment_version,
          assignment.created_at AS assignment_created_at,
          assignment.updated_at AS assignment_updated_at,
          client_key.id AS data_key_id,
          client_key.scope_type AS data_key_scope_type,
          client_key.scope_id AS data_key_scope_id,
          client_key.purpose AS data_key_purpose,
          client_key.dek_version AS data_key_version,
          client_key.retired_at AS data_key_retired_at,
          client_version.id AS client_record_version_id,
          client_version.entity_type AS client_record_version_type,
          client_version.entity_id AS client_record_version_entity_id,
          client_version.version AS client_record_version_number,
          client_version.snapshot_envelope AS client_record_version_envelope,
          client_version.changed_by_staff_id AS client_record_version_actor,
          client_version.changed_at AS client_record_version_changed_at,
          client_version.correlation_id AS client_record_version_correlation,
          assignment_version.id AS assignment_record_version_id,
          assignment_version.entity_type AS assignment_record_version_type,
          assignment_version.entity_id AS assignment_record_version_entity_id,
          assignment_version.version AS assignment_record_version_number,
          assignment_version.snapshot_envelope AS assignment_record_version_envelope,
          assignment_version.changed_by_staff_id AS assignment_record_version_actor,
          assignment_version.changed_at AS assignment_record_version_changed_at,
          assignment_version.correlation_id AS assignment_record_version_correlation
   FROM clients AS client
   JOIN client_assignments AS assignment
     ON assignment.client_id=client.id AND assignment.ends_at IS NULL
   JOIN data_keys AS client_key
     ON client_key.id=json_extract(
          CASE WHEN json_valid(client.identity_envelope)
            THEN client.identity_envelope ELSE '{}' END,'$.dataKeyId')
    AND client_key.dek_version=json_extract(
          CASE WHEN json_valid(client.identity_envelope)
            THEN client.identity_envelope ELSE '{}' END,'$.dataKeyVersion')
    AND client_key.scope_type='client'
    AND client_key.scope_id=client.id
    AND client_key.purpose='identity'
    AND client_key.dek_version=1
    AND client_key.retired_at IS NULL
   JOIN record_versions AS client_version
     ON client_version.entity_type='client'
    AND client_version.entity_id=client.id
    AND client_version.version=client.version
   JOIN record_versions AS assignment_version
     ON assignment_version.entity_type='client_assignment'
    AND assignment_version.entity_id=assignment.id
    AND assignment_version.version=assignment.version
   WHERE client.id=?
     AND client.status IN ('active','paused')
     AND (
       ? IN ('owner','coordinator')
       OR (?='specialist' AND client.status='active' AND assignment.specialist_id=?)
     )
     AND (SELECT count(*) FROM record_versions AS version
       WHERE version.entity_type='client' AND version.entity_id=client.id)=client.version
     AND (SELECT min(version.version) FROM record_versions AS version
       WHERE version.entity_type='client' AND version.entity_id=client.id)=1
     AND (SELECT max(version.version) FROM record_versions AS version
       WHERE version.entity_type='client' AND version.entity_id=client.id)=client.version
     AND NOT EXISTS (SELECT 1 FROM record_versions AS version
       WHERE version.entity_id=client.id AND version.entity_type!='client')
     AND NOT EXISTS (SELECT 1 FROM record_versions AS version
       WHERE version.entity_type='client' AND version.entity_id=client.id
         AND (
           NOT json_valid(version.snapshot_envelope)
           OR json_extract(CASE WHEN json_valid(version.snapshot_envelope)
                THEN version.snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT client_key.id
           OR json_extract(CASE WHEN json_valid(version.snapshot_envelope)
                THEN version.snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1
         ))
     AND (SELECT count(*) FROM record_versions AS version
       WHERE version.entity_type='client_assignment'
         AND version.entity_id=assignment.id)=assignment.version
     AND (SELECT min(version.version) FROM record_versions AS version
       WHERE version.entity_type='client_assignment'
         AND version.entity_id=assignment.id)=1
     AND (SELECT max(version.version) FROM record_versions AS version
       WHERE version.entity_type='client_assignment'
         AND version.entity_id=assignment.id)=assignment.version
     AND NOT EXISTS (SELECT 1 FROM record_versions AS version
       WHERE version.entity_id=assignment.id
         AND version.entity_type!='client_assignment')
     AND NOT EXISTS (SELECT 1 FROM record_versions AS version
       WHERE version.entity_type='client_assignment'
         AND version.entity_id=assignment.id
         AND (
           NOT json_valid(version.snapshot_envelope)
           OR json_extract(CASE WHEN json_valid(version.snapshot_envelope)
                THEN version.snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT client_key.id
           OR json_extract(CASE WHEN json_valid(version.snapshot_envelope)
                THEN version.snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1
         ))
   GROUP BY client.id
   HAVING count(assignment.id)=1`
).bind(clientId, actor.role, actor.role, actor.specialistId).first()

const retainedSnapshotFact = (serialized, dataKeyId) => {
  try {
    if (typeof serialized !== 'string') notFound()
    const envelope = replayObject(JSON.parse(serialized), [
      'format', 'algorithm', 'dataKeyId', 'dataKeyVersion', 'nonce', 'ciphertext',
    ])
    if (envelope.format !== 1 || envelope.algorithm !== 'A256GCM'
      || envelope.dataKeyId !== dataKeyId || envelope.dataKeyVersion !== 1
      || typeof envelope.nonce !== 'string'
      || !/^[A-Za-z0-9_-]{16}$/.test(envelope.nonce)
      || typeof envelope.ciphertext !== 'string'
      || !/^[A-Za-z0-9_-]{22,}$/.test(envelope.ciphertext)) notFound()
    return serialized
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') throw error
    notFound()
  }
}

const scopedClientFact = (value, clientId) => {
  try {
    const row = replayObject(value, [
      'id', 'identity_envelope', 'status', 'version', 'archived_at', 'created_at',
      'updated_at', 'assignment_id', 'specialist_id', 'starts_at', 'ends_at',
      'assigned_by_staff_id', 'assignment_version', 'assignment_created_at',
      'assignment_updated_at', 'data_key_id', 'data_key_scope_type',
      'data_key_scope_id', 'data_key_purpose', 'data_key_version',
      'data_key_retired_at', 'client_record_version_id',
      'client_record_version_type', 'client_record_version_entity_id',
      'client_record_version_number', 'client_record_version_envelope',
      'client_record_version_actor', 'client_record_version_changed_at',
      'client_record_version_correlation', 'assignment_record_version_id',
      'assignment_record_version_type', 'assignment_record_version_entity_id',
      'assignment_record_version_number', 'assignment_record_version_envelope',
      'assignment_record_version_actor', 'assignment_record_version_changed_at',
      'assignment_record_version_correlation',
    ])
    if (row.id !== clientId || typeof row.identity_envelope !== 'string'
      || !['active', 'paused'].includes(row.status)
      || !Number.isSafeInteger(row.version) || row.version < 1
      || row.archived_at !== null || !canonicalInstant(row.created_at)
      || !canonicalInstant(row.updated_at) || row.updated_at < row.created_at
      || typeof row.assignment_id !== 'string' || !ASSIGNMENT_ID.test(row.assignment_id)
      || typeof row.specialist_id !== 'string' || !SPECIALIST_ID.test(row.specialist_id)
      || !canonicalInstant(row.starts_at) || row.ends_at !== null
      || typeof row.assigned_by_staff_id !== 'string' || !STAFF_ID.test(row.assigned_by_staff_id)
      || !Number.isSafeInteger(row.assignment_version) || row.assignment_version < 1
      || !canonicalInstant(row.assignment_created_at)
      || !canonicalInstant(row.assignment_updated_at)
      || row.assignment_created_at > row.assignment_updated_at
      || typeof row.data_key_id !== 'string' || !ID.test(row.data_key_id)
      || row.data_key_scope_type !== 'client' || row.data_key_scope_id !== clientId
      || row.data_key_purpose !== 'identity' || row.data_key_version !== 1
      || row.data_key_retired_at !== null
      || typeof row.client_record_version_id !== 'string'
      || !VERSION_ID.test(row.client_record_version_id)
      || row.client_record_version_type !== 'client'
      || row.client_record_version_entity_id !== clientId
      || row.client_record_version_number !== row.version
      || typeof row.client_record_version_actor !== 'string'
      || !STAFF_ID.test(row.client_record_version_actor)
      || !canonicalInstant(row.client_record_version_changed_at)
      || typeof row.client_record_version_correlation !== 'string'
      || !ID.test(row.client_record_version_correlation)
      || typeof row.assignment_record_version_id !== 'string'
      || !VERSION_ID.test(row.assignment_record_version_id)
      || row.assignment_record_version_type !== 'client_assignment'
      || row.assignment_record_version_entity_id !== row.assignment_id
      || row.assignment_record_version_number !== row.assignment_version
      || typeof row.assignment_record_version_actor !== 'string'
      || !STAFF_ID.test(row.assignment_record_version_actor)
      || !canonicalInstant(row.assignment_record_version_changed_at)
      || typeof row.assignment_record_version_correlation !== 'string'
      || !ID.test(row.assignment_record_version_correlation)) notFound()
    retainedSnapshotFact(row.client_record_version_envelope, row.data_key_id)
    retainedSnapshotFact(row.assignment_record_version_envelope, row.data_key_id)
    return Object.freeze({
      id: row.id,
      identityEnvelope: row.identity_envelope,
      status: row.status,
      version: row.version,
      archivedAt: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentClientVersionEnvelope: row.client_record_version_envelope,
      currentAssignmentVersionEnvelope: row.assignment_record_version_envelope,
      assignment: Object.freeze({
        id: row.assignment_id,
        clientId: row.id,
        specialistId: row.specialist_id,
        startsAt: row.starts_at,
        endsAt: null,
        assignedByStaffId: row.assigned_by_staff_id,
        version: row.assignment_version,
        createdAt: row.assignment_created_at,
        updatedAt: row.assignment_updated_at,
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') throw error
    notFound()
  }
}

const validateEditReplay = (value, clientId, request) => {
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
  if (replay.status !== 200 || client.id !== clientId
    || client.name !== request.name || client.age !== request.age
    || client.status !== request.status || client.version !== request.expectedVersion + 1
    || client.archivedAt !== null || client.readOnly !== false
    || !canonicalInstant(client.createdAt) || !canonicalInstant(client.updatedAt)
    || client.updatedAt < client.createdAt
    || !ASSIGNMENT_ID.test(assignment.id)
    || assignment.specialistId !== request.specialistId
    || !canonicalInstant(assignment.startsAt)
    || !Number.isSafeInteger(assignment.version) || assignment.version < 1) replayFailure()
  return Object.freeze({
    status: 200,
    body: Object.freeze({ data: Object.freeze({ client: clientDto(client, assignment) }) }),
  })
}

const versionConflict = (currentVersion) => {
  const error = new Error('VERSION_CONFLICT')
  Object.defineProperty(error, 'details', {
    enumerable: true, value: Object.freeze({ currentVersion }),
  })
  throw error
}

const validateRetainedCurrentSnapshots = async (context, current, identity) => {
  try {
    const clientPlaintext = await decryptForScope(
      context.keyring, context.dataKey, {
        expectedScope: context.scope,
        recordId: current.id,
        field: 'record_version',
        envelope: JSON.parse(current.currentClientVersionEnvelope),
      },
    )
    const expectedClient = JSON.stringify({
      age: identity.age,
      archivedAt: current.archivedAt,
      createdAt: current.createdAt,
      id: current.id,
      name: identity.name,
      schema: 'client.v1',
      status: current.status,
      updatedAt: current.updatedAt,
      version: current.version,
    })
    if (clientPlaintext !== expectedClient) notFound()
    const assignmentPlaintext = await decryptForScope(
      context.keyring, context.dataKey, {
        expectedScope: context.scope,
        recordId: current.assignment.id,
        field: 'record_version',
        envelope: JSON.parse(current.currentAssignmentVersionEnvelope),
      },
    )
    const expectedAssignment = JSON.stringify({
      assignedByStaffId: current.assignment.assignedByStaffId,
      clientId: current.assignment.clientId,
      createdAt: current.assignment.createdAt,
      endsAt: current.assignment.endsAt,
      id: current.assignment.id,
      schema: 'client_assignment.v1',
      specialistId: current.assignment.specialistId,
      startsAt: current.assignment.startsAt,
      updatedAt: current.assignment.updatedAt,
      version: current.assignment.version,
    })
    if (assignmentPlaintext !== expectedAssignment) notFound()
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') throw error
    notFound()
  }
}

const conditionalVersionStatement = (db, version, conditionSql, bindings) => db.prepare(
  `INSERT INTO record_versions
   (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
    changed_at,correlation_id)
   SELECT ?,?,?,?,?,?,?,?
   WHERE ${conditionSql}`
).bind(
  version.row.id, version.row.entity_type, version.row.entity_id, version.row.version,
  version.row.snapshot_envelope, version.row.changed_by_staff_id,
  version.row.changed_at, version.row.correlation_id, ...bindings,
)

const editGuardStatement = (db, values) => {
  const targetLifecycle = values.reassigned
    ? specialistPostcondition(values.targetPractitioner.staffUserId)
    : { sql: '1', bindings: [] }
  const assignmentSql = values.reassigned
    ? `EXISTS (SELECT 1 FROM client_assignments
         WHERE id=? AND client_id=? AND specialist_id=? AND starts_at=? AND ends_at=?
           AND assigned_by_staff_id=? AND version=? AND created_at=? AND updated_at=?)
       AND EXISTS (SELECT 1 FROM client_assignments
         WHERE id=? AND client_id=? AND specialist_id=? AND starts_at=? AND ends_at IS NULL
           AND assigned_by_staff_id=? AND version=1 AND created_at=? AND updated_at=?)
       AND (SELECT count(*) FROM client_assignments
         WHERE client_id=? AND ends_at IS NULL)=1
       AND NOT EXISTS (SELECT 1 FROM appointments
         WHERE client_id=? AND specialist_id=? AND status!='cancelled' AND starts_at>=?)`
    : `EXISTS (SELECT 1 FROM client_assignments
         WHERE id=? AND client_id=? AND specialist_id=? AND starts_at=? AND ends_at IS NULL
           AND assigned_by_staff_id=? AND version=? AND created_at=? AND updated_at=?)
       AND (SELECT count(*) FROM client_assignments
         WHERE client_id=? AND ends_at IS NULL)=1`
  const assignmentBindings = values.reassigned
    ? [
        values.oldAssignment.id, values.client.id, values.oldAssignment.specialistId,
        values.oldAssignment.startsAt, values.now, values.oldAssignment.assignedByStaffId,
        values.oldAssignment.version, values.oldAssignment.createdAt, values.now,
        values.assignment.id, values.client.id, values.assignment.specialistId,
        values.now, values.actorId, values.now, values.now,
        values.client.id, values.client.id, values.oldAssignment.specialistId, values.now,
      ]
    : [
        values.assignment.id, values.client.id, values.assignment.specialistId,
        values.assignment.startsAt, values.assignment.assignedByStaffId,
        values.assignment.version, values.assignment.createdAt,
        values.assignment.updatedAt, values.client.id,
      ]
  const assignmentHistorySql = values.reassigned
    ? `AND (SELECT count(*) FROM record_versions AS history
         WHERE history.entity_type='client_assignment'
           AND history.entity_id=?)=?
       AND (SELECT min(history.version) FROM record_versions AS history
         WHERE history.entity_type='client_assignment' AND history.entity_id=?)=1
       AND (SELECT max(history.version) FROM record_versions AS history
         WHERE history.entity_type='client_assignment' AND history.entity_id=?)=?
       AND (SELECT count(*) FROM record_versions AS history
         WHERE history.entity_type='client_assignment' AND history.entity_id=?)=1
       AND (SELECT min(history.version) FROM record_versions AS history
         WHERE history.entity_type='client_assignment' AND history.entity_id=?)=1
       AND (SELECT max(history.version) FROM record_versions AS history
         WHERE history.entity_type='client_assignment' AND history.entity_id=?)=1
       AND NOT EXISTS (SELECT 1 FROM record_versions AS history
         WHERE history.entity_id IN (?,?) AND history.entity_type!='client_assignment')
       AND NOT EXISTS (SELECT 1 FROM record_versions AS history
         WHERE history.entity_type='client_assignment' AND history.entity_id IN (?,?)
           AND (
             NOT json_valid(history.snapshot_envelope)
             OR json_extract(CASE WHEN json_valid(history.snapshot_envelope)
                  THEN history.snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
             OR json_extract(CASE WHEN json_valid(history.snapshot_envelope)
                  THEN history.snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1
           ))`
    : `AND (SELECT count(*) FROM record_versions AS history
         WHERE history.entity_type='client_assignment' AND history.entity_id=?)=?
       AND (SELECT min(history.version) FROM record_versions AS history
         WHERE history.entity_type='client_assignment' AND history.entity_id=?)=1
       AND (SELECT max(history.version) FROM record_versions AS history
         WHERE history.entity_type='client_assignment' AND history.entity_id=?)=?
       AND NOT EXISTS (SELECT 1 FROM record_versions AS history
         WHERE history.entity_id=? AND history.entity_type!='client_assignment')
       AND NOT EXISTS (SELECT 1 FROM record_versions AS history
         WHERE history.entity_type='client_assignment' AND history.entity_id=?
           AND (
             NOT json_valid(history.snapshot_envelope)
             OR json_extract(CASE WHEN json_valid(history.snapshot_envelope)
                  THEN history.snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
             OR json_extract(CASE WHEN json_valid(history.snapshot_envelope)
                  THEN history.snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1
           ))`
  const assignmentHistoryBindings = values.reassigned
    ? [
        values.oldAssignment.id, values.oldAssignment.version,
        values.oldAssignment.id, values.oldAssignment.id, values.oldAssignment.version,
        values.assignment.id, values.assignment.id, values.assignment.id,
        values.oldAssignment.id, values.assignment.id,
        values.oldAssignment.id, values.assignment.id, values.dataKeyId,
      ]
    : [
        values.assignment.id, values.assignment.version,
        values.assignment.id, values.assignment.id, values.assignment.version,
        values.assignment.id, values.assignment.id, values.dataKeyId,
      ]
  const versionIds = values.reassigned
    ? [values.clientVersionId, values.client.id, values.oldAssignmentVersionId,
        values.oldAssignment.id, values.assignmentVersionId, values.assignment.id]
    : [values.clientVersionId, values.client.id]
  const metadata = values.reassigned
    ? {
        clientVersion: values.client.version,
        closedAssignmentId: values.oldAssignment.id,
        closedAssignmentVersion: values.oldAssignment.version,
        newAssignmentId: values.assignment.id,
        newAssignmentVersion: 1,
      }
    : { clientVersion: values.client.version }
  return db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'client_edit_postcondition'
     WHERE NOT (
       EXISTS (SELECT 1 FROM data_keys
         WHERE id=? AND scope_type='client' AND scope_id=? AND purpose='identity'
           AND dek_version=1 AND retired_at IS NULL)
       AND EXISTS (SELECT 1 FROM clients
         WHERE id=? AND status=? AND version=? AND archived_at IS NULL
           AND created_at=? AND updated_at=? AND identity_envelope=?
           AND json_extract(identity_envelope,'$.dataKeyId')=?
           AND json_extract(identity_envelope,'$.dataKeyVersion')=1)
       AND (${assignmentSql})
       AND (SELECT count(*) FROM record_versions
         WHERE ((id=? AND entity_type='client' AND entity_id=? AND version=?)
           ${values.reassigned
    ? "OR (id=? AND entity_type='client_assignment' AND entity_id=? AND version=?) OR (id=? AND entity_type='client_assignment' AND entity_id=? AND version=1)"
    : ''})
           AND changed_by_staff_id=? AND changed_at=? AND correlation_id=?
           AND json_extract(snapshot_envelope,'$.dataKeyId')=?
           AND json_extract(snapshot_envelope,'$.dataKeyVersion')=1)=?
       AND (SELECT count(*) FROM record_versions AS history
         WHERE history.entity_type='client' AND history.entity_id=?)=?
       AND (SELECT min(history.version) FROM record_versions AS history
         WHERE history.entity_type='client' AND history.entity_id=?)=1
       AND (SELECT max(history.version) FROM record_versions AS history
         WHERE history.entity_type='client' AND history.entity_id=?)=?
       AND NOT EXISTS (SELECT 1 FROM record_versions AS history
         WHERE history.entity_id=? AND history.entity_type!='client')
       AND NOT EXISTS (SELECT 1 FROM record_versions AS history
         WHERE history.entity_type='client' AND history.entity_id=?
           AND (
             NOT json_valid(history.snapshot_envelope)
             OR json_extract(CASE WHEN json_valid(history.snapshot_envelope)
                  THEN history.snapshot_envelope ELSE '{}' END,'$.dataKeyId') IS NOT ?
             OR json_extract(CASE WHEN json_valid(history.snapshot_envelope)
                  THEN history.snapshot_envelope ELSE '{}' END,'$.dataKeyVersion') IS NOT 1
           ))
       ${assignmentHistorySql}
       AND EXISTS (SELECT 1 FROM audit_events
         WHERE id=? AND actor_staff_id=? AND action=? AND entity_type='client'
           AND entity_id=? AND result='success' AND reason_envelope IS NULL
           AND correlation_id=? AND metadata_json=?)
       AND EXISTS (SELECT 1 FROM idempotency_records
         WHERE actor_id=? AND operation=? AND idempotency_key=?
           AND resource_type='client' AND resource_id=?
           AND json_extract(request_hash,'$.dataKeyId')=?
           AND json_extract(request_hash,'$.dataKeyVersion')=1
           AND json_extract(response_envelope,'$.dataKeyId')=?
           AND json_extract(response_envelope,'$.dataKeyVersion')=1)
       ${values.reassigned ? `AND EXISTS (SELECT 1 FROM specialists AS specialist
         JOIN staff_users AS staff
           ON staff.id=specialist.staff_user_id AND staff.specialist_id=specialist.id
         WHERE specialist.id=? AND specialist.staff_user_id=?
           AND specialist.status='active' AND staff.status='active')` : ''}
       AND (${targetLifecycle.sql})
     )`
  ).bind(
    values.dataKeyId, values.client.id,
    values.client.id, values.client.status, values.client.version,
    values.client.createdAt, values.now, values.identityEnvelope, values.dataKeyId,
    ...assignmentBindings,
    ...versionIds.slice(0, 2), values.client.version,
    ...(values.reassigned
      ? [versionIds[2], versionIds[3], values.oldAssignment.version,
          versionIds[4], versionIds[5]]
      : []),
    values.actorId, values.now, values.correlationId,
    values.dataKeyId, values.reassigned ? 3 : 1,
    values.client.id, values.client.version,
    values.client.id, values.client.id, values.client.version,
    values.client.id, values.client.id, values.dataKeyId,
    ...assignmentHistoryBindings,
    values.auditId, values.actorId,
    values.reassigned ? 'client.assignment.changed' : 'client.updated',
    values.client.id, values.correlationId, JSON.stringify(metadata),
    values.actorId, EDIT_OPERATION, values.idempotencyKey, values.client.id,
    values.dataKeyId, values.dataKeyId,
    ...(values.reassigned
      ? [values.assignment.specialistId, values.targetPractitioner.staffUserId]
      : []),
    ...targetLifecycle.bindings,
  )
}

export async function editClient(input) {
  const command = captureEditCommand(input)
  const actor = actorFact(command.actor)
  const requestDigest = await digestEditClientRequest(command.clientId, command.body)
  const idem = Object.freeze({
    actorId: actor.id,
    operation: EDIT_OPERATION,
    idempotencyKey: command.idempotencyKey,
    requestDigest,
    resourceType: 'client',
    scopeType: 'client',
    scopePurpose: 'identity',
  })
  const replay = await inspectStoredScopeIdempotency(command.db, command.keyring, idem)
  if (replay) return validateEditReplay(replay, command.clientId, command.body)
  let now
  try { now = new Date(command.nowMs).toISOString() } catch { throw new Error('INTERNAL_ERROR') }
  const current = scopedClientFact(
    await loadScopedClient(command.db, command.clientId, actor), command.clientId,
  )
  if (!authorize(actor, 'client.manage', {
    kind: 'client', clientId: current.id,
    assignment: {
      kind: 'client_assignment', clientId: current.id,
      specialistId: current.assignment.specialistId, status: 'active',
    },
  }, { nowMs: command.nowMs })) notFound()
  if (command.body.expectedVersion !== current.version) versionConflict(current.version)

  const context = await loadClientCryptoContext(command.db, command.keyring, {
    clientId: current.id, envelope: current.identityEnvelope,
  })
  const identity = await decryptClientIdentity(context, {
    clientId: current.id, envelope: current.identityEnvelope,
  })
  await validateRetainedCurrentSnapshots(context, current, identity)
  const reassigned = command.body.specialistId !== current.assignment.specialistId
  if (reassigned && actor.role === 'specialist') throw new Error('CLIENT_ASSIGNMENT_CONFLICT')
  if (!reassigned && identity.name === command.body.name && identity.age === command.body.age
    && current.status === command.body.status) validation('body')

  let targetPractitioner = null
  if (reassigned) {
    targetPractitioner = practitionerFact(
      await loadActivePractitioner(command.db, command.body.specialistId, actor)
    )
    const blocked = await command.db.prepare(
      `SELECT 1 AS blocked FROM appointments
       WHERE client_id=? AND specialist_id=? AND status!='cancelled' AND starts_at>=?
       LIMIT 1`
    ).bind(current.id, current.assignment.specialistId, now).first()
    if (blocked) {
      const fact = replayObject(blocked, ['blocked'])
      if (fact.blocked !== 1) throw new Error('INTERNAL_ERROR')
      throw new Error('CLIENT_ASSIGNMENT_CONFLICT')
    }
  }

  if (reassigned && now <= current.assignment.startsAt) {
    throw new Error('CLIENT_ASSIGNMENT_CONFLICT')
  }
  const used = new Set()
  const assignmentId = reassigned
    ? generated(command.idFactory, 'asg', ASSIGNMENT_ID, used)
    : null
  const clientVersionId = generated(command.idFactory, 'ver', VERSION_ID, used)
  const oldAssignmentVersionId = reassigned
    ? generated(command.idFactory, 'ver', VERSION_ID, used)
    : null
  const assignmentVersionId = reassigned
    ? generated(command.idFactory, 'ver', VERSION_ID, used)
    : null
  const auditId = generated(command.idFactory, 'aud', AUDIT_ID, used)
  const client = Object.freeze({
    id: current.id, name: command.body.name, age: command.body.age,
    status: command.body.status, version: current.version + 1, archivedAt: null,
    createdAt: current.createdAt, updatedAt: now,
  })
  const oldAssignment = reassigned ? Object.freeze({
    ...current.assignment, endsAt: now, version: current.assignment.version + 1,
    updatedAt: now,
  }) : current.assignment
  const assignment = reassigned ? Object.freeze({
    id: assignmentId, clientId: current.id, specialistId: targetPractitioner.id,
    startsAt: now, endsAt: null, assignedByStaffId: actor.id, version: 1,
    createdAt: now, updatedAt: now,
  }) : current.assignment
  const identityEnvelope = await encryptClientIdentity(context, {
    clientId: current.id, name: client.name, age: client.age,
  })
  const clientVersion = await versionBuilder.build(command.db, context, {
    clientId: current.id, versionId: clientVersionId, entityType: 'client',
    entity: client, changedByStaffId: actor.id, changedAt: now,
    correlationId: command.correlationId, ownerFact: null,
  })
  const oldAssignmentVersion = reassigned ? await versionBuilder.build(command.db, context, {
    clientId: current.id, versionId: oldAssignmentVersionId,
    entityType: 'client_assignment', entity: oldAssignment,
    changedByStaffId: actor.id, changedAt: now,
    correlationId: command.correlationId, ownerFact: null,
  }) : null
  const assignmentVersion = reassigned ? await versionBuilder.build(command.db, context, {
    clientId: current.id, versionId: assignmentVersionId,
    entityType: 'client_assignment', entity: assignment,
    changedByStaffId: actor.id, changedAt: now,
    correlationId: command.correlationId, ownerFact: null,
  }) : null
  const body = Object.freeze({ data: Object.freeze({ client: clientDto(client, assignment) }) })
  const response = Object.freeze({ status: 200, body })
  const idempotency = await createIdempotencyStatement(command.db, context, {
    actorId: actor.id, operation: EDIT_OPERATION,
    idempotencyKey: command.idempotencyKey, requestDigest,
    expectedScope: context.scope, resourceType: 'client', resourceId: current.id,
    response, createdAt: now, expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  })
  const metadata = reassigned ? {
    clientVersion: client.version,
    closedAssignmentId: oldAssignment.id,
    closedAssignmentVersion: oldAssignment.version,
    newAssignmentId: assignment.id,
    newAssignmentVersion: 1,
  } : { clientVersion: client.version }
  const uow = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  uow.domain(command.db.prepare(
    `UPDATE clients
     SET identity_envelope=?,status=?,version=?,updated_at=?
     WHERE id=? AND version=? AND status IN ('active','paused') AND archived_at IS NULL`
  ).bind(identityEnvelope, client.status, client.version, now, current.id, current.version))
  if (reassigned) {
    uow.domain(command.db.prepare(
      `UPDATE client_assignments SET ends_at=?,version=?,updated_at=?
       WHERE id=? AND client_id=? AND specialist_id=? AND version=? AND ends_at IS NULL
         AND EXISTS (SELECT 1 FROM clients
           WHERE id=? AND version=? AND identity_envelope=? AND updated_at=?)`
    ).bind(
      now, oldAssignment.version, now, current.assignment.id, current.id,
      current.assignment.specialistId, current.assignment.version,
      current.id, client.version, identityEnvelope, now,
    ))
    uow.domain(command.db.prepare(
      `INSERT INTO client_assignments
       (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
        version,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?
       WHERE EXISTS (SELECT 1 FROM client_assignments WHERE id=? AND ends_at=?)
         AND EXISTS (SELECT 1 FROM clients
           WHERE id=? AND version=? AND identity_envelope=? AND updated_at=?)`
    ).bind(
      assignment.id, current.id, assignment.specialistId, now, null, actor.id, 1, now, now,
      oldAssignment.id, now, current.id, client.version, identityEnvelope, now,
    ))
  }
  uow.version(conditionalVersionStatement(
    command.db, clientVersion,
    'EXISTS (SELECT 1 FROM clients WHERE id=? AND version=? AND updated_at=? AND identity_envelope=? AND status=?)',
    [current.id, client.version, now, identityEnvelope, client.status],
  ))
  if (reassigned) {
    uow.version(conditionalVersionStatement(
      command.db, oldAssignmentVersion,
      'EXISTS (SELECT 1 FROM record_versions WHERE id=?) AND EXISTS (SELECT 1 FROM client_assignments WHERE id=? AND version=? AND ends_at=?)',
      [clientVersionId, oldAssignment.id, oldAssignment.version, now],
    ))
    uow.version(conditionalVersionStatement(
      command.db, assignmentVersion,
      'EXISTS (SELECT 1 FROM record_versions WHERE id=?) AND EXISTS (SELECT 1 FROM client_assignments WHERE id=? AND version=1 AND ends_at IS NULL)',
      [clientVersionId, assignment.id],
    ))
  }
  uow.audit(auditEventStatement(command.db, {
    id: auditId, occurredAt: now, actorStaffId: actor.id,
    action: reassigned ? 'client.assignment.changed' : 'client.updated',
    entityType: 'client', entityId: current.id, result: 'success',
    correlationId: command.correlationId, metadata, reasonEnvelope: null,
  }))
  uow.idempotency(idempotency)
  uow.guard(editGuardStatement(command.db, {
    reassigned, client, oldAssignment, assignment, now, actorId: actor.id,
    clientVersionId, oldAssignmentVersionId, assignmentVersionId, auditId,
    correlationId: command.correlationId, idempotencyKey: command.idempotencyKey,
    dataKeyId: context.dataKey.id, targetPractitioner,
    identityEnvelope,
  }))
  try {
    await uow.commit()
    return response
  } catch (originalError) {
    if (isD1IdentityCollision(originalError)) {
      const recovered = await recoverStoredScopeIdempotencyAfterCollision(
        command.recoveryDb, command.keyring, idem, originalError,
      )
      return validateEditReplay(recovered, command.clientId, command.body)
    }
    if (isD1CoreDirectoryInvariantFailure(originalError)) {
      const row = await command.db.prepare(
        'SELECT version FROM clients WHERE id=?'
      ).bind(current.id).first()
      const fact = replayObject(row, ['version'])
      if (Number.isSafeInteger(fact.version) && fact.version > current.version) {
        versionConflict(fact.version)
      }
    }
    throw originalError
  }
}

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
