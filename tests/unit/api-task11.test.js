import assert from 'node:assert/strict'
import test from 'node:test'

import { createApiClient } from '../../src/api.js'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const TOKEN_A = 'v1.1999999999.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const TOKEN_B = 'v1.1999999998.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const NOW = '2026-08-27T10:00:00.000Z'
const resolutionAuthority = Object.freeze({
  serviceId: null, targetId: null, resolvedByStaffId: 'stf_owner_1',
  sourceRecordId: null, conflictId: null, sourceValue: null,
})

const sessionBody = (overrides = {}) => ({
  data: {
    actor: {
      id: 'stf_owner_1', displayName: 'Julia Właścicielka', professionalTitle: null,
      role: 'owner', specialistId: null, version: 3,
    },
    authorityRevision: 1,
    capabilities: [...ROLE_DEFAULT_CAPABILITIES.owner],
    csrfToken: TOKEN_A,
    csrfExpiresAt: '2033-05-18T03:33:19.000Z',
    environment: 'staging',
    dataMode: 'fictional',
    ...overrides,
  },
})

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

const errorResponse = (code, status) => jsonResponse({
  error: { code, correlationId: '77777777-7777-4777-8777-777777777777' },
}, status)

const queuedFetch = (...responses) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    assert.ok(next, `unexpected fetch ${url}`)
    return typeof next === 'function' ? next(url, init) : next
  }
  return { calls, fetchImpl }
}

const financeRow = Object.freeze({
  id: 'fin_task11_row', sourceKind: 'workbook', appointmentId: null,
  accountingMonth: '2026-08', occurredOn: '2026-08-07', kind: 'income',
  recordType: 'income', revenueGrosze: 18_000, receivableGrosze: 18_000,
  collectedGrosze: 5_000, expenseGrosze: 0, specialistId: 'sp_anna',
  serviceId: 'zajecia', program: null, paymentMethod: 'unknown',
  invoiceStatus: 'not_required', version: 1,
})

const kpis = (overrides = {}) => ({
  revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0,
  expensesGrosze: 0, incomeGrosze: 0, ...overrides,
})

const financeWindow = () => ({
  currentMonth: '2026-08', selectedMonth: '2026-08', fromMonth: '2026-03',
  toMonth: '2026-08',
  months: ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'],
  latestPopulatedMonth: '2026-08',
  kpis: kpis({
    revenueGrosze: 18_000, collectedGrosze: 5_000, outstandingGrosze: 13_000,
    incomeGrosze: 18_000,
  }),
  trend: [
    { month: '2026-03', ...kpis() }, { month: '2026-04', ...kpis() },
    { month: '2026-05', ...kpis() }, { month: '2026-06', ...kpis() },
    { month: '2026-07', ...kpis() },
    { month: '2026-08', ...kpis({
      revenueGrosze: 18_000, collectedGrosze: 5_000, outstandingGrosze: 13_000,
      incomeGrosze: 18_000,
    }) },
  ],
  splits: {
    specialist: { sp_anna: 18_000 }, service: { zajecia: 18_000 },
    payment: { cash: 5_000, outstanding: 13_000 },
    invoice: { not_required: { count: 1, revenueGrosze: 18_000 } },
    program: {
      english: { count: 0, revenueGrosze: 0 },
      tus: { count: 0, revenueGrosze: 0 },
    },
  },
  specialistLabels: [{ id: 'sp_anna', label: 'Anna Nowak' }],
  rows: [financeRow],
  coverage: { dateOnlyCount: 1, monthOnlyCount: 0, timedCount: 0, unknownCount: 0 },
  unknownPeriodCount: 0,
  complete: true,
})

const registryImport = Object.freeze({
  id: 'wbi_task11_import',
  artifact: {
    id: 'wba_task11_artifact', fingerprint: 'a'.repeat(64), byteSize: 4096,
    parserVersion: 2, materializerVersion: 2, createdAt: NOW,
  },
  status: 'materializing', version: 2, phase: 'index_finance',
  progress: { processed: 64, total: 2234 },
  summary: {
    sourceCount: 2235, quarantineCount: 3, conflictCount: 0,
    duplicateCount: 0, resolutionCount: 0,
  },
  resolutionVersion: 0, createdByStaffId: 'stf_owner_1', createdAt: NOW, updatedAt: NOW,
})

const registryPage = () => ({
  cursor: null, nextCursor: null, imports: [registryImport], exports: [], entries: [],
  complete: true,
})

const registrySource = (display = {}) => ({
  id: 'wbs_task11_source', recordType: 'income', disposition: 'accepted',
  sheetName: 'Sierpień 2026', rowNumber: 7,
  display: {
    accountingMonth: '2026-08', occurredOn: '2026-08-07', periodPrecision: 'day',
    periodMonth: '2026-08', amountGrosze: 18_000, paymentMethod: 'cash',
    settlementStatus: 'paid', invoiceStatus: 'not_required', specialistName: 'Anna',
    counterparty: null, sourceLabel: 'Konsultacja', ...display,
  },
})

const sourceDetailResponse = (display) => jsonResponse({ data: {
  importId: 'wbi_task11_import', section: 'source', cursor: null,
  nextCursor: null, items: [registrySource(display)], complete: true,
} })

test('Task 11 API accepts only exact internally coherent finance and registry DTOs', async () => {
  const controller = new AbortController()
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse({ data: financeWindow() }),
    jsonResponse({ data: registryPage() }),
    jsonResponse({ data: {
      importId: registryImport.id, section: 'quarantine', cursor: null, nextCursor: null,
      items: [{
        id: 'wbq_task11_quarantine', sourceRecordId: 'wbs_task11_source',
        primaryReason: 'SERVICE_DATE_MISSING', reasonCodes: ['SERVICE_DATE_MISSING'],
      }], complete: true,
    } }),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  const finance = await client.loadFinanceWindow({ selectedMonth: '2026-08' }, {
    signal: controller.signal,
  })
  const registry = await client.loadWorkbookRegistry({ cursor: null, section: 'all' }, {
    signal: controller.signal,
  })
  const detail = await client.loadWorkbookRegistryDetail({
    importId: registryImport.id, section: 'quarantine', cursor: null,
  }, { signal: controller.signal })

  assert.deepEqual(finance, financeWindow())
  assert.deepEqual(registry, registryPage())
  assert.equal(detail.items[0].primaryReason, 'SERVICE_DATE_MISSING')
  assert.ok(Object.isFrozen(finance.rows[0]))
  assert.ok(Object.isFrozen(registry.imports[0].artifact))
  assert.deepEqual(calls.map(({ url }) => url), [
    '/api/v1/session',
    '/api/v1/finance/window?month=2026-08',
    '/api/v1/workbooks/registry?section=all',
    '/api/v1/workbooks/registry/details',
  ])
  assert.equal(calls[1].init.signal, controller.signal)
  assert.equal(calls[2].init.signal, controller.signal)
  assert.equal(calls[3].init.signal, controller.signal)
  assert.equal(calls[3].init.body,
    '{"importId":"wbi_task11_import","section":"quarantine","cursor":null}')
})

test('Task 11 unknown-period registry is entries-only and rejects dated rows', async () => {
  const unknownEntry = {
    id: 'fin_task11_unknown', importId: 'wbi_task11_import', state: 'active',
    voidType: null, kind: 'income', recordType: 'english', accountingMonth: null,
    amountGrosze: 0, version: 1,
  }
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse({ data: {
      cursor: null, nextCursor: null, imports: [], exports: [], entries: [unknownEntry],
      complete: true,
    } }),
    jsonResponse({ data: {
      cursor: null, nextCursor: null, imports: [], exports: [],
      entries: [{ ...unknownEntry, accountingMonth: '2026-08' }], complete: true,
    } }),
  )
  const client = createApiClient({ fetchImpl })

  const result = await client.loadWorkbookRegistry({ cursor: null, section: 'unknown' })
  assert.equal(result.entries[0].accountingMonth, null)
  const unlinked = await createApiClient({ fetchImpl: queuedFetch(jsonResponse({ data: {
    cursor: null, nextCursor: null, imports: [], exports: [],
    entries: [{ ...unknownEntry, importId: null }], complete: true,
  } })).fetchImpl }).loadWorkbookRegistry({ cursor: null, section: 'unknown' })
  assert.equal(unlinked.entries[0].importId, null)
  assert.equal(calls[0].url, '/api/v1/workbooks/registry?section=unknown')
  await assert.rejects(client.loadWorkbookRegistry({ cursor: null, section: 'unknown' }), {
    code: 'INVALID_RESPONSE',
  })
})

test('Task 11 conflict detail exposes only its exact bounded plan digest', async () => {
  const planDigest = `v1_${'P'.repeat(43)}`
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse({ data: {
      importId: 'wbi_task11_import', section: 'conflicts', cursor: null,
      planDigest, specialistOptions: [], nextCursor: null,
      items: [{ id: `hcf_${'H'.repeat(43)}`, kind: 'specialist_mapping', resolved: false }],
      complete: true,
    } }),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  const detail = await client.loadWorkbookRegistryDetail({
    importId: 'wbi_task11_import', section: 'conflicts', cursor: null,
  })
  assert.equal(detail.planDigest, planDigest)
  assert.deepEqual(detail.items, [{
    id: `hcf_${'H'.repeat(43)}`, kind: 'specialist_mapping', resolved: false,
  }])
})

test('Task 11 conflict detail projects a bounded workbook mapping label only for workbook conflicts', async () => {
  const planDigest = `v1_${'P'.repeat(43)}`
  const sourceValue = 'Fikcyjna specjalistka po ponownym wczytaniu'
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse({ data: {
      importId: 'wbi_task11_import', section: 'conflicts', cursor: null,
      planDigest, specialistOptions: [], nextCursor: null,
      items: [{
        id: `wmc_${'H'.repeat(43)}`, kind: 'specialist_mapping', resolved: false,
        sourceValue,
      }],
      complete: true,
    } }),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  const detail = await client.loadWorkbookRegistryDetail({
    importId: 'wbi_task11_import', section: 'conflicts', cursor: null,
  })
  assert.deepEqual(detail.items, [{
    id: `wmc_${'H'.repeat(43)}`, kind: 'specialist_mapping', resolved: false,
    sourceValue,
  }])
})

test('Task 11 API rejects inconsistent finance totals and registry extra keys', async () => {
  const badWindow = financeWindow()
  badWindow.kpis = { ...badWindow.kpis, revenueGrosze: 17_999 }
  const badRegistry = registryPage()
  badRegistry.imports = [{ ...registryImport, sourceKey: 'must-not-cross' }]
  const { fetchImpl } = queuedFetch(
    jsonResponse({ data: badWindow }),
    jsonResponse({ data: badRegistry }),
  )
  const client = createApiClient({ fetchImpl })

  await assert.rejects(client.loadFinanceWindow({ selectedMonth: '2026-08' }), {
    code: 'INVALID_RESPONSE',
  })
  await assert.rejects(client.loadWorkbookRegistry({ cursor: null, section: 'all' }), {
    code: 'INVALID_RESPONSE',
  })
})

test('Task 11 client preserves every reviewed finance conflict and validation shape', async () => {
  const codes = [
    'FINANCE_ENTRY_VOIDED', 'FINANCE_ENTRY_NOT_READY',
    'FINANCE_ENTRY_DEPENDENCY_CONFLICT', 'FINANCE_WINDOW_LIMIT', 'FINANCE_WINDOW_RETRY',
  ]
  const responses = [jsonResponse(sessionBody())]
  for (const code of codes) responses.push(jsonResponse({ error: {
    code, correlationId: '99999999-9999-4999-8999-999999999999',
  } }, 409))
  responses.push(jsonResponse({ error: {
    code: 'VALIDATION_FAILED', details: { field: 'month' },
    correlationId: '99999999-9999-4999-8999-999999999999',
  } }, 400))
  const { fetchImpl } = queuedFetch(...responses)
  const client = createApiClient({ fetchImpl })
  await client.getSession()
  for (const code of codes) {
    await assert.rejects(client.loadFinanceWindow({ selectedMonth: '2026-08' }), { code })
  }
  await assert.rejects(client.loadFinanceWindow({ selectedMonth: '2026-08' }), {
    code: 'VALIDATION_FAILED', details: { field: 'month' },
  })
})

test('Task 11 client preserves the bounded registry overflow conflict', async () => {
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()), errorResponse('WORKBOOK_REGISTRY_LIMIT', 409),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()
  await assert.rejects(client.loadWorkbookRegistry({ cursor: null, section: 'all' }), {
    code: 'WORKBOOK_REGISTRY_LIMIT', status: 409,
  })
})

test('Task 11 finance and registry rows enforce the authoritative money ceiling', async () => {
  const amountGrosze = 100_000_001
  const oversizedWindow = financeWindow()
  oversizedWindow.rows = [{
    ...financeRow, revenueGrosze: amountGrosze, receivableGrosze: amountGrosze,
    collectedGrosze: 0,
  }]
  oversizedWindow.kpis = kpis({
    revenueGrosze: amountGrosze, outstandingGrosze: amountGrosze,
    incomeGrosze: amountGrosze,
  })
  oversizedWindow.trend[5] = { month: '2026-08', ...oversizedWindow.kpis }
  oversizedWindow.splits = {
    specialist: { sp_anna: amountGrosze }, service: { zajecia: amountGrosze },
    payment: { outstanding: amountGrosze },
    invoice: { not_required: { count: 1, revenueGrosze: amountGrosze } },
    program: {
      english: { count: 0, revenueGrosze: 0 }, tus: { count: 0, revenueGrosze: 0 },
    },
  }
  const oversizedEntry = {
    id: 'fin_task11_oversized', importId: 'wbi_task11_import', state: 'active',
    voidType: null, kind: 'income', recordType: 'income', accountingMonth: '2026-08',
    amountGrosze, version: 1,
  }
  const { fetchImpl } = queuedFetch(
    jsonResponse({ data: oversizedWindow }),
    jsonResponse({ data: {
      cursor: null, nextCursor: null, imports: [], exports: [], entries: [oversizedEntry],
      complete: true,
    } }),
    jsonResponse(sessionBody()),
    sourceDetailResponse({ amountGrosze }),
  )
  const client = createApiClient({ fetchImpl })

  await assert.rejects(client.loadFinanceWindow({ selectedMonth: '2026-08' }), {
    code: 'INVALID_RESPONSE',
  })
  await assert.rejects(client.loadWorkbookRegistry({ cursor: null, section: 'entries' }), {
    code: 'INVALID_RESPONSE',
  })
  await client.getSession()
  await assert.rejects(client.loadWorkbookRegistryDetail({
    importId: 'wbi_task11_import', section: 'source', cursor: null,
  }), { code: 'INVALID_RESPONSE' })
})

test('source detail enforces exact period and payment tuple relationships', async () => {
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    sourceDetailResponse({ periodMonth: '2026-07' }),
    sourceDetailResponse({ periodPrecision: 'month' }),
    sourceDetailResponse({
      occurredOn: null, periodPrecision: 'unknown', periodMonth: '2026-08',
    }),
    sourceDetailResponse({ settlementStatus: null, invoiceStatus: null }),
    sourceDetailResponse({}),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(client.loadWorkbookRegistryDetail({
      importId: 'wbi_task11_import', section: 'source', cursor: null,
    }), { code: 'INVALID_RESPONSE' })
  }
  const valid = await client.loadWorkbookRegistryDetail({
    importId: 'wbi_task11_import', section: 'source', cursor: null,
  })
  assert.deepEqual(valid.items, [registrySource()])
})

test('Task 11 finance splits reject hostile and noncanonical keys before projection', async () => {
  const hostileWindow = financeWindow()
  hostileWindow.splits.specialist = JSON.parse('{"__proto__":18000}')
  const unsortedWindow = financeWindow()
  unsortedWindow.splits.payment = { outstanding: 13_000, cash: 5_000 }
  const { fetchImpl } = queuedFetch(
    jsonResponse({ data: hostileWindow }),
    jsonResponse({ data: unsortedWindow }),
  )
  const client = createApiClient({ fetchImpl })

  await assert.rejects(client.loadFinanceWindow({ selectedMonth: '2026-08' }), {
    code: 'INVALID_RESPONSE',
  })
  await assert.rejects(client.loadFinanceWindow({ selectedMonth: '2026-08' }), {
    code: 'INVALID_RESPONSE',
  })
})

test('Task 11 finance splits reject accessors without evaluating them', async () => {
  let reads = 0
  const specialist = {}
  Object.defineProperty(specialist, 'sp_anna', {
    enumerable: true,
    get() {
      reads += 1
      return 18_000
    },
  })
  const hostileWindow = financeWindow()
  hostileWindow.splits.specialist = specialist
  const { fetchImpl } = queuedFetch({
    ok: true, status: 200, json: async () => ({ data: hostileWindow }),
  })
  const client = createApiClient({ fetchImpl })

  await assert.rejects(client.loadFinanceWindow({ selectedMonth: '2026-08' }), {
    code: 'INVALID_RESPONSE',
  })
  assert.equal(reads, 0)
})

test('Task 11 finance window rejects months before the canonical reporting floor', async () => {
  let fetched = false
  const client = createApiClient({ fetchImpl: async () => { fetched = true } })

  await assert.rejects(client.loadFinanceWindow({ selectedMonth: '2000-05' }), {
    code: 'CLIENT_INPUT_INVALID',
  })
  assert.equal(fetched, false)

  const badWindow = financeWindow()
  badWindow.latestPopulatedMonth = '2000-05'
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()), jsonResponse({ data: badWindow }),
  )
  const responseClient = createApiClient({ fetchImpl })
  await responseClient.getSession()
  await assert.rejects(responseClient.loadFinanceWindow({ selectedMonth: '2026-08' }), {
    code: 'INVALID_RESPONSE',
  })
})

test('Task 11 API contains hostile option and nested signal accessors before fetch', async () => {
  let fetched = false
  let signalReads = 0
  const signal = {}
  Object.defineProperties(signal, {
    aborted: {
      get() {
        signalReads += 1
        throw new Error('private abort state')
      },
    },
    addEventListener: { value() {} },
  })
  const client = createApiClient({ fetchImpl: async () => { fetched = true } })

  await assert.rejects(async () => client.loadFinanceWindow(
    { selectedMonth: '2026-08' },
    new Proxy({}, { getPrototypeOf() { throw new Error('private prototype') } }),
  ), { name: 'ApiError', code: 'CLIENT_INPUT_INVALID' })
  await assert.rejects(client.loadFinanceWindow(
    { selectedMonth: '2026-08' }, { signal },
  ), { name: 'ApiError', code: 'CLIENT_INPUT_INVALID' })
  assert.equal(signalReads, 0)
  assert.equal(fetched, false)
})

const importDto = (overrides = {}) => ({
  id: 'wbi_task11_import', artifactId: 'wba_task11_artifact', status: 'materializing',
  acceptedRecords: 2232, quarantinedRecords: 3, createdByStaffId: 'stf_owner_1',
  version: 2, createdAt: NOW, updatedAt: NOW, completedAt: null, ...overrides,
})

const jobDto = (overrides = {}) => ({
  id: 'wbj_task11_job', phase: 'index_finance', status: 'running', cursor: 64,
  totalRecords: 2234, processedRecords: 64, version: 2, updatedAt: NOW,
  completedAt: null, ...overrides,
})

const previewDto = (overrides = {}) => ({
  fingerprint: 'f'.repeat(64), parserVersion: 2, materializerVersion: 2,
  planDigest: `v1_${'C'.repeat(43)}`,
  previewToken: `v1.1.${'A'.repeat(86)}.${'B'.repeat(43)}`,
  counts: {
    financeRows: 1, datedFinanceRows: 0, undatedFinanceRows: 1, tusRows: 0,
    englishRows: 0, costOrAncillaryRows: 0,
  },
  warnings: [],
  reconciliation: {
    sourceCandidates: 1, acceptedRows: 0, quarantinedRows: 1,
    excludedFormulaBlocks: 0, excludedFormulaRows: 0,
  },
  proposedMappings: [],
  conflicts: [{
    id: `wmc_${'D'.repeat(43)}`, code: 'SPECIALIST_MAPPING_REQUIRED',
    sourceValue: 'Nieznana Specjalistka',
  }, {
    code: 'PANEL_ROW_MISSING', field: null, recordId: 'fin_missing_panel_row',
  }],
  quarantine: [{
    sourceKey: 'workbook:v1:0:4:0', sheet: 'Wrzesień 2025', rowNumber: 4,
    recordType: 'income', accountingMonth: '2025-09', occurredOn: null,
    periodPrecision: 'month', periodMonth: '2025-09',
    reasonCode: 'SERVICE_DATE_MISSING', reasonCodes: ['SERVICE_DATE_MISSING'],
    raw: { Cena: 180 },
  }],
  specialistOptions: [{ id: 'sp_anna', label: 'Anna Nowak' }],
  specialistLabels: [],
  workbookKind: 'legacy',
  ...overrides,
})

test('preview projects exact mapping/blocking conflicts and strips quarantined raw cells', async () => {
  const file = new File([new Uint8Array([80, 75, 3, 4])], 'fikcyjny.xlsx', { type: XLSX })
  const hostile = previewDto()
  hostile.conflicts = [{
    ...hostile.conflicts[0], arbitraryServerText: 'must not cross',
  }]
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse({ data: previewDto() }),
    jsonResponse({ data: hostile }),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  const result = await client.previewWorkbook(file)
  assert.deepEqual(result.mappingConflicts, [{
    id: `wmc_${'D'.repeat(43)}`, code: 'SPECIALIST_MAPPING_REQUIRED',
    sourceValue: 'Nieznana Specjalistka',
  }])
  assert.equal(result.hasBlockingConflicts, true)
  assert.deepEqual(result.quarantine, [{
    sheet: 'Wrzesień 2025', rowNumber: 4, recordType: 'income',
    reasonCode: 'SERVICE_DATE_MISSING', reasonCodes: ['SERVICE_DATE_MISSING'],
  }])
  assert.equal(JSON.stringify(result).includes('Cena'), false)
  await assert.rejects(client.previewWorkbook(file), { code: 'INVALID_RESPONSE' })
})

test('preview accepts only an exact sorted disjoint Panel-v2 mutation review', async () => {
  const file = new File([new Uint8Array([80, 75, 3, 4])], 'panel.xlsx', { type: XLSX })
  const panel = {
    unchangedIds: ['fin_panel_a'],
    updates: [{
      id: 'fin_panel_b', type: 'finance_entry',
      values: { amountGrosze: 20_000, paymentMethod: 'transfer' },
    }],
    voidIds: ['fin_panel_c'],
  }
  const overlap = structuredClone(panel)
  overlap.voidIds = ['fin_panel_b']
  const unsorted = structuredClone(panel)
  unsorted.unchangedIds = ['fin_panel_z', 'fin_panel_a']
  const extra = structuredClone(panel)
  extra.updates[0].sourceValue = 'must not cross'
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse({ data: previewDto({
      workbookKind: 'panel-v2', conflicts: [], quarantine: [], panelChanges: panel,
    }) }),
    jsonResponse({ data: previewDto({
      workbookKind: 'panel-v2', conflicts: [], quarantine: [], panelChanges: overlap,
    }) }),
    jsonResponse({ data: previewDto({
      workbookKind: 'panel-v2', conflicts: [], quarantine: [], panelChanges: unsorted,
    }) }),
    jsonResponse({ data: previewDto({
      workbookKind: 'panel-v2', conflicts: [], quarantine: [], panelChanges: extra,
    }) }),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  assert.deepEqual((await client.previewWorkbook(file)).panelChanges, panel)
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(client.previewWorkbook(file), { code: 'INVALID_RESPONSE' })
  }
})

test('Panel-v2 preview binds exact archived-capable labels to every referenced specialist', async () => {
  const file = new File([new Uint8Array([80, 75, 3, 4])], 'panel.xlsx', { type: XLSX })
  const exact = previewDto({
    workbookKind: 'panel-v2', quarantine: [], proposedMappings: [],
    conflicts: [{
      code: 'PANEL_CONCURRENT_EDIT', recordId: 'fin_panel_b', field: 'specialistId',
      current: 'sp_archived', edited: 'sp_anna',
    }],
    panelChanges: {
      unchangedIds: [], updates: [{
        id: 'fin_panel_a', type: 'finance_entry', values: { specialistId: 'sp_anna' },
      }], voidIds: [],
    },
    specialistLabels: [
      { id: 'sp_anna', label: 'Anna Nowak' },
      { id: 'sp_archived', label: 'Barbara Archiwalna' },
    ],
  })
  const missing = structuredClone(exact)
  missing.specialistLabels.pop()
  const extra = structuredClone(exact)
  extra.specialistLabels.push({ id: 'sp_extra', label: 'Celina Dodatkowa' })
  const wrong = structuredClone(exact)
  wrong.specialistLabels[1] = { id: 'sp_wrong', label: 'Barbara Archiwalna' }
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    ...[exact, missing, extra, wrong].map((data) => jsonResponse({ data })),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  assert.deepEqual((await client.previewWorkbook(file)).specialistLabels, exact.specialistLabels)
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(client.previewWorkbook(file), { code: 'INVALID_RESPONSE' })
  }
})

test('preview rejects hostile arrays inside quarantined source data without reading them', async () => {
  const file = new File([new Uint8Array([80, 75, 3, 4])], 'fikcyjny.xlsx', { type: XLSX })
  let reads = 0
  const cells = []
  Object.defineProperty(cells, '0', {
    enumerable: true,
    get() {
      reads += 1
      return 180
    },
  })
  const hostile = previewDto()
  hostile.quarantine[0].raw = { Cena: cells }
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    { ok: true, status: 200, json: async () => ({ data: hostile }) },
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  await assert.rejects(client.previewWorkbook(file), { code: 'INVALID_RESPONSE' })
  assert.equal(reads, 0)
})

test('multipart retry rebuilds FormData around the same selected File and explicit resolutions', async () => {
  const file = new File([new Uint8Array([80, 75, 3, 4])], 'fikcyjny-import.xlsx', {
    type: XLSX,
  })
  const previewToken = `v1.1.${'A'.repeat(86)}.${'B'.repeat(43)}`
  const resolutions = [{ conflictId: `wmc_${'C'.repeat(43)}`, specialistId: 'sp_anna' }]
  const imported = importDto({ status: 'ready', version: 1 })
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    errorResponse('CSRF_EXPIRED', 403),
    jsonResponse(sessionBody({
      csrfToken: TOKEN_B, authorityRevision: 2,
      csrfExpiresAt: '2033-05-18T03:33:18.000Z',
    })),
    jsonResponse({ data: { import: imported } }, 201),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()
  const signal = new AbortController().signal

  assert.deepEqual(await client.createWorkbookImport(
    file, previewToken, resolutions,
    { idempotencyKey: 'workbook-import-key-0001', signal },
  ), imported)

  const attempts = [calls[1], calls[3]]
  for (const attempt of attempts) {
    assert.equal(attempt.init.signal, signal)
    assert.equal(new Headers(attempt.init.headers).get('Content-Type'), null)
    assert.equal(new Headers(attempt.init.headers).get('Idempotency-Key'),
      'workbook-import-key-0001')
    assert.ok(attempt.init.body instanceof FormData)
    assert.equal(attempt.init.body.get('previewToken'), previewToken)
    assert.equal(attempt.init.body.get('resolutions'), JSON.stringify(resolutions))
    assert.equal(attempt.init.body.get('workbook').name, file.name)
  }
  assert.notEqual(attempts[0].init.body, attempts[1].init.body)
})

test('multipart retry starts a causal CSRF refresh after a held earlier session request', async () => {
  const file = new File([new Uint8Array([80, 75, 3, 4])], 'fikcyjny-import.xlsx', {
    type: XLSX,
  })
  const imported = importDto({ status: 'ready', version: 1 })
  let releaseHeld
  const heldResponse = new Promise((resolve) => { releaseHeld = resolve })
  const queued = queuedFetch(
    jsonResponse(sessionBody()),
    () => heldResponse,
    errorResponse('CSRF_EXPIRED', 403),
    jsonResponse(sessionBody({
      csrfToken: TOKEN_B,
      csrfExpiresAt: '2033-05-18T03:33:18.000Z',
    })),
    jsonResponse({ data: { import: imported } }, 201),
  )
  const client = createApiClient({ fetchImpl: queued.fetchImpl })
  await client.getSession()

  const held = client.getSession()
  const action = client.createWorkbookImport(
    file,
    `v1.1.${'A'.repeat(86)}.${'B'.repeat(43)}`,
    [],
    { idempotencyKey: 'workbook-import-key-0001' },
  )
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(queued.calls.map(({ url }) => url), [
      '/api/v1/session',
      '/api/v1/session',
      '/api/v1/workbooks/imports',
      '/api/v1/session',
      '/api/v1/workbooks/imports',
    ])
    assert.deepEqual(await action, imported)
    const attempts = queued.calls.filter(({ url }) => url === '/api/v1/workbooks/imports')
    assert.equal(new Headers(attempts[0].init.headers).get('X-CSRF-Token'), TOKEN_A)
    assert.equal(new Headers(attempts[1].init.headers).get('X-CSRF-Token'), TOKEN_B)
    assert.equal(new Headers(attempts[0].init.headers).get('Idempotency-Key'),
      'workbook-import-key-0001')
    assert.equal(new Headers(attempts[1].init.headers).get('Idempotency-Key'),
      'workbook-import-key-0001')
  } finally {
    releaseHeld(jsonResponse(sessionBody()))
    await Promise.allSettled([held, action])
  }
})

test('status, resolution and void commands use landed exact bodies and return exact DTOs', async () => {
  const status = {
    import: importDto(), job: jobDto(),
    evidence: { createdRecords: 5, voidedRecords: 7, converged: false },
  }
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse({ data: status }),
    jsonResponse({ data: {
      importId: 'wbi_task11_import', resolutionCount: 1,
      importVersion: 3, resolutionVersion: 1,
    } }),
    jsonResponse({ data: { entryId: 'fin_task11_row', state: 'void', version: 1 } }),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()
  const signal = new AbortController().signal

  assert.deepEqual(await client.getWorkbookImport('wbi_task11_import', { signal }), status)
  assert.deepEqual(await client.recordWorkbookResolutions('wbi_task11_import', {
    expectedVersion: 0, planDigest: `v1_${'D'.repeat(43)}`,
    resolutions: [{ conflictId: `wmc_${'E'.repeat(43)}`, specialistId: 'sp_anna' }],
  }, { idempotencyKey: 'workbook-resolution-key-0001', signal }), {
    importId: 'wbi_task11_import', resolutionCount: 1,
    importVersion: 3, resolutionVersion: 1,
  })
  assert.deepEqual(await client.voidLedgerEntry(
    'fin_task11_row', 1, 'Błędna pozycja testowa',
    { idempotencyKey: 'finance-void-key-0001', signal },
  ), { entryId: 'fin_task11_row', state: 'void', version: 1 })
  assert.equal(calls[1].init.signal, signal)
  assert.equal(calls[2].init.body,
    `{"expectedVersion":0,"planDigest":"v1_${'D'.repeat(43)}","resolutions":[{"conflictId":"wmc_${'E'.repeat(43)}","specialistId":"sp_anna"}]}`)
  assert.equal(calls[3].init.body,
    '{"expectedVersion":1,"reason":"Błędna pozycja testowa"}')
})

test('workbook status and continuation bind the exact import identity and a version that never goes backwards', async () => {
  const wrongImport = {
    import: importDto({ id: 'wbi_task11_other' }), job: jobDto(),
    evidence: { createdRecords: 0, voidedRecords: 0, converged: false },
  }
  // A repeated import version is normal mid-materialization, so only a version
  // that regresses below the one sent proves the response is stale.
  const stale = {
    import: importDto({ version: 1 }), job: jobDto({ version: 1 }),
    evidence: { createdRecords: 0, voidedRecords: 0, converged: false },
  }
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()), jsonResponse({ data: wrongImport }),
    jsonResponse({ data: stale }),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  await assert.rejects(client.getWorkbookImport('wbi_task11_import'), {
    code: 'INVALID_RESPONSE',
  })
  await assert.rejects(client.continueWorkbookImport(
    'wbi_task11_import', 2, { idempotencyKey: 'workbook-continue-boundary-1' },
  ), { code: 'INVALID_RESPONSE' })
})

test('binary export is an audited POST with strict private headers and exact length', async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 0, 255])
  const signal = new AbortController().signal
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    new Response(bytes, { headers: {
      'cache-control': 'private, no-store',
      'content-disposition': 'attachment; filename="bear-with-me-panel-v2-2026-08-27.xlsx"',
      'content-length': String(bytes.byteLength),
      'content-type': XLSX,
      'x-content-type-options': 'nosniff',
    } }),
  )
  const client = createApiClient({
    fetchImpl, idempotencyKeyFactory: () => 'workbook-export-key-0001',
  })
  await client.getSession()

  const exported = await client.exportWorkbook({ format: 'panel-v2' }, { signal })
  assert.equal(exported.filename, 'bear-with-me-panel-v2-2026-08-27.xlsx')
  assert.deepEqual(exported.bytes, bytes)
  assert.equal(calls[1].url, '/api/v1/workbooks/exports')
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].init.body, '{"format":"panel-v2"}')
  assert.equal(calls[1].init.signal, signal)
  assert.equal(new Headers(calls[1].init.headers).get('X-CSRF-Token'), TOKEN_A)
  assert.equal(new Headers(calls[1].init.headers).get('Idempotency-Key'),
    'workbook-export-key-0001')
})

test('binary export retains its internal replay key only across ambiguous failure', async () => {
  const response = () => new Response(new Uint8Array([80, 75, 3, 4]), { headers: {
    'cache-control': 'private, no-store',
    'content-disposition': 'attachment; filename="bear-with-me-panel-v2.xlsx"',
    'content-length': '4', 'content-type': XLSX, 'x-content-type-options': 'nosniff',
  } })
  const keys = ['workbook-export-replay-0001', 'workbook-export-replay-0002',
    'workbook-export-replay-0003']
  const { calls, fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    () => { throw new Error('lost response') }, response(),
    errorResponse('IDEMPOTENCY_CONFLICT', 409), response(),
  )
  const client = createApiClient({
    fetchImpl, idempotencyKeyFactory: () => keys.shift(),
  })
  await client.getSession()

  await assert.rejects(client.exportWorkbook({ format: 'panel-v2' }), {
    code: 'NETWORK_ERROR',
  })
  await client.exportWorkbook({ format: 'panel-v2' })
  await assert.rejects(client.exportWorkbook({ format: 'panel-v2' }), {
    code: 'IDEMPOTENCY_CONFLICT',
  })
  await client.exportWorkbook({ format: 'panel-v2' })
  const exportedKeys = calls.slice(1).map(({ init }) => (
    new Headers(init.headers).get('Idempotency-Key')
  ))
  assert.deepEqual(exportedKeys, [
    'workbook-export-replay-0001', 'workbook-export-replay-0001',
    'workbook-export-replay-0002', 'workbook-export-replay-0003',
  ])
})

test('binary export requires a declared bounded length and wipes source chunks after copying', async () => {
  const sourceChunk = new Uint8Array([80, 75, 3, 4])
  let read = false
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({
      'cache-control': 'private, no-store',
      'content-disposition': 'attachment; filename="bear-with-me-panel-v2.xlsx"',
      'content-length': String(sourceChunk.byteLength),
      'content-type': XLSX,
      'x-content-type-options': 'nosniff',
    }),
    body: { getReader: () => ({
      read: async () => read
        ? { done: true, value: undefined }
        : (read = true, { done: false, value: sourceChunk }),
      cancel: async () => {},
    }) },
  }
  const missingLength = new Response(new Uint8Array([80, 75, 3, 4]), { headers: {
    'cache-control': 'private, no-store',
    'content-disposition': 'attachment; filename="bear-with-me-panel-v2.xlsx"',
    'content-type': XLSX,
    'x-content-type-options': 'nosniff',
  } })
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()), response, missingLength,
  )
  const client = createApiClient({
    fetchImpl, idempotencyKeyFactory: () => 'workbook-export-key-0001',
  })
  await client.getSession()

  const result = await client.exportWorkbook({ format: 'panel-v2' })
  assert.deepEqual(result.bytes, new Uint8Array([80, 75, 3, 4]))
  assert.deepEqual(sourceChunk, new Uint8Array(4))
  await assert.rejects(client.exportWorkbook({ format: 'panel-v2' }), {
    code: 'INVALID_RESPONSE',
  })
})

test('binary export rejects noncanonical private headers and cancels unread bodies', async () => {
  const cancelled = []
  const response = (cacheControl, contentLength, index) => {
    let read = false
    return {
      ok: true,
      status: 200,
      headers: new Headers({
        'cache-control': cacheControl,
        'content-disposition': 'attachment; filename="bear-with-me-panel-v2.xlsx"',
        'content-length': contentLength,
        'content-type': XLSX,
        'x-content-type-options': 'nosniff',
      }),
      body: {
        async cancel() { cancelled.push(index) },
        getReader: () => ({
          read: async () => read
            ? { done: true, value: undefined }
            : (read = true, { done: false, value: new Uint8Array([80, 75, 3, 4]) }),
          async cancel() { cancelled.push(index) },
        }),
      },
    }
  }
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    response('public, private, no-store', '4', 1),
    response('private, no-store', '04', 2),
  )
  const client = createApiClient({
    fetchImpl, idempotencyKeyFactory: () => 'workbook-export-key-0001',
  })
  await client.getSession()

  await assert.rejects(client.exportWorkbook({ format: 'panel-v2' }), {
    code: 'INVALID_RESPONSE',
  })
  await assert.rejects(client.exportWorkbook({ format: 'panel-v2' }), {
    code: 'INVALID_RESPONSE',
  })
  assert.deepEqual(cancelled, [1, 2])
})

test('binary export wipes the rejected current chunk as well as earlier chunks', async () => {
  const sourceChunk = new Uint8Array([80, 75, 3, 4])
  let read = false
  let cancelled = false
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({
      'cache-control': 'private, no-store',
      'content-disposition': 'attachment; filename="bear-with-me-panel-v2.xlsx"',
      'content-length': '3',
      'content-type': XLSX,
      'x-content-type-options': 'nosniff',
    }),
    body: { getReader: () => ({
      read: async () => read
        ? { done: true, value: undefined }
        : (read = true, { done: false, value: sourceChunk }),
      cancel: async () => { cancelled = true },
    }) },
  }
  const { fetchImpl } = queuedFetch(jsonResponse(sessionBody()), response)
  const client = createApiClient({
    fetchImpl, idempotencyKeyFactory: () => 'workbook-export-key-0001',
  })
  await client.getSession()

  await assert.rejects(client.exportWorkbook({ format: 'panel-v2' }), {
    code: 'INVALID_RESPONSE',
  })
  assert.equal(cancelled, true)
  assert.deepEqual(sourceChunk, new Uint8Array(4))
})

test('binary export cancels an acquired reader when its read accessor is hostile', async () => {
  let cancelled = false
  const reader = {
    cancel: async () => { cancelled = true },
  }
  Object.defineProperty(reader, 'read', {
    get() { throw new Error('private reader') },
  })
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({
      'cache-control': 'private, no-store',
      'content-disposition': 'attachment; filename="bear-with-me-panel-v2.xlsx"',
      'content-length': '4',
      'content-type': XLSX,
      'x-content-type-options': 'nosniff',
    }),
    body: { getReader: () => reader },
  }
  const { fetchImpl } = queuedFetch(jsonResponse(sessionBody()), response)
  const client = createApiClient({
    fetchImpl, idempotencyKeyFactory: () => 'workbook-export-key-0001',
  })
  await client.getSession()

  await assert.rejects(client.exportWorkbook({ format: 'panel-v2' }), {
    code: 'INVALID_RESPONSE',
  })
  assert.equal(cancelled, true)
})

test('binary export rejects and wipes a nonempty terminal stream value', async () => {
  const firstChunk = new Uint8Array([80, 75, 3, 4])
  const terminalChunk = new Uint8Array([9, 8, 7, 6])
  const results = [
    { done: false, value: firstChunk },
    { done: true, value: terminalChunk },
  ]
  let cancelled = false
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({
      'cache-control': 'private, no-store',
      'content-disposition': 'attachment; filename="bear-with-me-panel-v2.xlsx"',
      'content-length': '4',
      'content-type': XLSX,
      'x-content-type-options': 'nosniff',
    }),
    body: { getReader: () => ({
      read: async () => results.shift(),
      cancel: async () => { cancelled = true },
    }) },
  }
  const { fetchImpl } = queuedFetch(jsonResponse(sessionBody()), response)
  const client = createApiClient({
    fetchImpl, idempotencyKeyFactory: () => 'workbook-export-key-0001',
  })
  await client.getSession()

  await assert.rejects(client.exportWorkbook({ format: 'panel-v2' }), {
    code: 'INVALID_RESPONSE',
  })
  assert.equal(cancelled, true)
  assert.deepEqual(firstChunk, new Uint8Array(4))
  assert.deepEqual(terminalChunk, new Uint8Array(4))
})

test('binary export rejects stream result accessors without invoking them', async () => {
  let doneReads = 0
  const sourceChunk = new Uint8Array([80, 75, 3, 4])
  const result = { value: sourceChunk }
  Object.defineProperty(result, 'done', {
    enumerable: true,
    get() {
      doneReads += 1
      return false
    },
  })
  let cancelled = false
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({
      'cache-control': 'private, no-store',
      'content-disposition': 'attachment; filename="bear-with-me-panel-v2.xlsx"',
      'content-length': '4',
      'content-type': XLSX,
      'x-content-type-options': 'nosniff',
    }),
    body: { getReader: () => ({
      read: async () => result,
      cancel: async () => { cancelled = true },
    }) },
  }
  const { fetchImpl } = queuedFetch(jsonResponse(sessionBody()), response)
  const client = createApiClient({
    fetchImpl, idempotencyKeyFactory: () => 'workbook-export-key-0001',
  })
  await client.getSession()

  await assert.rejects(client.exportWorkbook({ format: 'panel-v2' }), {
    code: 'INVALID_RESPONSE',
  })
  assert.equal(doneReads, 0)
  assert.equal(cancelled, true)
  assert.deepEqual(sourceChunk, new Uint8Array(4))
})

test('binary export contains hostile response and error accessors as fixed API errors', async () => {
  const hostileError = {}
  Object.defineProperty(hostileError, 'error', {
    enumerable: true,
    get() { throw new Error('private error payload') },
  })
  const responses = [
    {
      ok: true,
      get status() { throw new Error('private response status') },
    },
    {
      ok: false,
      status: 500,
      json: async () => hostileError,
    },
  ]
  for (const response of responses) {
    let calls = 0
    const client = createApiClient({
      idempotencyKeyFactory: () => 'workbook-export-key-0001',
      fetchImpl: async () => {
        calls += 1
        return calls === 1 ? jsonResponse(sessionBody()) : response
      },
    })
    await client.getSession()
    await assert.rejects(client.exportWorkbook({ format: 'panel-v2' }), {
      name: 'ApiError', code: 'INVALID_RESPONSE', message: 'INVALID_RESPONSE',
    })
  }
})

test('workbook registry pagination rejects skipped and empty nonterminal pages', async () => {
  const unknownEntries = Array.from({ length: 20 }, (_, index) => ({
    id: `fin_task11_unknown_${String(index).padStart(2, '0')}`,
    importId: 'wbi_task11_import', state: 'active', voidType: null,
    kind: 'income', recordType: 'english', accountingMonth: null,
    amountGrosze: 0, version: 1,
  }))
  const duplicateItems = Array.from({ length: 20 }, (_, index) => ({
    id: `dup_task11_${String(index).padStart(2, '0')}`, count: 2,
  }))
  const { fetchImpl } = queuedFetch(
    jsonResponse({ data: {
      cursor: null, nextCursor: 'c_40_r12', imports: [], exports: [],
      entries: unknownEntries, complete: false,
    } }),
    jsonResponse({ data: {
      cursor: null, nextCursor: 'c_20_r12', imports: [], exports: [], entries: [],
      complete: false,
    } }),
    jsonResponse(sessionBody()),
    jsonResponse({ data: {
      importId: 'wbi_task11_import', section: 'duplicates', cursor: null,
      nextCursor: 'c_40_r12', items: duplicateItems, complete: false,
    } }),
  )
  const client = createApiClient({ fetchImpl })

  await assert.rejects(client.loadWorkbookRegistry({ cursor: null, section: 'unknown' }), {
    code: 'INVALID_RESPONSE',
  })
  await assert.rejects(client.loadWorkbookRegistry({ cursor: null, section: 'all' }), {
    code: 'INVALID_RESPONSE',
  })
  await client.getSession()
  await assert.rejects(client.loadWorkbookRegistryDetail({
    importId: 'wbi_task11_import', section: 'duplicates', cursor: null,
  }), { code: 'INVALID_RESPONSE' })
})

test('workbook registry detail rejects rows outside the Worker visible order', async () => {
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    jsonResponse({ data: {
      importId: 'wbi_task11_import', section: 'conflicts', cursor: null,
      nextCursor: null, complete: true, planDigest: `v1_${'A'.repeat(43)}`,
      specialistOptions: [],
      items: [
        { id: 'wmc_z', kind: 'mapping', resolved: false },
        { id: 'wmc_a', kind: 'mapping', resolved: false },
      ],
    } }),
    jsonResponse({ data: {
      importId: 'wbi_task11_import', section: 'duplicates', cursor: null,
      nextCursor: null, complete: true,
      items: [{ id: 'dup_z', count: 2 }, { id: 'dup_a', count: 2 }],
    } }),
    jsonResponse({ data: {
      importId: 'wbi_task11_import', section: 'resolutions', cursor: null,
      nextCursor: null, complete: true,
      items: [
        {
          id: 'wrs_z', kind: 'resolution_set', decision: 'recorded',
          specialistId: null, ...resolutionAuthority,
          version: 2, createdAt: '2026-08-27T10:01:00.000Z',
          choices: [],
        },
        {
          id: 'wrs_a', kind: 'resolution_set', decision: 'recorded',
          specialistId: null, ...resolutionAuthority,
          version: 1, createdAt: NOW, choices: [],
        },
      ],
    } }),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  for (const section of ['conflicts', 'duplicates', 'resolutions']) {
    await assert.rejects(client.loadWorkbookRegistryDetail({
      importId: 'wbi_task11_import', section, cursor: null,
    }), { code: 'INVALID_RESPONSE' })
  }
})

test('resolution history discriminates the Worker wbr and wrs DTO branches', async () => {
  const detail = (item) => {
    const ids = [...new Set([
      item.specialistId, ...(item.choices ?? []).map(({ specialistId }) => specialistId),
    ].filter(Boolean))].sort()
    return jsonResponse({ data: {
    importId: 'wbi_task11_import', section: 'resolutions', cursor: null,
    nextCursor: null, items: [item], specialistLabels: ids.map((id) => ({
      id, label: id === 'sp_anna' ? 'Anna' : 'Beata',
    })), complete: true,
    } })
  }
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    detail({
      id: 'wrs_task11_bad', kind: 'specialist_mapping', decision: 'explicit_match',
      specialistId: 'sp_anna', ...resolutionAuthority,
      version: 1, createdAt: NOW, choices: [],
    }),
    detail({
      id: 'wbr_task11_bad', kind: 'specialist_mapping', decision: 'explicit_match',
      specialistId: 'sp_anna', ...resolutionAuthority, sourceValue: 'Anna',
      version: 2, createdAt: NOW,
      choices: [{ conflictId: 'hpc_task11_bad', specialistId: 'sp_anna' }],
    }),
    detail({
      id: 'wbr_task11_valid', kind: 'specialist_mapping', decision: 'explicit_match',
      specialistId: 'sp_anna', ...resolutionAuthority,
      sourceValue: 'Anna',
      version: 1, createdAt: NOW, choices: [],
    }),
    detail({
      id: 'wrs_task11_valid', kind: 'resolution_set', decision: 'recorded',
      specialistId: null, ...resolutionAuthority, version: 2, createdAt: NOW,
      choices: [
        { conflictId: 'wmc_task11_a', specialistId: 'sp_anna' },
        { conflictId: 'wmc_task11_b', specialistId: 'sp_beata' },
      ],
    }),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(client.loadWorkbookRegistryDetail({
      importId: 'wbi_task11_import', section: 'resolutions', cursor: null,
    }), { code: 'INVALID_RESPONSE' })
  }
  for (let index = 0; index < 2; index += 1) {
    await assert.doesNotReject(client.loadWorkbookRegistryDetail({
      importId: 'wbi_task11_import', section: 'resolutions', cursor: null,
    }))
  }
})

test('resolution history requires the exact referenced specialist label set', async () => {
  const item = {
    id: 'wrs_task11_labels', kind: 'resolution_set', decision: 'recorded',
    specialistId: null, ...resolutionAuthority, version: 1, createdAt: NOW,
    choices: [{ conflictId: 'wmc_task11_labels', specialistId: 'sp_anna' }],
  }
  const response = (specialistLabels) => jsonResponse({ data: {
    importId: 'wbi_task11_import', section: 'resolutions', cursor: null,
    nextCursor: null, items: [item], specialistLabels, complete: true,
  } })
  const { fetchImpl } = queuedFetch(
    jsonResponse(sessionBody()),
    response([]),
    response([
      { id: 'sp_anna', label: 'Anna' },
      { id: 'sp_extra', label: 'Beata' },
    ]),
    response([{ id: 'sp_wrong', label: 'Anna' }]),
  )
  const client = createApiClient({ fetchImpl })
  await client.getSession()

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(client.loadWorkbookRegistryDetail({
      importId: 'wbi_task11_import', section: 'resolutions', cursor: null,
    }), { code: 'INVALID_RESPONSE' })
  }
})

test('finance arithmetic fails closed on safe-integer overflow', async () => {
  const overflow = financeWindow()
  overflow.rows = [
    { ...financeRow, id: 'fin_task11_first', revenueGrosze: Number.MAX_SAFE_INTEGER,
      receivableGrosze: Number.MAX_SAFE_INTEGER, collectedGrosze: Number.MAX_SAFE_INTEGER },
    { ...financeRow, id: 'fin_task11_second', revenueGrosze: 1,
      receivableGrosze: 1, collectedGrosze: 1 },
  ]
  overflow.kpis = {
    revenueGrosze: Number.MAX_SAFE_INTEGER,
    collectedGrosze: Number.MAX_SAFE_INTEGER,
    outstandingGrosze: 0,
    expensesGrosze: 0,
    incomeGrosze: Number.MAX_SAFE_INTEGER,
  }
  overflow.trend[5] = { month: '2026-08', ...overflow.kpis }
  overflow.splits = {
    ...overflow.splits,
    specialist: { sp_anna: Number.MAX_SAFE_INTEGER },
    service: { zajecia: Number.MAX_SAFE_INTEGER },
    payment: { cash: Number.MAX_SAFE_INTEGER },
    invoice: { not_required: { count: 2, revenueGrosze: Number.MAX_SAFE_INTEGER } },
  }
  const { fetchImpl } = queuedFetch(jsonResponse({ data: overflow }))
  const client = createApiClient({ fetchImpl })

  await assert.rejects(client.loadFinanceWindow({ selectedMonth: '2026-08' }), {
    code: 'INVALID_RESPONSE',
  })
})
