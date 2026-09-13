export const SPECIALIST_AVATAR_KEYS = Object.freeze([
  'bloom',
  'cross',
  'orbit',
  'wave',
])

export const DEFAULT_SPECIALIST_AVATAR_KEY = 'bloom'

export const isSpecialistAvatarKey = (value) => SPECIALIST_AVATAR_KEYS.includes(value)

export function specialistAvatarKeyOrDefault(value) {
  if (value === undefined) return DEFAULT_SPECIALIST_AVATAR_KEY
  if (!isSpecialistAvatarKey(value)) throw new TypeError('SPECIALIST_AVATAR_KEY_INVALID')
  return value
}
