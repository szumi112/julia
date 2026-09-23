// Shared interactive pills for changing session status / payment inline.
import { Fragment, useEffect, useRef, useState } from 'react'
import { Button, IconBtn, Pill, Popover, PopItem } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { STATUS_LABELS, STATUS_PILL, PAY_LABELS, PAY_PILL, METHOD_LABELS, fmtDayMonth, fmtMoney, paymentDisplayFor } from '../format.js'
import { sessionHasStarted } from '../workspace.js'
import {
  APPOINTMENT_CANCELLATION_REASONS,
  appointmentCancellationError,
} from '../appointment-cancellation.js'

const STATUS_TONE = { scheduled: 'ink', completed: 'sage', cancelled: 'ink', noshow: 'pink' }
const PAY_TONE = { paid: 'sage', unpaid: 'amber', partial: 'amber' }

export function CancellationDialog({ session, clientName, specialistName, onClose, onConfirm }) {
  const dialogRef = useRef(null)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    dialog?.querySelector('input')?.focus()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  const close = () => {
    if (!saving) onClose()
  }
  const confirm = async () => {
    if (!reason || saving) return
    setSaving(true)
    setError('')
    try {
      await onConfirm(reason)
      onClose()
    } catch (failure) {
      setError(appointmentCancellationError(failure))
      setSaving(false)
    }
  }

  return (
    <dialog
      className="quick-dialog cancellation-dialog"
      ref={dialogRef}
      aria-labelledby="appointment-cancellation-title"
      onCancel={(event) => { event.preventDefault(); close() }}
    >
      <div className="quick-dialog__head">
        <div>
          <div className="eyebrow">Potwierdzenie</div>
          <h2 id="appointment-cancellation-title">Odwołaj sesję?</h2>
          <p>{clientName} · {fmtDayMonth(session.date)}, {session.time} · {specialistName}</p>
        </div>
        <IconBtn name="close" label="Zamknij" onClick={close} disabled={saving} />
      </div>

      <fieldset className="cancellation-dialog__reasons">
        <legend>Powód odwołania</legend>
        {APPOINTMENT_CANCELLATION_REASONS.map((option) => (
          <label className="cancellation-dialog__reason" key={option.value}>
            <input
              type="radio"
              name="appointment-cancellation-reason"
              value={option.value}
              checked={reason === option.value}
              disabled={saving}
              onChange={(event) => { setReason(event.target.value); setError('') }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      {error && <div className="cancellation-dialog__error" role="alert">{error}</div>}
      <div className="quick-dialog__actions">
        <Button variant="ghost" disabled={saving} onClick={close}>Zamknij</Button>
        <Button variant="danger" disabled={!reason || saving} onClick={() => { void confirm() }}>
          {saving ? 'Odwoływanie…' : 'Odwołaj sesję'}
        </Button>
      </div>
    </dialog>
  )
}

export function StatusPicker({
  session, accessibleLabel, canChange = false, clientName = '', specialistName = '',
  onStatusChange, onCancel,
}) {
  const { dispatch, toast } = useApp()
  const { appMode, role } = useShell()
  const [open, setOpen] = useState(false)
  const [cancellationOpen, setCancellationOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const completedUnavailable = !sessionHasStarted(session)
  if (session.status === 'cancelled') {
    return <Pill tone={STATUS_TONE.cancelled} dot>{STATUS_LABELS.cancelled}</Pill>
  }
  if (!canChange || typeof onStatusChange !== 'function' || session.readOnly
    || (role.scope === 'own' && session.psychId !== role.psychId)) {
    return <Pill tone={STATUS_TONE[session.status]} dot>{STATUS_LABELS[session.status]}</Pill>
  }
  const changeStatus = async (status) => {
    if (saving) return
    if (status === session.status) {
      setOpen(false)
      return
    }
    setSaving(true)
    try {
      if (appMode === 'app') await onStatusChange(status)
      else {
        dispatch({ type: 'UPDATE_SESSION', id: session.id, patch: { status } })
        // cancelling has a billing consequence worth naming
        toast(status === 'cancelled'
          ? 'Sesja została odwołana · nie wlicza się do rozliczeń'
          : `Status sesji został zmieniony · ${STATUS_LABELS[status]}`)
      }
    } finally {
      setSaving(false)
      setOpen(false)
    }
  }
  return <>
    <Popover
      open={open}
      setOpen={setOpen}
      trigger={
        <Pill
          tone={STATUS_TONE[session.status]}
          dot
          onClick={() => setOpen(!open)}
          title="Zmień status sesji"
          aria-label={accessibleLabel}
        >
          {STATUS_LABELS[session.status]}
          <Icon name="chevD" size={11} />
        </Pill>
      }
    >
      {Object.keys(STATUS_LABELS).filter((st) => st !== 'cancelled').map((st) => <Fragment key={st}>
        <PopItem
          on={st === session.status}
          disabled={saving || (st === 'completed' && completedUnavailable)}
          onClick={() => { void changeStatus(st) }}
        >
          <span className="dot" style={{ width: 7, height: 7, borderRadius: 99, background: `var(--${STATUS_TONE[st] === 'error' ? 'error' : STATUS_TONE[st]})` }} />
          {st === 'cancelled' && appMode === 'app' ? 'Odwołaj' : STATUS_LABELS[st]}
        </PopItem>
        {st === 'completed' && completedUnavailable && <div className="popover__label">Odbytą sesję oznaczysz po jej rozpoczęciu.</div>}
      </Fragment>)}
      {typeof onCancel === 'function' && <>
        <div className="popover__sep" role="separator" />
        <PopItem
          role="menuitem"
          className="popover__item--danger"
          disabled={saving}
          onClick={() => { setOpen(false); setCancellationOpen(true) }}
        >
          <Icon name="close" size={14} />
          Odwołaj sesję…
        </PopItem>
      </>}
    </Popover>
    {cancellationOpen && (
      <CancellationDialog
        session={session}
        clientName={clientName}
        specialistName={specialistName}
        onClose={() => setCancellationOpen(false)}
        onConfirm={onCancel}
      />
    )}
  </>
}

export function PaymentPicker({ session, accessibleLabel, readOnly = false, action = null }) {
  const { dispatch, toast } = useApp()
  const { appMode, openSessionForm, role } = useShell()
  const [open, setOpen] = useState(false)
  const display = paymentDisplayFor(session)
  if (!display) return null
  if (display.kind === 'quiet') return <span className="muted">{display.label}</span>
  const label =
    session.payment === 'partial'
      ? `${PAY_LABELS.partial} · ${fmtMoney(session.paidAmount)}`
      : display.label
  if (readOnly || appMode === 'app' || session.readOnly
    || (role.scope === 'own' && session.psychId !== role.psychId)) {
    return <>
      <Pill tone={display.tone} dot>{label}</Pill>
      {action}
    </>
  }
  return (
    <Popover
      open={open}
      setOpen={setOpen}
      trigger={
        <Pill
          tone={display.tone}
          dot
          onClick={() => setOpen(!open)}
          title="Zmień płatność"
          aria-label={accessibleLabel}
        >
          {label}
          <Icon name="chevD" size={11} />
        </Pill>
      }
    >
      {Object.keys(PAY_LABELS).map((p) => (
        <PopItem
          key={p}
          on={p === session.payment}
          onClick={() => {
            if (p === session.payment) {
              setOpen(p === 'partial')
              return
            }
            dispatch({ type: 'UPDATE_SESSION', id: session.id, patch: { payment: p } })
            setOpen(p === 'partial')
            toast(`Płatność została zmieniona · ${PAY_LABELS[p]}`)
          }}
        >
          <span className="dot" style={{ width: 7, height: 7, borderRadius: 99, background: `var(--${PAY_TONE[p] === 'error' ? 'error' : PAY_TONE[p]})` }} />
          {PAY_LABELS[p]}
        </PopItem>
      ))}
      {session.payment === 'partial' && (
        <PopItem
          role="menuitem"
          onClick={() => {
            setOpen(false)
            openSessionForm({ session, focus: 'paidAmount' })
          }}
        >
          <Icon name="edit" size={14} />
          Edytuj kwotę
        </PopItem>
      )}
      {session.payment !== 'unpaid' && (
        <>
          <div className="popover__sep" role="separator" />
          <div className="popover__label">Forma płatności</div>
          {Object.entries(METHOD_LABELS).map(([value, label]) => (
            <PopItem
              key={value}
              on={session.method === value}
              onClick={() => {
                setOpen(false)
                if (session.method === value) return
                dispatch({ type: 'UPDATE_SESSION', id: session.id, patch: { method: value } })
                toast(`Forma płatności została zmieniona · ${label}`)
              }}
            >
              {label}
            </PopItem>
          ))}
        </>
      )}
    </Popover>
  )
}

export { STATUS_PILL, PAY_PILL }
