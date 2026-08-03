import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
import { processNextBackupCreate } from '../../worker/operations/backups.js'
import { enqueueOutboxStatement } from '../../worker/jobs/outbox.js'
import { encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'

const CLAIM_MS = Date.UTC(2044, 6, 29, 10, 0, 0)
const CLAIM_NOW = new Date(CLAIM_MS).toISOString()
const LEASE_MS = 12 * 60 * 1000
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const SCHEDULER_EXPIRY = new Date(CLAIM_MS + 4 * 60 * 60 * 1000).toISOString()
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
    expect(Object.keys(module)).toEqual(['processNextBackupCreate'])

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

  it('allows attempt seven to become private recovery-only attempt eight then rejects exhaustion', async () => {
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

    const exhaustedJob = await job(seeded.jobId)
    const exhaustedAttempts = await attempts(seeded.jobId)
    await expect(processNextBackupCreate(processInput({
      context,
      schedulerRun,
      nowMs: attemptEightNow + LEASE_MS + 1,
      idFactory: () => 'attempt_backup_recovery_9',
      leaseOwnerFactory: () => 'owner_backup_recovery_9',
    }))).rejects.toThrow(/^BACKUP_STATE_INVALID$/)
    expect(await job(seeded.jobId)).toEqual(exhaustedJob)
    expect(await attempts(seeded.jobId)).toEqual(exhaustedAttempts)
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
      expect(hostileReads).toBe(1)
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
