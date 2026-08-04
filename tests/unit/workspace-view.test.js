import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clientIdentityFor,
  isWorkspaceRangeCovered,
  monthWorkspaceRange,
  projectLoadedWorkspace,
  rollingWorkspaceRange,
  specialistIdentityFor,
  weekWorkspaceRange,
  workspaceRangeState,
} from '../../src/workspace-view.js'

const specialist = (overrides = {}) => Object.freeze({
  id: 'sp_anna', displayName: 'Anna Nowak', standardRateGrosze: 18_000,
  status: 'active', version: 3, staffVersion: 4, ...overrides,
})

const client = (overrides = {}) => Object.freeze({
  id: 'cl_ola', name: 'Ola Testowa', age: 12, status: 'active', version: 2,
  archivedAt: null, createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-07-10T09:00:00.000Z', readOnly: false,
  assignment: Object.freeze({
    id: 'asg_ola', specialistId: 'sp_anna', startsAt: '2026-01-10T09:00:00.000Z', version: 1,
  }),
  ...overrides,
})

const appointment = (overrides = {}) => Object.freeze({
  id: 'apt_history', clientId: 'cl_archived', specialistId: 'sp_history',
  serviceId: 'zajecia', startsAt: '2026-07-15T08:30:00.000Z',
  endsAt: '2026-07-15T09:20:00.000Z', timeZone: 'Europe/Warsaw', location: 'Gabinet 2',
  status: 'completed', source: 'panel', version: 3, cancelledAt: null,
  createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-16T08:00:00.000Z',
  charge: Object.freeze({
    id: 'chg_history', serviceId: 'zajecia', expectedAmountGrosze: 18_050,
    currency: 'PLN', version: 1,
  }),
  payment: Object.freeze({
    status: 'partial', collectedGrosze: 8_025, outstandingGrosze: 10_025,
    latestMethod: 'transfer', latestReceivedAt: '2026-07-16T10:00:00.000Z',
  }),
  paymentEntries: Object.freeze([Object.freeze({
    id: 'pay_history', amountGrosze: 8_025, method: 'transfer',
    receivedAt: '2026-07-16T10:00:00.000Z', correctedAt: null, replacementEntryId: null,
  })]),
  ...overrides,
})

const nullMap = (values) => Object.freeze(Object.assign(Object.create(null), values))
const loadedState = (overrides = {}) => Object.freeze({
  loadedRanges: Object.freeze([{ from: '2026-07-01', to: '2026-07-31' }]),
  specialistsById: nullMap({ sp_anna: specialist() }),
  clientsById: nullMap({
    cl_ola: client(),
    cl_paused: client({
      id: 'cl_paused', name: 'Bartek Testowy', status: 'paused',
      assignment: Object.freeze({
        id: 'asg_paused', specialistId: 'sp_anna',
        startsAt: '2026-01-10T09:00:00.000Z', version: 1,
      }),
    }),
    cl_archived: client({
      id: 'cl_archived', name: 'Zofia Historyczna', status: 'archived', readOnly: true,
      archivedAt: '2026-07-20T08:00:00.000Z', assignment: null,
    }),
  }),
  appointmentsById: nullMap({ apt_history: appointment() }),
  authorityGeneration: 2,
  writeEpoch: 5,
  ...overrides,
})

test('projects canonical records into immutable legacy view records without private demo fields', () => {
  const source = loadedState()
  const projected = projectLoadedWorkspace(source)

  assert.deepEqual(projected.psychologists, [{
    id: 'sp_anna', name: 'Anna Nowak', rate: 180, color: 'var(--pink-deep)',
    status: 'active', version: 3, staffVersion: 4,
  }])
  assert.deepEqual(projected.clients, [
    {
      id: 'cl_paused', name: 'Bartek Testowy', age: 12, status: 'paused',
      psychId: 'sp_anna', version: 2, readOnly: false, since: '2026-01-10',
    },
    {
      id: 'cl_ola', name: 'Ola Testowa', age: 12, status: 'active',
      psychId: 'sp_anna', version: 2, readOnly: false, since: '2026-01-10',
    },
    {
      id: 'cl_archived', name: 'Zofia Historyczna', age: 12, status: 'archived',
      psychId: null, version: 2, readOnly: true, since: '2026-01-10',
    },
  ])
  assert.deepEqual(projected.sessions, [{
    id: 'apt_history', clientId: 'cl_archived', psychId: 'sp_history',
    service: 'zajecia', date: '2026-07-15', time: '10:30', duration: 50,
    amount: 180.5, location: 'Gabinet 2', status: 'completed', version: 3,
    payment: 'partial', paidAmount: 80.25, method: 'transfer', paidDate: '2026-07-16',
    readOnly: true,
  }])
  assert.equal(Object.hasOwn(projected.clients[0], 'phone'), false)
  assert.equal(Object.hasOwn(projected.clients[0], 'notes'), false)
  assert.equal(Object.hasOwn(projected.sessions[0], 'notes'), false)
  assert.ok(Object.isFrozen(projected))
  assert.ok(Object.isFrozen(projected.clients))
  assert.ok(Object.isFrozen(projected.sessions[0]))
  assert.notEqual(projected.clients[0], source.clientsById.cl_paused)
})

test('does not manufacture unreferenced archived clients and marks missing identities safely', () => {
  const projected = projectLoadedWorkspace(loadedState({
    clientsById: nullMap({
      cl_ola: client(),
      cl_archived: client({
        id: 'cl_archived', name: 'Zofia Historyczna', status: 'archived', readOnly: true,
        archivedAt: '2026-07-20T08:00:00.000Z', assignment: null,
      }),
      cl_unreferenced: client({
        id: 'cl_unreferenced', name: 'Nie powinna się pojawić', status: 'archived',
        readOnly: true, archivedAt: '2026-07-20T08:00:00.000Z', assignment: null,
      }),
    }),
  }))

  assert.deepEqual(projected.clients.map(({ id }) => id), ['cl_ola', 'cl_archived'])
  assert.deepEqual(clientIdentityFor(projected.clients, 'cl_archived'), {
    name: 'Zofia Historyczna', available: true, readOnly: true,
  })
  assert.deepEqual(clientIdentityFor(projected.clients, 'cl_missing'), {
    name: 'Klient niedostępny', available: false, readOnly: true,
  })
  assert.deepEqual(specialistIdentityFor(projected.psychologists, 'sp_history'), {
    name: 'Specjalistka niedostępna', color: null, available: false,
  })
  assert.equal(JSON.stringify(projected).includes('cl_missing'), false)
  assert.equal(JSON.stringify(projected).includes('sp_history'), true)
})

test('rejects hostile projection boundaries without invoking accessors or coercion hooks', () => {
  let reads = 0
  const accessorMap = Object.create(null)
  Object.defineProperty(accessorMap, 'sp_anna', {
    enumerable: true,
    get() { reads += 1; return specialist() },
  })
  Object.freeze(accessorMap)
  assert.throws(() => projectLoadedWorkspace(loadedState({ specialistsById: accessorMap })), TypeError)

  const hostileAmount = { valueOf() { reads += 1; return 18_000 } }
  assert.throws(() => projectLoadedWorkspace(loadedState({
    appointmentsById: nullMap({
      apt_history: appointment({
        charge: Object.freeze({
          id: 'chg_history', serviceId: 'zajecia', expectedAmountGrosze: hostileAmount,
          currency: 'PLN', version: 1,
        }),
      }),
    }),
  })), TypeError)
  assert.equal(reads, 0)
})

test('builds exact leap-safe month, Monday week, and bounded rolling windows', () => {
  assert.deepEqual(monthWorkspaceRange('2024-02'), { from: '2024-02-01', to: '2024-02-29' })
  assert.deepEqual(monthWorkspaceRange('2100-02'), { from: '2100-02-01', to: '2100-02-28' })
  assert.deepEqual(weekWorkspaceRange('2026-01-01'), { from: '2025-12-29', to: '2026-01-04' })
  assert.deepEqual(rollingWorkspaceRange('2024-02-29'), { from: '2023-11-29', to: '2024-02-29' })
  assert.throws(() => rollingWorkspaceRange('2024-02-29', 94), TypeError)
  assert.throws(() => monthWorkspaceRange('2026-13'), TypeError)
  assert.throws(() => weekWorkspaceRange('2026-02-29'), TypeError)
})

test('uses normalized coverage rather than rows and distinguishes load outcomes', () => {
  const ranges = [
    { from: '2026-01-01', to: '2026-01-10' },
    { from: '2026-01-11', to: '2026-01-31' },
  ]
  const month = monthWorkspaceRange('2026-01')
  assert.equal(isWorkspaceRangeCovered(ranges, month), true)
  assert.equal(isWorkspaceRangeCovered([], month), false)
  assert.equal(workspaceRangeState('ready', ranges, month), 'ready')
  assert.equal(workspaceRangeState('loading', ranges, month), 'ready')
  assert.equal(workspaceRangeState('ready', [], month), 'loading')
  assert.equal(workspaceRangeState('loading', [], month), 'loading')
  assert.equal(workspaceRangeState('read-only-error', [], month), 'unavailable')
})
