import { decodeBase64Url, encodeBase64Url } from './encoding.js'

const invalid = () => { throw new Error('CSRF_INVALID') }
const expired = () => { throw new Error('CSRF_EXPIRED') }
const positive = (value) => Number.isSafeInteger(value) && value > 0
const canonicalInteger = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value)
  && Number.isSafeInteger(Number(value)) && String(Number(value)) === value

const encoded = (value, length) => {
  try {
    const bytes = decodeBase64Url(value)
    if (bytes.byteLength !== length) {
      bytes.fill(0)
      invalid()
    }
    return bytes
  } catch (error) {
    if (error?.message === 'CSRF_INVALID') throw error
    invalid()
  }
}

const messageFor = (subject, origin, expires, nonce) => {
  if (typeof subject !== 'string' || !subject || typeof origin !== 'string' || !origin) invalid()
  return new TextEncoder().encode(['bwm:csrf:v1', subject, origin, expires, nonce].join('\n'))
}

async function csrfKey(lookupKey) {
  let label
  let derived
  try {
    label = new TextEncoder().encode('bwm:csrf:key:v1')
    derived = new Uint8Array(await crypto.subtle.sign('HMAC', lookupKey, label))
    if (derived.byteLength !== 32) invalid()
    return await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  } catch (error) {
    if (error?.message === 'CSRF_INVALID') throw error
    invalid()
  } finally {
    label?.fill(0)
    derived?.fill(0)
  }
}

export async function issueCsrfToken({ subject, origin, keyring, nowMs = Date.now(), ttlSeconds = 900 } = {}) {
  if (!positive(ttlSeconds) || ttlSeconds > 900 || !Number.isFinite(nowMs)) invalid()
  const lookupKey = keyring?.getLookupHmac?.(keyring?.activeLookupKeyVersion)
  if (!lookupKey) invalid()
  const expiresUnix = Math.floor(nowMs / 1000) + ttlSeconds
  if (!positive(expiresUnix)) invalid()
  const nonce = crypto.getRandomValues(new Uint8Array(16))
  let message
  let signature
  try {
    const nonceText = encodeBase64Url(nonce)
    message = messageFor(subject, origin, String(expiresUnix), nonceText)
    signature = new Uint8Array(await crypto.subtle.sign('HMAC', await csrfKey(lookupKey), message))
    if (signature.byteLength !== 32) invalid()
    return `v1.${expiresUnix}.${nonceText}.${encodeBase64Url(signature)}`
  } catch (error) {
    if (error?.message === 'CSRF_INVALID') throw error
    invalid()
  } finally {
    nonce.fill(0)
    message?.fill(0)
    signature?.fill(0)
  }
}

export async function verifyCsrfToken(token, { subject, origin, keyring, nowMs = Date.now() } = {}) {
  if (typeof token !== 'string' || !Number.isFinite(nowMs)) invalid()
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1' || !canonicalInteger(parts[1])) invalid()
  const expiresUnix = Number(parts[1])
  let nonce
  let signature
  let message
  try {
    nonce = encoded(parts[2], 16)
    signature = encoded(parts[3], 32)
    message = messageFor(subject, origin, parts[1], parts[2])
    const versions = keyring?.lookupKeyVersions
    if (!Array.isArray(versions) || !versions.length) invalid()
    const matches = await Promise.all(versions.map(async (version) => {
      const lookupKey = keyring.getLookupHmac(version)
      if (!lookupKey) return false
      return crypto.subtle.verify('HMAC', await csrfKey(lookupKey), signature, message)
    }))
    if (!matches.some(Boolean)) invalid()
    const nowUnix = Math.floor(nowMs / 1000)
    if (expiresUnix <= nowUnix) expired()
    if (expiresUnix > nowUnix + 900) invalid()
    return true
  } catch (error) {
    if (error?.message === 'CSRF_INVALID' || error?.message === 'CSRF_EXPIRED') throw error
    invalid()
  } finally {
    nonce?.fill(0)
    signature?.fill(0)
    message?.fill(0)
  }
}
