import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { apiClient } from '../api.js'
import { canPerformAction } from '../capability-access.js'
import { fmtFullDate, fmtMoney, isBillable, monthKey, METHOD_LABELS } from '../format.js'
import { ownPaymentSession } from '../own-payments.js'
import { routeHref } from '../routing.js'
import { SERVICE_BY_ID } from '../services.js'
import { useShell } from '../shell-ctx.js'
import { usePaymentMutationLock } from '../store.jsx'
import { useReveal } from '../anim.js'
import { Button, EmptyState, MoneyKpi, Pager, Pill, usePagination } from '../ui.jsx'
import { PeriodNav, useRouteParamsSync, ViewState } from '../ux-patterns.jsx'
import { monthWorkspaceRange } from '../workspace-view.js'
import { AppPaymentEntry } from './Payments.jsx'
import { WorkbookExport } from './WorkbookExport.jsx'
import { loadFailureCopy } from '../save-failure-copy.js'

const validMonth = (value) => /^\d{4}-\d{2}$/.test(value || '')
const paymentLabel = Object.freeze({
  paid: 'Opłacona', partial: 'Częściowo opłacona', unpaid: 'Do zapłaty',
})

export function OwnPayments() {
  const { canAccess, capabilities, getViewState, patchViewState, route } = useShell()
  const { locked: paymentMutationLocked } = usePaymentMutationLock()
  const currentMonth = monthKey(new Date())
  const [initial] = useState(() => {
    const saved = getViewState('payments', { ym: currentMonth, page: 1 })
    return {
      month: validMonth(route.params?.ym) ? route.params.ym
        : validMonth(saved.ym) ? saved.ym : currentMonth,
      page: Math.max(1, Number(route.params?.page ?? saved.page) || 1),
    }
  })
  const [selectedMonth, setSelectedMonth] = useState(initial.month)
  const [reloadToken, setReloadToken] = useState(0)
  const range = useMemo(() => monthWorkspaceRange(selectedMonth), [selectedMonth])
  const rangeKey = `${range.from}|${range.to}`
  const currentRangeKey = useRef(rangeKey)
  currentRangeKey.current = rangeKey
  const ownPaymentsHeadingRef = useRef(null)
  const [request, setRequest] = useState(() => ({
    key: '', status: 'loading', data: null, error: null,
  }))

  useEffect(() => {
    let current = true
    const key = `${range.from}|${range.to}`
    setRequest((current) => ({
      key,
      status: current.data === null ? 'loading' : 'refreshing',
      data: current.data,
      error: null,
    }))
    apiClient.loadOwnPaymentsWindow(range).then((data) => {
      if (current) setRequest({ key, status: 'ready', data, error: null })
    }).catch(() => {
      if (current) setRequest((previous) => ({
        key, status: 'error', data: previous.data, error: true,
      }))
    })
    return () => { current = false }
  }, [range, reloadToken])

  const requestKey = rangeKey
  const requestMatchesMonth = request.data?.window?.from === range.from && request.data?.window?.to === range.to
  const isCurrent = request.key === requestKey && requestMatchesMonth
  const phase = request.key !== requestKey
    ? 'loading'
    : request.status === 'error' ? isCurrent ? 'refresh-error' : 'error'
      : request.status === 'ready' && isCurrent ? 'ready'
        : request.status === 'refreshing' && isCurrent ? 'refreshing' : 'loading'
  const revealRef = useReveal()
  const appointments = useMemo(() => (
    isCurrent
      ? request.data.appointments.filter(isBillable)
      : []
  ), [isCurrent, request.data])
  const summary = useMemo(() => appointments.reduce((result, appointment) => ({
    due: result.due + appointment.charge.expectedAmountGrosze,
    collected: result.collected + appointment.payment.collectedGrosze,
    outstanding: result.outstanding + appointment.payment.outstandingGrosze,
  }), { due: 0, collected: 0, outstanding: 0 }), [appointments])
  const { pageItems, page, pages, setPage } = usePagination(appointments, {
    pageSize: 25,
    resetKey: selectedMonth,
    initialPage: initial.page,
  })
  useEffect(() => {
    patchViewState('payments', { ym: selectedMonth, page })
  }, [page, patchViewState, selectedMonth])
  useRouteParamsSync('payments', {
    ym: selectedMonth === currentMonth ? undefined : selectedMonth,
    page: page > 1 ? page : undefined,
  })
  const reload = useCallback(() => setReloadToken((value) => value + 1), [])
  const refreshOwnPayments = useCallback(async () => {
    const key = `${range.from}|${range.to}`
    const data = await apiClient.loadOwnPaymentsWindow(range)
    if (currentRangeKey.current !== key) return
    setRequest({ key, status: 'ready', data, error: null })
  }, [range])
  const canRecordPayments = canPerformAction(capabilities, 'payment.record')
  const canOpenCalendar = canAccess('calendar')

  return (
    <div className="finance-window" ref={revealRef}>
      <div className="view-head" data-reveal>
        <div>
          <h1 className="display view-head__title">Finanse <em>i płatności</em></h1>
          <p className="view-head__sub">Twoje sesje, należności i wpłaty.</p>
        </div>
        <div className="view-head__actions">
          <WorkbookExport own />
          <PeriodNav month={selectedMonth} max={currentMonth} current={currentMonth} onChange={setSelectedMonth} />
        </div>
      </div>

      {!isCurrent ? (
        <ViewState
          className={phase === 'error' || phase === 'refresh-error' ? '' : 'finance-window__loading'}
          tone={phase === 'error' || phase === 'refresh-error' ? 'error' : 'loading'}
          icon="payments"
          title={phase === 'error' || phase === 'refresh-error' ? loadFailureCopy('Twoich rozliczeń') : 'Wczytuję Twoje rozliczenia…'}
          action={phase === 'error' || phase === 'refresh-error' ? <Button onClick={reload}>Spróbuj ponownie</Button> : null}
        />
      ) : (
        <>
          {phase === 'refreshing' && <ViewState
            tone="loading"
            compact
            icon="payments"
            title="Odświeżam Twoje rozliczenia…"
          />}
          {phase === 'refresh-error' && <ViewState
            tone="error"
            compact
            icon="payments"
            title="Nie udało się odświeżyć Twoich rozliczeń"
            hint="Widzisz ostatnio wczytane dane tego miesiąca."
            action={<Button size="sm" onClick={reload}>Spróbuj ponownie</Button>}
          />}
          <div className={phase === 'refreshing' || phase === 'refresh-error' ? 'is-refreshing' : ''} aria-busy={phase === 'refreshing' || undefined}>
          <section className="finance-window__kpis" aria-label="Podsumowanie własnych rozliczeń">
            {[
              ['Należne', summary.due],
              ['Wpłacono', summary.collected],
              ['Pozostało do zapłaty', summary.outstanding],
            ].map(([label, value]) => (
              <MoneyKpi key={label} label={label} grosze={value} tone={label === 'Pozostało do zapłaty' ? 'amber' : undefined} />
            ))}
          </section>
          <section className="card finance-window__table" data-reveal aria-labelledby="own-payments-title">
            <h2 className="card-title" id="own-payments-title" ref={ownPaymentsHeadingRef} tabIndex={-1}>
              Twoje sesje
            </h2>
            <div className="table-scroll">
              <table className="table table--cards" aria-label="Własne rozliczenia sesji">
                <thead><tr>
                  <th>Sesja</th><th>Usługa</th><th className="right">Należne</th>
                  <th className="right">Wpłacono</th><th className="right">Pozostało</th>
                  <th>Forma</th><th>Płatność</th><th>Akcje</th>
                </tr></thead>
                <tbody>{appointments.length === 0 ? <tr><td colSpan={8}>
                  <EmptyState icon="payments" title="Brak rozliczonych sesji w tym miesiącu" />
                </td></tr> : pageItems.map((appointment) => {
                  const session = ownPaymentSession(appointment)
                  return <tr key={appointment.id}>
                  <td data-th="Sesja">
                    <div>{fmtFullDate(session.date)}</div>
                    <div className="muted">{session.time}</div>
                    {canOpenCalendar && <a href={routeHref('calendar', {
                      date: session.date,
                      highlightSessionIds: [appointment.id],
                    })}>Otwórz w Grafiku</a>}
                  </td>
                  <td data-th="Usługa">{SERVICE_BY_ID[appointment.serviceId].label}</td>
                  <td className="right num-cell" data-th="Należne">
                    {fmtMoney(appointment.charge.expectedAmountGrosze / 100)}
                  </td>
                  <td className="right num-cell" data-th="Wpłacono">
                    {fmtMoney(appointment.payment.collectedGrosze / 100)}
                  </td>
                  <td className="right num-cell" data-th="Pozostało">
                    {fmtMoney(appointment.payment.outstandingGrosze / 100)}
                  </td>
                  <td data-th="Forma">{appointment.payment.latestMethod
                    ? METHOD_LABELS[appointment.payment.latestMethod] : '—'}</td>
                  <td data-th="Płatność"><Pill tone={appointment.payment.status === 'paid' ? 'sage' : 'amber'}>
                    {paymentLabel[appointment.payment.status]}
                  </Pill></td>
                  <td className="td--actions" data-th="Akcje">{canRecordPayments && appointment.payment.outstandingGrosze > 0 ? <AppPaymentEntry
                    session={session}
                    fallbackFocusRef={ownPaymentsHeadingRef}
                    paymentMutationLocked={paymentMutationLocked}
                    workspace={null}
                    onRecordPayment={async (input) => {
                      await apiClient.recordPayment(appointment.id, appointment.version, {
                        amountGrosze: input.amountGrosze,
                        method: input.method,
                        receivedAt: input.receivedAt,
                      })
                    }}
                    onRefresh={refreshOwnPayments}
                  /> : <span className="faint">—</span>}</td>
                </tr>
                })}</tbody>
              </table>
            </div>
            <Pager page={page} pages={pages} onPage={setPage} label="Stronicowanie własnych rozliczeń" />
          </section>
          </div>
        </>
      )}
    </div>
  )
}
