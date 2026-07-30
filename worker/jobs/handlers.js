import { loadEmailProviderConfig } from '../config.js'
import { decodeBase64Url, encodeBase64Url } from '../security/encoding.js'
import { blindEmailCandidates, decryptForScope } from '../security/envelope.js'
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
const EMAIL = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+$/u
const PROVIDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PROVIDER_RUNWAY_MS = 11_000
const randomId = () => crypto.randomUUID().replaceAll('-', '')
const randomCorrelationId = () => crypto.randomUUID()
const validId = (value) => typeof value === 'string' && ID.test(value)
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const exactRow = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const nullableInstant = (value) => value === null || validInstant(value)
const invitationLifecycleValid = (row) => {
  const activated = row.activated_at !== null
  const revoked = row.revoked_at !== null
  if (row.status === 'activated') {
    return activated && !revoked && row.access_allowed_at !== null
  }
  if (row.status === 'revoked') return revoked && !activated
  if (activated || revoked) return false
  if (row.status === 'provisioning') return row.access_allowed_at === null
  if (row.status === 'pending') return row.access_allowed_at !== null
  return row.status === 'expired'
}
const INVITATION_EMAIL_ROW_KEYS = Object.freeze([
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
  'staff_email_lookup',
  'staff_email_envelope',
  'staff_status',
  'staff_version',
])
const ENVELOPE_KEYS = Object.freeze([
  'format',
  'algorithm',
  'dataKeyId',
  'dataKeyVersion',
  'nonce',
  'ciphertext',
])
const validEnvelope = (value) => {
  if (typeof value !== 'string' || value.length > 4096) return false
  let nonce
  let ciphertext
  try {
    const parsed = JSON.parse(value)
    if (!exactRow(parsed, ENVELOPE_KEYS)
      || parsed.format !== 1
      || parsed.algorithm !== 'A256GCM'
      || !validId(parsed.dataKeyId)
      || !Number.isSafeInteger(parsed.dataKeyVersion)
      || parsed.dataKeyVersion < 1
      || typeof parsed.nonce !== 'string'
      || typeof parsed.ciphertext !== 'string') return false
    nonce = decodeBase64Url(parsed.nonce)
    ciphertext = decodeBase64Url(parsed.ciphertext)
    return nonce.byteLength === 12
      && ciphertext.byteLength >= 16
      && encodeBase64Url(nonce) === parsed.nonce
      && encodeBase64Url(ciphertext) === parsed.ciphertext
  } catch {
    return false
  } finally {
    nonce?.fill(0)
    ciphertext?.fill(0)
  }
}
const emailJobKey = (invitationId, version) => (
  `staff.invitation.email:${invitationId}:${version}`
)
const emailFor = (context, row) => decryptForScope(
  context.keyring,
  context.dataKey,
  {
    expectedScope: context.scope,
    recordId: row.id,
    field: 'email',
    envelope: JSON.parse(row.email_envelope),
  },
)
const canonicalRecipient = (value) => {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFC').trim().toLowerCase()
  return value === normalized
    && new TextEncoder().encode(value).byteLength <= 254
    && EMAIL.test(value)
    && !value.startsWith('.')
    && !value.includes('..')
    && !value.includes('.@')
    && value.endsWith('@example.test')
    ? value
    : null
}
const fixedProviderFailure = (error) => {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') {
    return { result: 'dead' }
  }
  let descriptors
  try {
    descriptors = Object.getOwnPropertyDescriptors(error)
  } catch {
    return { result: 'dead' }
  }
  const code = descriptors.code?.value
  const retryable = descriptors.retryable?.value
  const ambiguous = descriptors.ambiguous?.value
  if (code === 'EMAIL_PROVIDER_RATE_LIMITED'
    && retryable === true && ambiguous === false) return { result: 'retry' }
  if (['EMAIL_PROVIDER_REJECTED', 'EMAIL_PROVIDER_CONFIG_INVALID'].includes(code)
    && retryable === false && ambiguous === false) return { result: 'dead' }
  if (code === 'EMAIL_DELIVERY_AMBIGUOUS'
    && retryable === false && ambiguous === true) {
    return { result: 'dead', errorCode: 'EMAIL_DELIVERY_AMBIGUOUS' }
  }
  return { result: 'dead' }
}

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

export async function handleInvitationEmail({
  db,
  cryptoContext,
  config,
  bindings,
  job,
  payload,
  nowMs,
  nowFactory = Date.now,
  providers = {},
}) {
  const invitation = await db.prepare(
    `SELECT i.id,i.staff_id,i.email_lookup,i.email_envelope,
            i.display_name_envelope,i.role,i.status,i.inviter_id,i.expires_at,
            i.access_allowed_at,i.email_sent_at,i.activated_at,i.revoked_at,
            i.version,i.created_at,i.updated_at,
            s.email_lookup AS staff_email_lookup,
            s.email_envelope AS staff_email_envelope,
            s.status AS staff_status,s.version AS staff_version
     FROM staff_invitations i JOIN staff_users s ON s.id=i.staff_id
     WHERE i.id=?`
  ).bind(payload.invitationId).first()
  const now = iso(nowMs)
  if (!invitation) {
    return { result: 'succeeded' }
  }
  if (!exactRow(invitation, INVITATION_EMAIL_ROW_KEYS)
    || !/^inv_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(invitation.id ?? '')
    || !/^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(invitation.staff_id ?? '')
    || !/^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(invitation.inviter_id ?? '')
    || !['owner', 'coordinator', 'specialist'].includes(invitation.role)
    || !['provisioning', 'pending', 'activated', 'revoked', 'expired'].includes(invitation.status)
    || !['pending', 'active', 'disabled'].includes(invitation.staff_status)
    || typeof invitation.email_lookup !== 'string'
    || invitation.email_lookup.length === 0
    || typeof invitation.staff_email_lookup !== 'string'
    || invitation.staff_email_lookup.length === 0
    || !validEnvelope(invitation.email_envelope)
    || !validEnvelope(invitation.staff_email_envelope)
    || !validEnvelope(invitation.display_name_envelope)
    || invitation.id !== job.aggregate_id
    || !validInstant(invitation.expires_at)
    || !nullableInstant(invitation.access_allowed_at)
    || !nullableInstant(invitation.email_sent_at)
    || !nullableInstant(invitation.activated_at)
    || !nullableInstant(invitation.revoked_at)
    || !invitationLifecycleValid(invitation)
    || !validInstant(invitation.created_at)
    || !validInstant(invitation.updated_at)
    || invitation.updated_at < invitation.created_at
    || !Number.isSafeInteger(invitation.version)
    || invitation.version < 1
    || invitation.version >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(invitation.staff_version)
    || invitation.staff_version < 1) return { result: 'dead' }
  const actor = await db.prepare('SELECT id FROM staff_users WHERE id=?')
    .bind(payload.actorId).first()
  if (!exactRow(actor, ['id']) || actor.id !== payload.actorId) return { result: 'dead' }
  if (invitation.staff_status !== 'pending' || invitation.status !== 'pending'
    || invitation.expires_at <= now || invitation.email_sent_at !== null) {
    return { result: 'succeeded' }
  }
  if (job.idempotency_key !== emailJobKey(invitation.id, invitation.version)) {
    return { result: 'dead' }
  }
  let invitationEmail
  let staffEmail
  try {
    [invitationEmail, staffEmail] = await Promise.all([
      emailFor(cryptoContext, invitation),
      emailFor(cryptoContext, {
        id: invitation.staff_id,
        email_envelope: invitation.staff_email_envelope,
      }),
    ])
  } catch {
    return { result: 'dead' }
  }
  const recipient = canonicalRecipient(invitationEmail)
  if (!recipient || staffEmail !== recipient
    || invitation.email_lookup !== invitation.staff_email_lookup) return { result: 'dead' }
  let candidates
  try {
    candidates = await blindEmailCandidates(recipient, cryptoContext.keyring)
  } catch {
    return { result: 'dead' }
  }
  if (!candidates.includes(invitation.email_lookup)) return { result: 'dead' }

  let providerConfig = null
  let send = providers.sendInvitationEmail
  if (typeof send !== 'function') {
    try {
      providerConfig = loadEmailProviderConfig(bindings, config)
    } catch {
      return { result: 'dead' }
    }
    send = sendInvitationEmail
  }
  let providerNowMs
  try {
    if (typeof nowFactory !== 'function') return { result: 'dead' }
    const observed = nowFactory()
    if (!Number.isSafeInteger(observed) || observed < 0) return { result: 'dead' }
    providerNowMs = Math.max(nowMs, observed)
  } catch {
    return { result: 'dead' }
  }
  const providerNow = iso(providerNowMs)
  if (invitation.expires_at <= providerNow) return { result: 'succeeded' }
  if (Date.parse(job.lease_expires_at) - providerNowMs < PROVIDER_RUNWAY_MS) {
    return { result: 'retry' }
  }
  try {
    const accepted = await send({
      ...providerConfig,
      appOrigin: config.appOrigin,
      jobId: job.id,
      recipient,
      expiresAt: invitation.expires_at,
      fetch: providers.fetch ?? fetch,
    })
    if (!exactRow(accepted, ['providerId'])
      || !PROVIDER_UUID.test(accepted.providerId ?? '')) return { result: 'dead' }
    return Object.freeze({
      result: 'email-accepted',
      providerId: accepted.providerId,
    })
  } catch (error) {
    return fixedProviderFailure(error)
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
