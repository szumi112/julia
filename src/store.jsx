// In-memory app state — no persistence by design (demo).
import { createContext, useContext, useMemo, useReducer, useState, useCallback } from 'react'
import { INITIAL_STATE } from './data.js'
import { monthKey, isBillable, collectedOf, outstandingOf } from './format.js'

const AppCtx = createContext(null)

let nextId = 10000

function reducer(state, action) {
  switch (action.type) {
    case 'ADD_SESSION': {
      const session = { ...action.session, id: `s${nextId++}` }
      return { ...state, sessions: [...state.sessions, session].sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1)) }
    }
    case 'UPDATE_SESSION':
      return {
        ...state,
        sessions: state.sessions
          .map((s) => (s.id === action.id ? { ...s, ...action.patch } : s))
          .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1)),
      }
    case 'DELETE_SESSION':
      return { ...state, sessions: state.sessions.filter((s) => s.id !== action.id) }
    case 'ADD_PSYCH': {
      const psych = { ...action.psych, id: `p${nextId++}` }
      return { ...state, psychologists: [...state.psychologists, psych] }
    }
    case 'UPDATE_PSYCH':
      return {
        ...state,
        psychologists: state.psychologists.map((p) => (p.id === action.id ? { ...p, ...action.patch } : p)),
      }
    case 'DELETE_PSYCH':
      // guarded in the UI: only allowed when no assigned clients / upcoming sessions
      return { ...state, psychologists: state.psychologists.filter((p) => p.id !== action.id) }
    case 'ADD_CLIENT': {
      const client = { ...action.client, id: `c${nextId++}` }
      return { ...state, clients: [...state.clients, client] }
    }
    case 'UPDATE_CLIENT':
      return {
        ...state,
        clients: state.clients.map((c) => (c.id === action.id ? { ...c, ...action.patch } : c)),
      }
    case 'DELETE_CLIENT':
      // removing a client also removes their session history (in-memory demo)
      return {
        ...state,
        clients: state.clients.filter((c) => c.id !== action.id),
        sessions: state.sessions.filter((s) => s.clientId !== action.id),
      }
    case 'ADD_POST': {
      const post = { ...action.post, id: `b${nextId++}` }
      return { ...state, posts: [post, ...state.posts] }
    }
    case 'DELETE_POST':
      return { ...state, posts: state.posts.filter((p) => p.id !== action.id) }
    case 'UPDATE_CENTER':
      return { ...state, center: { ...state.center, ...action.patch } }
    case 'UPDATE_USER':
      return { ...state, user: { ...state.user, ...action.patch } }
    case 'SET_PREF':
      return { ...state, prefs: { ...state.prefs, [action.key]: action.value } }
    default:
      return state
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const [toasts, setToasts] = useState([])

  const toast = useCallback((msg, icon = 'check') => {
    const id = ++nextId
    setToasts((t) => [...t, { id, msg, icon }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])

  const value = useMemo(
    () => ({ state, dispatch, toast, toasts }),
    [state, toast, toasts]
  )
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
}

export const useApp = () => useContext(AppCtx)

// ---------- selectors ----------

export const sessionsInMonth = (sessions, ym) => sessions.filter((s) => monthKey(s.date) === ym)

export const monthStats = (sessions, ym) => {
  const list = sessionsInMonth(sessions, ym)
  const billed = list.filter(isBillable)
  const completed = list.filter((s) => s.status === 'completed')
  const revenue = billed.reduce((a, s) => a + s.amount, 0)
  const collected = billed.reduce((a, s) => a + collectedOf(s), 0)
  return {
    count: list.length,
    completed: completed.length,
    hours: completed.reduce((a, s) => a + s.duration, 0) / 60,
    revenue,
    collected,
    outstanding: revenue - collected,
  }
}

export const totalOutstanding = (sessions) => sessions.reduce((a, s) => a + outstandingOf(s), 0)

export const upcomingSessions = (sessions, n = 6) => {
  const now = new Date()
  const today = monthKey(now) + '-' + String(now.getDate()).padStart(2, '0')
  const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return sessions
    .filter((s) => s.status === 'scheduled' && (s.date > today || (s.date === today && s.time >= nowTime)))
    .slice(0, n)
}

export const availableMonths = (sessions) => {
  const set = new Set(sessions.map((s) => monthKey(s.date)))
  return [...set].sort()
}

export const clientOutstanding = (sessions, clientId) =>
  sessions.filter((s) => s.clientId === clientId).reduce((a, s) => a + outstandingOf(s), 0)

export const lastSessionOf = (sessions, clientId) => {
  const past = sessions.filter((s) => s.clientId === clientId && s.status === 'completed')
  return past.length ? past[past.length - 1] : null
}

// revenue per month for the income chart (last n months)
export const revenueSeries = (sessions, months) =>
  months.map((ym) => ({ ym, ...monthStats(sessions, ym) }))
