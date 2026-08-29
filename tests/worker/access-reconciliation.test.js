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
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { NOW_MS } from './fixtures.js'

const NOW = new Date(NOW_MS).toISOString()
const FUTURE = new Date(NOW_MS + 86_400_000).toISOString()
const PAST = new Date(NOW_MS - 1).toISOString()
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const EMPTY_FINGERPRINT = 'BYDlKyUUBNO-3cX7_bRPY-TkArudTPGjIdbwtAdLSCw'
let serial = 0
let reconcileSerial = 0

const sequence = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

const correlationSequence = () => {
  let count = 0
  return () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}`
}

const clockSequence = (...values) => {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

async function context() {
  serial += 1
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: `key_access_b2_${serial}`,
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
  displayName = 'Access Test',
  role = 'coordinator',
  status = 'pending',
  lookup = null,
}) {
  const activatedAt = status === 'active' ? NOW : null
  const disabledAt = status === 'disabled' ? NOW : null
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`
  ).bind(
    id,
    lookup ?? await blindEmailIndex(email, cryptoContext.keyring),
    await encryptedField(cryptoContext, id, 'email', email),
    await encryptedField(cryptoContext, id, 'display_name', displayName),
    role,
    status,
    status === 'active' ? `subject_${id}` : null,
    role === 'specialist' ? `sp_${id.slice(4)}` : null,
    activatedAt,
    disabledAt,
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
  status = 'provisioning',
  expiresAt = FUTURE,
  lookup = null,
  version = 1,
}) {
  const accessAllowedAt = ['pending', 'activated'].includes(status) ? NOW : null
  const revokedAt = status === 'revoked' ? NOW : null
  const activatedAt = status === 'activated' ? NOW : null
  await env.DB.prepare(
    `INSERT INTO staff_invitations
     (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,inviter_id,
      expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,version,created_at,updated_at)
     VALUES (?,?,?,?,?,'coordinator',?,?,?,?,NULL,?,?,?,?,?)`
  ).bind(
    id,
    staffId,
    lookup ?? await blindEmailIndex(email, cryptoContext.keyring),
    await encryptedField(cryptoContext, id, 'email', email),
    await encryptedField(cryptoContext, id, 'display_name', 'Invitation Test'),
    status,
    inviterId,
    expiresAt,
    accessAllowedAt,
    activatedAt,
    revokedAt,
    version,
    NOW,
    NOW,
  ).run()
  return env.DB.prepare('SELECT * FROM staff_invitations WHERE id=?').bind(id).first()
}

async function setState(key, value) {
  const row = await env.DB.prepare('SELECT version FROM system_state WHERE key=?').bind(key).first()
  await env.DB.prepare(
    'UPDATE system_state SET value_json=?,version=version+1,updated_at=? WHERE key=? AND version=?'
  ).bind(JSON.stringify(value), NOW, key, row.version).run()
}

async function resetAccessState() {
  await setState('access.desired_generation', { generation: 0 })
  await setState('access.applied_generation', {
    fingerprint: EMPTY_FINGERPRINT,
    generation: 0,
  })
  await setState('access.reconcile.lease', {
    expiresAt: null,
    nonce: null,
    owner: null,
  })
}

async function retirePriorCandidates(retainedId) {
  const rows = (await env.DB.prepare(
    "SELECT id,status,version FROM staff_users WHERE status IN ('active','pending') AND id!=? ORDER BY id"
  ).bind(retainedId).all()).results
  for (const row of rows) {
    await env.DB.prepare(
      `UPDATE staff_users
       SET status='disabled',disabled_at=?,version=version+1,updated_at=?
       WHERE id=? AND status=? AND version=?`
    ).bind(NOW, NOW, row.id, row.status, row.version).run()
  }
}

async function seedJob(cryptoContext, {
  id,
  type,
  aggregateType,
  aggregateId,
  payload,
  idempotencyKey,
  scheduledAt = NOW,
}) {
  const statement = await outbox.enqueueOutboxStatement(env.DB, cryptoContext, {
    id,
    type,
    aggregateType,
    aggregateId,
    payload,
    idempotencyKey,
    scheduledAt,
    nowMs: NOW_MS,
  })
  await statement.run()
  return env.DB.prepare('SELECT * FROM outbox_jobs WHERE id=?').bind(id).first()
}

async function claimJob(id) {
  const claims = await outbox.claimDueJobs(env.DB, {
    nowMs: NOW_MS,
    idFactory: sequence(`attempt_${id}`),
    leaseOwnerFactory: sequence(`claim_${id}`),
    limit: 10,
  })
  return claims.find((claim) => claim.id === id)
}

async function decryptJobPayload(cryptoContext, row) {
  return JSON.parse(await decryptForScope(
    cryptoContext.keyring,
    cryptoContext.dataKey,
    {
      expectedScope: cryptoContext.scope,
      recordId: row.id,
      field: 'job_payload',
      envelope: JSON.parse(row.payload_envelope),
    },
  ))
}

const reconcileInput = (cryptoContext, payload, overrides = {}) => {
  reconcileSerial += 1
  const call = reconcileSerial
  return {
    db: overrides.db ?? env.DB,
    cryptoContext,
    config: overrides.config ?? { appEnv: 'development' },
    bindings: overrides.bindings,
    payload,
    nowMs: overrides.nowMs ?? NOW_MS,
    providers: overrides.providers ?? {
      reconcileAccessGroup: vi.fn().mockResolvedValue({ emails: [] }),
    },
    idFactory: overrides.idFactory ?? sequence(`access_${serial}_${call}`),
    leaseOwnerFactory: overrides.leaseOwnerFactory ?? sequence(`lease_owner_${serial}_${call}`),
    leaseNonceFactory: overrides.leaseNonceFactory ?? sequence(`lease_nonce_${serial}_${call}`),
    correlationIdFactory: overrides.correlationIdFactory ?? correlationSequence(),
    nowFactory: overrides.nowFactory ?? (() => overrides.nowMs ?? NOW_MS),
  }
}

function meteredDb(real, { rejectPublication = false } = {}) {
  let statements = 0
  let maxBindings = 0
  const wrap = (inner, sql) => ({
    __inner: inner,
    __sql: sql,
    bind(...values) {
      maxBindings = Math.max(maxBindings, values.length)
      return wrap(inner.bind(...values), sql)
    },
    run() {
      statements += 1
      return inner.run()
    },
    first(column) {
      statements += 1
      return inner.first(column)
    },
    all() {
      statements += 1
      return inner.all()
    },
    raw(options) {
      statements += 1
      return inner.raw(options)
    },
  })
  return {
    db: {
      prepare(sql) {
        return wrap(real.prepare(sql), sql)
      },
      batch(batchStatements) {
        statements += batchStatements.length
        const publication = batchStatements.some((statement) => (
          statement.__sql?.includes("action='staff.access.reconciled'")
        ))
        if (rejectPublication && publication) {
          throw new Error('outbox_operation_guard_failed: SQLITE_CONSTRAINT')
        }
        return real.batch(batchStatements.map((statement) => statement.__inner ?? statement))
      },
    },
    usage: () => ({ maxBindings, statements }),
  }
}

describe('authoritative Access desired membership', () => {
  it('admits the exact protected staging role alias only in staging', async () => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_staging_owner_${serial}`,
      email: 'kontakt@bearwithme.pl',
      role: 'owner',
      status: 'active',
    })
    await retirePriorCandidates(owner.id)

    await expect(handlers.desiredAccessMembership(
      env.DB,
      cryptoContext,
      NOW_MS,
      'staging',
    )).resolves.toMatchObject({
      emails: ['kontakt@bearwithme.pl'],
    })
    await expect(handlers.desiredAccessMembership(
      env.DB,
      cryptoContext,
      NOW_MS,
      'production',
    )).rejects.toThrow(/^ACCESS_DESIRED_STATE_INVALID$/)
  })

  it('returns normalized sorted membership and the exact blind-index fingerprint vector', async () => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: 'stf_access_anna',
      email: 'anna@example.test',
      role: 'owner',
      status: 'active',
    })
    await retirePriorCandidates(owner.id)
    await seedStaff(cryptoContext, {
      id: 'stf_access_zoe',
      email: 'zoe@example.test',
      status: 'pending',
    })
    await seedInvitation(cryptoContext, {
      id: 'inv_access_zoe',
      staffId: 'stf_access_zoe',
      inviterId: owner.id,
      email: 'zoe@example.test',
    })
    await seedStaff(cryptoContext, {
      id: 'stf_access_disabled',
      email: 'disabled@example.test',
      status: 'disabled',
    })
    await seedStaff(cryptoContext, {
      id: 'stf_access_expired',
      email: 'expired@example.test',
      status: 'pending',
    })
    await seedInvitation(cryptoContext, {
      id: 'inv_access_expired',
      staffId: 'stf_access_expired',
      inviterId: owner.id,
      email: 'expired@example.test',
      expiresAt: PAST,
    })

    await expect(handlers.desiredAccessMembership(env.DB, cryptoContext, NOW_MS)).resolves.toEqual({
      emails: ['anna@example.test', 'zoe@example.test'],
      fingerprint: 'Z7IYUwfofL0grYjfZzg6E75F4eSJJk_AYjwetnGvfnA',
      provisioningInvitations: [{
        id: 'inv_access_zoe',
        staffId: 'stf_access_zoe',
        version: 1,
      }],
    })
  })

  it('reads staff and invitation candidates through one D1 batch snapshot', async () => {
    const cryptoContext = await context()
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: vi.fn(env.DB.batch.bind(env.DB)),
    }
    await handlers.desiredAccessMembership(db, cryptoContext, NOW_MS)
    expect(db.batch).toHaveBeenCalledTimes(1)
    expect(db.batch.mock.calls[0][0]).toHaveLength(2)
  })

  it('returns the contract fingerprint for an empty desired set', async () => {
    expect(await handlers.accessDesiredFingerprint([])).toBe(EMPTY_FINGERPRINT)
  })

  it('fails closed when two included identities share one valid blind lookup', async () => {
    const cryptoContext = await context()
    const lookupDigest = new Uint8Array(32).fill(9)
    const lookup = `v1:${encodeBase64Url(lookupDigest)}`
    const staffRows = await Promise.all([
      {
        id: `stf_access_collision_first_${serial}`,
        email: `collision-first-${serial}@example.test`,
      },
      {
        id: `stf_access_collision_second_${serial}`,
        email: `collision-second-${serial}@example.test`,
      },
    ].map(async ({ id, email }) => ({
      id,
      email_lookup: lookup,
      email_envelope: await encryptedField(cryptoContext, id, 'email', email),
      status: 'active',
      version: 1,
    })))
    const db = {
      prepare: vi.fn((sql) => ({ sql })),
      batch: vi.fn().mockResolvedValue([
        { results: staffRows },
        { results: [] },
      ]),
    }
    const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(
      async () => new Uint8Array(32).fill(9).buffer,
    )
    try {
      await expect(handlers.desiredAccessMembership(
        db,
        cryptoContext,
        NOW_MS,
      )).rejects.toThrow(/^ACCESS_DESIRED_STATE_INVALID$/)
      expect(sign).toHaveBeenCalledTimes(2)
    } finally {
      sign.mockRestore()
      lookupDigest.fill(0)
    }
  })

  it.each([
    ['mismatched encrypted staff/invitation emails', async (cryptoContext, owner) => {
      await seedStaff(cryptoContext, {
        id: 'stf_access_mismatch',
        email: 'staff-mismatch@example.test',
      })
      await seedInvitation(cryptoContext, {
        id: 'inv_access_mismatch',
        staffId: 'stf_access_mismatch',
        inviterId: owner.id,
        email: 'invitation-mismatch@example.test',
      })
    }],
    ['mismatched blind lookup indexes', async (cryptoContext, owner) => {
      await seedStaff(cryptoContext, {
        id: 'stf_access_lookup',
        email: 'lookup@example.test',
      })
      await seedInvitation(cryptoContext, {
        id: 'inv_access_lookup',
        staffId: 'stf_access_lookup',
        inviterId: owner.id,
        email: 'lookup@example.test',
        lookup: await blindEmailIndex('other@example.test', cryptoContext.keyring),
      })
    }],
    ['a blind-index collision between different canonical emails', async (cryptoContext, owner) => {
      const lookup = await blindEmailIndex('collision-a@example.test', cryptoContext.keyring)
      await seedStaff(cryptoContext, {
        id: 'stf_access_collision',
        email: 'collision-a@example.test',
        lookup,
      })
      await seedInvitation(cryptoContext, {
        id: 'inv_access_collision',
        staffId: 'stf_access_collision',
        inviterId: owner.id,
        email: 'collision-b@example.test',
        lookup,
      })
    }],
    ['a malformed candidate envelope', async (cryptoContext) => {
      await seedStaff(cryptoContext, {
        id: 'stf_access_malformed',
        email: 'malformed@example.test',
        status: 'active',
      })
      await env.DB.prepare(
        'UPDATE staff_users SET email_envelope=?,version=version+1,updated_at=? WHERE id=?'
      ).bind('{}', NOW, 'stf_access_malformed').run()
    }],
    ['an active row with an ambiguous open invitation', async (cryptoContext, owner) => {
      await seedStaff(cryptoContext, {
        id: 'stf_access_ambiguous',
        email: 'ambiguous@example.test',
        status: 'active',
      })
      await seedInvitation(cryptoContext, {
        id: 'inv_access_ambiguous',
        staffId: 'stf_access_ambiguous',
        inviterId: owner.id,
        email: 'ambiguous@example.test',
      })
    }],
    ['an active candidate outside the fictional email domain', async (cryptoContext) => {
      await seedStaff(cryptoContext, {
        id: 'stf_access_external_active',
        email: 'external@invalid.example',
        status: 'active',
      })
    }],
    ['a pending candidate outside the fictional email domain', async (cryptoContext, owner) => {
      await seedStaff(cryptoContext, {
        id: 'stf_access_external_pending',
        email: 'external-pending@invalid.example',
      })
      await seedInvitation(cryptoContext, {
        id: 'inv_access_external_pending',
        staffId: 'stf_access_external_pending',
        inviterId: owner.id,
        email: 'external-pending@invalid.example',
      })
    }],
  ])('fails closed before provider I/O for %s', async (_label, arrange) => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_access_owner_${serial}`,
      email: `access-owner-${serial}@example.test`,
      role: 'owner',
      status: 'active',
    })
    await retirePriorCandidates(owner.id)
    await arrange(cryptoContext, owner)
    const provider = vi.fn()
    await expect(handlers.handleAccessReconcile(reconcileInput(
      cryptoContext,
      { actorId: owner.id, generation: 0 },
      { providers: { reconcileAccessGroup: provider } },
    ))).rejects.toThrow(/^ACCESS_DESIRED_STATE_INVALID$/)
    expect(provider).not.toHaveBeenCalled()
  })
})

describe('singleton Access reconciliation lease', () => {
  it('has one CAS winner and never reclaims an unexpired owner early', async () => {
    await resetAccessState()
    const owners = sequence('singleton_owner')
    const nonces = sequence('singleton_nonce')
    const attempts = await Promise.all([
      handlers.acquireAccessReconcileLease({
        db: env.DB,
        nowMs: NOW_MS,
        ownerFactory: owners,
        nonceFactory: nonces,
      }),
      handlers.acquireAccessReconcileLease({
        db: env.DB,
        nowMs: NOW_MS,
        ownerFactory: owners,
        nonceFactory: nonces,
      }),
    ])
    expect(attempts.filter(Boolean)).toHaveLength(1)
    expect(attempts.find(Boolean)).toMatchObject({
      expiresAt: new Date(NOW_MS + 60_000).toISOString(),
    })
    await expect(handlers.acquireAccessReconcileLease({
      db: env.DB,
      nowMs: NOW_MS + 59_999,
      ownerFactory: owners,
      nonceFactory: nonces,
    })).resolves.toBeNull()
  })

  it.each([
    ['missing desired state', async () => {
      const db = {
        prepare(sql) {
          if (sql.includes('FROM system_state') && sql.includes('key=?')) {
            return env.DB.prepare(sql.replace('WHERE key=?', "WHERE key=? AND key!='access.desired_generation'"))
          }
          return env.DB.prepare(sql)
        },
        batch: env.DB.batch.bind(env.DB),
      }
      return db
    }],
    ['malformed desired state', async () => {
      await setState('access.desired_generation', { generation: -1 })
      return env.DB
    }],
    ['malformed applied state', async () => {
      await setState('access.applied_generation', { fingerprint: 'not-base64url', generation: 0 })
      return env.DB
    }],
    ['malformed lease state', async () => {
      await setState('access.reconcile.lease', { owner: null, nonce: null, expiresAt: null, extra: true })
      return env.DB
    }],
  ])('fails closed for %s', async (_label, arrange) => {
    await resetAccessState()
    const db = await arrange()
    const cryptoContext = await context()
    await expect(handlers.handleAccessReconcile(reconcileInput(
      cryptoContext,
      { actorId: 'stf_access_owner', generation: 0 },
      { db },
    ))).rejects.toThrow(/^ACCESS_RECONCILE_STATE_INVALID$/)
  })
})

describe('guarded Access reconciliation publication', () => {
  async function provisioningFixture() {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_publication_owner_${serial}`,
      email: `publication-owner-${serial}@example.test`,
      role: 'owner',
      status: 'active',
    })
    await retirePriorCandidates(owner.id)
    const staff = await seedStaff(cryptoContext, {
      id: `stf_publication_staff_${serial}`,
      email: `publication-staff-${serial}@example.test`,
      status: 'pending',
    })
    const invitation = await seedInvitation(cryptoContext, {
      id: `inv_publication_${serial}`,
      staffId: staff.id,
      inviterId: owner.id,
      email: `publication-staff-${serial}@example.test`,
    })
    await resetAccessState()
    await setState('access.desired_generation', { generation: 1 })
    return { cryptoContext, owner, staff, invitation }
  }

  async function provisioningQueue(count) {
    const fixture = await provisioningFixture()
    const invitations = [fixture.invitation]
    for (let index = 1; index < count; index += 1) {
      const suffix = `${String(index).padStart(2, '0')}_${serial}`
      const email = `publication-chunk-${suffix}@example.test`
      const staff = await seedStaff(fixture.cryptoContext, {
        id: `stf_publication_chunk_${suffix}`,
        email,
        status: 'pending',
      })
      invitations.push(await seedInvitation(fixture.cryptoContext, {
        id: `inv_publication_chunk_${suffix}`,
        staffId: staff.id,
        inviterId: fixture.owner.id,
        email,
      }))
    }
    return {
      ...fixture,
      invitations: invitations.toSorted((left, right) => left.id.localeCompare(right.id)),
    }
  }

  it('atomically applies state, versions invitations, audits, and enqueues encrypted email jobs', async () => {
    const fixture = await provisioningFixture()
    const provider = vi.fn().mockResolvedValue({ emails: [] })
    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      { providers: { reconcileAccessGroup: provider } },
    ))).resolves.toEqual({ result: 'succeeded' })

    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider.mock.calls[0][0].emails).toEqual([
      `publication-owner-${serial}@example.test`,
      `publication-staff-${serial}@example.test`,
    ])
    expect(provider.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(15_000)

    const [applied, lease, invitation, versions, audits, jobs] = await Promise.all([
      env.DB.prepare("SELECT * FROM system_state WHERE key='access.applied_generation'").first(),
      env.DB.prepare("SELECT * FROM system_state WHERE key='access.reconcile.lease'").first(),
      env.DB.prepare('SELECT * FROM staff_invitations WHERE id=?').bind(fixture.invitation.id).first(),
      env.DB.prepare("SELECT * FROM record_versions WHERE entity_type='staff_invitation' AND entity_id=?").bind(fixture.invitation.id).all(),
      env.DB.prepare("SELECT * FROM audit_events WHERE action='staff.access.reconciled'").all(),
      env.DB.prepare("SELECT * FROM outbox_jobs WHERE type='staff.invitation.email'").all(),
    ])
    expect(JSON.parse(applied.value_json)).toMatchObject({ generation: 1 })
    expect(JSON.parse(applied.value_json).fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.parse(lease.value_json)).toEqual({ expiresAt: null, nonce: null, owner: null })
    expect(invitation).toMatchObject({
      status: 'pending',
      version: 2,
      access_allowed_at: NOW,
    })
    expect(versions.results).toHaveLength(1)
    expect(versions.results[0]).toMatchObject({
      version: 2,
      changed_by_staff_id: fixture.owner.id,
    })
    expect(audits.results).toHaveLength(1)
    expect(audits.results[0]).toMatchObject({
      actor_staff_id: fixture.owner.id,
      entity_type: 'access_group',
      entity_id: 'centre_1',
      reason_envelope: null,
    })
    expect(JSON.parse(audits.results[0].metadata_json)).toEqual({
      desiredGeneration: 1,
      appliedGeneration: 1,
      invitationCount: 1,
    })
    expect(jobs.results).toHaveLength(1)
    expect(jobs.results[0]).toMatchObject({
      aggregate_type: 'staff_invitation',
      aggregate_id: fixture.invitation.id,
      idempotency_key: `staff.invitation.email:${fixture.invitation.id}:2`,
      status: 'queued',
    })
    expect(await decryptJobPayload(fixture.cryptoContext, jobs.results[0])).toEqual({
      actorId: fixture.owner.id,
      invitationId: fixture.invitation.id,
    })
    expect(JSON.stringify({ versions, jobs })).not.toContain(`publication-staff-${serial}@example.test`)
  })

  it('releases and succeeds without provider I/O when the desired generation is already applied', async () => {
    const fixture = await provisioningFixture()
    const desired = await handlers.desiredAccessMembership(env.DB, fixture.cryptoContext, NOW_MS)
    await setState('access.applied_generation', {
      fingerprint: desired.fingerprint,
      generation: 1,
    })
    const provider = vi.fn()
    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      { providers: { reconcileAccessGroup: provider } },
    ))).resolves.toEqual({ result: 'succeeded' })
    expect(provider).not.toHaveBeenCalled()
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.reconcile.lease'"
    ).first()).value_json)).toEqual({ expiresAt: null, nonce: null, owner: null })
  })

  it('refreshes expired membership before treating a generation as already applied', async () => {
    const fixture = await provisioningFixture()
    const expiresAt = new Date(NOW_MS + 30_000).toISOString()
    await env.DB.prepare(
      `UPDATE staff_invitations
       SET expires_at=?,version=version+1,updated_at=?
       WHERE id=? AND status='provisioning' AND version=1`
    ).bind(expiresAt, NOW, fixture.invitation.id).run()
    const desired = await handlers.desiredAccessMembership(
      env.DB,
      fixture.cryptoContext,
      NOW_MS,
    )
    await setState('access.applied_generation', {
      fingerprint: desired.fingerprint,
      generation: 1,
    })
    const provider = vi.fn()

    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        providers: { reconcileAccessGroup: provider },
        nowFactory: () => NOW_MS + 30_000,
      },
    ))).resolves.toEqual({ result: 'retry' })

    expect(provider).not.toHaveBeenCalled()
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({
      fingerprint: desired.fingerprint,
      generation: 1,
    })
  })

  it('rejects an already-pending invitation that expires at the publication guard', async () => {
    const fixture = await provisioningFixture()
    const expiresAt = new Date(NOW_MS + 30_000).toISOString()
    await env.DB.prepare(
      `UPDATE staff_invitations
       SET status='pending',access_allowed_at=?,expires_at=?,version=version+1,updated_at=?
       WHERE id=? AND status='provisioning' AND version=1`
    ).bind(NOW, expiresAt, NOW, fixture.invitation.id).run()
    const provider = vi.fn().mockResolvedValue({ emails: [] })

    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        providers: { reconcileAccessGroup: provider },
        nowFactory: clockSequence(
          NOW_MS,
          NOW_MS,
          NOW_MS,
          NOW_MS + 30_000,
        ),
      },
    ))).resolves.toEqual({ result: 'retry' })

    expect(provider).toHaveBeenCalledTimes(1)
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
    expect(await env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
      .bind(fixture.invitation.id).first()).toEqual({ status: 'pending', version: 2 })
  })

  it('mechanically rejects an already-pending invitation changed before publication', async () => {
    const fixture = await provisioningFixture()
    await env.DB.prepare(
      `UPDATE staff_invitations
       SET status='pending',access_allowed_at=?,version=version+1,updated_at=?
       WHERE id=? AND status='provisioning' AND version=1`
    ).bind(NOW, NOW, fixture.invitation.id).run()
    const before = {
      audits: (await env.DB.prepare(
        `SELECT count(*) AS count FROM audit_events
         WHERE action='staff.access.reconciled' AND actor_staff_id=?`
      ).bind(fixture.owner.id).first()).count,
      jobs: (await env.DB.prepare(
        `SELECT count(*) AS count FROM outbox_jobs
         WHERE type='staff.invitation.email' AND aggregate_id=?`
      ).bind(fixture.invitation.id).first()).count,
      versions: (await env.DB.prepare(
        `SELECT count(*) AS count FROM record_versions
         WHERE entity_type='staff_invitation' AND entity_id=?`
      ).bind(fixture.invitation.id).first()).count,
    }
    let batches = 0
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: vi.fn(async (statements) => {
        batches += 1
        if (batches === 4) {
          await env.DB.prepare(
            `UPDATE staff_invitations
             SET status='revoked',revoked_at=?,version=version+1,updated_at=?
             WHERE id=? AND status='pending' AND version=2`
          ).bind(NOW, NOW, fixture.invitation.id).run()
        }
        return env.DB.batch(statements)
      }),
    }
    const provider = vi.fn().mockResolvedValue({ emails: [] })

    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        db,
        providers: { reconcileAccessGroup: provider },
      },
    ))).resolves.toEqual({ result: 'retry' })

    expect(batches).toBe(4)
    expect(provider).toHaveBeenCalledTimes(1)
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
    expect(await env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
      .bind(fixture.invitation.id).first()).toEqual({ status: 'revoked', version: 3 })
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='staff.access.reconciled' AND actor_staff_id=?`
    ).bind(fixture.owner.id).first()).count).toBe(before.audits)
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM outbox_jobs
       WHERE type='staff.invitation.email' AND aggregate_id=?`
    ).bind(fixture.invitation.id).first()).count).toBe(before.jobs)
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM record_versions
       WHERE entity_type='staff_invitation' AND entity_id=?`
    ).bind(fixture.invitation.id).first()).count).toBe(before.versions)
  })

  it('starts provider I/O with the exact required 46 second lease runway', async () => {
    const fixture = await provisioningFixture()
    const provider = vi.fn().mockResolvedValue({ emails: [] })

    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        providers: { reconcileAccessGroup: provider },
        nowFactory: () => NOW_MS + 14_000,
      },
    ))).resolves.toEqual({ result: 'succeeded' })

    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('does not call the provider with one millisecond less than the required lease runway', async () => {
    const fixture = await provisioningFixture()
    const provider = vi.fn().mockResolvedValue({ emails: [] })

    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        providers: { reconcileAccessGroup: provider },
        nowFactory: () => NOW_MS + 14_001,
      },
    ))).resolves.toEqual({ result: 'retry' })

    expect(provider).not.toHaveBeenCalled()
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.reconcile.lease'"
    ).first()).value_json)).toEqual({ expiresAt: null, nonce: null, owner: null })
  })

  it('samples provider runway after the final lease read completes', async () => {
    const fixture = await provisioningFixture()
    let leaseReads = 0
    let providerFenceLeaseRead = false
    const db = {
      prepare(sql) {
        const statement = env.DB.prepare(sql)
        if (!sql.includes('SELECT key,value_json,version FROM system_state WHERE key=?')) {
          return statement
        }
        return {
          bind(...bindings) {
            const bound = statement.bind(...bindings)
            return {
              async first() {
                const row = await bound.first()
                if (bindings[0] === 'access.reconcile.lease') {
                  leaseReads += 1
                  if (leaseReads === 4) providerFenceLeaseRead = true
                }
                return row
              },
            }
          },
        }
      },
      batch: env.DB.batch.bind(env.DB),
    }
    const provider = vi.fn().mockResolvedValue({ emails: [] })

    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        db,
        providers: { reconcileAccessGroup: provider },
        nowFactory: () => providerFenceLeaseRead ? NOW_MS + 14_001 : NOW_MS,
      },
    ))).resolves.toEqual({ result: 'retry' })

    expect(providerFenceLeaseRead).toBe(true)
    expect(provider).not.toHaveBeenCalled()
  })

  it('does not call the provider after losing its nonce during the initial snapshot', async () => {
    const fixture = await provisioningFixture()
    let batches = 0
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: vi.fn(async (statements) => {
        const results = await env.DB.batch(statements)
        batches += 1
        if (batches === 2) {
          await setState('access.reconcile.lease', {
            expiresAt: new Date(NOW_MS + 120_000).toISOString(),
            nonce: 'replacement_pre_provider_nonce',
            owner: 'replacement_pre_provider_owner',
          })
        }
        return results
      }),
    }
    const provider = vi.fn().mockResolvedValue({ emails: [] })

    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        db,
        providers: { reconcileAccessGroup: provider },
      },
    ))).resolves.toEqual({ result: 'retry' })

    expect(provider).not.toHaveBeenCalled()
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.reconcile.lease'"
    ).first()).value_json)).toMatchObject({
      nonce: 'replacement_pre_provider_nonce',
      owner: 'replacement_pre_provider_owner',
    })
  })

  it('does not call the provider after its lease revision changes with the same value', async () => {
    const fixture = await provisioningFixture()
    let batches = 0
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: vi.fn(async (statements) => {
        const results = await env.DB.batch(statements)
        batches += 1
        if (batches === 2) {
          await env.DB.prepare(
            `UPDATE system_state
             SET version=version+1,updated_at=?
             WHERE key='access.reconcile.lease'`
          ).bind(NOW).run()
        }
        return results
      }),
    }
    const provider = vi.fn().mockResolvedValue({ emails: [] })

    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        db,
        providers: { reconcileAccessGroup: provider },
      },
    ))).resolves.toEqual({ result: 'retry' })

    expect(provider).not.toHaveBeenCalled()
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
  })

  it('proves a newer ordinary job and releases obsolete work without publishing', async () => {
    const fixture = await provisioningFixture()
    const provider = vi.fn(async () => {
      const held = JSON.parse((await env.DB.prepare(
        "SELECT value_json FROM system_state WHERE key='access.reconcile.lease'"
      ).first()).value_json)
      expect(held.owner).toMatch(/^lease_owner_/)
      expect(held.nonce).toMatch(/^lease_nonce_/)
      await setState('access.desired_generation', { generation: 2 })
      await seedJob(fixture.cryptoContext, {
        id: `job_newer_${serial}`,
        type: 'staff.access.reconcile',
        aggregateType: 'access_group',
        aggregateId: 'centre_1',
        payload: { actorId: fixture.owner.id, generation: 2 },
        idempotencyKey: 'staff.access.reconcile:2',
      })
      return { emails: [] }
    })
    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      { providers: { reconcileAccessGroup: provider } },
    ))).resolves.toEqual({ result: 'succeeded' })

    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
    expect(await env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
      .bind(fixture.invitation.id).first()).toEqual({ status: 'provisioning', version: 1 })
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.reconcile.lease'"
    ).first()).value_json)).toEqual({ expiresAt: null, nonce: null, owner: null })
  })

  it('does not publish or release after losing the singleton fencing nonce', async () => {
    const fixture = await provisioningFixture()
    const provider = vi.fn(async () => {
      await setState('access.reconcile.lease', {
        expiresAt: new Date(NOW_MS + 120_000).toISOString(),
        nonce: 'replacement_nonce',
        owner: 'replacement_owner',
      })
      return { emails: [] }
    })
    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      { providers: { reconcileAccessGroup: provider } },
    ))).resolves.toEqual({ result: 'retry' })

    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.reconcile.lease'"
    ).first()).value_json)).toMatchObject({
      nonce: 'replacement_nonce',
      owner: 'replacement_owner',
    })
  })

  it('does not publish after the owned singleton lease expires during provider I/O', async () => {
    const fixture = await provisioningFixture()
    const provider = vi.fn().mockResolvedValue({ emails: [] })
    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        providers: { reconcileAccessGroup: provider },
        nowFactory: () => NOW_MS + 60_000,
      },
    ))).resolves.toEqual({ result: 'retry' })
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
    expect(await env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
      .bind(fixture.invitation.id).first()).toEqual({ status: 'provisioning', version: 1 })
  })

  it('uses the real pre-provider clock when production omits a time factory', async () => {
    const fixture = await provisioningFixture()
    const provider = vi.fn().mockResolvedValue({ emails: [] })
    const input = reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      { providers: { reconcileAccessGroup: provider } },
    )
    delete input.nowFactory
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + 60_000)
    try {
      await expect(handlers.handleAccessReconcile(input)).resolves.toEqual({ result: 'retry' })
    } finally {
      clock.mockRestore()
    }
    expect(provider).not.toHaveBeenCalled()
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
  })

  it('rechecks time after publication preparation and excludes a newly expired invitation', async () => {
    const fixture = await provisioningFixture()
    const expiresAt = new Date(NOW_MS + 30_000).toISOString()
    await env.DB.prepare(
      `UPDATE staff_invitations
       SET expires_at=?,version=version+1,updated_at=?
       WHERE id=? AND version=1`
    ).bind(expiresAt, NOW, fixture.invitation.id).run()
    let clockReads = 0
    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        nowFactory: () => {
          clockReads += 1
          return clockReads === 1 ? NOW_MS : NOW_MS + 30_000
        },
      },
    ))).resolves.toEqual({ result: 'retry' })
    expect(clockReads).toBeGreaterThanOrEqual(2)
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
    expect(await env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
      .bind(fixture.invitation.id).first()).toEqual({ status: 'provisioning', version: 2 })
  })

  it('uses a canonical default correlation ID for Access publication', async () => {
    const fixture = await provisioningFixture()
    const request = reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
    )
    delete request.correlationIdFactory
    await expect(handlers.handleAccessReconcile(request)).resolves.toEqual({
      result: 'succeeded',
    })
    const audit = await env.DB.prepare(
      `SELECT correlation_id FROM audit_events
       WHERE action='staff.access.reconciled' AND actor_staff_id=?
       ORDER BY occurred_at DESC,id DESC LIMIT 1`
    ).bind(fixture.owner.id).first()
    expect(audit.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('rejects stale and future payload generations before provider I/O', async () => {
    const stale = await provisioningFixture()
    await setState('access.desired_generation', { generation: 20 })
    await seedJob(stale.cryptoContext, {
      id: `job_stale_payload_${serial}`,
      type: 'staff.access.reconcile',
      aggregateType: 'access_group',
      aggregateId: 'centre_1',
      payload: { actorId: stale.owner.id, generation: 20 },
      idempotencyKey: 'staff.access.reconcile:20',
    })
    const staleProvider = vi.fn()
    await expect(handlers.handleAccessReconcile(reconcileInput(
      stale.cryptoContext,
      { actorId: stale.owner.id, generation: 19 },
      { providers: { reconcileAccessGroup: staleProvider } },
    ))).resolves.toEqual({ result: 'succeeded' })
    expect(staleProvider).not.toHaveBeenCalled()

    const future = await provisioningFixture()
    const futureProvider = vi.fn()
    await expect(handlers.handleAccessReconcile(reconcileInput(
      future.cryptoContext,
      { actorId: future.owner.id, generation: 2 },
      { providers: { reconcileAccessGroup: futureProvider } },
    ))).rejects.toThrow(/^ACCESS_RECONCILE_STATE_INVALID$/)
    expect(futureProvider).not.toHaveBeenCalled()
  })

  it('withholds publication when only the desired fingerprint drifts during provider I/O', async () => {
    const fixture = await provisioningFixture()
    const provider = vi.fn(async () => {
      await env.DB.prepare(
        `UPDATE staff_invitations
         SET status='expired',version=version+1,updated_at=?
         WHERE id=? AND status='provisioning' AND version=1`
      ).bind(NOW, fixture.invitation.id).run()
      return { emails: [] }
    })
    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      { providers: { reconcileAccessGroup: provider } },
    ))).resolves.toEqual({ result: 'retry' })
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.reconcile.lease'"
    ).first()).value_json)).toMatchObject({
      owner: expect.stringMatching(/^lease_owner_/),
      nonce: expect.stringMatching(/^lease_nonce_/),
    })
  })

  it('releases its owned lease without publishing when the provider fails', async () => {
    const fixture = await provisioningFixture()
    const failure = Object.assign(new Error('ACCESS_PROVIDER_NETWORK'), { retryable: true })
    const provider = vi.fn().mockRejectedValue(failure)
    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      { providers: { reconcileAccessGroup: provider } },
    ))).rejects.toBe(failure)
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.reconcile.lease'"
    ).first()).value_json)).toEqual({ expiresAt: null, nonce: null, owner: null })
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
  })

  it('publishes every eligible invitation in one atomic reconciliation batch', async () => {
    const fixture = await provisioningFixture()
    const secondStaff = await seedStaff(fixture.cryptoContext, {
      id: `stf_publication_second_${serial}`,
      email: `publication-second-${serial}@example.test`,
      status: 'pending',
    })
    const secondInvitation = await seedInvitation(fixture.cryptoContext, {
      id: `inv_publication_second_${serial}`,
      staffId: secondStaff.id,
      inviterId: fixture.owner.id,
      email: `publication-second-${serial}@example.test`,
    })
    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
    ))).resolves.toEqual({ result: 'succeeded' })
    const invitations = (await env.DB.prepare(
      'SELECT id,status,version FROM staff_invitations WHERE id IN (?,?) ORDER BY id'
    ).bind(fixture.invitation.id, secondInvitation.id).all()).results
    expect(invitations).toEqual([
      { id: fixture.invitation.id, status: 'pending', version: 2 },
      { id: secondInvitation.id, status: 'pending', version: 2 },
    ].toSorted((left, right) => left.id.localeCompare(right.id)))
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM record_versions WHERE entity_type='staff_invitation' AND entity_id IN (?,?)"
    ).bind(fixture.invitation.id, secondInvitation.id).first()).count).toBe(2)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM outbox_jobs WHERE type='staff.invitation.email' AND aggregate_id IN (?,?)"
    ).bind(fixture.invitation.id, secondInvitation.id).first()).count).toBe(2)
    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action='staff.access.reconciled' AND actor_staff_id=?
       ORDER BY occurred_at DESC,id DESC LIMIT 1`
    ).bind(fixture.owner.id).first()
    expect(JSON.parse(audit.metadata_json).invitationCount).toBe(2)
  })

  it.each([
    [4, ['succeeded', 'succeeded'], [2, 2]],
    [5, ['succeeded', 'succeeded', 'succeeded'], [2, 2, 1]],
  ])('converges %i provisioning invitations in bounded publication chunks', async (
    invitationCount,
    expectedResults,
    expectedAuditCounts,
  ) => {
    const fixture = await provisioningQueue(invitationCount)
    const provider = vi.fn().mockResolvedValue({ emails: [] })

    for (const [index, expectedResult] of expectedResults.entries()) {
      await expect(handlers.handleAccessReconcile(reconcileInput(
        fixture.cryptoContext,
        { actorId: fixture.owner.id, generation: 1 },
        { providers: { reconcileAccessGroup: provider } },
      ))).resolves.toEqual({ result: expectedResult })

      const invitations = (await env.DB.prepare(
        `SELECT id,status,version FROM staff_invitations
         WHERE id IN (${fixture.invitations.map(() => '?').join(',')})
         ORDER BY id`
      ).bind(...fixture.invitations.map((invitation) => invitation.id)).all()).results
      expect(invitations.filter((invitation) => invitation.status === 'pending'))
        .toHaveLength(Math.min((index + 1) * 2, invitationCount))
      expect(invitations.filter((invitation) => invitation.status === 'provisioning'))
        .toHaveLength(Math.max(invitationCount - ((index + 1) * 2), 0))
      expect(JSON.parse((await env.DB.prepare(
        "SELECT value_json FROM system_state WHERE key='access.reconcile.lease'"
      ).first()).value_json)).toEqual({ expiresAt: null, nonce: null, owner: null })
      expect(JSON.parse((await env.DB.prepare(
        "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
      ).first()).value_json)).toMatchObject({ generation: 1 })
    }

    expect(provider).toHaveBeenCalledTimes(1)
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toMatchObject({ generation: 1 })
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM record_versions
       WHERE entity_type='staff_invitation'
         AND entity_id IN (${fixture.invitations.map(() => '?').join(',')})`
    ).bind(...fixture.invitations.map((invitation) => invitation.id)).first()).count)
      .toBe(invitationCount)
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM outbox_jobs
       WHERE type='staff.invitation.email'
         AND aggregate_id IN (${fixture.invitations.map(() => '?').join(',')})`
    ).bind(...fixture.invitations.map((invitation) => invitation.id)).first()).count)
      .toBe(invitationCount)
    const audits = (await env.DB.prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action='staff.access.reconciled' AND actor_staff_id=?
       ORDER BY rowid`
    ).bind(fixture.owner.id).all()).results
    expect(audits.map(({ metadata_json: metadata }) => JSON.parse(metadata))).toEqual(
      expectedAuditCounts.map((count) => ({
        desiredGeneration: 1,
        appliedGeneration: 1,
        invitationCount: count,
      })),
    )
    const remainingHeads = fixture.invitations.filter((_, index) => (
      index >= 2 && index % 2 === 0
    ))
    const continuationKeys = remainingHeads.map((invitation) => (
      `staff.access.reconcile.continue:1:${invitation.id}:${invitation.version}`
    ))
    const continuations = (await env.DB.prepare(
      `SELECT idempotency_key,status,attempt_count,max_attempts
       FROM outbox_jobs
       WHERE type='staff.access.reconcile'
         AND idempotency_key IN (${continuationKeys.map(() => '?').join(',')})
       ORDER BY idempotency_key`
    ).bind(...continuationKeys).all()).results
    expect(continuations).toEqual(continuationKeys.toSorted().map((idempotencyKey) => ({
      idempotency_key: idempotencyKey,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 8,
    })))
  })

  it('keeps a rejected two-invitation publication inside dedicated-drain headroom', async () => {
    const fixture = await provisioningQueue(5)
    const meter = meteredDb(env.DB, { rejectPublication: true })
    const provider = vi.fn().mockResolvedValue({ emails: [] })

    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      {
        db: meter.db,
        providers: { reconcileAccessGroup: provider },
      },
    ))).resolves.toEqual({ result: 'retry' })

    const usage = meter.usage()
    expect(provider).toHaveBeenCalledTimes(1)
    expect(usage).toEqual({ maxBindings: 45, statements: 31 })
    expect(10 + usage.statements + 7).toBeLessThanOrEqual(50)
  })

  it('converges seventeen invitations through fresh bounded continuations', async () => {
    const fixture = await provisioningQueue(17)
    const provider = vi.fn().mockResolvedValue({ emails: [] })
    const results = []

    for (let index = 0; index < 9; index += 1) {
      results.push(await handlers.handleAccessReconcile(reconcileInput(
        fixture.cryptoContext,
        { actorId: fixture.owner.id, generation: 1 },
        { providers: { reconcileAccessGroup: provider } },
      )))
    }

    expect(results).toEqual(Array.from({ length: 9 }, () => ({ result: 'succeeded' })))
    expect(provider).toHaveBeenCalledTimes(1)
    const invitations = (await env.DB.prepare(
      `SELECT status,version FROM staff_invitations
       WHERE id IN (${fixture.invitations.map(() => '?').join(',')})`
    ).bind(...fixture.invitations.map((invitation) => invitation.id)).all()).results
    expect(invitations).toHaveLength(17)
    expect(invitations.every((invitation) => (
      invitation.status === 'pending' && invitation.version === 2
    ))).toBe(true)

    const continuationKeys = fixture.invitations
      .filter((_, index) => index >= 2 && index % 2 === 0)
      .map((invitation) => (
        `staff.access.reconcile.continue:1:${invitation.id}:${invitation.version}`
      ))
    const continuations = (await env.DB.prepare(
      `SELECT idempotency_key,status,attempt_count,max_attempts
       FROM outbox_jobs
       WHERE type='staff.access.reconcile'
         AND idempotency_key IN (${continuationKeys.map(() => '?').join(',')})`
    ).bind(...continuationKeys).all()).results
    expect(continuations).toHaveLength(8)
    expect(continuations.every((job) => (
      job.status === 'queued' && job.attempt_count === 0 && job.max_attempts === 8
    ))).toBe(true)
  })

  it('converges provider and D1 through an explicit A-to-B-to-A generation sequence', async () => {
    const fixture = await provisioningFixture()
    const sets = []
    const provider = vi.fn(async ({ emails }) => {
      sets.push(emails)
      return { emails }
    })
    await handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      { providers: { reconcileAccessGroup: provider } },
    ))
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE staff_invitations
         SET status='revoked',revoked_at=?,version=version+1,updated_at=?
         WHERE id=? AND status='pending' AND version=2`
      ).bind(NOW, NOW, fixture.invitation.id),
      env.DB.prepare(
        `UPDATE staff_users
         SET status='disabled',disabled_at=?,version=version+1,updated_at=?
         WHERE id=? AND status='pending' AND version=1`
      ).bind(NOW, NOW, fixture.staff.id),
    ])
    await setState('access.desired_generation', { generation: 2 })
    await handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 2 },
      { providers: { reconcileAccessGroup: provider } },
    ))
    await env.DB.prepare(
      `UPDATE staff_users
       SET status='pending',disabled_at=NULL,version=version+1,updated_at=?
       WHERE id=? AND status='disabled' AND version=2`
    ).bind(NOW, fixture.staff.id).run()
    const nextInvitation = await seedInvitation(fixture.cryptoContext, {
      id: `inv_publication_aba_${serial}`,
      staffId: fixture.staff.id,
      inviterId: fixture.owner.id,
      email: `publication-staff-${serial}@example.test`,
    })
    await setState('access.desired_generation', { generation: 3 })
    await handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 3 },
      { providers: { reconcileAccessGroup: provider } },
    ))

    const ownerEmail = `publication-owner-${serial}@example.test`
    const staffEmail = `publication-staff-${serial}@example.test`
    expect(sets).toEqual([
      [ownerEmail, staffEmail],
      [ownerEmail],
      [ownerEmail, staffEmail],
    ])
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toMatchObject({ generation: 3 })
    expect(await env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
      .bind(nextInvitation.id).first()).toEqual({ status: 'pending', version: 2 })
  })

  it('fences a late A response after an expired-lease B run has published', async () => {
    const fixture = await provisioningFixture()
    const before = {
      audits: (await env.DB.prepare(
        "SELECT count(*) AS count FROM audit_events WHERE action='staff.access.reconciled'"
      ).first()).count,
      jobs: (await env.DB.prepare(
        "SELECT count(*) AS count FROM outbox_jobs WHERE type='staff.invitation.email' AND aggregate_id=?"
      ).bind(fixture.invitation.id).first()).count,
      versions: (await env.DB.prepare(
        "SELECT count(*) AS count FROM record_versions WHERE entity_type='staff_invitation' AND entity_id=?"
      ).bind(fixture.invitation.id).first()).count,
    }
    let providerEmails = []
    let releaseA
    let signalAStarted
    const aStarted = new Promise((resolve) => {
      signalAStarted = resolve
    })
    const aMayReturn = new Promise((resolve) => {
      releaseA = resolve
    })
    let providerCall = 0
    const provider = vi.fn(async ({ emails }) => {
      providerCall += 1
      providerEmails = [...emails]
      if (providerCall === 1) {
        signalAStarted()
        await aMayReturn
      }
      return { emails }
    })

    const runA = handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      { providers: { reconcileAccessGroup: provider } },
    ))
    await aStarted

    const desired = await env.DB.prepare(
      "SELECT value_json,version FROM system_state WHERE key='access.desired_generation'"
    ).first()
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE staff_invitations
         SET status='revoked',revoked_at=?,version=version+1,updated_at=?
         WHERE id=? AND status='provisioning' AND version=1`
      ).bind(NOW, NOW, fixture.invitation.id),
      env.DB.prepare(
        `UPDATE staff_users
         SET status='disabled',disabled_at=?,version=version+1,updated_at=?
         WHERE id=? AND status='pending' AND version=1`
      ).bind(NOW, NOW, fixture.staff.id),
      env.DB.prepare(
        `UPDATE system_state
         SET value_json=?,version=version+1,updated_at=?
         WHERE key='access.desired_generation' AND value_json=? AND version=?`
      ).bind(JSON.stringify({ generation: 2 }), NOW, desired.value_json, desired.version),
    ])

    const runB = await handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 2 },
      {
        nowMs: NOW_MS + 60_001,
        providers: { reconcileAccessGroup: provider },
      },
    ))
    expect(runB).toEqual({ result: 'succeeded' })
    releaseA()
    await expect(runA).resolves.toEqual({ result: 'retry' })

    const latestMembership = await handlers.desiredAccessMembership(
      env.DB,
      fixture.cryptoContext,
      NOW_MS + 60_001,
    )
    expect(provider.mock.calls.map(([request]) => request.emails)).toEqual([
      [
        `publication-owner-${serial}@example.test`,
        `publication-staff-${serial}@example.test`,
      ],
      [`publication-owner-${serial}@example.test`],
    ])
    expect(providerEmails).toEqual([`publication-owner-${serial}@example.test`])
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({
      fingerprint: latestMembership.fingerprint,
      generation: 2,
    })
    expect(await env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
      .bind(fixture.invitation.id).first()).toEqual({ status: 'revoked', version: 2 })
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.access.reconciled'"
    ).first()).count).toBe(before.audits + 1)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM outbox_jobs WHERE type='staff.invitation.email' AND aggregate_id=?"
    ).bind(fixture.invitation.id).first()).count).toBe(before.jobs)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM record_versions WHERE entity_type='staff_invitation' AND entity_id=?"
    ).bind(fixture.invitation.id).first()).count).toBe(before.versions)
  })

  it('cancels stale provider mutation A before newer run B publishes', async () => {
    vi.useFakeTimers()
    try {
      const fixture = await provisioningFixture()
      const bindings = {
        CF_ACCOUNT_ID: 'a'.repeat(32),
        CF_ACCESS_GROUP_ID: '11111111-1111-4111-8111-111111111111',
        CF_ACCESS_GROUP_NAME: 'Bear with me Staff',
        CF_ACCESS_GROUP_TOKEN: 'provider-secret',
      }
      const groupResult = (emails) => ({
        id: bindings.CF_ACCESS_GROUP_ID,
        name: bindings.CF_ACCESS_GROUP_NAME,
        include: emails.map((email) => ({ email: { email } })),
        require: [{ email_domain: { domain: 'example.test' } }],
        exclude: [{ email: { email: 'blocked@example.test' } }],
      })
      const ok = (emails, url) => ({
        ok: true,
        redirected: false,
        status: 200,
        url,
        json: async () => ({ success: true, result: groupResult(emails) }),
      })
      let providerEmails = []
      let putCount = 0
      let signalAStarted
      const aStarted = new Promise((resolve) => {
        signalAStarted = resolve
      })
      let aCancelled = false
      const fetch = vi.fn(async (url, init) => {
        if (init.method === 'GET') return ok(providerEmails, url)
        putCount += 1
        const desired = JSON.parse(init.body).include
          .map((rule) => rule.email.email)
        if (putCount > 1) {
          providerEmails = desired
          return ok(providerEmails, url)
        }
        signalAStarted()
        return new Promise((resolve, reject) => {
          const mutation = setTimeout(() => {
            providerEmails = desired
            resolve(ok(providerEmails, url))
          }, 20_000)
          init.signal.addEventListener('abort', () => {
            aCancelled = true
            clearTimeout(mutation)
            reject(Object.assign(new Error('late A aborted'), { name: 'AbortError' }))
          }, { once: true })
        })
      })

      const runA = handlers.handleAccessReconcile(reconcileInput(
        fixture.cryptoContext,
        { actorId: fixture.owner.id, generation: 1 },
        {
          bindings,
          config: { appEnv: 'staging' },
          providers: { fetch },
        },
      ))
      const expectedA = expect(runA).rejects.toMatchObject({
        message: 'ACCESS_PROVIDER_TIMEOUT',
        retryable: true,
      })
      await aStarted
      await vi.advanceTimersByTimeAsync(15_000)
      await expectedA

      const desired = await env.DB.prepare(
        "SELECT value_json,version FROM system_state WHERE key='access.desired_generation'"
      ).first()
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE staff_invitations
           SET status='revoked',revoked_at=?,version=version+1,updated_at=?
           WHERE id=? AND status='provisioning' AND version=1`
        ).bind(NOW, NOW, fixture.invitation.id),
        env.DB.prepare(
          `UPDATE staff_users
           SET status='disabled',disabled_at=?,version=version+1,updated_at=?
           WHERE id=? AND status='pending' AND version=1`
        ).bind(NOW, NOW, fixture.staff.id),
        env.DB.prepare(
          `UPDATE system_state
           SET value_json=?,version=version+1,updated_at=?
           WHERE key='access.desired_generation' AND value_json=? AND version=?`
        ).bind(JSON.stringify({ generation: 2 }), NOW, desired.value_json, desired.version),
      ])

      await expect(handlers.handleAccessReconcile(reconcileInput(
        fixture.cryptoContext,
        { actorId: fixture.owner.id, generation: 2 },
        {
          bindings,
          config: { appEnv: 'staging' },
          providers: { fetch },
        },
      ))).resolves.toEqual({ result: 'succeeded' })
      await vi.advanceTimersByTimeAsync(5_001)

      const latestMembership = await handlers.desiredAccessMembership(
        env.DB,
        fixture.cryptoContext,
        NOW_MS,
      )
      expect(aCancelled).toBe(true)
      expect(providerEmails).toEqual([`publication-owner-${serial}@example.test`])
      expect(JSON.parse((await env.DB.prepare(
        "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
      ).first()).value_json)).toEqual({
        fingerprint: latestMembership.fingerprint,
        generation: 2,
      })
      expect(await env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
        .bind(fixture.invitation.id).first()).toEqual({ status: 'revoked', version: 2 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rolls back the entire publication when its final mechanical guard fails', async () => {
    const fixture = await provisioningFixture()
    const before = {
      audits: (await env.DB.prepare(
        "SELECT count(*) AS count FROM audit_events WHERE action='staff.access.reconciled'"
      ).first()).count,
      jobs: (await env.DB.prepare(
        "SELECT count(*) AS count FROM outbox_jobs WHERE type='staff.invitation.email'"
      ).first()).count,
    }
    const db = {
      prepare(sql) {
        const guarded = sql.includes('INSERT INTO outbox_operation_guard_failures')
          ? sql.replace('WHERE NOT (', 'WHERE NOT (0 AND ')
          : sql
        return env.DB.prepare(guarded)
      },
      batch: env.DB.batch.bind(env.DB),
    }
    await expect(handlers.handleAccessReconcile(reconcileInput(
      fixture.cryptoContext,
      { actorId: fixture.owner.id, generation: 1 },
      { db },
    ))).resolves.toEqual({ result: 'retry' })

    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.applied_generation'"
    ).first()).value_json)).toEqual({ fingerprint: EMPTY_FINGERPRINT, generation: 0 })
    expect(await env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
      .bind(fixture.invitation.id).first()).toEqual({ status: 'provisioning', version: 1 })
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.access.reconciled'"
    ).first()).count).toBe(before.audits)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM outbox_jobs WHERE type='staff.invitation.email'"
    ).first()).count).toBe(before.jobs)
  })

  it('supplies the provider with a runtime fetch closure instead of globalThis.fetch', async () => {
    const fixture = await provisioningFixture()
    const providerResponse = new Response(null, { status: 204 })
    const runtimeFetch = vi.fn(async () => providerResponse)
    vi.stubGlobal('fetch', runtimeFetch)
    try {
      const provider = async (request) => {
        if (typeof request.fetch !== 'function' || request.fetch === globalThis.fetch) {
          throw new Error('runtime_fetch_invalid')
        }
        const response = await request.fetch('https://provider.example.test/check')
        if (response !== providerResponse) throw new Error('runtime_fetch_response_invalid')
      }

      await expect(handlers.handleAccessReconcile(reconcileInput(
        fixture.cryptoContext,
        { actorId: fixture.owner.id, generation: 1 },
        { providers: { reconcileAccessGroup: provider } },
      ))).resolves.toEqual({ result: 'succeeded' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('authoritative outbox handler dispatch', () => {
  it('rejects claimed type/aggregate substitution before payload decryption or provider I/O', async () => {
    await resetAccessState()
    const cryptoContext = await context()
    const job = await seedJob(cryptoContext, {
      id: `job_dispatch_recheck_${serial}`,
      type: 'staff.access.reconcile',
      aggregateType: 'access_group',
      aggregateId: 'centre_1',
      payload: { actorId: `stf_dispatch_owner_${serial}`, generation: 0 },
      idempotencyKey: `staff.access.reconcile:dispatch-${serial}`,
    })
    expect(job).toBeTruthy()
    const claim = await claimJob(job.id)
    const provider = vi.fn()
    const poisonedContext = {
      ...cryptoContext,
      dataKey: Object.freeze({}),
    }
    await expect(handlers.dispatchOutboxJob({
      db: env.DB,
      cryptoContext: poisonedContext,
      config: { appEnv: 'development' },
      job: { ...claim, aggregate_id: 'other_group' },
      nowMs: NOW_MS,
      providers: { reconcileAccessGroup: provider },
    })).resolves.toEqual({ result: 'retry' })
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-canonical lease expiry', {
      jobPatch: { lease_expires_at: 42 },
      claimPatch: { lease_expires_at: 42 },
    }],
    ['an invalid lease owner', {
      jobPatch: { lease_owner: 'invalid lease owner' },
      claimPatch: {
        lease_owner: 'invalid lease owner',
        leaseOwner: 'invalid lease owner',
      },
    }],
    ['an invalid attempt ID', {
      attemptPatch: { id: 'invalid attempt id' },
      claimPatch: { attemptId: 'invalid attempt id' },
    }],
  ])('rejects %s in authoritative claim rows before payload decryption', async (_label, patches) => {
    await resetAccessState()
    const cryptoContext = await context()
    const job = await seedJob(cryptoContext, {
      id: `job_dispatch_malformed_${serial}`,
      type: 'staff.access.reconcile',
      aggregateType: 'access_group',
      aggregateId: 'centre_1',
      payload: { actorId: `stf_dispatch_malformed_${serial}`, generation: 0 },
      idempotencyKey: `staff.access.reconcile:malformed-${serial}`,
    })
    const claim = await claimJob(job.id)
    const db = {
      prepare(sql) {
        if (sql === 'SELECT * FROM outbox_jobs WHERE id=?') {
          return {
            bind(id) {
              return {
                async first() {
                  const row = await env.DB.prepare(sql).bind(id).first()
                  return { ...row, ...patches.jobPatch }
                },
              }
            },
          }
        }
        if (sql.includes('FROM outbox_attempts')) {
          return {
            bind(id, attemptNumber) {
              return {
                async first() {
                  const row = await env.DB.prepare(sql).bind(id, attemptNumber).first()
                  return { ...row, ...patches.attemptPatch }
                },
              }
            },
          }
        }
        return env.DB.prepare(sql)
      },
      batch: env.DB.batch.bind(env.DB),
    }
    const provider = vi.fn()
    await expect(handlers.dispatchOutboxJob({
      db,
      cryptoContext: {
        ...cryptoContext,
        dataKey: Object.freeze({}),
      },
      config: { appEnv: 'development' },
      job: { ...claim, ...patches.claimPatch },
      nowMs: NOW_MS,
      providers: { reconcileAccessGroup: provider },
    })).resolves.toEqual({ result: 'retry' })
    expect(provider).not.toHaveBeenCalled()
  })

  it('routes an accepted expiry claim through the atomic invitation domain service', async () => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_expiry_owner_${serial}`,
      email: `expiry-owner-${serial}@example.test`,
      role: 'owner',
      status: 'active',
    })
    await retirePriorCandidates(owner.id)
    await resetAccessState()
    const staff = await seedStaff(cryptoContext, {
      id: `stf_expiry_staff_${serial}`,
      email: `expiry-staff-${serial}@example.test`,
      status: 'pending',
    })
    const invitation = await seedInvitation(cryptoContext, {
      id: `inv_expiry_dispatch_${serial}`,
      staffId: staff.id,
      inviterId: owner.id,
      email: `expiry-staff-${serial}@example.test`,
      expiresAt: NOW,
    })
    await seedJob(cryptoContext, {
      id: `job_expiry_dispatch_${serial}`,
      type: 'staff.invitation.expire',
      aggregateType: 'staff_invitation',
      aggregateId: invitation.id,
      payload: { actorId: owner.id, invitationId: invitation.id },
      idempotencyKey: `staff.invitation.expire:${invitation.id}`,
    })
    const claim = await claimJob(`job_expiry_dispatch_${serial}`)

    await expect(handlers.dispatchOutboxJob({
      db: env.DB,
      cryptoContext,
      config: { appEnv: 'development' },
      job: claim,
      nowMs: NOW_MS,
      idFactory: sequence(`expiry_dispatch_${serial}`),
    })).resolves.toEqual({ result: 'succeeded' })

    expect(await env.DB.prepare('SELECT status,version FROM staff_invitations WHERE id=?')
      .bind(invitation.id).first()).toEqual({ status: 'expired', version: 2 })
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.desired_generation'"
    ).first()).value_json)).toEqual({ generation: 1 })
    const audit = await env.DB.prepare(
      `SELECT actor_staff_id,correlation_id FROM audit_events
       WHERE action='staff.invitation.expired' AND actor_staff_id=?
       ORDER BY occurred_at DESC,id DESC LIMIT 1`
    ).bind(owner.id).first()
    expect(audit.actor_staff_id).toBe(owner.id)
    expect(audit.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM outbox_jobs WHERE type='staff.access.reconcile' AND idempotency_key='staff.access.reconcile:1'"
    ).first()).count).toBe(1)
  })

  it('treats terminal invitation expiry as a successful no-op', async () => {
    const cryptoContext = await context()
    const owner = await seedStaff(cryptoContext, {
      id: `stf_terminal_owner_${serial}`,
      email: `terminal-owner-${serial}@example.test`,
      role: 'owner',
      status: 'active',
    })
    await retirePriorCandidates(owner.id)
    await resetAccessState()
    const staff = await seedStaff(cryptoContext, {
      id: `stf_terminal_staff_${serial}`,
      email: `terminal-staff-${serial}@example.test`,
      status: 'pending',
    })
    const invitation = await seedInvitation(cryptoContext, {
      id: `inv_terminal_dispatch_${serial}`,
      staffId: staff.id,
      inviterId: owner.id,
      email: `terminal-staff-${serial}@example.test`,
      status: 'revoked',
      expiresAt: NOW,
    })
    await seedJob(cryptoContext, {
      id: `job_terminal_dispatch_${serial}`,
      type: 'staff.invitation.expire',
      aggregateType: 'staff_invitation',
      aggregateId: invitation.id,
      payload: { actorId: owner.id, invitationId: invitation.id },
      idempotencyKey: `staff.invitation.expire:${invitation.id}`,
    })
    const claim = await claimJob(`job_terminal_dispatch_${serial}`)
    await expect(handlers.dispatchOutboxJob({
      db: env.DB,
      cryptoContext,
      config: { appEnv: 'development' },
      job: claim,
      nowMs: NOW_MS,
      idFactory: sequence(`terminal_dispatch_${serial}`),
      correlationIdFactory: correlationSequence(),
    })).resolves.toEqual({ result: 'succeeded' })
    expect(JSON.parse((await env.DB.prepare(
      "SELECT value_json FROM system_state WHERE key='access.desired_generation'"
    ).first()).value_json)).toEqual({ generation: 0 })
  })
})
