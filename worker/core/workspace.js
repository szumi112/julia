import { AppError } from '../http/errors.js'
import { authorize } from '../identity/policy.js'
import { decryptForScope } from '../security/envelope.js'
import { decodeBase64Url } from '../security/encoding.js'
import { decryptClientIdentity } from './crypto.js'
import {
  assertClientIdentity,
  assertLocation,
  isAppointmentId,
  isAssignmentId,
  isCanonicalUtc,
  isChargeId,
  isClientId,
  isCorrectionId,
  isPaymentId,
  isSpecialistId,
} from '../../src/core-records.js'
import {
  captureHistoricalClient,
  captureHistoricalOccurrence,
  captureHistoricalPeriod,
  compareHistoricalClients,
  compareHistoricalOccurrences,
  isHistoricalClientId,
  isHistoricalCounterpartyId,
  isHistoricalOccurrenceId,
} from '../../src/historical-records.js'
import { SERVICE_BY_ID } from '../../src/services.js'
import { decryptHistoricalIdentityWithDataKey } from './historical-crypto.js'

const validation = (field) => { throw new AppError('VALIDATION_FAILED', { field }) }
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
const collator = new Intl.Collator('pl-PL', { sensitivity: 'base', usage: 'sort' })
const CAPS = Object.freeze({
  specialists: 50, clients: 1_000, appointments: 500, paymentEntries: 1_000,
  historicalClients: 1_000, historicalOccurrences: 1_000,
})
const STAFF_KEYS = Object.freeze([
  'id', 'staff_user_id', 'standard_rate_grosze', 'status', 'version', 'staff_id',
  'staff_specialist_id', 'staff_status', 'staff_version', 'display_name_envelope',
])
const CLIENT_KEYS = Object.freeze([
  'id', 'identity_envelope', 'status', 'version', 'archived_at', 'created_at',
  'updated_at', 'assignment_id', 'assignment_specialist_id', 'assignment_starts_at',
  'assignment_version', 'key_id', 'key_scope_type', 'key_scope_id', 'key_purpose',
  'key_dek_version', 'key_wrapped_key_b64', 'key_wrap_nonce_b64', 'key_kek_version',
  'key_created_at', 'key_retired_at',
])
const APPOINTMENT_KEYS = Object.freeze([
  'id', 'client_id', 'specialist_id', 'service_id', 'starts_at', 'ends_at',
  'time_zone', 'location', 'status', 'source', 'version', 'cancelled_at', 'created_at',
  'updated_at', 'charge_id', 'charge_service_id', 'expected_amount_grosze',
  'currency', 'charge_version',
])
const PAYMENT_KEYS = Object.freeze([
  'id', 'appointment_id', 'amount_grosze', 'method', 'received_at',
  'payment_created_at', 'correction_id', 'corrected_at', 'replacement_entry_id',
])
const DATA_KEY_KEYS = Object.freeze([
  'id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64',
  'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at',
])
const HISTORICAL_CLIENT_KEYS = Object.freeze([
  'id', 'identity_envelope', 'status', 'active_client_id', 'version', 'created_at',
  'updated_at', 'key_id', 'key_scope_type', 'key_scope_id', 'key_purpose',
  'key_dek_version', 'key_wrapped_key_b64', 'key_wrap_nonce_b64', 'key_kek_version',
  'key_created_at', 'key_retired_at',
])
const HISTORICAL_COUNTERPARTY_KEYS = Object.freeze([
  'id', 'identity_envelope', 'version', 'created_at', 'updated_at', 'key_id',
  'key_scope_type', 'key_scope_id', 'key_purpose', 'key_dek_version',
  'key_wrapped_key_b64', 'key_wrap_nonce_b64', 'key_kek_version', 'key_created_at',
  'key_retired_at',
])
const HISTORICAL_OCCURRENCE_KEYS = Object.freeze([
  'id', 'source_record_id', 'historical_client_id', 'counterparty_id', 'specialist_id',
  'service_id', 'service_label_envelope', 'period_precision', 'occurred_on',
  'occurred_month', 'status', 'version', 'created_at', 'updated_at',
])
const HISTORICAL_LATEST_KEYS = Object.freeze(['latest_month'])

const invalid = () => { throw new Error('INTERNAL_ERROR') }
const cryptoFailure = () => { throw new Error('CRYPTO_FAILURE') }

const captureExact = (value, keys, failure = invalid) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) failure()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) failure()
    const captured = Object.create(null)
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) failure()
      captured[key] = descriptor.value
    }
    return captured
  } catch { failure() }
}

const captureCallable = (target, key) => {
  try {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function')) invalid()
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') invalid()
    return descriptor.value
  } catch { invalid() }
}

const denseRows = (value) => {
  try {
    if (!Array.isArray(value)) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || length < 0
      || Reflect.ownKeys(descriptors).length !== length + 1) invalid()
    const rows = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
      rows.push(descriptor.value)
    }
    return rows
  } catch { invalid() }
}

const captureDb = (db) => Object.freeze({
  db,
  prepare: captureCallable(db, 'prepare'),
  batch: captureCallable(db, 'batch'),
})

const query = async (capabilities, sql, bindings, rowKeys) => {
  const statement = capabilities.prepare.call(capabilities.db, sql)
  const bind = captureCallable(statement, 'bind')
  const bound = bind.apply(statement, bindings)
  const all = captureCallable(bound, 'all')
  const pending = all.call(bound)
  if (!(pending instanceof Promise)) invalid()
  const result = await pending
  let rows
  try {
    const descriptor = Object.getOwnPropertyDescriptor(result, 'results')
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid()
    rows = denseRows(descriptor.value)
  } catch { invalid() }
  return rows.map((row) => Object.freeze(captureExact(row, rowKeys)))
}

const positive = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value)
  && value >= 1 && value <= max
const nullableInstant = (value) => value === null || isCanonicalUtc(value)
const canonicalName = (value) => {
  try { return assertClientIdentity({ name: value, age: null }).name } catch { cryptoFailure() }
}
const parseEnvelope = (value) => {
  if (typeof value !== 'string') cryptoFailure()
  try { return JSON.parse(value) } catch { cryptoFailure() }
}
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const defaultDecryptSpecialist = async ({ recordId, envelope, cryptoContext }) => {
  const context = captureExact(cryptoContext, ['keyring', 'dataKey', 'scope'], cryptoFailure)
  return decryptForScope(context.keyring, context.dataKey, {
    expectedScope: context.scope,
    recordId,
    field: 'display_name',
    envelope: parseEnvelope(envelope),
  })
}

const defaultDecryptClient = async ({ clientId, envelope, dataKey, keyring }) => (
  decryptClientIdentity({ keyring, dataKey, scope: { type: 'client', id: clientId, purpose: 'identity' } }, {
    clientId, envelope,
  })
)

const civil = (value, field) => {
  if (typeof value !== 'string') validation(field)
  const match = DATE.exec(value)
  if (!match) validation(field)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const epoch = Date.UTC(year, month - 1, day)
  const exact = new Date(epoch)
  if (exact.getUTCFullYear() !== year || exact.getUTCMonth() !== month - 1
    || exact.getUTCDate() !== day) validation(field)
  return Object.freeze({ value, year, month, day, epoch })
}

const nextCivil = ({ epoch }) => {
  const date = new Date(epoch + 86_400_000)
  return Object.freeze({
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
    day: date.getUTCDate(), epoch: date.getTime(),
  })
}

const offsetAt = (epoch) => {
  const fields = Object.fromEntries(dayFormatter.formatToParts(new Date(epoch))
    .filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]))
  return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second) - epoch
}

const warsawMidnight = ({ year, month, day, epoch }) => {
  let instant = epoch - offsetAt(epoch)
  instant = epoch - offsetAt(instant)
  const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(instant))
    .filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]))
  if (parts.year !== year || parts.month !== month || parts.day !== day
    || parts.hour !== 0 || parts.minute !== 0 || parts.second !== 0) validation('from')
  return new Date(instant).toISOString()
}

export function parseWorkspaceQuery(value) {
  if (typeof value !== 'string') validation('from')
  let url
  try { url = new URL(value) } catch { validation('from') }
  if (url.hash || !url.search || url.search.includes('%')) validation('from')
  const entries = url.search.slice(1).split('&')
  if (entries.length !== 2) {
    if (entries.filter((entry) => entry.startsWith('from=')).length > 1) validation('from')
    if (entries.filter((entry) => entry.startsWith('to=')).length > 1) validation('to')
    if (entries.some((entry) => entry.startsWith('from='))
      && !entries.some((entry) => entry.startsWith('to='))) validation('to')
    validation('from')
  }
  const values = Object.create(null)
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    const key = separator === -1 ? entry : entry.slice(0, separator)
    const raw = separator === -1 ? '' : entry.slice(separator + 1)
    if (key !== 'from' && key !== 'to') validation('from')
    if (Object.hasOwn(values, key)) validation(key)
    values[key] = raw
  }
  if (!Object.hasOwn(values, 'from')) validation('from')
  if (!Object.hasOwn(values, 'to')) validation('to')
  const from = civil(values.from, 'from')
  const to = civil(values.to, 'to')
  const days = Math.floor((to.epoch - from.epoch) / 86_400_000) + 1
  if (days < 1 || days > 93) validation('to')
  return Object.freeze({
    from: from.value,
    to: to.value,
    lower: warsawMidnight(from),
    upper: warsawMidnight(nextCivil(to)),
  })
}

const DIRECTORY_SQL = `
  SELECT specialist.id, specialist.staff_user_id, specialist.standard_rate_grosze,
         specialist.status, specialist.version, staff.id AS staff_id,
         staff.specialist_id AS staff_specialist_id, staff.status AS staff_status,
         staff.version AS staff_version, staff.display_name_envelope
  FROM specialists AS specialist
  JOIN staff_users AS staff
    ON staff.id=specialist.staff_user_id AND staff.specialist_id=specialist.id
  WHERE specialist.status='active' AND staff.status='active'
  ORDER BY specialist.id
  LIMIT ?`

const directoryV2Sql = (specialist) => `
  SELECT specialist.id, specialist.staff_user_id, specialist.standard_rate_grosze,
         specialist.status, specialist.version, staff.id AS staff_id,
         staff.specialist_id AS staff_specialist_id, staff.status AS staff_status,
         staff.version AS staff_version, specialist.display_name_envelope
  FROM specialists AS specialist
  LEFT JOIN staff_users AS staff
    ON staff.id=specialist.staff_user_id AND staff.specialist_id=specialist.id
  WHERE (specialist.status IN ('active','pending')
      AND (specialist.staff_user_id IS NULL OR staff.status IN ('pending','active')))
    OR (specialist.status='archived' AND EXISTS (
      SELECT 1 FROM historical_service_occurrences AS occurrence
      WHERE occurrence.specialist_id=specialist.id
        AND ${historicalWindowSql(specialist)}
    ))
  ORDER BY specialist.id
  LIMIT ?`

const appointmentSql = (specialist) => `
  SELECT appointment.id, appointment.client_id, appointment.specialist_id,
         appointment.service_id, appointment.starts_at, appointment.ends_at,
         appointment.time_zone, appointment.location, appointment.status,
         appointment.source, appointment.version, appointment.cancelled_at,
         appointment.created_at, appointment.updated_at, charge.id AS charge_id,
         charge.service_id AS charge_service_id,
         charge.expected_amount_grosze, charge.currency,
         charge.version AS charge_version
  FROM ${specialist
    ? 'appointments AS appointment INDEXED BY appointments_specialist_starts_id_idx'
    : `specialists AS scope
       CROSS JOIN appointments AS appointment INDEXED BY appointments_specialist_starts_id_idx
         ON appointment.specialist_id=scope.id`}
  LEFT JOIN session_charges AS charge ON charge.appointment_id=appointment.id
  WHERE ${specialist ? 'appointment.specialist_id=? AND ' : ''}
        appointment.starts_at>=? AND appointment.starts_at<?
  ORDER BY appointment.starts_at,appointment.id
  LIMIT ?`

const clientSql = (specialist) => `
  SELECT client.id, client.identity_envelope, client.status, client.version,
         client.archived_at, client.created_at, client.updated_at,
         assignment.id AS assignment_id,
         assignment.specialist_id AS assignment_specialist_id,
         assignment.starts_at AS assignment_starts_at,
         assignment.version AS assignment_version,
         data_key.id AS key_id, data_key.scope_type AS key_scope_type,
         data_key.scope_id AS key_scope_id, data_key.purpose AS key_purpose,
         data_key.dek_version AS key_dek_version,
         data_key.wrapped_key_b64 AS key_wrapped_key_b64,
         data_key.wrap_nonce_b64 AS key_wrap_nonce_b64,
         data_key.kek_version AS key_kek_version,
         data_key.created_at AS key_created_at,
         data_key.retired_at AS key_retired_at
  FROM clients AS client
  LEFT JOIN client_assignments AS assignment
    ON assignment.client_id=client.id AND assignment.ends_at IS NULL
       ${specialist ? 'AND assignment.specialist_id=?' : ''}
  LEFT JOIN data_keys AS data_key
    ON data_key.id=CASE WHEN json_valid(client.identity_envelope)
                        THEN json_extract(client.identity_envelope,'$.dataKeyId') END
   AND data_key.dek_version=CASE WHEN json_valid(client.identity_envelope)
                                 THEN json_extract(client.identity_envelope,'$.dataKeyVersion') END
   AND data_key.scope_type='client' AND data_key.scope_id=client.id
   AND data_key.purpose='identity'
  WHERE (
    (client.status IN ('active','paused') AND assignment.id IS NOT NULL)
    OR (assignment.id IS NULL
      AND (client.status='archived' OR (client.status IN ('active','paused') AND EXISTS (
        SELECT 1 FROM client_assignments AS current_assignment
        WHERE current_assignment.client_id=client.id AND current_assignment.ends_at IS NULL
      )))
      AND EXISTS (
      SELECT 1 FROM appointments AS history
      WHERE history.client_id=client.id
        ${specialist ? 'AND history.specialist_id=?' : ''}
        AND history.starts_at>=? AND history.starts_at<?
      ))
  )
  ORDER BY client.id
  LIMIT ?`

const paymentSql = (specialist) => `
  SELECT payment.id, payment.appointment_id, payment.amount_grosze, payment.method,
         payment.received_at, payment.created_at AS payment_created_at,
         correction.id AS correction_id,
         correction.created_at AS corrected_at, correction.replacement_entry_id
  FROM ${specialist
    ? 'appointments AS appointment INDEXED BY appointments_specialist_starts_id_idx'
    : `specialists AS scope
       CROSS JOIN appointments AS appointment INDEXED BY appointments_specialist_starts_id_idx
         ON appointment.specialist_id=scope.id`}
  CROSS JOIN payment_entries AS payment ON payment.appointment_id=appointment.id
  LEFT JOIN payment_corrections AS correction ON correction.reversed_entry_id=payment.id
  WHERE ${specialist ? 'appointment.specialist_id=? AND ' : ''}
        appointment.starts_at>=? AND appointment.starts_at<?
  ORDER BY payment.received_at,payment.id
  LIMIT ?`

const historicalWindowSql = (specialist) => `
  ${specialist ? 'occurrence.specialist_id=? AND ' : ''}(
    (occurrence.period_precision='day'
      AND occurrence.occurred_on>=? AND occurrence.occurred_on<=?)
    OR (occurrence.period_precision='month'
      AND occurrence.occurred_month>=? AND occurrence.occurred_month<=?)
    OR occurrence.period_precision='unknown'
  )`

const historicalSubjectSql = ({ specialist, kind }) => {
  const person = kind === 'person'
  const table = person ? 'historical_clients' : 'historical_counterparties'
  const alias = person ? 'historical_client' : 'historical_counterparty'
  const subjectColumn = person ? 'historical_client_id' : 'counterparty_id'
  return `
    SELECT ${alias}.id,${alias}.identity_envelope,
           ${person ? `${alias}.status,${alias}.active_client_id,` : ''}
           ${alias}.version,${alias}.created_at,${alias}.updated_at,
           data_key.id AS key_id,data_key.scope_type AS key_scope_type,
           data_key.scope_id AS key_scope_id,data_key.purpose AS key_purpose,
           data_key.dek_version AS key_dek_version,
           data_key.wrapped_key_b64 AS key_wrapped_key_b64,
           data_key.wrap_nonce_b64 AS key_wrap_nonce_b64,
           data_key.kek_version AS key_kek_version,
           data_key.created_at AS key_created_at,
           data_key.retired_at AS key_retired_at
    FROM ${table} AS ${alias}
    LEFT JOIN data_keys AS data_key
      ON data_key.id=CASE WHEN json_valid(${alias}.identity_envelope)
                          THEN json_extract(${alias}.identity_envelope,'$.dataKeyId') END
     AND data_key.dek_version=CASE WHEN json_valid(${alias}.identity_envelope)
                                   THEN json_extract(${alias}.identity_envelope,'$.dataKeyVersion') END
     AND data_key.scope_type='${person ? 'historical_client' : 'historical_counterparty'}'
     AND data_key.scope_id=${alias}.id AND data_key.purpose='identity'
    WHERE EXISTS (
      SELECT 1 FROM historical_service_occurrences AS occurrence
      WHERE occurrence.${subjectColumn}=${alias}.id
        AND ${historicalWindowSql(specialist)}
    )
    ORDER BY ${alias}.id
    LIMIT ?`
}

const historicalOccurrenceSql = (specialist) => `
  SELECT occurrence.id,occurrence.source_record_id,occurrence.historical_client_id,
         occurrence.counterparty_id,occurrence.specialist_id,occurrence.service_id,
         occurrence.service_label_envelope,occurrence.period_precision,
         occurrence.occurred_on,occurrence.occurred_month,occurrence.status,
         occurrence.version,occurrence.created_at,occurrence.updated_at
  FROM historical_service_occurrences AS occurrence
  WHERE ${historicalWindowSql(specialist)}
  ORDER BY CASE occurrence.period_precision WHEN 'day' THEN 0 WHEN 'month' THEN 1 ELSE 2 END,
           CASE occurrence.period_precision WHEN 'day' THEN occurrence.occurred_on
             WHEN 'month' THEN occurrence.occurred_month ELSE '' END,
           occurrence.id
  LIMIT ?`

const historicalLatestSql = (specialist) => `
  SELECT MAX(occurrence.occurred_month) AS latest_month
  FROM historical_service_occurrences AS occurrence
  WHERE ${specialist ? 'occurrence.specialist_id=? AND ' : ''}
        occurrence.status='recorded'
    AND occurrence.period_precision IN ('day','month')`

const limit = (rows, field) => {
  if (rows.length > CAPS[field]) throw new AppError('WORKSPACE_RESULT_LIMIT', {
    field, limit: CAPS[field],
  })
  return rows
}

const validActor = (actor) => {
  const value = captureExact(actor, ['id', 'role', 'specialistId', 'version'])
  if (typeof value.id !== 'string' || !/^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(value.id)
    || !['owner', 'coordinator', 'specialist'].includes(value.role)
    || !positive(value.version)
    || (value.role === 'specialist'
      ? !isSpecialistId(value.specialistId)
      : value.specialistId !== null && !isSpecialistId(value.specialistId))) invalid()
  return Object.freeze(value)
}

const dataKeyFromClient = (row) => Object.freeze(Object.fromEntries(DATA_KEY_KEYS.map((key) => {
  const source = `key_${key}`
  return [key, row[source]]
})))

const dataKeyFromHistoricalSubject = (row) => Object.freeze(Object.fromEntries(
  DATA_KEY_KEYS.map((key) => [key, row[`key_${key}`]]),
))

const decodedBytes = (value, length, minimum = false) => {
  let decoded
  try { decoded = decodeBase64Url(value) } catch { cryptoFailure() }
  if ((minimum && decoded.byteLength < length) || (!minimum && decoded.byteLength !== length)) {
    decoded.fill(0)
    cryptoFailure()
  }
  decoded.fill(0)
}

const validatedClientKey = (row) => {
  const envelope = captureExact(parseEnvelope(row.identity_envelope), [
    'format', 'algorithm', 'dataKeyId', 'dataKeyVersion', 'nonce', 'ciphertext',
  ], cryptoFailure)
  if (envelope.format !== 1 || envelope.algorithm !== 'A256GCM'
    || typeof envelope.dataKeyId !== 'string' || !OPAQUE_ID.test(envelope.dataKeyId)
    || !positive(envelope.dataKeyVersion)) cryptoFailure()
  decodedBytes(envelope.nonce, 12)
  decodedBytes(envelope.ciphertext, 16, true)
  const dataKey = dataKeyFromClient(row)
  if (dataKey.id !== envelope.dataKeyId || dataKey.dek_version !== envelope.dataKeyVersion
    || typeof dataKey.id !== 'string' || !OPAQUE_ID.test(dataKey.id)
    || dataKey.scope_type !== 'client' || dataKey.scope_id !== row.id
    || dataKey.purpose !== 'identity' || !positive(dataKey.dek_version)
    || !positive(dataKey.kek_version) || !isCanonicalUtc(dataKey.created_at)
    || !nullableInstant(dataKey.retired_at)) cryptoFailure()
  decodedBytes(dataKey.wrapped_key_b64, 48)
  decodedBytes(dataKey.wrap_nonce_b64, 12)
  return dataKey
}

const validatedHistoricalSubjectKey = (row, kind) => {
  const envelope = captureExact(parseEnvelope(row.identity_envelope), [
    'format', 'algorithm', 'dataKeyId', 'dataKeyVersion', 'nonce', 'ciphertext',
  ], cryptoFailure)
  if (envelope.format !== 1 || envelope.algorithm !== 'A256GCM'
    || typeof envelope.dataKeyId !== 'string' || !OPAQUE_ID.test(envelope.dataKeyId)
    || !positive(envelope.dataKeyVersion)) cryptoFailure()
  decodedBytes(envelope.nonce, 12)
  decodedBytes(envelope.ciphertext, 16, true)
  const dataKey = dataKeyFromHistoricalSubject(row)
  const scopeType = kind === 'person' ? 'historical_client' : 'historical_counterparty'
  if (dataKey.id !== envelope.dataKeyId || dataKey.dek_version !== envelope.dataKeyVersion
    || typeof dataKey.id !== 'string' || !OPAQUE_ID.test(dataKey.id)
    || dataKey.scope_type !== scopeType || dataKey.scope_id !== row.id
    || dataKey.purpose !== 'identity' || !positive(dataKey.dek_version)
    || !positive(dataKey.kek_version) || !isCanonicalUtc(dataKey.created_at)
    || !nullableInstant(dataKey.retired_at)) cryptoFailure()
  decodedBytes(dataKey.wrapped_key_b64, 48)
  decodedBytes(dataKey.wrap_nonce_b64, 12)
  return dataKey
}

const defaultDecryptHistoricalIdentity = async ({ kind, id, envelope, dataKey, keyring }) => (
  decryptHistoricalIdentityWithDataKey(keyring, { kind, id, envelope, dataKey })
)

const defaultDecryptHistoricalField = async ({
  kind, subjectId, recordId, envelope, dataKey, keyring,
}) => decryptForScope(keyring, dataKey, {
  expectedScope: {
    type: kind === 'person' ? 'historical_client' : 'historical_counterparty',
    id: subjectId,
    purpose: 'identity',
  },
  recordId,
  field: 'service_label',
  envelope: parseEnvelope(envelope),
})

const specialistDto = async (row, context, decrypt, profileV2) => {
  const archived = row.status === 'archived'
  const accessStatus = row.staff_user_id === null
    ? 'unclaimed'
    : row.staff_status === 'pending' ? 'invited'
      : row.staff_status === 'active' ? 'enabled' : null
  if (!isSpecialistId(row.id) || !positive(row.standard_rate_grosze, 1_000_000)
    || !positive(row.version) || typeof row.display_name_envelope !== 'string'
    || (profileV2
      ? (!['active', 'pending', 'archived'].includes(row.status)
        || (!archived && accessStatus === null)
        || (row.staff_user_id !== null && (
          row.staff_user_id !== row.staff_id || row.staff_specialist_id !== row.id
          || !positive(row.staff_version)
          || (archived && !['pending', 'active', 'disabled'].includes(row.staff_status))
        )))
      : (typeof row.staff_user_id !== 'string' || row.staff_user_id !== row.staff_id
        || row.staff_specialist_id !== row.id || row.status !== 'active'
        || row.staff_status !== 'active' || !positive(row.staff_version)))) invalid()
  let decryptedName
  try {
    decryptedName = await decrypt({
      recordId: profileV2 ? row.id : row.staff_id,
      staffId: row.staff_id,
      envelope: row.display_name_envelope,
      cryptoContext: context,
    })
  } catch (error) {
    if (!profileV2 || row.staff_id === null) throw error
    decryptedName = await decrypt({
      recordId: row.staff_id,
      staffId: row.staff_id,
      envelope: row.display_name_envelope,
      cryptoContext: context,
    })
  }
  const displayName = canonicalName(decryptedName)
  if (profileV2 && archived) return freeze({
    id: row.id, displayName, standardRateGrosze: row.standard_rate_grosze,
    status: 'archived', version: row.version, staffVersion: row.staff_version,
  })
  return freeze(profileV2 ? {
    id: row.id, displayName, standardRateGrosze: row.standard_rate_grosze,
    status: 'active', version: row.version, staffVersion: row.staff_version,
    accessStatus,
  } : {
    id: row.id, displayName, standardRateGrosze: row.standard_rate_grosze,
    status: 'active', version: row.version, staffVersion: row.staff_version,
  })
}

const assignmentDto = (row) => {
  const values = [row.assignment_id, row.assignment_specialist_id,
    row.assignment_starts_at, row.assignment_version]
  if (values.every((value) => value === null)) return null
  if (!isAssignmentId(row.assignment_id) || !isSpecialistId(row.assignment_specialist_id)
    || !isCanonicalUtc(row.assignment_starts_at) || !positive(row.assignment_version)) invalid()
  return freeze({
    id: row.assignment_id, specialistId: row.assignment_specialist_id,
    startsAt: row.assignment_starts_at, version: row.assignment_version,
  })
}

const clientDto = async (row, actor, context, decrypt, appointmentByClient) => {
  if (!isClientId(row.id) || !['active', 'paused', 'archived'].includes(row.status)
    || !positive(row.version) || !nullableInstant(row.archived_at)
    || !isCanonicalUtc(row.created_at) || !isCanonicalUtc(row.updated_at)
    || row.created_at > row.updated_at
    || (row.status === 'archived') !== (row.archived_at !== null)
    || typeof row.identity_envelope !== 'string') invalid()
  const assignment = assignmentDto(row)
  if (row.status === 'archived' && assignment !== null) invalid()
  if ((row.archived_at !== null
      && (row.archived_at < row.created_at || row.archived_at > row.updated_at))
    || (assignment !== null
      && (assignment.startsAt < row.created_at || assignment.startsAt > row.updated_at))) invalid()
  const fact = assignment === null
    ? (() => {
      const appointment = appointmentByClient.get(row.id)?.[0]
      return appointment ? {
        kind: 'client_history', clientId: row.id, appointmentId: appointment.id,
        specialistId: appointment.specialist_id,
      } : null
    })()
    : {
      kind: 'client', clientId: row.id,
      assignment: {
        kind: 'client_assignment', clientId: row.id,
        specialistId: assignment?.specialistId, status: 'active',
      },
    }
  if (!fact || !authorize(actor, 'client.operational.read', fact, { nowMs: 0 })) invalid()
  const dataKey = validatedClientKey(row)
  const decrypted = captureExact(await decrypt({
    clientId: row.id, envelope: row.identity_envelope, dataKey,
    keyring: context.keyring,
  }), ['name', 'age'], cryptoFailure)
  const identity = assertClientIdentity(decrypted)
  return freeze({
    id: row.id, name: identity.name, age: identity.age, status: row.status,
    version: row.version, archivedAt: row.archived_at, createdAt: row.created_at,
    updatedAt: row.updated_at, readOnly: row.status === 'archived', assignment,
  })
}

const historicalClientRecord = async ({
  row, visibleClientIds, keyring, decryptIdentity,
}) => {
  if (!isHistoricalClientId(row.id) || !['historical', 'activated'].includes(row.status)
    || !positive(row.version) || !isCanonicalUtc(row.created_at)
    || !isCanonicalUtc(row.updated_at) || row.created_at > row.updated_at
    || typeof row.identity_envelope !== 'string'
    || (row.status === 'historical' ? row.active_client_id !== null
      : !isClientId(row.active_client_id))) invalid()
  const dataKey = validatedHistoricalSubjectKey(row, 'person')
  const name = await decryptIdentity({
    kind: 'person', id: row.id, envelope: row.identity_envelope, dataKey, keyring,
  })
  const dto = captureHistoricalClient({
    id: row.id, name, status: row.status,
    activeClientId: visibleClientIds.has(row.active_client_id) ? row.active_client_id : null,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  })
  return Object.freeze({ dto, dataKey })
}

const historicalCounterpartyRecord = async ({ row, keyring, decryptIdentity }) => {
  if (!isHistoricalCounterpartyId(row.id) || !positive(row.version)
    || !isCanonicalUtc(row.created_at) || !isCanonicalUtc(row.updated_at)
    || row.created_at > row.updated_at || typeof row.identity_envelope !== 'string') invalid()
  const dataKey = validatedHistoricalSubjectKey(row, 'counterparty')
  const name = await decryptIdentity({
    kind: 'counterparty', id: row.id, envelope: row.identity_envelope, dataKey, keyring,
  })
  return Object.freeze({ id: row.id, name, dataKey })
}

const historicalOccurrenceBase = (row, actor) => {
  if (!isHistoricalOccurrenceId(row.id)
    || (row.historical_client_id === null) === (row.counterparty_id === null)
    || !(row.historical_client_id === null || isHistoricalClientId(row.historical_client_id))
    || !(row.counterparty_id === null || isHistoricalCounterpartyId(row.counterparty_id))
    || !isSpecialistId(row.specialist_id)
    || (actor.role === 'specialist' && row.specialist_id !== actor.specialistId)
    || !(row.service_id === null || Object.hasOwn(SERVICE_BY_ID, row.service_id))
    || typeof row.service_label_envelope !== 'string'
    || !['recorded', 'voided'].includes(row.status) || !positive(row.version)
    || !isCanonicalUtc(row.created_at) || !isCanonicalUtc(row.updated_at)
    || row.created_at > row.updated_at) invalid()
  captureHistoricalPeriod({
    precision: row.period_precision, day: row.occurred_on, month: row.occurred_month,
  })
  return row
}

const historicalOccurrenceDto = async ({
  row, clientsById, counterpartiesById, keyring, decryptField,
}) => {
  const kind = row.historical_client_id === null ? 'counterparty' : 'person'
  const subjectId = row.historical_client_id ?? row.counterparty_id
  const subject = kind === 'person'
    ? clientsById.get(subjectId) : counterpartiesById.get(subjectId)
  if (!subject) invalid()
  const serviceLabel = await decryptField({
    kind, subjectId, recordId: row.id, envelope: row.service_label_envelope,
    dataKey: subject.dataKey, keyring,
  })
  return captureHistoricalOccurrence({
    id: row.id,
    historicalClientId: row.historical_client_id,
    counterparty: kind === 'counterparty' ? { id: subject.id, name: subject.name } : null,
    specialistId: row.specialist_id,
    serviceId: row.service_id,
    serviceLabel,
    period: {
      precision: row.period_precision, day: row.occurred_on, month: row.occurred_month,
    },
    status: row.status,
    version: row.version,
    sourceRecordId: row.source_record_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

const appointmentBase = (row, actor, window) => {
  if (!isAppointmentId(row.id) || !isClientId(row.client_id)
    || !isSpecialistId(row.specialist_id) || !SERVICE_BY_ID[row.service_id]
    || !isCanonicalUtc(row.starts_at) || !isCanonicalUtc(row.ends_at)
    || row.starts_at < window.lower || row.starts_at >= window.upper
    || row.ends_at <= row.starts_at || row.time_zone !== 'Europe/Warsaw'
    || !['scheduled', 'completed', 'cancelled', 'noshow'].includes(row.status)
    || row.source !== 'panel' || !positive(row.version)
    || !nullableInstant(row.cancelled_at)
    || (row.status === 'cancelled') !== (row.cancelled_at !== null)
    || !isCanonicalUtc(row.created_at) || !isCanonicalUtc(row.updated_at)
    || row.created_at > row.updated_at
    || (row.cancelled_at !== null
      && (row.cancelled_at < row.created_at || row.cancelled_at > row.updated_at))
    || !isChargeId(row.charge_id)
    || row.charge_service_id !== row.service_id
    || !positive(row.expected_amount_grosze, 1_000_000)
    || row.currency !== 'PLN' || !positive(row.charge_version)) invalid()
  try { assertLocation(row.location) } catch { invalid() }
  if (!authorize(actor, 'appointment.charge.read', {
    kind: 'appointment', appointmentId: row.id, specialistId: row.specialist_id,
  }, { nowMs: 0 })) invalid()
  return row
}

const paymentDtos = (appointment, rows) => {
  const ids = new Set()
  const correctionIds = new Set()
  const replacementIds = new Set()
  for (const row of rows) {
    if (!isPaymentId(row.id) || row.appointment_id !== appointment.id
      || !positive(row.amount_grosze, 1_000_000)
      || !['cash', 'card', 'transfer', 'monthly'].includes(row.method)
      || !isCanonicalUtc(row.received_at) || !isCanonicalUtc(row.payment_created_at)
      || row.payment_created_at < appointment.created_at
      || row.payment_created_at > appointment.updated_at
      || (row.correction_id === null) !== (row.corrected_at === null)
      || (row.correction_id === null) !== (row.replacement_entry_id === null)
        && row.replacement_entry_id !== null) invalid()
    if (ids.has(row.id)) invalid()
    ids.add(row.id)
    if (row.correction_id !== null) {
      if (!isCorrectionId(row.correction_id) || !isCanonicalUtc(row.corrected_at)
        || row.corrected_at < row.payment_created_at
        || row.corrected_at > appointment.updated_at || correctionIds.has(row.correction_id)
        || (row.replacement_entry_id !== null && (!isPaymentId(row.replacement_entry_id)
          || replacementIds.has(row.replacement_entry_id)))) invalid()
      correctionIds.add(row.correction_id)
      if (row.replacement_entry_id !== null) replacementIds.add(row.replacement_entry_id)
    }
  }
  for (const row of rows) {
    if (row.replacement_entry_id !== null) {
      const replacement = rows.find((candidate) => candidate.id === row.replacement_entry_id)
      if (!replacement || replacement.appointment_id !== row.appointment_id
        || replacement.id === row.id
        || replacement.payment_created_at !== row.corrected_at) invalid()
    }
  }
  const links = new Map(rows.filter((row) => row.replacement_entry_id !== null)
    .map((row) => [row.id, row.replacement_entry_id]))
  for (const start of links.keys()) {
    const path = new Set()
    let current = start
    while (links.has(current)) {
      if (path.has(current)) invalid()
      path.add(current)
      current = links.get(current)
    }
  }
  const sorted = [...rows].sort((left, right) => left.received_at.localeCompare(right.received_at)
    || left.id.localeCompare(right.id))
  const effective = sorted.filter((row) => row.correction_id === null)
  const collected = effective.reduce((sum, row) => {
    const next = sum + row.amount_grosze
    if (!Number.isSafeInteger(next)) invalid()
    return next
  }, 0)
  if (collected < 0 || collected > appointment.expected_amount_grosze
    || (!['completed', 'noshow'].includes(appointment.status) && collected !== 0)) invalid()
  const latest = effective.at(-1) ?? null
  return freeze({
    entries: sorted.map((row) => freeze({
      id: row.id, amountGrosze: row.amount_grosze, method: row.method,
      receivedAt: row.received_at, correctedAt: row.corrected_at,
      replacementEntryId: row.replacement_entry_id,
    })),
    aggregate: {
      status: collected === 0 ? 'unpaid'
        : collected === appointment.expected_amount_grosze ? 'paid' : 'partial',
      collectedGrosze: collected,
      outstandingGrosze: ['completed', 'noshow'].includes(appointment.status)
        ? appointment.expected_amount_grosze - collected : 0,
      latestMethod: latest?.method ?? null,
      latestReceivedAt: latest?.received_at ?? null,
    },
  })
}

export async function readWorkspace(input) {
  const keys = (() => {
    try { return Reflect.ownKeys(Object.getOwnPropertyDescriptors(input)) } catch { invalid() }
  })()
  const hasCoreDecrypt = keys.includes('decryptSpecialist') || keys.includes('decryptClient')
  const hasHistoricalDecrypt = keys.includes('decryptHistoricalIdentity')
    || keys.includes('decryptHistoricalField')
  const expected = ['db', 'actor', 'cryptoContext', 'window']
  if (hasCoreDecrypt) expected.push('decryptSpecialist', 'decryptClient')
  if (hasHistoricalDecrypt) {
    expected.push('decryptHistoricalIdentity', 'decryptHistoricalField')
  }
  const captured = captureExact(input, expected)
  const actor = validActor(captured.actor)
  const window = captureExact(captured.window, ['from', 'to', 'lower', 'upper'])
  if (!DATE.test(window.from) || !DATE.test(window.to)
    || !isCanonicalUtc(window.lower) || !isCanonicalUtc(window.upper)
    || window.lower >= window.upper) invalid()
  const decryptSpecialist = captured.decryptSpecialist ?? defaultDecryptSpecialist
  const decryptClient = captured.decryptClient ?? defaultDecryptClient
  const decryptHistoricalIdentity = captured.decryptHistoricalIdentity
    ?? defaultDecryptHistoricalIdentity
  const decryptHistoricalField = captured.decryptHistoricalField ?? defaultDecryptHistoricalField
  const cryptoContext = captureExact(
    captured.cryptoContext, ['keyring', 'dataKey', 'scope'], cryptoFailure,
  )
  if (typeof decryptSpecialist !== 'function' || typeof decryptClient !== 'function'
    || typeof decryptHistoricalIdentity !== 'function'
    || typeof decryptHistoricalField !== 'function'
    || !cryptoContext.keyring || typeof cryptoContext.keyring !== 'object') invalid()
  const db = captureDb(captured.db)
  if (!authorize(actor, 'specialist.directory.read', {
    kind: 'specialist_directory', centreId: 'centre_1',
  }, { nowMs: 0 })) invalid()

  const scoped = actor.role === 'specialist'
  const historicalBindings = [
    ...(scoped ? [actor.specialistId] : []),
    window.from, window.to, window.from.slice(0, 7), window.to.slice(0, 7),
  ]
  let specialistRows
  let profileV2 = true
  try {
    specialistRows = limit(await query(
      db, directoryV2Sql(scoped), [...historicalBindings, CAPS.specialists + 1], STAFF_KEYS,
    ), 'specialists')
  } catch (error) {
    if (!/no such column: specialist\.display_name_envelope/.test(error?.message ?? '')) {
      throw error
    }
    profileV2 = false
    specialistRows = limit(await query(
      db, DIRECTORY_SQL, [CAPS.specialists + 1], STAFF_KEYS,
    ), 'specialists')
  }
  if (new Set(specialistRows.map((row) => row.id)).size !== specialistRows.length
    || new Set(specialistRows.map((row) => row.staff_id).filter(Boolean)).size
      !== specialistRows.filter((row) => row.staff_id !== null).length) invalid()
  const appointmentBindings = scoped
    ? [actor.specialistId, window.lower, window.upper, CAPS.appointments + 1]
    : [window.lower, window.upper, CAPS.appointments + 1]
  const appointmentRows = limit(await query(
    db, appointmentSql(scoped), appointmentBindings, APPOINTMENT_KEYS,
  ), 'appointments').map((row) => appointmentBase(row, actor, window))
  if (new Set(appointmentRows.map((row) => row.id)).size !== appointmentRows.length
    || new Set(appointmentRows.map((row) => row.charge_id)).size !== appointmentRows.length) invalid()
  const clientBindings = scoped
    ? [actor.specialistId, actor.specialistId, window.lower, window.upper, CAPS.clients + 1]
    : [window.lower, window.upper, CAPS.clients + 1]
  const clientRows = limit(await query(
    db, clientSql(scoped), clientBindings, CLIENT_KEYS,
  ), 'clients')
  if (new Set(clientRows.map((row) => row.id)).size !== clientRows.length) invalid()
  if (appointmentRows.some((appointment) => (
    !clientRows.some((client) => client.id === appointment.client_id)
  ))) invalid()
  const paymentBindings = scoped
    ? [actor.specialistId, window.lower, window.upper, CAPS.paymentEntries + 1]
    : [window.lower, window.upper, CAPS.paymentEntries + 1]
  const paymentRows = limit(await query(
    db, paymentSql(scoped), paymentBindings, PAYMENT_KEYS,
  ), 'paymentEntries')
  if (new Set(paymentRows.map((row) => row.id)).size !== paymentRows.length) invalid()

  const historicalOccurrenceRows = limit(await query(
    db, historicalOccurrenceSql(scoped),
    [...historicalBindings, CAPS.historicalOccurrences + 1],
    HISTORICAL_OCCURRENCE_KEYS,
  ), 'historicalOccurrences').map((row) => historicalOccurrenceBase(row, actor))
  if (new Set(historicalOccurrenceRows.map((row) => row.id)).size
      !== historicalOccurrenceRows.length
    || new Set(historicalOccurrenceRows.map((row) => row.source_record_id)).size
      !== historicalOccurrenceRows.length) invalid()
  const historicalSpecialistIds = new Set(historicalOccurrenceRows.map(
    (row) => row.specialist_id,
  ))
  const returnedSpecialistIds = new Set(specialistRows.map((row) => row.id))
  if ([...historicalSpecialistIds].some((id) => !returnedSpecialistIds.has(id))
    || specialistRows.some((row) => row.status === 'archived'
      && !historicalSpecialistIds.has(row.id))) invalid()
  const historicalClientRows = limit(await query(
    db, historicalSubjectSql({ specialist: scoped, kind: 'person' }),
    [...historicalBindings, CAPS.historicalClients + 1], HISTORICAL_CLIENT_KEYS,
  ), 'historicalClients')
  if (new Set(historicalClientRows.map((row) => row.id)).size
      !== historicalClientRows.length) invalid()
  const historicalCounterpartyRows = await query(
    db, historicalSubjectSql({ specialist: scoped, kind: 'counterparty' }),
    [...historicalBindings, CAPS.historicalOccurrences + 1],
    HISTORICAL_COUNTERPARTY_KEYS,
  )
  if (historicalCounterpartyRows.length > CAPS.historicalOccurrences) {
    throw new AppError('WORKSPACE_RESULT_LIMIT', {
      field: 'historicalOccurrences', limit: CAPS.historicalOccurrences,
    })
  }
  if (new Set(historicalCounterpartyRows.map((row) => row.id)).size
      !== historicalCounterpartyRows.length) invalid()
  const latestRows = await query(
    db, historicalLatestSql(scoped), scoped ? [actor.specialistId] : [], HISTORICAL_LATEST_KEYS,
  )
  if (latestRows.length !== 1) invalid()
  const latestPopulatedMonth = latestRows[0].latest_month
  if (latestPopulatedMonth !== null) captureHistoricalPeriod({
    precision: 'month', day: null, month: latestPopulatedMonth,
  })

  const appointmentByClient = new Map()
  for (const row of appointmentRows) {
    const values = appointmentByClient.get(row.client_id) ?? []
    values.push(row)
    appointmentByClient.set(row.client_id, values)
  }
  const specialists = await Promise.all(specialistRows.map((row) => (
    specialistDto(row, cryptoContext, decryptSpecialist, profileV2)
  )))
  const clients = await Promise.all(clientRows.map((row) => (
    clientDto(row, actor, cryptoContext, decryptClient, appointmentByClient)
  )))
  const visibleClientIds = new Set(clients.map(({ id }) => id))
  const historicalClientRecords = await Promise.all(historicalClientRows.map((row) => (
    historicalClientRecord({
      row, visibleClientIds, keyring: cryptoContext.keyring,
      decryptIdentity: decryptHistoricalIdentity,
    })
  )))
  const historicalCounterpartyRecords = await Promise.all(
    historicalCounterpartyRows.map((row) => historicalCounterpartyRecord({
      row, keyring: cryptoContext.keyring, decryptIdentity: decryptHistoricalIdentity,
    })),
  )
  const historicalClientsById = new Map(historicalClientRecords.map((record) => (
    [record.dto.id, record]
  )))
  const historicalCounterpartiesById = new Map(historicalCounterpartyRecords.map((record) => (
    [record.id, record]
  )))
  const referencedHistoricalClients = new Set(historicalOccurrenceRows
    .map((row) => row.historical_client_id).filter(Boolean))
  const referencedHistoricalCounterparties = new Set(historicalOccurrenceRows
    .map((row) => row.counterparty_id).filter(Boolean))
  if (historicalClientRecords.some((record) => !referencedHistoricalClients.has(record.dto.id))
    || historicalCounterpartyRecords.some(
      (record) => !referencedHistoricalCounterparties.has(record.id),
    )
    || [...referencedHistoricalClients].some((id) => !historicalClientsById.has(id))
    || [...referencedHistoricalCounterparties].some(
      (id) => !historicalCounterpartiesById.has(id),
    )) invalid()
  const historicalOccurrences = await Promise.all(historicalOccurrenceRows.map((row) => (
    historicalOccurrenceDto({
      row, clientsById: historicalClientsById,
      counterpartiesById: historicalCounterpartiesById,
      keyring: cryptoContext.keyring, decryptField: decryptHistoricalField,
    })
  )))
  const historicalClients = historicalClientRecords.map(({ dto }) => dto)
  const paymentsByAppointment = new Map()
  for (const row of paymentRows) {
    if (!appointmentRows.some((appointment) => appointment.id === row.appointment_id)) invalid()
    const values = paymentsByAppointment.get(row.appointment_id) ?? []
    values.push(row)
    paymentsByAppointment.set(row.appointment_id, values)
  }
  const appointments = appointmentRows.map((row) => {
    const payment = paymentDtos(row, paymentsByAppointment.get(row.id) ?? [])
    return freeze({
      id: row.id, clientId: row.client_id, specialistId: row.specialist_id,
      serviceId: row.service_id, startsAt: row.starts_at, endsAt: row.ends_at,
      timeZone: row.time_zone, location: row.location, status: row.status,
      source: row.source, version: row.version, cancelledAt: row.cancelled_at,
      createdAt: row.created_at, updatedAt: row.updated_at,
      charge: {
        id: row.charge_id, serviceId: row.charge_service_id,
        expectedAmountGrosze: row.expected_amount_grosze,
        currency: row.currency, version: row.charge_version,
      },
      payment: payment.aggregate,
      paymentEntries: payment.entries,
    })
  })
  specialists.sort((left, right) => collator.compare(left.displayName, right.displayName)
    || left.id.localeCompare(right.id))
  clients.sort((left, right) => collator.compare(left.name, right.name)
    || left.id.localeCompare(right.id))
  appointments.sort((left, right) => left.startsAt.localeCompare(right.startsAt)
    || left.id.localeCompare(right.id))
  historicalClients.sort(compareHistoricalClients)
  historicalOccurrences.sort(compareHistoricalOccurrences)
  return freeze({ data: {
    window: { from: window.from, to: window.to, timeZone: 'Europe/Warsaw', complete: true },
    specialists, clients, appointments, historicalClients, historicalOccurrences,
    latestPopulatedMonth,
  } })
}
