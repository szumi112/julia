import { canonicalHistoricalName } from '../../src/historical-records.js'
import {
  createWrappedDataKey,
  decryptForScope,
  encryptForScope,
  loadDataKey,
} from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'

export const HISTORICAL_PERSON_LOOKUP_DOMAIN = 'bwm:historical-person:v1'
export const HISTORICAL_COUNTERPARTY_LOOKUP_DOMAIN = 'bwm:historical-counterparty:v1'

const CLIENT_ID = /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const COUNTERPARTY_ID = /^hcp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const fail = () => { throw new Error('CRYPTO_FAILURE') }
const exact = (value, keys) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) fail()
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
      captured[key] = descriptor.value
    }
    return captured
  } catch { fail() }
}

const kindFacts = (kind, id) => {
  if (kind === 'person' && typeof id === 'string' && CLIENT_ID.test(id)) {
    return Object.freeze({
      domain: HISTORICAL_PERSON_LOOKUP_DOMAIN,
      scope: Object.freeze({ type: 'historical_client', id, purpose: 'identity' }),
    })
  }
  if (kind === 'counterparty' && typeof id === 'string' && COUNTERPARTY_ID.test(id)) {
    return Object.freeze({
      domain: HISTORICAL_COUNTERPARTY_LOOKUP_DOMAIN,
      scope: Object.freeze({ type: 'historical_counterparty', id, purpose: 'identity' }),
    })
  }
  fail()
}

const canonicalDisplayName = (value) => {
  canonicalHistoricalName(value)
  const display = value.normalize('NFC').trim().replace(/\s+/gu, ' ')
  if (/[\p{Cc}\p{Cf}]/u.test(display)) fail()
  return display
}

const canonicalInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

const lookupFor = async (keyring, kind, name, version) => {
  const facts = kindFacts(kind, kind === 'person' ? 'hcl_lookup' : 'hcp_lookup')
  if (!Number.isSafeInteger(version) || version < 1) fail()
  const key = keyring?.getLookupHmac?.(version)
  if (!key) fail()
  let message
  let digest
  try {
    message = new TextEncoder().encode(`${facts.domain}\n${canonicalHistoricalName(name)}`)
    digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
    if (digest.byteLength !== 32) fail()
    return Object.freeze({ version, digest: encodeBase64Url(digest), domain: facts.domain })
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  } finally {
    message?.fill(0)
    digest?.fill(0)
  }
}

export async function historicalIdentityLookupCandidates(keyring, kind, name) {
  const versions = keyring?.lookupKeyVersions
  if (!Array.isArray(versions) || versions.length < 1
    || versions.some((version) => !Number.isSafeInteger(version) || version < 1)) fail()
  return Object.freeze(await Promise.all(versions.map(
    (version) => lookupFor(keyring, kind, name, version),
  )))
}

export async function buildHistoricalIdentity(db, keyring, input) {
  try {
    if (!db?.prepare || !keyring) fail()
    const value = exact(input, ['kind', 'id', 'dataKeyId', 'name', 'createdAt'])
    const facts = kindFacts(value.kind, value.id)
    if (typeof value.dataKeyId !== 'string' || !KEY_ID.test(value.dataKeyId)
      || !canonicalInstant(value.createdAt)) fail()
    const name = canonicalDisplayName(value.name)
    const dataKey = await createWrappedDataKey(keyring, {
      scope: facts.scope, id: value.dataKeyId, createdAt: value.createdAt,
    })
    const envelope = await encryptForScope(keyring, dataKey, {
      expectedScope: facts.scope,
      recordId: value.id,
      field: 'identity',
      plaintext: JSON.stringify({ schema: 'historical_identity.v1', kind: value.kind, name }),
    })
    return Object.freeze({
      dataKey,
      identityEnvelope: JSON.stringify(envelope),
      lookups: await historicalIdentityLookupCandidates(keyring, value.kind, name),
      keyStatement: db.prepare(`INSERT INTO data_keys
        (id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
         kek_version,created_at,retired_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        dataKey.id, dataKey.scope_type, dataKey.scope_id, dataKey.purpose,
        dataKey.dek_version, dataKey.wrapped_key_b64, dataKey.wrap_nonce_b64,
        dataKey.kek_version, dataKey.created_at, dataKey.retired_at,
      ),
    })
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function decryptHistoricalIdentity(db, keyring, input) {
  try {
    if (!db?.prepare || !keyring) fail()
    const value = exact(input, ['kind', 'id', 'envelope'])
    const facts = kindFacts(value.kind, value.id)
    let envelope
    try { envelope = JSON.parse(value.envelope) } catch { fail() }
    const dataKey = await loadDataKey(db, { envelope, expectedScope: facts.scope })
    const plaintext = await decryptForScope(keyring, dataKey, {
      expectedScope: facts.scope,
      recordId: value.id,
      field: 'identity',
      envelope,
    })
    let payload
    try { payload = JSON.parse(plaintext) } catch { fail() }
    const captured = exact(payload, ['schema', 'kind', 'name'])
    if (captured.schema !== 'historical_identity.v1' || captured.kind !== value.kind) fail()
    return canonicalDisplayName(captured.name)
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function decryptHistoricalIdentityWithDataKey(keyring, input) {
  try {
    const value = exact(input, ['kind', 'id', 'envelope', 'dataKey'])
    const facts = kindFacts(value.kind, value.id)
    let envelope
    try { envelope = JSON.parse(value.envelope) } catch { fail() }
    const plaintext = await decryptForScope(keyring, value.dataKey, {
      expectedScope: facts.scope, recordId: value.id, field: 'identity', envelope,
    })
    let payload
    try { payload = JSON.parse(plaintext) } catch { fail() }
    const captured = exact(payload, ['schema', 'kind', 'name'])
    if (captured.schema !== 'historical_identity.v1' || captured.kind !== value.kind) fail()
    return canonicalDisplayName(captured.name)
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function encryptHistoricalField(db, keyring, input) {
  try {
    const value = exact(input, ['kind', 'id', 'identityEnvelope', 'field', 'value'])
    const facts = kindFacts(value.kind, value.id)
    let envelope
    try { envelope = JSON.parse(value.identityEnvelope) } catch { fail() }
    const dataKey = await loadDataKey(db, { envelope, expectedScope: facts.scope })
    return JSON.stringify(await encryptForScope(keyring, dataKey, {
      expectedScope: facts.scope, recordId: value.id, field: value.field,
      plaintext: value.value,
    }))
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}
