import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, sessionsInMonth, availableMonths } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useFlip } from '../anim.js'
import {
  Avatar, Chip, IconBtn, Button, InfoTip, EmptyState, Figure, Field, Popover,
  usePagination, Pager,
} from '../ui.jsx'
import { FilterGroup, useRouteParamsSync } from '../ux-patterns.jsx'
import { Icon } from '../icons.jsx'
import { BarFill } from '../charts.jsx'
import { PaymentPicker } from './session-bits.jsx'
import {
  cap, fmtFullDate, fmtMoney, monthKey, addMonths, fmtMonthYear, fmtShortDate,
  isBillable, collectedOf, outstandingOf, sessionsWord, METHOD_LABELS, toISODate,
} from '../format.js'
import { paymentEntryFor, paymentSnapshotOf, scopedBillingSummary } from '../workspace.js'

const validMonth = (value) => /^\d{4}-\d{2}$/.test(value || '')

function PaymentEntry({ session, client, onBook, fallbackFocusRef }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ amount: '', method: '' })
  const [errors, setErrors] = useState({})
  const wrapRef = useRef(null)
  const amountRef = useRef(null)
  const methodRef = useRef(null)
  const remainder = Math.round(outstandingOf(session) * 100) / 100

  const begin = () => {
    setForm({ amount: String(remainder), method: session.method || '' })
    setErrors({})
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => amountRef.current?.focus({ preventScroll: true }))
  }, [open])

  const focusAfterClose = (useFallback = false) => {
    requestAnimationFrame(() => {
      const trigger = wrapRef.current?.querySelector('button')
      const target = useFallback ? fallbackFocusRef?.current : trigger || fallbackFocusRef?.current
      target?.focus({ preventScroll: true })
    })
  }

  const cancel = () => {
    setOpen(false)
    focusAfterClose()
  }

  const save = (event) => {
    event.preventDefault()
    const result = paymentEntryFor(session, {
      amount: form.amount,
      method: form.method,
      paidDate: toISODate(new Date()),
    })
    setErrors(result.errors)
    if (!result.patch) {
      requestAnimationFrame(() => {
        if (result.errors.amount) amountRef.current?.focus({ preventScroll: true })
        else if (result.errors.method) methodRef.current?.focus({ preventScroll: true })
      })
      return
    }
    onBook(result.patch)
    setOpen(false)
    focusAfterClose(result.patch.payment === 'paid')
  }

  return (
    <span ref={wrapRef}>
      <Popover
        open={open}
        setOpen={setOpen}
        contentRole="dialog"
        ariaLabel="Zaksięguj wpłatę"
        align="right"
        trigger={(
          <Button
            variant="soft"
            size="sm"
            aria-haspopup="dialog"
            aria-label={`Zaksięguj wpłatę — ${client?.name || 'klient'}, ${fmtFullDate(session.date)}`}
            onClick={begin}
          >
            Zaksięguj
          </Button>
        )}
      >
        <form className="payment-entry" onSubmit={save} noValidate>
          <div>
            <strong>{client?.name || 'Klient'}</strong>
            <p>{fmtFullDate(session.date)} · pozostało {fmtMoney(remainder)}</p>
          </div>
          <Field label="Kwota wpłaty" error={errors.amount}>
            <input
              ref={amountRef}
              className="input"
              type="number"
              min="0.01"
              max={remainder}
              step="0.01"
              inputMode="decimal"
              name="payment-amount"
              autoComplete="off"
              value={form.amount}
              onChange={(event) => {
                setForm((current) => ({ ...current, amount: event.target.value }))
                setErrors((current) => ({ ...current, amount: null }))
              }}
            />
          </Field>
          <Field label="Forma płatności" error={errors.method}>
            <select
              ref={methodRef}
              className="select"
              name="payment-method"
              autoComplete="off"
              value={form.method}
              onChange={(event) => {
                setForm((current) => ({ ...current, method: event.target.value }))
                setErrors((current) => ({ ...current, method: null }))
              }}
            >
              <option value="">Wybierz</option>
              {Object.entries(METHOD_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>
          <div className="payment-entry__actions">
            <Button size="sm" variant="ghost" onClick={cancel}>Anuluj</Button>
            <Button size="sm" type="submit">Zapisz wpłatę</Button>
          </div>
        </form>
      </Popover>
    </span>
  )
}

export function Payments() {
  const { state, dispatch, toast } = useApp()
  const { getViewState, openSessionForm, patchViewState, route } = useShell()
  const ref = useReveal()
  const ledgerTitleRef = useRef(null)
  const maxYm = monthKey(new Date())
  const [initial] = useState(() => {
    const saved = getViewState('payments', {
      allPeriods: false,
      ym: maxYm,
      specialist: null,
      unpaidOnly: false,
      page: 1,
    })
    return {
      allPeriods: typeof route.params?.allPeriods === 'boolean'
        ? route.params.allPeriods
        : saved.allPeriods === true,
      // URL params win over the registry — a shared link must reproduce its scope
      ym: validMonth(route.params?.ym)
        ? route.params.ym
        : validMonth(saved.ym) ? saved.ym : maxYm,
      specialist: state.psychologists.some((psychologist) => psychologist.id === route.params?.specialist)
        ? route.params.specialist
        : state.psychologists.some((psychologist) => psychologist.id === saved.specialist)
          ? saved.specialist
          : null,
      unpaidOnly: typeof route.params?.unpaidOnly === 'boolean'
        ? route.params.unpaidOnly
        : saved.unpaidOnly === true,
      page: Math.max(1, Number(route.params?.page ?? saved.page) || 1),
    }
  })
  const [ym, setYm] = useState(initial.ym)
  const [allPeriods, setAllPeriods] = useState(initial.allPeriods)
  const [psychFilter, setPsychFilter] = useState(initial.specialist)
  const [unpaidOnly, setUnpaidOnly] = useState(initial.unpaidOnly)

  const months = useMemo(() => availableMonths(state.sessions), [state.sessions])
  const psychologists = useMemo(
    () => state.psychologists.toSorted((a, b) => a.name.localeCompare(b.name, 'pl')),
    [state.psychologists]
  )
  const periodSessions = useMemo(
    () => allPeriods ? state.sessions : sessionsInMonth(state.sessions, ym),
    [allPeriods, state.sessions, ym]
  )
  const periodBillable = useMemo(() => periodSessions.filter(isBillable), [periodSessions])
  const scopedBillable = useMemo(
    () => periodBillable.filter((session) => !psychFilter || session.psychId === psychFilter).reverse(),
    [periodBillable, psychFilter]
  )
  const ledgerRows = useMemo(
    () => scopedBillable.filter((session) => !unpaidOnly || outstandingOf(session) > 0),
    [scopedBillable, unpaidOnly]
  )
  const summary = useMemo(
    () => scopedBillingSummary(periodSessions, { psychId: psychFilter }),
    [periodSessions, psychFilter]
  )

  const { pageItems, page, pages, setPage } = usePagination(ledgerRows, {
    pageSize: 25,
    resetKey: `${allPeriods}|${ym}|${psychFilter}|${unpaidOnly}`,
    initialPage: initial.page,
  })
  const flipRef = useFlip(pageItems.map((session) => session.id).join(','))

  useEffect(() => {
    patchViewState('payments', {
      allPeriods,
      ym,
      specialist: psychFilter,
      unpaidOnly,
      page,
    })
  }, [allPeriods, page, patchViewState, psychFilter, unpaidOnly, ym])

  // the whole ledger scope lives in the URL, so a filtered month can be shared
  useRouteParamsSync('payments', {
    allPeriods: allPeriods || undefined,
    unpaidOnly: unpaidOnly || undefined,
    specialist: psychFilter || undefined,
    ym: allPeriods ? undefined : ym,
    page: page > 1 ? page : undefined,
  })

  const comparisonPsychologists = psychFilter
    ? psychologists.filter((psychologist) => psychologist.id === psychFilter)
    : psychologists
  const comparison = useMemo(() => {
    const totals = new Map(comparisonPsychologists.map((psychologist) => [
      psychologist.id,
      { psychologist, collected: 0, outstanding: 0 },
    ]))
    for (const session of periodBillable) {
      const item = totals.get(session.psychId)
      if (!item) continue
      item.collected += collectedOf(session)
      item.outstanding += outstandingOf(session)
    }
    return [...totals.values()]
  }, [comparisonPsychologists, periodBillable])
  const maxPsych = Math.max(...comparison.map((item) => item.collected + item.outstanding), 1)

  const clientOf = (id) => state.clients.find((client) => client.id === id)
  const psychOf = (id) => state.psychologists.find((psychologist) => psychologist.id === id)
  const selectedPsychologist = psychFilter ? psychOf(psychFilter) : null
  const periodLabel = allPeriods ? 'Wszystkie okresy' : cap(fmtMonthYear(ym))
  const scopeLabel = `${periodLabel} · ${selectedPsychologist?.name || 'Cały zespół'}`

  const bookPayment = (session, patch) => {
    const snapshot = paymentSnapshotOf(session)
    const amount = patch.paidAmount - snapshot.paidAmount
    const client = clientOf(session.clientId)
    dispatch({ type: 'UPDATE_SESSION', id: session.id, patch })
    toast(`Zaksięgowano wpłatę ${fmtMoney(amount)} — ${client?.name || 'klient'}`, 'payments', {
      label: 'Cofnij',
      key: `payment:${session.id}`,
      timeoutMs: 5000,
      onClick: () => dispatch({ type: 'UPDATE_SESSION', id: session.id, patch: snapshot }),
    })
  }

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Rozliczenia</div>
          <h1 className="display view-head__title">Finanse <em>i płatności</em></h1>
          <p className="view-head__sub">
            Sesje rozliczane: odbyte i nieobecności. Odwołane nie są fakturowane.
          </p>
        </div>
      </div>

      <section className="finance-scope" role="region" aria-label="Zakres finansów" data-reveal>
        <div className="finance-scope__summary">Zakres: {scopeLabel}</div>
        <div className="finance-scope__controls">
          <FilterGroup label="Okres">
            <Chip on={!allPeriods} onClick={() => setAllPeriods(false)}>Wybrany miesiąc</Chip>
            <Chip on={allPeriods} onClick={() => setAllPeriods(true)}>Wszystkie okresy</Chip>
            {!allPeriods && (
              <div className="month-nav">
                <IconBtn name="chevL" label="Poprzedni miesiąc" disabled={ym <= months[0]} onClick={() => setYm(addMonths(ym, -1))} />
                <span className="month-nav__label">{fmtMonthYear(ym)}</span>
                <IconBtn name="chevR" label="Następny miesiąc" disabled={ym >= maxYm} onClick={() => setYm(addMonths(ym, 1))} />
              </div>
            )}
          </FilterGroup>
          <FilterGroup label="Specjalistka">
            <Chip on={!psychFilter} onClick={() => setPsychFilter(null)}>Cały zespół</Chip>
            {psychologists.map((psychologist) => (
              <Chip
                key={psychologist.id}
                on={psychFilter === psychologist.id}
                swatch={psychologist.color}
                aria-label={psychologist.name}
                onClick={() => setPsychFilter(psychologist.id)}
              >
                {psychologist.name.split(' ')[0]}
              </Chip>
            ))}
          </FilterGroup>
        </div>
      </section>

      <div className="figures" role="group" aria-label={`Rozliczenia — ${scopeLabel}`}>
        <Figure
          label={<><span className="finance-figure-label">Należne za rozliczone sesje</span> <InfoTip text={allPeriods
            ? 'Suma kwot za sesje rozliczane we wszystkich okresach — odbyte i nieobecności. Sesje odwołane nie są fakturowane.'
            : 'Suma kwot za sesje rozliczane w tym miesiącu — odbyte i nieobecności. Sesje odwołane nie są fakturowane.'
          } /></>}
          value={summary.due}
          fmt={fmtMoney}
        />
        <Figure
          label={<><span className="finance-figure-label">Wpłacono</span> <InfoTip text="Gotówka już wpłacona przez klientów, łącznie z wpłatami częściowymi." /></>}
          value={summary.collected}
          fmt={fmtMoney}
        />
        <Figure
          label={<><span className="finance-figure-label">Pozostało do zapłaty</span> <InfoTip text="Część należności, której klienci jeszcze nie wpłacili." /></>}
          value={summary.outstanding}
          fmt={fmtMoney}
          attention
        />
      </div>

      {summary.due > 0 && (
        <div className="collect" data-reveal>
          <div className="hbar__track" style={{ height: 16 }}>
            <BarFill
              segments={[
                { value: summary.collected, color: 'var(--sage)', label: 'wpłacono' },
                { value: summary.outstanding, color: 'var(--amber-mid)', label: 'pozostało do zapłaty' },
              ]}
              totalMax={summary.due}
            />
          </div>
          <div className="row row--between collect__labels">
            <span className="muted">
              wpłacono {fmtMoney(summary.collected)} · {Math.round((summary.collected / summary.due) * 100)}%
            </span>
            {summary.outstanding > 0
              ? <span className="collect__due">pozostało {fmtMoney(summary.outstanding)}</span>
              : <span className="collect__ok">wszystko rozliczone</span>}
          </div>
        </div>
      )}

      <div className="grid-13 finance-grid" style={{ marginTop: 4 }}>
        <section className="card card--pad" data-reveal role="region" aria-label="Porównanie specjalistek" style={{ alignSelf: 'start' }}>
          <h2 className="card-title">Porównanie specjalistek · {periodLabel.toLowerCase()}</h2>
          <div className="hbar" style={{ marginTop: 20 }}>
            {comparison.map(({ psychologist, collected, outstanding }) => (
              <div className="hbar__row hbar__row--labeled finance-comparison__row" key={psychologist.id}>
                <span className="hbar__name">
                  <Avatar name={psychologist.name} color={psychologist.color} size={26} />
                  <span>{psychologist.name.split(' ')[0]}</span>
                </span>
                <div>
                  <div className="hbar__track">
                    <BarFill
                      segments={[
                        { value: collected, color: 'var(--sage)', label: 'wpłacono' },
                        { value: outstanding, color: 'var(--amber-mid)', label: 'pozostało do zapłaty' },
                      ]}
                      totalMax={maxPsych}
                    />
                  </div>
                  <div className="row row--between finance-comparison__amounts">
                    <span className="muted">{fmtMoney(collected)} wpłacono</span>
                    {outstanding > 0 && <span>{fmtMoney(outstanding)} pozostało</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="legend" style={{ marginTop: 18 }}>
            <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--sage)' }} /> Wpłacono</span>
            <span className="legend__item"><span className="legend__swatch" style={{ background: 'var(--amber-mid)' }} /> Pozostało do zapłaty</span>
          </div>
        </section>

        <section className="card finance-ledger" data-reveal aria-labelledby="finance-ledger-title">
          <div className="finance-ledger__head">
            <div>
              <h2 className="card-title" id="finance-ledger-title" ref={ledgerTitleRef} tabIndex={-1}>Lista rozliczeń</h2>
              <span className="faint">{ledgerRows.length} {sessionsWord(ledgerRows.length)}</span>
            </div>
            <section className="ledger-filters" role="region" aria-label="Filtry listy rozliczeń">
              <p>Dotyczy tylko: <strong>Lista rozliczeń</strong></p>
              <FilterGroup label="Płatność">
                <Chip on={!unpaidOnly} onClick={() => setUnpaidOnly(false)}>Wszystkie płatności</Chip>
                <Chip on={unpaidOnly} onClick={() => setUnpaidOnly(true)}>Pozostałe do zapłaty</Chip>
              </FilterGroup>
            </section>
          </div>
          <div className="table-scroll">
            <table className="table" aria-label="Lista rozliczeń">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Klient</th>
                  <th>Specjalistka</th>
                  <th className="right">Należne</th>
                  <th className="right">Wpłacono</th>
                  <th>Forma</th>
                  <th>Płatność</th>
                  <th></th>
                </tr>
              </thead>
              <tbody ref={flipRef}>
                {ledgerRows.length === 0 && (
                  <tr>
                    <td colSpan={8}>
                      {scopedBillable.length === 0 ? (
                        <EmptyState
                          icon="payments"
                          title={allPeriods ? 'Brak rozliczeń we wszystkich okresach' : 'Brak rozliczeń w tym miesiącu'}
                          hint="Rozliczane są sesje odbyte i nieobecności — pojawią się tu po zakończeniu."
                        />
                      ) : (
                        <EmptyState
                          icon="search"
                          title="Brak kwot pozostałych do zapłaty"
                          hint="Wszystkie należności w tym zakresie zostały wpłacone."
                        />
                      )}
                    </td>
                  </tr>
                )}
                {pageItems.map((session) => {
                  const psychologist = psychOf(session.psychId)
                  const client = clientOf(session.clientId)
                  const outstanding = outstandingOf(session)
                  return (
                    <tr
                      key={session.id}
                      data-flip-id={session.id}
                      data-session-id={session.id}
                      data-payment={session.payment}
                      data-paid-amount={String(session.paidAmount ?? 0)}
                      data-method={session.method || ''}
                      data-paid-date={session.paidDate || ''}
                      data-outstanding={String(outstanding)}
                      className={outstanding > 0 ? 'is-due' : ''}
                    >
                      <td style={{ fontWeight: 600 }}>{fmtShortDate(session.date)}</td>
                      <td>{client?.name}</td>
                      <td>
                        <span className="row" style={{ gap: 8 }}>
                          <span className="finance-ledger__swatch" style={{ background: psychologist?.color }} />
                          <span className="muted">{psychologist ? psychologist.name.split(' ')[0] : '—'}</span>
                        </span>
                      </td>
                      <td className="right num-cell">{fmtMoney(session.amount)}</td>
                      <td className="right num-cell muted">{fmtMoney(collectedOf(session))}</td>
                      <td className="muted">{METHOD_LABELS[session.method] || '—'}</td>
                      <td><PaymentPicker session={session} readOnly /></td>
                      <td className="right">
                        {outstanding > 0 ? (
                          <PaymentEntry
                            session={session}
                            client={client}
                            fallbackFocusRef={ledgerTitleRef}
                            onBook={(patch) => bookPayment(session, patch)}
                          />
                        ) : (
                          <Icon name="check" size={16} style={{ color: 'var(--sage-deep)' }} />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={pages} onPage={setPage} />
        </section>
      </div>
    </div>
  )
}
