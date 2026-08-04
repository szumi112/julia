import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useAppointmentMutationLock, useWorkspaceRefresh, useWorkspaceWindow, sessionsInMonth, availableMonths } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useFlip, motionOK } from '../anim.js'
import { useIsPhone, useMediaQuery, desktopMQ } from '../responsive.js'
import { Button, IconBtn, Segmented, Avatar, Chip, Pill, EmptyState } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { StatusPicker, PaymentPicker } from './session-bits.jsx'
import { useRouteParamsSync } from '../ux-patterns.jsx'
import { sessionMatchesFilters, sessionsForRole } from '../workspace.js'
import { serviceBadge } from '../services.js'
import {
  monthKey, addMonths, fmtMonthYear, toISODate, parseISO, pad2, cap,
  fmtWeekday, fmtDayMonth, fmtWeekRange, fmtMoney, sessionsWord, timeToMin,
  STATUS_LABELS, PAY_LABELS,
} from '../format.js'
import {
  clientIdentityFor,
  monthWorkspaceRange,
  specialistIdentityFor,
  weekWorkspaceRange,
} from '../workspace-view.js'
import { ApiError } from '../api.js'

const DOW = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd']
const STRIP_DOW = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd']
const PAYMENT_FILTERS = [
  { value: 'all', label: 'Wszystkie' },
  { value: 'partial', label: 'Częściowo opłacona' },
  { value: 'unpaid', label: 'Nieopłacona' },
  { value: 'paid', label: 'Opłacona' },
]
const ATTENDANCE_FILTERS = [
  { value: 'all', label: 'Wszystkie' },
  { value: 'noshow', label: 'Nieobecność' },
  { value: 'completed', label: 'Odbyta' },
  { value: 'cancelled', label: 'Odwołana' },
  { value: 'scheduled', label: 'Zaplanowana' },
]

const defaultCalendarFilters = () => ({ payment: 'all', attendance: 'all' })

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isISODate(value) {
  if (!ISO_DATE.test(value || '')) return false
  return toISODate(parseISO(value)) === value
}

function addDays(iso, amount) {
  const date = parseISO(iso)
  date.setDate(date.getDate() + amount)
  return toISODate(date)
}

function weekDaysFor(iso) {
  const date = parseISO(iso)
  const mondayOffset = (date.getDay() + 6) % 7
  const monday = addDays(iso, -mondayOffset)
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index))
}

function initialCalendarViewState(getViewState, params, today) {
  const defaults = {
    ym: monthKey(today),
    selected: today,
    mode: 'agenda',
    filters: defaultCalendarFilters(),
    filtersOpen: false,
  }
  const persisted = getViewState('calendar', defaults)
  const paramDate = isISODate(params?.date) ? params.date : null
  const persistedDate = isISODate(persisted.selected) ? persisted.selected : today
  const selected = paramDate || persistedDate
  // URL params win over the registry — a shared link must reproduce its scope
  const payment = PAYMENT_FILTERS.some(({ value }) => value === params?.payment)
    ? params.payment
    : PAYMENT_FILTERS.some(({ value }) => value === persisted.filters?.payment)
      ? persisted.filters.payment
      : 'all'
  const attendance = ATTENDANCE_FILTERS.some(({ value }) => value === params?.attendance)
    ? params.attendance
    : ATTENDANCE_FILTERS.some(({ value }) => value === persisted.filters?.attendance)
      ? persisted.filters.attendance
      : 'all'
  const paramYm = /^\d{4}-\d{2}$/.test(params?.ym || '') ? params.ym : null

  return {
    ym: paramDate
      ? monthKey(paramDate)
      : paramYm || (/^\d{4}-\d{2}$/.test(persisted.ym || '') ? persisted.ym : monthKey(selected)),
    selected,
    mode: params?.mode === 'cal' ? 'cal' : persisted.mode === 'cal' ? 'cal' : 'agenda',
    filters: { payment, attendance },
    filtersOpen: Boolean(persisted.filtersOpen),
  }
}

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

const appointmentEditInput = (session, patch = {}) => ({
  specialistId: session.psychId,
  serviceId: session.service,
  date: session.date,
  time: session.time,
  durationMinutes: session.duration,
  expectedAmountGrosze: Math.round(session.amount * 100),
  location: session.location ?? null,
  status: session.status,
  ...patch,
})

// Seven-day, Monday-first strip. The toolbar above owns week navigation, so the
// strip is purely the day picker. Keyboard movement updates selection and focus
// together so only the active date participates in the tab order.
function DayStrip({ days, selected, today, byDate, psychOf, onSelect }) {
  const ref = useRef(null)
  const first = useRef(true)
  const focusDate = useRef(null)

  useEffect(() => {
    const strip = ref.current
    const el = strip?.querySelector('.day-strip__day.is-on')
    if (!strip || !el) return
    const left = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2
    strip.scrollTo({ left, behavior: first.current || !motionOK() ? 'auto' : 'smooth' })
    first.current = false
  }, [selected, days])

  useEffect(() => {
    if (!focusDate.current) return
    const iso = focusDate.current
    focusDate.current = null
    ref.current?.querySelector(`[data-iso="${iso}"]`)?.focus()
  }, [days, selected])

  const selectAndFocus = (iso) => {
    focusDate.current = iso
    onSelect(iso)
  }

  const onDayKeyDown = (event, iso) => {
    let next = null
    if (event.key === 'ArrowLeft') next = addDays(iso, -1)
    if (event.key === 'ArrowRight') next = addDays(iso, 1)
    if (event.key === 'Home') next = days[0]
    if (event.key === 'End') next = days[6]
    if (event.key === 'PageUp') next = addDays(iso, -7)
    if (event.key === 'PageDown') next = addDays(iso, 7)
    if (!next) return
    event.preventDefault()
    selectAndFocus(next)
  }

  return (
    <div className="day-strip" ref={ref} role="group" aria-label="Tydzień">
      {days.map((iso) => {
        const items = byDate[iso] || []
        const dowIdx = (parseISO(iso).getDay() + 6) % 7
        return (
          <button
            type="button"
            key={iso}
            data-iso={iso}
            className={[
              'day-strip__day',
              iso === selected ? 'is-on' : '',
              iso === today ? 'is-today' : '',
              dowIdx >= 5 ? 'is-weekend' : '',
            ].join(' ')}
            onClick={() => onSelect(iso)}
            onKeyDown={(event) => onDayKeyDown(event, iso)}
            aria-pressed={iso === selected}
            aria-label={`${fmtDayMonth(iso)} — ${items.length} ${sessionsWord(items.length)}`}
            tabIndex={iso === selected ? 0 : -1}
          >
            <span className="day-strip__dow">{STRIP_DOW[dowIdx]}</span>
            <span className="day-strip__num">{Number(iso.slice(8))}</span>
            <span className="day-strip__dots">
              {items.slice(0, 3).map((session) => (
                <span key={session.id} className="dot" style={{ background: psychOf(session.psychId)?.color }} />
              ))}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function CalendarView({ params = {} }) {
  const { state, dispatch, toast, workspace } = useApp()
  const { locked: appointmentMutationLocked } = useAppointmentMutationLock()
  const refreshWorkspace = useWorkspaceRefresh()
  const { appMode, capabilities, getViewState, openSessionForm, patchViewState, role } = useShell()
  const isApp = appMode === 'app'
  const today = toISODate(new Date())
  const curYm = monthKey(new Date())
  const [initialViewState] = useState(() => initialCalendarViewState(getViewState, params, today))
  const [ym, setYm] = useState(initialViewState.ym)
  const [mode, setMode] = useState(initialViewState.mode)
  const [selected, setSelected] = useState(initialViewState.selected)
  const [filters, setFilters] = useState(initialViewState.filters)
  const [filtersOpen, setFiltersOpen] = useState(initialViewState.filtersOpen)
  const isPhone = useIsPhone()
  // dragging an agenda row or a month-grid chip would trap touch scrolling,
  // so it stays a fine-pointer affordance (reschedule via the session form)
  const dragPointer = useMediaQuery(`${desktopMQ} and (pointer: fine)`)
  const gridRef = useRef(null)
  const dayPanelRef = useRef(null)
  const agendaPanelRef = useRef(null)
  const ref = useReveal()
  const suppressClick = useRef(false)

  const roleSessions = useMemo(
    () => sessionsForRole(state, role),
    [state.sessions, role.psychId, role.scope]
  )
  const highlightIdsKey = Array.isArray(params.highlightSessionIds)
    ? params.highlightSessionIds.join('|')
    : ''
  const highlightedSessionIds = useMemo(() => {
    const inRole = new Set(roleSessions.map((session) => session.id))
    return new Set(
      (Array.isArray(params.highlightSessionIds) ? params.highlightSessionIds : [])
        .filter((id) => inRole.has(id))
    )
  }, [highlightIdsKey, roleSessions])
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
    () => roleSessions.filter((session) => (
      sessionMatchesFilters(session, filters) || highlightedSessionIds.has(session.id)
    )),
    [filters, highlightedSessionIds, roleSessions]
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
  const weekByDate = useMemo(() => {
    const map = {}
    filteredSessions.forEach((session) => {
      (map[session.date] = map[session.date] || []).push(session)
    })
    return map
  }, [filteredSessions])

  useEffect(() => {
    patchViewState('calendar', { ym, selected, mode, filters, filtersOpen })
  }, [filters, filtersOpen, mode, patchViewState, selected, ym])

  // the whole visible scope lives in the URL — deep-link params pass through
  useRouteParamsSync('calendar', {
    date: selected,
    ym: mode === 'cal' ? ym : undefined,
    mode: mode === 'cal' ? 'cal' : undefined,
    payment: filters.payment !== 'all' ? filters.payment : undefined,
    attendance: filters.attendance !== 'all' ? filters.attendance : undefined,
    highlightSessionIds: params.highlightSessionIds?.length ? params.highlightSessionIds : undefined,
  })

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

    const finish = async (ev) => {
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
        if (isApp) {
          let commandAccepted = false
          try {
            await workspace.editAppointment(s.id, s.version, appointmentEditInput(s, { date: d.dropIso }))
            commandAccepted = true
            await refreshWorkspace(workspaceRange)
          } catch (error) {
            if (!commandAccepted && error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
              try {
                await refreshWorkspace(workspaceRange)
                toast('Termin został zmieniony. Odświeżono kalendarz.', 'alert')
              } catch {
                toast('Termin został zmieniony, ale nie udało się odświeżyć kalendarza.', 'alert')
              }
            } else if (commandAccepted) {
              toast('Sesję przeniesiono, ale nie udało się odświeżyć kalendarza.', 'alert')
            } else {
              toast('Nie udało się przenieść sesji.', 'alert')
            }
            const r = chip.getBoundingClientRect()
            if (motionOK()) {
              window.gsap.to(ghost, {
                x: r.left, y: r.top, scale: 1, rotation: 0, autoAlpha: 0.3,
                duration: 0.3, ease: 'power3.inOut', onComplete: () => ghost.remove(),
              })
            } else ghost.remove()
            return
          }
        } else {
          dispatch({ type: 'UPDATE_SESSION', id: s.id, patch: { date: d.dropIso } })
        }
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
      { y: 6 },
      { y: 0, duration: 0.18, ease: 'power2.out', stagger: { amount: 0.05 }, clearProps: 'transform' }
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
    setYm(monthKey(iso))
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

  // The month grid mirrors the day strip's keyboard model: arrows move the
  // selection (and the focus) while only the selected day sits in tab order.
  const gridFocusDate = useRef(null)
  useEffect(() => {
    if (!gridFocusDate.current) return
    const iso = gridFocusDate.current
    gridFocusDate.current = null
    gridRef.current?.querySelector(`[data-iso="${iso}"]`)?.focus()
  }, [selected, cells])

  const onGridDayKeyDown = (event, iso) => {
    // with weekends hidden, skip the invisible cells so the selection (and
    // the grid's only tab stop) never lands on a day that isn't rendered
    const step = (delta) => {
      let next = addDays(iso, delta)
      if (!showWeekends) {
        let guard = 0
        while ((parseISO(next).getDay() + 6) % 7 >= 5 && guard < 7) {
          next = addDays(next, delta > 0 ? 1 : -1)
          guard += 1
        }
      }
      return next
    }
    let next = null
    if (event.key === 'ArrowLeft') next = step(-1)
    if (event.key === 'ArrowRight') next = step(1)
    if (event.key === 'ArrowUp') next = addDays(iso, -7)
    if (event.key === 'ArrowDown') next = addDays(iso, 7)
    if (event.key === 'Home') next = weekDaysFor(iso)[0]
    if (event.key === 'End') next = showWeekends ? weekDaysFor(iso)[6] : weekDaysFor(iso)[4]
    if (!next) return
    event.preventDefault()
    gridFocusDate.current = next
    selectDay(next)
  }

  const daySessions = selected ? (byDate[selected] || []) : []

  const agendaSel = selected || (ym === curYm ? today : `${ym}-01`)
  const agendaSessions = useMemo(
    () => (byDate[agendaSel] || []).slice().sort((a, b) => (a.time < b.time ? -1 : 1)),
    [byDate, agendaSel]
  )
  const weekDays = useMemo(() => weekDaysFor(agendaSel), [agendaSel])
  const workspaceRange = useMemo(
    () => mode === 'agenda' ? weekWorkspaceRange(agendaSel) : monthWorkspaceRange(ym),
    [agendaSel, mode, ym]
  )
  const workspaceState = useWorkspaceWindow(workspaceRange, isApp)
  const canManageAppointments = !isApp || (
    capabilities.includes('appointment.manage')
    && workspaceState === 'ready'
    && !appointmentMutationLocked
  )
  const canDrag = dragPointer && canManageAppointments

  const changeAppointmentStatus = async (session, status) => {
    let commandAccepted = false
    try {
      if (status === 'cancelled') {
        await workspace.cancelAppointment(session.id, session.version)
      } else {
        await workspace.editAppointment(session.id, session.version, appointmentEditInput(session, { status }))
      }
      commandAccepted = true
      await refreshWorkspace(workspaceRange)
    } catch (error) {
      if (!commandAccepted && error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        try {
          await refreshWorkspace(workspaceRange)
          toast('Termin został zmieniony. Odświeżono kalendarz.', 'alert')
        } catch {
          toast('Termin został zmieniony, ale nie udało się odświeżyć kalendarza.', 'alert')
        }
      } else if (commandAccepted) {
        toast('Status sesji zapisano, ale nie udało się odświeżyć kalendarza.', 'alert')
      } else {
        toast('Nie udało się zmienić statusu sesji.', 'alert')
      }
      return
    }
    toast(status === 'cancelled'
      ? 'Sesja odwołana — nie jest fakturowana'
      : `Status zmieniony: ${STATUS_LABELS[status].toLowerCase()}`)
  }

  // One navigator per view: Plan dnia moves by week, Miesiąc by month, and the
  // toolbar counts whatever the user is actually looking at.
  const firstMonth = monthsRange[0]
  const lastMonth = monthsRange[monthsRange.length - 1]
  const nav = mode === 'agenda'
    ? {
      label: fmtWeekRange(weekDays[0], weekDays[6]),
      prevLabel: 'Poprzedni tydzień',
      nextLabel: 'Następny tydzień',
      prev: () => selectDay(addDays(agendaSel, -7)),
      next: () => selectDay(addDays(agendaSel, 7)),
      prevOff: !isApp && monthKey(addDays(weekDays[0], -7)) < firstMonth,
      nextOff: !isApp && monthKey(addDays(weekDays[6], 7)) > lastMonth,
      atToday: agendaSel === today,
      count: `${agendaSessions.length} ${sessionsWord(agendaSessions.length)} tego dnia`,
    }
    : {
      label: fmtMonthYear(ym),
      prevLabel: 'Poprzedni miesiąc',
      nextLabel: 'Następny miesiąc',
      prev: () => changeMonth(-1),
      next: () => changeMonth(1),
      prevOff: !isApp && ym <= firstMonth,
      nextOff: !isApp && ym >= lastMonth,
      atToday: ym === curYm,
      count: `${monthSessions.length} ${sessionsWord(monthSessions.length)} w tym miesiącu`,
    }
  const focusedHighlightKey = useRef(null)
  useEffect(() => {
    if (highlightedSessionIds.size === 0) return
    const requestKey = `${agendaSel}|${highlightIdsKey}|${mode}`
    if (focusedHighlightKey.current === requestKey) return
    const panel = mode === 'agenda' ? agendaPanelRef.current : dayPanelRef.current
    const row = panel?.querySelector('.agenda__row.is-highlighted')
    if (!row) return
    const frame = requestAnimationFrame(() => {
      row.focus()
      focusedHighlightKey.current = requestKey
    })
    return () => cancelAnimationFrame(frame)
  }, [agendaSel, highlightIdsKey, highlightedSessionIds, mode])

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
      { y: 6 },
      { y: 0, duration: 0.18, ease: 'power3.out', stagger: { amount: 0.05 }, clearProps: 'transform' }
    )
  }, [agendaSel, mode])

  if (isApp && workspaceState !== 'ready') {
    return (
      <section role="status" aria-label="Stan kalendarza">
        <EmptyState
          icon="calendar"
          title={workspaceState === 'loading' ? 'Wczytywanie kalendarza…' : 'Kalendarz jest teraz niedostępny'}
          hint={workspaceState === 'loading'
            ? 'Pobieramy kompletny widoczny zakres kalendarza.'
            : 'Nie pokazujemy niepełnych ani demonstracyjnych danych.'}
        />
      </section>
    )
  }

  // one session row — shared by the desktop day panel and the phone agenda
  const dayRow = (s, dragOk) => {
    const c = clientOf(s.clientId)
    const p = psychOf(s.psychId)
    const clientIdentity = clientIdentityFor(state.clients, s.clientId)
    const specialistIdentity = specialistIdentityFor(state.psychologists, s.psychId)
    const draggable = dragOk && s.status === 'scheduled'
    const clientName = clientIdentity.name
    const highlighted = highlightedSessionIds.has(s.id)
    // settled sessions stay in time order, dimmed — the day reads as one list
    const terminal = s.status === 'completed' || s.status === 'cancelled'
    return (
      <div
        className={`agenda__row ${highlighted ? 'is-highlighted' : ''}`}
        key={s.id}
        data-flip-id={s.id}
        data-payment={s.payment}
        data-attendance={s.status}
        data-psych-id={s.psychId}
        data-terminal={terminal ? 'true' : undefined}
        onPointerDown={draggable ? (e) => onChipDown(e, s) : undefined}
        style={{ '--node-color': p?.color, ...(draggable ? { touchAction: 'none' } : null) }}
        tabIndex={highlighted ? -1 : undefined}
        role={highlighted ? 'group' : undefined}
        aria-label={highlighted ? `Wyróżniona sesja — ${clientName}, ${s.time}` : undefined}
      >
        <span className="agenda__time">{s.time}</span>
        <span className="agenda__main">
          <span className="agenda__client">{clientName}</span>
          <span className="agenda__meta">
            <Avatar name={specialistIdentity.name} color={specialistIdentity.color} size={16} />
            {specialistIdentity.name} · {fmtMoney(s.amount)}
          </span>
          <span className="agenda__pills">
            {serviceBadge(s.service) && <Pill tone="sky">{serviceBadge(s.service)}</Pill>}
            {c?.readOnly && <Pill tone="ink">Archiwalny</Pill>}
            <StatusPicker
              session={s}
              accessibleLabel={`Status: ${STATUS_LABELS[s.status]} — ${clientName}, ${s.time}`}
              canChange={canManageAppointments}
              onStatusChange={(status) => changeAppointmentStatus(s, status)}
            />
            <PaymentPicker
              session={s}
              accessibleLabel={`Płatność: ${PAY_LABELS[s.payment]} — ${clientName}, ${s.time}`}
            />
          </span>
        </span>
        {canManageAppointments && !s.readOnly && (
          <IconBtn
            name="edit"
            label={`Edytuj sesję — ${clientName}, ${s.time}`}
            size={16}
            onClick={() => openSessionForm({ session: s, workspaceRange })}
          />
        )}
      </div>
    )
  }

  // a day's rows on the day thread, with the "teraz" marker when it is today.
  // `wide` lays each row out on one line where the column allows it.
  const dayThread = (sessions, dragOk, iso, flipRef, wide = false) => {
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const isToday = iso === today
    return (
      <div className={`agenda agenda--spine ${wide ? 'agenda--wide' : ''}`} ref={flipRef} style={{ marginTop: 6 }}>
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
          {!isPhone && canManageAppointments && (
            <Button icon="plus" magnetic onClick={() => openSessionForm({ date: selected || today, psychId: rolePsychId, workspaceRange })}>
              Nowa sesja
            </Button>
          )}
        </div>
      </div>

      <div className="row row--between cal-toolbar" data-reveal>
        <div className="row" style={{ gap: 14 }}>
          <div className="month-nav">
            <IconBtn name="chevL" label={nav.prevLabel} disabled={nav.prevOff} onClick={nav.prev} />
            <span className="month-nav__label month-nav__label--sentence">{cap(nav.label)}</span>
            <IconBtn name="chevR" label={nav.nextLabel} disabled={nav.nextOff} onClick={nav.next} />
          </div>
          {!nav.atToday && (
            <Button variant="ghost" size="sm" onClick={() => selectDay(today)}>
              Dziś
            </Button>
          )}
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="faint" aria-live="polite" style={{ fontSize: 13.5 }}>
            {nav.count}
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
            days={weekDays}
            selected={agendaSel}
            today={today}
            byDate={weekByDate}
            psychOf={psychOf}
            onSelect={selectDay}
          />
          <section className="card card--pad agenda-day" ref={agendaPanelRef} data-reveal aria-label="Plan dnia">
            <h2 className="card-title">
              <span className="row" style={{ gap: 9 }}>
                {cap(fmtWeekday(agendaSel))}, {fmtDayMonth(agendaSel)}
                {agendaSel === today && <span className="pill pill--amber">dziś</span>}
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
                hint={isApp ? 'W tym kompletnym zakresie nie ma zaplanowanych sesji.' : 'Dodaj pierwszą sesję przyciskiem poniżej.'}
              />
            ) : (
              dayThread(agendaSessions, false, agendaSel, agendaFlipRef, true)
            )}
            {canManageAppointments && <Button variant="soft" size="sm" icon="plus" className="btn--full" style={{ marginTop: 14 }}
              onClick={() => openSessionForm({ date: agendaSel, psychId: rolePsychId, workspaceRange })}>
              Dodaj sesję tego dnia
            </Button>}
          </section>
        </>
      ) : (
        <div className="grid-31 cal-month" data-reveal>
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
                    onKeyDown={(event) => onGridDayKeyDown(event, cell.iso)}
                    aria-label={`${fmtDayMonth(cell.iso)} — ${items.length} ${sessionsWord(items.length)}`}
                    aria-pressed={cell.iso === selected}
                    aria-current={cell.iso === today ? 'date' : undefined}
                    tabIndex={cell.iso === selected ? 0 : -1}
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
                            className={`cal__item ${s.status === 'scheduled' && canDrag ? 'is-draggable' : ''}`}
                            data-flip-id={s.id}
                            style={{ background: psychOf(s.psychId)?.soft, '--node-color': psychOf(s.psychId)?.color }}
                            onPointerDown={(e) => { if (canDrag) onChipDown(e, s) }}
                            title={s.status === 'scheduled' && canDrag ? 'Przeciągnij, aby przełożyć sesję' : undefined}
                          >
                            <span className="cal__item-time">{s.time}</span>
                            <span className="cal__item-name">{clientIdentityFor(state.clients, s.clientId).name.split(' ')[0]}</span>
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

          {/* the side cell holds no flow content, so the month grid alone sets
              the row height and the panel stretches to meet it */}
          <div className="cal-month__side">
            <div className="card card--pad cal-day-panel" ref={dayPanelRef}>
              <h2 className="card-title">
                <span className="row" style={{ gap: 9 }}>
                  {selected ? cap(fmtWeekday(selected)) + ', ' + fmtDayMonth(selected) : 'Wybierz dzień'}
                  {selected === today && <span className="pill pill--amber">dziś</span>}
                </span>
                {selected && (
                  <span className="faint" style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 550 }}>
                    {daySessions.length} {sessionsWord(daySessions.length)}
                  </span>
                )}
              </h2>
              <div className="cal-day-panel__list">
                {selected && daySessions.length === 0 && (
                  <EmptyState
                    compact
                    icon="calendar"
                    title="Brak sesji tego dnia"
                    hint={isApp ? 'W tym kompletnym zakresie nie ma zaplanowanych sesji.' : 'Dodaj pierwszą sesję przyciskiem poniżej.'}
                  />
                )}
                {daySessions.length > 0 &&
                  dayThread(daySessions.slice().sort((a, b) => (a.time < b.time ? -1 : 1)), canDrag, selected)}
              </div>
              {selected && canManageAppointments && (
                <Button variant="soft" size="sm" icon="plus" className="btn--full" style={{ marginTop: 14 }}
                  onClick={() => openSessionForm({ date: selected, psychId: rolePsychId, workspaceRange })}>
                  Dodaj sesję tego dnia
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
