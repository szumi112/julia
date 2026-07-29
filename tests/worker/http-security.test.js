import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import { AppError, apiError, publicError } from '../../worker/http/errors.js'
import { parseCanonicalContentLength, readJsonBodyOnce } from '../../worker/http/security.js'

const correlationId = '11111111-1111-4111-8111-111111111111'
const config = {
  appEnv: 'staging',
  appOrigin: 'https://panel.bearwithme.pl',
  dataMode: 'fictional',
  accessHealthServiceTokenId: 'health-service',
}
const principal = { kind: 'human', subject: 'access-owner', normalizedEmail: 'owner@example.test' }
const actor = { id: 'stf_owner', role: 'owner', specialistId: 'sp_owner', version: 3 }

const appDeps = (overrides = {}) => ({
  config,
  now: () => 1_800_000_000_000,
  safeLog: vi.fn(),
  resolveAccessPrincipal: vi.fn(async (_request, { expected }) => (
    expected === 'service'
      ? { kind: 'service', serviceName: 'health-service' }
      : principal
  )),
  resolveActor: vi.fn(async () => actor),
  verifyCsrfToken: vi.fn(async () => true),
  cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
  session: vi.fn(async () => ({ data: { ok: true } })),
  ...overrides,
})

describe('HTTP security primitives', () => {
  it.each([
    [undefined, null],
    [null, null],
    ['0', 0],
    ['1', 1],
    ['65536', 65_536],
  ])('accepts canonical content length %s', (value, expected) => {
    expect(parseCanonicalContentLength(value)).toBe(expected)
  })

  it.each(['', '00', '01', '+1', '-1', ' 1', '1 ', '1.0', '1,2', '1x', '9007199254740992'])(
    'rejects noncanonical content length %s',
    (value) => expect(() => parseCanonicalContentLength(value)).toThrow(/^INVALID_CONTENT_LENGTH$/)
  )

  it('rejects a canonical declared body above the limit before consumption', () => {
    expect(() => parseCanonicalContentLength('65537')).toThrow(/^PAYLOAD_TOO_LARGE$/)
  })

  it('reads valid JSON once and enforces encoded bytes', async () => {
    const exact = `"${'x'.repeat(65_534)}"`
    await expect(readJsonBodyOnce(new Request('https://example.test', {
      method: 'POST',
      body: exact,
    }))).resolves.toBe(exact.slice(1, -1))

    const oversized = new Request('https://example.test', {
      method: 'POST',
      body: `"${'x'.repeat(65_535)}"`,
    })
    await expect(readJsonBodyOnce(oversized)).rejects.toThrow(/^PAYLOAD_TOO_LARGE$/)
    expect(oversized.bodyUsed).toBe(true)
  })

  it('maps malformed UTF-8 and JSON to one stable parser error', async () => {
    for (const body of [new Uint8Array([0xff]), new TextEncoder().encode('{')]) {
      await expect(readJsonBodyOnce(new Request('https://example.test', {
        method: 'POST',
        body,
      }))).rejects.toThrow(/^INVALID_JSON$/)
    }
  })
})

describe('hardened API lifecycle', () => {
  it('rejects unsupported methods before Access or identity', async () => {
    const deps = appDeps()
    const response = await createApp(deps).request('/api/v1/session', {
      method: 'TRACE',
      headers: { 'x-correlation-id': correlationId },
    })
    expect(response.status).toBe(405)
    expect(deps.resolveAccessPrincipal).not.toHaveBeenCalled()
    expect(deps.resolveActor).not.toHaveBeenCalled()
  })

  it('rejects cheap mutation checks before Access and CSRF before actor resolution', async () => {
    const badOrigin = appDeps()
    const first = await createApp(badOrigin).request('/api/v1/session', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(first.status).toBe(403)
    expect(badOrigin.resolveAccessPrincipal).not.toHaveBeenCalled()

    const badCsrf = appDeps({ verifyCsrfToken: vi.fn(async () => { throw new Error('CSRF_INVALID') }) })
    const second = await createApp(badCsrf).request('/api/v1/session', {
      method: 'POST',
      headers: {
        origin: config.appOrigin,
        'content-type': 'application/json',
        'x-csrf-token': 'bad',
      },
      body: '{}',
    })
    expect(second.status).toBe(403)
    expect(badCsrf.resolveAccessPrincipal).toHaveBeenCalledOnce()
    expect(badCsrf.resolveActor).not.toHaveBeenCalled()
  })

  it('keeps exact liveness service-only and DB-free', async () => {
    const deps = appDeps({
      resolveActor: vi.fn(async () => { throw new Error('DB_TRAP') }),
    })
    const response = await createApp(deps).request('/api/v1/health/live', {
      headers: { 'x-correlation-id': correlationId },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { status: 'ok' } })
    expect(deps.resolveAccessPrincipal).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ expected: 'service' }))
    expect(deps.resolveActor).not.toHaveBeenCalled()
  })

  it('authenticates unknown v1 routes as human and emits no CORS permission headers', async () => {
    const deps = appDeps()
    const response = await createApp(deps).request('/api/v1/missing?marker=parent@example.test', {
      headers: { 'x-correlation-id': correlationId },
    })
    expect(response.status).toBe(404)
    expect(deps.resolveAccessPrincipal).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ expected: 'human' }))
    expect(deps.resolveActor).toHaveBeenCalledOnce()
    for (const header of [
      'access-control-allow-origin', 'access-control-allow-credentials',
      'access-control-allow-methods', 'access-control-allow-headers',
      'access-control-max-age', 'access-control-expose-headers',
    ]) expect(response.headers.has(header)).toBe(false)
  })

  it('adds fixed security headers and one sanitized completion log', async () => {
    const deps = appDeps()
    const response = await createApp(deps).request('/api/v1/session', {
      headers: { 'x-correlation-id': correlationId },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-correlation-id')).toBe(correlationId)
    expect(deps.safeLog).toHaveBeenCalledOnce()
    expect(JSON.stringify(deps.safeLog.mock.calls)).not.toContain('owner@example.test')
  })

  it('orders Access, CSRF, actor, one body parse, and route context', async () => {
    const order = []
    const deps = appDeps({
      resolveAccessPrincipal: vi.fn(async () => {
        order.push('principal')
        return principal
      }),
      verifyCsrfToken: vi.fn(async () => { order.push('csrf') }),
      resolveActor: vi.fn(async () => {
        order.push('actor')
        return actor
      }),
      readJsonBodyOnce: vi.fn(async (request) => {
        order.push('body')
        return JSON.parse(await request.text())
      }),
    })
    const app = createApp(deps)
    app.post('/api/v1/test-mutation', (c) => {
      order.push('route')
      return c.json({ data: c.get('jsonBody') })
    })
    const response = await app.request('/api/v1/test-mutation', {
      method: 'POST',
      headers: {
        origin: config.appOrigin,
        'content-type': 'application/json',
        'x-csrf-token': 'valid',
      },
      body: '{"value":1}',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { value: 1 } })
    expect(order).toEqual(['principal', 'csrf', 'actor', 'body', 'route'])
    expect(deps.readJsonBodyOnce).toHaveBeenCalledOnce()
  })

  it('serves only authenticated human OPTIONS for registered human routes', async () => {
    const deps = appDeps()
    const response = await createApp(deps).request('/api/v1/session', {
      method: 'OPTIONS',
      headers: { origin: config.appOrigin },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    expect(deps.verifyCsrfToken).not.toHaveBeenCalled()
    expect(deps.resolveActor).toHaveBeenCalledOnce()
  })
})

describe('closed public error map', () => {
  it.each([
    ['INVALID_CONTENT_LENGTH', 400],
    ['INVALID_JSON', 400],
    ['ACCESS_ASSERTION_INVALID', 401],
    ['ACCESS_DENIED', 403],
    ['FORBIDDEN', 403],
    ['ORIGIN_INVALID', 403],
    ['FETCH_METADATA_INVALID', 403],
    ['CSRF_INVALID', 403],
    ['CSRF_EXPIRED', 403],
    ['NOT_FOUND', 404],
    ['METHOD_NOT_ALLOWED', 405],
    ['IDEMPOTENCY_CONFLICT', 409],
    ['VERSION_CONFLICT', 409],
    ['PAYLOAD_TOO_LARGE', 413],
    ['UNSUPPORTED_MEDIA_TYPE', 415],
    ['RATE_LIMITED', 429],
    ['ACCESS_KEYSET_UNAVAILABLE', 503],
    ['INTERNAL_ERROR', 500],
  ])('maps %s to %i without caller status control', async (code, status) => {
    const correlation = '22222222-2222-4222-8222-222222222222'
    const response = apiError(new AppError(code, { status: 418 }), correlation)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: { code, correlationId: correlation } })
  })

  it('maps forged errors and sensitive markers to a generic internal error', async () => {
    const error = new Error('SELECT email FROM staff_users parent@example.test')
    error.code = 'ACCESS_DENIED'
    error.status = 403
    error.details = { email: 'parent@example.test' }
    error.stack = 'jwt-claim-marker'
    const mapped = publicError(error)
    const response = apiError(mapped, correlationId)
    const serialized = JSON.stringify(await response.json())
    expect(response.status).toBe(500)
    expect(serialized).toContain('INTERNAL_ERROR')
    for (const marker of ['SELECT', 'parent@example.test', 'jwt-claim-marker']) {
      expect(serialized).not.toContain(marker)
    }
  })
})
