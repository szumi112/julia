import { auditEventStatement } from '../audit/events.js'
import { isD1OutboxOperationGuardFailure } from '../db/errors.js'
import { createUnitOfWork } from '../db/unit-of-work.js'
import { loadAccessProviderConfig } from '../config.js'
import { acceptPhaseOneAccessEmail } from '../identity/canonical-email.js'
import {
  blindEmailCandidates,
  decryptForScope,
  encryptForScope,
} from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'
import { enqueueOutboxStatement } from './outbox.js'
import { reconcileAccessGroup } from '../providers/cloudflare-access.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const INVITATION_ID = /^inv_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const LOOKUP = /^v[1-9]\d*:[A-Za-z0-9_-]{43}$/
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const LEASE_MS = 60_000
const PROVIDER_TIMEOUT_MS = 15_000
const PROVIDER_RUNWAY_MS = (PROVIDER_TIMEOUT_MS * 3) + 1_000
const PROVISIONING_PUBLICATION_LIMIT = 2
const DOMAIN_SEPARATOR = 'bwm:access-desired-set:v1\n'
const textEncoder = new TextEncoder()

const ownObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const validId = (value) => typeof value === 'string' && ID.test(value)
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const iso = (nowMs) => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('ACCESS_RECONCILE_STATE_INVALID')
  try {
    return new Date(nowMs).toISOString()
  } catch {
    throw new Error('ACCESS_RECONCILE_STATE_INVALID')
  }
}
const idFrom = (factory) => {
  if (typeof factory !== 'function') throw new Error('ACCESS_RECONCILE_STATE_INVALID')
  const value = factory()
  if (!validId(value)) throw new Error('ACCESS_RECONCILE_STATE_INVALID')
  return value
}
const canonicalEmail = (value, appEnv) => (
  acceptPhaseOneAccessEmail(value, { appEnv }) !== null
)
const operationGuard = (db, operationId, predicate, bindings) => db.prepare(
  `INSERT INTO outbox_operation_guard_failures (operation_id)
   SELECT ? WHERE NOT (${predicate})`
).bind(operationId, ...bindings)
const directoryError = () => {
  throw new Error('ACCESS_DESIRED_STATE_INVALID')
}
const stateError = () => {
  throw new Error('ACCESS_RECONCILE_STATE_INVALID')
}

function exactD1Row(row, keys) {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).length === keys.length
    && keys.every((key) => Object.hasOwn(row, key))
}

async function decryptEmail(cryptoContext, recordId, serialized) {
  try {
    if (typeof serialized !== 'string' || serialized.length > 4096) directoryError()
    return await decryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: cryptoContext.scope,
        recordId,
        field: 'email',
        envelope: JSON.parse(serialized),
      },
    )
  } catch {
    directoryError()
  }
}

async function validateLookup(cryptoContext, email, lookup) {
  try {
    const candidates = await blindEmailCandidates(email, cryptoContext.keyring)
    if (!candidates.includes(lookup)) directoryError()
  } catch {
    directoryError()
  }
}

export async function accessDesiredFingerprint(lookups) {
  if (!Array.isArray(lookups) || !lookups.every((lookup) => typeof lookup === 'string' && LOOKUP.test(lookup))) {
    directoryError()
  }
  const sorted = [...new Set(lookups)].sort()
  const encoded = textEncoder.encode(`${DOMAIN_SEPARATOR}${sorted.map((lookup) => `${lookup}\n`).join('')}`)
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
    return encodeBase64Url(digest)
  } finally {
    encoded.fill(0)
    digest?.fill(0)
  }
}

async function completeDesiredMembership(db, cryptoContext, nowMs, appEnv = 'development') {
  if (!db?.prepare || !cryptoContext?.keyring || !ownObject(cryptoContext.dataKey)
    || !ownObject(cryptoContext.scope)
    || cryptoContext.scope.type !== 'staff_directory'
    || cryptoContext.scope.purpose !== 'identity'
    || !['development', 'production', 'staging'].includes(appEnv)) directoryError()
  const now = iso(nowMs)
  let staffResult
  let invitationResult
  try {
    [staffResult, invitationResult] = await db.batch([
      db.prepare(
        `SELECT id,email_lookup,email_envelope,status,version
         FROM staff_users
         WHERE status IN ('active','pending')
         ORDER BY id`
      ),
      db.prepare(
        `SELECT id,staff_id,email_lookup,email_envelope,status,expires_at,version
         FROM staff_invitations
         WHERE status IN ('provisioning','pending')
         ORDER BY staff_id,id`
      ),
    ])
  } catch {
    directoryError()
  }
  if (!Array.isArray(staffResult?.results) || !Array.isArray(invitationResult?.results)) {
    directoryError()
  }
  const staffRows = staffResult.results
  const invitationRows = invitationResult.results
  for (const row of staffRows) {
    if (!exactD1Row(row, ['id', 'email_lookup', 'email_envelope', 'status', 'version'])
      || !STAFF_ID.test(row.id ?? '')
      || !LOOKUP.test(row.email_lookup ?? '')
      || !['active', 'pending'].includes(row.status)
      || !Number.isSafeInteger(row.version)
      || row.version < 1) directoryError()
  }
  const invitationsByStaff = new Map()
  for (const row of invitationRows) {
    if (!exactD1Row(row, [
      'id', 'staff_id', 'email_lookup', 'email_envelope',
      'status', 'expires_at', 'version',
    ])
      || !INVITATION_ID.test(row.id ?? '')
      || !STAFF_ID.test(row.staff_id ?? '')
      || !LOOKUP.test(row.email_lookup ?? '')
      || !['provisioning', 'pending'].includes(row.status)
      || !validInstant(row.expires_at)
      || !Number.isSafeInteger(row.version)
      || row.version < 1) directoryError()
    const rows = invitationsByStaff.get(row.staff_id) ?? []
    rows.push(row)
    invitationsByStaff.set(row.staff_id, rows)
  }
  const emails = []
  const lookups = []
  const includedPendingInvitations = []
  const provisioningInvitations = []
  const identities = new Map()
  const lookupOwners = new Map()
  for (const staff of staffRows) {
    const invitations = invitationsByStaff.get(staff.id) ?? []
    if (staff.status === 'active' && invitations.length > 0) directoryError()
    if (staff.status === 'pending' && invitations.length > 1) directoryError()
    const invitation = staff.status === 'pending' ? invitations[0] : null
    if (staff.status === 'pending' && (!invitation || invitation.expires_at <= now)) continue
    const staffEmail = await decryptEmail(cryptoContext, staff.id, staff.email_envelope)
    if (!canonicalEmail(staffEmail, appEnv)) directoryError()
    await validateLookup(cryptoContext, staffEmail, staff.email_lookup)
    if (invitation) {
      const invitationEmail = await decryptEmail(
        cryptoContext,
        invitation.id,
        invitation.email_envelope,
      )
      if (!canonicalEmail(invitationEmail, appEnv)
        || invitationEmail !== staffEmail
        || invitation.email_lookup !== staff.email_lookup) directoryError()
      await validateLookup(cryptoContext, invitationEmail, invitation.email_lookup)
      includedPendingInvitations.push(Object.freeze({
        emailLookup: invitation.email_lookup,
        expiresAt: invitation.expires_at,
        id: invitation.id,
        staffEmailLookup: staff.email_lookup,
        staffId: staff.id,
        staffStatus: staff.status,
        staffVersion: staff.version,
        status: invitation.status,
        version: invitation.version,
      }))
      if (invitation.status === 'provisioning') {
        provisioningInvitations.push(Object.freeze({
          id: invitation.id,
          staffId: staff.id,
          version: invitation.version,
        }))
      }
    }
    const prior = identities.get(staffEmail)
    if (prior && (prior.staffId !== staff.id || prior.lookup !== staff.email_lookup)) directoryError()
    const priorLookup = lookupOwners.get(staff.email_lookup)
    if (priorLookup
      && (priorLookup.staffId !== staff.id || priorLookup.email !== staffEmail)) {
      directoryError()
    }
    identities.set(staffEmail, { staffId: staff.id, lookup: staff.email_lookup })
    lookupOwners.set(staff.email_lookup, { email: staffEmail, staffId: staff.id })
    emails.push(staffEmail)
    lookups.push(staff.email_lookup)
  }
  emails.sort()
  includedPendingInvitations.sort((left, right) => left.id.localeCompare(right.id))
  provisioningInvitations.sort((left, right) => left.id.localeCompare(right.id))
  return {
    emails: [...new Set(emails)],
    fingerprint: await accessDesiredFingerprint(lookups),
    includedPendingInvitations,
    provisioningInvitations,
  }
}

export async function desiredAccessMembership(db, cryptoContext, nowMs, appEnv = 'development') {
  const desired = await completeDesiredMembership(db, cryptoContext, nowMs, appEnv)
  return Object.freeze({
    emails: Object.freeze([...desired.emails]),
    fingerprint: desired.fingerprint,
    provisioningInvitations: Object.freeze(
      desired.provisioningInvitations.map((invitation) => Object.freeze({ ...invitation })),
    ),
  })
}

function parseStateRow(row, key) {
  if (!exactD1Row(row, ['key', 'value_json', 'version'])
    || row.key !== key
    || typeof row.value_json !== 'string'
    || !Number.isSafeInteger(row.version)
    || row.version < 1) stateError()
  let value
  try {
    value = JSON.parse(row.value_json)
  } catch {
    stateError()
  }
  if (!ownObject(value) || JSON.stringify(value) !== row.value_json) stateError()
  if (key === 'access.desired_generation') {
    if (!exactKeys(value, ['generation'])
      || !Number.isSafeInteger(value.generation)
      || value.generation < 0) stateError()
  } else if (key === 'access.applied_generation') {
    if (!exactKeys(value, ['fingerprint', 'generation'])
      || !FINGERPRINT.test(value.fingerprint ?? '')
      || !Number.isSafeInteger(value.generation)
      || value.generation < 0) stateError()
  } else if (key === 'access.reconcile.lease') {
    if (!exactKeys(value, ['expiresAt', 'nonce', 'owner'])) stateError()
    const released = value.expiresAt === null && value.nonce === null && value.owner === null
    const held = validInstant(value.expiresAt)
      && validId(value.nonce)
      && validId(value.owner)
    if (!released && !held) stateError()
  } else {
    stateError()
  }
  return { ...row, value }
}

async function state(db, key) {
  let row
  try {
    row = await db.prepare(
      'SELECT key,value_json,version FROM system_state WHERE key=?'
    ).bind(key).first()
  } catch {
    stateError()
  }
  return parseStateRow(row, key)
}

async function allStates(db) {
  const [desired, applied, lease] = await Promise.all([
    state(db, 'access.desired_generation'),
    state(db, 'access.applied_generation'),
    state(db, 'access.reconcile.lease'),
  ])
  if (applied.value.generation > desired.value.generation) stateError()
  return { desired, applied, lease }
}

export async function acquireAccessReconcileLease({
  db,
  nowMs,
  ownerFactory,
  nonceFactory,
} = {}) {
  if (!db?.prepare || !db?.batch) stateError()
  const now = iso(nowMs)
  const current = await state(db, 'access.reconcile.lease')
  if (current.value.expiresAt !== null && current.value.expiresAt > now) return null
  const owner = idFrom(ownerFactory)
  const nonce = idFrom(nonceFactory)
  if (owner === nonce) stateError()
  const expiresAt = iso(nowMs + LEASE_MS)
  const value = { expiresAt, nonce, owner }
  const valueJson = JSON.stringify(value)
  const nextVersion = current.version + 1
  try {
    await db.batch([
      db.prepare(
        `UPDATE system_state
         SET value_json=?,version=version+1,updated_at=?
         WHERE key='access.reconcile.lease' AND version=? AND value_json=?
           AND (
             json_extract(value_json,'$.expiresAt') IS NULL
             OR json_extract(value_json,'$.expiresAt')<=?
           )`
      ).bind(valueJson, now, current.version, current.value_json, now),
      operationGuard(
        db,
        `access_lease_acquire_${nonce}`,
        `changes()=1 AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='access.reconcile.lease' AND value_json=? AND version=?
         )`,
        [valueJson, nextVersion],
      ),
    ])
  } catch (error) {
    if (isD1OutboxOperationGuardFailure(error)) return null
    throw error
  }
  return Object.freeze({
    owner,
    nonce,
    expiresAt,
    valueJson,
    version: nextVersion,
  })
}

function ownedLease(row, lease, now) {
  return sameLeaseFence(row, lease)
    && row.value.expiresAt > now
}

function sameLeaseFence(row, lease) {
  return row.version === lease.version
    && row.value_json === lease.valueJson
    && row.value.owner === lease.owner
    && row.value.nonce === lease.nonce
    && row.value.expiresAt === lease.expiresAt
}

const membershipCurrentAt = (membership, now) => (
  membership.includedPendingInvitations.every(
    (invitation) => invitation.expiresAt > now,
  )
)

async function releaseLease(db, lease, nowMs) {
  const now = iso(nowMs)
  const current = await state(db, 'access.reconcile.lease')
  if (!sameLeaseFence(current, lease)) return false
  const released = JSON.stringify({ expiresAt: null, nonce: null, owner: null })
  try {
    await db.batch([
      db.prepare(
        `UPDATE system_state
         SET value_json=?,version=version+1,updated_at=?
         WHERE key='access.reconcile.lease' AND version=? AND value_json=?`
      ).bind(released, now, current.version, current.value_json),
      operationGuard(
        db,
        `access_lease_release_${lease.nonce}`,
        `changes()=1 AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='access.reconcile.lease' AND value_json=? AND version=?
         )`,
        [released, current.version + 1],
      ),
    ])
    return true
  } catch (error) {
    if (isD1OutboxOperationGuardFailure(error)) return false
    throw error
  }
}

async function releaseObsolete(db, lease, desired, nowMs) {
  const now = iso(nowMs)
  const currentLease = await state(db, 'access.reconcile.lease')
  if (!ownedLease(currentLease, lease, now)) return false
  const key = `staff.access.reconcile:${desired.value.generation}`
  const released = JSON.stringify({ expiresAt: null, nonce: null, owner: null })
  try {
    await db.batch([
      db.prepare(
        `UPDATE system_state
         SET value_json=?,version=version+1,updated_at=?
         WHERE key='access.reconcile.lease' AND version=? AND value_json=?
           AND json_extract(value_json,'$.expiresAt')>?
           AND EXISTS (
             SELECT 1 FROM system_state
             WHERE key='access.desired_generation' AND value_json=? AND version=?
           )
           AND EXISTS (
             SELECT 1 FROM outbox_jobs
             WHERE type='staff.access.reconcile'
               AND aggregate_type='access_group' AND aggregate_id='centre_1'
               AND idempotency_key=?
           )`
      ).bind(
        released,
        now,
        currentLease.version,
        currentLease.value_json,
        now,
        desired.value_json,
        desired.version,
        key,
      ),
      operationGuard(
        db,
        `access_obsolete_release_${lease.nonce}`,
        `changes()=1 AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='access.reconcile.lease' AND value_json=? AND version=?
         )`,
        [released, currentLease.version + 1],
      ),
    ])
    return true
  } catch (error) {
    if (isD1OutboxOperationGuardFailure(error)) return false
    throw error
  }
}

async function invitationRow(db, invitation) {
  const row = await db.prepare(
    `SELECT id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,
            inviter_id,expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,
            version,created_at,updated_at
     FROM staff_invitations
     WHERE id=?`
  ).bind(invitation.id).first()
  if (!row || row.id !== invitation.id || row.staff_id !== invitation.staffId
    || row.email_lookup !== invitation.emailLookup
    || row.status !== invitation.status
    || row.expires_at !== invitation.expiresAt
    || row.version !== invitation.version) stateError()
  return row
}

async function versionStatement(db, cryptoContext, row, actorId, now, correlationId, idFactory) {
  const id = idFrom(idFactory)
  const snapshot = JSON.stringify(await encryptForScope(
    cryptoContext.keyring,
    cryptoContext.dataKey,
    {
      expectedScope: cryptoContext.scope,
      recordId: row.id,
      field: 'record_version',
      plaintext: JSON.stringify(row),
    },
  ))
  return {
    id,
    statement: db.prepare(
      `INSERT INTO record_versions
       (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
        changed_at,correlation_id)
       VALUES (?,'staff_invitation',?,?,?,?,?,?)`
    ).bind(id, row.id, row.version, snapshot, actorId, now, correlationId),
  }
}

async function publishApplied({
  db,
  cryptoContext,
  actorId,
  correlationId,
  desiredState,
  appliedState,
  leaseState,
  membership,
  advanceApplied,
  nowMs,
  nowFactory,
  idFactory,
}) {
  const now = iso(nowMs)
  const appliedValue = advanceApplied
    ? JSON.stringify({
      fingerprint: membership.fingerprint,
      generation: desiredState.value.generation,
    })
    : appliedState.value_json
  const appliedVersion = appliedState.version + (advanceApplied ? 1 : 0)
  const appliedGeneration = advanceApplied
    ? desiredState.value.generation
    : appliedState.value.generation
  const releasedValue = JSON.stringify({ expiresAt: null, nonce: null, owner: null })
  const provisioningInvitations = membership.includedPendingInvitations
    .filter((candidate) => candidate.status === 'provisioning')
  const firstRemainingInvitation = provisioningInvitations[PROVISIONING_PUBLICATION_LIMIT] ?? null
  const invitationChanges = []
  for (const invitation of provisioningInvitations.slice(0, PROVISIONING_PUBLICATION_LIMIT)) {
    const current = await invitationRow(db, invitation)
    const next = {
      ...current,
      status: 'pending',
      access_allowed_at: now,
      version: current.version + 1,
      updated_at: now,
    }
    const version = await versionStatement(
      db,
      cryptoContext,
      next,
      actorId,
      now,
      correlationId,
      idFactory,
    )
    const jobId = idFrom(idFactory)
    invitationChanges.push({
      current,
      invitation,
      next,
      version,
      jobId,
      jobKey: `staff.invitation.email:${current.id}:${next.version}`,
      job: await enqueueOutboxStatement(db, cryptoContext, {
        id: jobId,
        type: 'staff.invitation.email',
        aggregateType: 'staff_invitation',
        aggregateId: current.id,
        payload: { actorId, invitationId: current.id },
        idempotencyKey: `staff.invitation.email:${current.id}:${next.version}`,
        scheduledAt: now,
        nowMs,
      }),
    })
  }
  let continuation = null
  if (firstRemainingInvitation) {
    const id = idFrom(idFactory)
    const idempotencyKey = [
      'staff.access.reconcile.continue',
      desiredState.value.generation,
      firstRemainingInvitation.id,
      firstRemainingInvitation.version,
    ].join(':')
    continuation = {
      id,
      idempotencyKey,
      statement: await enqueueOutboxStatement(db, cryptoContext, {
        id,
        type: 'staff.access.reconcile',
        aggregateType: 'access_group',
        aggregateId: 'centre_1',
        payload: {
          actorId,
          generation: desiredState.value.generation,
        },
        idempotencyKey,
        scheduledAt: now,
        nowMs,
      }),
    }
  }
  const auditId = idFrom(idFactory)
  const audit = auditEventStatement(db, {
    id: auditId,
    occurredAt: now,
    actorStaffId: actorId,
    action: 'staff.access.reconciled',
    entityType: 'access_group',
    entityId: 'centre_1',
    result: 'success',
    correlationId,
    metadata: {
      desiredGeneration: desiredState.value.generation,
      appliedGeneration,
      invitationCount: invitationChanges.length,
    },
    reasonEnvelope: null,
  })
  const guardNowMs = nowFactory()
  const guardNow = iso(guardNowMs)
  if (leaseState.value.expiresAt <= guardNow
    || membership.includedPendingInvitations.some(
      (invitation) => invitation.expiresAt <= guardNow,
    )) {
    return Object.freeze({ complete: false, published: false })
  }
  const uow = createUnitOfWork(db, {
    mode: 'mutation',
    actorId,
    correlationId,
  })
  if (advanceApplied) {
    uow.domain(
      db.prepare(
        `UPDATE system_state
         SET value_json=?,version=version+1,updated_at=?
         WHERE key='access.applied_generation' AND value_json=? AND version=?
           AND EXISTS (
             SELECT 1 FROM system_state
             WHERE key='access.desired_generation' AND value_json=? AND version=?
           )
           AND EXISTS (
             SELECT 1 FROM system_state
             WHERE key='access.reconcile.lease' AND value_json=? AND version=?
               AND json_extract(value_json,'$.expiresAt')>?
           )`
      ).bind(
        appliedValue,
        now,
        appliedState.value_json,
        appliedState.version,
        desiredState.value_json,
        desiredState.version,
        leaseState.value_json,
        leaseState.version,
        guardNow,
      )
    )
  }
  for (const change of invitationChanges) {
    uow.domain(
      db.prepare(
        `UPDATE staff_invitations
         SET status='pending',access_allowed_at=?,version=version+1,updated_at=?
         WHERE id=? AND staff_id=? AND status='provisioning' AND version=?
           AND expires_at>?
           AND email_lookup=?
           AND EXISTS (
             SELECT 1 FROM staff_users
             WHERE id=? AND status=? AND version=? AND email_lookup=?
           )
           AND EXISTS (
             SELECT 1 FROM system_state
             WHERE key='access.desired_generation' AND value_json=? AND version=?
           )
           AND EXISTS (
             SELECT 1 FROM system_state
             WHERE key='access.reconcile.lease' AND value_json=? AND version=?
               AND json_extract(value_json,'$.expiresAt')>?
           )`
      ).bind(
        now,
        now,
        change.current.id,
        change.current.staff_id,
        change.current.version,
        guardNow,
        change.current.email_lookup,
        change.invitation.staffId,
        change.invitation.staffStatus,
        change.invitation.staffVersion,
        change.invitation.staffEmailLookup,
        desiredState.value_json,
        desiredState.version,
        leaseState.value_json,
        leaseState.version,
        guardNow,
      )
    )
    uow.version(change.version.statement)
    uow.outbox(change.job)
  }
  if (continuation) uow.outbox(continuation.statement)
  uow.audit(audit)
  uow.domain(
    db.prepare(
      `UPDATE system_state
       SET value_json=?,version=version+1,updated_at=?
       WHERE key='access.reconcile.lease' AND value_json=? AND version=?
         AND json_extract(value_json,'$.expiresAt')>?
         AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='access.desired_generation' AND value_json=? AND version=?
         )
         AND EXISTS (
           SELECT 1 FROM system_state
           WHERE key='access.applied_generation' AND value_json=? AND version=?
         )`
    ).bind(
      releasedValue,
      now,
      leaseState.value_json,
      leaseState.version,
      guardNow,
      desiredState.value_json,
      desiredState.version,
      appliedValue,
      appliedVersion,
    )
  )
  const invitationPredicates = invitationChanges.map(() => (
    `AND EXISTS (
       SELECT 1 FROM staff_invitations
       WHERE id=? AND staff_id=? AND status='pending' AND version=?
         AND access_allowed_at=? AND updated_at=?
     )
     AND EXISTS (
       SELECT 1 FROM record_versions
       WHERE id=? AND entity_type='staff_invitation' AND entity_id=? AND version=?
         AND changed_by_staff_id=? AND changed_at=? AND correlation_id=?
     )
     AND EXISTS (
       SELECT 1 FROM outbox_jobs
       WHERE id=? AND type='staff.invitation.email'
         AND aggregate_type='staff_invitation' AND aggregate_id=?
         AND idempotency_key=? AND status='queued'
     )`
  )).join('\n')
  const invitationBindings = invitationChanges.flatMap((change) => [
    change.next.id,
    change.next.staff_id,
    change.next.version,
    now,
    now,
    change.version.id,
    change.next.id,
    change.next.version,
    actorId,
    now,
    correlationId,
    change.jobId,
    change.next.id,
    change.jobKey,
  ])
  const changedInvitationIds = new Set(
    invitationChanges.map((change) => change.invitation.id),
  )
  const membershipProof = JSON.stringify(
    membership.includedPendingInvitations.map((invitation) => ({
      emailLookup: invitation.emailLookup,
      expiresAt: invitation.expiresAt,
      id: invitation.id,
      staffEmailLookup: invitation.staffEmailLookup,
      staffId: invitation.staffId,
      staffStatus: invitation.staffStatus,
      staffVersion: invitation.staffVersion,
      status: changedInvitationIds.has(invitation.id) ? 'pending' : invitation.status,
      version: invitation.version + (changedInvitationIds.has(invitation.id) ? 1 : 0),
    })),
  )
  const continuationPredicate = continuation
    ? `AND EXISTS (
         SELECT 1 FROM outbox_jobs
         WHERE id=? AND type='staff.access.reconcile'
           AND aggregate_type='access_group' AND aggregate_id='centre_1'
           AND idempotency_key=? AND status='queued'
           AND attempt_count=0 AND max_attempts=8
           AND scheduled_at=? AND created_at=scheduled_at AND updated_at=scheduled_at
           AND lease_owner IS NULL AND lease_expires_at IS NULL
           AND last_error_code IS NULL
       )`
    : ''
  const continuationBindings = continuation
    ? [continuation.id, continuation.idempotencyKey, now]
    : []
  uow.guard(operationGuard(
    db,
    `access_publish_${auditId}`,
    `changes()=1
     AND EXISTS (
       SELECT 1 FROM system_state
       WHERE key='access.reconcile.lease' AND value_json=? AND version=?
     )
     AND EXISTS (
       SELECT 1 FROM system_state
       WHERE key='access.desired_generation' AND value_json=? AND version=?
     )
     AND EXISTS (
       SELECT 1 FROM system_state
       WHERE key='access.applied_generation' AND value_json=? AND version=?
     )
     AND EXISTS (
       SELECT 1 FROM audit_events
       WHERE id=? AND actor_staff_id=? AND action='staff.access.reconciled'
         AND entity_type='access_group' AND entity_id='centre_1'
         AND result='success' AND reason_envelope IS NULL
         AND correlation_id=? AND metadata_json=?
     )
     ${invitationPredicates}
     ${continuationPredicate}
     AND (
       SELECT count(*)
       FROM json_each(?) AS expected
       JOIN staff_invitations AS invitation
         ON invitation.id=json_extract(expected.value,'$.id')
       JOIN staff_users AS staff
         ON staff.id=json_extract(expected.value,'$.staffId')
       WHERE json_type(expected.value,'$.id')='text'
         AND json_type(expected.value,'$.staffId')='text'
         AND json_type(expected.value,'$.emailLookup')='text'
         AND json_type(expected.value,'$.status')='text'
         AND json_type(expected.value,'$.expiresAt')='text'
         AND json_type(expected.value,'$.version')='integer'
         AND json_type(expected.value,'$.staffEmailLookup')='text'
         AND json_type(expected.value,'$.staffStatus')='text'
         AND json_type(expected.value,'$.staffVersion')='integer'
         AND invitation.staff_id=json_extract(expected.value,'$.staffId')
         AND invitation.email_lookup=json_extract(expected.value,'$.emailLookup')
         AND invitation.status=json_extract(expected.value,'$.status')
         AND invitation.expires_at=json_extract(expected.value,'$.expiresAt')
         AND invitation.expires_at>?
         AND invitation.version=json_extract(expected.value,'$.version')
         AND staff.email_lookup=json_extract(expected.value,'$.staffEmailLookup')
         AND staff.status=json_extract(expected.value,'$.staffStatus')
         AND staff.version=json_extract(expected.value,'$.staffVersion')
     )=?`,
    [
      releasedValue,
      leaseState.version + 1,
      desiredState.value_json,
      desiredState.version,
      appliedValue,
      appliedVersion,
      auditId,
      actorId,
      correlationId,
      JSON.stringify({
        appliedGeneration,
        desiredGeneration: desiredState.value.generation,
        invitationCount: invitationChanges.length,
      }),
      ...invitationBindings,
      ...continuationBindings,
      membershipProof,
      guardNow,
      membership.includedPendingInvitations.length,
    ],
  ))
  try {
    await uow.commit()
    return Object.freeze({
      complete: continuation === null,
      published: true,
    })
  } catch (error) {
    if (isD1OutboxOperationGuardFailure(error)) {
      return Object.freeze({ complete: false, published: false })
    }
    throw error
  }
}

function validateHandlerInput(input) {
  if (!input?.db?.prepare || !input?.db?.batch
    || !input.cryptoContext?.keyring
    || !ownObject(input.cryptoContext.dataKey)
    || !ownObject(input.cryptoContext.scope)
    || !exactKeys(input.payload, ['actorId', 'generation'])
    || !STAFF_ID.test(input.payload.actorId ?? '')
    || !Number.isSafeInteger(input.payload.generation)
    || input.payload.generation < 0
    || !Number.isSafeInteger(input.nowMs)
    || input.nowMs < 0
    || typeof input.idFactory !== 'function'
    || typeof input.leaseOwnerFactory !== 'function'
    || typeof input.leaseNonceFactory !== 'function'
    || typeof input.correlationIdFactory !== 'function'
    || (input.nowFactory !== undefined && typeof input.nowFactory !== 'function')) stateError()
}

export async function handleAccessReconcile(input) {
  validateHandlerInput(input)
  const nowFactory = input.nowFactory ?? Date.now
  const observedNowMs = () => {
    const observed = nowFactory()
    if (!Number.isSafeInteger(observed) || observed < 0) stateError()
    return Math.max(input.nowMs, observed)
  }
  await allStates(input.db)
  const lease = await acquireAccessReconcileLease({
    db: input.db,
    nowMs: input.nowMs,
    ownerFactory: input.leaseOwnerFactory,
    nonceFactory: input.leaseNonceFactory,
  })
  if (!lease) return { result: 'retry' }
  let currentStates
  let membership
  const refreshNowMs = observedNowMs()
  try {
    currentStates = await allStates(input.db)
    membership = await completeDesiredMembership(
      input.db,
      input.cryptoContext,
      refreshNowMs,
      input.config?.appEnv,
    )
  } catch (error) {
    await releaseLease(input.db, lease, refreshNowMs)
    throw error
  }
  const providerFenceLease = await state(input.db, 'access.reconcile.lease')
  const providerFenceNowMs = observedNowMs()
  const providerFenceNow = iso(providerFenceNowMs)
  if (!ownedLease(providerFenceLease, lease, providerFenceNow)) {
    if (lease.expiresAt <= providerFenceNow) {
      await releaseLease(input.db, lease, providerFenceNowMs)
    }
    return { result: 'retry' }
  }
  if (!membershipCurrentAt(membership, providerFenceNow)) {
    await releaseLease(input.db, lease, providerFenceNowMs)
    return { result: 'retry' }
  }
  const generation = currentStates.desired.value.generation
  const applied = currentStates.applied.value
  if (input.payload.generation > generation) {
    await releaseLease(input.db, lease, providerFenceNowMs)
    stateError()
  }
  if (input.payload.generation < generation) {
    if (input.payload.generation <= applied.generation) {
      return await releaseLease(input.db, lease, providerFenceNowMs)
        ? { result: 'succeeded' }
        : { result: 'retry' }
    }
    return await releaseObsolete(input.db, lease, currentStates.desired, providerFenceNowMs)
      ? { result: 'succeeded' }
      : { result: 'retry' }
  }
  if (applied.generation === generation && applied.fingerprint === membership.fingerprint) {
    if (membership.provisioningInvitations.length === 0) {
      return await releaseLease(input.db, lease, providerFenceNowMs)
        ? { result: 'succeeded' }
        : { result: 'retry' }
    }
    const publication = await publishApplied({
      db: input.db,
      cryptoContext: input.cryptoContext,
      actorId: input.payload.actorId,
      correlationId: idFrom(input.correlationIdFactory),
      desiredState: currentStates.desired,
      appliedState: currentStates.applied,
      leaseState: providerFenceLease,
      membership,
      advanceApplied: false,
      nowMs: providerFenceNowMs,
      nowFactory: observedNowMs,
      idFactory: input.idFactory,
    })
    if (publication.published) {
      return { result: 'succeeded' }
    }
    const cleanupNowMs = observedNowMs()
    if (lease.expiresAt <= iso(cleanupNowMs)) {
      await releaseLease(input.db, lease, cleanupNowMs)
    }
    return { result: 'retry' }
  }
  if (Date.parse(lease.expiresAt) - providerFenceNowMs < PROVIDER_RUNWAY_MS) {
    await releaseLease(input.db, lease, providerFenceNowMs)
    return { result: 'retry' }
  }
  const providers = ownObject(input.providers) ? input.providers : {}
  const reconcile = providers.reconcileAccessGroup ?? reconcileAccessGroup
  try {
    const providerConfig = providers.reconcileAccessGroup
      ? {}
      : loadAccessProviderConfig(input.bindings, input.config)
    await reconcile({
      ...providerConfig,
      emails: membership.emails,
      timeoutMs: PROVIDER_TIMEOUT_MS,
      ...(providers.reconcileAccessGroup
        ? {}
        : { fetch: providers.fetch ?? globalThis.fetch }),
    })
  } catch (error) {
    await releaseLease(input.db, lease, observedNowMs())
    throw error
  }
  const finalNowMs = observedNowMs()
  const finalNow = iso(finalNowMs)
  const finalLease = await state(input.db, 'access.reconcile.lease')
  if (!ownedLease(finalLease, lease, finalNow)) {
    if (lease.expiresAt <= finalNow) {
      await releaseLease(input.db, lease, finalNowMs)
    }
    return { result: 'retry' }
  }
  const finalStates = await allStates(input.db)
  const finalMembership = await completeDesiredMembership(
    input.db,
    input.cryptoContext,
    finalNowMs,
    input.config?.appEnv,
  )
  const generationChanged = finalStates.desired.value.generation !== generation
  const fingerprintChanged = finalMembership.fingerprint !== membership.fingerprint
  if (generationChanged || fingerprintChanged) {
    if (finalStates.desired.value.generation > generation) {
      return await releaseObsolete(
        input.db,
        lease,
        finalStates.desired,
        finalNowMs,
      )
        ? { result: 'succeeded' }
        : { result: 'retry' }
    }
    return { result: 'retry' }
  }
  const correlationId = idFrom(input.correlationIdFactory)
  const published = await publishApplied({
    db: input.db,
    cryptoContext: input.cryptoContext,
    actorId: input.payload.actorId,
    correlationId,
    desiredState: finalStates.desired,
    appliedState: finalStates.applied,
    leaseState: finalLease,
    membership: finalMembership,
    advanceApplied: true,
    nowMs: finalNowMs,
    nowFactory: observedNowMs,
    idFactory: input.idFactory,
  })
  if (published.published) {
    return { result: 'succeeded' }
  }
  const cleanupNowMs = observedNowMs()
  if (lease.expiresAt <= iso(cleanupNowMs)) {
    await releaseLease(input.db, lease, cleanupNowMs)
  }
  return { result: 'retry' }
}
