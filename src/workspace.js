import { DEMO_ROLES } from './data.js'
import { isBillable, monthKey, outstandingOf, timeToMin, toISODate } from './format.js'

export const roleById = (id) => DEMO_ROLES.find((role) => role.id === id) || DEMO_ROLES[0]

export const sessionsForRole = (state, role) =>
  role.scope === 'own' ? state.sessions.filter((session) => session.psychId === role.psychId) : state.sessions

export const dayAttention = (state, role, date) => {
  const scoped = sessionsForRole(state, role)
  return scoped
    .filter((session) => session.date <= date && outstandingOf(session) > 0)
    .map((session) => ({ kind: 'payment', sessionId: session.id, amount: outstandingOf(session) }))
    .sort((a, b) => b.amount - a.amount)
}

export const todayWorkspace = (state, role, now) => {
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
    attention: dayAttention(state, role, today).slice(0, 3),
    summary,
  }
}
