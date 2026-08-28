import { parseWorkbookFile } from '../../src/workbook-import.js'
import {
  createScopedPanelWorkbook,
  mergePanelEdits,
  patchPanelWorkbook,
  readPanelWorkbook,
} from '../../src/workbook-ooxml.js'
export { continueWorkbookMaterialization as continueWorkbookImport } from './workbook-materialization.js'
import {
  createWorkbookPanelMetadataCallbacks,
  createWorkbookPreviewToken,
  digestWorkbookPreviewPlan,
  digestWorkbookSourcePayload,
  digestWorkbookSourceValue,
  readWorkbookArtifact,
  storeWorkbookArtifact,
  verifyWorkbookPreviewToken,
} from '../security/workbook-artifacts.js'
import { auditEventStatement } from '../audit/events.js'
import {
  encryptForScope,
  getOrCreateDataKey,
  decryptForScope,
  loadDataKey,
} from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'
import { compareUtf16CodeUnits } from '../../src/code-unit-order.js'
import {
  invalidPanelFinanceField,
  normalizePanelFinanceEdits,
  prospectivePanelFinanceValues,
} from './workbook-panel-finance.js'
import { authorize } from '../identity/policy.js'
import { captureAuthorityActor } from '../identity/authority-actor.js'
import { resolveCurrentAuthorityActor } from '../identity/staff.js'
import {
  loadWorkbookSpecialistLabels,
  loadWorkbookSpecialistOptions,
} from './workbook-specialist-options.js'
import { parseWorkbookMaterializationProgress } from './workbook-materialization-progress.js'

export const APPROVED_WORKBOOK_FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'

const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024
const MAX_WORKBOOK_EXPORT_BYTES = 10 * 1024 * 1024
const MAX_WORKBOOK_EXPORT_ROWS = 5_000
const CENTRE_ID = /^centre_[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ARTIFACT_ID = /^wba_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SOURCE_KEY = /^workbook:v1:(\d{1,4}):(\d{1,7}):(\d{1,5})$/
const SOURCE_SCOPE = Object.freeze({
  type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
})
const CENTRE_RESOURCE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const IDENTITY_SCOPE = Object.freeze({
  type: 'staff_directory', id: 'centre_1', purpose: 'identity',
})
const OPTIONAL_PREVIEW_KEYS = Object.freeze([
  'db', 'loadPanelState', 'nonceFactory', 'parse', 'readPanel',
])
const REQUIRED_PREVIEW_KEYS = Object.freeze([
  'bytes', 'filename', 'actor', 'keyring', 'config', 'centreId', 'nowMs',
])
const PROFILE_MAPPINGS = Object.freeze({
  '': Object.freeze({
    displayName: 'Julia Wolanin',
    resolutionCode: 'blank_assigned_to_julia',
    sourceValue: '',
    sourceValueKind: 'blank',
    specialistId: 'sp_staging_workbook_julia_wolanin',
  }),
  'Anna Janowska': Object.freeze({
    displayName: 'Anna Janowska',
    resolutionCode: 'explicit_match',
    sourceValue: 'Anna Janowska',
    sourceValueKind: 'explicit_name',
    specialistId: 'sp_staging_workbook_anna_janowska',
  }),
  'Justyna J-J': Object.freeze({
    displayName: 'Justyna J-J',
    resolutionCode: 'explicit_match',
    sourceValue: 'Justyna J-J',
    sourceValueKind: 'explicit_name',
    specialistId: 'sp_staging_workbook_justyna_j_j',
  }),
})

const PANEL_FINANCE_FIELDS = Object.freeze({
  accountingMonth: Object.freeze({ type: 'text' }),
  occurredOn: Object.freeze({ type: 'date' }),
  amountGrosze: Object.freeze({ type: 'cents' }),
  paidAmountGrosze: Object.freeze({ type: 'cents' }),
  paymentMethod: Object.freeze({
    type: 'enum', values: Object.freeze(['blik', 'card', 'cash', 'monthly', 'other', 'transfer', 'unknown']),
  }),
  settlementStatus: Object.freeze({
    type: 'enum', values: Object.freeze(['paid', 'partial', 'unknown', 'unpaid']),
  }),
  invoiceStatus: Object.freeze({
    type: 'enum', values: Object.freeze(['action_required', 'issued', 'not_issued', 'not_required', 'unknown']),
  }),
  specialistId: Object.freeze({ type: 'text' }),
})
const PANEL_FINANCE_COLUMNS = Object.freeze([
  Object.freeze({ key: 'accountingMonth', label: 'Miesiąc księgowy', type: 'text', width: 16 }),
  Object.freeze({ key: 'occurredOn', label: 'Data', type: 'date', width: 14 }),
  Object.freeze({ key: 'amountGrosze', label: 'Kwota (gr)', type: 'cents', width: 16 }),
  Object.freeze({ key: 'paidAmountGrosze', label: 'Zapłacono (gr)', type: 'cents', width: 18 }),
  Object.freeze({ key: 'paymentMethod', label: 'Sposób płatności', type: 'enum', values: PANEL_FINANCE_FIELDS.paymentMethod.values, width: 18 }),
  Object.freeze({ key: 'settlementStatus', label: 'Rozliczenie', type: 'enum', values: PANEL_FINANCE_FIELDS.settlementStatus.values, width: 16 }),
  Object.freeze({ key: 'invoiceStatus', label: 'Faktura', type: 'enum', values: PANEL_FINANCE_FIELDS.invoiceStatus.values, width: 18 }),
  Object.freeze({ key: 'specialistId', label: 'ID specjalisty', type: 'text', width: 28 }),
])
const WARSAW_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
})

export async function loadWorkbookPanelState({
  db, keyring, centreId, rows, specialistIds = [],
} = {}) {
  if (!db?.prepare || !keyring || centreId !== 'centre_1' || !Array.isArray(rows)
    || rows.length > 2_500 || rows.some((row) => (
      !row || row.type !== 'finance_entry' || typeof row.id !== 'string'
      || !/^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(row.id)
    )) || !Array.isArray(specialistIds) || specialistIds.length > 2_500
    || new Set(specialistIds).size !== specialistIds.length
    || specialistIds.some((id) => (
      typeof id !== 'string' || !/^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(id)
    ))) previewInvalid()
  const loaded = []
  for (let offset = 0; offset < rows.length; offset += 100) {
    const ids = rows.slice(offset, offset + 100).map(({ id }) => id)
    const result = (await db.prepare(
      `SELECT entry.id,entry.kind,entry.record_type,entry.accounting_month,
              entry.occurred_on,entry.amount_grosze,
              entry.paid_amount_grosze,entry.payment_method,entry.settlement_status,
              entry.invoice_status,entry.specialist_id,entry.version,
              CASE WHEN EXISTS (
                SELECT 1 FROM activity_charges AS charge
                WHERE charge.finance_entry_id=entry.id AND charge.status='active'
              ) OR EXISTS (
                SELECT 1 FROM finance_source_links AS source_link
                JOIN historical_service_occurrences AS occurrence
                  ON occurrence.source_record_id=source_link.source_record_id
                 AND occurrence.status='recorded'
                WHERE source_link.finance_entry_id=entry.id
              ) THEN 1 ELSE 0 END AS mutation_blocked
       FROM finance_entries AS entry
       JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
       WHERE entry.id IN (${ids.map(() => '?').join(',')})
         AND batch.status='committed'
         AND NOT EXISTS (SELECT 1 FROM finance_entry_voids AS void
           WHERE void.finance_entry_id=entry.id)
         AND NOT EXISTS (SELECT 1 FROM finance_manual_voids AS manual_void
           WHERE manual_void.finance_entry_id=entry.id)
       ORDER BY entry.id`,
    ).bind(...ids).all()).results
    if (!Array.isArray(result)) previewInvalid()
    loaded.push(...result)
  }
  let foundSpecialists = []
  if (specialistIds.length) {
    foundSpecialists = (await db.prepare(
      `SELECT specialist.id FROM json_each(?) AS requested
       JOIN specialists AS specialist
         ON specialist.id=requested.value AND specialist.status='active'
       ORDER BY specialist.id`,
    ).bind(JSON.stringify(specialistIds)).all()).results
    if (!Array.isArray(foundSpecialists)) previewInvalid()
  }
  const knownSpecialistIds = foundSpecialists.map(({ id }) => id)
    .sort(compareUtf16CodeUnits)
  return Object.freeze({
    fieldsByType: Object.freeze({ finance_entry: PANEL_FINANCE_FIELDS }),
    specialistIds: Object.freeze(knownSpecialistIds),
    rows: Object.freeze(loaded.map((row) => Object.freeze({
      id: row.id,
      kind: row.kind,
      recordType: row.record_type,
      type: 'finance_entry',
      version: row.version,
      mutationBlocked: row.mutation_blocked === 1,
      values: Object.freeze({
        accountingMonth: row.accounting_month,
        occurredOn: row.occurred_on,
        amountGrosze: row.amount_grosze,
        paidAmountGrosze: row.paid_amount_grosze,
        paymentMethod: row.payment_method,
        settlementStatus: row.settlement_status,
        invoiceStatus: row.invoice_status,
        specialistId: row.specialist_id,
      }),
    }))),
  })
}

const workbookArtifactDescriptor = (row) => Object.freeze({
  environment: row.environment,
  centreId: row.centre_id,
  objectKey: row.object_key,
  fingerprint: row.fingerprint,
  byteSize: row.byte_size,
  parserVersion: row.parser_version,
  materializerVersion: row.materializer_version,
  contentNonce: row.content_nonce_b64,
  workbookKekVersion: row.workbook_kek_version,
  metadataHmacVersion: row.metadata_hmac_version,
  metadataSignature: row.metadata_signature,
})

const latestExportCte = `WITH export_guard AS (
  SELECT EXISTS (
    SELECT 1 FROM workbook_imports AS pending_import
    LEFT JOIN workbook_materialization_jobs AS pending_job
      ON pending_job.import_id=pending_import.id
    LEFT JOIN workbook_import_plans AS pending_plan
      ON pending_plan.import_id=pending_import.id
    WHERE (pending_import.status NOT IN ('complete','failed')
        OR (pending_job.id IS NOT NULL AND pending_job.status NOT IN ('complete','failed')))
      AND (pending_plan.import_id IS NULL OR pending_plan.workbook_kind='legacy'
        OR pending_job.total_records>pending_job.processed_records)
  ) AS nonterminal
), latest_export AS (
  SELECT artifact.centre_id,artifact.environment,artifact.fingerprint,
         artifact.byte_size,artifact.parser_version,artifact.materializer_version,
         artifact.object_key,artifact.content_nonce_b64,artifact.workbook_kek_version,
         artifact.metadata_hmac_version,artifact.metadata_signature,
         import.id AS import_id
  FROM workbook_imports AS import
  JOIN workbook_materialization_jobs AS job ON job.import_id=import.id
  JOIN workbook_templates AS template ON template.artifact_id=import.artifact_id
  JOIN workbook_artifacts AS artifact ON artifact.id=template.artifact_id
  WHERE import.status='complete' AND job.status='complete' AND artifact.centre_id=?
    AND (?='panel-v2' OR template.format='legacy')
    AND (SELECT nonterminal FROM export_guard)=0
  ORDER BY import.completed_at DESC,import.id DESC LIMIT 1
)`

const artifactExportStatement = (db, centreId, format) => db.prepare(
  `${latestExportCte}
   SELECT latest_export.*,export_guard.nonterminal
   FROM export_guard LEFT JOIN latest_export ON 1=1`,
).bind(centreId, format)

const activeFinanceRowsExportStatement = (db, centreId, format) => db.prepare(
  `${latestExportCte}
   SELECT entry.id,entry.accounting_month,entry.occurred_on,entry.amount_grosze,
            entry.paid_amount_grosze,entry.payment_method,entry.settlement_status,
            entry.invoice_status,entry.specialist_id,entry.version
     FROM finance_entries AS entry
     JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
     JOIN latest_export ON 1=1
     WHERE batch.status='committed'
       AND NOT EXISTS (SELECT 1 FROM finance_entry_voids AS void
         WHERE void.finance_entry_id=entry.id)
       AND NOT EXISTS (SELECT 1 FROM finance_manual_voids AS manual_void
         WHERE manual_void.finance_entry_id=entry.id)
     ORDER BY entry.id LIMIT 5001`,
).bind(centreId, format)

const ownFinanceRowsExportStatement = (db, centreId, format, specialistId) => db.prepare(
  `${latestExportCte}
   SELECT entry.id,entry.accounting_month,entry.occurred_on,entry.amount_grosze,
            entry.paid_amount_grosze,entry.payment_method,entry.settlement_status,
            entry.invoice_status,entry.specialist_id,entry.version
     FROM finance_entries AS entry
     JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
     JOIN latest_export ON 1=1
     WHERE batch.status='committed'
       AND entry.specialist_id=?
       AND NOT EXISTS (SELECT 1 FROM finance_entry_voids AS void
         WHERE void.finance_entry_id=entry.id)
       AND NOT EXISTS (SELECT 1 FROM finance_manual_voids AS manual_void
         WHERE manual_void.finance_entry_id=entry.id)
     ORDER BY entry.id LIMIT 5001`,
).bind(centreId, format, specialistId)

const panelValues = (row) => Object.freeze({
  accountingMonth: row.accounting_month,
  occurredOn: row.occurred_on,
  amountGrosze: row.amount_grosze,
  paidAmountGrosze: row.paid_amount_grosze,
  paymentMethod: row.payment_method,
  settlementStatus: row.settlement_status,
  invoiceStatus: row.invoice_status,
  specialistId: row.specialist_id,
})

const panelExportDocument = async ({ rows, callbacks, scope }) => {
  const sheetRows = rows.map((row) => Object.freeze({ id: row.id, values: panelValues(row) }))
  const metadataRows = []
  for (let offset = 0; offset < rows.length; offset += 64) {
    const page = rows.slice(offset, offset + 64)
    metadataRows.push(...await Promise.all(page.map(async (row) => {
      const values = panelValues(row)
      const digests = await Promise.all(PANEL_FINANCE_COLUMNS.map(async ({ key }) => [
        key,
        await callbacks.digestField({
          rowType: 'finance_entry', rowId: row.id, field: key, value: values[key],
        }),
      ]))
      return Object.freeze({
        id: row.id,
        type: 'finance_entry',
        baseVersion: row.version,
        fieldDigests: Object.freeze(Object.fromEntries(digests)),
      })
    })))
  }
  return Object.freeze({
    metadata: Object.freeze({
      format: 'Panel-v2',
      scope,
      rows: Object.freeze(metadataRows),
      voidIds: Object.freeze([]),
    }),
    sheets: Object.freeze([Object.freeze({
      name: 'Panel — Wizyty', columns: PANEL_FINANCE_COLUMNS, rows: sheetRows,
    })]),
  })
}

const panelExportFor = async ({ source, rows, callbacks, centreId }) => {
  const document = await panelExportDocument({
    rows,
    callbacks,
    scope: Object.freeze({ id: centreId, type: 'centre' }),
  })
  return patchPanelWorkbook(source, {
    includePermissions: false,
    metadata: document.metadata,
    sheets: document.sheets,
  }, { sign: callbacks.sign })
}

const specialistPanelExportFor = async ({ rows, callbacks, specialistId }) => {
  const document = await panelExportDocument({
    rows,
    callbacks,
    scope: Object.freeze({ id: specialistId, type: 'specialist' }),
  })
  return createScopedPanelWorkbook({
    allowedRowIds: rows.map(({ id }) => id),
    allowedSheets: [{ name: 'Panel — Wizyty', columns: PANEL_FINANCE_COLUMNS }],
    metadata: document.metadata,
    sheets: document.sheets,
  }, { sign: callbacks.sign })
}

const parseExportEnvelope = (value) => {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error()
    return parsed
  } catch { throw new Error('CRYPTO_FAILURE') }
}

const specialistNamesForExport = async ({ db, keyring, ids }) => {
  const unique = [...new Set(ids)]
  if (!unique.length) return new Map()
  if (unique.length > 100 || unique.some((id) => !/^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(id))) {
    throw new Error('INTERNAL_ERROR')
  }
  const rows = (await db.prepare(
    `SELECT id,display_name_envelope FROM specialists
     WHERE id IN (${unique.map(() => '?').join(',')}) ORDER BY id`,
  ).bind(...unique).all()).results
  if (!Array.isArray(rows) || rows.length !== unique.length) throw new Error('INTERNAL_ERROR')
  const dataKeys = new Map()
  const result = new Map()
  for (const row of rows) {
    const envelope = parseExportEnvelope(row.display_name_envelope)
    const cacheKey = `${envelope.dataKeyId}\n${envelope.dataKeyVersion}`
    let dataKey = dataKeys.get(cacheKey)
    if (!dataKey) {
      dataKey = await loadDataKey(db, { envelope, expectedScope: IDENTITY_SCOPE })
      dataKeys.set(cacheKey, dataKey)
    }
    let displayName
    try {
      displayName = await decryptForScope(keyring, dataKey, {
        expectedScope: IDENTITY_SCOPE,
        recordId: row.id,
        field: 'display_name',
        envelope,
      })
    } catch { throw new Error('CRYPTO_FAILURE') }
    if (typeof displayName !== 'string' || !displayName
      || displayName !== displayName.trim().normalize('NFC')
      || new TextEncoder().encode(displayName).byteLength > 120) {
      throw new Error('CRYPTO_FAILURE')
    }
    result.set(row.id, displayName)
  }
  return result
}

const legacySourceRowsExportStatement = (db, centreId, format) => db.prepare(
  `${latestExportCte}
   SELECT source.sheet_index,source.sheet_name,source.row_number,source.block_index,source.record_type,
            source.accounting_month AS source_accounting_month,
            source.occurred_on AS source_occurred_on,
            source.amount_grosze AS source_amount_grosze,
            source.payment_method AS source_payment_method,
            source.settlement_status AS source_settlement_status,
            source.invoice_status AS source_invoice_status,
            source.initial_paid_amount_grosze,
            entry.id AS finance_entry_id,entry.accounting_month,entry.occurred_on,
            entry.amount_grosze,entry.paid_amount_grosze,entry.payment_method,
            entry.settlement_status,entry.invoice_status,entry.specialist_id,
            resolution.source_value_kind,
            resolution.specialist_id AS source_specialist_id
     FROM workbook_source_records AS source
     JOIN latest_export AS latest ON latest.import_id=source.import_id
     JOIN finance_source_links AS link ON link.source_record_id=source.id
     JOIN finance_entries AS entry ON entry.id=link.finance_entry_id
     LEFT JOIN workbook_resolutions AS resolution
       ON resolution.import_id=source.import_id
      AND resolution.kind='specialist_mapping'
      AND resolution.source_value_hmac_version=source.specialist_source_hmac_version
      AND resolution.source_value_digest=source.specialist_source_digest
     WHERE source.disposition='accepted'
       AND NOT EXISTS (SELECT 1 FROM finance_entry_voids AS void
         WHERE void.finance_entry_id=entry.id)
       AND NOT EXISTS (SELECT 1 FROM finance_manual_voids AS manual_void
         WHERE manual_void.finance_entry_id=entry.id)
       AND (entry.accounting_month IS NOT source.accounting_month
         OR entry.occurred_on IS NOT source.occurred_on
         OR entry.amount_grosze IS NOT source.amount_grosze
         OR entry.payment_method IS NOT source.payment_method
         OR entry.settlement_status IS NOT source.settlement_status
         OR entry.invoice_status IS NOT source.invoice_status
         OR entry.paid_amount_grosze IS NOT source.initial_paid_amount_grosze
         OR entry.specialist_id IS NOT resolution.specialist_id
         OR resolution.source_value_kind='blank')
     ORDER BY source.sheet_index,source.row_number,source.block_index LIMIT 5001`,
).bind(centreId, format)

const unlinkedFinanceRowsExportStatement = (db, centreId, format) => db.prepare(
  `${latestExportCte}
   SELECT entry.id AS finance_entry_id,entry.accounting_month,entry.occurred_on,
            entry.amount_grosze,entry.paid_amount_grosze,entry.payment_method,
            entry.settlement_status,entry.invoice_status,entry.specialist_id
     FROM finance_entries AS entry
     JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
     JOIN latest_export ON 1=1
     WHERE batch.status='committed'
       AND NOT EXISTS (SELECT 1 FROM finance_entry_voids AS void
         WHERE void.finance_entry_id=entry.id)
       AND NOT EXISTS (SELECT 1 FROM finance_manual_voids AS manual_void
         WHERE manual_void.finance_entry_id=entry.id)
       AND NOT EXISTS (SELECT 1 FROM finance_source_links AS link
         WHERE link.finance_entry_id=entry.id)
     ORDER BY entry.id LIMIT 2501`,
).bind(centreId, format)

const signedVoidRowsExportStatement = (db, centreId, format) => db.prepare(
  `${latestExportCte}
   SELECT combined.finance_entry_id,combined.sheet_index,combined.sheet_name,
          combined.row_number,combined.block_index,combined.record_type,
          combined.void_kind
   FROM (
     SELECT void.finance_entry_id,source.sheet_index,source.sheet_name,source.row_number,
            source.block_index,source.record_type,void.created_at,void.id,
            'panel' AS void_kind
       FROM finance_entry_voids AS void
       JOIN latest_export AS latest ON 1=1
       JOIN workbook_import_plans AS plan
         ON plan.import_id=void.workbook_import_id AND plan.workbook_kind='panel-v2'
       LEFT JOIN finance_source_links AS link ON link.finance_entry_id=void.finance_entry_id
       LEFT JOIN workbook_source_records AS source
         ON source.id=link.source_record_id AND source.import_id=latest.import_id
       WHERE void.reason_code='panel_signed_void'
     UNION ALL
     SELECT manual_void.finance_entry_id,source.sheet_index,source.sheet_name,
            source.row_number,source.block_index,source.record_type,
            manual_void.created_at,manual_void.id,'manual' AS void_kind
       FROM finance_manual_voids AS manual_void
       JOIN latest_export AS latest ON 1=1
       LEFT JOIN finance_source_links AS link
         ON link.finance_entry_id=manual_void.finance_entry_id
       LEFT JOIN workbook_source_records AS source
         ON source.id=link.source_record_id AND source.import_id=latest.import_id
   ) AS combined
   ORDER BY combined.created_at,combined.id LIMIT 5001`,
).bind(centreId, format)

const legacyExportFor = async ({ db, source, keyring, baseRows, unlinkedRows, voidRows }) => {
  const paymentLabels = {
    blik: 'BLIK', card: 'karta', cash: 'gotówka', monthly: 'miesięcznie',
    other: 'inne', transfer: 'przelew', unknown: 'nieznana',
  }
  const settlementLabels = {
    paid: 'opłacona', partial: 'częściowo opłacona', unknown: 'nieznane', unpaid: 'nieopłacona',
  }
  const invoiceLabels = {
    action_required: 'do wystawienia', issued: 'wystawiona', not_issued: 'brak',
    not_required: 'nie wymaga', unknown: 'nieznana',
  }
  const specialistIds = [
    ...baseRows.filter((row) => row.source_value_kind === 'blank'
      || row.specialist_id !== row.source_specialist_id)
      .map(({ specialist_id: id }) => id),
    ...unlinkedRows.map(({ specialist_id: id }) => id),
  ].filter(Boolean)
  const specialistNames = await specialistNamesForExport({ db, keyring, ids: specialistIds })
  const patches = new Map()
  const additions = []
  const patchFor = (row) => {
    const key = `${row.sheet_name}\n${row.row_number}\n${row.block_index}`
    let patch = patches.get(key)
    if (!patch) {
      patch = {
        sheet: row.sheet_name,
        sheetIndex: row.sheet_index,
        rowNumber: row.row_number,
        blockIndex: row.block_index,
        recordType: row.record_type,
        values: {},
      }
      patches.set(key, patch)
    }
    return patch
  }
  for (const row of baseRows) {
    const values = patchFor(row).values
    const nonNativeChanges = []
    if (row.accounting_month !== row.source_accounting_month) {
      if (row.block_index === 0) values.accountingMonth = row.accounting_month
      else nonNativeChanges.push(`miesiąc ${row.accounting_month ?? 'brak'}`)
    }
    if (row.occurred_on !== row.source_occurred_on) {
      if (row.block_index === 0) values.occurredOn = row.occurred_on
      else nonNativeChanges.push(`data ${row.occurred_on ?? 'brak'}`)
    }
    if (row.amount_grosze !== row.source_amount_grosze) values.amountGrosze = row.amount_grosze
    if (!row.source_value_kind || !row.source_specialist_id) throw new Error('INTERNAL_ERROR')
    if ((row.source_value_kind === 'blank'
      || row.specialist_id !== row.source_specialist_id) && row.specialist_id) {
      const displayName = specialistNames.get(row.specialist_id)
      if (!displayName) throw new Error('INTERNAL_ERROR')
      if (row.block_index === 0) values.specialistDisplayName = displayName
      else additions.push({
        action: 'update', field: 'specialistDisplayName', id: row.finance_entry_id,
        value: displayName,
      })
    }
    if (row.payment_method !== row.source_payment_method) {
      if (row.block_index === 0) values.paymentMethod = row.payment_method
      else nonNativeChanges.push(`płatność ${paymentLabels[row.payment_method]}`)
    }
    if (row.settlement_status !== row.source_settlement_status) {
      if (row.block_index === 0) values.settlementStatus = row.settlement_status
      else nonNativeChanges.push(`status ${settlementLabels[row.settlement_status]}`)
    }
    if (row.invoice_status !== row.source_invoice_status) {
      if (row.block_index === 0) values.invoiceStatus = row.invoice_status
      else nonNativeChanges.push(`faktura ${invoiceLabels[row.invoice_status]}`)
    }
    if (row.paid_amount_grosze !== row.initial_paid_amount_grosze) additions.push({
      action: 'update', field: 'paidAmountGrosze', id: row.finance_entry_id,
      value: String(row.paid_amount_grosze),
    })
    if (nonNativeChanges.length) additions.push({
      action: 'update', field: 'record', id: row.finance_entry_id,
      value: `Zmiany rekordu ze źródła: ${nonNativeChanges.join('; ')}`,
    })
  }
  for (const row of unlinkedRows) {
    const displayName = row.specialist_id ? specialistNames.get(row.specialist_id) : null
    if (row.specialist_id && !displayName) throw new Error('INTERNAL_ERROR')
    additions.push({
      action: 'update',
      field: 'record',
      id: row.finance_entry_id,
      value: [
        `miesiąc ${row.accounting_month ?? 'brak'}`,
        `data ${row.occurred_on ?? 'brak'}`,
        `kwota ${(row.amount_grosze / 100).toFixed(2)} zł`,
        `zapłacono ${(row.paid_amount_grosze / 100).toFixed(2)} zł`,
        `płatność ${paymentLabels[row.payment_method]}`,
        `status ${settlementLabels[row.settlement_status]}`,
        `faktura ${invoiceLabels[row.invoice_status]}`,
        `specjalista ${displayName ?? 'brak'}`,
      ].join('; '),
    })
  }
  const legacyVoids = []
  for (const row of voidRows) {
    if (row.sheet_name === null) additions.push({
      action: 'void', field: 'record', id: row.finance_entry_id,
      value: row.void_kind === 'manual'
        ? 'Unieważniono ręcznie w rejestrze finansowym'
        : 'Unieważniono w podpisanym pliku Panel-v2',
    })
    else legacyVoids.push({
      sheet: row.sheet_name,
      sheetIndex: row.sheet_index,
      rowNumber: row.row_number,
      blockIndex: row.block_index,
      recordType: row.record_type,
    })
  }
  const legacyRows = [...patches.values()].filter(({ values }) => Object.keys(values).length)
  if (additions.length > MAX_WORKBOOK_EXPORT_ROWS
    || legacyRows.length > MAX_WORKBOOK_EXPORT_ROWS
    || legacyVoids.length > MAX_WORKBOOK_EXPORT_ROWS) {
    throw new Error('WORKBOOK_EXPORT_LIMIT')
  }
  return patchPanelWorkbook(source, {
    outputMode: 'legacy',
    sheets: [],
    legacyAdditions: additions,
    legacyRows,
    legacyVoids,
  })
}

const snapshotRows = (result, maximum) => {
  const rows = result?.results
  if (!Array.isArray(rows)) throw new Error('INTERNAL_ERROR')
  if (rows.length > maximum) throw new Error('WORKBOOK_EXPORT_LIMIT')
  return rows
}

const workbookExportSnapshot = async (db, centreId, format, specialistId = null) => {
  const dataStatements = format === 'legacy'
    ? [
        artifactExportStatement(db, centreId, format),
        legacySourceRowsExportStatement(db, centreId, format),
        unlinkedFinanceRowsExportStatement(db, centreId, format),
        signedVoidRowsExportStatement(db, centreId, format),
      ]
    : [
        artifactExportStatement(db, centreId, format),
        specialistId === null
          ? activeFinanceRowsExportStatement(db, centreId, format)
          : ownFinanceRowsExportStatement(db, centreId, format, specialistId),
      ]
  const statements = [...dataStatements, db.prepare(
    `SELECT revision FROM finance_reporting_state WHERE authority_key='finance'`,
  )]
  let results
  try { results = await db.batch(statements) } catch { throw new Error('INTERNAL_ERROR') }
  if (!Array.isArray(results) || results.length !== statements.length) {
    throw new Error('INTERNAL_ERROR')
  }
  const artifacts = snapshotRows(results[0], 1)
  const artifact = artifacts[0]
  if (!artifact || artifact.nonterminal === 1) throw new Error('WORKBOOK_EXPORT_CONFLICT')
  if (artifact.object_key === null) throw new Error('NOT_FOUND')
  const revisionRows = snapshotRows(results.at(-1), 1)
  const revision = revisionRows[0]?.revision
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('INTERNAL_ERROR')
  if (format === 'panel-v2') return Object.freeze({
    artifact, revision,
    rows: snapshotRows(results[1], MAX_WORKBOOK_EXPORT_ROWS),
  })
  return Object.freeze({
    artifact, revision,
    baseRows: snapshotRows(results[1], MAX_WORKBOOK_EXPORT_ROWS),
    unlinkedRows: snapshotRows(results[2], 2_500),
    voidRows: snapshotRows(results[3], MAX_WORKBOOK_EXPORT_ROWS),
  })
}

const requireExportRevision = async (db, expected) => {
  const row = await db.prepare(
    `SELECT revision FROM finance_reporting_state WHERE authority_key='finance'`,
  ).first()
  if (!row || row.revision !== expected) throw new Error('WORKBOOK_EXPORT_CONFLICT')
}

const sameCapabilities = (left, right) => left.length === right.length
  && left.every((capability, index) => capability === right[index])

const exportAccessFor = (value, nowMs, format) => {
  const actor = captureAuthorityActor(value)
  if (!actor) throw new Error('NOT_FOUND')
  if (['owner', 'coordinator'].includes(actor.role)
    && authorize(actor, 'workbook.centre.export', CENTRE_RESOURCE, { nowMs })) {
    return Object.freeze({ actor, specialistId: null })
  }
  if (format === 'panel-v2' && actor.role === 'specialist'
    && authorize(actor, 'workbook.own.export', {
      kind: 'workbook_own', specialistId: actor.specialistId,
    }, { nowMs })) {
    return Object.freeze({ actor, specialistId: actor.specialistId })
  }
  throw new Error('NOT_FOUND')
}

const requireCurrentAuthority = async (db, expected) => {
  let current
  try {
    current = await resolveCurrentAuthorityActor(db, {
      id: expected.id,
      role: expected.role,
      specialist_id: expected.specialistId,
      version: expected.version,
    })
  } catch {
    throw new Error('NOT_FOUND')
  }
  if (current.authorityRevision !== expected.authorityRevision
    || !sameCapabilities(current.capabilities, expected.capabilities)) {
    throw new Error('NOT_FOUND')
  }
  return current
}

const authoritySnapshotInvariant = (db, actor) => db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'workbook_authority_changed' WHERE NOT EXISTS (
     SELECT 1 FROM staff_users AS staff
     JOIN staff_authorities AS authority ON authority.staff_id=staff.id
     WHERE staff.id=? AND staff.role=? AND staff.specialist_id IS ?
       AND staff.version=? AND staff.status='active' AND authority.revision=?
   )`,
).bind(
  actor.id,
  actor.role,
  actor.specialistId,
  actor.version,
  actor.authorityRevision,
)

const specialistSnapshotInvariant = (db, specialistIds) => db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'workbook_specialist_authority_changed' WHERE (
     SELECT count(*) FROM specialists AS specialist
     JOIN json_each(?) AS selected ON selected.value=specialist.id
     WHERE specialist.status='active'
   ) != ?`,
).bind(JSON.stringify(specialistIds), specialistIds.length)

const validExportBytes = (bytes) => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
    || bytes.byteLength > MAX_WORKBOOK_EXPORT_BYTES) {
    bytes?.fill?.(0)
    throw new Error('WORKBOOK_EXPORT_LIMIT')
  }
  return bytes
}

export async function exportWorkbook({
  db, bucket, actor, keyring, config, centreId, nowMs, format,
} = {}) {
  if (!db?.prepare || !db?.batch || typeof bucket?.get !== 'function'
    || !keyring || config?.appEnv !== 'staging' || config?.dataMode !== 'fictional'
    || centreId !== 'centre_1' || !Number.isSafeInteger(nowMs) || nowMs < 0
    || !['legacy', 'panel-v2'].includes(format)) throw new Error('NOT_FOUND')
  const access = exportAccessFor(actor, nowMs, format)
  const snapshot = await workbookExportSnapshot(db, centreId, format, access.specialistId)
  const { artifact } = snapshot
  const callbacks = createWorkbookPanelMetadataCallbacks({ keyring, config, centreId })
  await requireCurrentAuthority(db, access.actor)

  if (access.specialistId !== null) {
    let bytes
    try {
      bytes = validExportBytes(await specialistPanelExportFor({
        rows: snapshot.rows,
        callbacks,
        specialistId: access.specialistId,
      }))
      await requireCurrentAuthority(db, access.actor)
      await requireExportRevision(db, snapshot.revision)
      const day = WARSAW_DAY.format(new Date(nowMs))
      return Object.freeze({
        bytes,
        filename: `bear-with-me-${format}-${day}.xlsx`,
      })
    } catch (error) {
      bytes?.fill?.(0)
      throw error
    }
  }

  const source = await readWorkbookArtifact({
    bucket,
    keyring,
    config,
    centreId,
    descriptor: workbookArtifactDescriptor(artifact),
  })
  let bytes
  try {
    bytes = format === 'legacy'
      ? await legacyExportFor({
          db, source, keyring, baseRows: snapshot.baseRows,
          unlinkedRows: snapshot.unlinkedRows, voidRows: snapshot.voidRows,
        })
      : await panelExportFor({
        source,
        rows: snapshot.rows,
        callbacks,
        centreId,
      })
    validExportBytes(bytes)
    await requireCurrentAuthority(db, access.actor)
    await requireExportRevision(db, snapshot.revision)
    const day = WARSAW_DAY.format(new Date(nowMs))
    return Object.freeze({
      bytes,
      filename: `bear-with-me-${format}-${day}.xlsx`,
    })
  } catch (error) {
    bytes?.fill?.(0)
    throw error
  } finally {
    source.fill(0)
  }
}

const previewInvalid = () => { throw new Error('WORKBOOK_PREVIEW_INVALID') }
const PANEL_FIELD_DIGEST = /^v([1-9]\d*)_([A-Za-z0-9_-]{43})$/
const capturePreview = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) previewInvalid()
  const keys = Reflect.ownKeys(input)
  if (keys.some((key) => typeof key !== 'string'
    || (!REQUIRED_PREVIEW_KEYS.includes(key) && !OPTIONAL_PREVIEW_KEYS.includes(key)))
    || REQUIRED_PREVIEW_KEYS.some((key) => !keys.includes(key))) previewInvalid()
  const captured = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) previewInvalid()
    captured[key] = descriptor.value
  }
  return captured
}

const sourceValues = (rows) => {
  if (!Array.isArray(rows)) previewInvalid()
  const result = new Set()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.sourceKey !== 'string' || typeof row.recordType !== 'string') previewInvalid()
    const sourceValue = ['english', 'tus'].includes(row.recordType)
      ? ''
      : row.specialistName ?? ''
    if (typeof sourceValue !== 'string'
      || sourceValue !== sourceValue.trim().normalize('NFC')) previewInvalid()
    result.add(sourceValue)
  }
  return result
}

const panelConflict = (code, recordId, field = null, values = {}) => Object.freeze({
  code, ...values, field, recordId,
})

const panelMergeFor = async ({ panel, callbacks, centreId, loadPanelState }) => {
  if (panel.kind === 'legacy') return Object.freeze({
    conflicts: Object.freeze([]),
    plan: Object.freeze({ updates: Object.freeze([]), voids: Object.freeze([]) }),
    response: null,
  })
  const metadata = panel.metadata
  if (!metadata || metadata.format !== 'Panel-v2' || !Array.isArray(metadata.rows)
    || !Array.isArray(metadata.voidIds) || !Array.isArray(panel.edits)
    || !Array.isArray(panel.voidIds)) previewInvalid()
  const signedRows = new Map()
  for (const row of metadata.rows) {
    if (!row || typeof row.id !== 'string' || typeof row.type !== 'string'
      || !Number.isSafeInteger(row.baseVersion) || row.baseVersion < 0
      || !row.fieldDigests || Array.isArray(row.fieldDigests)
      || typeof row.fieldDigests !== 'object' || signedRows.has(row.id)
      || Object.values(row.fieldDigests).some((digest) => (
        typeof digest !== 'string' || !PANEL_FIELD_DIGEST.test(digest)
      ))) previewInvalid()
    signedRows.set(row.id, row)
  }
  if (new Set(panel.voidIds).size !== panel.voidIds.length
    || panel.voidIds.length !== metadata.voidIds.length
    || panel.voidIds.some((id) => !metadata.voidIds.includes(id) || !signedRows.has(id))) {
    previewInvalid()
  }
  const edits = new Map()
  const normalizedEdits = new Map()
  const invalidEditFields = new Map()
  for (const edit of panel.edits) {
    const signed = signedRows.get(edit?.id)
    if (!signed || edits.has(edit.id) || typeof edit.sheet !== 'string'
      || !edit.values || Array.isArray(edit.values) || typeof edit.values !== 'object'
      || Object.keys(edit.values).some((field) => !Object.hasOwn(signed.fieldDigests, field))) {
      previewInvalid()
    }
    edits.set(edit.id, edit)
    const normalized = normalizePanelFinanceEdits(edit.values)
    if (normalized.field !== null) invalidEditFields.set(edit.id, normalized.field)
    else normalizedEdits.set(edit.id, Object.freeze({ ...edit, values: normalized.values }))
  }
  if (panel.voidIds.some((id) => edits.has(id))) previewInvalid()
  const actionableIds = new Set([...edits.keys(), ...panel.voidIds])
  const requestedRows = metadata.rows
    .filter(({ id }) => actionableIds.has(id))
    .sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
  if (!requestedRows.length) return Object.freeze({
    conflicts: Object.freeze([]),
    plan: Object.freeze({ updates: Object.freeze([]), voids: Object.freeze([]) }),
    response: Object.freeze({
      unchangedIds: Object.freeze([]), updates: Object.freeze([]), voidIds: Object.freeze([]),
    }),
  })
  if (typeof loadPanelState !== 'function') previewInvalid()
  const specialistIds = [...new Set([...normalizedEdits.values()]
    .map(({ values }) => values.specialistId)
    .filter((id) => typeof id === 'string'
      && /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(id)))]
    .sort(compareUtf16CodeUnits)
  let loaded
  try {
    loaded = await loadPanelState(Object.freeze({
      centreId,
      specialistIds: Object.freeze(specialistIds),
      rows: Object.freeze(requestedRows.map((row) => Object.freeze({
        baseVersion: row.baseVersion,
        fieldDigests: Object.freeze({ ...row.fieldDigests }),
        id: row.id,
        type: row.type,
      }))),
    }))
  } catch (error) {
    if (error?.message === 'WORKBOOK_PREVIEW_INVALID') throw error
    previewInvalid()
  }
  if (!loaded || !loaded.fieldsByType || Array.isArray(loaded.fieldsByType)
    || typeof loaded.fieldsByType !== 'object' || !Array.isArray(loaded.rows)
    || !Array.isArray(loaded.specialistIds)
    || new Set(loaded.specialistIds).size !== loaded.specialistIds.length
    || loaded.specialistIds.some((id) => (
      typeof id !== 'string' || !/^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(id)
    ))) previewInvalid()
  const currentRows = new Map()
  for (const row of loaded.rows) {
    if (!row || typeof row.id !== 'string' || !actionableIds.has(row.id)
      || typeof row.type !== 'string' || !Number.isSafeInteger(row.version) || row.version < 1
      || !row.values || Array.isArray(row.values) || typeof row.values !== 'object'
      || currentRows.has(row.id)) previewInvalid()
    currentRows.set(row.id, row)
  }

  const conflicts = []
  const unchangedIds = []
  const planUpdates = []
  const planVoids = []
  for (const signed of requestedRows) {
    const current = currentRows.get(signed.id)
    const edit = edits.get(signed.id)
    if (!current) {
      conflicts.push(panelConflict('PANEL_ROW_MISSING', signed.id))
      continue
    }
    if (current.type !== signed.type) previewInvalid()
    const fields = loaded.fieldsByType[signed.type]
    if (!fields || Array.isArray(fields) || typeof fields !== 'object'
      || Object.keys(signed.fieldDigests).some((field) => !Object.hasOwn(fields, field))) {
      previewInvalid()
    }
    if (current.mutationBlocked === true) {
      conflicts.push(panelConflict('PANEL_DEPENDENCY_CONFLICT', signed.id))
      continue
    }
    if (edit) {
      const invalidEditField = invalidEditFields.get(signed.id)
      if (invalidEditField) {
        conflicts.push(panelConflict('PANEL_VALUE_INVALID', signed.id, invalidEditField))
        continue
      }
      const normalizedEdit = normalizedEdits.get(signed.id)
      if (!normalizedEdit) previewInvalid()
      if (Object.hasOwn(normalizedEdit.values, 'specialistId')
        && normalizedEdit.values.specialistId !== null
        && !loaded.specialistIds.includes(normalizedEdit.values.specialistId)) {
        conflicts.push(panelConflict('PANEL_VALUE_INVALID', signed.id, 'specialistId'))
        continue
      }
      const baseValues = {}
      const currentValues = {}
      const editedValues = {}
      for (const [field, editedValue] of Object.entries(normalizedEdit.values)) {
        if (!Object.hasOwn(current.values, field)) previewInvalid()
        const version = Number(PANEL_FIELD_DIGEST.exec(signed.fieldDigests[field])?.[1])
        const currentDigest = await callbacks.digestField({
          rowType: signed.type, rowId: signed.id, field,
          value: current.values[field], hmacVersion: version,
        })
        const editedDigest = await callbacks.digestField({
          rowType: signed.type, rowId: signed.id, field,
          value: editedValue, hmacVersion: version,
        })
        if (currentDigest === signed.fieldDigests[field]) {
          baseValues[field] = current.values[field]
        } else if (editedDigest === signed.fieldDigests[field]) {
          baseValues[field] = editedValue
        } else {
          conflicts.push(panelConflict(
            'PANEL_CONCURRENT_EDIT', signed.id, field,
            { current: current.values[field], edited: editedValue },
          ))
          continue
        }
        currentValues[field] = current.values[field]
        editedValues[field] = editedValue
      }
      if (Object.keys(editedValues).length) {
        const merged = mergePanelEdits({
          baseRows: [{ id: signed.id, values: baseValues }],
          currentRows: [{ id: signed.id, values: currentValues }],
          editedRows: [{ id: signed.id, values: editedValues }],
          fields,
        })
        if (merged.conflicts.length) previewInvalid()
        const mergedValues = merged.updates[0]?.values ?? {}
        const prospective = prospectivePanelFinanceValues(current.values, mergedValues)
        const validationSpecialistIds = Object.hasOwn(mergedValues, 'specialistId')
          ? loaded.specialistIds
          : [...loaded.specialistIds, current.values.specialistId].filter(Boolean)
        const invalidField = invalidPanelFinanceField({
          kind: current.kind,
          recordType: current.recordType,
          values: prospective,
          specialistIds: validationSpecialistIds,
        })
        if (invalidField) {
          conflicts.push(panelConflict('PANEL_VALUE_INVALID', signed.id, invalidField))
          continue
        }
        unchangedIds.push(...merged.unchangedIds)
        planUpdates.push(...merged.updates.map((update) => Object.freeze({
          ...update, expectedVersion: current.version, type: signed.type,
        })))
      }
      continue
    }

    let concurrent = false
    const baseValues = {}
    for (const [field, digest] of Object.entries(signed.fieldDigests)) {
      if (!Object.hasOwn(current.values, field)) previewInvalid()
      const version = Number(PANEL_FIELD_DIGEST.exec(digest)?.[1])
      const actual = await callbacks.digestField({
        rowType: signed.type, rowId: signed.id, field,
        value: current.values[field], hmacVersion: version,
      })
      if (actual !== digest) concurrent = true
      baseValues[field] = current.values[field]
    }
    if (concurrent) {
      conflicts.push(panelConflict('PANEL_CONCURRENT_VOID', signed.id))
      continue
    }
    const merged = mergePanelEdits({
      baseRows: [{ id: signed.id, values: baseValues }],
      currentRows: [{ id: signed.id, values: { ...baseValues } }],
      editedRows: [],
      fields,
      voidIds: [signed.id],
    })
    if (merged.conflicts.length || merged.voids.length !== 1) previewInvalid()
    planVoids.push(Object.freeze({
      expectedVersion: current.version, id: signed.id, type: signed.type,
    }))
  }
  conflicts.sort((left, right) => (
    compareUtf16CodeUnits(left.recordId, right.recordId)
    || compareUtf16CodeUnits(left.field ?? '', right.field ?? '')
    || compareUtf16CodeUnits(left.code, right.code)
  ))
  planUpdates.sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
  planVoids.sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
  unchangedIds.sort(compareUtf16CodeUnits)
  return Object.freeze({
    conflicts: Object.freeze(conflicts),
    plan: Object.freeze({
      updates: Object.freeze(planUpdates), voids: Object.freeze(planVoids),
    }),
    response: Object.freeze({
      unchangedIds: Object.freeze(unchangedIds),
      updates: Object.freeze(planUpdates.map(({ expectedVersion: _version, ...update }) => (
        Object.freeze(update)
      ))),
      voidIds: Object.freeze(planVoids.map(({ id }) => id)),
    }),
  })
}

async function inspectWorkbook(input, includeSpecialistOptions = false) {
  const command = capturePreview(input)
  const bytes = command.bytes instanceof Uint8Array
    ? new Uint8Array(command.bytes.buffer, command.bytes.byteOffset, command.bytes.byteLength)
    : null
  if (!bytes || bytes.byteLength < 1 || bytes.byteLength > MAX_WORKBOOK_BYTES
    || typeof command.filename !== 'string' || !command.filename.toLowerCase().endsWith('.xlsx')
    || command.filename.includes('/') || command.filename.includes('\\')
    || !authorize(command.actor, 'finance.import', CENTRE_RESOURCE, {
      nowMs: command.nowMs,
    })
    || command.config?.appEnv !== 'staging' || command.config?.dataMode !== 'fictional'
    || typeof command.centreId !== 'string' || !CENTRE_ID.test(command.centreId)
    || !Number.isSafeInteger(command.nowMs) || command.nowMs < 0
    || (command.parse !== undefined && typeof command.parse !== 'function')
    || (command.readPanel !== undefined && typeof command.readPanel !== 'function')
    || (command.loadPanelState !== undefined && typeof command.loadPanelState !== 'function')
    || (command.nonceFactory !== undefined && typeof command.nonceFactory !== 'function')) {
    previewInvalid()
  }
  const callbacks = createWorkbookPanelMetadataCallbacks({
    keyring: command.keyring,
    config: command.config,
    centreId: command.centreId,
  })
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  let parsed
  try {
    parsed = await (command.parse ?? parseWorkbookFile)(
      arrayBuffer, { filename: command.filename },
    )
  } catch { previewInvalid() }
  let panel
  try {
    panel = await (command.readPanel ?? readPanelWorkbook)(
      bytes, { verify: callbacks.verify },
    )
  } catch (error) {
    if (['PANEL_META_SIGNATURE_INVALID', 'WORKBOOK_PANEL_SIGNATURE_INVALID']
      .includes(error?.message)) throw new Error('WORKBOOK_PANEL_SIGNATURE_INVALID')
    previewInvalid()
  }
  if (!parsed || typeof parsed !== 'object' || !FINGERPRINT.test(parsed.fingerprint ?? '')
    || !Number.isSafeInteger(parsed.parserVersion) || parsed.parserVersion < 2
    || !Number.isSafeInteger(parsed.materializerVersion) || parsed.materializerVersion < 2
    || !parsed.counts || !Array.isArray(parsed.warnings)
    || !Array.isArray(parsed.rows) || !Array.isArray(parsed.quarantinedRows)
    || !parsed.reconciliation || !panel || !['legacy', 'panel-v2'].includes(panel.kind)) {
    previewInvalid()
  }
  if (panel.kind === 'legacy' && parsed.fingerprint !== APPROVED_WORKBOOK_FINGERPRINT) {
    throw new Error('WORKBOOK_FINGERPRINT_REJECTED')
  }
  if (panel.kind === 'panel-v2' && (
    panel.metadata?.scope?.type !== 'centre'
    || panel.metadata?.scope?.id !== command.centreId
  )) throw new Error('WORKBOOK_SCOPE_MISMATCH')
  const panelMerge = await panelMergeFor({
    panel,
    callbacks,
    centreId: command.centreId,
    loadPanelState: command.loadPanelState,
  })

  const values = panel.kind === 'legacy' ? sourceValues(parsed.rows) : new Set()
  const proposedMappings = [...values]
    .map((sourceValue) => PROFILE_MAPPINGS[sourceValue] ?? null)
    .filter(Boolean)
    .sort((left, right) => compareUtf16CodeUnits(left.displayName, right.displayName))
  const mappingConflicts = []
  for (const sourceValue of [...values]
    .filter((value) => !Object.hasOwn(PROFILE_MAPPINGS, value))
    .sort(compareUtf16CodeUnits)) {
    const provenance = await digestWorkbookSourceValue({
      keyring: command.keyring,
      config: command.config,
      centreId: command.centreId,
      sourceValueKind: sourceValue === '' ? 'blank' : 'explicit_name',
      sourceValue,
    })
    mappingConflicts.push(Object.freeze({
      id: `wmc_${provenance.digest}`,
      code: 'SPECIALIST_MAPPING_REQUIRED',
      sourceValue,
    }))
  }
  const conflicts = Object.freeze([...mappingConflicts, ...panelMerge.conflicts])
  const panelSpecialistIds = [...new Set([
    ...(panelMerge.response?.updates ?? []).flatMap(({ values }) => (
      typeof values.specialistId === 'string' ? [values.specialistId] : []
    )),
    ...panelMerge.conflicts.flatMap(({ field, current, edited }) => (
      field === 'specialistId'
        ? [current, edited].filter((value) => typeof value === 'string')
        : []
    )),
  ])].sort(compareUtf16CodeUnits)
  const previewPlan = Object.freeze({
    schema: 'workbook_preview_plan.v1',
    workbookKind: panel.kind,
    panel: panelMerge.plan,
    proposedMappings: Object.freeze(proposedMappings),
  })
  const planDigest = await digestWorkbookPreviewPlan({
    keyring: command.keyring,
    config: command.config,
    centreId: command.centreId,
    actorId: command.actor.id,
    plan: previewPlan,
  })
  const previewToken = await createWorkbookPreviewToken({
    keyring: command.keyring,
    config: command.config,
    centreId: command.centreId,
    actorId: command.actor.id,
    fingerprint: parsed.fingerprint,
    byteSize: bytes.byteLength,
    parserVersion: parsed.parserVersion,
    materializerVersion: parsed.materializerVersion,
    planDigest,
    issuedAtMs: command.nowMs,
    expiresAtMs: command.nowMs + 5 * 60 * 1000,
    ...(command.nonceFactory ? { nonceFactory: command.nonceFactory } : {}),
  })
  const responseData = {
      fingerprint: parsed.fingerprint,
      parserVersion: parsed.parserVersion,
      materializerVersion: parsed.materializerVersion,
      planDigest,
      previewToken,
      counts: parsed.counts,
      warnings: parsed.warnings,
      reconciliation: parsed.reconciliation,
      proposedMappings: Object.freeze(proposedMappings),
      conflicts,
      quarantine: parsed.quarantinedRows,
      workbookKind: panel.kind,
      specialistOptions: includeSpecialistOptions
        ? await loadWorkbookSpecialistOptions({ db: command.db, keyring: command.keyring })
        : Object.freeze([]),
      specialistLabels: includeSpecialistOptions
        ? await loadWorkbookSpecialistLabels({
          db: command.db, keyring: command.keyring, ids: panelSpecialistIds,
        })
        : Object.freeze([]),
  }
  if (panelMerge.response) responseData.panelChanges = panelMerge.response
  const response = Object.freeze({ data: Object.freeze(responseData) })
  return Object.freeze({
    callbacks, panel, panelPlan: panelMerge.plan, parsed, planDigest, response,
  })
}

export async function previewWorkbook(input) {
  const command = capturePreview(input)
  if (!command.db?.prepare) previewInvalid()
  const inspected = await inspectWorkbook(command, true)
  await requireCurrentAuthority(command.db, command.actor)
  return inspected.response
}

const createInvalid = () => { throw new Error('WORKBOOK_IMPORT_INVALID') }
const generated = (factory, prefix, pattern) => {
  let value
  try { value = `${prefix}_${factory()}` } catch { createInvalid() }
  if (!pattern.test(value)) createInvalid()
  return value
}
const sha256Base64 = async (value) => {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value)
  return encodeBase64Url(await crypto.subtle.digest('SHA-256', bytes))
}
const instant = (nowMs) => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) createInvalid()
  try { return new Date(nowMs).toISOString() } catch { createInvalid() }
}
const importDto = (row) => Object.freeze({
  id: row.id,
  artifactId: row.artifact_id,
  status: row.status,
  acceptedRecords: row.accepted_records,
  quarantinedRecords: row.quarantined_records,
  createdByStaffId: row.created_by_staff_id,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
})
const importResponse = (row, status = 200) => Object.freeze({
  status,
  body: Object.freeze({ data: Object.freeze({ import: importDto(row) }) }),
})
const materializationJobDto = (row) => Object.freeze({
  id: row.job_id,
  phase: row.job_phase,
  status: row.job_status,
  cursor: row.job_cursor,
  totalRecords: row.job_total_records,
  processedRecords: row.job_processed_records,
  version: row.job_version,
  updatedAt: row.job_updated_at,
  completedAt: row.job_completed_at,
})

const loadImportRow = async (db, importId, actorId = null) => {
  if (!db?.prepare || typeof importId !== 'string' || !IMPORT_ID.test(importId)) {
    createInvalid()
  }
  const row = await db.prepare(
    `SELECT id,artifact_id,status,accepted_records,quarantined_records,
            created_by_staff_id,version,created_at,updated_at,completed_at
     FROM workbook_imports WHERE id=?`,
  ).bind(importId).first()
  if (!row || (actorId !== null && row.created_by_staff_id !== actorId)) {
    throw new Error('NOT_FOUND')
  }
  return row
}

const DISCOVERY_ROW_KEYS = Object.freeze([
  'id', 'artifact_id', 'status', 'version', 'job_status', 'progress_json',
])
const MATERIALIZATION_JOB_STATUS_BY_IMPORT_STATUS = Object.freeze({
  complete: 'complete',
  failed: 'failed',
  materializing: 'running',
  ready: 'ready',
})
const validMaterializationStatusPair = (importStatus, jobStatus) => (
  typeof importStatus === 'string'
  && Object.hasOwn(MATERIALIZATION_JOB_STATUS_BY_IMPORT_STATUS, importStatus)
  && MATERIALIZATION_JOB_STATUS_BY_IMPORT_STATUS[importStatus] === jobStatus
)
const readMaterializationProgress = (value) => {
  try { return parseWorkbookMaterializationProgress(value) } catch {
    throw new Error('INTERNAL_ERROR')
  }
}
const discoveryRows = (value) => {
  try {
    const result = Object.getOwnPropertyDescriptor(value, 'results')
    if (!result?.enumerable || !Object.hasOwn(result, 'value')) throw new Error()
    const rows = result.value
    if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype
      || rows.length > 2) throw new Error()
    const descriptors = Object.getOwnPropertyDescriptors(rows)
    if (Reflect.ownKeys(descriptors).length !== rows.length + 1) throw new Error()
    return Array.from({ length: rows.length }, (_, index) => {
      const item = descriptors[String(index)]
      if (!item?.enumerable || !Object.hasOwn(item, 'value')) throw new Error()
      const row = item.value
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error()
      const fields = Object.getOwnPropertyDescriptors(row)
      const keys = Reflect.ownKeys(fields)
      if (keys.length !== DISCOVERY_ROW_KEYS.length || keys.some((key) => (
        typeof key !== 'string' || !DISCOVERY_ROW_KEYS.includes(key)
      ))) throw new Error()
      return Object.fromEntries(DISCOVERY_ROW_KEYS.map((key) => {
        const field = fields[key]
        if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw new Error()
        return [key, field.value]
      }))
    })
  } catch {
    throw new Error('INTERNAL_ERROR')
  }
}

const discoveredImportState = (row) => {
  const progress = readMaterializationProgress(row.progress_json)
  if (!IMPORT_ID.test(row.id ?? '') || !ARTIFACT_ID.test(row.artifact_id ?? '')
    || !validMaterializationStatusPair(row.status, row.job_status)
    || !Number.isSafeInteger(row.version) || row.version < 1
  ) {
    throw new Error('INTERNAL_ERROR')
  }
  return Object.freeze({
    artifactId: row.artifact_id,
    converged: row.status === 'complete',
    createdRecords: progress.inserted,
    importId: row.id,
    status: row.status,
    version: row.version,
    voidedRecords: progress.voided,
  })
}

export async function discoverWorkbookImport({ db, actor, nowMs, fingerprint } = {}) {
  if (!authorize(actor, 'finance.import', CENTRE_RESOURCE, { nowMs })
    || !db?.prepare || !Number.isSafeInteger(nowMs) || nowMs < 0
    || typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) {
    throw new Error('NOT_FOUND')
  }
  const rows = discoveryRows(await db.prepare(
    `SELECT import.id,import.artifact_id,import.status,import.version,
            job.status AS job_status,job.progress_json
     FROM workbook_imports AS import
     JOIN workbook_artifacts AS artifact ON artifact.id=import.artifact_id
     JOIN workbook_materialization_jobs AS job ON job.import_id=import.id
     WHERE import.created_by_staff_id=?
       AND artifact.created_by_staff_id=import.created_by_staff_id
       AND job.created_by_staff_id=import.created_by_staff_id
       AND artifact.centre_id='centre_1'
       AND artifact.fingerprint=?
     LIMIT 2`,
  ).bind(actor.id, fingerprint).all())
  if (rows.length > 1) throw new Error('INTERNAL_ERROR')
  const discovered = rows.length === 0 ? null : discoveredImportState(rows[0])
  await requireCurrentAuthority(db, actor)
  return Object.freeze({ data: Object.freeze({ import: discovered }) })
}

export async function getWorkbookImport({ db, actor, nowMs, importId } = {}) {
  if (!authorize(actor, 'finance.import', CENTRE_RESOURCE, { nowMs })
    || !db?.prepare || typeof importId !== 'string' || !IMPORT_ID.test(importId)
    || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('NOT_FOUND')
  const row = await db.prepare(
    `SELECT import.id,import.artifact_id,import.status,import.accepted_records,
            import.quarantined_records,import.created_by_staff_id,import.version,
            import.created_at,import.updated_at,import.completed_at,
            job.id AS job_id,job.phase AS job_phase,job.status AS job_status,
            job.cursor AS job_cursor,job.total_records AS job_total_records,
            job.processed_records AS job_processed_records,job.version AS job_version,
            job.updated_at AS job_updated_at,job.completed_at AS job_completed_at,
            job.summary_json,job.progress_json
     FROM workbook_imports AS import
     JOIN workbook_materialization_jobs AS job ON job.import_id=import.id
     WHERE import.id=? AND import.created_by_staff_id=?`,
  ).bind(importId, actor.id).first()
  if (!row) throw new Error('NOT_FOUND')
  if (!validMaterializationStatusPair(row.status, row.job_status)) {
    throw new Error('INTERNAL_ERROR')
  }
  const progress = readMaterializationProgress(row.progress_json)
  const data = {
    import: importDto(row),
    job: materializationJobDto(row),
    evidence: Object.freeze({
      createdRecords: progress.inserted,
      voidedRecords: progress.voided,
      converged: row.status === 'complete' && row.job_status === 'complete',
    }),
  }
  if (row.summary_json !== null) {
    let summary
    try { summary = JSON.parse(row.summary_json) } catch { throw new Error('INTERNAL_ERROR') }
    if (!summary || Array.isArray(summary) || typeof summary !== 'object'
      || Object.values(summary).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error('INTERNAL_ERROR')
    }
    data.reconciliation = Object.freeze({ ...summary })
  }
  await requireCurrentAuthority(db, actor)
  return Object.freeze({ data: Object.freeze(data) })
}

const sourcePayload = (row) => {
  const { raw, ...normalized } = row
  return Object.freeze({
    schema: 'workbook_source_payload.v1',
    normalized: Object.freeze(normalized),
    raw: raw ?? Object.freeze({}),
  })
}

const initialPaidAmountFor = (row) => row.settlementStatus === 'paid'
  ? row.amountGrosze
  : row.settlementStatus === 'partial'
    ? Math.max(1, Math.min(row.amountGrosze - 1, Math.floor(row.amountGrosze / 2)))
    : 0

const sealSource = async (keyring, dataKey, recordId, value, field = 'source_payload') => (
  JSON.stringify(await encryptForScope(keyring, dataKey, {
    expectedScope: SOURCE_SCOPE,
    recordId,
    field,
    plaintext: JSON.stringify(value),
  }))
)

const sourceRowsFor = async ({
  parsed, importId, keyring, config, centreId, dataKey, idFactory, now,
}) => {
  const records = []
  const quarantine = []
  const all = [
    ...parsed.rows.map((row) => ({ disposition: 'accepted', row })),
    ...parsed.quarantinedRows.map((row) => ({ disposition: 'quarantined', row })),
  ]
  for (const { disposition, row } of all) {
    const match = SOURCE_KEY.exec(row.sourceKey ?? '')
    const validPeriod = (row.periodPrecision === 'day'
        && typeof row.occurredOn === 'string'
        && row.periodMonth === row.occurredOn.slice(0, 7))
      || (row.periodPrecision === 'month'
        && row.occurredOn === null && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(row.periodMonth))
      || (row.periodPrecision === 'unknown'
        && row.occurredOn === null && row.periodMonth === null)
    if (!match || typeof row.sheet !== 'string' || !Number.isSafeInteger(row.rowNumber)
      || !['income', 'expense', 'tus', 'english'].includes(row.recordType)
      || !validPeriod) createInvalid()
    const id = generated(idFactory, 'wbs', /^wbs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
    const payload = sourcePayload(row)
    const provenance = await digestWorkbookSourcePayload({
      keyring, config, centreId, sourceKey: row.sourceKey, payload,
    })
    const sourceValue = ['english', 'tus'].includes(row.recordType)
      ? ''
      : row.specialistName ?? ''
    const specialistProvenance = await digestWorkbookSourceValue({
      keyring,
      config,
      centreId,
      sourceValueKind: sourceValue === '' ? 'blank' : 'explicit_name',
      sourceValue,
    })
    records.push(Object.freeze({
      id,
      importId,
      sourceKey: row.sourceKey,
      sheetIndex: Number(match[1]),
      sheetName: row.sheet,
      rowNumber: row.rowNumber,
      blockIndex: Number(match[3]),
      recordType: row.recordType,
      disposition,
      accountingMonth: row.accountingMonth ?? null,
      occurredOn: row.occurredOn ?? null,
      periodPrecision: row.periodPrecision,
      periodMonth: row.periodMonth,
      amountGrosze: row.amountGrosze ?? null,
      paymentMethod: disposition === 'accepted' ? row.paymentMethod : null,
      settlementStatus: disposition === 'accepted' ? row.settlementStatus : null,
      invoiceStatus: disposition === 'accepted' ? row.invoiceStatus : null,
      initialPaidAmountGrosze: disposition === 'accepted' ? initialPaidAmountFor(row) : null,
      recordDigest: provenance.digest,
      recordDigestHmacVersion: provenance.hmacVersion,
      specialistSourceDigest: specialistProvenance.digest,
      specialistSourceHmacVersion: specialistProvenance.hmacVersion,
      warningCodesJson: JSON.stringify(row.warningCodes ?? []),
      sourcePayloadVersion: 1,
      sourcePayloadEnvelope: await sealSource(keyring, dataKey, id, payload),
      createdAt: now,
    }))
    if (disposition === 'quarantined') {
      const reasonCodes = Array.isArray(row.reasonCodes)
        ? row.reasonCodes : [row.reasonCode]
      if (typeof row.reasonCode !== 'string' || reasonCodes.some((code) => typeof code !== 'string')) {
        createInvalid()
      }
      quarantine.push(Object.freeze({
        id: generated(idFactory, 'wbq', /^wbq_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
        sourceRecordId: id,
        primaryReason: row.reasonCode,
        reasonCodesJson: JSON.stringify(reasonCodes),
        createdAt: now,
      }))
    }
  }
  return { quarantine, records }
}

const resolutionRowsFor = async ({
  mappings, importId, actorId, keyring, config, centreId, dataKey, idFactory, now,
}) => {
  const result = []
  for (const mapping of mappings) {
    const id = generated(idFactory, 'wbr', /^wbr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
    const provenance = await digestWorkbookSourceValue({
      keyring,
      config,
      centreId,
      sourceValueKind: mapping.sourceValueKind,
      sourceValue: mapping.sourceValue,
    })
    result.push(Object.freeze({
      id,
      importId,
      resolutionCode: mapping.resolutionCode,
      specialistId: mapping.specialistId,
      sourceValueKind: mapping.sourceValueKind,
      sourceValueDigest: provenance.digest,
      sourceValueHmacVersion: provenance.hmacVersion,
      sourceValueEnvelope: await sealSource(
        keyring, dataKey, id,
        { schema: 'workbook_specialist_source.v1', sourceValue: mapping.sourceValue },
        'source_value',
      ),
      resolvedByStaffId: actorId,
      createdAt: now,
    }))
  }
  return result
}

const valuesStatement = (db, sql, values) => db.prepare(sql).bind(JSON.stringify(values))
const sourceInsertStatements = (db, records) => {
  const statements = []
  for (let offset = 0; offset < records.length; offset += 100) {
    statements.push(valuesStatement(db, `INSERT INTO workbook_source_records
      (id,import_id,source_key,sheet_index,sheet_name,row_number,block_index,
       record_type,disposition,accounting_month,occurred_on,period_precision,
       period_month,amount_grosze,
       payment_method,settlement_status,invoice_status,initial_paid_amount_grosze,
       record_digest,record_digest_hmac_version,specialist_source_digest,
       specialist_source_hmac_version,warning_codes_json,source_payload_version,
       source_payload_envelope,created_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.importId'),
             json_extract(value,'$.sourceKey'),json_extract(value,'$.sheetIndex'),
             json_extract(value,'$.sheetName'),json_extract(value,'$.rowNumber'),
             json_extract(value,'$.blockIndex'),json_extract(value,'$.recordType'),
             json_extract(value,'$.disposition'),json_extract(value,'$.accountingMonth'),
             json_extract(value,'$.occurredOn'),json_extract(value,'$.periodPrecision'),
             json_extract(value,'$.periodMonth'),json_extract(value,'$.amountGrosze'),
             json_extract(value,'$.paymentMethod'),
             json_extract(value,'$.settlementStatus'),
             json_extract(value,'$.invoiceStatus'),
             json_extract(value,'$.initialPaidAmountGrosze'),
             json_extract(value,'$.recordDigest'),
             json_extract(value,'$.recordDigestHmacVersion'),
             json_extract(value,'$.specialistSourceDigest'),
             json_extract(value,'$.specialistSourceHmacVersion'),
             json_extract(value,'$.warningCodesJson'),
             json_extract(value,'$.sourcePayloadVersion'),
             json_extract(value,'$.sourcePayloadEnvelope'),json_extract(value,'$.createdAt')
      FROM json_each(?)`, records.slice(offset, offset + 100)))
  }
  return statements
}

const replayRow = (db, actorId, idempotencyKey) => db.prepare(
  `SELECT request_hash,import_id FROM workbook_request_replays
   WHERE actor_staff_id=? AND operation='workbooks.import' AND idempotency_key=?`,
).bind(actorId, idempotencyKey).first()

export async function createWorkbookImport(input) {
  const optional = [
    'artifactNonceFactory', 'loadPanelState', 'nonceFactory', 'parse', 'readPanel',
    'resolutions', 'storeArtifact',
  ]
  const required = [
    'db', 'bucket', 'actor', 'keyring', 'config', 'centreId', 'nowMs',
    'correlationId', 'idFactory', 'bytes', 'filename', 'previewToken',
    'idempotencyKey',
  ]
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
    || required.some((key) => !Object.hasOwn(input, key))
    || Reflect.ownKeys(input).some((key) => (
      typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))
    ))) createInvalid()
  const command = Object.freeze({ ...input })
  if (!command.db?.prepare || !command.db?.batch || typeof command.bucket?.put !== 'function'
    || !authorize(command.actor, 'finance.import', CENTRE_RESOURCE, {
      nowMs: command.nowMs,
    })
    || command.config?.appEnv !== 'staging' || command.config?.dataMode !== 'fictional'
    || command.centreId !== SOURCE_SCOPE.id || typeof command.idFactory !== 'function'
    || typeof command.correlationId !== 'string' || !CORRELATION_ID.test(command.correlationId)
    || typeof command.previewToken !== 'string'
    || typeof command.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey)) createInvalid()
  const now = instant(command.nowMs)
  const submittedResolutions = command.resolutions ?? []
  if (!Array.isArray(submittedResolutions) || submittedResolutions.length > 100) createInvalid()
  const canonicalResolutions = submittedResolutions.map((resolution) => {
    if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)
      || Object.getPrototypeOf(resolution) !== Object.prototype
      || Reflect.ownKeys(resolution).length !== 2
      || !Object.hasOwn(resolution, 'conflictId')
      || !Object.hasOwn(resolution, 'specialistId')
      || typeof resolution.conflictId !== 'string'
      || !/^wmc_[A-Za-z0-9_-]{43}$/.test(resolution.conflictId)
      || typeof resolution.specialistId !== 'string'
      || !/^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(resolution.specialistId)) {
      createInvalid()
    }
    return Object.freeze({
      conflictId: resolution.conflictId, specialistId: resolution.specialistId,
    })
  }).sort((left, right) => compareUtf16CodeUnits(left.conflictId, right.conflictId))
  if (new Set(canonicalResolutions.map(({ conflictId }) => conflictId)).size
    !== canonicalResolutions.length) createInvalid()
  if (!(command.bytes instanceof Uint8Array)) createInvalid()
  const submittedFingerprint = await sha256Base64(command.bytes)
  const tokenDigest = await sha256Base64(command.previewToken)
  const requestHash = await sha256Base64(JSON.stringify([
    'workbooks.import.request.v2', submittedFingerprint, command.filename,
    tokenDigest, canonicalResolutions,
  ]))
  const replay = await replayRow(command.db, command.actor.id, command.idempotencyKey)
  if (replay) {
    if (replay.request_hash !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT')
    const replayed = await loadImportRow(command.db, replay.import_id, command.actor.id)
    await requireCurrentAuthority(command.db, command.actor)
    return importResponse(replayed)
  }
  const inspected = await inspectWorkbook({
    bytes: command.bytes,
    filename: command.filename,
    actor: command.actor,
    keyring: command.keyring,
    config: command.config,
    centreId: command.centreId,
    nowMs: command.nowMs,
    ...(command.parse ? { parse: command.parse } : {}),
    ...(command.readPanel ? { readPanel: command.readPanel } : {}),
    ...(command.loadPanelState ? { loadPanelState: command.loadPanelState } : {}),
    ...(command.nonceFactory ? { nonceFactory: command.nonceFactory } : {}),
  })
  const mappingConflicts = inspected.response.data.conflicts
    .filter(({ code }) => code === 'SPECIALIST_MAPPING_REQUIRED')
  const blockingConflicts = inspected.response.data.conflicts
    .filter(({ code }) => code !== 'SPECIALIST_MAPPING_REQUIRED')
  await verifyWorkbookPreviewToken({
    token: command.previewToken,
    keyring: command.keyring,
    config: command.config,
    expected: {
      centreId: command.centreId,
      actorId: command.actor.id,
      fingerprint: inspected.parsed.fingerprint,
      byteSize: command.bytes.byteLength,
      parserVersion: inspected.parsed.parserVersion,
      materializerVersion: inspected.parsed.materializerVersion,
      planDigest: inspected.planDigest,
    },
    nowMs: command.nowMs,
  })
  const expectedConflictIds = mappingConflicts.map(({ id }) => id)
    .sort(compareUtf16CodeUnits)
  if (blockingConflicts.length
    || canonicalResolutions.length !== expectedConflictIds.length
    || canonicalResolutions.some(({ conflictId }, index) => (
      conflictId !== expectedConflictIds[index]
    ))) throw new Error('WORKBOOK_IMPORT_CONFLICT')
  const mappingByConflict = new Map(mappingConflicts.map((conflict) => [conflict.id, conflict]))
  const explicitMappings = canonicalResolutions.map(({ conflictId, specialistId }) => {
    const conflict = mappingByConflict.get(conflictId)
    return Object.freeze({
      displayName: specialistId,
      resolutionCode: 'explicit_match',
      sourceValue: conflict.sourceValue,
      sourceValueKind: 'explicit_name',
      specialistId,
    })
  })
  const allMappings = [
    ...inspected.response.data.proposedMappings,
    ...explicitMappings,
  ]
  const specialistIds = [...new Set(allMappings.map(({ specialistId }) => specialistId))]
  if (specialistIds.length) {
    const found = (await command.db.prepare(
      `SELECT id FROM specialists
       WHERE id IN (${specialistIds.map(() => '?').join(',')})
         AND status='active' ORDER BY id`,
    ).bind(...specialistIds).all()).results
    if (!Array.isArray(found) || found.length !== specialistIds.length
      || new Set(found.map(({ id }) => id)).size !== specialistIds.length) {
      throw new Error('WORKBOOK_IMPORT_CONFLICT')
    }
  }
  const importId = generated(command.idFactory, 'wbi', IMPORT_ID)
  const artifactId = generated(command.idFactory, 'wba', /^wba_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
  const templateId = generated(command.idFactory, 'wbt', /^wbt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
  const jobId = generated(command.idFactory, 'wbj', /^wbj_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
  const auditId = generated(command.idFactory, 'aud', /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
  const resolutionSetId = canonicalResolutions.length
    ? generated(command.idFactory, 'wrs', /^wrs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
    : null
  const resolutionAuditId = resolutionSetId === null ? null
    : generated(command.idFactory, 'aud', /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
  const dataKey = await getOrCreateDataKey(command.db, command.keyring, SOURCE_SCOPE, {
    id: generated(command.idFactory, 'key', /^key_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
    createdAt: now,
  })
  const isLegacyImport = inspected.panel.kind === 'legacy'
  const { records, quarantine } = isLegacyImport
    ? await sourceRowsFor({
      parsed: inspected.parsed,
      importId,
      keyring: command.keyring,
      config: command.config,
      centreId: command.centreId,
      dataKey,
      idFactory: command.idFactory,
      now,
    })
    : { records: [], quarantine: [] }
  const resolutions = isLegacyImport
    ? await resolutionRowsFor({
      mappings: allMappings,
      importId,
      actorId: command.actor.id,
      keyring: command.keyring,
      config: command.config,
      centreId: command.centreId,
      dataKey,
      idFactory: command.idFactory,
      now,
    })
    : []
  const materializationPlanEnvelope = await sealSource(
    command.keyring,
    dataKey,
    importId,
    Object.freeze({
      schema: 'workbook_import_plan.v1',
      workbookKind: inspected.panel.kind,
      previewPlanDigest: inspected.planDigest,
      panel: inspected.panelPlan,
      conflicts: mappingConflicts.map(({ id, code, sourceValue }) => Object.freeze({
        id, code, kind: 'specialist_mapping', sourceValue,
      })),
      appliedResolutions: canonicalResolutions,
    }),
    'materialization_plan',
  )
  const resolutionSetEnvelope = resolutionSetId === null ? null : await sealSource(
    command.keyring,
    dataKey,
    resolutionSetId,
    Object.freeze({
      schema: 'workbook_resolution_set.v1',
      planDigest: inspected.planDigest,
      resolutions: canonicalResolutions,
    }),
    'resolutions',
  )
  const objectKey = `workbook-objects/wbo_${command.idFactory()}_${command.idFactory()}`
  const store = command.storeArtifact ?? storeWorkbookArtifact
  await requireCurrentAuthority(command.db, command.actor)
  const descriptor = await store({
    bucket: command.bucket,
    keyring: command.keyring,
    config: command.config,
    centreId: command.centreId,
    objectKey,
    bytes: command.bytes,
    fingerprint: inspected.parsed.fingerprint,
    parserVersion: inspected.parsed.parserVersion,
    materializerVersion: inspected.parsed.materializerVersion,
    ...(command.artifactNonceFactory
      ? { nonceFactory: command.artifactNonceFactory } : {}),
  })
  const row = {
    id: importId,
    artifact_id: artifactId,
    status: 'ready',
    accepted_records: isLegacyImport ? inspected.parsed.rows.length : 0,
    quarantined_records: isLegacyImport ? inspected.parsed.quarantinedRows.length : 0,
    created_by_staff_id: command.actor.id,
    version: 1,
    created_at: now,
    updated_at: now,
    completed_at: null,
  }
  const initialProgress = JSON.stringify({
    accepted: 0,
    accountingMonthsCorrected: 0,
    candidateCount: 0,
    financeBatchId: null,
    fixedRevenuesInserted: 0,
    formulaGhostsVoided: 0,
    inserted: 0,
    linked: 0,
    quarantined: 0,
    quarantinedVoided: 0,
    specialistAssignmentsCorrected: 0,
    textAmountVisitsInserted: 0,
    voided: 0,
  })
  const statements = [
    command.db.prepare(`INSERT INTO workbook_artifacts
      (id,centre_id,environment,fingerprint,byte_size,parser_version,
       materializer_version,object_key,content_nonce_b64,workbook_kek_version,
       metadata_hmac_version,metadata_signature,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      artifactId, command.centreId, descriptor.environment, descriptor.fingerprint,
      descriptor.byteSize, descriptor.parserVersion, descriptor.materializerVersion,
      descriptor.objectKey, descriptor.contentNonce, descriptor.workbookKekVersion,
      descriptor.metadataHmacVersion, descriptor.metadataSignature, command.actor.id, now,
    ),
    command.db.prepare(`INSERT INTO workbook_templates
      (id,artifact_id,format,source_kind,created_by_staff_id,created_at)
      VALUES (?,?,?,?,?,?)`).bind(
      templateId, artifactId, inspected.panel.kind,
      inspected.panel.kind === 'panel-v2' ? 'panel_round_trip' : 'approved_import',
      command.actor.id, now,
    ),
    command.db.prepare(`INSERT INTO workbook_imports
      (id,artifact_id,preview_token_digest,status,accepted_records,quarantined_records,
       correlation_id,
       created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      importId, artifactId, tokenDigest, 'ready', row.accepted_records,
      row.quarantined_records, command.correlationId, command.actor.id, 1, now, now, null,
    ),
    command.db.prepare(`INSERT INTO workbook_import_plans
      (import_id,workbook_kind,plan_version,plan_envelope,created_at)
      VALUES (?,?,?,?,?)`).bind(
      importId, inspected.panel.kind, 1, materializationPlanEnvelope, now,
    ),
    command.db.prepare(`INSERT INTO workbook_import_plan_summaries
      (import_id,mapping_conflict_count) VALUES (?,?)`).bind(
      importId, mappingConflicts.length,
    ),
    ...sourceInsertStatements(command.db, records),
  ]
  if (resolutionSetId !== null) statements.push(command.db.prepare(
    `INSERT INTO workbook_import_resolution_sets
     (id,import_id,artifact_id,preview_token_digest,plan_digest,resolution_count,
      resolutions_envelope,created_by_staff_id,version,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    resolutionSetId, importId, artifactId, tokenDigest, inspected.planDigest,
    canonicalResolutions.length, resolutionSetEnvelope, command.actor.id, 1, now,
  ), auditEventStatement(command.db, {
    id: resolutionAuditId,
    occurredAt: now,
    actorStaffId: command.actor.id,
    action: 'workbook.resolutions.recorded',
    entityType: 'workbook_import',
    entityId: importId,
    result: 'success',
    correlationId: command.correlationId,
    metadata: { resolutionCount: canonicalResolutions.length, resolutionVersion: 1 },
    reasonEnvelope: null,
  }))
  if (quarantine.length) statements.push(valuesStatement(command.db,
    `INSERT INTO workbook_quarantine_records
     (id,source_record_id,primary_reason,reason_codes_json,created_at)
     SELECT json_extract(value,'$.id'),json_extract(value,'$.sourceRecordId'),
            json_extract(value,'$.primaryReason'),json_extract(value,'$.reasonCodesJson'),
            json_extract(value,'$.createdAt') FROM json_each(?)`, quarantine))
  if (resolutions.length) statements.push(valuesStatement(command.db,
    `INSERT INTO workbook_resolutions
     (id,import_id,source_record_id,kind,resolution_code,specialist_id,
      source_value_kind,source_value_digest,source_value_hmac_version,source_value_envelope,
      resolved_by_staff_id,created_at)
     SELECT json_extract(value,'$.id'),json_extract(value,'$.importId'),NULL,
            'specialist_mapping',json_extract(value,'$.resolutionCode'),
            json_extract(value,'$.specialistId'),json_extract(value,'$.sourceValueKind'),
            json_extract(value,'$.sourceValueDigest'),
            json_extract(value,'$.sourceValueHmacVersion'),
            json_extract(value,'$.sourceValueEnvelope'),
            json_extract(value,'$.resolvedByStaffId'),json_extract(value,'$.createdAt')
     FROM json_each(?)`, resolutions))
  statements.push(
    command.db.prepare(`INSERT INTO workbook_materialization_jobs
      (id,import_id,phase,status,cursor,total_records,processed_records,
       progress_json,created_by_staff_id,version,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      jobId, importId, isLegacyImport ? 'index_finance' : 'apply_finance', 'ready', 0,
      isLegacyImport
        ? 0
        : inspected.panelPlan.updates.length + inspected.panelPlan.voids.length,
      0, initialProgress,
      command.actor.id, 1, now, now, null,
    ),
    command.db.prepare(`INSERT INTO workbook_request_replays
      (actor_staff_id,operation,idempotency_key,request_hash,import_id,created_at)
      VALUES (?,'workbooks.import',?,?,?,?)`).bind(
      command.actor.id, command.idempotencyKey, requestHash, importId, now,
    ),
    auditEventStatement(command.db, {
      id: auditId,
      occurredAt: now,
      actorStaffId: command.actor.id,
      action: 'workbook.import.created',
      entityType: 'workbook_import',
      entityId: importId,
      result: 'success',
      correlationId: command.correlationId,
      metadata: {
        acceptedCount: row.accepted_records,
        importVersion: 1,
        quarantinedCount: row.quarantined_records,
      },
      reasonEnvelope: null,
    }),
    specialistSnapshotInvariant(command.db, specialistIds),
    authoritySnapshotInvariant(command.db, command.actor),
  )
  try {
    await command.db.batch(statements)
  } catch (error) {
    const winner = await replayRow(command.db, command.actor.id, command.idempotencyKey)
    if (winner) {
      if (winner.request_hash !== requestHash) {
        try { await command.bucket.delete(descriptor.objectKey) } catch { /* Best-effort orphan cleanup. */ }
        throw new Error('IDEMPOTENCY_CONFLICT')
      }
      const replayed = await loadImportRow(command.db, winner.import_id, command.actor.id)
      const artifact = await command.db.prepare(
        `SELECT environment,centre_id,object_key,fingerprint,byte_size,
                parser_version,materializer_version,content_nonce_b64,
                workbook_kek_version,metadata_hmac_version,metadata_signature
         FROM workbook_artifacts WHERE id=?`,
      ).bind(replayed.artifact_id).first()
      if (!artifact || artifact.fingerprint !== descriptor.fingerprint
        || artifact.byte_size !== descriptor.byteSize) throw new Error('INTERNAL_ERROR')
      const committedBytes = await readWorkbookArtifact({
        bucket: command.bucket,
        keyring: command.keyring,
        config: command.config,
        centreId: command.centreId,
        descriptor: workbookArtifactDescriptor(artifact),
      })
      committedBytes.fill(0)
      if (artifact.object_key !== descriptor.objectKey) {
        try { await command.bucket.delete(descriptor.objectKey) } catch { /* Best-effort orphan cleanup. */ }
      }
      await requireCurrentAuthority(command.db, command.actor)
      return importResponse(replayed)
    }
    try { await command.bucket.delete(descriptor.objectKey) } catch { /* Best-effort orphan cleanup. */ }
    throw error
  }
  await requireCurrentAuthority(command.db, command.actor)
  return importResponse(row, 201)
}
