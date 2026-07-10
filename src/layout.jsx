import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon, Bloom } from './icons.jsx'
import { Avatar, IconBtn } from './ui.jsx'
import { useApp } from './store.jsx'
import { ShellCtx } from './shell-ctx.js'
import { useIsCompact, useIsPhone } from './responsive.js'
import { TodayCockpit } from './cockpit.jsx'
import { animateOut, motionOK, goldBurst } from './anim.js'
import { fmtMonthYear, monthKey, toISODate, fmtWeekday, cap, sessionsWord, outstandingOf } from './format.js'
import { Dashboard } from './views/Dashboard.jsx'
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
  { id: 'dashboard', label: 'Pulpit', icon: 'dashboard' },
  { id: 'calendar', label: 'Kalendarz', icon: 'calendar' },
  { id: 'clients', label: 'Klienci', icon: 'clients' },
  { id: 'team', label: 'Zespół', icon: 'team' },
  { id: 'payments', label: 'Finanse', icon: 'payments' },
  { id: 'reports', label: 'Raporty', icon: 'reports' },
]

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

function Sidebar({ route, navigate, className = '', innerRef }) {
  const { state } = useApp()
  const navRef = useRef(null)
  const pillRef = useRef(null)
  const activeId = ACTIVE_OF[route.name] || route.name

  useLayoutEffect(() => {
    const nav = navRef.current
    const pill = pillRef.current
    if (!nav || !pill) return
    const items = nav.querySelectorAll('.nav__item')
    const ids = [...NAV.map((n) => n.id), 'settings']
    const idx = ids.indexOf(activeId)
    const el = items[idx]
    if (!el) { pill.style.opacity = 0; return }
    const target = { top: el.offsetTop, height: el.offsetHeight, opacity: 1 }
    if (motionOK()) {
      window.gsap.to(pill, { ...target, duration: 0.45, ease: 'elastic.out(1, 0.75)', overwrite: true })
    } else {
      Object.assign(pill.style, { top: target.top + 'px', height: target.height + 'px', opacity: 1 })
    }
  }, [activeId])

  const today = toISODate(new Date())
  const todayCount = state.sessions.filter(
    (s) => s.date === today && (s.status === 'scheduled' || s.status === 'completed')
  ).length

  return (
    <aside className={`sidebar ${className}`} ref={innerRef}>
      <div className="sidebar__brand" data-shell-reveal>
        <Logotype />
      </div>
      <nav className="nav" ref={navRef} aria-label="Nawigacja główna">
        <span className="nav__pill" ref={pillRef} />
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav__item ${activeId === n.id ? 'is-active' : ''}`}
            onClick={() => navigate(n.id)}
            aria-current={activeId === n.id ? 'page' : undefined}
            data-shell-reveal
          >
            <Icon name={n.icon} size={19} />
            {n.label}
          </button>
        ))}
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
function MobileNavDrawer({ route, navigate, onClose }) {
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

function MobileTabbar({ route, navigate, onAdd }) {
  const barRef = useRef(null)
  const [pill, setPill] = useState(null)
  const activeId = ACTIVE_OF[route.name] || route.name

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
      <span>{n.label}</span>
    </button>
  )

  return (
    <nav className="tabbar" ref={barRef} aria-label="Nawigacja dolna">
      {pill && <span className="tabbar__pill" style={{ left: pill.left }} />}
      {TABBAR.slice(0, 2).map(tab)}
      <button className="tabbar__fab" onClick={onAdd} aria-label="Nowa sesja">
        <Icon name="plus" size={22} />
      </button>
      {TABBAR.slice(2).map(tab)}
    </nav>
  )
}

function Topbar({ route, onLogout, onSearch, onMenu, overlayKey }) {
  const { state } = useApp()
  const titleRef = useRef(null)
  const title = TITLES[route.name] || ''

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
        <IconBtn name="menu" label="Otwórz menu" className="topbar__menu" onClick={onMenu} data-shell-reveal />
      )}
      <div className="topbar__title" ref={titleRef} data-shell-reveal>
        <span className="topbar__crumb">Aurelia <span style={{ opacity: 0.35, margin: '0 7px' }}>/</span> </span><b>{title}</b>
      </div>
      <div className="topbar__right" data-shell-reveal>
        <button className="cmd-trigger" onClick={onSearch} title="Szukaj w Aurelii (Ctrl+K)">
          <Icon name="search" size={15} />
          <span>Szukaj…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <TodayCockpit closeKey={overlayKey} />
        <div className="userchip">
          <Avatar name={state.user.name} size={37} />
          <div>
            <div className="userchip__name">{state.user.name}</div>
            <div className="userchip__role">{state.user.role}</div>
          </div>
        </div>
        <IconBtn name="logout" label="Wyloguj się" onClick={onLogout} />
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
  const [route, setRoute] = useState({ name: 'dashboard' })
  const [drawer, setDrawer] = useState(null)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const isCompact = useIsCompact()
  const isPhone = useIsPhone()
  const viewRef = useRef(null)
  const contentRef = useRef(null)
  const shellRef = useRef(null)
  const busy = useRef(false)

  useMonthSettled()

  // widening past the breakpoint restores the static sidebar
  useEffect(() => {
    if (!isCompact) setNavOpen(false)
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

  // one modal layer at a time: opening any overlay closes its siblings, and
  // the background view is marked inert while one is up (the cockpit gets the
  // same signal via overlayKey)
  const anyModal = !!drawer || cmdOpen || navOpen
  useEffect(() => {
    contentRef.current?.toggleAttribute('inert', anyModal)
  }, [anyModal])

  // global search shortcut — registered once, so it reads overlay state
  // through a ref. A form drawer keeps priority (Ctrl+K must not stack a
  // second modal over unsaved input); toggling closed drops inert first so
  // the palette's focus restore can land in the content area.
  const overlayRef = useRef({ drawer: null, cmd: false })
  overlayRef.current = { drawer, cmd: cmdOpen }
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (overlayRef.current.drawer) return
        setNavOpen(false)
        if (overlayRef.current.cmd) contentRef.current?.removeAttribute('inert')
        setCmdOpen(!overlayRef.current.cmd)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const navigate = (name, params) => {
    if (busy.current) return
    if (route.name === name && JSON.stringify(route.params) === JSON.stringify(params)) return
    busy.current = true
    const dir = (DEPTH[name] || 0) - (DEPTH[route.name] || 0)
    animateOut(viewRef.current, dir).then(() => {
      setRoute({ name, params })
      if (contentRef.current) contentRef.current.scrollTop = 0
      busy.current = false
    })
  }

  const openSessionForm = (opts = {}) => { setCmdOpen(false); setNavOpen(false); setDrawer({ kind: 'session', opts }) }
  const openClientForm = (opts = {}) => { setCmdOpen(false); setNavOpen(false); setDrawer({ kind: 'client', opts }) }
  const openPsychForm = (opts = {}) => { setCmdOpen(false); setNavOpen(false); setDrawer({ kind: 'psych', opts }) }
  // inert must drop before the closing overlay's cleanup restores focus into
  // the content area, or the focus() call lands on an inert subtree and dies
  const unInert = () => contentRef.current?.removeAttribute('inert')
  const closeDrawer = () => { unInert(); setDrawer(null) }

  const View = VIEWS[route.name] || Dashboard

  return (
    <ShellCtx.Provider value={{ route, navigate, openSessionForm, openClientForm, openPsychForm }}>
      <div className="shell" ref={shellRef}>
        {!isCompact && <Sidebar route={route} navigate={navigate} />}
        <div className="main">
          <Topbar
            route={route}
            onLogout={onLogout}
            onSearch={() => setCmdOpen(true)}
            onMenu={isCompact ? () => setNavOpen(true) : undefined}
            overlayKey={`${drawer?.kind || ''}-${cmdOpen}-${navOpen}`}
          />
          <main className="content" ref={contentRef}>
            <div className="view" ref={viewRef} key={route.name + JSON.stringify(route.params || {})}>
              <View params={route.params || {}} />
            </div>
          </main>
        </div>
      </div>
      {/* view changes are announced — the router moves no focus by itself */}
      <div className="sr-only" aria-live="polite">{TITLES[route.name] || ''}</div>
      {isPhone && <MobileTabbar route={route} navigate={navigate} onAdd={() => openSessionForm()} />}
      {isCompact && navOpen && (
        <MobileNavDrawer route={route} navigate={navigate} onClose={() => { unInert(); setNavOpen(false) }} />
      )}
      {drawer?.kind === 'session' && <SessionDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {drawer?.kind === 'client' && <ClientDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {drawer?.kind === 'psych' && <PsychDrawer opts={drawer.opts} onClose={closeDrawer} />}
      {cmdOpen && <CommandPalette onClose={() => { unInert(); setCmdOpen(false) }} />}
    </ShellCtx.Provider>
  )
}
