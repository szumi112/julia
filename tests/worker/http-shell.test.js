import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import { createD1QueryBudget } from '../../worker/db/query-budget.js'
import { safeLog } from '../../worker/logging/safe-log.js'

const deps = (overrides = {}) => ({
  config: {
    appEnv: 'staging',
    appOrigin: 'https://panel.bearwithme.pl',
    dataMode: 'fictional',
  },
  resolveAccessPrincipal: vi.fn(async () => ({
    kind: 'human',
    subject: 'access-shell',
    normalizedEmail: 'shell@example.test',
  })),
  resolveActor: vi.fn(async () => ({
    id: 'stf_shell',
    role: 'owner',
    specialistId: null,
    version: 1,
  })),
  cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
  ...overrides,
})

function coreBudgetDb(order = []) {
  const calls = []
  const statement = (sql, bindings = []) => ({
    bind(...values) { return statement(sql, values) },
    run() { calls.push({ method: 'run', sql, bindings }); return Promise.resolve({ success: true }) },
    first() {
      calls.push({ method: 'first', sql, bindings })
      if (sql.includes('FROM data_keys')) {
        order.push('query.data-key')
        return Promise.resolve({
          id: 'key_core_fixture', scope_type: 'staff_directory', scope_id: 'centre_1',
          purpose: 'identity', dek_version: 1, wrapped_key_b64: 'wrapped',
          wrap_nonce_b64: 'nonce', kek_version: 1, created_at: '2026-08-04T00:00:00.000Z',
          retired_at: null,
        })
      }
      return Promise.resolve(null)
    },
    all() { calls.push({ method: 'all', sql, bindings }); return Promise.resolve({ results: [] }) },
    raw() { calls.push({ method: 'raw', sql, bindings }); return Promise.resolve([]) },
  })
  const db = { calls }
  Object.defineProperties(db, {
    prepare: { configurable: true, get() { order.push('capture.prepare'); return (sql) => statement(sql) } },
    batch: {
      configurable: true,
      get() {
        order.push('capture.batch')
        return (statements) => {
          calls.push({ method: 'batch', count: statements.length })
          return Promise.resolve(statements.map(() => ({ success: true })))
        }
      },
    },
  })
  return db
}

describe('API shell', () => {
  it('returns a stable envelope and correlation id for authenticated unknown API routes', async () => {
    const log = vi.fn()
    const response = await createApp(deps({ safeLog: log })).request(
      '/api/v1/not-present?marker=parent@example.test'
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    })
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('warn', expect.objectContaining({
      event: 'request.failed',
      errorCode: 'NOT_FOUND',
      routeId: 'unmatched',
      status: 404,
    }))
    expect(JSON.stringify(log.mock.calls)).not.toContain('parent@example.test')
  })

  it('never lets the API route fall through to the SPA', async () => {
    const response = await createApp().request('/api/not-present')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('regenerates an untrusted correlation id and keeps arbitrary error codes generic', async () => {
    const log = vi.fn()
    const app = createApp(deps({ safeLog: log }))
    app.get('/api/v1/test-error', () => {
      const error = new Error('provider failure')
      error.code = 'PROVIDER_SECRET_FAILURE'
      error.status = 418
      error.body = 'parent@example.test'
      throw error
    })

    const response = await app.request('/api/v1/test-error', {
      headers: { 'x-correlation-id': 'parent@example.test' },
    })
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(body)).not.toContain('parent@example.test')
    expect(log).toHaveBeenCalledWith('error', expect.objectContaining({
      event: 'request.failed',
      correlationId: response.headers.get('x-correlation-id'),
      errorCode: 'INTERNAL_ERROR',
      method: 'GET',
      result: 'failure',
      routeId: 'unmatched',
      status: 500,
    }))
  })
})

describe('core route D1 budget boundary', () => {
  const path = '/api/v1/__core-budget-fixture'

  it('installs one 50/8 budget before identity crypto and shares its exact views', async () => {
    const order = []
    const db = coreBudgetDb(order)
    let actorWork
    let actorRecovery
    const fixture = vi.fn(async ({ db: work, recoveryDb, budget }) => {
      order.push('fixture')
      expect(work).toBe(actorWork)
      expect(recoveryDb).toBe(actorRecovery)
      expect(budget.usage()).toEqual({
        used: 3, remaining: 47, workRemaining: 39, totalLimit: 50, recoveryReserve: 8,
      })
      return { data: { usage: budget.usage() } }
    })
    const input = deps({
      cryptoContext: undefined,
      db,
      keyring: {},
      coreRouteFixture: fixture,
      resolveAccessPrincipal: vi.fn(async () => { order.push('access'); return { kind: 'human', subject: 'access-core', normalizedEmail: 'core@example.test' } }),
      resolveActor: vi.fn(async (work, _principal, _context, options) => {
        order.push('actor')
        actorWork = work
        actorRecovery = options.recoveryDb
        expect(work).not.toBe(db)
        expect(actorRecovery).not.toBe(work)
        await work.prepare('SELECT actor_one').first()
        await work.prepare('SELECT actor_two').first()
        return { id: 'stf_core', role: 'owner', specialistId: null, version: 1 }
      }),
    })

    const response = await createApp(input).request(path)

    expect(response.status).toBe(200)
    expect(fixture).toHaveBeenCalledOnce()
    expect(order).toEqual([
      'capture.prepare', 'capture.batch', 'access', 'query.data-key', 'actor', 'fixture',
    ])
    expect(db.calls.map((call) => call.sql)).toEqual([
      expect.stringContaining('FROM data_keys'), 'SELECT actor_one', 'SELECT actor_two',
    ])
  })

  it('keeps GET recovery unused and bounds a combined synthetic collision path at 50', async () => {
    const getDb = coreBudgetDb()
    const getFixture = vi.fn(async ({ budget }) => ({ data: { usage: budget.usage() } }))
    const getResponse = await createApp(deps({
      db: getDb, coreRouteFixture: getFixture,
      resolveActor: vi.fn(async () => ({ id: 'stf_get', role: 'owner', specialistId: null, version: 1 })),
    })).request(path)
    expect(getResponse.status).toBe(200)
    expect((await getResponse.json()).data.usage.used).toBe(0)

    const db = coreBudgetDb()
    const combined = vi.fn(async ({ db: work, recoveryDb, budget }) => {
      await work.batch(Array.from({ length: 39 }, (_, index) => work.prepare(`SELECT domain_${index}`)))
      expect(() => work.prepare('SELECT ordinary_over_ceiling').run())
        .toThrow('D1_QUERY_BUDGET_EXCEEDED')
      await recoveryDb.batch(Array.from({ length: 8 }, (_, index) => recoveryDb.prepare(`SELECT recovery_${index}`)))
      expect(() => recoveryDb.prepare('SELECT total_over_ceiling').run())
        .toThrow('D1_QUERY_BUDGET_EXCEEDED')
      return { data: { usage: budget.usage() } }
    })
    const response = await createApp(deps({
      cryptoContext: undefined,
      db,
      keyring: {},
      coreRouteFixture: combined,
      resolveActor: vi.fn(async (work) => {
        await work.prepare('SELECT actor_one').first()
        await work.prepare('SELECT actor_two').first()
        return { id: 'stf_combined', role: 'owner', specialistId: null, version: 1 }
      }),
    })).request(path)

    expect(response.status).toBe(200)
    expect((await response.json()).data.usage).toEqual({
      used: 50, remaining: 0, workRemaining: 0, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('does not activate the inert fixture from request or environment data', async () => {
    const input = deps({ db: coreBudgetDb(), coreRouteFixture: undefined })
    const response = await createApp(input).request(`${path}?coreRouteFixture=true`, {
      headers: { 'x-core-route-fixture': 'true' },
    }, { coreRouteFixture: true })

    expect(response.status).toBe(404)
    expect(input.resolveActor).toHaveBeenCalledOnce()
  })

  it('activates the inert fixture only from one own data-valued createApp dependency', async () => {
    const inheritedFixture = vi.fn()
    const inherited = Object.assign(Object.create({ coreRouteFixture: inheritedFixture }), deps())
    const inheritedResponse = await createApp(inherited).request(path)
    expect(inheritedResponse.status).toBe(404)
    expect(inheritedFixture).not.toHaveBeenCalled()

    let getterCalls = 0
    const accessor = deps()
    Object.defineProperty(accessor, 'coreRouteFixture', {
      enumerable: true,
      get() { getterCalls += 1; return vi.fn() },
    })
    const accessorResponse = await createApp(accessor).request(path)
    expect(accessorResponse.status).toBe(404)
    expect(getterCalls).toBe(0)
  })

  it.each([
    ['missing batch', { prepare() {} }],
    ['nested work view', createD1QueryBudget(coreBudgetDb(), { totalLimit: 50, recoveryReserve: 8 }).work],
    ['hostile prepare', Object.defineProperty({ batch() {} }, 'prepare', { get() { throw new Error('private-db-marker') } })],
  ])('fails closed before Access for a %s DB surface', async (_label, db) => {
    const input = deps({ db, coreRouteFixture: vi.fn(), resolveAccessPrincipal: vi.fn(), resolveActor: vi.fn() })
    const response = await createApp(input).request(path)

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })
    expect(input.resolveAccessPrincipal).not.toHaveBeenCalled()
    expect(input.resolveActor).not.toHaveBeenCalled()
  })

  it('preserves raw D1 identity for an existing non-core route', async () => {
    const rawDb = coreBudgetDb()
    const service = vi.fn(async ({ db }) => {
      expect(db).toBe(rawDb)
      return { data: { ok: true } }
    })
    const input = deps({
      db: rawDb,
      getOperationalHealth: service,
      resolveActor: vi.fn(async (db) => {
        expect(db).toBe(rawDb)
        return { id: 'stf_non_core', role: 'owner', specialistId: null, version: 1 }
      }),
    })

    const response = await createApp(input).request('/api/v1/operations/health')

    expect(response.status).toBe(200)
    expect(service).toHaveBeenCalledOnce()
  })
})

describe('operations HTTP shell', () => {
  const correlationId = '11111111-1111-4111-8111-111111111111'
  const origin = 'https://panel.bearwithme.pl'
  const actor = Object.freeze({
    id: 'stf_shell',
    role: 'owner',
    specialistId: null,
    version: 1,
  })

  const readPaths = [
    ['operations.health', '/api/v1/operations/health', 'getOperationalHealth'],
    ['operations.actions', '/api/v1/operations/actions', 'listOpenOperationalActions'],
    ['security.audit', '/api/v1/security/audit?limit=1', 'listSecurityAudit'],
  ]

  it.each(readPaths)('classifies %s and invokes only its selected service', async (routeId, path, serviceName) => {
    const service = vi.fn(async () => ({ data: { ok: true } }))
    const log = vi.fn()
    const input = deps({
      [serviceName]: service,
      now: () => 1_800_000_000_000,
      idFactory: () => 'generated_1',
      safeLog: log,
    })
    const response = await createApp(input).request(path, {
      headers: { 'x-correlation-id': correlationId },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { ok: true } })
    expect(service).toHaveBeenCalledOnce()
    expect(service.mock.calls[0][0]).toEqual(expect.objectContaining({
      actor,
      correlationId,
      nowMs: 1_800_000_000_000,
    }))
    expect(Object.keys(service.mock.calls[0][0]).sort()).toEqual(
      (serviceName === 'listSecurityAudit'
        ? ['actor', 'correlationId', 'cryptoContext', 'db', 'idFactory', 'nowMs', 'query']
        : ['actor', 'correlationId', 'cryptoContext', 'db', 'idFactory', 'nowMs']).sort()
    )
    if (serviceName === 'listSecurityAudit') {
      expect(service.mock.calls[0][0].query).toBeInstanceOf(URLSearchParams)
      expect(service.mock.calls[0][0].query.toString()).toBe('limit=1')
    }
    expect(log).toHaveBeenCalledWith('info', expect.objectContaining({ routeId }))
  })

  it('passes the canonical classified action ID and exact resolution service facts', async () => {
    const service = vi.fn(async () => ({ data: { action: { id: 'action_1' } } }))
    const input = deps({
      resolveOperationalAction: service,
      now: () => 1_800_000_000_000,
      idFactory: () => 'generated_1',
      verifyCsrfToken: vi.fn(async () => true),
    })
    const response = await createApp(input).request('/api/v1/operations/actions/action_1/resolution', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': 'resolve-key',
        'sec-fetch-site': 'same-origin',
        'x-correlation-id': correlationId,
        'x-csrf-token': 'csrf-token',
      },
      body: '{"version":1}',
    })

    expect(response.status).toBe(200)
    expect(service).toHaveBeenCalledWith({
      db: undefined,
      cryptoContext: input.cryptoContext,
      actor,
      nowMs: 1_800_000_000_000,
      correlationId,
      idFactory: input.idFactory,
      actionId: 'action_1',
      idempotencyKey: 'resolve-key',
      body: { version: 1 },
    })
  })

  it.each([
    ['POST', '/api/v1/operations/health', 'GET, HEAD, OPTIONS'],
    ['DELETE', '/api/v1/operations/actions', 'GET, HEAD, OPTIONS'],
    ['POST', '/api/v1/security/audit?limit=1', 'GET, HEAD, OPTIONS'],
    ['GET', '/api/v1/operations/actions/action_1/resolution', 'POST, OPTIONS'],
  ])('rejects %s %s with route-specific Allow before dependencies', async (method, path, allow) => {
    const input = deps({
      config: undefined,
      resolveAccessPrincipal: vi.fn(),
      resolveActor: vi.fn(),
      getOperationalHealth: vi.fn(),
      listOpenOperationalActions: vi.fn(),
      listSecurityAudit: vi.fn(),
      resolveOperationalAction: vi.fn(),
    })
    const response = await createApp(input).request(path, { method })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe(allow)
    expect(input.resolveAccessPrincipal).not.toHaveBeenCalled()
    expect(input.resolveActor).not.toHaveBeenCalled()
  })

  it.each([
    '/api/v1/operations/health?x=1',
    '/api/v1/operations/actions?x=1',
    '/api/v1/operations/actions/action_1/resolution?x=1',
    '/api/v1/operations/actions/%61ction_1/resolution',
    '/api/v1/operations/actions/action.1/resolution',
    '/api/v1/operations/actions/action_1%2Fextra/resolution',
    '/api/v1/operations/actions/action_1/resolution/',
  ])('keeps noncanonical operations variant %s unmatched', async (path) => {
    const service = vi.fn()
    const input = deps({
      getOperationalHealth: service,
      listOpenOperationalActions: service,
      resolveOperationalAction: service,
      listSecurityAudit: service,
    })
    const response = await createApp(input).request(path, {
      headers: { 'x-correlation-id': correlationId },
    })

    expect(response.status).toBe(404)
    expect(service).not.toHaveBeenCalled()
  })

  it.each([
    ['/api/v1/operations/health', 'GET, HEAD, OPTIONS'],
    ['/api/v1/operations/actions', 'GET, HEAD, OPTIONS'],
    ['/api/v1/security/audit?limit=1', 'GET, HEAD, OPTIONS'],
    ['/api/v1/operations/actions/action_1/resolution', 'POST, OPTIONS'],
  ])('authenticates OPTIONS %s without selecting a service, CSRF, or body', async (path, allow) => {
    const input = deps({
      getOperationalHealth: null,
      listOpenOperationalActions: null,
      resolveOperationalAction: null,
      listSecurityAudit: null,
      verifyCsrfToken: vi.fn(),
      readJsonBodyOnce: vi.fn(),
    })
    const response = await createApp(input).request(path, {
      method: 'OPTIONS',
      headers: { origin, 'x-correlation-id': correlationId },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('allow')).toBe(allow)
    expect(await response.text()).toBe('')
    expect(input.resolveAccessPrincipal).toHaveBeenCalledOnce()
    expect(input.resolveActor).toHaveBeenCalledOnce()
    expect(input.verifyCsrfToken).not.toHaveBeenCalled()
    expect(input.readJsonBodyOnce).not.toHaveBeenCalled()
  })

  it.each(readPaths)('runs authorized work for HEAD %s and strips only the body', async (_routeId, path, serviceName) => {
    const service = vi.fn(async () => ({ data: { secret: 'body-sentinel' } }))
    const response = await createApp(deps({ [serviceName]: service })).request(path, { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.text()).toBe('')
    expect(service).toHaveBeenCalledOnce()
  })

  it.each([
    undefined,
    '',
    'short',
    'has whitespace',
    'has:colon',
    'comma,key',
    `a${'x'.repeat(128)}`,
  ])('rejects resolution Idempotency-Key %j before Access or body consumption', async (idempotencyKey) => {
    const input = deps({
      resolveAccessPrincipal: vi.fn(),
      resolveActor: vi.fn(),
      verifyCsrfToken: vi.fn(),
      readJsonBodyOnce: vi.fn(),
      resolveOperationalAction: vi.fn(),
    })
    const headers = {
      origin,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    }
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey
    const response = await createApp(input).request('/api/v1/operations/actions/action_1/resolution', {
      method: 'POST', headers, body: '{}',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    expect(input.resolveAccessPrincipal).not.toHaveBeenCalled()
    expect(input.verifyCsrfToken).not.toHaveBeenCalled()
    expect(input.resolveActor).not.toHaveBeenCalled()
    expect(input.readJsonBodyOnce).not.toHaveBeenCalled()
    expect(input.resolveOperationalAction).not.toHaveBeenCalled()
  })

  it('orders Access, CSRF, actor resolution, duplicate-safe body parsing, then resolution service', async () => {
    const order = []
    const input = deps({
      resolveAccessPrincipal: vi.fn(async () => {
        order.push('access')
        return { kind: 'human', subject: 'access-shell', normalizedEmail: 'shell@example.test' }
      }),
      verifyCsrfToken: vi.fn(async () => { order.push('csrf') }),
      resolveActor: vi.fn(async () => { order.push('actor'); return actor }),
      readJsonBodyOnce: vi.fn(async (_request, options) => {
        order.push('body')
        expect(options).toEqual({ rejectDuplicateTopLevelKeys: true })
        return { version: 1 }
      }),
      resolveOperationalAction: vi.fn(async () => { order.push('service'); return { data: {} } }),
    })
    const response = await createApp(input).request('/api/v1/operations/actions/action_1/resolution', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': 'resolve-key',
        'sec-fetch-site': 'same-origin',
        'x-csrf-token': 'csrf-token',
      },
      body: '{"version":1}',
    })

    expect(response.status).toBe(200)
    expect(order).toEqual(['access', 'csrf', 'actor', 'body', 'service'])
  })

  it('rejects an actual duplicate version key before invoking the resolution service', async () => {
    const service = vi.fn(async () => ({ data: {} }))
    const input = deps({
      resolveOperationalAction: service,
      verifyCsrfToken: vi.fn(async () => true),
    })
    const response = await createApp(input).request('/api/v1/operations/actions/action_1/resolution', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': 'resolve-key',
        'sec-fetch-site': 'same-origin',
        'x-correlation-id': correlationId,
        'x-csrf-token': 'csrf-token',
      },
      body: '{"version":1,"version":2}',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', correlationId },
    })
    expect(service).not.toHaveBeenCalled()
  })

  it('validates the selected injected service after Access and CSRF but before actor resolution', async () => {
    const input = deps({
      resolveAccessPrincipal: vi.fn(async () => ({
        kind: 'human', subject: 'access-shell', normalizedEmail: 'shell@example.test',
      })),
      resolveActor: vi.fn(),
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(),
      resolveOperationalAction: 'not-a-function',
    })
    const response = await createApp(input).request('/api/v1/operations/actions/action_1/resolution', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': 'resolve-key',
        'sec-fetch-site': 'same-origin',
        'x-csrf-token': 'csrf-token',
      },
      body: '{"version":1}',
    })

    expect(response.status).toBe(500)
    expect(input.resolveAccessPrincipal).toHaveBeenCalledOnce()
    expect(input.verifyCsrfToken).toHaveBeenCalledOnce()
    expect(input.resolveActor).not.toHaveBeenCalled()
    expect(input.readJsonBodyOnce).not.toHaveBeenCalled()
  })

  it.each([
    'a2345678',
    'a._~-123',
    `a${'x'.repeat(127)}`,
  ])('accepts canonical resolution Idempotency-Key %s without changing staff semantics', async (idempotencyKey) => {
    const service = vi.fn(async () => ({ data: { action: { id: 'action_key' } } }))
    const input = deps({
      resolveOperationalAction: service,
      verifyCsrfToken: vi.fn(async () => true),
    })
    const response = await createApp(input).request('/api/v1/operations/actions/action_key/resolution', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'sec-fetch-site': 'same-origin',
        'x-csrf-token': 'csrf-token',
      },
      body: '{"version":1}',
    })
    expect(response.status).toBe(200)
    expect(service).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey }))
  })

  it('maps internal operation failures without leaking stored or thrown fields', async () => {
    const marker = 'parent@example.test private-envelope private-provider-body'
    const log = vi.fn()
    const failure = new Error(`OPERATIONS_STATE_INVALID ${marker}`)
    failure.cursor = marker
    failure.response = { body: marker }
    const input = deps({
      getOperationalHealth: vi.fn(async () => { throw failure }),
      safeLog: log,
    })
    const response = await createApp(input).request('/api/v1/operations/health', {
      headers: {
        'x-correlation-id': correlationId,
        'x-private-marker': marker,
      },
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', correlationId },
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker)
  })

  it('returns exact safe resolution validation and version-conflict details', async () => {
    const request = async (error) => {
      const input = deps({
        resolveOperationalAction: vi.fn(async () => { throw error }),
        verifyCsrfToken: vi.fn(async () => true),
      })
      return createApp(input).request('/api/v1/operations/actions/action_error/resolution', {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'idempotency-key': 'private-idempotency-key',
          'sec-fetch-site': 'same-origin',
          'x-correlation-id': correlationId,
          'x-csrf-token': 'private-csrf',
        },
        body: '{"version":1}',
      })
    }
    const invalid = new Error('VALIDATION_FAILED')
    invalid.details = { field: 'version', private: 'private-body' }
    const invalidResponse = await request(invalid)
    expect(invalidResponse.status).toBe(400)
    expect(await invalidResponse.json()).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        correlationId,
        details: { field: 'version' },
      },
    })

    const conflict = new Error('VERSION_CONFLICT')
    conflict.details = { currentVersion: 2, private: 'private-action' }
    const conflictResponse = await request(conflict)
    expect(conflictResponse.status).toBe(409)
    expect(await conflictResponse.json()).toEqual({
      error: {
        code: 'VERSION_CONFLICT',
        correlationId,
        details: { currentVersion: 2 },
      },
    })
  })

  it('keeps registered HEAD failures bodyless while preserving JSON and security headers', async () => {
    const marker = 'private-cursor-sentinel'
    const log = vi.fn()
    const input = deps({
      listSecurityAudit: vi.fn(async () => { throw new Error('VALIDATION_FAILED') }),
      safeLog: log,
    })
    const response = await createApp(input).request(`/api/v1/security/audit?cursor=${marker}`, {
      method: 'HEAD',
      headers: { 'x-correlation-id': correlationId },
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('')
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker)
  })

  it('never calls or passes provider, evaluator, scheduler, outbox, export, or R2 dependencies', async () => {
    const forbidden = vi.fn(() => { throw new Error('provider-private-marker') })
    const service = vi.fn(async (input) => {
      expect(Object.keys(input).sort()).toEqual([
        'actor', 'correlationId', 'cryptoContext', 'db', 'idFactory', 'nowMs',
      ])
      return { data: { generatedAt: 'safe' } }
    })
    const input = deps({
      evaluateStoredOperationalState: forbidden,
      exportDatabase: forbidden,
      getOperationalHealth: service,
      processOutboxBatch: forbidden,
      providers: forbidden,
      r2: forbidden,
      runScheduled: forbidden,
    })
    const response = await createApp(input).request('/api/v1/operations/health')
    expect(response.status).toBe(200)
    expect(service).toHaveBeenCalledOnce()
    expect(forbidden).not.toHaveBeenCalled()
  })
})

describe('safeLog', () => {
  it('keeps valid PII-free fields', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    safeLog('info', {
      actorId: 'staff_42',
      correlationId: '11111111-1111-4111-8111-111111111111',
      durationMs: 18,
      entityId: 'session_42',
      entityType: 'session',
      event: 'request.completed',
      jobId: 'job_42',
      result: 'success',
    })

    expect(output).toHaveBeenCalledWith(JSON.stringify({
      actorId: 'staff_42',
      correlationId: '11111111-1111-4111-8111-111111111111',
      durationMs: 18,
      entityId: 'session_42',
      entityType: 'session',
      event: 'request.completed',
      jobId: 'job_42',
      result: 'success',
    }))
  })

  it('drops emails, JWT-like values, provider objects, and bodies', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    const email = 'parent@example.test'
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InBhcmVudEBleGFtcGxlLnRlc3QifQ.signature'
    safeLog('error', {
      actorId: email,
      correlationId: 'invalid',
      durationMs: -1,
      entityId: jwt,
      entityType: { provider: 'access' },
      errorCode: 'INTERNAL_ERROR',
      event: 'request.failed',
      jobId: { body: email },
      result: ['failed'],
      body: email,
    })

    const line = output.mock.calls[0][0]
    expect(line).toBe(JSON.stringify({ errorCode: 'INTERNAL_ERROR', event: 'request.failed' }))
    expect(line).not.toContain(email)
    expect(line).not.toContain(jwt)
    expect(line).not.toContain('provider')
    expect(line).not.toContain('body')
  })

  it('does not log unknown levels', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    safeLog('log', { event: 'request.completed' })
    expect(output).not.toHaveBeenCalled()
  })

  it('keeps validated scheduler identity and counters', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    safeLog('info', {
      event: 'scheduler.completed',
      result: 'completed',
      runId: 'scheduler_run_42',
      attemptCount: 2,
      claimedJobs: 10,
      succeededJobs: 7,
      failedJobs: 3,
    })

    expect(output).toHaveBeenCalledWith(JSON.stringify({
      event: 'scheduler.completed',
      result: 'completed',
      runId: 'scheduler_run_42',
      attemptCount: 2,
      claimedJobs: 10,
      succeededJobs: 7,
      failedJobs: 3,
    }))
  })

  it.each([
    'staff.list',
    'staff.invitations',
    'staff.deactivation',
    'operations.health',
    'operations.actions',
    'operations.action-resolution',
    'security.audit',
  ])('keeps the accepted safe route id %s', (routeId) => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    safeLog('info', { event: 'request.completed', routeId })
    expect(output).toHaveBeenCalledWith(JSON.stringify({ event: 'request.completed', routeId }))
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['string', '1'],
    ['object', { count: 1 }],
    ['oversized job count', 11],
  ])('drops %s scheduler job counters', (_label, value) => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
    safeLog('warn', {
      event: 'scheduler.failed',
      result: 'failure',
      claimedJobs: value,
      succeededJobs: value,
      failedJobs: value,
    })

    expect(output).toHaveBeenCalledWith(JSON.stringify({
      event: 'scheduler.failed',
      result: 'failure',
    }))
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['string', '1'],
    ['object', { count: 1 }],
  ])('drops %s scheduler attempt counts', (_label, attemptCount) => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
    safeLog('warn', {
      event: 'scheduler.failed',
      result: 'failure',
      attemptCount,
    })

    expect(output).toHaveBeenCalledWith(JSON.stringify({
      event: 'scheduler.failed',
      result: 'failure',
    }))
  })
})
