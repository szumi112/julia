import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useClientMutationLock, useWorkspaceWindow, clientOutstanding, lastSessionOf } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useFlip } from '../anim.js'
import { Button, Avatar, Pill, Chip, SearchInput, IconBtn, EmptyState, Segmented, usePagination, Pager } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { StatusPicker, PaymentPicker } from './session-bits.jsx'
import { ClientDrawer } from './ClientForm.jsx'
import { ageLabel, addMonths, fmtMoney, fmtMonthYear, fmtShortDate, fmtFullDate, fmtDayMonth, fmtWeekday, cap, monthKey, sessionsWord, toISODate, pad2, plural, STATUS_LABELS, PAY_LABELS } from '../format.js'
import { clientMatchesQuery, clientsForRole, sessionsForRole } from '../workspace.js'
import { serviceBadge, serviceShort } from '../services.js'
import { EntityLink, FilterBar, FilterGroup, useRouteParamsSync } from '../ux-patterns.jsx'
import {
  monthWorkspaceRange,
  rollingWorkspaceRange,
  specialistIdentityFor,
} from '../workspace-view.js'
import { canPerformAction } from '../capability-access.js'
import {
  historicalClientDirectoryModel,
  historicalClientHistoryModel,
  latestPopulatedMonthAction,
  resolveClientCatalogViewState,
} from '../historical-workspace-view.js'
import { HistoricalOccurrenceRow } from './historical-bits.jsx'
import { HistoricalClientActivation } from './HistoricalClientActivation.jsx'

// the client's next scheduled visit — sessions stay sorted by date+time
const nextSessionOf = (sessions, clientId) => {
  const now = new Date()
  const today = toISODate(now)
  const nowTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  return sessions.find(
    (s) => s.clientId === clientId && s.status === 'scheduled' &&
      (s.date > today || (s.date === today && s.time >= nowTime))
  )
}

function HistoricalHistorySections({ history }) {
  return (
    <div className="historical-client-history">
      <section className="card card--pad historical-section" aria-labelledby="historical-exact-title">
        <h2 className="card-title" id="historical-exact-title">Dokładne daty</h2>
        {history.exactDayRows.length > 0 ? history.exactDayRows.map((row) => (
          <div className="historical-client-history__entry" key={row.id}>
            <time dateTime={row.day}>{fmtFullDate(row.day)}</time>
            <HistoricalOccurrenceRow row={row} date={row.day} />
          </div>
        )) : <p className="faint">Brak wpisów z dokładną datą w widocznym zakresie.</p>}
      </section>
      <section className="card card--pad historical-section" aria-labelledby="historical-months-title">
        <h2 className="card-title" id="historical-months-title">Miesiące bez dnia</h2>
        {history.monthOnlyRows.length > 0 ? history.monthOnlyRows.map((row) => (
          <div className="historical-client-history__entry" key={row.id}>
            <time dateTime={row.month}>{fmtMonthYear(row.month)}</time>
            <HistoricalOccurrenceRow row={row} />
          </div>
        )) : <p className="faint">Brak wpisów miesięcznych w widocznym zakresie.</p>}
      </section>
      <section className="card card--pad historical-section" aria-labelledby="historical-unknown-title">
        <h2 className="card-title" id="historical-unknown-title">Okres nieustalony</h2>
        {history.unknownRows.length > 0 ? history.unknownRows.map((row) => (
          <HistoricalOccurrenceRow key={row.id} row={row} />
        )) : <p className="faint">Brak wpisów z nieustalonym okresem.</p>}
      </section>
    </div>
  )
}

function HistoricalClientsPanel({
  directory, historyPeriod, historyYm, latestAction, onCatalog, onHistoryPeriod,
  onHistoryYm, query, setQuery,
}) {
  return (
    <div>
      <div className="view-head">
        <div>
          <div className="eyebrow">Kartoteka źródłowa</div>
          <h1 className="display view-head__title">Klienci <em>historyczni</em></h1>
          <p className="view-head__sub">Profile i wizyty odtworzone ze skoroszytu, bez dopisywania bieżącej opieki.</p>
        </div>
        <div className="view-head__actions historical-directory__actions">
          <SearchInput value={query} onChange={setQuery} placeholder="Imię, usługa lub specjalistka…" />
          <Segmented
            ariaLabel="Kartoteka klientów"
            value="historical"
            onChange={onCatalog}
            options={[
              { value: 'current', label: 'Bieżący' },
              { value: 'historical', label: 'Historia skoroszytu' },
            ]}
          />
        </div>
      </div>
      <div className="historical-directory__toolbar">
        <div className="month-nav">
          <IconBtn name="chevL" label="Poprzedni miesiąc" onClick={() => onHistoryYm(addMonths(historyYm, -1))} />
          <span className="month-nav__label month-nav__label--sentence">{cap(fmtMonthYear(historyYm))}</span>
          <IconBtn name="chevR" label="Następny miesiąc" onClick={() => onHistoryYm(addMonths(historyYm, 1))} />
        </div>
        <Segmented
          ariaLabel="Okres historii"
          value={historyPeriod}
          onChange={onHistoryPeriod}
          options={[
            { value: 'known', label: 'Znany okres' },
            { value: 'unknown', label: 'Okres nieustalony' },
          ]}
        />
      </div>
      {directory.length === 0 ? (
        <section className="card card--pad historical-zero" aria-live="polite">
          <h2 className="card-title">Brak profili historycznych</h2>
          <p>{historyPeriod === 'unknown'
            ? 'Nie ma klientów z wpisami o nieustalonym okresie.'
            : `W ${fmtMonthYear(historyYm)} nie ma profili ze skoroszytu.`}</p>
          {latestAction && <Button variant="soft" onClick={() => onHistoryYm(latestAction.month)}>{latestAction.label}</Button>}
        </section>
      ) : (
        <div className="card card--table">
          <div className="table-scroll table-scroll--until-tablet">
            <table className="table table--cards" aria-label="Klienci historyczni">
              <thead>
                <tr><th>Klient</th><th>Wpisy źródłowe</th><th>Okres</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {directory.map((client) => (
                  <tr key={client.id} className="historical-client-row" data-history-client-id={client.id}>
                    <td data-th="Klient"><strong>{client.name}</strong></td>
                    <td data-th="Wpisy źródłowe">{client.visitCount}</td>
                    <td data-th="Okres">{client.periodSummary}</td>
                    <td data-th="Status"><Pill tone={client.activeClientId ? 'sage' : 'sky'}>{client.lifecycle}</Pill></td>
                    <td data-th="Karta" className="td--actions">
                      <EntityLink
                        route="client"
                        params={historyPeriod === 'unknown'
                          ? { id: client.id, historyPeriod: 'unknown' }
                          : { id: client.id, ym: historyYm }}
                        label={`Otwórz historię — ${client.name}`}
                        className="link"
                      >
                        Historia
                      </EntityLink>
                      {client.activeClientId && (
                        <EntityLink
                          route="client"
                          params={{ id: client.activeClientId, ym: historyYm }}
                          label={`Otwórz aktywną kartę — ${client.name}`}
                          className="link"
                        >
                          Aktywna karta
                        </EntityLink>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function HistoricalClientDetail({ historicalClient, occurrences, specialists, workspaceRange }) {
  const { capabilities, role } = useShell()
  const { locked: clientMutationLocked } = useClientMutationLock()
  const identityRef = useRef(null)
  const [activationOpen, setActivationOpen] = useState(false)
  const history = useMemo(() => historicalClientHistoryModel({
    historicalClient, occurrences, specialists,
  }), [historicalClient, occurrences, specialists])
  const canActivate = historicalClient.status === 'historical'
    && role.scope === 'centre'
    && ['owner', 'coordinator'].includes(role.id)
    && canPerformAction(capabilities, 'client.historical.activate')
  const closeActivation = () => {
    setActivationOpen(false)
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (!active || active === document.body || !active.isConnected) {
        identityRef.current?.focus()
      }
    })
  }
  return (
    <div>
      <EntityLink route="clients" params={{ catalog: 'historical' }} className="link row historical-back-link">
        <Icon name="arrowL" size={16} /> Wróć do klientów historycznych
      </EntityLink>
      <div className="id-band historical-client-band" ref={identityRef} tabIndex={-1}>
        <Avatar name={historicalClient.name} size={64} />
        <div className="id-band__main">
          <p className="eyebrow id-band__eyebrow">Profil ze skoroszytu</p>
          <h1 className="display id-band__name">{historicalClient.name}</h1>
          <div className="id-band__pills">
            <Pill tone={historicalClient.activeClientId ? 'sage' : 'sky'}>
              {historicalClient.activeClientId ? 'Aktywowano' : 'Historyczny'}
            </Pill>
          </div>
        </div>
        {historicalClient.activeClientId && (
          <div className="id-band__actions">
            <EntityLink route="client" params={{ id: historicalClient.activeClientId }} className="btn btn--soft">
              Otwórz aktywną kartę
            </EntityLink>
          </div>
        )}
        {canActivate && (
          <div className="id-band__actions">
            <Button
              variant="primary"
              disabled={clientMutationLocked}
              onClick={() => setActivationOpen(true)}
            >
              Aktywuj klienta
            </Button>
          </div>
        )}
      </div>
      <HistoricalHistorySections history={history} />
      {activationOpen && (
        <HistoricalClientActivation
          historicalClient={historicalClient}
          workspaceRange={workspaceRange}
          onClose={closeActivation}
        />
      )}
    </div>
  )
}

function HistoricalSourceHistory({ historicalClient, occurrences, specialists, workspaceRange }) {
  const history = useMemo(() => historicalClientHistoryModel({
    historicalClient, occurrences, specialists,
  }), [historicalClient, occurrences, specialists])
  return (
    <section className="client-record__section" aria-label="Historia ze skoroszytu">
      <div className="card card--pad">
        <h2 className="card-title">Historia ze skoroszytu</h2>
        <p className="faint">
          Widoczny zakres: {fmtFullDate(workspaceRange.from)} – {fmtFullDate(workspaceRange.to)}.
          To odrębne wpisy źródłowe, nie historia frekwencji.
        </p>
        <HistoricalHistorySections history={history} />
      </div>
    </section>
  )
}

export function Clients({ params = {} }) {
  const { state } = useApp()
  const { appMode, capabilities, getViewState, openClientForm, patchViewState, role } = useShell()
  const isApp = appMode === 'app'
  const today = toISODate(new Date())
  const ref = useReveal()
  const initialState = useRef(null)
  if (!initialState.current) {
    const saved = getViewState('clients', {
      query: '',
      specialist: null,
      debtOnly: false,
      status: 'all',
      page: 1,
      catalog: 'current',
      historyYm: monthKey(today),
      historyPeriod: 'known',
    })
    const catalogState = resolveClientCatalogViewState({ params, persisted: saved, today })
    const requestedSpecialist = role.scope !== 'own'
      && typeof params.specialist === 'string'
      && state.psychologists.some((psychologist) => psychologist.id === params.specialist)
      ? params.specialist
      : null
    initialState.current = {
      query: typeof saved.query === 'string' ? saved.query : '',
      specialist: requestedSpecialist || (
        role.scope !== 'own' && state.psychologists.some((p) => p.id === saved.specialist)
          ? saved.specialist
          : null
      ),
      debtOnly: saved.debtOnly === true,
      status: ['active', 'paused'].includes(saved.status) ? saved.status : 'all',
      page: Math.max(1, Number(saved.page) || 1),
      ...catalogState,
    }
  }
  const [query, setQuery] = useState(initialState.current.query)
  const [psychFilter, setPsychFilter] = useState(initialState.current.specialist)
  const [debtOnly, setDebtOnly] = useState(initialState.current.debtOnly)
  const [statusFilter, setStatusFilter] = useState(initialState.current.status)
  const [catalog, setCatalog] = useState(initialState.current.catalog)
  const [historyYm, setHistoryYm] = useState(initialState.current.historyYm)
  const [historyPeriod, setHistoryPeriod] = useState(initialState.current.historyPeriod)
  const [clientForm, setClientForm] = useState(null)
  const workspaceRange = useMemo(
    () => isApp && catalog === 'historical'
      ? monthWorkspaceRange(historyYm)
      : rollingWorkspaceRange(today),
    [catalog, historyYm, isApp, today],
  )
  const workspaceState = useWorkspaceWindow(workspaceRange, isApp)
  const { locked: clientMutationLocked } = useClientMutationLock()
  const canManageClients = !isApp || canPerformAction(capabilities, 'client.create')
  const clientActionsLocked = isApp && clientMutationLocked
  const openClient = (opts = {}) => {
    if (isApp) {
      if (clientActionsLocked) return
      setClientForm({ ...opts, workspaceRange })
    }
    else openClientForm(opts)
  }

  const scopedClients = useMemo(
    () => clientsForRole(state, role).filter((client) => client.status !== 'archived'),
    [state, role]
  )
  const filtered = useMemo(() => {
    return scopedClients.filter((c) => {
      if (role.scope !== 'own' && psychFilter && c.psychId !== psychFilter) return false
      if (debtOnly && clientOutstanding(state.sessions, c.id) <= 0) return false
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (!clientMatchesQuery(c, query)) return false
      return true
    })
  }, [scopedClients, state.sessions, query, psychFilter, debtOnly, role.scope, statusFilter])

  const { pageItems, page, pages, setPage } = usePagination(filtered, {
    pageSize: 25,
    resetKey: `${query}|${psychFilter}|${debtOnly}|${statusFilter}`,
    initialPage: initialState.current.page,
  })
  const tbodyRef = useFlip(pageItems.map((c) => c.id).join(','))
  const psychologists = useMemo(
    () => state.psychologists.toSorted((a, b) => a.name.localeCompare(b.name, 'pl')),
    [state.psychologists]
  )
  const historySpecialists = useMemo(
    () => [...state.psychologists, ...(state.historicalSpecialists ?? [])],
    [state.historicalSpecialists, state.psychologists],
  )
  const historicalDirectory = useMemo(() => historicalClientDirectoryModel({
    historicalClients: isApp ? state.historicalClients : [],
    occurrences: isApp ? state.historicalOccurrences : [],
    specialists: isApp ? historySpecialists : [],
    ym: historyYm,
    periodMode: historyPeriod,
    query,
  }), [
    historyPeriod,
    historyYm,
    isApp,
    query,
    state.historicalClients,
    state.historicalOccurrences,
    historySpecialists,
  ])
  const historicalMonthCount = useMemo(() => isApp
    ? state.historicalOccurrences.filter((occurrence) => (
        occurrence.status === 'recorded'
        && occurrence.period.precision !== 'unknown'
        && occurrence.period.month === historyYm
      )).length
    : 0, [historyYm, isApp, state.historicalOccurrences])
  const latestHistoryAction = isApp && catalog === 'historical'
    && historyPeriod === 'known' && workspaceState === 'ready'
    ? latestPopulatedMonthAction({
        selectedMonth: historyYm,
        appointmentCount: 0,
        historicalCount: historicalMonthCount,
        latestPopulatedMonth: state.latestPopulatedMonth,
      })
    : null

  useEffect(() => {
    patchViewState('clients', {
      query,
      specialist: role.scope === 'own' ? null : psychFilter,
      debtOnly,
      status: statusFilter,
      page,
      catalog,
      historyYm,
      historyPeriod,
    })
  }, [catalog, debtOnly, historyPeriod, historyYm, page, patchViewState, psychFilter, query, role.scope, statusFilter])

  useRouteParamsSync('clients', catalog === 'historical'
    ? { catalog: 'historical', historyPeriod, ym: historyYm }
    : { specialist: role.scope !== 'own' ? psychFilter || undefined : undefined })

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)
  const activeFilterCount =
    (role.scope !== 'own' && psychFilter ? 1 : 0)
    + (debtOnly ? 1 : 0)
    + (statusFilter !== 'all' ? 1 : 0)
  const filterSummary = [
    role.scope !== 'own' && psychFilter
      ? `Specjalistka: ${psychOf(psychFilter)?.name.split(' ')[0]}`
      : null,
    debtOnly ? 'Płatności: z zaległościami' : null,
    statusFilter === 'active' ? 'Status klienta: aktywni' : null,
    statusFilter === 'paused' ? 'Status klienta: wstrzymani' : null,
  ].filter(Boolean).join(' · ')
  const clearFilters = () => {
    setPsychFilter(null)
    setDebtOnly(false)
    setStatusFilter('all')
  }

  if (isApp && workspaceState !== 'ready') {
    return (
      <section role="status" aria-label="Stan kartoteki">
        <EmptyState
          icon="clients"
          title={workspaceState === 'loading' ? 'Wczytywanie kartoteki…' : 'Kartoteka jest teraz niedostępna'}
          hint={workspaceState === 'loading'
            ? 'Pobieramy uprawniony zakres klientów i historii spotkań.'
            : 'Dane pozostają tylko do odczytu. Spróbuj ponownie po odświeżeniu strony.'}
        />
      </section>
    )
  }

  if (isApp && catalog === 'historical') {
    return (
      <div ref={ref}>
        <HistoricalClientsPanel
          directory={historicalDirectory}
          historyPeriod={historyPeriod}
          historyYm={historyYm}
          latestAction={latestHistoryAction}
          onCatalog={setCatalog}
          onHistoryPeriod={setHistoryPeriod}
          onHistoryYm={setHistoryYm}
          query={query}
          setQuery={setQuery}
        />
      </div>
    )
  }

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Kartoteka</div>
          <h1 className="display view-head__title">
            {role.scope === 'own' ? <>Moi <em>klienci</em></> : <>Klienci <em>centrum</em></>}
          </h1>
          <p className="view-head__sub">
            {scopedClients.length} {plural(scopedClients.length, 'osoba', 'osoby', 'osób')}
            {role.scope === 'own'
              ? ' przypisanych do Twojej opieki — wyszukuj i przechodź do kart klientów.'
              : ' pod opieką zespołu — wyszukuj, filtruj i przechodź do kart klientów.'}
          </p>
        </div>
        <div className="view-head__actions">
          <SearchInput value={query} onChange={setQuery} placeholder="Imię, e-mail lub telefon…" />
          {isApp && (
            <Segmented
              ariaLabel="Kartoteka klientów"
              value={catalog}
              onChange={setCatalog}
              options={[
                { value: 'current', label: 'Bieżący' },
                { value: 'historical', label: 'Historia skoroszytu' },
              ]}
            />
          )}
          {canManageClients && (
            <Button icon="plus" magnetic disabled={clientActionsLocked} onClick={() => openClient({ psychId: role.scope === 'own' ? role.psychId : psychFilter || undefined })}>
              Dodaj klienta
            </Button>
          )}
        </div>
      </div>

      <div data-reveal>
        <FilterBar
          activeCount={activeFilterCount}
          summary={filterSummary}
          onClear={clearFilters}
          label="Filtry klientów"
        >
          {role.scope !== 'own' && (
            <FilterGroup label="Specjalistka">
              <Chip on={!psychFilter} onClick={() => setPsychFilter(null)}>Cały zespół</Chip>
              {psychologists.map((p) => (
                <Chip
                  key={p.id}
                  on={psychFilter === p.id}
                  swatch={p.color}
                  onClick={() => setPsychFilter(p.id)}
                >
                  {p.name.split(' ')[0]}
                </Chip>
              ))}
            </FilterGroup>
          )}
          <FilterGroup label="Płatności">
            <Chip on={!debtOnly} onClick={() => setDebtOnly(false)}>Wszystkie</Chip>
            <Chip on={debtOnly} onClick={() => setDebtOnly(true)}>
              <Icon name="payments" size={14} /> Z zaległościami
            </Chip>
          </FilterGroup>
          <FilterGroup label="Status klienta">
            <Chip on={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>Wszyscy</Chip>
            <Chip on={statusFilter === 'active'} onClick={() => setStatusFilter('active')}>Aktywni</Chip>
            <Chip on={statusFilter === 'paused'} onClick={() => setStatusFilter('paused')}>Wstrzymani</Chip>
          </FilterGroup>
        </FilterBar>
      </div>

      <p className="client-results" role="status" aria-live="polite">
        {filtered.length} {plural(filtered.length, 'wynik', 'wyniki', 'wyników')}
      </p>

      <div className="card card--table" data-reveal>
        <div className="table-scroll table-scroll--until-tablet">
        <table className="table table--cards">
          <thead>
            <tr>
              <th>Klient</th>
              <th>Opieka</th>
              <th>Ostatnia sesja</th>
              <th>Następna sesja</th>
              <th className="right">Zaległość</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6}>
                  {scopedClients.length === 0 ? (
                    <EmptyState
                      icon="clients"
                      title="Kartoteka jest jeszcze pusta"
                      hint="Dodaj pierwszego klienta, aby planować sesje i rozliczenia."
                      action={canManageClients && <Button size="sm" icon="plus" disabled={clientActionsLocked} onClick={() => openClient()}>Dodaj klienta</Button>}
                    />
                  ) : (
                    <EmptyState
                      icon="search"
                      title="Nie znaleziono klientów"
                      hint="Zmień wyszukiwanie lub filtry — albo dodaj nową osobę."
                      action={canManageClients && <Button size="sm" variant="soft" icon="plus" disabled={clientActionsLocked} onClick={() => openClient()}>Dodaj klienta</Button>}
                    />
                  )}
                </td>
              </tr>
            )}
            {pageItems.map((c) => {
              const p = psychOf(c.psychId)
              const specialist = specialistIdentityFor(state.psychologists, c.psychId)
              const last = lastSessionOf(state.sessions, c.id)
              const next = nextSessionOf(state.sessions, c.id)
              const debt = clientOutstanding(state.sessions, c.id)
              return (
                <tr
                  key={c.id}
                  data-flip-id={c.id}
                  className="client-row"
                >
                  <td>
                    <EntityLink
                      route="client"
                      params={{ id: c.id }}
                      label={`Otwórz kartę — ${c.name}`}
                      className="client-entity-link"
                    >
                      <Avatar name={c.name} color={p?.color} size={36} />
                      <span>
                        <span style={{ fontWeight: 650, display: 'block' }}>{c.name}</span>
                        <span className="faint" style={{ fontSize: 12.5 }}>
                          {[ageLabel(c.age, c.age), c.phone].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </EntityLink>
                  </td>
                  <td data-th="Opieka">
                    <span className="row" style={{ gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: p?.color, display: 'inline-block' }} />
                      <span className="muted">{specialist.name}</span>
                    </span>
                  </td>
                  <td className="num-cell muted" data-th="Ostatnia sesja">{last ? fmtShortDate(last.date) : '—'}</td>
                  <td data-th="Następna sesja">
                    {next
                      ? <span className="num-cell" style={{ fontWeight: 600 }}>{fmtShortDate(next.date)} · {next.time}</span>
                      : <span className="faint">nie umówiono</span>}
                  </td>
                  <td className="right" data-th="Zaległość">
                    {debt > 0 ? <Pill tone="coral">{fmtMoney(debt)}</Pill> : <span className="faint">—</span>}
                  </td>
                  <td data-th="Status">
                    <Pill tone={c.status === 'active' ? 'sage' : 'pink'} dot>
                      {c.status === 'active' ? 'Aktywny' : 'Wstrzymany'}
                    </Pill>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
        <Pager page={page} pages={pages} onPage={setPage} />
      </div>
      {clientForm && <ClientDrawer opts={clientForm} onClose={() => setClientForm(null)} />}
    </div>
  )
}

export function ClientDetail({ params }) {
  const { state, dispatch, toast } = useApp()
  const { appMode, capabilities, openSessionForm, openClientForm, role } = useShell()
  const isApp = appMode === 'app'
  const todayIso = toISODate(new Date())
  const detailYm = /^\d{4}-(0[1-9]|1[0-2])$/.test(params?.ym || '')
    ? params.ym : monthKey(todayIso)
  const usesHistoricalWindow = isApp && (
    /^hcl_/.test(params?.id || '')
    || /^\d{4}-(0[1-9]|1[0-2])$/.test(params?.ym || '')
    || params?.historyPeriod === 'unknown'
  )
  const workspaceRange = useMemo(
    () => usesHistoricalWindow ? monthWorkspaceRange(detailYm) : rollingWorkspaceRange(todayIso),
    [detailYm, todayIso, usesHistoricalWindow],
  )
  const workspaceState = useWorkspaceWindow(workspaceRange, isApp)
  const ref = useReveal([params.id])
  const [noteText, setNoteText] = useState('')
  const [clientForm, setClientForm] = useState(null)
  const { locked: clientMutationLocked } = useClientMutationLock()
  const client = clientsForRole(state, role).find((candidate) => candidate.id === params.id)
  const historicalClient = isApp
    ? state.historicalClients.find((candidate) => candidate.id === params.id)
    : null
  const historySpecialists = useMemo(
    () => [...state.psychologists, ...(state.historicalSpecialists ?? [])],
    [state.historicalSpecialists, state.psychologists],
  )
  const linkedHistoricalClient = isApp && client
    ? state.historicalClients.find((candidate) => candidate.activeClientId === client.id)
    : null
  const all = client
    ? sessionsForRole(state, role).filter((session) => session.clientId === client.id)
    : []
  // upcoming care first, everything else newest-first below it
  const now = new Date()
  const nowTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  const upcoming = all.filter(
    (s) => s.status === 'scheduled' && (s.date > todayIso || (s.date === todayIso && s.time >= nowTime))
  )
  const upcomingIds = new Set(upcoming.map((s) => s.id))
  const history = all.filter((s) => !upcomingIds.has(s.id)).slice().reverse()
  const historyPages = usePagination(history, { pageSize: 10, resetKey: params.id })
  if (isApp && workspaceState !== 'ready') {
    return (
      <section role="status" aria-label="Stan karty klienta">
        <EmptyState
          icon="clients"
          title={workspaceState === 'loading' ? 'Wczytywanie karty klienta…' : 'Karta klienta jest teraz niedostępna'}
          hint="Wyświetlimy wyłącznie dane z uprawnionego, kompletnego zakresu."
        />
      </section>
    )
  }
  if (historicalClient) {
    return (
      <div ref={ref}>
        <HistoricalClientDetail
          historicalClient={historicalClient}
          occurrences={state.historicalOccurrences}
          specialists={historySpecialists}
          workspaceRange={workspaceRange}
        />
      </div>
    )
  }
  if (!client) {
    return (
      <EmptyState
        icon="clients"
        title="Nie znaleziono klienta"
        hint="Być może został usunięty z kartoteki."
        action={<EntityLink route="clients" className="btn btn--soft btn--sm">Wróć do listy</EntityLink>}
      />
    )
  }

  const psych = state.psychologists.find((p) => p.id === client.psychId)
  const completed = all.filter((s) => s.status === 'completed')
  const debt = clientOutstanding(state.sessions, client.id)
  const next = upcoming[0] || null
  const family = client.familyId
    ? state.clients.filter((c) => c.familyId === client.familyId && c.id !== client.id)
    : []
  const canReadClinicalNotes = !isApp && role.scope === 'own' && client.psychId === role.psychId
  const canEditClient = !clientMutationLocked && !client.readOnly
    && (!isApp || canPerformAction(capabilities, 'client.edit'))
    && (role.scope !== 'own' || client.psychId === role.psychId)
  const canManageCare = !isApp && !client.readOnly
    && (role.scope !== 'own' || client.psychId === role.psychId)
  const openClient = () => {
    if (isApp) {
      if (clientMutationLocked) return
      setClientForm({ client, workspaceRange })
    }
    else openClientForm({ client })
  }

  const addNote = () => {
    if (!canReadClinicalNotes) return
    const text = noteText.trim()
    if (!text) return
    dispatch({
      type: 'UPDATE_CLIENT',
      id: client.id,
      patch: { notes: [{ date: toISODate(new Date()), text }, ...client.notes] },
    })
    setNoteText('')
    toast('Notatka dodana')
  }

  const removeNote = (idx) => {
    if (!canReadClinicalNotes) return
    const previous = client.notes
    dispatch({
      type: 'UPDATE_CLIENT',
      id: client.id,
      patch: { notes: client.notes.filter((_, k) => k !== idx) },
    })
    toast('Notatka usunięta', 'close', {
      label: 'Cofnij',
      key: `note:${client.id}:${idx}`,
      timeoutMs: 5000,
      onClick: () => dispatch({ type: 'UPDATE_CLIENT', id: client.id, patch: { notes: previous } }),
    })
  }

  return (
    <div ref={ref}>
      <EntityLink route="clients" className="link row" style={{ gap: 7, marginBottom: 20, width: 'fit-content' }} data-reveal>
        <Icon name="arrowL" size={16} /> Wróć do listy klientów
      </EntityLink>

      <div className="client-record">
        <section className="client-record__section" aria-labelledby="care-overview-title" data-reveal>
          <div className="id-band" style={{ '--band-color': psych?.color }}>
            <Avatar name={client.name} color={psych?.color} size={64} />
            <div className="id-band__main">
              <p className="eyebrow id-band__eyebrow">Karta klienta</p>
              <h1 className="display id-band__name">{client.name}</h1>
              <div className="id-band__meta">
                {ageLabel(client.age, client.age) && <span>{ageLabel(client.age, client.age)}</span>}
                {!isApp && client.phone && (
                  <span>
                    <Icon name="phone" size={14} />
                    <a href={`tel:${client.phone.replace(/\s/g, '')}`}>{client.phone}</a>
                  </span>
                )}
                {!isApp && client.email && (
                  <span>
                    <Icon name="mail" size={14} />
                    <a href={`mailto:${client.email}`}>{client.email}</a>
                  </span>
                )}
                <span>pod opieką od {fmtFullDate(client.since)}</span>
                <span>{completed.length} {plural(completed.length, 'sesja odbyta', 'sesje odbyte', 'sesji odbytych')}</span>
              </div>
              <div className="id-band__pills">
                <Pill tone={client.status === 'active' ? 'sage' : 'pink'} dot>
                  {client.status === 'archived'
                    ? 'Archiwalny'
                    : client.status === 'active' ? 'Aktywny' : 'Wstrzymany'}
                </Pill>
              </div>
            </div>
            {(canEditClient || canManageCare) && (
              <div className="id-band__actions">
                {canEditClient && <Button variant="ghost" icon="edit" onClick={openClient}>Edytuj</Button>}
                {canManageCare && <Button icon="plus" onClick={() => openSessionForm({ clientId: client.id })}>
                  {role.scope === 'own' ? 'Przygotuj sesję' : 'Umów spotkanie'}
                </Button>}
              </div>
            )}
          </div>
          <h2 className="client-record__title" id="care-overview-title">Przegląd opieki</h2>
          <div className="care-overview" aria-label="Podsumowanie opieki">
            <div className="care-overview__item">
              <span>Specjalistka prowadząca</span>
              {psych && role.scope !== 'own' && !isApp ? (
                <EntityLink route="psych" params={{ id: psych.id }} className="link care-overview__value">
                  {psych.title} {psych.name}
                </EntityLink>
              ) : <b>{psych?.name || 'Specjalistka niedostępna'}</b>}
            </div>
            <div className="care-overview__item">
              <span>Następne spotkanie</span>
              <b>{next ? `${cap(fmtWeekday(next.date))}, ${fmtDayMonth(next.date)} · ${next.time}` : 'Nie umówiono'}</b>
            </div>
            <div className="care-overview__item">
              <span>Saldo klienta</span>
              <b className={debt > 0 ? 'care-overview__debt' : ''}>{debt > 0 ? `Do rozliczenia ${fmtMoney(debt)}` : 'Rozliczony'}</b>
            </div>
            {!isApp && <div className="care-overview__item">
              <span>Rodzina</span>
              {family.length > 0 ? (
                <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  {family.map((member) => {
                    const label = `${member.name} (${member.familyRole || 'rodzina'})`
                    // a therapist sees the family fact, but only their own
                    // clients' cards open from here
                    return role.scope === 'own' && member.psychId !== role.psychId ? (
                      <b key={member.id}>{label}</b>
                    ) : (
                      <EntityLink
                        key={member.id}
                        route="client"
                        params={{ id: member.id }}
                        className="link care-overview__value"
                      >
                        {label}
                      </EntityLink>
                    )
                  })}
                </span>
              ) : <b>—</b>}
            </div>}
          </div>
        </section>

        <section className="client-record__section" aria-labelledby="upcoming-appointments-title" data-reveal>
          <div className="card card--pad">
            <h2 className="card-title" id="upcoming-appointments-title">
              Najbliższe spotkania
              <span className="faint" style={{ fontSize: 13, fontFamily: 'var(--font-ui)' }}>
                {upcoming.length} {sessionsWord(upcoming.length)}
              </span>
            </h2>
            {upcoming.length > 0 ? (
              <div className="agenda agenda--spine" style={{ marginTop: 6 }}>
                <span className="spine__rule" aria-hidden="true" />
                {upcoming.map((s) => (
                  <div className="agenda__row" key={s.id} style={{ '--node-color': psych?.color }}>
                    <span className="agenda__time">{s.time}</span>
                    <span className="agenda__main">
                      <EntityLink
                        route="calendar"
                        params={{ date: s.date, highlightSessionIds: [s.id] }}
                        label={`Pokaż w kalendarzu — ${fmtDayMonth(s.date)}, ${s.time}`}
                        className="agenda__client agenda__client-link"
                      >
                        {cap(fmtWeekday(s.date))}, {fmtDayMonth(s.date)}
                      </EntityLink>
                      <span className="agenda__meta">
                        {serviceShort(s.service)} · {s.duration} min · {fmtMoney(s.amount)}
                      </span>
                      <span className="agenda__pills">
                        <StatusPicker
                          session={s}
                          accessibleLabel={`Status: ${STATUS_LABELS[s.status]} — ${fmtDayMonth(s.date)}, ${s.time}`}
                        />
                        <PaymentPicker
                          session={s}
                          accessibleLabel={`Płatność: ${PAY_LABELS[s.payment]} — ${fmtDayMonth(s.date)}, ${s.time}`}
                        />
                      </span>
                    </span>
                    {canManageCare && (
                      <IconBtn
                        name="edit"
                        label={`Edytuj sesję — ${fmtDayMonth(s.date)}, ${s.time}`}
                        size={16}
                        onClick={() => openSessionForm({ session: s })}
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState compact icon="calendar" title="Brak najbliższych spotkań" hint="Umów spotkanie, aby pojawiło się w planie opieki." />
            )}
          </div>
        </section>

        <section className="client-record__section" aria-labelledby="attendance-history-title" data-reveal>
          <div className="card card--pad">
            <h2 className="card-title" id="attendance-history-title">
              Historia frekwencji
              <span className="faint" style={{ fontSize: 13, fontFamily: 'var(--font-ui)' }}>
                {history.length} {sessionsWord(history.length)}
              </span>
            </h2>
            {isApp && (
              <p className="faint">
                Zakres historii: {fmtFullDate(workspaceRange.from)} – {fmtFullDate(workspaceRange.to)}
              </p>
            )}
            {history.length > 0 ? (
              <>
              <div className="table-scroll table-scroll--until-tablet">
                <table className="table table--cards" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Godzina</th>
                      <th>Rodzaj</th>
                      <th>Status</th>
                      <th className="right">Kwota</th>
                      <th>Płatność</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyPages.pageItems.map((s) => (
                      <tr key={s.id}>
                        <td style={{ fontWeight: 600 }} data-th="Data">{fmtShortDate(s.date)}</td>
                        <td className="num-cell muted" data-th="Godzina">{s.time}</td>
                        <td className="muted" data-th="Rodzaj">{serviceShort(s.service)}</td>
                        <td data-th="Status">
                          <StatusPicker
                            session={s}
                            accessibleLabel={`Status: ${STATUS_LABELS[s.status]} — ${fmtDayMonth(s.date)}, ${s.time}`}
                          />
                        </td>
                        <td className="right num-cell" data-th="Kwota">{fmtMoney(s.amount)}</td>
                        <td data-th="Płatność">
                          <PaymentPicker
                            session={s}
                            accessibleLabel={`Płatność: ${PAY_LABELS[s.payment]} — ${fmtDayMonth(s.date)}, ${s.time}`}
                          />
                        </td>
                        <td className="right td--actions" style={{ width: 44 }}>
                          {canManageCare && (
                            <IconBtn
                              name="edit"
                              label={`Edytuj sesję — ${fmtDayMonth(s.date)}, ${s.time}`}
                              size={15}
                              onClick={() => openSessionForm({ session: s })}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={historyPages.page} pages={historyPages.pages} onPage={historyPages.setPage} />
              </>
            ) : (
              <EmptyState compact icon="calendar" title="Brak historii frekwencji" hint="Odbyte, odwołane i nieobecne spotkania pojawią się tutaj." />
            )}
          </div>
        </section>

        {isApp && linkedHistoricalClient && (
          <HistoricalSourceHistory
            historicalClient={linkedHistoricalClient}
            occurrences={state.historicalOccurrences}
            specialists={historySpecialists}
            workspaceRange={workspaceRange}
          />
        )}

        {!isApp && <section className="client-record__section" aria-labelledby="clinical-notes-title" data-reveal>
          <div className="card card--pad">
            <h2 className="card-title" id="clinical-notes-title">Notatki kliniczne</h2>
            {canReadClinicalNotes ? (
              <>
                <div className="note-composer" style={{ marginTop: 16 }}>
                  <textarea
                    className="textarea"
                    value={noteText}
                    placeholder="Nowa notatka — zalecenia, obserwacje…"
                    aria-label="Nowa notatka"
                    onChange={(e) => setNoteText(e.target.value)}
                  />
                  <div>
                    <Button size="sm" variant="soft" icon="plus" onClick={addNote} disabled={!noteText.trim()}>
                      Dodaj notatkę
                    </Button>
                  </div>
                </div>
                <div className="notes" style={{ marginTop: 18 }}>
                  {client.notes.length === 0 && (
                    <EmptyState
                      compact
                      icon="edit"
                      title="Brak notatek"
                      hint="Dodaj pierwszą notatkę powyżej — data dzisiejsza doda się sama."
                    />
                  )}
                  {client.notes.map((n, i) => (
                    <div className="note" key={`${n.date}-${i}`}>
                      <div className="note__date">{fmtFullDate(n.date)}</div>
                      <div className="note__text">{n.text}</div>
                      <IconBtn
                        name="trash"
                        label="Usuń notatkę"
                        size={14}
                        className="note__del"
                        onClick={() => removeNote(i)}
                      />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="clinical-notes__restricted">Notatki są dostępne w widoku specjalistki.</p>
            )}
          </div>
        </section>}
      </div>
      {clientForm && <ClientDrawer opts={clientForm} onClose={() => setClientForm(null)} />}
    </div>
  )
}
