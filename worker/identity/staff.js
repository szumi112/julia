import { auditEventStatement } from '../audit/events.js'
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
const collision = (error) => /^(?:identity_collision: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?|D1_ERROR: identity_collision: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)$/.test(error?.message ?? '')

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
  return db.prepare(
    `INSERT INTO record_versions
     (id, entity_type, entity_id, version, snapshot_envelope, changed_by_staff_id, changed_at, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(statementId(idFactory), entityType(table), row.id, next.version,
    await encryptedSnapshot(context, table, row, next), changedByStaffId, now, correlationId)
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
      entityType: 'staff_user', entityId: row.id, result: 'denied', correlationId, metadata: { version: row.version },
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
     WHERE id=? AND staff_id=? AND status='pending' AND version=? AND email_lookup IN (${placeholders(candidates)})
       AND expires_at > ? AND access_allowed_at IS NOT NULL AND length(access_allowed_at)>0`
  ).bind(activeLookup, now, now, invitation.id, staff.id, invitation.version, ...candidates, now)
  const statements = [
    staffUpdate,
    invitationUpdate,
    await recordVersionStatement(db, context, 'staff_users', staff, staffNext, { now, correlationId, idFactory, changedByStaffId: staff.id }),
    await recordVersionStatement(db, context, 'staff_invitations', invitation, invitationNext, { now, correlationId, idFactory, changedByStaffId: staff.id }),
    constructor(db, { id: statementId(idFactory), occurredAt: now, actorStaffId: staff.id, action: 'identity.activation', entityType: 'staff_user', entityId: staff.id, result: 'success', correlationId, metadata: { staffVersion: staffNext.version, invitationVersion: invitationNext.version } }),
    guardStatement(db, 'staff_users', staff, { status: 'active', access_subject: principal.subject, email_lookup: activeLookup, version: staffNext.version, activated_at: now }),
    guardStatement(db, 'staff_invitations', invitation, { status: 'activated', email_lookup: activeLookup, version: invitationNext.version, activated_at: now }),
  ]
  await db.batch(statements)
  return asActor(staffNext)
}

async function reindexOne(db, context, table, row, activeLookup, options) {
  if (row.email_lookup === activeLookup) return false
  const now = iso(options.nowMs)
  const next = { ...row, email_lookup: activeLookup, version: row.version + 1, updated_at: now }
  const update = db.prepare(`UPDATE ${table} SET email_lookup=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
    .bind(activeLookup, now, row.id, row.version)
  const statements = [
    update,
    await recordVersionStatement(db, context, table, row, next, { now, correlationId: options.correlationId, idFactory: options.idFactory, changedByStaffId: options.changedByStaffId ?? null }),
    (options.auditEventStatement ?? auditEventStatement)(db, { id: statementId(options.idFactory), occurredAt: now, actorStaffId: options.changedByStaffId ?? null, action: 'identity.reindex', entityType: entityType(table), entityId: row.id, result: 'success', correlationId: options.correlationId, metadata: { version: next.version } }),
    guardStatement(db, table, row, { email_lookup: activeLookup, version: next.version }),
  ]
  try {
    await db.batch(statements)
    return true
  } catch (error) {
    if (!collision(error)) throw error
    const current = await db.prepare(`SELECT id,email_lookup,version FROM ${table} WHERE id=?`).bind(row.id).first()
    if (current?.email_lookup === activeLookup && current.version >= next.version) return false
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
    if (rows.length === 1) await appendDenied(db, rows[0], options)
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
     FROM staff_invitations WHERE staff_id=? AND email_lookup IN (${placeholders(candidates)}) AND status='pending' AND expires_at > ? AND access_allowed_at IS NOT NULL AND length(access_allowed_at)>0`
  ).bind(staff.id, ...candidates, now).all()).results
  if (invitations.length !== 1) {
    await appendDenied(db, staff, options)
    throw denied()
  }
  try {
    return await activate(db, staff, invitations[0], principal, context, { now, candidates, activeLookup }, options)
  } catch (error) {
    const exact = await db.prepare('SELECT id,role,specialist_id,version,status,access_subject FROM staff_users WHERE id=?').bind(staff.id).first()
    if (exact?.status === 'active' && exact.access_subject === principal.subject) return asActor(exact)
    if (!collision(error)) await appendDenied(db, staff, options)
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
