import { useEffect, useRef, useState } from 'react'

import { AreaChart, BarFill } from '../charts.jsx'
import { fmtMoney, fmtMonthYear, plural } from '../format.js'
import {
  FINANCE_WINDOW_MIN_MONTH,
  financeMonthView,
  warsawMonthKey,
} from '../finance-reporting.js'
import { SERVICE_BY_ID } from '../services.js'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { Button, TableScroll } from '../ui.jsx'
import { PeriodNav, useRouteParamsSync, ViewState } from '../ux-patterns.jsx'
import { useFinanceWindow } from './use-finance-window.js'
import { loadFailureCopy } from '../save-failure-copy.js'
import { routeHref } from '../routing.js'

const money = (value) => fmtMoney(value / 100)
const PAYMENT_LABELS = Object.freeze({
  blik: 'BLIK', card: 'Karta', cash: 'Gotówka', monthly: 'Miesięcznie',
  other: 'Inna', outstanding: 'Pozostało do zapłaty', transfer: 'Przelew',
  unknown: 'Nie ustalono',
  verification: 'Rozliczenie do sprawdzenia',
})
const INVOICE_LABELS = Object.freeze({
  action_required: 'Wymaga wystawienia', issued: 'Wystawiona',
  not_issued: 'Niewystawiona', not_required: 'Nie wymaga', unknown: 'Do sprawdzenia',
})
function MoneySplit({ title, rows }) {
  const maxValue = Math.max(...rows.map(({ value }) => Math.max(value, 0)), 1)
  return (
    <section className="card card--pad report-window__split" data-reveal>
      <h2 className="card-title">{title}</h2>
      {rows.length === 0 ? <p className="muted">Brak danych</p> : (
        <dl className="report-window__rows">{rows.map(({ id, label, value }) => <div key={id}>
          <dt>{label}</dt>
          <dd>
            <span>{money(value)}</span>
            <div className="hbar__track report-window__split-track" aria-hidden="true">
              <BarFill
                segments={[{
                  value: Math.max(value, 0),
                  color: 'var(--coral)',
                  label,
                }]}
                totalMax={maxValue}
              />
            </div>
          </dd>
        </div>)}</dl>
      )}
    </section>
  )
}

export function ProtectedReports({ params = {} }) {
  const { getViewState, patchViewState, route } = useShell()
  const browserMonth = warsawMonthKey()
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const saved = getViewState('reports', { ym: browserMonth })
    const requested = params.ym ?? route.params?.ym
    return financeMonthView({
      requestedMonth: requested,
      savedMonth: saved.ym,
      currentMonth: browserMonth,
      selectedMonth: browserMonth,
      selectedRowCount: 0,
      latestPopulatedMonth: null,
    }).initialMonth
  })
  const finance = useFinanceWindow(selectedMonth)
  const headingRef = useRef(null)
  const pendingMonthFocusRef = useRef(false)
  const financeWindow = finance.data
  const serverCurrentMonth = financeWindow?.currentMonth ?? browserMonth
  const specialistNames = new Map(financeWindow?.specialistLabels.map(({ id, label }) => [id, label]) ?? [])

  useEffect(() => patchViewState('reports', { ym: selectedMonth }), [patchViewState, selectedMonth])
  useRouteParamsSync('reports', {
    ym: selectedMonth === serverCurrentMonth ? undefined : selectedMonth,
  })
  useEffect(() => {
    if (finance.status !== 'ready' || !pendingMonthFocusRef.current) return
    pendingMonthFocusRef.current = false
    requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }))
  }, [finance.status, selectedMonth])
  const revealRef = useReveal()

  const selectMonth = (month) => {
    pendingMonthFocusRef.current = true
    setSelectedMonth(month)
  }

  const failed = finance.phase === 'error' || finance.phase === 'refresh-error'
  const monthView = finance.isCurrent ? financeMonthView({
    requestedMonth: null,
    savedMonth: selectedMonth,
    currentMonth: financeWindow.currentMonth,
    selectedMonth,
    selectedRowCount: financeWindow.rows.length,
    latestPopulatedMonth: financeWindow.latestPopulatedMonth,
  }) : null
  const moneyRows = (values, labelFor) => Object.entries(values).map(([id, value]) => ({
    id, label: labelFor(id), value,
  })).sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, 'pl'))

  return (
    <div className="report-window" ref={revealRef}>
      <div className="view-head">
        <div>
          <h1 className="display view-head__title" ref={headingRef} tabIndex={-1}>Raporty</h1>
          <p className="view-head__sub">Porównuje sześć miesięcy i podsumowuje wybrany miesiąc. Finanse służą do bieżących rozliczeń.</p>
        </div>
        <div className="view-head__actions no-print">
          {monthView && !monthView.emptyCopy && <Button variant="ghost" icon="print" onClick={() => window.print()}>Drukuj</Button>}
          <PeriodNav month={selectedMonth} min={FINANCE_WINDOW_MIN_MONTH} max={serverCurrentMonth} current={serverCurrentMonth} onChange={selectMonth} />
        </div>
      </div>
      {!finance.isCurrent ? <ViewState
        className={failed ? '' : 'finance-window__loading'}
        tone={failed ? 'error' : 'loading'}
        icon="reports"
        title={failed ? loadFailureCopy('raportu') : 'Wczytuję raport…'}
        action={failed ? <Button onClick={finance.reload}>Spróbuj ponownie</Button> : null}
      /> : <>
      {finance.phase === 'refreshing' && <ViewState
        tone="loading"
        compact
        icon="reports"
        title="Odświeżam raport…"
      />}
      {finance.phase === 'refresh-error' && <ViewState
        tone="error"
        compact
        icon="reports"
        title="Nie udało się odświeżyć raportu"
        hint="Widzisz ostatnio wczytane dane tego miesiąca."
        action={<Button size="sm" onClick={finance.reload}>Spróbuj ponownie</Button>}
      />}
      <div className={finance.isStale ? 'is-refreshing' : ''} aria-busy={finance.phase === 'refreshing' || undefined}>
      {monthView.emptyCopy ? <ViewState
        icon="reports"
        title={monthView.emptyCopy}
        hint="Wybierz inny miesiąc, aby zobaczyć podsumowanie."
        action={monthView.latestPopulatedMonth ? <Button variant="ghost" onClick={() => selectMonth(monthView.latestPopulatedMonth)}>
          Pokaż ostatni miesiąc z danymi ({fmtMonthYear(monthView.latestPopulatedMonth)})
        </Button> : null}
      /> : null}
      <section className="report-print-sheet print-only" aria-label="Arkusz wydruku raportu">
        <p>Podsumowanie miesiąca: {fmtMonthYear(selectedMonth)}</p>
      </section>

      <section className="card card--pad report-window__trend" data-reveal aria-labelledby="report-trend-title">
        <h2 className="card-title" id="report-trend-title">Trend sześciu miesięcy</h2>
        <div className="chart-frame no-print">
          <AreaChart
            data={financeWindow.trend.map((point) => ({
              ym: point.month,
              revenue: point.revenueGrosze / 100,
            }))}
            label="Przychody w sześciu miesiącach"
          />
        </div>
        <TableScroll label="Przewijana tabela trendu sześciu miesięcy"><table className="table">
          <caption className="sr-only">Przychody, wpłaty i wydatki w sześciu miesiącach</caption>
          <thead><tr><th>Miesiąc</th><th className="right">Przychody</th>
            <th className="right">Wpłacono</th><th className="right">Do sprawdzenia</th><th className="right">Wydatki</th>
            <th className="right">Dochód</th></tr></thead>
          <tbody>{financeWindow.trend.map((point) => <tr key={point.month}>
            <th scope="row">{fmtMonthYear(point.month)}</th>
            <td className="right">{money(point.revenueGrosze)}</td>
            <td className="right">{money(point.collectedGrosze)}</td>
            <td className="right">{money(point.verificationGrosze)}</td>
            <td className="right">{money(point.expensesGrosze)}</td>
            <td className="right">{money(point.incomeGrosze)}</td>
          </tr>)}</tbody>
        </table></TableScroll>
      </section>

      <div className="report-window__splits">
        <MoneySplit
          title="Przychody według specjalistki"
          rows={moneyRows(financeWindow.splits.specialist, (id) => specialistNames.get(id) ?? 'Nie ustalono')}
        />
        <MoneySplit
          title="Przychody według usługi"
          rows={moneyRows(financeWindow.splits.service, (id) => SERVICE_BY_ID[id]?.label ?? 'Nie ustalono')}
        />
        <MoneySplit
          title="Płatności i zaległości"
          rows={moneyRows(financeWindow.splits.payment, (id) => PAYMENT_LABELS[id] ?? 'Nie ustalono')}
        />
      <section className="card card--pad report-window__split" data-reveal>
          <h2 className="card-title">Faktury</h2>
          {Object.keys(financeWindow.splits.invoice).length === 0 ? <p className="muted">Brak danych</p> : (
            <dl className="activity-card-facts">{Object.entries(financeWindow.splits.invoice)
              .map(([id, value]) => ({ id, label: INVOICE_LABELS[id] ?? 'Do sprawdzenia', value }))
              .sort((left, right) => right.value.revenueGrosze - left.value.revenueGrosze
                || left.label.localeCompare(right.label, 'pl'))
              .map(({ id, label, value }) => <div key={id}>
              <dt>{label}</dt>
              <dd>{value.count} · {money(value.revenueGrosze)}</dd>
            </div>)}</dl>
          )}
        </section>
        <section className="card card--pad report-window__split" data-reveal>
          <h2 className="card-title">TUS i angielski</h2>
          <dl className="activity-card-facts">{Object.entries(financeWindow.splits.program)
            .map(([program, value]) => ({
              program, value, label: program === 'tus' ? 'TUS' : 'Angielski',
            }))
            .sort((left, right) => right.value.revenueGrosze - left.value.revenueGrosze
              || left.label.localeCompare(right.label, 'pl'))
            .map(({ program, value, label }) => <div key={program}>
            <dt>{label}</dt>
            <dd>{money(value.revenueGrosze)} · {value.count} {plural(
              value.count, 'aktywność', 'aktywności', 'aktywności',
            )}</dd>
          </div>)}</dl>
      </section>
      </div>

      <section className="card card--pad report-window__coverage" data-reveal aria-labelledby="coverage-title">
        <h2 className="card-title" id="coverage-title">Pokrycie czasu i dat</h2>
        <dl className="activity-card-facts">
          <div><dt>Dokładna godzina</dt><dd>{financeWindow.coverage.timedCount}</dd></div>
          <div><dt>Godzina nieustalona</dt><dd>{financeWindow.coverage.dateOnlyCount}</dd></div>
          <div><dt>Dzień nieustalony</dt><dd>{financeWindow.coverage.monthOnlyCount}</dd></div>
          <div><dt>Okres nieustalony w wybranym miesiącu</dt><dd>{financeWindow.coverage.unknownCount}</dd></div>
        </dl>
      </section>
      {financeWindow.unknownPeriodCount > 0 ? <section className="card card--pad report-window__unknown" data-reveal>
        <h2 className="card-title">Pozycje bez miesiąca</h2>
        <p>{financeWindow.unknownPeriodCount} {plural(
          financeWindow.unknownPeriodCount,
          'pozycja z arkusza nie ma', 'pozycje z arkusza nie mają', 'pozycji z arkusza nie ma',
        )} przypisanego miesiąca, więc nie {plural(financeWindow.unknownPeriodCount, 'liczy', 'liczą', 'liczy')} się
          do żadnego miesiąca. Znajdziesz {financeWindow.unknownPeriodCount === 1 ? 'ją' : 'je'} w arkuszu Excel
          pobranym w <a href={routeHref('payments')}>Finansach</a>.</p>
      </section> : null}
      </div>
      </>}
    </div>
  )
}
