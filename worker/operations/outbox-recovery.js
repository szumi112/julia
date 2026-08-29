import { auditEventStatement } from '../audit/events.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectIdempotency,
  recoverIdempotencyAfterCollision,
} from '../db/unit-of-work.js'
import {
  isD1IdentityCollision,
  isD1InvalidOutboxRecoveryEdge,
  isD1OutboxOperationGuardFailure,
} from '../db/errors.js'
import { captureAuthorityActor } from '../identity/authority-actor.js'
import { normalizeCanonicalEmail } from '../identity/canonical-email.js'
import { authorize } from '../identity/policy.js'
import { resolveCurrentAuthorityActor } from '../identity/staff.js'
import { decryptOutboxPayload, enqueueOutboxStatement } from '../jobs/outbox.js'
import { isCorrelationId } from '../logging/safe-log.js'
import {
  blindEmailCandidates,
  decryptForScope,
  encryptForScope,
} from '../security/envelope.js'

const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const DAY_MS = 24 * 60 * 60 * 1000
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const EMAIL_LOOKUP = /^v[1-9]\d*:[A-Za-z0-9_-]{43}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const INVITATION_ID = /^inv_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ACTION_ROW_KEYS = Object.freeze([
  'id',
  'fingerprint',
  'kind',
  'severity',
  'status',
  'entity_type',
  'entity_id',
  'details_envelope',
  'version',
  'created_at',
  'updated_at',
  'resolved_at',
])
const OUTBOX_JOB_ROW_KEYS = Object.freeze([
  'id',
  'type',
  'aggregate_type',
  'aggregate_id',
  'payload_envelope',
  'idempotency_key',
  'status',
  'attempt_count',
  'max_attempts',
  'scheduled_at',
  'lease_owner',
  'lease_expires_at',
  'last_error_code',
  'created_at',
  'updated_at',
])
const OUTBOX_ATTEMPT_ROW_KEYS = Object.freeze([
  'id',
  'job_id',
  'attempt_number',
  'started_at',
  'completed_at',
  'result',
  'error_code',
  'provider_reference',
])
const INVITATION_ROW_KEYS = Object.freeze([
  'id',
  'staff_id',
  'email_lookup',
  'email_envelope',
  'display_name_envelope',
  'role',
  'status',
  'inviter_id',
  'expires_at',
  'access_allowed_at',
  'email_sent_at',
  'activated_at',
  'revoked_at',
  'version',
  'created_at',
  'updated_at',
])
const EMAIL_PREPARATION_ROW_KEYS = Object.freeze([
  ...INVITATION_ROW_KEYS,
  'current_staff_id',
  'staff_email_lookup',
  'staff_email_envelope',
  'staff_display_name_envelope',
  'staff_role',
  'staff_status',
  'staff_version',
  'staff_created_at',
  'staff_updated_at',
])
const RECOVERABLE_ACCESS_ERRORS = new Set([
  'OUTBOX_HANDLER_FAILURE',
  'OUTBOX_HANDLER_RETRY',
  'OUTBOX_LEASE_EXPIRED',
])
const RECOVERABLE_EMAIL_ERRORS = new Set([
  'OUTBOX_HANDLER_FAILURE',
  'OUTBOX_HANDLER_RETRY',
])
const RECOVERABLE_TYPES = new Set([
  'staff.access.reconcile',
  'staff.invitation.email',
])

const exactObject = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const positive = (value) => Number.isSafeInteger(value) && value > 0
const validId = (value) => typeof value === 'string' && ID.test(value)
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const iso = (nowMs) => new Date(nowMs).toISOString()
const invalid = () => { throw new Error('VALIDATION_FAILED') }
const conflict = () => { throw new Error('OUTBOX_RECOVERY_CONFLICT') }
const unsafe = () => { throw new Error('OUTBOX_RECOVERY_UNSAFE') }
const idFrom = (factory) => {
  if (typeof factory !== 'function') invalid()
  const id = factory()
  if (!validId(id)) throw new Error('INTERNAL_ERROR')
  return id
}
const recoveryIdFrom = (factory) => {
  const id = `rcv_${idFrom(factory)}`
  if (!validId(id)) throw new Error('INTERNAL_ERROR')
  return id
}
const operationGuard = (db, operationId, predicate, bindings) => db.prepare(
  `INSERT INTO outbox_operation_guard_failures (operation_id)
   SELECT ? WHERE NOT (${predicate})`,
).bind(operationId, ...bindings)

function captureBody(value) {
  if (!exactObject(value, ['version']) || !positive(value.version)) invalid()
  return Object.freeze({ version: value.version })
}

async function activeOwner(db, actor, nowMs) {
  const captured = captureAuthorityActor(actor)
  if (!captured || !authorize(captured, 'staff.manage', CENTRE, { nowMs })) {
    throw new Error('FORBIDDEN')
  }
  const row = await db.prepare(
    `SELECT id,role,specialist_id,version
     FROM staff_users
     WHERE id=? AND role='owner' AND status='active' AND version=?`,
  ).bind(captured.id, captured.version).first()
  if (!row) throw new Error('FORBIDDEN')
  const current = await resolveCurrentAuthorityActor(db, row)
  if (current.id !== captured.id
    || current.role !== captured.role
    || current.specialistId !== captured.specialistId
    || current.version !== captured.version
    || current.authorityRevision !== captured.authorityRevision
    || current.capabilities.length !== captured.capabilities.length
    || current.capabilities.some((capability, index) => (
      capability !== captured.capabilities[index]
    ))
    || !authorize(current, 'staff.manage', CENTRE, { nowMs })) {
    throw new Error('FORBIDDEN')
  }
  return current
}

async function readAction(db, cryptoContext, actionId) {
  const row = await db.prepare(
    `SELECT id,fingerprint,kind,severity,status,entity_type,entity_id,
            details_envelope,version,created_at,updated_at,resolved_at
     FROM operational_actions WHERE id=?`,
  ).bind(actionId).first()
  if (!row) throw new Error('NOT_FOUND')
  if (!exactObject(row, ACTION_ROW_KEYS)
    || row.id !== actionId
    || !validId(row.id)
    || row.fingerprint !== `outbox.dead:${row.entity_id}`
    || row.kind !== 'outbox_job_failed'
    || row.severity !== 'critical'
    || !['open', 'resolved'].includes(row.status)
    || row.entity_type !== 'outbox_job'
    || !validId(row.entity_id)
    || typeof row.details_envelope !== 'string'
    || !validInstant(row.created_at)
    || !validInstant(row.updated_at)
    || (row.status === 'open'
      ? row.version !== 1
        || row.updated_at !== row.created_at
        || row.resolved_at !== null
      : row.version !== 2
        || !validInstant(row.resolved_at)
        || row.updated_at !== row.resolved_at)) {
    conflict()
  }
  let details
  try {
    details = JSON.parse(await decryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: cryptoContext.scope,
        recordId: row.id,
        field: 'action_details',
        envelope: JSON.parse(row.details_envelope),
      },
    ))
  } catch {
    throw new Error('CRYPTO_FAILURE')
  }
  if (!exactObject(details, ['errorCode', 'jobId', 'outboxType'])
    || details.jobId !== row.entity_id
    || !RECOVERABLE_TYPES.has(details.outboxType)
    || !ERROR_CODE.test(details.errorCode ?? '')) conflict()
  return Object.freeze({ row, details })
}

async function readSourceJob(db, cryptoContext, action) {
  const row = await db.prepare(
    'SELECT * FROM outbox_jobs WHERE id=?',
  ).bind(action.row.entity_id).first()
  if (!row
    || !exactObject(row, OUTBOX_JOB_ROW_KEYS)
    || row.id !== action.row.entity_id
    || !validId(row.id)
    || row.status !== 'dead'
    || !positive(row.attempt_count)
    || row.max_attempts !== 8
    || row.attempt_count > 8
    || !validInstant(row.scheduled_at)
    || !validInstant(row.created_at)
    || !validInstant(row.updated_at)
    || row.updated_at < row.created_at
    || row.lease_owner !== null
    || row.lease_expires_at !== null
    || row.last_error_code !== action.details.errorCode
    || !ERROR_CODE.test(row.last_error_code ?? '')
    || row.type !== action.details.outboxType
    || (row.type === 'staff.access.reconcile'
      && ['OUTBOX_HANDLER_RETRY', 'OUTBOX_LEASE_EXPIRED'].includes(row.last_error_code)
      && row.attempt_count !== row.max_attempts)
    || (row.type === 'staff.access.reconcile'
      ? row.aggregate_type !== 'access_group' || row.aggregate_id !== 'centre_1'
      : row.aggregate_type !== 'staff_invitation'
        || !INVITATION_ID.test(row.aggregate_id))) conflict()
  const terminalAttempt = await db.prepare(
    `SELECT id,job_id,attempt_number,started_at,completed_at,result,error_code,
            provider_reference
     FROM outbox_attempts WHERE job_id=? AND attempt_number=?`,
  ).bind(row.id, row.attempt_count).first()
  if (!terminalAttempt
    || !exactObject(terminalAttempt, OUTBOX_ATTEMPT_ROW_KEYS)
    || !validId(terminalAttempt.id)
    || terminalAttempt.job_id !== row.id
    || terminalAttempt.attempt_number !== row.attempt_count
    || !validInstant(terminalAttempt.started_at)
    || !validInstant(terminalAttempt.completed_at)
    || terminalAttempt.completed_at < terminalAttempt.started_at
    || terminalAttempt.completed_at !== row.updated_at
    || terminalAttempt.result !== 'dead'
    || terminalAttempt.error_code !== row.last_error_code
    || terminalAttempt.provider_reference !== null) conflict()
  let payload
  try {
    payload = await decryptOutboxPayload(cryptoContext, row)
  } catch {
    conflict()
  }
  if (row.type === 'staff.access.reconcile') {
    if (!exactObject(payload, ['actorId', 'generation'])
      || !STAFF_ID.test(payload.actorId ?? '')
      || !Number.isSafeInteger(payload.generation)
      || payload.generation < 0
      || row.idempotency_key !== `staff.access.reconcile:${payload.generation}`) conflict()
  } else if (!exactObject(payload, ['actorId', 'invitationId'])
    || !STAFF_ID.test(payload.actorId ?? '')
    || payload.invitationId !== row.aggregate_id
    || !positive(Number(row.idempotency_key.slice(
      `staff.invitation.email:${row.aggregate_id}:`.length,
    )))
    || row.idempotency_key !== `staff.invitation.email:${row.aggregate_id}:${Number(
      row.idempotency_key.slice(`staff.invitation.email:${row.aggregate_id}:`.length),
    )}`) conflict()
  return row
}

async function desiredGeneration(db) {
  const row = await db.prepare(
    `SELECT key,value_json,version,updated_at
     FROM system_state WHERE key='access.desired_generation'`,
  ).first()
  let value
  try { value = JSON.parse(row?.value_json) } catch { throw new Error('INTERNAL_ERROR') }
  if (!row || !exactObject(value, ['generation'])
    || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !positive(row.version)) throw new Error('INTERNAL_ERROR')
  return Object.freeze({ row, generation: value.generation })
}

function idempotencyInput(owner, actionId, version, idempotencyKey, scope) {
  return Object.freeze({
    actorId: owner.id,
    operation: 'outbox.recovery.request',
    idempotencyKey,
    requestDigest: JSON.stringify({ actionId, version }),
    expectedScope: scope,
  })
}

function versionConflict(currentVersion) {
  const error = new Error('VERSION_CONFLICT')
  error.details = { currentVersion }
  throw error
}

async function accessPreparation(db, source, owner, now) {
  if (!RECOVERABLE_ACCESS_ERRORS.has(source.last_error_code)) conflict()
  const desired = await desiredGeneration(db)
  const nextGeneration = desired.generation + 1
  if (!Number.isSafeInteger(nextGeneration)) throw new Error('INTERNAL_ERROR')
  return Object.freeze({
    kind: 'access',
    desiredGeneration: nextGeneration,
    invitationVersion: null,
    replacementKey: `staff.access.reconcile:${nextGeneration}`,
    replacement: Object.freeze({
      type: 'staff.access.reconcile',
      aggregateType: 'access_group',
      aggregateId: 'centre_1',
      payload: Object.freeze({ actorId: owner.id, generation: nextGeneration }),
    }),
    domainStatement: db.prepare(
      `UPDATE system_state
       SET value_json=?,version=version+1,updated_at=?
       WHERE key='access.desired_generation' AND value_json=? AND version=?`,
    ).bind(
      JSON.stringify({ generation: nextGeneration }),
      now,
      desired.row.value_json,
      desired.row.version,
    ),
    versionStatement: null,
    guardSql: `EXISTS (
       SELECT 1 FROM system_state
       WHERE key='access.desired_generation' AND value_json=? AND version=?
     )`,
    guardBindings: Object.freeze([
      JSON.stringify({ generation: nextGeneration }),
      desired.row.version + 1,
    ]),
  })
}

async function emailDeliveryEvidence(db, invitationId, excludedJobId) {
  const evidence = await db.prepare(
    `SELECT
       EXISTS (
         SELECT 1
         FROM delivery_attempts AS delivery
         JOIN outbox_jobs AS job ON job.id=delivery.outbox_job_id
         WHERE job.type='staff.invitation.email'
           AND job.aggregate_type='staff_invitation' AND job.aggregate_id=?
           AND delivery.status='accepted'
       ) AS accepted_delivery,
       EXISTS (
         SELECT 1 FROM outbox_jobs
         WHERE type='staff.invitation.email'
           AND aggregate_type='staff_invitation' AND aggregate_id=? AND id!=?
           AND status IN ('queued','processing','succeeded')
       ) AS other_delivery_job`,
  ).bind(invitationId, invitationId, excludedJobId).first()
  if (!exactObject(evidence, ['accepted_delivery', 'other_delivery_job'])
    || ![0, 1].includes(evidence.accepted_delivery)
    || ![0, 1].includes(evidence.other_delivery_job)) conflict()
  return evidence
}

async function emailPreparation(
  db,
  cryptoContext,
  source,
  owner,
  now,
  correlationId,
  idFactory,
) {
  if (source.last_error_code === 'EMAIL_DELIVERY_AMBIGUOUS') unsafe()
  if (!RECOVERABLE_EMAIL_ERRORS.has(source.last_error_code)
    || (source.last_error_code === 'OUTBOX_HANDLER_RETRY'
      && source.attempt_count !== source.max_attempts)) conflict()
  const row = await db.prepare(
    `SELECT invitation.id,invitation.staff_id,invitation.email_lookup,
            invitation.email_envelope,invitation.display_name_envelope,
            invitation.role,invitation.status,invitation.inviter_id,
            invitation.expires_at,invitation.access_allowed_at,
            invitation.email_sent_at,invitation.activated_at,
            invitation.revoked_at,invitation.version,invitation.created_at,
            invitation.updated_at,staff.id AS current_staff_id,
            staff.email_lookup AS staff_email_lookup,
            staff.email_envelope AS staff_email_envelope,
            staff.display_name_envelope AS staff_display_name_envelope,
            staff.role AS staff_role,staff.status AS staff_status,
            staff.version AS staff_version,staff.created_at AS staff_created_at,
            staff.updated_at AS staff_updated_at
     FROM staff_invitations AS invitation
     JOIN staff_users AS staff ON staff.id=invitation.staff_id
     WHERE invitation.id=?`,
  ).bind(source.aggregate_id).first()
  if (!row
    || !exactObject(row, EMAIL_PREPARATION_ROW_KEYS)
    || !INVITATION_ID.test(row.id ?? '')
    || row.id !== source.aggregate_id
    || !STAFF_ID.test(row.staff_id ?? '')
    || row.current_staff_id !== row.staff_id
    || !STAFF_ID.test(row.inviter_id ?? '')
    || !EMAIL_LOOKUP.test(row.email_lookup ?? '')
    || row.staff_email_lookup !== row.email_lookup
    || !['owner', 'coordinator', 'specialist'].includes(row.role)
    || row.staff_role !== row.role
    || row.status !== 'pending'
    || row.staff_status !== 'pending'
    || !validInstant(row.expires_at)
    || row.expires_at <= now
    || !validInstant(row.access_allowed_at)
    || row.access_allowed_at > now
    || row.email_sent_at !== null
    || row.activated_at !== null
    || row.revoked_at !== null
    || !positive(row.version)
    || !positive(row.staff_version)
    || !validInstant(row.created_at)
    || !validInstant(row.updated_at)
    || row.updated_at < row.created_at
    || !validInstant(row.staff_created_at)
    || !validInstant(row.staff_updated_at)
    || row.staff_updated_at < row.staff_created_at
    || source.idempotency_key !== `staff.invitation.email:${row.id}:${row.version}`) conflict()
  let invitationEmail
  let invitationDisplayName
  let staffEmail
  let staffDisplayName
  try {
    [invitationEmail, invitationDisplayName, staffEmail, staffDisplayName] = await Promise.all([
      decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
        expectedScope: cryptoContext.scope,
        recordId: row.id,
        field: 'email',
        envelope: JSON.parse(row.email_envelope),
      }),
      decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
        expectedScope: cryptoContext.scope,
        recordId: row.id,
        field: 'display_name',
        envelope: JSON.parse(row.display_name_envelope),
      }),
      decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
        expectedScope: cryptoContext.scope,
        recordId: row.staff_id,
        field: 'email',
        envelope: JSON.parse(row.staff_email_envelope),
      }),
      decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
        expectedScope: cryptoContext.scope,
        recordId: row.staff_id,
        field: 'display_name',
        envelope: JSON.parse(row.staff_display_name_envelope),
      }),
    ])
  } catch {
    conflict()
  }
  if (invitationEmail !== staffEmail
    || normalizeCanonicalEmail(invitationEmail) !== invitationEmail
    || invitationDisplayName !== staffDisplayName
    || typeof invitationDisplayName !== 'string'
    || invitationDisplayName.length < 1) conflict()
  let lookupCandidates
  try {
    lookupCandidates = await blindEmailCandidates(invitationEmail, cryptoContext.keyring)
  } catch {
    conflict()
  }
  if (!Array.isArray(lookupCandidates)
    || !lookupCandidates.includes(row.email_lookup)) conflict()
  const evidence = await emailDeliveryEvidence(db, row.id, source.id)
  if (evidence.accepted_delivery !== 0 || evidence.other_delivery_job !== 0) unsafe()
  const nextVersion = row.version + 1
  if (!Number.isSafeInteger(nextVersion)) throw new Error('INTERNAL_ERROR')
  const invitation = Object.fromEntries(INVITATION_ROW_KEYS.map((key) => [key, row[key]]))
  const next = Object.freeze({
    ...invitation,
    version: nextVersion,
    updated_at: now,
  })
  const versionId = idFrom(idFactory)
  const snapshotEnvelope = JSON.stringify(await encryptForScope(
    cryptoContext.keyring,
    cryptoContext.dataKey,
    {
      expectedScope: cryptoContext.scope,
      recordId: next.id,
      field: 'record_version',
      plaintext: JSON.stringify(next),
    },
  ))
  return Object.freeze({
    kind: 'email',
    desiredGeneration: null,
    invitationVersion: nextVersion,
    replacementKey: `staff.invitation.email:${row.id}:${nextVersion}`,
    replacement: Object.freeze({
      type: 'staff.invitation.email',
      aggregateType: 'staff_invitation',
      aggregateId: row.id,
      payload: Object.freeze({ actorId: owner.id, invitationId: row.id }),
    }),
    domainStatement: db.prepare(
      `UPDATE staff_invitations
       SET version=version+1,updated_at=?
       WHERE id=? AND staff_id=? AND email_lookup=? AND email_envelope=?
         AND display_name_envelope=? AND role=? AND status='pending'
         AND inviter_id=? AND expires_at=? AND expires_at>?
         AND access_allowed_at=? AND access_allowed_at IS NOT NULL
         AND email_sent_at IS NULL AND activated_at IS NULL AND revoked_at IS NULL
         AND version=? AND created_at=? AND updated_at=?
         AND EXISTS (
           SELECT 1 FROM staff_users
           WHERE id=? AND email_lookup=? AND email_envelope=?
             AND display_name_envelope=? AND role=? AND status=? AND version=?
             AND created_at=? AND updated_at=?
         )`,
    ).bind(
      now,
      row.id,
      row.staff_id,
      row.email_lookup,
      row.email_envelope,
      row.display_name_envelope,
      row.role,
      row.inviter_id,
      row.expires_at,
      now,
      row.access_allowed_at,
      row.version,
      row.created_at,
      row.updated_at,
      row.staff_id,
      row.staff_email_lookup,
      row.staff_email_envelope,
      row.staff_display_name_envelope,
      row.staff_role,
      row.staff_status,
      row.staff_version,
      row.staff_created_at,
      row.staff_updated_at,
    ),
    versionId,
    versionStatement: db.prepare(
      `INSERT INTO record_versions
       (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
        changed_at,correlation_id)
       SELECT ?,'staff_invitation',?,?,?,?,?,? WHERE changes()=1`,
    ).bind(
      versionId,
      row.id,
      nextVersion,
      snapshotEnvelope,
      owner.id,
      now,
      correlationId,
    ),
    guardSql: `EXISTS (
       SELECT 1 FROM staff_invitations
       WHERE id=? AND staff_id=? AND email_lookup=? AND email_envelope=?
         AND display_name_envelope=? AND role=? AND status='pending'
         AND inviter_id=? AND expires_at=? AND expires_at>?
         AND access_allowed_at=? AND access_allowed_at IS NOT NULL
         AND email_sent_at IS NULL AND activated_at IS NULL AND revoked_at IS NULL
         AND version=? AND created_at=? AND updated_at=?
     )
     AND EXISTS (
       SELECT 1 FROM record_versions
       WHERE id=? AND entity_type='staff_invitation' AND entity_id=? AND version=?
         AND changed_by_staff_id=? AND changed_at=? AND correlation_id=?
     )
     AND EXISTS (
       SELECT 1 FROM staff_users
       WHERE id=? AND email_lookup=? AND email_envelope=?
         AND display_name_envelope=? AND role=? AND status=? AND version=?
         AND created_at=? AND updated_at=?
     )`,
    guardBindings: Object.freeze([
      row.id,
      row.staff_id,
      row.email_lookup,
      row.email_envelope,
      row.display_name_envelope,
      row.role,
      row.inviter_id,
      row.expires_at,
      now,
      row.access_allowed_at,
      nextVersion,
      row.created_at,
      now,
      versionId,
      row.id,
      nextVersion,
      owner.id,
      now,
      correlationId,
      row.staff_id,
      row.staff_email_lookup,
      row.staff_email_envelope,
      row.staff_display_name_envelope,
      row.staff_role,
      row.staff_status,
      row.staff_version,
      row.staff_created_at,
      row.staff_updated_at,
    ]),
  })
}

async function classifyCommitRace({
  db,
  cryptoContext,
  actor,
  action,
  source,
  nowMs,
  error,
}) {
  if (!isD1OutboxOperationGuardFailure(error)
    && !isD1InvalidOutboxRecoveryEdge(error)) throw error
  await activeOwner(db, actor, nowMs)
  const currentAction = await readAction(db, cryptoContext, action.row.id)
  if (currentAction.row.status !== action.row.status
    || currentAction.row.version !== action.row.version) {
    versionConflict(currentAction.row.version)
  }
  const existing = await db.prepare(
    `SELECT replacement_job_id FROM outbox_job_recoveries
     WHERE source_job_id=? OR operational_action_id=?`,
  ).bind(source.id, action.row.id).first()
  if (existing) conflict()
  const currentSource = await readSourceJob(db, cryptoContext, currentAction)
  if (currentSource.type === 'staff.invitation.email') {
    const evidence = await emailDeliveryEvidence(
      db,
      currentSource.aggregate_id,
      currentSource.id,
    )
    if (evidence.accepted_delivery !== 0 || evidence.other_delivery_job !== 0) unsafe()
  }
  conflict()
}

export async function requestOutboxRecovery({
  db,
  cryptoContext,
  actor,
  actionId,
  body,
  idempotencyKey,
  correlationId,
  nowMs,
  idFactory = () => crypto.randomUUID().replaceAll('-', ''),
} = {}) {
  if (!db?.prepare || !db?.batch || !cryptoContext?.keyring
    || !cryptoContext?.dataKey || !cryptoContext?.scope
    || !validId(actionId) || !IDEMPOTENCY_KEY.test(idempotencyKey ?? '')
    || !isCorrelationId(correlationId)
    || !Number.isSafeInteger(nowMs) || nowMs < 0
    || typeof idFactory !== 'function') invalid()
  const request = captureBody(body)
  const owner = await activeOwner(db, actor, nowMs)
  const idem = idempotencyInput(
    owner,
    actionId,
    request.version,
    idempotencyKey,
    cryptoContext.scope,
  )
  const replay = await inspectIdempotency(db, cryptoContext, idem)
  if (replay) return replay.body
  const action = await readAction(db, cryptoContext, actionId)
  if (action.row.status !== 'open' || action.row.version !== request.version) {
    versionConflict(action.row.version)
  }
  const existing = await db.prepare(
    `SELECT replacement_job_id FROM outbox_job_recoveries
     WHERE source_job_id=? OR operational_action_id=?`,
  ).bind(action.row.entity_id, action.row.id).first()
  if (existing) conflict()
  const source = await readSourceJob(db, cryptoContext, action)
  const now = iso(nowMs)
  const preparation = source.type === 'staff.access.reconcile'
    ? await accessPreparation(db, source, owner, now)
    : await emailPreparation(
        db,
        cryptoContext,
        source,
        owner,
        now,
        correlationId,
        idFactory,
      )
  const auditId = idFrom(idFactory)
  const replacementJobId = idFrom(idFactory)
  const recoveryId = recoveryIdFrom(idFactory)
  const emailSafetySql = preparation.kind === 'email'
    ? `NOT EXISTS (
         SELECT 1
         FROM delivery_attempts AS delivery
         JOIN outbox_jobs AS job ON job.id=delivery.outbox_job_id
         WHERE job.type='staff.invitation.email'
           AND job.aggregate_type='staff_invitation' AND job.aggregate_id=?
           AND delivery.status='accepted'
       )
       AND NOT EXISTS (
         SELECT 1 FROM outbox_jobs
         WHERE type='staff.invitation.email'
           AND aggregate_type='staff_invitation' AND aggregate_id=?
           AND id NOT IN (?,?)
           AND status IN ('queued','processing','succeeded')
       )`
    : '1=1'
  const emailSafetyBindings = preparation.kind === 'email'
    ? [source.aggregate_id, source.aggregate_id, source.id, replacementJobId]
    : []
  const result = Object.freeze({
    data: Object.freeze({
      action: Object.freeze({ id: action.row.id, status: 'open', version: action.row.version }),
      recovery: Object.freeze({ kind: preparation.kind, status: 'queued' }),
    }),
  })
  const unit = createUnitOfWork(db, {
    mode: 'mutation',
    actorId: owner.id,
    correlationId,
  })
  unit.domain(preparation.domainStatement)
  if (preparation.versionStatement) unit.version(preparation.versionStatement)
  unit.outbox(await enqueueOutboxStatement(db, cryptoContext, {
    id: replacementJobId,
    ...preparation.replacement,
    idempotencyKey: preparation.replacementKey,
    scheduledAt: now,
    nowMs,
    ...(preparation.kind === 'access' ? { onlyIfPreviousStatementChanged: true } : {}),
  }))
  unit.domain(db.prepare(
    `INSERT INTO outbox_job_recoveries
     (id,source_job_id,replacement_job_id,operational_action_id,
      requested_by_staff_id,correlation_id,created_at)
     SELECT ?,?,?,?,?,?,? WHERE changes()=1`,
  ).bind(
    recoveryId,
    source.id,
    replacementJobId,
    action.row.id,
    owner.id,
    correlationId,
    now,
  ))
  unit.audit(auditEventStatement(db, {
    id: auditId,
    occurredAt: now,
    actorStaffId: owner.id,
    action: 'outbox.recovery.requested',
    entityType: 'outbox_job',
    entityId: source.id,
    result: 'success',
    correlationId,
    metadata: {
      actionVersion: action.row.version,
      desiredGeneration: preparation.desiredGeneration,
      invitationVersion: preparation.invitationVersion,
      replacementJobId,
    },
    reasonEnvelope: null,
  }))
  unit.idempotency(await createIdempotencyStatement(db, cryptoContext, {
    ...idem,
    resourceType: 'outbox_recovery',
    resourceId: recoveryId,
    response: { status: 202, body: result },
    createdAt: now,
    expiresAt: iso(nowMs + DAY_MS),
  }))
  unit.guard(operationGuard(
    db,
    `outbox_recovery_${recoveryId}`,
    `${preparation.guardSql}
     AND ${emailSafetySql}
     AND EXISTS (
       SELECT 1
       FROM staff_users AS staff
       JOIN staff_authorities AS authority ON authority.staff_id=staff.id
       WHERE staff.id=? AND staff.role='owner' AND staff.status='active'
         AND staff.specialist_id IS ? AND staff.version=?
         AND authority.revision=?
     )
     AND EXISTS (
       SELECT 1 FROM outbox_jobs
       WHERE id=? AND type=? AND status='dead'
         AND last_error_code=?
     )
     AND EXISTS (
       SELECT 1 FROM operational_actions
       WHERE id=? AND fingerprint=? AND kind='outbox_job_failed'
         AND status='open' AND entity_type='outbox_job' AND entity_id=? AND version=?
     )
     AND EXISTS (
       SELECT 1 FROM outbox_jobs
       WHERE id=? AND type=? AND aggregate_type=? AND aggregate_id=?
         AND idempotency_key=? AND status='queued' AND attempt_count=0
     )
     AND EXISTS (
       SELECT 1 FROM outbox_job_recoveries
       WHERE id=? AND source_job_id=? AND replacement_job_id=?
         AND operational_action_id=? AND requested_by_staff_id=?
         AND correlation_id=? AND created_at=?
     )
     AND EXISTS (
       SELECT 1 FROM idempotency_records
       WHERE actor_id=? AND operation='outbox.recovery.request'
         AND idempotency_key=? AND resource_type='outbox_recovery' AND resource_id=?
     )`,
    [
      ...preparation.guardBindings,
      ...emailSafetyBindings,
      owner.id,
      owner.specialistId,
      owner.version,
      owner.authorityRevision,
      source.id,
      source.type,
      source.last_error_code,
      action.row.id,
      action.row.fingerprint,
      source.id,
      action.row.version,
      replacementJobId,
      preparation.replacement.type,
      preparation.replacement.aggregateType,
      preparation.replacement.aggregateId,
      preparation.replacementKey,
      recoveryId,
      source.id,
      replacementJobId,
      action.row.id,
      owner.id,
      correlationId,
      now,
      owner.id,
      idempotencyKey,
      recoveryId,
    ],
  ))
  try {
    await unit.commit()
    return result
  } catch (error) {
    if (isD1IdentityCollision(error)) {
      try {
        const recovered = await recoverIdempotencyAfterCollision(
          db,
          cryptoContext,
          idem,
          error,
        )
        return recovered.body
      } catch (recoveryError) {
        if (recoveryError !== error) throw recoveryError
      }
      conflict()
    }
    return classifyCommitRace({
      db,
      cryptoContext,
      actor,
      action,
      source,
      nowMs,
      error,
    })
  }
}
