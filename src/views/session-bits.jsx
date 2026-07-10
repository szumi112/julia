// Shared interactive pills for changing session status / payment inline.
import { useState } from 'react'
import { Pill, Popover, PopItem } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { STATUS_LABELS, STATUS_PILL, PAY_LABELS, PAY_PILL, fmtMoney } from '../format.js'

const STATUS_TONE = { scheduled: 'rose', completed: 'sage', cancelled: 'mauve', noshow: 'error' }
const PAY_TONE = { paid: 'sage', unpaid: 'error', partial: 'gold' }

export function StatusPicker({ session }) {
  const { dispatch, toast } = useApp()
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      setOpen={setOpen}
      trigger={
        <Pill tone={STATUS_TONE[session.status]} dot onClick={() => setOpen(!open)} title="Zmień status sesji">
          {STATUS_LABELS[session.status]}
          <Icon name="chevD" size={11} />
        </Pill>
      }
    >
      {Object.keys(STATUS_LABELS).map((st) => (
        <PopItem
          key={st}
          on={st === session.status}
          onClick={() => {
            dispatch({ type: 'UPDATE_SESSION', id: session.id, patch: { status: st } })
            setOpen(false)
            // cancelling has a billing consequence worth naming
            toast(st === 'cancelled'
              ? 'Status zmieniony: odwołana — sesja nie jest fakturowana'
              : `Status zmieniony: ${STATUS_LABELS[st].toLowerCase()}`)
          }}
        >
          <span className="dot" style={{ width: 7, height: 7, borderRadius: 99, background: `var(--${STATUS_TONE[st] === 'error' ? 'error' : STATUS_TONE[st]})` }} />
          {STATUS_LABELS[st]}
        </PopItem>
      ))}
    </Popover>
  )
}

export function PaymentPicker({ session }) {
  const { dispatch, toast } = useApp()
  const { openSessionForm } = useShell()
  const [open, setOpen] = useState(false)
  const label =
    session.payment === 'partial'
      ? `${PAY_LABELS.partial} · ${fmtMoney(session.paidAmount)}`
      : PAY_LABELS[session.payment]
  return (
    <Popover
      open={open}
      setOpen={setOpen}
      trigger={
        <Pill tone={PAY_TONE[session.payment]} dot onClick={() => setOpen(!open)} title="Zmień płatność">
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
            dispatch({ type: 'UPDATE_SESSION', id: session.id, patch: { payment: p } })
            setOpen(p === 'partial')
            toast(`Płatność zmieniona: ${PAY_LABELS[p].toLowerCase()}`)
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
    </Popover>
  )
}

export { STATUS_PILL, PAY_PILL }
