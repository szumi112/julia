import test from 'node:test'
import assert from 'node:assert/strict'
import {
  captureLoadedActivitiesState,
  captureLoadedActivitiesLoad,
  createLoadedActivitiesState,
  isActivityWindowLoaded,
  mergeLoadedActivitiesLoad,
  recordLoadedActivitiesWrite,
  resetLoadedActivitiesAuthority,
  activityLoadRequestKey,
} from '../../src/loaded-activities.js'

const NOW = '2025-01-01T10:00:00.000Z'

const program = (code) => ({
  id: `apg_${code}`, code, label: code === 'tus' ? 'TUS' : 'Angielski',
  status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
})

const group = (id = 'agr_tus_one') => ({
  id, programId: 'apg_tus', label: 'Grupa TUS', details: null,
  status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
})

const leader = (id = 'agl_tus_one', groupId = 'agr_tus_one') => ({
  id, groupId, specialistId: 'sp_julia', startsOn: '2025-01-01', endsOn: null,
  status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
})

const participant = (id, programId) => ({
  id, programId, name: id === 'acp_tus_one' ? 'Fikcyjna Tusia' : 'Fikcyjny Anglista',
  clientId: null, historicalClientId: null, status: 'active', version: 1,
  createdAt: NOW, updatedAt: NOW,
})

const membership = (month = '2025-01') => ({
  id: `amb_${month.replace('-', '_')}`, participantId: 'acp_tus_one',
  programId: 'apg_tus', groupId: 'agr_tus_one', membershipKind: 'observation',
  period: { precision: 'month', day: null, month }, startsOn: null, endsOn: null,
  status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
})

const attendanceMembership = (month = '2025-01') => ({
  ...membership(month), id: `amb_attendance_${month.replace('-', '_')}`,
  period: { precision: 'day', day: `${month}-15`, month },
})

const activityClass = (month = '2025-01') => ({
  id: `acl_${month.replace('-', '_')}`, groupId: 'agr_tus_one', date: `${month}-15`,
  time: null, durationMinutes: null, topic: null, status: 'scheduled', version: 1,
  createdAt: NOW, updatedAt: NOW,
})

const attendance = (month = '2025-01') => ({
  id: `aat_${month.replace('-', '_')}`, classId: `acl_${month.replace('-', '_')}`,
  participantId: 'acp_tus_one', status: 'present', version: 1,
  createdAt: NOW, updatedAt: NOW,
})

const charge = ({
  id, programId, participantId, month, groupId = null, membershipId = null,
  lessonCount = null, status = 'active', financeEntryId,
}) => ({
  id, participantId, programId, groupId, membershipId,
  period: { precision: 'month', day: null, month }, lessonCount,
  responsibleSpecialistId: 'sp_julia', financeEntryId, status, version: 1,
  finance: {
    amountGrosze: 18_000, paidAmountGrosze: 18_000,
    paymentMethod: 'cash', settlementStatus: 'paid',
  },
  createdAt: NOW, updatedAt: NOW,
})

const payload = ({ from, to = from, kind = 'tus', includeClass = false,
  empty = false, directoryKinds = [kind] } = {}) => {
  const hasTus = directoryKinds.includes('tus')
  const hasEnglish = directoryKinds.includes('english')
  const directories = {
    programs: directoryKinds.map(program).sort((left, right) => left.id.localeCompare(right.id)),
    groups: hasTus ? [group()] : [],
    groupLeaders: hasTus ? [leader()] : [],
    participants: [
      ...(hasTus ? [participant('acp_tus_one', 'apg_tus')] : []),
      ...(hasEnglish ? [participant('acp_english_one', 'apg_english')] : []),
    ].sort((left, right) => left.id.localeCompare(right.id)),
  }
  if (empty) return {
    from, to, complete: true, currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: null, english: null },
    ...directories, memberships: [], classes: [], attendance: [], charges: [], payments: [],
  }
  if (kind === 'english') return {
    from, to, complete: true, currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: '2025-01', english: from },
    ...directories, memberships: [],
    classes: [], attendance: [],
    charges: [charge({
      id: `ach_english_${from.replace('-', '_')}`, programId: 'apg_english',
      participantId: 'acp_english_one', month: from, lessonCount: 0,
      financeEntryId: `fin_english_${from.replace('-', '_')}`,
    })],
    payments: [],
  }
  const monthMembership = membership(from)
  const monthClass = activityClass(from)
  const monthCharge = charge({
    id: `ach_tus_${from.replace('-', '_')}`, programId: 'apg_tus',
    participantId: 'acp_tus_one', month: from, groupId: 'agr_tus_one',
    membershipId: monthMembership.id, financeEntryId: `fin_tus_${from.replace('-', '_')}`,
  })
  return {
    from, to, complete: true, currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: from, english: null },
    ...directories,
    memberships: includeClass ? [monthMembership, attendanceMembership(from)] : [monthMembership],
    classes: includeClass ? [monthClass] : [],
    attendance: includeClass ? [attendance(from)] : [], charges: [monthCharge],
    payments: [],
  }
}

const load = (state, from, to = from, loadSequence) => (
  captureLoadedActivitiesLoad(state, { from, to }, loadSequence)
)

const withFixedDate = (value, callback) => {
  const NativeDate = globalThis.Date
  class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length === 0 ? [value] : args)) }
    static now() { return new NativeDate(value).getTime() }
  }
  globalThis.Date = FixedDate
  try { return callback() } finally { globalThis.Date = NativeDate }
}

test('creates the exact deeply frozen empty activity cache', () => {
  const state = createLoadedActivitiesState()
  assert.deepEqual(Object.keys(state), [
    'loadedMonths', 'programsById', 'groupsById', 'groupLeadersById',
    'participantsById', 'membershipsById', 'classesById', 'attendanceById',
    'chargesById', 'paymentsById', 'latestPopulatedMonths',
    'latestThroughMonth', 'authorityGeneration', 'writeEpoch', 'directorySequence',
  ])
  assert.deepEqual(state.loadedMonths, [])
  assert.equal(Object.getPrototypeOf(state.programsById), null)
  assert.deepEqual(state.latestPopulatedMonths, { tus: null, english: null })
  assert.equal(Object.isFrozen(state), true)
  assert.equal(Object.isFrozen(state.latestPopulatedMonths), true)
})

test('captures only canonical inclusive month windows of at most twelve months', () => {
  const state = createLoadedActivitiesState()
  assert.deepEqual(load(state, '2024-02', '2025-01'), {
    from: '2024-02', to: '2025-01', authorityGeneration: 0, writeEpoch: 0,
    loadSequence: 1,
  })
  for (const request of [
    { from: '2024-01', to: '2025-01' },
    { from: '2025-02', to: '2025-01' },
    { from: '2025-2', to: '2025-02' },
    { from: '0000-01', to: '0000-01' },
  ]) assert.throws(() => captureLoadedActivitiesLoad(state, request), /activity/i)
})

test('merges disjoint complete windows and retains their canonical relationship graphs', () => {
  let state = createLoadedActivitiesState()
  state = mergeLoadedActivitiesLoad(
    state, load(state, '2025-01'), payload({ from: '2025-01', includeClass: true }),
  ).state
  state = mergeLoadedActivitiesLoad(
    state, load(state, '2025-03'), payload({ from: '2025-03', kind: 'english' }),
  ).state

  assert.deepEqual(state.loadedMonths, [
    { from: '2025-01', to: '2025-01' },
    { from: '2025-03', to: '2025-03' },
  ])
  assert.deepEqual(Object.keys(state.programsById).sort(), ['apg_english', 'apg_tus'])
  assert.deepEqual(Object.keys(state.participantsById).sort(), [
    'acp_english_one', 'acp_tus_one',
  ])
  assert.deepEqual(Object.keys(state.groupsById), ['agr_tus_one'])
  assert.deepEqual(Object.keys(state.groupLeadersById), [])
  assert.deepEqual(Object.keys(state.chargesById).sort(), [
    'ach_english_2025_03', 'ach_tus_2025_01',
  ])
  assert.equal(isActivityWindowLoaded(state, { from: '2025-01', to: '2025-03' }), false)
  assert.equal(isActivityWindowLoaded(state, { from: '2025-03', to: '2025-03' }), true)
})

test('replaces window facts while retaining complete empty global directories', () => {
  let state = createLoadedActivitiesState()
  state = mergeLoadedActivitiesLoad(
    state, load(state, '2025-01'),
    payload({ from: '2025-01', includeClass: true }),
  ).state
  state = mergeLoadedActivitiesLoad(
    state, load(state, '2025-02'), payload({
      from: '2025-02', kind: 'english', directoryKinds: ['tus', 'english'],
    }),
  ).state
  const emptyJanuary = payload({
    from: '2025-01', empty: true, directoryKinds: ['tus', 'english'],
  })
  emptyJanuary.latestPopulatedMonths.english = '2025-02'
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-01'), emptyJanuary).state

  assert.deepEqual(Object.keys(state.membershipsById), [])
  assert.deepEqual(Object.keys(state.classesById), [])
  assert.deepEqual(Object.keys(state.attendanceById), [])
  assert.deepEqual(Object.keys(state.paymentsById), [])
  assert.deepEqual(Object.keys(state.groupsById), ['agr_tus_one'])
  assert.deepEqual(Object.keys(state.groupLeadersById), ['agl_tus_one'])
  assert.deepEqual(Object.keys(state.participantsById).sort(), [
    'acp_english_one', 'acp_tus_one',
  ])
  assert.deepEqual(Object.keys(state.programsById), ['apg_english', 'apg_tus'])
  assert.deepEqual(state.latestPopulatedMonths, { tus: null, english: '2025-02' })
})

test('replaces native interval memberships as a global directory independent of the window', () => {
  let state = createLoadedActivitiesState()
  const january = payload({ from: '2025-01' })
  january.memberships = [{
    ...january.memberships[0], id: 'amb_interval_one', membershipKind: 'interval',
    period: { precision: 'unknown', day: null, month: null },
    startsOn: '2025-01-20', endsOn: '2025-03-04',
  }]
  january.charges[0] = { ...january.charges[0], membershipId: 'amb_interval_one' }
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-01'), january).state

  const april = payload({ from: '2025-04', empty: true })
  april.memberships = [{
    ...january.memberships[0], version: 2, status: 'inactive', updatedAt: '2025-04-01T10:00:00.000Z',
  }]
  april.latestPopulatedMonths.tus = '2025-01'
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-04'), april).state
  assert.deepEqual(
    Object.values(state.membershipsById)
      .filter(({ membershipKind }) => membershipKind === 'interval')
      .map(({ id }) => id),
    ['amb_interval_one'],
  )
  assert.equal(state.membershipsById.amb_interval_one.version, 2)
})

test('accepts an identical global interval in a disjoint response and removes it when authority omits it', () => {
  let state = createLoadedActivitiesState()
  const january = payload({ from: '2025-01' })
  const interval = {
    ...january.memberships[0], id: 'amb_interval_one', membershipKind: 'interval',
    period: { precision: 'unknown', day: null, month: null },
    startsOn: '2025-01-20', endsOn: null,
  }
  january.memberships = [january.memberships[0], interval]
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-01'), january).state

  const april = payload({ from: '2025-04', empty: true })
  april.memberships = [interval]
  april.latestPopulatedMonths.tus = '2025-01'
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-04'), april).state
  assert.deepEqual(
    Object.values(state.membershipsById)
      .filter(({ membershipKind }) => membershipKind === 'interval')
      .map(({ id }) => id),
    ['amb_interval_one'],
  )

  const may = payload({ from: '2025-05', empty: true })
  may.latestPopulatedMonths.tus = '2025-01'
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-05'), may).state
  assert.deepEqual(
    Object.values(state.membershipsById)
      .filter(({ membershipKind }) => membershipKind === 'interval'),
    [],
  )
  assert.ok(state.chargesById.ach_tus_2025_01)
})

test('never resurrects an active leader omitted or downgraded by a later directory response', () => {
  let state = createLoadedActivitiesState()
  state = mergeLoadedActivitiesLoad(
    state, load(state, '2025-01'), payload({ from: '2025-01' }),
  ).state

  const omitted = payload({ from: '2025-03', kind: 'english' })
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-03'), omitted).state
  assert.ok(state.groupsById.agr_tus_one, 'retained January charge still needs its group')
  assert.equal(state.groupLeadersById.agl_tus_one, undefined)

  const inactive = payload({
    from: '2025-04', kind: 'english', directoryKinds: ['english', 'tus'],
  })
  inactive.groupLeaders = [{
    ...inactive.groupLeaders[0], status: 'inactive', endsOn: '2025-03-31', version: 2,
    updatedAt: '2025-04-01T10:00:00.000Z',
  }]
  inactive.latestPopulatedMonths.tus = '2025-01'
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-04'), inactive).state
  assert.equal(state.groupLeadersById.agl_tus_one.status, 'inactive')
  assert.equal(state.groupLeadersById.agl_tus_one.version, 2)
})

test('an older concurrent directory response is refetched instead of rolling back newer facts', () => {
  const initial = createLoadedActivitiesState()
  const older = load(initial, '2025-01', '2025-01', 1)
  const newer = load(initial, '2025-02', '2025-02', 2)
  const current = payload({ from: '2025-02', empty: true })
  current.groupLeaders = [{
    ...current.groupLeaders[0], status: 'inactive', endsOn: '2025-01-31', version: 2,
    updatedAt: '2025-02-01T10:00:00.000Z',
  }]
  let state = mergeLoadedActivitiesLoad(initial, newer, current).state

  const stale = mergeLoadedActivitiesLoad(
    state, older, payload({ from: '2025-01', empty: true }),
  )

  assert.equal(stale.state, state)
  assert.deepEqual(stale, { state, outcome: 'stale-directory', refetch: true })
  assert.equal(state.groupLeadersById.agl_tus_one.version, 2)
  assert.equal(state.groupLeadersById.agl_tus_one.status, 'inactive')
})

test('a later request with an older entity version is refetched instead of downgrading state', () => {
  const initial = createLoadedActivitiesState()
  const versionTwo = payload({ from: '2025-01', empty: true })
  versionTwo.groupLeaders = [{
    ...versionTwo.groupLeaders[0], status: 'inactive', endsOn: '2025-01-31', version: 2,
    updatedAt: '2025-02-01T10:00:00.000Z',
  }]
  const state = mergeLoadedActivitiesLoad(
    initial, load(initial, '2025-01', '2025-01', 1), versionTwo,
  ).state

  const stale = mergeLoadedActivitiesLoad(
    state, load(state, '2025-02', '2025-02', 2),
    payload({ from: '2025-02', empty: true }),
  )

  assert.deepEqual(stale, { state, outcome: 'stale-directory', refetch: true })
  assert.equal(state.groupLeadersById.agl_tus_one.version, 2)
})

test('equal-version directory equivocation never replaces a trusted fact', () => {
  const cases = [
    ['programs', (value) => ({ ...value, label: 'TUS zmieniony' })],
    ['groups', (value) => ({ ...value, label: 'Grupa zmieniona' })],
    ['groupLeaders', (value) => ({ ...value, startsOn: '2025-01-02' })],
    ['participants', (value) => ({ ...value, name: 'Inna osoba fikcyjna' })],
    ['memberships', (value) => ({ ...value, startsOn: '2025-01-02' })],
  ]

  for (const [key, change] of cases) {
    const initial = payload({ from: '2025-01', empty: true })
    const interval = {
      ...membership('2025-01'), id: 'amb_interval_equivocation',
      membershipKind: 'interval', period: { precision: 'unknown', day: null, month: null },
      startsOn: '2025-01-01', endsOn: null,
    }
    initial.memberships = [interval]
    const empty = createLoadedActivitiesState()
    const state = mergeLoadedActivitiesLoad(empty, load(empty, '2025-01'), initial).state
    const later = payload({ from: '2025-02', empty: true })
    later.memberships = [interval]
    later[key] = later[key].map((value) => change(value))

    assert.throws(
      () => mergeLoadedActivitiesLoad(state, load(state, '2025-02'), later),
      /version equivocation/i,
      key,
    )
  }
})

test('retains an omitted interval required by disjoint historical attendance', () => {
  let state = createLoadedActivitiesState()
  const january = payload({ from: '2025-01', includeClass: true })
  january.memberships = [{
    ...january.memberships[1], id: 'amb_interval_attendance', membershipKind: 'interval',
    period: { precision: 'unknown', day: null, month: null },
    startsOn: '2025-01-01', endsOn: null,
  }]
  january.charges = []
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-01'), january).state
  state = mergeLoadedActivitiesLoad(
    state,
    load(state, '2025-03'),
    payload({ from: '2025-03', kind: 'english' }),
  ).state

  assert.ok(state.attendanceById.aat_2025_01)
  assert.ok(state.membershipsById.amb_interval_attendance)
})

test('retains an omitted interval referenced by a disjoint historical charge', () => {
  let state = createLoadedActivitiesState()
  const january = payload({ from: '2025-01' })
  january.memberships = [{
    ...january.memberships[0], id: 'amb_interval_charge', membershipKind: 'interval',
    period: { precision: 'unknown', day: null, month: null },
    startsOn: '2025-01-01', endsOn: '2025-01-31', status: 'inactive',
  }]
  january.charges[0] = { ...january.charges[0], membershipId: 'amb_interval_charge' }
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-01'), january).state

  state = mergeLoadedActivitiesLoad(
    state, load(state, '2025-03'), payload({ from: '2025-03', kind: 'english' }),
  ).state

  assert.ok(state.chargesById.ach_tus_2025_01)
  assert.ok(state.membershipsById.amb_interval_charge)
})

test('accepts historical attendance backed only by a month observation', () => {
  const state = createLoadedActivitiesState()
  const january = payload({ from: '2025-01', includeClass: true })
  january.memberships = [january.memberships[0]]

  const merged = mergeLoadedActivitiesLoad(state, load(state, '2025-01'), january).state

  assert.ok(merged.attendanceById.aat_2025_01)
  assert.ok(merged.membershipsById.amb_2025_01)
})

test('accepts historical attendance backed by an inactive closed interval', () => {
  const state = createLoadedActivitiesState()
  const january = payload({ from: '2025-01', includeClass: true })
  january.memberships = [{
    ...january.memberships[0], id: 'amb_interval_historical',
    membershipKind: 'interval', period: { precision: 'unknown', day: null, month: null },
    startsOn: '2025-01-01', endsOn: '2025-01-31', status: 'inactive',
  }]
  january.charges = []

  const merged = mergeLoadedActivitiesLoad(state, load(state, '2025-01'), january).state

  assert.ok(merged.attendanceById.aat_2025_01)
  assert.equal(merged.membershipsById.amb_interval_historical.status, 'inactive')
})

test('rejects unresolved, cross-program, duplicate-finance, and out-of-window graphs', () => {
  const state = createLoadedActivitiesState()
  const cases = []
  const missingGroup = payload({ from: '2025-01' })
  missingGroup.groups = []
  cases.push(missingGroup)
  const crossProgram = payload({ from: '2025-01' })
  crossProgram.memberships[0] = {
    ...crossProgram.memberships[0], programId: 'apg_english',
  }
  crossProgram.programs.push(program('english'))
  cases.push(crossProgram)
  const duplicateFinance = payload({ from: '2025-01' })
  duplicateFinance.participants.push(participant('acp_tus_two', 'apg_tus'))
  duplicateFinance.memberships.push({
    ...duplicateFinance.memberships[0], id: 'amb_tus_two', participantId: 'acp_tus_two',
  })
  duplicateFinance.charges.push({
    ...duplicateFinance.charges[0], id: 'ach_tus_two', participantId: 'acp_tus_two',
    membershipId: 'amb_tus_two',
  })
  cases.push(duplicateFinance)
  const outside = payload({ from: '2025-01' })
  outside.charges[0] = {
    ...outside.charges[0], period: { precision: 'month', day: null, month: '2025-02' },
  }
  cases.push(outside)

  for (const value of cases) {
    assert.throws(() => mergeLoadedActivitiesLoad(state, load(state, '2025-01'), value), /activity/i)
  }
})

test('requires scoped latest populated months to cover every retained active charge', () => {
  const state = createLoadedActivitiesState()
  const invalid = payload({ from: '2025-01' })
  invalid.latestPopulatedMonths.tus = null
  assert.throws(
    () => mergeLoadedActivitiesLoad(state, load(state, '2025-01'), invalid),
    /workspace payload/i,
  )

  invalid.charges[0] = { ...invalid.charges[0], status: 'inactive' }
  invalid.memberships[0] = { ...invalid.memberships[0], status: 'inactive' }
  const merged = mergeLoadedActivitiesLoad(state, load(state, '2025-01'), invalid)
  assert.equal(merged.state.latestPopulatedMonths.tus, null)
})

test('requires latest populated months to cover retained active observations without charges', () => {
  let state = createLoadedActivitiesState()
  const march = payload({ from: '2025-03', empty: true })
  march.memberships = [membership('2025-03')]
  march.latestPopulatedMonths.tus = '2025-03'
  state = mergeLoadedActivitiesLoad(state, load(state, '2025-03'), march).state

  const april = payload({ from: '2025-04', empty: true })
  april.latestPopulatedMonths.tus = '2025-02'
  assert.throws(
    () => mergeLoadedActivitiesLoad(state, load(state, '2025-04'), april),
    /latest populated month/i,
  )
})

test('a cached future charge stays valid when Warsaw advances into its month', () => {
  let state
  withFixedDate('2026-08-31T10:00:00.000Z', () => {
    const september = payload({ from: '2026-09' })
    september.currentDay = '2026-08-31'
    september.latestPopulatedMonths.tus = null
    const initial = createLoadedActivitiesState()
    state = mergeLoadedActivitiesLoad(initial, load(initial, '2026-09'), september).state
    assert.equal(state.latestThroughMonth, '2026-08')
  })

  withFixedDate('2026-09-01T10:00:00.000Z', () => {
    assert.equal(isActivityWindowLoaded(state, { from: '2026-09', to: '2026-09' }), true)
    assert.equal(recordLoadedActivitiesWrite(state).latestThroughMonth, '2026-08')
  })
})

test('a cached future observation stays valid when Warsaw advances into its month', () => {
  let state
  withFixedDate('2026-08-31T10:00:00.000Z', () => {
    const september = payload({ from: '2026-09', empty: true })
    september.currentDay = '2026-08-31'
    september.memberships = [membership('2026-09')]
    const initial = createLoadedActivitiesState()
    state = mergeLoadedActivitiesLoad(initial, load(initial, '2026-09'), september).state
    assert.equal(state.latestThroughMonth, '2026-08')
  })

  withFixedDate('2026-09-01T10:00:00.000Z', () => {
    assert.equal(isActivityWindowLoaded(state, { from: '2026-09', to: '2026-09' }), true)
  })
})

test('a month-boundary response is validated against the server-trusted response day', () => {
  let initial
  let captured
  withFixedDate('2026-08-31T21:59:59.000Z', () => {
    initial = createLoadedActivitiesState()
    captured = load(initial, '2026-09')
    assert.equal(Object.hasOwn(captured, 'latestThroughMonth'), false)
  })
  const september = payload({ from: '2026-09', empty: true })
  september.currentDay = '2026-08-31'
  september.memberships = [membership('2026-09')]

  withFixedDate('2026-08-31T22:00:01.000Z', () => {
    const merged = mergeLoadedActivitiesLoad(initial, captured, september).state
    assert.equal(merged.latestThroughMonth, '2026-08')
    assert.ok(merged.membershipsById.amb_2026_09)
  })
})

test('rejects forged future latest metadata and mutable nested entity facts', () => {
  const initial = createLoadedActivitiesState()
  const state = mergeLoadedActivitiesLoad(
    initial, load(initial, '2025-01'), payload({ from: '2025-01' }),
  ).state
  const futureLatest = Object.freeze({
    ...state,
    latestPopulatedMonths: Object.freeze({ tus: '9999-12', english: null }),
  })
  assert.throws(() => captureLoadedActivitiesState(futureLatest), /latest populated month/i)

  const original = state.chargesById.ach_tus_2025_01
  const mutableFinance = { ...original.finance }
  const forgedCharge = Object.freeze({ ...original, finance: mutableFinance })
  const forgedCharges = Object.assign(Object.create(null), state.chargesById, {
    [forgedCharge.id]: forgedCharge,
  })
  Object.freeze(forgedCharges)
  const mutableNested = Object.freeze({ ...state, chargesById: forgedCharges })
  assert.throws(() => captureLoadedActivitiesState(mutableNested), /charges/i)
  mutableFinance.amountGrosze = 1
})

test('contains proxy-backed entity facts and retains only canonical copies', async () => {
  const validProgram = Object.freeze(program('tus'))
  const base = createLoadedActivitiesState()
  const hostileState = new Proxy(base, {
    isExtensible() { throw new Error('hostile state shell') },
  })
  assert.throws(
    () => captureLoadedActivitiesState(hostileState),
    { name: 'TypeError', message: 'Invalid activity loaded state' },
  )
  const hostileLatest = new Proxy(base.latestPopulatedMonths, {
    isExtensible() { throw new Error('hostile latest months') },
  })
  assert.throws(
    () => captureLoadedActivitiesState(Object.freeze({
      ...base, latestPopulatedMonths: hostileLatest,
    })),
    { name: 'TypeError', message: 'Invalid activity latest populated months' },
  )
  const hostileRange = new Proxy(Object.freeze({ from: '2025-01', to: '2025-01' }), {
    isExtensible() { throw new Error('hostile loaded range') },
  })
  assert.throws(
    () => captureLoadedActivitiesState(Object.freeze({
      ...base, loadedMonths: Object.freeze([hostileRange]),
    })),
    { name: 'TypeError', message: 'Invalid activity loaded months' },
  )

  const stateWith = (entity) => {
    const programsById = Object.assign(Object.create(null), { apg_tus: entity })
    Object.freeze(programsById)
    return Object.freeze({ ...createLoadedActivitiesState(), programsById })
  }

  const throwing = new Proxy(validProgram, {
    get() { throw new Error('hostile get') },
  })
  const capturedThrowing = captureLoadedActivitiesState(stateWith(throwing))
  assert.notEqual(capturedThrowing.programsById.apg_tus, throwing)
  assert.deepEqual(capturedThrowing.programsById.apg_tus, validProgram)

  const stale = mergeLoadedActivitiesLoad(stateWith(throwing), {
    from: '2025-01', to: '2025-01', authorityGeneration: 1,
    writeEpoch: 0, loadSequence: 1,
  }, null)
  assert.notEqual(stale.state.programsById.apg_tus, throwing)
  assert.equal(stale.state.programsById.apg_tus.label, 'TUS')

  let synchronousCalls = 0
  let revokeSynchronous
  const synchronous = Proxy.revocable(validProgram, {
    getOwnPropertyDescriptor(target, key) {
      synchronousCalls += 1
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
      if (synchronousCalls === 21) revokeSynchronous()
      return descriptor
    },
  })
  revokeSynchronous = synchronous.revoke
  const capturedSynchronous = captureLoadedActivitiesState(stateWith(synchronous.proxy))
  assert.throws(() => synchronous.proxy.id, TypeError)
  assert.notEqual(capturedSynchronous.programsById.apg_tus, synchronous.proxy)
  assert.deepEqual(capturedSynchronous.programsById.apg_tus, validProgram)

  let asynchronousCalls = 0
  let revokeAsynchronous
  const asynchronous = Proxy.revocable(validProgram, {
    getOwnPropertyDescriptor(target, key) {
      asynchronousCalls += 1
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
      if (asynchronousCalls === 21) queueMicrotask(revokeAsynchronous)
      return descriptor
    },
  })
  revokeAsynchronous = asynchronous.revoke
  const captured = captureLoadedActivitiesState(stateWith(asynchronous.proxy))
  await Promise.resolve()
  assert.notEqual(captured.programsById.apg_tus, asynchronous.proxy)
  assert.deepEqual(captured.programsById.apg_tus, validProgram)
})

test('ignores old authority loads and requests one refetch after a successful write', () => {
  const initial = createLoadedActivitiesState()
  const oldCapture = load(initial, '2025-01')
  const reset = resetLoadedActivitiesAuthority(initial)
  assert.deepEqual(
    mergeLoadedActivitiesLoad(reset, oldCapture, payload({ from: '2025-01' })),
    { state: reset, outcome: 'ignored-authority', refetch: false },
  )

  const capture = load(reset, '2025-01')
  const written = recordLoadedActivitiesWrite(reset)
  assert.deepEqual(
    mergeLoadedActivitiesLoad(written, capture, payload({ from: '2025-01' })),
    { state: written, outcome: 'stale-write', refetch: true },
  )
})

test('activity load request keys change across authority generations for the same month', () => {
  const initial = createLoadedActivitiesState()
  const reset = resetLoadedActivitiesAuthority(initial)
  const window = { from: '2025-01', to: '2025-01' }
  assert.notEqual(
    activityLoadRequestKey(initial, window),
    activityLoadRequestKey(reset, window),
  )
})

test('captures and freezes caller data without retaining mutable references', () => {
  const state = createLoadedActivitiesState()
  const raw = payload({ from: '2025-01', includeClass: true })
  const merged = mergeLoadedActivitiesLoad(state, load(state, '2025-01'), raw).state
  raw.groups[0].label = 'Zmieniona grupa'
  raw.charges[0].finance.amountGrosze = 99
  assert.equal(merged.groupsById.agr_tus_one.label, 'Grupa TUS')
  assert.equal(merged.chargesById.ach_tus_2025_01.finance.amountGrosze, 18_000)
  assert.equal(Object.isFrozen(merged.groupsById.agr_tus_one), true)
  assert.equal(Object.isFrozen(merged.chargesById.ach_tus_2025_01.finance), true)

  assert.throws(() => mergeLoadedActivitiesLoad(state, load(state, '2025-01'), {
    ...payload({ from: '2025-01' }), extra: true,
  }), /activity/i)
})
