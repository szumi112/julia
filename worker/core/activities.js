import {
  captureActivityGroup,
  captureActivityGroupLeader,
  captureActivityParticipant,
  captureActivityMembership,
  captureActivityClass,
  captureActivityAttendance,
  captureActivityMonthWindow,
  captureActivityWorkspace,
  captureCreateActivityGroupCommand,
  captureEditActivityGroupCommand,
  captureCreateActivityParticipantCommand,
  captureEditActivityParticipantCommand,
  captureCreateActivityMembershipCommand,
  captureEditActivityMembershipCommand,
  captureCreateActivityClassCommand,
  captureEditActivityClassCommand,
  captureSetActivityAttendanceCommand,
} from '../../src/activity-records.js'
import { auditEventStatement } from '../audit/events.js'
import { AppError } from '../http/errors.js'
import { authorize } from '../identity/policy.js'
import { partsInWarsaw } from '../operations/clock.js'
import { encodeBase64Url } from '../security/encoding.js'
import { getOrCreateDataKey } from '../security/envelope.js'
import {
  ACTIVITY_CENTRE_RESOURCE,
  loadActivityGroupResourceFact,
  loadActivityParticipantResourceFact,
} from './resources.js'
import {
  ACTIVITY_SCOPE,
  activityIdentityLookupCandidates,
  decryptActivityField,
  decryptActivityIdentity,
  encryptActivityField,
  encryptActivityIdentity,
  loadActivityDataKey,
  openActivityPayload,
  sealActivityPayload,
} from './activity-crypto.js'

const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const CAPS = Object.freeze({
  programs: 2,
  groups: 100,
  groupLeaders: 2000,
  participants: 1000,
  memberships: 2000,
  classes: 1000,
  attendance: 10000,
  charges: 5000,
})
const DATA_KEY_FIELDS = Object.freeze([
  'id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64',
  'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at',
])

const invalid = (field = 'body') => { throw new AppError('VALIDATION_FAILED', { field }) }
const internal = () => { throw new Error('INTERNAL_ERROR') }

const exact = (value, keys) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) internal()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) internal()
    const result = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) internal()
      result[key] = descriptor.value
    }
    return result
  } catch (error) {
    if (error?.message === 'INTERNAL_ERROR') throw error
    internal()
  }
}

const actorFact = (value) => {
  let hasVersion
  try { hasVersion = Object.getOwnPropertyDescriptor(value, 'version') !== undefined } catch {
    internal()
  }
  const actor = exact(value, hasVersion
    ? ['id', 'role', 'specialistId', 'version'] : ['id', 'role', 'specialistId'])
  if (typeof actor.id !== 'string' || !STAFF_ID.test(actor.id)
    || !['owner', 'coordinator', 'specialist'].includes(actor.role)
    || (actor.role === 'specialist'
      ? typeof actor.specialistId !== 'string' || !SPECIALIST_ID.test(actor.specialistId)
      : actor.specialistId !== null && (typeof actor.specialistId !== 'string'
        || !SPECIALIST_ID.test(actor.specialistId)))) internal()
  return Object.freeze(actor)
}

export function parseActivityWorkspaceQuery(value) {
  let url
  try { url = new URL(value) } catch { invalid('body') }
  const keys = [...url.searchParams.keys()]
  if (keys.length !== 2 || keys[0] !== 'from' || keys[1] !== 'to'
    || url.searchParams.getAll('from').length !== 1
    || url.searchParams.getAll('to').length !== 1) invalid('body')
  try {
    return captureActivityMonthWindow({
      from: url.searchParams.get('from'), to: url.searchParams.get('to'),
    })
  } catch {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    invalid(typeof from !== 'string' || !/^\d{4}-\d{2}$/.test(from) ? 'from'
      : typeof to !== 'string' || !/^\d{4}-\d{2}$/.test(to) ? 'to' : 'body')
  }
}

const rowsFor = async (db, sql, bindings, field) => {
  let response
  try { response = await db.prepare(sql).bind(...bindings).all() } catch (error) { throw error }
  if (!Array.isArray(response?.results)) internal()
  if (response.results.length > CAPS[field]) {
    throw new AppError('ACTIVITY_RESULT_LIMIT', { field, limit: CAPS[field] })
  }
  return response.results
}

const currentLeader = (alias = 'leader') => (
  `${alias}.status='active' AND ${alias}.starts_on<=clock.current_day
   AND coalesce(${alias}.ends_on,'9999-12-31')>=clock.current_day`
)

const windowLeader = (alias = 'leader') => (
  `${alias}.status='active' AND ${alias}.starts_on<=clock.to_month||'-31'
   AND coalesce(${alias}.ends_on,'9999-12-31')>=clock.from_month||'-01'`
)

const groupVisibility = (groupAlias = 'activity_group') => `(
  EXISTS (SELECT 1 FROM activity_group_leaders AS leader
    WHERE leader.group_id=${groupAlias}.id AND leader.specialist_id=?
      AND (${currentLeader()} OR ${windowLeader()}))
  OR EXISTS (SELECT 1 FROM activity_charges AS charge
    WHERE charge.group_id=${groupAlias}.id AND charge.status='active'
      AND charge.responsible_specialist_id=?
      AND charge.accounting_month BETWEEN clock.from_month AND clock.to_month)
)`

const participantVisibility = (participantAlias = 'participant') => `(
  EXISTS (SELECT 1 FROM activity_charges AS charge
    WHERE charge.participant_id=${participantAlias}.id AND charge.status='active'
      AND charge.responsible_specialist_id=?
      AND charge.accounting_month BETWEEN clock.from_month AND clock.to_month)
  OR EXISTS (SELECT 1 FROM activity_memberships AS membership
    JOIN activity_group_leaders AS leader ON leader.group_id=membership.group_id
      AND leader.specialist_id=?
    WHERE membership.participant_id=${participantAlias}.id
      AND membership.status='active' AND (
        (membership.membership_kind='interval'
          AND membership.starts_on<=clock.current_day
          AND coalesce(membership.ends_on,'9999-12-31')>=clock.current_day
          AND ${currentLeader()})
        OR (membership.membership_kind='observation'
          AND membership.observed_month BETWEEN clock.from_month AND clock.to_month
          AND leader.status='active'
          AND leader.starts_on<=coalesce(membership.observed_on,membership.observed_month||'-31')
          AND coalesce(leader.ends_on,'9999-12-31')
            >=coalesce(membership.observed_on,membership.observed_month||'-01'))
      ))
  OR EXISTS (SELECT 1 FROM activity_attendance AS attendance
    JOIN activity_classes AS activity_class ON activity_class.id=attendance.class_id
    JOIN activity_group_leaders AS leader ON leader.group_id=activity_class.group_id
      AND leader.specialist_id=?
    WHERE attendance.participant_id=${participantAlias}.id
      AND substr(activity_class.occurs_on,1,7)
        BETWEEN clock.from_month AND clock.to_month
      AND leader.status='active' AND leader.starts_on<=activity_class.occurs_on
      AND coalesce(leader.ends_on,'9999-12-31')>=activity_class.occurs_on)
)`

const membershipVisibility = (membershipAlias = 'membership') => `(
  (${membershipAlias}.membership_kind='interval' AND ${membershipAlias}.status='active'
    AND ${membershipAlias}.starts_on<=clock.current_day
    AND coalesce(${membershipAlias}.ends_on,'9999-12-31')>=clock.current_day
    AND EXISTS (SELECT 1 FROM activity_group_leaders AS leader
      WHERE leader.group_id=${membershipAlias}.group_id AND leader.specialist_id=?
        AND ${currentLeader()}))
  OR (${membershipAlias}.membership_kind='observation'
    AND ${membershipAlias}.status='active'
    AND ${membershipAlias}.observed_month BETWEEN clock.from_month AND clock.to_month
    AND EXISTS (SELECT 1 FROM activity_group_leaders AS leader
      WHERE leader.group_id=${membershipAlias}.group_id AND leader.specialist_id=?
        AND leader.status='active'
        AND leader.starts_on<=coalesce(${membershipAlias}.observed_on,
          ${membershipAlias}.observed_month||'-31')
        AND coalesce(leader.ends_on,'9999-12-31')
          >=coalesce(${membershipAlias}.observed_on,${membershipAlias}.observed_month||'-01')))
  OR EXISTS (SELECT 1 FROM activity_charges AS charge
    WHERE charge.membership_id=${membershipAlias}.id AND charge.status='active'
      AND charge.responsible_specialist_id=?
      AND charge.accounting_month BETWEEN clock.from_month AND clock.to_month)
  OR EXISTS (SELECT 1 FROM activity_attendance AS attendance
      JOIN activity_classes AS activity_class ON activity_class.id=attendance.class_id
        AND activity_class.group_id=${membershipAlias}.group_id
      JOIN activity_group_leaders AS leader ON leader.group_id=activity_class.group_id
        AND leader.specialist_id=?
      WHERE attendance.participant_id=${membershipAlias}.participant_id
        AND substr(activity_class.occurs_on,1,7)
          BETWEEN clock.from_month AND clock.to_month
        AND (
          (${membershipAlias}.membership_kind='interval'
            AND ${membershipAlias}.starts_on<=activity_class.occurs_on
            AND coalesce(${membershipAlias}.ends_on,'9999-12-31')
              >=activity_class.occurs_on)
          OR (${membershipAlias}.membership_kind='observation'
            AND ${membershipAlias}.period_precision='day'
            AND ${membershipAlias}.observed_on=activity_class.occurs_on)
          OR (${membershipAlias}.membership_kind='observation'
            AND ${membershipAlias}.period_precision='month'
            AND ${membershipAlias}.observed_month=substr(activity_class.occurs_on,1,7))
        )
        AND leader.status='active' AND leader.starts_on<=activity_class.occurs_on
        AND coalesce(leader.ends_on,'9999-12-31')>=activity_class.occurs_on)
)`

const clockCte = `WITH clock(current_day,from_month,to_month) AS (VALUES (?,?,?))`

const programsSql = `SELECT id,code,label,status,version,created_at,updated_at
  FROM activity_programs ORDER BY id LIMIT 3`

const groupsSql = (scoped) => scoped
  ? `${clockCte}
     SELECT activity_group.id,activity_group.program_id,activity_group.label_envelope,
       activity_group.details_envelope,activity_group.status,activity_group.version,
       activity_group.created_at,activity_group.updated_at
     FROM activity_groups AS activity_group,clock
     WHERE ${groupVisibility()} ORDER BY activity_group.id LIMIT 101`
  : `SELECT id,program_id,label_envelope,details_envelope,status,version,created_at,updated_at
     FROM activity_groups ORDER BY id LIMIT 101`

const leadersSql = (scoped) => scoped
  ? `${clockCte}
     SELECT leader.id,leader.group_id,leader.specialist_id,leader.starts_on,leader.ends_on,
       leader.status,leader.version,leader.created_at,leader.updated_at
     FROM activity_group_leaders AS leader
     JOIN activity_groups AS activity_group ON activity_group.id=leader.group_id,clock
     WHERE ${groupVisibility()} ORDER BY leader.id LIMIT 2001`
  : `SELECT id,group_id,specialist_id,starts_on,ends_on,status,version,created_at,updated_at
     FROM activity_group_leaders ORDER BY id LIMIT 2001`

const participantsSql = (scoped) => scoped
  ? `${clockCte}
     SELECT participant.id,participant.program_id,participant.identity_envelope,
       participant.client_id,participant.historical_client_id,participant.status,
       participant.version,participant.created_at,participant.updated_at
     FROM activity_participants AS participant,clock
     WHERE ${participantVisibility()} ORDER BY participant.id LIMIT 1001`
  : `SELECT id,program_id,identity_envelope,client_id,historical_client_id,status,
       version,created_at,updated_at FROM activity_participants ORDER BY id LIMIT 1001`

const membershipsSql = (scoped) => scoped
  ? `${clockCte}
     SELECT membership.id,membership.participant_id,membership.program_id,
       membership.group_id,membership.membership_kind,membership.period_precision,
       membership.observed_on,membership.observed_month,membership.starts_on,
       membership.ends_on,membership.status,membership.version,membership.created_at,
       membership.updated_at
     FROM activity_memberships AS membership,clock
     WHERE ${membershipVisibility()}
     ORDER BY membership.id LIMIT 2001`
  : `SELECT id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at
     FROM activity_memberships
     WHERE membership_kind='interval' OR observed_month BETWEEN ? AND ?
     ORDER BY id LIMIT 2001`

const classesSql = (scoped) => scoped
  ? `${clockCte}
     SELECT activity_class.id,activity_class.group_id,activity_class.occurs_on,
       activity_class.wall_time,activity_class.duration_minutes,
       activity_class.topic_envelope,activity_class.status,activity_class.version,
       activity_class.created_at,activity_class.updated_at
     FROM activity_classes AS activity_class
     JOIN activity_group_leaders AS leader ON leader.group_id=activity_class.group_id
       AND leader.specialist_id=?,clock
     WHERE substr(activity_class.occurs_on,1,7) BETWEEN clock.from_month AND clock.to_month
       AND leader.status='active' AND leader.starts_on<=activity_class.occurs_on
       AND coalesce(leader.ends_on,'9999-12-31')>=activity_class.occurs_on
     GROUP BY activity_class.id ORDER BY activity_class.id LIMIT 1001`
  : `SELECT id,group_id,occurs_on,wall_time,duration_minutes,topic_envelope,status,
       version,created_at,updated_at FROM activity_classes
     WHERE substr(occurs_on,1,7) BETWEEN ? AND ? ORDER BY id LIMIT 1001`

const attendanceSql = (scoped) => scoped
  ? `${clockCte}
     SELECT attendance.id,attendance.class_id,attendance.participant_id,
       attendance.status,attendance.version,attendance.created_at,attendance.updated_at
     FROM activity_attendance AS attendance
     JOIN activity_classes AS activity_class ON activity_class.id=attendance.class_id
     JOIN activity_group_leaders AS leader ON leader.group_id=activity_class.group_id
       AND leader.specialist_id=?,clock
     WHERE substr(activity_class.occurs_on,1,7) BETWEEN clock.from_month AND clock.to_month
       AND leader.status='active' AND leader.starts_on<=activity_class.occurs_on
       AND coalesce(leader.ends_on,'9999-12-31')>=activity_class.occurs_on
     GROUP BY attendance.id ORDER BY attendance.id LIMIT 10001`
  : `SELECT attendance.id,attendance.class_id,attendance.participant_id,
       attendance.status,attendance.version,attendance.created_at,attendance.updated_at
     FROM activity_attendance AS attendance
     JOIN activity_classes AS activity_class ON activity_class.id=attendance.class_id
     WHERE substr(activity_class.occurs_on,1,7) BETWEEN ? AND ?
     ORDER BY attendance.id LIMIT 10001`

const chargesSql = (scoped) => `SELECT charge.id,charge.participant_id,charge.program_id,
  charge.group_id,charge.membership_id,charge.period_precision,charge.occurred_on,
  charge.accounting_month,charge.lesson_count,charge.responsible_specialist_id,
  charge.finance_entry_id,charge.status,charge.version,charge.created_at,charge.updated_at,
  finance.amount_grosze,finance.paid_amount_grosze,finance.payment_method,
  finance.settlement_status
  FROM activity_charges AS charge
  JOIN finance_entries AS finance ON finance.id=charge.finance_entry_id
  LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=finance.id
  WHERE charge.status='active' AND void.id IS NULL
    AND charge.accounting_month BETWEEN ? AND ?
    ${scoped ? 'AND charge.responsible_specialist_id=?' : ''}
  ORDER BY charge.id LIMIT 5001`

const latestSql = (scoped) => scoped
  ? `WITH clock(current_month) AS (VALUES (?)), populated(program_id,month) AS (
       SELECT charge.program_id,charge.accounting_month
       FROM activity_charges AS charge
       JOIN finance_entries AS finance ON finance.id=charge.finance_entry_id
       LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=finance.id
       CROSS JOIN clock
       WHERE charge.status='active' AND void.id IS NULL
         AND charge.responsible_specialist_id=?
         AND charge.accounting_month<=clock.current_month
       UNION ALL
       SELECT membership.program_id,membership.observed_month
       FROM activity_memberships AS membership
       JOIN activity_group_leaders AS leader ON leader.group_id=membership.group_id
         AND leader.specialist_id=?,clock
       WHERE membership.membership_kind='observation' AND membership.status='active'
         AND membership.observed_month<=clock.current_month
         AND leader.status='active'
         AND leader.starts_on<=coalesce(membership.observed_on,membership.observed_month||'-31')
         AND coalesce(leader.ends_on,'9999-12-31')
           >=coalesce(membership.observed_on,membership.observed_month||'-01')
     ) SELECT max(CASE WHEN program_id='apg_tus' THEN month END) AS tus,
         max(CASE WHEN program_id='apg_english' THEN month END) AS english
       FROM populated`
  : `WITH populated(program_id,month) AS (
       SELECT charge.program_id,charge.accounting_month
       FROM activity_charges AS charge
       JOIN finance_entries AS finance ON finance.id=charge.finance_entry_id
       LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=finance.id
       WHERE charge.status='active' AND void.id IS NULL AND charge.accounting_month<=?
       UNION ALL
       SELECT membership.program_id,membership.observed_month
       FROM activity_memberships AS membership
       WHERE membership.membership_kind='observation' AND membership.status='active'
         AND membership.observed_month<=?
     ) SELECT max(CASE WHEN program_id='apg_tus' THEN month END) AS tus,
         max(CASE WHEN program_id='apg_english' THEN month END) AS english
       FROM populated`

const dataKey = async (db) => {
  const row = await db.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
       kek_version,created_at,retired_at FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1`,
  ).bind(ACTIVITY_SCOPE.type, ACTIVITY_SCOPE.id, ACTIVITY_SCOPE.purpose).first()
  if (row === null) return null
  const captured = exact(row, DATA_KEY_FIELDS)
  if (captured.scope_type !== ACTIVITY_SCOPE.type || captured.scope_id !== ACTIVITY_SCOPE.id
    || captured.purpose !== ACTIVITY_SCOPE.purpose || captured.retired_at !== null) internal()
  return Object.freeze(captured)
}

const groupDto = async (row, keyring, activityDataKey) => ({
  id: row.id,
  programId: row.program_id,
  label: await decryptActivityIdentity(keyring, activityDataKey, {
    kind: 'group', id: row.id, programId: row.program_id, envelope: row.label_envelope,
  }),
  details: row.details_envelope === null ? null : await decryptActivityField(
    keyring, activityDataKey, {
      kind: 'groupDetails', id: row.id, envelope: row.details_envelope,
    },
  ),
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const participantDto = async (row, keyring, activityDataKey) => ({
  id: row.id,
  programId: row.program_id,
  name: await decryptActivityIdentity(keyring, activityDataKey, {
    kind: 'participant', id: row.id, programId: row.program_id,
    envelope: row.identity_envelope,
  }),
  clientId: row.client_id,
  historicalClientId: row.historical_client_id,
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const classDto = async (row, keyring, activityDataKey) => ({
  id: row.id,
  groupId: row.group_id,
  date: row.occurs_on,
  time: row.wall_time,
  durationMinutes: row.duration_minutes,
  topic: row.topic_envelope === null ? null : await decryptActivityField(
    keyring, activityDataKey, {
      kind: 'classTopic', id: row.id, envelope: row.topic_envelope,
    },
  ),
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export async function readActivityWorkspace(input) {
  const command = exact(input, ['db', 'actor', 'keyring', 'nowMs', 'window'])
  if (!command.db?.prepare || !command.keyring
    || !Number.isSafeInteger(command.nowMs) || command.nowMs < 0) internal()
  const actor = actorFact(command.actor)
  let window
  try { window = captureActivityMonthWindow(command.window) } catch { invalid('body') }
  const current = partsInWarsaw(command.nowMs)
  const scoped = actor.role === 'specialist'
  const clock = [current.day, window.from, window.to]
  const activityDataKey = await dataKey(command.db)
  const programs = await rowsFor(command.db, programsSql, [], 'programs')
  const groups = await rowsFor(command.db, groupsSql(scoped), scoped
    ? [...clock, actor.specialistId, actor.specialistId] : [], 'groups')
  const groupLeaders = await rowsFor(command.db, leadersSql(scoped), scoped
    ? [...clock, actor.specialistId, actor.specialistId] : [], 'groupLeaders')
  const participants = await rowsFor(command.db, participantsSql(scoped), scoped
    ? [...clock, actor.specialistId, actor.specialistId, actor.specialistId]
    : [], 'participants')
  const memberships = await rowsFor(command.db, membershipsSql(scoped), scoped
    ? [...clock, actor.specialistId, actor.specialistId, actor.specialistId,
      actor.specialistId]
    : [window.from, window.to],
  'memberships')
  const classes = await rowsFor(command.db, classesSql(scoped), scoped
    ? [...clock, actor.specialistId] : [window.from, window.to], 'classes')
  const attendance = await rowsFor(command.db, attendanceSql(scoped), scoped
    ? [...clock, actor.specialistId] : [window.from, window.to], 'attendance')
  const charges = await rowsFor(command.db, chargesSql(scoped), scoped
    ? [window.from, window.to, actor.specialistId] : [window.from, window.to], 'charges')
  const latestBindings = scoped
    ? [current.month, actor.specialistId, actor.specialistId]
    : [current.month, current.month]
  const latest = await command.db.prepare(latestSql(scoped)).bind(...latestBindings).first()
  if (!latest || Reflect.ownKeys(latest).length !== 2) internal()
  if ((groups.length || participants.length || classes.some((row) => row.topic_envelope))
    && !activityDataKey) internal()
  const data = {
    from: window.from,
    to: window.to,
    complete: true,
    currentDay: current.day,
    latestPopulatedMonths: { tus: latest.tus, english: latest.english },
    programs: programs.map((row) => ({
      id: row.id, code: row.code, label: row.label, status: row.status,
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    groups: await Promise.all(groups.map((row) => groupDto(
      row, command.keyring, activityDataKey,
    ))),
    groupLeaders: groupLeaders.map((row) => ({
      id: row.id, groupId: row.group_id, specialistId: row.specialist_id,
      startsOn: row.starts_on, endsOn: row.ends_on, status: row.status,
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    participants: await Promise.all(participants.map((row) => participantDto(
      row, command.keyring, activityDataKey,
    ))),
    memberships: memberships.map((row) => ({
      id: row.id, participantId: row.participant_id, programId: row.program_id,
      groupId: row.group_id, membershipKind: row.membership_kind,
      period: {
        precision: row.period_precision, day: row.observed_on, month: row.observed_month,
      },
      startsOn: row.starts_on, endsOn: row.ends_on, status: row.status,
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    classes: await Promise.all(classes.map((row) => classDto(
      row, command.keyring, activityDataKey,
    ))),
    attendance: attendance.map((row) => ({
      id: row.id, classId: row.class_id, participantId: row.participant_id,
      status: row.status, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    charges: charges.map((row) => ({
      id: row.id, participantId: row.participant_id, programId: row.program_id,
      groupId: row.group_id, membershipId: row.membership_id,
      period: {
        precision: row.period_precision, day: row.occurred_on,
        month: row.accounting_month,
      },
      lessonCount: row.lesson_count,
      responsibleSpecialistId: row.responsible_specialist_id,
      financeEntryId: row.finance_entry_id, status: row.status, version: row.version,
      finance: {
        amountGrosze: row.amount_grosze, paidAmountGrosze: row.paid_amount_grosze,
        paymentMethod: row.payment_method, settlementStatus: row.settlement_status,
      },
      createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    payments: [],
  }
  return Object.freeze({
    data: captureActivityWorkspace(data, { currentMonth: current.month }),
  })
}

const COMMAND_INPUT_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const GENERATED_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const GENERATED = Object.freeze({
  key: /^key_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  group: /^agr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  leader: /^agl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  participant: /^acp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  membership: /^amb_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  class: /^acl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  attendance: /^aat_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  version: /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  audit: /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
})
const TARGET_IDS = Object.freeze({
  groupId: GENERATED.group,
  participantId: GENERATED.participant,
  membershipId: GENERATED.membership,
  classId: GENERATED.class,
})
const GROUP_CREATE_OPERATION = 'activity.group.create'
const GROUP_CREATE_REPLAY_RECORD_ID = 'agr_activity_group_create_replay'
const GROUP_CREATE_REPLAY_SCHEMA = 'activity_group_create_replay.v1'

const validationError = (field = 'body') => {
  throw new TypeError(`VALIDATION_FAILED/${field}`)
}

const instantFor = (nowMs) => {
  try {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) validationError()
    const result = new Date(nowMs).toISOString()
    if (Date.parse(result) !== nowMs) validationError()
    return result
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('VALIDATION_FAILED/')) {
      throw error
    }
    validationError()
  }
}

const groupCreateCommand = (input) => {
  const command = exact(input, COMMAND_INPUT_KEYS)
  if (!command.db?.prepare || !command.db?.batch || !command.recoveryDb?.prepare
    || !command.keyring || typeof command.idFactory !== 'function'
    || typeof command.correlationId !== 'string' || !UUID.test(command.correlationId)
    || typeof command.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey)) validationError()
  const actor = actorFact(command.actor)
  if (!authorize(actor, 'tus.manage', ACTIVITY_CENTRE_RESOURCE, {
    nowMs: command.nowMs,
  })) throw new Error('FORBIDDEN')
  let body
  try { body = captureCreateActivityGroupCommand(command.body) } catch {
    validationError()
  }
  return Object.freeze({
    ...command, actor, body, now: instantFor(command.nowMs),
    currentDay: partsInWarsaw(command.nowMs).day,
  })
}

const generated = (command, used, prefix, kind) => {
  let suffix
  try { suffix = command.idFactory() } catch { throw new Error('INTERNAL_ERROR') }
  const value = `${prefix}_${suffix}`
  if (typeof suffix !== 'string' || !GENERATED_SUFFIX.test(suffix)
    || !GENERATED[kind]?.test(value) || used.has(value)) throw new Error('INTERNAL_ERROR')
  used.add(value)
  return value
}

const digestGroupCreate = async (body) => {
  const bytes = new TextEncoder().encode(JSON.stringify({
    route: 'POST /api/v1/activities/groups',
    body: {
      programId: body.programId,
      label: body.label,
      details: body.details,
      leaderSpecialistIds: body.leaderSpecialistIds,
    },
  }))
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return encodeBase64Url(digest)
  } finally {
    bytes.fill(0)
    digest?.fill(0)
  }
}

const loadGroupCreateReplay = (db, actorId, idempotencyKey) => db.prepare(
  `SELECT request_hash,response_envelope FROM activity_request_replays
   WHERE actor_staff_id=? AND operation=? AND idempotency_key=?`,
).bind(actorId, GROUP_CREATE_OPERATION, idempotencyKey).first()

const groupCreateResponse = (group, groupLeaders) => Object.freeze({
  status: 201,
  body: Object.freeze({ data: Object.freeze({ group, groupLeaders }) }),
})

const openGroupCreateReplay = async (db, command, row) => {
  if (row.request_hash !== command.requestHash) throw new Error('IDEMPOTENCY_CONFLICT')
  const activityDataKey = await loadActivityDataKey(db, row.response_envelope)
  const payload = await openActivityPayload(command.keyring, activityDataKey, {
    recordId: GROUP_CREATE_REPLAY_RECORD_ID,
    field: 'request_replay',
    envelope: row.response_envelope,
  })
  const replay = exact(payload, ['schema', 'status', 'group', 'groupLeaders'])
  let group
  let groupLeaders
  try {
    group = captureActivityGroup(replay.group)
    if (!Array.isArray(replay.groupLeaders) || replay.groupLeaders.length > 20) internal()
    groupLeaders = Object.freeze(replay.groupLeaders.map(captureActivityGroupLeader))
  } catch { throw new Error('CRYPTO_FAILURE') }
  if (replay.schema !== GROUP_CREATE_REPLAY_SCHEMA || replay.status !== 201
    || group.programId !== command.body.programId || group.label !== command.body.label
    || group.details !== command.body.details || group.status !== 'active' || group.version !== 1
    || groupLeaders.some((leader) => leader.groupId !== group.id)
    || groupLeaders.some((leader, index) => index > 0
      && groupLeaders[index - 1].id >= leader.id)
    || JSON.stringify(groupLeaders.map(({ specialistId }) => specialistId).sort())
      !== JSON.stringify(command.body.leaderSpecialistIds)) throw new Error('CRYPTO_FAILURE')
  return groupCreateResponse(group, groupLeaders)
}

const loadGroupCreateAuthority = async (command) => {
  const program = await command.db.prepare(
    `SELECT id FROM activity_programs WHERE id=? AND status='active'`,
  ).bind(command.body.programId).first()
  if (program?.id !== command.body.programId) throw new Error('NOT_FOUND')
  if (!command.body.leaderSpecialistIds.length) return
  const placeholders = command.body.leaderSpecialistIds.map(() => '?').join(',')
  const rows = (await command.db.prepare(
    `SELECT id FROM specialists WHERE status='active' AND id IN (${placeholders})
     ORDER BY id LIMIT 21`,
  ).bind(...command.body.leaderSpecialistIds).all()).results
  if (!Array.isArray(rows)
    || JSON.stringify(rows.map(({ id }) => id))
      !== JSON.stringify(command.body.leaderSpecialistIds)) throw new Error('NOT_FOUND')
}

const groupVersionStatement = async (command, used, dataKey, entityType, entity) => (
  command.db.prepare(`INSERT INTO record_versions
    (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
     changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
    generated(command, used, 'ver', 'version'), entityType, entity.id, entity.version,
    await sealActivityPayload(command.keyring, dataKey, {
      recordId: entity.id, field: 'record_version', value: entity,
    }),
    command.actor.id, command.now, command.correlationId,
  )
)

const chunksOf = (values, size) => Array.from(
  { length: Math.ceil(values.length / size) },
  (_, index) => values.slice(index * size, (index + 1) * size),
)

const versionRowsStatements = async (command, used, dataKey, rows) => {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 41) internal()
  const statements = []
  for (const chunk of chunksOf(rows, 12)) {
    const values = []
    const bindings = []
    for (const { entityType, entity } of chunk) {
      values.push('(?,?,?,?,?,?,?,?)')
      bindings.push(
        generated(command, used, 'ver', 'version'), entityType, entity.id, entity.version,
        await sealActivityPayload(command.keyring, dataKey, {
          recordId: entity.id, field: 'record_version', value: entity,
        }),
        command.actor.id, command.now, command.correlationId,
      )
    }
    statements.push(command.db.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES ${values.join(',')}`).bind(...bindings))
  }
  return statements
}

const leaderInsertStatements = (command, leaders) => {
  if (!leaders.length) return []
  return chunksOf(leaders, 10).map((chunk) => {
    const values = chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')
    return command.db.prepare(`INSERT INTO activity_group_leaders
      (id,group_id,specialist_id,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES ${values}`).bind(...chunk.flatMap((leader) => [
      leader.id, leader.groupId, leader.specialistId, leader.startsOn, leader.endsOn,
      leader.status, leader.version, leader.createdAt, leader.updatedAt,
    ]))
  })
}

const leaderCloseStatements = (command, leaders) => {
  if (!leaders.length) return []
  return chunksOf(leaders, 15).map((chunk) => {
    const endsOnCases = chunk.map(() => 'WHEN ? THEN ?').join(' ')
    const versionCases = chunk.map(() => 'WHEN ? THEN ?').join(' ')
    const predicates = chunk.map(() => '(id=? AND version=?)').join(' OR ')
    return command.db.prepare(`UPDATE activity_group_leaders SET
      ends_on=CASE id ${endsOnCases} ELSE ends_on END,
      status='inactive',
      version=CASE id ${versionCases} ELSE version END,
      updated_at=? WHERE ${predicates}`).bind(
      ...chunk.flatMap(({ id, endsOn }) => [id, endsOn]),
      ...chunk.flatMap(({ id, version }) => [id, version]),
      command.now,
      ...chunk.flatMap(({ id, version }) => [id, version - 1]),
    )
  })
}

const groupCreateGuard = (command, {
  group, groupLeaders, dataKey, auditId, requestHash,
}) => command.db.prepare(`INSERT INTO core_directory_invariant_failures (failure_kind)
  SELECT 'activity_group_create_uow' WHERE NOT (
    EXISTS (SELECT 1 FROM activity_groups
      WHERE id=? AND program_id=? AND status='active' AND version=1
        AND created_at=? AND updated_at=?
        AND json_extract(label_envelope,'$.dataKeyId')=?
        AND (details_envelope IS NULL
          OR json_extract(details_envelope,'$.dataKeyId')=?))
    AND (SELECT count(*) FROM activity_group_leaders
      WHERE group_id=? AND status='active' AND starts_on=? AND ends_on IS NULL
        AND version=1)=?
    AND (SELECT count(*) FROM record_versions
      WHERE (entity_id=? AND entity_type='activity_group' AND version=1)
        OR (entity_type='activity_group_leader' AND entity_id IN (
          SELECT id FROM activity_group_leaders WHERE group_id=?)))=?
    AND EXISTS (SELECT 1 FROM audit_events WHERE id=?
      AND action='activity.group.created' AND entity_type='activity_group'
      AND entity_id=? AND actor_staff_id=?
      AND json_extract(metadata_json,'$.groupVersion')=1
      AND json_extract(metadata_json,'$.leaderCount')=?)
    AND EXISTS (SELECT 1 FROM activity_request_replays
      WHERE actor_staff_id=? AND operation=? AND idempotency_key=?
        AND request_hash=?))`).bind(
  group.id, group.programId, command.now, command.now, dataKey.id, dataKey.id,
  group.id, command.currentDay, groupLeaders.length,
  group.id, group.id, groupLeaders.length + 1,
  auditId, group.id, command.actor.id, groupLeaders.length,
  command.actor.id, GROUP_CREATE_OPERATION, command.idempotencyKey, requestHash,
)

const recoverGroupCreate = async (command, error) => {
  const replay = await loadGroupCreateReplay(
    command.recoveryDb, command.actor.id, command.idempotencyKey,
  )
  if (replay) return openGroupCreateReplay(command.recoveryDb, command, replay)
  if (String(error?.message ?? error).includes('activity_group_lookup_aliases')) {
    throw new Error('ACTIVITY_CONFLICT')
  }
  throw error
}

export async function createActivityGroup(input) {
  const base = groupCreateCommand(input)
  const requestHash = await digestGroupCreate(base.body)
  const command = Object.freeze({ ...base, requestHash })
  const replay = await loadGroupCreateReplay(
    command.db, command.actor.id, command.idempotencyKey,
  )
  if (replay) return openGroupCreateReplay(command.db, command, replay)
  await loadGroupCreateAuthority(command)
  const used = new Set()
  const dataKey = await getOrCreateDataKey(command.db, command.keyring, ACTIVITY_SCOPE, {
    id: generated(command, used, 'key', 'key'), createdAt: command.now,
  })
  const groupId = generated(command, used, 'agr', 'group')
  const labelEnvelope = await encryptActivityIdentity(command.keyring, dataKey, {
    kind: 'group', id: groupId, programId: command.body.programId,
    value: command.body.label,
  })
  const detailsEnvelope = command.body.details === null ? null
    : await encryptActivityField(command.keyring, dataKey, {
      kind: 'groupDetails', id: groupId, value: command.body.details,
    })
  const group = captureActivityGroup({
    id: groupId, programId: command.body.programId, label: command.body.label,
    details: command.body.details, status: 'active', version: 1,
    createdAt: command.now, updatedAt: command.now,
  })
  const groupLeaders = Object.freeze(command.body.leaderSpecialistIds.map(
    (specialistId) => captureActivityGroupLeader({
      id: generated(command, used, 'agl', 'leader'), groupId,
      specialistId, startsOn: command.currentDay, endsOn: null,
      status: 'active', version: 1, createdAt: command.now, updatedAt: command.now,
    }),
  ).sort((left, right) => left.id.localeCompare(right.id)))
  const lookupCandidates = await activityIdentityLookupCandidates(command.keyring, {
    kind: 'group', programId: group.programId, value: group.label,
  })
  const responseEnvelope = await sealActivityPayload(command.keyring, dataKey, {
    recordId: GROUP_CREATE_REPLAY_RECORD_ID,
    field: 'request_replay',
    value: {
      schema: GROUP_CREATE_REPLAY_SCHEMA, status: 201, group, groupLeaders,
    },
  })
  const auditId = generated(command, used, 'aud', 'audit')
  const statements = [
    command.db.prepare(`INSERT INTO activity_groups
      (id,program_id,label_envelope,details_envelope,status,version,created_at,updated_at)
      VALUES (?,?,?,?,'active',1,?,?)`).bind(
      group.id, group.programId, labelEnvelope, detailsEnvelope, command.now, command.now,
    ),
    ...lookupCandidates.map((lookup) => command.db.prepare(
      `INSERT INTO activity_group_lookup_aliases
       (group_id,program_id,domain,hmac_version,lookup_digest,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(
      group.id, group.programId, lookup.domain, lookup.version, lookup.digest, command.now,
    )),
    ...leaderInsertStatements(command, groupLeaders),
    ...await versionRowsStatements(command, used, dataKey, [
      { entityType: 'activity_group', entity: { schema: 'activity_group.v1', ...group } },
      ...groupLeaders.map((leader) => ({
        entityType: 'activity_group_leader',
        entity: { schema: 'activity_group_leader.v1', ...leader },
      })),
    ]),
  ]
  statements.push(
    auditEventStatement(command.db, {
      id: auditId, occurredAt: command.now, actorStaffId: command.actor.id,
      action: 'activity.group.created', entityType: 'activity_group',
      entityId: group.id, result: 'success', correlationId: command.correlationId,
      metadata: { groupVersion: 1, leaderCount: groupLeaders.length },
      reasonEnvelope: null,
    }),
    command.db.prepare(`INSERT INTO activity_request_replays
      (actor_staff_id,operation,idempotency_key,request_hash,response_envelope,created_at)
      VALUES (?,?,?,?,?,?)`).bind(
      command.actor.id, GROUP_CREATE_OPERATION, command.idempotencyKey,
      requestHash, responseEnvelope, command.now,
    ),
    groupCreateGuard(command, {
      group, groupLeaders, dataKey, auditId, requestHash,
    }),
  )
  try { await command.db.batch(statements) } catch (error) {
    return recoverGroupCreate(command, error)
  }
  return groupCreateResponse(group, groupLeaders)
}

const commandInput = (input, { targetKey = null, capture, centreOnly = false }) => {
  const keys = targetKey === null ? COMMAND_INPUT_KEYS : [...COMMAND_INPUT_KEYS, targetKey]
  let command
  try { command = exact(input, keys) } catch { validationError() }
  if (!command.db?.prepare || !command.db?.batch || !command.recoveryDb?.prepare
    || !command.keyring || typeof command.idFactory !== 'function'
    || typeof command.correlationId !== 'string' || !UUID.test(command.correlationId)
    || typeof command.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey)
    || (targetKey !== null && !TARGET_IDS[targetKey]?.test(command[targetKey]))) {
    validationError()
  }
  const actor = actorFact(command.actor)
  let body
  try { body = capture(command.body) } catch { validationError() }
  if (centreOnly && !authorize(actor, 'tus.manage', ACTIVITY_CENTRE_RESOURCE, {
    nowMs: command.nowMs,
  })) throw new Error('FORBIDDEN')
  return Object.freeze({
    ...command, actor, body, now: instantFor(command.nowMs),
    currentDay: partsInWarsaw(command.nowMs).day,
  })
}

const requestDigest = async (route, body) => {
  const bytes = new TextEncoder().encode(JSON.stringify({ route, body }))
  let digest
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return encodeBase64Url(digest)
  } finally {
    bytes.fill(0)
    digest?.fill(0)
  }
}

const loadCommandReplay = (db, actorId, operation, idempotencyKey) => db.prepare(
  `SELECT request_hash,response_envelope FROM activity_request_replays
   WHERE actor_staff_id=? AND operation=? AND idempotency_key=?`,
).bind(actorId, operation, idempotencyKey).first()

const commandResponse = (status, data) => Object.freeze({
  status,
  body: Object.freeze({ data: Object.freeze(data) }),
})

const singleResponseData = (value, key, capture) => {
  const data = exact(value, [key])
  return Object.freeze({ [key]: capture(data[key]) })
}

const groupResponseData = (value) => {
  const data = exact(value, ['group', 'groupLeaders'])
  const group = captureActivityGroup(data.group)
  if (!Array.isArray(data.groupLeaders) || data.groupLeaders.length > 20) internal()
  const groupLeaders = Object.freeze(data.groupLeaders.map(captureActivityGroupLeader))
  if (groupLeaders.some((leader) => leader.groupId !== group.id || leader.status !== 'active')) {
    internal()
  }
  if (groupLeaders.some((leader, index) => index > 0
    && groupLeaders[index - 1].id >= leader.id)) internal()
  return Object.freeze({ group, groupLeaders })
}

const openCommandReplay = async (db, command, config, row) => {
  if (row.request_hash !== command.requestHash) throw new Error('IDEMPOTENCY_CONFLICT')
  const activityDataKey = await loadActivityDataKey(db, row.response_envelope)
  const payload = await openActivityPayload(command.keyring, activityDataKey, {
    recordId: config.replayRecordId,
    field: 'request_replay',
    envelope: row.response_envelope,
  })
  let replay
  let data
  try {
    replay = exact(payload, ['schema', 'status', 'data'])
    data = config.captureData(replay.data)
  } catch { throw new Error('CRYPTO_FAILURE') }
  if (replay.schema !== config.replaySchema || replay.status !== config.status
    || !config.accept(data, command)) throw new Error('CRYPTO_FAILURE')
  return commandResponse(replay.status, data)
}

const sealCommandReplay = async (command, dataKey, config, data) => (
  sealActivityPayload(command.keyring, dataKey, {
    recordId: config.replayRecordId,
    field: 'request_replay',
    value: { schema: config.replaySchema, status: config.status, data },
  })
)

const replayStatement = (command, config, responseEnvelope) => command.db.prepare(
  `INSERT INTO activity_request_replays
   (actor_staff_id,operation,idempotency_key,request_hash,response_envelope,created_at)
   VALUES (?,?,?,?,?,?)`,
).bind(
  command.actor.id, config.operation, command.idempotencyKey, command.requestHash,
  responseEnvelope, command.now,
)

const mutationGuard = (command, config, {
  entityId, entityVersion, auditId,
}) => command.db.prepare(`INSERT INTO core_directory_invariant_failures (failure_kind)
  SELECT ? WHERE NOT (
    EXISTS (SELECT 1 FROM ${config.table} WHERE id=? AND version=? AND updated_at=?)
    AND EXISTS (SELECT 1 FROM record_versions
      WHERE entity_type=? AND entity_id=? AND version=?
        AND changed_by_staff_id=? AND changed_at=? AND correlation_id=?)
    AND EXISTS (SELECT 1 FROM audit_events
      WHERE id=? AND action=? AND entity_type=? AND entity_id=?
        AND actor_staff_id=? AND correlation_id=?)
    AND EXISTS (SELECT 1 FROM activity_request_replays
      WHERE actor_staff_id=? AND operation=? AND idempotency_key=?
        AND request_hash=?))`).bind(
  `${config.operation}_uow`, entityId, entityVersion, command.now,
  config.entityType, entityId, entityVersion, command.actor.id, command.now,
  command.correlationId,
  auditId, config.auditAction, config.entityType, entityId, command.actor.id,
  command.correlationId,
  command.actor.id, config.operation, command.idempotencyKey, command.requestHash,
)

const versionConflict = (currentVersion) => {
  const error = new Error('VERSION_CONFLICT')
  error.details = { currentVersion }
  return error
}

const isActivityConflict = (error) => {
  const message = String(error?.message ?? error)
  return /activity_(?:group|participant|membership|class|attendance)/.test(message)
    || /UNIQUE constraint failed: activity_/.test(message)
    || /FOREIGN KEY constraint failed/.test(message)
}

const recoverCommand = async (command, config, error, expected = null) => {
  const replay = await loadCommandReplay(
    command.recoveryDb, command.actor.id, config.operation, command.idempotencyKey,
  )
  if (replay) return openCommandReplay(command.recoveryDb, command, config, replay)
  if (expected) {
    const current = await command.recoveryDb.prepare(
      `SELECT version FROM ${config.table} WHERE id=?`,
    ).bind(expected.id).first()
    if (Number.isSafeInteger(current?.version)
      && current.version !== expected.version) throw versionConflict(current.version)
  }
  if (isActivityConflict(error)) throw new Error('ACTIVITY_CONFLICT')
  throw error
}

const prepareCommand = async (base, route, config) => {
  const requestHash = await requestDigest(route, base.body)
  const command = Object.freeze({ ...base, requestHash })
  const replayRow = await loadCommandReplay(
    command.db, command.actor.id, config.operation, command.idempotencyKey,
  )
  return Object.freeze({ command, replayRow })
}

const dataKeyForCreate = (command, used) => getOrCreateDataKey(
  command.db, command.keyring, ACTIVITY_SCOPE, {
    id: generated(command, used, 'key', 'key'), createdAt: command.now,
  },
)

const requireActivityDataKey = async (db) => {
  const result = await dataKey(db)
  if (!result) throw new Error('CRYPTO_FAILURE')
  return result
}

const groupEditConfig = (groupId) => ({
  operation: 'activity.group.edit',
  replayRecordId: groupId,
  replaySchema: 'activity_group_edit_replay.v1',
  status: 200,
  table: 'activity_groups',
  entityType: 'activity_group',
  auditAction: 'activity.group.updated',
  captureData: groupResponseData,
  accept: (data, command) => data.group.id === command.groupId
    && data.group.label === command.body.label
    && data.group.details === command.body.details
    && data.group.status === command.body.status
    && data.group.version === command.body.expectedVersion + 1
    && JSON.stringify(data.groupLeaders.map(({ specialistId }) => specialistId).sort())
      === JSON.stringify(command.body.leaderSpecialistIds),
})

export async function editActivityGroup(input) {
  const base = commandInput(input, {
    targetKey: 'groupId', capture: captureEditActivityGroupCommand,
  })
  const config = groupEditConfig(base.groupId)
  const prepared = await prepareCommand(
    base, `POST /api/v1/activities/groups/${base.groupId}/edits`, config,
  )
  const command = prepared.command
  if (command.body.status === 'inactive' && command.body.leaderSpecialistIds.length) {
    validationError()
  }
  const fact = await loadActivityGroupResourceFact(
    command.db, command.actor, command.groupId, command.nowMs,
  )
  if (!authorize(command.actor, 'tus.manage', fact, { nowMs: command.nowMs })) {
    throw new Error('NOT_FOUND')
  }
  if (prepared.replayRow) {
    return openCommandReplay(command.db, command, config, prepared.replayRow)
  }
  const current = await command.db.prepare(`SELECT id,program_id,label_envelope,
    details_envelope,status,version,created_at,updated_at FROM activity_groups WHERE id=?`)
    .bind(command.groupId).first()
  if (!current || current.id !== command.groupId) throw new Error('NOT_FOUND')
  if (current.version !== command.body.expectedVersion) {
    throw versionConflict(current.version)
  }
  const currentLeaders = (await command.db.prepare(`SELECT id,group_id,specialist_id,
    starts_on,ends_on,status,version,created_at,updated_at
    FROM activity_group_leaders WHERE group_id=? AND status='active'
      AND (?='inactive' OR (
        starts_on<=? AND coalesce(ends_on,'9999-12-31')>=?))
    ORDER BY specialist_id,id LIMIT 21`).bind(
    command.groupId, command.body.status, command.currentDay, command.currentDay,
  ).all()).results
  if (!Array.isArray(currentLeaders) || currentLeaders.length > 20) internal()
  const currentSpecialistIds = currentLeaders.map(({ specialist_id: value }) => value).sort()
  if (command.actor.role === 'specialist'
    && (command.body.status !== 'active'
      || JSON.stringify(currentSpecialistIds)
        !== JSON.stringify(command.body.leaderSpecialistIds))) throw new Error('FORBIDDEN')
  if (command.body.leaderSpecialistIds.length) {
    const placeholders = command.body.leaderSpecialistIds.map(() => '?').join(',')
    const specialists = (await command.db.prepare(
      `SELECT id FROM specialists WHERE status='active' AND id IN (${placeholders})
       ORDER BY id LIMIT 21`,
    ).bind(...command.body.leaderSpecialistIds).all()).results
    if (!Array.isArray(specialists)
      || JSON.stringify(specialists.map(({ id }) => id))
        !== JSON.stringify(command.body.leaderSpecialistIds)) throw new Error('NOT_FOUND')
  }
  const used = new Set()
  const activityDataKey = await loadActivityDataKey(command.db, current.label_envelope)
  const nextVersion = current.version + 1
  const group = captureActivityGroup({
    id: current.id, programId: current.program_id, label: command.body.label,
    details: command.body.details, status: command.body.status, version: nextVersion,
    createdAt: current.created_at, updatedAt: command.now,
  })
  const retained = []
  const closed = []
  const currentBySpecialist = new Map(currentLeaders.map(
    (leader) => [leader.specialist_id, leader],
  ))
  for (const leader of currentLeaders) {
    if (command.body.leaderSpecialistIds.includes(leader.specialist_id)) {
      retained.push(captureActivityGroupLeader({
        id: leader.id, groupId: leader.group_id, specialistId: leader.specialist_id,
        startsOn: leader.starts_on, endsOn: leader.ends_on, status: leader.status,
        version: leader.version, createdAt: leader.created_at, updatedAt: leader.updated_at,
      }))
      continue
    }
    closed.push(captureActivityGroupLeader({
      id: leader.id, groupId: leader.group_id, specialistId: leader.specialist_id,
      startsOn: leader.starts_on,
      endsOn: leader.starts_on <= command.currentDay
          && (leader.ends_on === null || leader.ends_on >= command.currentDay)
        ? command.currentDay : leader.ends_on,
      status: 'inactive', version: leader.version + 1,
      createdAt: leader.created_at, updatedAt: command.now,
    }))
  }
  const added = command.body.leaderSpecialistIds
    .filter((specialistId) => !currentBySpecialist.has(specialistId))
    .map((specialistId) => captureActivityGroupLeader({
      id: generated(command, used, 'agl', 'leader'), groupId: group.id, specialistId,
      startsOn: command.currentDay, endsOn: null, status: 'active', version: 1,
      createdAt: command.now, updatedAt: command.now,
    }))
  const groupLeaders = Object.freeze([...retained, ...added]
    .sort((left, right) => left.id.localeCompare(right.id)))
  const labelEnvelope = await encryptActivityIdentity(command.keyring, activityDataKey, {
    kind: 'group', id: group.id, programId: group.programId, value: group.label,
  })
  const detailsEnvelope = group.details === null ? null : await encryptActivityField(
    command.keyring, activityDataKey, {
      kind: 'groupDetails', id: group.id, value: group.details,
    },
  )
  const lookupCandidates = await activityIdentityLookupCandidates(command.keyring, {
    kind: 'group', programId: group.programId, value: group.label,
  })
  const data = Object.freeze({ group, groupLeaders })
  const responseEnvelope = await sealCommandReplay(
    command, activityDataKey, config, data,
  )
  const auditId = generated(command, used, 'aud', 'audit')
  const statements = [
    ...leaderCloseStatements(command, closed),
    ...leaderInsertStatements(command, added),
    command.db.prepare(`UPDATE activity_groups SET label_envelope=?,details_envelope=?,
      status=?,version=?,updated_at=? WHERE id=? AND version=?`).bind(
      labelEnvelope, detailsEnvelope, group.status, group.version, command.now,
      group.id, command.body.expectedVersion,
    ),
    ...lookupCandidates.map((lookup) => command.db.prepare(
      `INSERT INTO activity_group_lookup_aliases
       (group_id,program_id,domain,hmac_version,lookup_digest,created_at)
       SELECT ?,?,?,?,?,? WHERE NOT EXISTS (
         SELECT 1 FROM activity_group_lookup_aliases
         WHERE group_id=? AND hmac_version=? AND lookup_digest=?)`,
    ).bind(
      group.id, group.programId, lookup.domain, lookup.version, lookup.digest, command.now,
      group.id, lookup.version, lookup.digest,
    )),
    ...await versionRowsStatements(command, used, activityDataKey, [
      { entityType: 'activity_group', entity: { schema: 'activity_group.v1', ...group } },
      ...[...closed, ...added].map((leader) => ({
        entityType: 'activity_group_leader',
        entity: { schema: 'activity_group_leader.v1', ...leader },
      })),
    ]),
  ]
  statements.push(
    auditEventStatement(command.db, {
      id: auditId, occurredAt: command.now, actorStaffId: command.actor.id,
      action: config.auditAction, entityType: config.entityType, entityId: group.id,
      result: 'success', correlationId: command.correlationId,
      metadata: { groupVersion: group.version, leaderCount: groupLeaders.length },
      reasonEnvelope: null,
    }),
    replayStatement(command, config, responseEnvelope),
    mutationGuard(command, config, {
      entityId: group.id, entityVersion: group.version, auditId,
    }),
  )
  if (closed.length || added.length) {
    const changed = [...closed, ...added]
    const versions = changed.map(() => '(entity_id=? AND version=?)').join(' OR ')
    statements.push(command.db.prepare(
      `INSERT INTO core_directory_invariant_failures (failure_kind)
       SELECT 'activity_group_leader_edit_uow' WHERE (
         SELECT count(*) FROM record_versions
         WHERE entity_type='activity_group_leader' AND (${versions})
           AND changed_by_staff_id=? AND changed_at=? AND correlation_id=?)!=?`,
    ).bind(
      ...changed.flatMap(({ id, version }) => [id, version]), command.actor.id,
      command.now, command.correlationId, changed.length,
    ))
  }
  try { await command.db.batch(statements) } catch (error) {
    return recoverCommand(command, config, error, {
      id: group.id, version: command.body.expectedVersion,
    })
  }
  return commandResponse(config.status, data)
}

const participantConfig = ({ create, participantId = null }) => ({
  operation: create ? 'activity.participant.create' : 'activity.participant.edit',
  replayRecordId: create ? 'acp_activity_participant_create_replay' : participantId,
  replaySchema: create
    ? 'activity_participant_create_replay.v1' : 'activity_participant_edit_replay.v1',
  status: create ? 201 : 200,
  table: 'activity_participants',
  entityType: 'activity_participant',
  auditAction: create ? 'activity.participant.created' : 'activity.participant.updated',
  captureData: (value) => singleResponseData(
    value, 'participant', captureActivityParticipant,
  ),
  accept: (data, command) => {
    const participant = data.participant
    return (create ? participant.programId === command.body.programId
      : participant.id === command.participantId
        && participant.status === command.body.status)
      && participant.name === command.body.name
      && participant.clientId === command.body.clientId
      && participant.historicalClientId === command.body.historicalClientId
      && participant.status === (create ? 'active' : command.body.status)
      && participant.version === (create ? 1 : command.body.expectedVersion + 1)
  },
})

const loadParticipantLinkAuthority = async (command, programId) => {
  const row = await command.db.prepare(`SELECT
    EXISTS (SELECT 1 FROM activity_programs WHERE id=? AND status='active') AS program_ok,
    CASE WHEN ? IS NULL THEN 1 ELSE EXISTS (
      SELECT 1 FROM clients WHERE id=? AND status IN ('active','paused')) END AS client_ok,
    CASE WHEN ? IS NULL THEN 1 ELSE EXISTS (
      SELECT 1 FROM historical_clients WHERE id=? AND status='historical') END AS historical_ok`)
    .bind(
      programId, command.body.clientId, command.body.clientId,
      command.body.historicalClientId, command.body.historicalClientId,
    ).first()
  if (row?.program_ok !== 1 || row.client_ok !== 1 || row.historical_ok !== 1) {
    throw new Error('NOT_FOUND')
  }
}

export async function createActivityParticipant(input) {
  const base = commandInput(input, {
    capture: captureCreateActivityParticipantCommand, centreOnly: true,
  })
  const config = participantConfig({ create: true })
  const prepared = await prepareCommand(
    base, 'POST /api/v1/activities/participants', config,
  )
  const command = prepared.command
  if (prepared.replayRow) {
    return openCommandReplay(command.db, command, config, prepared.replayRow)
  }
  await loadParticipantLinkAuthority(command, command.body.programId)
  const used = new Set()
  const activityDataKey = await dataKeyForCreate(command, used)
  const participant = captureActivityParticipant({
    id: generated(command, used, 'acp', 'participant'),
    programId: command.body.programId, name: command.body.name,
    clientId: command.body.clientId, historicalClientId: command.body.historicalClientId,
    status: 'active', version: 1, createdAt: command.now, updatedAt: command.now,
  })
  const identityEnvelope = await encryptActivityIdentity(command.keyring, activityDataKey, {
    kind: 'participant', id: participant.id, programId: participant.programId,
    value: participant.name,
  })
  const lookupCandidates = await activityIdentityLookupCandidates(command.keyring, {
    kind: 'participant', programId: participant.programId, value: participant.name,
  })
  const data = Object.freeze({ participant })
  const responseEnvelope = await sealCommandReplay(
    command, activityDataKey, config, data,
  )
  const auditId = generated(command, used, 'aud', 'audit')
  const statements = [
    command.db.prepare(`INSERT INTO activity_participants
      (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
       created_at,updated_at) VALUES (?,?,?,?,?,'active',1,?,?)`).bind(
      participant.id, participant.programId, identityEnvelope, participant.clientId,
      participant.historicalClientId, command.now, command.now,
    ),
    ...lookupCandidates.map((lookup) => command.db.prepare(
      `INSERT INTO activity_participant_lookup_aliases
       (participant_id,program_id,domain,hmac_version,lookup_digest,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(
      participant.id, participant.programId, lookup.domain, lookup.version,
      lookup.digest, command.now,
    )),
    await groupVersionStatement(command, used, activityDataKey, 'activity_participant', {
      schema: 'activity_participant.v1', ...participant,
    }),
    auditEventStatement(command.db, {
      id: auditId, occurredAt: command.now, actorStaffId: command.actor.id,
      action: config.auditAction, entityType: config.entityType,
      entityId: participant.id, result: 'success', correlationId: command.correlationId,
      metadata: { participantVersion: participant.version }, reasonEnvelope: null,
    }),
    replayStatement(command, config, responseEnvelope),
    mutationGuard(command, config, {
      entityId: participant.id, entityVersion: participant.version, auditId,
    }),
  ]
  try { await command.db.batch(statements) } catch (error) {
    return recoverCommand(command, config, error)
  }
  return commandResponse(config.status, data)
}

export async function editActivityParticipant(input) {
  const base = commandInput(input, {
    targetKey: 'participantId', capture: captureEditActivityParticipantCommand,
  })
  const config = participantConfig({ create: false, participantId: base.participantId })
  const prepared = await prepareCommand(
    base, `POST /api/v1/activities/participants/${base.participantId}/edits`, config,
  )
  const command = prepared.command
  const fact = await loadActivityParticipantResourceFact(
    command.db, command.actor, command.participantId, command.nowMs,
  )
  if (!authorize(command.actor, 'tus.manage', fact, { nowMs: command.nowMs })) {
    throw new Error('NOT_FOUND')
  }
  if (prepared.replayRow) {
    return openCommandReplay(command.db, command, config, prepared.replayRow)
  }
  const current = await command.db.prepare(`SELECT id,program_id,identity_envelope,
    client_id,historical_client_id,status,version,created_at,updated_at
    FROM activity_participants WHERE id=?`).bind(command.participantId).first()
  if (!current || current.id !== command.participantId) throw new Error('NOT_FOUND')
  if (current.version !== command.body.expectedVersion) {
    throw versionConflict(current.version)
  }
  if (command.actor.role === 'specialist'
    && (command.body.clientId !== current.client_id
      || command.body.historicalClientId !== current.historical_client_id)) {
    throw new Error('FORBIDDEN')
  }
  await loadParticipantLinkAuthority(command, current.program_id)
  const used = new Set()
  const activityDataKey = await loadActivityDataKey(command.db, current.identity_envelope)
  const participant = captureActivityParticipant({
    id: current.id, programId: current.program_id, name: command.body.name,
    clientId: command.body.clientId, historicalClientId: command.body.historicalClientId,
    status: command.body.status, version: current.version + 1,
    createdAt: current.created_at, updatedAt: command.now,
  })
  const identityEnvelope = await encryptActivityIdentity(command.keyring, activityDataKey, {
    kind: 'participant', id: participant.id, programId: participant.programId,
    value: participant.name,
  })
  const lookupCandidates = await activityIdentityLookupCandidates(command.keyring, {
    kind: 'participant', programId: participant.programId, value: participant.name,
  })
  const data = Object.freeze({ participant })
  const responseEnvelope = await sealCommandReplay(
    command, activityDataKey, config, data,
  )
  const auditId = generated(command, used, 'aud', 'audit')
  const statements = [
    command.db.prepare(`UPDATE activity_participants SET identity_envelope=?,client_id=?,
      historical_client_id=?,status=?,version=?,updated_at=? WHERE id=? AND version=?`)
      .bind(
        identityEnvelope, participant.clientId, participant.historicalClientId,
        participant.status, participant.version, command.now, participant.id,
        command.body.expectedVersion,
      ),
    ...lookupCandidates.map((lookup) => command.db.prepare(
      `INSERT INTO activity_participant_lookup_aliases
       (participant_id,program_id,domain,hmac_version,lookup_digest,created_at)
       SELECT ?,?,?,?,?,? WHERE NOT EXISTS (
         SELECT 1 FROM activity_participant_lookup_aliases
         WHERE participant_id=? AND hmac_version=? AND lookup_digest=?)`,
    ).bind(
      participant.id, participant.programId, lookup.domain, lookup.version,
      lookup.digest, command.now, participant.id, lookup.version, lookup.digest,
    )),
    await groupVersionStatement(command, used, activityDataKey, 'activity_participant', {
      schema: 'activity_participant.v1', ...participant,
    }),
    auditEventStatement(command.db, {
      id: auditId, occurredAt: command.now, actorStaffId: command.actor.id,
      action: config.auditAction, entityType: config.entityType,
      entityId: participant.id, result: 'success', correlationId: command.correlationId,
      metadata: { participantVersion: participant.version }, reasonEnvelope: null,
    }),
    replayStatement(command, config, responseEnvelope),
    mutationGuard(command, config, {
      entityId: participant.id, entityVersion: participant.version, auditId,
    }),
  ]
  try { await command.db.batch(statements) } catch (error) {
    return recoverCommand(command, config, error, {
      id: participant.id, version: command.body.expectedVersion,
    })
  }
  return commandResponse(config.status, data)
}

const membershipConfig = ({ create, membershipId = null }) => ({
  operation: create ? 'activity.membership.create' : 'activity.membership.edit',
  replayRecordId: create ? 'amb_activity_membership_create_replay' : membershipId,
  replaySchema: create
    ? 'activity_membership_create_replay.v1' : 'activity_membership_edit_replay.v1',
  status: create ? 201 : 200,
  table: 'activity_memberships',
  entityType: 'activity_membership',
  auditAction: create ? 'activity.membership.created' : 'activity.membership.updated',
  captureData: (value) => singleResponseData(
    value, 'membership', captureActivityMembership,
  ),
  accept: (data, command) => {
    const membership = data.membership
    return (create
      ? membership.participantId === command.body.participantId
        && membership.groupId === command.body.groupId && membership.status === 'active'
      : membership.id === command.membershipId
        && membership.status === command.body.status)
      && membership.membershipKind === 'interval'
      && membership.period.precision === 'unknown'
      && membership.startsOn === command.body.startsOn
      && membership.endsOn === command.body.endsOn
      && membership.version === (create ? 1 : command.body.expectedVersion + 1)
  },
})

const loadMembershipCreateGraph = async (command) => {
  const row = await command.db.prepare(`SELECT activity_group.program_id
    FROM activity_groups AS activity_group
    JOIN activity_participants AS participant
      ON participant.program_id=activity_group.program_id
    JOIN activity_programs AS program ON program.id=activity_group.program_id
    WHERE activity_group.id=? AND participant.id=?
      AND activity_group.status='active' AND participant.status='active'
      AND program.status='active'`).bind(
    command.body.groupId, command.body.participantId,
  ).first()
  if (!row || typeof row.program_id !== 'string') throw new Error('NOT_FOUND')
  return row.program_id
}

export async function createActivityMembership(input) {
  const base = commandInput(input, { capture: captureCreateActivityMembershipCommand })
  const config = membershipConfig({ create: true })
  const prepared = await prepareCommand(
    base, 'POST /api/v1/activities/memberships', config,
  )
  const command = prepared.command
  const fact = await loadActivityGroupResourceFact(
    command.db, command.actor, command.body.groupId, command.nowMs,
  )
  if (!authorize(command.actor, 'tus.manage', fact, { nowMs: command.nowMs })) {
    throw new Error('NOT_FOUND')
  }
  if (command.actor.role === 'specialist') {
    const participantFact = await loadActivityParticipantResourceFact(
      command.db, command.actor, command.body.participantId, command.nowMs,
    )
    if (!authorize(command.actor, 'tus.manage', participantFact, {
      nowMs: command.nowMs,
    })) throw new Error('NOT_FOUND')
  }
  if (prepared.replayRow) {
    return openCommandReplay(command.db, command, config, prepared.replayRow)
  }
  const programId = await loadMembershipCreateGraph(command)
  const used = new Set()
  const activityDataKey = await dataKeyForCreate(command, used)
  const membership = captureActivityMembership({
    id: generated(command, used, 'amb', 'membership'),
    participantId: command.body.participantId, programId,
    groupId: command.body.groupId, membershipKind: 'interval',
    period: { precision: 'unknown', day: null, month: null },
    startsOn: command.body.startsOn, endsOn: command.body.endsOn,
    status: 'active', version: 1, createdAt: command.now, updatedAt: command.now,
  })
  const data = Object.freeze({ membership })
  const responseEnvelope = await sealCommandReplay(
    command, activityDataKey, config, data,
  )
  const auditId = generated(command, used, 'aud', 'audit')
  const statements = [
    command.db.prepare(`INSERT INTO activity_memberships
      (id,participant_id,program_id,group_id,membership_kind,period_precision,
       observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
      VALUES (?,?,?,?,'interval','unknown',NULL,NULL,?,?,'active',1,?,?)`).bind(
      membership.id, membership.participantId, membership.programId, membership.groupId,
      membership.startsOn, membership.endsOn, command.now, command.now,
    ),
    await groupVersionStatement(command, used, activityDataKey, 'activity_membership', {
      schema: 'activity_membership.v1', ...membership,
    }),
    auditEventStatement(command.db, {
      id: auditId, occurredAt: command.now, actorStaffId: command.actor.id,
      action: config.auditAction, entityType: config.entityType,
      entityId: membership.id, result: 'success', correlationId: command.correlationId,
      metadata: { membershipVersion: membership.version }, reasonEnvelope: null,
    }),
    replayStatement(command, config, responseEnvelope),
    mutationGuard(command, config, {
      entityId: membership.id, entityVersion: membership.version, auditId,
    }),
  ]
  try { await command.db.batch(statements) } catch (error) {
    return recoverCommand(command, config, error)
  }
  return commandResponse(config.status, data)
}

export async function editActivityMembership(input) {
  const base = commandInput(input, {
    targetKey: 'membershipId', capture: captureEditActivityMembershipCommand,
  })
  const config = membershipConfig({ create: false, membershipId: base.membershipId })
  const prepared = await prepareCommand(
    base, `POST /api/v1/activities/memberships/${base.membershipId}/edits`, config,
  )
  const command = prepared.command
  const current = await command.db.prepare(`SELECT id,participant_id,program_id,group_id,
    membership_kind,period_precision,observed_on,observed_month,starts_on,ends_on,
    status,version,created_at,updated_at FROM activity_memberships WHERE id=?`)
    .bind(command.membershipId).first()
  if (!current || current.id !== command.membershipId
    || current.membership_kind !== 'interval') throw new Error('NOT_FOUND')
  const fact = await loadActivityGroupResourceFact(
    command.db, command.actor, current.group_id, command.nowMs,
  )
  if (!authorize(command.actor, 'tus.manage', fact, { nowMs: command.nowMs })) {
    throw new Error('NOT_FOUND')
  }
  if (prepared.replayRow) {
    return openCommandReplay(command.db, command, config, prepared.replayRow)
  }
  if (current.version !== command.body.expectedVersion) {
    throw versionConflict(current.version)
  }
  const used = new Set()
  const activityDataKey = await requireActivityDataKey(command.db)
  const membership = captureActivityMembership({
    id: current.id, participantId: current.participant_id,
    programId: current.program_id, groupId: current.group_id,
    membershipKind: 'interval', period: { precision: 'unknown', day: null, month: null },
    startsOn: command.body.startsOn, endsOn: command.body.endsOn,
    status: command.body.status, version: current.version + 1,
    createdAt: current.created_at, updatedAt: command.now,
  })
  const data = Object.freeze({ membership })
  const responseEnvelope = await sealCommandReplay(
    command, activityDataKey, config, data,
  )
  const auditId = generated(command, used, 'aud', 'audit')
  const statements = [
    command.db.prepare(`UPDATE activity_memberships SET starts_on=?,ends_on=?,status=?,
      version=?,updated_at=? WHERE id=? AND version=?`).bind(
      membership.startsOn, membership.endsOn, membership.status, membership.version,
      command.now, membership.id, command.body.expectedVersion,
    ),
    await groupVersionStatement(command, used, activityDataKey, 'activity_membership', {
      schema: 'activity_membership.v1', ...membership,
    }),
    auditEventStatement(command.db, {
      id: auditId, occurredAt: command.now, actorStaffId: command.actor.id,
      action: config.auditAction, entityType: config.entityType,
      entityId: membership.id, result: 'success', correlationId: command.correlationId,
      metadata: { membershipVersion: membership.version }, reasonEnvelope: null,
    }),
    replayStatement(command, config, responseEnvelope),
    mutationGuard(command, config, {
      entityId: membership.id, entityVersion: membership.version, auditId,
    }),
  ]
  try { await command.db.batch(statements) } catch (error) {
    return recoverCommand(command, config, error, {
      id: membership.id, version: command.body.expectedVersion,
    })
  }
  return commandResponse(config.status, data)
}

const classConfig = ({ create, classId = null }) => ({
  operation: create ? 'activity.class.create' : 'activity.class.edit',
  replayRecordId: create ? 'acl_activity_class_create_replay' : classId,
  replaySchema: create
    ? 'activity_class_create_replay.v1' : 'activity_class_edit_replay.v1',
  status: create ? 201 : 200,
  table: 'activity_classes',
  entityType: 'activity_class',
  auditAction: create ? 'activity.class.created' : 'activity.class.updated',
  captureData: (value) => singleResponseData(value, 'class', captureActivityClass),
  accept: (data, command) => {
    const activityClass = data.class
    return (create ? activityClass.groupId === command.body.groupId
      : activityClass.id === command.classId)
      && activityClass.date === command.body.date
      && activityClass.time === command.body.time
      && activityClass.durationMinutes === command.body.durationMinutes
      && activityClass.topic === command.body.topic
      && activityClass.status === command.body.status
      && activityClass.version === (create ? 1 : command.body.expectedVersion + 1)
  },
})

export async function createActivityClass(input) {
  const base = commandInput(input, { capture: captureCreateActivityClassCommand })
  const config = classConfig({ create: true })
  const prepared = await prepareCommand(
    base, 'POST /api/v1/activities/classes', config,
  )
  const command = prepared.command
  const fact = await loadActivityGroupResourceFact(
    command.db, command.actor, command.body.groupId, command.nowMs, command.body.date,
  )
  if (!authorize(command.actor, 'tus.manage', fact, { nowMs: command.nowMs })) {
    throw new Error('NOT_FOUND')
  }
  if (prepared.replayRow) {
    return openCommandReplay(command.db, command, config, prepared.replayRow)
  }
  const group = await command.db.prepare(
    `SELECT id FROM activity_groups WHERE id=? AND status='active'`,
  ).bind(command.body.groupId).first()
  if (group?.id !== command.body.groupId) throw new Error('NOT_FOUND')
  const used = new Set()
  const activityDataKey = await dataKeyForCreate(command, used)
  const activityClass = captureActivityClass({
    id: generated(command, used, 'acl', 'class'), groupId: command.body.groupId,
    date: command.body.date, time: command.body.time,
    durationMinutes: command.body.durationMinutes, topic: command.body.topic,
    status: command.body.status, version: 1,
    createdAt: command.now, updatedAt: command.now,
  })
  const topicEnvelope = activityClass.topic === null ? null : await encryptActivityField(
    command.keyring, activityDataKey, {
      kind: 'classTopic', id: activityClass.id, value: activityClass.topic,
    },
  )
  const data = Object.freeze({ class: activityClass })
  const responseEnvelope = await sealCommandReplay(
    command, activityDataKey, config, data,
  )
  const auditId = generated(command, used, 'aud', 'audit')
  const statements = [
    command.db.prepare(`INSERT INTO activity_classes
      (id,group_id,occurs_on,wall_time,duration_minutes,topic_envelope,status,version,
       created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)`).bind(
      activityClass.id, activityClass.groupId, activityClass.date, activityClass.time,
      activityClass.durationMinutes, topicEnvelope, activityClass.status,
      command.now, command.now,
    ),
    await groupVersionStatement(command, used, activityDataKey, 'activity_class', {
      schema: 'activity_class.v1', ...activityClass,
    }),
    auditEventStatement(command.db, {
      id: auditId, occurredAt: command.now, actorStaffId: command.actor.id,
      action: config.auditAction, entityType: config.entityType,
      entityId: activityClass.id, result: 'success', correlationId: command.correlationId,
      metadata: { classVersion: activityClass.version }, reasonEnvelope: null,
    }),
    replayStatement(command, config, responseEnvelope),
    mutationGuard(command, config, {
      entityId: activityClass.id, entityVersion: activityClass.version, auditId,
    }),
  ]
  try { await command.db.batch(statements) } catch (error) {
    return recoverCommand(command, config, error)
  }
  return commandResponse(config.status, data)
}

export async function editActivityClass(input) {
  const base = commandInput(input, {
    targetKey: 'classId', capture: captureEditActivityClassCommand,
  })
  const config = classConfig({ create: false, classId: base.classId })
  const prepared = await prepareCommand(
    base, `POST /api/v1/activities/classes/${base.classId}/edits`, config,
  )
  const command = prepared.command
  const current = await command.db.prepare(`SELECT id,group_id,occurs_on,wall_time,
    duration_minutes,topic_envelope,status,version,created_at,updated_at
    FROM activity_classes WHERE id=?`).bind(command.classId).first()
  if (!current || current.id !== command.classId) throw new Error('NOT_FOUND')
  const fact = await loadActivityGroupResourceFact(
    command.db, command.actor, current.group_id, command.nowMs, current.occurs_on,
  )
  if (!authorize(command.actor, 'tus.manage', fact, { nowMs: command.nowMs })) {
    throw new Error('NOT_FOUND')
  }
  if (command.body.date !== current.occurs_on) {
    const targetFact = await loadActivityGroupResourceFact(
      command.db, command.actor, current.group_id, command.nowMs, command.body.date,
    )
    if (!authorize(command.actor, 'tus.manage', targetFact, { nowMs: command.nowMs })) {
      throw new Error('NOT_FOUND')
    }
  }
  if (prepared.replayRow) {
    return openCommandReplay(command.db, command, config, prepared.replayRow)
  }
  if (current.version !== command.body.expectedVersion) {
    throw versionConflict(current.version)
  }
  const used = new Set()
  const activityDataKey = current.topic_envelope === null
    ? await requireActivityDataKey(command.db)
    : await loadActivityDataKey(command.db, current.topic_envelope)
  const activityClass = captureActivityClass({
    id: current.id, groupId: current.group_id, date: command.body.date,
    time: command.body.time, durationMinutes: command.body.durationMinutes,
    topic: command.body.topic, status: command.body.status,
    version: current.version + 1, createdAt: current.created_at, updatedAt: command.now,
  })
  const topicEnvelope = activityClass.topic === null ? null : await encryptActivityField(
    command.keyring, activityDataKey, {
      kind: 'classTopic', id: activityClass.id, value: activityClass.topic,
    },
  )
  const data = Object.freeze({ class: activityClass })
  const responseEnvelope = await sealCommandReplay(
    command, activityDataKey, config, data,
  )
  const auditId = generated(command, used, 'aud', 'audit')
  const statements = [
    command.db.prepare(`UPDATE activity_classes SET occurs_on=?,wall_time=?,
      duration_minutes=?,topic_envelope=?,status=?,version=?,updated_at=?
      WHERE id=? AND version=?`).bind(
      activityClass.date, activityClass.time, activityClass.durationMinutes,
      topicEnvelope, activityClass.status, activityClass.version, command.now,
      activityClass.id, command.body.expectedVersion,
    ),
    await groupVersionStatement(command, used, activityDataKey, 'activity_class', {
      schema: 'activity_class.v1', ...activityClass,
    }),
    auditEventStatement(command.db, {
      id: auditId, occurredAt: command.now, actorStaffId: command.actor.id,
      action: config.auditAction, entityType: config.entityType,
      entityId: activityClass.id, result: 'success', correlationId: command.correlationId,
      metadata: { classVersion: activityClass.version }, reasonEnvelope: null,
    }),
    replayStatement(command, config, responseEnvelope),
    mutationGuard(command, config, {
      entityId: activityClass.id, entityVersion: activityClass.version, auditId,
    }),
  ]
  try { await command.db.batch(statements) } catch (error) {
    return recoverCommand(command, config, error, {
      id: activityClass.id, version: command.body.expectedVersion,
    })
  }
  return commandResponse(config.status, data)
}

const attendanceConfig = (classId, create) => ({
  operation: 'activity.attendance.set',
  replayRecordId: classId,
  replaySchema: 'activity_attendance_set_replay.v1',
  status: create ? 201 : 200,
  table: 'activity_attendance',
  entityType: 'activity_attendance',
  auditAction: 'activity.attendance.set',
  captureData: (value) => singleResponseData(
    value, 'attendance', captureActivityAttendance,
  ),
  accept: (data, command) => data.attendance.classId === command.classId
    && data.attendance.participantId === command.body.participantId
    && data.attendance.status === command.body.status
    && data.attendance.version === command.body.expectedVersion + 1,
})

const recoverAttendance = async (command, config, error) => {
  const replay = await loadCommandReplay(
    command.recoveryDb, command.actor.id, config.operation, command.idempotencyKey,
  )
  if (replay) return openCommandReplay(command.recoveryDb, command, config, replay)
  const current = await command.recoveryDb.prepare(`SELECT version
    FROM activity_attendance WHERE class_id=? AND participant_id=?`).bind(
    command.classId, command.body.participantId,
  ).first()
  if (Number.isSafeInteger(current?.version)
    && current.version !== command.body.expectedVersion) {
    throw versionConflict(current.version)
  }
  if (isActivityConflict(error)) throw new Error('ACTIVITY_CONFLICT')
  throw error
}

export async function setActivityAttendance(input) {
  const base = commandInput(input, {
    targetKey: 'classId', capture: captureSetActivityAttendanceCommand,
  })
  const create = base.body.expectedVersion === 0
  const config = attendanceConfig(base.classId, create)
  const prepared = await prepareCommand(
    base, `POST /api/v1/activities/classes/${base.classId}/attendance`, config,
  )
  const command = prepared.command
  const activityClass = await command.db.prepare(
    `SELECT id,group_id,occurs_on,topic_envelope FROM activity_classes WHERE id=?`,
  ).bind(command.classId).first()
  if (!activityClass || activityClass.id !== command.classId) throw new Error('NOT_FOUND')
  const fact = await loadActivityGroupResourceFact(
    command.db, command.actor, activityClass.group_id, command.nowMs,
    activityClass.occurs_on,
  )
  if (!authorize(command.actor, 'tus.manage', fact, { nowMs: command.nowMs })) {
    throw new Error('NOT_FOUND')
  }
  if (prepared.replayRow) {
    return openCommandReplay(command.db, command, config, prepared.replayRow)
  }
  const current = await command.db.prepare(`SELECT id,class_id,participant_id,status,
    version,created_at,updated_at FROM activity_attendance
    WHERE class_id=? AND participant_id=?`).bind(
    command.classId, command.body.participantId,
  ).first()
  if (create ? current !== null : current === null) {
    if (current && Number.isSafeInteger(current.version)) {
      throw versionConflict(current.version)
    }
    throw new Error('NOT_FOUND')
  }
  if (!create && current.version !== command.body.expectedVersion) {
    throw versionConflict(current.version)
  }
  const used = new Set()
  const activityDataKey = activityClass.topic_envelope === null
    ? await requireActivityDataKey(command.db)
    : await loadActivityDataKey(command.db, activityClass.topic_envelope)
  const attendance = captureActivityAttendance({
    id: create ? generated(command, used, 'aat', 'attendance') : current.id,
    classId: command.classId, participantId: command.body.participantId,
    status: command.body.status, version: command.body.expectedVersion + 1,
    createdAt: create ? command.now : current.created_at, updatedAt: command.now,
  })
  const data = Object.freeze({ attendance })
  const responseEnvelope = await sealCommandReplay(
    command, activityDataKey, config, data,
  )
  const auditId = generated(command, used, 'aud', 'audit')
  const statements = [
    create
      ? command.db.prepare(`INSERT INTO activity_attendance
          (id,class_id,participant_id,status,version,created_at,updated_at)
          VALUES (?,?,?,?,1,?,?)`).bind(
          attendance.id, attendance.classId, attendance.participantId,
          attendance.status, command.now, command.now,
        )
      : command.db.prepare(`UPDATE activity_attendance SET status=?,version=?,updated_at=?
          WHERE id=? AND version=?`).bind(
          attendance.status, attendance.version, command.now,
          attendance.id, command.body.expectedVersion,
        ),
    await groupVersionStatement(command, used, activityDataKey, 'activity_attendance', {
      schema: 'activity_attendance.v1', ...attendance,
    }),
    auditEventStatement(command.db, {
      id: auditId, occurredAt: command.now, actorStaffId: command.actor.id,
      action: config.auditAction, entityType: config.entityType,
      entityId: attendance.id, result: 'success', correlationId: command.correlationId,
      metadata: { attendanceVersion: attendance.version }, reasonEnvelope: null,
    }),
    replayStatement(command, config, responseEnvelope),
    mutationGuard(command, config, {
      entityId: attendance.id, entityVersion: attendance.version, auditId,
    }),
  ]
  try { await command.db.batch(statements) } catch (error) {
    return recoverAttendance(command, config, error)
  }
  return commandResponse(config.status, data)
}
