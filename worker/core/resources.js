import { isAppointmentId, isClientId, isSpecialistId } from '../../src/core-records.js'
import { captureAuthorityActor } from '../identity/authority-actor.js'
import { partsInWarsaw } from '../operations/clock.js'

const ACTIVITY_GROUP_ID = /^agr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ACTIVITY_PARTICIPANT_ID = /^acp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CIVIL_DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
const notFound = () => { throw new Error('NOT_FOUND') }
const cryptoFailure = () => { throw new Error('CRYPTO_FAILURE') }

export const CENTRE_RESOURCE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
export const SPECIALIST_DIRECTORY_RESOURCE = Object.freeze({
  kind: 'specialist_directory', centreId: 'centre_1',
})
export const ACTIVITY_CENTRE_RESOURCE = Object.freeze({
  kind: 'activity_centre', centreId: 'centre_1',
})

const captureFields = (value, keys, { exact = false } = {}) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (exact && (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key)))) return null
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null
      captured[key] = descriptor.value
    }
    return captured
  } catch {
    return null
  }
}

const exactRow = (value, keys) => {
  const row = captureFields(value, keys, { exact: true })
  if (!row) cryptoFailure()
  return row
}

const first = async (db, sql, bindings) => {
  try {
    if (db === null || typeof db !== 'object') cryptoFailure()
    const prepare = db.prepare
    if (typeof prepare !== 'function') cryptoFailure()
    return await Reflect.apply(prepare, db, [sql]).bind(...bindings).first()
  } catch {
    cryptoFailure()
  }
}

const requireFactRow = (row) => {
  if (row === null || row === undefined) notFound()
  return row
}

const frozenAssignment = (clientId, specialistId) => Object.freeze({
  kind: 'client_assignment', clientId, specialistId, status: 'active',
})

const activityLeaderIds = (value) => {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length > 100
      || parsed.some((id) => !isSpecialistId(id))
      || new Set(parsed).size !== parsed.length) cryptoFailure()
    return Object.freeze([...parsed].sort((left, right) => left.localeCompare(right)))
  } catch { cryptoFailure() }
}

const validCivilDay = (value) => {
  if (typeof value !== 'string' || !CIVIL_DAY.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (!Number.isSafeInteger(year) || year < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]
}

export async function loadActivityGroupResourceFact(
  db, value, groupId, nowMs, effectiveDay,
) {
  const actor = captureAuthorityActor(value)
  if (!actor || !ACTIVITY_GROUP_ID.test(groupId)
    || !Number.isSafeInteger(nowMs) || nowMs < 0) notFound()
  const currentDay = effectiveDay === undefined ? partsInWarsaw(nowMs).day : effectiveDay
  if (!validCivilDay(currentDay)) {
    if (effectiveDay === undefined) cryptoFailure()
    notFound()
  }
  const specialistScope = actor.role === 'specialist'
  const sql = specialistScope
    ? `WITH target(id) AS (VALUES (?)), clock(day) AS (VALUES (?))
       SELECT activity_group.id AS group_id,
              coalesce((SELECT json_group_array(leader.specialist_id ORDER BY leader.specialist_id)
                FROM activity_group_leaders AS leader, clock
                WHERE leader.group_id=activity_group.id AND leader.status='active'
                  AND leader.starts_on<=clock.day
                  AND coalesce(leader.ends_on,'9999-12-31')>=clock.day),'[]')
                AS leader_specialist_ids_json
       FROM activity_groups AS activity_group JOIN target ON target.id=activity_group.id,
            clock
       WHERE EXISTS (SELECT 1 FROM activity_group_leaders AS leader
         WHERE leader.group_id=activity_group.id AND leader.status='active'
           AND leader.starts_on<=clock.day
           AND coalesce(leader.ends_on,'9999-12-31')>=clock.day
           AND leader.specialist_id=?)`
    : `WITH clock(day) AS (VALUES (?))
       SELECT activity_group.id AS group_id,
              coalesce((SELECT json_group_array(leader.specialist_id ORDER BY leader.specialist_id)
                FROM activity_group_leaders AS leader,clock
                WHERE leader.group_id=activity_group.id AND leader.status='active'
                  AND leader.starts_on<=clock.day
                  AND coalesce(leader.ends_on,'9999-12-31')>=clock.day),'[]')
                AS leader_specialist_ids_json
       FROM activity_groups AS activity_group,clock WHERE activity_group.id=?`
  const bindings = specialistScope
    ? [groupId, currentDay, actor.specialistId]
    : [currentDay, groupId]
  const row = exactRow(requireFactRow(await first(db, sql, bindings)), [
    'group_id', 'leader_specialist_ids_json',
  ])
  if (row.group_id !== groupId) cryptoFailure()
  return Object.freeze({
    kind: 'activity_group', groupId,
    leaderSpecialistIds: activityLeaderIds(row.leader_specialist_ids_json),
  })
}

export async function loadActivityParticipantResourceFact(
  db, value, participantId, nowMs,
) {
  const actor = captureAuthorityActor(value)
  if (!actor || !ACTIVITY_PARTICIPANT_ID.test(participantId)
    || !Number.isSafeInteger(nowMs) || nowMs < 0) notFound()
  const currentDay = partsInWarsaw(nowMs).day
  if (!CIVIL_DAY.test(currentDay)) cryptoFailure()
  const specialistScope = actor.role === 'specialist'
  const sql = specialistScope
    ? `WITH target(id) AS (VALUES (?)), clock(day) AS (VALUES (?))
       SELECT participant.id AS participant_id,
              coalesce((SELECT json_group_array(DISTINCT leader.specialist_id)
                FROM activity_memberships AS membership
                JOIN activity_group_leaders AS leader ON leader.group_id=membership.group_id
                  AND leader.status='active', clock
                WHERE membership.participant_id=participant.id
                  AND membership.status='active'
                  AND membership.membership_kind='interval'
                  AND membership.starts_on<=clock.day
                  AND coalesce(membership.ends_on,'9999-12-31')>=clock.day
                  AND leader.starts_on<=clock.day
                  AND coalesce(leader.ends_on,'9999-12-31')>=clock.day), '[]')
                AS leader_specialist_ids_json,
              (SELECT charge.responsible_specialist_id FROM activity_charges AS charge
                WHERE charge.participant_id=participant.id AND charge.status='active'
                  AND charge.responsible_specialist_id=? LIMIT 1) AS responsible_specialist_id
       FROM activity_participants AS participant JOIN target ON target.id=participant.id,
            clock
       WHERE EXISTS (SELECT 1 FROM activity_charges AS charge
               WHERE charge.participant_id=participant.id AND charge.status='active'
                 AND charge.responsible_specialist_id=?)
          OR EXISTS (SELECT 1 FROM activity_memberships AS membership
               JOIN activity_group_leaders AS leader ON leader.group_id=membership.group_id
                 AND leader.status='active'
               WHERE membership.participant_id=participant.id
                 AND membership.status='active'
                 AND membership.membership_kind='interval'
                 AND membership.starts_on<=clock.day
                 AND coalesce(membership.ends_on,'9999-12-31')>=clock.day
                 AND leader.starts_on<=clock.day
                 AND coalesce(leader.ends_on,'9999-12-31')>=clock.day
                 AND leader.specialist_id=?)`
    : `WITH clock(day) AS (VALUES (?))
       SELECT participant.id AS participant_id,
              coalesce((SELECT json_group_array(DISTINCT leader.specialist_id)
                FROM activity_memberships AS membership
                JOIN activity_group_leaders AS leader ON leader.group_id=membership.group_id
                  AND leader.status='active',clock
                WHERE membership.participant_id=participant.id
                  AND membership.status='active'
                  AND membership.membership_kind='interval'
                  AND membership.starts_on<=clock.day
                  AND coalesce(membership.ends_on,'9999-12-31')>=clock.day
                  AND leader.starts_on<=clock.day
                  AND coalesce(leader.ends_on,'9999-12-31')>=clock.day),'[]')
                AS leader_specialist_ids_json,
              NULL AS responsible_specialist_id
       FROM activity_participants AS participant,clock WHERE participant.id=?`
  const bindings = specialistScope
    ? [
      participantId, currentDay, actor.specialistId,
      actor.specialistId, actor.specialistId,
    ]
    : [currentDay, participantId]
  const row = exactRow(requireFactRow(await first(db, sql, bindings)), [
    'participant_id', 'leader_specialist_ids_json', 'responsible_specialist_id',
  ])
  if (row.participant_id !== participantId
    || !(row.responsible_specialist_id === null
      || isSpecialistId(row.responsible_specialist_id))) cryptoFailure()
  return Object.freeze({
    kind: 'activity_record', activityId: participantId,
    leaderSpecialistIds: activityLeaderIds(row.leader_specialist_ids_json),
    responsibleSpecialistId: row.responsible_specialist_id,
  })
}

export async function loadClientResourceFact(db, value, clientId) {
  const actor = captureAuthorityActor(value)
  if (!actor || !isClientId(clientId)) notFound()
  const specialistScope = actor.role === 'specialist'
  const sql = specialistScope
    ? `SELECT c.id AS client_id,
              ca.client_id AS assignment_client_id,
              ca.specialist_id AS assignment_specialist_id
       FROM clients c
       JOIN client_assignments ca
         ON ca.client_id=c.id AND ca.ends_at IS NULL
       JOIN specialists s
         ON s.id=ca.specialist_id AND s.status='active'
       WHERE c.id=? AND c.status IN ('active','paused')
         AND ca.specialist_id=? AND s.staff_user_id=?`
    : `SELECT c.id AS client_id,
              CASE WHEN s.id IS NULL THEN NULL ELSE ca.client_id END AS assignment_client_id,
              CASE WHEN s.id IS NULL THEN NULL ELSE ca.specialist_id END AS assignment_specialist_id
       FROM clients c
       LEFT JOIN client_assignments ca
         ON ca.client_id=c.id AND ca.ends_at IS NULL
       LEFT JOIN specialists s
         ON s.id=ca.specialist_id AND s.status='active'
       WHERE c.id=? AND c.status IN ('active','paused')`
  const bindings = specialistScope
    ? [clientId, actor.specialistId, actor.id]
    : [clientId]
  const row = exactRow(requireFactRow(await first(db, sql, bindings)), [
    'client_id', 'assignment_client_id', 'assignment_specialist_id',
  ])
  if (row.client_id !== clientId || !isClientId(row.client_id)) cryptoFailure()
  const empty = row.assignment_client_id === null && row.assignment_specialist_id === null
  const active = row.assignment_client_id === clientId
    && isSpecialistId(row.assignment_specialist_id)
  if (!empty && !active) cryptoFailure()
  if (specialistScope && (!active || row.assignment_specialist_id !== actor.specialistId)) {
    cryptoFailure()
  }
  return Object.freeze({
    kind: 'client', clientId,
    assignment: active ? frozenAssignment(clientId, row.assignment_specialist_id) : null,
  })
}

export async function loadClientHistoryResourceFact(db, value, input) {
  const actor = captureAuthorityActor(value)
  const ids = captureFields(input, ['clientId', 'appointmentId'], { exact: true })
  if (!actor || !ids || !isClientId(ids.clientId) || !isAppointmentId(ids.appointmentId)) {
    notFound()
  }
  const specialistScope = actor.role === 'specialist'
  const sql = specialistScope
    ? `SELECT c.id AS client_id, a.id AS appointment_id, a.specialist_id AS specialist_id
       FROM clients c
       JOIN appointments a ON a.client_id=c.id
       JOIN specialists s
         ON s.id=a.specialist_id AND s.status='active'
       WHERE c.id=? AND c.status='archived' AND a.id=?
         AND a.specialist_id=? AND s.staff_user_id=?`
    : `SELECT c.id AS client_id, a.id AS appointment_id, a.specialist_id AS specialist_id
       FROM clients c
       JOIN appointments a ON a.client_id=c.id
       WHERE c.id=? AND c.status='archived' AND a.id=?`
  const bindings = specialistScope
    ? [ids.clientId, ids.appointmentId, actor.specialistId, actor.id]
    : [ids.clientId, ids.appointmentId]
  const row = exactRow(requireFactRow(await first(db, sql, bindings)), [
    'client_id', 'appointment_id', 'specialist_id',
  ])
  if (row.client_id !== ids.clientId || row.appointment_id !== ids.appointmentId
    || !isSpecialistId(row.specialist_id)
    || (specialistScope && row.specialist_id !== actor.specialistId)) cryptoFailure()
  return Object.freeze({
    kind: 'client_history', clientId: row.client_id,
    appointmentId: row.appointment_id, specialistId: row.specialist_id,
  })
}

export async function loadAppointmentResourceFact(db, value, appointmentId) {
  const actor = captureAuthorityActor(value)
  if (!actor || !isAppointmentId(appointmentId)) notFound()
  const specialistScope = actor.role === 'specialist'
  const sql = specialistScope
    ? `SELECT a.id AS appointment_id, a.specialist_id AS specialist_id
       FROM appointments a
       JOIN specialists s
         ON s.id=a.specialist_id AND s.status='active'
       WHERE a.id=? AND a.specialist_id=? AND s.staff_user_id=?`
    : `SELECT a.id AS appointment_id, a.specialist_id AS specialist_id
       FROM appointments a
       WHERE a.id=?`
  const bindings = specialistScope
    ? [appointmentId, actor.specialistId, actor.id]
    : [appointmentId]
  const row = exactRow(requireFactRow(await first(db, sql, bindings)), [
    'appointment_id', 'specialist_id',
  ])
  if (row.appointment_id !== appointmentId || !isSpecialistId(row.specialist_id)
    || (specialistScope && row.specialist_id !== actor.specialistId)) cryptoFailure()
  return Object.freeze({
    kind: 'appointment', appointmentId: row.appointment_id, specialistId: row.specialist_id,
  })
}
