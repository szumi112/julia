import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { runScheduled } from '../../worker/operations/scheduler.js'
import { partsInWarsaw } from '../../worker/operations/clock.js'
import { decryptOutboxPayload, enqueueOutboxStatement, processOutboxBatch } from '../../worker/jobs/outbox.js'
import { decryptForScope, encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import recoveryRow from '../fixtures/backup-recovery-workbook-row.json'

const VALID_ENV = Object.freeze({
  APP_ENV: 'development',
  APP_ORIGIN: 'http://127.0.0.1:5174',
  DATA_MODE: 'fictional',
  ACCESS_AUD: 'scheduler-audience',
  ACCESS_HEALTH_SERVICE_TOKEN_ID: 'scheduler-health-token',
  ACCESS_TEAM_DOMAIN: 'https://bearwithme.cloudflareaccess.com',
  ACTIVE_DATA_KEK_VERSION: '1',
  ACTIVE_LOOKUP_KEY_VERSION: '1',
  ACTIVE_BACKUP_KEK_VERSION: '1',
  BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  BWM_BACKUP_KEK_V1: 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
})
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const LEASE_MS = 900_000
const CRASH_STAGES = Object.freeze([
  'before_initial_insert',
  'after_initial_insert',
  'after_crypto_load',
  'before_backup_batch',
  'after_backup_batch',
  'after_ordinary_finalization',
  'before_completion_batch',
  'after_completion_batch',
])
let serial = 0

const runtimeEnv = (db = env.DB) => ({ ...env, ...VALID_ENV, DB: db })
const sequence = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}
const correlationSequence = () => {
  let count = 0
  return () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`
}
const schedule = (offset = 0, minute = 15) => Date.UTC(2040 + offset, 0, 2, 2, minute)
const nowIso = (ms) => new Date(ms).toISOString()
const dueFor = (scheduledTime) => {
  const local = partsInWarsaw(scheduledTime)
  return { localDay: local.day, localMonth: local.month, retentionClass: 'monthly' }
}

async function cryptoContext() {
  const keyring = await createKeyring(runtimeEnv(), {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_scheduler_gate_c',
    createdAt: '2040-01-01T00:00:00.000Z',
  })
  return { keyring, dataKey, scope: SCOPE }
}

function schedulerDeps(prefix, context, scheduledTime, overrides = {}) {
  const safePrefix = prefix.replaceAll(/[^A-Za-z0-9_]/g, '_')
  return {
    now: () => scheduledTime,
    cryptoContext: context,
    backupDue: () => false,
    processOutboxBatch: vi.fn(async () => []),
    dispatchOutboxJob: vi.fn(async () => ({ result: 'succeeded' })),
    safeLog: vi.fn(),
    providers: Object.freeze({ marker: safePrefix }),
    idFactory: sequence(`id_${safePrefix}`),
    backupIdFactory: sequence(`bkp_${safePrefix}`),
    leaseOwnerFactory: sequence(`lease_${safePrefix}`),
    leaseNonceFactory: sequence(`nonce_${safePrefix}`),
    correlationIdFactory: correlationSequence(),
    ...overrides,
  }
}

const schedulerRow = (scheduledTime) => env.DB.prepare(
  `SELECT id,scheduled_for,started_at,completed_at,status,attempt_count,lease_owner,
          lease_expires_at,claimed_jobs,succeeded_jobs,failed_jobs,error_code
   FROM scheduler_runs WHERE scheduled_for=?`
).bind(nowIso(scheduledTime)).first()

async function seedScheduler({
  id,
  scheduledTime,
  startedAt,
  completedAt = null,
  status = 'running',
  attemptCount = 1,
  leaseOwner,
  leaseExpiresAt,
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
    id,
    nowIso(scheduledTime),
    startedAt,
    completedAt,
    status,
    attemptCount,
    leaseOwner,
    leaseExpiresAt,
    claimedJobs,
    succeededJobs,
    failedJobs,
    errorCode,
  ).run()
}

const BACKUP_COLUMNS = [
  'id', 'local_day', 'local_month', 'retention_class', 'status', 'version',
  'export_bookmark', 'object_key', 'manifest_key', 'ssec_key_version',
  'wrapped_ssec_key_b64', 'wrap_nonce_b64', 'object_etag', 'object_size',
  'started_at', 'completed_at', 'expires_at', 'restore_verified_at',
  'last_error_code', 'created_at', 'updated_at',
]

async function seedBackup({
  id,
  localDay,
  localMonth = localDay.slice(0, 7),
  retentionClass = 'monthly',
  status = 'queued',
  version = 1,
  createdAt,
  updatedAt = createdAt,
  ...facts
}) {
  const stored = ['stored', 'restore_verified'].includes(status)
  const values = {
    id,
    local_day: localDay,
    local_month: localMonth,
    retention_class: retentionClass,
    status,
    version,
    export_bookmark: stored ? 'bookmark' : null,
    object_key: stored ? 'object' : null,
    manifest_key: stored ? 'manifest' : null,
    ssec_key_version: stored ? 1 : null,
    wrapped_ssec_key_b64: stored ? 'wrapped' : null,
    wrap_nonce_b64: stored ? 'nonce' : null,
    object_etag: stored ? 'etag' : null,
    object_size: stored ? 42 : null,
    started_at: stored ? createdAt : null,
    completed_at: stored ? createdAt : null,
    expires_at: stored ? nowIso(Date.parse(createdAt) + 86_400_000) : null,
    restore_verified_at: status === 'restore_verified' ? createdAt : null,
    last_error_code: status === 'failed' ? 'BACKUP_FAILED' : null,
    created_at: createdAt,
    updated_at: updatedAt,
    ...facts,
  }
  await env.DB.prepare(
    `INSERT INTO backup_runs (${BACKUP_COLUMNS.join(',')})
     VALUES (${BACKUP_COLUMNS.map(() => '?').join(',')})`
  ).bind(...BACKUP_COLUMNS.map((key) => values[key])).run()
  return values
}

async function enqueueBackup(context, {
  jobId,
  backupId,
  localDay,
  timestamp,
  idempotencyKey = `backup.create:${localDay}:${backupId}`,
}) {
  const statement = await enqueueOutboxStatement(env.DB, context, {
    id: jobId,
    type: 'backup.create',
    aggregateType: 'backup_run',
    aggregateId: backupId,
    payload: { backupId },
    idempotencyKey,
    scheduledAt: timestamp,
    nowMs: Date.parse(timestamp),
    maxAttempts: 8,
  })
  await statement.run()
  return env.DB.prepare('SELECT * FROM outbox_jobs WHERE id=?').bind(jobId).first()
}

async function seedBackupJobRaw(context, {
  jobId,
  backupId,
  localDay,
  timestamp,
  idempotencyKey = `backup.create:${localDay}:${backupId}`,
  maxAttempts = 8,
  plaintext = `{"backupId":"${backupId}"}`,
  payloadEnvelope = null,
}) {
  const envelope = payloadEnvelope ?? JSON.stringify(await encryptForScope(
    context.keyring,
    context.dataKey,
    {
      expectedScope: context.scope,
      recordId: jobId,
      field: 'job_payload',
      plaintext,
    },
  ))
  await env.DB.prepare(
    `INSERT INTO outbox_jobs
     (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
      attempt_count,max_attempts,scheduled_at,lease_owner,lease_expires_at,
      last_error_code,created_at,updated_at)
     VALUES (?,'backup.create','backup_run',?,?,?,'queued',0,?,?,NULL,NULL,NULL,?,?)`
  ).bind(
    jobId,
    backupId,
    envelope,
    idempotencyKey,
    maxAttempts,
    timestamp,
    timestamp,
    timestamp,
  ).run()
}

async function enqueueOrdinary(context, { id, scheduledAt, suffix = id }) {
  const invitationId = `inv_${suffix}`
  const statement = await enqueueOutboxStatement(env.DB, context, {
    id,
    type: 'staff.invitation.expire',
    aggregateType: 'staff_invitation',
    aggregateId: invitationId,
    payload: { actorId: 'stf_scheduler_owner', invitationId },
    idempotencyKey: `staff.invitation.expire:${suffix}`,
    scheduledAt,
    nowMs: Date.parse(scheduledAt),
  })
  await statement.run()
}

function trackedDb(real, hooks = {}) {
  const wrap = (inner, sql) => ({
    __inner: inner,
    __sql: sql,
    bind(...values) {
      hooks.bind?.({ sql, values })
      return wrap(inner.bind(...values), sql)
    },
    async run() {
      const execute = () => inner.run()
      return hooks.run ? hooks.run({ sql, execute }) : execute()
    },
    async first(column) {
      const execute = () => inner.first(column)
      return hooks.first ? hooks.first({ sql, execute }) : execute()
    },
    async all() {
      const execute = () => inner.all()
      return hooks.all ? hooks.all({ sql, execute }) : execute()
    },
    async raw(options) {
      const execute = () => inner.raw(options)
      return hooks.raw ? hooks.raw({ sql, execute }) : execute()
    },
  })
  return {
    prepare(sql) { return wrap(real.prepare(sql), sql) },
    async batch(statements) {
      const unwrapped = statements.map((statement) => statement.__inner ?? statement)
      const sql = statements.map((statement) => statement.__sql ?? '')
      const execute = () => real.batch(unwrapped)
      return hooks.batch ? hooks.batch({ statements, sql, execute }) : execute()
    },
  }
}

function realBackupArchive(mode) {
  const objects = new Map()
  const calls = []
  return {
    objects,
    calls,
    binding: {
      async put(key, value) {
        calls.push(`put:${key}`)
        if (key.endsWith('.manifest.json') && mode === 'manifest_cleanup_failure') {
          throw new Error('manifest write marker')
        }
        let bytes
        if (value instanceof ReadableStream) {
          const reader = value.getReader()
          const values = []
          while (true) {
            const part = await reader.read()
            if (part.done) break
            values.push(...part.value)
          }
          bytes = Uint8Array.from(values)
        } else {
          bytes = new Uint8Array(value)
        }
        objects.set(key, bytes)
        return { etag: `etag-${mode}-${objects.size}`, size: bytes.byteLength }
      },
      async delete(key) {
        calls.push(`delete:${key}`)
        if (!(mode === 'manifest_cleanup_failure' && key.endsWith('.sql'))) objects.delete(key)
      },
      async head(key) {
        calls.push(`head:${key}`)
        return objects.has(key) ? { etag: `etag-${mode}`, size: objects.get(key).byteLength } : null
      },
      async get() { return null },
      async list() { return { objects: [], truncated: false } },
    },
  }
}

const backupProviderEnv = (db, archive) => ({
  ...runtimeEnv(db),
  APP_ENV: 'staging',
  APP_ORIGIN: 'https://staging.bearwithme-panel.app',
  CF_ACCOUNT_ID: '2c7526d6afa1ee03407e35beefc21a0f',
  CF_D1_DATABASE_ID: 'df9375e3-b5a8-4fe2-83b2-52acf78beb17',
  CF_D1_EXPORT_TOKEN: 'fictional-scheduler-export-token',
  ARCHIVE: archive,
})

function backupProviderFetch() {
  return vi.fn(async (url) => {
    if (url === 'https://download.example.test/scheduler-backup.sql') {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    }
    return new Response(JSON.stringify({
      errors: [],
      messages: [],
      result: {
        at_bookmark: 'bookmark-scheduler-real-v3',
        filename: 'scheduler-backup.sql',
        signed_url: 'https://download.example.test/scheduler-backup.sql',
      },
      success: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

const backupsForDay = async (localDay) => (await env.DB.prepare(
  'SELECT * FROM backup_runs WHERE local_day=? ORDER BY id'
).bind(localDay).all()).results
const jobsForBackup = async (backupId) => (await env.DB.prepare(
  `SELECT * FROM outbox_jobs
   WHERE type='backup.create' AND aggregate_type='backup_run' AND aggregate_id=?
   ORDER BY id`
).bind(backupId).all()).results

describe('scheduled coordinator claim and fencing', () => {
  it('claims the exact instant with attempt one and a fifteen-minute lease before closing', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const deps = schedulerDeps('initial_claim', context, scheduledTime)

    await expect(runScheduled({ scheduledTime, env: runtimeEnv(), deps })).resolves.toEqual({
      status: 'succeeded',
      reason: null,
      runId: 'id_initial_claim_1',
      claimedJobs: 0,
      succeededJobs: 0,
      failedJobs: 0,
      backupEnqueued: false,
    })
    expect(await schedulerRow(scheduledTime)).toEqual({
      id: 'id_initial_claim_1',
      scheduled_for: nowIso(scheduledTime),
      started_at: nowIso(scheduledTime),
      completed_at: nowIso(scheduledTime),
      status: 'succeeded',
      attempt_count: 1,
      lease_owner: 'lease_initial_claim_1',
      lease_expires_at: nowIso(scheduledTime + LEASE_MS),
      claimed_jobs: 0,
      succeeded_jobs: 0,
      failed_jobs: 0,
      error_code: null,
    })
    const health = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='health.snapshot'"
    ).first()
    expect(health).toMatchObject({
      key: 'health.snapshot',
      version: 1,
      updated_at: nowIso(scheduledTime),
    })
    const snapshot = JSON.parse(health.value_json)
    expect(snapshot.generatedAt).toBe(nowIso(scheduledTime))
    expect(snapshot.checks.map(({ id }) => id)).toEqual([
      'outbox.processing',
      'backup.freshness',
      'access.reconciliation',
      'scheduler.runs',
    ])
    expect(snapshot.checks.find(({ id }) => id === 'scheduler.runs')).toMatchObject({
      status: 'ok',
      lastSuccessAt: nowIso(scheduledTime),
      detailCode: 'SCHEDULER_HEALTHY',
    })
  })

  it('skips the exact successful instant without loading crypto, backup, or dispatch work', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('duplicate_first', context, scheduledTime),
    })
    const createKeyringSpy = vi.fn(async () => { throw new Error('must not load crypto') })
    const due = vi.fn(() => false)
    const process = vi.fn(async () => [])

    await expect(runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('duplicate_second', undefined, scheduledTime, {
        cryptoContext: undefined,
        createKeyring: createKeyringSpy,
        backupDue: due,
        processOutboxBatch: process,
      }),
    })).resolves.toMatchObject({
      status: 'skipped',
      reason: 'already_succeeded',
      runId: 'id_duplicate_first_1',
      claimedJobs: 0,
      backupEnqueued: false,
    })
    expect(createKeyringSpy).not.toHaveBeenCalled()
    expect(due).not.toHaveBeenCalled()
    expect(process).not.toHaveBeenCalled()
  })

  it('skips a live overlap without mutating its exact row', async () => {
    const scheduledTime = schedule(++serial)
    const before = {
      id: 'run_live_overlap',
      scheduledTime,
      startedAt: nowIso(scheduledTime - 1_000),
      leaseOwner: 'owner_live_overlap',
      leaseExpiresAt: nowIso(scheduledTime + 1),
    }
    await seedScheduler(before)
    const snapshot = await schedulerRow(scheduledTime)
    const deps = schedulerDeps('live_overlap', undefined, scheduledTime, {
      cryptoContext: undefined,
      createKeyring: vi.fn(),
    })

    await expect(runScheduled({ scheduledTime, env: runtimeEnv(), deps })).resolves.toEqual({
      status: 'skipped',
      reason: 'live_lease',
      runId: 'run_live_overlap',
      claimedJobs: 0,
      succeededJobs: 0,
      failedJobs: 0,
      backupEnqueued: false,
    })
    expect(await schedulerRow(scheduledTime)).toEqual(snapshot)
    expect(deps.createKeyring).not.toHaveBeenCalled()
    expect(deps.processOutboxBatch).not.toHaveBeenCalled()
  })

  it('fails closed when a generated run id collides outside the exact scheduled instant', async () => {
    const context = await cryptoContext()
    const existingTime = schedule(++serial)
    const scheduledTime = schedule(++serial)
    await seedScheduler({
      id: 'run_arbitrary_identity_collision',
      scheduledTime: existingTime,
      startedAt: nowIso(existingTime),
      completedAt: nowIso(existingTime),
      status: 'succeeded',
      leaseOwner: 'owner_arbitrary_identity_collision',
      leaseExpiresAt: nowIso(existingTime + LEASE_MS),
    })

    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('arbitrary_run_collision', context, scheduledTime, {
        idFactory: () => 'run_arbitrary_identity_collision',
      }),
    })

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'coordinator_failed',
      runId: null,
    })
    expect(await schedulerRow(scheduledTime)).toBeNull()
  })

  it('never treats a malformed exact scheduler row as a duplicate winner', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    await seedScheduler({
      id: 'run_malformed_duplicate',
      scheduledTime,
      startedAt: nowIso(scheduledTime),
      completedAt: nowIso(scheduledTime),
      status: 'succeeded',
      leaseOwner: 'owner_malformed_duplicate',
      leaseExpiresAt: nowIso(scheduledTime + LEASE_MS),
      claimedJobs: 1,
      succeededJobs: 1,
      failedJobs: 1,
    })
    const before = await env.DB.prepare('SELECT * FROM scheduler_runs WHERE scheduled_for=?')
      .bind(nowIso(scheduledTime)).first()

    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('malformed_duplicate', context, scheduledTime),
    })

    expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed', runId: null })
    expect(await env.DB.prepare('SELECT * FROM scheduler_runs WHERE scheduled_for=?')
      .bind(nowIso(scheduledTime)).first()).toEqual(before)
  })

  it('reclaims an expired row with a fresh exact fence and cleared attempt facts', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    await seedScheduler({
      id: 'run_expired_reclaim',
      scheduledTime,
      startedAt: nowIso(scheduledTime - LEASE_MS),
      leaseOwner: 'owner_expired_old',
      leaseExpiresAt: nowIso(scheduledTime),
      claimedJobs: 4,
      succeededJobs: 3,
      failedJobs: 1,
    })
    const nowMs = scheduledTime + 10
    const deps = schedulerDeps('expired_reclaim', context, scheduledTime, { now: () => nowMs })

    await expect(runScheduled({ scheduledTime, env: runtimeEnv(), deps })).resolves.toMatchObject({
      status: 'succeeded',
      runId: 'run_expired_reclaim',
    })
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      id: 'run_expired_reclaim',
      started_at: nowIso(nowMs),
      completed_at: nowIso(nowMs),
      status: 'succeeded',
      attempt_count: 2,
      lease_owner: 'lease_expired_reclaim_2',
      lease_expires_at: nowIso(nowMs + LEASE_MS),
      claimed_jobs: 0,
      succeeded_jobs: 0,
      failed_jobs: 0,
      error_code: null,
    })
  })

  it('reclaims a failed row immediately with its immutable run identity', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    await seedScheduler({
      id: 'run_failed_reclaim',
      scheduledTime,
      startedAt: nowIso(scheduledTime - 20_000),
      completedAt: nowIso(scheduledTime - 10_000),
      status: 'failed',
      attemptCount: 3,
      leaseOwner: 'owner_failed_old',
      leaseExpiresAt: nowIso(scheduledTime + 86_400_000),
      claimedJobs: 2,
      succeededJobs: 1,
      failedJobs: 1,
      errorCode: 'SCHEDULER_COORDINATOR_FAILED',
    })

    await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('failed_reclaim', context, scheduledTime),
    })
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      id: 'run_failed_reclaim',
      status: 'succeeded',
      attempt_count: 4,
      lease_owner: 'lease_failed_reclaim_2',
      claimed_jobs: 0,
      succeeded_jobs: 0,
      failed_jobs: 0,
      error_code: null,
    })
  })

  it.each(['initial', 'reclaim'])('rejects nonzero attempt facts in the %s owned-row post-reread', async (claimKind) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    if (claimKind === 'reclaim') {
      await seedScheduler({
        id: 'run_nonzero_reclaim_reread',
        scheduledTime,
        startedAt: nowIso(scheduledTime - LEASE_MS),
        leaseOwner: 'owner_nonzero_reclaim_reread',
        leaseExpiresAt: nowIso(scheduledTime),
      })
    }
    let mutated = false
    const mutate = async () => {
      mutated = true
      await env.DB.prepare(
        `UPDATE scheduler_runs SET claimed_jobs=1,succeeded_jobs=1
         WHERE scheduled_for=? AND status='running'`
      ).bind(nowIso(scheduledTime)).run()
    }
    const db = trackedDb(env.DB, {
      async run({ sql, execute }) {
        const value = await execute()
        if (!mutated && claimKind === 'initial' && sql.includes('INSERT INTO scheduler_runs')) {
          await mutate()
        }
        return value
      },
      async batch({ sql, execute }) {
        const value = await execute()
        if (!mutated && claimKind === 'reclaim' && sql[0]?.includes('UPDATE scheduler_runs')) {
          await mutate()
        }
        return value
      },
    })

    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(db),
      deps: schedulerDeps(`nonzero_${claimKind}_reread`, context, scheduledTime),
    })

    expect(mutated).toBe(true)
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'coordinator_failed',
      runId: null,
    })
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: 'running',
      claimed_jobs: 1,
      succeeded_jobs: 1,
      failed_jobs: 0,
    })
  })

  it('rereads once after a lost CAS and follows the succeeded decision', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    await seedScheduler({
      id: 'run_cas_loser_success',
      scheduledTime,
      startedAt: nowIso(scheduledTime - LEASE_MS),
      leaseOwner: 'owner_cas_loser_old',
      leaseExpiresAt: nowIso(scheduledTime),
    })
    let intercepted = false
    const db = trackedDb(env.DB, {
      async batch({ sql, execute }) {
        if (!intercepted && sql[0]?.includes('UPDATE scheduler_runs')) {
          intercepted = true
          await env.DB.prepare(
            `UPDATE scheduler_runs SET status='succeeded',completed_at=?
             WHERE scheduled_for=? AND status='running'`
          ).bind(nowIso(scheduledTime), nowIso(scheduledTime)).run()
        }
        return execute()
      },
    })
    const deps = schedulerDeps('cas_loser_success', context, scheduledTime)

    await expect(runScheduled({ scheduledTime, env: runtimeEnv(db), deps })).resolves.toMatchObject({
      status: 'skipped',
      reason: 'already_succeeded',
      runId: 'run_cas_loser_success',
    })
    expect(deps.processOutboxBatch).not.toHaveBeenCalled()
  })

  it('permits one second exact reclaim CAS and fails closed after a second loss', async () => {
    const context = await cryptoContext()
    for (const failTwice of [false, true]) {
      const scheduledTime = schedule(++serial)
      const id = `run_cas_retry_${failTwice ? 'twice' : 'once'}`
      await seedScheduler({
        id,
        scheduledTime,
        startedAt: nowIso(scheduledTime - LEASE_MS),
        leaseOwner: `owner_${id}`,
        leaseExpiresAt: nowIso(scheduledTime),
      })
      let losses = 0
      const db = trackedDb(env.DB, {
        async batch({ sql, execute }) {
          if (sql[0]?.includes('UPDATE scheduler_runs') && losses < (failTwice ? 2 : 1)) {
            losses += 1
            await env.DB.prepare(
              `UPDATE scheduler_runs
               SET attempt_count=attempt_count+1,lease_owner=?,started_at=?
               WHERE scheduled_for=? AND status='running'`
            ).bind(`competing_owner_${losses}`, nowIso(scheduledTime), nowIso(scheduledTime)).run()
          }
          return execute()
        },
      })
      const result = await runScheduled({
        scheduledTime,
        env: runtimeEnv(db),
        deps: schedulerDeps(`cas_retry_${failTwice}`, context, scheduledTime),
      })
      if (failTwice) {
        expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed' })
        expect(await schedulerRow(scheduledTime)).toMatchObject({
          status: 'running',
          attempt_count: 3,
          lease_owner: 'competing_owner_2',
        })
      } else {
        expect(result).toMatchObject({ status: 'succeeded', runId: id })
        expect(await schedulerRow(scheduledTime)).toMatchObject({
          status: 'succeeded',
          attempt_count: 3,
        })
      }
    }
  })

  it.each(['succeeded', 'live'])('does not reinterpret a second reclaim CAS loss as %s', async (winnerState) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    await seedScheduler({
      id: `run_second_loss_${winnerState}`,
      scheduledTime,
      startedAt: nowIso(scheduledTime - LEASE_MS),
      leaseOwner: `owner_second_loss_${winnerState}`,
      leaseExpiresAt: nowIso(scheduledTime),
    })
    let losses = 0
    const db = trackedDb(env.DB, {
      async batch({ sql, execute }) {
        if (sql[0]?.includes('UPDATE scheduler_runs') && losses < 2) {
          losses += 1
          if (losses === 1) {
            await env.DB.prepare(
              `UPDATE scheduler_runs
               SET attempt_count=attempt_count+1,lease_owner='second_loss_first_winner'
               WHERE scheduled_for=? AND status='running'`
            ).bind(nowIso(scheduledTime)).run()
          } else if (winnerState === 'succeeded') {
            await env.DB.prepare(
              `UPDATE scheduler_runs SET status='succeeded',completed_at=?
               WHERE scheduled_for=? AND status='running'`
            ).bind(nowIso(scheduledTime), nowIso(scheduledTime)).run()
          } else {
            await env.DB.prepare(
              `UPDATE scheduler_runs
               SET attempt_count=attempt_count+1,lease_owner='second_loss_live_winner',
                   lease_expires_at=?
               WHERE scheduled_for=? AND status='running'`
            ).bind(nowIso(scheduledTime + LEASE_MS), nowIso(scheduledTime)).run()
          }
        }
        return execute()
      },
    })

    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(db),
      deps: schedulerDeps(`second_loss_${winnerState}`, context, scheduledTime),
    })

    expect(losses).toBe(2)
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'coordinator_failed',
      runId: null,
    })
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: winnerState === 'succeeded' ? 'succeeded' : 'running',
    })
  })

  it.each(['backup', 'processor', 'completion'])('a takeover before %s prevents stale side effects and terminal writes', async (checkpoint) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    let dueCalls = 0
    let processCalls = 0
    const takeover = async () => {
      await env.DB.prepare(
        `UPDATE scheduler_runs
         SET attempt_count=attempt_count+1,lease_owner='newer_owner',
             lease_expires_at=?,started_at=?
         WHERE scheduled_for=? AND status='running'`
      ).bind(
        nowIso(scheduledTime + LEASE_MS * 2),
        nowIso(scheduledTime),
        nowIso(scheduledTime),
      ).run()
    }
    const deps = schedulerDeps(`takeover_${checkpoint}`, context, scheduledTime, {
      backupDue: async () => {
        dueCalls += 1
        if (checkpoint === 'backup' || checkpoint === 'processor') await takeover()
        return checkpoint === 'backup' ? dueFor(scheduledTime) : false
      },
      processOutboxBatch: vi.fn(async () => {
        processCalls += 1
        if (checkpoint === 'completion') await takeover()
        return []
      }),
    })

    const result = await runScheduled({ scheduledTime, env: runtimeEnv(), deps })
    expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed' })
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: 'running',
      attempt_count: 2,
      lease_owner: 'newer_owner',
    })
    expect(await backupsForDay(dueFor(scheduledTime).localDay)).toEqual([])
    expect(dueCalls).toBe(1)
    expect(processCalls).toBe(checkpoint === 'completion' ? 1 : 0)
  })
})

describe('backup due facts and atomic dormant publication', () => {
  it('maps live-day, live-monthly, stored-monthly, failed, and pruned rows into exact Gate A facts', async () => {
    const context = await cryptoContext()
    const captures = []
    const cases = [
      { suffix: 'live_day', row: { status: 'queued', retentionClass: 'daily', sameDay: true }, want: [true, false, false] },
      { suffix: 'live_month', row: { status: 'queued', retentionClass: 'monthly', sameDay: false }, want: [false, true, false] },
      { suffix: 'stored_month', row: { status: 'stored', retentionClass: 'monthly', sameDay: false }, want: [false, false, true] },
      { suffix: 'dead_history', row: { status: 'failed', retentionClass: 'monthly', sameDay: true, alsoPruned: true }, want: [false, false, false] },
    ]
    for (const item of cases) {
      const scheduledTime = schedule(++serial)
      const due = dueFor(scheduledTime)
      const day = item.row.sameDay ? due.localDay : `${due.localMonth}-01`
      await seedBackup({
        id: `bkp_facts_${item.suffix}`,
        localDay: day,
        localMonth: due.localMonth,
        retentionClass: item.row.retentionClass,
        status: item.row.status,
        createdAt: nowIso(scheduledTime - 1_000),
      })
      if (item.row.alsoPruned) {
        await seedBackup({
          id: `bkp_facts_${item.suffix}_pruned`,
          localDay: `${due.localMonth}-01`,
          localMonth: due.localMonth,
          retentionClass: 'monthly',
          status: 'pruned',
          createdAt: nowIso(scheduledTime - 2_000),
        })
      }
      const backupDue = vi.fn((_instant, facts) => {
        captures.push(facts)
        return false
      })
      await runScheduled({
        scheduledTime,
        env: runtimeEnv(),
        deps: schedulerDeps(`facts_${item.suffix}`, context, scheduledTime, { backupDue }),
      })
      expect(backupDue).toHaveBeenCalledWith(scheduledTime, {
        hasLiveBackupForLocalDay: item.want[0],
        hasLiveMonthlyBackupForLocalMonth: item.want[1],
        hasStoredMonthlyBackupForLocalMonth: item.want[2],
      })
    }
    expect(captures).toHaveLength(cases.length)
  })

  it('enqueues a daily backup after a real stored monthly row on a later local day', async () => {
    const context = await cryptoContext()
    const scheduledTime = Date.UTC(2040 + ++serial, 0, 3, 2, 15)
    const local = partsInWarsaw(scheduledTime)
    await seedBackup({
      id: 'bkp_stored_month_before_daily',
      localDay: `${local.month}-01`,
      localMonth: local.month,
      retentionClass: 'monthly',
      status: 'stored',
      createdAt: nowIso(scheduledTime - 86_400_000),
    })
    const deps = schedulerDeps('stored_month_daily', context, scheduledTime, {
      backupDue: undefined,
      backupIdFactory: () => 'bkp_daily_after_stored_month',
    })

    await expect(runScheduled({ scheduledTime, env: runtimeEnv(), deps })).resolves.toMatchObject({
      status: 'succeeded',
      backupEnqueued: true,
    })
    await expect(env.DB.prepare(
      `SELECT local_day,local_month,retention_class,status
       FROM backup_runs WHERE id=?`,
    ).bind('bkp_daily_after_stored_month').first()).resolves.toEqual({
      local_day: local.day,
      local_month: local.month,
      retention_class: 'daily',
      status: 'queued',
    })
  })

  it('atomically inserts one exact queued backup and one encrypted dormant job behind its scheduler fence', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const timestamp = nowIso(scheduledTime)
    const due = dueFor(scheduledTime)
    const deps = schedulerDeps('atomic_enqueue', context, scheduledTime, {
      backupDue: () => due,
      backupIdFactory: () => 'bkp_atomic_enqueue',
    })

    await expect(runScheduled({ scheduledTime, env: runtimeEnv(), deps })).resolves.toMatchObject({
      status: 'succeeded',
      backupEnqueued: true,
    })
    const backup = await env.DB.prepare('SELECT * FROM backup_runs WHERE id=?')
      .bind('bkp_atomic_enqueue').first()
    expect(backup).toEqual({
      id: 'bkp_atomic_enqueue',
      local_day: due.localDay,
      local_month: due.localMonth,
      retention_class: 'monthly',
      status: 'queued',
      version: 1,
      export_bookmark: null,
      object_key: null,
      manifest_key: null,
      ssec_key_version: null,
      wrapped_ssec_key_b64: null,
      wrap_nonce_b64: null,
      object_etag: null,
      object_size: null,
      started_at: null,
      completed_at: null,
      expires_at: null,
      restore_verified_at: null,
      last_error_code: null,
      created_at: timestamp,
      updated_at: timestamp,
    })
    const jobs = await jobsForBackup(backup.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      type: 'backup.create',
      aggregate_type: 'backup_run',
      aggregate_id: backup.id,
      idempotency_key: `backup.create:${due.localDay}:${backup.id}`,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 8,
      scheduled_at: timestamp,
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: null,
      created_at: timestamp,
      updated_at: timestamp,
    })
    await expect(decryptOutboxPayload(context, jobs[0])).resolves.toEqual({ backupId: backup.id })
  })

  it('uses a fresh post-encryption fence check when the observed clock advances', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const due = dueFor(scheduledTime)
    const observations = [
      scheduledTime,
      scheduledTime,
      scheduledTime,
      scheduledTime,
      scheduledTime + 1,
    ]
    let index = 0
    const now = () => observations[Math.min(index++, observations.length - 1)]
    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('advancing_backup_clock', context, scheduledTime, {
        now,
        backupDue: () => due,
        backupIdFactory: () => 'bkp_advancing_backup_clock',
      }),
    })

    expect(result).toMatchObject({ status: 'succeeded', backupEnqueued: true })
    expect(await env.DB.prepare('SELECT created_at,updated_at FROM backup_runs WHERE id=?')
      .bind('bkp_advancing_backup_clock').first()).toEqual({
      created_at: nowIso(scheduledTime),
      updated_at: nowIso(scheduledTime),
    })
  })

  it.each([
    ['empty envelope fields', {
      format: 1,
      algorithm: 'A256GCM',
      dataKeyId: '',
      dataKeyVersion: 1,
      nonce: '',
      ciphertext: '',
    }],
    ['noncanonical envelope fields', {
      format: 1,
      algorithm: 'A256GCM',
      dataKeyId: 'bad id',
      dataKeyVersion: 1,
      nonce: 'not+base64=',
      ciphertext: '*',
    }],
  ])('rejects injected backup enqueue statements with %s', async (_label, envelope) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const due = dueFor(scheduledTime)
    const backupId = `bkp_bad_enqueue_${serial}`
    let jobId = null
    const enqueueOutboxStatement = vi.fn(async (db, _cryptoContext, input) => {
      jobId = input.id
      const createdAt = nowIso(input.nowMs)
      return db.prepare(
        `INSERT INTO outbox_jobs
         (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
          attempt_count,max_attempts,scheduled_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'queued',0,?,?,?,?)`
      ).bind(
        input.id,
        input.type,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(envelope),
        input.idempotencyKey,
        input.maxAttempts,
        input.scheduledAt,
        createdAt,
        createdAt,
      )
    })

    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps(`bad_enqueue_${serial}`, context, scheduledTime, {
        backupDue: () => due,
        backupIdFactory: () => backupId,
        enqueueOutboxStatement,
      }),
    })

    expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed' })
    expect(enqueueOutboxStatement).toHaveBeenCalledOnce()
    expect(await env.DB.prepare('SELECT id FROM backup_runs WHERE id=?').bind(backupId).first()).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM outbox_jobs WHERE id=?').bind(jobId).first()).toBeNull()
  })

  it.each([0, 1, 2])('rolls back both publication rows when backup batch statement %i fails', async (target) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const due = dueFor(scheduledTime)
    const backupId = `bkp_atomic_failure_${target}`
    let intercepted = false
    const db = trackedDb(env.DB, {
      async batch({ sql, statements, execute }) {
        if (!intercepted && sql.length === 3 && sql[0].includes('INSERT INTO backup_runs')) {
          intercepted = true
          const failing = env.DB.prepare(
            'INSERT INTO outbox_operation_guard_failures (operation_id) SELECT ?'
          ).bind(`forced_atomic_failure_${target}`)
          const replacement = statements.map((statement) => statement.__inner ?? statement)
          replacement[target] = failing
          return env.DB.batch(replacement)
        }
        return execute()
      },
    })
    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(db),
      deps: schedulerDeps(`atomic_failure_${target}`, context, scheduledTime, {
        backupDue: () => due,
        backupIdFactory: () => backupId,
      }),
    })

    expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed' })
    expect(await env.DB.prepare('SELECT id FROM backup_runs WHERE id=?').bind(backupId).first()).toBeNull()
    expect(await jobsForBackup(backupId)).toEqual([])
  })

  it('preserves a committed-backup result when later coordinator work fails', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const due = dueFor(scheduledTime)
    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('backup_then_failure', context, scheduledTime, {
        backupDue: () => due,
        backupIdFactory: () => 'bkp_backup_then_failure',
        processOutboxBatch: vi.fn(async () => { throw new Error('provider-private-body') }),
      }),
    })

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'coordinator_failed',
      backupEnqueued: true,
    })
    expect(await backupsForDay(due.localDay)).toHaveLength(1)
    expect(await jobsForBackup('bkp_backup_then_failure')).toHaveLength(1)
  })

  it('fails closed on an unrelated generated outbox job id collision with no live winner', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const timestamp = nowIso(scheduledTime)
    const due = dueFor(scheduledTime)
    await enqueueOrdinary(context, {
      id: 'job_unrelated_backup_collision',
      scheduledAt: timestamp,
      suffix: 'unrelated_backup_collision',
    })
    const ids = ['run_backup_job_collision', 'job_unrelated_backup_collision']
    let index = 0
    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('backup_job_collision', context, scheduledTime, {
        backupDue: () => due,
        backupIdFactory: () => 'bkp_unrelated_job_collision',
        idFactory: () => ids[Math.min(index++, ids.length - 1)],
      }),
    })

    expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed' })
    expect(await backupsForDay(due.localDay)).toEqual([])
    expect(await jobsForBackup('bkp_unrelated_job_collision')).toEqual([])
    expect(await env.DB.prepare('SELECT type,status,attempt_count FROM outbox_jobs WHERE id=?')
      .bind('job_unrelated_backup_collision').first()).toEqual({
      type: 'staff.invitation.expire',
      status: 'queued',
      attempt_count: 0,
    })
    await env.DB.prepare(
      "UPDATE outbox_jobs SET scheduled_at='9999-12-31T23:59:59.999Z' WHERE id=?"
    ).bind('job_unrelated_backup_collision').run()
  })

  it('accepts a live-index collision only after validating one exact queued winner and payload', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const due = dueFor(scheduledTime)
    const timestamp = nowIso(scheduledTime)
    let injected = false
    const db = trackedDb(env.DB, {
      async batch({ sql, execute }) {
        if (!injected && sql.length === 3 && sql[0].includes('INSERT INTO backup_runs')) {
          injected = true
          await seedBackup({
            id: 'bkp_collision_winner',
            localDay: due.localDay,
            localMonth: due.localMonth,
            retentionClass: due.retentionClass,
            createdAt: timestamp,
          })
          await enqueueBackup(context, {
            jobId: 'job_collision_winner',
            backupId: 'bkp_collision_winner',
            localDay: due.localDay,
            timestamp,
          })
        }
        return execute()
      },
    })
    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(db),
      deps: schedulerDeps('collision_winner', context, scheduledTime, {
        backupDue: () => due,
        backupIdFactory: () => 'bkp_collision_loser',
      }),
    })

    expect(result).toMatchObject({ status: 'succeeded', backupEnqueued: false })
    expect((await backupsForDay(due.localDay)).map(({ id }) => id)).toEqual(['bkp_collision_winner'])
    expect(await jobsForBackup('bkp_collision_loser')).toEqual([])
  })

  it.each([
    ['missing job', 'missing_job'],
    ['wrong retention', 'wrong_retention'],
    ['wrong version', 'wrong_version'],
    ['mismatched timestamps', 'bad_timestamp'],
    ['non-null queued field', 'nonnull_field'],
    ['exporting winner', 'exporting'],
    ['duplicate jobs', 'duplicate_job'],
    ['processing job', 'processing_job'],
    ['attempted queued job', 'attempted_job'],
    ['wrong max attempts', 'wrong_max'],
    ['wrong per-run key', 'wrong_key'],
    ['malformed envelope', 'bad_envelope'],
    ['mismatched payload', 'bad_payload'],
  ])('fails closed for a collision winner with %s', async (_label, variant) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const due = dueFor(scheduledTime)
    const timestamp = nowIso(scheduledTime)
    const winnerId = `bkp_invalid_winner_${variant}`
    const jobId = `job_invalid_winner_${variant}`
    let injected = false
    const db = trackedDb(env.DB, {
      async batch({ sql, execute }) {
        if (!injected && sql.length === 3 && sql[0].includes('INSERT INTO backup_runs')) {
          injected = true
          await seedBackup({
            id: winnerId,
            localDay: due.localDay,
            localMonth: due.localMonth,
            retentionClass: variant === 'wrong_retention' ? 'daily' : due.retentionClass,
            status: variant === 'exporting' ? 'exporting' : 'queued',
            version: variant === 'wrong_version' ? 2 : 1,
            createdAt: timestamp,
            updatedAt: variant === 'bad_timestamp' ? nowIso(scheduledTime + 1) : timestamp,
            export_bookmark: variant === 'nonnull_field' ? 'unexpected' : null,
          })
          if (variant !== 'missing_job') {
            if (['wrong_max', 'wrong_key', 'bad_envelope', 'bad_payload'].includes(variant)) {
              await seedBackupJobRaw(context, {
                jobId,
                backupId: winnerId,
                localDay: due.localDay,
                timestamp,
                ...(variant === 'wrong_max' ? { maxAttempts: 7 } : {}),
                ...(variant === 'wrong_key' ? {
                  idempotencyKey: `backup.create:${due.localMonth}-01:${winnerId}`,
                } : {}),
                ...(variant === 'bad_envelope' ? { payloadEnvelope: '{}' } : {}),
                ...(variant === 'bad_payload' ? {
                  plaintext: `{"backupId":"${winnerId}_other"}`,
                } : {}),
              })
            } else {
              await enqueueBackup(context, {
                jobId,
                backupId: winnerId,
                localDay: due.localDay,
                timestamp,
              })
            }
            if (variant === 'duplicate_job') {
              await seedBackupJobRaw(context, {
                jobId: `${jobId}_two`,
                backupId: winnerId,
                localDay: `${due.localMonth}-01`,
                timestamp,
              })
            }
            if (variant === 'processing_job') {
              await env.DB.prepare(
                `UPDATE outbox_jobs SET status='processing',attempt_count=1,
                 lease_owner='winner_job_owner',lease_expires_at=? WHERE id=?`
              ).bind(nowIso(scheduledTime + 60_000), jobId).run()
            } else if (variant === 'attempted_job') {
              await env.DB.prepare('UPDATE outbox_jobs SET attempt_count=1 WHERE id=?').bind(jobId).run()
            }
          }
        }
        return execute()
      },
    })
    const log = vi.fn()
    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(db),
      deps: schedulerDeps(`invalid_winner_${variant}`, context, scheduledTime, {
        backupDue: () => due,
        backupIdFactory: () => `bkp_collision_attempt_${variant}`,
        safeLog: log,
      }),
    })

    expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed' })
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: 'failed',
      error_code: 'SCHEDULER_COORDINATOR_FAILED',
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain(winnerId)
  })
})

describe('production identity crypto loading', () => {
  it.each([
    ['noncanonical wrapped key', { wrapped_key_b64: 'not+base64=' }, false],
    ['wrong wrapped key length', { wrapped_key_b64: encodeBase64Url(new Uint8Array(47)) }, false],
    ['noncanonical wrap nonce', { wrap_nonce_b64: 'not+base64=' }, false],
    ['wrong wrap nonce length', { wrap_nonce_b64: encodeBase64Url(new Uint8Array(11)) }, false],
    ['unresolved data KEK', {}, true],
  ])('rejects an active identity DEK with %s before work', async (_label, mutation, unresolvedKek) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const db = trackedDb(env.DB, {
      async first({ sql, execute }) {
        const row = await execute()
        return sql.includes('FROM data_keys') ? { ...row, ...mutation } : row
      },
    })
    const process = vi.fn(async () => [])
    const keyring = unresolvedKek
      ? { ...context.keyring, getDataKek: () => null }
      : context.keyring

    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(db),
      deps: schedulerDeps(`malformed_dek_${serial}`, undefined, scheduledTime, {
        cryptoContext: undefined,
        createKeyring: async () => keyring,
        processOutboxBatch: process,
      }),
    })

    expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed' })
    expect(process).not.toHaveBeenCalled()
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: 'failed',
      error_code: 'SCHEDULER_COORDINATOR_FAILED',
    })
  })
})

describe('scheduled operational publication budget', () => {
  it('publishes the centre denial-overflow action within Cloudflare Free D1 limits', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const occurredAt = nowIso(scheduledTime)
    const actorId = 'stf_scheduler_denial_overflow'
    await env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,version,created_at,updated_at)
       VALUES (?,?,?,?,?,'pending',1,?,?)`
    ).bind(
      actorId,
      'lookup_scheduler_denial_overflow',
      '{}',
      '{}',
      'coordinator',
      occurredAt,
      occurredAt,
    ).run()
    for (let index = 0; index < 101; index += 1) {
      const suffix = index.toString().padStart(3, '0')
      const id = `aud_scheduler_denial_overflow_${suffix}`
      const reasonEnvelope = JSON.stringify(await encryptForScope(
        context.keyring,
        context.dataKey,
        {
          expectedScope: context.scope,
          recordId: id,
          field: 'reason',
          plaintext: 'staff invitation rate limit',
        },
      ))
      await env.DB.prepare(
        `INSERT INTO audit_events
         (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
          reason_envelope,correlation_id,metadata_json)
         VALUES (?,?,?,'authorization.denied','staff_user',?,'denied',?,?,?)`
      ).bind(
        id,
        nowIso(scheduledTime - index),
        actorId,
        actorId,
        reasonEnvelope,
        `cor_scheduler_denial_overflow_${suffix}`,
        '{"version":1}',
      ).run()
    }

    let statements = 0
    let maxBindings = 0
    const terminal = async ({ execute }) => {
      statements += 1
      return execute()
    }
    const db = trackedDb(env.DB, {
      bind({ values }) { maxBindings = Math.max(maxBindings, values.length) },
      run: terminal,
      first: terminal,
      all: terminal,
      raw: terminal,
      async batch({ sql, execute }) {
        statements += sql.length
        return execute()
      },
    })
    const deps = schedulerDeps('denial_overflow_budget', context, scheduledTime)
    delete deps.processOutboxBatch

    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(db),
      deps,
    })
    expect(result).toMatchObject({
      status: 'succeeded',
      claimedJobs: 0,
      succeededJobs: 0,
      failedJobs: 0,
    })
    expect(statements).toBeLessThanOrEqual(50)
    expect(maxBindings).toBeLessThanOrEqual(100)
    const action = await env.DB.prepare(
      `SELECT id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
              version,created_at,updated_at,resolved_at
       FROM operational_actions
       WHERE fingerprint='security.authorization_denials:overflow' AND status='open'`
    ).first()
    expect(action).toMatchObject({
      fingerprint: 'security.authorization_denials:overflow',
      kind: 'authorization_denial_spike',
      severity: 'critical',
      status: 'open',
      entity_type: 'centre',
      entity_id: 'centre_1',
      version: 1,
      created_at: occurredAt,
      updated_at: occurredAt,
      resolved_at: null,
    })
    const details = await decryptForScope(context.keyring, context.dataKey, {
      expectedScope: context.scope,
      recordId: action.id,
      field: 'action_details',
      envelope: JSON.parse(action.details_envelope),
    })
    expect(JSON.parse(details)).toEqual({
      errorCode: 'AUTHORIZATION_DENIAL_OVERFLOW',
      minimumCount: 101,
      threshold: 100,
      windowMinutes: 15,
    })
  })
})

describe('ordinary outbox integration and privacy', () => {
  it.each([
    ['v3 success', 'success', 'stored', null],
    ['recovery drift', 'recovery_drift', 'failed', 'BACKUP_MIGRATION_SET_CHANGED'],
    ['manifest and cleanup failure', 'manifest_cleanup_failure', 'failed', 'BACKUP_ORPHAN_CLEANUP_FAILED'],
  ])('keeps the real non-injected %s path within 47 work statements and a three-statement reserve', async (
    _label, mode, expectedStatus, expectedError,
  ) => {
    const context = await cryptoContext()
    const budgetMonth = { success: 0, recovery_drift: 1, manifest_cleanup_failure: 2 }[mode]
    const scheduledTime = Date.UTC(2039, budgetMonth, 2, 2, 15)
    const archive = realBackupArchive(mode)
    let statements = 0
    let recoveryReads = 0
    const executed = []
    const terminal = async ({ sql, execute }) => {
      statements += 1
      executed.push(sql.replaceAll(/\s+/g, ' ').trim().slice(0, 100))
      return execute()
    }
    const db = trackedDb(env.DB, {
      run: terminal,
      first: terminal,
      raw: terminal,
      async all({ sql, execute }) {
        statements += 1
        executed.push(sql.replaceAll(/\s+/g, ' ').trim().slice(0, 100))
        if (/WITH migration_snapshot AS/i.test(sql)
          && /JOIN workbook_imports AS imported/i.test(sql)) {
          recoveryReads += 1
          const row = structuredClone(recoveryRow)
          if (mode === 'recovery_drift' && recoveryReads === 2) row.activity_version += 1
          return { results: [row], success: true }
        }
        return execute()
      },
      async batch({ sql, execute }) {
        statements += sql.length
        executed.push(...sql.map((value) => value.replaceAll(/\s+/g, ' ').trim().slice(0, 100)))
        return execute()
      },
    })
    const backupId = `bkp_scheduler_real_${mode}`
    const deps = schedulerDeps(`real_${mode}`, context, scheduledTime, {
      cryptoContext: undefined,
      createKeyring: async () => context.keyring,
      backupDue: () => dueFor(scheduledTime),
      backupIdFactory: () => backupId,
      rawKeyFactory: () => new Uint8Array(32).fill(7),
      backupNonceFactory: () => new Uint8Array(12).fill(5),
      fetch: backupProviderFetch(),
      wait: async () => {},
    })
    expect(Object.hasOwn(deps, 'processBackupCreate')).toBe(false)

    const result = await runScheduled({
      scheduledTime,
      env: backupProviderEnv(db, archive.binding),
      deps,
    })
    const observedBackup = await env.DB.prepare(
      'SELECT status,last_error_code FROM backup_runs WHERE id=?'
    ).bind(backupId).first()
    const observedJobs = (await jobsForBackup(backupId)).map(({ status, last_error_code: lastErrorCode }) => ({
      status, lastErrorCode,
    }))
    expect(result.status, JSON.stringify({ result, statements, observedBackup, observedJobs, executed }))
      .toBe('succeeded')
    expect(result.backupEnqueued).toBe(true)

    expect(statements).toBeLessThanOrEqual(47)
    expect(50 - statements).toBeGreaterThanOrEqual(3)
    expect(recoveryReads).toBe(2)
    expect(observedBackup).toEqual({
      status: expectedStatus,
      last_error_code: expectedError,
    })
    if (mode === 'success') {
      expect(archive.calls.filter((call) => call.startsWith('put:')).map((call) => call.slice(4)))
        .toEqual([
          `backups/v3/${dueFor(scheduledTime).localMonth.replace('-', '/')}/${backupId}.sql`,
          `backups/v3/${dueFor(scheduledTime).localMonth.replace('-', '/')}/${backupId}.manifest.json`,
        ])
    }
    if (mode === 'manifest_cleanup_failure') expect(archive.objects.size).toBe(1)
  })

  it('runs one bounded retention pass when no backup create job is claimed', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const processBackupCreate = vi.fn(async () => ({
      claimed: false, result: null, backupId: null,
    }))
    const processBackupRetention = vi.fn(async () => ({ selected: 0, pruned: 0 }))

    await expect(runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('backup_retention_pass', context, scheduledTime, {
        processBackupCreate,
        processBackupRetention,
      }),
    })).resolves.toMatchObject({ status: 'succeeded' })

    expect(processBackupRetention).toHaveBeenCalledOnce()
    expect(processBackupRetention.mock.calls[0][0]).toMatchObject({
      db: expect.any(Object),
      archive: env.ARCHIVE,
      nowMs: scheduledTime,
      limit: 5,
    })
  })

  it('runs one dedicated backup before ordinary work and leaves provider jobs queued', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const timestamp = nowIso(scheduledTime)
    const backupId = 'bkp_scheduler_dedicated_processor'
    await enqueueBackup(context, {
      jobId: 'job_scheduler_dedicated_processor',
      backupId,
      localDay: dueFor(scheduledTime).localDay,
      timestamp,
    })
    await enqueueOrdinary(context, {
      id: 'job_scheduler_deferred_for_backup',
      scheduledAt: timestamp,
      suffix: 'scheduler_deferred_for_backup',
    })
    const processBackupCreate = vi.fn(async ({ schedulerRun, checkpoint }) => {
      await checkpoint()
      expect(schedulerRun).toMatchObject({
        attemptCount: 1,
        leaseOwner: expect.stringMatching(/^lease_/),
      })
      return { claimed: true, result: 'succeeded', backupId }
    })
    const ordinary = vi.fn(async () => [{
      id: 'job_scheduler_deferred_for_backup', result: 'succeeded',
    }])

    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('dedicated_backup_processor', context, scheduledTime, {
        processBackupCreate,
        processOutboxBatch: ordinary,
      }),
    })

    expect(result).toMatchObject({
      status: 'succeeded',
      claimedJobs: 0,
      succeededJobs: 0,
      failedJobs: 0,
    })
    expect(processBackupCreate).toHaveBeenCalledOnce()
    expect(ordinary).not.toHaveBeenCalled()
    expect(await env.DB.prepare(
      'SELECT status,attempt_count FROM outbox_jobs WHERE id=?'
    ).bind('job_scheduler_deferred_for_backup').first()).toEqual({
      status: 'queued', attempt_count: 0,
    })
    await env.DB.prepare(
      "UPDATE outbox_jobs SET status='dead',last_error_code='TEST_CLEANUP' WHERE id=?"
    ).bind('job_scheduler_dedicated_processor').run()
    await env.DB.prepare(
      "UPDATE backup_runs SET status='failed',version=version+1,last_error_code='TEST_CLEANUP' WHERE id=?"
    ).bind(backupId).run()
    await env.DB.prepare(
      "UPDATE outbox_jobs SET scheduled_at='9999-12-31T23:59:59.999Z' WHERE id=?"
    ).bind('job_scheduler_deferred_for_backup').run()
  })

  it('leaves ordinary jobs queued when the dedicated drain processor is not injected', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const timestamp = nowIso(scheduledTime)
    const jobId = 'job_scheduler_dedicated_drain'
    await enqueueOrdinary(context, {
      id: jobId,
      scheduledAt: timestamp,
      suffix: 'scheduler_dedicated_drain',
    })
    const deps = schedulerDeps('dedicated_drain', context, scheduledTime)
    delete deps.processOutboxBatch

    await expect(runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps,
    })).resolves.toMatchObject({
      status: 'succeeded',
      claimedJobs: 0,
      succeededJobs: 0,
      failedJobs: 0,
    })

    expect(await env.DB.prepare(
      'SELECT status,attempt_count FROM outbox_jobs WHERE id=?'
    ).bind(jobId).first()).toEqual({ status: 'queued', attempt_count: 0 })
    await env.DB.prepare(
      "UPDATE outbox_jobs SET scheduled_at='9999-12-31T23:59:59.999Z' WHERE id=?"
    ).bind(jobId).run()
  })

  it('stops normal work at 47 statements and uses the final three only for failure state', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    let statements = 0
    const terminal = async ({ execute }) => {
      statements += 1
      return execute()
    }
    const db = trackedDb(env.DB, {
      run: terminal,
      first: terminal,
      all: terminal,
      raw: terminal,
      async batch({ sql, execute }) {
        statements += sql.length
        return execute()
      },
    })
    const process = vi.fn(async ({ db: budgetedDb }) => {
      for (let index = 0; index < 100; index += 1) {
        await budgetedDb.prepare('SELECT 1').first()
      }
      return []
    })

    await expect(runScheduled({
      scheduledTime,
      env: runtimeEnv(db),
      deps: schedulerDeps('query_budget', context, scheduledTime, {
        processOutboxBatch: process,
      }),
    })).resolves.toMatchObject({
      status: 'failed',
      reason: 'coordinator_failed',
    })

    expect(statements).toBe(50)
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: 'failed',
      error_code: 'SCHEDULER_COORDINATOR_FAILED',
    })
  })

  it('dispatches at most one ordinary job while dormant backup work remains untouched', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const timestamp = nowIso(scheduledTime)
    for (let index = 0; index < 11; index += 1) {
      await enqueueOrdinary(context, {
        id: `job_scheduler_max_ten_${String(index).padStart(2, '0')}`,
        scheduledAt: timestamp,
        suffix: `scheduler_max_ten_${index}`,
      })
    }
    await enqueueBackup(context, {
      jobId: 'job_scheduler_dormant',
      backupId: 'bkp_scheduler_dormant',
      localDay: dueFor(scheduledTime).localDay,
      timestamp,
    })
    const dispatches = []
    const dispatchOutboxJob = vi.fn(async ({ job }) => {
      dispatches.push(job.id)
      return { result: 'succeeded' }
    })
    const deps = schedulerDeps('max_ten', context, scheduledTime, {
      processOutboxBatch,
      dispatchOutboxJob,
    })

    const result = await runScheduled({ scheduledTime, env: runtimeEnv(), deps })
    expect(result).toMatchObject({
      status: 'succeeded',
      claimedJobs: 1,
      succeededJobs: 1,
      failedJobs: 0,
    })
    expect(dispatches).toEqual(['job_scheduler_max_ten_00'])
    expect(dispatches).not.toContain('job_scheduler_dormant')
    expect(await env.DB.prepare('SELECT status,attempt_count FROM outbox_jobs WHERE id=?')
      .bind('job_scheduler_dormant').first()).toEqual({ status: 'queued', attempt_count: 0 })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM outbox_jobs
       WHERE id LIKE 'job_scheduler_max_ten_%' AND status='queued'`
    ).first()).toEqual({ count: 10 })
    await env.DB.prepare(
      `UPDATE outbox_jobs SET scheduled_at='9999-12-31T23:59:59.999Z'
       WHERE id LIKE 'job_scheduler_max_ten_%' AND status='queued'`
    ).run()
  })

  it('leaves a claimed ordinary job open when scheduler ownership changes before dispatch', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const jobId = 'job_dispatch_takeover'
    await enqueueOrdinary(context, {
      id: jobId,
      scheduledAt: nowIso(scheduledTime),
      suffix: 'dispatch_takeover',
    })
    const dispatchOutboxJob = vi.fn(async () => ({ result: 'succeeded' }))
    let takeoverInstalled = false
    const db = trackedDb(env.DB, {
      async first({ sql, execute }) {
        const row = await execute()
        if (!takeoverInstalled
          && sql === 'SELECT * FROM outbox_jobs WHERE id=?'
          && row?.id === jobId
          && row.status === 'processing') {
          takeoverInstalled = true
          await env.DB.prepare(
            `UPDATE scheduler_runs
             SET started_at=?,completed_at=NULL,status='running',attempt_count=2,
                 lease_owner='dispatch_takeover_owner',lease_expires_at=?,claimed_jobs=0,
                 succeeded_jobs=0,failed_jobs=0,error_code=NULL
             WHERE scheduled_for=?`
          ).bind(
            nowIso(scheduledTime + 1),
            nowIso(scheduledTime + LEASE_MS * 2),
            nowIso(scheduledTime),
          ).run()
        }
        return row
      },
    })

    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(db),
      deps: schedulerDeps('dispatch_takeover', context, scheduledTime, {
        processOutboxBatch,
        dispatchOutboxJob,
      }),
    })

    expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed' })
    expect(takeoverInstalled).toBe(true)
    expect(dispatchOutboxJob).not.toHaveBeenCalled()
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: 'running',
      attempt_count: 2,
      lease_owner: 'dispatch_takeover_owner',
      completed_at: null,
      claimed_jobs: 0,
      succeeded_jobs: 0,
      failed_jobs: 0,
      error_code: null,
    })
    expect(await env.DB.prepare(
      `SELECT status,attempt_count,lease_owner,lease_expires_at,last_error_code
       FROM outbox_jobs WHERE id=?`
    ).bind(jobId).first()).toMatchObject({
      status: 'processing',
      attempt_count: 1,
      last_error_code: null,
    })
    expect((await env.DB.prepare(
      `SELECT completed_at,result,error_code,provider_reference
       FROM outbox_attempts WHERE job_id=? ORDER BY attempt_number,id`
    ).bind(jobId).all()).results).toEqual([{
      completed_at: null,
      result: null,
      error_code: null,
      provider_reference: null,
    }])
    expect((await env.DB.prepare(
      `SELECT id FROM operational_actions
       WHERE entity_type='outbox_job' AND entity_id=?`
    ).bind(jobId).all()).results).toEqual([])
    expect((await env.DB.prepare(
      'SELECT id FROM delivery_attempts WHERE outbox_job_id=?'
    ).bind(jobId).all()).results).toEqual([])

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE outbox_attempts SET completed_at=?,result='succeeded'
         WHERE job_id=? AND attempt_number=1 AND completed_at IS NULL`
      ).bind(nowIso(scheduledTime), jobId),
      env.DB.prepare(
        `UPDATE outbox_jobs
         SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
         WHERE id=? AND status='processing'`
      ).bind(nowIso(scheduledTime), jobId),
    ])
  })

  it.each([
    ['succeeded', 1, 0],
    ['retry', 0, 1],
    ['dead', 0, 1],
  ])('counts one %s outcome without leaking handler details or failing the coordinator', async (
    expectedResult,
    succeededJobs,
    failedJobs,
  ) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const jobId = `job_scheduler_outcome_${expectedResult}`
    const providerSecret = 'parent@example.test provider body'
    const log = vi.fn()
    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps(`outcome_counts_${expectedResult}`, context, scheduledTime, {
        processOutboxBatch: vi.fn(async () => [{ id: jobId, result: expectedResult }]),
        safeLog: log,
      }),
    })

    expect(result).toMatchObject({
      status: 'succeeded',
      claimedJobs: 1,
      succeededJobs,
      failedJobs,
    })
    expect(JSON.stringify(await schedulerRow(scheduledTime))).not.toContain(providerSecret)
    expect(JSON.stringify(log.mock.calls)).not.toContain(providerSecret)
  })

  it.each([
    ['not an array', null],
    ['more than one', Array.from({ length: 2 }, (_, index) => ({ id: `job_bad_${index}`, result: 'succeeded' }))],
    ['duplicate ids', [{ id: 'job_bad_duplicate', result: 'succeeded' }, { id: 'job_bad_duplicate', result: 'retry' }]],
    ['extra facts', [{ id: 'job_bad_extra', result: 'succeeded', payload: 'secret' }]],
    ['invalid result', [{ id: 'job_bad_result', result: 'dormant' }]],
    ['invalid id', [{ id: 'bad id', result: 'succeeded' }]],
  ])('contains malformed processor output: %s', async (_label, outcomes) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const raw = 'provider-secret@example.test'
    const log = vi.fn()
    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps(`malformed_processor_${serial}`, context, scheduledTime, {
        processOutboxBatch: vi.fn(async () => {
          if (outcomes === null) throw new Error(raw)
          return outcomes
        }),
        safeLog: log,
      }),
    })

    expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed' })
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: 'failed',
      error_code: 'SCHEDULER_COORDINATOR_FAILED',
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain(raw)
  })

  it('emits only fixed scheduler events, results, counters, run identity, and failure code', async () => {
    const context = await cryptoContext()
    const completedTime = schedule(++serial)
    const completedLog = vi.fn()
    await runScheduled({
      scheduledTime: completedTime,
      env: runtimeEnv(),
      deps: schedulerDeps('fixed_logs_completed', context, completedTime, {
        processOutboxBatch: vi.fn(async () => [
          { id: 'job_log_success', result: 'succeeded' },
        ]),
        safeLog: completedLog,
      }),
    })
    expect(completedLog.mock.calls).toEqual([
      ['info', {
        event: 'scheduler.started',
        result: 'started',
        runId: 'id_fixed_logs_completed_1',
        attemptCount: 1,
        claimedJobs: 0,
        succeededJobs: 0,
        failedJobs: 0,
      }],
      ['info', {
        event: 'scheduler.completed',
        result: 'completed',
        runId: 'id_fixed_logs_completed_1',
        attemptCount: 1,
        claimedJobs: 1,
        succeededJobs: 1,
        failedJobs: 0,
      }],
    ])

    const failedTime = schedule(++serial)
    const failedLog = vi.fn()
    await runScheduled({
      scheduledTime: failedTime,
      env: runtimeEnv(),
      deps: schedulerDeps('fixed_logs_failed', context, failedTime, {
        processOutboxBatch: vi.fn(async () => { throw new Error('backup id bkp_secret parent@example.test') }),
        safeLog: failedLog,
      }),
    })
    expect(failedLog.mock.calls.at(-1)).toEqual(['error', {
      event: 'scheduler.failed',
      result: 'failure',
      runId: 'id_fixed_logs_failed_1',
      attemptCount: 1,
      claimedJobs: 0,
      succeededJobs: 0,
      failedJobs: 0,
      errorCode: 'SCHEDULER_COORDINATOR_FAILED',
    }])
    expect(JSON.stringify(failedLog.mock.calls)).not.toContain('bkp_secret')
    expect(JSON.stringify(failedLog.mock.calls)).not.toContain('parent@example.test')
    expect(JSON.stringify(failedLog.mock.calls)).not.toContain(nowIso(failedTime))
  })

  it.each([
    ['scheduler.started', 'succeeded'],
    ['scheduler.completed', 'succeeded'],
    ['scheduler.failed', 'failed'],
  ])('keeps scheduler state and return authoritative when %s logging throws', async (throwEvent, expectedStatus) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const secret = `logger-secret-${throwEvent}@example.test`
    const safeLog = vi.fn((_level, fields) => {
      if (fields.event === throwEvent) throw new Error(secret)
    })
    const resultPromise = runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps(`throwing_log_${serial}`, context, scheduledTime, {
        safeLog,
        ...(throwEvent === 'scheduler.failed' ? {
          processOutboxBatch: vi.fn(async () => { throw new Error('coordinator-private-body') }),
        } : {}),
      }),
    })

    await expect(resultPromise).resolves.toMatchObject({
      status: expectedStatus,
      reason: expectedStatus === 'succeeded' ? null : 'coordinator_failed',
    })
    const result = await resultPromise
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: expectedStatus,
      error_code: expectedStatus === 'succeeded' ? null : 'SCHEDULER_COORDINATOR_FAILED',
    })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it.each([
    ['scheduler.started', 'succeeded'],
    ['scheduler.completed', 'succeeded'],
    ['scheduler.failed', 'failed'],
  ])('awaits and contains asynchronous %s logging rejection', async (throwEvent, expectedStatus) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const secret = `async-logger-secret-${throwEvent}@example.test`
    let rejectLogger
    const loggerResult = new Promise((_resolve, reject) => { rejectLogger = reject })
    let observeTargetCall
    const targetCalled = new Promise((resolve) => { observeTargetCall = resolve })
    const safeLog = vi.fn(async (_level, fields) => {
      if (fields.event !== throwEvent) return
      observeTargetCall()
      return loggerResult
    })
    const resultPromise = runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps(`async_throwing_log_${serial}`, context, scheduledTime, {
        safeLog,
        ...(throwEvent === 'scheduler.failed' ? {
          processOutboxBatch: vi.fn(async () => { throw new Error('coordinator-private-body') }),
        } : {}),
      }),
    })

    await targetCalled
    const targetIndex = safeLog.mock.calls.findIndex(([, fields]) => fields.event === throwEvent)
    safeLog.mock.results[targetIndex].value.catch(() => {})
    let settled = false
    resultPromise.then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(settled).toBe(false)

    rejectLogger(new Error(secret))
    await expect(resultPromise).resolves.toMatchObject({
      status: expectedStatus,
      reason: expectedStatus === 'succeeded' ? null : 'coordinator_failed',
    })
    const result = await resultPromise
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: expectedStatus,
      error_code: expectedStatus === 'succeeded' ? null : 'SCHEDULER_COORDINATOR_FAILED',
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(safeLog.mock.calls)).not.toContain(secret)
  })
})

describe('failed same-day replacement', () => {
  it('keeps failed/dead history byte-for-byte and converges concurrent eligible rows on one new pair', async () => {
    const context = await cryptoContext()
    const firstTime = schedule(++serial)
    const secondTime = firstTime + 60_000
    const due = dueFor(firstTime)
    const timestamp = nowIso(firstTime - 86_400_000)
    await seedBackup({
      id: 'bkp_failed_same_day_old',
      localDay: due.localDay,
      localMonth: due.localMonth,
      retentionClass: 'monthly',
      status: 'failed',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    await enqueueBackup(context, {
      jobId: 'job_failed_same_day_old',
      backupId: 'bkp_failed_same_day_old',
      localDay: due.localDay,
      timestamp,
    })
    await env.DB.prepare(
      `UPDATE outbox_jobs SET status='dead',attempt_count=8,last_error_code='BACKUP_FAILED',
       updated_at=? WHERE id=?`
    ).bind(timestamp, 'job_failed_same_day_old').run()
    const oldBackup = await env.DB.prepare('SELECT * FROM backup_runs WHERE id=?')
      .bind('bkp_failed_same_day_old').first()
    const oldJob = await env.DB.prepare('SELECT * FROM outbox_jobs WHERE id=?')
      .bind('job_failed_same_day_old').first()

    const [first, second] = await Promise.all([
      runScheduled({
        scheduledTime: firstTime,
        env: runtimeEnv(),
        deps: schedulerDeps('same_day_first', context, firstTime, {
          backupDue: undefined,
          backupIdFactory: () => 'bkp_failed_same_day_new_a',
        }),
      }),
      runScheduled({
        scheduledTime: secondTime,
        env: runtimeEnv(),
        deps: schedulerDeps('same_day_second', context, secondTime, {
          backupDue: undefined,
          backupIdFactory: () => 'bkp_failed_same_day_new_b',
        }),
      }),
    ])
    expect([first, second].every(({ status }) => status === 'succeeded')).toBe(true)
    expect([first, second].filter(({ backupEnqueued }) => backupEnqueued)).toHaveLength(1)
    expect(await env.DB.prepare('SELECT * FROM backup_runs WHERE id=?')
      .bind('bkp_failed_same_day_old').first()).toEqual(oldBackup)
    expect(await env.DB.prepare('SELECT * FROM outbox_jobs WHERE id=?')
      .bind('job_failed_same_day_old').first()).toEqual(oldJob)
    const replacements = (await backupsForDay(due.localDay)).filter(({ status }) => status === 'queued')
    expect(replacements).toHaveLength(1)
    expect(replacements[0].id).not.toBe(oldBackup.id)
    const replacementJobs = await jobsForBackup(replacements[0].id)
    expect(replacementJobs).toHaveLength(1)
    expect(replacementJobs[0]).toMatchObject({
      status: 'queued',
      attempt_count: 0,
      idempotency_key: `backup.create:${due.localDay}:${replacements[0].id}`,
    })
  })
})

describe('crash and reply-loss convergence', () => {
  it.each(CRASH_STAGES)('recovers at %s without duplicating scheduler, backup, or ordinary effects', async (stage) => {
    const context = await cryptoContext()
      const scheduledTime = schedule(++serial)
      const due = dueFor(scheduledTime)
      const backupId = `bkp_crash_${stage}`
      const ordinaryId = `job_crash_${stage}_ordinary`
      if (stage === 'after_ordinary_finalization') {
        await enqueueOrdinary(context, {
          id: ordinaryId,
          scheduledAt: nowIso(scheduledTime),
          suffix: `crash_${stage}`,
        })
      }
      let tripped = false
      const db = trackedDb(env.DB, {
        async run({ sql, execute }) {
          if (!tripped
            && ['before_initial_insert', 'after_initial_insert'].includes(stage)
            && sql.includes('INSERT INTO scheduler_runs')) {
            tripped = true
            if (stage === 'before_initial_insert') throw new Error('reply lost before insert')
            if (stage === 'after_initial_insert') {
              await execute()
              throw new Error('reply lost after insert')
            }
          }
          return execute()
        },
        async first({ sql, execute }) {
          const value = await execute()
          if (!tripped && stage === 'after_crypto_load' && sql.includes('FROM data_keys')) {
            tripped = true
            throw new Error('reply lost after crypto load')
          }
          return value
        },
        async batch({ sql, execute }) {
          const backupBatch = sql.length === 3 && sql[0].includes('INSERT INTO backup_runs')
          const completionBatch = sql.some((text) => text.includes('UPDATE scheduler_runs')
            && text.includes("status='succeeded'"))
            && sql.some((text) => text.includes("'health.snapshot'"))
          const failureBatch = sql.length === 2 && sql[0].includes("status='failed'")
          if (tripped && failureBatch) throw new Error('failure transition refused')
          if (!tripped && backupBatch && stage === 'before_backup_batch') {
            tripped = true
            throw new Error('reply lost before backup batch')
          }
          if (!tripped && backupBatch && stage === 'after_backup_batch') {
            tripped = true
            await execute()
            throw new Error('reply lost after backup batch')
          }
          if (!tripped && completionBatch && stage === 'before_completion_batch') {
            tripped = true
            throw new Error('reply lost before completion')
          }
          if (!tripped && completionBatch && stage === 'after_completion_batch') {
            tripped = true
            await execute()
            throw new Error('reply lost after completion')
          }
          return execute()
        },
      })
      const firstProcess = stage === 'after_ordinary_finalization'
        ? async (input) => {
            const result = await processOutboxBatch(input)
            if (!tripped) {
              tripped = true
              throw new Error('reply lost after ordinary finalization')
            }
            return result
          }
        : vi.fn(async () => [])
      const firstDeps = schedulerDeps(`crash_first_${stage}`, context, scheduledTime, {
        backupDue: () => ['before_backup_batch', 'after_backup_batch'].includes(stage) ? due : false,
        backupIdFactory: () => backupId,
        processOutboxBatch: firstProcess,
        dispatchOutboxJob: vi.fn(async () => ({ result: 'succeeded' })),
        ...(stage === 'after_crypto_load' ? {
          cryptoContext: undefined,
          createKeyring: async () => context.keyring,
        } : {}),
      })
      await runScheduled({ scheduledTime, env: runtimeEnv(db), deps: firstDeps })

      const firstRow = await schedulerRow(scheduledTime)
      if (stage === 'before_initial_insert') {
        expect(firstRow).toBeNull()
      } else if (stage === 'after_completion_batch') {
        expect(firstRow).toMatchObject({ status: 'succeeded', attempt_count: 1 })
      } else {
        expect(firstRow).toMatchObject({
          status: 'running',
          attempt_count: 1,
          completed_at: null,
          claimed_jobs: 0,
          succeeded_jobs: 0,
          failed_jobs: 0,
          error_code: null,
        })
        const beforeExpiry = await runScheduled({
          scheduledTime,
          env: runtimeEnv(),
          deps: schedulerDeps(`crash_before_expiry_${stage}`, context, scheduledTime, {
            now: () => scheduledTime + LEASE_MS - 1,
          }),
        })
        expect(beforeExpiry, stage).toMatchObject({
          status: 'skipped',
          reason: 'live_lease',
        })
        expect(await schedulerRow(scheduledTime)).toEqual(firstRow)
      }
      const recoveryNow = scheduledTime + LEASE_MS + 1
      const recovery = await runScheduled({
        scheduledTime,
        env: runtimeEnv(),
        deps: schedulerDeps(`crash_recovery_${stage}`, context, scheduledTime, {
          now: () => recoveryNow,
          backupDue: () => ['before_backup_batch', 'after_backup_batch'].includes(stage) ? due : false,
          backupIdFactory: () => `${backupId}_recovery`,
          ...(stage === 'after_ordinary_finalization' ? {
            processOutboxBatch,
            dispatchOutboxJob: vi.fn(async () => ({ result: 'succeeded' })),
          } : {}),
        }),
      })
      if (stage === 'after_completion_batch') {
        expect(recovery, stage).toMatchObject({ status: 'skipped', reason: 'already_succeeded' })
      } else {
        expect(recovery, stage).toMatchObject({ status: 'succeeded' })
      }
      expect(await schedulerRow(scheduledTime)).toMatchObject({
        status: 'succeeded',
        attempt_count: stage === 'before_initial_insert' || stage === 'after_completion_batch' ? 1 : 2,
      })
      const backups = await backupsForDay(due.localDay)
      expect(backups.length).toBe(['before_backup_batch', 'after_backup_batch'].includes(stage) ? 1 : 0)
      if (backups.length) expect(await jobsForBackup(backups[0].id)).toHaveLength(1)
      if (stage === 'after_ordinary_finalization') {
        expect(await env.DB.prepare('SELECT status,attempt_count FROM outbox_jobs WHERE id=?')
          .bind(ordinaryId).first()).toEqual({ status: 'succeeded', attempt_count: 1 })
      }
  })

  it.each([
    'after_claim',
    'after_crypto',
    'before_backup',
    'after_backup',
    'before_processor',
    'after_ordinary_finalization',
    'before_completion',
  ])('a newer takeover after %s blocks the stale continuation at its next checkpoint', async (stage) => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const due = dueFor(scheduledTime)
    const ordinaryId = `job_takeover_${stage}`
    if (stage === 'after_ordinary_finalization') {
      await enqueueOrdinary(context, {
        id: ordinaryId,
        scheduledAt: nowIso(scheduledTime),
        suffix: `takeover_${stage}`,
      })
    }
    let taken = false
    const takeover = async () => {
      if (taken) return
      taken = true
      await env.DB.prepare(
        `UPDATE scheduler_runs SET attempt_count=attempt_count+1,lease_owner='takeover_owner',
         lease_expires_at=?,started_at=? WHERE scheduled_for=? AND status='running'`
      ).bind(
        nowIso(scheduledTime + LEASE_MS * 2),
        nowIso(scheduledTime),
        nowIso(scheduledTime),
      ).run()
    }
    const db = trackedDb(env.DB, {
      async first({ sql, execute }) {
        const value = await execute()
        if (stage === 'after_claim' && sql.includes('FROM scheduler_runs') && value?.status === 'running') {
          await takeover()
        }
        if (stage === 'after_crypto' && sql.includes('FROM data_keys')) await takeover()
        return value
      },
      async batch({ sql, execute }) {
        if (stage === 'after_backup' && sql[0]?.includes('INSERT INTO backup_runs')) {
          const value = await execute()
          await takeover()
          return value
        }
        return execute()
      },
    })
    const process = vi.fn(async (input) => {
      if (stage === 'after_ordinary_finalization') {
        const outcomes = await processOutboxBatch(input)
        await takeover()
        return outcomes
      }
      if (stage === 'before_completion') await takeover()
      return []
    })
    const deps = schedulerDeps(`takeover_matrix_${stage}`, context, scheduledTime, {
      backupDue: async () => {
        if (stage === 'before_backup' || stage === 'before_processor') await takeover()
        return stage === 'before_backup' || stage === 'after_backup' ? due : false
      },
      processOutboxBatch: process,
      ...(stage === 'after_crypto' ? {
        cryptoContext: undefined,
        createKeyring: async () => context.keyring,
      } : {}),
    })
    const result = await runScheduled({ scheduledTime, env: runtimeEnv(db), deps })

    expect(result).toMatchObject({ status: 'failed', reason: 'coordinator_failed' })
    expect(await schedulerRow(scheduledTime)).toMatchObject({
      status: 'running',
      attempt_count: 2,
      lease_owner: 'takeover_owner',
    })
    expect(process).toHaveBeenCalledTimes(
      ['after_ordinary_finalization', 'before_completion'].includes(stage) ? 1 : 0
    )
    if (stage !== 'after_backup') expect(await backupsForDay(due.localDay)).toEqual([])
    if (stage === 'after_backup') expect(result.backupEnqueued).toBe(true)
    if (stage === 'after_ordinary_finalization') {
      expect(await env.DB.prepare('SELECT status,attempt_count FROM outbox_jobs WHERE id=?')
        .bind(ordinaryId).first()).toEqual({ status: 'succeeded', attempt_count: 1 })
    }
  })
})

describe('pre-claim validation', () => {
  it('snapshots a changing scheduledTime accessor once for claim and due work', async () => {
    const context = await cryptoContext()
    const firstTime = schedule(++serial)
    const secondTime = schedule(++serial)
    let reads = 0
    const backupDue = vi.fn(() => false)
    const input = {
      get scheduledTime() {
        reads += 1
        return reads === 1 ? firstTime : secondTime
      },
      env: runtimeEnv(),
      deps: schedulerDeps('changing_scheduled_time', context, firstTime, { backupDue }),
    }

    await expect(runScheduled(input)).resolves.toMatchObject({ status: 'succeeded' })
    expect(reads).toBe(1)
    expect(backupDue).toHaveBeenCalledWith(firstTime, expect.any(Object))
    expect(await schedulerRow(firstTime)).toMatchObject({ status: 'succeeded' })
    expect(await schedulerRow(secondTime)).toBeNull()
  })

  it('maps a throwing dependency accessor to fixed pre-claim validation without logging its text', async () => {
    const scheduledTime = schedule(++serial)
    const secret = 'dependency-getter-secret@example.test'
    const log = vi.fn()
    let reads = 0
    const deps = { safeLog: log }
    Object.defineProperty(deps, 'now', {
      enumerable: true,
      get() {
        reads += 1
        throw new Error(secret)
      },
    })

    await expect(runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps,
    })).rejects.toThrow(/^SCHEDULER_INVALID$/)
    expect(reads).toBe(1)
    expect(log).not.toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    expect(await schedulerRow(scheduledTime)).toBeNull()
  })

  it('rejects an extended-year controller instant before persistence', async () => {
    const scheduledTime = 253_402_300_800_000
    const scheduledFor = new Date(scheduledTime).toISOString()

    await expect(runScheduled({
      scheduledTime,
      env: runtimeEnv(),
    })).rejects.toThrow(/^SCHEDULER_INVALID$/)
    expect(await env.DB.prepare(
      'SELECT id FROM scheduler_runs WHERE scheduled_for=?'
    ).bind(scheduledFor).first()).toBeNull()
  })

  it('contains an extended-year clock observation before persistence', async () => {
    const context = await cryptoContext()
    const scheduledTime = schedule(++serial)
    const result = await runScheduled({
      scheduledTime,
      env: runtimeEnv(),
      deps: schedulerDeps('extended_observation', context, scheduledTime, {
        now: () => 253_402_300_800_000,
      }),
    })

    expect(result).toEqual({
      status: 'failed',
      reason: 'coordinator_failed',
      runId: null,
      claimedJobs: 0,
      succeededJobs: 0,
      failedJobs: 0,
      backupEnqueued: false,
    })
    expect(await schedulerRow(scheduledTime)).toBeNull()
  })

  it.each([
    ['negative instant', -1, {}],
    ['fractional instant', 1.5, {}],
    ['unsafe instant', Number.MAX_SAFE_INTEGER + 1, {}],
    ['missing prepare', schedule(++serial), { env: { ...VALID_ENV, DB: { batch() {} } } }],
    ['missing batch', schedule(++serial), { env: { ...VALID_ENV, DB: { prepare() {} } } }],
    ['non-function dependency', schedule(++serial), { deps: { now: 1 } }],
  ])('rejects %s with the fixed scheduler input error', async (_label, scheduledTime, overrides) => {
    await expect(runScheduled({
      scheduledTime,
      env: overrides.env ?? runtimeEnv(),
      deps: overrides.deps ?? {},
    })).rejects.toThrow(/^SCHEDULER_INVALID$/)
  })
})
