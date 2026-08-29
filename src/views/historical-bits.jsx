import { fmtFullDate, fmtMonthYear, plural } from '../format.js'
import { EntityLink } from '../ux-patterns.jsx'
import { Button } from '../ui.jsx'

export function HistoricalOccurrenceRow({ row, date = null }) {
  const subject = row.historicalClientId ? (
    <EntityLink
      route="client"
      params={row.month
        ? { id: row.historicalClientId, ym: row.month }
        : { id: row.historicalClientId, historyPeriod: 'unknown' }}
      label={`Otwórz klienta historycznego — ${row.subjectName}`}
      className="historical-row__subject"
    >
      {row.subjectName}
    </EntityLink>
  ) : <span className="historical-row__subject">{row.subjectName}</span>

  return (
    <div
      className="agenda__row historical-row"
      aria-label={`${row.subjectName}${date ? `, ${fmtFullDate(date)}` : ''}, ${row.periodLabel.toLowerCase()}, ${row.serviceLabel}`}
    >
      <span className="agenda__time historical-row__period">{row.periodLabel}</span>
      <span className="agenda__main">
        <span className="agenda__client">{subject}</span>
        <span className="agenda__meta">{row.serviceLabel} · {row.specialistName}</span>
      </span>
    </div>
  )
}

export function HistoricalMonthSection({ rows, ym }) {
  if (rows.length === 0) return null
  return (
    <section className="card card--pad historical-section" aria-labelledby="historical-month-heading">
      <h2 id="historical-month-heading" className="card-title">
        Wpisy z nieustalonym dniem · {fmtMonthYear(ym)}
        <span className="faint">{rows.length}</span>
      </h2>
      <div className="historical-list">
        {rows.map((row) => <HistoricalOccurrenceRow key={row.id} row={row} />)}
      </div>
    </section>
  )
}

export function HistoricalUnknownSummary({ count, routeParams }) {
  if (count === 0) return null
  return (
    <section className="card card--pad historical-section historical-review-summary" aria-label="Wpisy z nieustalonym okresem">
      <div>
        <h2 className="card-title">Okres do sprawdzenia</h2>
        <p className="faint">
          {count} {plural(count, 'wpis wymaga', 'wpisy wymagają', 'wpisów wymaga')} ustalenia okresu.
        </p>
      </div>
      <EntityLink
        route="calendar"
        params={{ ...routeParams, review: 'unknown' }}
        className="btn btn--soft btn--sm"
        label={`Przejrzyj ${count} wpisów z nieustalonym okresem`}
      >
        Przejrzyj okres
      </EntityLink>
    </section>
  )
}

export function HistoricalUnknownReview({ rows, onClose }) {
  return (
    <section className="card card--pad historical-section" aria-labelledby="historical-unknown-heading">
      <div className="row row--between historical-section__head">
        <h2 id="historical-unknown-heading" className="card-title">Okres nieustalony</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>Zamknij przegląd</Button>
      </div>
      {rows.length > 0 ? (
        <div className="historical-list">
          {rows.map((row) => <HistoricalOccurrenceRow key={row.id} row={row} />)}
        </div>
      ) : <p className="faint">Brak wpisów z nieustalonym okresem w tym zakresie.</p>}
    </section>
  )
}
