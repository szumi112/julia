// Pure TUS domain logic (group classes) — kept .js and side-effect free so it
// is unit-testable like workspace.js. TUS money is intentionally separate from
// session billing: nothing here feeds isBillable/monthStats.
import { ageLabel, monthKey, searchNorm } from './format.js'
import { normalizeSearchText } from './workspace.js'

const polishNameOrder = new Intl.Collator('pl', { sensitivity: 'base' })

export const sortTusByName = (items) => items.toSorted((a, b) =>
  polishNameOrder.compare(a.name, b.name) || a.id.localeCompare(b.id)
)

/**
 * Groups read as an age ladder, not an alphabet — „przedszkolaki 5–6" belongs
 * before „nastolatki 13–16" however the names sort. Groups without bounds fall
 * to the end, then alphabetically.
 */
export const sortTusGroups = (groups) => groups.toSorted((a, b) => {
  const aAge = Number.isInteger(a.ageMin) ? a.ageMin : Infinity
  const bAge = Number.isInteger(b.ageMin) ? b.ageMin : Infinity
  if (aAge !== bAge) return aAge - bAge
  return polishNameOrder.compare(a.name, b.name) || a.id.localeCompare(b.id)
})

export const withTusGroupDefaults = (group) => ({
  ...group,
  capacity: group.capacity ?? 8,
  ageMin: group.ageMin ?? null,
  ageMax: group.ageMax ?? null,
})

// group age ranges use the shared Polish age formatter
export const tusAgeLabel = ageLabel

export const tusAssignmentStatusLabel = ({ ageMatch, isFull }) => {
  if (isFull) return 'Brak miejsc'
  if (ageMatch === true) return 'Polecana'
  if (ageMatch === false) return 'Poza przedziałem wiekowym'
  return 'Brak przedziału wiekowego'
}

export const searchTusOverview = ({ groups = [], kids = [], query } = {}) => {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return { groups: [], kids: [] }
  return {
    groups: sortTusGroups(groups.filter((group) => normalizeSearchText(group.name).includes(normalizedQuery))),
    kids: sortTusByName(kids.filter((kid) =>
      [kid.name, kid.parentName, kid.parentPhone]
        .some((value) => normalizeSearchText(value).includes(normalizedQuery))
    )),
  }
}

export const tusAssignmentOptions = ({ groups = [], kids = [], kid } = {}) => {
  const memberCounts = new Map()
  for (const member of kids) {
    if (!member.groupId) continue
    memberCounts.set(member.groupId, (memberCounts.get(member.groupId) || 0) + 1)
  }

  return groups
    .map((sourceGroup) => {
      const group = withTusGroupDefaults(sourceGroup)
      const memberCount = memberCounts.get(group.id) || 0
      const remaining = Math.max(group.capacity - memberCount, 0)
      const isFull = memberCount >= group.capacity
      const hasAge = kid?.age !== null && kid?.age !== undefined && kid?.age !== ''
      const hasBounds = group.ageMin !== null && group.ageMax !== null
      const ageMatch = hasAge && hasBounds
        ? Number(kid.age) >= Number(group.ageMin) && Number(kid.age) <= Number(group.ageMax)
        : null
      return { ...group, ageMatch, isFull, memberCount, remaining }
    })
    .sort((a, b) => {
      const tierOf = (group) => group.isFull ? 2 : group.ageMatch === true ? 0 : 1
      return tierOf(a) - tierOf(b)
        || polishNameOrder.compare(a.name, b.name)
        || a.id.localeCompare(b.id)
    })
}

export const tusGroupsForRole = (state, role) =>
  role.scope === 'own' ? state.tusGroups.filter((g) => g.leaderIds.includes(role.psychId)) : state.tusGroups

export const canLeadGroup = (group, role) =>
  role.scope !== 'own' || group.leaderIds.includes(role.psychId)

export const kidsOfGroup = (kids, groupId) => kids.filter((k) => k.groupId === groupId)

export const unassignedKids = (kids) => kids.filter((k) => !k.groupId)

export const tusMemberOptions = (clients, kids, groups) => {
  const clientsById = new Map(clients.map((client) => [client.id, client]))
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const enrolledClientIds = new Set(kids.map((kid) => kid.clientId).filter(Boolean))

  const parentOf = (client, guardianClientId) => {
    if (guardianClientId && clientsById.has(guardianClientId)) return clientsById.get(guardianClientId)
    if (!client?.familyId) return null
    return clients.find((candidate) =>
      candidate.familyId === client.familyId && candidate.id !== client.id && candidate.familyRole === 'rodzic'
    ) || null
  }

  const options = kids.map((kid) => {
    const client = clientsById.get(kid.clientId)
    const parent = parentOf(client, kid.guardianClientId)
    return {
      key: `kid:${kid.id}`,
      kidId: kid.id,
      clientId: client?.id || null,
      name: client?.name || kid.name,
      age: kid.age ?? null,
      parentName: parent?.name || kid.parentName || '',
      parentPhone: parent?.phone || kid.parentPhone || '',
      groupId: kid.groupId || null,
      groupName: groupsById.get(kid.groupId)?.name || '',
      source: 'tus',
    }
  })

  for (const client of clients) {
    if (client.familyRole !== 'dziecko' || enrolledClientIds.has(client.id)) continue
    const parent = parentOf(client)
    options.push({
      key: `client:${client.id}`,
      kidId: null,
      clientId: client.id,
      name: client.name,
      age: client.age ?? null,
      parentName: parent?.name || '',
      parentPhone: parent?.phone || '',
      groupId: null,
      groupName: '',
      source: 'client',
    })
  }

  return options.sort((a, b) => polishNameOrder.compare(a.name, b.name) || a.key.localeCompare(b.key))
}

const memberSearchText = (option) =>
  `${searchNorm([option.name, option.parentName, option.parentPhone, option.groupName].filter(Boolean).join(' '))
    .replace(/[–—]/g, '-')} ${String(option.parentPhone || '').replace(/\D/g, '')}`

export const filterTusMemberOptions = (options, query) => {
  const needle = searchNorm(query).replace(/[–—]/g, '-').trim()
  return needle ? options.filter((option) => memberSearchText(option).includes(needle)) : options
}

export const assignTusGroupMembers = (kids, groupId, memberKidIds) => {
  const selected = new Set(memberKidIds)
  return kids.map((kid) => {
    if (selected.has(kid.id)) {
      if (kid.groupId && kid.groupId !== groupId) return kid
      return kid.groupId === groupId ? kid : { ...kid, groupId }
    }
    if (kid.groupId === groupId) return { ...kid, groupId: null }
    return kid
  })
}

export const materializeTusGroupMembers = ({
  clients,
  kids,
  groupId,
  memberKeys,
  newChildren = [],
  leaderId = null,
  today,
  makeId,
}) => {
  let nextClients = [...clients]
  let nextKids = [...kids]
  const clientsById = new Map(nextClients.map((client) => [client.id, client]))
  const draftsByKey = new Map(newChildren.map((draft) => [draft.key, draft]))
  const newParentsByIdentity = new Map()
  const selectedKidIds = []

  const replaceClient = (client) => {
    clientsById.set(client.id, client)
    const index = nextClients.findIndex((candidate) => candidate.id === client.id)
    if (index === -1) nextClients = [...nextClients, client]
    else nextClients = nextClients.map((candidate) => candidate.id === client.id ? client : candidate)
  }

  const familyParentOf = (client) => {
    if (!client?.familyId) return null
    return nextClients.find((candidate) =>
      candidate.id !== client.id && candidate.familyId === client.familyId && candidate.familyRole === 'rodzic'
    ) || null
  }

  const addClientEnrollment = (client) => {
    const enrolled = nextKids.find((kid) => kid.clientId === client.id)
    if (enrolled) {
      selectedKidIds.push(enrolled.id)
      return
    }
    const parent = familyParentOf(client)
    const kid = {
      id: makeId('k'),
      clientId: client.id,
      guardianClientId: parent?.id || null,
      name: client.name,
      age: client.age ?? null,
      groupId: null,
      parentName: parent?.name || '',
      parentPhone: parent?.phone || '',
      regulationsSigned: false,
      note: '',
    }
    nextKids = [...nextKids, kid]
    selectedKidIds.push(kid.id)
  }

  const addDraftChild = (draft) => {
    const parentIdentity = !draft.parentClientId
      ? `${searchNorm(draft.parentName).trim()}|${String(draft.parentPhone || '').replace(/\D/g, '')}|${searchNorm(draft.parentEmail).trim()}`
      : ''
    let parent = draft.parentClientId
      ? clientsById.get(draft.parentClientId)
      : newParentsByIdentity.get(parentIdentity)
    if (!parent) {
      parent = {
        id: makeId('c'),
        name: draft.parentName,
        psychId: leaderId,
        email: draft.parentEmail || '',
        phone: draft.parentPhone || '',
        since: today,
        status: 'active',
        notes: [],
        familyId: null,
        familyRole: 'rodzic',
      }
    }

    const familyId = parent.familyId || makeId('f')
    parent = {
      ...parent,
      familyId,
      familyRole: parent.familyRole || 'rodzic',
    }
    replaceClient(parent)
    if (parentIdentity) newParentsByIdentity.set(parentIdentity, parent)

    const child = {
      id: makeId('c'),
      name: draft.childName,
      age: Number(draft.age),
      psychId: leaderId || parent.psychId || null,
      email: '',
      phone: parent.phone || '',
      since: today,
      status: 'active',
      notes: [],
      familyId,
      familyRole: 'dziecko',
    }
    replaceClient(child)

    const kid = {
      id: makeId('k'),
      clientId: child.id,
      guardianClientId: parent.id,
      name: child.name,
      age: child.age,
      groupId: null,
      parentName: parent.name,
      parentPhone: parent.phone || '',
      regulationsSigned: !!draft.regulationsSigned,
      note: '',
    }
    nextKids = [...nextKids, kid]
    selectedKidIds.push(kid.id)
  }

  for (const key of memberKeys) {
    const [kind, id] = key.split(':')
    if (kind === 'kid' && nextKids.some((kid) => kid.id === id)) selectedKidIds.push(id)
    if (kind === 'client') {
      const client = clientsById.get(id)
      if (client) addClientEnrollment(client)
    }
    if (kind === 'new') {
      const draft = draftsByKey.get(key)
      if (draft) addDraftChild(draft)
    }
  }

  return {
    clients: nextClients,
    kids: assignTusGroupMembers(nextKids, groupId, selectedKidIds),
  }
}

export const updateTusKidAndClients = (clients, kids, kidId, patch) => {
  const current = kids.find((kid) => kid.id === kidId)
  if (!current) return { clients, kids }
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key)
  return {
    kids: kids.map((kid) => kid.id === kidId ? { ...kid, ...patch } : kid),
    clients: clients.map((client) => {
      let next = client
      if (client.id === current.clientId) {
        next = {
          ...next,
          ...(has('name') ? { name: patch.name } : {}),
          ...(has('age') ? { age: patch.age } : {}),
          ...(has('parentPhone') ? { phone: patch.parentPhone } : {}),
        }
      }
      if (client.id === current.guardianClientId) {
        next = {
          ...next,
          ...(has('parentName') ? { name: patch.parentName } : {}),
          ...(has('parentPhone') ? { phone: patch.parentPhone } : {}),
        }
      }
      return next
    }),
  }
}

export const linkTusGuardian = (kids, childClientId, guardian) => kids.map((kid) =>
  kid.clientId === childClientId
    ? {
        ...kid,
        guardianClientId: guardian.id,
        parentName: guardian.name,
        parentPhone: guardian.phone || '',
      }
    : kid
)

export const unlinkTusGuardian = (kids, clientId) => kids.map((kid) =>
  kid.clientId === clientId || kid.guardianClientId === clientId
    ? { ...kid, guardianClientId: null, parentName: '', parentPhone: '' }
    : kid
)

export const classesInMonth = (classes, ym) =>
  classes
    .filter((c) => monthKey(c.date) === ym)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))

export const tusMonths = (classes) => [...new Set(classes.map((c) => monthKey(c.date)))].sort()

const normalizedMoment = (value) => value.includes('T') ? value.slice(0, 16) : `${value}T00:00`

export const tusClassMoment = (cls) => `${cls.date}T${cls.time || '00:00'}`

export const classHasStarted = (cls, nowIso) => tusClassMoment(cls) <= normalizedMoment(nowIso)

export const nextClassOf = (classes, groupId, nowIso) =>
  classes
    .filter((c) => c.groupId === groupId && tusClassMoment(c) >= normalizedMoment(nowIso))
    .sort((a, b) => tusClassMoment(a).localeCompare(tusClassMoment(b)))[0] || null

// Rate over marked cells only — unmarked (future) classes don't dilute it.
// kidFilter: a kid id, an array of kid ids, or nothing (every mark). Callers
// aggregating a group should pass the roster ids, so marks left behind by a
// kid who moved groups don't skew the rate.
export const attendanceRate = (classes, kidFilter) => {
  const wanted = Array.isArray(kidFilter) ? new Set(kidFilter) : kidFilter ? new Set([kidFilter]) : null
  let present = 0
  let marked = 0
  for (const c of classes) {
    for (const [kidId, value] of Object.entries(c.attendance)) {
      if (wanted && !wanted.has(kidId)) continue
      marked++
      if (value) present++
    }
  }
  return marked ? Math.round((present / marked) * 100) : null
}

export const setAttendanceForRoster = (attendance, rosterIds, kidId, present) => ({
  ...Object.fromEntries(rosterIds.map((id) => [id, false])),
  ...attendance,
  [kidId]: present,
})

export const tusPaymentFor = (payments, kidId, ym) =>
  payments.find((p) => p.kidId === kidId && p.ym === ym) || {
    kidId, ym, status: 'unpaid', method: null, invoice: false, paidDate: null, note: '', amount: null,
  }

export const tusMonthSummary = (group, classes, kids, payments, ym, nowIso) => {
  const monthClasses = classesInMonth(classes, ym).filter((c) => c.groupId === group.id)
  const roster = kidsOfGroup(kids, group.id)
  const paymentRows = roster.map((k) => tusPaymentFor(payments, k.id, ym))
  const paidCount = paymentRows.filter((payment) => payment.status === 'paid').length
  const dueRows = paymentRows.filter((payment) => payment.status !== 'paid')
  const dueCount = dueRows.length
  return {
    classCount: monthClasses.length,
    heldCount: monthClasses.filter((c) => classHasStarted(c, nowIso)).length,
    attendanceRate: attendanceRate(monthClasses, roster.map((k) => k.id)),
    paidCount,
    dueCount,
    dueAmount: dueRows.reduce((sum, payment) => sum + (payment.amount ?? group.fee), 0),
  }
}

// Cascade for DELETE_TUS_KID: drop the kid's attendance marks and payments.
export const stripKid = (classes, payments, kidId) => ({
  classes: classes.map((c) => {
    if (!(kidId in c.attendance)) return c
    const attendance = { ...c.attendance }
    delete attendance[kidId]
    return { ...c, attendance }
  }),
  payments: payments.filter((p) => p.kidId !== kidId),
})
