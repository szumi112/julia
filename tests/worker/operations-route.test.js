import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  getOperationalHealth,
  listOpenOperationalActions,
  listSecurityAudit,
  resolveOperationalAction,
} from '../../worker/routes/operations.js'
import {
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { decodeBase64Url, encodeBase64Url } from '../../worker/security/encoding.js'

const NOW_MS = Date.parse('2042-07-31T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const CORRELATION_ID = '11111111-1111-4111-8111-111111111111'
const SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})
let fixtureSerial = 0

const ids = (prefix = 'generated') => {
  let count = 0
  return () => `${prefix}_${++count}`
}

function singleReadObject(source, marker) {
  const reads = new Map()
  const object = {}
  for (const key of Reflect.ownKeys(source)) {
    Object.defineProperty(object, key, {
      enumerable: true,
      configurable: true,
      get() {
        const count = (reads.get(key) ?? 0) + 1
        reads.set(key, count)
        if (count > 1) throw new Error(`${marker}:${String(key)}`)
        return source[key]
      },
    })
  }
  return { object, reads }
}

async function cryptoContext() {
  const keyring = await createKeyring(env, {
    activeBackupKekVersion: 1,
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_operations_gate_e',
    createdAt: NOW,
  })
  return { keyring, dataKey, scope: SCOPE }
}

async function cryptoContextWithLookup({ activeVersion = 2, includeVersion1 = true } = {}) {
  const bindings = {
    BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    BWM_LOOKUP_HMAC_V2: encodeBase64Url(new Uint8Array(32).fill(9)),
    ...(includeVersion1
      ? { BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ' }
      : {}),
  }
  const keyring = await createKeyring(bindings, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: activeVersion,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_operations_gate_e',
    createdAt: NOW,
  })
  return { keyring, dataKey, scope: SCOPE }
}

async function cryptoContextWithLookupCount(count) {
  const bindings = {
    BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }
  const raw = new Uint8Array(32)
  try {
    for (let version = 1; version <= count; version += 1) {
      raw.fill((version % 251) + 1)
      bindings[`BWM_LOOKUP_HMAC_V${version}`] = encodeBase64Url(raw)
    }
  } finally {
    raw.fill(0)
  }
  const keyring = await createKeyring(bindings, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: count,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_operations_gate_e',
    createdAt: NOW,
  })
  return { keyring, dataKey, scope: SCOPE }
}

function cryptoContextWithKeys(context, { dataKek, lookupKey }) {
  const dataKekVersion = context.dataKey.kek_version
  const lookupVersion = context.keyring.activeLookupKeyVersion
  return {
    ...context,
    keyring: {
      activeLookupKeyVersion: lookupVersion,
      lookupKeyVersions: [lookupVersion],
      getDataKek: (version) => version === dataKekVersion ? dataKek : null,
      getLookupHmac: (version) => version === lookupVersion ? lookupKey : null,
    },
  }
}

async function seedActiveActor({
  id = 'stf_operations_owner',
  role = 'owner',
  specialistId = role === 'specialist' ? `sp_${id}` : null,
  version = 1,
} = {}) {
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,?,?,?,?,?)`
  ).bind(
    id,
    `lookup_${id}`,
    '{}',
    '{}',
    role,
    `subject_${id}`,
    specialistId,
    version,
    NOW,
    NOW,
    NOW,
  ).run()
  return { id, role, specialistId, version }
}

const commonInput = (actor, context, changes = {}) => ({
  db: env.DB,
  cryptoContext: context,
  actor,
  nowMs: NOW_MS,
  correlationId: CORRELATION_ID,
  idFactory: ids('aud_operations'),
  ...changes,
})

async function denialRows(actorId) {
  return (await env.DB.prepare(
    `SELECT id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
            reason_envelope,correlation_id,metadata_json
     FROM audit_events WHERE actor_staff_id=? AND action='authorization.denied'
     ORDER BY id`
  ).bind(actorId).all()).results
}

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])
  )
  return value
}

const canonicalJson = (value) => JSON.stringify(canonicalValue(value))

const validSnapshot = (generatedAt = NOW) => ({
  generatedAt,
  checks: [
    {
      id: 'outbox.processing',
      label: 'Kolejka zadań',
      status: 'ok',
      lastSuccessAt: generatedAt,
      detailCode: 'OUTBOX_HEALTHY',
    },
    {
      id: 'backup.freshness',
      label: 'Kopie zapasowe',
      status: 'warning',
      lastSuccessAt: null,
      detailCode: 'BACKUP_PENDING',
    },
    {
      id: 'access.reconciliation',
      label: 'Synchronizacja dostępu',
      status: 'critical',
      lastSuccessAt: generatedAt,
      detailCode: 'ACCESS_RECONCILIATION_LAG',
    },
    {
      id: 'scheduler.runs',
      label: 'Zadania cykliczne',
      status: 'ok',
      lastSuccessAt: generatedAt,
      detailCode: 'SCHEDULER_HEALTHY',
    },
  ],
})

async function seedHealthSnapshot(snapshot = validSnapshot(), {
  version = 1,
  updatedAt = snapshot.generatedAt,
  valueJson = canonicalJson(snapshot),
} = {}) {
  const existing = await env.DB.prepare(
    "SELECT version FROM system_state WHERE key='health.snapshot'"
  ).first()
  if (existing) {
    await env.DB.prepare(
      `UPDATE system_state
       SET value_json=?,version=version+1,updated_at=?
       WHERE key='health.snapshot' AND version=?`
    ).bind(valueJson, updatedAt, existing.version).run()
    return {
      key: 'health.snapshot',
      value_json: valueJson,
      version: existing.version + 1,
      updated_at: updatedAt,
    }
  }
  await env.DB.prepare(
    `INSERT INTO system_state (key,value_json,version,updated_at)
     VALUES ('health.snapshot',?,?,?)`
  ).bind(valueJson, version, updatedAt).run()
  return { key: 'health.snapshot', value_json: valueJson, version, updated_at: updatedAt }
}

function facade(real, hooks = {}) {
  const statement = (inner, sql, bindings = []) => ({
    __inner: inner,
    __sql: sql,
    __bindings: bindings,
    bind(...values) { return statement(inner.bind(...values), sql, values) },
    run: () => inner.run(),
    first: (column) => inner.first(column),
    async all() {
      const replacement = await hooks.all?.(sql, bindings)
      return replacement === undefined ? inner.all() : replacement
    },
  })
  return {
    prepare(sql) { return statement(real.prepare(sql), sql) },
    batch(statements) {
      const run = hooks.batch?.(statements)
      if (run !== undefined) return run
      return real.batch(statements.map((item) => item.__inner ?? item))
    },
  }
}

const storedActorRow = (actor) => ({
  id: actor.id,
  role: actor.role,
  status: 'active',
  specialist_id: actor.specialistId,
  version: actor.version,
})

function singleReadAllResult(rows, marker) {
  let resultsReads = 0
  let lengthReads = 0
  let mutations = 0
  const entryReads = new Map()
  const results = new Proxy([...rows], {
    get(target, property, receiver) {
      if (property === 'length') {
        lengthReads += 1
        if (lengthReads > 1) throw new Error(`${marker}:length`)
      } else if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)) {
        const count = (entryReads.get(property) ?? 0) + 1
        entryReads.set(property, count)
        if (count > 1) throw new Error(`${marker}:entry:${property}`)
      }
      return Reflect.get(target, property, receiver)
    },
    set() {
      mutations += 1
      throw new Error(`${marker}:set`)
    },
    defineProperty() {
      mutations += 1
      throw new Error(`${marker}:define`)
    },
    deleteProperty() {
      mutations += 1
      throw new Error(`${marker}:delete`)
    },
  })
  const wrapper = { success: true, meta: { duration: 0 } }
  Object.defineProperty(wrapper, 'results', {
    enumerable: true,
    configurable: true,
    get() {
      resultsReads += 1
      if (resultsReads > 1) throw new Error(`${marker}:results`)
      return results
    },
  })
  return {
    wrapper,
    reads: () => ({ entryReads, lengthReads, mutations, resultsReads }),
  }
}

function throwingAllResult(marker) {
  const error = new Error(marker)
  const wrapper = { success: false }
  Object.defineProperty(wrapper, 'results', {
    enumerable: true,
    configurable: true,
    get() { throw error },
  })
  return { error, wrapper }
}

async function actionEnvelope(context, id, details, plaintext = canonicalJson(details)) {
  return JSON.stringify(await encryptForScope(context.keyring, context.dataKey, {
    expectedScope: context.scope,
    recordId: id,
    field: 'action_details',
    plaintext,
  }))
}

async function actionRow(context, {
  id,
  fingerprint,
  kind,
  severity,
  entityType,
  entityId,
  details,
  createdAt = NOW,
  status = 'open',
  version = status === 'open' ? 1 : 2,
  updatedAt = status === 'open' ? createdAt : NOW,
  resolvedAt = status === 'open' ? null : updatedAt,
  plaintext,
}) {
  return {
    id,
    fingerprint,
    kind,
    severity,
    status,
    entity_type: entityType,
    entity_id: entityId,
    details_envelope: await actionEnvelope(context, id, details, plaintext),
    version,
    created_at: createdAt,
    updated_at: updatedAt,
    resolved_at: resolvedAt,
  }
}

const ACTION_FACTS = Object.freeze([
  Object.freeze({
    id: 'act_access_lag',
    fingerprint: 'access.reconciliation_lag',
    kind: 'access_reconciliation_lag',
    severity: 'critical',
    entityType: 'access_group',
    entityId: 'centre_1',
    details: Object.freeze({
      appliedGeneration: 2,
      desiredGeneration: 3,
      errorCode: 'ACCESS_RECONCILIATION_LAG',
    }),
  }),
  Object.freeze({
    id: 'act_denial_spike',
    fingerprint: 'security.authorization_denials:stf_target:staff.manage',
    kind: 'authorization_denial_spike',
    severity: 'warning',
    entityType: 'staff_user',
    entityId: 'stf_target',
    details: Object.freeze({
      actorId: 'stf_target',
      capability: 'staff.manage',
      count: 10,
      errorCode: 'AUTHORIZATION_DENIAL_SPIKE',
      threshold: 10,
    }),
  }),
  Object.freeze({
    id: 'act_backup_failed',
    fingerprint: 'backup.failed:bkp_failed_1',
    kind: 'backup_failed',
    severity: 'critical',
    entityType: 'backup_run',
    entityId: 'bkp_failed_1',
    details: Object.freeze({ backupId: 'bkp_failed_1', errorCode: 'BACKUP_FAILED' }),
  }),
  Object.freeze({
    id: 'act_backup_stale',
    fingerprint: 'backup.stale',
    kind: 'backup_stale',
    severity: 'critical',
    entityType: 'centre',
    entityId: 'centre_1',
    details: Object.freeze({ errorCode: 'BACKUP_STALE', thresholdHours: 36 }),
  }),
  Object.freeze({
    id: 'act_outbox_dead',
    fingerprint: 'outbox.dead:job_dead_1',
    kind: 'outbox_job_failed',
    severity: 'critical',
    entityType: 'outbox_job',
    entityId: 'job_dead_1',
    details: Object.freeze({
      errorCode: 'OUTBOX_HANDLER_RETRY',
      jobId: 'job_dead_1',
      outboxType: 'staff.invitation.expire',
    }),
  }),
  Object.freeze({
    id: 'act_scheduler_stale',
    fingerprint: 'scheduler.stale',
    kind: 'scheduler_stale',
    severity: 'critical',
    entityType: 'scheduler_run',
    entityId: 'scheduler_run_1',
    details: Object.freeze({
      errorCode: 'SCHEDULER_STALE',
      schedulerRunId: 'scheduler_run_1',
      thresholdMinutes: 15,
    }),
  }),
])

const DENIAL_OVERFLOW_FACT = Object.freeze({
  id: 'act_denial_overflow',
  fingerprint: 'security.authorization_denials:overflow',
  kind: 'authorization_denial_spike',
  severity: 'critical',
  entityType: 'centre',
  entityId: 'centre_1',
  details: Object.freeze({
    errorCode: 'AUTHORIZATION_DENIAL_OVERFLOW',
    minimumCount: 101,
    threshold: 100,
    windowMinutes: 15,
  }),
})

async function actionRows(context, facts = ACTION_FACTS) {
  return Promise.all(facts.map((fact, index) => actionRow(context, {
    ...fact,
    createdAt: new Date(NOW_MS - index).toISOString(),
  })))
}

async function insertAction(row) {
  await env.DB.prepare(
    `INSERT INTO operational_actions
     (id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
      version,created_at,updated_at,resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    row.id,
    row.fingerprint,
    row.kind,
    row.severity,
    row.status,
    row.entity_type,
    row.entity_id,
    row.details_envelope,
    row.version,
    row.created_at,
    row.updated_at,
    row.resolved_at,
  ).run()
  return row
}

async function reasonEnvelope(context, id, plaintext = 'reason-not-readable') {
  return JSON.stringify(await encryptForScope(context.keyring, context.dataKey, {
    expectedScope: context.scope,
    recordId: id,
    field: 'wrong_aad_on_purpose',
    plaintext,
  }))
}

const AUDIT_FACTS = Object.freeze([
  Object.freeze({ action: 'authorization.denied', entityType: 'staff_user', entityId: 'stf_audit_target', result: 'denied', metadata: { version: 1 }, actorStaffId: 'stf_audit_actor', encryptedReason: true }),
  Object.freeze({ action: 'backup.pruned', entityType: 'backup_run', entityId: 'bkp_audit_pruned', result: 'success', metadata: { backupVersion: 2 }, actorStaffId: null }),
  Object.freeze({ action: 'data_key.rewrapped', entityType: 'data_key', entityId: 'key_audit', result: 'success', metadata: { newKekVersion: 2, oldKekVersion: 1 }, actorStaffId: 'stf_audit_actor' }),
  Object.freeze({ action: 'identity.activation', entityType: 'staff_user', entityId: 'stf_audit_target', result: 'success', metadata: { invitationVersion: 2, specialistVersion: 1, staffVersion: 2 }, actorStaffId: 'stf_audit_actor' }),
  Object.freeze({ action: 'identity.denied', entityType: 'staff_user', entityId: 'stf_audit_target', result: 'denied', metadata: { version: 2 }, actorStaffId: 'stf_audit_actor' }),
  Object.freeze({ action: 'identity.reindex', entityType: 'staff_invitation', entityId: 'inv_audit', result: 'success', metadata: { version: 2 }, actorStaffId: 'stf_audit_actor' }),
  Object.freeze({ action: 'operational_action.resolved', entityType: 'operational_action', entityId: 'act_audit', result: 'success', metadata: { actionVersion: 2 }, actorStaffId: 'stf_audit_actor' }),
  Object.freeze({ action: 'staff.access.reconciled', entityType: 'access_group', entityId: 'centre_1', result: 'success', metadata: { appliedGeneration: 2, desiredGeneration: 2, invitationCount: 0 }, actorStaffId: 'stf_audit_actor' }),
  Object.freeze({ action: 'staff.bootstrap', entityType: 'staff_user', entityId: 'stf_audit_target', result: 'success', metadata: { desiredGeneration: 1, invitationVersion: 1, specialistVersion: null, staffVersion: 1 }, actorStaffId: null }),
  Object.freeze({ action: 'staff.deactivated', entityType: 'staff_user', entityId: 'stf_audit_target', result: 'success', metadata: { desiredGeneration: 2, specialistVersion: 2, staffVersion: 2 }, actorStaffId: 'stf_audit_actor' }),
  Object.freeze({ action: 'staff.invitation.email_accepted', entityType: 'staff_invitation', entityId: 'inv_audit', result: 'success', metadata: { invitationVersion: 2 }, actorStaffId: 'stf_audit_actor' }),
  Object.freeze({ action: 'staff.invitation.expired', entityType: 'staff_invitation', entityId: 'inv_audit', result: 'success', metadata: { desiredGeneration: 2, invitationVersion: 2, specialistVersion: null, staffVersion: 2 }, actorStaffId: 'stf_audit_actor' }),
  Object.freeze({ action: 'staff.invited', entityType: 'staff_invitation', entityId: 'inv_audit', result: 'success', metadata: { desiredGeneration: 2, invitationVersion: 1, specialistVersion: 1, staffVersion: 1 }, actorStaffId: 'stf_audit_actor' }),
  Object.freeze({ action: 'specialist.backfilled', entityType: 'specialist', entityId: 'sp_audit_backfilled', result: 'success', metadata: { specialistVersion: 1, stateVersion: 2 }, actorStaffId: null }),
  Object.freeze({ action: 'core_directory.upgrade.advanced', entityType: 'system_state', entityId: 'core_directory_specialist_backfill_v1', result: 'success', metadata: { createdCount: 0, processedCount: 1, stateVersion: 2 }, actorStaffId: null }),
])

async function auditRow(context, fact, index = 0, changes = {}) {
  const id = changes.id ?? `audit_event_${String(index).padStart(3, '0')}`
  return {
    id,
    occurred_at: changes.occurred_at ?? new Date(NOW_MS - index).toISOString(),
    actor_staff_id: Object.hasOwn(changes, 'actor_staff_id')
      ? changes.actor_staff_id
      : fact.actorStaffId,
    action: changes.action ?? fact.action,
    entity_type: changes.entity_type ?? fact.entityType,
    entity_id: changes.entity_id ?? fact.entityId,
    result: changes.result ?? fact.result,
    reason_envelope: Object.hasOwn(changes, 'reason_envelope')
      ? changes.reason_envelope
      : fact.encryptedReason
        ? await reasonEnvelope(context, id)
        : null,
    correlation_id: changes.correlation_id ?? `stored_correlation_${index}`,
    metadata_json: changes.metadata_json ?? canonicalJson(fact.metadata),
    ...(changes.extra === undefined ? {} : { extra: changes.extra }),
  }
}

async function signedCursor(context, positionText, version = context.keyring.activeLookupKeyVersion) {
  const positionBytes = new TextEncoder().encode(positionText)
  try {
    return await signedCursorBytes(context, positionBytes, version)
  } finally {
    positionBytes.fill(0)
  }
}

async function signedCursorBytes(context, positionBytes, version = context.keyring.activeLookupKeyVersion) {
  const position = encodeBase64Url(positionBytes)
  const input = new TextEncoder().encode(
    `bwm.security-audit.cursor.v1\n${version}\n${position}`
  )
  const mac = new Uint8Array(await crypto.subtle.sign(
    'HMAC', context.keyring.getLookupHmac(version), input,
  ))
  input.fill(0)
  const token = `v1.${version}.${position}.${encodeBase64Url(mac)}`
  mac.fill(0)
  return token
}

const resolutionInput = (actor, context, actionId, changes = {}) => commonInput(actor, context, {
  actionId,
  idempotencyKey: 'resolve-key',
  body: { version: 1 },
  ...changes,
})

async function caught(promise) {
  try {
    await promise
    throw new Error('EXPECTED_REJECTION')
  } catch (error) {
    return error
  }
}

describe('operations route services', () => {
  it('exports the four Gate E services', () => {
    expect(getOperationalHealth).toBeTypeOf('function')
    expect(listOpenOperationalActions).toBeTypeOf('function')
    expect(resolveOperationalAction).toBeTypeOf('function')
    expect(listSecurityAudit).toBeTypeOf('function')
  })

  it.each([
    ['health', getOperationalHealth, []],
    ['actions', listOpenOperationalActions, []],
    ['resolution', resolveOperationalAction, ['actionId', 'idempotencyKey', 'body']],
    ['audit', listSecurityAudit, ['query']],
  ])('rejects malformed exact service inputs for %s before D1', async (_label, service, extraKeys) => {
    const actor = { id: 'stf_input', role: 'owner', specialistId: null, version: 1 }
    const context = await cryptoContext()
    const extras = extraKeys.includes('query')
      ? { query: new URLSearchParams() }
      : extraKeys.length
        ? { actionId: 'action_1', idempotencyKey: 'resolve-key', body: { version: 1 } }
        : {}
    const valid = commonInput(actor, context, extras)
    const invalid = [
      null,
      { ...valid, extra: true },
      Object.assign(Object.create({ inherited: true }), valid),
      { ...valid, db: { prepare() {} } },
      { ...valid, actor: { ...actor, status: 'active' } },
      { ...valid, nowMs: -1 },
      { ...valid, correlationId: 'opaque-but-not-uuid' },
      { ...valid, idFactory: 'not-a-function' },
      { ...valid, cryptoContext: { ...context, scope: { ...SCOPE, id: 'other' } } },
      {
        ...valid,
        cryptoContext: {
          ...context,
          keyring: {
            activeLookupKeyVersion: 1,
            lookupKeyVersions: [1],
            getDataKek: () => ({}),
            getLookupHmac: () => ({}),
          },
        },
      },
    ]
    for (const input of invalid) {
      await expect(service(input)).rejects.toThrow(/^OPERATIONS_INVALID$/)
    }
  })

  it('accepts 65 loaded canonical lookup keys in all four service contexts', async () => {
    const context = await cryptoContextWithLookupCount(65)
    const actor = { id: 'stf_lookup_65', role: 'owner', specialistId: null, version: 1 }
    const services = [
      ['health', getOperationalHealth, {}, 'FROM system_state'],
      ['actions', listOpenOperationalActions, {}, 'FROM operational_actions'],
      ['resolution', resolveOperationalAction, {
        actionId: 'act_lookup_65',
        idempotencyKey: 'resolve-key',
        body: { version: 1 },
      }, 'FROM operational_actions'],
      ['audit', listSecurityAudit, { query: new URLSearchParams() }, 'FROM audit_events'],
    ]

    for (const [label, service, extras, terminalSql] of services) {
      const downstream = new Error(`lookup-65-reached-${label}`)
      const db = facade(env.DB, {
        all(sql) {
          if (sql.includes('FROM staff_users')) return { results: [storedActorRow(actor)] }
          if (sql.includes(terminalSql)) throw downstream
          return undefined
        },
      })
      const error = await caught(service(commonInput(actor, context, { db, ...extras })))
      expect(error).toBe(downstream)
    }
  })

  it('rejects real CryptoKeys with noncanonical algorithms, lengths, or usages before D1', async () => {
    const context = await cryptoContext()
    const validDataKek = context.keyring.getDataKek(context.dataKey.kek_version)
    const validLookupKey = context.keyring.getLookupHmac(context.keyring.activeLookupKeyVersion)
    const candidates = []
    const add = async (label, target, promise, optional = false) => {
      try {
        candidates.push([label, target, await promise])
      } catch (error) {
        if (!optional) throw error
      }
    }
    await add('AES-GCM 128-bit', 'data', crypto.subtle.importKey(
      'raw', new Uint8Array(16).fill(1), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
    ))
    await add('HMAC SHA-1', 'lookup', crypto.subtle.importKey(
      'raw', new Uint8Array(32).fill(2), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
    ))
    await add('HMAC SHA-256 128-bit', 'lookup', crypto.subtle.importKey(
      'raw', new Uint8Array(16).fill(3), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    ), true)
    await add('AES-GCM missing decrypt usage', 'data', crypto.subtle.importKey(
      'raw', new Uint8Array(32).fill(4), { name: 'AES-GCM' }, false, ['encrypt'],
    ))
    await add('HMAC missing sign usage', 'lookup', crypto.subtle.importKey(
      'raw', new Uint8Array(32).fill(5), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    ))
    await add('AES-GCM extra usages', 'data', crypto.subtle.importKey(
      'raw', new Uint8Array(32).fill(6), { name: 'AES-GCM' }, false,
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    ), true)
    await add('HMAC extra verify usage', 'lookup', crypto.subtle.importKey(
      'raw', new Uint8Array(32).fill(7), { name: 'HMAC', hash: 'SHA-256' }, false,
      ['sign', 'verify'],
    ))

    const actor = { id: 'stf_real_crypto_key', role: 'owner', specialistId: null, version: 1 }
    for (const [label, target, key] of candidates) {
      const marker = new Error(`private-crypto-marker:${label}`)
      const prepare = vi.fn(() => { throw marker })
      const invalidContext = cryptoContextWithKeys(context, {
        dataKek: target === 'data' ? key : validDataKek,
        lookupKey: target === 'lookup' ? key : validLookupKey,
      })
      const error = await caught(getOperationalHealth(commonInput(actor, invalidContext, {
        db: { prepare, batch: vi.fn() },
      })))
      expect(error.message, label).toBe('OPERATIONS_INVALID')
      expect(error, label).not.toBe(marker)
      expect(prepare, label).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['AES-256-GCM', 'data', () => crypto.subtle.importKey(
      'raw', new Uint8Array(32).fill(8), { name: 'AES-GCM' }, true,
      ['encrypt', 'decrypt'],
    )],
    ['HMAC-SHA-256', 'lookup', () => crypto.subtle.importKey(
      'raw', new Uint8Array(32).fill(9), { name: 'HMAC', hash: 'SHA-256' }, true,
      ['sign'],
    )],
  ])('rejects an otherwise valid extractable %s key before D1', async (label, target, importKey) => {
    const context = await cryptoContext()
    const validDataKek = context.keyring.getDataKek(context.dataKey.kek_version)
    const validLookupKey = context.keyring.getLookupHmac(context.keyring.activeLookupKeyVersion)
    const exportable = await importKey()
    const marker = new Error(`private-extractable-key:${label}`)
    const prepare = vi.fn(() => { throw marker })
    const invalidContext = cryptoContextWithKeys(context, {
      dataKek: target === 'data' ? exportable : validDataKek,
      lookupKey: target === 'lookup' ? exportable : validLookupKey,
    })
    const actor = {
      id: `stf_extractable_${target}`,
      role: 'owner',
      specialistId: null,
      version: 1,
    }

    const error = await caught(getOperationalHealth(commonInput(actor, invalidContext, {
      db: { prepare, batch: vi.fn() },
    })))
    expect(error.message).toBe('OPERATIONS_INVALID')
    expect(error).not.toBe(marker)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('normalizes root, nested, descriptor, and hostile keyring traps to OPERATIONS_INVALID', async () => {
    const context = await cryptoContext()
    const actor = { id: 'stf_proxy_input', role: 'owner', specialistId: null, version: 1 }
    const valid = commonInput(actor, context)
    const revoked = Proxy.revocable(valid, {})
    revoked.revoke()
    const prototypeTrap = new Proxy(valid, {
      getPrototypeOf() { throw new Error('prototype-private-marker') },
    })
    const descriptorTrap = new Proxy(valid, {
      getOwnPropertyDescriptor() { throw new Error('descriptor-private-marker') },
    })
    const ownKeysTrap = new Proxy(valid, {
      ownKeys() { throw new Error('ownkeys-private-marker') },
    })
    const getterTrap = { ...valid }
    Object.defineProperty(getterTrap, 'db', {
      enumerable: true,
      get() { throw new Error('getter-private-marker') },
    })
    const nestedRevoked = Proxy.revocable(context.scope, {})
    nestedRevoked.revoke()
    const nestedTrap = { ...valid, cryptoContext: { ...context, scope: nestedRevoked.proxy } }
    const hostile = {}
    Object.defineProperty(hostile, 'message', {
      get() { throw new Error('message-private-marker') },
    })
    const keyringTrap = {
      ...valid,
      cryptoContext: {
        ...context,
        keyring: new Proxy(context.keyring, {
          get(target, property, receiver) {
            if (property === 'getDataKek') return () => { throw hostile }
            return Reflect.get(target, property, receiver)
          },
        }),
      },
    }
    const versions = [1]
    Object.defineProperty(versions, '0', {
      configurable: true,
      enumerable: true,
      get() { throw new Error('lookup-version-private-marker') },
    })
    const versionsTrap = {
      ...valid,
      cryptoContext: {
        ...context,
        keyring: new Proxy(context.keyring, {
          get(target, property, receiver) {
            if (property === 'lookupKeyVersions') return versions
            return Reflect.get(target, property, receiver)
          },
        }),
      },
    }

    for (const value of [
      revoked.proxy,
      prototypeTrap,
      descriptorTrap,
      ownKeysTrap,
      getterTrap,
      nestedTrap,
      keyringTrap,
      versionsTrap,
    ]) {
      await expect(getOperationalHealth(value)).rejects.toThrow(/^OPERATIONS_INVALID$/)
    }
  })

  it('captures every root and nested service input getter exactly once', async () => {
    const baseContext = await cryptoContext()
    await seedHealthSnapshot(validSnapshot())
    const services = [
      ['health', getOperationalHealth, {}, { data: validSnapshot() }],
      ['actions', listOpenOperationalActions, {}, { data: { actions: [], truncated: false } }],
      ['resolution', resolveOperationalAction, {
        actionId: 'act_single_read_absent',
        idempotencyKey: 'resolve-key',
        body: { version: 1 },
      }, 'NOT_FOUND'],
      ['audit', listSecurityAudit, { query: new URLSearchParams() }, { data: { events: [], nextCursor: null } }],
    ]
    for (const [label, service, extras, terminal] of services) {
      const actor = await seedActiveActor({ id: `stf_single_read_${label}` })
      const dataKey = singleReadObject(baseContext.dataKey, `${label}:dataKey`)
      const scope = singleReadObject(baseContext.scope, `${label}:scope`)
      const versions = [1]
      let versionReads = 0
      Object.defineProperty(versions, '0', {
        configurable: true,
        enumerable: true,
        get() {
          versionReads += 1
          if (versionReads > 1) throw new Error(`${label}:lookupVersion`)
          return 1
        },
      })
      const keyring = singleReadObject({
        activeLookupKeyVersion: baseContext.keyring.activeLookupKeyVersion,
        lookupKeyVersions: versions,
        getDataKek: baseContext.keyring.getDataKek,
        getLookupHmac: baseContext.keyring.getLookupHmac,
      }, `${label}:keyring`)
      const context = singleReadObject({
        keyring: keyring.object,
        dataKey: dataKey.object,
        scope: scope.object,
      }, `${label}:context`)
      const capturedActor = singleReadObject(actor, `${label}:actor`)
      const db = facade(env.DB, {
        all: (sql) => {
          if (label === 'actions' && sql.includes('FROM operational_actions')) return { results: [] }
          if (label === 'resolution' && sql.includes('FROM operational_actions')) return { results: [] }
          if (label === 'audit' && sql.includes('FROM audit_events')) return { results: [] }
          return undefined
        },
      })
      const root = singleReadObject(commonInput(capturedActor.object, context.object, {
        db,
        ...extras,
      }), `${label}:root`)
      if (typeof terminal === 'string') {
        await expect(service(root.object)).rejects.toThrow(new RegExp(`^${terminal}$`))
      } else {
        await expect(service(root.object)).resolves.toEqual(terminal)
      }
      expect(versionReads).toBe(1)
      for (const reads of [root.reads, context.reads, dataKey.reads, scope.reads, keyring.reads, capturedActor.reads]) {
        expect([...reads.values()].every((count) => count === 1)).toBe(true)
      }
    }
  })

  it('captures each D1 all-result wrapper and Proxy results array once without mutation', async () => {
    const context = await cryptoContext()
    const actor = { id: 'stf_all_capture', role: 'owner', specialistId: null, version: 1 }
    const snapshot = validSnapshot()
    const healthRow = {
      key: 'health.snapshot',
      value_json: canonicalJson(snapshot),
      version: 1,
      updated_at: snapshot.generatedAt,
    }
    const cases = [
      ['actor', getOperationalHealth, {}, [storedActorRow(actor)], { data: snapshot }],
      ['health', getOperationalHealth, {}, [healthRow], { data: snapshot }],
      ['action-list', listOpenOperationalActions, {}, [], {
        data: { actions: [], truncated: false },
      }],
      ['action-by-id', resolveOperationalAction, {
        actionId: 'act_all_capture_absent',
        idempotencyKey: 'resolve-key',
        body: { version: 1 },
      }, [], 'NOT_FOUND'],
      ['audit', listSecurityAudit, { query: new URLSearchParams() }, [], {
        data: { events: [], nextCursor: null },
      }],
    ]

    for (const [target, service, extras, targetRows, terminal] of cases) {
      const captured = singleReadAllResult(targetRows, `all-capture:${target}`)
      const db = facade(env.DB, {
        all(sql) {
          if (sql.includes('FROM staff_users')) {
            return target === 'actor' ? captured.wrapper : { results: [storedActorRow(actor)] }
          }
          if (sql.includes('FROM system_state')) {
            return target === 'health' ? captured.wrapper : { results: [healthRow] }
          }
          if (sql.includes('FROM operational_actions')) return captured.wrapper
          if (sql.includes('FROM audit_events')) return captured.wrapper
          return undefined
        },
      })
      const promise = service(commonInput(actor, context, { db, ...extras }))
      if (typeof terminal === 'string') {
        await expect(promise).rejects.toThrow(new RegExp(`^${terminal}$`))
      } else {
        await expect(promise).resolves.toEqual(terminal)
      }
      const reads = captured.reads()
      expect(reads.resultsReads, target).toBe(1)
      expect(reads.lengthReads, target).toBe(1)
      expect([...reads.entryReads.values()], target).toEqual(
        Array.from({ length: targetRows.length }, () => 1)
      )
      expect(reads.mutations, target).toBe(0)
    }
  })

  it.each([
    ['actor', getOperationalHealth, {}],
    ['health', getOperationalHealth, {}],
    ['action-list', listOpenOperationalActions, {}],
    ['action-by-id', resolveOperationalAction, {
      actionId: 'act_all_throw', idempotencyKey: 'resolve-key', body: { version: 1 },
    }],
    ['audit', listSecurityAudit, { query: new URLSearchParams() }],
  ])('normalizes a throwing D1 all-result getter in the %s reader', async (target, service, extras) => {
    const context = await cryptoContext()
    const actor = { id: `stf_all_throw_${target}`, role: 'owner', specialistId: null, version: 1 }
    const hostile = throwingAllResult(`private-all-marker:${target}`)
    const db = facade(env.DB, {
      all(sql) {
        if (sql.includes('FROM staff_users')) {
          return target === 'actor' ? hostile.wrapper : { results: [storedActorRow(actor)] }
        }
        if (sql.includes('FROM system_state') && target === 'health') return hostile.wrapper
        if (sql.includes('FROM operational_actions')
          && (target === 'action-list' || target === 'action-by-id')) return hostile.wrapper
        if (sql.includes('FROM audit_events') && target === 'audit') return hostile.wrapper
        return undefined
      },
    })

    const error = await caught(service(commonInput(actor, context, { db, ...extras })))
    expect(error.message).toBe('OPERATIONS_STATE_INVALID')
    expect(error).not.toBe(hostile.error)
  })

  it('normalizes a throwing Proxy results entry without leaking or mutating it', async () => {
    const context = await cryptoContext()
    const actor = { id: 'stf_all_proxy_throw', role: 'owner', specialistId: null, version: 1 }
    const marker = new Error('private-all-proxy-entry')
    let mutations = 0
    const results = new Proxy([storedActorRow(actor)], {
      get(target, property, receiver) {
        if (property === '0') throw marker
        return Reflect.get(target, property, receiver)
      },
      set() { mutations += 1; throw marker },
      defineProperty() { mutations += 1; throw marker },
      deleteProperty() { mutations += 1; throw marker },
    })
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM staff_users') ? { results, success: true } : undefined,
    })

    const error = await caught(getOperationalHealth(commonInput(actor, context, { db })))
    expect(error.message).toBe('OPERATIONS_STATE_INVALID')
    expect(error).not.toBe(marker)
    expect(mutations).toBe(0)
  })

  it('captures the attempted-audit collision result once before recovery classification', async () => {
    const context = await cryptoContext()
    const actor = { id: 'stf_attempted_audit_capture', role: 'owner', specialistId: null, version: 1 }
    const row = await actionRow(context, {
      ...ACTION_FACTS[2],
      id: 'act_attempted_audit_capture',
      fingerprint: 'backup.failed:bkp_attempted_audit_capture',
      entityId: 'bkp_attempted_audit_capture',
      details: {
        backupId: 'bkp_attempted_audit_capture',
        errorCode: 'BACKUP_FAILED',
      },
    })
    const attempted = singleReadAllResult([], 'attempted-audit-capture')
    const collision = new Error('identity_collision: SQLITE_CONSTRAINT')
    const db = facade(env.DB, {
      all(sql) {
        if (sql.includes('FROM staff_users')) return { results: [storedActorRow(actor)] }
        if (sql.includes('FROM operational_actions')) return { results: [row] }
        if (sql.includes('FROM audit_events')) return attempted.wrapper
        return undefined
      },
      batch() { throw collision },
    })

    const error = await caught(resolveOperationalAction(resolutionInput(actor, context, row.id, {
      db,
      idFactory: ids('aud_attempted_audit_capture'),
    })))
    expect(error).toBe(collision)
    expect(attempted.reads()).toMatchObject({
      lengthReads: 1,
      mutations: 0,
      resultsReads: 1,
    })
  })

  it.each([
    ['extra field', { extra: 'private-actor-field' }],
    ['unknown role', { role: 'administrator' }],
    ['unknown status', { status: 'locked' }],
    ['zero version', { version: 0 }],
    ['invalid specialist id', { specialist_id: 'bad specialist id' }],
  ])('fails closed on a malformed revalidated actor row: %s', async (_label, changes) => {
    const context = await cryptoContext()
    const actor = { id: `stf_malformed_actor_${++fixtureSerial}`, role: 'owner', specialistId: null, version: 1 }
    const row = { ...storedActorRow(actor), ...changes }
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM staff_users') ? { results: [row] } : undefined,
    })

    await expect(getOperationalHealth(commonInput(actor, context, { db })))
      .rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
  })

  it('propagates denial persistence failure instead of returning a bare forbidden response', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_denial_persistence_failure', role: 'specialist' })
    const failure = new Error('denial-persistence-failed')
    const db = facade(env.DB, {
      batch() { throw failure },
    })

    const error = await caught(getOperationalHealth(commonInput(actor, context, {
      db,
      idFactory: ids('aud_denial_persistence_failure'),
    })))
    expect(error).toBe(failure)
    expect(await denialRows(actor.id)).toHaveLength(0)
  })

  it.each([
    ['health', getOperationalHealth, {}, 'operations.health.read denied'],
    ['actions', listOpenOperationalActions, {}, 'operations.health.read denied'],
    ['resolution', resolveOperationalAction, {
      actionId: 'action_denied', idempotencyKey: 'resolve-key', body: { version: 1 },
    }, 'operations.health.read denied'],
    ['audit', listSecurityAudit, { query: new URLSearchParams() }, 'security.audit.read denied'],
  ])('writes one exact encrypted denial before rejecting specialist %s', async (_label, service, changes, reason) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: `stf_denied_${_label}`, role: 'specialist' })

    await expect(service(commonInput(actor, context, {
      idFactory: ids(`aud_denied_${_label}`),
      ...changes,
    }))).rejects.toThrow(/^FORBIDDEN$/)

    const rows = await denialRows(actor.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(expect.objectContaining({
      occurred_at: NOW,
      actor_staff_id: actor.id,
      action: 'authorization.denied',
      entity_type: 'staff_user',
      entity_id: actor.id,
      result: 'denied',
      correlation_id: CORRELATION_ID,
      metadata_json: '{"version":1}',
    }))
    expect(rows[0].reason_envelope).not.toContain(reason)
    await expect(decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope,
      recordId: rows[0].id,
      field: 'reason',
      envelope: JSON.parse(rows[0].reason_envelope),
    })).resolves.toBe(reason)
  })

  it.each([
    ['disabled', { status: 'disabled' }],
    ['changed role', { role: 'coordinator' }],
    ['changed version', { version: 2 }],
  ])('denies a previously authorized actor after active-row revalidation: %s', async (_label, stored) => {
    const context = await cryptoContext()
    const inputActor = { id: `stf_revalidate_${_label.replaceAll(' ', '_')}`, role: 'owner', specialistId: null, version: 1 }
    const seeded = await seedActiveActor({
      id: inputActor.id,
      role: stored.role ?? inputActor.role,
      version: stored.version ?? inputActor.version,
    })
    if (stored.status === 'disabled') {
      await seedActiveActor({ id: 'stf_revalidate_guard_owner', role: 'owner' })
      await env.DB.prepare(
        `UPDATE staff_users SET status='disabled',disabled_at=?,updated_at=?,version=version+1
         WHERE id=?`
      ).bind(NOW, NOW, inputActor.id).run()
    }

    await expect(getOperationalHealth(commonInput(inputActor, context, {
      idFactory: ids(`aud_revalidate_${_label.replaceAll(' ', '_')}`),
    }))).rejects.toThrow(/^FORBIDDEN$/)
    expect(await denialRows(seeded.id)).toHaveLength(1)
  })

  it.each(['owner', 'coordinator'])('returns only the canonical stored health snapshot for %s', async (role) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: `stf_health_${role}`, role })
    const snapshot = validSnapshot()
    await seedHealthSnapshot(snapshot)

    const result = await getOperationalHealth(commonInput(actor, context))

    expect(result).toEqual({ data: snapshot })
    expect(Object.keys(result)).toEqual(['data'])
    expect(Object.keys(result.data)).toEqual(['generatedAt', 'checks'])
    for (const check of result.data.checks) {
      expect(Object.keys(check)).toEqual([
        'id', 'label', 'status', 'lastSuccessAt', 'detailCode',
      ])
    }
    result.data.checks[0].label = 'mutated'
    await expect(getOperationalHealth(commonInput(actor, context))).resolves.toEqual({ data: snapshot })
  })

  it.each(['OUTBOX_DRAIN_FAILED', 'OUTBOX_DRAIN_STALE'])(
    'returns the exact critical outbox drain state %s',
    async (detailCode) => {
      const context = await cryptoContext()
      const actor = await seedActiveActor({
        id: `stf_health_${detailCode.toLowerCase()}`,
        role: 'owner',
      })
      const snapshot = validSnapshot()
      snapshot.checks[0] = {
        ...snapshot.checks[0],
        status: 'critical',
        detailCode,
      }
      await seedHealthSnapshot(snapshot)

      await expect(getOperationalHealth(commonInput(actor, context)))
        .resolves.toEqual({ data: snapshot })
    },
  )

  it.each([
    ['missing row', null],
    ['duplicate rows', 'duplicate'],
    ['extra row field', { extra: true }],
    ['zero state version', { version: 0 }],
    ['noncanonical timestamp', { updated_at: '2042-07-31T10:00:00Z' }],
  ])('fails closed for invalid stored health row: %s', async (_label, mutation) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: `stf_bad_health_row_${_label.replaceAll(' ', '_')}` })
    const row = await seedHealthSnapshot()
    const db = facade(env.DB, {
      all: (sql) => {
        if (!sql.includes("FROM system_state WHERE key='health.snapshot'")) return undefined
        if (mutation === null) return { results: [] }
        if (mutation === 'duplicate') return { results: [row, row] }
        return { results: [{ ...row, ...mutation }] }
      },
    })

    await expect(getOperationalHealth(commonInput(actor, context, { db })))
      .rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
  })

  it.each([
    ['noncanonical JSON', JSON.stringify(validSnapshot())],
    ['wrong generatedAt', canonicalJson({ ...validSnapshot(), generatedAt: '2042-07-31T09:59:59.999Z' })],
    ['extra top-level key', canonicalJson({ ...validSnapshot(), extra: true })],
    ['missing check', canonicalJson({ ...validSnapshot(), checks: validSnapshot().checks.slice(0, 3) })],
    ['reordered checks', canonicalJson({ ...validSnapshot(), checks: [...validSnapshot().checks].reverse() })],
    ['extra check key', canonicalJson({ ...validSnapshot(), checks: validSnapshot().checks.map((check, index) => index ? check : { ...check, extra: true }) })],
    ['bad status/detail pair', canonicalJson({ ...validSnapshot(), checks: validSnapshot().checks.map((check, index) => index ? check : { ...check, detailCode: 'OUTBOX_DEAD' }) })],
    ['future last success', canonicalJson({ ...validSnapshot(), checks: validSnapshot().checks.map((check, index) => index ? check : { ...check, lastSuccessAt: '2042-07-31T10:00:00.001Z' }) })],
    ['noncanonical last success', canonicalJson({ ...validSnapshot(), checks: validSnapshot().checks.map((check, index) => index ? check : { ...check, lastSuccessAt: '2042-07-31T10:00:00Z' }) })],
  ])('fails closed for invalid stored health JSON: %s', async (_label, valueJson) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: `stf_bad_health_json_${_label.replaceAll(/[^A-Za-z0-9_-]/g, '_')}` })
    await seedHealthSnapshot(validSnapshot(), { valueJson })
    const before = await env.DB.prepare(
      "SELECT value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()

    await expect(getOperationalHealth(commonInput(actor, context)))
      .rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
    expect(await env.DB.prepare(
      "SELECT value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual(before)
  })

  it('returns all six exact validated open action kinds for owner', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_actions_owner', role: 'owner' })
    const rows = await actionRows(context)
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM operational_actions') ? { results: rows } : undefined,
    })

    const result = await listOpenOperationalActions(commonInput(actor, context, { db }))

    expect(result).toEqual({
      data: {
        actions: ACTION_FACTS.map((fact, index) => ({
          id: fact.id,
          kind: fact.kind,
          severity: fact.severity,
          entityType: fact.entityType,
          entityId: fact.entityId,
          details: fact.details,
          version: 1,
          createdAt: new Date(NOW_MS - index).toISOString(),
          updatedAt: new Date(NOW_MS - index).toISOString(),
        })),
        truncated: false,
      },
    })
    for (const action of result.data.actions) {
      expect(Object.keys(action)).toEqual([
        'id', 'kind', 'severity', 'entityType', 'entityId', 'details',
        'version', 'createdAt', 'updatedAt',
      ])
      expect(JSON.stringify(action)).not.toContain('details_envelope')
      expect(JSON.stringify(action)).not.toContain('fingerprint')
    }
  })

  it('returns the exact centre-scoped denial overflow only to an owner', async () => {
    const context = await cryptoContext()
    const owner = await seedActiveActor({ id: 'stf_denial_overflow_owner', role: 'owner' })
    const coordinator = await seedActiveActor({
      id: 'stf_denial_overflow_coordinator',
      role: 'coordinator',
    })
    const row = await actionRow(context, DENIAL_OVERFLOW_FACT)
    const db = facade(env.DB, {
      all(sql) {
        if (!sql.includes('FROM operational_actions')) return undefined
        return {
          results: sql.includes("kind<>'authorization_denial_spike'") ? [] : [row],
        }
      },
    })

    await expect(listOpenOperationalActions(commonInput(owner, context, { db }))).resolves.toEqual({
      data: {
        actions: [{
          id: row.id,
          kind: row.kind,
          severity: row.severity,
          entityType: row.entity_type,
          entityId: row.entity_id,
          details: DENIAL_OVERFLOW_FACT.details,
          version: 1,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }],
        truncated: false,
      },
    })
    await expect(listOpenOperationalActions(commonInput(coordinator, context, { db }))).resolves.toEqual({
      data: { actions: [], truncated: false },
    })
  })

  it('excludes coordinator denial spikes before limit, decryption, and response projection', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_actions_coordinator_boundary', role: 'coordinator' })
    const rows = await actionRows(context)
    const corruptRows = rows.map((row) => row.kind === 'authorization_denial_spike'
      ? { ...row, details_envelope: 'corrupt-security-envelope' }
      : row)
    const db = facade(env.DB, {
      all(sql) {
        if (!sql.includes('FROM operational_actions')) return undefined
        const scoped = /kind\s*<>\s*'authorization_denial_spike'/.test(sql)
        return {
          results: scoped
            ? corruptRows.filter(({ kind }) => kind !== 'authorization_denial_spike')
            : corruptRows,
        }
      },
    })
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt')

    let result
    let actionDecryptCalls
    try {
      result = await listOpenOperationalActions(commonInput(actor, context, { db }))
    } finally {
      actionDecryptCalls = decrypt.mock.calls.filter(([algorithm]) => (
        new TextDecoder().decode(algorithm.additionalData).includes('\naction_details\n')
      )).length
      decrypt.mockRestore()
    }

    expect(result.data.actions.map(({ kind }) => kind)).toEqual(
      ACTION_FACTS.filter(({ kind }) => kind !== 'authorization_denial_spike')
        .map(({ kind }) => kind)
    )
    expect(result.data.truncated).toBe(false)
    expect(actionDecryptCalls).toBe(5)
  })

  it('revalidates the actor after the action query and before decrypting details', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_actions_predecrypt_guard', role: 'coordinator' })
    await insertAction(await actionRow(context, {
      ...ACTION_FACTS[2],
      id: 'act_predecrypt_guard',
      fingerprint: 'backup.failed:bkp_predecrypt_guard',
      entityId: 'bkp_predecrypt_guard',
      details: { backupId: 'bkp_predecrypt_guard', errorCode: 'BACKUP_FAILED' },
    }))
    const db = facade(env.DB, {
      async all(sql, bindings) {
        if (!sql.includes('FROM operational_actions')) return undefined
        const result = await env.DB.prepare(sql).bind(...bindings).all()
        await env.DB.prepare(
          `UPDATE staff_users SET status='disabled',disabled_at=?,updated_at=?,version=version+1
           WHERE id=?`
        ).bind(NOW, NOW, actor.id).run()
        return result
      },
    })
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt')

    const result = await caught(listOpenOperationalActions(commonInput(actor, context, {
      db,
      idFactory: ids('aud_actions_predecrypt'),
    })))
    const actionDecryptCalls = decrypt.mock.calls.filter(([algorithm]) => (
      new TextDecoder().decode(algorithm.additionalData).includes('\naction_details\n')
    )).length
    decrypt.mockRestore()

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('FORBIDDEN')
    expect(actionDecryptCalls).toBe(0)
    expect(await denialRows(actor.id)).toHaveLength(1)
  })

  it('revalidates the actor after decryption before returning action details', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_actions_response_guard', role: 'coordinator' })
    const row = await actionRow(context, {
      ...ACTION_FACTS[2],
      id: 'act_response_guard',
      fingerprint: 'backup.failed:bkp_response_guard',
      entityId: 'bkp_response_guard',
      details: { backupId: 'bkp_response_guard', errorCode: 'BACKUP_FAILED' },
    })
    const db = facade(env.DB, {
      all(sql) {
        return sql.includes('FROM operational_actions') ? { results: [row] } : undefined
      },
    })
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    let disabled = false
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      const plaintext = await originalDecrypt(...args)
      if (!disabled) {
        disabled = true
        await env.DB.prepare(
          `UPDATE staff_users SET status='disabled',disabled_at=?,updated_at=?,version=version+1
           WHERE id=?`
        ).bind(NOW, NOW, actor.id).run()
      }
      return plaintext
    })

    const result = await caught(listOpenOperationalActions(commonInput(actor, context, {
      db,
      idFactory: ids('aud_actions_response'),
    })))
    const actionDecryptCalls = decrypt.mock.calls.filter(([algorithm]) => (
      new TextDecoder().decode(algorithm.additionalData).includes('\naction_details\n')
    )).length
    decrypt.mockRestore()

    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('FORBIDDEN')
    expect(actionDecryptCalls).toBe(1)
    expect(await denialRows(actor.id)).toHaveLength(1)
  })

  it('returns 100 actions only after validating the 101st row and reports truncation', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_actions_bounds' })
    const facts = Array.from({ length: 101 }, (_, index) => ({
      id: `act_bound_${String(index).padStart(3, '0')}`,
      fingerprint: `backup.failed:bkp_bound_${index}`,
      kind: 'backup_failed',
      severity: 'critical',
      entityType: 'backup_run',
      entityId: `bkp_bound_${index}`,
      details: { backupId: `bkp_bound_${index}`, errorCode: 'BACKUP_FAILED' },
    }))
    const rows = await actionRows(context, facts)
    const db = facade(env.DB, {
      all: (sql, bindings) => {
        if (!sql.includes('FROM operational_actions')) return undefined
        expect(sql).toContain("WHERE status='open'")
        expect(sql).toContain('ORDER BY created_at DESC,id DESC')
        expect(bindings).toEqual([101])
        return { results: rows }
      },
    })

    const result = await listOpenOperationalActions(commonInput(actor, context, { db }))
    expect(result.data.actions).toHaveLength(100)
    expect(result.data.truncated).toBe(true)
    expect(result.data.actions.at(-1).id).toBe('act_bound_099')

    rows[100] = { ...rows[100], details_envelope: 'corrupt-extra-row' }
    await expect(listOpenOperationalActions(commonInput(actor, context, { db })))
      .rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
  })

  it.each([
    ['unknown kind', (row) => ({ ...row, kind: 'future_kind' })],
    ['wrong status', (row) => ({ ...row, status: 'resolved', resolved_at: NOW })],
    ['wrong version', (row) => ({ ...row, version: 2 })],
    ['wrong fingerprint', (row) => ({ ...row, fingerprint: 'backup.failed:bkp_other' })],
    ['wrong entity', (row) => ({ ...row, entity_id: 'bkp_other' })],
    ['noncanonical detail JSON', async (row, context) => ({
      ...row,
      details_envelope: await actionEnvelope(
        context,
        row.id,
        ACTION_FACTS[2].details,
        '{"errorCode":"BACKUP_FAILED","backupId":"bkp_failed_1"}',
      ),
    })],
    ['wrong AAD', async (row, context) => ({
      ...row,
      details_envelope: await actionEnvelope(context, 'act_other_aad', ACTION_FACTS[2].details),
    })],
    ['extra row key', (row) => ({ ...row, private_error: 'sentinel-private' })],
    ['unsorted rows', (row) => row],
  ])('fails the entire action list for %s', async (_label, mutate) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: `stf_action_invalid_${_label.replaceAll(/[^A-Za-z0-9_-]/g, '_')}` })
    const base = await actionRow(context, ACTION_FACTS[2])
    let rows
    if (_label === 'unsorted rows') {
      const older = await actionRow(context, {
        ...ACTION_FACTS[2],
        id: 'act_unsorted_older',
        fingerprint: 'backup.failed:bkp_unsorted_older',
        entityId: 'bkp_unsorted_older',
        details: { backupId: 'bkp_unsorted_older', errorCode: 'BACKUP_FAILED' },
        createdAt: new Date(NOW_MS - 1).toISOString(),
      })
      rows = [older, base]
    } else {
      rows = [await mutate(base, context)]
    }
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM operational_actions') ? { results: rows } : undefined,
    })

    await expect(listOpenOperationalActions(commonInput(actor, context, { db })))
      .rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
  })

  it.each([
    ['wrong fingerprint', { fingerprint: 'security.authorization_denials:overflow_other' }],
    ['wrong severity', { severity: 'warning' }],
    ['wrong entity type', { entityType: 'staff_user' }],
    ['wrong entity id', { entityId: 'centre_2' }],
    ['wrong error code', {
      details: { ...DENIAL_OVERFLOW_FACT.details, errorCode: 'AUTHORIZATION_DENIAL_SPIKE' },
    }],
    ['wrong minimum count', {
      details: { ...DENIAL_OVERFLOW_FACT.details, minimumCount: 100 },
    }],
    ['wrong threshold', {
      details: { ...DENIAL_OVERFLOW_FACT.details, threshold: 101 },
    }],
    ['wrong window', {
      details: { ...DENIAL_OVERFLOW_FACT.details, windowMinutes: 14 },
    }],
    ['extra detail', {
      details: { ...DENIAL_OVERFLOW_FACT.details, count: 101 },
    }],
    ['superseded count key', {
      details: {
        countAtLeast: 101,
        errorCode: 'AUTHORIZATION_DENIAL_OVERFLOW',
        threshold: 100,
        windowMinutes: 15,
      },
    }],
  ])('rejects malformed centre-scoped denial overflow: %s', async (_label, changes) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({
      id: `stf_denial_overflow_invalid_${++fixtureSerial}`,
      role: 'owner',
    })
    const row = await actionRow(context, { ...DENIAL_OVERFLOW_FACT, ...changes })
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM operational_actions') ? { results: [row] } : undefined,
    })

    await expect(listOpenOperationalActions(commonInput(actor, context, { db })))
      .rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
  })

  it('accepts an unknown ordinary outbox type only with OUTBOX_TYPE_INVALID', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_action_unknown_outbox' })
    const row = await actionRow(context, {
      ...ACTION_FACTS[4],
      id: 'act_unknown_outbox',
      fingerprint: 'outbox.dead:job_unknown_outbox',
      entityId: 'job_unknown_outbox',
      details: {
        errorCode: 'OUTBOX_TYPE_INVALID',
        jobId: 'job_unknown_outbox',
        outboxType: 'future.delivery',
      },
    })
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM operational_actions') ? { results: [row] } : undefined,
    })

    await expect(listOpenOperationalActions(commonInput(actor, context, { db }))).resolves.toEqual({
      data: {
        actions: [{
          id: row.id,
          kind: row.kind,
          severity: row.severity,
          entityType: row.entity_type,
          entityId: row.entity_id,
          details: {
            errorCode: 'OUTBOX_TYPE_INVALID',
            jobId: 'job_unknown_outbox',
            outboxType: 'future.delivery',
          },
          version: 1,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }],
        truncated: false,
      },
    })
  })

  it('never accepts dormant backup.create as an ordinary dead outbox action', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_action_dormant' })
    const row = await actionRow(context, {
      ...ACTION_FACTS[4],
      details: {
        errorCode: 'OUTBOX_HANDLER_FAILURE',
        jobId: ACTION_FACTS[4].entityId,
        outboxType: 'backup.create',
      },
    })
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM operational_actions') ? { results: [row] } : undefined,
    })
    await expect(listOpenOperationalActions(commonInput(actor, context, { db })))
      .rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
  })

  it('resolves one exact open action with audit -> CAS -> final guard and no replay record', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_resolve_success' })
    const row = await insertAction(await actionRow(context, {
      ...ACTION_FACTS[2],
      id: 'act_resolve_success',
      fingerprint: 'backup.failed:bkp_resolve_success',
      entityId: 'bkp_resolve_success',
      details: { backupId: 'bkp_resolve_success', errorCode: 'BACKUP_FAILED' },
      createdAt: new Date(NOW_MS - 1_000).toISOString(),
    }))
    const observed = []
    const db = facade(env.DB, {
      batch(statements) {
        observed.push(...statements.map((item) => ({ sql: item.__sql, bindings: item.__bindings })))
        return env.DB.batch(statements.map((item) => item.__inner ?? item))
      },
    })

    const result = await resolveOperationalAction(resolutionInput(actor, context, row.id, {
      db,
      idFactory: ids('aud_resolve_success'),
    }))

    expect(result).toEqual({
      data: {
        action: {
          id: row.id,
          status: 'resolved',
          version: 2,
          resolvedAt: NOW,
          updatedAt: NOW,
        },
      },
    })
    expect(observed).toHaveLength(3)
    expect(observed[0].sql).toContain('INSERT INTO audit_events')
    expect(observed[1].sql).toContain('UPDATE operational_actions')
    expect(observed[1].sql).toContain("WHERE id=? AND status='open' AND version=?")
    expect(observed[2].sql).toContain('changes()=1')
    expect(observed[2].sql).toContain('specialist_id IS ?')
    expect(await env.DB.prepare(
      'SELECT status,version,resolved_at,updated_at FROM operational_actions WHERE id=?'
    ).bind(row.id).first()).toEqual({
      status: 'resolved', version: 2, resolved_at: NOW, updated_at: NOW,
    })
    expect(await env.DB.prepare(
      `SELECT occurred_at,actor_staff_id,action,entity_type,entity_id,result,
              reason_envelope,correlation_id,metadata_json
       FROM audit_events WHERE entity_type='operational_action' AND entity_id=?`
    ).bind(row.id).first()).toEqual({
      occurred_at: NOW,
      actor_staff_id: actor.id,
      action: 'operational_action.resolved',
      entity_type: 'operational_action',
      entity_id: row.id,
      result: 'success',
      reason_envelope: null,
      correlation_id: CORRELATION_ID,
      metadata_json: '{"actionVersion":2}',
    })
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM idempotency_records WHERE resource_id=?'
    ).bind(row.id).first()).count).toBe(0)
  })

  it.each([
    [null, { field: 'version' }],
    [{}, { field: 'version' }],
    [{ version: 1, extra: true }, { field: 'version' }],
    [{ version: '1' }, { field: 'version' }],
    [{ version: 0 }, { field: 'version' }],
    [{ version: 1.5 }, { field: 'version' }],
  ])('rejects invalid resolution body %j only after authorization and action validation', async (body, details) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: `stf_resolve_body_${++fixtureSerial}` })
    const row = await actionRow(context, {
      ...ACTION_FACTS[3],
      id: `act_resolve_body_${actor.id}`,
    })
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM operational_actions') ? { results: [row] } : undefined,
    })
    const error = await caught(resolveOperationalAction(resolutionInput(actor, context, row.id, { db, body })))
    expect(error.message).toBe('VALIDATION_FAILED')
    expect(error.details).toEqual(details)
  })

  it('returns NOT_FOUND for a valid absent action and validates idempotency in depth', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_resolve_absent' })
    await expect(resolveOperationalAction(resolutionInput(actor, context, 'act_absent')))
      .rejects.toThrow(/^NOT_FOUND$/)
    await expect(resolveOperationalAction(resolutionInput(actor, context, 'act_absent', {
      idempotencyKey: 'bad:key',
    }))).rejects.toThrow(/^VALIDATION_FAILED$/)
  })

  it('authorizes a denial-spike coordinator for operations, then writes only a security denial before decrypting', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_resolve_denial_coord', role: 'coordinator' })
    const row = await actionRow(context, {
      ...ACTION_FACTS[1],
      id: 'act_resolve_denial_coord',
    })
    row.details_envelope = 'corrupt-details-sentinel'
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM operational_actions') ? { results: [row] } : undefined,
    })

    await expect(resolveOperationalAction(resolutionInput(actor, context, row.id, {
      db,
      idFactory: ids('aud_resolve_denial_coord'),
    }))).rejects.toThrow(/^FORBIDDEN$/)
    const rows = await denialRows(actor.id)
    expect(rows).toHaveLength(1)
    await expect(decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope,
      recordId: rows[0].id,
      field: 'reason',
      envelope: JSON.parse(rows[0].reason_envelope),
    })).resolves.toBe('security.audit.read denied')
  })

  it('keeps centre-scoped denial overflow resolution owner-only', async () => {
    const context = await cryptoContext()
    const coordinator = await seedActiveActor({
      id: 'stf_resolve_denial_overflow_coordinator',
      role: 'coordinator',
    })
    const owner = await seedActiveActor({ id: 'stf_resolve_denial_overflow_owner', role: 'owner' })
    const row = await insertAction(await actionRow(context, DENIAL_OVERFLOW_FACT))

    try {
      await expect(resolveOperationalAction(resolutionInput(coordinator, context, row.id, {
        idFactory: ids('aud_resolve_denial_overflow_coordinator'),
      }))).rejects.toThrow(/^FORBIDDEN$/)
      expect(await env.DB.prepare(
        'SELECT status,version FROM operational_actions WHERE id=?'
      ).bind(row.id).first()).toEqual({ status: 'open', version: 1 })
      expect(await denialRows(coordinator.id)).toHaveLength(1)

      await expect(resolveOperationalAction(resolutionInput(owner, context, row.id, {
        idFactory: ids('aud_resolve_denial_overflow_owner'),
      }))).resolves.toEqual({
        data: {
          action: {
            id: row.id,
            status: 'resolved',
            version: 2,
            resolvedAt: NOW,
            updatedAt: NOW,
          },
        },
      })
    } finally {
      await env.DB.prepare(
        `UPDATE operational_actions
         SET status='resolved',resolved_at=?,updated_at=?,version=version+1
         WHERE id=? AND status='open'`
      ).bind(NOW, NOW, row.id).run()
    }
  })

  it('returns a safe current version for valid stale and already-resolved actions', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_resolve_conflict' })
    const open = await actionRow(context, {
      ...ACTION_FACTS[3],
      id: 'act_resolve_requested_version',
    })
    const openDb = facade(env.DB, {
      all: (sql) => sql.includes('FROM operational_actions') ? { results: [open] } : undefined,
    })
    const requested = await caught(resolveOperationalAction(resolutionInput(actor, context, open.id, {
      db: openDb,
      body: { version: 2 },
    })))
    expect(requested.message).toBe('VERSION_CONFLICT')
    expect(requested.details).toEqual({ currentVersion: 1 })

    const resolved = await actionRow(context, {
      ...ACTION_FACTS[3],
      id: 'act_resolve_already_done',
      createdAt: new Date(NOW_MS - 1_000).toISOString(),
      status: 'resolved',
      updatedAt: NOW,
    })
    const resolvedDb = facade(env.DB, {
      all: (sql) => sql.includes('FROM operational_actions') ? { results: [resolved] } : undefined,
    })
    const existing = await caught(resolveOperationalAction(resolutionInput(actor, context, resolved.id, {
      db: resolvedDb,
    })))
    expect(existing.message).toBe('VERSION_CONFLICT')
    expect(existing.details).toEqual({ currentVersion: 2 })
  })

  it('rolls back the action and success audit when the final guard fails', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_resolve_rollback' })
    const row = await insertAction(await actionRow(context, {
      ...ACTION_FACTS[3],
      id: 'act_resolve_rollback',
    }))
    const db = facade(env.DB, {
      batch(statements) {
        const forced = env.DB.prepare(
          "INSERT INTO outbox_operation_guard_failures (operation_id) VALUES ('forced_resolution')"
        )
        return env.DB.batch([
          ...statements.slice(0, -1).map((item) => item.__inner ?? item),
          forced,
        ])
      },
    })

    await expect(resolveOperationalAction(resolutionInput(actor, context, row.id, {
      db,
      idFactory: ids('aud_resolve_rollback'),
    }))).rejects.toThrow(/outbox_operation_guard_failed/)
    expect(await env.DB.prepare(
      'SELECT status,version,resolved_at FROM operational_actions WHERE id=?'
    ).bind(row.id).first()).toEqual({ status: 'open', version: 1, resolved_at: null })
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE entity_type='operational_action' AND entity_id=?"
    ).bind(row.id).first()).count).toBe(0)
  })

  it('converges two version-1 requests to one success audit and one conflict, with no same-key replay', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_resolve_concurrent' })
    const row = await insertAction(await actionRow(context, {
      ...ACTION_FACTS[5],
      id: 'act_resolve_concurrent',
      entityId: 'scheduler_run_concurrent',
      details: {
        errorCode: 'SCHEDULER_STALE',
        schedulerRunId: 'scheduler_run_concurrent',
        thresholdMinutes: 15,
      },
    }))
    const idFactory = ids('aud_resolve_concurrent')
    const attempts = await Promise.allSettled([
      resolveOperationalAction(resolutionInput(actor, context, row.id, { idFactory })),
      resolveOperationalAction(resolutionInput(actor, context, row.id, { idFactory })),
    ])
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const loser = attempts.find(({ status }) => status === 'rejected').reason
    expect(loser.message).toBe('VERSION_CONFLICT')
    expect(loser.details).toEqual({ currentVersion: 2 })
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='operational_action.resolved' AND entity_id=?`
    ).bind(row.id).first()).count).toBe(1)

    const replay = await caught(resolveOperationalAction(resolutionInput(actor, context, row.id, {
      idFactory,
      idempotencyKey: 'resolve-key',
    })))
    expect(replay.message).toBe('VERSION_CONFLICT')
    expect(replay.details).toEqual({ currentVersion: 2 })
  })

  it('reconciles a committed resolution after reply loss through conflict and open-list absence', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_resolve_reply_loss' })
    const row = await insertAction(await actionRow(context, {
      ...ACTION_FACTS[2],
      id: 'act_resolve_reply_loss',
      fingerprint: 'backup.failed:bkp_resolve_reply_loss',
      entityId: 'bkp_resolve_reply_loss',
      details: {
        backupId: 'bkp_resolve_reply_loss',
        errorCode: 'BACKUP_FAILED',
      },
    }))
    const replyLoss = new Error('resolution-reply-lost')
    const losingReplyDb = facade(env.DB, {
      async batch(statements) {
        await env.DB.batch(statements.map((item) => item.__inner ?? item))
        throw replyLoss
      },
    })

    const first = await caught(resolveOperationalAction(resolutionInput(actor, context, row.id, {
      db: losingReplyDb,
      idFactory: ids('aud_resolve_reply_loss'),
    })))
    expect(first).toBe(replyLoss)
    const retry = await caught(resolveOperationalAction(resolutionInput(actor, context, row.id, {
      idFactory: ids('aud_resolve_reply_loss_retry'),
    })))
    expect(retry.message).toBe('VERSION_CONFLICT')
    expect(retry.details).toEqual({ currentVersion: 2 })
    const open = await listOpenOperationalActions(commonInput(actor, context))
    expect(open.data.actions.some(({ id }) => id === row.id)).toBe(false)
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='operational_action.resolved' AND entity_id=?`
    ).bind(row.id).first()).count).toBe(1)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM idempotency_records WHERE resource_id=?'
    ).bind(row.id).first()).count).toBe(0)
  })

  it('rolls back on an actor change, rereads authorization, and persists only one denial', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_resolve_stale_actor', role: 'coordinator' })
    const row = await insertAction(await actionRow(context, {
      ...ACTION_FACTS[2],
      id: 'act_resolve_stale_actor',
      fingerprint: 'backup.failed:bkp_resolve_stale_actor',
      entityId: 'bkp_resolve_stale_actor',
      details: { backupId: 'bkp_resolve_stale_actor', errorCode: 'BACKUP_FAILED' },
    }))
    let batchCalls = 0
    const db = facade(env.DB, {
      async batch(statements) {
        batchCalls += 1
        if (batchCalls === 1) {
          await env.DB.prepare(
            `UPDATE staff_users
             SET status='disabled',disabled_at=?,updated_at=?,version=version+1
             WHERE id=?`
          ).bind(NOW, NOW, actor.id).run()
        }
        return env.DB.batch(statements.map((item) => item.__inner ?? item))
      },
    })

    await expect(resolveOperationalAction(resolutionInput(actor, context, row.id, {
      db,
      idFactory: ids('aud_resolve_stale_actor'),
    }))).rejects.toThrow(/^FORBIDDEN$/)
    expect(await env.DB.prepare(
      'SELECT status,version FROM operational_actions WHERE id=?'
    ).bind(row.id).first()).toEqual({ status: 'open', version: 1 })
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='operational_action.resolved' AND entity_id=?`
    ).bind(row.id).first()).count).toBe(0)
    expect(await denialRows(actor.id)).toHaveLength(1)
  })

  it('does not misclassify an audit-id collision as a version conflict', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_resolve_audit_collision' })
    const row = await insertAction(await actionRow(context, {
      ...ACTION_FACTS[2],
      id: 'act_resolve_audit_collision',
      fingerprint: 'backup.failed:bkp_resolve_audit_collision',
      entityId: 'bkp_resolve_audit_collision',
      details: {
        backupId: 'bkp_resolve_audit_collision',
        errorCode: 'BACKUP_FAILED',
      },
    }))
    await env.DB.prepare(
      `INSERT INTO audit_events
       (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
        reason_envelope,correlation_id,metadata_json)
       VALUES ('aud_resolve_collision_1',?,?,'identity.reindex','staff_user',?,'success',NULL,'stored_correlation','{"version":1}')`
    ).bind(NOW, actor.id, actor.id).run()

    const error = await caught(resolveOperationalAction(resolutionInput(actor, context, row.id, {
      idFactory: ids('aud_resolve_collision'),
    })))
    expect(error.message).toMatch(/identity_collision/)
    expect(error.message).not.toBe('VERSION_CONFLICT')
    expect(await env.DB.prepare(
      'SELECT status,version FROM operational_actions WHERE id=?'
    ).bind(row.id).first()).toEqual({ status: 'open', version: 1 })
  })

  it('rejects a concurrent immutable action mutation before recovery decrypts it', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({
      id: 'stf_resolve_immutable_mutation',
      role: 'coordinator',
    })
    const original = await actionRow(context, {
      ...ACTION_FACTS[2],
      id: 'act_resolve_immutable_mutation',
      fingerprint: 'backup.failed:bkp_resolve_immutable_mutation',
      entityId: 'bkp_resolve_immutable_mutation',
      details: {
        backupId: 'bkp_resolve_immutable_mutation',
        errorCode: 'BACKUP_FAILED',
      },
    })
    const changed = await actionRow(context, {
      ...ACTION_FACTS[1],
      id: original.id,
      fingerprint: 'security.authorization_denials:stf_target:staff.manage',
    })
    let actionReads = 0
    const db = facade(env.DB, {
      all(sql) {
        if (sql.includes('FROM audit_events')) return { results: [] }
        if (!sql.includes('FROM operational_actions')) return undefined
        actionReads += 1
        return { results: [actionReads === 1 ? original : changed] }
      },
      batch() {
        throw new Error('identity_collision: SQLITE_CONSTRAINT')
      },
    })
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt')

    const error = await caught(resolveOperationalAction(resolutionInput(actor, context, original.id, {
      db,
      idFactory: ids('aud_resolve_immutable_mutation'),
    })))
    const decryptCalls = decrypt.mock.calls.length
    decrypt.mockRestore()
    expect(error.message).toBe('OPERATIONS_STATE_INVALID')
    expect(decryptCalls).toBe(2)
  })

  it('returns the exact closed audit registry without decrypting reasons or identity names', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_audit_registry' })
    const rows = await Promise.all(AUDIT_FACTS.map((fact, index) => auditRow(context, fact, index)))
    const db = facade(env.DB, {
      all: (sql, bindings) => {
        if (!sql.includes('FROM audit_events')) return undefined
        expect(sql).toContain('ORDER BY occurred_at DESC,id DESC')
        expect(bindings).toEqual([51])
        return { results: rows }
      },
    })

    const result = await listSecurityAudit(commonInput(actor, context, {
      db,
      query: new URLSearchParams(),
    }))

    expect(result).toEqual({
      data: {
        events: AUDIT_FACTS.map((fact, index) => ({
          id: `audit_event_${String(index).padStart(3, '0')}`,
          occurredAt: new Date(NOW_MS - index).toISOString(),
          actorStaffId: fact.actorStaffId,
          action: fact.action,
          entityType: fact.entityType,
          entityId: fact.entityId,
          result: fact.result,
          correlationId: `stored_correlation_${index}`,
          metadata: fact.metadata,
        })),
        nextCursor: null,
      },
    })
    for (const event of result.data.events) {
      expect(Object.keys(event)).toEqual([
        'id', 'occurredAt', 'actorStaffId', 'action', 'entityType', 'entityId',
        'result', 'correlationId', 'metadata',
      ])
    }
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('reason-not-readable')
    expect(serialized).not.toContain('reason_envelope')
    expect(serialized).not.toContain('display_name')
  })

  it('normalizes every exact Phase 1 identity audit shape without rewriting stored rows', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_audit_legacy_registry' })
    const facts = AUDIT_FACTS.filter(({ action }) => [
      'identity.activation',
      'staff.bootstrap',
      'staff.deactivated',
      'staff.invitation.expired',
      'staff.invited',
    ].includes(action)).map((fact) => {
      const { specialistVersion: ignored, ...metadata } = fact.metadata
      return { ...fact, metadata }
    })
    const rows = await Promise.all(facts.map((fact, index) => auditRow(context, fact, index)))
    const stored = rows.map(({ metadata_json }) => metadata_json)
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM audit_events') ? { results: rows } : undefined,
    })

    const result = await listSecurityAudit(commonInput(actor, context, {
      db,
      query: new URLSearchParams(),
    }))

    expect(result.data.events.map(({ metadata }) => metadata)).toEqual(facts.map((fact) => ({
      ...fact.metadata,
      specialistVersion: null,
    })))
    expect(rows.map(({ metadata_json }) => metadata_json)).toEqual(stored)
  })

  it('authorizes and revalidates before parsing audit query values', async () => {
    const context = await cryptoContext()
    const coordinator = await seedActiveActor({ id: 'stf_audit_query_coord', role: 'coordinator' })
    await expect(listSecurityAudit(commonInput(coordinator, context, {
      idFactory: ids('aud_audit_query_coord'),
      query: new URLSearchParams('unknown=private-cursor'),
    }))).rejects.toThrow(/^FORBIDDEN$/)
    expect(await denialRows(coordinator.id)).toHaveLength(1)

    const owner = await seedActiveActor({ id: 'stf_audit_query_owner' })
    await expect(listSecurityAudit(commonInput(owner, context, {
      query: new URLSearchParams('unknown=private-cursor'),
    }))).rejects.toThrow(/^VALIDATION_FAILED$/)
  })

  it.each([
    ['unknown action', { action: 'future.event' }],
    ['wrong entity', { entity_type: 'wrong' }],
    ['wrong result', { result: 'failure' }],
    ['noncanonical metadata', { metadata_json: '{"version":1, "extra":0}' }],
    ['string metadata version', { metadata_json: '{"version":"1"}' }],
    ['unexpected reason', { reason_envelope: '{}' }],
    ['bad stored correlation', { correlation_id: 'contains space' }],
    ['extra row key', { extra: 'private-sentinel' }],
  ])('fails the entire audit read for invalid stored event: %s', async (_label, changes) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: `stf_audit_invalid_${_label.replaceAll(/[^A-Za-z0-9_-]/g, '_')}` })
    const row = await auditRow(context, AUDIT_FACTS[4], 0, changes)
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM audit_events') ? { results: [row] } : undefined,
    })
    await expect(listSecurityAudit(commonInput(actor, context, {
      db,
      query: new URLSearchParams(),
    }))).rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
  })

  it('fails closed on authorization-denial reason-envelope corruption without decrypting it', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_audit_reason_corrupt' })
    const valid = await auditRow(context, AUDIT_FACTS[0], 0)
    const envelope = JSON.parse(valid.reason_envelope)
    const corrupt = [
      'not-json-private-reason',
      JSON.stringify({ ...envelope, nonce: '*' }),
      JSON.stringify({ ...envelope, dataKeyId: 'key_wrong_reason' }),
      JSON.stringify({ ...envelope, dataKeyVersion: envelope.dataKeyVersion + 1 }),
    ]

    for (const reason_envelope of corrupt) {
      const db = facade(env.DB, {
        all: (sql) => sql.includes('FROM audit_events')
          ? { results: [{ ...valid, reason_envelope }] }
          : undefined,
      })
      await expect(listSecurityAudit(commonInput(actor, context, {
        db,
        query: new URLSearchParams(),
      }))).rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
    }
  })

  it.each([
    ['non-null actor', { actor_staff_id: 'stf_wrong' }],
    ['wrong backup id', { entity_id: 'backup_wrong' }],
    ['wrong entity', { entity_type: 'centre' }],
    ['wrong result', { result: 'failure' }],
    ['reason present', { reason_envelope: '{}' }],
    ['zero version', { metadata_json: '{"backupVersion":0}' }],
    ['fractional version', { metadata_json: '{"backupVersion":1.5}' }],
    ['string version', { metadata_json: '{"backupVersion":"1"}' }],
    ['extra metadata', { metadata_json: '{"backupVersion":1,"extra":1}' }],
  ])('accepts no malformed backup.pruned handoff: %s', async (_label, changes) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: `stf_audit_pruned_${_label.replaceAll(/[^A-Za-z0-9_-]/g, '_')}` })
    const row = await auditRow(context, AUDIT_FACTS[1], 0, changes)
    const db = facade(env.DB, {
      all: (sql) => sql.includes('FROM audit_events') ? { results: [row] } : undefined,
    })
    await expect(listSecurityAudit(commonInput(actor, context, {
      db,
      query: new URLSearchParams(),
    }))).rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
  })

  it('paginates by a signed newest-first keyset cursor without overlap or gaps', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_audit_cursor' })
    const sameInstant = new Date(NOW_MS - 1_000).toISOString()
    const rows = [
      await auditRow(context, AUDIT_FACTS[4], 0, { id: 'audit_tie_z', occurred_at: sameInstant }),
      await auditRow(context, AUDIT_FACTS[4], 1, { id: 'audit_tie_y', occurred_at: sameInstant }),
      await auditRow(context, AUDIT_FACTS[4], 2, { id: 'audit_older', occurred_at: new Date(NOW_MS - 2_000).toISOString() }),
    ]
    const firstDb = facade(env.DB, {
      all: (sql, bindings) => {
        if (!sql.includes('FROM audit_events')) return undefined
        expect(bindings).toEqual([2])
        return { results: rows.slice(0, 2) }
      },
    })
    const first = await listSecurityAudit(commonInput(actor, context, {
      db: firstDb,
      query: new URLSearchParams('limit=1'),
    }))
    expect(first.data.events.map(({ id }) => id)).toEqual(['audit_tie_z'])
    expect(first.data.nextCursor).toMatch(/^v1\.1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    const segments = first.data.nextCursor.split('.')
    const positionText = new TextDecoder('utf-8', { fatal: true })
      .decode(decodeBase64Url(segments[2]))
    expect(JSON.parse(positionText)).toEqual({ id: 'audit_tie_z', occurredAt: sameInstant })

    const secondDb = facade(env.DB, {
      all: (sql, bindings) => {
        if (!sql.includes('FROM audit_events')) return undefined
        expect(sql).toContain('WHERE (occurred_at < ? OR (occurred_at = ? AND id < ?))')
        expect(bindings).toEqual([sameInstant, sameInstant, 'audit_tie_z', 2])
        return { results: rows.slice(1) }
      },
    })
    const second = await listSecurityAudit(commonInput(actor, context, {
      db: secondDb,
      query: new URLSearchParams({ cursor: first.data.nextCursor, limit: '1' }),
    }))
    expect(second.data.events.map(({ id }) => id)).toEqual(['audit_tie_y'])
    expect(second.data.nextCursor).not.toBeNull()

    const thirdDb = facade(env.DB, {
      all: (sql) => sql.includes('FROM audit_events') ? { results: [rows[2]] } : undefined,
    })
    const third = await listSecurityAudit(commonInput(actor, context, {
      db: thirdDb,
      query: new URLSearchParams({ cursor: second.data.nextCursor, limit: '1' }),
    }))
    expect(third.data.events.map(({ id }) => id)).toEqual(['audit_older'])
    expect(third.data.nextCursor).toBeNull()
  })

  it('accepts a cursor signed by a still-loaded historical lookup key and rejects a retired key', async () => {
    const oldContext = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_audit_historical_cursor' })
    const rows = [
      await auditRow(oldContext, AUDIT_FACTS[4], 0, { id: 'audit_historical_z' }),
      await auditRow(oldContext, AUDIT_FACTS[4], 1, { id: 'audit_historical_y' }),
    ]
    const firstDb = facade(env.DB, {
      all: (sql) => sql.includes('FROM audit_events') ? { results: rows } : undefined,
    })
    const first = await listSecurityAudit(commonInput(actor, oldContext, {
      db: firstDb,
      query: new URLSearchParams('limit=1'),
    }))

    const rotated = await cryptoContextWithLookup()
    const rotatedDb = facade(env.DB, {
      all: (sql) => sql.includes('FROM audit_events') ? { results: [] } : undefined,
    })
    await expect(listSecurityAudit(commonInput(actor, rotated, {
      db: rotatedDb,
      query: new URLSearchParams({ cursor: first.data.nextCursor }),
    }))).resolves.toEqual({ data: { events: [], nextCursor: null } })

    const retired = await cryptoContextWithLookup({ includeVersion1: false })
    await expect(listSecurityAudit(commonInput(actor, retired, {
      db: rotatedDb,
      query: new URLSearchParams({ cursor: first.data.nextCursor }),
    }))).rejects.toThrow(/^VALIDATION_FAILED$/)
  })

  it('continues without a gap from a v1 cursor with 65 loaded keys and active v65, then rejects v1 retirement', async () => {
    const context = await cryptoContextWithLookupCount(65)
    const actor = { id: 'stf_audit_cursor_v65', role: 'owner', specialistId: null, version: 1 }
    const sameInstant = new Date(NOW_MS - 1_000).toISOString()
    const position = canonicalJson({ id: 'audit_v65_z', occurredAt: sameInstant })
    const historicalCursor = await signedCursor(context, position, 1)
    expect(historicalCursor).toMatch(/^v1\.1\./)
    const younger = await auditRow(context, AUDIT_FACTS[4], 0, {
      id: 'audit_v65_y',
      occurred_at: sameInstant,
    })
    const older = await auditRow(context, AUDIT_FACTS[4], 1, {
      id: 'audit_v65_old',
      occurred_at: new Date(NOW_MS - 2_000).toISOString(),
    })
    const firstDb = facade(env.DB, {
      all(sql, bindings) {
        if (sql.includes('FROM staff_users')) return { results: [storedActorRow(actor)] }
        if (!sql.includes('FROM audit_events')) return undefined
        expect(sql).toContain('WHERE (occurred_at < ? OR (occurred_at = ? AND id < ?))')
        expect(bindings).toEqual([sameInstant, sameInstant, 'audit_v65_z', 2])
        return { results: [younger, older] }
      },
    })

    const first = await listSecurityAudit(commonInput(actor, context, {
      db: firstDb,
      query: new URLSearchParams({ cursor: historicalCursor, limit: '1' }),
    }))
    expect(first.data.events.map(({ id }) => id)).toEqual(['audit_v65_y'])
    expect(first.data.nextCursor).toMatch(/^v1\.65\./)

    const secondDb = facade(env.DB, {
      all(sql, bindings) {
        if (sql.includes('FROM staff_users')) return { results: [storedActorRow(actor)] }
        if (!sql.includes('FROM audit_events')) return undefined
        expect(bindings).toEqual([sameInstant, sameInstant, 'audit_v65_y', 2])
        return { results: [older] }
      },
    })
    const second = await listSecurityAudit(commonInput(actor, context, {
      db: secondDb,
      query: new URLSearchParams({ cursor: first.data.nextCursor, limit: '1' }),
    }))
    expect(second.data.events.map(({ id }) => id)).toEqual(['audit_v65_old'])
    expect(second.data.nextCursor).toBeNull()
    expect([...first.data.events, ...second.data.events].map(({ id }) => id)).toEqual([
      'audit_v65_y',
      'audit_v65_old',
    ])

    const retiredContext = {
      ...context,
      keyring: {
        activeLookupKeyVersion: 65,
        lookupKeyVersions: context.keyring.lookupKeyVersions.filter((version) => version !== 1),
        getDataKek: context.keyring.getDataKek,
        getLookupHmac: (version) => version === 1 ? null : context.keyring.getLookupHmac(version),
      },
    }
    let retiredAuditReads = 0
    const retiredDb = facade(env.DB, {
      all(sql) {
        if (sql.includes('FROM staff_users')) return { results: [storedActorRow(actor)] }
        if (sql.includes('FROM audit_events')) retiredAuditReads += 1
        return undefined
      },
    })
    await expect(listSecurityAudit(commonInput(actor, retiredContext, {
      db: retiredDb,
      query: new URLSearchParams({ cursor: historicalCursor }),
    }))).rejects.toThrow(/^VALIDATION_FAILED$/)
    expect(retiredAuditReads).toBe(0)
  })

  it.each(['1', '100'])('accepts canonical audit limit %s and binds limit plus one', async (limit) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: `stf_audit_limit_${limit}` })
    const db = facade(env.DB, {
      all: (sql, bindings) => {
        if (!sql.includes('FROM audit_events')) return undefined
        expect(bindings.at(-1)).toBe(Number(limit) + 1)
        return { results: [] }
      },
    })
    await expect(listSecurityAudit(commonInput(actor, context, {
      db,
      query: new URLSearchParams({ limit }),
    }))).resolves.toEqual({ data: { events: [], nextCursor: null } })
  })

  it.each([
    'limit=',
    'limit=0',
    'limit=01',
    'limit=101',
    'limit=%2B1',
    'limit=1.0',
    'limit=1&limit=2',
    'cursor=',
    'cursor=a&cursor=b',
    'unknown=1',
    'limit=1&cursor=a&unknown=1',
  ])('rejects noncanonical audit query %s', async (query) => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: `stf_audit_query_${++fixtureSerial}` })
    await expect(listSecurityAudit(commonInput(actor, context, {
      query: new URLSearchParams(query),
    }))).rejects.toThrow(/^VALIDATION_FAILED$/)
  })

  it('rejects tampered and noncanonical signed cursors with one validation error', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_audit_cursor_invalid' })
    const validPosition = canonicalJson({ id: 'audit_cursor_position', occurredAt: NOW })
    const valid = await signedCursor(context, validPosition)
    const [prefix, version, position, mac] = valid.split('.')
    const malformed = [
      `${valid}=${''}`,
      `${valid}.extra`,
      `v2.${version}.${position}.${mac}`,
      `${prefix}.01.${position}.${mac}`,
      `${prefix}.999.${position}.${mac}`,
      `${prefix}.${version}.${position}*.${mac}`,
      `${prefix}.${version}.${position}.${mac.slice(0, -1)}${mac.at(-1) === 'A' ? 'B' : 'A'}`,
      await signedCursor(context, '{"occurredAt":"2042-07-31T10:00:00.000Z","id":"audit_cursor_position"}'),
      await signedCursor(context, canonicalJson({ id: 'bad id', occurredAt: NOW })),
      await signedCursor(context, canonicalJson({ id: 'audit_cursor_position', occurredAt: '2042-07-31T10:00:00Z' })),
      await signedCursor(context, canonicalJson({ extra: 1, id: 'audit_cursor_position', occurredAt: NOW })),
    ]
    for (const cursor of malformed) {
      await expect(listSecurityAudit(commonInput(actor, context, {
        query: new URLSearchParams({ cursor }),
      }))).rejects.toThrow(/^VALIDATION_FAILED$/)
    }
  })

  it('rejects a correctly signed cursor whose position is malformed UTF-8', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_audit_cursor_utf8' })
    const malformedBytes = new Uint8Array([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0xc3, 0x28])
    const cursor = await signedCursorBytes(context, malformedBytes)
    malformedBytes.fill(0)

    await expect(listSecurityAudit(commonInput(actor, context, {
      query: new URLSearchParams({ cursor }),
    }))).rejects.toThrow(/^VALIDATION_FAILED$/)
  })

  it('validates the extra audit row and enforces the decoded keyset boundary', async () => {
    const context = await cryptoContext()
    const actor = await seedActiveActor({ id: 'stf_audit_extra_validation' })
    const first = await auditRow(context, AUDIT_FACTS[4], 0, { id: 'audit_extra_z' })
    const corrupt = { ...await auditRow(context, AUDIT_FACTS[4], 1, { id: 'audit_extra_y' }), action: 'unknown' }
    const corruptDb = facade(env.DB, {
      all: (sql) => sql.includes('FROM audit_events') ? { results: [first, corrupt] } : undefined,
    })
    await expect(listSecurityAudit(commonInput(actor, context, {
      db: corruptDb,
      query: new URLSearchParams('limit=1'),
    }))).rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)

    const cursor = await signedCursor(context, canonicalJson({
      id: first.id,
      occurredAt: first.occurred_at,
    }))
    const outOfBoundsDb = facade(env.DB, {
      all: (sql) => sql.includes('FROM audit_events') ? { results: [first] } : undefined,
    })
    await expect(listSecurityAudit(commonInput(actor, context, {
      db: outOfBoundsDb,
      query: new URLSearchParams({ cursor }),
    }))).rejects.toThrow(/^OPERATIONS_STATE_INVALID$/)
  })
})
