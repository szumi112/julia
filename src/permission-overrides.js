import {
  NON_DENIABLE_CAPABILITIES,
  ROLE_CAPABILITY_CEILINGS,
  ROLE_DEFAULT_CAPABILITIES,
  effectiveCapabilitiesFor,
  normalizeCapabilityOverrides,
} from './capabilities.js'

const CAPABILITY_LABELS = Object.freeze({
  'appointment.charge.read': 'Podgląd rozliczeń wizyt',
  'appointment.manage': 'Zarządzanie wizytami',
  'backup.manage': 'Zarządzanie kopiami zapasowymi',
  'centre.manage': 'Zarządzanie centrum',
  'chat.direct': 'Wiadomości bezpośrednie',
  'chat.general': 'Czat ogólny',
  'client.manage': 'Zarządzanie klientami',
  'client.operational.read': 'Podgląd klientów i kalendarza',
  'clinical.read': 'Podgląd danych klinicznych',
  'finance.centre.manage': 'Zarządzanie finansami centrum',
  'finance.centre.read': 'Podgląd finansów centrum',
  'finance.import': 'Import danych finansowych',
  'operations.health.read': 'Podgląd stanu systemu',
  'payment.manage': 'Rejestrowanie płatności',
  'permissions.manage': 'Zarządzanie uprawnieniami',
  'restore.manage': 'Przywracanie kopii zapasowych',
  'security.audit.read': 'Podgląd dziennika bezpieczeństwa',
  'security.keys.manage': 'Zarządzanie kluczami bezpieczeństwa',
  'specialist.directory.read': 'Podgląd katalogu specjalistek',
  'staff.manage': 'Zarządzanie personelem',
  'tus.manage': 'Zarządzanie TUS i zajęciami grupowymi',
  'workbook.centre.export': 'Eksport skoroszytu centrum',
  'workbook.own.export': 'Eksport własnego skoroszytu',
})
const LABEL_COLLATOR = new Intl.Collator('pl-PL', {
  numeric: true,
  sensitivity: 'base',
})

const invalid = (field = 'body') => {
  throw new TypeError(`VALIDATION_FAILED/${field}`)
}

const authorityInput = (value) => {
  let descriptors
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    invalid()
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const captured = {}
  for (const field of ['role', 'allow', 'deny']) {
    const descriptor = descriptors[field]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
    captured[field] = descriptor.value
  }
  const normalized = normalizeCapabilityOverrides(captured)
  return Object.freeze({ role: captured.role, ...normalized })
}

export function permissionChoicesFor(authority) {
  const current = authorityInput(authority)
  const defaults = new Set(ROLE_DEFAULT_CAPABILITIES[current.role])
  const effective = new Set(effectiveCapabilitiesFor(current))
  const locked = new Set(NON_DENIABLE_CAPABILITIES[current.role])
  const choices = ROLE_CAPABILITY_CEILINGS[current.role].map((capability) => (
    Object.freeze({
      capability,
      label: CAPABILITY_LABELS[capability],
      defaultEnabled: defaults.has(capability),
      enabled: effective.has(capability),
      locked: locked.has(capability),
    })
  ))
  choices.sort((left, right) => (
    LABEL_COLLATOR.compare(left.label, right.label)
      || left.capability.localeCompare(right.capability)
  ))
  return Object.freeze(choices)
}

export function setPermissionEnabled(authority, capability, enabled) {
  if (typeof enabled !== 'boolean') invalid()
  const current = authorityInput(authority)
  const ceiling = ROLE_CAPABILITY_CEILINGS[current.role]
  if (!ceiling.includes(capability)) invalid('allow')

  const defaults = new Set(ROLE_DEFAULT_CAPABILITIES[current.role])
  const nonDeniable = new Set(NON_DENIABLE_CAPABILITIES[current.role])
  if (!enabled && nonDeniable.has(capability)) invalid('deny')

  const allow = new Set(current.allow)
  const deny = new Set(current.deny)
  if (defaults.has(capability)) {
    allow.delete(capability)
    if (enabled) deny.delete(capability)
    else deny.add(capability)
  } else {
    deny.delete(capability)
    if (enabled) allow.add(capability)
    else allow.delete(capability)
  }

  const normalized = normalizeCapabilityOverrides({
    role: current.role,
    allow: [...allow],
    deny: [...deny],
  })
  return Object.freeze({
    role: current.role,
    allow: normalized.allow,
    deny: normalized.deny,
    effectiveCapabilities: effectiveCapabilitiesFor({
      role: current.role,
      allow: normalized.allow,
      deny: normalized.deny,
    }),
  })
}
