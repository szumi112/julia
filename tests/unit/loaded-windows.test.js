import test from 'node:test'
import assert from 'node:assert/strict'

import {
  captureLoadedWorkspaceLoad,
  createLoadedWorkspaceState,
  isWorkspaceWindowLoaded,
  mergeLoadedWorkspaceLoad,
  recordLoadedWorkspaceWrite,
  resetLoadedWorkspaceAuthority,
} from '../../src/loaded-windows.js'
import { projectLoadedWorkspace } from '../../src/workspace-view.js'

const range = (from, to = from) => ({ from, to })
const specialist = (id = 'sp_anna', displayName = 'Anna', status = 'active') => ({
  id, displayName, status, version: status === 'archived' ? 2 : 1,
})
const client = (id = 'cl_ola', status = 'active', specialistId = 'sp_anna') => ({
  id,
  name: id,
  status,
  readOnly: status === 'archived',
  assignment: status === 'archived' ? null : { id: `asg_${id}`, specialistId },
})
const appointment = (id, clientId, startsAt, specialistId = 'sp_anna') => ({
  id, clientId, specialistId, startsAt,
  charge: { id: `chg_${id}`, expectedAmountGrosze: 18000 },
  paymentEntries: [],
})
const historicalClient = (id = 'hcl_ola', overrides = {}) => ({
  id, name: id, status: 'historical', activeClientId: null, version: 1,
  createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-01T08:00:00.000Z',
  ...overrides,
})
const historicalOccurrence = ({
  id, historicalClientId = 'hcl_ola', counterparty = null,
  specialistId = 'sp_anna', precision = 'day', value = '2026-08-01',
  status = 'recorded', sourceRecordId = `wbs_${id}`,
}) => ({
  id,
  historicalClientId,
  counterparty,
  specialistId,
  serviceId: null,
  serviceLabel: 'Usługa historyczna',
  period: precision === 'day'
    ? { precision, day: value, month: value.slice(0, 7) }
    : precision === 'month'
      ? { precision, day: null, month: value }
      : { precision, day: null, month: null },
  status,
  version: status === 'voided' ? 2 : 1,
  sourceRecordId,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: status === 'voided'
    ? '2026-07-01T08:01:00.000Z' : '2026-07-01T08:00:00.000Z',
})
const payload = ({
  from, to = from, specialists = [], clients = [], appointments = [],
  historicalClients = [], historicalOccurrences = [], latestPopulatedMonth = null,
}) => ({
  window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
  specialists,
  clients,
  appointments,
  historicalClients,
  historicalOccurrences,
  latestPopulatedMonth,
})
const load = (state, input) => {
  const capture = captureLoadedWorkspaceLoad(state, range(input.from, input.to))
  return mergeLoadedWorkspaceLoad(state, capture, payload(input)).state
}

test('creates a deeply frozen empty loaded-workspace state', () => {
  const state = createLoadedWorkspaceState()
  assert.deepEqual(state.loadedRanges, [])
  assert.equal(Object.getPrototypeOf(state.specialistsById), null)
  assert.equal(Object.getPrototypeOf(state.clientsById), null)
  assert.equal(Object.getPrototypeOf(state.appointmentsById), null)
  assert.equal(Object.getPrototypeOf(state.historicalClientsById), null)
  assert.equal(Object.getPrototypeOf(state.historicalOccurrencesById), null)
  assert.equal(state.latestPopulatedMonth, null)
  assert.deepEqual([state.authorityGeneration, state.writeEpoch], [0, 0])
  assert.ok(Object.isFrozen(state))
  assert.ok(Object.isFrozen(state.loadedRanges))
  assert.ok(Object.isFrozen(state.clientsById))
  assert.ok(Object.isFrozen(state.historicalClientsById))
  assert.ok(Object.isFrozen(state.historicalOccurrencesById))
})

test('rejects invalid, impossible, reversed, and inexact civil ranges', () => {
  const state = createLoadedWorkspaceState()
  for (const invalid of [
    {},
    { from: '2026-02-29', to: '2026-03-01' },
    { from: '2026-08-02', to: '2026-08-01' },
    { from: '0000-12-31', to: '0001-01-01' },
    { from: '2026-8-01', to: '2026-08-02' },
    { from: '2026-08-01', to: '2026-08-02', extra: true },
  ]) assert.throws(() => captureLoadedWorkspaceLoad(state, invalid), TypeError)
})

test('captures ranges and epochs without mutating or marking state loaded', () => {
  const state = createLoadedWorkspaceState()
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-01', '2026-08-07'))
  assert.deepEqual(capture, {
    from: '2026-08-01', to: '2026-08-07', authorityGeneration: 0, writeEpoch: 0,
  })
  assert.deepEqual(state.loadedRanges, [])
  assert.ok(Object.isFrozen(capture))
})

test('normalizes overlapping, adjacent, duplicate, and subsumed loaded ranges', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, { from: '2026-08-10', to: '2026-08-12' })
  state = load(state, { from: '2026-08-01', to: '2026-08-09' })
  state = load(state, { from: '2026-08-05', to: '2026-08-11' })
  state = load(state, { from: '2026-08-01', to: '2026-08-12' })
  assert.deepEqual(state.loadedRanges, [{ from: '2026-08-01', to: '2026-08-12' }])
})

test('normalizes leap-day and year-boundary adjacency without host timezone dependence', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, { from: '0004-02-28', to: '0004-02-29' })
  state = load(state, { from: '0004-03-01', to: '0004-03-01' })
  state = load(state, { from: '2024-02-28', to: '2024-02-29' })
  state = load(state, { from: '2024-03-01', to: '2024-03-01' })
  state = load(state, { from: '2026-12-31', to: '2026-12-31' })
  state = load(state, { from: '2027-01-01', to: '2027-01-02' })
  assert.deepEqual(state.loadedRanges, [
    { from: '0004-02-28', to: '0004-03-01' },
    { from: '2024-02-28', to: '2024-03-01' },
    { from: '2026-12-31', to: '2027-01-02' },
  ])
})

test('accepts year 0001 appointment boundaries and rejects year 0000 instants', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, {
    from: '0001-06-01', specialists: [specialist()], clients: [client()],
    appointments: [appointment('apt_era', 'cl_ola', '0001-06-01T12:00:00.000Z')],
  })
  assert.deepEqual(Object.keys(state.appointmentsById), ['apt_era'])
  const capture = captureLoadedWorkspaceLoad(state, range('0001-06-02'))
  assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, payload({
    from: '0001-06-02', specialists: [specialist()], clients: [client()],
    appointments: [appointment('apt_zero', 'cl_ola', '0000-06-02T12:00:00.000Z')],
  })), TypeError)
  state = load(state, {
    from: '9999-12-31', specialists: [specialist()], clients: [client()],
  })
  assert.equal(isWorkspaceWindowLoaded(state, range('9999-12-31')), true)
})

test('reports only full union coverage and never infers coverage from rows', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, { from: '2026-08-01', to: '2026-08-03' })
  state = load(state, { from: '2026-08-05', to: '2026-08-07' })
  assert.equal(isWorkspaceWindowLoaded(state, range('2026-08-01', '2026-08-03')), true)
  assert.equal(isWorkspaceWindowLoaded(state, range('2026-08-02')), true)
  assert.equal(isWorkspaceWindowLoaded(state, range('2026-08-01', '2026-08-07')), false)
  assert.equal(isWorkspaceWindowLoaded(state, range('2026-08-04')), false)
})

test('replaces appointments inside a complete Warsaw start-date window and retains outside rows', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, {
    from: '2026-08-01', to: '2026-08-02', specialists: [specialist()],
    clients: [client()],
    appointments: [appointment('apt_old', 'cl_ola', '2026-07-31T22:00:00.000Z')],
  })
  state = load(state, {
    from: '2026-08-01', to: '2026-08-01', specialists: [specialist()],
    clients: [client()], appointments: [],
  })
  assert.deepEqual(Object.keys(state.appointmentsById), [])

  state = load(state, {
    from: '2026-08-03', to: '2026-08-03', specialists: [specialist()],
    clients: [client()],
    appointments: [appointment('apt_later', 'cl_ola', '2026-08-03T21:59:59.999Z')],
  })
  state = load(state, {
    from: '2026-08-04', to: '2026-08-04', specialists: [specialist()],
    clients: [client()], appointments: [],
  })
  assert.deepEqual(Object.keys(state.appointmentsById), ['apt_later'])
})

test('historical cache replaces day and month coverage separately, replaces every unknown row, and retains outside precision', () => {
  let state = createLoadedWorkspaceState()
  const julyClients = [
    historicalClient('hcl_july_day'),
    historicalClient('hcl_july_month'),
    historicalClient('hcl_old_unknown'),
  ]
  state = load(state, {
    from: '2026-07-01', to: '2026-07-31', specialists: [specialist()],
    historicalClients: julyClients,
    historicalOccurrences: [
      historicalOccurrence({ id: 'hoc_july_day', historicalClientId: 'hcl_july_day', value: '2026-07-12' }),
      historicalOccurrence({ id: 'hoc_july_month', historicalClientId: 'hcl_july_month', precision: 'month', value: '2026-07' }),
      historicalOccurrence({ id: 'hoc_old_unknown', historicalClientId: 'hcl_old_unknown', precision: 'unknown', value: null }),
    ],
    latestPopulatedMonth: '2026-07',
  })
  state = load(state, {
    from: '2026-08-10', to: '2026-08-20', specialists: [specialist()],
    historicalClients: [
      historicalClient('hcl_august_day'),
      historicalClient('hcl_august_month'),
      historicalClient('hcl_new_unknown'),
    ],
    historicalOccurrences: [
      historicalOccurrence({ id: 'hoc_august_day', historicalClientId: 'hcl_august_day', value: '2026-08-12' }),
      historicalOccurrence({ id: 'hoc_august_month', historicalClientId: 'hcl_august_month', precision: 'month', value: '2026-08' }),
      historicalOccurrence({ id: 'hoc_new_unknown', historicalClientId: 'hcl_new_unknown', precision: 'unknown', value: null }),
    ],
    latestPopulatedMonth: '2026-08',
  })

  assert.deepEqual(Object.keys(state.historicalOccurrencesById).sort(), [
    'hoc_august_day', 'hoc_august_month', 'hoc_july_day', 'hoc_july_month',
    'hoc_new_unknown',
  ])
  assert.deepEqual(Object.keys(state.historicalClientsById).sort(), [
    'hcl_august_day', 'hcl_august_month', 'hcl_july_day', 'hcl_july_month',
    'hcl_new_unknown',
  ])
  assert.equal(state.latestPopulatedMonth, '2026-08')

  state = load(state, {
    from: '2026-08-15', to: '2026-08-15', specialists: [specialist()],
    historicalClients: [], historicalOccurrences: [], latestPopulatedMonth: '2026-08',
  })
  assert.deepEqual(Object.keys(state.historicalOccurrencesById).sort(), [
    'hoc_august_day', 'hoc_july_day', 'hoc_july_month',
  ])
  assert.deepEqual(Object.keys(state.historicalClientsById).sort(), [
    'hcl_august_day', 'hcl_july_day', 'hcl_july_month',
  ])
  assert.equal(state.latestPopulatedMonth, '2026-08')
})

test('historical month replacement follows month overlap while exact days follow civil coverage', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, {
    from: '2026-08-01', to: '2026-08-31', specialists: [specialist()],
    historicalClients: [historicalClient('hcl_day'), historicalClient('hcl_month')],
    historicalOccurrences: [
      historicalOccurrence({ id: 'hoc_day', historicalClientId: 'hcl_day', value: '2026-08-20' }),
      historicalOccurrence({ id: 'hoc_month', historicalClientId: 'hcl_month', precision: 'month', value: '2026-08' }),
    ],
    latestPopulatedMonth: '2026-08',
  })
  state = load(state, {
    from: '2026-08-01', to: '2026-08-01', specialists: [specialist()],
    historicalClients: [], historicalOccurrences: [], latestPopulatedMonth: '2026-08',
  })
  assert.deepEqual(Object.keys(state.historicalOccurrencesById), ['hoc_day'])
  assert.deepEqual(Object.keys(state.historicalClientsById), ['hcl_day'])
})

test('historical merge rejects unresolved subjects, specialist leaks, invalid precision windows, and outside collisions', () => {
  const state = createLoadedWorkspaceState()
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-01', '2026-08-31'))
  const cases = [
    payload({
      from: '2026-08-01', to: '2026-08-31', specialists: [specialist()],
      historicalOccurrences: [historicalOccurrence({ id: 'hoc_orphan' })],
      latestPopulatedMonth: '2026-08',
    }),
    payload({
      from: '2026-08-01', to: '2026-08-31', specialists: [specialist()],
      historicalClients: [historicalClient()],
      historicalOccurrences: [historicalOccurrence({ id: 'hoc_leak', specialistId: 'sp_other' })],
      latestPopulatedMonth: '2026-08',
    }),
    payload({
      from: '2026-08-01', to: '2026-08-31', specialists: [specialist()],
      historicalClients: [historicalClient()],
      historicalOccurrences: [historicalOccurrence({ id: 'hoc_outside', value: '2026-09-01' })],
      latestPopulatedMonth: '2026-09',
    }),
    payload({
      from: '2026-08-01', to: '2026-08-31', specialists: [specialist()],
      historicalClients: [historicalClient()],
      historicalOccurrences: [historicalOccurrence({ id: 'hoc_latest' })],
      latestPopulatedMonth: null,
    }),
  ]
  for (const value of cases) {
    assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, value), TypeError)
  }

  let retained = load(state, {
    from: '2026-07-01', to: '2026-07-31', specialists: [specialist()],
    historicalClients: [historicalClient()],
    historicalOccurrences: [historicalOccurrence({ id: 'hoc_same', value: '2026-07-01' })],
    latestPopulatedMonth: '2026-07',
  })
  const next = captureLoadedWorkspaceLoad(retained, range('2026-08-01', '2026-08-31'))
  for (const occurrence of [
    historicalOccurrence({ id: 'hoc_same', value: '2026-08-01', sourceRecordId: 'wbs_new' }),
    historicalOccurrence({ id: 'hoc_new', value: '2026-08-01', sourceRecordId: 'wbs_hoc_same' }),
  ]) {
    assert.throws(() => mergeLoadedWorkspaceLoad(retained, next, payload({
      from: '2026-08-01', to: '2026-08-31', specialists: [specialist()],
      historicalClients: [historicalClient()], historicalOccurrences: [occurrence],
      latestPopulatedMonth: '2026-08',
    })), TypeError)
  }
})

test('replaces complete specialist and active-client directories instead of unioning stale rows', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, {
    from: '2026-08-01', specialists: [specialist('sp_anna')],
    clients: [client('cl_ola', 'active', 'sp_anna')],
  })
  state = load(state, {
    from: '2026-08-02', specialists: [specialist('sp_beata')],
    clients: [client('cl_jan', 'paused', 'sp_beata')],
  })
  assert.deepEqual(Object.keys(state.specialistsById), ['sp_beata'])
  assert.deepEqual(Object.keys(state.clientsById), ['cl_jan'])
})

test('retains only archived specialists referenced by historical records across disjoint loads', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, {
    from: '2026-08-01', to: '2026-08-31',
    specialists: [
      specialist(), specialist('sp_archived', 'Archiwalna', 'archived'),
    ],
    historicalClients: [historicalClient()],
    historicalOccurrences: [historicalOccurrence({
      id: 'hoc_archived_specialist', specialistId: 'sp_archived', value: '2026-08-12',
    })],
    latestPopulatedMonth: '2026-08',
  })
  state = load(state, {
    from: '2026-09-01', to: '2026-09-30', specialists: [specialist()],
    latestPopulatedMonth: '2026-08',
  })
  assert.deepEqual(Object.keys(state.specialistsById).sort(), ['sp_anna', 'sp_archived'])
  assert.equal(state.specialistsById.sp_archived.status, 'archived')
  assert.equal(state.historicalOccurrencesById.hoc_archived_specialist.specialistId,
    'sp_archived')

  assert.throws(() => load(state, {
    from: '2026-10-01', to: '2026-10-31',
    specialists: [specialist(), specialist('sp_leaked', 'Ukryta', 'archived')],
    latestPopulatedMonth: '2026-08',
  }), TypeError)

  state = load(state, {
    from: '2026-08-01', to: '2026-08-31', specialists: [specialist()],
    latestPopulatedMonth: null,
  })
  assert.deepEqual(Object.keys(state.specialistsById), ['sp_anna'])
  assert.deepEqual(Object.keys(state.historicalOccurrencesById), [])
})

test('downgrades an omitted active specialist to historical-only attribution', () => {
  const previouslyActive = {
    id: 'sp_transitioned', displayName: 'Specjalistka Historyczna',
    standardRateGrosze: 18000, status: 'active', version: 3, staffVersion: 4,
    accessStatus: 'enabled',
  }
  const currentActive = {
    id: 'sp_current', displayName: 'Specjalistka Aktywna',
    standardRateGrosze: 19000, status: 'active', version: 1, staffVersion: 2,
    accessStatus: 'enabled',
  }
  let state = createLoadedWorkspaceState()
  state = load(state, {
    from: '2026-08-01', to: '2026-08-31', specialists: [previouslyActive],
    historicalClients: [historicalClient()],
    historicalOccurrences: [historicalOccurrence({
      id: 'hoc_transitioned_specialist', specialistId: 'sp_transitioned',
      value: '2026-08-12',
    })],
    latestPopulatedMonth: '2026-08',
  })
  state = load(state, {
    from: '2026-09-01', to: '2026-09-30', specialists: [currentActive],
    latestPopulatedMonth: '2026-08',
  })

  assert.equal(state.specialistsById.sp_transitioned.status, 'archived')
  assert.equal(Object.hasOwn(state.specialistsById.sp_transitioned, 'accessStatus'), false)
  assert.equal(state.historicalOccurrencesById.hoc_transitioned_specialist.specialistId,
    'sp_transitioned')
  const view = projectLoadedWorkspace(state)
  assert.deepEqual(view.psychologists.map(({ id }) => id), ['sp_current'])
  assert.deepEqual(view.historicalSpecialists.map(({ id, status }) => ({ id, status })), [{
    id: 'sp_transitioned', status: 'archived',
  }])
})

test('retains archived clients referenced across windows and prunes the last unreferenced archive', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, {
    from: '2026-08-01', specialists: [specialist()], clients: [client('cl_old', 'archived')],
    appointments: [appointment('apt_first', 'cl_old', '2026-08-01T08:00:00.000Z')],
  })
  state = load(state, {
    from: '2026-08-02', specialists: [specialist()], clients: [client('cl_new', 'archived')],
    appointments: [appointment('apt_second', 'cl_new', '2026-08-02T08:00:00.000Z')],
  })
  assert.deepEqual(Object.keys(state.clientsById).sort(), ['cl_new', 'cl_old'])
  state = load(state, {
    from: '2026-08-01', specialists: [specialist()], clients: [], appointments: [],
  })
  assert.deepEqual(Object.keys(state.clientsById), ['cl_new'])
})

test('rejects resurrection of a retained archived ID as an active directory client', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, {
    from: '2026-08-01', specialists: [specialist()], clients: [client('cl_old', 'archived')],
    appointments: [appointment('apt_old', 'cl_old', '2026-08-01T08:00:00.000Z')],
  })
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-02'))
  assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, payload({
    from: '2026-08-02', specialists: [specialist()], clients: [client('cl_old')],
  })), TypeError)
})

test('rejects unreferenced archives and appointments with missing clients before marking coverage', () => {
  const state = createLoadedWorkspaceState()
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-01'))
  assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, payload({
    from: '2026-08-01', clients: [client('cl_old', 'archived')],
  })), TypeError)
  assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, payload({
    from: '2026-08-01', appointments: [
      appointment('apt_orphan', 'cl_missing', '2026-08-01T08:00:00.000Z'),
    ],
  })), TypeError)
  assert.deepEqual(state.loadedRanges, [])
})

test('rejects duplicate and cross-type IDs and appointments outside the returned Warsaw window', () => {
  const state = createLoadedWorkspaceState()
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-01'))
  const cases = [
    payload({ from: '2026-08-01', specialists: [specialist(), specialist()] }),
    payload({ from: '2026-08-01', clients: [client(), client()] }),
    payload({
      from: '2026-08-01', specialists: [specialist()], clients: [client()],
      appointments: [appointment('apt_one', 'cl_ola', '2026-08-02T00:00:00.000Z')],
    }),
    payload({
      from: '2026-08-01', specialists: [specialist('sp_same')],
      clients: [{ ...client('cl_same', 'active', 'sp_same'), id: 'sp_same' }],
    }),
  ]
  for (const value of cases) assert.throws(
    () => mergeLoadedWorkspaceLoad(state, capture, value), TypeError,
  )
})

test('rejects duplicate nested assignment, charge, and payment-entry IDs', () => {
  const state = createLoadedWorkspaceState()
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-01'))
  const duplicateAssignments = payload({
    from: '2026-08-01', specialists: [specialist()],
    clients: [
      client('cl_one'),
      { ...client('cl_two'), assignment: { id: 'asg_cl_one', specialistId: 'sp_anna' } },
    ],
  })
  const first = appointment('apt_one', 'cl_ola', '2026-08-01T08:00:00.000Z')
  first.paymentEntries = [{ id: 'pay_same' }]
  const second = appointment('apt_two', 'cl_ola', '2026-08-01T09:00:00.000Z')
  second.charge.id = first.charge.id
  second.paymentEntries = [{ id: 'pay_same' }]
  const duplicateLedgerIds = payload({
    from: '2026-08-01', specialists: [specialist()], clients: [client()],
    appointments: [first, second],
  })
  for (const value of [duplicateAssignments, duplicateLedgerIds]) {
    assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, value), TypeError)
  }
})

test('rejects an appointment ID that collides with a retained appointment outside the window', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, {
    from: '2026-08-01', specialists: [specialist()], clients: [client()],
    appointments: [appointment('apt_same', 'cl_ola', '2026-08-01T08:00:00.000Z')],
  })
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-02'))
  assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, payload({
    from: '2026-08-02', specialists: [specialist()], clients: [client()],
    appointments: [appointment('apt_same', 'cl_ola', '2026-08-02T08:00:00.000Z')],
  })), TypeError)
})

test('rejects nested ledger IDs that collide with retained appointments', () => {
  let state = createLoadedWorkspaceState()
  state = load(state, {
    from: '2026-08-01', specialists: [specialist()], clients: [client()],
    appointments: [appointment('apt_old', 'cl_ola', '2026-08-01T08:00:00.000Z')],
  })
  const next = appointment('apt_new', 'cl_ola', '2026-08-02T08:00:00.000Z')
  next.charge.id = 'chg_apt_old'
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-02'))
  assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, payload({
    from: '2026-08-02', specialists: [specialist()], clients: [client()],
    appointments: [next],
  })), TypeError)
})

test('resets authority to a fresh empty generation and ignores old loads', () => {
  let state = createLoadedWorkspaceState()
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-01'))
  state = resetLoadedWorkspaceAuthority(state)
  assert.deepEqual([state.authorityGeneration, state.writeEpoch], [1, 0])
  assert.deepEqual(state.loadedRanges, [])
  assert.deepEqual(Object.keys(state.historicalClientsById), [])
  assert.deepEqual(Object.keys(state.historicalOccurrencesById), [])
  assert.equal(state.latestPopulatedMonth, null)
  const result = mergeLoadedWorkspaceLoad(state, capture, payload({ from: '2026-08-01' }))
  assert.deepEqual(
    { outcome: result.outcome, refetch: result.refetch, same: result.state === state },
    { outcome: 'ignored-authority', refetch: false, same: true },
  )
})

test('discards pre-write loads with an explicit refetch signal', () => {
  let state = createLoadedWorkspaceState()
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-01'))
  state = recordLoadedWorkspaceWrite(state)
  const result = mergeLoadedWorkspaceLoad(state, capture, payload({
    from: '2026-08-01', specialists: [specialist()],
  }))
  assert.deepEqual(
    { outcome: result.outcome, refetch: result.refetch, same: result.state === state },
    { outcome: 'stale-write', refetch: true, same: true },
  )
  assert.deepEqual(state.loadedRanges, [])
})

test('merges same-epoch concurrent loads into latest state in either completion order', () => {
  for (const order of [['first', 'second'], ['second', 'first']]) {
    let state = createLoadedWorkspaceState()
    const captures = {
      first: captureLoadedWorkspaceLoad(state, range('2026-08-01')),
      second: captureLoadedWorkspaceLoad(state, range('2026-08-02')),
    }
    const values = {
      first: payload({
        from: '2026-08-01', specialists: [specialist()],
        clients: [client(), client('cl_old', 'archived')],
        appointments: [appointment('apt_first', 'cl_old', '2026-08-01T08:00:00.000Z')],
      }),
      second: payload({
        from: '2026-08-02', specialists: [specialist()], clients: [client()],
        appointments: [appointment('apt_second', 'cl_ola', '2026-08-02T08:00:00.000Z')],
      }),
    }
    for (const key of order) {
      const result = mergeLoadedWorkspaceLoad(state, captures[key], values[key])
      assert.deepEqual([result.outcome, result.refetch], ['merged', false])
      state = result.state
    }
    assert.deepEqual(Object.keys(state.appointmentsById).sort(), ['apt_first', 'apt_second'])
    assert.deepEqual(state.loadedRanges, [{ from: '2026-08-01', to: '2026-08-02' }])
  }
})

test('captures caller data deeply and freezes merge state and result', () => {
  const specialists = [specialist()]
  const clients = [client()]
  const appointments = [appointment('apt_one', 'cl_ola', '2026-08-01T08:00:00.000Z')]
  const state = createLoadedWorkspaceState()
  const result = mergeLoadedWorkspaceLoad(
    state,
    captureLoadedWorkspaceLoad(state, range('2026-08-01')),
    payload({ from: '2026-08-01', specialists, clients, appointments }),
  )
  specialists[0].displayName = 'Changed'
  appointments[0].charge.expectedAmountGrosze = 1
  assert.equal(result.state.specialistsById.sp_anna.displayName, 'Anna')
  assert.equal(result.state.appointmentsById.apt_one.charge.expectedAmountGrosze, 18000)
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.state.appointmentsById.apt_one.charge))
  assert.ok(Object.isFrozen(result.state.appointmentsById.apt_one.paymentEntries))
})

test('rejects nested prototype-pollution keys without inheritance or source mutation', () => {
  const state = createLoadedWorkspaceState()
  const source = appointment('apt_pollution', 'cl_ola', '2026-08-01T08:00:00.000Z')
  Object.defineProperty(source.charge, '__proto__', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: { polluted: true },
  })
  const sourcePrototype = Object.getPrototypeOf(source.charge)
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-01'))
  assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, payload({
    from: '2026-08-01', specialists: [specialist()], clients: [client()],
    appointments: [source],
  })), TypeError)
  assert.equal(Object.getPrototypeOf(source.charge), sourcePrototype)
  assert.equal(source.charge.polluted, undefined)
  assert.equal({}.polluted, undefined)

  const inherited = Object.create({ status: 'active' })
  Object.assign(inherited, { id: 'sp_inherited', displayName: 'Inherited', version: 1 })
  assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, payload({
    from: '2026-08-01', specialists: [inherited],
  })), TypeError)

  const missingOwnStatus = { id: 'sp_missing', displayName: 'Missing', version: 1 }
  Object.defineProperty(Object.prototype, 'status', {
    configurable: true,
    value: 'active',
  })
  try {
    assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, payload({
      from: '2026-08-01', specialists: [missingOwnStatus],
    })), TypeError)
  } finally {
    delete Object.prototype.status
  }
})

test('preserves safe canonical own fields without retaining caller references', () => {
  const state = createLoadedWorkspaceState()
  const source = appointment('apt_fields', 'cl_ola', '2026-08-01T08:00:00.000Z')
  source.payment = { status: 'unpaid', latestMethod: null }
  const result = mergeLoadedWorkspaceLoad(
    state,
    captureLoadedWorkspaceLoad(state, range('2026-08-01')),
    payload({
      from: '2026-08-01', specialists: [specialist()], clients: [client()],
      appointments: [source],
    }),
  )
  assert.deepEqual(result.state.appointmentsById.apt_fields.payment, {
    status: 'unpaid', latestMethod: null,
  })
  assert.notEqual(result.state.appointmentsById.apt_fields.payment, source.payment)
})

test('fails closed on mismatched, incomplete, extra, accessor, sparse, and proxy payloads', () => {
  const state = createLoadedWorkspaceState()
  const capture = captureLoadedWorkspaceLoad(state, range('2026-08-01'))
  const mismatched = payload({ from: '2026-08-02' })
  const incomplete = payload({ from: '2026-08-01' })
  incomplete.window.complete = false
  const extra = { ...payload({ from: '2026-08-01' }), extra: true }
  let reads = 0
  const accessor = payload({ from: '2026-08-01' })
  Object.defineProperty(accessor, 'clients', { enumerable: true, get() { reads += 1; return [] } })
  const sparse = payload({ from: '2026-08-01' })
  sparse.clients = new Array(1)
  const hostile = new Proxy({}, { ownKeys() { throw new Error('trap') } })
  for (const value of [mismatched, incomplete, extra, accessor, sparse, hostile]) {
    assert.throws(() => mergeLoadedWorkspaceLoad(state, capture, value), TypeError)
  }
  assert.equal(reads, 0)
  assert.deepEqual(state.loadedRanges, [])
})

test('rejects hidden and symbol range properties without invoking accessors', () => {
  const state = createLoadedWorkspaceState()
  let reads = 0
  const hidden = range('2026-08-01')
  Object.defineProperty(hidden, 'hidden', { value: true })
  const symbol = range('2026-08-01')
  symbol[Symbol('extra')] = true
  const accessor = {}
  Object.defineProperty(accessor, 'from', { enumerable: true, get() { reads += 1; return '2026-08-01' } })
  Object.defineProperty(accessor, 'to', { enumerable: true, value: '2026-08-01' })
  for (const value of [hidden, symbol, accessor]) {
    assert.throws(() => captureLoadedWorkspaceLoad(state, value), TypeError)
  }
  assert.equal(reads, 0)
})

test('guards safe-integer generation and write-epoch increments', () => {
  let state = createLoadedWorkspaceState()
  state = Object.freeze({ ...state, authorityGeneration: Number.MAX_SAFE_INTEGER })
  assert.throws(() => resetLoadedWorkspaceAuthority(state), RangeError)
  state = Object.freeze({ ...createLoadedWorkspaceState(), writeEpoch: Number.MAX_SAFE_INTEGER })
  assert.throws(() => recordLoadedWorkspaceWrite(state), RangeError)
})

test('authenticates every public state argument before reading or returning it', () => {
  const canonical = createLoadedWorkspaceState()
  let reads = 0
  const accessor = {}
  for (const key of Object.keys(canonical)) {
    Object.defineProperty(accessor, key, key === 'writeEpoch'
      ? { enumerable: true, get() { reads += 1; return 0 } }
      : { enumerable: true, value: canonical[key] })
  }
  const proxy = new Proxy({}, { ownKeys() { throw new Error('state trap') } })
  const extra = Object.freeze({ ...canonical, extra: true })
  const mutableRanges = Object.freeze({ ...canonical, loadedRanges: [] })
  const badRange = Object.freeze({
    ...canonical,
    loadedRanges: Object.freeze([Object.freeze({ from: '2026-08-02', to: '2026-08-01' })]),
  })
  const plainMap = Object.freeze({ ...canonical, clientsById: Object.freeze({}) })
  const hidden = { ...canonical }
  Object.defineProperty(hidden, 'extra', { value: true })
  Object.freeze(hidden)
  const mapAccessor = Object.create(null)
  Object.defineProperty(mapAccessor, 'sp_trap', {
    enumerable: true,
    get() { reads += 1; return specialist('sp_trap') },
  })
  Object.freeze(mapAccessor)
  const accessorMapState = Object.freeze({ ...canonical, specialistsById: mapAccessor })
  const validCapture = captureLoadedWorkspaceLoad(canonical, range('2026-08-01'))
  const validPayload = payload({ from: '2026-08-01' })
  for (const value of [
    accessor, proxy, extra, hidden, mutableRanges, badRange, plainMap, accessorMapState,
  ]) {
    assert.throws(() => captureLoadedWorkspaceLoad(value, range('2026-08-01')), TypeError)
    assert.throws(() => isWorkspaceWindowLoaded(value, range('2026-08-01')), TypeError)
    assert.throws(() => recordLoadedWorkspaceWrite(value), TypeError)
    assert.throws(() => resetLoadedWorkspaceAuthority(value), TypeError)
    assert.throws(() => mergeLoadedWorkspaceLoad(value, validCapture, validPayload), TypeError)
  }
  assert.equal(reads, 0)
})

test('rejects mutable, key-mismatched, and referentially corrupt state entities', () => {
  let canonical = createLoadedWorkspaceState()
  canonical = load(canonical, {
    from: '2026-08-01', specialists: [specialist()], clients: [client()],
    appointments: [appointment('apt_state', 'cl_ola', '2026-08-01T08:00:00.000Z')],
  })
  const nullMap = (entries) => {
    const value = Object.create(null)
    for (const [key, item] of entries) value[key] = item
    return Object.freeze(value)
  }
  const mutableClient = { ...canonical.clientsById.cl_ola }
  const mutableEntityState = Object.freeze({
    ...canonical,
    clientsById: nullMap([['cl_ola', mutableClient]]),
  })
  const mismatchedKeyState = Object.freeze({
    ...canonical,
    clientsById: nullMap([['cl_wrong', canonical.clientsById.cl_ola]]),
  })
  const orphanState = Object.freeze({
    ...canonical,
    clientsById: Object.freeze(Object.create(null)),
  })
  for (const value of [mutableEntityState, mismatchedKeyState, orphanState]) {
    assert.throws(() => isWorkspaceWindowLoaded(value, range('2026-08-01')), TypeError)
  }
})

test('all public transitions return state that remains immutable after mutation probes', () => {
  const initial = createLoadedWorkspaceState()
  const written = recordLoadedWorkspaceWrite(initial)
  const reset = resetLoadedWorkspaceAuthority(written)
  const capture = captureLoadedWorkspaceLoad(reset, range('2026-08-01'))
  const merged = mergeLoadedWorkspaceLoad(reset, capture, payload({ from: '2026-08-01' })).state
  for (const value of [initial, written, reset, merged]) {
    assert.ok(Object.isFrozen(value))
    assert.ok(Object.isFrozen(value.loadedRanges))
    assert.ok(Object.isFrozen(value.specialistsById))
    assert.throws(() => { value.writeEpoch = 9 }, TypeError)
    assert.throws(() => { value.loadedRanges.push(range('2026-08-02')) }, TypeError)
    assert.throws(() => { value.clientsById.cl_bad = client('cl_bad') }, TypeError)
  }
})
