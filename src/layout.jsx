import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon, Bloom } from './icons.jsx'
import { Avatar, IconBtn, PopItem, Popover } from './ui.jsx'
import { useApp } from './store.jsx'
import { ShellCtx } from './shell-ctx.js'
import { DEMO_ROLES } from './data.js'
import { useIsCompact, useIsPhone } from './responsive.js'
import { TodayCockpit } from './cockpit.jsx'
import { animateOut, motionOK, goldBurst } from './anim.js'
import { fmtMonthYear, monthKey, toISODate, fmtWeekday, cap, sessionsWord, outstandingOf } from './format.js'
import { sessionsForRole } from './workspace.js'
import { BoardDrawer, Dashboard } from './views/Dashboard.jsx'
import { CalendarView } from './views/Calendar.jsx'
import { Clients, ClientDetail } from './views/Clients.jsx'
import { Team, PsychDetail } from './views/Team.jsx'
import { Payments } from './views/Payments.jsx'
import { Reports } from './views/Reports.jsx'
import { Settings } from './views/Settings.jsx'
import { SessionDrawer } from './views/SessionForm.jsx'
import { ClientDrawer } from './views/ClientForm.jsx'
import { PsychDrawer } from './views/PsychForm.jsx'
import { CommandPalette } from './command-palette.jsx'

const NAV = [
  { id: 'dashboard', label: 'Dziś', icon: 'dashboard' },
  { id: 'calendar', label: 'Kalendarz', icon: 'calendar' },
  { id: 'clients', label: 'Klienci', icon: 'clients' },
  { id: 'team', label: 'Zespół', icon: 'team' },
  { id: 'payments', label: 'Finanse', icon: 'payments' },
  { id: 'reports', label: 'Raporty', icon: 'reports' },
]

const ROLE_NAV = {
  owner: ['dashboard', 'calendar', 'clients', 'team', 'payments', 'reports', 'settings'],
  coordinator: ['dashboard', 'calendar', 'clients', 'payments', 'settings'],
  therapist: ['dashboard', 'calendar', 'clients', 'settings'],
}
const canAccess = (routeName, role) => ROLE_NAV[role.id].includes(routeName)

const navLabel = (item, role) => {
  if (role.id !== 'therapist') return item.label
  return {
    dashboard: 'Mój dzień',
    calendar: 'Mój kalendarz',
    clients: 'Moi klienci',
  }[item.id] || item.label
}

const routeTitle = (routeName, role) => {
  const navItem = NAV.find((item) => item.id === routeName)
  return navItem ? navLabel(navItem, role) : TITLES[routeName] || ''
}

const TITLES = {
  dashboard: 'Pulpit',
  calendar: 'Kalendarz sesji',
  clients: 'Klienci',
  client: 'Karta klienta',
  team: 'Zespół',
  psych: 'Profil specjalistki',
  payments: 'Finanse',
  reports: 'Raport miesięczny',
  settings: 'Ustawienia',
}

const VIEWS = {
  dashboard: Dashboard,
  calendar: CalendarView,
  clients: Clients,
  client: ClientDetail,
  team: Team,
  psych: PsychDetail,
  payments: Payments,
  reports: Reports,
  settings: Settings,
}

const ACTIVE_OF = { client: 'clients', psych: 'team' }

// the handler accepts Ctrl and Cmd alike — advertise the native chord
const META_K = /Mac|iP/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'

export function Logotype({ light }) {
  return (
    <div className="logotype">
      <Bloom size={36} />
      <div className="logotype__name" style={light ? { color: '#fff' } : undefined}>
        Aurelia
        <small>Centrum Psychoterapii</small>
      </div>
    </div>
  )
}

function Sidebar({ route, navigate, role, className = '', innerRef, inert }) {
  const { state } = useApp()
  const navRef = useRef(null)
  const pillRef = useRef(null)
  const activeId = ACTIVE_OF[route.name] || route.name
  const items = NAV.filter((item) => canAccess(item.id, role))
  const showSettings = canAccess('settings', role)

  useLayoutEffect(() => {
    const nav = navRef.current
    const pill = pillRef.current
    if (!nav || !pill) return
    const navItems = nav.querySelectorAll('.nav__item')
    const ids = [...items.map((item) => item.id), ...(showSettings ? ['settings'] : [])]
    const idx = ids.indexOf(activeId)
    const el = navItems[idx]
    if (!el) { pill.style.opacity = 0; return }
    const target = { top: el.offsetTop, height: el.offsetHeight, opacity: 1 }
    if (motionOK()) {
      window.gsap.to(pill, { ...target, duration: 0.45, ease: 'elastic.out(1, 0.75)', overwrite: true })
    } else {
      Object.assign(pill.style, { top: target.top + 'px', height: target.height + 'px', opacity: 1 })
    }
  }, [activeId, role.id, showSettings])

  const today = toISODate(new Date())
  const todayCount = sessionsForRole(state, role).filter(
    (s) => s.date === today && (s.status === 'scheduled' || s.status === 'completed')
  ).length

  return (
    <aside className={`sidebar ${className}`} ref={innerRef} inert={inert}>
      <div className="sidebar__brand" data-shell-reveal>
        <Logotype />
      </div>
      <nav className="nav" ref={navRef} aria-label="Nawigacja główna">
        <span className="nav__pill" ref={pillRef} />
        {items.map((n) => (
          <button
            key={n.id}
            className={`nav__item ${activeId === n.id ? 'is-active' : ''}`}
            onClick={() => navigate(n.id)}
            aria-current={activeId === n.id ? 'page' : undefined}
            data-shell-reveal
          >
            <Icon name={n.icon} size={19} />
            {navLabel(n, role)}
          </button>
        ))}
        {showSettings && (
          <>
            <div className="nav__divider" data-shell-reveal />
            <button
              className={`nav__item ${activeId === 'settings' ? 'is-active' : ''}`}
              onClick={() => navigate('settings')}
              aria-current={activeId === 'settings' ? 'page' : undefined}
              data-shell-reveal
            >
              <Icon name="settings" size={19} />
              Ustawienia
            </button>
          </>
        )}
      </nav>
      <div className="sidebar__foot" data-shell-reveal>
        <div className="today-card">
          <div className="today-card__label">Dziś · {fmtWeekday(today)}</div>
          <div className="today-card__line">
            {todayCount > 0 ? `${todayCount} ${sessionsWord(todayCount)} w grafiku` : 'Spokojny dzień'}
          </div>
          <div className="today-card__sub">Weź głęboki oddech 🌿</div>
        </div>
      </div>
    </aside>
  )
}

// Compact-shell navigation: the sidebar slides in from the left as a drawer,
// with the same GSAP choreography as the form drawers (mirrored).
function MobileNavDrawer({ route, navigate, role, onClose }) {
  const asideRef = useRef(null)
  const backRef = useRef(null)
  const closing = useRef(false)

  useEffect(() => {
    if (!motionOK() || !asideRef.current) return
    window.gsap.fromTo(backRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 })
    window.gsap.fromTo(asideRef.current, { x: '-104%' }, { x: '0%', duration: 0.5, ease: 'power4.out' })
  }, [])

  const close = useCallback(() => {
    if (closing.current) return
    if (!motionOK() || !asideRef.current) return onClose()
    closing.current = true
    window.gsap.to(backRef.current, { autoAlpha: 0, duration: 0.25 })
    window.gsap.to(asideRef.current, { x: '-104%', duration: 0.38, ease: 'power3.in', onComplete: onClose })
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
      const els = [...aside.querySelectorAll('button, [tabindex]:not([tabindex="-1"])')]
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
        className="sidebar--drawer"
        innerRef={asideRef}
      />
    </div>
  )
}

// Phone-first bottom navigation: the four daily destinations plus a raised
// "new session" action in the centre. Secondary pages (Zespół, Raporty,
// Ustawienia) stay in the hamburger drawer.
const TABBAR = NAV.filter((n) => ['dashboard', 'calendar', 'clients', 'payments'].includes(n.id))

function MobileTabbar({ route, navigate, role, onAdd }) {
  const barRef = useRef(null)
  const [pill, setPill] = useState(null)
  const activeId = ACTIVE_OF[route.name] || route.name
  const tabs = TABBAR.filter((item) => canAccess(item.id, role))

  // the gliding blob behind the active icon — measured, then moved via CSS
  // transition (same pattern as Segmented, survives orientation changes)
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const measure = () => {
      const btn = bar.querySelector(`.tabbar__item[data-id="${activeId}"]`)
      if (!btn) return setPill(null)
      setPill({ left: btn.offsetLeft + (btn.offsetWidth - 46) / 2 })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [activeId])

  useEffect(() => {
    if (!motionOK() || !barRef.current) return
    window.gsap.fromTo(
      barRef.current,
      { y: 84 },
      { y: 0, duration: 0.7, ease: 'power4.out', delay: 0.15, clearProps: 'transform' }
    )
  }, [])

  const tab = (n) => (
    <button
      key={n.id}
      data-id={n.id}
      className={`tabbar__item ${activeId === n.id ? 'is-active' : ''}`}
      onClick={() => navigate(n.id)}
      aria-current={activeId === n.id ? 'page' : undefined}
    >
      <Icon name={n.icon} size={21} />
      <span>{navLabel(n, role)}</span>
    </button>
  )

  return (
    <nav className="tabbar" ref={barRef} aria-label="Nawigacja dolna">
      {pill && <span className="tabbar__pill" style={{ left: pill.left }} />}
      {tabs.slice(0, 2).map(tab)}
      <button className="tabbar__fab" onClick={onAdd} aria-label="Nowa sesja">
        <Icon name="plus" size={22} />
      </button>
      {tabs.slice(2).map(tab)}
    </nav>
  )
}

function Topbar({ route, role, setDemoRole, roleMenuOpen, setRoleMenuOpen, onCockpitChange, onLogout, onSearch, onMenu, overlayKey }) {
  const titleRef = useRef(null)
  const title = routeTitle(route.name, role)
  const controlsInert = overlayKey ? '' : undefined

  useEffect(() => {
    if (!motionOK() || !titleRef.current) return
    window.gsap.fromTo(
      titleRef.current,
      { autoAlpha: 0, y: 6 },
      { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power2.out' }
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
        <span className="topbar__crumb">Aurelia <span style={{ opacity: 0.35, margin: '0 7px' }}>/</span> </span><b>{title}</b>
      </div>
      <div className="topbar__right" data-shell-reveal>
        <div className="topbar__controls" inert={controlsInert}>
          <button className="cmd-trigger" onClick={onSearch} title={`Szukaj w Aurelii (${META_K})`}>
            <Icon name="search" size={15} />
            <span>Szukaj…</span>
            <kbd>{META_K}</kbd>
          </button>
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
          <IconBtn name="logout" label="Wyloguj się" onClick={onLogout} />
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
          // order matters: goldBurst skips zero-size anchors, so fall through
          // to whichever gold signal the current view actually shows
          goldBurst(
            document.querySelector('.figures__item--gold') ||
            document.querySelector('.stat--gold') ||
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

// details sit one level below their list view — used for drill-in continuity
const DEPTH = { client: 1, psych: 1 }

export function Shell({ onLogout }) {
  const { state, dispatch } = useApp()
  const [route, setRoute] = useState({ name: 'dashboard' })
  const [drawer, setDrawer] = useState(null)
  const [overlay, setOverlay] = useState(null)
  const [roleMenuOpen, setRoleMenuOpen] = useState(false)
  const isCompact = useIsCompact()
  const isPhone = useIsPhone()
  const viewRef = useRef(null)
  const contentRef = useRef(null)
  const shellRef = useRef(null)
  const busy = useRef(false)
  const role = DEMO_ROLES.find((demoRole) => demoRole.id === state.demoRoleId) || DEMO_ROLES[0]

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
      { autoAlpha: 0, x: -14 },
      { autoAlpha: 1, x: 0, duration: 0.7, ease: 'power3.out', stagger: 0.05, clearProps: 'transform,opacity,visibility' }
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
        setRoleMenuOpen(false)
        setOverlay((active) => active === 'palette' ? null : 'palette')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const navigate = (name, params) => {
    if (!canAccess(ACTIVE_OF[name] || name, role)) return
    if (busy.current) return
    setRoleMenuOpen(false)
    setOverlay(null)
    if (route.name === name && JSON.stringify(route.params) === JSON.stringify(params)) return
    busy.current = true
    const dir = (DEPTH[name] || 0) - (DEPTH[route.name] || 0)
    animateOut(viewRef.current, dir).then(() => {
      setRoute({ name, params })
      if (contentRef.current) contentRef.current.scrollTop = 0
      busy.current = false
    })
  }

  const setDemoRole = (roleId) => {
    const nextRole = DEMO_ROLES.find((demoRole) => demoRole.id === roleId)
    if (!nextRole) return
    if (!canAccess(ACTIVE_OF[route.name] || route.name, nextRole)) {
      setRoute({ name: 'dashboard' })
      if (contentRef.current) contentRef.current.scrollTop = 0
    }
    dispatch({ type: 'SET_DEMO_ROLE', roleId })
  }

  const setRoleMenu = (open) => {
    if (open) {
      setOverlay(null)
    }
    setRoleMenuOpen(open)
  }
  const openSessionForm = (opts = {}) => { setDrawer({ kind: 'session', opts }); openOverlay('drawer') }
  const openClientForm = (opts = {}) => { setDrawer({ kind: 'client', opts }); openOverlay('drawer') }
  const openPsychForm = (opts = {}) => { setDrawer({ kind: 'psych', opts }); openOverlay('drawer') }
  const openTeamBoard = () => { setDrawer({ kind: 'board' }); openOverlay('drawer') }
  const closeDrawer = () => {
    closeOverlay('drawer')
    setDrawer(null)
  }

  // The new .view exists only after animateOut has committed a route swap.
  // Moving focus here gives screen-reader and keyboard users the destination
  // context without interrupting the existing live-region announcement.
  useEffect(() => {
    viewRef.current?.focus({ preventScroll: true })
  }, [route])

  const View = VIEWS[route.name] || Dashboard
  const hasOverlay = overlay !== null

  return (
    <ShellCtx.Provider value={{ role, setDemoRole, canAccess, route, navigate, openSessionForm, openClientForm, openPsychForm, openTeamBoard }}>
      <div className="shell" ref={shellRef}>
        {!isCompact && <Sidebar route={route} navigate={navigate} role={role} inert={hasOverlay ? '' : undefined} />}
        <div className="main">
          <Topbar
            route={route}
            role={role}
            setDemoRole={setDemoRole}
            roleMenuOpen={roleMenuOpen}
            setRoleMenuOpen={setRoleMenu}
            onCockpitChange={(open) => open ? openOverlay('cockpit') : closeOverlay('cockpit')}
            onLogout={onLogout}
            onSearch={() => {
              setRoleMenuOpen(false)
              setOverlay((active) => active === 'palette' ? null : 'palette')
            }}
            onMenu={isCompact ? () => openOverlay('navigation') : undefined}
            overlayKey={overlay}
          />
          <main className="content" ref={contentRef} inert={hasOverlay ? '' : undefined}>
            <div className="view" ref={viewRef} tabIndex={-1} key={route.name + JSON.stringify(route.params || {})}>
              <View params={route.params || {}} />
            </div>
          </main>
        </div>
      </div>
      {/* view changes are announced — the router moves no focus by itself */}
      <div className="sr-only" aria-live="polite">{routeTitle(route.name, role)}</div>
      {isPhone && (
        <div inert={hasOverlay ? '' : undefined}>
          <MobileTabbar route={route} navigate={navigate} role={role} onAdd={() => openSessionForm()} />
        </div>
      )}
      {isCompact && overlay === 'navigation' && (
        <MobileNavDrawer route={route} navigate={navigate} role={role} onClose={() => closeOverlay('navigation')} />
      )}
      {overlay === 'drawer' && drawer?.kind === 'session' && <SessionDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {overlay === 'drawer' && drawer?.kind === 'client' && <ClientDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {overlay === 'drawer' && drawer?.kind === 'psych' && <PsychDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {overlay === 'drawer' && drawer?.kind === 'board' && <BoardDrawer onClose={closeDrawer} />}
      {overlay === 'palette' && <CommandPalette onClose={() => closeOverlay('palette')} />}
    </ShellCtx.Provider>
  )
}
