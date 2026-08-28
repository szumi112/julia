import { Button, EmptyState, Figure, IconBtn, Pill } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { addMonths, fmtMonthYear, fmtMoney, METHOD_LABELS } from '../format.js'
import { routeHref } from '../routing.js'

const SETTLEMENT_LABELS = Object.freeze({
  paid: 'Opłacona', partial: 'Częściowo opłacona', unpaid: 'Nieopłacona', unknown: 'Status nieznany',
})

export const activityMoney = (grosze) => grosze === null ? '—' : fmtMoney(grosze / 100)

export function ActivityLoadState({ state }) {
  if (state === 'ready') return null
  return (
    <section role="status" aria-label="Stan danych zajęć">
      <EmptyState
        icon="group"
        title={state === 'loading' ? 'Wczytywanie danych…' : 'Dane są teraz niedostępne'}
        hint={state === 'loading'
          ? 'Pobieramy kompletny wybrany miesiąc.'
          : 'Nie pokazujemy ani nie edytujemy niepełnych danych.'}
      />
    </section>
  )
}

export function ActivityMonthNav({ currentMonth, month, onChange }) {
  return (
    <div className="activity-month-controls">
      {month !== currentMonth && (
        <Button variant="ghost" size="sm" onClick={() => onChange(currentMonth)}>Bieżący miesiąc</Button>
      )}
      <div className="month-nav">
        <IconBtn name="chevL" label="Poprzedni miesiąc" onClick={() => onChange(addMonths(month, -1))} />
        <time className="month-nav__label" dateTime={month}>{fmtMonthYear(month)}</time>
        <IconBtn
          name="chevR"
          label="Następny miesiąc"
          disabled={month >= currentMonth}
          onClick={() => onChange(addMonths(month, 1))}
        />
        {month >= currentMonth && (
          <span className="sr-only">Nie można przejść do przyszłego miesiąca.</span>
        )}
      </div>
    </div>
  )
}

export function ActivityLatestLink({ latestMonth, month, route, params = {} }) {
  if (!latestMonth || latestMonth === month) return null
  return (
    <a className="link activity-latest" href={routeHref(route, { ...params, ym: latestMonth })}>
      Przejdź do ostatniego miesiąca z danymi — {fmtMonthYear(latestMonth)}
    </a>
  )
}

export function ActivityFigures({ summary, english = false }) {
  return (
    <div className="figures activity-figures" role="group" aria-label="Podsumowanie miesiąca">
      <Figure label="Uczestnicy" value={summary.participantCount} />
      {english && <Figure label="Liczba lekcji" value={summary.lessonCount} />}
      <Figure label="Kwota" value={summary.amountGrosze / 100} fmt={fmtMoney} />
      <Figure label="Wpłacono" value={summary.paidAmountGrosze / 100} fmt={fmtMoney} />
      <Figure
        label="Pozostało do zapłaty"
        value={summary.outstandingAmountGrosze / 100}
        fmt={fmtMoney}
        attention={summary.outstandingAmountGrosze > 0}
      />
      {!english && <Figure label="Zapisane zajęcia" value={summary.classCount} />}
    </div>
  )
}

export function ActivityChargeTable({ rows, english = false, titleId }) {
  return (
    <div className="table-scroll activity-table-scroll">
      <table className="table activity-table" aria-labelledby={titleId}>
        <thead>
          <tr>
            <th>Uczestnik</th>
            <th>Grupa / program</th>
            {english && <th className="right">Liczba lekcji</th>}
            <th className="right">Kwota</th>
            <th>Płatność</th>
            <th>Forma</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.participant.name}</strong></td>
              <td>{row.groupLabel}</td>
              {english && <td className="right num-cell">{row.lessonCount}</td>}
              <td className="right num-cell">{activityMoney(row.amountGrosze)}</td>
              <td>
                <Pill tone={row.settlementStatus === 'paid' ? 'sage' : row.settlementStatus === 'partial' ? 'amber' : 'error'}>
                  {SETTLEMENT_LABELS[row.settlementStatus]}
                </Pill>
              </td>
              <td>{METHOD_LABELS[row.paymentMethod] ?? 'Nieoznaczona'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ActivityBackLink({ month }) {
  return (
    <a className="link row activity-back" href={routeHref('tus', { ym: month })}>
      <Icon name="arrowL" size={16} /> Wróć do zajęć TUS
    </a>
  )
}
