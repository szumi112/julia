import { authorize } from '../identity/policy.js'
import { readBackupRecoverySnapshot } from '../operations/backup-recovery.js'
import { readWorkbookArtifact } from '../security/workbook-artifacts.js'

const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const APPROVED = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const fail = (code) => { throw new Error(code) }
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const safe = (value) => Number.isSafeInteger(value) && value >= 0
const OBJECT_LIMIT = 1_000

const authorizeOperator = async (db, actor, nowMs) => {
  if (!authorize(actor, 'finance.import', CENTRE, { nowMs })) fail('NOT_FOUND')
  const row = await db.prepare(
    `SELECT authority.revision FROM staff_users AS staff
     JOIN staff_authorities AS authority ON authority.staff_id=staff.id
     WHERE staff.id=? AND staff.role=? AND staff.specialist_id IS ?
       AND staff.version=? AND staff.status='active'`,
  ).bind(actor.id, actor.role, actor.specialistId, actor.version).first()
  if (!row || row.revision !== actor.authorityRevision) fail('NOT_FOUND')
}

export async function loadWorkbookOperatorEvidence(input) {
  if (!exact(input, ['db', 'bucket', 'actor', 'nowMs']) || !input.db?.prepare
    || typeof input.bucket?.list !== 'function'
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) fail('INTERNAL_ERROR')
  await authorizeOperator(input.db, input.actor, input.nowMs)
  let workbookObjectCount = 0
  let cursor
  const seenCursors = new Set()
  do {
    let page
    const limit = Math.min(1_000, OBJECT_LIMIT + 1 - workbookObjectCount)
    try {
      page = await input.bucket.list({
        prefix: 'workbook-objects/', limit, ...(cursor ? { cursor } : {}),
      })
    } catch { fail('INTERNAL_ERROR') }
    if (!page || !Array.isArray(page.objects) || page.objects.length > limit
      || typeof page.truncated !== 'boolean') fail('INTERNAL_ERROR')
    workbookObjectCount += page.objects.length
    if (workbookObjectCount > OBJECT_LIMIT) fail('WORKBOOK_OPERATOR_EVIDENCE_LIMIT')
    if (!page.truncated) break
    if (page.objects.length < 1 || typeof page.cursor !== 'string'
      || page.cursor.length < 1 || page.cursor.length > 2_048
      || /[\p{Cc}\p{Cf}]/u.test(page.cursor) || seenCursors.has(page.cursor)) {
      fail('INTERNAL_ERROR')
    }
    seenCursors.add(page.cursor)
    cursor = page.cursor
  } while (true)
  const row = await input.db.prepare(
    `SELECT
      (SELECT count(*) FROM workbook_artifacts) AS artifactCount,
      (SELECT count(*) FROM workbook_templates) AS templateCount,
      (SELECT count(*) FROM workbook_imports) AS importCount,
      (SELECT count(*) FROM workbook_import_plans) AS planCount,
      (SELECT count(*) FROM workbook_source_records) AS sourceRecordCount,
      (SELECT count(*) FROM workbook_quarantine_records) AS quarantineCount,
      (SELECT count(*) FROM workbook_resolutions) AS resolutionCount,
      (SELECT count(*) FROM workbook_import_resolution_sets) AS resolutionSetCount,
      (SELECT count(*) FROM workbook_materialization_jobs) AS jobCount,
      (SELECT count(*) FROM workbook_finance_candidates) AS candidateCount,
      (SELECT count(*) FROM workbook_finance_decisions) AS decisionCount,
      (SELECT count(*) FROM finance_entries) AS financeEntryCount,
      (SELECT count(*) FROM finance_source_links) AS financeLinkCount,
      (SELECT count(*) FROM historical_service_occurrences) AS historicalOccurrenceCount,
      (SELECT count(*) FROM activity_charges) AS activityChargeCount,
      (SELECT count(*) FROM historical_service_occurrences)
        + (SELECT count(*) FROM activity_source_links) AS projectionLinkCount,
      (SELECT count(*) FROM finance_entry_voids) AS workbookVoidCount,
      (SELECT count(*) FROM finance_manual_voids) AS manualVoidCount,
      (SELECT count(*) FROM workbook_finance_decisions
       WHERE action='insert') AS createdRecordCount,
      (SELECT count(*) FROM finance_entry_voids)
        + (SELECT count(*) FROM finance_manual_voids) AS voidedRecordCount,
      (SELECT count(*) FROM audit_events) AS auditEventCount,
      (SELECT count(*) FROM outbox_jobs) AS outboxMessageCount`,
  ).first()
  const keys = [
    'artifactCount', 'workbookObjectCount', 'templateCount', 'importCount',
    'planCount', 'sourceRecordCount', 'quarantineCount', 'resolutionCount',
    'resolutionSetCount', 'jobCount', 'candidateCount', 'decisionCount',
    'financeEntryCount', 'financeLinkCount', 'historicalOccurrenceCount',
    'activityChargeCount', 'projectionLinkCount', 'workbookVoidCount',
    'manualVoidCount', 'createdRecordCount', 'voidedRecordCount',
    'auditEventCount', 'outboxMessageCount',
  ]
  if (!row) fail('INTERNAL_ERROR')
  row.workbookObjectCount = workbookObjectCount
  if (keys.some((key) => !safe(row[key]))) fail('INTERNAL_ERROR')
  await authorizeOperator(input.db, input.actor, input.nowMs)
  return Object.freeze({ data: Object.freeze(Object.fromEntries(
    keys.map((key) => [key, row[key]]),
  )) })
}

const artifactDescriptor = (row) => Object.freeze({
  environment: row.environment, centreId: row.centre_id, objectKey: row.object_key,
  fingerprint: row.fingerprint, byteSize: row.byte_size,
  parserVersion: row.parser_version, materializerVersion: row.materializer_version,
  contentNonce: row.content_nonce_b64, workbookKekVersion: row.workbook_kek_version,
  metadataHmacVersion: row.metadata_hmac_version,
  metadataSignature: row.metadata_signature,
})

export async function verifyWorkbookImportArtifact(input) {
  const keys = ['db', 'bucket', 'actor', 'keyring', 'config', 'nowMs', 'importId']
  if (!exact(input, keys) || !input.db?.prepare || !input.keyring
    || !IMPORT_ID.test(input.importId ?? '')
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) fail('INTERNAL_ERROR')
  await authorizeOperator(input.db, input.actor, input.nowMs)
  const row = await input.db.prepare(
    `SELECT artifact.* FROM workbook_artifacts AS artifact
     JOIN workbook_imports AS import ON import.artifact_id=artifact.id
     WHERE import.id=? AND import.created_by_staff_id=?`,
  ).bind(input.importId, input.actor.id).first()
  if (!row) fail('NOT_FOUND')
  let bytes
  try {
    bytes = await readWorkbookArtifact({
      bucket: input.bucket, keyring: input.keyring, config: input.config,
      centreId: 'centre_1', descriptor: artifactDescriptor(row),
    })
    await authorizeOperator(input.db, input.actor, input.nowMs)
    return Object.freeze({ data: Object.freeze({
      artifactId: row.id,
      environmentMatch: row.environment === input.config.appEnv,
      centreMatch: row.centre_id === 'centre_1',
      opaqueObjectKey: /^workbook-objects\/wbo_[A-Za-z0-9_-]{16,180}$/.test(row.object_key),
      ciphertextMetadataValid: true,
      digestMatch: row.fingerprint === APPROVED,
      sizeMatch: bytes.byteLength === row.byte_size,
      keyVersionsMatch: row.workbook_kek_version === input.config.activeWorkbookKekVersion
        && row.metadata_hmac_version === input.config.activeWorkbookHmacVersion,
      readbackDigestMatch: true,
    }) })
  } finally {
    bytes?.fill(0)
  }
}

export async function loadWorkbookReconciliationEvidence(input) {
  if (!exact(input, ['db', 'actor', 'nowMs', 'importId']) || !input.db?.prepare
    || !IMPORT_ID.test(input.importId ?? '')
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) fail('INTERNAL_ERROR')
  await authorizeOperator(input.db, input.actor, input.nowMs)
  const imported = await input.db.prepare(
    `SELECT id FROM workbook_imports WHERE id=? AND created_by_staff_id=?`,
  ).bind(input.importId, input.actor.id).first()
  if (!imported || imported.id !== input.importId) fail('NOT_FOUND')
  let snapshot
  try { snapshot = await readBackupRecoverySnapshot(input.db) } catch {
    await authorizeOperator(input.db, input.actor, input.nowMs)
    fail('INTERNAL_ERROR')
  }
  const facts = snapshot?.recoveryFacts
  if (!facts || facts.kind !== 'workbook_roundtrip_v1'
    || facts.import?.id !== input.importId || facts.artifact?.fingerprint !== APPROVED) {
    fail('NOT_FOUND')
  }
  await authorizeOperator(input.db, input.actor, input.nowMs)
  return Object.freeze({ data: facts })
}
