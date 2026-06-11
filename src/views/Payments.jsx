import { useMemo, useState } from 'react'
import { useApp, sessionsInMonth, availableMonths } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useCountUp, useFlip } from '../anim.js'
import { Avatar, Pill, Chip, IconBtn, Button, InfoTip, EmptyState } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { BarFill } from '../charts.jsx'
import { PaymentPicker } from './session-bits.jsx'
import {
  fmtMoney, monthKey, addMonths, fmtMonthYear, fmtShortDate,
  isBillable, collectedOf, outstandingOf, sessionsWord,
} from '../format.js'

function MoneyStat({ label, value, tone, tip }) {
  const ref = useCountUp(value, fmtMoney)
  return (
    <div className={`card stat card--lift ${tone === 'gold' ? 'stat--gold' : ''}`} data-reveal>
      <div className="stat__label">{label}{tip && <InfoTip text={tip} />}</div>
      <div className="stat__value"><span ref={ref}>0</span></div>
    </div>
  )
}

export function Payments() {
  const { state, dispatch, toast } = useApp()
  const { openSessionForm } = useShell()
  const ref = useReveal()
  const [ym, setYm] = useState(monthKey(new Date()))
  const [psychFilter, setPsychFilter] = useState(null)
  const [unpaidOnly, setUnpaidOnly] = useState(false)

  const months = useMemo(() => availableMonths(state.sessions), [state.sessions])
  const maxYm = monthKey(new Date()) // billing always stops at the current month
  const monthBillable = useMemo(
    () => sessionsInMonth(state.sessions, ym).filter(isBillable).reverse(),
    [state.sessions, ym]
  )
  const filtered = monthBillable.filter(
    (s) => (!psychFilter || s.psychId === psychFilter) && (!unpaidOnly || outstandingOf(s) > 0)
  )

  const collected = filtered.reduce((a, s) => a + collectedOf(s), 0)
  const outstanding = filtered.reduce((a, s) => a + outstandingOf(s), 0)

  const flipRef = useFlip(filtered.map((s) => s.id).join(','))

  const perPsych = state.psychologists.map((p) => {
    const own = monthBillable.filter((s) => s.psychId === p.id)
    return {
      p,
      collected: own.reduce((a, s) => a + collectedOf(s), 0),
      outstanding: own.reduce((a, s) => a + outstandingOf(s), 0),
    }
  })
  const maxPsych = Math.max(...perPsych.map((x) => x.collected + x.outstanding), 1)

  const clientOf = (id) => state.clients.find((c) => c.id === id)
  const psychOf = (id) => state.psychologists.find((p) => p.id === id)

  const markPaid = (s) => {
    dispatch({ type: 'UPDATE_SESSION', id: s.id, patch: { payment: 'paid', paidAmount: s.amount } })
    toast(`Zaksięgowano ${fmtMoney(outstandingOf(s))} — ${clientOf(s.clientId)?.name}`)
  }

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Rozliczenia</div>
          <h1 className="display view-head__title">Finanse <em>i płatności</em></h1>
          <p className="view-head__sub">
            Sesje rozliczane: odbyte i nieobecności. Odwołane nie są fakturowane.
          </p>
        </div>
        <div className="view-head__actions">
          {ym !== maxYm && (
            <Button variant="ghost" size="sm" onClick={() => setYm(maxYm)}>
              Bieżący miesiąc
            </Button>
          )}
          <div className="month-nav">
            <IconBtn name="chevL" label="Poprzedni miesiąc" disabled={ym <= months[0]} onClick={() => setYm(addMonths(ym, -1))} />
            <span className="month-nav__label">{fmtMonthYear(ym)}</span>
            <IconBtn name="chevR" label="Następny miesiąc" disabled={ym >= maxYm} onClick={() => setYm(addMonths(ym, 1))} />
          </div>
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
        <Chip on={unpaidOnly} onClick={() => setUnpaidOnly(!unpaidOnly)}>
          <Icon name="payments" size={14} /> Tylko zaległe
        </Chip>
      </div>

      <div className="stats-row stats-row--3">
        <MoneyStat
          label="Wystawione (mies.)"
          value={collected + outstanding}
          tip="Suma kwot za sesje rozliczane w tym miesiącu — odbyte i nieobecności. Sesje odwołane nie są fakturowane."
        />
        <MoneyStat label="Zebrane" value={collected} tip="Kwoty już wpłacone przez klientów, łącznie z wpłatami częściowymi." />
        <MoneyStat
          label="Zaległe"
          value={outstanding}
          tone="gold"
          tip="To, czego klienci jeszcze nie wpłacili. Zniknie, gdy oznaczysz sesje jako opłacone."
        />
      </div>

      <div className="grid-13" style={{ marginTop: 4 }}>
        <div className="card card--pad" data-reveal style={{ alignSelf: 'start' }}>
          <h2 className="card-title">Zespół · {fmtMonthYear(ym)}</h2>
          <div className="hbar" style={{ marginTop: 20 }}>
            {perPsych.map(({ p, collected: col, outstanding: out }) => (
              <div className="hbar__row hbar__row--labeled" key={p.id}>
                <span className="hbar__name">
                  <Avatar name={p.name} color={p.color} size={26} />
                  <span>{p.name.split(' ')[0]}</span>
                </span>
                <div>
                  <div className="hbar__track">
                    <BarFill
                      segments={[
                        { value: col, color: 'var(--sage)', label: 'zebrane' },
                        { value: out, color: 'var(--gold-mid)', label: 'zaległe' },
                      ]}
                      totalMax={maxPsych}
                    />
                  </div>
                  <div className="row row--between" style={{ marginTop: 5, fontSize: 12 }}>
                    <span className="muted">{fmtMoney(col)} zebrane</span>
                    {out > 0 && <span style={{ color: 'var(--gold-deep)', fontWeight: 650 }}>{fmtMoney(out)} zaległe</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="legend" style={{ marginTop: 18 }}>
            <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--sage)' }} /> Zebrane</span>
            <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--gold-mid)' }} /> Zaległe</span>
          </div>
        </div>

        <div className="card" data-reveal style={{ overflow: 'hidden' }}>
          <div className="row row--between" style={{ padding: '20px 24px 0' }}>
            <h2 className="card-title">Rozliczenia sesji</h2>
            <span className="faint" style={{ fontSize: 13 }}>
              {filtered.length} {sessionsWord(filtered.length)}
            </span>
          </div>
          <div className="table-scroll" style={{ marginTop: 8 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Klient</th>
                <th>Specjalistka</th>
                <th className="right">Kwota</th>
                <th className="right">Zapłacono</th>
                <th>Płatność</th>
                <th></th>
              </tr>
            </thead>
            <tbody ref={flipRef}>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      icon="payments"
                      title="Brak rozliczeń w tym miesiącu"
                      hint="Rozliczane są sesje odbyte i nieobecności — pojawią się tu po zakończeniu."
                    />
                  </td>
                </tr>
              )}
              {filtered.map((s) => {
                const p = psychOf(s.psychId)
                const out = outstandingOf(s)
                return (
                  <tr key={s.id} data-flip-id={s.id}>
                    <td style={{ fontWeight: 600 }}>{fmtShortDate(s.date)}</td>
                    <td>{clientOf(s.clientId)?.name}</td>
                    <td>
                      <span className="row" style={{ gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: p?.color, display: 'inline-block' }} />
                        <span className="muted">{p ? p.name.split(' ')[0] : '—'}</span>
                      </span>
                    </td>
                    <td className="right num-cell">{fmtMoney(s.amount)}</td>
                    <td className="right num-cell muted">{fmtMoney(collectedOf(s))}</td>
                    <td><PaymentPicker session={s} /></td>
                    <td className="right">
                      {out > 0 ? (
                        <Button variant="soft" size="sm" title="Oznacz pełną wpłatę za tę sesję" onClick={() => markPaid(s)}>Zaksięguj</Button>
                      ) : (
                        <Icon name="check" size={16} style={{ color: 'var(--sage-deep)' }} />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  )
}
