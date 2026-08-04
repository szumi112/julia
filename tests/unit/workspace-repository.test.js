import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createApiWorkspaceRepository,
  createDemoWorkspaceRepository,
} from '../../src/workspace-repository.js'

const METHODS = [
  'archiveClient', 'cancelAppointment', 'correctPayment', 'createAppointment',
  'createClient', 'editAppointment', 'editClient', 'loadWindow', 'recordPayment',
]

const clientInput = (overrides = {}) => ({
  name: 'Ola Nowak', age: 12, status: 'active', specialistId: 'sp_anna', ...overrides,
})

const appointmentInput = (overrides = {}) => ({
  clientId: 'cl_ola', specialistId: 'sp_anna', serviceId: 'zajecia',
  date: '2026-08-10', time: '10:00', durationMinutes: 50,
  expectedAmountGrosze: 18_000, location: null, status: 'scheduled', ...overrides,
})

const apiDouble = () => {
  const calls = []
  let key = 0
  const api = {
    loadWorkspaceWindow: async (...args) => (calls.push(['loadWorkspaceWindow', ...args]), Object.freeze({ kind: 'window' })),
    createClient: async (...args) => (calls.push(['createClient', ...args]), Object.freeze({ kind: 'client' })),
    editClient: async (...args) => (calls.push(['editClient', ...args]), Object.freeze({ kind: 'client' })),
    archiveClient: async (...args) => (calls.push(['archiveClient', ...args]), Object.freeze({ kind: 'client' })),
    createAppointment: async (...args) => (calls.push(['createAppointment', ...args]), Object.freeze({ kind: 'appointment' })),
    editAppointment: async (...args) => (calls.push(['editAppointment', ...args]), Object.freeze({ kind: 'appointment' })),
    cancelAppointment: async (...args) => (calls.push(['cancelAppointment', ...args]), Object.freeze({ kind: 'appointment' })),
    recordPayment: async (...args) => (calls.push(['recordPayment', ...args]), Object.freeze({ kind: 'appointment' })),
    correctPayment: async (...args) => (calls.push(['correctPayment', ...args]), Object.freeze({ kind: 'appointment' })),
    createIdempotencyKey: () => `repository-key-${String(++key).padStart(4, '0')}`,
  }
  return { api, calls }
}

test('constructors expose one exact frozen repository interface', () => {
  const { api } = apiDouble()
  const apiRepository = createApiWorkspaceRepository({ api })
  const demoRepository = createDemoWorkspaceRepository({ dispatch() {}, getState: () => ({ psychologists: [], clients: [], sessions: [] }) })
  for (const repository of [apiRepository, demoRepository]) {
    assert.deepEqual(Object.keys(repository).sort(), METHODS)
    assert.equal(Object.isFrozen(repository), true)
    for (const method of METHODS) assert.equal(typeof repository[method], 'function')
  }
})

test('API repository delegates every command with exact captured arguments and fresh action keys', async () => {
  const { api, calls } = apiDouble()
  const repository = createApiWorkspaceRepository({ api })
  const create = clientInput()
  const edit = clientInput({ status: 'paused' })
  const appointment = appointmentInput()
  const appointmentEdit = { ...appointmentInput({ status: 'completed' }) }
  delete appointmentEdit.clientId

  const results = await Promise.all([
    repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' }),
    repository.createClient(create),
    repository.editClient('cl_ola', 1, edit),
    repository.archiveClient('cl_ola', 2),
    repository.createAppointment(appointment),
    repository.editAppointment('apt_visit', 3, appointmentEdit),
    repository.cancelAppointment('apt_visit', 4),
    repository.recordPayment('apt_visit', 5, { amountGrosze: 7_000, method: 'card', paidDate: '2026-08-04' }),
    repository.correctPayment('pay_entry', 6, { reason: 'Zmiana metody', replacement: { amountGrosze: 6_000, method: 'transfer', paidDate: '2026-01-04' } }),
  ])

  assert.deepEqual(results.map((value) => value.kind), [
    'window', 'client', 'client', 'client', 'appointment', 'appointment',
    'appointment', 'appointment', 'appointment',
  ])
  assert.deepEqual(calls, [
    ['loadWorkspaceWindow', { from: '2026-08-01', to: '2026-08-31' }],
    ['createClient', create, { idempotencyKey: 'repository-key-0001' }],
    ['editClient', 'cl_ola', 1, edit, { idempotencyKey: 'repository-key-0002' }],
    ['archiveClient', 'cl_ola', 2, { idempotencyKey: 'repository-key-0003' }],
    ['createAppointment', appointment, { idempotencyKey: 'repository-key-0004' }],
    ['editAppointment', 'apt_visit', 3, appointmentEdit, { idempotencyKey: 'repository-key-0005' }],
    ['cancelAppointment', 'apt_visit', 4, { idempotencyKey: 'repository-key-0006' }],
    ['recordPayment', 'apt_visit', 5, { amountGrosze: 7_000, method: 'card', receivedAt: '2026-08-04T10:00:00.000Z' }, { idempotencyKey: 'repository-key-0007' }],
    ['correctPayment', 'pay_entry', 6, { reason: 'Zmiana metody', replacement: { amountGrosze: 6_000, method: 'transfer', receivedAt: '2026-01-04T11:00:00.000Z' } }, { idempotencyKey: 'repository-key-0008' }],
  ])
  assert.deepEqual(create, clientInput())
  assert.deepEqual(appointment, appointmentInput())
})

test('API payment compatibility handles leap day, null correction, and rejects invalid dates before keys or calls', async () => {
  const { api, calls } = apiDouble()
  const repository = createApiWorkspaceRepository({ api })
  await repository.recordPayment('apt_visit', 1, { amountGrosze: 1, method: 'cash', paidDate: '2028-02-29' })
  await repository.correctPayment('pay_entry', 2, { reason: 'Zwrot', replacement: null })
  assert.equal(calls[0][3].receivedAt, '2028-02-29T11:00:00.000Z')
  assert.equal(calls[1][3].replacement, null)
  const before = calls.length
  for (const paidDate of ['2026-02-29', '2026-03-29T12:00', '']) {
    await assert.rejects(repository.recordPayment('apt_visit', 1, { amountGrosze: 1, method: 'cash', paidDate }), /VALIDATION_FAILED/)
  }
  assert.equal(calls.length, before)
})

test('hostile constructor dependencies and command values fail without getters or partial calls', async () => {
  let reads = 0
  const { api, calls } = apiDouble()
  const accessorApi = { ...api }
  Object.defineProperty(accessorApi, 'createClient', { enumerable: true, get() { reads += 1; return api.createClient } })
  assert.throws(() => createApiWorkspaceRepository({ api: accessorApi }), /VALIDATION_FAILED/)
  assert.equal(reads, 0)
  assert.throws(() => createApiWorkspaceRepository({ api: { ...api, extra() {} } }), /VALIDATION_FAILED/)

  const repository = createApiWorkspaceRepository({ api })
  const hostile = Object.defineProperty(clientInput(), 'name', {
    enumerable: true, get() { reads += 1; return 'Private' },
  })
  await assert.rejects(repository.createClient(hostile), /VALIDATION_FAILED/)
  assert.equal(reads, 0)
  assert.equal(calls.length, 0)
})

test('API repository rejects a malformed generated action key before invoking a command', async () => {
  const { api, calls } = apiDouble()
  api.createIdempotencyKey = () => 'bad key'
  const repository = createApiWorkspaceRepository({ api })
  await assert.rejects(repository.createClient(clientInput()), /VALIDATION_FAILED\/idempotencyKey/)
  assert.deepEqual(calls, [])
})

const demoState = () => ({
  psychologists: [
    { id: 'p2', name: 'Żaneta', rate: 200 },
    { id: 'p1', name: 'Anna', rate: 180 },
  ],
  clients: [
    { id: 'c2', name: 'Zenon', age: 10, psychId: 'p2', since: '2026-01-02', status: 'paused', email: 'private@example.test', phone: 'secret', notes: ['secret'], familyId: 'f1', familyRole: 'dziecko' },
    { id: 'c1', name: 'Ada', age: 8, psychId: 'p1', since: '2026-01-01', status: 'active', email: 'private@example.test', phone: 'secret', notes: ['secret'], familyId: null, familyRole: null },
  ],
  sessions: [
    { id: 's2', clientId: 'c2', psychId: 'p2', service: 'zajecia', date: '2026-09-01', time: '10:00', duration: 50, amount: 200, status: 'scheduled', payment: 'unpaid', paidAmount: 0, method: null, note: 'secret' },
    { id: 's1', clientId: 'c1', psychId: 'p1', service: 'zajecia', date: '2026-08-04', time: '09:00', duration: 50, amount: 180, status: 'completed', payment: 'partial', paidAmount: 70, method: 'cash', paidDate: '2026-08-05', note: 'secret' },
  ],
})

const demoHarness = () => {
  let state = demoState()
  let sequence = 10
  const actions = []
  const dispatch = (action) => {
    actions.push(structuredClone(action))
    if (action.type === 'ADD_CLIENT') state = { ...state, clients: [...state.clients, { ...action.client, id: `c${++sequence}`, familyId: null, familyRole: null }] }
    if (action.type === 'UPDATE_CLIENT') state = { ...state, clients: state.clients.map((item) => item.id === action.id ? { ...item, ...action.patch } : item) }
    if (action.type === 'DELETE_CLIENT') state = { ...state, clients: state.clients.filter((item) => item.id !== action.id), sessions: state.sessions.filter((item) => item.clientId !== action.id) }
    if (action.type === 'ADD_SESSION') state = { ...state, sessions: [...state.sessions, { ...action.session, id: `s${++sequence}` }] }
    if (action.type === 'UPDATE_SESSION') state = { ...state, sessions: state.sessions.map((item) => item.id === action.id ? { ...item, ...action.patch } : item) }
    if (action.type === 'DELETE_SESSION') state = { ...state, sessions: state.sessions.filter((item) => item.id !== action.id) }
  }
  return { actions, dispatch, getState: () => state }
}

test('demo load projects a complete ordered canonical window without excluded fields', async () => {
  const harness = demoHarness()
  const repository = createDemoWorkspaceRepository({ dispatch: harness.dispatch, getState: harness.getState })
  const result = await repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' })
  assert.deepEqual(result.window, { from: '2026-08-01', to: '2026-08-31', timeZone: 'Europe/Warsaw', complete: true })
  assert.deepEqual(result.specialists.map(({ id, displayName }) => [id, displayName]), [['sp_demo_p1', 'Anna'], ['sp_demo_p2', 'Żaneta']])
  assert.deepEqual(result.clients.map(({ id, name }) => [id, name]), [['cl_demo_c1', 'Ada'], ['cl_demo_c2', 'Zenon']])
  assert.equal(result.appointments.length, 1)
  assert.equal(result.appointments[0].id, 'apt_demo_s1')
  assert.equal(result.appointments[0].clientId, 'cl_demo_c1')
  assert.equal(result.appointments[0].charge.expectedAmountGrosze, 18_000)
  assert.equal(result.appointments[0].payment.collectedGrosze, 7_000)
  assert.equal(result.appointments[0].paymentEntries[0].receivedAt, '2026-08-05T10:00:00.000Z')
  assert.equal(JSON.stringify(result).includes('private@example.test'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(Object.isFrozen(result.appointments[0].paymentEntries[0]), true)
  assert.equal(harness.actions.length, 0)
})

test('demo client lifecycle dispatches legacy actions and keeps core IDs and versions deterministic', async () => {
  const harness = demoHarness()
  const repository = createDemoWorkspaceRepository({ dispatch: harness.dispatch, getState: harness.getState })
  const created = await repository.createClient(clientInput({ specialistId: 'sp_demo_p1' }))
  assert.equal(created.id, 'cl_demo_new_1')
  assert.equal(created.version, 1)
  assert.deepEqual(harness.actions[0], {
    type: 'ADD_CLIENT',
    client: { name: 'Ola Nowak', age: 12, status: 'active', psychId: 'p1', since: created.createdAt.slice(0, 10), email: '', phone: '', notes: [], familyId: null, familyRole: null },
  })
  const edited = await repository.editClient(created.id, 1, clientInput({ name: 'Ola Kowalska', specialistId: 'sp_demo_p2' }))
  assert.equal(edited.version, 2)
  assert.equal(edited.assignment.specialistId, 'sp_demo_p2')
  assert.deepEqual(harness.actions[1], { type: 'UPDATE_CLIENT', id: 'c11', patch: { name: 'Ola Kowalska', age: 12, status: 'active', psychId: 'p2' } })
  const archived = await repository.archiveClient(created.id, 2)
  assert.equal(archived.status, 'archived')
  assert.equal(archived.version, 3)
  assert.deepEqual(harness.actions[2], { type: 'DELETE_CLIENT', id: 'c11' })
  await assert.rejects(repository.editClient(created.id, 2, clientInput({ specialistId: 'sp_demo_p1' })), /NOT_FOUND/)
  assert.equal(harness.actions.length, 3)
})

test('demo appointment and payment lifecycle preserves cents, versions, reversal links, and reducer actions', async () => {
  const harness = demoHarness()
  const repository = createDemoWorkspaceRepository({ dispatch: harness.dispatch, getState: harness.getState })
  const created = await repository.createAppointment(appointmentInput({ clientId: 'cl_demo_c1', specialistId: 'sp_demo_p1' }))
  assert.equal(created.id, 'apt_demo_new_1')
  assert.equal(created.charge.expectedAmountGrosze, 18_000)
  assert.equal(harness.actions[0].type, 'ADD_SESSION')
  assert.equal(harness.actions[0].session.amount, 180)
  assert.equal(harness.actions[0].session.note, '')

  const editInput = { ...appointmentInput({ specialistId: 'sp_demo_p2', status: 'completed', expectedAmountGrosze: 20_000 }) }
  delete editInput.clientId
  const edited = await repository.editAppointment(created.id, 1, editInput)
  assert.equal(edited.version, 2)
  assert.equal(edited.charge.version, 2)
  assert.equal(harness.actions[1].type, 'UPDATE_SESSION')
  assert.equal(harness.actions[1].patch.amount, 200)

  const recorded = await repository.recordPayment(created.id, 2, { amountGrosze: 7_001, method: 'card', paidDate: '2026-08-12' })
  assert.equal(recorded.version, 3)
  assert.equal(recorded.payment.collectedGrosze, 7_001)
  assert.equal(recorded.paymentEntries[0].id, 'pay_demo_new_1')
  assert.equal(harness.actions[2].patch.paidAmount, 70.01)
  assert.equal(harness.actions[2].patch.paidDate, '2026-08-12')

  const corrected = await repository.correctPayment('pay_demo_new_1', 3, { reason: 'Korekta', replacement: { amountGrosze: 6_002, method: 'transfer', paidDate: '2026-08-13' } })
  assert.equal(corrected.version, 4)
  assert.equal(corrected.payment.collectedGrosze, 6_002)
  assert.equal(corrected.paymentEntries[0].replacementEntryId, 'pay_demo_new_2')
  assert.equal(harness.actions[3].patch.paidAmount, 60.02)

  const second = await repository.createAppointment(appointmentInput({
    clientId: 'cl_demo_c1', specialistId: 'sp_demo_p1', date: '2026-08-20',
  }))
  const cancelled = await repository.cancelAppointment(second.id, 1)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.version, 2)
  assert.deepEqual(harness.actions[5], { type: 'DELETE_SESSION', id: 's12' })
})

test('demo rejects stale and missing targets before dispatch and never mutates caller or state', async () => {
  const harness = demoHarness()
  const initial = structuredClone(harness.getState())
  const repository = createDemoWorkspaceRepository({ dispatch: harness.dispatch, getState: harness.getState })
  const input = clientInput({ specialistId: 'sp_demo_p1' })
  await assert.rejects(repository.editClient('cl_demo_c1', 2, input), /VERSION_CONFLICT/)
  await assert.rejects(repository.cancelAppointment('apt_missing', 1), /NOT_FOUND/)
  await assert.rejects(repository.createAppointment(appointmentInput({ clientId: 'cl_missing', specialistId: 'sp_demo_p1' })), /NOT_FOUND/)
  assert.deepEqual(input, clientInput({ specialistId: 'sp_demo_p1' }))
  assert.deepEqual(harness.getState(), initial)
  assert.equal(harness.actions.length, 0)
})

test('demo reconciles delayed reducer IDs to command-returned core IDs', async () => {
  let state = demoState()
  let pending = null
  const repository = createDemoWorkspaceRepository({
    dispatch(action) { pending = structuredClone(action) },
    getState: () => state,
  })
  const created = await repository.createClient(clientInput({ specialistId: 'sp_demo_p1' }))
  assert.equal(created.id, 'cl_demo_new_1')
  state = { ...state, clients: [...state.clients, { ...pending.client, id: 'c99' }] }
  const loaded = await repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' })
  assert.equal(loaded.clients.find(({ name }) => name === 'Ola Nowak').id, created.id)
  assert.equal(loaded.clients.some(({ id }) => id === 'cl_demo_c99'), false)
})
