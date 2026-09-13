import { Button, EmptyState, Figure, IconBtn, Pill } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { addMonths, fmtMonthYear, fmtMoney, METHOD_LABELS } from '../format.js'
import { routeHref } from '../routing.js'
import { useApp } from '../store.jsx'
import { ViewState } from '../ux-patterns.jsx'
import { FinanceEntryActions } from './FinanceEntryActions.jsx'

const SETTLEMENT_LABELS = Object.freeze({
  paid: 'Opłacona', partial: 'Częściowo opłacona', unpaid: 'Nieopłacona', unknown: 'Status nieznany',
})

export const activityMoney = (grosze) => grosze === null ? '—' : fmtMoney(grosze / 100)

const activityUnavailableTitle = (title) => (
  title === 'Angielski' ? 'Angielski jest teraz niedostępny' : `${title} są teraz niedostępne`
)

export function ActivityLoadState({ state, title, onRetry }) {
  if (state === 'ready') return null
  return (
    <ViewState
      tone={state === 'loading' ? 'loading' : 'error'}
      icon="group"
      title={state === 'loading' ? 'Wczytuję zajęcia…' : activityUnavailableTitle(title)}
      hint={state === 'loading'
        ? 'Pobieramy dane za wybrany miesiąc.'
        : 'Nie udało się pobrać danych. Spróbuj ponownie.'}
      action={state === 'unavailable' && onRetry ? <Button onClick={onRetry}>Spróbuj ponownie</Button> : null}
    />
  )
}

export function ActivityModuleEmpty({ program }) {
  const english = program === 'english'
  return (
    <EmptyState
      icon="group"
      title={english ? 'Angielski nie jest teraz w Twoim zakresie' : 'Zajęcia TUS nie są teraz w Twoim zakresie'}
      hint={english
        ? 'Nie prowadzisz obecnie grupy angielskiego. Gdy dostaniesz przypisanie, zajęcia pojawią się tutaj.'
        : 'Nie prowadzisz obecnie grupy TUS. Gdy dostaniesz przypisanie, zajęcia pojawią się tutaj.'}
    />
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
          onClick={() => onChange(addMonths(month, 1))}
        />
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        Wybrano miesiąc: {fmtMonthYear(month)}
      </span>
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

export function ActivityChargeTable({ rows, english = false, month, titleId }) {
  const { workspace } = useApp()
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
            <th></th>
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
                <Pill tone={row.settlementStatus === 'paid' ? 'sage' : ['partial', 'unpaid'].includes(row.settlementStatus) ? 'amber' : 'ink'}>
                  {SETTLEMENT_LABELS[row.settlementStatus]}
                </Pill>
              </td>
              <td>{METHOD_LABELS[row.paymentMethod] ?? 'Nieoznaczona'}</td>
              <td>{row.charge?.financeEntryId && <FinanceEntryActions row={{ id: row.charge.financeEntryId }}
                onChanged={() => { workspace.activities.loadWindow({ from: month, to: month }).catch(() => {}) }} />}</td>
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
