import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, apiClient } from './api.js'
import { APP_MODE } from './app-mode.js'

const AuthCtx = createContext(null)
const DENIED_CODES = new Set(['ACCESS_DENIED', 'FORBIDDEN'])
const REAUTH_CODES = new Set(['ACCESS_ASSERTION_INVALID', 'REAUTH_REQUIRED'])
const EMPTY_CAPABILITIES = Object.freeze([])
const REFRESH_LEAD_MS = 60_000
const REFRESH_MIN_DELAY_MS = 5_000
const REFRESH_MAX_DELAY_MS = 5 * 60_000

const authStateFor = (error) => {
  if (!(error instanceof ApiError)
    || (error.status !== 401 && error.status !== 403)) return 'unavailable'
  if (REAUTH_CODES.has(error.code)) return 'reauth'
  return DENIED_CODES.has(error.code) ? 'denied' : 'unavailable'
}

function AuthScreen({ state, onLogout, onRetry }) {
  const title = state === 'loading'
    ? 'Sprawdzanie dostępu'
    : state === 'denied'
      ? 'Brak dostępu do panelu'
      : state === 'reauth'
        ? 'Sesja wygasła'
        : 'Nie udało się połączyć z panelem'

  return (
    <main className={`auth-screen auth-screen--${state}`} aria-labelledby="auth-screen-title">
      <p className="auth-screen__brand" translate="no">Bear with me</p>
      <h1 id="auth-screen-title">{title}</h1>
      {state === 'loading' && (
        <p className="auth-screen__message" role="status">Trwa bezpieczne łączenie z panelem.</p>
      )}
      {state === 'denied' && (
        <>
          <p className="auth-screen__message">To konto nie ma aktywnego dostępu do panelu personelu.</p>
          <button type="button" className="btn btn--ghost" onClick={onLogout}>Wyloguj się</button>
        </>
      )}
      {state === 'reauth' && (
        <>
          <p className="auth-screen__message">Sesja logowania wygasła. Zaloguj się ponownie, aby wrócić do panelu.</p>
          <button type="button" className="btn btn--primary" onClick={onLogout}>Zaloguj się ponownie</button>
        </>
      )}
      {state === 'unavailable' && (
        <>
          <p className="auth-screen__message">Sprawdź połączenie i spróbuj ponownie.</p>
          <button type="button" className="btn btn--primary" onClick={onRetry}>Spróbuj ponownie</button>
        </>
      )}
    </main>
  )
}

export function AuthProvider({ children, client = apiClient }) {
  const [auth, setAuth] = useState({ status: 'loading', session: null })
  const mountedRef = useRef(false)
  const bootstrapStartedRef = useRef(false)
  const loggingOutRef = useRef(false)
  const requestRef = useRef(0)

  const requestSession = useCallback(async (status) => {
    const requestId = ++requestRef.current
    setAuth((current) => ({
      status,
      session: status === 'refreshing' ? current.session : null,
    }))
    try {
      await client.getSession()
    } catch (error) {
      if (!mountedRef.current || requestRef.current !== requestId) return
      const nextStatus = authStateFor(error)
      if (nextStatus === 'denied' && error instanceof ApiError && error.code === 'FORBIDDEN') {
        client.clearSession()
      }
      setAuth({ status: nextStatus, session: null })
    }
  }, [client])

  useEffect(() => {
    mountedRef.current = true
    const unsubscribe = client.subscribeSession((session, reason) => {
      if (!mountedRef.current) return
      requestRef.current += 1
      if (loggingOutRef.current) return
      setAuth(session
        ? { status: 'authenticated', session }
        : { status: reason === 'reauth' ? 'reauth' : 'denied', session: null })
    })
    if (!bootstrapStartedRef.current) {
      bootstrapStartedRef.current = true
      void requestSession('loading')
    }
    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [client, requestSession])

  const retry = useCallback(() => {
    void requestSession('loading')
  }, [requestSession])
  const refresh = useCallback(() => requestSession('refreshing'), [requestSession])
  useEffect(() => {
    if (auth.status !== 'authenticated' || !auth.session) return undefined
    const expiresAt = Date.parse(auth.session.csrfExpiresAt)
    const untilRefresh = Number.isFinite(expiresAt)
      ? expiresAt - Date.now() - REFRESH_LEAD_MS
      : REFRESH_MIN_DELAY_MS
    const delay = Math.max(
      REFRESH_MIN_DELAY_MS,
      Math.min(REFRESH_MAX_DELAY_MS, untilRefresh),
    )
    const timer = window.setTimeout(() => {
      void refresh()
    }, delay)
    return () => window.clearTimeout(timer)
  }, [auth.session, auth.status, refresh])
  useEffect(() => {
    if (auth.status !== 'authenticated') return undefined
    const refreshVisibleAuthority = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', refreshVisibleAuthority)
    document.addEventListener('visibilitychange', refreshVisibleAuthority)
    return () => {
      window.removeEventListener('focus', refreshVisibleAuthority)
      document.removeEventListener('visibilitychange', refreshVisibleAuthority)
    }
  }, [auth.status, refresh])
  useEffect(() => {
    if (!import.meta.env.DEV || APP_MODE !== 'app') return undefined
    const onTestRefresh = () => {
      void refresh()
    }
    window.addEventListener('bwm:test-auth-refresh', onTestRefresh)
    return () => window.removeEventListener('bwm:test-auth-refresh', onTestRefresh)
  }, [refresh])
  const logout = useCallback(() => {
    loggingOutRef.current = true
    client.clearSession()
    window.location.assign('/cdn-cgi/access/logout')
  }, [client])
  const value = useMemo(() => ({
    capabilities: auth.session?.capabilities || EMPTY_CAPABILITIES,
    logout,
    refresh,
    session: auth.session,
    status: auth.status,
  }), [auth.session, auth.status, logout, refresh])

  if (auth.status === 'loading' || auth.status === 'denied'
    || auth.status === 'reauth' || auth.status === 'unavailable') {
    return <AuthScreen state={auth.status} onLogout={logout} onRetry={retry} />
  }

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth() {
  const auth = useContext(AuthCtx)
  if (!auth) throw new Error('AUTH_CONTEXT_REQUIRED')
  return auth
}
