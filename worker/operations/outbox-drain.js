import { loadConfig } from '../config.js'
import { createD1QueryBudget } from '../db/query-budget.js'
import { dispatchOutboxJob as dispatchJob } from '../jobs/handlers.js'
import { processOutboxBatch as processBatch } from '../jobs/outbox.js'
import { safeLog as writeSafeLog } from '../logging/safe-log.js'
import { decodeBase64Url } from '../security/encoding.js'
import { createKeyring as buildKeyring } from '../security/keyring.js'

const IDENTITY_SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})
const DATA_KEY_ROW_KEYS = Object.freeze([
  'id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64',
  'wrap_nonce_b64', 'kek_version', 'created_at', 'retired_at',
])
const DEPENDENCY_FUNCTIONS = Object.freeze([
  'now',
  'createKeyring',
  'processOutboxBatch',
  'dispatchOutboxJob',
  'safeLog',
  'idFactory',
  'leaseOwnerFactory',
  'leaseNonceFactory',
  'correlationIdFactory',
])
const DEPENDENCY_KEYS = Object.freeze([
  ...DEPENDENCY_FUNCTIONS,
  'cryptoContext',
  'providers',
])
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const HEARTBEAT_KEY = 'outbox.drain.last_success'
const HEARTBEAT_ROW_KEYS = Object.freeze(['key', 'value_json', 'version', 'updated_at'])

const invalid = () => { throw new Error('OUTBOX_DRAIN_INVALID') }
const invalidState = () => { throw new Error('OUTBOX_DRAIN_STATE_INVALID') }
const heartbeatFailed = () => { throw new Error('OUTBOX_DRAIN_HEARTBEAT_FAILED') }
const ownObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const randomId = (prefix) => `${prefix}${crypto.randomUUID().replaceAll('-', '')}`

function instantFromMs(value, failure = invalid) {
  if (!Number.isSafeInteger(value) || value < 0) failure()
  let instant
  try { instant = new Date(value).toISOString() } catch { failure() }
  if (!validInstant(instant) || Date.parse(instant) !== value) failure()
  return instant
}

function validEncodedLength(value, length) {
  let decoded
  try {
    decoded = decodeBase64Url(value)
    return decoded.byteLength === length
  } catch {
    return false
  } finally {
    decoded?.fill(0)
  }
}

function validateDataKey(row) {
  if (!exactKeys(row, DATA_KEY_ROW_KEYS)
    || !ID.test(row.id ?? '')
    || row.scope_type !== IDENTITY_SCOPE.type
    || row.scope_id !== IDENTITY_SCOPE.id
    || row.purpose !== IDENTITY_SCOPE.purpose
    || row.dek_version !== 1
    || !validEncodedLength(row.wrapped_key_b64, 48)
    || !validEncodedLength(row.wrap_nonce_b64, 12)
    || !Number.isSafeInteger(row.kek_version) || row.kek_version < 1
    || !validInstant(row.created_at)
    || row.retired_at !== null) invalidState()
  return row
}

function validateHeartbeat(row) {
  if (!exactKeys(row, HEARTBEAT_ROW_KEYS)
    || row.key !== HEARTBEAT_KEY
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || !validInstant(row.updated_at)) heartbeatFailed()
  let value
  try { value = JSON.parse(row.value_json) } catch { heartbeatFailed() }
  if (!exactKeys(value, ['completedAt'])
    || JSON.stringify(value) !== row.value_json
    || (value.completedAt !== null && !validInstant(value.completedAt))
    || (row.version === 1 && value.completedAt !== null)
    || (value.completedAt !== null && value.completedAt > row.updated_at)) heartbeatFailed()
  return { ...row, value }
}

const laterInstant = (left, right) => left === null || left < right ? right : left

async function persistHeartbeat(db, attemptAt, succeeded) {
  let current
  try {
    current = validateHeartbeat(await db.prepare(
      `SELECT key,value_json,version,updated_at
       FROM system_state WHERE key='outbox.drain.last_success'`
    ).first())
  } catch {
    heartbeatFailed()
  }
  const nextVersion = current.version + 1
  if (!Number.isSafeInteger(nextVersion)) heartbeatFailed()
  const nextCompletedAt = succeeded
    ? laterInstant(current.value.completedAt, attemptAt)
    : current.value.completedAt
  const nextUpdatedAt = laterInstant(current.updated_at, attemptAt)
  const nextValueJson = JSON.stringify({ completedAt: nextCompletedAt })
  try {
    await db.batch([
      db.prepare(
        `UPDATE system_state
         SET value_json=?,version=version+1,updated_at=?
         WHERE key='outbox.drain.last_success' AND value_json=? AND version=? AND updated_at=?`
      ).bind(
        nextValueJson,
        nextUpdatedAt,
        current.value_json,
        current.version,
        current.updated_at,
      ),
      db.prepare(
        `INSERT INTO outbox_operation_guard_failures (operation_id)
         SELECT ? WHERE NOT (
           changes()=1 AND EXISTS (
             SELECT 1 FROM system_state
             WHERE key='outbox.drain.last_success' AND value_json=? AND version=? AND updated_at=?
           )
         )`
      ).bind(
        `outbox_drain_heartbeat_${nextVersion}`,
        nextValueJson,
        nextVersion,
        nextUpdatedAt,
      ),
    ])
  } catch {
    heartbeatFailed()
  }
}

function validateInvocation(input) {
  try {
    if (!ownObject(input)
      || !Object.hasOwn(input, 'scheduledTime')
      || !Object.hasOwn(input, 'env')
      || Reflect.ownKeys(input).some((key) => typeof key !== 'string'
        || !['scheduledTime', 'env', 'deps'].includes(key))) invalid()
    const env = input.env
    const rawDeps = Object.hasOwn(input, 'deps') ? input.deps : undefined
    if (!env || typeof env !== 'object'
      || !env.DB?.prepare || !env.DB?.batch
      || (rawDeps !== undefined && !ownObject(rawDeps))) invalid()
    const deps = {}
    if (rawDeps !== undefined) {
      if (Reflect.ownKeys(rawDeps).some((key) => typeof key !== 'string'
        || !DEPENDENCY_KEYS.includes(key))) invalid()
      for (const key of Object.keys(rawDeps)) deps[key] = rawDeps[key]
    }
    for (const key of DEPENDENCY_FUNCTIONS) {
      if (deps[key] !== undefined && typeof deps[key] !== 'function') invalid()
    }
    if (deps.cryptoContext !== undefined && !ownObject(deps.cryptoContext)) invalid()
    if (deps.providers !== undefined && !ownObject(deps.providers)) invalid()
    instantFromMs(input.scheduledTime)
    return {
      scheduledTime: input.scheduledTime,
      env,
      db: env.DB,
      deps,
      config: loadConfig(env),
    }
  } catch {
    invalid()
  }
}

function dependencies(input) {
  return {
    now: input.now ?? Date.now,
    createKeyring: input.createKeyring ?? buildKeyring,
    cryptoContext: input.cryptoContext,
    processOutboxBatch: input.processOutboxBatch ?? processBatch,
    dispatchOutboxJob: input.dispatchOutboxJob ?? dispatchJob,
    safeLog: input.safeLog ?? writeSafeLog,
    providers: input.providers ?? {},
    idFactory: input.idFactory ?? (() => randomId('jobrun_')),
    leaseOwnerFactory: input.leaseOwnerFactory ?? (() => randomId('lease_')),
    leaseNonceFactory: input.leaseNonceFactory ?? (() => randomId('nonce_')),
    correlationIdFactory: input.correlationIdFactory ?? (() => crypto.randomUUID()),
  }
}

function observe(now, floor) {
  let value
  try { value = now() } catch { invalidState() }
  if (!Number.isSafeInteger(value) || value < 0) invalidState()
  return Math.max(floor, value)
}

async function identityCryptoContext(db, env, config, deps) {
  if (deps.cryptoContext !== undefined) return deps.cryptoContext
  const keyring = await deps.createKeyring(env, config)
  if (!keyring || typeof keyring !== 'object' || typeof keyring.getDataKek !== 'function') {
    invalidState()
  }
  const row = await db.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
            kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1`
  ).bind(IDENTITY_SCOPE.type, IDENTITY_SCOPE.id, IDENTITY_SCOPE.purpose).first()
  if (!row) invalidState()
  const dataKey = validateDataKey(row)
  let kek
  try { kek = keyring.getDataKek(dataKey.kek_version) } catch { invalidState() }
  if (!kek) invalidState()
  return { keyring, dataKey, scope: { ...IDENTITY_SCOPE } }
}

function countsFor(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length > 1) invalidState()
  let succeededJobs = 0
  let failedJobs = 0
  for (const outcome of outcomes) {
    if (!exactKeys(outcome, ['id', 'result'])
      || !ID.test(outcome.id ?? '')
      || !['succeeded', 'retry', 'dead'].includes(outcome.result)) invalidState()
    if (outcome.result === 'succeeded') succeededJobs += 1
    else failedJobs += 1
  }
  return { claimedJobs: outcomes.length, succeededJobs, failedJobs }
}

async function emit(log, level, fields) {
  try { await log(level, fields) } catch { /* Logging does not own durable work. */ }
}

export async function runOutboxDrain(input) {
  const validated = validateInvocation(input)
  const deps = dependencies(validated.deps)
  const budget = createD1QueryBudget(validated.db, {
    totalLimit: 50,
    recoveryReserve: 3,
  })
  const env = { ...validated.env, DB: budget.work }
  let counts = { claimedJobs: 0, succeededJobs: 0, failedJobs: 0 }
  let succeeded = false
  try {
    const nowMs = observe(deps.now, validated.scheduledTime)
    const cryptoContext = await identityCryptoContext(
      budget.work,
      env,
      validated.config,
      deps,
    )
    const outcomes = await deps.processOutboxBatch({
      db: budget.work,
      cryptoContext,
      config: validated.config,
      nowMs,
      nowFactory: () => observe(deps.now, nowMs),
      idFactory: deps.idFactory,
      leaseOwnerFactory: deps.leaseOwnerFactory,
      limit: 1,
      claimScanLimit: 1,
      reapLimit: 1,
      stopAfterReap: true,
      dispatch: (dispatchInput) => deps.dispatchOutboxJob({
        ...dispatchInput,
        env,
        bindings: env,
        providers: deps.providers,
        idFactory: deps.idFactory,
        leaseOwnerFactory: deps.leaseOwnerFactory,
        leaseNonceFactory: deps.leaseNonceFactory,
        correlationIdFactory: deps.correlationIdFactory,
      }),
    })
    counts = countsFor(outcomes)
    succeeded = true
  } catch {
    // The fixed result is persisted below before it is exposed to the scheduler.
  }
  let attemptAt
  try {
    attemptAt = instantFromMs(observe(deps.now, validated.scheduledTime), heartbeatFailed)
  } catch {
    heartbeatFailed()
  }
  await persistHeartbeat(budget.recovery, attemptAt, succeeded)
  if (succeeded) {
    await emit(deps.safeLog, 'info', {
      event: 'outbox.drain.completed',
      result: 'completed',
      ...counts,
    })
    return { status: 'succeeded', reason: null, ...counts }
  }
  await emit(deps.safeLog, 'error', {
    event: 'outbox.drain.failed',
    result: 'failure',
    errorCode: 'OUTBOX_DRAIN_FAILED',
    ...counts,
  })
  return { status: 'failed', reason: 'drain_failed', ...counts }
}
