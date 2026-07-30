import { auditEventStatement } from '../audit/events.js'
import { isD1IdentityCollision, isD1LastActiveOwner } from '../db/errors.js'
import { createIdempotencyStatement, inspectIdempotency, recoverIdempotencyAfterCollision } from '../db/unit-of-work.js'
import { blindEmailCandidates, blindEmailIndex, decryptForScope, encryptForScope } from '../security/envelope.js'
import { enqueueOutboxStatement } from '../jobs/outbox.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const roles = new Set(['owner', 'coordinator', 'specialist'])
const exactObject = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const validId = (value) => typeof value === 'string' && ID.test(value)
const iso = (nowMs) => new Date(nowMs).toISOString()
const idFrom = (factory) => { const value = factory(); if (!validId(value)) throw new Error('INTERNAL_ERROR'); return value }
const validation = (field) => { const error = new Error('VALIDATION_FAILED'); error.details = { field }; throw error }
const plain = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]))

export const specialistIdFor = (staffId) => validId(staffId) && staffId.startsWith('stf_') ? `sp_${staffId.slice(4)}` : `sp_${staffId}`

export function validateInvitationInput(input, { dataMode } = {}) {
  if (!exactObject(input, ['displayName', 'email', 'role'])) validation('displayName')
  if (typeof input.displayName !== 'string') validation('displayName')
  const displayName = input.displayName.normalize('NFC').trim()
  if (!displayName || new TextEncoder().encode(displayName).byteLength > 120) validation('displayName')
  if (typeof input.email !== 'string') validation('email')
  const email = input.email.trim().toLowerCase()
  if (!EMAIL.test(email) || new TextEncoder().encode(email).byteLength > 254 || (dataMode === 'fictional' && !email.endsWith('@example.test'))) validation('email')
  if (!roles.has(input.role)) validation('role')
  return Object.freeze({ displayName, email, role: input.role })
}

function publicStaff(row) {
  return { id: row.id, displayName: row.displayName, email: row.email, role: row.role, status: row.status, version: row.version, specialistId: row.specialist_id ?? null }
}
function publicInvitation(row) {
  return { id: row.id, status: row.status, expiresAt: row.expires_at, emailSentAt: row.email_sent_at ?? null, version: row.version }
}
async function envelope(context, recordId, field, plaintext) {
  return JSON.stringify(await encryptForScope(context.keyring, context.dataKey, { expectedScope: context.scope, recordId, field, plaintext }))
}
async function versionStatement(db, context, row, entityType, changedBy, now, correlationId, idFactory) {
  const id = idFrom(idFactory)
  return db.prepare('INSERT INTO record_versions (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, entityType, row.id, row.version, await envelope(context, row.id, 'record_version', JSON.stringify(row)), changedBy, now, correlationId)
}
async function state(db, key) {
  const row = await db.prepare('SELECT key,value_json,version FROM system_state WHERE key=?').bind(key).first()
  if (!row || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error('INTERNAL_ERROR')
  try { return { ...row, value: JSON.parse(row.value_json) } } catch { throw new Error('INTERNAL_ERROR') }
}
async function desiredGenerationStatement(db, now, idFactory) {
  const current = await state(db, 'access.desired_generation')
  if (!Number.isSafeInteger(current.value?.generation) || current.value.generation < 0) throw new Error('INTERNAL_ERROR')
  const generation = current.value.generation + 1
  return { generation, statement: db.prepare('UPDATE system_state SET value_json=?,version=version+1,updated_at=? WHERE key=? AND version=?')
    .bind(JSON.stringify({ generation }), now, current.key, current.version) }
}
async function matchingStaff(db, context, email) {
  const candidates = await blindEmailCandidates(email, context.keyring)
  const rows = (await db.prepare(`SELECT * FROM staff_users WHERE email_lookup IN (${candidates.map(() => '?').join(',')})`).bind(...candidates).all()).results
  const matches = []
  for (const row of rows) {
    try {
      const value = await decryptForScope(context.keyring, context.dataKey, { expectedScope: context.scope, recordId: row.id, field: 'email', envelope: JSON.parse(row.email_envelope) })
      if (value === email) matches.push(row)
    } catch { throw new Error('CRYPTO_FAILURE') }
  }
  return matches
}
async function makeOutbox(db, context, values, nowMs, idFactory) {
  const reconcileId = idFrom(idFactory)
  const expireId = idFrom(idFactory)
  return [
    await enqueueOutboxStatement(db, context, { id: reconcileId, type: 'staff.access.reconcile', aggregateType: 'access_group', aggregateId: 'centre_1', payload: { generation: values.generation, actorId: values.actorId }, idempotencyKey: `staff.access.reconcile:${values.generation}`, scheduledAt: values.now, nowMs }),
    await enqueueOutboxStatement(db, context, { id: expireId, type: 'staff.invitation.expire', aggregateType: 'staff_invitation', aggregateId: values.invitationId, payload: { invitationId: values.invitationId, actorId: values.actorId }, idempotencyKey: `staff.invitation.expire:${values.invitationId}`, scheduledAt: values.expiresAt, nowMs }),
  ]
}

export async function inviteStaff({ db, cryptoContext, actor, input, idempotencyKey, correlationId, nowMs, dataMode, idFactory = () => crypto.randomUUID().replaceAll('-', '') } = {}) {
  if (!db?.prepare || !db?.batch || !validId(actor?.id) || actor.role !== 'owner' || !validId(correlationId) || !Number.isSafeInteger(nowMs) || !validId(idempotencyKey)) throw new Error('FORBIDDEN')
  const request = validateInvitationInput(input, { dataMode })
  const requestDigest = JSON.stringify(request)
  const idem = { actorId: actor.id, operation: 'staff.invite', idempotencyKey, requestDigest, expectedScope: cryptoContext.scope }
  const replay = await inspectIdempotency(db, cryptoContext, idem)
  if (replay) return replay.body
  const now = iso(nowMs); const expiresAt = iso(nowMs + 7 * 24 * 60 * 60 * 1000)
  const existing = await matchingStaff(db, cryptoContext, request.email)
  if (existing.length > 1) throw new Error('INTERNAL_ERROR')
  const reused = existing[0] ?? null
  if (reused && reused.status !== 'disabled') {
    const open = await db.prepare("SELECT id FROM staff_invitations WHERE staff_id=? AND status IN ('provisioning','pending')").bind(reused.id).first()
    if (open || reused.status === 'active') throw new Error('STAFF_INVITATION_CONFLICT')
  }
  const staffId = reused?.id ?? idFrom(idFactory); const invitationId = idFrom(idFactory)
  const lookup = await blindEmailIndex(request.email, cryptoContext.keyring)
  const staff = {
    id: staffId, email_lookup: lookup, email_envelope: await envelope(cryptoContext, staffId, 'email', request.email),
    display_name_envelope: await envelope(cryptoContext, staffId, 'display_name', request.displayName), role: request.role,
    status: 'pending', access_subject: null, specialist_id: request.role === 'specialist' ? specialistIdFor(staffId) : null,
    version: reused ? reused.version + 1 : 1, activated_at: null, disabled_at: null, created_at: reused?.created_at ?? now, updated_at: now,
    displayName: request.displayName, email: request.email,
  }
  const invitation = { id: invitationId, staff_id: staffId, email_lookup: lookup, email_envelope: await envelope(cryptoContext, invitationId, 'email', request.email), display_name_envelope: await envelope(cryptoContext, invitationId, 'display_name', request.displayName), role: request.role, status: 'provisioning', inviter_id: actor.id, expires_at: expiresAt, access_allowed_at: null, email_sent_at: null, activated_at: null, revoked_at: null, version: 1, created_at: now, updated_at: now }
  const desired = await desiredGenerationStatement(db, now, idFactory)
  const body = { data: { staff: publicStaff(staff), invitation: publicInvitation(invitation) } }
  const statements = []
  if (reused) statements.push(db.prepare("UPDATE staff_users SET email_lookup=?,email_envelope=?,display_name_envelope=?,role=?,status='pending',access_subject=NULL,specialist_id=?,activated_at=NULL,disabled_at=NULL,version=version+1,updated_at=? WHERE id=? AND version=? AND status='disabled'")
    .bind(staff.email_lookup, staff.email_envelope, staff.display_name_envelope, staff.role, staff.specialist_id, now, staffId, reused.version))
  else statements.push(db.prepare('INSERT INTO staff_users (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(...Object.values(plain(staff, ['id', 'email_lookup', 'email_envelope', 'display_name_envelope', 'role', 'status', 'access_subject', 'specialist_id', 'version', 'activated_at', 'disabled_at', 'created_at', 'updated_at']))))
  statements.push(
    db.prepare('INSERT INTO staff_invitations (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,inviter_id,expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(...Object.values(plain(invitation, ['id', 'staff_id', 'email_lookup', 'email_envelope', 'display_name_envelope', 'role', 'status', 'inviter_id', 'expires_at', 'access_allowed_at', 'email_sent_at', 'activated_at', 'revoked_at', 'version', 'created_at', 'updated_at']))),
    await versionStatement(db, cryptoContext, staff, 'staff_user', actor.id, now, correlationId, idFactory),
    await versionStatement(db, cryptoContext, invitation, 'staff_invitation', actor.id, now, correlationId, idFactory),
    desired.statement,
    auditEventStatement(db, { id: idFrom(idFactory), occurredAt: now, actorStaffId: actor.id, action: 'staff.invited', entityType: 'staff_invitation', entityId: invitationId, result: 'success', correlationId, metadata: { staffVersion: staff.version, invitationVersion: 1, desiredGeneration: desired.generation }, reasonEnvelope: null }),
    ...(await makeOutbox(db, cryptoContext, { generation: desired.generation, actorId: actor.id, invitationId, expiresAt, now }, nowMs, idFactory)),
    await createIdempotencyStatement(db, cryptoContext, { ...idem, resourceType: 'staff_invitation', resourceId: invitationId, response: { status: 201, body }, createdAt: now, expiresAt: iso(nowMs + 24 * 60 * 60 * 1000) }),
  )
  try { await db.batch(statements); return body } catch (error) {
    if (isD1IdentityCollision(error)) {
      const recovered = await recoverIdempotencyAfterCollision(db, cryptoContext, idem, error)
      if (recovered) return recovered.body
      throw new Error('STAFF_INVITATION_CONFLICT')
    }
    throw error
  }
}

export async function listStaff({ db, cryptoContext } = {}) {
  const rows = (await db.prepare('SELECT * FROM staff_users').all()).results
  const collator = new Intl.Collator('pl-PL', { sensitivity: 'base', numeric: true })
  const staff = []
  for (const row of rows) {
    const [email, displayName, invitation] = await Promise.all([
      decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, { expectedScope: cryptoContext.scope, recordId: row.id, field: 'email', envelope: JSON.parse(row.email_envelope) }),
      decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, { expectedScope: cryptoContext.scope, recordId: row.id, field: 'display_name', envelope: JSON.parse(row.display_name_envelope) }),
      db.prepare("SELECT id,status,expires_at,email_sent_at,version FROM staff_invitations WHERE staff_id=? AND status IN ('provisioning','pending') ORDER BY created_at DESC LIMIT 1").bind(row.id).first(),
    ])
    staff.push({ ...publicStaff({ ...row, email, displayName }), invitation: invitation ? publicInvitation(invitation) : null })
  }
  staff.sort((a, b) => collator.compare(a.displayName, b.displayName) || a.id.localeCompare(b.id))
  return { data: { staff } }
}

export async function deactivateStaff({ db, cryptoContext, actor, staffId, version, idempotencyKey, correlationId, nowMs, idFactory = () => crypto.randomUUID().replaceAll('-', '') } = {}) {
  if (!db?.prepare || actor?.role !== 'owner') throw new Error('FORBIDDEN')
  if (!validId(staffId)) throw new Error('NOT_FOUND')
  if (!Number.isSafeInteger(version) || version < 1) validation('version')
  if (!validId(idempotencyKey)) throw new Error('VALIDATION_FAILED')
  const requestDigest = JSON.stringify({ version }); const idem = { actorId: actor.id, operation: 'staff.deactivate', idempotencyKey, requestDigest, expectedScope: cryptoContext.scope }
  const replay = await inspectIdempotency(db, cryptoContext, idem); if (replay) return replay.body
  const row = await db.prepare('SELECT * FROM staff_users WHERE id=?').bind(staffId).first(); if (!row) throw new Error('NOT_FOUND')
  if (row.version !== version) { const error = new Error('VERSION_CONFLICT'); error.details = { currentVersion: row.version }; throw error }
  const now = iso(nowMs); const staff = { ...row, status: 'disabled', disabled_at: now, version: row.version + 1, updated_at: now }
  const desired = await desiredGenerationStatement(db, now, idFactory)
  const invitation = await db.prepare("SELECT * FROM staff_invitations WHERE staff_id=? AND status IN ('provisioning','pending')").bind(staffId).first()
  const [email, displayName] = await Promise.all([
    decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, { expectedScope: cryptoContext.scope, recordId: row.id, field: 'email', envelope: JSON.parse(row.email_envelope) }),
    decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, { expectedScope: cryptoContext.scope, recordId: row.id, field: 'display_name', envelope: JSON.parse(row.display_name_envelope) }),
  ])
  const body = { data: { staff: publicStaff({ ...staff, displayName, email }) } }
  const statements = [
    db.prepare("UPDATE staff_users SET status='disabled',disabled_at=?,version=version+1,updated_at=? WHERE id=? AND version=?").bind(now, now, staffId, version),
    await versionStatement(db, cryptoContext, staff, 'staff_user', actor.id, now, correlationId, idFactory), desired.statement,
    auditEventStatement(db, { id: idFrom(idFactory), occurredAt: now, actorStaffId: actor.id, action: 'staff.deactivated', entityType: 'staff_user', entityId: staffId, result: 'success', correlationId, metadata: { staffVersion: staff.version, desiredGeneration: desired.generation }, reasonEnvelope: null }),
    await enqueueOutboxStatement(db, cryptoContext, { id: idFrom(idFactory), type: 'staff.access.reconcile', aggregateType: 'access_group', aggregateId: 'centre_1', payload: { generation: desired.generation, actorId: actor.id }, idempotencyKey: `staff.access.reconcile:${desired.generation}`, scheduledAt: now, nowMs }),
    await createIdempotencyStatement(db, cryptoContext, { ...idem, resourceType: 'staff_user', resourceId: staffId, response: { status: 200, body }, createdAt: now, expiresAt: iso(nowMs + 86_400_000) }),
  ]
  if (invitation) statements.splice(1, 0, db.prepare("UPDATE staff_invitations SET status='revoked',revoked_at=?,version=version+1,updated_at=? WHERE id=? AND version=?").bind(now, now, invitation.id, invitation.version))
  try { await db.batch(statements); return body } catch (error) { if (isD1LastActiveOwner(error)) throw new Error('LAST_ACTIVE_OWNER'); throw error }
}
