import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import { AppError, apiError, publicError } from '../../worker/http/errors.js'
import {
  hasDuplicateTopLevelJsonKey,
  parseCanonicalContentLength,
  readJsonBodyOnce,
} from '../../worker/http/security.js'

const correlationId = '11111111-1111-4111-8111-111111111111'
const config = {
  appEnv: 'staging',
  appOrigin: 'https://panel.bearwithme.pl',
  dataMode: 'fictional',
  accessHealthServiceTokenId: 'health-service',
}
const principal = { kind: 'human', subject: 'access-owner', normalizedEmail: 'owner@example.test' }
const actor = { id: 'stf_owner', role: 'owner', specialistId: 'sp_owner', version: 3 }
const publicErrors = [
  ['INVALID_CONTENT_LENGTH', 400],
  ['INVALID_JSON', 400],
  ['VALIDATION_FAILED', 400],
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
  ['LAST_ACTIVE_OWNER', 409],
  ['STAFF_INVITATION_CONFLICT', 409],
  ['VERSION_CONFLICT', 409],
  ['PAYLOAD_TOO_LARGE', 413],
  ['UNSUPPORTED_MEDIA_TYPE', 415],
  ['RATE_LIMITED', 429],
  ['ACCESS_KEYSET_UNAVAILABLE', 503],
  ['INTERNAL_ERROR', 500],
]

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

const mutationApp = (deps) => {
  const app = createApp(deps)
  app.post('/api/v1/test-mutation', (c) => c.json({ data: c.get('jsonBody') }))
  return app
}

const noCors = (response) => {
  for (const header of [
    'access-control-allow-origin', 'access-control-allow-credentials',
    'access-control-allow-methods', 'access-control-allow-headers',
    'access-control-max-age', 'access-control-expose-headers',
  ]) expect(response.headers.has(header)).toBe(false)
}

const hasSecurityHeaders = (response) => {
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/)
  noCors(response)
}

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
    for (const body of [
      new Uint8Array(),
      new Uint8Array([0xff]),
      new TextEncoder().encode('{'),
    ]) {
      await expect(readJsonBodyOnce(new Request('https://example.test', {
        method: 'POST',
        body,
      }))).rejects.toThrow(/^INVALID_JSON$/)
    }
  })

  it.each([
    ['{"role":"owner","role":"specialist"}', true],
    ['{"role":"owner","\\u0072ole":"specialist"}', true],
    ['{"value":{"role":"owner","role":"specialist"},"text":"role,}"}', false],
    ['[{"role":"owner"},{"role":"specialist"}]', false],
  ])('detects semantic duplicate top-level keys in %s', (text, expected) => {
    expect(hasDuplicateTopLevelJsonKey(text)).toBe(expected)
  })

  it('rejects duplicate top-level keys only when the route requests strict JSON objects', async () => {
    const raw = '{"role":"owner","\\u0072ole":"specialist"}'
    await expect(readJsonBodyOnce(new Request('https://example.test', {
      method: 'POST',
      body: raw,
    }), { rejectDuplicateTopLevelKeys: true })).rejects.toThrow(/^VALIDATION_FAILED$/)
    await expect(readJsonBodyOnce(new Request('https://example.test', {
      method: 'POST',
      body: raw,
    }))).resolves.toEqual({ role: 'specialist' })
  })

  it('counts multibyte UTF-8 bytes at the exact boundary', async () => {
    const exact = `"${'\u0800'.repeat(21_844)}xy"`
    expect(new TextEncoder().encode(exact)).toHaveLength(65_536)
    await expect(readJsonBodyOnce(new Request('https://example.test', {
      method: 'POST',
      body: exact,
    }))).resolves.toBe(`${'\u0800'.repeat(21_844)}xy`)
    const over = `"${'\u0800'.repeat(21_845)}"`
    expect(new TextEncoder().encode(over).byteLength).toBeGreaterThan(65_536)
    await expect(readJsonBodyOnce(new Request('https://example.test', {
      method: 'POST',
      body: over,
    }))).rejects.toThrow(/^PAYLOAD_TOO_LARGE$/)
  })

  it('cancels a no-length multi-chunk stream on overflow and consumes it', async () => {
    let cancelled = false
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000).fill(0x20))
        controller.enqueue(new Uint8Array(30_000).fill(0x20))
      },
      cancel() { cancelled = true },
    })
    const request = new Request('https://example.test', { method: 'POST', body: stream })
    await expect(readJsonBodyOnce(request)).rejects.toThrow(/^PAYLOAD_TOO_LARGE$/)
    expect(cancelled).toBe(true)
    expect(request.bodyUsed).toBe(true)
  })
})

describe('hardened API lifecycle', () => {
  it.each(['TRACE', 'PROPFIND'])(
    'rejects unsupported method %s before Access or identity',
    async (method) => {
      const deps = appDeps()
      const response = await createApp(deps).request('/api/v1/session', {
        method,
        headers: { 'x-correlation-id': correlationId },
      })
      expect(response.status).toBe(405)
      expect(deps.resolveAccessPrincipal).not.toHaveBeenCalled()
      expect(deps.resolveActor).not.toHaveBeenCalled()
    }
  )

  it('rejects cheap mutation checks before Access and CSRF before actor resolution', async () => {
    const badOrigin = appDeps()
    const first = await mutationApp(badOrigin).request('/api/v1/test-mutation', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(first.status).toBe(403)
    expect(badOrigin.resolveAccessPrincipal).not.toHaveBeenCalled()

    const badCsrf = appDeps({ verifyCsrfToken: vi.fn(async () => { throw new Error('CSRF_INVALID') }) })
    const second = await mutationApp(badCsrf).request('/api/v1/test-mutation', {
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

  it.each([
    '/api/v1/health/live?x=parent@example.test',
    '/api/v1/%68ealth/live',
    '/api/v1/health%2Flive',
  ])('treats health-like raw variant %s as an authenticated human unknown route', async (path) => {
    const serviceDeps = appDeps({
      resolveAccessPrincipal: vi.fn(async (_request, options) => {
        expect(options.expected).toBe('human')
        return { kind: 'service', serviceName: 'health-service' }
      }),
    })
    const rejected = await createApp(serviceDeps).request(path)
    expect(rejected.status).toBe(401)
    expect(serviceDeps.resolveAccessPrincipal).toHaveBeenCalledOnce()
    expect(serviceDeps.resolveActor).not.toHaveBeenCalled()

    const humanDeps = appDeps()
    const response = await createApp(humanDeps).request(path)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect(humanDeps.resolveAccessPrincipal).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ expected: 'human' }),
    )
    expect(humanDeps.resolveActor).toHaveBeenCalledOnce()
  })

  it('uses only the service verifier for exact health HEAD and strips its body', async () => {
    const deps = appDeps({
      resolveActor: vi.fn(async () => { throw new Error('DB_TRAP') }),
      createKeyring: vi.fn(async () => { throw new Error('KEYRING_TRAP') }),
    })
    const response = await createApp(deps).request('/api/v1/health/live', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(deps.resolveAccessPrincipal).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ expected: 'service' }),
    )
    expect(deps.resolveActor).not.toHaveBeenCalled()
    expect(deps.createKeyring).not.toHaveBeenCalled()
  })

  it('rejects human/service principal confusion before D1 on both route kinds', async () => {
    const humanOnHealth = appDeps({
      resolveAccessPrincipal: vi.fn(async () => principal),
    })
    const health = await createApp(humanOnHealth).request('/api/v1/health/live')
    expect(health.status).toBe(401)
    expect(humanOnHealth.resolveActor).not.toHaveBeenCalled()

    const serviceOnSession = appDeps({
      resolveAccessPrincipal: vi.fn(async () => ({
        kind: 'service',
        serviceName: 'health-service',
      })),
    })
    const session = await createApp(serviceOnSession).request('/api/v1/session')
    expect(session.status).toBe(401)
    expect(serviceOnSession.resolveActor).not.toHaveBeenCalled()
  })

  it.each([
    ['registered human OPTIONS', '/api/v1/session', { method: 'OPTIONS', headers: { origin: config.appOrigin } }],
    ['unknown v1 route', '/api/v1/unknown', {}],
    ['allowed mutation', '/api/v1/test-mutation', {
      method: 'POST',
      headers: {
        origin: config.appOrigin,
        'content-type': 'application/json',
        'x-csrf-token': 'valid',
      },
      body: '{}',
    }],
  ])('rejects a service principal on %s before actor resolution', async (_label, path, init) => {
    const deps = appDeps({
      resolveAccessPrincipal: vi.fn(async (_request, options) => {
        expect(options.expected).toBe('human')
        return { kind: 'service', serviceName: 'health-service' }
      }),
    })
    const app = path === '/api/v1/test-mutation' ? mutationApp(deps) : createApp(deps)
    const response = await app.request(path, init)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'ACCESS_ASSERTION_INVALID' } })
    expect(deps.resolveAccessPrincipal).toHaveBeenCalledOnce()
    expect(deps.verifyCsrfToken).not.toHaveBeenCalled()
    expect(deps.resolveActor).not.toHaveBeenCalled()
  })

  it('rejects endpoint-disallowed session mutations before all dependencies', async () => {
    const deps = appDeps()
    const response = await createApp(deps).request('/api/v1/session', {
      method: 'POST',
      headers: {
        origin: config.appOrigin,
        'content-type': 'application/json',
        'x-csrf-token': 'valid',
      },
      body: '{}',
    })
    expect(response.status).toBe(405)
    expect(deps.resolveAccessPrincipal).not.toHaveBeenCalled()
    expect(deps.verifyCsrfToken).not.toHaveBeenCalled()
    expect(deps.resolveActor).not.toHaveBeenCalled()
    expect(deps.session).not.toHaveBeenCalled()
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

  it('maps a body-stream read failure to sanitized INVALID_JSON after consuming the raw body', async () => {
    const marker = 'body-stream-parent@example.test'
    const route = vi.fn()
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(new Error(marker))
      },
    })
    const request = new Request(`${config.appOrigin}/api/v1/test-mutation?query=${marker}`, {
      method: 'POST',
      headers: {
        origin: config.appOrigin,
        'content-type': 'application/json',
        'x-csrf-token': 'valid',
        'x-sensitive-marker': marker,
      },
      body: stream,
    })
    const deps = appDeps()
    const app = createApp(deps)
    app.post('/api/v1/test-mutation', route)
    const response = await app.request(request)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_JSON', correlationId: response.headers.get('x-correlation-id') },
    })
    expect(request.bodyUsed).toBe(true)
    expect(route).not.toHaveBeenCalled()
    expect(deps.resolveActor).toHaveBeenCalledOnce()
    expect(deps.safeLog).toHaveBeenCalledOnce()
    expect(JSON.stringify(deps.safeLog.mock.calls)).not.toContain(marker)
    hasSecurityHeaders(response)
  })

  it('gives a mutation route only parsed jsonBody after final raw-stream consumption', async () => {
    const deps = appDeps()
    const app = createApp(deps)
    app.post('/api/v1/test-mutation', async (c) => {
      expect(c.req.raw.bodyUsed).toBe(true)
      await expect(c.req.raw.text()).rejects.toThrow()
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
  })

  it.each([
    [{}, 'ORIGIN_INVALID'],
    [{ origin: `${config.appOrigin}/` }, 'ORIGIN_INVALID'],
    [{ origin: config.appOrigin, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }, 'FETCH_METADATA_INVALID'],
    [{ origin: config.appOrigin, 'sec-fetch-site': 'none', 'content-type': 'application/json' }, 'FETCH_METADATA_INVALID'],
    [{ origin: config.appOrigin, 'content-type': 'application/problem+json' }, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ origin: config.appOrigin, 'content-type': 'application/json; charset=utf-8; charset=utf-8' }, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ origin: config.appOrigin, 'content-type': 'application/json; profile=x' }, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ origin: config.appOrigin, 'content-type': 'application/json', 'content-encoding': 'gzip' }, 'UNSUPPORTED_MEDIA_TYPE'],
  ])('rejects malformed mutation metadata before Access: %j', async (headers, code) => {
    const deps = appDeps()
    const response = await mutationApp(deps).request('/api/v1/test-mutation', {
      method: 'POST',
      headers,
      body: '{}',
    })
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(deps.resolveAccessPrincipal).not.toHaveBeenCalled()
    expect(deps.resolveActor).not.toHaveBeenCalled()
    hasSecurityHeaders(response)
  })

  it('rejects declared oversize before pulling the body and actual oversize despite a small declaration', async () => {
    const readBody = vi.fn(async () => { throw new Error('BODY_READ_TRAP') })
    const declared = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{}'))
        controller.close()
      },
    })
    const deps = appDeps({ readJsonBodyOnce: readBody })
    const early = await mutationApp(deps).request(new Request(
      `${config.appOrigin}/api/v1/test-mutation`,
      {
        method: 'POST',
        headers: {
          origin: config.appOrigin,
          'content-type': 'application/json',
          'content-length': '65537',
          'x-csrf-token': 'valid',
        },
        body: declared,
      }
    ))
    expect(early.status).toBe(413)
    expect(readBody).not.toHaveBeenCalled()

    const actual = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537).fill(0x20))
        controller.close()
      },
    })
    const late = await mutationApp(appDeps()).request(new Request(
      `${config.appOrigin}/api/v1/test-mutation`,
      {
        method: 'POST',
        headers: {
          origin: config.appOrigin,
          'content-type': 'application/json',
          'content-length': '10',
          'x-csrf-token': 'valid',
        },
        body: actual,
      }
    ))
    expect(late.status).toBe(413)
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

  it('rejects health OPTIONS before Access and authenticates unknown OPTIONS before 404', async () => {
    const healthDeps = appDeps()
    const health = await createApp(healthDeps).request('/api/v1/health/live', {
      method: 'OPTIONS',
    })
    expect(health.status).toBe(405)
    expect(healthDeps.resolveAccessPrincipal).not.toHaveBeenCalled()

    const unknownDeps = appDeps()
    const unknown = await createApp(unknownDeps).request('/api/v1/unknown', {
      method: 'OPTIONS',
      headers: { origin: config.appOrigin },
    })
    expect(unknown.status).toBe(404)
    expect(unknownDeps.resolveAccessPrincipal).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ expected: 'human' }),
    )
    expect(unknownDeps.resolveActor).toHaveBeenCalledOnce()
  })

  it('keeps fixed headers, no CORS, and one sanitized log across response classes', async () => {
    const cases = [
      async () => {
        const deps = appDeps()
        return { deps, response: await createApp(deps).request('/api/v1/health/live') }
      },
      async () => {
        const deps = appDeps()
        return { deps, response: await createApp(deps).request('/api/v1/session') }
      },
      async () => {
        const deps = appDeps()
        return { deps, response: await createApp(deps).request('/api/v1/session', { method: 'OPTIONS' }) }
      },
      async () => {
        const deps = appDeps()
        return { deps, response: await createApp(deps).request('/api/v1/missing?email=parent@example.test') }
      },
      async () => {
        const deps = appDeps()
        return {
          deps,
          response: await mutationApp(deps).request('/api/v1/test-mutation', {
            method: 'POST',
            headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
            body: '{"email":"parent@example.test"}',
          }),
        }
      },
    ]
    for (const run of cases) {
      const { deps, response } = await run()
      hasSecurityHeaders(response)
      expect(deps.safeLog).toHaveBeenCalledOnce()
      expect(JSON.stringify(deps.safeLog.mock.calls)).not.toContain('parent@example.test')
    }
  })

  it.each(publicErrors)(
    'maps %s through the real app lifecycle with a safe envelope, headers, and log',
    async (code, status) => {
      const marker = `sensitive-${code}-parent@example.test`
      const deps = appDeps()
      const app = createApp(deps)
      app.post('/api/v1/test-error', () => {
        const error = new AppError(code, { field: 'email' })
        error.cause = new Error(marker)
        error.stack = marker
        error.secret = marker
        throw error
      })
      const response = await app.request(`/api/v1/test-error?query=${encodeURIComponent(marker)}`, {
        method: 'POST',
        headers: {
          origin: config.appOrigin,
          'content-type': 'application/json',
          'x-correlation-id': correlationId,
          'x-csrf-token': 'valid',
          'x-sensitive-marker': marker,
        },
        body: JSON.stringify({ marker }),
      })
      expect(response.status).toBe(status)
      const body = await response.json()
      expect(body).toEqual({
        error: {
          code,
          correlationId,
          details: { field: 'email' },
        },
      })
      hasSecurityHeaders(response)
      expect(deps.safeLog).toHaveBeenCalledOnce()
      expect(deps.safeLog).toHaveBeenCalledWith(
        status >= 500 ? 'error' : 'warn',
        expect.objectContaining({
          correlationId,
          errorCode: code,
          event: 'request.failed',
          result: 'failure',
          routeId: 'unmatched',
          status,
        }),
      )
      const serialized = JSON.stringify({
        body,
        headers: Object.fromEntries(response.headers),
        logs: deps.safeLog.mock.calls,
      })
      expect(serialized).not.toContain(marker)
    },
  )
})

describe('closed public error map', () => {
  it.each(publicErrors)('maps %s to %i without caller status control', async (code, status) => {
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

  it('does not expose specialistId as a generic validation field', async () => {
    const response = apiError(
      new AppError('VALIDATION_FAILED', { field: 'specialistId' }),
      correlationId,
    )
    expect(await response.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', correlationId },
    })
  })
})
