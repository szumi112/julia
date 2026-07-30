import { authorize } from '../identity/policy.js'
import { auditEventStatement, encryptAuditReason } from '../audit/events.js'
import { createUnitOfWork } from '../db/unit-of-work.js'
import { deactivateStaff, inviteStaff, listStaff } from '../identity/invitations.js'

const centre = { kind: 'centre', centreId: 'centre_1' }
const deny = async ({ db, actor, cryptoContext, correlationId, nowMs, idFactory }) => {
  const id = idFactory()
  try {
    const reasonEnvelope = await encryptAuditReason({ keyring: cryptoContext.keyring, dataKey: cryptoContext.dataKey, expectedScope: cryptoContext.scope, auditEventId: id, plaintext: 'staff.manage denied' })
    const uow = createUnitOfWork(db, { mode: 'denial', actorId: actor.id, correlationId })
    uow.audit(auditEventStatement(db, { id, occurredAt: new Date(nowMs).toISOString(), actorStaffId: actor.id, action: 'authorization.denied', entityType: 'staff_user', entityId: actor.id, result: 'denied', correlationId, metadata: { version: actor.version }, reasonEnvelope }))
    await uow.commit()
  } catch { /* A denial remains opaque if storage is unavailable. */ }
  throw new Error('FORBIDDEN')
}
const allowed = (actor, nowMs) => authorize(actor, 'staff.manage', centre, { nowMs })
const idempotency = (request) => request.headers.get('Idempotency-Key')

export async function getStaff(input) {
  if (!allowed(input.actor, input.nowMs)) return deny(input)
  return listStaff(input)
}
export async function postInvitation(input) {
  if (!allowed(input.actor, input.nowMs)) return deny(input)
  const key = idempotency(input.request)
  if (!key) throw new Error('VALIDATION_FAILED')
  return inviteStaff({ ...input, input: input.body, idempotencyKey: key, dataMode: input.config.dataMode })
}
export async function postDeactivation(input) {
  if (!allowed(input.actor, input.nowMs)) return deny(input)
  const key = idempotency(input.request)
  if (!key) throw new Error('VALIDATION_FAILED')
  return deactivateStaff({ ...input, staffId: input.staffId, version: input.body?.version, idempotencyKey: key })
}
