import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  blindEmailIndex,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import {
  decryptOutboxPayload,
  enqueueOutboxStatement,
  finalizeAcceptedInvitationEmail,
  finalizeOutboxJob,
  reapExpiredOutboxLeases,
} from '../../worker/jobs/outbox.js'
import { authorityActor } from './fixtures.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = Date.parse('2042-08-29T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})
const OWNER_ID = 'stf_outbox_recovery_owner'
const OWNER = authorityActor({ id: OWNER_ID, role: 'owner' })
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444'
const EMAIL_CORRELATION_ID = '55555555-5555-4555-8555-555555555555'
let context
let accessSourceGeneration = 100

const run = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).run()
const one = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).first()
const raceBeforeBatch = (race) => ({
  prepare: env.DB.prepare.bind(env.DB),
  async batch(statements) {
    await race()
    return env.DB.batch(statements)
  },
})
const substituteFirst = (needle, transform) => ({
  prepare(sql) {
    const statement = env.DB.prepare(sql)
    if (!sql.includes(needle)) return statement
    return {
      bind(...bindings) {
        const bound = statement.bind(...bindings)
        return {
          ...bound,
          async first() {
            return transform(await bound.first())
          },
        }
      },
    }
  },
  batch: env.DB.batch.bind(env.DB),
})
const ids = (prefix) => {
  let serial = 0
  return () => `${prefix}_${++serial}`
}

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await run(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?, '{}','{}','owner','active',?,NULL,1,?,NULL,?,?)`,
    OWNER_ID,
    'outbox_recovery_owner_lookup',
    'outbox-recovery-owner-subject',
    NOW,
    NOW,
    NOW,
  )
  const keyring = await createKeyring(env, {
    activeBackupKekVersion: 1,
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_outbox_recovery',
    createdAt: NOW,
  })
  context = { keyring, dataKey, scope: SCOPE }
})

async function openDeadAction({
  actionId,
  errorCode,
  jobId,
  type,
  aggregateType,
  aggregateId,
  idempotencyKey,
  payload,
  attemptCount = 1,
  terminalAttempt = true,
  terminalAttemptErrorCode = errorCode,
  terminalCompletedAt = NOW,
  terminalProviderReference = null,
}) {
  const statement = await enqueueOutboxStatement(env.DB, context, {
    id: jobId,
    type,
    aggregateType,
    aggregateId,
    payload,
    idempotencyKey,
    scheduledAt: NOW,
    nowMs: NOW_MS,
  })
  await statement.run()
  await run(
    `UPDATE outbox_jobs
     SET status='dead',attempt_count=?,last_error_code=?,updated_at=?
     WHERE id=? AND status='queued'`,
    attemptCount,
    errorCode,
    NOW,
    jobId,
  )
  if (terminalAttempt) {
    await run(
      `INSERT INTO outbox_attempts
       (id,job_id,attempt_number,started_at,completed_at,result,error_code,
        provider_reference)
       VALUES (?,?,?,?,?,'dead',?,?)`,
      `attempt_${jobId}`,
      jobId,
      attemptCount,
      NOW,
      terminalCompletedAt,
      terminalAttemptErrorCode,
      terminalProviderReference,
    )
  }
  const detailsEnvelope = JSON.stringify(await encryptForScope(
    context.keyring,
    context.dataKey,
    {
      expectedScope: context.scope,
      recordId: actionId,
      field: 'action_details',
      plaintext: JSON.stringify({ errorCode, jobId, outboxType: type }),
    },
  ))
  await run(
    `INSERT INTO operational_actions
     (id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
      version,created_at,updated_at)
     VALUES (?,?,'outbox_job_failed','critical','open','outbox_job',?,?,1,?,?)`,
    actionId,
    `outbox.dead:${jobId}`,
    jobId,
    detailsEnvelope,
    NOW,
    NOW,
  )
}

async function encryptedField(recordId, field, plaintext) {
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

async function recoveryModule() {
  try {
    return await import('../../worker/operations/outbox-recovery.js')
  } catch {
    return null
  }
}

async function seedEmailRecoveryFixture(suffix, errorCode, options = {}) {
  const staffId = `stf_recovery_${suffix}`
  const invitationId = `inv_recovery_${suffix}`
  const actionId = `act_recovery_${suffix}`
  const jobId = `job_recovery_${suffix}_dead`
  const expiresAt = new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString()
  const email = `recovery-${suffix.replaceAll('_', '-')}@example.test`
  const displayName = `Recovery ${suffix}`
  const lookup = await blindEmailIndex(options.lookupEmail ?? email, context.keyring)
  await run(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,'coordinator','pending',NULL,NULL,1,NULL,NULL,?,?)`,
    staffId,
    lookup,
    await encryptedField(staffId, 'email', email),
    await encryptedField(staffId, 'display_name', displayName),
    NOW,
    NOW,
  )
  await run(
    `INSERT INTO staff_invitations
     (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,
      inviter_id,expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,
      version,created_at,updated_at)
     VALUES (?,?,?,?,?,'coordinator','pending',?,?,?,NULL,NULL,NULL,2,?,?)`,
    invitationId,
    staffId,
    lookup,
    await encryptedField(invitationId, 'email', email),
    await encryptedField(invitationId, 'display_name', displayName),
    OWNER_ID,
    expiresAt,
    NOW,
    NOW,
    NOW,
  )
  await openDeadAction({
    actionId,
    errorCode,
    jobId,
    type: 'staff.invitation.email',
    aggregateType: 'staff_invitation',
    aggregateId: invitationId,
    idempotencyKey: `staff.invitation.email:${invitationId}:2`,
    payload: { actorId: OWNER_ID, invitationId },
  })
  return { actionId, invitationId, jobId, staffId }
}

async function seedOwner(id) {
  await run(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,'{}','{}','owner','active',?,NULL,1,?,NULL,?,?)`,
    id,
    `${id}_lookup`,
    `${id}_subject`,
    NOW,
    NOW,
    NOW,
  )
  return authorityActor({ id, role: 'owner' })
}

async function requestAccessRecovery(suffix, correlationId) {
  const module = await recoveryModule()
  expect(module).not.toBeNull()
  accessSourceGeneration += 1
  const sourceGeneration = accessSourceGeneration
  const actionId = `act_recovery_${suffix}`
  const sourceJobId = `job_recovery_${suffix}_dead`
  await openDeadAction({
    actionId,
    errorCode: 'OUTBOX_HANDLER_FAILURE',
    jobId: sourceJobId,
    type: 'staff.access.reconcile',
    aggregateType: 'access_group',
    aggregateId: 'centre_1',
    idempotencyKey: `staff.access.reconcile:${sourceGeneration}`,
    payload: { actorId: OWNER_ID, generation: sourceGeneration },
  })
  await module.requestOutboxRecovery({
    db: env.DB,
    cryptoContext: context,
    actor: OWNER,
    actionId,
    body: { version: 1 },
    idempotencyKey: `recover-${suffix}-key-0001`,
    correlationId,
    nowMs: NOW_MS,
    idFactory: ids(`generated_recovery_${suffix}`),
  })
  const lineage = await one(
    `SELECT source_job_id,replacement_job_id,operational_action_id,correlation_id
     FROM outbox_job_recoveries WHERE source_job_id=?`,
    sourceJobId,
  )
  return { actionId, sourceJobId, ...lineage }
}

async function startAttempt(jobId, suffix, { attemptNumber = 1, expired = false } = {}) {
  const attemptId = `attempt_recovery_${suffix}`
  const leaseOwner = `lease_recovery_${suffix}`
  const leaseExpiresAt = new Date(NOW_MS + (expired ? -1 : 60_000)).toISOString()
  await run(
    `UPDATE outbox_jobs
     SET status='processing',attempt_count=?,lease_owner=?,lease_expires_at=?,updated_at=?
     WHERE id=? AND status='queued' AND attempt_count=0`,
    attemptNumber,
    leaseOwner,
    leaseExpiresAt,
    NOW,
    jobId,
  )
  await run(
    `INSERT INTO outbox_attempts
     (id,job_id,attempt_number,started_at) VALUES (?,?,?,?)`,
    attemptId,
    jobId,
    attemptNumber,
    NOW,
  )
  return { attemptId, attemptNumber, leaseExpiresAt, leaseOwner }
}

describe('owner outbox recovery command', () => {
  it('replaces a dead Access job by advancing the canonical desired generation', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    await run(
      `UPDATE system_state
       SET value_json='{"generation":4}',version=version+1,updated_at=?
       WHERE key='access.desired_generation' AND version=1`,
      NOW,
    )
    await openDeadAction({
      actionId: 'act_recovery_access',
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      jobId: 'job_recovery_access_dead',
      type: 'staff.access.reconcile',
      aggregateType: 'access_group',
      aggregateId: 'centre_1',
      idempotencyKey: 'staff.access.reconcile:4',
      payload: { actorId: OWNER_ID, generation: 4 },
    })

    const result = await module.requestOutboxRecovery({
      db: env.DB,
      cryptoContext: context,
      actor: OWNER,
      actionId: 'act_recovery_access',
      body: { version: 1 },
      idempotencyKey: 'recover-access-key-0001',
      correlationId: CORRELATION_ID,
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_access'),
    })

    expect(result).toEqual({
      data: {
        action: { id: 'act_recovery_access', status: 'open', version: 1 },
        recovery: { kind: 'access', status: 'queued' },
      },
    })
    expect(await one(
      "SELECT value_json,version FROM system_state WHERE key='access.desired_generation'",
    )).toEqual({ value_json: '{"generation":5}', version: 3 })
    const replacement = await one(
      `SELECT id,type,aggregate_type,aggregate_id,idempotency_key,status,attempt_count,
              max_attempts,scheduled_at
       FROM outbox_jobs
       WHERE type='staff.access.reconcile' AND idempotency_key='staff.access.reconcile:5'`,
    )
    expect(replacement).toMatchObject({
      type: 'staff.access.reconcile',
      aggregate_type: 'access_group',
      aggregate_id: 'centre_1',
      idempotency_key: 'staff.access.reconcile:5',
      status: 'queued',
      attempt_count: 0,
      max_attempts: 8,
      scheduled_at: NOW,
    })
    expect(await decryptOutboxPayload(context, await one(
      'SELECT * FROM outbox_jobs WHERE id=?',
      replacement.id,
    ))).toEqual({ actorId: OWNER_ID, generation: 5 })
    expect(await one(
      `SELECT source_job_id,replacement_job_id,operational_action_id,
              requested_by_staff_id,correlation_id,created_at
       FROM outbox_job_recoveries WHERE source_job_id='job_recovery_access_dead'`,
    )).toEqual({
      source_job_id: 'job_recovery_access_dead',
      replacement_job_id: replacement.id,
      operational_action_id: 'act_recovery_access',
      requested_by_staff_id: OWNER_ID,
      correlation_id: CORRELATION_ID,
      created_at: NOW,
    })
    expect(await one(
      "SELECT status FROM outbox_jobs WHERE id='job_recovery_access_dead'",
    )).toEqual({ status: 'dead' })
    expect(await one(
      "SELECT status,version FROM operational_actions WHERE id='act_recovery_access'",
    )).toEqual({ status: 'open', version: 1 })
    expect(await one(
      `SELECT action,entity_type,entity_id,actor_staff_id,metadata_json
       FROM audit_events WHERE action='outbox.recovery.requested'
         AND entity_id='job_recovery_access_dead'`,
    )).toEqual({
      action: 'outbox.recovery.requested',
      entity_type: 'outbox_job',
      entity_id: 'job_recovery_access_dead',
      actor_staff_id: OWNER_ID,
      metadata_json: JSON.stringify({
        actionVersion: 1,
        desiredGeneration: 5,
        invitationVersion: null,
        replacementJobId: replacement.id,
      }),
    })
    expect(await one(
      `SELECT count(*) AS count FROM idempotency_records
       WHERE actor_id=? AND operation='outbox.recovery.request'
         AND idempotency_key='recover-access-key-0001'`,
      OWNER_ID,
    )).toEqual({ count: 1 })
  })

  it('replaces a definitively dead email job with the next invitation version', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const staffId = 'stf_recovery_email_target'
    const invitationId = 'inv_recovery_email_target'
    const expiresAt = new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString()
    const email = 'recovery-email-target@example.test'
    const displayName = 'Recovery Email Target'
    const lookup = await blindEmailIndex(email, context.keyring)
    await run(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
        specialist_id,version,activated_at,disabled_at,created_at,updated_at)
       VALUES (?,?,?,?,'coordinator','pending',NULL,NULL,1,NULL,NULL,?,?)`,
      staffId,
      lookup,
      await encryptedField(staffId, 'email', email),
      await encryptedField(staffId, 'display_name', displayName),
      NOW,
      NOW,
    )
    await run(
      `INSERT INTO staff_invitations
       (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,
        inviter_id,expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,
        version,created_at,updated_at)
       VALUES (?,?,?,?,?,'coordinator','pending',?,?,?,NULL,NULL,NULL,2,?,?)`,
      invitationId,
      staffId,
      lookup,
      await encryptedField(invitationId, 'email', email),
      await encryptedField(invitationId, 'display_name', displayName),
      OWNER_ID,
      expiresAt,
      NOW,
      NOW,
      NOW,
    )
    for (const version of [1, 2]) {
      await run(
        `INSERT INTO record_versions
         (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
          changed_at,correlation_id)
         VALUES (?,'staff_invitation',?,?,'{}',?,?,?)`,
        `ver_recovery_email_${version}`,
        invitationId,
        version,
        OWNER_ID,
        NOW,
        `55555555-5555-4555-8555-55555555555${version}`,
      )
    }
    await openDeadAction({
      actionId: 'act_recovery_email',
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      jobId: 'job_recovery_email_dead',
      type: 'staff.invitation.email',
      aggregateType: 'staff_invitation',
      aggregateId: invitationId,
      idempotencyKey: `staff.invitation.email:${invitationId}:2`,
      payload: { actorId: OWNER_ID, invitationId },
    })

    const result = await module.requestOutboxRecovery({
      db: env.DB,
      cryptoContext: context,
      actor: OWNER,
      actionId: 'act_recovery_email',
      body: { version: 1 },
      idempotencyKey: 'recover-email-key-0001',
      correlationId: EMAIL_CORRELATION_ID,
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_email'),
    })

    expect(result).toEqual({
      data: {
        action: { id: 'act_recovery_email', status: 'open', version: 1 },
        recovery: { kind: 'email', status: 'queued' },
      },
    })
    expect(await one(
      `SELECT status,email_sent_at,version,updated_at
       FROM staff_invitations WHERE id=?`,
      invitationId,
    )).toEqual({
      status: 'pending',
      email_sent_at: null,
      version: 3,
      updated_at: NOW,
    })
    const replacement = await one(
      `SELECT * FROM outbox_jobs
       WHERE type='staff.invitation.email' AND aggregate_id=?
         AND idempotency_key=?`,
      invitationId,
      `staff.invitation.email:${invitationId}:3`,
    )
    expect(replacement).toMatchObject({
      aggregate_type: 'staff_invitation',
      aggregate_id: invitationId,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 8,
      scheduled_at: NOW,
    })
    expect(await decryptOutboxPayload(context, replacement)).toEqual({
      actorId: OWNER_ID,
      invitationId,
    })
    expect(await one(
      `SELECT entity_type,entity_id,version,changed_by_staff_id,changed_at,correlation_id
       FROM record_versions
       WHERE entity_type='staff_invitation' AND entity_id=? AND version=3`,
      invitationId,
    )).toEqual({
      entity_type: 'staff_invitation',
      entity_id: invitationId,
      version: 3,
      changed_by_staff_id: OWNER_ID,
      changed_at: NOW,
      correlation_id: EMAIL_CORRELATION_ID,
    })
    expect(await one(
      `SELECT source_job_id,replacement_job_id,operational_action_id
       FROM outbox_job_recoveries WHERE source_job_id='job_recovery_email_dead'`,
    )).toEqual({
      source_job_id: 'job_recovery_email_dead',
      replacement_job_id: replacement.id,
      operational_action_id: 'act_recovery_email',
    })
    expect(await one(
      `SELECT action,metadata_json FROM audit_events
       WHERE action='outbox.recovery.requested' AND entity_id='job_recovery_email_dead'`,
    )).toEqual({
      action: 'outbox.recovery.requested',
      metadata_json: JSON.stringify({
        actionVersion: 1,
        desiredGeneration: null,
        invitationVersion: 3,
        replacementJobId: replacement.id,
      }),
    })
    expect(await one(
      "SELECT status,version FROM operational_actions WHERE id='act_recovery_email'",
    )).toEqual({ status: 'open', version: 1 })
  })

  it('refuses to resend an ambiguously delivered email', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const fixture = await seedEmailRecoveryFixture(
      'email_ambiguous',
      'EMAIL_DELIVERY_AMBIGUOUS',
    )
    const before = await one('SELECT count(*) AS count FROM outbox_jobs')

    await expect(module.requestOutboxRecovery({
      db: env.DB,
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: 'recover-ambiguous-key-0001',
      correlationId: '66666666-6666-4666-8666-666666666666',
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_ambiguous'),
    })).rejects.toThrow(/OUTBOX_RECOVERY_UNSAFE/)

    expect(await one('SELECT count(*) AS count FROM outbox_jobs')).toEqual(before)
    expect(await one(
      'SELECT version,email_sent_at FROM staff_invitations WHERE id=?',
      fixture.invitationId,
    )).toEqual({ version: 2, email_sent_at: null })
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )).toEqual({ count: 0 })
  })

  it.each([
    ['OUTBOX_HANDLER_RETRY', 201],
    ['OUTBOX_LEASE_EXPIRED', 202],
  ])('refuses a non-exhausted Access source with %s', async (errorCode, generation) => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const suffix = errorCode.toLowerCase()
    const actionId = `act_recovery_non_exhausted_${suffix}`
    const jobId = `job_recovery_non_exhausted_${suffix}`
    await openDeadAction({
      actionId,
      errorCode,
      jobId,
      type: 'staff.access.reconcile',
      aggregateType: 'access_group',
      aggregateId: 'centre_1',
      idempotencyKey: `staff.access.reconcile:${generation}`,
      payload: { actorId: OWNER_ID, generation },
    })

    await expect(module.requestOutboxRecovery({
      db: env.DB,
      cryptoContext: context,
      actor: OWNER,
      actionId,
      body: { version: 1 },
      idempotencyKey: `recover-non-exhausted-${suffix}-0001`,
      correlationId: '14141414-1414-4414-8414-141414141414',
      nowMs: NOW_MS,
      idFactory: ids(`generated_recovery_non_exhausted_${suffix}`),
    })).rejects.toThrow(/OUTBOX_RECOVERY_CONFLICT/)
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      jobId,
    )).toEqual({ count: 0 })
  })

  it.each([
    ['OUTBOX_HANDLER_RETRY', 211],
    ['OUTBOX_LEASE_EXPIRED', 212],
  ])('recovers an exhausted Access source with %s', async (errorCode, generation) => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const suffix = `exhausted_${errorCode.toLowerCase()}`
    const actionId = `act_recovery_${suffix}`
    const jobId = `job_recovery_${suffix}`
    await openDeadAction({
      actionId,
      errorCode,
      jobId,
      type: 'staff.access.reconcile',
      aggregateType: 'access_group',
      aggregateId: 'centre_1',
      idempotencyKey: `staff.access.reconcile:${generation}`,
      payload: { actorId: OWNER_ID, generation },
      attemptCount: 8,
    })

    await expect(module.requestOutboxRecovery({
      db: env.DB,
      cryptoContext: context,
      actor: OWNER,
      actionId,
      body: { version: 1 },
      idempotencyKey: `recover-${suffix.replaceAll('_', '-')}-0001`,
      correlationId: '21212121-2121-4121-8121-212121212121',
      nowMs: NOW_MS,
      idFactory: ids(`generated_recovery_${suffix}`),
    })).resolves.toMatchObject({
      data: { recovery: { kind: 'access', status: 'queued' } },
    })
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      jobId,
    )).toEqual({ count: 1 })
  })

  it.each([
    ['missing terminal attempt', { terminalAttempt: false }],
    ['mismatched terminal error', {
      terminalAttemptErrorCode: 'OUTBOX_HANDLER_RETRY',
    }],
    ['mismatched terminal completion', {
      terminalCompletedAt: '2042-08-29T10:00:00.001Z',
    }],
    ['unexpected terminal provider reference', {
      terminalProviderReference: 'provider_reference_rejected',
    }],
  ])('refuses a dead source with %s evidence', async (label, evidence) => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const suffix = label.replaceAll(' ', '_')
    const actionId = `act_recovery_${suffix}`
    const jobId = `job_recovery_${suffix}`
    await openDeadAction({
      actionId,
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      jobId,
      type: 'staff.access.reconcile',
      aggregateType: 'access_group',
      aggregateId: 'centre_1',
      idempotencyKey: `staff.access.reconcile:${++accessSourceGeneration}`,
      payload: { actorId: OWNER_ID, generation: accessSourceGeneration },
      ...evidence,
    })

    await expect(module.requestOutboxRecovery({
      db: env.DB,
      cryptoContext: context,
      actor: OWNER,
      actionId,
      body: { version: 1 },
      idempotencyKey: `recover-${suffix.replaceAll('_', '-')}-0001`,
      correlationId: '15151515-1515-4515-8515-151515151515',
      nowMs: NOW_MS,
      idFactory: ids(`generated_recovery_${suffix}`),
    })).rejects.toThrow(/OUTBOX_RECOVERY_CONFLICT/)
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      jobId,
    )).toEqual({ count: 0 })
  })

  it('refuses a tampered retry ceiling even when it makes a retry look exhausted', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const actionId = 'act_recovery_tampered_retry_ceiling'
    const jobId = 'job_recovery_tampered_retry_ceiling'
    const generation = ++accessSourceGeneration
    await openDeadAction({
      actionId,
      errorCode: 'OUTBOX_HANDLER_RETRY',
      jobId,
      type: 'staff.access.reconcile',
      aggregateType: 'access_group',
      aggregateId: 'centre_1',
      idempotencyKey: `staff.access.reconcile:${generation}`,
      payload: { actorId: OWNER_ID, generation },
    })

    await expect(module.requestOutboxRecovery({
      db: substituteFirst('SELECT * FROM outbox_jobs WHERE id=?', (record) => ({
        ...record,
        max_attempts: 1,
      })),
      cryptoContext: context,
      actor: OWNER,
      actionId,
      body: { version: 1 },
      idempotencyKey: 'recover-tampered-retry-ceiling-0001',
      correlationId: '17171717-1717-4717-8717-171717171717',
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_tampered_retry_ceiling'),
    })).rejects.toThrow(/OUTBOX_RECOVERY_CONFLICT/)
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      jobId,
    )).toEqual({ count: 0 })
  })

  it('rejects a tampered open action snapshot', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const fixture = await seedEmailRecoveryFixture(
      'tampered_action_snapshot',
      'OUTBOX_HANDLER_FAILURE',
    )

    await expect(module.requestOutboxRecovery({
      db: substituteFirst('FROM operational_actions WHERE id=?', (record) => ({
        ...record,
        version: 2,
      })),
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: 'recover-tampered-action-snapshot-0001',
      correlationId: '16161616-1616-4616-8616-161616161616',
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_tampered_action_snapshot'),
    })).rejects.toThrow(/OUTBOX_RECOVERY_CONFLICT/)
  })

  it('refuses to resend when any accepted delivery evidence exists', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const fixture = await seedEmailRecoveryFixture(
      'email_accepted_evidence',
      'OUTBOX_HANDLER_FAILURE',
    )
    await run(
      `INSERT INTO delivery_attempts
       (id,outbox_job_id,provider,provider_reference,status,error_code,attempted_at)
       VALUES ('delivery_recovery_accepted_evidence',?,'scaleway_tem',
               '77777777-7777-4777-8777-777777777777','accepted',NULL,?)`,
      fixture.jobId,
      NOW,
    )
    const before = await one('SELECT count(*) AS count FROM outbox_jobs')

    await expect(module.requestOutboxRecovery({
      db: env.DB,
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: 'recover-accepted-key-0001',
      correlationId: '77777777-7777-4777-8777-777777777777',
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_accepted'),
    })).rejects.toThrow(/OUTBOX_RECOVERY_UNSAFE/)

    expect(await one('SELECT count(*) AS count FROM outbox_jobs')).toEqual(before)
    expect(await one(
      'SELECT version FROM staff_invitations WHERE id=?',
      fixture.invitationId,
    )).toEqual({ version: 2 })
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )).toEqual({ count: 0 })
  })

  it('rejects a shared but incorrect blind lookup for the decrypted email', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const fixture = await seedEmailRecoveryFixture(
      'email_wrong_lookup',
      'OUTBOX_HANDLER_FAILURE',
      { lookupEmail: 'different-recovery-address@example.test' },
    )

    await expect(module.requestOutboxRecovery({
      db: env.DB,
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: 'recover-email-wrong-lookup-0001',
      correlationId: '18181818-1818-4818-8818-181818181818',
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_email_wrong_lookup'),
    })).rejects.toThrow(/^OUTBOX_RECOVERY_CONFLICT$/)
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )).toEqual({ count: 0 })
  })

  it.each([
    ['action', 'FROM operational_actions WHERE id=?'],
    ['source job', 'FROM outbox_jobs WHERE id=?'],
  ])('fails closed on a substituted %s row shape', async (_label, needle) => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const fixture = await seedEmailRecoveryFixture(
      `substituted_${_label.replace(' ', '_')}`,
      'OUTBOX_HANDLER_FAILURE',
    )
    const db = substituteFirst(needle, (record) => ({ ...record, extra: true }))

    await expect(module.requestOutboxRecovery({
      db,
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: `recover-substituted-${_label.replace(' ', '-')}-0001`,
      correlationId: '88888888-8888-4888-8888-888888888888',
      nowMs: NOW_MS,
      idFactory: ids(`generated_recovery_substituted_${_label.replace(' ', '_')}`),
    })).rejects.toThrow(/OUTBOX_RECOVERY_CONFLICT/)

    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )).toEqual({ count: 0 })
  })

  it.each([
    ['an extra selected field', (record) => ({ ...record, extra: true })],
    ['a malformed expiry', (record) => ({ ...record, expires_at: 'not-an-instant' })],
    ['a malformed invitation envelope', (record) => ({
      ...record,
      email_envelope: '{}',
    })],
  ])('fails closed on %s in the invitation recovery snapshot', async (label, transform) => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const suffix = label.replaceAll(' ', '_')
    const fixture = await seedEmailRecoveryFixture(
      `snapshot_${suffix}`,
      'OUTBOX_HANDLER_FAILURE',
    )

    await expect(module.requestOutboxRecovery({
      db: substituteFirst('FROM staff_invitations AS invitation', transform),
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: `recover-snapshot-${suffix.replaceAll('_', '-')}-0001`,
      correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      nowMs: NOW_MS,
      idFactory: ids(`generated_recovery_snapshot_${suffix}`),
    })).rejects.toThrow(/OUTBOX_RECOVERY_CONFLICT/)

    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )).toEqual({ count: 0 })
  })

  it('rolls back if the requesting owner loses current authority before commit', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const raceOwnerId = 'stf_recovery_authority_race_owner'
    const raceOwner = await seedOwner(raceOwnerId)
    const fixture = await seedEmailRecoveryFixture(
      'owner_authority_race',
      'OUTBOX_HANDLER_FAILURE',
    )
    const db = raceBeforeBatch(() => run(
      `UPDATE staff_users
       SET status='disabled',version=version+1,disabled_at=?,updated_at=?
      WHERE id=? AND status='active'`,
      NOW,
      NOW,
      raceOwnerId,
    ))

    await expect(module.requestOutboxRecovery({
      db,
      cryptoContext: context,
      actor: raceOwner,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: 'recover-owner-authority-race-0001',
      correlationId: '99999999-9999-4999-8999-999999999999',
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_owner_authority_race'),
    })).rejects.toThrow(/^FORBIDDEN$/)
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )).toEqual({ count: 0 })
    expect(await one(
      'SELECT version FROM staff_invitations WHERE id=?',
      fixture.invitationId,
    )).toEqual({ version: 2 })
  })

  it('rolls back with a typed conflict if the captured pending staff row changes', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const fixture = await seedEmailRecoveryFixture(
      'email_staff_snapshot_race',
      'OUTBOX_HANDLER_FAILURE',
    )
    const changedDisplayName = await encryptedField(
      fixture.staffId,
      'display_name',
      'Changed Recovery Name',
    )

    await expect(module.requestOutboxRecovery({
      db: raceBeforeBatch(() => run(
        `UPDATE staff_users
         SET display_name_envelope=?,version=version+1,updated_at=? WHERE id=?`,
        changedDisplayName,
        NOW,
        fixture.staffId,
      )),
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: 'recover-email-staff-snapshot-race-0001',
      correlationId: '19191919-1919-4919-8919-191919191919',
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_email_staff_snapshot_race'),
    })).rejects.toThrow(/^OUTBOX_RECOVERY_CONFLICT$/)
    expect(await one(
      'SELECT version FROM staff_invitations WHERE id=?',
      fixture.invitationId,
    )).toEqual({ version: 2 })
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )).toEqual({ count: 0 })
  })

  it('rolls back with a typed conflict if the captured invitation row changes', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const fixture = await seedEmailRecoveryFixture(
      'email_invitation_snapshot_race',
      'OUTBOX_HANDLER_FAILURE',
    )
    const changedDisplayName = await encryptedField(
      fixture.invitationId,
      'display_name',
      'Changed Invitation Name',
    )

    await expect(module.requestOutboxRecovery({
      db: raceBeforeBatch(() => run(
        `UPDATE staff_invitations
         SET display_name_envelope=?,version=version+1,updated_at=? WHERE id=?`,
        changedDisplayName,
        NOW,
        fixture.invitationId,
      )),
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: 'recover-email-invitation-snapshot-race-0001',
      correlationId: '20202020-2020-4020-8020-202020202020',
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_email_invitation_snapshot_race'),
    })).rejects.toThrow(/^OUTBOX_RECOVERY_CONFLICT$/)
    expect(await one(
      'SELECT version FROM staff_invitations WHERE id=?',
      fixture.invitationId,
    )).toEqual({ version: 3 })
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )).toEqual({ count: 0 })
  })

  it.each([
    ['accepted delivery', async (fixture) => run(
      `INSERT INTO delivery_attempts
       (id,outbox_job_id,provider,provider_reference,status,error_code,attempted_at)
       VALUES (? ,?,'scaleway_tem',?,'accepted',NULL,?)`,
      `delivery_${fixture.jobId}`,
      fixture.jobId,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      NOW,
    )],
    ['another live email job', async (fixture) => {
      const statement = await enqueueOutboxStatement(env.DB, context, {
        id: `job_${fixture.invitationId}_raced`,
        type: 'staff.invitation.email',
        aggregateType: 'staff_invitation',
        aggregateId: fixture.invitationId,
        payload: { actorId: OWNER_ID, invitationId: fixture.invitationId },
        idempotencyKey: `staff.invitation.email:${fixture.invitationId}:99`,
        scheduledAt: NOW,
        nowMs: NOW_MS,
      })
      await statement.run()
    }],
  ])('rolls back if %s appears before the email recovery batch commits', async (label, race) => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const suffix = label.replaceAll(' ', '_')
    const fixture = await seedEmailRecoveryFixture(
      `email_${suffix}_race`,
      'OUTBOX_HANDLER_FAILURE',
    )

    await expect(module.requestOutboxRecovery({
      db: raceBeforeBatch(() => race(fixture)),
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: `recover-${suffix.replaceAll('_', '-')}-race-0001`,
      correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      nowMs: NOW_MS,
      idFactory: ids(`generated_recovery_${suffix}_race`),
    })).rejects.toThrow(/^OUTBOX_RECOVERY_UNSAFE$/)

    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )).toEqual({ count: 0 })
    expect(await one(
      'SELECT version FROM staff_invitations WHERE id=?',
      fixture.invitationId,
    )).toEqual({ version: 2 })
  })

  it.each([
    ['action state', 'VERSION_CONFLICT', async (fixture) => run(
      `UPDATE operational_actions
       SET status='resolved',version=2,resolved_at=?,updated_at=? WHERE id=?`,
      NOW,
      NOW,
      fixture.actionId,
    )],
    ['source state', 'OUTBOX_RECOVERY_CONFLICT', async (fixture) => run(
      `UPDATE outbox_jobs SET last_error_code='OUTBOX_HANDLER_RETRY' WHERE id=?`,
      fixture.jobId,
    )],
  ])('classifies a raced %s without exposing a D1 guard error', async (
    label,
    expectedCode,
    race,
  ) => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const suffix = label.replaceAll(' ', '_')
    const fixture = await seedEmailRecoveryFixture(
      `email_${suffix}_classification`,
      'OUTBOX_HANDLER_FAILURE',
    )

    await expect(module.requestOutboxRecovery({
      db: raceBeforeBatch(() => race(fixture)),
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: `recover-${suffix.replaceAll('_', '-')}-classification-0001`,
      correlationId: '17171717-1717-4717-8717-171717171717',
      nowMs: NOW_MS,
      idFactory: ids(`generated_recovery_${suffix}_classification`),
    })).rejects.toThrow(new RegExp(`^${expectedCode}$`))
    expect(await one(
      'SELECT count(*) AS count FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )).toEqual({ count: 0 })
  })

  it('resolves the source action only when a generic replacement succeeds', async () => {
    const correlationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const lineage = await requestAccessRecovery('terminal_success', correlationId)
    const attempt = await startAttempt(
      lineage.replacement_job_id,
      'terminal_success',
    )
    const completedAt = new Date(NOW_MS + 1).toISOString()

    await expect(finalizeOutboxJob(env.DB, context, {
      jobId: lineage.replacement_job_id,
      leaseOwner: attempt.leaseOwner,
      attemptNumber: attempt.attemptNumber,
      nowMs: NOW_MS + 1,
      result: 'succeeded',
      errorCode: null,
      providerReference: null,
      idFactory: ids('generated_terminal_success'),
    })).resolves.toBe(true)

    expect(await one(
      'SELECT status,version,updated_at,resolved_at FROM operational_actions WHERE id=?',
      lineage.actionId,
    )).toEqual({
      status: 'resolved',
      version: 2,
      updated_at: completedAt,
      resolved_at: completedAt,
    })
    expect(await one(
      `SELECT actor_staff_id,action,entity_type,entity_id,correlation_id,metadata_json
       FROM audit_events
       WHERE action='operational_action.resolved' AND entity_id=?`,
      lineage.actionId,
    )).toEqual({
      actor_staff_id: null,
      action: 'operational_action.resolved',
      entity_type: 'operational_action',
      entity_id: lineage.actionId,
      correlation_id: correlationId,
      metadata_json: '{"actionVersion":2}',
    })
    expect(await one(
      'SELECT status FROM outbox_jobs WHERE id=?',
      lineage.sourceJobId,
    )).toEqual({ status: 'dead' })
  })

  it('keeps the source action open while a replacement remains retryable', async () => {
    const lineage = await requestAccessRecovery(
      'replacement_retry',
      '22222222-2222-4222-8222-222222222222',
    )
    const attempt = await startAttempt(lineage.replacement_job_id, 'replacement_retry')

    await expect(finalizeOutboxJob(env.DB, context, {
      jobId: lineage.replacement_job_id,
      leaseOwner: attempt.leaseOwner,
      attemptNumber: attempt.attemptNumber,
      nowMs: NOW_MS + 1,
      result: 'retry',
      errorCode: 'OUTBOX_HANDLER_RETRY',
      providerReference: null,
      idFactory: ids('generated_replacement_retry'),
    })).resolves.toBe(true)

    expect(await one(
      'SELECT status,version,resolved_at FROM operational_actions WHERE id=?',
      lineage.actionId,
    )).toEqual({ status: 'open', version: 1, resolved_at: null })
    expect(await one(
      'SELECT status,last_error_code FROM outbox_jobs WHERE id=?',
      lineage.replacement_job_id,
    )).toEqual({ status: 'queued', last_error_code: 'OUTBOX_HANDLER_RETRY' })
    expect(await one(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='operational_action.resolved' AND entity_id=?`,
      lineage.actionId,
    )).toEqual({ count: 0 })
  })

  it('moves the only open failure action to a generic replacement that dies', async () => {
    const correlationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const lineage = await requestAccessRecovery('terminal_dead', correlationId)
    const attempt = await startAttempt(lineage.replacement_job_id, 'terminal_dead')

    await expect(finalizeOutboxJob(env.DB, context, {
      jobId: lineage.replacement_job_id,
      leaseOwner: attempt.leaseOwner,
      attemptNumber: attempt.attemptNumber,
      nowMs: NOW_MS + 1,
      result: 'dead',
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      providerReference: null,
      idFactory: ids('generated_terminal_dead'),
    })).resolves.toBe(true)

    expect(await one(
      'SELECT status,version FROM operational_actions WHERE id=?',
      lineage.actionId,
    )).toEqual({ status: 'resolved', version: 2 })
    expect((await env.DB.prepare(
      `SELECT id,entity_id,status FROM operational_actions
       WHERE id=? OR entity_id=? ORDER BY id`,
    ).bind(lineage.actionId, lineage.replacement_job_id).all()).results
      .filter(({ status }) => status === 'open')).toEqual([
        expect.objectContaining({ entity_id: lineage.replacement_job_id, status: 'open' }),
      ])
    expect(await one(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='operational_action.resolved' AND entity_id=?
         AND correlation_id=?`,
      lineage.actionId,
      correlationId,
    )).toEqual({ count: 1 })
  })

  it('resolves the source action in the provider-accepted email terminal batch', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const correlationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const fixture = await seedEmailRecoveryFixture(
      'accepted_terminal',
      'OUTBOX_HANDLER_FAILURE',
    )
    await module.requestOutboxRecovery({
      db: env.DB,
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: 'recover-accepted-terminal-key-0001',
      correlationId,
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_accepted_terminal'),
    })
    const lineage = await one(
      'SELECT replacement_job_id FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )
    const attempt = await startAttempt(
      lineage.replacement_job_id,
      'accepted_terminal',
    )

    await expect(finalizeAcceptedInvitationEmail(env.DB, context, {
      jobId: lineage.replacement_job_id,
      leaseOwner: attempt.leaseOwner,
      attemptNumber: attempt.attemptNumber,
      nowMs: NOW_MS + 1,
      providerId: '12121212-1212-4212-8212-121212121212',
      idFactory: ids('generated_accepted_terminal'),
      nowFactory: () => NOW_MS + 1,
    })).resolves.toBe(true)

    expect(await one(
      'SELECT status,version FROM operational_actions WHERE id=?',
      fixture.actionId,
    )).toEqual({ status: 'resolved', version: 2 })
    expect(await one(
      `SELECT actor_staff_id,correlation_id,metadata_json FROM audit_events
       WHERE action='operational_action.resolved' AND entity_id=?`,
      fixture.actionId,
    )).toEqual({
      actor_staff_id: null,
      correlation_id: correlationId,
      metadata_json: '{"actionVersion":2}',
    })
  })

  it('moves the only open failure action when a recovered lease expires terminally', async () => {
    const correlationId = '13131313-1313-4313-8313-131313131313'
    const lineage = await requestAccessRecovery('expired_terminal', correlationId)
    await startAttempt(lineage.replacement_job_id, 'expired_terminal', {
      attemptNumber: 8,
      expired: true,
    })

    await expect(reapExpiredOutboxLeases(env.DB, context, {
      nowMs: NOW_MS,
      idFactory: ids('generated_expired_terminal'),
    })).resolves.toEqual([
      expect.objectContaining({ id: lineage.replacement_job_id, result: 'dead' }),
    ])
    expect(await one(
      'SELECT status,version FROM operational_actions WHERE id=?',
      lineage.actionId,
    )).toEqual({ status: 'resolved', version: 2 })
    expect((await env.DB.prepare(
      `SELECT entity_id,status FROM operational_actions
       WHERE id=? OR entity_id=?`,
    ).bind(lineage.actionId, lineage.replacement_job_id).all()).results
      .filter(({ status }) => status === 'open')).toEqual([
        expect.objectContaining({ entity_id: lineage.replacement_job_id, status: 'open' }),
      ])
  })

  it('moves the open failure action when a recovered email lease expires ambiguously', async () => {
    const module = await recoveryModule()
    expect(module).not.toBeNull()
    const fixture = await seedEmailRecoveryFixture(
      'email_expired_terminal',
      'OUTBOX_HANDLER_FAILURE',
    )
    await module.requestOutboxRecovery({
      db: env.DB,
      cryptoContext: context,
      actor: OWNER,
      actionId: fixture.actionId,
      body: { version: 1 },
      idempotencyKey: 'recover-email-expired-terminal-0001',
      correlationId: '23232323-2323-4323-8323-232323232323',
      nowMs: NOW_MS,
      idFactory: ids('generated_recovery_email_expired_terminal'),
    })
    const lineage = await one(
      'SELECT replacement_job_id FROM outbox_job_recoveries WHERE source_job_id=?',
      fixture.jobId,
    )
    await startAttempt(lineage.replacement_job_id, 'email_expired_terminal', {
      expired: true,
    })

    await expect(reapExpiredOutboxLeases(env.DB, context, {
      nowMs: NOW_MS,
      idFactory: ids('generated_email_expired_terminal'),
    })).resolves.toContainEqual({
      id: lineage.replacement_job_id,
      result: 'dead',
    })
    expect(await one(
      'SELECT status,version FROM operational_actions WHERE id=?',
      fixture.actionId,
    )).toEqual({ status: 'resolved', version: 2 })
    expect(await one(
      'SELECT status,last_error_code FROM outbox_jobs WHERE id=?',
      lineage.replacement_job_id,
    )).toEqual({ status: 'dead', last_error_code: 'EMAIL_DELIVERY_AMBIGUOUS' })
    expect((await env.DB.prepare(
      `SELECT entity_id,status FROM operational_actions
       WHERE id=? OR entity_id=?`,
    ).bind(fixture.actionId, lineage.replacement_job_id).all()).results
      .filter(({ status }) => status === 'open')).toEqual([
        expect.objectContaining({ entity_id: lineage.replacement_job_id, status: 'open' }),
      ])
  })
})
