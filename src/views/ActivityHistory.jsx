import { useCallback, useEffect, useRef, useState } from 'react'

import { ACTIVITY_KINDS } from '../activity-history.js'
import { apiClient } from '../api.js'
import { fmtFullDate, warsawDateTimeFromUtc } from '../format.js'
import { useShell } from '../shell-ctx.js'
import { Button } from '../ui.jsx'
import { FilterBar, FilterGroup, ViewState, useRouteParamsSync } from '../ux-patterns.jsx'

const EMPTY_FILTERS = Object.freeze({ actor: '', client: '', kind: '', from: '', to: '' })
const DATE = /^\d{4}-\d{2}-\d{2}$/
const KIND_VALUES = new Set(ACTIVITY_KINDS.map(({ value }) => value))
const INITIAL_STATE = Object.freeze({
  error: null,
  filters: Object.freeze({ actors: [], clients: [] }),
  items: [],
  nextCursor: null,
  status: 'loading',
})

const validDate = (value) => typeof value === 'string' && DATE.test(value) ? value : ''
const validText = (value) => typeof value === 'string' ? value : ''

function historyFilters(params, saved) {
  const source = params && typeof params === 'object' ? params : {}
  const fallback = saved && typeof saved === 'object' ? saved : EMPTY_FILTERS
  const valueFor = (key) => Object.hasOwn(source, key) ? source[key] : fallback[key]
  const kind = validText(valueFor('kind'))
  return {
    actor: validText(valueFor('actor')),
    client: validText(valueFor('client')),
    kind: KIND_VALUES.has(kind) ? kind : '',
    from: validDate(valueFor('from')),
    to: validDate(valueFor('to')),
  }
}

function requestFor(filters, cursor) {
  return {
    ...filters,
    limit: 20,
    ...(cursor ? { cursor } : {}),
  }
}

function activityDays(items) {
  const days = new Map()
  for (const item of items) {
    const { date, time } = warsawDateTimeFromUtc(item.occurredAt)
    const group = days.get(date) || []
    group.push({ ...item, time })
    days.set(date, group)
  }
  return [...days.entries()]
}

function filterSummary(filters, filterOptions) {
  const actor = filterOptions.actors.find(({ id }) => id === filters.actor)?.label
  const client = filterOptions.clients.find(({ id }) => id === filters.client)?.label
  const kind = ACTIVITY_KINDS.find(({ value }) => value === filters.kind)?.label
  return [actor, client, kind, filters.from, filters.to].filter(Boolean).join(' · ')
}

function DetailList({ details }) {
  if (!details?.length) return null
  return <ul className="activity-history__details" aria-label="Zakres zmiany">
    {details.map((detail) => <li key={`${detail.field}:${detail.before}:${detail.after}`}>
      <strong>{detail.field}</strong>
      <span>{detail.before ?? '-'} → {detail.after ?? '-'}</span>
    </li>)}
  </ul>
}

function HistoryRows({ items }) {
  return <div className="activity-history">
    {activityDays(items).map(([date, dayItems]) => <section className="activity-history__day" key={date}>
      <h2 className="activity-history__day-title">{fmtFullDate(date)}</h2>
      <ol className="activity-history__list">
        {dayItems.map((item) => <li className="card activity-history__item" key={item.id}>
          <div>
            <strong>{item.actorName}</strong> {item.summary}
          </div>
          <div className="activity-history__meta">
            {item.clientName ? <span>Klient: {item.clientName}</span> : null}
            <time dateTime={item.occurredAt}>{item.time}</time>
          </div>
          <DetailList details={item.details} />
        </li>)}
      </ol>
    </section>)}
  </div>
}

export function ActivityHistory() {
  const {
    authorityGeneration, getViewState, patchViewState, route,
  } = useShell()
  const routeKey = JSON.stringify(route.params || {})
  const previousRouteKey = useRef(routeKey)
  const [filters, setFilters] = useState(() => historyFilters(
    route.params, getViewState('history', EMPTY_FILTERS),
  ))
  const [snapshot, setSnapshot] = useState(INITIAL_STATE)
  const [retryVersion, setRetryVersion] = useState(0)
  const requestScopeRef = useRef(0)

  useEffect(() => {
    if (previousRouteKey.current === routeKey) return
    previousRouteKey.current = routeKey
    setFilters(historyFilters(JSON.parse(routeKey), EMPTY_FILTERS))
  }, [routeKey])

  useEffect(() => {
    patchViewState('history', filters)
  }, [filters, patchViewState])
  useRouteParamsSync('history', filters)

  const filterKey = JSON.stringify(filters)
  useEffect(() => {
    const controller = new AbortController()
    const scope = ++requestScopeRef.current
    setSnapshot((current) => ({ ...INITIAL_STATE, filters: current.filters, status: 'loading' }))

    apiClient.listActivityHistory(requestFor(filters), { signal: controller.signal }).then((result) => {
      if (requestScopeRef.current !== scope) return
      setSnapshot({
        error: null,
        filters: result.filters,
        items: result.items,
        nextCursor: result.nextCursor,
        status: 'ready',
      })
    }).catch((error) => {
      if (controller.signal.aborted || requestScopeRef.current !== scope) return
      setSnapshot((current) => ({ ...INITIAL_STATE, error, filters: current.filters, status: 'error' }))
    })
    return () => controller.abort()
  }, [authorityGeneration, filterKey, retryVersion])

  const updateFilter = useCallback((key, value) => {
    setFilters((current) => ({ ...current, [key]: value }))
  }, [])
  const clearFilters = useCallback(() => {
    patchViewState('history', EMPTY_FILTERS)
    setFilters(EMPTY_FILTERS)
  }, [patchViewState])
  const retry = useCallback(() => setRetryVersion((value) => value + 1), [])
  const loadMore = useCallback(async () => {
    const cursor = snapshot.nextCursor
    if (!cursor || snapshot.status === 'loading-more') return
    const scope = requestScopeRef.current
    setSnapshot((current) => ({ ...current, error: null, status: 'loading-more' }))
    try {
      const result = await apiClient.listActivityHistory(requestFor(filters, cursor))
      if (requestScopeRef.current !== scope) return
      setSnapshot((current) => ({
        error: null,
        filters: result.filters,
        items: [...current.items, ...result.items],
        nextCursor: result.nextCursor,
        status: 'ready',
      }))
    } catch (error) {
      if (requestScopeRef.current !== scope) return
      setSnapshot((current) => ({ ...current, error, status: 'continuation-error' }))
    }
  }, [filters, snapshot.nextCursor, snapshot.status])

  const activeCount = Object.values(filters).filter(Boolean).length
  const filterOptions = snapshot.filters
  const controls = <FilterBar
    activeCount={activeCount}
    summary={filterSummary(filters, filterOptions)}
    onClear={clearFilters}
  >
    <FilterGroup label="Osoba">
      <select className="select" aria-label="Osoba" value={filters.actor} onChange={(event) => updateFilter('actor', event.target.value)}>
        <option value="">Wszystkie osoby</option>
        {filterOptions.actors.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </FilterGroup>
    <FilterGroup label="Klient">
      <select className="select" aria-label="Klient" value={filters.client} onChange={(event) => updateFilter('client', event.target.value)}>
        <option value="">Wszyscy klienci</option>
        {filterOptions.clients.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </FilterGroup>
    <FilterGroup label="Rodzaj">
      <select className="select" aria-label="Rodzaj" value={filters.kind} onChange={(event) => updateFilter('kind', event.target.value)}>
        <option value="">Wszystkie rodzaje</option>
        {ACTIVITY_KINDS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
      </select>
    </FilterGroup>
    <FilterGroup label="Okres">
      <div className="activity-history__period">
        <label>Od<input className="input" aria-label="Od" type="date" value={filters.from} onChange={(event) => updateFilter('from', event.target.value)} /></label>
        <label>Do<input className="input" aria-label="Do" type="date" value={filters.to} onChange={(event) => updateFilter('to', event.target.value)} /></label>
      </div>
    </FilterGroup>
  </FilterBar>

  return <>
    <div className="view-head">
      <div>
        <div className="eyebrow">Centrum</div>
        <h1 className="display view-head__title">Historia <em>aktywności</em></h1>
        <p className="view-head__sub">Zmiany wykonane w panelu przez osoby z zespołu.</p>
      </div>
    </div>
    {controls}
    {snapshot.status === 'loading' ? <ViewState tone="loading" icon="reports" title="Wczytywanie historii aktywności" /> : null}
    {snapshot.status === 'error' ? <ViewState
      tone="error"
      icon="reports"
      title="Nie udało się wczytać historii aktywności"
      hint="Sprawdź połączenie i spróbuj ponownie."
      action={<Button size="sm" onClick={retry}>Spróbuj ponownie</Button>}
    /> : null}
    {snapshot.status !== 'loading' && snapshot.status !== 'error' && snapshot.items.length === 0 ? <ViewState
      icon="reports"
      title="Brak aktywności dla wybranych filtrów"
      hint="Zmień okres lub wyczyść filtry."
    /> : null}
    {snapshot.items.length > 0 ? <>
      <HistoryRows items={snapshot.items} />
      {snapshot.status === 'continuation-error' ? <div className="form-warn form-warn--error" role="alert">
        Nie udało się wczytać kolejnych wpisów. <Button size="sm" variant="ghost" onClick={loadMore}>Spróbuj ponownie</Button>
      </div> : null}
      {snapshot.nextCursor && snapshot.status !== 'continuation-error' ? <Button
        className="activity-history__more"
        variant="soft"
        disabled={snapshot.status === 'loading-more'}
        onClick={loadMore}
      >{snapshot.status === 'loading-more' ? 'Wczytywanie…' : 'Pokaż więcej'}</Button> : null}
    </> : null}
  </>
}
