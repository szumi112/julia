import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { apiClient, ApiError, createApiClient } from '../../src/api.js'
import { isWellFormedUnicode, validateClientInput } from '../../src/core-records.js'
import { validateCreateClientBody } from '../../worker/core/clients.js'
import { capabilitiesForActor } from '../../worker/identity/policy.js'

const CORRELATION_ID = '77777777-7777-4777-8777-777777777777'
const TOKEN_A = 'v1.1999999999.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const TOKEN_B = 'v1.1999999998.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'
const coordinatorCapabilities = [
  'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
  'client.manage', 'client.operational.read', 'finance.centre.read',
  'operations.health.read', 'payment.manage', 'specialist.directory.read', 'tus.manage',
]

const sessionBody = (overrides = {}) => ({
  data: {
    actor: {
      id: 'stf_owner_1',
      displayName: 'Julia Właścicielka',
      role: 'owner',
      specialistId: null,
      version: 3,
    },
    capabilities: [
      'appointment.charge.read',
      'appointment.manage',
      'centre.manage',
      'chat.direct',
      'chat.general',
      'client.manage',
      'client.operational.read',
      'clinical.read',
      'finance.centre.manage',
      'finance.centre.read',
      'operations.health.read',
      'payment.manage',
      'security.audit.read',
      'specialist.directory.read',
      'staff.manage',
      'tus.manage',
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

const emptyWorkspaceBody = (from = '2026-08-01', to = '2026-08-31') => ({
  data: {
    window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
    specialists: [],
    clients: [],
    appointments: [],
  },
})

const fullWorkspaceBody = () => ({
  data: {
    window: {
      from: '2026-08-01',
      to: '2026-08-31',
      timeZone: 'Europe/Warsaw',
      complete: true,
    },
    specialists: [{
      id: 'sp_anna',
      displayName: 'Anna Żuraw',
      standardRateGrosze: 18000,
      status: 'active',
      version: 2,
      staffVersion: 3,
    }],
    clients: [{
      id: 'cl_ola',
      name: 'Ola Nowak',
      age: 12,
      status: 'active',
      version: 4,
      archivedAt: null,
      createdAt: '2026-07-01T08:00:00.000Z',
      updatedAt: '2026-08-10T12:00:00.000Z',
      readOnly: false,
      assignment: {
        id: 'asg_ola_anna',
        specialistId: 'sp_anna',
        startsAt: '2026-07-01T08:00:00.000Z',
        version: 1,
      },
    }],
    appointments: [{
      id: 'apt_ola_august',
      clientId: 'cl_ola',
      specialistId: 'sp_anna',
      serviceId: 'zajecia',
      startsAt: '2026-08-10T08:00:00.000Z',
      endsAt: '2026-08-10T08:50:00.000Z',
      timeZone: 'Europe/Warsaw',
      location: 'Gabinet 1',
      status: 'completed',
      source: 'panel',
      version: 4,
      cancelledAt: null,
      createdAt: '2026-08-01T08:00:00.000Z',
      updatedAt: '2026-08-10T12:00:00.000Z',
      charge: {
        id: 'chg_ola_august',
        serviceId: 'zajecia',
        expectedAmountGrosze: 18000,
        currency: 'PLN',
        version: 1,
      },
      payment: {
        status: 'paid',
        collectedGrosze: 18000,
        outstandingGrosze: 0,
        latestMethod: 'card',
        latestReceivedAt: '2026-08-10T11:00:00.000Z',
      },
      paymentEntries: [{
        id: 'pay_original',
        amountGrosze: 7000,
        method: 'cash',
        receivedAt: '2026-08-10T10:00:00.000Z',
        correctedAt: '2026-08-10T10:30:00.000Z',
        replacementEntryId: 'pay_replacement',
      }, {
        id: 'pay_replacement',
        amountGrosze: 18000,
        method: 'card',
        receivedAt: '2026-08-10T11:00:00.000Z',
        correctedAt: null,
        replacementEntryId: null,
      }],
    }],
  },
})

test('rejects invalid workspace windows without fetching and constructs the exact GET', async () => {
  assert.equal(typeof apiClient.loadWorkspaceWindow, 'function')
  const { calls, fetchImpl } = queuedFetch(jsonResponse(emptyWorkspaceBody()))
  const client = createApiClient({ fetchImpl })
  const hostile = Object.defineProperty({}, 'from', {
    enumerable: true,
    get() { throw new Error('private input') },
  })
  const invalid = [
    null,
    [],
    { from: '2026-08-01' },
    { from: '2026-08-01', to: '2026-08-31', extra: true },
    { from: '2026-8-01', to: '2026-08-31' },
    { from: '2026-02-29', to: '2026-03-01' },
    { from: '2026-08-02', to: '2026-08-01' },
    { from: '2026-01-01', to: '2026-04-04' },
    hostile,
  ]

  for (const options of invalid) {
    await assert.rejects(client.loadWorkspaceWindow(options), {
      code: 'CLIENT_INPUT_INVALID',
      message: 'CLIENT_INPUT_INVALID',
    })
  }
  assert.equal(calls.length, 0)

  assert.deepEqual(await client.loadWorkspaceWindow({
    from: '2026-08-01',
    to: '2026-08-31',
  }), emptyWorkspaceBody().data)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/v1/workspace?from=2026-08-01&to=2026-08-31')
  assert.deepEqual(calls[0].init, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  assert.equal(header(calls[0], 'Content-Type'), null)
  assert.equal(header(calls[0], 'X-CSRF-Token'), null)
  assert.equal(header(calls[0], 'Idempotency-Key'), null)
  assert.equal(Object.hasOwn(calls[0].init, 'body'), false)
})

test('captures workspace inputs without coercion or value access and never mutates them', async () => {
  let gets = 0
  let coercions = 0
  const hostileProxy = new Proxy({ from: '2026-08-01', to: '2026-08-31' }, {
    get() { gets += 1; throw new Error('input value trap') },
    ownKeys() { throw new Error('input descriptor trap') },
  })
  const coercible = {
    valueOf() { coercions += 1; return '2026-08-01' },
    toString() { coercions += 1; return '2026-08-01' },
  }
  const symbolInput = { from: '2026-08-01', to: '2026-08-31' }
  symbolInput[Symbol('extra')] = true
  const nonEnumerable = Object.defineProperties({}, {
    from: { value: '2026-08-01', enumerable: true },
    to: { value: '2026-08-31', enumerable: false },
  })
  const inherited = Object.create({ from: '2026-08-01', to: '2026-08-31' })
  const { calls, fetchImpl } = queuedFetch()
  const client = createApiClient({ fetchImpl })
  for (const options of [
    hostileProxy,
    { from: coercible, to: '2026-08-31' },
    symbolInput,
    nonEnumerable,
    inherited,
  ]) await assert.rejects(client.loadWorkspaceWindow(options), { code: 'CLIENT_INPUT_INVALID' })

  assert.equal(gets, 0)
  assert.equal(coercions, 0)
  assert.equal(calls.length, 0)
  assert.deepEqual(symbolInput.from, '2026-08-01')
  assert.equal(Reflect.ownKeys(symbolInput).length, 3)
})

test('accepts exactly 93 civil days and enforces Warsaw DST half-open appointment bounds', async () => {
  const dst = fullWorkspaceBody()
  dst.data.window = {
    from: '2026-03-29', to: '2026-03-29', timeZone: 'Europe/Warsaw', complete: true,
  }
  Object.assign(dst.data.clients[0], {
    createdAt: '2026-02-01T08:00:00.000Z',
    updatedAt: '2026-03-29T01:00:00.000Z',
  })
  dst.data.clients[0].assignment.startsAt = '2026-02-01T08:00:00.000Z'
  Object.assign(dst.data.appointments[0], {
    startsAt: '2026-03-28T23:00:00.000Z',
    endsAt: '2026-03-28T23:50:00.000Z',
    status: 'scheduled',
    createdAt: '2026-03-01T08:00:00.000Z',
    updatedAt: '2026-03-29T01:00:00.000Z',
  })
  dst.data.appointments[0].paymentEntries = []
  dst.data.appointments[0].payment = {
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
    latestMethod: null, latestReceivedAt: null,
  }
  const exact93 = emptyWorkspaceBody('2026-01-01', '2026-04-03')
  const { fetchImpl } = queuedFetch(parsedResponse(exact93), parsedResponse(dst))
  const client = createApiClient({ fetchImpl })
  assert.equal((await client.loadWorkspaceWindow({
    from: '2026-01-01', to: '2026-04-03',
  })).window.to, '2026-04-03')
  assert.equal((await client.loadWorkspaceWindow({
    from: '2026-03-29', to: '2026-03-29',
  })).appointments[0].startsAt, '2026-03-28T23:00:00.000Z')

  const upper = structuredClone(dst)
  upper.data.appointments[0].startsAt = '2026-03-29T22:00:00.000Z'
  upper.data.appointments[0].endsAt = '2026-03-29T22:50:00.000Z'
  const upperFetch = queuedFetch(parsedResponse(upper)).fetchImpl
  await assert.rejects(createApiClient({ fetchImpl: upperFetch }).loadWorkspaceWindow({
    from: '2026-03-29', to: '2026-03-29',
  }), { code: 'INVALID_RESPONSE' })
})

test('captures and deeply freezes a complete workspace response independently of its source', async () => {
  const source = fullWorkspaceBody()
  const { fetchImpl } = queuedFetch(parsedResponse(source))
  const result = await createApiClient({ fetchImpl }).loadWorkspaceWindow({
    from: '2026-08-01',
    to: '2026-08-31',
  })

  assert.deepEqual(result, source.data)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.window), true)
  assert.equal(Object.isFrozen(result.specialists), true)
  assert.equal(Object.isFrozen(result.specialists[0]), true)
  assert.equal(Object.isFrozen(result.clients[0].assignment), true)
  assert.equal(Object.isFrozen(result.appointments[0].charge), true)
  assert.equal(Object.isFrozen(result.appointments[0].payment), true)
  assert.equal(Object.isFrozen(result.appointments[0].paymentEntries), true)
  assert.equal(Object.isFrozen(result.appointments[0].paymentEntries[0]), true)

  source.data.clients[0].name = 'Zmienione źródło'
  source.data.appointments[0].paymentEntries[1].amountGrosze = 1
  assert.equal(result.clients[0].name, 'Ola Nowak')
  assert.equal(result.appointments[0].paymentEntries[1].amountGrosze, 18000)
})

test('workspace text rejects malformed Unicode and preserves valid astral pairs', async () => {
  const malformed = [
    '\uD800',
    '\uDFFF',
    'Anna\uD800',
    'An\uD800na',
    'Anna\uDFFF',
    'An\uDFFFna',
  ]
  const fields = [
    (body, value) => { body.data.specialists[0].displayName = value },
    (body, value) => { body.data.clients[0].name = value },
    (body, value) => { body.data.appointments[0].location = value },
  ]
  for (const value of malformed) {
    assert.equal(isWellFormedUnicode(value, { forceFallback: true }), false)
    for (const setValue of fields) {
      const body = fullWorkspaceBody()
      setValue(body, value)
      await rejectWorkspaceBody(body)
    }
  }

  assert.equal(isWellFormedUnicode('😀', { forceFallback: true }), true)
  const astral = fullWorkspaceBody()
  astral.data.specialists[0].displayName = 'Anna 😀'
  astral.data.clients[0].name = 'Ola 😀'
  astral.data.appointments[0].location = 'Gabinet 😀'
  const { fetchImpl } = queuedFetch(parsedResponse(astral))
  const result = await createApiClient({ fetchImpl }).loadWorkspaceWindow({
    from: '2026-08-01', to: '2026-08-31',
  })
  assert.equal(result.specialists[0].displayName, 'Anna 😀')
  assert.equal(result.clients[0].name, 'Ola 😀')
  assert.equal(result.appointments[0].location, 'Gabinet 😀')
})

const rejectWorkspaceBody = async (body) => {
  const { fetchImpl } = queuedFetch(parsedResponse(body))
  await assert.rejects(createApiClient({ fetchImpl }).loadWorkspaceWindow({
    from: '2026-08-01',
    to: '2026-08-31',
  }), (error) => error instanceof ApiError
    && error.code === 'INVALID_RESPONSE'
    && error.message === 'INVALID_RESPONSE'
    && error.status === 200)
}

const workspaceAt = (body, path) => path.reduce((value, key) => value[key], body)

test('rejects missing, extra, and wrong-typed workspace keys at every nesting level', async () => {
  const objectPaths = [
    [],
    ['data'],
    ['data', 'window'],
    ['data', 'specialists', 0],
    ['data', 'clients', 0],
    ['data', 'clients', 0, 'assignment'],
    ['data', 'appointments', 0],
    ['data', 'appointments', 0, 'charge'],
    ['data', 'appointments', 0, 'payment'],
    ['data', 'appointments', 0, 'paymentEntries', 0],
  ]
  for (const path of objectPaths) {
    const template = fullWorkspaceBody()
    const keys = Object.keys(workspaceAt(template, path))
    for (const key of keys) {
      const missing = fullWorkspaceBody()
      delete workspaceAt(missing, path)[key]
      await rejectWorkspaceBody(missing)

      const wrong = fullWorkspaceBody()
      workspaceAt(wrong, path)[key] = { invalid: true }
      await rejectWorkspaceBody(wrong)
    }
    const extra = fullWorkspaceBody()
    workspaceAt(extra, path).contact = 'private@example.test'
    await rejectWorkspaceBody(extra)
  }
})

test('rejects invalid specialist, client, assignment, and appointment scalar contracts', async () => {
  const cases = [
    (body) => { body.data.window.from = '2026-08-02' },
    (body) => { body.data.window.timeZone = 'UTC' },
    (body) => { body.data.window.complete = false },
    (body) => { body.data.specialists[0].id = 'staff_anna' },
    (body) => { body.data.specialists[0].displayName = ' Anna' },
    (body) => { body.data.specialists[0].displayName = 'A\u0000nna' },
    (body) => { body.data.specialists[0].standardRateGrosze = 1_000_001 },
    (body) => { body.data.specialists[0].status = 'pending' },
    (body) => { body.data.specialists[0].version = 0 },
    (body) => { body.data.specialists[0].staffVersion = 0 },
    (body) => { body.data.clients[0].id = 'client_ola' },
    (body) => { body.data.clients[0].name = 'Ola ' },
    (body) => { body.data.clients[0].age = 27 },
    (body) => { body.data.clients[0].status = 'deleted' },
    (body) => { body.data.clients[0].version = 1.5 },
    (body) => { body.data.clients[0].createdAt = '2026-07-01T08:00:00Z' },
    (body) => { body.data.clients[0].updatedAt = '2026-06-01T08:00:00.000Z' },
    (body) => { body.data.clients[0].archivedAt = '2026-08-01T00:00:00.000Z' },
    (body) => { body.data.clients[0].readOnly = true },
    (body) => { body.data.clients[0].assignment.id = 'assignment_1' },
    (body) => { body.data.clients[0].assignment.specialistId = 'sp_missing' },
    (body) => { body.data.clients[0].assignment.startsAt = '2026-06-01T08:00:00.000Z' },
    (body) => { body.data.clients[0].assignment.version = 0 },
    (body) => { body.data.appointments[0].id = 'appointment_1' },
    (body) => { body.data.appointments[0].clientId = 'cl_missing' },
    (body) => { body.data.appointments[0].specialistId = 'specialist_1' },
    (body) => { body.data.appointments[0].serviceId = 'unknown-service' },
    (body) => { body.data.appointments[0].startsAt = '2026-07-31T21:59:59.999Z' },
    (body) => { body.data.appointments[0].endsAt = body.data.appointments[0].startsAt },
    (body) => { body.data.appointments[0].timeZone = 'UTC' },
    (body) => { body.data.appointments[0].location = ' Gabinet' },
    (body) => { body.data.appointments[0].status = 'removed' },
    (body) => { body.data.appointments[0].source = 'import' },
    (body) => { body.data.appointments[0].version = 0 },
    (body) => { body.data.appointments[0].cancelledAt = '2026-08-10T09:00:00.000Z' },
    (body) => { body.data.appointments[0].createdAt = 'not-an-instant' },
    (body) => { body.data.appointments[0].updatedAt = '2026-07-01T00:00:00.000Z' },
    (body) => { body.data.appointments[0].charge.id = 'charge_1' },
    (body) => { body.data.appointments[0].charge.serviceId = 'plan' },
    (body) => { body.data.appointments[0].charge.expectedAmountGrosze = 0 },
    (body) => { body.data.appointments[0].charge.currency = 'EUR' },
    (body) => { body.data.appointments[0].charge.version = 0 },
  ]
  for (const mutate of cases) {
    const body = fullWorkspaceBody()
    mutate(body)
    await rejectWorkspaceBody(body)
  }
})

test('accepts archived and history-only clients exactly when referenced by an appointment', async () => {
  const archived = fullWorkspaceBody()
  Object.assign(archived.data.clients[0], {
    status: 'archived',
    archivedAt: '2026-08-10T12:00:00.000Z',
    readOnly: true,
    assignment: null,
  })
  const { fetchImpl } = queuedFetch(parsedResponse(archived))
  const result = await createApiClient({ fetchImpl }).loadWorkspaceWindow({
    from: '2026-08-01', to: '2026-08-31',
  })
  assert.equal(result.clients[0].readOnly, true)
  assert.equal(result.clients[0].assignment, null)

  const historyOnly = fullWorkspaceBody()
  historyOnly.data.clients[0].assignment = null
  const historyFetch = queuedFetch(parsedResponse(historyOnly)).fetchImpl
  assert.equal((await createApiClient({ fetchImpl: historyFetch }).loadWorkspaceWindow({
    from: '2026-08-01', to: '2026-08-31',
  })).clients[0].readOnly, false)

  for (const mutate of [
    (body) => { body.data.clients[0].status = 'archived'; body.data.clients[0].readOnly = true; body.data.clients[0].assignment = null },
    (body) => { body.data.clients[0].assignment = null },
  ]) {
    const body = fullWorkspaceBody()
    mutate(body)
    body.data.appointments = []
    await rejectWorkspaceBody(body)
  }
})

test('accepts a valid historical appointment specialist absent from the active directory', async () => {
  const body = fullWorkspaceBody()
  body.data.appointments[0].specialistId = 'sp_historical'
  const { fetchImpl } = queuedFetch(parsedResponse(body))
  const result = await createApiClient({ fetchImpl }).loadWorkspaceWindow({
    from: '2026-08-01', to: '2026-08-31',
  })
  assert.equal(result.appointments[0].specialistId, 'sp_historical')
})

test('recomputes payment aggregates and rejects incoherent correction relationships', async () => {
  const cases = [
    (body) => { body.data.appointments[0].paymentEntries[0].id = 'payment_1' },
    (body) => { body.data.appointments[0].paymentEntries[0].amountGrosze = 0 },
    (body) => { body.data.appointments[0].paymentEntries[0].method = 'crypto' },
    (body) => { body.data.appointments[0].paymentEntries[0].receivedAt = '2026-08-10' },
    (body) => { body.data.appointments[0].paymentEntries[0].correctedAt = null },
    (body) => { body.data.appointments[0].paymentEntries[0].replacementEntryId = 'pay_missing' },
    (body) => { body.data.appointments[0].paymentEntries[0].replacementEntryId = 'pay_original' },
    (body) => { body.data.appointments[0].paymentEntries[1].replacementEntryId = 'pay_original'; body.data.appointments[0].paymentEntries[1].correctedAt = '2026-08-10T11:30:00.000Z' },
    (body) => { body.data.appointments[0].payment.status = 'partial' },
    (body) => { body.data.appointments[0].payment.collectedGrosze = 7000 },
    (body) => { body.data.appointments[0].payment.outstandingGrosze = 1 },
    (body) => { body.data.appointments[0].payment.latestMethod = 'cash' },
    (body) => { body.data.appointments[0].payment.latestReceivedAt = null },
    (body) => { body.data.appointments[0].paymentEntries.reverse() },
  ]
  for (const mutate of cases) {
    const body = fullWorkspaceBody()
    mutate(body)
    await rejectWorkspaceBody(body)
  }

  for (const status of ['scheduled', 'cancelled']) {
    const body = fullWorkspaceBody()
    Object.assign(body.data.appointments[0], {
      status,
      cancelledAt: status === 'cancelled' ? '2026-08-10T12:00:00.000Z' : null,
    })
    await rejectWorkspaceBody(body)
  }
})

test('workspace appointment lifecycle versions account for charges, payments, and corrections', async () => {
  const edited = fullWorkspaceBody()
  const editedAppointment = edited.data.appointments[0]
  editedAppointment.version = 6
  editedAppointment.charge.version = 2
  editedAppointment.paymentEntries = [{
    id: 'pay_chain_original', amountGrosze: 7_000, method: 'cash',
    receivedAt: '2026-08-10T09:00:00.000Z',
    correctedAt: '2026-08-10T10:00:00.000Z',
    replacementEntryId: 'pay_chain_first',
  }, {
    id: 'pay_chain_first', amountGrosze: 8_000, method: 'card',
    receivedAt: '2026-08-10T10:00:00.000Z',
    correctedAt: '2026-08-10T11:00:00.000Z',
    replacementEntryId: 'pay_chain_second',
  }, {
    id: 'pay_chain_second', amountGrosze: 18_000, method: 'transfer',
    receivedAt: '2026-08-10T11:00:00.000Z', correctedAt: null,
    replacementEntryId: null,
  }]
  editedAppointment.payment = {
    status: 'paid', collectedGrosze: 18_000, outstandingGrosze: 0,
    latestMethod: 'transfer', latestReceivedAt: '2026-08-10T11:00:00.000Z',
  }
  const accepted = queuedFetch(parsedResponse(edited))
  const result = await createApiClient({ fetchImpl: accepted.fetchImpl }).loadWorkspaceWindow({
    from: '2026-08-01', to: '2026-08-31',
  })
  assert.equal(result.appointments[0].version, 6)
  assert.equal(result.appointments[0].charge.version, 2)

  const invalid = [
    (body) => {
      const appointment = body.data.appointments[0]
      appointment.version = 2
      appointment.charge.version = 257
      appointment.paymentEntries = []
      appointment.payment = {
        status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
        latestMethod: null, latestReceivedAt: null,
      }
    },
    (body) => { body.data.appointments[0].version = 2 },
    (body) => {
      const appointment = body.data.appointments[0]
      appointment.version = 1
      appointment.charge.version = 1
      appointment.paymentEntries = []
      appointment.payment = {
        status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
        latestMethod: null, latestReceivedAt: null,
      }
    },
    (body) => {
      const appointment = body.data.appointments[0]
      appointment.version = 1
      appointment.charge.version = 1
      appointment.status = 'cancelled'
      appointment.cancelledAt = appointment.updatedAt
      appointment.paymentEntries = []
      appointment.payment = {
        status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
        latestMethod: null, latestReceivedAt: null,
      }
    },
  ]
  for (const mutate of invalid) {
    const body = fullWorkspaceBody()
    mutate(body)
    await rejectWorkspaceBody(body)
  }

  const equalChronology = structuredClone(edited)
  equalChronology.data.appointments[0].paymentEntries[0].correctedAt =
    equalChronology.data.appointments[0].paymentEntries[1].correctedAt
  await rejectWorkspaceBody(equalChronology)
})

test('rejects duplicate IDs and noncanonical directory and appointment ordering', async () => {
  const cases = [
    (body) => { body.data.specialists.push(structuredClone(body.data.specialists[0])) },
    (body) => { body.data.clients.push(structuredClone(body.data.clients[0])) },
    (body) => { body.data.appointments.push(structuredClone(body.data.appointments[0])) },
    (body) => {
      const second = structuredClone(body.data.appointments[0])
      second.id = 'apt_second'; second.charge.id = body.data.appointments[0].charge.id
      second.paymentEntries = []; second.payment = { status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18000, latestMethod: null, latestReceivedAt: null }
      body.data.appointments.push(second)
    },
    (body) => {
      const second = structuredClone(body.data.appointments[0])
      second.id = 'apt_second'; second.charge.id = 'chg_second'
      second.paymentEntries[0].id = 'pay_other'; second.paymentEntries[0].replacementEntryId = 'pay_replacement'
      body.data.appointments.push(second)
    },
    (body) => {
      const second = structuredClone(body.data.specialists[0])
      second.id = 'sp_aaron'; second.displayName = 'Aarón'
      body.data.specialists.push(second)
    },
    (body) => {
      const second = structuredClone(body.data.clients[0])
      second.id = 'cl_ania'; second.name = 'Ania'; second.assignment.id = 'asg_ania'
      body.data.clients.push(second)
    },
    (body) => {
      const second = structuredClone(body.data.appointments[0])
      second.id = 'apt_earlier'; second.charge.id = 'chg_earlier'
      second.startsAt = '2026-08-09T08:00:00.000Z'; second.endsAt = '2026-08-09T08:50:00.000Z'
      second.paymentEntries = []; second.payment = { status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18000, latestMethod: null, latestReceivedAt: null }
      body.data.appointments.push(second)
    },
  ]
  for (const mutate of cases) {
    const body = fullWorkspaceBody()
    mutate(body)
    await rejectWorkspaceBody(body)
  }
})

const unpaidAppointment = (index) => {
  const appointment = structuredClone(fullWorkspaceBody().data.appointments[0])
  const suffix = String(index).padStart(4, '0')
  appointment.id = `apt_${suffix}`
  appointment.charge.id = `chg_${suffix}`
  appointment.paymentEntries = []
  appointment.payment = {
    status: 'unpaid',
    collectedGrosze: 0,
    outstandingGrosze: 18000,
    latestMethod: null,
    latestReceivedAt: null,
  }
  return appointment
}

test('accepts every workspace cap boundary and rejects overflow without truncation', async () => {
  const boundaryBodies = []

  const specialists = fullWorkspaceBody()
  specialists.data.specialists = Array.from({ length: 50 }, (_, index) => ({
    ...structuredClone(specialists.data.specialists[0]),
    id: `sp_${String(index).padStart(3, '0')}`,
    displayName: 'Anna',
  }))
  specialists.data.clients[0].assignment.specialistId = 'sp_000'
  specialists.data.appointments[0].specialistId = 'sp_000'
  boundaryBodies.push(specialists)

  const clients = fullWorkspaceBody()
  clients.data.clients = Array.from({ length: 1_000 }, (_, index) => {
    const client = structuredClone(clients.data.clients[0])
    const suffix = String(index).padStart(3, '0')
    client.id = `cl_${suffix}`
    client.name = 'Ola'
    client.assignment.id = `asg_${suffix}`
    return client
  })
  clients.data.appointments[0].clientId = 'cl_000'
  boundaryBodies.push(clients)

  const appointments = fullWorkspaceBody()
  appointments.data.appointments = Array.from({ length: 500 }, (_, index) => (
    unpaidAppointment(index)
  ))
  boundaryBodies.push(appointments)

  const payments = fullWorkspaceBody()
  const paymentEntries = Array.from({ length: 1_000 }, (_, index) => ({
    id: `pay_${String(index).padStart(4, '0')}`,
    amountGrosze: 1,
    method: 'cash',
    receivedAt: '2026-08-10T11:00:00.000Z',
    correctedAt: null,
    replacementEntryId: null,
  }))
  Object.assign(payments.data.appointments[0].charge, { expectedAmountGrosze: 1_000 })
  payments.data.appointments[0].version = 1_001
  payments.data.appointments[0].paymentEntries = paymentEntries
  payments.data.appointments[0].payment = {
    status: 'paid', collectedGrosze: 1_000, outstandingGrosze: 0,
    latestMethod: 'cash', latestReceivedAt: '2026-08-10T11:00:00.000Z',
  }
  boundaryBodies.push(payments)

  for (const body of boundaryBodies) {
    const { fetchImpl } = queuedFetch(parsedResponse(body))
    const result = await createApiClient({ fetchImpl }).loadWorkspaceWindow({
      from: '2026-08-01', to: '2026-08-31',
    })
    assert.equal(result.specialists.length, body.data.specialists.length)
    assert.equal(result.clients.length, body.data.clients.length)
    assert.equal(result.appointments.length, body.data.appointments.length)
    assert.equal(result.appointments.reduce(
      (sum, appointment) => sum + appointment.paymentEntries.length, 0,
    ), body.data.appointments.reduce(
      (sum, appointment) => sum + appointment.paymentEntries.length, 0,
    ))
  }

  const overflows = [
    (() => {
      const body = structuredClone(specialists)
      body.data.specialists.push({ ...body.data.specialists.at(-1), id: 'sp_999' })
      return body
    })(),
    (() => {
      const body = structuredClone(clients)
      const next = { ...body.data.clients.at(-1), id: 'cl_1000', assignment: {
        ...body.data.clients.at(-1).assignment, id: 'asg_1000',
      } }
      body.data.clients.push(next)
      return body
    })(),
    (() => {
      const body = structuredClone(appointments)
      body.data.appointments.push(unpaidAppointment(9999))
      return body
    })(),
    (() => {
      const body = structuredClone(payments)
      body.data.appointments[0].charge.expectedAmountGrosze = 1_001
      body.data.appointments[0].payment.collectedGrosze = 1_001
      body.data.appointments[0].paymentEntries.push({
        ...body.data.appointments[0].paymentEntries.at(-1), id: 'pay_9999',
      })
      return body
    })(),
  ]
  for (const body of overflows) await rejectWorkspaceBody(body)

  const distributed = fullWorkspaceBody()
  const first = unpaidAppointment(0)
  const second = unpaidAppointment(1)
  const entriesFor = (start, count) => Array.from({ length: count }, (_, offset) => ({
    id: `pay_${String(start + offset).padStart(4, '0')}`,
    amountGrosze: 1,
    method: 'cash',
    receivedAt: '2026-08-10T11:00:00.000Z',
    correctedAt: null,
    replacementEntryId: null,
  }))
  first.charge.expectedAmountGrosze = 600
  first.version = 601
  first.paymentEntries = entriesFor(0, 600)
  first.payment = { status: 'paid', collectedGrosze: 600, outstandingGrosze: 0,
    latestMethod: 'cash', latestReceivedAt: '2026-08-10T11:00:00.000Z' }
  second.charge.expectedAmountGrosze = 401
  second.version = 402
  second.paymentEntries = entriesFor(600, 401)
  second.payment = { status: 'paid', collectedGrosze: 401, outstandingGrosze: 0,
    latestMethod: 'cash', latestReceivedAt: '2026-08-10T11:00:00.000Z' }
  distributed.data.appointments = [first, second]
  await rejectWorkspaceBody(distributed)
})

test('contains hostile workspace descriptors, arrays, prototypes, proxies, and accessors', async () => {
  const hostileBodies = []

  const getter = fullWorkspaceBody()
  Object.defineProperty(getter.data.clients[0], 'name', {
    enumerable: true,
    get() { throw new Error('fictional client private getter') },
  })
  hostileBodies.push(getter)

  const hidden = fullWorkspaceBody()
  Object.defineProperty(hidden.data.clients[0], 'name', {
    value: hidden.data.clients[0].name,
    enumerable: false,
  })
  hostileBodies.push(hidden)

  const symbol = fullWorkspaceBody()
  symbol.data.appointments[0][Symbol('private')] = 'not accepted'
  hostileBodies.push(symbol)

  const sparse = fullWorkspaceBody()
  delete sparse.data.appointments[0].paymentEntries[0]
  hostileBodies.push(sparse)

  const arrayProperty = fullWorkspaceBody()
  arrayProperty.data.clients.privateData = true
  hostileBodies.push(arrayProperty)

  const arrayAccessor = fullWorkspaceBody()
  Object.defineProperty(arrayAccessor.data.specialists, '0', {
    enumerable: true,
    get() { throw new Error('directory getter') },
  })
  hostileBodies.push(arrayAccessor)

  const prototype = fullWorkspaceBody()
  Object.setPrototypeOf(prototype.data.appointments[0].charge, { inherited: true })
  hostileBodies.push(prototype)

  const proxy = fullWorkspaceBody()
  proxy.data.clients[0] = new Proxy(proxy.data.clients[0], {
    ownKeys() { throw new Error('proxy trap detail') },
  })
  hostileBodies.push(proxy)

  for (const body of hostileBodies) await rejectWorkspaceBody(body)
})

test('sanitizes workspace server, network, response, and validator failures', async () => {
  const throwingResponse = {}
  Object.defineProperty(throwingResponse, 'status', {
    get() { throw new Error('provider response secret') },
  })
  const throwingPayload = {}
  Object.defineProperty(throwingPayload, 'data', {
    enumerable: true,
    get() { throw new Error('fictional client secret') },
  })
  const failures = [
    new Error('network provider secret'),
    throwingResponse,
    parsedResponse(throwingPayload),
    parsedResponse({ error: { code: 'UNKNOWN_PRIVATE_CODE', correlationId: CORRELATION_ID } }, 500),
    parsedResponse({ error: {
      code: 'INTERNAL_ERROR',
      correlationId: CORRELATION_ID,
      details: { sql: 'SELECT fictional_private_name' },
    } }, 500),
  ]
  for (const response of failures) {
    const { fetchImpl } = queuedFetch(response)
    let error
    try {
      await createApiClient({ fetchImpl }).loadWorkspaceWindow({
        from: '2026-08-01', to: '2026-08-31',
      })
      assert.fail('workspace failure must reject')
    } catch (caught) {
      error = caught
    }
    assert.equal(error instanceof ApiError, true)
    assert.equal(['NETWORK_ERROR', 'INVALID_RESPONSE', 'INTERNAL_ERROR'].includes(error.code), true)
    const exposed = JSON.stringify(error)
    assert.equal(exposed.includes('secret'), false)
    assert.equal(exposed.includes('fictional_private_name'), false)
    assert.equal(exposed.includes('from='), false)
    assert.equal(error.message, error.code)
  }
})

test('performs independent uncached workspace GETs without changing session or mutation state', async () => {
  const invitationResult = {
    data: { staff: staff({ status: 'pending' }), invitation },
  }
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    parsedResponse(emptyWorkspaceBody()),
    parsedResponse({ data: null }),
    parsedResponse(emptyWorkspaceBody()),
    jsonResponse(invitationResult, 201),
  )
  let generated = 0
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => { generated += 1; return 'generated-key-0001' },
  })
  await client.getSession()
  const options = Object.freeze({ from: '2026-08-01', to: '2026-08-31' })
  await client.loadWorkspaceWindow(options)
  await assert.rejects(client.loadWorkspaceWindow(options), { code: 'INVALID_RESPONSE' })
  await client.loadWorkspaceWindow(options)
  await client.inviteStaff({
    displayName: 'Anna', email: 'anna@example.test', role: 'specialist',
  }, { idempotencyKey: 'workspace-state-key-0001' })

  assert.equal(calls.length, 5)
  assert.deepEqual(calls.slice(1, 4).map((call) => call.url), [
    '/api/v1/workspace?from=2026-08-01&to=2026-08-31',
    '/api/v1/workspace?from=2026-08-01&to=2026-08-31',
    '/api/v1/workspace?from=2026-08-01&to=2026-08-31',
  ])
  assert.equal(generated, 0)
  assert.equal(header(calls[4], 'X-CSRF-Token'), TOKEN_A)
  assert.equal(header(calls[4], 'Idempotency-Key'), 'workspace-state-key-0001')
  assert.equal(calls.slice(1, 4).some((call) => header(call, 'X-CSRF-Token') !== null), false)
  assert.equal(calls.slice(1, 4).some((call) => header(call, 'Idempotency-Key') !== null), false)
  assert.equal(calls.slice(1, 4).some((call) => Object.hasOwn(call.init, 'body')), false)
  assert.equal(JSON.stringify(options), '{"from":"2026-08-01","to":"2026-08-31"}')
})

test('creates, edits, and targets an invitation at one stable specialist profile', async () => {
  const createdAt = '2026-08-27T12:00:00.000Z'
  const created = {
    data: { specialist: {
      id: 'sp_anna_profile', displayName: 'Anna Janowska',
      standardRateGrosze: 18000, status: 'active', version: 1,
      accessStatus: 'unclaimed', createdAt, updatedAt: createdAt,
    } },
  }
  const updatedAt = '2026-08-27T12:01:00.000Z'
  const edited = {
    data: { specialist: {
      ...created.data.specialist,
      displayName: 'Anna Janowska-Kowalska',
      standardRateGrosze: 19000,
      version: 2,
      staffVersion: null,
      updatedAt,
    } },
  }
  const invited = {
    data: {
      staff: staff({
        id: 'stf_anna_profile', displayName: 'Anna Janowska-Kowalska',
        email: 'anna-j@gmail.com', status: 'pending', version: 1,
        specialistId: 'sp_anna_profile',
      }),
      invitation,
    },
  }
  const queued = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse(created, 201),
    jsonResponse(edited),
    jsonResponse(invited, 201),
  )
  const client = createApiClient({ fetchImpl: queued.fetchImpl })
  await client.getSession()
  await client.createSpecialistProfile({
    displayName: 'Anna Janowska', standardRateGrosze: 18000,
  }, { idempotencyKey: 'specialist-create-api-0001' })
  await client.updateSpecialistProfile('sp_anna_profile', 1, {
    displayName: 'Anna Janowska-Kowalska', standardRateGrosze: 19000,
  }, { idempotencyKey: 'specialist-edit-api-0001' })
  await client.inviteSpecialistProfile('sp_anna_profile', {
    email: 'anna-j@gmail.com', expectedVersion: 2,
  }, { idempotencyKey: 'specialist-invite-api-0001' })

  assert.deepEqual(queued.calls.slice(1).map(({ url, init }) => ({
    body: init.body,
    key: header({ init }, 'Idempotency-Key'),
    method: init.method,
    url,
  })), [
    {
      body: '{"displayName":"Anna Janowska","standardRateGrosze":18000}',
      key: 'specialist-create-api-0001', method: 'POST', url: '/api/v1/specialists',
    },
    {
      body: '{"expectedVersion":1,"displayName":"Anna Janowska-Kowalska","standardRateGrosze":19000}',
      key: 'specialist-edit-api-0001', method: 'POST',
      url: '/api/v1/specialists/sp_anna_profile/edits',
    },
    {
      body: '{"email":"anna-j@gmail.com","expectedVersion":2}',
      key: 'specialist-invite-api-0001', method: 'POST',
      url: '/api/v1/specialists/sp_anna_profile/invitations',
    },
  ])
})

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
      version: 4,
    },
    capabilities: coordinatorCapabilities,
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
      version: 4,
    },
    capabilities: coordinatorCapabilities,
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

test('requires and freezes the exact positive authority revision actor shape', async () => {
  const accepted = sessionBody()
  const { fetchImpl } = queuedFetch(jsonResponse(accepted))
  const session = await createApiClient({ fetchImpl }).getSession()
  assert.equal(session.actor.version, 3)
  assert.equal(Object.isFrozen(session.actor), true)
  assert.deepEqual(Reflect.ownKeys(session.actor).sort(), ['displayName', 'id', 'role', 'specialistId', 'version'])

  const boundaryActor = {
    id: `stf_${'a'.repeat(124)}`,
    displayName: 'Anna Graniczna',
    role: 'specialist',
    specialistId: `sp_${'a'.repeat(125)}`,
    version: 1,
  }
  const boundary = queuedFetch(jsonResponse(sessionBody({
    actor: boundaryActor,
    capabilities: [...capabilitiesForActor(boundaryActor)],
  })))
  assert.deepEqual((await createApiClient({ fetchImpl: boundary.fetchImpl }).getSession()).actor, boundaryActor)

  for (const mutate of [
    (actor) => { delete actor.version },
    (actor) => { actor.version = 0 },
    (actor) => { actor.version = 1.5 },
    (actor) => { actor.extra = true },
    (actor) => { actor.id = 'sp_owner' },
    (actor) => { actor.id = `stf_${'a'.repeat(125)}` },
    (actor) => { actor.specialistId = 'stf_profile' },
    (actor) => { actor.specialistId = `sp_${'a'.repeat(126)}` },
  ]) {
    const body = structuredClone(sessionBody())
    mutate(body.data.actor)
    const queued = queuedFetch(jsonResponse(body))
    await assert.rejects(createApiClient({ fetchImpl: queued.fetchImpl }).getSession(), {
      code: 'INVALID_RESPONSE', message: 'INVALID_RESPONSE', status: 200,
    })
  }
})

test('keeps browser session role registries byte-for-byte equal to Worker policy', async () => {
  const actors = [
    { id: 'stf_owner_1', displayName: 'Ola', role: 'owner', specialistId: 'sp_owner', version: 2 },
    { id: 'stf_coord_1', displayName: 'Ela', role: 'coordinator', specialistId: null, version: 3 },
    { id: 'stf_spec_1', displayName: 'Anna', role: 'specialist', specialistId: 'sp_spec', version: 4 },
  ]
  for (const actor of actors) {
    const capabilities = [...capabilitiesForActor(actor)]
    const body = sessionBody({ actor, capabilities })
    const queued = queuedFetch(jsonResponse(body))
    const session = await createApiClient({ fetchImpl: queued.fetchImpl }).getSession()
    assert.deepEqual(session.capabilities, capabilities)
    assert.equal(Object.isFrozen(session.capabilities), true)

    const reordered = sessionBody({ actor, capabilities: [...capabilities].reverse() })
    const invalid = queuedFetch(jsonResponse(reordered))
    await assert.rejects(createApiClient({ fetchImpl: invalid.fetchImpl }).getSession(), {
      code: 'INVALID_RESPONSE', message: 'INVALID_RESPONSE', status: 200,
    })
  }
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

test('exposes only code-specific stable error fields', async () => {
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
    assert.deepEqual(error.details, { field: 'email' })
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
  { action: 'client.created', entityType: 'client', entityId: 'cl_audit_created', result: 'success', metadata: { clientVersion: 1, assignmentId: 'asg_audit_created', assignmentVersion: 1 }, actorStaffId: 'stf_audit_actor' },
  { action: 'client.updated', entityType: 'client', entityId: 'cl_audit_updated', result: 'success', metadata: { clientVersion: 2 }, actorStaffId: 'stf_audit_actor' },
  { action: 'client.assignment.changed', entityType: 'client', entityId: 'cl_audit_assignment', result: 'success', metadata: { clientVersion: 2, closedAssignmentId: 'asg_audit_old', closedAssignmentVersion: 2, newAssignmentId: 'asg_audit_new', newAssignmentVersion: 1 }, actorStaffId: 'stf_audit_actor' },
  { action: 'client.archived', entityType: 'client', entityId: 'cl_audit_archived', result: 'success', metadata: { clientVersion: 3, assignmentId: 'asg_audit_archive', assignmentVersion: 2 }, actorStaffId: 'stf_audit_actor' },
  { action: 'appointment.created', entityType: 'appointment', entityId: 'apt_audit_created', result: 'success', metadata: { appointmentVersion: 1, chargeVersion: 1 }, actorStaffId: 'stf_audit_actor' },
  { action: 'appointment.updated', entityType: 'appointment', entityId: 'apt_audit_updated', result: 'success', metadata: { appointmentVersion: 2, chargeVersion: 2 }, actorStaffId: 'stf_audit_actor' },
  { action: 'appointment.cancelled', entityType: 'appointment', entityId: 'apt_audit_cancelled', result: 'success', metadata: { appointmentVersion: 2, chargeVersion: 1 }, actorStaffId: 'stf_audit_actor' },
  { action: 'payment.recorded', entityType: 'appointment', entityId: 'apt_audit_paid', result: 'success', metadata: { appointmentVersion: 2, paymentEntryId: 'pay_audit_recorded' }, actorStaffId: 'stf_audit_actor' },
  { action: 'payment.corrected', entityType: 'payment_entry', entityId: 'pay_audit_reversed', result: 'success', metadata: { appointmentVersion: 3, correctionId: 'cor_audit_corrected', reversedEntryId: 'pay_audit_reversed', replacementEntryId: null }, actorStaffId: 'stf_audit_actor' },
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

test('security audit projects and deeply freezes all twenty-four exact registry actions with opaque correlations', async () => {
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

const clientInput = (overrides = {}) => ({
  name: 'Ola Żuraw',
  age: 12,
  status: 'active',
  specialistId: 'sp_anna',
  ...overrides,
})

const clientDto = (overrides = {}) => ({
  id: 'cl_ola',
  name: 'Ola Żuraw',
  age: 12,
  status: 'active',
  version: 1,
  archivedAt: null,
  createdAt: '2026-08-04T08:00:00.000Z',
  updatedAt: '2026-08-04T08:00:00.000Z',
  readOnly: false,
  assignment: {
    id: 'asg_ola_anna',
    specialistId: 'sp_anna',
    startsAt: '2026-08-04T08:00:00.000Z',
    version: 1,
  },
  ...overrides,
})

const clientEnvelope = (client) => ({ data: { client } })

test('finance API lists a month and sends the exact import lifecycle requests', async () => {
  const batch = {
    id: 'fib_api_one', fingerprint: 'a'.repeat(64), formatVersion: 1,
    totalRows: 1, acceptedRows: 0, status: 'importing', version: 1,
    createdAt: '2026-08-27T10:00:00.000Z',
    updatedAt: '2026-08-27T10:00:00.000Z', committedAt: null,
  }
  const financeEntry = {
    id: 'fin_api_one', kind: 'income', recordType: 'income',
    accountingMonth: '2025-09', occurredOn: '2025-09-08', amountGrosze: 18000,
    paidAmountGrosze: 18000, paymentMethod: 'card', settlementStatus: 'paid',
    invoiceStatus: 'issued', counterparty: 'Fikcyjna Klientka',
    sourceLabel: 'Konsultacja fikcyjna', invoiceNote: '', specialistId: null,
    lessonCount: null, source: {
      batchId: batch.id, sourceKey: 'fictional.xlsx:Wrzesień:2:abcdef0123456789',
      sheet: 'Wrzesień', rowNumber: 2, raw: { Cena: 180 },
    }, appointmentId: null, version: 1, createdByStaffId: 'stf_owner_1',
    createdAt: '2026-08-27T10:01:00.000Z', updatedAt: '2026-08-27T10:01:00.000Z',
  }
  const summary = {
    month: '2025-09', revenueGrosze: 18000, expensesGrosze: 0,
    balanceGrosze: 18000, collectedGrosze: 18000, outstandingGrosze: 0,
    invoiceActionCount: 0, entryCount: 1,
  }
  const financeInput = Object.fromEntries([
    'kind', 'recordType', 'accountingMonth', 'occurredOn', 'amountGrosze',
    'paidAmountGrosze', 'paymentMethod', 'settlementStatus', 'invoiceStatus',
    'counterparty', 'sourceLabel', 'invoiceNote', 'specialistId', 'lessonCount', 'source',
  ].map((key) => [key, financeEntry[key]]))
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse({ data: { entries: [financeEntry], summary } }),
    jsonResponse({ data: { batch: { ...batch, filename: 'fictional.xlsx' } } }, 201),
    jsonResponse({ data: { batch: { ...batch, acceptedRows: 1, version: 2 } } }),
    jsonResponse({ data: { batch: {
      ...batch, acceptedRows: 1, status: 'committed', version: 3,
      updatedAt: '2026-08-27T10:02:00.000Z', committedAt: '2026-08-27T10:02:00.000Z',
    } } }),
  )
  const client = createApiClient({ fetchImpl, idempotencyKeyFactory: () => 'finance-generated-key-0001' })
  await client.getSession()

  assert.deepEqual(await client.listFinance({ month: '2025-09', kind: null }), {
    entries: [financeEntry], summary,
  })
  await client.startFinanceImport({
    filename: 'fictional.xlsx', fingerprint: 'a'.repeat(64), formatVersion: 1, totalRows: 1,
  }, { idempotencyKey: 'finance-start-key-0001' })
  await client.appendFinanceImportChunk(batch.id, 0, [financeInput], {
    idempotencyKey: 'finance-chunk-key-0001',
  })
  await client.commitFinanceImport(batch.id, 2, { idempotencyKey: 'finance-commit-key-0001' })

  assert.equal(calls[1].url, '/api/v1/finance?month=2025-09')
  assert.equal(calls[2].url, '/api/v1/finance/imports')
  assert.equal(calls[3].url, `/api/v1/finance/imports/${batch.id}/chunks`)
  assert.deepEqual(JSON.parse(calls[3].init.body), {
    sequence: 0,
    entries: [{
      kind: financeEntry.kind, recordType: financeEntry.recordType,
      accountingMonth: financeEntry.accountingMonth, occurredOn: financeEntry.occurredOn,
      amountGrosze: financeEntry.amountGrosze, paidAmountGrosze: financeEntry.paidAmountGrosze,
      paymentMethod: financeEntry.paymentMethod,
      settlementStatus: financeEntry.settlementStatus, invoiceStatus: financeEntry.invoiceStatus,
      counterparty: financeEntry.counterparty, sourceLabel: financeEntry.sourceLabel,
      invoiceNote: financeEntry.invoiceNote, specialistId: financeEntry.specialistId,
      lessonCount: financeEntry.lessonCount, source: financeEntry.source,
    }],
  })
  assert.equal(calls[4].url, `/api/v1/finance/imports/${batch.id}/commit`)
})

test('finance API exposes entries without an accounting month', async () => {
  const summary = {
    month: null, revenueGrosze: 0, expensesGrosze: 0, balanceGrosze: 0,
    collectedGrosze: 0, outstandingGrosze: 0, invoiceActionCount: 0, entryCount: 0,
  }
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse({ data: { entries: [], summary } }),
  )
  const client = createApiClient({ fetchImpl, idempotencyKeyFactory: () => 'finance-generated-key-0001' })
  await client.getSession()

  assert.deepEqual(await client.listFinance({ month: null, kind: null }), {
    entries: [], summary,
  })
  assert.equal(calls[1].url, '/api/v1/finance?month=unknown')
})

test('exposes client commands and sends canonical create, edit, and archive requests', async () => {
  assert.equal(typeof apiClient.createClient, 'function')
  assert.equal(typeof apiClient.editClient, 'function')
  assert.equal(typeof apiClient.archiveClient, 'function')

  const created = clientDto()
  const edited = clientDto({
    name: 'Ola Nowak',
    age: null,
    status: 'paused',
    version: 2,
    updatedAt: '2026-08-04T09:00:00.000Z',
    assignment: {
      id: 'asg_ola_beata',
      specialistId: 'sp_beata',
      startsAt: '2026-08-04T09:00:00.000Z',
      version: 1,
    },
  })
  const archived = clientDto({
    name: 'Ola Nowak',
    age: null,
    status: 'archived',
    version: 3,
    archivedAt: '2026-08-04T10:00:00.000Z',
    updatedAt: '2026-08-04T10:00:00.000Z',
    readOnly: true,
    assignment: null,
  })
  const generated = ['client-create-key-0001', 'client-archive-key-0003']
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse(clientEnvelope(created), 201),
    jsonResponse(clientEnvelope(edited)),
    jsonResponse(clientEnvelope(archived)),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => generated.shift(),
  })
  await client.getSession()

  const createSource = {
    specialistId: 'sp_anna', status: 'active', age: 12, name: 'Ola Żuraw',
  }
  const createResult = await client.createClient(createSource)
  const editResult = await client.editClient('cl_ola', 1, clientInput({
    name: 'Ola Nowak', age: null, status: 'paused', specialistId: 'sp_beata',
  }), { idempotencyKey: 'client-edit-key-0002' })
  const archiveResult = await client.archiveClient('cl_ola', 2)

  assert.deepEqual(createResult, created)
  assert.deepEqual(editResult, edited)
  assert.deepEqual(archiveResult, archived)
  for (const result of [createResult, editResult, archiveResult]) assertDeepFrozen(result)
  assert.notEqual(createResult, created)
  assert.notEqual(createResult.assignment, created.assignment)
  created.name = 'private source mutation'
  created.assignment.specialistId = 'sp_private'
  assert.equal(createResult.name, 'Ola Żuraw')
  assert.equal(createResult.assignment.specialistId, 'sp_anna')
  assert.deepEqual(createSource, clientInput())

  assert.deepEqual(calls.slice(1).map((call) => call.url), [
    '/api/v1/clients',
    '/api/v1/clients/cl_ola/edits',
    '/api/v1/clients/cl_ola/archive',
  ])
  assert.deepEqual(calls.slice(1).map((call) => call.init.body), [
    '{"name":"Ola Żuraw","age":12,"status":"active","specialistId":"sp_anna"}',
    '{"expectedVersion":1,"name":"Ola Nowak","age":null,"status":"paused","specialistId":"sp_beata"}',
    '{"expectedVersion":2}',
  ])
  assert.deepEqual(calls.slice(1).map((call) => header(call, 'Idempotency-Key')), [
    'client-create-key-0001', 'client-edit-key-0002', 'client-archive-key-0003',
  ])
  for (const call of calls.slice(1)) {
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.credentials, 'same-origin')
    assert.equal(header(call, 'Accept'), 'application/json')
    assert.equal(header(call, 'Content-Type'), 'application/json')
    assert.equal(header(call, 'X-CSRF-Token'), TOKEN_A)
    assert.equal(header(call, 'Authorization'), null)
    assert.deepEqual(Object.keys(call.init.headers).sort(), [
      'Accept', 'Content-Type', 'Idempotency-Key', 'X-CSRF-Token',
    ])
  }
  assert.equal(generated.length, 0)
})

test('client commands reject malformed and hostile inputs before fetch or key generation', async () => {
  let generated = 0
  let gets = 0
  let coercions = 0
  const keyFactory = () => { generated += 1; return 'unused-client-key-0001' }
  const hostile = new Proxy(clientInput(), {
    get() { gets += 1; throw new Error('private client getter') },
    ownKeys() { throw new Error('private client keys') },
  })
  const coercibleId = {
    toString() { coercions += 1; return 'cl_ola' },
    valueOf() { coercions += 1; return 'cl_ola' },
  }
  const accessor = Object.defineProperty(clientInput(), 'name', {
    enumerable: true,
    get() { gets += 1; throw new Error('private identity') },
  })
  const hidden = Object.defineProperty(clientInput(), 'extra', { value: true })
  const symbol = { ...clientInput(), [Symbol('private')]: true }
  const badInputs = [
    null, [], {}, hostile, accessor, hidden, symbol,
    clientInput({ name: ' Ola Żuraw' }),
    clientInput({ name: 'Ola Z\u0307uraw' }),
    clientInput({ name: '\uD800' }),
    clientInput({ name: 'a'.repeat(121) }),
    clientInput({ age: 0 }),
    clientInput({ age: 27 }),
    clientInput({ age: 12.5 }),
    clientInput({ status: 'archived' }),
    clientInput({ specialistId: 'stf_anna' }),
  ]
  for (const input of badInputs) {
    const { calls, fetchImpl } = queuedFetch()
    const client = createApiClient({ fetchImpl, idempotencyKeyFactory: keyFactory })
    await assert.rejects(Promise.resolve().then(() => client.createClient(input)), assertClientInput)
    assert.equal(calls.length, 0)
  }

  const invalidCalls = [
    (client) => client.editClient('', 1, clientInput()),
    (client) => client.editClient(coercibleId, 1, clientInput()),
    (client) => client.editClient('cl_ola', 0, clientInput()),
    (client) => client.editClient('cl_ola', Number.MAX_SAFE_INTEGER, clientInput()),
    (client) => client.archiveClient('cl_ola', 0),
    (client) => client.archiveClient('cl_ola', 1, null),
    (client) => client.createClient(clientInput(), {}),
    (client) => client.editClient('cl_ola', 1, clientInput(), {}),
    (client) => client.archiveClient('cl_ola', 1, {}),
    (client) => client.createClient(clientInput(), { idempotencyKey: 'bad key' }),
    (client) => client.createClient(clientInput(), { idempotencyKey: 'valid-key-0001', extra: true }),
    (client) => client.createClient(clientInput(), Object.defineProperty({}, 'idempotencyKey', {
      enumerable: true, get() { gets += 1; throw new Error('private option') },
    })),
  ]
  for (const invoke of invalidCalls) {
    const { calls, fetchImpl } = queuedFetch()
    const client = createApiClient({ fetchImpl, idempotencyKeyFactory: keyFactory })
    await assert.rejects(Promise.resolve().then(() => invoke(client)), (error) => {
      assertClientInput(error)
      assert.doesNotMatch(JSON.stringify(error), /private client|private identity|private option/)
      return true
    })
    assert.equal(calls.length, 0)
  }
  const missingSession = queuedFetch()
  await assert.rejects(createApiClient({
    fetchImpl: missingSession.fetchImpl,
    idempotencyKeyFactory: keyFactory,
  }).createClient(clientInput()), { code: 'SESSION_REQUIRED' })
  assert.equal(missingSession.calls.length, 0)
  assert.equal(generated, 0)
  assert.equal(coercions, 0)
  assert.equal(gets, 0)
})

test('client command options distinguish omission from every malformed supplied object', async () => {
  let generated = 0
  let reads = 0
  const keyFactory = () => { generated += 1; return 'client-option-key-0001' }
  const malformedOptions = () => {
    const hidden = Object.defineProperty({}, 'idempotencyKey', {
      value: 'client-option-key-0001', enumerable: false,
    })
    const accessor = Object.defineProperty({}, 'idempotencyKey', {
      enumerable: true,
      get() { reads += 1; throw new Error('private option value') },
    })
    return [
      {},
      { idempotencyKey: 'client-option-key-0001', extra: true },
      hidden,
      accessor,
      { idempotencyKey: 'client-option-key-0001', [Symbol('extra')]: true },
      new Proxy({ idempotencyKey: 'client-option-key-0001' }, {
        ownKeys() { throw new Error('private option proxy') },
      }),
    ]
  }
  const invokes = [
    (client, options) => client.createClient(clientInput(), options),
    (client, options) => client.editClient('cl_ola', 1, clientInput(), options),
    (client, options) => client.archiveClient('cl_ola', 1, options),
  ]
  for (const invoke of invokes) {
    for (const options of malformedOptions()) {
      const queued = queuedFetch()
      const client = createApiClient({
        fetchImpl: queued.fetchImpl,
        idempotencyKeyFactory: keyFactory,
      })
      await assert.rejects(Promise.resolve().then(() => invoke(client, options)), (error) => {
        assertClientInput(error)
        assert.doesNotMatch(JSON.stringify(error), /private option/)
        return true
      })
      assert.equal(queued.calls.length, 0)
    }
  }
  assert.equal(generated, 0)
  assert.equal(reads, 0)
})

test('client identity validation stays byte-for-byte aligned across browser, core, and Worker', async () => {
  const joinedName = 'Ada\u200DNowak'
  const input = clientInput({ name: joinedName })
  assert.deepEqual(validateClientInput(input), input)
  assert.deepEqual(validateCreateClientBody(input), input)

  const response = clientEnvelope(clientDto({ name: joinedName }))
  const queued = queuedFetch(jsonResponse(sessionBody()), jsonResponse(response, 201))
  let generated = 0
  const client = createApiClient({
    fetchImpl: queued.fetchImpl,
    idempotencyKeyFactory: () => { generated += 1; return 'unicode-client-key-0001' },
  })
  await client.getSession()
  const result = await client.createClient(input, undefined)
  assert.equal(generated, 1)
  assert.equal(result.name, joinedName)
  assert.equal(queued.calls[1].init.body,
    '{"name":"Ada‍Nowak","age":12,"status":"active","specialistId":"sp_anna"}')

  const workspace = fullWorkspaceBody()
  workspace.data.clients[0].name = joinedName
  const workspaceQueue = queuedFetch(jsonResponse(workspace))
  const loaded = await createApiClient({ fetchImpl: workspaceQueue.fetchImpl }).loadWorkspaceWindow({
    from: '2026-08-01', to: '2026-08-31',
  })
  assert.equal(loaded.clients[0].name, joinedName)

  for (const name of ['\uD800', 'Ada\uD800Nowak', '\uDFFF']) {
    const malformed = clientInput({ name })
    assert.throws(() => validateClientInput(malformed), /VALIDATION_FAILED\/name/)
    assert.throws(() => validateCreateClientBody(malformed), /VALIDATION_FAILED\/name/)
    const browser = queuedFetch()
    await assert.rejects(createApiClient({ fetchImpl: browser.fetchImpl }).createClient(malformed),
      assertClientInput)
    assert.equal(browser.calls.length, 0)
  }
})

test('client command success validators enforce exact operation relationships', async () => {
  const cases = [
    ['create extra envelope key', 'create', (body) => { body.extra = true }],
    ['create wrong identity', 'create', (body) => { body.data.client.name = 'Private Name' }],
    ['create wrong version', 'create', (body) => { body.data.client.version = 2 }],
    ['create incoherent assignment', 'create', (body) => { body.data.client.assignment.startsAt = '2026-08-04T08:00:01.000Z' }],
    ['create malformed Unicode', 'create', (body) => { body.data.client.name = '\uD800' }],
    ['create noncanonical instant', 'create', (body) => { body.data.client.createdAt = '2026-08-04T08:00:00Z' }],
    ['edit wrong target', 'edit', (body) => { body.data.client.id = 'cl_other' }],
    ['edit wrong version', 'edit', (body) => { body.data.client.version = 3 }],
    ['edit wrong specialist', 'edit', (body) => { body.data.client.assignment.specialistId = 'sp_other' }],
    ['edit noncurrent assignment version', 'edit', (body) => { body.data.client.assignment.version = 2 }],
    ['archive remains writable', 'archive', (body) => { body.data.client.readOnly = false }],
    ['archive retains assignment', 'archive', (body) => { body.data.client.assignment = clientDto().assignment }],
    ['archive time differs from update', 'archive', (body) => { body.data.client.updatedAt = '2026-08-04T09:59:59.000Z' }],
  ]
  for (const [name, operation, mutate] of cases) {
    await test(name, async () => {
      const base = operation === 'archive'
        ? clientDto({
          status: 'archived', version: 2, archivedAt: '2026-08-04T10:00:00.000Z',
          updatedAt: '2026-08-04T10:00:00.000Z', readOnly: true, assignment: null,
        })
        : clientDto(operation === 'edit' ? { version: 2 } : {})
      const body = clientEnvelope(base)
      mutate(body)
      const { calls, fetchImpl } = queuedFetch(
        jsonResponse(sessionBody()), jsonResponse(body, operation === 'create' ? 201 : 200),
      )
      const client = createApiClient({ fetchImpl })
      await client.getSession()
      const invoke = operation === 'create'
        ? () => client.createClient(clientInput(), { idempotencyKey: 'malformed-client-key-0001' })
        : operation === 'edit'
          ? () => client.editClient('cl_ola', 1, clientInput(), { idempotencyKey: 'malformed-client-key-0001' })
          : () => client.archiveClient('cl_ola', 1, { idempotencyKey: 'malformed-client-key-0001' })
      await assert.rejects(invoke(), (error) => {
        assertInvalidResponse(error)
        assert.equal(error.idempotencyKey, 'malformed-client-key-0001')
        assert.doesNotMatch(JSON.stringify(error), /Private Name|sp_other/)
        return true
      })
      assert.equal(calls.length, 2)
    })
  }
})

test('client commands contain hostile success values and preserve valid CSRF after rejection', async () => {
  const secret = 'private client response Ola ciphertext'
  let reads = 0
  const hostile = clientEnvelope(clientDto())
  Object.defineProperty(hostile.data.client, 'name', {
    enumerable: true,
    get() { reads += 1; throw new Error(secret) },
  })
  const wrongStatus = clientEnvelope(clientDto())
  const archived = clientDto({
    status: 'archived', version: 2, archivedAt: '2026-08-04T10:00:00.000Z',
    updatedAt: '2026-08-04T10:00:00.000Z', readOnly: true, assignment: null,
  })
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    parsedResponse(hostile, 201),
    parsedResponse(wrongStatus, 200),
    jsonResponse(clientEnvelope(archived)),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  for (const key of ['hostile-client-key-0001', 'status-client-key-0002']) {
    await assert.rejects(client.createClient(clientInput(), { idempotencyKey: key }), (error) => {
      assertInvalidResponse(error)
      assert.equal(error.idempotencyKey, key)
      assert.doesNotMatch(JSON.stringify(error), /private client|Ola|ciphertext/)
      return true
    })
  }
  assert.equal(reads, 0)

  await client.archiveClient('cl_ola', 1, { idempotencyKey: 'after-invalid-key-0003' })
  assert.equal(header(calls[3], 'X-CSRF-Token'), TOKEN_A)
  assert.equal(calls.length, 4)
})

test('client create refreshes CSRF exactly once while preserving key, path, and body', async () => {
  let generated = 0
  const refreshed = sessionBody({ csrfToken: TOKEN_B, csrfExpiresAt: '2033-05-18T03:33:18.000Z' })
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    errorResponse('CSRF_EXPIRED', 403),
    jsonResponse(refreshed),
    jsonResponse(clientEnvelope(clientDto()), 201),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => { generated += 1; return 'csrf-client-key-0001' },
  })
  await client.getSession()
  await client.createClient(clientInput())

  assert.equal(generated, 1)
  assert.deepEqual(calls.map((call) => call.url), [
    '/api/v1/session', '/api/v1/clients', '/api/v1/session', '/api/v1/clients',
  ])
  assert.equal(calls[1].init.body, calls[3].init.body)
  assert.equal(header(calls[1], 'Idempotency-Key'), 'csrf-client-key-0001')
  assert.equal(header(calls[3], 'Idempotency-Key'), 'csrf-client-key-0001')
  assert.equal(header(calls[1], 'X-CSRF-Token'), TOKEN_A)
  assert.equal(header(calls[3], 'X-CSRF-Token'), TOKEN_B)
})

test('client mutations never automatically retry a second CSRF or non-CSRF outcome', async () => {
  const outcomes = [
    [errorResponse('CSRF_EXPIRED', 403), jsonResponse(sessionBody()), errorResponse('CSRF_EXPIRED', 403), 4, 'CSRF_EXPIRED'],
    [errorResponse('FORBIDDEN', 403), null, null, 2, 'FORBIDDEN'],
    [errorResponse('INTERNAL_ERROR', 500), null, null, 2, 'INTERNAL_ERROR'],
    [jsonResponse({ data: { client: { private: 'ciphertext' } } }, 201), null, null, 2, 'INVALID_RESPONSE'],
  ]
  for (const [first, refresh, second, callCount, code] of outcomes) {
    const queued = queuedFetch(
      jsonResponse(sessionBody()),
      first,
      ...(refresh ? [refresh, second] : []),
    )
    const client = createApiClient({ fetchImpl: queued.fetchImpl })
    await client.getSession()
    await assert.rejects(client.createClient(clientInput(), {
      idempotencyKey: 'no-client-retry-key-0001',
    }), (error) => {
      assert.equal(error.code, code)
      assert.doesNotMatch(JSON.stringify(error), /ciphertext/)
      return true
    })
    assert.equal(queued.calls.length, callCount)
    assert.equal(queued.calls.filter((call) => call.init.method === 'POST').length,
      code === 'CSRF_EXPIRED' ? 2 : 1)
  }
})

test('uncertain client transport is not retried and supports explicit identical replay', async () => {
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    new Error('private transport identity Ola'),
    jsonResponse(clientEnvelope(clientDto()), 201),
  )
  const client = createApiClient({
    fetchImpl,
    idempotencyKeyFactory: () => 'uncertain-client-key-0001',
  })
  await client.getSession()
  let actionKey
  await assert.rejects(client.createClient(clientInput()), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.idempotencyKey, 'uncertain-client-key-0001')
    assert.doesNotMatch(JSON.stringify(error), /private transport|Ola/)
    actionKey = error.idempotencyKey
    return true
  })
  assert.equal(calls.length, 2)

  const result = await client.createClient(clientInput(), { idempotencyKey: actionKey })
  assert.equal(result.id, 'cl_ola')
  assert.equal(calls.length, 3)
  assert.equal(calls[1].url, calls[2].url)
  assert.equal(calls[1].init.body, calls[2].init.body)
  assert.equal(header(calls[1], 'Idempotency-Key'), header(calls[2], 'Idempotency-Key'))
})

test('client conflicts expose only safe details and authentication denials clear the session', async () => {
  const conflictCodes = [
    'CLIENT_STATUS_CONFLICT', 'CLIENT_ASSIGNMENT_CONFLICT', 'CLIENT_ARCHIVE_CONFLICT',
  ]
  for (const code of conflictCodes) {
    const { fetchImpl } = queuedFetch(
      jsonResponse(sessionBody()),
      errorResponse(code, 409, { details: { name: 'Private Ola', currentVersion: 3 } }),
    )
    const client = createApiClient({ fetchImpl })
    await client.getSession()
    await assert.rejects(client.archiveClient('cl_ola', 1, {
      idempotencyKey: 'client-conflict-key-0001',
    }), (error) => {
      assert.equal(error.code, code)
      assert.equal(Object.hasOwn(error, 'details'), false)
      assert.doesNotMatch(JSON.stringify(error), /Private Ola/)
      return true
    })
  }

  for (const currentVersion of [3, 0, Number.MAX_SAFE_INTEGER + 1]) {
    const { fetchImpl } = queuedFetch(
      jsonResponse(sessionBody()),
      errorResponse('VERSION_CONFLICT', 409, {
        details: { currentVersion, name: 'Private Ola' },
      }),
    )
    const client = createApiClient({ fetchImpl })
    await client.getSession()
    await assert.rejects(client.archiveClient('cl_ola', 1, {
      idempotencyKey: 'client-version-key-0001',
    }), (error) => {
      assert.equal(error.code, 'VERSION_CONFLICT')
      assert.deepEqual(error.details, currentVersion === 3 ? { currentVersion: 3 } : undefined)
      assert.doesNotMatch(JSON.stringify(error), /Private Ola/)
      return true
    })
  }

  const auth = queuedFetch(
    jsonResponse(sessionBody()),
    errorResponse('ACCESS_DENIED', 403),
  )
  const client = createApiClient({ fetchImpl: auth.fetchImpl })
  const observed = []
  client.subscribeSession((session) => observed.push(session))
  await client.getSession()
  await assert.rejects(client.createClient(clientInput(), {
    idempotencyKey: 'client-auth-key-0001',
  }), { code: 'ACCESS_DENIED' })
  assert.deepEqual(observed, [publicSession(), null])
  await assert.rejects(client.archiveClient('cl_ola', 1, {
    idempotencyKey: 'client-auth-key-0002',
  }), { code: 'SESSION_REQUIRED' })
  assert.equal(auth.calls.length, 2)
})

const appointmentInput = (overrides = {}) => ({
  clientId: 'cl_ola',
  specialistId: 'sp_anna',
  serviceId: 'zajecia',
  date: '2026-08-10',
  time: '10:00',
  durationMinutes: 50,
  expectedAmountGrosze: 18_000,
  location: 'Gabinet 1',
  status: 'scheduled',
  ...overrides,
})

const ledgerAppointment = (overrides = {}) => {
  const base = {
    id: 'apt_ola_august',
    clientId: 'cl_ola',
    specialistId: 'sp_anna',
    serviceId: 'zajecia',
    startsAt: '2026-08-10T08:00:00.000Z',
    endsAt: '2026-08-10T08:50:00.000Z',
    timeZone: 'Europe/Warsaw',
    location: 'Gabinet 1',
    status: 'scheduled',
    source: 'panel',
    version: 1,
    cancelledAt: null,
    createdAt: '2026-08-04T08:00:00.000Z',
    updatedAt: '2026-08-04T08:00:00.000Z',
    charge: {
      id: 'chg_ola_august', serviceId: 'zajecia', expectedAmountGrosze: 18_000,
      currency: 'PLN', version: 1,
    },
    payment: {
      status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
      latestMethod: null, latestReceivedAt: null,
    },
    paymentEntries: [],
  }
  return {
    ...base,
    ...overrides,
    charge: { ...base.charge, ...(overrides.charge ?? {}) },
    payment: { ...base.payment, ...(overrides.payment ?? {}) },
    paymentEntries: overrides.paymentEntries ?? base.paymentEntries,
  }
}

const appointmentEnvelope = (appointment) => ({ data: { appointment } })

test('ledger commands expose the public API and send exact canonical requests', async () => {
  for (const name of [
    'createAppointment', 'editAppointment', 'cancelAppointment', 'recordPayment',
    'correctPayment',
  ]) assert.equal(typeof apiClient[name], 'function')

  const created = ledgerAppointment()
  const edited = ledgerAppointment({
    specialistId: 'sp_beata', serviceId: 'konsultacja',
    startsAt: '2026-08-11T09:30:00.000Z', endsAt: '2026-08-11T11:00:00.000Z',
    location: null, status: 'completed', version: 2,
    updatedAt: '2026-08-04T09:00:00.000Z',
    charge: { serviceId: 'konsultacja', expectedAmountGrosze: 25_000, version: 2 },
    payment: { outstandingGrosze: 25_000 },
  })
  const cancelled = ledgerAppointment({
    version: 3, status: 'cancelled', cancelledAt: '2026-08-04T10:00:00.000Z',
    updatedAt: '2026-08-04T10:00:00.000Z',
  })
  const recorded = ledgerAppointment({
    version: 4, status: 'completed', updatedAt: '2026-08-04T11:00:00.000Z',
    payment: {
      status: 'partial', collectedGrosze: 7_000, outstandingGrosze: 11_000,
      latestMethod: 'card', latestReceivedAt: '2026-08-04T10:30:00.000Z',
    },
    paymentEntries: [{
      id: 'pay_original', amountGrosze: 7_000, method: 'card',
      receivedAt: '2026-08-04T10:30:00.000Z', correctedAt: null,
      replacementEntryId: null,
    }],
  })
  const corrected = ledgerAppointment({
    version: 5, status: 'completed', updatedAt: '2026-08-04T12:00:00.000Z',
    payment: {
      status: 'partial', collectedGrosze: 6_000, outstandingGrosze: 12_000,
      latestMethod: 'transfer', latestReceivedAt: '2026-08-04T10:45:00.000Z',
    },
    paymentEntries: [{
      id: 'pay_original', amountGrosze: 7_000, method: 'card',
      receivedAt: '2026-08-04T10:30:00.000Z',
      correctedAt: '2026-08-04T12:00:00.000Z', replacementEntryId: 'pay_replacement',
    }, {
      id: 'pay_replacement', amountGrosze: 6_000, method: 'transfer',
      receivedAt: '2026-08-04T10:45:00.000Z', correctedAt: null,
      replacementEntryId: null,
    }],
  })
  const queued = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse(appointmentEnvelope(created), 201),
    jsonResponse(appointmentEnvelope(edited)),
    jsonResponse(appointmentEnvelope(cancelled)),
    jsonResponse(appointmentEnvelope(recorded)),
    jsonResponse(appointmentEnvelope(corrected)),
  )
  const keys = ['ledger-create-key-0001', 'ledger-cancel-key-0003']
  const client = createApiClient({
    fetchImpl: queued.fetchImpl, idempotencyKeyFactory: () => keys.shift(),
  })
  await client.getSession()
  const createSource = appointmentInput()
  const editSource = {
    specialistId: 'sp_beata', serviceId: 'konsultacja', date: '2026-08-11',
    time: '11:30', durationMinutes: 90, expectedAmountGrosze: 25_000,
    location: null, status: 'completed',
  }
  const paymentSource = {
    amountGrosze: 7_000, method: 'card', receivedAt: '2026-08-04T10:30:00.000Z',
  }
  const correctionSource = {
    reason: 'Zmiana metody', replacement: {
      amountGrosze: 6_000, method: 'transfer', receivedAt: '2026-08-04T10:45:00.000Z',
    },
  }
  const results = [
    await client.createAppointment(createSource),
    await client.editAppointment('apt_ola_august', 1, editSource,
      { idempotencyKey: 'ledger-edit-key-0002' }),
    await client.cancelAppointment('apt_ola_august', 2),
    await client.recordPayment('apt_ola_august', 3, paymentSource,
      { idempotencyKey: 'ledger-record-key-0004' }),
    await client.correctPayment('pay_original', 4, correctionSource,
      { idempotencyKey: 'ledger-correct-key-0005' }),
  ]
  assert.deepEqual(results, [created, edited, cancelled, recorded, corrected])
  for (const result of results) assertDeepFrozen(result)
  assert.deepEqual(createSource, appointmentInput())
  assert.deepEqual(queued.calls.slice(1).map(({ url }) => url), [
    '/api/v1/appointments',
    '/api/v1/appointments/apt_ola_august/edits',
    '/api/v1/appointments/apt_ola_august/cancellation',
    '/api/v1/appointments/apt_ola_august/payments',
    '/api/v1/payments/pay_original/corrections',
  ])
  assert.deepEqual(queued.calls.slice(1).map(({ init }) => init.body), [
    '{"clientId":"cl_ola","specialistId":"sp_anna","serviceId":"zajecia","date":"2026-08-10","time":"10:00","durationMinutes":50,"expectedAmountGrosze":18000,"location":"Gabinet 1","status":"scheduled"}',
    '{"expectedVersion":1,"specialistId":"sp_beata","serviceId":"konsultacja","date":"2026-08-11","time":"11:30","durationMinutes":90,"expectedAmountGrosze":25000,"location":null,"status":"completed"}',
    '{"expectedVersion":2}',
    '{"expectedVersion":3,"amountGrosze":7000,"method":"card","receivedAt":"2026-08-04T10:30:00.000Z"}',
    '{"expectedVersion":4,"reason":"Zmiana metody","replacement":{"amountGrosze":6000,"method":"transfer","receivedAt":"2026-08-04T10:45:00.000Z"}}',
  ])
  assert.deepEqual(queued.calls.slice(1).map((call) => header(call, 'Idempotency-Key')), [
    'ledger-create-key-0001', 'ledger-edit-key-0002', 'ledger-cancel-key-0003',
    'ledger-record-key-0004', 'ledger-correct-key-0005',
  ])
  for (const call of queued.calls.slice(1)) {
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.credentials, 'same-origin')
    assert.equal(header(call, 'Accept'), 'application/json')
    assert.equal(header(call, 'Content-Type'), 'application/json')
    assert.equal(header(call, 'X-CSRF-Token'), TOKEN_A)
    assert.deepEqual(Object.keys(call.init.headers).sort(), [
      'Accept', 'Content-Type', 'Idempotency-Key', 'X-CSRF-Token',
    ])
  }
})

test('ledger commands reject invalid hostile inputs and options before session, key, or fetch', async () => {
  let generated = 0
  let reads = 0
  const hostileInput = new Proxy(appointmentInput(), {
    ownKeys() { throw new Error('private appointment keys') },
    get() { reads += 1; throw new Error('private appointment value') },
  })
  const accessor = Object.defineProperty(appointmentInput(), 'location', {
    enumerable: true, get() { reads += 1; throw new Error('private location') },
  })
  const badCreateInputs = [
    null, [], {}, hostileInput, accessor,
    { ...appointmentInput(), extra: true },
    { ...appointmentInput(), [Symbol('private')]: true },
    appointmentInput({ clientId: 'apt_wrong' }),
    appointmentInput({ specialistId: 'stf_wrong' }),
    appointmentInput({ serviceId: 'unknown' }),
    appointmentInput({ date: '2026-02-29' }),
    appointmentInput({ time: '24:00' }),
    appointmentInput({ durationMinutes: 60 }),
    appointmentInput({ expectedAmountGrosze: 0 }),
    appointmentInput({ expectedAmountGrosze: 1_000_001 }),
    appointmentInput({ location: ' Gabinet' }),
    appointmentInput({ location: 'a'.repeat(81) }),
    appointmentInput({ location: '\uD800' }),
    appointmentInput({ status: 'cancelled' }),
  ]
  const malformedOptions = [
    null, {}, { idempotencyKey: 'bad key' },
    { idempotencyKey: 'ledger-option-key-0001', extra: true },
    Object.defineProperty({}, 'idempotencyKey', {
      enumerable: true, get() { reads += 1; throw new Error('private key') },
    }),
  ]
  for (const invoke of [
    ...badCreateInputs.map((input) => (client) => client.createAppointment(input)),
    (client) => client.editAppointment('apt_ola_august', 0, appointmentInput()),
    (client) => client.cancelAppointment('cl_wrong', 1),
    (client) => client.recordPayment('apt_ola_august', 4_096, {
      amountGrosze: 1, method: 'cash', receivedAt: '2026-08-04T10:00:00.000Z',
    }),
    (client) => client.recordPayment('apt_ola_august', 1, {
      amountGrosze: 1, method: 'blik', receivedAt: '2026-08-04T10:00:00.000Z',
    }),
    (client) => client.recordPayment('apt_ola_august', 1, {
      amountGrosze: 1, method: 'cash', receivedAt: '2026-08-04T10:00:00Z',
    }),
    (client) => client.correctPayment('apt_wrong', 1, {
      reason: 'Korekta', replacement: null,
    }),
    (client) => client.correctPayment('pay_original', 1, {
      reason: ' Korekta', replacement: null,
    }),
    (client) => client.correctPayment('pay_original', 1, {
      reason: 'ą'.repeat(251), replacement: null,
    }),
    ...malformedOptions.map((options) => (client) => (
      client.cancelAppointment('apt_ola_august', 1, options)
    )),
  ]) {
    const queued = queuedFetch()
    const client = createApiClient({
      fetchImpl: queued.fetchImpl,
      idempotencyKeyFactory: () => { generated += 1; return 'unused-ledger-key-0001' },
    })
    await assert.rejects(Promise.resolve().then(() => invoke(client)), assertClientInput)
    assert.equal(queued.calls.length, 0)
  }
  assert.equal(generated, 0)
  assert.equal(reads, 0)
})

test('ledger response validation enforces binary payment graphs, aggregates, and command relationships', async () => {
  const correctedAt = '2026-08-04T12:00:00.000Z'
  const valid = ledgerAppointment({
    version: 5, status: 'completed', updatedAt: correctedAt,
    payment: {
      status: 'partial', collectedGrosze: 300, outstandingGrosze: 17_700,
      latestMethod: 'transfer', latestReceivedAt: '2026-08-04T10:30:00.000Z',
    },
    paymentEntries: [{
      id: 'pay_A-entry', amountGrosze: 100, method: 'cash',
      receivedAt: '2026-08-04T10:00:00.000Z',
      correctedAt: '2026-08-04T11:00:00.000Z',
      replacementEntryId: 'pay_A_entry',
    }, {
      id: 'pay_A_entry', amountGrosze: 200, method: 'card',
      receivedAt: '2026-08-04T10:00:00.000Z', correctedAt,
      replacementEntryId: 'pay_a-entry',
    }, {
      id: 'pay_a-entry', amountGrosze: 300, method: 'transfer',
      receivedAt: '2026-08-04T10:30:00.000Z', correctedAt: null,
      replacementEntryId: null,
    }],
  })
  const acceptedQueue = queuedFetch(
    jsonResponse(sessionBody()), jsonResponse(appointmentEnvelope(valid)),
  )
  const acceptedClient = createApiClient({ fetchImpl: acceptedQueue.fetchImpl })
  await acceptedClient.getSession()
  const accepted = await acceptedClient.correctPayment('pay_A_entry', 4, {
    reason: 'Łańcuch korekt', replacement: {
      amountGrosze: 300, method: 'transfer', receivedAt: '2026-08-04T10:30:00.000Z',
    },
  }, { idempotencyKey: 'ledger-graph-key-0001' })
  assert.equal(accepted.paymentEntries[2].id, 'pay_a-entry')
  assertDeepFrozen(accepted)

  const cases = [
    ['wrong envelope', { appointment: valid }],
    ['wrong target', appointmentEnvelope({
      ...valid,
      paymentEntries: valid.paymentEntries.map((entry) => entry.id === 'pay_A_entry'
        ? { ...entry, id: 'pay_other' } : entry),
    })],
    ['wrong version', appointmentEnvelope({ ...valid, version: 6 })],
    ['wrong aggregate', appointmentEnvelope({
      ...valid, payment: { ...valid.payment, collectedGrosze: 301 },
    })],
    ['locale rather than binary order', appointmentEnvelope({
      ...valid, paymentEntries: [valid.paymentEntries[1], valid.paymentEntries[0], valid.paymentEntries[2]],
    })],
    ['reverse-time link', appointmentEnvelope({
      ...valid,
      paymentEntries: valid.paymentEntries.map((entry, index) => index === 1
        ? { ...entry, receivedAt: '2026-08-04T09:59:00.000Z' } : entry),
    })],
    ['equal correction chronology', appointmentEnvelope({
      ...valid,
      paymentEntries: valid.paymentEntries.map((entry, index) => index === 0
        ? { ...entry, correctedAt } : entry),
    })],
    ['cycle', appointmentEnvelope({
      ...valid,
      paymentEntries: valid.paymentEntries.map((entry, index) => index === 2
        ? { ...entry, correctedAt, replacementEntryId: 'pay_A-entry' } : entry),
      payment: {
        status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
        latestMethod: null, latestReceivedAt: null,
      },
    })],
  ]
  for (const [name, body] of cases) {
    await test(name, async () => {
      const queued = queuedFetch(jsonResponse(sessionBody()), parsedResponse(body))
      const client = createApiClient({ fetchImpl: queued.fetchImpl })
      await client.getSession()
      await assert.rejects(client.correctPayment('pay_A_entry', 4, {
        reason: 'Łańcuch korekt', replacement: {
          amountGrosze: 300, method: 'transfer', receivedAt: '2026-08-04T10:30:00.000Z',
        },
      }, { idempotencyKey: 'ledger-invalid-key-0001' }), (error) => {
        assertInvalidResponse(error)
        assert.equal(error.idempotencyKey, 'ledger-invalid-key-0001')
        return true
      })
    })
  }
})

test('ledger commands reject impossible charge and appointment lifecycle versions', async () => {
  const editResponse = ledgerAppointment({
    version: 2, updatedAt: '2026-08-04T09:00:00.000Z', charge: { version: 257 },
  })
  const correctionResponse = ledgerAppointment({
    version: 2, status: 'completed', updatedAt: '2026-08-04T10:00:00.000Z',
    payment: {
      status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
      latestMethod: null, latestReceivedAt: null,
    },
    paymentEntries: [{
      id: 'pay_impossible', amountGrosze: 1_000, method: 'cash',
      receivedAt: '2026-08-04T09:00:00.000Z',
      correctedAt: '2026-08-04T10:00:00.000Z', replacementEntryId: null,
    }],
  })
  const queued = queuedFetch(
    jsonResponse(sessionBody()), jsonResponse(appointmentEnvelope(editResponse)),
    jsonResponse(appointmentEnvelope(correctionResponse)),
  )
  const client = createApiClient({ fetchImpl: queued.fetchImpl })
  await client.getSession()
  await assert.rejects(client.editAppointment('apt_ola_august', 1, {
    specialistId: 'sp_anna', serviceId: 'zajecia', date: '2026-08-10', time: '10:00',
    durationMinutes: 50, expectedAmountGrosze: 18_000, location: 'Gabinet 1',
    status: 'scheduled',
  }, { idempotencyKey: 'ledger-charge-version-key-0001' }), assertInvalidResponse)
  await assert.rejects(client.correctPayment('pay_impossible', 1, {
    reason: 'Niemożliwa historia', replacement: null,
  }, { idempotencyKey: 'ledger-correction-version-key-0002' }), assertInvalidResponse)
  assert.equal(queued.calls.length, 3)
})

test('ledger commands reuse one key for one CSRF refresh and require explicit replay after uncertainty', async () => {
  let generated = 0
  const refreshed = sessionBody({
    csrfToken: TOKEN_B, csrfExpiresAt: '2033-05-18T03:33:18.000Z',
  })
  const created = ledgerAppointment()
  const queued = queuedFetch(
    jsonResponse(sessionBody()), errorResponse('CSRF_EXPIRED', 403),
    jsonResponse(refreshed), jsonResponse(appointmentEnvelope(created), 201),
    new Error('private uncertain ledger transport'),
    jsonResponse(appointmentEnvelope(created), 201),
  )
  const client = createApiClient({
    fetchImpl: queued.fetchImpl,
    idempotencyKeyFactory: () => `ledger-generated-key-000${++generated}`,
  })
  await client.getSession()
  await client.createAppointment(appointmentInput())
  assert.equal(generated, 1)
  assert.equal(header(queued.calls[1], 'Idempotency-Key'), 'ledger-generated-key-0001')
  assert.equal(header(queued.calls[3], 'Idempotency-Key'), 'ledger-generated-key-0001')
  assert.equal(header(queued.calls[1], 'X-CSRF-Token'), TOKEN_A)
  assert.equal(header(queued.calls[3], 'X-CSRF-Token'), TOKEN_B)

  let retryKey
  await assert.rejects(client.createAppointment(appointmentInput()), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.idempotencyKey, 'ledger-generated-key-0002')
    assert.doesNotMatch(JSON.stringify(error), /private uncertain/)
    retryKey = error.idempotencyKey
    return true
  })
  assert.equal(queued.calls.length, 5)
  await client.createAppointment(appointmentInput(), { idempotencyKey: retryKey })
  assert.equal(queued.calls.length, 6)
  assert.equal(queued.calls[4].init.body, queued.calls[5].init.body)
  assert.equal(header(queued.calls[4], 'Idempotency-Key'), retryKey)
  assert.equal(header(queued.calls[5], 'Idempotency-Key'), retryKey)
})

test('ledger create accepts the exact zero-collected billable aggregate', async () => {
  const completed = ledgerAppointment({
    status: 'completed', payment: { outstandingGrosze: 18_000 },
  })
  const queued = queuedFetch(
    jsonResponse(sessionBody()), jsonResponse(appointmentEnvelope(completed), 201),
  )
  const client = createApiClient({ fetchImpl: queued.fetchImpl })
  await client.getSession()
  const result = await client.createAppointment(appointmentInput({ status: 'completed' }), {
    idempotencyKey: 'ledger-billable-key-0001',
  })
  assert.equal(result.payment.outstandingGrosze, 18_000)
})

test('ledger correction responses must prove a post-creation mutation instant', async () => {
  const instant = '2026-08-04T08:00:00.000Z'
  const malformed = ledgerAppointment({
    version: 2, status: 'completed', createdAt: instant, updatedAt: instant,
    payment: {
      status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
      latestMethod: null, latestReceivedAt: null,
    },
    paymentEntries: [{
      id: 'pay_original', amountGrosze: 1, method: 'cash', receivedAt: instant,
      correctedAt: instant, replacementEntryId: null,
    }],
  })
  const queued = queuedFetch(
    jsonResponse(sessionBody()), jsonResponse(appointmentEnvelope(malformed)),
  )
  const client = createApiClient({ fetchImpl: queued.fetchImpl })
  await client.getSession()
  await assert.rejects(client.correctPayment('pay_original', 1, {
    reason: 'Usunięcie wpisu', replacement: null,
  }, { idempotencyKey: 'ledger-instant-key-0001' }), assertInvalidResponse)
})
