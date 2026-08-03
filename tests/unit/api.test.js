import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ApiError, createApiClient } from '../../src/api.js'

const CORRELATION_ID = '77777777-7777-4777-8777-777777777777'
const TOKEN_A = 'v1.1999999999.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const TOKEN_B = 'v1.1999999998.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'

const sessionBody = (overrides = {}) => ({
  data: {
    actor: {
      id: 'stf_owner_1',
      displayName: 'Julia Właścicielka',
      role: 'owner',
      specialistId: null,
    },
    capabilities: [
      'appointment.manage',
      'staff.manage',
    ],
    csrfToken: TOKEN_A,
    csrfExpiresAt: '2033-05-18T03:33:19.000Z',
    environment: 'staging',
    dataMode: 'fictional',
    ...overrides,
  },
})

const publicSession = (body = sessionBody()) => {
  const { csrfToken: _csrfToken, ...session } = body.data
  return session
}

const staff = (overrides = {}) => ({
  id: 'stf_specialist_1',
  displayName: 'Anna Specjalistka',
  email: 'anna@example.test',
  role: 'specialist',
  status: 'active',
  version: 1,
  specialistId: 'sp_specialist_1',
  ...overrides,
})

const invitation = {
  id: 'inv_specialist_1',
  status: 'provisioning',
  expiresAt: '2033-05-25T03:33:19.000Z',
  emailSentAt: null,
  version: 1,
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const parsedResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const errorResponse = (code, status, options = {}) => jsonResponse({
  error: {
    code,
    correlationId: options.correlationId ?? CORRELATION_ID,
    ...(options.details ? { details: options.details } : {}),
    ...(options.extra ? options.extra : {}),
  },
}, status)

const queuedFetch = (...responses) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next(url, init)
    assert.ok(next, `unexpected fetch ${url}`)
    return next
  }
  return { calls, fetchImpl }
}

const header = (call, name) => new Headers(call.init.headers).get(name)

test('gets and validates the session over the exact same-origin request', async () => {
  const body = sessionBody()
  const { calls, fetchImpl } = queuedFetch(jsonResponse(body))
  const client = createApiClient({ fetchImpl })
  const observed = []
  client.subscribeSession((session) => observed.push(session))

  const result = await client.getSession()

  assert.deepEqual(result, publicSession(body))
  assert.deepEqual(observed, [publicSession(body)])
  assert.equal(Object.hasOwn(result, 'csrfToken'), false)
  assert.equal(JSON.stringify({ result, observed }).includes(TOKEN_A), false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/v1/session')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(header(calls[0], 'Accept'), 'application/json')
  assert.equal(header(calls[0], 'Authorization'), null)
  assert.equal(header(calls[0], 'X-BWM-Local-Identity'), null)
})

test('single-flights concurrent session reads and cleans up after success', async () => {
  const firstBody = sessionBody()
  const secondBody = sessionBody({
    csrfToken: TOKEN_B,
    csrfExpiresAt: '2033-05-18T03:33:18.000Z',
  })
  let releaseFirst
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve })
  const { calls, fetchImpl } = queuedFetch(
    () => firstResponse,
    jsonResponse(secondBody),
  )
  const client = createApiClient({ fetchImpl })
  const observed = []
  client.subscribeSession((session) => observed.push(session))

  const first = client.getSession()
  const concurrent = client.getSession()

  assert.equal(first, concurrent)
  assert.equal(calls.length, 1)
  releaseFirst(jsonResponse(firstBody))
  assert.deepEqual(await Promise.all([first, concurrent]), [
    publicSession(firstBody),
    publicSession(firstBody),
  ])
  assert.deepEqual(observed, [publicSession(firstBody)])

  assert.deepEqual(await client.getSession(), publicSession(secondBody))
  assert.equal(calls.length, 2)
  assert.deepEqual(observed, [
    publicSession(firstBody),
    publicSession(secondBody),
  ])
})

test('single-flights concurrent session failures and cleans up after rejection', async () => {
  let rejectFirst
  const firstResponse = new Promise((resolve, reject) => { rejectFirst = reject })
  const { calls, fetchImpl } = queuedFetch(
    () => firstResponse,
    jsonResponse(sessionBody()),
  )
  const client = createApiClient({ fetchImpl })
  const observed = []
  client.subscribeSession((session) => observed.push(session))

  const first = client.getSession()
  const concurrent = client.getSession()
  const rejected = Promise.all([first, concurrent])

  assert.equal(first, concurrent)
  assert.equal(calls.length, 1)
  rejectFirst(new Error('provider detail must stay private'))
  await assert.rejects(rejected, {
    code: 'NETWORK_ERROR',
    message: 'NETWORK_ERROR',
  })
  assert.deepEqual(observed, [])

  assert.deepEqual(await client.getSession(), publicSession())
  assert.equal(calls.length, 2)
  assert.deepEqual(observed, [publicSession()])
})

test('invalidates an in-flight session read when authentication is cleared', async () => {
  const firstBody = sessionBody()
  const secondBody = sessionBody({
    actor: {
      id: 'stf_coordinator_1',
      displayName: 'Karolina Koordynatorka',
      role: 'coordinator',
      specialistId: null,
    },
    csrfToken: TOKEN_B,
    csrfExpiresAt: '2033-05-18T03:33:18.000Z',
  })
  const invitationResult = {
    data: {
      staff: staff({ status: 'pending' }),
      invitation,
    },
  }
  let releaseFirst
  let releaseSecond
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve })
  const secondResponse = new Promise((resolve) => { releaseSecond = resolve })
  const { calls, fetchImpl } = queuedFetch(
    () => firstResponse,
    () => secondResponse,
    jsonResponse(invitationResult, 201),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'clear-race-key-0001',
  })
  const observed = []
  client.subscribeSession((session) => observed.push(session))

  const stale = client.getSession()
  client.clearSession()
  const authoritative = client.getSession()

  assert.notEqual(stale, authoritative)
  assert.equal(calls.length, 2)

  releaseSecond(jsonResponse(secondBody))
  assert.deepEqual(await authoritative, publicSession(secondBody))
  assert.deepEqual(observed, [null, publicSession(secondBody)])

  releaseFirst(jsonResponse(firstBody))
  assert.deepEqual(await stale, publicSession(firstBody))
  assert.deepEqual(observed, [null, publicSession(secondBody)])

  assert.deepEqual(await client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'specialist',
  }), invitationResult.data)
  assert.equal(header(calls[2], 'X-CSRF-Token'), TOKEN_B)
})

test('contains a stale authentication denial after a newer session succeeds', async () => {
  const authoritativeBody = sessionBody({
    actor: {
      id: 'stf_coordinator_1',
      displayName: 'Karolina Koordynatorka',
      role: 'coordinator',
      specialistId: null,
    },
    csrfToken: TOKEN_B,
    csrfExpiresAt: '2033-05-18T03:33:18.000Z',
  })
  const invitationResult = {
    data: {
      staff: staff({ status: 'pending' }),
      invitation,
    },
  }
  let releaseStale
  const staleResponse = new Promise((resolve) => { releaseStale = resolve })
  const { calls, fetchImpl } = queuedFetch(
    () => staleResponse,
    jsonResponse(authoritativeBody),
    jsonResponse(invitationResult, 201),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'stale-denial-key-0001',
  })
  const observed = []
  client.subscribeSession((session) => observed.push(session))

  const stale = client.getSession()
  client.clearSession()
  assert.deepEqual(await client.getSession(), publicSession(authoritativeBody))
  assert.deepEqual(observed, [null, publicSession(authoritativeBody)])

  releaseStale(errorResponse('ACCESS_ASSERTION_INVALID', 401))
  await assert.rejects(stale, {
    code: 'ACCESS_ASSERTION_INVALID',
    status: 401,
  })
  assert.deepEqual(observed, [null, publicSession(authoritativeBody)])

  assert.deepEqual(await client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'specialist',
  }), invitationResult.data)
  assert.equal(header(calls[2], 'X-CSRF-Token'), TOKEN_B)
})

test('lists validated staff without mutation headers', async () => {
  const body = { data: { staff: [{ ...staff(), invitation: null }] } }
  const { calls, fetchImpl } = queuedFetch(jsonResponse(body))
  const client = createApiClient({ fetchImpl })

  assert.deepEqual(await client.listStaff(), body.data)
  assert.equal(calls[0].url, '/api/v1/staff')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(header(calls[0], 'Accept'), 'application/json')
  assert.equal(header(calls[0], 'Content-Type'), null)
  assert.equal(header(calls[0], 'X-CSRF-Token'), null)
  assert.equal(header(calls[0], 'Idempotency-Key'), null)
})

test('invites staff with generated and explicit idempotency keys and exact JSON', async () => {
  const inviteBody = {
    displayName: 'Anna Specjalistka',
    email: 'anna@example.test',
    role: 'specialist',
  }
  const success = { data: { staff: staff({ status: 'pending' }), invitation } }
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse(success, 201),
    jsonResponse(success, 201),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'generated-key-0001',
  })
  await client.getSession()

  assert.deepEqual(await client.inviteStaff(inviteBody), success.data)
  assert.deepEqual(await client.inviteStaff(inviteBody, {
    idempotencyKey: 'explicit-key-0002',
  }), success.data)

  for (const call of calls.slice(1)) {
    assert.equal(call.url, '/api/v1/staff/invitations')
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.credentials, 'same-origin')
    assert.equal(header(call, 'Accept'), 'application/json')
    assert.equal(header(call, 'Content-Type'), 'application/json')
    assert.equal(header(call, 'X-CSRF-Token'), TOKEN_A)
    assert.equal(call.init.body, JSON.stringify(inviteBody))
  }
  assert.equal(header(calls[1], 'Idempotency-Key'), 'generated-key-0001')
  assert.equal(header(calls[2], 'Idempotency-Key'), 'explicit-key-0002')
})

test('deactivates only an opaque staff ID with exact version JSON', async () => {
  const success = { data: { staff: staff({ status: 'disabled', version: 4 }) } }
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse(success),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'deactivate-key-0001',
  })
  await client.getSession()

  assert.deepEqual(await client.deactivateStaff('stf_specialist_1', 3), success.data)
  assert.equal(calls[1].url, '/api/v1/staff/stf_specialist_1/deactivation')
  assert.equal(calls[1].init.body, '{"version":3}')
  assert.equal(header(calls[1], 'Idempotency-Key'), 'deactivate-key-0001')
  assert.equal(header(calls[1], 'X-CSRF-Token'), TOKEN_A)

  for (const [staffId, version] of [
    ['../owner', 3],
    ['stf_specialist_1/email@example.test', 3],
    ['stf_specialist_1', 0],
    ['stf_specialist_1', 1.5],
  ]) {
    await assert.rejects(client.deactivateStaff(staffId, version), {
      code: 'CLIENT_INPUT_INVALID',
      message: 'CLIENT_INPUT_INVALID',
    })
  }
  assert.equal(calls.length, 2)
})

test('refreshes once on CSRF_EXPIRED and reuses the exact action key', async () => {
  const refreshed = sessionBody({
    csrfToken: TOKEN_B,
    csrfExpiresAt: '2033-05-18T03:33:18.000Z',
  })
  const success = { data: { staff: staff({ status: 'pending' }), invitation } }
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    errorResponse('CSRF_EXPIRED', 403),
    jsonResponse(refreshed),
    jsonResponse(success, 201),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'csrf-retry-key-0001',
  })
  const observed = []
  client.subscribeSession((session) => observed.push(session))
  await client.getSession()

  assert.deepEqual(await client.inviteStaff({
    displayName: 'Anna Specjalistka',
    email: 'anna@example.test',
    role: 'specialist',
  }), success.data)
  assert.deepEqual(calls.map(({ url }) => url), [
    '/api/v1/session',
    '/api/v1/staff/invitations',
    '/api/v1/session',
    '/api/v1/staff/invitations',
  ])
  assert.equal(header(calls[1], 'Idempotency-Key'), 'csrf-retry-key-0001')
  assert.equal(header(calls[3], 'Idempotency-Key'), 'csrf-retry-key-0001')
  assert.equal(header(calls[1], 'X-CSRF-Token'), TOKEN_A)
  assert.equal(header(calls[3], 'X-CSRF-Token'), TOKEN_B)
  assert.deepEqual(observed, [
    publicSession(sessionBody()),
    publicSession(refreshed),
  ])
})

test('does not retry a second CSRF failure or non-CSRF server failures', async (t) => {
  await t.test('second CSRF failure', async () => {
    const { calls, fetchImpl } = queuedFetch(
      jsonResponse(sessionBody()),
      errorResponse('CSRF_EXPIRED', 403),
      jsonResponse(sessionBody({
        csrfToken: TOKEN_B,
        csrfExpiresAt: '2033-05-18T03:33:18.000Z',
      })),
      errorResponse('CSRF_EXPIRED', 403),
    )
    const client = createApiClient({
      fetchImpl,
      idempotencyKeyFactory: () => 'second-csrf-key',
    })
    await client.getSession()
    await assert.rejects(client.inviteStaff({
      displayName: 'Anna',
      email: 'anna@example.test',
      role: 'owner',
    }), { code: 'CSRF_EXPIRED' })
    assert.equal(calls.length, 4)
  })

  for (const [code, status] of [
    ['FORBIDDEN', 403],
    ['VALIDATION_FAILED', 400],
    ['VERSION_CONFLICT', 409],
    ['STAFF_INVITATION_CONFLICT', 409],
  ]) {
    await t.test(code, async () => {
      const { calls, fetchImpl } = queuedFetch(
        jsonResponse(sessionBody()),
        errorResponse(code, status),
      )
      const client = createApiClient({
        fetchImpl,
        idempotencyKeyFactory: () => `no-retry-${code.toLowerCase()}`,
      })
      await client.getSession()
      await assert.rejects(client.inviteStaff({
        displayName: 'Anna',
        email: 'anna@example.test',
        role: 'owner',
      }), { code })
      assert.equal(calls.length, 2)
    })
  }
})

test('clears authentication state on explicit clear and authentication denial', async () => {
  const success = { data: { staff: staff({ status: 'pending' }), invitation } }
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    errorResponse('ACCESS_ASSERTION_INVALID', 401),
    jsonResponse(sessionBody()),
    errorResponse('ACCESS_DENIED', 403),
    jsonResponse(sessionBody()),
    errorResponse('FORBIDDEN', 403),
    jsonResponse(success, 201),
    errorResponse('VERSION_CONFLICT', 409, {
      details: { currentVersion: 4 },
    }),
    jsonResponse(success, 201),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'auth-state-key-0001',
  })
  const observed = []
  client.subscribeSession((session) => observed.push(session))

  await client.getSession()
  await assert.rejects(client.getSession(), { code: 'ACCESS_ASSERTION_INVALID' })
  await assert.rejects(client.inviteStaff({}), { code: 'SESSION_REQUIRED' })
  assert.equal(calls.length, 2)

  await client.getSession()
  await assert.rejects(client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'owner',
  }), { code: 'ACCESS_DENIED' })
  await assert.rejects(client.inviteStaff({}), { code: 'SESSION_REQUIRED' })
  assert.equal(calls.length, 4)

  await client.getSession()
  await assert.rejects(client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'owner',
  }), { code: 'FORBIDDEN' })
  assert.deepEqual(await client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'owner',
  }), success.data)
  assert.equal(header(calls[6], 'X-CSRF-Token'), TOKEN_A)

  await assert.rejects(client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'owner',
  }), {
    code: 'VERSION_CONFLICT',
    details: { currentVersion: 4 },
  })
  assert.deepEqual(await client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'owner',
  }), success.data)
  assert.equal(header(calls[8], 'X-CSRF-Token'), TOKEN_A)

  client.clearSession()
  await assert.rejects(client.inviteStaff({}), { code: 'SESSION_REQUIRED' })
  assert.equal(calls.length, 9)
  assert.deepEqual(observed, [
    publicSession(),
    null,
    publicSession(),
    null,
    publicSession(),
    null,
  ])
})

test('isolates listener failures and honors unsubscribe', async () => {
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse(sessionBody({
      csrfToken: TOKEN_B,
      csrfExpiresAt: '2033-05-18T03:33:18.000Z',
    })),
  )
  const client = createApiClient({ fetchImpl })
  const observed = []
  client.subscribeSession(() => {
    throw new Error('listener-secret@example.test')
  })
  client.subscribeSession(async () => {
    throw new Error('async-listener-secret@example.test')
  })
  const unsubscribe = client.subscribeSession((session) => observed.push(session))

  await client.getSession()
  await Promise.resolve()
  unsubscribe()
  unsubscribe()
  await client.getSession()
  await Promise.resolve()

  assert.deepEqual(observed, [publicSession()])
})

test('rejects malformed session envelopes without replacing a valid CSRF token', async () => {
  const success = { data: { staff: staff({ status: 'pending' }), invitation } }
  const rawSecret = 'raw-response anna@example.test'
  const malformed = {
    ok: true,
    status: 200,
    json: async () => {
      throw new Error(rawSecret)
    },
  }
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    malformed,
    jsonResponse(success, 201),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'malformed-key-0001',
  })
  const observed = []
  client.subscribeSession((session) => observed.push(session))
  await client.getSession()

  await assert.rejects(client.getSession(), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'INVALID_RESPONSE')
    assert.equal(error.status, 200)
    assert.equal(error.message, 'INVALID_RESPONSE')
    assert.doesNotMatch(error.message, /anna@example\.test|raw-response/)
    return true
  })
  await client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'owner',
  })
  assert.equal(header(calls[2], 'X-CSRF-Token'), TOKEN_A)
  assert.deepEqual(observed, [publicSession()])
})

test('classifies an out-of-range CSRF expiry as a fixed invalid response', async () => {
  const oversizedToken = 'v1.9007199254740991.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
  const { fetchImpl } = queuedFetch(jsonResponse(sessionBody({
    csrfToken: oversizedToken,
  })))
  const client = createApiClient({ fetchImpl })

  await assert.rejects(client.getSession(), {
    code: 'INVALID_RESPONSE',
    message: 'INVALID_RESPONSE',
    status: 200,
  })
})

test('sanitizes throwing response and envelope getters as fixed API errors', async (t) => {
  const rawSecret = 'throwing-getter anna@example.test'
  const throwingProperty = (property, rest = {}) => Object.defineProperty(
    rest,
    property,
    {
      enumerable: true,
      get() {
        throw new Error(rawSecret)
      },
    },
  )
  const cases = [
    {
      name: 'response status',
      response: throwingProperty('status', {}),
      status: 0,
    },
    {
      name: 'success data',
      response: {
        ok: true,
        status: 200,
        json: async () => throwingProperty('data', {}),
      },
      status: 200,
    },
    {
      name: 'error code',
      response: {
        ok: false,
        status: 403,
        json: async () => ({
          error: throwingProperty('code', {
            correlationId: CORRELATION_ID,
          }),
        }),
      },
      status: 403,
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { fetchImpl } = queuedFetch(fixture.response)
      const client = createApiClient({ fetchImpl })

      await assert.rejects(client.listStaff(), (error) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'INVALID_RESPONSE')
        assert.equal(error.message, 'INVALID_RESPONSE')
        assert.equal(error.status, fixture.status)
        assert.doesNotMatch(JSON.stringify(error), /throwing-getter|anna@example\.test/)
        return true
      })
    })
  }
})

test('sanitizes throwing invite input getters before fetch', async () => {
  const rawSecret = 'input-getter anna@example.test'
  const input = {
    email: 'anna@example.test',
    role: 'owner',
  }
  Object.defineProperty(input, 'displayName', {
    enumerable: true,
    get() {
      throw new Error(rawSecret)
    },
  })
  const { calls, fetchImpl } = queuedFetch(jsonResponse(sessionBody()))
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'input-getter-key',
  })
  await client.getSession()

  await assert.rejects(Promise.resolve().then(() => client.inviteStaff(input)), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'CLIENT_INPUT_INVALID')
    assert.equal(error.message, 'CLIENT_INPUT_INVALID')
    assert.doesNotMatch(JSON.stringify(error), /input-getter|anna@example\.test/)
    return true
  })
  assert.equal(calls.length, 1)
})

test('sanitizes null and throwing public option objects before fetch', async (t) => {
  const rawSecret = 'option-getter anna@example.test'
  const throwingOptions = (property) => Object.defineProperty({}, property, {
    enumerable: true,
    get() {
      throw new Error(rawSecret)
    },
  })
  const fixedInputError = (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'CLIENT_INPUT_INVALID')
    assert.equal(error.message, 'CLIENT_INPUT_INVALID')
    assert.doesNotMatch(JSON.stringify(error), /option-getter|anna@example\.test/)
    return true
  }

  await t.test('createApiClient null options', () => {
    assert.throws(() => createApiClient(null), fixedInputError)
  })
  await t.test('createApiClient throwing options', () => {
    assert.throws(() => createApiClient(throwingOptions('fetchImpl')), fixedInputError)
  })

  for (const [name, invoke] of [
    ['inviteStaff', (client, options) => client.inviteStaff({
      displayName: 'Anna',
      email: 'anna@example.test',
      role: 'owner',
    }, options)],
    ['deactivateStaff', (client, options) => client.deactivateStaff(
      'stf_specialist_1',
      1,
      options,
    )],
  ]) {
    for (const [caseName, options] of [
      ['null options', null],
      ['throwing options', throwingOptions('idempotencyKey')],
    ]) {
      await t.test(`${name} ${caseName}`, async () => {
        const { calls, fetchImpl } = queuedFetch(jsonResponse(sessionBody()))
        const client = createApiClient({ fetchImpl })
        await client.getSession()

        await assert.rejects(
          Promise.resolve().then(() => invoke(client, options)),
          fixedInputError,
        )
        assert.equal(calls.length, 1)
      })
    }
  }
})

test('replaces an ApiError thrown by an injected response accessor', async () => {
  const rawSecret = 'forged-api-error anna@example.test'
  const forged = new ApiError('INTERNAL_ERROR', { status: 500 })
  forged.message = rawSecret
  forged.raw = rawSecret
  const response = Object.defineProperty({}, 'status', {
    get() {
      throw forged
    },
  })
  const { fetchImpl } = queuedFetch(response)
  const client = createApiClient({ fetchImpl })

  await assert.rejects(client.listStaff(), (error) => {
    assert.ok(error instanceof ApiError)
    assert.notEqual(error, forged)
    assert.equal(error.code, 'INVALID_RESPONSE')
    assert.equal(error.status, 0)
    assert.equal(error.message, 'INVALID_RESPONSE')
    assert.doesNotMatch(JSON.stringify(error), /forged-api-error|anna@example\.test/)
    return true
  })
})

test('exposes only allow-listed stable error fields', async () => {
  const rawSecret = 'anna@example.test raw provider message'
  const acceptedWorkerCorrelationId = '00000000-0000-0000-0000-000000000000'
  const { fetchImpl } = queuedFetch(errorResponse('VALIDATION_FAILED', 400, {
    correlationId: acceptedWorkerCorrelationId,
    details: {
      field: 'email',
      currentVersion: 4,
      limit: 5,
      retryAfterSeconds: 60,
      email: rawSecret,
      providerMessage: rawSecret,
    },
    extra: {
      body: rawSecret,
      headers: { authorization: rawSecret },
      message: rawSecret,
    },
  }))
  const client = createApiClient({ fetchImpl })

  await assert.rejects(client.listStaff(), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.message, 'VALIDATION_FAILED')
    assert.equal(error.code, 'VALIDATION_FAILED')
    assert.equal(error.status, 400)
    assert.equal(error.correlationId, acceptedWorkerCorrelationId)
    assert.deepEqual(error.details, {
      field: 'email',
      currentVersion: 4,
      limit: 5,
      retryAfterSeconds: 60,
    })
    assert.equal(error.idempotencyKey, undefined)
    assert.doesNotMatch(JSON.stringify(error), /anna@example\.test|provider message/)
    return true
  })
})

test('retains an opaque action key for an uncertain mutation without retrying', async () => {
  const rawSecret = 'transport failed for anna@example.test'
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    new Error(rawSecret),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'uncertain-key-0001',
  })
  await client.getSession()

  await assert.rejects(client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'owner',
  }), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.status, 0)
    assert.equal(error.message, 'NETWORK_ERROR')
    assert.equal(error.idempotencyKey, 'uncertain-key-0001')
    assert.doesNotMatch(JSON.stringify(error), /anna@example\.test|transport failed/)
    return true
  })
  assert.equal(calls.length, 2)
})

test('fails before fetch for invalid inputs, keys, or missing session state', async () => {
  const { calls, fetchImpl } = queuedFetch()
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'short',
  })

  assert.throws(() => client.createIdempotencyKey(), {
    code: 'CLIENT_INPUT_INVALID',
  })
  await assert.rejects(client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'owner',
  }, { idempotencyKey: 'bad key' }), {
    code: 'CLIENT_INPUT_INVALID',
  })
  await assert.rejects(client.inviteStaff({
    displayName: 'Anna',
    email: 'anna@example.test',
    role: 'owner',
  }, { idempotencyKey: 'valid-key-0001' }), {
    code: 'SESSION_REQUIRED',
  })
  assert.throws(() => client.subscribeSession(null), {
    code: 'CLIENT_INPUT_INVALID',
  })
  assert.equal(calls.length, 0)
})

test('keeps local identity development-only and contains no application auth storage path', async () => {
  const source = await readFile(new URL('../../src/api.js', import.meta.url), 'utf8')

  assert.match(source, /import\.meta\.env\?\.DEV === true/)
  assert.match(source, /APP_MODE === 'app'/)
  assert.match(source, /VITE_BWM_LOCAL_IDENTITY/)
  assert.doesNotMatch(source, /\bAuthorization\b/)
  assert.doesNotMatch(source, /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/)
  assert.doesNotMatch(source, /\bcaches\b|\bserviceWorker\b|\bdocument\.cookie\b/)
  assert.doesNotMatch(source, /\bconsole\./)
})

const OPERATIONS_NOW = '2033-05-18T03:33:19.000Z'
const AUDIT_CURSOR = `v1.2.cG9zaXRpb24.${'M'.repeat(43)}`

const healthBody = () => ({
  data: {
    generatedAt: OPERATIONS_NOW,
    checks: [
      { id: 'outbox.processing', label: 'Kolejka zadań', status: 'ok', lastSuccessAt: OPERATIONS_NOW, detailCode: 'OUTBOX_HEALTHY' },
      { id: 'backup.freshness', label: 'Kopie zapasowe', status: 'warning', lastSuccessAt: null, detailCode: 'BACKUP_PENDING' },
      { id: 'access.reconciliation', label: 'Synchronizacja dostępu', status: 'critical', lastSuccessAt: '2033-05-18T03:33:18.000Z', detailCode: 'ACCESS_RECONCILIATION_LAG' },
      { id: 'scheduler.runs', label: 'Zadania cykliczne', status: 'ok', lastSuccessAt: OPERATIONS_NOW, detailCode: 'SCHEDULER_HEALTHY' },
    ],
  },
})

const ACTION_FACTS = [
  {
    id: 'act_access_lag', kind: 'access_reconciliation_lag', severity: 'critical',
    entityType: 'access_group', entityId: 'centre_1',
    details: { appliedGeneration: 2, desiredGeneration: 3, errorCode: 'ACCESS_RECONCILIATION_LAG' },
  },
  {
    id: 'act_denial_spike', kind: 'authorization_denial_spike', severity: 'warning',
    entityType: 'staff_user', entityId: 'stf_target',
    details: { actorId: 'stf_target', capability: 'staff.manage', count: 10, errorCode: 'AUTHORIZATION_DENIAL_SPIKE', threshold: 10 },
  },
  {
    id: 'act_backup_failed', kind: 'backup_failed', severity: 'critical',
    entityType: 'backup_run', entityId: 'bkp_failed_1',
    details: { backupId: 'bkp_failed_1', errorCode: 'BACKUP_FAILED' },
  },
  {
    id: 'act_backup_stale', kind: 'backup_stale', severity: 'critical',
    entityType: 'centre', entityId: 'centre_1',
    details: { errorCode: 'BACKUP_STALE', thresholdHours: 36 },
  },
  {
    id: 'act_outbox_dead', kind: 'outbox_job_failed', severity: 'critical',
    entityType: 'outbox_job', entityId: 'job_dead_1',
    details: { errorCode: 'OUTBOX_HANDLER_RETRY', jobId: 'job_dead_1', outboxType: 'staff.invitation.expire' },
  },
  {
    id: 'act_scheduler_stale', kind: 'scheduler_stale', severity: 'critical',
    entityType: 'scheduler_run', entityId: 'scheduler_run_1',
    details: { errorCode: 'SCHEDULER_STALE', schedulerRunId: 'scheduler_run_1', thresholdMinutes: 15 },
  },
]

const DENIAL_OVERFLOW_FACT = {
  id: 'act_denial_overflow',
  kind: 'authorization_denial_spike',
  severity: 'critical',
  entityType: 'centre',
  entityId: 'centre_1',
  details: {
    errorCode: 'AUTHORIZATION_DENIAL_OVERFLOW',
    minimumCount: 101,
    threshold: 100,
    windowMinutes: 15,
  },
}

const actionsBody = (facts = ACTION_FACTS, truncated = false) => ({
  data: {
    actions: facts.map((fact, index) => ({
      ...structuredClone(fact),
      version: 1,
      createdAt: new Date(Date.parse(OPERATIONS_NOW) - index).toISOString(),
      updatedAt: new Date(Date.parse(OPERATIONS_NOW) - index).toISOString(),
    })),
    truncated,
  },
})

const AUDIT_FACTS = [
  { action: 'authorization.denied', entityType: 'staff_user', entityId: 'stf_audit_target', result: 'denied', metadata: { version: 1 }, actorStaffId: 'stf_audit_actor' },
  { action: 'backup.pruned', entityType: 'backup_run', entityId: 'bkp_audit_pruned', result: 'success', metadata: { backupVersion: 2 }, actorStaffId: null },
  { action: 'data_key.rewrapped', entityType: 'data_key', entityId: 'key_audit', result: 'success', metadata: { newKekVersion: 2, oldKekVersion: 1 }, actorStaffId: 'stf_audit_actor' },
  { action: 'identity.activation', entityType: 'staff_user', entityId: 'stf_audit_target', result: 'success', metadata: { invitationVersion: 2, specialistVersion: 1, staffVersion: 2 }, actorStaffId: 'stf_audit_actor' },
  { action: 'identity.denied', entityType: 'staff_user', entityId: 'stf_audit_target', result: 'denied', metadata: { version: 2 }, actorStaffId: 'stf_audit_actor' },
  { action: 'identity.reindex', entityType: 'staff_invitation', entityId: 'inv_audit', result: 'success', metadata: { version: 2 }, actorStaffId: 'stf_audit_actor' },
  { action: 'operational_action.resolved', entityType: 'operational_action', entityId: 'act_audit', result: 'success', metadata: { actionVersion: 2 }, actorStaffId: 'stf_audit_actor' },
  { action: 'staff.access.reconciled', entityType: 'access_group', entityId: 'centre_1', result: 'success', metadata: { appliedGeneration: 2, desiredGeneration: 2, invitationCount: 0 }, actorStaffId: 'stf_audit_actor' },
  { action: 'staff.bootstrap', entityType: 'staff_user', entityId: 'stf_audit_target', result: 'success', metadata: { desiredGeneration: 1, invitationVersion: 1, specialistVersion: null, staffVersion: 1 }, actorStaffId: null },
  { action: 'staff.deactivated', entityType: 'staff_user', entityId: 'stf_audit_target', result: 'success', metadata: { desiredGeneration: 2, specialistVersion: 2, staffVersion: 2 }, actorStaffId: 'stf_audit_actor' },
  { action: 'staff.invitation.email_accepted', entityType: 'staff_invitation', entityId: 'inv_audit', result: 'success', metadata: { invitationVersion: 2 }, actorStaffId: 'stf_audit_actor' },
  { action: 'staff.invitation.expired', entityType: 'staff_invitation', entityId: 'inv_audit', result: 'success', metadata: { desiredGeneration: 2, invitationVersion: 2, specialistVersion: null, staffVersion: 2 }, actorStaffId: 'stf_audit_actor' },
  { action: 'staff.invited', entityType: 'staff_invitation', entityId: 'inv_audit', result: 'success', metadata: { desiredGeneration: 2, invitationVersion: 1, specialistVersion: 1, staffVersion: 1 }, actorStaffId: 'stf_audit_actor' },
  { action: 'specialist.backfilled', entityType: 'specialist', entityId: 'sp_audit_backfilled', result: 'success', metadata: { specialistVersion: 1, stateVersion: 2 }, actorStaffId: null },
  { action: 'core_directory.upgrade.advanced', entityType: 'system_state', entityId: 'core_directory_specialist_backfill_v1', result: 'success', metadata: { createdCount: 0, processedCount: 1, stateVersion: 2 }, actorStaffId: null },
]

const IDENTITY_AUDIT_ACTIONS = new Set([
  'identity.activation',
  'staff.bootstrap',
  'staff.deactivated',
  'staff.invitation.expired',
  'staff.invited',
])

const IDENTITY_AUDIT_FACTS = AUDIT_FACTS.filter(
  ({ action }) => IDENTITY_AUDIT_ACTIONS.has(action),
)

const auditBody = (facts = AUDIT_FACTS, nextCursor = null) => ({
  data: {
    events: facts.map((fact, index) => ({
      id: `audit_event_${String(999 - index).padStart(3, '0')}`,
      occurredAt: new Date(Date.parse(OPERATIONS_NOW) - index).toISOString(),
      ...structuredClone(fact),
      correlationId: `stored_correlation_${index}`,
    })),
    nextCursor,
  },
})

const assertDeepFrozen = (value) => {
  if (value === null || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertDeepFrozen(child)
}

const assertClientInput = (error) => {
  assert.ok(error instanceof ApiError)
  assert.equal(error.code, 'CLIENT_INPUT_INVALID')
  assert.equal(error.message, 'CLIENT_INPUT_INVALID')
  return true
}

const assertInvalidResponse = (error) => {
  assert.ok(error instanceof ApiError)
  assert.equal(error.code, 'INVALID_RESPONSE')
  assert.equal(error.message, 'INVALID_RESPONSE')
  return true
}

test('operations health and operational actions and security audit reads use exact same-origin requests', async () => {
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(healthBody()),
    jsonResponse(actionsBody()),
    jsonResponse(auditBody([])),
  )
  const client = createApiClient({ fetchImpl })

  await client.getOperationsHealth()
  await client.getOperationalActions()
  await client.getSecurityAudit()

  assert.deepEqual(calls.map(({ url }) => url), [
    '/api/v1/operations/health',
    '/api/v1/operations/actions',
    '/api/v1/security/audit',
  ])
  for (const call of calls) {
    assert.equal(call.init.method, 'GET')
    assert.equal(call.init.credentials, 'same-origin')
    assert.equal(header(call, 'Accept'), 'application/json')
    assert.equal(header(call, 'Content-Type'), null)
    assert.equal(header(call, 'X-CSRF-Token'), null)
    assert.equal(header(call, 'Idempotency-Key'), null)
    assert.equal(header(call, 'Authorization'), null)
    assert.equal(call.init.body, undefined)
  }
})

test('operations health projects and deeply freezes the exact four-check snapshot', async () => {
  const body = healthBody()
  const { fetchImpl } = queuedFetch(jsonResponse(body))
  const result = await createApiClient({ fetchImpl }).getOperationsHealth()

  assert.deepEqual(result, body.data)
  assert.notEqual(result, body.data)
  assert.notEqual(result.checks, body.data.checks)
  result.checks.forEach((check, index) => assert.notEqual(check, body.data.checks[index]))
  assertDeepFrozen(result)
})

test('operations health accepts the exact critical outbox drain states', async () => {
  for (const detailCode of ['OUTBOX_DRAIN_FAILED', 'OUTBOX_DRAIN_STALE']) {
    const body = healthBody()
    body.data.checks[0] = {
      ...body.data.checks[0],
      status: 'critical',
      detailCode,
    }
    const { fetchImpl } = queuedFetch(jsonResponse(body))

    const result = await createApiClient({ fetchImpl }).getOperationsHealth()

    assert.equal(result.checks[0].status, 'critical')
    assert.equal(result.checks[0].detailCode, detailCode)
    assertDeepFrozen(result)
  }
})

test('operations health rejects malformed envelopes, order, labels, pairs, times, and duplicate IDs', async (t) => {
  const cases = [
    ['extra outer key', (body) => { body.extra = true }],
    ['missing outer data', (body) => { delete body.data }],
    ['non-plain outer', (body) => Object.assign(Object.create({}), body)],
    ['extra inner key', (body) => { body.data.extra = true }],
    ['zero checks', (body) => { body.data.checks = [] }],
    ['reordered checks', (body) => { body.data.checks.reverse() }],
    ['wrong label', (body) => { body.data.checks[0].label = 'Kolejka' }],
    ['cross-paired detail', (body) => { body.data.checks[0].detailCode = 'BACKUP_FRESH' }],
    ['duplicate IDs', (body) => { body.data.checks[1].id = body.data.checks[0].id }],
    ['noncanonical generated time', (body) => { body.data.generatedAt = '2033-05-18T03:33:19Z' }],
    ['future last success', (body) => { body.data.checks[0].lastSuccessAt = '2033-05-18T03:33:20.000Z' }],
    ['extra check key', (body) => { body.data.checks[0].provider = 'private' }],
  ]
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      let body = healthBody()
      body = mutate(body) ?? body
      const { fetchImpl } = queuedFetch(parsedResponse(body))
      await assert.rejects(createApiClient({ fetchImpl }).getOperationsHealth(), assertInvalidResponse)
    })
  }

  await t.test('throwing envelope getter', async () => {
    const raw = 'health getter provider@example.test'
    const body = Object.defineProperty({}, 'data', { enumerable: true, get() { throw new Error(raw) } })
    const { fetchImpl } = queuedFetch({ ok: true, status: 200, json: async () => body })
    await assert.rejects(createApiClient({ fetchImpl }).getOperationsHealth(), (error) => {
      assertInvalidResponse(error)
      assert.doesNotMatch(JSON.stringify(error), /provider@example\.test|health getter/)
      return true
    })
  })
})

test('operational actions project and deeply freeze all six accepted kinds', async () => {
  const body = actionsBody()
  const { fetchImpl } = queuedFetch(jsonResponse(body))
  const result = await createApiClient({ fetchImpl }).getOperationalActions()

  assert.deepEqual(result, body.data)
  assert.notEqual(result, body.data)
  assert.notEqual(result.actions, body.data.actions)
  result.actions.forEach((action, index) => {
    assert.notEqual(action, body.data.actions[index])
    assert.notEqual(action.details, body.data.actions[index].details)
  })
  assertDeepFrozen(result)
})

test('operational actions accept and freeze a centre-scoped denial overflow spike', async () => {
  const { fetchImpl } = queuedFetch(jsonResponse(actionsBody([DENIAL_OVERFLOW_FACT])))

  const result = await createApiClient({ fetchImpl }).getOperationalActions()

  assert.deepEqual(result.actions[0], actionsBody([DENIAL_OVERFLOW_FACT]).data.actions[0])
  assertDeepFrozen(result)
})

test('operational actions reject malformed centre-scoped denial overflow spikes', async (t) => {
  const cases = [
    ['warning severity', (fact) => { fact.severity = 'warning' }],
    ['staff entity type', (fact) => { fact.entityType = 'staff_user' }],
    ['wrong centre', (fact) => { fact.entityId = 'centre_2' }],
    ['wrong error code', (fact) => { fact.details.errorCode = 'AUTHORIZATION_DENIAL_SPIKE' }],
    ['wrong minimum count', (fact) => { fact.details.minimumCount = 100 }],
    ['wrong threshold', (fact) => { fact.details.threshold = 101 }],
    ['wrong window', (fact) => { fact.details.windowMinutes = 14 }],
    ['extra detail', (fact) => { fact.details.count = 101 }],
    ['superseded count key', (fact) => {
      delete fact.details.minimumCount
      fact.details.countAtLeast = 101
    }],
  ]
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fact = structuredClone(DENIAL_OVERFLOW_FACT)
      mutate(fact)
      const { fetchImpl } = queuedFetch(parsedResponse(actionsBody([fact])))
      await assert.rejects(
        createApiClient({ fetchImpl }).getOperationalActions(),
        assertInvalidResponse,
      )
    })
  }
})

test('operational actions accept only the frozen ordinary and bounded unknown outbox combinations', async (t) => {
  const types = ['staff.access.reconcile', 'staff.invitation.email', 'staff.invitation.expire']
  const codes = ['OUTBOX_HANDLER_FAILURE', 'OUTBOX_HANDLER_RETRY', 'OUTBOX_LEASE_EXPIRED', 'EMAIL_DELIVERY_AMBIGUOUS']
  for (const outboxType of types) {
    for (const errorCode of codes) {
      await t.test(`${outboxType} ${errorCode}`, async () => {
        const fact = structuredClone(ACTION_FACTS[4])
        fact.details = { ...fact.details, errorCode, outboxType }
        const { fetchImpl } = queuedFetch(jsonResponse(actionsBody([fact])))
        assert.equal((await createApiClient({ fetchImpl }).getOperationalActions()).actions.length, 1)
      })
    }
  }
  await t.test('unknown bounded type with OUTBOX_TYPE_INVALID', async () => {
    const fact = structuredClone(ACTION_FACTS[4])
    fact.details = { ...fact.details, errorCode: 'OUTBOX_TYPE_INVALID', outboxType: 'future.ordinary-task' }
    const { fetchImpl } = queuedFetch(jsonResponse(actionsBody([fact])))
    assert.equal((await createApiClient({ fetchImpl }).getOperationalActions()).actions.length, 1)
  })
})

test('operational actions reject malformed shapes, relationships, dormant backup work, and invalid list invariants', async (t) => {
  const cases = [
    ['extra envelope key', (body) => { body.extra = 'ciphertext-private' }],
    ['non-plain data', (body) => { body.data = Object.assign(Object.create({}), body.data) }],
    ['extra action key', (body) => { body.data.actions[0].fingerprint = 'private' }],
    ['unknown kind', (body) => { body.data.actions[0].kind = 'future_action' }],
    ['wrong open version', (body) => { body.data.actions[0].version = 2 }],
    ['unequal timestamps', (body) => { body.data.actions[0].updatedAt = '2033-05-18T03:33:18.000Z' }],
    ['wrong severity', (body) => { body.data.actions[0].severity = 'warning' }],
    ['generation relationship', (body) => { body.data.actions[0].details.appliedGeneration = 3 }],
    ['denial actor mismatch', (body) => { body.data.actions[1].details.actorId = 'stf_other' }],
    ['denial capability', (body) => { body.data.actions[1].details.capability = 'finance.centre.read' }],
    ['backup id grammar', (body) => { body.data.actions[2].entityId = 'backup_1'; body.data.actions[2].details.backupId = 'backup_1' }],
    ['backup relationship', (body) => { body.data.actions[2].details.backupId = 'bkp_other' }],
    ['backup stale entity', (body) => { body.data.actions[3].entityId = 'centre_2' }],
    ['dormant backup outbox', (body) => { body.data.actions[4].details.outboxType = 'backup.create' }],
    ['known outbox invalid-type code', (body) => { body.data.actions[4].details.errorCode = 'OUTBOX_TYPE_INVALID' }],
    ['unknown outbox ordinary code', (body) => { body.data.actions[4].details.outboxType = 'future.task' }],
    ['scheduler relationship', (body) => { body.data.actions[5].details.schedulerRunId = 'run_other' }],
    ['extra details', (body) => { body.data.actions[0].details.provider = 'private' }],
    ['duplicate IDs', (body) => { body.data.actions[1].id = body.data.actions[0].id }],
    ['wrong order', (body) => { body.data.actions.reverse() }],
    ['truncated short list', (body) => { body.data.truncated = true }],
    ['nonboolean truncated', (body) => { body.data.truncated = 0 }],
  ]
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const body = actionsBody()
      mutate(body)
      const { fetchImpl } = queuedFetch(parsedResponse(body))
      await assert.rejects(createApiClient({ fetchImpl }).getOperationalActions(), assertInvalidResponse)
    })
  }

  await t.test('more than 100 actions', async () => {
    const facts = Array.from({ length: 101 }, (_, index) => ({ ...structuredClone(ACTION_FACTS[0]), id: `act_${String(999 - index).padStart(3, '0')}` }))
    const { fetchImpl } = queuedFetch(jsonResponse(actionsBody(facts)))
    await assert.rejects(createApiClient({ fetchImpl }).getOperationalActions(), assertInvalidResponse)
  })
  await t.test('exactly 100 actions may be truncated', async () => {
    const facts = Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(ACTION_FACTS[0]), id: `act_${String(999 - index).padStart(3, '0')}` }))
    const { fetchImpl } = queuedFetch(jsonResponse(actionsBody(facts, true)))
    assert.equal((await createApiClient({ fetchImpl }).getOperationalActions()).actions.length, 100)
  })
})

test('security audit builds URLSearchParams in cursor-limit order and validates public options before fetch', async (t) => {
  for (const [name, options, expectedUrl, count] of [
    ['neither', undefined, '/api/v1/security/audit', 0],
    ['cursor only', { cursor: AUDIT_CURSOR }, `/api/v1/security/audit?cursor=${AUDIT_CURSOR}`, 0],
    ['limit only', { limit: 1 }, '/api/v1/security/audit?limit=1', 1],
    ['both', { limit: 2, cursor: AUDIT_CURSOR }, `/api/v1/security/audit?cursor=${AUDIT_CURSOR}&limit=2`, 2],
  ]) {
    await t.test(name, async () => {
      const { calls, fetchImpl } = queuedFetch(jsonResponse(auditBody(Array.from({ length: count }, (_, index) => AUDIT_FACTS[index]))))
      await createApiClient({ fetchImpl }).getSecurityAudit(options)
      assert.equal(calls[0].url, expectedUrl)
    })
  }

  const hiddenAuditExtra = Object.defineProperty({}, 'extra', { value: true })
  const symbolicAuditExtra = { [Symbol('extra')]: true }
  const invalid = [
    null, [], Object.create({}), { extra: true }, { cursor: '' }, { cursor: ' v1.2.cG9z.MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM' },
    { cursor: `v01.2.cG9z.${'M'.repeat(43)}` }, { cursor: `v1.01.cG9z.${'M'.repeat(43)}` },
    { cursor: `v1.${Number.MAX_SAFE_INTEGER + 1}.cG9z.${'M'.repeat(43)}` },
    { cursor: `v1.2.cG9z=.${'M'.repeat(43)}` }, { cursor: `v1.2..${'M'.repeat(43)}` },
    { cursor: `v1.2.cG9z.${'M'.repeat(42)}` }, { cursor: `v1.2.${'A'.repeat(980)}.${'M'.repeat(43)}` },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '50' }, { limit: Number.MAX_SAFE_INTEGER },
    hiddenAuditExtra, symbolicAuditExtra,
  ]
  for (const options of invalid) {
    const { calls, fetchImpl } = queuedFetch()
    await assert.rejects(Promise.resolve().then(() => createApiClient({ fetchImpl }).getSecurityAudit(options)), assertClientInput)
    assert.equal(calls.length, 0)
  }

  await t.test('throwing getters and proxies are contained', async () => {
    const secret = 'audit cursor getter anna@example.test'
    const options = Object.defineProperty({}, 'cursor', { enumerable: true, get() { throw new Error(secret) } })
    const proxy = new Proxy({}, { ownKeys() { throw new Error(secret) } })
    for (const value of [options, proxy]) {
      const { calls, fetchImpl } = queuedFetch()
      await assert.rejects(Promise.resolve().then(() => createApiClient({ fetchImpl }).getSecurityAudit(value)), (error) => {
        assertClientInput(error)
        assert.doesNotMatch(JSON.stringify(error), /anna@example\.test|cursor getter/)
        return true
      })
      assert.equal(calls.length, 0)
    }
  })
})

test('security audit projects and deeply freezes all fifteen exact registry actions with opaque correlations', async () => {
  const body = auditBody()
  const { fetchImpl } = queuedFetch(jsonResponse(body))
  const result = await createApiClient({ fetchImpl }).getSecurityAudit({ limit: 50 })

  assert.deepEqual(result, body.data)
  assert.notEqual(result, body.data)
  assert.notEqual(result.events, body.data.events)
  result.events.forEach((event, index) => {
    assert.notEqual(event, body.data.events[index])
    assert.notEqual(event.metadata, body.data.events[index].metadata)
  })
  assert.equal(result.events[0].correlationId, 'stored_correlation_0')
  assertDeepFrozen(result)
})

test('security audit accepts every exact new identity metadata shape', async (t) => {
  for (const fact of IDENTITY_AUDIT_FACTS) {
    await t.test(fact.action, async () => {
      const body = auditBody([fact])
      const { fetchImpl } = queuedFetch(jsonResponse(body))

      const result = await createApiClient({ fetchImpl }).getSecurityAudit()

      assert.deepEqual(result.events[0].metadata, fact.metadata)
      assertDeepFrozen(result)
    })
  }
})

test('security audit normalizes every exact Phase 1 identity shape without mutating it', async (t) => {
  for (const fact of IDENTITY_AUDIT_FACTS) {
    await t.test(fact.action, async () => {
      const legacyFact = structuredClone(fact)
      delete legacyFact.metadata.specialistVersion
      const body = auditBody([legacyFact])
      const rawMetadata = structuredClone(body.data.events[0].metadata)
      const { fetchImpl } = queuedFetch(jsonResponse(body))

      const result = await createApiClient({ fetchImpl }).getSecurityAudit()

      assert.deepEqual(result.events[0].metadata, {
        ...legacyFact.metadata,
        specialistVersion: null,
      })
      assert.deepEqual(body.data.events[0].metadata, rawMetadata)
      assertDeepFrozen(result)
    })
  }
})

test('security audit rejects every mixed and extra-key identity metadata shape', async (t) => {
  for (const fact of IDENTITY_AUDIT_FACTS) {
    await t.test(fact.action, async () => {
      const legacyMetadata = structuredClone(fact.metadata)
      delete legacyMetadata.specialistVersion
      const mixedMetadata = structuredClone(fact.metadata)
      delete mixedMetadata[Object.keys(legacyMetadata)[0]]
      const malformed = [
        mixedMetadata,
        { ...legacyMetadata, unexpected: 1 },
        { ...fact.metadata, unexpected: 1 },
      ]

      for (const metadata of malformed) {
        const malformedFact = structuredClone(fact)
        malformedFact.metadata = metadata
        const { fetchImpl } = queuedFetch(jsonResponse(auditBody([malformedFact])))
        await assert.rejects(
          createApiClient({ fetchImpl }).getSecurityAudit(),
          assertInvalidResponse,
        )
      }
    })
  }
})

test('security audit accepts a valid cursor only on an exactly full page', async () => {
  const facts = Array.from({ length: 50 }, () => AUDIT_FACTS[0])
  const body = auditBody(facts, AUDIT_CURSOR)
  const { fetchImpl } = queuedFetch(jsonResponse(body))

  const result = await createApiClient({ fetchImpl }).getSecurityAudit({ limit: 50 })

  assert.equal(result.events.length, 50)
  assert.equal(result.nextCursor, AUDIT_CURSOR)
  assertDeepFrozen(result)
})

test('security audit rejects malformed registries, list invariants, and cursor presence violations', async (t) => {
  const cases = [
    ['extra envelope', (body) => { body.raw = 'provider-private' }],
    ['non-plain inner', (body) => { body.data = Object.assign(Object.create({}), body.data) }],
    ['extra event key', (body) => { body.data.events[0].email = 'private@example.test' }],
    ['unknown action', (body) => { body.data.events[0].action = 'future.unknown' }],
    ['wrong entity', (body) => { body.data.events[0].entityType = 'centre' }],
    ['wrong result', (body) => { body.data.events[0].result = 'success' }],
    ['invalid opaque correlation', (body) => { body.data.events[0].correlationId = 'bad correlation' }],
    ['duplicate IDs', (body) => { body.data.events[1].id = body.data.events[0].id }],
    ['wrong order', (body) => { body.data.events.reverse() }],
    ['extra metadata', (body) => { body.data.events[0].metadata.reason = 'private' }],
    ['zero version', (body) => { body.data.events[0].metadata.version = 0 }],
    ['fractional version', (body) => { body.data.events[0].metadata.version = 1.5 }],
    ['string version', (body) => { body.data.events[0].metadata.version = '1' }],
    ['negative count', (body) => { body.data.events[7].metadata.invitationCount = -1 }],
    ['invalid actor', (body) => { body.data.events[0].actorStaffId = 'actor space' }],
    ['short page with cursor', (body) => { body.data.nextCursor = AUDIT_CURSOR }],
    ['malformed next cursor', (body) => { body.data.events = Array.from({ length: 50 }, (_, index) => ({ ...body.data.events[0], id: `audit_${String(999 - index).padStart(3, '0')}`, occurredAt: new Date(Date.parse(OPERATIONS_NOW) - index).toISOString() })); body.data.nextCursor = 'opaque' }],
  ]
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const body = auditBody()
      mutate(body)
      const { fetchImpl } = queuedFetch(parsedResponse(body))
      await assert.rejects(createApiClient({ fetchImpl }).getSecurityAudit({ limit: 50 }), assertInvalidResponse)
    })
  }
  await t.test('more events than requested', async () => {
    const { fetchImpl } = queuedFetch(jsonResponse(auditBody(AUDIT_FACTS.slice(0, 2))))
    await assert.rejects(createApiClient({ fetchImpl }).getSecurityAudit({ limit: 1 }), assertInvalidResponse)
  })
})

test('security audit accepts both identity.reindex entities and rejects every malformed backup.pruned handoff', async (t) => {
  await t.test('identity.reindex staff user', async () => {
    const fact = { ...structuredClone(AUDIT_FACTS[5]), entityType: 'staff_user', entityId: 'stf_reindexed' }
    const { fetchImpl } = queuedFetch(jsonResponse(auditBody([fact])))
    assert.equal((await createApiClient({ fetchImpl }).getSecurityAudit()).events.length, 1)
  })
  const cases = [
    ['non-null actor', (event) => { event.actorStaffId = 'stf_actor' }],
    ['non-backup id', (event) => { event.entityId = 'run_backup' }],
    ['wrong entity', (event) => { event.entityType = 'centre' }],
    ['wrong result', (event) => { event.result = 'denied' }],
    ['missing backupVersion', (event) => { delete event.metadata.backupVersion }],
    ['zero backupVersion', (event) => { event.metadata.backupVersion = 0 }],
    ['fractional backupVersion', (event) => { event.metadata.backupVersion = 1.5 }],
    ['string backupVersion', (event) => { event.metadata.backupVersion = '2' }],
    ['extra backup metadata', (event) => { event.metadata.provider = 'private' }],
  ]
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const body = auditBody([AUDIT_FACTS[1]])
      mutate(body.data.events[0])
      const { fetchImpl } = queuedFetch(jsonResponse(body))
      await assert.rejects(createApiClient({ fetchImpl }).getSecurityAudit(), assertInvalidResponse)
    })
  }
})

test('operational resolution sends captured version, current CSRF, explicit key, and projects exact result', async () => {
  const response = { data: { action: { id: 'act_access_lag', status: 'resolved', version: 2, resolvedAt: OPERATIONS_NOW, updatedAt: OPERATIONS_NOW } } }
  const { calls, fetchImpl } = queuedFetch(jsonResponse(sessionBody()), jsonResponse(response))
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  const result = await client.resolveOperationalAction('act_access_lag', 1, { idempotencyKey: 'resolve-key-0001' })

  assert.deepEqual(result, response.data)
  assert.notEqual(result, response.data)
  assert.notEqual(result.action, response.data.action)
  assertDeepFrozen(result)
  const call = calls[1]
  assert.equal(call.url, '/api/v1/operations/actions/act_access_lag/resolution')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.credentials, 'same-origin')
  assert.equal(header(call, 'Accept'), 'application/json')
  assert.equal(header(call, 'Content-Type'), 'application/json')
  assert.equal(header(call, 'X-CSRF-Token'), TOKEN_A)
  assert.equal(header(call, 'Idempotency-Key'), 'resolve-key-0001')
  assert.equal(header(call, 'Authorization'), null)
  assert.equal(call.init.body, '{"version":1}')
})

test('operational resolution rejects public input access and malformed exact results before leaking data', async (t) => {
  const hiddenResolutionExtra = Object.defineProperty({ idempotencyKey: 'resolve-key-0001' }, 'extra', { value: true })
  const symbolicResolutionExtra = { idempotencyKey: 'resolve-key-0001', [Symbol('extra')]: true }
  const invalidInputs = [
    ['', 1, { idempotencyKey: 'resolve-key-0001' }],
    ['bad id', 1, { idempotencyKey: 'resolve-key-0001' }],
    ['act_ok', 0, { idempotencyKey: 'resolve-key-0001' }],
    ['act_ok', Number.MAX_SAFE_INTEGER, { idempotencyKey: 'resolve-key-0001' }],
    ['act_ok', 1, undefined],
    ['act_ok', 1, {}],
    ['act_ok', 1, { idempotencyKey: 'bad key' }],
    ['act_ok', 1, { idempotencyKey: 'resolve-key-0001', extra: true }],
    ['act_ok', 1, hiddenResolutionExtra],
    ['act_ok', 1, symbolicResolutionExtra],
  ]
  for (const args of invalidInputs) {
    const { calls, fetchImpl } = queuedFetch()
    await assert.rejects(Promise.resolve().then(() => createApiClient({ fetchImpl }).resolveOperationalAction(...args)), assertClientInput)
    assert.equal(calls.length, 0)
  }

  await t.test('throwing options getter', async () => {
    const secret = 'resolution getter ciphertext anna@example.test'
    const options = Object.defineProperty({}, 'idempotencyKey', { enumerable: true, get() { throw new Error(secret) } })
    const { calls, fetchImpl } = queuedFetch()
    await assert.rejects(Promise.resolve().then(() => createApiClient({ fetchImpl }).resolveOperationalAction('act_ok', 1, options)), (error) => {
      assertClientInput(error)
      assert.doesNotMatch(JSON.stringify(error), /ciphertext|anna@example\.test|resolution getter/)
      return true
    })
    assert.equal(calls.length, 0)
  })

  const valid = { data: { action: { id: 'act_ok', status: 'resolved', version: 2, resolvedAt: OPERATIONS_NOW, updatedAt: OPERATIONS_NOW } } }
  const malformed = [
    (body) => { body.extra = true },
    (body) => { body.data.extra = true },
    (body) => { body.data.action.extra = 'provider-private' },
    (body) => { body.data.action.id = 'act_other' },
    (body) => { body.data.action.status = 'open' },
    (body) => { body.data.action.version = 3 },
    (body) => { body.data.action.resolvedAt = '2033-05-18T03:33:19Z' },
    (body) => { body.data.action.updatedAt = '2033-05-18T03:33:18.000Z' },
  ]
  for (const mutate of malformed) {
    const body = structuredClone(valid)
    mutate(body)
    const { fetchImpl } = queuedFetch(jsonResponse(sessionBody()), jsonResponse(body))
    const client = createApiClient({ fetchImpl })
    await client.getSession()
    await assert.rejects(client.resolveOperationalAction('act_ok', 1, { idempotencyKey: 'resolve-key-0001' }), assertInvalidResponse)
  }
})

test('operational resolution retries exactly once after CSRF_EXPIRED with refreshed CSRF and the same key', async () => {
  const refreshed = sessionBody({ csrfToken: TOKEN_B, csrfExpiresAt: '2033-05-18T03:33:18.000Z' })
  const result = { data: { action: { id: 'act_ok', status: 'resolved', version: 2, resolvedAt: OPERATIONS_NOW, updatedAt: OPERATIONS_NOW } } }
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    errorResponse('CSRF_EXPIRED', 403),
    jsonResponse(refreshed),
    jsonResponse(result),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()
  await client.resolveOperationalAction('act_ok', 1, { idempotencyKey: 'resolve-key-0001' })

  assert.equal(calls.length, 4)
  assert.equal(calls[2].url, '/api/v1/session')
  assert.equal(header(calls[1], 'X-CSRF-Token'), TOKEN_A)
  assert.equal(header(calls[3], 'X-CSRF-Token'), TOKEN_B)
  assert.equal(header(calls[1], 'Idempotency-Key'), 'resolve-key-0001')
  assert.equal(header(calls[3], 'Idempotency-Key'), 'resolve-key-0001')
  assert.equal(calls.filter((call) => call.init.method === 'POST').length, 2)
})

test('operational resolution never retries network, malformed, VERSION_CONFLICT, or other non-CSRF outcomes', async (t) => {
  const outcomes = [
    ['network', new Error('provider email private@example.test'), 'NETWORK_ERROR', true],
    ['malformed', jsonResponse({ data: { action: { raw: 'ciphertext-private' } } }), 'INVALID_RESPONSE', true],
    ['version conflict', errorResponse('VERSION_CONFLICT', 409, { details: { currentVersion: 2, email: 'private@example.test' } }), 'VERSION_CONFLICT', false],
    ['forbidden', errorResponse('FORBIDDEN', 403), 'FORBIDDEN', false],
    ['server error', errorResponse('INTERNAL_ERROR', 500), 'INTERNAL_ERROR', true],
  ]
  for (const [name, outcome, code, retainsKey] of outcomes) {
    await t.test(name, async () => {
      const { calls, fetchImpl } = queuedFetch(jsonResponse(sessionBody()), outcome)
      const client = createApiClient({ fetchImpl })
      await client.getSession()
      await assert.rejects(client.resolveOperationalAction('act_ok', 1, { idempotencyKey: 'resolve-key-0001' }), (error) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, code)
        assert.equal(error.message, code)
        assert.equal(error.idempotencyKey, retainsKey ? 'resolve-key-0001' : undefined)
        if (code === 'VERSION_CONFLICT') assert.deepEqual(error.details, { currentVersion: 2 })
        assert.doesNotMatch(JSON.stringify(error), /private@example\.test|ciphertext-private|provider email/)
        return true
      })
      assert.equal(calls.length, 2)
      assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1)
    })
  }
})

test('operations health authentication denials clear session but FORBIDDEN preserves it', async () => {
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    errorResponse('FORBIDDEN', 403),
    errorResponse('ACCESS_DENIED', 403),
  )
  const client = createApiClient({ fetchImpl })
  const observed = []
  client.subscribeSession((session) => observed.push(session))
  await client.getSession()
  await assert.rejects(client.getOperationsHealth(), { code: 'FORBIDDEN' })
  assert.equal(observed.length, 1)
  await assert.rejects(client.getOperationsHealth(), { code: 'ACCESS_DENIED' })
  assert.deepEqual(observed, [publicSession(), null])
})

test('operations health and operational actions and security audit contain raw response secrets', async (t) => {
  const secret = 'provider-sentinel private@example.test ciphertext nonce bookmark'
  for (const [name, invoke] of [
    ['health', (client) => client.getOperationsHealth()],
    ['actions', (client) => client.getOperationalActions()],
    ['audit', (client) => client.getSecurityAudit({ cursor: AUDIT_CURSOR, limit: 50 })],
  ]) {
    await t.test(name, async () => {
      const payload = Object.defineProperty({}, 'data', { enumerable: true, get() { throw new Error(secret) } })
      const { fetchImpl } = queuedFetch({ ok: true, status: 200, json: async () => payload })
      await assert.rejects(invoke(createApiClient({ fetchImpl })), (error) => {
        assertInvalidResponse(error)
        assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'status'])
        assert.doesNotMatch(JSON.stringify(error), /provider-sentinel|private@example\.test|ciphertext|nonce|bookmark/)
        return true
      })
    })
  }
})

const changingProperty = (target, key, values, enumerable = true) => {
  let reads = 0
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable,
    get() {
      const value = values[Math.min(reads, values.length - 1)]
      reads += 1
      if (value instanceof Error) throw value
      return value
    },
  })
  return () => reads
}

test('operations health captures envelopes, arrays, checks, and scalar values exactly once', async (t) => {
  await t.test('outer data', async () => {
    const body = healthBody()
    const data = body.data
    const reads = changingProperty(body, 'data', [data, new Error('private second data read')])
    const { fetchImpl } = queuedFetch(parsedResponse(body))

    assert.deepEqual(await createApiClient({ fetchImpl }).getOperationsHealth(), data)
    assert.equal(reads(), 1)
  })

  await t.test('checks array', async () => {
    const body = healthBody()
    const checks = body.data.checks
    const reads = changingProperty(body.data, 'checks', [checks, new Error('private second checks read')])
    const { fetchImpl } = queuedFetch(parsedResponse(body))

    assert.deepEqual((await createApiClient({ fetchImpl }).getOperationsHealth()).checks, checks)
    assert.equal(reads(), 1)
  })

  await t.test('nested check scalar', async () => {
    const body = healthBody()
    const reads = changingProperty(body.data.checks[0], 'detailCode', [
      'OUTBOX_HEALTHY',
      'private-detail-sentinel',
    ])
    const { fetchImpl } = queuedFetch(parsedResponse(body))

    const result = await createApiClient({ fetchImpl }).getOperationsHealth()
    assert.equal(result.checks[0].detailCode, 'OUTBOX_HEALTHY')
    assert.equal(reads(), 1)
    assert.doesNotMatch(JSON.stringify(result), /private-detail-sentinel/)
  })
})

test('operational actions snapshot drifting arrays, rows, details, and non-enumerable fields', async (t) => {
  await t.test('zero-to-101 array length drift cannot bypass the bound', async () => {
    const facts = Array.from({ length: 101 }, (_, index) => ({
      ...structuredClone(ACTION_FACTS[0]),
      id: `act_drift_${String(999 - index).padStart(3, '0')}`,
    }))
    const body = actionsBody(facts)
    const actions = body.data.actions
    let lengthReads = 0
    body.data.actions = new Proxy(actions, {
      get(target, key, receiver) {
        if (key === 'length') {
          lengthReads += 1
          return lengthReads === 1 ? 0 : Reflect.get(target, key, receiver)
        }
        return Reflect.get(target, key, receiver)
      },
    })
    const { fetchImpl } = queuedFetch(parsedResponse(body))

    const result = await createApiClient({ fetchImpl }).getOperationalActions()
    assert.deepEqual(result, { actions: [], truncated: false })
    assert.equal(lengthReads, 1)
  })

  await t.test('detail scalar is validated and projected from one capture', async () => {
    const body = actionsBody([ACTION_FACTS[0]])
    const reads = changingProperty(body.data.actions[0].details, 'appliedGeneration', [
      2,
      'private-generation-sentinel',
    ])
    const { fetchImpl } = queuedFetch(parsedResponse(body))

    const result = await createApiClient({ fetchImpl }).getOperationalActions()
    assert.equal(result.actions[0].details.appliedGeneration, 2)
    assert.equal(reads(), 1)
    assert.doesNotMatch(JSON.stringify(result), /private-generation-sentinel/)
  })

  await t.test('required non-enumerable detail fields retain the exact projection', async () => {
    const body = actionsBody([ACTION_FACTS[2]])
    body.data.actions[0].details = Object.defineProperties({}, {
      backupId: { value: 'bkp_failed_1' },
      errorCode: { value: 'BACKUP_FAILED' },
    })
    const { fetchImpl } = queuedFetch(parsedResponse(body))

    const result = await createApiClient({ fetchImpl }).getOperationalActions()
    assert.deepEqual(result.actions[0].details, {
      backupId: 'bkp_failed_1',
      errorCode: 'BACKUP_FAILED',
    })
    assertDeepFrozen(result)
  })

  await t.test('revoked detail proxy is a fixed invalid response', async () => {
    const body = actionsBody([ACTION_FACTS[0]])
    const { proxy, revoke } = Proxy.revocable(body.data.actions[0].details, {})
    body.data.actions[0].details = proxy
    revoke()
    const { fetchImpl } = queuedFetch(parsedResponse(body))

    await assert.rejects(createApiClient({ fetchImpl }).getOperationalActions(), assertInvalidResponse)
  })
})

test('operational resolution captures the response action and stable error fields once', async (t) => {
  await t.test('resolved action scalar', async () => {
    const body = { data: { action: { id: 'act_ok', status: 'resolved', version: 2, resolvedAt: OPERATIONS_NOW, updatedAt: OPERATIONS_NOW } } }
    const reads = changingProperty(body.data.action, 'id', ['act_ok', 'private-action-sentinel'])
    const { fetchImpl } = queuedFetch(jsonResponse(sessionBody()), parsedResponse(body))
    const client = createApiClient({ fetchImpl })
    await client.getSession()

    const result = await client.resolveOperationalAction('act_ok', 1, { idempotencyKey: 'resolve-key-0001' })
    assert.equal(result.action.id, 'act_ok')
    assert.equal(reads(), 1)
    assert.doesNotMatch(JSON.stringify(result), /private-action-sentinel/)
  })

  await t.test('changing VERSION_CONFLICT details', async () => {
    const details = {}
    const detailReads = changingProperty(details, 'currentVersion', [2, 2, 'private-version-sentinel'])
    const error = { code: 'VERSION_CONFLICT', correlationId: CORRELATION_ID, details }
    const codeReads = changingProperty(error, 'code', [
      'VERSION_CONFLICT',
      'VERSION_CONFLICT',
      'private-code-sentinel',
    ])
    const payload = { error }
    const envelopeReads = changingProperty(payload, 'error', [
      error,
      { code: 'private-envelope-sentinel' },
    ])
    const { fetchImpl } = queuedFetch(jsonResponse(sessionBody()), parsedResponse(payload, 409))
    const client = createApiClient({ fetchImpl })
    await client.getSession()

    await assert.rejects(client.resolveOperationalAction('act_ok', 1, { idempotencyKey: 'resolve-key-0001' }), (caught) => {
      assert.equal(caught.code, 'VERSION_CONFLICT')
      assert.deepEqual(caught.details, { currentVersion: 2 })
      assert.doesNotMatch(JSON.stringify(caught), /private-(?:version|code|envelope)-sentinel/)
      return true
    })
    assert.equal(envelopeReads(), 1)
    assert.equal(codeReads(), 1)
    assert.equal(detailReads(), 1)
  })

  await t.test('throwing safe detail getter is contained without changing the stable error', async () => {
    const details = {}
    changingProperty(details, 'currentVersion', [new Error('private detail getter')])
    const payload = { error: { code: 'VERSION_CONFLICT', correlationId: CORRELATION_ID, details } }
    const { fetchImpl } = queuedFetch(jsonResponse(sessionBody()), parsedResponse(payload, 409))
    const client = createApiClient({ fetchImpl })
    await client.getSession()

    await assert.rejects(client.resolveOperationalAction('act_ok', 1, { idempotencyKey: 'resolve-key-0001' }), (caught) => {
      assert.equal(caught.code, 'VERSION_CONFLICT')
      assert.equal(caught.details, undefined)
      assert.doesNotMatch(JSON.stringify(caught), /private detail getter/)
      return true
    })
  })
})

test('security audit snapshots drifting arrays, event fields, and metadata values', async (t) => {
  await t.test('within-limit to over-limit array drift cannot bypass the bound', async () => {
    const facts = Array.from({ length: 51 }, () => AUDIT_FACTS[0])
    const body = auditBody(facts)
    const events = body.data.events
    let lengthReads = 0
    body.data.events = new Proxy(events, {
      get(target, key, receiver) {
        if (key === 'length') {
          lengthReads += 1
          return lengthReads === 1 ? 1 : Reflect.get(target, key, receiver)
        }
        return Reflect.get(target, key, receiver)
      },
    })
    const { fetchImpl } = queuedFetch(parsedResponse(body))

    const result = await createApiClient({ fetchImpl }).getSecurityAudit({ limit: 50 })
    assert.equal(result.events.length, 1)
    assert.equal(lengthReads, 1)
  })

  await t.test('event and metadata scalars use their validated captures', async () => {
    const body = auditBody([AUDIT_FACTS[0]])
    const correlationReads = changingProperty(body.data.events[0], 'correlationId', [
      'stored_correlation_0',
      'private-correlation-sentinel',
    ])
    const versionReads = changingProperty(body.data.events[0].metadata, 'version', [
      1,
      'private-metadata-sentinel',
    ])
    const { fetchImpl } = queuedFetch(parsedResponse(body))

    const result = await createApiClient({ fetchImpl }).getSecurityAudit()
    assert.equal(result.events[0].correlationId, 'stored_correlation_0')
    assert.deepEqual(result.events[0].metadata, { version: 1 })
    assert.equal(correlationReads(), 1)
    assert.equal(versionReads(), 1)
    assert.doesNotMatch(JSON.stringify(result), /private-(?:correlation|metadata)-sentinel/)
  })
})

test('security audit rejects noncanonical base64url aliases on input and response', async (t) => {
  const positionAlias = `v1.2.cG9zaXRpb25.${'M'.repeat(43)}`
  const macAlias = `v1.2.cG9zaXRpb24.${'M'.repeat(42)}N`
  for (const cursor of [positionAlias, macAlias]) {
    await t.test(`input ${cursor === positionAlias ? 'position' : 'mac'} alias`, async () => {
      const { calls, fetchImpl } = queuedFetch()
      await assert.rejects(createApiClient({ fetchImpl }).getSecurityAudit({ cursor }), assertClientInput)
      assert.equal(calls.length, 0)
    })

    await t.test(`response ${cursor === positionAlias ? 'position' : 'mac'} alias`, async () => {
      const facts = Array.from({ length: 50 }, () => AUDIT_FACTS[0])
      const { fetchImpl } = queuedFetch(jsonResponse(auditBody(facts, cursor)))
      await assert.rejects(
        createApiClient({ fetchImpl }).getSecurityAudit({ limit: 50 }),
        assertInvalidResponse,
      )
    })
  }
})

test('security audit ignores polluted inherited options and reads present own options once', async () => {
  const secret = 'private polluted option getter'
  Object.defineProperties(Object.prototype, {
    cursor: { configurable: true, get() { throw new Error(secret) } },
    limit: { configurable: true, get() { throw new Error(secret) } },
  })
  try {
    const options = {}
    const cursorReads = changingProperty(options, 'cursor', [AUDIT_CURSOR, new Error('private cursor reread')])
    const limitReads = changingProperty(options, 'limit', [1, new Error('private limit reread')])
    const { calls, fetchImpl } = queuedFetch(
      jsonResponse(auditBody([AUDIT_FACTS[0]])),
      jsonResponse(auditBody([])),
    )
    const client = createApiClient({ fetchImpl })

    await client.getSecurityAudit(options)
    await client.getSecurityAudit()

    assert.equal(calls[0].url, `/api/v1/security/audit?cursor=${AUDIT_CURSOR}&limit=1`)
    assert.equal(calls[1].url, '/api/v1/security/audit')
    assert.equal(cursorReads(), 1)
    assert.equal(limitReads(), 1)
  } finally {
    delete Object.prototype.cursor
    delete Object.prototype.limit
  }
})
