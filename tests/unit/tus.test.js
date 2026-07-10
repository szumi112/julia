import assert from 'node:assert/strict'
import test from 'node:test'
import { roleById } from '../../src/workspace.js'
import {
  tusGroupsForRole, canLeadGroup, kidsOfGroup, unassignedKids, classesInMonth, tusMonths,
  nextClassOf, attendanceRate, tusPaymentFor, tusMonthSummary, stripKid,
} from '../../src/tus.js'

const groups = [
  { id: 'g1', name: 'Grupa TUS 5–6 lat', leaderIds: ['p2', 'p3'], fee: 300 },
  { id: 'g2', name: 'Grupa TUS 4 lata', leaderIds: ['p3', 'p4'], fee: 300 },
]
const kids = [
  { id: 'k1', groupId: 'g1' }, { id: 'k2', groupId: 'g1' }, { id: 'k3', groupId: null },
]
const classes = [
  { id: 'tc1', groupId: 'g1', date: '2026-07-01', time: '16:00', topic: 'Emocje', attendance: { k1: true, k2: false } },
  { id: 'tc2', groupId: 'g1', date: '2026-07-08', time: '16:00', topic: '', attendance: { k1: true, k2: true } },
  { id: 'tc3', groupId: 'g1', date: '2026-07-15', time: '16:00', topic: '', attendance: {} },
  { id: 'tc4', groupId: 'g2', date: '2026-06-25', time: '17:00', topic: '', attendance: {} },
]
const payments = [
  { id: 'tp1', kidId: 'k1', ym: '2026-07', amount: 300, status: 'paid', method: 'transfer', invoice: true, paidDate: '2026-07-05', note: '' },
]

test('therapist sees only groups they lead', () => {
  assert.deepEqual(tusGroupsForRole({ tusGroups: groups }, roleById('therapist')).map((g) => g.id), ['g1'])
})

test('centre roles see every group', () => {
  assert.deepEqual(tusGroupsForRole({ tusGroups: groups }, roleById('owner')).map((g) => g.id), ['g1', 'g2'])
})

test('leadership requires centre scope or being a leader', () => {
  assert.equal(canLeadGroup(groups[0], roleById('therapist')), true) // p2 leads g1
  assert.equal(canLeadGroup(groups[1], roleById('therapist')), false) // p2 does not lead g2
  assert.equal(canLeadGroup(groups[1], roleById('coordinator')), true)
})

test('kids split into roster and unassigned pool', () => {
  assert.deepEqual(kidsOfGroup(kids, 'g1').map((k) => k.id), ['k1', 'k2'])
  assert.deepEqual(unassignedKids(kids).map((k) => k.id), ['k3'])
})

test('classes filter by month and months list is sorted unique', () => {
  assert.deepEqual(classesInMonth(classes, '2026-07').map((c) => c.id), ['tc1', 'tc2', 'tc3'])
  assert.deepEqual(tusMonths(classes), ['2026-06', '2026-07'])
})

test('next class is the first at or after now for the group', () => {
  assert.equal(nextClassOf(classes, 'g1', '2026-07-05').id, 'tc2')
  assert.equal(nextClassOf(classes, 'g1', '2026-08-01'), null)
})

test('attendance rate counts marked cells only', () => {
  assert.equal(attendanceRate(classes.filter((c) => c.groupId === 'g1')), 75) // 3 of 4 marks are present
  assert.equal(attendanceRate(classes.filter((c) => c.groupId === 'g1'), 'k2'), 50)
  assert.equal(attendanceRate([classes[3]]), null)
})

test('payment lookup falls back to an unpaid default', () => {
  assert.equal(tusPaymentFor(payments, 'k1', '2026-07').status, 'paid')
  assert.deepEqual(tusPaymentFor(payments, 'k2', '2026-07'), {
    kidId: 'k2', ym: '2026-07', status: 'unpaid', method: null, invoice: false, paidDate: null, note: '', amount: null,
  })
})

test('month summary aggregates classes, attendance, and dues', () => {
  assert.deepEqual(tusMonthSummary(groups[0], classes, kids, payments, '2026-07', '2026-07-10'), {
    classCount: 3, heldCount: 2, attendanceRate: 75, paidCount: 1, dueCount: 1, dueAmount: 300,
  })
})

test('stripKid removes attendance marks and payment rows', () => {
  const out = stripKid(classes, payments, 'k1')
  assert.equal('k1' in out.classes[0].attendance, false)
  assert.equal(out.classes[0].attendance.k2, false)
  assert.deepEqual(out.payments, [])
})
