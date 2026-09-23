import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, useClientMutationLock, useWorkspaceRetry, useWorkspaceWindow, clientOutstanding } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useFlip } from '../anim.js'
import { Button, Avatar, Pill, Chip, SearchInput, IconBtn, EmptyState, Segmented, usePagination, Pager } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { StatusPicker, PaymentPicker } from './session-bits.jsx'
import { ClientDrawer } from './ClientForm.jsx'
import { ageLabel, fmtMoney, fmtMonthYear, inMonthYear, fmtShortDate, fmtFullDate, fmtDayMonth, fmtWeekday, cap, monthKey, sessionsWord, toISODate, warsawDateTimeFromUtc, plural, STATUS_LABELS, PAY_LABELS } from '../format.js'
import { clientMatchesQuery, clientsForRole, isBookableClient, sessionsForRole } from '../workspace.js'
import { serviceBadge, serviceShort } from '../services.js'
import { EntityLink, FilterBar, FilterGroup, PeriodNav, useRouteParamsSync, ViewState } from '../ux-patterns.jsx'
import {
  monthWorkspaceRange,
  futureWorkspaceRange,
  previousWorkspaceRange,
  rollingWorkspaceRange,
  isWorkspaceRangeCovered,
  specialistIdentityFor,
} from '../workspace-view.js'
import { isWorkspaceRangePending } from '../workspace-load-request.js'
import { canPerformAction } from '../capability-access.js'
import {
  historicalClientDirectoryModel,
  historicalClientHistoryModel,
  latestPopulatedMonthAction,
  resolveClientCatalogViewState,
} from '../historical-workspace-view.js'
import { HistoricalOccurrenceRow } from './historical-bits.jsx'
import { HistoricalClientActivation } from './HistoricalClientActivation.jsx'
import { ClientSessionNotes } from './ClientSessionNotes.jsx'

const PARENTAL_RIGHTS_LABELS = { '': 'Nie ustalono', both: 'Tak', not_both: 'Nie' }

const HISTORICAL_SUBTITLE = 'Klienci z dawnego arkusza. Tylko do wglądu.'

// the client's next scheduled visit — sessions stay sorted by date+time
const nextSessionOf = (sessions, clientId) => {
  const { date: today, time: nowTime } = warsawDateTimeFromUtc(new Date().toISOString())
  return sessions.find(
    (s) => s.clientId === clientId && s.status === 'scheduled' &&
      (s.date > today || (s.date === today && s.time >= nowTime))
  )
}

const sessionsInRange = (sessions, range) => sessions.filter(
  (session) => session.date >= range.from && session.date <= range.to,
)

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
        )) : <p className="faint">Brak sesji z dokładną datą.</p>}
      </section>
      <section className="card card--pad historical-section" aria-labelledby="historical-months-title">
        <h2 className="card-title" id="historical-months-title">Miesiące bez dnia</h2>
        {history.monthOnlyRows.length > 0 ? history.monthOnlyRows.map((row) => (
          <div className="historical-client-history__entry" key={row.id}>
            <time dateTime={row.month}>{fmtMonthYear(row.month)}</time>
            <HistoricalOccurrenceRow row={row} />
          </div>
        )) : <p className="faint">Brak sesji bez dnia.</p>}
      </section>
      <section className="card card--pad historical-section" aria-labelledby="historical-unknown-title">
        <h2 className="card-title" id="historical-unknown-title">Bez daty</h2>
        {history.unknownRows.length > 0 ? history.unknownRows.map((row) => (
          <HistoricalOccurrenceRow key={row.id} row={row} />
        )) : <p className="faint">Brak sesji bez daty.</p>}
      </section>
    </div>
  )
}

function HistoricalClientsPanel({
  directory, currentMonth, historyPeriod, historyYm, latestAction, onHistoryPeriod,
  onHistoryYm, query, setQuery, notice, stale,
}) {
  return (
    <div>
      <div className="view-head">
        <div>
          <h1 className="display view-head__title">Klienci <em>historyczni</em></h1>
          <p className="view-head__sub">{HISTORICAL_SUBTITLE}</p>
        </div>
        <div className="view-head__actions historical-directory__actions">
          <SearchInput value={query} onChange={setQuery} placeholder="Imię, usługa lub specjalistka…" />
        </div>
      </div>
      <div className="historical-directory__toolbar">
        <PeriodNav month={historyYm} current={currentMonth} onChange={onHistoryYm} />
        <Segmented
          ariaLabel="Okres historii"
          value={historyPeriod}
          onChange={onHistoryPeriod}
          options={[
            { value: 'known', label: 'Z datą' },
            { value: 'unknown', label: 'Bez daty' },
          ]}
        />
      </div>
      {notice}
      <div className={stale ? 'is-refreshing' : ''} aria-busy={stale || undefined}>
      {directory.length === 0 ? (
        <section className="card card--pad historical-zero" aria-live="polite">
          <h2 className="card-title">{query ? 'Nie znaleziono klientów z dawnego arkusza' : 'Brak klientów z dawnego arkusza'}</h2>
          <p>{query ? `Brak wyników dla „${query}”.` : historyPeriod === 'unknown'
            ? 'Nie ma klientów z sesjami bez daty.'
            : `${cap(inMonthYear(historyYm))} nie ma klientów z dawnego arkusza.`}</p>
          {query && <Button variant="soft" onClick={() => setQuery('')}>Wyczyść wyszukiwanie</Button>}
          {latestAction && <Button variant="soft" onClick={() => onHistoryYm(latestAction.month)}>{latestAction.label}</Button>}
        </section>
      ) : (
        <div className="card card--table">
          <div className="table-scroll table-scroll--until-tablet">
            <table className="table table--cards" aria-label="Klienci historyczni">
              <thead>
                <tr><th>Klient</th><th>Sesje z arkusza</th><th>Okres</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {directory.map((client) => (
                  <tr key={client.id} className="historical-client-row" data-history-client-id={client.id}>
                    <td data-th="Klient"><strong>{client.name}</strong></td>
                  <td data-th="Sesje z arkusza">{client.visitCount}</td>
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
    </div>
  )
}

function HistoricalClientDetail({ historicalClient, occurrences, specialists, workspaceRange, periodMode = 'known' }) {
  const { capabilities, role } = useShell()
  const { locked: clientMutationLocked } = useClientMutationLock()
  const identityRef = useRef(null)
  const [activationOpen, setActivationOpen] = useState(false)
  const history = useMemo(() => historicalClientHistoryModel({
    historicalClient, occurrences, specialists, workspaceRange, periodMode,
  }), [historicalClient, occurrences, specialists, workspaceRange, periodMode])
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
          <p className="eyebrow id-band__eyebrow">Dawny arkusz</p>
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
              Dodaj do kartoteki
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
    historicalClient, occurrences, specialists, workspaceRange,
  }), [historicalClient, occurrences, specialists, workspaceRange])
  return (
    <section className="client-record__section" aria-label="Historia z dawnego arkusza">
      <div className="card card--pad">
        <h2 className="card-title">Historia z dawnego arkusza</h2>
        <p className="faint">
          Od {fmtFullDate(workspaceRange.from)} do {fmtFullDate(workspaceRange.to)}.
          Sesje z dawnego arkusza, osobno od historii sesji.
        </p>
        <HistoricalHistorySections history={history} />
      </div>
    </section>
  )
}

export function Clients({ params = {} }) {
  const { state, workspace, workspaceFailures, workspacePendingRanges } = useApp()
  const { appMode, capabilities, getViewState, openClientForm, patchViewState, role } = useShell()
  const isApp = appMode === 'app'
  const canViewHistorical = isApp && role.scope === 'centre'
    && capabilities.includes('finance.centre.read')
  const today = warsawDateTimeFromUtc(new Date().toISOString()).date
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
  const effectiveCatalog = canViewHistorical ? catalog : 'current'
  const workspaceRange = useMemo(
    () => isApp && effectiveCatalog === 'historical'
      ? monthWorkspaceRange(historyYm)
      : rollingWorkspaceRange(today),
    [effectiveCatalog, historyYm, isApp, today],
  )
  const futureRange = useMemo(() => futureWorkspaceRange(today), [today])
  const pastWorkspaceState = useWorkspaceWindow(workspaceRange, isApp)
  const futureWorkspaceState = useWorkspaceWindow(
    futureRange,
    isApp && effectiveCatalog !== 'historical',
  )
  const workspaceState = pastWorkspaceState
  const retryWorkspace = useWorkspaceRetry()
  const workspaceCovered = !isApp || isWorkspaceRangeCovered(workspace.loadedRanges, workspaceRange)
  const workspaceFailed = isApp && workspaceFailures.has(`${workspaceRange.from}|${workspaceRange.to}`)
  const workspaceRefreshing = isApp && workspaceCovered
    && isWorkspaceRangePending(workspacePendingRanges, workspaceRange)
  const workspaceRefreshFailed = isApp && workspaceCovered && workspaceFailed
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
  const recentSessions = useMemo(
    () => sessionsInRange(state.sessions, workspaceRange),
    [state.sessions, workspaceRange],
  )
  const filtered = useMemo(() => {
    return scopedClients.filter((c) => {
      if (role.scope !== 'own' && psychFilter && c.psychId !== psychFilter) return false
      if (debtOnly && clientOutstanding(recentSessions, c.id) <= 0) return false
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (!clientMatchesQuery(c, query)) return false
      return true
    })
  }, [scopedClients, recentSessions, query, psychFilter, debtOnly, role.scope, statusFilter])

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

  useRouteParamsSync('clients', effectiveCatalog === 'historical'
    ? { catalog: 'historical', historyPeriod, ym: historyYm }
    : { specialist: role.scope !== 'own' ? psychFilter || undefined : undefined })

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)
  const activeFilterCount =
    (role.scope !== 'own' && psychFilter ? 1 : 0)
    + (debtOnly ? 1 : 0)
    + (statusFilter !== 'all' ? 1 : 0)
  const filterSummary = [
    role.scope !== 'own' && psychFilter
      ? `Specjalistka: ${psychOf(psychFilter)?.name}`
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

  if (isApp && effectiveCatalog === 'historical') {
    return (
      <div ref={ref}>
        {workspaceCovered ? <>
          <HistoricalClientsPanel
            directory={historicalDirectory}
            currentMonth={monthKey(today)}
            historyPeriod={historyPeriod}
            historyYm={historyYm}
            latestAction={latestHistoryAction}
            onHistoryPeriod={setHistoryPeriod}
            onHistoryYm={setHistoryYm}
            query={query}
            setQuery={setQuery}
            stale={workspaceRefreshing}
            notice={<>
              {workspaceRefreshing && <ViewState
                compact
                tone="loading"
                icon="clients"
                title="Wczytuję klientów…"
              />}
              {workspaceRefreshFailed && <ViewState
                compact
                tone="error"
                icon="clients"
                title="Nie udało się odświeżyć listy klientów"
                hint="Spróbuj ponownie za chwilę."
                action={<Button size="sm" onClick={() => retryWorkspace(workspaceRange)}>Spróbuj ponownie</Button>}
              />}
            </>}
          />
        </> : <>
          <div className="view-head">
            <div>
              <h1 className="display view-head__title">Klienci <em>historyczni</em></h1>
              <p className="view-head__sub">{HISTORICAL_SUBTITLE}</p>
            </div>
            <div className="view-head__actions historical-directory__actions">
              <SearchInput value={query} onChange={setQuery} placeholder="Imię, usługa lub specjalistka…" />
            </div>
          </div>
          <ViewState
            ariaLabel="Stan kartoteki"
            tone={workspaceState === 'unavailable' ? 'error' : 'loading'}
            icon="clients"
            title={workspaceState === 'unavailable' ? 'Nie udało się wczytać klientów' : 'Wczytuję klientów…'}
            hint={workspaceState === 'unavailable' ? 'Spróbuj ponownie za chwilę.' : undefined}
            action={workspaceState === 'unavailable'
              ? <Button onClick={() => retryWorkspace(workspaceRange)}>Spróbuj ponownie</Button>
              : undefined}
          />
        </>}
      </div>
    )
  }

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <h1 className="display view-head__title">
            {role.scope === 'own' ? <>Moi <em>klienci</em></> : <>Klienci <em>centrum</em></>}
          </h1>
          {workspaceCovered && <p className="view-head__sub">
            {scopedClients.length} {plural(scopedClients.length, 'osoba', 'osoby', 'osób')}
            {role.scope === 'own'
              ? ' przypisanych do Twojej opieki — wyszukuj i przechodź do kart klientów.'
              : ' pod opieką zespołu — wyszukuj, filtruj i przechodź do kart klientów.'}
          </p>}
        </div>
        <div className="view-head__actions">
          <SearchInput value={query} onChange={setQuery} placeholder="Imię klienta…" />
          {canManageClients && (
            <Button icon="plus" magnetic disabled={clientActionsLocked} onClick={() => openClient({ psychId: role.scope === 'own' ? role.psychId : psychFilter || undefined })}>
              Dodaj klienta
            </Button>
          )}
        </div>
      </div>

      {!workspaceCovered ? <ViewState
        ariaLabel="Stan kartoteki"
        tone={workspaceState === 'unavailable' ? 'error' : 'loading'}
        icon="clients"
        title={workspaceState === 'unavailable' ? 'Nie udało się wczytać klientów' : 'Wczytuję klientów…'}
        hint={workspaceState === 'unavailable' ? 'Spróbuj ponownie za chwilę.' : undefined}
        action={workspaceState === 'unavailable'
          ? <Button onClick={() => retryWorkspace(workspaceRange)}>Spróbuj ponownie</Button>
          : undefined}
      /> : <>
      {workspaceRefreshing && <ViewState
        compact
        tone="loading"
        icon="clients"
        title="Wczytuję klientów…"
      />}
      {workspaceRefreshFailed && <ViewState
        compact
        tone="error"
        icon="clients"
        title="Nie udało się odświeżyć listy klientów"
        hint="Spróbuj ponownie za chwilę."
        action={<Button size="sm" onClick={() => retryWorkspace(workspaceRange)}>Spróbuj ponownie</Button>}
      />}

      <div className={workspaceRefreshing ? 'is-refreshing' : ''} aria-busy={workspaceRefreshing || undefined}>
      {canViewHistorical && (
        <EntityLink route="clients" params={{ catalog: 'historical' }} className="link">
          Klienci z dawnego arkusza
        </EntityLink>
      )}
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
                  {p.name}
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

      {futureWorkspaceState === 'unavailable' && (
        <div className="row faint" role="status" style={{ gap: 10, marginBottom: 12 }}>
          <span>Nie udało się wczytać najbliższych sesji.</span>
          <Button size="sm" variant="soft" onClick={() => retryWorkspace(futureRange)}>
            Spróbuj ponownie
          </Button>
        </div>
      )}

      <div className="card card--table" data-reveal>
        <div className="table-scroll table-scroll--until-tablet">
        <table className="table table--cards">
          <thead>
            <tr>
              <th>Klient</th>
              <th>Specjalistka</th>
              <th>Następna sesja</th>
              <th className="right">Do zapłaty od {fmtFullDate(workspaceRange.from)} do {fmtFullDate(workspaceRange.to)}</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4}>
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
                      hint={query
                        ? `Brak wyników dla „${query}”.`
                        : 'Zmień filtry, aby zobaczyć klientów w tym zakresie.'}
                      action={query ? <Button size="sm" variant="soft" onClick={() => setQuery('')}>
                        Wyczyść wyszukiwanie
                      </Button> : undefined}
                    />
                  )}
                </td>
              </tr>
            )}
            {pageItems.map((c) => {
              const p = psychOf(c.psychId)
              const specialist = specialistIdentityFor(state.psychologists, c.psychId)
              const next = nextSessionOf(sessionsInRange(state.sessions, futureRange), c.id)
              const debt = clientOutstanding(recentSessions, c.id)
              return (
                <tr
                  key={c.id}
                  data-flip-id={c.id}
                  className="client-row"
                >
                  <td data-th="Klient">
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
                  <td data-th="Specjalistka">
                    <span className="row" style={{ gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: p?.color, display: 'inline-block' }} />
                      <span className="muted">{specialist.name}</span>
                    </span>
                  </td>
                  <td data-th="Następna sesja">
                    {futureWorkspaceState !== 'ready'
                      ? <span className="faint">{futureWorkspaceState === 'loading'
                        ? 'Wczytuję najbliższe sesje…'
                        : 'Najbliższe sesje są teraz niedostępne.'}</span>
                      : next
                      ? <span className="num-cell" style={{ fontWeight: 600 }}>
                        {cap(fmtWeekday(next.date))}, {fmtDayMonth(next.date)} · {next.time}
                      </span>
                      : <span className="faint">Brak sesji w najbliższych 3 miesiącach</span>}
                  </td>
                  <td className="right" data-th={`Do zapłaty: ${fmtFullDate(workspaceRange.from)} – ${fmtFullDate(workspaceRange.to)}`}>
                    {workspaceState !== 'ready'
                      ? <span className="faint">Nie udało się wczytać płatności.</span>
                      : debt > 0 ? <Pill tone="amber">{fmtMoney(debt)}</Pill>
                        : <span className="faint">Brak zaległości w tym zakresie</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
        <Pager page={page} pages={pages} onPage={setPage} />
      </div>
      </div>
      {clientForm && <ClientDrawer opts={clientForm} onClose={() => setClientForm(null)} />}
      </>}
    </div>
  )
}

export function ClientDetail({ params }) {
  const { state, dispatch, toast } = useApp()
  const { actor, appMode, authorityGeneration, capabilities, openSessionForm, openClientForm, role } = useShell()
  const isApp = appMode === 'app'
  const nowParts = warsawDateTimeFromUtc(new Date().toISOString())
  const todayIso = nowParts.date
  const sourceHistoryMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(params?.ym || '')
    ? params.ym : null
  const isHistoricalRecord = isApp && (
    /^hcl_/.test(params?.id || '')
    || params?.historyPeriod === 'unknown'
  )
  const workspaceRange = useMemo(
    () => isHistoricalRecord ? monthWorkspaceRange(sourceHistoryMonth ?? monthKey(todayIso)) : rollingWorkspaceRange(todayIso),
    [isHistoricalRecord, sourceHistoryMonth, todayIso],
  )
  const sourceHistoryRange = useMemo(
    () => !isHistoricalRecord && sourceHistoryMonth ? monthWorkspaceRange(sourceHistoryMonth) : null,
    [isHistoricalRecord, sourceHistoryMonth],
  )
  const futureRange = useMemo(() => futureWorkspaceRange(todayIso), [todayIso])
  const [historyRange, setHistoryRange] = useState(null)
  const pastWorkspaceState = useWorkspaceWindow(workspaceRange, isApp)
  const sourceHistoryState = useWorkspaceWindow(
    sourceHistoryRange,
    isApp && sourceHistoryRange !== null && pastWorkspaceState === 'ready',
  )
  const futureWorkspaceState = useWorkspaceWindow(futureRange, isApp && !isHistoricalRecord)
  const historyWorkspaceState = useWorkspaceWindow(historyRange, isApp && historyRange !== null)
  const workspaceState = pastWorkspaceState
  const retryWorkspace = useWorkspaceRetry()
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
  const earliestHistoryDate = historyRange?.from ?? workspaceRange.from
  const latestVisibleDate = isHistoricalRecord ? workspaceRange.to : futureRange.to
  const all = client
    ? sessionsForRole(state, role).filter((session) => (
        session.clientId === client.id
        && session.date >= earliestHistoryDate
        && session.date <= latestVisibleDate
      ))
    : []
  // upcoming care first, everything else newest-first below it
  const nowTime = nowParts.time
  const upcoming = all.filter(
    (s) => s.status === 'scheduled'
      && (s.date > todayIso || (s.date === todayIso && s.time >= nowTime)),
  )
  const upcomingIds = new Set(upcoming.map((s) => s.id))
  const history = all.filter((s) => !upcomingIds.has(s.id)).slice().reverse()
  const historyPages = usePagination(history, { pageSize: 10, resetKey: params.id })
  if (isApp && workspaceState !== 'ready') {
    return (
      <div ref={ref}>
        <EntityLink route="clients" className="link row" style={{ gap: 7, marginBottom: 20, width: 'fit-content' }}>
          <Icon name="arrowL" size={16} /> Wróć do kartoteki
        </EntityLink>
        <div className="view-head">
          <div>
            <h1 className="display view-head__title">Karta klienta</h1>
          </div>
        </div>
        <ViewState
          ariaLabel="Stan karty klienta"
          tone={workspaceState === 'unavailable' ? 'error' : 'loading'}
          icon="clients"
          title={workspaceState === 'loading' ? 'Wczytuję kartę klienta…' : 'Nie udało się wczytać karty klienta'}
          hint={workspaceState === 'loading' ? undefined : 'Spróbuj ponownie za chwilę.'}
          action={workspaceState === 'unavailable'
            ? <Button onClick={() => retryWorkspace(workspaceRange)}>Spróbuj ponownie</Button>
            : undefined}
        />
      </div>
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
          periodMode={params?.historyPeriod === 'unknown' ? 'unknown' : 'known'}
        />
      </div>
    )
  }
  if (!client) {
    return (
      <EmptyState
        icon="clients"
        title="Nie możemy otworzyć tej karty"
        hint="Link jest nieaktualny albo klient jest pod opieką innej specjalistki."
        action={<EntityLink route="clients" className="btn btn--soft btn--sm">Wróć do listy</EntityLink>}
      />
    )
  }

  const psych = state.psychologists.find((p) => p.id === client.psychId)
  const completed = all.filter((s) => s.status === 'completed')
  const debt = clientOutstanding(sessionsInRange(state.sessions, workspaceRange), client.id)
  const next = nextSessionOf(all, client.id)
  const earlierHistoryRange = isApp
    ? previousWorkspaceRange(
        historyRange ?? workspaceRange,
        client.since,
      )
    : null
  const family = client.familyId
    ? state.clients.filter((c) => c.familyId === client.familyId && c.id !== client.id)
    : []
  // App-mode family links live on the child's card; a parent sees the children
  // that point at them. Only clients this user can see are listed.
  const guardianIds = [client.guardianClientId, client.secondGuardianClientId].filter(Boolean)
  const linkedFamily = isApp ? [
    ...guardianIds.map((id) => state.clients.find((c) => c.id === id)).filter(Boolean)
      .map((member) => ({ member, label: 'rodzic' })),
    ...state.clients.filter((c) => c.guardianClientId === client.id
      || c.secondGuardianClientId === client.id).map((member) => ({ member, label: 'dziecko' })),
  ] : []
  const canReadClinicalNotes = !isApp && role.scope === 'own' && client.psychId === role.psychId
  const canReadAppSessionNotes = isApp && actor?.specialistId
    && actor.specialistId === client.psychId && capabilities.includes('clinical.read')
  const canEditClient = !clientMutationLocked && !client.readOnly
    && (!isApp || canPerformAction(capabilities, 'client.edit'))
    && (role.scope !== 'own' || client.psychId === role.psychId)
  const canManageCare = isBookableClient(client)
    && (!isApp || canPerformAction(capabilities, 'appointment.create'))
    && (role.scope !== 'own' || client.psychId === role.psychId)
  const openClient = () => {
    if (isApp) {
      if (clientMutationLocked) return
      setClientForm({ client, workspaceRange })
    }
    else openClientForm({ client })
  }
  const bookSession = () => openSessionForm({ clientId: client.id })
  const bookLabel = role.scope === 'own' ? 'Przygotuj sesję' : 'Umów sesję'

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
    toast('Notatka została dodana')
  }

  const removeNote = (idx) => {
    if (!canReadClinicalNotes) return
    const previous = client.notes
    dispatch({
      type: 'UPDATE_CLIENT',
      id: client.id,
      patch: { notes: client.notes.filter((_, k) => k !== idx) },
    })
    toast('Notatka została usunięta', 'check', {
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
        <section className="client-record__section" aria-labelledby="client-name-title" data-reveal>
          <div className="id-band" style={{ '--band-color': psych?.color }}>
            <Avatar name={client.name} color={psych?.color} size={64} />
            <div className="id-band__main">
              <h1 className="display id-band__name" id="client-name-title">{client.name}</h1>
              <div className="id-band__meta">
                {ageLabel(client.age, client.age) && <span>{ageLabel(client.age, client.age)}</span>}
                {(client.guardianPhone || client.phone) && (
                  <span>
                    <Icon name="phone" size={14} />
                    <a href={`tel:${(client.guardianPhone || client.phone).replace(/\s/g, '')}`}>{client.guardianPhone || client.phone}</a>
                  </span>
                )}
                {(client.guardianEmail || client.email) && (
                  <span>
                    <Icon name="mail" size={14} />
                    <a href={`mailto:${client.guardianEmail || client.email}`}>{client.guardianEmail || client.email}</a>
                  </span>
                )}
                <span>pod opieką od {fmtFullDate(client.since)}</span>
                <span>{completed.length} {plural(completed.length, 'sesja odbyta', 'sesje odbyte', 'sesji odbytych')}</span>
              </div>
              <div className="id-band__pills">
                <Pill tone={client.status === 'active' ? 'sage' : 'ink'} dot>
                  {client.status === 'archived'
                    ? 'Archiwalny'
                    : client.status === 'active' ? 'Aktywny' : 'Wstrzymany'}
                </Pill>
              </div>
            </div>
            {(canEditClient || canManageCare) && (
              <div className="id-band__actions">
                {canEditClient && <Button variant="ghost" icon="edit" onClick={openClient}>Edytuj</Button>}
                {canManageCare && <Button icon="plus" onClick={bookSession}>{bookLabel}</Button>}
              </div>
            )}
          </div>
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
              <span>{isHistoricalRecord ? 'Sesje w wybranym miesiącu' : 'Następna sesja'}</span>
              <b>{isHistoricalRecord
                ? '—'
                : futureWorkspaceState !== 'ready'
                  ? '—'
                  : next
                    ? `${cap(fmtWeekday(next.date))}, ${fmtDayMonth(next.date)} · ${next.time}`
                    : 'Brak sesji w najbliższych 3 miesiącach'}</b>
            </div>
            <div className="care-overview__item">
              <span>Do zapłaty od {fmtFullDate(workspaceRange.from)} do {fmtFullDate(workspaceRange.to)}</span>
              <b className={debt > 0 ? 'care-overview__debt' : ''}>{debt > 0
                ? fmtMoney(debt)
                : 'Brak zaległości w tym zakresie'}</b>
            </div>
            {isApp && (linkedFamily.length > 0 || guardianIds.length > 0) && <div className="care-overview__item">
              <span>Rodzina</span>
              {linkedFamily.length > 0 ? (
                <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  {linkedFamily.map(({ member, label }) => (
                    <EntityLink
                      key={member.id}
                      route="client"
                      params={{ id: member.id }}
                      className="link care-overview__value"
                    >
                      {`${member.name} (${label})`}
                    </EntityLink>
                  ))}
                </span>
              ) : <b>{guardianIds.length ? 'Rodzic spoza Twojej listy klientów' : '—'}</b>}
            </div>}
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
              {isHistoricalRecord ? 'Sesje w wybranym miesiącu' : 'Najbliższe sesje'}
              <span className="faint" style={{ fontSize: 13, fontFamily: 'var(--font-ui)' }}>
                {upcoming.length} {sessionsWord(upcoming.length)}
              </span>
            </h2>
            {!isHistoricalRecord && futureWorkspaceState !== 'ready' ? (
              <div className="row" role="status" style={{ gap: 10 }}>
                <p className="faint">{futureWorkspaceState === 'loading'
                  ? 'Wczytuję najbliższe sesje…'
                  : 'Nie udało się wczytać najbliższych sesji.'}</p>
                {futureWorkspaceState === 'unavailable' && (
                  <Button size="sm" variant="soft" onClick={() => retryWorkspace(futureRange)}>
                    Spróbuj ponownie
                  </Button>
                )}
              </div>
            ) : upcoming.length > 0 ? (
              <div className="agenda agenda--spine" style={{ marginTop: 6 }}>
                <span className="spine__rule" aria-hidden="true" />
                {upcoming.map((s) => (
                  <div className="agenda__row" key={s.id} style={{ '--node-color': psych?.color }}>
                    <span className="agenda__time">{s.time}</span>
                    <span className="agenda__main">
                      <EntityLink
                        route="calendar"
                        params={{ date: s.date, highlightSessionIds: [s.id] }}
                        label={`Pokaż w Grafiku — ${fmtDayMonth(s.date)}, ${s.time}`}
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
                    {canManageCare && !s.readOnly && (
                      <span className="agenda__actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openSessionForm({ session: s, reschedule: true, focus: 'date' })}
                        >
                          Przełóż
                        </Button>
                        <IconBtn
                          name="edit"
                          label={`Edytuj sesję — ${fmtDayMonth(s.date)}, ${s.time}`}
                          size={16}
                          onClick={() => openSessionForm({ session: s })}
                        />
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                compact
                icon="calendar"
                title={isHistoricalRecord ? 'Brak sesji w wybranym miesiącu' : 'Brak sesji w najbliższych 3 miesiącach'}
                hint={isHistoricalRecord ? 'W tym miesiącu nie ma zaplanowanych sesji.' : undefined}
                action={!isHistoricalRecord && canManageCare
                  ? <Button size="sm" icon="plus" onClick={bookSession}>{bookLabel}</Button>
                  : undefined}
              />
            )}
          </div>
        </section>

        <section className="client-record__section" aria-labelledby="attendance-history-title" data-reveal>
          <div className="card card--pad">
            <h2 className="card-title" id="attendance-history-title">
              Historia sesji
              <span className="faint" style={{ fontSize: 13, fontFamily: 'var(--font-ui)' }}>
                {history.length} {sessionsWord(history.length)}
              </span>
            </h2>
            {isApp && (
              <p className="faint">
                {historyRange
                  ? `Pokazujemy sesje od ${fmtFullDate(historyRange.from)}.`
                  : 'Pokazujemy sesje z ostatnich 3 miesięcy.'}
              </p>
            )}
            {history.length > 0 ? (
              <>
              {isApp && historyRange && historyWorkspaceState === 'loading' && (
                <p className="faint" role="status">Wczytuję wcześniejsze sesje…</p>
              )}
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
                        <td className="right td--actions">
                          {canManageCare && !s.readOnly && (
                            <span className="agenda__actions">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openSessionForm({ session: s, reschedule: true, focus: 'date' })}
                              >
                                Przełóż
                              </Button>
                              <IconBtn
                                name="edit"
                                label={`Edytuj sesję — ${fmtDayMonth(s.date)}, ${s.time}`}
                                size={15}
                                onClick={() => openSessionForm({ session: s })}
                              />
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={historyPages.page} pages={historyPages.pages} onPage={historyPages.setPage} />
              </>
            ) : isApp && historyRange && historyWorkspaceState === 'loading' ? (
              <p className="faint" role="status">Wczytuję wcześniejsze sesje…</p>
            ) : isApp && historyRange && historyWorkspaceState === 'unavailable' ? (
              <p className="faint" role="status">Nie udało się wczytać wcześniejszych sesji.</p>
            ) : (
              <EmptyState compact icon="calendar" title="Brak historii sesji" hint="Odbyte, odwołane i nieobecne sesje pojawią się tutaj." />
            )}
            {isApp && historyWorkspaceState === 'unavailable' && historyRange ? (
              <div className="row" style={{ marginTop: 14, gap: 10 }}>
                <Button size="sm" variant="soft" onClick={() => retryWorkspace(historyRange)}>
                  Spróbuj ponownie
                </Button>
              </div>
            ) : isApp && earlierHistoryRange && historyWorkspaceState !== 'loading' ? (
              <Button
                size="sm"
                variant="soft"
                onClick={() => setHistoryRange(earlierHistoryRange)}
                style={{ marginTop: 14 }}
              >
                Pokaż wcześniejsze sesje
              </Button>
            ) : null}
          </div>
        </section>

        {isApp && linkedHistoricalClient && sourceHistoryState !== 'ready' ? (
          <section className="client-record__section" aria-label="Historia z dawnego arkusza">
            <ViewState
              ariaLabel="Stan historii z dawnego arkusza"
              tone={sourceHistoryState === 'unavailable' ? 'error' : 'loading'}
              icon="clients"
              title={sourceHistoryState === 'unavailable'
                ? 'Nie udało się wczytać historii z dawnego arkusza'
                : 'Wczytuję historię z dawnego arkusza…'}
              hint={sourceHistoryState === 'unavailable' ? 'Spróbuj ponownie za chwilę.' : undefined}
              action={sourceHistoryState === 'unavailable'
                ? <Button onClick={() => retryWorkspace(sourceHistoryRange)}>Spróbuj ponownie</Button>
                : undefined}
            />
          </section>
        ) : isApp && linkedHistoricalClient ? (
          <HistoricalSourceHistory
            historicalClient={linkedHistoricalClient}
            occurrences={state.historicalOccurrences}
            specialists={historySpecialists}
            workspaceRange={sourceHistoryRange ?? workspaceRange}
          />
        ) : null}

        {client.intakeReason && <section className="client-record__section" aria-labelledby="intake-reason-title" data-reveal>
          <div className="card card--pad">
            <h2 className="card-title" id="intake-reason-title">Z czym przychodzi</h2>
            <p className="client-record__reception-notes">{client.intakeReason}</p>
          </div>
        </section>}

        {typeof client.age === 'number' && !isHistoricalRecord && <section className="client-record__section" aria-labelledby="consent-title" data-reveal>
          <div className="card card--pad">
            <h2 className="card-title" id="consent-title">Zgody i prawa rodzicielskie</h2>
            <dl className="client-record__facts">
              <div>
                <dt>Oboje rodzice mają pełnię praw rodzicielskich</dt>
                <dd>{PARENTAL_RIGHTS_LABELS[client.parentalRights || '']}</dd>
              </div>
              <div>
                <dt>Zgoda na terapię małoletniego</dt>
                <dd>{client.therapyConsent === 'signed'
                  ? <Pill tone="sage" dot>Podpisana</Pill>
                  : <Pill tone="amber" dot>Brak podpisanej zgody</Pill>}</dd>
              </div>
            </dl>
          </div>
        </section>}

        {client.receptionNotes && <section className="client-record__section" aria-labelledby="reception-notes-title" data-reveal>
          <div className="card card--pad">
            <h2 className="card-title" id="reception-notes-title">Uwagi recepcji</h2>
            <p className="client-record__reception-notes">{client.receptionNotes}</p>
          </div>
        </section>}

        {canReadAppSessionNotes && <ClientSessionNotes
          key={`${client.id}:${client.psychId}:${actor.id}:${authorityGeneration}`}
          clientId={client.id}
          specialistId={client.psychId}
          authorName={specialistIdentityFor(state.psychologists, client.psychId).name}
        />}

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
