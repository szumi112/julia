import { decodeBase64Url, encodeBase64Url } from './encoding.js'

const NAME = /^[a-z][a-z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const ROW_KEYS = ['id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64', 'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at']
const ENVELOPE_KEYS = ['format', 'algorithm', 'dataKeyId', 'dataKeyVersion', 'nonce', 'ciphertext']
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const cryptoFailure = () => new Error('CRYPTO_FAILURE')
const fail = () => { throw cryptoFailure() }
const positive = (value) => Number.isSafeInteger(value) && value > 0
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const validateScope = (scope) => {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).length !== 3 || !['type', 'id', 'purpose'].every((key) => Object.hasOwn(scope, key))
    || typeof scope.type !== 'string' || typeof scope.id !== 'string' || typeof scope.purpose !== 'string'
    || !NAME.test(scope.type) || !ID.test(scope.id) || !NAME.test(scope.purpose)) fail()
  return scope
}

const validateId = (value) => {
  if (typeof value !== 'string' || !ID.test(value)) fail()
  return value
}

const canonicalInstant = (value) => typeof value === 'string' && UTC_INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

const bytes = (value, length, minimum = false) => {
  let decoded
  try { decoded = decodeBase64Url(value) } catch { fail() }
  if ((minimum && decoded.byteLength < length) || (!minimum && decoded.byteLength !== length)) {
    decoded.fill(0)
    fail()
  }
  return decoded
}

const keyAad = (scope, dekVersion) => new TextEncoder().encode([
  'bwm:key:v1', scope.type, scope.id, scope.purpose, String(dekVersion),
].join('\n'))

const fieldAad = (scope, recordId, field, dataKeyId, dataKeyVersion) => new TextEncoder().encode([
  'bwm:field:v1', scope.type, scope.id, scope.purpose, recordId, field, dataKeyId, String(dataKeyVersion),
].join('\n'))

const scopeFromRow = (row) => ({ type: row.scope_type, id: row.scope_id, purpose: row.purpose })

const sameScope = (left, right) => left.type === right.type && left.id === right.id && left.purpose === right.purpose

const validateRow = (row, expectedScope) => {
  if (!exactKeys(row, ROW_KEYS)) fail()
  const scope = validateScope(scopeFromRow(row))
  const expected = validateScope(expectedScope)
  if (!sameScope(scope, expected) || !validateId(row.id) || !positive(row.dek_version) || !positive(row.kek_version)
    || !canonicalInstant(row.created_at) || (row.retired_at !== null && !canonicalInstant(row.retired_at))) fail()
  const wrapped = bytes(row.wrapped_key_b64, 48)
  const nonce = bytes(row.wrap_nonce_b64, 12)
  wrapped.fill(0)
  nonce.fill(0)
  return scope
}

const validateEnvelope = (envelope) => {
  if (!exactKeys(envelope, ENVELOPE_KEYS) || envelope.format !== 1 || envelope.algorithm !== 'A256GCM'
    || !validateId(envelope.dataKeyId) || !positive(envelope.dataKeyVersion)) fail()
  const nonce = bytes(envelope.nonce, 12)
  const ciphertext = bytes(envelope.ciphertext, 16, true)
  nonce.fill(0)
  ciphertext.fill(0)
}

const aesParams = (nonce, additionalData) => ({ name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 })

async function unwrapDataKeyBytes(keyring, row, expectedScope) {
  const scope = validateRow(row, expectedScope)
  const kek = keyring?.getDataKek?.(row.kek_version)
  if (!kek) fail()
  let wrapped
  let nonce
  try {
    wrapped = bytes(row.wrapped_key_b64, 48)
    nonce = bytes(row.wrap_nonce_b64, 12)
    const result = await crypto.subtle.decrypt(aesParams(nonce, keyAad(scope, row.dek_version)), kek, wrapped)
    const raw = new Uint8Array(result)
    if (raw.byteLength !== 32) {
      raw.fill(0)
      fail()
    }
    return raw
  } catch {
    fail()
  } finally {
    wrapped?.fill(0)
    nonce?.fill(0)
  }
}

async function importDek(raw) {
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  } catch {
    fail()
  } finally {
    raw.fill(0)
  }
}

const defaultId = () => crypto.randomUUID().replaceAll('-', '')

export async function createWrappedDataKey(keyring, { scope, id, dekVersion = 1, createdAt } = {}) {
  try {
    validateScope(scope)
    validateId(id)
    if (!positive(dekVersion) || !canonicalInstant(createdAt)) fail()
    const kekVersion = keyring?.activeDataKekVersion
    const kek = keyring?.getDataKek?.(kekVersion)
    if (!positive(kekVersion) || !kek) fail()
    let rawDek
    let nonce
    try {
      rawDek = crypto.getRandomValues(new Uint8Array(32))
      nonce = crypto.getRandomValues(new Uint8Array(12))
      const wrapped = new Uint8Array(await crypto.subtle.encrypt(aesParams(nonce, keyAad(scope, dekVersion)), kek, rawDek))
      try {
        if (wrapped.byteLength !== 48) fail()
        return {
          id,
          scope_type: scope.type,
          scope_id: scope.id,
          purpose: scope.purpose,
          dek_version: dekVersion,
          wrapped_key_b64: encodeBase64Url(wrapped),
          wrap_nonce_b64: encodeBase64Url(nonce),
          kek_version: kekVersion,
          created_at: createdAt,
          retired_at: null,
        }
      } finally { wrapped.fill(0) }
    } finally {
      rawDek?.fill(0)
      nonce?.fill(0)
    }
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

const selectExact = async (db, scope, dekVersion) => db.prepare(
  `SELECT id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64, wrap_nonce_b64, kek_version, created_at, retired_at
   FROM data_keys WHERE scope_type = ? AND scope_id = ? AND purpose = ? AND dek_version = ?`
).bind(scope.type, scope.id, scope.purpose, dekVersion).first()

const isDataKeyCollision = (error) => error instanceof Error && error.message.includes('identity_collision')

export async function getOrCreateDataKey(db, keyring, scope, { id = defaultId(), dekVersion = 1, createdAt = new Date().toISOString() } = {}) {
  validateScope(scope)
  if (!positive(dekVersion)) fail()
  const existing = await selectExact(db, scope, dekVersion)
  if (existing) {
    validateRow(existing, scope)
    return existing
  }
  const row = await createWrappedDataKey(keyring, { scope, id, dekVersion, createdAt })
  try {
    await db.prepare(
      `INSERT INTO data_keys (id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64, wrap_nonce_b64, kek_version, created_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(row.id, row.scope_type, row.scope_id, row.purpose, row.dek_version, row.wrapped_key_b64, row.wrap_nonce_b64, row.kek_version, row.created_at, row.retired_at).run()
    return row
  } catch (error) {
    if (!isDataKeyCollision(error)) throw error
    let winner
    try {
      winner = await selectExact(db, scope, dekVersion)
    } catch {
      throw error
    }
    if (winner) {
      validateRow(winner, scope)
      return winner
    }
    throw error
  }
}

export async function loadDataKey(db, { envelope, expectedScope } = {}) {
  try {
    validateScope(expectedScope)
    validateEnvelope(envelope)
    const row = await db.prepare(
      `SELECT id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64, wrap_nonce_b64, kek_version, created_at, retired_at
       FROM data_keys WHERE id = ? AND dek_version = ? AND scope_type = ? AND scope_id = ? AND purpose = ?`
    ).bind(envelope.dataKeyId, envelope.dataKeyVersion, expectedScope.type, expectedScope.id, expectedScope.purpose).first()
    if (!row) fail()
    validateRow(row, expectedScope)
    return row
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    throw error
  }
}

export async function encryptForScope(keyring, dataKey, { expectedScope, recordId, field, plaintext } = {}) {
  try {
    const scope = validateRow(dataKey, expectedScope)
    if (dataKey.retired_at !== null || !validateId(recordId) || typeof field !== 'string' || !NAME.test(field) || typeof plaintext !== 'string') fail()
    const raw = await unwrapDataKeyBytes(keyring, dataKey, expectedScope)
    const dek = await importDek(raw)
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    let encoded
    try {
      encoded = new TextEncoder().encode(plaintext)
      const cipher = new Uint8Array(await crypto.subtle.encrypt(aesParams(nonce, fieldAad(scope, recordId, field, dataKey.id, dataKey.dek_version)), dek, encoded))
      try {
        if (cipher.byteLength < 16) fail()
        return { format: 1, algorithm: 'A256GCM', dataKeyId: dataKey.id, dataKeyVersion: dataKey.dek_version, nonce: encodeBase64Url(nonce), ciphertext: encodeBase64Url(cipher) }
      } finally { cipher.fill(0) }
    } finally {
      nonce.fill(0)
      encoded?.fill(0)
    }
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function decryptForScope(keyring, dataKey, { expectedScope, recordId, field, envelope } = {}) {
  try {
    const scope = validateRow(dataKey, expectedScope)
    validateEnvelope(envelope)
    if (!validateId(recordId) || typeof field !== 'string' || !NAME.test(field)
      || envelope.dataKeyId !== dataKey.id || envelope.dataKeyVersion !== dataKey.dek_version) fail()
    const raw = await unwrapDataKeyBytes(keyring, dataKey, expectedScope)
    const dek = await importDek(raw)
    let nonce
    let ciphertext
    let plain
    try {
      nonce = bytes(envelope.nonce, 12)
      ciphertext = bytes(envelope.ciphertext, 16, true)
      plain = new Uint8Array(await crypto.subtle.decrypt(aesParams(nonce, fieldAad(scope, recordId, field, dataKey.id, dataKey.dek_version)), dek, ciphertext))
      return new TextDecoder('utf-8', { fatal: true }).decode(plain)
    } finally {
      nonce?.fill(0)
      ciphertext?.fill(0)
      plain?.fill(0)
    }
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function rewrapDataKey(keyring, dataKey, { targetKekVersion } = {}) {
  try {
    const scope = scopeFromRow(dataKey ?? {})
    validateRow(dataKey, scope)
    if (!positive(targetKekVersion) || targetKekVersion <= dataKey.kek_version) fail()
    const target = keyring?.getDataKek?.(targetKekVersion)
    if (!target) fail()
    const raw = await unwrapDataKeyBytes(keyring, dataKey, scope)
    let nonce
    try {
      nonce = crypto.getRandomValues(new Uint8Array(12))
      const wrapped = new Uint8Array(await crypto.subtle.encrypt(aesParams(nonce, keyAad(scope, dataKey.dek_version)), target, raw))
      try {
        if (wrapped.byteLength !== 48) fail()
        const where = Object.freeze({ id: dataKey.id, scope_type: dataKey.scope_type, scope_id: dataKey.scope_id, purpose: dataKey.purpose, dek_version: dataKey.dek_version, wrapped_key_b64: dataKey.wrapped_key_b64, wrap_nonce_b64: dataKey.wrap_nonce_b64, kek_version: dataKey.kek_version })
        const set = Object.freeze({ wrapped_key_b64: encodeBase64Url(wrapped), wrap_nonce_b64: encodeBase64Url(nonce), kek_version: targetKekVersion })
        return Object.freeze({ where, set })
      } finally { wrapped.fill(0) }
    } finally {
      raw.fill(0)
      nonce?.fill(0)
    }
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

const normalizedEmail = (email) => {
  if (typeof email !== 'string') fail()
  const value = email.trim().toLowerCase()
  if (!value) fail()
  return value
}

export async function blindEmailIndex(email, keyring, version = keyring?.activeLookupKeyVersion) {
  const normalized = normalizedEmail(email)
  if (!positive(version)) fail()
  const key = keyring?.getLookupHmac?.(version)
  if (!key) fail()
  let raw
  let signature
  try {
    raw = new TextEncoder().encode(normalized)
    signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, raw))
    if (signature.byteLength !== 32) fail()
    return `v${version}:${encodeBase64Url(signature)}`
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  } finally {
    raw?.fill(0)
    signature?.fill(0)
  }
}

export async function blindEmailCandidates(email, keyring) {
  const versions = keyring?.lookupKeyVersions
  if (!Array.isArray(versions)) fail()
  return Promise.all(versions.map((version) => blindEmailIndex(email, keyring, version)))
}
