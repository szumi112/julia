// Shared interactive pills for changing session status / payment inline.
import { useState } from 'react'
import { Pill, Popover, PopItem } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useApp } from '../store.jsx'
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
        <Pill tone={STATUS_TONE[session.status]} dot onClick={() => setOpen(!open)} aria-haspopup="menu">
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
            toast(`Status zmieniony: ${STATUS_LABELS[st].toLowerCase()}`)
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
        <Pill tone={PAY_TONE[session.payment]} dot onClick={() => setOpen(!open)} aria-haspopup="menu">
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
            const patch = { payment: p }
            if (p === 'partial' && !session.paidAmount) patch.paidAmount = Math.round(session.amount / 2 / 10) * 10
            dispatch({ type: 'UPDATE_SESSION', id: session.id, patch })
            setOpen(false)
            toast(`Płatność: ${PAY_LABELS[p].toLowerCase()}`)
          }}
        >
          <span className="dot" style={{ width: 7, height: 7, borderRadius: 99, background: `var(--${PAY_TONE[p] === 'error' ? 'error' : PAY_TONE[p]})` }} />
          {PAY_LABELS[p]}
        </PopItem>
      ))}
    </Popover>
  )
}

export { STATUS_PILL, PAY_PILL }
