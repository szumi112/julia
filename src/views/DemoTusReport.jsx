import { useMemo } from 'react'
import { useApp } from '../store.jsx'
import { useMinuteNow } from '../clock.js'
import { BarFill } from '../charts.jsx'
import { kidsOfGroup, tusMonthSummary } from '../tus.js'
import { fmtMoney, fmtMonthYear, pad2, toISODate } from '../format.js'
import { kidsWord } from './Tus.jsx'

const PAID = 'var(--sage)'
const DUE = 'var(--amber-mid)'

export function DemoTusReport({ selectedPsychologist, ym }) {
  const { state } = useApp()
  const now = useMinuteNow()
  const nowIso = `${toISODate(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  const rows = useMemo(
    () => state.tusGroups
      .filter((group) => !selectedPsychologist || group.leaderIds.includes(selectedPsychologist.id))
      .map((group) => ({
        group,
        roster: kidsOfGroup(state.tusKids, group.id),
        summary: tusMonthSummary(
          group, state.tusClasses, state.tusKids, state.tusPayments, ym, nowIso,
        ),
      })),
    [nowIso, selectedPsychologist, state.tusClasses, state.tusGroups, state.tusKids, state.tusPayments, ym],
  )
  if (rows.length === 0) return null
  const kidCount = rows.reduce((total, row) => total + row.roster.length, 0)
  const due = rows.reduce((total, row) => total + row.summary.dueAmount, 0)

  return (
    <section className="card card--pad" data-reveal aria-label="Zajęcia grupowe TUS">
      <div className="row row--between">
        <h2 className="card-title">Zajęcia grupowe TUS · {fmtMonthYear(ym)}</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          {kidCount} {kidsWord(kidCount)} ·{' '}
          {due > 0
            ? <span className="collect__due">{fmtMoney(due)} do zapłaty</span>
            : <span className="collect__ok">opłaty rozliczone</span>}
        </span>
      </div>
      <div className="report-tus">
        {rows.map(({ group, roster, summary }) => (
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
  )
}
