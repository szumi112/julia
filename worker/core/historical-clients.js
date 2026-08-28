import { auditEventStatement } from '../audit/events.js'
import { specialistPostcondition } from '../identity/specialists.js'
import { buildClientDataKey, encryptClientIdentity } from './crypto.js'
import { loadActivePractitioner } from './clients.js'
import { decryptHistoricalIdentityWithDataKey } from './historical-crypto.js'
import { decryptForScope, encryptForScope } from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'

const HISTORICAL_ID = /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const DATA_KEY_COLUMNS = Object.freeze([
  'id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64',
  'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at',
])

const fail = (code = 'HISTORICAL_ACTIVATION_INVALID') => { throw new Error(code) }
const generated = (factory, prefix, pattern) => {
  let value
  try { value = `${prefix}_${factory()}` } catch { fail() }
  if (!pattern.test(value)) fail()
  return value
}
const nowAt = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) fail()
  try { return new Date(value).toISOString() } catch { fail() }
}
const sha256 = async (value) => encodeBase64Url(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(value),
))
const keyFrom = (row) => Object.freeze(Object.fromEntries(DATA_KEY_COLUMNS.map(
  (key) => [key, row[`key_${key}`]],
)))
const historicalScope = (id) => Object.freeze({
  type: 'historical_client', id, purpose: 'identity',
})

const loadHistorical = (db, id) => db.prepare(
  `SELECT historical.id,historical.identity_envelope,historical.status,
          historical.active_client_id,historical.version,historical.created_at,
          historical.updated_at,
          key.id AS key_id,key.scope_type AS key_scope_type,key.scope_id AS key_scope_id,
          key.purpose AS key_purpose,key.dek_version AS key_dek_version,
          key.wrapped_key_b64 AS key_wrapped_key_b64,
          key.wrap_nonce_b64 AS key_wrap_nonce_b64,key.kek_version AS key_kek_version,
          key.created_at AS key_created_at,key.retired_at AS key_retired_at
   FROM historical_clients AS historical
   JOIN data_keys AS key
     ON key.id=json_extract(historical.identity_envelope,'$.dataKeyId')
    AND key.dek_version=json_extract(historical.identity_envelope,'$.dataKeyVersion')
    AND key.scope_type='historical_client' AND key.scope_id=historical.id
    AND key.purpose='identity' AND key.retired_at IS NULL
   WHERE historical.id=?`,
).bind(id).first()

const replay = (db, actorId, key) => db.prepare(
  `SELECT request_hash,response_envelope FROM historical_request_replays
   WHERE actor_staff_id=? AND operation='historical.activate' AND idempotency_key=?`,
).bind(actorId, key).first()

const openReplay = async (keyring, dataKey, historicalClientId, row) => {
  let envelope
  try { envelope = JSON.parse(row.response_envelope) } catch { fail('CRYPTO_FAILURE') }
  let value
  try {
    value = JSON.parse(await decryptForScope(keyring, dataKey, {
      expectedScope: historicalScope(historicalClientId),
      recordId: historicalClientId, field: 'activation_replay', envelope,
    }))
  } catch { fail('CRYPTO_FAILURE') }
  if (value?.status !== 201 || !value.body?.data?.historicalClient
    || !value.body?.data?.client) fail('CRYPTO_FAILURE')
  return Object.freeze(value)
}

const seal = (keyring, dataKey, scope, recordId, field, value) => encryptForScope(
  keyring, dataKey, {
    expectedScope: scope, recordId, field, plaintext: JSON.stringify(value),
  },
).then(JSON.stringify)

export async function activateHistoricalClient(input) {
  const command = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.freeze({ ...input }) : null
  const body = command?.body
  if (command && !['owner', 'coordinator'].includes(command.actor?.role)) fail('NOT_FOUND')
  if (!command?.db?.prepare || !command.db?.batch || !command.keyring
    || typeof command.actor.id !== 'string'
    || typeof command.historicalClientId !== 'string'
    || !HISTORICAL_ID.test(command.historicalClientId)
    || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 2
    || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1
    || typeof body.specialistId !== 'string' || !SPECIALIST_ID.test(body.specialistId)
    || typeof command.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(command.idempotencyKey)
    || typeof command.correlationId !== 'string'
    || !CORRELATION_ID.test(command.correlationId)
    || typeof command.idFactory !== 'function') fail()
  const now = nowAt(command.nowMs)
  const requestHash = await sha256(JSON.stringify([
    1, command.historicalClientId, body.expectedVersion, body.specialistId,
  ]))
  let historical = await loadHistorical(command.db, command.historicalClientId)
  if (!historical) fail('NOT_FOUND')
  const historicalKey = keyFrom(historical)
  const existingReplay = await replay(command.db, command.actor.id, command.idempotencyKey)
  if (existingReplay) {
    if (existingReplay.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
    return openReplay(
      command.keyring, historicalKey, command.historicalClientId, existingReplay,
    )
  }
  if (historical.status !== 'historical' || historical.version !== body.expectedVersion) {
    fail('VERSION_CONFLICT')
  }
  const specialist = await loadActivePractitioner(
    command.db, body.specialistId, command.actor,
  )
  if (!specialist) fail('NOT_FOUND')
  const name = await decryptHistoricalIdentityWithDataKey(command.keyring, {
    kind: 'person', id: historical.id, envelope: historical.identity_envelope,
    dataKey: historicalKey,
  })
  const clientId = generated(
    command.idFactory, 'cl', /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/,
  )
  const assignmentId = generated(
    command.idFactory, 'asg', /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  )
  const clientVersionId = generated(
    command.idFactory, 'ver', /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  )
  const assignmentVersionId = generated(
    command.idFactory, 'ver', /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  )
  const historicalVersionId = generated(
    command.idFactory, 'ver', /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  )
  const auditId = generated(
    command.idFactory, 'aud', /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  )
  const built = await buildClientDataKey(command.db, command.keyring, {
    clientId,
    dataKeyId: generated(command.idFactory, 'key', /^key_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/),
    createdAt: now,
  })
  const clientScope = built.scope
  const clientContext = Object.freeze({
    keyring: command.keyring, dataKey: built.row, scope: clientScope,
  })
  const identityEnvelope = await encryptClientIdentity(clientContext, {
    clientId, name, age: null,
  })
  const assignment = Object.freeze({
    id: assignmentId, specialistId: body.specialistId, startsAt: now, version: 1,
  })
  const client = Object.freeze({
    id: clientId, name, age: null, status: 'active', version: 1,
    archivedAt: null, createdAt: now, updatedAt: now, readOnly: false, assignment,
  })
  const historicalClient = Object.freeze({
    id: historical.id, name, status: 'activated', activeClientId: clientId,
    version: historical.version + 1, createdAt: historical.created_at, updatedAt: now,
  })
  const response = Object.freeze({
    status: 201,
    body: Object.freeze({ data: Object.freeze({ historicalClient, client }) }),
  })
  const clientSnapshot = {
    age: null, archivedAt: null, createdAt: now, id: clientId, name,
    schema: 'client.v1', status: 'active', updatedAt: now, version: 1,
  }
  const assignmentSnapshot = {
    assignedByStaffId: command.actor.id, clientId, createdAt: now, endsAt: null,
    id: assignmentId, schema: 'client_assignment.v1', specialistId: body.specialistId,
    startsAt: now, updatedAt: now, version: 1,
  }
  const practitionerPostcondition = specialistPostcondition(specialist.staff_user_id)
  const statements = [
    built.statement,
    command.db.prepare(`INSERT INTO clients
      (id,identity_envelope,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,'active',1,NULL,?,?)`).bind(clientId, identityEnvelope, now, now),
    command.db.prepare(`INSERT INTO client_assignments
      (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,version,
       created_at,updated_at) VALUES (?,?,?,?,NULL,?,1,?,?)`).bind(
      assignmentId, clientId, body.specialistId, now, command.actor.id, now, now,
    ),
    command.db.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,'client',?,1,?,?,?,?)`).bind(
      clientVersionId, clientId,
      await seal(command.keyring, built.row, clientScope, clientId, 'record_version',
        clientSnapshot),
      command.actor.id, now, command.correlationId,
    ),
    command.db.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,'client_assignment',?,1,?,?,?,?)`).bind(
      assignmentVersionId, assignmentId,
      await seal(command.keyring, built.row, clientScope, assignmentId, 'record_version',
        assignmentSnapshot),
      command.actor.id, now, command.correlationId,
    ),
    command.db.prepare(`UPDATE historical_clients SET status='activated',
      active_client_id=?,version=?,updated_at=?
      WHERE id=? AND status='historical' AND version=?`).bind(
      clientId, historical.version + 1, now, historical.id, historical.version,
    ),
    command.db.prepare(`INSERT INTO core_directory_invariant_failures (failure_kind)
      SELECT 'historical_activation_cas' WHERE changes()!=1 OR NOT (
        EXISTS (SELECT 1 FROM specialists AS target
          JOIN staff_users AS staff
            ON staff.id=target.staff_user_id AND staff.specialist_id=target.id
          WHERE target.id=? AND target.staff_user_id=?
            AND target.status='active' AND staff.status='active')
        AND (${practitionerPostcondition.sql})
      )`).bind(
      specialist.id, specialist.staff_user_id, ...practitionerPostcondition.bindings,
    ),
    command.db.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,'historical_client',?,?,?,?,?,?)`).bind(
      historicalVersionId, historical.id, historical.version + 1,
      await seal(command.keyring, historicalKey, historicalScope(historical.id),
        historical.id, 'snapshot', { schema: 'historical_client.v1', ...historicalClient }),
      command.actor.id, now, command.correlationId,
    ),
    auditEventStatement(command.db, {
      id: auditId, occurredAt: now, actorStaffId: command.actor.id,
      action: 'historical_client.activated', entityType: 'historical_client',
      entityId: historical.id, result: 'success', correlationId: command.correlationId,
      metadata: {
        activeClientId: clientId, activeClientVersion: 1,
        assignmentId, assignmentVersion: 1,
        historicalClientVersion: historical.version + 1,
      },
      reasonEnvelope: null,
    }),
    command.db.prepare(`INSERT INTO historical_request_replays
      (actor_staff_id,operation,idempotency_key,request_hash,import_id,
       historical_client_id,response_envelope,created_at)
      VALUES (?,'historical.activate',?,?,NULL,?,?,?)`).bind(
      command.actor.id, command.idempotencyKey, requestHash, historical.id,
      await seal(command.keyring, historicalKey, historicalScope(historical.id),
        historical.id, 'activation_replay', response),
      now,
    ),
  ]
  try {
    await command.db.batch(statements)
    return response
  } catch (error) {
    const winner = await replay(command.db, command.actor.id, command.idempotencyKey)
    if (winner) {
      if (winner.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT')
      historical = await loadHistorical(command.db, command.historicalClientId)
      return openReplay(command.keyring, keyFrom(historical), historical.id, winner)
    }
    const current = await loadHistorical(command.db, command.historicalClientId)
    if (current?.version !== historical.version || current?.status === 'activated') {
      fail('VERSION_CONFLICT')
    }
    throw error
  }
}
