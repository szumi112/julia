import { auditEventStatement } from '../audit/events.js'
import { isD1IdentityCollision } from '../db/errors.js'
import { blindEmailCandidates, blindEmailIndex, decryptForScope, encryptForScope } from '../security/envelope.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const tables = new Set(['staff_users', 'staff_invitations'])
const denied = () => new Error('ACCESS_DENIED')
const failure = () => new Error('IDENTITY_FAILURE')
const iso = (nowMs) => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw failure()
  return new Date(nowMs).toISOString()
}
const id = (value) => typeof value === 'string' && ID.test(value)
const asActor = (row) => Object.freeze({ id: row.id, role: row.role, specialistId: row.specialist_id, version: row.version })
const placeholders = (items) => items.map(() => '?').join(', ')
const statementId = (factory) => {
  const value = factory?.()
  if (!id(value)) throw failure()
  return value
}
const entityType = (table) => table === 'staff_users' ? 'staff_user' : 'staff_invitation'
const collision = isD1IdentityCollision

function requireContext(context) {
  if (!context?.keyring || !context?.dataKey || !context?.scope) throw failure()
  return context
}

async function encryptedSnapshot(context, table, row, next) {
  const value = JSON.stringify({ ...row, ...next })
  return JSON.stringify(await encryptForScope(context.keyring, context.dataKey, {
    expectedScope: context.scope, recordId: row.id, field: 'record_version', plaintext: value,
  }))
}

async function recordVersionStatement(db, context, table, row, next, { now, correlationId, idFactory, changedByStaffId = null }) {
  const recordId = statementId(idFactory)
  return { id: recordId, statement: db.prepare(
    `INSERT INTO record_versions
     (id, entity_type, entity_id, version, snapshot_envelope, changed_by_staff_id, changed_at, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(recordId, entityType(table), row.id, next.version,
    await encryptedSnapshot(context, table, row, next), changedByStaffId, now, correlationId) }
}

function guardStatement(db, table, row, expected) {
  const columns = table === 'staff_users'
    ? 'id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at'
    : 'id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,inviter_id,expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,version,created_at,updated_at'
  const terms = Object.entries(expected).map(([key]) => `${key} = ?`).join(' AND ')
  return db.prepare(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table} WHERE id = ? AND NOT (${terms})`)
    .bind(row.id, ...Object.values(expected))
}

async function appendDenied(db, row, { nowMs, correlationId, idFactory, auditEventStatement: constructor = auditEventStatement }) {
  if (!row || !id(row.id)) return
  const now = iso(nowMs)
  try {
    await constructor(db, {
      id: statementId(idFactory), occurredAt: now, actorStaffId: row.id, action: 'identity.denied',
      entityType: 'staff_user', entityId: row.id, result: 'denied', correlationId, metadata: { version: row.version }, reasonEnvelope: null,
    }).run()
  } catch { /* A denial must never disclose an internal storage error. */ }
}

async function matchingStaff(db, candidates) {
  return (await db.prepare(
    `SELECT id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at
     FROM staff_users WHERE email_lookup IN (${placeholders(candidates)})`
  ).bind(...candidates).all()).results
}

async function activeForSubject(db, subject) {
  return (await db.prepare(
    `SELECT id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at
     FROM staff_users WHERE access_subject = ?`
  ).bind(subject).all()).results
}

async function activate(db, staff, invitation, principal, context, values, options) {
  const { now, candidates, activeLookup } = values
  const { correlationId, idFactory, auditEventStatement: constructor = auditEventStatement } = options
  const staffNext = { ...staff, status: 'active', access_subject: principal.subject, email_lookup: activeLookup, version: staff.version + 1, activated_at: now, updated_at: now }
  const invitationNext = { ...invitation, status: 'activated', email_lookup: activeLookup, version: invitation.version + 1, activated_at: now, updated_at: now }
  const staffUpdate = db.prepare(
    `UPDATE staff_users SET status='active',access_subject=?,email_lookup=?,activated_at=?,version=version+1,updated_at=?
     WHERE id=? AND status='pending' AND access_subject IS NULL AND version=? AND email_lookup IN (${placeholders(candidates)})`
  ).bind(principal.subject, activeLookup, now, now, staff.id, staff.version, ...candidates)
  const invitationUpdate = db.prepare(
    `UPDATE staff_invitations SET status='activated',email_lookup=?,activated_at=?,version=version+1,updated_at=?
     WHERE id=? AND staff_id=? AND role=? AND status='pending' AND version=? AND email_lookup IN (${placeholders(candidates)})
       AND expires_at > ? AND access_allowed_at IS NOT NULL AND length(access_allowed_at)>0`
  ).bind(activeLookup, now, now, invitation.id, staff.id, staff.role, invitation.version, ...candidates, now)
  const staffVersion = await recordVersionStatement(db, context, 'staff_users', staff, staffNext, { now, correlationId, idFactory, changedByStaffId: staff.id })
  const invitationVersion = await recordVersionStatement(db, context, 'staff_invitations', invitation, invitationNext, { now, correlationId, idFactory, changedByStaffId: staff.id })
  const auditId = statementId(idFactory)
  const statements = [
    staffUpdate,
    invitationUpdate,
    staffVersion.statement,
    invitationVersion.statement,
    constructor(db, { id: auditId, occurredAt: now, actorStaffId: staff.id, action: 'identity.activation', entityType: 'staff_user', entityId: staff.id, result: 'success', correlationId, metadata: { staffVersion: staffNext.version, invitationVersion: invitationNext.version }, reasonEnvelope: null }),
    guardStatement(db, 'staff_users', staff, { status: 'active', access_subject: principal.subject, email_lookup: activeLookup, version: staffNext.version, activated_at: now }),
    guardStatement(db, 'staff_invitations', invitation, { status: 'activated', email_lookup: activeLookup, version: invitationNext.version, activated_at: now }),
  ]
  try { await db.batch(statements) } catch (error) {
    error.identityAttempt = { staffVersionId: staffVersion.id, invitationVersionId: invitationVersion.id, auditId, staffNext, invitationNext, correlationId }
    throw error
  }
  return asActor(staffNext)
}

async function reindexOne(db, context, table, row, activeLookup, options) {
  if (row.email_lookup === activeLookup) return false
  const now = iso(options.nowMs)
  const next = { ...row, email_lookup: activeLookup, version: row.version + 1, updated_at: now }
  const update = db.prepare(`UPDATE ${table} SET email_lookup=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
    .bind(activeLookup, now, row.id, row.version)
  const version = await recordVersionStatement(db, context, table, row, next, { now, correlationId: options.correlationId, idFactory: options.idFactory, changedByStaffId: options.changedByStaffId ?? null })
  const auditId = statementId(options.idFactory)
  const statements = [
    update,
    version.statement,
    (options.auditEventStatement ?? auditEventStatement)(db, { id: auditId, occurredAt: now, actorStaffId: options.changedByStaffId ?? null, action: 'identity.reindex', entityType: entityType(table), entityId: row.id, result: 'success', correlationId: options.correlationId, metadata: { version: next.version }, reasonEnvelope: null }),
    guardStatement(db, table, row, { email_lookup: activeLookup, version: next.version }),
  ]
  try {
    await db.batch(statements)
    return true
  } catch (error) {
    if (!collision(error)) throw error
    const current = await db.prepare(`SELECT id,email_lookup,version FROM ${table} WHERE id=?`).bind(row.id).first()
    const record = await db.prepare('SELECT entity_type,entity_id,version FROM record_versions WHERE id=?').bind(version.id).first()
    const audit = await db.prepare('SELECT action,entity_type,entity_id,result,correlation_id FROM audit_events WHERE id=?').bind(auditId).first()
    if (current?.email_lookup === activeLookup && current.version === next.version
      && record?.entity_type === entityType(table) && record.entity_id === row.id && record.version === next.version
      && audit?.action === 'identity.reindex' && audit.entity_type === entityType(table) && audit.entity_id === row.id && audit.result === 'success' && audit.correlation_id === options.correlationId) return false
    throw error
  }
}

export async function resolveActor(db, principal, cryptoContext, options = {}) {
  const context = requireContext(cryptoContext)
  if (!db?.prepare || principal?.kind !== 'human' || typeof principal.subject !== 'string' || !principal.subject || typeof principal.normalizedEmail !== 'string' || !principal.normalizedEmail) throw denied()
  const candidates = await blindEmailCandidates(principal.normalizedEmail, context.keyring)
  const now = iso(options.nowMs)
  const [rows, boundRows] = await Promise.all([matchingStaff(db, candidates), activeForSubject(db, principal.subject)])
  if (rows.length !== 1 || boundRows.some((row) => row.id !== rows[0]?.id)) {
    const identified = rows.length === 1 ? rows[0] : boundRows.length === 1 ? boundRows[0] : null
    if (identified) await appendDenied(db, identified, options)
    throw denied()
  }
  const staff = rows[0]
  if (staff.status === 'disabled') {
    await appendDenied(db, staff, options)
    throw denied()
  }
  const activeLookup = await blindEmailIndex(principal.normalizedEmail, context.keyring)
  if (staff.status === 'active') {
    if (staff.access_subject !== principal.subject) {
      await appendDenied(db, staff, options)
      throw denied()
    }
    if (staff.email_lookup !== activeLookup) {
      try { await reindexOne(db, context, 'staff_users', staff, activeLookup, { ...options, changedByStaffId: staff.id }) } catch { throw denied() }
      const current = await db.prepare('SELECT id,role,specialist_id,version,access_subject,status FROM staff_users WHERE id=?').bind(staff.id).first()
      if (!current || current.status !== 'active' || current.access_subject !== principal.subject) throw denied()
      return asActor(current)
    }
    return asActor(staff)
  }
  if (staff.status !== 'pending' || staff.access_subject !== null) {
    await appendDenied(db, staff, options)
    throw denied()
  }
  const invitations = (await db.prepare(
    `SELECT id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,inviter_id,expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,version,created_at,updated_at
     FROM staff_invitations WHERE staff_id=? AND role=? AND email_lookup IN (${placeholders(candidates)}) AND status='pending' AND expires_at > ? AND access_allowed_at IS NOT NULL AND length(access_allowed_at)>0`
  ).bind(staff.id, staff.role, ...candidates, now).all()).results
  if (invitations.length !== 1) {
    await appendDenied(db, staff, options)
    throw denied()
  }
  try {
    return await activate(db, staff, invitations[0], principal, context, { now, candidates, activeLookup }, options)
  } catch (error) {
    const exact = await db.prepare('SELECT id,role,specialist_id,version,status,access_subject,email_lookup,activated_at FROM staff_users WHERE id=?').bind(staff.id).first()
    const attempt = error.identityAttempt
    const exactInvitation = collision(error)
      ? await db.prepare('SELECT id,status,email_lookup,version,activated_at FROM staff_invitations WHERE id=?').bind(invitations[0].id).first()
      : null
    const staffVersion = attempt && await db.prepare("SELECT id FROM record_versions WHERE entity_type='staff_user' AND entity_id=? AND version=?").bind(staff.id, attempt.staffNext.version).first()
    const invitationVersion = attempt && await db.prepare("SELECT id FROM record_versions WHERE entity_type='staff_invitation' AND entity_id=? AND version=?").bind(invitations[0].id, attempt.invitationNext.version).first()
    const audit = attempt && await db.prepare("SELECT id FROM audit_events WHERE action='identity.activation' AND entity_type='staff_user' AND entity_id=? AND result='success'").bind(staff.id).first()
    const attemptedStaffVersion = attempt && await db.prepare('SELECT entity_type,entity_id,version FROM record_versions WHERE id=?').bind(attempt.staffVersionId).first()
    const attemptedInvitationVersion = attempt && await db.prepare('SELECT entity_type,entity_id,version FROM record_versions WHERE id=?').bind(attempt.invitationVersionId).first()
    const attemptedAudit = attempt && await db.prepare('SELECT action,entity_type,entity_id,result FROM audit_events WHERE id=?').bind(attempt.auditId).first()
    if (collision(error) && attempt && exact?.status === 'active' && exact.access_subject === principal.subject
      && exact.version === staff.version + 1 && exactInvitation?.status === 'activated'
      && exact.email_lookup === activeLookup && exact.activated_at === attempt.staffNext.activated_at
      && exactInvitation.email_lookup === activeLookup && exactInvitation.version === invitations[0].version + 1 && exactInvitation.activated_at === attempt.invitationNext.activated_at
      && staffVersion && invitationVersion && audit
      && (!attemptedStaffVersion || attemptedStaffVersion.entity_type === 'staff_user' && attemptedStaffVersion.entity_id === staff.id && attemptedStaffVersion.version === attempt.staffNext.version)
      && (!attemptedInvitationVersion || attemptedInvitationVersion.entity_type === 'staff_invitation' && attemptedInvitationVersion.entity_id === invitations[0].id && attemptedInvitationVersion.version === attempt.invitationNext.version)
      && (!attemptedAudit || attemptedAudit.action === 'identity.activation' && attemptedAudit.entity_type === 'staff_user' && attemptedAudit.entity_id === staff.id && attemptedAudit.result === 'success')) return asActor(exact)
    if (!collision(error)) throw error
    throw denied()
  }
}

export async function reindexEmailLookupsBatch(db, cryptoContext, options = {}) {
  const context = requireContext(cryptoContext)
  const { table, afterId = '', limit, nowMs, correlationId, idFactory } = options
  if (!tables.has(table) || (afterId !== '' && !id(afterId)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !id(correlationId)) throw failure()
  const rows = (await db.prepare(`SELECT * FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`).bind(afterId, limit).all()).results
  let changed = 0
  for (const row of rows) {
    let envelope
    try { envelope = JSON.parse(row.email_envelope) } catch { throw failure() }
    const email = await decryptForScope(context.keyring, context.dataKey, { expectedScope: context.scope, recordId: row.id, field: 'email', envelope })
    const activeLookup = await blindEmailIndex(email, context.keyring)
    if (await reindexOne(db, context, table, row, activeLookup, options)) changed += 1
  }
  return Object.freeze({ afterId: rows.at(-1)?.id ?? afterId, scanned: rows.length, changed, done: rows.length < limit })
}

export async function verifyNoOldEmailLookups(db, cryptoContext) {
  const context = requireContext(cryptoContext)
  const active = context.keyring.activeLookupKeyVersion
  if (!Number.isSafeInteger(active) || active < 1) throw failure()
  const old = context.keyring.lookupKeyVersions.filter((version) => version !== active)
  if (!old.length) return Object.freeze({ complete: true, count: 0 })
  const clauses = old.map(() => 'email_lookup LIKE ?').join(' OR ')
  const [staff, invitations] = await Promise.all(['staff_users', 'staff_invitations'].map(async (table) => (
    await db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${clauses}`).bind(...old.map((version) => `v${version}:%`)).first()
  )))
  const count = staff.count + invitations.count
  return Object.freeze({ complete: count === 0, count })
}
