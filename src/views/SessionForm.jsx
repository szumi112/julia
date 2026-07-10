// Add/Edit session — slide-over drawer with validation.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { Button, Field, Segmented, IconBtn } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useDrawerFX, motionOK } from '../anim.js'
import { toISODate, timeToMin, STATUS_LABELS, PAY_LABELS } from '../format.js'

export function SessionDrawer({ opts, onClose }) {
  const { state, dispatch, toast } = useApp()
  const editing = opts.session || null
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const { close, shake } = useDrawerFX(drawerRef, backRef, onClose)

  const defaultClient = editing?.clientId || opts.clientId || ''
  const defaultPsych =
    editing?.psychId ||
    (defaultClient ? state.clients.find((c) => c.id === defaultClient)?.psychId : '') ||
    opts.psychId ||
    ''

  const [form, setForm] = useState({
    clientId: defaultClient,
    psychId: defaultPsych,
    date: editing?.date || opts.date || toISODate(new Date()),
    time: editing?.time || '12:00',
    duration: editing?.duration || 50,
    amount: editing ? editing.amount : '',
    status: editing?.status || 'scheduled',
    payment: editing?.payment || 'unpaid',
    paidAmount: editing?.paidAmount || '',
    note: editing?.note || '',
  })
  const [errors, setErrors] = useState({})
  const amountTouched = useRef(!!editing)

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: null }))
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
      amount: amountTouched.current ? f.amount : psych ? psych.rate : f.amount,
    }))
    setErrors((e) => ({ ...e, clientId: null }))
  }

  const onPsychChange = (psychId) => {
    const psych = state.psychologists.find((p) => p.id === psychId)
    setForm((f) => ({
      ...f,
      psychId,
      amount: amountTouched.current ? f.amount : psych ? psych.rate : f.amount,
    }))
    setErrors((e) => ({ ...e, psychId: null }))
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
        { autoAlpha: 0, y: -6 },
        { autoAlpha: 1, y: 0, duration: 0.35, ease: 'power2.out', clearProps: 'transform,opacity,visibility' }
      )
    }
  }, [conflict?.id])

  const submit = (e) => {
    e.preventDefault()
    const errs = {}
    if (!form.clientId) errs.clientId = 'Wybierz klienta'
    if (!form.psychId) errs.psychId = 'Wybierz specjalistkę'
    if (!form.date) errs.date = 'Podaj datę'
    if (!form.time) errs.time = 'Podaj godzinę'
    const amount = Number(form.amount)
    if (!amount || amount <= 0) errs.amount = 'Podaj kwotę większą od zera'
    if (form.payment === 'partial') {
      const pa = Number(form.paidAmount)
      if (!pa || pa <= 0) errs.paidAmount = 'Podaj wpłaconą kwotę'
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
      date: form.date,
      time: form.time,
      duration: Number(form.duration),
      amount,
      status: form.status,
      payment: form.payment,
      paidAmount: form.payment === 'partial' ? Number(form.paidAmount) : form.payment === 'paid' ? amount : 0,
      note: form.note,
    }
    if (editing) {
      dispatch({ type: 'UPDATE_SESSION', id: editing.id, patch: payload })
      toast('Zmiany w sesji zapisane')
    } else {
      dispatch({ type: 'ADD_SESSION', session: payload })
      toast('Nowa sesja dodana do kalendarza')
    }
    close()
  }

  const remove = () => {
    dispatch({ type: 'DELETE_SESSION', id: editing.id })
    toast('Sesja usunięta', 'close')
    close()
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
                ? `${client?.name || ''} · ${editing.date}`
                : 'Uzupełnij szczegóły spotkania.'}
            </p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field label="Klient" error={errors.clientId}>
            <select className="select" value={form.clientId} onChange={(e) => onClientChange(e.target.value)} autoFocus>
              <option value="">— wybierz klienta —</option>
              {state.clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Specjalistka" error={errors.psychId}>
            <select className="select" value={form.psychId} onChange={(e) => onPsychChange(e.target.value)}>
              <option value="">— wybierz —</option>
              {state.psychologists.map((p) => (
                <option key={p.id} value={p.id}>{p.title} {p.name}</option>
              ))}
            </select>
          </Field>

          <div className="form-grid">
            <Field label="Data" error={errors.date} hint={editing ? 'Zmiana daty przekłada sesję w kalendarzu.' : undefined}>
              <input type="date" className="input" value={form.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
            <Field label="Godzina" error={errors.time}>
              <input type="time" className="input" value={form.time} onChange={(e) => set('time', e.target.value)} />
            </Field>
            <Field label="Czas trwania">
              <select className="select" value={form.duration} onChange={(e) => set('duration', e.target.value)}>
                <option value="50">50 minut</option>
                <option value="60">60 minut</option>
                <option value="80">80 minut</option>
                <option value="90">90 minut</option>
              </select>
            </Field>
            <Field label="Kwota (zł)" error={errors.amount}>
              <input
                type="number"
                min="0"
                step="10"
                className="input"
                value={form.amount}
                placeholder="np. 220"
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
              options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Field>

          <Field
            label="Płatność"
            hint="Czy klient zapłacił za tę sesję — przy wpłacie częściowej podaj kwotę."
          >
            <Segmented
              ariaLabel="Płatność"
              value={form.payment}
              onChange={(v) => set('payment', v)}
              options={Object.entries(PAY_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Field>

          {form.payment === 'partial' && (
            <Field label="Wpłacono (zł)" error={errors.paidAmount}>
              <input
                type="number"
                min="0"
                step="10"
                className="input"
                value={form.paidAmount}
                placeholder="np. 110"
                onChange={(e) => set('paidAmount', e.target.value)}
              />
            </Field>
          )}

          <Field label="Zalecenia / notatka">
            <textarea
              className="textarea"
              value={form.note}
              placeholder="Zalecenia dla klienta, przebieg sesji…"
              onChange={(e) => set('note', e.target.value)}
            />
          </Field>
        </form>

        <div className="drawer__foot">
          <Button variant="primary" onClick={submit}>
            {editing ? 'Zapisz zmiany' : 'Dodaj sesję'}
          </Button>
          {editing && (
            <Button variant="danger" onClick={remove}>
              Usuń
            </Button>
          )}
          <Button variant="ghost" onClick={close}>Anuluj</Button>
        </div>
      </aside>
    </>
  )
}
