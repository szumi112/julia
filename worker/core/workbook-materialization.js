import { auditEventStatement } from '../audit/events.js'
import {
  decryptForScope,
  encryptForScope,
  loadDataKey,
} from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'
import { compareUtf16CodeUnits } from '../../src/code-unit-order.js'
import {
  invalidPanelFinanceField,
  normalizePanelFinanceEdits,
  prospectivePanelFinanceValues,
} from './workbook-panel-finance.js'
import {
  loadAuthenticatedWorkbookSpecialistMappings,
  openAuthenticatedWorkbookSource,
  resolveAuthenticatedWorkbookSpecialist,
  WORKBOOK_SOURCE_SCOPE,
} from './workbook-source-registry.js'
import { authorize } from '../identity/policy.js'
import { resolveCurrentAuthorityActor } from '../identity/staff.js'
import { digestWorkbookSourceValue } from '../security/workbook-artifacts.js'
import { parseWorkbookMaterializationProgress } from './workbook-materialization-progress.js'

export const WORKBOOK_MATERIALIZATION_SLICE_SIZE = 64

const APPROVED = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const SOURCE_SCOPE = WORKBOOK_SOURCE_SCOPE
const FINANCE_SCOPE = Object.freeze({
  type: 'centre_finance', id: 'centre_1', purpose: 'ledger',
})
const CENTRE_RESOURCE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SOURCE_KEY = /^workbook:v1:\d{1,4}:\d{1,7}:\d{1,5}$/
const fail = (code = 'WORKBOOK_MATERIALIZATION_INVALID') => { throw new Error(code) }
const instant = (nowMs) => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail()
  try { return new Date(nowMs).toISOString() } catch { fail() }
}
const generated = (factory, prefix, pattern) => {
  let value
  try { value = `${prefix}_${factory()}` } catch { fail() }
  if (!pattern.test(value)) fail()
  return value
}
const sha256Base64 = async (value) => encodeBase64Url(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(value),
))
const jsonStatement = (db, sql, values) => db.prepare(sql).bind(JSON.stringify(values))
const invariant = (db, predicate, ...bindings) => db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'workbook_materialization_postcondition' WHERE NOT (${predicate})`,
).bind(...bindings)

const authorityInvariant = (db, actor) => invariant(
  db,
  `EXISTS (
    SELECT 1 FROM staff_users AS staff
    JOIN staff_authorities AS authority ON authority.staff_id=staff.id
    WHERE staff.id=? AND staff.role=? AND staff.specialist_id IS ?
      AND staff.version=? AND staff.status='active' AND authority.revision=?
  )`,
  actor.id,
  actor.role,
  actor.specialistId,
  actor.version,
  actor.authorityRevision,
)

const specialistInvariant = (db, specialistIds) => invariant(
  db,
  `(SELECT count(*) FROM specialists AS specialist
    JOIN json_each(?) AS selected ON selected.value=specialist.id
    WHERE specialist.status='active')=?`,
  JSON.stringify(specialistIds),
  specialistIds.length,
)

const panelDependencyIds = async (db, ids) => {
  if (!ids.length) return new Set()
  const rows = (await db.prepare(
    `SELECT requested.value AS id FROM json_each(?) AS requested
     WHERE EXISTS (
       SELECT 1 FROM activity_charges AS charge
       WHERE charge.finance_entry_id=requested.value AND charge.status='active'
     ) OR EXISTS (
       SELECT 1 FROM finance_source_links AS source_link
       JOIN historical_service_occurrences AS occurrence
         ON occurrence.source_record_id=source_link.source_record_id
        AND occurrence.status='recorded'
       WHERE source_link.finance_entry_id=requested.value
     ) ORDER BY requested.value`,
  ).bind(JSON.stringify(ids)).all()).results
  if (!Array.isArray(rows)) fail('WORKBOOK_IMPORT_CONFLICT')
  return new Set(rows.map(({ id }) => id))
}

const panelDependencyInvariant = (db, ids) => invariant(
  db,
  `NOT EXISTS (
    SELECT 1 FROM json_each(?) AS requested
    WHERE EXISTS (
      SELECT 1 FROM activity_charges AS charge
      WHERE charge.finance_entry_id=requested.value AND charge.status='active'
    ) OR EXISTS (
      SELECT 1 FROM finance_source_links AS source_link
      JOIN historical_service_occurrences AS occurrence
        ON occurrence.source_record_id=source_link.source_record_id
       AND occurrence.status='recorded'
      WHERE source_link.finance_entry_id=requested.value
    )
  )`,
  JSON.stringify(ids),
)

const requireCurrentAuthority = async (db, actor) => {
  let current
  try {
    current = await resolveCurrentAuthorityActor(db, {
      id: actor.id,
      role: actor.role,
      specialist_id: actor.specialistId,
      version: actor.version,
    })
  } catch { fail('NOT_FOUND') }
  if (current.authorityRevision !== actor.authorityRevision
    || current.capabilities.length !== actor.capabilities.length
    || current.capabilities.some((capability, index) => (
      capability !== actor.capabilities[index]
    ))) fail('NOT_FOUND')
}

const requireActiveSpecialists = async (db, specialistIds) => {
  if (!specialistIds.length) return
  const active = (await db.prepare(
    `SELECT id FROM specialists WHERE id IN (${specialistIds.map(() => '?').join(',')})
     AND status='active' ORDER BY id`,
  ).bind(...specialistIds).all()).results
  if (!Array.isArray(active) || active.length !== specialistIds.length) fail('NOT_FOUND')
}

const parseJson = (value, code = 'WORKBOOK_MATERIALIZATION_INVALID') => {
  try { return JSON.parse(value) } catch { fail(code) }
}

const importDto = (row) => Object.freeze({
  id: row.import_id,
  artifactId: row.artifact_id,
  status: row.import_status,
  acceptedRecords: row.accepted_records,
  quarantinedRecords: row.quarantined_records,
  createdByStaffId: row.created_by_staff_id,
  version: row.import_version,
  createdAt: row.import_created_at,
  updatedAt: row.import_updated_at,
  completedAt: row.import_completed_at,
})

const jobDto = (row) => Object.freeze({
  id: row.job_id,
  phase: row.phase,
  status: row.job_status,
  cursor: row.cursor,
  totalRecords: row.total_records,
  processedRecords: row.processed_records,
  version: row.job_version,
  updatedAt: row.job_updated_at,
  completedAt: row.job_completed_at,
})

const responseFrom = (row, status = 200) => {
  const progress = parseWorkbookMaterializationProgress(row.progress_json)
  const data = {
    import: importDto(row),
    job: jobDto(row),
    evidence: Object.freeze({
      createdRecords: progress.inserted,
      voidedRecords: progress.voided,
      converged: row.import_status === 'complete' && row.job_status === 'complete',
    }),
  }
  if (row.summary_json !== null) data.reconciliation = Object.freeze(parseJson(row.summary_json))
  return Object.freeze({ status, body: Object.freeze({ data: Object.freeze(data) }) })
}

const loadState = async (db, importId, actorId) => {
  const row = await db.prepare(
    `SELECT import.id AS import_id,import.artifact_id,import.status AS import_status,
            import.accepted_records,import.quarantined_records,
            import.created_by_staff_id,import.version AS import_version,
            import.created_at AS import_created_at,import.updated_at AS import_updated_at,
            import.completed_at AS import_completed_at,
            job.id AS job_id,job.phase,job.status AS job_status,job.cursor,
            job.total_records,job.processed_records,job.progress_json,job.summary_json,
            job.created_by_staff_id AS job_created_by_staff_id,
            job.version AS job_version,job.updated_at AS job_updated_at,
            job.completed_at AS job_completed_at,
            plan.workbook_kind,plan.plan_version,plan.plan_envelope,
            artifact.fingerprint
     FROM workbook_imports AS import
     JOIN workbook_materialization_jobs AS job ON job.import_id=import.id
     JOIN workbook_import_plans AS plan ON plan.import_id=import.id
     JOIN workbook_artifacts AS artifact ON artifact.id=import.artifact_id
     WHERE import.id=? AND import.created_by_staff_id=?`,
  ).bind(importId, actorId).first()
  if (!row || row.job_created_by_staff_id !== row.created_by_staff_id) fail('NOT_FOUND')
  parseWorkbookMaterializationProgress(row.progress_json)
  return row
}

const loadPlan = async (db, keyring, row, config, centreId) => {
  const envelope = parseJson(row.plan_envelope, 'CRYPTO_FAILURE')
  const dataKey = await loadDataKey(db, { envelope, expectedScope: SOURCE_SCOPE })
  let plan
  try {
    plan = JSON.parse(await decryptForScope(keyring, dataKey, {
      expectedScope: SOURCE_SCOPE,
      recordId: row.import_id,
      field: 'materialization_plan',
      envelope,
    }))
  } catch { fail('CRYPTO_FAILURE') }
  const conflicts = plan?.conflicts ?? []
  const appliedResolutions = plan?.appliedResolutions ?? []
  if (!plan || plan.schema !== 'workbook_import_plan.v1'
    || plan.workbookKind !== row.workbook_kind
    || typeof plan.previewPlanDigest !== 'string'
    || !/^v[1-9]\d*_[A-Za-z0-9_-]{43}$/.test(plan.previewPlanDigest)
    || !plan.panel || !Array.isArray(plan.panel.updates) || !Array.isArray(plan.panel.voids)
    || !Array.isArray(conflicts) || conflicts.length > 100
    || !Array.isArray(appliedResolutions) || appliedResolutions.length > 100) fail()
  const resolutionMappings = []
  let resolutionIdentity = null
  if (conflicts.length) {
    const latest = await db.prepare(
      `SELECT id,version,plan_digest,resolutions_envelope
       FROM workbook_import_resolution_sets WHERE import_id=?
       ORDER BY version DESC LIMIT 1`,
    ).bind(row.import_id).first()
    if (!latest || latest.plan_digest !== plan.previewPlanDigest) fail()
    resolutionIdentity = Object.freeze({
      id: latest.id, version: latest.version, planDigest: latest.plan_digest,
      envelope: latest.resolutions_envelope,
    })
    let set
    try {
      set = JSON.parse(await decryptForScope(keyring, dataKey, {
        expectedScope: SOURCE_SCOPE, recordId: latest.id, field: 'resolutions',
        envelope: parseJson(latest.resolutions_envelope, 'CRYPTO_FAILURE'),
      }))
    } catch { fail('CRYPTO_FAILURE') }
    if (!set || set.schema !== 'workbook_resolution_set.v1'
      || set.planDigest !== plan.previewPlanDigest || !Array.isArray(set.resolutions)
      || set.resolutions.length !== conflicts.length) fail()
    const conflictCatalog = new Map()
    for (const conflict of conflicts) {
      if (!conflict || typeof conflict !== 'object' || Array.isArray(conflict)
        || conflict.kind !== 'specialist_mapping'
        || typeof conflict.id !== 'string' || typeof conflict.sourceValue !== 'string'
        || conflictCatalog.has(conflict.id)) fail()
      conflictCatalog.set(conflict.id, conflict)
    }
    const specialistIds = new Set()
    for (const resolution of set.resolutions) {
      const conflict = conflictCatalog.get(resolution?.conflictId)
      if (!conflict || typeof resolution.specialistId !== 'string'
        || !/^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(resolution.specialistId)
        || resolutionMappings.some(({ conflictId }) => conflict.id === conflictId)) fail()
      specialistIds.add(resolution.specialistId)
      const sourceValueKind = conflict.sourceValue === '' ? 'blank' : 'explicit_name'
      const provenance = await digestWorkbookSourceValue({
        keyring, config, centreId,
        sourceValueKind, sourceValue: conflict.sourceValue,
      })
      resolutionMappings.push(Object.freeze({
        conflictId: conflict.id,
        sourceValue: conflict.sourceValue,
        sourceValueKind,
        digest: provenance.digest,
        hmacVersion: provenance.hmacVersion,
        specialistId: resolution.specialistId,
      }))
    }
    resolutionIdentity = Object.freeze({
      ...resolutionIdentity,
      specialistIds: Object.freeze([...specialistIds].sort(compareUtf16CodeUnits)),
    })
  }
  const initialMappings = await loadAuthenticatedWorkbookSpecialistMappings({
    db, keyring, dataKey, importId: row.import_id, config, centreId,
  })
  const effectiveMappings = new Map(initialMappings.bySourceValue)
  for (const mapping of resolutionMappings) effectiveMappings.set(mapping.sourceValue, mapping)
  const specialistIds = [...new Set([...effectiveMappings.values()]
    .map(({ specialistId }) => specialistId))].sort(compareUtf16CodeUnits)
  return Object.freeze({
    dataKey, plan, resolutionMappings: Object.freeze(resolutionMappings), resolutionIdentity,
    specialistIds: Object.freeze(specialistIds), initialMappings,
  })
}

const replayRow = (db, actorId, idempotencyKey) => db.prepare(
  `SELECT request_hash FROM workbook_request_replays
   WHERE actor_staff_id=? AND operation='workbooks.continue' AND idempotency_key=?`,
).bind(actorId, idempotencyKey).first()

const replayStatement = (db, command, requestHash, now) => db.prepare(
  `INSERT INTO workbook_request_replays
   (actor_staff_id,operation,idempotency_key,request_hash,import_id,created_at)
   VALUES (?,'workbooks.continue',?,?,?,?)`,
).bind(command.actor.id, command.idempotencyKey, requestHash, command.importId, now)

const financeOpen = async (keyring, dataKey, recordId, field, serialized) => {
  try {
    return JSON.parse(await decryptForScope(keyring, dataKey, {
      expectedScope: FINANCE_SCOPE,
      recordId,
      field,
      envelope: parseJson(serialized, 'CRYPTO_FAILURE'),
    }))
  } catch { fail('CRYPTO_FAILURE') }
}

const financeSeal = async (keyring, dataKey, recordId, field, value) => JSON.stringify(
  await encryptForScope(keyring, dataKey, {
    expectedScope: FINANCE_SCOPE,
    recordId,
    field,
    plaintext: JSON.stringify(value),
  }),
)

const loadFinanceKey = async (db) => {
  const row = await db.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,
            wrap_nonce_b64,kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1`,
  ).bind(FINANCE_SCOPE.type, FINANCE_SCOPE.id, FINANCE_SCOPE.purpose).first()
  if (!row) fail('CRYPTO_FAILURE')
  return row
}

const exactApprovedProgress = (progress) => (
  progress.accepted === 2_232
  && progress.quarantined === 3
  && progress.candidateCount === 2_234
  && progress.linked === 2_232
  && progress.voided === 7
  && progress.inserted === 5
  && progress.accountingMonthsCorrected === 45
  && progress.specialistAssignmentsCorrected === 2_227
  && progress.fixedRevenuesInserted === 3
  && progress.formulaGhostsVoided === 5
  && progress.quarantinedVoided === 2
  && progress.textAmountVisitsInserted === 2
)

const summaryFrom = (progress) => Object.freeze({
  accepted: progress.accepted,
  quarantined: progress.quarantined,
  linked: progress.linked,
  voided: progress.voided,
  inserted: progress.inserted,
  accountingMonthsCorrected: progress.accountingMonthsCorrected,
  specialistAssignmentsCorrected: progress.specialistAssignmentsCorrected,
  fixedRevenuesInserted: progress.fixedRevenuesInserted,
  formulaGhostsVoided: progress.formulaGhostsVoided,
  quarantinedVoided: progress.quarantinedVoided,
  textAmountVisitsInserted: progress.textAmountVisitsInserted,
})

const persistSlice = async ({
  command,
  state,
  domainStatements,
  phase,
  cursor,
  totalRecords,
  progress,
  requestHash,
  now,
  complete = false,
}) => {
  const activeSpecialistIds = [...new Set([
    ...state.resolution_specialist_ids,
    ...(state.mutation_specialist_ids ?? []),
  ])].sort(compareUtf16CodeUnits)
  const nextJobVersion = state.job_version + 1
  const summary = complete ? summaryFrom(progress) : null
  const statements = [...domainStatements]
  let nextImportVersion = state.import_version
  let nextImportStatus = state.import_status
  if (complete) {
    if (!['ready', 'materializing'].includes(state.import_status)) fail('VERSION_CONFLICT')
    nextImportVersion += 1
    nextImportStatus = 'complete'
    statements.push(command.db.prepare(
      `UPDATE workbook_imports SET status='complete',version=?,updated_at=?,completed_at=?
       WHERE id=? AND created_by_staff_id=? AND status=? AND version=?`,
    ).bind(
      nextImportVersion, now, now, command.importId, command.actor.id,
      state.import_status, state.import_version,
    ))
  } else if (state.import_status === 'ready') {
    nextImportVersion += 1
    nextImportStatus = 'materializing'
    statements.push(command.db.prepare(
      `UPDATE workbook_imports SET status='materializing',version=?,updated_at=?
       WHERE id=? AND created_by_staff_id=? AND status='ready' AND version=?`,
    ).bind(nextImportVersion, now, command.importId, command.actor.id, state.import_version))
  } else if (state.import_status !== 'materializing') fail('VERSION_CONFLICT')

  statements.push(command.db.prepare(
    `UPDATE workbook_materialization_jobs
     SET phase=?,status=?,cursor=?,total_records=?,processed_records=?,progress_json=?,
         summary_json=?,version=?,updated_at=?,completed_at=?
     WHERE id=? AND import_id=? AND phase=? AND status IN ('ready','running')
       AND cursor=? AND version=?`,
  ).bind(
    complete ? 'complete' : phase,
    complete ? 'complete' : 'running',
    complete ? totalRecords : cursor,
    totalRecords,
    complete ? totalRecords : cursor,
    JSON.stringify(progress),
    complete ? JSON.stringify(summary) : null,
    nextJobVersion,
    now,
    complete ? now : null,
    state.job_id,
    command.importId,
    state.phase,
    state.cursor,
    state.job_version,
  ))
  statements.push(replayStatement(command.db, command, requestHash, now))
  if (complete) {
    const auditId = generated(command.idFactory, 'aud', /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
    statements.push(auditEventStatement(command.db, {
      id: auditId,
      occurredAt: now,
      actorStaffId: command.actor.id,
      action: 'workbook.import.materialized',
      entityType: 'workbook_import',
      entityId: command.importId,
      result: 'success',
      correlationId: command.correlationId,
      metadata: {
        accountingMonthsCorrected: summary.accountingMonthsCorrected,
        importVersion: nextImportVersion,
        insertedCount: summary.inserted,
        linkedCount: summary.linked,
        voidedCount: summary.voided,
      },
      reasonEnvelope: null,
    }))
  }
  statements.push(invariant(
    command.db,
    `EXISTS (SELECT 1 FROM workbook_materialization_jobs
      WHERE id=? AND version=? AND phase=? AND cursor=? AND status=?)
     AND EXISTS (SELECT 1 FROM workbook_imports
      WHERE id=? AND version=? AND status=?)
     AND ((? IS NULL AND NOT EXISTS (
       SELECT 1 FROM workbook_import_resolution_sets WHERE import_id=?
     )) OR EXISTS (
       SELECT 1 FROM workbook_import_resolution_sets resolution
       WHERE resolution.import_id=? AND resolution.id=? AND resolution.version=?
         AND NOT EXISTS (SELECT 1 FROM workbook_import_resolution_sets newer
           WHERE newer.import_id=resolution.import_id AND newer.version>resolution.version)
     ))`,
    state.job_id,
    nextJobVersion,
    complete ? 'complete' : phase,
    complete ? totalRecords : cursor,
    complete ? 'complete' : 'running',
    command.importId,
    nextImportVersion,
    nextImportStatus,
    state.resolution_identity?.id ?? null,
    command.importId,
    command.importId,
    state.resolution_identity?.id ?? null,
    state.resolution_identity?.version ?? null,
  ))
  statements.push(authorityInvariant(command.db, command.actor))
  if (activeSpecialistIds.length) {
    statements.push(specialistInvariant(command.db, activeSpecialistIds))
  }
  if (state.mutation_dependency_ids?.length) {
    statements.push(panelDependencyInvariant(command.db, state.mutation_dependency_ids))
  }
  try {
    await command.db.batch(statements)
  } catch (error) {
    if (state.mutation_dependency_ids?.length
      && (await panelDependencyIds(command.db, state.mutation_dependency_ids)).size) {
      fail('WORKBOOK_IMPORT_CONFLICT')
    }
    throw error
  }
  const current = await loadState(command.db, command.importId, command.actor.id)
  await requireCurrentAuthority(command.db, command.actor)
  await requireActiveSpecialists(command.db, activeSpecialistIds)
  return responseFrom(current)
}

const indexFinanceSlice = async (command, state, progress, requestHash, now) => {
  if (state.fingerprint !== APPROVED || state.workbook_kind !== 'legacy') {
    fail('WORKBOOK_FINGERPRINT_REJECTED')
  }
  if (state.accepted_records !== 2_232 || state.quarantined_records !== 3) {
    fail('WORKBOOK_RECONCILIATION_CONFLICT')
  }
  let total = state.total_records
  if (progress.financeBatchId === null) {
    const batches = (await command.db.prepare(
      `SELECT id FROM finance_import_batches
       WHERE fingerprint=? AND status='committed' ORDER BY id LIMIT 2`,
    ).bind(APPROVED).all()).results
    if (!Array.isArray(batches) || batches.length !== 1) fail('WORKBOOK_RECONCILIATION_CONFLICT')
    progress.financeBatchId = batches[0].id
    total = (await command.db.prepare(
      `SELECT count(*) AS count FROM finance_entries AS entry
       LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
       LEFT JOIN finance_manual_voids AS manual_void
         ON manual_void.finance_entry_id=entry.id
       WHERE entry.batch_id=? AND void.id IS NULL AND manual_void.id IS NULL`,
    ).bind(progress.financeBatchId).first()).count
    if (total !== 2_234) fail('WORKBOOK_RECONCILIATION_CONFLICT')
    progress.candidateCount = total
  }
  const rows = (await command.db.prepare(
    `SELECT entry.id,entry.accounting_month,entry.specialist_id,entry.version,
            entry.source_row_envelope
     FROM finance_entries AS entry
     LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
     LEFT JOIN finance_manual_voids AS manual_void
       ON manual_void.finance_entry_id=entry.id
     WHERE entry.batch_id=? AND void.id IS NULL AND manual_void.id IS NULL
     ORDER BY entry.id LIMIT ? OFFSET ?`,
  ).bind(
    progress.financeBatchId, WORKBOOK_MATERIALIZATION_SLICE_SIZE, state.cursor,
  ).all()).results
  if (!Array.isArray(rows) || !rows.length) fail('WORKBOOK_RECONCILIATION_CONFLICT')
  const financeKey = await loadFinanceKey(command.db)
  const candidates = []
  for (const row of rows) {
    const source = await financeOpen(
      command.keyring, financeKey, row.id, 'source_row', row.source_row_envelope,
    )
    if (source?.schema !== 'finance_entry_source.v1'
      || typeof source.source?.sourceKey !== 'string'
      || !SOURCE_KEY.test(source.source.sourceKey)) fail('CRYPTO_FAILURE')
    candidates.push({
      id: generated(command.idFactory, 'wfc', /^wfc_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
      importId: command.importId,
      financeEntryId: row.id,
      sourceKey: source.source.sourceKey,
      accountingMonth: row.accounting_month,
      specialistId: row.specialist_id,
      financeVersion: row.version,
      createdAt: now,
    })
  }
  const statements = [jsonStatement(command.db,
    `INSERT INTO workbook_finance_candidates
     (id,import_id,finance_entry_id,source_key,accounting_month,specialist_id,
      finance_version,created_at)
     SELECT json_extract(value,'$.id'),json_extract(value,'$.importId'),
            json_extract(value,'$.financeEntryId'),json_extract(value,'$.sourceKey'),
            json_extract(value,'$.accountingMonth'),json_extract(value,'$.specialistId'),
            json_extract(value,'$.financeVersion'),json_extract(value,'$.createdAt')
     FROM json_each(?)`, candidates)]
  const nextCursor = state.cursor + rows.length
  const finished = nextCursor === total
  return persistSlice({
    command,
    state,
    domainStatements: statements,
    phase: finished ? 'reconcile_sources' : 'index_finance',
    cursor: finished ? 0 : nextCursor,
    totalRecords: finished
      ? state.accepted_records + state.quarantined_records
      : total,
    progress,
    requestHash,
    now,
  })
}

const reconcileSourceSlice = async (
  command, state, progress, sourceKeyRow, initialMappings, resolutionMappings, requestHash, now,
) => {
  const rows = (await command.db.prepare(
    `SELECT source.id AS source_record_id,source.source_key,source.sheet_name,
            source.row_number,source.record_type,source.disposition,
            source.occurred_on,source.period_precision,source.period_month,
            source.record_digest,source.record_digest_hmac_version,
            source.specialist_source_digest,source.specialist_source_hmac_version,
            source.source_payload_envelope,quarantine.primary_reason
     FROM workbook_source_records AS source
     LEFT JOIN workbook_quarantine_records AS quarantine
       ON quarantine.source_record_id=source.id
     WHERE source.import_id=? ORDER BY source.source_key
     LIMIT ? OFFSET ?`,
  ).bind(command.importId, WORKBOOK_MATERIALIZATION_SLICE_SIZE, state.cursor).all()).results
  if (!Array.isArray(rows) || !rows.length) fail('WORKBOOK_RECONCILIATION_CONFLICT')
  const bySourceValue = new Map(initialMappings.bySourceValue)
  const byDigest = new Map(initialMappings.byDigest)
  for (const mapping of resolutionMappings) {
    const prior = bySourceValue.get(mapping.sourceValue)
    if (prior) byDigest.delete(`${prior.hmacVersion}:${prior.digest}`)
    bySourceValue.set(mapping.sourceValue, mapping)
    byDigest.set(`${mapping.hmacVersion}:${mapping.digest}`, mapping)
  }
  const mappings = Object.freeze({ bySourceValue, byDigest })
  const keys = rows.map(({ source_key: key }) => key)
  const candidates = (await command.db.prepare(
    `SELECT id,finance_entry_id,source_key,accounting_month,specialist_id,
            finance_version FROM workbook_finance_candidates
     WHERE import_id=? AND source_key IN (${keys.map(() => '?').join(',')})`,
  ).bind(command.importId, ...keys).all()).results
  if (!Array.isArray(candidates)) fail()
  const bySource = new Map(candidates.map((row) => [row.source_key, row]))
  const decisions = []
  for (const source of rows) {
    const payload = await openAuthenticatedWorkbookSource({
      keyring: command.keyring, dataKey: sourceKeyRow, row: source,
      config: command.config, centreId: command.centreId,
    })
    const row = payload.normalized
    const candidate = bySource.get(source.source_key)
    if (source.disposition === 'accepted') {
      progress.accepted += 1
      progress.linked += 1
      const specialistId = await resolveAuthenticatedWorkbookSpecialist({
        keyring: command.keyring, config: command.config, centreId: command.centreId,
        mappings, row: source, payload,
      })
      if (candidate) {
        const accountingMonthChanged = candidate.accounting_month !== row.accountingMonth
        const specialistChanged = candidate.specialist_id !== specialistId
        if (accountingMonthChanged) progress.accountingMonthsCorrected += 1
        if (specialistChanged) progress.specialistAssignmentsCorrected += 1
        decisions.push({
          id: generated(command.idFactory, 'wfd', /^wfd_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
          importId: command.importId,
          sourceRecordId: source.source_record_id,
          financeEntryId: candidate.finance_entry_id,
          action: 'link_update',
          reasonCode: null,
          targetAccountingMonth: row.accountingMonth,
          targetSpecialistId: specialistId,
          expectedFinanceVersion: candidate.finance_version,
          accountingMonthChanged: accountingMonthChanged ? 1 : 0,
          specialistChanged: specialistChanged ? 1 : 0,
          createdAt: now,
        })
      } else {
        progress.inserted += 1
        if (row.recordType === 'income' && row.sheet === 'Stałe koszty') {
          progress.fixedRevenuesInserted += 1
        }
        if (row.recordType === 'income'
          && Array.isArray(row.warningCodes)
          && row.warningCodes.includes('AMOUNT_STORED_AS_TEXT')) {
          progress.textAmountVisitsInserted += 1
        }
        decisions.push({
          id: generated(command.idFactory, 'wfd', /^wfd_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
          importId: command.importId,
          sourceRecordId: source.source_record_id,
          financeEntryId: null,
          action: 'insert',
          reasonCode: null,
          targetAccountingMonth: row.accountingMonth,
          targetSpecialistId: specialistId,
          expectedFinanceVersion: null,
          accountingMonthChanged: 0,
          specialistChanged: 0,
          createdAt: now,
        })
      }
    } else if (source.disposition === 'quarantined') {
      progress.quarantined += 1
      if (candidate) {
        progress.voided += 1
        progress.quarantinedVoided += 1
        decisions.push({
          id: generated(command.idFactory, 'wfd', /^wfd_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
          importId: command.importId,
          sourceRecordId: source.source_record_id,
          financeEntryId: candidate.finance_entry_id,
          action: 'void',
          reasonCode: 'quarantined',
          targetAccountingMonth: null,
          targetSpecialistId: null,
          expectedFinanceVersion: candidate.finance_version,
          accountingMonthChanged: 0,
          specialistChanged: 0,
          createdAt: now,
        })
      }
    } else fail('CRYPTO_FAILURE')
  }
  const statements = decisions.length ? [decisionInsert(command.db, decisions)] : []
  const nextCursor = state.cursor + rows.length
  const finished = nextCursor === state.total_records
  return persistSlice({
    command,
    state,
    domainStatements: statements,
    phase: finished ? 'reconcile_unmatched' : 'reconcile_sources',
    cursor: finished ? 0 : nextCursor,
    totalRecords: finished ? progress.candidateCount : state.total_records,
    progress,
    requestHash,
    now,
  })
}

const decisionInsert = (db, decisions) => jsonStatement(db,
  `INSERT INTO workbook_finance_decisions
   (id,import_id,source_record_id,finance_entry_id,action,reason_code,
    target_accounting_month,target_specialist_id,expected_finance_version,
    accounting_month_changed,specialist_changed,created_at)
   SELECT json_extract(value,'$.id'),json_extract(value,'$.importId'),
          json_extract(value,'$.sourceRecordId'),json_extract(value,'$.financeEntryId'),
          json_extract(value,'$.action'),json_extract(value,'$.reasonCode'),
          json_extract(value,'$.targetAccountingMonth'),
          json_extract(value,'$.targetSpecialistId'),
          json_extract(value,'$.expectedFinanceVersion'),
          json_extract(value,'$.accountingMonthChanged'),
          json_extract(value,'$.specialistChanged'),json_extract(value,'$.createdAt')
   FROM json_each(?)`, decisions)

const reconcileUnmatchedSlice = async (command, state, progress, requestHash, now) => {
  const rows = (await command.db.prepare(
    `SELECT candidate.finance_entry_id,candidate.finance_version
     FROM workbook_finance_candidates AS candidate
     WHERE candidate.import_id=? AND NOT EXISTS (
       SELECT 1 FROM workbook_finance_decisions AS decision
       WHERE decision.import_id=candidate.import_id
         AND decision.finance_entry_id=candidate.finance_entry_id)
     ORDER BY candidate.id LIMIT ?`,
  ).bind(command.importId, WORKBOOK_MATERIALIZATION_SLICE_SIZE).all()).results
  if (!Array.isArray(rows)) fail()
  const decisions = rows.map((row) => ({
    id: generated(command.idFactory, 'wfd', /^wfd_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
    importId: command.importId,
    sourceRecordId: null,
    financeEntryId: row.finance_entry_id,
    action: 'void',
    reasonCode: 'formula_cache',
    targetAccountingMonth: null,
    targetSpecialistId: null,
    expectedFinanceVersion: row.finance_version,
    accountingMonthChanged: 0,
    specialistChanged: 0,
    createdAt: now,
  }))
  progress.formulaGhostsVoided += decisions.length
  progress.voided += decisions.length
  const remainingAfter = rows.length === WORKBOOK_MATERIALIZATION_SLICE_SIZE
  const statements = decisions.length ? [decisionInsert(command.db, decisions)] : []
  if (remainingAfter) return persistSlice({
    command,
    state,
    domainStatements: statements,
    phase: 'reconcile_unmatched',
    cursor: state.cursor + rows.length,
    totalRecords: state.total_records,
    progress,
    requestHash,
    now,
  })
  if (!exactApprovedProgress(progress)) fail('WORKBOOK_RECONCILIATION_CONFLICT')
  const decisionCount = (await command.db.prepare(
    'SELECT count(*) AS count FROM workbook_finance_decisions WHERE import_id=?',
  ).bind(command.importId).first()).count + decisions.length
  if (decisionCount !== 2_239) fail('WORKBOOK_RECONCILIATION_CONFLICT')
  return persistSlice({
    command,
    state,
    domainStatements: statements,
    phase: 'apply_finance',
    cursor: 0,
    totalRecords: decisionCount,
    progress,
    requestHash,
    now,
  })
}

const paidAmountFor = (row) => row.settlementStatus === 'paid'
  ? row.amountGrosze
  : row.settlementStatus === 'partial'
    ? Math.max(1, Math.min(row.amountGrosze - 1, Math.floor(row.amountGrosze / 2)))
    : 0

const applyLegacySlice = async (command, state, progress, sourceKeyRow, requestHash, now) => {
  const rows = (await command.db.prepare(
    `SELECT decision.id,decision.source_record_id,decision.finance_entry_id,
            decision.action,decision.reason_code,decision.target_accounting_month,
            decision.target_specialist_id,decision.expected_finance_version,
            decision.accounting_month_changed,decision.specialist_changed,
            source.source_key,source.sheet_name,source.row_number,source.record_type,
            source.occurred_on,source.period_precision,source.period_month,
            source.record_digest,source.record_digest_hmac_version,
            source.source_payload_envelope,
            entry.accounting_month AS current_accounting_month,
            entry.specialist_id AS current_specialist_id,entry.version AS current_version,
            entry.source_row_envelope
     FROM workbook_finance_decisions AS decision
     LEFT JOIN workbook_source_records AS source ON source.id=decision.source_record_id
     LEFT JOIN finance_entries AS entry ON entry.id=decision.finance_entry_id
     WHERE decision.import_id=? ORDER BY decision.id LIMIT ? OFFSET ?`,
  ).bind(command.importId, WORKBOOK_MATERIALIZATION_SLICE_SIZE, state.cursor).all()).results
  if (!Array.isArray(rows) || !rows.length) fail('WORKBOOK_RECONCILIATION_CONFLICT')
  const financeEnvelope = rows.find(({ source_row_envelope: value }) => value)?.source_row_envelope
    ?? (await command.db.prepare(
      'SELECT source_row_envelope FROM finance_entries WHERE batch_id=? LIMIT 1',
    ).bind(progress.financeBatchId).first())?.source_row_envelope
  if (!financeEnvelope) fail('CRYPTO_FAILURE')
  const financeKey = await loadDataKey(command.db, {
    envelope: parseJson(financeEnvelope, 'CRYPTO_FAILURE'), expectedScope: FINANCE_SCOPE,
  })
  const updates = []
  const adjustments = []
  const inserts = []
  const voids = []
  const links = []
  for (const row of rows) {
    if (row.action === 'link_update') {
      if (row.current_version !== row.expected_finance_version) fail('VERSION_CONFLICT')
      if (row.accounting_month_changed || row.specialist_changed) {
        updates.push({
          id: row.finance_entry_id,
          accountingMonth: row.target_accounting_month,
          specialistId: row.target_specialist_id,
          expectedVersion: row.expected_finance_version,
          updatedAt: now,
        })
        const adjustmentId = generated(
          command.idFactory, 'fadj', /^fadj_[A-Za-z0-9][A-Za-z0-9_-]{0,122}$/,
        )
        adjustments.push({
          id: adjustmentId,
          financeEntryId: row.finance_entry_id,
          workbookImportId: command.importId,
          reasonEnvelope: await financeSeal(command.keyring, financeKey, adjustmentId, 'reason', {
            code: 'workbook_reconciliation', importId: command.importId,
          }),
          beforeEnvelope: await financeSeal(command.keyring, financeKey, adjustmentId, 'before', {
            accountingMonth: row.current_accounting_month,
            specialistId: row.current_specialist_id,
          }),
          afterEnvelope: await financeSeal(command.keyring, financeKey, adjustmentId, 'after', {
            accountingMonth: row.target_accounting_month,
            specialistId: row.target_specialist_id,
          }),
          actorId: command.actor.id,
          createdAt: now,
        })
      }
      links.push({
        id: generated(command.idFactory, 'fsl', /^fsl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
        sourceRecordId: row.source_record_id,
        financeEntryId: row.finance_entry_id,
        relationship: 'reconciled',
        expectedVersion: row.expected_finance_version
          + (row.accounting_month_changed || row.specialist_changed ? 1 : 0),
        actorId: command.actor.id,
        createdAt: now,
      })
    } else if (row.action === 'insert') {
      const payload = await openAuthenticatedWorkbookSource({
        keyring: command.keyring, dataKey: sourceKeyRow, row,
        config: command.config, centreId: command.centreId,
      })
      const value = payload.normalized
      const entryId = generated(command.idFactory, 'fin', /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
      inserts.push({
        id: entryId,
        batchId: progress.financeBatchId,
        sourceKey: `materialized:${row.record_digest}`,
        kind: value.recordType === 'expense' ? 'expense' : 'income',
        recordType: value.recordType,
        accountingMonth: value.accountingMonth,
        occurredOn: value.occurredOn,
        amountGrosze: value.amountGrosze,
        paidAmountGrosze: paidAmountFor(value),
        paymentMethod: value.paymentMethod,
        settlementStatus: value.settlementStatus,
        invoiceStatus: value.invoiceStatus,
        specialistId: row.target_specialist_id,
        detailsEnvelope: await financeSeal(command.keyring, financeKey, entryId, 'details', {
          schema: 'finance_entry_details.v1',
          counterparty: value.counterparty,
          sourceLabel: value.sourceLabel,
          invoiceNote: value.invoiceNote,
          lessonCount: value.lessonCount,
        }),
        sourceEnvelope: await financeSeal(command.keyring, financeKey, entryId, 'source_row', {
          schema: 'finance_entry_source.v1',
          source: {
            batchId: progress.financeBatchId,
            sourceKey: value.sourceKey,
            sheet: value.sheet,
            rowNumber: value.rowNumber,
            raw: payload.raw,
          },
        }),
        sourceLookup: `v1:${row.record_digest}`,
        actorId: command.actor.id,
        createdAt: now,
      })
      links.push({
        id: generated(command.idFactory, 'fsl', /^fsl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
        sourceRecordId: row.source_record_id,
        financeEntryId: entryId,
        relationship: 'materialized',
        expectedVersion: 1,
        actorId: command.actor.id,
        createdAt: now,
      })
    } else if (row.action === 'void') {
      if (row.current_version !== row.expected_finance_version) fail('VERSION_CONFLICT')
      voids.push({
        id: generated(command.idFactory, 'fev', /^fev_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
        financeEntryId: row.finance_entry_id,
        workbookImportId: command.importId,
        sourceRecordId: row.source_record_id,
        reasonCode: row.reason_code,
        expectedVersion: row.expected_finance_version,
        actorId: command.actor.id,
        createdAt: now,
      })
    } else fail()
  }
  const statements = applyFinanceStatements(command.db, {
    updates, adjustments, inserts, voids, links,
  })
  const nextCursor = state.cursor + rows.length
  const complete = nextCursor === state.total_records
  return persistSlice({
    command,
    state,
    domainStatements: statements,
    phase: 'apply_finance',
    cursor: nextCursor,
    totalRecords: state.total_records,
    progress,
    requestHash,
    now,
    complete,
  })
}

const applyFinanceStatements = (db, { updates, adjustments, inserts, voids, links }) => {
  const statements = []
  if (updates.length) {
    statements.push(jsonStatement(db,
      `WITH changes AS (
         SELECT json_extract(value,'$.id') AS id,
                json_extract(value,'$.accountingMonth') AS accounting_month,
                json_extract(value,'$.specialistId') AS specialist_id,
                json_extract(value,'$.expectedVersion') AS expected_version,
                json_extract(value,'$.updatedAt') AS updated_at
         FROM json_each(?)
       )
       UPDATE finance_entries SET
         accounting_month=(SELECT accounting_month FROM changes WHERE changes.id=finance_entries.id),
         specialist_id=(SELECT specialist_id FROM changes WHERE changes.id=finance_entries.id),
         version=version+1,
         updated_at=(SELECT updated_at FROM changes WHERE changes.id=finance_entries.id)
       WHERE EXISTS (SELECT 1 FROM changes WHERE changes.id=finance_entries.id
         AND changes.expected_version=finance_entries.version)`, updates))
    statements.push(invariant(db, 'changes()=?', updates.length))
  }
  if (adjustments.length) statements.push(jsonStatement(db,
    `INSERT INTO finance_adjustments
     (id,finance_entry_id,reason_envelope,before_envelope,after_envelope,
      recorded_by_staff_id,created_at,workbook_import_id)
     SELECT json_extract(value,'$.id'),json_extract(value,'$.financeEntryId'),
            json_extract(value,'$.reasonEnvelope'),json_extract(value,'$.beforeEnvelope'),
            json_extract(value,'$.afterEnvelope'),json_extract(value,'$.actorId'),
            json_extract(value,'$.createdAt'),json_extract(value,'$.workbookImportId')
     FROM json_each(?)`, adjustments))
  if (inserts.length) statements.push(jsonStatement(db,
    `INSERT INTO finance_entries
     (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
      amount_grosze,paid_amount_grosze,payment_method,settlement_status,
      invoice_status,specialist_id,appointment_id,counterparty_lookup,
      details_envelope,source_row_envelope,version,created_by_staff_id,
      source_lookup,source_dedup_lookup,created_at,updated_at)
     SELECT json_extract(value,'$.id'),json_extract(value,'$.batchId'),
            json_extract(value,'$.sourceKey'),json_extract(value,'$.kind'),
            json_extract(value,'$.recordType'),json_extract(value,'$.accountingMonth'),
            json_extract(value,'$.occurredOn'),json_extract(value,'$.amountGrosze'),
            json_extract(value,'$.paidAmountGrosze'),json_extract(value,'$.paymentMethod'),
            json_extract(value,'$.settlementStatus'),json_extract(value,'$.invoiceStatus'),
            json_extract(value,'$.specialistId'),NULL,NULL,
            json_extract(value,'$.detailsEnvelope'),json_extract(value,'$.sourceEnvelope'),
            1,json_extract(value,'$.actorId'),json_extract(value,'$.sourceLookup'),
            json_extract(value,'$.sourceLookup'),json_extract(value,'$.createdAt'),
            json_extract(value,'$.createdAt') FROM json_each(?)`, inserts))
  if (voids.length) {
    statements.push(jsonStatement(db,
      `INSERT INTO finance_entry_voids
       (id,finance_entry_id,workbook_import_id,workbook_source_record_id,reason_code,
        voided_by_staff_id,created_at)
       SELECT json_extract(item.value,'$.id'),entry.id,
              json_extract(item.value,'$.workbookImportId'),
              json_extract(item.value,'$.sourceRecordId'),
              json_extract(item.value,'$.reasonCode'),
              json_extract(item.value,'$.actorId'),json_extract(item.value,'$.createdAt')
       FROM json_each(?) AS item
       JOIN finance_entries AS entry
         ON entry.id=json_extract(item.value,'$.financeEntryId')
        AND entry.version=json_extract(item.value,'$.expectedVersion')
       WHERE NOT EXISTS (SELECT 1 FROM finance_entry_voids AS existing
         WHERE existing.finance_entry_id=entry.id)
         AND NOT EXISTS (SELECT 1 FROM finance_manual_voids AS manual_void
           WHERE manual_void.finance_entry_id=entry.id)`, voids))
    statements.push(invariant(db, 'changes()=?', voids.length))
  }
  if (links.length) {
    statements.push(jsonStatement(db,
      `INSERT INTO finance_source_links
       (id,source_record_id,finance_entry_id,relationship,created_by_staff_id,created_at)
       SELECT json_extract(item.value,'$.id'),json_extract(item.value,'$.sourceRecordId'),
              entry.id,json_extract(item.value,'$.relationship'),
              json_extract(item.value,'$.actorId'),json_extract(item.value,'$.createdAt')
       FROM json_each(?) AS item
       JOIN finance_entries AS entry
         ON entry.id=json_extract(item.value,'$.financeEntryId')
        AND entry.version=json_extract(item.value,'$.expectedVersion')
       WHERE NOT EXISTS (SELECT 1 FROM finance_entry_voids AS existing
         WHERE existing.finance_entry_id=entry.id)
         AND NOT EXISTS (SELECT 1 FROM finance_manual_voids AS manual_void
           WHERE manual_void.finance_entry_id=entry.id)`, links))
    statements.push(invariant(db, 'changes()=?', links.length))
  }
  return statements
}

const applyPanelSlice = async (command, state, progress, plan, requestHash, now) => {
  const actions = [
    ...plan.panel.updates.map((value) => ({ ...value, action: 'update' })),
    ...plan.panel.voids.map((value) => ({ ...value, action: 'void' })),
  ]
  if (actions.length !== state.total_records
    || new Set(actions.map(({ id }) => id)).size !== actions.length
    || actions.some(({ id, type, expectedVersion }) => (
      type !== 'finance_entry'
      || typeof id !== 'string' || !/^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(id)
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    ))) {
    fail('WORKBOOK_MATERIALIZATION_INVALID')
  }
  const page = actions.slice(state.cursor, state.cursor + WORKBOOK_MATERIALIZATION_SLICE_SIZE)
  if (!page.length && actions.length) fail('VERSION_CONFLICT')
  if (!page.length) return persistSlice({
    command, state, domainStatements: [], phase: 'apply_finance', cursor: 0,
    totalRecords: 0, progress, requestHash, now, complete: true,
  })
  const ids = page.map(({ id }) => id)
  if ((await panelDependencyIds(command.db, ids)).size) fail('WORKBOOK_IMPORT_CONFLICT')
  const rows = (await command.db.prepare(
    `SELECT id,kind,record_type,accounting_month,occurred_on,amount_grosze,
            paid_amount_grosze,
            payment_method,settlement_status,invoice_status,specialist_id,version,
            source_row_envelope
     FROM finance_entries WHERE id IN (${ids.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM finance_entry_voids
         WHERE finance_entry_id=finance_entries.id)
       AND NOT EXISTS (SELECT 1 FROM finance_manual_voids
         WHERE finance_entry_id=finance_entries.id)`,
  ).bind(...ids).all()).results
  if (!Array.isArray(rows) || rows.length !== ids.length) fail('VERSION_CONFLICT')
  const byId = new Map(rows.map((row) => [row.id, row]))
  const proposedSpecialistIds = [...new Set(page
    .filter(({ action }) => action === 'update')
    .map(({ values }) => normalizePanelFinanceEdits(values))
    .map((normalized) => {
      if (normalized.field !== null || normalized.values === null) {
        fail('WORKBOOK_IMPORT_CONFLICT')
      }
      return normalized.values.specialistId
    })
    .filter((id) => id !== null && id !== undefined))]
    .sort(compareUtf16CodeUnits)
  let foundSpecialists = []
  if (proposedSpecialistIds.length) {
    foundSpecialists = (await command.db.prepare(
      `SELECT specialist.id FROM json_each(?) AS requested
       JOIN specialists AS specialist
         ON specialist.id=requested.value AND specialist.status='active'
       ORDER BY specialist.id`,
    ).bind(JSON.stringify(proposedSpecialistIds)).all()).results
    if (!Array.isArray(foundSpecialists)) fail('WORKBOOK_IMPORT_CONFLICT')
  }
  const knownSpecialistIds = foundSpecialists.map(({ id }) => id)
  const validated = new Map()
  for (const action of page) {
    const current = byId.get(action.id)
    if (!current || current.version !== action.expectedVersion) fail('VERSION_CONFLICT')
    if (action.action === 'void') continue
    const normalized = normalizePanelFinanceEdits(action.values)
    if (normalized.field !== null || normalized.values === null
      || !Object.keys(normalized.values).length) fail('WORKBOOK_IMPORT_CONFLICT')
    const currentValues = {
      accountingMonth: current.accounting_month,
      occurredOn: current.occurred_on,
      amountGrosze: current.amount_grosze,
      paidAmountGrosze: current.paid_amount_grosze,
      paymentMethod: current.payment_method,
      settlementStatus: current.settlement_status,
      invoiceStatus: current.invoice_status,
      specialistId: current.specialist_id,
    }
    const prospective = prospectivePanelFinanceValues(currentValues, normalized.values)
    const validationSpecialistIds = Object.hasOwn(normalized.values, 'specialistId')
      ? knownSpecialistIds
      : [...knownSpecialistIds, current.specialist_id].filter(Boolean)
    if (invalidPanelFinanceField({
      kind: current.kind,
      recordType: current.record_type,
      values: prospective,
      specialistIds: validationSpecialistIds,
    })) fail('WORKBOOK_IMPORT_CONFLICT')
    validated.set(action.id, Object.freeze({
      prospective,
      values: normalized.values,
    }))
  }
  const financeKey = validated.size ? await loadFinanceKey(command.db) : null
  const updates = []
  const adjustments = []
  const voids = []
  const columns = Object.freeze({
    accountingMonth: 'accounting_month',
    occurredOn: 'occurred_on',
    amountGrosze: 'amount_grosze',
    paidAmountGrosze: 'paid_amount_grosze',
    paymentMethod: 'payment_method',
    settlementStatus: 'settlement_status',
    invoiceStatus: 'invoice_status',
    specialistId: 'specialist_id',
  })
  for (const action of page) {
    const current = byId.get(action.id)
    if (action.action === 'void') {
      voids.push({
        id: generated(command.idFactory, 'fev', /^fev_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
        financeEntryId: action.id,
        workbookImportId: command.importId,
        sourceRecordId: null,
        reasonCode: 'panel_signed_void',
        expectedVersion: action.expectedVersion,
        actorId: command.actor.id,
        createdAt: now,
      })
      progress.voided += 1
      continue
    }
    const prepared = validated.get(action.id)
    if (!prepared) fail('WORKBOOK_IMPORT_CONFLICT')
    const values = {}
    const before = {}
    const after = { ...prepared.values }
    for (const [field, value] of Object.entries(prepared.values)) {
      const column = columns[field]
      if (!column) fail('WORKBOOK_MATERIALIZATION_INVALID')
      values[column] = value
      before[field] = current[column]
    }
    if (!Object.hasOwn(prepared.values, 'paidAmountGrosze')) {
      if (prepared.prospective.settlementStatus === 'paid') {
        values.paid_amount_grosze = prepared.prospective.paidAmountGrosze
        before.paidAmountGrosze = current.paid_amount_grosze
        after.paidAmountGrosze = prepared.prospective.paidAmountGrosze
      } else if (['unknown', 'unpaid'].includes(prepared.prospective.settlementStatus)) {
        values.paid_amount_grosze = prepared.prospective.paidAmountGrosze
        before.paidAmountGrosze = current.paid_amount_grosze
        after.paidAmountGrosze = prepared.prospective.paidAmountGrosze
      }
    }
    if (!Object.keys(values).length) continue
    const adjustmentId = generated(
      command.idFactory, 'fadj', /^fadj_[A-Za-z0-9][A-Za-z0-9_-]{0,122}$/,
    )
    updates.push({ id: action.id, expectedVersion: action.expectedVersion, values, updatedAt: now })
    adjustments.push({
      id: adjustmentId,
      financeEntryId: action.id,
      workbookImportId: command.importId,
      reasonEnvelope: await financeSeal(command.keyring, financeKey, adjustmentId, 'reason', {
        code: 'panel_round_trip', importId: command.importId,
      }),
      beforeEnvelope: await financeSeal(
        command.keyring, financeKey, adjustmentId, 'before', before,
      ),
      afterEnvelope: await financeSeal(
        command.keyring, financeKey, adjustmentId, 'after', after,
      ),
      actorId: command.actor.id,
      createdAt: now,
    })
    if (Object.hasOwn(prepared.values, 'accountingMonth')) {
      progress.accountingMonthsCorrected += 1
    }
    if (Object.hasOwn(prepared.values, 'specialistId')) {
      progress.specialistAssignmentsCorrected += 1
    }
  }
  const statements = []
  if (updates.length) {
    statements.push(jsonStatement(command.db,
      `WITH changes AS (
         SELECT json_extract(value,'$.id') AS id,
                json_extract(value,'$.expectedVersion') AS expected_version,
                json_extract(value,'$.updatedAt') AS updated_at,
                json_type(value,'$.values.accounting_month') IS NOT NULL
                  AS has_accounting_month,
                json_extract(value,'$.values.accounting_month') AS accounting_month,
                json_type(value,'$.values.occurred_on') IS NOT NULL AS has_occurred_on,
                json_extract(value,'$.values.occurred_on') AS occurred_on,
                json_type(value,'$.values.amount_grosze') IS NOT NULL AS has_amount_grosze,
                json_extract(value,'$.values.amount_grosze') AS amount_grosze,
                json_type(value,'$.values.paid_amount_grosze') IS NOT NULL
                  AS has_paid_amount_grosze,
                json_extract(value,'$.values.paid_amount_grosze') AS paid_amount_grosze,
                json_type(value,'$.values.payment_method') IS NOT NULL AS has_payment_method,
                json_extract(value,'$.values.payment_method') AS payment_method,
                json_type(value,'$.values.settlement_status') IS NOT NULL
                  AS has_settlement_status,
                json_extract(value,'$.values.settlement_status') AS settlement_status,
                json_type(value,'$.values.invoice_status') IS NOT NULL AS has_invoice_status,
                json_extract(value,'$.values.invoice_status') AS invoice_status,
                json_type(value,'$.values.specialist_id') IS NOT NULL AS has_specialist_id,
                json_extract(value,'$.values.specialist_id') AS specialist_id
         FROM json_each(?)
       )
       UPDATE finance_entries SET
         accounting_month=CASE WHEN (SELECT has_accounting_month FROM changes
           WHERE changes.id=finance_entries.id) THEN (SELECT accounting_month FROM changes
           WHERE changes.id=finance_entries.id) ELSE accounting_month END,
         occurred_on=CASE WHEN (SELECT has_occurred_on FROM changes
           WHERE changes.id=finance_entries.id) THEN (SELECT occurred_on FROM changes
           WHERE changes.id=finance_entries.id) ELSE occurred_on END,
         amount_grosze=CASE WHEN (SELECT has_amount_grosze FROM changes
           WHERE changes.id=finance_entries.id) THEN (SELECT amount_grosze FROM changes
           WHERE changes.id=finance_entries.id) ELSE amount_grosze END,
         paid_amount_grosze=CASE WHEN (SELECT has_paid_amount_grosze FROM changes
           WHERE changes.id=finance_entries.id) THEN (SELECT paid_amount_grosze FROM changes
           WHERE changes.id=finance_entries.id) ELSE paid_amount_grosze END,
         payment_method=CASE WHEN (SELECT has_payment_method FROM changes
           WHERE changes.id=finance_entries.id) THEN (SELECT payment_method FROM changes
           WHERE changes.id=finance_entries.id) ELSE payment_method END,
         settlement_status=CASE WHEN (SELECT has_settlement_status FROM changes
           WHERE changes.id=finance_entries.id) THEN (SELECT settlement_status FROM changes
           WHERE changes.id=finance_entries.id) ELSE settlement_status END,
         invoice_status=CASE WHEN (SELECT has_invoice_status FROM changes
           WHERE changes.id=finance_entries.id) THEN (SELECT invoice_status FROM changes
           WHERE changes.id=finance_entries.id) ELSE invoice_status END,
         specialist_id=CASE WHEN (SELECT has_specialist_id FROM changes
           WHERE changes.id=finance_entries.id) THEN (SELECT specialist_id FROM changes
           WHERE changes.id=finance_entries.id) ELSE specialist_id END,
         version=version+1,
         updated_at=(SELECT updated_at FROM changes WHERE changes.id=finance_entries.id)
       WHERE EXISTS (SELECT 1 FROM changes WHERE changes.id=finance_entries.id
         AND changes.expected_version=finance_entries.version)`, updates))
    statements.push(invariant(command.db, 'changes()=?', updates.length))
  }
  if (adjustments.length) statements.push(...applyFinanceStatements(command.db, {
    updates: [], adjustments, inserts: [], voids: [], links: [],
  }))
  if (voids.length) statements.push(...applyFinanceStatements(command.db, {
    updates: [], adjustments: [], inserts: [], voids, links: [],
  }))
  const nextCursor = state.cursor + page.length
  return persistSlice({
    command,
    state: Object.freeze({
      ...state,
      mutation_specialist_ids: proposedSpecialistIds,
      mutation_dependency_ids: ids,
    }),
    domainStatements: statements,
    phase: 'apply_finance',
    cursor: nextCursor,
    totalRecords: state.total_records,
    progress,
    requestHash,
    now,
    complete: nextCursor === state.total_records,
  })
}

export async function continueWorkbookMaterialization(input) {
  const command = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.freeze({ ...input }) : null
  if (!command || !command.db?.prepare || !command.db?.batch
    || !authorize(command.actor, 'finance.import', CENTRE_RESOURCE, {
      nowMs: command.nowMs,
    })
    || command.config?.appEnv !== 'staging' || command.config?.dataMode !== 'fictional'
    || command.centreId !== 'centre_1' || typeof command.importId !== 'string'
    || !IMPORT_ID.test(command.importId) || !Number.isSafeInteger(command.expectedVersion)
    || command.expectedVersion < 1 || typeof command.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey)
    || typeof command.correlationId !== 'string' || !CORRELATION_ID.test(command.correlationId)
    || typeof command.idFactory !== 'function') fail()
  const now = instant(command.nowMs)
  let state = await loadState(command.db, command.importId, command.actor.id)
  const authenticated = await loadPlan(
    command.db, command.keyring, state, command.config, command.centreId,
  )
  state = Object.freeze({
    ...state,
    resolution_identity: authenticated.resolutionIdentity,
    resolution_specialist_ids: authenticated.specialistIds,
  })
  const requestHash = await sha256Base64(JSON.stringify([
    1, command.importId, command.expectedVersion, state.plan_envelope,
    authenticated.plan.previewPlanDigest, authenticated.resolutionIdentity,
  ]))
  const replay = await replayRow(command.db, command.actor.id, command.idempotencyKey)
  if (replay) {
    if (replay.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
    await requireCurrentAuthority(command.db, command.actor)
    return responseFrom(state)
  }
  if (state.import_status === 'complete') {
    await requireCurrentAuthority(command.db, command.actor)
    return responseFrom(state)
  }
  if (state.import_version !== command.expectedVersion) fail('VERSION_CONFLICT')
  await requireActiveSpecialists(command.db, state.resolution_specialist_ids)
  const progress = parseWorkbookMaterializationProgress(state.progress_json)
  try {
    if (state.workbook_kind === 'panel-v2') {
      return await applyPanelSlice(
        command, state, progress, authenticated.plan, requestHash, now,
      )
    }
    if (state.fingerprint !== APPROVED) fail('WORKBOOK_FINGERPRINT_REJECTED')
    if (state.phase === 'index_finance') {
      return await indexFinanceSlice(command, state, progress, requestHash, now)
    }
    if (state.phase === 'reconcile_sources') {
      return await reconcileSourceSlice(
        command, state, progress, authenticated.dataKey,
        authenticated.initialMappings, authenticated.resolutionMappings, requestHash, now,
      )
    }
    if (state.phase === 'reconcile_unmatched') {
      return await reconcileUnmatchedSlice(command, state, progress, requestHash, now)
    }
    if (state.phase === 'apply_finance') {
      return await applyLegacySlice(
        command, state, progress, authenticated.dataKey, requestHash, now,
      )
    }
    fail('VERSION_CONFLICT')
  } catch (error) {
    if (['WORKBOOK_RECONCILIATION_CONFLICT', 'WORKBOOK_FINGERPRINT_REJECTED',
      'WORKBOOK_IMPORT_CONFLICT', 'WORKBOOK_MATERIALIZATION_INVALID',
      'CRYPTO_FAILURE', 'VERSION_CONFLICT',
    ].includes(error?.message)) throw error
    const winner = await replayRow(command.db, command.actor.id, command.idempotencyKey)
    if (winner) {
      if (winner.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
      state = await loadState(command.db, command.importId, command.actor.id)
      await requireCurrentAuthority(command.db, command.actor)
      return responseFrom(state)
    }
    const current = await loadState(command.db, command.importId, command.actor.id)
    if (current.job_version !== state.job_version || current.import_status === 'complete') {
      await requireCurrentAuthority(command.db, command.actor)
      return responseFrom(current)
    }
    throw error
  }
}
