import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createUnitOfWork } from '../../worker/db/unit-of-work.js'
import { dispatchOutboxJob } from '../../worker/jobs/handlers.js'
import * as outbox from '../../worker/jobs/outbox.js'
import {
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'

const NOW_MS = 1_800_000_000_000
const NOW = new Date(NOW_MS).toISOString()
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
let serial = 0

const sequence = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

async function context() {
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_outbox_b1',
    createdAt: NOW,
  })
  return { keyring, dataKey, scope: SCOPE }
}

async function nonDirectoryContext() {
  const scope = Object.freeze({ type: 'backup', id: 'centre_1', purpose: 'export' })
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
    id: 'key_outbox_wrong_scope',
    createdAt: NOW,
  })
  return { keyring, dataKey, scope }
}

async function enqueue(cryptoContext, overrides = {}) {
  serial += 1
  const type = overrides.type ?? 'staff.invitation.expire'
  const invitationId = overrides.invitationId ?? `inv_outbox_${serial}`
  const defaults = type === 'staff.access.reconcile'
    ? {
        aggregateType: 'access_group',
        aggregateId: 'centre_1',
        payload: { actorId: 'stf_owner_outbox', generation: serial },
      }
    : {
        aggregateType: 'staff_invitation',
        aggregateId: invitationId,
        payload: { actorId: 'stf_owner_outbox', invitationId },
      }
  const input = {
    id: overrides.id ?? `job_outbox_${serial}`,
    type,
    aggregateType: overrides.aggregateType ?? defaults.aggregateType,
    aggregateId: overrides.aggregateId ?? defaults.aggregateId,
    payload: overrides.payload ?? defaults.payload,
    idempotencyKey: overrides.idempotencyKey ?? `${type}:${serial}`,
    scheduledAt: overrides.scheduledAt ?? NOW,
    nowMs: overrides.nowMs ?? NOW_MS,
    ...(Object.hasOwn(overrides, 'maxAttempts') ? { maxAttempts: overrides.maxAttempts } : {}),
    ...(Object.hasOwn(overrides, 'onlyIfPreviousStatementChanged')
      ? { onlyIfPreviousStatementChanged: overrides.onlyIfPreviousStatementChanged }
      : {}),
  }
  const statement = await outbox.enqueueOutboxStatement(env.DB, cryptoContext, input)
  await statement.run()
  return input
}

async function claim(options = {}) {
  return outbox.claimDueJobs(options.db ?? env.DB, {
    nowMs: options.nowMs ?? NOW_MS,
    idFactory: options.idFactory ?? sequence(`attempt_${++serial}`),
    leaseOwnerFactory: options.leaseOwnerFactory ?? sequence(`lease_${serial}`),
    limit: options.limit ?? 10,
    ...(Object.hasOwn(options, 'scanLimit') ? { scanLimit: options.scanLimit } : {}),
  })
}

const job = (id) => env.DB.prepare('SELECT * FROM outbox_jobs WHERE id=?').bind(id).first()
const attempts = async (id) => (await env.DB.prepare(
  'SELECT * FROM outbox_attempts WHERE job_id=? ORDER BY attempt_number,id'
).bind(id).all()).results
const actions = async (id) => (await env.DB.prepare(
  'SELECT * FROM operational_actions WHERE entity_type=? AND entity_id=? ORDER BY created_at,id'
).bind('outbox_job', id).all()).results
const park = (id) => env.DB.prepare(
  "UPDATE outbox_jobs SET scheduled_at='2099-01-01T00:00:00.000Z' WHERE id=? AND status='queued'"
).bind(id).run()
const settle = async (id) => {
  const row = await job(id)
  if (row?.status !== 'processing') return
  await env.DB.prepare(
    `UPDATE outbox_attempts
     SET completed_at=?,result='succeeded'
     WHERE job_id=? AND attempt_number=? AND completed_at IS NULL`
  ).bind(NOW, id, row.attempt_count).run()
  await env.DB.prepare(
    `UPDATE outbox_jobs
     SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
     WHERE id=? AND status='processing'`
  ).bind(NOW, id).run()
}

const backupInput = ({
  id,
  backupId,
  localDay = '2026-07-31',
  ...overrides
}) => ({
  id,
  type: 'backup.create',
  aggregateType: 'backup_run',
  aggregateId: backupId,
  payload: { backupId },
  idempotencyKey: `backup.create:${localDay}:${backupId}`,
  scheduledAt: NOW,
  nowMs: NOW_MS,
  ...overrides,
})

async function enqueueBackup(cryptoContext, input) {
  const statement = await outbox.enqueueOutboxStatement(
    env.DB,
    cryptoContext,
    backupInput(input),
  )
  await statement.run()
  return backupInput(input)
}

async function seedBackupBacklog(cryptoContext, prefix, count, scheduledAt) {
  const statements = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const suffix = String(index).padStart(3, '0')
    const id = `job_backup_${prefix}_${suffix}`
    const backupId = `bkp_${prefix}_${suffix}`
    const payloadEnvelope = JSON.stringify(await encryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: SCOPE,
        recordId: id,
        field: 'job_payload',
        plaintext: `{"backupId":"${backupId}"}`,
      },
    ))
    return env.DB.prepare(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,created_at,updated_at)
       VALUES (?,'backup.create','backup_run',?,?,?,'queued',0,8,?,?,?)`
    ).bind(
      id,
      backupId,
      payloadEnvelope,
      `backup.create:2026-07-31:${backupId}`,
      scheduledAt,
      NOW,
      NOW,
    )
  }))
  await env.DB.batch(statements)
  return statements.map((_, index) => `job_backup_${prefix}_${String(index).padStart(3, '0')}`)
}

const backupStates = async (prefix) => (await env.DB.prepare(
  'SELECT * FROM outbox_jobs WHERE id LIKE ? ORDER BY id'
).bind(`job_backup_${prefix}_%`).all()).results

const parkPrefix = (prefix) => env.DB.prepare(
  `UPDATE outbox_jobs SET scheduled_at='2099-01-01T00:00:00.000Z'
   WHERE id LIKE ? AND status='queued'`
).bind(`${prefix}%`).run()

describe('durable outbox enqueue', () => {
  it('uses the fixed retry schedule and dead-letters after attempt eight', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(outbox.retryDelayMs)).toEqual([
      60_000, 300_000, 900_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000,
    ])
    expect(outbox.retryDelayMs(8)).toBeNull()
  })

  it('encrypts one canonical allow-listed payload without retaining plaintext', async () => {
    const cryptoContext = await context()
    const input = await enqueue(cryptoContext, {
      id: 'job_enqueue_secret',
      invitationId: 'inv_enqueue_secret',
      payload: { invitationId: 'inv_enqueue_secret', actorId: 'stf_owner_enqueue' },
      idempotencyKey: 'staff.invitation.expire:inv_enqueue_secret',
    })
    const row = await job(input.id)
    expect(row).toMatchObject({
      id: input.id,
      type: input.type,
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 8,
    })
    expect(JSON.stringify(row)).not.toContain('stf_owner_enqueue')
    expect(JSON.stringify(row)).not.toContain('invitationId')
    await expect(decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
      expectedScope: SCOPE,
      recordId: input.id,
      field: 'job_payload',
      envelope: JSON.parse(row.payload_envelope),
    })).resolves.toBe('{"actorId":"stf_owner_enqueue","invitationId":"inv_enqueue_secret"}')
    await park(input.id)
  })

  it('recognizes and encrypts the exact dormant backup payload without retaining its key', async () => {
    const cryptoContext = await context()
    const input = await enqueueBackup(cryptoContext, {
      id: 'job_backup_enqueue_secret',
      backupId: 'bkp_enqueue_secret',
    })
    const row = await job(input.id)

    expect(outbox.OUTBOX_TYPES).toContain('backup.create')
    expect(row).toMatchObject({
      id: input.id,
      type: 'backup.create',
      aggregate_type: 'backup_run',
      aggregate_id: input.aggregateId,
      idempotency_key: 'backup.create:2026-07-31:bkp_enqueue_secret',
      status: 'queued',
      attempt_count: 0,
      max_attempts: 8,
    })
    expect(JSON.stringify(row)).not.toContain('backupId')
    await expect(decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
      expectedScope: SCOPE,
      recordId: input.id,
      field: 'job_payload',
      envelope: JSON.parse(row.payload_envelope),
    })).resolves.toBe('{"backupId":"bkp_enqueue_secret"}')
    await expect(outbox.decryptOutboxPayload(cryptoContext, row))
      .resolves.toEqual({ backupId: 'bkp_enqueue_secret' })
    await park(input.id)
  })

  it('rejects every malformed backup shape and per-run key before D1', async () => {
    const cryptoContext = await context()
    const valid = backupInput({
      id: 'job_backup_validation',
      backupId: 'bkp_validation',
    })
    const cases = [
      { ...valid, aggregateId: 'bkp_' },
      { ...valid, aggregateId: 'run_validation', payload: { backupId: 'run_validation' },
        idempotencyKey: 'backup.create:2026-07-31:run_validation' },
      { ...valid, aggregateType: 'backup' },
      { ...valid, payload: { backupId: 'bkp_other' } },
      { ...valid, payload: {} },
      { ...valid, payload: { id: 'bkp_validation' } },
      { ...valid, payload: { backupId: 'bkp_validation', actorId: 'stf_owner_backup' } },
      { ...valid, payload: {
        actorId: 'stf_owner_backup',
        invitationId: 'inv_backup_validation',
      } },
      { ...valid, payload: { actorId: 'stf_owner_backup', generation: 1 } },
      { ...valid, idempotencyKey: 'backup.create:2026-7-31:bkp_validation' },
      { ...valid, idempotencyKey: 'backup.create:2026-02-30:bkp_validation' },
      { ...valid, idempotencyKey: 'backup.create:2026-07-31T00:00:00Z:bkp_validation' },
      { ...valid, idempotencyKey: 'backup.create:2026-07-31:bkp_other' },
      { ...valid, idempotencyKey: 'backup.create:2026-07-31:bkp_validation:extra' },
      { ...valid, scheduledAt: new Date(NOW_MS + 1).toISOString() },
    ]
    const unreachableDb = {
      prepare() { throw new Error('D1_REACHED') },
    }
    for (const input of cases) {
      await expect(outbox.enqueueOutboxStatement(unreachableDb, cryptoContext, input))
        .rejects.toThrow(/^OUTBOX_INVALID$/)
    }
  })

  it('accepts a distinct immutable idempotency key for each valid backup run', async () => {
    const cryptoContext = await context()
    const first = await enqueueBackup(cryptoContext, {
      id: 'job_backup_per_run_first',
      backupId: 'bkp_per_run_first',
    })
    const second = await enqueueBackup(cryptoContext, {
      id: 'job_backup_per_run_second',
      backupId: 'bkp_per_run_second',
    })
    const rows = (await env.DB.prepare(
      `SELECT id,aggregate_id,idempotency_key FROM outbox_jobs
       WHERE id IN (?,?) ORDER BY id`
    ).bind(first.id, second.id).all()).results

    expect(rows).toEqual([
      {
        id: first.id,
        aggregate_id: 'bkp_per_run_first',
        idempotency_key: 'backup.create:2026-07-31:bkp_per_run_first',
      },
      {
        id: second.id,
        aggregate_id: 'bkp_per_run_second',
        idempotency_key: 'backup.create:2026-07-31:bkp_per_run_second',
      },
    ])
    await park(first.id)
    await park(second.id)
  })

  it('rejects extra fields, noncanonical facts, oversized payloads, and unsupported types before D1', async () => {
    const cryptoContext = await context()
    const valid = {
      id: 'job_enqueue_validation',
      type: 'staff.invitation.expire',
      aggregateType: 'staff_invitation',
      aggregateId: 'inv_enqueue_validation',
      payload: { actorId: 'stf_owner_enqueue', invitationId: 'inv_enqueue_validation' },
      idempotencyKey: 'staff.invitation.expire:inv_enqueue_validation',
      scheduledAt: NOW,
      nowMs: NOW_MS,
    }
    const cases = [
      { ...valid, extra: true },
      { ...valid, id: 'not canonical' },
      { ...valid, type: 'backup.export' },
      { ...valid, scheduledAt: '1800000000000' },
      { ...valid, maxAttempts: 9 },
      { ...valid, payload: { ...valid.payload, email: 'secret@example.test' } },
      { ...valid, payload: { actorId: 'stf_owner_enqueue', invitationId: `inv_${'a'.repeat(2048)}` } },
    ]
    for (const input of cases) {
      await expect(outbox.enqueueOutboxStatement(env.DB, cryptoContext, input))
        .rejects.toThrow(/^OUTBOX_INVALID$/)
    }
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM outbox_jobs WHERE id='job_enqueue_validation'"
    ).first()).toEqual({ count: 0 })
  })

  it('tags conditional enqueue statements and rejects their use through the domain UOW channel', async () => {
    const cryptoContext = await context()
    const statement = await outbox.enqueueOutboxStatement(env.DB, cryptoContext, {
      id: 'job_enqueue_tag',
      type: 'staff.access.reconcile',
      aggregateType: 'access_group',
      aggregateId: 'centre_1',
      payload: { actorId: 'stf_owner_enqueue', generation: 1 },
      idempotencyKey: 'staff.access.reconcile:enqueue-tag',
      scheduledAt: NOW,
      nowMs: NOW_MS,
      onlyIfPreviousStatementChanged: true,
    })
    expect(outbox.outboxStatementDescriptorFor(statement)).toEqual({
      conditional: true,
      type: 'staff.access.reconcile',
    })
    const uow = createUnitOfWork(env.DB, {
      mode: 'mutation',
      actorId: 'stf_owner_enqueue',
      correlationId: '11111111-1111-4111-8111-111111111111',
    })
    expect(() => uow.domain(statement)).toThrow(/^UNIT_OF_WORK_INVALID$/)
  })
})

describe('durable outbox claims', () => {
  it('excludes a due dormant backup from ordinary claims without mutating it', async () => {
    const cryptoContext = await context()
    const [backupId] = await seedBackupBacklog(
      cryptoContext,
      'claim_excluded',
      1,
      new Date(NOW_MS - 1).toISOString(),
    )
    const ordinary = await enqueue(cryptoContext, {
      id: 'job_backup_claim_ordinary',
      invitationId: 'inv_backup_claim_ordinary',
      idempotencyKey: 'staff.invitation.expire:backup-claim-ordinary',
    })
    const claimed = await claim({
      idFactory: sequence('attempt_backup_claim'),
      leaseOwnerFactory: sequence('lease_backup_claim'),
    })
    const backupAfter = await job(backupId)
    const backupAttempts = await attempts(backupId)
    for (const row of claimed) await settle(row.id)
    await park(backupId)
    await park(ordinary.id)

    expect(claimed.map(({ id }) => id)).toEqual([ordinary.id])
    expect(backupAfter).toMatchObject({
      status: 'queued',
      attempt_count: 0,
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: null,
    })
    expect(backupAttempts).toEqual([])
  })

  it('does not let one hundred earlier dormant backups starve ten ordinary claims', async () => {
    const cryptoContext = await context()
    const backupIds = await seedBackupBacklog(
      cryptoContext,
      'claim_backlog',
      100,
      new Date(NOW_MS - 1).toISOString(),
    )
    const ordinaryIds = []
    for (let index = 0; index < 10; index += 1) {
      const suffix = String(index).padStart(2, '0')
      const input = await enqueue(cryptoContext, {
        id: `job_backup_backlog_ordinary_${suffix}`,
        invitationId: `inv_backup_backlog_ordinary_${suffix}`,
        idempotencyKey: `staff.invitation.expire:backup-backlog-${suffix}`,
      })
      ordinaryIds.push(input.id)
    }
    const claimed = await claim({
      idFactory: sequence('attempt_backup_backlog'),
      leaseOwnerFactory: sequence('lease_backup_backlog'),
    })
    const dormantAfter = await backupStates('claim_backlog')
    const dormantAttemptCount = (await env.DB.prepare(
      `SELECT count(*) AS count FROM outbox_attempts
       WHERE job_id LIKE 'job_backup_claim_backlog_%'`
    ).first()).count
    for (const row of claimed) await settle(row.id)
    await parkPrefix('job_backup_claim_backlog_')
    await parkPrefix('job_backup_backlog_ordinary_')

    expect(claimed.map(({ id }) => id)).toEqual(ordinaryIds)
    expect(dormantAfter).toHaveLength(backupIds.length)
    expect(dormantAfter.every((row) => row.status === 'queued'
      && row.attempt_count === 0
      && row.lease_owner === null
      && row.lease_expires_at === null
      && row.last_error_code === null)).toBe(true)
    expect(dormantAttemptCount).toBe(0)
  })

  it('claims in stable order, caps at ten, and gives every attempt a fresh fencing token', async () => {
    const cryptoContext = await context()
    const ids = [
      'job_claim_09', 'job_claim_02', 'job_claim_11', 'job_claim_01',
      'job_claim_04', 'job_claim_12', 'job_claim_08', 'job_claim_03',
      'job_claim_10', 'job_claim_07', 'job_claim_06', 'job_claim_05',
    ]
    for (const id of ids) {
      await enqueue(cryptoContext, {
        id,
        invitationId: `inv_${id}`,
        idempotencyKey: `staff.invitation.expire:${id}`,
      })
    }
    const claimed = await claim({
      idFactory: sequence('attempt_claim'),
      leaseOwnerFactory: sequence('lease_claim'),
      limit: 99,
    })
    expect(claimed.map(({ id }) => id)).toEqual([...ids].sort().slice(0, 10))
    expect(new Set(claimed.map(({ leaseOwner }) => leaseOwner))).toHaveLength(10)
    expect(claimed.every(({ attemptNumber }) => attemptNumber === 1)).toBe(true)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM outbox_jobs WHERE id LIKE 'job_claim_%' AND status='processing'"
    ).first()).count).toBe(10)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM outbox_attempts WHERE id LIKE 'attempt_claim_%' AND completed_at IS NULL"
    ).first()).count).toBe(10)
    for (const { id } of claimed) await settle(id)
    for (const id of [...ids].sort().slice(10)) await park(id)
  })

  it('gives two racing workers disjoint claims without duplicate open attempts', async () => {
    const cryptoContext = await context()
    const ids = ['job_race_1', 'job_race_2', 'job_race_3', 'job_race_4']
    for (const id of ids) {
      await enqueue(cryptoContext, {
        id,
        invitationId: `inv_${id}`,
        idempotencyKey: `staff.invitation.expire:${id}`,
      })
    }
    const [one, two] = await Promise.all([
      claim({
        idFactory: sequence('attempt_race_one'),
        leaseOwnerFactory: sequence('lease_race_one'),
      }),
      claim({
        idFactory: sequence('attempt_race_two'),
        leaseOwnerFactory: sequence('lease_race_two'),
      }),
    ])
    const claimedIds = [...one, ...two].map(({ id }) => id)
    expect(claimedIds.sort()).toEqual([...ids].sort())
    expect(new Set(claimedIds)).toHaveLength(ids.length)
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM (
         SELECT job_id FROM outbox_attempts
         WHERE job_id LIKE 'job_race_%' AND completed_at IS NULL
         GROUP BY job_id HAVING count(*)>1
       )`
    ).first()).count).toBe(0)
    for (const id of ids) await settle(id)
  })

  it('rolls back a forced postcondition failure without treating another D1 error as a loser', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_claim_rollback',
      invitationId: 'inv_claim_rollback',
      idempotencyKey: 'staff.invitation.expire:claim-rollback',
    })
    const forced = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: (statements) => env.DB.batch([
        ...statements.slice(0, -1),
        env.DB.prepare(
          "INSERT INTO outbox_operation_guard_failures (operation_id) VALUES ('forced_claim')"
        ),
      ]),
    }
    await expect(claim({
      db: forced,
      idFactory: sequence('attempt_claim_rollback'),
      leaseOwnerFactory: sequence('lease_claim_rollback'),
    })).resolves.toEqual([])
    expect(await job('job_claim_rollback')).toMatchObject({
      status: 'queued',
      attempt_count: 0,
      lease_owner: null,
    })
    expect(await attempts('job_claim_rollback')).toEqual([])

    const collision = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async () => { throw new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT') },
    }
    await expect(claim({
      db: collision,
      idFactory: sequence('attempt_claim_collision'),
      leaseOwnerFactory: sequence('lease_claim_collision'),
    })).rejects.toThrow(/identity_collision/)
    await park('job_claim_rollback')
  })

  it('bounds raced claim attempts by the requested scan limit', async () => {
    const cryptoContext = await context()
    for (const suffix of ['one', 'two']) {
      await enqueue(cryptoContext, {
        id: `job_claim_scan_${suffix}`,
        invitationId: `inv_claim_scan_${suffix}`,
        idempotencyKey: `staff.invitation.expire:claim-scan-${suffix}`,
      })
    }
    let batches = 0
    const losingDb = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements) {
        batches += 1
        return env.DB.batch([
          ...statements.slice(0, -1),
          env.DB.prepare(
            `INSERT INTO outbox_operation_guard_failures (operation_id)
             VALUES (?)`
          ).bind(`forced_claim_scan_${batches}`),
        ])
      },
    }

    const claimed = await claim({
      db: losingDb,
      idFactory: sequence('attempt_claim_scan'),
      leaseOwnerFactory: sequence('lease_claim_scan'),
      limit: 1,
      scanLimit: 1,
    })
    const rows = (await env.DB.prepare(
      "SELECT id,status FROM outbox_jobs WHERE id LIKE 'job_claim_scan_%' ORDER BY id"
    ).all()).results
    await parkPrefix('job_claim_scan_')

    expect(claimed).toEqual([])
    expect(batches).toBe(1)
    expect(rows).toEqual([
      { id: 'job_claim_scan_one', status: 'queued' },
      { id: 'job_claim_scan_two', status: 'queued' },
    ])
  })

  it('does not claim future, processing, malformed, terminal, or exhausted jobs', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_claim_excluded_future',
      invitationId: 'inv_claim_excluded_future',
      idempotencyKey: 'staff.invitation.expire:claim-excluded-future',
      scheduledAt: new Date(NOW_MS + 1).toISOString(),
    })
    await enqueue(cryptoContext, {
      id: 'job_claim_excluded_processing',
      invitationId: 'inv_claim_excluded_processing',
      idempotencyKey: 'staff.invitation.expire:claim-excluded-processing',
    })
    await enqueue(cryptoContext, {
      id: 'job_claim_excluded_terminal',
      invitationId: 'inv_claim_excluded_terminal',
      idempotencyKey: 'staff.invitation.expire:claim-excluded-terminal',
    })
    await enqueue(cryptoContext, {
      id: 'job_claim_excluded_exhausted',
      invitationId: 'inv_claim_excluded_exhausted',
      idempotencyKey: 'staff.invitation.expire:claim-excluded-exhausted',
    })
    await env.DB.prepare(
      "UPDATE outbox_jobs SET status='dead' WHERE id='job_claim_excluded_terminal'"
    ).run()
    await env.DB.prepare(
      "UPDATE outbox_jobs SET attempt_count=8 WHERE id='job_claim_excluded_exhausted'"
    ).run()
    await env.DB.prepare(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,created_at,updated_at)
       VALUES ('job_claim_excluded_malformed','staff.invitation.expire',
         'staff_invitation','inv_claim_excluded_malformed','{}',
         'staff.invitation.expire:claim-excluded-malformed','queued',0,8,?,?,?)`
    ).bind(NOW, NOW, NOW).run()
    await env.DB.prepare(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,created_at,updated_at)
       VALUES ('job_claim_excluded_bad_envelope','staff.invitation.expire',
         'staff_invitation','inv_claim_excluded_bad_envelope',?,
         'staff.invitation.expire:claim-excluded-bad-envelope','queued',0,8,?,?,?)`
    ).bind(JSON.stringify({
      format: 1,
      algorithm: 'A256GCM',
      dataKeyId: 'key_bad_envelope',
      dataKeyVersion: 1,
      nonce: '',
      ciphertext: '',
    }), NOW, NOW, NOW).run()
    const [processing] = await claim({
      idFactory: sequence('attempt_claim_excluded'),
      leaseOwnerFactory: sequence('lease_claim_excluded'),
    })
    expect(processing.id).toBe('job_claim_excluded_processing')
    await expect(claim({
      idFactory: sequence('attempt_claim_excluded_again'),
      leaseOwnerFactory: sequence('lease_claim_excluded_again'),
    })).resolves.toEqual([])
    await settle(processing.id)
    for (const id of [
      'job_claim_excluded_future',
      'job_claim_excluded_exhausted',
      'job_claim_excluded_malformed',
      'job_claim_excluded_bad_envelope',
    ]) await park(id)
  })
})

describe('durable outbox expired-lease reaping', () => {
  it('does not reap or mutate an expired dormant backup claim', async () => {
    const cryptoContext = await context()
    const input = await enqueueBackup(cryptoContext, {
      id: 'job_backup_reap_dormant',
      backupId: 'bkp_reap_dormant',
    })
    await env.DB.prepare(
      `UPDATE outbox_jobs
       SET status='processing',attempt_count=1,lease_owner=?,lease_expires_at=?,updated_at=?
       WHERE id=?`
    ).bind('lease_backup_reap', NOW, NOW, input.id).run()
    await env.DB.prepare(
      `INSERT INTO outbox_attempts (id,job_id,attempt_number,started_at)
       VALUES (?,?,1,?)`
    ).bind('attempt_backup_reap', input.id, new Date(NOW_MS - 60_000).toISOString()).run()
    const beforeJob = await job(input.id)
    const beforeAttempts = await attempts(input.id)

    const reaped = await outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
      nowMs: NOW_MS,
      idFactory: sequence('action_backup_reap'),
    })
    const afterJob = await job(input.id)
    const afterAttempts = await attempts(input.id)
    if (afterJob.status === 'processing') await settle(input.id)
    else await park(input.id)

    expect(reaped).toEqual([])
    expect(afterJob).toEqual(beforeJob)
    expect(afterAttempts).toEqual(beforeAttempts)
    expect(await actions(input.id)).toEqual([])
  })

  it('dead-letters an ambiguous email attempt and opens one encrypted critical action', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_reap_email',
      type: 'staff.invitation.email',
      invitationId: 'inv_reap_email',
      idempotencyKey: 'staff.invitation.email:reap-email',
    })
    const [claimed] = await claim({
      idFactory: sequence('attempt_reap_email'),
      leaseOwnerFactory: sequence('lease_reap_email'),
    })
    const result = await outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
      nowMs: NOW_MS + 60_000,
      idFactory: sequence('action_reap_email'),
    })
    expect(result).toEqual([{ id: claimed.id, result: 'dead' }])
    expect(await job(claimed.id)).toMatchObject({
      status: 'dead',
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: 'EMAIL_DELIVERY_AMBIGUOUS',
    })
    expect(await attempts(claimed.id)).toMatchObject([{
      attempt_number: 1,
      result: 'dead',
      error_code: 'EMAIL_DELIVERY_AMBIGUOUS',
    }])
    const [action] = await actions(claimed.id)
    expect(action).toMatchObject({
      id: 'action_reap_email_1',
      severity: 'critical',
      status: 'open',
    })
    expect(JSON.stringify(action)).not.toContain('stf_owner_outbox')
    await expect(decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
      expectedScope: SCOPE,
      recordId: action.id,
      field: 'action_details',
      envelope: JSON.parse(action.details_envelope),
    })).resolves.toBe(
      '{"errorCode":"EMAIL_DELIVERY_AMBIGUOUS","jobId":"job_reap_email","outboxType":"staff.invitation.email"}'
    )
    await expect(outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
      nowMs: NOW_MS + 120_000,
      idFactory: sequence('action_reap_email_repeat'),
    })).resolves.toEqual([])
    expect(await actions(claimed.id)).toHaveLength(1)
    expect(await attempts(claimed.id)).toHaveLength(1)
  })

  it.each(['staff.access.reconcile', 'staff.invitation.expire'])(
    'requeues one expired idempotent %s attempt immediately',
    async (type) => {
      const cryptoContext = await context()
      const suffix = type.endsWith('reconcile') ? 'access' : 'expiry'
      await enqueue(cryptoContext, {
        id: `job_reap_${suffix}`,
        type,
        invitationId: `inv_reap_${suffix}`,
        idempotencyKey: `${type}:reap-${suffix}`,
      })
      const [claimed] = await claim({
        idFactory: sequence(`attempt_reap_${suffix}`),
        leaseOwnerFactory: sequence(`lease_reap_${suffix}`),
      })
      const reapedAt = NOW_MS + 60_000
      await expect(outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
        nowMs: reapedAt,
        idFactory: sequence(`action_reap_${suffix}`),
      })).resolves.toEqual([{ id: claimed.id, result: 'retry' }])
      expect(await job(claimed.id)).toMatchObject({
        status: 'queued',
        scheduled_at: new Date(reapedAt).toISOString(),
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: 'OUTBOX_LEASE_EXPIRED',
      })
      expect(await attempts(claimed.id)).toMatchObject([{
        result: 'retry',
        error_code: 'OUTBOX_LEASE_EXPIRED',
      }])
      expect(await actions(claimed.id)).toEqual([])
      await park(claimed.id)
    }
  )

  it.each(['staff.access.reconcile', 'staff.invitation.expire'])(
    'dead-letters an expired final %s attempt and opens one critical action',
    async (type) => {
      const cryptoContext = await context()
      const suffix = type.endsWith('reconcile') ? 'access' : 'expiry'
      const input = await enqueue(cryptoContext, {
        id: `job_reap_exhausted_${suffix}`,
        type,
        invitationId: `inv_reap_exhausted_${suffix}`,
        idempotencyKey: `${type}:reap-exhausted-${suffix}`,
      })
      await env.DB.prepare(
        `UPDATE outbox_jobs
         SET status='processing',attempt_count=8,lease_owner=?,lease_expires_at=?,updated_at=?
         WHERE id=?`
      ).bind(`lease_reap_exhausted_${suffix}`, NOW, NOW, input.id).run()
      await env.DB.prepare(
        `INSERT INTO outbox_attempts (id,job_id,attempt_number,started_at)
         VALUES (?,?,8,?)`
      ).bind(
        `attempt_reap_exhausted_${suffix}`,
        input.id,
        new Date(NOW_MS - 60_000).toISOString(),
      ).run()

      await expect(outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
        nowMs: NOW_MS + 60_000,
        idFactory: sequence(`action_reap_exhausted_${suffix}`),
      })).resolves.toEqual([{ id: input.id, result: 'dead' }])
      expect(await job(input.id)).toMatchObject({
        status: 'dead',
        scheduled_at: NOW,
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: 'OUTBOX_LEASE_EXPIRED',
      })
      expect(await attempts(input.id)).toMatchObject([{
        attempt_number: 8,
        result: 'dead',
        error_code: 'OUTBOX_LEASE_EXPIRED',
      }])
      const [action] = await actions(input.id)
      expect(action).toMatchObject({
        id: `action_reap_exhausted_${suffix}_1`,
        severity: 'critical',
        status: 'open',
      })
      await expect(decryptForScope(cryptoContext.keyring, cryptoContext.dataKey, {
        expectedScope: SCOPE,
        recordId: action.id,
        field: 'action_details',
        envelope: JSON.parse(action.details_envelope),
      })).resolves.toBe(
        `{"errorCode":"OUTBOX_LEASE_EXPIRED","jobId":"${input.id}","outboxType":"${type}"}`
      )
      await expect(outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
        nowMs: NOW_MS + 120_000,
        idFactory: sequence(`action_reap_exhausted_repeat_${suffix}`),
      })).resolves.toEqual([])
      expect(await actions(input.id)).toHaveLength(1)
      expect(await attempts(input.id)).toHaveLength(1)
    }
  )

  it('reaps only the requested oldest expired lease', async () => {
    const cryptoContext = await context()
    for (const suffix of ['one', 'two']) {
      await enqueue(cryptoContext, {
        id: `job_reap_limit_${suffix}`,
        invitationId: `inv_reap_limit_${suffix}`,
        idempotencyKey: `staff.invitation.expire:reap-limit-${suffix}`,
      })
    }
    await claim({
      idFactory: sequence('attempt_reap_limit'),
      leaseOwnerFactory: sequence('lease_reap_limit'),
      limit: 2,
    })

    let result
    let thrown
    try {
      result = await outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
        nowMs: NOW_MS + 60_000,
        idFactory: sequence('action_reap_limit'),
        limit: 1,
      })
    } catch (error) {
      thrown = error
    }
    const first = await job('job_reap_limit_one')
    const second = await job('job_reap_limit_two')
    await settle('job_reap_limit_one')
    await settle('job_reap_limit_two')
    await park('job_reap_limit_one')
    await park('job_reap_limit_two')

    expect(thrown).toBeUndefined()
    expect(result).toEqual([{ id: 'job_reap_limit_one', result: 'retry' }])
    expect(first).toMatchObject({ status: 'queued' })
    expect(second).toMatchObject({ status: 'processing' })
  })

  it('fails closed on a missing or mismatched open attempt', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_reap_malformed',
      invitationId: 'inv_reap_malformed',
      idempotencyKey: 'staff.invitation.expire:reap-malformed',
    })
    await env.DB.prepare(
      `UPDATE outbox_jobs
       SET status='processing',attempt_count=1,lease_owner='lease_reap_malformed',
           lease_expires_at=?,updated_at=?
       WHERE id='job_reap_malformed'`
    ).bind(new Date(NOW_MS - 1).toISOString(), NOW).run()
    await expect(outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
      nowMs: NOW_MS,
      idFactory: sequence('action_reap_malformed'),
    })).rejects.toThrow(/^OUTBOX_STATE_INVALID$/)
    expect(await job('job_reap_malformed')).toMatchObject({
      status: 'processing',
      attempt_count: 1,
    })
    expect(await actions('job_reap_malformed')).toEqual([])
    await env.DB.prepare(
      `UPDATE outbox_jobs
       SET status='dead',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
       WHERE id='job_reap_malformed'`
    ).bind(NOW).run()
  })

  it('has one winner across concurrent reapers', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_reap_race',
      type: 'staff.invitation.email',
      invitationId: 'inv_reap_race',
      idempotencyKey: 'staff.invitation.email:reap-race',
    })
    await claim({
      idFactory: sequence('attempt_reap_race'),
      leaseOwnerFactory: sequence('lease_reap_race'),
    })
    const [one, two] = await Promise.all([
      outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
        nowMs: NOW_MS + 60_000,
        idFactory: sequence('action_reap_race_one'),
      }),
      outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
        nowMs: NOW_MS + 60_000,
        idFactory: sequence('action_reap_race_two'),
      }),
    ])
    expect([...one, ...two]).toHaveLength(1)
    expect(await attempts('job_reap_race')).toHaveLength(1)
    expect(await actions('job_reap_race')).toHaveLength(1)
  })
})

describe('durable outbox finalization', () => {
  it('atomically completes a successful attempt and job', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_finalize_success',
      invitationId: 'inv_finalize_success',
      idempotencyKey: 'staff.invitation.expire:finalize-success',
    })
    const [claimed] = await claim({
      idFactory: sequence('attempt_finalize_success'),
      leaseOwnerFactory: sequence('lease_finalize_success'),
    })
    await expect(outbox.finalizeOutboxJob(env.DB, cryptoContext, {
      jobId: claimed.id,
      leaseOwner: claimed.leaseOwner,
      attemptNumber: claimed.attemptNumber,
      nowMs: NOW_MS + 1,
      result: 'succeeded',
      errorCode: null,
      providerReference: null,
      idFactory: sequence('action_finalize_success'),
    })).resolves.toBe(true)
    expect(await job(claimed.id)).toMatchObject({
      status: 'succeeded',
      lease_owner: null,
      last_error_code: null,
    })
    expect(await attempts(claimed.id)).toMatchObject([{
      result: 'succeeded',
      error_code: null,
    }])
    expect(await actions(claimed.id)).toEqual([])
  })

  it('uses every exact retry delay and makes retry attempt eight terminal', async () => {
    const cryptoContext = await context()
    const input = await enqueue(cryptoContext, {
      id: 'job_finalize_retries',
      invitationId: 'inv_finalize_retries',
      idempotencyKey: 'staff.invitation.expire:finalize-retries',
    })
    let dueAt = NOW_MS
    for (let attemptNumber = 1; attemptNumber <= 8; attemptNumber += 1) {
      const [claimed] = await claim({
        nowMs: dueAt,
        idFactory: sequence(`attempt_finalize_retry_${attemptNumber}`),
        leaseOwnerFactory: sequence(`lease_finalize_retry_${attemptNumber}`),
      })
      expect(claimed).toMatchObject({ id: input.id, attemptNumber })
      const completedAt = dueAt + 1
      await outbox.finalizeOutboxJob(env.DB, cryptoContext, {
        jobId: claimed.id,
        leaseOwner: claimed.leaseOwner,
        attemptNumber,
        nowMs: completedAt,
        result: 'retry',
        errorCode: 'OUTBOX_HANDLER_RETRY',
        providerReference: null,
        idFactory: sequence(`action_finalize_retry_${attemptNumber}`),
      })
      const row = await job(input.id)
      if (attemptNumber < 8) {
        dueAt = completedAt + outbox.retryDelayMs(attemptNumber)
        expect(row).toMatchObject({
          status: 'queued',
          scheduled_at: new Date(dueAt).toISOString(),
        })
      } else {
        expect(row).toMatchObject({
          status: 'dead',
          last_error_code: 'OUTBOX_HANDLER_RETRY',
        })
      }
    }
    expect((await attempts(input.id)).map(({ result }) => result)).toEqual([
      'retry', 'retry', 'retry', 'retry', 'retry', 'retry', 'retry', 'dead',
    ])
    expect(await actions(input.id)).toHaveLength(1)
  })

  it('dead-letters explicitly once and leaves stale, wrong, expired, and terminal owners as no-ops', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_finalize_dead',
      invitationId: 'inv_finalize_dead',
      idempotencyKey: 'staff.invitation.expire:finalize-dead',
    })
    const [claimed] = await claim({
      idFactory: sequence('attempt_finalize_dead'),
      leaseOwnerFactory: sequence('lease_finalize_dead'),
    })
    const base = {
      jobId: claimed.id,
      attemptNumber: claimed.attemptNumber,
      nowMs: NOW_MS + 1,
      result: 'dead',
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      providerReference: null,
      idFactory: sequence('action_finalize_dead'),
    }
    await expect(outbox.finalizeOutboxJob(env.DB, cryptoContext, {
      ...base,
      leaseOwner: 'lease_wrong_owner',
    })).resolves.toBe(false)
    await expect(outbox.finalizeOutboxJob(env.DB, cryptoContext, {
      ...base,
      attemptNumber: 2,
      leaseOwner: claimed.leaseOwner,
    })).resolves.toBe(false)
    await expect(outbox.finalizeOutboxJob(env.DB, cryptoContext, {
      ...base,
      leaseOwner: claimed.leaseOwner,
    })).resolves.toBe(true)
    await expect(outbox.finalizeOutboxJob(env.DB, cryptoContext, {
      ...base,
      leaseOwner: claimed.leaseOwner,
    })).resolves.toBe(false)
    expect(await actions(claimed.id)).toHaveLength(1)

    await enqueue(cryptoContext, {
      id: 'job_finalize_expired',
      invitationId: 'inv_finalize_expired',
      idempotencyKey: 'staff.invitation.expire:finalize-expired',
    })
    const [expired] = await claim({
      idFactory: sequence('attempt_finalize_expired'),
      leaseOwnerFactory: sequence('lease_finalize_expired'),
    })
    await expect(outbox.finalizeOutboxJob(env.DB, cryptoContext, {
      ...base,
      jobId: expired.id,
      leaseOwner: expired.leaseOwner,
      attemptNumber: expired.attemptNumber,
      nowMs: NOW_MS + 60_000,
      idFactory: sequence('action_finalize_expired'),
    })).resolves.toBe(false)
    expect(await job(expired.id)).toMatchObject({ status: 'processing' })
    expect(await actions(expired.id)).toEqual([])
    await settle(expired.id)
  })

  it('rolls back every finalization write when the final guard fails', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_finalize_rollback',
      invitationId: 'inv_finalize_rollback',
      idempotencyKey: 'staff.invitation.expire:finalize-rollback',
    })
    const [claimed] = await claim({
      idFactory: sequence('attempt_finalize_rollback'),
      leaseOwnerFactory: sequence('lease_finalize_rollback'),
    })
    const forced = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: (statements) => env.DB.batch([
        ...statements.slice(0, -1),
        env.DB.prepare(
          "INSERT INTO outbox_operation_guard_failures (operation_id) VALUES ('forced_finalize')"
        ),
      ]),
    }
    await expect(outbox.finalizeOutboxJob(forced, cryptoContext, {
      jobId: claimed.id,
      leaseOwner: claimed.leaseOwner,
      attemptNumber: claimed.attemptNumber,
      nowMs: NOW_MS + 1,
      result: 'dead',
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      providerReference: null,
      idFactory: sequence('action_finalize_rollback'),
    })).resolves.toBe(false)
    expect(await job(claimed.id)).toMatchObject({
      status: 'processing',
      lease_owner: claimed.leaseOwner,
    })
    expect(await attempts(claimed.id)).toMatchObject([{
      completed_at: null,
      result: null,
    }])
    expect(await actions(claimed.id)).toEqual([])
    await settle(claimed.id)
  })

  it('fails closed when a matching open action does not have every exact encrypted action fact', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_finalize_bad_action',
      invitationId: 'inv_finalize_bad_action',
      idempotencyKey: 'staff.invitation.expire:finalize-bad-action',
    })
    const [claimed] = await claim({
      idFactory: sequence('attempt_finalize_bad_action'),
      leaseOwnerFactory: sequence('lease_finalize_bad_action'),
    })
    const actionId = 'action_finalize_bad_action'
    const detailsEnvelope = JSON.stringify(await encryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: SCOPE,
        recordId: actionId,
        field: 'action_details',
        plaintext: '{"errorCode":"OUTBOX_HANDLER_FAILURE","jobId":"job_finalize_bad_action","outboxType":"staff.invitation.expire"}',
      }
    ))
    await env.DB.prepare(
      `INSERT INTO operational_actions
       (id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
        version,created_at,updated_at)
       VALUES (?,?,'wrong_kind','critical','open','outbox_job',?,?,1,?,?)`
    ).bind(
      actionId,
      'outbox.dead:job_finalize_bad_action',
      claimed.id,
      detailsEnvelope,
      NOW,
      NOW,
    ).run()
    await expect(outbox.finalizeOutboxJob(env.DB, cryptoContext, {
      jobId: claimed.id,
      leaseOwner: claimed.leaseOwner,
      attemptNumber: claimed.attemptNumber,
      nowMs: NOW_MS + 1,
      result: 'dead',
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      providerReference: null,
      idFactory: sequence('action_finalize_bad_action_new'),
    })).rejects.toThrow(/^OUTBOX_STATE_INVALID$/)
    expect(await job(claimed.id)).toMatchObject({
      status: 'processing',
      lease_owner: claimed.leaseOwner,
    })
    expect(await attempts(claimed.id)).toMatchObject([{
      completed_at: null,
      result: null,
    }])
    await settle(claimed.id)
  })

  it('reuses one pre-existing open action only when every encrypted action fact matches', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_finalize_exact_action',
      invitationId: 'inv_finalize_exact_action',
      idempotencyKey: 'staff.invitation.expire:finalize-exact-action',
    })
    const [claimed] = await claim({
      idFactory: sequence('attempt_finalize_exact_action'),
      leaseOwnerFactory: sequence('lease_finalize_exact_action'),
    })
    const actionId = 'action_finalize_exact_action'
    const detailsEnvelope = JSON.stringify(await encryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: SCOPE,
        recordId: actionId,
        field: 'action_details',
        plaintext: '{"errorCode":"OUTBOX_HANDLER_FAILURE","jobId":"job_finalize_exact_action","outboxType":"staff.invitation.expire"}',
      }
    ))
    await env.DB.prepare(
      `INSERT INTO operational_actions
       (id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
        version,created_at,updated_at)
       VALUES (?,?,'outbox_job_failed','critical','open','outbox_job',?,?,1,?,?)`
    ).bind(
      actionId,
      'outbox.dead:job_finalize_exact_action',
      claimed.id,
      detailsEnvelope,
      NOW,
      NOW,
    ).run()
    await expect(outbox.finalizeOutboxJob(env.DB, cryptoContext, {
      jobId: claimed.id,
      leaseOwner: claimed.leaseOwner,
      attemptNumber: claimed.attemptNumber,
      nowMs: NOW_MS + 1,
      result: 'dead',
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      providerReference: null,
      idFactory: sequence('action_finalize_exact_action_unused'),
    })).resolves.toBe(true)
    expect(await job(claimed.id)).toMatchObject({
      status: 'dead',
      last_error_code: 'OUTBOX_HANDLER_FAILURE',
    })
    expect(await actions(claimed.id)).toMatchObject([{
      id: actionId,
      kind: 'outbox_job_failed',
      details_envelope: detailsEnvelope,
    }])
  })

  it('rejects a non-staff-directory context before creating a dead-letter action', async () => {
    const cryptoContext = await context()
    const wrongContext = await nonDirectoryContext()
    await enqueue(cryptoContext, {
      id: 'job_finalize_wrong_scope',
      invitationId: 'inv_finalize_wrong_scope',
      idempotencyKey: 'staff.invitation.expire:finalize-wrong-scope',
    })
    const [claimed] = await claim({
      idFactory: sequence('attempt_finalize_wrong_scope'),
      leaseOwnerFactory: sequence('lease_finalize_wrong_scope'),
    })
    await expect(outbox.finalizeOutboxJob(env.DB, wrongContext, {
      jobId: claimed.id,
      leaseOwner: claimed.leaseOwner,
      attemptNumber: claimed.attemptNumber,
      nowMs: NOW_MS + 1,
      result: 'dead',
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      providerReference: null,
      idFactory: sequence('action_finalize_wrong_scope'),
    })).rejects.toThrow(/^OUTBOX_INVALID$/)
    expect(await job(claimed.id)).toMatchObject({
      status: 'processing',
      lease_owner: claimed.leaseOwner,
    })
    expect(await actions(claimed.id)).toEqual([])
    await settle(claimed.id)
  })
})

describe('generic outbox processor', () => {
  it('rejects a non-function beforeDispatch hook before claiming work', async () => {
    const cryptoContext = await context()

    await expect(outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS,
      idFactory: sequence('processor_invalid_hook_id'),
      leaseOwnerFactory: sequence('processor_invalid_hook_lease'),
      beforeDispatch: 'not-a-function',
      dispatch: async () => ({ result: 'succeeded' }),
    })).rejects.toThrow(/^OUTBOX_INVALID$/)
  })

  it('propagates beforeDispatch rejection with the claimed job and attempt left open', async () => {
    const cryptoContext = await context()
    const input = await enqueue(cryptoContext, {
      id: 'job_processor_before_dispatch_reject',
      invitationId: 'inv_processor_before_dispatch_reject',
      idempotencyKey: 'staff.invitation.expire:processor-before-dispatch-reject',
    })
    const error = new Error('scheduler ownership lost')
    let dispatches = 0

    await expect(outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS,
      idFactory: sequence('processor_reject_hook_id'),
      leaseOwnerFactory: sequence('processor_reject_hook_lease'),
      beforeDispatch: async () => { throw error },
      dispatch: async () => {
        dispatches += 1
        return { result: 'succeeded' }
      },
    })).rejects.toBe(error)

    expect(dispatches).toBe(0)
    expect(await job(input.id)).toMatchObject({
      status: 'processing',
      attempt_count: 1,
      last_error_code: null,
    })
    expect(await attempts(input.id)).toEqual([
      expect.objectContaining({
        attempt_number: 1,
        completed_at: null,
        result: null,
        error_code: null,
        provider_reference: null,
      }),
    ])
    expect(await actions(input.id)).toEqual([])
    expect((await env.DB.prepare(
      'SELECT id FROM delivery_attempts WHERE outbox_job_id=?'
    ).bind(input.id).all()).results).toEqual([])
    await settle(input.id)
  })

  it('preserves ordinary completion when beforeDispatch resolves', async () => {
    const cryptoContext = await context()
    const input = await enqueue(cryptoContext, {
      id: 'job_processor_before_dispatch_success',
      invitationId: 'inv_processor_before_dispatch_success',
      idempotencyKey: 'staff.invitation.expire:processor-before-dispatch-success',
    })
    const order = []

    const completed = await outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS,
      idFactory: sequence('processor_success_hook_id'),
      leaseOwnerFactory: sequence('processor_success_hook_lease'),
      beforeDispatch: async () => { order.push('beforeDispatch') },
      dispatch: async () => {
        order.push('dispatch')
        return { result: 'succeeded' }
      },
    })

    expect(order).toEqual(['beforeDispatch', 'dispatch'])
    expect(completed).toEqual([{ id: input.id, result: 'succeeded' }])
    expect(await job(input.id)).toMatchObject({
      status: 'succeeded',
      attempt_count: 1,
      last_error_code: null,
    })
    expect(await attempts(input.id)).toEqual([
      expect.objectContaining({
        attempt_number: 1,
        result: 'succeeded',
        error_code: null,
      }),
    ])
    expect(await actions(input.id)).toEqual([])
  })

  it('honors one bounded claim and one-candidate scan per invocation', async () => {
    const cryptoContext = await context()
    for (const suffix of ['one', 'two']) {
      await enqueue(cryptoContext, {
        id: `job_processor_limit_${suffix}`,
        invitationId: `inv_processor_limit_${suffix}`,
        idempotencyKey: `staff.invitation.expire:processor-limit-${suffix}`,
      })
    }
    const dispatched = []

    const completed = await outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS,
      idFactory: sequence('processor_limit_id'),
      leaseOwnerFactory: sequence('processor_limit_lease'),
      limit: 1,
      claimScanLimit: 1,
      reapLimit: 1,
      stopAfterReap: true,
      dispatch: async ({ job: current }) => {
        dispatched.push(current.id)
        return { result: 'succeeded' }
      },
    })
    const second = await job('job_processor_limit_two')
    await park('job_processor_limit_two')

    expect(completed).toEqual([{ id: 'job_processor_limit_one', result: 'succeeded' }])
    expect(dispatched).toEqual(['job_processor_limit_one'])
    expect(second).toMatchObject({
      status: 'queued',
      attempt_count: 0,
    })
  })

  it('returns after one reap without claiming or dispatching in the same invocation', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_processor_reap_only',
      invitationId: 'inv_processor_reap_only',
      idempotencyKey: 'staff.invitation.expire:processor-reap-only',
    })
    await claim({
      idFactory: sequence('attempt_processor_reap_only'),
      leaseOwnerFactory: sequence('lease_processor_reap_only'),
      limit: 1,
    })
    let dispatches = 0

    const completed = await outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS + 60_000,
      idFactory: sequence('processor_reap_only_id'),
      leaseOwnerFactory: sequence('processor_reap_only_lease'),
      limit: 1,
      claimScanLimit: 1,
      reapLimit: 1,
      stopAfterReap: true,
      dispatch: async () => {
        dispatches += 1
        return { result: 'succeeded' }
      },
    })
    const current = await job('job_processor_reap_only')
    await park('job_processor_reap_only')

    expect(completed).toEqual([{ id: 'job_processor_reap_only', result: 'retry' }])
    expect(dispatches).toBe(0)
    expect(current).toMatchObject({
      status: 'queued',
      attempt_count: 1,
      last_error_code: 'OUTBOX_LEASE_EXPIRED',
    })
  })

  it('does not dispatch when beforeDispatch consumes the remaining lease', async () => {
    const cryptoContext = await context()
    const input = await enqueue(cryptoContext, {
      id: 'job_processor_hook_lease_expired',
      invitationId: 'inv_processor_hook_lease_expired',
      idempotencyKey: 'staff.invitation.expire:processor-hook-lease-expired',
    })
    let currentMs = NOW_MS
    let hookCalls = 0
    let dispatches = 0

    const completed = await outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS,
      nowFactory: () => currentMs,
      idFactory: sequence('processor_hook_lease_expired_id'),
      leaseOwnerFactory: sequence('processor_hook_lease_expired_lease'),
      beforeDispatch: async () => {
        hookCalls += 1
        currentMs = NOW_MS + 60_000
      },
      dispatch: async () => {
        dispatches += 1
        return { result: 'succeeded' }
      },
    })

    expect(hookCalls).toBe(1)
    expect(dispatches).toBe(0)
    expect(completed).toEqual([])
    expect(await job(input.id)).toMatchObject({
      status: 'processing',
      attempt_count: 1,
    })
    expect(await attempts(input.id)).toEqual([
      expect.objectContaining({
        attempt_number: 1,
        completed_at: null,
        result: null,
      }),
    ])
    await settle(input.id)
  })

  it('processes ordinary work behind a dormant backlog without dispatching or mutating backups', async () => {
    const cryptoContext = await context()
    await seedBackupBacklog(
      cryptoContext,
      'processor_dormant',
      100,
      new Date(NOW_MS - 1).toISOString(),
    )
    const ordinaryIds = []
    for (let index = 0; index < 2; index += 1) {
      const input = await enqueue(cryptoContext, {
        id: `job_backup_processor_ordinary_${index}`,
        invitationId: `inv_backup_processor_ordinary_${index}`,
        idempotencyKey: `staff.invitation.expire:backup-processor-${index}`,
      })
      ordinaryIds.push(input.id)
    }
    const before = await backupStates('processor_dormant')
    const dispatchedTypes = []
    const completed = await outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS,
      idFactory: sequence('processor_backup_dormant_id'),
      leaseOwnerFactory: sequence('processor_backup_dormant_lease'),
      dispatch: async ({ job: current }) => {
        dispatchedTypes.push(current.type)
        return { result: 'succeeded' }
      },
    })
    const after = await backupStates('processor_dormant')
    const dormantAttemptCount = (await env.DB.prepare(
      `SELECT count(*) AS count FROM outbox_attempts
       WHERE job_id LIKE 'job_backup_processor_dormant_%'`
    ).first()).count
    await parkPrefix('job_backup_processor_dormant_')
    await parkPrefix('job_backup_processor_ordinary_')

    expect(completed).toEqual(ordinaryIds.map((id) => ({ id, result: 'succeeded' })))
    expect(dispatchedTypes).toEqual([
      'staff.invitation.expire',
      'staff.invitation.expire',
    ])
    expect(after).toEqual(before)
    expect(dormantAttemptCount).toBe(0)
  })

  it('finishes expired-lease D1 work before dispatching the reclaimed job', async () => {
    const cryptoContext = await context()
    await enqueue(cryptoContext, {
      id: 'job_processor_order',
      invitationId: 'inv_processor_order',
      idempotencyKey: 'staff.invitation.expire:processor-order',
    })
    await claim({
      idFactory: sequence('attempt_processor_order'),
      leaseOwnerFactory: sequence('lease_processor_order'),
    })
    let pendingBatches = 0
    const guardedDb = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements) {
        pendingBatches += 1
        try {
          return await env.DB.batch(statements)
        } finally {
          pendingBatches -= 1
        }
      },
    }
    let dispatches = 0
    await outbox.processOutboxBatch({
      db: guardedDb,
      cryptoContext,
      config: Object.freeze({ marker: 'injected' }),
      nowMs: NOW_MS + 60_000,
      idFactory: sequence('processor_order_id'),
      leaseOwnerFactory: sequence('processor_order_lease'),
      dispatch: async (input) => {
        dispatches += 1
        expect(pendingBatches).toBe(0)
        expect(input).not.toHaveProperty('payload')
        expect(input.job.id).toBe('job_processor_order')
        expect(await env.DB.prepare(
          'SELECT result FROM outbox_attempts WHERE job_id=? AND attempt_number=1'
        ).bind(input.job.id).first()).toEqual({ result: 'retry' })
        return { result: 'succeeded' }
      },
    })
    expect(dispatches).toBe(1)
    expect((await attempts('job_processor_order')).map(({ result }) => result))
      .toEqual(['retry', 'succeeded'])
  })

  it('does not dispatch cached claims after a handler crosses the lease and a reaper wins', async () => {
    const cryptoContext = await context()
    for (const suffix of ['one', 'two']) {
      await enqueue(cryptoContext, {
        id: `job_processor_expiry_${suffix}`,
        type: 'staff.invitation.email',
        invitationId: `inv_processor_expiry_${suffix}`,
        idempotencyKey: `staff.invitation.email:processor-expiry-${suffix}`,
      })
    }
    let currentMs = NOW_MS
    let dispatches = 0
    const completed = await outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS,
      nowFactory: () => currentMs,
      idFactory: sequence('processor_expiry_id'),
      leaseOwnerFactory: sequence('processor_expiry_lease'),
      dispatch: async () => {
        dispatches += 1
        currentMs = NOW_MS + 60_000
        await outbox.reapExpiredOutboxLeases(env.DB, cryptoContext, {
          nowMs: currentMs,
          idFactory: sequence(`action_processor_expiry_${dispatches}`),
        })
        return { result: 'succeeded' }
      },
    })
    expect(dispatches).toBe(1)
    expect(completed).toEqual([])
    for (const suffix of ['one', 'two']) {
      expect(await job(`job_processor_expiry_${suffix}`)).toMatchObject({
        status: 'dead',
        last_error_code: 'EMAIL_DELIVERY_AMBIGUOUS',
      })
      expect(await attempts(`job_processor_expiry_${suffix}`)).toHaveLength(1)
      expect(await actions(`job_processor_expiry_${suffix}`)).toHaveLength(1)
    }
  })

  it('bounds claims, exposes no plaintext payload, and sanitizes thrown failures', async () => {
    const cryptoContext = await context()
    for (let index = 0; index < 11; index += 1) {
      await enqueue(cryptoContext, {
        id: `job_processor_${String(index).padStart(2, '0')}`,
        invitationId: `inv_processor_${index}`,
        idempotencyKey: `staff.invitation.expire:processor-${index}`,
      })
    }
    const dispatched = []
    const completed = await outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: Object.freeze({ marker: 'injected' }),
      nowMs: NOW_MS + 60_000,
      idFactory: sequence('processor_id'),
      leaseOwnerFactory: sequence('processor_lease'),
      dispatch: async (input) => {
        dispatched.push(input)
        expect(input).not.toHaveProperty('payload')
        expect(JSON.stringify(input.job)).not.toContain('stf_owner_outbox')
        throw new Error(`recipient secret ${input.job.id}@example.test`)
      },
    })
    expect(dispatched).toHaveLength(10)
    expect(completed).toHaveLength(10)
    expect(dispatched.every(({ config }) => config.marker === 'injected')).toBe(true)
    const persisted = await env.DB.prepare(
      `SELECT last_error_code FROM outbox_jobs
       WHERE id LIKE 'job_processor_0%'
       ORDER BY id`
    ).all()
    expect(persisted.results.filter(
      ({ last_error_code }) => last_error_code === 'OUTBOX_HANDLER_FAILURE'
    )).toEqual(Array(10).fill({ last_error_code: 'OUTBOX_HANDLER_FAILURE' }))
    expect(JSON.stringify(persisted.results)).not.toContain('recipient secret')
    const remaining = (await env.DB.prepare(
      `SELECT id FROM outbox_jobs
       WHERE id LIKE 'job_processor_0%' AND status='queued'`
    ).all()).results
    for (const { id } of remaining) await park(id)
    await park('job_processor_10')
  })

  it('retries a fixed D1 query-budget exhaustion instead of dead-lettering the job', async () => {
    const cryptoContext = await context()
    const input = await enqueue(cryptoContext, {
      id: 'job_processor_query_budget',
      invitationId: 'inv_processor_query_budget',
      idempotencyKey: 'staff.invitation.expire:processor-query-budget',
    })

    const completed = await outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS,
      idFactory: sequence('processor_query_budget_id'),
      leaseOwnerFactory: sequence('processor_query_budget_lease'),
      limit: 1,
      claimScanLimit: 1,
      dispatch: async () => { throw new Error('D1_QUERY_BUDGET_EXCEEDED') },
    })

    expect(completed).toEqual([{ id: input.id, result: 'retry' }])
    expect(await job(input.id)).toMatchObject({
      status: 'queued',
      attempt_count: 1,
      last_error_code: 'OUTBOX_HANDLER_RETRY',
    })
    expect(await actions(input.id)).toEqual([])
    await park(input.id)
  })

  it('never dispatches an unknown type and dead-letters it with a fixed code', async () => {
    const cryptoContext = await context()
    const id = 'job_processor_unknown'
    const payloadEnvelope = JSON.stringify(await encryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: SCOPE,
        recordId: id,
        field: 'job_payload',
        plaintext: '{"actorId":"stf_owner_outbox"}',
      }
    ))
    await env.DB.prepare(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'queued',0,8,?,?,?)`
    ).bind(
      id,
      'staff.unknown',
      'staff_user',
      'stf_unknown',
      payloadEnvelope,
      'staff.unknown:processor',
      NOW,
      NOW,
      NOW,
    ).run()
    let calls = 0
    let hookCalls = 0
    await outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS,
      idFactory: sequence('processor_unknown_id'),
      leaseOwnerFactory: sequence('processor_unknown_lease'),
      beforeDispatch: async () => {
        hookCalls += 1
        throw new Error('unknown jobs do not cross the dispatch fence')
      },
      dispatch: async () => { calls += 1 },
    })
    expect(hookCalls).toBe(0)
    expect(calls).toBe(0)
    expect(await job(id)).toMatchObject({
      status: 'dead',
      last_error_code: 'OUTBOX_TYPE_INVALID',
    })
    expect(await actions(id)).toHaveLength(1)
  })

  it('returns a frozen dormant sentinel for an authoritative backup claim before decryption', async () => {
    const cryptoContext = await context()
    const malformedId = 'job_backup_direct_malformed'
    const malformedEnvelope = JSON.stringify(await encryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: SCOPE,
        recordId: malformedId,
        field: 'job_payload',
        plaintext: '{"backupId":"bkp_direct_malformed"}',
      },
    ))
    const leaseExpiry = new Date(NOW_MS + 60_000).toISOString()
    await env.DB.prepare(
      `INSERT INTO outbox_jobs
       (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
        attempt_count,max_attempts,scheduled_at,lease_owner,lease_expires_at,created_at,updated_at)
       VALUES (?,'backup.create','backup_run',?,?,
         'backup.create:2026-07-31:bkp_direct_malformed','processing',1,7,?,?,?,?,?)`
    ).bind(
      malformedId,
      'bkp_direct_malformed',
      malformedEnvelope,
      NOW,
      'lease_backup_direct_malformed',
      leaseExpiry,
      NOW,
      NOW,
    ).run()
    await env.DB.prepare(
      `INSERT INTO outbox_attempts (id,job_id,attempt_number,started_at)
       VALUES (?,?,1,?)`
    ).bind('attempt_backup_direct_malformed', malformedId, NOW).run()
    const malformed = await job(malformedId)
    const malformedResult = await dispatchOutboxJob({
      db: env.DB,
      cryptoContext: { ...cryptoContext, dataKey: Object.freeze({}) },
      config: {},
      job: {
        ...malformed,
        attemptId: 'attempt_backup_direct_malformed',
        attemptNumber: 1,
        leaseOwner: 'lease_backup_direct_malformed',
      },
      nowMs: NOW_MS,
    })
    const malformedAfter = await job(malformedId)
    await settle(malformedId)

    expect(malformedResult).toEqual({ result: 'retry' })
    expect(malformedAfter).toEqual(malformed)

    const input = await enqueueBackup(cryptoContext, {
      id: 'job_backup_direct_dispatch',
      backupId: 'bkp_direct_dispatch',
    })
    await env.DB.prepare(
      `UPDATE outbox_jobs
       SET status='processing',attempt_count=1,lease_owner=?,lease_expires_at=?,updated_at=?
       WHERE id=?`
    ).bind('lease_backup_direct', leaseExpiry, NOW, input.id).run()
    await env.DB.prepare(
      `INSERT INTO outbox_attempts (id,job_id,attempt_number,started_at)
       VALUES (?,?,1,?)`
    ).bind('attempt_backup_direct', input.id, NOW).run()
    const processing = await job(input.id)
    const claim = {
      ...processing,
      attemptId: 'attempt_backup_direct',
      attemptNumber: 1,
      leaseOwner: 'lease_backup_direct',
    }
    const beforeJob = await job(input.id)
    const beforeAttempts = await attempts(input.id)
    const beforeBackups = (await env.DB.prepare(
      'SELECT count(*) AS count FROM backup_runs'
    ).first()).count
    let providerCalls = 0

    const result = await dispatchOutboxJob({
      db: env.DB,
      cryptoContext: { ...cryptoContext, dataKey: Object.freeze({}) },
      config: {},
      job: claim,
      nowMs: NOW_MS,
      providers: {
        reconcileAccessGroup: async () => { providerCalls += 1 },
        sendInvitationEmail: async () => { providerCalls += 1 },
      },
    })
    const afterJob = await job(input.id)
    const afterAttempts = await attempts(input.id)
    const afterBackups = (await env.DB.prepare(
      'SELECT count(*) AS count FROM backup_runs'
    ).first()).count
    await settle(input.id)

    expect(result).toEqual({
      result: 'dormant',
      errorCode: 'OUTBOX_HANDLER_DORMANT',
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(providerCalls).toBe(0)
    expect(afterJob).toEqual(beforeJob)
    expect(afterAttempts).toEqual(beforeAttempts)
    expect(afterBackups).toBe(beforeBackups)
  })
})
