import { auditEventStatement } from '../audit/events.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectIdempotency,
  recoverIdempotencyAfterCollision,
} from '../db/unit-of-work.js'
import { isD1IdentityCollision } from '../db/errors.js'
import { authorize } from '../identity/policy.js'
import { encodeBase64Url } from '../security/encoding.js'
import { encryptForScope } from '../security/envelope.js'
import { isWellFormedUnicode } from '../../src/core-records.js'

const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const BODY_KEYS = Object.freeze(['displayName', 'professionalTitle', 'standardRateGrosze'])
const INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const VERSION_ID = /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const AUDIT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPERATION = 'specialists.create'
const DAY_MS = 24 * 60 * 60 * 1000

const validation = (field) => { throw new TypeError(`VALIDATION_FAILED/${field}`) }
const captureExact = (value, keys, field = 'body') => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) validation(field)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length || actual.some((key) => (
      typeof key !== 'string' || !keys.includes(key)
    ))) validation(field)
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        validation(field)
      }
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

const validProfessionalTitle = (value) => {
  if (!validName(value) || /[\p{Cc}\p{Cf}]/u.test(value)) return false
  return true
}

export function validateSpecialistProfileBody(value) {
  const body = captureExact(value, BODY_KEYS)
  if (!validName(body.displayName)) validation('displayName')
  if (!validProfessionalTitle(body.professionalTitle)) validation('professionalTitle')
  if (!Number.isSafeInteger(body.standardRateGrosze)
    || body.standardRateGrosze < 1 || body.standardRateGrosze > 1_000_000) {
    validation('standardRateGrosze')
  }
  return body
}

const generated = (factory, prefix, grammar, used) => {
  let suffix
  try { suffix = factory() } catch { throw new Error('INTERNAL_ERROR') }
  const value = `${prefix}_${suffix}`
  if (typeof suffix !== 'string' || !ID.test(suffix) || !grammar.test(value)
    || used.has(value)) throw new Error('INTERNAL_ERROR')
  used.add(value)
  return value
}

const actorFact = (value) => {
  let captured
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('FORBIDDEN')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    captured = Object.fromEntries(['id', 'role', 'specialistId'].map((key) => {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('FORBIDDEN')
      return [key, descriptor.value]
    }))
  } catch {
    throw new Error('FORBIDDEN')
  }
  if (!STAFF_ID.test(captured.id ?? '')
    || !['owner', 'coordinator', 'specialist'].includes(captured.role)
    || (captured.specialistId !== null && !SPECIALIST_ID.test(captured.specialistId ?? ''))) {
    throw new Error('FORBIDDEN')
  }
  return captured
}

const profileDto = (profile) => Object.freeze({
  id: profile.id,
  displayName: profile.displayName,
  professionalTitle: profile.professionalTitle,
  standardRateGrosze: profile.standardRateGrosze,
  status: 'active',
  version: 1,
  accessStatus: 'unclaimed',
  createdAt: profile.createdAt,
  updatedAt: profile.createdAt,
})

const replayResult = (value, request) => {
  try {
    const replay = captureExact(value, ['status', 'body'])
    const body = captureExact(replay.body, ['data'])
    const data = captureExact(body.data, ['specialist'])
    const profile = captureExact(data.specialist, [
      'id', 'displayName', 'professionalTitle', 'standardRateGrosze', 'status',
      'version', 'accessStatus', 'createdAt', 'updatedAt',
    ])
    if (replay.status !== 201 || !SPECIALIST_ID.test(profile.id ?? '')
      || profile.displayName !== request.displayName
      || profile.professionalTitle !== request.professionalTitle
      || profile.standardRateGrosze !== request.standardRateGrosze
      || profile.status !== 'active' || profile.version !== 1
      || profile.accessStatus !== 'unclaimed' || profile.updatedAt !== profile.createdAt
      || new Date(profile.createdAt).toISOString() !== profile.createdAt) {
      throw new Error('CRYPTO_FAILURE')
    }
    return Object.freeze({
      status: 201,
      body: Object.freeze({ data: Object.freeze({ specialist: profileDto({
        ...profile, createdAt: profile.createdAt,
      }) }) }),
    })
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    throw new Error('CRYPTO_FAILURE')
  }
}

const requestDigest = async (route, body) => {
  const encoded = new TextEncoder().encode(JSON.stringify({ route, body }))
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
    return encodeBase64Url(digest)
  } finally {
    encoded.fill(0)
    digest?.fill(0)
  }
}

const loadContext = async (db, keyring) => {
  const dataKey = await db.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
            kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1
       AND retired_at IS NULL`,
  ).bind(SCOPE.type, SCOPE.id, SCOPE.purpose).first()
  if (!dataKey) throw new Error('CRYPTO_FAILURE')
  return Object.freeze({ keyring, dataKey, expectedScope: SCOPE })
}

export async function createSpecialistProfile(input) {
  const command = captureExact(input, INPUT_KEYS)
  if (!command.db?.prepare || !command.db?.batch || !command.recoveryDb?.prepare
    || !command.keyring || typeof command.idFactory !== 'function'
    || !Number.isSafeInteger(command.nowMs) || command.nowMs < 0
    || !CORRELATION_ID.test(command.correlationId ?? '')
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey ?? '')) validation('body')
  const body = validateSpecialistProfileBody(command.body)
  const actor = actorFact(command.actor)
  if (!authorize(actor, 'staff.manage', { kind: 'centre', centreId: 'centre_1' }, {
    nowMs: command.nowMs,
  })) throw new Error('FORBIDDEN')
  const context = await loadContext(command.db, command.keyring)
  const digest = await requestDigest('POST /api/v1/specialists', {
    displayName: body.displayName,
    professionalTitle: body.professionalTitle,
    standardRateGrosze: body.standardRateGrosze,
  })
  const idem = Object.freeze({
    actorId: actor.id, operation: OPERATION, idempotencyKey: command.idempotencyKey,
    requestDigest: digest, expectedScope: SCOPE,
  })
  const replay = await inspectIdempotency(command.db, context, idem)
  if (replay) return replayResult(replay, body)

  let now
  try { now = new Date(command.nowMs).toISOString() } catch { throw new Error('INTERNAL_ERROR') }
  const used = new Set()
  const specialistId = generated(command.idFactory, 'sp', SPECIALIST_ID, used)
  const versionId = generated(command.idFactory, 'ver', VERSION_ID, used)
  const auditId = generated(command.idFactory, 'aud', AUDIT_ID, used)
  const profile = Object.freeze({
    id: specialistId,
    displayName: body.displayName,
    professionalTitle: body.professionalTitle,
    standardRateGrosze: body.standardRateGrosze,
    createdAt: now,
  })
  const displayNameEnvelope = JSON.stringify(await encryptForScope(
    command.keyring, context.dataKey, {
      expectedScope: SCOPE, recordId: specialistId,
      field: 'display_name', plaintext: body.displayName,
    },
  ))
  const professionalTitleEnvelope = JSON.stringify(await encryptForScope(
    command.keyring, context.dataKey, {
      expectedScope: SCOPE, recordId: specialistId,
      field: 'professional_title', plaintext: body.professionalTitle,
    },
  ))
  const snapshot = JSON.stringify({
    archivedAt: null,
    createdAt: now,
    displayName: body.displayName,
    id: specialistId,
    professionalTitle: body.professionalTitle,
    schema: 'specialist.v3',
    staffUserId: null,
    standardRateGrosze: body.standardRateGrosze,
    status: 'active',
    updatedAt: now,
    version: 1,
  })
  const snapshotEnvelope = JSON.stringify(await encryptForScope(
    command.keyring, context.dataKey, {
      expectedScope: SCOPE, recordId: specialistId,
      field: 'record_version', plaintext: snapshot,
    },
  ))
  const response = Object.freeze({
    status: 201,
    body: Object.freeze({ data: Object.freeze({ specialist: profileDto(profile) }) }),
  })
  const idempotency = await createIdempotencyStatement(command.db, context, {
    ...idem, resourceType: 'specialist', resourceId: specialistId,
    response, createdAt: now, expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  })
  const uow = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  uow.domain(command.db.prepare(
    `INSERT INTO specialists
     (id,staff_user_id,display_name_envelope,professional_title_envelope,
      standard_rate_grosze,status,version,archived_at,created_at,updated_at)
     VALUES (?,NULL,?,?,?,'active',1,NULL,?,?)`,
  ).bind(
    specialistId, displayNameEnvelope, professionalTitleEnvelope,
    body.standardRateGrosze, now, now,
  ))
  uow.version(command.db.prepare(
    `INSERT INTO record_versions
     (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
      changed_at,correlation_id)
     VALUES (?,'specialist',?,1,?,?,?,?)`,
  ).bind(versionId, specialistId, snapshotEnvelope, actor.id, now, command.correlationId))
  uow.audit(auditEventStatement(command.db, {
    id: auditId, occurredAt: now, actorStaffId: actor.id,
    action: 'specialist.profile.created', entityType: 'specialist',
    entityId: specialistId, result: 'success', correlationId: command.correlationId,
    metadata: { specialistVersion: 1 }, reasonEnvelope: null,
  }))
  uow.idempotency(idempotency)
  uow.guard(command.db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'specialist_profile_create_postcondition'
     WHERE NOT (
       EXISTS (SELECT 1 FROM specialists
         WHERE id=? AND staff_user_id IS NULL AND display_name_envelope=?
           AND professional_title_envelope=?
           AND standard_rate_grosze=? AND status='active' AND version=1
           AND archived_at IS NULL AND created_at=? AND updated_at=?)
       AND EXISTS (SELECT 1 FROM record_versions
         WHERE id=? AND entity_type='specialist' AND entity_id=? AND version=1
           AND changed_by_staff_id=? AND changed_at=? AND correlation_id=?)
       AND EXISTS (SELECT 1 FROM audit_events
         WHERE id=? AND action='specialist.profile.created' AND entity_type='specialist'
           AND entity_id=? AND actor_staff_id=? AND correlation_id=?)
       AND EXISTS (SELECT 1 FROM idempotency_records
         WHERE actor_id=? AND operation=? AND idempotency_key=?
           AND resource_type='specialist' AND resource_id=?)
     )`,
  ).bind(
    specialistId, displayNameEnvelope, professionalTitleEnvelope,
    body.standardRateGrosze, now, now,
    versionId, specialistId, actor.id, now, command.correlationId,
    auditId, specialistId, actor.id, command.correlationId,
    actor.id, OPERATION, command.idempotencyKey, specialistId,
  ))
  try {
    await uow.commit()
    return response
  } catch (error) {
    if (!isD1IdentityCollision(error)) throw error
    const recovered = await recoverIdempotencyAfterCollision(
      command.recoveryDb, context, idem, error,
    )
    return replayResult(recovered, body)
  }
}

export async function updateSpecialistProfile(input) {
  const keys = [
    'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
    'specialistId', 'body', 'idempotencyKey',
  ]
  const command = captureExact(input, keys)
  if (!command.db?.prepare || !command.db?.batch || !command.recoveryDb?.prepare
    || !command.keyring || typeof command.idFactory !== 'function'
    || !Number.isSafeInteger(command.nowMs) || command.nowMs < 0
    || !CORRELATION_ID.test(command.correlationId ?? '')
    || !SPECIALIST_ID.test(command.specialistId ?? '')
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey ?? '')) validation('body')
  const body = captureExact(command.body, [
    'expectedVersion', 'displayName', 'professionalTitle', 'standardRateGrosze',
  ])
  validateSpecialistProfileBody({
    displayName: body.displayName,
    professionalTitle: body.professionalTitle,
    standardRateGrosze: body.standardRateGrosze,
  })
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    validation('expectedVersion')
  }
  const actor = actorFact(command.actor)
  if (!authorize(actor, 'staff.manage', { kind: 'centre', centreId: 'centre_1' }, {
    nowMs: command.nowMs,
  })) throw new Error('FORBIDDEN')
  const context = await loadContext(command.db, command.keyring)
  const digest = await requestDigest(
    `POST /api/v1/specialists/${command.specialistId}/edits`,
    {
      displayName: body.displayName,
      expectedVersion: body.expectedVersion,
      professionalTitle: body.professionalTitle,
      standardRateGrosze: body.standardRateGrosze,
    },
  )
  const idem = Object.freeze({
    actorId: actor.id,
    operation: 'specialists.edit',
    idempotencyKey: command.idempotencyKey,
    requestDigest: digest,
    expectedScope: SCOPE,
  })
  const replay = await inspectIdempotency(command.db, context, idem)
  if (replay) return replay
  const current = await command.db.prepare(
    `SELECT specialist.id,specialist.staff_user_id,specialist.status,specialist.version,
            specialist.archived_at,specialist.created_at,staff.status AS staff_status,
            staff.version AS staff_version
     FROM specialists AS specialist
     LEFT JOIN staff_users AS staff ON staff.id=specialist.staff_user_id
     WHERE specialist.id=?`,
  ).bind(command.specialistId).first()
  if (!current || !['active', 'pending'].includes(current.status)) throw new Error('NOT_FOUND')
  if (current.version !== body.expectedVersion) {
    const error = new Error('VERSION_CONFLICT')
    error.details = { currentVersion: current.version }
    throw error
  }
  const accessStatus = current.staff_user_id === null ? 'unclaimed'
    : current.staff_status === 'pending' ? 'invited'
      : current.staff_status === 'active' ? 'enabled' : null
  if (accessStatus === null) throw new Error('INTERNAL_ERROR')
  const now = new Date(command.nowMs).toISOString()
  const nextVersion = current.version + 1
  const displayNameEnvelope = JSON.stringify(await encryptForScope(
    command.keyring, context.dataKey, {
      expectedScope: SCOPE, recordId: current.id,
      field: 'display_name', plaintext: body.displayName,
    },
  ))
  const professionalTitleEnvelope = JSON.stringify(await encryptForScope(
    command.keyring, context.dataKey, {
      expectedScope: SCOPE, recordId: current.id,
      field: 'professional_title', plaintext: body.professionalTitle,
    },
  ))
  const snapshotEnvelope = JSON.stringify(await encryptForScope(
    command.keyring, context.dataKey, {
      expectedScope: SCOPE, recordId: current.id, field: 'record_version',
      plaintext: JSON.stringify({
        archivedAt: current.archived_at,
        createdAt: current.created_at,
        displayName: body.displayName,
        id: current.id,
        professionalTitle: body.professionalTitle,
        schema: 'specialist.v3',
        staffUserId: current.staff_user_id,
        standardRateGrosze: body.standardRateGrosze,
        status: current.status,
        updatedAt: now,
        version: nextVersion,
      }),
    },
  ))
  const used = new Set()
  const versionId = generated(command.idFactory, 'ver', VERSION_ID, used)
  const auditId = generated(command.idFactory, 'aud', AUDIT_ID, used)
  const specialist = Object.freeze({
    id: current.id, displayName: body.displayName,
    professionalTitle: body.professionalTitle,
    standardRateGrosze: body.standardRateGrosze, status: 'active',
    version: nextVersion, staffVersion: current.staff_version,
    accessStatus, createdAt: current.created_at, updatedAt: now,
  })
  const response = Object.freeze({
    status: 200,
    body: Object.freeze({ data: Object.freeze({ specialist }) }),
  })
  const uow = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  uow.domain(command.db.prepare(
    `UPDATE specialists
     SET display_name_envelope=?,professional_title_envelope=?,standard_rate_grosze=?,
         version=version+1,updated_at=?
     WHERE id=? AND version=? AND status IN ('active','pending')`,
  ).bind(
    displayNameEnvelope, professionalTitleEnvelope, body.standardRateGrosze, now,
    current.id, current.version,
  ))
  uow.version(command.db.prepare(
    `INSERT INTO record_versions
     (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
      changed_at,correlation_id)
     VALUES (?,'specialist',?,?,?,?,?,?)`,
  ).bind(
    versionId, current.id, nextVersion, snapshotEnvelope,
    actor.id, now, command.correlationId,
  ))
  uow.audit(auditEventStatement(command.db, {
    id: auditId, occurredAt: now, actorStaffId: actor.id,
    action: 'specialist.profile.updated', entityType: 'specialist',
    entityId: current.id, result: 'success', correlationId: command.correlationId,
    metadata: { specialistVersion: nextVersion }, reasonEnvelope: null,
  }))
  uow.idempotency(await createIdempotencyStatement(command.db, context, {
    ...idem, resourceType: 'specialist', resourceId: current.id,
    response, createdAt: now, expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  }))
  uow.guard(command.db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'specialist_profile_edit_postcondition'
     WHERE NOT (
       EXISTS (SELECT 1 FROM specialists
         WHERE id=? AND staff_user_id IS ? AND display_name_envelope=?
           AND professional_title_envelope=?
           AND standard_rate_grosze=? AND version=? AND updated_at=?)
       AND EXISTS (SELECT 1 FROM record_versions
         WHERE id=? AND entity_type='specialist' AND entity_id=? AND version=?)
       AND EXISTS (SELECT 1 FROM audit_events
         WHERE id=? AND action='specialist.profile.updated' AND entity_id=?)
       AND EXISTS (SELECT 1 FROM idempotency_records
         WHERE actor_id=? AND operation='specialists.edit' AND idempotency_key=?
           AND resource_id=?)
     )`,
  ).bind(
    current.id, current.staff_user_id, displayNameEnvelope, professionalTitleEnvelope,
    body.standardRateGrosze, nextVersion, now,
    versionId, current.id, nextVersion,
    auditId, current.id,
    actor.id, command.idempotencyKey, current.id,
  ))
  await uow.commit()
  return response
}
