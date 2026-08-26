import {
  financeEntryDto,
  financeMonthSummary,
  validateFinanceEntryInput,
  validateFinanceImport,
} from '../../src/finance-records.js'
import { auditEventStatement } from '../audit/events.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectIdempotency,
} from '../db/unit-of-work.js'
import {
  isD1FinanceSourceDuplicate,
} from '../db/errors.js'
import { authorize } from '../identity/policy.js'
import {
  blindEmailIndex,
  blindEmailCandidates,
  createWrappedDataKey,
  decryptForScope,
  encryptForScope,
} from '../security/envelope.js'

export const FINANCE_SCOPE = Object.freeze({
  type: 'centre_finance', id: 'centre_1', purpose: 'ledger',
})

const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const DATA_KEY_COLUMNS = `id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,
  wrap_nonce_b64,kek_version,created_at,retired_at`
const BATCH_ID = /^fib_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ENTRY_ID = /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CHUNK_ID = /^fic_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const AUDIT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const DATA_KEY_ID = /^key_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const SOURCE_KEY = /^workbook:v1:(\d{1,4}):(\d{1,6}):(\d{1,4})$/
const KINDS = new Set(['expense', 'income'])
const MAX_CHUNK_ROWS = 20
const DAY_MS = 86_400_000

const fail = (code = 'INTERNAL_ERROR') => { throw new Error(code) }
const validation = (field = 'body') => { throw new TypeError(`VALIDATION_FAILED/${field}`) }
const exact = (value, keys, field = 'body') => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) validation(field)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length || !keys.every((key) => actual.includes(key))) {
      validation(field)
    }
    const result = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) validation(field)
      result[key] = descriptor.value
    }
    return result
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('VALIDATION_FAILED/')) throw error
    validation(field)
  }
}

const actorFact = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('NOT_FOUND')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actor = {}
    for (const key of ['id', 'role', 'specialistId']) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('NOT_FOUND')
      actor[key] = descriptor.value
    }
    if (typeof actor.id !== 'string' || !STAFF_ID.test(actor.id)
      || !['owner', 'coordinator', 'specialist'].includes(actor.role)
      || (actor.specialistId !== null
        && (typeof actor.specialistId !== 'string' || !SPECIALIST_ID.test(actor.specialistId)))
      || (actor.role === 'specialist' && actor.specialistId === null)
      || (!authorize(actor, 'finance.centre.read', CENTRE, { nowMs: 0 })
        && !authorize(actor, 'finance.centre.manage', CENTRE, { nowMs: 0 }))) fail('NOT_FOUND')
    return Object.freeze(actor)
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') throw error
    fail('NOT_FOUND')
  }
}

const requireRead = (actor, nowMs) => {
  if (!authorize(actor, 'finance.centre.read', CENTRE, { nowMs })) fail('NOT_FOUND')
}

const requireManage = (actor, nowMs) => {
  if (!authorize(actor, 'finance.centre.manage', CENTRE, { nowMs })) fail('NOT_FOUND')
}

const canonicalInstant = (nowMs) => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail()
  try { return new Date(nowMs).toISOString() } catch { fail() }
}

const validDependency = (db, keyring, correlationId, idFactory) => {
  if (!db?.prepare || !db?.batch || !keyring || typeof correlationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(correlationId)
    || (idFactory !== undefined && typeof idFactory !== 'function')) fail()
}

const generated = (idFactory, prefix, pattern) => {
  let value
  try { value = `${prefix}_${idFactory()}` } catch { fail() }
  if (!pattern.test(value)) fail()
  return value
}

const keyRow = async (db) => db.prepare(
  `SELECT ${DATA_KEY_COLUMNS} FROM data_keys
   WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1`
).bind(FINANCE_SCOPE.type, FINANCE_SCOPE.id, FINANCE_SCOPE.purpose).first()

const createFinanceContext = async (db, keyring, idFactory, now) => {
  const current = await keyRow(db)
  if (current) return Object.freeze({ keyring, dataKey: current, scope: FINANCE_SCOPE, statement: null })
  const dataKey = await createWrappedDataKey(keyring, {
    scope: FINANCE_SCOPE,
    id: generated(idFactory, 'key', DATA_KEY_ID),
    createdAt: now,
  })
  const statement = db.prepare(
    `INSERT INTO data_keys
     (id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
      kek_version,created_at,retired_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    dataKey.id, dataKey.scope_type, dataKey.scope_id, dataKey.purpose,
    dataKey.dek_version, dataKey.wrapped_key_b64, dataKey.wrap_nonce_b64,
    dataKey.kek_version, dataKey.created_at, dataKey.retired_at,
  )
  return Object.freeze({ keyring, dataKey, scope: FINANCE_SCOPE, statement })
}

const loadFinanceContext = async (db, keyring) => {
  const dataKey = await keyRow(db)
  if (!dataKey) fail('CRYPTO_FAILURE')
  return Object.freeze({ keyring, dataKey, scope: FINANCE_SCOPE })
}

const seal = async (context, recordId, field, value) => JSON.stringify(await encryptForScope(
  context.keyring,
  context.dataKey,
  { expectedScope: context.scope, recordId, field, plaintext: JSON.stringify(value) },
))

const open = async (context, recordId, field, value) => {
  try {
    return JSON.parse(await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope, recordId, field, envelope: JSON.parse(value),
    }))
  } catch { fail('CRYPTO_FAILURE') }
}

const batchDto = (row, filename = undefined) => Object.freeze({
  id: row.id,
  fingerprint: row.fingerprint,
  ...(filename === undefined ? {} : { filename }),
  formatVersion: row.format_version,
  totalRows: row.total_rows,
  acceptedRows: row.accepted_rows,
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  committedAt: row.committed_at,
})

const loadBatch = async (db, batchId) => {
  if (typeof batchId !== 'string' || !BATCH_ID.test(batchId)) validation('batchId')
  const row = await db.prepare(
    `SELECT id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,
            status,version,created_at,updated_at,committed_at
     FROM finance_import_batches WHERE id=?`
  ).bind(batchId).first()
  if (!row) fail('NOT_FOUND')
  return row
}

const audit = (db, { id, now, actorId, action, entityId, correlationId, metadata }) => (
  auditEventStatement(db, {
    id, occurredAt: now, actorStaffId: actorId, action,
    entityType: action.startsWith('finance.import') ? 'finance_import' : 'finance_entry',
    entityId, result: 'success', correlationId, metadata, reasonEnvelope: null,
  })
)

const batchGuard = (db, {
  batchId, status, acceptedRows, version, auditId, action, actorId, correlationId, metadata,
}) => db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'finance_batch_postcondition'
   WHERE NOT (
     EXISTS (SELECT 1 FROM finance_import_batches
       WHERE id=? AND status=? AND accepted_rows=? AND version=?)
     AND EXISTS (SELECT 1 FROM audit_events
       WHERE id=? AND action=? AND entity_type='finance_import' AND entity_id=?
         AND actor_staff_id=? AND correlation_id=? AND result='success'
         AND metadata_json=?))`
).bind(
  batchId, status, acceptedRows, version,
  auditId, action, batchId, actorId, correlationId,
  JSON.stringify(Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)))),
)

const responseForBatch = (status, batch) => Object.freeze({
  status,
  body: Object.freeze({ data: Object.freeze({ batch: Object.freeze(batch) }) }),
})

const idempotencyInput = (actorId, operation, idempotencyKey, requestDigest) => Object.freeze({
  actorId, operation, idempotencyKey, requestDigest, expectedScope: FINANCE_SCOPE,
})

const sourceBlock = (source) => {
  const match = SOURCE_KEY.exec(source.sourceKey)
  if (!match || Number(match[2]) !== source.rowNumber) validation('body')
  return Number(match[3])
}

const sourceIdentity = (value) => JSON.stringify([
  value.kind,
  value.recordType,
  value.accountingMonth,
  value.occurredOn,
  value.amountGrosze,
  value.paidAmountGrosze,
  value.paymentMethod,
  value.settlementStatus,
  value.invoiceStatus,
  value.counterparty,
  value.sourceLabel,
  value.invoiceNote,
  value.specialistId,
  value.lessonCount,
  value.source.rowNumber,
  sourceBlock(value.source),
])

export async function startFinanceImport(input) {
  const command = exact(input, [
    'db', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory', 'body',
    'idempotencyKey',
  ], 'input')
  validDependency(command.db, command.keyring, command.correlationId, command.idFactory)
  const actor = actorFact(command.actor)
  requireManage(actor, command.nowMs)
  if (!IDEMPOTENCY_KEY.test(command.idempotencyKey ?? '')) validation('body')
  const body = validateFinanceImport(command.body)
  const now = canonicalInstant(command.nowMs)
  const context = await createFinanceContext(command.db, command.keyring, command.idFactory, now)
  const idem = idempotencyInput(
    actor.id, 'finance.import.start', command.idempotencyKey, JSON.stringify(body),
  )
  const replay = await inspectIdempotency(command.db, context, idem)
  if (replay) return replay
  const duplicate = await command.db.prepare(
    'SELECT id FROM finance_import_batches WHERE fingerprint=?'
  ).bind(body.fingerprint).first()
  if (duplicate) fail('FINANCE_IMPORT_DUPLICATE')
  const batchId = generated(command.idFactory, 'fib', BATCH_ID)
  const auditId = generated(command.idFactory, 'aud', AUDIT_ID)
  const filenameEnvelope = await seal(context, batchId, 'filename', {
    schema: 'finance_import_filename.v1', filename: body.filename,
  })
  const metadata = Object.freeze({ batchVersion: 1, rowCount: body.totalRows })
  const row = {
    id: batchId, fingerprint: body.fingerprint, filename_envelope: filenameEnvelope,
    format_version: body.formatVersion, total_rows: body.totalRows, accepted_rows: 0,
    status: 'importing', version: 1, created_at: now, updated_at: now, committed_at: null,
  }
  const response = responseForBatch(201, batchDto(row, body.filename))
  const unit = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  if (context.statement) unit.domain(context.statement)
  unit.domain(command.db.prepare(
    `INSERT INTO finance_import_batches
     (id,fingerprint,filename_envelope,format_version,total_rows,accepted_rows,status,
      created_by_staff_id,version,created_at,updated_at,committed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    batchId, body.fingerprint, filenameEnvelope, body.formatVersion, body.totalRows,
    0, 'importing', actor.id, 1, now, now, null,
  ))
  unit.audit(audit(command.db, {
    id: auditId, now, actorId: actor.id, action: 'finance.import.started',
    entityId: batchId, correlationId: command.correlationId, metadata,
  }))
  unit.idempotency(await createIdempotencyStatement(command.db, context, {
    ...idem, resourceType: 'finance_import', resourceId: batchId, response,
    createdAt: now, expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  }))
  unit.guard(batchGuard(command.db, {
    batchId, status: 'importing', acceptedRows: 0, version: 1,
    auditId, action: 'finance.import.started', actorId: actor.id,
    correlationId: command.correlationId, metadata,
  }))
  try {
    await unit.commit()
  } catch (error) {
    const winner = await inspectIdempotency(command.db, context, idem)
    if (winner) return winner
    const existing = await command.db.prepare(
      'SELECT id FROM finance_import_batches WHERE fingerprint=?'
    ).bind(body.fingerprint).first()
    if (existing) fail('FINANCE_IMPORT_DUPLICATE')
    throw error
  }
  return response
}

const validateChunkBody = (value) => {
  const body = exact(value, ['sequence', 'entries'])
  if (!Number.isSafeInteger(body.sequence) || body.sequence < 0 || body.sequence > 9999
    || !Array.isArray(body.entries) || body.entries.length < 1
    || body.entries.length > MAX_CHUNK_ROWS) validation('body')
  return Object.freeze({
    sequence: body.sequence,
    entries: Object.freeze(body.entries.map((entry) => validateFinanceEntryInput(entry))),
  })
}

const hashChunk = async (body) => {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('')
  } finally {
    bytes.fill(0)
    digest?.fill(0)
  }
}

export async function appendFinanceImportChunk(input) {
  const command = exact(input, [
    'db', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory', 'batchId',
    'body', 'idempotencyKey',
  ], 'input')
  validDependency(command.db, command.keyring, command.correlationId, command.idFactory)
  const actor = actorFact(command.actor)
  requireManage(actor, command.nowMs)
  if (!IDEMPOTENCY_KEY.test(command.idempotencyKey ?? '')) validation('body')
  if (typeof command.batchId !== 'string' || !BATCH_ID.test(command.batchId)) {
    validation('batchId')
  }
  const body = validateChunkBody(command.body)
  if (body.entries.some((entry) => entry.source?.batchId !== command.batchId)) {
    validation('body')
  }
  const payloadHash = await hashChunk(body)
  const loadReplay = () => command.db.prepare(
    `SELECT chunk.sequence,chunk.row_count,chunk.payload_hash,
            batch.id,batch.fingerprint,batch.format_version,batch.total_rows,
            batch.accepted_rows,batch.status,batch.version,batch.created_at,
            batch.updated_at,batch.committed_at
     FROM finance_import_chunks AS chunk
     JOIN finance_import_batches AS batch ON batch.id=chunk.batch_id
     WHERE chunk.batch_id=? AND chunk.idempotency_key=?`
  ).bind(command.batchId, command.idempotencyKey).first()
  const replay = await loadReplay()
  if (replay) {
    if (replay.sequence !== body.sequence || replay.row_count !== body.entries.length
      || replay.payload_hash !== payloadHash) fail('IDEMPOTENCY_CONFLICT')
    return responseForBatch(200, batchDto(replay))
  }
  const current = await loadBatch(command.db, command.batchId)
  if (current.status !== 'importing') fail('FINANCE_IMPORT_CLOSED')
  if (current.accepted_rows + body.entries.length > current.total_rows) {
    fail('FINANCE_IMPORT_OVERFLOW')
  }
  const now = canonicalInstant(command.nowMs)
  const context = await loadFinanceContext(command.db, command.keyring)
  const lookupSets = await Promise.all(body.entries.map(async (value) => {
    const identity = sourceIdentity(value)
    const candidates = await blindEmailCandidates(identity, command.keyring)
    const active = await blindEmailIndex(identity, command.keyring)
    if (!candidates.includes(active)) fail('CRYPTO_FAILURE')
    return Object.freeze({ active, candidates: Object.freeze(candidates) })
  }))
  const lookupCandidates = [...new Set(lookupSets.flatMap(({ candidates }) => candidates))]
  if (lookupCandidates.length !== lookupSets.reduce(
    (total, { candidates }) => total + candidates.length, 0
  )) fail('FINANCE_IMPORT_DUPLICATE')
  const existingSource = await command.db.prepare(
    `SELECT id FROM finance_entries
     WHERE source_dedup_lookup IN (${lookupCandidates.map(() => '?').join(',')})
     LIMIT 1`
  ).bind(...lookupCandidates).first()
  if (existingSource) fail('FINANCE_IMPORT_DUPLICATE')
  const entries = []
  for (const [index, value] of body.entries.entries()) {
    const id = generated(command.idFactory, 'fin', ENTRY_ID)
    const detailsEnvelope = await seal(context, id, 'details', {
      schema: 'finance_entry_details.v1',
      counterparty: value.counterparty,
      sourceLabel: value.sourceLabel,
      invoiceNote: value.invoiceNote,
      lessonCount: value.lessonCount,
    })
    const sourceEnvelope = await seal(context, id, 'source_row', {
      schema: 'finance_entry_source.v1', source: value.source,
    })
    const sourceLookup = lookupSets[index].active
    const safeSourceKey = `workbook:v1:${value.source.rowNumber}:${sourceLookup.slice(3)}`
    entries.push({ id, value, detailsEnvelope, sourceEnvelope, sourceLookup, safeSourceKey })
  }
  const chunkId = generated(command.idFactory, 'fic', CHUNK_ID)
  const auditId = generated(command.idFactory, 'aud', AUDIT_ID)
  const nextVersion = current.version + 1
  const acceptedRows = current.accepted_rows + entries.length
  const metadata = Object.freeze({ batchVersion: nextVersion, rowCount: entries.length })
  const unit = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  for (const item of entries) {
    const value = item.value
    unit.domain(command.db.prepare(
      `INSERT INTO finance_entries
       (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
        amount_grosze,paid_amount_grosze,payment_method,settlement_status,
        invoice_status,specialist_id,appointment_id,counterparty_lookup,
        details_envelope,source_row_envelope,version,created_by_staff_id,
        source_dedup_lookup,
        created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      item.id, command.batchId, item.safeSourceKey, value.kind, value.recordType,
      value.accountingMonth, value.occurredOn, value.amountGrosze, value.paidAmountGrosze,
      value.paymentMethod, value.settlementStatus, value.invoiceStatus,
      value.specialistId, null, null, item.detailsEnvelope, item.sourceEnvelope,
      1, actor.id, item.sourceLookup, now, now,
    ))
  }
  unit.domain(command.db.prepare(
    `INSERT INTO finance_import_chunks
     (id,batch_id,sequence,row_count,payload_hash,idempotency_key,created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(
    chunkId, command.batchId, body.sequence, entries.length, payloadHash,
    command.idempotencyKey, now,
  ))
  unit.domain(command.db.prepare(
    `UPDATE finance_import_batches
     SET accepted_rows=?,version=?,updated_at=?
     WHERE id=? AND status='importing' AND version=? AND accepted_rows=?`
  ).bind(
    acceptedRows, nextVersion, now, command.batchId, current.version, current.accepted_rows,
  ))
  unit.audit(audit(command.db, {
    id: auditId, now, actorId: actor.id, action: 'finance.import.chunk.accepted',
    entityId: command.batchId, correlationId: command.correlationId, metadata,
  }))
  unit.guard(batchGuard(command.db, {
    batchId: command.batchId, status: 'importing', acceptedRows, version: nextVersion,
    auditId, action: 'finance.import.chunk.accepted', actorId: actor.id,
    correlationId: command.correlationId, metadata,
  }))
  try {
    await unit.commit()
  } catch (error) {
    const winner = await loadReplay()
    if (winner && winner.sequence === body.sequence
      && winner.row_count === body.entries.length
      && winner.payload_hash === payloadHash) {
      return responseForBatch(200, batchDto(winner))
    }
    if (isD1FinanceSourceDuplicate(error)) fail('FINANCE_IMPORT_DUPLICATE')
    throw error
  }
  return responseForBatch(200, batchDto({
    ...current, accepted_rows: acceptedRows, version: nextVersion, updated_at: now,
  }))
}

export async function commitFinanceImport(input) {
  const command = exact(input, [
    'db', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory', 'batchId',
    'body', 'idempotencyKey',
  ], 'input')
  validDependency(command.db, command.keyring, command.correlationId, command.idFactory)
  const actor = actorFact(command.actor)
  requireManage(actor, command.nowMs)
  if (!IDEMPOTENCY_KEY.test(command.idempotencyKey ?? '')) validation('body')
  const body = exact(command.body, ['expectedVersion'])
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    validation('expectedVersion')
  }
  const context = await loadFinanceContext(command.db, command.keyring)
  const idem = idempotencyInput(actor.id, 'finance.import.commit', command.idempotencyKey,
    JSON.stringify({ batchId: command.batchId, expectedVersion: body.expectedVersion }))
  const replay = await inspectIdempotency(command.db, context, idem)
  if (replay) return replay
  const current = await loadBatch(command.db, command.batchId)
  if (current.version !== body.expectedVersion) fail('VERSION_CONFLICT')
  if (current.status === 'committed') return responseForBatch(200, batchDto(current))
  if (current.status !== 'importing') fail('FINANCE_IMPORT_CLOSED')
  if (current.accepted_rows !== current.total_rows) fail('FINANCE_IMPORT_INCOMPLETE')
  const now = canonicalInstant(command.nowMs)
  const auditId = generated(command.idFactory, 'aud', AUDIT_ID)
  const version = current.version + 1
  const metadata = Object.freeze({ batchVersion: version, rowCount: current.total_rows })
  const response = responseForBatch(200, batchDto({
    ...current, status: 'committed', version, updated_at: now, committed_at: now,
  }))
  const unit = createUnitOfWork(command.db, {
    mode: 'mutation', actorId: actor.id, correlationId: command.correlationId,
  })
  unit.domain(command.db.prepare(
    `UPDATE finance_import_batches
     SET status='committed',version=?,updated_at=?,committed_at=?
     WHERE id=? AND status='importing' AND version=? AND accepted_rows=total_rows`
  ).bind(version, now, now, command.batchId, current.version))
  unit.audit(audit(command.db, {
    id: auditId, now, actorId: actor.id, action: 'finance.import.committed',
    entityId: command.batchId, correlationId: command.correlationId, metadata,
  }))
  unit.idempotency(await createIdempotencyStatement(command.db, context, {
    ...idem, resourceType: 'finance_import', resourceId: command.batchId, response,
    createdAt: now, expiresAt: new Date(command.nowMs + 7 * DAY_MS).toISOString(),
  }))
  unit.guard(batchGuard(command.db, {
    batchId: command.batchId, status: 'committed',
    acceptedRows: current.total_rows, version,
    auditId, action: 'finance.import.committed', actorId: actor.id,
    correlationId: command.correlationId, metadata,
  }))
  try {
    await unit.commit()
  } catch (error) {
    const winner = await inspectIdempotency(command.db, context, idem)
    if (winner) return winner
    throw error
  }
  return response
}

const parseDetails = (value) => {
  const details = exact(value, [
    'schema', 'counterparty', 'sourceLabel', 'invoiceNote', 'lessonCount',
  ], 'stored')
  if (details.schema !== 'finance_entry_details.v1') fail('CRYPTO_FAILURE')
  return details
}

const parseSource = (value) => {
  const source = exact(value, ['schema', 'source'], 'stored')
  if (source.schema !== 'finance_entry_source.v1') fail('CRYPTO_FAILURE')
  return source.source
}

export async function listFinanceEntries(input) {
  const command = exact(input, ['db', 'actor', 'keyring', 'nowMs', 'month', 'kind'], 'input')
  validDependency(command.db, command.keyring, 'finance_list', undefined)
  const actor = actorFact(command.actor)
  requireRead(actor, command.nowMs)
  if (command.month !== null && (typeof command.month !== 'string' || !MONTH.test(command.month))) {
    validation('accountingMonth')
  }
  if (command.kind !== null && !KINDS.has(command.kind)) validation('kind')
  const bindings = []
  const predicates = []
  if (command.month === null) predicates.push('accounting_month IS NULL')
  else {
    predicates.push('accounting_month=?')
    bindings.push(command.month)
  }
  if (command.kind !== null) {
    predicates.push('kind=?')
    bindings.push(command.kind)
  }
  const rows = (await command.db.prepare(
    `SELECT entry.id,entry.batch_id,entry.source_key,entry.kind,entry.record_type,
            entry.accounting_month,entry.occurred_on,entry.amount_grosze,
            entry.paid_amount_grosze,entry.payment_method,entry.settlement_status,
            entry.invoice_status,entry.specialist_id,entry.appointment_id,
            entry.details_envelope,entry.source_row_envelope,entry.version,
            entry.created_by_staff_id,entry.created_at,entry.updated_at
     FROM finance_entries AS entry
     JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
     WHERE ${predicates.join(' AND ')}
       AND batch.status='committed'
     ORDER BY entry.occurred_on DESC,entry.id ASC LIMIT 5000`
  ).bind(...bindings).all()).results
  if (!Array.isArray(rows)) fail()
  if (rows.length === 0) return Object.freeze({ data: Object.freeze({
    entries: Object.freeze([]), summary: financeMonthSummary([], command.month),
  }) })
  const context = await loadFinanceContext(command.db, command.keyring)
  const entries = []
  for (const row of rows) {
    const details = parseDetails(await open(context, row.id, 'details', row.details_envelope))
    const source = row.source_row_envelope === null
      ? null
      : parseSource(await open(context, row.id, 'source_row', row.source_row_envelope))
    entries.push(financeEntryDto({
      id: row.id,
      kind: row.kind,
      recordType: row.record_type,
      accountingMonth: row.accounting_month,
      occurredOn: row.occurred_on,
      amountGrosze: row.amount_grosze,
      paidAmountGrosze: row.paid_amount_grosze,
      paymentMethod: row.payment_method,
      settlementStatus: row.settlement_status,
      invoiceStatus: row.invoice_status,
      counterparty: details.counterparty,
      sourceLabel: details.sourceLabel,
      invoiceNote: details.invoiceNote,
      specialistId: row.specialist_id,
      lessonCount: details.lessonCount,
      source,
      appointmentId: row.appointment_id,
      version: row.version,
      createdByStaffId: row.created_by_staff_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }
  return Object.freeze({ data: Object.freeze({
    entries: Object.freeze(entries),
    summary: financeMonthSummary(entries, command.month),
  }) })
}
