import { isAppointmentId, isClientId, isSpecialistId } from '../../src/core-records.js'

export const CAPABILITIES = Object.freeze([
  'appointment.charge.read', 'appointment.manage', 'centre.manage', 'chat.direct', 'chat.general',
  'client.manage', 'client.operational.read', 'clinical.read', 'finance.centre.manage',
  'finance.centre.read', 'operations.health.read', 'payment.manage', 'security.audit.read', 'specialist.directory.read',
  'staff.manage', 'tus.manage',
])

const ROLE_CAPABILITIES = Object.freeze({
  owner: Object.freeze([...CAPABILITIES]),
  coordinator: Object.freeze([
    'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
    'client.manage', 'client.operational.read', 'finance.centre.read',
    'operations.health.read', 'payment.manage', 'specialist.directory.read', 'tus.manage',
  ]),
  specialist: Object.freeze([
    'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
    'client.manage', 'client.operational.read', 'clinical.read', 'payment.manage',
    'specialist.directory.read', 'tus.manage',
  ]),
})

const nonempty = (value) => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const staffId = (value) => typeof value === 'string'
  && /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(value)
const activityGroupId = (value) => typeof value === 'string'
  && /^agr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(value)
const activityId = (value) => typeof value === 'string'
  && /^(?:agr|acp|amb|acl|aat)_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(value)

const captureFields = (value, keys) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const captured = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
    captured[key] = descriptor.value
  }
  return captured
}

const captureExact = (value, keys) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) return null
  const captured = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null
    captured[key] = descriptor.value
  }
  return captured
}

const knownActor = (value) => {
  const actor = captureFields(value, ['id', 'role', 'specialistId'])
  if (!actor || !staffId(actor.id)
    || !['owner', 'coordinator', 'specialist'].includes(actor.role)
    || (actor.role === 'specialist'
      ? !isSpecialistId(actor.specialistId)
      : actor.specialistId !== null && !isSpecialistId(actor.specialistId))) return null
  return actor
}

const ids = (values) => {
  if (!Array.isArray(values)) return null
  const length = values.length
  if (!Number.isSafeInteger(length) || length < 1 || length > 1_000) return null
  const captured = new Array(length)
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !nonempty(descriptor.value)) return null
    captured[index] = descriptor.value
  }
  return captured
}

const has = (values, value) => ids(values)?.includes(value) === true
const activitySpecialistIds = (values) => {
  if (!Array.isArray(values) || values.length > 1_000) return null
  const captured = []
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')
      || !isSpecialistId(descriptor.value)) return null
    captured.push(descriptor.value)
  }
  return captured
}
const ownSpecialist = (actor, value) => nonempty(actor.specialistId)
  && actor.specialistId === value

const exactCentre = (resource) => {
  const fact = captureExact(resource, ['kind', 'centreId'])
  return fact?.kind === 'centre' && fact.centreId === 'centre_1'
}

const exactDirectory = (resource) => {
  const fact = captureExact(resource, ['kind', 'centreId'])
  return fact?.kind === 'specialist_directory' && fact.centreId === 'centre_1'
}

const exactAssignment = (value, clientId) => {
  if (value === null) return null
  const fact = captureExact(value, ['kind', 'clientId', 'specialistId', 'status'])
  return fact?.kind === 'client_assignment' && fact.clientId === clientId
    && isSpecialistId(fact.specialistId) && fact.status === 'active' ? fact : false
}

const exactClient = (resource) => {
  const fact = captureExact(resource, ['kind', 'clientId', 'assignment'])
  if (fact?.kind !== 'client' || !isClientId(fact.clientId)) return null
  const assignment = exactAssignment(fact.assignment, fact.clientId)
  return assignment === false ? null : { ...fact, assignment }
}

const exactHistory = (resource) => {
  const fact = captureExact(resource, ['kind', 'clientId', 'appointmentId', 'specialistId'])
  return fact?.kind === 'client_history' && isClientId(fact.clientId)
    && isAppointmentId(fact.appointmentId) && isSpecialistId(fact.specialistId) ? fact : null
}

const exactAppointment = (resource) => {
  const fact = captureExact(resource, ['kind', 'appointmentId', 'specialistId'])
  return fact?.kind === 'appointment' && isAppointmentId(fact.appointmentId)
    && isSpecialistId(fact.specialistId) ? fact : null
}

const legacyClient = (resource) => {
  const fact = captureFields(resource, ['kind', 'clientId'])
  return fact?.kind === 'client' && isClientId(fact.clientId) ? fact : null
}

const activeAssignment = (actor, resource) => {
  const client = exactClient(resource)
  return Boolean(client?.assignment && ownSpecialist(actor, client.assignment.specialistId))
}

export function capabilitiesForActor(value) {
  try {
    const actor = knownActor(value)
    return actor ? ROLE_CAPABILITIES[actor.role] : Object.freeze([])
  } catch {
    return Object.freeze([])
  }
}

export function authorize(value, capability, resource, options = {}) {
  try {
    const actor = knownActor(value)
    const capturedOptions = captureFields(options, ['nowMs'])
    const nowMs = capturedOptions?.nowMs
    if (!actor || !CAPABILITIES.includes(capability)
      || !Number.isSafeInteger(nowMs) || nowMs < 0) return false

    if (['centre.manage', 'finance.centre.manage', 'staff.manage', 'security.audit.read'].includes(capability)) {
      return actor.role === 'owner' && exactCentre(resource)
    }
    if (capability === 'finance.centre.read' || capability === 'operations.health.read') {
      return ['owner', 'coordinator'].includes(actor.role) && exactCentre(resource)
    }
    if (capability === 'specialist.directory.read') return exactDirectory(resource)
    if (capability === 'chat.general') return exactCentre(resource)
    if (capability === 'chat.direct') {
      const conversation = captureFields(resource, ['kind', 'conversationId', 'participantStaffIds'])
      return conversation?.kind === 'conversation' && nonempty(conversation.conversationId)
        && has(conversation.participantStaffIds, actor.id)
    }
    if (capability === 'client.manage') {
      const client = exactClient(resource)
      if (!client) return false
      return actor.role === 'specialist' ? activeAssignment(actor, resource)
        : ['owner', 'coordinator'].includes(actor.role)
    }
    if (capability === 'client.operational.read') {
      const history = exactHistory(resource)
      if (history) return actor.role === 'specialist'
        ? ownSpecialist(actor, history.specialistId)
        : ['owner', 'coordinator'].includes(actor.role)
      const client = exactClient(resource)
      if (!client) return false
      return actor.role === 'specialist' ? activeAssignment(actor, resource)
        : ['owner', 'coordinator'].includes(actor.role)
    }
    if (['appointment.manage', 'appointment.charge.read', 'payment.manage'].includes(capability)) {
      const appointment = exactAppointment(resource)
      return Boolean(appointment
        && (actor.role !== 'specialist' || ownSpecialist(actor, appointment.specialistId)))
    }
    if (capability === 'tus.manage') {
      const activityCentre = captureExact(resource, ['kind', 'centreId'])
      if (activityCentre?.kind === 'activity_centre') {
        return activityCentre.centreId === 'centre_1' && actor.role !== 'specialist'
      }
      const activityGroup = captureExact(
        resource, ['kind', 'groupId', 'leaderSpecialistIds'],
      )
      if (activityGroup?.kind === 'activity_group') {
        const leaders = activitySpecialistIds(activityGroup.leaderSpecialistIds)
        return Boolean(activityGroupId(activityGroup.groupId) && leaders
          && (actor.role !== 'specialist' || leaders.includes(actor.specialistId)))
      }
      const activityRecord = captureExact(resource, [
        'kind', 'activityId', 'leaderSpecialistIds', 'responsibleSpecialistId',
      ])
      if (activityRecord?.kind === 'activity_record') {
        const leaders = activitySpecialistIds(activityRecord.leaderSpecialistIds)
        const responsible = activityRecord.responsibleSpecialistId
        if (!activityId(activityRecord.activityId) || !leaders
          || !(responsible === null || isSpecialistId(responsible))) return false
        return actor.role !== 'specialist' || leaders.includes(actor.specialistId)
          || responsible === actor.specialistId
      }
      const group = captureFields(resource, ['kind', 'groupId', 'leaderSpecialistIds'])
      if (group?.kind !== 'tus_group' || !nonempty(group.groupId)
        || !ids(group.leaderSpecialistIds)) return false
      return actor.role !== 'specialist'
        || has(group.leaderSpecialistIds, actor.specialistId)
    }
    if (capability === 'clinical.read') {
      if (actor.role === 'coordinator') return false
      if (activeAssignment(actor, resource)) return true
      const client = legacyClient(resource)
      const breakGlass = captureFields(resource, ['breakGlass'])?.breakGlass
      const fact = captureFields(breakGlass, [
        'kind', 'ownerStaffId', 'clientId', 'startsAt', 'expiresAt', 'revokedAt',
      ])
      return Boolean(actor.role === 'owner' && client && fact?.kind === 'break_glass'
        && fact.ownerStaffId === actor.id && fact.clientId === client.clientId
        && Number.isSafeInteger(fact.startsAt) && Number.isSafeInteger(fact.expiresAt)
        && fact.startsAt <= nowMs && nowMs < fact.expiresAt && fact.revokedAt === null)
    }
    return false
  } catch {
    return false
  }
}
