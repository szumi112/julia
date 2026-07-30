const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
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
  if (typeof value !== 'string' || !ID.test(value)) denied()
  return value
}

const acceptedShellRole = (sessionUser) => {
  if (!sessionUser || typeof sessionUser !== 'object' || Array.isArray(sessionUser)) denied()
  const name = acceptedName(sessionUser.displayName)

  if (sessionUser.role === 'owner') {
    return {
      id: 'owner',
      label: 'Właściciel',
      name,
      psychId: acceptedSpecialistId(sessionUser.specialistId, false),
      scope: 'centre',
    }
  }
  if (sessionUser.role === 'coordinator') {
    return {
      id: 'coordinator',
      label: 'Koordynator',
      name,
      psychId: acceptedSpecialistId(sessionUser.specialistId, false),
      scope: 'centre',
    }
  }
  if (sessionUser.role === 'specialist') {
    return {
      id: 'therapist',
      label: 'Specjalista',
      name,
      psychId: acceptedSpecialistId(sessionUser.specialistId, true),
      scope: 'own',
    }
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
