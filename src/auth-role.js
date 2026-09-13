import { isWellFormedUnicode } from './core-records.js'

const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const EMAIL = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+$/u
const INVALID_NAME = /[\p{Cc}\p{Cf}]/u

export const ROLE_LABELS = Object.freeze({
  owner: 'Zarządzanie / Właścicielka',
  coordinator: 'Koordynacja i recepcja',
  specialist: 'Prowadzenie terapii / Zespół terapeutyczny',
})

const ACCESS_PRESENTATIONS = Object.freeze({
  active: Object.freeze({ action: 'deactivate', label: 'Ma dostęp', tone: 'sage' }),
  pending: Object.freeze({ action: 'cancel', label: 'Zaproszenie wysłane', tone: 'amber' }),
  disabled: Object.freeze({ action: 'reinvite', label: 'Dostęp wyłączony', tone: 'ink' }),
  unclaimed: Object.freeze({ action: 'invite', label: 'Brak dostępu do panelu', tone: 'ink' }),
})

const ACCESS_STATUS_BY_PROFILE_STATUS = Object.freeze({
  enabled: 'active',
  invited: 'pending',
  unclaimed: 'unclaimed',
})
const UNKNOWN_ACCESS_PRESENTATION = Object.freeze({
  action: null,
  label: 'Stan dostępu niedostępny',
  tone: 'ink',
})

export const accessPresentationFor = (person) => {
  const status = typeof person?.status === 'string' && Object.hasOwn(ACCESS_PRESENTATIONS, person.status)
    ? person.status
    : ACCESS_STATUS_BY_PROFILE_STATUS[person?.accessStatus] ?? null
  return status ? ACCESS_PRESENTATIONS[status] : UNKNOWN_ACCESS_PRESENTATION
}

export const roleLabelFor = (role) => {
  const key = role === 'therapist' ? 'specialist' : role
  return typeof key === 'string' && Object.hasOwn(ROLE_LABELS, key)
    ? ROLE_LABELS[key]
    : 'Rola niedostępna'
}

export const rolePresentationFor = (person) => (
  person?.professionalTitle ?? roleLabelFor(person?.role ?? person?.id)
)

const denied = () => {
  throw new Error('AUTHORIZATION_INVALID')
}

const acceptedName = (value) => {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)
    || value !== value.normalize('NFC') || value !== value.trim()
    || !value || INVALID_NAME.test(value)
    || new TextEncoder().encode(value).byteLength > 120) {
    denied()
  }
  return value
}

const acceptedProfessionalTitle = (value) => value === null ? null : acceptedName(value)

const acceptedEmail = (value) => {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)
    || value !== value.normalize('NFC') || value !== value.trim()
    || value !== value.toLowerCase() || !EMAIL.test(value)
    || value.startsWith('.') || value.includes('..') || value.includes('.@')
    || new TextEncoder().encode(value).byteLength > 254) denied()
  return value
}

const acceptedSpecialistId = (value, required) => {
  if (value === null && !required) return null
  if (typeof value !== 'string' || !SPECIALIST_ID.test(value)) denied()
  return value
}

const acceptedShellRole = (sessionUser) => {
  if (!sessionUser || typeof sessionUser !== 'object' || Array.isArray(sessionUser)) denied()
  const descriptors = Object.getOwnPropertyDescriptors(sessionUser)
  const keys = ['id', 'displayName', 'email', 'professionalTitle', 'role', 'specialistId', 'version']
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) denied()
  const actor = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) denied()
    actor[key] = descriptor.value
  }
  if (typeof actor.id !== 'string' || !STAFF_ID.test(actor.id)
    || !Number.isSafeInteger(actor.version) || actor.version < 1) denied()
  const name = acceptedName(actor.displayName)
  acceptedEmail(actor.email)
  const professionalTitle = acceptedProfessionalTitle(actor.professionalTitle)
  const specialistId = acceptedSpecialistId(
    actor.specialistId,
    actor.role === 'specialist',
  )
  if ((professionalTitle === null) !== (specialistId === null)) denied()
  const shared = { authorityVersion: actor.version, professionalTitle }

  if (actor.role === 'owner') {
    return Object.freeze({
      ...shared,
      id: 'owner',
      label: roleLabelFor(actor.role),
      name,
      psychId: specialistId,
      scope: 'centre',
    })
  }
  if (actor.role === 'coordinator') {
    return Object.freeze({
      ...shared,
      id: 'coordinator',
      label: roleLabelFor(actor.role),
      name,
      psychId: specialistId,
      scope: 'centre',
    })
  }
  if (actor.role === 'specialist') {
    return Object.freeze({
      ...shared,
      id: 'therapist',
      label: roleLabelFor(actor.role),
      name,
      psychId: specialistId,
      scope: 'own',
    })
  }
  denied()
}

export function shellRoleFor(sessionUser) {
  try {
    return acceptedShellRole(sessionUser)
  } catch {
    denied()
  }
}
