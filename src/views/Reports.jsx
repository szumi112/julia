// Monthly report — Aurelia's editorial data story: the month opens as two
// written sentences with its figures set inline, then the operational table.
import { useEffect, useMemo, useState } from 'react'
import { useApp, sessionsInMonth, monthStats, availableMonths } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { Avatar, Button, Chip, IconBtn, Figure } from '../ui.jsx'
import { Donut, BarFill } from '../charts.jsx'
import {
  fmtMoney, fmtNumber, monthKey, addMonths, fmtMonthYear, fmtMonthLocative, fmtMonthName, cap,
  billableSummary, plural,
} from '../format.js'

const hoursWord = (h) => plural(h, 'godzina', 'godziny', 'godzin')
const fmtHours = (value) => `${fmtNumber(Math.round(value))} h`
const fmtRoundedNumber = (value) => fmtNumber(Math.round(value))

// The written lead stays on the exact same scope and billing rules as every
// number below it: completed and no-show sessions accrue an amount due, while
// the cash figure only includes payments already received.
function ReportLead({ ym, stats, scopeName, avg }) {
  const inMonth = `W ${fmtMonthLocative(ym)}`
  const h = Math.round(stats.hours)
  if (stats.count === 0) {
    return (
      <p className="report-lead__text">
        {inMonth} {scopeName ? <em>{scopeName}</em> : 'centrum'} nie {scopeName ? 'przeprowadziła' : 'przeprowadziło'} żadnych sesji.
        {' '}Gdy pojawią się pierwsze spotkania, ten raport opowie ich historię.
      </p>
    )
  }
  return (
    <p className="report-lead__text">
      {inMonth} {scopeName ? <em>{scopeName}</em> : 'zespół'} {scopeName ? 'przeprowadziła' : 'przeprowadził'}{' '}
      {/* accusative after "przeprowadzić": 1 sesję / 2 sesje / 5 sesji */}
      <em>{stats.completed} {plural(stats.completed, 'sesję', 'sesje', 'sesji')}</em> — <em>{h} {hoursWord(h)}</em> rozmów.
      {' '}Należne za rozliczone sesje: <em>{fmtMoney(stats.revenue)}</em>; wpłacono dotąd{' '}
      <em>{fmtMoney(stats.collected)}</em>, a <em>{fmtMoney(stats.outstanding)}</em> pozostało do zapłaty.
      {stats.billable > 0 && <> Średnia należność za rozliczoną sesję to <em>{fmtMoney(avg)}</em>.</>}
    </p>
  )
}

export function Reports() {
  const { state, toast } = useApp()
  const { getViewState, patchViewState } = useShell()
  const currentYm = monthKey(new Date())
  const [initialViewState] = useState(() => {
    const saved = getViewState('reports', { ym: currentYm, specialist: null })
    return {
      ym: typeof saved.ym === 'string' && /^\d{4}-\d{2}$/.test(saved.ym) && saved.ym <= currentYm
        ? saved.ym
        : currentYm,
      specialist: state.psychologists.some((psychologist) => psychologist.id === saved.specialist)
        ? saved.specialist
        : null,
    }
  })
  const [ym, setYm] = useState(initialViewState.ym)
  const [psychFilter, setPsychFilter] = useState(initialViewState.specialist)
  const ref = useReveal([ym, psychFilter])

  const months = useMemo(() => availableMonths(state.sessions), [state.sessions])
  const maxYm = currentYm // no reports for future months
  const minYm = months[0] || maxYm
  const psychologists = useMemo(
    () => [...state.psychologists].sort((a, b) => a.name.localeCompare(b.name, 'pl')),
    [state.psychologists]
  )
  const selectedPsychologist = psychologists.find((psychologist) => psychologist.id === psychFilter) || null
  const scopeName = selectedPsychologist?.name || 'Cały zespół'
  const scopedPsychologists = useMemo(
    () => selectedPsychologist ? [selectedPsychologist] : psychologists,
    [psychologists, selectedPsychologist]
  )
  const scopedSessions = useMemo(
    () => selectedPsychologist
      ? state.sessions.filter((session) => session.psychId === selectedPsychologist.id)
      : state.sessions,
    [selectedPsychologist, state.sessions]
  )
  const stats = useMemo(() => monthStats(scopedSessions, ym), [scopedSessions, ym])
  const monthList = useMemo(() => sessionsInMonth(scopedSessions, ym), [scopedSessions, ym])
  const perPsych = useMemo(() => scopedPsychologists.map((psychologist) => {
    const own = monthList.filter((session) => session.psychId === psychologist.id)
    const completed = own.filter((session) => session.status === 'completed')
    return {
      p: psychologist,
      sessions: completed.length,
      hours: completed.reduce((total, session) => total + session.duration, 0) / 60,
      ...billableSummary(own),
    }
  }), [monthList, scopedPsychologists])
  const maxDue = Math.max(...perPsych.map((item) => item.revenue), 1)
  const avg = stats.billable > 0 ? stats.revenue / stats.billable : 0
  const donutParts = useMemo(
    () => perPsych.map(({ p, revenue }) => ({ value: revenue, color: p.color, label: p.name })),
    [perPsych]
  )

  useEffect(() => {
    patchViewState('reports', {
      ym,
      specialist: selectedPsychologist?.id || null,
    })
  }, [patchViewState, selectedPsychologist, ym])

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Podsumowanie miesiąca</div>
          <h1 className="display view-head__title">Raport miesięczny — <em>{fmtMonthYear(ym)}</em></h1>
          <p className="view-head__sub">
            {selectedPsychologist
              ? `Godziny i należności w tym raporcie obejmują wyłącznie: ${selectedPsychologist.name}.`
              : 'Godziny i należności w podziale na specjalistki oraz dla całego centrum. To, co dawniej liczył Excel.'}
          </p>
        </div>
        <div className="view-head__actions no-print">
          {ym !== maxYm && (
            <Button variant="ghost" size="sm" onClick={() => setYm(maxYm)}>
              Bieżący miesiąc
            </Button>
          )}
          <div className="month-nav">
            <IconBtn name="chevL" label="Poprzedni miesiąc" disabled={ym <= minYm} onClick={() => setYm(addMonths(ym, -1))} />
            <span className="month-nav__label">{fmtMonthYear(ym)}</span>
            <IconBtn name="chevR" label="Następny miesiąc" disabled={ym >= maxYm} onClick={() => setYm(addMonths(ym, 1))} />
          </div>
          <Button variant="ghost" icon="print" onClick={() => window.print()}>Drukuj</Button>
          <Button icon="download" magnetic onClick={() => toast('Raport PDF wyeksportowany (demo)')}>
            Eksport (demo)
          </Button>
        </div>
      </div>

      <div className="row chips-row no-print" data-reveal role="group" aria-label="Specjalistka raportu">
        <Chip on={!selectedPsychologist} onClick={() => setPsychFilter(null)}>Cały zespół</Chip>
        {psychologists.map((psychologist) => (
          <Chip
            key={psychologist.id}
            on={selectedPsychologist?.id === psychologist.id}
            swatch={psychologist.color}
            aria-label={psychologist.name}
            onClick={() => setPsychFilter(selectedPsychologist?.id === psychologist.id ? null : psychologist.id)}
          >
            {psychologist.name.split(' ')[0]}
          </Chip>
        ))}
      </div>

      <p className="eyebrow report-scope" data-reveal>Zakres raportu: {scopeName}</p>

      <section aria-label="Treść raportu">
        <p className="print-only faint" style={{ margin: '0 0 14px', fontSize: 13 }}>
          {state.center.name} · {state.center.address}
        </p>

        <section className="report-lead" data-reveal>
          <ReportLead
            ym={ym}
            stats={stats}
            avg={avg}
            scopeName={selectedPsychologist?.name || null}
          />
        </section>

        <div className="figures" data-reveal role="group" aria-label={`${scopeName} — ${fmtMonthYear(ym)}`}>
          <Figure label="Należne za rozliczone sesje" value={stats.revenue} fmt={fmtMoney} />
          <Figure label="Wpłacono" value={stats.collected} fmt={fmtMoney} />
          <Figure label="Pozostało do zapłaty" value={stats.outstanding} fmt={fmtMoney} gold={stats.outstanding > 0} />
          <Figure label="Godziny terapii" value={stats.hours} fmt={fmtHours} />
          <Figure label="Sesje odbyte" value={stats.completed} fmt={fmtRoundedNumber} />
          <Figure label="Średnia należność za rozliczoną sesję" value={avg} fmt={fmtMoney} />
        </div>

        <div className="grid-31" style={{ marginTop: 20 }}>
          <div className="card card--pad" data-reveal>
            <h2 className="card-title">{selectedPsychologist ? 'Specjalistka' : 'Specjalistki'} · {fmtMonthYear(ym)}</h2>
            <div className="table-scroll" style={{ marginTop: 12 }}>
              <table className="table report-comparison-table" aria-label="Porównanie specjalistek">
                <thead>
                  <tr>
                    <th>Specjalistka</th>
                    <th className="right">Sesje odbyte</th>
                    <th className="right">Godziny</th>
                    <th className="right">Należne za rozliczone sesje</th>
                    <th className="right">Wpłacono</th>
                    <th className="right">Pozostało do zapłaty</th>
                    <th style={{ width: '22%' }}><span className="sr-only">Udział należności</span></th>
                  </tr>
                </thead>
                <tbody>
                  {perPsych.map(({ p, sessions, hours, revenue, collected, outstanding }) => (
                    <tr key={p.id} data-specialist-id={p.id}>
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
                          <BarFill segments={[{ value: revenue, color: p.color }]} totalMax={maxDue} />
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!selectedPsychologist && (
                    <tr className="table__total">
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
                  )}
                </tbody>
              </table>
            </div>

            <section className="report-summary-cards" aria-label="Podsumowania specjalistek">
              {perPsych.map(({ p, sessions, hours, revenue, collected, outstanding }) => (
                <article className="report-summary-card" key={p.id} data-specialist-id={p.id}>
                  <header className="report-summary-card__head">
                    <Avatar name={p.name} color={p.color} size={30} />
                    <h3>{p.name}</h3>
                  </header>
                  <dl className="report-summary-card__metrics">
                    <div><dt>Sesje odbyte</dt><dd>{sessions}</dd></div>
                    <div><dt>Godziny</dt><dd>{Math.round(hours * 10) / 10} h</dd></div>
                    <div><dt>Należne za rozliczone sesje</dt><dd>{fmtMoney(revenue)}</dd></div>
                    <div><dt>Wpłacono</dt><dd>{fmtMoney(collected)}</dd></div>
                    <div><dt>Pozostało do zapłaty</dt><dd>{outstanding > 0 ? fmtMoney(outstanding) : '—'}</dd></div>
                  </dl>
                </article>
              ))}
            </section>
          </div>

          <div className="card card--pad" data-reveal style={{ alignSelf: 'start', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <h2 className="card-title" style={{ alignSelf: 'stretch' }}>Struktura należności</h2>
            <div style={{ marginTop: 18 }}>
              <Donut
                parts={donutParts}
                centerTop={fmtMoney(stats.revenue)}
                centerBottom={cap(fmtMonthName(ym))}
                label={`Struktura należności — ${scopeName}`}
              />
            </div>
            <div className="stack" style={{ gap: 10, marginTop: 22, alignSelf: 'stretch' }}>
              {perPsych.map(({ p, revenue }) => (
                <div className="row row--between" key={p.id} style={{ fontSize: 13.5 }}>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="legend__swatch" style={{ background: p.color }} />
                    {p.name}
                  </span>
                  <span style={{ fontWeight: 650 }}>
                    {stats.revenue > 0 ? Math.round((revenue / stats.revenue) * 100) : 0}%
                  </span>
                </div>
              ))}
            </div>
            <p className="faint" style={{ fontSize: 12.5, marginTop: 20, alignSelf: 'stretch' }}>
              {cap(fmtMonthYear(ym))}: {stats.completed}{' '}
              {plural(stats.completed, 'sesja terapeutyczna odbyta', 'sesje terapeutyczne odbyte', 'sesji terapeutycznych odbytych')}
              {selectedPsychologist ? ` — ${selectedPsychologist.name}.` : ' w centrum.'}
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
