import { describe, expect, it, vi } from 'vitest'
import {
  escapeInvitationHtml,
  escapeInvitationText,
  sendInvitationEmail,
} from '../../worker/providers/scaleway-email.js'

const ENDPOINT = 'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails'
const PROVIDER_ID = '22222222-2222-4222-8222-222222222222'
const valid = Object.freeze({
  secret: 'provider-secret',
  projectId: '11111111-1111-4111-8111-111111111111',
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

const acceptedBody = (email = { id: PROVIDER_ID }) => JSON.stringify({ emails: [email] })

function fixedError(error, expected) {
  expect(error).toMatchObject(expected)
  expect(Object.keys(error).sort()).toEqual(['ambiguous', 'code', 'retryable'])
  expect(error.message).not.toContain(valid.secret)
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

describe('Scaleway invitation email provider request', () => {
  it('sends the exact deterministic one-recipient TEM request without identity-bearing content', async () => {
    const fetch = vi.fn(async () => response(acceptedBody({
      id: PROVIDER_ID,
      message_id: 'ignored-message',
      project_id: valid.projectId,
      mail_from: valid.fromEmail,
      mail_rcpt: valid.recipient,
      rcpt_type: 'to',
      subject: 'ignored-subject',
      created_at: 'ignored-created',
      updated_at: 'ignored-updated',
      status: 'queued',
      status_details: 'ignored-details',
      rcpt_to: valid.recipient,
      try_count: 4_294_967_295,
      flags: ['transactional'],
      last_tries: [{
        rank: 0,
        tried_at: 'ignored-attempted',
        code: -2_147_483_648,
        message: 'ignored-provider-message',
      }],
    })))

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
      'X-Auth-Token': valid.secret,
      'Content-Type': 'application/json',
    })
    const body = JSON.parse(init.body)
    expect(Object.keys(body)).toEqual([
      'project_id',
      'from',
      'to',
      'subject',
      'text',
      'html',
      'additional_headers',
    ])
    expect(body.project_id).toBe(valid.projectId)
    expect(body.from).toEqual({ email: valid.fromEmail, name: valid.fromName })
    expect(body.to).toEqual([{ email: valid.recipient }])
    expect(body.additional_headers).toEqual([{
      key: 'X-BWM-Job-ID',
      value: valid.jobId,
    }])
    expect(Object.keys(body.additional_headers[0])).toEqual(['key', 'value'])
    expect(init.headers).not.toHaveProperty('X-BWM-Job-ID')
    for (const content of [body.subject, body.text, body.html]) {
      expect(content).toContain('Bear with me')
      expect(content).not.toContain(valid.recipient)
      expect(content).not.toContain('Anna')
      expect(content).not.toContain('zaprosił')
      expect(content).not.toMatch(/hasło|token|pacjent/iu)
      expect(content).not.toContain('ignored-provider-message')
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

  it('serializes byte-identical bodies for identical inputs', async () => {
    const bodies = []
    const fetch = async (_url, init) => {
      bodies.push(init.body)
      return response(acceptedBody())
    }
    await sendInvitationEmail({ ...valid, fetch })
    await sendInvitationEmail({ ...valid, fetch })
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toBe(bodies[1])
  })

  it('accepts the staging owner alias only for the exact staging origin', async () => {
    const recipient = 'kontakt@bearwithme.pl'
    const fetch = vi.fn(async () => response(acceptedBody()))

    await expect(sendInvitationEmail({
      ...valid,
      appOrigin: 'https://staging.bearwithme-panel.app',
      fetch,
      recipient,
    })).resolves.toEqual({ providerId: PROVIDER_ID })
    expect(JSON.parse(fetch.mock.calls[0][1].body).to).toEqual([{ email: recipient }])

    fetch.mockClear()
    await rejected({ ...valid, fetch, recipient }, {
      code: 'EMAIL_PROVIDER_CONFIG_INVALID',
      retryable: false,
      ambiguous: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['a missing fetch implementation', { fetch: null }],
    ['a noncanonical project UUID', { projectId: 'project_1' }],
    ['a noncanonical recipient', { recipient: 'Anna@example.test' }],
    ['a non-fictional recipient', { recipient: 'anna@example.com' }],
    ['a control-bearing recipient', { recipient: 'anna\u0000@example.test' }],
    ['an outer newline-bearing recipient', { recipient: '\nanna@example.test' }],
    ['a quoted recipient local part', { recipient: '"anna"@example.test' }],
    ['a leading-dot recipient local part', { recipient: '.anna@example.test' }],
    ['a trailing-dot recipient local part', { recipient: 'anna.@example.test' }],
    ['consecutive recipient local dots', { recipient: 'anna..x@example.test' }],
    ['a leading-hyphen recipient domain label', { recipient: 'anna@-example.test' }],
    ['a trailing-hyphen recipient domain label', { recipient: 'anna@example-.test' }],
    ['consecutive recipient domain dots', { recipient: 'anna@example..test' }],
    ['a path-bearing app origin', { appOrigin: 'https://bearwithme-panel.app/login' }],
    ['a noncanonical expiry', { expiresAt: '2027-01-15T10:05:09Z' }],
    ['a control-bearing sender name', { fromName: 'Bear\nwith me' }],
    ['a U+0085-bearing sender name', { fromName: 'Bear\u0085with me' }],
    ['a U+009F-bearing sender name', { fromName: 'Bear\u009fwith me' }],
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

describe('Scaleway invitation email provider response', () => {
  it.each([
    ['a redirected response', true, ENDPOINT, 0],
    [
      'a response from another endpoint',
      false,
      `https://redirect.invalid/${valid.secret}/${valid.recipient}`,
      1,
    ],
    ['a synthetic response without a provable URL', false, undefined, 0],
  ])('rejects %s before status or body parsing', async (
    _label,
    redirected,
    url,
    expectedUrlReads,
  ) => {
    let urlReads = 0
    let statusReads = 0
    let bodyReads = 0
    const candidate = { redirected }
    if (url !== undefined) {
      Object.defineProperty(candidate, 'url', {
        get() {
          urlReads += 1
          return url
        },
      })
    }
    Object.defineProperties(candidate, {
      status: {
        get() {
          statusReads += 1
          return 200
        },
      },
      body: {
        get() {
          bodyReads += 1
          throw new Error(`${valid.secret} ${valid.recipient} private response body`)
        },
      },
    })

    const error = await rejected({
      ...valid,
      fetch: async () => candidate,
    }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })

    expect(urlReads).toBe(expectedUrlReads)
    expect(statusReads).toBe(0)
    expect(bodyReads).toBe(0)
    if (url) expect(error.message).not.toContain(url)
    expect(error.message).not.toContain('private response body')
  })

  it.each([
    'message_id',
    'project_id',
    'mail_from',
    'mail_rcpt',
    'rcpt_type',
    'subject',
    'created_at',
    'updated_at',
    'status',
    'status_details',
    'rcpt_to',
  ])('rejects a non-string %s value', async (field) => {
    await rejected({
      ...valid,
      fetch: async () => response(acceptedBody({ id: PROVIDER_ID, [field]: 1 })),
    }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })

  it.each([
    [429, 'EMAIL_PROVIDER_RATE_LIMITED', true, false],
    [400, 'EMAIL_PROVIDER_REJECTED', false, false],
    [401, 'EMAIL_PROVIDER_REJECTED', false, false],
    [422, 'EMAIL_PROVIDER_REJECTED', false, false],
    [500, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
    [503, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
    [201, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
    [204, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
    [302, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
  ])('maps HTTP %i to a fixed sanitized classification', async (status, code, retryable, ambiguous) => {
    const fetch = vi.fn(async () => response(
      `${valid.secret} ${valid.recipient} raw-provider-body`,
      status,
    ))
    const error = await rejected({ ...valid, fetch }, { code, retryable, ambiguous })
    expect(error.message).not.toContain('raw-provider-body')
  })

  it.each([
    [429, 'EMAIL_PROVIDER_RATE_LIMITED', true, false],
    [400, 'EMAIL_PROVIDER_REJECTED', false, false],
    [500, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
    [201, 'EMAIL_DELIVERY_AMBIGUOUS', false, true],
  ])('cancels an immediate HTTP %i response body without changing classification', async (
    status,
    code,
    retryable,
    ambiguous,
  ) => {
    let cancellations = 0
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('private provider body'))
      },
      cancel() {
        cancellations += 1
      },
    })
    await rejected({
      ...valid,
      fetch: async () => responseAtEndpoint({ status, body: stream }),
    }, { code, retryable, ambiguous })
    await Promise.resolve()
    expect(cancellations).toBe(1)
  })

  it.each([
    ['network rejection', async () => { throw new Error(`${valid.secret} ${valid.recipient}`) }],
    ['missing response', async () => undefined],
    ['response body read rejection', async () => ({
      redirected: false,
      url: ENDPOINT,
      status: 200,
      body: new ReadableStream({
        pull(controller) {
          controller.error(new Error(`${valid.secret} ${valid.recipient}`))
        },
      }),
    })],
  ])('treats %s as ambiguous without leaking transport data', async (_label, fetch) => {
    await rejected({ ...valid, fetch }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })

  it('does not inspect properties on a hostile transport rejection', async () => {
    const rejection = new Proxy({}, {
      get() {
        throw new Error(`${valid.secret} ${valid.recipient} hostile getter`)
      },
    })
    await rejected({
      ...valid,
      fetch: async () => { throw rejection },
    }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })

  it('enforces its own deterministic timeout when fetch ignores AbortSignal', async () => {
    vi.useFakeTimers()
    try {
      const pending = sendInvitationEmail({
        ...valid,
        fetch: async () => new Promise(() => {}),
      })
      const error = pending.catch((caught) => caught)
      await vi.advanceTimersByTimeAsync(10_000)
      fixedError(await error, {
        code: 'EMAIL_DELIVERY_AMBIGUOUS',
        retryable: false,
        ambiguous: true,
      })
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
        fetch: async () => responseAtEndpoint({
          status: 200,
          body: { getReader: () => reader },
        }),
      })
      const error = pending.catch((caught) => caught)
      await vi.advanceTimersByTimeAsync(10_000)
      fixedError(await error, {
        code: 'EMAIL_DELIVERY_AMBIGUOUS',
        retryable: false,
        ambiguous: true,
      })
      await vi.runAllTicks()
      expect(cancellations).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a late response body when fetch resolves after the deadline abort', async () => {
    vi.useFakeTimers()
    let cancellations = 0
    let releases = 0
    try {
      const reader = {
        read: async () => new Promise(() => {}),
        cancel: async () => { cancellations += 1 },
        releaseLock() { releases += 1 },
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
      fixedError(await error, {
        code: 'EMAIL_DELIVERY_AMBIGUOUS',
        retryable: false,
        ambiguous: true,
      })
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.runAllTicks()
      expect(cancellations).toBe(1)
      expect(releases).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a late non-200 response body after the deadline classification is fixed', async () => {
    vi.useFakeTimers()
    let cancellations = 0
    try {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('private late body'))
        },
        cancel() {
          cancellations += 1
        },
      })
      const pending = sendInvitationEmail({
        ...valid,
        fetch: async () => new Promise((resolve) => {
          setTimeout(() => resolve(responseAtEndpoint({ status: 500, body: stream })), 11_000)
        }),
      })
      const error = pending.catch((caught) => caught)
      await vi.advanceTimersByTimeAsync(10_000)
      fixedError(await error, {
        code: 'EMAIL_DELIVERY_AMBIGUOUS',
        retryable: false,
        ambiguous: true,
      })
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.runAllTicks()
      expect(cancellations).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects excessive JSON nesting with the fixed ambiguous classification', async () => {
    const nested = `${'['.repeat(256)}"transactional"${']'.repeat(256)}`
    await rejected({
      ...valid,
      fetch: async () => response(
        `{"emails":[{"id":"${PROVIDER_ID}","flags":${nested}}]}`,
      ),
    }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })

  it.each([
    ['malformed JSON', '{"emails":'],
    ['a duplicate top-level key', `{"emails":[{"id":"${PROVIDER_ID}"}],"emails":[]}`],
    ['a duplicate provider key', `{"emails":[{"id":"${PROVIDER_ID}","id":"${PROVIDER_ID}"}]}`],
    ['a duplicate nested key', `{"emails":[{"id":"${PROVIDER_ID}","last_tries":[{"rank":0,"rank":1,"tried_at":"x","code":1,"message":"x"}]}]}`],
    ['an unknown top-level field', `{"emails":[{"id":"${PROVIDER_ID}"}],"other":true}`],
    ['an unknown provider field', `{"emails":[{"id":"${PROVIDER_ID}","other":true}]}`],
    ['an unknown nested field', `{"emails":[{"id":"${PROVIDER_ID}","last_tries":[{"rank":0,"tried_at":"x","code":1,"message":"x","other":true}]}]}`],
    ['zero emails', '{"emails":[]}'],
    ['multiple emails', `{"emails":[{"id":"${PROVIDER_ID}"},{"id":"${PROVIDER_ID}"}]}`],
    ['a non-array emails value', '{"emails":{}}'],
    ['an invalid provider ID', '{"emails":[{"id":"TEM_1"}]}'],
    ['an uppercase provider UUID', '{"emails":[{"id":"22222222-2222-4222-8222-22222222222A"}]}'],
    ['a non-plain provider value', '{"emails":[null]}'],
    ['an invalid uint32', `{"emails":[{"id":"${PROVIDER_ID}","try_count":4294967296}]}`],
    ['a fractional uint32', `{"emails":[{"id":"${PROVIDER_ID}","try_count":1.5}]}`],
    ['a non-string optional field', `{"emails":[{"id":"${PROVIDER_ID}","message_id":1}]}`],
    ['a non-array flags field', `{"emails":[{"id":"${PROVIDER_ID}","flags":"transactional"}]}`],
    ['an invalid int32', `{"emails":[{"id":"${PROVIDER_ID}","last_tries":[{"rank":0,"tried_at":"x","code":2147483648,"message":"x"}]}]}`],
    ['an invalid nested rank', `{"emails":[{"id":"${PROVIDER_ID}","last_tries":[{"rank":-1,"tried_at":"x","code":1,"message":"x"}]}]}`],
    ['a fractional nested rank', `{"emails":[{"id":"${PROVIDER_ID}","last_tries":[{"rank":1.5,"tried_at":"x","code":1,"message":"x"}]}]}`],
    ['a non-string tried_at', `{"emails":[{"id":"${PROVIDER_ID}","last_tries":[{"rank":0,"tried_at":1,"code":1,"message":"x"}]}]}`],
    ['a non-integer nested code', `{"emails":[{"id":"${PROVIDER_ID}","last_tries":[{"rank":0,"tried_at":"x","code":1.5,"message":"x"}]}]}`],
    ['a non-string nested message', `{"emails":[{"id":"${PROVIDER_ID}","last_tries":[{"rank":0,"tried_at":"x","code":1,"message":1}]}]}`],
    ['a non-array last_tries field', `{"emails":[{"id":"${PROVIDER_ID}","last_tries":{}}]}`],
    ['a non-string flag', `{"emails":[{"id":"${PROVIDER_ID}","flags":[1]}]}`],
  ])('treats %s as ambiguous', async (_label, body) => {
    await rejected({ ...valid, fetch: async () => response(body) }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
  })

  it('stops the raw response stream as soon as it exceeds 64 KiB', async () => {
    let pulls = 0
    let cancellations = 0
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(32 * 1024))
      },
      cancel() {
        cancellations += 1
      },
    })
    await rejected({
      ...valid,
      fetch: async () => responseAtEndpoint({ status: 200, body: stream }),
    }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
    expect(pulls).toBeLessThanOrEqual(3)
    expect(cancellations).toBe(1)
  })

  it('keeps an oversized-stream cancellation rejection sanitized', async () => {
    let cancellations = 0
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(65_537))
      },
      cancel() {
        cancellations += 1
        throw new Error(`${valid.secret} ${valid.recipient} cancel failure`)
      },
    })
    await rejected({
      ...valid,
      fetch: async () => responseAtEndpoint({ status: 200, body: stream }),
    }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
    expect(cancellations).toBe(1)
  })

  it('cancels once after a read failure and keeps cancellation rejection sanitized', async () => {
    let cancellations = 0
    const reader = {
      async read() {
        throw new Error(`${valid.secret} ${valid.recipient} read failure`)
      },
      async cancel() {
        cancellations += 1
        throw new Error(`${valid.secret} ${valid.recipient} cancel failure`)
      },
      releaseLock() {},
    }
    await rejected({
      ...valid,
      fetch: async () => responseAtEndpoint({
        status: 200,
        body: { getReader: () => reader },
      }),
    }, {
      code: 'EMAIL_DELIVERY_AMBIGUOUS',
      retryable: false,
      ambiguous: true,
    })
    expect(cancellations).toBe(1)
  })
})
