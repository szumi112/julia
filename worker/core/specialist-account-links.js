import { auditEventStatement } from '../audit/events.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectIdempotency,
  recoverIdempotencyAfterCollision,
} from '../db/unit-of-work.js'
import {
  isD1CoreDirectoryInvariantFailure,
  isD1IdentityCollision,
} from '../db/errors.js'
import { authorize } from '../identity/policy.js'
import { decryptForScope, encryptForScope } from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'
import { isWellFormedUnicode } from '../../src/core-records.js'

const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const BODY_KEYS = Object.freeze([
  'staffId', 'expectedSpecialistVersion', 'expectedStaffVersion',
])
const INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'specialistId', 'body', 'idempotencyKey',
])
const ACTOR_KEYS = Object.freeze(['id', 'role', 'specialistId', 'version'])
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const LINK_ID = /^spl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const VERSION_ID = /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const AUDIT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const OPERATION = 'specialists.account.link'
const DAY_MS = 24 * 60 * 60 * 1000
const LEGACY_TITLE = 'Specjalistka'

const validation = (field) => { throw new TypeError(`VALIDATION_FAILED/${field}`) }
const forbidden = () => { throw new Error('FORBIDDEN') }
const conflict = () => { throw new Error('SPECIALIST_LINK_CONFLICT') }
const versionConflict = () => { throw new Error('VERSION_CONFLICT') }
const cryptoFailure = () => { throw new Error('CRYPTO_FAILURE') }

const captureExact = (value, keys, field = 'body') => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) validation(field)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      validation(field)
    }
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

const validVersion = (value) => Number.isSafeInteger(value) && value >= 1
const validInstant = (value) => {
  try {
    return typeof value === 'string' && INSTANT.test(value)
      && new Date(value).toISOString() === value
  } catch {
    return false
  }
}

export function validateSpecialistAccountLinkBody(value) {
  const body = captureExact(value, BODY_KEYS)
  if (!STAFF_ID.test(body.staffId ?? '')) validation('staffId')
  if (!validVersion(body.expectedSpecialistVersion)) {
    validation('expectedSpecialistVersion')
  }
  if (!validVersion(body.expectedStaffVersion)) validation('expectedStaffVersion')
  return body
}

const captureActor = (value, nowMs) => {
  let actor
  try {
    actor = captureExact(value, ACTOR_KEYS, 'actor')
  } catch {
    forbidden()
  }
  if (!STAFF_ID.test(actor.id ?? '')
    || !['owner', 'coordinator', 'specialist'].includes(actor.role)
    || (actor.specialistId !== null && !SPECIALIST_ID.test(actor.specialistId ?? ''))
    || !validVersion(actor.version)
    || !authorize(actor, 'staff.manage', CENTRE, { nowMs })) forbidden()
  return actor
}

const captureCommand = (value) => {
  const input = captureExact(value, INPUT_KEYS)
  if (!input.db?.prepare || !input.db?.batch || !input.recoveryDb?.prepare
    || !input.keyring || typeof input.idFactory !== 'function'
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !CORRELATION_ID.test(input.correlationId ?? '')
    || !SPECIALIST_ID.test(input.specialistId ?? '')
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey ?? '')) validation('body')
  const actor = captureActor(input.actor, input.nowMs)
  const body = validateSpecialistAccountLinkBody(input.body)
  return Object.freeze({ ...input, actor, body })
}

const requestDigest = async (specialistId, body) => {
  const encoded = new TextEncoder().encode(JSON.stringify({
    route: `POST /api/v1/specialists/${specialistId}/account-links`,
    body: {
      expectedSpecialistVersion: body.expectedSpecialistVersion,
      expectedStaffVersion: body.expectedStaffVersion,
      staffId: body.staffId,
    },
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

const loadContext = async (db, keyring) => {
  const dataKey = await db.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
            kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1
       AND retired_at IS NULL`,
  ).bind(SCOPE.type, SCOPE.id, SCOPE.purpose).first()
  if (!dataKey) cryptoFailure()
  return Object.freeze({ keyring, dataKey, expectedScope: SCOPE })
}

const generated = (factory, prefix, grammar, used) => {
  let suffix
  try { suffix = factory() } catch { throw new Error('INTERNAL_ERROR') }
  const value = `${prefix}_${suffix}`
  if (typeof suffix !== 'string' || !SUFFIX.test(suffix)
    || !grammar.test(value) || used.has(value)) throw new Error('INTERNAL_ERROR')
  used.add(value)
  return value
}

const exactReplayObject = (value, keys) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) cryptoFailure()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length || actual.some((key) => (
      typeof key !== 'string' || !keys.includes(key)
    ))) cryptoFailure()
    const result = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        cryptoFailure()
      }
      result[key] = descriptor.value
    }
    return result
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    cryptoFailure()
  }
}

const linkDto = (value) => Object.freeze({
  id: value.id,
  specialistId: value.specialistId,
  staffId: value.staffId,
  lifecycle: 'activated',
  specialistVersion: value.specialistVersion,
  staffVersion: value.staffVersion,
  createdAt: value.createdAt,
})

const responseFor = (link) => Object.freeze({
  status: 201,
  body: Object.freeze({ data: Object.freeze({ link: linkDto(link) }) }),
})

const replayResult = (value, specialistId, body) => {
  const replay = exactReplayObject(value, ['status', 'body'])
  const responseBody = exactReplayObject(replay.body, ['data'])
  const data = exactReplayObject(responseBody.data, ['link'])
  const link = exactReplayObject(data.link, [
    'id', 'specialistId', 'staffId', 'lifecycle', 'specialistVersion',
    'staffVersion', 'createdAt',
  ])
  if (replay.status !== 201 || !LINK_ID.test(link.id ?? '')
    || link.specialistId !== specialistId || link.staffId !== body.staffId
    || link.lifecycle !== 'activated'
    || link.specialistVersion !== body.expectedSpecialistVersion + 1
    || link.staffVersion !== body.expectedStaffVersion + 1
    || !validInstant(link.createdAt)) cryptoFailure()
  return responseFor(link)
}

const activeOwner = async (db, actor) => {
  const row = await db.prepare(
    `SELECT id,role,status,specialist_id,version
     FROM staff_users WHERE id=?`,
  ).bind(actor.id).first()
  if (!row || row.id !== actor.id || row.role !== 'owner' || row.status !== 'active'
    || row.specialist_id !== actor.specialistId || row.version !== actor.version) forbidden()
  return row
}

const targetRows = async (db, staffId, specialistId) => Promise.all([
  db.prepare(
    `SELECT id,email_lookup,email_envelope,display_name_envelope,role,status,
            access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at
     FROM staff_users WHERE id=?`,
  ).bind(staffId).first(),
  db.prepare(
    `SELECT id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
            archived_at,created_at,updated_at,professional_title_envelope
     FROM specialists WHERE id=?`,
  ).bind(specialistId).first(),
])

const safeTitle = (value) => {
  if (typeof value !== 'string' || value !== value.trim()
    || value !== value.normalize('NFC') || !isWellFormedUnicode(value)
    || /[\p{Cc}\p{Cf}]/u.test(value)) return false
  const encoded = new TextEncoder().encode(value)
  const valid = encoded.byteLength >= 1 && encoded.byteLength <= 120
  encoded.fill(0)
  return valid
}

const safeDisplayName = (value) => {
  if (typeof value !== 'string' || value !== value.trim()
    || value !== value.normalize('NFC') || !isWellFormedUnicode(value)) return false
  const encoded = new TextEncoder().encode(value)
  const valid = encoded.byteLength >= 1 && encoded.byteLength <= 120
  encoded.fill(0)
  return valid
}

const decryptProfilePresentation = async (context, profile) => {
  try {
    const displayName = await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: SCOPE,
      recordId: profile.id,
      field: 'display_name',
      envelope: JSON.parse(profile.display_name_envelope),
    })
    const professionalTitle = profile.professional_title_envelope === null
      ? LEGACY_TITLE
      : await decryptForScope(context.keyring, context.dataKey, {
          expectedScope: SCOPE,
          recordId: profile.id,
          field: 'professional_title',
          envelope: JSON.parse(profile.professional_title_envelope),
        })
    if (!safeDisplayName(displayName) || !safeTitle(professionalTitle)) cryptoFailure()
    return Object.freeze({ displayName, professionalTitle })
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    cryptoFailure()
  }
}

const encryptSnapshot = async (context, recordId, value) => JSON.stringify(
  await encryptForScope(context.keyring, context.dataKey, {
    expectedScope: SCOPE,
    recordId,
    field: 'record_version',
    plaintext: JSON.stringify(value),
  }),
)

const specialistSnapshot = (profile, presentation) => ({
  archivedAt: profile.archived_at,
  createdAt: profile.created_at,
  displayName: presentation.displayName,
  id: profile.id,
  professionalTitle: presentation.professionalTitle,
  schema: 'specialist.v3',
  staffUserId: profile.staff_user_id,
  standardRateGrosze: profile.standard_rate_grosze,
  status: profile.status,
  updatedAt: profile.updated_at,
  version: profile.version,
})

const validateTargetState = (staff, profile, body) => {
  if (!staff || !profile
    || !STAFF_ID.test(staff.id ?? '') || !SPECIALIST_ID.test(profile.id ?? '')
    || !['owner', 'coordinator', 'specialist'].includes(staff.role)
    || staff.role === 'specialist'
    || staff.status !== 'active' || staff.specialist_id !== null
    || profile.status !== 'active' || profile.archived_at !== null
    || profile.staff_user_id !== null) conflict()
  if (staff.version !== body.expectedStaffVersion
    || profile.version !== body.expectedSpecialistVersion) versionConflict()
}

const messageOf = (error) => {
  try {
    if (!(error instanceof Error)) return ''
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
    return descriptor && Object.hasOwn(descriptor, 'value')
      && typeof descriptor.value === 'string' ? descriptor.value : ''
  } catch {
    return ''
  }
}

const linkConstraint = (error) => /^(?:D1_ERROR: )?(?:UNIQUE constraint failed: (?:staff_users\.specialist_id|specialists\.staff_user_id)|invalid_specialist_staff_link): SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_(?:UNIQUE|TRIGGER)\))?$/
  .test(messageOf(error))

const classifyFailedCommit = async (db, specialistId, body) => {
  const [staff, profile] = await targetRows(db, body.staffId, specialistId)
  if (!staff || !profile || staff.status !== 'active' || staff.specialist_id !== null
    || profile.status !== 'active' || profile.archived_at !== null
    || profile.staff_user_id !== null) conflict()
  if (staff.version !== body.expectedStaffVersion
    || profile.version !== body.expectedSpecialistVersion) versionConflict()
  conflict()
}

export async function linkSpecialistAccount(value) {
  const command = captureCommand(value)
  const context = await loadContext(command.db, command.keyring)
  const digest = await requestDigest(command.specialistId, command.body)
  const idem = Object.freeze({
    actorId: command.actor.id,
    operation: OPERATION,
    idempotencyKey: command.idempotencyKey,
    requestDigest: digest,
    expectedScope: SCOPE,
  })
  const replay = await inspectIdempotency(command.db, context, idem)
  if (replay) return replayResult(replay, command.specialistId, command.body)

  await activeOwner(command.db, command.actor)
  const [staff, profile] = await targetRows(
    command.db,
    command.body.staffId,
    command.specialistId,
  )
  validateTargetState(staff, profile, command.body)
  const presentation = await decryptProfilePresentation(context, profile)
  const now = new Date(command.nowMs).toISOString()
  const nextStaff = Object.freeze({
    ...staff,
    specialist_id: profile.id,
    version: staff.version + 1,
    updated_at: now,
  })
  const nextProfile = Object.freeze({
    ...profile,
    staff_user_id: staff.id,
    version: profile.version + 1,
    updated_at: now,
  })
  const used = new Set()
  const linkId = generated(command.idFactory, 'spl', LINK_ID, used)
  const staffVersionId = generated(command.idFactory, 'ver', VERSION_ID, used)
  const specialistVersionId = generated(command.idFactory, 'ver', VERSION_ID, used)
  const auditId = generated(command.idFactory, 'aud', AUDIT_ID, used)
  const staffSnapshotEnvelope = await encryptSnapshot(context, staff.id, nextStaff)
  const specialistSnapshotEnvelope = await encryptSnapshot(
    context,
    profile.id,
    specialistSnapshot(nextProfile, presentation),
  )
  const link = linkDto({
    id: linkId,
    specialistId: profile.id,
    staffId: staff.id,
    specialistVersion: nextProfile.version,
    staffVersion: nextStaff.version,
    createdAt: now,
  })
  const response = responseFor(link)
  const idempotency = await createIdempotencyStatement(command.db, context, {
    ...idem,
    resourceType: 'specialist_account_link',
    resourceId: link.id,
    response,
    createdAt: now,
    expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  })
  const audit = auditEventStatement(command.db, {
    id: auditId,
    occurredAt: now,
    actorStaffId: command.actor.id,
    action: 'specialist.account.linked',
    entityType: 'specialist',
    entityId: profile.id,
    result: 'success',
    correlationId: command.correlationId,
    metadata: {
      specialistVersion: nextProfile.version,
      staffVersion: nextStaff.version,
    },
    reasonEnvelope: null,
  })
  const unit = createUnitOfWork(command.db, {
    mode: 'mutation',
    actorId: command.actor.id,
    correlationId: command.correlationId,
  })
  unit.domain(command.db.prepare(
    `UPDATE staff_users
     SET specialist_id=?,version=version+1,updated_at=?
     WHERE id=? AND role=? AND status='active' AND specialist_id IS NULL AND version=?
       AND email_lookup=? AND email_envelope=? AND display_name_envelope=?
       AND access_subject IS ? AND activated_at IS ? AND disabled_at IS ? AND created_at=?`,
  ).bind(
    profile.id,
    now,
    staff.id,
    staff.role,
    staff.version,
    staff.email_lookup,
    staff.email_envelope,
    staff.display_name_envelope,
    staff.access_subject,
    staff.activated_at,
    staff.disabled_at,
    staff.created_at,
  ))
  unit.domain(command.db.prepare(
    `UPDATE specialists
     SET staff_user_id=?,version=version+1,updated_at=?
     WHERE id=? AND staff_user_id IS NULL AND status='active' AND archived_at IS NULL
       AND version=? AND display_name_envelope=? AND professional_title_envelope IS ?
       AND standard_rate_grosze=? AND created_at=? AND (SELECT changes())=1`,
  ).bind(
    staff.id,
    now,
    profile.id,
    profile.version,
    profile.display_name_envelope,
    profile.professional_title_envelope,
    profile.standard_rate_grosze,
    profile.created_at,
  ))
  unit.version(command.db.prepare(
    `INSERT INTO record_versions
     (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
      changed_at,correlation_id)
     VALUES (?,'staff_user',?,?,?,?,?,?)`,
  ).bind(
    staffVersionId,
    staff.id,
    nextStaff.version,
    staffSnapshotEnvelope,
    command.actor.id,
    now,
    command.correlationId,
  ))
  unit.version(command.db.prepare(
    `INSERT INTO record_versions
     (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
      changed_at,correlation_id)
     VALUES (?,'specialist',?,?,?,?,?,?)`,
  ).bind(
    specialistVersionId,
    profile.id,
    nextProfile.version,
    specialistSnapshotEnvelope,
    command.actor.id,
    now,
    command.correlationId,
  ))
  unit.domain(command.db.prepare(
    `INSERT INTO specialist_account_links
     (id,specialist_id,staff_user_id,lifecycle,changed_by_staff_id,version,created_at)
     VALUES (?,?,?,'activated',?,?,?)`,
  ).bind(
    link.id,
    profile.id,
    staff.id,
    command.actor.id,
    nextProfile.version,
    now,
  ))
  unit.audit(audit)
  unit.idempotency(idempotency)
  unit.guard(command.db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'specialist_account_link_postcondition'
     WHERE NOT (
       EXISTS (SELECT 1 FROM staff_users
         WHERE id=? AND email_lookup=? AND email_envelope=? AND display_name_envelope=?
           AND role=? AND status='active' AND access_subject IS ? AND specialist_id=?
           AND version=? AND activated_at IS ? AND disabled_at IS ? AND created_at=?
           AND updated_at=?)
       AND EXISTS (SELECT 1 FROM specialists
         WHERE id=? AND staff_user_id=? AND display_name_envelope=?
           AND professional_title_envelope IS ? AND standard_rate_grosze=?
           AND status='active' AND version=? AND archived_at IS NULL
           AND created_at=? AND updated_at=?)
       AND EXISTS (SELECT 1 FROM record_versions
         WHERE id=? AND entity_type='staff_user' AND entity_id=? AND version=?
           AND snapshot_envelope=? AND changed_by_staff_id=? AND changed_at=?
           AND correlation_id=?)
       AND EXISTS (SELECT 1 FROM record_versions
         WHERE id=? AND entity_type='specialist' AND entity_id=? AND version=?
           AND snapshot_envelope=? AND changed_by_staff_id=? AND changed_at=?
           AND correlation_id=?)
       AND EXISTS (SELECT 1 FROM specialist_account_links
         WHERE id=? AND specialist_id=? AND staff_user_id=? AND lifecycle='activated'
           AND changed_by_staff_id=? AND version=? AND created_at=?)
       AND EXISTS (SELECT 1 FROM audit_events
         WHERE id=? AND occurred_at=? AND actor_staff_id=?
           AND action='specialist.account.linked' AND entity_type='specialist'
           AND entity_id=? AND result='success' AND reason_envelope IS NULL
           AND correlation_id=? AND metadata_json=?)
       AND EXISTS (SELECT 1 FROM idempotency_records
         WHERE actor_id=? AND operation=? AND idempotency_key=?
           AND resource_type='specialist_account_link' AND resource_id=?)
     )`,
  ).bind(
    staff.id,
    staff.email_lookup,
    staff.email_envelope,
    staff.display_name_envelope,
    staff.role,
    staff.access_subject,
    profile.id,
    nextStaff.version,
    staff.activated_at,
    staff.disabled_at,
    staff.created_at,
    now,
    profile.id,
    staff.id,
    profile.display_name_envelope,
    profile.professional_title_envelope,
    profile.standard_rate_grosze,
    nextProfile.version,
    profile.created_at,
    now,
    staffVersionId,
    staff.id,
    nextStaff.version,
    staffSnapshotEnvelope,
    command.actor.id,
    now,
    command.correlationId,
    specialistVersionId,
    profile.id,
    nextProfile.version,
    specialistSnapshotEnvelope,
    command.actor.id,
    now,
    command.correlationId,
    link.id,
    profile.id,
    staff.id,
    command.actor.id,
    nextProfile.version,
    now,
    auditId,
    now,
    command.actor.id,
    profile.id,
    command.correlationId,
    JSON.stringify({
      specialistVersion: nextProfile.version,
      staffVersion: nextStaff.version,
    }),
    command.actor.id,
    OPERATION,
    command.idempotencyKey,
    link.id,
  ))
  try {
    await unit.commit()
    return response
  } catch (error) {
    if (isD1IdentityCollision(error)) {
      try {
        const recovered = await recoverIdempotencyAfterCollision(
          command.recoveryDb,
          context,
          idem,
          error,
        )
        return replayResult(recovered, command.specialistId, command.body)
      } catch (recoveryError) {
        if (recoveryError !== error) throw recoveryError
      }
    }
    if (isD1CoreDirectoryInvariantFailure(error)
      || isD1IdentityCollision(error)
      || linkConstraint(error)) {
      return classifyFailedCommit(
        command.recoveryDb,
        command.specialistId,
        command.body,
      )
    }
    throw error
  }
}
