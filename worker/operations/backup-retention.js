import { auditEventStatement } from '../audit/events.js'

const MAX_BATCH = 20
const INCOMPLETE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const invalid = () => { throw new Error('BACKUP_RETENTION_INVALID') }
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const validId = (value) => typeof value === 'string' && ID.test(value)

function captureInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== 6
    || !['db', 'archive', 'nowMs', 'limit', 'idFactory', 'correlationIdFactory']
      .every((key) => Object.hasOwn(input, key))
    || !input.db?.prepare || !input.db?.batch
    || typeof input.archive?.delete !== 'function'
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_BATCH
    || typeof input.idFactory !== 'function'
    || typeof input.correlationIdFactory !== 'function') invalid()
  const now = new Date(input.nowMs).toISOString()
  if (!validInstant(now)) invalid()
  const incompleteBefore = new Date(input.nowMs - INCOMPLETE_MAX_AGE_MS).toISOString()
  return { ...input, now, incompleteBefore }
}

const operationGuard = (db, id, predicate, bindings) => db.prepare(
  `INSERT INTO outbox_operation_guard_failures (operation_id)
   SELECT ? WHERE NOT (${predicate})`
).bind(id, ...bindings)

async function pruneOne(input, row) {
  if (!row || typeof row !== 'object'
    || !validId(row.id)
    || !['stored', 'restore_verified', 'failed'].includes(row.status)
    || !Number.isSafeInteger(row.version) || row.version < 1
    || typeof row.local_month !== 'string'
    || !validInstant(row.created_at)) invalid()
  const completed = row.status !== 'failed'
  if ((completed && (typeof row.object_key !== 'string' || row.object_key.length === 0
      || typeof row.manifest_key !== 'string' || row.manifest_key.length === 0
      || !validInstant(row.expires_at) || row.expires_at > input.now))
    || (!completed && row.created_at > input.incompleteBefore)) invalid()
  const prefix = `backups/v1/${row.local_month.replace('-', '/')}/${row.id}`
  const objectKey = completed ? row.object_key : `${prefix}.sql`
  const manifestKey = completed ? row.manifest_key : `${prefix}.manifest.json`
  await input.archive.delete(objectKey)
  await input.archive.delete(manifestKey)
  const nextVersion = row.version + 1
  const auditId = input.idFactory()
  const correlationId = input.correlationIdFactory()
  if (!validId(auditId) || !validId(correlationId)) invalid()
  await input.db.batch([
    input.db.prepare(
      `UPDATE backup_runs
       SET status='pruned',version=?,updated_at=?
       WHERE id=? AND status=? AND version=?
         AND ((status IN ('stored','restore_verified') AND expires_at<=?)
           OR (status='failed' AND created_at<=?))`
    ).bind(
      nextVersion,
      input.now,
      row.id,
      row.status,
      row.version,
      input.now,
      input.incompleteBefore,
    ),
    operationGuard(
      input.db,
      `backup_prune_${row.id}_${nextVersion}`,
      `changes()=1 AND EXISTS (
         SELECT 1 FROM backup_runs
         WHERE id=? AND status='pruned' AND version=? AND updated_at=?
       )`,
      [row.id, nextVersion, input.now],
    ),
    auditEventStatement(input.db, {
      id: auditId,
      occurredAt: input.now,
      actorStaffId: null,
      action: 'backup.pruned',
      entityType: 'backup_run',
      entityId: row.id,
      result: 'success',
      correlationId,
      metadata: { backupVersion: nextVersion },
      reasonEnvelope: null,
    }),
  ])
}

export async function pruneExpiredBackups(input) {
  const captured = captureInput(input)
  const response = await captured.db.prepare(
    `SELECT id,local_month,status,version,object_key,manifest_key,expires_at,created_at
     FROM backup_runs
     WHERE (status IN ('stored','restore_verified') AND expires_at<=?)
        OR (status='failed' AND created_at<=?)
     ORDER BY coalesce(expires_at,created_at),id
     LIMIT ?`
  ).bind(captured.now, captured.incompleteBefore, captured.limit).all()
  if (!Array.isArray(response?.results) || response.results.length > captured.limit) invalid()
  let pruned = 0
  for (const row of response.results) {
    await pruneOne(captured, row)
    pruned += 1
  }
  return { selected: response.results.length, pruned }
}
