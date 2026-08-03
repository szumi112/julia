import { decryptForScope, encryptForScope } from '../security/envelope.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const PROFILE_COLUMNS = Object.freeze([
  'id',
  'staff_user_id',
  'standard_rate_grosze',
  'status',
  'version',
  'archived_at',
  'created_at',
  'updated_at',
])

const failure = () => { throw new Error('SPECIALIST_LIFECYCLE_INVALID') }
const exactRow = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const validId = (value) => typeof value === 'string' && ID.test(value)
const validInstant = (value) => {
  try {
    return typeof value === 'string'
      && INSTANT.test(value)
      && new Date(value).toISOString() === value
  } catch {
    return false
  }
}
const idFrom = (factory) => {
  const value = factory?.()
  if (!validId(value)) failure()
  return value
}
const sameRow = (actual, expected) => actual && expected
  && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => Object.is(actual[key], value))

export function specialistIdFor(staffId) {
  if (!STAFF_ID.test(staffId ?? '')) failure()
  const specialistId = `sp_${staffId.slice(4)}`
  if (!SPECIALIST_ID.test(specialistId)) failure()
  return specialistId
}

export function specialistStatusForStaff(status) {
  if (status === 'pending') return 'pending'
  if (status === 'active') return 'active'
  if (status === 'disabled') return 'archived'
  failure()
}

export function specialistSnapshot(profile) {
  if (!validProfile(profile)) failure()
  return {
    archivedAt: profile.archived_at,
    createdAt: profile.created_at,
    id: profile.id,
    schema: 'specialist.v1',
    staffUserId: profile.staff_user_id,
    standardRateGrosze: profile.standard_rate_grosze,
    status: profile.status,
    updatedAt: profile.updated_at,
    version: profile.version,
  }
}

function validProfile(profile) {
  return exactRow(profile, PROFILE_COLUMNS)
    && SPECIALIST_ID.test(profile.id ?? '')
    && STAFF_ID.test(profile.staff_user_id ?? '')
    && Number.isSafeInteger(profile.standard_rate_grosze)
    && profile.standard_rate_grosze >= 1
    && profile.standard_rate_grosze <= 1_000_000
    && ['pending', 'active', 'archived'].includes(profile.status)
    && Number.isSafeInteger(profile.version)
    && profile.version >= 1
    && ((profile.status === 'archived' && validInstant(profile.archived_at))
      || (profile.status !== 'archived' && profile.archived_at === null))
    && validInstant(profile.created_at)
    && validInstant(profile.updated_at)
    && profile.created_at <= profile.updated_at
}

async function snapshotEnvelope(context, profile) {
  return JSON.stringify(await encryptForScope(
    context.keyring,
    context.dataKey,
    {
      expectedScope: context.scope,
      recordId: profile.id,
      field: 'record_version',
      plaintext: JSON.stringify(specialistSnapshot(profile)),
    },
  ))
}

export async function specialistSnapshotMatches(context, record, profile) {
  if (!context?.keyring || !context?.dataKey || !context?.scope
    || !exactRow(record, [
      'id', 'entity_type', 'entity_id', 'version', 'snapshot_envelope',
      'changed_by_staff_id', 'changed_at', 'correlation_id',
    ]) || !validProfile(profile)) return false
  try {
    const plaintext = await decryptForScope(
      context.keyring,
      context.dataKey,
      {
        expectedScope: context.scope,
        recordId: profile.id,
        field: 'record_version',
        envelope: JSON.parse(record.snapshot_envelope),
      },
    )
    return sameRow(JSON.parse(plaintext), specialistSnapshot(profile))
  } catch {
    return false
  }
}

async function currentProfile(db, context, specialistId, staffId) {
  const rows = (await db.prepare(
    `SELECT id,staff_user_id,standard_rate_grosze,status,version,archived_at,
            created_at,updated_at
     FROM specialists
     WHERE id=? OR staff_user_id=?
     ORDER BY id`
  ).bind(specialistId, staffId).all()).results
  if (!Array.isArray(rows) || rows.length > 1) failure()
  const profile = rows[0] ?? null
  if (!profile) return null
  if (!validProfile(profile)
    || profile.id !== specialistId
    || profile.staff_user_id !== staffId) failure()
  const record = await db.prepare(
    `SELECT id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
            changed_at,correlation_id
     FROM record_versions
     WHERE entity_type='specialist' AND entity_id=? AND version=?`
  ).bind(profile.id, profile.version).first()
  if (!record || record.entity_id !== profile.id || record.version !== profile.version
    || !await specialistSnapshotMatches(context, record, profile)) failure()
  return profile
}

export async function prepareSpecialistTransition({
  db,
  cryptoContext,
  currentStaff,
  nextStaff,
  changedByStaffId,
  now,
  correlationId,
  idFactory,
} = {}) {
  if (!db?.prepare || !cryptoContext?.keyring || !cryptoContext?.dataKey
    || !cryptoContext?.scope || !nextStaff || !STAFF_ID.test(nextStaff.id ?? '')
    || (currentStaff !== null && currentStaff !== undefined
      && (!STAFF_ID.test(currentStaff.id ?? '') || currentStaff.id !== nextStaff.id))
    || (changedByStaffId !== null && !STAFF_ID.test(changedByStaffId ?? ''))
    || !validInstant(now) || !validId(correlationId)) failure()

  const retainedId = currentStaff?.specialist_id ?? null
  if (retainedId !== null && !SPECIALIST_ID.test(retainedId)) failure()
  const specialistId = retainedId
    ?? (nextStaff.role === 'specialist' ? specialistIdFor(nextStaff.id) : null)
  const staff = { ...nextStaff, specialist_id: specialistId }
  if (specialistId === null) {
    const unexpected = await db.prepare(
      'SELECT id FROM specialists WHERE staff_user_id=?'
    ).bind(nextStaff.id).first()
    if (unexpected !== null) failure()
    return Object.freeze({
      staff: Object.freeze(staff),
      specialistId: null,
      specialistVersion: null,
      domainStatement: null,
      versionStatement: null,
    })
  }

  const current = await currentProfile(
    db,
    cryptoContext,
    specialistId,
    nextStaff.id,
  )
  if (currentStaff && current && current.status !== specialistStatusForStaff(currentStaff.status)) {
    failure()
  }
  const status = specialistStatusForStaff(nextStaff.status)
  let profile
  let domainStatement
  if (!current) {
    profile = {
      id: specialistId,
      staff_user_id: nextStaff.id,
      standard_rate_grosze: 18000,
      status,
      version: 1,
      archived_at: status === 'archived' ? now : null,
      created_at: now,
      updated_at: now,
    }
    domainStatement = db.prepare(
      `INSERT INTO specialists
       (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
       VALUES (?,?,18000,?,1,?,?,?)`
    ).bind(
      profile.id,
      profile.staff_user_id,
      profile.status,
      profile.archived_at,
      profile.created_at,
      profile.updated_at,
    )
  } else if (current.status !== status) {
    profile = {
      ...current,
      status,
      version: current.version + 1,
      archived_at: status === 'archived' ? now : null,
      updated_at: now,
    }
    domainStatement = db.prepare(
      `UPDATE specialists
       SET status=?,version=version+1,archived_at=?,updated_at=?
       WHERE id=? AND staff_user_id=? AND status=? AND version=?`
    ).bind(
      profile.status,
      profile.archived_at,
      profile.updated_at,
      current.id,
      current.staff_user_id,
      current.status,
      current.version,
    )
  } else {
    return Object.freeze({
      staff: Object.freeze(staff),
      specialistId,
      specialistVersion: null,
      domainStatement: null,
      versionStatement: null,
    })
  }

  const recordId = idFrom(idFactory)
  const versionStatement = db.prepare(
    `INSERT INTO record_versions
     (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
      changed_at,correlation_id)
     VALUES (?,'specialist',?,?,?,?,?,?)`
  ).bind(
    recordId,
    profile.id,
    profile.version,
    await snapshotEnvelope(cryptoContext, profile),
    changedByStaffId,
    now,
    correlationId,
  )
  return Object.freeze({
    staff: Object.freeze(staff),
    specialistId,
    specialistVersion: profile.version,
    profile: Object.freeze(profile),
    versionId: recordId,
    domainStatement,
    versionStatement,
  })
}

export function specialistPostcondition(staffId) {
  if (!STAFF_ID.test(staffId ?? '')) failure()
  return Object.freeze({
    sql: `EXISTS (
      SELECT 1
      FROM staff_users AS staff
      LEFT JOIN specialists AS specialist
        ON specialist.id=staff.specialist_id
       AND specialist.staff_user_id=staff.id
      WHERE staff.id=?
        AND (
          (staff.specialist_id IS NULL
            AND specialist.id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM specialists AS retained
              WHERE retained.staff_user_id=staff.id
            ))
          OR (
            staff.specialist_id IS NOT NULL
            AND specialist.status=CASE staff.status
              WHEN 'pending' THEN 'pending'
              WHEN 'active' THEN 'active'
              WHEN 'disabled' THEN 'archived'
            END
            AND EXISTS (
              SELECT 1 FROM record_versions AS version
              WHERE version.entity_type='specialist'
                AND version.entity_id=specialist.id
                AND version.version=specialist.version
            )
          )
        )
    )`,
    bindings: Object.freeze([staffId]),
  })
}

export function specialistGuardStatement(db, staffId) {
  const postcondition = specialistPostcondition(staffId)
  return db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'missing_profile' WHERE NOT (${postcondition.sql})`
  ).bind(...postcondition.bindings)
}

export async function listActiveSpecialists({ db } = {}) {
  if (!db?.prepare) failure()
  const rows = (await db.prepare(
    `SELECT specialist.id,specialist.staff_user_id,specialist.standard_rate_grosze,
            specialist.version
     FROM specialists AS specialist
     JOIN staff_users AS staff
       ON staff.id=specialist.staff_user_id
      AND staff.specialist_id=specialist.id
     WHERE staff.status='active' AND specialist.status='active'
     ORDER BY specialist.id`
  ).all()).results
  if (!Array.isArray(rows)) failure()
  return Object.freeze(rows.map((row) => {
    if (!exactRow(row, ['id', 'staff_user_id', 'standard_rate_grosze', 'version'])
      || !SPECIALIST_ID.test(row.id ?? '')
      || !STAFF_ID.test(row.staff_user_id ?? '')
      || !Number.isSafeInteger(row.standard_rate_grosze)
      || row.standard_rate_grosze < 1
      || !Number.isSafeInteger(row.version)
      || row.version < 1) failure()
    return Object.freeze({
      id: row.id,
      staffUserId: row.staff_user_id,
      standardRateGrosze: row.standard_rate_grosze,
      version: row.version,
    })
  }))
}
