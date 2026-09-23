import {
  captureClientNote,
  captureClientNoteInput,
  captureClientNotesPayload,
  captureClientNotesQuery,
} from '../../src/client-notes.js'
import { encodeBase64Url, decodeBase64Url } from '../security/encoding.js'
import { encryptForScope, decryptForScope } from '../security/envelope.js'
import { loadClientCryptoContext } from './crypto.js'
import { loadClientResourceFact } from './resources.js'
import { captureAuthorityActor } from '../identity/authority-actor.js'
import { authorize } from '../identity/policy.js'
import { auditEventStatement } from '../audit/events.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectStoredScopeIdempotency,
  recoverStoredScopeIdempotencyAfterCollision,
} from '../db/unit-of-work.js'
import { isD1CoreDirectoryInvariantFailure, isD1IdentityCollision } from '../db/errors.js'

const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const NOTE_ID = /^cno_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const AUDIT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPERATION = 'clients.notes.create'
const CURSOR_DOMAIN = 'bwm:client-session-notes:cursor:v1'
const DAY_MS = 24 * 60 * 60 * 1000

const invalid = (field = 'body') => { throw new TypeError(`VALIDATION_FAILED/${field}`) }
const notFound = () => { throw new Error('NOT_FOUND') }
const corrupt = () => { throw new Error('CRYPTO_FAILURE') }

const exact = (value, keys) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null
    const actual = Reflect.ownKeys(value)
    if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return null
    const captured = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      captured[key] = descriptor.value
    }
    return captured
  } catch { return null }
}

export function validateClientNoteBody(value) {
  const body = captureClientNoteInput(value)
  if (!body) invalid('text')
  return body
}

const actorFor = (input) => {
  const actor = captureAuthorityActor(input)
  if (!actor) notFound()
  return actor
}

const currentLead = async (db, actor, clientId, nowMs, write = false) => {
  if (!CLIENT_ID.test(clientId ?? '') || !Number.isSafeInteger(nowMs) || nowMs < 0
    || !actor.specialistId) notFound()
  const resource = await loadClientResourceFact(db, actor, clientId)
  if (resource.assignment?.specialistId !== actor.specialistId
    || !authorize(actor, 'clinical.read', resource, { nowMs })
    || (write && !authorize(actor, 'client.manage', resource, { nowMs }))) notFound()
  const row = await db.prepare(
    `SELECT client.identity_envelope,assignment.id AS assignment_id,
            assignment.version AS assignment_version
     FROM clients AS client
     JOIN client_assignments AS assignment
       ON assignment.client_id=client.id AND assignment.ends_at IS NULL
     JOIN specialists AS specialist
       ON specialist.id=assignment.specialist_id
       AND specialist.status='active' AND specialist.staff_user_id=?
     JOIN staff_users AS staff
       ON staff.id=specialist.staff_user_id AND staff.specialist_id=specialist.id
       AND staff.status='active' AND staff.role=? AND staff.version=?
     JOIN staff_authorities AS authority
       ON authority.staff_id=staff.id AND authority.revision=?
     WHERE client.id=? AND client.status IN ('active','paused')
       AND assignment.specialist_id=?`
  ).bind(actor.id, actor.role, actor.version, actor.authorityRevision,
    clientId, actor.specialistId).first()
  if (!row || typeof row.identity_envelope !== 'string'
    || typeof row.assignment_id !== 'string'
    || !/^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(row.assignment_id)
    || !Number.isSafeInteger(row.assignment_version) || row.assignment_version < 1) notFound()
  return Object.freeze({
    identityEnvelope: row.identity_envelope,
    assignmentId: row.assignment_id,
    assignmentVersion: row.assignment_version,
  })
}

const cursorPayload = (lead, actor, clientId, query, row) => ({
  clientId,
  authorStaffId: actor.id,
  authorSpecialistId: actor.specialistId,
  assignmentId: lead.assignmentId,
  assignmentVersion: lead.assignmentVersion,
  authorityRevision: actor.authorityRevision,
  limit: query.limit,
  createdAt: row.createdAt,
  id: row.id,
})

const cursorMessage = (version, position) => new TextEncoder().encode(
  `${CURSOR_DOMAIN}\n${version}\n${position}`,
)

const cursorSignature = async (key, version, position) => {
  const message = cursorMessage(version, position)
  try { return new Uint8Array(await crypto.subtle.sign('HMAC', key, message)) }
  finally { message.fill(0) }
}

const encodeCursor = async (keyring, payload) => {
  const version = keyring?.activeLookupKeyVersion
  const key = keyring?.getLookupHmac?.(version)
  if (!Number.isSafeInteger(version) || version < 1 || !key) corrupt()
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  let signature
  try {
    const position = encodeBase64Url(bytes)
    signature = await cursorSignature(key, version, position)
    if (signature.byteLength !== 32) corrupt()
    return `v1.${version}.${position}.${encodeBase64Url(signature)}`
  } finally { bytes.fill(0); signature?.fill(0) }
}

const decodeCursor = async (keyring, token, lead, actor, clientId, query) => {
  const segments = token.split('.')
  if (segments.length !== 4 || segments[0] !== 'v1'
    || !/^[1-9]\d*$/.test(segments[1])) invalid('cursor')
  const version = Number(segments[1])
  const key = keyring?.getLookupHmac?.(version)
  if (!Number.isSafeInteger(version) || version < 1 || !key) invalid('cursor')
  let signature
  let expected
  let positionBytes
  try {
    signature = decodeBase64Url(segments[3])
    positionBytes = decodeBase64Url(segments[2])
    if (signature.byteLength !== 32 || positionBytes.byteLength > 700) invalid('cursor')
    expected = await cursorSignature(key, version, segments[2])
    let difference = 0
    for (let index = 0; index < 32; index += 1) difference |= signature[index] ^ expected[index]
    if (difference !== 0) invalid('cursor')
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(positionBytes))
    const keys = [
      'clientId', 'authorStaffId', 'authorSpecialistId', 'assignmentId',
      'assignmentVersion', 'authorityRevision', 'limit', 'createdAt', 'id',
    ]
    const position = exact(value, keys)
    if (!position || JSON.stringify(position) !== new TextDecoder().decode(positionBytes)
      || position.clientId !== clientId
      || position.authorStaffId !== actor.id
      || position.authorSpecialistId !== actor.specialistId
      || position.assignmentId !== lead.assignmentId
      || position.assignmentVersion !== lead.assignmentVersion
      || position.authorityRevision !== actor.authorityRevision
      || position.limit !== query.limit
      || !captureClientNote({
        id: position.id, clientId, authorStaffId: actor.id,
        authorSpecialistId: actor.specialistId,
        createdAt: position.createdAt, text: 'x',
      })) invalid('cursor')
    return position
  } catch { invalid('cursor') }
  finally { signature?.fill(0); expected?.fill(0); positionBytes?.fill(0) }
}

const digestRequest = async (clientId, body) => {
  const bytes = new TextEncoder().encode(JSON.stringify({
    route: `POST /api/v1/clients/${clientId}/notes`, body,
  }))
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return encodeBase64Url(digest)
  } finally { bytes.fill(0); digest?.fill(0) }
}

const idemInput = (actor, clientId, idempotencyKey, requestDigest) => Object.freeze({
  actorId: actor.id,
  operation: OPERATION,
  idempotencyKey,
  requestDigest,
  resourceType: 'client',
  scopeType: 'client',
  scopePurpose: 'identity',
})

const replayResult = (replay, clientId, actor, text) => {
  const body = exact(replay?.body, ['data'])
  const data = exact(body?.data, ['note'])
  const note = captureClientNote(data?.note)
  if (replay.status !== 201 || !note || note.clientId !== clientId
    || note.authorStaffId !== actor.id
    || note.authorSpecialistId !== actor.specialistId
    || note.text !== text) corrupt()
  return Object.freeze({ status: 201, body: Object.freeze({ data: Object.freeze({ note }) }) })
}

const noteGuard = (db, value) => db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'client_note_postcondition' WHERE NOT (
     EXISTS (SELECT 1 FROM client_session_notes
       WHERE id=? AND client_id=? AND author_staff_id=?
         AND author_specialist_id=? AND created_at=? AND body_envelope=?
         AND json_extract(body_envelope,'$.dataKeyId')=?)
     AND EXISTS (SELECT 1 FROM audit_events
       WHERE id=? AND actor_staff_id=? AND action='client.note.created'
         AND entity_type='client' AND entity_id=? AND result='success'
         AND correlation_id=? AND metadata_json='{}' AND reason_envelope IS NULL)
     AND EXISTS (SELECT 1 FROM idempotency_records
       WHERE actor_id=? AND operation=? AND idempotency_key=?
         AND resource_type='client' AND resource_id=?
         AND json_extract(request_hash,'$.dataKeyId')=?
         AND json_extract(response_envelope,'$.dataKeyId')=?)
     AND EXISTS (SELECT 1 FROM clients AS client
       JOIN client_assignments AS assignment
         ON assignment.client_id=client.id AND assignment.ends_at IS NULL
       WHERE client.id=? AND client.status IN ('active','paused')
         AND assignment.id=? AND assignment.version=? AND assignment.specialist_id=?)
     AND EXISTS (SELECT 1 FROM staff_users AS staff
       JOIN specialists AS specialist
         ON specialist.id=staff.specialist_id AND specialist.staff_user_id=staff.id
       JOIN staff_authorities AS authority ON authority.staff_id=staff.id
       WHERE staff.id=? AND staff.role=? AND staff.status='active'
         AND staff.version=? AND staff.specialist_id=?
         AND specialist.status='active' AND authority.revision=?)
     AND EXISTS (SELECT 1 FROM data_keys
       WHERE id=? AND scope_type='client' AND scope_id=?
         AND purpose='identity' AND retired_at IS NULL)
   )`
).bind(
  value.note.id, value.note.clientId, value.actor.id,
  value.actor.specialistId, value.note.createdAt, value.envelope,
  value.dataKeyId,
  value.auditId, value.actor.id, value.note.clientId, value.correlationId,
  value.actor.id, OPERATION, value.idempotencyKey, value.note.clientId,
  value.dataKeyId, value.dataKeyId,
  value.note.clientId, value.lead.assignmentId,
  value.lead.assignmentVersion, value.actor.specialistId,
  value.actor.id, value.actor.role, value.actor.version,
  value.actor.specialistId, value.actor.authorityRevision,
  value.dataKeyId, value.note.clientId,
)

export async function createClientNote(input) {
  const command = exact(input, [
    'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId',
    'idFactory', 'clientId', 'body', 'idempotencyKey',
  ])
  if (!command?.db?.prepare || !command.db.batch || !command.recoveryDb?.prepare
    || !command.keyring || typeof command.idFactory !== 'function'
    || !CORRELATION_ID.test(command.correlationId ?? '')
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey ?? '')) invalid()
  const actor = actorFor(command.actor)
  const body = validateClientNoteBody(command.body)
  const lead = await currentLead(command.db, actor, command.clientId, command.nowMs, true)
  const requestDigest = await digestRequest(command.clientId, body)
  const idem = idemInput(actor, command.clientId, command.idempotencyKey, requestDigest)
  const replay = await inspectStoredScopeIdempotency(command.db, command.keyring, idem)
  if (replay) return replayResult(replay, command.clientId, actor, body.text)

  const context = await loadClientCryptoContext(command.db, command.keyring, {
    clientId: command.clientId, envelope: lead.identityEnvelope,
  })
  const noteSuffix = command.idFactory()
  const auditSuffix = command.idFactory()
  if (typeof noteSuffix !== 'string' || typeof auditSuffix !== 'string') invalid()
  const noteId = `cno_${noteSuffix}`
  const auditId = `aud_${auditSuffix}`
  if (!NOTE_ID.test(noteId) || !AUDIT_ID.test(auditId)) invalid()
  const createdAt = new Date(command.nowMs).toISOString()
  const note = captureClientNote({
    id: noteId, clientId: command.clientId,
    authorStaffId: actor.id, authorSpecialistId: actor.specialistId,
    createdAt, text: body.text,
  })
  if (!note) corrupt()
  const envelope = JSON.stringify(await encryptForScope(
    context.keyring, context.dataKey, {
      expectedScope: context.scope, recordId: note.id,
      field: 'client_session_note', plaintext: note.text,
    },
  ))
  const response = Object.freeze({ status: 201, body: Object.freeze({ data: Object.freeze({ note }) }) })
  const idempotency = await createIdempotencyStatement(command.db, context, {
    actorId: actor.id,
    operation: OPERATION,
    idempotencyKey: command.idempotencyKey,
    requestDigest,
    expectedScope: context.scope,
    resourceType: 'client',
    resourceId: command.clientId,
    response,
    createdAt,
    expiresAt: new Date(command.nowMs + DAY_MS).toISOString(),
  })
  const uow = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  uow.domain(command.db.prepare(
    `INSERT INTO client_session_notes
     (id,client_id,author_staff_id,author_specialist_id,created_at,body_envelope)
     VALUES (?,?,?,?,?,?)`
  ).bind(note.id, note.clientId, note.authorStaffId,
    note.authorSpecialistId, note.createdAt, envelope))
  uow.audit(auditEventStatement(command.db, {
    id: auditId, occurredAt: createdAt, actorStaffId: actor.id,
    action: 'client.note.created', entityType: 'client',
    entityId: command.clientId, result: 'success',
    correlationId: command.correlationId, metadata: {}, reasonEnvelope: null,
  }))
  uow.idempotency(idempotency)
  uow.guard(noteGuard(command.db, {
    note, actor, lead, envelope, auditId, dataKeyId: context.dataKey.id,
    correlationId: command.correlationId, idempotencyKey: command.idempotencyKey,
  }))
  try {
    await uow.commit()
    return response
  } catch (error) {
    if (isD1IdentityCollision(error)) {
      await currentLead(command.recoveryDb, actor, command.clientId, command.nowMs, true)
      const recovered = await recoverStoredScopeIdempotencyAfterCollision(
        command.recoveryDb, command.keyring, idem, error,
      )
      return replayResult(recovered, command.clientId, actor, body.text)
    }
    if (isD1CoreDirectoryInvariantFailure(error)) notFound()
    throw error
  }
}

export async function listClientNotes(input) {
  const command = exact(input, ['db', 'actor', 'keyring', 'nowMs', 'clientId', 'query'])
  if (!command?.db?.prepare || !command.keyring) invalid()
  const actor = actorFor(command.actor)
  const lead = await currentLead(command.db, actor, command.clientId, command.nowMs)
  const query = captureClientNotesQuery(command.query)
  if (!query) invalid('cursor')
  const cursor = query.cursor
    ? await decodeCursor(command.keyring, query.cursor, lead, actor, command.clientId, query)
    : null
  const context = await loadClientCryptoContext(command.db, command.keyring, {
    clientId: command.clientId, envelope: lead.identityEnvelope,
  })
  const statement = cursor
    ? command.db.prepare(
      `SELECT id,client_id,author_staff_id,author_specialist_id,created_at,body_envelope
       FROM client_session_notes
       WHERE client_id=? AND author_staff_id=? AND author_specialist_id=?
         AND (created_at<? OR (created_at=? AND id<?))
       ORDER BY created_at DESC,id DESC LIMIT ?`
    ).bind(command.clientId, actor.id, actor.specialistId,
      cursor.createdAt, cursor.createdAt, cursor.id, query.limit + 1)
    : command.db.prepare(
      `SELECT id,client_id,author_staff_id,author_specialist_id,created_at,body_envelope
       FROM client_session_notes
       WHERE client_id=? AND author_staff_id=? AND author_specialist_id=?
       ORDER BY created_at DESC,id DESC LIMIT ?`
    ).bind(command.clientId, actor.id, actor.specialistId, query.limit + 1)
  const rows = (await statement.all()).results
  if (!Array.isArray(rows) || rows.length > query.limit + 1) corrupt()
  const current = await currentLead(command.db, actor, command.clientId, command.nowMs)
  if (current.assignmentId !== lead.assignmentId
    || current.assignmentVersion !== lead.assignmentVersion) notFound()
  const pageRows = rows.slice(0, query.limit)
  const items = []
  for (const row of pageRows) {
    if (row.client_id !== command.clientId || row.author_staff_id !== actor.id
      || row.author_specialist_id !== actor.specialistId) corrupt()
    let envelope
    try { envelope = JSON.parse(row.body_envelope) } catch { corrupt() }
    const text = await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope,
      recordId: row.id,
      field: 'client_session_note', envelope,
    })
    const note = captureClientNote({
      id: row.id, clientId: row.client_id,
      authorStaffId: row.author_staff_id,
      authorSpecialistId: row.author_specialist_id,
      createdAt: row.created_at, text,
    })
    if (!note) corrupt()
    items.push(note)
  }
  const nextCursor = rows.length > query.limit
    ? await encodeCursor(command.keyring, cursorPayload(
      lead, actor, command.clientId, query, items.at(-1),
    ))
    : null
  const data = captureClientNotesPayload({ items, nextCursor })
  if (!data) corrupt()
  return Object.freeze({ status: 200, body: Object.freeze({ data }) })
}
