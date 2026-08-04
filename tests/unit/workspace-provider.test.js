import test from 'node:test'
import assert from 'node:assert/strict'

import * as workspaceProvider from '../../src/workspace-provider.js'

const { createWorkspaceProviderController } = workspaceProvider

const WORKSPACE_KEYS = [
  'archiveClient', 'cancelAppointment', 'correctPayment', 'createAppointment',
  'createClient', 'editAppointment', 'editClient', 'loadWindow', 'loadedRanges',
  'recordPayment', 'status',
]
const range = (from, to = from) => ({ from, to })
const specialist = () => ({ id: 'sp_anna', displayName: 'Anna', status: 'active', version: 1 })
const client = () => ({
  id: 'cl_ola', name: 'Ola', status: 'active', readOnly: false,
  assignment: { id: 'asg_ola', specialistId: 'sp_anna' },
})
const payload = (from, to = from) => ({
  window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
  specialists: [specialist()], clients: [client()], appointments: [],
})
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const repositoryWith = (overrides = {}) => Object.freeze({
  loadWindow: async ({ from, to }) => payload(from, to),
  createClient: async (input) => ({ id: 'cl_created', input }),
  editClient: async () => ({}), archiveClient: async () => ({}),
  createAppointment: async () => ({}), editAppointment: async () => ({}),
  cancelAppointment: async () => ({}), recordPayment: async () => ({}),
  correctPayment: async () => ({}), ...overrides,
})

const makeController = (repositoryFactory, overrides = {}) => createWorkspaceProviderController({
  repositoryFactory,
  dispatch: overrides.dispatch || (() => {}),
  getState: overrides.getState || (() => ({ demoRoleId: 'owner' })),
  authorityKey: overrides.authorityKey || 'authority-one',
  clearToasts: overrides.clearToasts || (() => {}),
})

const stale = { code: 'WORKSPACE_AUTHORITY_STALE', message: 'WORKSPACE_AUTHORITY_STALE' }

test('exposes the exact workspace contract and constructs one repository with exact dependencies', () => {
  const dispatch = () => {}
  const getState = () => ({})
  let dependencies
  let factoryCalls = 0
  const controller = makeController((received) => {
    factoryCalls += 1
    dependencies = received
    return repositoryWith()
  }, { dispatch, getState })
  assert.deepEqual(Object.keys(controller.getSnapshot().workspace).sort(), WORKSPACE_KEYS)
  assert.deepEqual(Reflect.ownKeys(dependencies).sort(), ['dispatch', 'getState'])
  assert.equal(dependencies.dispatch, dispatch)
  assert.equal(dependencies.getState, getState)
  assert.ok(Object.isFrozen(dependencies))
  controller.getSnapshot()
  assert.equal(factoryCalls, 1)
})

test('rejects accessor-backed repositories without invoking their methods', () => {
  const repository = { ...repositoryWith() }
  let reads = 0
  Object.defineProperty(repository, 'loadWindow', {
    enumerable: true,
    get() { reads += 1; return async () => ({}) },
  })
  assert.throws(() => makeController(() => repository), TypeError)
  assert.equal(reads, 0)
})

test('tracks concurrent current-authority loads until all finish and normalizes coverage', async () => {
  const first = deferred()
  const second = deferred()
  let calls = 0
  const controller = makeController(() => repositoryWith({
    loadWindow: () => (++calls === 1 ? first.promise : second.promise),
  }))
  const one = controller.getSnapshot().workspace.loadWindow(range('2026-08-01', '2026-08-03'))
  const two = controller.getSnapshot().workspace.loadWindow(range('2026-08-03', '2026-08-05'))
  assert.equal(controller.getSnapshot().workspace.status, 'loading')
  second.resolve(payload('2026-08-03', '2026-08-05'))
  await two
  assert.equal(controller.getSnapshot().workspace.status, 'loading')
  first.resolve(payload('2026-08-01', '2026-08-03'))
  await one
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [range('2026-08-01', '2026-08-05')])
})

test('authority reset replaces repository, clears state and toasts, and rejects old completion', async () => {
  const oldLoad = deferred()
  let factoryCalls = 0
  let toastClears = 0
  const controller = makeController(() => {
    factoryCalls += 1
    return factoryCalls === 1
      ? repositoryWith({ loadWindow: () => oldLoad.promise })
      : repositoryWith()
  }, { clearToasts: () => { toastClears += 1 } })
  const pending = controller.getSnapshot().workspace.loadWindow(range('2026-08-01'))
  controller.resetAuthority('authority-two')
  assert.equal(factoryCalls, 2)
  assert.equal(toastClears, 1)
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [])
  oldLoad.resolve(payload('2026-08-01'))
  await assert.rejects(pending, stale)
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [])
})

test('every old-authority mutation completion is replaced by one fixed stale error', async () => {
  const methods = [
    'createClient', 'editClient', 'archiveClient', 'createAppointment',
    'editAppointment', 'cancelAppointment', 'recordPayment', 'correctPayment',
  ]
  for (const method of methods) {
    const turn = deferred()
    let factories = 0
    const controller = makeController(() => {
      factories += 1
      return factories === 1 ? repositoryWith({ [method]: () => turn.promise }) : repositoryWith()
    })
    const command = controller.getSnapshot().workspace[method]('private-input', { secret: true })
    controller.resetAuthority(`next-${method}`)
    turn.resolve({ secretDto: method })
    await assert.rejects(command, stale, method)
    assert.equal(controller.getSnapshot().loadedState.writeEpoch, 0)
    assert.equal(controller.getSnapshot().workspace.status, 'ready')
  }
})

test('old-authority load and mutation failures never disclose their original errors', async () => {
  const oldLoad = deferred()
  const oldMutation = deferred()
  let factories = 0
  const controller = makeController(() => {
    factories += 1
    return factories === 1
      ? repositoryWith({ loadWindow: () => oldLoad.promise, createClient: () => oldMutation.promise })
      : repositoryWith()
  })
  const loading = controller.getSnapshot().workspace.loadWindow(range('2026-08-01'))
  const mutating = controller.getSnapshot().workspace.createClient({ secret: true })
  controller.resetAuthority('authority-two')
  oldLoad.reject(Object.assign(new Error('private load'), { code: 'NETWORK_ERROR' }))
  oldMutation.reject(Object.assign(new Error('private mutation'), { code: 'VERSION_CONFLICT' }))
  await assert.rejects(loading, stale)
  await assert.rejects(mutating, stale)
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
})

test('failed replacement construction leaves the new authority empty and read-only', async () => {
  const events = []
  let oldCalls = 0
  let factories = 0
  const controller = makeController(() => {
    factories += 1
    events.push(`factory-${factories}`)
    if (factories === 2) throw new Error('private factory failure')
    return repositoryWith({ createClient: async () => { oldCalls += 1; return {} } })
  }, { clearToasts: () => { events.push('clear-toasts') } })
  await controller.getSnapshot().workspace.loadWindow(range('2026-08-01'))
  await controller.getSnapshot().workspace.createClient({})
  assert.throws(() => controller.resetAuthority('authority-broken'), {
    code: 'WORKSPACE_RESET_FAILED', message: 'WORKSPACE_RESET_FAILED',
  })
  assert.deepEqual(events, ['factory-1', 'clear-toasts', 'factory-2'])
  assert.equal(controller.getSnapshot().workspace.status, 'read-only-error')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [])
  assert.deepEqual([
    controller.getSnapshot().loadedState.authorityGeneration,
    controller.getSnapshot().loadedState.writeEpoch,
  ], [1, 0])
  await assert.rejects(controller.getSnapshot().workspace.loadWindow(range('2026-08-02')), {
    code: 'WORKSPACE_READ_ONLY', message: 'WORKSPACE_READ_ONLY',
  })
  await assert.rejects(controller.getSnapshot().workspace.createClient({}), {
    code: 'WORKSPACE_READ_ONLY', message: 'WORKSPACE_READ_ONLY',
  })
  assert.equal(oldCalls, 1)
})

test('toast reset failure prevents replacement construction and remains fail closed', () => {
  let factories = 0
  const controller = makeController(() => {
    factories += 1
    return repositoryWith()
  }, { clearToasts: () => { throw new Error('private toast failure') } })
  assert.throws(() => controller.resetAuthority('authority-broken'), {
    code: 'WORKSPACE_RESET_FAILED', message: 'WORKSPACE_RESET_FAILED',
  })
  assert.equal(factories, 1)
  assert.equal(controller.getSnapshot().workspace.status, 'read-only-error')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [])
})

test('demo role dispatch resets authority synchronously only for an accepted changed role', () => {
  const events = []
  let state = { demoRoleId: 'owner' }
  const dispatch = workspaceProvider.createAuthorityBoundDispatch({
    dispatch: (action) => { events.push(`dispatch-${action.roleId}`); state = { ...state, demoRoleId: action.roleId } },
    getState: () => state,
    resetAuthority: (key) => { events.push(`reset-${key}`) },
    authorityKeyFor: (next) => `role-${next.demoRoleId}`,
    demoRoleIds: ['owner', 'coordinator', 'therapist'],
  })
  dispatch({ type: 'SET_DEMO_ROLE', roleId: 'therapist' })
  assert.deepEqual(events, ['reset-role-therapist', 'dispatch-therapist'])
  events.length = 0
  dispatch({ type: 'SET_DEMO_ROLE', roleId: 'therapist' })
  dispatch({ type: 'SET_DEMO_ROLE', roleId: 'invalid' })
  assert.deepEqual(events, ['dispatch-therapist', 'dispatch-invalid'])
})

test('a successful write invalidates a captured load and causes one exact bounded refetch', async () => {
  const stale = deferred()
  const requests = []
  const controller = makeController(() => repositoryWith({
    loadWindow: (requested) => {
      requests.push(requested)
      return requests.length === 1 ? stale.promise : Promise.resolve(payload(requested.from, requested.to))
    },
  }))
  const requested = range('2026-08-10', '2026-08-12')
  const loading = controller.getSnapshot().workspace.loadWindow(requested)
  await controller.getSnapshot().workspace.createClient({ name: 'caller draft' })
  assert.equal(controller.getSnapshot().loadedState.writeEpoch, 1)
  stale.resolve(payload(requested.from, requested.to))
  await loading
  assert.deepEqual(requests, [requested, requested])
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [requested])
})

test('business errors do not advance the epoch or make the workspace read-only', async () => {
  const conflict = Object.assign(new Error('conflict'), { code: 'VERSION_CONFLICT', status: 409 })
  const controller = makeController(() => repositoryWith({
    editClient: async () => { throw conflict },
  }))
  await assert.rejects(controller.getSnapshot().workspace.editClient('cl_ola', 1, {}), conflict)
  assert.equal(controller.getSnapshot().loadedState.writeEpoch, 0)
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
})

test('demo validation failures remain command errors instead of outages', async () => {
  const controller = makeController(() => repositoryWith({
    createClient: async () => { throw new TypeError('VALIDATION_FAILED/body') },
  }))
  await assert.rejects(controller.getSnapshot().workspace.createClient({}), TypeError)
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
  assert.equal(controller.getSnapshot().loadedState.writeEpoch, 0)
})

test('infrastructure failure preserves caller input and disables later mutations', async () => {
  const input = { name: 'Niezapisany szkic', nested: { untouched: true } }
  const before = JSON.stringify(input)
  let calls = 0
  const outage = Object.assign(new Error('offline'), { code: 'NETWORK_ERROR', status: 0 })
  const controller = makeController(() => repositoryWith({
    createClient: async () => { calls += 1; throw outage },
  }))
  await assert.rejects(controller.getSnapshot().workspace.createClient(input), outage)
  assert.equal(JSON.stringify(input), before)
  assert.equal(controller.getSnapshot().workspace.status, 'read-only-error')
  await assert.rejects(controller.getSnapshot().workspace.createClient(input), { code: 'WORKSPACE_READ_ONLY' })
  assert.equal(calls, 1)
  assert.equal(controller.getSnapshot().loadedState.writeEpoch, 0)
  controller.resetAuthority('authority-recovered')
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [])
})

test('invalid load response fails closed without erasing prior canonical coverage', async () => {
  let calls = 0
  const controller = makeController(() => repositoryWith({
    loadWindow: async ({ from, to }) => (++calls === 1 ? payload(from, to) : { invalid: true }),
  }))
  await controller.getSnapshot().workspace.loadWindow(range('2026-08-01'))
  await assert.rejects(controller.getSnapshot().workspace.loadWindow(range('2026-08-02')), TypeError)
  assert.equal(controller.getSnapshot().workspace.status, 'read-only-error')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [range('2026-08-01')])
})
