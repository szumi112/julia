import { auditEventStatement, encryptAuditReason } from '../audit/events.js'
import { isD1IdentityCollision, isD1LastActiveOwner } from '../db/errors.js'
import {
  commitRateLimitedMutation,
  createIdempotencyStatement,
  createUnitOfWork,
  inspectIdempotency,
  rateLimitGuardStatement,
  recoverIdempotencyAfterCollision,
} from '../db/unit-of-work.js'
import { blindEmailCandidates, blindEmailIndex, decryptForScope, encryptForScope } from '../security/envelope.js'
import { enqueueOutboxStatement } from '../jobs/outbox.js'
import { authorize } from './policy.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const INVITATION_RATE_LIMIT = 5
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const roles = new Set(['owner', 'coordinator', 'specialist'])
const exactObject = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const validId = (value) => typeof value === 'string' && ID.test(value)
const iso = (nowMs) => new Date(nowMs).toISOString()
const idFrom = (factory) => { const value = factory(); if (!validId(value)) throw new Error('INTERNAL_ERROR'); return value }
const prefixedIdFrom = (prefix, factory) => {
  const value = `${prefix}_${idFrom(factory)}`
  if (!validId(value)) throw new Error('INTERNAL_ERROR')
  return value
}
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
async function versionRecord(db, context, row, entityType, changedBy, now, correlationId, idFactory) {
  const id = idFrom(idFactory)
  return {
    id,
    statement: db.prepare('INSERT INTO record_versions (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, entityType, row.id, row.version, await envelope(context, row.id, 'record_version', JSON.stringify(row)), changedBy, now, correlationId),
  }
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
  return {
    generation,
    priorVersion: current.version,
    statement: db.prepare('UPDATE system_state SET value_json=?,version=version+1,updated_at=? WHERE key=? AND version=?')
      .bind(JSON.stringify({ generation }), now, current.key, current.version),
  }
}
async function matchingIdentityRows(db, context, email) {
  const candidates = await blindEmailCandidates(email, context.keyring)
  const placeholders = candidates.map(() => '?').join(',')
  const [staff, invitations] = await Promise.all([
    db.prepare(`SELECT * FROM staff_users WHERE email_lookup IN (${placeholders})`)
      .bind(...candidates).all(),
    db.prepare(`SELECT id,staff_id,email_envelope FROM staff_invitations WHERE email_lookup IN (${placeholders})`)
      .bind(...candidates).all(),
  ])
  const exactStaffIds = new Set()
  for (const row of staff.results) {
    try {
      const value = await decryptForScope(context.keyring, context.dataKey, { expectedScope: context.scope, recordId: row.id, field: 'email', envelope: JSON.parse(row.email_envelope) })
      if (value === email) exactStaffIds.add(row.id)
    } catch { throw new Error('CRYPTO_FAILURE') }
  }
  for (const row of invitations.results) {
    try {
      const value = await decryptForScope(context.keyring, context.dataKey, { expectedScope: context.scope, recordId: row.id, field: 'email', envelope: JSON.parse(row.email_envelope) })
      if (value === email) exactStaffIds.add(row.staff_id)
    } catch { throw new Error('CRYPTO_FAILURE') }
  }
  const rowsById = new Map(staff.results.map((row) => [row.id, row]))
  const missingIds = [...exactStaffIds].filter((id) => !rowsById.has(id))
  if (missingIds.length) {
    const linked = (await db.prepare(
      `SELECT * FROM staff_users WHERE id IN (${missingIds.map(() => '?').join(',')})`
    ).bind(...missingIds).all()).results
    for (const row of linked) rowsById.set(row.id, row)
  }
  if ([...exactStaffIds].some((id) => !rowsById.has(id))) throw new Error('INTERNAL_ERROR')
  return [...exactStaffIds].map((id) => rowsById.get(id))
}

async function retainedIdentity(db, context, email, now) {
  const matches = await matchingIdentityRows(db, context, email)
  if (matches.length > 1) throw new Error('STAFF_INVITATION_CONFLICT')
  const staff = matches[0] ?? null
  if (!staff) return { staff: null, expiredOpen: null }
  const invitations = (await db.prepare(
    'SELECT * FROM staff_invitations WHERE staff_id=? ORDER BY created_at,id'
  ).bind(staff.id).all()).results
  const open = invitations.filter(({ status }) => ['provisioning', 'pending'].includes(status))
  if (staff.status === 'active' || open.length > 1) {
    throw new Error('STAFF_INVITATION_CONFLICT')
  }
  if (open.length === 1 && open[0].expires_at > now) {
    throw new Error('STAFF_INVITATION_CONFLICT')
  }
  const expiredOpen = open[0] ?? null
  if (staff.status === 'disabled' && !expiredOpen) return { staff, expiredOpen: null }
  const terminalPreActivation = invitations.length > 0 && invitations.every((invitation) => (
    ['expired', 'revoked'].includes(invitation.status)
      || invitation.id === expiredOpen?.id
  ))
  if (staff.status !== 'pending' || !terminalPreActivation
    || (expiredOpen && expiredOpen.expires_at > now)) {
    throw new Error('STAFF_INVITATION_CONFLICT')
  }
  return { staff, expiredOpen }
}

async function activeOwner(db, actor, nowMs) {
  if (!validId(actor?.id) || !Number.isSafeInteger(actor.version)
    || !authorize(actor, 'staff.manage', CENTRE, { nowMs })) throw new Error('FORBIDDEN')
  const row = await db.prepare(
    `SELECT id,role,specialist_id,version
     FROM staff_users
     WHERE id=? AND role='owner' AND status='active' AND version=?`
  ).bind(actor.id, actor.version).first()
  if (!row || !authorize({
    id: row.id,
    role: row.role,
    specialistId: row.specialist_id,
    version: row.version,
  }, 'staff.manage', CENTRE, { nowMs })) throw new Error('FORBIDDEN')
  return row
}

export async function inviteStaff({ db, cryptoContext, actor, input, idempotencyKey, correlationId, nowMs, dataMode, idFactory = () => crypto.randomUUID().replaceAll('-', '') } = {}) {
  if (!db?.prepare || !db?.batch || !cryptoContext?.keyring || !cryptoContext?.dataKey
    || !cryptoContext?.scope || !validId(correlationId) || !Number.isSafeInteger(nowMs)
    || nowMs < 0 || !IDEMPOTENCY_KEY.test(idempotencyKey ?? '')) throw new Error('VALIDATION_FAILED')
  const owner = await activeOwner(db, actor, nowMs)
  const request = validateInvitationInput(input, { dataMode })
  const requestDigest = JSON.stringify({
    displayName: request.displayName,
    email: request.email,
    role: request.role,
  })
  const idem = {
    actorId: owner.id,
    operation: 'staff.invite',
    idempotencyKey,
    requestDigest,
    expectedScope: cryptoContext.scope,
  }
  const replay = await inspectIdempotency(db, cryptoContext, idem)
  if (replay) return replay.body
  const now = iso(nowMs)
  const retained = await retainedIdentity(db, cryptoContext, request.email, now)
  const reused = retained.staff
  const expiresAt = iso(nowMs + 7 * DAY_MS)
  const staffId = reused?.id ?? prefixedIdFrom('stf', idFactory)
  const invitationId = prefixedIdFrom('inv', idFactory)
  const lookup = await blindEmailIndex(request.email, cryptoContext.keyring)
  const staff = {
    ...(reused ?? {}),
    id: staffId,
    email_lookup: lookup,
    email_envelope: await envelope(cryptoContext, staffId, 'email', request.email),
    display_name_envelope: await envelope(cryptoContext, staffId, 'display_name', request.displayName), role: request.role,
    status: 'pending', access_subject: null, specialist_id: request.role === 'specialist' ? specialistIdFor(staffId) : null,
    version: reused ? reused.version + 1 : 1,
    activated_at: null,
    disabled_at: null,
    created_at: reused?.created_at ?? now,
    updated_at: now,
  }
  const invitation = {
    id: invitationId,
    staff_id: staffId,
    email_lookup: lookup,
    email_envelope: await envelope(cryptoContext, invitationId, 'email', request.email),
    display_name_envelope: await envelope(cryptoContext, invitationId, 'display_name', request.displayName),
    role: request.role,
    status: 'provisioning',
    inviter_id: owner.id,
    expires_at: expiresAt,
    access_allowed_at: null,
    email_sent_at: null,
    activated_at: null,
    revoked_at: null,
    version: 1,
    created_at: now,
    updated_at: now,
  }
  const expiredOpen = retained.expiredOpen
    ? {
        ...retained.expiredOpen,
        status: 'expired',
        version: retained.expiredOpen.version + 1,
        updated_at: now,
      }
    : null
  const desired = await desiredGenerationStatement(db, now, idFactory)
  const body = {
    data: {
      staff: publicStaff({ ...staff, displayName: request.displayName, email: request.email }),
      invitation: publicInvitation(invitation),
    },
  }
  const staffVersion = await versionRecord(
    db, cryptoContext, staff, 'staff_user', owner.id, now, correlationId, idFactory,
  )
  const invitationVersion = await versionRecord(
    db, cryptoContext, invitation, 'staff_invitation', owner.id, now, correlationId, idFactory,
  )
  const expiredOpenVersion = expiredOpen
    ? await versionRecord(
        db,
        cryptoContext,
        expiredOpen,
        'staff_invitation',
        owner.id,
        now,
        correlationId,
        idFactory,
      )
    : null
  const auditId = idFrom(idFactory)
  const reconcileId = idFrom(idFactory)
  const expiryJobId = idFrom(idFactory)
  const denialAuditId = idFrom(idFactory)
  const reconcileKey = `staff.access.reconcile:${desired.generation}`
  const expiryKey = `staff.invitation.expire:${invitationId}`
  const primaryAudit = auditEventStatement(db, {
    id: auditId,
    occurredAt: now,
    actorStaffId: owner.id,
    action: 'staff.invited',
    entityType: 'staff_invitation',
    entityId: invitationId,
    result: 'success',
    correlationId,
    metadata: {
      staffVersion: staff.version,
      invitationVersion: invitation.version,
      desiredGeneration: desired.generation,
    },
    reasonEnvelope: null,
  })
  const denialAudit = auditEventStatement(db, {
    id: denialAuditId,
    occurredAt: now,
    actorStaffId: owner.id,
    action: 'authorization.denied',
    entityType: 'staff_user',
    entityId: owner.id,
    result: 'denied',
    correlationId,
    metadata: { version: owner.version },
    reasonEnvelope: await encryptAuditReason({
      keyring: cryptoContext.keyring,
      dataKey: cryptoContext.dataKey,
      expectedScope: cryptoContext.scope,
      auditEventId: denialAuditId,
      plaintext: 'staff invitation rate limit',
    }),
  })
  const uow = createUnitOfWork(db, {
    mode: 'mutation',
    actorId: owner.id,
    correlationId,
  })
  if (expiredOpen) {
    uow.domain(
      db.prepare(
        `UPDATE staff_invitations
         SET status='expired',version=version+1,updated_at=?
         WHERE id=? AND staff_id=? AND version=?
           AND status IN ('provisioning','pending') AND expires_at<=?`
      ).bind(
        now,
        expiredOpen.id,
        expiredOpen.staff_id,
        retained.expiredOpen.version,
        now,
      )
    )
    uow.version(expiredOpenVersion.statement)
  }
  if (reused) {
    uow.domain(
      db.prepare(
        `UPDATE staff_users
         SET email_lookup=?,email_envelope=?,display_name_envelope=?,role=?,
             status='pending',access_subject=NULL,specialist_id=?,
             activated_at=NULL,disabled_at=NULL,version=version+1,updated_at=?
         WHERE id=? AND version=? AND status=?`
      ).bind(
        staff.email_lookup,
        staff.email_envelope,
        staff.display_name_envelope,
        staff.role,
        staff.specialist_id,
        now,
        reused.id,
        reused.version,
        reused.status,
      )
    )
    uow.domain(
      db.prepare(
        `INSERT INTO staff_invitations
         (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,
          inviter_id,expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,
          version,created_at,updated_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`
      ).bind(...Object.values(plain(invitation, [
        'id', 'staff_id', 'email_lookup', 'email_envelope', 'display_name_envelope',
        'role', 'status', 'inviter_id', 'expires_at', 'access_allowed_at',
        'email_sent_at', 'activated_at', 'revoked_at', 'version', 'created_at',
        'updated_at',
      ])))
    )
  } else {
    uow.domain(
      db.prepare('INSERT INTO staff_users (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(...Object.values(plain(staff, ['id', 'email_lookup', 'email_envelope', 'display_name_envelope', 'role', 'status', 'access_subject', 'specialist_id', 'version', 'activated_at', 'disabled_at', 'created_at', 'updated_at'])))
    )
    uow.domain(
      db.prepare('INSERT INTO staff_invitations (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,inviter_id,expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(...Object.values(plain(invitation, ['id', 'staff_id', 'email_lookup', 'email_envelope', 'display_name_envelope', 'role', 'status', 'inviter_id', 'expires_at', 'access_allowed_at', 'email_sent_at', 'activated_at', 'revoked_at', 'version', 'created_at', 'updated_at'])))
    )
  }
  uow.version(staffVersion.statement)
  uow.version(invitationVersion.statement)
  uow.domain(desired.statement)
  uow.outbox(await enqueueOutboxStatement(db, cryptoContext, {
    id: reconcileId,
    type: 'staff.access.reconcile',
    aggregateType: 'access_group',
    aggregateId: 'centre_1',
    payload: { generation: desired.generation, actorId: owner.id },
    idempotencyKey: reconcileKey,
    scheduledAt: now,
    nowMs,
    onlyIfPreviousStatementChanged: true,
  }))
  uow.outbox(await enqueueOutboxStatement(db, cryptoContext, {
    id: expiryJobId,
    type: 'staff.invitation.expire',
    aggregateType: 'staff_invitation',
    aggregateId: invitationId,
    payload: { invitationId, actorId: owner.id },
    idempotencyKey: expiryKey,
    scheduledAt: expiresAt,
    nowMs,
  }))
  uow.audit(primaryAudit)
  uow.idempotency(await createIdempotencyStatement(db, cryptoContext, {
    ...idem,
    resourceType: 'staff_invitation',
    resourceId: invitationId,
    response: { status: 201, body },
    createdAt: now,
    expiresAt: iso(nowMs + DAY_MS),
  }))
  const expiredOpenPostcondition = expiredOpen
    ? `AND EXISTS (
        SELECT 1 FROM staff_invitations
        WHERE id=? AND staff_id=? AND status='expired' AND version=? AND updated_at=?
      )
      AND EXISTS (
        SELECT 1 FROM record_versions
        WHERE id=? AND entity_type='staff_invitation' AND entity_id=? AND version=?
      )`
    : ''
  const expiredOpenBindings = expiredOpen
    ? [
        expiredOpen.id,
        expiredOpen.staff_id,
        expiredOpen.version,
        now,
        expiredOpenVersion.id,
        expiredOpen.id,
        expiredOpen.version,
      ]
    : []
  uow.guard(rateLimitGuardStatement(db, {
    auditId,
    actorId: owner.id,
    action: 'staff.invited',
    limit: INVITATION_RATE_LIMIT,
    since: iso(nowMs - HOUR_MS),
    postconditionSql: `EXISTS (
        SELECT 1 FROM staff_users
        WHERE id=? AND email_lookup=? AND role=? AND status='pending' AND version=?
      )
      AND EXISTS (
        SELECT 1 FROM staff_invitations
        WHERE id=? AND staff_id=? AND status='provisioning' AND version=1 AND expires_at=?
      )
      AND EXISTS (
        SELECT 1 FROM record_versions
        WHERE id=? AND entity_type='staff_user' AND entity_id=? AND version=?
      )
      AND EXISTS (
        SELECT 1 FROM record_versions
        WHERE id=? AND entity_type='staff_invitation' AND entity_id=? AND version=1
      )
      AND EXISTS (
        SELECT 1 FROM system_state
        WHERE key='access.desired_generation' AND value_json=? AND version=?
      )
      AND EXISTS (
        SELECT 1 FROM outbox_jobs
        WHERE id=? AND type='staff.access.reconcile' AND idempotency_key=?
      )
      AND EXISTS (
        SELECT 1 FROM outbox_jobs
        WHERE id=? AND type='staff.invitation.expire' AND idempotency_key=? AND scheduled_at=?
      )
      AND EXISTS (
        SELECT 1 FROM idempotency_records
        WHERE actor_id=? AND operation='staff.invite' AND idempotency_key=?
          AND resource_type='staff_invitation' AND resource_id=?
      )${expiredOpen ? `\n      ${expiredOpenPostcondition}` : ''}`,
    postconditionBindings: [
      staffId,
      staff.email_lookup,
      staff.role,
      staff.version,
      invitationId,
      staffId,
      expiresAt,
      staffVersion.id,
      staffId,
      staff.version,
      invitationVersion.id,
      invitationId,
      JSON.stringify({ generation: desired.generation }),
      desired.priorVersion + 1,
      reconcileId,
      reconcileKey,
      expiryJobId,
      expiryKey,
      expiresAt,
      owner.id,
      idempotencyKey,
      invitationId,
      ...expiredOpenBindings,
    ],
  }))
  try {
    await commitRateLimitedMutation(db, uow, {
      actorId: owner.id,
      action: 'staff.invited',
      limit: INVITATION_RATE_LIMIT,
      since: iso(nowMs - HOUR_MS),
      correlationId,
      denialAudit,
    })
    return body
  } catch (error) {
    if (isD1IdentityCollision(error)) {
      try {
        const recovered = await recoverIdempotencyAfterCollision(db, cryptoContext, idem, error)
        return recovered.body
      } catch (recoveryError) {
        if (recoveryError !== error) throw recoveryError
        const current = await matchingIdentityRows(db, cryptoContext, request.email)
        const reuseChanged = reused && current.some((row) => (
          row.id === reused.id && row.version !== reused.version
        ))
        if ((!reused && current.length > 0) || reuseChanged || current.length > 1) {
          throw new Error('STAFF_INVITATION_CONFLICT')
        }
      }
    }
    throw error
  }
}

export async function listStaff({ db, cryptoContext, actor, nowMs } = {}) {
  if (!db?.prepare || !db?.batch || !cryptoContext?.keyring || !cryptoContext?.dataKey
    || !cryptoContext?.scope || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('VALIDATION_FAILED')
  }
  await activeOwner(db, actor, nowMs)
  const rows = (await db.prepare(
    `SELECT id,email_lookup,email_envelope,display_name_envelope,role,status,
            access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at
     FROM staff_users`
  ).all()).results
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
  if (!db?.prepare || !db?.batch || !cryptoContext?.keyring || !cryptoContext?.dataKey
    || !cryptoContext?.scope || !validId(correlationId) || !Number.isSafeInteger(nowMs)
    || nowMs < 0 || !IDEMPOTENCY_KEY.test(idempotencyKey ?? '')) {
    throw new Error('VALIDATION_FAILED')
  }
  const owner = await activeOwner(db, actor, nowMs)
  if (!STAFF_ID.test(staffId ?? '')) throw new Error('NOT_FOUND')
  if (!Number.isSafeInteger(version) || version < 1) validation('version')
  const requestDigest = JSON.stringify({ version })
  const idem = {
    actorId: owner.id,
    operation: 'staff.deactivate',
    idempotencyKey,
    requestDigest,
    expectedScope: cryptoContext.scope,
  }
  const replay = await inspectIdempotency(db, cryptoContext, idem)
  if (replay) return replay.body
  const row = await db.prepare('SELECT * FROM staff_users WHERE id=?').bind(staffId).first()
  if (!row) throw new Error('NOT_FOUND')
  if (row.version !== version) {
    const error = new Error('VERSION_CONFLICT')
    error.details = { currentVersion: row.version }
    throw error
  }
  const invitations = (await db.prepare(
    "SELECT * FROM staff_invitations WHERE staff_id=? AND status IN ('provisioning','pending')"
  ).bind(staffId).all()).results
  if (invitations.length > 1) throw new Error('INTERNAL_ERROR')
  const invitation = invitations[0] ?? null
  const [email, displayName] = await Promise.all([
    decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, { expectedScope: cryptoContext.scope, recordId: row.id, field: 'email', envelope: JSON.parse(row.email_envelope) }),
    decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, { expectedScope: cryptoContext.scope, recordId: row.id, field: 'display_name', envelope: JSON.parse(row.display_name_envelope) }),
  ])
  const now = iso(nowMs)
  const staff = {
    ...row,
    status: 'disabled',
    disabled_at: now,
    version: row.version + 1,
    updated_at: now,
  }
  const revokedInvitation = invitation
    ? {
        ...invitation,
        status: 'revoked',
        revoked_at: now,
        version: invitation.version + 1,
        updated_at: now,
      }
    : null
  const body = { data: { staff: publicStaff({ ...staff, displayName, email }) } }
  const staffVersion = await versionRecord(
    db, cryptoContext, staff, 'staff_user', owner.id, now, correlationId, idFactory,
  )
  const invitationVersion = revokedInvitation
    ? await versionRecord(
        db,
        cryptoContext,
        revokedInvitation,
        'staff_invitation',
        owner.id,
        now,
        correlationId,
        idFactory,
      )
    : null
  const desired = await desiredGenerationStatement(db, now, idFactory)
  const auditId = idFrom(idFactory)
  const reconcileId = idFrom(idFactory)
  const reconcileKey = `staff.access.reconcile:${desired.generation}`
  const uow = createUnitOfWork(db, {
    mode: 'mutation',
    actorId: owner.id,
    correlationId,
  })
  uow.domain(
    db.prepare(
      `UPDATE staff_users
       SET status='disabled',disabled_at=?,version=version+1,updated_at=?
       WHERE id=? AND version=?`
    ).bind(now, now, staffId, version)
  )
  if (revokedInvitation) {
    uow.domain(
      db.prepare(
        `UPDATE staff_invitations
         SET status='revoked',revoked_at=?,version=version+1,updated_at=?
         WHERE id=? AND staff_id=? AND version=? AND status IN ('provisioning','pending')`
      ).bind(
        now,
        now,
        revokedInvitation.id,
        staffId,
        invitation.version,
      )
    )
  }
  uow.version(staffVersion.statement)
  if (invitationVersion) uow.version(invitationVersion.statement)
  uow.domain(desired.statement)
  uow.outbox(await enqueueOutboxStatement(db, cryptoContext, {
    id: reconcileId,
    type: 'staff.access.reconcile',
    aggregateType: 'access_group',
    aggregateId: 'centre_1',
    payload: { generation: desired.generation, actorId: owner.id },
    idempotencyKey: reconcileKey,
    scheduledAt: now,
    nowMs,
    onlyIfPreviousStatementChanged: true,
  }))
  uow.audit(auditEventStatement(db, {
    id: auditId,
    occurredAt: now,
    actorStaffId: owner.id,
    action: 'staff.deactivated',
    entityType: 'staff_user',
    entityId: staffId,
    result: 'success',
    correlationId,
    metadata: {
      staffVersion: staff.version,
      desiredGeneration: desired.generation,
    },
    reasonEnvelope: null,
  }))
  uow.idempotency(await createIdempotencyStatement(db, cryptoContext, {
    ...idem,
    resourceType: 'staff_user',
    resourceId: staffId,
    response: { status: 200, body },
    createdAt: now,
    expiresAt: iso(nowMs + DAY_MS),
  }))
  const invitationPostcondition = revokedInvitation
    ? `AND EXISTS (
        SELECT 1 FROM staff_invitations
        WHERE id=? AND staff_id=? AND status='revoked' AND revoked_at=?
          AND version=? AND updated_at=?
      )
      AND EXISTS (
        SELECT 1 FROM record_versions
        WHERE id=? AND entity_type='staff_invitation' AND entity_id=? AND version=?
      )`
    : ''
  const invitationBindings = revokedInvitation
    ? [
        revokedInvitation.id,
        staffId,
        now,
        revokedInvitation.version,
        now,
        invitationVersion.id,
        revokedInvitation.id,
        revokedInvitation.version,
      ]
    : []
  uow.guard(
    db.prepare(
      `INSERT INTO audit_events
       (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
        reason_envelope,correlation_id,metadata_json)
       SELECT id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
              reason_envelope,correlation_id,metadata_json
       FROM audit_events
       WHERE id=? AND NOT (
         EXISTS (
           SELECT 1 FROM staff_users
           WHERE id=? AND status='disabled' AND disabled_at=? AND version=? AND updated_at=?
         )
         AND EXISTS (
           SELECT 1 FROM record_versions
           WHERE id=? AND entity_type='staff_user' AND entity_id=? AND version=?
         )
         AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='access.desired_generation' AND value_json=? AND version=?
         )
         AND EXISTS (
           SELECT 1 FROM outbox_jobs
           WHERE id=? AND type='staff.access.reconcile' AND idempotency_key=?
         )
         AND EXISTS (
           SELECT 1 FROM idempotency_records
           WHERE actor_id=? AND operation='staff.deactivate' AND idempotency_key=?
             AND resource_type='staff_user' AND resource_id=?
         )
         ${invitationPostcondition}
       )`
    ).bind(
      auditId,
      staffId,
      now,
      staff.version,
      now,
      staffVersion.id,
      staffId,
      staff.version,
      JSON.stringify({ generation: desired.generation }),
      desired.priorVersion + 1,
      reconcileId,
      reconcileKey,
      owner.id,
      idempotencyKey,
      staffId,
      ...invitationBindings,
    )
  )
  try {
    await uow.commit()
    return body
  } catch (error) {
    if (isD1LastActiveOwner(error)) throw new Error('LAST_ACTIVE_OWNER')
    if (isD1IdentityCollision(error)) {
      const recovered = await recoverIdempotencyAfterCollision(
        db,
        cryptoContext,
        idem,
        error,
      )
      return recovered.body
    }
    throw error
  }
}

export async function expireInvitation({ db, cryptoContext, actorId, invitationId, correlationId, nowMs, idFactory = () => crypto.randomUUID().replaceAll('-', '') } = {}) {
  if (!db?.prepare || !db?.batch || !cryptoContext?.keyring || !cryptoContext?.dataKey
    || !cryptoContext?.scope || !validId(actorId) || !validId(invitationId)
    || !validId(correlationId) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('INTERNAL_ERROR')
  }
  const invitation = await db.prepare(
    'SELECT * FROM staff_invitations WHERE id=?'
  ).bind(invitationId).first()
  const now = iso(nowMs)
  if (!invitation || !['provisioning', 'pending'].includes(invitation.status)
    || invitation.expires_at > now) return { expired: false }
  const staff = await db.prepare(
    "SELECT id,status,version FROM staff_users WHERE id=? AND status='pending'"
  ).bind(invitation.staff_id).first()
  if (!staff) return { expired: false }
  const nextInvitation = { ...invitation, status: 'expired', version: invitation.version + 1, updated_at: now }
  const desired = await desiredGenerationStatement(db, now, idFactory)
  const invitationVersion = await versionRecord(
    db,
    cryptoContext,
    nextInvitation,
    'staff_invitation',
    actorId,
    now,
    correlationId,
    idFactory,
  )
  const auditId = idFrom(idFactory)
  const reconcileId = idFrom(idFactory)
  const reconcileKey = `staff.access.reconcile:${desired.generation}`
  const uow = createUnitOfWork(db, {
    mode: 'mutation',
    actorId,
    correlationId,
  })
  uow.domain(
    db.prepare(
      `UPDATE staff_invitations
       SET status='expired',version=version+1,updated_at=?
       WHERE id=? AND staff_id=? AND version=?
         AND status IN ('provisioning','pending') AND expires_at<=?
         AND EXISTS (
           SELECT 1 FROM staff_users
           WHERE id=? AND status='pending' AND version=?
         )`
    ).bind(
      now,
      invitation.id,
      invitation.staff_id,
      invitation.version,
      now,
      staff.id,
      staff.version,
    )
  )
  uow.version(invitationVersion.statement)
  uow.domain(desired.statement)
  uow.outbox(await enqueueOutboxStatement(db, cryptoContext, {
    id: reconcileId,
    type: 'staff.access.reconcile',
    aggregateType: 'access_group',
    aggregateId: 'centre_1',
    payload: { generation: desired.generation, actorId },
    idempotencyKey: reconcileKey,
    scheduledAt: now,
    nowMs,
    onlyIfPreviousStatementChanged: true,
  }))
  uow.audit(auditEventStatement(db, {
    id: auditId,
    occurredAt: now,
    actorStaffId: actorId,
    action: 'staff.invitation.expired',
    entityType: 'staff_invitation',
    entityId: invitation.id,
    result: 'success',
    correlationId,
    metadata: {
      staffVersion: staff.version,
      invitationVersion: nextInvitation.version,
      desiredGeneration: desired.generation,
    },
    reasonEnvelope: null,
  }))
  uow.guard(
    db.prepare(
      `INSERT INTO audit_events
       (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
        reason_envelope,correlation_id,metadata_json)
       SELECT id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
              reason_envelope,correlation_id,metadata_json
       FROM audit_events
       WHERE id=? AND NOT (
         EXISTS (
           SELECT 1 FROM staff_invitations
           WHERE id=? AND staff_id=? AND status='expired' AND version=? AND updated_at=?
         )
         AND EXISTS (
           SELECT 1 FROM record_versions
           WHERE id=? AND entity_type='staff_invitation' AND entity_id=? AND version=?
         )
         AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='access.desired_generation' AND value_json=? AND version=?
         )
         AND EXISTS (
           SELECT 1 FROM outbox_jobs
           WHERE id=? AND type='staff.access.reconcile' AND idempotency_key=?
         )
       )`
    ).bind(
      auditId,
      invitation.id,
      invitation.staff_id,
      nextInvitation.version,
      now,
      invitationVersion.id,
      invitation.id,
      nextInvitation.version,
      JSON.stringify({ generation: desired.generation }),
      desired.priorVersion + 1,
      reconcileId,
      reconcileKey,
    )
  )
  try {
    await uow.commit()
    return { expired: true }
  } catch (error) {
    if (!isD1IdentityCollision(error)) throw error
    const current = await db.prepare(
      'SELECT status,version FROM staff_invitations WHERE id=?'
    ).bind(invitation.id).first()
    if (!current || current.version !== invitation.version
      || !['provisioning', 'pending'].includes(current.status)) return { expired: false }
    throw error
  }
}
