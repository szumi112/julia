import { describe, expect, it, vi } from 'vitest'
import { CORE_ROUTE_DESCRIPTORS, createApp } from '../../worker/app.js'
import {
  areSiblingD1QueryBudgetViews,
  createD1QueryBudget,
  D1_QUERY_BUDGET_EXCEEDED,
  usageForD1QueryBudgetViews,
} from '../../worker/db/query-budget.js'
import { safeLog } from '../../worker/logging/safe-log.js'

const deps = (overrides = {}) => ({
  config: {
    appEnv: 'staging',
    appOrigin: 'https://bearwithme-panel.app',
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

  it('logs only a safe JWT diagnostic category while keeping the response generic', async () => {
    const log = vi.fn()
    const failure = new Error('ACCESS_ASSERTION_INVALID')
    Object.defineProperty(failure, 'diagnosticCode', {
      enumerable: false,
      value: 'ACCESS_JWT_AUDIENCE_INVALID',
    })
    const response = await createApp(deps({
      resolveAccessPrincipal: vi.fn(async () => { throw failure }),
      safeLog: log,
    })).request('/api/v1/session')

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'ACCESS_ASSERTION_INVALID' },
    })
    expect(log).toHaveBeenCalledWith('warn', expect.objectContaining({
      errorCode: 'ACCESS_JWT_AUDIENCE_INVALID',
      routeId: 'session',
      status: 401,
    }))
  })
})

describe('closed core route descriptors', () => {
  const origin = 'https://bearwithme-panel.app'
  const commands = [
    ['/api/v1/clients/cl_one/edits', { expectedVersion: 1, name: 'Ala', age: 12, status: 'active', specialistId: 'sp_one' }],
    ['/api/v1/clients/cl_one/archive', { expectedVersion: 1 }],
    ['/api/v1/appointments', { clientId: 'cl_one', specialistId: 'sp_one', serviceId: 'zajecia', date: '2026-08-04', time: '10:00', durationMinutes: 50, expectedAmountGrosze: 20000, location: null, status: 'scheduled' }],
    ['/api/v1/appointments/apt_one/edits', { expectedVersion: 1, specialistId: 'sp_one', serviceId: 'zajecia', date: '2026-08-04', time: '10:00', durationMinutes: 50, expectedAmountGrosze: 20000, location: null, status: 'scheduled' }],
    ['/api/v1/appointments/apt_one/cancellation', { expectedVersion: 1 }],
    ['/api/v1/appointments/apt_one/payments', { expectedVersion: 1, amountGrosze: 10000, method: 'card', receivedAt: '2026-08-04T10:00:00.000Z' }],
    ['/api/v1/payments/pay_one/corrections', { expectedVersion: 1, reason: 'Korekta', replacement: null }],
  ]
  const futureCommands = commands.slice(6)
  const headers = {
    origin,
    'content-type': 'application/json',
    'idempotency-key': 'core-command-key-0001',
    'x-csrf-token': 'valid',
  }

  it('publishes only immutable nonfunctional route metadata with registered audit actions', () => {
    expect(CORE_ROUTE_DESCRIPTORS.map(({ id, capability, auditActions, bodyKeys, sharedBudget }) => ({
      id, capability, auditActions, bodyKeys, sharedBudget,
    }))).toEqual([
      { id: 'workspace', capability: 'client.operational.read', auditActions: [], bodyKeys: null, sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'specialists.create', capability: 'staff.manage', auditActions: ['specialist.profile.created'], bodyKeys: ['displayName', 'standardRateGrosze'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'specialists.edit', capability: 'staff.manage', auditActions: ['specialist.profile.updated'], bodyKeys: ['expectedVersion', 'displayName', 'standardRateGrosze'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'clients.create', capability: 'client.manage', auditActions: ['client.created'], bodyKeys: ['name', 'age', 'status', 'specialistId'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'clients.edit', capability: 'client.manage', auditActions: ['client.updated', 'client.assignment.changed'], bodyKeys: ['expectedVersion', 'name', 'age', 'status', 'specialistId'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'clients.archive', capability: 'client.manage', auditActions: ['client.archived'], bodyKeys: ['expectedVersion'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'appointments.create', capability: 'appointment.manage', auditActions: ['appointment.created'], bodyKeys: ['clientId', 'specialistId', 'serviceId', 'date', 'time', 'durationMinutes', 'expectedAmountGrosze', 'location', 'status'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'appointments.edit', capability: 'appointment.manage', auditActions: ['appointment.updated'], bodyKeys: ['expectedVersion', 'specialistId', 'serviceId', 'date', 'time', 'durationMinutes', 'expectedAmountGrosze', 'location', 'status'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'appointments.cancel', capability: 'appointment.manage', auditActions: ['appointment.cancelled'], bodyKeys: ['expectedVersion'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'appointments.payment', capability: 'payment.manage', auditActions: ['payment.recorded'], bodyKeys: ['expectedVersion', 'amountGrosze', 'method', 'receivedAt'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'payments.correct', capability: 'payment.manage', auditActions: ['payment.corrected'], bodyKeys: ['expectedVersion', 'reason', 'replacement'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'finance.list', capability: 'finance.centre.read', auditActions: [], bodyKeys: null, sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'finance.import.start', capability: 'finance.centre.manage', auditActions: ['finance.import.started'], bodyKeys: ['filename', 'fingerprint', 'formatVersion', 'totalRows'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'finance.import.chunk', capability: 'finance.centre.manage', auditActions: ['finance.import.chunk.accepted'], bodyKeys: ['sequence', 'entries'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
      { id: 'finance.import.commit', capability: 'finance.centre.manage', auditActions: ['finance.import.committed'], bodyKeys: ['expectedVersion'], sharedBudget: { totalLimit: 50, recoveryReserve: 8 } },
    ])
    expect(Object.isFrozen(CORE_ROUTE_DESCRIPTORS)).toBe(true)
    expect(CORE_ROUTE_DESCRIPTORS.every((route) => Object.isFrozen(route)
      && !Object.hasOwn(route, 'handler') && !Object.hasOwn(route, 'service'))).toBe(true)
    const assertDeeplyFrozen = (value) => {
      if (!value || typeof value !== 'object') return
      expect(value).not.toBeInstanceOf(RegExp)
      expect(Object.isFrozen(value)).toBe(true)
      for (const child of Object.values(value)) assertDeeplyFrozen(child)
    }
    assertDeeplyFrozen(CORE_ROUTE_DESCRIPTORS)
    expect(CORE_ROUTE_DESCRIPTORS.filter(({ pathPattern }) => pathPattern)
      .every(({ pathPattern }) => typeof pathPattern === 'string')).toBe(true)
    expect(() => {
      CORE_ROUTE_DESCRIPTORS[0].sharedBudget.totalLimit = 1
    }).toThrow(TypeError)
  })

  it.each(futureCommands)('validates the closed shell once and keeps future route %s nonfunctional', async (path, body) => {
    const readJsonBodyOnce = vi.fn(async () => body)
    const input = deps({ db: coreBudgetDb(), readJsonBodyOnce, verifyCsrfToken: vi.fn(async () => true) })
    const response = await createApp(input).request(path, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('NOT_FOUND')
    expect(readJsonBodyOnce).toHaveBeenCalledOnce()
    expect(readJsonBodyOnce).toHaveBeenCalledWith(expect.any(Request), {
      rejectDuplicateTopLevelKeys: true,
    })
    expect(input.resolveAccessPrincipal).toHaveBeenCalledOnce()
    expect(input.resolveActor).toHaveBeenCalledOnce()
  })

  it('dispatches client edit through the authentic shared command boundary', async () => {
    let views
    const editClient = vi.fn(async (input) => {
      views = { work: input.db, recovery: input.recoveryDb }
      expect(input).toMatchObject({
        clientId: 'cl_one',
        idempotencyKey: 'core-command-key-0001',
        body: { expectedVersion: 1, name: 'Ala', age: 12, status: 'active', specialistId: 'sp_one' },
      })
      await input.db.prepare('SELECT edit_domain_1').first()
      await input.db.prepare('SELECT edit_domain_2').first()
      return { status: 200, body: { data: { client: { id: input.clientId } } } }
    })
    const input = deps({
      db: coreBudgetDb(), editClient,
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
    })
    const response = await createApp(input).request('/api/v1/clients/cl_one/edits', {
      method: 'POST', headers, body: JSON.stringify(commands[0][1]),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { client: { id: 'cl_one' } } })
    expect(editClient).toHaveBeenCalledOnce()
    expect(areSiblingD1QueryBudgetViews(views.work, views.recovery)).toBe(true)
    expect(usageForD1QueryBudgetViews(views.work, views.recovery)).toEqual({
      used: 2, remaining: 48, workRemaining: 40, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('dispatches client archive through the authentic shared command boundary', async () => {
    let views
    const archiveClient = vi.fn(async (input) => {
      views = { work: input.db, recovery: input.recoveryDb }
      expect(input).toMatchObject({
        clientId: 'cl_one', idempotencyKey: 'core-command-key-0001',
        body: { expectedVersion: 1 },
      })
      await input.db.prepare('SELECT archive_domain_1').first()
      return { status: 200, body: { data: { client: { id: input.clientId, status: 'archived' } } } }
    })
    const input = deps({
      db: coreBudgetDb(), archiveClient, verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
    })
    const response = await createApp(input).request('/api/v1/clients/cl_one/archive', {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: 1 }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { client: { id: 'cl_one', status: 'archived' } } })
    expect(archiveClient).toHaveBeenCalledOnce()
    expect(areSiblingD1QueryBudgetViews(views.work, views.recovery)).toBe(true)
    expect(usageForD1QueryBudgetViews(views.work, views.recovery)).toEqual({
      used: 1, remaining: 49, workRemaining: 41, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('dispatches appointment create through the authentic shared command boundary', async () => {
    let views
    const createAppointment = vi.fn(async (input) => {
      views = { work: input.db, recovery: input.recoveryDb }
      expect(input).toMatchObject({
        idempotencyKey: 'core-command-key-0001', body: commands[2][1],
      })
      await input.db.prepare('SELECT appointment_domain_1').first()
      return { status: 201, body: { data: { appointment: { id: 'apt_one' } } } }
    })
    const input = deps({
      db: coreBudgetDb(), createAppointment, verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
    })
    const response = await createApp(input).request('/api/v1/appointments', {
      method: 'POST', headers, body: JSON.stringify(commands[2][1]),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { appointment: { id: 'apt_one' } } })
    expect(createAppointment).toHaveBeenCalledOnce()
    expect(areSiblingD1QueryBudgetViews(views.work, views.recovery)).toBe(true)
  })

  it('dispatches appointment edit through the authentic shared command boundary', async () => {
    let views
    const editAppointment = vi.fn(async (input) => {
      views = { work: input.db, recovery: input.recoveryDb }
      expect(input).toMatchObject({
        appointmentId: 'apt_one', idempotencyKey: 'core-command-key-0001',
        body: commands[3][1],
      })
      await input.db.prepare('SELECT appointment_edit_domain_1').first()
      await input.db.prepare('SELECT appointment_edit_domain_2').first()
      return { status: 200, body: { data: { appointment: { id: input.appointmentId } } } }
    })
    const input = deps({
      db: coreBudgetDb(), editAppointment, verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
    })
    const response = await createApp(input).request('/api/v1/appointments/apt_one/edits', {
      method: 'POST', headers, body: JSON.stringify(commands[3][1]),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { appointment: { id: 'apt_one' } } })
    expect(editAppointment).toHaveBeenCalledOnce()
    expect(areSiblingD1QueryBudgetViews(views.work, views.recovery)).toBe(true)
    expect(usageForD1QueryBudgetViews(views.work, views.recovery)).toEqual({
      used: 2, remaining: 48, workRemaining: 40, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('dispatches appointment cancellation through the authentic shared command boundary', async () => {
    let views
    const cancelAppointment = vi.fn(async (input) => {
      views = { work: input.db, recovery: input.recoveryDb }
      expect(input).toMatchObject({
        appointmentId: 'apt_one', idempotencyKey: 'core-command-key-0001',
        body: commands[4][1],
      })
      await input.db.prepare('SELECT appointment_cancel_domain_1').first()
      return { status: 200, body: { data: { appointment: {
        id: input.appointmentId, status: 'cancelled',
      } } } }
    })
    const input = deps({
      db: coreBudgetDb(), cancelAppointment,
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
    })
    const response = await createApp(input).request(
      '/api/v1/appointments/apt_one/cancellation', {
        method: 'POST', headers, body: JSON.stringify(commands[4][1]),
      },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { appointment: {
      id: 'apt_one', status: 'cancelled',
    } } })
    expect(cancelAppointment).toHaveBeenCalledOnce()
    expect(areSiblingD1QueryBudgetViews(views.work, views.recovery)).toBe(true)
    expect(usageForD1QueryBudgetViews(views.work, views.recovery)).toEqual({
      used: 1, remaining: 49, workRemaining: 41,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('dispatches appointment payment through the authentic shared command boundary', async () => {
    let views
    const recordAppointmentPayment = vi.fn(async (input) => {
      views = { work: input.db, recovery: input.recoveryDb }
      expect(input).toMatchObject({
        appointmentId: 'apt_one', idempotencyKey: 'core-command-key-0001',
        body: commands[5][1],
      })
      await input.db.prepare('SELECT appointment_payment_domain_1').first()
      return { status: 200, body: { data: { appointment: {
        id: input.appointmentId, payment: { status: 'partial' },
      } } } }
    })
    const input = deps({
      db: coreBudgetDb(), recordAppointmentPayment,
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
    })
    const response = await createApp(input).request(
      '/api/v1/appointments/apt_one/payments', {
        method: 'POST', headers, body: JSON.stringify(commands[5][1]),
      },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { appointment: {
      id: 'apt_one', payment: { status: 'partial' },
    } } })
    expect(recordAppointmentPayment).toHaveBeenCalledOnce()
    expect(areSiblingD1QueryBudgetViews(views.work, views.recovery)).toBe(true)
  })

  it('dispatches payment correction through the authentic shared command boundary', async () => {
    let views
    const correctAppointmentPayment = vi.fn(async (input) => {
      views = { work: input.db, recovery: input.recoveryDb }
      expect(input).toMatchObject({
        paymentId: 'pay_one', idempotencyKey: 'core-command-key-0001',
        body: commands[6][1],
      })
      await input.db.prepare('SELECT payment_correction_domain_1').first()
      return { status: 200, body: { data: { appointment: {
        id: 'apt_one', payment: { status: 'unpaid' },
      } } } }
    })
    const input = deps({
      db: coreBudgetDb(), correctAppointmentPayment,
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
    })
    const response = await createApp(input).request(
      '/api/v1/payments/pay_one/corrections', {
        method: 'POST', headers, body: JSON.stringify(commands[6][1]),
      },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { appointment: {
      id: 'apt_one', payment: { status: 'unpaid' },
    } } })
    expect(correctAppointmentPayment).toHaveBeenCalledOnce()
    expect(areSiblingD1QueryBudgetViews(views.work, views.recovery)).toBe(true)
  })

  it('rejects idempotency and exact body-shape failures in the frozen shell order', async () => {
    const missingKey = deps({ db: coreBudgetDb(), resolveAccessPrincipal: vi.fn(), readJsonBodyOnce: vi.fn() })
    const first = await createApp(missingKey).request('/api/v1/clients', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-csrf-token': 'valid' },
      body: '{}',
    })
    expect(first.status).toBe(400)
    expect(missingKey.resolveAccessPrincipal).not.toHaveBeenCalled()
    expect(missingKey.readJsonBodyOnce).not.toHaveBeenCalled()

    for (const body of [
      { name: 'Ala', age: 12, status: 'active' },
      { name: 'Ala', age: 12, status: 'active', specialistId: 'sp_one', extra: true },
    ]) {
      const input = deps({
        db: coreBudgetDb(),
        verifyCsrfToken: vi.fn(async () => true),
        readJsonBodyOnce: vi.fn(async () => body),
      })
      const response = await createApp(input).request('/api/v1/clients', {
        method: 'POST', headers, body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED', details: { field: 'body' } },
      })
      expect(input.readJsonBodyOnce).toHaveBeenCalledOnce()
    }
  })

  it('rejects every non-descriptor command method with exact Allow before Access', async () => {
    for (const method of ['GET', 'HEAD', 'DELETE']) {
      const input = deps({ resolveAccessPrincipal: vi.fn(), resolveActor: vi.fn(), db: coreBudgetDb() })
      const response = await createApp(input).request('/api/v1/clients', { method })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST, OPTIONS')
      expect(input.resolveAccessPrincipal).not.toHaveBeenCalled()
      expect(input.resolveActor).not.toHaveBeenCalled()
    }
  })

  it('installs one shared budget before identity and passes it to workspace', async () => {
    const order = []
    const rawDb = coreBudgetDb(order)
    let actorWork
    let actorRecovery
    const input = deps({
      db: rawDb,
      cryptoContext: undefined,
      keyring: {},
      resolveAccessPrincipal: vi.fn(async () => {
        order.push('access')
        return { kind: 'human', subject: 'access-shell', normalizedEmail: 'shell@example.test' }
      }),
      resolveActor: vi.fn(async (work, _principal, _context, options) => {
        order.push('actor')
        actorWork = work
        actorRecovery = options.recoveryDb
        expect(areSiblingD1QueryBudgetViews(work, options.recoveryDb)).toBe(true)
        expect(usageForD1QueryBudgetViews(work, options.recoveryDb)).toEqual({
          used: 1, remaining: 49, workRemaining: 41, totalLimit: 50, recoveryReserve: 8,
        })
        await work.prepare('SELECT actor_one').first()
        await work.prepare('SELECT actor_two').first()
        expect(usageForD1QueryBudgetViews(work, options.recoveryDb)).toEqual({
          used: 3, remaining: 47, workRemaining: 39, totalLimit: 50, recoveryReserve: 8,
        })
        return { id: 'stf_core', role: 'owner', specialistId: null, version: 1 }
      }),
      getWorkspace: vi.fn(async ({ db }) => {
        expect(db).toBe(actorWork)
        return { data: { window: { from: '2026-08-01', to: '2026-08-31', timeZone: 'Europe/Warsaw', complete: true }, specialists: [], clients: [], appointments: [] } }
      }),
    })
    const response = await createApp(input).request('/api/v1/workspace?from=2026-08-01&to=2026-08-31')
    expect(response.status).toBe(200)
    expect(actorWork).not.toBe(rawDb)
    expect(actorRecovery).not.toBe(actorWork)
    expect(order).toEqual(['capture.prepare', 'capture.batch', 'access', 'query.data-key', 'actor'])
  })

  it('keeps a core GET at zero recovery usage when identity needs no database work', async () => {
    let views
    const input = deps({
      db: coreBudgetDb(),
      resolveActor: vi.fn(async (work, _principal, _context, { recoveryDb }) => {
        views = { work, recoveryDb }
        return { id: 'stf_core', role: 'owner', specialistId: null, version: 1 }
      }),
      getWorkspace: vi.fn(async () => ({ data: { window: { from: '2026-08-01', to: '2026-08-31', timeZone: 'Europe/Warsaw', complete: true }, specialists: [], clients: [], appointments: [] } })),
    })
    const response = await createApp(input).request('/api/v1/workspace?from=2026-08-01&to=2026-08-31')
    expect(response.status).toBe(200)
    expect(usageForD1QueryBudgetViews(views.work, views.recoveryDb)).toEqual({
      used: 0, remaining: 50, workRemaining: 42, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('enforces the exact 42 work plus 8 recovery ceilings at the core boundary', async () => {
    let finalUsage
    const input = deps({
      db: coreBudgetDb(),
      resolveActor: vi.fn(async (work, _principal, _context, { recoveryDb }) => {
        expect(usageForD1QueryBudgetViews(work, recoveryDb)).toEqual({
          used: 0, remaining: 50, workRemaining: 42, totalLimit: 50, recoveryReserve: 8,
        })
        for (let index = 0; index < 42; index += 1) await work.prepare(`SELECT work_${index}`).first()
        expect(() => work.prepare('SELECT work_over').first()).toThrow(D1_QUERY_BUDGET_EXCEEDED)
        for (let index = 0; index < 8; index += 1) await recoveryDb.prepare(`SELECT recovery_${index}`).first()
        expect(() => recoveryDb.prepare('SELECT recovery_over').first()).toThrow(D1_QUERY_BUDGET_EXCEEDED)
        finalUsage = usageForD1QueryBudgetViews(work, recoveryDb)
        return { id: 'stf_core', role: 'owner', specialistId: null, version: 1 }
      }),
      getWorkspace: vi.fn(async () => ({ data: { window: { from: '2026-08-01', to: '2026-08-31', timeZone: 'Europe/Warsaw', complete: true }, specialists: [], clients: [], appointments: [] } })),
    })
    const response = await createApp(input).request('/api/v1/workspace?from=2026-08-01&to=2026-08-31')
    expect(response.status).toBe(200)
    expect(finalUsage).toEqual({
      used: 50, remaining: 0, workRemaining: 0, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('rejects malformed, nested, and hostile core databases before Access', async () => {
    let hostileReads = 0
    const baseBudget = createD1QueryBudget(coreBudgetDb(), { totalLimit: 50, recoveryReserve: 8 })
    const candidates = [
      { prepare() {}, batch: null },
      baseBudget.work,
      Object.defineProperties({}, {
        prepare: { get() { hostileReads += 1; throw new Error('private prepare') } },
        batch: { get() { hostileReads += 1; throw new Error('private batch') } },
      }),
    ]
    for (const db of candidates) {
      const input = deps({ db, resolveAccessPrincipal: vi.fn() })
      const response = await createApp(input).request('/api/v1/workspace?from=2026-08-01&to=2026-08-31')
      expect(response.status).toBe(500)
      expect(input.resolveAccessPrincipal).not.toHaveBeenCalled()
    }
    expect(hostileReads).toBe(1)
  })

  it.each(commands)('returns exact command Allow and authenticates OPTIONS without CSRF or body for %s', async (path) => {
    const input = deps({ verifyCsrfToken: vi.fn(), readJsonBodyOnce: vi.fn(), db: coreBudgetDb() })
    const response = await createApp(input).request(path, { method: 'OPTIONS', headers: { origin } })
    expect(response.status).toBe(204)
    expect(response.headers.get('allow')).toBe('POST, OPTIONS')
    expect(input.resolveAccessPrincipal).toHaveBeenCalledOnce()
    expect(input.resolveActor).toHaveBeenCalledOnce()
    expect(input.verifyCsrfToken).not.toHaveBeenCalled()
    expect(input.readJsonBodyOnce).not.toHaveBeenCalled()
  })

  it('returns exact workspace Allow and rejects aliases and mutation queries', async () => {
    const options = await createApp(deps({ db: coreBudgetDb() })).request('/api/v1/workspace?from=2026-08-01&to=2026-08-31', { method: 'OPTIONS', headers: { origin } })
    expect(options.status).toBe(204)
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    for (const path of [
      '/api/v1/clients/cl_one/edits/',
      '/api/v1/clients/%63l_one/edits',
      '/api/v1/clients/client_one/edits',
      '/api/v1/appointments/apt_one/edits/extra',
      '/api/v1/payments/apt_one/corrections',
      '/api/v1/clients?unexpected=1',
    ]) {
      const input = deps({ db: coreBudgetDb(), verifyCsrfToken: vi.fn(async () => true), readJsonBodyOnce: vi.fn(async () => ({})) })
      const response = await createApp(input).request(path, { method: 'POST', headers, body: '{}' })
      expect(response.status).toBe(404)
    }
  })

  it('preserves raw D1 identity for an existing non-core route', async () => {
    const rawDb = coreBudgetDb()
    const service = vi.fn(async ({ db }) => { expect(db).toBe(rawDb); return { data: { ok: true } } })
    const input = deps({ db: rawDb, getOperationalHealth: service, resolveActor: vi.fn(async (db) => { expect(db).toBe(rawDb); return { id: 'stf_non_core', role: 'owner', specialistId: null, version: 1 } }) })
    expect((await createApp(input).request('/api/v1/operations/health')).status).toBe(200)
    expect(service).toHaveBeenCalledOnce()
  })
})

describe('operations HTTP shell', () => {
  const correlationId = '11111111-1111-4111-8111-111111111111'
  const origin = 'https://bearwithme-panel.app'
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
