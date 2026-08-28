import {
  decryptForScope,
  encryptForScope,
  loadDataKey,
} from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'

export const ACTIVITY_SCOPE = Object.freeze({
  type: 'centre_activity', id: 'centre_1', purpose: 'activity',
})
export const ACTIVITY_PARTICIPANT_LOOKUP_DOMAIN = 'bwm:activity-participant:v1'
export const ACTIVITY_GROUP_LOOKUP_DOMAIN = 'bwm:activity-group:v1'

const PARTICIPANT_ID = /^acp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const GROUP_ID = /^agr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ACTIVITY_RECORD_ID = /^(?:acp|agr|agl|amb|acl|aat|ach|apj)_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PROGRAM_IDS = new Set(['apg_english', 'apg_tus'])
const PAYLOAD_FIELDS = new Set(['record_version', 'request_replay'])
const encoder = new TextEncoder()

const fail = () => { throw new Error('CRYPTO_FAILURE') }

const exact = (value, keys) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail()
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

const frozen = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

const canonicalDisplay = (value, maximum = 160) => {
  if (typeof value !== 'string' || !value.isWellFormed()) fail()
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ')
  if (!normalized.length || /[\p{Cc}\p{Cf}]/u.test(normalized)) fail()
  const bytes = encoder.encode(normalized)
  const valid = bytes.byteLength <= maximum
  bytes.fill(0)
  if (!valid) fail()
  return normalized
}

const identityFacts = (kind, id) => {
  if (kind === 'participant' && typeof id === 'string' && PARTICIPANT_ID.test(id)) {
    return Object.freeze({
      domain: ACTIVITY_PARTICIPANT_LOOKUP_DOMAIN,
      field: 'participant_identity',
      schema: 'activity_participant_identity.v1',
    })
  }
  if (kind === 'group' && typeof id === 'string' && GROUP_ID.test(id)) {
    return Object.freeze({
      domain: ACTIVITY_GROUP_LOOKUP_DOMAIN,
      field: 'group_label',
      schema: 'activity_group_label.v1',
    })
  }
  fail()
}

const fieldFacts = (kind, id) => {
  if (kind === 'groupDetails' && typeof id === 'string' && GROUP_ID.test(id)) {
    return Object.freeze({ field: 'group_details', maximum: 2000 })
  }
  if (kind === 'classTopic' && typeof id === 'string'
    && /^acl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(id)) {
    return Object.freeze({ field: 'class_topic', maximum: 1000 })
  }
  fail()
}

const programId = (value) => {
  if (typeof value !== 'string' || !PROGRAM_IDS.has(value)) fail()
  return value
}

const parseEnvelope = (value) => {
  if (typeof value !== 'string') fail()
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail()
    return parsed
  } catch { fail() }
}

const lookupFor = async (keyring, facts, program, value, version) => {
  if (!Number.isSafeInteger(version) || version < 1) fail()
  const key = keyring?.getLookupHmac?.(version)
  if (!key) fail()
  let message
  let digest
  try {
    const canonical = canonicalDisplay(value).toLocaleLowerCase('pl-PL')
    message = encoder.encode(`${facts.domain}\n${program}\n${canonical}`)
    digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
    if (digest.byteLength !== 32) fail()
    return Object.freeze({
      domain: facts.domain, version, digest: encodeBase64Url(digest),
    })
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  } finally {
    message?.fill(0)
    digest?.fill(0)
  }
}

export async function activityIdentityLookupCandidates(keyring, input) {
  try {
    const value = exact(input, ['kind', 'programId', 'value'])
    const facts = identityFacts(
      value.kind,
      value.kind === 'participant' ? 'acp_lookup' : 'agr_lookup',
    )
    const program = programId(value.programId)
    const versions = keyring?.lookupKeyVersions
    if (!Array.isArray(versions) || versions.length < 1
      || versions.some((version) => !Number.isSafeInteger(version) || version < 1)) fail()
    return Object.freeze(await Promise.all(versions.map(
      (version) => lookupFor(keyring, facts, program, value.value, version),
    )))
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function encryptActivityIdentity(keyring, dataKey, input) {
  try {
    const value = exact(input, ['kind', 'id', 'programId', 'value'])
    const facts = identityFacts(value.kind, value.id)
    const program = programId(value.programId)
    const display = canonicalDisplay(value.value)
    return JSON.stringify(await encryptForScope(keyring, dataKey, {
      expectedScope: ACTIVITY_SCOPE,
      recordId: value.id,
      field: facts.field,
      plaintext: JSON.stringify({
        schema: facts.schema, kind: value.kind, programId: program, value: display,
      }),
    }))
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function decryptActivityIdentity(keyring, dataKey, input) {
  try {
    const value = exact(input, ['kind', 'id', 'programId', 'envelope'])
    const facts = identityFacts(value.kind, value.id)
    const program = programId(value.programId)
    const plaintext = await decryptForScope(keyring, dataKey, {
      expectedScope: ACTIVITY_SCOPE,
      recordId: value.id,
      field: facts.field,
      envelope: parseEnvelope(value.envelope),
    })
    let payload
    try { payload = JSON.parse(plaintext) } catch { fail() }
    const captured = exact(payload, ['schema', 'kind', 'programId', 'value'])
    if (captured.schema !== facts.schema || captured.kind !== value.kind
      || captured.programId !== program) fail()
    return canonicalDisplay(captured.value)
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function encryptActivityField(keyring, dataKey, input) {
  try {
    const value = exact(input, ['kind', 'id', 'value'])
    const facts = fieldFacts(value.kind, value.id)
    const plaintext = canonicalDisplay(value.value, facts.maximum)
    return JSON.stringify(await encryptForScope(keyring, dataKey, {
      expectedScope: ACTIVITY_SCOPE,
      recordId: value.id,
      field: facts.field,
      plaintext,
    }))
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function decryptActivityField(keyring, dataKey, input) {
  try {
    const value = exact(input, ['kind', 'id', 'envelope'])
    const facts = fieldFacts(value.kind, value.id)
    const plaintext = await decryptForScope(keyring, dataKey, {
      expectedScope: ACTIVITY_SCOPE,
      recordId: value.id,
      field: facts.field,
      envelope: parseEnvelope(value.envelope),
    })
    return canonicalDisplay(plaintext, facts.maximum)
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

const captureJson = (value, seen = new Set(), depth = 0) => {
  if (depth > 12 || seen.has(value)) fail()
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail()
    return value
  }
  if (!value || typeof value !== 'object') fail()
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > 1000) fail()
      const descriptors = Object.getOwnPropertyDescriptors(value)
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index]
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
      }
      const unexpected = Reflect.ownKeys(descriptors).filter((key) => key !== 'length'
        && !(typeof key === 'string' && /^\d+$/.test(key) && Number(key) < value.length))
      if (unexpected.length) fail()
      return value.map((item) => captureJson(item, seen, depth + 1))
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) fail()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result = {}
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key]
      if (typeof key !== 'string' || !descriptor?.enumerable
        || !Object.hasOwn(descriptor, 'value')) fail()
      result[key] = captureJson(descriptor.value, seen, depth + 1)
    }
    return result
  } finally { seen.delete(value) }
}

const payloadInput = (input, includeEnvelope) => {
  const value = exact(input, includeEnvelope
    ? ['recordId', 'field', 'envelope']
    : ['recordId', 'field', 'value'])
  if (typeof value.recordId !== 'string' || !ACTIVITY_RECORD_ID.test(value.recordId)
    || typeof value.field !== 'string' || !PAYLOAD_FIELDS.has(value.field)) fail()
  return value
}

export async function sealActivityPayload(keyring, dataKey, input) {
  try {
    const value = payloadInput(input, false)
    const payload = captureJson(value.value)
    const plaintext = JSON.stringify(payload)
    const bytes = encoder.encode(plaintext)
    const valid = bytes.byteLength <= 16_384
    bytes.fill(0)
    if (!valid) fail()
    return JSON.stringify(await encryptForScope(keyring, dataKey, {
      expectedScope: ACTIVITY_SCOPE,
      recordId: value.recordId,
      field: value.field,
      plaintext,
    }))
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function openActivityPayload(keyring, dataKey, input) {
  try {
    const value = payloadInput(input, true)
    const plaintext = await decryptForScope(keyring, dataKey, {
      expectedScope: ACTIVITY_SCOPE,
      recordId: value.recordId,
      field: value.field,
      envelope: parseEnvelope(value.envelope),
    })
    let parsed
    try { parsed = JSON.parse(plaintext) } catch { fail() }
    return frozen(captureJson(parsed))
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}

export async function loadActivityDataKey(db, serializedEnvelope) {
  try {
    if (!db?.prepare) fail()
    return Object.freeze(await loadDataKey(db, {
      envelope: parseEnvelope(serializedEnvelope), expectedScope: ACTIVITY_SCOPE,
    }))
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    fail()
  }
}
