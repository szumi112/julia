import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { runOutboxDrain } from '../../worker/operations/outbox-drain.js'
import { enqueueOutboxStatement, processOutboxBatch } from '../../worker/jobs/outbox.js'
import { getOrCreateDataKey } from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'

const VALID_ENV = Object.freeze({
  APP_ENV: 'development',
  APP_ORIGIN: 'http://127.0.0.1:5174',
  DATA_MODE: 'fictional',
  ACCESS_AUD: 'outbox-drain-audience',
  ACCESS_HEALTH_SERVICE_TOKEN_ID: 'outbox-drain-health-token',
  ACCESS_TEAM_DOMAIN: 'https://bearwithme.cloudflareaccess.com',
  ACTIVE_DATA_KEK_VERSION: '1',
  ACTIVE_LOOKUP_KEY_VERSION: '1',
  ACTIVE_BACKUP_KEK_VERSION: '1',
  BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  BWM_BACKUP_KEK_V1: 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
})
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const NOW_MS = Date.parse('2041-01-02T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
let serial = 0

const runtimeEnv = (db = env.DB) => ({ ...env, ...VALID_ENV, DB: db })
const sequence = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

async function cryptoContext() {
  const keyring = await createKeyring(runtimeEnv(), {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: `key_outbox_drain_${++serial}`,
    createdAt: NOW,
  })
  return { keyring, dataKey, scope: SCOPE }
}

async function enqueueExpiry(context, suffix) {
  const statement = await enqueueOutboxStatement(env.DB, context, {
    id: `job_outbox_drain_${suffix}`,
    type: 'staff.invitation.expire',
    aggregateType: 'staff_invitation',
    aggregateId: `inv_outbox_drain_${suffix}`,
    payload: {
      actorId: 'stf_outbox_drain_owner',
      invitationId: `inv_outbox_drain_${suffix}`,
    },
    idempotencyKey: `staff.invitation.expire:outbox-drain-${suffix}`,
    scheduledAt: NOW,
    nowMs: NOW_MS,
  })
  await statement.run()
}

function drainDeps(context, overrides = {}) {
  return {
    now: () => NOW_MS,
    cryptoContext: context,
    processOutboxBatch,
    dispatchOutboxJob: vi.fn(async () => ({ result: 'succeeded' })),
    safeLog: vi.fn(),
    providers: Object.freeze({ marker: 'outbox-drain' }),
    idFactory: sequence(`id_outbox_drain_${serial}`),
    leaseOwnerFactory: sequence(`lease_outbox_drain_${serial}`),
    leaseNonceFactory: sequence(`nonce_outbox_drain_${serial}`),
    correlationIdFactory: sequence(`correlation_outbox_drain_${serial}`),
    ...overrides,
  }
}

function meteredDb(real) {
  let statements = 0
  const inners = new WeakMap()
  const wrap = (inner) => {
    const wrapper = {
      bind(...values) { return wrap(inner.bind(...values)) },
      run(...args) { statements += 1; return inner.run(...args) },
      first(...args) { statements += 1; return inner.first(...args) },
      all(...args) { statements += 1; return inner.all(...args) },
      raw(...args) { statements += 1; return inner.raw(...args) },
    }
    inners.set(wrapper, inner)
    return wrapper
  }
  return {
    db: {
      prepare(sql) { return wrap(real.prepare(sql)) },
      batch(items) {
        statements += items.length
        return real.batch(items.map((item) => inners.get(item) ?? item))
      },
    },
    used: () => statements,
  }
}

function heartbeatRaceDb(real, competingAt) {
  const inners = new WeakMap()
  const sqlByStatement = new WeakMap()
  const wrap = (inner, sql) => {
    const wrapper = {
      bind(...values) { return wrap(inner.bind(...values), sql) },
      run(...args) { return inner.run(...args) },
      first(...args) { return inner.first(...args) },
      all(...args) { return inner.all(...args) },
      raw(...args) { return inner.raw(...args) },
    }
    inners.set(wrapper, inner)
    sqlByStatement.set(wrapper, sql)
    return wrapper
  }
  return {
    prepare(sql) { return wrap(real.prepare(sql), sql) },
    async batch(items) {
      if (items.some((item) => sqlByStatement.get(item)?.includes(
        "WHERE key='outbox.drain.last_success' AND value_json=? AND version=?"
      ))) {
        const current = await real.prepare(
          "SELECT version FROM system_state WHERE key='outbox.drain.last_success'"
        ).first()
        await real.prepare(
          `UPDATE system_state SET value_json=?,version=version+1,updated_at=?
           WHERE key='outbox.drain.last_success' AND version=?`
        ).bind(
          JSON.stringify({ completedAt: competingAt }),
          competingAt,
          current.version,
        ).run()
      }
      return real.batch(items.map((item) => inners.get(item) ?? item))
    },
  }
}

function forgedHeartbeatDb(real, heartbeat, onBatch) {
  return {
    prepare(sql) {
      const statement = real.prepare(sql)
      if (!sql.includes("FROM system_state WHERE key='outbox.drain.last_success'")) {
        return statement
      }
      return {
        bind: (...values) => statement.bind(...values),
        run: (...args) => statement.run(...args),
        first: async () => structuredClone(heartbeat),
        all: (...args) => statement.all(...args),
        raw: (...args) => statement.raw(...args),
      }
    },
    batch(...args) {
      onBatch()
      return Promise.resolve(args.map(() => ({ success: true })))
    },
  }
}

describe('free-tier outbox drain', () => {
  it('processes only one due job and leaves the next job queued', async () => {
    const context = await cryptoContext()
    await enqueueExpiry(context, 'one')
    await enqueueExpiry(context, 'two')
    const dispatch = vi.fn(async () => ({ result: 'succeeded' }))

    await expect(runOutboxDrain({
      scheduledTime: NOW_MS,
      env: runtimeEnv(),
      deps: drainDeps(context, { dispatchOutboxJob: dispatch }),
    })).resolves.toEqual({
      status: 'succeeded',
      reason: null,
      claimedJobs: 1,
      succeededJobs: 1,
      failedJobs: 0,
    })

    const rows = (await env.DB.prepare(
      `SELECT id,status,attempt_count FROM outbox_jobs
       WHERE id LIKE 'job_outbox_drain_%' ORDER BY id`
    ).all()).results
    await env.DB.prepare(
      `UPDATE outbox_jobs SET scheduled_at='2099-01-01T00:00:00.000Z'
       WHERE id='job_outbox_drain_two' AND status='queued'`
    ).run()

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(rows).toEqual([
      { id: 'job_outbox_drain_one', status: 'succeeded', attempt_count: 1 },
      { id: 'job_outbox_drain_two', status: 'queued', attempt_count: 0 },
    ])
  })

  it('returns a fixed empty success without provider work when no job is due', async () => {
    const context = await cryptoContext()
    const dispatch = vi.fn()

    await expect(runOutboxDrain({
      scheduledTime: NOW_MS,
      env: runtimeEnv(),
      deps: drainDeps(context, { dispatchOutboxJob: dispatch }),
    })).resolves.toEqual({
      status: 'succeeded',
      reason: null,
      claimedJobs: 0,
      succeededJobs: 0,
      failedJobs: 0,
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(await env.DB.prepare(
      "SELECT value_json,version,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
    ).first()).toMatchObject({
      value_json: JSON.stringify({ completedAt: NOW }),
      updated_at: NOW,
    })
  })

  it('records a failed attempt without replacing the last successful completion', async () => {
    const context = await cryptoContext()
    const laterMs = NOW_MS + 60_000
    const later = new Date(laterMs).toISOString()
    await runOutboxDrain({
      scheduledTime: NOW_MS,
      env: runtimeEnv(),
      deps: drainDeps(context),
    })
    const successful = await env.DB.prepare(
      "SELECT value_json,version,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
    ).first()

    await expect(runOutboxDrain({
      scheduledTime: laterMs,
      env: runtimeEnv(),
      deps: drainDeps(context, {
        now: () => laterMs,
        processOutboxBatch: async () => { throw new Error('private drain failure') },
      }),
    })).resolves.toEqual({
      status: 'failed',
      reason: 'drain_failed',
      claimedJobs: 0,
      succeededJobs: 0,
      failedJobs: 0,
    })

    expect(await env.DB.prepare(
      "SELECT value_json,version,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
    ).first()).toEqual({
      value_json: JSON.stringify({ completedAt: NOW }),
      version: successful.version + 1,
      updated_at: later,
    })
  })

  it('keeps heartbeat timestamps monotonic for a delayed successful invocation', async () => {
    const context = await cryptoContext()
    const newerMs = NOW_MS + 300_000
    const olderMs = NOW_MS + 240_000
    const newer = new Date(newerMs).toISOString()
    await runOutboxDrain({
      scheduledTime: newerMs,
      env: runtimeEnv(),
      deps: drainDeps(context, { now: () => newerMs }),
    })
    const before = await env.DB.prepare(
      "SELECT value_json,version,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
    ).first()

    await expect(runOutboxDrain({
      scheduledTime: olderMs,
      env: runtimeEnv(),
      deps: drainDeps(context, { now: () => olderMs }),
    })).resolves.toMatchObject({ status: 'succeeded' })

    expect(await env.DB.prepare(
      "SELECT value_json,version,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
    ).first()).toEqual({
      value_json: JSON.stringify({ completedAt: newer }),
      version: before.version + 1,
      updated_at: newer,
    })
  })

  it('fails closed without overwriting a competing heartbeat fence', async () => {
    const context = await cryptoContext()
    const competingAt = new Date(NOW_MS + 600_000).toISOString()
    const db = heartbeatRaceDb(env.DB, competingAt)

    await expect(runOutboxDrain({
      scheduledTime: NOW_MS + 540_000,
      env: runtimeEnv(db),
      deps: drainDeps(context, { now: () => NOW_MS + 540_000 }),
    })).rejects.toThrow(/^OUTBOX_DRAIN_HEARTBEAT_FAILED$/)

    expect(await env.DB.prepare(
      "SELECT value_json,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
    ).first()).toEqual({
      value_json: JSON.stringify({ completedAt: competingAt }),
      updated_at: competingAt,
    })
  })

  it('rejects an impossible version-one successful heartbeat without mutation', async () => {
    const context = await cryptoContext()
    const before = await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
    ).first()
    let batchCalls = 0
    const db = forgedHeartbeatDb(env.DB, {
      ...before,
      value_json: JSON.stringify({ completedAt: NOW }),
      version: 1,
      updated_at: NOW,
    }, () => { batchCalls += 1 })

    await expect(runOutboxDrain({
      scheduledTime: NOW_MS,
      env: runtimeEnv(db),
      deps: drainDeps(context),
    })).rejects.toThrow(/^OUTBOX_DRAIN_HEARTBEAT_FAILED$/)

    expect(await env.DB.prepare(
      "SELECT key,value_json,version,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
    ).first()).toEqual(before)
    expect(batchCalls).toBe(0)
  })

  it('stops before statement 51 and reports only a fixed failure', async () => {
    const context = await cryptoContext()
    const budgetMs = NOW_MS + 660_000
    const budgetAt = new Date(budgetMs).toISOString()
    const meter = meteredDb(env.DB)
    const before = await env.DB.prepare(
      "SELECT value_json,version FROM system_state WHERE key='outbox.drain.last_success'"
    ).first()
    const process = vi.fn(async ({ db }) => {
      for (let index = 0; index < 51; index += 1) {
        await db.prepare('SELECT 1').first()
      }
      return []
    })

    await expect(runOutboxDrain({
      scheduledTime: budgetMs,
      env: runtimeEnv(meter.db),
      deps: drainDeps(context, { now: () => budgetMs, processOutboxBatch: process }),
    })).resolves.toEqual({
      status: 'failed',
      reason: 'drain_failed',
      claimedJobs: 0,
      succeededJobs: 0,
      failedJobs: 0,
    })

    expect(meter.used()).toBe(50)
    expect(await env.DB.prepare(
      "SELECT value_json,version,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
    ).first()).toEqual({
      value_json: before.value_json,
      version: before.version + 1,
      updated_at: budgetAt,
    })
  })

  it('rejects malformed invocation state before touching D1', async () => {
    let prepares = 0
    const db = {
      prepare() { prepares += 1; throw new Error('D1_REACHED') },
      batch() { throw new Error('D1_REACHED') },
    }

    await expect(runOutboxDrain({
      scheduledTime: -1,
      env: runtimeEnv(db),
    })).rejects.toThrow(/^OUTBOX_DRAIN_INVALID$/)
    expect(prepares).toBe(0)
  })
})
