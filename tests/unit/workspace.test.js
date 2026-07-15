import assert from 'node:assert/strict'
import test from 'node:test'
import * as workspace from '../../src/workspace.js'
import { PSYCHOLOGISTS } from '../../src/data.js'
import { billableSummary, paymentPatchFor } from '../../src/format.js'

const {
  roleById, sessionsForRole, clientsForRole, dayAttention, todayWorkspace, sessionMatchesFilters,
  dissolveLoneFamilies, normalizeSearchText, clientMatchesQuery, dayStatusSummary, sessionConflicts,
  paymentEntryFor, paymentSnapshotOf, scopedBillingSummary, specialistWeekLoad, withPsychologistDefaults,
} = workspace

const state = {
  sessions: [
    { id: 's-owner', psychId: 'p1', date: '2026-07-10', time: '09:00', status: 'scheduled', amount: 220, payment: 'unpaid', paidAmount: 0 },
    { id: 's-therapist', psychId: 'p2', date: '2026-07-10', time: '10:00', status: 'completed', amount: 260, payment: 'partial', paidAmount: 130 },
  ],
  clients: [],
  psychologists: [],
}

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

test('psychologist capacity defaults to twenty while preserving explicit values', () => {
  assert.deepEqual(withPsychologistDefaults({ id: 'p-new', weeklyCapacity: 12 }), {
    id: 'p-new', weeklyCapacity: 12,
  })
  assert.deepEqual(withPsychologistDefaults({ id: 'p-default' }), {
    id: 'p-default', weeklyCapacity: 20,
  })
  assert.equal(PSYCHOLOGISTS.every((psychologist) => psychologist.weeklyCapacity === 20), true)
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
      amount: 'Kwota nie może przekraczać pozostałej kwoty',
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
    errors: { amount: 'Podaj kwotę większą od zera' },
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
