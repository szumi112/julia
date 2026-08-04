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
  deactivateStaff,
  expireInvitation,
  inviteStaff,
  listStaff,
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
  const ownerEmail = `owner-${serial}@example.test`
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,?,1,?,?,?)`
  ).bind(
    owner.id,
    await blindEmailIndex(ownerEmail, keyring),
    await encryptedField({ keyring, dataKey }, owner.id, 'email', ownerEmail),
    await encryptedField({ keyring, dataKey }, owner.id, 'display_name', 'Owner Testowy'),
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

const deactivate = (context, staffId, version, options = {}) => deactivateStaff({
  db: options.db ?? env.DB,
  cryptoContext: context,
  actor: options.actor ?? context.owner,
  staffId,
  version,
  idempotencyKey: options.idempotencyKey ?? `deactivate-key-${serial}`,
  correlationId: options.correlationId ?? '55555555-5555-4555-8555-555555555555',
  nowMs: options.nowMs ?? NOW_MS,
  idFactory: options.idFactory ?? ids(`deactivate_${serial}`),
})

const list = (context, options = {}) => listStaff({
  db: options.db ?? env.DB,
  cryptoContext: context,
  actor: options.actor ?? context.owner,
  nowMs: options.nowMs ?? NOW_MS,
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
  lookupVersion,
  accessSubject = status === 'active' ? `subject_${id}` : null,
  activatedAt = status === 'active' ? now : null,
  disabledAt = status === 'disabled' ? now : null,
}) {
  const lookup = await blindEmailIndex(email, context.keyring, lookupVersion)
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
    accessSubject,
    role === 'specialist' ? specialistIdFor(id) : null,
    version,
    activatedAt,
    disabledAt,
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
  version = 1,
  expiresAt = now,
  createdAt = now,
  emailSentAt = null,
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
    expiresAt,
    ['pending', 'activated'].includes(status) ? now : null,
    emailSentAt,
    status === 'activated' ? now : null,
    status === 'revoked' ? now : null,
    version,
    createdAt,
    now,
  ).run()
  return env.DB.prepare('SELECT * FROM staff_invitations WHERE id=?').bind(id).first()
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
    env.DB.prepare("SELECT count(*) AS count FROM audit_events WHERE action IN ('staff.invited','staff.deactivated','staff.invitation.expired','authorization.denied')").first(),
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

async function retainOnlyActiveOwners(retainedIds) {
  const rows = (await env.DB.prepare(
    "SELECT id FROM staff_users WHERE role='owner' AND status='active' ORDER BY id"
  ).all()).results
  for (const row of rows) {
    if (retainedIds.includes(row.id)) continue
    await env.DB.prepare(
      `UPDATE staff_users
       SET status='disabled',disabled_at=?,version=version+1,updated_at=?
       WHERE id=? AND role='owner' AND status='active'`
    ).bind(now, now, row.id).run()
  }
}

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

function failedIdempotencyWriteDb() {
  return {
    prepare(sql) {
      const guarded = sql.includes('INSERT INTO idempotency_records')
        ? sql.replace(
            'VALUES (?,?,?,?,?,?,?,?,?)',
            'SELECT ?,?,?,?,?,?,?,?,? WHERE 0',
          )
        : sql
      return env.DB.prepare(guarded)
    },
    batch: env.DB.batch.bind(env.DB),
  }
}

function winnerBeforeBatchDb(commitWinner) {
  let started = false
  return {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements) {
      if (!started) {
        started = true
        await commitWinner()
      }
      return env.DB.batch(statements)
    },
  }
}

describe('staff invitation input', () => {
  it.each(['coordinator', 'owner', 'specialist'])('accepts and normalizes the %s role', (role) => {
    expect(validateInvitationInput({
      displayName: '  Z\u0307aneta Testowa  ',
      email: '  Z\u0307ANETA@EXAMPLE.TEST  ',
      role,
    }, { dataMode: 'fictional' })).toEqual({
      displayName: '\u017baneta Testowa',
      email: '\u017caneta@example.test',
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

  it.each([
    ['a NUL control character', 'anna\u0000@example.test'],
    ['an outer newline control character', '\nanna@example.test'],
    ['an invisible format character', 'anna\u200b@example.test'],
    ['a quoted local part', '"anna"@example.test'],
    ['a leading local-part dot', '.anna@example.test'],
    ['a trailing local-part dot', 'anna.@example.test'],
    ['consecutive local-part dots', 'anna..test@example.test'],
    ['a leading domain-label hyphen', 'anna@-example.test'],
    ['a trailing domain-label hyphen', 'anna@example-.test'],
    ['consecutive domain dots', 'anna@example..test'],
    ['an invalid domain-label underscore', 'anna@exam_ple.test'],
    ['internal whitespace', 'anna test@example.test'],
  ])('rejects %s with only the email field detail', (_label, email) => {
    try {
      validateInvitationInput({
        displayName: 'Anna Testowa',
        email,
        role: 'coordinator',
      }, { dataMode: 'fictional' })
      throw new Error('expected validation failure')
    } catch (error) {
      expect(error).toMatchObject({
        message: 'VALIDATION_FAILED',
        details: { field: 'email' },
      })
      expect(Object.keys(error.details)).toEqual(['field'])
      expect(error.message).not.toContain(email)
    }
  })
})

describe('staff invitation creation', () => {
  it('rejects sender-invalid emails before cryptography, ID generation, or writes', async () => {
    const context = await cryptoContext()
    let cryptoCalls = 0
    let idCalls = 0
    const guardedContext = {
      ...context,
      keyring: {
        ...context.keyring,
        getDataKek(...args) {
          cryptoCalls += 1
          return context.keyring.getDataKek(...args)
        },
        getLookupHmac(...args) {
          cryptoCalls += 1
          return context.keyring.getLookupHmac(...args)
        },
      },
    }
    const invalidEmails = [
      'anna\u0000@example.test',
      '\nanna@example.test',
      'anna\u200b@example.test',
      '"anna"@example.test',
      '.anna@example.test',
      'anna.@example.test',
      'anna..test@example.test',
      'anna@-example.test',
      'anna@example-.test',
      'anna@example..test',
      'anna@exam_ple.test',
      'anna test@example.test',
    ]
    const before = await mutationFacts()
    for (const [index, email] of invalidEmails.entries()) {
      await expect(invite(guardedContext, {
        displayName: 'Anna Testowa',
        email,
        role: 'coordinator',
      }, {
        idempotencyKey: `invalid-email-${index}-key`,
        idFactory() {
          idCalls += 1
          return `invalid_email_${idCalls}`
        },
      })).rejects.toMatchObject({
        message: 'VALIDATION_FAILED',
        details: { field: 'email' },
      })
    }
    expect(cryptoCalls).toBe(0)
    expect(idCalls).toBe(0)
    expect(await mutationFacts()).toEqual(before)
  })

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
        specialistVersion: 1,
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

  it('conflicts on an exact retained active staff identity', async () => {
    const context = await cryptoContext()
    const email = 'retained-active@example.test'
    await seedStaff(context, {
      id: 'stf_retained_active',
      email,
      status: 'active',
      role: 'coordinator',
    })
    const before = await mutationFacts()
    await expect(invite(context, {
      displayName: 'Nowa Nazwa',
      email,
      role: 'specialist',
    }, {
      idempotencyKey: 'retained-active-key',
    })).rejects.toThrow(/^STAFF_INVITATION_CONFLICT$/)
    expect(await mutationFacts()).toEqual(before)
  })

  it('conflicts on a pending retained row with an unexpired open invitation', async () => {
    const context = await cryptoContext()
    const email = 'retained-open@example.test'
    const staff = await seedStaff(context, {
      id: 'stf_retained_open',
      email,
      status: 'pending',
    })
    await seedInvitation(context, {
      id: 'inv_retained_open',
      staffId: staff.id,
      email,
      status: 'provisioning',
      expiresAt: new Date(NOW_MS + 1).toISOString(),
    })
    const before = await mutationFacts()
    await expect(invite(context, {
      displayName: 'Nadal Otwarta',
      email,
      role: 'specialist',
    }, {
      idempotencyKey: 'retained-open-key',
    })).rejects.toThrow(/^STAFF_INVITATION_CONFLICT$/)
    expect(await mutationFacts()).toEqual(before)
  })

  it('searches retained invitation candidates from every lookup-key version and reuses the linked row', async () => {
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
    const result = await invite(context, {
      displayName: 'Retained Match',
      email: 'retained-invitation@example.test',
      role: 'owner',
    }, {
      idempotencyKey: 'retained-invitation-key',
      idFactory: ids('retained_invitation'),
    })
    expect(result.data.staff).toMatchObject({
      id: 'stf_retained_invitation',
      displayName: 'Retained Match',
      email: 'retained-invitation@example.test',
      role: 'owner',
      status: 'pending',
      version: 2,
    })
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
        specialistVersion: null,
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

describe('retained staff reinvitation', () => {
  it.each([
    ['owner', 'coordinator', 'disabled', null],
    ['owner', 'specialist', 'pending', 'expired'],
    ['coordinator', 'owner', 'pending', 'revoked'],
    ['coordinator', 'specialist', 'disabled', null],
    ['specialist', 'owner', 'pending', 'expired'],
    ['specialist', 'coordinator', 'pending', 'revoked'],
  ])('reuses the immutable row for %s to %s with %s history', async (
    initialRole,
    nextRole,
    status,
    invitationStatus,
  ) => {
    const context = await cryptoContext()
    const email = `${initialRole}-${nextRole}-${invitationStatus ?? status}@example.test`
    const retained = await seedStaff(context, {
      id: `stf_${initialRole}_${nextRole}_${invitationStatus ?? status}`,
      email,
      displayName: 'Stara Nazwa',
      role: initialRole,
      status,
      version: 3,
      accessSubject: status === 'disabled'
        ? `retained_subject_${initialRole}_${nextRole}`
        : null,
      activatedAt: status === 'disabled' ? new Date(NOW_MS - DAY_MS).toISOString() : null,
    })
    if (invitationStatus) {
      await seedInvitation(context, {
        id: `inv_old_${initialRole}_${nextRole}`,
        staffId: retained.id,
        email,
        role: initialRole,
        status: invitationStatus,
        version: 2,
      })
    }
    const before = await mutationFacts()
    const retainedSpecialistId = initialRole === 'specialist' || nextRole === 'specialist'
      ? specialistIdFor(retained.id)
      : null
    const result = await invite(context, {
      displayName: 'Nowa Nazwa',
      email: `  ${email.toUpperCase()}  `,
      role: nextRole,
    }, {
      idempotencyKey: `reuse-${initialRole}-${nextRole}-${invitationStatus ?? status}`,
      idFactory: ids(`reuse_${initialRole}_${nextRole}_${invitationStatus ?? status}`),
    })

    expect(result.data.staff).toEqual({
      id: retained.id,
      displayName: 'Nowa Nazwa',
      email,
      role: nextRole,
      status: 'pending',
      version: 4,
      specialistId: retainedSpecialistId,
    })
    expect(result.data.invitation).toMatchObject({
      status: 'provisioning',
      version: 1,
      emailSentAt: null,
    })
    const stored = await env.DB.prepare('SELECT * FROM staff_users WHERE id=?').bind(retained.id).first()
    expect(stored).toMatchObject({
      id: retained.id,
      role: nextRole,
      status: 'pending',
      access_subject: null,
      specialist_id: retainedSpecialistId,
      version: 4,
      activated_at: null,
      disabled_at: null,
      created_at: retained.created_at,
      updated_at: now,
    })
    expect(await decryptEnvelope(context, stored.id, 'email', stored.email_envelope)).toBe(email)
    expect(await decryptEnvelope(context, stored.id, 'display_name', stored.display_name_envelope)).toBe('Nowa Nazwa')
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 1,
      versions: retainedSpecialistId === null ? 2 : 3,
      audits: 1,
      idempotency: 1,
      jobs: 2,
    })
    const staffHistory = await env.DB.prepare(
      "SELECT * FROM record_versions WHERE entity_type='staff_user' AND entity_id=? AND version=4"
    ).bind(retained.id).first()
    expect(JSON.parse(await decryptEnvelope(
      context,
      retained.id,
      'record_version',
      staffHistory.snapshot_envelope,
    ))).toEqual(stored)
  })

  it('expires a wall-clock-expired open invitation inside one reinvite mutation with exact histories', async () => {
    const context = await cryptoContext()
    const email = 'expired-open-reuse@example.test'
    const retained = await seedStaff(context, {
      id: 'stf_expired_open_reuse',
      email,
      role: 'coordinator',
      status: 'pending',
      version: 2,
    })
    const oldInvitation = await seedInvitation(context, {
      id: 'inv_expired_open_reuse',
      staffId: retained.id,
      email,
      role: 'coordinator',
      status: 'provisioning',
      version: 3,
      expiresAt: now,
    })
    const before = await mutationFacts()
    const result = await invite(context, {
      displayName: 'Ponowiona Osoba',
      email,
      role: 'specialist',
    }, {
      idempotencyKey: 'expired-open-reuse-key',
      idFactory: ids('expired_open_reuse'),
    })

    const [storedStaff, storedOld, storedNew] = await Promise.all([
      env.DB.prepare('SELECT * FROM staff_users WHERE id=?').bind(retained.id).first(),
      env.DB.prepare('SELECT * FROM staff_invitations WHERE id=?').bind(oldInvitation.id).first(),
      env.DB.prepare('SELECT * FROM staff_invitations WHERE id=?').bind(result.data.invitation.id).first(),
    ])
    expect(storedStaff).toMatchObject({ status: 'pending', role: 'specialist', version: 3 })
    expect(storedOld).toMatchObject({
      id: oldInvitation.id,
      status: 'expired',
      version: 4,
      updated_at: now,
    })
    expect(storedNew).toMatchObject({
      id: result.data.invitation.id,
      staff_id: retained.id,
      status: 'provisioning',
      version: 1,
    })
    const histories = (await env.DB.prepare(
      `SELECT * FROM record_versions
       WHERE (entity_type='staff_user' AND entity_id=? AND version=3)
          OR (entity_type='staff_invitation' AND entity_id=? AND version=4)
          OR (entity_type='staff_invitation' AND entity_id=? AND version=1)
       ORDER BY entity_id`
    ).bind(retained.id, oldInvitation.id, storedNew.id).all()).results
    expect(histories).toHaveLength(3)
    for (const history of histories) {
      const row = history.entity_id === retained.id
        ? storedStaff
        : history.entity_id === oldInvitation.id ? storedOld : storedNew
      expect(JSON.parse(await decryptEnvelope(
        context,
        history.entity_id,
        'record_version',
        history.snapshot_envelope,
      ))).toEqual(row)
      expect(history).toMatchObject({
        changed_by_staff_id: context.owner.id,
        changed_at: now,
        correlation_id: '11111111-1111-4111-8111-111111111111',
      })
    }
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 1,
      versions: 4,
      audits: 1,
      idempotency: 1,
      jobs: 2,
    })
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.invited' AND entity_id=?"
    ).bind(storedNew.id).first()).count).toBe(1)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.invitation.expired' AND entity_id=?"
    ).bind(oldInvitation.id).first()).count).toBe(0)
    expect(generationOf(await mutationFacts())).toBe(generationOf(before) + 1)
  })

  it('fails closed when retained exact candidates resolve to more than one logical staff row', async () => {
    const bindings = {
      ...env,
      BWM_LOOKUP_HMAC_V2: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
    }
    const context = await cryptoContext({ bindings, activeLookupKeyVersion: 2 })
    const email = 'ambiguous-retained@example.test'
    await seedStaff(context, {
      id: 'stf_ambiguous_old',
      email,
      status: 'disabled',
      lookupVersion: 1,
    })
    await seedStaff(context, {
      id: 'stf_ambiguous_current',
      email,
      status: 'disabled',
      lookupVersion: 2,
    })
    const before = await mutationFacts()
    await expect(invite(context, {
      displayName: 'Niejednoznaczna Osoba',
      email,
      role: 'owner',
    }, {
      idempotencyKey: 'ambiguous-retained-key',
    })).rejects.toThrow(/^STAFF_INVITATION_CONFLICT$/)
    expect(await mutationFacts()).toEqual(before)
  })

  it('has one winner for concurrent different-key reinvitations and leaves no loser state', async () => {
    const context = await cryptoContext()
    const retained = await seedStaff(context, {
      id: 'stf_concurrent_reuse',
      email: 'concurrent-reuse@example.test',
      status: 'disabled',
      role: 'coordinator',
    })
    const before = await mutationFacts()
    const barrier = batchBarrier()
    const settled = await Promise.allSettled([
      invite(context, {
        displayName: 'Pierwsza Próba',
        email: 'concurrent-reuse@example.test',
        role: 'owner',
      }, {
        db: barrier.db,
        idempotencyKey: 'concurrent-reuse-one',
        idFactory: ids('concurrent_reuse_one'),
      }),
      invite(context, {
        displayName: 'Druga Próba',
        email: 'concurrent-reuse@example.test',
        role: 'specialist',
      }, {
        db: barrier.db,
        idempotencyKey: 'concurrent-reuse-two',
        idFactory: ids('concurrent_reuse_two'),
      }),
    ])
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(settled.find(({ status }) => status === 'rejected').reason)
      .toMatchObject({ message: 'STAFF_INVITATION_CONFLICT' })
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 1,
      versions: 2,
      audits: 1,
      idempotency: 1,
      jobs: 2,
    })
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM staff_invitations WHERE staff_id=? AND status IN ('provisioning','pending')"
    ).bind(retained.id).first()).count).toBe(1)
  })

  it('replays only an exact retained-row request and conflicts on a changed body', async () => {
    const context = await cryptoContext()
    await seedStaff(context, {
      id: 'stf_reuse_replay',
      email: 'reuse-replay@example.test',
      status: 'disabled',
    })
    const before = await mutationFacts()
    const input = {
      displayName: 'Powtórzona Osoba',
      email: 'reuse-replay@example.test',
      role: 'owner',
    }
    const options = {
      idempotencyKey: 'reuse-replay-key',
      idFactory: ids('reuse_replay'),
    }
    const first = await invite(context, input, options)
    await expect(invite(context, input, options)).resolves.toEqual(first)
    await expect(invite(context, {
      ...input,
      role: 'specialist',
    }, options)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT$/)
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 1,
      versions: 2,
      audits: 1,
      idempotency: 1,
      jobs: 2,
    })
  })

  it('applies the audited rolling rate limit to retained-row reinvitations', async () => {
    const context = await cryptoContext()
    for (let index = 1; index <= 6; index += 1) {
      await seedStaff(context, {
        id: `stf_reuse_limit_${index}`,
        email: `reuse-limit-${index}@example.test`,
        status: 'disabled',
      })
    }
    const before = await mutationFacts()
    for (let index = 1; index <= 5; index += 1) {
      await invite(context, {
        displayName: `Ponowienie ${index}`,
        email: `reuse-limit-${index}@example.test`,
        role: 'coordinator',
      }, {
        idempotencyKey: `reuse-limit-key-${index}`,
        idFactory: ids(`reuse_limit_${index}`),
      })
    }
    await expect(invite(context, {
      displayName: 'Ponowienie 6',
      email: 'reuse-limit-6@example.test',
      role: 'coordinator',
    }, {
      idempotencyKey: 'reuse-limit-key-6',
      idFactory: ids('reuse_limit_6'),
    })).rejects.toThrow(/^RATE_LIMITED$/)
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 5,
      versions: 10,
      audits: 6,
      idempotency: 5,
      jobs: 10,
    })
    expect(await env.DB.prepare(
      "SELECT status,version FROM staff_users WHERE id='stf_reuse_limit_6'"
    ).first()).toEqual({ status: 'disabled', version: 1 })
  })

  it('rolls back every retained-row write when the final generation guard fails', async () => {
    const context = await cryptoContext()
    const retained = await seedStaff(context, {
      id: 'stf_reuse_guard',
      email: 'reuse-guard@example.test',
      role: 'specialist',
      status: 'disabled',
      version: 4,
    })
    const before = await mutationFacts()
    await expect(invite(context, {
      displayName: 'Guard Ponowienia',
      email: 'reuse-guard@example.test',
      role: 'owner',
    }, {
      db: failedGenerationCasDb(),
      idempotencyKey: 'reuse-guard-key',
      idFactory: ids('reuse_guard'),
    })).rejects.toThrow(/rate_limit_guard_failed/)
    expect(await mutationFacts()).toEqual(before)
    expect(await env.DB.prepare(
      'SELECT role,status,version FROM staff_users WHERE id=?'
    ).bind(retained.id).first()).toEqual({
      role: 'specialist',
      status: 'disabled',
      version: 4,
    })
  })
})

describe('staff deactivation', () => {
  it('authorizes only a currently active owner before target identity decryption', async () => {
    const context = await cryptoContext()
    const target = await seedStaff(context, {
      id: 'stf_deactivate_authorization',
      email: 'deactivate-authorization@example.test',
      status: 'active',
    })
    const disabledOwner = await seedStaff(context, {
      id: 'stf_deactivate_disabled_owner',
      email: 'deactivate-disabled-owner@example.test',
      role: 'owner',
      status: 'disabled',
    })
    const before = await mutationFacts()
    for (const actor of [
      { id: 'stf_deactivate_coordinator', role: 'coordinator', specialistId: null, version: 1 },
      { id: 'stf_deactivate_specialist', role: 'specialist', specialistId: 'sp_deactivate_specialist', version: 1 },
      { id: disabledOwner.id, role: 'owner', specialistId: null, version: disabledOwner.version },
    ]) {
      await expect(deactivate(context, target.id, target.version, {
        actor,
        idempotencyKey: `deactivate-denied-${actor.role}-${actor.id}`,
      })).rejects.toThrow(/^FORBIDDEN$/)
    }
    expect(await mutationFacts()).toEqual(before)
  })

  it('atomically disables staff without an open invitation and appends exact evidence', async () => {
    const context = await cryptoContext()
    const target = await seedStaff(context, {
      id: 'stf_deactivate_active',
      email: 'deactivate-active@example.test',
      displayName: 'Aktywna Osoba',
      role: 'coordinator',
      status: 'active',
      version: 3,
    })
    const before = await mutationFacts()
    const generation = generationOf(before) + 1
    const result = await deactivate(context, target.id, target.version, {
      idempotencyKey: 'deactivate-active-key',
      idFactory: ids('deactivate_active'),
    })
    expect(result).toEqual({
      data: {
        staff: {
          id: target.id,
          displayName: 'Aktywna Osoba',
          email: 'deactivate-active@example.test',
          role: 'coordinator',
          status: 'disabled',
          version: 4,
          specialistId: null,
        },
      },
    })
    const stored = await env.DB.prepare('SELECT * FROM staff_users WHERE id=?').bind(target.id).first()
    expect(stored).toMatchObject({
      status: 'disabled',
      disabled_at: now,
      version: 4,
      updated_at: now,
    })
    const history = await env.DB.prepare(
      "SELECT * FROM record_versions WHERE entity_type='staff_user' AND entity_id=? AND version=4"
    ).bind(target.id).first()
    expect(JSON.parse(await decryptEnvelope(
      context,
      target.id,
      'record_version',
      history.snapshot_envelope,
    ))).toEqual(stored)
    expect(await env.DB.prepare(
      "SELECT action,entity_type,entity_id,result,metadata_json FROM audit_events WHERE action='staff.deactivated' AND entity_id=?"
    ).bind(target.id).first()).toEqual({
      action: 'staff.deactivated',
      entity_type: 'staff_user',
      entity_id: target.id,
      result: 'success',
      metadata_json: JSON.stringify({
        desiredGeneration: generation,
        specialistVersion: null,
        staffVersion: 4,
      }),
    })
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 0,
      versions: 1,
      audits: 1,
      idempotency: 1,
      jobs: 1,
    })
  })

  it('revokes and versions the one open invitation in the same deactivation batch', async () => {
    const context = await cryptoContext()
    const created = await invite(context, {
      displayName: 'Oczekująca Osoba',
      email: 'deactivate-open@example.test',
      role: 'specialist',
    }, {
      idempotencyKey: 'deactivate-open-create',
      idFactory: ids('deactivate_open_create'),
    })
    const before = await mutationFacts()
    const result = await deactivate(context, created.data.staff.id, created.data.staff.version, {
      idempotencyKey: 'deactivate-open-key',
      idFactory: ids('deactivate_open'),
    })
    expect(result.data.staff).toMatchObject({
      id: created.data.staff.id,
      status: 'disabled',
      version: 2,
    })
    const invitation = await env.DB.prepare(
      'SELECT * FROM staff_invitations WHERE id=?'
    ).bind(created.data.invitation.id).first()
    expect(invitation).toMatchObject({
      status: 'revoked',
      revoked_at: now,
      version: 2,
      updated_at: now,
    })
    const history = await env.DB.prepare(
      "SELECT * FROM record_versions WHERE entity_type='staff_invitation' AND entity_id=? AND version=2"
    ).bind(invitation.id).first()
    expect(JSON.parse(await decryptEnvelope(
      context,
      invitation.id,
      'record_version',
      history.snapshot_envelope,
    ))).toEqual(invitation)
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 0,
      versions: 3,
      audits: 1,
      idempotency: 1,
      jobs: 1,
    })
  })

  it('replays an exact deactivation and conflicts on a changed body', async () => {
    const context = await cryptoContext()
    const target = await seedStaff(context, {
      id: 'stf_deactivate_replay',
      email: 'deactivate-replay@example.test',
      status: 'active',
      version: 2,
    })
    const before = await mutationFacts()
    const options = {
      idempotencyKey: 'deactivate-replay-key',
      idFactory: ids('deactivate_replay'),
    }
    const first = await deactivate(context, target.id, 2, options)
    await expect(deactivate(context, target.id, 2, options)).resolves.toEqual(first)
    await expect(deactivate(context, target.id, 3, options))
      .rejects.toThrow(/^IDEMPOTENCY_CONFLICT$/)
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 0,
      versions: 1,
      audits: 1,
      idempotency: 1,
      jobs: 1,
    })
  })

  it('concurrent exact deactivation recovers the winner through idempotency', async () => {
    const context = await cryptoContext()
    const created = await invite(context, {
      displayName: 'Concurrent Practitioner',
      email: 'deactivate-concurrent@example.test',
      role: 'specialist',
    }, {
      idempotencyKey: 'deactivate-concurrent-create',
      idFactory: ids('deactivate_concurrent_create'),
    })
    const before = await mutationFacts()
    let winner
    const db = winnerBeforeBatchDb(async () => {
      winner = await deactivate(context, created.data.staff.id, created.data.staff.version, {
        idempotencyKey: 'deactivate-concurrent-shared',
        correlationId: '66666666-6666-4666-8666-666666666661',
        idFactory: ids('deactivate_concurrent_one'),
      })
    })
    const recovered = await deactivate(
      context,
      created.data.staff.id,
      created.data.staff.version,
      {
        db,
        idempotencyKey: 'deactivate-concurrent-shared',
        correlationId: '66666666-6666-4666-8666-666666666662',
        idFactory: ids('deactivate_concurrent_two'),
      },
    )

    expect(recovered).toEqual(winner)
    expect(recovered.data.staff).toMatchObject({
      id: created.data.staff.id,
      status: 'disabled',
      version: 2,
    })
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 0,
      versions: 3,
      audits: 1,
      idempotency: 1,
      jobs: 1,
    })
  })

  it('returns only allow-listed stale-version detail and hides missing staff facts', async () => {
    const context = await cryptoContext()
    const target = await seedStaff(context, {
      id: 'stf_deactivate_stale',
      email: 'deactivate-stale@example.test',
      status: 'active',
      version: 4,
    })
    const before = await mutationFacts()
    try {
      await deactivate(context, target.id, 3, { idempotencyKey: 'deactivate-stale-key' })
      throw new Error('expected stale version failure')
    } catch (error) {
      expect(error).toMatchObject({
        message: 'VERSION_CONFLICT',
        details: { currentVersion: 4 },
      })
      expect(Object.keys(error.details)).toEqual(['currentVersion'])
    }
    await expect(deactivate(context, 'stf_missing_opaque', 1, {
      idempotencyKey: 'deactivate-missing-key',
    })).rejects.toThrow(/^NOT_FOUND$/)
    await expect(deactivate(context, 'not-canonical', 1, {
      idempotencyKey: 'deactivate-path-key',
    })).rejects.toThrow(/^NOT_FOUND$/)
    try {
      await deactivate(context, target.id, 0, {
        idempotencyKey: 'deactivate-version-key',
      })
      throw new Error('expected version validation failure')
    } catch (error) {
      expect(error).toMatchObject({
        message: 'VALIDATION_FAILED',
        details: { field: 'version' },
      })
      expect(Object.keys(error.details)).toEqual(['field'])
    }
    expect(await mutationFacts()).toEqual(before)
  })

  it('preserves an unrelated identity collision without idempotency recovery', async () => {
    const context = await cryptoContext()
    const created = await invite(context, {
      displayName: 'Źródło Kolizji',
      email: 'deactivate-collision-source@example.test',
      role: 'coordinator',
    }, {
      idempotencyKey: 'deactivate-collision-source',
      idFactory: ids('deactivate_collision_source'),
    })
    const collision = await env.DB.prepare(
      "SELECT id FROM record_versions WHERE entity_type='staff_user' AND entity_id=?"
    ).bind(created.data.staff.id).first()
    const target = await seedStaff(context, {
      id: 'stf_deactivate_collision',
      email: 'deactivate-collision@example.test',
      status: 'active',
    })
    const before = await mutationFacts()
    await expect(deactivate(context, target.id, target.version, {
      idempotencyKey: 'deactivate-collision-key',
      idFactory: () => collision.id,
    })).rejects.toThrow(/identity_collision/)
    expect(await mutationFacts()).toEqual(before)
    expect(await env.DB.prepare(
      'SELECT status,version FROM staff_users WHERE id=?'
    ).bind(target.id).first()).toEqual({ status: 'active', version: 1 })
  })

  it('rolls back all deactivation writes when the final generation guard fails', async () => {
    const context = await cryptoContext()
    const target = await seedStaff(context, {
      id: 'stf_deactivate_guard',
      email: 'deactivate-guard@example.test',
      status: 'active',
    })
    const before = await mutationFacts()
    await expect(deactivate(context, target.id, target.version, {
      db: failedGenerationCasDb(),
      idempotencyKey: 'deactivate-guard-key',
      idFactory: ids('deactivate_guard'),
    })).rejects.toThrow(/identity_collision/)
    expect(await mutationFacts()).toEqual(before)
    expect(await env.DB.prepare(
      'SELECT status,version FROM staff_users WHERE id=?'
    ).bind(target.id).first()).toEqual({ status: 'active', version: 1 })
  })

  it('preserves collision semantics when deactivation idempotency evidence is missing', async () => {
    const context = await cryptoContext()
    const target = await seedStaff(context, {
      id: 'stf_deactivate_idempotency_guard',
      email: 'deactivate-idempotency-guard@example.test',
      status: 'active',
    })
    const before = await mutationFacts()

    await expect(deactivate(context, target.id, target.version, {
      db: failedIdempotencyWriteDb(),
      idempotencyKey: 'deactivate-idempotency-guard',
      idFactory: ids('deactivate_idempotency_guard'),
    })).rejects.toThrow(/identity_collision/)
    expect(await mutationFacts()).toEqual(before)
    expect(await env.DB.prepare(
      'SELECT status,version FROM staff_users WHERE id=?'
    ).bind(target.id).first()).toEqual({ status: 'active', version: 1 })
  })

  it('maps only the exact last-active-owner sentinel and leaves every row unchanged', async () => {
    const context = await cryptoContext()
    await retainOnlyActiveOwners([context.owner.id])
    const before = await mutationFacts()
    await expect(deactivate(context, context.owner.id, context.owner.version, {
      idempotencyKey: 'deactivate-last-owner',
      idFactory: ids('deactivate_last_owner'),
    })).rejects.toThrow(/^LAST_ACTIVE_OWNER$/)
    expect(await mutationFacts()).toEqual(before)
    expect(await env.DB.prepare(
      'SELECT status,version FROM staff_users WHERE id=?'
    ).bind(context.owner.id).first()).toEqual({ status: 'active', version: 1 })
  })

  it('preserves one active owner under forced concurrent last-owner attempts', async () => {
    const context = await cryptoContext()
    const second = await seedStaff(context, {
      id: 'stf_second_owner',
      email: 'second-owner@example.test',
      role: 'owner',
      status: 'active',
    })
    const secondActor = {
      id: second.id,
      role: 'owner',
      specialistId: null,
      version: second.version,
    }
    await retainOnlyActiveOwners([context.owner.id, second.id])
    const before = await mutationFacts()
    const barrier = batchBarrier()
    const settled = await Promise.allSettled([
      deactivate(context, second.id, second.version, {
        db: barrier.db,
        actor: context.owner,
        idempotencyKey: 'concurrent-owner-one',
        correlationId: '66666666-6666-4666-8666-666666666666',
        idFactory: ids('concurrent_owner_one'),
      }),
      deactivate(context, context.owner.id, context.owner.version, {
        db: barrier.db,
        actor: secondActor,
        idempotencyKey: 'concurrent-owner-two',
        correlationId: '77777777-7777-4777-8777-777777777777',
        idFactory: ids('concurrent_owner_two'),
      }),
    ])
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(settled.find(({ status }) => status === 'rejected').reason)
      .toMatchObject({ message: 'LAST_ACTIVE_OWNER' })
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM staff_users WHERE role='owner' AND status='active'"
    ).first()).count).toBe(1)
    expect(mutationDelta(before, await mutationFacts())).toEqual({
      staff: 0,
      invitations: 0,
      versions: 1,
      audits: 1,
      idempotency: 1,
      jobs: 1,
    })
  })
})

describe('staff lifecycle generation and listing', () => {
  it('uses three increasing generations and ordinary reconcile keys for A-B-A', async () => {
    const context = await cryptoContext()
    const before = await mutationFacts()
    const first = await invite(context, {
      displayName: 'A B A',
      email: 'a-b-a@example.test',
      role: 'coordinator',
    }, {
      idempotencyKey: 'a-b-a-invite-key',
      idFactory: ids('a_b_a_invite'),
    })
    const disabled = await deactivate(context, first.data.staff.id, first.data.staff.version, {
      idempotencyKey: 'a-b-a-disable-key',
      idFactory: ids('a_b_a_disable'),
    })
    const repeated = await invite(context, {
      displayName: 'A B A',
      email: 'a-b-a@example.test',
      role: 'coordinator',
    }, {
      idempotencyKey: 'a-b-a-reinvite-key',
      idFactory: ids('a_b_a_reinvite'),
    })
    expect(disabled.data.staff.status).toBe('disabled')
    expect(repeated.data.staff).toMatchObject({
      id: first.data.staff.id,
      status: 'pending',
      version: 3,
    })
    const generations = [
      generationOf(before) + 1,
      generationOf(before) + 2,
      generationOf(before) + 3,
    ]
    expect(generationOf(await mutationFacts())).toBe(generations[2])
    expect((await env.DB.prepare(
      `SELECT idempotency_key FROM outbox_jobs
       WHERE type='staff.access.reconcile' AND idempotency_key IN (?,?,?)
       ORDER BY idempotency_key`
    ).bind(...generations.map((generation) => `staff.access.reconcile:${generation}`)).all()).results)
      .toEqual(generations.map((generation) => ({
        idempotency_key: `staff.access.reconcile:${generation}`,
      })))
  })

  it('authorizes a current active owner before decrypting staff-list identities', async () => {
    const context = await cryptoContext()
    const disabledOwner = await seedStaff(context, {
      id: 'stf_disabled_list_owner',
      email: 'disabled-list-owner@example.test',
      role: 'owner',
      status: 'disabled',
    })
    const before = await mutationFacts()
    for (const actor of [
      { id: 'stf_list_coordinator', role: 'coordinator', specialistId: null, version: 1 },
      { id: 'stf_list_specialist', role: 'specialist', specialistId: 'sp_list_specialist', version: 1 },
      { id: disabledOwner.id, role: 'owner', specialistId: null, version: disabledOwner.version },
    ]) {
      await expect(list(context, { actor })).rejects.toThrow(/^FORBIDDEN$/)
    }
    expect(await mutationFacts()).toEqual(before)
  })

  it('sorts with the exact Polish collator and opaque-id tie breaker', async () => {
    const context = await cryptoContext()
    for (const row of [
      { id: 'stf_sort_z', displayName: 'Żaneta', email: 'sort-z@example.test' },
      { id: 'stf_sort_a', displayName: 'Ądam', email: 'sort-a@example.test' },
      { id: 'stf_sort_10', displayName: 'Zofia 10', email: 'sort-10@example.test' },
      { id: 'stf_sort_2', displayName: 'Zofia 2', email: 'sort-2@example.test' },
      { id: 'stf_tie_b', displayName: 'ewa', email: 'tie-b@example.test' },
      { id: 'stf_tie_a', displayName: 'Ewa', email: 'tie-a@example.test' },
    ]) {
      await seedStaff(context, {
        ...row,
        status: 'disabled',
      })
    }
    const result = await list(context)
    const selectedIds = new Set([
      context.owner.id,
      'stf_sort_z',
      'stf_sort_a',
      'stf_sort_10',
      'stf_sort_2',
      'stf_tie_b',
      'stf_tie_a',
    ])
    expect(result.data.staff
      .filter(({ id }) => selectedIds.has(id))
      .map(({ id, displayName }) => ({ id, displayName }))).toEqual([
      { id: 'stf_sort_a', displayName: 'Ądam' },
      { id: 'stf_tie_a', displayName: 'Ewa' },
      { id: 'stf_tie_b', displayName: 'ewa' },
      { id: context.owner.id, displayName: 'Owner Testowy' },
      { id: 'stf_sort_2', displayName: 'Zofia 2' },
      { id: 'stf_sort_10', displayName: 'Zofia 10' },
      { id: 'stf_sort_z', displayName: 'Żaneta' },
    ])
  })

  it('returns the exact public shape with only the current open invitation and no retained secrets', async () => {
    const context = await cryptoContext()
    const target = await seedStaff(context, {
      id: 'stf_list_shape',
      email: 'list-shape@example.test',
      displayName: 'Lista Kształt',
      role: 'specialist',
      status: 'pending',
      version: 5,
    })
    await seedInvitation(context, {
      id: 'inv_terminal_secret',
      staffId: target.id,
      email: 'old-list-shape@example.test',
      displayName: 'Stara Tajna Nazwa',
      role: 'coordinator',
      status: 'revoked',
      version: 7,
      createdAt: new Date(NOW_MS - DAY_MS).toISOString(),
    })
    const open = await seedInvitation(context, {
      id: 'inv_list_open',
      staffId: target.id,
      email: 'list-shape@example.test',
      displayName: 'Lista Kształt',
      role: 'specialist',
      status: 'pending',
      version: 3,
      expiresAt: new Date(NOW_MS + DAY_MS).toISOString(),
      emailSentAt: now,
    })
    const result = await list(context)
    const row = result.data.staff.find(({ id }) => id === target.id)
    expect(row).toEqual({
      id: target.id,
      displayName: 'Lista Kształt',
      email: 'list-shape@example.test',
      role: 'specialist',
      status: 'pending',
      version: 5,
      specialistId: specialistIdFor(target.id),
      invitation: {
        id: open.id,
        status: 'pending',
        expiresAt: new Date(NOW_MS + DAY_MS).toISOString(),
        emailSentAt: now,
        version: 3,
      },
    })
    expect(Object.keys(row)).toEqual([
      'id',
      'displayName',
      'email',
      'role',
      'status',
      'version',
      'specialistId',
      'invitation',
    ])
    expect(Object.keys(row.invitation)).toEqual([
      'id',
      'status',
      'expiresAt',
      'emailSentAt',
      'version',
    ])
    const serialized = JSON.stringify(result)
    for (const secret of [
      target.email_lookup,
      target.email_envelope,
      target.display_name_envelope,
      'inv_terminal_secret',
      'old-list-shape@example.test',
      'Stara Tajna Nazwa',
    ]) expect(serialized).not.toContain(secret)
  })
})
