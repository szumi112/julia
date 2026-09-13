import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useToasts } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { rolePresentationFor } from '../auth-role.js'
import { motionOK, setReduceMotion, useReveal } from '../anim.js'
import { useIsPhone, useMediaQuery } from '../responsive.js'
import { Button, Field, Avatar, IconBtn } from '../ui.jsx'
import { EntityLink, useRouteParamsSync } from '../ux-patterns.jsx'
import { canPerformAction } from '../capability-access.js'
import { OperationsPanel } from './Operations.jsx'
import { useAuth } from '../auth.jsx'
import { authClient, authStrategyFor, passwordValidationError } from '../auth-client.js'

const SECTIONS = [
  { id: 'center', label: 'Centrum' },
  { id: 'calendar', label: 'Grafik i integracje' },
  { id: 'team', label: 'Zespół i stawki' },
]
const PERSONAL_SECTIONS = SECTIONS.filter((section) => section.id === 'calendar')
const OPERATIONS_SECTION = Object.freeze({ id: 'security', label: 'Bezpieczeństwo danych' })

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const USES_BETTER_AUTH = authStrategyFor(import.meta.env?.MODE) === 'better-auth'

const teamDraftOf = (psychologists, current = {}) => Object.fromEntries(
  psychologists.map((psychologist) => [
    psychologist.id,
    current[psychologist.id] || {
      rate: String(psychologist.rate),
      weeklyCapacity: String(psychologist.weeklyCapacity),
    },
  ])
)

function SaveControls({ status, dirty, disabled, label, onSave }) {
  const message = status === 'saving'
    ? 'Zapisywanie…'
    : status === 'saved'
      ? 'Zapisano'
      : dirty ? 'Niezapisane zmiany' : ''
  return (
    <div className="settings-save">
      <span className="settings-save__status" role="status" aria-live="polite">{message}</span>
      <Button size="sm" type="submit" disabled={disabled} onClick={onSave}>{label}</Button>
    </div>
  )
}

function PreferenceSwitch({ title, description, on, disabled, onChange }) {
  return (
    <button
      type="button"
      className="pref-row pref-row--switch"
      role="switch"
      aria-checked={on}
      aria-label={title}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span>
        <span className="pref-row__title">{title}</span>
        <span className="pref-row__desc">{description}</span>
      </span>
      <span className={`toggle ${on ? 'is-on' : ''}`} aria-hidden="true" />
    </button>
  )
}

function AccountAuthentication({ client = authClient }) {
  const { logout, session } = useAuth()
  const { toast } = useToasts()
  const [methods, setMethods] = useState([])
  const [accounts, setAccounts] = useState([])
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changeOpen, setChangeOpen] = useState(false)
  const [reauthRequired, setReauthRequired] = useState(false)
  const [status, setStatus] = useState('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([client.getConfig(), client.listAccounts()])
      .then(([config, nextAccounts]) => {
        if (!active) return
        setMethods(Array.isArray(config?.methods) ? config.methods : [])
        setAccounts(Array.isArray(nextAccounts) ? nextAccounts : [])
        setStatus('idle')
      })
      .catch(() => {
        if (!active) return
        setStatus('error')
        setMessage('Nie udało się pobrać metod logowania.')
      })
    return () => { active = false }
  }, [client])

  const providers = new Set(accounts.map((account) => account.providerId))
  const hasPassword = providers.has('credential')
  const setFirstPassword = async (event) => {
    event.preventDefault()
    const validation = passwordValidationError(password)
    if (validation) return setMessage(validation)
    if (password !== confirmPassword) return setMessage('Hasła nie są takie same')
    setStatus('saving')
    setMessage('')
    try {
      await client.setFirstPassword(password, session.csrfToken)
      setAccounts((current) => [...current, { providerId: 'credential' }])
      setPassword('')
      setConfirmPassword('')
      setStatus('idle')
      setMessage('Hasło zostało ustawione.')
    } catch (error) {
      setStatus('idle')
      setMessage(error?.status === 401 ? 'Zaloguj się ponownie, aby ustawić hasło.' : 'Nie udało się ustawić hasła.')
    }
  }

  const clearPasswordFields = () => {
    setCurrentPassword('')
    setPassword('')
    setConfirmPassword('')
  }

  const changePassword = async (event) => {
    event.preventDefault()
    if (!currentPassword) return setMessage('Podaj obecne hasło')
    const validation = passwordValidationError(password)
    if (validation) return setMessage(validation)
    if (password !== confirmPassword) return setMessage('Hasła nie są takie same')
    setStatus('saving')
    setMessage('')
    setReauthRequired(false)
    try {
      await client.changePassword(currentPassword, password)
      clearPasswordFields()
      setChangeOpen(false)
      setStatus('idle')
      toast('Hasło zostało zmienione', 'check')
    } catch (error) {
      setStatus('idle')
      if (error?.status === 401 && error?.code === 'REAUTH_REQUIRED') {
        setReauthRequired(true)
        setMessage('Ze względów bezpieczeństwa zaloguj się ponownie, aby zmienić hasło.')
      } else {
        setMessage('Nie udało się zmienić hasła. Sprawdź obecne hasło.')
      }
    }
  }

  return (
    <div className="card card--pad settings-authentication" aria-label="Metody logowania">
      <h3 className="card-title">Logowanie do panelu</h3>
      <p className="pref-row__desc">Kod e-mail jest zawsze dostępny. Możesz też ustawić hasło.</p>
      {status === 'loading' ? <p role="status">Pobieranie metod logowania…</p> : null}
      {!hasPassword && methods.includes('password') && status !== 'loading' ? (
        <form className="settings-authentication__password" onSubmit={setFirstPassword}>
          <Field label="Nowe hasło">
            <input className="input" type="password" autoComplete="new-password" minLength={12} maxLength={128}
              value={password} onChange={(event) => { setPassword(event.target.value); setMessage('') }} />
          </Field>
          <Field label="Powtórz hasło">
            <input className="input" type="password" autoComplete="new-password" minLength={12} maxLength={128}
              value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setMessage('') }} />
          </Field>
          <Button type="submit" size="sm" disabled={status === 'saving'}>Ustaw hasło</Button>
        </form>
      ) : null}
      {hasPassword ? (
        <div className="pref-row settings-authentication__method">
          <span><span className="pref-row__title">Hasło</span><span className="pref-row__desc">Ustawione</span></span>
          <Button type="button" size="sm" variant="soft" onClick={() => {
            clearPasswordFields()
            setMessage('')
            setReauthRequired(false)
            setChangeOpen((open) => !open)
          }}>{changeOpen ? 'Anuluj' : 'Zmień hasło'}</Button>
        </div>
      ) : null}
      {hasPassword && changeOpen ? (
        <form className="settings-authentication__password" aria-label="Zmiana hasła" onSubmit={changePassword} noValidate>
          <Field label="Obecne hasło">
            <input className="input" type="password" autoComplete="current-password" required maxLength={128}
              value={currentPassword} onChange={(event) => { setCurrentPassword(event.target.value); setMessage(''); setReauthRequired(false) }} />
          </Field>
          <Field label="Nowe hasło">
            <input className="input" type="password" autoComplete="new-password" required minLength={12} maxLength={128}
              value={password} onChange={(event) => { setPassword(event.target.value); setMessage(''); setReauthRequired(false) }} />
          </Field>
          <Field label="Powtórz hasło">
            <input className="input" type="password" autoComplete="new-password" required minLength={12} maxLength={128}
              value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setMessage(''); setReauthRequired(false) }} />
          </Field>
          <Button type="submit" size="sm" disabled={status === 'saving'}>Zmień hasło</Button>
          {message ? <p className="field__error settings-authentication__form-message" role="alert">{message}</p> : null}
          {reauthRequired ? <Button type="button" size="sm" variant="soft" onClick={() => { void logout() }}>Zaloguj się ponownie</Button> : null}
        </form>
      ) : null}
      {!hasPassword && message ? <p className={status === 'error' ? 'field__error' : 'settings-authentication__message'} role="status">{message}</p> : null}
    </div>
  )
}

export function Profile() {
  const { actor, appMode, capabilities, role } = useShell()
  const ref = useReveal()
  const isApp = appMode === 'app'
  const canManageStaff = isApp && canPerformAction(capabilities, 'staff.invite')
  const identity = isApp ? actor : {
    displayName: role.name,
    email: null,
    professionalTitle: role.professionalTitle,
  }

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Konto</div>
          <h1 className="display view-head__title">Mój profil</h1>
          <p className="view-head__sub">Twoje dane i sposób logowania do panelu.</p>
        </div>
      </div>
      <section className="settings-section" aria-labelledby="profile-account-title">
        <h2 className="settings-section__title" id="profile-account-title">Twoje konto</h2>
        <div className="card card--pad settings-account-identity" aria-label="Tożsamość konta">
          <div>
            <span className="settings-account-identity__label">Imię i nazwisko</span>
            <strong>{identity.displayName}</strong>
          </div>
          {identity.email && (
            <div>
              <span className="settings-account-identity__label">E-mail do logowania</span>
              <strong>{identity.email}</strong>
            </div>
          )}
          <div>
            <span className="settings-account-identity__label">Rola w panelu</span>
            <strong>{role.label}</strong>
          </div>
          {identity.professionalTitle && (
            <div>
              <span className="settings-account-identity__label">Tytuł zawodowy</span>
              <strong>{identity.professionalTitle}</strong>
            </div>
          )}
          <p>Imienia i adresu e-mail nie da się zmienić w panelu.</p>
          {canManageStaff && (
            <p>Aby wyłączyć dostęp danej osoby, wyłącz go w Dostępie personelu i wyślij nowe zaproszenie.</p>
          )}
        </div>
        {isApp && USES_BETTER_AUTH ? <AccountAuthentication /> : null}
      </section>
    </div>
  )
}

export function Settings({ params = {} }) {
  const { state, dispatch, toast } = useApp()
  const {
    appMode,
    capabilities,
    navigate,
    openPsychForm,
    patchViewState,
    registerLeaveGuard,
    role,
  } = useShell()
  const ref = useReveal()
  const isPhone = useIsPhone()
  const osReduce = useMediaQuery('(prefers-reduced-motion: reduce)')
  const sectionRefs = useRef({})
  const teamFormRef = useRef(null)
  const isApp = appMode === 'app'
  const isOwner = role.id === 'owner'
  const canReadOperations = isApp && isOwner
    && canPerformAction(capabilities, 'operations.health.read')
  const availableSections = useMemo(() => {
    const sections = isApp
      ? []
      : isOwner ? SECTIONS : PERSONAL_SECTIONS
    return [
      ...sections,
      ...(canReadOperations ? [OPERATIONS_SECTION] : []),
    ]
  }, [canReadOperations, isApp, isOwner])
  const defaultSection = availableSections[0]?.id || 'calendar'
  const hasExplicitSection = availableSections.some((section) => section.id === params.section)
  const psychologists = useMemo(
    () => state.psychologists.toSorted((a, b) => a.name.localeCompare(b.name, 'pl')),
    [state.psychologists]
  )
  const [initialSection] = useState(() => {
    // A valid URL section is authoritative; a clean URL starts at the default.
    if (availableSections.some((section) => section.id === params.section)) return params.section
    return defaultSection
  })
  const [activeSection, setActiveSection] = useState(initialSection)
  const [center, setCenter] = useState({ ...state.center })
  const [team, setTeam] = useState(() => teamDraftOf(psychologists))
  const teamSourceRef = useRef(teamDraftOf(psychologists))
  const [centerStatus, setCenterStatus] = useState('idle')
  const [teamStatus, setTeamStatus] = useState('idle')
  const [teamSaveAttempted, setTeamSaveAttempted] = useState(false)

  useEffect(() => {
    if (!availableSections.some((section) => section.id === activeSection)) {
      setActiveSection(defaultSection)
    }
  }, [activeSection, availableSections, defaultSection])

  useEffect(() => {
    patchViewState('settings', { section: activeSection })
  }, [activeSection, patchViewState])

  // the active section lives in the URL, so a settings view can be shared
  useRouteParamsSync('settings', {
    section: hasExplicitSection || activeSection !== defaultSection ? activeSection : undefined,
  })

  useEffect(() => {
    const previousSource = teamSourceRef.current
    const nextSource = teamDraftOf(psychologists)
    setTeam((current) => Object.fromEntries(psychologists.map((psychologist) => {
      const previous = previousSource[psychologist.id]
      const next = nextSource[psychologist.id]
      const draft = current[psychologist.id] || next
      return [psychologist.id, {
        rate: !previous || draft.rate === previous.rate ? next.rate : draft.rate,
        weeklyCapacity: !previous || draft.weeklyCapacity === previous.weeklyCapacity
          ? next.weeklyCapacity
          : draft.weeklyCapacity,
      }]
    })))
    teamSourceRef.current = nextSource
  }, [psychologists])

  const centerErrors = {
    name: center.name.trim() ? null : 'Podaj nazwę centrum',
    email: center.email.trim() && !EMAIL.test(center.email.trim()) ? 'Podaj poprawny adres e-mail' : null,
  }
  const centerDirty = Object.keys(center).some((key) => center[key] !== state.center[key])
  const teamErrors = Object.fromEntries(psychologists.map((psychologist) => {
    const draft = team[psychologist.id] || { rate: '', weeklyCapacity: '' }
    const rate = Number(draft.rate)
    const weeklyCapacity = Number(draft.weeklyCapacity)
    return [psychologist.id, {
      rate: Number.isFinite(rate) && rate > 0 ? null : 'Wpisz stawkę większą niż 0 zł',
      weeklyCapacity: Number.isInteger(weeklyCapacity) && weeklyCapacity > 0
        ? null
        : 'Wpisz liczbę sesji, np. 20',
    }]
  }))
  const teamDirty = psychologists.some((psychologist) => {
    const draft = team[psychologist.id]
    return draft && (
      draft.rate !== String(psychologist.rate)
      || draft.weeklyCapacity !== String(psychologist.weeklyCapacity)
    )
  })
  const teamInvalid = Object.values(teamErrors).some((errors) => errors.rate || errors.weeklyCapacity)

  // route commits (sidebar, back/forward, role switch) ask before discarding drafts
  const settingsDirty = centerDirty || teamDirty
  useEffect(() => registerLeaveGuard(() => settingsDirty), [registerLeaveGuard, settingsDirty])

  const markDraftChanged = (setStatus) => setStatus((current) => current === 'saving' ? current : 'idle')
  const completeSave = (save, setStatus) => {
    setStatus('saving')
    window.setTimeout(() => {
      save()
      setStatus('saved')
    }, 80)
  }

  const selectSection = (sectionId) => {
    if (sectionId === activeSection) return
    navigate('settings', {
      section: sectionId,
    }, () => {
      requestAnimationFrame(() => {
        const section = document.querySelector('.view .settings-sections > .settings-section')
        const heading = section?.querySelector('h2')
        heading?.focus({ preventScroll: true })
        section?.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'start' })
      })
    })
  }

  const saveCenter = (event) => {
    event?.preventDefault()
    if (!centerDirty || centerErrors.name || centerErrors.email || centerStatus === 'saving') return
    const patch = Object.fromEntries(Object.entries(center).map(([key, value]) => [key, value.trim()]))
    completeSave(() => {
      dispatch({ type: 'UPDATE_CENTER', patch })
      setCenter(patch)
    }, setCenterStatus)
  }

  const saveTeam = (event) => {
    event?.preventDefault()
    setTeamSaveAttempted(true)
    if (!teamDirty || teamStatus === 'saving') return
    if (teamInvalid) {
      requestAnimationFrame(() =>
        teamFormRef.current?.querySelector('.has-error input, .has-error select, .has-error textarea')?.focus()
      )
      return
    }
    const nextDraft = teamDraftOf(psychologists, team)
    completeSave(() => {
      for (const psychologist of psychologists) {
        const rate = Number(nextDraft[psychologist.id].rate)
        const weeklyCapacity = Number(nextDraft[psychologist.id].weeklyCapacity)
        if (rate === psychologist.rate && weeklyCapacity === psychologist.weeklyCapacity) continue
        dispatch({
          type: 'UPDATE_PSYCH',
          id: psychologist.id,
          patch: { rate, weeklyCapacity },
        })
        nextDraft[psychologist.id] = { rate: String(rate), weeklyCapacity: String(weeklyCapacity) }
      }
      setTeam({ ...nextDraft })
    }, setTeamStatus)
  }

  const setPreference = (key, value, message, sideEffect) => {
    const previous = state.prefs[key]
    dispatch({ type: 'SET_PREF', key, value })
    sideEffect?.(value)
    toast(message, 'check', {
      label: 'Cofnij',
      key: `preference:${key}`,
      timeoutMs: 5000,
      onClick: () => {
        dispatch({ type: 'SET_PREF', key, value: previous })
        sideEffect?.(previous)
      },
    })
  }

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <h1 className="display view-head__title">Ustawienia</h1>
          <p className="view-head__sub">
            {isOwner && !isApp
              ? 'Dane centrum, integracje oraz stawki i limity zespołu.'
              : !isApp
                ? `Grafik i preferencje dla: ${role.name} · ${role.label}${role.professionalTitle ? ` · ${rolePresentationFor(role)}` : ''}.`
                : 'Sprawdź, czy kopie zapasowe i automatyczne kontrole działają.'}
          </p>
        </div>
      </div>

      {isPhone && availableSections.length > 1 ? (
        <label className="settings-mobile-nav">
          <span>Sekcja</span>
          <select
            className="select"
            aria-label="Sekcja"
            value={activeSection}
            onChange={(event) => selectSection(event.target.value)}
          >
            {availableSections.map((section) => (
              <option key={section.id} value={section.id}>{section.label}</option>
            ))}
          </select>
        </label>
      ) : null}

      <div className={`settings-grid ${availableSections.length === 1 ? 'settings-grid--single' : ''}`}>
        {!isPhone && availableSections.length > 1 && (
          <nav className="settings-local-nav" aria-label="Sekcje ustawień">
            {availableSections.map((section) => (
              <button
                type="button"
                key={section.id}
                className={activeSection === section.id ? 'is-active' : ''}
                aria-current={activeSection === section.id ? 'true' : undefined}
                onClick={() => selectSection(section.id)}
              >
                {section.label}
              </button>
            ))}
          </nav>
        )}

        <div className="settings-sections">
          {!isApp && activeSection === 'center' && <section
                className="settings-section"
                ref={(element) => { sectionRefs.current.center = element }}
                aria-labelledby="settings-center-title"
              >
            <h2 className="settings-section__title" id="settings-center-title" tabIndex={-1}>Dane centrum</h2>
            <form className="card card--pad stack" aria-label="Dane centrum" onSubmit={saveCenter} noValidate>
              <Field label="Nazwa" error={centerErrors.name}>
                <input
                  className="input"
                  name="organization"
                  autoComplete="organization"
                  disabled={centerStatus === 'saving'}
                  value={center.name}
                  onChange={(event) => {
                    setCenter((current) => ({ ...current, name: event.target.value }))
                    markDraftChanged(setCenterStatus)
                  }}
                />
              </Field>
              <Field label="Adres">
                <input
                  className="input"
                  name="street-address"
                  autoComplete="street-address"
                  disabled={centerStatus === 'saving'}
                  value={center.address}
                  onChange={(event) => {
                    setCenter((current) => ({ ...current, address: event.target.value }))
                    markDraftChanged(setCenterStatus)
                  }}
                />
              </Field>
              <div className="form-grid">
                <Field label="Telefon">
                  <input
                    className="input"
                    type="tel"
                    name="tel"
                    autoComplete="tel"
                    disabled={centerStatus === 'saving'}
                    value={center.phone}
                    onChange={(event) => {
                      setCenter((current) => ({ ...current, phone: event.target.value }))
                      markDraftChanged(setCenterStatus)
                    }}
                  />
                </Field>
                <Field label="E-mail" error={centerErrors.email}>
                  <input
                    className="input"
                    type="email"
                    name="work-email"
                    autoComplete="email"
                    spellCheck={false}
                    disabled={centerStatus === 'saving'}
                    value={center.email}
                    onChange={(event) => {
                      setCenter((current) => ({ ...current, email: event.target.value }))
                      markDraftChanged(setCenterStatus)
                    }}
                  />
                </Field>
              </div>
              <SaveControls
                status={centerStatus}
                dirty={centerDirty}
                disabled={!centerDirty || Boolean(centerErrors.name || centerErrors.email) || centerStatus === 'saving'}
                label="Zapisz dane centrum"
              />
            </form>
              </section>}

          {!isApp && activeSection === 'calendar' && <section
            className="settings-section"
            ref={(element) => { sectionRefs.current.calendar = element }}
            aria-labelledby="settings-calendar-title"
          >
            <h2 className="settings-section__title" id="settings-calendar-title" tabIndex={-1}>Grafik i integracje</h2>
            <div className="card card--pad">
              <h3 className="card-title">Wygląd i preferencje</h3>
              <div className="settings-pref-list">
                <PreferenceSwitch
                  title="Ogranicz animacje"
                  description={osReduce
                    ? 'System już ogranicza ruch — ustawienie systemowe ma pierwszeństwo.'
                    : 'Wycisza efekty ruchu w całej aplikacji.'}
                  on={osReduce || state.prefs.reduceMotion}
                  disabled={osReduce}
                  onChange={(value) => setPreference(
                    'reduceMotion',
                    value,
                    value ? 'Ogranicz animacje — włączone' : 'Ogranicz animacje — wyłączone',
                    setReduceMotion
                  )}
                />
              </div>
            </div>

            <div className="card card--pad settings-integration">
              <h3 className="card-title">Grafik Google</h3>
              <div className="pref-row">
                <div>
                  <div className="pref-row__desc">
                    W tym demo nie łączymy kont Google ani nie synchronizujemy sesji.
                  </div>
                </div>
              </div>
            </div>
          </section>}

          {!isApp && isOwner && activeSection === 'team' && (
            <section
              className="settings-section"
              ref={(element) => { sectionRefs.current.team = element }}
              aria-labelledby="settings-team-title"
            >
            <h2 className="settings-section__title" id="settings-team-title" tabIndex={-1}>Zespół i stawki</h2>
            <form ref={teamFormRef} className="card card--pad" aria-label="Zespół i stawki" onSubmit={saveTeam} noValidate>
              <div className="stack team-settings-list">
                {psychologists.map((psychologist) => {
                  const draft = team[psychologist.id] || { rate: '', weeklyCapacity: '' }
                  const errors = teamSaveAttempted ? teamErrors[psychologist.id] : null
                  return (
                    <div className="team-settings-row" key={psychologist.id}>
                      <span className="team-settings-row__person">
                        <Avatar name={psychologist.name} color={psychologist.color} avatarKey={psychologist.avatarKey} size={38} />
                        <span>
                          <span className="pref-row__title">{psychologist.title} {psychologist.name}</span>
                          <span className="pref-row__desc">{psychologist.spec}</span>
                        </span>
                      </span>
                      <div className="team-settings-row__fields">
                        <Field label="Stawka za sesję (zł)" error={errors?.rate}>
                          <input
                            className="input input--rate"
                            type="number"
                            disabled={teamStatus === 'saving'}
                            min="0.01"
                            step="10"
                            inputMode="decimal"
                            name={`rate-${psychologist.id}`}
                            autoComplete="off"
                            aria-label={`Stawka za sesję — ${psychologist.name}`}
                            value={draft.rate}
                            onChange={(event) => {
                              setTeam((current) => ({
                                ...current,
                                [psychologist.id]: { ...current[psychologist.id], rate: event.target.value },
                              }))
                              markDraftChanged(setTeamStatus)
                              setTeamSaveAttempted(false)
                            }}
                          />
                        </Field>
                        <Field label="Wizyt w tygodniu (maks.)" error={errors?.weeklyCapacity}>
                          <input
                            className="input input--capacity"
                            type="number"
                            disabled={teamStatus === 'saving'}
                            min="1"
                            step="1"
                            inputMode="numeric"
                            name={`capacity-${psychologist.id}`}
                            autoComplete="off"
                            aria-label={`Wizyt w tygodniu (maks.) — ${psychologist.name}`}
                            value={draft.weeklyCapacity}
                            onChange={(event) => {
                              setTeam((current) => ({
                                ...current,
                                [psychologist.id]: { ...current[psychologist.id], weeklyCapacity: event.target.value },
                              }))
                              markDraftChanged(setTeamStatus)
                              setTeamSaveAttempted(false)
                            }}
                          />
                        </Field>
                        <IconBtn
                          name="edit"
                          label={`Edytuj profil — ${psychologist.name}`}
                          size={16}
                          disabled={teamStatus === 'saving'}
                          onClick={() => openPsychForm({ psych: psychologist })}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="divider-soft" />
              <div className="settings-team-actions">
                <SaveControls
                  status={teamStatus}
                  dirty={teamDirty}
                  disabled={!teamDirty || teamStatus === 'saving'}
                  label="Zapisz zespół"
                />
                <EntityLink
                  route="team"
                  label="Zarządzaj zespołem"
                  className="btn btn--soft btn--sm settings-team-link"
                  aria-disabled={teamStatus === 'saving' ? 'true' : undefined}
                  onClick={(event) => { if (teamStatus === 'saving') event.preventDefault() }}
                >
                  Zarządzaj zespołem
                </EntityLink>
              </div>
            </form>
            </section>
          )}

          {activeSection === 'security' && canReadOperations && (
            <OperationsPanel sectionRef={(element) => { sectionRefs.current.security = element }} />
          )}
        </div>
      </div>
    </div>
  )
}
