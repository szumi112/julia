const META_FORMAT = 'Panel-v2'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/
const SAFE_DIGEST = /^[A-Za-z0-9_-]{16,512}$/
const SAFE_SIGNATURE = /^[A-Za-z0-9._~+/=-]{1,4096}$/

const fail = (code) => { throw new TypeError(code) }

const exactKeys = (value, keys) => {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

const normalizeScope = (scope) => {
  if (!exactKeys(scope, ['id', 'type'])
    || !['centre', 'specialist'].includes(scope.type)
    || typeof scope.id !== 'string' || !SAFE_ID.test(scope.id)) {
    fail('PANEL_META_SCHEMA_INVALID')
  }
  return { id: scope.id, type: scope.type }
}

const normalizeRow = (row) => {
  if (!exactKeys(row, ['baseVersion', 'fieldDigests', 'id', 'type'])
    || typeof row.id !== 'string' || !SAFE_ID.test(row.id)
    || typeof row.type !== 'string' || !SAFE_KEY.test(row.type)
    || !Number.isSafeInteger(row.baseVersion) || row.baseVersion < 0
    || !row.fieldDigests || Array.isArray(row.fieldDigests)
    || typeof row.fieldDigests !== 'object') fail('PANEL_META_SCHEMA_INVALID')
  const fieldDigests = {}
  for (const key of Object.keys(row.fieldDigests).sort()) {
    const digest = row.fieldDigests[key]
    if (!SAFE_KEY.test(key) || typeof digest !== 'string' || !SAFE_DIGEST.test(digest)) {
      fail('PANEL_META_SCHEMA_INVALID')
    }
    fieldDigests[key] = digest
  }
  if (!Object.keys(fieldDigests).length) fail('PANEL_META_SCHEMA_INVALID')
  return {
    baseVersion: row.baseVersion,
    fieldDigests,
    id: row.id,
    type: row.type,
  }
}

const normalizedMetadata = (metadata) => {
  if (!exactKeys(metadata, ['format', 'rows', 'scope', 'voidIds'])
    || metadata.format !== META_FORMAT || !Array.isArray(metadata.rows)
    || !Array.isArray(metadata.voidIds)) fail('PANEL_META_SCHEMA_INVALID')
  const rows = metadata.rows.map(normalizeRow).sort((left, right) => (
    left.id.localeCompare(right.id) || left.type.localeCompare(right.type)
  ))
  const ids = new Set()
  for (const row of rows) {
    if (ids.has(row.id)) fail('PANEL_META_SCHEMA_INVALID')
    ids.add(row.id)
  }
  const voidIds = [...metadata.voidIds].sort()
  if (new Set(voidIds).size !== voidIds.length
    || voidIds.some((id) => typeof id !== 'string' || !ids.has(id))) {
    fail('PANEL_META_SCHEMA_INVALID')
  }
  return {
    format: META_FORMAT,
    rows,
    scope: normalizeScope(metadata.scope),
    voidIds,
  }
}

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    const result = {}
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key])
    return result
  }
  return typeof value === 'string' ? value.normalize('NFC') : value
}

export const canonicalPanelMetadata = (metadata) => new TextEncoder().encode(
  JSON.stringify(canonicalValue(normalizedMetadata(metadata))),
)

export const signPanelMetadata = async (metadata, sign) => {
  if (typeof sign !== 'function') fail('PANEL_META_SIGNER_REQUIRED')
  const payloadBytes = canonicalPanelMetadata(metadata)
  const signature = await sign(new Uint8Array(payloadBytes))
  if (typeof signature !== 'string' || !SAFE_SIGNATURE.test(signature)) {
    fail('PANEL_META_SIGNATURE_INVALID')
  }
  return {
    payload: new TextDecoder().decode(payloadBytes),
    signature,
  }
}

export const panelMetadataFromPayload = (payload) => {
  if (typeof payload !== 'string' || payload.length > 1024 * 1024) {
    fail('PANEL_META_PAYLOAD_INVALID')
  }
  let parsed
  try { parsed = JSON.parse(payload) } catch { fail('PANEL_META_PAYLOAD_INVALID') }
  const canonicalBytes = canonicalPanelMetadata(parsed)
  const canonicalPayload = new TextDecoder().decode(canonicalBytes)
  if (canonicalPayload !== payload.normalize('NFC')) fail('PANEL_META_CANONICAL_INVALID')
  return { metadata: normalizedMetadata(parsed), payloadBytes: canonicalBytes }
}

export const verifyPanelMetadata = async ({ payload, signature }, verify) => {
  if (typeof verify !== 'function') fail('PANEL_META_VERIFIER_REQUIRED')
  if (typeof signature !== 'string' || !SAFE_SIGNATURE.test(signature)) {
    fail('PANEL_META_SIGNATURE_INVALID')
  }
  const parsed = panelMetadataFromPayload(payload)
  const valid = await verify(new Uint8Array(parsed.payloadBytes), signature)
  if (valid !== true) fail('PANEL_META_SIGNATURE_INVALID')
  return parsed.metadata
}
