import { DEMO_ROLES } from './data.js'
import { collectedOf, fmtDayMonth, fmtMoney, isBillable, METHOD_LABELS, monthKey, outstandingOf, timeToMin, toISODate, warsawDateTimeFromUtc } from './format.js'
import { DEFAULT_SPECIALIST_AVATAR_KEY } from './specialist-avatars.js'

const assignmentStartCivilTime = (startsAt) => {
  try {
    return warsawDateTimeFromUtc(startsAt)
  } catch {
    return null
  }
}

export const sessionHasStarted = (session, now = new Date()) => {
  const current = warsawDateTimeFromUtc(now.toISOString())
  return `${session.date}T${session.time}:00` <= `${current.date}T${current.time}:${current.second}`
}

export const isBeforeAssignmentStart = (date, time, startsAt) => {
  const assignment = assignmentStartCivilTime(startsAt)
  return !!assignment && `${date}T${time}:00` < `${assignment.date}T${assignment.time}:${assignment.second}`
}

export const assignmentStartLabel = (startsAt) => {
  const assignment = assignmentStartCivilTime(startsAt)
  return assignment ? `${fmtDayMonth(assignment.date)} o ${assignment.time}` : ''
}

export const withPsychologistDefaults = (psychologist) => ({
  ...psychologist,
  weeklyCapacity: psychologist.weeklyCapacity ?? 20,
  avatarKey: psychologist.avatarKey ?? DEFAULT_SPECIALIST_AVATAR_KEY,
})

export const specialistWeekLoad = (sessions, psychologist, date = new Date()) => {
  const monday = new Date(date)
  monday.setHours(12, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const sunday = new Date(monday)
  sunday.setDate(sunday.getDate() + 6)
  const start = toISODate(monday)
  const end = toISODate(sunday)
  const capacity = withPsychologistDefaults(psychologist).weeklyCapacity
  const booked = sessions.filter((session) => (
    session.psychId === psychologist.id
    && session.status !== 'cancelled'
    && session.date >= start
    && session.date <= end
  )).length
  const remaining = capacity - booked
  return {
    start,
    end,
    booked,
    capacity,
    remaining,
    status: remaining > 0 ? 'available' : remaining === 0 ? 'full' : 'over',
  }
}

export const normalizeSearchText = (value) =>
  String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')

const compareCodeUnits = (left, right) => left < right ? -1 : left > right ? 1 : 0

export const compareCalendarSessionOrder = (left, right) => (
  compareCodeUnits(left.time, right.time) || compareCodeUnits(left.id, right.id)
)

export const clientMatchesQuery = (client, query) => {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return true
  return [client.name, client.email, client.phone]
    .some((value) => normalizeSearchText(value).includes(normalizedQuery))
}

export const dayStatusSummary = (sessions, date, nowMinutes) => {
  const summary = {
    total: 0,
    completed: 0,
    noshow: 0,
    scheduled: 0,
    unresolvedPast: 0,
    current: 0,
    future: 0,
  }

  for (const session of sessions) {
    if (session.date !== date || session.status === 'cancelled') continue
    summary.total++
    if (session.status === 'completed') summary.completed++
    if (session.status === 'noshow') summary.noshow++
    if (session.status !== 'scheduled') continue

    summary.scheduled++
    const start = timeToMin(session.time)
    const end = start + (session.duration ?? 50)
    if (nowMinutes < start) summary.future++
    else if (nowMinutes < end) summary.current++
    else summary.unresolvedPast++
  }

  return summary
}

export const sessionConflicts = (sessions, { date } = {}) => {
  const sessionsBySpecialistDay = new Map()
  for (const session of sessions) {
    if (session.status === 'cancelled' || !session.psychId || (date && session.date !== date)) continue
    const key = `${session.date}\u0000${session.psychId}`
    const group = sessionsBySpecialistDay.get(key) || []
    group.push(session)
    sessionsBySpecialistDay.set(key, group)
  }

  const conflicts = []
  for (const group of sessionsBySpecialistDay.values()) {
    group.sort((a, b) => timeToMin(a.time) - timeToMin(b.time) || a.id.localeCompare(b.id))
    for (let i = 0; i < group.length; i++) {
      const first = group[i]
      const firstStart = timeToMin(first.time)
      const firstEnd = firstStart + (first.duration ?? 50)
      for (let j = i + 1; j < group.length; j++) {
        const second = group[j]
        const secondStart = timeToMin(second.time)
        if (secondStart >= firstEnd) break
        const secondEnd = secondStart + (second.duration ?? 50)
        if (firstStart >= secondEnd) continue
        conflicts.push({
          date: first.date,
          psychId: first.psychId,
          sessionIds: [first.id, second.id].sort((a, b) => a.localeCompare(b)),
          firstStart,
          secondStart,
        })
      }
    }
  }

  return conflicts
    .sort((a, b) =>
      a.date.localeCompare(b.date)
      || a.firstStart - b.firstStart
      || a.secondStart - b.secondStart
      || a.sessionIds[0].localeCompare(b.sessionIds[0])
      || a.sessionIds[1].localeCompare(b.sessionIds[1])
      || a.psychId.localeCompare(b.psychId)
    )
    .map(({ date: conflictDate, psychId, sessionIds }) => ({ date: conflictDate, psychId, sessionIds }))
}

// One entry per overlapping block (e.g. three sessions at 14:00) instead of one
// per overlapping pair; sessionIds keep sessionConflicts' order of appearance.
export const sessionConflictGroups = (sessions, options) => {
  const groups = []
  const groupOf = new Map()
  for (const conflict of sessionConflicts(sessions, options)) {
    const [target, ...others] = [...new Set(conflict.sessionIds.map((id) => groupOf.get(id)).filter(Boolean))]
    const group = target || { date: conflict.date, psychId: conflict.psychId, sessionIds: [] }
    if (!target) groups.push(group)
    for (const other of others) {
      groups.splice(groups.indexOf(other), 1)
      group.sessionIds.push(...other.sessionIds)
    }
    for (const id of conflict.sessionIds) {
      if (!group.sessionIds.includes(id)) group.sessionIds.push(id)
    }
    for (const id of group.sessionIds) groupOf.set(id, group)
  }
  return groups
}

export const scopedBillingSummary = (sessions, { psychId = null } = {}) => {
  const summary = { due: 0, collected: 0, outstanding: 0 }
  for (const session of sessions) {
    if ((psychId !== null && session.psychId !== psychId) || !isBillable(session)) continue
    summary.due += session.amount
    summary.collected += collectedOf(session)
    summary.outstanding += outstandingOf(session)
  }
  return summary
}

export const paymentSnapshotOf = (session) => ({
  payment: session.payment,
  paidAmount: session.paidAmount ?? 0,
  method: session.method ?? null,
  paidDate: session.paidDate ?? null,
})

export const PAYMENT_AMOUNT_COPY = 'Wpisz kwotę, np. 180 albo 180,50.'
export const paymentOverRemainderCopy = (remainderCents) =>
  `Do zapłaty zostało ${fmtMoney(remainderCents / 100)} - wpisz tyle albo mniej.`

export const paymentEntryFor = (session, { amount, method, paidDate }) => {
  const typed = String(amount ?? '').trim()
  const entryAmount = /^\d+(?:[.,]\d{1,2})?$/.test(typed) ? Number(typed.replace(',', '.')) : NaN
  const entryCents = Math.round(entryAmount * 100)
  const remainderCents = Math.round(outstandingOf(session) * 100)
  const errors = {}
  if (!Number.isFinite(entryAmount) || entryAmount <= 0 || entryCents <= 0) {
    errors.amount = PAYMENT_AMOUNT_COPY
  } else if (entryCents > remainderCents) {
    errors.amount = paymentOverRemainderCopy(remainderCents)
  }
  if (!Object.hasOwn(METHOD_LABELS, method)) errors.method = 'Wybierz formę płatności'
  if (Object.keys(errors).length > 0) return { errors, patch: null }

  const totalCents = Math.round(Number(session.amount) * 100)
  const paidCents = Math.round((Number(session.paidAmount) || 0) * 100) + entryCents
  return {
    errors,
    patch: {
      payment: paidCents === totalCents ? 'paid' : 'partial',
      paidAmount: paidCents / 100,
      method,
      paidDate,
    },
  }
}

export const roleById = (id) => DEMO_ROLES.find((role) => role.id === id) || DEMO_ROLES[0]

export const sessionsForRole = (state, role) =>
  role.scope === 'own' ? state.sessions.filter((session) => session.psychId === role.psychId) : state.sessions

export const clientsForRole = (state, role) =>
  role.scope === 'own' ? state.clients.filter((client) => client.psychId === role.psychId) : state.clients

// Appointment mutations in the Worker accept only the current, writable
// directory records. Historical and archived records can still appear next to
// old sessions, but must never become a new appointment target.
export const isBookableClient = (client) => !!client
  && ['active', 'paused'].includes(client.status)
  && client.archivedAt == null
  && client.readOnly !== true

export const bookableClientsForRole = (state, role) => clientsForRole(state, role)
  .filter(isBookableClient)

const polishClientNameOrder = new Intl.Collator('pl', { sensitivity: 'base' })

// Session forms show a scoped, searchable directory instead of a browser
// select. Keep its order deterministic even when a workspace response arrives
// in a different order.
export const sessionClientOptions = (clients) => [...clients].sort((left, right) => (
  polishClientNameOrder.compare(left.name, right.name) || left.id.localeCompare(right.id)
))

export const filterSessionClientOptions = (clients, query) => clients.filter(
  (client) => clientMatchesQuery(client, query),
)

// A family needs at least two members — after an unlink, delete, or move,
// clear the link fields on anyone left alone so no dangling familyId survives.
export const dissolveLoneFamilies = (clients) => {
  const sizes = {}
  for (const client of clients) {
    if (client.familyId) sizes[client.familyId] = (sizes[client.familyId] || 0) + 1
  }
  return clients.map((client) =>
    client.familyId && sizes[client.familyId] < 2 ? { ...client, familyId: null, familyRole: null } : client
  )
}

export const sessionMatchesFilters = (session, filters) => {
  const paymentMatches = filters.payment === 'all' || session.payment === filters.payment
  const attendanceMatches = filters.attendance === 'all' || session.status === filters.attendance
  const specialistMatches = !filters.specialist || session.psychId === filters.specialist
  return paymentMatches && attendanceMatches && specialistMatches
}

export const latestSessionForClient = (sessions, clientId) => sessions
  .filter((session) => session.clientId === clientId && session.status !== 'cancelled')
  .toSorted((left, right) => (
    right.date.localeCompare(left.date)
    || right.time.localeCompare(left.time)
    || right.id.localeCompare(left.id)
  ))[0] || null

export const sessionSpecialistId = ({
  availablePsychologists,
  ownPsychId = null,
  preferredPsychId = null,
  latestPsychId = null,
  clientPsychId = null,
  currentPsychId = null,
}) => {
  const availableIds = new Set(availablePsychologists.map((psychologist) => psychologist.id))
  if (ownPsychId && availableIds.has(ownPsychId)) return ownPsychId
  return [preferredPsychId, latestPsychId, clientPsychId, currentPsychId]
    .find((id) => availableIds.has(id)) || ''
}

export const occupiedSessionsForSpecialistDay = (sessions, {
  psychId, date, excludeId = null,
} = {}) => sessions
  .filter((session) => (
    session.psychId === psychId
    && session.date === date
    && session.id !== excludeId
    && session.status !== 'cancelled'
  ))
  .toSorted(compareCalendarSessionOrder)

const timeFromMinutes = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

export const occupiedTimeLabels = (sessions) => {
  const labels = new Set()
  for (const session of sessions) {
    labels.add(`${session.time}-${timeFromMinutes(timeToMin(session.time) + (session.duration ?? 50))}`)
  }
  return [...labels]
}

export const suggestedSessionTime = (sessions, options = {}) => {
  const occupied = occupiedSessionsForSpecialistDay(sessions, options)
  if (occupied.length === 0) return null
  const end = Math.max(...occupied.map((session) => timeToMin(session.time) + (session.duration ?? 50)))
  return end < 24 * 60 ? timeFromMinutes(end) : null
}

export const dayAttention = (state, role, date) => {
  const scoped = sessionsForRole(state, role)
  return scoped
    .filter((session) => session.date <= date && outstandingOf(session) > 0)
    .map((session) => ({ kind: 'payment', sessionId: session.id, amount: outstandingOf(session) }))
    .sort((a, b) => b.amount - a.amount)
}

export const todayWorkspace = (state, role, now, outstandingRange = null) => {
  const today = toISODate(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const scoped = sessionsForRole(state, role)
  const schedule = scoped
    .filter((session) => session.date === today && session.status !== 'cancelled')
    .toSorted((a, b) => timeToMin(a.time) - timeToMin(b.time) || a.id.localeCompare(b.id))
  const scheduled = schedule.filter((session) => session.status === 'scheduled')
  const current = scheduled.find((session) => {
    const start = timeToMin(session.time)
    return start <= nowMin && nowMin < start + (session.duration || 50)
  }) || null
  const next = scheduled.find((session) => timeToMin(session.time) > nowMin) || null
  const summary = role.id === 'owner'
    ? {
        completedToday: {
          scope: 'today',
          value: schedule.filter((session) => session.status === 'completed').length,
        },
        revenueMonth: {
          scope: 'month',
          value: state.sessions
            .filter((session) => monthKey(session.date) === monthKey(today) && isBillable(session))
            .reduce((sum, session) => sum + session.amount, 0),
        },
        outstandingAllTime: {
          scope: 'all-time',
          value: state.sessions.reduce((sum, session) => sum + outstandingOf(session), 0),
        },
      }
    : null

  return {
    current,
    next,
    schedule,
    daySummary: dayStatusSummary(schedule, today, nowMin),
    attention: dayAttention(state, role, today).slice(0, 3),
    outstanding: scoped
      .filter((session) => !outstandingRange || (
        session.date >= outstandingRange.from && session.date <= outstandingRange.to
      ))
      .reduce((sum, session) => sum + outstandingOf(session), 0),
    summary,
  }
}
