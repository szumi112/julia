const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const INVALID_NAME = /[\p{Cc}\p{Cf}]/u

const denied = () => {
  throw new Error('AUTHORIZATION_INVALID')
}

const acceptedName = (value) => {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || value !== value.trim()
    || !value || INVALID_NAME.test(value)
    || new TextEncoder().encode(value).byteLength > 120) {
    denied()
  }
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
  const keys = ['id', 'displayName', 'role', 'specialistId', 'version']
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
  const shared = { authorityVersion: actor.version }

  if (actor.role === 'owner') {
    return Object.freeze({
      ...shared,
      id: 'owner',
      label: 'Właściciel',
      name,
      psychId: acceptedSpecialistId(actor.specialistId, false),
      scope: 'centre',
    })
  }
  if (actor.role === 'coordinator') {
    return Object.freeze({
      ...shared,
      id: 'coordinator',
      label: 'Koordynator',
      name,
      psychId: acceptedSpecialistId(actor.specialistId, false),
      scope: 'centre',
    })
  }
  if (actor.role === 'specialist') {
    return Object.freeze({
      ...shared,
      id: 'therapist',
      label: 'Specjalista',
      name,
      psychId: acceptedSpecialistId(actor.specialistId, true),
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
