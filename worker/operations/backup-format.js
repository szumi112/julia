const INVALID = 'BACKUP_MANIFEST_INVALID'
const POLLUTING_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ROOT_KEYS = [
  'format', 'backupId', 'createdAt', 'localDay', 'localMonth', 'retentionClass',
  'objectKey', 'objectEtag', 'objectSize', 'atBookmark', 'wrappedSsecKey',
]
const WRAPPED_KEY_KEYS = ['algorithm', 'kekVersion', 'nonce', 'ciphertext']
const BACKUP_ID = /^bkp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const BASE64URL = /^[A-Za-z0-9_-]*$/
const UNSAFE_OPAQUE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

const invalid = () => { throw new Error(INVALID) }

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

function manifestValue(value) {
  const manifest = exactObject(value, ROOT_KEYS)
  const wrapped = exactObject(manifest.wrappedSsecKey, WRAPPED_KEY_KEYS)
  if (manifest.format !== 'bwm-d1-sql-v1'
    || typeof manifest.backupId !== 'string' || !BACKUP_ID.test(manifest.backupId)
    || !validInstant(manifest.createdAt)
    || !validDay(manifest.localDay) || !validMonth(manifest.localMonth)
    || manifest.localDay.slice(0, 7) !== manifest.localMonth
    || !['daily', 'monthly'].includes(manifest.retentionClass)
    || !validOpaque(manifest.objectEtag) || !validOpaque(manifest.atBookmark)
    || !Number.isSafeInteger(manifest.objectSize) || manifest.objectSize < 0
    || wrapped.algorithm !== 'A256GCM'
    || !Number.isSafeInteger(wrapped.kekVersion) || wrapped.kekVersion <= 0
    || !validBase64Url(wrapped.nonce, 12) || !validBase64Url(wrapped.ciphertext, 48)) invalid()
  const keys = backupObjectKeys({ backupId: manifest.backupId, localMonth: manifest.localMonth })
  if (manifest.objectKey !== keys.objectKey) invalid()
  return manifest
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
