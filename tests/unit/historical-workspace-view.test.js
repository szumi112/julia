import assert from 'node:assert/strict'
import test from 'node:test'

import {
  historicalCalendarModel,
  historicalClientDirectoryModel,
  historicalClientHistoryModel,
  latestPopulatedMonthAction,
  resolveCalendarHistoricalViewState,
  resolveClientCatalogViewState,
  sortProfessionalDirectory,
} from '../../src/historical-workspace-view.js'

const historicalClients = Object.freeze([
  Object.freeze({
    id: 'hcl_zaneta', name: 'Żaneta Testowa', status: 'historical', activeClientId: null,
    version: 1, createdAt: '2026-01-01T08:00:00.000Z', updatedAt: '2026-01-01T08:00:00.000Z',
  }),
  Object.freeze({
    id: 'hcl_ola', name: 'Ola Historyczna', status: 'activated', activeClientId: 'cl_ola',
    version: 2, createdAt: '2026-01-01T08:00:00.000Z', updatedAt: '2026-02-01T08:00:00.000Z',
  }),
])

const specialists = Object.freeze([
  Object.freeze({ id: 'sp_zofia', name: 'Zofia Specjalistka', professionalTitle: 'Psycholożka' }),
  Object.freeze({ id: 'sp_anna', name: 'Anna Specjalistka', professionalTitle: 'Psycholożka' }),
])

const occurrence = (overrides = {}) => Object.freeze({
  id: 'hoc_day', historicalClientId: 'hcl_zaneta', counterparty: null,
  specialistId: 'sp_anna', serviceId: null, serviceLabel: 'Konsultacja',
  period: Object.freeze({ precision: 'day', day: '2026-07-12', month: '2026-07' }),
  status: 'recorded', version: 1, sourceRecordId: 'wbs_day',
  createdAt: '2026-01-01T08:00:00.000Z', updatedAt: '2026-01-01T08:00:00.000Z',
  ...overrides,
})

const occurrences = Object.freeze([
  occurrence(),
  occurrence({
    id: 'hoc_month', historicalClientId: 'hcl_ola', serviceLabel: 'Diagnoza',
    period: Object.freeze({ precision: 'month', day: null, month: '2026-07' }),
    sourceRecordId: 'wbs_month',
  }),
  occurrence({
    id: 'hoc_unknown', historicalClientId: null,
    counterparty: Object.freeze({ id: 'hcp_school', name: 'Szkoła Testowa' }),
    specialistId: 'sp_zofia', serviceLabel: 'Superwizja',
    period: Object.freeze({ precision: 'unknown', day: null, month: null }),
    sourceRecordId: 'wbs_unknown',
  }),
  occurrence({
    id: 'hoc_voided', status: 'voided', version: 2,
    period: Object.freeze({ precision: 'day', day: '2026-07-13', month: '2026-07' }),
    sourceRecordId: 'wbs_voided',
  }),
])

test('calendar model keeps exact-day, month-only and unknown occurrences exclusive and omits voided rows', () => {
  const model = historicalCalendarModel({
    occurrences, historicalClients, specialists, ym: '2026-07', showHistorical: true,
  })

  assert.deepEqual(Object.keys(model.exactByDay), ['2026-07-12'])
  assert.deepEqual(model.exactByDay['2026-07-12'].map(({ id }) => id), ['hoc_day'])
  assert.deepEqual(model.monthOnlyRows.map(({ id }) => id), ['hoc_month'])
  assert.deepEqual(model.unknownRows.map(({ id }) => id), ['hoc_unknown'])
  assert.equal(JSON.stringify(model).includes('hoc_voided'), false)
  assert.deepEqual(
    [model.historicalCount, model.visibleCount, model.unknownCount, model.suppressedCount],
    [2, 2, 1, 0],
  )
})

test('calendar rows expose exact Polish precision labels without appointment-only fields', () => {
  const model = historicalCalendarModel({
    occurrences, historicalClients, specialists, ym: '2026-07', showHistorical: true,
  })
  const rows = [
    model.exactByDay['2026-07-12'][0], model.monthOnlyRows[0], model.unknownRows[0],
  ]

  assert.deepEqual(rows.map(({ periodLabel }) => periodLabel), [
    'Godzina nieustalona', 'Dzień nieustalony', 'Okres nieustalony',
  ])
  for (const row of rows) {
    for (const key of ['time', 'duration', 'status', 'payment', 'amount']) {
      assert.equal(Object.hasOwn(row, key), false, `${row.id} must omit ${key}`)
    }
    assert.equal(Object.isFrozen(row), true)
  }
})

test('calendar model suppresses historical rows under appointment-only filters without inventing matches', () => {
  const model = historicalCalendarModel({
    occurrences, historicalClients, specialists, ym: '2026-07', showHistorical: false,
  })

  assert.deepEqual(Object.keys(model.exactByDay), [])
  assert.deepEqual(model.monthOnlyRows, [])
  assert.deepEqual(model.unknownRows, [])
  assert.deepEqual(
    [model.historicalCount, model.visibleCount, model.unknownCount, model.suppressedCount],
    [2, 0, 1, 3],
  )
})

test('latest month action is offered only for an unfiltered empty selected month and never selects it', () => {
  const input = Object.freeze({
    selectedMonth: '2026-08', appointmentCount: 0, historicalCount: 0,
    latestPopulatedMonth: '2026-07',
  })

  assert.deepEqual(latestPopulatedMonthAction(input), {
    month: '2026-07', label: 'Pokaż lipiec 2026',
  })
  assert.equal(input.selectedMonth, '2026-08')
  assert.equal(latestPopulatedMonthAction({ ...input, appointmentCount: 1 }), null)
  assert.equal(latestPopulatedMonthAction({ ...input, historicalCount: 1 }), null)
  assert.equal(latestPopulatedMonthAction({ ...input, latestPopulatedMonth: '2026-08' }), null)
  assert.equal(latestPopulatedMonthAction({ ...input, latestPopulatedMonth: null }), null)
})

test('calendar and client history use deterministic Polish name, service, precision and ID ordering', () => {
  const unordered = Object.freeze([
    occurrence({ id: 'hoc_b', serviceLabel: 'Badanie' }),
    occurrence({ id: 'hoc_a', serviceLabel: 'Badanie' }),
    occurrence({ id: 'hoc_ola', historicalClientId: 'hcl_ola', serviceLabel: 'Zajęcia' }),
    occurrence({
      id: 'hoc_new', serviceLabel: 'Terapia',
      period: Object.freeze({ precision: 'day', day: '2026-08-01', month: '2026-08' }),
    }),
    occurrence({
      id: 'hoc_old_month', serviceLabel: 'Diagnoza',
      period: Object.freeze({ precision: 'month', day: null, month: '2026-06' }),
    }),
    occurrence({
      id: 'hoc_new_month', serviceLabel: 'Diagnoza',
      period: Object.freeze({ precision: 'month', day: null, month: '2026-07' }),
    }),
    occurrence({
      id: 'hoc_unknown_z', serviceLabel: 'Zajęcia',
      period: Object.freeze({ precision: 'unknown', day: null, month: null }),
    }),
  ])
  const calendar = historicalCalendarModel({
    occurrences: unordered, historicalClients, specialists, ym: '2026-07', showHistorical: true,
  })
  const history = historicalClientHistoryModel({
    historicalClient: historicalClients[0], occurrences: unordered,
  })

  assert.deepEqual(calendar.exactByDay['2026-07-12'].map(({ id }) => id), [
    'hoc_ola', 'hoc_a', 'hoc_b',
  ])
  assert.deepEqual(history.exactDayRows.map(({ id }) => id), ['hoc_new', 'hoc_a', 'hoc_b'])
  assert.deepEqual(history.monthOnlyRows.map(({ id }) => id), ['hoc_new_month', 'hoc_old_month'])
  assert.deepEqual(history.unknownRows.map(({ id }) => id), ['hoc_unknown_z'])
})

test('calendar rows distinguish client, counterparty and missing identities safely', () => {
  const model = historicalCalendarModel({
    occurrences: Object.freeze([
      occurrences[0], occurrences[2], occurrence({ id: 'hoc_missing', historicalClientId: 'hcl_missing' }),
    ]),
    historicalClients, specialists, ym: '2026-07', showHistorical: true,
  })
  const dayRows = model.exactByDay['2026-07-12']

  assert.deepEqual(dayRows.map(({ subjectKind, subjectName }) => [subjectKind, subjectName]), [
    ['client', 'Klient niedostępny'],
    ['client', 'Żaneta Testowa'],
  ])
  assert.deepEqual(
    [model.unknownRows[0].subjectKind, model.unknownRows[0].subjectName],
    ['counterparty', 'Szkoła Testowa'],
  )
})

test('historical directory groups known or unknown visits and preserves activation link state', () => {
  const known = historicalClientDirectoryModel({
    historicalClients, occurrences, ym: '2026-07', periodMode: 'known', query: '',
  })
  const unknown = historicalClientDirectoryModel({
    historicalClients, occurrences: Object.freeze([
      ...occurrences,
      occurrence({
        id: 'hoc_unknown_client', historicalClientId: 'hcl_zaneta',
        period: Object.freeze({ precision: 'unknown', day: null, month: null }),
      }),
    ]), ym: '2026-07', periodMode: 'unknown', query: '',
  })

  assert.deepEqual(known.map(({ id, visitCount, lifecycle, activeClientId }) => (
    [id, visitCount, lifecycle, activeClientId]
  )), [
    ['hcl_ola', 1, 'Aktywowano', 'cl_ola'],
    ['hcl_zaneta', 1, 'Historyczny', null],
  ])
  assert.deepEqual(unknown.map(({ id }) => id), ['hcl_zaneta'])
  assert.deepEqual(historicalClientDirectoryModel({
    historicalClients, occurrences, ym: '2026-07', periodMode: 'known', query: 'diagnoza',
  }).map(({ id }) => id), ['hcl_ola'])
})

test('historical directory search includes the resolved specialist display name', () => {
  assert.deepEqual(historicalClientDirectoryModel({
    historicalClients,
    occurrences,
    specialists,
    ym: '2026-07',
    periodMode: 'known',
    query: 'Anna Specjalistka',
  }).map(({ id }) => id), ['hcl_ola', 'hcl_zaneta'])
  assert.deepEqual(historicalClientDirectoryModel({
    historicalClients,
    occurrences,
    specialists,
    ym: '2026-07',
    periodMode: 'known',
    query: 'Zofia Specjalistka',
  }), [])
})

test('professional directory sorts by Polish name and stable ID without authorization-role input', () => {
  const directory = sortProfessionalDirectory(Object.freeze([
    Object.freeze({ id: 'sp_julia_b', name: 'Julia Wolanin', professionalTitle: 'Specjalistka' }),
    Object.freeze({ id: 'sp_anna', name: 'Anna Nowak', professionalTitle: 'Psycholożka' }),
    Object.freeze({ id: 'sp_julia_a', name: 'Julia Wolanin', professionalTitle: 'Specjalistka' }),
  ]))

  assert.deepEqual(directory.map(({ id, name, professionalTitle }) => (
    [id, name, professionalTitle]
  )), [
    ['sp_anna', 'Anna Nowak', 'Psycholożka'],
    ['sp_julia_a', 'Julia Wolanin', 'Specjalistka'],
    ['sp_julia_b', 'Julia Wolanin', 'Specjalistka'],
  ])
  assert.equal(directory.some((item) => Object.hasOwn(item, 'role')), false)
})

test('calendar historical state gives valid URL month and review precedence over the registry', () => {
  assert.deepEqual(resolveCalendarHistoricalViewState({
    params: { date: '2026-06-18', ym: '2026-07', review: 'unknown' },
    persisted: { ym: '2026-05', selected: '2026-05-04', review: null },
    today: '2026-08-28',
  }), {
    ym: '2026-06', selected: '2026-06-18', review: 'unknown',
  })
  assert.deepEqual(resolveCalendarHistoricalViewState({
    params: { ym: '2026-07' },
    persisted: { ym: '2026-05', selected: '2026-05-04', review: 'unknown' },
    today: '2026-08-28',
  }), {
    ym: '2026-07', selected: '2026-05-04', review: 'unknown',
  })
})

test('client catalog state gives valid URL catalog, month and period precedence over the registry', () => {
  assert.deepEqual(resolveClientCatalogViewState({
    params: { catalog: 'historical', ym: '2026-06', historyPeriod: 'unknown' },
    persisted: { catalog: 'current', historyYm: '2026-05', historyPeriod: 'known' },
    today: '2026-08-28',
  }), {
    catalog: 'historical', historyYm: '2026-06', historyPeriod: 'unknown',
  })
  assert.deepEqual(resolveClientCatalogViewState({
    params: {}, persisted: {}, today: '2026-08-28',
  }), {
    catalog: 'current', historyYm: '2026-08', historyPeriod: 'known',
  })
})
