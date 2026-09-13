import {
  captureSpecialistAbsence,
  captureSpecialistAbsenceCancelInput,
  captureSpecialistAbsenceInput,
  captureSpecialistAbsencesPayload,
  isSpecialistAbsenceId,
} from '../../src/specialist-absences.js'
import { auditEventStatement } from '../audit/events.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectIdempotency,
  recoverIdempotencyAfterCollision,
} from '../db/unit-of-work.js'
import { isD1IdentityCollision } from '../db/errors.js'
import { authorize } from '../identity/policy.js'
import { captureAuthorityActor } from '../identity/authority-actor.js'
import { encodeBase64Url } from '../security/encoding.js'
import { encryptForScope } from '../security/envelope.js'

export const SPECIALIST_ABSENCE_SCOPE = Object.freeze({
  type: 'staff_directory', id: 'centre_1', purpose: 'identity',
})

const INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const READ_KEYS = Object.freeze(['db', 'actor', 'keyring', 'nowMs', 'url'])
const ABSENCE_ID = /^abs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const VERSION_ID = /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const AUDIT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000
const MAX_ROWS = 500
const CREATE_OPERATION = 'specialist_absence.create'
const CANCEL_OPERATION = 'specialist_absence.cancel'

const invalid = (field = 'body') => { throw new TypeError(`VALIDATION_FAILED/${field}`) }
const notFound = () => { throw new Error('NOT_FOUND') }
const internal = () => { throw new Error('INTERNAL_ERROR') }

const exact = (value, keys, field = 'body') => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalid(field)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(descriptors)
    if (ownKeys.length !== keys.length || ownKeys.some((key) => (
      typeof key !== 'string' || !keys.includes(key)
      || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')
    ))) invalid(field)
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])))
  } catch (error) {
    if (error instanceof TypeError && /^VALIDATION_FAILED\//.test(error.message)) throw error
    invalid(field)
  }
}

const actorFact = (value) => {
  const actor = captureAuthorityActor(value)
  if (!actor) notFound()
  return actor
}

const context = async (db, keyring) => {
  const dataKey = await db.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
       kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1 AND retired_at IS NULL`,
  ).bind(
    SPECIALIST_ABSENCE_SCOPE.type,
    SPECIALIST_ABSENCE_SCOPE.id,
    SPECIALIST_ABSENCE_SCOPE.purpose,
  ).first()
  if (!dataKey) throw new Error('CRYPTO_FAILURE')
  return Object.freeze({ keyring, dataKey, expectedScope: SPECIALIST_ABSENCE_SCOPE })
}

const canonicalInstant = (nowMs) => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) internal()
  try { return new Date(nowMs).toISOString() } catch { internal() }
}

const generated = (idFactory, prefix, pattern) => {
  let suffix
  try { suffix = idFactory() } catch { internal() }
  const value = `${prefix}_${suffix}`
  if (typeof suffix !== 'string' || !pattern.test(value)) internal()
  return value
}

const dateValue = (value) => {
  const match = typeof value === 'string' ? DATE.exec(value) : null
  if (!match) return null
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const date = new Date(epoch)
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    ? Object.freeze({ value, epoch }) : null
}

const dateWindow = (value) => {
  const parsed = exact(value, ['from', 'to'], 'query')
  const from = dateValue(parsed.from)
  const to = dateValue(parsed.to)
  if (!from || !to || to.value < from.value) invalid('query')
  const days = Math.floor((to.epoch - from.epoch) / DAY_MS) + 1
  if (days < 1 || days > 93) invalid('query')
  return Object.freeze({ from: from.value, to: to.value })
}

export function parseSpecialistAbsenceQuery(value) {
  let url
  try { url = new URL(value) } catch { invalid('query') }
  const params = [...url.searchParams.entries()]
  if (params.length !== 2 || new Set(params.map(([key]) => key)).size !== 2
    || !params.every(([key]) => key === 'from' || key === 'to')) invalid('query')
  return dateWindow({ from: url.searchParams.get('from'), to: url.searchParams.get('to') })
}

const digest = async (route, body) => {
  const encoded = new TextEncoder().encode(JSON.stringify({ route, body }))
  let value
  try {
    value = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
    return encodeBase64Url(value)
  } finally {
    encoded.fill(0)
    value?.fill(0)
  }
}

const loadActiveSpecialist = async (db, specialistId) => {
  const row = await db.prepare(
    `SELECT id FROM specialists WHERE id=? AND status='active'`,
  ).bind(specialistId).first()
  if (row?.id !== specialistId) notFound()
  return row
}

const command = async (input, bodyCapture) => {
  const captured = exact(input, INPUT_KEYS)
  if (!captured.db?.prepare || !captured.db?.batch || !captured.recoveryDb?.prepare
    || !captured.keyring || typeof captured.idFactory !== 'function'
    || !Number.isSafeInteger(captured.nowMs) || captured.nowMs < 0
    || !CORRELATION_ID.test(captured.correlationId ?? '')
    || !IDEMPOTENCY_KEY.test(captured.idempotencyKey ?? '')) invalid()
  const actor = actorFact(captured.actor)
  const body = bodyCapture(captured.body)
  return Object.freeze({ ...captured, actor, body, now: canonicalInstant(captured.nowMs) })
}

const idemInput = (actor, operation, idempotencyKey, requestDigest) => ({
  actorId: actor.id, operation, idempotencyKey, requestDigest,
  expectedScope: SPECIALIST_ABSENCE_SCOPE,
})

const replay = async (db, keyring, idem) => {
  const cryptoContext = await context(db, keyring)
  return { cryptoContext, value: await inspectIdempotency(db, cryptoContext, idem) }
}

const replayAfterCollision = async (db, keyring, idem, error) => {
  if (!isD1IdentityCollision(error)) throw error
  const cryptoContext = await context(db, keyring)
  return recoverIdempotencyAfterCollision(db, cryptoContext, idem, error)
}

const absenceFromRow = (row) => {
  try {
    return captureSpecialistAbsence({
      id: row.id,
      specialistId: row.specialist_id,
      dateFrom: row.date_from,
      dateTo: row.date_to,
      allDay: true,
      version: row.version,
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
    })
  } catch { internal() }
}

const versionEnvelope = async (cryptoContext, absence) => JSON.stringify(await encryptForScope(
  cryptoContext.keyring, cryptoContext.dataKey, {
    expectedScope: SPECIALIST_ABSENCE_SCOPE,
    recordId: absence.id,
    field: 'record_version',
    plaintext: JSON.stringify({ schema: 'specialist_absence.v1', ...absence }),
  },
))

const responseFor = (status, absence) => Object.freeze({
  status,
  body: Object.freeze({ data: Object.freeze({ absence }) }),
})

const createGuard = (commandValue, { absence, versionId, auditId }) => commandValue.db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'specialist_absence_create_uow' WHERE NOT (
     EXISTS (SELECT 1 FROM specialist_absences
       WHERE id=? AND specialist_id=? AND date_from=? AND date_to=? AND version=1
         AND created_by_staff_id=? AND created_at=? AND cancelled_at IS NULL)
     AND EXISTS (SELECT 1 FROM record_versions
       WHERE id=? AND entity_type='specialist_absence' AND entity_id=? AND version=1)
     AND EXISTS (SELECT 1 FROM audit_events
       WHERE id=? AND action='specialist.absence.created' AND entity_type='specialist_absence'
         AND entity_id=? AND actor_staff_id=? AND correlation_id=?)
     AND EXISTS (SELECT 1 FROM idempotency_records
       WHERE actor_id=? AND operation=? AND idempotency_key=?
         AND resource_type='specialist_absence' AND resource_id=?))`,
).bind(
  absence.id, absence.specialistId, absence.dateFrom, absence.dateTo,
  commandValue.actor.id, absence.createdAt, versionId, absence.id,
  auditId, absence.id, commandValue.actor.id, commandValue.correlationId,
  commandValue.actor.id, CREATE_OPERATION, commandValue.idempotencyKey, absence.id,
)

export async function createSpecialistAbsence(input) {
  const base = await command(input, captureSpecialistAbsenceInput)
  const requestDigest = await digest('POST /api/v1/specialist-absences', base.body)
  const idem = idemInput(base.actor, CREATE_OPERATION, base.idempotencyKey, requestDigest)
  const inspected = await replay(base.db, base.keyring, idem)
  if (inspected.value) return inspected.value
  if (!authorize(base.actor, 'appointment.manage', {
    kind: 'specialist_absence', specialistId: base.body.specialistId,
  }, { nowMs: base.nowMs })) throw new Error('FORBIDDEN')
  await loadActiveSpecialist(base.db, base.body.specialistId)
  const absenceId = generated(base.idFactory, 'abs', ABSENCE_ID)
  const versionId = generated(base.idFactory, 'ver', VERSION_ID)
  const auditId = generated(base.idFactory, 'aud', AUDIT_ID)
  const absence = captureSpecialistAbsence({
    id: absenceId, specialistId: base.body.specialistId,
    dateFrom: base.body.dateFrom, dateTo: base.body.dateTo, allDay: true,
    version: 1, createdAt: base.now, cancelledAt: null,
  })
  const snapshotEnvelope = await versionEnvelope(inspected.cryptoContext, absence)
  const response = responseFor(201, absence)
  const idempotency = await createIdempotencyStatement(base.db, inspected.cryptoContext, {
    ...idem, resourceType: 'specialist_absence', resourceId: absence.id,
    response, createdAt: base.now, expiresAt: new Date(base.nowMs + 7 * DAY_MS).toISOString(),
  })
  const unit = createUnitOfWork(base.db, {
    mode: 'mutation', actorId: base.actor.id, correlationId: base.correlationId,
  })
  unit.domain(base.db.prepare(
    `INSERT INTO specialist_absences
      (id,specialist_id,date_from,date_to,version,created_by_staff_id,created_at,
       cancelled_by_staff_id,cancelled_at)
     VALUES (?,?,?, ?,1,?,?,NULL,NULL)`,
  ).bind(
    absence.id, absence.specialistId, absence.dateFrom, absence.dateTo,
    base.actor.id, absence.createdAt,
  ))
  unit.version(base.db.prepare(
    `INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,'specialist_absence',?,1,?,?,?,?)`,
  ).bind(versionId, absence.id, snapshotEnvelope, base.actor.id, base.now, base.correlationId))
  unit.audit(auditEventStatement(base.db, {
    id: auditId, occurredAt: base.now, actorStaffId: base.actor.id,
    action: 'specialist.absence.created', entityType: 'specialist_absence',
    entityId: absence.id, result: 'success', correlationId: base.correlationId,
    metadata: { absenceVersion: 1 }, reasonEnvelope: null,
  }))
  unit.idempotency(idempotency)
  unit.guard(createGuard(base, { absence, versionId, auditId }))
  try {
    await unit.commit()
  } catch (error) {
    return replayAfterCollision(base.recoveryDb, base.keyring, idem, error)
  }
  return response
}

const loadAbsence = async (db, absenceId) => {
  const row = await db.prepare(
    `SELECT id,specialist_id,date_from,date_to,version,created_at,cancelled_at
     FROM specialist_absences WHERE id=?`,
  ).bind(absenceId).first()
  if (!row) notFound()
  return absenceFromRow(row)
}

export async function cancelSpecialistAbsence(input) {
  const captured = exact(input, [...INPUT_KEYS, 'absenceId'])
  if (!isSpecialistAbsenceId(captured.absenceId)) invalid('absenceId')
  const base = Object.freeze({
    ...(await command(
      Object.fromEntries(INPUT_KEYS.map((key) => [key, captured[key]])),
      captureSpecialistAbsenceCancelInput,
    )),
    absenceId: captured.absenceId,
  })
  const requestDigest = await digest(
    `POST /api/v1/specialist-absences/${base.absenceId}/cancellation`, base.body,
  )
  const idem = idemInput(base.actor, CANCEL_OPERATION, base.idempotencyKey, requestDigest)
  const inspected = await replay(base.db, base.keyring, idem)
  if (inspected.value) return inspected.value
  const current = await loadAbsence(base.db, base.absenceId)
  if (current.cancelledAt !== null) notFound()
  if (!authorize(base.actor, 'appointment.manage', {
    kind: 'specialist_absence', specialistId: current.specialistId,
  }, { nowMs: base.nowMs })) notFound()
  if (current.version !== base.body.expectedVersion) {
    const error = new Error('VERSION_CONFLICT')
    error.details = { currentVersion: current.version }
    throw error
  }
  const absence = captureSpecialistAbsence({ ...current, version: current.version + 1, cancelledAt: base.now })
  const versionId = generated(base.idFactory, 'ver', VERSION_ID)
  const auditId = generated(base.idFactory, 'aud', AUDIT_ID)
  const snapshotEnvelope = await versionEnvelope(inspected.cryptoContext, absence)
  const response = responseFor(200, absence)
  const idempotency = await createIdempotencyStatement(base.db, inspected.cryptoContext, {
    ...idem, resourceType: 'specialist_absence', resourceId: absence.id,
    response, createdAt: base.now, expiresAt: new Date(base.nowMs + 7 * DAY_MS).toISOString(),
  })
  const unit = createUnitOfWork(base.db, {
    mode: 'mutation', actorId: base.actor.id, correlationId: base.correlationId,
  })
  unit.domain(base.db.prepare(
    `UPDATE specialist_absences
     SET version=?,cancelled_by_staff_id=?,cancelled_at=?
     WHERE id=? AND version=? AND cancelled_at IS NULL`,
  ).bind(absence.version, base.actor.id, base.now, absence.id, current.version))
  unit.version(base.db.prepare(
    `INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,'specialist_absence',?,?,?,?,?,?)`,
  ).bind(versionId, absence.id, absence.version, snapshotEnvelope,
    base.actor.id, base.now, base.correlationId))
  unit.audit(auditEventStatement(base.db, {
    id: auditId, occurredAt: base.now, actorStaffId: base.actor.id,
    action: 'specialist.absence.cancelled', entityType: 'specialist_absence',
    entityId: absence.id, result: 'success', correlationId: base.correlationId,
    metadata: { absenceVersion: absence.version }, reasonEnvelope: null,
  }))
  unit.idempotency(idempotency)
  unit.guard(base.db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'specialist_absence_cancel_uow' WHERE NOT (
       EXISTS (SELECT 1 FROM specialist_absences
         WHERE id=? AND version=? AND cancelled_by_staff_id=? AND cancelled_at=?)
       AND EXISTS (SELECT 1 FROM record_versions
         WHERE id=? AND entity_type='specialist_absence' AND entity_id=? AND version=?)
       AND EXISTS (SELECT 1 FROM audit_events
         WHERE id=? AND action='specialist.absence.cancelled' AND entity_id=?
           AND actor_staff_id=? AND correlation_id=?)
       AND EXISTS (SELECT 1 FROM idempotency_records
         WHERE actor_id=? AND operation=? AND idempotency_key=? AND resource_id=?))`,
  ).bind(
    absence.id, absence.version, base.actor.id, base.now,
    versionId, absence.id, absence.version, auditId, absence.id,
    base.actor.id, base.correlationId, base.actor.id, CANCEL_OPERATION,
    base.idempotencyKey, absence.id,
  ))
  try {
    await unit.commit()
  } catch (error) {
    return replayAfterCollision(base.recoveryDb, base.keyring, idem, error)
  }
  return response
}

export async function listSpecialistAbsences(input) {
  const captured = exact(input, READ_KEYS)
  if (!captured.db?.prepare || !captured.keyring) invalid()
  const actor = actorFact(captured.actor)
  const window = dateWindow(captured.url instanceof URL
    ? { from: captured.url.searchParams.get('from'), to: captured.url.searchParams.get('to') }
    : parseSpecialistAbsenceQuery(captured.url))
  if (!authorize(actor, 'appointment.manage', {
    kind: 'specialist_absence', specialistId: actor.specialistId ?? 'sp_read_all',
  }, { nowMs: captured.nowMs })) {
    if (actor.role === 'specialist') notFound()
    throw new Error('FORBIDDEN')
  }
  const scoped = actor.role === 'specialist'
  const rows = (await captured.db.prepare(
    `SELECT id,specialist_id,date_from,date_to,version,created_at,cancelled_at
     FROM specialist_absences
     WHERE cancelled_at IS NULL AND date_from<=? AND date_to>=?
       ${scoped ? 'AND specialist_id=?' : ''}
     ORDER BY date_from,id LIMIT ?`,
  ).bind(...(scoped ? [window.to, window.from, actor.specialistId, MAX_ROWS + 1]
    : [window.to, window.from, MAX_ROWS + 1])).all()).results
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) internal()
  const payload = {
    from: window.from, to: window.to,
    absences: rows.map(absenceFromRow),
  }
  return Object.freeze({ data: Object.freeze(captureSpecialistAbsencesPayload(payload)) })
}
