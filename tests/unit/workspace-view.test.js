import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clientIdentityFor,
  isWorkspaceRangeCovered,
  monthWorkspaceRange,
  projectLoadedActivities,
  projectLoadedWorkspace,
  rollingWorkspaceRange,
  specialistIdentityFor,
  weekWorkspaceRange,
  workspaceRangeState,
} from '../../src/workspace-view.js'
import {
  captureLoadedActivitiesLoad,
  createLoadedActivitiesState,
  mergeLoadedActivitiesLoad,
} from '../../src/loaded-activities.js'

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
const historicalClient = (overrides = {}) => Object.freeze({
  id: 'hcl_ola', name: 'Ola Historyczna', status: 'historical', activeClientId: null,
  version: 1, createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-01T08:00:00.000Z', ...overrides,
})
const historicalOccurrence = (overrides = {}) => Object.freeze({
  id: 'hoc_ola', historicalClientId: 'hcl_ola', counterparty: null,
  specialistId: 'sp_anna', serviceId: null, serviceLabel: 'Usługa historyczna',
  period: Object.freeze({ precision: 'month', day: null, month: '2026-07' }),
  status: 'recorded', version: 1, sourceRecordId: 'wbs_ola',
  createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-01T08:00:00.000Z',
  ...overrides,
})
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
  historicalClientsById: nullMap({}),
  historicalOccurrencesById: nullMap({}),
  latestPopulatedMonth: null,
  authorityGeneration: 2,
  writeEpoch: 5,
  ...overrides,
})

const loadedActivitiesState = () => {
  const initial = createLoadedActivitiesState()
  const capture = captureLoadedActivitiesLoad(initial, { from: '2026-08', to: '2026-08' })
  return mergeLoadedActivitiesLoad(initial, capture, {
    from: '2026-08', to: '2026-08', complete: true,
    currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: null, english: '2026-08' },
    programs: [{
      id: 'apg_english', code: 'english', label: 'Angielski', status: 'active',
      version: 1, createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    }],
    groups: [], groupLeaders: [],
    participants: [{
      id: 'acp_english', programId: 'apg_english', name: 'Fikcyjny Anglista',
      clientId: null, historicalClientId: null, status: 'active', version: 1,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    }],
    memberships: [], classes: [], attendance: [],
    charges: [{
      id: 'ach_english', participantId: 'acp_english', programId: 'apg_english',
      groupId: null, membershipId: null,
      period: { precision: 'month', day: null, month: '2026-08' }, lessonCount: 0,
      responsibleSpecialistId: 'sp_anna', financeEntryId: 'fin_english',
      status: 'active', version: 1,
      finance: {
        amountGrosze: 18_000, paidAmountGrosze: 7_000,
        paymentMethod: 'transfer', settlementStatus: 'partial',
      },
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    }],
    payments: [],
  }).state
}

test('projects the canonical activity cache as exact immutable ID-ordered arrays', () => {
  const source = loadedActivitiesState()
  const projected = projectLoadedActivities(source)
  assert.deepEqual(Object.keys(projected), [
    'loadedMonths', 'latestPopulatedMonths', 'programs', 'groups', 'groupLeaders',
    'participants', 'memberships', 'classes', 'attendance', 'charges', 'payments',
  ])
  assert.deepEqual(projected.loadedMonths, [{ from: '2026-08', to: '2026-08' }])
  assert.deepEqual(projected.programs.map(({ id }) => id), ['apg_english'])
  assert.deepEqual(projected.participants.map(({ id }) => id), ['acp_english'])
  assert.deepEqual(projected.charges[0].finance, {
    amountGrosze: 18_000, paidAmountGrosze: 7_000,
    paymentMethod: 'transfer', settlementStatus: 'partial',
  })
  assert.equal(Object.hasOwn(projected.charges[0], 'amountGrosze'), false)
  assert.deepEqual(projected.payments, [])
  assert.equal(Object.isFrozen(projected), true)
  assert.equal(Object.isFrozen(projected.charges[0].finance), true)
  assert.notEqual(projected.charges[0], source.chargesById.ach_english)
})

test('activity projection rejects forged cache shells before reading their entity maps', () => {
  const source = loadedActivitiesState()
  let reads = 0
  const forged = { ...source }
  Object.defineProperty(forged, 'chargesById', {
    enumerable: true,
    get() { reads += 1; return source.chargesById },
  })
  assert.throws(() => projectLoadedActivities(forged), TypeError)
  assert.equal(reads, 0)
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
  assert.deepEqual(projected.historicalClients, [])
  assert.deepEqual(projected.historicalOccurrences, [])
  assert.equal(projected.latestPopulatedMonth, null)
  assert.equal(Object.hasOwn(projected.clients[0], 'phone'), false)
  assert.equal(Object.hasOwn(projected.clients[0], 'notes'), false)
  assert.equal(Object.hasOwn(projected.sessions[0], 'notes'), false)
  assert.ok(Object.isFrozen(projected))
  assert.ok(Object.isFrozen(projected.clients))
  assert.ok(Object.isFrozen(projected.sessions[0]))
  assert.notEqual(projected.clients[0], source.clientsById.cl_paused)
})

test('projects canonical historical DTOs separately from timed sessions and preserves source precision', () => {
  const sourceClient = historicalClient({
    status: 'activated', activeClientId: 'cl_ola', version: 2,
    updatedAt: '2026-07-20T08:00:00.000Z',
  })
  const monthOccurrence = historicalOccurrence()
  const unknownCounterparty = historicalOccurrence({
    id: 'hoc_school', historicalClientId: null,
    counterparty: Object.freeze({ id: 'hcp_school', name: 'Szkoła Podstawowa nr 1' }),
    serviceLabel: 'Superwizja zespołu',
    period: Object.freeze({ precision: 'unknown', day: null, month: null }),
    sourceRecordId: 'wbs_school',
  })
  const projected = projectLoadedWorkspace(loadedState({
    historicalClientsById: nullMap({ hcl_ola: sourceClient }),
    historicalOccurrencesById: nullMap({
      hoc_ola: monthOccurrence, hoc_school: unknownCounterparty,
    }),
    latestPopulatedMonth: '2026-07',
  }))

  assert.deepEqual(projected.historicalClients, [sourceClient])
  assert.deepEqual(projected.historicalOccurrences, [monthOccurrence, unknownCounterparty])
  assert.equal(projected.latestPopulatedMonth, '2026-07')
  assert.equal(projected.sessions.length, 1)
  assert.equal(projected.sessions.some(({ id }) => id === 'hoc_ola'), false)
  assert.equal(Object.hasOwn(projected.historicalOccurrences[0], 'date'), false)
  assert.equal(Object.hasOwn(projected.historicalOccurrences[0], 'time'), false)
  assert.notEqual(projected.historicalClients[0], sourceClient)
  assert.notEqual(projected.historicalOccurrences[0], monthOccurrence)
  assert.ok(Object.isFrozen(projected.historicalOccurrences[0].period))
})

test('keeps archived historical specialist identities out of the active team directory', () => {
  const archived = specialist({
    id: 'sp_archived_history', displayName: 'Zofia Archiwalna',
    status: 'archived', version: 5, staffVersion: 7,
  })
  const projected = projectLoadedWorkspace(loadedState({
    specialistsById: nullMap({ sp_anna: specialist(), sp_archived_history: archived }),
    historicalClientsById: nullMap({ hcl_ola: historicalClient() }),
    historicalOccurrencesById: nullMap({
      hoc_ola: historicalOccurrence({ specialistId: 'sp_archived_history' }),
    }),
    latestPopulatedMonth: '2026-07',
  }))
  assert.deepEqual(projected.psychologists.map(({ id }) => id), ['sp_anna'])
  assert.deepEqual(projected.historicalSpecialists, [{
    id: 'sp_archived_history', name: 'Zofia Archiwalna', rate: 180,
    color: 'var(--sky-deep)', status: 'archived', version: 5, staffVersion: 7,
  }])
  assert.deepEqual(specialistIdentityFor(
    projected.historicalSpecialists, 'sp_archived_history',
  ), {
    name: 'Zofia Archiwalna', color: 'var(--sky-deep)', available: true,
  })
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

test('rejects corrupt historical projection links and scoped active-client leaks', () => {
  const occurrence = historicalOccurrence()
  for (const state of [
    loadedState({
      historicalClientsById: nullMap({}),
      historicalOccurrencesById: nullMap({ hoc_ola: occurrence }),
      latestPopulatedMonth: '2026-07',
    }),
    loadedState({
      historicalClientsById: nullMap({
        hcl_ola: historicalClient({ status: 'activated', activeClientId: 'cl_missing' }),
      }),
      historicalOccurrencesById: nullMap({ hoc_ola: occurrence }),
      latestPopulatedMonth: '2026-07',
    }),
    loadedState({
      historicalClientsById: nullMap({ hcl_ola: historicalClient() }),
      historicalOccurrencesById: nullMap({
        hoc_ola: historicalOccurrence({ specialistId: 'sp_missing' }),
      }),
      latestPopulatedMonth: '2026-07',
    }),
  ]) assert.throws(() => projectLoadedWorkspace(state), TypeError)
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
