import { auditEventStatement } from '../audit/events.js'
import { createUnitOfWork } from '../db/unit-of-work.js'
import { authorize } from '../identity/policy.js'
import {
  decryptForScope,
  encryptForScope,
  loadDataKey,
} from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'
import { compareUtf16CodeUnits } from '../../src/code-unit-order.js'
import {
  loadAuthenticatedWorkbookSpecialistMappings,
  loadWorkbookSourceDataKey,
  openAuthenticatedWorkbookSource,
} from './workbook-source-registry.js'
import {
  loadWorkbookSpecialistLabels,
  loadWorkbookSpecialistOptions,
} from './workbook-specialist-options.js'

const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const SOURCE_SCOPE = Object.freeze({
  type: 'workbook_source_registry', id: 'centre_1', purpose: 'source_registry',
})
const IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const PLAN_DIGEST = /^v[1-9]\d*_[A-Za-z0-9_-]{43}$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.xlsx$/
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const CURSOR = /^c_(0|[1-9]\d{0,5})_r([1-9]\d*)$/
const INVALID_TEXT = /[\p{Cc}\p{Cf}]/u
const PAGE_SIZE = 20

const fail = (code) => { throw new Error(code) }
const invalid = (field) => fail(`VALIDATION_FAILED/${field}`)
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value)
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const safeCount = (value) => Number.isSafeInteger(value) && value >= 0
const boundedSourceValue = (value) => typeof value === 'string' && value.length <= 200
  && value === value.trim().normalize('NFC') && !INVALID_TEXT.test(value)
const instant = (nowMs) => new Date(nowMs).toISOString()

const assertCurrentActor = async (db, actor) => {
  const current = await db.prepare(
    `SELECT staff.id,authority.revision FROM staff_users AS staff
     JOIN staff_authorities AS authority ON authority.staff_id=staff.id
     WHERE staff.id=? AND staff.role=? AND staff.specialist_id IS ?
       AND staff.version=? AND staff.status='active'`,
  ).bind(actor.id, actor.role, actor.specialistId, actor.version).first()
  if (!current || current.revision !== actor.authorityRevision) fail('NOT_FOUND')
}

const digest = async (text) => {
  const bytes = new TextEncoder().encode(text)
  let hash
  try {
    hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return encodeBase64Url(hash)
  } finally {
    bytes.fill(0)
    hash?.fill(0)
  }
}

const replayFor = (db, actorId, operation, idempotencyKey) => db.prepare(
  `SELECT request_hash,entity_id,response_version,response_aux_version
   FROM finance_reporting_request_replays
   WHERE actor_staff_id=? AND operation=? AND idempotency_key=?`,
).bind(actorId, operation, idempotencyKey).first()

const actorFenceSql = `EXISTS (
  SELECT 1 FROM staff_users AS staff
  JOIN staff_authorities AS authority ON authority.staff_id=staff.id
  WHERE staff.id=? AND staff.role=? AND staff.specialist_id IS ?
    AND staff.version=? AND staff.status='active' AND authority.revision=?
)`

const captureResolution = (value) => {
  if (!exact(value, ['conflictId', 'specialistId'])
    || typeof value.conflictId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.conflictId)
    || typeof value.specialistId !== 'string'
    || !/^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(value.specialistId)) {
    invalid('resolutions')
  }
  return Object.freeze({ conflictId: value.conflictId, specialistId: value.specialistId })
}

const resolutionResponse = (
  importId, resolutionCount, resolutionVersion, importVersion,
) => Object.freeze({
  status: 200,
  body: Object.freeze({ data: Object.freeze({
    importId, resolutionCount, resolutionVersion, importVersion,
  }) }),
})

export async function recordWorkbookResolutions(input) {
  const keys = [
    'db', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory', 'importId',
    'expectedVersion', 'planDigest', 'resolutions', 'idempotencyKey',
  ]
  if (!exact(input, keys) || !input.db?.prepare || !input.db?.batch || !input.keyring
    || typeof input.idFactory !== 'function'
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !CORRELATION_ID.test(input.correlationId ?? '')
    || !IMPORT_ID.test(input.importId ?? '')
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || !PLAN_DIGEST.test(input.planDigest ?? '')
    || !Array.isArray(input.resolutions) || input.resolutions.length < 1
    || input.resolutions.length > 100
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey ?? '')) invalid('resolutions')
  if (!authorize(input.actor, 'finance.import', CENTRE, { nowMs: input.nowMs })) fail('NOT_FOUND')
  await assertCurrentActor(input.db, input.actor)
  const resolutions = input.resolutions.map(captureResolution)
  if (new Set(resolutions.map(({ conflictId }) => conflictId)).size !== resolutions.length) {
    invalid('resolutions')
  }
  resolutions.sort((left, right) => compareUtf16CodeUnits(
    left.conflictId, right.conflictId,
  ))
  const requestHash = await digest(JSON.stringify([
    input.importId, input.expectedVersion, input.planDigest, resolutions,
  ]))
  const replay = await replayFor(
    input.db, input.actor.id, 'workbook.resolutions.record', input.idempotencyKey,
  )
  if (replay) {
    if (replay.request_hash !== requestHash || replay.entity_id !== input.importId) {
      fail('IDEMPOTENCY_CONFLICT')
    }
    if (!safeCount(replay.response_aux_version) || replay.response_aux_version < 1) {
      fail('INTERNAL_ERROR')
    }
    await assertCurrentActor(input.db, input.actor)
    return resolutionResponse(
      input.importId, resolutions.length, replay.response_version,
      replay.response_aux_version,
    )
  }
  const state = await input.db.prepare(
    `SELECT import.id,import.artifact_id,import.preview_token_digest,import.status,
            import.version AS import_version,
            import.created_by_staff_id,plan.plan_envelope,
            coalesce(max(resolution.version),0) AS resolution_version
     FROM workbook_imports AS import
     JOIN workbook_import_plans AS plan ON plan.import_id=import.id
     LEFT JOIN workbook_import_resolution_sets AS resolution
       ON resolution.import_id=import.id
     WHERE import.id=? AND import.created_by_staff_id=? GROUP BY import.id`,
  ).bind(input.importId, input.actor.id).first()
  if (!state) fail('NOT_FOUND')
  if (!['ready', 'conflicts'].includes(state.status)) {
    fail('VERSION_CONFLICT')
  }
  if (state.resolution_version !== input.expectedVersion) fail('VERSION_CONFLICT')
  let envelope
  let plan
  try {
    envelope = JSON.parse(state.plan_envelope)
    const dataKey = await loadDataKey(input.db, { envelope, expectedScope: SOURCE_SCOPE })
    plan = JSON.parse(await decryptForScope(input.keyring, dataKey, {
      expectedScope: SOURCE_SCOPE, recordId: input.importId,
      field: 'materialization_plan', envelope,
    }))
  } catch { fail('CRYPTO_FAILURE') }
  if (!plain(plan) || plan.previewPlanDigest !== input.planDigest
    || !Array.isArray(plan.conflicts) || plan.conflicts.length < 1
    || plan.conflicts.length > 100) fail('VERSION_CONFLICT')
  const catalog = new Map()
  for (const conflict of plan.conflicts) {
    if (!exact(conflict, ['id', 'code', 'kind', 'sourceValue'])
      || typeof conflict.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(conflict.id)
      || typeof conflict.code !== 'string'
      || !/^[A-Z][A-Z0-9_]{2,63}$/.test(conflict.code)
      || conflict.kind !== 'specialist_mapping'
      || typeof conflict.sourceValue !== 'string' || conflict.sourceValue.length > 200
      || catalog.has(conflict.id)) fail('VERSION_CONFLICT')
    catalog.set(conflict.id, conflict)
  }
  if (resolutions.length !== catalog.size
    || resolutions.some(({ conflictId }) => !catalog.has(conflictId))) {
    fail('VERSION_CONFLICT')
  }
  const specialistIds = [...new Set(resolutions.map(({ specialistId }) => specialistId))]
  const activeSpecialists = specialistIds.length ? (await input.db.prepare(
    `SELECT id FROM specialists WHERE id IN (${specialistIds.map(() => '?').join(',')})
     AND status='active' ORDER BY id`,
  ).bind(...specialistIds).all()).results : []
  if (!Array.isArray(activeSpecialists)
    || activeSpecialists.length !== specialistIds.length) fail('VERSION_CONFLICT')
  const nextVersion = input.expectedVersion + 1
  const nextImportVersion = state.import_version + 1
  const createdAt = instant(input.nowMs)
  let resolutionId
  let auditId
  try {
    resolutionId = `wrs_${input.idFactory()}`
    auditId = `aud_${input.idFactory()}`
  } catch { fail('INTERNAL_ERROR') }
  if (!/^wrs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(resolutionId)
    || !/^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(auditId)) fail('INTERNAL_ERROR')
  const dataKey = await loadDataKey(input.db, { envelope, expectedScope: SOURCE_SCOPE })
  const resolutionsEnvelope = JSON.stringify(await encryptForScope(input.keyring, dataKey, {
    expectedScope: SOURCE_SCOPE, recordId: resolutionId, field: 'resolutions',
    plaintext: JSON.stringify({
      schema: 'workbook_resolution_set.v1', planDigest: input.planDigest, resolutions,
    }),
  }))
  const metadata = { resolutionCount: resolutions.length, resolutionVersion: nextVersion }
  const unit = createUnitOfWork(input.db, {
    mode: 'mutation', actorId: input.actor.id, correlationId: input.correlationId,
  })
  unit.domain(input.db.prepare(
    `UPDATE workbook_imports
     SET status=?,version=version+1,updated_at=?
     WHERE id=? AND created_by_staff_id=? AND status=? AND version=?`,
  ).bind(
    state.status === 'conflicts' ? 'materializing' : 'ready',
    createdAt, input.importId, input.actor.id, state.status, state.import_version,
  ))
  unit.domain(input.db.prepare(
    `INSERT INTO workbook_import_resolution_sets
     (id,import_id,artifact_id,preview_token_digest,plan_digest,resolution_count,
      resolutions_envelope,created_by_staff_id,version,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    resolutionId, input.importId, state.artifact_id, state.preview_token_digest,
    input.planDigest, resolutions.length, resolutionsEnvelope, input.actor.id,
    nextVersion, createdAt,
  ))
  unit.idempotency(input.db.prepare(
    `INSERT INTO finance_reporting_request_replays
     (actor_staff_id,operation,idempotency_key,request_hash,entity_id,response_version,
      response_aux_version,created_at)
     VALUES (?,'workbook.resolutions.record',?,?,?,?,?,?)`,
  ).bind(
    input.actor.id, input.idempotencyKey, requestHash, input.importId, nextVersion,
    nextImportVersion, createdAt,
  ))
  unit.audit(auditEventStatement(input.db, {
    id: auditId, occurredAt: createdAt, actorStaffId: input.actor.id,
    action: 'workbook.resolutions.recorded', entityType: 'workbook_import',
    entityId: input.importId, result: 'success', correlationId: input.correlationId,
    metadata, reasonEnvelope: null,
  }))
  unit.guard(input.db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'workbook_resolution_postcondition' WHERE NOT (
       EXISTS (SELECT 1 FROM workbook_import_resolution_sets
         WHERE id=? AND import_id=? AND version=? AND created_by_staff_id=?)
       AND EXISTS (SELECT 1 FROM finance_reporting_request_replays
         WHERE actor_staff_id=? AND operation='workbook.resolutions.record'
           AND idempotency_key=? AND request_hash=? AND entity_id=? AND response_version=?
           AND response_aux_version=?)
       AND EXISTS (SELECT 1 FROM audit_events WHERE id=?
         AND action='workbook.resolutions.recorded' AND entity_id=?
         AND actor_staff_id=? AND correlation_id=? AND metadata_json=?)
       AND (SELECT coalesce(max(version),0) FROM workbook_import_resolution_sets
         WHERE import_id=?)=?
       AND EXISTS (SELECT 1 FROM workbook_imports WHERE id=?
         AND created_by_staff_id=? AND status=? AND version=?)
       AND (SELECT count(*) FROM specialists AS specialist
         JOIN json_each(?) AS selected ON selected.value=specialist.id
         WHERE specialist.status='active')=?
       AND ${actorFenceSql})`,
  ).bind(
    resolutionId, input.importId, nextVersion, input.actor.id,
    input.actor.id, input.idempotencyKey, requestHash, input.importId, nextVersion,
    nextImportVersion,
    auditId, input.importId, input.actor.id, input.correlationId,
    JSON.stringify(metadata), input.importId, nextVersion,
    input.importId, input.actor.id,
    state.status === 'conflicts' ? 'materializing' : state.status,
    nextImportVersion,
    JSON.stringify(specialistIds), specialistIds.length,
    input.actor.id, input.actor.role, input.actor.specialistId, input.actor.version,
    input.actor.authorityRevision,
  ))
  try {
    await unit.commit()
  } catch (error) {
    const winner = await replayFor(
      input.db, input.actor.id, 'workbook.resolutions.record', input.idempotencyKey,
    )
    if (winner) {
      if (winner.request_hash !== requestHash || winner.entity_id !== input.importId) {
        fail('IDEMPOTENCY_CONFLICT')
      }
      if (!safeCount(winner.response_aux_version) || winner.response_aux_version < 1) {
        fail('INTERNAL_ERROR')
      }
      await assertCurrentActor(input.db, input.actor)
      return resolutionResponse(
        input.importId, resolutions.length, winner.response_version,
        winner.response_aux_version,
      )
    }
    const current = await input.db.prepare(
      `SELECT coalesce(max(version),0) AS version FROM workbook_import_resolution_sets
       WHERE import_id=?`,
    ).bind(input.importId).first('version')
    if (current !== input.expectedVersion) fail('VERSION_CONFLICT')
    throw error
  }
  await assertCurrentActor(input.db, input.actor)
  return resolutionResponse(
    input.importId, resolutions.length, nextVersion, nextImportVersion,
  )
}

const exportResponse = (row) => Object.freeze({
  status: 200,
  body: Object.freeze({ data: Object.freeze({
    id: row.id, format: row.format, scope: row.scope, byteSize: row.byteSize,
    filename: row.filename, createdAt: row.createdAt, version: 1,
  }) }),
})

export async function recordWorkbookExport(input) {
  const keys = [
    'db', 'actor', 'nowMs', 'correlationId', 'idFactory', 'format', 'byteSize',
    'filename', 'fingerprint', 'idempotencyKey',
  ]
  if (!exact(input, keys) || !input.db?.prepare || !input.db?.batch
    || typeof input.idFactory !== 'function'
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !CORRELATION_ID.test(input.correlationId ?? '')
    || !['legacy', 'panel-v2'].includes(input.format)
    || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1
    || input.byteSize > 10 * 1024 * 1024
    || !FILENAME.test(input.filename ?? '') || !FINGERPRINT.test(input.fingerprint ?? '')
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey ?? '')) invalid('export')
  let scope
  let specialistId = null
  if (authorize(input.actor, 'workbook.centre.export', CENTRE, { nowMs: input.nowMs })) {
    scope = 'centre'
  } else if (authorize(input.actor, 'workbook.own.export', Object.freeze({
    kind: 'workbook_own', specialistId: input.actor?.specialistId,
  }), { nowMs: input.nowMs })) {
    scope = 'own'
    specialistId = input.actor.specialistId
  } else fail('NOT_FOUND')
  if (scope === 'own' && input.format !== 'panel-v2') invalid('export')
  await assertCurrentActor(input.db, input.actor)
  const requestHash = await digest(JSON.stringify([
    input.format, scope, specialistId, input.byteSize, input.filename, input.fingerprint,
  ]))
  const replay = await replayFor(
    input.db, input.actor.id, 'workbook.export.create', input.idempotencyKey,
  )
  if (replay) {
    if (replay.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
    const row = await input.db.prepare(
      `SELECT id,format,scope,byte_size AS byteSize,filename,created_at AS createdAt
       FROM workbook_export_history WHERE id=? AND created_by_staff_id=?`,
    ).bind(replay.entity_id, input.actor.id).first()
    if (!row) fail('INTERNAL_ERROR')
    await assertCurrentActor(input.db, input.actor)
    return exportResponse(row)
  }
  let exportId
  let auditId
  try {
    exportId = `wbe_${input.idFactory()}`
    auditId = `aud_${input.idFactory()}`
  } catch { fail('INTERNAL_ERROR') }
  if (!/^wbe_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(exportId)
    || !/^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(auditId)) fail('INTERNAL_ERROR')
  const createdAt = instant(input.nowMs)
  const metadata = { byteSize: input.byteSize, exportVersion: 1 }
  const unit = createUnitOfWork(input.db, {
    mode: 'mutation', actorId: input.actor.id, correlationId: input.correlationId,
  })
  unit.domain(input.db.prepare(
    `INSERT INTO workbook_export_history
     (id,format,scope,scope_specialist_id,byte_size,filename,artifact_fingerprint,
      created_by_staff_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(
    exportId, input.format, scope, specialistId, input.byteSize, input.filename,
    input.fingerprint, input.actor.id, createdAt,
  ))
  unit.idempotency(input.db.prepare(
    `INSERT INTO finance_reporting_request_replays
     (actor_staff_id,operation,idempotency_key,request_hash,entity_id,response_version,created_at)
     VALUES (?,'workbook.export.create',?,?,?,?,?)`,
  ).bind(input.actor.id, input.idempotencyKey, requestHash, exportId, 1, createdAt))
  unit.audit(auditEventStatement(input.db, {
    id: auditId, occurredAt: createdAt, actorStaffId: input.actor.id,
    action: 'workbook.export.created', entityType: 'workbook_export', entityId: exportId,
    result: 'success', correlationId: input.correlationId, metadata, reasonEnvelope: null,
  }))
  unit.guard(input.db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'workbook_export_history_postcondition' WHERE NOT (
       EXISTS (SELECT 1 FROM workbook_export_history WHERE id=?
         AND created_by_staff_id=? AND scope=? AND scope_specialist_id IS ?)
       AND EXISTS (SELECT 1 FROM finance_reporting_request_replays
         WHERE actor_staff_id=? AND operation='workbook.export.create'
           AND idempotency_key=? AND request_hash=? AND entity_id=? AND response_version=1)
       AND EXISTS (SELECT 1 FROM audit_events WHERE id=?
         AND action='workbook.export.created' AND entity_id=? AND actor_staff_id=?
         AND correlation_id=? AND metadata_json=?) AND ${actorFenceSql})`,
  ).bind(
    exportId, input.actor.id, scope, specialistId,
    input.actor.id, input.idempotencyKey, requestHash, exportId,
    auditId, exportId, input.actor.id, input.correlationId, JSON.stringify(metadata),
    input.actor.id, input.actor.role, input.actor.specialistId, input.actor.version,
    input.actor.authorityRevision,
  ))
  try {
    await unit.commit()
  } catch (error) {
    const winner = await replayFor(
      input.db, input.actor.id, 'workbook.export.create', input.idempotencyKey,
    )
    if (winner) {
      if (winner.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
      const row = await input.db.prepare(
        `SELECT id,format,scope,byte_size AS byteSize,filename,created_at AS createdAt
         FROM workbook_export_history WHERE id=? AND created_by_staff_id=?`,
      ).bind(winner.entity_id, input.actor.id).first()
      if (!row) fail('INTERNAL_ERROR')
      await assertCurrentActor(input.db, input.actor)
      return exportResponse(row)
    }
    throw error
  }
  await assertCurrentActor(input.db, input.actor)
  return exportResponse({
    id: exportId, format: input.format, scope, byteSize: input.byteSize,
    filename: input.filename, createdAt,
  })
}

const pageCursor = (value) => {
  if (value === null) return Object.freeze({ offset: 0, revision: null })
  const match = CURSOR.exec(value)
  if (!match) invalid('cursor')
  const offset = Number(match[1])
  const revision = Number(match[2])
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(revision)) invalid('cursor')
  return Object.freeze({ offset, revision })
}
const registryRevision = async (db) => {
  const row = await db.prepare(
    `SELECT revision FROM finance_reporting_state WHERE authority_key='finance'`,
  ).first()
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1) fail('INTERNAL_ERROR')
  return row.revision
}
const assertRegistrySnapshot = async (db, expected) => {
  if (await registryRevision(db) !== expected) fail('WORKBOOK_REGISTRY_RETRY')
}
const boundedRows = async (statement, cap, code = 'WORKBOOK_REGISTRY_LIMIT') => {
  const result = (await statement.all())?.results
  if (!Array.isArray(result)) fail('INTERNAL_ERROR')
  if (result.length > cap) fail(code)
  return result
}

const importDto = (row) => Object.freeze({
  id: row.id,
  artifact: Object.freeze({
    id: row.artifact_id, fingerprint: row.fingerprint, byteSize: row.byte_size,
    parserVersion: row.parser_version, materializerVersion: row.materializer_version,
    createdAt: row.artifact_created_at,
  }),
  status: row.status,
  version: row.version,
  phase: row.phase,
  progress: row.phase === null ? null : Object.freeze({
    processed: row.processed_records, total: row.total_records,
  }),
  summary: Object.freeze({
    sourceCount: row.source_count,
    quarantineCount: row.quarantine_count,
    conflictCount: row.conflict_count,
    duplicateCount: row.duplicate_count,
    resolutionCount: row.resolution_count,
  }),
  resolutionVersion: row.resolution_version,
  createdByStaffId: row.created_by_staff_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const exportDto = (row) => Object.freeze({
  id: row.id, format: row.format, scope: row.scope, byteSize: row.byte_size,
  filename: row.filename, createdAt: row.created_at, version: 1,
})

const entryDto = (row) => Object.freeze({
  id: row.id, importId: row.import_id ?? null,
  state: row.void_type === null ? 'active' : 'void',
  voidType: row.void_type, kind: row.kind, recordType: row.record_type,
  accountingMonth: row.accounting_month, amountGrosze: row.amount_grosze,
  version: row.version,
})

export async function loadWorkbookRegistry(input) {
  const keys = ['db', 'actor', 'nowMs', 'cursor', 'section']
  if (!exact(input, keys) || !input.db?.prepare
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !['all', 'imports', 'exports', 'entries', 'unknown'].includes(input.section)) {
    invalid('registry')
  }
  if (!authorize(input.actor, 'finance.centre.read', CENTRE, { nowMs: input.nowMs })) {
    fail('NOT_FOUND')
  }
  const { offset, revision: cursorRevision } = pageCursor(input.cursor)
  const revision = await registryRevision(input.db)
  if (cursorRevision !== null && cursorRevision !== revision) fail('WORKBOOK_REGISTRY_RETRY')
  const importRows = ['exports', 'entries', 'unknown'].includes(input.section) ? []
    : await boundedRows(input.db.prepare(
      `SELECT import.id,import.status,import.version,import.created_by_staff_id,
              import.created_at,import.updated_at,
              artifact.id AS artifact_id,artifact.fingerprint,artifact.byte_size,
              artifact.parser_version,artifact.materializer_version,
              artifact.created_at AS artifact_created_at,
              job.phase,job.processed_records,job.total_records,
              (SELECT count(*) FROM workbook_source_records AS source
               WHERE source.import_id=import.id) AS source_count,
              (SELECT count(*) FROM workbook_quarantine_records AS quarantine
               JOIN workbook_source_records AS source ON source.id=quarantine.source_record_id
               WHERE source.import_id=import.id) AS quarantine_count,
              coalesce((SELECT projection.conflict_count
                FROM historical_projection_jobs AS projection
                WHERE projection.import_id=import.id),0)
              + (SELECT summary.mapping_conflict_count
                 FROM workbook_import_plan_summaries AS summary
                 WHERE summary.import_id=import.id) AS conflict_count,
              (SELECT count(*)-count(DISTINCT source.record_digest)
               FROM workbook_source_records AS source
               WHERE source.import_id=import.id) AS duplicate_count,
              max(
                (SELECT count(*) FROM workbook_resolutions AS resolution
                 WHERE resolution.import_id=import.id),
                coalesce((SELECT resolution_set.resolution_count
                  FROM workbook_import_resolution_sets AS resolution_set
                  WHERE resolution_set.import_id=import.id
                  ORDER BY resolution_set.version DESC LIMIT 1),0)
              ) + coalesce((SELECT count(*)
                FROM historical_conflict_resolutions AS historical_resolution
                JOIN historical_projection_conflicts AS conflict
                  ON conflict.id=historical_resolution.conflict_id
                JOIN historical_projection_jobs AS projection
                  ON projection.id=conflict.job_id
                WHERE projection.import_id=import.id),0) AS resolution_count,
              coalesce((SELECT max(resolution_set.version)
                FROM workbook_import_resolution_sets AS resolution_set
                WHERE resolution_set.import_id=import.id),0) AS resolution_version
       FROM workbook_imports AS import
       JOIN workbook_artifacts AS artifact ON artifact.id=import.artifact_id
       LEFT JOIN workbook_materialization_jobs AS job ON job.import_id=import.id
       WHERE artifact.centre_id=?
       ORDER BY import.created_at DESC,import.id DESC LIMIT ? OFFSET ?`,
    ).bind(CENTRE.centreId, PAGE_SIZE + 1, offset), PAGE_SIZE + 1)
  const exportRows = ['imports', 'entries', 'unknown'].includes(input.section) ? []
    : await boundedRows(input.db.prepare(
      `SELECT id,format,scope,byte_size,filename,created_at
       FROM workbook_export_history
       ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
    ).bind(PAGE_SIZE + 1, offset), PAGE_SIZE + 1)
  const entryRows = input.section === 'imports' || input.section === 'exports' ? []
    : await boundedRows(input.db.prepare(
      `SELECT entry.id,source.import_id,entry.kind,entry.record_type,
              entry.accounting_month,entry.amount_grosze,entry.version,
              CASE WHEN manual_void.id IS NOT NULL THEN 'manual'
                   WHEN workbook_void.id IS NOT NULL THEN 'workbook' ELSE NULL END AS void_type
       FROM finance_entries AS entry
       LEFT JOIN finance_source_links AS link ON link.finance_entry_id=entry.id
       LEFT JOIN workbook_source_records AS source ON source.id=link.source_record_id
       LEFT JOIN workbook_imports AS import ON import.id=source.import_id
       LEFT JOIN workbook_artifacts AS artifact ON artifact.id=import.artifact_id
       LEFT JOIN finance_manual_voids AS manual_void ON manual_void.finance_entry_id=entry.id
       LEFT JOIN finance_entry_voids AS workbook_void ON workbook_void.finance_entry_id=entry.id
       WHERE (artifact.centre_id=? OR link.id IS NULL)
       ${input.section === 'unknown' ? 'AND entry.accounting_month IS NULL' : ''}
       ORDER BY entry.created_at DESC,entry.id DESC LIMIT ? OFFSET ?`,
    ).bind(CENTRE.centreId, PAGE_SIZE + 1, offset), PAGE_SIZE + 1)
  const hasNext = importRows.length > PAGE_SIZE || exportRows.length > PAGE_SIZE
    || entryRows.length > PAGE_SIZE
  const imports = Object.freeze(importRows.slice(0, PAGE_SIZE).map(importDto))
  const exports = Object.freeze(exportRows.slice(0, PAGE_SIZE).map(exportDto))
  const entries = Object.freeze(entryRows.slice(0, PAGE_SIZE).map(entryDto))
  await assertRegistrySnapshot(input.db, revision)
  await assertCurrentActor(input.db, input.actor)
  return Object.freeze({ data: Object.freeze({
    cursor: input.cursor,
    nextCursor: hasNext ? `c_${offset + PAGE_SIZE}_r${revision}` : null,
    imports,
    exports,
    entries,
    complete: !hasNext,
  }) })
}

export async function loadWorkbookRegistryDetail(input) {
  const keys = ['db', 'actor', 'keyring', 'config', 'nowMs', 'importId', 'cursor', 'section']
  const sections = ['source', 'quarantine', 'conflicts', 'duplicates', 'resolutions', 'entries']
  if (!exact(input, keys) || !input.db?.prepare || !input.keyring
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !IMPORT_ID.test(input.importId ?? '') || !sections.includes(input.section)) {
    invalid('registryDetail')
  }
  if (!authorize(input.actor, 'finance.centre.read', CENTRE, { nowMs: input.nowMs })) {
    fail('NOT_FOUND')
  }
  await assertCurrentActor(input.db, input.actor)
  const visible = await input.db.prepare(
    `SELECT import.id FROM workbook_imports AS import
     JOIN workbook_artifacts AS artifact ON artifact.id=import.artifact_id
     WHERE import.id=? AND artifact.centre_id=?`,
  ).bind(input.importId, CENTRE.centreId).first()
  if (!visible) fail('NOT_FOUND')
  const { offset, revision: cursorRevision } = pageCursor(input.cursor)
  const revision = await registryRevision(input.db)
  if (cursorRevision !== null && cursorRevision !== revision) fail('WORKBOOK_REGISTRY_RETRY')
  const pageSize = input.section === 'resolutions' ? 1 : PAGE_SIZE
  let values
  let exposedPlanDigest = null
  if (input.section === 'source') {
    const sourceRows = await boundedRows(input.db.prepare(
      `SELECT source.id AS source_record_id,source.source_key,source.sheet_name,
              source.row_number,source.record_type,source.disposition,
              source.occurred_on,source.period_precision,source.period_month,
              source.record_digest,source.record_digest_hmac_version,
              source.source_payload_envelope
       FROM workbook_source_records AS source
       WHERE source.import_id=? ORDER BY source.source_key LIMIT ? OFFSET ?`,
    ).bind(input.importId, pageSize + 1, offset), pageSize + 1)
    values = []
    let dataKey = null
    for (const row of sourceRows.slice(0, pageSize)) {
      dataKey ??= await loadWorkbookSourceDataKey(input.db, row.source_payload_envelope)
      const payload = await openAuthenticatedWorkbookSource({
        keyring: input.keyring, dataKey, row, config: input.config, centreId: 'centre_1',
      })
      values.push(Object.freeze({
        id: row.source_record_id, recordType: row.record_type,
        disposition: row.disposition, sheetName: row.sheet_name,
        rowNumber: row.row_number,
        display: Object.freeze({
          accountingMonth: payload.normalized.accountingMonth ?? null,
          occurredOn: payload.normalized.occurredOn ?? null,
          periodPrecision: payload.normalized.periodPrecision,
          periodMonth: payload.normalized.periodMonth ?? null,
          amountGrosze: payload.normalized.amountGrosze ?? null,
          paymentMethod: payload.normalized.paymentMethod ?? null,
          settlementStatus: payload.normalized.settlementStatus ?? null,
          invoiceStatus: payload.normalized.invoiceStatus ?? null,
          specialistName: typeof payload.normalized.specialistName === 'string'
            ? payload.normalized.specialistName.slice(0, 200) : null,
          counterparty: typeof payload.normalized.counterparty === 'string'
            ? payload.normalized.counterparty.slice(0, 200) : null,
          sourceLabel: typeof payload.normalized.sourceLabel === 'string'
            ? payload.normalized.sourceLabel.slice(0, 200) : null,
        }),
      }))
    }
    values.hasNext = sourceRows.length > pageSize
  } else if (input.section === 'quarantine') {
    const rows = await boundedRows(input.db.prepare(
      `SELECT quarantine.id,quarantine.source_record_id,quarantine.primary_reason,
              quarantine.reason_codes_json
       FROM workbook_quarantine_records AS quarantine
       JOIN workbook_source_records AS source ON source.id=quarantine.source_record_id
       WHERE source.import_id=? ORDER BY source.source_key LIMIT ? OFFSET ?`,
    ).bind(input.importId, pageSize + 1, offset), pageSize + 1)
    values = rows.slice(0, pageSize).map((row) => Object.freeze({
      id: row.id, sourceRecordId: row.source_record_id,
      primaryReason: row.primary_reason, reasonCodes: JSON.parse(row.reason_codes_json),
    }))
    values.hasNext = rows.length > pageSize
  } else if (input.section === 'conflicts') {
    const historicalCount = await input.db.prepare(
      `SELECT count(*) AS count FROM historical_projection_conflicts AS conflict
       JOIN historical_projection_jobs AS job ON job.id=conflict.job_id
       WHERE job.import_id=?`,
    ).bind(input.importId).first('count')
    if (!safeCount(historicalCount)) fail('INTERNAL_ERROR')
    const historicalOffset = Math.min(offset, historicalCount)
    const historicalRows = await boundedRows(input.db.prepare(
      `SELECT conflict.id,conflict.kind,
              CASE WHEN resolution.id IS NULL THEN 0 ELSE 1 END AS resolved
       FROM historical_projection_conflicts AS conflict
       JOIN historical_projection_jobs AS job ON job.id=conflict.job_id
       LEFT JOIN historical_conflict_resolutions AS resolution
         ON resolution.conflict_id=conflict.id
       WHERE job.import_id=? ORDER BY conflict.id LIMIT ? OFFSET ?`,
    ).bind(input.importId, pageSize, historicalOffset), pageSize)
    const rows = historicalRows.map((row) => Object.freeze({
      id: row.id, kind: row.kind, resolved: row.resolved === 1,
    }))
    const planRow = await input.db.prepare(
      `SELECT plan.plan_envelope FROM workbook_import_plans AS plan
       WHERE plan.import_id=?`,
    ).bind(input.importId).first()
    if (!planRow) fail('NOT_FOUND')
    let planEnvelope
    let plan
    try {
      planEnvelope = JSON.parse(planRow.plan_envelope)
      const dataKey = await loadDataKey(input.db, {
        envelope: planEnvelope, expectedScope: SOURCE_SCOPE,
      })
      plan = JSON.parse(await decryptForScope(input.keyring, dataKey, {
        expectedScope: SOURCE_SCOPE, recordId: input.importId,
        field: 'materialization_plan', envelope: planEnvelope,
      }))
    } catch { fail('CRYPTO_FAILURE') }
    if (!PLAN_DIGEST.test(plan?.previewPlanDigest ?? '')) fail('CRYPTO_FAILURE')
    exposedPlanDigest = plan.previewPlanDigest
    const mapping = plan.conflicts ?? []
    if (!Array.isArray(mapping) || mapping.length > 100) fail('INTERNAL_ERROR')
    const latestRow = await input.db.prepare(
      `SELECT id,plan_digest,resolutions_envelope
       FROM workbook_import_resolution_sets WHERE import_id=?
       ORDER BY version DESC LIMIT 1`,
    ).bind(input.importId).first()
    let latestResolutions = plan.appliedResolutions ?? []
    if (latestRow) {
      let envelope
      let set
      try {
        envelope = JSON.parse(latestRow.resolutions_envelope)
        const dataKey = await loadDataKey(input.db, {
          envelope, expectedScope: SOURCE_SCOPE,
        })
        set = JSON.parse(await decryptForScope(input.keyring, dataKey, {
          expectedScope: SOURCE_SCOPE, recordId: latestRow.id,
          field: 'resolutions', envelope,
        }))
      } catch { fail('CRYPTO_FAILURE') }
      if (set?.schema !== 'workbook_resolution_set.v1'
        || set.planDigest !== latestRow.plan_digest || !Array.isArray(set.resolutions)) {
        fail('CRYPTO_FAILURE')
      }
      latestResolutions = set.resolutions
    }
    const latestResolved = new Set(latestResolutions.map(({ conflictId }) => conflictId))
    const mappingRows = []
    for (const conflict of mapping) {
      if (!exact(conflict, ['id', 'code', 'kind', 'sourceValue'])
        || typeof conflict.id !== 'string' || !/^wmc_[A-Za-z0-9_-]{1,123}$/.test(conflict.id)
        || conflict.code !== 'SPECIALIST_MAPPING_REQUIRED'
        || conflict.kind !== 'specialist_mapping'
        || !boundedSourceValue(conflict.sourceValue)) fail('CRYPTO_FAILURE')
      mappingRows.push(Object.freeze({
        id: conflict.id, kind: conflict.kind, resolved: latestResolved.has(conflict.id),
        sourceValue: conflict.sourceValue,
      }))
    }
    mappingRows.sort((left, right) => compareUtf16CodeUnits(left.id, right.id))
    const mappingOffset = Math.max(0, offset - historicalCount)
    values = [
      ...rows,
      ...mappingRows.slice(mappingOffset, mappingOffset + pageSize - rows.length),
    ]
    values.hasNext = offset + values.length < historicalCount + mappingRows.length
  } else if (input.section === 'duplicates') {
    const rows = await boundedRows(input.db.prepare(
      `SELECT min(source.id) AS first_id,count(*) AS count
       FROM workbook_source_records AS source WHERE source.import_id=?
       GROUP BY source.record_digest HAVING count(*)>1
       ORDER BY first_id LIMIT ? OFFSET ?`,
    ).bind(input.importId, pageSize + 1, offset), pageSize + 1)
    values = rows.slice(0, pageSize).map((row) => Object.freeze({
      id: `dup_${row.first_id.slice(4)}`, count: row.count,
    }))
    values.hasNext = rows.length > pageSize
  } else if (input.section === 'resolutions') {
    const rows = await boundedRows(input.db.prepare(
      `SELECT resolution.id,resolution.kind,resolution.resolution_code,
              resolution.specialist_id,resolution.created_at,1 AS version,
              NULL AS resolutions_envelope,NULL AS plan_digest,
              NULL AS service_id,NULL AS target_id,
              resolution.resolved_by_staff_id,resolution.source_record_id,
              NULL AS conflict_id
       FROM workbook_resolutions AS resolution WHERE resolution.import_id=?
       UNION ALL
       SELECT resolution_set.id,'resolution_set','recorded',NULL,
              resolution_set.created_at,resolution_set.version,
              resolution_set.resolutions_envelope,resolution_set.plan_digest,
              NULL,NULL,resolution_set.created_by_staff_id,NULL,NULL
       FROM workbook_import_resolution_sets AS resolution_set
       WHERE resolution_set.import_id=?
       UNION ALL
       SELECT historical_resolution.id,'historical_resolution',
              historical_resolution.classification,NULL,
              historical_resolution.created_at,1,NULL,NULL,
              historical_resolution.service_id,
              coalesce(historical_resolution.existing_historical_client_id,
                       historical_resolution.existing_counterparty_id),
              historical_resolution.resolved_by_staff_id,NULL,
              historical_resolution.conflict_id
       FROM historical_conflict_resolutions AS historical_resolution
       JOIN historical_projection_conflicts AS conflict
         ON conflict.id=historical_resolution.conflict_id
       JOIN historical_projection_jobs AS projection ON projection.id=conflict.job_id
       WHERE projection.import_id=?
       ORDER BY created_at,id LIMIT ? OFFSET ?`,
    ).bind(
      input.importId, input.importId, input.importId, pageSize + 1, offset,
    ), pageSize + 1)
    values = []
    let dataKey = null
    let authenticatedMappings = null
    let totalChoices = 0
    for (const row of rows.slice(0, pageSize)) {
      if (row.kind !== 'resolution_set') {
        let sourceValue = null
        if (row.kind === 'specialist_mapping') {
          const planRow = await input.db.prepare(
            `SELECT plan_envelope FROM workbook_import_plans WHERE import_id=?`,
          ).bind(input.importId).first()
          if (!planRow) fail('NOT_FOUND')
          let planEnvelope
          try { planEnvelope = JSON.parse(planRow.plan_envelope) } catch { fail('CRYPTO_FAILURE') }
          dataKey ??= await loadDataKey(input.db, {
            envelope: planEnvelope, expectedScope: SOURCE_SCOPE,
          })
          authenticatedMappings ??= await loadAuthenticatedWorkbookSpecialistMappings({
            db: input.db, keyring: input.keyring, dataKey,
            importId: input.importId, config: input.config, centreId: CENTRE.centreId,
          })
          sourceValue = authenticatedMappings.byResolutionId.get(row.id)?.sourceValue
          if (typeof sourceValue !== 'string' || !boundedSourceValue(sourceValue)) {
            fail('CRYPTO_FAILURE')
          }
        }
        values.push(Object.freeze({
          id: row.id, kind: row.kind, decision: row.resolution_code,
          specialistId: row.specialist_id, version: row.version,
          serviceId: row.service_id, targetId: row.target_id,
          resolvedByStaffId: row.resolved_by_staff_id,
          sourceRecordId: row.source_record_id, conflictId: row.conflict_id,
          sourceValue,
          createdAt: row.created_at, choices: Object.freeze([]),
        }))
        continue
      }
      let envelope
      let set
      try {
        envelope = JSON.parse(row.resolutions_envelope)
        dataKey ??= await loadDataKey(input.db, {
          envelope, expectedScope: SOURCE_SCOPE,
        })
        set = JSON.parse(await decryptForScope(input.keyring, dataKey, {
          expectedScope: SOURCE_SCOPE, recordId: row.id,
          field: 'resolutions', envelope,
        }))
      } catch { fail('CRYPTO_FAILURE') }
      if (set?.schema !== 'workbook_resolution_set.v1'
        || set.planDigest !== row.plan_digest || !Array.isArray(set.resolutions)
        || set.resolutions.length > 100
        || set.resolutions.some((choice) => !exact(choice, ['conflictId', 'specialistId'])
          || !/^wmc_[A-Za-z0-9_-]{1,123}$/.test(choice.conflictId)
          || !/^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(choice.specialistId))) {
        fail('CRYPTO_FAILURE')
      }
      totalChoices += set.resolutions.length
      if (totalChoices > 100) fail('WORKBOOK_REGISTRY_LIMIT')
      values.push(Object.freeze({
        id: row.id, kind: row.kind, decision: row.resolution_code,
        specialistId: null, serviceId: null, targetId: null,
        resolvedByStaffId: row.resolved_by_staff_id,
        sourceRecordId: null, conflictId: null,
        sourceValue: null,
        version: row.version, createdAt: row.created_at,
        choices: Object.freeze(set.resolutions.map((choice) => Object.freeze({
          conflictId: choice.conflictId, specialistId: choice.specialistId,
        }))),
      }))
    }
    values.hasNext = rows.length > pageSize
  } else {
    const rows = await boundedRows(input.db.prepare(
      `SELECT entry.id,source.import_id,entry.kind,entry.record_type,
              entry.accounting_month,entry.amount_grosze,entry.version,
              CASE WHEN manual_void.id IS NOT NULL THEN 'manual'
                   WHEN workbook_void.id IS NOT NULL THEN 'workbook' ELSE NULL END AS void_type
       FROM finance_entries AS entry
       JOIN finance_source_links AS link ON link.finance_entry_id=entry.id
       JOIN workbook_source_records AS source ON source.id=link.source_record_id
       LEFT JOIN finance_manual_voids AS manual_void ON manual_void.finance_entry_id=entry.id
       LEFT JOIN finance_entry_voids AS workbook_void ON workbook_void.finance_entry_id=entry.id
       WHERE source.import_id=? ORDER BY entry.created_at DESC,entry.id DESC
       LIMIT ? OFFSET ?`,
    ).bind(input.importId, pageSize + 1, offset), pageSize + 1)
    values = rows.slice(0, pageSize).map(entryDto)
    values.hasNext = rows.length > pageSize
  }
  const hasNext = values.hasNext
  delete values.hasNext
  const specialistOptions = input.section === 'conflicts'
    && authorize(input.actor, 'finance.import', CENTRE, { nowMs: input.nowMs })
    ? await loadWorkbookSpecialistOptions({ db: input.db, keyring: input.keyring })
    : Object.freeze([])
  const specialistLabels = input.section === 'resolutions'
    ? await loadWorkbookSpecialistLabels({
        db: input.db,
        keyring: input.keyring,
        ids: values.flatMap((value) => [
          value.specialistId, ...(value.choices ?? []).map(({ specialistId }) => specialistId),
        ]).filter(Boolean),
      })
    : Object.freeze([])
  await assertRegistrySnapshot(input.db, revision)
  await assertCurrentActor(input.db, input.actor)
  return Object.freeze({ data: Object.freeze({
    importId: input.importId, section: input.section, cursor: input.cursor,
    ...(input.section === 'conflicts' ? {
      planDigest: exposedPlanDigest, specialistOptions,
    } : {}),
    ...(input.section === 'resolutions' ? { specialistLabels } : {}),
    nextCursor: hasNext ? `c_${offset + pageSize}_r${revision}` : null,
    items: Object.freeze(values), complete: !hasNext,
  }) })
}
