import { decodeBase64Url, encodeBase64Url } from './encoding.js'
import { compareUtf16CodeUnits } from '../../src/code-unit-order.js'

const ARTIFACT_DOMAIN = 'workbook-artifact-v1'
const ARTIFACT_AAD_DOMAIN = 'bwm/workbook-artifact/aes-gcm/v1'
const ARTIFACT_HMAC_DOMAIN = 'bwm/workbook-artifact/metadata-hmac/v1'
const PREVIEW_HMAC_DOMAIN = 'bwm/workbook-preview-token/hmac/v1'
const PREVIEW_PLAN_HMAC_DOMAIN = 'bwm/workbook-preview-plan/hmac/v1'
const PANEL_HMAC_DOMAIN = 'bwm/workbook-panel-metadata/hmac/v1'
const PANEL_FIELD_HMAC_DOMAIN = 'bwm/workbook-panel-field/hmac/v1'
const SOURCE_RECORD_HMAC_DOMAIN = 'bwm/workbook-source-record/hmac/v1'
const SOURCE_VALUE_HMAC_DOMAIN = 'bwm/workbook-source-value/hmac/v1'
const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024
const FINGERPRINT = /^[0-9a-f]{64}$/
const CENTRE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const OBJECT_KEY = /^workbook-objects\/wbo_[A-Za-z0-9][A-Za-z0-9_-]{23,123}$/
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/
const SOURCE_KEY = /^workbook:v1:\d{1,4}:\d{1,7}:\d{1,5}$/
const TOKEN = /^v1\.([1-9]\d*)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/
const VERSIONED_DIGEST = /^v([1-9]\d*)_[A-Za-z0-9_-]{43}$/
const utf8 = new TextEncoder()

const artifactInvalid = () => { throw new Error('WORKBOOK_ARTIFACT_INVALID') }
const tokenInvalid = () => { throw new Error('WORKBOOK_PREVIEW_TOKEN_INVALID') }
const panelInvalid = () => { throw new Error('WORKBOOK_PANEL_SIGNATURE_INVALID') }
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const exactInstantMs = (value) => Number.isSafeInteger(value) && value >= 0
const exactBytes = (value) => value instanceof Uint8Array
  ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  : null

const digestHex = async (bytes) => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0')).join('')
}

const artifactFacts = (value) => [
  ARTIFACT_DOMAIN,
  value.environment,
  value.centreId,
  value.objectKey,
  value.fingerprint,
  value.byteSize,
  value.parserVersion,
  value.materializerVersion,
  value.contentNonce,
  value.workbookKekVersion,
  value.metadataHmacVersion,
]

const artifactMessage = (domain, value) => utf8.encode(`${domain}\n${JSON.stringify(artifactFacts(value))}`)

const validArtifactFacts = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && value.environment === 'staging'
  && typeof value.centreId === 'string' && CENTRE_ID.test(value.centreId)
  && typeof value.objectKey === 'string' && OBJECT_KEY.test(value.objectKey)
  && typeof value.fingerprint === 'string' && FINGERPRINT.test(value.fingerprint)
  && positiveInteger(value.byteSize) && value.byteSize <= MAX_WORKBOOK_BYTES
  && positiveInteger(value.parserVersion)
  && positiveInteger(value.materializerVersion)
  && typeof value.contentNonce === 'string'
  && positiveInteger(value.workbookKekVersion)
  && positiveInteger(value.metadataHmacVersion)

const metadataFrom = (value) => ({
  bwmDomain: ARTIFACT_DOMAIN,
  byteSize: String(value.byteSize),
  centreId: value.centreId,
  contentNonce: value.contentNonce,
  environment: value.environment,
  fingerprint: value.fingerprint,
  materializerVersion: String(value.materializerVersion),
  metadataHmacVersion: String(value.metadataHmacVersion),
  metadataSignature: value.metadataSignature,
  objectKey: value.objectKey,
  parserVersion: String(value.parserVersion),
  workbookKekVersion: String(value.workbookKekVersion),
})

const sameMetadata = (actual, expected) => {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
  const expectedKeys = Object.keys(expected).sort(compareUtf16CodeUnits)
  const actualKeys = Object.keys(actual).sort(compareUtf16CodeUnits)
  return expectedKeys.length === actualKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index] && actual[key] === expected[key])
}

const activeWorkbookKeys = (keyring, config, invalid) => {
  const kekVersion = config?.activeWorkbookKekVersion
  const hmacVersion = config?.activeWorkbookHmacVersion
  const kek = positiveInteger(kekVersion) && typeof keyring?.getWorkbookKek === 'function'
    ? keyring.getWorkbookKek(kekVersion)
    : null
  const hmac = positiveInteger(hmacVersion) && typeof keyring?.getWorkbookHmac === 'function'
    ? keyring.getWorkbookHmac(hmacVersion)
    : null
  if (!kek || !hmac) invalid()
  return { kek, kekVersion, hmac, hmacVersion }
}

const randomBytes = (size) => crypto.getRandomValues(new Uint8Array(size))

const canonicalDigestValue = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    // Raw legacy cells carry ordinary decimal amounts; only non-finite numbers
    // lack a stable JSON representation and cannot be signed.
    if (!Number.isFinite(value)) panelInvalid()
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalDigestValue)
  if (!value || typeof value !== 'object') panelInvalid()
  const result = {}
  for (const key of Object.keys(value).sort(compareUtf16CodeUnits)) {
    if (value[key] === undefined) panelInvalid()
    result[key] = canonicalDigestValue(value[key])
  }
  return result
}

const provenanceHmac = async ({
  keyring, config, centreId, domain, facts, value, hmacVersion,
}, invalid = panelInvalid) => {
  try {
    if (config?.appEnv !== 'staging' || typeof centreId !== 'string'
      || !CENTRE_ID.test(centreId) || !Array.isArray(facts)
      || facts.some((fact) => typeof fact !== 'string' || fact.includes('\n'))) invalid()
    const version = hmacVersion ?? config.activeWorkbookHmacVersion
    const hmac = positiveInteger(version) && typeof keyring?.getWorkbookHmac === 'function'
      ? keyring.getWorkbookHmac(version)
      : null
    if (!hmac) invalid()
    const canonical = JSON.stringify(canonicalDigestValue(value))
    const message = utf8.encode([domain, config.appEnv, centreId, ...facts, canonical].join('\n'))
    return Object.freeze({
      digest: encodeBase64Url(await crypto.subtle.sign('HMAC', hmac, message)),
      hmacVersion: version,
    })
  } catch (error) {
    if (error?.message === 'WORKBOOK_PANEL_SIGNATURE_INVALID') throw error
    invalid()
  }
}

export async function digestWorkbookSourcePayload({
  keyring, config, centreId, sourceKey, payload, hmacVersion,
} = {}) {
  if (typeof sourceKey !== 'string' || !SOURCE_KEY.test(sourceKey)) panelInvalid()
  return provenanceHmac({
    keyring, config, centreId, domain: SOURCE_RECORD_HMAC_DOMAIN,
    facts: [sourceKey], value: payload, hmacVersion,
  })
}

export async function digestWorkbookSourceValue({
  keyring, config, centreId, sourceValueKind, sourceValue, hmacVersion,
} = {}) {
  if (!['blank', 'explicit_name'].includes(sourceValueKind)
    || typeof sourceValue !== 'string'
    || sourceValue !== sourceValue.trim().normalize('NFC')) panelInvalid()
  return provenanceHmac({
    keyring, config, centreId, domain: SOURCE_VALUE_HMAC_DOMAIN,
    facts: [sourceValueKind], value: sourceValue, hmacVersion,
  })
}

export async function digestWorkbookPreviewPlan({
  keyring, config, centreId, actorId, plan, hmacVersion,
} = {}) {
  if (typeof actorId !== 'string' || !STAFF_ID.test(actorId)) panelInvalid()
  const result = await provenanceHmac({
    keyring,
    config,
    centreId,
    domain: PREVIEW_PLAN_HMAC_DOMAIN,
    facts: [actorId],
    value: plan,
    hmacVersion,
  })
  return `v${result.hmacVersion}_${result.digest}`
}

export async function storeWorkbookArtifact({
  bucket,
  keyring,
  config,
  centreId,
  objectKey,
  bytes: source,
  fingerprint,
  parserVersion,
  materializerVersion,
  nonceFactory = () => randomBytes(12),
}) {
  try {
    const bytes = exactBytes(source)
    if (!bytes || bytes.byteLength < 1 || bytes.byteLength > MAX_WORKBOOK_BYTES
      || config?.appEnv !== 'staging' || typeof bucket?.put !== 'function'
      || typeof nonceFactory !== 'function') artifactInvalid()
    if (await digestHex(bytes) !== fingerprint) artifactInvalid()
    const { kek, kekVersion, hmac, hmacVersion } = activeWorkbookKeys(
      keyring, config, artifactInvalid,
    )
    const nonce = exactBytes(nonceFactory())
    if (!nonce || nonce.byteLength !== 12) artifactInvalid()
    const descriptor = {
      environment: config.appEnv,
      centreId,
      objectKey,
      fingerprint,
      byteSize: bytes.byteLength,
      parserVersion,
      materializerVersion,
      contentNonce: encodeBase64Url(nonce),
      workbookKekVersion: kekVersion,
      metadataHmacVersion: hmacVersion,
    }
    if (!validArtifactFacts(descriptor)) artifactInvalid()
    const metadataSignature = encodeBase64Url(await crypto.subtle.sign(
      'HMAC', hmac, artifactMessage(ARTIFACT_HMAC_DOMAIN, descriptor),
    ))
    const signed = Object.freeze({ ...descriptor, metadataSignature })
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: nonce,
      additionalData: artifactMessage(ARTIFACT_AAD_DOMAIN, descriptor),
      tagLength: 128,
    }, kek, bytes)
    await bucket.put(objectKey, ciphertext, { customMetadata: metadataFrom(signed) })
    return signed
  } catch (error) {
    if (error?.message === 'WORKBOOK_ARTIFACT_INVALID') throw error
    artifactInvalid()
  }
}

export async function readWorkbookArtifact({ bucket, keyring, config, centreId, descriptor }) {
  try {
    if (config?.appEnv !== 'staging' || centreId !== descriptor?.centreId
      || descriptor?.environment !== config.appEnv || !validArtifactFacts(descriptor)
      || typeof descriptor.metadataSignature !== 'string'
      || !SIGNATURE.test(descriptor.metadataSignature)
      || typeof bucket?.get !== 'function') artifactInvalid()
    const hmac = typeof keyring?.getWorkbookHmac === 'function'
      ? keyring.getWorkbookHmac(descriptor.metadataHmacVersion)
      : null
    const kek = typeof keyring?.getWorkbookKek === 'function'
      ? keyring.getWorkbookKek(descriptor.workbookKekVersion)
      : null
    if (!hmac || !kek) artifactInvalid()
    const signature = decodeBase64Url(descriptor.metadataSignature)
    if (!await crypto.subtle.verify(
      'HMAC', hmac, signature, artifactMessage(ARTIFACT_HMAC_DOMAIN, descriptor),
    )) artifactInvalid()
    const stored = await bucket.get(descriptor.objectKey)
    if (!stored || typeof stored.arrayBuffer !== 'function'
      || !sameMetadata(stored.customMetadata, metadataFrom(descriptor))) artifactInvalid()
    const nonce = decodeBase64Url(descriptor.contentNonce)
    if (nonce.byteLength !== 12) artifactInvalid()
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: nonce,
      additionalData: artifactMessage(ARTIFACT_AAD_DOMAIN, descriptor),
      tagLength: 128,
    }, kek, await stored.arrayBuffer()))
    if (plaintext.byteLength !== descriptor.byteSize
      || await digestHex(plaintext) !== descriptor.fingerprint) artifactInvalid()
    return plaintext
  } catch (error) {
    if (error?.message === 'WORKBOOK_ARTIFACT_INVALID') throw error
    artifactInvalid()
  }
}

const previewPayload = ({
  environment,
  centreId,
  actorId,
  fingerprint,
  byteSize,
  parserVersion,
  materializerVersion,
  planDigest,
  issuedAtMs,
  expiresAtMs,
  nonce,
}) => [
  1,
  environment,
  centreId,
  actorId,
  fingerprint,
  byteSize,
  parserVersion,
  materializerVersion,
  planDigest,
  issuedAtMs,
  expiresAtMs,
  nonce,
]

const validPreviewPayload = (payload) => Array.isArray(payload)
  && payload.length === 12
  && payload[0] === 1
  && payload[1] === 'staging'
  && typeof payload[2] === 'string' && CENTRE_ID.test(payload[2])
  && typeof payload[3] === 'string' && STAFF_ID.test(payload[3])
  && typeof payload[4] === 'string' && FINGERPRINT.test(payload[4])
  && positiveInteger(payload[5]) && payload[5] <= MAX_WORKBOOK_BYTES
  && positiveInteger(payload[6])
  && positiveInteger(payload[7])
  && typeof payload[8] === 'string' && VERSIONED_DIGEST.test(payload[8])
  && exactInstantMs(payload[9])
  && exactInstantMs(payload[10]) && payload[10] > payload[9]
  && payload[10] - payload[9] <= 5 * 60 * 1000
  && typeof payload[11] === 'string'
  && /^[A-Za-z0-9_-]{22}$/.test(payload[11])

export async function createWorkbookPreviewToken({
  keyring,
  config,
  centreId,
  actorId,
  fingerprint,
  byteSize,
  parserVersion,
  materializerVersion,
  planDigest,
  issuedAtMs,
  expiresAtMs,
  nonceFactory = () => randomBytes(16),
}) {
  try {
    if (config?.appEnv !== 'staging' || typeof nonceFactory !== 'function') tokenInvalid()
    const { hmac, hmacVersion } = activeWorkbookKeys(keyring, config, tokenInvalid)
    const nonceBytes = exactBytes(nonceFactory())
    if (!nonceBytes || nonceBytes.byteLength !== 16) tokenInvalid()
    const payload = previewPayload({
      environment: config.appEnv,
      centreId,
      actorId,
      fingerprint,
      byteSize,
      parserVersion,
      materializerVersion,
      planDigest,
      issuedAtMs,
      expiresAtMs,
      nonce: encodeBase64Url(nonceBytes),
    })
    if (!validPreviewPayload(payload)) tokenInvalid()
    const encoded = encodeBase64Url(utf8.encode(JSON.stringify(payload)))
    const signature = encodeBase64Url(await crypto.subtle.sign(
      'HMAC', hmac, utf8.encode(`${PREVIEW_HMAC_DOMAIN}\n${encoded}`),
    ))
    return `v1.${hmacVersion}.${encoded}.${signature}`
  } catch (error) {
    if (error?.message === 'WORKBOOK_PREVIEW_TOKEN_INVALID') throw error
    tokenInvalid()
  }
}

const authenticateWorkbookPreviewToken = async ({ token, keyring, config, nowMs }) => {
  try {
    if (config?.appEnv !== 'staging' || typeof token !== 'string'
      || !exactInstantMs(nowMs)) tokenInvalid()
    const match = TOKEN.exec(token)
    if (!match || !Number.isSafeInteger(Number(match[1]))) tokenInvalid()
    const hmacVersion = Number(match[1])
    const hmac = typeof keyring?.getWorkbookHmac === 'function'
      ? keyring.getWorkbookHmac(hmacVersion)
      : null
    if (!hmac || !await crypto.subtle.verify(
      'HMAC',
      hmac,
      decodeBase64Url(match[3]),
      utf8.encode(`${PREVIEW_HMAC_DOMAIN}\n${match[2]}`),
    )) tokenInvalid()
    const payloadText = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(match[2]))
    const payload = JSON.parse(payloadText)
    if (!validPreviewPayload(payload) || JSON.stringify(payload) !== payloadText
      || payload[1] !== config.appEnv
      || nowMs < payload[9] || nowMs > payload[10]) tokenInvalid()
    return Object.freeze({
      centreId: payload[2],
      actorId: payload[3],
      fingerprint: payload[4],
      byteSize: payload[5],
      parserVersion: payload[6],
      materializerVersion: payload[7],
      planDigest: payload[8],
      issuedAtMs: payload[9],
      expiresAtMs: payload[10],
    })
  } catch (error) {
    if (error?.message === 'WORKBOOK_PREVIEW_TOKEN_INVALID') throw error
    tokenInvalid()
  }
}

export async function verifyWorkbookPreviewTokenContext({
  token, keyring, config, expected, nowMs,
}) {
  try {
    if (!expected || typeof expected !== 'object') tokenInvalid()
    const verified = await authenticateWorkbookPreviewToken({
      token, keyring, config, nowMs,
    })
    if (verified.centreId !== expected.centreId
      || verified.actorId !== expected.actorId
      || verified.fingerprint !== expected.fingerprint
      || verified.byteSize !== expected.byteSize
      || verified.parserVersion !== expected.parserVersion
      || verified.materializerVersion !== expected.materializerVersion) tokenInvalid()
    return verified
  } catch (error) {
    if (error?.message === 'WORKBOOK_PREVIEW_TOKEN_INVALID') throw error
    tokenInvalid()
  }
}

export async function verifyWorkbookPreviewToken(input) {
  try {
    const verified = await verifyWorkbookPreviewTokenContext(input)
    if (verified.planDigest !== input.expected.planDigest) tokenInvalid()
    return verified
  } catch (error) {
    if (error?.message === 'WORKBOOK_PREVIEW_TOKEN_INVALID') throw error
    tokenInvalid()
  }
}

export function createWorkbookPanelMetadataCallbacks({ keyring, config, centreId }) {
  if (config?.appEnv !== 'staging' || typeof centreId !== 'string' || !CENTRE_ID.test(centreId)) {
    panelInvalid()
  }
  const prefix = `${PANEL_HMAC_DOMAIN}\n${config.appEnv}\n${centreId}\n`
  return Object.freeze({
    async digestField({ rowType, rowId, field, value, hmacVersion } = {}) {
      if (typeof rowType !== 'string' || !SAFE_KEY.test(rowType)
        || typeof rowId !== 'string' || !SAFE_ID.test(rowId)
        || typeof field !== 'string' || !SAFE_KEY.test(field)) panelInvalid()
      const result = await provenanceHmac({
        keyring,
        config,
        centreId,
        domain: PANEL_FIELD_HMAC_DOMAIN,
        facts: [rowType, rowId, field],
        value,
        hmacVersion,
      })
      return `v${result.hmacVersion}_${result.digest}`
    },
    async sign(source) {
      try {
        const bytes = exactBytes(source)
        const { hmac, hmacVersion } = activeWorkbookKeys(keyring, config, panelInvalid)
        if (!bytes) panelInvalid()
        const message = new Uint8Array(utf8.encode(prefix).byteLength + bytes.byteLength)
        message.set(utf8.encode(prefix), 0)
        message.set(bytes, utf8.encode(prefix).byteLength)
        const signature = encodeBase64Url(await crypto.subtle.sign('HMAC', hmac, message))
        return `v${hmacVersion}.${signature}`
      } catch (error) {
        if (error?.message === 'WORKBOOK_PANEL_SIGNATURE_INVALID') throw error
        panelInvalid()
      }
    },
    async verify(source, signed) {
      try {
        const bytes = exactBytes(source)
        const match = typeof signed === 'string' ? /^v([1-9]\d*)\.([A-Za-z0-9_-]{43})$/.exec(signed) : null
        const version = match ? Number(match[1]) : null
        const hmac = positiveInteger(version) && typeof keyring?.getWorkbookHmac === 'function'
          ? keyring.getWorkbookHmac(version)
          : null
        if (!bytes || !hmac) return false
        const prefixBytes = utf8.encode(prefix)
        const message = new Uint8Array(prefixBytes.byteLength + bytes.byteLength)
        message.set(prefixBytes, 0)
        message.set(bytes, prefixBytes.byteLength)
        return crypto.subtle.verify('HMAC', hmac, decodeBase64Url(match[2]), message)
      } catch {
        return false
      }
    },
  })
}
