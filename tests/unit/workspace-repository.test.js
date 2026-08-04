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

test('API client versions above the appointment ceiling still delegate', async () => {
  const { api, calls } = apiDouble()
  const repository = createApiWorkspaceRepository({ api })
  await repository.editClient('cl_ola', 4_096, clientInput())
  await repository.archiveClient('cl_ola', 9_001)
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ['editClient', 'cl_ola', 4_096],
    ['archiveClient', 'cl_ola', 9_001],
  ])
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
    { id: 's1', clientId: 'c1', psychId: 'p1', service: 'zajecia', date: '2026-08-04', time: '09:00', duration: 50, amount: 180, location: 'Gabinet 1', status: 'completed', payment: 'partial', paidAmount: 70, method: 'cash', paidDate: '2026-08-05', note: 'secret' },
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
  assert.equal(result.appointments[0].location, 'Gabinet 1')
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
  const created = await repository.createAppointment(appointmentInput({ clientId: 'cl_demo_c1', specialistId: 'sp_demo_p1', location: 'Gabinet 2' }))
  assert.equal(created.id, 'apt_demo_new_1')
  assert.equal(created.charge.expectedAmountGrosze, 18_000)
  assert.equal(harness.actions[0].type, 'ADD_SESSION')
  assert.equal(harness.actions[0].session.amount, 180)
  assert.equal(harness.actions[0].session.location, 'Gabinet 2')
  assert.equal(harness.actions[0].session.note, '')

  const editInput = { ...appointmentInput({ specialistId: 'sp_demo_p2', status: 'completed', expectedAmountGrosze: 20_000, location: 'Sala TUS' }) }
  delete editInput.clientId
  const edited = await repository.editAppointment(created.id, 1, editInput)
  assert.equal(edited.version, 2)
  assert.equal(edited.charge.version, 2)
  assert.equal(harness.actions[1].type, 'UPDATE_SESSION')
  assert.equal(harness.actions[1].patch.amount, 200)
  assert.equal(harness.actions[1].patch.location, 'Sala TUS')
  assert.equal(edited.location, 'Sala TUS')

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

test('demo appointment edit treats a location-only change as a real mutation', async () => {
  const harness = demoHarness()
  const repository = createDemoWorkspaceRepository({ dispatch: harness.dispatch, getState: harness.getState })
  const edited = await repository.editAppointment('apt_demo_s2', 1, {
    specialistId: 'sp_demo_p2', serviceId: 'zajecia', date: '2026-09-01',
    time: '10:00', durationMinutes: 50, expectedAmountGrosze: 20_000,
    location: 'Gabinet 4', status: 'scheduled',
  })
  assert.equal(edited.location, 'Gabinet 4')
  assert.deepEqual(harness.actions[0], {
    type: 'UPDATE_SESSION', id: 's2', patch: {
      psychId: 'p2', service: 'zajecia', date: '2026-09-01', time: '10:00',
      duration: 50, amount: 200, location: 'Gabinet 4', status: 'scheduled',
    },
  })
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
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      queueMicrotask(() => { state = { ...state, clients: [...state.clients, { ...action.client, id: 'c99' }] } })
    },
    getState: () => state,
  })
  const created = await repository.createClient(clientInput({ specialistId: 'sp_demo_p1' }))
  assert.equal(created.id, 'cl_demo_new_1')
  const loaded = await repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' })
  assert.equal(loaded.clients.find(({ name }) => name === 'Ola Nowak').id, created.id)
  assert.equal(loaded.clients.some(({ id }) => id === 'cl_demo_c99'), false)
})

test('demo pending reconciliation cannot capture an identical pre-existing row', async () => {
  let state = demoState()
  state = { ...state, clients: [...state.clients, {
    id: 'c_old', name: 'Ola Nowak', age: 12, psychId: 'p1', since: '2026-01-03',
    status: 'active', email: '', phone: '', notes: [], familyId: null, familyRole: null,
  }] }
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      queueMicrotask(() => { state = { ...state, clients: [...state.clients, { ...action.client, id: 'c_new' }] } })
    },
    getState: () => state,
  })
  const created = await repository.createClient(clientInput({ specialistId: 'sp_demo_p1' }))
  const loaded = await repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' })
  assert.equal(created.id, 'cl_demo_new_1')
  assert.equal(loaded.clients.find(({ id }) => id === created.id).createdAt, created.createdAt)
  assert.equal(loaded.clients.some(({ id }) => id === 'cl_demo_c_old'), true)
})

test('demo generated client and appointment IDs skip occupied legacy-derived candidates', async () => {
  let state = demoState()
  state = {
    ...state,
    clients: [
      ...state.clients,
      { ...state.clients[0], id: 'new_1' },
      { ...state.clients[0], id: 'new_2' },
    ],
    sessions: [{ ...state.sessions[0], id: 'new_1' }, ...state.sessions],
  }
  let sequence = 100
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      if (action.type === 'ADD_CLIENT') state = { ...state, clients: [...state.clients, { ...action.client, id: `c${++sequence}` }] }
      if (action.type === 'ADD_SESSION') state = { ...state, sessions: [...state.sessions, { ...action.session, id: `s${++sequence}` }] }
    },
    getState: () => state,
  })
  const client = await repository.createClient(clientInput({ specialistId: 'sp_demo_p1' }))
  const appointment = await repository.createAppointment(appointmentInput({ clientId: 'cl_demo_c1', specialistId: 'sp_demo_p1' }))
  assert.equal(client.id, 'cl_demo_new_3')
  assert.equal(appointment.id, 'apt_demo_new_2')
})

test('demo generated payment IDs skip legacy and nested history candidates deterministically', async () => {
  let state = demoState()
  state = {
    ...state,
    sessions: [{
      ...state.sessions[0], id: 'new', payment: 'partial', paidAmount: 1,
      method: 'cash', paidDate: '2026-08-04',
    }, ...state.sessions],
  }
  const actions = []
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      actions.push(action)
      state = { ...state, sessions: state.sessions.map((item) => (
        item.id === action.id ? { ...item, ...action.patch } : item
      )) }
    },
    getState: () => state,
  })
  const recorded = await repository.recordPayment('apt_demo_s1', 1, {
    amountGrosze: 100, method: 'card', paidDate: '2026-08-06',
  })
  assert.equal(recorded.paymentEntries.at(-1).id, 'pay_demo_new_2')
  const corrected = await repository.correctPayment('pay_demo_new_2', 2, {
    reason: 'Zmiana', replacement: { amountGrosze: 50, method: 'cash', paidDate: '2026-08-07' },
  })
  assert.equal(corrected.paymentEntries.at(-1).id, 'pay_demo_new_3')
  assert.equal(actions.length, 2)
})

test('demo reserves identities across concurrent delayed creates and payment histories', async () => {
  let state = demoState()
  state = {
    ...state,
    sessions: state.sessions.map((item) => item.id === 's2'
      ? { ...item, status: 'completed' }
      : item),
  }
  let clientSequence = 20
  let appointmentSequence = 20
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      setTimeout(() => {
        if (action.type === 'ADD_CLIENT') {
          state = { ...state, clients: [...state.clients, { ...action.client, id: `c${++clientSequence}` }] }
        }
        if (action.type === 'ADD_SESSION') {
          state = { ...state, sessions: [...state.sessions, { ...action.session, id: `s${++appointmentSequence}` }] }
        }
        if (action.type === 'UPDATE_SESSION') {
          state = { ...state, sessions: state.sessions.map((item) => (
            item.id === action.id ? { ...item, ...action.patch } : item
          )) }
        }
      }, 0)
    },
    getState: () => state,
  })

  const clients = await Promise.all([
    repository.createClient(clientInput({ name: 'Ala Nowak', specialistId: 'sp_demo_p1' })),
    repository.createClient(clientInput({ name: 'Ela Nowak', specialistId: 'sp_demo_p1' })),
  ])
  assert.deepEqual(clients.map(({ id }) => id), ['cl_demo_new_1', 'cl_demo_new_2'])

  const appointments = await Promise.all([
    repository.createAppointment(appointmentInput({ clientId: 'cl_demo_c1', specialistId: 'sp_demo_p1', date: '2026-08-10' })),
    repository.createAppointment(appointmentInput({ clientId: 'cl_demo_c1', specialistId: 'sp_demo_p1', date: '2026-08-11' })),
  ])
  assert.deepEqual(appointments.map(({ id }) => id), ['apt_demo_new_1', 'apt_demo_new_2'])

  const recorded = await Promise.all([
    repository.recordPayment('apt_demo_s1', 1, { amountGrosze: 100, method: 'cash', paidDate: '2026-08-06' }),
    repository.recordPayment('apt_demo_s2', 1, { amountGrosze: 100, method: 'card', paidDate: '2026-09-02' }),
  ])
  const paymentIds = recorded.map((item) => item.paymentEntries.at(-1).id)
  assert.deepEqual(paymentIds, ['pay_demo_new_1', 'pay_demo_new_2'])

  const corrected = await Promise.all([
    repository.correctPayment(paymentIds[0], 2, {
      reason: 'Korekta A', replacement: { amountGrosze: 90, method: 'card', paidDate: '2026-08-07' },
    }),
    repository.correctPayment(paymentIds[1], 2, {
      reason: 'Korekta B', replacement: { amountGrosze: 80, method: 'cash', paidDate: '2026-09-03' },
    }),
  ])
  assert.deepEqual(corrected.map((item) => item.paymentEntries.at(-1).id), [
    'pay_demo_new_3', 'pay_demo_new_4',
  ])
  const loaded = await repository.loadWindow({ from: '2026-08-01', to: '2026-09-30' })
  const canonicalIds = loaded.appointments.flatMap((item) => item.paymentEntries.map(({ id }) => id))
  assert.equal(new Set(canonicalIds).size, canonicalIds.length)
})

test('demo releases a failed payment reservation for deterministic reuse', async () => {
  let state = demoState()
  let apply = false
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      if (!apply) return
      state = { ...state, sessions: state.sessions.map((item) => (
        item.id === action.id ? { ...item, ...action.patch } : item
      )) }
    },
    getState: () => state,
  })
  const input = { amountGrosze: 100, method: 'card', paidDate: '2026-08-06' }
  await assert.rejects(repository.recordPayment('apt_demo_s1', 1, input), /DEMO_STATE_NOT_APPLIED/)
  apply = true
  const recorded = await repository.recordPayment('apt_demo_s1', 1, input)
  assert.equal(recorded.paymentEntries.at(-1).id, 'pay_demo_new_1')
  const correction = {
    reason: 'Korekta', replacement: { amountGrosze: 90, method: 'cash', paidDate: '2026-08-07' },
  }
  apply = false
  await assert.rejects(repository.correctPayment('pay_demo_new_1', 2, correction), /DEMO_STATE_NOT_APPLIED/)
  apply = true
  const corrected = await repository.correctPayment('pay_demo_new_1', 2, correction)
  assert.equal(corrected.paymentEntries.at(-1).id, 'pay_demo_new_2')
})

test('demo serializes same-version payment and correction mutations without losing history', async () => {
  let state = demoState()
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      setTimeout(() => {
        state = { ...state, sessions: state.sessions.map((item) => (
          item.id === action.id ? { ...item, ...action.patch } : item
        )) }
      }, 0)
    },
    getState: () => state,
  })
  const input = { amountGrosze: 100, method: 'card', paidDate: '2026-08-06' }
  const identical = await Promise.allSettled([
    repository.recordPayment('apt_demo_s1', 1, input),
    repository.recordPayment('apt_demo_s1', 1, input),
  ])
  assert.deepEqual(identical.map(({ status }) => status).sort(), ['fulfilled', 'rejected'])
  assert.match(identical.find(({ status }) => status === 'rejected').reason.message, /VERSION_CONFLICT/)
  const first = identical.find(({ status }) => status === 'fulfilled').value
  assert.equal(first.version, 2)
  assert.equal(first.paymentEntries.at(-1).id, 'pay_demo_new_1')

  const differing = await Promise.allSettled([
    repository.recordPayment('apt_demo_s1', 2, { ...input, amountGrosze: 90 }),
    repository.recordPayment('apt_demo_s1', 2, { ...input, amountGrosze: 80 }),
  ])
  assert.deepEqual(differing.map(({ status }) => status).sort(), ['fulfilled', 'rejected'])
  const second = differing.find(({ status }) => status === 'fulfilled').value
  assert.equal(second.version, 3)
  assert.equal(second.paymentEntries.at(-1).id, 'pay_demo_new_2')

  const corrections = await Promise.allSettled([
    repository.correctPayment('pay_demo_new_1', 3, {
      reason: 'Korekta A', replacement: { amountGrosze: 70, method: 'cash', paidDate: '2026-08-07' },
    }),
    repository.correctPayment('pay_demo_new_1', 3, {
      reason: 'Korekta B', replacement: { amountGrosze: 60, method: 'transfer', paidDate: '2026-08-07' },
    }),
  ])
  assert.deepEqual(corrections.map(({ status }) => status).sort(), ['fulfilled', 'rejected'])
  assert.match(corrections.find(({ status }) => status === 'rejected').reason.message, /VERSION_CONFLICT/)
  const corrected = corrections.find(({ status }) => status === 'fulfilled').value
  assert.equal(corrected.version, 4)
  assert.equal(corrected.paymentEntries.length, 4)
  assert.equal(new Set(corrected.paymentEntries.map(({ id }) => id)).size, 4)
})

test('demo serializes client and appointment edits against terminal mutations', async () => {
  const harness = demoHarness()
  const repository = createDemoWorkspaceRepository({ dispatch: harness.dispatch, getState: harness.getState })
  const clientResults = await Promise.allSettled([
    repository.editClient('cl_demo_c1', 1, clientInput({ name: 'Ada Nowak', age: 8, specialistId: 'sp_demo_p1' })),
    repository.archiveClient('cl_demo_c1', 1),
  ])
  assert.deepEqual(clientResults.map(({ status }) => status), ['fulfilled', 'rejected'])
  assert.match(clientResults[1].reason.message, /VERSION_CONFLICT/)
  const archived = await repository.archiveClient('cl_demo_c1', 2)
  assert.equal(archived.status, 'archived')

  const appointmentResults = await Promise.allSettled([
    repository.editAppointment('apt_demo_s2', 1, {
      specialistId: 'sp_demo_p2', serviceId: 'zajecia', date: '2026-09-01',
      time: '10:00', durationMinutes: 50, expectedAmountGrosze: 20_000,
      location: 'Gabinet 4', status: 'scheduled',
    }),
    repository.cancelAppointment('apt_demo_s2', 1),
  ])
  assert.deepEqual(appointmentResults.map(({ status }) => status), ['fulfilled', 'rejected'])
  assert.match(appointmentResults[1].reason.message, /VERSION_CONFLICT/)
  const cancelled = await repository.cancelAppointment('apt_demo_s2', 2)
  assert.equal(cancelled.status, 'cancelled')
})

test('demo permits concurrent mutations for different clients and appointments', async () => {
  const harness = demoHarness()
  const repository = createDemoWorkspaceRepository({ dispatch: harness.dispatch, getState: harness.getState })
  const clients = await Promise.all([
    repository.editClient('cl_demo_c1', 1, clientInput({ name: 'Ada A', age: 8, specialistId: 'sp_demo_p1' })),
    repository.editClient('cl_demo_c2', 1, clientInput({ name: 'Zenon B', age: 10, status: 'paused', specialistId: 'sp_demo_p2' })),
  ])
  assert.deepEqual(clients.map(({ version }) => version), [2, 2])
  const appointments = await Promise.all([
    repository.editAppointment('apt_demo_s1', 1, {
      specialistId: 'sp_demo_p1', serviceId: 'zajecia', date: '2026-08-04',
      time: '09:00', durationMinutes: 50, expectedAmountGrosze: 18_000,
      location: 'Gabinet 2', status: 'completed',
    }),
    repository.editAppointment('apt_demo_s2', 1, {
      specialistId: 'sp_demo_p2', serviceId: 'zajecia', date: '2026-09-01',
      time: '10:00', durationMinutes: 50, expectedAmountGrosze: 20_000,
      location: 'Gabinet 4', status: 'scheduled',
    }),
  ])
  assert.deepEqual(appointments.map(({ version }) => version), [2, 2])
})

test('demo observes delayed out-of-order mutations by target while validating the whole state', async () => {
  const afterTurns = (turns, operation) => {
    if (turns === 0) setTimeout(operation, 0)
    else setTimeout(() => afterTurns(turns - 1, operation), 0)
  }
  let state = demoState()
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      const turns = action.id === 'c1' || action.id === 's1' ? 2 : 0
      afterTurns(turns, () => {
        if (action.type === 'UPDATE_CLIENT') {
          state = { ...state, clients: state.clients.map((item) => (
            item.id === action.id ? { ...item, ...action.patch } : item
          )) }
        }
        if (action.type === 'UPDATE_SESSION') {
          state = { ...state, sessions: state.sessions.map((item) => (
            item.id === action.id ? { ...item, ...action.patch } : item
          )) }
        }
      })
    },
    getState: () => state,
  })
  const clients = await Promise.all([
    repository.editClient('cl_demo_c1', 1, clientInput({ name: 'Ada A', age: 8, specialistId: 'sp_demo_p1' })),
    repository.editClient('cl_demo_c2', 1, clientInput({ name: 'Zenon B', age: 10, status: 'paused', specialistId: 'sp_demo_p2' })),
  ])
  assert.deepEqual(clients.map(({ version }) => version), [2, 2])
  const appointments = await Promise.all([
    repository.editAppointment('apt_demo_s1', 1, {
      specialistId: 'sp_demo_p1', serviceId: 'zajecia', date: '2026-08-04',
      time: '09:00', durationMinutes: 50, expectedAmountGrosze: 18_000,
      location: 'Gabinet 2', status: 'completed',
    }),
    repository.editAppointment('apt_demo_s2', 1, {
      specialistId: 'sp_demo_p2', serviceId: 'zajecia', date: '2026-09-01',
      time: '10:00', durationMinutes: 50, expectedAmountGrosze: 20_000,
      location: 'Gabinet 4', status: 'scheduled',
    }),
  ])
  assert.deepEqual(appointments.map(({ version }) => version), [2, 2])
  const mixed = await Promise.all([
    repository.recordPayment('apt_demo_s1', 2, { amountGrosze: 100, method: 'card', paidDate: '2026-08-06' }),
    repository.editAppointment('apt_demo_s2', 2, {
      specialistId: 'sp_demo_p2', serviceId: 'zajecia', date: '2026-09-01',
      time: '10:00', durationMinutes: 50, expectedAmountGrosze: 20_000,
      location: 'Gabinet 5', status: 'scheduled',
    }),
  ])
  assert.deepEqual(mixed.map(({ version }) => version), [3, 3])
  assert.equal(mixed[0].paymentEntries.at(-1).id, 'pay_demo_new_1')
})

test('demo reconciles unrelated out-of-order creates and the fifth macrotask boundary', async () => {
  const afterTurns = (turns, operation) => {
    if (turns === 0) setTimeout(operation, 0)
    else setTimeout(() => afterTurns(turns - 1, operation), 0)
  }
  let state = demoState()
  let sequence = 40
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      const turns = action.client.name === 'Ala Wolna' ? 2 : 0
      afterTurns(turns, () => {
        state = { ...state, clients: [...state.clients, { ...action.client, id: `c${++sequence}` }] }
      })
    },
    getState: () => state,
  })
  const created = await Promise.all([
    repository.createClient(clientInput({ name: 'Ala Wolna', specialistId: 'sp_demo_p1' })),
    repository.createClient(clientInput({ name: 'Ela Szybka', specialistId: 'sp_demo_p1' })),
  ])
  assert.deepEqual(created.map(({ id }) => id), ['cl_demo_new_1', 'cl_demo_new_2'])

  let boundaryState = demoState()
  const boundary = createDemoWorkspaceRepository({
    dispatch(action) {
      afterTurns(4, () => {
        boundaryState = { ...boundaryState, clients: [
          ...boundaryState.clients, { ...action.client, id: 'c_boundary' },
        ] }
      })
    },
    getState: () => boundaryState,
  })
  const finalTurn = await boundary.createClient(clientInput({ name: 'Piąty Obrót', specialistId: 'sp_demo_p1' }))
  assert.equal(finalTurn.id, 'cl_demo_new_1')
})

test('demo target observation still fails closed on a malformed surrounding row', async () => {
  let state = demoState()
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      setTimeout(() => {
        state = {
          ...state,
          clients: state.clients.map((item) => item.id === 'c2'
            ? { ...item, age: 'private-invalid' }
            : item),
        }
      }, 0)
      setTimeout(() => {
        state = { ...state, clients: state.clients.map((item) => (
          item.id === action.id ? { ...item, ...action.patch } : item
        )) }
      }, 0)
    },
    getState: () => state,
  })
  await assert.rejects(repository.editClient(
    'cl_demo_c1', 1, clientInput({ name: 'Ada Nowak', age: 8, specialistId: 'sp_demo_p1' }),
  ), /VALIDATION_FAILED\/age/)
})

test('demo rejects two matching created rows instead of choosing one nondeterministically', async () => {
  let state = demoState()
  const repository = createDemoWorkspaceRepository({
    dispatch(action) {
      state = { ...state, clients: [
        ...state.clients, { ...action.client, id: 'c_new_a' }, { ...action.client, id: 'c_new_b' },
      ] }
    },
    getState: () => state,
  })
  await assert.rejects(repository.createClient(clientInput({ specialistId: 'sp_demo_p1' })), /DEMO_STATE_MISMATCH/)
})

test('demo awaits delayed reducer application and rejects persistent no-op or wrong-row dispatches', async () => {
  let delayedState = demoState()
  const delayed = createDemoWorkspaceRepository({
    dispatch(action) {
      setTimeout(() => {
        delayedState = { ...delayedState, clients: [...delayedState.clients, { ...action.client, id: 'c88' }] }
      }, 0)
    },
    getState: () => delayedState,
  })
  const created = await delayed.createClient(clientInput({ specialistId: 'sp_demo_p1' }))
  assert.equal(created.id, 'cl_demo_new_1')
  assert.equal(delayedState.clients.some(({ id }) => id === 'c88'), true)

  const unchanged = demoState()
  const noClient = createDemoWorkspaceRepository({ dispatch() {}, getState: () => unchanged })
  await assert.rejects(noClient.createClient(clientInput({ specialistId: 'sp_demo_p1' })), /DEMO_STATE_/)

  let wrongState = demoState()
  const wrongAppointment = createDemoWorkspaceRepository({
    dispatch() { wrongState = { ...wrongState, sessions: [...wrongState.sessions, { ...wrongState.sessions[0], id: 's_wrong' }] } },
    getState: () => wrongState,
  })
  await assert.rejects(wrongAppointment.createAppointment(appointmentInput({ clientId: 'cl_demo_c1', specialistId: 'sp_demo_p1' })), /DEMO_STATE_MISMATCH/)

  const unchangedPayment = demoState()
  const noPayment = createDemoWorkspaceRepository({ dispatch() {}, getState: () => unchangedPayment })
  await assert.rejects(noPayment.recordPayment('apt_demo_s1', 1, { amountGrosze: 1, method: 'cash', paidDate: '2026-08-06' }), /DEMO_STATE_/)
})

test('demo awaits delayed appointment and payment reducer applications', async () => {
  let appointmentState = demoState()
  const appointments = createDemoWorkspaceRepository({
    dispatch(action) {
      setTimeout(() => {
        appointmentState = { ...appointmentState, sessions: [
          ...appointmentState.sessions, { ...action.session, id: 's_delayed' },
        ] }
      }, 0)
    },
    getState: () => appointmentState,
  })
  const appointment = await appointments.createAppointment(appointmentInput({
    clientId: 'cl_demo_c1', specialistId: 'sp_demo_p1', location: 'Gabinet 3',
  }))
  assert.equal(appointment.location, 'Gabinet 3')
  assert.equal(appointmentState.sessions.some(({ id }) => id === 's_delayed'), true)

  let paymentState = demoState()
  const payments = createDemoWorkspaceRepository({
    dispatch(action) {
      setTimeout(() => {
        paymentState = { ...paymentState, sessions: paymentState.sessions.map((item) => (
          item.id === action.id ? { ...item, ...action.patch } : item
        )) }
      }, 0)
    },
    getState: () => paymentState,
  })
  const paid = await payments.recordPayment('apt_demo_s1', 1, {
    amountGrosze: 100, method: 'card', paidDate: '2026-08-06',
  })
  assert.equal(paid.payment.collectedGrosze, 7_100)
  assert.equal(paymentState.sessions.find(({ id }) => id === 's1').paidAmount, 71)
})

test('demo rebuilds live indexes and rejects removed or inactive specialists before dispatch', async () => {
  let state = demoState()
  const actions = []
  const repository = createDemoWorkspaceRepository({ dispatch: (action) => actions.push(action), getState: () => state })
  await repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' })
  state = {
    ...state, psychologists: [{ ...state.psychologists[0], status: 'inactive' }],
    clients: [], sessions: [],
  }
  await assert.rejects(repository.createClient(clientInput({ specialistId: 'sp_demo_p1' })), /NOT_FOUND/)
  await assert.rejects(repository.createClient(clientInput({ specialistId: 'sp_demo_p2' })), /NOT_FOUND/)
  assert.equal(actions.length, 0)
})

test('demo refuses a canonical window with an active client assigned to an absent or inactive specialist', async () => {
  for (const psychologists of [
    [{ ...demoState().psychologists[0] }],
    demoState().psychologists.map((item) => item.id === 'p1' ? { ...item, status: 'inactive' } : item),
  ]) {
    const state = { ...demoState(), psychologists }
    const repository = createDemoWorkspaceRepository({ dispatch() {}, getState: () => state })
    await assert.rejects(repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' }), /VALIDATION_FAILED\/client/)
  }
})

test('demo excludes an unreferenced inactive specialist from an otherwise valid window', async () => {
  const base = demoState()
  const state = {
    ...base,
    psychologists: [...base.psychologists, { id: 'p9', name: 'Nieaktywna', rate: 190, status: 'inactive' }],
  }
  const repository = createDemoWorkspaceRepository({ dispatch() {}, getState: () => state })
  const loaded = await repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' })
  assert.deepEqual(loaded.specialists.map(({ id }) => id), ['sp_demo_p1', 'sp_demo_p2'])
})

test('demo rejects an appointment whose client is absent from the returned directory', async () => {
  const base = demoState()
  const state = {
    ...base,
    sessions: [{ ...base.sessions[0], id: 's_orphan', clientId: 'c_missing', date: '2026-08-04' }],
  }
  const repository = createDemoWorkspaceRepository({ dispatch() {}, getState: () => state })
  await assert.rejects(repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' }), /VALIDATION_FAILED\/workspace/)
})

test('demo contains hostile collection proxy failures as canonical validation errors', async () => {
  const traps = [
    (target) => new Proxy(target, { get(_target, key, receiver) { if (key === 'length') throw new Error('private length'); return Reflect.get(_target, key, receiver) } }),
    (target) => new Proxy(target, { ownKeys() { throw new Error('private keys') } }),
    (target) => new Proxy(target, { getOwnPropertyDescriptor() { throw new Error('private index') } }),
    (target) => new Proxy(target, { get(_target, key, receiver) { if (key === Symbol.iterator) throw new Error('private iterator'); return Reflect.get(_target, key, receiver) } }),
  ]
  const areas = ['psychologists', 'clients', 'sessions']
  for (let index = 0; index < traps.length; index += 1) {
    const state = demoState()
    const area = areas[index % areas.length]
    state[area] = traps[index](state[area])
    const repository = createDemoWorkspaceRepository({ dispatch() {}, getState: () => state })
    await assert.rejects(repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' }), (error) => {
      assert.match(error.message, /^VALIDATION_FAILED\/state$/)
      assert.doesNotMatch(String(error), /private/)
      return true
    })
  }
})

test('demo rejects coercive and descriptor-hostile legacy scalars without dispatch', async () => {
  const coercive = { valueOf() { throw new Error('private value') }, toString() { throw new Error('private text') }, [Symbol.toPrimitive]() { throw new Error('private primitive') } }
  const mutations = [
    (state) => { state.psychologists[0].rate = coercive },
    (state) => { state.clients[0].age = coercive },
    (state) => { state.sessions[0].amount = coercive },
    (state) => { state.sessions[0].paidAmount = coercive },
    (state) => Object.defineProperty(state.sessions[0], 'date', { enumerable: true, get() { throw new Error('private date') } }),
  ]
  for (const mutate of mutations) {
    const state = demoState()
    mutate(state)
    let dispatched = 0
    const repository = createDemoWorkspaceRepository({ dispatch() { dispatched += 1 }, getState: () => state })
    await assert.rejects(repository.loadWindow({ from: '2026-08-01', to: '2026-08-31' }), /VALIDATION_FAILED/)
    assert.equal(dispatched, 0)
  }
})
