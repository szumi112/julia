// In-memory app state — no persistence by design (demo).
import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef,
  useState, useSyncExternalStore,
} from 'react'
import { DEMO_ROLES, INITIAL_STATE } from './data.js'
import { monthKey, billableSummary, outstandingOf, paymentPatchFor, toISODate } from './format.js'
import {
  linkTusGuardian, materializeTusGroupMembers, setAttendanceForRoster, stripKid,
  unlinkTusGuardian, updateTusKidAndClients, withTusGroupDefaults,
} from './tus.js'
import { dissolveLoneFamilies, withPsychologistDefaults } from './workspace.js'
import {
  createAuthorityBoundDispatch,
  createWorkspaceProviderController,
} from './workspace-provider.js'
import {
  isWorkspaceRangeCovered,
  projectLoadedWorkspace,
  workspaceRangeState,
} from './workspace-view.js'

const AppCtx = createContext(null)
// toasts live in their own context: every add/expire would otherwise
// recreate the app context value and re-render all of its consumers
const ToastCtx = createContext([])
const ClientMutationCtx = createContext(Object.freeze({ locked: false }))
const AppointmentMutationCtx = createContext(Object.freeze({ locked: false }))

let nextId = 10000

const makeId = (prefix) => `${prefix}${nextId++}`

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
      const psych = withPsychologistDefaults({ ...action.psych, id: `p${nextId++}` })
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
        tusKids: state.tusKids.map((kid) => {
          if (kid.clientId === action.id) {
            return { ...kid, ...(action.patch.name == null ? {} : { name: action.patch.name }) }
          }
          if (kid.guardianClientId === action.id) {
            return {
              ...kid,
              ...(action.patch.name == null ? {} : { parentName: action.patch.name }),
              ...(action.patch.phone == null ? {} : { parentPhone: action.patch.phone }),
            }
          }
          return kid
        }),
      }
    case 'DELETE_CLIENT':
      // removing a client also removes their session history (in-memory demo)
      // and dissolves a family the removal leaves with a single member
      return {
        ...state,
        clients: dissolveLoneFamilies(state.clients.filter((c) => c.id !== action.id)),
        sessions: state.sessions.filter((s) => s.clientId !== action.id),
        tusKids: state.tusKids.map((kid) => ({
          ...kid,
          ...(kid.clientId === action.id ? { clientId: null } : {}),
          ...(kid.guardianClientId === action.id ? { guardianClientId: null } : {}),
        })),
      }
    case 'ADD_POST': {
      const post = { ...action.post, id: `b${nextId++}` }
      return { ...state, posts: [post, ...state.posts] }
    }
    case 'DELETE_POST':
      return { ...state, posts: state.posts.filter((p) => p.id !== action.id) }
    case 'RESTORE_POST': {
      if (state.posts.some((p) => p.id === action.post.id)) return state
      const posts = [...state.posts]
      posts.splice(Math.min(action.index ?? posts.length, posts.length), 0, action.post)
      return { ...state, posts }
    }
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
      const acting = state.clients.find((c) => c.id === action.clientId)
      const other = state.clients.find((c) => c.id === action.otherId)
      // the acting client's family wins, so linking from an existing member
      // grows that family instead of stranding it
      const familyId = acting?.familyId || other?.familyId || `f${nextId++}`
      const clients = dissolveLoneFamilies(state.clients.map((c) =>
          c.id === action.clientId
            ? { ...c, familyId, familyRole: action.role || null }
            : c.id === action.otherId
              ? { ...c, familyId }
              : c
        ))
      const actingRole = action.role || acting?.familyRole
      let childClientId = null
      let guardian = null
      if (actingRole === 'dziecko') [childClientId, guardian] = [acting?.id, other]
      else if (actingRole === 'rodzic') [childClientId, guardian] = [other?.id, acting]
      else if (other?.familyRole === 'dziecko') [childClientId, guardian] = [other.id, acting]
      else if (other?.familyRole === 'rodzic') [childClientId, guardian] = [acting?.id, other]
      else if (state.tusKids.some((kid) => kid.clientId === acting?.id)) [childClientId, guardian] = [acting.id, other]
      else if (state.tusKids.some((kid) => kid.clientId === other?.id)) [childClientId, guardian] = [other.id, acting]
      return {
        ...state,
        clients,
        tusKids: childClientId && guardian
          ? linkTusGuardian(state.tusKids, childClientId, guardian)
          : state.tusKids,
      }
    }
    case 'UNLINK_FAMILY':
      return {
        ...state,
        clients: dissolveLoneFamilies(
          state.clients.map((c) => (c.id === action.clientId ? { ...c, familyId: null, familyRole: null } : c))
        ),
        tusKids: unlinkTusGuardian(state.tusKids, action.clientId),
      }
    case 'ADD_TUS_GROUP': {
      const group = withTusGroupDefaults({ ...action.group, id: makeId('g') })
      if (action.memberKeys == null) return { ...state, tusGroups: [...state.tusGroups, group] }
      const roster = materializeTusGroupMembers({
        clients: state.clients,
        kids: state.tusKids,
        groupId: group.id,
        memberKeys: action.memberKeys,
        newChildren: action.newChildren,
        leaderId: group.leaderIds[0] || null,
        today: toISODate(new Date()),
        makeId,
      })
      return {
        ...state,
        clients: roster.clients,
        tusKids: roster.kids,
        tusGroups: [...state.tusGroups, group],
      }
    }
    case 'UPDATE_TUS_GROUP': {
      const tusGroups = state.tusGroups.map((g) => (g.id === action.id ? { ...g, ...action.patch } : g))
      if (action.memberKeys == null) return { ...state, tusGroups }
      const group = tusGroups.find((candidate) => candidate.id === action.id)
      const roster = materializeTusGroupMembers({
        clients: state.clients,
        kids: state.tusKids,
        groupId: action.id,
        memberKeys: action.memberKeys,
        newChildren: action.newChildren,
        leaderId: group?.leaderIds[0] || null,
        today: toISODate(new Date()),
        makeId,
      })
      return { ...state, clients: roster.clients, tusKids: roster.kids, tusGroups }
    }
    case 'ADD_TUS_KID':
      return { ...state, tusKids: [...state.tusKids, { ...action.kid, id: `k${nextId++}` }] }
    case 'UPDATE_TUS_KID': {
      const linked = updateTusKidAndClients(state.clients, state.tusKids, action.id, action.patch)
      return { ...state, clients: linked.clients, tusKids: linked.kids }
    }
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
    case 'SET_TUS_ATTENDANCE': {
      const cls = state.tusClasses.find((item) => item.id === action.classId)
      const rosterIds = state.tusKids.filter((kid) => kid.groupId === cls?.groupId).map((kid) => kid.id)
      return {
        ...state,
        tusClasses: state.tusClasses.map((c) =>
          c.id === action.classId
            ? { ...c, attendance: setAttendanceForRoster(c.attendance, rosterIds, action.kidId, action.present) }
            : c
        ),
      }
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

export function AppProvider({ children, repositoryFactory, authorityKey }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const stateRef = useRef(state)
  stateRef.current = state
  const [toasts, setToasts] = useState([])
  const clearToasts = useCallback(() => setToasts([]), [])
  const effectiveAuthorityKey = typeof authorityKey === 'function'
    ? authorityKey(state)
    : authorityKey
  const workspaceControllerRef = useRef(null)
  if (workspaceControllerRef.current === null) {
    workspaceControllerRef.current = createWorkspaceProviderController({
      repositoryFactory,
      dispatch,
      getState: () => stateRef.current,
      authorityKey: effectiveAuthorityKey,
      clearToasts,
    })
  }
  const workspaceController = workspaceControllerRef.current
  const authorityDispatch = useMemo(() => createAuthorityBoundDispatch({
    dispatch,
    getState: () => stateRef.current,
    resetAuthority: workspaceController.resetAuthority,
    authorityKeyFor: typeof authorityKey === 'function' ? authorityKey : () => effectiveAuthorityKey,
    demoRoleIds: DEMO_ROLES.map((role) => role.id),
  }), [authorityKey, effectiveAuthorityKey, workspaceController])
  const workspaceSnapshot = useSyncExternalStore(
    workspaceController.subscribe,
    workspaceController.getSnapshot,
    workspaceController.getSnapshot,
  )
  const protectedRecords = useMemo(() => {
    try {
      return JSON.parse(effectiveAuthorityKey)?.[0] === 'api'
    } catch {
      return false
    }
  }, [effectiveAuthorityKey])
  const viewState = useMemo(() => {
    if (!protectedRecords) return state
    const records = projectLoadedWorkspace(workspaceSnapshot.loadedState)
    return {
      ...state,
      ...records,
      posts: [],
      tusGroups: [],
      tusKids: [],
      tusClasses: [],
      tusPayments: [],
    }
  }, [protectedRecords, state, workspaceSnapshot.loadedState])

  // Toast actions can mutate scoped data. A role boundary invalidates both
  // their visible context and their authority, so never carry them across it.
  useEffect(() => {
    clearToasts()
  }, [clearToasts, state.demoRoleId])

  // toasts auto-expire but stay interruptible: a tap marks them leaving so the
  // exit tween can play before removal; rapid actions cap the stack at 3
  const leave = useCallback((id, delay) => {
    const beginLeaving = () => setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
    if (delay > 0) setTimeout(beginLeaving, delay)
    else beginLeaving()
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), delay + 350)
  }, [])

  const toast = useCallback((msg, icon = 'check', action) => {
    const id = ++nextId
    const normalizedAction = action?.label && typeof action.onClick === 'function'
      ? {
          label: action.label,
          onClick: action.onClick,
          timeoutMs: action.timeoutMs,
          key: typeof action.key === 'string' && action.key ? action.key : null,
        }
      : null
    setToasts((t) => {
      const available = normalizedAction?.key
        ? t.filter((item) => item.action?.key !== normalizedAction.key)
        : t
      return [...available.slice(-2), { id, msg, icon, action: normalizedAction }]
    })
    const timeoutMs = Number.isFinite(normalizedAction?.timeoutMs)
      ? Math.max(0, normalizedAction.timeoutMs)
      : 3000
    leave(id, timeoutMs)
  }, [leave])

  const dismissToast = useCallback((id) => leave(id, 0), [leave])

  const value = useMemo(
    () => ({ state: viewState, dispatch: authorityDispatch, toast, workspace: workspaceSnapshot.workspace }),
    [authorityDispatch, toast, viewState, workspaceSnapshot.workspace]
  )
  const toastValue = useMemo(
    () => ({ toasts, dismissToast, clearToasts }),
    [clearToasts, dismissToast, toasts]
  )
  const clientMutationValue = useMemo(
    () => Object.freeze({ locked: workspaceSnapshot.clientMutationLocked }),
    [workspaceSnapshot.clientMutationLocked]
  )
  const appointmentMutationValue = useMemo(
    () => Object.freeze({ locked: workspaceSnapshot.appointmentMutationLocked }),
    [workspaceSnapshot.appointmentMutationLocked]
  )
  return (
    <ClientMutationCtx.Provider value={clientMutationValue}>
      <AppointmentMutationCtx.Provider value={appointmentMutationValue}>
        <AppCtx.Provider value={value}>
          <ToastCtx.Provider value={toastValue}>{children}</ToastCtx.Provider>
        </AppCtx.Provider>
      </AppointmentMutationCtx.Provider>
    </ClientMutationCtx.Provider>
  )
}

export const useApp = () => useContext(AppCtx)
export const useToasts = () => useContext(ToastCtx)
export const useClientMutationLock = () => useContext(ClientMutationCtx)
export const useAppointmentMutationLock = () => useContext(AppointmentMutationCtx)

export const useWorkspaceWindow = (range, enabled = true) => {
  const { workspace } = useApp()
  const requested = useRef(new Set())
  const key = range ? `${range.from}|${range.to}` : ''
  const covered = range
    ? isWorkspaceRangeCovered(workspace.loadedRanges, range)
    : false

  useEffect(() => {
    if (!enabled || !range || covered || workspace.status === 'read-only-error'
      || requested.current.has(key)) return
    requested.current.add(key)
    Promise.resolve(workspace.loadWindow(range)).catch(() => {})
  }, [covered, enabled, key, range, workspace])

  if (!enabled || !range) return 'ready'
  return workspaceRangeState(workspace.status, workspace.loadedRanges, range)
}

// Mutations invalidate no directory rows locally. Callers refresh the same bounded
// canonical window after a successful command instead of applying command DTOs.
export const useWorkspaceRefresh = () => {
  const { workspace } = useApp()
  return useCallback((range) => workspace.loadWindow(range), [workspace])
}

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
