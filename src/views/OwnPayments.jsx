import { useCallback, useEffect, useMemo, useState } from 'react'

import { apiClient } from '../api.js'
import {
  addMonths,
  cap,
  fmtMoney,
  fmtMonthYear,
  fmtShortDate,
  monthKey,
  METHOD_LABELS,
} from '../format.js'
import { SERVICE_BY_ID } from '../services.js'
import { useShell } from '../shell-ctx.js'
import { Button, EmptyState, IconBtn, Pager, Pill, usePagination } from '../ui.jsx'
import { useRouteParamsSync } from '../ux-patterns.jsx'
import { monthWorkspaceRange } from '../workspace-view.js'

const validMonth = (value) => /^\d{4}-\d{2}$/.test(value || '')
const paymentLabel = Object.freeze({
  paid: 'Opłacona', partial: 'Częściowo opłacona', unpaid: 'Nieopłacona',
})

export function OwnPayments() {
  const { getViewState, patchViewState, route } = useShell()
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
  const [request, setRequest] = useState(() => ({
    key: '', status: 'loading', data: null,
  }))

  useEffect(() => {
    let current = true
    const key = `${range.from}|${range.to}`
    setRequest({ key, status: 'loading', data: null })
    apiClient.loadOwnPaymentsWindow(range).then((data) => {
      if (current) setRequest({ key, status: 'ready', data })
    }).catch(() => {
      if (current) setRequest({ key, status: 'error', data: null })
    })
    return () => { current = false }
  }, [range, reloadToken])

  const requestKey = `${range.from}|${range.to}`
  const status = request.key === requestKey ? request.status : 'loading'
  const appointments = useMemo(() => (
    status === 'ready'
      ? request.data.appointments.filter(({ status: value }) => (
          value === 'completed' || value === 'noshow'
        ))
      : []
  ), [request.data, status])
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

  return (
    <div className="finance-window">
      <div className="view-head">
        <div>
          <div className="eyebrow">Własne rozliczenia</div>
          <h1 className="display view-head__title">Finanse <em>i płatności</em></h1>
          <p className="view-head__sub">
            Wyłącznie należności i wpłaty za Twoje sesje — bez danych klientów i zespołu.
          </p>
        </div>
        <div className="view-head__actions">
          <div className="month-nav">
            <IconBtn
              name="chevL"
              label="Poprzedni miesiąc"
              onClick={() => setSelectedMonth(addMonths(selectedMonth, -1))}
            />
            <span className="month-nav__label">{cap(fmtMonthYear(selectedMonth))}</span>
            <IconBtn
              name="chevR"
              label="Następny miesiąc"
              disabled={selectedMonth >= currentMonth}
              onClick={() => setSelectedMonth(addMonths(selectedMonth, 1))}
            />
          </div>
        </div>
      </div>

      {status !== 'ready' ? (
        <section role={status === 'loading' ? 'status' : 'alert'}>
          <EmptyState
            icon="payments"
            title={status === 'loading'
              ? 'Wczytywanie własnych rozliczeń…'
              : 'Własne rozliczenia są teraz niedostępne'}
            hint="Nie pokazujemy częściowych kwot."
            action={status === 'error' ? <Button onClick={reload}>Spróbuj ponownie</Button> : null}
          />
        </section>
      ) : (
        <>
          <section className="finance-window__kpis" aria-label="Podsumowanie własnych rozliczeń">
            {[
              ['Należne', summary.due],
              ['Wpłacono', summary.collected],
              ['Pozostało do zapłaty', summary.outstanding],
            ].map(([label, value]) => <article className="finance-window__kpi" key={label}>
              <span>{label}</span>
              <strong>{fmtMoney(value / 100)}</strong>
            </article>)}
          </section>
          <section className="card finance-window__table" aria-labelledby="own-payments-title">
            <h2 className="card-title" id="own-payments-title">
              Własne sesje · {fmtMonthYear(selectedMonth)}
            </h2>
            <div className="table-scroll">
              <table className="table" aria-label="Własne rozliczenia sesji">
                <thead><tr>
                  <th>Data</th><th>Usługa</th><th className="right">Należne</th>
                  <th className="right">Wpłacono</th><th className="right">Pozostało</th>
                  <th>Forma</th><th>Płatność</th>
                </tr></thead>
                <tbody>{appointments.length === 0 ? <tr><td colSpan={7}>
                  <EmptyState icon="payments" title="Brak rozliczonych sesji w tym miesiącu" />
                </td></tr> : pageItems.map((appointment) => <tr key={appointment.id}>
                  <td>{fmtShortDate(appointment.startsAt.slice(0, 10))}</td>
                  <td>{SERVICE_BY_ID[appointment.serviceId].label}</td>
                  <td className="right num-cell">
                    {fmtMoney(appointment.charge.expectedAmountGrosze / 100)}
                  </td>
                  <td className="right num-cell">
                    {fmtMoney(appointment.payment.collectedGrosze / 100)}
                  </td>
                  <td className="right num-cell">
                    {fmtMoney(appointment.payment.outstandingGrosze / 100)}
                  </td>
                  <td>{appointment.payment.latestMethod
                    ? METHOD_LABELS[appointment.payment.latestMethod] : '—'}</td>
                  <td><Pill tone={appointment.payment.status === 'paid' ? 'sage' : 'amber'}>
                    {paymentLabel[appointment.payment.status]}
                  </Pill></td>
                </tr>)}</tbody>
              </table>
            </div>
            <Pager page={page} pages={pages} onPage={setPage} label="Stronicowanie własnych rozliczeń" />
          </section>
        </>
      )}
    </div>
  )
}
