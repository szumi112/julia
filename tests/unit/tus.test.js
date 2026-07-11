import assert from 'node:assert/strict'
import test from 'node:test'
import { roleById } from '../../src/workspace.js'
import {
  tusGroupsForRole, canLeadGroup, kidsOfGroup, unassignedKids, classesInMonth, tusMonths,
  nextClassOf, attendanceRate, setAttendanceForRoster, tusPaymentFor, tusMonthSummary, stripKid,
  tusMemberOptions, filterTusMemberOptions, assignTusGroupMembers, materializeTusGroupMembers,
  linkTusGuardian, unlinkTusGuardian, updateTusKidAndClients,
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

test('classes in a month are sorted by date and time', () => {
  const unsorted = [
    { id: 'late', date: '2026-07-08', time: '18:00' },
    { id: 'middle', date: '2026-07-08', time: '16:00' },
    { id: 'early', date: '2026-07-01', time: '17:00' },
  ]
  assert.deepEqual(classesInMonth(unsorted, '2026-07').map((c) => c.id), ['early', 'middle', 'late'])
})

test('next class is the first at or after now for the group', () => {
  assert.equal(nextClassOf(classes, 'g1', '2026-07-05').id, 'tc2')
  assert.equal(nextClassOf(classes, 'g1', '2026-08-01'), null)
})

test('next class respects the time on the current day', () => {
  const timed = [
    { id: 'morning', groupId: 'g1', date: '2026-07-11', time: '09:00', attendance: {} },
    { id: 'evening', groupId: 'g1', date: '2026-07-11', time: '17:00', attendance: {} },
  ]
  assert.equal(nextClassOf(timed, 'g1', '2026-07-11T12:00').id, 'evening')
})

test('attendance rate counts marked cells only', () => {
  assert.equal(attendanceRate(classes.filter((c) => c.groupId === 'g1')), 75) // 3 of 4 marks are present
  assert.equal(attendanceRate(classes.filter((c) => c.groupId === 'g1'), 'k2'), 50)
  assert.equal(attendanceRate([classes[3]]), null)
})

test('taking attendance marks the rest of the roster absent', () => {
  assert.deepEqual(setAttendanceForRoster({}, ['k1', 'k2', 'k3'], 'k2', true), {
    k1: false,
    k2: true,
    k3: false,
  })
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

test('month summary counts only classes that have started', () => {
  const timed = [
    { id: 'morning', groupId: 'g1', date: '2026-07-11', time: '09:00', attendance: { k1: true } },
    { id: 'evening', groupId: 'g1', date: '2026-07-11', time: '17:00', attendance: {} },
  ]
  assert.equal(tusMonthSummary(groups[0], timed, kids, payments, '2026-07', '2026-07-11T12:00').heldCount, 1)
})

test('month summary respects a discounted unpaid amount', () => {
  const discounted = [
    ...payments,
    { id: 'tp2', kidId: 'k2', ym: '2026-07', amount: 225, status: 'unpaid', method: null, invoice: false, paidDate: null, note: '' },
  ]
  assert.equal(tusMonthSummary(groups[0], classes, kids, discounted, '2026-07', '2026-07-10').dueAmount, 225)
})

test('group aggregates ignore marks left by kids who moved groups', () => {
  const withGhost = [
    { id: 'tc9', groupId: 'g1', date: '2026-07-01', time: '16:00', topic: '', attendance: { k1: true, ghost: false } },
  ]
  assert.equal(attendanceRate(withGhost, ['k1']), 100)
  assert.equal(tusMonthSummary(groups[0], withGhost, kids, [], '2026-07', '2026-07-10').attendanceRate, 100)
})

test('stripKid removes attendance marks and payment rows', () => {
  const out = stripKid(classes, payments, 'k1')
  assert.equal('k1' in out.classes[0].attendance, false)
  assert.equal(out.classes[0].attendance.k2, false)
  assert.deepEqual(out.payments, [])
})

test('member options merge TUS children with linked client records without duplicates', () => {
  const clients = [
    { id: 'c-parent', name: 'Renata Gawrys', phone: '+48 500 100 200', email: 'renata@example.test', familyId: 'f1', familyRole: 'rodzic' },
    { id: 'c-linked', name: 'Basia Borkowska', phone: '', email: '', familyId: 'f1', familyRole: 'dziecko' },
    { id: 'c-new', name: 'Ala Nowak', phone: '', email: '', familyId: 'f2', familyRole: 'dziecko' },
    { id: 'c-adult', name: 'Dorota Zawadzka', phone: '', email: '', familyId: null, familyRole: null },
  ]
  const memberKids = [
    { id: 'k-linked', clientId: 'c-linked', guardianClientId: 'c-parent', name: 'Nieaktualna Basia', age: 6, groupId: 'g1', parentName: 'Stary wpis', parentPhone: '' },
    { id: 'k-standalone', name: 'Celina Lis', age: 5, groupId: null, parentName: 'Zenon Lis', parentPhone: '+48 501 111 222' },
  ]

  const options = tusMemberOptions(clients, memberKids, groups)

  assert.deepEqual(options.map((option) => option.name), ['Ala Nowak', 'Basia Borkowska', 'Celina Lis'])
  assert.deepEqual(options.map((option) => option.key), ['client:c-new', 'kid:k-linked', 'kid:k-standalone'])
  assert.equal(options[1].parentName, 'Renata Gawrys')
  assert.equal(options[1].groupName, 'Grupa TUS 5–6 lat')
})

test('member search matches a child by parent, phone, or current group', () => {
  const options = [
    { key: 'kid:k1', name: 'Basia Borkowska', parentName: 'Renata Gawrys', parentPhone: '+48 500 100 200', groupName: 'Grupa TUS 5–6 lat' },
    { key: 'kid:k2', name: 'Celina Lis', parentName: 'Zenon Lis', parentPhone: '+48 501 111 222', groupName: '' },
  ]

  assert.deepEqual(filterTusMemberOptions(options, 'gawrys').map((option) => option.key), ['kid:k1'])
  assert.deepEqual(filterTusMemberOptions(options, '500 100').map((option) => option.key), ['kid:k1'])
  assert.deepEqual(filterTusMemberOptions(options, '500100200').map((option) => option.key), ['kid:k1'])
  assert.deepEqual(filterTusMemberOptions(options, '5-6 lat').map((option) => option.key), ['kid:k1'])
})

test('assigning group members adds unassigned children without moving another group’s roster', () => {
  const memberKids = [
    { id: 'k1', groupId: 'g1' },
    { id: 'k2', groupId: 'g2' },
    { id: 'k3', groupId: null },
    { id: 'k4', groupId: 'g3' },
  ]

  const updated = assignTusGroupMembers(memberKids, 'g2', ['k1', 'k3'])

  assert.deepEqual(updated.map((kid) => kid.groupId), ['g1', null, 'g2', 'g3'])
})

test('materializing a new group child creates linked client records and reuses an existing parent', () => {
  let sequence = 0
  const makeId = (prefix) => `${prefix}-new-${++sequence}`
  const clients = [
    { id: 'c-parent', name: 'Anna Kowalska', phone: '+48 600 123 456', email: 'anna@example.test', psychId: 'p4', familyId: null, familyRole: null },
  ]
  const draft = {
    key: 'new:mila',
    childName: 'Mila Kowalska',
    age: 5,
    parentClientId: 'c-parent',
    regulationsSigned: true,
  }

  const out = materializeTusGroupMembers({
    clients,
    kids: [],
    groupId: 'g-new',
    memberKeys: ['new:mila'],
    newChildren: [draft],
    leaderId: 'p2',
    today: '2026-07-11',
    makeId,
  })

  assert.equal(out.clients.length, 2)
  const parent = out.clients.find((client) => client.id === 'c-parent')
  const child = out.clients.find((client) => client.name === 'Mila Kowalska')
  assert.equal(parent.familyRole, 'rodzic')
  assert.equal(child.familyRole, 'dziecko')
  assert.equal(parent.familyId, child.familyId)
  assert.equal(child.psychId, 'p2')
  assert.deepEqual(out.kids.map((kid) => ({
    clientId: kid.clientId,
    guardianClientId: kid.guardianClientId,
    groupId: kid.groupId,
    parentName: kid.parentName,
    regulationsSigned: kid.regulationsSigned,
  })), [{
    clientId: child.id,
    guardianClientId: parent.id,
    groupId: 'g-new',
    parentName: 'Anna Kowalska',
    regulationsSigned: true,
  }])
})

test('editing a linked TUS profile keeps child and parent client cards in sync', () => {
  const clients = [
    { id: 'c-child', name: 'Mila Kowalska', age: 5, phone: '+48 600 000 000' },
    { id: 'c-parent', name: 'Anna Kowalska', phone: '+48 600 000 000' },
    { id: 'c-other', name: 'Bez zmian', phone: '+48 511 111 111' },
  ]
  const memberKids = [{
    id: 'k1', clientId: 'c-child', guardianClientId: 'c-parent', name: 'Mila Kowalska', age: 5,
    parentName: 'Anna Kowalska', parentPhone: '+48 600 000 000', groupId: 'g1', regulationsSigned: false,
  }]

  const out = updateTusKidAndClients(clients, memberKids, 'k1', {
    name: 'Mila Nowak',
    age: 6,
    parentName: 'Anna Nowak',
    parentPhone: '+48 600 123 456',
    regulationsSigned: true,
  })

  assert.deepEqual(out.kids[0], {
    ...memberKids[0],
    name: 'Mila Nowak', age: 6, parentName: 'Anna Nowak', parentPhone: '+48 600 123 456', regulationsSigned: true,
  })
  assert.deepEqual(out.clients.find((client) => client.id === 'c-child'), {
    id: 'c-child', name: 'Mila Nowak', age: 6, phone: '+48 600 123 456',
  })
  assert.deepEqual(out.clients.find((client) => client.id === 'c-parent'), {
    id: 'c-parent', name: 'Anna Nowak', phone: '+48 600 123 456',
  })
  assert.equal(out.clients.find((client) => client.id === 'c-other').name, 'Bez zmian')
})

test('family relinking replaces the TUS guardian contact', () => {
  const memberKids = [{
    id: 'k1', clientId: 'c-child', guardianClientId: 'c-old-parent',
    parentName: 'Stary Rodzic', parentPhone: '+48 500 000 000',
  }]

  const linked = linkTusGuardian(memberKids, 'c-child', {
    id: 'c-new-parent', name: 'Nowy Rodzic', phone: '+48 600 123 456',
  })

  assert.deepEqual(linked[0], {
    ...memberKids[0],
    guardianClientId: 'c-new-parent', parentName: 'Nowy Rodzic', parentPhone: '+48 600 123 456',
  })
})

test('family unlinking clears TUS guardian references from either linked card', () => {
  const memberKids = [{
    id: 'k1', clientId: 'c-child', guardianClientId: 'c-parent',
    parentName: 'Anna Kowalska', parentPhone: '+48 600 123 456',
  }]
  const clearedFromChild = unlinkTusGuardian(memberKids, 'c-child')
  const clearedFromParent = unlinkTusGuardian(memberKids, 'c-parent')

  for (const result of [clearedFromChild, clearedFromParent]) {
    assert.equal(result[0].guardianClientId, null)
    assert.equal(result[0].parentName, '')
    assert.equal(result[0].parentPhone, '')
  }
})

test('sibling drafts with the same new parent share one parent client and family', () => {
  let sequence = 0
  const makeId = (prefix) => `${prefix}-new-${++sequence}`
  const newChildren = [
    {
      key: 'new:ola', childName: 'Ola Kowalska', age: 5, parentClientId: '',
      parentName: 'Anna Kowalska', parentPhone: '+48 600 123 456', parentEmail: 'anna@example.test',
    },
    {
      key: 'new:mila', childName: 'Mila Kowalska', age: 7, parentClientId: '',
      parentName: 'Anna Kowalska', parentPhone: '+48 600 123 456', parentEmail: 'anna@example.test',
    },
  ]

  const out = materializeTusGroupMembers({
    clients: [], kids: [], groupId: 'g1', memberKeys: newChildren.map((draft) => draft.key),
    newChildren, leaderId: 'p2', today: '2026-07-11', makeId,
  })

  assert.equal(out.clients.filter((client) => client.familyRole === 'rodzic').length, 1)
  assert.equal(out.clients.filter((client) => client.familyRole === 'dziecko').length, 2)
  assert.equal(new Set(out.clients.map((client) => client.familyId)).size, 1)
  assert.equal(new Set(out.kids.map((kid) => kid.guardianClientId)).size, 1)
})
