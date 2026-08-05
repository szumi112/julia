// Monthly report — a dashboard you scan, not an essay you read: KPI squares,
// the collection bar, specialists ranked by what they billed, the six-month
// trend, and the TUS group classes. Group-class money keeps its own block:
// tus.js deliberately keeps it out of monthStats, so it never joins the
// session totals above it.
import { useEffect, useMemo, useState } from 'react'
import { useApp, useWorkspaceWindow, sessionsInMonth, monthStats, availableMonths, revenueSeries } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useRouteParamsSync } from '../ux-patterns.jsx'
import { useReveal } from '../anim.js'
import { useMinuteNow } from '../clock.js'
import { Avatar, Button, Chip, EmptyState, IconBtn, Stat } from '../ui.jsx'
import { AreaChart, Donut, BarFill } from '../charts.jsx'
import { kidsOfGroup, tusMonthSummary } from '../tus.js'
import { kidsWord } from './Tus.jsx'
import {
  fmtMoney, fmtNumber, monthKey, addMonths, fmtMonthYear, fmtMonthName, cap, pad2, toISODate,
  billableSummary, outstandingOf, sessionsWord,
} from '../format.js'
import { monthWorkspaceRange } from '../workspace-view.js'

// pl-PL decimals: "37,5 h" — one fraction digit max, integers stay clean
const fmtHours = (value) => `${new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 }).format(value)} h`
const fmtRoundedNumber = (value) => fmtNumber(Math.round(value))
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

// Both money bars split the same way, so they get the same two colours and the
// same legend wording everywhere on the page.
const PAID = 'var(--sage)'
const DUE = 'var(--amber-mid)'
const splitSegments = (paid, due) => [
  { value: paid, color: PAID, label: 'wpłacono' },
  { value: due, color: DUE, label: 'pozostało do zapłaty' },
]

function SplitLegend({ paidLabel = 'Wpłacono', dueLabel = 'Pozostało do zapłaty' }) {
  return (
    <div className="legend" style={{ marginTop: 16 }}>
      <span className="legend__item"><span className="legend__swatch" style={{ background: PAID }} /> {paidLabel}</span>
      <span className="legend__item"><span className="legend__swatch" style={{ background: DUE }} /> {dueLabel}</span>
    </div>
  )
}

export function Reports({ params = {} }) {
  const { state, toast } = useApp()
  const { appMode, getViewState, patchViewState } = useShell()
  const isApp = appMode === 'app'
  const currentYm = monthKey(new Date())
  const [initialViewState] = useState(() => {
    const saved = getViewState('reports', { ym: currentYm, specialist: null })
    return {
      // URL params win over the registry — a shared link must reproduce its scope
      ym: /^\d{4}-\d{2}$/.test(params.ym || '') && params.ym <= currentYm
        ? params.ym
        : typeof saved.ym === 'string' && /^\d{4}-\d{2}$/.test(saved.ym) && saved.ym <= currentYm
          ? saved.ym
          : currentYm,
      specialist: state.psychologists.some((psychologist) => psychologist.id === params.specialist)
        ? params.specialist
        : state.psychologists.some((psychologist) => psychologist.id === saved.specialist)
          ? saved.specialist
          : null,
    }
  })
  const [ym, setYm] = useState(initialViewState.ym)
  const [psychFilter, setPsychFilter] = useState(initialViewState.specialist)
  const workspaceRange = useMemo(() => monthWorkspaceRange(ym), [ym])
  const workspaceState = useWorkspaceWindow(workspaceRange, isApp)
  const ref = useReveal([ym, psychFilter])
  const now = useMinuteNow()
  const nowIso = `${toISODate(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`

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
  // ranked by what each billed, so the longest bar is the first one read
  const ranked = useMemo(() => [...perPsych].sort((a, b) => b.revenue - a.revenue), [perPsych])
  const maxDue = Math.max(...perPsych.map((item) => item.revenue), 1)
  const avg = stats.billable > 0 ? stats.revenue / stats.billable : 0
  const unpaidCount = useMemo(
    () => monthList.filter((session) => outstandingOf(session) > 0).length,
    [monthList]
  )
  const donutParts = useMemo(
    () => perPsych.map(({ p, revenue }) => ({ value: revenue, color: p.color, label: p.name })),
    [perPsych]
  )
  const trendMonths = useMemo(() => Array.from({ length: 6 }, (_, i) => addMonths(ym, i - 5)), [ym])
  const series = useMemo(() => revenueSeries(scopedSessions, trendMonths), [scopedSessions, trendMonths])

  // Group classes are led by one or two specialists, so the chip scopes them too.
  const tusRows = useMemo(
    () => state.tusGroups
      .filter((group) => !selectedPsychologist || group.leaderIds.includes(selectedPsychologist.id))
      .map((group) => ({
        group,
        roster: kidsOfGroup(state.tusKids, group.id),
        summary: tusMonthSummary(group, state.tusClasses, state.tusKids, state.tusPayments, ym, nowIso),
      })),
    [nowIso, selectedPsychologist, state.tusClasses, state.tusGroups, state.tusKids, state.tusPayments, ym]
  )
  const tusKidCount = tusRows.reduce((total, row) => total + row.roster.length, 0)
  const tusDue = tusRows.reduce((total, row) => total + row.summary.dueAmount, 0)

  useEffect(() => {
    patchViewState('reports', {
      ym,
      specialist: selectedPsychologist?.id || null,
    })
  }, [patchViewState, selectedPsychologist, ym])

  // month and scope live in the URL, so a report view can be shared
  useRouteParamsSync('reports', {
    ym: ym !== currentYm ? ym : undefined,
    specialist: psychFilter || undefined,
  })

  if (isApp && workspaceState !== 'ready') {
    return (
      <section role="status" aria-label="Stan raportu">
        <EmptyState
          icon="reports"
          title={workspaceState === 'loading' ? 'Wczytywanie raportu…' : 'Raport jest teraz niedostępny'}
          hint={workspaceState === 'loading'
            ? 'Pobieramy kompletny wybrany miesiąc.'
            : 'Nie pokazujemy podsumowania dla niepełnego okresu.'}
        />
      </section>
    )
  }

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Podsumowanie miesiąca</div>
          <h1 className="display view-head__title">Raport miesięczny — <em>{fmtMonthYear(ym)}</em></h1>
          <p className="view-head__sub">
            {selectedPsychologist ? `Zakres: ${selectedPsychologist.name}.` : 'Zakres: cały zespół.'}
          </p>
        </div>
        <div className="view-head__actions no-print">
          {ym !== maxYm && (
            <Button variant="ghost" size="sm" onClick={() => setYm(maxYm)}>
              Bieżący miesiąc
            </Button>
          )}
          <div className="month-nav">
            <IconBtn name="chevL" label="Poprzedni miesiąc" disabled={!isApp && ym <= minYm} onClick={() => setYm(addMonths(ym, -1))} />
            <span className="month-nav__label">{fmtMonthYear(ym)}</span>
            <IconBtn name="chevR" label="Następny miesiąc" disabled={ym >= maxYm} onClick={() => setYm(addMonths(ym, 1))} />
          </div>
          {!isApp && <>
            <Button variant="ghost" icon="print" onClick={() => window.print()}>Drukuj</Button>
            <Button icon="download" magnetic onClick={() => toast('Raport PDF wyeksportowany (demo)')}>
              Eksport (demo)
            </Button>
          </>}
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

      <section aria-label="Treść raportu">
        <p className="print-only faint" style={{ margin: '0 0 14px', fontSize: 13 }}>
          {state.center.name} · {state.center.address}
        </p>

        <div className="stats-row stats-row--3" role="group" aria-label={`${scopeName} — ${fmtMonthYear(ym)}`}>
          <Stat
            label="Należne"
            value={stats.revenue}
            fmt={fmtMoney}
            sub={`z ${stats.billable} rozliczonych sesji`}
          />
          <Stat
            label="Wpłacono"
            value={stats.collected}
            fmt={fmtMoney}
            sub={`${share(stats.collected, stats.revenue)}% należności`}
          />
          <Stat
            label="Pozostało do zapłaty"
            value={stats.outstanding}
            fmt={fmtMoney}
            tone={stats.outstanding > 0 ? 'amber' : undefined}
            sub={`z ${unpaidCount} sesji`}
          />
          <Stat label="Godziny terapii" value={stats.hours} fmt={fmtHours} />
          <Stat label="Sesje odbyte" value={stats.completed} fmt={fmtRoundedNumber} />
          <Stat label="Średnia za sesję" value={avg} fmt={fmtMoney} />
        </div>

        <div className="stack">
          {stats.revenue > 0 && (
            <section className="card card--pad" data-reveal aria-label="Rozliczenie miesiąca">
              <div className="row row--between">
                <h2 className="card-title">Rozliczenie miesiąca</h2>
                <span className="hbar__val">{share(stats.collected, stats.revenue)}% wpłacone</span>
              </div>
              <div className="hbar__track" style={{ marginTop: 16 }}>
                <BarFill segments={splitSegments(stats.collected, stats.outstanding)} totalMax={stats.revenue} />
              </div>
              <SplitLegend
                paidLabel={`Wpłacono ${fmtMoney(stats.collected)}`}
                dueLabel={`Pozostało ${fmtMoney(stats.outstanding)}`}
              />
            </section>
          )}

          <div className="grid-31">
            <div className="card card--pad" data-reveal>
              <h2 className="card-title">{selectedPsychologist ? 'Specjalistka' : 'Specjalistki'} · {fmtMonthYear(ym)}</h2>
              <div className="hbar report-psych" style={{ marginTop: 20 }} role="group" aria-label="Porównanie specjalistek">
                {ranked.map(({ p, sessions, hours, revenue, collected, outstanding }) => (
                  <div className="hbar__row report-psych__row" key={p.id} data-specialist-id={p.id}>
                    <span className="hbar__name">
                      <Avatar name={p.name} color={p.color} size={26} />
                      <span className="report-psych__name">{p.name}</span>
                    </span>
                    <div className="report-psych__bar">
                      <div className="hbar__track" style={{ height: 18 }}>
                        <BarFill segments={splitSegments(collected, outstanding)} totalMax={maxDue} />
                      </div>
                      <div className="row row--between report-psych__meta">
                        <span className="muted">{sessions} {sessionsWord(sessions)} · {fmtHours(hours)}</span>
                        {outstanding > 0
                          ? <span className="collect__due">{fmtMoney(outstanding)} do zapłaty</span>
                          : <span className="collect__ok">rozliczone</span>}
                      </div>
                    </div>
                    <span className="hbar__val">{fmtMoney(revenue)}</span>
                  </div>
                ))}
              </div>
              <SplitLegend />
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
                {ranked.map(({ p, revenue }) => (
                  <div className="row row--between" key={p.id} style={{ fontSize: 13.5 }}>
                    <span className="row" style={{ gap: 8 }}>
                      <span className="legend__swatch" style={{ background: p.color }} />
                      {p.name}
                    </span>
                    <span style={{ fontWeight: 650 }}>{share(revenue, stats.revenue)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {!isApp && (
            <div className="card card--pad" data-reveal>
              <h2 className="card-title">Przychód · ostatnie 6 miesięcy</h2>
              <div style={{ marginTop: 12 }}>
                <AreaChart data={series} height={200} label={`Przychód — ${scopeName}`} />
              </div>
            </div>
          )}

          {!isApp && tusRows.length > 0 && (
            <section className="card card--pad" data-reveal aria-label="Zajęcia grupowe TUS">
              <div className="row row--between">
                <h2 className="card-title">Zajęcia grupowe TUS · {fmtMonthYear(ym)}</h2>
                <span className="muted" style={{ fontSize: 13 }}>
                  {tusKidCount} {kidsWord(tusKidCount)} ·{' '}
                  {tusDue > 0
                    ? <span className="collect__due">{fmtMoney(tusDue)} do zapłaty</span>
                    : <span className="collect__ok">opłaty rozliczone</span>}
                </span>
              </div>
              <div className="report-tus">
                {tusRows.map(({ group, roster, summary }) => (
                  <article className="report-tus__group" key={group.id} data-group-id={group.id}>
                    <div className="row row--between">
                      <h3 className="report-tus__name">{group.name}</h3>
                      <span className="report-tus__rate">
                        {summary.attendanceRate == null ? '—' : `${summary.attendanceRate}%`}
                        <small>frekwencja</small>
                      </span>
                    </div>
                    <div className="gcard__stats">
                      <span>zajęcia · <b>{summary.heldCount}/{summary.classCount}</b></span>
                      <span>dzieci · <b>{roster.length}</b></span>
                    </div>
                    <div className="hbar__track" style={{ height: 14 }}>
                      <BarFill
                        segments={[
                          { value: summary.paidCount, color: PAID, label: 'opłacone' },
                          { value: summary.dueCount, color: DUE, label: 'do opłacenia' },
                        ]}
                        totalMax={Math.max(roster.length, 1)}
                      />
                    </div>
                    <div className="row row--between collect__labels">
                      <span className="muted">opłacone {summary.paidCount}/{roster.length}</span>
                      {summary.dueCount > 0
                        ? <span className="collect__due">{fmtMoney(summary.dueAmount)} do zapłaty</span>
                        : <span className="collect__ok">wszystko opłacone</span>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </section>
    </div>
  )
}
