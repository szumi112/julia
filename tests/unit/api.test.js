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
