import { useEffect, useState } from 'react'
import { AppProvider, useApp, useToasts } from './store.jsx'
import { Shell } from './layout.jsx'
import { Login } from './views/Login.jsx'
import { ToastHost } from './ui.jsx'
import { setReduceMotion } from './anim.js'
import { APP_MODE } from './app-mode.js'
import { AuthProvider, useAuth } from './auth.jsx'

function MotionSync() {
  const { state } = useApp()
  useEffect(() => {
    setReduceMotion(state.prefs.reduceMotion)
  }, [state.prefs.reduceMotion])
  return null
}

function DemoRoot() {
  const [authed, setAuthed] = useState(false)
  const { clearToasts } = useToasts()
  const setAuthenticated = (value) => {
    clearToasts()
    setAuthed(value)
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
  return (
    <AppProvider>
      <DemoRoot />
    </AppProvider>
  )
}

const authorityKeyFor = (session) => JSON.stringify([
  session.actor.id,
  session.actor.role,
  session.actor.specialistId,
  [...session.capabilities].sort(),
  session.dataMode,
])

function ProtectedApp() {
  const { logout, session, status } = useAuth()
  return (
    <AppProvider key={authorityKeyFor(session)}>
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
