// Monthly report — the hero view replacing the Excel sheet.
import { useMemo, useState } from 'react'
import { useApp, sessionsInMonth, monthStats, availableMonths } from '../store.jsx'
import { useReveal, useCountUp } from '../anim.js'
import { Avatar, Button, IconBtn } from '../ui.jsx'
import { Donut, BarFill } from '../charts.jsx'
import {
  fmtMoney, fmtNumber, monthKey, addMonths, fmtMonthYear, fmtMonthName, cap,
  isBillable, collectedOf, plural,
} from '../format.js'

function BigNum({ label, value, fmt }) {
  const ref = useCountUp(value, fmt)
  return (
    <div className="report-bignum__item">
      <span>{label}</span>
      <b><span ref={ref}>0</span></b>
    </div>
  )
}

export function Reports() {
  const { state, toast } = useApp()
  const [ym, setYm] = useState(monthKey(new Date()))
  const ref = useReveal([ym])

  const months = useMemo(() => availableMonths(state.sessions), [state.sessions])
  const maxYm = monthKey(new Date()) // no reports for future months
  const stats = useMemo(() => monthStats(state.sessions, ym), [state.sessions, ym])
  const monthList = useMemo(() => sessionsInMonth(state.sessions, ym), [state.sessions, ym])

  const perPsych = state.psychologists.map((p) => {
    const own = monthList.filter((s) => s.psychId === p.id)
    const billed = own.filter(isBillable)
    const completed = own.filter((s) => s.status === 'completed')
    const revenue = billed.reduce((a, s) => a + s.amount, 0)
    const collected = billed.reduce((a, s) => a + collectedOf(s), 0)
    return {
      p,
      sessions: completed.length,
      hours: completed.reduce((a, s) => a + s.duration, 0) / 60,
      revenue,
      collected,
      outstanding: revenue - collected,
    }
  })
  const maxRev = Math.max(...perPsych.map((x) => x.revenue), 1)
  const avg = stats.completed > 0 ? stats.revenue / Math.max(stats.completed, 1) : 0

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Podsumowanie miesiąca</div>
          <h1 className="display view-head__title">Raport — <em>{fmtMonthYear(ym)}</em></h1>
          <p className="view-head__sub">
            Godziny i przychody w podziale na specjalistki oraz dla całego centrum. To, co dawniej liczył Excel.
          </p>
        </div>
        <div className="view-head__actions no-print">
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
          <Button variant="ghost" icon="print" onClick={() => window.print()}>Drukuj</Button>
          <Button icon="download" magnetic onClick={() => toast('Raport PDF wyeksportowany (demo)')}>
            Eksport
          </Button>
        </div>
      </div>

      <section className="report-hero" data-reveal>
        <div className="report-hero__month" aria-hidden="true">{fmtMonthName(ym)}</div>
        <div className="report-bignum">
          <BigNum label="Przychód centrum" value={stats.revenue} fmt={fmtMoney} />
          <BigNum label="Zebrane" value={stats.collected} fmt={fmtMoney} />
          <BigNum label="Godziny terapii" value={stats.hours} fmt={(v) => `${fmtNumber(Math.round(v))} h`} />
          <BigNum label="Sesje odbyte" value={stats.completed} fmt={(v) => fmtNumber(Math.round(v))} />
          <BigNum label="Średnio / sesję" value={avg} fmt={fmtMoney} />
        </div>
      </section>

      <div className="grid-31" style={{ marginTop: 20 }}>
        <div className="card card--pad" data-reveal>
          <h2 className="card-title">Zespół — {fmtMonthYear(ym)}</h2>
          <table className="table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Specjalistka</th>
                <th className="right">Sesje</th>
                <th className="right">Godziny</th>
                <th className="right">Przychód</th>
                <th className="right">Zebrane</th>
                <th className="right">Zaległe</th>
                <th style={{ width: '22%' }}></th>
              </tr>
            </thead>
            <tbody>
              {perPsych.map(({ p, sessions, hours, revenue, collected, outstanding }) => (
                <tr key={p.id}>
                  <td>
                    <span className="row" style={{ gap: 10 }}>
                      <Avatar name={p.name} color={p.color} size={30} />
                      <span style={{ fontWeight: 650 }}>{p.name}</span>
                    </span>
                  </td>
                  <td className="right num-cell">{sessions}</td>
                  <td className="right num-cell">{Math.round(hours * 10) / 10} h</td>
                  <td className="right num-cell">{fmtMoney(revenue)}</td>
                  <td className="right num-cell" style={{ color: 'var(--sage-deep)' }}>{fmtMoney(collected)}</td>
                  <td className="right num-cell" style={{ color: outstanding > 0 ? 'var(--gold-deep)' : 'var(--ink-faint)' }}>
                    {outstanding > 0 ? fmtMoney(outstanding) : '—'}
                  </td>
                  <td>
                    <div className="hbar__track" style={{ height: 14 }}>
                      <BarFill segments={[{ value: revenue, color: p.color }]} totalMax={maxRev} />
                    </div>
                  </td>
                </tr>
              ))}
              <tr style={{ background: 'var(--surface-warm)' }}>
                <td style={{ fontWeight: 700, fontFamily: 'var(--font-display)' }}>Całe centrum</td>
                <td className="right num-cell" style={{ fontWeight: 700 }}>{stats.completed}</td>
                <td className="right num-cell" style={{ fontWeight: 700 }}>{Math.round(stats.hours * 10) / 10} h</td>
                <td className="right num-cell" style={{ fontWeight: 700 }}>{fmtMoney(stats.revenue)}</td>
                <td className="right num-cell" style={{ fontWeight: 700, color: 'var(--sage-deep)' }}>{fmtMoney(stats.collected)}</td>
                <td className="right num-cell" style={{ fontWeight: 700, color: 'var(--gold-deep)' }}>
                  {stats.outstanding > 0 ? fmtMoney(stats.outstanding) : '—'}
                </td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card card--pad" data-reveal style={{ alignSelf: 'start', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <h2 className="card-title" style={{ alignSelf: 'stretch' }}>Udział w przychodzie</h2>
          <div style={{ marginTop: 18 }}>
            <Donut
              parts={perPsych.map(({ p, revenue }) => ({ value: revenue, color: p.color, label: p.name }))}
              centerTop={fmtMoney(stats.revenue)}
              centerBottom={cap(fmtMonthName(ym))}
            />
          </div>
          <div className="stack" style={{ gap: 10, marginTop: 22, alignSelf: 'stretch' }}>
            {perPsych.map(({ p, revenue }) => (
              <div className="row row--between" key={p.id} style={{ fontSize: 13.5 }}>
                <span className="row" style={{ gap: 8 }}>
                  <span className="legend__swatch" style={{ background: p.color }} />
                  {p.name.split(' ')[0]}
                </span>
                <span style={{ fontWeight: 650 }}>
                  {stats.revenue > 0 ? Math.round((revenue / stats.revenue) * 100) : 0}%
                </span>
              </div>
            ))}
          </div>
          <p className="faint" style={{ fontSize: 12.5, marginTop: 20, alignSelf: 'stretch' }}>
            {cap(fmtMonthYear(ym))}: {stats.completed}{' '}
            {plural(stats.completed, 'sesja terapeutyczna odbyta', 'sesje terapeutyczne odbyte', 'sesji terapeutycznych odbytych')} w centrum.
          </p>
        </div>
      </div>
    </div>
  )
}
