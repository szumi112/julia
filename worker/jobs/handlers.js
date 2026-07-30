import { decryptForScope } from '../security/envelope.js'
import { sendInvitationEmail } from '../providers/scaleway-email.js'
import { expireInvitation } from '../identity/invitations.js'
import {
  accessDesiredFingerprint,
  acquireAccessReconcileLease,
  desiredAccessMembership,
  handleAccessReconcile as reconcileAccess,
} from './access-reconciliation.js'
import { decryptOutboxPayload, validProcessingJob } from './outbox.js'

const iso = (nowMs) => new Date(nowMs).toISOString()
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const randomId = () => crypto.randomUUID().replaceAll('-', '')
const randomCorrelationId = () => crypto.randomUUID()
const validId = (value) => typeof value === 'string' && ID.test(value)
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const exactRow = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const emailFor = (context, row) => decryptForScope(context.keyring, context.dataKey, {
  expectedScope: context.scope, recordId: row.id, field: 'email', envelope: JSON.parse(row.email_envelope),
})

export async function desiredAccessEmails(db, cryptoContext, nowMs) {
  return [...(await desiredAccessMembership(db, cryptoContext, nowMs)).emails]
}

export { accessDesiredFingerprint, acquireAccessReconcileLease, desiredAccessMembership }

export async function handleAccessReconcile(input) {
  return reconcileAccess({
    ...input,
    idFactory: input.idFactory ?? randomId,
    leaseOwnerFactory: input.leaseOwnerFactory ?? randomId,
    leaseNonceFactory: input.leaseNonceFactory ?? randomId,
    correlationIdFactory: input.correlationIdFactory ?? randomCorrelationId,
  })
}

export async function handleInvitationEmail({ db, cryptoContext, config, job, payload, nowMs, providers = {} }) {
  const invitation = await db.prepare(
    `SELECT i.*,s.status AS staff_status
     FROM staff_invitations i JOIN staff_users s ON s.id=i.staff_id
     WHERE i.id=?`
  ).bind(payload.invitationId).first()
  const now = iso(nowMs)
  if (!invitation || invitation.staff_status !== 'pending' || invitation.status !== 'pending'
    || invitation.expires_at <= now || invitation.email_sent_at !== null) return { result: 'succeeded' }
  const recipient = await emailFor(cryptoContext, invitation)
  const send = providers.sendInvitationEmail ?? sendInvitationEmail
  try {
    const accepted = await send({ ...config.emailProvider, appOrigin: config.appOrigin, jobId: job.id, recipient, expiresAt: invitation.expires_at, fetch: providers.fetch ?? fetch })
    const nextVersion = invitation.version + 1
    await db.batch([
      db.prepare('INSERT INTO delivery_attempts (id,outbox_job_id,provider,provider_reference,status,error_code,attempted_at) VALUES (?,?,?,?,?,?,?)')
        .bind(providers.idFactory?.() ?? crypto.randomUUID().replaceAll('-', ''), job.id, 'scaleway_tem', accepted.providerId, 'accepted', null, now),
      db.prepare('UPDATE staff_invitations SET email_sent_at=?,version=version+1,updated_at=? WHERE id=? AND version=? AND email_sent_at IS NULL')
        .bind(now, now, invitation.id, invitation.version),
    ])
    return { result: 'succeeded', providerReference: accepted.providerId }
  } catch (error) {
    return { result: error.ambiguous ? 'dead' : error.retryable ? 'retry' : 'dead', errorCode: error.message }
  }
}

export async function handleInvitationExpiry({
  db,
  cryptoContext,
  payload,
  nowMs,
  idFactory = randomId,
  correlationIdFactory = randomCorrelationId,
}) {
  await expireInvitation({
    db,
    cryptoContext,
    actorId: payload.actorId,
    invitationId: payload.invitationId,
    correlationId: correlationIdFactory(),
    nowMs,
    idFactory,
  })
  return { result: 'succeeded' }
}

async function authoritativeClaim(input) {
  if (!input?.db?.prepare || !input.job
    || !validId(input.job.id)
    || !validId(input.job.attemptId)
    || !validId(input.job.leaseOwner)
    || !validId(input.job.lease_owner)
    || !validInstant(input.job.lease_expires_at)
    || !Number.isSafeInteger(input.job.attemptNumber)
    || input.job.attemptNumber < 1
    || !Number.isSafeInteger(input.job.attempt_count)
    || input.job.attempt_count < 1
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) return null
  const now = iso(input.nowMs)
  const row = await input.db.prepare(
    'SELECT * FROM outbox_jobs WHERE id=?'
  ).bind(input.job.id).first()
  if (!exactRow(row, [
    'id', 'type', 'aggregate_type', 'aggregate_id', 'payload_envelope',
    'idempotency_key', 'status', 'attempt_count', 'max_attempts', 'scheduled_at',
    'lease_owner', 'lease_expires_at', 'last_error_code', 'created_at', 'updated_at',
  ])
    || !validProcessingJob(row)
    || !validId(row.id)
    || row.id !== input.job.id
    || !validId(row.aggregate_id)
    || typeof row.type !== 'string'
    || typeof row.aggregate_type !== 'string'
    || typeof row.payload_envelope !== 'string'
    || typeof row.idempotency_key !== 'string'
    || !Number.isSafeInteger(row.attempt_count)
    || row.attempt_count < 1
    || !Number.isSafeInteger(row.max_attempts)
    || row.max_attempts < row.attempt_count
    || row.max_attempts > 8
    || !validInstant(row.scheduled_at)
    || !validId(row.lease_owner)
    || !validInstant(row.lease_expires_at)
    || !validInstant(row.created_at)
    || !validInstant(row.updated_at)
    || row.type !== input.job.type
    || row.aggregate_type !== input.job.aggregate_type
    || row.aggregate_id !== input.job.aggregate_id
    || row.status !== 'processing'
    || input.job.status !== 'processing'
    || row.attempt_count !== input.job.attemptNumber
    || row.attempt_count !== input.job.attempt_count
    || row.lease_owner !== input.job.leaseOwner
    || row.lease_owner !== input.job.lease_owner
    || row.lease_expires_at !== input.job.lease_expires_at
    || row.lease_expires_at <= now) return null
  const aggregateValid = row.type === 'staff.access.reconcile'
    ? row.aggregate_type === 'access_group' && row.aggregate_id === 'centre_1'
    : ['staff.invitation.email', 'staff.invitation.expire'].includes(row.type)
      && row.aggregate_type === 'staff_invitation'
      && /^inv_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(row.aggregate_id)
  if (!aggregateValid) return null
  const attempt = await input.db.prepare(
    `SELECT id,job_id,attempt_number,started_at,completed_at,result,error_code,
            provider_reference
     FROM outbox_attempts
     WHERE job_id=? AND attempt_number=?`
  ).bind(row.id, row.attempt_count).first()
  if (!exactRow(attempt, [
    'id', 'job_id', 'attempt_number', 'started_at', 'completed_at', 'result',
    'error_code', 'provider_reference',
  ])
    || !validId(attempt.id)
    || attempt.id !== input.job.attemptId
    || !validId(attempt.job_id)
    || attempt.job_id !== row.id
    || attempt.attempt_number !== row.attempt_count
    || !validInstant(attempt.started_at)
    || attempt.completed_at !== null
    || attempt.result !== null
    || attempt.error_code !== null
    || attempt.provider_reference !== null) return null
  return row
}

export async function dispatchOutboxJob(input) {
  const current = await authoritativeClaim(input)
  if (!current) return { result: 'retry' }
  let payload
  try {
    payload = await decryptOutboxPayload(input.cryptoContext, current)
  } catch { return { result: 'dead', errorCode: 'CRYPTO_FAILURE' } }
  if (current.type === 'staff.access.reconcile') {
    return handleAccessReconcile({ ...input, job: current, payload })
  }
  if (current.type === 'staff.invitation.email') {
    return handleInvitationEmail({ ...input, job: current, payload })
  }
  return handleInvitationExpiry({ ...input, job: current, payload })
}
