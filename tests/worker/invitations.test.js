import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  blindEmailIndex,
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import {
  expireInvitation,
  inviteStaff,
  specialistIdFor,
  validateInvitationInput,
} from '../../worker/identity/invitations.js'
import { NOW_MS } from './fixtures.js'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
const scope = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const now = new Date(NOW_MS).toISOString()
let serial = 0

const ids = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

async function cryptoContext(options = {}) {
  serial += 1
  const owner = Object.freeze({
    id: `stf_owner_invitation_${serial}`,
    role: 'owner',
    specialistId: null,
    version: 1,
  })
  const keyring = await createKeyring(options.bindings ?? env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: options.activeLookupKeyVersion ?? 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
    id: `key_invitation_${serial}`,
    createdAt: now,
  })
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,?,1,?,?,?)`
  ).bind(
    owner.id,
    `owner_lookup_${serial}`,
    '{}',
    '{}',
    'owner',
    `owner_subject_${serial}`,
    null,
    now,
    now,
    now,
  ).run()
  return { keyring, dataKey, scope, owner }
}

const invite = (context, input, options = {}) => inviteStaff({
  db: options.db ?? env.DB,
  cryptoContext: context,
  actor: options.actor ?? context.owner,
  input,
  idempotencyKey: options.idempotencyKey ?? `invite-key-${serial}-${input.role}`,
  correlationId: options.correlationId ?? '11111111-1111-4111-8111-111111111111',
  nowMs: options.nowMs ?? NOW_MS,
  dataMode: options.dataMode ?? 'fictional',
  idFactory: options.idFactory ?? ids(`opaque_${serial}`),
})

const expire = (context, invitationId, options = {}) => expireInvitation({
  db: options.db ?? env.DB,
  cryptoContext: context,
  actorId: options.actorId ?? context.owner.id,
  invitationId,
  correlationId: options.correlationId ?? '22222222-2222-4222-8222-222222222222',
  nowMs: options.nowMs ?? NOW_MS + WEEK_MS,
  idFactory: options.idFactory ?? ids(`expiry_${serial}`),
})

async function encryptedField(context, recordId, field, plaintext) {
  return JSON.stringify(await encryptForScope(context.keyring, context.dataKey, {
    expectedScope: scope,
    recordId,
    field,
    plaintext,
  }))
}

async function seedStaff(context, {
  id,
  email,
  displayName = 'Retained Candidate',
  role = 'coordinator',
  status = 'pending',
  version = 1,
}) {
  const lookup = await blindEmailIndex(email, context.keyring)
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id,
    lookup,
    await encryptedField(context, id, 'email', email),
    await encryptedField(context, id, 'display_name', displayName),
    role,
    status,
    status === 'active' ? `subject_${id}` : null,
    role === 'specialist' ? specialistIdFor(id) : null,
    version,
    status === 'active' ? now : null,
    status === 'disabled' ? now : null,
    now,
    now,
  ).run()
  return env.DB.prepare('SELECT * FROM staff_users WHERE id=?').bind(id).first()
}

async function seedInvitation(context, {
  id,
  staffId,
  email,
  displayName = 'Retained Invitation',
  role = 'coordinator',
  status = 'expired',
  lookupVersion,
}) {
  const lookup = await blindEmailIndex(email, context.keyring, lookupVersion)
  await env.DB.prepare(
    `INSERT INTO staff_invitations
     (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,inviter_id,
      expires_at,access_allowed_at,email_sent_at,activated_at,revoked_at,version,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id,
    staffId,
    lookup,
    await encryptedField(context, id, 'email', email),
    await encryptedField(context, id, 'display_name', displayName),
    role,
    status,
    context.owner.id,
    now,
    ['pending', 'activated'].includes(status) ? now : null,
    null,
    status === 'activated' ? now : null,
    status === 'revoked' ? now : null,
    1,
    now,
    now,
  ).run()
}

async function decryptEnvelope(context, recordId, field, serialized) {
  return decryptForScope(context.keyring, context.dataKey, {
    expectedScope: scope,
    recordId,
    field,
    envelope: JSON.parse(serialized),
  })
}

async function mutationFacts() {
  const [staff, invitations, versions, audits, idempotency, jobs, desired] = await Promise.all([
    env.DB.prepare('SELECT count(*) AS count FROM staff_users').first(),
    env.DB.prepare('SELECT count(*) AS count FROM staff_invitations').first(),
    env.DB.prepare('SELECT count(*) AS count FROM record_versions').first(),
    env.DB.prepare("SELECT count(*) AS count FROM audit_events WHERE action IN ('staff.invited','staff.invitation.expired','authorization.denied')").first(),
    env.DB.prepare('SELECT count(*) AS count FROM idempotency_records').first(),
    env.DB.prepare('SELECT count(*) AS count FROM outbox_jobs').first(),
    env.DB.prepare("SELECT value_json,version FROM system_state WHERE key='access.desired_generation'").first(),
  ])
  return {
    staff: staff.count,
    invitations: invitations.count,
    versions: versions.count,
    audits: audits.count,
    idempotency: idempotency.count,
    jobs: jobs.count,
    desired,
  }
}

function mutationDelta(before, after) {
  return Object.fromEntries(
    ['staff', 'invitations', 'versions', 'audits', 'idempotency', 'jobs']
      .map((key) => [key, after[key] - before[key]]),
  )
}

const generationOf = (facts) => JSON.parse(facts.desired.value_json).generation

function batchBarrier() {
  let waiting = 0
  let release
  const ready = new Promise((resolve) => { release = resolve })
  return {
    db: {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements) {
        waiting += 1
        if (waiting === 2) release()
        if (waiting <= 2) await ready
        return env.DB.batch(statements)
      },
    },
  }
}

function failedGenerationCasDb() {
  return {
    prepare(sql) {
      const guarded = sql.includes("UPDATE system_state SET value_json=?,version=version+1,updated_at=? WHERE key=? AND version=?")
        ? sql.replace('WHERE key=? AND version=?', 'WHERE key=? AND version=? AND 0')
        : sql
      return env.DB.prepare(guarded)
    },
    batch: env.DB.batch.bind(env.DB),
  }
}

describe('staff invitation input', () => {
  it.each(['coordinator', 'owner', 'specialist'])('accepts and normalizes the %s role', (role) => {
    expect(validateInvitationInput({
      displayName: '  Z\u0307aneta Testowa  ',
      email: '  PERSON@EXAMPLE.TEST  ',
      role,
    }, { dataMode: 'fictional' })).toEqual({
      displayName: '\u017baneta Testowa',
      email: 'person@example.test',
      role,
    })
  })

  it('derives a specialist id from exactly the opaque staff payload', () => {
    expect(specialistIdFor('stf_opaque-payload_1')).toBe('sp_opaque-payload_1')
  })

  it.each([
    ['displayName', { displayName: '', email: 'anna@example.test', role: 'owner' }],
    ['displayName', { displayName: 'x'.repeat(121), email: 'anna@example.test', role: 'owner' }],
    ['email', { displayName: 'Anna', email: 'anna@real.test', role: 'owner' }],
    ['email', { displayName: 'Anna', email: 'anna@sub.example.test', role: 'owner' }],
    ['email', { displayName: 'Anna', email: 'not-an-email', role: 'owner' }],
    ['role', { displayName: 'Anna', email: 'anna@example.test', role: 'administrator' }],
    ['displayName', { displayName: 'Anna', email: 'anna@example.test', role: 'owner', extra: true }],
    ['displayName', null],
  ])('rejects invalid exact input with only the %s field detail', (field, input) => {
    try {
      validateInvitationInput(input, { dataMode: 'fictional' })
      throw new Error('expected validation failure')
    } catch (error) {
      expect(error).toMatchObject({ message: 'VALIDATION_FAILED', details: { field } })
      expect(Object.keys(error.details)).toEqual(['field'])
    }
  })
})

describe('staff invitation creation', () => {
  it.each([
    ['coordinator', null],
    ['owner', null],
    ['specialist', 'sp_role_specialist_1'],
  ])('generates reserved server-side ids for a %s', async (role, specialistId) => {
    const context = await cryptoContext()
    const result = await invite(context, {
      displayName: `${role} Testowy`,
      email: `${role}@example.test`,
      role,
    }, {
      idFactory: ids(`role_${role}`),
      idempotencyKey: `role-key-${role}`,
    })
    expect(result.data.staff).toMatchObject({
      id: `stf_role_${role}_1`,
      role,
      specialistId,
      status: 'pending',
      version: 1,
    })
    expect(result.data.invitation).toMatchObject({
      id: `inv_role_${role}_2`,
      status: 'provisioning',
      version: 1,
    })
  })

  it('authorizes only a currently active owner before identity reads or writes', async () => {
    const context = await cryptoContext()
    const authorizedBaseline = await mutationFacts()
    for (const actor of [
      { id: 'stf_coordinator', role: 'coordinator', specialistId: null, version: 1 },
      { id: 'stf_specialist', role: 'specialist', specialistId: 'sp_specialist', version: 1 },
    ]) {
      await expect(invite(context, {
        displayName: 'Nieuprawniona Osoba',
        email: `${actor.role}@example.test`,
        role: 'owner',
      }, { actor, idempotencyKey: `denied-${actor.role}-key` })).rejects.toThrow(/^FORBIDDEN$/)
    }
    expect(await mutationFacts()).toEqual(authorizedBaseline)
    await seedStaff(context, {
      id: 'stf_inactive_owner',
      email: 'inactive-owner@example.test',
      role: 'owner',
      status: 'disabled',
    })
    const inactiveBaseline = await mutationFacts()
    await expect(invite(context, {
      displayName: 'Nieaktywny W\u0142a\u015bciciel',
      email: 'new-owner@example.test',
      role: 'owner',
    }, {
      actor: { id: 'stf_inactive_owner', role: 'owner', specialistId: null, version: 1 },
      idempotencyKey: 'denied-inactive-owner',
    })).rejects.toThrow(/^FORBIDDEN$/)
    expect(await mutationFacts()).toEqual(inactiveBaseline)
  })

  it('atomically stores exact encrypted rows and snapshots, exact audit metadata, and exactly two jobs', async () => {
    const context = await cryptoContext()
    const before = await mutationFacts()
    const generation = generationOf(before) + 1
    const input = {
      displayName: 'Anna Testowa',
      email: 'anna.lifecycle@example.test',
      role: 'specialist',
    }
    const idempotencyKey = 'lifecycle-key-1234'
    const result = await invite(context, input, {
      idFactory: ids('lifecycle'),
      idempotencyKey,
    })
    const staff = await env.DB.prepare('SELECT * FROM staff_users WHERE id=?').bind(result.data.staff.id).first()
    const invitation = await env.DB.prepare('SELECT * FROM staff_invitations WHERE id=?').bind(result.data.invitation.id).first()
    expect(staff).toMatchObject({
      id: 'stf_lifecycle_1',
      role: 'specialist',
      status: 'pending',
      access_subject: null,
      specialist_id: 'sp_lifecycle_1',
      version: 1,
      activated_at: null,
      disabled_at: null,
      created_at: now,
      updated_at: now,
    })
    expect(invitation).toMatchObject({
      id: 'inv_lifecycle_2',
      staff_id: staff.id,
      role: 'specialist',
      status: 'provisioning',
      inviter_id: context.owner.id,
      expires_at: new Date(NOW_MS + WEEK_MS).toISOString(),
      access_allowed_at: null,
      email_sent_at: null,
      activated_at: null,
      revoked_at: null,
      version: 1,
      created_at: now,
      updated_at: now,
    })
    expect(await decryptEnvelope(context, staff.id, 'email', staff.email_envelope)).toBe(input.email)
    expect(await decryptEnvelope(context, staff.id, 'display_name', staff.display_name_envelope)).toBe(input.displayName)
    expect(await decryptEnvelope(context, invitation.id, 'email', invitation.email_envelope)).toBe(input.email)
    expect(await decryptEnvelope(context, invitation.id, 'display_name', invitation.display_name_envelope)).toBe(input.displayName)

    const versions = (await env.DB.prepare(
      'SELECT * FROM record_versions WHERE entity_id IN (?,?) ORDER BY entity_type'
    ).bind(staff.id, invitation.id).all()).results
    expect(versions).toHaveLength(2)
    for (const version of versions) {
      const row = version.entity_type === 'staff_user' ? staff : invitation
      const snapshot = JSON.parse(await decryptEnvelope(
        context,
        version.entity_id,
        'record_version',
        version.snapshot_envelope,
      ))
      expect(snapshot).toEqual(row)
      expect(version).toMatchObject({
        entity_id: row.id,
        version: 1,
        changed_by_staff_id: context.owner.id,
        changed_at: now,
        correlation_id: '11111111-1111-4111-8111-111111111111',
      })
    }

    expect(await env.DB.prepare(
      `SELECT occurred_at,actor_staff_id,action,entity_type,entity_id,result,
              reason_envelope,correlation_id,metadata_json
       FROM audit_events WHERE action='staff.invited' AND actor_staff_id=?`
    ).bind(context.owner.id).first()).toEqual({
      occurred_at: now,
      actor_staff_id: context.owner.id,
      action: 'staff.invited',
      entity_type: 'staff_invitation',
      entity_id: invitation.id,
      result: 'success',
      reason_envelope: null,
      correlation_id: '11111111-1111-4111-8111-111111111111',
      metadata_json: JSON.stringify({
        desiredGeneration: generation,
        invitationVersion: 1,
        staffVersion: 1,
      }),
    })

    const jobs = (await env.DB.prepare(
      `SELECT * FROM outbox_jobs
       WHERE (type='staff.access.reconcile' AND idempotency_key=?)
          OR (type='staff.invitation.expire' AND aggregate_id=?)
       ORDER BY type`
    ).bind(`staff.access.reconcile:${generation}`, invitation.id).all()).results
    expect(jobs).toHaveLength(2)
    expect(jobs.map(({ type, aggregate_type, aggregate_id, idempotency_key, scheduled_at }) => ({
      type,
      aggregate_type,
      aggregate_id,
      idempotency_key,
      scheduled_at,
    }))).toEqual([
      {
        type: 'staff.access.reconcile',
        aggregate_type: 'access_group',
        aggregate_id: 'centre_1',
        idempotency_key: `staff.access.reconcile:${generation}`,
        scheduled_at: now,
      },
      {
        type: 'staff.invitation.expire',
        aggregate_type: 'staff_invitation',
        aggregate_id: invitation.id,
        idempotency_key: `staff.invitation.expire:${invitation.id}`,
        scheduled_at: invitation.expires_at,
      },
    ])
    const payloads = await Promise.all(jobs.map(async (job) => JSON.parse(await decryptEnvelope(
      context,
      job.id,
      'job_payload',
      job.payload_envelope,
    ))))
    expect(payloads).toEqual([
      { generation, actorId: context.owner.id },
      { invitationId: invitation.id, actorId: context.owner.id },
    ])

    const requestDigest = JSON.stringify(input)
    const successBody = JSON.stringify({ status: 201, body: result })
    const rawRows = await Promise.all([
      'staff_users',
      'staff_invitations',
      'record_versions',
      'audit_events',
      'idempotency_records',
      'outbox_jobs',
    ].map(async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results))
    const raw = JSON.stringify(rawRows)
    for (const plaintext of [
      input.displayName,
      input.email,
      requestDigest,
      successBody,
      JSON.stringify({ generation, actorId: context.owner.id }),
      JSON.stringify({ invitationId: invitation.id, actorId: context.owner.id }),
    ]) expect(raw).not.toContain(plaintext)
  })

  it.each(['active', 'disabled', 'pending'])('conflicts on an exact retained %s staff identity', async (status) => {
    const context = await cryptoContext()
    const email = `retained-${status}@example.test`
    await seedStaff(context, {
      id: `stf_retained_${status}`,
      email,
      status,
      role: status === 'active' ? 'owner' : 'coordinator',
    })
    const before = await mutationFacts()
    await expect(invite(context, {
      displayName: 'Nowa Nazwa',
      email,
      role: 'specialist',
    }, {
      idempotencyKey: `retained-${status}-key`,
    })).rejects.toThrow(/^STAFF_INVITATION_CONFLICT$/)
    expect(await mutationFacts()).toEqual(before)
  })

  it('searches retained invitation candidates from every lookup-key version before writing', async () => {
    const bindings = {
      ...env,
      BWM_LOOKUP_HMAC_V2: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
    }
    const context = await cryptoContext({ bindings, activeLookupKeyVersion: 2 })
    await seedStaff(context, {
      id: 'stf_retained_invitation',
      email: 'current-address@example.test',
      status: 'pending',
    })
    await seedInvitation(context, {
      id: 'inv_retained_old_lookup',
      staffId: 'stf_retained_invitation',
      email: 'retained-invitation@example.test',
      lookupVersion: 1,
    })
    const before = await mutationFacts()
    await expect(invite(context, {
      displayName: 'Retained Match',
      email: 'retained-invitation@example.test',
      role: 'owner',
    }, {
      idempotencyKey: 'retained-invitation-key',
    })).rejects.toThrow(/^STAFF_INVITATION_CONFLICT$/)
    expect(await mutationFacts()).toEqual(before)
  })

  it('replays only the same canonical idempotent request and conflicts on a changed body', async () => {
    const context = await cryptoContext()
    const before = await mutationFacts()
    const input = {
      displayName: 'Beata Testowa',
      email: 'beata@example.test',
      role: 'coordinator',
    }
    const options = {
      idempotencyKey: 'same-request-key',
      idFactory: ids('same_request'),
    }
    const first = await invite(context, input, options)
    await expect(invite(context, {
      email: '  BEATA@EXAMPLE.TEST ',
      role: 'coordinator',
      displayName: '  Beata Testowa ',
    }, options)).resolves.toEqual(first)
    await expect(invite(context, {
      ...input,
      role: 'owner',
    }, options)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT$/)
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 1,
      invitations: 1,
      versions: 2,
      audits: 1,
      idempotency: 1,
      jobs: 2,
    })
  })

  it('recovers a concurrent exact idempotency tuple with one mutation', async () => {
    const context = await cryptoContext()
    const before = await mutationFacts()
    const barrier = batchBarrier()
    const input = {
      displayName: 'Celina Testowa',
      email: 'celina@example.test',
      role: 'owner',
    }
    const attempts = await Promise.all([
      invite(context, input, {
        db: barrier.db,
        idempotencyKey: 'concurrent-same-key',
        idFactory: ids('concurrent_same_one'),
      }),
      invite(context, input, {
        db: barrier.db,
        idempotencyKey: 'concurrent-same-key',
        idFactory: ids('concurrent_same_two'),
      }),
    ])
    expect(attempts[0]).toEqual(attempts[1])
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 1,
      invitations: 1,
      versions: 2,
      audits: 1,
      idempotency: 1,
      jobs: 2,
    })
  })

  it('preserves an unrelated identity collision without rewriting its provenance', async () => {
    const context = await cryptoContext()
    await seedStaff(context, {
      id: 'stf_taken_payload',
      email: 'occupied@example.test',
      status: 'pending',
    })
    const before = await mutationFacts()
    const generated = [
      'taken_payload',
      'fresh_invitation',
      'fresh_staff_version',
      'fresh_invitation_version',
      'fresh_audit',
      'fresh_reconcile',
      'fresh_expiry',
      'fresh_denial',
    ]
    await expect(invite(context, {
      displayName: 'Collision Candidate',
      email: 'collision-candidate@example.test',
      role: 'coordinator',
    }, {
      idempotencyKey: 'unrelated-collision-key',
      idFactory: () => generated.shift(),
    })).rejects.toThrow(/identity_collision/)
    expect(await mutationFacts()).toEqual(before)
  })

  it('allows five rolling-hour successes, then writes only one encrypted denial', async () => {
    const context = await cryptoContext()
    const before = await mutationFacts()
    for (let index = 1; index <= 5; index += 1) {
      await invite(context, {
        displayName: `Limit Osoba ${index}`,
        email: `limit-${index}@example.test`,
        role: 'coordinator',
      }, {
        idempotencyKey: `limit-success-key-${index}`,
        idFactory: ids(`limit_success_${index}`),
      })
    }
    await expect(invite(context, {
      displayName: 'Limit Osoba 6',
      email: 'limit-6@example.test',
      role: 'coordinator',
    }, {
      idempotencyKey: 'limit-denied-key-6',
      idFactory: ids('limit_denied'),
    })).rejects.toThrow(/^RATE_LIMITED$/)
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 5,
      invitations: 5,
      versions: 10,
      audits: 6,
      idempotency: 5,
      jobs: 10,
    })
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.invited' AND actor_staff_id=?"
    ).bind(context.owner.id).first()).count).toBe(5)
    const denial = await env.DB.prepare(
      `SELECT * FROM audit_events
       WHERE action='authorization.denied' AND actor_staff_id=?`
    ).bind(context.owner.id).first()
    expect(denial).toMatchObject({
      actor_staff_id: context.owner.id,
      entity_type: 'staff_user',
      entity_id: context.owner.id,
      result: 'denied',
      correlation_id: '11111111-1111-4111-8111-111111111111',
      metadata_json: '{"version":1}',
    })
    const reason = await decryptEnvelope(context, denial.id, 'reason', denial.reason_envelope)
    expect(reason).toBe('staff invitation rate limit')
    expect(reason).not.toContain('limit-6@example.test')
  })

  it('forces two fifth attempts through the concurrent final rate guard with no loser state', async () => {
    const context = await cryptoContext()
    const before = await mutationFacts()
    for (let index = 1; index <= 4; index += 1) {
      await invite(context, {
        displayName: `Concurrent Seed ${index}`,
        email: `concurrent-seed-${index}@example.test`,
        role: 'coordinator',
      }, {
        idempotencyKey: `concurrent-seed-key-${index}`,
        idFactory: ids(`concurrent_seed_${index}`),
      })
    }
    const barrier = batchBarrier()
    const inputs = [
      { displayName: 'Concurrent One', email: 'concurrent-one@example.test', role: 'owner' },
      { displayName: 'Concurrent Two', email: 'concurrent-two@example.test', role: 'specialist' },
    ]
    const settled = await Promise.allSettled(inputs.map((input, index) => invite(context, input, {
      db: barrier.db,
      idempotencyKey: `concurrent-limit-key-${index}`,
      correlationId: `${index + 3}3333333-3333-4333-8333-333333333333`,
      idFactory: ids(`concurrent_limit_${index}`),
    })))
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const loser = settled.find(({ status }) => status === 'rejected')
    expect(loser.reason).toMatchObject({ message: 'RATE_LIMITED' })
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 5,
      invitations: 5,
      versions: 10,
      audits: 6,
      idempotency: 5,
      jobs: 10,
    })
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='authorization.denied' AND actor_staff_id=?"
    ).bind(context.owner.id).first()).count).toBe(1)
  })

})

describe('staff invitation expiry', () => {
  it('expires exactly when due, appends an exact snapshot and audit, and advances generation monotonically', async () => {
    const context = await cryptoContext()
    const before = await mutationFacts()
    const firstGeneration = generationOf(before) + 1
    const expiryGeneration = firstGeneration + 1
    const created = await invite(context, {
      displayName: 'Dorota Testowa',
      email: 'dorota@example.test',
      role: 'owner',
    }, {
      idempotencyKey: 'expiry-due-create',
      idFactory: ids('expiry_due_create'),
    })
    await expect(expire(context, created.data.invitation.id, {
      idFactory: ids('expiry_due'),
    })).resolves.toEqual({ expired: true })
    const invitation = await env.DB.prepare(
      'SELECT * FROM staff_invitations WHERE id=?'
    ).bind(created.data.invitation.id).first()
    expect(invitation).toMatchObject({
      status: 'expired',
      version: 2,
      updated_at: new Date(NOW_MS + WEEK_MS).toISOString(),
    })
    const history = await env.DB.prepare(
      `SELECT * FROM record_versions
       WHERE entity_type='staff_invitation' AND entity_id=? AND version=2`
    ).bind(invitation.id).first()
    expect(JSON.parse(await decryptEnvelope(
      context,
      invitation.id,
      'record_version',
      history.snapshot_envelope,
    ))).toEqual(invitation)
    expect(history).toMatchObject({
      changed_by_staff_id: context.owner.id,
      changed_at: new Date(NOW_MS + WEEK_MS).toISOString(),
      correlation_id: '22222222-2222-4222-8222-222222222222',
    })
    expect(await env.DB.prepare(
      `SELECT occurred_at,actor_staff_id,action,entity_type,entity_id,result,
              reason_envelope,correlation_id,metadata_json
       FROM audit_events WHERE action='staff.invitation.expired' AND entity_id=?`
    ).bind(invitation.id).first()).toEqual({
      occurred_at: new Date(NOW_MS + WEEK_MS).toISOString(),
      actor_staff_id: context.owner.id,
      action: 'staff.invitation.expired',
      entity_type: 'staff_invitation',
      entity_id: invitation.id,
      result: 'success',
      reason_envelope: null,
      correlation_id: '22222222-2222-4222-8222-222222222222',
      metadata_json: JSON.stringify({
        desiredGeneration: expiryGeneration,
        invitationVersion: 2,
        staffVersion: 1,
      }),
    })
    expect(await env.DB.prepare(
      "SELECT value_json,version FROM system_state WHERE key='access.desired_generation'"
    ).first()).toEqual({
      value_json: JSON.stringify({ generation: expiryGeneration }),
      version: before.desired.version + 2,
    })
    expect((await env.DB.prepare(
      `SELECT type,idempotency_key FROM outbox_jobs
       WHERE type='staff.access.reconcile' AND idempotency_key IN (?,?)
       ORDER BY idempotency_key`
    ).bind(
      `staff.access.reconcile:${firstGeneration}`,
      `staff.access.reconcile:${expiryGeneration}`,
    ).all()).results).toEqual([
      { type: 'staff.access.reconcile', idempotency_key: `staff.access.reconcile:${firstGeneration}` },
      { type: 'staff.access.reconcile', idempotency_key: `staff.access.reconcile:${expiryGeneration}` },
    ])
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM outbox_jobs
       WHERE type='staff.invitation.expire' AND aggregate_id=?`
    ).bind(invitation.id).first()).count).toBe(1)
  })

  it('does no writes when the invitation is not due or missing', async () => {
    const context = await cryptoContext()
    const created = await invite(context, {
      displayName: 'Ewa Testowa',
      email: 'ewa@example.test',
      role: 'coordinator',
    }, {
      idempotencyKey: 'expiry-noop-create',
      idFactory: ids('expiry_noop_create'),
    })
    const before = await mutationFacts()
    await expect(expire(context, created.data.invitation.id, {
      nowMs: NOW_MS + WEEK_MS - 1,
      idFactory: ids('expiry_not_due'),
    })).resolves.toEqual({ expired: false })
    await expect(expire(context, 'inv_missing_opaque', {
      idFactory: ids('expiry_missing'),
    })).resolves.toEqual({ expired: false })
    expect(await mutationFacts()).toEqual(before)
  })

  it.each(['activated', 'revoked'])('does no writes for an already %s invitation', async (terminalStatus) => {
    const context = await cryptoContext()
    const created = await invite(context, {
      displayName: `Terminal ${terminalStatus}`,
      email: `terminal-${terminalStatus}@example.test`,
      role: 'coordinator',
    }, {
      idempotencyKey: `terminal-${terminalStatus}-create`,
      idFactory: ids(`terminal_${terminalStatus}_create`),
    })
    const invitationId = created.data.invitation.id
    if (terminalStatus === 'activated') {
      await env.DB.prepare(
        `UPDATE staff_invitations
         SET status='pending',access_allowed_at=?,version=version+1,updated_at=?
         WHERE id=?`
      ).bind(now, now, invitationId).run()
      await env.DB.prepare(
        `UPDATE staff_invitations
         SET status='activated',activated_at=?,version=version+1,updated_at=?
         WHERE id=?`
      ).bind(now, now, invitationId).run()
    } else {
      await env.DB.prepare(
        `UPDATE staff_invitations
         SET status='revoked',revoked_at=?,version=version+1,updated_at=?
         WHERE id=?`
      ).bind(now, now, invitationId).run()
    }
    const before = await mutationFacts()
    await expect(expire(context, invitationId, {
      idFactory: ids(`terminal_${terminalStatus}_expiry`),
    })).resolves.toEqual({ expired: false })
    expect(await mutationFacts()).toEqual(before)
  })

  it('does no writes when the invitation staff row is no longer pending', async () => {
    const context = await cryptoContext()
    const created = await invite(context, {
      displayName: 'Former Pending',
      email: 'former-pending@example.test',
      role: 'coordinator',
    }, {
      idempotencyKey: 'non-pending-create',
      idFactory: ids('non_pending_create'),
    })
    await env.DB.prepare(
      `UPDATE staff_users
       SET status='active',access_subject='subject_non_pending',activated_at=?,
           version=version+1,updated_at=?
       WHERE id=?`
    ).bind(now, now, created.data.staff.id).run()
    const before = await mutationFacts()
    await expect(expire(context, created.data.invitation.id, {
      idFactory: ids('non_pending_expiry'),
    })).resolves.toEqual({ expired: false })
    expect(await mutationFacts()).toEqual(before)
  })

  it('has exactly one winner when two expiry attempts race', async () => {
    const context = await cryptoContext()
    const before = await mutationFacts()
    const created = await invite(context, {
      displayName: 'Expiry Race',
      email: 'expiry-race@example.test',
      role: 'specialist',
    }, {
      idempotencyKey: 'expiry-race-create',
      idFactory: ids('expiry_race_create'),
    })
    const barrier = batchBarrier()
    const outcomes = await Promise.all([
      expire(context, created.data.invitation.id, {
        db: barrier.db,
        correlationId: '33333333-3333-4333-8333-333333333333',
        idFactory: ids('expiry_race_one'),
      }),
      expire(context, created.data.invitation.id, {
        db: barrier.db,
        correlationId: '44444444-4444-4444-8444-444444444444',
        idFactory: ids('expiry_race_two'),
      }),
    ])
    expect(outcomes.sort((left, right) => Number(right.expired) - Number(left.expired))).toEqual([
      { expired: true },
      { expired: false },
    ])
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.invitation.expired' AND entity_id=?"
    ).bind(created.data.invitation.id).first()).count).toBe(1)
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM record_versions
       WHERE entity_type='staff_invitation' AND entity_id=? AND version=2`
    ).bind(created.data.invitation.id).first()).count).toBe(1)
    expect((await env.DB.prepare(
      `SELECT count(*) AS count FROM outbox_jobs
       WHERE type='staff.access.reconcile' AND idempotency_key IN (?,?)`
    ).bind(
      `staff.access.reconcile:${generationOf(before) + 1}`,
      `staff.access.reconcile:${generationOf(before) + 2}`,
    ).first()).count).toBe(2)
  })

  it('rolls back every expiry write when the desired-generation CAS fails its final guard', async () => {
    const context = await cryptoContext()
    const created = await invite(context, {
      displayName: 'Expiry Guard',
      email: 'expiry-guard@example.test',
      role: 'owner',
    }, {
      idempotencyKey: 'expiry-guard-create',
      idFactory: ids('expiry_guard_create'),
    })
    const before = await mutationFacts()
    await expect(expire(context, created.data.invitation.id, {
      db: failedGenerationCasDb(),
      idFactory: ids('expiry_guard_failure'),
    })).rejects.toThrow(/identity_collision/)
    expect(await mutationFacts()).toEqual(before)
    expect(await env.DB.prepare(
      'SELECT status,version FROM staff_invitations WHERE id=?'
    ).bind(created.data.invitation.id).first()).toEqual({
      status: 'provisioning',
      version: 1,
    })
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.invitation.expired' AND entity_id=?"
    ).bind(created.data.invitation.id).first()).count).toBe(0)
  })

  it('rolls back every creation write when the desired-generation CAS fails its final guard', async () => {
    const context = await cryptoContext()
    const before = await mutationFacts()
    await expect(invite(context, {
      displayName: 'Guard Failure',
      email: 'guard-failure@example.test',
      role: 'specialist',
    }, {
      db: failedGenerationCasDb(),
      idempotencyKey: 'creation-guard-failure',
      idFactory: ids('creation_guard_failure'),
    })).rejects.toThrow(/rate_limit_guard_failed/)
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 0,
      versions: 0,
      audits: 0,
      idempotency: 0,
      jobs: 0,
    })
    expect((await mutationFacts()).desired).toEqual(before.desired)
  })
})
