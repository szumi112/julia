import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  evaluateStoredOperationalState,
  publishScheduledOperationalState,
} from '../../worker/operations/health.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  createWrappedDataKey,
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'

const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const NOW_MS = Date.parse('2042-01-02T02:00:00.000Z')
const DENIAL_MS = NOW_MS - 86_400_000
const LEASE_MS = 900_000
const ORDINARY_TYPES = ['staff.access.reconcile', 'staff.invitation.email', 'staff.invitation.expire']

const nowIso = (ms) => new Date(ms).toISOString()

function singleReadProperty(object, key, value, marker) {
  let reads = 0
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1
      if (reads > 1) throw new Error(marker)
      return value
    },
  })
  return () => reads
}

function throwingProperty(object, key, marker) {
  let reads = 0
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1
      throw new Error(marker)
    },
  })
  return () => reads
}

function revokedObject() {
  const controlled = Proxy.revocable({}, {})
  controlled.revoke()
  return controlled.proxy
}

const tamperEncoded = (value) => `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`

async function cryptoContext() {
  const keyring = await createKeyring({
    BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }, { activeDataKekVersion: 1 })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_health_gate_d',
    createdAt: '2040-01-01T00:00:00.000Z',
  })
  return { keyring, dataKey, scope: SCOPE }
}

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  )
  return value
}
const canonical = (value) => JSON.stringify(canonicalValue(value))

async function setState(key, valueJson, updatedAt = nowIso(NOW_MS)) {
  await env.DB.prepare(
    'UPDATE system_state SET value_json=?,version=version+1,updated_at=? WHERE key=?'
  ).bind(valueJson, updatedAt, key).run()
}

async function seedScheduler({
  id,
  scheduledFor,
  startedAt = scheduledFor,
  completedAt = scheduledFor,
  status = 'succeeded',
  attemptCount = 1,
  leaseOwner = `lease_${id}`,
  leaseExpiresAt = nowIso(Date.parse(scheduledFor) + LEASE_MS),
  claimedJobs = 0,
  succeededJobs = 0,
  failedJobs = 0,
  errorCode = null,
}) {
  await env.DB.prepare(
    `INSERT INTO scheduler_runs
     (id,scheduled_for,started_at,completed_at,status,attempt_count,lease_owner,
      lease_expires_at,claimed_jobs,succeeded_jobs,failed_jobs,error_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, scheduledFor, startedAt, status === 'running' ? null : completedAt, status,
    attemptCount, leaseOwner, leaseExpiresAt, claimedJobs, succeededJobs, failedJobs, errorCode,
  ).run()
}

const BACKUP_COLUMNS = [
  'id', 'local_day', 'local_month', 'retention_class', 'status', 'version',
  'export_bookmark', 'object_key', 'manifest_key', 'ssec_key_version',
  'wrapped_ssec_key_b64', 'wrap_nonce_b64', 'object_etag', 'object_size',
  'started_at', 'completed_at', 'expires_at', 'restore_verified_at',
  'last_error_code', 'created_at', 'updated_at',
]

async function seedBackup({ id, status, createdAt, completedAt = createdAt, updatedAt = createdAt }) {
  const stored = ['stored', 'restore_verified'].includes(status)
  const values = {
    id,
    local_day: createdAt.slice(0, 10),
    local_month: createdAt.slice(0, 7),
    retention_class: 'daily',
    status,
    version: 1,
    export_bookmark: stored ? 'bookmark' : null,
    object_key: stored ? 'object' : null,
    manifest_key: stored ? 'manifest' : null,
    ssec_key_version: stored ? 1 : null,
    wrapped_ssec_key_b64: stored ? 'wrapped' : null,
    wrap_nonce_b64: stored ? 'nonce' : null,
    object_etag: stored ? 'etag' : null,
    object_size: stored ? 1 : null,
    started_at: status === 'queued' ? null : createdAt,
    completed_at: ['queued', 'exporting'].includes(status) ? null : completedAt,
    expires_at: stored ? nowIso(Date.parse(completedAt) + 86_400_000) : null,
    restore_verified_at: status === 'restore_verified' ? completedAt : null,
    last_error_code: status === 'failed' ? 'PRIVATE_BACKUP_ERROR' : null,
    created_at: createdAt,
    updated_at: updatedAt,
  }
  await env.DB.prepare(
    `INSERT INTO backup_runs (${BACKUP_COLUMNS.join(',')})
     VALUES (${BACKUP_COLUMNS.map(() => '?').join(',')})`
  ).bind(...BACKUP_COLUMNS.map((key) => values[key])).run()
}

async function seedOutbox({
  id,
  type = ORDINARY_TYPES[0],
  status = 'succeeded',
  updatedAt = nowIso(NOW_MS),
}) {
  await env.DB.prepare(
    `INSERT INTO outbox_jobs
     (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
      attempt_count,max_attempts,scheduled_at,lease_owner,lease_expires_at,
      last_error_code,created_at,updated_at)
     VALUES (?,?,'fixture','fixture','{}',?,?,1,8,?,NULL,NULL,?,?,?)`
  ).bind(
    id, type, `key_${id}`, status, updatedAt,
    status === 'dead' ? 'OUTBOX_DELIVERY_FAILED' : null, updatedAt, updatedAt,
  ).run()
}

async function seedStaff(actorId) {
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,version,created_at,updated_at)
     VALUES (?,?,?,?,?,'pending',1,?,?)`
  ).bind(actorId, `lookup_${actorId}`, '{}', '{}', 'coordinator', nowIso(NOW_MS), nowIso(NOW_MS)).run()
}

async function seedDenial(context, {
  id,
  actorId,
  occurredAt,
  reason = 'operations.health.read denied',
  metadataJson = '{"version":1}',
  entityType = 'staff_user',
  entityId = actorId,
  result = 'denied',
  envelope = null,
}) {
  const reasonEnvelope = envelope ?? JSON.stringify(await encryptForScope(
    context.keyring,
    context.dataKey,
    {
      expectedScope: context.scope,
      recordId: id,
      field: 'reason',
      plaintext: reason,
    },
  ))
  await env.DB.prepare(
    `INSERT INTO audit_events
     (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
      reason_envelope,correlation_id,metadata_json)
     VALUES (?,?,?,'authorization.denied',?,?,?,?,?,?)`
  ).bind(
    id, occurredAt, actorId, entityType, entityId, result,
    reasonEnvelope, `cor_${id}`, metadataJson,
  ).run()
}

async function actionEnvelope(context, id, details) {
  return JSON.stringify(await encryptForScope(context.keyring, context.dataKey, {
    expectedScope: context.scope,
    recordId: id,
    field: 'action_details',
    plaintext: JSON.stringify(Object.fromEntries(Object.entries(details).sort(([left], [right]) => left.localeCompare(right)))),
  }))
}

async function seedAction(context, {
  id,
  fingerprint,
  kind,
  severity,
  entityType,
  entityId,
  details,
  status = 'open',
  createdAt = nowIso(NOW_MS - 600_000),
  resolvedAt = status === 'resolved' ? nowIso(NOW_MS - 300_000) : null,
  version = status === 'resolved' ? 2 : 1,
}) {
  const updatedAt = resolvedAt ?? createdAt
  await env.DB.prepare(
    `INSERT INTO operational_actions
     (id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
      version,created_at,updated_at,resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, fingerprint, kind, severity, status, entityType, entityId,
    await actionEnvelope(context, id, details), version, createdAt, updatedAt, resolvedAt,
  ).run()
}

async function actionRow(context, {
  id,
  fingerprint,
  kind,
  severity,
  entityType,
  entityId,
  details,
  status = 'open',
  createdAt = nowIso(NOW_MS - 600_000),
  resolvedAt = status === 'resolved' ? nowIso(NOW_MS - 300_000) : null,
  version = status === 'resolved' ? 2 : 1,
}) {
  return {
    id,
    fingerprint,
    kind,
    severity,
    status,
    entity_type: entityType,
    entity_id: entityId,
    details_envelope: await actionEnvelope(context, id, details),
    version,
    created_at: createdAt,
    updated_at: resolvedAt ?? createdAt,
    resolved_at: resolvedAt,
  }
}

const checkFor = (result, id) => result.snapshot.checks.find((item) => item.id === id)

async function evaluate(nowMs = NOW_MS, changes = {}) {
  return evaluateStoredOperationalState({
    db: env.DB,
    cryptoContext: await cryptoContext(),
    nowMs,
    prospectiveSchedulerRun: null,
    ...changes,
  })
}

function trackedDb(real, hooks = {}) {
  const wrap = (inner, sql) => ({
    __inner: inner,
    __sql: sql,
    bind(...values) { return wrap(inner.bind(...values), sql) },
    run: () => inner.run(),
    async first(column) {
      const replacement = await hooks.first?.({ sql, column })
      return replacement === undefined ? inner.first(column) : replacement
    },
    async all() {
      const replacement = await hooks.all?.({ sql })
      return replacement === undefined ? inner.all() : replacement
    },
    raw: (options) => inner.raw(options),
  })
  return {
    prepare(sql) {
      hooks.prepare?.(sql)
      return wrap(real.prepare(sql), sql)
    },
    async batch(statements) {
      const sql = statements.map((statement) => statement.__sql ?? '')
      const execute = () => real.batch(statements.map((statement) => statement.__inner ?? statement))
      return hooks.batch ? hooks.batch({ statements, sql, execute }) : execute()
    },
  }
}

const backupFact = ({ id, status, completedAt, createdAt = completedAt, updatedAt = createdAt }) => ({
  id,
  status,
  completed_at: ['queued', 'exporting'].includes(status) ? null : completedAt,
  last_error_code: status === 'failed' ? 'PRIVATE_BACKUP_ERROR' : null,
  created_at: createdAt,
  updated_at: updatedAt,
})

function healthReadDb({
  earliest,
  backupAttempt,
  backupSuccess,
  deadJob,
  succeededJob,
  schedulerSuccess,
  openAction,
} = {}) {
  return trackedDb(env.DB, {
    first({ sql }) {
      if (sql.includes('FROM scheduler_runs') && sql.includes('ORDER BY scheduled_for ASC')) return earliest ?? null
      if (sql.includes('FROM backup_runs') && sql.includes("WHERE status IN ('stored','restore_verified')")) return backupSuccess ?? null
      if (sql.includes('FROM backup_runs') && sql.includes('ORDER BY created_at DESC')) return backupAttempt ?? null
      if (sql.includes('FROM outbox_jobs') && sql.includes("status='dead'")) return deadJob ?? null
      if (sql.includes('FROM outbox_jobs') && sql.includes("status='succeeded'")) return succeededJob ?? null
      if (sql.includes('FROM scheduler_runs') && sql.includes("WHERE status='succeeded'")) return schedulerSuccess ?? null
      if (sql.includes('FROM operational_actions') && sql.includes("status='open'")) return openAction ?? null
      return undefined
    },
    all({ sql }) {
      if (sql.includes('FROM operational_actions') && sql.includes("status='open'")) {
        return { results: openAction ? [openAction] : [] }
      }
      return undefined
    },
  })
}

let publisherSerial = 0
let invalidDenialSerial = 0

async function publisherFixture({ id = 'run_publish', scheduledFor } = {}) {
  const exactScheduledFor = scheduledFor ?? nowIso(NOW_MS - 10_000 - (++publisherSerial))
  const leaseOwner = `lease_${id}`
  const leaseExpiresAt = nowIso(NOW_MS + LEASE_MS)
  await seedScheduler({
    id,
    scheduledFor: exactScheduledFor,
    status: 'running',
    completedAt: null,
    leaseOwner,
    leaseExpiresAt,
  })
  return {
    context: await cryptoContext(),
    run: {
      id,
      scheduledFor: exactScheduledFor,
      attemptCount: 1,
      leaseOwner,
      leaseExpiresAt,
      claimedJobs: 3,
      succeededJobs: 2,
      failedJobs: 1,
    },
  }
}

const idSequence = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

describe('stored operational health evaluation', () => {
  it('returns the exact four checks in Polish label order with exact fields only', async () => {
    const result = await evaluateStoredOperationalState({
      db: env.DB,
      cryptoContext: await cryptoContext(),
      nowMs: NOW_MS,
      prospectiveSchedulerRun: null,
    })

    expect(Object.keys(result)).toEqual(['snapshot', 'actionCandidates'])
    expect(Object.keys(result.snapshot)).toEqual(['generatedAt', 'checks'])
    expect(result.snapshot.generatedAt).toBe(nowIso(NOW_MS))
    expect(result.snapshot.checks).toEqual([
      {
        id: 'outbox.processing',
        label: 'Kolejka zadań',
        status: 'ok',
        lastSuccessAt: null,
        detailCode: 'OUTBOX_HEALTHY',
      },
      {
        id: 'backup.freshness',
        label: 'Kopie zapasowe',
        status: 'ok',
        lastSuccessAt: null,
        detailCode: 'BACKUP_NOT_DUE',
      },
      {
        id: 'access.reconciliation',
        label: 'Synchronizacja dostępu',
        status: 'ok',
        lastSuccessAt: '2026-07-30T00:00:00.000Z',
        detailCode: 'ACCESS_CURRENT',
      },
      {
        id: 'scheduler.runs',
        label: 'Zadania cykliczne',
        status: 'warning',
        lastSuccessAt: null,
        detailCode: 'SCHEDULER_STARTING',
      },
    ])
    for (const check of result.snapshot.checks) {
      expect(Object.keys(check)).toEqual(['id', 'label', 'status', 'lastSuccessAt', 'detailCode'])
    }
    expect(result.actionCandidates).toEqual([])
  })

  it('accepts epoch nowMs while binding the exact pre-epoch denial lower edge', async () => {
    const result = await evaluate(0, { db: healthReadDb() })
    expect(result.snapshot.generatedAt).toBe('1970-01-01T00:00:00.000Z')
    expect(result.actionCandidates).toEqual([])
  })

  it('normalizes a malformed injected identity crypto context before any stored reads', async () => {
    const context = await cryptoContext()
    await expect(evaluateStoredOperationalState({
      db: env.DB,
      cryptoContext: {
        ...context,
        dataKey: { ...context.dataKey, wrapped_key_b64: 'bad' },
      },
      nowMs: NOW_MS,
      prospectiveSchedulerRun: null,
    })).rejects.toThrow(/^HEALTH_INVALID$/)
  })

  it('normalizes revoked and throwing evaluator input boundaries without leaking markers', async () => {
    const context = await cryptoContext()
    const base = {
      db: env.DB,
      cryptoContext: context,
      nowMs: NOW_MS,
      prospectiveSchedulerRun: null,
    }
    await expect(evaluateStoredOperationalState(revokedObject()))
      .rejects.toThrow(/^HEALTH_INVALID$/)

    const marker = 'private-evaluator-getter-marker'
    const throwingInput = { ...base }
    const inputReads = throwingProperty(throwingInput, 'nowMs', marker)
    await expect(evaluateStoredOperationalState(throwingInput))
      .rejects.toThrow(/^HEALTH_INVALID$/)
    expect(inputReads()).toBe(1)

    const throwingScope = { ...SCOPE }
    const scopeReads = throwingProperty(throwingScope, 'purpose', marker)
    await expect(evaluateStoredOperationalState({
      ...base,
      cryptoContext: { ...context, scope: throwingScope },
    })).rejects.toThrow(/^HEALTH_INVALID$/)
    expect(scopeReads()).toBe(1)

    await expect(evaluateStoredOperationalState({
      ...base,
      cryptoContext: { ...context, dataKey: revokedObject() },
    })).rejects.toThrow(/^HEALTH_INVALID$/)
  })

  it('snapshots evaluator getters once before stored reads and crypto work', async () => {
    const context = await cryptoContext()
    const marker = 'private-evaluator-changing-marker'

    const root = {
      db: env.DB,
      cryptoContext: context,
      nowMs: NOW_MS,
      prospectiveSchedulerRun: null,
    }
    const contextReads = singleReadProperty(root, 'cryptoContext', context, marker)
    expect((await evaluateStoredOperationalState(root)).snapshot.generatedAt).toBe(nowIso(NOW_MS))
    expect(contextReads()).toBe(1)

    const db = { batch: env.DB.batch.bind(env.DB) }
    const prepareReads = singleReadProperty(db, 'prepare', env.DB.prepare.bind(env.DB), marker)
    expect((await evaluateStoredOperationalState({
      db,
      cryptoContext: context,
      nowMs: NOW_MS,
      prospectiveSchedulerRun: null,
    })).snapshot.generatedAt).toBe(nowIso(NOW_MS))
    expect(prepareReads()).toBe(1)

    const prospective = { id: 'run_changing_prospective', completedAt: nowIso(NOW_MS) }
    const completedAtReads = singleReadProperty(
      prospective, 'completedAt', nowIso(NOW_MS), marker,
    )
    expect(checkFor(await evaluateStoredOperationalState({
      db: env.DB,
      cryptoContext: context,
      nowMs: NOW_MS,
      prospectiveSchedulerRun: prospective,
    }), 'scheduler.runs').detailCode).toBe('SCHEDULER_HEALTHY')
    expect(completedAtReads()).toBe(1)

    const at = DENIAL_MS - 31 * 86_400_000
    const actorId = 'stf_changing_data_key'
    await seedStaff(actorId)
    await seedDenial(context, {
      id: 'aud_changing_data_key',
      actorId,
      occurredAt: nowIso(at),
      reason: 'staff invitation rate limit',
    })
    const dataKey = { ...context.dataKey }
    const dataKeyIdReads = singleReadProperty(dataKey, 'id', context.dataKey.id, marker)
    expect((await evaluateStoredOperationalState({
      db: env.DB,
      cryptoContext: { ...context, dataKey },
      nowMs: at,
      prospectiveSchedulerRun: null,
    })).actionCandidates).toEqual([])
    expect(dataKeyIdReads()).toBe(1)
  })

  it('preserves a genuine D1 failure after evaluator input capture', async () => {
    const context = await cryptoContext()
    const db = {
      prepare() { throw new Error('D1_DOWNSTREAM_FAILURE') },
      batch: env.DB.batch.bind(env.DB),
    }
    await expect(evaluateStoredOperationalState({
      db,
      cryptoContext: context,
      nowMs: NOW_MS,
      prospectiveSchedulerRun: null,
    })).rejects.toThrow(/^D1_DOWNSTREAM_FAILURE$/)
  })

  it('reports access lag and creates its one exact critical candidate', async () => {
    await setState('access.desired_generation', '{"generation":3}')
    const result = await evaluate()
    expect(checkFor(result, 'access.reconciliation')).toEqual({
      id: 'access.reconciliation',
      label: 'Synchronizacja dostępu',
      status: 'critical',
      lastSuccessAt: '2026-07-30T00:00:00.000Z',
      detailCode: 'ACCESS_RECONCILIATION_LAG',
    })
    expect(result.actionCandidates).toContainEqual({
      fingerprint: 'access.reconciliation_lag',
      kind: 'access_reconciliation_lag',
      severity: 'critical',
      entityType: 'access_group',
      entityId: 'centre_1',
      details: {
        appliedGeneration: 0,
        desiredGeneration: 3,
        errorCode: 'ACCESS_RECONCILIATION_LAG',
      },
    })
    await setState('access.desired_generation', '{"generation":0}')
  })

  it.each([
    ['noncanonical desired JSON', 'access.desired_generation', '{ "generation":0}'],
    ['extra desired key', 'access.desired_generation', '{"extra":1,"generation":0}'],
    ['fractional desired generation', 'access.desired_generation', '{"generation":1.5}'],
    ['bad applied fingerprint', 'access.applied_generation', '{"fingerprint":"bad","generation":0}'],
    ['applied ahead of desired', 'access.applied_generation', '{"fingerprint":"BYDlKyUUBNO-3cX7_bRPY-TkArudTPGjIdbwtAdLSCw","generation":1}'],
  ])('fails closed for %s', async (_label, key, valueJson) => {
    const original = key === 'access.desired_generation'
      ? '{"generation":0}'
      : '{"fingerprint":"BYDlKyUUBNO-3cX7_bRPY-TkArudTPGjIdbwtAdLSCw","generation":0}'
    await setState(key, valueJson)
    try {
      await expect(evaluate()).rejects.toThrow(/^HEALTH_STATE_INVALID$/)
    } finally {
      await setState(key, original)
    }
  })

  it.each([
    ['before spring window', '2027-03-28T00:00:00.000Z', '2027-03-28T01:14:00.000Z', 'ok', 'BACKUP_NOT_DUE'],
    ['at spring window', '2027-03-28T00:00:00.000Z', '2027-03-28T01:15:00.000Z', 'warning', 'BACKUP_PENDING'],
    ['before fall window', '2027-10-31T00:00:00.000Z', '2027-10-31T02:14:00.000Z', 'ok', 'BACKUP_NOT_DUE'],
    ['at fall window', '2027-10-31T00:00:00.000Z', '2027-10-31T02:15:00.000Z', 'warning', 'BACKUP_PENDING'],
  ])('derives the first actual Warsaw 03:15 baseline %s', async (_label, scheduledFor, at, status, detailCode) => {
    const result = await evaluate(Date.parse(at), {
      db: healthReadDb({ earliest: { id: `run_${_label.replaceAll(' ', '_')}`, scheduled_for: scheduledFor } }),
    })
    expect(checkFor(result, 'backup.freshness')).toMatchObject({ status, detailCode })
  })

  it('uses the next local 03:15 after a same-day late first schedule', async () => {
    const db = healthReadDb({
      earliest: { id: 'run_after_first_window', scheduled_for: '2042-01-01T04:00:00.000Z' },
    })
    expect(checkFor(await evaluate(Date.parse('2042-01-02T02:14:00.000Z'), { db }), 'backup.freshness'))
      .toMatchObject({ status: 'ok', detailCode: 'BACKUP_NOT_DUE' })
    expect(checkFor(await evaluate(Date.parse('2042-01-02T02:15:00.000Z'), { db }), 'backup.freshness'))
      .toMatchObject({ status: 'warning', detailCode: 'BACKUP_PENDING' })
  })

  it('pins the latest successful backup lookup to its bounded partial index', async () => {
    const prepared = []
    const db = trackedDb(healthReadDb(), { prepare: (sql) => prepared.push(sql) })

    await evaluate(NOW_MS, { db })

    const successSql = prepared.find((sql) => (
      sql.includes("WHERE status IN ('stored','restore_verified')")
    ))
    expect(successSql).toContain(
      'FROM backup_runs INDEXED BY backup_runs_success_completed_id_idx'
    )
  })

  it.each([
    ['pending', null, NOW_MS, 'warning', 'BACKUP_PENDING'],
    ['missing after threshold', null, NOW_MS + 36 * 3_600_000 + 1, 'critical', 'BACKUP_STALE'],
    ['fresh', { id: 'bkp_fresh', status: 'stored', completedOffset: -10 * 3_600_000 }, NOW_MS, 'ok', 'BACKUP_FRESH'],
    ['exactly 36h', { id: 'bkp_edge', status: 'stored', completedOffset: -36 * 3_600_000 }, NOW_MS, 'ok', 'BACKUP_FRESH'],
    ['after 36h', { id: 'bkp_stale', status: 'stored', completedOffset: -36 * 3_600_000 - 1 }, NOW_MS, 'critical', 'BACKUP_STALE'],
  ])('evaluates backup state %s', async (_label, backup, at, status, detailCode) => {
    const stored = backup
      ? backupFact({
          id: backup.id,
          status: backup.status,
          completedAt: nowIso(NOW_MS + backup.completedOffset),
        })
      : null
    const result = await evaluate(at, {
      db: healthReadDb({
        earliest: { id: `run_backup_${_label.replaceAll(' ', '_')}`, scheduled_for: '2042-01-01T02:00:00.000Z' },
        backupAttempt: stored,
        backupSuccess: stored,
      }),
    })
    expect(checkFor(result, 'backup.freshness')).toMatchObject({
      status,
      detailCode,
      lastSuccessAt: backup ? nowIso(NOW_MS + backup.completedOffset) : null,
    })
    if (detailCode === 'BACKUP_STALE') expect(result.actionCandidates).toContainEqual({
      fingerprint: 'backup.stale',
      kind: 'backup_stale',
      severity: 'critical',
      entityType: 'centre',
      entityId: 'centre_1',
      details: { errorCode: 'BACKUP_STALE', thresholdHours: 36 },
    })
  })

  it('gives the latest failed attempt precedence while retaining the last stored success', async () => {
    const success = backupFact({
      id: 'bkp_prior_success', status: 'stored', completedAt: nowIso(NOW_MS - 60_000),
    })
    const failure = backupFact({
      id: 'bkp_latest_failed', status: 'failed', completedAt: nowIso(NOW_MS),
    })
    const result = await evaluate(NOW_MS, { db: healthReadDb({
      earliest: { id: 'run_backup_failed', scheduled_for: '2042-01-01T02:00:00.000Z' },
      backupAttempt: failure,
      backupSuccess: success,
    }) })
    expect(checkFor(result, 'backup.freshness')).toMatchObject({
      status: 'critical',
      detailCode: 'BACKUP_FAILED',
      lastSuccessAt: nowIso(NOW_MS - 60_000),
    })
    expect(result.actionCandidates).toContainEqual({
      fingerprint: 'backup.failed:bkp_latest_failed',
      kind: 'backup_failed',
      severity: 'critical',
      entityType: 'backup_run',
      entityId: 'bkp_latest_failed',
      details: { backupId: 'bkp_latest_failed', errorCode: 'BACKUP_FAILED' },
    })
  })

  it.each(['backup_failed_invalid_prefix', 'bkp_'])(
    'rejects invalid selected and stored backup_failed relationship ID %s',
    async (backupId) => {
      const context = await cryptoContext()
      const openAction = await actionRow(context, {
        id: `opa_invalid_backup_id_${backupId}`,
        fingerprint: `backup.failed:${backupId}`,
        kind: 'backup_failed',
        severity: 'critical',
        entityType: 'backup_run',
        entityId: backupId,
        details: { backupId, errorCode: 'BACKUP_FAILED' },
      })
      const db = healthReadDb({
        earliest: {
          id: `run_invalid_backup_id_${backupId}`,
          scheduled_for: nowIso(NOW_MS - 86_400_000),
        },
        backupAttempt: backupFact({
          id: backupId,
          status: 'failed',
          completedAt: nowIso(NOW_MS),
        }),
        openAction,
      })
      await expect(evaluateStoredOperationalState({
        db,
        cryptoContext: context,
        nowMs: NOW_MS,
        prospectiveSchedulerRun: null,
      })).rejects.toThrow(/^HEALTH_STATE_INVALID$/)
    },
  )

  it('does not treat pruned as success and does not let it erase an earlier stored success', async () => {
    const success = backupFact({
      id: 'bkp_stored_before_prune', status: 'stored', completedAt: nowIso(NOW_MS - 60_000),
    })
    const pruned = backupFact({
      id: 'bkp_pruned_latest', status: 'pruned', completedAt: nowIso(NOW_MS),
    })
    expect(checkFor(await evaluate(NOW_MS, { db: healthReadDb({
      earliest: { id: 'run_backup_pruned', scheduled_for: '2042-01-01T02:00:00.000Z' },
      backupAttempt: pruned,
      backupSuccess: success,
    }) }), 'backup.freshness')).toMatchObject({
      status: 'ok',
      detailCode: 'BACKUP_FRESH',
      lastSuccessAt: nowIso(NOW_MS - 60_000),
    })
  })

  it('reports ordinary dead and latest-success facts without creating another action', async () => {
    const result = await evaluate(NOW_MS, { db: healthReadDb({
      deadJob: { id: 'job_dead', type: ORDINARY_TYPES[1], status: 'dead', updated_at: nowIso(NOW_MS) },
      succeededJob: { id: 'job_success_new', type: ORDINARY_TYPES[2], status: 'succeeded', updated_at: nowIso(NOW_MS - 1_000) },
    }) })
    expect(checkFor(result, 'outbox.processing')).toMatchObject({
      status: 'critical',
      detailCode: 'OUTBOX_DEAD',
      lastSuccessAt: nowIso(NOW_MS - 1_000),
    })
    expect(result.actionCandidates.some(({ kind }) => kind === 'outbox_job_failed')).toBe(false)
  })

  it('excludes dormant failed backup.create history from ordinary outbox health', async () => {
    expect(checkFor(await evaluate(), 'outbox.processing')).toMatchObject({
      status: 'ok', detailCode: 'OUTBOX_HEALTHY', lastSuccessAt: null,
    })
  })

  it.each([
    ['exact threshold', -LEASE_MS, 'ok', 'SCHEDULER_HEALTHY'],
    ['older threshold', -LEASE_MS - 1, 'critical', 'SCHEDULER_STALE'],
  ])('evaluates persisted scheduler success at the %s', async (_label, offset, status, detailCode) => {
    const completedAt = nowIso(NOW_MS + offset)
    const result = await evaluate(NOW_MS, { db: healthReadDb({ schedulerSuccess: {
      id: `run_scheduler_${status}`, scheduled_for: completedAt, completed_at: completedAt, status: 'succeeded',
    } }) })
    expect(checkFor(result, 'scheduler.runs')).toMatchObject({ status, detailCode, lastSuccessAt: completedAt })
  })

  it('publishes a prospective success as healthy and opens only a recovered stale-gap action', async () => {
    const previousAt = nowIso(NOW_MS - LEASE_MS - 1)
    const result = await evaluate(NOW_MS, {
      db: healthReadDb({ schedulerSuccess: {
        id: 'run_previous_stale', scheduled_for: previousAt, completed_at: previousAt, status: 'succeeded',
      } }),
      prospectiveSchedulerRun: { id: 'run_current', completedAt: nowIso(NOW_MS) },
    })
    expect(checkFor(result, 'scheduler.runs')).toEqual({
      id: 'scheduler.runs', label: 'Zadania cykliczne', status: 'ok',
      lastSuccessAt: nowIso(NOW_MS), detailCode: 'SCHEDULER_HEALTHY',
    })
    expect(result.actionCandidates).toContainEqual({
      fingerprint: 'scheduler.stale',
      kind: 'scheduler_stale',
      severity: 'critical',
      entityType: 'scheduler_run',
      entityId: 'run_previous_stale',
      details: {
        errorCode: 'SCHEDULER_STALE',
        schedulerRunId: 'run_previous_stale',
        thresholdMinutes: 15,
      },
    })
  })

  it('maps only the three closed denial reasons and separates actor/capability groups', async () => {
    const context = await cryptoContext()
    await seedStaff('stf_denial_a')
    await seedStaff('stf_denial_b')
    for (let index = 0; index < 10; index += 1) {
      await seedDenial(context, {
        id: `aud_health_a_${index}`,
        actorId: 'stf_denial_a',
        occurredAt: nowIso(DENIAL_MS - 10_000 - index),
        reason: 'operations.health.read denied',
      })
      await seedDenial(context, {
        id: `aud_health_b_${index}`,
        actorId: 'stf_denial_b',
        occurredAt: nowIso(DENIAL_MS - 20_000 - index),
        reason: 'security.audit.read denied',
      })
    }
    await seedDenial(context, {
      id: 'aud_known_rate_limit',
      actorId: 'stf_denial_a',
      occurredAt: nowIso(DENIAL_MS),
      reason: 'staff invitation rate limit',
    })
    await env.DB.prepare(
      `INSERT INTO audit_events
       (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
        reason_envelope,correlation_id,metadata_json)
       VALUES ('aud_null_actor',?,NULL,'authorization.denied','staff_user','stf_ignored',
               'denied','plaintext-not-selected','cor_null_actor','{"version":1}')`
    ).bind(nowIso(DENIAL_MS)).run()

    const result = await evaluate(DENIAL_MS)
    expect(result.actionCandidates.filter(({ kind }) => kind === 'authorization_denial_spike')).toEqual([
      {
        fingerprint: 'security.authorization_denials:stf_denial_a:operations.health.read',
        kind: 'authorization_denial_spike',
        severity: 'warning',
        entityType: 'staff_user',
        entityId: 'stf_denial_a',
        details: {
          actorId: 'stf_denial_a',
          capability: 'operations.health.read',
          count: 10,
          errorCode: 'AUTHORIZATION_DENIAL_SPIKE',
          threshold: 10,
        },
      },
      {
        fingerprint: 'security.authorization_denials:stf_denial_b:security.audit.read',
        kind: 'authorization_denial_spike',
        severity: 'warning',
        entityType: 'staff_user',
        entityId: 'stf_denial_b',
        details: {
          actorId: 'stf_denial_b',
          capability: 'security.audit.read',
          count: 10,
          errorCode: 'AUTHORIZATION_DENIAL_SPIKE',
          threshold: 10,
        },
      },
    ])
  })

  it.each([
    ['constructor', 1, 41],
    ['constructor', 10, 42],
    ['toString', 1, 43],
    ['toString', 10, 44],
  ])('rejects inherited prototype denial reason %s at %i events without residue', async (reason, count, daysAgo) => {
    const fixture = await publisherFixture({ id: `run_prototype_reason_${reason}_${count}` })
    const actorId = `stf_prototype_reason_${reason}_${count}`
    const at = DENIAL_MS - daysAgo * 86_400_000
    await seedStaff(actorId)
    for (let index = 0; index < count; index += 1) await seedDenial(fixture.context, {
      id: `aud_prototype_reason_${reason}_${count}_${index}`,
      actorId,
      occurredAt: nowIso(at - index),
      reason,
    })
    const beforeActions = (await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions'
    ).first()).count
    const beforeSnapshot = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()

    await expect(evaluateStoredOperationalState({
      db: env.DB,
      cryptoContext: fixture.context,
      nowMs: at,
      prospectiveSchedulerRun: null,
    })).rejects.toThrow(/^AUTHORIZATION_DENIAL_STATE_INVALID$/)
    await expect(publishScheduledOperationalState({
      db: env.DB,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence(`opa_prototype_reason_${reason}_${count}`),
      now: () => at,
    })).rejects.toThrow(/^AUTHORIZATION_DENIAL_STATE_INVALID$/)

    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions'
    ).first()).count).toBe(beforeActions)
    expect(await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual(beforeSnapshot)
    expect((await env.DB.prepare('SELECT status FROM scheduler_runs WHERE id=?')
      .bind(fixture.run.id).first()).status).toBe('running')
  })

  it('includes the denial lower edge, excludes future rows, and opens at ten not nine', async () => {
    const context = await cryptoContext()
    await seedStaff('stf_denial_bounds')
    for (let index = 0; index < 9; index += 1) await seedDenial(context, {
      id: `aud_bounds_${index}`,
      actorId: 'stf_denial_bounds',
      occurredAt: nowIso(DENIAL_MS - LEASE_MS + index),
      reason: 'staff.manage denied',
    })
    expect((await evaluate(DENIAL_MS)).actionCandidates.some(
      ({ entityId, kind }) => kind === 'authorization_denial_spike' && entityId === 'stf_denial_bounds'
    )).toBe(false)
    await seedDenial(context, {
      id: 'aud_bounds_tenth',
      actorId: 'stf_denial_bounds',
      occurredAt: nowIso(DENIAL_MS),
      reason: 'staff.manage denied',
    })
    await seedDenial(context, {
      id: 'aud_bounds_future',
      actorId: 'stf_denial_bounds',
      occurredAt: nowIso(DENIAL_MS + 1),
      reason: 'staff.manage denied',
    })
    const candidate = (await evaluate(DENIAL_MS)).actionCandidates.find(
      ({ entityId, kind }) => kind === 'authorization_denial_spike' && entityId === 'stf_denial_bounds'
    )
    expect(candidate.details).toMatchObject({ capability: 'staff.manage', count: 10, threshold: 10 })
  })

  it('requires ten denials strictly after a newer matching resolution', async () => {
    const context = await cryptoContext()
    const actorId = 'stf_denial_resolved'
    await seedStaff(actorId)
    const fingerprint = `security.authorization_denials:${actorId}:staff.manage`
    const resolvedAt = DENIAL_MS - 300_000
    await seedAction(context, {
      id: 'opa_denial_resolved',
      fingerprint,
      kind: 'authorization_denial_spike',
      severity: 'warning',
      entityType: 'staff_user',
      entityId: actorId,
      details: {
        actorId,
        capability: 'staff.manage',
        count: 12,
        errorCode: 'AUTHORIZATION_DENIAL_SPIKE',
        threshold: 10,
      },
      status: 'resolved',
      createdAt: nowIso(DENIAL_MS - 600_000),
      resolvedAt: nowIso(resolvedAt),
    })
    for (let index = 0; index < 10; index += 1) await seedDenial(context, {
      id: `aud_resolution_edge_${index}`,
      actorId,
      occurredAt: index === 0 ? nowIso(resolvedAt) : nowIso(resolvedAt + index),
      reason: 'staff.manage denied',
    })
    expect((await evaluate(DENIAL_MS)).actionCandidates.some(({ fingerprint: value }) => value === fingerprint)).toBe(false)
    await seedDenial(context, {
      id: 'aud_resolution_tenth_new',
      actorId,
      occurredAt: nowIso(resolvedAt + 10),
      reason: 'staff.manage denied',
    })
    const candidate = (await evaluate(DENIAL_MS)).actionCandidates.find(({ fingerprint: value }) => value === fingerprint)
    expect(candidate.details.count).toBe(10)
  })

  it('fails on the malformed newest resolution instead of falling back to older valid history', async () => {
    const context = await cryptoContext()
    const actorId = 'stf_denial_bad_resolution'
    const at = DENIAL_MS - 4 * 86_400_000
    const fingerprint = `security.authorization_denials:${actorId}:staff.manage`
    await seedStaff(actorId)
    await seedAction(context, {
      id: 'opa_resolution_older_valid',
      fingerprint,
      kind: 'authorization_denial_spike',
      severity: 'warning',
      entityType: 'staff_user',
      entityId: actorId,
      details: {
        actorId, capability: 'staff.manage', count: 10,
        errorCode: 'AUTHORIZATION_DENIAL_SPIKE', threshold: 10,
      },
      status: 'resolved',
      createdAt: nowIso(at - 500_000),
      resolvedAt: nowIso(at - 400_000),
    })
    await seedAction(context, {
      id: 'opa_resolution_newest_bad',
      fingerprint,
      kind: 'authorization_denial_spike',
      severity: 'warning',
      entityType: 'staff_user',
      entityId: actorId,
      details: {
        actorId, capability: 'staff.manage', count: 10,
        errorCode: 'AUTHORIZATION_DENIAL_SPIKE', threshold: 10,
      },
      status: 'resolved',
      createdAt: nowIso(at - 300_000),
      resolvedAt: nowIso(at - 200_000),
      version: 3,
    })
    for (let index = 0; index < 10; index += 1) await seedDenial(context, {
      id: `aud_bad_resolution_${index}`,
      actorId,
      occurredAt: nowIso(at - index),
      reason: 'staff.manage denied',
    })
    await expect(evaluate(at)).rejects.toThrow(/^HEALTH_STATE_INVALID$/)
  })

  it.each([
    ['unknown plaintext', { reason: 'operations.health.read denied ' }],
    ['bad metadata', { metadataJson: '{"version":0}' }],
    ['wrong entity', { entityType: 'access_group' }],
    ['wrong actor entity', { entityId: 'stf_other' }],
  ])('fails closed for identified denial %s', async (_label, changes) => {
    const context = await cryptoContext()
    const at = DENIAL_MS - 2 * 86_400_000 - (++invalidDenialSerial) * 2 * LEASE_MS
    const actorId = `stf_denial_invalid_${_label.replaceAll(' ', '_')}`
    await seedStaff(actorId)
    await seedDenial(context, {
      id: `aud_denial_invalid_${_label.replaceAll(' ', '_')}`,
      actorId,
      occurredAt: nowIso(at),
      ...changes,
    })
    await expect(evaluate(at)).rejects.toThrow(/^AUTHORIZATION_DENIAL_STATE_INVALID$/)
  })

  it('fails closed for a denial reason envelope replayed under the wrong audit AAD', async () => {
    const context = await cryptoContext()
    const at = DENIAL_MS - 10 * 86_400_000
    await seedStaff('stf_denial_aad')
    const envelope = JSON.stringify(await encryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope,
      recordId: 'aud_different_record',
      field: 'reason',
      plaintext: 'staff.manage denied',
    }))
    await seedDenial(context, {
      id: 'aud_denial_wrong_aad',
      actorId: 'stf_denial_aad',
      occurredAt: nowIso(at),
      envelope,
    })
    await expect(evaluate(at)).rejects.toThrow(/^AUTHORIZATION_DENIAL_STATE_INVALID$/)
  })

  it('accepts a valid historical open action despite current access generations advancing', async () => {
    const context = await cryptoContext()
    await setState('access.desired_generation', '{"generation":4}')
    const openAction = await actionRow(context, {
      id: 'opa_existing_access_lag',
      fingerprint: 'access.reconciliation_lag',
      kind: 'access_reconciliation_lag',
      severity: 'critical',
      entityType: 'access_group',
      entityId: 'centre_1',
      details: {
        appliedGeneration: 0,
        desiredGeneration: 2,
        errorCode: 'ACCESS_RECONCILIATION_LAG',
      },
    })
    expect((await evaluate(NOW_MS, { db: healthReadDb({ openAction }) })).actionCandidates
      .some(({ fingerprint }) => fingerprint === 'access.reconciliation_lag')).toBe(false)
    await setState('access.desired_generation', '{"generation":0}')
  })

  it('fails closed instead of overwriting a malformed existing open action', async () => {
    const context = await cryptoContext()
    await setState('access.desired_generation', '{"generation":2}')
    const openAction = await actionRow(context, {
      id: 'opa_bad_existing_access_lag',
      fingerprint: 'access.reconciliation_lag',
      kind: 'access_reconciliation_lag',
      severity: 'critical',
      entityType: 'access_group',
      entityId: 'centre_1',
      details: {
        appliedGeneration: 0,
        desiredGeneration: 1,
        errorCode: 'ACCESS_RECONCILIATION_LAG',
      },
      version: 2,
    })
    try {
      await expect(evaluate(NOW_MS, { db: healthReadDb({ openAction }) }))
        .rejects.toThrow(/^HEALTH_STATE_INVALID$/)
    } finally {
      await setState('access.desired_generation', '{"generation":0}')
    }
  })

  it('fails closed for an existing action encrypted under the wrong record AAD', async () => {
    const context = await cryptoContext()
    await setState('access.desired_generation', '{"generation":2}')
    const openAction = await actionRow(context, {
      id: 'opa_wrong_action_aad',
      fingerprint: 'access.reconciliation_lag',
      kind: 'access_reconciliation_lag',
      severity: 'critical',
      entityType: 'access_group',
      entityId: 'centre_1',
      details: {
        appliedGeneration: 0,
        desiredGeneration: 1,
        errorCode: 'ACCESS_RECONCILIATION_LAG',
      },
    })
    openAction.details_envelope = await actionEnvelope(context, 'opa_different_action_aad', {
      appliedGeneration: 0,
      desiredGeneration: 1,
      errorCode: 'ACCESS_RECONCILIATION_LAG',
    })
    try {
      await expect(evaluate(NOW_MS, { db: healthReadDb({ openAction }) }))
        .rejects.toThrow(/^HEALTH_STATE_INVALID$/)
    } finally {
      await setState('access.desired_generation', '{"generation":0}')
    }
  })
})

describe('atomic scheduled operational publication', () => {
  it('normalizes revoked and throwing publisher input boundaries without leaking markers', async () => {
    const fixture = await publisherFixture({ id: 'run_invalid_publisher_boundary' })
    const base = {
      db: env.DB,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_invalid_publisher_boundary'),
      now: () => NOW_MS,
    }
    const beforeActions = (await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions'
    ).first()).count
    await expect(publishScheduledOperationalState(revokedObject()))
      .rejects.toThrow(/^HEALTH_INVALID$/)

    const marker = 'private-publisher-getter-marker'
    const throwingInput = { ...base }
    const inputReads = throwingProperty(throwingInput, 'idFactory', marker)
    await expect(publishScheduledOperationalState(throwingInput))
      .rejects.toThrow(/^HEALTH_INVALID$/)
    expect(inputReads()).toBe(1)

    await expect(publishScheduledOperationalState({ ...base, run: revokedObject() }))
      .rejects.toThrow(/^HEALTH_INVALID$/)
    await expect(publishScheduledOperationalState({
      ...base,
      cryptoContext: { ...fixture.context, scope: revokedObject() },
    })).rejects.toThrow(/^HEALTH_INVALID$/)
    await expect(publishScheduledOperationalState({
      ...base,
      cryptoContext: { ...fixture.context, dataKey: revokedObject() },
    })).rejects.toThrow(/^HEALTH_INVALID$/)

    expect(await env.DB.prepare(
      "SELECT key FROM system_state WHERE key='health.snapshot'"
    ).first()).toBeNull()
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions'
    ).first()).count).toBe(beforeActions)
    expect((await env.DB.prepare('SELECT status FROM scheduler_runs WHERE id=?')
      .bind(fixture.run.id).first()).status).toBe('running')
  })

  it('conditionally inserts the first canonical snapshot at version one and closes the exact fence', async () => {
    const fixture = await publisherFixture({ id: 'run_first_snapshot' })
    const sql = []
    const result = await publishScheduledOperationalState({
      db: trackedDb(env.DB, { prepare: (text) => sql.push(text) }),
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_first_snapshot'),
      now: () => NOW_MS,
    })
    expect(result).toEqual({
      completedAt: nowIso(NOW_MS),
      snapshot: result.snapshot,
      snapshotVersion: 1,
      createdActions: 0,
      publicationAttempts: 1,
    })
    const stored = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()
    expect(stored).toEqual({
      key: 'health.snapshot',
      value_json: canonical(result.snapshot),
      version: 1,
      updated_at: nowIso(NOW_MS),
    })
    expect(await env.DB.prepare(
      'SELECT status,completed_at,claimed_jobs,succeeded_jobs,failed_jobs,error_code,lease_owner,lease_expires_at FROM scheduler_runs WHERE id=?'
    ).bind(fixture.run.id).first()).toEqual({
      status: 'succeeded',
      completed_at: nowIso(NOW_MS),
      claimed_jobs: 3,
      succeeded_jobs: 2,
      failed_jobs: 1,
      error_code: null,
      lease_owner: fixture.run.leaseOwner,
      lease_expires_at: fixture.run.leaseExpiresAt,
    })
    const mutationSql = sql.filter((text) => /(?:INSERT|UPDATE|DELETE)/.test(text))
    expect(mutationSql.some((text) => /\b(?:REPLACE|IGNORE|UPSERT)\b/i.test(text))).toBe(false)
    expect(mutationSql.some((text) => text.includes("INSERT INTO system_state (key,value_json,version,updated_at)\n     SELECT 'health.snapshot',?,1,?"))).toBe(true)
  })

  it('snapshots publisher run and crypto getters once before publication work', async () => {
    const fixture = await publisherFixture({ id: 'run_changing_publisher_input' })
    const marker = 'private-publisher-changing-marker'
    const at = DENIAL_MS - 46 * 86_400_000
    const actorId = 'stf_changing_publisher_crypto'
    await seedStaff(actorId)
    await seedDenial(fixture.context, {
      id: 'aud_changing_publisher_crypto',
      actorId,
      occurredAt: nowIso(at),
      reason: 'staff invitation rate limit',
    })

    const dataKey = { ...fixture.context.dataKey }
    const dataKeyIdReads = singleReadProperty(
      dataKey, 'id', fixture.context.dataKey.id, marker,
    )
    const scope = { ...fixture.context.scope }
    const scopePurposeReads = singleReadProperty(
      scope, 'purpose', fixture.context.scope.purpose, marker,
    )
    const realGetDataKek = fixture.context.keyring.getDataKek
    let getDataKekCalls = 0
    const keyring = { ...fixture.context.keyring }
    const keyringGetterReads = singleReadProperty(keyring, 'getDataKek', (version) => {
      getDataKekCalls += 1
      if (getDataKekCalls > 1) throw new Error(marker)
      return realGetDataKek(version)
    }, marker)
    const context = { keyring, dataKey, scope }
    const contextDataKeyReads = singleReadProperty(context, 'dataKey', dataKey, marker)
    const run = { ...fixture.run }
    const claimedReads = singleReadProperty(run, 'claimedJobs', fixture.run.claimedJobs, marker)
    const input = {
      db: env.DB,
      cryptoContext: context,
      run,
      idFactory: idSequence('opa_changing_publisher_input'),
      now: () => at,
    }
    const contextReads = singleReadProperty(input, 'cryptoContext', context, marker)

    const result = await publishScheduledOperationalState(input)
    expect(result.publicationAttempts).toBe(1)
    expect(contextReads()).toBe(1)
    expect(contextDataKeyReads()).toBe(1)
    expect(dataKeyIdReads()).toBe(1)
    expect(scopePurposeReads()).toBe(1)
    expect(keyringGetterReads()).toBe(1)
    expect(getDataKekCalls).toBe(1)
    expect(claimedReads()).toBe(1)
  })

  it('validates and advances one existing snapshot version with exact CAS', async () => {
    const before = await env.DB.prepare(
      "SELECT version FROM system_state WHERE key='health.snapshot'"
    ).first()
    const secondNow = NOW_MS
    const second = await publisherFixture({ id: 'run_snapshot_version_2' })
    const result = await publishScheduledOperationalState({
      db: env.DB, cryptoContext: second.context, run: second.run,
      idFactory: idSequence('opa_snapshot_version_2'), now: () => secondNow,
    })
    expect(result.snapshotVersion).toBe(before.version + 1)
    expect(await env.DB.prepare(
      "SELECT version,updated_at,value_json FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual({
      version: before.version + 1,
      updated_at: nowIso(secondNow),
      value_json: canonical(result.snapshot),
    })
  })

  it('refuses to overwrite a malformed existing snapshot', async () => {
    const fixture = await publisherFixture({ id: 'run_malformed_snapshot' })
    const malformed = '{"checks":[],"generatedAt":"2042-01-02T02:00:00.000Z"}'
    const before = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()
    const db = trackedDb(env.DB, {
      first({ sql }) {
        if (sql.includes("FROM system_state WHERE key='health.snapshot'")) return { ...before, value_json: malformed }
        return undefined
      },
    })
    await expect(publishScheduledOperationalState({
      db,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_malformed_snapshot'),
      now: () => NOW_MS,
    })).rejects.toThrow(/^HEALTH_STATE_INVALID$/)
    expect(await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual(before)
    expect((await env.DB.prepare('SELECT status FROM scheduler_runs WHERE id=?').bind(fixture.run.id).first()).status).toBe('running')
  })

  it('rejects snapshot version overflow before any publication batch or mutation', async () => {
    const fixture = await publisherFixture({ id: 'run_snapshot_version_overflow' })
    const beforeSnapshot = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()
    const beforeActions = (await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions'
    ).first()).count
    let batchCalls = 0
    const db = trackedDb(env.DB, {
      first({ sql }) {
        if (sql.includes("FROM system_state WHERE key='health.snapshot'")) return {
          ...beforeSnapshot,
          version: Number.MAX_SAFE_INTEGER,
        }
        return undefined
      },
      async batch({ execute }) {
        batchCalls += 1
        return execute()
      },
    })

    await expect(publishScheduledOperationalState({
      db,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_snapshot_version_overflow'),
      now: () => NOW_MS,
    })).rejects.toThrow(/^HEALTH_STATE_INVALID$/)
    expect(batchCalls).toBe(0)
    expect(await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual(beforeSnapshot)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions'
    ).first()).count).toBe(beforeActions)
    expect((await env.DB.prepare('SELECT status FROM scheduler_runs WHERE id=?')
      .bind(fixture.run.id).first()).status).toBe('running')
  })

  it.each([
    ['eleven claimed and completed', 11, 11, 0],
    ['completed total above claimed', 1, 2, 1],
  ])('accepts safe nonnegative publisher counts: %s', async (_label, claimedJobs, succeededJobs, failedJobs) => {
    const fixture = await publisherFixture({ id: `run_safe_counts_${claimedJobs}_${succeededJobs}_${failedJobs}` })
    const run = { ...fixture.run, claimedJobs, succeededJobs, failedJobs }
    const result = await publishScheduledOperationalState({
      db: env.DB,
      cryptoContext: fixture.context,
      run,
      idFactory: idSequence(`opa_safe_counts_${claimedJobs}_${succeededJobs}_${failedJobs}`),
      now: () => NOW_MS,
    })
    expect(result.publicationAttempts).toBe(1)
    expect(await env.DB.prepare(
      'SELECT claimed_jobs,succeeded_jobs,failed_jobs,status FROM scheduler_runs WHERE id=?'
    ).bind(run.id).first()).toEqual({
      claimed_jobs: claimedJobs,
      succeeded_jobs: succeededJobs,
      failed_jobs: failedJobs,
      status: 'succeeded',
    })
  })

  it.each([
    ['wrong identity scope', 51, async (context, auditId) => {
      const scope = { ...SCOPE, id: 'centre_2' }
      const dataKey = await createWrappedDataKey(context.keyring, {
        scope,
        id: context.dataKey.id,
        dekVersion: 1,
        createdAt: '2040-01-01T00:00:00.000Z',
      })
      return encryptForScope(context.keyring, dataKey, {
        expectedScope: scope,
        recordId: auditId,
        field: 'reason',
        plaintext: 'staff.manage denied',
      })
    }],
    ['wrong identity purpose', 52, async (context, auditId) => {
      const scope = { ...SCOPE, purpose: 'profile' }
      const dataKey = await createWrappedDataKey(context.keyring, {
        scope,
        id: context.dataKey.id,
        dekVersion: 1,
        createdAt: '2040-01-01T00:00:00.000Z',
      })
      return encryptForScope(context.keyring, dataKey, {
        expectedScope: scope,
        recordId: auditId,
        field: 'reason',
        plaintext: 'staff.manage denied',
      })
    }],
    ['wrong identity data key', 53, async (context, auditId) => {
      const dataKey = await createWrappedDataKey(context.keyring, {
        scope: SCOPE,
        id: 'key_denial_wrong_data_key',
        dekVersion: 1,
        createdAt: '2040-01-01T00:00:00.000Z',
      })
      return encryptForScope(context.keyring, dataKey, {
        expectedScope: SCOPE,
        recordId: auditId,
        field: 'reason',
        plaintext: 'staff.manage denied',
      })
    }],
    ['tampered nonce', 54, async (context, auditId) => {
      const envelope = await encryptForScope(context.keyring, context.dataKey, {
        expectedScope: SCOPE,
        recordId: auditId,
        field: 'reason',
        plaintext: 'staff.manage denied',
      })
      return { ...envelope, nonce: tamperEncoded(envelope.nonce) }
    }],
    ['tampered ciphertext', 55, async (context, auditId) => {
      const envelope = await encryptForScope(context.keyring, context.dataKey, {
        expectedScope: SCOPE,
        recordId: auditId,
        field: 'reason',
        plaintext: 'staff.manage denied',
      })
      return { ...envelope, ciphertext: tamperEncoded(envelope.ciphertext) }
    }],
  ])('publisher rejects denial %s without success residue', async (_label, daysAgo, envelopeFor) => {
    const slug = _label.replaceAll(' ', '_')
    const fixture = await publisherFixture({ id: `run_publisher_denial_${slug}` })
    const actorId = `stf_publisher_denial_${slug}`
    const auditId = `aud_publisher_denial_${slug}`
    const at = DENIAL_MS - daysAgo * 86_400_000
    await seedStaff(actorId)
    await seedDenial(fixture.context, {
      id: auditId,
      actorId,
      occurredAt: nowIso(at),
      envelope: JSON.stringify(await envelopeFor(fixture.context, auditId)),
    })
    const beforeSnapshot = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()
    const beforeActions = (await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions'
    ).first()).count

    await expect(publishScheduledOperationalState({
      db: env.DB,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence(`opa_publisher_denial_${slug}`),
      now: () => at,
    })).rejects.toThrow(/^AUTHORIZATION_DENIAL_STATE_INVALID$/)
    expect(await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual(beforeSnapshot)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions'
    ).first()).count).toBe(beforeActions)
    expect((await env.DB.prepare('SELECT status FROM scheduler_runs WHERE id=?')
      .bind(fixture.run.id).first()).status).toBe('running')
  })

  it.each([
    ['access_reconciliation_lag', async () => {
      await setState('access.desired_generation', '{"generation":2}')
      return {
        fingerprint: 'access.reconciliation_lag',
        severity: 'critical', entityType: 'access_group', entityId: 'centre_1',
        details: { appliedGeneration: 0, desiredGeneration: 2, errorCode: 'ACCESS_RECONCILIATION_LAG' },
      }
    }],
    ['backup_failed', async () => {
      await seedScheduler({ id: 'run_backup_failed_baseline', scheduledFor: nowIso(NOW_MS - 86_400_000) })
      await seedBackup({ id: 'bkp_action_failed', status: 'failed', createdAt: nowIso(NOW_MS) })
      return {
        fingerprint: 'backup.failed:bkp_action_failed',
        severity: 'critical', entityType: 'backup_run', entityId: 'bkp_action_failed',
        details: { backupId: 'bkp_action_failed', errorCode: 'BACKUP_FAILED' },
      }
    }],
    ['backup_stale', async () => {
      await seedScheduler({
        id: 'run_backup_action_baseline',
        scheduledFor: nowIso(NOW_MS - 72 * 3_600_000),
      })
      return {
        db: trackedDb(env.DB, {
          first({ sql }) {
            if (sql.includes('FROM backup_runs')) return null
            return undefined
          },
        }),
        fingerprint: 'backup.stale',
        severity: 'critical', entityType: 'centre', entityId: 'centre_1',
        details: { errorCode: 'BACKUP_STALE', thresholdHours: 36 },
      }
    }],
    ['scheduler_stale', async () => {
      const completedAt = nowIso(NOW_MS - LEASE_MS - 1)
      return {
        db: trackedDb(env.DB, {
          first({ sql }) {
            if (sql.includes('FROM scheduler_runs') && sql.includes("WHERE status='succeeded'")) return {
              id: 'run_scheduler_action_stale',
              scheduled_for: completedAt,
              completed_at: completedAt,
              status: 'succeeded',
            }
            return undefined
          },
        }),
        fingerprint: 'scheduler.stale',
        severity: 'critical', entityType: 'scheduler_run', entityId: 'run_scheduler_action_stale',
        details: { errorCode: 'SCHEDULER_STALE', schedulerRunId: 'run_scheduler_action_stale', thresholdMinutes: 15 },
      }
    }],
    ['authorization_denial_spike', async (context) => {
      const actorId = 'stf_action_denial'
      await seedStaff(actorId)
      for (let index = 0; index < 10; index += 1) await seedDenial(context, {
        id: `aud_action_denial_${index}`,
        actorId,
        occurredAt: nowIso(NOW_MS - index),
        reason: 'security.audit.read denied',
      })
      return {
        fingerprint: `security.authorization_denials:${actorId}:security.audit.read`,
        severity: 'warning', entityType: 'staff_user', entityId: actorId,
        details: {
          actorId, capability: 'security.audit.read', count: 10,
          errorCode: 'AUTHORIZATION_DENIAL_SPIKE', threshold: 10,
        },
      }
    }],
  ])('encrypts one exact canonical %s action and keeps plaintext out of raw state', async (kind, arrange) => {
    const fixture = await publisherFixture({ id: `run_action_${kind}` })
    const expected = await arrange(fixture.context)
    const result = await publishScheduledOperationalState({
      db: expected.db ?? env.DB,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence(`opa_${kind}`),
      now: () => NOW_MS,
    })
    const action = await env.DB.prepare(
      `SELECT id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
              version,created_at,updated_at,resolved_at
       FROM operational_actions WHERE kind=? ORDER BY id LIMIT 1`
    ).bind(kind).first()
    expect(action).toMatchObject({
      fingerprint: expected.fingerprint,
      kind,
      severity: expected.severity,
      status: 'open',
      entity_type: expected.entityType,
      entity_id: expected.entityId,
      version: 1,
      created_at: nowIso(NOW_MS),
      updated_at: nowIso(NOW_MS),
      resolved_at: null,
    })
    const plaintext = await decryptForScope(fixture.context.keyring, fixture.context.dataKey, {
      expectedScope: fixture.context.scope,
      recordId: action.id,
      field: 'action_details',
      envelope: JSON.parse(action.details_envelope),
    })
    expect(plaintext).toBe(canonical(expected.details))
    expect(JSON.stringify(action)).not.toContain(expected.details.errorCode)
    expect(result.createdActions).toBeGreaterThanOrEqual(1)
  })

  it('recomputes once after a proven first snapshot race', async () => {
    const fixture = await publisherFixture({ id: 'run_snapshot_race' })
    const before = await env.DB.prepare(
      "SELECT version FROM system_state WHERE key='health.snapshot'"
    ).first()
    let batches = 0
    const db = trackedDb(env.DB, {
      async batch({ execute }) {
        batches += 1
        if (batches === 1) {
          await env.DB.prepare(
            "UPDATE system_state SET version=version+1 WHERE key='health.snapshot'"
          ).run()
        }
        return execute()
      },
    })
    const observations = [NOW_MS, NOW_MS + 1]
    const result = await publishScheduledOperationalState({
      db,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_snapshot_race'),
      now: () => observations.shift(),
    })
    expect(result).toMatchObject({ publicationAttempts: 2, snapshotVersion: before.version + 2 })
    expect(batches).toBe(2)
    expect((await env.DB.prepare('SELECT status FROM scheduler_runs WHERE id=?').bind(fixture.run.id).first()).status).toBe('succeeded')
  })

  it('accepts a concurrent randomized-envelope action winner only after a fresh full retry', async () => {
    const fixture = await publisherFixture({ id: 'run_action_race' })
    const actorId = 'stf_concurrent_action'
    const fingerprint = `security.authorization_denials:${actorId}:operations.health.read`
    const details = {
      actorId,
      capability: 'operations.health.read',
      count: 10,
      errorCode: 'AUTHORIZATION_DENIAL_SPIKE',
      threshold: 10,
    }
    await seedStaff(actorId)
    for (let index = 0; index < 10; index += 1) await seedDenial(fixture.context, {
      id: `aud_concurrent_action_${index}`,
      actorId,
      occurredAt: nowIso(NOW_MS - index),
      reason: 'operations.health.read denied',
    })
    let batches = 0
    const db = trackedDb(env.DB, {
      async batch({ execute }) {
        batches += 1
        if (batches === 1) await seedAction(fixture.context, {
          id: 'opa_concurrent_action_winner',
          fingerprint,
          kind: 'authorization_denial_spike',
          severity: 'warning',
          entityType: 'staff_user',
          entityId: actorId,
          details,
          createdAt: nowIso(NOW_MS),
        })
        return execute()
      },
    })
    const result = await publishScheduledOperationalState({
      db,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_concurrent_action_loser'),
      now: () => NOW_MS,
    })
    expect(result).toMatchObject({ publicationAttempts: 2, createdActions: 0 })
    expect(batches).toBe(2)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions WHERE fingerprint=? AND status=\'open\''
    ).bind(fingerprint).first()).count).toBe(1)
  })

  it('atomically retains an encrypted action, snapshot, and scheduler close after post-commit reply loss', async () => {
    const fixture = await publisherFixture({ id: 'run_post_commit_loss' })
    const actorId = 'stf_post_commit_action'
    const fingerprint = `security.authorization_denials:${actorId}:staff.manage`
    const at = DENIAL_MS - 60 * 86_400_000
    await seedStaff(actorId)
    for (let index = 0; index < 10; index += 1) await seedDenial(fixture.context, {
      id: `aud_post_commit_action_${index}`,
      actorId,
      occurredAt: nowIso(at - index),
      reason: 'staff.manage denied',
    })
    const before = await env.DB.prepare(
      "SELECT version FROM system_state WHERE key='health.snapshot'"
    ).first()
    const beforeActions = (await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions'
    ).first()).count
    const db = trackedDb(env.DB, {
      async batch({ execute }) {
        await execute()
        throw new Error('reply lost after publication commit')
      },
    })
    await expect(publishScheduledOperationalState({
      db,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_post_commit_loss'),
      now: () => at,
    })).rejects.toThrow(/^reply lost after publication commit$/)

    const action = await env.DB.prepare(
      `SELECT id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
              version,created_at,updated_at,resolved_at
       FROM operational_actions WHERE fingerprint=? AND status='open'`
    ).bind(fingerprint).first()
    expect(action).toMatchObject({
      id: 'opa_post_commit_loss_1',
      fingerprint,
      kind: 'authorization_denial_spike',
      severity: 'warning',
      status: 'open',
      entity_type: 'staff_user',
      entity_id: actorId,
      version: 1,
      created_at: nowIso(at),
      updated_at: nowIso(at),
      resolved_at: null,
    })
    expect(await decryptForScope(fixture.context.keyring, fixture.context.dataKey, {
      expectedScope: fixture.context.scope,
      recordId: action.id,
      field: 'action_details',
      envelope: JSON.parse(action.details_envelope),
    })).toBe(canonical({
      actorId,
      capability: 'staff.manage',
      count: 10,
      errorCode: 'AUTHORIZATION_DENIAL_SPIKE',
      threshold: 10,
    }))
    const snapshot = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()
    expect(snapshot).toMatchObject({
      key: 'health.snapshot',
      version: before.version + 1,
      updated_at: nowIso(at),
    })
    expect(JSON.parse(snapshot.value_json).generatedAt).toBe(nowIso(at))
    const scheduler = await env.DB.prepare(
      `SELECT status,completed_at,claimed_jobs,succeeded_jobs,failed_jobs,error_code,
              lease_owner,lease_expires_at
       FROM scheduler_runs WHERE id=?`
    ).bind(fixture.run.id).first()
    expect(scheduler).toEqual({
      status: 'succeeded',
      completed_at: nowIso(at),
      claimed_jobs: fixture.run.claimedJobs,
      succeeded_jobs: fixture.run.succeededJobs,
      failed_jobs: fixture.run.failedJobs,
      error_code: null,
      lease_owner: fixture.run.leaseOwner,
      lease_expires_at: fixture.run.leaseExpiresAt,
    })
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM operational_actions'
    ).first()).count).toBe(beforeActions + 1)

    await expect(publishScheduledOperationalState({
      db,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_post_commit_duplicate'),
      now: () => at + 1,
    })).rejects.toThrow(/^HEALTH_OWNERSHIP_LOST$/)
    expect(await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual(snapshot)
    expect(await env.DB.prepare(
      `SELECT id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
              version,created_at,updated_at,resolved_at
       FROM operational_actions WHERE fingerprint=? AND status='open'`
    ).bind(fingerprint).first()).toEqual(action)
    expect(await env.DB.prepare(
      `SELECT status,completed_at,claimed_jobs,succeeded_jobs,failed_jobs,error_code,
              lease_owner,lease_expires_at
       FROM scheduler_runs WHERE id=?`
    ).bind(fixture.run.id).first()).toEqual(scheduler)
  })

  it('leaves no publication changes when transport fails before batch execution', async () => {
    const fixture = await publisherFixture({ id: 'run_pre_commit_loss' })
    const before = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()
    const db = trackedDb(env.DB, {
      async batch() { throw new Error('reply lost before publication commit') },
    })
    await expect(publishScheduledOperationalState({
      db,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_pre_commit_loss'),
      now: () => NOW_MS,
    })).rejects.toThrow(/^reply lost before publication commit$/)
    expect(await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual(before)
    expect((await env.DB.prepare('SELECT status FROM scheduler_runs WHERE id=?')
      .bind(fixture.run.id).first()).status).toBe('running')
  })

  it('preserves an unrelated Task 7 outbox action byte-for-byte', async () => {
    const fixture = await publisherFixture({ id: 'run_task7_preserved' })
    await seedAction(fixture.context, {
      id: 'opa_task7_preserved',
      fingerprint: 'outbox.dead:job_task7_preserved',
      kind: 'outbox_job_failed',
      severity: 'critical',
      entityType: 'outbox_job',
      entityId: 'job_task7_preserved',
      details: {
        errorCode: 'OUTBOX_DELIVERY_FAILED',
        jobId: 'job_task7_preserved',
        outboxType: 'staff.invitation.email',
      },
    })
    const before = await env.DB.prepare('SELECT * FROM operational_actions WHERE id=?')
      .bind('opa_task7_preserved').first()
    await publishScheduledOperationalState({
      db: env.DB,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_task7_publication'),
      now: () => NOW_MS,
    })
    expect(await env.DB.prepare('SELECT * FROM operational_actions WHERE id=?')
      .bind('opa_task7_preserved').first()).toEqual(before)
  })

  it('throws the fixed conflict after a second proven snapshot race', async () => {
    const fixture = await publisherFixture({ id: 'run_snapshot_conflict' })
    let batches = 0
    const db = trackedDb(env.DB, {
      async batch({ execute }) {
        batches += 1
        await env.DB.prepare(
          "UPDATE system_state SET version=version+1 WHERE key='health.snapshot'"
        ).run()
        return execute()
      },
    })
    await expect(publishScheduledOperationalState({
      db, cryptoContext: fixture.context, run: fixture.run,
      idFactory: idSequence('opa_snapshot_conflict'), now: () => NOW_MS,
    })).rejects.toThrow(/^HEALTH_SNAPSHOT_CONFLICT$/)
    expect(batches).toBe(2)
    expect((await env.DB.prepare('SELECT status FROM scheduler_runs WHERE id=?').bind(fixture.run.id).first()).status).toBe('running')
  })

  it('does not retry an unexplained publication guard failure', async () => {
    const fixture = await publisherFixture({ id: 'run_unexplained_guard' })
    const before = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()
    let batches = 0
    const db = trackedDb(env.DB, {
      async batch({ statements, execute }) {
        batches += 1
        const replacement = [...statements].map((statement) => statement.__inner ?? statement)
        replacement[replacement.length - 1] = env.DB.prepare(
          "INSERT INTO outbox_operation_guard_failures (operation_id) SELECT 'forced_unexplained'"
        )
        return env.DB.batch(replacement)
      },
    })
    await expect(publishScheduledOperationalState({
      db, cryptoContext: fixture.context, run: fixture.run,
      idFactory: idSequence('opa_unexplained_guard'), now: () => NOW_MS,
    })).rejects.toThrow(/^HEALTH_STATE_INVALID$/)
    expect(batches).toBe(1)
    expect(await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual(before)
  })

  it('rolls back snapshot and actions when the final atomic guard aborts', async () => {
    const fixture = await publisherFixture({ id: 'run_atomic_rollback' })
    await setState('access.desired_generation', '{"generation":2}')
    const beforeSnapshot = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()
    const beforeActions = (await env.DB.prepare('SELECT count(*) AS count FROM operational_actions').first()).count
    const db = trackedDb(env.DB, {
      async batch({ statements }) {
        const replacement = statements.map((statement) => statement.__inner ?? statement)
        replacement[replacement.length - 1] = env.DB.prepare(
          "INSERT INTO outbox_operation_guard_failures (operation_id) SELECT 'forced_atomic_rollback'"
        )
        return env.DB.batch(replacement)
      },
    })
    await expect(publishScheduledOperationalState({
      db, cryptoContext: fixture.context, run: fixture.run,
      idFactory: idSequence('opa_atomic_rollback'), now: () => NOW_MS,
    })).rejects.toThrow(/^HEALTH_STATE_INVALID$/)
    expect(await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual(beforeSnapshot)
    expect((await env.DB.prepare('SELECT count(*) AS count FROM operational_actions').first()).count).toBe(beforeActions)
    expect((await env.DB.prepare('SELECT status FROM scheduler_runs WHERE id=?').bind(fixture.run.id).first()).status).toBe('running')
  })

  it('prevents all publication when the scheduler fence is taken over before the batch', async () => {
    const fixture = await publisherFixture({ id: 'run_stale_publisher' })
    const beforeSnapshot = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()
    let batches = 0
    const db = trackedDb(env.DB, {
      async batch({ execute }) {
        batches += 1
        await env.DB.prepare(
          `UPDATE scheduler_runs
           SET attempt_count=attempt_count+1,lease_owner='new_owner',lease_expires_at=?
           WHERE id=? AND status='running'`
        ).bind(nowIso(NOW_MS + LEASE_MS * 2), fixture.run.id).run()
        return execute()
      },
    })
    await expect(publishScheduledOperationalState({
      db, cryptoContext: fixture.context, run: fixture.run,
      idFactory: idSequence('opa_stale_publisher'), now: () => NOW_MS,
    })).rejects.toThrow()
    expect(batches).toBe(1)
    expect(await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()).toEqual(beforeSnapshot)
    expect(await env.DB.prepare('SELECT status,attempt_count,lease_owner FROM scheduler_runs WHERE id=?')
      .bind(fixture.run.id).first()).toEqual({ status: 'running', attempt_count: 2, lease_owner: 'new_owner' })
  })

  it('calls the injected clock once per attempt and has no provider input or fallback', async () => {
    const fixture = await publisherFixture({ id: 'run_single_clock' })
    const now = vi.fn(() => NOW_MS)
    const providers = { call: vi.fn(() => { throw new Error('provider must stay unused') }) }
    await publishScheduledOperationalState({
      db: env.DB,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_single_clock'),
      now,
    })
    expect(now).toHaveBeenCalledOnce()
    expect(providers.call).not.toHaveBeenCalled()
    await expect(publishScheduledOperationalState({
      db: env.DB,
      cryptoContext: fixture.context,
      run: fixture.run,
      idFactory: idSequence('opa_provider_extra'),
      now,
      providers,
    })).rejects.toThrow(/^HEALTH_INVALID$/)
  })
})
