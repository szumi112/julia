// Add/Edit session — slide-over drawer with validation.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useAppointmentMutationLock, useWorkspaceRefresh } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { Button, Field, Segmented, IconBtn, DiscardConfirm, useDiscardGuard } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useDrawerFX, motionOK } from '../anim.js'
import { toISODate, timeToMin, fmtDayMonth, isBillable, STATUS_LABELS, PAY_LABELS, METHOD_LABELS } from '../format.js'
import { clientsForRole } from '../workspace.js'
import { SERVICES, SERVICE_BY_ID, STANDARD_SERVICE, amountFor, durationFor } from '../services.js'
import { ApiError } from '../api.js'
import { validateAppointmentInput } from '../core-records.js'
import { canPerformAction } from '../capability-access.js'

export function SessionDrawer({ opts, onClose }) {
  const { state, dispatch, toast, workspace } = useApp()
  const { locked: appointmentMutationLocked } = useAppointmentMutationLock()
  const { appMode, capabilities, role, registerLeaveGuard } = useShell()
  const refreshWorkspace = useWorkspaceRefresh()
  const isApp = appMode === 'app'
  const editing = opts.session || null
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const paidAmountRef = useRef(null)

  const defaultClient = editing?.clientId || opts.clientId || ''
  const defaultPsych =
    editing?.psychId ||
    (defaultClient ? state.clients.find((c) => c.id === defaultClient)?.psychId : '') ||
    opts.psychId ||
    (role.scope === 'own' ? role.psychId : '') ||
    ''
  const availableClients = clientsForRole(state, role)
  const availablePsychologists = role.scope === 'own'
    ? state.psychologists.filter((psych) => psych.id === role.psychId)
    : state.psychologists
  const statusOptions = Object.entries(STATUS_LABELS).filter(([value]) => !isApp || value !== 'cancelled')

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
    date: editing?.date || opts.date || toISODate(new Date()),
    time: editing?.time || '12:00',
    duration: editing?.duration || durationFor(defaultService),
    amount: defaultAmount,
    status: editing?.status || 'scheduled',
    payment: editing?.payment || 'unpaid',
    paidAmount: editing?.paidAmount || '',
    method: editing?.method || '',
    note: editing?.note || '',
  })
  const [errors, setErrors] = useState({})
  const [confirmDel, setConfirmDel] = useState(false)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const amountTouched = useRef(!!editing)
  const [initialForm] = useState(form)
  const discardGuard = useDiscardGuard(JSON.stringify(form) !== JSON.stringify(initialForm))
  const { close, forceClose, shake } = useDrawerFX(drawerRef, backRef, onClose, discardGuard.guard)
  useEffect(() => registerLeaveGuard(discardGuard.check), [registerLeaveGuard, discardGuard.check])

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

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: null }))
    setSaveStatus('idle')
    setSaveError(null)
  }

  // auto-fill psychologist + amount when picking a client
  const onClientChange = (clientId) => {
    const client = state.clients.find((c) => c.id === clientId)
    const psychId = client ? client.psychId : form.psychId
    const psych = state.psychologists.find((p) => p.id === psychId)
    setForm((f) => ({
      ...f,
      clientId,
      psychId,
      amount: amountTouched.current ? f.amount : amountFor(f.service, psych),
    }))
    setErrors((e) => ({ ...e, clientId: null }))
  }

  const onPsychChange = (psychId) => {
    const psych = state.psychologists.find((p) => p.id === psychId)
    setForm((f) => ({
      ...f,
      psychId,
      amount: amountTouched.current ? f.amount : amountFor(f.service, psych),
    }))
    setErrors((e) => ({ ...e, psychId: null }))
  }

  // Picking a position from the cennik restates length and price — an explicit
  // choice of service outranks an earlier hand-typed amount.
  const onServiceChange = (service) => {
    const psych = state.psychologists.find((p) => p.id === form.psychId)
    amountTouched.current = false
    setForm((f) => ({ ...f, service, duration: durationFor(service), amount: amountFor(service, psych) }))
    setErrors((e) => ({ ...e, amount: null }))
  }

  // acceptance target: a failed submit lands focus on the first invalid field
  const focusFirstInvalid = () =>
    requestAnimationFrame(() =>
      drawerRef.current?.querySelector('.has-error input, .has-error select, .has-error textarea')?.focus()
    )

  // non-blocking warning: the chosen specialist already has a session then
  const conflict = useMemo(() => {
    if (!form.psychId || !form.date || !form.time) return null
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
  }, [state.sessions, form.psychId, form.date, form.time, form.duration, editing])

  const warnRef = useRef(null)
  useEffect(() => {
    if (conflict && motionOK() && warnRef.current) {
      window.gsap.fromTo(
        warnRef.current,
        { y: -4 },
        { y: 0, duration: 0.2, ease: 'power2.out', clearProps: 'transform' }
      )
    }
  }, [conflict?.id])

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
    try {
      appPayload()
      return {}
    } catch (error) {
      const field = error instanceof TypeError ? error.message.split('/').at(-1) : 'body'
      return {
        clientId: field === 'clientId' ? 'Wybierz klienta' : null,
        psychId: field === 'specialistId' ? 'Wybierz specjalistkę' : null,
        date: field === 'dateTime' ? 'Podaj poprawną datę i godzinę' : null,
        time: field === 'dateTime' ? 'Podaj poprawną datę i godzinę' : null,
        amount: ['expectedAmountGrosze', 'durationMinutes', 'serviceId'].includes(field)
          ? 'Sprawdź rodzaj spotkania i kwotę' : null,
        body: ['clientId', 'specialistId', 'dateTime', 'expectedAmountGrosze', 'durationMinutes', 'serviceId', 'status'].includes(field)
          ? null
          : 'Sprawdź dane sesji',
      }
    }
  }

  const refreshAfterAppMutation = async () => {
    try {
      await refreshWorkspace(opts.workspaceRange)
    } catch {
      forceClose()
      toast('Sesję zapisano, ale nie udało się odświeżyć kalendarza.', 'alert')
      return false
    }
    return true
  }

  const submitApp = async () => {
    if (saveStatus === 'saving' || appointmentMutationLocked
      || !canPerformAction(capabilities, editing
        ? 'appointment.edit' : 'appointment.create')) return
    const nextErrors = appErrors()
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) {
      shake()
      focusFirstInvalid()
      return
    }
    const payload = appPayload()
    setSaveStatus('saving')
    setSaveError(null)
    try {
      if (editing) await workspace.editAppointment(editing.id, editing.version, payload)
      else await workspace.createAppointment(payload)
    } catch (error) {
      setSaveStatus('error')
      if (error instanceof ApiError && error.code === 'APPOINTMENT_OVERLAP') {
        setSaveError('Ten termin jest już zajęty. Wybierz inną godzinę.')
      } else if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        try {
          await refreshWorkspace(opts.workspaceRange)
        } catch {
          // The form intentionally stays open with its draft after stale failures.
        }
        setSaveError('Termin został zmieniony. Odśwież kalendarz i spróbuj ponownie.')
      } else {
        setSaveError('Nie udało się zapisać sesji.')
      }
      return
    }
    if (!await refreshAfterAppMutation()) return
    toast(editing ? 'Zmiany w sesji zapisane' : 'Nowa sesja dodana do kalendarza')
    forceClose()
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
      toast('Zmiany w sesji zapisane')
    } else {
      dispatch({ type: 'ADD_SESSION', session: payload })
      toast('Nowa sesja dodana do kalendarza')
    }
    forceClose()
  }

  const remove = () => {
    if (isApp) return
    dispatch({ type: 'DELETE_SESSION', id: editing.id })
    toast('Sesja usunięta', 'close')
    forceClose()
  }

  const client = state.clients.find((c) => c.id === form.clientId)

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={editing ? 'Edycja sesji' : 'Nowa sesja'}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{editing ? 'Edycja sesji' : 'Nowa sesja'}</h2>
            <p className="drawer__sub">
              {editing
                ? `${client?.name || ''} · ${fmtDayMonth(editing.date)}`
                : 'Uzupełnij szczegóły spotkania.'}
            </p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field label="Klient" error={errors.clientId}>
            {/* no autoFocus: it would hijack activeElement before useDrawerFX
                records the opener, breaking focus restore on close */}
            <select name="session-client" autoComplete="off" className="select" value={form.clientId} onChange={(e) => onClientChange(e.target.value)} disabled={isApp && Boolean(editing)}>
              <option value="">— wybierz klienta —</option>
              {availableClients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Specjalistka" error={errors.psychId}>
            <select name="session-psych" autoComplete="off" className="select" value={form.psychId} onChange={(e) => onPsychChange(e.target.value)}>
              <option value="">— wybierz —</option>
              {availablePsychologists.map((p) => (
                <option key={p.id} value={p.id}>{p.title} {p.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Rodzaj spotkania" hint={SERVICE_BY_ID[form.service]?.note}>
            <select name="session-service" autoComplete="off" className="select" value={form.service} onChange={(e) => onServiceChange(e.target.value)}>
              {SERVICES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </Field>

          <div className="form-grid">
            <Field label="Data" error={errors.date} hint={editing ? 'Zmiana daty przekłada sesję w kalendarzu.' : undefined}>
              <input type="date" name="session-date" autoComplete="off" className="input" value={form.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
            <Field label="Godzina" error={errors.time}>
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
                placeholder="np. 180…"
                onChange={(e) => { amountTouched.current = true; set('amount', e.target.value) }}
              />
            </Field>
          </div>

          {conflict && (
            <div className="form-warn" role="status" ref={warnRef}>
              <Icon name="alert" size={15} />
              <span>
                {state.psychologists.find((p) => p.id === form.psychId)?.name.split(' ')[0] || 'Specjalistka'}{' '}
                ma już tego dnia sesję o <b>{conflict.time}</b>
                {state.clients.find((c) => c.id === conflict.clientId) &&
                  <> ({state.clients.find((c) => c.id === conflict.clientId).name})</>}
                . Możesz mimo to zapisać — terminy będą się nakładać.
              </span>
            </div>
          )}

          <Field
            label="Status sesji"
            hint="Rozliczane są sesje odbyte i nieobecności. Sesja odwołana nie jest fakturowana."
          >
            <Segmented
              ariaLabel="Status sesji"
              value={form.status}
              onChange={(v) => set('status', v)}
              options={statusOptions.map(([value, label]) => ({ value, label }))}
            />
          </Field>

          {!isApp && <Field
            label="Płatność"
            hint="Czy klient zapłacił za tę sesję — przy wpłacie częściowej podaj kwotę."
          >
            <Segmented
              ariaLabel="Płatność"
              value={form.payment}
              onChange={(v) => set('payment', v)}
              options={Object.entries(PAY_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Field>}

          {!isApp && form.payment !== 'unpaid' && (
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

          {!isApp && form.payment === 'partial' && (
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

          {editing && confirmDel && (
            <div className="form-warn form-warn--error" role="alert">
              <Icon name="alert" size={15} />
              <span>
                Sesja z <b>{fmtDayMonth(editing.date)} o {editing.time}</b>
                {client && <> ({client.name})</>} zostanie trwale usunięta
                {isBillable(editing) && <> — zniknie też z rozliczeń i raportu miesiąca</>}
                .
              </span>
            </div>
          )}
          {saveError && (
            <div className="form-warn form-warn--error" role="alert">
              <Icon name="alert" size={15} />
              <span>{saveError}</span>
            </div>
          )}
        </form>

        {discardGuard.confirming && (
          <DiscardConfirm onStay={discardGuard.hide} onDiscard={forceClose} />
        )}

        <div className="drawer__foot">
          {editing && confirmDel ? (
            <>
              <Button variant="danger" onClick={remove}>
                Tak, usuń sesję
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDel(false)}>Wróć</Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={submit} disabled={isApp && (saveStatus === 'saving' || appointmentMutationLocked)}>
                {editing ? 'Zapisz zmiany' : 'Dodaj sesję'}
              </Button>
              {editing && !isApp && (
                <Button variant="danger" onClick={() => setConfirmDel(true)}>
                  Usuń
                </Button>
              )}
              <Button variant="ghost" onClick={close} disabled={isApp && saveStatus === 'saving'}>Anuluj</Button>
            </>
          )}
        </div>
      </aside>
    </>
  )
}
