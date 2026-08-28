import { CAPABILITIES, isCapability } from './capabilities.js'

const allOf = (...capabilities) => Object.freeze({
  allOf: Object.freeze(capabilities),
})

const anyRule = (...rules) => Object.freeze({
  anyRule: Object.freeze(rules),
})

const WORKSPACE_READ = allOf(
  'appointment.charge.read',
  'client.operational.read',
  'specialist.directory.read',
)

const PROTECTED_ROUTE_RULES = Object.freeze({
  dashboard: WORKSPACE_READ,
  calendar: WORKSPACE_READ,
  clients: WORKSPACE_READ,
  client: WORKSPACE_READ,
  tus: allOf('tus.manage'),
  tusGroup: allOf('tus.manage'),
  english: allOf('tus.manage'),
  team: allOf('staff.manage'),
  psych: allOf('staff.manage'),
  payments: anyRule(allOf('finance.centre.read'), WORKSPACE_READ),
  ledger: allOf('finance.centre.read'),
  reports: allOf('finance.centre.read'),
  settings: allOf(),
})

const PROTECTED_ACTION_RULES = Object.freeze({
  'appointment.create': allOf('appointment.manage'),
  'appointment.edit': allOf('appointment.manage'),
  'appointment.cancel': allOf('appointment.manage'),
  'payment.record': allOf('payment.manage'),
  'payment.correct': allOf('payment.manage'),
  'client.create': allOf('client.manage'),
  'client.edit': allOf('client.manage'),
  'client.archive': allOf('client.manage'),
  'client.historical.activate': allOf('client.manage'),
  'specialist.create': allOf('staff.manage'),
  'specialist.edit': allOf('staff.manage'),
  'specialist.link': allOf('staff.manage'),
  'staff.invite': allOf('staff.manage'),
  'staff.role.edit': allOf('staff.manage'),
  'staff.deactivate': allOf('staff.manage'),
  'permissions.read': allOf('permissions.manage'),
  'permissions.edit': allOf('permissions.manage'),
  'operations.health.read': allOf('operations.health.read'),
  'security.audit.read': allOf('security.audit.read'),
  'finance.import.preview': allOf('finance.import'),
  'finance.import.create': allOf('finance.import'),
  'finance.import.continue': allOf('finance.import'),
  'finance.import.status': allOf('finance.import'),
  'finance.entry.void': allOf('finance.centre.manage'),
  'workbook.export.centre': allOf('workbook.centre.export'),
  'workbook.export.own': allOf('workbook.own.export'),
  'activity.group.create': allOf('tus.manage'),
  'activity.group.edit': allOf('tus.manage'),
  'activity.participant.create': allOf('tus.manage'),
  'activity.participant.edit': allOf('tus.manage'),
  'activity.membership.create': allOf('tus.manage'),
  'activity.membership.edit': allOf('tus.manage'),
  'activity.class.create': allOf('tus.manage'),
  'activity.class.edit': allOf('tus.manage'),
  'activity.attendance.edit': allOf('tus.manage'),
})

const CAPABILITY_INDEX = new Map(
  CAPABILITIES.map((capability, index) => [capability, index]),
)

function acceptedCapabilitySet(capabilities) {
  try {
    if (!Array.isArray(capabilities)) return null

    const descriptors = Object.getOwnPropertyDescriptors(capabilities)
    const prototype = Object.getPrototypeOf(capabilities)
    const lengthDescriptor = descriptors.length
    const length = lengthDescriptor?.value
    if (prototype !== Array.prototype
      || !Object.hasOwn(lengthDescriptor ?? {}, 'value')
      || lengthDescriptor.enumerable !== false
      || !Number.isSafeInteger(length)
      || length < 0
      || length > CAPABILITIES.length) {
      return null
    }
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== length + 1 || !keys.includes('length')) return null

    const accepted = new Set()
    let previousIndex = -1

    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        return null
      }

      const capability = descriptor.value
      const capabilityIndex = CAPABILITY_INDEX.get(capability)
      if (!isCapability(capability) || capabilityIndex <= previousIndex) return null

      accepted.add(capability)
      previousIndex = capabilityIndex
    }

    return accepted
  } catch {
    return null
  }
}

function acceptedRule(rules, id) {
  if (typeof id !== 'string' || !Object.hasOwn(rules, id)) return null
  return rules[id]
}

function satisfiesRule(capabilities, rule) {
  if (rule.anyRule && !rule.anyRule.some((candidate) => (
    satisfiesRule(capabilities, candidate)
  ))) return false
  if (rule.allOf && !rule.allOf.every((capability) => capabilities.has(capability))) {
    return false
  }
  if (rule.anyOf && !rule.anyOf.some((capability) => capabilities.has(capability))) {
    return false
  }
  return true
}

export function canAccessProtectedRoute(capabilities, routeName) {
  const accepted = acceptedCapabilitySet(capabilities)
  const rule = acceptedRule(PROTECTED_ROUTE_RULES, routeName)
  return Boolean(accepted && rule && satisfiesRule(accepted, rule))
}

export function canPerformAction(capabilities, actionId) {
  const accepted = acceptedCapabilitySet(capabilities)
  const rule = acceptedRule(PROTECTED_ACTION_RULES, actionId)
  return Boolean(accepted && rule && satisfiesRule(accepted, rule))
}

export function protectedPaymentsSurface(capabilities, specialistId) {
  const accepted = acceptedCapabilitySet(capabilities)
  if (!accepted) return 'unavailable'
  if (accepted.has('finance.centre.read')) return 'centre'
  if (typeof specialistId === 'string' && specialistId.startsWith('sp_')
    && satisfiesRule(accepted, WORKSPACE_READ)) return 'own'
  return 'unavailable'
}
