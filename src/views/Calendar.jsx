import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, sessionsInMonth, availableMonths } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useFlip, motionOK } from '../anim.js'
import { useIsPhone, useMediaQuery, desktopMQ } from '../responsive.js'
import { Button, IconBtn, Segmented, Avatar, Chip, EmptyState } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { StatusPicker, PaymentPicker } from './session-bits.jsx'
import { sessionMatchesFilters, sessionsForRole } from '../workspace.js'
import {
  monthKey, addMonths, fmtMonthYear, toISODate, parseISO, pad2, cap,
  fmtWeekday, fmtDayMonth, fmtMoney, sessionsWord, timeToMin,
} from '../format.js'

const DOW = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd']
const STRIP_DOW = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd']
const PAYMENT_FILTERS = [
  { value: 'all', label: 'Wszystkie' },
  { value: 'paid', label: 'Opłacone' },
  { value: 'partial', label: 'Częściowe' },
  { value: 'unpaid', label: 'Nieopłacone' },
]
const ATTENDANCE_FILTERS = [
  { value: 'all', label: 'Wszyscy' },
  { value: 'completed', label: 'Obecny' },
  { value: 'noshow', label: 'Nieobecny' },
  { value: 'cancelled', label: 'Odwołana' },
  { value: 'scheduled', label: 'Zaplanowana' },
]

const defaultCalendarFilters = () => ({ payment: 'all', attendance: 'all' })

function monthGrid(ym) {
  const [y, m] = ym.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const startOffset = (first.getDay() + 6) % 7 // Monday-first
  const daysInMonth = new Date(y, m, 0).getDate()
  const cells = []
  for (let i = 0; i < startOffset; i++) {
    const d = new Date(y, m - 1, 1 - (startOffset - i))
    cells.push({ iso: toISODate(d), inMonth: false, dow: i % 7 })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ iso: `${y}-${pad2(m)}-${pad2(d)}`, inMonth: true, dow: cells.length % 7 })
  }
  while (cells.length % 7 !== 0) {
    const last = parseISO(cells[cells.length - 1].iso)
    last.setDate(last.getDate() + 1)
    cells.push({ iso: toISODate(last), inMonth: false, dow: cells.length % 7 })
  }
  return cells
}

// Phone agenda mode: horizontally scrollable month strip — day pills with
// psychologist-colored dots; the selected day auto-centers in the strip.
function DayStrip({ days, selected, today, byDate, psychOf, onSelect }) {
  const ref = useRef(null)
  const first = useRef(true)

  useEffect(() => {
    const strip = ref.current
    const el = strip?.querySelector('.day-strip__day.is-on')
    if (!strip || !el) return
    const left = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2
    strip.scrollTo({ left, behavior: first.current || !motionOK() ? 'auto' : 'smooth' })
    first.current = false
  }, [selected, days])

  return (
    <div className="day-strip" ref={ref}>
      {days.map((iso) => {
        const items = byDate[iso] || []
        const dowIdx = (parseISO(iso).getDay() + 6) % 7
        return (
          <button
            key={iso}
            className={[
              'day-strip__day',
              iso === selected ? 'is-on' : '',
              iso === today ? 'is-today' : '',
              dowIdx >= 5 ? 'is-weekend' : '',
            ].join(' ')}
            onClick={() => onSelect(iso)}
            aria-pressed={iso === selected}
            aria-label={`${fmtDayMonth(iso)} — ${items.length} ${sessionsWord(items.length)}`}
          >
            <span className="day-strip__dow">{STRIP_DOW[dowIdx]}</span>
            <span className="day-strip__num">{Number(iso.slice(8))}</span>
            <span className="day-strip__dots">
              {items.slice(0, 3).map((s) => (
                <span key={s.id} className="dot" style={{ background: psychOf(s.psychId)?.color }} />
              ))}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function CalendarView() {
  const { state, dispatch, toast } = useApp()
  const { openSessionForm, role } = useShell()
  const today = toISODate(new Date())
  const curYm = monthKey(new Date())
  const [ym, setYm] = useState(curYm)
  const [mode, setMode] = useState('agenda')
  const [selected, setSelected] = useState(today)
  const [filters, setFilters] = useState(defaultCalendarFilters)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [agendaExpanded, setAgendaExpanded] = useState(false)
  const isPhone = useIsPhone()
  // dragging an agenda row would trap touch scrolling, so it stays a desktop affordance
  const agendaDrag = useMediaQuery(`${desktopMQ} and (pointer: fine)`)
  const gridRef = useRef(null)
  const dayPanelRef = useRef(null)
  const agendaPanelRef = useRef(null)
  const ref = useReveal()
  const suppressClick = useRef(false)

  const roleSessions = useMemo(
    () => sessionsForRole(state, role),
    [state.sessions, role.psychId, role.scope]
  )
  const rolePsychologists = useMemo(
    () => role.scope === 'own'
      ? state.psychologists.filter((psychologist) => psychologist.id === role.psychId)
      : state.psychologists,
    [role, state.psychologists]
  )
  const monthsRange = useMemo(() => availableMonths(roleSessions), [roleSessions])
  const showWeekends = state.prefs.weekendsInCalendar
  const cells = useMemo(() => {
    const all = monthGrid(ym)
    return showWeekends ? all : all.filter((c) => c.dow < 5)
  }, [ym, showWeekends])

  // Role scope always precedes the local operational filters.
  const filteredSessions = useMemo(
    () => roleSessions.filter((session) => sessionMatchesFilters(session, filters)),
    [filters, roleSessions]
  )
  const monthSessions = useMemo(
    () => sessionsInMonth(filteredSessions, ym),
    [filteredSessions, ym]
  )
  const byDate = useMemo(() => {
    const map = {}
    monthSessions.forEach((s) => { (map[s.date] = map[s.date] || []).push(s) })
    return map
  }, [monthSessions])

  const clientOf = (id) => state.clients.find((c) => c.id === id)
  const psychOf = (id) => state.psychologists.find((p) => p.id === id)

  // --- drag & drop: reschedule by dragging a session chip onto another day ---
  const onChipDown = (e, s) => {
    if (s.status !== 'scheduled') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const chip = e.currentTarget
    const pid = e.pointerId
    const d = { startX: e.clientX, startY: e.clientY, active: false, ghost: null, dropIso: null, dropEl: null, moveX: null, moveY: null }

    const onMove = (ev) => {
      if (ev.pointerId !== pid) return
      if (!d.active) {
        if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 6) return
        d.active = true
        suppressClick.current = true
        const r = chip.getBoundingClientRect()
        const ghost = document.createElement('div')
        ghost.className = 'drag-ghost'
        ghost.textContent = `${s.time} · ${clientOf(s.clientId)?.name || 'Sesja'}`
        ghost.style.width = Math.min(Math.max(r.width + 16, 130), 220) + 'px'
        document.body.appendChild(ghost)
        d.ghost = ghost
        chip.classList.add('is-dragging')
        document.body.classList.add('is-grabbing')
        if (motionOK()) {
          window.gsap.set(ghost, { x: r.left, y: r.top })
          d.moveX = window.gsap.quickTo(ghost, 'x', { duration: 0.18, ease: 'power3' })
          d.moveY = window.gsap.quickTo(ghost, 'y', { duration: 0.18, ease: 'power3' })
          window.gsap.fromTo(ghost, { scale: 0.9, rotation: 0 }, { scale: 1.04, rotation: 2, duration: 0.25, ease: 'power3.out' })
        } else {
          ghost.style.transform = `translate(${r.left}px, ${r.top}px)`
        }
      }
      const gx = ev.clientX - 16
      const gy = ev.clientY - 16
      if (d.moveX) { d.moveX(gx); d.moveY(gy) }
      else if (d.ghost) d.ghost.style.transform = `translate(${gx}px, ${gy}px)`

      const under = document.elementFromPoint(ev.clientX, ev.clientY)
      const day = under ? under.closest('.cal__day[data-iso]') : null
      const iso = day && !day.classList.contains('is-out') ? day.dataset.iso : null
      const valid = iso && iso !== s.date
      const dropEl = valid ? day : null
      // only touch the DOM when the hovered day actually changes
      if (d.dropEl !== dropEl) {
        d.dropEl?.classList.remove('is-dropover')
        dropEl?.classList.add('is-dropover')
      }
      d.dropIso = valid ? iso : null
      d.dropEl = dropEl
    }

    const finish = (ev) => {
      if (ev && ev.pointerId !== pid) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      if (!d.active) return
      d.dropEl?.classList.remove('is-dropover')
      document.body.classList.remove('is-grabbing')
      chip.classList.remove('is-dragging')
      setTimeout(() => { suppressClick.current = false }, 0)
      const ghost = d.ghost
      if (d.dropIso) {
        const target = d.dropEl
        dispatch({ type: 'UPDATE_SESSION', id: s.id, patch: { date: d.dropIso } })
        // same non-blocking overlap check as the session form
        const start = timeToMin(s.time)
        const end = start + s.duration
        const clash = state.sessions.find(
          (o) =>
            o.id !== s.id &&
            o.psychId === s.psychId &&
            o.date === d.dropIso &&
            o.status !== 'cancelled' &&
            timeToMin(o.time) < end &&
            start < timeToMin(o.time) + o.duration
        )
        if (clash) {
          toast(`Sesja przeniesiona na ${fmtDayMonth(d.dropIso)} — uwaga, nakłada się z sesją o ${clash.time}`, 'alert')
        } else {
          toast(`Sesja przeniesiona na ${fmtDayMonth(d.dropIso)}`)
        }
        selectDay(d.dropIso)
        if (motionOK() && target) {
          const cr = target.getBoundingClientRect()
          window.gsap.to(ghost, {
            x: cr.left + 10, y: cr.top + 36, scale: 0.4, autoAlpha: 0,
            duration: 0.32, ease: 'power3.in', onComplete: () => ghost.remove(),
          })
          // compositor-friendly landing pulse on the receiving day
          window.gsap.fromTo(
            target,
            { scale: 1.045 },
            { scale: 1, duration: 0.45, ease: 'power2.out', clearProps: 'transform' }
          )
        } else ghost.remove()
      } else {
        const r = chip.getBoundingClientRect()
        if (motionOK()) {
          window.gsap.to(ghost, {
            x: r.left, y: r.top, scale: 1, rotation: 0, autoAlpha: 0.3,
            duration: 0.3, ease: 'power3.inOut', onComplete: () => ghost.remove(),
          })
        } else ghost.remove()
      }
    }
    const cancel = (ev) => {
      if (ev && ev.pointerId !== pid) return
      d.dropIso = null
      finish()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
  }

  // animate the month-grid swap only for real context changes (month, mode,
  // weekend pref) — filter changes keep the grid still so persisting sessions
  // stay visibly in place (state-driven continuity, not a blanket replay)
  const firstSwap = useRef(true)
  useEffect(() => {
    if (firstSwap.current) {
      firstSwap.current = false
      return
    }
    if (mode !== 'cal' || !motionOK() || !gridRef.current) return
    window.gsap.fromTo(
      gridRef.current.children,
      { autoAlpha: 0, y: 10 },
      { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power2.out', stagger: 0.006, clearProps: 'transform,opacity,visibility' }
    )
  }, [ym, mode, showWeekends])

  const filterKey = `${ym}|${filters.payment}|${filters.attendance}`
  // Filtered events retain spatial continuity in every operational view.
  const agendaFlipRef = useFlip(`agenda|${filterKey}`)
  const gridFlipRef = useFlip(`cal|${filterKey}`)

  const changeMonth = (d) => {
    const next = addMonths(ym, d)
    setYm(next)
    // keep a day selected so the panel never collapses to an empty prompt
    setSelected(next === curYm ? today : `${next}-01`)
  }

  const toggleFilter = (key, value) => {
    setFilters((current) => ({ ...current, [key]: current[key] === value ? 'all' : value }))
  }
  const activeFilterCount =
    (filters.payment !== 'all' ? 1 : 0) + (filters.attendance !== 'all' ? 1 : 0)
  const hasActiveFilters = activeFilterCount > 0
  const rolePsychId = role.scope === 'own' ? role.psychId : undefined

  // Selecting a day brings its session list into view only when it is off
  // screen — a panel the user can already see must not move under them.
  const selectDay = (iso) => {
    setSelected(iso)
    const panel = mode === 'agenda' ? agendaPanelRef.current : dayPanelRef.current
    if (!panel) return
    requestAnimationFrame(() => {
      const scrollport = panel.closest('.content')?.getBoundingClientRect()
      const rect = panel.getBoundingClientRect()
      const inView = scrollport &&
        rect.top < scrollport.bottom - 80 && rect.bottom > scrollport.top + 80
      if (inView) return
      panel.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'start' })
    })
  }

  const daySessions = selected ? (byDate[selected] || []) : []

  // --- phone agenda mode ---
  const stripDays = useMemo(() => {
    const [y, m] = ym.split('-').map(Number)
    const n = new Date(y, m, 0).getDate()
    return Array.from({ length: n }, (_, i) => `${y}-${pad2(m)}-${pad2(i + 1)}`)
  }, [ym])

  const agendaSel = selected || (ym === curYm ? today : `${ym}-01`)
  const agendaSessions = useMemo(
    () => (byDate[agendaSel] || []).slice().sort((a, b) => (a.time < b.time ? -1 : 1)),
    [byDate, agendaSel]
  )
  const shownAgendaSessions = agendaExpanded ? agendaSessions : agendaSessions.slice(0, 4)
  const hiddenAgendaSessions = agendaSessions.length - shownAgendaSessions.length

  useEffect(() => setAgendaExpanded(false), [agendaSel, filterKey])

  // gentle row cascade when another day is picked from the strip
  const firstAgendaSwap = useRef(true)
  useEffect(() => {
    if (mode !== 'agenda') {
      firstAgendaSwap.current = true
      return
    }
    if (firstAgendaSwap.current) {
      firstAgendaSwap.current = false
      return
    }
    if (!motionOK() || !agendaPanelRef.current) return
    window.gsap.fromTo(
      agendaPanelRef.current.querySelectorAll('.agenda__row, .empty'),
      { autoAlpha: 0, y: 12 },
      { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power3.out', stagger: 0.05, clearProps: 'transform,opacity,visibility' }
    )
  }, [agendaSel, mode])

  // one session row — shared by the desktop day panel and the phone agenda
  const dayRow = (s, dragOk) => {
    const c = clientOf(s.clientId)
    const p = psychOf(s.psychId)
    const draggable = dragOk && s.status === 'scheduled'
    return (
      <div
        className="agenda__row"
        key={s.id}
        data-flip-id={s.id}
        data-payment={s.payment}
        data-attendance={s.status}
        data-psych-id={s.psychId}
        onPointerDown={draggable ? (e) => onChipDown(e, s) : undefined}
        style={{ '--node-color': p?.color, ...(draggable ? { touchAction: 'none' } : null) }}
      >
        <span className="agenda__time">{s.time}</span>
        <span className="agenda__main">
          <span className="agenda__client">{c?.name}</span>
          <span className="agenda__meta">
            <Avatar name={p?.name || '?'} color={p?.color} size={16} />
            {p?.name} · {fmtMoney(s.amount)}
          </span>
          <span className="agenda__pills">
            <StatusPicker session={s} />
            <PaymentPicker session={s} />
          </span>
        </span>
        <IconBtn name="edit" label="Edytuj sesję" size={16} onClick={() => openSessionForm({ session: s })} />
      </div>
    )
  }

  // a day's rows on the day thread, with the "teraz" marker when it is today
  const dayThread = (sessions, dragOk, iso, flipRef) => {
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const isToday = iso === today
    return (
      <div className="agenda agenda--spine" ref={flipRef} style={{ marginTop: 6 }}>
        {sessions.length > 0 && <span className="spine__rule" aria-hidden="true" />}
        {sessions.map((s, i) => {
          const nowHere = isToday &&
            timeToMin(s.time) > nowMin &&
            (i === 0 || timeToMin(sessions[i - 1].time) <= nowMin)
          return (
            <Fragment key={s.id}>
              {nowHere && <div className="spine__now" aria-hidden="true">teraz</div>}
              {dayRow(s, dragOk)}
            </Fragment>
          )
        })}
      </div>
    )
  }

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Sesje i grafik</div>
          <h1 className="display view-head__title">Kalendarz <em>sesji</em></h1>
        </div>
        <div className="view-head__actions">
          <Segmented
            ariaLabel="Widok"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'agenda', label: 'Plan dnia', icon: 'clock' },
              { value: 'cal', label: 'Miesiąc', icon: 'calendar' },
            ]}
          />
          {/* the phone's raised tabbar action already covers "new session" */}
          {!isPhone && (
            <Button icon="plus" magnetic onClick={() => openSessionForm({ date: selected || today, psychId: rolePsychId })}>
              Nowa sesja
            </Button>
          )}
        </div>
      </div>

      <div className="row row--between cal-toolbar" data-reveal>
        <div className="row" style={{ gap: 14 }}>
          <div className="month-nav">
            <IconBtn name="chevL" label="Poprzedni miesiąc" disabled={ym <= monthsRange[0]} onClick={() => changeMonth(-1)} />
            <span className="month-nav__label">{fmtMonthYear(ym)}</span>
            <IconBtn name="chevR" label="Następny miesiąc" disabled={ym >= monthsRange[monthsRange.length - 1]} onClick={() => changeMonth(1)} />
          </div>
          {ym !== curYm && (
            <Button variant="ghost" size="sm" onClick={() => { setYm(curYm); setSelected(today) }}>
              Dziś
            </Button>
          )}
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="faint" aria-live="polite" style={{ fontSize: 13.5 }}>
            {monthSessions.length} {sessionsWord(monthSessions.length)} w tym miesiącu
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon="filter"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filtry{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <section className="cal-filters" aria-label="Filtry kalendarza">
          <div className="cal-filters__group" role="group" aria-label="Płatność">
            <span className="cal-filters__label">Płatność</span>
            {PAYMENT_FILTERS.map((payment) => (
              <Chip key={payment.value} on={filters.payment === payment.value} onClick={() => toggleFilter('payment', payment.value)}>
                {payment.label}
              </Chip>
            ))}
          </div>
          <div className="cal-filters__group" role="group" aria-label="Obecność klienta">
            <span className="cal-filters__label">Obecność</span>
            {ATTENDANCE_FILTERS.map((attendance) => (
              <Chip key={attendance.value} on={filters.attendance === attendance.value} onClick={() => toggleFilter('attendance', attendance.value)}>
                {attendance.label}
              </Chip>
            ))}
          </div>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={() => setFilters(defaultCalendarFilters)}>
              Wyczyść filtry
            </Button>
          )}
        </section>
      )}

      {mode === 'agenda' ? (
        <>
          <DayStrip
            days={stripDays}
            selected={agendaSel}
            today={today}
            byDate={byDate}
            psychOf={psychOf}
            onSelect={selectDay}
          />
          <section className="card card--pad agenda-day" ref={agendaPanelRef} data-reveal aria-label="Plan dnia">
            <h2 className="card-title">
              <span className="row" style={{ gap: 9 }}>
                {cap(fmtWeekday(agendaSel))}, {fmtDayMonth(agendaSel)}
                {agendaSel === today && <span className="pill pill--gold">dziś</span>}
              </span>
              <span className="faint" style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 550 }}>
                {agendaSessions.length} {sessionsWord(agendaSessions.length)}
              </span>
            </h2>
            {agendaSessions.length === 0 ? (
              <EmptyState
                compact
                icon="calendar"
                title="Brak sesji tego dnia"
                hint="Dodaj pierwszą sesję przyciskiem poniżej."
              />
            ) : (
              dayThread(shownAgendaSessions, false, agendaSel, agendaFlipRef)
            )}
            {hiddenAgendaSessions > 0 && (
              <button
                type="button"
                className="bpost-more"
                aria-label={`Jeszcze ${hiddenAgendaSessions} ${sessionsWord(hiddenAgendaSessions)}`}
                onClick={() => setAgendaExpanded(true)}
              >
                +{hiddenAgendaSessions} więcej
              </button>
            )}
            <Button variant="soft" size="sm" icon="plus" className="btn--full" style={{ marginTop: 14 }}
              onClick={() => openSessionForm({ date: agendaSel, psychId: rolePsychId })}>
              Dodaj sesję tego dnia
            </Button>
          </section>
        </>
      ) : (
        <div className="grid-31" data-reveal>
          <div>
            <div className="cal" style={{ gridTemplateColumns: `repeat(${showWeekends ? 7 : 5}, 1fr)`, marginBottom: 7 }}>
              {(showWeekends ? DOW : DOW.slice(0, 5)).map((d) => (
                <div key={d} className="cal__dow">{d}</div>
              ))}
            </div>
            <div
              className="cal"
              ref={(node) => { gridRef.current = node; gridFlipRef.current = node }}
              style={{ gridTemplateColumns: `repeat(${showWeekends ? 7 : 5}, 1fr)` }}
            >
              {cells.map((cell) => {
                const items = (byDate[cell.iso] || []).sort((a, b) => (a.time < b.time ? -1 : 1))
                return (
                  <button
                    key={cell.iso}
                    data-iso={cell.iso}
                    data-flip-id={`day-${cell.iso}`}
                    className={[
                      'cal__day',
                      cell.inMonth ? '' : 'is-out',
                      cell.iso === today ? 'is-today' : '',
                      cell.iso === selected ? 'is-sel' : '',
                      cell.dow >= 5 ? 'is-weekend' : '',
                    ].join(' ')}
                    onClick={() => { if (!suppressClick.current) selectDay(cell.iso) }}
                    aria-label={`${fmtDayMonth(cell.iso)} — ${items.length} ${sessionsWord(items.length)}`}
                  >
                    <span className="cal__num">{Number(cell.iso.slice(8))}</span>
                    {isPhone ? (
                      <span className="cal__dots">
                        {items.slice(0, 4).map((s) => (
                          <span key={s.id} className="dot" style={{ background: psychOf(s.psychId)?.color }} />
                        ))}
                        {items.length > 4 && <span className="cal__more">+{items.length - 4}</span>}
                      </span>
                    ) : (
                      <span className="cal__items">
                        {items.slice(0, 3).map((s) => (
                          <span
                            key={s.id}
                            className={`cal__item ${s.status === 'scheduled' ? 'is-draggable' : ''}`}
                            data-flip-id={s.id}
                            style={{ background: psychOf(s.psychId)?.soft }}
                            onPointerDown={(e) => onChipDown(e, s)}
                            title={s.status === 'scheduled' ? 'Przeciągnij, aby przełożyć sesję' : undefined}
                          >
                            <span className="dot" style={{ background: psychOf(s.psychId)?.color }} />
                            {s.time} {clientOf(s.clientId)?.name.split(' ')[0]}
                          </span>
                        ))}
                        {items.length > 3 && <span className="cal__more">+{items.length - 3} więcej</span>}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            <div className="legend" style={{ marginTop: 16 }}>
              {rolePsychologists.map((p) => (
                <span key={p.id} className="legend__item">
                  <span className="legend__swatch" style={{ background: p.color }} />
                  {p.name}
                </span>
              ))}
            </div>
          </div>

          <div className="card card--pad cal-day-panel" ref={dayPanelRef}>
            <h2 className="card-title">
              <span className="row" style={{ gap: 9 }}>
                {selected ? cap(fmtWeekday(selected)) + ', ' + fmtDayMonth(selected) : 'Wybierz dzień'}
                {selected === today && <span className="pill pill--gold">dziś</span>}
              </span>
              {selected && (
                <span className="faint" style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 550 }}>
                  {daySessions.length} {sessionsWord(daySessions.length)}
                </span>
              )}
            </h2>
            {selected && daySessions.length === 0 && (
              <EmptyState
                compact
                icon="calendar"
                title="Brak sesji tego dnia"
                hint="Dodaj pierwszą sesję przyciskiem poniżej."
              />
            )}
            {daySessions.length > 0 &&
              dayThread(daySessions.slice().sort((a, b) => (a.time < b.time ? -1 : 1)), agendaDrag, selected)}
            {selected && (
              <Button variant="soft" size="sm" icon="plus" className="btn--full" style={{ marginTop: 14 }}
                onClick={() => openSessionForm({ date: selected, psychId: rolePsychId })}>
                Dodaj sesję tego dnia
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
