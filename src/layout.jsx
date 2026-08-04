import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon, BearMark } from './icons.jsx'
import { Avatar, Button, EmptyState, IconBtn, PopItem, Popover } from './ui.jsx'
import { useApp, useToasts } from './store.jsx'
import { ShellCtx } from './shell-ctx.js'
import { DEMO_ROLES } from './data.js'
import { shellRoleFor } from './auth-role.js'
import { useIsCompact, useIsPhone } from './responsive.js'
import { TodayCockpit } from './cockpit.jsx'
import { motionOK, brandBurst } from './anim.js'
import { fmtMonthYear, monthKey, toISODate, fmtWeekday, cap, sessionsWord, outstandingOf } from './format.js'
import { todayWorkspace } from './workspace.js'
import { BoardDrawer, Dashboard } from './views/Dashboard.jsx'
import { CalendarView } from './views/Calendar.jsx'
import { Clients, ClientDetail } from './views/Clients.jsx'
import { Team, PsychDetail } from './views/Team.jsx'
import { TusGroups } from './views/Tus.jsx'
import { TusGroupDetail } from './views/TusGroup.jsx'
import { Payments } from './views/Payments.jsx'
import { Reports } from './views/Reports.jsx'
import { Settings } from './views/Settings.jsx'
import { SessionDrawer } from './views/SessionForm.jsx'
import { ClientDrawer } from './views/ClientForm.jsx'
import { PsychDrawer } from './views/PsychForm.jsx'
import { TusGroupDrawer, TusKidDrawer, TusClassDrawer } from './views/TusForms.jsx'
import { CommandPalette } from './command-palette.jsx'
import {
  patchRouteViewState as patchRegistryRoute,
  readRouteViewState,
  resetRouteViewState as resetRegistryRoute,
} from './view-state.js'
import { routeFromHash, routeHref } from './routing.js'

const NAV = [
  { id: 'dashboard', label: 'Dziś', icon: 'dashboard' },
  { id: 'calendar', label: 'Kalendarz', icon: 'calendar' },
  { id: 'clients', label: 'Klienci', icon: 'clients' },
  { id: 'tus', label: 'Zajęcia TUS', icon: 'group' },
  { id: 'team', label: 'Zespół', icon: 'team' },
  { id: 'payments', label: 'Finanse', icon: 'payments' },
  { id: 'reports', label: 'Raporty', icon: 'reports' },
]

const DEMO_ROLE_NAV = {
  owner: ['dashboard', 'calendar', 'clients', 'tus', 'team', 'payments', 'reports', 'settings'],
  coordinator: ['dashboard', 'calendar', 'clients', 'tus', 'payments', 'settings'],
  therapist: ['dashboard', 'calendar', 'clients', 'tus', 'settings'],
}
const APP_ROLE_NAV = {
  owner: DEMO_ROLE_NAV.owner,
  coordinator: ['dashboard', 'calendar', 'clients', 'tus', 'payments', 'reports', 'settings'],
  therapist: ['dashboard', 'calendar', 'clients', 'tus', 'payments', 'settings'],
}
const EMPTY_CAPABILITIES = Object.freeze([])
const canAccessInMode = (routeName, role, appMode) => {
  const matrix = appMode === 'app' ? APP_ROLE_NAV : DEMO_ROLE_NAV
  return Boolean(matrix[role.id]?.includes(routeName))
}

const routeTitle = (routeName) => {
  const navItem = NAV.find((item) => item.id === routeName)
  return navItem ? navItem.label : TITLES[routeName] || ''
}

const TITLES = {
  dashboard: 'Dziś',
  calendar: 'Kalendarz',
  clients: 'Klienci',
  client: 'Karta klienta',
  tus: 'Zajęcia TUS',
  tusGroup: 'Grupa TUS',
  team: 'Zespół',
  psych: 'Profil specjalistki',
  payments: 'Finanse',
  reports: 'Raporty',
  settings: 'Ustawienia',
}

const VIEWS = {
  dashboard: Dashboard,
  calendar: CalendarView,
  clients: Clients,
  client: ClientDetail,
  tus: TusGroups,
  tusGroup: TusGroupDetail,
  team: Team,
  psych: PsychDetail,
  payments: Payments,
  reports: Reports,
  settings: Settings,
}

const ACTIVE_OF = { client: 'clients', psych: 'team', tusGroup: 'tus' }

// the handler accepts Ctrl and Cmd alike — advertise the native chord
const META_K = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘ K' : 'Ctrl K'

function AppSpecialistPayments() {
  return (
    <div>
      <div className="view-head">
        <div>
          <div className="eyebrow">Twoje finanse</div>
          <h1 className="display view-head__title">Rozliczenia <em>specjalisty</em></h1>
          <p className="view-head__sub">Widoczne są wyłącznie rozliczenia przypisane do tego konta.</p>
        </div>
      </div>
      <section className="specialist-payments-empty" aria-label="Rozliczenia specjalisty">
        <EmptyState
          icon="payments"
          title="Brak rozliczeń specjalisty"
          hint="W środowisku testowym nie ma rozliczeń przypisanych do tego konta."
        />
      </section>
    </div>
  )
}

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
  showTodayCard = true,
}) {
  const { state } = useApp()
  const navRef = useRef(null)
  const pillRef = useRef(null)
  const activeId = ACTIVE_OF[route.name] || route.name
  const items = NAV.filter((item) => canAccessRoute(item.id, role) && (!navIds || navIds.includes(item.id)))
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

  const now = new Date()
  const today = toISODate(now)
  const todayCount = todayWorkspace(state, role, now).daySummary.total

  return (
    <aside className={`sidebar ${className}`} ref={innerRef} inert={inert}>
      <div className="sidebar__brand" data-shell-reveal>
        <Logotype />
      </div>
      <nav className="nav" ref={navRef} aria-label="Nawigacja główna">
        <span className="nav__pill" ref={pillRef} />
        {items.map((n) => (
          <a
            key={n.id}
            {...navLink(navigate, n.id)}
            className={`nav__item ${activeId === n.id ? 'is-active' : ''}`}
            aria-current={activeId === n.id ? 'page' : undefined}
            data-shell-reveal
          >
            <Icon name={n.icon} size={19} />
            {n.label}
          </a>
        ))}
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
        {showTodayCard && (
          <div className="today-card">
            <div className="today-card__label">Dziś · {fmtWeekday(today)}</div>
            <div className="today-card__line">
              {todayCount > 0 ? `${todayCount} ${sessionsWord(todayCount)} w grafiku` : 'Spokojny dzień'}
            </div>
            <div className="today-card__sub">Weź głęboki oddech 🌿</div>
          </div>
        )}
      </div>
    </aside>
  )
}

function MobileRoleControls({ appMode, role, onRoleChange, onLogout }) {
  return (
    <div className="mobile-account">
      <div className="mobile-account__identity">
        <Avatar name={role.name} size={40} />
        <span>
          <b>{role.name}</b>
          <small>{role.label}</small>
        </span>
      </div>
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
              <Avatar name={demoRole.name} size={30} />
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
const PHONE_MENU_IDS = ['clients', 'team', 'payments', 'reports', 'settings']

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
            onRoleChange={(roleId) => { onRoleChange(roleId); close() }}
            onLogout={onLogout}
          />
        ) : undefined}
        className={`sidebar--drawer ${phone ? 'sidebar--phone' : ''}`}
        innerRef={asideRef}
        navIds={phone ? PHONE_MENU_IDS : undefined}
        showTodayCard={!phone}
      />
    </div>
  )
}

// Phone-first bottom navigation: two daily destinations, a raised add action,
// TUS, then the sole entry point to all secondary navigation and account tools.
const PHONE_TAB_IDS = new Set(['dashboard', 'calendar', 'tus'])
const PHONE_TABS = NAV.filter((item) => PHONE_TAB_IDS.has(item.id))

function MobileTabbar({ route, navigate, onAdd, onMenu }) {
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
      <span>{n.id === 'tus' ? 'TUS' : n.label}</span>
    </a>
  )

  return (
    <nav className="tabbar" ref={barRef} aria-label="Nawigacja dolna">
      {pill && <span className="tabbar__pill" style={{ transform: `translateX(${pill.left}px)` }} />}
      <div className="tabbar__side">
        {PHONE_TABS.slice(0, 2).map(tab)}
      </div>
      {onAdd && (
        <button className="tabbar__fab" onClick={onAdd} aria-label="Nowa sesja">
          <Icon name="plus" size={22} />
        </button>
      )}
      <div className="tabbar__side">
        {PHONE_TABS.slice(2).map(tab)}
        <button
          type="button"
          data-id="menu"
          className={`tabbar__item ${activeTabId === 'menu' ? 'is-active' : ''}`}
          onClick={onMenu}
          aria-current={activeTabId === 'menu' ? 'page' : undefined}
        >
          <Icon name="menu" size={21} />
          <span>Menu</span>
        </button>
      </div>
    </nav>
  )
}

function Topbar({
  appMode,
  route,
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
}) {
  const titleRef = useRef(null)
  const title = routeTitle(route.name)
  const controlsInert = overlayKey ? '' : undefined

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
        <span className="topbar__crumb" translate="no">Bear with me <span style={{ opacity: 0.35, margin: '0 7px' }}>/</span> </span><b>{title}</b>
      </div>
      <div className="topbar__right" data-shell-reveal>
        <div className="topbar__controls" inert={controlsInert}>
          <button className="cmd-trigger" onClick={onSearch} title={`Szukaj w panelu (${META_K})`}>
            <Icon name="search" size={15} />
            <span>Szukaj…</span>
            <kbd>{META_K}</kbd>
          </button>
          {showAccountControls && (
            <>
              {appMode === 'app' ? (
                <div className="userchip userchip--authenticated">
                  <Avatar name={role.name} size={37} />
                  <span>
                    <span className="userchip__name">{role.name}</span>
                    <span className="userchip__role">{role.label}</span>
                  </span>
                </div>
              ) : (
                <Popover
                  align="right"
                  ariaLabel="Tryb demonstracyjny"
                  contentRole="group"
                  open={roleMenuOpen}
                  setOpen={setRoleMenuOpen}
                  trigger={
                    <button
                      type="button"
                      className="userchip userchip--button"
                      onClick={() => setRoleMenuOpen(!roleMenuOpen)}
                    >
                      <Avatar name={role.name} size={37} />
                      <span>
                        <span className="userchip__mode">Tryb demonstracyjny</span>
                        <span className="userchip__name">{role.name}</span>
                        <span className="userchip__role">{role.label}</span>
                      </span>
                    </button>
                  }
                >
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
                </Popover>
              )}
              <IconBtn name="logout" label="Wyloguj się" onClick={onLogout} />
            </>
          )}
        </div>
        <TodayCockpit
          open={overlayKey === 'cockpit'}
          onOpenChange={onCockpitChange}
          disabled={!!overlayKey}
        />
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
          toast(`${cap(fmtMonthYear(ym))} rozliczony w całości ✨`)
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
          <h2 className="display" id="leave-confirm-title">Niezapisane zmiany</h2>
          <p>Masz niezapisane zmiany. Odrzucić je i kontynuować?</p>
          <div className="leave-confirm__actions">
            <Button variant="ghost" onClick={onCancel}>Kontynuuj edycję</Button>
            <Button onClick={onConfirm}>Odrzuć i wyjdź</Button>
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
  const { state, dispatch } = useApp()
  const { clearToasts } = useToasts()
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
  const canAccessRoute = useCallback(
    (routeName, targetRole = role) => canAccessInMode(routeName, targetRole, appMode),
    [appMode, role]
  )
  const [route, setRoute] = useState(() => {
    const requested = routeFromHash(window.location.hash)
    if (!requested || !VIEWS[requested.name]
      || !canAccessInMode(ACTIVE_OF[requested.name] || requested.name, role, appMode)) {
      return { name: 'dashboard' }
    }
    return requested
  })
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
    if (!viaHash && previousName && viewChanged) {
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
    const onHashChange = () => {
      const currentRole = roleRef.current
      const currentRoute = routeRef.current
      const requested = routeFromHash(window.location.hash)
      const accessible = requested
        && VIEWS[requested.name]
        && canAccessInMode(ACTIVE_OF[requested.name] || requested.name, currentRole, appMode)
      const nextRoute = accessible ? requested : { name: 'dashboard' }
      if (
        currentRoute.name === nextRoute.name
        && JSON.stringify(currentRoute.params || {}) === JSON.stringify(nextRoute.params || {})
      ) return
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
      }
      if (leaveBlocked()) {
        setPendingLeave(() => () => requestLeave(commit))
        return
      }
      commit()
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [appMode])

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

  const navigate = useCallback((name, params) => {
    const currentRole = roleRef.current
    const currentRoute = routeRef.current
    if (!canAccessInMode(ACTIVE_OF[name] || name, currentRole, appMode)) return
    if (currentRoute.name === name && JSON.stringify(currentRoute.params) === JSON.stringify(params)) return
    if (leaveBlocked()) {
      setPendingLeave(() => () => requestLeave(() => navigate(name, params)))
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
  }, [appMode, requestLeave])

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
      name: canAccessInMode(candidate, nextRole, 'demo') ? candidate : 'dashboard',
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
    if (isApp && !capabilities.includes('appointment.manage')) return
    setDrawer({ kind: 'session', opts })
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
  const openTusGroupForm = useCallback((opts = {}) => { setDrawer({ kind: 'tusGroup', opts }); openOverlay('drawer') }, [openOverlay])
  const openTusKidForm = useCallback((opts = {}) => { setDrawer({ kind: 'tusKid', opts }); openOverlay('drawer') }, [openOverlay])
  const openTusClassForm = useCallback((opts = {}) => { setDrawer({ kind: 'tusClass', opts }); openOverlay('drawer') }, [openOverlay])
  const openTeamBoard = useCallback(() => { setDrawer({ kind: 'board' }); openOverlay('drawer') }, [openOverlay])
  const closeDrawer = useCallback(() => {
    closeOverlay('drawer')
    setDrawer(null)
  }, [closeOverlay])

  // Moving focus after the immediate route commit gives screen-reader and keyboard users the destination
  // context without interrupting the existing live-region announcement.
  useEffect(() => {
    viewRef.current?.focus({ preventScroll: true })
  }, [role.id, route.name, routeParamsKey])

  const View = isApp && role.id === 'therapist' && route.name === 'payments'
    ? AppSpecialistPayments
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
  const shellValue = useMemo(() => ({
    actor,
    appMode,
    capabilities,
    dataMode,
    role,
    setDemoRole: isApp ? undefined : setDemoRole,
    canAccess: canAccessRoute,
    route,
    navigate,
    getViewState,
    patchViewState,
    resetViewState,
    openSessionForm,
    openClientForm,
    openPsychForm,
    openTusGroupForm,
    openTusKidForm,
    openTusClassForm,
    openTeamBoard,
    registerLeaveGuard,
  }), [
    getViewState, navigate, openClientForm, openPsychForm, openSessionForm, openTeamBoard,
    openTusClassForm, openTusGroupForm, openTusKidForm, patchViewState, registerLeaveGuard,
    actor, appMode, canAccessRoute, capabilities, dataMode, isApp, resetViewState,
    role, route, setDemoRole,
  ])

  return (
    <ShellCtx.Provider value={shellValue}>
      <a className="skip-link" href="#main-content" inert={hasOverlay ? '' : undefined}>Przejdź do treści</a>
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
            canAccessRoute={canAccessRoute}
            inert={hasOverlay ? '' : undefined}
          />
        )}
        <div className="main">
          <Topbar
            appMode={appMode}
            route={route}
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
          />
          {isApp && dataMode === 'fictional' && (
            <div className="environment-strip" role="status">Środowisko testowe</div>
          )}
          <main
            id="main-content"
            className={`content ${route.name === 'dashboard' ? 'content--dashboard' : ''}`}
            ref={contentRef}
            tabIndex={-1}
            inert={hasOverlay ? '' : undefined}
          >
            <div className="view" ref={viewRef} tabIndex={-1} key={`${role.id}:${route.name}:${routeParamsKey}`}>
              <View params={route.params || {}} />
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
            onAdd={isApp ? undefined : openNewSession}
            onMenu={openNavigation}
          />
        </div>
      )}
      {isCompact && overlay === 'navigation' && (
        <MobileNavDrawer
          appMode={appMode}
          canAccessRoute={canAccessRoute}
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
      {!isApp && overlay === 'drawer' && drawer?.kind === 'client' && <ClientDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {!isApp && overlay === 'drawer' && drawer?.kind === 'psych' && <PsychDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {overlay === 'drawer' && drawer?.kind === 'tusGroup' && <TusGroupDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {overlay === 'drawer' && drawer?.kind === 'tusKid' && <TusKidDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {overlay === 'drawer' && drawer?.kind === 'tusClass' && <TusClassDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {overlay === 'drawer' && drawer?.kind === 'board' && <BoardDrawer onClose={closeDrawer} />}
      {overlay === 'palette' && <CommandPalette onClose={() => closeOverlay('palette')} />}
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
