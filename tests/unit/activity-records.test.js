import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureCreateActivityClassCommand,
  captureCreateActivityGroupCommand,
  captureCreateActivityMembershipCommand,
  captureCreateActivityParticipantCommand,
  captureEditActivityClassCommand,
  captureEditActivityGroupCommand,
  captureEditActivityMembershipCommand,
  captureEditActivityParticipantCommand,
  captureActivityCharge,
  captureActivityGroupLeader,
  captureActivityMembership,
  captureActivityMonthWindow,
  captureActivityPeriod,
  captureActivityProjectionJob,
  captureActivityWorkspace,
  captureSetActivityAttendanceCommand,
} from '../../src/activity-records.js'

const NOW = '2027-03-01T08:00:00.000Z'

const charge = (overrides = {}) => ({
  id: 'ach_tus_one', participantId: 'acp_ola', programId: 'apg_tus',
  groupId: 'agr_sowy', membershipId: 'amb_ola_sowy',
  period: { precision: 'month', day: null, month: '2025-01' },
  lessonCount: null, responsibleSpecialistId: 'sp_julia',
  financeEntryId: 'fin_tus_one', status: 'active', version: 1,
  finance: {
    amountGrosze: 34000, paidAmountGrosze: 34000, paymentMethod: 'transfer',
    settlementStatus: 'paid',
  },
  createdAt: NOW, updatedAt: NOW, ...overrides,
})

test('activity periods preserve exact day/month precision and reject invented shapes', () => {
  assert.deepEqual(captureActivityPeriod({
    precision: 'day', day: '2025-01-31', month: '2025-01',
  }), { precision: 'day', day: '2025-01-31', month: '2025-01' })
  assert.deepEqual(captureActivityPeriod({
    precision: 'month', day: null, month: '2025-02',
  }), { precision: 'month', day: null, month: '2025-02' })
  assert.deepEqual(captureActivityPeriod({
    precision: 'unknown', day: null, month: null,
  }), { precision: 'unknown', day: null, month: null })
  assert.throws(() => captureActivityPeriod({
    precision: 'month', day: '2025-02-01', month: '2025-02',
  }), /Invalid activity period/)
  assert.throws(() => captureActivityPeriod({
    precision: 'day', day: '2025-02-29', month: '2025-02',
  }), /Invalid activity period/)
  assert.equal(captureActivityPeriod({
    precision: 'day', day: '0001-02-28', month: '0001-02',
  }).day, '0001-02-28')
  assert.equal(captureActivityPeriod({
    precision: 'day', day: '0004-02-29', month: '0004-02',
  }).day, '0004-02-29')
  assert.throws(() => captureActivityPeriod({
    precision: 'day', day: '0000-01-01', month: '0000-01',
  }), /Invalid activity period/)
})

test('activity month windows are inclusive, canonical, exact, and bounded to twelve months', () => {
  assert.deepEqual(captureActivityMonthWindow({ from: '2025-01', to: '2025-12' }), {
    from: '2025-01', to: '2025-12',
  })
  assert.throws(() => captureActivityMonthWindow({ from: '2025-01', to: '2026-01' }),
    /Invalid activity month window/)
  assert.throws(() => captureActivityMonthWindow({ from: '2025-02', to: '2025-01' }),
    /Invalid activity month window/)
  assert.throws(() => captureActivityMonthWindow({
    from: '2025-01', to: '2025-02', timezone: 'Europe\/Warsaw',
  }), /Invalid activity month window/)
})

test('charges keep finance as a joined projection and never accept duplicated money fields', () => {
  const captured = captureActivityCharge(charge())
  assert.equal(captured.finance.amountGrosze, 34000)
  assert.equal(Object.hasOwn(captured, 'amountGrosze'), false)
  assert.equal(Object.hasOwn(captured, 'paidAmountGrosze'), false)
  assert.equal(Object.isFrozen(captured), true)
  assert.equal(Object.isFrozen(captured.finance), true)
  assert.throws(() => captureActivityCharge({ ...charge(), amountGrosze: 34000 }),
    /Invalid activity charge/)
})

test('charge finance projections enforce canonical settlement amount semantics', () => {
  for (const finance of [
    { amountGrosze: 34000, paidAmountGrosze: 33999, settlementStatus: 'paid' },
    { amountGrosze: 34000, paidAmountGrosze: 1, settlementStatus: 'unpaid' },
    { amountGrosze: 34000, paidAmountGrosze: 1, settlementStatus: 'unknown' },
    { amountGrosze: 34000, paidAmountGrosze: 0, settlementStatus: 'partial' },
    { amountGrosze: 34000, paidAmountGrosze: 34000, settlementStatus: 'partial' },
  ]) assert.throws(() => captureActivityCharge(charge({
    finance: { paymentMethod: 'transfer', ...finance },
  })), /Invalid activity charge/)

  for (const finance of [
    { amountGrosze: 34000, paidAmountGrosze: 34000, settlementStatus: 'paid' },
    { amountGrosze: 34000, paidAmountGrosze: 0, settlementStatus: 'unpaid' },
    { amountGrosze: 34000, paidAmountGrosze: 0, settlementStatus: 'unknown' },
    { amountGrosze: 34000, paidAmountGrosze: 1, settlementStatus: 'partial' },
  ]) assert.deepEqual(captureActivityCharge(charge({
    finance: { paymentMethod: 'transfer', ...finance },
  })).finance, { paymentMethod: 'transfer', ...finance })
})

test('charge finance semantics reject numeric objects without coercing them', () => {
  let reads = 0
  const hostileAmount = {
    valueOf() { reads += 1; return 1 },
  }
  assert.throws(() => captureActivityCharge(charge({
    finance: {
      amountGrosze: 34000, paidAmountGrosze: hostileAmount,
      paymentMethod: 'transfer', settlementStatus: 'partial',
    },
  })), /Invalid activity charge/)
  assert.equal(reads, 0)
})

test('TUS finance must be positive while English preserves an exact zero month', () => {
  const zeroFinance = {
    amountGrosze: 0, paidAmountGrosze: 0, paymentMethod: 'unknown',
    settlementStatus: 'unknown',
  }
  assert.throws(() => captureActivityCharge(charge({ finance: zeroFinance })),
    /Invalid activity charge/)
  assert.equal(captureActivityCharge(charge({
    id: 'ach_english_zero_finance', participantId: 'acp_english_ola',
    programId: 'apg_english', groupId: null, membershipId: null,
    lessonCount: 0, financeEntryId: 'fin_english_zero_finance', finance: zeroFinance,
  })).finance.amountGrosze, 0)
})

test('English preserves an explicit zero lesson count and TUS rejects all lesson counts', () => {
  const english = captureActivityCharge(charge({
    id: 'ach_english_zero', participantId: 'acp_english_ola',
    programId: 'apg_english', groupId: null, membershipId: null,
    lessonCount: 0, financeEntryId: 'fin_english_zero',
  }))
  assert.equal(english.lessonCount, 0)
  assert.throws(() => captureActivityCharge(charge({ lessonCount: 4 })),
    /Invalid activity charge/)
  assert.throws(() => captureActivityCharge(charge({
    id: 'ach_english_missing', participantId: 'acp_english_ola',
    programId: 'apg_english', groupId: null, membershipId: null,
    lessonCount: null, financeEntryId: 'fin_english_missing',
  })), /Invalid activity charge/)
})

test('membership observations cannot acquire invented native interval dates', () => {
  const observation = {
    id: 'amb_ola_sowy', participantId: 'acp_ola', programId: 'apg_tus',
    groupId: 'agr_sowy', membershipKind: 'observation',
    period: { precision: 'month', day: null, month: '2025-01' },
    startsOn: null, endsOn: null, status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  assert.equal(captureActivityMembership(observation).startsOn, null)
  assert.throws(() => captureActivityMembership({
    ...observation, startsOn: '2025-01-01',
  }), /Invalid activity membership/)
  assert.deepEqual(captureActivityMembership({
    ...observation, id: 'amb_native_one', membershipKind: 'interval',
    period: { precision: 'unknown', day: null, month: null },
    startsOn: '2025-01-01', endsOn: '2025-06-30',
  }).period, { precision: 'unknown', day: null, month: null })
})

test('workspace capture requires explicit arrays and does not invent classes or attendance', () => {
  const workspace = captureActivityWorkspace({
    from: '2025-01', to: '2025-01', complete: true,
    currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: '2025-01', english: null },
    programs: [], groups: [], groupLeaders: [], participants: [], memberships: [], classes: [],
    attendance: [], charges: [], payments: [],
  })
  assert.equal(workspace.classes.length, 0)
  assert.equal(workspace.attendance.length, 0)
  assert.equal(Object.isFrozen(workspace), true)
  assert.equal(Object.isFrozen(workspace.charges), true)
  assert.throws(() => captureActivityWorkspace({
    from: '2025-01', to: '2025-01', complete: true,
    currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: '2025-01', english: null },
    programs: [], groups: [], groupLeaders: [], participants: [], memberships: [],
    charges: [], payments: [],
  }), /Invalid activity workspace/)
  assert.throws(() => captureActivityWorkspace({
    from: '2025-01', to: '2025-01', complete: true,
    currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: '2025-01', english: null },
    programs: [], groups: [], groupLeaders: [], participants: [], memberships: [], classes: [],
    attendance: [], charges: [], payments: [], inferredSchedule: [],
  }), /Invalid activity workspace/)
  assert.throws(() => captureActivityWorkspace({
    from: '2025-01', to: '2025-01', complete: true,
    currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: '2025-13', english: null },
    programs: [], groups: [], groupLeaders: [], participants: [], memberships: [], classes: [],
    attendance: [], charges: [], payments: [],
  }), /Invalid activity latest populated months/)
  assert.throws(() => captureActivityWorkspace({
    from: '2025-01', to: '2025-01', complete: true,
    currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: null, english: null },
    programs: [], groups: [], groupLeaders: [], participants: [], memberships: [],
    classes: [], attendance: [], charges: [], payments: [{ id: 'apy_invented' }],
  }), /Invalid activity workspace/)
})

test('workspace latest populated months cannot advance beyond its embedded current day', () => {
  assert.throws(() => captureActivityWorkspace({
    from: '2026-09', to: '2026-09', complete: true,
    currentDay: '2026-08-31',
    latestPopulatedMonths: { tus: '2026-09', english: null },
    programs: [], groups: [], groupLeaders: [], participants: [], memberships: [],
    classes: [], attendance: [], charges: [], payments: [],
  }), /Invalid activity workspace/)
})

test('workspace capture enforces ordered cross-references and visible latest-month bounds', () => {
  const program = {
    id: 'apg_tus', code: 'tus', label: 'TUS', status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  const group = {
    id: 'agr_sowy', programId: 'apg_tus', label: 'Sowy', details: null,
    status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
  }
  const participant = {
    id: 'acp_ola', programId: 'apg_tus', name: 'Ola', clientId: null,
    historicalClientId: null, status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  const membership = {
    id: 'amb_ola_sowy', participantId: 'acp_ola', programId: 'apg_tus',
    groupId: 'agr_sowy', membershipKind: 'observation',
    period: { precision: 'month', day: null, month: '2025-01' },
    startsOn: null, endsOn: null, status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  const leader = {
    id: 'agl_sowy_julia', groupId: 'agr_sowy', specialistId: 'sp_julia',
    startsOn: '2025-01-01', endsOn: null, status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  const base = {
    from: '2025-01', to: '2025-01', complete: true,
    currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: '2025-01', english: null },
    programs: [program], groups: [group], groupLeaders: [leader],
    participants: [participant], memberships: [membership], classes: [],
    attendance: [], charges: [charge()], payments: [],
  }
  assert.equal(captureActivityWorkspace(base).charges.length, 1)
  for (const hostile of [
    { ...base, groups: [{ ...group, programId: 'apg_english' }] },
    { ...base, groupLeaders: [{ ...leader, groupId: 'agr_missing' }] },
    { ...base, memberships: [{ ...membership, participantId: 'acp_missing' }] },
    { ...base, charges: [charge({ groupId: 'agr_missing' })] },
    { ...base, latestPopulatedMonths: { tus: null, english: null } },
    { ...base, participants: [{ ...participant, id: 'acp_z' }, participant] },
  ]) assert.throws(() => captureActivityWorkspace(hostile), /Invalid activity workspace/)

  const futureClass = {
    id: 'acl_sowy_future', groupId: group.id, date: '2027-01-15', time: '16:00',
    durationMinutes: 60, topic: null, status: 'scheduled', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  const futureClasses = captureActivityWorkspace({
    ...base,
    from: '2027-01',
    to: '2027-01',
    latestPopulatedMonths: { tus: '2026-08', english: null },
    memberships: [],
    classes: [futureClass],
    charges: [],
  }, { currentMonth: '2026-08' })
  assert.equal(futureClasses.classes[0].id, futureClass.id)
  assert.equal(futureClasses.latestPopulatedMonths.tus, '2026-08')

  const futureObservation = {
    ...membership,
    id: 'amb_ola_sowy_future',
    period: { precision: 'month', day: null, month: '2027-01' },
  }
  const futureCharge = charge({
    id: 'ach_tus_future',
    membershipId: futureObservation.id,
    period: { precision: 'month', day: null, month: '2027-01' },
    financeEntryId: 'fin_tus_future',
  })
  const futureCharges = captureActivityWorkspace({
    ...base,
    from: '2027-01',
    to: '2027-01',
    latestPopulatedMonths: { tus: '2026-08', english: null },
    memberships: [futureObservation],
    classes: [],
    charges: [futureCharge],
  }, { currentMonth: '2026-08' })
  assert.equal(futureCharges.charges[0].id, futureCharge.id)
  assert.equal(futureCharges.latestPopulatedMonths.tus, '2026-08')
})

test('workspace capture rejects durable natural-key collisions and active interval overlaps', () => {
  const program = {
    id: 'apg_tus', code: 'tus', label: 'TUS', status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  const group = (id) => ({
    id, programId: 'apg_tus', label: id === 'agr_lisy' ? 'Lisy' : 'Sowy', details: null,
    status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
  })
  const participant = {
    id: 'acp_ola', programId: 'apg_tus', name: 'Ola', clientId: null,
    historicalClientId: null, status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  const observation = (id, precision = 'month') => ({
    id, participantId: 'acp_ola', programId: 'apg_tus', groupId: 'agr_sowy',
    membershipKind: 'observation', period: precision === 'day'
      ? { precision: 'day', day: '2025-01-15', month: '2025-01' }
      : { precision: 'month', day: null, month: '2025-01' },
    startsOn: null, endsOn: null, status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  })
  const interval = (id, groupId, startsOn, endsOn, status = 'active') => ({
    id, participantId: 'acp_ola', programId: 'apg_tus', groupId,
    membershipKind: 'interval', period: { precision: 'unknown', day: null, month: null },
    startsOn, endsOn, status, version: 1, createdAt: NOW, updatedAt: NOW,
  })
  const leader = (id, startsOn, endsOn, status = 'active') => ({
    id, groupId: 'agr_sowy', specialistId: 'sp_julia', startsOn, endsOn,
    status, version: 1, createdAt: NOW, updatedAt: NOW,
  })
  const activityClass = {
    id: 'acl_sowy', groupId: 'agr_sowy', date: '2025-01-15', time: null,
    durationMinutes: null, topic: null, status: 'completed', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  const attendance = (id) => ({
    id, classId: 'acl_sowy', participantId: 'acp_ola', status: 'present',
    version: 1, createdAt: NOW, updatedAt: NOW,
  })
  const base = {
    from: '2025-01', to: '2025-01', complete: true,
    currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: '2025-01', english: null },
    programs: [program], groups: [group('agr_lisy'), group('agr_sowy')],
    groupLeaders: [], participants: [participant], memberships: [observation('amb_month_a')],
    classes: [activityClass], attendance: [attendance('aat_a')], charges: [], payments: [],
  }
  const cases = [
    {
      ...base,
      memberships: [observation('amb_month_a'), observation('amb_month_b')],
    },
    {
      ...base,
      memberships: [observation('amb_day_a', 'day'), observation('amb_day_b', 'day')],
    },
    {
      ...base,
      memberships: [
        interval('amb_interval_a', 'agr_lisy', '2025-01-01', '2025-03-01'),
        interval('amb_interval_b', 'agr_sowy', '2025-03-01', '2025-04-01'),
      ],
    },
    {
      ...base,
      groupLeaders: [
        leader('agl_interval_a', '2025-01-01', '2025-03-01'),
        leader('agl_interval_b', '2025-02-01', '2025-04-01'),
      ],
    },
    {
      ...base,
      attendance: [attendance('aat_a'), attendance('aat_b')],
    },
  ]

  for (const value of cases) {
    assert.throws(() => captureActivityWorkspace(value), /Invalid activity workspace/)
  }
})

test('workspace capture keeps inactive interval history authoritative for overlap guards', () => {
  const program = {
    id: 'apg_tus', code: 'tus', label: 'TUS', status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  const group = {
    id: 'agr_sowy', programId: 'apg_tus', label: 'Sowy', details: null,
    status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
  }
  const participant = {
    id: 'acp_ola', programId: 'apg_tus', name: 'Ola', clientId: null,
    historicalClientId: null, status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }
  const interval = (id, status) => ({
    id, participantId: 'acp_ola', programId: 'apg_tus', groupId: 'agr_sowy',
    membershipKind: 'interval', period: { precision: 'unknown', day: null, month: null },
    startsOn: '2025-01-01', endsOn: '2025-03-01', status,
    version: 1, createdAt: NOW, updatedAt: NOW,
  })
  const leader = (id, status) => ({
    id, groupId: 'agr_sowy', specialistId: 'sp_julia', startsOn: '2025-01-01',
    endsOn: '2025-03-01', status, version: 1, createdAt: NOW, updatedAt: NOW,
  })

  const value = {
    from: '2025-01', to: '2025-01', complete: true,
    currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: null, english: null }, programs: [program], groups: [group],
    groupLeaders: [leader('agl_active', 'active'), leader('agl_inactive', 'inactive')],
    participants: [participant],
    memberships: [interval('amb_active', 'active'), interval('amb_inactive', 'inactive')],
    classes: [], attendance: [], charges: [], payments: [],
  }

  assert.throws(() => captureActivityWorkspace(value), /Invalid activity workspace/)
  assert.equal(captureActivityWorkspace({
    ...value,
    memberships: [interval('amb_inactive', 'inactive')],
  }).groupLeaders.length, 2)
})

test('untrusted activity arrays must be dense plain data arrays', () => {
  const base = {
    from: '2025-01', to: '2025-01', complete: true,
    currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: null, english: null }, programs: [], groups: [],
    groupLeaders: [], participants: [], memberships: [], classes: [], attendance: [],
    charges: [], payments: [],
  }
  const sparse = new Array(1)
  const accessor = []
  Object.defineProperty(accessor, '0', { enumerable: true, get: () => ({}) })
  accessor.length = 1
  class ActivityArray extends Array {}
  const subclass = new ActivityArray()
  const symbol = []
  symbol[Symbol('private')] = true
  for (const programs of [sparse, accessor, subclass, symbol]) {
    assert.throws(() => captureActivityWorkspace({ ...base, programs }),
      /Invalid activity workspace/)
  }
  const leaders = ['sp_julia']
  Object.defineProperty(leaders, '0', { enumerable: true, get: () => 'sp_julia' })
  assert.throws(() => captureCreateActivityGroupCommand({
    programId: 'apg_tus', label: 'Sowy', details: null,
    leaderSpecialistIds: leaders,
  }), /Invalid activity/)
})

test('group leaders are exact, versioned specialist facts', () => {
  assert.deepEqual(captureActivityGroupLeader({
    id: 'agl_sowy_julia', groupId: 'agr_sowy', specialistId: 'sp_julia',
    startsOn: '2025-01-01', endsOn: null, status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }), {
    id: 'agl_sowy_julia', groupId: 'agr_sowy', specialistId: 'sp_julia',
    startsOn: '2025-01-01', endsOn: null, status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  })
  assert.throws(() => captureActivityGroupLeader({
    id: 'agl_sowy_julia', groupId: 'agr_sowy', specialistId: 'sp_julia',
    startsOn: '2025-02-01', endsOn: '2025-01-31', status: 'active', version: 1,
    createdAt: NOW, updatedAt: NOW,
  }), /Invalid activity group leader/)
})

test('native activity commands are exact, versioned and preserve nullable facts', () => {
  assert.deepEqual(captureCreateActivityGroupCommand({
    programId: 'apg_tus', label: 'Sowy', details: null,
    leaderSpecialistIds: ['sp_julia', 'sp_anna'],
  }), {
    programId: 'apg_tus', label: 'Sowy', details: null,
    leaderSpecialistIds: ['sp_anna', 'sp_julia'],
  })
  assert.deepEqual(captureEditActivityGroupCommand({
    expectedVersion: 2, label: 'Sowy', details: 'Grupa popołudniowa',
    status: 'active', leaderSpecialistIds: [],
  }).leaderSpecialistIds, [])
  assert.deepEqual(captureCreateActivityParticipantCommand({
    programId: 'apg_english', name: 'Ola', clientId: null,
    historicalClientId: 'hcl_ola',
  }).historicalClientId, 'hcl_ola')
  assert.equal(captureEditActivityParticipantCommand({
    expectedVersion: 1, name: 'Ola', clientId: null,
    historicalClientId: null, status: 'inactive',
  }).status, 'inactive')
  assert.deepEqual(captureCreateActivityMembershipCommand({
    participantId: 'acp_ola', groupId: 'agr_sowy', startsOn: '2025-01-01',
    endsOn: null,
  }).endsOn, null)
  assert.equal(captureEditActivityMembershipCommand({
    expectedVersion: 3, startsOn: '2025-01-01', endsOn: '2025-06-30',
    status: 'inactive',
  }).expectedVersion, 3)
  assert.equal(captureCreateActivityClassCommand({
    groupId: 'agr_sowy', date: '2025-03-04', time: null,
    durationMinutes: null, topic: null, status: 'scheduled',
  }).time, null)
  assert.equal(captureEditActivityClassCommand({
    expectedVersion: 1, date: '2025-03-04', time: '16:30',
    durationMinutes: 90, topic: 'Współpraca', status: 'completed',
  }).durationMinutes, 90)
  assert.equal(captureSetActivityAttendanceCommand({
    participantId: 'acp_ola', status: 'present', expectedVersion: 0,
  }).expectedVersion, 0)

  for (const hostile of [
    () => captureCreateActivityGroupCommand({
      programId: 'apg_tus', label: 'Sowy', details: null,
      leaderSpecialistIds: ['sp_julia', 'sp_julia'],
    }),
    () => captureCreateActivityGroupCommand({
      programId: 'apg_tus', label: 'Sowy', details: null,
      leaderSpecialistIds: Array.from({ length: 21 }, (_, index) => `sp_${index + 1}`),
    }),
    () => captureEditActivityParticipantCommand({
      expectedVersion: 0, name: 'Ola', clientId: null,
      historicalClientId: null, status: 'active',
    }),
    () => captureCreateActivityMembershipCommand({
      participantId: 'acp_ola', groupId: 'agr_sowy', startsOn: '2025-02-01',
      endsOn: '2025-01-31',
    }),
    () => captureCreateActivityClassCommand({
      groupId: 'agr_sowy', date: '2025-02-29', time: null,
      durationMinutes: null, topic: null, status: 'scheduled',
    }),
    () => captureSetActivityAttendanceCommand({
      participantId: 'acp_ola', status: 'present', expectedVersion: -1,
    }),
  ]) assert.throws(hostile, /Invalid activity/)
})

test('activity display text rejects whitespace that crypto would silently canonicalize', () => {
  for (const label of ['A  B', 'A\u00a0B', 'A\u2009B']) {
    assert.throws(() => captureCreateActivityGroupCommand({
      programId: 'apg_tus', label, details: null, leaderSpecialistIds: [],
    }), /Invalid activity group command/)
    assert.throws(() => captureCreateActivityParticipantCommand({
      programId: 'apg_english', name: label, clientId: null, historicalClientId: null,
    }), /Invalid activity participant command/)
  }
})

test('projection jobs expose exact durable progress and completed-state versions', () => {
  const running = captureActivityProjectionJob({
    id: 'apj_import_one', importId: 'wbi_import_one', status: 'running',
    afterSourceRecordId: 'wbs_source_one', totalRecords: 190,
    processedRecords: 1, projectedRecords: 1, version: 2,
    updatedAt: NOW, completedAt: null,
  })
  assert.equal(Object.isFrozen(running), true)
  assert.deepEqual(captureActivityProjectionJob({
    ...running, status: 'complete', processedRecords: 190,
    projectedRecords: 190, version: 191, completedAt: NOW,
  }), {
    ...running, status: 'complete', processedRecords: 190,
    projectedRecords: 190, version: 191, completedAt: NOW,
  })
  for (const hostile of [
    { ...running, processedRecords: 191 },
    { ...running, projectedRecords: 2 },
    { ...running, projectedRecords: 0 },
    { ...running, processedRecords: 0, projectedRecords: 0 },
    { ...running, processedRecords: 190, projectedRecords: 190 },
    { ...running, status: 'complete', completedAt: NOW },
    { ...running, resolverStaffId: 'stf_resolver' },
  ]) assert.throws(
    () => captureActivityProjectionJob(hostile), /Invalid activity projection job/,
  )
})
