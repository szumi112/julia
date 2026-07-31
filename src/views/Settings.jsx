import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { motionOK, setReduceMotion, useReveal } from '../anim.js'
import { useIsPhone, useMediaQuery } from '../responsive.js'
import { Button, Field, Avatar, IconBtn } from '../ui.jsx'
import { EntityLink, useRouteParamsSync } from '../ux-patterns.jsx'
import { StaffAccess } from './StaffAccess.jsx'

const SECTIONS = [
  { id: 'account', label: 'Konto' },
  { id: 'center', label: 'Centrum' },
  { id: 'calendar', label: 'Kalendarz i integracje' },
  { id: 'team', label: 'Zespół i stawki' },
]
const PERSONAL_SECTIONS = SECTIONS.filter((section) => section.id === 'calendar')
const STAFF_SECTION = Object.freeze({ id: 'staff', label: 'Dostęp personelu' })

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

export function Settings({ params = {} }) {
  const { state, dispatch, toast } = useApp()
  const {
    actor,
    appMode,
    capabilities,
    getViewState,
    openPsychForm,
    patchViewState,
    registerLeaveGuard,
    role,
  } = useShell()
  const ref = useReveal()
  const isPhone = useIsPhone()
  const osReduce = useMediaQuery('(prefers-reduced-motion: reduce)')
  const sectionRefs = useRef({})
  const isApp = appMode === 'app'
  const isOwner = role.id === 'owner'
  const canManageStaff = isApp && capabilities.includes('staff.manage')
  const availableSections = useMemo(() => {
    const sections = isOwner ? SECTIONS : PERSONAL_SECTIONS
    return canManageStaff ? [...sections, STAFF_SECTION] : sections
  }, [canManageStaff, isOwner])
  const defaultSection = isOwner ? 'account' : 'calendar'
  const psychologists = useMemo(
    () => state.psychologists.toSorted((a, b) => a.name.localeCompare(b.name, 'pl')),
    [state.psychologists]
  )
  const [initialSection] = useState(() => {
    // URL params win over the registry — a shared link must reproduce its scope
    if (availableSections.some((section) => section.id === params.section)) return params.section
    const saved = getViewState('settings', { section: defaultSection })
    return availableSections.some((section) => section.id === saved.section)
      ? saved.section
      : defaultSection
  })
  const [activeSection, setActiveSection] = useState(initialSection)
  const [profile, setProfile] = useState(() => (
    isApp ? { name: '', email: '' } : { name: state.user.name, email: state.user.email }
  ))
  const [center, setCenter] = useState({ ...state.center })
  const [team, setTeam] = useState(() => teamDraftOf(psychologists))
  const teamSourceRef = useRef(teamDraftOf(psychologists))
  const [profileStatus, setProfileStatus] = useState('idle')
  const [centerStatus, setCenterStatus] = useState('idle')
  const [teamStatus, setTeamStatus] = useState('idle')

  useEffect(() => {
    patchViewState('settings', { section: activeSection })
  }, [activeSection, patchViewState])

  // the active section lives in the URL, so a settings view can be shared
  useRouteParamsSync('settings', { section: activeSection !== defaultSection ? activeSection : undefined })

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

  const profileErrors = isApp
    ? { name: null, email: null }
    : {
        name: profile.name.trim() ? null : 'Podaj imię i nazwisko',
        email: !profile.email.trim()
          ? 'Podaj adres e-mail'
          : EMAIL.test(profile.email.trim()) ? null : 'Podaj poprawny adres e-mail',
      }
  const centerErrors = {
    name: center.name.trim() ? null : 'Podaj nazwę centrum',
    email: center.email.trim() && !EMAIL.test(center.email.trim()) ? 'Podaj poprawny adres e-mail' : null,
  }
  const profileDirty = !isApp
    && (profile.name !== state.user.name || profile.email !== state.user.email)
  const centerDirty = Object.keys(center).some((key) => center[key] !== state.center[key])
  const teamErrors = Object.fromEntries(psychologists.map((psychologist) => {
    const draft = team[psychologist.id] || { rate: '', weeklyCapacity: '' }
    const rate = Number(draft.rate)
    const weeklyCapacity = Number(draft.weeklyCapacity)
    return [psychologist.id, {
      rate: Number.isFinite(rate) && rate > 0 ? null : 'Stawka musi być większa od zera',
      weeklyCapacity: Number.isInteger(weeklyCapacity) && weeklyCapacity > 0
        ? null
        : 'Limit musi być dodatnią liczbą całkowitą',
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
  const settingsDirty = profileDirty || centerDirty || teamDirty
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
    setActiveSection(sectionId)
    requestAnimationFrame(() => {
      const section = sectionRefs.current[sectionId]
      const heading = section?.querySelector('h2')
      heading?.focus({ preventScroll: true })
      section?.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'start' })
    })
  }

  const saveProfile = (event) => {
    event?.preventDefault()
    if (isApp || !profileDirty || profileErrors.name || profileErrors.email || profileStatus === 'saving') return
    const patch = { name: profile.name.trim(), email: profile.email.trim() }
    completeSave(() => {
      dispatch({ type: 'UPDATE_USER', patch })
      setProfile(patch)
    }, setProfileStatus)
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
    if (!teamDirty || teamInvalid || teamStatus === 'saving') return
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
          <div className="eyebrow">{isOwner ? 'Konfiguracja' : 'Twoje preferencje'}</div>
          <h1 className="display view-head__title">
            Ustawienia <em>{isOwner ? 'centrum' : 'osobiste'}</em>
          </h1>
          <p className="view-head__sub">
            {isOwner
              ? 'Konto, dane centrum, integracje oraz stawki i limity zespołu.'
              : `Kalendarz, integracje i preferencje dla: ${role.name} · ${role.label}.`}
          </p>
        </div>
      </div>

      {isPhone ? (
        <label className="settings-mobile-nav">
          <span>Przejdź do sekcji</span>
          <select
            className="select"
            aria-label="Sekcja ustawień"
            value={activeSection}
            onChange={(event) => selectSection(event.target.value)}
          >
            {availableSections.map((section) => (
              <option key={section.id} value={section.id}>{section.label}</option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="settings-grid">
        {!isPhone && (
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
          {isOwner && (
            <>
              <section
                className="settings-section"
                ref={(element) => { sectionRefs.current.account = element }}
                aria-labelledby="settings-account-title"
              >
            <h2 className="settings-section__title" id="settings-account-title" tabIndex={-1}>Twoje konto</h2>
            {isApp ? (
              <div className="card card--pad settings-account-identity" aria-label="Tożsamość konta">
                <div>
                  <span className="settings-account-identity__label">Imię i nazwisko</span>
                  <strong>{actor.displayName}</strong>
                </div>
                <div>
                  <span className="settings-account-identity__label">Rola</span>
                  <strong>{role.label}</strong>
                </div>
                <p>Tożsamość jest zarządzana przez chroniony dostęp do panelu.</p>
              </div>
            ) : (
              <form className="card card--pad stack" aria-label="Twoje konto" onSubmit={saveProfile} noValidate>
                <Field label="Imię i nazwisko" error={profileErrors.name}>
                  <input
                    className="input"
                    name="name"
                    autoComplete="name"
                    disabled={profileStatus === 'saving'}
                    value={profile.name}
                    onChange={(event) => {
                      setProfile((current) => ({ ...current, name: event.target.value }))
                      markDraftChanged(setProfileStatus)
                    }}
                  />
                </Field>
                <Field label="Adres e-mail" error={profileErrors.email}>
                  <input
                    className="input"
                    type="email"
                    name="email"
                    autoComplete="email"
                    spellCheck={false}
                    disabled={profileStatus === 'saving'}
                    value={profile.email}
                    onChange={(event) => {
                      setProfile((current) => ({ ...current, email: event.target.value }))
                      markDraftChanged(setProfileStatus)
                    }}
                  />
                </Field>
                <SaveControls
                  status={profileStatus}
                  dirty={profileDirty}
                  disabled={!profileDirty || Boolean(profileErrors.name || profileErrors.email) || profileStatus === 'saving'}
                  label="Zapisz konto"
                />
              </form>
            )}
              </section>

              <section
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
              </section>
            </>
          )}

          <section
            className="settings-section"
            ref={(element) => { sectionRefs.current.calendar = element }}
            aria-labelledby="settings-calendar-title"
          >
            <h2 className="settings-section__title" id="settings-calendar-title" tabIndex={-1}>Kalendarz i integracje</h2>
            <div className="card card--pad">
              <h3 className="card-title">Preferencje kalendarza</h3>
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
                <PreferenceSwitch
                  title="Weekendy w kalendarzu"
                  description="Pokazuj soboty i niedziele w widoku miesiąca."
                  on={state.prefs.weekendsInCalendar}
                  onChange={(value) => setPreference(
                    'weekendsInCalendar',
                    value,
                    `Weekendy w kalendarzu — ${value ? 'włączone' : 'wyłączone'}`
                  )}
                />
              </div>
            </div>

            <div className="card card--pad settings-integration">
              <h3 className="card-title">Integracje</h3>
              <div className="pref-row">
                <div>
                  <div className="pref-row__title">Google Calendar</div>
                  <div className="pref-row__desc">
                    Synchronizacja wizyt z kalendarzem Google (demo) — pełne połączenie wymaga wersji z kontami.
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={state.prefs.gcalConnected ? 'ghost' : 'soft'}
                  onClick={() => {
                    const connected = !state.prefs.gcalConnected
                    setPreference(
                      'gcalConnected',
                      connected,
                      connected ? 'Połączono z Google Calendar (demo)' : 'Rozłączono z Google Calendar'
                    )
                  }}
                >
                  {state.prefs.gcalConnected ? 'Rozłącz' : 'Połącz (demo)'}
                </Button>
              </div>
            </div>
          </section>

          {isOwner && (
            <section
              className="settings-section"
              ref={(element) => { sectionRefs.current.team = element }}
              aria-labelledby="settings-team-title"
            >
            <h2 className="settings-section__title" id="settings-team-title" tabIndex={-1}>Zespół i stawki</h2>
            <form className="card card--pad" aria-label="Zespół i stawki" onSubmit={saveTeam} noValidate>
              <div className="stack team-settings-list">
                {psychologists.map((psychologist) => {
                  const draft = team[psychologist.id] || { rate: '', weeklyCapacity: '' }
                  const errors = teamErrors[psychologist.id]
                  return (
                    <div className="team-settings-row" key={psychologist.id}>
                      <span className="team-settings-row__person">
                        <Avatar name={psychologist.name} color={psychologist.color} size={38} />
                        <span>
                          <span className="pref-row__title">{psychologist.title} {psychologist.name}</span>
                          <span className="pref-row__desc">{psychologist.spec}</span>
                        </span>
                      </span>
                      <div className="team-settings-row__fields">
                        <Field label="Stawka (zł)" error={errors?.rate}>
                          <input
                            className="input input--rate"
                            type="number"
                            disabled={teamStatus === 'saving'}
                            min="0.01"
                            step="10"
                            inputMode="decimal"
                            name={`rate-${psychologist.id}`}
                            autoComplete="off"
                            aria-label={`Stawka — ${psychologist.name}`}
                            value={draft.rate}
                            onChange={(event) => {
                              setTeam((current) => ({
                                ...current,
                                [psychologist.id]: { ...current[psychologist.id], rate: event.target.value },
                              }))
                              markDraftChanged(setTeamStatus)
                            }}
                          />
                        </Field>
                        <Field label="Limit tygodniowy" error={errors?.weeklyCapacity}>
                          <input
                            className="input input--capacity"
                            type="number"
                            disabled={teamStatus === 'saving'}
                            min="1"
                            step="1"
                            inputMode="numeric"
                            name={`capacity-${psychologist.id}`}
                            autoComplete="off"
                            aria-label={`Limit tygodniowy — ${psychologist.name}`}
                            value={draft.weeklyCapacity}
                            onChange={(event) => {
                              setTeam((current) => ({
                                ...current,
                                [psychologist.id]: { ...current[psychologist.id], weeklyCapacity: event.target.value },
                              }))
                              markDraftChanged(setTeamStatus)
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
                  disabled={!teamDirty || teamInvalid || teamStatus === 'saving'}
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

          {canManageStaff && (
            <StaffAccess sectionRef={(element) => { sectionRefs.current.staff = element }} />
          )}
        </div>
      </div>
    </div>
  )
}
