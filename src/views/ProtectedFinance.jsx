import { useEffect, useMemo, useRef, useState } from 'react'

import { AreaChart, BarFill } from '../charts.jsx'
import { addMonths, cap, fmtMoney, fmtMonthYear, fmtShortDate } from '../format.js'
import {
  FINANCE_WINDOW_MIN_MONTH,
  financeMonthView,
  warsawMonthKey,
} from '../finance-reporting.js'
import { SERVICE_BY_ID } from '../services.js'
import { canAccessProtectedRoute } from '../capability-access.js'
import { useApp, useWorkspaceWindow } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { Button, EmptyState, IconBtn, MoneyKpi, Pill, TableScroll, Tabs } from '../ui.jsx'
import { useRouteParamsSync } from '../ux-patterns.jsx'
import { monthWorkspaceRange } from '../workspace-view.js'
import {
  ProtectedPaymentAction,
  useProtectedPaymentContext,
} from './PaymentActions.jsx'
import { useFinanceWindow } from './use-finance-window.js'

const TABS = Object.freeze([
  Object.freeze({ value: 'income', label: 'Przychody' }),
  Object.freeze({ value: 'payments', label: 'Płatności i zaległości' }),
  Object.freeze({ value: 'expenses', label: 'Wydatki' }),
  Object.freeze({ value: 'invoices', label: 'Faktury' }),
])
const TAB_IDS = new Set(TABS.map(({ value }) => value))
const money = (value) => fmtMoney(value / 100)
const invoiceLabel = Object.freeze({
  action_required: 'Wymaga wystawienia', issued: 'Wystawiona',
  not_issued: 'Niewystawiona', not_required: 'Nie wymaga', unknown: 'Do sprawdzenia',
})

function Kpis({ values }) {
  const items = [
    ['Przychody', values.revenueGrosze, 'coral'],
    ['Wpłacono', values.collectedGrosze, 'sage'],
    ['Pozostało do zapłaty', values.outstandingGrosze, 'amber'],
    ['Wydatki', values.expensesGrosze, 'pink'],
    ['Dochód', values.incomeGrosze, 'sky'],
  ]
  return (
    <section className="finance-window__kpis" aria-label="Podsumowanie finansowe">
      {items.map(([label, value, tone]) => (
        <MoneyKpi key={label} label={label} grosze={value} tone={tone} />
      ))}
    </section>
  )
}

function MonthlySettlement({ values }) {
  const collected = Math.max(values.collectedGrosze, 0)
  const outstanding = Math.max(values.outstandingGrosze, 0)
  const due = collected + outstanding
  const collectedShare = due > 0 ? Math.round((collected / due) * 100) : 0
  const settlementSummary = due > 0 ? `${collectedShare}% wpłacone` : 'Brak należności'

  return (
    <section className="card card--pad finance-window__balance" data-reveal aria-label="Rozliczenie miesiąca">
      <div className="finance-window__balance-head">
        <h2 className="card-title">Rozliczenie miesiąca</h2>
        <span className="hbar__val">{settlementSummary}</span>
      </div>
      <div className="hbar__track finance-window__balance-track" aria-hidden="true">
        <BarFill
          segments={[
            { value: collected, color: 'var(--sage)', label: 'wpłacono' },
            { value: outstanding, color: 'var(--amber-mid)', label: 'pozostało do zapłaty' },
          ]}
          totalMax={Math.max(due, 1)}
        />
      </div>
      <dl className="finance-window__balance-legend">
        <div>
          <dt><span className="finance-window__balance-swatch finance-window__balance-swatch--paid" />Wpłacono</dt>
          <dd>{money(collected)}</dd>
        </div>
        <div>
          <dt><span className="finance-window__balance-swatch finance-window__balance-swatch--due" />Pozostało do zapłaty</dt>
          <dd>{money(outstanding)}</dd>
        </div>
      </dl>
    </section>
  )
}

function LedgerTable({
  rows, kind, specialistNames, appointmentLabels, onReconciled, paymentContext,
}) {
  const headingRef = useRef(null)
  const visible = rows.filter((row) => (
    kind === 'income' ? row.kind === 'income'
      : kind === 'payments' ? row.kind === 'income'
      : kind === 'expenses' ? row.kind === 'expense'
        : row.kind === 'income' && row.invoiceStatus !== 'not_required'
  ))
  const title = kind === 'income' ? 'Przychody miesiąca'
    : kind === 'payments' ? 'Płatności i zaległości miesiąca'
      : kind === 'expenses' ? 'Wydatki miesiąca' : 'Faktury miesiąca'
  if (kind === 'payments') return (
    <section className="card finance-window__table" data-reveal aria-labelledby="finance-payments-title">
      <h2 className="card-title" id="finance-payments-title" ref={headingRef} tabIndex={-1}>
        {title}
      </h2>
      <TableScroll label="Przewijana tabela rozliczeń"><table className="table" aria-label="Lista rozliczeń">
        <thead><tr><th>Data</th><th>Źródło</th><th className="right">Należne</th>
          <th className="right">Wpłacono</th><th className="right">Pozostało</th><th></th></tr></thead>
        <tbody>{visible.length === 0 ? <tr><td colSpan={6}>
          <EmptyState icon="payments" title="Brak rozliczeń w tym miesiącu" />
        </td></tr> : visible.map((row) => {
          const outstandingGrosze = row.receivableGrosze - row.collectedGrosze
          return <tr key={row.id}>
            <td>{row.occurredOn ? fmtShortDate(row.occurredOn) : 'Dzień nieustalony'}</td>
            <td>{appointmentLabels.get(row.appointmentId)
              ?? (row.sourceKind === 'panel' ? 'Panel' : 'Arkusz źródłowy')}</td>
            <td className="right num-cell">{money(row.receivableGrosze)}</td>
            <td className="right num-cell">{money(row.collectedGrosze)}</td>
            <td className="right num-cell">{money(outstandingGrosze)}</td>
            <td className="right"><ProtectedPaymentAction
              appointmentId={row.appointmentId}
              outstandingGrosze={outstandingGrosze}
              fallbackFocusRef={headingRef}
              onReconciled={onReconciled}
              paymentContext={paymentContext}
            /></td>
          </tr>
        })}</tbody>
      </table></TableScroll>
    </section>
  )
  return (
    <section className="card finance-window__table" data-reveal aria-labelledby={`finance-${kind}-title`}>
      <h2 className="card-title" id={`finance-${kind}-title`}>{title}</h2>
      <TableScroll label={`Przewijana tabela — ${title}`}>
        <table className="table">
          <caption className="sr-only">{title}</caption>
          <thead><tr>
            <th>Data</th><th>Źródło</th><th>Specjalistka</th><th>Klasyfikacja</th>
            <th className="right">Kwota</th>{kind === 'invoices' ? <th>Stan faktury</th> : null}
          </tr></thead>
          <tbody>
            {visible.length === 0 ? <tr><td colSpan={kind === 'invoices' ? 6 : 5}>
              <EmptyState icon="payments" title="Brak pozycji w tym miesiącu" />
            </td></tr> : visible.map((row) => (
              <tr key={row.id}>
                <td>{row.occurredOn ? fmtShortDate(row.occurredOn) : 'Dzień nieustalony'}</td>
                <td>{appointmentLabels.get(row.appointmentId)
                  ?? (row.sourceKind === 'panel' ? 'Panel' : 'Arkusz źródłowy')}</td>
                <td>{specialistNames.get(row.specialistId) ?? 'Nie ustalono'}</td>
                <td>{row.program === 'tus' ? 'TUS' : row.program === 'english'
                  ? 'Angielski' : SERVICE_BY_ID[row.serviceId]?.label ?? 'Nie ustalono'}</td>
                <td className="right num-cell">{money(
                  row.kind === 'expense' ? row.expenseGrosze : row.revenueGrosze,
                )}</td>
                {kind === 'invoices' ? <td><Pill tone={row.invoiceStatus === 'action_required' ? 'amber' : 'ink'}>
                  {invoiceLabel[row.invoiceStatus] || 'Do sprawdzenia'}
                </Pill></td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </section>
  )
}

export function ProtectedFinance({ params = {} }) {
  const { state } = useApp()
  const { capabilities, getViewState, patchViewState, route } = useShell()
  const browserMonth = warsawMonthKey()
  const [initial] = useState(() => {
    const saved = getViewState('payments', { ym: browserMonth, tab: 'payments' })
    const requestedMonth = params.ym ?? route.params?.ym
    return {
      month: financeMonthView({
        requestedMonth,
        savedMonth: saved.ym,
        currentMonth: browserMonth,
        selectedMonth: browserMonth,
        selectedRowCount: 0,
        latestPopulatedMonth: null,
      }).initialMonth,
      tab: TAB_IDS.has(params.tab ?? route.params?.tab) ? params.tab ?? route.params.tab
        : TAB_IDS.has(saved.tab) ? saved.tab : 'payments',
    }
  })
  const [selectedMonth, setSelectedMonth] = useState(initial.month)
  const [tab, setTab] = useState(initial.tab)
  const headingRef = useRef(null)
  const pendingMonthFocusRef = useRef(false)
  const finance = useFinanceWindow(selectedMonth)
  const workspaceRange = useMemo(() => monthWorkspaceRange(selectedMonth), [selectedMonth])
  const canLoadWorkspace = canAccessProtectedRoute(capabilities, 'dashboard')
  const workspaceState = useWorkspaceWindow(
    workspaceRange, canLoadWorkspace && tab === 'payments',
  )
  const paymentContext = useProtectedPaymentContext(
    selectedMonth, tab === 'payments' && canLoadWorkspace, workspaceState,
  )
  const revealRef = useReveal([finance.status, selectedMonth])
  const window = finance.data
  const serverCurrentMonth = window?.currentMonth ?? browserMonth

  useEffect(() => {
    patchViewState('payments', { ym: selectedMonth, tab })
  }, [patchViewState, selectedMonth, tab])
  useRouteParamsSync('payments', {
    ym: selectedMonth === serverCurrentMonth ? undefined : selectedMonth,
    tab: tab === 'payments' ? undefined : tab,
  })

  const selectedRows = useMemo(() => window?.rows ?? [], [window?.rows])
  const specialistNames = useMemo(() => new Map(
    window?.specialistLabels.map(({ id, label }) => [id, label]) ?? [],
  ), [window?.specialistLabels])
  const appointmentLabels = useMemo(() => {
    const clientNames = new Map(state.clients.map(({ id, name }) => [id, name]))
    return new Map(state.sessions.map(({ id, clientId }) => [
      id, clientNames.get(clientId) ?? 'Klient niedostępny',
    ]))
  }, [state.clients, state.sessions])
  const monthView = window ? financeMonthView({
    requestedMonth: null,
    savedMonth: selectedMonth,
    currentMonth: window.currentMonth,
    selectedMonth,
    selectedRowCount: window.rows.length,
    latestPopulatedMonth: window.latestPopulatedMonth,
  }) : null
  const selectMonth = (month) => {
    pendingMonthFocusRef.current = true
    setSelectedMonth(month)
  }
  useEffect(() => {
    if (finance.status !== 'ready' || !pendingMonthFocusRef.current) return
    pendingMonthFocusRef.current = false
    requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }))
  }, [finance.status, selectedMonth])

  if (finance.status !== 'ready') return (
    <div className="finance-window">
      <div className="view-head"><div>
        <div className="eyebrow">Finanse centrum</div>
        <h1 className="display view-head__title">Finanse <em>centrum</em></h1>
      </div></div>
      <section role={finance.status === 'loading' ? 'status' : 'alert'}>
        <EmptyState
          icon="payments"
          title={finance.status === 'loading' ? 'Wczytywanie finansów…' : 'Finanse są teraz niedostępne'}
          hint="Nie pokazujemy częściowych kwot."
          action={finance.status === 'error' ? <Button onClick={finance.reload}>Spróbuj ponownie</Button> : null}
        />
      </section>
    </div>
  )

  return (
    <div className="finance-window" ref={revealRef}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Finanse centrum</div>
          <h1 className="display view-head__title" ref={headingRef} tabIndex={-1}>
            Finanse — <em>{fmtMonthYear(selectedMonth)}</em>
          </h1>
          <p className="view-head__sub">Jedno autorytatywne podsumowanie rejestru centrum.</p>
        </div>
        <div className="view-head__actions">
          <div className="month-nav">
            <IconBtn
              name="chevL"
              label="Poprzedni miesiąc"
              disabled={selectedMonth <= FINANCE_WINDOW_MIN_MONTH}
              onClick={() => selectMonth(addMonths(selectedMonth, -1))}
            />
            <span className="month-nav__label">{cap(fmtMonthYear(selectedMonth))}</span>
            <IconBtn name="chevR" label="Następny miesiąc" disabled={selectedMonth >= serverCurrentMonth} onClick={() => selectMonth(addMonths(selectedMonth, 1))} />
          </div>
        </div>
      </div>
      <Kpis values={window.kpis} />
      <MonthlySettlement values={window.kpis} />
      <section className="card card--pad finance-window__trend" data-reveal aria-labelledby="finance-trend-title">
        <h2 className="card-title" id="finance-trend-title">Przychody · sześć miesięcy</h2>
        <div className="chart-frame">
          <AreaChart
            data={window.trend.map((point) => ({
              ym: point.month,
              revenue: point.revenueGrosze / 100,
            }))}
            height={200}
            label={`Przychody w sześciu miesiącach do ${fmtMonthYear(selectedMonth)}`}
          />
        </div>
      </section>
      {monthView.emptyCopy ? <p className="finance-window__empty" role="status">
        {monthView.emptyCopy}
      </p> : null}
      {monthView.latestPopulatedMonth ? <Button variant="ghost" onClick={() => selectMonth(monthView.latestPopulatedMonth)}>
        Pokaż ostatni miesiąc z danymi — {fmtMonthYear(monthView.latestPopulatedMonth)}
      </Button> : null}
      <Tabs options={TABS} value={tab} onChange={setTab} ariaLabel="Obszary finansów">
        <LedgerTable
          rows={selectedRows}
          kind={tab}
          specialistNames={specialistNames}
          appointmentLabels={appointmentLabels}
          onReconciled={finance.reload}
          paymentContext={paymentContext}
        />
      </Tabs>
    </div>
  )
}
