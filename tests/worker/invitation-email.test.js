import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import * as handlers from '../../worker/jobs/handlers.js'
import * as outbox from '../../worker/jobs/outbox.js'
import {
  blindEmailIndex,
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { NOW_MS } from './fixtures.js'

const NOW = new Date(NOW_MS).toISOString()
const FUTURE = new Date(NOW_MS + 86_400_000).toISOString()
const LEASE_EXPIRES = new Date(NOW_MS + 60_000).toISOString()
const PROVIDER_ID = '22222222-2222-4222-8222-222222222222'
const SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})
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
    id: 'key_invitation_email_b3',
    createdAt: NOW,
  })
  return { keyring, dataKey, scope: SCOPE }
}

async function encryptedField(cryptoContext, recordId, field, plaintext) {
  return JSON.stringify(await encryptForScope(
    cryptoContext.keyring,
    cryptoContext.dataKey,
    {
      expectedScope: cryptoContext.scope,
      recordId,
      field,
      plaintext,
    },
  ))
}

async function seedStaff(cryptoContext, {
  id,
  email,
  displayName,
  role = 'coordinator',
  status = 'pending',
  version = 1,
  lookup,
  emailEnvelope,
}) {
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id,
    lookup ?? await blindEmailIndex(email, cryptoContext.keyring),
    emailEnvelope ?? await encryptedField(cryptoContext, id, 'email', email),
    await encryptedField(cryptoContext, id, 'display_name', displayName),
    role,
    status,
    status === 'active' ? `subject_${id}` : null,
    role === 'specialist' ? `sp_${id.slice(4)}` : null,
    version,
    status === 'active' ? NOW : null,
    status === 'disabled' ? NOW : null,
    NOW,
    NOW,
  ).run()
  return env.DB.prepare('SELECT * FROM staff_users WHERE id=?').bind(id).first()
}

async function seedInvitation(cryptoContext, {
  id,
  staffId,
  inviterId,
  email,
  displayName,
  status = 'pending',
  expiresAt = FUTURE,
  accessAllowedAt,
  version = 1,
  lookup,
  emailEnvelope,
  displayNameEnvelope,
  emailSentAt = null,
}) {
  const encryptedDisplayName = await encryptedField(
    cryptoContext,
    id,
    'display_name',
    displayName,
  )
  const resolvedDisplayNameEnvelope = typeof displayNameEnvelope === 'function'
    ? displayNameEnvelope(encryptedDisplayName)
    : displayNameEnvelope ?? encryptedDisplayName
  await env.DB.prepare(
    `INSERT INTO staff_invitations
     (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,inviter_id,
      expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,version,created_at,
      updated_at)
     VALUES (?,?,?,?,?,'coordinator',?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id,
    staffId,
    lookup ?? await blindEmailIndex(email, cryptoContext.keyring),
    emailEnvelope ?? await encryptedField(cryptoContext, id, 'email', email),
    resolvedDisplayNameEnvelope,
    status,
    inviterId,
    expiresAt,
    accessAllowedAt ?? (['pending', 'activated'].includes(status) ? NOW : null),
    emailSentAt,
    status === 'activated' ? NOW : null,
    status === 'revoked' ? NOW : null,
    version,
    NOW,
    NOW,
  ).run()
  return env.DB.prepare('SELECT * FROM staff_invitations WHERE id=?').bind(id).first()
}

async function seedJob(cryptoContext, {
  id,
  invitationId,
  invitationVersion = 1,
  actorId,
  processing = true,
}) {
  const statement = await outbox.enqueueOutboxStatement(env.DB, cryptoContext, {
    id,
    type: 'staff.invitation.email',
    aggregateType: 'staff_invitation',
    aggregateId: invitationId,
    payload: { actorId, invitationId },
    idempotencyKey: `staff.invitation.email:${invitationId}:${invitationVersion}`,
    scheduledAt: NOW,
    nowMs: NOW_MS,
  })
  await statement.run()
  if (!processing) return env.DB.prepare('SELECT * FROM outbox_jobs WHERE id=?').bind(id).first()
  const attemptId = `attempt_${id}`
  const leaseOwner = `lease_${id}`
  await env.DB.prepare(
    `UPDATE outbox_jobs
     SET status='processing',attempt_count=1,lease_owner=?,lease_expires_at=?,updated_at=?
     WHERE id=? AND status='queued' AND attempt_count=0`
  ).bind(leaseOwner, LEASE_EXPIRES, NOW, id).run()
  await env.DB.prepare(
    `INSERT INTO outbox_attempts (id,job_id,attempt_number,started_at)
     VALUES (?,?,1,?)`
  ).bind(attemptId, id, NOW).run()
  const row = await env.DB.prepare('SELECT * FROM outbox_jobs WHERE id=?').bind(id).first()
  return {
    ...row,
    attemptId,
    attemptNumber: 1,
    leaseOwner,
  }
}

async function fixture(options = {}) {
  serial += 1
  const suffix = String(serial)
  const cryptoContext = await context()
  const email = options.email ?? `recipient-${suffix}@example.test`
  const actorId = `stf_email_actor_${suffix}`
  const inviterId = options.separateInviter ? `stf_email_inviter_${suffix}` : actorId
  const staffId = `stf_email_target_${suffix}`
  const invitationId = `inv_email_${suffix}`
  const jobId = `job_email_${suffix}`
  if (!options.missingActor) {
    await seedStaff(cryptoContext, {
      id: actorId,
      email: `actor-${suffix}@example.test`,
      displayName: 'Actor Testowy',
      role: 'owner',
      status: options.actorStatus ?? 'active',
      version: options.actorVersion ?? 1,
    })
  }
  if (options.separateInviter) {
    await seedStaff(cryptoContext, {
      id: inviterId,
      email: `inviter-${suffix}@example.test`,
      displayName: 'Inviter Testowy',
      role: 'owner',
      status: 'active',
    })
  }
  const targetStatus = options.staffStatus ?? 'pending'
  const staff = options.missingInvitation
    ? null
    : await seedStaff(cryptoContext, {
        id: staffId,
        email: options.staffEmail ?? email,
        displayName: `Recipient ${suffix}`,
        status: targetStatus,
        version: options.staffVersion ?? 1,
        lookup: options.staffLookup,
        emailEnvelope: options.staffEmailEnvelope,
      })
  const invitation = options.missingInvitation
    ? null
    : await seedInvitation(cryptoContext, {
        id: invitationId,
        staffId,
        inviterId,
        email: options.invitationEmail ?? email,
        displayName: `Recipient ${suffix}`,
        status: options.invitationStatus ?? 'pending',
        expiresAt: options.expiresAt ?? FUTURE,
        accessAllowedAt: options.accessAllowedAt,
        version: options.invitationVersion ?? 1,
        lookup: options.invitationLookup,
        emailEnvelope: options.invitationEmailEnvelope,
        displayNameEnvelope: options.invitationDisplayNameEnvelope,
        emailSentAt: options.emailSentAt ?? null,
      })
  const job = await seedJob(cryptoContext, {
    id: jobId,
    invitationId,
    invitationVersion: options.jobInvitationVersion ?? invitation?.version ?? 1,
    actorId: options.payloadActorId ?? actorId,
    processing: options.processing ?? true,
  })
  return {
    actorId,
    cryptoContext,
    email,
    invitation,
    invitationId,
    job,
    jobId,
    staff,
  }
}

const dispatch = (value, options = {}) => handlers.dispatchOutboxJob({
  db: options.db ?? env.DB,
  cryptoContext: options.cryptoContext ?? value.cryptoContext,
  config: options.config ?? { appEnv: 'development', appOrigin: 'http://127.0.0.1:5174' },
  bindings: options.bindings,
  job: options.job ?? value.job,
  nowMs: options.nowMs ?? NOW_MS,
  nowFactory: options.nowFactory ?? (() => options.nowMs ?? NOW_MS),
  providers: options.providers,
})

async function acceptedFinalize(value, options = {}) {
  expect(outbox.finalizeAcceptedInvitationEmail).toBeTypeOf('function')
  const input = {
    jobId: value.jobId,
    leaseOwner: options.leaseOwner ?? value.job.leaseOwner,
    attemptNumber: options.attemptNumber ?? value.job.attemptNumber,
    nowMs: options.nowMs ?? NOW_MS + 1,
    providerId: options.providerId ?? PROVIDER_ID,
    idFactory: options.idFactory ?? sequence(`email_finalize_${serial}`),
  }
  if (!options.useDefaultClock) {
    input.nowFactory = options.nowFactory ?? (() => input.nowMs)
  }
  return outbox.finalizeAcceptedInvitationEmail(
    options.db ?? env.DB,
    value.cryptoContext,
    input,
  )
}

const row = (table, column, id) => env.DB.prepare(
  `SELECT * FROM ${table} WHERE ${column}=?`
).bind(id).first()

const deferOtherProcessingLeases = (jobId) => env.DB.prepare(
  `UPDATE outbox_jobs
   SET lease_expires_at=?,updated_at=?
   WHERE status='processing' AND id!=?`
).bind(FUTURE, NOW, jobId).run()

const joinedRowDb = (transform) => ({
  prepare(sql) {
    const statement = env.DB.prepare(sql)
    if (!sql.includes('FROM staff_invitations i JOIN staff_users s')) return statement
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

const paddedEnvelope = (envelope, length) => {
  expect(envelope.length).toBeLessThan(length)
  const padded = `${' '.repeat(length - envelope.length)}${envelope}`
  expect(padded).toHaveLength(length)
  return padded
}

describe('authoritative invitation email dispatch', () => {
  it('returns one frozen accepted fact without mutating D1 before the dedicated finalizer', async () => {
    const value = await fixture()
    const provider = vi.fn().mockResolvedValue({ providerId: PROVIDER_ID })
    const outcome = await dispatch(value, {
      providers: { sendInvitationEmail: provider },
    })
    expect(outcome).toEqual({ result: 'email-accepted', providerId: PROVIDER_ID })
    expect(Object.isFrozen(outcome)).toBe(true)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider.mock.calls[0][0]).toMatchObject({
      recipient: value.email,
      expiresAt: FUTURE,
      jobId: value.jobId,
    })
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
  })

  it('delivers the exact protected staging role alias through an injected provider', async () => {
    const value = await fixture({ email: 'staging-owner@bearwithme-panel.app' })
    const provider = vi.fn().mockResolvedValue({ providerId: PROVIDER_ID })

    await expect(dispatch(value, {
      config: {
        appEnv: 'staging',
        appOrigin: 'https://staging.bearwithme-panel.app',
      },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'email-accepted', providerId: PROVIDER_ID })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider.mock.calls[0][0].recipient).toBe('staging-owner@bearwithme-panel.app')
  })

  it.each([
    ['a missing invitation', { missingInvitation: true }],
    ['a disabled staff row', { staffStatus: 'disabled' }],
    ['an active staff row', { staffStatus: 'active' }],
    ['a provisioning invitation', { invitationStatus: 'provisioning' }],
    ['a revoked invitation', { invitationStatus: 'revoked' }],
    ['an activated invitation', { invitationStatus: 'activated', staffStatus: 'active' }],
    ['an expired invitation', { invitationStatus: 'expired' }],
    ['the exact expiry boundary', { expiresAt: NOW }],
    ['an already-sent invitation', { emailSentAt: NOW }],
  ])('suppresses %s as successful without recipient decryption or provider I/O', async (_label, patch) => {
    const value = await fixture(patch)
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      cryptoContext: { ...value.cryptoContext, keyring },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'succeeded' })
    expect(decryptions).toBe(1)
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['different decrypted invitation and staff emails', {
      invitationEmail: 'other@example.test',
    }],
    ['different invitation and staff lookups', {
      invitationLookup: 'v1:mismatched_lookup',
    }],
    ['a non-canonical decrypted recipient', {
      email: 'Recipient@example.test',
    }],
  ])('fails closed for %s before provider I/O', async (_label, patch) => {
    const value = await fixture(patch)
    const provider = vi.fn()
    await expect(dispatch(value, {
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(provider).not.toHaveBeenCalled()
  })

  it('rejects an invitation job whose immutable key names another published version', async () => {
    const value = await fixture({ jobInvitationVersion: 99 })
    const provider = vi.fn()
    await expect(dispatch(value, {
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(provider).not.toHaveBeenCalled()
    await expect(acceptedFinalize(value)).resolves.toBe(false)
  })

  it.each([
    ['a leading-dot local part', '.recipient@example.test'],
    ['a trailing-dot local part', 'recipient.@example.test'],
    ['consecutive local-part dots', 'recipient..x@example.test'],
    ['a control-bearing local part', 'recipient\u0001@example.test'],
    ['an outer newline control', '\nnewline-recipient@example.test'],
    ['a quoted local part', '"recipient"@example.test'],
    ['a leading-hyphen domain label', 'recipient@-example.test'],
    ['a trailing-hyphen domain label', 'recipient@example-.test'],
    ['consecutive domain dots', 'recipient@example..test'],
  ])('rejects %s before provider I/O', async (_label, email) => {
    const value = await fixture({ email })
    const provider = vi.fn()
    await expect(dispatch(value, {
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['a malformed expiry instant', { expiresAt: 'not-an-instant' }],
    ['a malformed access instant', { accessAllowedAt: 'not-an-instant' }],
  ])('fails closed for %s before recipient decryption or provider I/O', async (_label, patch) => {
    const value = await fixture(patch)
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      cryptoContext: { ...value.cryptoContext, keyring },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(decryptions).toBe(1)
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['an extra joined field', (record) => ({ ...record, extra: true })],
    ['a missing joined field', (record) => {
      const { display_name_envelope: _removed, ...substituted } = record
      return substituted
    }],
    ['a pending row with an activation instant', (record) => ({
      ...record,
      activated_at: NOW,
    })],
    ['a pending row with a revocation instant', (record) => ({
      ...record,
      revoked_at: NOW,
    })],
  ])('fails closed for %s before recipient decryption or provider I/O', async (_label, transform) => {
    const value = await fixture()
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      db: joinedRowDb(transform),
      cryptoContext: { ...value.cryptoContext, keyring },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(decryptions).toBe(1)
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['a malformed display-name envelope', (record) => ({
      ...record,
      display_name_envelope: '{}',
    })],
    ['an update instant before creation', (record) => ({
      ...record,
      created_at: FUTURE,
      updated_at: NOW,
    })],
  ])('fails closed for %s before recipient decryption or provider I/O', async (_label, transform) => {
    const value = await fixture()
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      db: joinedRowDb(transform),
      cryptoContext: { ...value.cryptoContext, keyring },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(decryptions).toBe(1)
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    [4096, { result: 'email-accepted', providerId: PROVIDER_ID }, 3, 1],
    [4097, { result: 'dead' }, 1, 0],
  ])('enforces the handler envelope boundary at %i characters before provider I/O', async (
    length,
    outcome,
    expectedDecryptions,
    expectedProviderCalls,
  ) => {
    const value = await fixture()
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn().mockResolvedValue({ providerId: PROVIDER_ID })
    await expect(dispatch(value, {
      db: joinedRowDb((record) => ({
        ...record,
        display_name_envelope: paddedEnvelope(record.display_name_envelope, length),
      })),
      cryptoContext: { ...value.cryptoContext, keyring },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual(outcome)
    expect(decryptions).toBe(expectedDecryptions)
    expect(provider).toHaveBeenCalledTimes(expectedProviderCalls)
  })

  it('rejects a maximum-safe invitation version before recipient decryption or provider I/O', async () => {
    const value = await fixture({ invitationVersion: Number.MAX_SAFE_INTEGER })
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      cryptoContext: { ...value.cryptoContext, keyring },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(decryptions).toBe(1)
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['provisioning with access', (record) => ({
      ...record,
      status: 'provisioning',
    })],
    ['activated without activation time', (record) => ({
      ...record,
      status: 'activated',
      staff_status: 'active',
    })],
    ['activated with revocation time', (record) => ({
      ...record,
      status: 'activated',
      staff_status: 'active',
      activated_at: NOW,
      revoked_at: NOW,
    })],
    ['activated without access', (record) => ({
      ...record,
      status: 'activated',
      staff_status: 'active',
      activated_at: NOW,
      access_allowed_at: null,
    })],
    ['revoked without revocation time', (record) => ({
      ...record,
      status: 'revoked',
    })],
    ['revoked with activation time', (record) => ({
      ...record,
      status: 'revoked',
      activated_at: NOW,
      revoked_at: NOW,
    })],
    ['expired with activation time', (record) => ({
      ...record,
      status: 'expired',
      activated_at: NOW,
    })],
  ])('fails closed for a lifecycle-invalid %s row', async (_label, transform) => {
    const value = await fixture()
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      db: joinedRowDb(transform),
      cryptoContext: { ...value.cryptoContext, keyring },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(decryptions).toBe(1)
    expect(provider).not.toHaveBeenCalled()
  })

  it('fails closed when a terminal joined row substitutes the claimed aggregate ID', async () => {
    const value = await fixture()
    const provider = vi.fn()
    await expect(dispatch(value, {
      db: joinedRowDb((record) => ({
        ...record,
        id: 'inv_substituted_terminal',
        status: 'revoked',
        access_allowed_at: null,
        revoked_at: NOW,
      })),
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(provider).not.toHaveBeenCalled()
  })

  it('requires a retained payload actor even when the invitation is terminal', async () => {
    const value = await fixture({
      invitationStatus: 'revoked',
      missingActor: true,
      separateInviter: true,
    })
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      cryptoContext: { ...value.cryptoContext, keyring },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(decryptions).toBe(1)
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['invitation expiry', {
      expiresAt: new Date(NOW_MS + 40_000).toISOString(),
      observedNowMs: NOW_MS + 40_000,
      outcome: { result: 'succeeded' },
    }],
    ['one millisecond less than the eleven-second lease runway', {
      observedNowMs: NOW_MS + 49_001,
      outcome: { result: 'retry' },
    }],
    ['lease expiry', {
      observedNowMs: NOW_MS + 60_000,
      outcome: { result: 'retry' },
    }],
  ])('rechecks %s immediately before provider I/O', async (_label, expected) => {
    const value = await fixture({ expiresAt: expected.expiresAt })
    const provider = vi.fn()
    await expect(dispatch(value, {
      nowFactory: () => expected.observedNowMs,
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual(expected.outcome)
    expect(provider).not.toHaveBeenCalled()
  })

  it('starts provider I/O with the exact eleven-second lease runway', async () => {
    const value = await fixture()
    const provider = vi.fn().mockResolvedValue({ providerId: PROVIDER_ID })
    await expect(dispatch(value, {
      nowFactory: () => NOW_MS + 49_000,
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'email-accepted', providerId: PROVIDER_ID })
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('fails closed on a wrongly AAD-bound recipient envelope', async () => {
    const cryptoContext = await context()
    const envelope = await encryptedField(
      cryptoContext,
      'inv_wrong_record',
      'email',
      'wrong-aad@example.test',
    )
    const value = await fixture({ invitationEmailEnvelope: envelope })
    const provider = vi.fn()
    await expect(dispatch(value, {
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(provider).not.toHaveBeenCalled()
  })

  it('fails closed on a wrongly AAD-bound staff envelope', async () => {
    const cryptoContext = await context()
    const envelope = await encryptedField(
      cryptoContext,
      'stf_wrong_record',
      'email',
      'wrong-staff-aad@example.test',
    )
    const value = await fixture({ staffEmailEnvelope: envelope })
    const provider = vi.fn()
    await expect(dispatch(value, {
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(provider).not.toHaveBeenCalled()
  })

  it('rejects matching but valid-looking wrong blind indexes', async () => {
    const cryptoContext = await context()
    const wrong = await blindEmailIndex('wrong-index@example.test', cryptoContext.keyring)
    const value = await fixture({
      invitationLookup: wrong,
      staffLookup: wrong,
    })
    const provider = vi.fn()
    await expect(dispatch(value, {
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(provider).not.toHaveBeenCalled()
  })

  it('requires the retained payload actor before recipient decryption or provider I/O', async () => {
    const value = await fixture({ missingActor: true, separateInviter: true })
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      cryptoContext: { ...value.cryptoContext, keyring },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'dead' })
    expect(decryptions).toBe(1)
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['a forged aggregate', (value) => ({ ...value.job, aggregate_id: 'inv_other' })],
    ['a forged aggregate type', (value) => ({
      ...value.job,
      aggregate_type: 'staff_user',
    })],
    ['a forged type', (value) => ({ ...value.job, type: 'staff.invitation.expire' })],
    ['a queued status', (value) => ({ ...value.job, status: 'queued' })],
    ['a stale attempt', (value) => ({ ...value.job, attemptNumber: 2, attempt_count: 2 })],
    ['a wrong lease owner', (value) => ({
      ...value.job,
      leaseOwner: 'lease_forged',
      lease_owner: 'lease_forged',
    })],
  ])('rejects %s before payload or recipient decryption', async (_label, patch) => {
    const value = await fixture()
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      cryptoContext: { ...value.cryptoContext, keyring },
      job: patch(value),
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'retry' })
    expect(decryptions).toBe(0)
    expect(provider).not.toHaveBeenCalled()
  })

  it('rejects an expired authoritative lease before payload or recipient decryption', async () => {
    const value = await fixture()
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      cryptoContext: { ...value.cryptoContext, keyring },
      nowMs: NOW_MS + 60_000,
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'retry' })
    expect(decryptions).toBe(0)
    expect(provider).not.toHaveBeenCalled()
  })

  it('rejects a completed authoritative attempt before payload or recipient decryption', async () => {
    const value = await fixture()
    await env.DB.prepare(
      `UPDATE outbox_attempts
       SET completed_at=?,result='succeeded'
       WHERE job_id=? AND attempt_number=1`
    ).bind(NOW, value.jobId).run()
    let decryptions = 0
    const keyring = {
      ...value.cryptoContext.keyring,
      getDataKek(version) {
        decryptions += 1
        return value.cryptoContext.keyring.getDataKek(version)
      },
    }
    const provider = vi.fn()
    await expect(dispatch(value, {
      cryptoContext: { ...value.cryptoContext, keyring },
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'retry' })
    expect(decryptions).toBe(0)
    expect(provider).not.toHaveBeenCalled()
  })

  it('bypasses development provider loading only when an injected fake is selected first', async () => {
    const injected = await fixture()
    const provider = vi.fn().mockResolvedValue({ providerId: PROVIDER_ID })
    await expect(dispatch(injected, {
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'email-accepted', providerId: PROVIDER_ID })
    expect(provider).toHaveBeenCalledTimes(1)

    const defaultProvider = await fixture()
    const fetch = vi.fn()
    await expect(dispatch(defaultProvider, {
      providers: { fetch },
      bindings: {
        SCW_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
        SCW_FROM_EMAIL: 'powiadomienia@example.test',
        SCW_FROM_NAME: 'Bear with me',
        SCW_SECRET_KEY: 'provider-secret',
      },
    })).resolves.toEqual({ result: 'dead' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['rate limited', {
      error: { code: 'EMAIL_PROVIDER_RATE_LIMITED', retryable: true, ambiguous: false },
      outcome: { result: 'retry' },
    }],
    ['rejected', {
      error: { code: 'EMAIL_PROVIDER_REJECTED', retryable: false, ambiguous: false },
      outcome: { result: 'dead' },
    }],
    ['config invalid', {
      error: { code: 'EMAIL_PROVIDER_CONFIG_INVALID', retryable: false, ambiguous: false },
      outcome: { result: 'dead' },
    }],
    ['ambiguous', {
      error: { code: 'EMAIL_DELIVERY_AMBIGUOUS', retryable: false, ambiguous: true },
      outcome: { result: 'dead', errorCode: 'EMAIL_DELIVERY_AMBIGUOUS' },
    }],
  ])('maps a fixed %s adapter error without copying its message', async (_label, expected) => {
    const value = await fixture()
    const provider = vi.fn(async () => {
      throw Object.assign(new Error(`${value.email} raw provider body`), expected.error)
    })
    await expect(dispatch(value, {
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual(expected.outcome)
  })
})

describe('accepted invitation email finalization', () => {
  it('atomically records accepted delivery, invitation version, snapshot, audit, attempt, and job', async () => {
    const value = await fixture({ separateInviter: true, actorStatus: 'disabled' })
    await expect(acceptedFinalize(value)).resolves.toBe(true)

    const invitation = await row('staff_invitations', 'id', value.invitationId)
    expect(invitation).toMatchObject({
      email_sent_at: new Date(NOW_MS + 1).toISOString(),
      version: 2,
    })
    const delivery = await row('delivery_attempts', 'outbox_job_id', value.jobId)
    expect(delivery).toMatchObject({
      provider: 'scaleway_tem',
      provider_reference: PROVIDER_ID,
      status: 'accepted',
      error_code: null,
      attempted_at: new Date(NOW_MS + 1).toISOString(),
    })
    const attempt = await row('outbox_attempts', 'job_id', value.jobId)
    expect(attempt).toMatchObject({
      completed_at: new Date(NOW_MS + 1).toISOString(),
      result: 'succeeded',
      error_code: null,
      provider_reference: PROVIDER_ID,
    })
    expect(await row('outbox_jobs', 'id', value.jobId)).toMatchObject({
      status: 'succeeded',
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: null,
    })
    const version = await env.DB.prepare(
      `SELECT * FROM record_versions
       WHERE entity_type='staff_invitation' AND entity_id=? AND version=2`
    ).bind(value.invitationId).first()
    expect(version).toMatchObject({
      changed_by_staff_id: value.actorId,
      correlation_id: value.jobId,
    })
    const snapshot = JSON.parse(await decryptForScope(
      value.cryptoContext.keyring,
      value.cryptoContext.dataKey,
      {
        expectedScope: value.cryptoContext.scope,
        recordId: value.invitationId,
        field: 'record_version',
        envelope: JSON.parse(version.snapshot_envelope),
      },
    ))
    expect(snapshot).toEqual(invitation)
    const audit = await env.DB.prepare(
      `SELECT * FROM audit_events
       WHERE action='staff.invitation.email_accepted' AND entity_id=?`
    ).bind(value.invitationId).first()
    expect(audit).toMatchObject({
      actor_staff_id: value.actorId,
      correlation_id: value.jobId,
      metadata_json: '{"invitationVersion":2}',
      reason_envelope: null,
    })

    const raw = JSON.stringify({
      invitation,
      delivery,
      attempt,
      version,
      audit,
      job: await row('outbox_jobs', 'id', value.jobId),
    })
    expect(raw).not.toContain(value.email)
    expect(raw).not.toContain(`Recipient ${serial}`)
  })

  it.each([
    [4096, true],
    [4097, false],
  ])('enforces the accepted finalizer envelope boundary at %i characters', async (
    length,
    accepted,
  ) => {
    const value = await fixture({
      invitationDisplayNameEnvelope: (envelope) => paddedEnvelope(envelope, length),
    })
    await expect(acceptedFinalize(value)).resolves.toBe(accepted)
    const delivery = await row('delivery_attempts', 'outbox_job_id', value.jobId)
    const invitation = await row('staff_invitations', 'id', value.invitationId)
    const attempt = await row('outbox_attempts', 'job_id', value.jobId)
    const job = await row('outbox_jobs', 'id', value.jobId)
    if (accepted) {
      expect(delivery).toMatchObject({ status: 'accepted' })
      expect(invitation).toMatchObject({
        email_sent_at: new Date(NOW_MS + 1).toISOString(),
        version: 2,
      })
      expect(attempt).toMatchObject({ result: 'succeeded' })
      expect(job).toMatchObject({ status: 'succeeded' })
    } else {
      expect(delivery).toBeNull()
      expect(invitation).toMatchObject({ email_sent_at: null, version: 1 })
      expect(attempt).toMatchObject({ completed_at: null, result: null })
      expect(job).toMatchObject({ status: 'processing' })
    }
  })

  it.each([
    ['wrong lease owner', { leaseOwner: 'lease_wrong' }],
    ['wrong attempt number', { attemptNumber: 2 }],
    ['expired lease', { nowMs: NOW_MS + 60_000 }],
  ])('loses cleanly for %s without partial writes', async (_label, patch) => {
    const value = await fixture()
    await expect(acceptedFinalize(value, patch)).resolves.toBe(false)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
    expect((await row('outbox_attempts', 'job_id', value.jobId)).completed_at).toBeNull()
    expect((await row('outbox_jobs', 'id', value.jobId)).status).toBe('processing')
  })

  it.each([
    ['job lease expiry', {}, NOW_MS + 60_000],
    ['invitation expiry', { expiresAt: new Date(NOW_MS + 2).toISOString() }, NOW_MS + 2],
  ])('loses cleanly when crypto/preparation crosses %s', async (_label, fixturePatch, finalNow) => {
    const value = await fixture(fixturePatch)
    await expect(acceptedFinalize(value, {
      nowFactory: () => finalNow,
    })).resolves.toBe(false)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
    expect((await row('outbox_attempts', 'job_id', value.jobId)).completed_at).toBeNull()
    expect((await row('outbox_jobs', 'id', value.jobId)).status).toBe('processing')
  })

  it('uses the real clock by default after accepted-history encryption', async () => {
    const value = await fixture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + 60_000)
    try {
      await expect(acceptedFinalize(value, { useDefaultClock: true })).resolves.toBe(false)
    } finally {
      clock.mockRestore()
    }
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
  })

  it('advances the last incrementable invitation version to the maximum safe integer', async () => {
    const initialVersion = Number.MAX_SAFE_INTEGER - 1
    const value = await fixture({ invitationVersion: initialVersion })
    await expect(acceptedFinalize(value)).resolves.toBe(true)

    const invitation = await row('staff_invitations', 'id', value.invitationId)
    expect(invitation).toMatchObject({
      email_sent_at: new Date(NOW_MS + 1).toISOString(),
      version: Number.MAX_SAFE_INTEGER,
    })
    const version = await env.DB.prepare(
      `SELECT * FROM record_versions
       WHERE entity_type='staff_invitation' AND entity_id=?`
    ).bind(value.invitationId).first()
    expect(version).toMatchObject({
      version: Number.MAX_SAFE_INTEGER,
      changed_by_staff_id: value.actorId,
      correlation_id: value.jobId,
    })
    const snapshot = JSON.parse(await decryptForScope(
      value.cryptoContext.keyring,
      value.cryptoContext.dataKey,
      {
        expectedScope: value.cryptoContext.scope,
        recordId: value.invitationId,
        field: 'record_version',
        envelope: JSON.parse(version.snapshot_envelope),
      },
    ))
    expect(snapshot).toMatchObject({
      email_sent_at: new Date(NOW_MS + 1).toISOString(),
      version: Number.MAX_SAFE_INTEGER,
    })
    expect(await env.DB.prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action='staff.invitation.email_accepted' AND entity_id=?`
    ).bind(value.invitationId).first()).toEqual({
      metadata_json: `{"invitationVersion":${Number.MAX_SAFE_INTEGER}}`,
    })
  })

  it('does not finalize a maximum-safe invitation version', async () => {
    const value = await fixture({ invitationVersion: Number.MAX_SAFE_INTEGER })
    await expect(acceptedFinalize(value)).resolves.toBe(false)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect(await row('staff_invitations', 'id', value.invitationId)).toMatchObject({
      email_sent_at: null,
      version: Number.MAX_SAFE_INTEGER,
    })
    expect((await row('outbox_attempts', 'job_id', value.jobId)).completed_at).toBeNull()
    expect((await row('outbox_jobs', 'id', value.jobId)).status).toBe('processing')
  })

  it('allows exactly one of two concurrent finalizers to win', async () => {
    const value = await fixture()
    const results = await Promise.all([
      acceptedFinalize(value, { idFactory: sequence(`email_race_a_${serial}`) }),
      acceptedFinalize(value, { idFactory: sequence(`email_race_b_${serial}`) }),
    ])
    expect(results.sort()).toEqual([false, true])
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM delivery_attempts WHERE outbox_job_id=?'
    ).bind(value.jobId).first()).count).toBe(1)
  })

  it('does not finalize accepted version A after recipient identity advances to pending version B', async () => {
    const value = await fixture()
    const provider = vi.fn().mockResolvedValue({ providerId: PROVIDER_ID })
    await expect(dispatch(value, {
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'email-accepted', providerId: PROVIDER_ID })

    const replacement = `replacement-${serial}@example.test`
    const lookup = await blindEmailIndex(replacement, value.cryptoContext.keyring)
    const staffEnvelope = await encryptedField(
      value.cryptoContext,
      value.staff.id,
      'email',
      replacement,
    )
    const invitationEnvelope = await encryptedField(
      value.cryptoContext,
      value.invitationId,
      'email',
      replacement,
    )
    await env.DB.prepare(
      `UPDATE staff_users
       SET email_lookup=?,email_envelope=?,version=version+1,updated_at=?
       WHERE id=?`
    ).bind(lookup, staffEnvelope, NOW, value.staff.id).run()
    await env.DB.prepare(
      `UPDATE staff_invitations
       SET email_lookup=?,email_envelope=?,version=version+1,updated_at=?
       WHERE id=?`
    ).bind(lookup, invitationEnvelope, NOW, value.invitationId).run()

    await expect(acceptedFinalize(value)).resolves.toBe(false)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()

    await deferOtherProcessingLeases(value.jobId)
    await expect(outbox.reapExpiredOutboxLeases(env.DB, value.cryptoContext, {
      nowMs: NOW_MS + 60_000,
      idFactory: sequence(`email_version_reaper_${serial}`),
    })).resolves.toContainEqual({ id: value.jobId, result: 'dead' })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await row('outbox_jobs', 'id', value.jobId)).toMatchObject({
      status: 'dead',
      last_error_code: 'EMAIL_DELIVERY_AMBIGUOUS',
    })
  })

  it.each([
    ['invitation version', async (value) => {
      await env.DB.prepare(
        'UPDATE staff_invitations SET version=version+1,updated_at=? WHERE id=?'
      ).bind(NOW, value.invitationId).run()
    }],
    ['invitation status', async (value) => {
      await env.DB.prepare(
        `UPDATE staff_invitations
         SET status='revoked',revoked_at=?,version=version+1,updated_at=? WHERE id=?`
      ).bind(NOW, NOW, value.invitationId).run()
    }],
    ['invitation expiry', async (value) => {
      await env.DB.prepare(
        `UPDATE staff_invitations
         SET expires_at=?,version=version+1,updated_at=? WHERE id=?`
      ).bind(NOW, NOW, value.invitationId).run()
    }],
    ['staff version', async (value) => {
      await env.DB.prepare(
        'UPDATE staff_users SET version=version+1,updated_at=? WHERE id=?'
      ).bind(NOW, value.staff.id).run()
    }],
    ['staff status', async (value) => {
      await env.DB.prepare(
        `UPDATE staff_users
         SET status='disabled',disabled_at=?,version=version+1,updated_at=? WHERE id=?`
      ).bind(NOW, NOW, value.staff.id).run()
    }],
    ['job lease ownership', async (value) => {
      await env.DB.prepare(
        `UPDATE outbox_jobs
         SET lease_owner='lease_raced',updated_at=? WHERE id=?`
      ).bind(NOW, value.jobId).run()
    }],
    ['open attempt completion', async (value) => {
      await env.DB.prepare(
        `UPDATE outbox_attempts
         SET completed_at=?,result='succeeded' WHERE job_id=? AND attempt_number=1`
      ).bind(NOW, value.jobId).run()
    }],
  ])('loses without partial writes after a %s race', async (_label, mutate) => {
    const value = await fixture()
    let raced = false
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements) {
        if (!raced) {
          raced = true
          await mutate(value)
        }
        return env.DB.batch(statements)
      },
    }
    await expect(acceptedFinalize(value, { db })).resolves.toBe(false)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('outbox_attempts', 'job_id', value.jobId)).provider_reference).toBeNull()
    expect((await row('outbox_jobs', 'id', value.jobId)).status).toBe('processing')
  })

  it('succeeds when the retained payload actor is deactivated immediately before the batch', async () => {
    const value = await fixture({ separateInviter: true })
    let raced = false
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements) {
        if (!raced) {
          raced = true
          await env.DB.prepare(
            `UPDATE staff_users
             SET status='disabled',access_subject=NULL,disabled_at=?,
                 version=version+1,updated_at=?
             WHERE id=?`
          ).bind(NOW, NOW, value.actorId).run()
        }
        return env.DB.batch(statements)
      },
    }
    await expect(acceptedFinalize(value, { db })).resolves.toBe(true)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toMatchObject({
      status: 'accepted',
      provider_reference: PROVIDER_ID,
    })
    expect((await row('staff_users', 'id', value.actorId)).status).toBe('disabled')
  })

  it('fails closed when the immutable payload actor is not retained', async () => {
    const value = await fixture({ missingActor: true, separateInviter: true })
    await expect(acceptedFinalize(value)).resolves.toBe(false)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
  })

  it.each([
    ['a malformed invitation expiry', { expiresAt: 'not-an-instant' }],
    ['a malformed invitation access instant', { accessAllowedAt: 'not-an-instant' }],
  ])('fails closed for %s before building accepted history', async (_label, patch) => {
    const value = await fixture(patch)
    await expect(acceptedFinalize(value)).resolves.toBe(false)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
  })

  it.each([
    ['job type', { type: 'staff.invitation.expire' }],
    ['job aggregate type', { aggregate_type: 'staff_user' }],
    ['job aggregate ID', { aggregate_id: 'inv_substituted' }],
    ['job payload envelope', { payload_envelope: '{}' }],
  ])('fails closed for a substituted %s fact', async (_label, patch) => {
    const value = await fixture()
    const db = {
      prepare(sql) {
        if (sql === 'SELECT * FROM outbox_jobs WHERE id=?') {
          return {
            bind(id) {
              return {
                async first() {
                  return {
                    ...await env.DB.prepare(sql).bind(id).first(),
                    ...patch,
                  }
                },
              }
            },
          }
        }
        return env.DB.prepare(sql)
      },
      batch: env.DB.batch.bind(env.DB),
    }
    await expect(acceptedFinalize(value, { db })).resolves.toBe(false)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
  })

  it.each([
    ['an extra job column', (record) => ({ ...record, extra: true })],
    ['a missing job column', (record) => {
      const { last_error_code: _removed, ...substituted } = record
      return substituted
    }],
    ['a malformed job schedule', (record) => ({
      ...record,
      scheduled_at: 'not-an-instant',
    })],
    ['a malformed job creation instant', (record) => ({
      ...record,
      created_at: 'not-an-instant',
    })],
    ['a malformed job update instant', (record) => ({
      ...record,
      updated_at: 'not-an-instant',
    })],
    ['a malformed prior error code', (record) => ({
      ...record,
      last_error_code: 'raw recipient@example.test',
    })],
  ])('fails closed for %s before building accepted history', async (_label, transform) => {
    const value = await fixture()
    const db = {
      prepare(sql) {
        const statement = env.DB.prepare(sql)
        if (sql !== 'SELECT * FROM outbox_jobs WHERE id=?') return statement
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
    }
    await expect(acceptedFinalize(value, { db })).resolves.toBe(false)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
  })

  it.each([
    ['a malformed invitation role', (record) => ({ ...record, role: 'administrator' })],
    ['a malformed inviter ID', (record) => ({ ...record, inviter_id: 'owner' })],
    ['a malformed email envelope', (record) => ({ ...record, email_envelope: '{}' })],
    ['a malformed display-name envelope', (record) => ({
      ...record,
      display_name_envelope: '{}',
    })],
  ])('fails closed for %s before building accepted history', async (_label, transform) => {
    const value = await fixture()
    const db = {
      prepare(sql) {
        const statement = env.DB.prepare(sql)
        if (sql !== 'SELECT * FROM staff_invitations WHERE id=?') return statement
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
    }
    await expect(acceptedFinalize(value, { db })).resolves.toBe(false)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
  })

  it('rolls the whole batch back when a delivery already exists for the same job', async () => {
    const value = await fixture()
    await env.DB.prepare(
      `INSERT INTO delivery_attempts
       (id,outbox_job_id,provider,provider_reference,status,error_code,attempted_at)
       VALUES (?,?,'scaleway_tem',?,'accepted',NULL,?)`
    ).bind(`delivery_existing_${serial}`, value.jobId, PROVIDER_ID, NOW).run()
    await expect(acceptedFinalize(value)).rejects.toThrow()
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM delivery_attempts WHERE outbox_job_id=?'
    ).bind(value.jobId).first()).count).toBe(1)
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
    expect((await row('outbox_attempts', 'job_id', value.jobId)).completed_at).toBeNull()
    expect((await row('outbox_jobs', 'id', value.jobId)).status).toBe('processing')
  })

  it('rolls back when each accepted-finalization statement fails', async () => {
    for (let failedIndex = 0; failedIndex < 7; failedIndex += 1) {
      const value = await fixture()
      const db = {
        prepare: env.DB.prepare.bind(env.DB),
        batch(statements) {
          expect(statements).toHaveLength(7)
          const forced = [...statements]
          forced[failedIndex] = env.DB.prepare(
            "INSERT INTO outbox_operation_guard_failures (operation_id) VALUES ('forced_email_finalize')"
          )
          return env.DB.batch(forced)
        },
      }
      await expect(acceptedFinalize(value, {
        db,
        idFactory: sequence(`email_failure_${failedIndex}_${serial}`),
      })).resolves.toBe(false)
      expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
      expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
      expect((await row('outbox_attempts', 'job_id', value.jobId)).completed_at).toBeNull()
      expect((await row('outbox_jobs', 'id', value.jobId)).status).toBe('processing')
    }
  })
})

describe('accepted-but-unresolved processing and reaping', () => {
  it.each([
    ['invitation expiry', {
      expiresAt: new Date(NOW_MS + 40_000).toISOString(),
      observedNowMs: NOW_MS + 40_000,
      expectedJob: { status: 'succeeded', last_error_code: null },
      expectedResult: 'succeeded',
    }],
    ['provider runway', {
      observedNowMs: NOW_MS + 49_001,
      expectedJob: { status: 'queued', last_error_code: 'OUTBOX_HANDLER_RETRY' },
      expectedResult: 'retry',
    }],
  ])('processor rechecks delayed %s before provider I/O', async (_label, expected) => {
    const value = await fixture({
      expiresAt: expected.expiresAt,
      processing: false,
    })
    const provider = vi.fn()
    let clockCalls = 0
    await expect(outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext: value.cryptoContext,
      config: { appEnv: 'development', appOrigin: 'http://127.0.0.1:5174' },
      nowMs: NOW_MS,
      nowFactory: () => (clockCalls++ === 0 ? NOW_MS : expected.observedNowMs),
      idFactory: sequence(`email_pre_io_clock_id_${serial}`),
      leaseOwnerFactory: sequence(`email_pre_io_clock_lease_${serial}`),
      dispatch: (input) => handlers.dispatchOutboxJob({
        ...input,
        providers: { sendInvitationEmail: provider },
      }),
    })).resolves.toContainEqual({
      id: value.jobId,
      result: expected.expectedResult,
    })
    expect(provider).not.toHaveBeenCalled()
    expect(await row('outbox_jobs', 'id', value.jobId)).toMatchObject(expected.expectedJob)
  })

  it.each([
    ['job lease expiry', {}, [NOW_MS, NOW_MS + 1, NOW_MS + 60_000]],
    ['invitation expiry', { expiresAt: new Date(NOW_MS + 2).toISOString() }, [
      NOW_MS,
      NOW_MS + 1,
      NOW_MS + 2,
    ]],
  ])('keeps processor evidence unresolved when finalizer preparation crosses %s', async (
    _label,
    fixturePatch,
    times,
  ) => {
    const value = await fixture({ ...fixturePatch, processing: false })
    let clockIndex = 0
    await expect(outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext: value.cryptoContext,
      config: {},
      nowMs: NOW_MS,
      nowFactory: () => times[Math.min(clockIndex++, times.length - 1)],
      idFactory: sequence(`email_clock_id_${serial}`),
      leaseOwnerFactory: sequence(`email_clock_lease_${serial}`),
      dispatch: async () => ({
        result: 'email-accepted',
        providerId: PROVIDER_ID,
      }),
    })).resolves.toEqual([])
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
    expect((await row('outbox_attempts', 'job_id', value.jobId)).completed_at).toBeNull()
    expect((await row('outbox_jobs', 'id', value.jobId)).status).toBe('processing')
  })

  it('treats an accepted fact from a non-email job as a generic handler failure', async () => {
    const cryptoContext = await context()
    const jobId = `job_cross_type_${++serial}`
    const invitationId = `inv_cross_type_${serial}`
    const statement = await outbox.enqueueOutboxStatement(env.DB, cryptoContext, {
      id: jobId,
      type: 'staff.invitation.expire',
      aggregateType: 'staff_invitation',
      aggregateId: invitationId,
      payload: { actorId: `stf_cross_type_${serial}`, invitationId },
      idempotencyKey: `staff.invitation.expire:cross-type-${serial}`,
      scheduledAt: NOW,
      nowMs: NOW_MS,
    })
    await statement.run()
    await expect(outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext,
      config: {},
      nowMs: NOW_MS,
      nowFactory: () => NOW_MS + 1,
      idFactory: sequence(`email_cross_type_id_${serial}`),
      leaseOwnerFactory: sequence(`email_cross_type_lease_${serial}`),
      dispatch: async () => ({
        result: 'email-accepted',
        providerId: PROVIDER_ID,
      }),
    })).resolves.toContainEqual({ id: jobId, result: 'dead' })
    expect(await row('delivery_attempts', 'outbox_job_id', jobId)).toBeNull()
    expect(await row('outbox_jobs', 'id', jobId)).toMatchObject({
      status: 'dead',
      last_error_code: 'OUTBOX_HANDLER_FAILURE',
    })
  })

  it.each([
    ['an extra key', {
      result: 'email-accepted',
      providerId: PROVIDER_ID,
      providerReference: PROVIDER_ID,
    }],
    ['an invalid provider UUID', {
      result: 'email-accepted',
      providerId: 'provider-not-a-uuid',
    }],
    ['a missing provider UUID', {
      result: 'email-accepted',
    }],
    ['a non-plain object', Object.assign(
      Object.create({ inherited: true }),
      { result: 'email-accepted', providerId: PROVIDER_ID },
    )],
  ])('rejects %s accepted fact without entering the dedicated finalizer', async (_label, fact) => {
    const value = await fixture({ processing: false })
    await expect(outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext: value.cryptoContext,
      config: {},
      nowMs: NOW_MS,
      nowFactory: () => NOW_MS + 1,
      idFactory: sequence(`email_malformed_id_${serial}`),
      leaseOwnerFactory: sequence(`email_malformed_lease_${serial}`),
      dispatch: async () => fact,
    })).resolves.toContainEqual({ id: value.jobId, result: 'dead' })
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('staff_invitations', 'id', value.invitationId)).email_sent_at).toBeNull()
    expect(await row('outbox_jobs', 'id', value.jobId)).toMatchObject({
      status: 'dead',
      last_error_code: 'OUTBOX_HANDLER_FAILURE',
    })
  })

  it('reaps an accepted response after a crash before finalizer entry without redispatching', async () => {
    const value = await fixture()
    const provider = vi.fn().mockResolvedValue({ providerId: PROVIDER_ID })
    await expect(dispatch(value, {
      providers: { sendInvitationEmail: provider },
    })).resolves.toEqual({ result: 'email-accepted', providerId: PROVIDER_ID })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()

    await deferOtherProcessingLeases(value.jobId)
    await expect(outbox.reapExpiredOutboxLeases(env.DB, value.cryptoContext, {
      nowMs: NOW_MS + 60_000,
      idFactory: sequence(`email_pre_finalize_crash_${serial}`),
    })).resolves.toContainEqual({ id: value.jobId, result: 'dead' })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await row('outbox_jobs', 'id', value.jobId)).toMatchObject({
      status: 'dead',
      last_error_code: 'EMAIL_DELIVERY_AMBIGUOUS',
    })
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM operational_actions
       WHERE entity_type='outbox_job' AND entity_id=? AND status='open'`
    ).bind(value.jobId).first()).count).toBe(1)
  })

  it('leaves accepted delivery unresolved when finalization throws, then reaps once without resending', async () => {
    const value = await fixture({ processing: false })
    const provider = vi.fn().mockResolvedValue({
      result: 'email-accepted',
      providerId: PROVIDER_ID,
    })
    let batches = 0
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch(statements) {
        batches += 1
        if (batches === 2) throw new Error('forced accepted finalizer failure')
        return env.DB.batch(statements)
      },
    }
    const completed = await outbox.processOutboxBatch({
      db,
      cryptoContext: value.cryptoContext,
      config: {},
      nowMs: NOW_MS,
      nowFactory: () => NOW_MS + 1,
      idFactory: sequence(`email_processor_id_${serial}`),
      leaseOwnerFactory: sequence(`email_processor_lease_${serial}`),
      dispatch: provider,
    })
    expect(completed).toEqual([])
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('outbox_jobs', 'id', value.jobId)).status).toBe('processing')
    expect((await row('outbox_attempts', 'job_id', value.jobId)).completed_at).toBeNull()

    await deferOtherProcessingLeases(value.jobId)
    await expect(outbox.reapExpiredOutboxLeases(env.DB, value.cryptoContext, {
      nowMs: NOW_MS + 60_000,
      idFactory: sequence(`email_reaper_${serial}`),
    })).resolves.toContainEqual({ id: value.jobId, result: 'dead' })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await row('outbox_jobs', 'id', value.jobId)).toMatchObject({
      status: 'dead',
      last_error_code: 'EMAIL_DELIVERY_AMBIGUOUS',
    })
    expect(await row('outbox_attempts', 'job_id', value.jobId)).toMatchObject({
      result: 'dead',
      error_code: 'EMAIL_DELIVERY_AMBIGUOUS',
      provider_reference: null,
    })
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM operational_actions
       WHERE entity_type='outbox_job' AND entity_id=? AND status='open'`
    ).bind(value.jobId).first()).count).toBe(1)

    await expect(outbox.reapExpiredOutboxLeases(env.DB, value.cryptoContext, {
      nowMs: NOW_MS + 60_001,
      idFactory: sequence(`email_reaper_second_${serial}`),
    })).resolves.toEqual([])
    await expect(outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext: value.cryptoContext,
      config: {},
      nowMs: NOW_MS + 60_001,
      idFactory: sequence(`email_processor_second_id_${serial}`),
      leaseOwnerFactory: sequence(`email_processor_second_lease_${serial}`),
      dispatch: provider,
    })).resolves.toEqual([])
    expect(provider).toHaveBeenCalledTimes(1)
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM operational_actions
       WHERE entity_type='outbox_job' AND entity_id=? AND status='open'`
    ).bind(value.jobId).first()).count).toBe(1)
  })

  it('does not fall through to generic finalization when the accepted finalizer loses its guard', async () => {
    const value = await fixture({ processing: false })
    let clockCalls = 0
    const completed = await outbox.processOutboxBatch({
      db: env.DB,
      cryptoContext: value.cryptoContext,
      config: {},
      nowMs: NOW_MS,
      nowFactory: () => (clockCalls++ === 0 ? NOW_MS : NOW_MS + 60_000),
      idFactory: sequence(`email_guard_id_${serial}`),
      leaseOwnerFactory: sequence(`email_guard_lease_${serial}`),
      dispatch: async () => ({
        result: 'email-accepted',
        providerId: PROVIDER_ID,
      }),
    })
    expect(completed).toEqual([])
    expect(await row('delivery_attempts', 'outbox_job_id', value.jobId)).toBeNull()
    expect((await row('outbox_jobs', 'id', value.jobId)).status).toBe('processing')
    expect((await row('outbox_attempts', 'job_id', value.jobId)).completed_at).toBeNull()
  })
})
