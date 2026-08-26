import { authorize } from '../identity/policy.js'
import { auditEventStatement, encryptAuditReason } from '../audit/events.js'
import { createUnitOfWork } from '../db/unit-of-work.js'
import { deactivateStaff, inviteStaff, listStaff } from '../identity/invitations.js'

const centre = { kind: 'centre', centreId: 'centre_1' }
const deny = async ({ db, actor, cryptoContext, correlationId, nowMs, idFactory }) => {
  const id = idFactory()
  const reasonEnvelope = await encryptAuditReason({ keyring: cryptoContext.keyring, dataKey: cryptoContext.dataKey, expectedScope: cryptoContext.scope, auditEventId: id, plaintext: 'staff.manage denied' })
  const uow = createUnitOfWork(db, { mode: 'denial', actorId: actor.id, correlationId })
  uow.audit(auditEventStatement(db, { id, occurredAt: new Date(nowMs).toISOString(), actorStaffId: actor.id, action: 'authorization.denied', entityType: 'staff_user', entityId: actor.id, result: 'denied', correlationId, metadata: { version: actor.version }, reasonEnvelope }))
  await uow.commit()
  throw new Error('FORBIDDEN')
}
const allowed = (actor, nowMs) => authorize(actor, 'staff.manage', centre, { nowMs })
const validation = (field) => {
  const error = new Error('VALIDATION_FAILED')
  error.details = { field }
  throw error
}
const deactivationBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.getPrototypeOf(body) !== Object.prototype
    || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'version')) {
    validation('version')
  }
  return body
}

export async function getStaff(input) {
  if (!allowed(input.actor, input.nowMs)) return deny(input)
  return listStaff(input)
}
export async function postInvitation(input) {
  if (!allowed(input.actor, input.nowMs)) return deny(input)
  const key = input.idempotencyKey
  if (!key) throw new Error('VALIDATION_FAILED')
  return inviteStaff({ ...input, input: input.body, idempotencyKey: key, dataMode: input.config.dataMode })
}
export async function postDeactivation(input) {
  if (!allowed(input.actor, input.nowMs)) return deny(input)
  const key = input.idempotencyKey
  if (!key) throw new Error('VALIDATION_FAILED')
  const body = deactivationBody(input.body)
  return deactivateStaff({ ...input, staffId: input.staffId, version: body.version, idempotencyKey: key })
}
