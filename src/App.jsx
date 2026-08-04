import { useEffect, useMemo, useState } from 'react'
import { AppProvider, useApp, useToasts } from './store.jsx'
import { Shell } from './layout.jsx'
import { Login } from './views/Login.jsx'
import { ToastHost } from './ui.jsx'
import { setReduceMotion } from './anim.js'
import { APP_MODE } from './app-mode.js'
import { AuthProvider, useAuth } from './auth.jsx'
import { apiClient } from './api.js'
import { DEMO_ROLES } from './data.js'
import {
  createApiWorkspaceRepository,
  createDemoWorkspaceRepository,
} from './workspace-repository.js'
import { createWorkspaceAuthorityKey } from './workspace-provider.js'
import { createWorkspaceApiDependency } from './app-workspace.js'

const demoRepositoryFactory = ({ dispatch, getState }) => (
  createDemoWorkspaceRepository({ dispatch, getState })
)
const workspaceApi = createWorkspaceApiDependency(apiClient)
const apiRepositoryFactory = () => createApiWorkspaceRepository({ api: workspaceApi })

const demoAuthorityKeyFor = (authGeneration) => (state) => {
  const demoRole = DEMO_ROLES.find((role) => role.id === state.demoRoleId) || DEMO_ROLES[0]
  return createWorkspaceAuthorityKey({
    repositoryMode: 'demo',
    dataMode: 'fictional',
    actorId: `demo-${demoRole.id}`,
    actorVersion: 1,
    role: demoRole.id,
    specialistId: demoRole.psychId === null ? null : `sp_demo_${demoRole.psychId}`,
    capabilities: [],
    demoRoleId: demoRole.id,
    demoAuthGeneration: authGeneration,
  })
}

function MotionSync() {
  const { state } = useApp()
  useEffect(() => {
    setReduceMotion(state.prefs.reduceMotion)
  }, [state.prefs.reduceMotion])
  return null
}

function DemoRoot({ authed, onAuthenticatedChange }) {
  const { clearToasts } = useToasts()
  const setAuthenticated = (value) => {
    clearToasts()
    onAuthenticatedChange(value)
  }
  return (
    <>
      <MotionSync />
      {authed ? (
        <Shell key="shell" appMode="demo" onLogout={() => setAuthenticated(false)} />
      ) : (
        <Login key="login" onLogin={() => setAuthenticated(true)} />
      )}
      <ToastHost />
      <div className="grain" aria-hidden="true" />
    </>
  )
}

function DemoApp() {
  const [auth, setAuth] = useState({ authed: false, generation: 0 })
  const authorityKeyForState = useMemo(
    () => demoAuthorityKeyFor(auth.generation),
    [auth.generation]
  )
  const setAuthenticated = (authed) => setAuth((current) => (
    current.authed === authed
      ? current
      : { authed, generation: current.generation + 1 }
  ))
  return (
    <AppProvider
      key={`demo-auth-${auth.generation}`}
      repositoryFactory={demoRepositoryFactory}
      authorityKey={authorityKeyForState}
    >
      <DemoRoot authed={auth.authed} onAuthenticatedChange={setAuthenticated} />
    </AppProvider>
  )
}

const authorityKeyFor = (session) => createWorkspaceAuthorityKey({
  repositoryMode: 'api',
  dataMode: session.dataMode,
  actorId: session.actor.id,
  actorVersion: session.actor.version,
  role: session.actor.role,
  specialistId: session.actor.specialistId,
  capabilities: session.capabilities,
  demoRoleId: null,
  demoAuthGeneration: null,
})

function ProtectedApp() {
  const { logout, session, status } = useAuth()
  const authorityKey = authorityKeyFor(session)
  return (
    <AppProvider
      key={authorityKey}
      repositoryFactory={apiRepositoryFactory}
      authorityKey={authorityKey}
    >
      <MotionSync />
      <Shell
        appMode="app"
        authStatus={status}
        session={session}
        onLogout={logout}
      />
      <ToastHost />
      <div className="grain" aria-hidden="true" />
    </AppProvider>
  )
}

export default function App() {
  return APP_MODE === 'demo'
    ? <DemoApp />
    : (
      <AuthProvider>
        <ProtectedApp />
      </AuthProvider>
    )
}
