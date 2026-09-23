import {
  ACTIVITY_ACTION_NAMES,
  activityForAction,
  captureActivityHistoryPayload,
  captureActivityHistoryQuery,
  formatActivityChanges,
  isActivityEventId,
} from '../../src/activity-history.js'
import { decryptClientIdentity } from '../core/crypto.js'
import { decryptActivityDetails } from '../audit/activity-history.js'
import { AppError } from '../http/errors.js'
import { captureAuthorityActor } from '../identity/authority-actor.js'
import { authorize } from '../identity/policy.js'
import { resolveCurrentAuthorityActor } from '../identity/staff.js'
import { decodeBase64Url, encodeBase64Url } from '../security/encoding.js'
import { decryptForScope } from '../security/envelope.js'

const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const CURSOR_PREFIX = 'bwm.activity-history.cursor.v1'
const MAX_OPTIONS = 1000
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
const collator = new Intl.Collator('pl-PL', { sensitivity: 'base' })
const idList = (values) => values.map(() => '?').join(',')
const fail = () => { throw new AppError('INTERNAL_ERROR') }
const validation = () => { throw new AppError('VALIDATION_FAILED') }
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const keyRow = (row) => ({
  id: row.key_id,
  scope_type: row.scope_type,
  scope_id: row.scope_id,
  purpose: row.purpose,
  dek_version: row.dek_version,
  wrapped_key_b64: row.wrapped_key_b64,
  wrap_nonce_b64: row.wrap_nonce_b64,
  kek_version: row.kek_version,
  created_at: row.key_created_at,
  retired_at: row.retired_at,
})
const keyColumns = (alias) => `
  ${alias}.id AS key_id,${alias}.scope_type,${alias}.scope_id,${alias}.purpose,
  ${alias}.dek_version,${alias}.wrapped_key_b64,${alias}.wrap_nonce_b64,
  ${alias}.kek_version,${alias}.created_at AS key_created_at,${alias}.retired_at`

function checkedRows(result, maximum) {
  if (!result || !Array.isArray(result.results) || result.results.length > maximum) fail()
  return result.results
}

function warsawMidnight(day) {
  const [year, month, date] = day.split('-').map(Number)
  const wall = Date.UTC(year, month - 1, date)
  let guess = wall - 3_600_000
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(guess))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]))
    const actualWall = Date.UTC(parts.year, parts.month - 1, parts.day,
      parts.hour, parts.minute, parts.second)
    guess -= actualWall - wall
  }
  const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(guess))
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, Number(value)]))
  if (parts.year !== year || parts.month !== month || parts.day !== date
    || parts.hour !== 0 || parts.minute !== 0 || parts.second !== 0) fail()
  return new Date(guess).toISOString()
}

function nextDay(day) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date) + 86_400_000)
    .toISOString().slice(0, 10)
}

function parseQuery(params) {
  if (!(params instanceof URLSearchParams)) validation()
  const object = {}
  for (const [key, value] of params.entries()) {
    if (Object.hasOwn(object, key)) validation()
    object[key] = key === 'limit' && /^(?:[1-9]|[1-9]\d|100)$/.test(value)
      ? Number(value) : value
  }
  try { return captureActivityHistoryQuery(object) } catch { validation() }
}

async function filterHash(query) {
  const canonical = {
    actor: query.actor, client: query.client, kind: query.kind,
    from: query.from, to: query.to, limit: query.limit,
  }
  const bytes = new TextEncoder().encode(JSON.stringify(canonical))
  try { return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) }
  finally { bytes.fill(0) }
}

async function cursorMac(key, version, encoded) {
  const bytes = new TextEncoder().encode(`${CURSOR_PREFIX}\n${version}\n${encoded}`)
  try { return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes)) }
  finally { bytes.fill(0) }
}

async function decodeCursor(context, token, expectedFilterHash) {
  const segments = token.split('.')
  if (segments.length !== 4 || segments[0] !== 'v1'
    || !/^[1-9]\d*$/.test(segments[1])
    || String(Number(segments[1])) !== segments[1]
    || !Number.isSafeInteger(Number(segments[1]))
    || segments[2].length > 512 || segments[3].length !== 43) validation()
  const version = Number(segments[1])
  const key = context.keyring.getLookupHmac(version)
  if (!key) validation()
  let signature
  let expected
  let positionBytes
  try {
    signature = decodeBase64Url(segments[3])
    positionBytes = decodeBase64Url(segments[2])
    if (signature.byteLength !== 32 || positionBytes.byteLength > 384) validation()
    expected = await cursorMac(key, version, segments[2])
    let difference = 0
    for (let index = 0; index < 32; index += 1) difference |= signature[index] ^ expected[index]
    if (difference !== 0) validation()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(positionBytes)
    const position = JSON.parse(text)
    if (!position || Object.getPrototypeOf(position) !== Object.prototype
      || Object.keys(position).length !== 3
      || !['id', 'occurredAt', 'filterHash'].every((name) => Object.hasOwn(position, name))
      || !isActivityEventId(position.id)
      || !validInstant(position.occurredAt)
      || position.filterHash !== expectedFilterHash
      || JSON.stringify(position) !== text) validation()
    return position
  } catch { validation() } finally {
    signature?.fill(0)
    expected?.fill(0)
    positionBytes?.fill(0)
  }
}

async function encodeCursor(context, row, currentFilterHash) {
  const version = context.keyring.activeLookupKeyVersion
  const key = context.keyring.getLookupHmac(version)
  if (!Number.isSafeInteger(version) || version < 1 || !key) fail()
  const bytes = new TextEncoder().encode(JSON.stringify({
    id: row.id, occurredAt: row.occurred_at, filterHash: currentFilterHash,
  }))
  let mac
  try {
    const encoded = encodeBase64Url(bytes)
    mac = await cursorMac(key, version, encoded)
    return `v1.${version}.${encoded}.${encodeBase64Url(mac)}`
  } finally {
    bytes.fill(0)
    mac?.fill(0)
  }
}

async function currentActor(db, actor, nowMs) {
  const captured = captureAuthorityActor(actor)
  if (!captured || !authorize(captured, 'activity.read', CENTRE, { nowMs })) {
    throw new AppError('FORBIDDEN')
  }
  const current = await resolveCurrentAuthorityActor(db, {
    id: captured.id, role: captured.role,
    specialist_id: captured.specialistId, version: captured.version,
  })
  if (current.authorityRevision !== captured.authorityRevision
    || JSON.stringify(current.capabilities) !== JSON.stringify(captured.capabilities)
    || !authorize(current, 'activity.read', CENTRE, { nowMs })) {
    throw new AppError('FORBIDDEN')
  }
  return current
}

async function actorOptions(db, context) {
  const result = await db.prepare(
    `SELECT staff.id,staff.display_name_envelope
     FROM staff_users AS staff
     WHERE EXISTS (
       SELECT 1 FROM audit_events AS audit
       WHERE audit.actor_staff_id=staff.id AND audit.result='success'
         AND audit.action IN (${idList(ACTIVITY_ACTION_NAMES)})
     )
     ORDER BY staff.id LIMIT ?`,
  ).bind(...ACTIVITY_ACTION_NAMES, MAX_OPTIONS + 1).all()
  const rows = checkedRows(result, MAX_OPTIONS + 1)
  if (rows.length > MAX_OPTIONS) throw new AppError('ACTIVITY_RESULT_LIMIT')
  const options = await Promise.all(rows.map(async (row) => ({
    id: row.id,
    label: await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope, recordId: row.id,
      field: 'display_name', envelope: JSON.parse(row.display_name_envelope),
    }),
  })))
  return options.sort((left, right) => collator.compare(left.label, right.label)
    || left.id.localeCompare(right.id))
}

async function clientOptions(db, context) {
  const actions = ACTIVITY_ACTION_NAMES
  const where = `audit.result='success' AND audit.actor_staff_id IS NOT NULL
    AND audit.action IN (${idList(actions)})`
  const result = await db.prepare(
    `WITH referenced_clients(client_id) AS (
       SELECT audit.entity_id FROM audit_events AS audit
       WHERE ${where} AND audit.entity_type='client'
       UNION
       SELECT appointment.client_id FROM audit_events AS audit
       JOIN appointments AS appointment ON appointment.id=audit.entity_id
       WHERE ${where} AND audit.entity_type='appointment'
       UNION
       SELECT appointment.client_id FROM audit_events AS audit
       JOIN payment_entries AS payment ON payment.id=audit.entity_id
       JOIN appointments AS appointment ON appointment.id=payment.appointment_id
       WHERE ${where} AND audit.entity_type='payment_entry'
     )
     SELECT client.id AS client_id,client.identity_envelope,${keyColumns('data_key')}
     FROM referenced_clients AS reference
     JOIN clients AS client ON client.id=reference.client_id
     LEFT JOIN data_keys AS data_key
       ON data_key.id=json_extract(client.identity_envelope,'$.dataKeyId')
      AND data_key.dek_version=json_extract(client.identity_envelope,'$.dataKeyVersion')
      AND data_key.scope_type='client' AND data_key.scope_id=client.id
      AND data_key.purpose='identity'
     ORDER BY client.id LIMIT ?`,
  ).bind(...actions, ...actions, ...actions, MAX_OPTIONS + 1).all()
  const rows = checkedRows(result, MAX_OPTIONS + 1)
  if (rows.length > MAX_OPTIONS) throw new AppError('ACTIVITY_RESULT_LIMIT')
  const options = await Promise.all(rows.map(async (row) => {
    if (!row.key_id) fail()
    const scope = { type: 'client', id: row.client_id, purpose: 'identity' }
    const identity = await decryptClientIdentity({
      keyring: context.keyring, dataKey: keyRow(row), scope,
    }, { clientId: row.client_id, envelope: row.identity_envelope })
    return { id: row.client_id, label: identity.name }
  }))
  return options.sort((left, right) => collator.compare(left.label, right.label)
    || left.id.localeCompare(right.id))
}

const clientIdSql = `CASE
  WHEN audit.entity_type='client' THEN audit.entity_id
  WHEN audit.entity_type='appointment' THEN appointment.client_id
  WHEN audit.entity_type='payment_entry' THEN payment_appointment.client_id
  ELSE NULL END`

async function page(db, query, cursor) {
  const actions = query.kind === null ? ACTIVITY_ACTION_NAMES
    : ACTIVITY_ACTION_NAMES.filter((action) => activityForAction(action).kind === query.kind)
  const conditions = [
    "audit.result='success'", 'audit.actor_staff_id IS NOT NULL',
    `audit.action IN (${idList(actions)})`,
  ]
  const binds = [...actions]
  if (query.actor) { conditions.push('audit.actor_staff_id=?'); binds.push(query.actor) }
  if (query.client) { conditions.push(`${clientIdSql}=?`); binds.push(query.client) }
  if (query.from) { conditions.push('audit.occurred_at>=?'); binds.push(warsawMidnight(query.from)) }
  if (query.to) { conditions.push('audit.occurred_at<?'); binds.push(warsawMidnight(nextDay(query.to))) }
  if (cursor) {
    conditions.push('(audit.occurred_at<? OR (audit.occurred_at=? AND audit.id<?))')
    binds.push(cursor.occurredAt, cursor.occurredAt, cursor.id)
  }
  const result = await db.prepare(
    `SELECT audit.id,audit.occurred_at,audit.actor_staff_id,audit.action,
            ${clientIdSql} AS client_id,
            details.scope_type AS detail_scope_type,
            details.scope_id AS detail_scope_id,
            details.scope_purpose AS detail_scope_purpose,
            details.details_envelope,${keyColumns('data_key')}
     FROM audit_events AS audit
     LEFT JOIN appointments AS appointment
       ON audit.entity_type='appointment' AND appointment.id=audit.entity_id
     LEFT JOIN payment_entries AS payment
       ON audit.entity_type='payment_entry' AND payment.id=audit.entity_id
     LEFT JOIN appointments AS payment_appointment
       ON payment_appointment.id=payment.appointment_id
     LEFT JOIN activity_history_details AS details ON details.audit_id=audit.id
     LEFT JOIN data_keys AS data_key
       ON data_key.id=json_extract(details.details_envelope,'$.dataKeyId')
      AND data_key.dek_version=json_extract(details.details_envelope,'$.dataKeyVersion')
      AND data_key.scope_type=details.scope_type AND data_key.scope_id=details.scope_id
      AND data_key.purpose=details.scope_purpose
     WHERE ${conditions.join(' AND ')}
     ORDER BY audit.occurred_at DESC,audit.id DESC LIMIT ?`,
  ).bind(...binds, query.limit + 1).all()
  return checkedRows(result, query.limit + 1)
}

async function specialistNames(db, context, changes) {
  const ids = [...new Set(changes.flatMap((change) => change
    .filter(({ field }) => field === 'specialist')
    .flatMap(({ before, after }) => [before, after].filter(Boolean))))]
  if (ids.length === 0) return new Map()
  if (ids.length > 200) fail()
  const rows = checkedRows(await db.prepare(
    `SELECT id,display_name_envelope FROM specialists
     WHERE id IN (${idList(ids)}) LIMIT ?`,
  ).bind(...ids, ids.length + 1).all(), ids.length)
  return new Map(await Promise.all(rows.map(async (row) => [
    row.id,
    await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope, recordId: row.id,
      field: 'display_name', envelope: JSON.parse(row.display_name_envelope),
    }),
  ])))
}

async function detailsFor(row, context) {
  if (row.details_envelope === null) return []
  const info = activityForAction(row.action)
  const clientScope = info.kind === 'appointment' || info.kind === 'payment'
  const scope = clientScope
    ? { type: 'client', id: row.client_id, purpose: 'identity' }
    : { type: 'centre_finance', id: 'centre_1', purpose: 'ledger' }
  if ((clientScope && (!row.client_id || row.detail_scope_type !== scope.type
    || row.detail_scope_id !== scope.id || row.detail_scope_purpose !== scope.purpose))
    || (!clientScope && (info.kind !== 'finance' || row.detail_scope_type !== scope.type
      || row.detail_scope_id !== scope.id || row.detail_scope_purpose !== scope.purpose))
    || !row.key_id) fail()
  return decryptActivityDetails({
    keyring: context.keyring, dataKey: keyRow(row), scope,
    auditId: row.id, action: row.action, envelope: row.details_envelope,
  })
}

export async function listActivityHistory(input) {
  if (!input?.db?.prepare || !input.cryptoContext?.keyring
    || !input.cryptoContext?.dataKey || !input.cryptoContext?.scope
    || !Number.isSafeInteger(input.nowMs)) fail()
  await currentActor(input.db, input.actor, input.nowMs)
  const query = parseQuery(input.query)
  const hash = await filterHash(query)
  const cursor = query.cursor === null ? null
    : await decodeCursor(input.cryptoContext, query.cursor, hash)
  const [actors, clients] = await Promise.all([
    actorOptions(input.db, input.cryptoContext),
    clientOptions(input.db, input.cryptoContext),
  ])
  const rows = await page(input.db, query, cursor)
  const visible = rows.slice(0, query.limit)
  const rawDetails = await Promise.all(visible.map((row) => detailsFor(row, input.cryptoContext)))
  const specialists = await specialistNames(input.db, input.cryptoContext, rawDetails)
  const actorNames = new Map(actors.map(({ id, label }) => [id, label]))
  const clientNames = new Map(clients.map(({ id, label }) => [id, label]))
  const items = visible.map((row, index) => {
    const info = activityForAction(row.action)
    const actorName = actorNames.get(row.actor_staff_id)
    if (!info || !actorName || !validInstant(row.occurred_at)
      || (row.client_id !== null && !clientNames.has(row.client_id))) fail()
    return {
      id: row.id, occurredAt: row.occurred_at, kind: info.kind,
      actorName, clientName: row.client_id === null ? null : clientNames.get(row.client_id),
      summary: info.summary,
      details: formatActivityChanges(rawDetails[index], specialists),
    }
  })
  const payload = {
    items,
    nextCursor: rows.length > query.limit
      ? await encodeCursor(input.cryptoContext, visible.at(-1), hash) : null,
    filters: { actors, clients },
  }
  try { return { data: captureActivityHistoryPayload(payload) } } catch { fail() }
}
