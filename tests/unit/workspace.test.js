import assert from 'node:assert/strict'
import test from 'node:test'
import { roleById, sessionsForRole, dayAttention, todayWorkspace, sessionMatchesFilters } from '../../src/workspace.js'
import { paymentPatchFor } from '../../src/format.js'

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
})

test('partial payment replaces an invalid full paid amount with a valid partial amount', () => {
  assert.deepEqual(paymentPatchFor('partial', 220, 220), { payment: 'partial', paidAmount: 110 })
})

test('partial payment keeps a strict partial amount for low positive totals', () => {
  assert.deepEqual(paymentPatchFor('partial', 1, 1), { payment: 'partial', paidAmount: 0.5 })
})

test('session filters combine inclusive date, payment, and attendance constraints', () => {
  const filters = {
    dateFrom: '2026-07-10',
    dateTo: '2026-07-10',
    payment: 'partial',
    attendance: 'completed',
  }
  assert.equal(sessionMatchesFilters(state.sessions[1], filters), true)
  assert.equal(sessionMatchesFilters({ ...state.sessions[1], payment: 'unpaid' }, filters), false)
  assert.equal(sessionMatchesFilters({ ...state.sessions[1], date: '2026-07-11' }, filters), false)
})
