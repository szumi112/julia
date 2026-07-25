// Today cockpit — a persistent "what's happening right now" panel, opened
// from the live chip in the topbar. Desktop: anchored dropdown under the
// chip; phones: a bottom sheet. Shows the next session, today's progress,
// outstanding payments and quick actions.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useApp, totalOutstanding } from './store.jsx'
import { useShell } from './shell-ctx.js'
import { useIsPhone } from './responsive.js'
import { useMinuteNow } from './clock.js'
import { motionOK } from './anim.js'
import { Icon } from './icons.jsx'
import { Avatar, Button, IconBtn, EmptyState } from './ui.jsx'
import { EntityLink } from './ux-patterns.jsx'
import { sessionsForRole, todayWorkspace } from './workspace.js'
import {
  toISODate, timeToMin, pad2, fmtMoney, fmtDayMonth, fmtWeekday, cap,
  sessionsWord, outstandingOf, isBillable, untilLabel,
} from './format.js'

const minToTime = (m) => `${pad2(Math.floor((m % 1440) / 60))}:${pad2(m % 60)}`

function useTodayModel() {
  const { state } = useApp()
  const { role } = useShell()
  const now = useMinuteNow()
  const today = toISODate(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return useMemo(() => {
    const workspace = todayWorkspace(state, role, now)
    const scopedSessions = sessionsForRole(state, role)
    const todays = workspace.schedule
    const done = workspace.daySummary.completed
    const total = workspace.daySummary.total
    const running = workspace.current
    const next = workspace.next
    // sessions are kept sorted by date+time, so the first future match wins
    const future = !running && !next
      ? scopedSessions.find((s) => s.status === 'scheduled' && s.date > today)
      : null
    const showFinance = role.scope !== 'own'
    const outstanding = showFinance ? totalOutstanding(state.sessions) : 0
    const unpaidCount = showFinance
      ? state.sessions.filter((s) => isBillable(s) && outstandingOf(s) > 0).length
      : 0
    return { today, nowMin, todays, done, total, running, next, future, outstanding, unpaidCount, showFinance }
  }, [state, role, today, nowMin])
}

function CockpitBody({ m, onClose }) {
  const { state } = useApp()
  const { openSessionForm, openClientForm } = useShell()
  const clientOf = (id) => state.clients.find((c) => c.id === id)
  const psychOf = (id) => state.psychologists.find((p) => p.id === id)
  const go = (fn) => { onClose(); fn() }

  const focus = m.running || m.next
  const focusPsych = focus ? psychOf(focus.psychId) : null
  const total = m.total
  const pct = total ? Math.round((m.done / total) * 100) : 0

  return (
    <>
      <div className="cockpit__head">
        <div>
          <div className="eyebrow">Dziś · {fmtWeekday(m.today)}</div>
          <h3 className="cockpit__title display">{fmtDayMonth(m.today)}</h3>
        </div>
        <IconBtn name="close" label="Zamknij panel dnia" onClick={onClose} />
      </div>

      {focus ? (
        <button className="cockpit__next" onClick={() => go(() => openSessionForm({ session: focus }))}>
          <span className="cockpit__next-time">{focus.time}</span>
          <span className="cockpit__next-main">
            <b>{clientOf(focus.clientId)?.name}</b>
            <span>
              <Avatar name={focusPsych?.name || '?'} color={focusPsych?.color} size={16} />
              <span className="cockpit__next-sub">{focusPsych?.name} · {focusPsych?.room}</span>
            </span>
          </span>
          <span className={`pill ${m.running ? 'pill--rose' : 'pill--gold'}`}>
            {m.running
              ? `trwa · do ${minToTime(timeToMin(focus.time) + focus.duration)}`
              : untilLabel(timeToMin(focus.time) - m.nowMin)}
          </span>
        </button>
      ) : m.future ? (
        <button className="cockpit__next" onClick={() => go(() => openSessionForm({ session: m.future }))}>
          <span className="cockpit__next-time">{m.future.time}</span>
          <span className="cockpit__next-main">
            <b>{clientOf(m.future.clientId)?.name}</b>
            <span><span className="cockpit__next-sub">najbliższa sesja · {fmtDayMonth(m.future.date)}</span></span>
          </span>
          <Icon name="chevR" size={15} className="faint" />
        </button>
      ) : (
        <EmptyState compact icon="sparkle" title="Brak zaplanowanych sesji" hint="Kalendarz jest wolny — czas na oddech." />
      )}

      {total > 0 && (
        <div>
          <div
            className="cockpit__progress"
            role="progressbar"
            aria-label="Postęp dnia"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={m.done}
            aria-valuetext={`${m.done} z ${total} sesji za Tobą`}
          ><span style={{ transform: `scaleX(${pct / 100})` }} /></div>
          <div className="cockpit__meta">
            {/* genitive after "z" — always "sesji" */}
            <span>{m.done} z {total} sesji za Tobą</span>
            <span className="faint">{cap(fmtWeekday(m.today))}</span>
          </div>
          <div className="cockpit__list spine">
            <span className="spine__rule" aria-hidden="true" />
            {m.todays.map((s, i) => {
              const p = psychOf(s.psychId)
              const live = m.running && s.id === m.running.id
              const nowHere = !m.running &&
                timeToMin(s.time) > m.nowMin &&
                (i === 0 || timeToMin(m.todays[i - 1].time) <= m.nowMin)
              return (
                <Fragment key={s.id}>
                  {nowHere && <div className="spine__now" aria-hidden="true">teraz</div>}
                  <button
                    className={`spine__row ${s.status === 'completed' ? 'is-done' : ''} ${live ? 'is-live' : ''}`}
                    style={{ '--node-color': p?.color }}
                    onClick={() => go(() => openSessionForm({ session: s }))}
                  >
                    <span className="spine__time">{s.time}</span>
                    <span className="spine__name">{clientOf(s.clientId)?.name}</span>
                    <Icon name={s.status === 'completed' ? 'check' : live ? 'wave' : 'clock'} size={14} className="faint" />
                  </button>
                </Fragment>
              )
            })}
          </div>
        </div>
      )}

      {m.showFinance && (m.outstanding > 0 ? (
        <EntityLink route="payments" className="cockpit__due" onClick={onClose}>
          <Icon name="payments" size={19} />
          <span style={{ flex: 1 }}>
            Zaległe płatności
            <b style={{ display: 'block' }}>{fmtMoney(m.outstanding)} · {m.unpaidCount} {sessionsWord(m.unpaidCount)}</b>
          </span>
          <Icon name="chevR" size={15} />
        </EntityLink>
      ) : (
        <div className="cockpit__due cockpit__due--ok">
          <Icon name="check" size={19} />
          <span style={{ flex: 1 }}>Wszystkie sesje rozliczone</span>
        </div>
      ))}

      <div className="cockpit__actions">
        <Button size="sm" icon="plus" onClick={() => go(() => openSessionForm({ date: m.today }))}>
          Nowa sesja
        </Button>
        <Button size="sm" variant="soft" icon="user" onClick={() => go(() => openClientForm())}>
          Nowy klient
        </Button>
        <EntityLink route="calendar" className="btn btn--ghost btn--sm" onClick={onClose}>
          <Icon name="calendar" size={17} />
          <span>Kalendarz</span>
        </EntityLink>
      </div>
    </>
  )
}

// Desktop container — anchored under the chip, closes on outside click /
// Escape / resize (fixed coordinates go stale), like ui.jsx's Popover.
function CockpitPop({ anchorRef, onClose, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect()
    const pop = ref.current
    if (!r || !pop) return
    const margin = 12
    let left = Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - margin)
    left = Math.max(margin, left)
    setPos({ left, top: r.bottom + 10 })
  }, [anchorRef])

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef.current?.contains(e.target)) onClose()
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, anchorRef])

  useEffect(() => {
    if (!motionOK() || !ref.current) return
    window.gsap.fromTo(
      ref.current,
      { y: -6, scale: 0.99 },
      { y: 0, scale: 1, duration: 0.2, ease: 'power3.out' }
    )
  }, [])

  // place meaningful focus on open, keep Tab inside, restore the chip on close
  useEffect(() => {
    const opener = document.activeElement
    const pop = ref.current
    // the primary action (next session) before the close button
    ;(pop?.querySelector('.cockpit__next') || pop?.querySelector('button'))?.focus()
    const onTab = (e) => {
      if (e.key !== 'Tab' || !pop) return
      const els = [...pop.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null)
      if (!els.length) return
      const first = els[0]
      const last = els[els.length - 1]
      const inside = pop.contains(document.activeElement)
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
    <div
      className="cockpit cockpit--pop"
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Panel dnia"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
    >
      {children(onClose)}
    </div>
  )
}

// Phone container — bottom sheet with the same exit choreography as the
// form drawers (animated out, Escape, focus restore, light tab trap).
function CockpitSheet({ onClose, children }) {
  const ref = useRef(null)
  const backRef = useRef(null)
  const closing = useRef(false)

  useEffect(() => {
    if (!motionOK() || !ref.current) return
    window.gsap.fromTo(ref.current, { y: 12 }, { y: 0, duration: 0.22, ease: 'power3.out' })
  }, [])

  const close = useCallback(() => {
    if (closing.current) return
    if (!motionOK() || !ref.current) return onClose()
    closing.current = true
    window.gsap.to(ref.current, { y: 12, duration: 0.18, ease: 'power3.in', onComplete: onClose })
  }, [onClose])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  useEffect(() => {
    const opener = document.activeElement
    const sheet = ref.current
    // meaningful focus goes to the first action, not the trigger under the backdrop
    ;(sheet?.querySelector('.cockpit__next') || sheet?.querySelector('button'))?.focus()
    const onTab = (e) => {
      if (e.key !== 'Tab' || !sheet) return
      const els = [...sheet.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null)
      if (!els.length) return
      const first = els[0]
      const last = els[els.length - 1]
      const inside = sheet.contains(document.activeElement)
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
    <div role="dialog" aria-modal="true" aria-label="Panel dnia">
      <div className="cockpit-back" ref={backRef} onClick={close} />
      <div className="cockpit cockpit--sheet" ref={ref}>
        <div className="cockpit__grab" aria-hidden="true" />
        {children(close)}
      </div>
    </div>
  )
}

export function TodayCockpit({ open, onOpenChange, disabled = false }) {
  const { state } = useApp()
  const m = useTodayModel()
  const isPhone = useIsPhone()
  const triggerRef = useRef(null)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])

  const firstName = (id) => state.clients.find((c) => c.id === id)?.name.split(' ')[0]
  let text
  if (m.running) text = `Trwa · ${firstName(m.running.clientId)}`
  else if (m.next) text = `${untilLabel(timeToMin(m.next.time) - m.nowMin)} · ${m.next.time}`
  else if (m.total > 0) text = `Po sesjach · ${m.done}/${m.total}`
  else text = 'Wolny dzień'

  return (
    <>
      <button
        className="today-chip"
        ref={triggerRef}
        onClick={() => onOpenChange(!open)}
        disabled={disabled}
        inert={open || disabled ? '' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Panel dnia: ${text}`}
        title="Panel dnia"
      >
        <span className={`today-chip__dot ${m.running ? 'is-live' : ''}`} />
        <span className="today-chip__text">{text}</span>
        <Icon name="chevD" size={13} className="today-chip__chev" />
      </button>
      {open && (isPhone ? (
        <CockpitSheet onClose={close}>
          {(animatedClose) => <CockpitBody m={m} onClose={animatedClose} />}
        </CockpitSheet>
      ) : (
        <CockpitPop anchorRef={triggerRef} onClose={close}>
          {() => <CockpitBody m={m} onClose={close} />}
        </CockpitPop>
      ))}
    </>
  )
}
