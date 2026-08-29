import { useEffect, useRef, useState } from 'react'

import { addMonths, cap, fmtMoney, fmtMonthYear, plural } from '../format.js'
import {
  FINANCE_WINDOW_MIN_MONTH,
  financeMonthView,
  warsawMonthKey,
} from '../finance-reporting.js'
import { SERVICE_BY_ID } from '../services.js'
import { useShell } from '../shell-ctx.js'
import { Button, EmptyState, IconBtn, TableScroll } from '../ui.jsx'
import { useRouteParamsSync } from '../ux-patterns.jsx'
import { useFinanceWindow } from './use-finance-window.js'

const money = (value) => fmtMoney(value / 100)
const PAYMENT_LABELS = Object.freeze({
  blik: 'BLIK', card: 'Karta', cash: 'Gotówka', monthly: 'Miesięcznie',
  other: 'Inna', outstanding: 'Pozostało do zapłaty', transfer: 'Przelew',
  unknown: 'Nie ustalono',
})
const INVOICE_LABELS = Object.freeze({
  action_required: 'Wymaga wystawienia', issued: 'Wystawiona',
  not_issued: 'Niewystawiona', not_required: 'Nie wymaga', unknown: 'Do sprawdzenia',
})

function MoneySplit({ title, rows }) {
  return (
    <section className="card card--pad report-window__split">
      <h2 className="card-title">{title}</h2>
      {rows.length === 0 ? <p className="muted">Brak danych</p> : (
        <dl>{rows.map(({ id, label, value }) => <div key={id}>
          <dt>{label}</dt><dd>{money(value)}</dd>
        </div>)}</dl>
      )}
    </section>
  )
}

export function ProtectedReports({ params = {} }) {
  const { getViewState, navigate, patchViewState, route } = useShell()
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
  const window = finance.data
  const serverCurrentMonth = window?.currentMonth ?? browserMonth
  const specialistNames = new Map(window?.specialistLabels.map(({ id, label }) => [id, label]) ?? [])

  useEffect(() => patchViewState('reports', { ym: selectedMonth }), [patchViewState, selectedMonth])
  useRouteParamsSync('reports', {
    ym: selectedMonth === serverCurrentMonth ? undefined : selectedMonth,
  })
  useEffect(() => {
    if (finance.status !== 'ready' || !pendingMonthFocusRef.current) return
    pendingMonthFocusRef.current = false
    requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }))
  }, [finance.status, selectedMonth])

  const selectMonth = (month) => {
    pendingMonthFocusRef.current = true
    setSelectedMonth(month)
  }

  if (finance.status !== 'ready') return (
    <div className="report-window">
      <div className="view-head"><div>
        <div className="eyebrow">Raporty centrum</div>
        <h1 className="display view-head__title">Raport <em>miesięczny</em></h1>
      </div></div>
      <section role={finance.status === 'loading' ? 'status' : 'alert'}>
        <EmptyState
          icon="reports"
          title={finance.status === 'loading' ? 'Wczytywanie raportu…' : 'Raport jest teraz niedostępny'}
          hint="Nie pokazujemy częściowych zestawień."
          action={finance.status === 'error' ? <Button onClick={finance.reload}>Spróbuj ponownie</Button> : null}
        />
      </section>
    </div>
  )

  const monthView = financeMonthView({
    requestedMonth: null,
    savedMonth: selectedMonth,
    currentMonth: window.currentMonth,
    selectedMonth,
    selectedRowCount: window.rows.length,
    latestPopulatedMonth: window.latestPopulatedMonth,
  })
  const moneyRows = (values, labelFor) => Object.entries(values).map(([id, value]) => ({
    id, label: labelFor(id), value,
  })).sort((left, right) => left.label.localeCompare(right.label, 'pl'))

  return (
    <div className="report-window">
      <div className="view-head">
        <div>
          <div className="eyebrow">Raporty centrum</div>
          <h1 className="display view-head__title" ref={headingRef} tabIndex={-1}>Raport — <em>{fmtMonthYear(selectedMonth)}</em></h1>
          <p className="view-head__sub">Sześć kolejnych miesięcy zakończonych wybranym miesiącem.</p>
        </div>
        <div className="view-head__actions"><div className="month-nav">
          <IconBtn
            name="chevL"
            label="Poprzedni miesiąc"
            disabled={selectedMonth <= FINANCE_WINDOW_MIN_MONTH}
            onClick={() => selectMonth(addMonths(selectedMonth, -1))}
          />
          <span className="month-nav__label">{cap(fmtMonthYear(selectedMonth))}</span>
          <IconBtn name="chevR" label="Następny miesiąc" disabled={selectedMonth >= serverCurrentMonth} onClick={() => selectMonth(addMonths(selectedMonth, 1))} />
        </div></div>
      </div>
      {monthView.emptyCopy ? <p role="status" className="finance-window__empty">
        {monthView.emptyCopy}
      </p> : null}
      {monthView.latestPopulatedMonth ? (
        <Button variant="ghost" onClick={() => selectMonth(monthView.latestPopulatedMonth)}>
          Pokaż ostatni miesiąc z danymi — {fmtMonthYear(monthView.latestPopulatedMonth)}
        </Button>
      ) : null}

      <section className="card card--pad report-window__trend" aria-labelledby="report-trend-title">
        <h2 className="card-title" id="report-trend-title">Trend sześciu miesięcy</h2>
        <TableScroll label="Przewijana tabela trendu sześciu miesięcy"><table className="table">
          <caption className="sr-only">Przychody, wpłaty i wydatki w sześciu miesiącach</caption>
          <thead><tr><th>Miesiąc</th><th className="right">Przychody</th>
            <th className="right">Wpłacono</th><th className="right">Wydatki</th>
            <th className="right">Dochód</th></tr></thead>
          <tbody>{window.trend.map((point) => <tr key={point.month}>
            <th scope="row">{fmtMonthYear(point.month)}</th>
            <td className="right">{money(point.revenueGrosze)}</td>
            <td className="right">{money(point.collectedGrosze)}</td>
            <td className="right">{money(point.expensesGrosze)}</td>
            <td className="right">{money(point.incomeGrosze)}</td>
          </tr>)}</tbody>
        </table></TableScroll>
      </section>

      <div className="report-window__splits">
        <MoneySplit
          title="Przychody według specjalistki"
          rows={moneyRows(window.splits.specialist, (id) => specialistNames.get(id) ?? 'Nie ustalono')}
        />
        <MoneySplit
          title="Przychody według usługi"
          rows={moneyRows(window.splits.service, (id) => SERVICE_BY_ID[id]?.label ?? 'Nie ustalono')}
        />
        <MoneySplit
          title="Płatności i zaległości"
          rows={moneyRows(window.splits.payment, (id) => PAYMENT_LABELS[id] ?? 'Nie ustalono')}
        />
        <section className="card card--pad report-window__split">
          <h2 className="card-title">Faktury</h2>
          <dl>{Object.entries(window.splits.invoice)
            .map(([id, value]) => ({ id, label: INVOICE_LABELS[id] ?? 'Do sprawdzenia', value }))
            .sort((left, right) => left.label.localeCompare(right.label, 'pl'))
            .map(({ id, label, value }) => <div key={id}>
            <dt>{label}</dt>
            <dd>{value.count} · {money(value.revenueGrosze)}</dd>
          </div>)}</dl>
        </section>
        <section className="card card--pad report-window__split">
          <h2 className="card-title">TUS i angielski</h2>
          <dl>{Object.entries(window.splits.program).map(([program, value]) => <div key={program}>
            <dt>{program === 'tus' ? 'TUS' : 'Angielski'}</dt>
            <dd>{money(value.revenueGrosze)} · {value.count} {plural(
              value.count, 'aktywność', 'aktywności', 'aktywności',
            )}</dd>
          </div>)}</dl>
        </section>
      </div>

      <section className="card card--pad report-window__coverage" aria-labelledby="coverage-title">
        <h2 className="card-title" id="coverage-title">Pokrycie czasu i dat</h2>
        <dl>
          <div><dt>Dokładna godzina</dt><dd>{window.coverage.timedCount}</dd></div>
          <div><dt>Godzina nieustalona</dt><dd>{window.coverage.dateOnlyCount}</dd></div>
          <div><dt>Dzień nieustalony</dt><dd>{window.coverage.monthOnlyCount}</dd></div>
          <div><dt>Okres nieustalony w wybranym miesiącu</dt><dd>{window.coverage.unknownCount}</dd></div>
        </dl>
      </section>
      {window.unknownPeriodCount > 0 ? <section className="card card--pad report-window__unknown">
        <h2 className="card-title">Nieustalony miesiąc księgowy</h2>
        <p>{window.unknownPeriodCount} {plural(
          window.unknownPeriodCount,
          'pozycja wymaga', 'pozycje wymagają', 'pozycji wymaga',
        )} przeglądu poza wybranym miesiącem.</p>
        <Button variant="ghost" onClick={() => navigate('ledger', { section: 'unknown' })}>
          Przejdź do pozycji z nieustalonym okresem
        </Button>
      </section> : null}
    </div>
  )
}
