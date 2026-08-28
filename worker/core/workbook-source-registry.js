import { decryptForScope, loadDataKey } from '../security/envelope.js'
import {
  digestWorkbookSourcePayload,
  digestWorkbookSourceValue,
} from '../security/workbook-artifacts.js'

export const WORKBOOK_SOURCE_SCOPE = Object.freeze({
  type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
})

const fail = () => { throw new Error('CRYPTO_FAILURE') }
const parsedEnvelope = (value) => {
  if (typeof value !== 'string') fail()
  try { return JSON.parse(value) } catch { fail() }
}

export const loadWorkbookSourceDataKey = (db, envelope) => loadDataKey(db, {
  envelope: parsedEnvelope(envelope), expectedScope: WORKBOOK_SOURCE_SCOPE,
})

export async function openAuthenticatedWorkbookSource({
  keyring, dataKey, row, config, centreId = 'centre_1',
} = {}) {
  if (!keyring || !dataKey || !row || typeof row !== 'object'
    || centreId !== WORKBOOK_SOURCE_SCOPE.id) fail()
  let payload
  try {
    payload = JSON.parse(await decryptForScope(keyring, dataKey, {
      expectedScope: WORKBOOK_SOURCE_SCOPE,
      recordId: row.source_record_id,
      field: 'source_payload',
      envelope: parsedEnvelope(row.source_payload_envelope),
    }))
  } catch { fail() }
  if (!payload || payload.schema !== 'workbook_source_payload.v1'
    || !payload.normalized || Array.isArray(payload.normalized)
    || typeof payload.normalized !== 'object' || !payload.raw || Array.isArray(payload.raw)
    || typeof payload.raw !== 'object') fail()
  const provenance = await digestWorkbookSourcePayload({
    keyring, config, centreId, sourceKey: row.source_key, payload,
    hmacVersion: row.record_digest_hmac_version,
  })
  if (provenance.digest !== row.record_digest
    || payload.normalized.sourceKey !== row.source_key
    || payload.normalized.sheet !== row.sheet_name
    || payload.normalized.rowNumber !== row.row_number
    || payload.normalized.recordType !== row.record_type
    || payload.normalized.occurredOn !== row.occurred_on
    || payload.normalized.periodPrecision !== row.period_precision
    || payload.normalized.periodMonth !== row.period_month) fail()
  return Object.freeze(payload)
}

export async function loadAuthenticatedWorkbookSpecialistMappings({
  db, keyring, dataKey, importId, config, centreId = 'centre_1',
} = {}) {
  if (!db?.prepare || !keyring || !dataKey || typeof importId !== 'string'
    || !/^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(importId)
    || centreId !== WORKBOOK_SOURCE_SCOPE.id) fail()
  const rows = (await db.prepare(
    `SELECT id,source_value_kind,source_value_digest,source_value_hmac_version,
            source_value_envelope,specialist_id
     FROM workbook_resolutions
     WHERE import_id=? AND kind='specialist_mapping' ORDER BY id
     LIMIT ?`,
  ).bind(importId, 101).all()).results
  if (!Array.isArray(rows) || rows.length > 100) fail()
  const bySourceValue = new Map()
  const byDigest = new Map()
  for (const row of rows) {
    let value
    try {
      value = JSON.parse(await decryptForScope(keyring, dataKey, {
        expectedScope: WORKBOOK_SOURCE_SCOPE,
        recordId: row.id,
        field: 'source_value',
        envelope: parsedEnvelope(row.source_value_envelope),
      }))
    } catch { fail() }
    if (!value || value.schema !== 'workbook_specialist_source.v1'
      || typeof value.sourceValue !== 'string') fail()
    const provenance = await digestWorkbookSourceValue({
      keyring, config, centreId,
      sourceValueKind: row.source_value_kind,
      sourceValue: value.sourceValue,
      hmacVersion: row.source_value_hmac_version,
    })
    const digestKey = `${row.source_value_hmac_version}:${row.source_value_digest}`
    if (provenance.digest !== row.source_value_digest
      || bySourceValue.has(value.sourceValue) || byDigest.has(digestKey)
      || typeof row.specialist_id !== 'string'
      || !/^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(row.specialist_id)) fail()
    const mapping = Object.freeze({
      sourceValue: value.sourceValue,
      sourceValueKind: row.source_value_kind,
      digest: row.source_value_digest,
      hmacVersion: row.source_value_hmac_version,
      specialistId: row.specialist_id,
    })
    bySourceValue.set(value.sourceValue, mapping)
    byDigest.set(digestKey, mapping)
  }
  return Object.freeze({ bySourceValue, byDigest })
}

export async function resolveAuthenticatedWorkbookSpecialist({
  keyring, config, centreId = 'centre_1', mappings, row, payload,
} = {}) {
  try {
    const sourceValue = ['english', 'tus'].includes(payload?.normalized?.recordType)
      ? '' : payload?.normalized?.specialistName ?? ''
    const sourceValueKind = sourceValue === '' ? 'blank' : 'explicit_name'
    if (!mappings?.byDigest?.get || !mappings?.bySourceValue?.get
      || !row || typeof row.specialist_source_digest !== 'string'
      || !Number.isSafeInteger(row.specialist_source_hmac_version)
      || row.specialist_source_hmac_version < 1) fail()
    const provenance = await digestWorkbookSourceValue({
      keyring, config, centreId, sourceValueKind, sourceValue,
      hmacVersion: row.specialist_source_hmac_version,
    })
    if (provenance.digest !== row.specialist_source_digest) fail()
    const mapping = mappings.byDigest.get(
      `${row.specialist_source_hmac_version}:${row.specialist_source_digest}`,
    )
    if (!mapping || mapping !== mappings.bySourceValue.get(sourceValue)
      || mapping.sourceValue !== sourceValue || mapping.sourceValueKind !== sourceValueKind) fail()
    return mapping.specialistId
  } catch { fail() }
}
