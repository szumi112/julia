const EMAIL = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+$/u
const MAX_EMAIL_BYTES = 254
const PHASE_ONE_ENVIRONMENTS = new Set(['development', 'production', 'staging'])

export const ACCESS_DISABLED_EMAIL = 'disabled@example.test'
export const STAGING_OWNER_EMAIL = 'staging-owner@bearwithme-panel.app'

const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength

export function normalizeCanonicalEmail(value, { fictional = false } = {}) {
  if (typeof value !== 'string'
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return null
  const email = value.trim().toLowerCase().normalize('NFC')
  if (utf8Bytes(email) > MAX_EMAIL_BYTES
    || !EMAIL.test(email)
    || email.startsWith('.')
    || email.includes('..')
    || email.includes('.@')
    || (fictional && !email.endsWith('@example.test'))) return null
  return email
}

export function acceptCanonicalEmail(value, options) {
  const email = normalizeCanonicalEmail(value, options)
  return email !== null && value === email ? email : null
}

export function acceptPhaseOneAccessEmail(value, {
  allowDisabled = false,
  appEnv,
} = {}) {
  if (!PHASE_ONE_ENVIRONMENTS.has(appEnv)) return null
  const email = acceptCanonicalEmail(value)
  if (email === null) return null
  if (email === ACCESS_DISABLED_EMAIL) return allowDisabled ? email : null
  if (email.endsWith('@example.test')) return email
  return appEnv === 'staging' && email === STAGING_OWNER_EMAIL ? email : null
}
