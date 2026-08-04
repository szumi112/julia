import {
  createWrappedDataKey,
  decryptForScope,
  encryptForScope,
  loadDataKey,
} from '../security/envelope.js'
import {
  assertClientIdentity,
  assertCorrectionReason,
  isCorrectionId,
} from '../../src/core-records.js'

const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const fail = () => { throw new Error('CRYPTO_FAILURE') }

export function clientKeyScope(clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) fail()
  return Object.freeze({ type: 'client', id: clientId, purpose: 'identity' })
}

export function assertClientKeyScope(scope) {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).length !== 3
    || scope.type !== 'client'
    || typeof scope.id !== 'string' || !CLIENT_ID.test(scope.id)
    || scope.purpose !== 'identity') fail()
  return Object.freeze({ type: scope.type, id: scope.id, purpose: scope.purpose })
}

const exactObject = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))

const canonicalInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

export async function buildClientDataKey(db, keyring, input) {
  try {
    if (!db?.prepare || !exactObject(input, ['clientId', 'dataKeyId', 'createdAt'])
      || typeof input.dataKeyId !== 'string' || !OPAQUE_ID.test(input.dataKeyId)
      || !canonicalInstant(input.createdAt)) fail()
    const scope = clientKeyScope(input.clientId)
    const row = Object.freeze(await createWrappedDataKey(keyring, {
      scope, id: input.dataKeyId, createdAt: input.createdAt,
    }))
    const statement = db.prepare(
      `INSERT INTO data_keys
       (id, scope_type, scope_id, purpose, dek_version, wrapped_key_b64,
        wrap_nonce_b64, kek_version, created_at, retired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id, row.scope_type, row.scope_id, row.purpose, row.dek_version,
      row.wrapped_key_b64, row.wrap_nonce_b64, row.kek_version, row.created_at,
      row.retired_at,
    )
    return Object.freeze({ row, scope, statement })
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

const parseEnvelope = (value) => {
  if (typeof value !== 'string') fail()
  try { return JSON.parse(value) } catch { fail() }
}

const cryptoContext = (context) => {
  if (!exactObject(context, ['keyring', 'dataKey', 'scope']) || !context.keyring
    || !context.dataKey) fail()
  const scope = assertClientKeyScope(context.scope)
  if (context.dataKey.scope_type !== scope.type
    || context.dataKey.scope_id !== scope.id
    || context.dataKey.purpose !== scope.purpose) fail()
  return { keyring: context.keyring, dataKey: context.dataKey, scope }
}

const serializedEnvelope = async (operation) => JSON.stringify(await operation)

export async function loadClientCryptoContext(db, keyring, input) {
  try {
    if (!db?.prepare || !keyring
      || !exactObject(input, ['clientId', 'envelope'])) fail()
    const scope = clientKeyScope(input.clientId)
    const dataKey = await loadDataKey(db, {
      envelope: parseEnvelope(input.envelope), expectedScope: scope,
    })
    return Object.freeze({ keyring, dataKey: Object.freeze(dataKey), scope })
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function encryptClientIdentity(context, input) {
  try {
    const current = cryptoContext(context)
    if (!exactObject(input, ['clientId', 'name', 'age'])
      || input.clientId !== current.scope.id) fail()
    const identity = assertClientIdentity({ name: input.name, age: input.age })
    const plaintext = JSON.stringify({
      schema: 'client.identity.v1', name: identity.name, age: identity.age,
    })
    return await serializedEnvelope(encryptForScope(
      current.keyring,
      current.dataKey,
      {
        expectedScope: current.scope,
        recordId: input.clientId,
        field: 'identity',
        plaintext,
      },
    ))
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function decryptClientIdentity(context, input) {
  try {
    const current = cryptoContext(context)
    if (!exactObject(input, ['clientId', 'envelope'])
      || input.clientId !== current.scope.id) fail()
    const plaintext = await decryptForScope(
      current.keyring,
      current.dataKey,
      {
        expectedScope: current.scope,
        recordId: input.clientId,
        field: 'identity',
        envelope: parseEnvelope(input.envelope),
      },
    )
    const parsed = JSON.parse(plaintext)
    if (!exactObject(parsed, ['schema', 'name', 'age'])
      || parsed.schema !== 'client.identity.v1') fail()
    return Object.freeze(assertClientIdentity({ name: parsed.name, age: parsed.age }))
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function encryptClientCorrectionReason(context, input) {
  try {
    const current = cryptoContext(context)
    if (!exactObject(input, ['correctionId', 'reason'])
      || !isCorrectionId(input.correctionId)) fail()
    const reason = assertCorrectionReason(input.reason)
    return await serializedEnvelope(encryptForScope(
      current.keyring,
      current.dataKey,
      {
        expectedScope: current.scope,
        recordId: input.correctionId,
        field: 'reason',
        plaintext: reason,
      },
    ))
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function decryptClientCorrectionReason(context, input) {
  try {
    const current = cryptoContext(context)
    if (!exactObject(input, ['correctionId', 'envelope'])
      || !isCorrectionId(input.correctionId)) fail()
    const reason = await decryptForScope(
      current.keyring,
      current.dataKey,
      {
        expectedScope: current.scope,
        recordId: input.correctionId,
        field: 'reason',
        envelope: parseEnvelope(input.envelope),
      },
    )
    return assertCorrectionReason(reason)
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}
