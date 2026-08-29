import { describe, expect, it, vi } from 'vitest'
import { reconcileAccessGroup } from '../../worker/providers/cloudflare-access.js'

const ACCOUNT_ID = 'a'.repeat(32)
const GROUP_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_NAME = 'Bear with me Staff'
const URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/groups/${GROUP_ID}`
const TOKEN = 'access-provider-secret'

const group = (overrides = {}) => ({
  id: GROUP_ID,
  name: GROUP_NAME,
  include: [],
  require: [{ email_domain: { domain: 'example.test' } }],
  exclude: [{ email: { email: 'blocked@example.test' } }],
  ...overrides,
})

const ok = (result, overrides = {}) => ({
  ok: true,
  redirected: false,
  status: 200,
  url: URL,
  json: async () => ({ success: true, result }),
  ...overrides,
})

const responseAtEndpoint = (body) => {
  const response = new Response(body)
  Object.defineProperty(response, 'url', { value: URL })
  return response
}

const input = (fetch, overrides = {}) => ({
  appEnv: 'staging',
  fetch,
  token: TOKEN,
  accountId: ACCOUNT_ID,
  groupId: GROUP_ID,
  groupName: GROUP_NAME,
  emails: ['zoe@example.test', 'anna@example.test', 'anna@example.test'],
  timeoutMs: 15_000,
  ...overrides,
})

const rejectingCancel = (reason) => {
  let handled = false
  const unhandled = []
  const cancel = vi.fn(() => {
    setTimeout(() => {
      if (!handled) unhandled.push(reason)
    }, 0)
    return {
      then(_resolve, reject) {
        handled = true
        reject(reason)
      },
    }
  })
  return {
    cancel,
    handled: () => handled,
    unhandled,
  }
}

describe('Cloudflare Access provider', () => {
  it('accepts only the exact protected staging role alias', async () => {
    const desired = [{ email: { email: 'kontakt@bearwithme.pl' } }]
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok(group({ include: desired })))
      .mockResolvedValueOnce(ok(group({ include: desired })))
      .mockResolvedValueOnce(ok(group({ include: desired })))

    await expect(reconcileAccessGroup(input(fetch, {
      emails: ['kontakt@bearwithme.pl'],
    }))).resolves.toEqual({ reconciled: true })
  })

  it('uses a non-deliverable sentinel when the desired production group is empty', async () => {
    const sentinel = [{ email: { email: 'disabled@example.test' } }]
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok(group({ include: sentinel })))
      .mockResolvedValueOnce(ok(group({ include: sentinel })))
      .mockResolvedValueOnce(ok(group({ include: sentinel })))

    await expect(reconcileAccessGroup(input(fetch, {
      appEnv: 'production',
      emails: [],
    }))).resolves.toEqual({ reconciled: true })
    expect(JSON.parse(fetch.mock.calls[1][1].body).include).toEqual(sentinel)
  })

  it('uses exact GET/PUT/GET requests with a Workers-compatible manual redirect policy', async () => {
    const desired = [
      { email: { email: 'anna@example.test' } },
      { email: { email: 'zoe@example.test' } },
    ]
    const current = group({ ignored: 'must-not-be-passed-through' })
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok(current))
      .mockResolvedValueOnce(ok(group({ include: desired })))
      .mockResolvedValueOnce(ok(group({ include: desired })))

    await expect(reconcileAccessGroup(input(fetch))).resolves.toEqual({
      reconciled: true,
    })

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [URL, 'GET'],
      [URL, 'PUT'],
      [URL, 'GET'],
    ])
    for (const [, init] of fetch.mock.calls) {
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
      expect(init.redirect).toBe('manual')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
    expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(fetch.mock.calls[2][1].headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(fetch.mock.calls[1][1].headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    })
    expect(fetch.mock.calls[1][1].body).toBe(JSON.stringify({
      name: GROUP_NAME,
      include: desired,
      require: [{ email_domain: { domain: 'example.test' } }],
      exclude: [{ email: { email: 'blocked@example.test' } }],
    }))
  })

  it.each([
    ['initial GET with a wrong URL', 0, 'wrong URL'],
    ['initial GET marked redirected', 0, 'redirected'],
    ['PUT with a wrong URL', 1, 'wrong URL'],
    ['PUT marked redirected', 1, 'redirected'],
    ['final GET with a wrong URL', 2, 'wrong URL'],
    ['final GET marked redirected', 2, 'redirected'],
  ])('rejects response provenance for %s', async (_case, stageIndex, failureKind) => {
    const desired = [
      { email: { email: 'anna@example.test' } },
      { email: { email: 'zoe@example.test' } },
    ]
    const hostileJson = vi.fn(async () => ({
      success: true,
      result: group({ include: stageIndex === 0 ? [] : desired }),
    }))
    const responses = [
      ok(group()),
      ok(group({ include: desired })),
      ok(group({ include: desired })),
    ]
    responses[stageIndex] = {
      ok: true,
      redirected: failureKind === 'redirected',
      status: 200,
      url: failureKind === 'wrong URL'
        ? `https://redirect.invalid/${TOKEN}/anna@example.test`
        : URL,
      json: hostileJson,
    }
    const fetch = vi.fn()
    for (const response of responses) fetch.mockResolvedValueOnce(response)

    let error
    try {
      await reconcileAccessGroup(input(fetch))
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      message: 'ACCESS_PROVIDER_RESPONSE_INVALID',
      retryable: false,
    })
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain('anna@example.test')
    expect(fetch).toHaveBeenCalledTimes(stageIndex + 1)
    expect(hostileJson).not.toHaveBeenCalled()
  })

  it('produces byte-identical PUT bodies for the same logical set', async () => {
    const bodies = []
    for (const emails of [
      ['zoe@example.test', 'anna@example.test'],
      ['anna@example.test', 'zoe@example.test', 'anna@example.test'],
    ]) {
      const desired = emails.toSorted().filter((email, index, values) => email !== values[index - 1])
        .map((email) => ({ email: { email } }))
      let call = 0
      const fetch = vi.fn(async (_url, init) => {
        call += 1
        if (init.method === 'PUT') {
          bodies.push(init.body)
          return ok(group({ include: desired }))
        }
        return ok(group({ include: call === 3 ? desired : [] }))
      })
      await reconcileAccessGroup(input(fetch, { emails }))
    }
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toBe(bodies[1])
  })

  it('deeply validates and clones require/exclude without retaining mutable aliases', async () => {
    const current = group()
    const desired = [
      { email: { email: 'anna@example.test' } },
      { email: { email: 'zoe@example.test' } },
    ]
    let putBody
    const fetch = vi.fn(async (_url, init) => {
      if (init.method === 'PUT') {
        putBody = init.body
        current.require[0].email_domain.domain = 'mutated.example'
        current.exclude.push({ email: { email: 'other@example.test' } })
        return ok(group({ include: desired }))
      }
      return ok(init.method === 'GET' && putBody ? group({ include: desired }) : current)
    })

    await reconcileAccessGroup(input(fetch))

    expect(JSON.parse(putBody)).toMatchObject({
      require: [{ email_domain: { domain: 'example.test' } }],
      exclude: [{ email: { email: 'blocked@example.test' } }],
    })
  })

  it.each([
    ['an include rule with another key', group({ include: [{ email: { email: 'old@example.test' }, everyone: {} }] })],
    ['a nested include value with another key', group({ include: [{ email: { email: 'old@example.test', extra: true } }] })],
    ['a non-email include rule', group({ include: [{ everyone: {} }] })],
    ['a null preserved rule', group({ require: [null] })],
    ['a numeric preserved rule', group({ exclude: [42] })],
    ['an empty preserved rule', group({ require: [{}] })],
    ['a response object with a prototype', Object.assign(Object.create({ inherited: true }), { success: true, result: group() })],
    ['an accessor anywhere in preserved rules', {
      success: true,
      result: group({
        require: [Object.defineProperty({}, 'email_domain', {
          enumerable: true,
          get: () => ({ domain: 'example.test' }),
        })],
      }),
    }],
    ['a prototype-polluting preserved-rule key', {
      success: true,
      result: group({
        require: [Object.defineProperty(
          { email_domain: { domain: 'example.test' } },
          '__proto__',
          {
            enumerable: true,
            value: { polluted: true },
          },
        )],
      }),
    }],
  ])('rejects %s before PUT', async (_label, responseBody) => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      redirected: false,
      status: 200,
      url: URL,
      json: async () => responseBody,
    })
    await expect(reconcileAccessGroup(input(fetch))).rejects.toMatchObject({
      message: 'ACCESS_PROVIDER_RESPONSE_INVALID',
      retryable: false,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['configured ID drift', group({ id: '22222222-2222-4222-8222-222222222222' }), 'ACCESS_PROVIDER_GROUP_DRIFT'],
    ['configured name drift', group({ name: 'Different Staff' }), 'ACCESS_PROVIDER_GROUP_DRIFT'],
    ['missing rules', { id: GROUP_ID, name: GROUP_NAME, include: [] }, 'ACCESS_PROVIDER_RESPONSE_INVALID'],
  ])('rejects %s as a deterministic failure', async (_label, result, code) => {
    const fetch = vi.fn().mockResolvedValue(ok(result))
    await expect(reconcileAccessGroup(input(fetch))).rejects.toMatchObject({
      message: code,
      retryable: false,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['include membership', group({ include: [{ email: { email: 'wrong@example.test' } }] })],
    ['require rules', group({
      include: [
        { email: { email: 'anna@example.test' } },
        { email: { email: 'zoe@example.test' } },
      ],
      require: [],
    })],
    ['exclude rules', group({
      include: [
        { email: { email: 'anna@example.test' } },
        { email: { email: 'zoe@example.test' } },
      ],
      exclude: [],
    })],
  ])('rejects final %s drift after PUT', async (_label, verified) => {
    const desired = [
      { email: { email: 'anna@example.test' } },
      { email: { email: 'zoe@example.test' } },
    ]
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok(group()))
      .mockResolvedValueOnce(ok(group({ include: desired })))
      .mockResolvedValueOnce(ok(verified))
    await expect(reconcileAccessGroup(input(fetch))).rejects.toMatchObject({
      message: 'ACCESS_PROVIDER_VERIFICATION_MISMATCH',
      retryable: true,
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
  ])('classifies HTTP %i without reading or exposing its body', async (status, retryable) => {
    const json = vi.fn(() => {
      throw new Error(`secret body ${TOKEN} anna@example.test`)
    })
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      redirected: false,
      status,
      url: URL,
      json,
    })
    let error
    try {
      await reconcileAccessGroup(input(fetch))
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ message: 'ACCESS_PROVIDER_HTTP', retryable })
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain('anna@example.test')
    expect(json).not.toHaveBeenCalled()
  })

  it.each([
    [{ ok: true, status: 429 }, 'ACCESS_PROVIDER_RESPONSE_INVALID'],
    [{ ok: false, status: 200 }, 'ACCESS_PROVIDER_RESPONSE_INVALID'],
  ])('rejects an inconsistent transport shape before reading its body', async (transport, code) => {
    const json = vi.fn()
    const fetch = vi.fn().mockResolvedValue({
      redirected: false,
      url: URL,
      ...transport,
      json,
    })
    await expect(reconcileAccessGroup(input(fetch))).rejects.toMatchObject({
      message: code,
      retryable: false,
    })
    expect(json).not.toHaveBeenCalled()
  })

  it('classifies network failures and bounded abort timeouts as fixed retryable errors', async () => {
    const networkFetch = vi.fn().mockRejectedValue(new Error(`socket ${TOKEN} anna@example.test`))
    await expect(reconcileAccessGroup(input(networkFetch))).rejects.toMatchObject({
      message: 'ACCESS_PROVIDER_NETWORK',
      retryable: true,
    })

    const hangingFetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('raw timeout'), {
        name: 'AbortError',
      })))
    }))
    await expect(reconcileAccessGroup(input(hangingFetch, { timeoutMs: 1 }))).rejects.toMatchObject({
      message: 'ACCESS_PROVIDER_TIMEOUT',
      retryable: true,
    })
  })

  it('enforces the deadline when fetch ignores the abort signal', async () => {
    const fetch = vi.fn(() => new Promise(() => {}))
    const provider = reconcileAccessGroup(input(fetch, {
      timeoutMs: 1,
      setTimeout: (callback) => {
        queueMicrotask(callback)
        return 1
      },
      clearTimeout: vi.fn(),
    }))
    const outcome = await Promise.race([
      provider.catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 20)),
    ])
    expect(outcome).toMatchObject({
      message: 'ACCESS_PROVIDER_TIMEOUT',
      retryable: true,
    })
  })

  it('sanitizes a spoofed provider-prefixed error from fetch', async () => {
    const fetch = vi.fn().mockRejectedValue(Object.assign(
      new Error(`ACCESS_PROVIDER_HTTP:${TOKEN}:anna@example.test`),
      { secret: TOKEN },
    ))
    let error
    try {
      await reconcileAccessGroup(input(fetch))
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      message: 'ACCESS_PROVIDER_NETWORK',
      retryable: true,
    })
    expect(error).not.toHaveProperty('secret')
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain('anna@example.test')
  })

  it('keeps the deadline active while streaming the response body', async () => {
    let fireTimeout
    let timeoutActive = false
    const setTimeout = vi.fn((callback) => {
      fireTimeout = callback
      timeoutActive = true
      return 1
    })
    const clearTimeout = vi.fn(() => {
      timeoutActive = false
    })
    const validBody = new TextEncoder().encode(JSON.stringify({
      success: true,
      result: group(),
    }))
    const fetch = vi.fn(async () => responseAtEndpoint(new ReadableStream({
      pull(controller) {
        if (timeoutActive) {
          fireTimeout()
          return new Promise(() => {})
        }
        controller.enqueue(validBody)
        controller.close()
      },
    })))
    await expect(reconcileAccessGroup(input(fetch, {
      timeoutMs: 1,
      setTimeout,
      clearTimeout,
    }))).rejects.toMatchObject({
      message: 'ACCESS_PROVIDER_TIMEOUT',
      retryable: true,
    })
    expect(clearTimeout).toHaveBeenCalledTimes(1)
  })

  it('stops reading an oversized provider response at the byte limit', async () => {
    const oversized = JSON.stringify({
      success: true,
      ignored: 'x'.repeat(100_000),
      result: group(),
    })
    const encoded = new TextEncoder().encode(oversized)
    const chunks = []
    for (let offset = 0; offset < encoded.byteLength; offset += 1024) {
      chunks.push(encoded.slice(offset, offset + 1024))
    }
    let pulls = 0
    const fetch = vi.fn(async () => responseAtEndpoint(new ReadableStream({
      pull(controller) {
        if (pulls >= chunks.length) {
          controller.close()
          return
        }
        controller.enqueue(chunks[pulls])
        pulls += 1
      },
    })))
    await expect(reconcileAccessGroup(input(fetch))).rejects.toMatchObject({
      message: 'ACCESS_PROVIDER_RESPONSE_INVALID',
      retryable: false,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(pulls).toBeLessThan(chunks.length)
  })

  it('classifies a streaming read rejection as a sanitized retryable network error', async () => {
    const raw = new Error(`stream reset ${TOKEN} anna@example.test`)
    const cancellation = rejectingCancel(
      new Error(`cancel failed ${TOKEN} zoe@example.test`),
    )
    const reader = {
      read: vi.fn().mockRejectedValue(raw),
      cancel: cancellation.cancel,
    }
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      redirected: false,
      status: 200,
      url: URL,
      body: { getReader: () => reader },
    })
    let error
    try {
      await reconcileAccessGroup(input(fetch))
    } catch (caught) {
      error = caught
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(error).toMatchObject({
      message: 'ACCESS_PROVIDER_NETWORK',
      retryable: true,
    })
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain('anna@example.test')
    expect(cancellation.cancel).toHaveBeenCalledTimes(1)
    expect(cancellation.handled()).toBe(true)
    expect(cancellation.unhandled).toEqual([])
  })

  it('swallows a rejecting cancel while reporting an oversized stream with a fixed code', async () => {
    const cancellation = rejectingCancel(
      new Error(`cancel leaked ${TOKEN} anna@example.test`),
    )
    const reader = {
      read: vi.fn().mockResolvedValue({
        done: false,
        value: new Uint8Array(65_537),
      }),
      cancel: cancellation.cancel,
    }
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      redirected: false,
      status: 200,
      url: URL,
      body: { getReader: () => reader },
    })
    let error
    try {
      await reconcileAccessGroup(input(fetch))
    } catch (caught) {
      error = caught
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(error).toMatchObject({
      message: 'ACCESS_PROVIDER_RESPONSE_INVALID',
      retryable: false,
    })
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain('anna@example.test')
    expect(cancellation.cancel).toHaveBeenCalledTimes(1)
    expect(cancellation.handled()).toBe(true)
    expect(cancellation.unhandled).toEqual([])
  })

  it.each([
    [{ appEnv: 'production', emails: ['kontakt@bearwithme.pl'] }, 'ACCESS_PROVIDER_CONFIG_INVALID'],
    [{ appEnv: 'staging', emails: ['disabled@example.test'] }, 'ACCESS_PROVIDER_CONFIG_INVALID'],
    [{ emails: ['PERSON@example.test'] }, 'ACCESS_PROVIDER_CONFIG_INVALID'],
    [{ emails: ['person@localhost'] }, 'ACCESS_PROVIDER_CONFIG_INVALID'],
    [{ emails: [' person@example.test'] }, 'ACCESS_PROVIDER_CONFIG_INVALID'],
    [{ timeoutMs: 15_001 }, 'ACCESS_PROVIDER_CONFIG_INVALID'],
    [{ token: '   ' }, 'ACCESS_PROVIDER_CONFIG_INVALID'],
  ])('rejects unsafe provider input before fetch', async (overrides, code) => {
    const fetch = vi.fn()
    await expect(reconcileAccessGroup(input(fetch, overrides))).rejects.toMatchObject({
      message: code,
      retryable: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
