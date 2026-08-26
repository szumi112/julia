const INVALID = 'BACKUP_MANIFEST_INVALID'
const CRYPTO_FAILED = 'BACKUP_CRYPTO_FAILED'
const POLLUTING_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ROOT_KEYS = [
  'format', 'backupId', 'createdAt', 'localDay', 'localMonth', 'retentionClass',
  'objectKey', 'objectEtag', 'objectSize', 'atBookmark', 'wrappedSsecKey',
]
const WRAPPED_KEY_KEYS = ['algorithm', 'kekVersion', 'nonce', 'ciphertext']
const FACT_KEYS = ROOT_KEYS.filter((key) => key !== 'wrappedSsecKey')
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const BASE64URL = /^[A-Za-z0-9_-]*$/
const UNSAFE_OPAQUE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

const invalid = () => { throw new Error(INVALID) }
const cryptoFailed = () => { throw new Error(CRYPTO_FAILED) }

function attempt(operation) {
  try {
    return operation()
  } catch {
    invalid()
  }
}

function descriptorsFor(value, expectedPrototype, nonEnumerable = new Set()) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== expectedPrototype) invalid()
  const keys = Reflect.ownKeys(value)
  const descriptors = new Map()
  for (const key of keys) {
    if (typeof key !== 'string' || POLLUTING_KEYS.has(key)) invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || (!descriptor.enumerable && !nonEnumerable.has(key)) || !Object.hasOwn(descriptor, 'value')) invalid()
    descriptors.set(key, descriptor)
  }
  return { keys, descriptors }
}

function canonicalValue(value, ancestors) {
  if (value === null || typeof value === 'boolean') return value ? 'true' : value === null ? 'null' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid()
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value !== 'object' || ancestors.has(value)) invalid()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return canonicalArray(value, ancestors)
    return canonicalObject(value, ancestors)
  } finally {
    ancestors.delete(value)
  }
}

function canonicalArray(value, ancestors) {
  const { keys, descriptors } = descriptorsFor(value, Array.prototype, new Set(['length']))
  const lengthDescriptor = descriptors.get('length')
  if (!lengthDescriptor || Object.hasOwn(lengthDescriptor, 'get') || Object.hasOwn(lengthDescriptor, 'set')
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || keys.length !== lengthDescriptor.value + 1) invalid()
  for (const key of keys) {
    if (key === 'length') continue
    const index = Number(key)
    if (!/^(?:0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(index)
      || String(index) !== key || index >= lengthDescriptor.value) invalid()
  }
  const values = []
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors.get(String(index))
    if (!descriptor) invalid()
    values.push(canonicalValue(descriptor.value, ancestors))
  }
  return `[${values.join(',')}]`
}

function canonicalObject(value, ancestors) {
  const { keys, descriptors } = descriptorsFor(value, Object.prototype)
  return `{${keys.slice().sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(descriptors.get(key).value, ancestors)}`).join(',')}}`
}

function exactObject(value, fields) {
  const { keys, descriptors } = descriptorsFor(value, Object.prototype)
  if (keys.length !== fields.length || fields.some((field) => !descriptors.has(field))) invalid()
  const captured = {}
  for (const field of fields) captured[field] = descriptors.get(field).value
  return captured
}

function validMonth(value) {
  if (typeof value !== 'string' || !MONTH.test(value)) return false
  const date = new Date(`${value}-01T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 7) === value
}

function validDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

function validInstant(value) {
  if (typeof value !== 'string' || !INSTANT.test(value)) return false
  const date = new Date(value)
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value
}

function validOpaque(value) {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || value !== value.trim() || UNSAFE_OPAQUE.test(value)) return false
  let encoded
  try {
    encoded = new TextEncoder().encode(value)
    return encoded.byteLength >= 1 && encoded.byteLength <= 1024
  } finally {
    encoded?.fill(0)
  }
}

function encodeBase64Url(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function validBase64Url(value, byteLength) {
  let decoded
  try {
    if (typeof value !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1) return false
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='))
    decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return decoded.byteLength === byteLength && encodeBase64Url(decoded) === value
  } catch {
    return false
  } finally {
    decoded?.fill(0)
  }
}

function factsValue(value) {
  const facts = exactObject(value, FACT_KEYS)
  if (facts.format !== 'bwm-d1-sql-v1'
    || typeof facts.backupId !== 'string' || !BACKUP_ID.test(facts.backupId)
    || !validInstant(facts.createdAt)
    || !validDay(facts.localDay) || !validMonth(facts.localMonth)
    || facts.localDay.slice(0, 7) !== facts.localMonth
    || !['daily', 'monthly'].includes(facts.retentionClass)
    || !validOpaque(facts.objectEtag) || !validOpaque(facts.atBookmark)
    || !Number.isSafeInteger(facts.objectSize) || facts.objectSize < 0) invalid()
  const keys = backupObjectKeys({ backupId: facts.backupId, localMonth: facts.localMonth })
  if (facts.objectKey !== keys.objectKey) invalid()
  return facts
}

function manifestValue(value) {
  const manifest = exactObject(value, ROOT_KEYS)
  const facts = factsValue(Object.fromEntries(FACT_KEYS.map((key) => [key, manifest[key]])))
  const wrapped = exactObject(manifest.wrappedSsecKey, WRAPPED_KEY_KEYS)
  if (wrapped.algorithm !== 'A256GCM'
    || !Number.isSafeInteger(wrapped.kekVersion) || wrapped.kekVersion <= 0
    || !validBase64Url(wrapped.nonce, 12) || !validBase64Url(wrapped.ciphertext, 48)) invalid()
  return { ...facts, wrappedSsecKey: wrapped }
}

function inputValue(value, fields) {
  return exactObject(value, fields)
}

function mutableBytes(value, length) {
  if (!(value instanceof Uint8Array) || value.byteLength !== length || value.buffer.byteLength === 0) invalid()
  return value
}

function keyringValue(value, needsActive) {
  const { descriptors } = descriptorsFor(value, Object.prototype)
  const getDescriptor = descriptors.get('getBackupKek')
  if (!getDescriptor || typeof getDescriptor.value !== 'function') invalid()
  if (!needsActive) return { getBackupKek: getDescriptor.value }
  const activeDescriptor = descriptors.get('activeBackupKekVersion')
  if (!activeDescriptor || !Number.isSafeInteger(activeDescriptor.value) || activeDescriptor.value <= 0) invalid()
  return { activeBackupKekVersion: activeDescriptor.value, getBackupKek: getDescriptor.value }
}

function validBackupKek(value) {
  try {
    if (typeof CryptoKey !== 'function' || !(value instanceof CryptoKey)) return false
    const algorithm = value.algorithm
    const usages = value.usages
    return value.type === 'secret'
      && value.extractable === false
      && algorithm?.name === 'AES-GCM'
      && algorithm?.length === 256
      && Array.isArray(usages)
      && usages.length === 2
      && usages.includes('encrypt')
      && usages.includes('decrypt')
  } catch {
    return false
  }
}

function decodeBase64Url(value, byteLength) {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1) invalid()
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='))
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (decoded.byteLength !== byteLength || encodeBase64Url(decoded) !== value) {
    decoded.fill(0)
    invalid()
  }
  return decoded
}

function aadFor(facts) {
  return new TextEncoder().encode(`bwm:backup-key:v1\n${canonicalJson(facts)}`)
}

function zero(bytes) {
  try {
    if (bytes instanceof Uint8Array) Uint8Array.prototype.fill.call(bytes, 0)
  } catch {
    // A detached view has no bytes left to erase.
  }
}

export function canonicalJson(value) {
  return attempt(() => canonicalValue(value, new Set()))
}

export function backupObjectKeys(input) {
  return attempt(() => {
    const value = exactObject(input, ['backupId', 'localMonth'])
    if (typeof value.backupId !== 'string' || !BACKUP_ID.test(value.backupId) || !validMonth(value.localMonth)) invalid()
    const [year, month] = value.localMonth.split('-')
    return {
      objectKey: `backups/v1/${year}/${month}/${value.backupId}.sql`,
      manifestKey: `backups/v1/${year}/${month}/${value.backupId}.manifest.json`,
    }
  })
}

export function parseCanonicalManifest(bytes) {
  return attempt(() => {
    if (!(bytes instanceof Uint8Array)) invalid()
    if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) invalid()
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const parsed = JSON.parse(text)
    manifestValue(parsed)
    const canonical = new TextEncoder().encode(canonicalJson(parsed))
    try {
      if (canonical.byteLength !== bytes.byteLength) invalid()
      for (let index = 0; index < bytes.byteLength; index += 1) if (canonical[index] !== bytes[index]) invalid()
    } finally {
      canonical.fill(0)
    }
    return parsed
  })
}

export function expectedObjectMetadata(manifest) {
  return attempt(() => {
    const value = manifestValue(manifest)
    return {
      backupId: value.backupId,
      format: value.format,
      retentionClass: value.retentionClass,
    }
  })
}

export async function createBackupManifest(input) {
  let nonce
  let plaintext
  let aad
  let ciphertext
  try {
    const value = inputValue(input, ['facts', 'rawSsecKey', 'keyring', 'nonceFactory'])
    const facts = factsValue(value.facts)
    const rawSsecKey = mutableBytes(value.rawSsecKey, 32)
    const ring = keyringValue(value.keyring, true)
    if (typeof value.nonceFactory !== 'function') invalid()
    plaintext = new Uint8Array(rawSsecKey)
    nonce = value.nonceFactory()
    if (nonce instanceof Promise) {
      const pendingNonce = nonce
      nonce = undefined
      Promise.prototype.then.call(pendingNonce, (resolved) => zero(resolved), () => {})
      invalid()
    }
    mutableBytes(nonce, 12)
    const kek = await ring.getBackupKek(ring.activeBackupKekVersion)
    if (!validBackupKek(kek)) invalid()
    aad = aadFor(facts)
    ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128,
    }, kek, plaintext))
    if (ciphertext.byteLength !== 48) invalid()
    const manifest = {
      ...facts,
      wrappedSsecKey: {
        algorithm: 'A256GCM',
        kekVersion: ring.activeBackupKekVersion,
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(ciphertext),
      },
    }
    const complete = manifestValue(manifest)
    const bytes = new TextEncoder().encode(canonicalJson(complete))
    return {
      manifest: complete,
      bytes,
      databaseFields: {
        ssecKeyVersion: complete.wrappedSsecKey.kekVersion,
        wrappedSsecKeyB64: complete.wrappedSsecKey.ciphertext,
        wrapNonceB64: complete.wrappedSsecKey.nonce,
      },
    }
  } catch {
    cryptoFailed()
  } finally {
    if (nonce instanceof Uint8Array) zero(nonce)
    zero(plaintext)
    zero(aad)
    zero(ciphertext)
  }
}

export async function openBackupManifest(input) {
  let nonce
  let ciphertext
  let aad
  let plaintext
  try {
    const value = inputValue(input, ['bytes', 'keyring'])
    const manifest = parseCanonicalManifest(value.bytes)
    const ring = keyringValue(value.keyring, false)
    nonce = decodeBase64Url(manifest.wrappedSsecKey.nonce, 12)
    ciphertext = decodeBase64Url(manifest.wrappedSsecKey.ciphertext, 48)
    const kek = await ring.getBackupKek(manifest.wrappedSsecKey.kekVersion)
    if (!validBackupKek(kek)) invalid()
    aad = aadFor(factsValue(Object.fromEntries(FACT_KEYS.map((key) => [key, manifest[key]]))))
    plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128,
    }, kek, ciphertext))
    if (plaintext.byteLength !== 32) invalid()
    const rawSsecKey = plaintext
    plaintext = undefined
    return { manifest, rawSsecKey }
  } catch {
    invalid()
  } finally {
    zero(nonce)
    zero(ciphertext)
    zero(aad)
    zero(plaintext)
  }
}
