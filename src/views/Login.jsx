import { useEffect, useRef, useState } from 'react'
import { Ambient } from '../three-scene.jsx'
import { Logotype } from '../layout.jsx'
import { Check } from '../ui.jsx'
import { useApp } from '../store.jsx'
import { useMagnetic, motionOK } from '../anim.js'
import { AuthRequestError, authClient, passwordValidationError, resetTokenFromLocation } from '../auth-client.js'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const authErrorMessage = (error) => {
  if (error instanceof AuthRequestError && error.status === 400) return 'Dane logowania lub link są nieprawidłowe albo wygasły. Spróbuj ponownie.'
  if (error instanceof AuthRequestError && error.status === 401) return 'Nieprawidłowy e-mail, hasło lub kod.'
  if (error instanceof AuthRequestError && error.status === 403) return 'To konto nie ma aktywnego dostępu do panelu.'
  if (error instanceof AuthRequestError && error.status === 429) return 'Za dużo prób. Odczekaj chwilę i spróbuj ponownie.'
  return 'Nie udało się zalogować. Sprawdź połączenie i spróbuj ponownie.'
}

function LoginFrame({ children, cardRef, rootRef }) {
  return (
    <div className="login" ref={rootRef}>
      <Ambient className="login__scene" amp={0.45} speed={0.85} scale={0.72} />
      <div className="login__vignette" />
      <div className="login__card" ref={cardRef}>{children}</div>
      <div className="login__footer">Bear with me · Centrum psychologiczno-edukacyjne · Jelenia Góra</div>
    </div>
  )
}

export function AppLogin({ client = authClient, onAuthenticated }) {
  const [methods, setMethods] = useState([])
  const [resetToken] = useState(() => resetTokenFromLocation(window.location.search, window.location.hash))
  const [mode, setMode] = useState(() => resetToken ? 'reset' : 'password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [newPassword, setNewPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const cardRef = useRef(null)
  const rootRef = useRef(null)

  useEffect(() => {
    if (resetToken) window.history.replaceState(null, '', `${window.location.pathname}#/reset-password`)
  }, [resetToken])

  useEffect(() => {
    let active = true
    client.getConfig()
      .then((config) => { if (active) setMethods(Array.isArray(config?.methods) ? config.methods : []) })
      .catch(() => { if (active) setError('Nie udało się pobrać metod logowania. Spróbuj ponownie.') })
    return () => { active = false }
  }, [client])

  const run = async (action) => {
    setLoading(true)
    setError('')
    try {
      return await action()
    } catch (requestError) {
      setError(authErrorMessage(requestError))
      return null
    } finally {
      setLoading(false)
    }
  }

  const validEmail = () => {
    if (EMAIL.test(email.trim())) return true
    setError('Wpisz poprawny adres e-mail.')
    return false
  }

  const submit = async (event) => {
    event.preventDefault()
    if (mode !== 'reset' && !validEmail()) return
    if (mode === 'password') {
      if (!password) return setError('Wpisz hasło.')
      const result = await run(() => client.signInPassword(email, password, remember))
      if (result) onAuthenticated()
      return
    }
    if (mode === 'otp-request') {
      const result = await run(() => client.sendSignInOtp(email))
      if (result) {
        setMode('otp')
        setNotice('Kod wysłaliśmy na podany adres. Jest ważny przez 5 minut.')
      }
      return
    }
    if (mode === 'reset-request') {
      const result = await run(() => client.requestPasswordReset(email, `${window.location.origin}/#/reset-password`))
      if (result) {
        setMode('password')
        setNotice('Jeśli konto istnieje, wysłaliśmy link do zmiany hasła.')
      }
      return
    }
    if (mode === 'reset') {
      const validation = passwordValidationError(newPassword)
      if (validation) return setError(validation)
      const result = await run(() => client.resetPassword(resetToken, newPassword))
      if (result) {
        window.history.replaceState(null, '', '/')
        setMode('password')
        setPassword('')
        setNewPassword('')
        setOtp('')
        setNotice('Hasło zostało zmienione. Możesz się zalogować.')
      }
      return
    }
    if (!/^\d{6}$/.test(otp)) return setError('Wpisz 6-cyfrowy kod.')
    const result = await run(() => client.signInOtp(email, otp))
    if (result) onAuthenticated()
  }

  const hasPassword = methods.includes('password')
  const hasOtp = methods.includes('email-otp')

  return (
    <LoginFrame cardRef={cardRef} rootRef={rootRef}>
      <form onSubmit={submit} noValidate>
        <div className="login__mark"><Logotype /></div>
        <h1 className="display login__title">Witaj <em>z powrotem</em></h1>
        <p className="login__sub">Zaloguj się, aby zajrzeć do dzisiejszego planu centrum.</p>

        {mode !== 'reset' ? <div className="float-field">
          <input id="app-login-email" type="email" placeholder=" " value={email}
            onChange={(event) => { setEmail(event.target.value); setError('') }} autoComplete="email" spellCheck={false} />
          <label htmlFor="app-login-email">Adres e-mail</label>
        </div> : null}

        {mode === 'password' && hasPassword ? <div className="float-field">
          <input id="app-login-password" type="password" placeholder=" " value={password}
            onChange={(event) => { setPassword(event.target.value); setError('') }} autoComplete="current-password" />
          <label htmlFor="app-login-password">Hasło</label>
        </div> : null}
        {mode === 'otp' ? <div className="float-field">
          <input id="app-login-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            placeholder=" " value={otp} onChange={(event) => { setOtp(event.target.value.replace(/\D/g, '').slice(0, 6)); setError('') }} />
          <label htmlFor="app-login-otp">Kod jednorazowy</label>
        </div> : null}
        {mode === 'reset' ? <div className="float-field">
          <input id="app-login-new-password" type="password" placeholder=" " value={newPassword}
            minLength={12} maxLength={128} onChange={(event) => { setNewPassword(event.target.value); setError('') }} autoComplete="new-password" />
          <label htmlFor="app-login-new-password">Nowe hasło</label>
        </div> : null}

        {mode === 'password' && hasPassword ? <div className="login__row">
          <Check checked={remember} onChange={setRemember}>Zapamiętaj mnie</Check>
          <button type="button" className="link" onClick={() => { setMode('reset-request'); setError(''); setNotice('') }}>Nie pamiętasz hasła?</button>
        </div> : null}

        {notice ? <p className="login-auth__notice" role="status">{notice}</p> : null}
        {error ? <p className="field__error login-auth__error" role="alert">{error}</p> : null}

        <button type="submit" className="btn btn--primary btn--lg btn--full" disabled={loading || methods.length === 0}>
          {loading
            ? 'Proszę czekać…'
            : mode === 'otp-request'
              ? 'Wyślij kod'
              : mode === 'reset-request'
                ? 'Wyślij link'
                : mode === 'reset' ? 'Zmień hasło' : 'Zaloguj się'}
        </button>

        <div className="login-auth__switches">
          {hasPassword && mode !== 'password' ? <button type="button" className="link" onClick={() => { setMode('password'); setError(''); setNotice('') }}>Zaloguj się hasłem</button> : null}
          {hasOtp && mode === 'password' ? <button type="button" className="link" onClick={() => { setMode('otp-request'); setError(''); setNotice('') }}>Zaloguj się kodem e-mail</button> : null}
          {mode === 'otp' ? <button type="button" className="link" onClick={() => setMode('otp-request')}>Wyślij nowy kod</button> : null}
          {(mode === 'reset-request' || mode === 'reset') ? <button type="button" className="link" onClick={() => { setMode('password'); setError(''); setNotice('') }}>Wróć do logowania</button> : null}
        </div>

      </form>
    </LoginFrame>
  )
}

export function Login({ onLogin }) {
  const { toast } = useApp()
  const [email, setEmail] = useState('anna@bearwithme.pl')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(false)
  const cardRef = useRef(null)
  const rootRef = useRef(null)
  const btnRef = useMagnetic(0.18)

  useEffect(() => {
    if (!motionOK() || !cardRef.current) return
    // cinematic but brief — the form must be workable well under a second
    const tl = window.gsap.timeline()
    tl.fromTo(
      cardRef.current,
      { autoAlpha: 0, y: 30, scale: 0.975 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.7, ease: 'power3.out', delay: 0.1 }
    )
    tl.fromTo(
      cardRef.current.querySelectorAll('[data-stagger]'),
      { autoAlpha: 0, y: 12 },
      { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power3.out', stagger: 0.055, clearProps: 'transform,opacity,visibility' },
      '-=0.45'
    )
  }, [])

  const submit = (e) => {
    e.preventDefault()
    const errs = {}
    if (!email.trim()) errs.email = 'Wpisz adres e-mail'
    if (!password.trim()) errs.password = 'Wpisz hasło'
    setErrors(errs)
    if (Object.keys(errs).length) {
      // announce and land on the first invalid field, not just the shake
      cardRef.current?.querySelector(errs.email ? '#email' : '#password')?.focus()
      if (motionOK()) {
        window.gsap.fromTo(
          cardRef.current,
          { x: 0 },
          { x: 9, duration: 0.07, repeat: 5, yoyo: true, ease: 'power1.inOut', clearProps: 'x' }
        )
      }
      return
    }
    setLoading(true)
    if (!motionOK()) return void setTimeout(onLogin, 350)
    const tl = window.gsap.timeline({ onComplete: onLogin, delay: 0.55 })
    tl.to(cardRef.current, { y: -26, autoAlpha: 0, scale: 0.97, duration: 0.55, ease: 'power3.in' })
    tl.to(rootRef.current, { autoAlpha: 0, duration: 0.5, ease: 'power2.inOut' }, '-=0.2')
  }

  return (
    <div className="login" ref={rootRef}>
      <Ambient className="login__scene" amp={0.45} speed={0.85} scale={0.72} />
      <div className="login__vignette" />
      <form className="login__card" ref={cardRef} onSubmit={submit} noValidate>
        <div className="login__mark" data-stagger>
          <Logotype />
        </div>
        <h1 className="display login__title" data-stagger>
          Witaj <em>z powrotem</em>
        </h1>
        <p className="login__sub" data-stagger>
          Zaloguj się, aby zajrzeć do dzisiejszego planu centrum.
        </p>

        <div className="float-field" data-stagger>
          <input
            id="email"
            name="email"
            type="email"
            placeholder=" "
            value={email}
            onChange={(e) => { setEmail(e.target.value); setErrors((x) => ({ ...x, email: null })) }}
            autoComplete="email"
            spellCheck={false}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? 'email-error' : undefined}
            style={errors.email ? { borderColor: 'var(--error)' } : undefined}
          />
          <label htmlFor="email">Adres e-mail</label>
          {errors.email && (
            <span className="field__error" id="email-error" role="alert" style={{ marginTop: 6, display: 'block' }}>{errors.email}</span>
          )}
        </div>

        <div className="float-field" data-stagger>
          <input
            id="password"
            name="password"
            type="password"
            placeholder=" "
            value={password}
            onChange={(e) => { setPassword(e.target.value); setErrors((x) => ({ ...x, password: null })) }}
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? 'password-error' : undefined}
            style={errors.password ? { borderColor: 'var(--error)' } : undefined}
          />
          <label htmlFor="password">Hasło</label>
          {errors.password && (
            <span className="field__error" id="password-error" role="alert" style={{ marginTop: 6, display: 'block' }}>{errors.password}</span>
          )}
        </div>

        <div className="login__row" data-stagger>
          <Check checked={remember} onChange={setRemember}>
            Zapamiętaj mnie
          </Check>
          <button
            type="button"
            className="link"
            onClick={() => toast('Wysłaliśmy link do zmiany hasła ✉️', 'mail')}
          >
            Nie pamiętasz hasła?
          </button>
        </div>

        <div data-stagger>
          <button type="submit" className="btn btn--primary btn--lg btn--full" ref={btnRef} disabled={loading}>
            <span>{loading ? 'Logowanie…' : 'Zaloguj się'}</span>
          </button>
          <p className="login__demo">Wersja demonstracyjna — wystarczy dowolny e-mail i hasło.</p>
        </div>
      </form>
      <div className="login__footer">Bear with me · Centrum psychologiczno-edukacyjne · Jelenia Góra</div>
    </div>
  )
}
