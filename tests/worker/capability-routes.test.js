import { describe, expect, it, vi } from 'vitest'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'
import { CORE_ROUTE_DESCRIPTORS, createApp } from '../../worker/app.js'
import {
  areSiblingD1QueryBudgetViews,
  usageForD1QueryBudgetViews,
} from '../../worker/db/query-budget.js'
import {
  getCapabilityOverride,
  getCapabilityTargets,
  postCapabilityOverride,
} from '../../worker/routes/capability-overrides.js'

const NOW_MS = Date.parse('2026-08-28T12:00:00.000Z')
const ORIGIN = 'https://bearwithme-panel.app'
const CORRELATION_ID = '99999999-9999-4999-8999-999999999999'
const STAFF_ID = 'stf_capability_route_target'
const ACTOR = Object.freeze({
  id: 'stf_capability_route_owner',
  role: 'owner',
  specialistId: null,
  version: 3,
  authorityRevision: 7,
  capabilities: ROLE_DEFAULT_CAPABILITIES.owner,
})
const REPLACEMENT = Object.freeze({
  expectedAuthorityRevision: 2,
  allow: Object.freeze(['finance.import']),
  deny: Object.freeze(['client.manage']),
})
const AUTHORITY = Object.freeze({
  staffId: STAFF_ID,
  displayName: 'Karolina Koordynatorka',
  role: 'coordinator',
  status: 'active',
  authorityRevision: 3,
  allow: Object.freeze(['finance.import']),
  deny: Object.freeze(['client.manage']),
  effectiveCapabilities: Object.freeze([
    'appointment.charge.read',
    'appointment.manage',
    'chat.direct',
    'chat.general',
    'client.operational.read',
    'finance.centre.read',
    'finance.import',
    'operations.health.read',
    'payment.manage',
    'specialist.directory.read',
    'tus.manage',
    'workbook.centre.export',
  ]),
})
const TARGETS = Object.freeze([Object.freeze({
  staffId: STAFF_ID,
  displayName: AUTHORITY.displayName,
  role: AUTHORITY.role,
  status: AUTHORITY.status,
  authorityRevision: 2,
})])

const statement = (calls, sql, bindings = []) => {
  const value = {
    bind: vi.fn((...next) => statement(calls, sql, next)),
    all: vi.fn(async () => { calls.push({ method: 'all', sql, bindings }); return { results: [] } }),
    first: vi.fn(async () => { calls.push({ method: 'first', sql, bindings }); return null }),
    raw: vi.fn(async () => { calls.push({ method: 'raw', sql, bindings }); return [] }),
    run: vi.fn(async () => { calls.push({ method: 'run', sql, bindings }); return { success: true } }),
  }
  return value
}

const database = () => {
  const calls = []
  return Object.freeze({
    calls,
    prepare: vi.fn((sql) => statement(calls, sql)),
    batch: vi.fn(async (statements) => statements.map(() => ({ success: true }))),
  })
}

const depsFor = (overrides = {}) => ({
  config: { appEnv: 'staging', appOrigin: ORIGIN, dataMode: 'fictional' },
  db: database(),
  cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
  now: () => NOW_MS,
  resolveAccessPrincipal: vi.fn(async () => ({
    kind: 'human',
    subject: 'access-capability-owner',
    normalizedEmail: 'capability-owner@example.test',
  })),
  resolveActor: vi.fn(async () => ACTOR),
  verifyCsrfToken: vi.fn(async () => true),
  safeLog: vi.fn(),
  idFactory: () => 'capability_route_fixture',
  ...overrides,
})

const mutation = (body = REPLACEMENT, key = 'capability-route-key-0001') => ({
  method: 'POST',
  headers: {
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin',
    'X-CSRF-Token': 'valid',
    'X-Correlation-Id': CORRELATION_ID,
    ...(key === null ? {} : { 'Idempotency-Key': key }),
  },
  body: JSON.stringify(body),
})

describe('capability override route adapters', () => {
  it('forwards exact service inputs and maps only contract validation fields', async () => {
    const list = vi.fn(async () => ({ data: { targets: TARGETS } }))
    const read = vi.fn(async () => ({ data: { authority: AUTHORITY } }))
    const replace = vi.fn(async () => ({ data: { authority: AUTHORITY } }))
    const base = {
      db: {}, recoveryDb: {}, cryptoContext: {}, actor: ACTOR,
      staffId: STAFF_ID, input: REPLACEMENT,
      idempotencyKey: 'capability-adapter-key-0001', correlationId: CORRELATION_ID,
      nowMs: NOW_MS, idFactory: () => 'adapter', ignored: 'never-forwarded',
    }

    await expect(getCapabilityTargets({ ...base, list })).resolves.toEqual({
      data: { targets: TARGETS },
    })
    expect(list).toHaveBeenCalledWith({
      db: base.db, cryptoContext: base.cryptoContext, actor: ACTOR, nowMs: NOW_MS,
    })
    await expect(getCapabilityOverride({ ...base, read })).resolves.toEqual({
      data: { authority: AUTHORITY },
    })
    expect(read).toHaveBeenCalledWith({
      db: base.db, cryptoContext: base.cryptoContext, actor: ACTOR,
      staffId: STAFF_ID, nowMs: NOW_MS,
    })
    await expect(postCapabilityOverride({ ...base, replace })).resolves.toEqual({
      data: { authority: AUTHORITY },
    })
    expect(replace).toHaveBeenCalledWith({
      db: base.db, recoveryDb: base.recoveryDb, cryptoContext: base.cryptoContext,
      actor: ACTOR, staffId: STAFF_ID, input: REPLACEMENT,
      idempotencyKey: base.idempotencyKey, correlationId: CORRELATION_ID,
      nowMs: NOW_MS, idFactory: base.idFactory,
    })

    for (const field of ['body', 'allow', 'deny', 'expectedAuthorityRevision']) {
      await expect(postCapabilityOverride({
        ...base,
        replace: vi.fn(async () => { throw new TypeError(`VALIDATION_FAILED/${field}`) }),
      })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', status: 400, details: { field },
      })
    }
  })
})

describe('capability override HTTP boundary', () => {
  it('publishes exact known-capability descriptors and the larger bounded replacement budget', () => {
    const selected = CORE_ROUTE_DESCRIPTORS.filter(({ id }) => id.startsWith('permissions.'))
    expect(selected.map((route) => ({
      id: route.id,
      path: route.path ?? null,
      pathPattern: route.pathPattern ?? null,
      methods: route.methods,
      allow: route.allow,
      capability: route.capability,
      auditActions: route.auditActions,
      bodyKeys: route.bodyKeys,
      queryMode: route.queryMode,
      sharedBudget: route.sharedBudget,
    }))).toEqual([
      {
        id: 'permissions.targets',
        path: '/api/v1/staff/capability-targets',
        pathPattern: null,
        methods: ['GET', 'HEAD', 'OPTIONS'],
        allow: 'GET, HEAD, OPTIONS',
        capability: 'permissions.manage',
        auditActions: [],
        bodyKeys: null,
        queryMode: 'none',
        sharedBudget: { totalLimit: 50, recoveryReserve: 8 },
      },
      {
        id: 'permissions.read',
        path: null,
        pathPattern: '^/api/v1/staff/stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}/capability-overrides$',
        methods: ['GET', 'HEAD', 'OPTIONS'],
        allow: 'GET, HEAD, OPTIONS',
        capability: 'permissions.manage',
        auditActions: [],
        bodyKeys: null,
        queryMode: 'none',
        sharedBudget: { totalLimit: 50, recoveryReserve: 8 },
      },
      {
        id: 'permissions.replace',
        path: null,
        pathPattern: '^/api/v1/staff/stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}/capability-overrides/edits$',
        methods: ['POST', 'OPTIONS'],
        allow: 'POST, OPTIONS',
        capability: 'permissions.manage',
        auditActions: ['staff.capabilities.updated'],
        bodyKeys: ['expectedAuthorityRevision', 'allow', 'deny'],
        queryMode: 'none',
        sharedBudget: { totalLimit: 80, recoveryReserve: 12 },
      },
    ])
    expect(selected).toHaveLength(3)
    expect(selected.every((route) => Object.isFrozen(route)
      && Object.isFrozen(route.methods)
      && Object.isFrozen(route.auditActions)
      && Object.isFrozen(route.sharedBudget))).toBe(true)
  })

  it('dispatches targets, exact authority reads, HEAD, and replacement through bounded views', async () => {
    const listCapabilityTargets = vi.fn(async () => ({ data: { targets: TARGETS } }))
    const getCapabilityOverrides = vi.fn(async () => ({ data: { authority: AUTHORITY } }))
    const replaceCapabilityOverrides = vi.fn(async () => ({ data: { authority: AUTHORITY } }))
    const input = depsFor({
      listCapabilityTargets,
      getCapabilityOverrides,
      replaceCapabilityOverrides,
    })
    const app = createApp(input)

    const targets = await app.request('/api/v1/staff/capability-targets')
    expect(targets.status).toBe(200)
    expect(await targets.json()).toEqual({ data: { targets: TARGETS } })
    const read = await app.request(`/api/v1/staff/${STAFF_ID}/capability-overrides`)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ data: { authority: AUTHORITY } })
    const head = await app.request(`/api/v1/staff/${STAFF_ID}/capability-overrides`, {
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const changed = await app.request(
      `/api/v1/staff/${STAFF_ID}/capability-overrides/edits`,
      mutation(),
    )
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ data: { authority: AUTHORITY } })

    expect(listCapabilityTargets).toHaveBeenCalledWith(expect.objectContaining({
      actor: ACTOR,
      cryptoContext: input.cryptoContext,
      nowMs: NOW_MS,
    }))
    expect(getCapabilityOverrides).toHaveBeenCalledWith(expect.objectContaining({
      actor: ACTOR,
      staffId: STAFF_ID,
      nowMs: NOW_MS,
    }))
    expect(replaceCapabilityOverrides).toHaveBeenCalledWith(expect.objectContaining({
      actor: ACTOR,
      staffId: STAFF_ID,
      input: REPLACEMENT,
      idempotencyKey: 'capability-route-key-0001',
      correlationId: CORRELATION_ID,
      nowMs: NOW_MS,
    }))
    const command = replaceCapabilityOverrides.mock.calls[0][0]
    expect(areSiblingD1QueryBudgetViews(command.db, command.recoveryDb)).toBe(true)
    expect(input.verifyCsrfToken).toHaveBeenCalledOnce()
  })

  it('rejects aliases, queries, extra bodies, missing idempotency, and wrong methods before dispatch', async () => {
    const listCapabilityTargets = vi.fn(async () => ({ data: { targets: [] } }))
    const getCapabilityOverrides = vi.fn(async () => ({ data: { authority: AUTHORITY } }))
    const replaceCapabilityOverrides = vi.fn(async () => ({ data: { authority: AUTHORITY } }))
    const input = depsFor({
      listCapabilityTargets,
      getCapabilityOverrides,
      replaceCapabilityOverrides,
    })
    const app = createApp(input)

    for (const path of [
      '/api/v1/staff/capability-targets?centreId=centre_1',
      `/api/v1/staff/${STAFF_ID}/capability-overrides/`,
      `/api/v1/staff/${STAFF_ID}/capability-overrides?raw=true`,
      '/api/v1/staff/staff_target/capability-overrides',
      `/api/v1/staff/${STAFF_ID}/capability-overrides/edits?raw=true`,
    ]) {
      const response = await app.request(path, path.includes('/edits') ? mutation() : undefined)
      expect(response.status, path).toBe(404)
    }
    expect(listCapabilityTargets).not.toHaveBeenCalled()
    expect(getCapabilityOverrides).not.toHaveBeenCalled()
    expect(replaceCapabilityOverrides).not.toHaveBeenCalled()

    const extra = await app.request(
      `/api/v1/staff/${STAFF_ID}/capability-overrides/edits`,
      mutation({ ...REPLACEMENT, email: 'private@example.test' }, 'capability-extra-key'),
    )
    expect(extra.status).toBe(400)
    expect((await extra.json()).error).toMatchObject({
      code: 'VALIDATION_FAILED', details: { field: 'body' },
    })
    const duplicate = await app.request(
      `/api/v1/staff/${STAFF_ID}/capability-overrides/edits`,
      {
        ...mutation(REPLACEMENT, 'capability-duplicate-key'),
        body: '{"expectedAuthorityRevision":2,"allow":[],"allow":["finance.import"],"deny":[]}',
      },
    )
    expect(duplicate.status).toBe(400)
    expect((await duplicate.json()).error.code).toBe('VALIDATION_FAILED')
    const missingKey = await app.request(
      `/api/v1/staff/${STAFF_ID}/capability-overrides/edits`,
      mutation(REPLACEMENT, null),
    )
    expect(missingKey.status).toBe(400)
    expect((await missingKey.json()).error.code).toBe('VALIDATION_FAILED')
    const wrongMethod = await app.request(
      `/api/v1/staff/${STAFF_ID}/capability-overrides`,
      { method: 'PUT', headers: { Origin: ORIGIN } },
    )
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    expect(replaceCapabilityOverrides).not.toHaveBeenCalled()

    const csrfService = vi.fn()
    const csrf = await createApp(depsFor({
      replaceCapabilityOverrides: csrfService,
      verifyCsrfToken: vi.fn(async () => { throw new Error('CSRF_INVALID') }),
    })).request(
      `/api/v1/staff/${STAFF_ID}/capability-overrides/edits`,
      mutation(REPLACEMENT, 'capability-csrf-key'),
    )
    expect(csrf.status).toBe(403)
    expect((await csrf.json()).error.code).toBe('CSRF_INVALID')
    expect(csrfService).not.toHaveBeenCalled()

    for (const [path, allow] of [
      ['/api/v1/staff/capability-targets', 'GET, HEAD, OPTIONS'],
      [`/api/v1/staff/${STAFF_ID}/capability-overrides`, 'GET, HEAD, OPTIONS'],
      [`/api/v1/staff/${STAFF_ID}/capability-overrides/edits`, 'POST, OPTIONS'],
    ]) {
      const response = await app.request(path, {
        method: 'OPTIONS', headers: { Origin: ORIGIN },
      })
      expect(response.status).toBe(204)
      expect(response.headers.get('allow')).toBe(allow)
    }
  })

  it('maps concealed, forbidden, validation, and version errors without leaking details', async () => {
    const secret = 'private@example.test'
    const denied = new Error('FORBIDDEN')
    denied.details = { email: secret }
    const forbidden = await createApp(depsFor({
      listCapabilityTargets: vi.fn(async () => { throw denied }),
    })).request('/api/v1/staff/capability-targets')
    expect(forbidden.status).toBe(403)
    expect(JSON.stringify(await forbidden.json())).not.toContain(secret)

    const missing = await createApp(depsFor({
      getCapabilityOverrides: vi.fn(async () => { throw new Error('NOT_FOUND') }),
    })).request(`/api/v1/staff/${STAFF_ID}/capability-overrides`)
    expect(missing.status).toBe(404)

    const validation = new Error('VALIDATION_FAILED')
    validation.details = { field: 'deny' }
    const invalid = await createApp(depsFor({
      replaceCapabilityOverrides: vi.fn(async () => { throw validation }),
    })).request(
      `/api/v1/staff/${STAFF_ID}/capability-overrides/edits`,
      mutation(REPLACEMENT, 'capability-validation-key'),
    )
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error.details).toEqual({ field: 'deny' })

    const conflict = new Error('VERSION_CONFLICT')
    conflict.details = { currentVersion: 9, displayName: secret }
    const stale = await createApp(depsFor({
      replaceCapabilityOverrides: vi.fn(async () => { throw conflict }),
    })).request(
      `/api/v1/staff/${STAFF_ID}/capability-overrides/edits`,
      mutation(REPLACEMENT, 'capability-conflict-key'),
    )
    const staleBody = await stale.json()
    expect(stale.status).toBe(409)
    expect(staleBody.error.details).toEqual({ currentVersion: 9 })
    expect(JSON.stringify(staleBody)).not.toContain(secret)
  })

  it('admits the maximum replacement statement shape while retaining recovery reserve', async () => {
    let views
    const replaceCapabilityOverrides = vi.fn(async (input) => {
      views = { work: input.db, recovery: input.recoveryDb }
      for (let index = 0; index < 61; index += 1) {
        await input.db.prepare(`SELECT capability_budget_${index}`).first()
      }
      return { data: { authority: AUTHORITY } }
    })
    const response = await createApp(depsFor({ replaceCapabilityOverrides })).request(
      `/api/v1/staff/${STAFF_ID}/capability-overrides/edits`,
      mutation(REPLACEMENT, 'capability-budget-key'),
    )

    expect(response.status).toBe(200)
    expect(areSiblingD1QueryBudgetViews(views.work, views.recovery)).toBe(true)
    expect(usageForD1QueryBudgetViews(views.work, views.recovery)).toEqual({
      used: 61,
      remaining: 19,
      workRemaining: 7,
      totalLimit: 80,
      recoveryReserve: 12,
    })
  })
})
