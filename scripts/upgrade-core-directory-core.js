import { auditEventStatement } from '../worker/audit/events.js'
import { createSystemUnitOfWork } from '../worker/db/unit-of-work.js'
import {
  specialistSnapshot,
  specialistSnapshotMatches,
  specialistStatusForStaff,
} from '../worker/identity/specialists.js'
import { encryptForScope } from '../worker/security/envelope.js'

const STATE_KEY = 'core_directory_specialist_backfill_v1'
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const VERSION_ID = /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const AUDIT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_FIELDS = Object.freeze([
  'afterStaffId',
  'createdCount',
  'processedCount',
  'status',
])

const invalid = () => { throw new Error('CORE_DIRECTORY_UPGRADE_INVALID') }
const cryptoRequired = () => { throw new Error('CORE_DIRECTORY_CRYPTO_REQUIRED') }
const ownObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const count = (value) => Number.isSafeInteger(value) && value >= 0
const resultFor = (state) => Object.freeze({
  createdCount: state.createdCount,
  processedCount: state.processedCount,
  status: state.status,
})
const serializeState = (state) => JSON.stringify({
  afterStaffId: state.afterStaffId,
  createdCount: state.createdCount,
  processedCount: state.processedCount,
  status: state.status,
})

const validCryptoContext = (value) => exactKeys(value, ['keyring', 'dataKey', 'scope'])
  && ownObject(value.keyring)
  && ownObject(value.dataKey)
  && exactKeys(value.scope, ['id', 'purpose', 'type'])
  && value.scope.id === 'centre_1'
  && value.scope.purpose === 'identity'
  && value.scope.type === 'staff_directory'

function parseState(row) {
  if (!exactKeys(row, ['value_json', 'version'])
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || typeof row.value_json !== 'string') invalid()
  let value
  try { value = JSON.parse(row.value_json) } catch { invalid() }
  if (!exactKeys(value, STATE_FIELDS)
    || (value.afterStaffId !== null && !STAFF_ID.test(value.afterStaffId ?? ''))
    || !count(value.createdCount)
    || !count(value.processedCount)
    || value.createdCount > value.processedCount
    || !['pending', 'running', 'complete'].includes(value.status)
    || (value.status === 'pending' && (
      value.afterStaffId !== null
      || value.createdCount !== 0
      || value.processedCount !== 0
    ))
    || (value.status === 'running' && (
      value.afterStaffId === null
      || value.processedCount < 1
    ))
    || (value.processedCount === 0 && value.afterStaffId !== null)
    || (value.processedCount > 0 && value.afterStaffId === null)
    || row.version !== value.processedCount + (value.status === 'complete' ? 2 : 1)
    || row.value_json !== serializeState(value)) invalid()
  return Object.freeze({ ...value, version: row.version })
}

const stateStatement = (db) => db.prepare(
  'SELECT value_json,version FROM system_state WHERE key=?'
).bind(STATE_KEY)

async function readState(db) {
  return parseState(await stateStatement(db).first())
}

function validateStaff(row) {
  if (!exactKeys(row, ['id', 'specialist_id', 'status'])
    || !STAFF_ID.test(row.id ?? '')
    || !SPECIALIST_ID.test(row.specialist_id ?? '')
    || !['pending', 'active', 'disabled'].includes(row.status)) invalid()
  return row
}

async function nextStaff(db, afterStaffId) {
  const row = await db.prepare(
    `SELECT id,specialist_id,status
     FROM staff_users
     WHERE specialist_id IS NOT NULL
       AND (? IS NULL OR id>?)
     ORDER BY id
     LIMIT 1`
  ).bind(afterStaffId, afterStaffId).first()
  return row === null ? null : validateStaff(row)
}

async function hasDirectoryRows(db) {
  const row = await db.prepare(
    `SELECT 1 AS present FROM staff_users WHERE specialist_id IS NOT NULL
     UNION ALL
     SELECT 1 AS present FROM specialists
     LIMIT 1`
  ).first()
  if (row !== null && !exactKeys(row, ['present'])) invalid()
  return row !== null
}

const globalFailureCaseSql = `CASE
  WHEN EXISTS (
    SELECT 1 FROM staff_users AS staff
    WHERE staff.role='specialist' AND staff.specialist_id IS NULL
  ) THEN 'missing_profile'
  WHEN EXISTS (
    SELECT 1 FROM specialists AS specialist
    WHERE NOT EXISTS (
      SELECT 1 FROM staff_users AS staff
      WHERE staff.id=specialist.staff_user_id
        AND staff.specialist_id IS NOT NULL
    )
  ) THEN 'orphan_profile'
  WHEN EXISTS (
    SELECT 1 FROM specialists AS specialist
    JOIN staff_users AS staff ON staff.id=specialist.staff_user_id
    WHERE staff.specialist_id IS NOT specialist.id
  ) THEN 'pointer_mismatch'
  WHEN EXISTS (
    SELECT 1 FROM staff_users AS staff
    WHERE staff.specialist_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM specialists AS specialist
      WHERE specialist.id=staff.specialist_id
        AND specialist.staff_user_id=staff.id
    )
  ) THEN 'missing_profile'
  WHEN EXISTS (
    SELECT 1 FROM specialists AS specialist
    JOIN staff_users AS staff
      ON staff.id=specialist.staff_user_id
     AND staff.specialist_id=specialist.id
    WHERE specialist.status IS NOT CASE staff.status
      WHEN 'pending' THEN 'pending'
      WHEN 'active' THEN 'active'
      WHEN 'disabled' THEN 'archived'
    END
  ) THEN 'status_mismatch'
  WHEN EXISTS (
    SELECT 1 FROM specialists AS specialist
    WHERE NOT EXISTS (
      SELECT 1 FROM record_versions AS version
      WHERE version.entity_type='specialist'
        AND version.entity_id=specialist.id
        AND version.version=specialist.version
    )
  ) THEN 'missing_version'
  WHEN EXISTS (
    SELECT 1 FROM specialists AS specialist
    WHERE (
      SELECT count(*) FROM record_versions AS version
      WHERE version.entity_type='specialist'
        AND version.entity_id=specialist.id
    )!=specialist.version
       OR (
         SELECT min(version.version) FROM record_versions AS version
         WHERE version.entity_type='specialist'
           AND version.entity_id=specialist.id
       ) IS NOT 1
       OR (
         SELECT max(version.version) FROM record_versions AS version
         WHERE version.entity_type='specialist'
           AND version.entity_id=specialist.id
       ) IS NOT specialist.version
  ) THEN 'noncontiguous_versions'
  WHEN NOT EXISTS (
    SELECT 1 FROM system_state
    WHERE key=? AND value_json=? AND version=?
  ) THEN 'upgrade_incomplete'
  ELSE NULL
END`

const globalFailuresSql = () => `SELECT failure_kind
FROM (SELECT ${globalFailureCaseSql} AS failure_kind)
WHERE failure_kind IS NOT NULL`

const globalGuardStatement = (db, state, { requireEmptyDirectory }) => db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT failure_kind
   FROM (
     SELECT CASE
       WHEN changes()!=1 THEN 'upgrade_incomplete'
       WHEN ?=1 AND (
         EXISTS (SELECT 1 FROM staff_users WHERE specialist_id IS NOT NULL)
         OR EXISTS (SELECT 1 FROM specialists)
       ) THEN 'upgrade_incomplete'
       ELSE ${globalFailureCaseSql}
     END AS failure_kind
   )
   WHERE failure_kind IS NOT NULL`
).bind(
  requireEmptyDirectory ? 1 : 0,
  STATE_KEY,
  serializeState(state),
  state.version,
)

async function assertCompleteInvariant(db, state) {
  const failure = await db.prepare(globalFailuresSql())
    .bind(STATE_KEY, serializeState(state), state.version).first()
  if (failure !== null) invalid()
}

async function currentProfile(db, context, staff) {
  const rows = (await db.prepare(
    `SELECT id,staff_user_id,standard_rate_grosze,status,version,archived_at,
            created_at,updated_at
     FROM specialists
     WHERE id=? OR staff_user_id=?
     ORDER BY id`
  ).bind(staff.specialist_id, staff.id).all()).results
  if (!Array.isArray(rows) || rows.length > 1) invalid()
  const profile = rows[0] ?? null
  if (profile === null) return null
  let expectedStatus
  try {
    expectedStatus = specialistStatusForStaff(staff.status)
    specialistSnapshot(profile)
  } catch {
    invalid()
  }
  if (profile.id !== staff.specialist_id
    || profile.staff_user_id !== staff.id
    || profile.status !== expectedStatus) invalid()
  const version = await db.prepare(
    `SELECT id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
            changed_at,correlation_id
     FROM record_versions
     WHERE entity_type='specialist' AND entity_id=? AND version=?`
  ).bind(profile.id, profile.version).first()
  if (!version
    || !await specialistSnapshotMatches(context, version, profile)) invalid()
  return Object.freeze(profile)
}

function generatedId(idFactory, kind) {
  let value
  try { value = idFactory(kind) } catch { invalid() }
  const grammar = kind === 'version' ? VERSION_ID : AUDIT_ID
  if (!grammar.test(value ?? '')) invalid()
  return value
}

async function snapshotEnvelope(context, profile) {
  const plaintext = JSON.stringify(specialistSnapshot(profile))
  const plaintextBytes = new TextEncoder().encode(plaintext)
  try {
    return JSON.stringify(await encryptForScope(
      context.keyring,
      context.dataKey,
      {
        expectedScope: context.scope,
        field: 'record_version',
        plaintext,
        recordId: profile.id,
      },
    ))
  } finally {
    plaintextBytes.fill(0)
  }
}

const stateUpdateStatement = (db, current, next, now) => db.prepare(
  `UPDATE system_state
   SET value_json=?,version=version+1,updated_at=?
   WHERE key=? AND value_json=? AND version=?`
).bind(
  serializeState(next),
  now,
  STATE_KEY,
  serializeState(current),
  current.version,
)

const auditStatement = (db, {
  action,
  auditId,
  correlationId,
  entityId,
  entityType,
  metadata,
  now,
}) => auditEventStatement(db, {
  action,
  actorStaffId: null,
  correlationId,
  entityId,
  entityType,
  id: auditId,
  metadata,
  occurredAt: now,
  reasonEnvelope: null,
  result: 'success',
})

const targetGuardStatement = (db, { profile, staff, state }) => db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'pointer_mismatch'
   WHERE changes()!=1 OR NOT (
     EXISTS (
       SELECT 1 FROM system_state
       WHERE key=? AND value_json=? AND version=?
     )
     AND EXISTS (
       SELECT 1 FROM staff_users
       WHERE id=? AND specialist_id=? AND status=?
     )
     AND EXISTS (
       SELECT 1 FROM specialists
       WHERE id=? AND staff_user_id=? AND standard_rate_grosze=?
         AND status=? AND version=? AND archived_at IS ?
         AND created_at=? AND updated_at=?
     )
     AND EXISTS (
       SELECT 1 FROM record_versions
       WHERE entity_type='specialist' AND entity_id=? AND version=?
     )
   )`
).bind(
  STATE_KEY,
  serializeState(state),
  state.version,
  staff.id,
  staff.specialist_id,
  staff.status,
  profile.id,
  profile.staff_user_id,
  profile.standard_rate_grosze,
  profile.status,
  profile.version,
  profile.archived_at,
  profile.created_at,
  profile.updated_at,
  profile.id,
  profile.version,
)

async function recoverAfterCommitFailure(db, expected, originalError) {
  try {
    const winner = await readState(db)
    const exactCompletion = expected.status === 'complete'
      && winner.version === expected.version
      && winner.status === expected.status
      && winner.afterStaffId === expected.afterStaffId
      && winner.processedCount === expected.processedCount
      && winner.createdCount === expected.createdCount
    const monotonicStaffProgress = expected.status === 'running'
      && ['running', 'complete'].includes(winner.status)
      && winner.version >= expected.version
      && winner.afterStaffId !== null
      && (
        (winner.processedCount === expected.processedCount
          && winner.afterStaffId === expected.afterStaffId
          && winner.createdCount === expected.createdCount)
        || (winner.processedCount > expected.processedCount
          && winner.afterStaffId > expected.afterStaffId
          && winner.createdCount >= expected.createdCount
          && winner.createdCount - expected.createdCount
            <= winner.processedCount - expected.processedCount)
      )
    if (exactCompletion || monotonicStaffProgress) return resultFor(winner)
  } catch {
    // Preserve only the fixed upgrade failure below.
  }
  void originalError
  invalid()
}

async function assertCompletedCryptoContext(db, context) {
  const staff = await nextStaff(db, null)
  if (staff === null) return
  await currentProfile(db, context, staff)
}

async function commitSystemUow(db, current, expected, build) {
  const uow = createSystemUnitOfWork(db, { correlationId: build.correlationId })
  for (const statement of build.beforeAudit) uow.domain(statement)
  if (build.versionStatement) uow.version(build.versionStatement)
  uow.audit(build.auditStatement)
  uow.domain(build.stateStatement)
  uow.guard(build.guardStatement)
  try {
    await uow.commit()
    return resultFor(expected)
  } catch (error) {
    return recoverAfterCommitFailure(db, expected, error)
  }
}

async function completeUpgrade({
  db,
  current,
  now,
  correlationId,
  idFactory,
  requireEmptyDirectory,
}) {
  const expected = Object.freeze({
    ...current,
    status: 'complete',
    version: current.version + 1,
  })
  const auditId = generatedId(idFactory, 'audit')
  return commitSystemUow(db, current, expected, {
    auditStatement: auditStatement(db, {
      action: 'core_directory.upgrade.advanced',
      auditId,
      correlationId,
      entityId: STATE_KEY,
      entityType: 'system_state',
      metadata: {
        createdCount: expected.createdCount,
        processedCount: expected.processedCount,
        stateVersion: expected.version,
      },
      now,
    }),
    beforeAudit: [],
    correlationId,
    guardStatement: globalGuardStatement(db, expected, { requireEmptyDirectory }),
    stateStatement: stateUpdateStatement(db, current, expected, now),
    versionStatement: null,
  })
}

async function advanceStaff({
  db,
  context,
  current,
  staff,
  now,
  correlationId,
  idFactory,
}) {
  const existing = await currentProfile(db, context, staff)
  let profile = existing
  let profileStatement = null
  let versionStatement = null
  let createdCount = current.createdCount
  if (profile === null) {
    const status = specialistStatusForStaff(staff.status)
    profile = Object.freeze({
      archived_at: status === 'archived' ? now : null,
      created_at: now,
      id: staff.specialist_id,
      staff_user_id: staff.id,
      standard_rate_grosze: 18000,
      status,
      updated_at: now,
      version: 1,
    })
    const versionId = generatedId(idFactory, 'version')
    profileStatement = db.prepare(
      `INSERT INTO specialists
       (id,staff_user_id,standard_rate_grosze,status,version,archived_at,
        created_at,updated_at)
       VALUES (?,?,18000,?,1,?,?,?)`
    ).bind(
      profile.id,
      profile.staff_user_id,
      profile.status,
      profile.archived_at,
      profile.created_at,
      profile.updated_at,
    )
    versionStatement = db.prepare(
      `INSERT INTO record_versions
       (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
        changed_at,correlation_id)
       VALUES (?,'specialist',?,1,?,NULL,?,?)`
    ).bind(
      versionId,
      profile.id,
      await snapshotEnvelope(context, profile),
      now,
      correlationId,
    )
    createdCount += 1
  }

  const expected = Object.freeze({
    afterStaffId: staff.id,
    createdCount,
    processedCount: current.processedCount + 1,
    status: 'running',
    version: current.version + 1,
  })
  const auditId = generatedId(idFactory, 'audit')
  const created = profileStatement !== null
  return commitSystemUow(db, current, expected, {
    auditStatement: auditStatement(db, {
      action: created ? 'specialist.backfilled' : 'core_directory.upgrade.advanced',
      auditId,
      correlationId,
      entityId: created ? profile.id : STATE_KEY,
      entityType: created ? 'specialist' : 'system_state',
      metadata: created
        ? { specialistVersion: 1, stateVersion: expected.version }
        : {
            createdCount: expected.createdCount,
            processedCount: expected.processedCount,
            stateVersion: expected.version,
          },
      now,
    }),
    beforeAudit: profileStatement ? [profileStatement] : [],
    correlationId,
    guardStatement: targetGuardStatement(db, { profile, staff, state: expected }),
    stateStatement: stateUpdateStatement(db, current, expected, now),
    versionStatement,
  })
}

export async function advanceCoreDirectoryUpgrade({
  db,
  cryptoContext = null,
  nowMs,
  correlationId,
  idFactory,
} = {}) {
  if (!db?.prepare
    || !db?.batch
    || (cryptoContext !== null && !validCryptoContext(cryptoContext))
    || !Number.isSafeInteger(nowMs)
    || nowMs < 0
    || !CORRELATION_ID.test(correlationId ?? '')
    || typeof idFactory !== 'function') invalid()
  let now
  try { now = new Date(nowMs).toISOString() } catch { invalid() }

  try {
    const current = await readState(db)
    if (current.status === 'complete') {
      if (cryptoContext === null) {
        if (await hasDirectoryRows(db)) cryptoRequired()
        await assertCompleteInvariant(db, current)
        return resultFor(current)
      }
      await assertCompleteInvariant(db, current)
      await assertCompletedCryptoContext(db, cryptoContext)
      return resultFor(current)
    }
    const staff = await nextStaff(db, current.afterStaffId)
    if (staff !== null) {
      if (cryptoContext === null) cryptoRequired()
      return advanceStaff({
        context: cryptoContext,
        correlationId,
        current,
        db,
        idFactory,
        now,
        staff,
      })
    }
    if (cryptoContext === null && await hasDirectoryRows(db)) cryptoRequired()
    return completeUpgrade({
      correlationId,
      current,
      db,
      idFactory,
      now,
      requireEmptyDirectory: cryptoContext === null,
    })
  } catch (error) {
    if (error?.message === 'CORE_DIRECTORY_CRYPTO_REQUIRED') throw error
    if (error?.message === 'CORE_DIRECTORY_UPGRADE_INVALID') throw error
    invalid()
  }
}
