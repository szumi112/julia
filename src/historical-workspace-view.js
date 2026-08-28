import { fmtMonthYear, searchNorm } from './format.js'

const polish = new Intl.Collator('pl-PL', { sensitivity: 'base' })
const byText = (left, right) => polish.compare(left, right)
const compareId = (left, right) => left.id.localeCompare(right.id)

const compareSubjectRows = (left, right) => (
  byText(left.subjectName, right.subjectName)
  || byText(left.serviceLabel, right.serviceLabel)
  || compareId(left, right)
)

const subjectFor = (occurrence, clientsById) => {
  if (occurrence.historicalClientId !== null) {
    return {
      historicalClientId: occurrence.historicalClientId,
      subjectName: clientsById.get(occurrence.historicalClientId)?.name ?? 'Klient niedostępny',
      subjectKind: 'client',
    }
  }
  return {
    historicalClientId: null,
    subjectName: occurrence.counterparty?.name ?? 'Podmiot niedostępny',
    subjectKind: 'counterparty',
  }
}

const periodFacts = (period) => {
  if (period.precision === 'day') {
    return {
      kind: 'historical-day', day: period.day, month: period.month,
      periodLabel: 'Godzina nieustalona',
    }
  }
  if (period.precision === 'month') {
    return {
      kind: 'historical-month', day: undefined, month: period.month,
      periodLabel: 'Dzień nieustalony',
    }
  }
  return {
    kind: 'historical-unknown', day: undefined, month: null,
    periodLabel: 'Okres nieustalony',
  }
}

const rowFor = (occurrence, clientsById, specialistsById) => {
  const period = periodFacts(occurrence.period)
  const row = {
    kind: period.kind,
    id: occurrence.id,
    ...subjectFor(occurrence, clientsById),
    specialistId: occurrence.specialistId,
    specialistName: specialistsById.get(occurrence.specialistId)?.name
      ?? 'Specjalistka niedostępna',
    serviceLabel: occurrence.serviceLabel,
  }
  if (period.day !== undefined) row.day = period.day
  row.month = period.month
  row.periodLabel = period.periodLabel
  return Object.freeze(row)
}

const rowContext = (historicalClients, specialists = []) => ({
  clientsById: new Map(historicalClients.map((client) => [client.id, client])),
  specialistsById: new Map(specialists.map((specialist) => [specialist.id, specialist])),
})

export function historicalCalendarModel({
  occurrences, historicalClients, specialists, ym, showHistorical,
}) {
  const { clientsById, specialistsById } = rowContext(historicalClients, specialists)
  const exactRows = []
  const monthRows = []
  const unknownRows = []

  for (const occurrence of occurrences) {
    if (occurrence.status !== 'recorded') continue
    const row = rowFor(occurrence, clientsById, specialistsById)
    if (occurrence.period.precision === 'unknown') unknownRows.push(row)
    else if (occurrence.period.month === ym) {
      if (occurrence.period.precision === 'day') exactRows.push(row)
      else monthRows.push(row)
    }
  }

  exactRows.sort((left, right) => left.day.localeCompare(right.day) || compareSubjectRows(left, right))
  monthRows.sort(compareSubjectRows)
  unknownRows.sort(compareSubjectRows)
  const exactByDay = Object.create(null)
  if (showHistorical) {
    for (const row of exactRows) {
      const dayRows = exactByDay[row.day] ?? []
      dayRows.push(row)
      exactByDay[row.day] = dayRows
    }
    for (const day of Object.keys(exactByDay)) Object.freeze(exactByDay[day])
  }

  const historicalCount = exactRows.length + monthRows.length
  const unknownCount = unknownRows.length
  return Object.freeze({
    exactByDay: Object.freeze(exactByDay),
    monthOnlyRows: showHistorical ? Object.freeze(monthRows) : Object.freeze([]),
    unknownRows: showHistorical ? Object.freeze(unknownRows) : Object.freeze([]),
    historicalCount,
    visibleCount: showHistorical ? historicalCount : 0,
    unknownCount,
    suppressedCount: showHistorical ? 0 : historicalCount + unknownCount,
  })
}

const historyRowCompare = (left, right) => (
  byText(left.serviceLabel, right.serviceLabel) || compareId(left, right)
)

export function historicalClientHistoryModel({ historicalClient, occurrences, specialists = [] }) {
  const { clientsById, specialistsById } = rowContext([historicalClient], specialists)
  const exactDayRows = []
  const monthOnlyRows = []
  const unknownRows = []
  for (const occurrence of occurrences) {
    if (occurrence.status !== 'recorded'
      || occurrence.historicalClientId !== historicalClient.id) continue
    const row = rowFor(occurrence, clientsById, specialistsById)
    if (occurrence.period.precision === 'day') exactDayRows.push(row)
    else if (occurrence.period.precision === 'month') monthOnlyRows.push(row)
    else unknownRows.push(row)
  }
  exactDayRows.sort((left, right) => right.day.localeCompare(left.day) || historyRowCompare(left, right))
  monthOnlyRows.sort((left, right) => right.month.localeCompare(left.month) || historyRowCompare(left, right))
  unknownRows.sort(historyRowCompare)
  return Object.freeze({
    exactDayRows: Object.freeze(exactDayRows),
    monthOnlyRows: Object.freeze(monthOnlyRows),
    unknownRows: Object.freeze(unknownRows),
  })
}

export function historicalClientDirectoryModel({
  historicalClients, occurrences, specialists = [], ym, periodMode, query,
}) {
  const clientsById = new Map(historicalClients.map((client) => [client.id, client]))
  const specialistsById = new Map(specialists.map((specialist) => [specialist.id, specialist]))
  const grouped = new Map()
  for (const occurrence of occurrences) {
    if (occurrence.status !== 'recorded' || occurrence.historicalClientId === null) continue
    const matchesPeriod = periodMode === 'unknown'
      ? occurrence.period.precision === 'unknown'
      : occurrence.period.precision !== 'unknown' && occurrence.period.month === ym
    if (!matchesPeriod || !clientsById.has(occurrence.historicalClientId)) continue
    const rows = grouped.get(occurrence.historicalClientId) ?? []
    rows.push(occurrence)
    grouped.set(occurrence.historicalClientId, rows)
  }
  const needle = searchNorm(query).trim()
  const result = []
  for (const [id, visits] of grouped) {
    const client = clientsById.get(id)
    const haystack = searchNorm([
      client.name,
      ...visits.flatMap((visit) => [
        visit.serviceLabel,
        visit.counterparty?.name,
        specialistsById.get(visit.specialistId)?.name,
      ]),
    ].filter(Boolean).join(' '))
    if (needle && !haystack.includes(needle)) continue
    const knownMonths = visits
      .map((visit) => visit.period.month)
      .filter(Boolean)
      .toSorted()
    result.push(Object.freeze({
      id: client.id,
      name: client.name,
      status: client.status,
      version: client.version,
      lifecycle: client.status === 'activated' ? 'Aktywowano' : 'Historyczny',
      activeClientId: client.activeClientId,
      visitCount: visits.length,
      periodSummary: periodMode === 'unknown'
        ? 'Okres nieustalony'
        : knownMonths.length > 0 ? fmtMonthYear(knownMonths.at(-1)) : fmtMonthYear(ym),
    }))
  }
  result.sort((left, right) => byText(left.name, right.name) || compareId(left, right))
  return Object.freeze(result)
}

export function latestPopulatedMonthAction({
  selectedMonth, appointmentCount, historicalCount, latestPopulatedMonth,
}) {
  if (appointmentCount !== 0 || historicalCount !== 0 || latestPopulatedMonth === null
    || latestPopulatedMonth === selectedMonth) return null
  return Object.freeze({
    month: latestPopulatedMonth,
    label: `Pokaż ${fmtMonthYear(latestPopulatedMonth)}`,
  })
}

export function sortProfessionalDirectory(specialists) {
  return Object.freeze(specialists.toSorted((left, right) => (
    byText(left.name, right.name) || compareId(left, right)
  )))
}

const validMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value ?? '')
const validDay = (value) => /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value ?? '')

export function resolveCalendarHistoricalViewState({ params, persisted, today }) {
  const paramDate = validDay(params?.date) ? params.date : null
  const selected = paramDate
    ?? (validDay(persisted?.selected) ? persisted.selected : today)
  const ym = paramDate?.slice(0, 7)
    ?? (validMonth(params?.ym) ? params.ym : null)
    ?? (validMonth(persisted?.ym) ? persisted.ym : selected.slice(0, 7))
  const review = params?.review === 'unknown'
    ? 'unknown'
    : persisted?.review === 'unknown' ? 'unknown' : null
  return Object.freeze({ ym, selected, review })
}

export function resolveClientCatalogViewState({ params, persisted, today }) {
  const catalog = params?.catalog === 'historical'
    ? 'historical'
    : params?.catalog === 'current'
      ? 'current'
      : persisted?.catalog === 'historical' ? 'historical' : 'current'
  const historyYm = validMonth(params?.ym)
    ? params.ym
    : validMonth(persisted?.historyYm) ? persisted.historyYm : today.slice(0, 7)
  const historyPeriod = params?.historyPeriod === 'unknown'
    ? 'unknown'
    : params?.historyPeriod === 'known'
      ? 'known'
      : persisted?.historyPeriod === 'unknown' ? 'unknown' : 'known'
  return Object.freeze({ catalog, historyYm, historyPeriod })
}
