export const CAPABILITIES = Object.freeze([
  'appointment.charge.read',
  'appointment.manage',
  'backup.manage',
  'centre.manage',
  'chat.direct',
  'chat.general',
  'client.manage',
  'client.operational.read',
  'clinical.read',
  'finance.centre.manage',
  'finance.centre.read',
  'finance.import',
  'operations.health.read',
  'payment.manage',
  'permissions.manage',
  'restore.manage',
  'security.audit.read',
  'security.keys.manage',
  'specialist.directory.read',
  'staff.manage',
  'tus.manage',
  'workbook.centre.export',
  'workbook.own.export',
])

export const ROLE_DEFAULT_CAPABILITIES = Object.freeze({
  owner: Object.freeze([
    'appointment.charge.read',
    'appointment.manage',
    'backup.manage',
    'centre.manage',
    'chat.direct',
    'chat.general',
    'client.manage',
    'client.operational.read',
    'clinical.read',
    'finance.centre.manage',
    'finance.centre.read',
    'finance.import',
    'operations.health.read',
    'payment.manage',
    'permissions.manage',
    'restore.manage',
    'security.audit.read',
    'security.keys.manage',
    'specialist.directory.read',
    'staff.manage',
    'tus.manage',
    'workbook.centre.export',
  ]),
  coordinator: Object.freeze([
    'appointment.charge.read',
    'appointment.manage',
    'chat.direct',
    'chat.general',
    'client.manage',
    'client.operational.read',
    'finance.centre.read',
    'operations.health.read',
    'payment.manage',
    'specialist.directory.read',
    'tus.manage',
    'workbook.centre.export',
  ]),
  specialist: Object.freeze([
    'appointment.charge.read',
    'appointment.manage',
    'chat.direct',
    'chat.general',
    'client.manage',
    'client.operational.read',
    'clinical.read',
    'payment.manage',
    'specialist.directory.read',
    'tus.manage',
    'workbook.own.export',
  ]),
})

export const ROLE_CAPABILITY_CEILINGS = Object.freeze({
  owner: Object.freeze([...ROLE_DEFAULT_CAPABILITIES.owner]),
  coordinator: Object.freeze([
    'appointment.charge.read',
    'appointment.manage',
    'chat.direct',
    'chat.general',
    'client.manage',
    'client.operational.read',
    'finance.centre.read',
    'finance.import',
    'operations.health.read',
    'payment.manage',
    'specialist.directory.read',
    'tus.manage',
    'workbook.centre.export',
  ]),
  specialist: Object.freeze([...ROLE_DEFAULT_CAPABILITIES.specialist]),
})

export const OWNER_ONLY_CAPABILITIES = Object.freeze([
  'backup.manage',
  'centre.manage',
  'finance.centre.manage',
  'permissions.manage',
  'restore.manage',
  'security.audit.read',
  'security.keys.manage',
  'staff.manage',
])

export const NON_DENIABLE_CAPABILITIES = Object.freeze({
  owner: Object.freeze(['permissions.manage']),
  coordinator: Object.freeze([]),
  specialist: Object.freeze([]),
})

const CAPABILITY_SET = new Set(CAPABILITIES)
const CAPABILITY_INDEX = new Map(CAPABILITIES.map((value, index) => [value, index]))
const ROLES = new Set(Object.keys(ROLE_DEFAULT_CAPABILITIES))
const DEFAULT_SETS = Object.freeze(Object.fromEntries(
  Object.entries(ROLE_DEFAULT_CAPABILITIES).map(([role, values]) => [role, new Set(values)]),
))
const CEILING_SETS = Object.freeze(Object.fromEntries(
  Object.entries(ROLE_CAPABILITY_CEILINGS).map(([role, values]) => [role, new Set(values)]),
))
const NON_DENIABLE_SETS = Object.freeze(Object.fromEntries(
  Object.entries(NON_DENIABLE_CAPABILITIES).map(([role, values]) => [role, new Set(values)]),
))

const invalid = (field) => { throw new TypeError(`VALIDATION_FAILED/${field}`) }

const captureOverrides = (value) => {
  let descriptors
  let prototype
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
    prototype = Object.getPrototypeOf(value)
  } catch {
    invalid('body')
  }
  const keys = Reflect.ownKeys(descriptors)
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || prototype !== Object.prototype || keys.length !== 3
    || keys.some((key) => typeof key !== 'string'
      || !['role', 'allow', 'deny'].includes(key))) invalid('body')
  const captured = {}
  for (const key of ['role', 'allow', 'deny']) {
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      invalid('body')
    }
    captured[key] = descriptor.value
  }
  return captured
}

const captureList = (value, field) => {
  let isArray
  let descriptors
  let prototype
  try {
    isArray = Array.isArray(value)
    if (isArray) {
      descriptors = Object.getOwnPropertyDescriptors(value)
      prototype = Object.getPrototypeOf(value)
    }
  } catch {
    invalid(field)
  }
  if (!isArray) invalid(field)
  const lengthDescriptor = descriptors.length
  const length = lengthDescriptor?.value
  if (prototype !== Array.prototype || !Object.hasOwn(lengthDescriptor ?? {}, 'value')
    || lengthDescriptor.enumerable !== false || !Number.isSafeInteger(length)
    || length < 0 || length > 1_000) invalid(field)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== length + 1 || !keys.includes('length')) invalid(field)
  const captured = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      invalid(field)
    }
    captured.push(descriptor.value)
  }
  return captured
}

const sorted = (values) => Object.freeze(CAPABILITIES.filter((value) => values.has(value)))

const normalizedInput = (value) => {
  const input = captureOverrides(value)
  if (!ROLES.has(input.role)) invalid('role')
  const ceiling = CEILING_SETS[input.role]
  const defaults = DEFAULT_SETS[input.role]
  const nonDeniable = NON_DENIABLE_SETS[input.role]
  const allow = new Set()
  const deny = new Set()
  for (const [field, target] of [
    ['allow', allow],
    ['deny', deny],
  ]) {
    for (const capability of captureList(input[field], field)) {
      if (!CAPABILITY_SET.has(capability) || !ceiling.has(capability)
        || (field === 'deny' && nonDeniable.has(capability))) invalid(field)
      target.add(capability)
    }
  }
  for (const capability of deny) allow.delete(capability)
  for (const capability of defaults) allow.delete(capability)
  return Object.freeze({
    role: input.role,
    allow: sorted(allow),
    deny: sorted(deny),
  })
}

export const isCapability = (value) => CAPABILITY_SET.has(value)

export function normalizeCapabilityOverrides(value) {
  const normalized = normalizedInput(value)
  return Object.freeze({ allow: normalized.allow, deny: normalized.deny })
}

export function effectiveCapabilitiesFor(value) {
  const normalized = normalizedInput(value)
  const effective = new Set([
    ...ROLE_DEFAULT_CAPABILITIES[normalized.role],
    ...normalized.allow,
  ])
  for (const capability of normalized.deny) effective.delete(capability)
  for (const capability of NON_DENIABLE_CAPABILITIES[normalized.role]) {
    effective.add(capability)
  }
  return sorted(effective)
}

export function acceptEffectiveCapabilities(role, values) {
  try {
    if (!ROLES.has(role)) return null
    const captured = captureList(values, 'capabilities')
    const ceiling = CEILING_SETS[role]
    let previous = -1
    for (const capability of captured) {
      const index = CAPABILITY_INDEX.get(capability)
      if (!ceiling.has(capability) || !Number.isSafeInteger(index) || index <= previous) {
        return null
      }
      previous = index
    }
    if (NON_DENIABLE_CAPABILITIES[role].some((capability) => (
      !captured.includes(capability)
    ))) return null
    return Object.freeze(captured)
  } catch {
    return null
  }
}
