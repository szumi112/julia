// In-memory app state — no persistence by design (demo).
import { createContext, useContext, useMemo, useReducer, useState, useCallback } from 'react'
import { DEMO_ROLES, INITIAL_STATE } from './data.js'
import { monthKey, billableSummary, outstandingOf, paymentPatchFor } from './format.js'
import { stripKid } from './tus.js'

const AppCtx = createContext(null)
// toasts live in their own context: every add/expire would otherwise
// recreate the app context value and re-render all of its consumers
const ToastCtx = createContext([])

let nextId = 10000

const sortClasses = (list) => [...list].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))

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
          .map((s) => {
            if (s.id !== action.id) return s
            const session = { ...s, ...action.patch }
            if (session.payment === 'unpaid') session.method = null
            return { ...session, ...paymentPatchFor(session.payment, session.amount, session.paidAmount) }
          })
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
      const client = { familyId: null, familyRole: null, ...action.client, id: `c${nextId++}` }
      if (!action.familyLink) return { ...state, clients: [...state.clients, client] }
      const other = state.clients.find((c) => c.id === action.familyLink.otherId)
      const familyId = other?.familyId || `f${nextId++}`
      client.familyId = familyId
      client.familyRole = action.familyLink.role || null
      return {
        ...state,
        clients: [...state.clients.map((c) => (c.id === other?.id ? { ...c, familyId } : c)), client],
      }
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
    case 'SET_DEMO_ROLE':
      return DEMO_ROLES.some((role) => role.id === action.roleId)
        ? { ...state, demoRoleId: action.roleId }
        : state
    case 'SET_PREF':
      return { ...state, prefs: { ...state.prefs, [action.key]: action.value } }
    case 'LINK_FAMILY': {
      const other = state.clients.find((c) => c.id === action.otherId)
      const familyId = other?.familyId || `f${nextId++}`
      return {
        ...state,
        clients: state.clients.map((c) =>
          c.id === action.clientId
            ? { ...c, familyId, familyRole: action.role || null }
            : c.id === action.otherId
              ? { ...c, familyId }
              : c
        ),
      }
    }
    case 'UNLINK_FAMILY':
      return {
        ...state,
        clients: state.clients.map((c) => (c.id === action.clientId ? { ...c, familyId: null, familyRole: null } : c)),
      }
    case 'ADD_TUS_GROUP':
      return { ...state, tusGroups: [...state.tusGroups, { ...action.group, id: `g${nextId++}` }] }
    case 'UPDATE_TUS_GROUP':
      return { ...state, tusGroups: state.tusGroups.map((g) => (g.id === action.id ? { ...g, ...action.patch } : g)) }
    case 'ADD_TUS_KID':
      return { ...state, tusKids: [...state.tusKids, { ...action.kid, id: `k${nextId++}` }] }
    case 'UPDATE_TUS_KID':
      return { ...state, tusKids: state.tusKids.map((k) => (k.id === action.id ? { ...k, ...action.patch } : k)) }
    case 'DELETE_TUS_KID': {
      // removing a kid also clears their attendance marks and fee history
      const { classes, payments } = stripKid(state.tusClasses, state.tusPayments, action.id)
      return {
        ...state,
        tusKids: state.tusKids.filter((k) => k.id !== action.id),
        tusClasses: classes,
        tusPayments: payments,
      }
    }
    case 'ADD_TUS_CLASS':
      return { ...state, tusClasses: sortClasses([...state.tusClasses, { ...action.cls, id: `tc${nextId++}` }]) }
    case 'UPDATE_TUS_CLASS':
      return { ...state, tusClasses: sortClasses(state.tusClasses.map((c) => (c.id === action.id ? { ...c, ...action.patch } : c))) }
    case 'DELETE_TUS_CLASS':
      return { ...state, tusClasses: state.tusClasses.filter((c) => c.id !== action.id) }
    case 'SET_TUS_ATTENDANCE':
      return {
        ...state,
        tusClasses: state.tusClasses.map((c) =>
          c.id === action.classId ? { ...c, attendance: { ...c.attendance, [action.kidId]: action.present } } : c
        ),
      }
    case 'UPSERT_TUS_PAYMENT': {
      const existing = state.tusPayments.find((p) => p.kidId === action.kidId && p.ym === action.ym)
      if (existing) {
        return { ...state, tusPayments: state.tusPayments.map((p) => (p === existing ? { ...p, ...action.patch } : p)) }
      }
      const kid = state.tusKids.find((k) => k.id === action.kidId)
      const group = state.tusGroups.find((g) => g.id === kid?.groupId)
      return {
        ...state,
        tusPayments: [
          ...state.tusPayments,
          {
            id: `tp${nextId++}`, kidId: action.kidId, ym: action.ym, amount: group?.fee ?? 0,
            status: 'unpaid', method: null, invoice: false, paidDate: null, note: '',
            ...action.patch,
          },
        ],
      }
    }
    default:
      return state
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const [toasts, setToasts] = useState([])

  // toasts auto-expire but stay interruptible: a tap marks them leaving so the
  // exit tween can play before removal; rapid actions cap the stack at 3
  const leave = useCallback((id, delay) => {
    setTimeout(() => setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x))), delay)
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), delay + 350)
  }, [])

  const toast = useCallback((msg, icon = 'check') => {
    const id = ++nextId
    setToasts((t) => [...t.slice(-2), { id, msg, icon }])
    leave(id, 3000)
  }, [leave])

  const dismissToast = useCallback((id) => leave(id, 0), [leave])

  const value = useMemo(
    () => ({ state, dispatch, toast }),
    [state, toast]
  )
  const toastValue = useMemo(() => ({ toasts, dismissToast }), [toasts, dismissToast])
  return (
    <AppCtx.Provider value={value}>
      <ToastCtx.Provider value={toastValue}>{children}</ToastCtx.Provider>
    </AppCtx.Provider>
  )
}

export const useApp = () => useContext(AppCtx)
export const useToasts = () => useContext(ToastCtx)

// ---------- selectors ----------

export const sessionsInMonth = (sessions, ym) => sessions.filter((s) => monthKey(s.date) === ym)

export const monthStats = (sessions, ym) => {
  const list = sessionsInMonth(sessions, ym)
  const completed = list.filter((s) => s.status === 'completed')
  return {
    count: list.length,
    completed: completed.length,
    hours: completed.reduce((a, s) => a + s.duration, 0) / 60,
    ...billableSummary(list),
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
