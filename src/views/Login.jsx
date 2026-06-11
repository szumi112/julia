import { useEffect, useRef, useState } from 'react'
import { Ambient } from '../three-scene.jsx'
import { Logotype } from '../layout.jsx'
import { Check } from '../ui.jsx'
import { useApp } from '../store.jsx'
import { useMagnetic, motionOK } from '../anim.js'

export function Login({ onLogin }) {
  const { toast } = useApp()
  const [email, setEmail] = useState('julia@aurelia.pl')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(false)
  const cardRef = useRef(null)
  const rootRef = useRef(null)
  const btnRef = useMagnetic(0.18)

  useEffect(() => {
    if (!motionOK() || !cardRef.current) return
    const tl = window.gsap.timeline()
    tl.fromTo(
      cardRef.current,
      { autoAlpha: 0, y: 34, scale: 0.97 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 1.1, ease: 'power3.out', delay: 0.25 }
    )
    tl.fromTo(
      cardRef.current.querySelectorAll('[data-stagger]'),
      { autoAlpha: 0, y: 14 },
      { autoAlpha: 1, y: 0, duration: 0.7, ease: 'power3.out', stagger: 0.08, clearProps: 'all' },
      '-=0.6'
    )
  }, [])

  const submit = (e) => {
    e.preventDefault()
    const errs = {}
    if (!email.trim()) errs.email = 'Wpisz adres e-mail'
    if (!password.trim()) errs.password = 'Wpisz hasło'
    setErrors(errs)
    if (Object.keys(errs).length) {
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
          Zaloguj się, aby zajrzeć do swojego centrum.
        </p>

        <div className="float-field" data-stagger>
          <input
            id="email"
            type="email"
            placeholder=" "
            value={email}
            onChange={(e) => { setEmail(e.target.value); setErrors((x) => ({ ...x, email: null })) }}
            autoComplete="email"
            style={errors.email ? { borderColor: 'var(--error)' } : undefined}
          />
          <label htmlFor="email">Adres e-mail</label>
          {errors.email && <span className="field__error" style={{ marginTop: 6, display: 'block' }}>{errors.email}</span>}
        </div>

        <div className="float-field" data-stagger>
          <input
            id="password"
            type="password"
            placeholder=" "
            value={password}
            onChange={(e) => { setPassword(e.target.value); setErrors((x) => ({ ...x, password: null })) }}
            autoComplete="current-password"
            style={errors.password ? { borderColor: 'var(--error)' } : undefined}
          />
          <label htmlFor="password">Hasło</label>
          {errors.password && <span className="field__error" style={{ marginTop: 6, display: 'block' }}>{errors.password}</span>}
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
        </div>
      </form>
      <div className="login__footer">Aurelia — Centrum Psychoterapii · Warszawa</div>
    </div>
  )
}
