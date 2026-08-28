import {
  canonicalHistoricalName,
  classifyHistoricalSubject,
  historicalNamesRequireReview,
} from '../../src/historical-records.js'
import { SERVICES } from '../../src/services.js'
import { compareUtf16CodeUnits } from '../../src/code-unit-order.js'
import { decryptForScope, encryptForScope } from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'
import {
  buildHistoricalIdentity,
  decryptHistoricalIdentityWithDataKey,
  historicalIdentityLookupCandidates,
} from './historical-crypto.js'
import {
  loadWorkbookSourceDataKey,
  loadAuthenticatedWorkbookSpecialistMappings,
  openAuthenticatedWorkbookSource,
  resolveAuthenticatedWorkbookSpecialist,
  WORKBOOK_SOURCE_SCOPE,
} from './workbook-source-registry.js'
import { authorize } from '../identity/policy.js'

export const HISTORICAL_PROJECTION_SLICE_SIZE = 2

const IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const SERVICE_BY_LABEL = new Map(SERVICES.map(({ id, label }) => [
  canonicalHistoricalName(label), id,
]))
const DATA_KEY_COLUMNS = Object.freeze([
  'id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64',
  'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at',
])
const CENTRE_RESOURCE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })

const fail = (code = 'HISTORICAL_PROJECTION_INVALID') => { throw new Error(code) }
const nowAt = (nowMs) => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail()
  try { return new Date(nowMs).toISOString() } catch { fail() }
}
const made = (factory, prefix, pattern) => {
  let id
  try { id = `${prefix}_${factory()}` } catch { fail() }
  if (!pattern.test(id)) fail()
  return id
}
const sha256 = async (value) => encodeBase64Url(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(value),
))
const normalizedLabel = (value) => {
  try { return canonicalHistoricalName(value) } catch { return null }
}

export const exactHistoricalServiceId = (label) => {
  const normalized = normalizedLabel(label)
  return normalized === null ? null : SERVICE_BY_LABEL.get(normalized) ?? null
}

export function historicalProjectionDecision(value) {
  const eligible = value?.recordType === 'income' && value.financeLinked === true
    && value.voided === false && typeof value.counterparty === 'string'
    && value.counterparty.trim().length > 0 && typeof value.sourceLabel === 'string'
    && value.sourceLabel.trim().length > 0 && typeof value.specialistId === 'string'
    && /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(value.specialistId)
    && ((value.periodPrecision === 'day' && typeof value.occurredOn === 'string'
      && value.periodMonth === value.occurredOn.slice(0, 7))
      || (value.periodPrecision === 'month' && value.occurredOn === null
        && typeof value.periodMonth === 'string')
      || (value.periodPrecision === 'unknown' && value.occurredOn === null
        && value.periodMonth === null))
  if (!eligible) return Object.freeze({
    eligible: false, classification: null, serviceId: null, conflictKind: null,
  })
  const classification = classifyHistoricalSubject({
    counterparty: value.counterparty.trim().normalize('NFC'),
    serviceLabel: value.sourceLabel.trim().normalize('NFC'),
  })
  const serviceId = exactHistoricalServiceId(value.sourceLabel)
  return Object.freeze({
    eligible: true,
    classification,
    serviceId,
    conflictKind: classification === 'review' ? 'classification'
      : serviceId === null ? 'service' : null,
  })
}

const jobDto = (row) => row.job_id === null ? null : Object.freeze({
  id: row.job_id,
  importId: row.import_id,
  status: row.job_status,
  afterSourceRecordId: row.after_source_record_id,
  totalRecords: row.total_records,
  processedRecords: row.processed_records,
  projectedRecords: row.projected_records,
  conflictCount: row.conflict_count,
  version: row.job_version,
  updatedAt: row.job_updated_at,
  completedAt: row.job_completed_at,
})

const response = (row, status = 200) => Object.freeze({
  status,
  body: Object.freeze({ data: Object.freeze({ projection: jobDto(row) }) }),
})

const safeConflictText = (value, maximum) => {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || value !== value.trim()
    || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return false
  const bytes = new TextEncoder().encode(value)
  const valid = bytes.byteLength >= 1 && bytes.byteLength <= maximum
  bytes.fill(0)
  return valid
}

const conflictContextDto = async ({ keyring, sourceKey, row }) => {
  let envelope
  try { envelope = JSON.parse(row.context_envelope) } catch { fail('CRYPTO_FAILURE') }
  let raw
  try {
    raw = JSON.parse(await decryptForScope(keyring, sourceKey, {
      expectedScope: WORKBOOK_SOURCE_SCOPE, recordId: row.id,
      field: 'conflict_context', envelope,
    }))
  } catch { fail('CRYPTO_FAILURE') }
  const keys = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Reflect.ownKeys(Object.getOwnPropertyDescriptors(raw)) : []
  const expected = [
    'schema', 'counterparty', 'serviceLabel', 'proposedClassification',
    'proposedServiceId', 'nearSubjectIds',
  ]
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))
    || raw.schema !== 'historical_projection_conflict.v1'
    || !safeConflictText(raw.counterparty, 160)
    || !safeConflictText(raw.serviceLabel, 240)
    || !['person', 'counterparty', 'review'].includes(raw.proposedClassification)
    || !(raw.proposedServiceId === null
      || SERVICES.some(({ id }) => id === raw.proposedServiceId))
    || !Array.isArray(raw.nearSubjectIds) || raw.nearSubjectIds.length > 100
    || new Set(raw.nearSubjectIds).size !== raw.nearSubjectIds.length
    || raw.nearSubjectIds.some((id) => typeof id !== 'string'
      || !/^hc[lp]_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(id))) {
    fail('CRYPTO_FAILURE')
  }
  const context = Object.freeze({
    counterparty: raw.counterparty,
    serviceLabel: raw.serviceLabel,
    proposedClassification: raw.proposedClassification,
    proposedServiceId: raw.proposedServiceId,
    nearSubjectIds: Object.freeze([...raw.nearSubjectIds]),
  })
  return Object.freeze({
    id: row.id, sourceRecordId: row.source_record_id, kind: row.kind, context,
  })
}

const unresolvedConflictDtos = async ({ db, keyring, state }) => {
  if (state.job_id === null) return Object.freeze([])
  const rows = (await db.prepare(
    `SELECT conflict.id,conflict.source_record_id,conflict.kind,conflict.context_envelope
     FROM historical_projection_conflicts AS conflict
     WHERE conflict.job_id=? AND NOT EXISTS (
       SELECT 1 FROM historical_conflict_resolutions AS resolution
       WHERE resolution.conflict_id=conflict.id)
     ORDER BY conflict.id LIMIT 101`,
  ).bind(state.job_id).all()).results
  if (!Array.isArray(rows) || rows.length > 100 || (!keyring && rows.length)) fail()
  const sourceIds = new Set()
  for (const row of rows) {
    if (!/^hcf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(row?.id ?? '')
      || !/^wbs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(row.source_record_id ?? '')
      || !['classification', 'service', 'near_match'].includes(row.kind)
      || typeof row.context_envelope !== 'string' || sourceIds.has(row.source_record_id)) fail()
    sourceIds.add(row.source_record_id)
  }
  if (!rows.length) return Object.freeze([])
  const sourceKey = await loadWorkbookSourceDataKey(db, state.plan_envelope)
  return Object.freeze(await Promise.all(rows.map((row) => conflictContextDto({
    keyring, sourceKey, row,
  }))))
}

const loadState = async (db, actorId, importId) => {
  const row = await db.prepare(
    `SELECT import.id AS import_id,import.status AS import_status,
            import.created_by_staff_id,import.correlation_id,import.version AS import_version,
            plan.workbook_kind,plan.plan_envelope,
            finance.status AS finance_status,finance.phase AS finance_phase,
            job.id AS job_id,job.status AS job_status,
            job.after_source_record_id,job.total_records,job.processed_records,
            job.projected_records,job.conflict_count,job.version AS job_version,
            job.updated_at AS job_updated_at,job.completed_at AS job_completed_at
     FROM workbook_imports AS import
     JOIN workbook_import_plans AS plan ON plan.import_id=import.id
     JOIN workbook_materialization_jobs AS finance ON finance.import_id=import.id
     LEFT JOIN historical_projection_jobs AS job ON job.import_id=import.id
     WHERE import.id=? AND import.created_by_staff_id=?`,
  ).bind(importId, actorId).first()
  if (!row || row.import_status !== 'complete' || row.workbook_kind !== 'legacy'
    || row.finance_status !== 'complete' || row.finance_phase !== 'complete') fail('NOT_FOUND')
  return row
}

const eligibleCount = async (db, importId) => {
  const row = await db.prepare(
    `SELECT count(*) AS count
     FROM workbook_source_records AS source
     JOIN finance_source_links AS link ON link.source_record_id=source.id
     JOIN finance_entries AS entry ON entry.id=link.finance_entry_id
     LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
     WHERE source.import_id=? AND source.disposition='accepted'
       AND source.record_type='income' AND void.id IS NULL
       AND entry.kind='income' AND entry.specialist_id IS NOT NULL`,
  ).bind(importId).first()
  if (!Number.isSafeInteger(row?.count) || row.count < 0 || row.count > 10_000) fail()
  return row.count
}

const replayRow = (db, actorId, operation, key) => db.prepare(
  `SELECT request_hash FROM historical_request_replays
   WHERE actor_staff_id=? AND operation=? AND idempotency_key=?`,
).bind(actorId, operation, key).first()

const replayStatement = (db, { actorId, operation, key, hash, importId, now }) => db.prepare(
  `INSERT INTO historical_request_replays
   (actor_staff_id,operation,idempotency_key,request_hash,import_id,
    historical_client_id,response_envelope,created_at)
   VALUES (?,?,?,?,?,NULL,NULL,?)`,
).bind(actorId, operation, key, hash, importId, now)

const authorityInvariant = (db, actor) => db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'historical_projection_authority_changed' WHERE NOT EXISTS (
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

const validateCommand = (input, { allowZero = false } = {}) => {
  const command = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.freeze({ ...input }) : null
  if (!authorize(command?.actor, 'finance.import', CENTRE_RESOURCE, {
    nowMs: command?.nowMs,
  })) fail('NOT_FOUND')
  if (!command || !command.db?.prepare || !command.db?.batch || !command.keyring
    || typeof command.actor.id !== 'string'
    || command.config?.appEnv !== 'staging' || command.config?.dataMode !== 'fictional'
    || command.centreId !== 'centre_1' || typeof command.importId !== 'string'
    || !IMPORT_ID.test(command.importId) || !Number.isSafeInteger(command.expectedVersion)
    || command.expectedVersion < (allowZero ? 0 : 1)
    || typeof command.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey)
    || typeof command.idFactory !== 'function') fail()
  return command
}

const createJob = async (command, state, requestHash, now) => {
  if (command.expectedVersion !== 0) fail('VERSION_CONFLICT')
  const total = await eligibleCount(command.db, command.importId)
  const id = made(command.idFactory, 'hpj', /^hpj_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
  try {
    await command.db.batch([
      command.db.prepare(`INSERT INTO historical_projection_jobs
      (id,import_id,status,after_source_record_id,total_records,processed_records,
       projected_records,conflict_count,created_by_staff_id,correlation_id,version,
       created_at,updated_at,completed_at)
      VALUES (?,?,'ready',NULL,?,0,0,0,?,?,1,?,?,NULL)`).bind(
        id, command.importId, total, state.created_by_staff_id, state.correlation_id, now, now,
      ),
      replayStatement(command.db, {
        actorId: command.actor.id, operation: 'historical.continue',
        key: command.idempotencyKey, hash: requestHash, importId: command.importId, now,
      }),
      authorityInvariant(command.db, command.actor),
    ])
  } catch (error) {
    const replay = await replayRow(
      command.db, command.actor.id, 'historical.continue', command.idempotencyKey,
    )
    if (replay && replay.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
    const winner = await loadState(command.db, command.actor.id, command.importId)
    if (winner.job_id === null) throw error
    return response(winner, replay ? 201 : 200)
  }
  return response(await loadState(command.db, command.actor.id, command.importId), 201)
}

const sourceRows = async (db, state) => {
  const rows = (await db.prepare(
    `SELECT source.id AS source_record_id,source.source_key,source.sheet_name,
            source.row_number,source.record_type,source.period_precision,
            source.period_month,source.occurred_on,source.record_digest,
            source.record_digest_hmac_version,source.specialist_source_digest,
            source.specialist_source_hmac_version,source.source_payload_envelope,
            entry.specialist_id,
            conflict.id AS conflict_id,conflict.kind AS conflict_kind,
            resolution.classification AS resolution_classification,
            resolution.existing_historical_client_id,
            resolution.existing_counterparty_id,resolution.service_id AS resolution_service_id,
            CASE WHEN source.id>? THEN 1 ELSE 0 END AS is_new
     FROM workbook_source_records AS source
     JOIN finance_source_links AS link ON link.source_record_id=source.id
     JOIN finance_entries AS entry ON entry.id=link.finance_entry_id
     LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=entry.id
     LEFT JOIN historical_service_occurrences AS occurrence
       ON occurrence.source_record_id=source.id
     LEFT JOIN historical_projection_conflicts AS conflict
       ON conflict.job_id=? AND conflict.source_record_id=source.id
     LEFT JOIN historical_conflict_resolutions AS resolution
       ON resolution.conflict_id=conflict.id
     WHERE source.import_id=? AND source.disposition='accepted'
       AND source.record_type='income' AND entry.kind='income'
       AND entry.specialist_id IS NOT NULL AND void.id IS NULL AND occurrence.id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM historical_projection_conflicts AS unresolved
         WHERE unresolved.job_id=? AND unresolved.source_record_id=source.id
           AND NOT EXISTS (SELECT 1 FROM historical_conflict_resolutions AS answer
             WHERE answer.conflict_id=unresolved.id)
       )
       AND NOT EXISTS (
         SELECT 1 FROM historical_projection_conflicts AS excluded
         JOIN historical_conflict_resolutions AS answer ON answer.conflict_id=excluded.id
         WHERE excluded.job_id=? AND excluded.source_record_id=source.id
           AND answer.classification='exclude'
       )
       AND (source.id>? OR resolution.id IS NOT NULL)
     ORDER BY is_new,source.id
     LIMIT ?`,
  ).bind(
    state.after_source_record_id ?? '', state.job_id, state.import_id, state.job_id,
    state.job_id, state.after_source_record_id ?? '', HISTORICAL_PROJECTION_SLICE_SIZE + 1,
  ).all()).results
  if (!Array.isArray(rows) || rows.length > HISTORICAL_PROJECTION_SLICE_SIZE + 1) fail()
  if (rows.length > HISTORICAL_PROJECTION_SLICE_SIZE) rows.pop()
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.source_record_id)) fail()
    seen.add(row.source_record_id)
  }
  return rows
}

const dataKeyFrom = (row) => Object.freeze(Object.fromEntries(DATA_KEY_COLUMNS.map(
  (key) => [key, row[`key_${key}`]],
)))

const loadIdentities = async (db, keyring, now) => {
  const clients = (await db.prepare(
    `SELECT subject.id,subject.identity_envelope,
            key.id AS key_id,key.scope_type AS key_scope_type,key.scope_id AS key_scope_id,
            key.purpose AS key_purpose,key.dek_version AS key_dek_version,
            key.wrapped_key_b64 AS key_wrapped_key_b64,
            key.wrap_nonce_b64 AS key_wrap_nonce_b64,key.kek_version AS key_kek_version,
            key.created_at AS key_created_at,key.retired_at AS key_retired_at
     FROM historical_clients AS subject
     JOIN data_keys AS key
       ON key.id=json_extract(subject.identity_envelope,'$.dataKeyId')
      AND key.dek_version=json_extract(subject.identity_envelope,'$.dataKeyVersion')
     ORDER BY subject.id LIMIT 1001`,
  ).all()).results
  const counterparties = (await db.prepare(
    `SELECT subject.id,subject.identity_envelope,
            key.id AS key_id,key.scope_type AS key_scope_type,key.scope_id AS key_scope_id,
            key.purpose AS key_purpose,key.dek_version AS key_dek_version,
            key.wrapped_key_b64 AS key_wrapped_key_b64,
            key.wrap_nonce_b64 AS key_wrap_nonce_b64,key.kek_version AS key_kek_version,
            key.created_at AS key_created_at,key.retired_at AS key_retired_at
     FROM historical_counterparties AS subject
     JOIN data_keys AS key
       ON key.id=json_extract(subject.identity_envelope,'$.dataKeyId')
      AND key.dek_version=json_extract(subject.identity_envelope,'$.dataKeyVersion')
     ORDER BY subject.id LIMIT 1001`,
  ).all()).results
  if (!Array.isArray(clients) || !Array.isArray(counterparties)
    || clients.length > 1_000 || counterparties.length > 1_000) fail('WORKSPACE_RESULT_LIMIT')
  const aliases = (await db.prepare(
    `SELECT 'person' AS kind,historical_client_id AS subject_id,hmac_version,lookup_digest
     FROM historical_client_lookup_aliases
     UNION ALL
     SELECT 'counterparty',counterparty_id,hmac_version,lookup_digest
     FROM historical_counterparty_lookup_aliases
     ORDER BY kind,subject_id,hmac_version LIMIT 5001`,
  ).all()).results
  if (!Array.isArray(aliases) || aliases.length > 5_000) fail('WORKSPACE_RESULT_LIMIT')
  const records = { person: new Map(), counterparty: new Map() }
  for (const [kind, rows] of [['person', clients], ['counterparty', counterparties]]) {
    for (const row of rows) {
      const name = await decryptHistoricalIdentityWithDataKey(keyring, {
        kind, id: row.id, envelope: row.identity_envelope, dataKey: dataKeyFrom(row),
      })
      records[kind].set(row.id, Object.freeze({
        id: row.id, name, canonical: canonicalHistoricalName(name),
        identityEnvelope: row.identity_envelope, dataKey: dataKeyFrom(row),
      }))
    }
  }
  const exact = { person: new Map(), counterparty: new Map() }
  const aliasesByRecord = { person: new Map(), counterparty: new Map() }
  for (const alias of aliases) {
    const record = records[alias.kind]?.get(alias.subject_id)
    if (!record || !Number.isSafeInteger(alias.hmac_version) || alias.hmac_version < 1
      || typeof alias.lookup_digest !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(alias.lookup_digest)) fail('CRYPTO_FAILURE')
    let recordAliases = aliasesByRecord[alias.kind].get(alias.subject_id)
    if (!recordAliases) {
      recordAliases = new Map()
      aliasesByRecord[alias.kind].set(alias.subject_id, recordAliases)
    }
    if (recordAliases.has(alias.hmac_version)) fail('CRYPTO_FAILURE')
    recordAliases.set(alias.hmac_version, alias.lookup_digest)
    const key = `${alias.hmac_version}:${alias.lookup_digest}`
    const existing = exact[alias.kind].get(key)
    if (existing && existing.id !== record.id) fail('HISTORICAL_IDENTITY_AMBIGUOUS')
    exact[alias.kind].set(key, record)
  }
  const pendingAliases = new Map()
  for (const [kind, kindRecords] of Object.entries(records)) {
    for (const record of kindRecords.values()) {
      const recordAliases = aliasesByRecord[kind].get(record.id) ?? new Map()
      const candidates = await historicalIdentityLookupCandidates(
        keyring, kind, record.name,
      )
      const statements = []
      for (const candidate of candidates) {
        const key = `${candidate.version}:${candidate.digest}`
        const existing = exact[kind].get(key)
        if (existing && existing.id !== record.id) fail('HISTORICAL_IDENTITY_AMBIGUOUS')
        exact[kind].set(key, record)
        const storedDigest = recordAliases.get(candidate.version)
        if (storedDigest && storedDigest !== candidate.digest) fail('CRYPTO_FAILURE')
        if (storedDigest) continue
        const table = kind === 'person'
          ? 'historical_client_lookup_aliases' : 'historical_counterparty_lookup_aliases'
        const subjectColumn = kind === 'person' ? 'historical_client_id' : 'counterparty_id'
        statements.push(db.prepare(`INSERT OR IGNORE INTO ${table}
          (${subjectColumn},domain,hmac_version,lookup_digest,created_at)
          VALUES (?,?,?,?,?)`).bind(
          record.id, candidate.domain, candidate.version, candidate.digest, now,
        ))
        statements.push(db.prepare(`INSERT INTO core_directory_invariant_failures
          (failure_kind) SELECT 'historical_lookup_alias_collision'
          WHERE NOT EXISTS (SELECT 1 FROM ${table}
            WHERE ${subjectColumn}=? AND domain=? AND hmac_version=? AND lookup_digest=?)`).bind(
          record.id, candidate.domain, candidate.version, candidate.digest,
        ))
      }
      if (statements.length) pendingAliases.set(`${kind}:${record.id}`, statements)
    }
  }
  return { records, exact, pendingAliases }
}

const takePendingAliasStatements = (identities, kind, id) => {
  const key = `${kind}:${id}`
  const statements = identities.pendingAliases.get(key) ?? []
  identities.pendingAliases.delete(key)
  return statements
}

const seal = (keyring, dataKey, scope, recordId, field, value) => encryptForScope(
  keyring, dataKey, {
    expectedScope: scope, recordId, field,
    plaintext: typeof value === 'string' ? value : JSON.stringify(value),
  },
).then(JSON.stringify)

const recordVersionStatement = (db, {
  id, entityType, entityId, version, snapshotEnvelope, actorId, now, correlationId,
}) => db.prepare(`INSERT INTO record_versions
  (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
   changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
  id, entityType, entityId, version, snapshotEnvelope, actorId, now, correlationId,
)

const exactRecord = async (identities, keyring, kind, name) => {
  const candidates = await historicalIdentityLookupCandidates(keyring, kind, name)
  const matches = new Map()
  for (const candidate of candidates) {
    const record = identities.exact[kind].get(`${candidate.version}:${candidate.digest}`)
    if (record) matches.set(record.id, record)
  }
  if (matches.size > 1) fail('HISTORICAL_IDENTITY_AMBIGUOUS')
  return [...matches.values()][0] ?? null
}

const nearRecords = (records, name) => [...records.values()].filter(
  (record) => historicalNamesRequireReview(record.name, name),
).sort((left, right) => compareUtf16CodeUnits(left.id, right.id))

const preparedIdentity = async ({ command, identities, kind, name, correlationId, now }) => {
  const existing = await exactRecord(identities, command.keyring, kind, name)
  if (existing) return Object.freeze({ ...existing, isNew: false, statements: [] })
  const prefix = kind === 'person' ? 'hcl' : 'hcp'
  const id = made(command.idFactory, prefix, kind === 'person'
    ? /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
    : /^hcp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
  const built = await buildHistoricalIdentity(command.db, command.keyring, {
    kind, id,
    dataKeyId: made(command.idFactory, 'key', /^key_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
    name, createdAt: now,
  })
  const scope = kind === 'person'
    ? { type: 'historical_client', id, purpose: 'identity' }
    : { type: 'historical_counterparty', id, purpose: 'identity' }
  const snapshot = kind === 'person'
    ? { schema: 'historical_client.v1', id, name, status: 'historical', activeClientId: null,
      version: 1, createdAt: now, updatedAt: now }
    : { schema: 'historical_counterparty.v1', id, name, version: 1,
      createdAt: now, updatedAt: now }
  const statements = [built.keyStatement]
  if (kind === 'person') statements.push(command.db.prepare(`INSERT INTO historical_clients
    (id,identity_envelope,status,active_client_id,version,created_at,updated_at)
    VALUES (?,?,'historical',NULL,1,?,?)`).bind(id, built.identityEnvelope, now, now))
  else statements.push(command.db.prepare(`INSERT INTO historical_counterparties
    (id,identity_envelope,version,created_at,updated_at) VALUES (?,?,1,?,?)`).bind(
    id, built.identityEnvelope, now, now,
  ))
  for (const lookup of built.lookups) {
    statements.push(kind === 'person'
      ? command.db.prepare(`INSERT INTO historical_client_lookup_aliases
        (historical_client_id,domain,hmac_version,lookup_digest,created_at)
        VALUES (?,?,?,?,?)`).bind(id, lookup.domain, lookup.version, lookup.digest, now)
      : command.db.prepare(`INSERT INTO historical_counterparty_lookup_aliases
        (counterparty_id,domain,hmac_version,lookup_digest,created_at)
        VALUES (?,?,?,?,?)`).bind(id, lookup.domain, lookup.version, lookup.digest, now))
    identities.exact[kind].set(`${lookup.version}:${lookup.digest}`, null)
  }
  statements.push(recordVersionStatement(command.db, {
    id: made(command.idFactory, 'ver', /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
    entityType: kind === 'person' ? 'historical_client' : 'historical_counterparty',
    entityId: id, version: 1,
    snapshotEnvelope: await seal(command.keyring, built.dataKey, scope, id, 'snapshot', snapshot),
    actorId: command.actor.id, now, correlationId,
  }))
  const record = Object.freeze({
    id, name, canonical: canonicalHistoricalName(name),
    identityEnvelope: built.identityEnvelope, dataKey: built.dataKey,
  })
  identities.records[kind].set(id, record)
  for (const lookup of built.lookups) {
    identities.exact[kind].set(`${lookup.version}:${lookup.digest}`, record)
  }
  return Object.freeze({ ...record, isNew: true, statements })
}

const conflictStatement = async ({ command, sourceKey, state, row, kind, context, now }) => {
  const id = made(command.idFactory, 'hcf', /^hcf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)
  return command.db.prepare(`INSERT INTO historical_projection_conflicts
    (id,job_id,source_record_id,kind,context_envelope,created_by_staff_id,
     correlation_id,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(
    id, state.job_id, row.source_record_id, kind,
    await seal(command.keyring, sourceKey, WORKBOOK_SOURCE_SCOPE, id, 'conflict_context', {
      schema: 'historical_projection_conflict.v1', ...context,
    }), command.actor.id, state.correlation_id, now,
  )
}

const materializeRow = async ({
  command, state, row, payload, identities, specialistMappings, now,
}) => {
  const value = payload.normalized
  if (await resolveAuthenticatedWorkbookSpecialist({
    keyring: command.keyring, config: command.config, centreId: command.centreId,
    mappings: specialistMappings, row, payload,
  }) !== row.specialist_id) {
    fail('CRYPTO_FAILURE')
  }
  const decision = historicalProjectionDecision({
    ...value, specialistId: row.specialist_id, financeLinked: true, voided: false,
  })
  if (!decision.eligible) return { statements: [], projected: 0, conflict: 0 }
  const resolution = row.conflict_id ? {
    classification: row.resolution_classification,
    existingHistoricalClientId: row.existing_historical_client_id,
    existingCounterpartyId: row.existing_counterparty_id,
    serviceId: row.resolution_service_id,
  } : null
  if (row.conflict_id && !resolution.classification) fail()
  const classification = resolution?.classification ?? decision.classification
  const serviceId = resolution ? resolution.serviceId : decision.serviceId
  if (classification === 'exclude') return { statements: [], projected: 0, conflict: 0 }
  const targetKind = classification === 'person' ? 'person'
    : classification === 'counterparty' ? 'counterparty' : null
  let conflictKind = resolution ? null : decision.conflictKind
  let chosen = null
  if (targetKind && resolution) {
    const explicitId = targetKind === 'person'
      ? resolution.existingHistoricalClientId : resolution.existingCounterpartyId
    if (explicitId) {
      chosen = identities.records[targetKind].get(explicitId)
      if (!chosen) fail('NOT_FOUND')
    }
  }
  if (targetKind && !chosen) chosen = await exactRecord(
    identities, command.keyring, targetKind, value.counterparty,
  )
  const near = targetKind && !chosen
    ? nearRecords(identities.records[targetKind], value.counterparty) : []
  if (!resolution && !conflictKind && near.length) conflictKind = 'near_match'
  if (!targetKind || conflictKind) {
    return {
      statements: [await conflictStatement({
        command, sourceKey: state.sourceKey, state, row, kind: conflictKind ?? 'classification',
        context: {
          counterparty: value.counterparty, serviceLabel: value.sourceLabel,
          proposedClassification: decision.classification,
          proposedServiceId: decision.serviceId,
          nearSubjectIds: near.map(({ id }) => id),
        }, now,
      })],
      projected: 0, conflict: 1,
    }
  }
  const subject = chosen ?? await preparedIdentity({
    command, identities, kind: targetKind, name: value.counterparty,
    correlationId: state.correlation_id, now,
  })
  const statements = [
    ...(subject.statements ?? []),
    ...takePendingAliasStatements(identities, targetKind, subject.id),
  ]
  statements.push(targetKind === 'person'
    ? command.db.prepare(`INSERT INTO historical_client_source_links
      (id,historical_client_id,source_record_id,created_at) VALUES (?,?,?,?)`).bind(
      made(command.idFactory, 'hcs', /^hcs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
      subject.id, row.source_record_id, now,
    )
    : command.db.prepare(`INSERT INTO historical_counterparty_source_links
      (id,counterparty_id,source_record_id,created_at) VALUES (?,?,?,?)`).bind(
      made(command.idFactory, 'hps', /^hps_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
      subject.id, row.source_record_id, now,
    ))
  const occurrenceId = made(
    command.idFactory, 'hoc', /^hoc_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  )
  const scope = targetKind === 'person'
    ? { type: 'historical_client', id: subject.id, purpose: 'identity' }
    : { type: 'historical_counterparty', id: subject.id, purpose: 'identity' }
  const occurrence = {
    schema: 'historical_occurrence.v1', id: occurrenceId,
    historicalClientId: targetKind === 'person' ? subject.id : null,
    counterpartyId: targetKind === 'counterparty' ? subject.id : null,
    specialistId: row.specialist_id, serviceId, serviceLabel: value.sourceLabel,
    period: { precision: row.period_precision, day: row.occurred_on, month: row.period_month },
    status: 'recorded', version: 1, sourceRecordId: row.source_record_id,
    createdAt: now, updatedAt: now,
  }
  statements.push(command.db.prepare(`INSERT INTO historical_service_occurrences
    (id,source_record_id,historical_client_id,counterparty_id,specialist_id,service_id,
     service_label_envelope,period_precision,occurred_on,occurred_month,status,version,
     created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'recorded',1,?,?)`).bind(
    occurrenceId, row.source_record_id,
    targetKind === 'person' ? subject.id : null,
    targetKind === 'counterparty' ? subject.id : null,
    row.specialist_id, serviceId,
    await seal(command.keyring, subject.dataKey, scope, occurrenceId, 'service_label',
      value.sourceLabel),
    row.period_precision, row.occurred_on, row.period_month, now, now,
  ))
  statements.push(recordVersionStatement(command.db, {
    id: made(command.idFactory, 'ver', /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
    entityType: 'historical_service_occurrence', entityId: occurrenceId, version: 1,
    snapshotEnvelope: await seal(
      command.keyring, subject.dataKey, scope, occurrenceId, 'snapshot', occurrence,
    ),
    actorId: command.actor.id, now, correlationId: state.correlation_id,
  }))
  return { statements, projected: 1, conflict: 0 }
}

export async function continueHistoricalProjection(input) {
  const command = validateCommand(input, { allowZero: true })
  const now = nowAt(command.nowMs)
  let state = await loadState(command.db, command.actor.id, command.importId)
  const requestHash = await sha256(JSON.stringify([
    1, command.importId, command.expectedVersion, state.plan_envelope,
  ]))
  const replay = await replayRow(
    command.db, command.actor.id, 'historical.continue', command.idempotencyKey,
  )
  if (replay) {
    if (replay.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
    return response(state)
  }
  if (state.job_id === null) return createJob(command, state, requestHash, now)
  if (state.job_version !== command.expectedVersion) fail('VERSION_CONFLICT')
  if (state.job_status === 'complete') return response(state)
  const sourceKey = await loadWorkbookSourceDataKey(command.db, state.plan_envelope)
  const specialistMappings = await loadAuthenticatedWorkbookSpecialistMappings({
    db: command.db, keyring: command.keyring, dataKey: sourceKey,
    importId: command.importId, config: command.config, centreId: command.centreId,
  })
  state = Object.freeze({ ...state, sourceKey })
  const rows = await sourceRows(command.db, state)
  const identities = rows.length
    ? await loadIdentities(command.db, command.keyring, now) : null
  const statements = []
  let projected = 0
  let conflicts = 0
  let processed = 0
  let after = state.after_source_record_id
  for (const row of rows) {
    const payload = await openAuthenticatedWorkbookSource({
      keyring: command.keyring, dataKey: sourceKey, row, config: command.config,
      centreId: command.centreId,
    })
    const result = await materializeRow({
      command, state, row, payload, identities, specialistMappings, now,
    })
    statements.push(...result.statements)
    projected += result.projected
    conflicts += result.conflict
    if (row.is_new === 1) {
      processed += 1
      after = row.source_record_id
    }
  }
  const unresolved = await command.db.prepare(
    `SELECT count(*) AS count FROM historical_projection_conflicts AS conflict
     WHERE conflict.job_id=? AND NOT EXISTS (
       SELECT 1 FROM historical_conflict_resolutions AS resolution
       WHERE resolution.conflict_id=conflict.id)`,
  ).bind(state.job_id).first()
  if (!Number.isSafeInteger(unresolved?.count) || unresolved.count < 0) fail()
  const atEnd = rows.length === 0
  const complete = atEnd && unresolved.count === 0
  const nextStatus = complete ? 'complete'
    : unresolved.count + conflicts > 0 ? 'conflicts' : 'running'
  const nextVersion = state.job_version + 1
  statements.push(command.db.prepare(`UPDATE historical_projection_jobs SET
    status=?,after_source_record_id=?,processed_records=processed_records+?,
    projected_records=projected_records+?,conflict_count=conflict_count+?,
    version=?,updated_at=?,completed_at=?
    WHERE id=? AND version=? AND status IN ('ready','running','conflicts')`).bind(
    nextStatus, after, processed, projected, conflicts, nextVersion, now,
    complete ? now : null, state.job_id, state.job_version,
  ))
  statements.push(command.db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'historical_projection_cas' WHERE changes()!=1`,
  ))
  statements.push(replayStatement(command.db, {
    actorId: command.actor.id, operation: 'historical.continue',
    key: command.idempotencyKey, hash: requestHash, importId: command.importId, now,
  }))
  statements.push(authorityInvariant(command.db, command.actor))
  try {
    await command.db.batch(statements)
  } catch (error) {
    const winner = await replayRow(
      command.db, command.actor.id, 'historical.continue', command.idempotencyKey,
    )
    if (winner) {
      if (winner.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
    } else {
      const current = await loadState(command.db, command.actor.id, command.importId)
      if (current.job_version !== state.job_version) fail('VERSION_CONFLICT')
      throw error
    }
  }
  return response(await loadState(command.db, command.actor.id, command.importId))
}

export async function getHistoricalProjection({ db, actor, importId, keyring } = {}) {
  if (!db?.prepare || !authorize(actor, 'finance.import', CENTRE_RESOURCE, { nowMs: 0 })
    || typeof importId !== 'string' || !IMPORT_ID.test(importId)) fail('NOT_FOUND')
  const state = await loadState(db, actor.id, importId)
  const projection = jobDto(state)
  const conflicts = await unresolvedConflictDtos({ db, keyring, state })
  return Object.freeze({ data: Object.freeze({ projection, conflicts }) })
}

export async function resolveHistoricalConflict(input) {
  const command = validateCommand({
    ...input, expectedVersion: input?.body?.expectedJobVersion,
  })
  const body = input.body
  const now = nowAt(command.nowMs)
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 5
    || !['expectedJobVersion', 'conflictId', 'classification', 'existingSubjectId', 'serviceId']
      .every((key) => Object.hasOwn(body, key))
    || !/^hcf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(body.conflictId)
    || !['person', 'counterparty', 'exclude'].includes(body.classification)
    || !(body.existingSubjectId === null
      || /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(body.existingSubjectId)
      || /^hcp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(body.existingSubjectId))
    || !(body.serviceId === null || SERVICES.some(({ id }) => id === body.serviceId))
    || (body.classification === 'person' && body.existingSubjectId !== null
      && !body.existingSubjectId.startsWith('hcl_'))
    || (body.classification === 'counterparty' && body.existingSubjectId !== null
      && !body.existingSubjectId.startsWith('hcp_'))
    || (body.classification === 'exclude'
      && (body.existingSubjectId !== null || body.serviceId !== null))) fail()
  const requestHash = await sha256(JSON.stringify([1, command.importId, body]))
  const replay = await replayRow(
    command.db, command.actor.id, 'historical.resolve', command.idempotencyKey,
  )
  if (replay) {
    if (replay.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
    return response(await loadState(command.db, command.actor.id, command.importId))
  }
  const state = await loadState(command.db, command.actor.id, command.importId)
  if (state.job_id === null || state.job_status === 'complete'
    || state.job_version !== body.expectedJobVersion) fail('VERSION_CONFLICT')
  const conflict = await command.db.prepare(
    `SELECT conflict.id FROM historical_projection_conflicts AS conflict
     WHERE conflict.id=? AND conflict.job_id=? AND NOT EXISTS (
       SELECT 1 FROM historical_conflict_resolutions AS resolution
       WHERE resolution.conflict_id=conflict.id)`,
  ).bind(body.conflictId, state.job_id).first()
  if (!conflict) fail('NOT_FOUND')
  if (body.existingSubjectId !== null) {
    const table = body.classification === 'person'
      ? 'historical_clients' : 'historical_counterparties'
    const exists = await command.db.prepare(`SELECT id FROM ${table} WHERE id=?`)
      .bind(body.existingSubjectId).first()
    if (!exists) fail('NOT_FOUND')
  }
  const nextVersion = state.job_version + 1
  const resolutionId = made(
    command.idFactory, 'hcr', /^hcr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  )
  try {
    await command.db.batch([
      command.db.prepare(`INSERT INTO historical_conflict_resolutions
        (id,conflict_id,classification,existing_historical_client_id,
         existing_counterparty_id,service_id,resolved_by_staff_id,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).bind(
        resolutionId, body.conflictId, body.classification,
        body.classification === 'person' ? body.existingSubjectId : null,
        body.classification === 'counterparty' ? body.existingSubjectId : null,
        body.serviceId, command.actor.id, now,
      ),
      command.db.prepare(`UPDATE historical_projection_jobs SET status='running',
        version=?,updated_at=? WHERE id=? AND version=? AND status='conflicts'`).bind(
        nextVersion, now, state.job_id, state.job_version,
      ),
      command.db.prepare(`INSERT INTO core_directory_invariant_failures (failure_kind)
        SELECT 'historical_resolution_cas' WHERE changes()!=1`),
      replayStatement(command.db, {
        actorId: command.actor.id, operation: 'historical.resolve',
        key: command.idempotencyKey, hash: requestHash, importId: command.importId, now,
      }),
      authorityInvariant(command.db, command.actor),
    ])
  } catch (error) {
    const winner = await replayRow(
      command.db, command.actor.id, 'historical.resolve', command.idempotencyKey,
    )
    if (winner) {
      if (winner.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
      return response(await loadState(
        command.db, command.actor.id, command.importId,
      ), 201)
    }
    const current = await loadState(command.db, command.actor.id, command.importId)
    if (current.job_version !== state.job_version) fail('VERSION_CONFLICT')
    throw error
  }
  return response(await loadState(command.db, command.actor.id, command.importId), 201)
}
