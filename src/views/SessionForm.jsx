// Add/Edit session — slide-over drawer with validation.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useApp, useAppointmentMutationLock, useWorkspaceRefresh, useWorkspaceRetry, useWorkspaceWindow,
} from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { Button, Field, Segmented, IconBtn, Pill, DiscardConfirm, useDiscardGuard } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { EntityLink } from '../ux-patterns.jsx'
import { SessionClientPicker } from './SessionClientPicker.jsx'
import { CancellationDialog } from './session-bits.jsx'
import { useDrawerFX } from '../anim.js'
import { toISODate, timeToMin, fmtDayMonth, fmtMoney, monthKey, warsawDateTimeFromUtc, STATUS_LABELS, PAY_LABELS, METHOD_LABELS } from '../format.js'
import {
  assignmentStartLabel, isBeforeAssignmentStart, latestSessionForClient,
  bookableClientsForRole, isBookableClient, occupiedSessionsForSpecialistDay, occupiedTimeLabels, sessionHasStarted, sessionSpecialistId,
  suggestedSessionTime,
} from '../workspace.js'
import { SERVICES, SERVICE_BY_ID, STANDARD_SERVICE, amountFor, durationFor } from '../services.js'
import { ApiError } from '../api.js'
import { validateAppointmentInput } from '../core-records.js'
import { canPerformAction } from '../capability-access.js'
import { conflictCopy, saveFailureCopy } from '../save-failure-copy.js'
import { hasActivePanelAccess, isAssignableSpecialist, NO_PANEL_ACCESS_COPY } from '../specialist-eligibility.js'
import { isWorkspaceRangeCovered, monthWorkspaceRange } from '../workspace-view.js'
import {
  appointmentCancellationTarget,
  appointmentCancellationToastKey,
  appointmentRestorationError,
} from '../appointment-cancellation.js'

const DEFAULT_SESSION_TIME = '12:00'

const workspaceRangeForSessionDate = (date, initialRange) => {
  if (!date) return null
  if (initialRange && initialRange.from <= date && initialRange.to >= date) return initialRange
  return monthWorkspaceRange(monthKey(date))
}

export function SessionDrawer({ opts, onClose }) {
  const { state, dispatch, toast, workspace } = useApp()
  const { locked: appointmentMutationLocked } = useAppointmentMutationLock()
  const { appMode, capabilities, role, registerLeaveGuard, navigate } = useShell()
  const refreshWorkspace = useWorkspaceRefresh()
  const isApp = appMode === 'app'
  const editing = opts.session || null
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const paidAmountRef = useRef(null)
  const dateRef = useRef(null)

  const availableClients = bookableClientsForRole(state, role)
  // only specialists with active panel access can take a session in the app
  const availablePsychologists = state.psychologists.filter((psych) => (
    (!isApp || isAssignableSpecialist(psych))
    && (role.scope !== 'own' || psych.id === role.psychId)
  ))
  const solePsychologist = availablePsychologists.length === 1 ? availablePsychologists[0] : null
  const defaultClient = editing?.clientId || opts.clientId || ''
  const defaultClientRecord = state.clients.find((client) => client.id === defaultClient)
  const latestClientSession = !editing && defaultClient
    ? latestSessionForClient(state.sessions, defaultClient)
    : null
  const defaultPsych = editing?.psychId || sessionSpecialistId({
    availablePsychologists,
    ownPsychId: role.scope === 'own' ? role.psychId : null,
    preferredPsychId: opts.psychId,
    latestPsychId: latestClientSession?.psychId,
    clientPsychId: defaultClientRecord?.psychId,
    currentPsychId: availablePsychologists.length === 1 ? availablePsychologists[0].id : null,
  })
  const defaultDate = editing?.date || opts.date || toISODate(new Date())
  const initialWorkspaceRange = workspaceRangeForSessionDate(defaultDate, opts.workspaceRange)
  const initialDateCovered = !isApp || isWorkspaceRangeCovered(workspace.loadedRanges, initialWorkspaceRange)
  const defaultTime = editing?.time || (initialDateCovered && suggestedSessionTime(state.sessions, {
    psychId: defaultPsych, date: defaultDate, excludeId: editing?.id,
  })) || DEFAULT_SESSION_TIME
  const statusOptions = Object.entries(STATUS_LABELS).filter(([value]) => value !== 'cancelled')

  // a new session opens priced: the service and the specialist are both known
  // up front, so the cennik can fill the amount before anything is typed
  const defaultService = editing?.service || STANDARD_SERVICE
  const defaultAmount = editing
    ? editing.amount
    : defaultPsych
      ? amountFor(defaultService, state.psychologists.find((p) => p.id === defaultPsych))
      : ''

  const [form, setForm] = useState({
    clientId: defaultClient,
    psychId: defaultPsych,
    service: defaultService,
    date: defaultDate,
    time: defaultTime,
    duration: editing?.duration || durationFor(defaultService),
    amount: defaultAmount,
    status: editing?.status || 'scheduled',
    payment: editing?.payment || 'unpaid',
    paidAmount: editing?.paidAmount || '',
    method: editing?.method || '',
    note: editing?.note || '',
  })
  const [errors, setErrors] = useState({})
  const [cancellationOpen, setCancellationOpen] = useState(false)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const amountTouched = useRef(!!editing)
  const timeTouched = useRef(!!editing)
  const psychTouched = useRef(false)
  const formWorkspaceRange = useMemo(
    () => workspaceRangeForSessionDate(form.date, opts.workspaceRange),
    [form.date, opts.workspaceRange?.from, opts.workspaceRange?.to],
  )
  const hasFormWorkspaceRange = Boolean(formWorkspaceRange)
  const occupiedWorkspaceState = useWorkspaceWindow(formWorkspaceRange, isApp && hasFormWorkspaceRange)
  const occupiedWorkspaceCovered = hasFormWorkspaceRange && (
    !isApp || isWorkspaceRangeCovered(workspace.loadedRanges, formWorkspaceRange)
  )
  const retryWorkspace = useWorkspaceRetry()
  const [initialForm] = useState(form)
  const discardGuard = useDiscardGuard(JSON.stringify(form) !== JSON.stringify(initialForm))
  const allowSavedNavigation = useRef(false)
  const { close, forceClose, shake } = useDrawerFX(drawerRef, backRef, onClose, discardGuard.guard)
  useEffect(() => registerLeaveGuard(() => (
    allowSavedNavigation.current ? false : discardGuard.check()
  )), [registerLeaveGuard, discardGuard.check])
  const [absenceCheck, setAbsenceCheck] = useState({ targetKey: null, status: 'idle', absence: null })
  const [absenceCheckAttempt, setAbsenceCheckAttempt] = useState(0)
  const absenceProviderState = workspace.absences?.state
  const absenceLoadWindow = workspace.absences?.loadWindow
  useEffect(() => {
    if (!absenceProviderState || !absenceLoadWindow || !form.date || !form.psychId) {
      setAbsenceCheck((current) => (
        current.targetKey === null && current.status === 'idle' && current.absence === null
          ? current
          : { targetKey: null, status: 'idle', absence: null }
      ))
      return
    }
    const specialistId = isApp ? form.psychId : `sp_demo_${form.psychId}`
    const loaded = absenceProviderState
    const key = `${role.id}|${specialistId}|${form.date}|${absenceCheckAttempt}`
    const findAbsence = (absences) => absences.find((absence) => (
      absence.specialistId === specialistId
        && absence.dateFrom <= form.date
        && absence.dateTo >= form.date
    )) || null
    if (absenceCheck.targetKey === key && absenceCheck.status !== 'idle') return
    if (loaded.from && loaded.to && loaded.from <= form.date && loaded.to >= form.date) {
      setAbsenceCheck({ targetKey: key, status: 'ready', absence: findAbsence(loaded.absences) })
      return
    }
    setAbsenceCheck({ targetKey: key, status: 'loading', absence: null })
    absenceLoadWindow({ from: form.date, to: form.date }).then((payload) => {
      setAbsenceCheck({ targetKey: key, status: 'ready', absence: findAbsence(payload.absences) })
    }).catch(() => setAbsenceCheck({ targetKey: key, status: 'error', absence: null }))
  }, [absenceCheck, absenceCheckAttempt, absenceLoadWindow, absenceProviderState, form.date, form.psychId, isApp, role.id])

  useEffect(() => {
    if (opts.focus !== 'paidAmount' || form.payment !== 'partial') return
    // useDrawerFX keeps later fields hidden during its entrance stagger. Wait
    // for this field's actual visibility instead of racing that animation.
    let frame
    const focusWhenVisible = () => {
      const input = paidAmountRef.current
      if (!input || getComputedStyle(input).visibility === 'hidden') {
        frame = requestAnimationFrame(focusWhenVisible)
        return
      }
      input.focus()
    }
    frame = requestAnimationFrame(focusWhenVisible)
    return () => cancelAnimationFrame(frame)
  }, [opts.focus, form.payment])

  useEffect(() => {
    if (opts.focus !== 'date') return
    let frame
    const focusWhenVisible = () => {
      const input = dateRef.current
      if (!input || getComputedStyle(input).visibility === 'hidden') {
        frame = requestAnimationFrame(focusWhenVisible)
        return
      }
      input.focus()
    }
    frame = requestAnimationFrame(focusWhenVisible)
    return () => cancelAnimationFrame(frame)
  }, [opts.focus])

  const set = (k, v) => {
    if (k === 'time') timeTouched.current = true
    setForm((f) => {
      const next = { ...f, [k]: v }
      return next
    })
    setErrors((e) => ({ ...e, [k]: null, ...(['date', 'duration', 'time'].includes(k) ? { time: null } : {}) }))
    setSaveStatus('idle')
    setSaveError(null)
  }
  const setPayment = (payment) => {
    setForm((current) => ({ ...current, payment, paidAmount: payment === 'partial' ? '' : current.paidAmount }))
    setErrors((current) => ({ ...current, paidAmount: null }))
    if (payment === 'partial') requestAnimationFrame(() => paidAmountRef.current?.focus())
  }

  // auto-fill psychologist + amount when picking a client
  const onClientChange = (clientId) => {
    const client = state.clients.find((c) => c.id === clientId)
    const latestSession = latestSessionForClient(state.sessions, clientId)
    const psychId = sessionSpecialistId({
      availablePsychologists,
      ownPsychId: role.scope === 'own' ? role.psychId : null,
      preferredPsychId: psychTouched.current ? form.psychId : null,
      latestPsychId: latestSession?.psychId,
      clientPsychId: client?.psychId,
      currentPsychId: form.psychId,
    })
    const psych = state.psychologists.find((p) => p.id === psychId)
    setForm((f) => ({
      ...f,
      clientId,
      psychId,
      time: timeTouched.current
        ? f.time
        : occupiedWorkspaceCovered
          ? suggestedSessionTime(state.sessions, {
            psychId, date: f.date, excludeId: editing?.id,
          }) || DEFAULT_SESSION_TIME
          : f.time,
      amount: amountTouched.current ? f.amount : amountFor(f.service, psych),
    }))
    setErrors((e) => ({ ...e, clientId: null, psychId: null, time: null }))
  }

  const onPsychChange = (psychId) => {
    psychTouched.current = true
    const psych = state.psychologists.find((p) => p.id === psychId)
    setForm((f) => ({
      ...f,
      psychId,
      time: timeTouched.current
        ? f.time
        : occupiedWorkspaceCovered
          ? suggestedSessionTime(state.sessions, {
            psychId, date: f.date, excludeId: editing?.id,
          }) || DEFAULT_SESSION_TIME
          : f.time,
      amount: amountTouched.current ? f.amount : amountFor(f.service, psych),
    }))
    setErrors((e) => ({ ...e, psychId: null, time: null }))
  }

  useEffect(() => {
    if (editing || timeTouched.current || !occupiedWorkspaceCovered || !form.psychId || !form.date) return
    const suggested = suggestedSessionTime(state.sessions, {
      psychId: form.psychId, date: form.date,
    }) || DEFAULT_SESSION_TIME
    setForm((current) => (
      current.date === form.date && current.psychId === form.psychId && current.time !== suggested
        ? { ...current, time: suggested }
        : current
    ))
  }, [editing, form.date, form.psychId, occupiedWorkspaceCovered, state.sessions])

  // Picking a position from the cennik restates length and price — an explicit
  // choice of service outranks an earlier hand-typed amount.
  const onServiceChange = (service) => {
    const psych = state.psychologists.find((p) => p.id === form.psychId)
    amountTouched.current = false
    setForm((f) => ({ ...f, service, duration: durationFor(service), amount: amountFor(service, psych) }))
    setErrors((e) => ({ ...e, amount: null, time: null }))
  }

  // acceptance target: a failed submit lands focus on the first invalid field
  const focusFirstInvalid = () =>
    requestAnimationFrame(() =>
      drawerRef.current?.querySelector('.has-error input, .has-error select, .has-error textarea')?.focus()
    )

  // A loaded clash is authoritative enough to stop an avoidable write. The API
  // remains the final guard for concurrent changes outside this workspace window.
  const conflict = useMemo(() => {
    if (!occupiedWorkspaceCovered || !form.psychId || !form.date || !form.time) return null
    const start = timeToMin(form.time)
    const end = start + Number(form.duration)
    return (
      state.sessions.find(
        (s) =>
          s.psychId === form.psychId &&
          s.date === form.date &&
          s.id !== editing?.id &&
          s.status !== 'cancelled' &&
          timeToMin(s.time) < end &&
          start < timeToMin(s.time) + s.duration
      ) || null
    )
  }, [state.sessions, form.psychId, form.date, form.time, form.duration, editing, occupiedWorkspaceCovered])

  const conflictError = conflict && (() => {
    const psychologist = state.psychologists.find((item) => item.id === form.psychId)
    const client = state.clients.find((item) => item.id === conflict.clientId)
    const firstName = psychologist?.name.split(' ')[0] || 'Specjalistka'
    return `${firstName} ma już sesję o ${conflict.time}${client ? ` (${client.name})` : ''}. Wybierz inną godzinę.`
  })()

  const occupiedSessions = useMemo(() => occupiedWorkspaceCovered
    ? occupiedSessionsForSpecialistDay(state.sessions, {
      psychId: form.psychId, date: form.date, excludeId: editing?.id,
    })
    : [], [editing?.id, form.date, form.psychId, occupiedWorkspaceCovered, state.sessions])
  const retryOccupiedWorkspace = () => {
    if (formWorkspaceRange) retryWorkspace(formWorkspaceRange)
  }
  const occupiedTimesHint = form.psychId && form.date
    ? !occupiedWorkspaceCovered
      ? occupiedWorkspaceState === 'unavailable'
        ? <><span>Nie udało się sprawdzić zajętych godzin.</span> <Button variant="ghost" size="sm" onClick={retryOccupiedWorkspace}>Spróbuj ponownie</Button></>
        : 'Sprawdzam zajęte godziny…'
      : occupiedSessions.length
      ? `Zajęte godziny: ${occupiedTimeLabels(occupiedSessions).join(' · ')}`
      : 'Zajęte godziny: brak'
    : undefined

  const absenceWarning = absenceCheck.absence
  const retryAbsenceCheck = () => {
    workspace.recoverFromInfrastructureError?.()
    setAbsenceCheck({ targetKey: null, status: 'idle', absence: null })
    setAbsenceCheckAttempt((attempt) => attempt + 1)
  }

  const appPayload = () => {
    const appointment = {
      clientId: form.clientId,
      specialistId: form.psychId,
      serviceId: form.service,
      date: form.date,
      time: form.time,
      durationMinutes: Number(form.duration),
      expectedAmountGrosze: Math.round(Number(form.amount) * 100),
      location: null,
      status: form.status,
    }
    validateAppointmentInput(appointment)
    if (!editing) return appointment
    const { clientId, ...edit } = appointment
    return edit
  }

  const appErrors = () => {
    const errors = {
      clientId: form.clientId ? null : 'Wybierz klienta',
      psychId: form.psychId ? null : 'Wybierz specjalistkę',
      date: form.date ? null : 'Podaj poprawną datę i godzinę',
      time: form.time ? null : 'Podaj poprawną datę i godzinę',
      amount: String(form.amount).trim() ? null : 'Sprawdź rodzaj sesji i kwotę',
      body: null,
    }
    try {
      appPayload()
      return errors
    } catch (error) {
      const field = error instanceof TypeError ? error.message.split('/').at(-1) : 'body'
      if (field === 'clientId') errors.clientId ||= 'Wybierz klienta'
      else if (field === 'specialistId') errors.psychId ||= 'Wybierz specjalistkę'
      else if (field === 'dateTime') {
        errors.date ||= 'Podaj poprawną datę i godzinę'
        errors.time ||= 'Podaj poprawną datę i godzinę'
      } else if (['expectedAmountGrosze', 'durationMinutes', 'serviceId'].includes(field)) {
        errors.amount = 'Sprawdź rodzaj sesji i kwotę'
      } else errors.body = 'Sprawdź dane sesji'
      return errors
    }
  }

  const appRefreshSourceRange = () => {
    if (!editing) return opts.workspaceRange || null
    if (opts.workspaceRange
      && opts.workspaceRange.from <= editing.date
      && opts.workspaceRange.to >= editing.date) return opts.workspaceRange
    return monthWorkspaceRange(monthKey(editing.date))
  }

  const refreshRangesAfterAppMutation = (savedAt) => {
    const source = editing ? appRefreshSourceRange() : null
    const destination = monthWorkspaceRange(monthKey(savedAt.date))
    return [source, destination].filter(Boolean).filter((range, index, ranges) => (
      ranges.findIndex((candidate) => (
        candidate.from === range.from && candidate.to === range.to
      )) === index
    ))
  }

  const refreshAfterAppMutation = async (savedAt) => {
    try {
      for (const range of refreshRangesAfterAppMutation(savedAt)) {
        await refreshWorkspace(range)
      }
    } catch {
      forceClose()
      toast('Sesję zapisano, ale nie udało się odświeżyć Grafiku.', 'alert')
      return false
    }
    return true
  }

  const selectedPsychLacksAccess = () => {
    const psych = state.psychologists.find((item) => item.id === form.psychId)
    return Boolean(psych) && !hasActivePanelAccess(psych)
  }

  const submitApp = async () => {
    if (saveStatus === 'saving' || appointmentMutationLocked
      || !canPerformAction(capabilities, editing
        ? 'appointment.edit' : 'appointment.create')) return
    const validationErrors = appErrors()
    const nextErrors = { ...validationErrors, time: conflictError || validationErrors.time }
    const selectedClient = state.clients.find((client) => client.id === form.clientId)
    if (!nextErrors.date && !nextErrors.time && selectedClient?.assignmentStartsAt && isBeforeAssignmentStart(
      form.date, form.time, selectedClient.assignmentStartsAt,
    )) {
      nextErrors.date = `Ten klient jest pod opieką tej specjalistki od ${assignmentStartLabel(selectedClient.assignmentStartsAt)}. Wcześniejszej sesji nie można zapisać.`
    }
    if (form.psychId && !availablePsychologists.some((psychologist) => psychologist.id === form.psychId)) {
      nextErrors.psychId = selectedPsychLacksAccess() ? NO_PANEL_ACCESS_COPY : 'Wybierz aktywną specjalistkę'
    }
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) {
      shake()
      focusFirstInvalid()
      return
    }
    const payload = appPayload()
    setSaveStatus('saving')
    setSaveError(null)
    let savedAppointment
    try {
      savedAppointment = editing
        ? await workspace.editAppointment(editing.id, editing.version, payload)
        : await workspace.createAppointment(payload)
    } catch (error) {
      setSaveStatus('error')
      if (error instanceof ApiError && error.code === 'APPOINTMENT_OVERLAP') {
        setErrors({ time: 'Ta sesja koliduje z inną sesją tej specjalistki. Wybierz inną godzinę.' })
        shake()
        focusFirstInvalid()
      } else if (error instanceof ApiError && error.code === 'NOT_FOUND' && selectedPsychLacksAccess()) {
        // the server refuses such a specialist with a generic NOT_FOUND
        setErrors({ psychId: NO_PANEL_ACCESS_COPY })
        shake()
        focusFirstInvalid()
      } else if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        try {
          const source = appRefreshSourceRange()
          if (source) await refreshWorkspace(source)
        } catch {
          // The form intentionally stays open with its draft after stale failures.
        }
        setSaveError(`${conflictCopy('tę sesję')} Zamknij formularz, otwórz go ponownie i wprowadź zmianę jeszcze raz.`)
      } else {
        setSaveError(saveFailureCopy(error, { subject: 'sesji' }))
      }
      return
    }
    const savedAt = warsawDateTimeFromUtc(savedAppointment.startsAt)
    if (!await refreshAfterAppMutation(savedAt)) return
    const savedClient = state.clients.find((client) => client.id === savedAppointment.clientId)
    const rescheduled = editing && (editing.date !== savedAt.date || editing.time !== savedAt.time)
    toast(`Sesja została ${rescheduled ? 'przełożona' : editing ? 'zapisana' : 'dodana'} · ${savedClient?.name || 'Klient'}, ${fmtDayMonth(savedAt.date)}, ${savedAt.time} · ${fmtMoney(savedAppointment.charge.expectedAmountGrosze / 100)}`)
    const showSavedSession = !editing || rescheduled
    if (showSavedSession) allowSavedNavigation.current = true
    forceClose()
    if (showSavedSession) {
      navigate('calendar', { date: savedAt.date, highlightSessionIds: [savedAppointment.id] })
    }
  }

  const submit = (e) => {
    e.preventDefault()
    if (isApp) return submitApp()
    const errs = {}
    if (!form.clientId) errs.clientId = 'Wybierz klienta'
    if (!form.psychId) errs.psychId = 'Wybierz specjalistkę'
    if (!form.date) errs.date = 'Podaj datę'
    if (!form.time) errs.time = 'Podaj godzinę'
    const amount = Number(form.amount)
    if (!Number.isFinite(amount) || amount <= 0) errs.amount = 'Podaj kwotę większą od zera'
    const selectedClient = state.clients.find((c) => c.id === form.clientId)
    if (selectedClient?.since && form.date < selectedClient.since) {
      errs.date = `Ten klient jest pod opieką od ${fmtDayMonth(selectedClient.since)}. Wcześniejszej sesji nie można zapisać.`
    }
    if (role.scope === 'own' && selectedClient?.psychId !== role.psychId) {
      errs.clientId = 'Wybierz klienta przypisanego do Twojej opieki'
    }
    if (role.scope === 'own' && form.psychId !== role.psychId) {
      errs.psychId = 'Sesję może prowadzić tylko aktywna specjalistka'
    }
    if (selectedClient && form.psychId && selectedClient.psychId !== form.psychId) {
      errs.psychId = 'Wybrana specjalistka nie prowadzi tego klienta'
    }
    if (form.payment === 'partial') {
      const pa = Number(form.paidAmount)
      if (!Number.isFinite(pa) || pa <= 0) errs.paidAmount = 'Podaj wpłaconą kwotę'
      else if (pa >= amount) errs.paidAmount = 'Wpłata częściowa musi być niższa niż kwota'
    }
    if (conflictError) errs.time = conflictError
    setErrors(errs)
    if (Object.keys(errs).length) {
      shake()
      focusFirstInvalid()
      return
    }
    const payload = {
      clientId: form.clientId,
      psychId: form.psychId,
      service: form.service,
      date: form.date,
      time: form.time,
      duration: Number(form.duration),
      amount,
      status: form.status,
      payment: form.payment,
      paidAmount: form.payment === 'partial' ? Number(form.paidAmount) : form.payment === 'paid' ? amount : 0,
      method: form.payment === 'unpaid' ? null : form.method || null,
      note: form.note,
    }
    if (editing) {
      dispatch({ type: 'UPDATE_SESSION', id: editing.id, patch: payload })
      toast(`Sesja została zapisana · ${selectedClient?.name || 'Klient'}, ${fmtDayMonth(payload.date)}, ${payload.time}`)
    } else {
      dispatch({ type: 'ADD_SESSION', session: payload })
      toast(`Sesja została dodana · ${selectedClient?.name || 'Klient'}, ${fmtDayMonth(payload.date)}, ${payload.time}`)
    }
    forceClose()
  }

  const cancelAppointmentWithUndo = async (reason) => {
    let cancelled
    const range = appRefreshSourceRange()
    const target = appointmentCancellationTarget(editing, appMode)
    try {
      cancelled = await workspace.cancelAppointment(target.id, target.version, reason)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT' && range) {
        try { await refreshWorkspace(range) } catch { /* dialog keeps the concrete error */ }
      }
      throw error
    }
    let refreshed = true
    try {
      if (range) await refreshWorkspace(range)
    } catch {
      refreshed = false
    }
    const clientName = client?.name || 'Klient'
    const toastKey = appointmentCancellationToastKey(cancelled.id)
    toast(
      refreshed
        ? `Sesja została odwołana · ${clientName}, ${fmtDayMonth(editing.date)}, ${editing.time}`
        : `Sesję odwołano, ale nie udało się odświeżyć Grafiku · ${clientName}, ${fmtDayMonth(editing.date)}, ${editing.time}`,
      refreshed ? 'check' : 'alert',
      {
        key: toastKey,
        label: 'Cofnij',
        onClick: async () => {
          let restored
          try {
            restored = await workspace.restoreAppointment(cancelled.id, cancelled.version)
            if (range) await refreshWorkspace(range)
            toast(`Sesja została przywrócona · ${clientName}, ${fmtDayMonth(editing.date)}, ${editing.time}`, 'check', { key: toastKey })
          } catch (error) {
            if (!restored && error instanceof ApiError && error.code === 'VERSION_CONFLICT' && range) {
              try { await refreshWorkspace(range) } catch { /* keep the command error */ }
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
    forceClose()
    return cancelled
  }

  const client = state.clients.find((c) => c.id === form.clientId)

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={opts.reschedule ? 'Przełóż sesję' : editing ? 'Edycja sesji' : 'Nowa sesja'}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{opts.reschedule ? 'Przełóż sesję' : editing ? 'Edycja sesji' : 'Nowa sesja'}</h2>
            <p className="drawer__sub">
              {editing
                ? `${client?.name || ''} · ${fmtDayMonth(editing.date)}`
                : 'Uzupełnij szczegóły sesji.'}
            </p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        <form className="drawer__body" onSubmit={submit} noValidate>
          {absenceCheck.status === 'error' && (
            <div className="cal__absence-error" role="status">
              <span>Nie udało się sprawdzić wolnego tej specjalistki.</span>
              <Button variant="ghost" size="sm" onClick={retryAbsenceCheck}>Spróbuj ponownie</Button>
            </div>
          )}
          {absenceWarning && (
            <div className="form-warn" role="status">
              <Icon name="calendar" size={15} />
              <span>
                {`Ta specjalistka ma zaznaczone wolne: ${fmtDayMonth(absenceWarning.dateFrom)}`}
                {absenceWarning.dateTo !== absenceWarning.dateFrom && ` - ${fmtDayMonth(absenceWarning.dateTo)}`}
                . Sesję nadal można zapisać.
              </span>
            </div>
          )}
          <SessionClientPicker
            clients={availableClients}
            selectedClient={defaultClientRecord}
            value={form.clientId}
            onChange={onClientChange}
            error={errors.clientId}
            disabled={Boolean(editing) && (isApp || !isBookableClient(defaultClientRecord))}
          />
          <p className="field__hint session-client-picker__link">
            Nie ma tej osoby? <EntityLink
              route="clients"
              className="link"
              onClick={(event) => {
                event.preventDefault()
                navigate('clients', undefined, forceClose)
              }}
            >Przejdź do Klientów</EntityLink>
          </p>

          {availablePsychologists.length === 0 ? (
            <div className="field has-error" role="alert">
              <span className="field__label">Specjalistka</span>
              <span className="field__error"><Icon name="alert" size={13} /> Brak aktywnej specjalistki dostępnej do tej sesji.</span>
            </div>
          ) : solePsychologist && form.psychId === solePsychologist.id ? (
            <div className="field">
              <span className="field__label">Prowadzi: {[solePsychologist.title, solePsychologist.name].filter(Boolean).join(' ')}</span>
            </div>
          ) : (
            <Field label="Specjalistka" error={errors.psychId}>
              <select name="session-psych" autoComplete="off" className="select" value={form.psychId} onChange={(e) => onPsychChange(e.target.value)}>
                <option value="">— wybierz —</option>
                {availablePsychologists.map((p) => (
                  <option key={p.id} value={p.id}>{p.title} {p.name}</option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Rodzaj sesji" hint={SERVICE_BY_ID[form.service]?.note}>
            <select name="session-service" autoComplete="off" className="select" value={form.service} onChange={(e) => onServiceChange(e.target.value)}>
              {SERVICES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </Field>

          <div className="form-grid">
            <Field label="Data" error={errors.date} hint={editing ? 'Zmiana daty przekłada sesję w Grafiku.' : undefined}>
              <input type="date" name="session-date" autoComplete="off" className="input" value={form.date} ref={dateRef} onChange={(e) => set('date', e.target.value)} />
            </Field>
            <Field label="Godzina" error={errors.time} hint={occupiedTimesHint}>
              <input type="time" name="session-time" autoComplete="off" className="input" value={form.time} onChange={(e) => set('time', e.target.value)} />
            </Field>
            <Field label="Czas trwania">
              <select name="session-duration" autoComplete="off" className="select" value={form.duration} onChange={(e) => set('duration', e.target.value)}>
                <option value="50">50 minut</option>
                <option value="60">60 minut</option>
                <option value="90">90 minut</option>
                <option value="120">120 minut</option>
              </select>
            </Field>
            <Field label="Kwota (zł)" error={errors.amount}>
              <input
                type="number"
                min="0"
                step="10"
                inputMode="decimal"
                name="session-amount"
                autoComplete="off"
                className="input"
                value={form.amount}
                placeholder="np. 180"
                onChange={(e) => { amountTouched.current = true; set('amount', e.target.value) }}
              />
            </Field>
          </div>

          <Field
            label="Status sesji"
            hint={sessionHasStarted(form)
              ? 'Rozliczane są sesje odbyte i nieobecności. Sesja odwołana nie wlicza się do rozliczeń.'
              : 'Odbytą sesję oznaczysz po jej rozpoczęciu.'}
          >
            {form.status === 'cancelled'
              ? <Pill tone="ink" dot>{STATUS_LABELS.cancelled}</Pill>
              : <Segmented
                  ariaLabel="Status sesji"
                  value={form.status}
                  onChange={(v) => set('status', v)}
                  options={statusOptions.map(([value, label]) => ({
                    value,
                    label,
                    disabled: value === 'completed' && !sessionHasStarted(form),
                  }))}
                />}
          </Field>

          {!isApp && (editing || form.status !== 'scheduled') && <Field
            label="Płatność"
            hint="Czy klient zapłacił za tę sesję — przy wpłacie częściowej podaj kwotę."
          >
            <Segmented
              ariaLabel="Płatność"
              value={form.payment}
              onChange={setPayment}
              options={Object.entries(PAY_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Field>}

          {!isApp && (editing || form.status !== 'scheduled') && form.payment !== 'unpaid' && (
            <Field label="Forma płatności" hint="Jak klient zapłacił — gotówką, kartą czy przelewem.">
              <Segmented
                ariaLabel="Forma płatności"
                value={form.method}
                onChange={(v) => set('method', v)}
                options={[
                  { value: '', label: '—' },
                  ...Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label })),
                ]}
              />
            </Field>
          )}

          {!isApp && (editing || form.status !== 'scheduled') && form.payment === 'partial' && (
            <Field label="Wpłacono (zł)" error={errors.paidAmount}>
              <input
                type="number"
                min="0"
                step="10"
                inputMode="decimal"
                name="session-paid"
                autoComplete="off"
                className="input"
                value={form.paidAmount}
                placeholder="np. 110…"
                ref={paidAmountRef}
                onChange={(e) => set('paidAmount', e.target.value)}
              />
            </Field>
          )}

          {!isApp && <Field label="Zalecenia / notatka">
            <textarea
              name="session-note"
              autoComplete="off"
              className="textarea"
              value={form.note}
              placeholder="Zalecenia dla klienta, przebieg sesji…"
              onChange={(e) => set('note', e.target.value)}
            />
          </Field>}

        </form>

        {saveError && (
          <div className="form-warn form-warn--error" role="alert">
            <Icon name="alert" size={15} />
            <span>{saveError}</span>
          </div>
        )}

        {discardGuard.confirming && (
          <DiscardConfirm onStay={discardGuard.hide} onDiscard={forceClose} />
        )}

        <div className="drawer__foot">
          <Button variant="primary" onClick={submit} disabled={availablePsychologists.length === 0 || (isApp && (saveStatus === 'saving' || appointmentMutationLocked))}>
            {isApp && saveStatus === 'saving' ? 'Zapisywanie…' : editing ? 'Zapisz zmiany' : 'Dodaj sesję'}
          </Button>
          {editing && form.status !== 'cancelled'
            && (!isApp || canPerformAction(capabilities, 'appointment.cancel')) && (
            <Button
              variant="danger"
              disabled={saveStatus === 'saving' || appointmentMutationLocked}
              onClick={() => setCancellationOpen(true)}
            >
              Odwołaj sesję…
            </Button>
          )}
          <Button variant="ghost" onClick={close} disabled={isApp && saveStatus === 'saving'}>Zamknij</Button>
        </div>
      </aside>
      {cancellationOpen && editing && (
        <CancellationDialog
          session={editing}
          clientName={client?.name || 'Klient'}
          specialistName={state.psychologists.find(({ id }) => id === editing.psychId)?.name || 'Specjalistka'}
          onClose={() => setCancellationOpen(false)}
          onConfirm={cancelAppointmentWithUndo}
        />
      )}
    </>
  )
}
