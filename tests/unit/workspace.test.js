import assert from 'node:assert/strict'
import test from 'node:test'
import * as workspace from '../../src/workspace.js'
import { PSYCHOLOGISTS } from '../../src/data.js'
import { billableSummary, fmtMoney, paymentPatchFor } from '../../src/format.js'

const {
  roleById, sessionsForRole, clientsForRole, dayAttention, todayWorkspace, sessionMatchesFilters,
  dissolveLoneFamilies, normalizeSearchText, clientMatchesQuery, dayStatusSummary, sessionConflicts, sessionConflictGroups,
  paymentEntryFor, paymentSnapshotOf, scopedBillingSummary, specialistWeekLoad, withPsychologistDefaults,
  sessionHasStarted, isBeforeAssignmentStart, assignmentStartLabel,
  latestSessionForClient, occupiedSessionsForSpecialistDay, occupiedTimeLabels, suggestedSessionTime,
  sessionSpecialistId, sessionClientOptions, filterSessionClientOptions, isBookableClient, bookableClientsForRole,
} = workspace

const state = {
  sessions: [
    { id: 's-owner', psychId: 'p1', date: '2026-07-10', time: '09:00', status: 'scheduled', amount: 220, payment: 'unpaid', paidAmount: 0 },
    { id: 's-therapist', psychId: 'p2', date: '2026-07-10', time: '10:00', status: 'completed', amount: 260, payment: 'partial', paidAmount: 130 },
  ],
  clients: [],
  psychologists: [],
}

test('calendar session ordering compares time then stable id with explicit code-unit order', () => {
  assert.equal(typeof workspace.compareCalendarSessionOrder, 'function')
  const compare = workspace.compareCalendarSessionOrder
  const items = [
    { id: 's_2', time: '09:00' },
    { id: 's_10', time: '09:00' },
    { id: 's_early', time: '08:59' },
  ]
  assert.deepEqual(items.toSorted(compare).map(({ id }) => id), ['s_early', 's_10', 's_2'])
  assert.equal(compare(items[0], items[0]), 0)
  assert.equal(compare({ id: '\u00e4', time: '09:00' }, { id: 'z', time: '09:00' }), 1)
})

test('therapist scope contains only their own sessions', () => {
  assert.deepEqual(sessionsForRole(state, roleById('therapist')).map((s) => s.id), ['s-therapist'])
})

test('therapist scope contains only their own clients', () => {
  const scopedState = {
    ...state,
    clients: [
      { id: 'c-owner', psychId: 'p1' },
      { id: 'c-therapist', psychId: 'p2' },
    ],
  }
  assert.deepEqual(clientsForRole(scopedState, roleById('therapist')).map((client) => client.id), ['c-therapist'])
})

test('centre roles retain all client records', () => {
  const scopedState = {
    ...state,
    clients: [
      { id: 'c-owner', psychId: 'p1' },
      { id: 'c-therapist', psychId: 'p2' },
    ],
  }
  assert.deepEqual(clientsForRole(scopedState, roleById('coordinator')).map((client) => client.id), ['c-owner', 'c-therapist'])
})

test('day attention exposes a partial payment with an explicit amount', () => {
  assert.deepEqual(dayAttention(state, roleById('owner'), '2026-07-10')[0], {
    kind: 'payment', sessionId: 's-therapist', amount: 130,
  })
})

test('day attention ignores a scheduled partial payment', () => {
  assert.deepEqual(dayAttention({
    ...state,
    sessions: [{ ...state.sessions[1], status: 'scheduled' }],
  }, roleById('owner'), '2026-07-10'), [])
})

test('today workspace selects the next scheduled session for the active role', () => {
  const workspace = todayWorkspace({
    ...state,
    sessions: [{ ...state.sessions[1], status: 'scheduled' }],
  }, roleById('therapist'), new Date('2026-07-10T09:30:00'))
  assert.equal(workspace.next.id, 's-therapist')
  assert.deepEqual(workspace.daySummary, {
    total: 1,
    completed: 0,
    noshow: 0,
    scheduled: 1,
    unresolvedPast: 0,
    current: 0,
    future: 1,
  })
})

test('today workspace limits outstanding money to its explicit range', () => {
  const workspace = todayWorkspace({
    ...state,
    sessions: [
      { id: 's-before', psychId: 'p1', date: '2026-04-13', time: '09:00', status: 'completed', amount: 110, payment: 'unpaid', paidAmount: 0 },
      { id: 's-in-range', psychId: 'p1', date: '2026-04-14', time: '09:00', status: 'completed', amount: 180, payment: 'unpaid', paidAmount: 0 },
      { id: 's-today', psychId: 'p2', date: '2026-07-15', time: '10:00', status: 'noshow', amount: 260, payment: 'partial', paidAmount: 60 },
      { id: 's-after', psychId: 'p2', date: '2026-07-16', time: '10:00', status: 'completed', amount: 300, payment: 'unpaid', paidAmount: 0 },
    ],
  }, roleById('owner'), new Date('2026-07-15T12:00:00'), {
    from: '2026-04-14', to: '2026-07-15',
  })

  assert.equal(workspace.outstanding, 380)
})

test('search normalization folds Polish diacritics and removes separators', () => {
  assert.equal(normalizeSearchText('  ŻÓŁĆ, +48 (500) 100-200  '), 'zolc48500100200')
})

test('client search matches a normalized name', () => {
  const client = { name: 'Łucja Żak', email: 'lucja.zak@example.pl', phone: '+48 501 234 567' }
  assert.equal(clientMatchesQuery(client, '  LUCJA ZAK '), true)
})

test('client search matches a normalized email', () => {
  const client = { name: 'Łucja Żak', email: 'lucja.zak@example.pl', phone: '+48 501 234 567' }
  assert.equal(clientMatchesQuery(client, 'LUCJA.ZAK@EXAMPLE.PL'), true)
})

test('client search compares formatted and unformatted phone numbers', () => {
  const client = { name: 'Łucja Żak', email: 'lucja.zak@example.pl', phone: '+48 501 234 567' }
  assert.equal(clientMatchesQuery(client, '48501234567'), true)
  assert.equal(clientMatchesQuery(client, '501-234-567'), true)
  assert.equal(clientMatchesQuery(client, '502234567'), false)
})

test('an empty normalized client query matches every client', () => {
  assert.equal(clientMatchesQuery({ name: 'Dowolna osoba' }, '  ---  '), true)
})

test('session client options use Polish name order and search only matching scoped clients', () => {
  const clients = [
    { id: 'c-3', name: 'Żaneta Lis' },
    { id: 'c-2', name: 'Alicja Nowak' },
    { id: 'c-1', name: 'Adam Nowak' },
  ]
  const options = sessionClientOptions(clients)

  assert.deepEqual(options.map((client) => client.id), ['c-1', 'c-2', 'c-3'])
  assert.deepEqual(filterSessionClientOptions(options, 'nowak').map((client) => client.id), ['c-1', 'c-2'])
  assert.deepEqual(filterSessionClientOptions(options, 'żaneta').map((client) => client.id), ['c-3'])
  assert.deepEqual(clients.map((client) => client.id), ['c-3', 'c-2', 'c-1'])
})

test('only active or paused writable clients are bookable for a session', () => {
  const clients = [
    { id: 'c-active', status: 'active', archivedAt: null, readOnly: false },
    { id: 'c-paused', status: 'paused', archivedAt: null, readOnly: false },
    { id: 'c-archived', status: 'archived', archivedAt: '2026-07-20T08:00:00.000Z', readOnly: true },
    { id: 'c-read-only', status: 'active', archivedAt: null, readOnly: true },
    { id: 'c-history', status: 'historical', archivedAt: null, readOnly: false },
  ]

  assert.deepEqual(clients.filter(isBookableClient).map((client) => client.id), ['c-active', 'c-paused'])
  assert.deepEqual(bookableClientsForRole({ clients }, roleById('owner')).map((client) => client.id), ['c-active', 'c-paused'])
})

test('day status summary gives current interval boundaries precedence', () => {
  const sessions = [
    { id: 's-ended', date: '2026-07-10', time: '09:10', duration: 50, status: 'scheduled' },
    { id: 's-starting', date: '2026-07-10', time: '10:00', duration: 50, status: 'scheduled' },
    { id: 's-future', date: '2026-07-10', time: '10:01', duration: 50, status: 'scheduled' },
  ]

  assert.deepEqual(dayStatusSummary(sessions, '2026-07-10', 10 * 60), {
    total: 3,
    completed: 0,
    noshow: 0,
    scheduled: 3,
    unresolvedPast: 1,
    current: 1,
    future: 1,
  })
})

test('day status summary excludes cancelled and other-day sessions', () => {
  const sessions = [
    { id: 's-completed', date: '2026-07-10', time: '09:00', status: 'completed' },
    { id: 's-noshow', date: '2026-07-10', time: '10:00', status: 'noshow' },
    { id: 's-cancelled', date: '2026-07-10', time: '11:00', status: 'cancelled' },
    { id: 's-other-day', date: '2026-07-11', time: '12:00', status: 'scheduled' },
  ]

  assert.deepEqual(dayStatusSummary(sessions, '2026-07-10', 12 * 60), {
    total: 2,
    completed: 1,
    noshow: 1,
    scheduled: 0,
    unresolvedPast: 0,
    current: 0,
    future: 0,
  })
})

test('session conflicts report overlaps in stable date, time, and ID order', () => {
  const sessions = [
    { id: 's-z', psychId: 'p2', date: '2026-07-11', time: '09:00', duration: 60, status: 'scheduled' },
    { id: 's-a', psychId: 'p2', date: '2026-07-11', time: '09:30', duration: 30, status: 'completed' },
    { id: 's-d', psychId: 'p1', date: '2026-07-10', time: '14:20', duration: 30, status: 'scheduled' },
    { id: 's-c', psychId: 'p1', date: '2026-07-10', time: '14:00', duration: 50, status: 'noshow' },
    { id: 's-other-psych', psychId: 'p3', date: '2026-07-10', time: '14:10', duration: 50, status: 'scheduled' },
  ]

  assert.deepEqual(sessionConflicts(sessions), [
    { date: '2026-07-10', psychId: 'p1', sessionIds: ['s-c', 's-d'] },
    { date: '2026-07-11', psychId: 'p2', sessionIds: ['s-a', 's-z'] },
  ])
  assert.deepEqual(sessionConflicts(sessions, { date: '2026-07-11' }), [
    { date: '2026-07-11', psychId: 'p2', sessionIds: ['s-a', 's-z'] },
  ])
})

test('session conflict groups merge every overlapping pair into one block', () => {
  const sessions = [
    { id: 's-1', psychId: 'p1', date: '2026-07-10', time: '14:00', duration: 50, status: 'scheduled' },
    { id: 's-2', psychId: 'p1', date: '2026-07-10', time: '14:00', duration: 50, status: 'scheduled' },
    { id: 's-3', psychId: 'p1', date: '2026-07-10', time: '14:00', duration: 50, status: 'scheduled' },
    { id: 's-4', psychId: 'p1', date: '2026-07-10', time: '16:00', duration: 50, status: 'scheduled' },
    { id: 's-5', psychId: 'p1', date: '2026-07-10', time: '16:30', duration: 50, status: 'scheduled' },
    { id: 's-6', psychId: 'p2', date: '2026-07-10', time: '14:00', duration: 50, status: 'scheduled' },
  ]

  assert.equal(sessionConflicts(sessions).length, 4)
  assert.deepEqual(sessionConflictGroups(sessions), [
    { date: '2026-07-10', psychId: 'p1', sessionIds: ['s-1', 's-2', 's-3'] },
    { date: '2026-07-10', psychId: 'p1', sessionIds: ['s-4', 's-5'] },
  ])
})

test('adjacent session intervals are not conflicts', () => {
  const sessions = [
    { id: 's-early', psychId: 'p1', date: '2026-07-10', time: '09:00', duration: 50, status: 'scheduled' },
    { id: 's-late', psychId: 'p1', date: '2026-07-10', time: '09:50', duration: 50, status: 'scheduled' },
  ]
  assert.deepEqual(sessionConflicts(sessions), [])
})

test('cancelled sessions never create conflicts', () => {
  const sessions = [
    { id: 's-active', psychId: 'p1', date: '2026-07-10', time: '09:00', duration: 50, status: 'scheduled' },
    { id: 's-cancelled', psychId: 'p1', date: '2026-07-10', time: '09:10', duration: 50, status: 'cancelled' },
  ]
  assert.deepEqual(sessionConflicts(sessions), [])
})

test('session status becomes available at the session start, while a no-show remains valid before it', () => {
  const session = { date: '2026-09-11', time: '14:05' }

  assert.equal(sessionHasStarted(session, new Date('2026-09-11T12:04:00.000Z')), false)
  assert.equal(sessionHasStarted(session, new Date('2026-09-11T12:05:00.000Z')), true)
  assert.equal(sessionHasStarted(session, new Date('2026-09-12T06:00:00.000Z')), true)
})

test('assignment start rejects an earlier session at full Warsaw date and time precision', () => {
  const startsAt = '2026-09-11T12:05:00.000Z'
  const startsAtWithSeconds = '2026-09-11T12:05:30.000Z'

  assert.equal(isBeforeAssignmentStart('2026-09-11', '14:04', startsAt), true)
  assert.equal(isBeforeAssignmentStart('2026-09-11', '14:05', startsAt), false)
  assert.equal(isBeforeAssignmentStart('2026-09-11', '14:05', startsAtWithSeconds), true)
  assert.equal(isBeforeAssignmentStart('2026-09-11', '14:06', startsAtWithSeconds), false)
  assert.equal(isBeforeAssignmentStart('2026-09-12', '08:00', startsAt), false)
  assert.equal(assignmentStartLabel(startsAt), '11 września o 14:05')
})

test('billing summary scopes billable amounts to one specialist', () => {
  const sessions = [
    { id: 's1', psychId: 'p1', status: 'completed', amount: 200, payment: 'paid', paidAmount: 200 },
    { id: 's2', psychId: 'p1', status: 'noshow', amount: 100, payment: 'partial', paidAmount: 40 },
    { id: 's3', psychId: 'p1', status: 'scheduled', amount: 900, payment: 'unpaid', paidAmount: 0 },
    { id: 's4', psychId: 'p2', status: 'completed', amount: 300, payment: 'unpaid', paidAmount: 0 },
  ]

  assert.deepEqual(scopedBillingSummary(sessions, { psychId: 'p1' }), {
    due: 300,
    collected: 240,
    outstanding: 60,
  })
  assert.deepEqual(scopedBillingSummary(sessions), {
    due: 600,
    collected: 240,
    outstanding: 360,
  })
})

test('psychologist defaults include a stable avatar while preserving explicit values', () => {
  assert.deepEqual(withPsychologistDefaults({ id: 'p-new', weeklyCapacity: 12, avatarKey: 'wave' }), {
    id: 'p-new', weeklyCapacity: 12, avatarKey: 'wave',
  })
  assert.deepEqual(withPsychologistDefaults({ id: 'p-default' }), {
    id: 'p-default', weeklyCapacity: 20, avatarKey: 'bloom',
  })
  // every seeded specialist declares her own capacity, so the default never
  // has to fire — part-time members (the TUS trainers) sit below twenty
  assert.equal(
    PSYCHOLOGISTS.every((p) => Number.isInteger(p.weeklyCapacity) && p.weeklyCapacity > 0),
    true,
  )
})

test('specialist weekly load counts Monday through Sunday and excludes cancelled sessions', () => {
  const sessions = [
    { id: 'before', psychId: 'p1', date: '2026-07-12', status: 'scheduled' },
    { id: 'monday', psychId: 'p1', date: '2026-07-13', status: 'completed' },
    { id: 'cancelled', psychId: 'p1', date: '2026-07-14', status: 'cancelled' },
    { id: 'sunday', psychId: 'p1', date: '2026-07-19', status: 'scheduled' },
    { id: 'after', psychId: 'p1', date: '2026-07-20', status: 'scheduled' },
    { id: 'other', psychId: 'p2', date: '2026-07-15', status: 'scheduled' },
  ]

  assert.deepEqual(specialistWeekLoad(sessions, { id: 'p1', weeklyCapacity: 2 }, new Date('2026-07-14T12:00:00')), {
    start: '2026-07-13',
    end: '2026-07-19',
    booked: 2,
    capacity: 2,
    remaining: 0,
    status: 'full',
  })
  assert.equal(
    specialistWeekLoad([...sessions, { id: 'extra', psychId: 'p1', date: '2026-07-16', status: 'noshow' }], { id: 'p1', weeklyCapacity: 2 }, new Date('2026-07-14T12:00:00')).status,
    'over'
  )
})

test('partial payment replaces an invalid full paid amount with a valid partial amount', () => {
  assert.deepEqual(paymentPatchFor('partial', 220, 220), { payment: 'partial', paidAmount: 110 })
})

test('partial payment keeps a strict partial amount for low positive totals', () => {
  assert.deepEqual(paymentPatchFor('partial', 1, 1), { payment: 'partial', paidAmount: 0.5 })
})

test('session filters combine payment and attendance constraints', () => {
  const filters = { payment: 'partial', attendance: 'completed' }
  assert.equal(sessionMatchesFilters(state.sessions[1], filters), true)
  assert.equal(sessionMatchesFilters({ ...state.sessions[1], payment: 'unpaid' }, filters), false)
  assert.equal(sessionMatchesFilters({ ...state.sessions[1], status: 'noshow' }, filters), false)
  assert.equal(sessionMatchesFilters(state.sessions[1], { payment: 'all', attendance: 'all' }), true)
  assert.equal(sessionMatchesFilters(state.sessions[1], { payment: 'all', attendance: 'all', specialist: 'p2' }), true)
  assert.equal(sessionMatchesFilters(state.sessions[1], { payment: 'all', attendance: 'all', specialist: 'p1' }), false)
})

test('the latest non-cancelled client session supplies the specialist default', () => {
  const sessions = [
    { id: 'cancelled-latest', clientId: 'c1', psychId: 'p3', date: '2026-08-05', time: '16:00', status: 'cancelled' },
    { id: 'latest', clientId: 'c1', psychId: 'p2', date: '2026-08-04', time: '14:00', status: 'scheduled' },
    { id: 'earlier', clientId: 'c1', psychId: 'p1', date: '2026-08-04', time: '09:00', status: 'completed' },
    { id: 'other-client', clientId: 'c2', psychId: 'p3', date: '2026-08-06', time: '10:00', status: 'scheduled' },
  ]

  assert.equal(latestSessionForClient(sessions, 'c1')?.id, 'latest')
  assert.equal(latestSessionForClient(sessions, 'missing'), null)
})

test('session specialist defaults stay within the available scope', () => {
  const availablePsychologists = [{ id: 'p1' }, { id: 'p2' }]

  assert.equal(sessionSpecialistId({
    availablePsychologists, latestPsychId: 'p2', clientPsychId: 'p3', currentPsychId: 'p1',
  }), 'p2')
  assert.equal(sessionSpecialistId({
    availablePsychologists, latestPsychId: 'p3', clientPsychId: 'p4', currentPsychId: 'p1',
  }), 'p1')
  assert.equal(sessionSpecialistId({
    availablePsychologists, latestPsychId: 'p3', clientPsychId: 'p2', currentPsychId: 'p1',
  }), 'p2')
  assert.equal(sessionSpecialistId({
    availablePsychologists, ownPsychId: 'p2', latestPsychId: 'p1', clientPsychId: 'p1',
  }), 'p2')
  assert.equal(sessionSpecialistId({
    availablePsychologists, preferredPsychId: 'p1', latestPsychId: 'p2', clientPsychId: 'p2',
  }), 'p1')
  assert.equal(sessionSpecialistId({
    availablePsychologists, latestPsychId: 'p3', clientPsychId: 'p4', currentPsychId: 'p5',
  }), '')
})

test('occupied specialist sessions provide an exact next-time suggestion without inventing availability', () => {
  const sessions = [
    { id: 'cancelled', psychId: 'p1', date: '2026-08-04', time: '15:00', duration: 50, status: 'cancelled' },
    { id: 'late', psychId: 'p1', date: '2026-08-04', time: '14:00', duration: 60, status: 'scheduled' },
    { id: 'early', psychId: 'p1', date: '2026-08-04', time: '09:00', duration: 50, status: 'completed' },
    { id: 'other-specialist', psychId: 'p2', date: '2026-08-04', time: '16:00', duration: 50, status: 'scheduled' },
  ]

  assert.deepEqual(
    occupiedSessionsForSpecialistDay(sessions, { psychId: 'p1', date: '2026-08-04' }).map((session) => session.id),
    ['early', 'late'],
  )
  assert.equal(suggestedSessionTime(sessions, { psychId: 'p1', date: '2026-08-04' }), '15:00')
  assert.equal(suggestedSessionTime(sessions, { psychId: 'p2', date: '2026-08-04' }), '16:50')
  assert.equal(suggestedSessionTime(sessions, { psychId: 'missing', date: '2026-08-04' }), null)
})

test('occupied-time labels keep the first matching interval and omit later duplicates', () => {
  const sessions = [
    { id: 'first', time: '09:00', duration: 50 },
    { id: 'duplicate', time: '09:00', duration: 50 },
    { id: 'next', time: '10:00', duration: 60 },
  ]

  assert.deepEqual(occupiedTimeLabels(sessions), ['09:00-09:50', '10:00-11:00'])
})

test('families with fewer than two members dissolve completely', () => {
  const clients = [
    { id: 'c1', familyId: 'f1', familyRole: 'rodzic' },
    { id: 'c2', familyId: null, familyRole: null },
    { id: 'c3', familyId: 'f2', familyRole: null },
    { id: 'c4', familyId: 'f2', familyRole: 'dziecko' },
  ]
  const out = dissolveLoneFamilies(clients)
  assert.deepEqual(out.map((c) => c.familyId), [null, null, 'f2', 'f2'])
  assert.equal(out[0].familyRole, null)
})

test('billable summary includes billable no-shows in its average population', () => {
  assert.deepEqual(billableSummary([
    { status: 'completed', amount: 200, payment: 'paid', paidAmount: 200 },
    { status: 'noshow', amount: 100, payment: 'unpaid', paidAmount: 0 },
  ]), { billable: 2, revenue: 300, collected: 200, outstanding: 100 })
})

test('payment entry marks an exact remainder as fully paid', () => {
  const session = {
    amount: 220,
    payment: 'unpaid',
    paidAmount: 0,
    method: null,
    paidDate: null,
    status: 'completed',
  }

  assert.deepEqual(paymentEntryFor(session, {
    amount: '220',
    method: 'transfer',
    paidDate: '2026-07-14',
  }), {
    errors: {},
    patch: {
      payment: 'paid',
      paidAmount: 220,
      method: 'transfer',
      paidDate: '2026-07-14',
    },
  })
})

test('payment entry adds to a prior amount and remains partial below the total', () => {
  const session = {
    amount: 260,
    payment: 'partial',
    paidAmount: 130,
    method: 'cash',
    paidDate: '2026-07-01',
    status: 'completed',
  }

  assert.deepEqual(paymentEntryFor(session, {
    amount: '60',
    method: 'card',
    paidDate: '2026-07-14',
  }), {
    errors: {},
    patch: {
      payment: 'partial',
      paidAmount: 190,
      method: 'card',
      paidDate: '2026-07-14',
    },
  })
})

test('payment entry rejects a missing method and an amount above the exact remainder', () => {
  const session = {
    amount: 260,
    payment: 'partial',
    paidAmount: 130,
    method: 'cash',
    paidDate: '2026-07-01',
    status: 'completed',
  }

  assert.deepEqual(paymentEntryFor(session, {
    amount: '131',
    method: '',
    paidDate: '2026-07-14',
  }), {
    errors: {
      amount: `Do zapłaty zostało ${fmtMoney(130)} - wpisz tyle albo mniej.`,
      method: 'Wybierz formę płatności',
    },
    patch: null,
  })
})

test('payment entry requires an amount greater than zero', () => {
  const session = {
    amount: 220,
    payment: 'unpaid',
    paidAmount: 0,
    method: null,
    paidDate: null,
    status: 'completed',
  }

  assert.deepEqual(paymentEntryFor(session, {
    amount: '0',
    method: 'cash',
    paidDate: '2026-07-14',
  }), {
    errors: { amount: 'Wpisz kwotę, np. 180 albo 180,50.' },
    patch: null,
  })
})

test('payment entry accepts the exact cent remainder without floating-point rejection', () => {
  const session = {
    amount: 100,
    payment: 'partial',
    paidAmount: 8.21,
    method: 'cash',
    paidDate: '2026-07-01',
    status: 'completed',
  }

  assert.deepEqual(paymentEntryFor(session, {
    amount: '91.79',
    method: 'card',
    paidDate: '2026-07-14',
  }), {
    errors: {},
    patch: {
      payment: 'paid',
      paidAmount: 100,
      method: 'card',
      paidDate: '2026-07-14',
    },
  })
})

test('payment entry accepts a decimal comma', () => {
  const session = {
    amount: 180.5,
    payment: 'unpaid',
    paidAmount: 0,
    method: null,
    paidDate: null,
    status: 'completed',
  }

  assert.deepEqual(paymentEntryFor(session, {
    amount: '180,50',
    method: 'cash',
    paidDate: '2026-07-14',
  }).patch, {
    payment: 'paid',
    paidAmount: 180.5,
    method: 'cash',
    paidDate: '2026-07-14',
  })
})

test('payment snapshot preserves every value needed to undo a booking', () => {
  assert.deepEqual(paymentSnapshotOf({
    payment: 'partial',
    paidAmount: 80,
    method: 'cash',
    paidDate: '2026-07-01',
  }), {
    payment: 'partial',
    paidAmount: 80,
    method: 'cash',
    paidDate: '2026-07-01',
  })
})

test('payment entry rejects thousands separators and a third decimal', () => {
  const session = { amount: 1800, payment: 'unpaid', paidAmount: 0, method: null, paidDate: null, status: 'completed' }
  for (const amount of ['1,000', '180,555', '1 000', '-5']) {
    assert.equal(paymentEntryFor(session, { amount, method: 'cash', paidDate: '2026-07-14' }).errors.amount,
      'Wpisz kwotę, np. 180 albo 180,50.')
  }
})
