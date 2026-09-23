import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon, BearMark } from './icons.jsx'
import { Avatar, Button, EmptyState, IconBtn, PopItem, Popover } from './ui.jsx'
import { useActivityMonthRetry, useApp, useToasts, useWorkspaceWindow } from './store.jsx'
import {
  canAccessShellRoute,
  resolveShellRoute,
  ShellCtx,
  useShell,
} from './shell-ctx.js'
import { DEMO_ROLES } from './data.js'
import { roleLabelFor, shellRoleFor } from './auth-role.js'
import { canPerformAction, protectedPaymentsSurface } from './capability-access.js'
import { useIsCompact, useIsPhone } from './responsive.js'
import { useMinuteNow } from './clock.js'
import { TodayCockpit } from './cockpit.jsx'
import { motionOK, brandBurst } from './anim.js'
import { fmtMonthYear, monthKey, toISODate, cap, outstandingOf } from './format.js'
import { weekWorkspaceRange } from './workspace-view.js'
import { activityCurrentMonth } from './activity-workspace.js'
import { activityModuleVisible } from './tus.js'
import { BoardDrawer, Dashboard } from './views/Dashboard.jsx'
import { CalendarView } from './views/Calendar.jsx'
import { Clients, ClientDetail } from './views/Clients.jsx'
import { Team, PsychDetail } from './views/Team.jsx'
import { TusGroups } from './views/Tus.jsx'
import { TusGroupDetail } from './views/TusGroup.jsx'
import { English } from './views/English.jsx'
import { Payments } from './views/Payments.jsx'
import { Finance } from './views/Finance.jsx'
import { Reports } from './views/Reports.jsx'
import { ProtectedFinance } from './views/ProtectedFinance.jsx'
import { OwnPayments } from './views/OwnPayments.jsx'
import { ProtectedReports } from './views/ProtectedReports.jsx'
import { Profile, Settings } from './views/Settings.jsx'
import { ActivityHistory } from './views/ActivityHistory.jsx'
import { SessionDrawer } from './views/SessionForm.jsx'
import { SpecialistAbsenceDrawer } from './views/SpecialistAbsenceForm.jsx'
import { ClientDrawer } from './views/ClientForm.jsx'
import { PsychDrawer } from './views/PsychForm.jsx'
import { TusGroupDrawer, TusKidDrawer, TusClassDrawer } from './views/TusForms.jsx'
import {
  ActivityClassDrawer, ActivityGroupDrawer, ActivityMembershipDrawer,
  ActivityParticipantDrawer,
} from './views/ActivityForms.jsx'
import { CommandPalette } from './command-palette.jsx'
import {
  patchRouteViewState as patchRegistryRoute,
  readRouteViewState,
  resetRouteViewState as resetRegistryRoute,
} from './view-state.js'
import { routeFromHash, routeHref } from './routing.js'

const NAV = [
  { id: 'dashboard', label: 'Dziś', icon: 'dashboard' },
  { id: 'calendar', label: 'Grafik', icon: 'calendar' },
  { id: 'clients', label: 'Klienci', icon: 'clients' },
  { id: 'tus', label: 'Zajęcia TUS', icon: 'group' },
  { id: 'english', label: 'Angielski', icon: 'english' },
  { id: 'team', label: 'Zespół', icon: 'team' },
  { id: 'payments', label: 'Finanse', icon: 'payments' },
  { id: 'reports', label: 'Raporty', icon: 'reports' },
  { id: 'history', label: 'Historia aktywności', icon: 'clock' },
]
const CENTRE_NAV_IDS = new Set(['team', 'payments', 'reports', 'history'])

const EMPTY_CAPABILITIES = Object.freeze([])

const routeTitle = (routeName) => {
  const navItem = NAV.find((item) => item.id === routeName)
  return navItem ? navItem.label : TITLES[routeName] || ''
}

const TITLES = {
  dashboard: 'Dziś',
  calendar: 'Grafik',
  clients: 'Klienci',
  client: 'Karta klienta',
  tus: 'Zajęcia TUS',
  tusGroup: 'Grupa TUS',
  english: 'Angielski',
  team: 'Zespół',
  psych: 'Profil specjalistki',
  payments: 'Finanse',
  ledger: 'Rejestr',
  reports: 'Raporty',
  history: 'Historia aktywności',
  settings: 'Ustawienia',
  profile: 'Mój profil',
}

const VIEWS = {
  dashboard: Dashboard,
  calendar: CalendarView,
  clients: Clients,
  client: ClientDetail,
  tus: TusGroups,
  tusGroup: TusGroupDetail,
  english: English,
  team: Team,
  psych: PsychDetail,
  payments: Payments,
  ledger: Finance,
  reports: Reports,
  history: ActivityHistory,
  settings: Settings,
  profile: Profile,
}

const ACTIVE_OF = { client: 'clients', psych: 'team', tusGroup: 'tus' }

// The handler accepts Ctrl and Cmd alike; expose the chord as a tooltip.
const META_K = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘ K' : 'Ctrl K'

function AppSpecialistPayments() {
  return <OwnPayments />
}

function AppUnavailablePayments() {
  return <div className="view-head"><div>
    <div className="eyebrow">Zakres uprawnień</div>
    <h1 className="display view-head__title">Finanse <em>niedostępne</em></h1>
    <p className="view-head__sub">Dostęp do finansów nadaje osoba zarządzająca panelem.</p>
  </div></div>
}

function RetiredLedger() {
  return <div className="view-head"><div>
    <div className="eyebrow">Narzędzia arkusza</div>
    <h1 className="display view-head__title">Rejestr został <em>przeniesiony</em></h1>
    <p className="view-head__sub">Wgrywanie arkusza i eksport całej bazy znajdziesz w Finansach.</p>
  </div></div>
}

const sameRoute = (left, right) => (
  left?.name === right?.name
  && JSON.stringify(left?.params || {}) === JSON.stringify(right?.params || {})
)

// Real hash links wherever the shell navigates: plain clicks go through the
// SPA router, Cmd/Ctrl/middle clicks keep native open-in-new-tab behavior.
function navLink(navigate, name) {
  return {
    href: routeHref(name),
    onClick: (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigate(name)
    },
  }
}

export function Logotype({ light }) {
  return (
    <div className="logotype">
      <BearMark size={36} />
      <div className="logotype__name" style={light ? { color: '#fff' } : undefined}>
        <span translate="no">Bear with me</span>
        <small>Centrum terapii</small>
      </div>
    </div>
  )
}

function Sidebar({
  route,
  navigate,
  role,
  accountControls,
  className = '',
  innerRef,
  inert,
  navIds,
  canAccessRoute,
}) {
  const navRef = useRef(null)
  const pillRef = useRef(null)
  const activeId = ACTIVE_OF[route.name] || route.name
  const items = NAV.filter((item) => canAccessRoute(item.id, role) && (!navIds || navIds.includes(item.id)))
  const dailyItems = items.filter((item) => !CENTRE_NAV_IDS.has(item.id))
  const centreItems = items.filter((item) => CENTRE_NAV_IDS.has(item.id))
  const showSettings = canAccessRoute('settings', role) && (!navIds || navIds.includes('settings'))
  const itemIds = items.map((item) => item.id).join(':')

  useLayoutEffect(() => {
    const nav = navRef.current
    const pill = pillRef.current
    if (!nav || !pill) return
    const navItems = nav.querySelectorAll('.nav__item')
    const ids = [...items.map((item) => item.id), ...(showSettings ? ['settings'] : [])]
    const idx = ids.indexOf(activeId)
    const el = navItems[idx]
    if (!el) { pill.style.opacity = 0; return }
    // transform-only glide: the pill slides with translateY, height snaps
    if (motionOK()) {
      window.gsap.set(pill, { height: el.offsetHeight, opacity: 1 })
      window.gsap.to(pill, { y: el.offsetTop, duration: 0.22, ease: 'power2.out', overwrite: true })
    } else {
      Object.assign(pill.style, { transform: `translateY(${el.offsetTop}px)`, height: `${el.offsetHeight}px`, opacity: 1 })
    }
  }, [activeId, itemIds, role.id, showSettings])

  const navItem = (item) => (
    <a
      key={item.id}
      {...navLink(navigate, item.id)}
      className={`nav__item ${activeId === item.id ? 'is-active' : ''}`}
      aria-current={activeId === item.id ? 'page' : undefined}
      data-shell-reveal
    >
      <Icon name={item.icon} size={19} />
      {item.label}
    </a>
  )

  return (
    <aside className={`sidebar ${className}`} ref={innerRef} inert={inert}>
      <div className="sidebar__brand" data-shell-reveal>
        <Logotype />
      </div>
      <nav className="nav" ref={navRef} aria-label="Nawigacja główna">
        <span className="nav__pill" ref={pillRef} />
        {dailyItems.map(navItem)}
        {centreItems.length > 0 && (
          <div className="nav__section" role="group" aria-label="Centrum">
            <div className="nav__section-rule" aria-hidden="true" />
            <span className="nav__section-label">Centrum</span>
            {centreItems.map(navItem)}
          </div>
        )}
        {showSettings && (
          <>
            <div className="nav__divider" data-shell-reveal />
            <a
              {...navLink(navigate, 'settings')}
              className={`nav__item ${activeId === 'settings' ? 'is-active' : ''}`}
              aria-current={activeId === 'settings' ? 'page' : undefined}
              data-shell-reveal
            >
              <Icon name="settings" size={19} />
              Ustawienia
            </a>
          </>
        )}
      </nav>
      <div className="sidebar__foot" data-shell-reveal>
        {accountControls}
      </div>
    </aside>
  )
}

function MobileRoleControls({ appMode, role, onProfile, onRoleChange, onLogout }) {
  const { state } = useApp()
  const avatarKeyForRole = (candidate) => state.psychologists
    .find((psychologist) => psychologist.id === candidate.psychId)?.avatarKey
  return (
    <div className="mobile-account">
      <button type="button" className="mobile-account__identity" onClick={onProfile}>
        <Avatar name={role.name} avatarKey={avatarKeyForRole(role)} size={40} />
        <span>
          <b>{role.name}</b>
          <small>{roleLabelFor(role.id)}</small>
          {role.professionalTitle && <small>{role.professionalTitle}</small>}
          <small className="mobile-account__profile">Mój profil ›</small>
        </span>
      </button>
      {appMode === 'demo' && (
        <div className="mobile-account__roles" role="group" aria-label="Tryb demonstracyjny">
          <div className="mobile-account__label">Tryb demonstracyjny</div>
          {DEMO_ROLES.map((demoRole) => (
            <button
              key={demoRole.id}
              type="button"
              className={`mobile-account__role ${demoRole.id === role.id ? 'is-active' : ''}`}
              aria-pressed={demoRole.id === role.id}
              onClick={() => onRoleChange(demoRole.id)}
            >
              <Avatar name={demoRole.name} avatarKey={avatarKeyForRole(demoRole)} size={30} />
              <span>{demoRole.label} · {demoRole.name}</span>
            </button>
          ))}
        </div>
      )}
      <button type="button" className="mobile-account__logout" onClick={onLogout}>
        <Icon name="logout" size={18} />
        Wyloguj się
      </button>
    </div>
  )
}

// Compact-shell navigation: the sidebar slides in from the left as a drawer,
// with the same GSAP choreography as the form drawers (mirrored).
const PHONE_MENU_IDS = ['tus', 'english', 'team', 'payments', 'reports', 'settings']

function MobileNavDrawer({
  appMode,
  canAccessRoute,
  route,
  navigate,
  role,
  onRoleChange,
  onLogout,
  phone,
  onClose,
}) {
  const asideRef = useRef(null)
  const backRef = useRef(null)
  const closing = useRef(false)

  useEffect(() => {
    const gsap = window.gsap
    const aside = asideRef.current
    const backdrop = backRef.current
    if (motionOK() && aside) {
      gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.2 })
      gsap.fromTo(aside, { x: '-104%' }, { x: '0%', duration: 0.22, ease: 'power3.out' })
    }
    return () => {
      gsap?.killTweensOf(backdrop)
      gsap?.killTweensOf(aside)
    }
  }, [])

  const close = useCallback(() => {
    if (closing.current) return
    if (!motionOK() || !asideRef.current) return onClose()
    closing.current = true
    window.gsap.to(backRef.current, { opacity: 0, duration: 0.18 })
    window.gsap.to(asideRef.current, { x: '-104%', duration: 0.2, ease: 'power3.in', onComplete: onClose })
  }, [onClose])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  // aria-modal promises a focus trap: focus the active item on open, keep Tab
  // inside the drawer, hand focus back to the hamburger on close
  useEffect(() => {
    const opener = document.activeElement
    const aside = asideRef.current
    // querySelector('a, b') returns first in DOM order — the active item
    // must be looked up explicitly or "Pulpit" always wins
    ;(aside?.querySelector('.nav__item.is-active') || aside?.querySelector('.nav__item'))?.focus()
    const onTab = (e) => {
      if (e.key !== 'Tab' || !aside) return
      const els = [...aside.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null)
      if (!els.length) return
      const first = els[0]
      const last = els[els.length - 1]
      const inside = aside.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onTab)
    return () => {
      document.removeEventListener('keydown', onTab)
      if (opener && typeof opener.focus === 'function') opener.focus()
    }
  }, [])

  return (
    <div role="dialog" aria-modal="true" aria-label="Nawigacja">
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <Sidebar
        route={route}
        navigate={(name, params) => { navigate(name, params); close() }}
        role={role}
        canAccessRoute={canAccessRoute}
        accountControls={phone ? (
          <MobileRoleControls
            appMode={appMode}
            role={role}
            onProfile={() => { navigate('profile'); close() }}
            onRoleChange={(roleId) => { onRoleChange(roleId); close() }}
            onLogout={onLogout}
          />
        ) : undefined}
        className={`sidebar--drawer ${phone ? 'sidebar--phone' : ''}`}
        innerRef={asideRef}
        navIds={phone ? PHONE_MENU_IDS : undefined}
      />
    </div>
  )
}

// Phone-first bottom navigation: the daily work and client list stay direct;
// programme-specific and secondary destinations remain in More.
const PHONE_TAB_IDS = new Set(['dashboard', 'calendar', 'clients'])
const PHONE_TABS = NAV.filter((item) => PHONE_TAB_IDS.has(item.id))

function MobileTabbar({ route, navigate, canAccessRoute, onAdd, onMenu }) {
  const barRef = useRef(null)
  const [pill, setPill] = useState(null)
  const activeId = ACTIVE_OF[route.name] || route.name
  const activeTabId = PHONE_TAB_IDS.has(activeId) ? activeId : 'menu'

  // the gliding blob behind the active icon — measured, then moved via CSS
  // transition (same pattern as Segmented, survives orientation changes)
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const measure = () => {
      const btn = bar.querySelector(`.tabbar__item[data-id="${activeTabId}"]`)
      if (!btn) return setPill(null)
      setPill({ left: btn.offsetLeft + (btn.offsetWidth - 46) / 2 })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [activeTabId])

  useEffect(() => {
    if (!motionOK() || !barRef.current) return
    window.gsap.fromTo(
      barRef.current,
      { y: 12 },
      { y: 0, duration: 0.22, ease: 'power3.out', clearProps: 'transform' }
    )
  }, [])

  const tab = (n) => (
    <a
      key={n.id}
      {...navLink(navigate, n.id)}
      data-id={n.id}
      className={`tabbar__item ${activeId === n.id ? 'is-active' : ''}`}
      aria-current={activeId === n.id ? 'page' : undefined}
    >
      <Icon name={n.icon} size={21} />
      <span>{n.id === 'calendar' ? 'Grafik' : n.label}</span>
    </a>
  )

  return (
    <nav className="tabbar" ref={barRef} aria-label="Nawigacja dolna">
      {pill && <span className="tabbar__pill" style={{ transform: `translateX(${pill.left}px)` }} />}
      <div className="tabbar__side">
        {PHONE_TABS.slice(0, 2).filter((item) => canAccessRoute(item.id)).map(tab)}
      </div>
      {onAdd && (
        <button className="tabbar__fab" onClick={onAdd} aria-label="Nowa sesja">
          <Icon name="plus" size={22} />
        </button>
      )}
      <div className="tabbar__side">
        {PHONE_TABS.slice(2).filter((item) => canAccessRoute(item.id)).map(tab)}
        <button
          type="button"
          data-id="menu"
          className={`tabbar__item ${activeTabId === 'menu' ? 'is-active' : ''}`}
          onClick={onMenu}
          aria-current={activeTabId === 'menu' ? 'page' : undefined}
        >
          <Icon name="menu" size={21} />
          <span>Więcej</span>
        </button>
      </div>
    </nav>
  )
}

function Topbar({
  appMode,
  actor,
  route,
  navigate,
  canAccessRoute,
  role,
  setDemoRole,
  roleMenuOpen,
  setRoleMenuOpen,
  showAccountControls,
  onCockpitChange,
  onLogout,
  onSearch,
  onMenu,
  overlayKey,
  todayWorkspaceRange,
  todayWorkspaceState,
}) {
  const { state } = useApp()
  const titleRef = useRef(null)
  const title = routeTitle(route.name)
  const parentRoute = ACTIVE_OF[route.name]
  const parentTitle = parentRoute ? routeTitle(parentRoute) : null
  const controlsInert = overlayKey ? '' : undefined
  const accountRoleLabel = roleLabelFor(role.id)
  const roleAvatarKey = state.psychologists
    .find((psychologist) => psychologist.id === role.psychId)?.avatarKey

  useEffect(() => {
    if (!motionOK() || !titleRef.current) return
    window.gsap.fromTo(
      titleRef.current,
      { y: 6 },
      { y: 0, duration: 0.2, ease: 'power2.out', clearProps: 'transform' }
    )
  }, [title])

  return (
    <header className="topbar">
      {onMenu && (
        <IconBtn
          name="menu"
          label="Otwórz menu"
          className="topbar__menu"
          onClick={onMenu}
          disabled={!!overlayKey}
          inert={controlsInert}
          data-shell-reveal
        />
      )}
      <div className="topbar__title" ref={titleRef} data-shell-reveal>
        {parentRoute ? (
          <>
            <a
              {...navLink(navigate, parentRoute)}
              className="topbar__parent"
              aria-label={`Wróć do widoku ${parentTitle}`}
            >
              <span className="topbar__phone-back" aria-hidden="true">‹ </span>{parentTitle}
            </a>
            <span className="topbar__separator" aria-hidden="true">›</span>
            <b className="topbar__detail-title">{title}</b>
          </>
        ) : <b>{title}</b>}
      </div>
      <div className="topbar__right" data-shell-reveal>
        <div className="topbar__controls" inert={controlsInert}>
          <button className="cmd-trigger" onClick={onSearch} title={`Szukaj w panelu (${META_K})`} aria-label="Szukaj klienta, osoby lub strony…">
            <Icon name="search" size={15} />
            <span>Szukaj klienta, osoby lub strony…</span>
          </button>
          {showAccountControls && (
            <Popover
              align="right"
              ariaLabel="Twoje konto"
              focusOnOpen
              open={roleMenuOpen}
              setOpen={setRoleMenuOpen}
              trigger={
                <button
                  type="button"
                  className="userchip userchip--button userchip--authenticated"
                  onClick={() => setRoleMenuOpen(!roleMenuOpen)}
                  aria-label="Twoje konto"
                >
                  <Avatar name={role.name} avatarKey={roleAvatarKey} size={37} />
                  <span>
                    {appMode === 'demo' && <span className="userchip__mode">Tryb demonstracyjny</span>}
                    <span className="userchip__name">{role.name}</span>
                    <span className="userchip__role">{accountRoleLabel}</span>
                    {role.professionalTitle && <span className="userchip__role">{role.professionalTitle}</span>}
                  </span>
                </button>
              }
            >
              <div className="account-menu__identity">
                <Avatar name={role.name} avatarKey={roleAvatarKey} size={40} />
                <span>
                  <strong>{role.name}</strong>
                  <small>{accountRoleLabel}</small>
                  {role.professionalTitle && <small>{role.professionalTitle}</small>}
                  {actor?.email && <small>{actor.email}</small>}
                </span>
              </div>
              <PopItem role="menuitem" onClick={() => navigate('profile')}>Mój profil</PopItem>
              {((appMode === 'demo' && role.id === 'owner')
                || (appMode === 'app' && canAccessRoute('settings'))) && (
                <PopItem
                  role="menuitem"
                  onClick={() => navigate('settings', appMode === 'demo' ? { section: 'center' } : undefined)}
                >
                  Ustawienia centrum
                </PopItem>
              )}
              {appMode === 'demo' && (
                <>
                  <div className="popover__divider" />
                  <div className="popover__label">Tryb demonstracyjny</div>
                  {DEMO_ROLES.map((demoRole) => (
                    <PopItem
                      key={demoRole.id}
                      role="button"
                      on={demoRole.id === role.id}
                      pressed
                      onClick={() => {
                        setDemoRole(demoRole.id)
                        setRoleMenuOpen(false)
                      }}
                    >
                      {demoRole.label} · {demoRole.name}
                    </PopItem>
                  ))}
                </>
              )}
              <div className="popover__divider" />
              <PopItem role="menuitem" className="popover__item--danger" onClick={onLogout}>Wyloguj się</PopItem>
            </Popover>
          )}
        </div>
        {(appMode !== 'app' || route.name !== 'dashboard') && (
          <TodayCockpit
            open={overlayKey === 'cockpit'}
            onOpenChange={onCockpitChange}
            disabled={!!overlayKey}
            workspaceRange={todayWorkspaceRange}
            workspaceState={todayWorkspaceState}
          />
        )}
      </div>
    </header>
  )
}

// Celebrates the moment any month's outstanding balance reaches zero,
// no matter which view settled the last payment.
function useMonthSettled() {
  const { state, toast } = useApp()
  const prev = useRef(null)
  useEffect(() => {
    const byMonth = {}
    state.sessions.forEach((s) => {
      const ym = monthKey(s.date)
      byMonth[ym] = (byMonth[ym] || 0) + outstandingOf(s)
    })
    if (prev.current) {
      for (const ym of Object.keys(prev.current)) {
        if (prev.current[ym] > 0 && (byMonth[ym] || 0) === 0) {
          // order matters: brandBurst skips zero-size anchors, so fall through
          // to whichever attention signal the current view actually shows
          brandBurst(
            document.querySelector('.figures__item--amber') ||
            document.querySelector('.stat--amber') ||
            document.querySelector('.today-chip')
          )
          toast(`${cap(fmtMonthYear(ym))} został rozliczony w całości`)
          break
        }
      }
    }
    prev.current = byMonth
  }, [state.sessions, toast])
}

// Modal confirm for a blocked route commit (dirty form/draft). Focus lands on
// the safe choice; Escape and backdrop cancel.
function LeaveConfirmDialog({ onCancel, onConfirm }) {
  const dialogRef = useRef(null)
  const cardRef = useRef(null)
  useEffect(() => {
    const dialog = dialogRef.current
    const opener = document.activeElement
    dialog?.showModal()
    cardRef.current?.querySelector('button')?.focus()
    return () => {
      if (dialog?.open) dialog.close()
      requestAnimationFrame(() => {
        if (opener?.isConnected) {
          opener.focus({ preventScroll: true })
        }
      })
    }
  }, [])
  return (
    <dialog
      className="modal-layer"
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby="leave-confirm-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <div className="leave-confirm">
        <div className="leave-confirm__backdrop" onClick={onCancel} />
        <div
          className="leave-confirm__card"
          ref={cardRef}
        >
          <h2 className="display" id="leave-confirm-title">Wyjść bez zapisywania?</h2>
          <p>Wprowadzone zmiany przepadną.</p>
          <div className="leave-confirm__actions">
            <Button onClick={onCancel}>Wróć do edycji</Button>
            <Button variant="danger" onClick={onConfirm}>Wyjdź bez zapisywania</Button>
          </div>
        </div>
      </div>
    </dialog>
  )
}

export function Shell({
  appMode = 'demo',
  authStatus = 'authenticated',
  onLogout,
  session = null,
}) {
  const { state, dispatch, workspace } = useApp()
  const { clearToasts, toast } = useToasts()
  const isApp = appMode === 'app'
  const appRole = useMemo(
    () => isApp ? shellRoleFor(session?.actor) : null,
    [isApp, session?.actor]
  )
  const role = appRole
    || DEMO_ROLES.find((demoRole) => demoRole.id === state.demoRoleId)
    || DEMO_ROLES[0]
  const actor = isApp ? session.actor : null
  const capabilities = isApp ? session.capabilities : EMPTY_CAPABILITIES
  const dataMode = isApp ? session.dataMode : 'fictional'
  const environment = isApp ? session.environment : null
  const authorityGeneration = isApp ? session.authorityRevision : 0
  const routeAuthority = useMemo(() => ({
    appMode,
    capabilities,
    roleId: role.id,
  }), [appMode, capabilities, role.id])
  const canAccessRoute = useCallback(
    (routeName, targetRole = role) => canAccessShellRoute({
      appMode,
      capabilities,
      roleId: targetRole.id,
    }, routeName),
    [appMode, capabilities, role]
  )
  const paymentsSurface = isApp
    ? protectedPaymentsSurface(capabilities, actor?.specialistId) : null
  const now = useMinuteNow()
  const currentActivityMonth = useMemo(() => activityCurrentMonth(now), [now])
  const needsActivityDiscovery = isApp && role.scope === 'own'
    && !capabilities.includes('tus.manage') && canAccessRoute('tus')
  const activityDiscovery = useActivityMonthRetry(
    currentActivityMonth, needsActivityDiscovery,
  )
  const canShowNavigationRoute = useCallback(
    (routeName, targetRole = role) => {
      if (!canAccessRoute(routeName, targetRole)) return false
      if (isApp && ['tus', 'english'].includes(routeName)) {
        return activityModuleVisible({
          capabilities,
          state: workspace.activities?.state,
          specialistId: actor?.specialistId,
          program: routeName,
          month: currentActivityMonth,
        })
      }
      return !(isApp && routeName === 'payments' && paymentsSurface === 'unavailable')
    },
    [actor?.specialistId, canAccessRoute, capabilities, currentActivityMonth, isApp, paymentsSurface, role, workspace.activities?.state],
  )
  const today = toISODate(now)
  const todayWorkspaceRange = useMemo(() => weekWorkspaceRange(today), [today])
  const [storedRoute, setRoute] = useState(() => {
    const requested = routeFromHash(window.location.hash)
    return requested || resolveShellRoute(routeAuthority, null) || { name: 'settings' }
  })
  const route = useMemo(
    () => resolveShellRoute(routeAuthority, storedRoute) || { name: 'settings' },
    [routeAuthority, storedRoute]
  )
  const canLoadTodayWorkspace = canAccessRoute('dashboard')
  const requestedTodayWorkspaceState = useWorkspaceWindow(
    todayWorkspaceRange,
    isApp && canLoadTodayWorkspace,
  )
  const todayWorkspaceState = isApp && !canLoadTodayWorkspace
    ? 'unavailable'
    : requestedTodayWorkspaceState
  const [drawer, setDrawer] = useState(null)
  const [overlay, setOverlay] = useState(null)
  const [roleMenuOpen, setRoleMenuOpen] = useState(false)
  const isCompact = useIsCompact()
  const isPhone = useIsPhone()
  const viewRef = useRef(null)
  const contentRef = useRef(null)
  const shellRef = useRef(null)
  const viewRegistryRef = useRef({})
  const routeRef = useRef(route)
  const roleRef = useRef(role)
  const routeAuthorityRef = useRef(routeAuthority)
  const unavailableRouteToastRef = useRef(false)
  // distinguishes hash-driven route commits (replace) from in-app navigation
  // (push) so browser back/forward walks views, not filter tweaks
  const fromHashRef = useRef(false)
  // role switches intentionally drop a previous route's params
  const stripParamsRef = useRef(false)
  // the hash as of the last shell commit — the push/replace decision reads
  // this because a mounted view may have already rewritten the live hash with
  // its own filter params earlier in the same commit
  const committedHashRef = useRef(window.location.hash)
  // leave guards: dirty views/forms register "is dirty?" checks, and every
  // route commit (sidebar, back/forward, role switch) asks before discarding
  const leaveGuardsRef = useRef(new Set())
  const leaveBypassRef = useRef(false)
  const [pendingLeave, setPendingLeave] = useState(null)
  const routeParamsKey = JSON.stringify(route.params || {})
  routeRef.current = route
  roleRef.current = role
  routeAuthorityRef.current = routeAuthority
  if (route !== storedRoute) unavailableRouteToastRef.current = true

  // A refreshed authority can invalidate the stored route before the shell
  // state commit. Derive the safe route during render so the old view never
  // paints, then synchronously discard stale shell state and replace the hash.
  useLayoutEffect(() => {
    if (route === storedRoute) return
    const nextHash = routeHref(route.name)
    viewRegistryRef.current = {}
    leaveGuardsRef.current.clear()
    setPendingLeave(null)
    setRoleMenuOpen(false)
    setDrawer(null)
    setOverlay(null)
    clearToasts()
    if (window.location.hash !== nextHash) {
      window.history.replaceState(window.history.state, '', nextHash)
    }
    committedHashRef.current = nextHash
    routeRef.current = route
    setRoute(route)
  }, [clearToasts, route, storedRoute])

  useEffect(() => {
    if (!unavailableRouteToastRef.current) return undefined
    const timeout = window.setTimeout(() => {
      if (!unavailableRouteToastRef.current) return
      unavailableRouteToastRef.current = false
      clearToasts()
      toast('Nie możemy otworzyć tego widoku.', 'alert', { key: 'unavailable-route' })
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [clearToasts, route, storedRoute, toast])

  useEffect(() => {
    const viaHash = fromHashRef.current
    fromHashRef.current = false
    const stripParams = stripParamsRef.current
    stripParamsRef.current = false
    const currentHash = window.location.hash
    const currentName = routeFromHash(currentHash)?.name
    const previousName = routeFromHash(committedHashRef.current)?.name
    // view-owned filter params survive a same-view commit; the shell strips
    // them when it owns the params or intentionally resets them
    const nextHash = route.params || stripParams || currentName !== route.name
      ? routeHref(route.name, route.params)
      : currentHash
    const viewChanged = previousName !== route.name
    const previousAccessible = previousName
      && canAccessShellRoute(routeAuthorityRef.current, previousName)
    if (!viaHash && previousAccessible && viewChanged) {
      window.history.pushState(window.history.state, '', nextHash)
    } else if (nextHash !== currentHash) {
      window.history.replaceState(window.history.state, '', nextHash)
    }
    committedHashRef.current = nextHash
  }, [route.name, routeParamsKey])

  // External hash changes (back/forward, manual edits, bookmarks while the app
  // is open) navigate too. The writer above uses pushState/replaceState, which
  // never fire hashchange, so there is no loop.
  useEffect(() => {
    const onHashChange = (event) => {
      const currentRole = roleRef.current
      const currentRoute = routeRef.current
      const requestedHash = event?.newURL
        ? new URL(event.newURL, window.location.href).hash
        : window.location.hash
      const requested = routeFromHash(requestedHash)
      const nextRoute = resolveShellRoute(routeAuthorityRef.current, requested)
        || { name: 'settings' }
      const rejectedRequest = !sameRoute(requested, nextRoute)
      if (
        sameRoute(currentRoute, nextRoute)
      ) {
        const nextHash = routeHref(nextRoute.name, nextRoute.params)
        if (window.location.hash !== nextHash) {
          clearToasts()
          toast('Nie możemy otworzyć tego widoku.', 'alert')
          window.history.replaceState(window.history.state, '', nextHash)
        }
        committedHashRef.current = nextHash
        return
      }
      const commit = () => {
        viewRegistryRef.current = patchRegistryRoute(
          viewRegistryRef.current,
          currentRole.id,
          currentRoute.name,
          { scrollY: contentRef.current?.scrollTop || 0 }
        )
        fromHashRef.current = true
        routeRef.current = nextRoute
        setRoleMenuOpen(false)
        setOverlay(null)
        setRoute(nextRoute)
        if (rejectedRequest) {
          clearToasts()
          toast('Nie możemy otworzyć tego widoku.', 'alert', { key: 'unavailable-route' })
        }
      }
      if (leaveBlocked()) {
        setPendingLeave(() => () => requestLeave(commit))
        return
      }
      commit()
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [clearToasts, toast])

  useMonthSettled()

  // widening past the breakpoint restores the static sidebar
  useEffect(() => {
    if (!isCompact) setOverlay((active) => active === 'navigation' ? null : active)
  }, [isCompact])

  // entrance choreography
  useEffect(() => {
    if (!motionOK() || !shellRef.current) return
    const items = shellRef.current.querySelectorAll('[data-shell-reveal]')
    window.gsap.fromTo(
      items,
      { x: -10 },
      { x: 0, duration: 0.22, ease: 'power3.out', stagger: { amount: 0.03 }, clearProps: 'transform' }
    )
  }, [])

  // Shell owns the one active overlay. Opening a new one unmounts every
  // sibling first, so no dialog can sit behind another dialog.
  const openOverlay = useCallback((key) => {
    setRoleMenuOpen(false)
    setOverlay(key)
  }, [])
  const closeOverlay = useCallback((key) => {
    setOverlay((active) => !key || active === key ? null : active)
  }, [])

  // global search shortcut — registered once, so it reads the active overlay
  // through a ref and toggles the palette without stacking it over a sibling.
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (document.querySelector('dialog:modal')) return
        setRoleMenuOpen(false)
        setOverlay((active) => active === 'palette' ? null : 'palette')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const getViewState = useCallback((routeName, defaults = {}) => (
    readRouteViewState(viewRegistryRef.current, role.id, routeName, defaults)
  ), [role.id])

  const registerLeaveGuard = useCallback((fn) => {
    leaveGuardsRef.current.add(fn)
    return () => leaveGuardsRef.current.delete(fn)
  }, [])
  const leaveBlocked = () => (
    !leaveBypassRef.current && [...leaveGuardsRef.current].some((isDirty) => isDirty())
  )
  const requestLeave = useCallback((proceed) => {
    leaveBypassRef.current = true
    proceed()
    leaveBypassRef.current = false
  }, [])
  const cancelLeave = useCallback(() => {
    setPendingLeave(null)
    // a blocked hashchange already moved the URL — put the current route back
    const current = routeRef.current
    const hash = routeHref(current.name, current.params)
    if (window.location.hash !== hash) {
      window.history.replaceState(window.history.state, '', hash)
    }
  }, [])

  const patchViewState = useCallback((routeName, patch) => {
    viewRegistryRef.current = patchRegistryRoute(viewRegistryRef.current, role.id, routeName, patch)
  }, [role.id])

  const resetViewState = useCallback((routeName) => {
    viewRegistryRef.current = resetRegistryRoute(viewRegistryRef.current, role.id, routeName)
  }, [role.id])

  const navigate = useCallback((name, params, afterCommit) => {
    const currentRole = roleRef.current
    const currentRoute = routeRef.current
    if (!canAccessShellRoute(routeAuthorityRef.current, name)) return
    if (currentRoute.name === name && JSON.stringify(currentRoute.params) === JSON.stringify(params)) return
    if (leaveBlocked()) {
      setPendingLeave(() => () => requestLeave(() => navigate(name, params, afterCommit)))
      return
    }
    setRoleMenuOpen(false)
    setOverlay(null)
    viewRegistryRef.current = patchRegistryRoute(
      viewRegistryRef.current,
      currentRole.id,
      currentRoute.name,
      { scrollY: contentRef.current?.scrollTop || 0 }
    )
    const nextRoute = { name, params }
    routeRef.current = nextRoute
    setRoute(nextRoute)
    afterCommit?.()
  }, [requestLeave])

  const setDemoRole = useCallback((roleId) => {
    if (isApp) return
    const nextRole = DEMO_ROLES.find((demoRole) => demoRole.id === roleId)
    if (!nextRole) return
    const currentRole = roleRef.current
    if (nextRole.id === currentRole.id) return
    const currentRoute = routeRef.current
    viewRegistryRef.current = patchRegistryRoute(
      viewRegistryRef.current,
      currentRole.id,
      currentRoute.name,
      { scrollY: contentRef.current?.scrollTop || 0 }
    )
    const parentRoute = ACTIVE_OF[currentRoute.name]
    const candidate = parentRoute || currentRoute.name
    const nextRoute = {
      name: canAccessShellRoute({
        appMode: 'demo',
        capabilities: EMPTY_CAPABILITIES,
        roleId: nextRole.id,
      }, candidate) ? candidate : 'dashboard',
    }
    if (leaveBlocked()) {
      setPendingLeave(() => () => requestLeave(() => setDemoRole(roleId)))
      return
    }
    // Clear scoped actions in the same event as the authority change so no
    // sensitive toast can paint once under the incoming role.
    clearToasts()
    stripParamsRef.current = true
    routeRef.current = nextRoute
    roleRef.current = nextRole
    setRoute(nextRoute)
    dispatch({ type: 'SET_DEMO_ROLE', roleId })
  }, [clearToasts, dispatch, isApp, requestLeave])

  useLayoutEffect(() => {
    const { scrollY } = readRouteViewState(viewRegistryRef.current, role.id, route.name, { scrollY: 0 })
    if (contentRef.current) contentRef.current.scrollTop = Number.isFinite(scrollY) ? scrollY : 0
  }, [role.id, route.name, routeParamsKey])

  const setRoleMenu = useCallback((open) => {
    if (open) {
      setOverlay(null)
    }
    setRoleMenuOpen(open)
  }, [])
  const openSessionForm = useCallback((opts = {}) => {
    if (isApp && !canPerformAction(capabilities, opts.session
      ? 'appointment.edit' : 'appointment.create')) return
    setDrawer({ kind: 'session', opts })
    openOverlay('drawer')
  }, [capabilities, isApp, openOverlay])
  const openSpecialistAbsenceForm = useCallback((opts = {}) => {
    if (isApp && !canPerformAction(capabilities, 'appointment.edit')) return
    setDrawer({ kind: 'specialistAbsence', opts })
    openOverlay('drawer')
  }, [capabilities, isApp, openOverlay])
  const openClientForm = useCallback((opts = {}) => {
    if (isApp) return
    setDrawer({ kind: 'client', opts })
    openOverlay('drawer')
  }, [isApp, openOverlay])
  const openPsychForm = useCallback((opts = {}) => {
    if (isApp) return
    setDrawer({ kind: 'psych', opts })
    openOverlay('drawer')
  }, [isApp, openOverlay])
  const openTusGroupForm = useCallback((opts = {}) => {
    if (isApp) return
    setDrawer({ kind: 'tusGroup', opts })
    openOverlay('drawer')
  }, [isApp, openOverlay])
  const openTusKidForm = useCallback((opts = {}) => {
    if (isApp) return
    setDrawer({ kind: 'tusKid', opts })
    openOverlay('drawer')
  }, [isApp, openOverlay])
  const openTusClassForm = useCallback((opts = {}) => {
    if (isApp) return
    setDrawer({ kind: 'tusClass', opts })
    openOverlay('drawer')
  }, [isApp, openOverlay])
  const openActivityGroupForm = useCallback((opts = {}) => {
    const actionId = opts.group ? 'activity.group.edit' : 'activity.group.create'
    if (!isApp || !canPerformAction(capabilities, actionId)) return
    setDrawer({ kind: 'activityGroup', opts })
    openOverlay('drawer')
  }, [capabilities, isApp, openOverlay])
  const openActivityParticipantForm = useCallback((opts = {}) => {
    const actionId = opts.participant ? 'activity.participant.edit' : 'activity.participant.create'
    if (!isApp || !canPerformAction(capabilities, actionId)) return
    setDrawer({ kind: 'activityParticipant', opts })
    openOverlay('drawer')
  }, [capabilities, isApp, openOverlay])
  const openActivityMembershipForm = useCallback((opts = {}) => {
    const actionId = opts.membership ? 'activity.membership.edit' : 'activity.membership.create'
    if (!isApp || !canPerformAction(capabilities, actionId)) return
    setDrawer({ kind: 'activityMembership', opts })
    openOverlay('drawer')
  }, [capabilities, isApp, openOverlay])
  const openActivityClassForm = useCallback((opts = {}) => {
    const actionId = opts.activityClass ? 'activity.class.edit' : 'activity.class.create'
    if (!isApp || !canPerformAction(capabilities, actionId)) return
    setDrawer({ kind: 'activityClass', opts })
    openOverlay('drawer')
  }, [capabilities, isApp, openOverlay])
  const openTeamBoard = useCallback(() => {
    if (isApp) return
    setDrawer({ kind: 'board' })
    openOverlay('drawer')
  }, [isApp, openOverlay])
  const closeDrawer = useCallback(() => {
    closeOverlay('drawer')
    setDrawer(null)
  }, [closeOverlay])

  // Moving focus after the immediate route commit gives screen-reader and keyboard users the destination
  // context without interrupting the existing live-region announcement.
  useEffect(() => {
    viewRef.current?.focus({ preventScroll: true })
  }, [role.id, route.name, routeParamsKey])

  const View = !isApp ? VIEWS[route.name] || Dashboard
    : route.name === 'payments' && paymentsSurface === 'own' ? AppSpecialistPayments
      : route.name === 'payments' && paymentsSurface === 'centre' ? ProtectedFinance
        : route.name === 'payments' ? AppUnavailablePayments
        : route.name === 'ledger' ? RetiredLedger
          : route.name === 'reports' ? ProtectedReports
            : VIEWS[route.name] || Dashboard
  const hasOverlay = overlay !== null
  const handleCockpitChange = useCallback((open) => {
    if (open) openOverlay('cockpit')
    else closeOverlay('cockpit')
  }, [closeOverlay, openOverlay])
  const toggleSearch = useCallback(() => {
    setRoleMenuOpen(false)
    setOverlay((active) => active === 'palette' ? null : 'palette')
  }, [])
  const openNavigation = useCallback(() => openOverlay('navigation'), [openOverlay])
  const closeNavigation = useCallback(() => closeOverlay('navigation'), [closeOverlay])
  const openNewSession = useCallback(() => openSessionForm(), [openSessionForm])
  const canCreateSession = !isApp || (
    workspace.status !== 'read-only-error'
    && canPerformAction(capabilities, 'appointment.create')
  )
  const shellValue = useMemo(() => ({
    actor,
    appMode,
    authorityGeneration,
    capabilities,
    activityDiscovery: needsActivityDiscovery ? {
      month: currentActivityMonth,
      state: activityDiscovery.state,
      retry: activityDiscovery.retry,
    } : null,
    dataMode,
    environment,
    role,
    setDemoRole: isApp ? undefined : setDemoRole,
    canAccess: canAccessRoute,
    canShowInNavigation: canShowNavigationRoute,
    route,
    navigate,
    getViewState,
    patchViewState,
    resetViewState,
    openSessionForm,
    openSpecialistAbsenceForm,
    openClientForm,
    openPsychForm,
    openTusGroupForm,
    openTusKidForm,
    openTusClassForm,
    openActivityGroupForm,
    openActivityParticipantForm,
    openActivityMembershipForm,
    openActivityClassForm,
    openTeamBoard,
    registerLeaveGuard,
  }), [
    getViewState, navigate, openClientForm, openPsychForm, openSessionForm, openSpecialistAbsenceForm, openTeamBoard,
    openActivityClassForm, openActivityGroupForm, openActivityMembershipForm, openActivityParticipantForm,
    openTusClassForm, openTusGroupForm, openTusKidForm, patchViewState, registerLeaveGuard,
    actor, activityDiscovery.retry, activityDiscovery.state, appMode, authorityGeneration, canAccessRoute,
    canShowNavigationRoute, capabilities, currentActivityMonth, dataMode, environment, isApp,
    needsActivityDiscovery, resetViewState, role, route, setDemoRole,
  ])

  return (
    <ShellCtx.Provider value={shellValue}>
      <a
        className="skip-link"
        href="#main-content"
        inert={hasOverlay ? '' : undefined}
        onClick={(event) => {
          event.preventDefault()
          contentRef.current?.focus({ preventScroll: true })
          contentRef.current?.scrollIntoView({ block: 'start' })
        }}
      >Przejdź do treści</a>
      <div
        className="shell"
        ref={shellRef}
        aria-busy={isApp && authStatus === 'refreshing'}
      >
        {!isCompact && (
          <Sidebar
            route={route}
            navigate={navigate}
            role={role}
            canAccessRoute={canShowNavigationRoute}
            inert={hasOverlay ? '' : undefined}
          />
        )}
        <div className="main">
          <Topbar
            appMode={appMode}
            actor={actor}
            route={route}
            navigate={navigate}
            canAccessRoute={canShowNavigationRoute}
            role={role}
            setDemoRole={setDemoRole}
            roleMenuOpen={roleMenuOpen}
            setRoleMenuOpen={setRoleMenu}
            showAccountControls={!isPhone}
            onCockpitChange={handleCockpitChange}
            onLogout={onLogout}
            onSearch={toggleSearch}
            onMenu={isCompact && !isPhone ? openNavigation : undefined}
            overlayKey={overlay}
            todayWorkspaceRange={todayWorkspaceRange}
            todayWorkspaceState={todayWorkspaceState}
          />
          {isApp && dataMode === 'fictional' && (
            <div className="environment-strip" role="status">Wersja testowa - nie wpisuj prawdziwych danych klientów</div>
          )}
          <main
            id="main-content"
            className={`content ${route.name === 'dashboard' ? 'content--dashboard' : ''}`}
            ref={contentRef}
            tabIndex={-1}
            inert={hasOverlay ? '' : undefined}
          >
            <div className="view" ref={viewRef} tabIndex={-1} key={`${role.id}:${route.name}:${routeParamsKey}`}>
              <View
                params={route.params || {}}
                todayWorkspaceRange={todayWorkspaceRange}
                todayWorkspaceState={todayWorkspaceState}
              />
            </div>
          </main>
        </div>
      </div>
      {/* view changes are announced — the router moves no focus by itself */}
      <div className="sr-only" aria-live="polite">{routeTitle(route.name)}</div>
      {isPhone && (
        <div inert={hasOverlay ? '' : undefined}>
          <MobileTabbar
            route={route}
            navigate={navigate}
            canAccessRoute={canShowNavigationRoute}
            onAdd={canCreateSession ? openNewSession : undefined}
            onMenu={openNavigation}
          />
        </div>
      )}
      {isCompact && overlay === 'navigation' && (
        <MobileNavDrawer
          appMode={appMode}
          canAccessRoute={canShowNavigationRoute}
          route={route}
          navigate={navigate}
          role={role}
          onRoleChange={setDemoRole}
          onLogout={onLogout}
          phone={isPhone}
          onClose={closeNavigation}
        />
      )}
      {overlay === 'drawer' && drawer?.kind === 'session' && <SessionDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {overlay === 'drawer' && drawer?.kind === 'specialistAbsence' && <SpecialistAbsenceDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {!isApp && overlay === 'drawer' && drawer?.kind === 'client' && <ClientDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {!isApp && overlay === 'drawer' && drawer?.kind === 'psych' && <PsychDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {!isApp && overlay === 'drawer' && drawer?.kind === 'tusGroup' && <TusGroupDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {!isApp && overlay === 'drawer' && drawer?.kind === 'tusKid' && <TusKidDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {!isApp && overlay === 'drawer' && drawer?.kind === 'tusClass' && <TusClassDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {isApp && overlay === 'drawer' && drawer?.kind === 'activityGroup' && <ActivityGroupDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {isApp && overlay === 'drawer' && drawer?.kind === 'activityParticipant' && <ActivityParticipantDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {isApp && overlay === 'drawer' && drawer?.kind === 'activityMembership' && <ActivityMembershipDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {isApp && overlay === 'drawer' && drawer?.kind === 'activityClass' && <ActivityClassDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {!isApp && overlay === 'drawer' && drawer?.kind === 'board' && <BoardDrawer onClose={closeDrawer} />}
      {overlay === 'palette' && <CommandPalette nav={NAV} onClose={() => closeOverlay('palette')} />}
      {pendingLeave && (
        <LeaveConfirmDialog
          onCancel={cancelLeave}
          onConfirm={() => {
            const proceed = pendingLeave
            setPendingLeave(null)
            proceed()
          }}
        />
      )}
    </ShellCtx.Provider>
  )
}
