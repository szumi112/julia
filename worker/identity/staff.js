import { auditEventStatement } from '../audit/events.js'
import { isD1IdentityCollision } from '../db/errors.js'
import { areSiblingD1QueryBudgetViews } from '../db/query-budget.js'
import { blindEmailCandidates, blindEmailIndex, decryptForScope, encryptForScope } from '../security/envelope.js'
import {
  prepareSpecialistTransition,
  specialistGuardStatement,
  specialistSnapshotMatches,
} from './specialists.js'

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
const accountLinkId = (factory) => {
  const suffix = statementId(factory)
  const value = `spl_${suffix}`
  if (value.length > 128) throw failure()
  return value
}
const entityType = (table) => table === 'staff_users' ? 'staff_user' : 'staff_invitation'
const collision = isD1IdentityCollision

function recoveryDbFor(db, options) {
  if (options === null || (typeof options !== 'object' && typeof options !== 'function')) throw failure()
  let current = options
  const seen = new Set()
  try {
    for (let depth = 0; current !== null && depth < 64; depth += 1) {
      if (seen.has(current)) throw failure()
      seen.add(current)
      const descriptor = Object.getOwnPropertyDescriptor(current, 'recoveryDb')
      if (descriptor) {
        if (depth !== 0 || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
          || !areSiblingD1QueryBudgetViews(db, descriptor.value)) throw failure()
        return descriptor.value
      }
      current = Object.getPrototypeOf(current)
    }
    if (current !== null) throw failure()
    return db
  } catch {
    throw failure()
  }
}

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

const sameRow = (actual, expected) => actual && expected
  && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => Object.is(actual[key], value))

async function snapshotMatches(context, record, row) {
  try {
    const plaintext = await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope,
      recordId: row.id,
      field: 'record_version',
      envelope: JSON.parse(record.snapshot_envelope),
    })
    return sameRow(JSON.parse(plaintext), row)
  } catch {
    return false
  }
}

const occupiedByTarget = (occupied, target) => !occupied || sameRow(occupied, target)

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

async function recoverActivation(db, context, { staff, invitation, principal, activeLookup, attempt }) {
  const [currentStaff, currentInvitation] = await Promise.all([
    db.prepare('SELECT * FROM staff_users WHERE id=?').bind(staff.id).first(),
    db.prepare('SELECT * FROM staff_invitations WHERE id=?').bind(invitation.id).first(),
  ])
  const activatedAt = currentStaff?.activated_at
  if (typeof activatedAt !== 'string' || currentInvitation?.activated_at !== activatedAt) return null
  const expectedStaff = {
    ...staff, status: 'active', access_subject: principal.subject, email_lookup: activeLookup,
    specialist_id: attempt.specialistId,
    version: staff.version + 1, activated_at: activatedAt, updated_at: activatedAt,
  }
  const expectedInvitation = {
    ...invitation, status: 'activated', email_lookup: activeLookup,
    version: invitation.version + 1, activated_at: activatedAt, updated_at: activatedAt,
  }
  if (!sameRow(currentStaff, expectedStaff) || !sameRow(currentInvitation, expectedInvitation)) return null

  const [staffVersion, invitationVersion] = await Promise.all([
    db.prepare("SELECT * FROM record_versions WHERE entity_type='staff_user' AND entity_id=? AND version=?")
      .bind(staff.id, expectedStaff.version).first(),
    db.prepare("SELECT * FROM record_versions WHERE entity_type='staff_invitation' AND entity_id=? AND version=?")
      .bind(invitation.id, expectedInvitation.version).first(),
  ])
  if (!staffVersion || !invitationVersion
    || staffVersion.changed_by_staff_id !== staff.id || invitationVersion.changed_by_staff_id !== staff.id
    || staffVersion.changed_at !== activatedAt || invitationVersion.changed_at !== activatedAt
    || !id(staffVersion.correlation_id) || invitationVersion.correlation_id !== staffVersion.correlation_id
    || !await snapshotMatches(context, staffVersion, currentStaff)
    || !await snapshotMatches(context, invitationVersion, currentInvitation)) return null

  let specialistVersion = null
  let attemptedSpecialistVersion = null
  if (attempt.specialistVersion !== null) {
    const profile = await db.prepare('SELECT * FROM specialists WHERE id=?').bind(attempt.specialistId).first()
    specialistVersion = await db.prepare(
      "SELECT * FROM record_versions WHERE entity_type='specialist' AND entity_id=? AND version=?"
    ).bind(attempt.specialistId, attempt.specialistVersion).first()
    if (!profile || profile.staff_user_id !== staff.id || profile.status !== 'active'
      || profile.version !== attempt.specialistVersion || profile.archived_at !== null
      || !specialistVersion
      || specialistVersion.changed_by_staff_id !== staff.id
      || specialistVersion.changed_at !== activatedAt
      || specialistVersion.correlation_id !== staffVersion.correlation_id
      || !await specialistSnapshotMatches(context, specialistVersion, profile)) return null
    attemptedSpecialistVersion = await db.prepare(
      'SELECT * FROM record_versions WHERE id=?'
    ).bind(attempt.specialistVersionId).first()
  }
  const metadata = JSON.stringify({
    invitationVersion: expectedInvitation.version,
    specialistVersion: attempt.specialistVersion,
    staffVersion: expectedStaff.version,
  })
  const audits = (await db.prepare(
    `SELECT * FROM audit_events
     WHERE action='identity.activation' AND entity_type='staff_user' AND entity_id=?
       AND result='success' AND metadata_json=?`
  ).bind(staff.id, metadata).all()).results
  if (audits.length !== 1) return null
  const audit = audits[0]
  if (audit.occurred_at !== activatedAt || audit.actor_staff_id !== staff.id || audit.reason_envelope !== null
    || audit.correlation_id !== staffVersion.correlation_id) return null

  const [attemptedStaffVersion, attemptedInvitationVersion, attemptedAudit] = await Promise.all([
    db.prepare('SELECT * FROM record_versions WHERE id=?').bind(attempt.staffVersionId).first(),
    db.prepare('SELECT * FROM record_versions WHERE id=?').bind(attempt.invitationVersionId).first(),
    db.prepare('SELECT * FROM audit_events WHERE id=?').bind(attempt.auditId).first(),
  ])
  if (!occupiedByTarget(attemptedStaffVersion, staffVersion)
    || !occupiedByTarget(attemptedInvitationVersion, invitationVersion)
    || !occupiedByTarget(attemptedSpecialistVersion, specialistVersion)
    || !occupiedByTarget(attemptedAudit, audit)) return null
  return asActor(currentStaff)
}

async function recoverReindex(db, context, table, row, activeLookup, attempt) {
  const current = await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(row.id).first()
  const changedAt = current?.updated_at
  if (typeof changedAt !== 'string') return false
  const expected = { ...row, email_lookup: activeLookup, version: row.version + 1, updated_at: changedAt }
  if (!sameRow(current, expected)) return false

  const type = entityType(table)
  const record = await db.prepare(
    'SELECT * FROM record_versions WHERE entity_type=? AND entity_id=? AND version=?'
  ).bind(type, row.id, expected.version).first()
  const validChanger = table === 'staff_users'
    ? record?.changed_by_staff_id === null || record?.changed_by_staff_id === row.id
    : record?.changed_by_staff_id === null
  if (!record || !validChanger || record.changed_at !== changedAt || !id(record.correlation_id)
    || !await snapshotMatches(context, record, current)) return false

  const audits = (await db.prepare(
    `SELECT * FROM audit_events
     WHERE action='identity.reindex' AND entity_type=? AND entity_id=?
       AND result='success' AND metadata_json=?`
  ).bind(type, row.id, JSON.stringify({ version: expected.version })).all()).results
  if (audits.length !== 1) return false
  const audit = audits[0]
  if (audit.occurred_at !== changedAt || audit.actor_staff_id !== record.changed_by_staff_id
    || audit.reason_envelope !== null || audit.correlation_id !== record.correlation_id) return false

  const [attemptedVersion, attemptedAudit] = await Promise.all([
    db.prepare('SELECT * FROM record_versions WHERE id=?').bind(attempt.versionId).first(),
    db.prepare('SELECT * FROM audit_events WHERE id=?').bind(attempt.auditId).first(),
  ])
  return occupiedByTarget(attemptedVersion, record) && occupiedByTarget(attemptedAudit, audit)
}

async function matchingStaff(db, candidates) {
  return (await db.prepare(
    `SELECT id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at
     FROM staff_users WHERE email_lookup IN (${placeholders(candidates)})`
  ).bind(...candidates).all()).results
}

async function hasSpecialistAccountLinks(db) {
  const row = await db.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name='specialist_account_links'",
  ).first()
  return row?.name === 'specialist_account_links'
}

async function activeForSubject(db, subject) {
  return (await db.prepare(
    `SELECT id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at
     FROM staff_users WHERE access_subject = ?`
  ).bind(subject).all()).results
}

async function activate(db, staff, invitation, principal, context, values, options, recovery) {
  const { now, candidates, activeLookup } = values
  const { correlationId, idFactory, auditEventStatement: constructor = auditEventStatement } = options
  let staffNext = { ...staff, status: 'active', access_subject: principal.subject, email_lookup: activeLookup, version: staff.version + 1, activated_at: now, updated_at: now }
  const invitationNext = { ...invitation, status: 'activated', email_lookup: activeLookup, version: invitation.version + 1, activated_at: now, updated_at: now }
  const specialist = await prepareSpecialistTransition({
    db,
    cryptoContext: context,
    currentStaff: staff,
    nextStaff: staffNext,
    changedByStaffId: staff.id,
    now,
    correlationId,
    idFactory,
  })
  staffNext = specialist.staff
  const staffUpdate = db.prepare(
    `UPDATE staff_users SET status='active',access_subject=?,email_lookup=?,specialist_id=?,activated_at=?,version=version+1,updated_at=?
     WHERE id=? AND status='pending' AND access_subject IS NULL AND version=? AND email_lookup IN (${placeholders(candidates)})`
  ).bind(principal.subject, activeLookup, staffNext.specialist_id, now, now, staff.id, staff.version, ...candidates)
  const invitationUpdate = db.prepare(
    `UPDATE staff_invitations SET status='activated',email_lookup=?,activated_at=?,version=version+1,updated_at=?
     WHERE id=? AND staff_id=? AND role=? AND status='pending' AND version=? AND email_lookup IN (${placeholders(candidates)})
       AND expires_at > ? AND access_allowed_at IS NOT NULL AND length(access_allowed_at)>0`
  ).bind(activeLookup, now, now, invitation.id, staff.id, staff.role, invitation.version, ...candidates, now)
  const staffVersion = await recordVersionStatement(db, context, 'staff_users', staff, staffNext, { now, correlationId, idFactory, changedByStaffId: staff.id })
  const invitationVersion = await recordVersionStatement(db, context, 'staff_invitations', invitation, invitationNext, { now, correlationId, idFactory, changedByStaffId: staff.id })
  const linkStatement = specialist.specialistId !== null
    && specialist.specialistVersion !== null
    && await hasSpecialistAccountLinks(db)
    ? db.prepare(
        `INSERT INTO specialist_account_links
         (id,specialist_id,staff_user_id,lifecycle,changed_by_staff_id,version,created_at)
         VALUES (?,?,?,'activated',?,?,?)`,
      ).bind(
        accountLinkId(idFactory),
        specialist.specialistId,
        staff.id,
        staff.id,
        specialist.specialistVersion,
        now,
      )
    : null
  const auditId = statementId(idFactory)
  recovery.attempt = Object.freeze({
    staffVersionId: staffVersion.id,
    invitationVersionId: invitationVersion.id,
    specialistId: specialist.specialistId,
    specialistVersion: specialist.specialistVersion,
    specialistVersionId: specialist.versionId ?? null,
    auditId,
  })
  const statements = [
    ...(specialist.domainStatement ? [specialist.domainStatement] : []),
    ...(specialist.versionStatement ? [specialist.versionStatement] : []),
    ...(linkStatement ? [linkStatement] : []),
    staffUpdate,
    invitationUpdate,
    staffVersion.statement,
    invitationVersion.statement,
    constructor(db, { id: auditId, occurredAt: now, actorStaffId: staff.id, action: 'identity.activation', entityType: 'staff_user', entityId: staff.id, result: 'success', correlationId, metadata: { staffVersion: staffNext.version, invitationVersion: invitationNext.version, specialistVersion: specialist.specialistVersion }, reasonEnvelope: null }),
    guardStatement(db, 'staff_users', staff, { status: 'active', access_subject: principal.subject, email_lookup: activeLookup, version: staffNext.version, activated_at: now }),
    guardStatement(db, 'staff_invitations', invitation, { status: 'activated', email_lookup: activeLookup, version: invitationNext.version, activated_at: now }),
    specialistGuardStatement(db, staff.id),
  ]
  await db.batch(statements)
  return asActor(staffNext)
}

async function reindexOne(db, context, table, row, activeLookup, options, recoveryDb = db, changedByStaffId = options.changedByStaffId ?? null) {
  if (row.email_lookup === activeLookup) return false
  const now = iso(options.nowMs)
  const next = { ...row, email_lookup: activeLookup, version: row.version + 1, updated_at: now }
  const update = db.prepare(`UPDATE ${table} SET email_lookup=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
    .bind(activeLookup, now, row.id, row.version)
  const version = await recordVersionStatement(db, context, table, row, next, { now, correlationId: options.correlationId, idFactory: options.idFactory, changedByStaffId })
  const auditId = statementId(options.idFactory)
  const attempt = Object.freeze({ versionId: version.id, auditId })
  const statements = [
    update,
    version.statement,
    (options.auditEventStatement ?? auditEventStatement)(db, { id: auditId, occurredAt: now, actorStaffId: changedByStaffId, action: 'identity.reindex', entityType: entityType(table), entityId: row.id, result: 'success', correlationId: options.correlationId, metadata: { version: next.version }, reasonEnvelope: null }),
    guardStatement(db, table, row, { email_lookup: activeLookup, version: next.version }),
  ]
  try {
    await db.batch(statements)
    return true
  } catch (error) {
    if (!collision(error)) throw failure()
    try {
      if (await recoverReindex(recoveryDb, context, table, row, activeLookup, attempt)) return false
    } catch {
      throw failure()
    }
    throw failure()
  }
}

async function resolveActorInternal(db, principal, cryptoContext, options, recoveryDb) {
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
      try { await reindexOne(db, context, 'staff_users', staff, activeLookup, options, recoveryDb, staff.id) } catch { throw denied() }
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
  const recovery = {}
  try {
    return await activate(db, staff, invitations[0], principal, context, { now, candidates, activeLookup }, options, recovery)
  } catch (error) {
    if (!collision(error)) throw error
    try {
      const actor = recovery.attempt && await recoverActivation(recoveryDb, context, {
        staff, invitation: invitations[0], principal, activeLookup, attempt: recovery.attempt,
      })
      if (actor) return actor
    } catch {
      throw failure()
    }
    throw denied()
  }
}

export async function resolveActor(db, principal, cryptoContext, options = {}) {
  try {
    return await resolveActorInternal(db, principal, cryptoContext, options, recoveryDbFor(db, options))
  } catch (error) {
    if (error?.message === 'ACCESS_DENIED') throw denied()
    if (error?.message === 'IDENTITY_FAILURE') throw failure()
    throw failure()
  }
}

export async function resolveActiveActorReadOnly(db, principal, cryptoContext) {
  try {
    const context = requireContext(cryptoContext)
    if (!db?.prepare || principal?.kind !== 'human'
      || typeof principal.subject !== 'string' || !principal.subject
      || typeof principal.normalizedEmail !== 'string' || !principal.normalizedEmail) {
      throw denied()
    }
    const activeLookup = await blindEmailIndex(principal.normalizedEmail, context.keyring)
    const row = await db.prepare(
      `SELECT id,role,specialist_id,version
       FROM staff_users
       WHERE email_lookup=? AND access_subject=? AND status='active'`,
    ).bind(activeLookup, principal.subject).first()
    if (!row) throw denied()
    return asActor(row)
  } catch (error) {
    if (error?.message === 'ACCESS_DENIED') throw denied()
    if (error?.message === 'IDENTITY_FAILURE') throw failure()
    throw failure()
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
