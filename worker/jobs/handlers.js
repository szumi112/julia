import { auditEventStatement } from '../audit/events.js'
import { decryptForScope, encryptForScope } from '../security/envelope.js'
import { reconcileAccessGroup } from '../providers/cloudflare-access.js'
import { sendInvitationEmail } from '../providers/scaleway-email.js'

const iso = (nowMs) => new Date(nowMs).toISOString()
const emailFor = (context, row) => decryptForScope(context.keyring, context.dataKey, {
  expectedScope: context.scope, recordId: row.id, field: 'email', envelope: JSON.parse(row.email_envelope),
})

export async function desiredAccessEmails(db, cryptoContext, nowMs) {
  const now = iso(nowMs)
  const rows = (await db.prepare(
    `SELECT s.id,s.email_envelope
     FROM staff_users s
     LEFT JOIN staff_invitations i ON i.staff_id=s.id
     WHERE s.status='active'
       OR (s.status='pending' AND i.status IN ('provisioning','pending') AND i.expires_at>?)`
  ).bind(now).all()).results
  const emails = await Promise.all(rows.map((row) => emailFor(cryptoContext, row)))
  return [...new Set(emails)].sort((a, b) => a.localeCompare(b))
}

export async function handleAccessReconcile({ db, cryptoContext, config, payload, nowMs, providers = {} }) {
  const desired = await desiredAccessEmails(db, cryptoContext, nowMs)
  const reconcile = providers.reconcileAccessGroup ?? reconcileAccessGroup
  await reconcile({ ...config.accessProvider, emails: desired, fetch: providers.fetch ?? fetch })
  return { result: 'succeeded' }
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

export async function handleInvitationExpiry({ db, cryptoContext, actorId, payload, correlationId, nowMs, idFactory = () => crypto.randomUUID().replaceAll('-', '') }) {
  const invitation = await db.prepare("SELECT * FROM staff_invitations WHERE id=? AND status IN ('provisioning','pending')").bind(payload.invitationId).first()
  const now = iso(nowMs)
  if (!invitation || invitation.expires_at > now) return { result: 'succeeded' }
  const staff = await db.prepare('SELECT * FROM staff_users WHERE id=?').bind(invitation.staff_id).first()
  if (!staff) return { result: 'dead', errorCode: 'STATE_INVALID' }
  await db.batch([
    db.prepare("UPDATE staff_invitations SET status='expired',version=version+1,updated_at=? WHERE id=? AND version=?").bind(now, invitation.id, invitation.version),
    auditEventStatement(db, { id: idFactory(), occurredAt: now, actorStaffId: actorId, action: 'staff.invitation.expired', entityType: 'staff_invitation', entityId: invitation.id, result: 'success', correlationId, metadata: { staffVersion: staff.version, invitationVersion: invitation.version + 1, desiredGeneration: payload.generation ?? 1 }, reasonEnvelope: null }),
  ])
  return { result: 'succeeded' }
}

export async function dispatchOutboxJob(input) {
  if (!['staff.access.reconcile', 'staff.invitation.email', 'staff.invitation.expire'].includes(input.job.type)) return { result: 'dead', errorCode: 'OUTBOX_TYPE_INVALID' }
  let payload
  try {
    payload = JSON.parse(await decryptForScope(input.cryptoContext.keyring, input.cryptoContext.dataKey, { expectedScope: input.cryptoContext.scope, recordId: input.job.id, field: 'job_payload', envelope: JSON.parse(input.job.payload_envelope) }))
  } catch { return { result: 'dead', errorCode: 'CRYPTO_FAILURE' } }
  if (input.job.type === 'staff.access.reconcile') return handleAccessReconcile({ ...input, payload })
  if (input.job.type === 'staff.invitation.email') return handleInvitationEmail({ ...input, payload })
  return handleInvitationExpiry({ ...input, payload })
}
