import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import {
  blindEmailIndex,
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { resolveCurrentAuthorityActor } from '../../worker/identity/staff.js'
import { NOW_MS, authorityActor } from './fixtures.js'
import { applyCapabilityOverridesMigration } from './apply-migrations.js'

const DAY_MS = 24 * 60 * 60 * 1000
const ORIGIN = 'https://bearwithme-panel.app'
const CORRELATION_ID = '77777777-7777-4777-8777-777777777777'
const SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})
const CONFIG = Object.freeze({
  appEnv: 'staging',
  appOrigin: ORIGIN,
  dataMode: 'fictional',
})
const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
  'access-control-expose-headers',
]
let fixtureSerial = 0

beforeAll(async () => {
  await applyCapabilityOverridesMigration()
})

const ids = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

async function encryptedField(context, recordId, field, plaintext) {
  return JSON.stringify(await encryptForScope(context.keyring, context.dataKey, {
    expectedScope: context.scope,
    recordId,
    field,
    plaintext,
  }))
}

async function createCryptoContext() {
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_staff_routes',
    createdAt: new Date(NOW_MS).toISOString(),
  })
  return { keyring, dataKey, scope: SCOPE }
}

async function seedActiveStaff(context, {
  id,
  role,
  email,
  displayName,
  specialistId = role === 'specialist' ? `sp_${id.slice(4)}` : null,
  version = 1,
}) {
  const now = new Date(NOW_MS).toISOString()
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,?,?,?,?,?)`
  ).bind(
    id,
    await blindEmailIndex(email, context.keyring),
    await encryptedField(context, id, 'email', email),
    await encryptedField(context, id, 'display_name', displayName),
    role,
    `subject_${id}`,
    specialistId,
    version,
    now,
    now,
    now,
  ).run()
  return { id, role, specialistId, version }
}

async function actorFixture(role = 'owner', suffix = role) {
  fixtureSerial += 1
  const cryptoContext = await createCryptoContext()
  const safeSuffix = suffix.replaceAll(' ', '_')
  const id = `stf_${safeSuffix}_${fixtureSerial}`
  const email = `${safeSuffix}-${fixtureSerial}@example.test`
  const displayName = role === 'owner' ? 'Owner Testowy' : `${role} Testowy`
  const row = await seedActiveStaff(cryptoContext, {
    id,
    role,
    email,
    displayName,
  })
  const actor = authorityActor(row)
  return { actor, cryptoContext, displayName, email }
}

function appDeps({ actor, cryptoContext }, overrides = {}) {
  return {
    config: CONFIG,
    cryptoContext,
    db: env.DB,
    idFactory: ids(`http_${actor.id}`),
    now: () => NOW_MS,
    readJsonBodyOnce: overrides.readJsonBodyOnce,
    resolveAccessPrincipal: vi.fn(async () => ({
      kind: 'human',
      subject: `subject_${actor.id}`,
      normalizedEmail: `${actor.id}@example.test`,
    })),
    resolveActor: vi.fn(async (db) => {
      try {
        const row = await db.prepare(
          'SELECT id,role,specialist_id,version FROM staff_users WHERE id=?',
        ).bind(actor.id).first()
        return row ? resolveCurrentAuthorityActor(db, row) : actor
      } catch {
        return actor
      }
    }),
    safeLog: vi.fn(),
    verifyCsrfToken: vi.fn(async () => true),
    ...overrides,
  }
}

function mutation(path, rawBody, idempotencyKey) {
  return {
    path,
    init: {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'x-correlation-id': CORRELATION_ID,
        'x-csrf-token': 'valid-csrf',
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      },
      body: rawBody,
    },
  }
}

function expectBoundary(response, expectedStatus) {
  expect(response.status).toBe(expectedStatus)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('x-correlation-id')).toBe(CORRELATION_ID)
  for (const header of CORS_HEADERS) expect(response.headers.has(header)).toBe(false)
}

function expectOneSafeLog(deps, markers = []) {
  expect(deps.safeLog).toHaveBeenCalledOnce()
  const serialized = JSON.stringify(deps.safeLog.mock.calls)
  for (const marker of markers) expect(serialized).not.toContain(marker)
}

async function requestOnce(app, deps, path, init, expectedStatus, markers = []) {
  deps.safeLog.mockClear()
  const response = await app.request(path, init)
  expectBoundary(response, expectedStatus)
  expectOneSafeLog(deps, markers)
  return response
}

async function count(sql, ...bindings) {
  return (await env.DB.prepare(sql).bind(...bindings).first()).count
}

async function retainOnlyActiveOwner(staffId) {
  const rows = (await env.DB.prepare(
    "SELECT id FROM staff_users WHERE role='owner' AND status='active' ORDER BY id"
  ).all()).results
  const now = new Date(NOW_MS).toISOString()
  for (const row of rows) {
    if (row.id === staffId) continue
    await env.DB.prepare(
      `UPDATE staff_users
       SET status='disabled',disabled_at=?,version=version+1,updated_at=?
       WHERE id=? AND role='owner' AND status='active'`
    ).bind(now, now, row.id).run()
  }
}

describe('staff route classification', () => {
  it.each([
    ['POST', '/api/v1/staff', 'GET, HEAD, OPTIONS'],
    ['GET', '/api/v1/staff/invitations', 'POST, OPTIONS'],
    ['PUT', '/api/v1/staff/invitations', 'POST, OPTIONS'],
    ['GET', '/api/v1/staff/stf_valid/deactivation', 'POST, OPTIONS'],
    ['DELETE', '/api/v1/staff/stf_valid/deactivation', 'POST, OPTIONS'],
  ])('rejects %s %s with its exact Allow before dependencies', async (method, path, allow) => {
    const fixture = {
      actor: { id: 'stf_trap', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: SCOPE },
    }
    const deps = appDeps(fixture)
    const response = await createApp(deps).request(path, { method })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe(allow)
    expect(deps.resolveAccessPrincipal).not.toHaveBeenCalled()
    expect(deps.verifyCsrfToken).not.toHaveBeenCalled()
    expect(deps.resolveActor).not.toHaveBeenCalled()
  })

  it('keeps unsupported methods side-effect free on staff paths', async () => {
    const fixture = {
      actor: { id: 'stf_trap', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: SCOPE },
    }
    const deps = appDeps(fixture)
    const response = await createApp(deps).request('/api/v1/staff', { method: 'TRACE' })
    expect(response.status).toBe(405)
    expect(deps.resolveAccessPrincipal).not.toHaveBeenCalled()
    expect(deps.verifyCsrfToken).not.toHaveBeenCalled()
    expect(deps.resolveActor).not.toHaveBeenCalled()
  })

  it.each([
    '/api/v1/staff?view=all',
    '/api/v1/staff/',
    '/api/v1/%73taff',
    '/api/v1/staff/invitations?view=all',
    '/api/v1/staff/staff_123/deactivation',
    '/api/v1/staff/stf_/deactivation',
    '/api/v1/staff/stf_-invalid/deactivation',
    `/api/v1/staff/stf_${'x'.repeat(125)}/deactivation`,
    '/api/v1/staff/stf_valid/deactivation/',
  ])('keeps noncanonical route variant %s unmatched for an active human', async (path) => {
    const fixture = {
      actor: { id: 'stf_human', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: SCOPE },
    }
    const handler = vi.fn(async () => ({ data: { unexpected: true } }))
    const deps = appDeps(fixture, {
      getStaff: handler,
      postDeactivation: handler,
      postInvitation: handler,
    })
    const response = await createApp(deps).request(path, {
      headers: { 'x-correlation-id': CORRELATION_ID },
    })
    expectBoundary(response, 404)
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', correlationId: CORRELATION_ID },
    })
    expect(handler).not.toHaveBeenCalled()
    expect(deps.resolveActor).toHaveBeenCalledOnce()
  })

  it('rejects a service assertion on a staff-like unknown path before actor resolution', async () => {
    const fixture = {
      actor: { id: 'stf_human', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: SCOPE },
    }
    const deps = appDeps(fixture, {
      resolveAccessPrincipal: vi.fn(async () => ({
        kind: 'service',
        serviceName: 'health-service',
      })),
    })
    const response = await createApp(deps).request('/api/v1/staff?alias=1', {
      headers: { 'x-correlation-id': CORRELATION_ID },
    })
    expectBoundary(response, 401)
    expect(deps.resolveActor).not.toHaveBeenCalled()
  })

  it('matches only a canonical opaque staff ID for deactivation', async () => {
    const fixture = {
      actor: { id: 'stf_human', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: SCOPE },
    }
    const handler = vi.fn(async () => ({
      data: {
        staff: {
          id: 'stf_a',
          displayName: 'A',
          email: 'a@example.test',
          role: 'coordinator',
          status: 'disabled',
          version: 2,
          specialistId: null,
        },
      },
    }))
    const deps = appDeps(fixture, { postDeactivation: handler })
    const request = mutation('/api/v1/staff/stf_a/deactivation', '{"version":1}', 'canonical-key')
    const response = await createApp(deps).request(request.path, request.init)
    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })
})

describe('staff route lifecycle', () => {
  it.each([
    [{ origin: 'https://evil.example', 'content-type': 'application/json' }, 'ORIGIN_INVALID'],
    [{ origin: ORIGIN, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }, 'FETCH_METADATA_INVALID'],
    [{ origin: ORIGIN, 'content-type': 'text/plain' }, 'UNSUPPORTED_MEDIA_TYPE'],
  ])('rejects cheap mutation metadata before Access for %j', async (headers, code) => {
    const fixture = {
      actor: { id: 'stf_trap', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: SCOPE },
    }
    const handler = vi.fn()
    const deps = appDeps(fixture, { postInvitation: handler })
    const response = await createApp(deps).request('/api/v1/staff/invitations', {
      method: 'POST',
      headers,
      body: '{}',
    })
    expect(response.status).toBe(code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 403)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(deps.resolveAccessPrincipal).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('preserves principal, CSRF, actor, one bounded body read, and handler order', async () => {
    const order = []
    const fixture = {
      actor: { id: 'stf_order', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: SCOPE },
    }
    const deps = appDeps(fixture, {
      resolveAccessPrincipal: vi.fn(async () => {
        order.push('principal')
        return {
          kind: 'human',
          subject: 'subject_stf_order',
          normalizedEmail: 'order@example.test',
        }
      }),
      verifyCsrfToken: vi.fn(async () => { order.push('csrf') }),
      resolveActor: vi.fn(async () => {
        order.push('actor')
        return fixture.actor
      }),
      readJsonBodyOnce: vi.fn(async (request) => {
        order.push('body')
        return JSON.parse(await request.text())
      }),
      postInvitation: vi.fn(async (input) => {
        order.push('handler')
        expect(input.body).toEqual({
          displayName: 'Anna Testowa',
          email: 'anna@example.test',
          role: 'coordinator',
        })
        expect(input.idempotencyKey).toBe('ordering-key')
        expect(input).not.toHaveProperty('request')
        return { data: { accepted: true } }
      }),
    })
    const request = mutation('/api/v1/staff/invitations', JSON.stringify({
      displayName: 'Anna Testowa',
      email: 'anna@example.test',
      role: 'coordinator',
    }), 'ordering-key')
    const response = await createApp(deps).request(request.path, request.init)
    expect(response.status).toBe(201)
    expect(order).toEqual(['principal', 'csrf', 'actor', 'body', 'handler'])
    expect(deps.readJsonBodyOnce).toHaveBeenCalledOnce()
  })

  it('stops at CSRF without resolving the actor or consuming the body', async () => {
    const fixture = {
      actor: { id: 'stf_trap', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: SCOPE },
    }
    const bodyReader = vi.fn()
    const handler = vi.fn()
    const deps = appDeps(fixture, {
      postInvitation: handler,
      readJsonBodyOnce: bodyReader,
      verifyCsrfToken: vi.fn(async () => { throw new Error('CSRF_INVALID') }),
    })
    const request = mutation('/api/v1/staff/invitations', '{}', 'csrf-failure-key')
    const response = await createApp(deps).request(request.path, request.init)
    expect(response.status).toBe(403)
    expect(deps.resolveAccessPrincipal).toHaveBeenCalledOnce()
    expect(deps.resolveActor).not.toHaveBeenCalled()
    expect(bodyReader).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([
    ['/api/v1/staff', 'GET, HEAD, OPTIONS'],
    ['/api/v1/staff/invitations', 'POST, OPTIONS'],
    ['/api/v1/staff/stf_a/deactivation', 'POST, OPTIONS'],
  ])('authenticates registered OPTIONS %s without CSRF or body consumption', async (path, allow) => {
    const fixture = {
      actor: { id: 'stf_options', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: SCOPE },
    }
    const deps = appDeps(fixture, {
      readJsonBodyOnce: vi.fn(),
      getStaff: vi.fn(),
      postInvitation: vi.fn(),
      postDeactivation: vi.fn(),
    })
    const response = await createApp(deps).request(path, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'x-correlation-id': CORRELATION_ID,
      },
    })
    expectBoundary(response, 204)
    expect(response.headers.get('allow')).toBe(allow)
    expect(await response.text()).toBe('')
    expect(deps.resolveAccessPrincipal).toHaveBeenCalledOnce()
    expect(deps.resolveActor).toHaveBeenCalledOnce()
    expect(deps.verifyCsrfToken).not.toHaveBeenCalled()
    expect(deps.readJsonBodyOnce).not.toHaveBeenCalled()
    expect(deps.getStaff).not.toHaveBeenCalled()
    expect(deps.postInvitation).not.toHaveBeenCalled()
    expect(deps.postDeactivation).not.toHaveBeenCalled()
  })
})

describe('staff owner HTTP operations', () => {
  it('serves exact GET, HEAD, OPTIONS, invite, and deactivate contracts', async () => {
    const fixture = await actorFixture('owner', 'http_owner')
    const idFactory = ids('success')
    const deps = appDeps(fixture, { idFactory })
    const app = createApp(deps)

    const list = await requestOnce(app, deps, '/api/v1/staff', {
      headers: { 'x-correlation-id': CORRELATION_ID },
    }, 200, [fixture.email, fixture.displayName])
    const listBody = await list.json()
    expect(listBody).toEqual({
      data: {
        staff: expect.arrayContaining([{
          id: fixture.actor.id,
          displayName: fixture.displayName,
          email: fixture.email,
          role: fixture.actor.role,
          status: 'active',
          version: fixture.actor.version,
          specialistId: fixture.actor.specialistId,
          invitation: null,
        }]),
      },
    })
    for (const row of listBody.data.staff) {
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
      if (row.invitation) {
        expect(Object.keys(row.invitation)).toEqual([
          'id',
          'status',
          'expiresAt',
          'emailSentAt',
          'version',
        ])
      }
    }

    const head = await requestOnce(app, deps, '/api/v1/staff', {
      method: 'HEAD',
      headers: { 'x-correlation-id': CORRELATION_ID },
    }, 200, [fixture.email, fixture.displayName])
    expect(await head.text()).toBe('')

    const options = await requestOnce(app, deps, '/api/v1/staff', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'x-correlation-id': CORRELATION_ID },
    }, 204)
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS')

    const inviteRequest = mutation('/api/v1/staff/invitations', JSON.stringify({
      displayName: 'Anna Testowa',
      email: 'anna.http@example.test',
      role: 'specialist',
    }), 'invite-success-key')
    const invited = await requestOnce(
      app,
      deps,
      inviteRequest.path,
      inviteRequest.init,
      201,
      ['anna.http@example.test', 'Anna Testowa', 'invite-success-key'],
    )
    const invitationBody = await invited.json()
    expect(invitationBody).toEqual({
      data: {
        staff: {
          id: 'stf_success_1',
          displayName: 'Anna Testowa',
          email: 'anna.http@example.test',
          role: 'specialist',
          status: 'pending',
          version: 1,
          specialistId: 'sp_success_1',
        },
        invitation: {
          id: 'inv_success_2',
          status: 'provisioning',
          expiresAt: new Date(NOW_MS + 7 * DAY_MS).toISOString(),
          emailSentAt: null,
          version: 1,
        },
      },
    })

    const deactivateRequest = mutation(
      '/api/v1/staff/stf_success_1/deactivation',
      '{"version":1}',
      'deactivate-success-key',
    )
    const deactivated = await requestOnce(
      app,
      deps,
      deactivateRequest.path,
      deactivateRequest.init,
      200,
      ['anna.http@example.test', 'Anna Testowa', 'deactivate-success-key'],
    )
    expect(await deactivated.json()).toEqual({
      data: {
        staff: {
          id: 'stf_success_1',
          displayName: 'Anna Testowa',
          email: 'anna.http@example.test',
          role: 'specialist',
          status: 'disabled',
          version: 2,
          specialistId: 'sp_success_1',
        },
      },
    })
    expect(deps.safeLog).toHaveBeenCalledOnce()
  })

  it('replays exact invite and deactivation successes without duplicate audits', async () => {
    const fixture = await actorFixture('owner', 'replay_owner')
    const deps = appDeps(fixture, { idFactory: ids('replay') })
    const app = createApp(deps)
    const inviteRequest = mutation('/api/v1/staff/invitations', JSON.stringify({
      displayName: 'Replay Testowa',
      email: 'replay@example.test',
      role: 'coordinator',
    }), 'replay-invite-key')
    const firstInvite = await app.request(inviteRequest.path, inviteRequest.init)
    const secondInvite = await app.request(inviteRequest.path, inviteRequest.init)
    expect(firstInvite.status).toBe(201)
    expect(secondInvite.status).toBe(201)
    expect(await secondInvite.json()).toEqual(await firstInvite.json())
    expect(await count(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.invited' AND actor_staff_id=?",
      fixture.actor.id,
    )).toBe(1)

    const deactivateRequest = mutation(
      '/api/v1/staff/stf_replay_1/deactivation',
      '{"version":1}',
      'replay-deactivate-key',
    )
    const firstDeactivate = await app.request(deactivateRequest.path, deactivateRequest.init)
    const secondDeactivate = await app.request(deactivateRequest.path, deactivateRequest.init)
    expect(firstDeactivate.status).toBe(200)
    expect(secondDeactivate.status).toBe(200)
    expect(await secondDeactivate.json()).toEqual(await firstDeactivate.json())
    expect(await count(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.deactivated' AND actor_staff_id=?",
      fixture.actor.id,
    )).toBe(1)
  })

  it('changes a staff role through the protected optimistic route', async () => {
    const fixture = await actorFixture('owner', 'role_http_owner')
    const target = await seedActiveStaff(fixture.cryptoContext, {
      id: 'stf_role_http_target',
      role: 'coordinator',
      email: 'role-http-target@example.test',
      displayName: 'Fikcyjna Koordynatorka',
    })
    const deps = appDeps(fixture, { idFactory: ids('role_http') })
    const request = mutation(
      `/api/v1/staff/${target.id}/role`,
      JSON.stringify({ expectedVersion: target.version, role: 'owner' }),
      'role-http-key',
    )

    const response = await requestOnce(
      createApp(deps),
      deps,
      request.path,
      request.init,
      200,
      ['role-http-target@example.test', 'Fikcyjna Koordynatorka', 'role-http-key'],
    )
    expect(await response.json()).toEqual({
      data: {
        staff: {
          id: target.id,
          displayName: 'Fikcyjna Koordynatorka',
          email: 'role-http-target@example.test',
          role: 'owner',
          status: 'active',
          version: 2,
          specialistId: null,
        },
      },
    })
    expect((await env.DB.prepare(
      `SELECT staff_id,revision FROM staff_authorities
       WHERE staff_id IN (?,?) ORDER BY staff_id`,
    ).bind(fixture.actor.id, target.id).all()).results).toEqual([
      { staff_id: fixture.actor.id, revision: 2 },
      { staff_id: target.id, revision: 2 },
    ].sort((left, right) => left.staff_id.localeCompare(right.staff_id)))
    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action='staff.role.updated' AND entity_id=?`,
    ).bind(target.id).first()
    expect(JSON.parse(audit.metadata_json)).toEqual({
      actorAuthorityRevision: 2,
      desiredGeneration: expect.any(Number),
      invitationVersion: null,
      specialistVersion: null,
      staffVersion: 2,
      targetAuthorityRevision: 2,
    })
  })

  it('rolls back the complete role batch when the last-owner trigger wins', async () => {
    const fixture = await actorFixture('owner', 'role_last_owner')
    await retainOnlyActiveOwner(fixture.actor.id)
    const before = await Promise.all([
      env.DB.prepare('SELECT role,status,version FROM staff_users WHERE id=?')
        .bind(fixture.actor.id).first(),
      env.DB.prepare('SELECT revision FROM staff_authorities WHERE staff_id=?')
        .bind(fixture.actor.id).first(),
      count("SELECT count(*) AS count FROM audit_events WHERE action='staff.role.updated'"),
      count("SELECT count(*) AS count FROM idempotency_records WHERE operation='staff.role.update'"),
    ])
    const deps = appDeps(fixture, { idFactory: ids('role_last_owner') })
    const request = mutation(
      `/api/v1/staff/${fixture.actor.id}/role`,
      JSON.stringify({ expectedVersion: fixture.actor.version, role: 'coordinator' }),
      'role-last-owner-key',
    )

    const response = await requestOnce(
      createApp(deps),
      deps,
      request.path,
      request.init,
      409,
    )
    expect(await response.json()).toEqual({
      error: { code: 'LAST_ACTIVE_OWNER', correlationId: CORRELATION_ID },
    })
    expect(await Promise.all([
      env.DB.prepare('SELECT role,status,version FROM staff_users WHERE id=?')
        .bind(fixture.actor.id).first(),
      env.DB.prepare('SELECT revision FROM staff_authorities WHERE staff_id=?')
        .bind(fixture.actor.id).first(),
      count("SELECT count(*) AS count FROM audit_events WHERE action='staff.role.updated'"),
      count("SELECT count(*) AS count FROM idempotency_records WHERE operation='staff.role.update'"),
    ])).toEqual(before)
  })
})

describe('staff authorization denial', () => {
  it.each(['coordinator', 'specialist'])(
    'returns the same forbidden envelope and persists one encrypted denial for %s',
    async (role) => {
      const fixture = await actorFixture(role, `denied_${role}`)
      const deps = appDeps(fixture, { idFactory: ids(`deny_${role}`) })
      const response = await createApp(deps).request('/api/v1/staff', {
        headers: { 'x-correlation-id': CORRELATION_ID },
      })
      expectBoundary(response, 403)
      expect(await response.json()).toEqual({
        error: { code: 'FORBIDDEN', correlationId: CORRELATION_ID },
      })
      const rows = (await env.DB.prepare(
        `SELECT actor_staff_id,action,entity_type,entity_id,result,reason_envelope,
                correlation_id,metadata_json
         FROM audit_events
         WHERE action='authorization.denied' AND actor_staff_id=?`
      ).bind(fixture.actor.id).all()).results
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        actor_staff_id: fixture.actor.id,
        action: 'authorization.denied',
        entity_type: 'staff_user',
        entity_id: fixture.actor.id,
        result: 'denied',
        correlation_id: CORRELATION_ID,
        metadata_json: '{"version":1}',
      })
      expect(rows[0].reason_envelope).not.toContain('staff.manage denied')
      await expect(decryptForScope(
        fixture.cryptoContext.keyring,
        fixture.cryptoContext.dataKey,
        {
          expectedScope: fixture.cryptoContext.scope,
          recordId: `deny_${role}_1`,
          field: 'reason',
          envelope: JSON.parse(rows[0].reason_envelope),
        },
      )).resolves.toBe('staff.manage denied')
    },
  )

  it('fails closed with an internal error when denial persistence fails', async () => {
    const fixture = await actorFixture('coordinator', 'denial_storage')
    const marker = 'denial-storage-parent@example.test'
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: vi.fn(async () => { throw new Error(marker) }),
    }
    const deps = appDeps(fixture, { db, idFactory: ids('deny_storage') })
    const response = await createApp(deps).request('/api/v1/staff', {
      headers: { 'x-correlation-id': CORRELATION_ID },
    })
    expectBoundary(response, 500)
    const body = await response.json()
    expect(body).toEqual({
      error: { code: 'INTERNAL_ERROR', correlationId: CORRELATION_ID },
    })
    expect(JSON.stringify({ body, logs: deps.safeLog.mock.calls })).not.toContain(marker)
  })
})

describe('staff request validation and public errors', () => {
  it.each([
    '{"displayName":"Anna","email":"anna@example.test","role":"owner","role":"specialist"}',
    '{"displayName":"Anna","email":"anna@example.test","role":"owner","\\u0072ole":"specialist"}',
  ])('rejects duplicate top-level keys before a staff mutation: %s', async (rawBody) => {
    const fixture = await actorFixture('owner', 'duplicate_owner')
    const deps = appDeps(fixture, { idFactory: ids('duplicate') })
    const beforeInvitations = await count('SELECT count(*) AS count FROM staff_invitations')
    const request = mutation('/api/v1/staff/invitations', rawBody, 'duplicate-key')
    const response = await createApp(deps).request(request.path, request.init)
    expectBoundary(response, 400)
    expect(await response.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', correlationId: CORRELATION_ID },
    })
    expect(await count('SELECT count(*) AS count FROM staff_invitations')).toBe(
      beforeInvitations,
    )
  })

  it.each([
    [undefined, 'missing'],
    ['short', 'invalid'],
    ['contains space', 'invalid'],
  ])('rejects a %s idempotency key without mutation', async (key) => {
    const fixture = await actorFixture('owner', `idem_${key ?? 'missing'}`)
    const deps = appDeps(fixture, { idFactory: ids('idem_invalid') })
    const beforeInvitations = await count('SELECT count(*) AS count FROM staff_invitations')
    const beforeDenials = await count(
      "SELECT count(*) AS count FROM audit_events WHERE action='authorization.denied'"
    )
    const request = mutation('/api/v1/staff/invitations', JSON.stringify({
      displayName: 'Anna',
      email: 'anna@example.test',
      role: 'coordinator',
    }), key)
    const response = await createApp(deps).request(request.path, request.init)
    expectBoundary(response, 400)
    expect(await response.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', correlationId: CORRELATION_ID },
    })
    expect(await count('SELECT count(*) AS count FROM staff_invitations')).toBe(
      beforeInvitations,
    )
    expect(await count(
      "SELECT count(*) AS count FROM audit_events WHERE action='authorization.denied'"
    )).toBe(beforeDenials)
  })

  it.each([
    [
      { displayName: '', email: 'anna@example.test', role: 'owner' },
      'displayName',
    ],
    [
      { displayName: 'Anna', email: 'anna@real.test', role: 'owner' },
      'email',
    ],
    [
      { displayName: 'Anna', email: 'anna@example.test', role: 'admin' },
      'role',
    ],
    [
      { displayName: 'Anna', email: 'anna@example.test', role: 'owner', extra: true },
      'displayName',
    ],
  ])('returns only the allow-listed field for invalid invite input', async (body, field) => {
    const fixture = await actorFixture('owner', `invalid_${field}`)
    const deps = appDeps(fixture, { idFactory: ids('invalid_field') })
    const request = mutation(
      '/api/v1/staff/invitations',
      JSON.stringify(body),
      `invalid-${field}-key`,
    )
    const response = await createApp(deps).request(request.path, request.init)
    expectBoundary(response, 400)
    expect(await response.json()).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        correlationId: CORRELATION_ID,
        details: { field },
      },
    })
  })

  it('rejects extra deactivation keys without changing the target', async () => {
    const fixture = await actorFixture('owner', 'exact_owner')
    await seedActiveStaff(fixture.cryptoContext, {
      id: 'stf_exact_target',
      role: 'coordinator',
      email: 'exact-target@example.test',
      displayName: 'Exact Target',
    })
    const deps = appDeps(fixture, { idFactory: ids('exact_body') })
    const request = mutation(
      '/api/v1/staff/stf_exact_target/deactivation',
      '{"version":1,"extra":true}',
      'exact-body-key',
    )
    const response = await createApp(deps).request(request.path, request.init)
    expectBoundary(response, 400)
    expect(await response.json()).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        correlationId: CORRELATION_ID,
        details: { field: 'version' },
      },
    })
    expect(await env.DB.prepare(
      'SELECT status,version FROM staff_users WHERE id=?'
    ).bind('stf_exact_target').first()).toEqual({ status: 'active', version: 1 })
  })

  it('maps replay conflict, invitation conflict, missing staff, and stale version exactly', async () => {
    const fixture = await actorFixture('owner', 'conflict_owner')
    const deps = appDeps(fixture, { idFactory: ids('conflict') })
    const app = createApp(deps)
    const firstRequest = mutation('/api/v1/staff/invitations', JSON.stringify({
      displayName: 'Conflict Testowa',
      email: 'conflict@example.test',
      role: 'coordinator',
    }), 'conflict-replay-key')
    expect((await app.request(firstRequest.path, firstRequest.init)).status).toBe(201)

    const digestConflict = mutation('/api/v1/staff/invitations', JSON.stringify({
      displayName: 'Inna Testowa',
      email: 'inna@example.test',
      role: 'coordinator',
    }), 'conflict-replay-key')
    const digestResponse = await app.request(digestConflict.path, digestConflict.init)
    expect(digestResponse.status).toBe(409)
    expect(await digestResponse.json()).toEqual({
      error: { code: 'IDEMPOTENCY_CONFLICT', correlationId: CORRELATION_ID },
    })

    const invitationConflict = mutation('/api/v1/staff/invitations', JSON.stringify({
      displayName: 'Conflict Testowa',
      email: 'conflict@example.test',
      role: 'coordinator',
    }), 'different-invite-key')
    const invitationResponse = await app.request(
      invitationConflict.path,
      invitationConflict.init,
    )
    expect(invitationResponse.status).toBe(409)
    expect(await invitationResponse.json()).toEqual({
      error: { code: 'STAFF_INVITATION_CONFLICT', correlationId: CORRELATION_ID },
    })

    const missing = mutation(
      '/api/v1/staff/stf_missing/deactivation',
      '{"version":1}',
      'missing-staff-key',
    )
    const missingResponse = await app.request(missing.path, missing.init)
    expect(missingResponse.status).toBe(404)
    expect(await missingResponse.json()).toEqual({
      error: { code: 'NOT_FOUND', correlationId: CORRELATION_ID },
    })

    const stale = mutation(
      '/api/v1/staff/stf_conflict_1/deactivation',
      '{"version":2}',
      'stale-version-key',
    )
    const staleResponse = await app.request(stale.path, stale.init)
    expect(staleResponse.status).toBe(409)
    expect(await staleResponse.json()).toEqual({
      error: {
        code: 'VERSION_CONFLICT',
        correlationId: CORRELATION_ID,
        details: { currentVersion: 1 },
      },
    })
    expect(await count(
      "SELECT count(*) AS count FROM audit_events WHERE action='authorization.denied' AND actor_staff_id=?",
      fixture.actor.id,
    )).toBe(0)
  })

  it('maps sole-owner deactivation to the exact last-owner conflict', async () => {
    const fixture = await actorFixture('owner', 'last_owner')
    await retainOnlyActiveOwner(fixture.actor.id)
    const deps = appDeps(fixture, { idFactory: ids('last_owner') })
    const request = mutation(
      `/api/v1/staff/${fixture.actor.id}/deactivation`,
      '{"version":1}',
      'last-owner-key',
    )
    const response = await createApp(deps).request(request.path, request.init)
    expectBoundary(response, 409)
    expect(await response.json()).toEqual({
      error: { code: 'LAST_ACTIVE_OWNER', correlationId: CORRELATION_ID },
    })
    expect(await count(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.deactivated' AND actor_staff_id=?",
      fixture.actor.id,
    )).toBe(0)
  })

  it('returns rate limited on the sixth accepted-hour attempt without partial staff state', async () => {
    const fixture = await actorFixture('owner', 'rate_owner')
    const deps = appDeps(fixture, { idFactory: ids('rate') })
    const app = createApp(deps)
    const beforeStaff = await count('SELECT count(*) AS count FROM staff_users')
    const beforeInvites = await count(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.invited' AND actor_staff_id=?",
      fixture.actor.id,
    )
    const beforeDenials = await count(
      "SELECT count(*) AS count FROM audit_events WHERE action='authorization.denied' AND actor_staff_id=?",
      fixture.actor.id,
    )
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const request = mutation('/api/v1/staff/invitations', JSON.stringify({
        displayName: `Rate ${attempt}`,
        email: `rate-${attempt}@example.test`,
        role: 'coordinator',
      }), `rate-limit-key-${attempt}`)
      expect((await app.request(request.path, request.init)).status).toBe(201)
    }
    const sixth = mutation('/api/v1/staff/invitations', JSON.stringify({
      displayName: 'Rate 6',
      email: 'rate-6@example.test',
      role: 'coordinator',
    }), 'rate-limit-key-6')
    const response = await app.request(sixth.path, sixth.init)
    expectBoundary(response, 429)
    expect(await response.json()).toEqual({
      error: { code: 'RATE_LIMITED', correlationId: CORRELATION_ID },
    })
    expect(await count(
      'SELECT count(*) AS count FROM staff_users'
    )).toBe(beforeStaff + 5)
    expect(await count(
      "SELECT count(*) AS count FROM audit_events WHERE action='staff.invited' AND actor_staff_id=?",
      fixture.actor.id,
    )).toBe(beforeInvites + 5)
    expect(await count(
      "SELECT count(*) AS count FROM audit_events WHERE action='authorization.denied' AND actor_staff_id=?",
      fixture.actor.id,
    )).toBe(beforeDenials + 1)
  })

  it('sanitizes an internal staff handler failure in the response and lifecycle log', async () => {
    const fixture = await actorFixture('owner', 'internal_owner')
    const marker = 'provider-object-parent@example.test'
    const deps = appDeps(fixture, {
      getStaff: vi.fn(async () => {
        const error = new Error(marker)
        error.code = 'FORBIDDEN'
        error.status = 403
        error.body = { marker }
        throw error
      }),
    })
    const response = await createApp(deps).request('/api/v1/staff', {
      headers: { 'x-correlation-id': CORRELATION_ID },
    })
    expectBoundary(response, 500)
    const body = await response.json()
    expect(body).toEqual({
      error: { code: 'INTERNAL_ERROR', correlationId: CORRELATION_ID },
    })
    expectOneSafeLog(deps, [marker])
  })
})
