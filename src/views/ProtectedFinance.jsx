import { useEffect, useMemo, useRef, useState } from 'react'

import { AreaChart, BarFill, Donut, toneColor } from '../charts.jsx'
import { cap, fmtMoney, fmtMonthName, fmtMonthYear, fmtShortDate, plural } from '../format.js'
import {
  FINANCE_WINDOW_MIN_MONTH,
  financeMonthView,
  warsawMonthKey,
} from '../finance-reporting.js'
import { paymentMixParts, serviceRevenueRanks } from '../finance-charts.js'
import { financeIncomeSettlement, financeRowsForSettlement, financeRowsForTab } from '../finance-tab-rows.js'
import { SERVICE_BY_ID } from '../services.js'
import { canAccessProtectedRoute, canPerformAction } from '../capability-access.js'
import { useApp, useWorkspaceWindow } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { Button, Chip, EmptyState, MoneyKpi, Pill, TableScroll, Tabs } from '../ui.jsx'
import { FilterGroup, PeriodNav, useRouteParamsSync, ViewState } from '../ux-patterns.jsx'
import { monthWorkspaceRange } from '../workspace-view.js'
import {
  ProtectedPaymentAction,
  useProtectedPaymentContext,
} from './PaymentActions.jsx'
import { useFinanceWindow } from './use-finance-window.js'
import { loadFailureCopy } from '../save-failure-copy.js'
import { FinanceEntryActions, FinanceEntryToolbar } from './FinanceEntryActions.jsx'
import { Registry } from './Registry.jsx'
import { WorkbookExport } from './WorkbookExport.jsx'

const TABS = Object.freeze([
  Object.freeze({ value: 'income', label: 'Wpływy' }),
  Object.freeze({ value: 'expenses', label: 'Wydatki' }),
  Object.freeze({ value: 'invoices', label: 'Faktury' }),
])
const TAB_IDS = new Set(TABS.map(({ value }) => value))
const money = (value) => fmtMoney(value / 100)
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
const invoiceLabel = Object.freeze({
  action_required: 'Wymaga wystawienia', issued: 'Wystawiona',
  not_issued: 'Niewystawiona', not_required: 'Nie wymaga', unknown: 'Do sprawdzenia',
})

function Kpis({ values }) {
  const items = [
    ['Przychody', values.revenueGrosze, 'coral'],
    ['Wydatki', values.expensesGrosze, 'ink'],
    ['Przychody minus wydatki', values.incomeGrosze, 'sage'],
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
  const verification = Math.max(values.verificationGrosze, 0)
  const due = collected + outstanding + verification
  const collectedShare = due > 0 ? Math.round((collected / due) * 100) : 0
  const settlementSummary = due > 0 ? `${collectedShare}% wpłacone` : 'Brak należności'
  const parts = [
    { value: collected, color: 'var(--sage)', label: 'Wpłacono' },
    { value: outstanding, color: 'var(--amber-mid)', label: 'Do zapłaty' },
    { value: verification, color: 'var(--ink-faint)', label: 'Do sprawdzenia' },
  ]

  return (
    <section className="finance-window__balance" data-reveal aria-label="Rozliczenie miesiąca">
      <div className="finance-window__balance-head">
        <span>Rozliczenie należności</span>
        <span className="hbar__val">{settlementSummary}</span>
      </div>
      <div className="hbar__track finance-window__balance-track" aria-hidden="true">
        <BarFill segments={parts} totalMax={Math.max(due, 1)} />
      </div>
      {due > 0 ? <ul className="legend finance-window__balance-legend">
        {parts.filter(({ value }) => value > 0).map(({ color, label, value }) => <li key={label} className="row" style={{ gap: 8 }}>
          <span className="legend__swatch" style={{ background: color }} aria-hidden="true" />
          {label}: {money(value)}
        </li>)}
      </ul> : null}
    </section>
  )
}

function LedgerTable({
  rows, kind, specialistNames, appointmentLabels, onReconciled, paymentContext,
  unpaidOnly, onUnpaidOnlyChange,
}) {
  const headingRef = useRef(null)
  const rowsForKind = kind === 'income'
    ? financeRowsForSettlement(rows, unpaidOnly)
    : financeRowsForTab(rows, kind)
  const title = kind === 'income' ? 'Wpływy miesiąca'
    : kind === 'expenses' ? 'Wydatki miesiąca' : 'Faktury miesiąca'
  const income = kind === 'income'
  const sourceLabel = (row) => row.appointmentId
    ? appointmentLabels.get(row.appointmentId) ?? 'Sesja'
    : row.sourceLabel || row.counterparty || 'Przychód'
  const serviceLabel = (row) => row.program === 'tus' ? 'TUS' : row.program === 'english'
    ? 'Angielski' : SERVICE_BY_ID[row.serviceId]?.label ?? 'Pozostała pozycja'
  const settlementLabel = (row) => row.settlementStatus === 'unknown' ? 'Do sprawdzenia'
    : row.settlementStatus === 'paid' ? 'Opłacona'
      : row.settlementStatus === 'partial' ? 'Częściowo opłacona' : 'Do zapłaty'

  if (income) return (
    <section className="card finance-window__table" data-reveal aria-labelledby="finance-income-title">
      <div className="finance-window__table-head">
        <div>
          <h2 className="card-title" id="finance-income-title" ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          <span className="faint">{rowsForKind.length} {plural(
            rowsForKind.length, 'pozycja', 'pozycje', 'pozycji',
          )}</span>
        </div>
        <FilterGroup label="Widok wpływów">
          <Chip on={!unpaidOnly} onClick={() => onUnpaidOnlyChange(false)}>Wszystkie</Chip>
          <Chip on={unpaidOnly} onClick={() => onUnpaidOnlyChange(true)}>Zaległości</Chip>
        </FilterGroup>
      </div>
      <TableScroll label="Przewijana tabela wpływów"><table className="table table--cards" aria-label="Lista wpływów">
        <thead><tr><th>Data</th><th>Osoba lub opis</th><th>Specjalistka</th><th>Usługa</th>
          <th className="right">Należne</th><th className="right">Wpłacono</th><th className="right">Pozostało</th><th>Płatność</th><th></th></tr></thead>
        <tbody>{rowsForKind.length === 0 ? <tr><td colSpan={9}>
          <EmptyState
            icon="payments"
            title={unpaidOnly ? 'Brak zaległości w tym miesiącu' : 'Brak wpływów w tym miesiącu'}
          />
        </td></tr> : rowsForKind.map((row) => {
          const settlement = financeIncomeSettlement(row)
          return <tr key={row.id}>
            <td data-th="Data">{row.occurredOn ? fmtShortDate(row.occurredOn) : <span className="muted">bez dnia</span>}</td>
            <td data-th="Osoba lub opis"><strong>{sourceLabel(row)}</strong>
              {!row.appointmentId && row.counterparty && row.counterparty !== row.sourceLabel
                ? <div className="muted">{row.counterparty}</div> : null}</td>
            <td data-th="Specjalistka">{row.appointmentId || row.specialistId
              ? specialistNames.get(row.specialistId) ?? 'Nie ustalono' : '—'}</td>
            <td data-th="Usługa">{row.appointmentId || row.serviceId || row.program ? serviceLabel(row) : '—'}</td>
            <td className="right num-cell" data-th="Należne">{money(row.receivableGrosze)}</td>
            <td className="right num-cell" data-th="Wpłacono">{settlement.amountsKnown
              ? money(row.collectedGrosze) : 'Nie ustalono'}</td>
            <td className="right num-cell" data-th="Pozostało">{settlement.amountsKnown
              ? money(settlement.outstandingGrosze) : 'Do sprawdzenia'}</td>
            <td data-th="Płatność"><Pill tone={row.settlementStatus === 'paid' ? 'sage'
              : row.settlementStatus === 'unknown' ? 'ink' : 'amber'}>{settlementLabel(row)}</Pill></td>
            <td className="right td--actions" data-th="Akcje">{row.appointmentId ? <ProtectedPaymentAction
              appointmentId={row.appointmentId} outstandingGrosze={settlement.outstandingGrosze}
              fallbackFocusRef={headingRef} onReconciled={onReconciled} paymentContext={paymentContext}
            /> : <FinanceEntryActions row={row} onChanged={onReconciled} />}</td>
          </tr>
        })}</tbody>
      </table></TableScroll>
    </section>
  )
  if (kind === 'invoices') return (
    <section className="card finance-window__table" data-reveal aria-labelledby="finance-invoices-title">
      <h2 className="card-title" id="finance-invoices-title">{title}</h2>
      <TableScroll label="Przewijana tabela faktur">
        <table className="table table--cards" aria-label="Lista faktur">
          <thead><tr><th>Data</th><th>Osoba lub opis</th><th className="right">Kwota</th><th>Stan faktury</th><th></th></tr></thead>
          <tbody>{rowsForKind.length === 0 ? <tr><td colSpan={5}>
            <EmptyState icon="payments" title="Brak faktur w tym miesiącu" />
          </td></tr> : rowsForKind.map((row) => (
            <tr key={row.id}>
              <td data-th="Data">{row.occurredOn ? fmtShortDate(row.occurredOn) : <span className="muted">bez dnia</span>}</td>
              <td data-th="Osoba lub opis"><strong>{sourceLabel(row)}</strong>
                {!row.appointmentId && row.counterparty && row.counterparty !== row.sourceLabel
                  ? <div className="muted">{row.counterparty}</div> : null}</td>
              <td className="right num-cell" data-th="Kwota">{money(row.revenueGrosze)}</td>
              <td data-th="Stan faktury"><Pill tone={row.invoiceStatus === 'action_required' ? 'amber' : 'ink'}>
                {invoiceLabel[row.invoiceStatus] ?? 'Do sprawdzenia'}
              </Pill></td>
              <td className="td--actions" data-th="Akcje"><FinanceEntryActions row={row} onChanged={onReconciled} /></td>
            </tr>
          ))}</tbody>
        </table>
      </TableScroll>
    </section>
  )
  return (
    <section className="card finance-window__table" data-reveal aria-labelledby={`finance-${kind}-title`}>
      <h2 className="card-title" id={`finance-${kind}-title`}>{title}</h2>
      <TableScroll label={`Przewijana tabela — ${title}`}>
        <table className="table table--cards">
          <caption className="sr-only">{title}</caption>
          <thead><tr>
            <th>Data</th><th>Opis</th><th className="right">Kwota</th><th></th>
          </tr></thead>
          <tbody>
            {rowsForKind.length === 0 ? <tr><td colSpan={4}>
              <EmptyState icon="payments" title="Brak wydatków w tym miesiącu" />
            </td></tr> : rowsForKind.map((row) => (
              <tr key={row.id}>
                <td data-th="Data">{row.occurredOn ? fmtShortDate(row.occurredOn) : <span className="muted">bez dnia</span>}</td>
                <td data-th="Opis"><strong>{row.sourceLabel || row.counterparty || 'Wydatek'}</strong>
                  {row.counterparty && row.counterparty !== row.sourceLabel
                    ? <div className="muted">{row.counterparty}</div> : null}</td>
                <td className="right num-cell" data-th="Kwota">{money(row.expenseGrosze)}</td>
                <td className="td--actions" data-th="Akcje"><FinanceEntryActions row={row} onChanged={onReconciled} /></td>
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
  const { appMode, capabilities, environment, getViewState, patchViewState, route } = useShell()
  const browserMonth = warsawMonthKey()
  const [initial] = useState(() => {
    const saved = getViewState('payments', { ym: browserMonth, tab: 'income', unpaidOnly: true })
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
        : TAB_IDS.has(saved.tab) ? saved.tab : 'income',
      unpaidOnly: typeof (params.unpaidOnly ?? route.params?.unpaidOnly) === 'boolean'
        ? params.unpaidOnly ?? route.params.unpaidOnly
        : saved.unpaidOnly !== false,
    }
  })
  const [selectedMonth, setSelectedMonth] = useState(initial.month)
  const [tab, setTab] = useState(initial.tab)
  const [unpaidOnly, setUnpaidOnly] = useState(initial.unpaidOnly)
  const headingRef = useRef(null)
  const pendingMonthFocusRef = useRef(false)
  const finance = useFinanceWindow(selectedMonth)
  const workspaceRange = useMemo(() => monthWorkspaceRange(selectedMonth), [selectedMonth])
  const canLoadWorkspace = canAccessProtectedRoute(capabilities, 'dashboard')
  const workspaceState = useWorkspaceWindow(
    workspaceRange, canLoadWorkspace && tab === 'income',
  )
  const paymentContext = useProtectedPaymentContext(
    selectedMonth, tab === 'income' && canLoadWorkspace, workspaceState,
  )
  const revealRef = useReveal()
  const window = finance.data
  const serverCurrentMonth = window?.currentMonth ?? browserMonth

  useEffect(() => {
    patchViewState('payments', { ym: selectedMonth, tab, unpaidOnly })
  }, [patchViewState, selectedMonth, tab, unpaidOnly])
  useRouteParamsSync('payments', {
    ym: selectedMonth === serverCurrentMonth ? undefined : selectedMonth,
    tab: tab === 'income' ? undefined : tab,
    unpaidOnly: tab === 'income' && !unpaidOnly ? false : undefined,
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
  const serviceRanks = useMemo(() => (window === null ? [] : serviceRevenueRanks(
    window.splits.service,
    (id) => SERVICE_BY_ID[id]?.label ?? 'Nie ustalono',
  )), [window])
  const paymentMix = useMemo(
    () => (window === null ? [] : paymentMixParts(window.splits.payment)),
    [window],
  )
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

  const paymentMixTotal = paymentMix.reduce((total, part) => total + part.value, 0)
  const emptyMonth = selectedRows.length === 0
  const afterFinanceEntryChanged = (kind) => {
    if (kind === 'expense') setTab('expenses')
    else if (kind === 'income') setTab('income')
    finance.reload()
  }
  const canUseWorkbookTools = appMode === 'app' && environment === 'staging'
    && canPerformAction(capabilities, 'finance.import.preview')
    && canPerformAction(capabilities, 'finance.import.create')
  const failed = finance.phase === 'error' || finance.phase === 'refresh-error'

  return (
    <div className="finance-window" ref={revealRef}>
      <div className="view-head">
        <div>
          <h1 className="display view-head__title" ref={headingRef} tabIndex={-1}>Finanse</h1>
          <p className="view-head__sub">Wpłaty, kwoty do zapłaty i wydatki poradni w wybranym miesiącu.</p>
        </div>
        <div className="view-head__actions">
          <WorkbookExport placement="finance-header" onComplete={finance.reload} />
          <FinanceEntryToolbar selectedMonth={selectedMonth} onChanged={afterFinanceEntryChanged} />
          <PeriodNav month={selectedMonth} min={FINANCE_WINDOW_MIN_MONTH} max={serverCurrentMonth} current={serverCurrentMonth} onChange={selectMonth} />
        </div>
      </div>
      {!finance.isCurrent ? <ViewState
        className={failed ? '' : 'finance-window__loading'}
        tone={failed ? 'error' : 'loading'}
        icon="payments"
        title={failed ? loadFailureCopy('finansów') : 'Wczytuję finanse…'}
        action={failed ? <Button onClick={finance.reload}>Spróbuj ponownie</Button> : null}
      /> : <>
      {finance.phase === 'refreshing' && <ViewState
        tone="loading"
        compact
        icon="payments"
        title="Odświeżam finanse…"
      />}
      {finance.phase === 'refresh-error' && <ViewState
        tone="error"
        compact
        icon="payments"
        title="Nie udało się odświeżyć finansów"
        hint="Widzisz ostatnio wczytane dane tego miesiąca."
        action={<Button size="sm" onClick={finance.reload}>Spróbuj ponownie</Button>}
      />}
      <div className={finance.isStale ? 'is-refreshing' : ''} aria-busy={finance.phase === 'refreshing' || undefined}>
      {emptyMonth ? <section className="finance-window__empty-state" data-reveal>
        <EmptyState
          icon="payments"
          title="Brak pozycji w tym miesiącu"
          hint="Pozycje pojawią się tu po odbytych sesjach albo po dodaniu wydatku."
        />
        {monthView.latestPopulatedMonth ? <Button variant="ghost" onClick={() => selectMonth(monthView.latestPopulatedMonth)}>
          Pokaż ostatni miesiąc z danymi ({fmtMonthYear(monthView.latestPopulatedMonth)})
        </Button> : null}
      </section> : <>
      <Kpis values={window.kpis} />
      {window.kpis.verificationGrosze > 0 ? <p className="finance-window__verification" role="status">
        Do sprawdzenia: {money(window.kpis.verificationGrosze)}. Te wpływy wymagają potwierdzenia rozliczenia.
      </p> : null}
      <MonthlySettlement values={window.kpis} />
      <Tabs options={TABS} value={tab} onChange={setTab} ariaLabel="Obszary finansów">
        <LedgerTable
          rows={selectedRows}
          kind={tab}
          specialistNames={specialistNames}
          appointmentLabels={appointmentLabels}
          onReconciled={afterFinanceEntryChanged}
          paymentContext={paymentContext}
          unpaidOnly={unpaidOnly}
          onUnpaidOnlyChange={setUnpaidOnly}
        />
      </Tabs>
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
      <div className="grid-31 finance-window__insights">
        <section className="card card--pad" data-reveal aria-labelledby="finance-services-title">
          <h2 className="card-title" id="finance-services-title">Przychody według usługi</h2>
          {serviceRanks.length === 0 ? (
            <p className="muted">Brak przychodów w tym miesiącu</p>
          ) : (
            <div className="hbar" style={{ marginTop: 20 }}>
              {serviceRanks.map(({ id, label, value }) => (
                <div className="hbar__row hbar__row--labeled" key={id}>
                  <span className="hbar__name"><span>{label}</span></span>
                  <div>
                    <div className="hbar__track" style={{ height: 18 }}>
                      <BarFill
                        segments={[{ value, color: 'var(--coral)', label }]}
                        totalMax={serviceRanks[0].value}
                      />
                    </div>
                    <div className="row row--between finance-window__insight-meta">
                      <span className="muted">{money(value)}</span>
                      <span>{share(value, window.kpis.revenueGrosze)}%</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section
          className="card card--pad"
          data-reveal
          aria-labelledby="finance-mix-title"
          style={{ alignSelf: 'start', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
        >
          <h2 className="card-title" id="finance-mix-title" style={{ alignSelf: 'stretch' }}>
            Wpłaty według formy
          </h2>
          {paymentMix.length === 0 ? (
            <p className="muted" style={{ alignSelf: 'stretch' }}>Brak wpłat w tym miesiącu</p>
          ) : (
            <>
              <div style={{ marginTop: 18 }}>
                <Donut
                  parts={paymentMix.map(({ label, tone, value }) => ({
                    label, value: value / 100, color: toneColor(tone),
                  }))}
                  centerTop={money(paymentMixTotal)}
                  centerBottom={cap(fmtMonthName(selectedMonth))}
                  label={`Wpłaty według formy — ${fmtMonthYear(selectedMonth)}`}
                />
              </div>
              <div className="stack" style={{ gap: 10, marginTop: 22, alignSelf: 'stretch' }}>
                {paymentMix.map(({ id, label, tone, value }) => (
                  <div className="row row--between" key={id} style={{ fontSize: 13.5 }}>
                    <span className="row" style={{ gap: 8 }}>
                      <span className="legend__swatch" style={{ background: `var(--${tone})` }} />
                      {label}
                    </span>
                    <span style={{ fontWeight: 650 }}>{share(value, paymentMixTotal)}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
      </>}
      </div>
      </>}
      {canUseWorkbookTools ? <Registry embedded /> : null}
    </div>
  )
}
