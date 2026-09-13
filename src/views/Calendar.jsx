import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useAppointmentMutationLock, useWorkspaceRefresh, useWorkspaceRetry, useWorkspaceWindow, sessionsInMonth, availableMonths } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useFlip, motionOK } from '../anim.js'
import { useIsPhone, useMediaQuery, desktopMQ } from '../responsive.js'
import { Button, IconBtn, Segmented, Avatar, Chip, Pill, EmptyState, Popover } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { StatusPicker, PaymentPicker } from './session-bits.jsx'
import { ProtectedPaymentAction, useProtectedPaymentContext } from './PaymentActions.jsx'
import { FilterBar, FilterGroup, useRouteParamsSync, ViewState } from '../ux-patterns.jsx'
import {
  compareCalendarSessionOrder,
  sessionMatchesFilters,
  sessionsForRole,
} from '../workspace.js'
import { serviceBadge } from '../services.js'
import {
  monthKey, addMonths, fmtMonthNameWithYearOutsideCurrent, fmtMonthYear, toISODate, parseISO, pad2, cap,
  fmtWeekday, fmtDayMonth, fmtWeekRange, fmtMoney, sessionsWord, calendarCountLabel, timeToMin,
  STATUS_LABELS, PAY_LABELS, fmtMonthLocative, warsawDateTimeFromUtc, isBillable,
} from '../format.js'
import {
  clientIdentityFor,
  isWorkspaceRangeCovered,
  monthWorkspaceRange,
  specialistIdentityFor,
  weekWorkspaceRange,
} from '../workspace-view.js'
import { isWorkspaceRangePending } from '../workspace-load-request.js'
import { ApiError } from '../api.js'
import {
  appointmentCancellationTarget,
  appointmentCancellationToastKey,
  appointmentRestorationError,
} from '../appointment-cancellation.js'
import { canPerformAction } from '../capability-access.js'
import {
  historicalCalendarModel,
  latestPopulatedMonthAction,
  resolveCalendarHistoricalViewState,
} from '../historical-workspace-view.js'
import {
  HistoricalMonthSection,
  HistoricalOccurrenceRow,
  HistoricalUnknownReview,
  HistoricalUnknownSummary,
} from './historical-bits.jsx'

const DOW = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd']
const STRIP_DOW = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd']
const PAYMENT_FILTERS = [
  { value: 'all', label: 'Wszystkie' },
  { value: 'partial', label: 'Częściowo opłacona' },
  { value: 'unpaid', label: 'Do zapłaty' },
  { value: 'paid', label: 'Opłacona' },
]
const ATTENDANCE_FILTERS = [
  { value: 'all', label: 'Wszystkie' },
  { value: 'noshow', label: 'Nieobecność' },
  { value: 'completed', label: 'Odbyta' },
  { value: 'cancelled', label: 'Odwołana' },
  { value: 'scheduled', label: 'Zaplanowana' },
]

const defaultCalendarFilters = () => ({ payment: 'all', attendance: 'all', specialist: null })

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WEEKENDS_STORAGE_KEY = 'bwm.calendar.weekends'

function savedWeekendsPreference() {
  try {
    const value = window.localStorage.getItem(WEEKENDS_STORAGE_KEY)
    return value === null ? true : value === 'true'
  } catch {
    return true
  }
}

function saveWeekendsPreference(value) {
  try {
    window.localStorage.setItem(WEEKENDS_STORAGE_KEY, String(value))
  } catch {
    // The calendar remains usable when browser storage is unavailable.
  }
}

function AbsenceMarker({ absence, specialist, block = false, onCancel }) {
  const range = absence.dateFrom === absence.dateTo
    ? fmtDayMonth(absence.dateFrom)
    : `${fmtDayMonth(absence.dateFrom)} - ${fmtDayMonth(absence.dateTo)}`
  return (
    <span
      className={`cal__absence ${block ? 'cal__absence--block' : ''}`}
      style={{ '--node-color': specialist?.color }}
      title={`Wolne: ${specialist?.name || specialist?.displayName || 'specjalistka'}, ${range}`}
    >
      <span className="cal__absence-label">wolne</span>
      <span className="cal__absence-name">{specialist?.name || specialist?.displayName || 'Specjalistka'}</span>
      {onCancel && (
        <button
          type="button"
          className="cal__absence-cancel"
          aria-label={`Anuluj wolne - ${specialist?.name || specialist?.displayName || 'specjalistka'}, ${range}`}
          onClick={(event) => { event.stopPropagation(); onCancel() }}
        >
          Anuluj
        </button>
      )}
    </span>
  )
}

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

function initialCalendarViewState(getViewState, params, today, psychologists) {
  const defaults = {
    ym: monthKey(today),
    selected: today,
    mode: 'agenda',
    filters: defaultCalendarFilters(),
    review: null,
  }
  const persisted = getViewState('calendar', defaults)
  const historicalState = resolveCalendarHistoricalViewState({ params, persisted, today })
  const paramDate = isISODate(params?.date) ? params.date : null
  const selected = historicalState.selected
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
  const specialist = typeof params?.specialist === 'string'
    && psychologists.some((psychologist) => psychologist.id === params.specialist)
    ? params.specialist
    : psychologists.some((psychologist) => psychologist.id === persisted.filters?.specialist)
      ? persisted.filters.specialist
      : null

  return {
    ym: historicalState.ym,
    selected,
    mode: params?.mode === 'cal'
      ? 'cal'
      : paramDate
        ? 'agenda'
        : persisted.mode === 'cal' ? 'cal' : 'agenda',
    filters: { payment, attendance, specialist },
    review: historicalState.review,
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

function firstSessionDayInMonth(ym, sessions) {
  return sessions
    .filter((session) => session.date?.startsWith(`${ym}-`))
    .map((session) => session.date)
    .sort()[0] || `${ym}-01`
}

function WeekNav({ selected, today, sessions, firstMonth, lastMonth, isApp, onSelect }) {
  const [open, setOpen] = useState(false)
  const [pickerMonth, setPickerMonth] = useState(() => monthKey(selected))
  const currentYear = Number(today.slice(0, 4))
  const prevOff = !isApp && pickerMonth <= firstMonth
  const nextOff = !isApp && pickerMonth >= lastMonth

  useEffect(() => {
    if (!open) setPickerMonth(monthKey(selected))
  }, [open, selected])

  const changeMonth = (delta) => {
    const next = addMonths(pickerMonth, delta)
    if ((!isApp && delta < 0 && next < firstMonth) || (!isApp && delta > 0 && next > lastMonth)) return
    setPickerMonth(next)
    onSelect(firstSessionDayInMonth(next, sessions), false)
  }

  const closeAndSelect = (event, iso) => {
    const trigger = event.currentTarget.closest('.pop-wrap')?.querySelector('.week-nav__trigger')
    setOpen(false)
    onSelect(iso)
    requestAnimationFrame(() => trigger?.focus())
  }

  const week = weekDaysFor(selected)
  return (
    <Popover
      open={open}
      setOpen={setOpen}
      contentRole="dialog"
      ariaLabel="Wybierz tydzień"
      trigger={(
        <Button
          variant="ghost"
          size="sm"
          className="week-nav__trigger"
          aria-haspopup="dialog"
          aria-label={`Wybierz tydzień: ${fmtWeekRange(week[0], week[6])}`}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="month-nav__label month-nav__label--sentence">{fmtWeekRange(week[0], week[6])}</span>
        </Button>
      )}
    >
      <div style={{ width: 282, padding: 4 }}>
        <div className="row row--between" style={{ marginBottom: 6 }}>
          <IconBtn name="chevL" label="Poprzedni miesiąc" disabled={prevOff} onClick={() => changeMonth(-1)} />
          <strong style={{ textTransform: 'capitalize' }}>
            {fmtMonthNameWithYearOutsideCurrent(pickerMonth, currentYear)}
          </strong>
          <IconBtn name="chevR" label="Następny miesiąc" disabled={nextOff} onClick={() => changeMonth(1)} />
        </div>
        <div className="cal" aria-label={`Kalendarz ${fmtMonthNameWithYearOutsideCurrent(pickerMonth, currentYear)}`} style={{ gap: 3 }}>
          {DOW.map((day) => <span className="cal__dow" style={{ padding: '2px 0' }} key={day}>{day}</span>)}
          {monthGrid(pickerMonth).map((cell) => (
            <button
              type="button"
              key={cell.iso}
              className={`cal__day ${cell.inMonth ? '' : 'is-out'} ${cell.iso === selected ? 'is-sel' : ''} ${cell.iso === today ? 'is-today' : ''}`}
              style={{ minHeight: 34, padding: 3, alignItems: 'center' }}
              disabled={!isApp && firstMonth && lastMonth && (
                monthKey(cell.iso) < firstMonth || monthKey(cell.iso) > lastMonth
              )}
              aria-label={fmtDayMonth(cell.iso)}
              aria-pressed={cell.iso === selected}
              onClick={(event) => closeAndSelect(event, cell.iso)}
            >
              <span className="cal__num">{Number(cell.iso.slice(8))}</span>
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={(event) => closeAndSelect(event, today)}>Dziś</Button>
      </div>
    </Popover>
  )
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
function DayStrip({
  days, selected, today, byDate, historicalByDate, absencesForDate, psychOf, onSelect,
}) {
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
        const historicalItems = historicalByDate[iso] || []
        const absenceItems = absencesForDate(iso)
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
            aria-label={`${fmtDayMonth(iso)} — ${calendarCountLabel(
              items.length, historicalItems.length, absenceItems.length,
            )}`}
            tabIndex={iso === selected ? 0 : -1}
          >
            <span className="day-strip__dow">{STRIP_DOW[dowIdx]}</span>
            <span className="day-strip__num">{Number(iso.slice(8))}</span>
            <span className="day-strip__dots">
              {items.slice(0, 3).map((session) => (
                <span key={session.id} className="dot" style={{ background: psychOf(session.psychId)?.color }} />
              ))}
              {historicalItems.slice(0, Math.max(0, 3 - items.length)).map((row) => (
                <span key={row.id} className="dot dot--historical" style={{ background: psychOf(row.specialistId)?.color }} />
              ))}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function CalendarView({ params = {} }) {
  const { state, dispatch, toast, workspace, workspaceFailures, workspacePendingRanges } = useApp()
  const { locked: appointmentMutationLocked } = useAppointmentMutationLock()
  const refreshWorkspace = useWorkspaceRefresh()
  const {
    appMode, capabilities, getViewState, navigate, openSessionForm,
    openSpecialistAbsenceForm, patchViewState, role,
  } = useShell()
  const isApp = appMode === 'app'
  const today = toISODate(new Date())
  const curYm = monthKey(new Date())
  const [initialViewState] = useState(() => {
    const initial = initialCalendarViewState(getViewState, params, today, state.psychologists)
    return role.scope === 'own'
      ? { ...initial, filters: { ...initial.filters, specialist: null } }
      : initial
  })
  const [ym, setYm] = useState(initialViewState.ym)
  const [mode, setMode] = useState(initialViewState.mode)
  const [selected, setSelected] = useState(initialViewState.selected)
  const [filters, setFilters] = useState(initialViewState.filters)
  const [review, setReview] = useState(initialViewState.review)
  const isPhone = useIsPhone()
  // dragging an agenda row or a month-grid chip would trap touch scrolling,
  // so it stays a fine-pointer affordance (reschedule via the session form)
  const dragPointer = useMediaQuery(`${desktopMQ} and (pointer: fine)`)
  const gridRef = useRef(null)
  const dayPanelRef = useRef(null)
  const agendaPanelRef = useRef(null)
  const ref = useReveal()
  const suppressClick = useRef(false)
  const dragCleanupRef = useRef(() => {})
  const calendarMounted = useRef(false)

  useEffect(() => {
    calendarMounted.current = true
    return () => {
      calendarMounted.current = false
      dragCleanupRef.current()
    }
  }, [])

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
  const filterPsychologists = useMemo(
    () => rolePsychologists.toSorted((left, right) => left.name.localeCompare(right.name, 'pl')),
    [rolePsychologists],
  )
  const monthsRange = useMemo(() => availableMonths(roleSessions), [roleSessions])
  const [appWeekends, setAppWeekends] = useState(() => (isApp ? savedWeekendsPreference() : true))
  const showWeekends = isApp ? appWeekends : state.prefs.weekendsInCalendar
  const toggleWeekends = () => {
    const next = !showWeekends
    if (isApp) {
      setAppWeekends(next)
      saveWeekendsPreference(next)
      return
    }
    dispatch({ type: 'SET_PREF', key: 'weekendsInCalendar', value: next })
  }
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
  const showHistorical = filters.payment === 'all' && filters.attendance === 'all' && !filters.specialist
  const historicalModel = useMemo(() => historicalCalendarModel({
    occurrences: isApp ? state.historicalOccurrences : [],
    historicalClients: isApp ? state.historicalClients : [],
    specialists: isApp
      ? [...state.psychologists, ...(state.historicalSpecialists ?? [])]
      : [],
    ym,
    showHistorical,
  }), [
    isApp,
    showHistorical,
    state.historicalClients,
    state.historicalOccurrences,
    state.historicalSpecialists,
    state.psychologists,
    ym,
  ])
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
    patchViewState('calendar', { ym, selected, mode, filters, review })
  }, [filters, mode, patchViewState, review, selected, ym])

  // the whole visible scope lives in the URL — deep-link params pass through
  useRouteParamsSync('calendar', {
    date: selected,
    ym: mode === 'cal' ? ym : undefined,
    mode: mode === 'cal' ? 'cal' : undefined,
    payment: filters.payment !== 'all' ? filters.payment : undefined,
    attendance: filters.attendance !== 'all' ? filters.attendance : undefined,
    specialist: role.scope !== 'own' ? filters.specialist || undefined : undefined,
    review: review === 'unknown' ? 'unknown' : undefined,
    highlightSessionIds: params.highlightSessionIds?.length ? params.highlightSessionIds : undefined,
  })

  const clientsById = useMemo(
    () => new Map(state.clients.map((client) => [client.id, client])),
    [state.clients],
  )
  const specialistsById = useMemo(
    () => new Map([
      ...state.psychologists,
      ...(state.historicalSpecialists ?? []),
    ].map((specialist) => [specialist.id, specialist])),
    [state.historicalSpecialists, state.psychologists],
  )
  const clientOf = (id) => clientsById.get(id)
  const psychOf = (id) => specialistsById.get(id)
  const [absenceView, setAbsenceView] = useState(() => ({
    from: null, to: null, absences: [],
  }))
  const visibleAbsences = absenceView.absences
  const absencePsychOf = (specialistId) => (
    psychOf(specialistId)
      || psychOf(specialistId?.replace(/^sp_demo_/, ''))
  )
  const absencesForDate = (iso) => visibleAbsences.filter((absence) => (
    absence.dateFrom <= iso && absence.dateTo >= iso
  ))

  // --- drag & drop: reschedule by dragging a session chip onto another day ---
  const onChipDown = (e, s) => {
    if (s.status !== 'scheduled' || s.readOnly || clientOf(s.clientId)?.readOnly) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const chip = e.currentTarget
    const pid = e.pointerId
    const d = {
      startX: e.clientX, startY: e.clientY, active: false, cancelled: false,
      ghost: null, dropIso: null, dropEl: null, moveX: null, moveY: null,
    }
    dragCleanupRef.current()

    const detach = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }
    const clearVisuals = ({ deferClick = false } = {}) => {
      d.dropEl?.classList.remove('is-dropover')
      document.body.classList.remove('is-grabbing')
      chip.classList.remove('is-dragging')
      d.ghost?.remove()
      if (deferClick) setTimeout(() => { suppressClick.current = false }, 0)
      else suppressClick.current = false
    }
    const abort = () => {
      d.cancelled = true
      detach()
      clearVisuals()
    }

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
      detach()
      if (!d.active) {
        if (dragCleanupRef.current === abort) dragCleanupRef.current = () => {}
        return
      }
      clearVisuals({ deferClick: true })
      if (d.dropIso) {
        let updatedAppointment
        let previousEdit
        if (isApp) {
          let commandAccepted = false
          previousEdit = appointmentEditInput(s)
          try {
            updatedAppointment = await workspace.editAppointment(
              s.id, s.version, appointmentEditInput(s, { date: d.dropIso }),
            )
            commandAccepted = true
            await refreshWorkspace(workspaceRange)
            if (d.cancelled || !calendarMounted.current) return
          } catch (error) {
            if (d.cancelled || !calendarMounted.current) return
            if (!commandAccepted && error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
              try {
                await refreshWorkspace(workspaceRange)
                if (d.cancelled || !calendarMounted.current) return
                toast('Sesja została zmieniona. Odświeżono Grafik.', 'alert')
              } catch {
                if (d.cancelled || !calendarMounted.current) return
                toast('Sesja została zmieniona, ale nie udało się odświeżyć Grafiku.', 'alert')
              }
            } else if (commandAccepted) {
              toast('Sesję przeniesiono, ale nie udało się odświeżyć Grafiku.', 'alert')
            } else {
              toast('Nie udało się przenieść sesji.', 'alert')
            }
            return
          }
        } else {
          dispatch({ type: 'UPDATE_SESSION', id: s.id, patch: { date: d.dropIso } })
        }
        if (d.cancelled || !calendarMounted.current) return
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
        if (isApp) {
          const movedAt = warsawDateTimeFromUtc(updatedAppointment.startsAt)
          const client = clientOf(updatedAppointment.clientId)
          const toastKey = `appointment-undo-${updatedAppointment.id}`
          toast(`Sesja została przełożona · ${client?.name || 'Klient'}, ${fmtDayMonth(movedAt.date)}, ${movedAt.time} · ${fmtMoney(updatedAppointment.charge.expectedAmountGrosze / 100)}${clash ? ` · Uwaga: nakłada się z sesją o ${clash.time}` : ''}`, clash ? 'alert' : 'check', {
              key: toastKey,
              label: 'Cofnij',
              onClick: async () => {
                let undoAccepted = false
                try {
                  const restoredAppointment = await workspace.editAppointment(
                    updatedAppointment.id, updatedAppointment.version, previousEdit,
                  )
                  undoAccepted = true
                  await refreshWorkspace(workspaceRange)
                  const restoredAt = warsawDateTimeFromUtc(restoredAppointment.startsAt)
                  setMode('agenda')
                  selectDay(restoredAt.date)
                  navigate('calendar', {
                    date: restoredAt.date,
                    highlightSessionIds: [restoredAppointment.id],
                  })
                  toast('Zmianę sesji cofnięto.', 'check', { key: toastKey })
                } catch (error) {
                  if (!undoAccepted && error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
                    try {
                      await refreshWorkspace(workspaceRange)
                      toast('Nie można cofnąć zmiany sesji. Grafik został odświeżony.', 'alert', { key: toastKey })
                    } catch {
                      toast('Nie można cofnąć zmiany sesji. Nie udało się odświeżyć Grafiku.', 'alert', { key: toastKey })
                    }
                  } else if (undoAccepted) {
                    toast('Zmianę sesji cofnięto, ale nie udało się odświeżyć Grafiku.', 'alert', { key: toastKey })
                  } else {
                    toast('Nie udało się cofnąć zmiany sesji.', 'alert', { key: toastKey })
                  }
                }
              },
            })
          setMode('agenda')
          selectDay(movedAt.date)
          navigate('calendar', { date: movedAt.date, highlightSessionIds: [updatedAppointment.id] })
        } else if (clash) {
          toast(`Sesja przeniesiona na ${fmtDayMonth(d.dropIso)} — uwaga, nakłada się z sesją o ${clash.time}`, 'alert')
        } else {
          toast(`Sesja przeniesiona na ${fmtDayMonth(d.dropIso)}`)
        }
        if (!isApp) selectDay(d.dropIso)
      }
      if (dragCleanupRef.current === abort) dragCleanupRef.current = () => {}
    }
    const cancel = (ev) => {
      if (ev && ev.pointerId !== pid) return
      d.dropIso = null
      finish()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    dragCleanupRef.current = abort
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

  const filterKey = `${ym}|${filters.payment}|${filters.attendance}|${filters.specialist || ''}`
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
    (filters.payment !== 'all' ? 1 : 0)
    + (filters.attendance !== 'all' ? 1 : 0)
  const activeFilterSummary = [
    filters.payment !== 'all' && PAYMENT_FILTERS.find((filter) => filter.value === filters.payment)?.label,
    filters.attendance !== 'all' && ATTENDANCE_FILTERS.find((filter) => filter.value === filters.attendance)?.label,
  ].filter(Boolean).join(' · ')
  const rolePsychId = role.scope === 'own' ? role.psychId : filters.specialist || undefined

  // Selecting a day brings its session list into view only when it is off
  // screen — a panel the user can already see must not move under them.
  const selectDay = (iso, scroll = true) => {
    const shouldScroll = scroll && iso !== selected
    setYm(monthKey(iso))
    setSelected(iso)
    if (!shouldScroll) return
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
  const dayHistoricalRows = selected ? (historicalModel.exactByDay[selected] || []) : []

  const agendaSel = selected || (ym === curYm ? today : `${ym}-01`)
  const agendaSessions = useMemo(
    () => (byDate[agendaSel] || []).slice().sort(compareCalendarSessionOrder),
    [byDate, agendaSel]
  )
  const agendaAbsences = absencesForDate(agendaSel)
  const selectedAbsences = selected ? absencesForDate(selected) : []
  const weekDays = useMemo(() => weekDaysFor(agendaSel), [agendaSel])
  const workspaceRange = useMemo(
    () => mode === 'agenda' ? weekWorkspaceRange(agendaSel) : monthWorkspaceRange(ym),
    [agendaSel, mode, ym]
  )
  const workspaceState = useWorkspaceWindow(workspaceRange, isApp)
  const paymentContext = useProtectedPaymentContext(
    ym, isApp, workspaceState, workspaceRange,
  )
  const retryWorkspace = useWorkspaceRetry()
  const workspaceCovered = !isApp || isWorkspaceRangeCovered(workspace.loadedRanges, workspaceRange)
  const workspaceFailed = isApp && workspaceFailures.has(`${workspaceRange.from}|${workspaceRange.to}`)
  const workspaceRefreshing = isApp && workspaceCovered
    && isWorkspaceRangePending(workspacePendingRanges, workspaceRange)
  const workspaceRefreshFailed = isApp && workspaceCovered && workspaceFailed
  const absenceLoadKeyRef = useRef(null)
  const [absenceLoadError, setAbsenceLoadError] = useState(false)
  const absenceProviderState = workspace.absences?.state
  const absenceLoadWindow = workspace.absences?.loadWindow
  useEffect(() => {
    if (!absenceProviderState || !absenceLoadWindow || !workspaceRange) return
    const key = `${role.id}|${workspaceRange.from}|${workspaceRange.to}`
    const loaded = absenceProviderState
    const loadedKey = `${loaded.from || ''}|${loaded.to || ''}`
    const covered = loaded.from === workspaceRange.from && loaded.to === workspaceRange.to
    if (covered) {
      absenceLoadKeyRef.current = { key, loadedKey }
      setAbsenceView((current) => (
        current.from === loaded.from && current.to === loaded.to
          && current.absences === loaded.absences
          ? current
          : loaded
      ))
      setAbsenceLoadError(false)
      return
    }
    if (absenceLoadKeyRef.current?.key === key
      && absenceLoadKeyRef.current?.loadedKey === loadedKey) return
    absenceLoadKeyRef.current = { key, loadedKey }
    setAbsenceLoadError(false)
    absenceLoadWindow(workspaceRange).catch(() => setAbsenceLoadError(true))
  }, [absenceLoadWindow, absenceProviderState, isApp, role.id, workspaceRange.from, workspaceRange.to])
  const canonicalMonthAppointmentCount = useMemo(
    () => sessionsInMonth(roleSessions, ym).length,
    [roleSessions, ym],
  )
  const latestMonthAction = isApp && mode === 'cal' && workspaceState === 'ready'
    ? latestPopulatedMonthAction({
        selectedMonth: ym,
        appointmentCount: canonicalMonthAppointmentCount,
        historicalCount: historicalModel.historicalCount,
        latestPopulatedMonth: state.latestPopulatedMonth,
      })
    : null
  const canManageAppointmentActions = !isApp || (
    canPerformAction(capabilities, 'appointment.edit')
    && !appointmentMutationLocked
  )
  const canManageAppointments = canManageAppointmentActions && workspaceCovered
  const canRecordPayments = isApp
    && workspaceState === 'ready'
    && workspace.status === 'ready'
    && canPerformAction(capabilities, 'payment.record')
  const canDrag = dragPointer && canManageAppointments
  const canDragSession = (session) => canDrag && !session.readOnly && !clientOf(session.clientId)?.readOnly
  const cancelAbsence = async (absence) => {
    try {
      const cancelled = await workspace.absences.cancel(absence.id, absence.version)
      setAbsenceView((current) => ({
        ...current,
        absences: current.absences.filter(({ id }) => id !== cancelled.id),
      }))
      toast('Wolne anulowane')
    } catch {
      toast('Nie udało się anulować wolnego.', 'alert')
    }
  }
  const absenceUnavailable = absenceLoadError || workspace.absences?.status === 'read-only-error'
  const retryAbsences = () => {
    const key = `${role.id}|${workspaceRange.from}|${workspaceRange.to}`
    const loaded = workspace.absences.state
    absenceLoadKeyRef.current = {
      key, loadedKey: `${loaded.from || ''}|${loaded.to || ''}`,
    }
    setAbsenceLoadError(false)
    workspace.recoverFromInfrastructureError?.()
    workspace.absences?.loadWindow(workspaceRange).catch(() => setAbsenceLoadError(true))
  }

  const changeAppointmentStatus = async (session, status) => {
    let commandAccepted = false
    let updatedAppointment
    const previousEdit = appointmentEditInput(session)
    try {
      updatedAppointment = await workspace.editAppointment(
        session.id, session.version, appointmentEditInput(session, { status }),
      )
      commandAccepted = true
      await refreshWorkspace(workspaceRange)
    } catch (error) {
      if (!commandAccepted && error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        try {
          await refreshWorkspace(workspaceRange)
          toast('Sesja została zmieniona. Odświeżono Grafik.', 'alert')
        } catch {
          toast('Sesja została zmieniona, ale nie udało się odświeżyć Grafiku.', 'alert')
        }
      } else if (commandAccepted) {
        toast('Status sesji zapisano, ale nie udało się odświeżyć Grafiku.', 'alert')
      } else {
        toast('Nie udało się zmienić statusu sesji.', 'alert')
      }
      return
    }
    const toastKey = `appointment-undo-${updatedAppointment.id}`
    toast(`Status zmieniony: ${STATUS_LABELS[status].toLowerCase()}`, 'check', {
      key: toastKey,
      label: 'Cofnij',
      onClick: async () => {
        let undoAccepted = false
        try {
          await workspace.editAppointment(updatedAppointment.id, updatedAppointment.version, previousEdit)
          undoAccepted = true
          await refreshWorkspace(workspaceRange)
          toast('Zmianę sesji cofnięto.', 'check', { key: toastKey })
        } catch (error) {
          if (!undoAccepted && error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
            try {
              await refreshWorkspace(workspaceRange)
              toast('Nie można cofnąć zmiany sesji. Grafik został odświeżony.', 'alert', { key: toastKey })
            } catch {
              toast('Nie można cofnąć zmiany sesji. Nie udało się odświeżyć Grafiku.', 'alert', { key: toastKey })
            }
          } else if (undoAccepted) {
            toast('Zmianę sesji cofnięto, ale nie udało się odświeżyć Grafiku.', 'alert', { key: toastKey })
          } else {
            toast('Nie udało się cofnąć zmiany sesji.', 'alert', { key: toastKey })
          }
        }
      },
    })
  }

  const cancelAppointmentWithUndo = async (session, reason) => {
    let cancelled
    const target = appointmentCancellationTarget(session, appMode)
    try {
      cancelled = await workspace.cancelAppointment(target.id, target.version, reason)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        try { await refreshWorkspace(workspaceRange) } catch { /* dialog keeps the concrete error */ }
      }
      throw error
    }
    let refreshed = true
    try { await refreshWorkspace(workspaceRange) } catch { refreshed = false }
    const clientName = clientIdentityFor(state.clients, session.clientId).name
    const toastKey = appointmentCancellationToastKey(cancelled.id)
    toast(
      refreshed
        ? `Sesja odwołana · ${clientName}, ${fmtDayMonth(session.date)}, ${session.time}`
        : `Sesję odwołano, ale nie udało się odświeżyć Grafiku · ${clientName}, ${fmtDayMonth(session.date)}, ${session.time}`,
      refreshed ? 'check' : 'alert',
      {
        key: toastKey,
        label: 'Cofnij',
        onClick: async () => {
          let restored
          try {
            restored = await workspace.restoreAppointment(cancelled.id, cancelled.version)
            await refreshWorkspace(workspaceRange)
            toast(`Sesję przywrócono · ${clientName}, ${fmtDayMonth(session.date)}, ${session.time}`, 'check', { key: toastKey })
          } catch (error) {
            if (!restored && error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
              try { await refreshWorkspace(workspaceRange) } catch { /* keep the command error */ }
            }
            toast(
              restored
                ? 'Sesję przywrócono, ale nie udało się odświeżyć Grafiku.'
                : appointmentRestorationError(error),
              'alert',
              { key: toastKey },
            )
          }
        },
      },
    )
    return cancelled
  }

  // One navigator per view: Plan dnia moves by week and Miesiąc by month.
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

  // one session row — shared by the desktop day panel and the phone agenda
  const dayRow = (s, dragOk) => {
    const c = clientOf(s.clientId)
    const p = psychOf(s.psychId)
    const clientIdentity = clientIdentityFor(state.clients, s.clientId)
    const specialistIdentity = specialistIdentityFor(state.psychologists, s.psychId)
    const draggable = dragOk && s.status === 'scheduled' && !s.readOnly && !c?.readOnly
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
            <Avatar name={specialistIdentity.name} color={specialistIdentity.color} avatarKey={specialistIdentity.avatarKey} size={16} />
            {specialistIdentity.name} · {fmtMoney(s.amount)}
          </span>
          <span className="agenda__pills">
            {serviceBadge(s.service) && <Pill tone="sky">{serviceBadge(s.service)}</Pill>}
            {c?.readOnly && <Pill tone="ink">Archiwalny</Pill>}
            <StatusPicker
              session={s}
              accessibleLabel={`Status: ${STATUS_LABELS[s.status]} — ${clientName}, ${s.time}`}
              canChange={canManageAppointments}
              clientName={clientName}
              specialistName={specialistIdentity.name}
              onStatusChange={(status) => changeAppointmentStatus(s, status)}
              onCancel={(reason) => cancelAppointmentWithUndo(s, reason)}
            />
            <PaymentPicker
              session={s}
              accessibleLabel={`Płatność: ${PAY_LABELS[s.payment]} — ${clientName}, ${s.time}`}
              action={canRecordPayments && !s.readOnly && !c?.readOnly
                && isBillable(s) && s.paidAmount < s.amount ? <ProtectedPaymentAction
                  appointmentId={s.id}
                  outstandingGrosze={Math.round((s.amount - s.paidAmount) * 100)}
                  paymentContext={paymentContext}
                  compact
                  hideEmpty
                /> : null}
            />
          </span>
        </span>
        {canManageAppointments && !s.readOnly && (
          <span className="agenda__actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openSessionForm({ session: s, workspaceRange, reschedule: true, focus: 'date' })}
            >
              Przełóż
            </Button>
            <IconBtn
              name="edit"
              label={`Edytuj sesję — ${clientName}, ${s.time}`}
              size={16}
              onClick={() => openSessionForm({ session: s, workspaceRange })}
            />
          </span>
        )}
      </div>
    )
  }

  // a day's rows on the day thread, with the "teraz" marker when it is today.
  // `wide` lays each row out on one line where the column allows it.
  const dayThread = (sessions, historicalRows, dragOk, iso, flipRef, wide = false) => {
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
        {historicalRows.map((row) => (
          <HistoricalOccurrenceRow key={row.id} row={row} date={iso} />
        ))}
      </div>
    )
  }

  const historicalRouteParams = {
    date: selected,
    ym: mode === 'cal' ? ym : undefined,
    mode: mode === 'cal' ? 'cal' : undefined,
    payment: filters.payment !== 'all' ? filters.payment : undefined,
    attendance: filters.attendance !== 'all' ? filters.attendance : undefined,
    specialist: role.scope !== 'own' ? filters.specialist || undefined : undefined,
    highlightSessionIds: params.highlightSessionIds?.length ? params.highlightSessionIds : undefined,
  }

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <h1 className="display view-head__title">Grafik <em>sesji</em></h1>
        </div>
        <div className="view-head__actions">
          <Button
            variant={showWeekends ? 'soft' : 'ghost'}
            size="sm"
            aria-pressed={showWeekends}
            onClick={toggleWeekends}
          >
            Weekendy
          </Button>
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
          {canManageAppointmentActions && (
            <>
              <Button variant="soft" icon="calendar" disabled={!workspaceCovered} onClick={() => openSpecialistAbsenceForm({ date: selected || today })}>
                Zaznacz wolne
              </Button>
              <Button icon="plus" magnetic disabled={!workspaceCovered} onClick={() => openSessionForm({ date: selected || today, psychId: rolePsychId, workspaceRange })}>
                Nowa sesja
              </Button>
            </>
          )}
        </div>
      </div>

      {!workspaceCovered ? <ViewState
        ariaLabel="Stan Grafiku"
        tone={workspaceState === 'unavailable' ? 'error' : 'loading'}
        icon="calendar"
        title={workspaceState === 'unavailable' ? 'Grafik jest teraz niedostępny' : 'Wczytuję Grafik…'}
        hint={workspaceState === 'unavailable'
          ? 'Nie pokazujemy niepełnego ani demonstracyjnego Grafiku.'
          : 'Pobieramy kompletny widoczny zakres Grafiku.'}
        action={workspaceState === 'unavailable'
          ? <Button onClick={() => retryWorkspace(workspaceRange)}>Spróbuj ponownie</Button>
          : undefined}
      /> : <>
      {workspaceRefreshing && <ViewState
        compact
        tone="loading"
        icon="calendar"
        title="Odświeżamy Grafik…"
        hint="Wyświetlamy ostatnio potwierdzony widoczny zakres."
      />}
      {workspaceRefreshFailed && <ViewState
        compact
        tone="error"
        icon="calendar"
        title="Nie udało się odświeżyć Grafiku"
        hint="Wyświetlamy ostatnio potwierdzony widoczny zakres."
        action={<Button size="sm" onClick={() => retryWorkspace(workspaceRange)}>Spróbuj ponownie</Button>}
      />}
      {absenceUnavailable && (
        <div className="cal__absence-error" role="status">
          <span>Nie udało się sprawdzić wolnego w tym zakresie.</span>
          <Button variant="ghost" size="sm" onClick={retryAbsences}>Spróbuj ponownie</Button>
        </div>
      )}

      <div className="row row--between cal-toolbar" data-reveal>
        <div className="row" style={{ gap: 14 }}>
          <div className="month-nav">
            <IconBtn name="chevL" label={nav.prevLabel} disabled={nav.prevOff} onClick={nav.prev} />
            {mode === 'agenda' ? (
              <WeekNav
                selected={agendaSel}
                today={today}
                sessions={roleSessions}
                firstMonth={firstMonth}
                lastMonth={lastMonth}
                isApp={isApp}
                onSelect={selectDay}
              />
            ) : <span className="month-nav__label month-nav__label--sentence">{cap(nav.label)}</span>}
            <IconBtn name="chevR" label={nav.nextLabel} disabled={nav.nextOff} onClick={nav.next} />
          </div>
          {!nav.atToday && (
            <Button variant="ghost" size="sm" onClick={() => selectDay(today)}>
              Dziś
            </Button>
          )}
        </div>
      </div>

      {role.scope !== 'own' && (
        <section className="filter-bar" aria-label="Filtr specjalistki">
          <FilterGroup label="Specjalistka">
            <Chip on={!filters.specialist} onClick={() => setFilters((current) => ({ ...current, specialist: null }))}>
              Wszystkie
            </Chip>
            {filterPsychologists.map((psychologist) => (
              <Chip
                key={psychologist.id}
                on={filters.specialist === psychologist.id}
                swatch={psychologist.color}
                onClick={() => setFilters((current) => ({
                  ...current,
                  specialist: current.specialist === psychologist.id ? null : psychologist.id,
                }))}
              >
                {psychologist.name}
              </Chip>
            ))}
          </FilterGroup>
        </section>
      )}

      <FilterBar
        activeCount={activeFilterCount}
        summary={activeFilterSummary}
        onClear={() => setFilters((current) => ({ ...current, payment: 'all', attendance: 'all' }))}
        label="Filtry Grafiku"
      >
        <FilterGroup label="Płatność">
            {PAYMENT_FILTERS.map((payment) => (
              <Chip key={payment.value} on={filters.payment === payment.value} onClick={() => toggleFilter('payment', payment.value)}>
                {payment.label}
              </Chip>
            ))}
        </FilterGroup>
        <FilterGroup label="Obecność klienta">
            {ATTENDANCE_FILTERS.map((attendance) => (
              <Chip key={attendance.value} on={filters.attendance === attendance.value} onClick={() => toggleFilter('attendance', attendance.value)}>
                {attendance.label}
              </Chip>
            ))}
        </FilterGroup>
      </FilterBar>

      <div className={workspaceRefreshing ? 'is-refreshing' : ''} aria-busy={workspaceRefreshing || undefined}>
      {mode === 'agenda' ? (
        <>
          <DayStrip
            days={weekDays}
            selected={agendaSel}
            today={today}
            byDate={weekByDate}
            historicalByDate={historicalModel.exactByDay}
            absencesForDate={absencesForDate}
            psychOf={psychOf}
            onSelect={selectDay}
          />
          <section className="card card--pad agenda-day" ref={agendaPanelRef} data-reveal aria-label="Plan dnia">
            <div className="agenda-day__head">
              <h2 className="card-title agenda-day__title">
                <span className="agenda-day__title-text">
                  {cap(fmtWeekday(agendaSel))}, {fmtDayMonth(agendaSel)}
                  {agendaSel === today && <span className="pill pill--amber">dziś</span>}
                </span>
              </h2>
              {(agendaSessions.length > 0
                || (historicalModel.exactByDay[agendaSel]?.length ?? 0) > 0
                || agendaAbsences.length > 0) && (
                <p className="agenda-day__count" aria-live="polite">
                {calendarCountLabel(
                  agendaSessions.length,
                  historicalModel.exactByDay[agendaSel]?.length ?? 0,
                  agendaAbsences.length,
                )}
                </p>
              )}
            </div>
            {agendaAbsences.map((absence) => (
              <AbsenceMarker
                key={absence.id}
                absence={absence}
                specialist={absencePsychOf(absence.specialistId)}
                block
                onCancel={canManageAppointments ? () => cancelAbsence(absence) : undefined}
              />
            ))}
            {agendaSessions.length === 0
              && (historicalModel.exactByDay[agendaSel]?.length ?? 0) === 0
              && agendaAbsences.length === 0 ? (
              <EmptyState
                compact
                icon="calendar"
                title="Brak sesji tego dnia"
                hint={isApp ? 'W tym kompletnym zakresie nie ma zaplanowanych sesji.' : 'Dodaj pierwszą sesję przyciskiem poniżej.'}
              />
            ) : (
              dayThread(
                agendaSessions,
                historicalModel.exactByDay[agendaSel] || [],
                false,
                agendaSel,
                agendaFlipRef,
                true,
              )
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
                const items = (byDate[cell.iso] || []).toSorted(compareCalendarSessionOrder)
                const historicalItems = historicalModel.exactByDay[cell.iso] || []
                const absenceItems = absencesForDate(cell.iso)
                const itemCount = items.length + historicalItems.length + absenceItems.length
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
                    aria-label={`${fmtDayMonth(cell.iso)} - ${calendarCountLabel(items.length, historicalItems.length, absenceItems.length)}`}
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
                        {historicalItems.slice(0, Math.max(0, 4 - items.length)).map((row) => (
                          <span key={row.id} className="dot dot--historical" style={{ background: psychOf(row.specialistId)?.color }} />
                        ))}
                        {absenceItems.slice(0, Math.max(0, 4 - items.length - historicalItems.length)).map((absence) => (
                          <span key={absence.id} className="dot dot--absence" style={{ background: absencePsychOf(absence.specialistId)?.color }} />
                        ))}
                        {itemCount > 4 && <span className="cal__more">+{itemCount - 4}</span>}
                      </span>
                    ) : (
                      <span className="cal__items">
                        {items.slice(0, 3).map((s) => (
                          <span
                            key={s.id}
                            className={`cal__item ${s.status === 'scheduled' && canDragSession(s) ? 'is-draggable' : ''}`}
                            data-flip-id={s.id}
                            style={{ background: psychOf(s.psychId)?.soft, '--node-color': psychOf(s.psychId)?.color }}
                            onPointerDown={(e) => { if (canDragSession(s)) onChipDown(e, s) }}
                            title={s.status === 'scheduled' && canDragSession(s) ? 'Przeciągnij, aby przełożyć sesję' : undefined}
                          >
                            <span className="cal__item-time">{s.time}</span>
                            <span className="cal__item-name">{clientIdentityFor(state.clients, s.clientId).name.split(' ')[0]}</span>
                          </span>
                        ))}
                        {historicalItems.slice(0, Math.max(0, 3 - items.length)).map((row) => (
                          <span key={row.id} className="cal__item cal__item--historical">
                            <span className="cal__item-time">bez godz.</span>
                            <span className="cal__item-name">{row.subjectName.split(' ')[0]}</span>
                          </span>
                        ))}
                        {absenceItems.slice(0, Math.max(0, 3 - items.length - historicalItems.length)).map((absence) => (
                          <AbsenceMarker
                            key={absence.id}
                            absence={absence}
                            specialist={absencePsychOf(absence.specialistId)}
                          />
                        ))}
                        {itemCount > 3 && <span className="cal__more">+{itemCount - 3} więcej</span>}
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
              <div className="cal-day-panel__head">
                <h2 className="card-title cal-day-panel__title">
                  <span className="cal-day-panel__title-text">
                    {selected ? cap(fmtWeekday(selected)) + ', ' + fmtDayMonth(selected) : 'Wybierz dzień'}
                    {selected === today && <span className="pill pill--amber">dziś</span>}
                  </span>
                </h2>
                {selected && (daySessions.length > 0 || dayHistoricalRows.length > 0 || selectedAbsences.length > 0) && (
                  <p className="cal-day-panel__count" aria-live="polite">
                    {calendarCountLabel(daySessions.length, dayHistoricalRows.length, selectedAbsences.length)}
                  </p>
                )}
              </div>
              <div className="cal-day-panel__list">
                {selectedAbsences.map((absence) => (
                  <AbsenceMarker
                    key={absence.id}
                    absence={absence}
                    specialist={absencePsychOf(absence.specialistId)}
                    block
                    onCancel={canManageAppointments ? () => cancelAbsence(absence) : undefined}
                  />
                ))}
                {selected && daySessions.length === 0 && dayHistoricalRows.length === 0 && selectedAbsences.length === 0 && (
                  <EmptyState
                    compact
                    icon="calendar"
                    title="Brak sesji tego dnia"
                    hint={isApp ? 'W tym kompletnym zakresie nie ma zaplanowanych sesji.' : 'Dodaj pierwszą sesję przyciskiem poniżej.'}
                  />
                )}
                {(daySessions.length > 0 || dayHistoricalRows.length > 0) &&
                  dayThread(
                    daySessions.toSorted(compareCalendarSessionOrder),
                    dayHistoricalRows,
                    canDrag,
                    selected,
                  )}
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
      {isApp && historicalModel.suppressedCount > 0 && (
        <p className="historical-filter-note" role="status">
          Wpisy ze skoroszytu bez statusu i płatności są ukryte przez aktywny filtr.
        </p>
      )}
      {isApp && mode === 'cal' && workspaceState === 'ready' && showHistorical
        && canonicalMonthAppointmentCount + historicalModel.historicalCount === 0 && (
        <section className="card card--pad historical-zero" aria-live="polite">
          <h2 className="card-title">Brak sesji i wpisów ze skoroszytu w tym miesiącu</h2>
          <p>W {fmtMonthLocative(ym)} {ym.slice(0, 4)} nie ma sesji ani wpisów ze skoroszytu.</p>
          {latestMonthAction && (
            <Button
              variant="soft"
              onClick={() => {
                setYm(latestMonthAction.month)
                setSelected(`${latestMonthAction.month}-01`)
                setMode('cal')
                setReview(null)
              }}
            >
              {latestMonthAction.label}
            </Button>
          )}
        </section>
      )}
      {isApp && showHistorical && (
        <HistoricalMonthSection rows={historicalModel.monthOnlyRows} ym={ym} />
      )}
      {isApp && showHistorical && review !== 'unknown' && (
        <HistoricalUnknownSummary
          count={historicalModel.unknownRows.length}
          routeParams={historicalRouteParams}
        />
      )}
      {isApp && showHistorical && review === 'unknown' && (
        <HistoricalUnknownReview
          rows={historicalModel.unknownRows}
          onClose={() => setReview(null)}
        />
      )}
      </div>
      </>}
    </div>
  )
}
