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
import {
  createWorkspaceRangeLoadCoordinator,
  finishWorkspaceRangePending,
  startWorkspaceRangePending,
  workspaceLoadRequestKey,
  workspacePendingRangeKeys,
} from './workspace-load-request.js'
import {
  activityWindowRetry,
  activityWindowLoadOutcome,
  clearActivityWindowRejection,
  shouldLoadActivityWindow,
  trackActivityWindowLoad,
} from './activity-load-request.js'
import { activityLoadRequestKey, isActivityWindowLoaded } from './loaded-activities.js'
import { activityMonthRange } from './activity-workspace.js'

const AppCtx = createContext(null)
// toasts live in their own context: every add/expire would otherwise
// recreate the app context value and re-render all of its consumers
const ToastCtx = createContext(null)
const ClientMutationCtx = createContext(Object.freeze({ locked: false }))
const AppointmentMutationCtx = createContext(Object.freeze({ locked: false }))
const PaymentMutationCtx = createContext(Object.freeze({ locked: false }))
const CanonicalAppointmentsCtx = createContext(Object.freeze(Object.create(null)))

let nextId = 10000

const makeId = (prefix) => `${prefix}${nextId++}`

export const allocateDemoClientId = () => makeId('c')

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
      const client = {
        familyId: null,
        familyRole: null,
        ...action.client,
        id: action.client.id || allocateDemoClientId(),
      }
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

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const toastsRef = useRef([])
  const timers = useRef(new Map())

  const publishToasts = useCallback((next) => {
    toastsRef.current = next
    setToasts(next)
  }, [])

  const cancelTimer = useCallback((id) => {
    const timer = timers.current.get(id)
    if (!timer) return
    clearTimeout(timer.expire)
    clearTimeout(timer.remove)
    timers.current.delete(id)
  }, [])
  const clearToasts = useCallback(() => {
    for (const id of [...timers.current.keys()]) cancelTimer(id)
    publishToasts([])
  }, [cancelTimer, publishToasts])

  // Exit motion needs a short overlap, but each toast owns both handles so a
  // replacement, clear, or unmount cannot leave an old timer behind.
  const leave = useCallback((id) => {
    const timer = timers.current.get(id)
    if (!timer || timer.remove) return
    clearTimeout(timer.expire)
    timer.remove = setTimeout(() => {
      timers.current.delete(id)
      publishToasts(toastsRef.current.filter((item) => item.id !== id))
    }, 350)
    publishToasts(toastsRef.current.map((item) => (item.id === id ? { ...item, leaving: true } : item)))
  }, [publishToasts])

  const toast = useCallback((msg, icon = 'check', options) => {
    const id = ++nextId
    const normalizedAction = options?.label && typeof options.onClick === 'function'
      ? {
          label: options.label,
          onClick: options.onClick,
        }
      : null
    const key = typeof options?.key === 'string' && options.key ? options.key : null
    const tone = ['success', 'warning', 'error'].includes(options?.tone)
      ? options.tone
      : icon === 'alert' ? 'warning' : 'success'
    const timeoutMs = normalizedAction || tone !== 'success' ? 8000 : 4000
    if (key) {
      for (const [activeId, timer] of timers.current) {
        if (timer.key === key) cancelTimer(activeId)
      }
    }
    const current = toastsRef.current
    const available = key
      ? current.filter((item) => item.key !== key)
      : current
    const next = [...available.slice(-2), { id, msg, icon, tone, key, action: normalizedAction }]
    const nextIds = new Set(next.map((item) => item.id))
    for (const item of current) {
      if (!nextIds.has(item.id)) cancelTimer(item.id)
    }
    publishToasts(next)
    const expire = setTimeout(() => leave(id), timeoutMs)
    timers.current.set(id, { expire, remove: null, key })
  }, [cancelTimer, leave, publishToasts])

  const dismissToast = useCallback((id) => leave(id), [leave])
  useEffect(() => () => {
    for (const id of [...timers.current.keys()]) cancelTimer(id)
  }, [cancelTimer])
  const toastValue = useMemo(
    () => ({ toasts, dismissToast, clearToasts, toast }),
    [clearToasts, dismissToast, toast, toasts]
  )
  return <ToastCtx.Provider value={toastValue}>{children}</ToastCtx.Provider>
}

export function AppProvider({ children, repositoryFactory, authorityKey }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const stateRef = useRef(state)
  stateRef.current = state
  const { clearToasts, toast } = useToasts()
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
    if (!protectedRecords) clearToasts()
    return () => clearToasts()
  }, [clearToasts, protectedRecords, state.demoRoleId])

  // Windows whose load was rejected, keyed by range. A failed window renders as
  // unavailable (never as endless loading) until the same range is retried.
  const [workspaceFailures, setWorkspaceFailures] = useState(() => new Set())
  useEffect(() => {
    setWorkspaceFailures((current) => (current.size === 0 ? current : new Set()))
  }, [effectiveAuthorityKey])
  const markWorkspaceFailure = useCallback((key) => {
    setWorkspaceFailures((current) => (current.has(key) ? current : new Set([...current, key])))
  }, [])
  const clearWorkspaceFailure = useCallback((key) => {
    setWorkspaceFailures((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }, [])
  const pendingWorkspaceCounts = useRef(new Map())
  const pendingWorkspaceGeneration = useRef(0)
  const workspaceLoadCoordinator = useRef(null)
  if (workspaceLoadCoordinator.current === null) {
    workspaceLoadCoordinator.current = createWorkspaceRangeLoadCoordinator()
  }
  const workspaceRequestAuthority = useRef(effectiveAuthorityKey)
  const [workspacePendingRanges, setWorkspacePendingRanges] = useState(() => new Set())
  const resetWorkspaceRequests = useCallback((authorityKey) => {
    if (workspaceRequestAuthority.current === authorityKey) return
    workspaceRequestAuthority.current = authorityKey
    pendingWorkspaceGeneration.current += 1
    pendingWorkspaceCounts.current = new Map()
    workspaceLoadCoordinator.current.reset()
    setWorkspacePendingRanges((current) => (current.size === 0 ? current : new Set()))
  }, [])
  useEffect(() => {
    resetWorkspaceRequests(effectiveAuthorityKey)
  }, [effectiveAuthorityKey, resetWorkspaceRequests])
  const beginWorkspaceLoad = useCallback((key) => {
    const next = startWorkspaceRangePending(pendingWorkspaceCounts.current, key)
    pendingWorkspaceCounts.current = next
    setWorkspacePendingRanges(workspacePendingRangeKeys(next))
    return pendingWorkspaceGeneration.current
  }, [])
  const endWorkspaceLoad = useCallback((key, generation) => {
    if (generation !== pendingWorkspaceGeneration.current) return
    const next = finishWorkspaceRangePending(pendingWorkspaceCounts.current, key)
    pendingWorkspaceCounts.current = next
    setWorkspacePendingRanges(workspacePendingRangeKeys(next))
  }, [])
  const loadWorkspaceRange = useCallback((range) => {
    resetWorkspaceRequests(effectiveAuthorityKey)
    return workspaceLoadCoordinator.current.load({
      range,
      request: () => workspaceSnapshot.workspace.loadWindow(range),
      onStart: beginWorkspaceLoad,
      onFulfilled: clearWorkspaceFailure,
      onRejected: markWorkspaceFailure,
      onSettled: endWorkspaceLoad,
    })
  }, [
    beginWorkspaceLoad, clearWorkspaceFailure, effectiveAuthorityKey, endWorkspaceLoad,
    markWorkspaceFailure, resetWorkspaceRequests, workspaceSnapshot.workspace,
  ])

  const value = useMemo(
    () => ({
      state: viewState,
      dispatch: authorityDispatch,
      toast,
      workspace: workspaceSnapshot.workspace,
      workspaceFailures,
      workspacePendingRanges,
      loadWorkspaceRange,
      markWorkspaceFailure,
      clearWorkspaceFailure,
    }),
    [
      authorityDispatch, clearWorkspaceFailure, loadWorkspaceRange, markWorkspaceFailure, toast, viewState,
      workspaceFailures, workspacePendingRanges, workspaceSnapshot.workspace,
    ]
  )
  const clientMutationValue = useMemo(
    () => Object.freeze({ locked: workspaceSnapshot.clientMutationLocked }),
    [workspaceSnapshot.clientMutationLocked]
  )
  const appointmentMutationValue = useMemo(
    () => Object.freeze({ locked: workspaceSnapshot.appointmentMutationLocked }),
    [workspaceSnapshot.appointmentMutationLocked]
  )
  const paymentMutationValue = useMemo(
    () => Object.freeze({ locked: workspaceSnapshot.paymentMutationLocked }),
    [workspaceSnapshot.paymentMutationLocked]
  )
  const canonicalAppointments = useMemo(
    () => protectedRecords
      ? workspaceSnapshot.loadedState.appointmentsById
      : Object.freeze(Object.create(null)),
    [protectedRecords, workspaceSnapshot.loadedState.appointmentsById]
  )
  return (
    <ClientMutationCtx.Provider value={clientMutationValue}>
      <AppointmentMutationCtx.Provider value={appointmentMutationValue}>
        <PaymentMutationCtx.Provider value={paymentMutationValue}>
          <CanonicalAppointmentsCtx.Provider value={canonicalAppointments}>
            <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
          </CanonicalAppointmentsCtx.Provider>
        </PaymentMutationCtx.Provider>
      </AppointmentMutationCtx.Provider>
    </ClientMutationCtx.Provider>
  )
}

export const useApp = () => useContext(AppCtx)
export const useToasts = () => useContext(ToastCtx)
export const useClientMutationLock = () => useContext(ClientMutationCtx)
export const useAppointmentMutationLock = () => useContext(AppointmentMutationCtx)
export const usePaymentMutationLock = () => useContext(PaymentMutationCtx)
export const useCanonicalAppointments = () => useContext(CanonicalAppointmentsCtx)

export const useWorkspaceWindow = (range, enabled = true) => {
  const { workspace, workspaceFailures, loadWorkspaceRange } = useApp()
  const requested = useRef(new Set())
  const key = range ? workspaceLoadRequestKey(range) : ''
  const covered = range
    ? isWorkspaceRangeCovered(workspace.loadedRanges, range)
    : false

  useEffect(() => {
    if (covered) {
      requested.current.delete(key)
      return
    }
    if (!enabled || !range || workspace.status === 'read-only-error'
      || requested.current.has(key)) return
    requested.current.add(key)
    // Keep a rejected key claimed until an explicit retry covers it. Clearing
    // it in `finally` lets the retry's failure reset trigger a second automatic
    // request beside the explicit retry.
    loadWorkspaceRange(range).catch(() => {})
  }, [covered, enabled, key, loadWorkspaceRange, range, workspace.status])

  if (!enabled || !range) return 'ready'
  if (!covered && workspaceFailures.has(key)) return 'unavailable'
  return workspaceRangeState(workspace.status, workspace.loadedRanges, range)
}

// Retries one window after a rejected load, lifting the read-only latch that an
// infrastructure error leaves behind. Views pass the range they render.
export const useWorkspaceRetry = () => {
  const { workspace, clearWorkspaceFailure, loadWorkspaceRange } = useApp()
  return useCallback((range) => {
    clearWorkspaceFailure(workspaceLoadRequestKey(range))
    if (workspace.status === 'read-only-error') workspace.recoverFromInfrastructureError()
    const request = loadWorkspaceRange(range)
    // Retry buttons are ordinary onClick handlers, so React does not observe
    // a rejected promise. Keep the rejection available to callers that await
    // it while marking the original promise as handled for ignored clicks.
    request.catch(() => {})
    return request
  }, [clearWorkspaceFailure, loadWorkspaceRange, workspace])
}

// Mutations invalidate no directory rows locally. Callers refresh the same bounded
// canonical window after a successful command instead of applying command DTOs.
export const useWorkspaceRefresh = () => {
  const { loadWorkspaceRange } = useApp()
  return useCallback((range) => loadWorkspaceRange(range), [loadWorkspaceRange])
}

export const useActivityWorkspaceWindow = (range, enabled = true, retryToken = 0) => {
  const { workspace } = useApp()
  const activities = workspace.activities
  const requested = useRef(new Set())
  const rejected = useRef(null)
  const mounted = useRef(false)
  const currentKey = useRef('')
  const lastRetryToken = useRef(retryToken)
  const forcedRequestKey = useRef(null)
  const [rejectedKey, setRejectedKey] = useState(null)
  const key = activities !== null && range
    ? activityLoadRequestKey(activities.state, range)
    : ''
  currentKey.current = key
  const covered = activities !== null && range
    ? isActivityWindowLoaded(activities.state, range)
    : false

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (lastRetryToken.current !== retryToken) {
      lastRetryToken.current = retryToken
      forcedRequestKey.current = key
      const cleared = clearActivityWindowRejection(rejected.current, key)
      if (cleared !== rejected.current) {
        rejected.current = cleared
        setRejectedKey(cleared)
      }
    }
    if (!enabled || activities === null || !range) {
      if (rejected.current !== null) {
        rejected.current = null
        setRejectedKey(null)
      }
      return
    }
    if (!shouldLoadActivityWindow({
      enabled,
      hasActivities: activities !== null,
      hasRange: range !== null && range !== undefined,
      readOnly: activities.status === 'read-only-error',
      covered,
      key,
      rejectedKey: rejected.current,
      requested: requested.current.has(key),
      forceKey: forcedRequestKey.current,
    })) return
    rejected.current = null
    setRejectedKey(null)
    forcedRequestKey.current = null
    trackActivityWindowLoad({
      key,
      requested: requested.current,
      load: () => activities.loadWindow(range),
      onRejected: (failedKey) => {
        if (mounted.current && currentKey.current === failedKey) {
          rejected.current = failedKey
          setRejectedKey(failedKey)
        }
      },
    }).catch(() => {})
  }, [activities, covered, enabled, key, range, rejectedKey, retryToken])

  return activityWindowLoadOutcome({
    enabled,
    hasActivities: activities !== null,
    hasRange: range !== null && range !== undefined,
    readOnly: activities?.status === 'read-only-error',
    covered,
    key,
    rejectedKey,
  })
}

export const useActivityMonth = (month, enabled = true) => {
  const range = useMemo(() => enabled ? activityMonthRange(month) : null, [enabled, month])
  return useActivityWorkspaceWindow(range, enabled)
}

export const useActivityMonthRetry = (month, enabled = true) => {
  const { workspace } = useApp()
  const [retryToken, setRetryToken] = useState(0)
  const range = useMemo(() => enabled ? activityMonthRange(month) : null, [enabled, month])
  const state = useActivityWorkspaceWindow(range, enabled, retryToken)
  const retry = useCallback(() => activityWindowRetry({
    status: workspace.activities?.status,
    range,
    recover: workspace.recoverFromInfrastructureError,
    schedule: () => setRetryToken((value) => value + 1),
  }), [range, workspace])
  return { state, retry }
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
