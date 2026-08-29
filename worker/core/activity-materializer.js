import {
  ACTIVITY_SCOPE,
  activityIdentityLookupCandidates,
  decryptActivityIdentity,
  encryptActivityIdentity,
  loadActivityDataKey,
  openActivityPayload,
  sealActivityPayload,
} from './activity-crypto.js'
import { captureActivityProjectionJob } from '../../src/activity-records.js'
import { activityProjectionAuditStatement } from './activity-audit.js'
import {
  loadAuthenticatedWorkbookSpecialistMappings,
  loadWorkbookSourceDataKey,
  openAuthenticatedWorkbookSource,
  resolveAuthenticatedWorkbookSpecialist,
} from './workbook-source-registry.js'
import { getOrCreateDataKey } from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'
import { authorize } from '../identity/policy.js'

export const ACTIVITY_PROJECTION_SLICE_SIZE = 1

const SOURCE_ID = /^wbs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const FINANCE_ID = /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const RESOLUTION_ID = /^wbr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const MONTH = /^(\d{4})-(\d{2})$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const encoder = new TextEncoder()

const fail = (code = 'ACTIVITY_PROJECTION_INVALID') => { throw new Error(code) }
const versionConflict = (currentVersion) => {
  const error = new Error('VERSION_CONFLICT')
  Object.defineProperty(error, 'details', {
    enumerable: true,
    value: Object.freeze({ currentVersion }),
  })
  throw error
}

const exact = (value, keys) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) fail()
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
      captured[key] = descriptor.value
    }
    return captured
  } catch (error) {
    if (error?.message === 'ACTIVITY_PROJECTION_INVALID') throw error
    fail()
  }
}

const authorityInvariant = (db, actor) => db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'activity_projection_authority_changed' WHERE NOT EXISTS (
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

const civilMonth = (value) => {
  const match = typeof value === 'string' ? MONTH.exec(value) : null
  return Boolean(match && match[1] !== '0000' && Number(match[2]) >= 1
    && Number(match[2]) <= 12)
}

const civilDay = (value) => {
  const match = typeof value === 'string' ? DAY.exec(value) : null
  if (!match || match[1] === '0000') return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const maximum = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= maximum[month - 1]
}

const text = (value, maximum) => {
  if (typeof value !== 'string' || value !== value.trim() || value !== value.normalize('NFC')
    || !value.length || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return false
  const bytes = encoder.encode(value)
  const valid = bytes.byteLength <= maximum
  bytes.fill(0)
  return valid
}

export function captureActivityProjectionItem(value) {
  const result = exact(value, [
    'sourceRecordId', 'financeEntryId', 'recordType', 'accountingMonth', 'occurredOn',
    'participantIdentity', 'groupLabel', 'lessonCount', 'specialistId', 'resolutionId',
  ])
  if (typeof result.sourceRecordId !== 'string' || !SOURCE_ID.test(result.sourceRecordId)
    || typeof result.financeEntryId !== 'string' || !FINANCE_ID.test(result.financeEntryId)
    || !['english', 'tus'].includes(result.recordType)
    || !civilMonth(result.accountingMonth)
    || !text(result.participantIdentity, 160)
    || typeof result.specialistId !== 'string' || !SPECIALIST_ID.test(result.specialistId)
    || typeof result.resolutionId !== 'string' || !RESOLUTION_ID.test(result.resolutionId)) fail()
  const tus = result.recordType === 'tus'
  const tusPeriod = result.occurredOn === null
    || (civilDay(result.occurredOn)
      && result.occurredOn.slice(0, 7) === result.accountingMonth)
  if ((tus && (!tusPeriod || !text(result.groupLabel, 160) || result.lessonCount !== null))
    || (!tus && (result.occurredOn !== null || result.groupLabel !== null
      || !Number.isSafeInteger(result.lessonCount)
      || result.lessonCount < 0 || result.lessonCount > 1000))) fail()
  return Object.freeze(result)
}

export function summarizeActivityProjection(values) {
  if (!Array.isArray(values) || values.length > 10_000) fail()
  const sources = new Set()
  const finances = new Set()
  let tusRecords = 0
  let tusDayRecords = 0
  let englishRecords = 0
  let explicitZeroLessonRecords = 0
  for (const value of values) {
    const item = captureActivityProjectionItem(value)
    if (sources.has(item.sourceRecordId) || finances.has(item.financeEntryId)) {
      fail('ACTIVITY_PROJECTION_CONFLICT')
    }
    sources.add(item.sourceRecordId)
    finances.add(item.financeEntryId)
    if (item.recordType === 'tus') {
      tusRecords += 1
      if (item.occurredOn !== null) tusDayRecords += 1
    } else {
      englishRecords += 1
      if (item.lessonCount === 0) explicitZeroLessonRecords += 1
    }
  }
  return Object.freeze({
    totalRecords: values.length,
    tusRecords,
    tusDayRecords,
    tusMonthRecords: tusRecords - tusDayRecords,
    englishRecords,
    englishMonthRecords: englishRecords,
    explicitZeroLessonRecords,
    classRecords: 0,
    attendanceRecords: 0,
    paymentRecords: 0,
  })
}

const IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const PARTICIPANT_ID = /^acp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const GROUP_ID = /^agr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const MEMBERSHIP_ID = /^amb_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CHARGE_ID = /^ach_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SOURCE_LINK_ID = /^asl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const VERSION_ID = /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const JOB_ID = /^apj_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const AUDIT_ID = /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CENTRE_RESOURCE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })

const made = (factory, prefix, pattern) => {
  let id
  try { id = `${prefix}_${factory(prefix)}` } catch { fail() }
  if (!pattern.test(id)) fail()
  return id
}

const instantAt = (nowMs) => {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail()
  let value
  try { value = new Date(nowMs).toISOString() } catch { fail() }
  if (Date.parse(value) !== nowMs) fail()
  return value
}

const commandInput = (input) => {
  const command = exact(input, [
    'db', 'recoveryDb', 'keyring', 'config', 'centreId', 'importId', 'actor', 'nowMs',
    'idFactory', 'sourceRecordIds',
  ])
  if (!command.db?.prepare || !command.db?.batch || !command.recoveryDb?.prepare
    || !command.recoveryDb?.batch || !command.keyring
    || command.centreId !== 'centre_1'
    || typeof command.importId !== 'string' || !IMPORT_ID.test(command.importId)
    || !authorize(command.actor, 'finance.import', CENTRE_RESOURCE, {
      nowMs: command.nowMs,
    })
    || typeof command.actor.id !== 'string' || !STAFF_ID.test(command.actor.id)
    || command.config?.appEnv !== 'staging' || command.config?.dataMode !== 'fictional'
    || typeof command.idFactory !== 'function'
    || !Array.isArray(command.sourceRecordIds)
    || command.sourceRecordIds.length < 1
    || command.sourceRecordIds.length > ACTIVITY_PROJECTION_SLICE_SIZE
    || new Set(command.sourceRecordIds).size !== command.sourceRecordIds.length
    || command.sourceRecordIds.some((id) => typeof id !== 'string' || !SOURCE_ID.test(id))) {
    fail()
  }
  command.now = instantAt(command.nowMs)
  return Object.freeze(command)
}

const loadAuthorityRow = (db, importId, sourceRecordId, actorId) => db.prepare(
  `SELECT source.id AS source_record_id,source.source_key,source.sheet_name,
          source.row_number,source.record_type,source.accounting_month,
          source.occurred_on,source.period_precision,source.period_month,
          source.amount_grosze,source.record_digest,source.record_digest_hmac_version,
          source.specialist_source_digest,source.specialist_source_hmac_version,
          source.source_payload_envelope,
          finance.id AS finance_entry_id,finance.kind AS finance_kind,
          finance.record_type AS finance_record_type,
          finance.accounting_month AS finance_accounting_month,
          finance.occurred_on AS finance_occurred_on,
          finance.amount_grosze AS finance_amount_grosze,
          finance.specialist_id AS finance_specialist_id,
          void.id AS finance_void_id,
          resolution.id AS resolution_id,
          resolution.specialist_id AS resolution_specialist_id
   FROM workbook_source_records AS source
   JOIN workbook_imports AS import ON import.id=source.import_id
     AND import.status='complete' AND import.created_by_staff_id=?
   JOIN workbook_import_plans AS plan ON plan.import_id=import.id
     AND plan.workbook_kind='legacy'
   JOIN workbook_materialization_jobs AS finance_job ON finance_job.import_id=import.id
     AND finance_job.phase='complete' AND finance_job.status='complete'
   JOIN finance_source_links AS finance_link ON finance_link.source_record_id=source.id
   JOIN finance_entries AS finance ON finance.id=finance_link.finance_entry_id
   LEFT JOIN finance_entry_voids AS void ON void.finance_entry_id=finance.id
   LEFT JOIN workbook_resolutions AS resolution ON resolution.import_id=source.import_id
     AND resolution.kind='specialist_mapping'
     AND resolution.source_value_digest=source.specialist_source_digest
     AND resolution.source_value_hmac_version=source.specialist_source_hmac_version
   WHERE source.import_id=? AND source.id=? AND source.disposition='accepted'
     AND source.record_type IN ('tus','english')`,
).bind(actorId, importId, sourceRecordId).first()

const authorityItem = async (command, mappings, sourceRecordId) => {
  const row = await loadAuthorityRow(
    command.db, command.importId, sourceRecordId, command.actor.id,
  )
  if (!row) fail('ACTIVITY_PROJECTION_NOT_READY')
  const payload = await openAuthenticatedWorkbookSource({
    keyring: command.keyring, dataKey: command.sourceDataKey, row,
    config: command.config, centreId: command.centreId,
  })
  const specialistId = await resolveAuthenticatedWorkbookSpecialist({
    keyring: command.keyring, config: command.config, centreId: command.centreId,
    mappings, row, payload,
  })
  const value = payload.normalized
  const exactPeriod = (value.recordType === 'english'
      && value.periodPrecision === 'month' && value.occurredOn === null
      && value.periodMonth === value.accountingMonth)
    || (value.recordType === 'tus' && (
      (value.periodPrecision === 'day' && value.occurredOn !== null
        && value.periodMonth === value.accountingMonth
        && value.occurredOn.slice(0, 7) === value.accountingMonth)
      || (value.periodPrecision === 'month' && value.occurredOn === null
        && value.periodMonth === value.accountingMonth)))
  if (!exactPeriod || row.finance_void_id !== null || row.finance_kind !== 'income'
    || row.finance_record_type !== value.recordType
    || row.finance_accounting_month !== value.accountingMonth
    || row.finance_occurred_on !== value.occurredOn
    || row.finance_amount_grosze !== value.amountGrosze
    || row.finance_specialist_id !== specialistId
    || row.resolution_specialist_id !== specialistId
    || typeof row.resolution_id !== 'string' || !RESOLUTION_ID.test(row.resolution_id)
    || row.accounting_month !== value.accountingMonth
    || row.amount_grosze !== value.amountGrosze) {
    fail('ACTIVITY_PROJECTION_AUTHORITY_MISMATCH')
  }
  return captureActivityProjectionItem({
    sourceRecordId: row.source_record_id,
    financeEntryId: row.finance_entry_id,
    recordType: value.recordType,
    accountingMonth: value.accountingMonth,
    occurredOn: value.occurredOn,
    participantIdentity: value.counterparty,
    groupLabel: value.recordType === 'tus' ? value.sourceLabel : null,
    lessonCount: value.recordType === 'english' ? value.lessonCount : null,
    specialistId,
    resolutionId: row.resolution_id,
  })
}

const loadProjectedCharge = (db, sourceRecordId) => db.prepare(
  `SELECT charge.id,charge.participant_id,charge.program_id,charge.group_id,
          charge.membership_id,charge.period_precision,charge.lesson_count,charge.status,
          charge.finance_entry_id,charge.responsible_specialist_id,
          charge.accounting_month,charge.occurred_on,program.code AS record_type,
          participant.identity_envelope AS participant_identity_envelope,
          activity_group.label_envelope AS group_label_envelope,
          membership.membership_kind,membership.period_precision AS membership_precision,
          membership.observed_on AS membership_observed_on,
          membership.observed_month AS membership_observed_month,
          participant_link.entity_id AS linked_participant_id,
          group_link.entity_id AS linked_group_id,
          membership_link.entity_id AS linked_membership_id
   FROM activity_source_links AS source_link
   JOIN activity_charges AS charge ON charge.id=source_link.entity_id
   JOIN activity_programs AS program ON program.id=charge.program_id
   JOIN activity_participants AS participant ON participant.id=charge.participant_id
   LEFT JOIN activity_groups AS activity_group ON activity_group.id=charge.group_id
   LEFT JOIN activity_memberships AS membership ON membership.id=charge.membership_id
   LEFT JOIN activity_source_links AS participant_link
     ON participant_link.source_record_id=source_link.source_record_id
    AND participant_link.relation='participant'
   LEFT JOIN activity_source_links AS group_link
     ON group_link.source_record_id=source_link.source_record_id
    AND group_link.relation='group'
   LEFT JOIN activity_source_links AS membership_link
     ON membership_link.source_record_id=source_link.source_record_id
    AND membership_link.relation='membership_observation'
   WHERE source_link.source_record_id=? AND source_link.relation='charge'`,
).bind(sourceRecordId).first()

const replayMatches = async (command, row, item) => {
  const precision = item.occurredOn === null ? 'month' : 'day'
  const scalarMatch = row && row.finance_entry_id === item.financeEntryId
    && row.responsible_specialist_id === item.specialistId
    && row.accounting_month === item.accountingMonth
    && row.occurred_on === item.occurredOn
    && row.record_type === item.recordType
    && row.program_id === `apg_${item.recordType}`
    && row.period_precision === precision
    && row.lesson_count === item.lessonCount
    && row.status === 'active'
    && row.linked_participant_id === row.participant_id
  if (!scalarMatch) return false
  const participant = await decryptActivityIdentity(
    command.keyring, command.activityDataKey, {
      kind: 'participant', id: row.participant_id, programId: row.program_id,
      envelope: row.participant_identity_envelope,
    },
  )
  if (canonicalIdentity(participant) !== canonicalIdentity(item.participantIdentity)) {
    return false
  }
  if (item.recordType === 'english') {
    return row.group_id === null && row.membership_id === null
      && row.linked_group_id === null && row.linked_membership_id === null
  }
  if (row.group_id === null || row.membership_id === null
    || row.linked_group_id !== row.group_id
    || row.linked_membership_id !== row.membership_id
    || row.membership_kind !== 'observation'
    || row.membership_precision !== precision
    || row.membership_observed_on !== item.occurredOn
    || row.membership_observed_month !== item.accountingMonth) return false
  const group = await decryptActivityIdentity(command.keyring, command.activityDataKey, {
    kind: 'group', id: row.group_id, programId: row.program_id,
    envelope: row.group_label_envelope,
  })
  return canonicalIdentity(group) === canonicalIdentity(item.groupLabel)
}

const candidateWhere = (candidates) => candidates.map(
  () => '(alias.hmac_version=? AND alias.lookup_digest=?)',
).join(' OR ')
const candidateBindings = (candidates) => candidates.flatMap(
  ({ version, digest }) => [version, digest],
)

const canonicalIdentity = (value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ')
  .toLocaleLowerCase('pl-PL')

const missingLookupsFor = async (db, table, foreignKey, id, candidates) => {
  const rows = (await db.prepare(
    `SELECT hmac_version,lookup_digest FROM ${table} WHERE ${foreignKey}=? LIMIT 101`,
  ).bind(id).all()).results
  if (!Array.isArray(rows) || rows.length > 100
    || rows.some((row) => !Number.isSafeInteger(row?.hmac_version)
      || typeof row.lookup_digest !== 'string')) fail()
  const existing = new Set(rows.map(
    ({ hmac_version: version, lookup_digest: digest }) => `${version}:${digest}`,
  ))
  return candidates.filter(
    ({ version, digest }) => !existing.has(`${version}:${digest}`),
  )
}

const loadParticipant = async (command, item, candidates) => {
  let rows = (await command.db.prepare(
    `SELECT DISTINCT participant.id,participant.identity_envelope
     FROM activity_participant_lookup_aliases AS alias
     JOIN activity_participants AS participant ON participant.id=alias.participant_id
     WHERE alias.program_id=? AND (${candidateWhere(candidates)}) LIMIT 2`,
  ).bind(
    `apg_${item.recordType}`, ...candidateBindings(candidates),
  ).all()).results
  if (!Array.isArray(rows) || rows.length > 1) fail('ACTIVITY_PROJECTION_CONFLICT')
  if (!rows.length) {
    const fallback = (await command.db.prepare(
      `SELECT id,identity_envelope FROM activity_participants
       WHERE program_id=? ORDER BY id LIMIT 1001`,
    ).bind(`apg_${item.recordType}`).all()).results
    if (!Array.isArray(fallback) || fallback.length > 1000) {
      fail('ACTIVITY_RESULT_LIMIT')
    }
    const matches = []
    for (const row of fallback) {
      const name = await decryptActivityIdentity(
        command.keyring, command.activityDataKey, {
          kind: 'participant', id: row.id, programId: `apg_${item.recordType}`,
          envelope: row.identity_envelope,
        },
      )
      if (canonicalIdentity(name) === canonicalIdentity(item.participantIdentity)) {
        matches.push(row)
      }
    }
    if (matches.length > 1) fail('ACTIVITY_PROJECTION_CONFLICT')
    rows = matches
  }
  if (!rows.length) return null
  const name = await decryptActivityIdentity(command.keyring, command.activityDataKey, {
    kind: 'participant', id: rows[0].id, programId: `apg_${item.recordType}`,
    envelope: rows[0].identity_envelope,
  })
  if (canonicalIdentity(name) !== canonicalIdentity(item.participantIdentity)) {
    fail('ACTIVITY_PROJECTION_CONFLICT')
  }
  return Object.freeze({
    ...rows[0],
    missingLookups: await missingLookupsFor(
      command.db, 'activity_participant_lookup_aliases', 'participant_id',
      rows[0].id, candidates,
    ),
  })
}

const loadGroup = async (command, item, candidates) => {
  let rows = (await command.db.prepare(
    `SELECT DISTINCT activity_group.id,activity_group.label_envelope
     FROM activity_group_lookup_aliases AS alias
     JOIN activity_groups AS activity_group ON activity_group.id=alias.group_id
     WHERE alias.program_id='apg_tus' AND (${candidateWhere(candidates)}) LIMIT 2`,
  ).bind(...candidateBindings(candidates)).all()).results
  if (!Array.isArray(rows) || rows.length > 1) fail('ACTIVITY_PROJECTION_CONFLICT')
  if (!rows.length) {
    const fallback = (await command.db.prepare(
      `SELECT id,label_envelope FROM activity_groups
       WHERE program_id='apg_tus' ORDER BY id LIMIT 101`,
    ).all()).results
    if (!Array.isArray(fallback) || fallback.length > 100) fail('ACTIVITY_RESULT_LIMIT')
    const matches = []
    for (const row of fallback) {
      const label = await decryptActivityIdentity(
        command.keyring, command.activityDataKey, {
          kind: 'group', id: row.id, programId: 'apg_tus',
          envelope: row.label_envelope,
        },
      )
      if (canonicalIdentity(label) === canonicalIdentity(item.groupLabel)) matches.push(row)
    }
    if (matches.length > 1) fail('ACTIVITY_PROJECTION_CONFLICT')
    rows = matches
  }
  if (!rows.length) return null
  const label = await decryptActivityIdentity(command.keyring, command.activityDataKey, {
    kind: 'group', id: rows[0].id, programId: 'apg_tus',
    envelope: rows[0].label_envelope,
  })
  if (canonicalIdentity(label) !== canonicalIdentity(item.groupLabel)) {
    fail('ACTIVITY_PROJECTION_CONFLICT')
  }
  return Object.freeze({
    ...rows[0],
    missingLookups: await missingLookupsFor(
      command.db, 'activity_group_lookup_aliases', 'group_id', rows[0].id, candidates,
    ),
  })
}

const loadMembership = (command, item, participantId, groupId) => command.db.prepare(
  `SELECT id FROM activity_memberships
   WHERE participant_id=? AND group_id=? AND membership_kind='observation'
     AND period_precision=? AND observed_on IS ? AND observed_month=?`,
).bind(
  participantId, groupId, item.occurredOn === null ? 'month' : 'day',
  item.occurredOn, item.accountingMonth,
).first()

const versionStatement = async (command, { id, type, entity }) => command.db.prepare(
  `INSERT INTO record_versions
   (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
    changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`,
).bind(
  made(command.idFactory, 'ver', VERSION_ID), type, id, 1,
  await sealActivityPayload(command.keyring, command.activityDataKey, {
    recordId: id, field: 'record_version', value: entity,
  }),
  command.actor.id, command.now, `activity_projection_${command.importId}`,
)

const sourceLinkStatement = (command, item, relation, entityId) => command.db.prepare(
  `INSERT INTO activity_source_links
   (id,source_record_id,relation,entity_id,created_by_staff_id,created_at)
   VALUES (?,?,?,?,?,?)`,
).bind(
  made(command.idFactory, 'asl', SOURCE_LINK_ID), item.sourceRecordId,
  relation, entityId, command.actor.id, command.now,
)

const prepareMaterializeOne = async (command, item) => {
  const existing = await loadProjectedCharge(command.db, item.sourceRecordId)
  if (existing) {
    if (!(await replayMatches(command, existing, item))) fail('ACTIVITY_PROJECTION_CONFLICT')
    return Object.freeze({ kind: 'replayed', statements: Object.freeze([]) })
  }
  const programId = `apg_${item.recordType}`
  const participantLookups = await activityIdentityLookupCandidates(command.keyring, {
    kind: 'participant', programId, value: item.participantIdentity,
  })
  let participant = await loadParticipant(command, item, participantLookups)
  const statements = []
  if (!participant) {
    const id = made(command.idFactory, 'acp', PARTICIPANT_ID)
    const identityEnvelope = await encryptActivityIdentity(
      command.keyring, command.activityDataKey, {
        kind: 'participant', id, programId, value: item.participantIdentity,
      },
    )
    participant = { id, identity_envelope: identityEnvelope }
    statements.push(command.db.prepare(
      `INSERT INTO activity_participants
       (id,program_id,identity_envelope,client_id,historical_client_id,status,version,
        created_at,updated_at) VALUES (?,?,?,NULL,NULL,'active',1,?,?)`,
    ).bind(id, programId, identityEnvelope, command.now, command.now))
    for (const lookup of participantLookups) statements.push(command.db.prepare(
      `INSERT INTO activity_participant_lookup_aliases
       (participant_id,program_id,domain,hmac_version,lookup_digest,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(id, programId, lookup.domain, lookup.version, lookup.digest, command.now))
    statements.push(await versionStatement(command, {
      id, type: 'activity_participant',
      entity: {
        schema: 'activity_participant.v1', id, programId, name: item.participantIdentity,
        clientId: null, historicalClientId: null, status: 'active', version: 1,
        createdAt: command.now, updatedAt: command.now,
      },
    }))
  } else {
    for (const lookup of participant.missingLookups) statements.push(command.db.prepare(
      `INSERT INTO activity_participant_lookup_aliases
       (participant_id,program_id,domain,hmac_version,lookup_digest,created_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(
      participant.id, programId, lookup.domain, lookup.version, lookup.digest, command.now,
    ))
  }
  statements.push(sourceLinkStatement(
    command, item, 'participant', participant.id,
  ))

  let group = null
  let membership = null
  if (item.recordType === 'tus') {
    const groupLookups = await activityIdentityLookupCandidates(command.keyring, {
      kind: 'group', programId, value: item.groupLabel,
    })
    group = await loadGroup(command, item, groupLookups)
    if (!group) {
      const id = made(command.idFactory, 'agr', GROUP_ID)
      const labelEnvelope = await encryptActivityIdentity(
        command.keyring, command.activityDataKey, {
          kind: 'group', id, programId, value: item.groupLabel,
        },
      )
      group = { id, label_envelope: labelEnvelope }
      statements.push(command.db.prepare(
        `INSERT INTO activity_groups
         (id,program_id,label_envelope,details_envelope,status,version,created_at,updated_at)
         VALUES (?,'apg_tus',?,NULL,'active',1,?,?)`,
      ).bind(id, labelEnvelope, command.now, command.now))
      for (const lookup of groupLookups) statements.push(command.db.prepare(
        `INSERT INTO activity_group_lookup_aliases
         (group_id,program_id,domain,hmac_version,lookup_digest,created_at)
         VALUES (?,'apg_tus',?,?,?,?)`,
      ).bind(id, lookup.domain, lookup.version, lookup.digest, command.now))
      statements.push(await versionStatement(command, {
        id, type: 'activity_group',
        entity: {
          schema: 'activity_group.v1', id, programId, label: item.groupLabel,
          details: null, status: 'active', version: 1,
          createdAt: command.now, updatedAt: command.now,
        },
      }))
    } else {
      for (const lookup of group.missingLookups) statements.push(command.db.prepare(
        `INSERT INTO activity_group_lookup_aliases
         (group_id,program_id,domain,hmac_version,lookup_digest,created_at)
         VALUES (?,'apg_tus',?,?,?,?)`,
      ).bind(group.id, lookup.domain, lookup.version, lookup.digest, command.now))
    }
    statements.push(sourceLinkStatement(command, item, 'group', group.id))
    membership = await loadMembership(command, item, participant.id, group.id)
    if (!membership) {
      const id = made(command.idFactory, 'amb', MEMBERSHIP_ID)
      const precision = item.occurredOn === null ? 'month' : 'day'
      membership = { id }
      statements.push(command.db.prepare(
        `INSERT INTO activity_memberships
         (id,participant_id,program_id,group_id,membership_kind,period_precision,
          observed_on,observed_month,starts_on,ends_on,status,version,created_at,updated_at)
         VALUES (?,?,? ,?,'observation',?,?,?,NULL,NULL,'active',1,?,?)`,
      ).bind(
        id, participant.id, programId, group.id, precision, item.occurredOn,
        item.accountingMonth, command.now, command.now,
      ))
      statements.push(await versionStatement(command, {
        id, type: 'activity_membership',
        entity: {
          schema: 'activity_membership.v1', id, participantId: participant.id,
          programId, groupId: group.id, membershipKind: 'observation',
          period: {
            precision, day: item.occurredOn, month: item.accountingMonth,
          },
          startsOn: null, endsOn: null, status: 'active', version: 1,
          createdAt: command.now, updatedAt: command.now,
        },
      }))
    }
    statements.push(sourceLinkStatement(
      command, item, 'membership_observation', membership.id,
    ))
  }

  const chargeId = made(command.idFactory, 'ach', CHARGE_ID)
  const precision = item.occurredOn === null ? 'month' : 'day'
  statements.push(command.db.prepare(
    `INSERT INTO activity_charges
     (id,participant_id,program_id,group_id,membership_id,period_precision,
      occurred_on,accounting_month,lesson_count,responsible_specialist_id,
      finance_entry_id,status,version,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',1,?,?)`,
  ).bind(
    chargeId, participant.id, programId, group?.id ?? null, membership?.id ?? null,
    precision, item.occurredOn, item.accountingMonth, item.lessonCount,
    item.specialistId, item.financeEntryId, command.now, command.now,
  ))
  statements.push(await versionStatement(command, {
    id: chargeId, type: 'activity_charge',
    entity: {
      schema: 'activity_charge.v1', id: chargeId, participantId: participant.id,
      programId, groupId: group?.id ?? null, membershipId: membership?.id ?? null,
      period: { precision, day: item.occurredOn, month: item.accountingMonth },
      lessonCount: item.lessonCount, responsibleSpecialistId: item.specialistId,
      financeEntryId: item.financeEntryId, status: 'active', version: 1,
      createdAt: command.now, updatedAt: command.now,
    },
  }))
  statements.push(sourceLinkStatement(command, item, 'charge', chargeId))
  return Object.freeze({ kind: 'projected', statements: Object.freeze(statements) })
}

const prepareActivitySlice = async (captured) => {
  const state = await captured.db.prepare(
    `SELECT plan.plan_envelope
     FROM workbook_imports AS import
     JOIN workbook_import_plans AS plan ON plan.import_id=import.id
       AND plan.workbook_kind='legacy'
     JOIN workbook_materialization_jobs AS finance ON finance.import_id=import.id
       AND finance.phase='complete' AND finance.status='complete'
     WHERE import.id=? AND import.status='complete' AND import.created_by_staff_id=?`,
  ).bind(captured.importId, captured.actor.id).first()
  if (!state) fail('ACTIVITY_PROJECTION_NOT_READY')
  const sourceDataKey = await loadWorkbookSourceDataKey(
    captured.db, state.plan_envelope,
  )
  const activityDataKey = await getOrCreateDataKey(
    captured.db, captured.keyring, ACTIVITY_SCOPE, {
      id: made(captured.idFactory, 'key', /^key_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
      createdAt: captured.now,
    },
  )
  const command = Object.freeze({ ...captured, sourceDataKey, activityDataKey })
  const mappings = await loadAuthenticatedWorkbookSpecialistMappings({
    db: command.db, keyring: command.keyring, dataKey: command.sourceDataKey,
    importId: command.importId, config: command.config, centreId: command.centreId,
  })
  const items = []
  const preparedRecords = []
  for (const sourceRecordId of command.sourceRecordIds) {
    const item = await authorityItem(command, mappings, sourceRecordId)
    items.push(item)
    preparedRecords.push(await prepareMaterializeOne(command, item))
  }
  return Object.freeze({
    command,
    items: Object.freeze(items),
    preparedRecords: Object.freeze(preparedRecords),
    statements: Object.freeze(preparedRecords.flatMap(({ statements }) => statements)),
  })
}

const sliceResult = (prepared, { collisionReplay = false } = {}) => {
  const projectedRecords = collisionReplay ? 0 : prepared.preparedRecords.filter(
    ({ kind }) => kind === 'projected',
  ).length
  return Object.freeze({
    processedRecords: prepared.items.length,
    projectedRecords,
    replayedRecords: prepared.items.length - projectedRecords,
    summary: summarizeActivityProjection(prepared.items),
  })
}

const authenticatePreparedReplay = async (prepared) => {
  for (const item of prepared.items) {
    const winner = await loadProjectedCharge(
      prepared.command.recoveryDb, item.sourceRecordId,
    )
    if (!(await replayMatches(prepared.command, winner, item))) return false
  }
  return true
}

export async function materializeActivitySlice(input) {
  const prepared = await prepareActivitySlice(commandInput(input))
  if (!prepared.statements.length) return sliceResult(prepared)
  try {
    await prepared.command.db.batch([
      ...prepared.statements,
      authorityInvariant(prepared.command.db, prepared.command.actor),
    ])
    return sliceResult(prepared)
  } catch (error) {
    if (await authenticatePreparedReplay(prepared)) {
      return sliceResult(prepared, { collisionReplay: true })
    }
    throw error
  }
}

export async function activityProjectionSourceReconciliation(input) {
  const value = exact(input, ['db', 'importId'])
  if (!value.db?.prepare || typeof value.importId !== 'string'
    || !IMPORT_ID.test(value.importId)) fail()
  const row = await value.db.prepare(
    `SELECT count(*) AS total_records,
            coalesce(sum(record_type='tus'),0) AS tus_records,
            coalesce(sum(record_type='tus' AND period_precision='day'),0)
              AS tus_day_records,
            coalesce(sum(record_type='tus' AND period_precision='month'),0)
              AS tus_month_records,
            coalesce(sum(record_type='english'),0) AS english_records,
            coalesce(sum(record_type='english' AND period_precision='month'),0)
              AS english_month_records,
            coalesce(sum(
              (record_type='tus' AND NOT (
                (period_precision='day' AND occurred_on IS NOT NULL
                  AND period_month=substr(occurred_on,1,7)
                  AND accounting_month=period_month)
                OR (period_precision='month' AND occurred_on IS NULL
                  AND period_month=accounting_month)))
              OR (record_type='english' AND NOT (
                period_precision='month' AND occurred_on IS NULL
                AND period_month=accounting_month))
            ),0) AS invalid_period_records
     FROM workbook_source_records
     WHERE import_id=? AND disposition='accepted'
       AND record_type IN ('tus','english')`,
  ).bind(value.importId).first()
  const result = Object.freeze({
    totalRecords: row?.total_records,
    tusRecords: row?.tus_records,
    tusDayRecords: row?.tus_day_records,
    tusMonthRecords: row?.tus_month_records,
    englishRecords: row?.english_records,
    englishMonthRecords: row?.english_month_records,
    invalidPeriodRecords: row?.invalid_period_records,
  })
  if (Object.values(result).some((count) => !Number.isSafeInteger(count)
      || count < 0 || count > 10_000)
    || result.tusDayRecords + result.tusMonthRecords !== result.tusRecords
    || result.englishMonthRecords !== result.englishRecords) fail()
  return result
}

export async function loadActivityProjectionCursorSlice(input) {
  const value = exact(input, ['db', 'importId', 'afterSourceRecordId'])
  if (!value.db?.prepare || typeof value.importId !== 'string'
    || !IMPORT_ID.test(value.importId)
    || !(value.afterSourceRecordId === null
      || (typeof value.afterSourceRecordId === 'string'
        && SOURCE_ID.test(value.afterSourceRecordId)))) fail()
  if (value.afterSourceRecordId !== null) {
    const cursor = await value.db.prepare(
      `SELECT id FROM workbook_source_records
       WHERE id=? AND import_id=? AND disposition='accepted'
         AND record_type IN ('tus','english')`,
    ).bind(value.afterSourceRecordId, value.importId).first()
    if (!cursor) fail('ACTIVITY_PROJECTION_CURSOR_INVALID')
  }
  const rows = (await value.db.prepare(
    `SELECT id FROM workbook_source_records
     WHERE import_id=? AND disposition='accepted'
       AND record_type IN ('tus','english') AND id>?
     ORDER BY id LIMIT ?`,
  ).bind(
    value.importId, value.afterSourceRecordId ?? '', ACTIVITY_PROJECTION_SLICE_SIZE + 1,
  ).all()).results
  if (!Array.isArray(rows) || rows.length > ACTIVITY_PROJECTION_SLICE_SIZE + 1
    || rows.some((row) => typeof row?.id !== 'string' || !SOURCE_ID.test(row.id))) fail()
  const selected = rows.slice(0, ACTIVITY_PROJECTION_SLICE_SIZE).map(({ id }) => id)
  return Object.freeze({
    sourceRecordIds: Object.freeze(selected),
    afterSourceRecordId: selected.at(-1) ?? value.afterSourceRecordId,
    done: rows.length <= ACTIVITY_PROJECTION_SLICE_SIZE,
  })
}

const PROJECTION_OPERATION = 'activity.projection.continue'
const PROJECTION_REPLAY_SCHEMA = 'activity_projection_replay.v2'
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const loadProjectionState = async (db, actorId, importId) => {
  const row = await db.prepare(
    `SELECT import.id AS import_id,import.status AS import_status,
            import.created_by_staff_id,import.correlation_id,
            plan.workbook_kind,plan.plan_envelope,
            finance.status AS finance_status,finance.phase AS finance_phase,
            job.id AS job_id,job.status AS job_status,
            job.after_source_record_id,job.total_records,job.processed_records,
            job.projected_records,job.version AS job_version,
            job.updated_at AS job_updated_at,job.completed_at AS job_completed_at
     FROM workbook_imports AS import
     JOIN workbook_import_plans AS plan ON plan.import_id=import.id
     JOIN workbook_materialization_jobs AS finance ON finance.import_id=import.id
     LEFT JOIN activity_projection_jobs AS job ON job.import_id=import.id
     WHERE import.id=? AND import.created_by_staff_id=?`,
  ).bind(importId, actorId).first()
  if (!row || row.import_status !== 'complete' || row.workbook_kind !== 'legacy'
    || row.finance_status !== 'complete' || row.finance_phase !== 'complete') {
    fail('NOT_FOUND')
  }
  if (typeof row.correlation_id !== 'string' || !CORRELATION_ID.test(row.correlation_id)) {
    fail()
  }
  return row
}

const projectionDto = (row) => row.job_id === null ? null : captureActivityProjectionJob({
  id: row.job_id,
  importId: row.import_id,
  status: row.job_status,
  afterSourceRecordId: row.after_source_record_id,
  totalRecords: row.total_records,
  processedRecords: row.processed_records,
  projectedRecords: row.projected_records,
  version: row.job_version,
  updatedAt: row.job_updated_at,
  completedAt: row.job_completed_at,
})

const projectionResponse = (job, status = 200) => Object.freeze({
  status,
  body: Object.freeze({
    data: Object.freeze({ job }),
  }),
})

const continuationCommand = (input) => {
  const command = exact(input, [
    'db', 'recoveryDb', 'actor', 'keyring', 'config', 'centreId', 'importId',
    'expectedVersion', 'idempotencyKey', 'idFactory', 'nowMs',
  ])
  if (!command.db?.prepare || !command.db?.batch || !command.recoveryDb?.prepare
    || !command.recoveryDb?.batch
    || !authorize(command.actor, 'finance.import', CENTRE_RESOURCE, {
      nowMs: command.nowMs,
    })
    || typeof command.actor.id !== 'string' || !STAFF_ID.test(command.actor.id)
    || !command.keyring || command.config?.appEnv !== 'staging'
    || command.config?.dataMode !== 'fictional' || command.centreId !== 'centre_1'
    || typeof command.importId !== 'string' || !IMPORT_ID.test(command.importId)
    || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0
    || typeof command.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey)
    || typeof command.idFactory !== 'function') fail()
  command.now = instantAt(command.nowMs)
  return Object.freeze(command)
}

const sha256 = async (value) => {
  let bytes
  let digest
  try {
    bytes = encoder.encode(value)
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return encodeBase64Url(digest)
  } finally {
    bytes?.fill(0)
    digest?.fill(0)
  }
}

const continuationHash = (command, state) => sha256(JSON.stringify([
  1, PROJECTION_OPERATION, command.importId, command.expectedVersion,
  state.plan_envelope,
]))

const loadProjectionReplay = (db, command) => db.prepare(
  `SELECT request_hash,response_envelope
   FROM activity_request_replays
   WHERE actor_staff_id=? AND operation=? AND idempotency_key=?`,
).bind(command.actor.id, PROJECTION_OPERATION, command.idempotencyKey).first()

const projectionReplayStatement = (command, requestHash, responseEnvelope) => (
  command.db.prepare(`INSERT INTO activity_request_replays
    (actor_staff_id,operation,idempotency_key,request_hash,response_envelope,created_at)
    VALUES (?,?,?,?,?,?)`).bind(
    command.actor.id, PROJECTION_OPERATION, command.idempotencyKey,
    requestHash, responseEnvelope, command.now,
  )
)

const openProjectionReplay = async (db, command, state, row) => {
  const dataKey = await loadActivityDataKey(db, row.response_envelope)
  const payload = await openActivityPayload(command.keyring, dataKey, {
    recordId: state.job_id, field: 'request_replay', envelope: row.response_envelope,
  })
  const replay = exact(payload, ['schema', 'status', 'job'])
  if (replay.schema !== PROJECTION_REPLAY_SCHEMA) fail('CRYPTO_FAILURE')
  let job
  try { job = captureActivityProjectionJob(replay.job) } catch {
    fail('CRYPTO_FAILURE')
  }
  if (![200, 201].includes(replay.status)
    || (replay.status === 201 && (job.status !== 'ready' || job.version !== 1))
    || job.id !== state.job_id || job.importId !== command.importId) {
    fail('CRYPTO_FAILURE')
  }
  return projectionResponse(job, replay.status)
}

const sealProjectionReplay = (command, dataKey, job, status) => sealActivityPayload(
  command.keyring, dataKey, {
    recordId: job.id, field: 'request_replay',
    value: { schema: PROJECTION_REPLAY_SCHEMA, status, job },
  },
)

const projectionGuardStatement = (command, {
  projection, auditId, requestHash, sourceRecordId,
}) => command.db.prepare(
  `INSERT INTO core_directory_invariant_failures (failure_kind)
   SELECT 'activity_projection_uow' WHERE NOT EXISTS (
     SELECT 1 FROM activity_projection_jobs AS job
     JOIN audit_events AS audit ON audit.id=?
       AND audit.action='activity.projection.advanced'
       AND audit.entity_type='activity_projection_job' AND audit.entity_id=job.id
       AND audit.actor_staff_id=job.created_by_staff_id
       AND audit.correlation_id=job.correlation_id
       AND json_extract(audit.metadata_json,'$.jobVersion')=job.version
       AND json_extract(audit.metadata_json,'$.processedCount')=job.processed_records
       AND json_extract(audit.metadata_json,'$.projectedCount')=job.projected_records
     JOIN activity_request_replays AS replay
       ON replay.actor_staff_id=job.created_by_staff_id
      AND replay.operation='activity.projection.continue'
      AND replay.idempotency_key=? AND replay.request_hash=?
     WHERE job.id=? AND job.import_id=? AND job.status=?
       AND job.after_source_record_id IS ? AND job.total_records=?
       AND job.processed_records=? AND job.projected_records=? AND job.version=?
       AND (? IS NULL OR EXISTS (
         SELECT 1 FROM activity_source_links AS source_link
         JOIN activity_charges AS charge ON charge.id=source_link.entity_id
         WHERE source_link.source_record_id=? AND source_link.relation='charge'
           AND charge.status='active'))
   )`,
).bind(
  auditId, command.idempotencyKey, requestHash, projection.id, projection.importId,
  projection.status, projection.afterSourceRecordId, projection.totalRecords,
  projection.processedRecords, projection.projectedRecords, projection.version,
  sourceRecordId, sourceRecordId,
)

const exactWorkbookActivityCounts = (summary) => summary.totalRecords === 190
  && summary.tusRecords === 25 && summary.tusDayRecords === 2
  && summary.tusMonthRecords === 23 && summary.englishRecords === 165
  && summary.englishMonthRecords === 165 && summary.invalidPeriodRecords === 0

const recoverProjectionWrite = async (command, requestHash, previousVersion, error) => {
  const replay = await loadProjectionReplay(command.recoveryDb, command)
  if (replay) {
    if (replay.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
    const state = await loadProjectionState(
      command.recoveryDb, command.actor.id, command.importId,
    )
    return openProjectionReplay(command.recoveryDb, command, state, replay)
  }
  const current = await loadProjectionState(
    command.recoveryDb, command.actor.id, command.importId,
  )
  if (current.job_id !== null && current.job_version !== previousVersion) {
    versionConflict(current.job_version)
  }
  throw error
}

const createProjectionJob = async (command, state, requestHash) => {
  if (command.expectedVersion !== 0) versionConflict(0)
  const summary = await activityProjectionSourceReconciliation({
    db: command.db, importId: command.importId,
  })
  if (!exactWorkbookActivityCounts(summary)) {
    fail('ACTIVITY_PROJECTION_RECONCILIATION_FAILED')
  }
  const dataKey = await getOrCreateDataKey(command.db, command.keyring, ACTIVITY_SCOPE, {
    id: made(command.idFactory, 'key', /^key_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
    createdAt: command.now,
  })
  const projection = captureActivityProjectionJob({
    id: made(command.idFactory, 'apj', JOB_ID), importId: command.importId,
    status: 'ready', afterSourceRecordId: null, totalRecords: summary.totalRecords,
    processedRecords: 0, projectedRecords: 0, version: 1,
    updatedAt: command.now, completedAt: null,
  })
  const auditId = made(command.idFactory, 'aud', AUDIT_ID)
  const responseEnvelope = await sealProjectionReplay(command, dataKey, projection, 201)
  try {
    await command.db.batch([
      command.db.prepare(`INSERT INTO activity_projection_jobs
        (id,import_id,status,after_source_record_id,total_records,processed_records,
         projected_records,created_by_staff_id,correlation_id,version,created_at,
         updated_at,completed_at)
        VALUES (?,?,'ready',NULL,?,0,0,?,?,1,?,?,NULL)`).bind(
        projection.id, command.importId, projection.totalRecords,
        state.created_by_staff_id, state.correlation_id, command.now, command.now,
      ),
      activityProjectionAuditStatement({
        db: command.db, id: auditId, occurredAt: command.now,
        actorStaffId: command.actor.id, jobId: projection.id,
        correlationId: state.correlation_id, jobVersion: 1,
        processedCount: 0, projectedCount: 0,
      }),
      projectionReplayStatement(command, requestHash, responseEnvelope),
      projectionGuardStatement(command, {
        projection, auditId, requestHash, sourceRecordId: null,
      }),
      authorityInvariant(command.db, command.actor),
    ])
  } catch (error) {
    return recoverProjectionWrite(command, requestHash, 0, error)
  }
  return projectionResponse(projection, 201)
}

export async function continueActivityProjection(input) {
  const command = continuationCommand(input)
  const state = await loadProjectionState(
    command.db, command.actor.id, command.importId,
  )
  const requestHash = await continuationHash(command, state)
  const replay = await loadProjectionReplay(command.db, command)
  if (replay) {
    if (replay.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
    if (state.job_id === null) fail('CRYPTO_FAILURE')
    return openProjectionReplay(command.db, command, state, replay)
  }
  if (state.job_id === null) {
    return createProjectionJob(command, state, requestHash)
  }
  if (state.job_version !== command.expectedVersion) versionConflict(state.job_version)
  const current = projectionDto(state)
  if (current.status === 'complete') return projectionResponse(current)
  const cursor = await loadActivityProjectionCursorSlice({
    db: command.db, importId: command.importId,
    afterSourceRecordId: current.afterSourceRecordId,
  })
  if (cursor.sourceRecordIds.length !== 1) fail('ACTIVITY_PROJECTION_CONFLICT')
  const prepared = await prepareActivitySlice(commandInput({
    db: command.db, recoveryDb: command.recoveryDb, keyring: command.keyring,
    config: command.config, centreId: command.centreId, importId: command.importId,
    actor: command.actor, nowMs: command.nowMs, idFactory: command.idFactory,
    sourceRecordIds: cursor.sourceRecordIds,
  }))
  const processedRecords = current.processedRecords + prepared.items.length
  const projectedRecords = current.projectedRecords + prepared.items.length
  const complete = cursor.done && processedRecords === current.totalRecords
  if (processedRecords > current.totalRecords
    || (cursor.done && !complete)
    || (!cursor.done && processedRecords === current.totalRecords)) {
    fail('ACTIVITY_PROJECTION_CONFLICT')
  }
  const projection = captureActivityProjectionJob({
    ...current,
    status: complete ? 'complete' : 'running',
    afterSourceRecordId: cursor.afterSourceRecordId,
    processedRecords,
    projectedRecords,
    version: current.version + 1,
    updatedAt: command.now,
    completedAt: complete ? command.now : null,
  })
  const auditId = made(command.idFactory, 'aud', AUDIT_ID)
  const responseEnvelope = await sealProjectionReplay(
    command, prepared.command.activityDataKey, projection, 200,
  )
  const sourceRecordId = cursor.sourceRecordIds[0]
  const statements = [
    ...prepared.statements,
    command.db.prepare(`UPDATE activity_projection_jobs SET
      status=?,after_source_record_id=?,processed_records=?,projected_records=?,
      version=?,updated_at=?,completed_at=?
      WHERE id=? AND version=? AND status IN ('ready','running')`).bind(
      projection.status, projection.afterSourceRecordId, projection.processedRecords,
      projection.projectedRecords, projection.version, projection.updatedAt,
      projection.completedAt, projection.id, current.version,
    ),
    command.db.prepare(`INSERT INTO core_directory_invariant_failures (failure_kind)
      SELECT 'activity_projection_cas' WHERE changes()!=1`),
    activityProjectionAuditStatement({
      db: command.db, id: auditId, occurredAt: command.now,
      actorStaffId: command.actor.id, jobId: projection.id,
      correlationId: state.correlation_id, jobVersion: projection.version,
      processedCount: projection.processedRecords,
      projectedCount: projection.projectedRecords,
    }),
    projectionReplayStatement(command, requestHash, responseEnvelope),
    projectionGuardStatement(command, {
      projection, auditId, requestHash, sourceRecordId,
    }),
    authorityInvariant(command.db, command.actor),
  ]
  try {
    await command.db.batch(statements)
  } catch (error) {
    return recoverProjectionWrite(command, requestHash, current.version, error)
  }
  const authoritative = await loadProjectionState(
    command.db, command.actor.id, command.importId,
  )
  if (authoritative.job_version !== projection.version) {
    versionConflict(authoritative.job_version ?? 0)
  }
  return projectionResponse(projectionDto(authoritative))
}

export async function getActivityProjection(input) {
  const value = exact(input, ['db', 'actor', 'importId'])
  if (!value.db?.prepare
    || !authorize(value.actor, 'finance.import', CENTRE_RESOURCE, { nowMs: 0 })
    || typeof value.actor.id !== 'string' || !STAFF_ID.test(value.actor.id)
    || typeof value.importId !== 'string' || !IMPORT_ID.test(value.importId)) {
    fail('NOT_FOUND')
  }
  const state = await loadProjectionState(value.db, value.actor.id, value.importId)
  return Object.freeze({
    data: Object.freeze({ job: projectionDto(state) }),
  })
}
