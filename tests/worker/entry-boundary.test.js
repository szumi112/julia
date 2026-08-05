import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import worker from '../../worker/index.js'
import { enqueueOutboxStatement } from '../../worker/jobs/outbox.js'
import { getOrCreateDataKey } from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'

const valid = {
  APP_ENV: 'development',
  APP_ORIGIN: 'http://127.0.0.1:5174',
  DATA_MODE: 'fictional',
  ACCESS_AUD: 'aud-1',
  ACCESS_HEALTH_SERVICE_TOKEN_ID: 'health-token-id',
  ACCESS_TEAM_DOMAIN: 'https://bearwithme.cloudflareaccess.com',
  ACTIVE_DATA_KEK_VERSION: '1',
  ACTIVE_LOOKUP_KEY_VERSION: '1',
  ACTIVE_BACKUP_KEK_VERSION: '1',
  BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  BWM_BACKUP_KEK_V1: 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
}
const IDENTITY_SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})

const CORE_ORIGIN = 'https://panel.example.test'
const CORE_CONFIG = Object.freeze({
  appEnv: 'staging', appOrigin: CORE_ORIGIN, dataMode: 'fictional',
})
const CORE_ACTORS = Object.freeze([
  Object.freeze({ id: 'stf_boundary_owner', role: 'owner', specialistId: null, version: 1 }),
  Object.freeze({ id: 'stf_boundary_coordinator', role: 'coordinator', specialistId: null, version: 1 }),
  Object.freeze({ id: 'stf_boundary_specialist', role: 'specialist', specialistId: 'sp_boundary', version: 1 }),
])
const CLIENT_BODY = Object.freeze({
  name: 'Fikcyjna granica', age: 12, status: 'active', specialistId: 'sp_boundary',
})
const CORE_CASES = Object.freeze([
  Object.freeze({ id: 'workspace', method: 'GET', path: '/api/v1/workspace?from=2027-01-01&to=2027-01-01' }),
  Object.freeze({ id: 'clients.create', path: '/api/v1/clients', body: CLIENT_BODY }),
  Object.freeze({ id: 'clients.edit', path: '/api/v1/clients/cl_guessed/edits', body: {
    expectedVersion: 1, ...CLIENT_BODY,
  } }),
  Object.freeze({ id: 'clients.archive', path: '/api/v1/clients/cl_guessed/archive', body: {
    expectedVersion: 1,
  } }),
  Object.freeze({ id: 'appointments.create', path: '/api/v1/appointments', body: {
    clientId: 'cl_guessed', specialistId: 'sp_boundary', serviceId: 'zajecia',
    date: '2027-01-01', time: '10:00', durationMinutes: 50,
    expectedAmountGrosze: 18_000, location: null, status: 'scheduled',
  } }),
  Object.freeze({ id: 'appointments.edit', path: '/api/v1/appointments/apt_guessed/edits', body: {
    expectedVersion: 1, specialistId: 'sp_boundary', serviceId: 'zajecia',
    date: '2027-01-01', time: '10:00', durationMinutes: 50,
    expectedAmountGrosze: 18_000, location: null, status: 'scheduled',
  } }),
  Object.freeze({ id: 'appointments.cancel', path: '/api/v1/appointments/apt_guessed/cancellation', body: {
    expectedVersion: 1,
  } }),
  Object.freeze({ id: 'appointments.payment', path: '/api/v1/appointments/apt_guessed/payments', body: {
    expectedVersion: 1, amountGrosze: 18_000, method: 'card',
    receivedAt: '2027-01-01T09:00:00.000Z',
  } }),
  Object.freeze({ id: 'payments.correct', path: '/api/v1/payments/pay_guessed/corrections', body: {
    expectedVersion: 1, reason: 'Fikcyjna korekta', replacement: null,
  } }),
])

const coreRequest = (entry, body = entry.body, headers = {}) => new Request(
  `https://worker.example.test${entry.path}`,
  entry.method === 'GET'
    ? { method: 'GET', headers }
    : {
        method: 'POST',
        headers: {
          origin: CORE_ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': 'entry-boundary-key-0001',
          'x-csrf-token': 'valid-token',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
)

const coreApp = (overrides = {}) => {
  const called = []
  const unavailable = (endpoint) => async (input) => {
    called.push({ endpoint, role: input.actor.role,
      target: input.clientId ?? input.appointmentId ?? input.paymentId ?? null })
    throw new Error('NOT_FOUND')
  }
  const app = createApp({
    config: CORE_CONFIG,
    db: env.DB,
    cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
    resolveAccessPrincipal: async () => ({ kind: 'human', subject: 'access-boundary' }),
    resolveActor: async () => CORE_ACTORS[0],
    verifyCsrfToken: async () => true,
    getWorkspace: unavailable('workspace'),
    postClient: unavailable('clients.create'),
    postClientEdit: unavailable('clients.edit'),
    postClientArchive: unavailable('clients.archive'),
    postAppointment: unavailable('appointments.create'),
    postAppointmentEdit: unavailable('appointments.edit'),
    postAppointmentCancellation: unavailable('appointments.cancel'),
    postAppointmentPayment: unavailable('appointments.payment'),
    postPaymentCorrection: unavailable('payments.correct'),
    safeLog: vi.fn(),
    ...overrides,
  })
  return { app, called }
}

const errorCode = async (response) => (await response.json()).error.code

async function ensureIdentityKey(runtimeEnv, id, createdAt) {
  const keyring = await createKeyring(runtimeEnv, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(
    env.DB,
    keyring,
    IDENTITY_SCOPE,
    { id, createdAt },
  )
  return { keyring, dataKey, scope: IDENTITY_SCOPE }
}

describe('Worker entry boundary', () => {
  it('rejects malformed configuration before serving a health response', async () => {
    expect(() => worker.fetch(
      new Request('https://example.test/api/v1/health/live'),
      { ...valid, APP_ORIGIN: '*' },
      { waitUntil() {} }
    )).toThrow()
  })

  it('requires a service assertion after accepting runtime configuration', async () => {
    const response = await worker.fetch(
      new Request('https://example.test/api/v1/health/live'),
      valid,
      { waitUntil() {} }
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'ACCESS_ASSERTION_INVALID' },
    })
  })

  it('does not require backup provider bindings for authenticated fetch handling', async () => {
    const response = await worker.fetch(
      new Request('https://example.test/api/v1/health/live'),
      valid,
      { waitUntil() {} }
    )

    expect(response.status).toBe(401)
  })

  it('rejects malformed configuration before scheduling work', () => {
    let waitUntilCalls = 0
    expect(() => worker.scheduled(
      {},
      { ...valid, ACTIVE_DATA_KEK_VERSION: '01' },
      { waitUntil() { waitUntilCalls += 1 } }
    )).toThrow()
    expect(waitUntilCalls).toBe(0)
  })

  it('validates configuration first and gives one promise ownership of scheduled completion', async () => {
    const scheduledTime = Date.parse('2038-01-15T00:00:00.000Z')
    const runtimeEnv = { ...env, ...valid, DB: env.DB }
    await ensureIdentityKey(runtimeEnv, 'key_entry_scheduler', '2038-01-15T00:00:00.000Z')
    const promises = []

    expect(worker.scheduled(
      { scheduledTime, cron: '*/5 * * * *' },
      runtimeEnv,
      { waitUntil(promise) { promises.push(promise) } }
    )).toBeUndefined()
    expect(promises).toHaveLength(1)

    await expect(promises[0]).resolves.toMatchObject({
      status: 'succeeded',
      reason: null,
    })
    expect(await env.DB.prepare(
      'SELECT scheduled_for,status FROM scheduler_runs WHERE scheduled_for=?'
    ).bind('2038-01-15T00:00:00.000Z').first()).toEqual({
      scheduled_for: '2038-01-15T00:00:00.000Z',
      status: 'succeeded',
    })
  })

  it('routes the explicit five-minute cron to the operations scheduler', async () => {
    const scheduledTime = Date.parse('2038-01-15T00:05:00.000Z')
    const runtimeEnv = { ...env, ...valid, DB: env.DB }
    await ensureIdentityKey(runtimeEnv, 'key_entry_operations', '2038-01-15T00:05:00.000Z')
    const promises = []

    expect(worker.scheduled(
      { scheduledTime, cron: '*/5 * * * *' },
      runtimeEnv,
      { waitUntil(promise) { promises.push(promise) } }
    )).toBeUndefined()
    expect(promises).toHaveLength(1)

    await expect(promises[0]).resolves.toMatchObject({
      status: 'succeeded',
      reason: null,
    })
    expect(await env.DB.prepare(
      'SELECT scheduled_for,status FROM scheduler_runs WHERE scheduled_for=?'
    ).bind('2038-01-15T00:05:00.000Z').first()).toEqual({
      scheduled_for: '2038-01-15T00:05:00.000Z',
      status: 'succeeded',
    })
  })

  it('routes the minute cron to the isolated outbox drain', async () => {
    const scheduledTime = Date.parse('2038-01-15T00:01:00.000Z')
    const runtimeEnv = { ...env, ...valid, DB: env.DB }
    const cryptoContext = await ensureIdentityKey(
      runtimeEnv,
      'key_entry_outbox',
      '2038-01-15T00:01:00.000Z',
    )
    const job = await enqueueOutboxStatement(env.DB, cryptoContext, {
      id: 'job_entry_outbox',
      type: 'staff.invitation.expire',
      aggregateType: 'staff_invitation',
      aggregateId: 'inv_entry_outbox_missing',
      payload: {
        actorId: 'stf_entry_outbox_owner',
        invitationId: 'inv_entry_outbox_missing',
      },
      idempotencyKey: 'staff.invitation.expire:entry-outbox',
      scheduledAt: '2038-01-15T00:01:00.000Z',
      nowMs: scheduledTime,
    })
    await job.run()
    const promises = []

    expect(worker.scheduled(
      { scheduledTime, cron: '* * * * *' },
      runtimeEnv,
      { waitUntil(promise) { promises.push(promise) } }
    )).toBeUndefined()
    expect(promises).toHaveLength(1)

    await expect(promises[0]).resolves.toEqual({
      status: 'succeeded',
      reason: null,
      claimedJobs: 1,
      succeededJobs: 1,
      failedJobs: 0,
    })
    expect(await env.DB.prepare(
      'SELECT id FROM scheduler_runs WHERE scheduled_for=?'
    ).bind('2038-01-15T00:01:00.000Z').first()).toBeNull()
    expect(await env.DB.prepare(
      'SELECT status,attempt_count FROM outbox_jobs WHERE id=?'
    ).bind('job_entry_outbox').first()).toEqual({
      status: 'succeeded',
      attempt_count: 1,
    })
  })

  it('rejects missing cron metadata before giving work to waitUntil', () => {
    let waitUntilCalls = 0

    expect(() => worker.scheduled(
      { scheduledTime: Date.parse('2038-01-15T00:02:00.000Z') },
      { ...env, ...valid, DB: env.DB },
      { waitUntil() { waitUntilCalls += 1 } }
    )).toThrow(/^SCHEDULED_CRON_INVALID$/)
    expect(waitUntilCalls).toBe(0)
  })

  it('rejects an unknown cron before giving work to waitUntil', () => {
    let waitUntilCalls = 0

    expect(() => worker.scheduled(
      { scheduledTime: Date.parse('2038-01-15T00:02:00.000Z'), cron: '2 * * * *' },
      { ...env, ...valid, DB: env.DB },
      { waitUntil() { waitUntilCalls += 1 } }
    )).toThrow(/^SCHEDULED_CRON_INVALID$/)
    expect(waitUntilCalls).toBe(0)
  })
})

describe('core Worker route boundary', () => {
  it('collapses every role x endpoint guessed-ID attempt to the same opaque result', async () => {
    const called = []

    for (const actor of CORE_ACTORS) {
      const route = coreApp({ resolveActor: async () => actor })
      for (const entry of CORE_CASES) {
        const response = await route.app.request(coreRequest(entry))
        expect(response.status).toBe(404)
        expect(await errorCode(response)).toBe('NOT_FOUND')
      }
      called.push(...route.called)
    }

    expect(called).toHaveLength(CORE_ACTORS.length * CORE_CASES.length)
    expect(called.map(({ endpoint }) => endpoint)).toEqual([
      ...CORE_ACTORS.flatMap(() => CORE_CASES.map(({ id }) => id)),
    ])
    expect(called.map(({ role }) => role)).toEqual([
      ...CORE_ACTORS.flatMap(({ role }) => CORE_CASES.map(() => role)),
    ])
    expect(called.map(({ target }) => target)).toEqual([
      ...CORE_ACTORS.flatMap(() => CORE_CASES.map(({ id }) => (
        id === 'clients.edit' || id === 'clients.archive' ? 'cl_guessed'
          : id.startsWith('appointments.') && id !== 'appointments.create' ? 'apt_guessed'
            : id === 'payments.correct' ? 'pay_guessed' : null
      ))),
    ])
  })

  it('rejects unknown, duplicate, and malformed JSON before a core command service runs', async () => {
    const { app, called } = coreApp()
    const cases = [
      [JSON.stringify({ ...CLIENT_BODY, unknown: true }), 'VALIDATION_FAILED'],
      ['{"name":"Fikcyjna","name":"Druga","age":12,"status":"active","specialistId":"sp_boundary"}', 'VALIDATION_FAILED'],
      ['{"name":', 'INVALID_JSON'],
    ]

    for (const [body, expected] of cases) {
      const response = await app.request(coreRequest(CORE_CASES[1], body))
      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe(expected)
    }
    expect(called).toEqual([])
  })

  it('accepts exactly 65,536 request bytes and rejects the next byte before dispatch', async () => {
    const called = []
    const { app } = coreApp({
      postClient: async (input) => {
        called.push(input.body)
        return { status: 201, body: { data: { client: { id: 'cl_boundary' } } } }
      },
    })
    const encoded = new TextEncoder()
    const canonical = JSON.stringify(CLIENT_BODY)
    const atLimit = `${canonical}${' '.repeat(65_536 - encoded.encode(canonical).byteLength)}`
    const aboveLimit = `${canonical}${' '.repeat(65_537 - encoded.encode(canonical).byteLength)}`

    const accepted = await app.request(coreRequest(CORE_CASES[1], atLimit))
    expect(accepted.status).toBe(201)
    expect(called).toEqual([CLIENT_BODY])
    const rejected = await app.request(coreRequest(CORE_CASES[1], aboveLimit))
    expect(rejected.status).toBe(413)
    expect(await errorCode(rejected)).toBe('PAYLOAD_TOO_LARGE')
    expect(called).toHaveLength(1)
  })

  it('enforces method, origin, Access, and CSRF gates in order without leaking the request', async () => {
    const events = []
    const make = ({ accessFailure = null, csrfFailure = null } = {}) => coreApp({
      resolveAccessPrincipal: async () => {
        events.push('access')
        if (accessFailure) throw new Error(accessFailure)
        return { kind: 'human', subject: 'access-boundary' }
      },
      verifyCsrfToken: async () => {
        events.push('csrf')
        if (csrfFailure) throw new Error(csrfFailure)
      },
      resolveActor: async () => {
        events.push('actor')
        return CORE_ACTORS[0]
      },
      readJsonBodyOnce: async () => {
        events.push('body')
        return CLIENT_BODY
      },
      postClient: async () => {
        events.push('service')
        return { status: 201, body: { data: { client: { id: 'cl_boundary' } } } }
      },
    }).app

    const method = await make().request(new Request('https://worker.example.test/api/v1/clients', {
      method: 'PUT', body: JSON.stringify(CLIENT_BODY), headers: { 'content-type': 'application/json' },
    }))
    expect(method.status).toBe(405)
    expect(events).toEqual([])

    const origin = await make().request(coreRequest(CORE_CASES[1], CLIENT_BODY, {
      origin: 'https://wrong-origin.example.test',
    }))
    expect(origin.status).toBe(403)
    expect(await errorCode(origin)).toBe('ORIGIN_INVALID')
    expect(events).toEqual([])

    const access = await make({ accessFailure: 'ACCESS_DENIED' }).request(coreRequest(CORE_CASES[1]))
    expect(access.status).toBe(403)
    expect(await errorCode(access)).toBe('ACCESS_DENIED')
    expect(events).toEqual(['access'])

    events.length = 0
    const csrf = await make({ csrfFailure: 'CSRF_INVALID' }).request(coreRequest(CORE_CASES[1]))
    expect(csrf.status).toBe(403)
    expect(await errorCode(csrf)).toBe('CSRF_INVALID')
    expect(events).toEqual(['access', 'csrf'])

    events.length = 0
    const accepted = await make().request(coreRequest(CORE_CASES[1]))
    expect(accepted.status).toBe(201)
    expect(events).toEqual(['access', 'csrf', 'actor', 'body', 'service'])
  })

  it('keeps fictional identity values out of entry logs and error envelopes', async () => {
    const confidentialName = 'Fikcyjna nazwa tylko dla testu granicy'
    const safeLog = vi.fn()
    const { app } = coreApp({
      safeLog,
      postClient: async () => { throw new Error('NOT_FOUND') },
    })
    const response = await app.request(coreRequest(CORE_CASES[1], {
      ...CLIENT_BODY, name: confidentialName,
    }))
    expect(response.status).toBe(404)
    const error = await response.json()
    const observed = JSON.stringify({ error, logs: safeLog.mock.calls })
    expect(observed).not.toContain(confidentialName)
    expect(observed).not.toContain('specialistId')
  })
})
