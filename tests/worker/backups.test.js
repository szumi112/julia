import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
import * as backupsModule from '../../worker/operations/backups.js'
import { enqueueOutboxStatement } from '../../worker/jobs/outbox.js'
import { openBackupManifest, parseCanonicalManifest } from '../../worker/operations/backup-format.js'
import { encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'

const {
  downloadD1Export,
  pollD1Export,
  processNextBackupCreate,
  runNextBackupCreate,
} = backupsModule

const CLAIM_MS = Date.UTC(2044, 6, 29, 10, 0, 0)
const CLAIM_NOW = new Date(CLAIM_MS).toISOString()
const LEASE_MS = 12 * 60 * 1000
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const SCHEDULER_EXPIRY = new Date(CLAIM_MS + 4 * 60 * 60 * 1000).toISOString()
const EXPORT_ACCOUNT_ID = 'a'.repeat(32)
const EXPORT_DATABASE_ID = '12345678-1234-4abc-8abc-123456789abc'
const EXPORT_TOKEN = 'fictional-export-token'
const BACKUP_SOURCE = Object.freeze({
  accountId: EXPORT_ACCOUNT_ID,
  appEnv: 'staging',
  dataMode: 'fictional',
  databaseId: EXPORT_DATABASE_ID,
})
const EXPORT_BOOKMARK = 'bookmark-fixture-1'
const EXPORT_FILENAME = 'dump-fixture.sql'
const EXPORT_URL = 'https://download.example.test/dump-fixture.sql?signature=fictional'
const EXPORT_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${EXPORT_ACCOUNT_ID}/d1/database/${EXPORT_DATABASE_ID}/export`
const encoder = new TextEncoder()
const BACKUP_COLUMNS = Object.freeze([
  'id', 'local_day', 'local_month', 'retention_class', 'status', 'version',
  'export_bookmark', 'object_key', 'manifest_key', 'ssec_key_version',
  'wrapped_ssec_key_b64', 'wrap_nonce_b64', 'object_etag', 'object_size',
  'started_at', 'completed_at', 'expires_at', 'restore_verified_at',
  'last_error_code', 'created_at', 'updated_at',
])
let schedulerSerial = 0
let backupSerial = 0
let inputSerial = 0

const nonterminalResult = (bookmark = EXPORT_BOOKMARK) => ({ at_bookmark: bookmark })
const completeResult = (overrides = {}) => ({
  at_bookmark: EXPORT_BOOKMARK,
  filename: EXPORT_FILENAME,
  signed_url: EXPORT_URL,
  ...overrides,
})

function rawExportResponse(raw, {
  contentType = 'application/json',
  contentLength,
  status = 200,
} = {}) {
  const headers = new Headers()
  if (contentType !== null) headers.set('content-type', contentType)
  if (contentLength !== undefined) headers.set('content-length', contentLength)
  return new Response(raw, { status, headers })
}

function exportResponse(result = nonterminalResult(), {
  errors = [],
  messages = [],
  success = true,
  ...options
} = {}) {
  return rawExportResponse(JSON.stringify({ errors, messages, result, success }), options)
}

function responseLike(overrides = {}) {
  return {
    body: new ReadableStream({ start(controller) { controller.close() } }),
    bodyUsed: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    ok: true,
    redirected: false,
    status: 200,
    ...overrides,
  }
}

function exportInput({
  fetch = vi.fn(async () => exportResponse(completeResult())),
  wait,
  now,
  signal = new AbortController().signal,
  startMs = 0,
} = {}) {
  let clockMs = startMs
  return {
    input: {
      accountId: EXPORT_ACCOUNT_ID,
      databaseId: EXPORT_DATABASE_ID,
      token: EXPORT_TOKEN,
      fetch,
      wait: wait ?? vi.fn(async (delay) => { clockMs += delay }),
      now: now ?? vi.fn(() => clockMs),
      signal,
    },
    readClock: () => clockMs,
    setClock: (value) => { clockMs = value },
  }
}

function sequenceFetch(responses, hook) {
  let index = 0
  return vi.fn(async (...args) => {
    hook?.({ index, args })
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    return response
  })
}

function inspectableDeferred() {
  const outcomes = []
  class InspectablePromise extends Promise {
    then(onFulfilled, onRejected) {
      return super.then(
        (value) => {
          const outcome = onFulfilled(value)
          if (outcome && typeof outcome === 'object' && Object.hasOwn(outcome, 'kind')) {
            outcomes.push(outcome)
          }
          return outcome
        },
        (error) => {
          const outcome = onRejected(error)
          if (outcome && typeof outcome === 'object' && Object.hasOwn(outcome, 'kind')) {
            outcomes.push(outcome)
          }
          return outcome
        },
      )
    }
  }
  let resolve
  let reject
  const promise = new InspectablePromise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  Object.defineProperty(promise, 'constructor', { value: Promise })
  return { outcomes, promise, reject, resolve }
}

const exportError = async (input) => {
  try {
    await pollD1Export(input)
  } catch (error) {
    return error
  }
  throw new Error('EXPECTED_EXPORT_ERROR')
}

const downloadInput = (overrides = {}) => ({
  downloadUrl: EXPORT_URL,
  fetch: vi.fn(async () => responseLike({
    body: new ReadableStream({ start(controller) { controller.close() } }),
  })),
  signal: new AbortController().signal,
  ...overrides,
})

afterEach(async () => {
  await env.DB.prepare(
    `UPDATE outbox_jobs
     SET scheduled_at='9999-12-31T23:59:59.999Z',
         lease_expires_at=CASE WHEN status='processing'
           THEN '9999-12-31T23:59:59.999Z' ELSE lease_expires_at END
     WHERE type='backup.create'`
  ).run()
})

const sequence = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

async function cryptoContext() {
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_backup_claim',
    createdAt: '2044-07-01T00:00:00.000Z',
  })
  return { keyring, dataKey, scope: SCOPE }
}

async function seedScheduler(overrides = {}) {
  schedulerSerial += 1
  const row = {
    runId: `${overrides.runId ?? 'run_backup_claim'}_${schedulerSerial}`,
    attemptCount: overrides.attemptCount ?? 1,
    leaseOwner: `${overrides.leaseOwner ?? 'scheduler_backup_claim'}_${schedulerSerial}`,
    leaseExpiresAt: overrides.leaseExpiresAt ?? SCHEDULER_EXPIRY,
  }
  const scheduledFor = new Date(CLAIM_MS - 60_000 - schedulerSerial).toISOString()
  await env.DB.prepare(
    `INSERT INTO scheduler_runs
     (id,scheduled_for,started_at,completed_at,status,attempt_count,lease_owner,
      lease_expires_at,claimed_jobs,succeeded_jobs,failed_jobs,error_code)
     VALUES (?,?,?,NULL,'running',?,?,?,0,0,0,NULL)`
  ).bind(
    row.runId,
    scheduledFor,
    scheduledFor,
    row.attemptCount,
    row.leaseOwner,
    row.leaseExpiresAt,
  ).run()
  return row
}

async function envelopeFor(context, jobId, plaintext) {
  return JSON.stringify(await encryptForScope(
    context.keyring,
    context.dataKey,
    {
      expectedScope: context.scope,
      recordId: jobId,
      field: 'job_payload',
      plaintext,
    },
  ))
}

async function seedBackup({
  id,
  localDay,
  createdAt,
  status = 'queued',
  version = 1,
  retentionClass = 'daily',
  ...overrides
}) {
  const values = {
    id,
    local_day: localDay,
    local_month: localDay.slice(0, 7),
    retention_class: retentionClass,
    status,
    version,
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
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  }
  await env.DB.prepare(
    `INSERT INTO backup_runs (${BACKUP_COLUMNS.join(',')})
     VALUES (${BACKUP_COLUMNS.map(() => '?').join(',')})`
  ).bind(...BACKUP_COLUMNS.map((key) => values[key])).run()
  return values
}

async function seedQueued(context, {
  jobId,
  backupId,
  localDay,
  createdAt = new Date(CLAIM_MS - 1_000).toISOString(),
  plaintext = null,
  payloadEnvelope = null,
  idempotencyKey = null,
  backup = {},
  skipBackup = false,
} = {}) {
  backupSerial += 1
  jobId ??= `job_backup_claim_${backupSerial}`
  backupId ??= `bkp_backup_claim_${backupSerial}`
  localDay ??= new Date(Date.UTC(2050, 0, backupSerial)).toISOString().slice(0, 10)
  if (!skipBackup) {
    await seedBackup({ id: backupId, localDay, createdAt, ...backup })
  }
  if (plaintext === null && payloadEnvelope === null && idempotencyKey === null) {
    const statement = await enqueueOutboxStatement(env.DB, context, {
      id: jobId,
      type: 'backup.create',
      aggregateType: 'backup_run',
      aggregateId: backupId,
      payload: { backupId },
      idempotencyKey: `backup.create:${localDay}:${backupId}`,
      scheduledAt: createdAt,
      nowMs: Date.parse(createdAt),
      maxAttempts: 8,
    })
    await statement.run()
  } else {
    const storedEnvelope = payloadEnvelope ?? await envelopeFor(
      context,
      jobId,
      plaintext ?? `{"backupId":"${backupId}"}`,
    )
    await env.DB.prepare(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,lease_owner,lease_expires_at,
        last_error_code,created_at,updated_at)
       VALUES (?,'backup.create','backup_run',?,?,?,'queued',0,8,?,NULL,NULL,NULL,?,?)`
    ).bind(
      jobId,
      backupId,
      storedEnvelope,
      idempotencyKey ?? `backup.create:${localDay}:${backupId}`,
      createdAt,
      createdAt,
      createdAt,
    ).run()
  }
  return { jobId, backupId, localDay, createdAt }
}

const job = (id) => env.DB.prepare('SELECT * FROM outbox_jobs WHERE id=?').bind(id).first()
const backup = (id) => env.DB.prepare('SELECT * FROM backup_runs WHERE id=?').bind(id).first()
const attempts = async (jobId) => (await env.DB.prepare(
  'SELECT * FROM outbox_attempts WHERE job_id=? ORDER BY attempt_number,id'
).bind(jobId).all()).results

function processInput({
  db = env.DB,
  context,
  schedulerRun,
  nowMs = CLAIM_MS,
  idFactory,
  leaseOwnerFactory,
  providers = Object.freeze({}),
} = {}) {
  inputSerial += 1
  idFactory ??= sequence(`attempt_backup_claim_${inputSerial}`)
  leaseOwnerFactory ??= sequence(`owner_backup_claim_${inputSerial}`)
  return {
    db,
    cryptoContext: context,
    config: Object.freeze({ unused: true }),
    bindings: Object.freeze({ unused: true }),
    schedulerRun,
    now: () => nowMs,
    wait: Object.freeze({ unused: true }),
    idFactory,
    leaseOwnerFactory,
    nonceFactory: Object.freeze({ unused: true }),
    providers,
  }
}

async function initialClaim(options = {}) {
  const context = options.context ?? await cryptoContext()
  const schedulerRun = options.schedulerRun ?? await seedScheduler()
  const seeded = await seedQueued(context, options.seed)
  const input = processInput({ context, schedulerRun, ...options })
  const result = await processNextBackupCreate(input)
  return { context, schedulerRun, seeded, input, result }
}

function trackedDb(real, hooks = {}) {
  const wrap = (inner, sql) => ({
    __inner: inner,
    __sql: sql,
    bind(...values) {
      hooks.bind?.({ sql, values })
      return wrap(inner.bind(...values), sql)
    },
    async run(...args) {
      hooks.terminal?.({ method: 'run', sql })
      return inner.run(...args)
    },
    async first(...args) {
      hooks.terminal?.({ method: 'first', sql })
      const execute = () => inner.first(...args)
      return hooks.first ? hooks.first({ sql, execute }) : execute()
    },
    async all(...args) {
      hooks.terminal?.({ method: 'all', sql })
      const execute = () => inner.all(...args)
      return hooks.all ? hooks.all({ sql, execute }) : execute()
    },
    async raw(...args) {
      hooks.terminal?.({ method: 'raw', sql })
      return inner.raw(...args)
    },
  })
  return {
    prepare(sql) {
      hooks.prepare?.(sql)
      return wrap(real.prepare(sql), sql)
    },
    async batch(statements) {
      const inners = statements.map((statement) => statement.__inner ?? statement)
      const sql = statements.map((statement) => statement.__sql ?? '')
      const execute = (replacement = inners) => real.batch(replacement)
      return hooks.batch ? hooks.batch({ statements, inners, sql, execute }) : execute()
    },
  }
}

async function forceReclaims({ context, schedulerRun, count, startMs = CLAIM_MS }) {
  let nowMs = startMs
  for (let index = 0; index < count; index += 1) {
    nowMs += LEASE_MS + 1
    await processNextBackupCreate(processInput({
      context,
      schedulerRun,
      nowMs,
      idFactory: () => `attempt_backup_reclaim_${backupSerial}_${index + 2}`,
      leaseOwnerFactory: () => `owner_backup_reclaim_${backupSerial}_${index + 2}`,
    }))
  }
  return nowMs
}

async function seedProcessingHistory(context, terminal = {}) {
  const createdAt = new Date(CLAIM_MS - 2 * LEASE_MS - 20).toISOString()
  const firstStartedAt = new Date(Date.parse(createdAt) + 10).toISOString()
  const openStartedAt = new Date(CLAIM_MS - LEASE_MS - 10).toISOString()
  const leaseExpiresAt = new Date(CLAIM_MS - 1).toISOString()
  const seeded = await seedQueued(context, { createdAt })
  await env.DB.prepare(
    `UPDATE backup_runs
     SET status='exporting',version=2,started_at=?,updated_at=?
     WHERE id=?`
  ).bind(firstStartedAt, firstStartedAt, seeded.backupId).run()
  await env.DB.prepare(
    `UPDATE outbox_jobs
     SET status='processing',attempt_count=2,lease_owner=?,lease_expires_at=?,
         last_error_code='OUTBOX_LEASE_EXPIRED',updated_at=?
     WHERE id=?`
  ).bind(
    `owner_backup_history_${backupSerial}`,
    leaseExpiresAt,
    openStartedAt,
    seeded.jobId,
  ).run()
  const completedAt = terminal.completedAt ?? openStartedAt
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO outbox_attempts
       (id,job_id,attempt_number,started_at,completed_at,result,error_code,provider_reference)
       VALUES (?,?,1,?,?,?,?,?)`
    ).bind(
      `attempt_backup_history_${backupSerial}_1`,
      seeded.jobId,
      firstStartedAt,
      completedAt,
      terminal.result ?? 'retry',
      Object.hasOwn(terminal, 'errorCode')
        ? terminal.errorCode
        : 'OUTBOX_LEASE_EXPIRED',
      terminal.providerReference ?? null,
    ),
    env.DB.prepare(
      `INSERT INTO outbox_attempts
       (id,job_id,attempt_number,started_at,completed_at,result,error_code,provider_reference)
       VALUES (?,?,2,?,NULL,NULL,NULL,NULL)`
    ).bind(
      `attempt_backup_history_${backupSerial}_2`,
      seeded.jobId,
      openStartedAt,
    ),
  ])
  return { ...seeded, openStartedAt }
}

describe('special backup create claim', () => {
  it('exports only the exact two-field operation surface and leaves unused capabilities untouched', async () => {
    const module = await import('../../worker/operations/backups.js')
    expect(Object.keys(module).sort()).toEqual([
      'downloadD1Export',
      'pollD1Export',
      'processNextBackupCreate',
      'runNextBackupCreate',
    ])

    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const providers = new Proxy({}, { get() { throw new Error('PROVIDER_ACCESSED') } })
    const result = await processNextBackupCreate({
      ...processInput({ context, schedulerRun, providers }),
      config: new Proxy({}, { get() { throw new Error('CONFIG_ACCESSED') } }),
      bindings: new Proxy({}, { get() { throw new Error('BINDINGS_ACCESSED') } }),
      wait: new Proxy({}, { get() { throw new Error('WAIT_ACCESSED') } }),
      nonceFactory: new Proxy({}, { get() { throw new Error('NONCE_ACCESSED') } }),
    })

    expect(result).toEqual({ claimed: false, schedulerRun })
    expect(Reflect.ownKeys(result)).toEqual(['claimed', 'schedulerRun'])
    expect(result.schedulerRun).not.toBe(schedulerRun)
  })

  it('claims the deterministic oldest queued backup including scheduled-time ties', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const sameTime = new Date(CLAIM_MS - 2_000).toISOString()
    await seedQueued(context, {
      jobId: 'job_backup_tie_b', backupId: 'bkp_backup_tie_b', localDay: '2044-07-28', createdAt: sameTime,
    })
    await seedQueued(context, {
      jobId: 'job_backup_tie_a', backupId: 'bkp_backup_tie_a', localDay: '2044-07-27', createdAt: sameTime,
    })

    const result = await processNextBackupCreate(processInput({
      context,
      schedulerRun,
      idFactory: () => 'attempt_backup_oldest',
      leaseOwnerFactory: () => 'owner_backup_oldest',
    }))

    expect(result).toEqual({ claimed: true, schedulerRun })
    expect(await job('job_backup_tie_a')).toMatchObject({
      status: 'processing',
      attempt_count: 1,
      lease_owner: 'owner_backup_oldest',
      lease_expires_at: new Date(CLAIM_MS + LEASE_MS).toISOString(),
      last_error_code: null,
      updated_at: CLAIM_NOW,
    })
    expect(await backup('bkp_backup_tie_a')).toMatchObject({
      status: 'exporting', version: 2, started_at: CLAIM_NOW, updated_at: CLAIM_NOW,
    })
    expect(await attempts('job_backup_tie_a')).toEqual([{
      id: 'attempt_backup_oldest',
      job_id: 'job_backup_tie_a',
      attempt_number: 1,
      started_at: CLAIM_NOW,
      completed_at: null,
      result: null,
      error_code: null,
      provider_reference: null,
    }])
    expect(await job('job_backup_tie_b')).toMatchObject({ status: 'queued', attempt_count: 0 })
  })

  it('uses exactly one candidate read plus one four-member batch and obeys the caller budget', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    await seedQueued(context)
    const prepared = []
    let delegatedBatches = 0
    const tracked = trackedDb(env.DB, {
      prepare: (sql) => prepared.push(sql),
      batch: ({ execute }) => {
        delegatedBatches += 1
        return execute()
      },
    })
    const budget = createD1QueryBudget(tracked, { totalLimit: 8, recoveryReserve: 3 })

    await expect(processNextBackupCreate(processInput({
      db: budget.work, context, schedulerRun,
    }))).resolves.toEqual({ claimed: true, schedulerRun })

    expect(budget.usage()).toMatchObject({ used: 5, workRemaining: 0 })
    expect(delegatedBatches).toBe(1)
    expect(prepared).toHaveLength(5)
    expect(prepared[0]).toContain('WITH candidate AS')
    expect(prepared[0]).not.toContain('SELECT *')

    const secondContext = await cryptoContext()
    const secondScheduler = await seedScheduler({ runId: 'run_backup_over_budget' })
    await seedQueued(secondContext, {
      jobId: 'job_backup_over_budget', backupId: 'bkp_backup_over_budget', localDay: '2044-07-26',
    })
    let overBudgetDelegations = 0
    const tooSmall = createD1QueryBudget(trackedDb(env.DB, {
      batch: ({ execute }) => {
        overBudgetDelegations += 1
        return execute()
      },
    }), { totalLimit: 5, recoveryReserve: 1 })
    await expect(processNextBackupCreate(processInput({
      db: tooSmall.work,
      context: secondContext,
      schedulerRun: secondScheduler,
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    expect(overBudgetDelegations).toBe(0)
    expect(tooSmall.usage().used).toBe(1)
  })

  it('spends one statement and no batch when there is no backup candidate', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    let terminals = 0
    let batches = 0
    const db = trackedDb(env.DB, {
      terminal: () => { terminals += 1 },
      batch: () => { batches += 1 },
    })

    await expect(processNextBackupCreate(processInput({ db, context, schedulerRun })))
      .resolves.toEqual({ claimed: false, schedulerRun })
    expect(terminals).toBe(1)
    expect(batches).toBe(0)
  })

  it('does not claim, reap, process, or dispatch ordinary and provider work', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    await seedQueued(context)
    const ordinaryEnvelope = await envelopeFor(
      context,
      'job_ordinary_backup_isolation',
      '{"actorId":"stf_backup_test","invitationId":"inv_backup_isolation"}',
    )
    const ordinaryCreated = new Date(CLAIM_MS - 10_000).toISOString()
    await env.DB.prepare(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,created_at,updated_at)
       VALUES (?,'staff.invitation.expire','staff_invitation',?,?,?,'queued',0,8,?,?,?)`
    ).bind(
      'job_ordinary_backup_isolation',
      'inv_backup_isolation',
      ordinaryEnvelope,
      'staff.invitation.expire:backup-isolation',
      ordinaryCreated,
      ordinaryCreated,
      ordinaryCreated,
    ).run()
    const ordinaryBefore = await job('job_ordinary_backup_isolation')
    const provider = vi.fn(async () => { throw new Error('PROVIDER_CALLED') })

    await expect(processNextBackupCreate(processInput({
      context,
      schedulerRun,
      providers: Object.freeze({
        exportBackup: provider,
        reconcileAccessGroup: provider,
        sendInvitationEmail: provider,
      }),
    }))).resolves.toEqual({ claimed: true, schedulerRun })

    expect(await job('job_ordinary_backup_isolation')).toEqual(ordinaryBefore)
    expect(provider).not.toHaveBeenCalled()
  })
})

describe('operational backup create runner', () => {
  it('stores the SSE-C SQL before its canonical manifest and atomically completes the claimed job', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const seeded = await seedQueued(context, {
      jobId: 'job_backup_operational_store',
      backupId: 'bkp_backup_operational_store',
      localDay: '2044-07-29',
    })
    const keyring = await createKeyring(env, {
      activeBackupKekVersion: 1,
    })
    const sqlBytes = encoder.encode('PRAGMA foreign_keys=OFF;\n-- opaque-fixture\n')
    const rawSsecKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
    const calls = []
    const evidenceOrder = []
    const db = trackedDb(env.DB, {
      all: async ({ sql, execute }) => {
        const response = await execute()
        if (/SELECT id,\s*name\s+FROM d1_migrations\s+ORDER BY id\s+LIMIT 257/i.test(sql)) {
          evidenceOrder.push('migrations')
        }
        return response
      },
    })
    let storedSql = null
    let storedManifest = null
    const archive = {
      async put(key, value, options) {
        calls.push({ key, options })
        evidenceOrder.push(key.endsWith('.sql') ? 'sql' : 'manifest')
        if (key.endsWith('.sql')) {
          const reader = value.getReader()
          const chunks = []
          while (true) {
            const part = await reader.read()
            if (part.done) break
            chunks.push(part.value)
          }
          storedSql = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))
          return { etag: 'etag-operational-1', size: storedSql.byteLength }
        }
        storedManifest = value
        return { etag: 'manifest-etag-ignored', size: value.byteLength }
      },
    }
    const pollExport = vi.fn(async () => {
      evidenceOrder.push('export')
      return {
        atBookmark: 'bookmark-operational-1',
        downloadUrl: 'https://download.example.test/opaque?signature=secret',
      }
    })
    const downloadExport = vi.fn(async () => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(sqlBytes)
          controller.close()
        },
      }),
    }))

    const result = await runNextBackupCreate({
      db,
      cryptoContext: context,
      keyring,
      archive,
      providerConfig: {
        accountId: EXPORT_ACCOUNT_ID,
        databaseId: EXPORT_DATABASE_ID,
        token: EXPORT_TOKEN,
      },
      source: BACKUP_SOURCE,
      schedulerRun,
      now: () => CLAIM_MS,
      wait: async () => {},
      fetch: async () => { throw new Error('real fetch must stay outside this test') },
      signal: new AbortController().signal,
      idFactory: sequence('attempt_backup_operational'),
      leaseOwnerFactory: sequence('owner_backup_operational'),
      nonceFactory: () => new Uint8Array(12).fill(9),
      rawKeyFactory: () => rawSsecKey,
      pollExport,
      downloadExport,
    })

    expect(result).toEqual({ claimed: true, result: 'succeeded', backupId: seeded.backupId })
    expect(calls.map(({ key }) => key)).toEqual([
      `backups/v2/2044/07/${seeded.backupId}.sql`,
      `backups/v2/2044/07/${seeded.backupId}.manifest.json`,
    ])
    expect(calls[0].options.customMetadata).toEqual({
      backupId: seeded.backupId,
      format: 'bwm-d1-sql-v2',
      retentionClass: 'daily',
      sourceAppEnv: 'staging',
      sourceDatabaseId: EXPORT_DATABASE_ID,
    })
    expect(calls[0].options.ssecKey).toBeInstanceOf(ArrayBuffer)
    expect(calls[1].options).toBeUndefined()
    expect(storedSql).toEqual(sqlBytes)
    const manifest = parseCanonicalManifest(storedManifest)
    expect(manifest).toMatchObject({
      format: 'bwm-d1-sql-v2',
      backupId: seeded.backupId,
      atBookmark: 'bookmark-operational-1',
      objectEtag: 'etag-operational-1',
      objectSize: sqlBytes.byteLength,
      source: BACKUP_SOURCE,
      restoreSentinel: {
        kind: 'backup_run_v1',
        backupId: seeded.backupId,
        status: 'exporting',
        version: 2,
      },
    })
    expect(manifest.appliedMigrations.length).toBeGreaterThan(0)
    expect(manifest.appliedMigrations.every(({ id, name }) => (
      Number.isSafeInteger(id) && /^\d{4}_[a-z0-9_-]+\.sql$/.test(name)
    ))).toBe(true)
    expect(evidenceOrder).toEqual(['migrations', 'export', 'migrations', 'sql', 'manifest'])
    const opened = await openBackupManifest({ bytes: storedManifest, keyring })
    expect(opened.rawSsecKey).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
    opened.rawSsecKey.fill(0)
    expect(rawSsecKey).toEqual(new Uint8Array(32))
    expect(JSON.stringify(manifest)).not.toContain('signature=secret')
    expect(await backup(seeded.backupId)).toMatchObject({
      status: 'stored',
      version: 3,
      object_key: `backups/v2/2044/07/${seeded.backupId}.sql`,
      manifest_key: `backups/v2/2044/07/${seeded.backupId}.manifest.json`,
      object_etag: 'etag-operational-1',
      object_size: sqlBytes.byteLength,
      expires_at: '2044-09-02T00:00:00.000Z',
      last_error_code: null,
    })
    expect(await job(seeded.jobId)).toMatchObject({
      status: 'succeeded',
      attempt_count: 1,
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: null,
    })
    expect(await attempts(seeded.jobId)).toMatchObject([{
      result: 'succeeded',
      error_code: null,
      provider_reference: null,
    }])
    expect(pollExport).toHaveBeenCalledOnce()
    expect(downloadExport).toHaveBeenCalledOnce()
  })

  it('fails the backup and outbox attempt with a fixed code when manifest-last storage fails', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const seeded = await seedQueued(context, {
      jobId: 'job_backup_operational_failure',
      backupId: 'bkp_backup_operational_failure',
      localDay: '2044-07-30',
    })
    const keyring = await createKeyring(env, { activeBackupKekVersion: 1 })
    const rawSsecKey = new Uint8Array(32).fill(7)
    const providerMarker = 'signed-url@example.test provider-secret-body'
    let puts = 0
    const archive = {
      async put(_key, value) {
        puts += 1
        if (puts === 1) {
          await value.pipeTo(new WritableStream({ write() {} }))
          return { etag: 'etag-operational-failure', size: 4 }
        }
        throw new Error(providerMarker)
      },
    }

    await expect(runNextBackupCreate({
      db: env.DB,
      cryptoContext: context,
      keyring,
      archive,
      providerConfig: {
        accountId: EXPORT_ACCOUNT_ID,
        databaseId: EXPORT_DATABASE_ID,
        token: EXPORT_TOKEN,
      },
      source: BACKUP_SOURCE,
      schedulerRun,
      now: () => CLAIM_MS,
      wait: async () => {},
      fetch: async () => {},
      signal: new AbortController().signal,
      idFactory: sequence('attempt_backup_operational_failure'),
      leaseOwnerFactory: sequence('owner_backup_operational_failure'),
      nonceFactory: () => new Uint8Array(12).fill(5),
      rawKeyFactory: () => rawSsecKey,
      pollExport: async () => ({
        atBookmark: 'bookmark-operational-failure',
        downloadUrl: `https://download.example.test/dump?${providerMarker}`,
      }),
      downloadExport: async () => ({
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]))
            controller.close()
          },
        }),
      }),
    })).resolves.toEqual({
      claimed: true,
      result: 'dead',
      backupId: seeded.backupId,
      errorCode: 'BACKUP_CREATE_FAILED',
    })

    expect(rawSsecKey).toEqual(new Uint8Array(32))
    expect(JSON.stringify(await backup(seeded.backupId))).not.toContain(providerMarker)
    expect(await backup(seeded.backupId)).toMatchObject({
      status: 'failed', version: 3, last_error_code: 'BACKUP_CREATE_FAILED',
    })
    expect(await job(seeded.jobId)).toMatchObject({
      status: 'dead',
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: 'BACKUP_CREATE_FAILED',
    })
    expect(await attempts(seeded.jobId)).toMatchObject([{
      result: 'dead',
      error_code: 'BACKUP_CREATE_FAILED',
      provider_reference: null,
    }])
  })

  it('does not finalize a claim after the scheduler owner lease is lost', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler({
      leaseExpiresAt: new Date(CLAIM_MS + 1).toISOString(),
    })
    const seeded = await seedQueued(context, {
      jobId: 'job_backup_operational_owner_lost',
      backupId: 'bkp_backup_operational_owner_lost',
      localDay: '2044-07-31',
    })
    const keyring = await createKeyring(env, { activeBackupKekVersion: 1 })
    let clockCalls = 0
    const archive = { put: vi.fn(async () => ({ etag: 'unused', size: 0 })) }

    await expect(runNextBackupCreate({
      db: env.DB,
      cryptoContext: context,
      keyring,
      archive,
      providerConfig: {
        accountId: EXPORT_ACCOUNT_ID,
        databaseId: EXPORT_DATABASE_ID,
        token: EXPORT_TOKEN,
      },
      source: BACKUP_SOURCE,
      schedulerRun,
      now: () => CLAIM_MS + (clockCalls++ === 0 ? 0 : 2),
      wait: async () => {},
      fetch: async () => {},
      signal: new AbortController().signal,
      idFactory: sequence('attempt_backup_operational_owner_lost'),
      leaseOwnerFactory: sequence('owner_backup_operational_owner_lost'),
      nonceFactory: () => new Uint8Array(12).fill(4),
      rawKeyFactory: () => new Uint8Array(32).fill(5),
      pollExport: async () => ({
        atBookmark: 'bookmark-operational-owner-lost',
        downloadUrl: 'https://download.example.test/owner-lost',
      }),
      downloadExport: async () => ({
        body: new ReadableStream({ start(controller) { controller.close() } }),
      }),
    })).rejects.toThrow('BACKUP_LEASE_LOST')

    expect(archive.put).not.toHaveBeenCalled()
    expect(await backup(seeded.backupId)).toMatchObject({
      status: 'exporting', version: 2, last_error_code: null,
    })
    expect(await job(seeded.jobId)).toMatchObject({
      status: 'processing', attempt_count: 1, last_error_code: null,
    })
    expect(await attempts(seeded.jobId)).toMatchObject([{
      completed_at: null, result: null, error_code: null,
    }])
  })

  it.each([
    ['SQL', 1],
    ['manifest', 2],
  ])('terminalizes an expired final claim after %s upload so retention can clean it', async (_stage, expireAfterPut) => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const seeded = await seedQueued(context, {
      jobId: `job_backup_exhausted_after_${expireAfterPut}`,
      backupId: `bkp_backup_exhausted_after_${expireAfterPut}`,
      localDay: `2044-08-0${expireAfterPut}`,
    })
    await processNextBackupCreate(processInput({
      context,
      schedulerRun,
      idFactory: () => `attempt_backup_exhausted_${expireAfterPut}_1`,
      leaseOwnerFactory: () => `owner_backup_exhausted_${expireAfterPut}_1`,
    }))
    const attemptSevenNow = await forceReclaims({ context, schedulerRun, count: 6 })
    const attemptEightNow = attemptSevenNow + LEASE_MS + 1
    let nowMs = attemptEightNow
    let putCount = 0
    const archive = {
      async put(key, value) {
        putCount += 1
        if (key.endsWith('.sql')) await value.pipeTo(new WritableStream({ write() {} }))
        if (putCount === expireAfterPut) nowMs = attemptEightNow + LEASE_MS + 1
        return {
          etag: `etag-exhausted-${expireAfterPut}-${putCount}`,
          size: key.endsWith('.sql') ? 1 : value.byteLength,
        }
      },
    }
    const keyring = await createKeyring(env, { activeBackupKekVersion: 1 })
    const runnerInput = () => ({
      db: env.DB,
      cryptoContext: context,
      keyring,
      archive,
      providerConfig: {
        accountId: EXPORT_ACCOUNT_ID,
        databaseId: EXPORT_DATABASE_ID,
        token: EXPORT_TOKEN,
      },
      source: BACKUP_SOURCE,
      schedulerRun,
      now: () => nowMs,
      wait: async () => {},
      fetch: async () => {},
      signal: new AbortController().signal,
      idFactory: sequence(`attempt_backup_exhausted_${expireAfterPut}_8`),
      leaseOwnerFactory: sequence(`owner_backup_exhausted_${expireAfterPut}_8`),
      nonceFactory: () => new Uint8Array(12).fill(expireAfterPut),
      rawKeyFactory: () => new Uint8Array(32).fill(expireAfterPut + 1),
      pollExport: async () => ({
        atBookmark: `bookmark-exhausted-${expireAfterPut}`,
        downloadUrl: `https://download.example.test/exhausted-${expireAfterPut}`,
      }),
      downloadExport: async () => ({
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([expireAfterPut]))
            controller.close()
          },
        }),
      }),
    })

    await expect(runNextBackupCreate(runnerInput())).rejects.toThrow('BACKUP_LEASE_LOST')
    expect(putCount).toBe(expireAfterPut)
    expect(await job(seeded.jobId)).toMatchObject({
      status: 'processing', attempt_count: 8, last_error_code: 'OUTBOX_LEASE_EXPIRED',
    })
    expect(await backup(seeded.backupId)).toMatchObject({
      status: 'exporting', version: 2, last_error_code: null,
    })

    const terminalInput = runnerInput()
    terminalInput.pollExport = async () => { throw new Error('PROVIDER_MUST_NOT_RUN') }
    terminalInput.downloadExport = async () => { throw new Error('PROVIDER_MUST_NOT_RUN') }
    await expect(runNextBackupCreate(terminalInput)).resolves.toEqual({
      claimed: true,
      result: 'dead',
      backupId: seeded.backupId,
      errorCode: 'OUTBOX_LEASE_EXPIRED',
    })
    expect(await job(seeded.jobId)).toMatchObject({
      status: 'dead',
      attempt_count: 8,
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: 'OUTBOX_LEASE_EXPIRED',
    })
    expect(await backup(seeded.backupId)).toMatchObject({
      status: 'failed', version: 3, last_error_code: 'OUTBOX_LEASE_EXPIRED',
    })
    expect((await attempts(seeded.jobId)).at(-1)).toMatchObject({
      attempt_number: 8,
      result: 'dead',
      error_code: 'OUTBOX_LEASE_EXPIRED',
      provider_reference: null,
    })
  })

  it('retains a monthly stored backup for 12 calendar months', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const seeded = await seedQueued(context, {
      jobId: 'job_backup_operational_monthly',
      backupId: 'bkp_backup_operational_monthly',
      localDay: '2046-02-01',
      backup: { retention_class: 'monthly' },
    })
    const keyring = await createKeyring(env, { activeBackupKekVersion: 1 })
    let putCount = 0
    const archive = {
      async put(_key, value) {
        putCount += 1
        if (putCount === 1) {
          await value.pipeTo(new WritableStream({ write() {} }))
          return { etag: 'etag-operational-monthly', size: 1 }
        }
        return { etag: 'manifest-operational-monthly', size: value.byteLength }
      },
    }

    await runNextBackupCreate({
      db: env.DB,
      cryptoContext: context,
      keyring,
      archive,
      providerConfig: {
        accountId: EXPORT_ACCOUNT_ID,
        databaseId: EXPORT_DATABASE_ID,
        token: EXPORT_TOKEN,
      },
      source: BACKUP_SOURCE,
      schedulerRun,
      now: () => CLAIM_MS,
      wait: async () => {},
      fetch: async () => {},
      signal: new AbortController().signal,
      idFactory: sequence('attempt_backup_operational_monthly'),
      leaseOwnerFactory: sequence('owner_backup_operational_monthly'),
      nonceFactory: () => new Uint8Array(12).fill(6),
      rawKeyFactory: () => new Uint8Array(32).fill(8),
      pollExport: async () => ({
        atBookmark: 'bookmark-operational-monthly',
        downloadUrl: 'https://download.example.test/monthly',
      }),
      downloadExport: async () => ({
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
            controller.close()
          },
        }),
      }),
    })

    expect(await backup(seeded.backupId)).toMatchObject({
      status: 'stored',
      retention_class: 'monthly',
      expires_at: '2047-02-01T00:00:00.000Z',
    })
  })

  it('rejects a migration-set change after bookmark creation before downloading or storing artifacts', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const seeded = await seedQueued(context, {
      jobId: 'job_backup_migration_drift',
      backupId: 'bkp_backup_migration_drift',
      localDay: '2046-03-01',
    })
    let migrationReads = 0
    const db = trackedDb(env.DB, {
      all: async ({ sql, execute }) => {
        const response = await execute()
        if (!/SELECT id,\s*name\s+FROM d1_migrations\s+ORDER BY id\s+LIMIT 257/i.test(sql)) {
          return response
        }
        migrationReads += 1
        if (migrationReads === 1) return response
        return {
          ...response,
          results: [...response.results, { id: 9999, name: '9999_drift.sql' }],
        }
      },
    })
    const archive = { put: vi.fn() }
    const downloadExport = vi.fn()

    await expect(runNextBackupCreate({
      db,
      cryptoContext: context,
      keyring: await createKeyring(env, { activeBackupKekVersion: 1 }),
      archive,
      providerConfig: {
        accountId: EXPORT_ACCOUNT_ID,
        databaseId: EXPORT_DATABASE_ID,
        token: EXPORT_TOKEN,
      },
      source: BACKUP_SOURCE,
      schedulerRun,
      now: () => CLAIM_MS,
      wait: async () => {},
      fetch: async () => {},
      signal: new AbortController().signal,
      idFactory: sequence('attempt_backup_migration_drift'),
      leaseOwnerFactory: sequence('owner_backup_migration_drift'),
      nonceFactory: () => new Uint8Array(12).fill(6),
      rawKeyFactory: () => new Uint8Array(32).fill(8),
      pollExport: async () => ({
        atBookmark: 'bookmark-migration-drift',
        downloadUrl: 'https://download.example.test/migration-drift',
      }),
      downloadExport,
    })).resolves.toEqual({
      claimed: true,
      result: 'dead',
      backupId: seeded.backupId,
      errorCode: 'BACKUP_MIGRATION_SET_CHANGED',
    })
    expect(migrationReads).toBe(2)
    expect(downloadExport).not.toHaveBeenCalled()
    expect(archive.put).not.toHaveBeenCalled()
  })
})

describe('strict backup reclaim', () => {
  it.each([
    ['61 seconds', 61_000],
    ['five minutes', 5 * 60_000],
    ['the exact twelve-minute expiry', LEASE_MS],
  ])('does not reclaim at %s', async (_label, offset) => {
    const { context, schedulerRun, seeded } = await initialClaim()
    const beforeJob = await job(seeded.jobId)
    const beforeAttempts = await attempts(seeded.jobId)

    await expect(processNextBackupCreate(processInput({
      context, schedulerRun, nowMs: CLAIM_MS + offset,
    }))).resolves.toEqual({ claimed: false, schedulerRun })
    expect(await job(seeded.jobId)).toEqual(beforeJob)
    expect(await attempts(seeded.jobId)).toEqual(beforeAttempts)
  })

  it('reclaims only at expiry plus one millisecond with fixed retry completion', async () => {
    const { context, schedulerRun, seeded } = await initialClaim({
      idFactory: () => 'attempt_backup_expiry_1',
      leaseOwnerFactory: () => 'owner_backup_expiry_1',
    })
    const backupBefore = await backup(seeded.backupId)
    const reclaimNowMs = CLAIM_MS + LEASE_MS + 1

    await expect(processNextBackupCreate(processInput({
      context,
      schedulerRun,
      nowMs: reclaimNowMs,
      idFactory: () => 'attempt_backup_expiry_2',
      leaseOwnerFactory: () => 'owner_backup_expiry_2',
    }))).resolves.toEqual({ claimed: true, schedulerRun })

    expect(await job(seeded.jobId)).toMatchObject({
      status: 'processing',
      attempt_count: 2,
      lease_owner: 'owner_backup_expiry_2',
      lease_expires_at: new Date(reclaimNowMs + LEASE_MS).toISOString(),
      last_error_code: 'OUTBOX_LEASE_EXPIRED',
      updated_at: new Date(reclaimNowMs).toISOString(),
    })
    expect(await attempts(seeded.jobId)).toEqual([
      {
        id: 'attempt_backup_expiry_1', job_id: seeded.jobId, attempt_number: 1,
        started_at: CLAIM_NOW, completed_at: new Date(reclaimNowMs).toISOString(),
        result: 'retry', error_code: 'OUTBOX_LEASE_EXPIRED', provider_reference: null,
      },
      {
        id: 'attempt_backup_expiry_2', job_id: seeded.jobId, attempt_number: 2,
        started_at: new Date(reclaimNowMs).toISOString(), completed_at: null,
        result: null, error_code: null, provider_reference: null,
      },
    ])
    expect(await backup(seeded.backupId)).toEqual(backupBefore)
  })

  it('reclaims repeatedly with one contiguous open attempt each time', async () => {
    const { context, schedulerRun, seeded } = await initialClaim({
      idFactory: () => 'attempt_backup_repeat_1',
      leaseOwnerFactory: () => 'owner_backup_repeat_1',
    })
    await forceReclaims({ context, schedulerRun, count: 3 })
    const rows = await attempts(seeded.jobId)

    expect((await job(seeded.jobId)).attempt_count).toBe(4)
    expect(rows.map((row) => row.attempt_number)).toEqual([1, 2, 3, 4])
    expect(rows.filter((row) => row.completed_at === null)).toHaveLength(1)
    expect(rows.slice(0, -1).every((row) => (
      row.result === 'retry' && row.error_code === 'OUTBOX_LEASE_EXPIRED'
    ))).toBe(true)
  })

  it('allows attempt seven to become private recovery-only attempt eight then terminalizes exhaustion', async () => {
    const { context, schedulerRun, seeded } = await initialClaim({
      idFactory: () => 'attempt_backup_recovery_1',
      leaseOwnerFactory: () => 'owner_backup_recovery_1',
    })
    const attemptSevenNow = await forceReclaims({ context, schedulerRun, count: 6 })
    expect((await job(seeded.jobId)).attempt_count).toBe(7)

    const attemptEightNow = attemptSevenNow + LEASE_MS + 1
    const result = await processNextBackupCreate(processInput({
      context,
      schedulerRun,
      nowMs: attemptEightNow,
      idFactory: () => 'attempt_backup_recovery_8',
      leaseOwnerFactory: () => 'owner_backup_recovery_8',
    }))
    expect(result).toEqual({ claimed: true, schedulerRun })
    expect(Reflect.ownKeys(result)).toEqual(['claimed', 'schedulerRun'])
    expect((await job(seeded.jobId)).attempt_count).toBe(8)
    expect((await attempts(seeded.jobId)).filter((row) => row.completed_at === null))
      .toEqual([expect.objectContaining({ attempt_number: 8 })])

    await expect(processNextBackupCreate(processInput({
      context,
      schedulerRun,
      nowMs: attemptEightNow + LEASE_MS + 1,
      idFactory: () => 'attempt_backup_recovery_9',
      leaseOwnerFactory: () => 'owner_backup_recovery_9',
    }))).resolves.toEqual({ claimed: true, schedulerRun })
    expect(await job(seeded.jobId)).toMatchObject({
      status: 'dead', attempt_count: 8, last_error_code: 'OUTBOX_LEASE_EXPIRED',
    })
    expect(await backup(seeded.backupId)).toMatchObject({
      status: 'failed', version: 3, last_error_code: 'OUTBOX_LEASE_EXPIRED',
    })
    expect((await attempts(seeded.jobId)).at(-1)).toMatchObject({
      attempt_number: 8, result: 'dead', error_code: 'OUTBOX_LEASE_EXPIRED',
    })
  })

  it('uses the same exact five-statement budget for reclaim', async () => {
    const { context, schedulerRun } = await initialClaim()
    const tracked = trackedDb(env.DB)
    const budget = createD1QueryBudget(tracked, { totalLimit: 8, recoveryReserve: 3 })
    await expect(processNextBackupCreate(processInput({
      db: budget.work,
      context,
      schedulerRun,
      nowMs: CLAIM_MS + LEASE_MS + 1,
    }))).resolves.toEqual({ claimed: true, schedulerRun })
    expect(budget.usage()).toMatchObject({ used: 5, workRemaining: 0 })
  })
})

describe('backup validation and closed errors', () => {
  it.each([
    ['envelope', null],
    ['payload', null],
    ['idempotency key', null],
    ['missing backup relationship', null],
    ['non-null queued job error', async ({ seeded }) => env.DB.prepare(
      "UPDATE outbox_jobs SET last_error_code='UNEXPECTED' WHERE id=?"
    ).bind(seeded.jobId).run()],
    ['non-null backup storage fact', null],
    ['backup version', null],
    ['queued attempt history', async ({ seeded }) => env.DB.prepare(
      'INSERT INTO outbox_attempts (id,job_id,attempt_number,started_at) VALUES (?,?,1,?)'
    ).bind('attempt_backup_malformed_history', seeded.jobId, seeded.createdAt).run()],
  ])('fails closed on the oldest malformed %s instead of claiming a later row', async (kind, mutate) => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const suffix = kind.replaceAll(/[^A-Za-z0-9]/g, '_')
    const malformedDay = new Date(Date.UTC(2060, 0, schedulerSerial * 2)).toISOString().slice(0, 10)
    const laterDay = new Date(Date.UTC(2060, 0, schedulerSerial * 2 + 1)).toISOString().slice(0, 10)
    const seedOptions = {
      jobId: `job_backup_malformed_oldest_${suffix}`,
      backupId: `bkp_backup_malformed_oldest_${suffix}`,
      localDay: malformedDay,
      createdAt: new Date(CLAIM_MS - 10_000).toISOString(),
    }
    if (kind === 'payload') {
      seedOptions.plaintext = `{"backupId":"${seedOptions.backupId}","extra":true}`
    }
    if (kind === 'envelope') seedOptions.payloadEnvelope = '{}'
    if (kind === 'idempotency key') {
      seedOptions.idempotencyKey = `backup.create:${malformedDay}:bkp_wrong_${suffix}`
    }
    if (kind === 'missing backup relationship') seedOptions.skipBackup = true
    if (kind === 'non-null backup storage fact') seedOptions.backup = { export_bookmark: 'unexpected' }
    if (kind === 'backup version') seedOptions.backup = { version: 2 }
    const seeded = await seedQueued(context, seedOptions)
    const later = await seedQueued(context, {
      jobId: `job_backup_malformed_later_${suffix}`,
      backupId: `bkp_backup_malformed_later_${suffix}`,
      localDay: laterDay,
      createdAt: new Date(CLAIM_MS - 5_000).toISOString(),
    })
    if (mutate) await mutate({ seeded })

    await expect(processNextBackupCreate(processInput({ context, schedulerRun })))
      .rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    expect(await job(later.jobId)).toMatchObject({ status: 'queued', attempt_count: 0 })
  })

  it('rejects malformed reclaim history and leaves the selected row unchanged', async () => {
    const { context, schedulerRun, seeded } = await initialClaim()
    await env.DB.prepare(
      `INSERT INTO outbox_attempts
       (id,job_id,attempt_number,started_at,completed_at,result,error_code)
       VALUES (?,?,2,?,?,'retry','OUTBOX_LEASE_EXPIRED')`
    ).bind(
      'attempt_backup_history_extra',
      seeded.jobId,
      CLAIM_NOW,
      new Date(CLAIM_MS + 1).toISOString(),
    ).run()
    const before = await job(seeded.jobId)

    await expect(processNextBackupCreate(processInput({
      context, schedulerRun, nowMs: CLAIM_MS + LEASE_MS + 1,
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    expect(await job(seeded.jobId)).toEqual(before)
  })

  it.each([
    ['invalid attempt id', () => 'not canonical'],
    ['throwing attempt id factory', () => { throw new Error('SECRET_ID_FAILURE') }],
  ])('maps %s to the fixed state error without leaking details', async (_label, idFactory) => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    await seedQueued(context)
    await expect(processNextBackupCreate(processInput({
      context, schedulerRun, idFactory,
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
  })

  it('maps an exact generated attempt identity collision to the fixed state error', async () => {
    const { context, schedulerRun, seeded } = await initialClaim({
      idFactory: () => 'attempt_backup_collision',
      leaseOwnerFactory: () => 'owner_backup_collision_1',
    })
    const before = await job(seeded.jobId)
    await expect(processNextBackupCreate(processInput({
      context,
      schedulerRun,
      nowMs: CLAIM_MS + LEASE_MS + 1,
      idFactory: () => 'attempt_backup_collision',
      leaseOwnerFactory: () => 'owner_backup_collision_2',
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    expect(await job(seeded.jobId)).toEqual(before)
    expect(await attempts(seeded.jobId)).toHaveLength(1)
  })

  it('maps a duplicate generated owner guard to lease lost and rolls back', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const seeded = await seedQueued(context)
    const otherEnvelope = await envelopeFor(
      context,
      'job_backup_owner_collision_other',
      '{"actorId":"stf_owner_collision","invitationId":"inv_owner_collision"}',
    )
    await env.DB.prepare(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,lease_owner,lease_expires_at,created_at,updated_at)
       VALUES (?,'staff.invitation.expire','staff_invitation',?,?,?,'processing',1,8,?,?,?,?,?)`
    ).bind(
      'job_backup_owner_collision_other',
      'inv_owner_collision',
      otherEnvelope,
      'staff.invitation.expire:owner-collision',
      CLAIM_NOW,
      'owner_backup_duplicate',
      SCHEDULER_EXPIRY,
      CLAIM_NOW,
      CLAIM_NOW,
    ).run()
    const beforeJob = await job(seeded.jobId)
    const beforeBackup = await backup(seeded.backupId)

    await expect(processNextBackupCreate(processInput({
      context,
      schedulerRun,
      leaseOwnerFactory: () => 'owner_backup_duplicate',
    }))).rejects.toThrow(/^BACKUP_LEASE_LOST$/)
    expect(await job(seeded.jobId)).toEqual(beforeJob)
    expect(await backup(seeded.backupId)).toEqual(beforeBackup)
    expect(await attempts(seeded.jobId)).toEqual([])
  })

  it('rejects inexact inputs, accessors, unsafe time, and overflow before D1 with fixed errors', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const valid = processInput({ context, schedulerRun })
    const accessor = { ...valid }
    Object.defineProperty(accessor, 'now', {
      enumerable: true,
      get() { throw new Error('SECRET_GETTER') },
    })
    const cases = [
      { ...valid, extra: true },
      { ...valid, schedulerRun: { ...schedulerRun, extra: true } },
      { ...valid, schedulerRun: { ...schedulerRun, attemptCount: 0 } },
      { ...valid, schedulerRun: { ...schedulerRun, leaseExpiresAt: CLAIM_NOW } },
      { ...valid, now: () => Number.MAX_SAFE_INTEGER },
      accessor,
      new Proxy(valid, { ownKeys() { throw new Error('SECRET_PROXY') } }),
    ]
    for (const input of cases) {
      await expect(processNextBackupCreate(input)).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    }
  })

  it('rejects malformed candidate result and exact row projections without native detail', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    await seedQueued(context)
    const malformedResultDb = trackedDb(env.DB, {
      all: async ({ execute }) => {
        await execute()
        return { success: true }
      },
    })
    await expect(processNextBackupCreate(processInput({
      db: malformedResultDb, context, schedulerRun,
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)

    const extraProjectionDb = trackedDb(env.DB, {
      all: async ({ execute }) => {
        const result = await execute()
        return { ...result, results: result.results.map((row) => ({ ...row, unexpected: true })) }
      },
    })
    await expect(processNextBackupCreate(processInput({
      db: extraProjectionDb, context, schedulerRun,
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
  })

  it('detaches D1 response and row data without invoking hostile accessors', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    await seedQueued(context)
    let responseReads = 0
    const responseDb = trackedDb(env.DB, {
      all: async ({ execute }) => {
        const result = await execute()
        return Object.defineProperty({}, 'results', {
          enumerable: true,
          get() { responseReads += 1; return result.results },
        })
      },
    })
    await expect(processNextBackupCreate(processInput({
      db: responseDb, context, schedulerRun,
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    expect(responseReads).toBe(0)

    let rowReads = 0
    const rowDb = trackedDb(env.DB, {
      all: async ({ execute }) => {
        const result = await execute()
        const row = { ...result.results[0] }
        Object.defineProperty(row, 'job_id', {
          enumerable: true,
          get() { rowReads += 1; return result.results[0].job_id },
        })
        return { ...result, results: [row] }
      },
    })
    await expect(processNextBackupCreate(processInput({
      db: rowDb, context, schedulerRun,
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    expect(rowReads).toBe(0)
  })

  it('validates batch success from fixed data descriptors without invoking accessors', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const seeded = await seedQueued(context)
    let successReads = 0
    const db = trackedDb(env.DB, {
      batch: () => Array.from({ length: 4 }, () => Object.defineProperty({}, 'success', {
        enumerable: true,
        get() { successReads += 1; return true },
      })),
    })
    await expect(processNextBackupCreate(processInput({
      db, context, schedulerRun,
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    expect(successReads).toBe(0)
    expect(await job(seeded.jobId)).toMatchObject({ status: 'queued', attempt_count: 0 })
  })

  it('rejects a non-string backup id without coercing it', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    await seedQueued(context)
    let coercions = 0
    const db = trackedDb(env.DB, {
      all: async ({ execute }) => {
        const result = await execute()
        return {
          ...result,
          results: [{
            ...result.results[0],
            job_aggregate_id: {
              toString() { coercions += 1; return 'bkp_hostile' },
            },
          }],
        }
      },
    })
    await expect(processNextBackupCreate(processInput({
      db, context, schedulerRun,
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    expect(coercions).toBe(0)
  })

  it('returns the captured scheduler fence when the caller mutates its object across an await', async () => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const expectedFence = { ...schedulerRun }
    await seedQueued(context)
    const db = trackedDb(env.DB, {
      all: async ({ execute }) => {
        const result = await execute()
        schedulerRun.attemptCount = 999
        schedulerRun.leaseOwner = 'mutated_after_capture'
        return result
      },
    })

    const result = await processNextBackupCreate(processInput({
      db, context, schedulerRun,
    }))
    expect(result).toEqual({ claimed: true, schedulerRun: expectedFence })
    expect(result.schedulerRun).not.toBe(schedulerRun)
  })

  it.each(['database', 'decrypt', 'factory'])(
    'closes a hostile value thrown from the %s boundary without leaking classifier failures',
    async (source) => {
      const context = await cryptoContext()
      const schedulerRun = await seedScheduler()
      if (source !== 'database') await seedQueued(context)
      let hostileReads = 0
      let thrown
      if (source === 'database') {
        thrown = Object.defineProperty({}, 'message', {
          enumerable: true,
          get() { hostileReads += 1; throw new Error('HOSTILE_MESSAGE_GETTER') },
        })
      } else if (source === 'decrypt') {
        thrown = {
          message: {
            toString() { hostileReads += 1; throw new Error('HOSTILE_MESSAGE_COERCION') },
          },
        }
      } else {
        thrown = new Proxy({}, {
          get(target, key) {
            if (key === 'message') {
              hostileReads += 1
              throw new Error('HOSTILE_MESSAGE_PROXY')
            }
            return Reflect.get(target, key)
          },
        })
      }
      const input = processInput({
        context,
        schedulerRun,
        ...(source === 'database'
          ? {
              db: {
                prepare() { throw thrown },
                batch() { throw new Error('BATCH_REACHED') },
              },
            }
          : {}),
        ...(source === 'decrypt'
          ? {
              context: Object.defineProperty({}, 'keyring', {
                enumerable: true,
                get() { throw thrown },
              }),
            }
          : {}),
        ...(source === 'factory' ? { idFactory: () => { throw thrown } } : {}),
      })

      await expect(processNextBackupCreate(input)).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
      expect(hostileReads).toBe(0)
    },
  )

  it.each([
    ['succeeded result', { result: 'succeeded', errorCode: null }],
    ['dead result', { result: 'dead', errorCode: 'BACKUP_DEAD' }],
    ['wrong retry error', { errorCode: 'WRONG_RETRY_ERROR' }],
    ['provider reference', { providerReference: 'provider_history' }],
    ['broken completion-to-next-start link', { completedAt: new Date(CLAIM_MS - LEASE_MS - 11).toISOString() }],
  ])('rejects a contiguous reclaim history with a prior %s', async (_label, terminal) => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const seeded = await seedProcessingHistory(context, terminal)
    const beforeJob = await job(seeded.jobId)
    const beforeAttempts = await attempts(seeded.jobId)

    await expect(processNextBackupCreate(processInput({
      context,
      schedulerRun,
      nowMs: CLAIM_MS,
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    expect(await job(seeded.jobId)).toEqual(beforeJob)
    expect(await attempts(seeded.jobId)).toEqual(beforeAttempts)
  })
})

describe('backup claim fences, rollback, and concurrency', () => {
  it.each([1, 2, 3])('rolls back all prior work when batch member %i succeeds and the next aborts', async (completedMembers) => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const seeded = await seedQueued(context)
    const beforeJob = await job(seeded.jobId)
    const beforeBackup = await backup(seeded.backupId)
    const db = trackedDb(env.DB, {
      batch: ({ inners, execute }) => {
        const forced = env.DB.prepare(
          "INSERT INTO outbox_operation_guard_failures (operation_id) VALUES ('forced_backup_rollback')"
        )
        const replacement = [...inners]
        replacement[completedMembers] = forced
        return execute(replacement)
      },
    })

    await expect(processNextBackupCreate(processInput({
      db, context, schedulerRun,
    }))).rejects.toThrow(/^BACKUP_LEASE_LOST$/)
    expect(await job(seeded.jobId)).toEqual(beforeJob)
    expect(await backup(seeded.backupId)).toEqual(beforeBackup)
    expect(await attempts(seeded.jobId)).toEqual([])
  })

  it.each(['scheduler', 'job owner', 'backup version'])('maps a stale %s race to lease lost with no diagnostic read', async (race) => {
    const { context, schedulerRun, seeded } = await initialClaim()
    const reclaimMs = CLAIM_MS + LEASE_MS + 1
    const beforeAttempts = await attempts(seeded.jobId)
    let candidateReads = 0
    const db = trackedDb(env.DB, {
      all: async ({ execute }) => {
        candidateReads += 1
        return execute()
      },
      batch: async ({ execute }) => {
        if (race === 'scheduler') {
          await env.DB.prepare(
            'UPDATE scheduler_runs SET attempt_count=attempt_count+1,lease_owner=? WHERE id=?'
          ).bind('scheduler_backup_takeover', schedulerRun.runId).run()
        } else if (race === 'job owner') {
          await env.DB.prepare(
            'UPDATE outbox_jobs SET lease_owner=? WHERE id=?'
          ).bind('owner_backup_takeover', seeded.jobId).run()
        } else {
          await env.DB.prepare(
            'UPDATE backup_runs SET version=3 WHERE id=?'
          ).bind(seeded.backupId).run()
        }
        return execute()
      },
    })

    await expect(processNextBackupCreate(processInput({
      db, context, schedulerRun, nowMs: reclaimMs,
    }))).rejects.toThrow(/^BACKUP_LEASE_LOST$/)
    expect(candidateReads).toBe(1)
    expect(await attempts(seeded.jobId)).toEqual(beforeAttempts)
  })

  it.each(['second open attempt', 'noncontiguous completed attempt'])('the final guard rejects a concurrent %s', async (race) => {
    const { context, schedulerRun, seeded } = await initialClaim()
    const reclaimMs = CLAIM_MS + LEASE_MS + 1
    const db = trackedDb(env.DB, {
      batch: async ({ execute }) => {
        if (race === 'second open attempt') {
          await env.DB.prepare(
            'INSERT INTO outbox_attempts (id,job_id,attempt_number,started_at) VALUES (?,?,7,?)'
          ).bind('attempt_backup_race_open', seeded.jobId, CLAIM_NOW).run()
        } else {
          await env.DB.prepare(
            `INSERT INTO outbox_attempts
             (id,job_id,attempt_number,started_at,completed_at,result,error_code)
             VALUES (?,?,7,?,?,'retry','OUTBOX_LEASE_EXPIRED')`
          ).bind('attempt_backup_race_gap', seeded.jobId, CLAIM_NOW, CLAIM_NOW).run()
        }
        return execute()
      },
    })

    await expect(processNextBackupCreate(processInput({
      db, context, schedulerRun, nowMs: reclaimMs,
    }))).rejects.toThrow(/^BACKUP_LEASE_LOST$/)
    expect((await job(seeded.jobId)).attempt_count).toBe(1)
  })

  it.each(['initial', 'reclaim'])('allows only one committed %s claimant', async (kind) => {
    const context = await cryptoContext()
    const schedulerRun = await seedScheduler()
    const seeded = await seedQueued(context)
    let nowMs = CLAIM_MS
    if (kind === 'reclaim') {
      await processNextBackupCreate(processInput({
        context,
        schedulerRun,
        idFactory: () => 'attempt_backup_concurrent_1',
        leaseOwnerFactory: () => 'owner_backup_concurrent_1',
      }))
      nowMs += LEASE_MS + 1
    }
    let arrived = 0
    let release
    const barrier = new Promise((resolve) => { release = resolve })
    const claimantDb = () => trackedDb(env.DB, {
      all: async ({ execute }) => {
        const result = await execute()
        arrived += 1
        if (arrived === 2) release()
        await barrier
        return result
      },
    })
    const settled = await Promise.allSettled([
      processNextBackupCreate(processInput({
        db: claimantDb(), context, schedulerRun, nowMs,
        idFactory: () => 'attempt_backup_concurrent_a',
        leaseOwnerFactory: () => 'owner_backup_concurrent_a',
      })),
      processNextBackupCreate(processInput({
        db: claimantDb(), context, schedulerRun, nowMs,
        idFactory: () => 'attempt_backup_concurrent_b',
        leaseOwnerFactory: () => 'owner_backup_concurrent_b',
      })),
    ])

    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((entry) => entry.status === 'rejected')).toHaveLength(1)
    expect(settled.find((entry) => entry.status === 'rejected').reason)
      .toEqual(new Error('BACKUP_LEASE_LOST'))
    const currentJob = await job(seeded.jobId)
    const currentAttempts = await attempts(seeded.jobId)
    expect(currentAttempts.filter((row) => row.completed_at === null)).toHaveLength(1)
    expect(currentAttempts).toHaveLength(kind === 'initial' ? 1 : 2)
    expect(currentJob.attempt_count).toBe(kind === 'initial' ? 1 : 2)
  })
})

describe('strict D1 export adapter input boundary', () => {
  it('exports exactly the processor and two adapters with fresh exact-key results', async () => {
    expect(Object.keys(backupsModule).sort()).toEqual([
      'downloadD1Export',
      'pollD1Export',
      'processNextBackupCreate',
      'runNextBackupCreate',
    ])
    const poll = await pollD1Export(exportInput().input)
    expect(poll).toEqual({ downloadUrl: EXPORT_URL, atBookmark: EXPORT_BOOKMARK })
    expect(Reflect.ownKeys(poll)).toEqual(['downloadUrl', 'atBookmark'])
    expect(Object.getPrototypeOf(poll)).toBe(Object.prototype)
    expect(Object.values(Object.getOwnPropertyDescriptors(poll)).every((descriptor) => (
      descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    ))).toBe(true)

    const stream = new ReadableStream({ start(controller) { controller.close() } })
    const download = await downloadD1Export(downloadInput({
      fetch: vi.fn(async () => responseLike({ body: stream })),
    }))
    expect(download).toEqual({ body: stream })
    expect(Reflect.ownKeys(download)).toEqual(['body'])
    expect(Object.getPrototypeOf(download)).toBe(Object.prototype)
    expect(poll).not.toBe(await pollD1Export(exportInput().input))
    expect(download).not.toBe(await downloadD1Export(downloadInput()))
  })

  it('requires exact own enumerable data descriptors before any dependency call', async () => {
    const { input } = exportInput()
    const invalidInputs = []
    for (const key of Reflect.ownKeys(input)) {
      const missing = { ...input }
      delete missing[key]
      invalidInputs.push(missing)
    }
    invalidInputs.push(
      null,
      [],
      Object.assign(Object.create(null), input),
      Object.assign(Object.create({ accountId: input.accountId }), {
        ...input,
        accountId: undefined,
      }),
      { ...input, extra: true },
      { ...input, [Symbol('signal')]: input.signal },
    )
    const hidden = { ...input }
    Object.defineProperty(hidden, 'token', { value: input.token, enumerable: false })
    invalidInputs.push(hidden)
    const accessor = { ...input }
    let getterCalls = 0
    Object.defineProperty(accessor, 'token', {
      enumerable: true,
      get() { getterCalls += 1; return input.token },
    })
    invalidInputs.push(accessor)

    for (const candidate of invalidInputs) {
      await expect(pollD1Export(candidate)).rejects.toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
    }
    expect(getterCalls).toBe(0)
    expect(input.fetch).not.toHaveBeenCalled()
    expect(input.wait).not.toHaveBeenCalled()
    expect(input.now).not.toHaveBeenCalled()
  })

  it('rejects invalid captured provider facts, dependencies, clock, and signal without coercion', async () => {
    const base = exportInput().input
    const coercion = { toString() { throw new Error('COERCION_ACCESSED') } }
    const invalid = [
      { accountId: '0'.repeat(32) },
      { accountId: 'A'.repeat(32) },
      { accountId: coercion },
      { databaseId: '00000000-0000-0000-0000-000000000000' },
      { databaseId: '00000000-0000-0000-0000-000000000001' },
      { databaseId: '12345678-1234-4abc-8abc-123456789abC' },
      { token: '' },
      { token: 'x'.repeat(4097) },
      { token: `fictional\u200btoken` },
      { token: coercion },
      { fetch: null },
      { wait: null },
      { now: null },
      { signal: {} },
    ]
    for (const overrides of invalid) {
      const input = { ...base, ...overrides }
      await expect(pollD1Export(input)).rejects.toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
    }
    expect(base.fetch).not.toHaveBeenCalled()
  })

  it('closes observable Proxy traps, re-entry, and inconsistent descriptor snapshots', async () => {
    const base = exportInput().input
    for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
      const proxy = new Proxy(base, {
        [trap]() { throw new Error(`HOSTILE_${trap}`) },
      })
      await expect(pollD1Export(proxy)).rejects.toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
    }

    const inconsistent = new Proxy(base, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'wait') return undefined
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    await expect(pollD1Export(inconsistent)).rejects
      .toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)

    let nested
    let reentered = false
    let proxy
    proxy = new Proxy(base, {
      getOwnPropertyDescriptor(target, property) {
        if (!reentered) {
          reentered = true
          nested = pollD1Export(proxy)
        }
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    await expect(pollD1Export(proxy)).rejects.toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
    await expect(nested).rejects.toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
    expect(base.fetch).not.toHaveBeenCalled()
  })

  it('uses one descriptor snapshot and never reads hostile properties through get', async () => {
    const base = exportInput().input
    const proxy = new Proxy(base, {
      get() { throw new Error('PROPERTY_GET_ACCESSED') },
    })
    await expect(pollD1Export(proxy)).resolves.toEqual({
      downloadUrl: EXPORT_URL,
      atBookmark: EXPORT_BOOKMARK,
    })
    expect(base.fetch).toHaveBeenCalledOnce()
  })
})

describe('D1 export REST request and response contract', () => {
  it('uses the exact authenticated start and immutable-bookmark poll requests', async () => {
    const fetch = sequenceFetch([
      exportResponse(nonterminalResult()),
      exportResponse(completeResult()),
    ])
    const { input } = exportInput({ fetch })

    await expect(pollD1Export(input)).resolves.toEqual({
      downloadUrl: EXPORT_URL,
      atBookmark: EXPORT_BOOKMARK,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe(EXPORT_ENDPOINT)
      expect(options.method).toBe('POST')
      expect(options.redirect).toBe('error')
      expect(options.headers).toEqual({
        Authorization: `Bearer ${EXPORT_TOKEN}`,
        'Content-Type': 'application/json',
      })
      expect(Object.keys(options).sort()).toEqual([
        'body', 'headers', 'method', 'redirect', 'signal',
      ])
      expect(options.signal).toBeInstanceOf(AbortSignal)
    }
    expect(fetch.mock.calls[0][1].body).toBe('{"output_format":"polling"}')
    expect(fetch.mock.calls[1][1].body).toBe(
      `{"current_bookmark":"${EXPORT_BOOKMARK}","output_format":"polling"}`
    )
    expect(input.wait).toHaveBeenCalledExactlyOnceWith(10_000)
  })

  it('invokes start, poll, wait, and download dependencies with an undefined receiver', async () => {
    let clock = 0
    const receivers = []
    const exposedRuntime = []
    const inspectReceiver = (label, receiver) => {
      receivers.push([label, receiver])
      if (receiver !== undefined) {
        exposedRuntime.push({
          label,
          reason: receiver.caller?.signal?.reason,
          token: receiver.token,
        })
      }
    }
    const responses = [
      exportResponse(nonterminalResult()),
      exportResponse(completeResult()),
    ]
    let request = 0
    const fetch = vi.fn(function () {
      inspectReceiver(request === 0 ? 'start' : 'poll', this)
      const response = responses[request]
      request += 1
      return Promise.resolve(response)
    })
    const wait = vi.fn(function (delay) {
      inspectReceiver('wait', this)
      clock += delay
      return Promise.resolve()
    })
    const result = await pollD1Export(exportInput({
      fetch,
      wait,
      now: vi.fn(() => clock),
    }).input)
    const stream = new ReadableStream({ start(controller) { controller.close() } })
    const downloadFetch = vi.fn(function () {
      inspectReceiver('download', this)
      return Promise.resolve(responseLike({ body: stream }))
    })
    await downloadD1Export(downloadInput({
      downloadUrl: result.downloadUrl,
      fetch: downloadFetch,
    }))

    expect(receivers).toEqual([
      ['start', undefined],
      ['wait', undefined],
      ['poll', undefined],
      ['download', undefined],
    ])
    expect(exposedRuntime).toEqual([])
  })

  it('accepts immediate completion and JSON media type parameters without waiting', async () => {
    const fetch = vi.fn(async () => exportResponse(completeResult(), {
      contentType: 'Application/JSON; charset="utf-8"',
      contentLength: '256',
    }))
    const { input } = exportInput({ fetch })
    const result = await pollD1Export(input)
    expect(result).toEqual({ downloadUrl: EXPORT_URL, atBookmark: EXPORT_BOOKMARK })
    expect(fetch).toHaveBeenCalledOnce()
    expect(input.wait).not.toHaveBeenCalled()
  })

  it.each([
    ['false success', exportResponse(null, { success: false }), 'BACKUP_EXPORT_START_FAILED'],
    ['HTTP failure', rawExportResponse('{}', { status: 503 }), 'BACKUP_EXPORT_START_FAILED'],
    ['redirected response', responseLike({ redirected: true }), 'BACKUP_EXPORT_START_FAILED'],
    ['missing response', null, 'BACKUP_EXPORT_START_FAILED'],
    ['missing content type', rawExportResponse('{}', { contentType: null }), 'BACKUP_EXPORT_RESPONSE_INVALID'],
    ['wrong content type', rawExportResponse('{}', { contentType: 'text/json' }), 'BACKUP_EXPORT_RESPONSE_INVALID'],
    ['multiple media types', rawExportResponse('{}', { contentType: 'application/json, text/plain' }), 'BACKUP_EXPORT_RESPONSE_INVALID'],
    ['noncanonical length', rawExportResponse('{}', { contentLength: '02' }), 'BACKUP_EXPORT_RESPONSE_INVALID'],
    ['oversize declared length', rawExportResponse('{}', { contentLength: '65537' }), 'BACKUP_EXPORT_RESPONSE_INVALID'],
    ['missing body', responseLike({ body: null }), 'BACKUP_EXPORT_RESPONSE_INVALID'],
    ['invalid UTF-8', rawExportResponse(new Uint8Array([0xff])), 'BACKUP_EXPORT_RESPONSE_INVALID'],
    ['invalid JSON', rawExportResponse('{'), 'BACKUP_EXPORT_RESPONSE_INVALID'],
  ])('maps %s to the fixed closed code', async (_name, response, code) => {
    const fetch = vi.fn(async () => response)
    const error = await exportError(exportInput({ fetch }).input)
    expect(error).toEqual(new Error(code))
  })

  it('maps a rejecting fetch to start failed without exposing native detail', async () => {
    const marker = 'native-fetch-provider-detail'
    const error = await exportError(exportInput({
      fetch: vi.fn(async () => { throw new Error(marker) }),
    }).input)
    expect(error).toEqual(new Error('BACKUP_EXPORT_START_FAILED'))
    expect(error.message).not.toContain(marker)
  })

  it.each([
    ['missing top field', { errors: [], messages: [], success: true }],
    ['extra top field', { errors: [], extra: true, messages: [], result: completeResult(), success: true }],
    ['errors not array', { errors: {}, messages: [], result: completeResult(), success: true }],
    ['messages not array', { errors: [], messages: {}, result: completeResult(), success: true }],
    ['result not object', { errors: [], messages: [], result: [], success: true }],
    ['nonboolean success', { errors: [], messages: [], result: completeResult(), success: 'true' }],
  ])('rejects an envelope with %s', async (_name, value) => {
    const error = await exportError(exportInput({
      fetch: vi.fn(async () => rawExportResponse(JSON.stringify(value))),
    }).input)
    expect(error).toEqual(new Error('BACKUP_EXPORT_RESPONSE_INVALID'))
  })

  it.each([
    ['missing bookmark', {}],
    ['empty bookmark', { at_bookmark: '' }],
    ['non-ASCII bookmark', { at_bookmark: 'bookmark-ą' }],
    ['oversize bookmark', { at_bookmark: 'b'.repeat(1025) }],
    ['undocumented status', { at_bookmark: EXPORT_BOOKMARK, status: 'running' }],
    ['partial terminal filename', { at_bookmark: EXPORT_BOOKMARK, filename: EXPORT_FILENAME }],
    ['partial terminal URL', { at_bookmark: EXPORT_BOOKMARK, signed_url: EXPORT_URL }],
    ['extra terminal field', { ...completeResult(), status: 'complete' }],
    ['empty filename', completeResult({ filename: '' })],
    ['slash filename', completeResult({ filename: '../dump.sql' })],
    ['backslash filename', completeResult({ filename: 'folder\\dump.sql' })],
    ['control filename', completeResult({ filename: 'dump\n.sql' })],
    ['oversize filename bytes', completeResult({ filename: 'ą'.repeat(513) })],
    ['HTTP URL', completeResult({ signed_url: 'http://download.example.test/dump.sql' })],
    ['URL credentials', completeResult({ signed_url: 'https://user@download.example.test/dump.sql' })],
    ['URL fragment', completeResult({ signed_url: 'https://download.example.test/dump.sql#fragment' })],
    ['URL whitespace', completeResult({ signed_url: ` ${EXPORT_URL}` })],
    ['noncanonical URL', completeResult({ signed_url: 'https://download.example.test' })],
    ['oversize URL bytes', completeResult({
      signed_url: `https://download.example.test/${'x'.repeat(8163)}`,
    })],
  ])('rejects result drift: %s', async (_name, result) => {
    const error = await exportError(exportInput({
      fetch: vi.fn(async () => exportResponse(result)),
    }).input)
    expect(error).toEqual(new Error('BACKUP_EXPORT_RESPONSE_INVALID'))
  })

  it('requires every poll to preserve the first bookmark', async () => {
    const fetch = sequenceFetch([
      exportResponse(nonterminalResult()),
      exportResponse(nonterminalResult('bookmark-fixture-changed')),
    ])
    await expect(pollD1Export(exportInput({ fetch }).input)).rejects
      .toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('accepts exact bookmark, filename, and signed URL byte boundaries', async () => {
    const bookmark = 'b'.repeat(1024)
    const filename = 'ą'.repeat(512)
    const urlPrefix = 'https://download.example.test/'
    const signedUrl = `${urlPrefix}${'x'.repeat(8192 - encoder.encode(urlPrefix).byteLength)}`
    expect(encoder.encode(filename)).toHaveLength(1024)
    expect(encoder.encode(signedUrl)).toHaveLength(8192)
    const fetch = sequenceFetch([
      exportResponse(nonterminalResult(bookmark)),
      exportResponse(completeResult({ at_bookmark: bookmark, filename, signed_url: signedUrl })),
    ])
    await expect(pollD1Export(exportInput({ fetch }).input)).resolves.toEqual({
      downloadUrl: signedUrl,
      atBookmark: bookmark,
    })
  })

  it.each([
    ['space', ' ', '{"current_bookmark":" ","output_format":"polling"}'],
    ['NUL', '\u0000', '{"current_bookmark":"\\u0000","output_format":"polling"}'],
    ['control', '\u0001', '{"current_bookmark":"\\u0001","output_format":"polling"}'],
    ['DEL', '\u007f', '{"current_bookmark":"\u007f","output_format":"polling"}'],
  ])('accepts the full ASCII bookmark range including %s with canonical poll JSON', async (_name, bookmark, expectedBody) => {
    const fetch = sequenceFetch([
      exportResponse(nonterminalResult(bookmark)),
      exportResponse(completeResult({ at_bookmark: bookmark })),
    ])
    const result = await pollD1Export(exportInput({ fetch }).input)
    expect(result).toEqual({ downloadUrl: EXPORT_URL, atBookmark: bookmark })
    expect(fetch.mock.calls[1][1].body).toBe(expectedBody)
  })

  it.each([
    '{"errors":[],"messages":[],"result":{"at_bookmark":"bookmark-fixture-1"},"success":true,"success":true}',
    '{"errors":[],"messages":[],"result":{"at_bookmark":"bookmark-fixture-1"},"result":{"at_bookmark":"bookmark-fixture-1"},"success":true}',
    '{"errors":[],"messages":[],"result":{"at_bookmark":"bookmark-fixture-1","at_bookmark":"bookmark-fixture-1"},"success":true}',
    `{"errors":[],"messages":[],"result":{"at_bookmark":"${EXPORT_BOOKMARK}","filename":"${EXPORT_FILENAME}","filename":"${EXPORT_FILENAME}","signed_url":"${EXPORT_URL}"},"success":true}`,
    `{"errors":[],"messages":[],"result":{"at_bookmark":"${EXPORT_BOOKMARK}","filename":"${EXPORT_FILENAME}","signed_url":"${EXPORT_URL}","signed_url":"${EXPORT_URL}"},"success":true}`,
    '{"errors":[],"messages":[],"result":{"at_bookmark":"bookmark-fixture-1"},"\\u0073uccess":true,"success":true}',
  ])('rejects duplicate JSON keys before parsing: %s', async (raw) => {
    const error = await exportError(exportInput({
      fetch: vi.fn(async () => rawExportResponse(raw)),
    }).input)
    expect(error).toEqual(new Error('BACKUP_EXPORT_RESPONSE_INVALID'))
  })

  it('accepts exactly 64 KiB and rejects one more byte with bounded stream cleanup', async () => {
    const base = JSON.stringify({
      errors: [''], messages: [], result: completeResult(), success: true,
    })
    const exactRaw = JSON.stringify({
      errors: ['x'.repeat(65_536 - encoder.encode(base).byteLength)],
      messages: [],
      result: completeResult(),
      success: true,
    })
    expect(encoder.encode(exactRaw)).toHaveLength(65_536)
    await expect(pollD1Export(exportInput({
      fetch: vi.fn(async () => rawExportResponse(exactRaw)),
    }).input)).resolves.toEqual({ downloadUrl: EXPORT_URL, atBookmark: EXPORT_BOOKMARK })

    let cancelled = false
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(exactRaw))
        controller.enqueue(new Uint8Array([0x20]))
      },
      cancel() { cancelled = true },
    })
    const error = await exportError(exportInput({
      fetch: vi.fn(async () => responseLike({ body: stream })),
    }).input)
    expect(error).toEqual(new Error('BACKUP_EXPORT_RESPONSE_INVALID'))
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  it('rejects malformed reader chunks and a locked response body', async () => {
    const malformedBody = {
      locked: false,
      getReader() {
        return {
          read: vi.fn(async () => ({ done: false, value: 'not-bytes' })),
          cancel: vi.fn(async () => {}),
          releaseLock: vi.fn(),
        }
      },
    }
    for (const body of [malformedBody, { ...malformedBody, locked: true }]) {
      const error = await exportError(exportInput({
        fetch: vi.fn(async () => responseLike({ body })),
      }).input)
      expect(error).toEqual(new Error('BACKUP_EXPORT_RESPONSE_INVALID'))
    }
  })

  it('rejects a zero-length nonterminal chunk and stops the reader immediately', async () => {
    const valid = encoder.encode(JSON.stringify({
      errors: [], messages: [], result: completeResult(), success: true,
    }))
    let reads = 0
    const reader = {
      read: vi.fn(async () => {
        reads += 1
        return reads === 1
          ? { done: false, value: new Uint8Array(0) }
          : { done: false, value: valid }
      }),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    }
    const body = { locked: false, getReader: vi.fn(() => reader) }
    const fetch = vi.fn(async () => responseLike({ body }))
    const input = exportInput({ fetch }).input
    await expect(pollD1Export(input)).rejects
      .toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
    expect(reader.read).toHaveBeenCalledOnce()
    expect(reader.cancel).toHaveBeenCalledOnce()
    expect(reader.releaseLock).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(input.wait).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(reader.read).toHaveBeenCalledOnce()
  })

  it('keeps the derived request signal deadline-bounded through a hanging body read', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let rejectRead
    const pendingRead = new Promise((_, reject) => { rejectRead = reject })
    const reader = {
      read: vi.fn(() => pendingRead),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    }
    const body = { locked: false, getReader: vi.fn(() => reader) }
    let requestSignal
    try {
      const promise = pollD1Export(exportInput({
        fetch: vi.fn(async (_url, options) => {
          requestSignal = options.signal
          return responseLike({ body })
        }),
        now: vi.fn(() => Date.now()),
      }).input)
      const rejection = expect(promise).rejects.toThrow(/^BACKUP_EXPORT_TIMEOUT$/)
      await vi.advanceTimersByTimeAsync(300_000)
      await rejection
      expect(requestSignal.aborted).toBe(true)
      expect(reader.cancel).toHaveBeenCalledOnce()
      expect(reader.releaseLock).toHaveBeenCalledOnce()
      rejectRead(new Error('LATE_BODY_PRIVATE_DETAIL'))
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps caller abort during a body read to start failed and aborts the request signal', async () => {
    const controller = new AbortController()
    let markReadStarted
    const readStarted = new Promise((resolve) => { markReadStarted = resolve })
    const reader = {
      read: vi.fn(() => {
        markReadStarted()
        return new Promise(() => {})
      }),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    }
    const body = { locked: false, getReader: vi.fn(() => reader) }
    let requestSignal
    const promise = pollD1Export(exportInput({
      fetch: vi.fn(async (_url, options) => {
        requestSignal = options.signal
        return responseLike({ body })
      }),
      signal: controller.signal,
    }).input)
    await readStarted
    controller.abort('private-body-abort-reason')
    await expect(promise).rejects.toThrow(/^BACKUP_EXPORT_START_FAILED$/)
    expect(requestSignal.aborted).toBe(true)
    expect(reader.cancel).toHaveBeenCalledOnce()
    expect(reader.releaseLock).toHaveBeenCalledOnce()
  })

  it('requires exact reader result descriptors', async () => {
    const raw = encoder.encode(JSON.stringify({
      errors: [], messages: [], result: completeResult(), success: true,
    }))
    let reads = 0
    const body = {
      locked: false,
      getReader() {
        return {
          read: vi.fn(async () => {
            reads += 1
            return reads === 1
              ? { done: false, extra: true, value: raw }
              : { done: true, value: undefined }
          }),
          cancel: vi.fn(async () => {}),
          releaseLock: vi.fn(),
        }
      },
    }
    await expect(pollD1Export(exportInput({
      fetch: vi.fn(async () => responseLike({ body })),
    }).input)).rejects.toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
  })

  it('never uses unbounded response or stream helpers', async () => {
    const response = exportResponse(completeResult())
    const forbidden = [
      vi.spyOn(response, 'arrayBuffer'),
      vi.spyOn(response, 'blob'),
      vi.spyOn(response, 'clone'),
      vi.spyOn(response, 'json'),
      vi.spyOn(response, 'text'),
      vi.spyOn(response.body, 'tee'),
    ]
    await expect(pollD1Export(exportInput({
      fetch: vi.fn(async () => response),
    }).input)).resolves.toEqual({ downloadUrl: EXPORT_URL, atBookmark: EXPORT_BOOKMARK })
    forbidden.forEach((spy) => expect(spy).not.toHaveBeenCalled())
  })
})

describe('D1 export monotonic deadline and request accounting', () => {
  it('waits exactly ten monotonic seconds only after accepted nonterminal responses', async () => {
    let clock = 50
    const wait = vi.fn(async (delay) => { clock += delay })
    const now = vi.fn(() => clock)
    const fetch = sequenceFetch([
      exportResponse(nonterminalResult()),
      exportResponse(completeResult()),
    ])
    await pollD1Export(exportInput({ fetch, wait, now }).input)
    expect(wait).toHaveBeenCalledExactlyOnceWith(10_000)
    expect(clock).toBe(10_050)
  })

  it('rejects an early-resolving wait and backward or invalid monotonic clock', async () => {
    const early = exportInput({
      fetch: vi.fn(async () => exportResponse(nonterminalResult())),
      wait: vi.fn(async () => {}),
      now: vi.fn(() => 10),
    }).input
    await expect(pollD1Export(early)).rejects.toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)

    const readings = [10_000, 10_000, 19_999]
    const backward = exportInput({
      fetch: vi.fn(async () => exportResponse(nonterminalResult())),
      wait: vi.fn(async () => {}),
      now: vi.fn(() => readings.shift() ?? 9_000),
    }).input
    await expect(pollD1Export(backward)).rejects
      .toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)

    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      const input = exportInput({ now: vi.fn(() => value) }).input
      await expect(pollD1Export(input)).rejects.toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
      expect(input.fetch).not.toHaveBeenCalled()
    }
    await expect(pollD1Export(exportInput({
      now: vi.fn(() => { throw new Error('CLOCK_DETAIL') }),
    }).input)).rejects.toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
  })

  it('times out before a wait when fewer than ten seconds remain', async () => {
    let clock = 0
    const fetch = vi.fn(async () => {
      clock = 291_000
      return exportResponse(nonterminalResult())
    })
    const wait = vi.fn(async () => { clock += 10_000 })
    const error = await exportError(exportInput({
      fetch, wait, now: vi.fn(() => clock),
    }).input)
    expect(error).toEqual(new Error('BACKUP_EXPORT_TIMEOUT'))
    expect(fetch).toHaveBeenCalledOnce()
    expect(wait).not.toHaveBeenCalled()
  })

  it.each([
    ['synchronous throw', () => { throw new Error('WAIT_SYNC_DETAIL') }],
    ['asynchronous rejection', async () => { throw new Error('WAIT_ASYNC_DETAIL') }],
  ])('maps a %s from wait to start failed', async (_name, wait) => {
    const error = await exportError(exportInput({
      fetch: vi.fn(async () => exportResponse(nonterminalResult())),
      wait,
    }).input)
    expect(error).toEqual(new Error('BACKUP_EXPORT_START_FAILED'))
  })

  it('bounds a hanging wait by the five-minute deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const wait = vi.fn(() => new Promise(() => {}))
      const promise = pollD1Export(exportInput({
        fetch: vi.fn(async () => exportResponse(nonterminalResult())),
        wait,
        now: vi.fn(() => Date.now()),
      }).input)
      const rejection = expect(promise).rejects.toThrow(/^BACKUP_EXPORT_TIMEOUT$/)
      await vi.advanceTimersByTimeAsync(300_000)
      await rejection
      expect(wait).toHaveBeenCalledExactlyOnceWith(10_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors caller abort during wait and gives an observed deadline precedence', async () => {
    const controller = new AbortController()
    const wait = vi.fn(() => new Promise(() => {}))
    const first = pollD1Export(exportInput({
      fetch: vi.fn(async () => exportResponse(nonterminalResult())),
      wait,
      signal: controller.signal,
    }).input)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort('private-caller-reason')
    await expect(first).rejects.toThrow(/^BACKUP_EXPORT_START_FAILED$/)

    let clock = 0
    const simultaneous = new AbortController()
    const second = pollD1Export(exportInput({
      fetch: vi.fn(async () => exportResponse(nonterminalResult())),
      wait: vi.fn(() => new Promise(() => {})),
      now: vi.fn(() => clock),
      signal: simultaneous.signal,
    }).input)
    await Promise.resolve()
    await Promise.resolve()
    clock = 300_000
    simultaneous.abort('private-simultaneous-reason')
    await expect(second).rejects.toThrow(/^BACKUP_EXPORT_TIMEOUT$/)
  })

  it('never starts export fetch after the caller signal is already aborted', async () => {
    const controller = new AbortController()
    let abortedAtInvocation
    const fetch = vi.fn(() => {
      abortedAtInvocation = controller.signal.aborted
      return new Promise(() => {})
    })
    const promise = pollD1Export(exportInput({ fetch, signal: controller.signal }).input)
    controller.abort('private-immediate-export-abort')
    await expect(promise).rejects.toThrow(/^BACKUP_EXPORT_START_FAILED$/)
    expect(fetch).toHaveBeenCalledOnce()
    expect(abortedAtInvocation).toBe(false)
  })

  it.each(['fulfill', 'reject'])('terminally observes a losing fetch that later %ss', async (settlement) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      let resolveFetch
      let rejectFetch
      const dependency = new Promise((resolve, reject) => {
        resolveFetch = resolve
        rejectFetch = reject
      })
      const wait = vi.fn()
      const promise = pollD1Export(exportInput({
        fetch: vi.fn(() => dependency),
        wait,
        now: vi.fn(() => Date.now()),
      }).input)
      const rejection = expect(promise).rejects.toThrow(/^BACKUP_EXPORT_TIMEOUT$/)
      await vi.advanceTimersByTimeAsync(300_000)
      await rejection
      if (settlement === 'fulfill') resolveFetch(exportResponse(nonterminalResult()))
      else rejectFetch(new Error('LATE_FETCH_PRIVATE_DETAIL'))
      await Promise.resolve()
      await Promise.resolve()
      expect(wait).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['fulfill', 'reject'])('terminally observes a losing wait that later %ss', async (settlement) => {
    const controller = new AbortController()
    let settle
    const dependency = new Promise((resolve, reject) => {
      settle = settlement === 'fulfill' ? resolve : reject
    })
    const fetch = vi.fn(async () => exportResponse(nonterminalResult()))
    let markWaitStarted
    const waitStarted = new Promise((resolve) => { markWaitStarted = resolve })
    const wait = vi.fn(() => {
      markWaitStarted()
      return dependency
    })
    const promise = pollD1Export(exportInput({
      fetch,
      wait,
      signal: controller.signal,
    }).input)
    await waitStarted
    expect(wait).toHaveBeenCalledOnce()
    controller.abort()
    await expect(promise).rejects.toThrow(/^BACKUP_EXPORT_START_FAILED$/)
    settle(settlement === 'fulfill' ? 'late-private-value' : new Error('LATE_WAIT_PRIVATE_DETAIL'))
    await Promise.resolve()
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('can complete on poll 29 at the reachable maximum of 30 export requests', async () => {
    const responses = [exportResponse(nonterminalResult())]
    for (let poll = 1; poll <= 28; poll += 1) responses.push(exportResponse(nonterminalResult()))
    responses.push(exportResponse(completeResult()))
    const fetch = sequenceFetch(responses)
    const { input } = exportInput({ fetch })
    const result = await pollD1Export(input)
    expect(result).toEqual({ downloadUrl: EXPORT_URL, atBookmark: EXPORT_BOOKMARK })
    expect(fetch).toHaveBeenCalledTimes(30)
    expect(input.wait).toHaveBeenCalledTimes(29)
    expect(fetch.mock.calls.length).toBeLessThan(31)

    const downloadFetch = vi.fn(async () => responseLike({
      body: new ReadableStream({ start(controller) { controller.close() } }),
    }))
    await downloadD1Export(downloadInput({ downloadUrl: result.downloadUrl, fetch: downloadFetch }))
    expect(fetch.mock.calls.length + downloadFetch.mock.calls.length).toBe(31)
    expect(fetch.mock.calls.length + downloadFetch.mock.calls.length).toBeLessThanOrEqual(32)
  })

  it('times out after 30 fixed waits and 30 requests before unreachable poll 30', async () => {
    const fetch = vi.fn(async () => exportResponse(nonterminalResult()))
    const { input } = exportInput({ fetch })
    await expect(pollD1Export(input)).rejects.toThrow(/^BACKUP_EXPORT_TIMEOUT$/)
    expect(fetch).toHaveBeenCalledTimes(30)
    expect(input.wait).toHaveBeenCalledTimes(30)
    expect(fetch.mock.calls.length).toBeLessThan(31)
    expect(fetch.mock.calls.length + 1).toBe(31)
    expect(fetch.mock.calls.length + 1).toBeLessThanOrEqual(32)
  })

  it('uses only the injected monotonic clock and never wall-clock Date', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('WALL_CLOCK_ACCESSED')
    })
    try {
      await expect(pollD1Export(exportInput().input)).resolves.toEqual({
        downloadUrl: EXPORT_URL,
        atBookmark: EXPORT_BOOKMARK,
      })
      expect(dateNow).not.toHaveBeenCalled()
    } finally {
      dateNow.mockRestore()
    }
  })
})

describe('signed D1 export download', () => {
  it('performs one unauthenticated GET and returns the exact unused stream', async () => {
    const stream = new ReadableStream({ start(controller) { controller.close() } })
    const getReader = vi.spyOn(stream, 'getReader')
    const tee = vi.spyOn(stream, 'tee')
    const cancel = vi.spyOn(stream, 'cancel')
    const fetch = vi.fn(async () => responseLike({ body: stream }))
    const signal = new AbortController().signal
    const result = await downloadD1Export(downloadInput({ fetch, signal }))

    expect(result).toEqual({ body: stream })
    expect(result.body).toBe(stream)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(EXPORT_URL, {
      method: 'GET',
      redirect: 'error',
      signal,
    })
    expect(Reflect.ownKeys(fetch.mock.calls[0][1]).sort()).toEqual([
      'method', 'redirect', 'signal',
    ])
    expect(getReader).not.toHaveBeenCalled()
    expect(tee).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(stream.locked).toBe(false)
  })

  it('requires exact download input descriptors before fetch', async () => {
    const base = downloadInput()
    const invalid = []
    for (const key of Reflect.ownKeys(base)) {
      const missing = { ...base }
      delete missing[key]
      invalid.push(missing)
    }
    invalid.push({ ...base, extra: true }, { ...base, [Symbol('fetch')]: base.fetch })
    const accessor = { ...base }
    let reads = 0
    Object.defineProperty(accessor, 'downloadUrl', {
      enumerable: true,
      get() { reads += 1; return EXPORT_URL },
    })
    invalid.push(accessor)
    for (const input of invalid) {
      await expect(downloadD1Export(input)).rejects
        .toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
    }
    expect(reads).toBe(0)
    expect(base.fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['non-string', { toString: () => EXPORT_URL }],
    ['HTTP', 'http://download.example.test/dump.sql'],
    ['credentials', 'https://user@download.example.test/dump.sql'],
    ['fragment', 'https://download.example.test/dump.sql#fragment'],
    ['whitespace', ` ${EXPORT_URL}`],
    ['noncanonical', 'https://download.example.test'],
  ])('rejects a %s URL before fetch', async (_name, downloadUrl) => {
    const input = downloadInput({ downloadUrl })
    await expect(downloadD1Export(input)).rejects
      .toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
    expect(input.fetch).not.toHaveBeenCalled()
  })

  it('maps an explicit redirected response separately', async () => {
    const error = await (async () => {
      try {
        await downloadD1Export(downloadInput({
          fetch: vi.fn(async () => responseLike({ redirected: true })),
        }))
      } catch (caught) { return caught }
    })()
    expect(error).toEqual(new Error('BACKUP_EXPORT_REDIRECTED'))
  })

  it.each([
    ['rejecting fetch', () => Promise.reject(new Error('DOWNLOAD_PRIVATE_DETAIL'))],
    ['non-2xx', async () => responseLike({ ok: false, status: 503 })],
    ['missing body', async () => responseLike({ body: null })],
    ['consumed body', async () => responseLike({ bodyUsed: true })],
    ['nonstream body', async () => responseLike({ body: {} })],
  ])('maps %s to fixed download failure', async (_name, fetchImpl) => {
    const error = await (async () => {
      try {
        await downloadD1Export(downloadInput({ fetch: vi.fn(fetchImpl) }))
      } catch (caught) { return caught }
    })()
    expect(error).toEqual(new Error('BACKUP_EXPORT_DOWNLOAD_FAILED'))
  })

  it('rejects a locked body without consuming or unlocking it', async () => {
    const stream = new ReadableStream({ start(controller) { controller.close() } })
    const reader = stream.getReader()
    try {
      await expect(downloadD1Export(downloadInput({
        fetch: vi.fn(async () => responseLike({ body: stream })),
      }))).rejects.toThrow(/^BACKUP_EXPORT_DOWNLOAD_FAILED$/)
      expect(stream.locked).toBe(true)
    } finally {
      reader.releaseLock()
    }
  })

  it('honors caller abort even when fetch ignores its signal and consumes a late rejection', async () => {
    const controller = new AbortController()
    let rejectFetch
    const dependency = new Promise((_, reject) => { rejectFetch = reject })
    const promise = downloadD1Export(downloadInput({
      fetch: vi.fn(() => dependency),
      signal: controller.signal,
    }))
    await Promise.resolve()
    controller.abort('private-download-abort')
    await expect(promise).rejects.toThrow(/^BACKUP_EXPORT_DOWNLOAD_FAILED$/)
    rejectFetch(new Error('LATE_DOWNLOAD_PRIVATE_DETAIL'))
    await Promise.resolve()
    await Promise.resolve()
  })

  it('never starts download fetch after the caller signal is already aborted', async () => {
    const controller = new AbortController()
    let abortedAtInvocation
    const fetch = vi.fn(() => {
      abortedAtInvocation = controller.signal.aborted
      return new Promise(() => {})
    })
    const promise = downloadD1Export(downloadInput({ fetch, signal: controller.signal }))
    controller.abort('private-immediate-download-abort')
    await expect(promise).rejects.toThrow(/^BACKUP_EXPORT_DOWNLOAD_FAILED$/)
    expect(fetch).toHaveBeenCalledOnce()
    expect(abortedAtInvocation).toBe(false)
  })
})

describe('same-checkpoint dependency races', () => {
  it('closes the wait fulfillment gate synchronously when caller abort wins', async () => {
    const controller = new AbortController()
    const deferred = inspectableDeferred()
    let markWaitStarted
    const waitStarted = new Promise((resolve) => { markWaitStarted = resolve })
    const wait = vi.fn(() => {
      markWaitStarted()
      return deferred.promise
    })
    const fetch = vi.fn(async () => exportResponse(nonterminalResult()))
    const promise = pollD1Export(exportInput({
      fetch,
      wait,
      signal: controller.signal,
    }).input)
    await waitStarted

    controller.abort('private-same-checkpoint-wait')
    deferred.resolve({ marker: 'losing-wait-value' })

    await expect(promise).rejects.toThrow(/^BACKUP_EXPORT_START_FAILED$/)
    await Promise.resolve()
    expect(deferred.outcomes).toEqual([{ kind: 'lost' }])
    expect(deferred.outcomes[0]).not.toHaveProperty('value')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('closes the export-fetch fulfillment gate synchronously when caller abort wins', async () => {
    const controller = new AbortController()
    const deferred = inspectableDeferred()
    let responseReads = 0
    const losingResponse = {}
    for (const key of ['body', 'headers', 'ok', 'redirected', 'status']) {
      Object.defineProperty(losingResponse, key, {
        get() { responseReads += 1; return undefined },
      })
    }
    const fetch = vi.fn(() => deferred.promise)
    const input = exportInput({ fetch, signal: controller.signal }).input
    const promise = pollD1Export(input)
    expect(fetch).toHaveBeenCalledOnce()

    controller.abort('private-same-checkpoint-export-fetch')
    deferred.resolve(losingResponse)

    await expect(promise).rejects.toThrow(/^BACKUP_EXPORT_START_FAILED$/)
    await Promise.resolve()
    expect(deferred.outcomes).toEqual([{ kind: 'lost' }])
    expect(deferred.outcomes[0]).not.toHaveProperty('value')
    expect(responseReads).toBe(0)
    expect(input.wait).not.toHaveBeenCalled()
  })

  it('closes the body-read fulfillment gate synchronously when caller abort wins', async () => {
    const controller = new AbortController()
    const deferred = inspectableDeferred()
    let markReadStarted
    const readStarted = new Promise((resolve) => { markReadStarted = resolve })
    const reader = {
      read: vi.fn(() => {
        markReadStarted()
        return deferred.promise
      }),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    }
    const body = { locked: false, getReader: vi.fn(() => reader) }
    const fetch = vi.fn(async () => responseLike({ body }))
    const input = exportInput({ fetch, signal: controller.signal }).input
    const promise = pollD1Export(input)
    await readStarted

    controller.abort('private-same-checkpoint-body-read')
    deferred.resolve({
      done: false,
      value: encoder.encode('{"marker":"losing-body-value"}'),
    })

    await expect(promise).rejects.toThrow(/^BACKUP_EXPORT_START_FAILED$/)
    await Promise.resolve()
    expect(deferred.outcomes).toEqual([{ kind: 'lost' }])
    expect(deferred.outcomes[0]).not.toHaveProperty('value')
    expect(reader.read).toHaveBeenCalledOnce()
    expect(reader.cancel).toHaveBeenCalledOnce()
    expect(reader.releaseLock).toHaveBeenCalledOnce()
    expect(input.wait).not.toHaveBeenCalled()
  })

  it('closes the download-fetch fulfillment gate synchronously when caller abort wins', async () => {
    const controller = new AbortController()
    const deferred = inspectableDeferred()
    let responseReads = 0
    const losingResponse = {}
    for (const key of ['body', 'bodyUsed', 'ok', 'redirected', 'status']) {
      Object.defineProperty(losingResponse, key, {
        get() { responseReads += 1; return undefined },
      })
    }
    const fetch = vi.fn(() => deferred.promise)
    const promise = downloadD1Export(downloadInput({
      fetch,
      signal: controller.signal,
    }))
    expect(fetch).toHaveBeenCalledOnce()

    controller.abort('private-same-checkpoint-download-fetch')
    deferred.resolve(losingResponse)

    await expect(promise).rejects.toThrow(/^BACKUP_EXPORT_DOWNLOAD_FAILED$/)
    await Promise.resolve()
    expect(deferred.outcomes).toEqual([{ kind: 'lost' }])
    expect(deferred.outcomes[0]).not.toHaveProperty('value')
    expect(responseReads).toBe(0)
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('D1 export isolation and privacy', () => {
  it('rejects every D1, R2, scheduler, audit, health, or logging capability as an extra input', async () => {
    const base = exportInput().input
    for (const key of ['audit', 'db', 'health', 'logger', 'r2', 'scheduler']) {
      const capability = vi.fn(() => { throw new Error(`CAPABILITY_${key}_ACCESSED`) })
      await expect(pollD1Export({ ...base, [key]: capability })).rejects
        .toThrow(/^BACKUP_EXPORT_RESPONSE_INVALID$/)
      expect(capability).not.toHaveBeenCalled()
    }
    expect(base.fetch).not.toHaveBeenCalled()
    expect(base.wait).not.toHaveBeenCalled()
  })

  it('exposes sensitive facts only in exact request arguments and the short-lived return', async () => {
    const fetch = sequenceFetch([
      exportResponse(nonterminalResult(), {
        errors: [{ detail: 'provider-error-marker' }],
        messages: [{ detail: 'provider-message-marker' }],
      }),
      exportResponse(completeResult()),
    ])
    const result = await pollD1Export(exportInput({ fetch }).input)
    expect(fetch.mock.calls[0][0]).toBe(EXPORT_ENDPOINT)
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${EXPORT_TOKEN}`)
    expect(fetch.mock.calls[1][1].body).toContain(EXPORT_BOOKMARK)
    expect(result).toEqual({ downloadUrl: EXPORT_URL, atBookmark: EXPORT_BOOKMARK })
    expect(result).not.toHaveProperty('filename')

    const stream = new ReadableStream({ start(controller) { controller.close() } })
    const downloadFetch = vi.fn(async () => responseLike({ body: stream }))
    const outer = await downloadD1Export(downloadInput({
      downloadUrl: result.downloadUrl,
      fetch: downloadFetch,
    }))
    expect(downloadFetch.mock.calls[0][0]).toBe(result.downloadUrl)
    expect(outer).toEqual({ body: stream })
    expect(Reflect.ownKeys(outer)).toEqual(['body'])
  })

  it('never leaks provider, transport, abort, or credential markers through fixed errors or logs', async () => {
    const markers = [
      EXPORT_TOKEN,
      EXPORT_ENDPOINT,
      EXPORT_BOOKMARK,
      EXPORT_FILENAME,
      EXPORT_URL,
      'provider-error-marker',
      'provider-message-marker',
      'transport-private-marker',
      'caller-abort-private-marker',
    ]
    const logSpies = ['debug', 'error', 'info', 'log', 'warn']
      .map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const controller = new AbortController()
    controller.abort('caller-abort-private-marker')
    const errors = []
    try {
      errors.push(await exportError(exportInput({
        fetch: vi.fn(async () => { throw new Error('transport-private-marker') }),
      }).input))
      errors.push(await exportError(exportInput({
        fetch: vi.fn(async () => exportResponse(null, {
          errors: [{ detail: 'provider-error-marker' }],
          messages: [{ detail: 'provider-message-marker' }],
          success: false,
        })),
      }).input))
      errors.push(await exportError(exportInput({ signal: controller.signal }).input))
      try {
        await downloadD1Export(downloadInput({
          fetch: vi.fn(async () => { throw new Error('transport-private-marker') }),
        }))
      } catch (error) { errors.push(error) }
      const unauthorized = JSON.stringify({
        errors: errors.map((error) => error.message),
        logs: logSpies.flatMap((spy) => spy.mock.calls),
      })
      for (const marker of markers) expect(unauthorized).not.toContain(marker)
      expect(errors.map((error) => error.message)).toEqual([
        'BACKUP_EXPORT_START_FAILED',
        'BACKUP_EXPORT_START_FAILED',
        'BACKUP_EXPORT_START_FAILED',
        'BACKUP_EXPORT_DOWNLOAD_FAILED',
      ])
    } finally {
      logSpies.forEach((spy) => spy.mockRestore())
    }
  })
})
