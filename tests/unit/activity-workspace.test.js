import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activityActionAvailability,
  activityCurrentMonth,
  activityGroupView,
  activityMonthRange,
  activityMonthState,
  activityProgramOverview,
} from '../../src/activity-workspace.js'

const frozenMap = (values) => Object.freeze(Object.assign(Object.create(null), values))

const state = Object.freeze({
  loadedMonths: Object.freeze([{ from: '2026-07', to: '2026-08' }]),
  programsById: frozenMap({
    apg_english: Object.freeze({ id: 'apg_english', code: 'english', label: 'Angielski' }),
    apg_tus: Object.freeze({ id: 'apg_tus', code: 'tus', label: 'TUS' }),
  }),
  groupsById: frozenMap({
    agr_z: Object.freeze({ id: 'agr_z', programId: 'apg_tus', label: 'Żółwie', details: null, version: 2 }),
    agr_a: Object.freeze({ id: 'agr_a', programId: 'apg_tus', label: 'Ącki', details: 'Opis', version: 1 }),
  }),
  groupLeadersById: frozenMap({
    agl_a: Object.freeze({ id: 'agl_a', groupId: 'agr_a', specialistId: 'sp_julia', status: 'active', version: 1 }),
  }),
  participantsById: frozenMap({
    acp_zero: Object.freeze({ id: 'acp_zero', programId: 'apg_english', name: 'Żaneta Zero', version: 1 }),
    acp_tus: Object.freeze({ id: 'acp_tus', programId: 'apg_tus', name: 'Łukasz TUS', version: 3 }),
  }),
  membershipsById: frozenMap({
    amb_tus: Object.freeze({
      id: 'amb_tus', participantId: 'acp_tus', programId: 'apg_tus', groupId: 'agr_a',
      membershipKind: 'observation', period: Object.freeze({ precision: 'month', day: null, month: '2026-08' }),
      startsOn: null, endsOn: null, status: 'active', version: 4,
    }),
  }),
  classesById: frozenMap({
    acl_real: Object.freeze({
      id: 'acl_real', groupId: 'agr_a', date: '2026-08-18', time: null,
      durationMinutes: null, topic: null, status: 'completed', version: 2,
    }),
  }),
  attendanceById: frozenMap({
    aat_real: Object.freeze({
      id: 'aat_real', classId: 'acl_real', participantId: 'acp_tus', status: 'present', version: 1,
    }),
  }),
  chargesById: frozenMap({
    ach_zero: Object.freeze({
      id: 'ach_zero', participantId: 'acp_zero', programId: 'apg_english', groupId: null,
      membershipId: null, period: Object.freeze({ precision: 'month', day: null, month: '2026-08' }),
      lessonCount: 0, responsibleSpecialistId: 'sp_julia', financeEntryId: 'fin_zero',
      status: 'active', version: 1, finance: Object.freeze({
        amountGrosze: 0, paidAmountGrosze: 0, paymentMethod: 'unknown', settlementStatus: 'unpaid',
      }),
    }),
    ach_tus: Object.freeze({
      id: 'ach_tus', participantId: 'acp_tus', programId: 'apg_tus', groupId: 'agr_a',
      membershipId: 'amb_tus', period: Object.freeze({ precision: 'month', day: null, month: '2026-08' }),
      lessonCount: null, responsibleSpecialistId: 'sp_julia', financeEntryId: 'fin_tus',
      status: 'active', version: 5, finance: Object.freeze({
        amountGrosze: 34_000, paidAmountGrosze: 10_000, paymentMethod: 'transfer', settlementStatus: 'partial',
      }),
    }),
  }),
  paymentsById: frozenMap({}),
  latestPopulatedMonths: Object.freeze({ tus: '2026-08', english: '2026-08' }),
})

test('uses the Warsaw civil month and validates a frozen one-month request', () => {
  assert.equal(activityCurrentMonth(new Date('2026-08-31T22:30:00.000Z')), '2026-09')
  assert.deepEqual(activityMonthRange('2026-08'), { from: '2026-08', to: '2026-08' })
  assert.equal(Object.isFrozen(activityMonthRange('2026-08')), true)
  assert.throws(() => activityMonthRange('2026-13'), /Invalid activity month/)
})

test('reports a month ready only when its complete canonical window is loaded', () => {
  assert.equal(activityMonthState('loading', state.loadedMonths, '2026-08'), 'loading')
  assert.equal(activityMonthState('ready', state.loadedMonths, '2026-08'), 'ready')
  assert.equal(activityMonthState('ready', [], '2026-08'), 'loading')
  assert.equal(activityMonthState('read-only-error', state.loadedMonths, '2026-08'), 'unavailable')
})

test('keeps English zero lesson and money facts as one ungrouped finance row', () => {
  const overview = activityProgramOverview(state, { program: 'english', month: '2026-08' })
  assert.equal(Object.isFrozen(overview), true)
  assert.equal(overview.summary.participantCount, 1)
  assert.equal(overview.summary.lessonCount, 0)
  assert.equal(overview.summary.amountGrosze, 0)
  assert.equal(overview.rows.length, 1)
  assert.equal(overview.rows[0].participant.name, 'Żaneta Zero')
  assert.equal(overview.rows[0].group, null)
  assert.equal(overview.rows[0].groupLabel, 'Bez przypisanej grupy')
  assert.equal(overview.rows[0].lessonCount, 0)
  assert.equal(overview.rows[0].amountGrosze, 0)
  assert.deepEqual(overview.participants.map(({ name }) => name), ['Żaneta Zero'])
  assert.deepEqual(overview.groups, [])
})

test('sorts protected groups by Polish label and never invents classes or attendance', () => {
  const july = activityProgramOverview(state, { program: 'tus', month: '2026-07' })
  assert.deepEqual(july.groups.map(({ group }) => group.id), ['agr_a', 'agr_z'])
  assert.equal(july.summary.classCount, 0)
  assert.equal(july.summary.amountGrosze, 0)

  const august = activityGroupView(state, { groupId: 'agr_a', month: '2026-08' })
  assert.equal(august.memberships[0].period.precision, 'month')
  assert.deepEqual(august.classes.map(({ activityClass }) => activityClass.id), ['acl_real'])
  assert.deepEqual(august.classes[0].attendance.map(({ attendance }) => attendance.id), ['aat_real'])
  assert.equal(august.chargeRows.length, 1)
  assert.equal(august.summary.amountGrosze, 34_000)
  assert.equal(activityGroupView(state, { groupId: 'agr_missing', month: '2026-08' }), null)
})

test('combines the global TUS grant with centre and proved leader eligibility', () => {
  const group = activityProgramOverview(state, { program: 'tus', month: '2026-08' }).groups[0]
  const centre = activityActionAvailability({
    actor: { specialistId: null }, role: { scope: 'centre' },
    capabilities: ['tus.manage'], group,
  })
  assert.equal(centre.createGroup, true)
  assert.equal(centre.createClass, true)

  const ownLeader = activityActionAvailability({
    actor: { specialistId: 'sp_julia' }, role: { scope: 'own' },
    capabilities: ['tus.manage'], group,
  })
  assert.equal(ownLeader.createGroup, false)
  assert.equal(ownLeader.createClass, true)
  assert.equal(ownLeader.editAttendance, true)

  const other = activityActionAvailability({
    actor: { specialistId: 'sp_other' }, role: { scope: 'own' },
    capabilities: ['tus.manage'], group,
  })
  assert.equal(other.createClass, false)
  assert.equal(activityActionAvailability({
    actor: { specialistId: 'sp_julia' }, role: { scope: 'own' }, capabilities: [], group,
  }).createClass, false)
})
