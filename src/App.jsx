import { useEffect, useState } from 'react'
import { AppProvider, useApp } from './store.jsx'
import { Shell } from './layout.jsx'
import { Login } from './views/Login.jsx'
import { ToastHost } from './ui.jsx'
import { setReduceMotion } from './anim.js'

function MotionSync() {
  const { state } = useApp()
  useEffect(() => {
    setReduceMotion(state.prefs.reduceMotion)
  }, [state.prefs.reduceMotion])
  return null
}

function Root() {
  const [authed, setAuthed] = useState(false)
  return (
    <>
      <MotionSync />
      {authed ? (
        <Shell key="shell" onLogout={() => setAuthed(false)} />
      ) : (
        <Login key="login" onLogin={() => setAuthed(true)} />
      )}
      <ToastHost />
      <div className="grain" aria-hidden="true" />
    </>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  )
}
