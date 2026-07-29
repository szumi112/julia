export const CAPABILITIES = Object.freeze([
  'appointment.charge.read', 'appointment.manage', 'centre.manage', 'chat.direct', 'chat.general',
  'client.operational.read', 'clinical.read', 'finance.centre.read', 'operations.health.read',
  'payment.manage', 'security.audit.read', 'staff.manage', 'tus.manage',
])

const ROLE_CAPABILITIES = Object.freeze({
  owner: Object.freeze([...CAPABILITIES]),
  coordinator: Object.freeze(['appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general', 'client.operational.read', 'finance.centre.read', 'operations.health.read', 'payment.manage', 'tus.manage']),
  specialist: Object.freeze(['appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general', 'client.operational.read', 'clinical.read', 'payment.manage', 'tus.manage']),
})
const nonempty = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const knownActor = (actor) => actor && typeof actor === 'object' && nonempty(actor.id)
  && ['owner', 'coordinator', 'specialist'].includes(actor.role)
  && (actor.specialistId === null || nonempty(actor.specialistId))
const ids = (values) => Array.isArray(values) && values.every(nonempty)
const has = (values, value) => ids(values) && values.includes(value)
const ownSpecialist = (actor, value) => nonempty(actor.specialistId) && actor.specialistId === value
const clientTarget = (resource) => resource?.kind === 'client' && nonempty(resource.clientId)
const centreTarget = (resource) => resource?.kind === 'centre' && nonempty(resource.centreId)
const assignment = (resource) => resource?.assignment
const activeAssignment = (actor, resource) => clientTarget(resource) && assignment(resource)?.kind === 'client_assignment'
  && assignment(resource).clientId === resource.clientId && assignment(resource).status === 'active' && ownSpecialist(actor, assignment(resource).specialistId)

export function capabilitiesForActor(actor) {
  return knownActor(actor) ? ROLE_CAPABILITIES[actor.role] : Object.freeze([])
}

export function authorize(actor, capability, resource, { nowMs } = {}) {
  if (!knownActor(actor) || !CAPABILITIES.includes(capability) || !Number.isSafeInteger(nowMs)) return false
  if (['centre.manage', 'staff.manage', 'security.audit.read'].includes(capability)) return actor.role === 'owner' && centreTarget(resource)
  if (capability === 'finance.centre.read' || capability === 'operations.health.read') return ['owner', 'coordinator'].includes(actor.role) && centreTarget(resource)
  if (capability === 'chat.general') return centreTarget(resource)
  if (capability === 'chat.direct') return resource?.kind === 'conversation' && nonempty(resource.conversationId) && has(resource.participantStaffIds, actor.id)
  if (capability === 'client.operational.read') return actor.role !== 'specialist'
    ? ['owner', 'coordinator'].includes(actor.role) && clientTarget(resource) : activeAssignment(actor, resource)
  if (['appointment.manage', 'appointment.charge.read', 'payment.manage'].includes(capability)) {
    if (!resource || resource.kind !== 'appointment' || !nonempty(resource.appointmentId) || !nonempty(resource.specialistId)) return false
    return actor.role !== 'specialist' || ownSpecialist(actor, resource.specialistId)
  }
  if (capability === 'tus.manage') {
    if (!resource || resource.kind !== 'tus_group' || !nonempty(resource.groupId) || !ids(resource.leaderSpecialistIds)) return false
    return actor.role !== 'specialist' || ownSpecialist(actor, actor.specialistId) && has(resource.leaderSpecialistIds, actor.specialistId)
  }
  if (capability === 'clinical.read') {
    if (actor.role === 'coordinator') return false
    if (activeAssignment(actor, resource)) return true
    const fact = resource?.breakGlass
    return actor.role === 'owner' && clientTarget(resource) && fact?.kind === 'break_glass' && fact.ownerStaffId === actor.id
      && fact.clientId === resource.clientId && Number.isSafeInteger(fact.startsAt) && Number.isSafeInteger(fact.expiresAt)
      && fact.startsAt <= nowMs && nowMs < fact.expiresAt && fact.revokedAt === null
  }
  return false
}
