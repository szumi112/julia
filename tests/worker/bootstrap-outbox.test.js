import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import * as handlers from '../../worker/jobs/handlers.js'
import * as outbox from '../../worker/jobs/outbox.js'
import {
  blindEmailIndex,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { NOW_MS } from './fixtures.js'

const NOW = new Date(NOW_MS).toISOString()
const SCOPE = Object.freeze({
  id: 'centre_1',
  purpose: 'identity',
  type: 'staff_directory',
})

const sequence = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

const correlationSequence = () => {
  let count = 0
  return () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`
}

async function context() {
  const keyring = await createKeyring(env, {
    activeBackupKekVersion: 1,
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    createdAt: NOW,
    id: 'key_bootstrap_outbox',
  })
  return { dataKey, keyring, scope: SCOPE }
}

async function encryptedField(cryptoContext, recordId, field, plaintext) {
  return JSON.stringify(await encryptForScope(
    cryptoContext.keyring,
    cryptoContext.dataKey,
    {
      expectedScope: cryptoContext.scope,
      field,
      plaintext,
      recordId,
    },
  ))
}

async function seedActiveOwner(cryptoContext, suffix) {
  const id = `stf_bootstrap_${suffix}`
  const email = `${suffix}@example.test`
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,NULL,1,?,NULL,?,?)`
  ).bind(
    id,
    await blindEmailIndex(email, cryptoContext.keyring),
    await encryptedField(cryptoContext, id, 'email', email),
    await encryptedField(cryptoContext, id, 'display_name', 'Bootstrap Owner'),
    'owner',
    `local:${email}`,
    NOW,
    NOW,
    NOW,
  ).run()
  return { email, id }
}

async function advanceDesiredGeneration() {
  const current = await env.DB.prepare(
    "SELECT value_json,version FROM system_state WHERE key='access.desired_generation'"
  ).first()
  const generation = JSON.parse(current.value_json).generation + 1
  await env.DB.prepare(
    `UPDATE system_state
     SET value_json=?,version=version+1,updated_at=?
     WHERE key='access.desired_generation' AND version=?`
  ).bind(JSON.stringify({ generation }), NOW, current.version).run()
  return generation
}

async function enqueue(cryptoContext, input) {
  const statement = await outbox.enqueueOutboxStatement(env.DB, cryptoContext, {
    maxAttempts: 8,
    nowMs: NOW_MS,
    ...input,
  })
  await statement.run()
}

async function seedTarget({
  payloadGenerationDelta = 0,
  suffix = 'one',
  withEarlierEmail = true,
} = {}) {
  const cryptoContext = await context()
  const actor = await seedActiveOwner(cryptoContext, suffix)
  const generation = await advanceDesiredGeneration()
  if (withEarlierEmail) {
    await enqueue(cryptoContext, {
      aggregateId: `inv_bootstrap_${suffix}`,
      aggregateType: 'staff_invitation',
      id: `job_email_${suffix}`,
      idempotencyKey: `staff.invitation.email:inv_bootstrap_${suffix}:2`,
      payload: {
        actorId: actor.id,
        invitationId: `inv_bootstrap_${suffix}`,
      },
      scheduledAt: new Date(NOW_MS - 1).toISOString(),
      type: 'staff.invitation.email',
    })
  }
  const jobId = `job_reconcile_${suffix}`
  await enqueue(cryptoContext, {
    aggregateId: 'centre_1',
    aggregateType: 'access_group',
    id: jobId,
    idempotencyKey: `staff.access.reconcile:${generation}`,
    payload: {
      actorId: actor.id,
      generation: generation + payloadGenerationDelta,
    },
    scheduledAt: NOW,
    type: 'staff.access.reconcile',
  })
  return { actor, cryptoContext, generation, jobId }
}

const outboxRow = (jobId) => env.DB.prepare(
  'SELECT * FROM outbox_jobs WHERE id=?'
).bind(jobId).first()

const attemptRows = async (jobId) => (await env.DB.prepare(
  'SELECT * FROM outbox_attempts WHERE job_id=? ORDER BY attempt_number,id'
).bind(jobId).all()).results

const processInput = ({ cryptoContext, jobId, provider, nowMs = NOW_MS }) => ({
  correlationIdFactory: correlationSequence(),
  cryptoContext,
  db: env.DB,
  dispatch: (input) => handlers.dispatchOutboxJob({
    ...input,
    providers: { reconcileAccessGroup: provider },
  }),
  idFactory: sequence(`id_${jobId}`),
  jobId,
  leaseNonceFactory: sequence(`nonce_${jobId}`),
  leaseOwnerFactory: sequence(`lease_${jobId}`),
  nowFactory: () => nowMs + 1,
  nowMs,
})

describe('target-only Access outbox processing', () => {
  it('claims and completes only the supplied reconcile job even when an email is earlier', async () => {
    const fixture = await seedTarget({ suffix: 'isolation' })
    const provider = vi.fn(async () => ({ reconciled: true }))
    const result = await outbox.processOutboxJobById(processInput({
      ...fixture,
      provider,
    }))

    expect(result).toEqual({
      jobId: fixture.jobId,
      result: 'succeeded',
    })
    expect(provider).toHaveBeenCalledOnce()
    expect(await env.DB.prepare(
      'SELECT status,attempt_count FROM outbox_jobs WHERE id=?'
    ).bind(fixture.jobId).first()).toEqual({
      attempt_count: 1,
      status: 'succeeded',
    })
    expect(await env.DB.prepare(
      "SELECT status,attempt_count FROM outbox_jobs WHERE id='job_email_isolation'"
    ).first()).toEqual({
      attempt_count: 0,
      status: 'queued',
    })
  })

  it('rejects a non-reconcile target before claim, decrypt, or dispatch', async () => {
    const fixture = await seedTarget({ suffix: 'wrong_type' })
    const dispatch = vi.fn()
    const before = await env.DB.prepare(
      "SELECT * FROM outbox_jobs WHERE id='job_email_wrong_type'"
    ).first()
    await expect(outbox.processOutboxJobById({
      ...processInput({
        ...fixture,
        provider: vi.fn(),
      }),
      dispatch,
      jobId: 'job_email_wrong_type',
    })).rejects.toThrow(/^OUTBOX_TARGET_INVALID$/)
    expect(dispatch).not.toHaveBeenCalled()
    expect(await env.DB.prepare(
      "SELECT * FROM outbox_jobs WHERE id='job_email_wrong_type'"
    ).first()).toEqual(before)
  })

  it('does not reclaim a live owner and never touches another expired job', async () => {
    const fixture = await seedTarget({ suffix: 'live' })
    const expiry = new Date(NOW_MS + 60_000).toISOString()
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE outbox_jobs
         SET status='processing',attempt_count=1,lease_owner='existing_owner',
             lease_expires_at=?,updated_at=?
         WHERE id=?`
      ).bind(expiry, NOW, fixture.jobId),
      env.DB.prepare(
        `INSERT INTO outbox_attempts
         (id,job_id,attempt_number,started_at)
         VALUES ('attempt_live',?,1,?)`
      ).bind(fixture.jobId, NOW),
      env.DB.prepare(
        `UPDATE outbox_jobs
         SET status='processing',attempt_count=1,lease_owner='email_owner',
             lease_expires_at=?,updated_at=?
         WHERE id='job_email_live'`
      ).bind(new Date(NOW_MS - 1).toISOString(), NOW),
      env.DB.prepare(
        `INSERT INTO outbox_attempts
         (id,job_id,attempt_number,started_at)
         VALUES ('attempt_email_live','job_email_live',1,?)`
      ).bind(NOW),
    ])
    const provider = vi.fn()
    expect(await outbox.processOutboxJobById(processInput({
      ...fixture,
      provider,
    }))).toEqual({
      jobId: fixture.jobId,
      result: 'busy',
    })
    expect(provider).not.toHaveBeenCalled()
    expect(await env.DB.prepare(
      "SELECT status,attempt_count,lease_owner FROM outbox_jobs WHERE id='job_email_live'"
    ).first()).toEqual({
      attempt_count: 1,
      lease_owner: 'email_owner',
      status: 'processing',
    })
  })

  it('reaps only an expired target attempt, claims with a new fence, and succeeds', async () => {
    const fixture = await seedTarget({ suffix: 'expired' })
    const expiredAt = new Date(NOW_MS + 60_000).toISOString()
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE outbox_jobs
         SET status='processing',attempt_count=1,lease_owner='expired_owner',
             lease_expires_at=?,updated_at=?
         WHERE id=?`
      ).bind(expiredAt, NOW, fixture.jobId),
      env.DB.prepare(
        `INSERT INTO outbox_attempts
         (id,job_id,attempt_number,started_at)
         VALUES ('attempt_expired',?,1,?)`
      ).bind(fixture.jobId, NOW),
    ])
    const provider = vi.fn(async () => ({ reconciled: true }))
    expect(await outbox.processOutboxJobById(processInput({
      ...fixture,
      nowMs: NOW_MS + 60_001,
      provider,
    }))).toEqual({
      jobId: fixture.jobId,
      result: 'succeeded',
    })
    expect(provider).toHaveBeenCalledOnce()
    expect((await env.DB.prepare(
      'SELECT attempt_number,result,error_code FROM outbox_attempts WHERE job_id=? ORDER BY attempt_number'
    ).bind(fixture.jobId).all()).results).toEqual([
      {
        attempt_number: 1,
        error_code: 'OUTBOX_LEASE_EXPIRED',
        result: 'retry',
      },
      {
        attempt_number: 2,
        error_code: null,
        result: 'succeeded',
      },
    ])
  })

  it('leaves a retryable provider failure resumable and succeeds on the same job later', async () => {
    const fixture = await seedTarget({ suffix: 'retry', withEarlierEmail: false })
    let calls = 0
    const provider = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        const error = new Error('fixed')
        error.retryable = true
        throw error
      }
      return { reconciled: true }
    })
    const processing = processInput({
      ...fixture,
      provider,
    })
    expect(await outbox.processOutboxJobById(processing)).toEqual({
      jobId: fixture.jobId,
      result: 'retry',
    })
    expect(await env.DB.prepare(
      'SELECT status,attempt_count,last_error_code FROM outbox_jobs WHERE id=?'
    ).bind(fixture.jobId).first()).toEqual({
      attempt_count: 1,
      last_error_code: 'OUTBOX_HANDLER_RETRY',
      status: 'queued',
    })
    expect(await outbox.processOutboxJobById({
      ...processing,
      nowMs: NOW_MS + 60_001,
      nowFactory: () => NOW_MS + 60_002,
    })).toEqual({
      jobId: fixture.jobId,
      result: 'succeeded',
    })
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('refuses a decrypted payload whose generation differs from its idempotency key', async () => {
    const fixture = await seedTarget({
      payloadGenerationDelta: 1,
      suffix: 'payload_mismatch',
      withEarlierEmail: false,
    })
    const dispatch = vi.fn()
    const before = await outboxRow(fixture.jobId)
    await expect(outbox.processOutboxJobById({
      ...processInput({
        ...fixture,
        provider: vi.fn(),
      }),
      dispatch,
    })).rejects.toThrow(/^OUTBOX_TARGET_INVALID$/)
    expect(dispatch).not.toHaveBeenCalled()
    expect(await outboxRow(fixture.jobId)).toEqual(before)
    expect(await attemptRows(fixture.jobId)).toEqual([])
  })

  it('refuses queued retry histories with a gap before claim or dispatch', async () => {
    const fixture = await seedTarget({
      suffix: 'history_gap',
      withEarlierEmail: false,
    })
    const completed = new Date(NOW_MS - 120_000).toISOString()
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE outbox_jobs
         SET attempt_count=2,last_error_code='OUTBOX_HANDLER_RETRY',
             scheduled_at=?,updated_at=?
         WHERE id=?`
      ).bind(new Date(NOW_MS - 60_000).toISOString(), completed, fixture.jobId),
      env.DB.prepare(
        `INSERT INTO outbox_attempts
         (id,job_id,attempt_number,started_at,completed_at,result,error_code)
         VALUES ('attempt_history_gap',?,2,?,?,'retry','OUTBOX_HANDLER_RETRY')`
      ).bind(
        fixture.jobId,
        new Date(NOW_MS - 180_000).toISOString(),
        completed,
      ),
    ])
    const dispatch = vi.fn()
    const before = await outboxRow(fixture.jobId)
    await expect(outbox.processOutboxJobById({
      ...processInput({
        ...fixture,
        provider: vi.fn(),
      }),
      dispatch,
    })).rejects.toThrow(/^OUTBOX_TARGET_INVALID$/)
    expect(dispatch).not.toHaveBeenCalled()
    expect(await outboxRow(fixture.jobId)).toEqual(before)
    expect(await attemptRows(fixture.jobId)).toHaveLength(1)
  })

  it('refuses forged terminal jobs and malformed live attempt evidence', async () => {
    const succeeded = await seedTarget({
      suffix: 'forged_succeeded',
      withEarlierEmail: false,
    })
    await env.DB.prepare(
      `UPDATE outbox_jobs
       SET status='processing',attempt_count=1,lease_owner='forged_owner',
           lease_expires_at=?,updated_at=?
       WHERE id=?`
    ).bind(new Date(NOW_MS + 60_000).toISOString(), NOW, succeeded.jobId).run()
    await env.DB.prepare(
      `UPDATE outbox_jobs
       SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
       WHERE id=?`
    ).bind(NOW, succeeded.jobId).run()

    const dead = await seedTarget({
      suffix: 'forged_dead',
      withEarlierEmail: false,
    })
    await env.DB.prepare(
      `UPDATE outbox_jobs
       SET status='dead',last_error_code='OUTBOX_HANDLER_FAILURE',updated_at=?
       WHERE id=?`
    ).bind(NOW, dead.jobId).run()

    const malformedLive = await seedTarget({
      suffix: 'malformed_live',
      withEarlierEmail: false,
    })
    await env.DB.prepare(
      `UPDATE outbox_jobs
       SET status='processing',attempt_count=1,lease_owner='live_without_attempt',
           lease_expires_at=?,updated_at=?
       WHERE id=?`
    ).bind(
      new Date(NOW_MS + 60_000).toISOString(),
      NOW,
      malformedLive.jobId,
    ).run()

    for (const fixture of [succeeded, dead, malformedLive]) {
      const dispatch = vi.fn()
      const before = await outboxRow(fixture.jobId)
      await expect(outbox.processOutboxJobById({
        ...processInput({
          ...fixture,
          provider: vi.fn(),
        }),
        dispatch,
      })).rejects.toThrow(/^OUTBOX_TARGET_INVALID$/)
      expect(dispatch).not.toHaveBeenCalled()
      expect(await outboxRow(fixture.jobId)).toEqual(before)
    }
  })

  it('refuses exhausted and attempt-eight resume states without touching unrelated rows', async () => {
    const exhausted = await seedTarget({ suffix: 'exhausted' })
    const attempts = []
    for (let number = 1; number <= 8; number += 1) {
      const startedAt = new Date(NOW_MS - ((10 - number) * 60_000)).toISOString()
      const completedAt = new Date(NOW_MS - ((9 - number) * 60_000)).toISOString()
      attempts.push(env.DB.prepare(
        `INSERT INTO outbox_attempts
         (id,job_id,attempt_number,started_at,completed_at,result,error_code)
         VALUES (?,?,?, ?,?,'retry','OUTBOX_HANDLER_RETRY')`
      ).bind(
        `attempt_exhausted_${number}`,
        exhausted.jobId,
        number,
        startedAt,
        completedAt,
      ))
    }
    await env.DB.batch([
      ...attempts,
      env.DB.prepare(
        `UPDATE outbox_jobs
         SET attempt_count=8,last_error_code='OUTBOX_HANDLER_RETRY',
             scheduled_at=?,updated_at=?
         WHERE id=?`
      ).bind(NOW, NOW, exhausted.jobId),
    ])
    const unrelatedBefore = await outboxRow('job_email_exhausted')
    const dispatch = vi.fn()
    await expect(outbox.processOutboxJobById({
      ...processInput({
        ...exhausted,
        provider: vi.fn(),
      }),
      dispatch,
    })).rejects.toThrow(/^OUTBOX_TARGET_INVALID$/)
    expect(dispatch).not.toHaveBeenCalled()
    expect(await outboxRow('job_email_exhausted')).toEqual(unrelatedBefore)
    expect(await attemptRows('job_email_exhausted')).toEqual([])
  })

  it('keeps a real Access adapter final-GET mismatch queued without publication', async () => {
    const fixture = await seedTarget({
      suffix: 'verification_mismatch',
      withEarlierEmail: false,
    })
    const bindings = {
      CF_ACCESS_GROUP_ID: '11111111-1111-4111-8111-111111111111',
      CF_ACCESS_GROUP_NAME: 'Bear with me Staff',
      CF_ACCESS_GROUP_TOKEN: 'provider-secret',
      CF_ACCOUNT_ID: 'a'.repeat(32),
    }
    const group = (include = []) => ({
      result: {
        exclude: [],
        id: bindings.CF_ACCESS_GROUP_ID,
        include,
        name: bindings.CF_ACCESS_GROUP_NAME,
        require: [],
      },
      success: true,
    })
    const methods = []
    const providerResponse = (url) => {
      const response = Response.json(group())
      Object.defineProperty(response, 'url', { value: url })
      return response
    }
    const fetch = vi.fn(async (url, request) => {
      methods.push(request.method)
      expect(request.redirect).toBe('manual')
      return providerResponse(url)
    })
    const dispatch = (input) => handlers.dispatchOutboxJob({
      ...input,
      providers: { fetch },
    })
    const result = await outbox.processOutboxJobById({
      ...processInput({
        ...fixture,
        provider: vi.fn(),
      }),
      bindings,
      config: { appEnv: 'staging' },
      dispatch,
    })

    expect(result).toEqual({
      jobId: fixture.jobId,
      result: 'retry',
    })
    expect(methods).toEqual(['GET', 'PUT', 'GET'])
    expect(await env.DB.prepare(
      'SELECT status,attempt_count,last_error_code FROM outbox_jobs WHERE id=?'
    ).bind(fixture.jobId).first()).toEqual({
      attempt_count: 1,
      last_error_code: 'OUTBOX_HANDLER_RETRY',
      status: 'queued',
    })
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json).generation).toBeLessThan(fixture.generation)
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='staff.access.reconciled' AND actor_staff_id=?`
    ).bind(fixture.actor.id).first()).toEqual({ count: 0 })
  })
})
