import { describe, expect, it, vi } from 'vitest'
import {
  escapeInvitationHtml,
  escapeInvitationText,
  sendInvitationEmail,
} from '../../worker/providers/resend-email.js'

const ENDPOINT = 'https://api.resend.com/emails'
const PROVIDER_ID = '22222222-2222-4222-8222-222222222222'
const valid = Object.freeze({
  apiKey: 're_provider_secret',
  fromEmail: 'powiadomienia@example.test',
  fromName: 'Bear with me',
  appOrigin: 'https://bearwithme-panel.app',
  jobId: 'job_invitation_email_1',
  recipient: 'anna@example.test',
  expiresAt: '2027-01-15T10:05:09.123Z',
})

const response = (body, status = 200) => {
  const result = new Response(status === 204 ? null : body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
  Object.defineProperty(result, 'url', { value: ENDPOINT })
  return result
}

const responseAtEndpoint = (overrides = {}) => ({
  redirected: false,
  url: ENDPOINT,
  ...overrides,
})

const acceptedBody = (value = { id: PROVIDER_ID }) => JSON.stringify(value)

function fixedError(error, expected) {
  expect(error).toMatchObject(expected)
  expect(Object.keys(error).sort()).toEqual(['ambiguous', 'code', 'retryable'])
  expect(error.message).not.toContain(valid.apiKey)
  expect(error.message).not.toContain(valid.recipient)
  return error
}

async function rejected(input, expected) {
  let error
  try {
    await sendInvitationEmail(input)
  } catch (caught) {
    error = caught
  }
  return fixedError(error, expected)
}

describe('Resend invitation email provider request', () => {
  it('sends the exact deterministic one-recipient request without identity-bearing content', async () => {
    const fetch = vi.fn(async () => response(acceptedBody()))

    await expect(sendInvitationEmail({ ...valid, fetch }))
      .resolves.toEqual({ providerId: PROVIDER_ID })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe(ENDPOINT)
    const init = fetch.mock.calls[0][1]
    expect(Object.keys(init)).toEqual(['method', 'headers', 'body', 'redirect', 'signal'])
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.headers).toEqual({
      Authorization: `Bearer ${valid.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': valid.jobId,
    })
    const body = JSON.parse(init.body)
    expect(Object.keys(body)).toEqual(['from', 'to', 'subject', 'text', 'html', 'headers'])
    expect(body.from).toBe(`${valid.fromName} <${valid.fromEmail}>`)
    expect(body.to).toEqual([valid.recipient])
    expect(body.headers).toEqual({ 'X-BWM-Job-ID': valid.jobId })
    expect(init.headers).not.toHaveProperty('X-BWM-Job-ID')
    for (const content of [body.subject, body.text, body.html]) {
      expect(content).toContain('Bear with me')
      expect(content).not.toContain(valid.recipient)
      expect(content).not.toMatch(/hasło|token|pacjent/iu)
    }
    for (const content of [body.text, body.html]) {
      expect(content).toContain(valid.appOrigin)
      expect(content).toContain(valid.expiresAt)
      expect(content).toContain('Europe/Warsaw')
      expect(content).toMatch(/11:05:09/)
    }
    expect(init.body).toBe(JSON.stringify(body))
  })

  it('uses dedicated text and HTML escaping for every interpolated value', () => {
    expect(escapeInvitationText('line\r\nnext\u0000')).toBe('line next ')
    expect(escapeInvitationHtml(`https://example.test/?a=1&b="<tag>'`))
      .toBe('https://example.test/?a=1&amp;b=&quot;&lt;tag&gt;&#39;')
  })

  it.each([
    ['a missing fetch implementation', { fetch: null }],
    ['an empty API key', { apiKey: '' }],
    ['a whitespace-bearing API key', { apiKey: 're secret' }],
    ['a noncanonical recipient', { recipient: 'Anna@example.test' }],
    ['a non-fictional recipient', { recipient: 'anna@example.com' }],
    ['a control-bearing recipient', { recipient: 'anna\u0000@example.test' }],
    ['a quoted recipient local part', { recipient: '"anna"@example.test' }],
    ['a leading-dot recipient local part', { recipient: '.anna@example.test' }],
    ['consecutive recipient local dots', { recipient: 'anna..x@example.test' }],
    ['a leading-hyphen recipient domain label', { recipient: 'anna@-example.test' }],
    ['consecutive recipient domain dots', { recipient: 'anna@example..test' }],
    ['a path-bearing app origin', { appOrigin: 'https://bearwithme-panel.app/login' }],
    ['a noncanonical expiry', { expiresAt: '2027-01-15T10:05:09Z' }],
    ['a control-bearing sender name', { fromName: 'Bear\nwith me' }],
    ['an angle-bracket-bearing sender name', { fromName: 'Bear <with me' }],
    ['an angle-bracket-closing sender name', { fromName: 'Bear with> me' }],
  ])('classifies %s before provider I/O', async (_label, patch) => {
    const fetch = vi.fn()
    await rejected({ ...valid, fetch, ...patch }, {
      code: 'EMAIL_PROVIDER_CONFIG_INVALID',
      retryable: false,
      ambiguous: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Resend invitation email provider response', () => {
  it.each([
    ['a redirected response', true, ENDPOINT, 0],
    ['a response from another endpoint', false, `https://redirect.invalid/${valid.apiKey}`, 1],
    ['a synthetic response without a provable URL', false, undefined, 0],
  ])('rejects %s before status or body parsing', async (_label, redirected, url, expectedUrlReads) => {
    let urlReads = 0
    let statusReads = 0
    let bodyReads = 0
    const candidate = { redirected }
    if (url !== undefined) Object.defineProperty(candidate, 'url', { get() { urlReads += 1; return url } })
    Object.defineProperties(candidate, {
      status: { get() { statusReads += 1; return 200 } },
      body: { get() { bodyReads += 1; throw new Error(`${valid.apiKey} private response body`) } },
    })
    const error = await rejected({ ...valid, fetch: async () => candidate }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS', retryable: false, ambiguous: true,
    })
    expect(urlReads).toBe(expectedUrlReads)
    expect(statusReads).toBe(0)
    expect(bodyReads).toBe(0)
    expect(error.message).not.toContain('private response body')
  })

  it.each([
    [429, 'EMAIL_PROVIDER_RATE_LIMITED', true, false],
    [400, 'EMAIL_PROVIDER_REJECTED', false, false],
    [401, 'EMAIL_PROVIDER_REJECTED', false, false],
    [422, 'EMAIL_PROVIDER_REJECTED', false, false],
    [500, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
    [201, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
    [204, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
  ])('maps HTTP %i to a fixed sanitized classification', async (status, code, retryable, ambiguous) => {
    const error = await rejected({
      ...valid,
      fetch: async () => response(`${valid.apiKey} ${valid.recipient} raw-provider-body`, status),
    }, { code, retryable, ambiguous })
    expect(error.message).not.toContain('raw-provider-body')
  })

  it.each([
    [429, 'EMAIL_PROVIDER_RATE_LIMITED', true, false],
    [400, 'EMAIL_PROVIDER_REJECTED', false, false],
    [500, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
  ])('cancels an immediate HTTP %i response body without changing classification', async (
    status,
    code,
    retryable,
    ambiguous,
  ) => {
    let cancellations = 0
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('private provider body')) },
      cancel() { cancellations += 1 },
    })
    await rejected({
      ...valid,
      fetch: async () => responseAtEndpoint({ status, body: stream }),
    }, { code, retryable, ambiguous })
    await Promise.resolve()
    expect(cancellations).toBe(1)
  })

  it.each([
    ['malformed JSON', '{"id":'],
    ['a duplicate success key', `{"id":"${PROVIDER_ID}","id":"${PROVIDER_ID}"}`],
    ['an extra success field', `{"id":"${PROVIDER_ID}","other":true}`],
    ['a missing identifier', '{}'],
    ['an invalid provider ID', '{"id":"email_1"}'],
    ['an uppercase provider UUID', '{"id":"22222222-2222-4222-8222-22222222222A"}'],
    ['a non-string identifier', '{"id":1}'],
  ])('treats %s as ambiguous', async (_label, body) => {
    await rejected({ ...valid, fetch: async () => response(body) }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS', retryable: false, ambiguous: true,
    })
  })

  it('treats network failure as ambiguous without leaking transport data', async () => {
    await rejected({
      ...valid,
      fetch: async () => { throw new Error(`${valid.apiKey} ${valid.recipient}`) },
    }, { code: 'EMAIL_DELIVERY_AMBIGUOUS', retryable: false, ambiguous: true })
  })

  it('enforces its own deterministic timeout when fetch ignores AbortSignal', async () => {
    vi.useFakeTimers()
    try {
      const pending = sendInvitationEmail({ ...valid, fetch: async () => new Promise(() => {}) })
      const error = pending.catch((caught) => caught)
      await vi.advanceTimersByTimeAsync(10_000)
      fixedError(await error, { code: 'EMAIL_DELIVERY_AMBIGUOUS', retryable: false, ambiguous: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a hanging response reader once when the deadline expires', async () => {
    vi.useFakeTimers()
    let cancellations = 0
    try {
      const reader = {
        read: async () => new Promise(() => {}),
        cancel: async () => { cancellations += 1 },
        releaseLock() {},
      }
      const pending = sendInvitationEmail({
        ...valid,
        fetch: async () => responseAtEndpoint({ status: 200, body: { getReader: () => reader } }),
      })
      const error = pending.catch((caught) => caught)
      await vi.advanceTimersByTimeAsync(10_000)
      fixedError(await error, { code: 'EMAIL_DELIVERY_AMBIGUOUS', retryable: false, ambiguous: true })
      await vi.runAllTicks()
      expect(cancellations).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a late response body after the deadline aborts the request', async () => {
    vi.useFakeTimers()
    let cancellations = 0
    try {
      const reader = {
        read: async () => new Promise(() => {}),
        cancel: async () => { cancellations += 1 },
        releaseLock() {},
      }
      const pending = sendInvitationEmail({
        ...valid,
        fetch: async () => new Promise((resolve) => {
          setTimeout(() => resolve(responseAtEndpoint({
            status: 200,
            body: { getReader: () => reader },
          })), 11_000)
        }),
      })
      const error = pending.catch((caught) => caught)
      await vi.advanceTimersByTimeAsync(10_000)
      fixedError(await error, { code: 'EMAIL_DELIVERY_AMBIGUOUS', retryable: false, ambiguous: true })
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.runAllTicks()
      expect(cancellations).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects excessive JSON nesting with the fixed ambiguous classification', async () => {
    const nested = `${'['.repeat(256)}"x"${']'.repeat(256)}`
    await rejected({
      ...valid,
      fetch: async () => response(`{"id":"${PROVIDER_ID}","extra":${nested}}`),
    }, { code: 'EMAIL_DELIVERY_AMBIGUOUS', retryable: false, ambiguous: true })
  })

  it('stops the raw response stream as soon as it exceeds 64 KiB', async () => {
    let pulls = 0
    let cancellations = 0
    const stream = new ReadableStream({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(32 * 1024)) },
      cancel() { cancellations += 1 },
    })
    await rejected({
      ...valid,
      fetch: async () => responseAtEndpoint({ status: 200, body: stream }),
    }, { code: 'EMAIL_DELIVERY_AMBIGUOUS', retryable: false, ambiguous: true })
    expect(pulls).toBeLessThanOrEqual(3)
    expect(cancellations).toBe(1)
  })
})
