import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, sessionsInMonth, availableMonths } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useFlip, motionOK } from '../anim.js'
import { useIsPhone, useIsCompact, useMediaQuery, desktopMQ, phoneMQ } from '../responsive.js'
import { Button, IconBtn, Segmented, Avatar, Chip, EmptyState } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { StatusPicker, PaymentPicker } from './session-bits.jsx'
import {
  monthKey, addMonths, fmtMonthYear, toISODate, parseISO, pad2, cap,
  fmtWeekday, fmtDayMonth, fmtMoney, sessionsWord, timeToMin, outstandingOf,
} from '../format.js'

const DOW = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd']
const STRIP_DOW = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd']

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
    <div className="day-strip" ref={ref} data-reveal>
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
  const { openSessionForm } = useShell()
  const today = toISODate(new Date())
  const curYm = monthKey(new Date())
  const [ym, setYm] = useState(curYm)
  // phones start in the day agenda — the 7-column grid is a tap target maze there
  const [mode, setMode] = useState(() => (window.matchMedia(phoneMQ).matches ? 'agenda' : 'cal'))
  const [selected, setSelected] = useState(today)
  const [psychFilter, setPsychFilter] = useState(null)
  const [statusFilter, setStatusFilter] = useState(null)
  const [unpaidOnly, setUnpaidOnly] = useState(false)
  const isPhone = useIsPhone()
  const isCompact = useIsCompact()

  // crossing the phone breakpoint swaps the available modes
  useEffect(() => {
    if (isPhone && mode === 'list') setMode('agenda')
    if (!isPhone && mode === 'agenda') setMode('cal')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPhone])
  // dragging an agenda row would trap touch scrolling, so it stays a desktop affordance
  const agendaDrag = useMediaQuery(`${desktopMQ} and (pointer: fine)`)
  const gridRef = useRef(null)
  const dayPanelRef = useRef(null)
  const ref = useReveal()
  const suppressClick = useRef(false)

  const monthsRange = useMemo(() => availableMonths(state.sessions), [state.sessions])
  const showWeekends = state.prefs.weekendsInCalendar
  const cells = useMemo(() => {
    const all = monthGrid(ym)
    return showWeekends ? all : all.filter((c) => c.dow < 5)
  }, [ym, showWeekends])

  // cancelled sessions are not shown on the grid (they stay in client history)
  const monthSessions = useMemo(
    () => sessionsInMonth(state.sessions, ym).filter(
      (s) =>
        s.status !== 'cancelled' &&
        (!psychFilter || s.psychId === psychFilter) &&
        (!statusFilter || s.status === statusFilter) &&
        (!unpaidOnly || outstandingOf(s) > 0)
    ),
    [state.sessions, ym, psychFilter, statusFilter, unpaidOnly]
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
        setSelected(d.dropIso)
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
    if (mode === 'list' || !motionOK() || !gridRef.current) return
    window.gsap.fromTo(
      gridRef.current.children,
      { autoAlpha: 0, y: 10 },
      { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power2.out', stagger: 0.006, clearProps: 'transform,opacity,visibility' }
    )
  }, [ym, mode, showWeekends])

  // list mode: day cards glide (FLIP) when filters add/remove/move them
  const flipRef = useFlip(`${mode}|${ym}|${psychFilter}|${statusFilter}|${unpaidOnly}`)

  const changeMonth = (d) => {
    const next = addMonths(ym, d)
    setYm(next)
    // keep a day selected so the panel never collapses to an empty prompt
    setSelected(next === curYm ? today : `${next}-01`)
  }

  // stacked layouts put the day panel below the grid — bring it into view
  const selectDay = (iso) => {
    setSelected(iso)
    if (isCompact) {
      requestAnimationFrame(() =>
        dayPanelRef.current?.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'start' })
      )
    }
  }

  const daySessions = selected ? (byDate[selected] || []) : []

  const listDays = useMemo(() => {
    const days = Object.keys(byDate).sort()
    return days.map((iso) => ({ iso, items: byDate[iso].sort((a, b) => (a.time < b.time ? -1 : 1)) }))
  }, [byDate])

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

  // gentle row cascade when another day is picked from the strip
  const agendaRef = useRef(null)
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
    if (!motionOK() || !agendaRef.current) return
    window.gsap.fromTo(
      agendaRef.current.querySelectorAll('.agenda__row, .empty'),
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
  const dayThread = (sessions, dragOk, iso) => {
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const isToday = iso === today
    return (
      <div className="agenda agenda--spine" style={{ marginTop: 6 }}>
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
            options={isPhone
              ? [
                  { value: 'agenda', label: 'Plan dnia', icon: 'clock' },
                  { value: 'cal', label: 'Miesiąc', icon: 'calendar' },
                ]
              : [
                  { value: 'cal', label: 'Kalendarz', icon: 'calendar' },
                  { value: 'list', label: 'Lista', icon: 'reports' },
                ]}
          />
          {/* the phone's raised tabbar action already covers "new session" */}
          {!isPhone && (
            <Button icon="plus" magnetic onClick={() => openSessionForm({ date: selected || today, psychId: psychFilter || undefined })}>
              Nowa sesja
            </Button>
          )}
        </div>
      </div>

      <div className="row chips-row" data-reveal>
        <Chip on={!psychFilter} onClick={() => setPsychFilter(null)}>Cały zespół</Chip>
        {state.psychologists.map((p) => (
          <Chip key={p.id} on={psychFilter === p.id} swatch={p.color}
            onClick={() => setPsychFilter(psychFilter === p.id ? null : p.id)}>
            {p.name.split(' ')[0]}
          </Chip>
        ))}
        <span className="chips-row__divider" />
        {[
          { value: 'scheduled', label: 'Zaplanowane' },
          { value: 'completed', label: 'Odbyte' },
          { value: 'noshow', label: 'Nieobecności' },
        ].map((o) => (
          <Chip key={o.value} on={statusFilter === o.value}
            onClick={() => setStatusFilter(statusFilter === o.value ? null : o.value)}>
            {o.label}
          </Chip>
        ))}
        <span className="chips-row__divider" />
        <Chip on={unpaidOnly} onClick={() => setUnpaidOnly(!unpaidOnly)}>
          <Icon name="payments" size={14} /> Nieopłacone
        </Chip>
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
        <span className="faint" style={{ fontSize: 13.5 }}>
          {monthSessions.length} {sessionsWord(monthSessions.length)} w tym miesiącu
          {mode === 'cal' && (
            <span className="cal-hint"> · przeciągnij sesję na inny dzień albo zmień datę w edycji sesji</span>
          )}
        </span>
      </div>

      {mode === 'agenda' ? (
        <>
          <DayStrip
            days={stripDays}
            selected={agendaSel}
            today={today}
            byDate={byDate}
            psychOf={psychOf}
            onSelect={setSelected}
          />
          <div className="card card--pad agenda-day" ref={agendaRef} data-reveal>
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
                hint="Dodaj sesję przyciskiem poniżej."
              />
            ) : (
              dayThread(agendaSessions, false, agendaSel)
            )}
            <Button variant="soft" size="sm" icon="plus" className="btn--full" style={{ marginTop: 14 }}
              onClick={() => openSessionForm({ date: agendaSel, psychId: psychFilter || undefined })}>
              Dodaj sesję tego dnia
            </Button>
          </div>
        </>
      ) : mode === 'cal' ? (
        <div className="grid-31" data-reveal>
          <div>
            <div className="cal" style={{ gridTemplateColumns: `repeat(${showWeekends ? 7 : 5}, 1fr)`, marginBottom: 7 }}>
              {(showWeekends ? DOW : DOW.slice(0, 5)).map((d) => (
                <div key={d} className="cal__dow">{d}</div>
              ))}
            </div>
            <div className="cal" ref={gridRef} style={{ gridTemplateColumns: `repeat(${showWeekends ? 7 : 5}, 1fr)` }}>
              {cells.map((cell) => {
                const items = (byDate[cell.iso] || []).sort((a, b) => (a.time < b.time ? -1 : 1))
                return (
                  <button
                    key={cell.iso}
                    data-iso={cell.iso}
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
              {state.psychologists.map((p) => (
                <span key={p.id} className="legend__item" style={psychFilter && psychFilter !== p.id ? { opacity: 0.35 } : undefined}>
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
                hint="Dodaj sesję przyciskiem poniżej."
              />
            )}
            {daySessions.length > 0 &&
              dayThread(daySessions.slice().sort((a, b) => (a.time < b.time ? -1 : 1)), agendaDrag, selected)}
            {selected && (
              <Button variant="soft" size="sm" icon="plus" className="btn--full" style={{ marginTop: 14 }}
                onClick={() => openSessionForm({ date: selected, psychId: psychFilter || undefined })}>
                Dodaj sesję tego dnia
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="stack" ref={flipRef} data-reveal>
          {listDays.length === 0 && (
            <div className="card card--pad">
              <EmptyState
                icon="calendar"
                title="Brak sesji w tym miesiącu"
                hint="Zaplanuj pierwsze spotkanie, aby pojawiło się w grafiku."
                action={<Button size="sm" icon="plus" onClick={() => openSessionForm({ date: today })}>Nowa sesja</Button>}
              />
            </div>
          )}
          {listDays.map(({ iso, items }) => (
            <div className="card card--pad" key={iso} data-flip-id={iso} style={{ padding: '18px 24px' }}>
              <div className="row row--between" style={{ marginBottom: 4 }}>
                <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 500 }}>
                  {cap(fmtWeekday(iso))}, {fmtDayMonth(iso)}
                  {iso === today && <span className="pill pill--gold" style={{ marginLeft: 10 }}>dziś</span>}
                </h3>
                <span className="faint" style={{ fontSize: 12.5 }}>{items.length} {sessionsWord(items.length)}</span>
              </div>
              <div className="table-scroll table-scroll--until-tablet">
              <table className="table table--cards">
                <tbody>
                  {items.map((s) => {
                    const c = clientOf(s.clientId)
                    const p = psychOf(s.psychId)
                    return (
                      <tr key={s.id}>
                        <td className="num-cell td--time" data-th="Godzina">{s.time}</td>
                        <td style={{ fontWeight: 600 }}>{c?.name}</td>
                        <td data-th="Specjalistka">
                          <span className="row" style={{ gap: 8 }}>
                            <span className="dot" style={{ width: 8, height: 8, borderRadius: 99, background: p?.color, display: 'inline-block' }} />
                            <span className="muted">{p?.name}</span>
                          </span>
                        </td>
                        <td className="num-cell" data-th="Kwota">{fmtMoney(s.amount)}</td>
                        <td data-th="Status"><StatusPicker session={s} /></td>
                        <td data-th="Płatność"><PaymentPicker session={s} /></td>
                        <td className="right td--actions" style={{ width: 50 }}>
                          <IconBtn name="edit" label="Edytuj" size={16} onClick={() => openSessionForm({ session: s })} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
