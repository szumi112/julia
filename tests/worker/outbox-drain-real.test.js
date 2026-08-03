import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { runOutboxDrain } from '../../worker/operations/outbox-drain.js'
import { enqueueOutboxStatement } from '../../worker/jobs/outbox.js'
import {
  blindEmailIndex,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'

const VALID_ENV = Object.freeze({
  APP_ENV: 'development',
  APP_ORIGIN: 'http://127.0.0.1:5174',
  DATA_MODE: 'fictional',
  ACCESS_AUD: 'outbox-drain-real-audience',
  ACCESS_HEALTH_SERVICE_TOKEN_ID: 'outbox-drain-real-health-token',
  ACCESS_TEAM_DOMAIN: 'https://bearwithme.cloudflareaccess.com',
  ACTIVE_DATA_KEK_VERSION: '1',
  ACTIVE_LOOKUP_KEY_VERSION: '1',
  ACTIVE_BACKUP_KEK_VERSION: '1',
  BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  BWM_BACKUP_KEK_V1: 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
})
const SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})
const EMPTY_FINGERPRINT = 'BYDlKyUUBNO-3cX7_bRPY-TkArudTPGjIdbwtAdLSCw'
const NOW_MS = Date.parse('2042-04-05T09:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const EMAIL_NOW_MS = NOW_MS + 86_400_000
const EMAIL_NOW = new Date(EMAIL_NOW_MS).toISOString()
const EXPIRY_NOW_MS = NOW_MS + 2 * 86_400_000
const EXPIRY_NOW = new Date(EXPIRY_NOW_MS).toISOString()
const FUTURE = new Date(NOW_MS + 30 * 86_400_000).toISOString()
const EMAIL_PROVIDER_ID = '55555555-5555-4555-8555-555555555555'

const runtimeEnv = (db = env.DB) => ({ ...env, ...VALID_ENV, DB: db })
const sequence = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}
const correlationSequence = () => {
  let count = 0
  return () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`
}

function meteredDb(real) {
  let statements = 0
  let maxBindings = 0
  const inners = new WeakMap()
  const wrap = (inner) => ({
    bind(...values) {
      maxBindings = Math.max(maxBindings, values.length)
      if (values.length > 100) throw new Error('TEST_D1_BIND_LIMIT_EXCEEDED')
      return wrapped(inner.bind(...values))
    },
    run(...args) { statements += 1; return inner.run(...args) },
    first(...args) { statements += 1; return inner.first(...args) },
    all(...args) { statements += 1; return inner.all(...args) },
    raw(...args) { statements += 1; return inner.raw(...args) },
  })
  const wrapped = (inner) => {
    const statement = wrap(inner)
    inners.set(statement, inner)
    return statement
  }
  return {
    db: {
      prepare(sql) { return wrapped(real.prepare(sql)) },
      batch(items) {
        statements += items.length
        return real.batch(items.map((item) => inners.get(item) ?? item))
      },
    },
    usage: () => ({ maxBindings, statements }),
  }
}

async function cryptoContext() {
  const keyring = await createKeyring(runtimeEnv(), {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_outbox_drain_real',
    createdAt: NOW,
  })
  return { keyring, dataKey, scope: SCOPE }
}

async function encryptedField(context, recordId, field, plaintext) {
  return JSON.stringify(await encryptForScope(
    context.keyring,
    context.dataKey,
    {
      expectedScope: context.scope,
      recordId,
      field,
      plaintext,
    },
  ))
}

async function seedStaff(context, {
  id,
  email,
  role = 'coordinator',
  status = 'pending',
}) {
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`
  ).bind(
    id,
    await blindEmailIndex(email, context.keyring),
    await encryptedField(context, id, 'email', email),
    await encryptedField(context, id, 'display_name', `Test ${id}`),
    role,
    status,
    status === 'active' ? `subject_${id}` : null,
    role === 'specialist' ? `sp_${id.slice(4)}` : null,
    status === 'active' ? NOW : null,
    status === 'disabled' ? NOW : null,
    NOW,
    NOW,
  ).run()
}

async function seedInvitation(context, {
  id,
  staffId,
  inviterId,
  email,
  status = 'provisioning',
  expiresAt = FUTURE,
  accessAllowedAt = status === 'pending' ? NOW : null,
}) {
  await env.DB.prepare(
    `INSERT INTO staff_invitations
     (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,inviter_id,
      expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,version,created_at,
      updated_at)
     VALUES (?,?,?,?,?,'coordinator',?,?,?,?,NULL,NULL,NULL,1,?,?)`
  ).bind(
    id,
    staffId,
    await blindEmailIndex(email, context.keyring),
    await encryptedField(context, id, 'email', email),
    await encryptedField(context, id, 'display_name', `Test ${id}`),
    status,
    inviterId,
    expiresAt,
    accessAllowedAt,
    NOW,
    NOW,
  ).run()
}

async function setState(key, value) {
  await env.DB.prepare(
    'UPDATE system_state SET value_json=?,version=version+1,updated_at=? WHERE key=?'
  ).bind(JSON.stringify(value), NOW, key).run()
}

async function seedAccessFixture() {
  const context = await cryptoContext()
  const ownerId = 'stf_drain_real_owner'
  await seedStaff(context, {
    id: ownerId,
    email: 'drain-real-owner@example.test',
    role: 'owner',
    status: 'active',
  })
  const invitationIds = []
  for (let index = 1; index <= 5; index += 1) {
    const suffix = String(index).padStart(2, '0')
    const staffId = `stf_drain_real_${suffix}`
    const invitationId = `inv_drain_real_${suffix}`
    const email = `drain-real-${suffix}@example.test`
    await seedStaff(context, { id: staffId, email })
    await seedInvitation(context, { id: invitationId, staffId, inviterId: ownerId, email })
    invitationIds.push(invitationId)
  }
  await setState('access.desired_generation', { generation: 1 })
  await setState('access.applied_generation', {
    fingerprint: EMPTY_FINGERPRINT,
    generation: 0,
  })
  await setState('access.reconcile.lease', {
    expiresAt: null,
    nonce: null,
    owner: null,
  })
  const accessJobId = 'job_drain_real_access'
  const job = await enqueueOutboxStatement(env.DB, context, {
    id: accessJobId,
    type: 'staff.access.reconcile',
    aggregateType: 'access_group',
    aggregateId: 'centre_1',
    payload: { actorId: ownerId, generation: 1 },
    idempotencyKey: 'staff.access.reconcile:1',
    scheduledAt: NOW,
    nowMs: NOW_MS,
  })
  await job.run()
  return { context, invitationIds }
}

function retryableEmailFailure() {
  return Object.assign(new Error('rate limited'), {
    ambiguous: false,
    code: 'EMAIL_PROVIDER_RATE_LIMITED',
    retryable: true,
  })
}

describe('real-handler free-tier outbox drain', () => {
  it('converges five provisioning invitations without exceeding 50 D1 statements per minute', async () => {
    const fixture = await seedAccessFixture()
    const reconcileAccessGroup = vi.fn(async ({ emails }) => ({ emails }))
    const sendInvitationEmail = vi.fn(async () => { throw retryableEmailFailure() })
    const ids = sequence('drain_real_id')
    const leaseOwners = sequence('drain_real_owner')
    const leaseNonces = sequence('drain_real_nonce')
    const correlations = correlationSequence()
    const usages = []
    const results = []

    for (let minute = 0; minute < 20; minute += 1) {
      const invocationMs = NOW_MS + minute * 60_000
      const meter = meteredDb(env.DB)
      results.push(await runOutboxDrain({
        scheduledTime: invocationMs,
        env: runtimeEnv(meter.db),
        deps: {
          now: () => invocationMs,
          safeLog: vi.fn(),
          providers: { reconcileAccessGroup, sendInvitationEmail },
          idFactory: ids,
          leaseOwnerFactory: leaseOwners,
          leaseNonceFactory: leaseNonces,
          correlationIdFactory: correlations,
        },
      }))
      usages.push(meter.usage())
      const convergence = await env.DB.prepare(
        `SELECT
           (SELECT count(*) FROM staff_invitations
            WHERE id LIKE 'inv_drain_real_%' AND status='provisioning') AS provisioning,
           (SELECT count(*) FROM outbox_jobs
            WHERE type='staff.access.reconcile' AND status IN ('queued','processing')) AS active_jobs`
      ).first()
      if (convergence.provisioning === 0 && convergence.active_jobs === 0) break
    }

    const placeholders = fixture.invitationIds.map(() => '?').join(',')
    const [accessJobs, invitations, emailJobs, applied, desired, deadActions, heartbeat] = await Promise.all([
      env.DB.prepare(
        `SELECT id,status FROM outbox_jobs
         WHERE type='staff.access.reconcile' AND created_at<? ORDER BY created_at,id`
      ).bind(EMAIL_NOW).all(),
      env.DB.prepare(
        `SELECT id,status,version FROM staff_invitations
         WHERE id IN (${placeholders}) ORDER BY id`
      ).bind(...fixture.invitationIds).all(),
      env.DB.prepare(
        `SELECT aggregate_id,status FROM outbox_jobs
         WHERE type='staff.invitation.email' AND aggregate_id IN (${placeholders})
         ORDER BY aggregate_id`
      ).bind(...fixture.invitationIds).all(),
      env.DB.prepare("SELECT value_json FROM system_state WHERE key='access.applied_generation'")
        .first(),
      env.DB.prepare("SELECT value_json FROM system_state WHERE key='access.desired_generation'")
        .first(),
      env.DB.prepare(
        `SELECT count(*) AS count FROM operational_actions
         WHERE entity_type='outbox_job' AND status='open'
           AND entity_id IN (
             SELECT id FROM outbox_jobs
             WHERE type='staff.access.reconcile' AND created_at<?
           )`
      ).bind(EMAIL_NOW).first(),
      env.DB.prepare(
        "SELECT value_json,version,updated_at FROM system_state WHERE key='outbox.drain.last_success'"
      ).first(),
    ])
    await env.DB.prepare(
      `UPDATE outbox_jobs SET scheduled_at='2099-01-01T00:00:00.000Z'
       WHERE type='staff.invitation.email' AND aggregate_id LIKE 'inv_drain_real_%'
         AND status='queued'`
    ).run()

    expect(results.length).toBeGreaterThan(1)
    expect(results.every((result) => result.status === 'succeeded')).toBe(true)
    expect(Math.max(...usages.map(({ statements }) => statements))).toBe(49)
    expect(Math.max(...usages.map(({ maxBindings }) => maxBindings))).toBe(45)
    expect(accessJobs.results.length).toBeGreaterThan(1)
    expect(accessJobs.results.every((job) => job.status === 'succeeded')).toBe(true)
    expect(invitations.results).toEqual(fixture.invitationIds.map((id) => ({
      id,
      status: 'pending',
      version: 2,
    })))
    expect(emailJobs.results).toEqual(fixture.invitationIds.map((aggregateId) => ({
      aggregate_id: aggregateId,
      status: 'queued',
    })))
    expect(JSON.parse(applied.value_json).generation).toBe(JSON.parse(desired.value_json).generation)
    expect(deadActions.count).toBe(0)
    const lastInvocation = new Date(NOW_MS + (results.length - 1) * 60_000).toISOString()
    expect(heartbeat).toEqual({
      value_json: JSON.stringify({ completedAt: lastInvocation }),
      version: results.length + 1,
      updated_at: lastInvocation,
    })
    expect(reconcileAccessGroup).toHaveBeenCalledTimes(1)
  })

  it('finalizes an accepted invitation email inside one free-tier invocation', async () => {
    const context = await cryptoContext()
    const ownerId = 'stf_drain_email_owner'
    const staffId = 'stf_drain_email_target'
    const invitationId = 'inv_drain_email_target'
    const jobId = 'job_drain_email_target'
    const email = 'drain-email-target@example.test'
    await seedStaff(context, {
      id: ownerId,
      email: 'drain-email-owner@example.test',
      role: 'owner',
      status: 'active',
    })
    await seedStaff(context, { id: staffId, email })
    await seedInvitation(context, {
      id: invitationId,
      staffId,
      inviterId: ownerId,
      email,
      status: 'pending',
    })
    const job = await enqueueOutboxStatement(env.DB, context, {
      id: jobId,
      type: 'staff.invitation.email',
      aggregateType: 'staff_invitation',
      aggregateId: invitationId,
      payload: { actorId: ownerId, invitationId },
      idempotencyKey: `staff.invitation.email:${invitationId}:1`,
      scheduledAt: EMAIL_NOW,
      nowMs: EMAIL_NOW_MS,
    })
    await job.run()
    const sendInvitationEmail = vi.fn(async () => ({ providerId: EMAIL_PROVIDER_ID }))
    const meter = meteredDb(env.DB)

    const result = await runOutboxDrain({
      scheduledTime: EMAIL_NOW_MS,
      env: runtimeEnv(meter.db),
      deps: {
        now: () => EMAIL_NOW_MS,
        safeLog: vi.fn(),
        providers: { sendInvitationEmail },
        idFactory: sequence('drain_email_id'),
        leaseOwnerFactory: sequence('drain_email_owner'),
        leaseNonceFactory: sequence('drain_email_nonce'),
        correlationIdFactory: correlationSequence(),
      },
    })
    const [invitation, completedJob, delivery] = await Promise.all([
      env.DB.prepare('SELECT status,email_sent_at,version FROM staff_invitations WHERE id=?')
        .bind(invitationId).first(),
      env.DB.prepare('SELECT status FROM outbox_jobs WHERE id=?').bind(jobId).first(),
      env.DB.prepare(
        `SELECT provider,provider_reference,status FROM delivery_attempts
         WHERE outbox_job_id=?`
      ).bind(jobId).first(),
    ])

    expect(result).toEqual({
      status: 'succeeded',
      reason: null,
      claimedJobs: 1,
      succeededJobs: 1,
      failedJobs: 0,
    })
    expect(meter.usage().statements).toBeLessThanOrEqual(50)
    expect(meter.usage().maxBindings).toBeLessThanOrEqual(100)
    expect(sendInvitationEmail).toHaveBeenCalledTimes(1)
    expect(invitation).toEqual({ status: 'pending', email_sent_at: EMAIL_NOW, version: 2 })
    expect(completedJob).toEqual({ status: 'succeeded' })
    expect(delivery).toEqual({
      provider: 'scaleway_tem',
      provider_reference: EMAIL_PROVIDER_ID,
      status: 'accepted',
    })
  })

  it('expires an invitation and queues access reconciliation inside one free-tier invocation', async () => {
    const context = await cryptoContext()
    const ownerId = 'stf_drain_expiry_owner'
    const staffId = 'stf_drain_expiry_target'
    const invitationId = 'inv_drain_expiry_target'
    const jobId = 'job_drain_expiry_target'
    const email = 'drain-expiry-target@example.test'
    await seedStaff(context, {
      id: ownerId,
      email: 'drain-expiry-owner@example.test',
      role: 'owner',
      status: 'active',
    })
    await seedStaff(context, { id: staffId, email })
    await seedInvitation(context, {
      id: invitationId,
      staffId,
      inviterId: ownerId,
      email,
      status: 'pending',
      expiresAt: EXPIRY_NOW,
    })
    const job = await enqueueOutboxStatement(env.DB, context, {
      id: jobId,
      type: 'staff.invitation.expire',
      aggregateType: 'staff_invitation',
      aggregateId: invitationId,
      payload: { actorId: ownerId, invitationId },
      idempotencyKey: `staff.invitation.expire:${invitationId}`,
      scheduledAt: EXPIRY_NOW,
      nowMs: EXPIRY_NOW_MS,
    })
    await job.run()
    const meter = meteredDb(env.DB)

    const result = await runOutboxDrain({
      scheduledTime: EXPIRY_NOW_MS,
      env: runtimeEnv(meter.db),
      deps: {
        now: () => EXPIRY_NOW_MS,
        safeLog: vi.fn(),
        providers: {},
        idFactory: sequence('drain_expiry_id'),
        leaseOwnerFactory: sequence('drain_expiry_owner'),
        leaseNonceFactory: sequence('drain_expiry_nonce'),
        correlationIdFactory: correlationSequence(),
      },
    })
    const [invitation, completedJob, reconcileJobs, deadActions] = await Promise.all([
      env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
        .bind(invitationId).first(),
      env.DB.prepare('SELECT status FROM outbox_jobs WHERE id=?').bind(jobId).first(),
      env.DB.prepare(
        `SELECT id,status FROM outbox_jobs
         WHERE type='staff.access.reconcile' AND created_at=? ORDER BY id`
      ).bind(EXPIRY_NOW).all(),
      env.DB.prepare(
        `SELECT count(*) AS count FROM operational_actions
         WHERE entity_type='outbox_job' AND entity_id=? AND status='open'`
      ).bind(jobId).first(),
    ])
    await env.DB.prepare(
      `UPDATE outbox_jobs SET scheduled_at='2099-01-01T00:00:00.000Z'
       WHERE type='staff.access.reconcile' AND created_at=? AND status='queued'`
    ).bind(EXPIRY_NOW).run()

    expect(result).toEqual({
      status: 'succeeded',
      reason: null,
      claimedJobs: 1,
      succeededJobs: 1,
      failedJobs: 0,
    })
    expect(meter.usage().statements).toBeLessThanOrEqual(50)
    expect(meter.usage().maxBindings).toBeLessThanOrEqual(100)
    expect(invitation).toEqual({ status: 'expired', version: 2 })
    expect(completedJob).toEqual({ status: 'succeeded' })
    expect(reconcileJobs.results).toHaveLength(1)
    expect(reconcileJobs.results[0].status).toBe('queued')
    expect(deadActions.count).toBe(0)
  })
})
