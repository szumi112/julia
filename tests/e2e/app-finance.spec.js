import { expect, test } from '@playwright/test'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const AUTHORIZED_SOURCE = 'Fikcyjna wartość źródłowa'
const LONG_AUTHORIZED_SOURCE = `Fikcyjna-${'x'.repeat(190)}`
const NOW = '2026-08-15T10:00:00.000Z'
const PLAN_DIGEST = `v1_${'P'.repeat(43)}`
const PREVIEW_TOKEN = `v1.1.${'A'.repeat(86)}.${'B'.repeat(43)}`

const json = (body, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(body),
})

const freezeTime = async (page) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript((iso) => {
    const NativeDate = Date
    const fixed = new NativeDate(iso).getTime()
    class FrozenDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixed])) }
      static now() { return fixed }
    }
    FrozenDate.parse = NativeDate.parse
    FrozenDate.UTC = NativeDate.UTC
    window.Date = FrozenDate
  }, NOW)
}

const specialist = {
  id: 'sp_anna', displayName: 'Anna Nowak', professionalTitle: 'Psycholożka',
  standardRateGrosze: 18_000, status: 'active', version: 1, staffVersion: 1,
}
const client = {
  id: 'cl_finance_e2e', name: 'Fikcyjna Klientka', age: 12, status: 'active',
  version: 1, archivedAt: null, createdAt: NOW, updatedAt: NOW, readOnly: false,
  assignment: {
    id: 'asg_finance_e2e', specialistId: specialist.id, startsAt: NOW, version: 1,
  },
}
const appointment = (index) => ({
  id: `apt_finance_e2e_${index}`, clientId: client.id, specialistId: specialist.id,
  serviceId: 'zajecia',
  startsAt: `2026-07-${String(index + 1).padStart(2, '0')}T08:00:00.000Z`,
  endsAt: `2026-07-${String(index + 1).padStart(2, '0')}T08:50:00.000Z`,
  timeZone: 'Europe/Warsaw', location: null, status: 'completed', source: 'panel',
  version: 1, cancelledAt: null, cancellationReason: null, createdAt: NOW, updatedAt: NOW,
  charge: {
    id: `chg_finance_e2e_${index}`, serviceId: 'zajecia',
    expectedAmountGrosze: 18_000, currency: 'PLN', version: 1,
  },
  payment: {
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
    latestMethod: null, latestReceivedAt: null,
  },
  paymentEntries: [],
})
const appointments = Array.from({ length: 20 }, (_, index) => appointment(index))

const workspace = (from, to) => ({ data: {
  window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
  specialists: [specialist], clients: [client], appointments: appointments.filter((item) => (
    item.startsAt.slice(0, 10) >= from && item.startsAt.slice(0, 10) <= to
  )),
  historicalClients: [], historicalOccurrences: [], latestPopulatedMonth: '2026-07',
} })
const ownPayments = (from, to, records = appointments) => ({ data: {
  window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
  appointments: records.filter((item) => (
    item.startsAt.slice(0, 10) >= from && item.startsAt.slice(0, 10) <= to
  )).map((item) => ({
    id: item.id,
    serviceId: item.serviceId,
    startsAt: item.startsAt,
    status: item.status,
    cancellationReason: item.cancellationReason,
    version: item.version,
    charge: item.charge,
    payment: item.payment,
  })),
} })

const monthKeys = (end) => {
  const [year, month] = end.split('-').map(Number)
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 6 + index, 1))
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  })
}
const zeroKpis = () => ({
  revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0, verificationGrosze: 0,
  expensesGrosze: 0, incomeGrosze: 0,
})
const financeRows = appointments.map((value, index) => ({
  id: `fin_panel_e2e_${index}`, sourceKind: 'panel', appointmentId: value.id,
  accountingMonth: '2026-07', occurredOn: value.startsAt.slice(0, 10), kind: 'income',
  recordType: 'income', revenueGrosze: 18_000, receivableGrosze: 18_000,
  collectedGrosze: 0, expenseGrosze: 0, specialistId: specialist.id,
  serviceId: 'zajecia', program: null, paymentMethod: 'unknown',
  invoiceStatus: 'not_required', version: 1,
  settlementStatus: 'unpaid', counterparty: null, sourceLabel: null,
}))
const financeWindow = (selectedMonth) => {
  const populated = selectedMonth === '2026-07'
  const total = populated ? financeRows.length * 18_000 : 0
  const months = monthKeys(selectedMonth)
  const selected = {
    ...zeroKpis(), revenueGrosze: total, outstandingGrosze: total, incomeGrosze: total,
  }
  return { data: {
    currentMonth: '2026-08', selectedMonth, fromMonth: months[0], toMonth: selectedMonth,
    months, latestPopulatedMonth: '2026-07', kpis: selected,
    trend: months.map((month) => ({
      month, ...(month === selectedMonth ? selected : zeroKpis()),
    })),
    splits: {
      specialist: populated ? { [specialist.id]: total } : {},
      service: populated ? { zajecia: total } : {},
      payment: { outstanding: total, verification: 0 },
      invoice: populated
        ? { not_required: { count: financeRows.length, revenueGrosze: total } } : {},
      program: {
        english: { count: populated ? 2 : 0, revenueGrosze: 0 },
        tus: { count: populated ? 5 : 0, revenueGrosze: 0 },
      },
    },
    specialistLabels: populated ? [{ id: specialist.id, label: specialist.displayName }] : [],
    rows: populated ? financeRows.map((row) => ({ ...row })) : [],
    coverage: {
      dateOnlyCount: 0, monthOnlyCount: 0,
      timedCount: populated ? financeRows.length : 0, unknownCount: 0,
    },
    unknownPeriodCount: 1, complete: true,
  } }
}

const registryImport = (overrides = {}) => ({
  id: 'wbi_finance_e2e',
  artifact: {
    id: 'wba_finance_e2e', fingerprint: 'a'.repeat(64), byteSize: 4096,
    parserVersion: 2, materializerVersion: 2, createdAt: NOW,
  },
  status: 'ready', version: 1, phase: 'apply_finance',
  progress: { processed: 0, total: 1 },
  summary: {
    sourceCount: 1, quarantineCount: 0, conflictCount: 0,
    duplicateCount: 0, resolutionCount: 0,
  },
  resolutionVersion: 0, createdByStaffId: 'stf_local_owner',
  createdAt: NOW, updatedAt: NOW, ...overrides,
})
const registryPage = ({ imports = [], exports = [], entries = [] } = {}) => ({ data: {
  cursor: null, nextCursor: null, imports, exports, entries, complete: true,
} })
const importedDto = (overrides = {}) => ({
  id: 'wbi_finance_e2e', artifactId: 'wba_finance_e2e', status: 'ready',
  acceptedRecords: 1, quarantinedRecords: 0, createdByStaffId: 'stf_local_owner',
  version: 1, createdAt: NOW, updatedAt: NOW, completedAt: null, ...overrides,
})
const jobDto = (overrides = {}) => ({
  id: 'wbj_finance_e2e', phase: 'apply_finance', status: 'ready', cursor: 0,
  totalRecords: 1, processedRecords: 0, version: 1, updatedAt: NOW,
  completedAt: null, ...overrides,
})
const preview = { data: {
  fingerprint: 'f'.repeat(64), parserVersion: 2, materializerVersion: 2,
  planDigest: PLAN_DIGEST, previewToken: PREVIEW_TOKEN,
  counts: {
    financeRows: 1, datedFinanceRows: 1, undatedFinanceRows: 0, tusRows: 0,
    englishRows: 0, costOrAncillaryRows: 0,
  },
  warnings: [
    { code: 'DUPLICATE_SOURCE_RECORD', count: 2 },
    { code: 'AMOUNT_STORED_AS_TEXT', count: 1 },
    { code: 'REVIEW_REQUIRED', count: 5 },
  ],
  reconciliation: {
    sourceCandidates: 1, acceptedRows: 1, quarantinedRows: 0,
    excludedFormulaBlocks: 0, excludedFormulaRows: 0,
  },
  proposedMappings: [{
    displayName: 'Anna Nowak', resolutionCode: 'exact_normalized',
    sourceValue: 'Anna N.', sourceValueKind: 'explicit_name', specialistId: specialist.id,
  }], conflicts: [], quarantine: [{
    sourceKey: 'workbook:v1:0:4:0', sheet: 'Fikcyjny arkusz', rowNumber: 4,
    recordType: 'income', accountingMonth: '2026-07', occurredOn: null,
    periodPrecision: 'month', periodMonth: '2026-07',
    reasonCode: 'SERVICE_DATE_MISSING', reasonCodes: ['SERVICE_DATE_MISSING'],
    raw: { sentinel: 'RAW_SOURCE_MUST_NOT_RENDER' },
  }], workbookKind: 'legacy',
  specialistOptions: [{ id: specialist.id, label: specialist.displayName }],
  specialistLabels: [],
} }
const previewWithConflict = { data: {
  ...preview.data,
  conflicts: [{
    id: `wmc_${'Q'.repeat(43)}`, code: 'SPECIALIST_MAPPING_REQUIRED',
    sourceValue: AUTHORIZED_SOURCE,
  }],
} }
const previewWithLongConflict = { data: {
  ...preview.data,
  conflicts: [{
    id: `wmc_${'L'.repeat(43)}`, code: 'SPECIALIST_MAPPING_REQUIRED',
    sourceValue: LONG_AUTHORIZED_SOURCE,
  }],
} }
const panelPreview = { data: {
  ...preview.data,
  workbookKind: 'panel-v2', proposedMappings: [], warnings: [], quarantine: [],
  specialistLabels: [{ id: specialist.id, label: specialist.displayName }],
  conflicts: [{
    code: 'PANEL_CONCURRENT_EDIT', recordId: 'fin_panel_review_conflict',
    field: 'amountGrosze', current: 18_000, edited: 20_000,
  }, {
    code: 'PANEL_DEPENDENCY_CONFLICT', recordId: 'fin_panel_review_dependency',
    field: null,
  }],
  panelChanges: {
    unchangedIds: [],
    updates: [{
      id: 'fin_panel_review_update', type: 'finance_entry',
      values: {
        accountingMonth: '2026-07', occurredOn: '2026-07-15',
        amountGrosze: 19_000, invoiceStatus: 'issued', paymentMethod: 'transfer',
        settlementStatus: 'paid', specialistId: specialist.id,
      },
    }],
    voidIds: ['fin_panel_review_void'],
  },
} }

const routeWorkspace = async (page, requests = []) => page.route(
  '**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    requests.push({ from, to })
    await route.fulfill(json(workspace(from, to)))
  },
)
const routeOwnPayments = async (page, requests = []) => page.route(
  '**/api/v1/payments/own?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    requests.push({ from, to })
    await route.fulfill(json(ownPayments(from, to)))
  },
)
const routeRegistry = async (page, imports = []) => page.route(
  '**/api/v1/workbooks/registry?*', async (route) => {
    const section = new URL(route.request().url()).searchParams.get('section')
    const entries = ['entries', 'unknown'].includes(section) ? [{
      id: 'fin_unknown_e2e', importId: 'wbi_finance_e2e', state: 'active',
      voidType: null, kind: 'income', recordType: 'income', accountingMonth: null,
      amountGrosze: 12_000, version: 1,
    }] : []
    await route.fulfill(json(registryPage({
      imports: section === 'imports' ? imports : [], entries,
    })))
  },
)

const enableStagingWorkbookTools = async (page) => page.route(
  '**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.environment = 'staging'
    await route.fulfill({ response, body: JSON.stringify(body) })
  },
)

const openWorkbookTools = async (page, { sessionConfigured = false } = {}) => {
  if (!sessionConfigured) await enableStagingWorkbookTools(page)
  await page.goto('./#/payments')
  await page.getByText('Wgraj arkusz', { exact: true }).click()
}

test('@owner keeps workbook entries in one income list with unverified amounts and a separate invoice list', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  const response = financeWindow('2026-07')
  response.data.rows[0] = { ...response.data.rows[0], sourceKind: 'workbook', appointmentId: null,
    settlementStatus: 'unknown', invoiceStatus: 'action_required', counterparty: 'Fikcyjna rodzina Leśna', sourceLabel: 'Zajęcia z arkusza' }
  response.data.kpis.outstandingGrosze = 342_000
  response.data.kpis.verificationGrosze = 18_000
  response.data.trend[5] = { month: '2026-07', ...response.data.kpis }
  response.data.splits.payment = { outstanding: 342_000, verification: 18_000 }
  response.data.coverage.timedCount -= 1
  response.data.coverage.dateOnlyCount += 1
  await page.route('**/api/v1/finance/window?*', (route) => route.fulfill(json(response)))
  await page.goto('./#/payments?ym=2026-07')
  const table = page.getByRole('table', { name: 'Lista wpływów' })
  await expect(table).toContainText('Fikcyjna rodzina Leśna')
  await expect(page.locator('.finance-window__verification')).toContainText('Do sprawdzenia')
  await expect(page.getByText('Przychody minus wydatki', { exact: true })).toBeVisible()
  await expect(table.getByRole('button', { name: /Dodaj wpłatę/ }).first()).toBeVisible()
  await page.getByRole('group', { name: 'Widok wpływów' }).getByRole('button', { name: 'Zaległości' }).click()
  const row = table.getByRole('row').filter({ hasText: 'Fikcyjna rodzina Leśna' })
  await expect(row).toContainText('Zajęcia z arkusza')
  await expect(row.locator('td[data-th="Wpłacono"]')).toHaveText('Nie ustalono')
  await expect(row.locator('td[data-th="Pozostało"]')).toHaveText('Do sprawdzenia')
  await expect(row.getByRole('button', { name: /Dodaj wpłatę/ })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Faktury' }).click()
  const invoices = page.getByRole('table', { name: 'Lista faktur' })
  await expect(invoices).toContainText('Fikcyjna rodzina Leśna')
  await expect(invoices.getByText('Wymaga wystawienia', { exact: true })).toBeVisible()
})

test('@owner filters protected settlements to outstanding balances and restores the filter from the route', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  const response = financeWindow('2026-07')
  response.data.rows[0].collectedGrosze = 18_000
  response.data.rows[0].paymentMethod = 'cash'
  response.data.kpis.collectedGrosze = 18_000
  response.data.kpis.outstandingGrosze = 342_000
  response.data.trend[5].collectedGrosze = 18_000
  response.data.trend[5].outstandingGrosze = 342_000
  response.data.splits.payment = { cash: 18_000, outstanding: 342_000, verification: 0 }
  await page.route('**/api/v1/finance/window?*', (route) => (
    route.fulfill(json(response))
  ))

  await page.goto('./#/payments?unpaidOnly=true&ym=2026-07')

  const table = page.getByRole('table', { name: 'Lista wpływów' })
  const filters = page.getByRole('group', { name: 'Widok wpływów' })
  await expect(filters.getByRole('button', { name: 'Zaległości' }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(table.getByRole('row')).toHaveCount(20)
  await expect(table.getByText('1 lip', { exact: true })).toHaveCount(0)

  await filters.getByRole('button', { name: 'Wszystkie' }).click()
  await expect(table.getByRole('row')).toHaveCount(21)
  await expect(table.getByText('1 lip', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/payments\?unpaidOnly=false&ym=2026-07$/)

  await filters.getByRole('button', { name: 'Zaległości' }).click()
  await expect(page).toHaveURL(/#\/payments\?ym=2026-07$/)

  await page.getByRole('link', { name: 'Raporty', exact: true }).click()
  await page.getByRole('link', { name: 'Finanse', exact: true }).click()
  await expect(filters.getByRole('button', { name: 'Zaległości' }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(table.getByRole('row')).toHaveCount(20)
  await expect(page).toHaveURL(/#\/payments\?ym=2026-07$/)
})

test('@owner prints a monthly report with coverage and amount-ranked breakdowns', async ({ page }) => {
  await freezeTime(page)
  await page.addInitScript(() => {
    window.__reportPrintCalls = 0
    Object.defineProperty(window, 'print', {
      configurable: true,
      value: () => { window.__reportPrintCalls += 1 },
    })
  })
  const response = financeWindow('2026-07')
  response.data.splits.program = {
    tus: { count: 2, revenueGrosze: 40_000 },
    english: { count: 3, revenueGrosze: 90_000 },
  }
  await page.route('**/api/v1/finance/window?*', (route) => route.fulfill(json(response)))

  await page.goto('./#/reports?ym=2026-07')

  await expect(page.getByText(
    'Porównuje sześć miesięcy i podsumowuje wybrany miesiąc. Finanse służą do bieżących rozliczeń.',
    { exact: true },
  )).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pokrycie czasu i dat' })).toBeVisible()
  const programs = page.locator('.report-window__split', {
    has: page.getByRole('heading', { name: 'TUS i angielski' }),
  }).locator('dt')
  await expect(programs).toHaveText(['Angielski', 'TUS'])

  await page.getByRole('button', { name: 'Drukuj' }).click()
  await expect.poll(() => page.evaluate(() => window.__reportPrintCalls)).toBe(1)
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.report-print-sheet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Drukuj' })).toBeHidden()
})

test('@owner keeps the six-month report context beside the selected month empty state', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/finance/window?*', (route) => route.fulfill(json(financeWindow('2026-08'))))

  await page.goto('./#/reports?ym=2026-08')

  await expect(page.getByText('Brak danych w bieżącym miesiącu', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pokaż ostatni miesiąc z danymi (lipiec 2026)' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Drukuj' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Trend sześciu miesięcy' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pokrycie czasu i dat' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Faktury' })).toBeVisible()
})

test('@owner keeps concise finance tabs keyboard-reachable on a phone', async ({ page }) => {
  await freezeTime(page)
  await page.setViewportSize({ width: 320, height: 844 })
  await routeWorkspace(page)
  await page.route('**/api/v1/finance/window?*', (route) => route.fulfill(json(financeWindow('2026-07'))))
  await page.goto('./#/payments?ym=2026-07')

  const tabs = page.getByRole('tablist', { name: 'Obszary finansów' })
  await expect(tabs.getByRole('tab')).toHaveText(['Wpływy', 'Wydatki', 'Faktury'])

  const first = page.getByRole('tab', { name: 'Wpływy' })
  const last = page.getByRole('tab', { name: 'Faktury' })
  await first.focus()
  await page.keyboard.press('End')
  await expect(last).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('@owner uses one authoritative finance window, latest month and unknown-period route', async ({ page }) => {
  await freezeTime(page)
  const workspaceRequests = []
  let markJulyStarted
  let releaseJuly
  const julyStarted = new Promise((resolve) => { markJulyStarted = resolve })
  const julyReleased = new Promise((resolve) => { releaseJuly = resolve })
  await routeWorkspace(page, workspaceRequests)
  await routeRegistry(page)
  await page.route('**/api/v1/finance/window?*', async (route) => {
    const month = new URL(route.request().url()).searchParams.get('month')
    if (month === '2026-07') {
      markJulyStarted()
      await julyReleased
    }
    await route.fulfill(json(financeWindow(month)))
  })

  await page.goto('./#/payments')
  await expect(page.getByText('Brak pozycji w tym miesiącu', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.locator('.finance-window__kpi')).toHaveCount(0)
  await expect(page.locator('.finance-window__trend')).toHaveCount(0)
  await page.getByRole('button', { name: /Pokaż ostatni miesiąc z danymi/ }).click()
  await julyStarted
  await expect(page.getByRole('heading', { level: 1, name: 'Finanse', exact: true }))
    .toBeVisible()
  await expect(page.getByRole('button', { name: 'Dodaj pozycję' })).toBeVisible()
  await expect(page.getByText('Wczytuję finanse…', { exact: true })).toBeVisible()
  await expect(page.getByText('Brak pozycji w tym miesiącu', { exact: true }))
    .toHaveCount(0)
  releaseJuly()
  const heading = page.getByRole('heading', { level: 1, name: 'Finanse', exact: true })
  await expect(heading).toBeFocused()
  await expect(page.getByRole('table', { name: 'Lista wpływów' }).getByRole('row'))
    .toHaveCount(21)
  expect(workspaceRequests.filter(({ from, to }) => (
    from === '2026-07-01' && to === '2026-07-31'
  ))).toHaveLength(1)
  await expect(page.getByRole('button', { name: /Dodaj wpłatę/ }).first())
    .toBeVisible()

  await page.goto('./#/reports?ym=2026-07')
  await expect(page.getByRole('heading', { name: 'Faktury' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pokrycie czasu i dat' })).toBeVisible()
  await expect(page.getByRole('main')).not.toContainText('sp_anna')
  await expect(page.getByRole('main')).not.toContainText('not_required')
  await expect(page.getByRole('main')).not.toContainText('outstanding')
  await page.goto('./#/payments?ym=2000-06')
  await expect(page.getByRole('button', { name: 'Poprzedni miesiąc' })).toBeDisabled()
  await page.goto('./#/reports?ym=2000-06')
  await expect(page.getByRole('button', { name: 'Poprzedni miesiąc' })).toBeDisabled()
  await expect(page.getByText('Pozycje bez miesiąca', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', {
    name: 'Przejdź do pozycji z nieustalonym okresem',
  })).toHaveCount(0)
})

test('@owner preserves the exact file and idempotency key across an ambiguous create retry', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.environment = 'staging'
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  await routeWorkspace(page)
  await routeRegistry(page)
  const duplicateSpecialistId = 'sp_anna_duplicate'
  await page.route('**/api/v1/workbooks/preview', (route) => route.fulfill(json({ data: {
    ...previewWithConflict.data,
    specialistOptions: [{
      id: specialist.id, label: specialist.displayName,
    }, {
      id: duplicateSpecialistId, label: specialist.displayName,
    }],
  } })))
  const keys = []
  const submittedResolutions = []
  let attempts = 0
  await page.route('**/api/v1/workbooks/imports', async (route) => {
    attempts += 1
    keys.push(route.request().headers()['idempotency-key'])
    const encoded = route.request().postData()?.match(
      /name="resolutions"\r\n\r\n([^\r]+)/,
    )?.[1]
    submittedResolutions.push(JSON.parse(encoded))
    if (attempts === 1) return route.abort('connectionreset')
    return route.fulfill(json({ data: { import: importedDto() } }, 201))
  })

  await page.goto('./#/payments')
  await page.getByText('Wgraj arkusz', { exact: true }).click()
  const picker = page.getByLabel('Wybierz plik Excel (.xlsx)')
  await picker.setInputFiles({
    name: 'fikcyjny.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByRole('heading', {
    name: 'Sprawdziliśmy plik. Nic jeszcze nie zostało zapisane.',
  })).toBeFocused()
  await expect(page.getByRole('heading', { name: 'Proponowane przypisania' })).toBeVisible()
  await expect(page.getByText('Anna N. → Anna Nowak', { exact: true })).toBeVisible()
  await expect(page.getByText('2 powtórzone wiersze', { exact: true })).toBeVisible()
  await expect(page.getByText('1 kwota zapisana jako tekst', { exact: true })).toBeVisible()
  await expect(page.getByText('5 wierszy do sprawdzenia', { exact: true })).toBeVisible()
  await expect(page.getByText('Fikcyjny arkusz · wiersz 4', { exact: true })).toBeVisible()
  const mappingSelect = page.getByLabel('Specjalistka nr 1')
  await expect(mappingSelect.getByRole('option', {
    name: 'Anna Nowak (1)', exact: true,
  })).toHaveCount(1)
  await expect(mappingSelect.getByRole('option', {
    name: 'Anna Nowak (2)', exact: true,
  })).toHaveCount(1)
  await mappingSelect.selectOption(duplicateSpecialistId)
  await page.getByRole('button', { name: 'Przenieś dane' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Kliknij „Przenieś dane” jeszcze raz',
  )
  await expect(picker).toBeDisabled()
  await expect(mappingSelect).toBeDisabled()
  expect(await picker.evaluate((input) => input.files.length)).toBe(0)
  await page.getByRole('button', { name: 'Przenieś dane' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Dane z arkusza są przenoszone' }))
    .toBeVisible()
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
  expect(keys[0]).toMatch(/^workbook-import-/)
  expect(submittedResolutions).toEqual([[
    { conflictId: `wmc_${'Q'.repeat(43)}`, specialistId: duplicateSpecialistId },
  ], [
    { conflictId: `wmc_${'Q'.repeat(43)}`, specialistId: duplicateSpecialistId },
  ]])
  expect(await page.getByLabel('Wybierz plik Excel (.xlsx)')
    .evaluate((input) => input.files.length)).toBe(0)
  await expect(page.getByRole('main')).not.toContainText('RAW_SOURCE_MUST_NOT_RENDER')
  await expect(page.getByRole('main')).not.toContainText(specialist.id)
  await expect(page.getByRole('main')).not.toContainText(duplicateSpecialistId)
  expect(await page.evaluate(() => ({
    local: localStorage.length, session: sessionStorage.length,
  }))).toEqual({ local: 0, session: 0 })
})

test('@owner clears a definitively rejected create and requires a fresh preview', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  await routeRegistry(page)
  await page.route('**/api/v1/workbooks/preview', (route) => (
    route.fulfill(json(preview))
  ))
  await page.route('**/api/v1/workbooks/imports', (route) => route.fulfill(json({
    error: {
      code: 'WORKBOOK_IMPORT_CONFLICT',
      correlationId: '77777777-7777-4777-8777-777777777777',
    },
  }, 409)))

  await openWorkbookTools(page)
  await page.getByLabel('Wybierz plik Excel (.xlsx)').setInputFiles({
    name: 'fikcyjny.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await page.getByRole('button', { name: 'Przenieś dane' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Mógł zostać już wczytany albo lista specjalistek się zmieniła',
  )
  await expect(page.getByRole('button', { name: 'Przenieś dane' }))
    .toHaveCount(0)
  expect(await page.getByLabel('Wybierz plik Excel (.xlsx)')
    .evaluate((input) => input.files.length)).toBe(0)
})

test('@owner explains a rejected workbook fingerprint instead of a generic failure', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  await routeRegistry(page)
  await page.route('**/api/v1/workbooks/preview', (route) => route.fulfill(json({
    error: {
      code: 'WORKBOOK_FINGERPRINT_REJECTED',
      correlationId: '77777777-7777-4777-8777-777777777778',
    },
  }, 400)))

  await openWorkbookTools(page)
  await page.getByLabel('Wybierz plik Excel (.xlsx)').setInputFiles({
    name: 'edytowany.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByRole('alert')).toContainText(
    'Tego arkusza nie można wczytać',
  )
  await expect(page.getByRole('alert')).not.toContainText('Nie udało się sprawdzić pliku')
  expect(await page.getByLabel('Wybierz plik Excel (.xlsx)')
    .evaluate((input) => input.files.length)).toBe(0)
})

test('@owner reviews exact signed Panel-v2 updates, voids and blocking conflicts', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  await routeRegistry(page)
  await page.route('**/api/v1/workbooks/preview', (route) => route.fulfill(json(panelPreview)))
  await openWorkbookTools(page)
  await page.getByLabel('Wybierz plik Excel (.xlsx)').setInputFiles({
    name: 'fikcyjny-panel.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByRole('heading', { name: 'Zmiany w pozycjach' })).toBeVisible()
  const updateEvidence = page.locator('.workbook-import__evidence li')
    .filter({ hasText: 'Pozycja do zmiany:' })
  await expect(updateEvidence).toContainText('kwota — 190,00 zł')
  await expect(updateEvidence).toContainText('miesiąc rozliczenia — lipiec 2026')
  await expect(updateEvidence).toContainText('data — 15 lip')
  await expect(updateEvidence).toContainText('forma płatności — Przelew')
  await expect(updateEvidence).toContainText('status płatności — Opłacona')
  await expect(updateEvidence).toContainText('faktura — Wystawiona')
  await expect(updateEvidence).toContainText('specjalistka — Anna Nowak')
  await expect(updateEvidence).not.toContainText('transfer')
  await expect(updateEvidence).not.toContainText('issued')
  await expect(updateEvidence).not.toContainText(specialist.id)
  await expect(page.getByText('1 pozycja do usunięcia.', { exact: true })).toBeVisible()
  const conflictEvidence = page.locator('.workbook-import__evidence li')
    .filter({ hasText: 'Ktoś w międzyczasie zmienił to pole w panelu' })
  await expect(conflictEvidence).toContainText(
    'obecnie: 180,00 zł · w pliku: 200,00 zł',
  )
  const dependencyEvidence = page.locator('.workbook-import__evidence li')
    .filter({ hasText: 'Tę pozycję można zmienić tylko w panelu' })
  await expect(dependencyEvidence).toContainText(
    'Tę pozycję można zmienić tylko w panelu, nie w pliku',
  )
  await expect(page.getByRole('button', { name: 'Przenieś dane' }))
    .toBeDisabled()
  for (const value of [
    'fin_panel_review_update', 'fin_panel_review_void', 'fin_panel_review_conflict',
  ]) expect(await page.locator('*').evaluateAll((nodes, sentinel) => nodes.some((node) => (
    [...node.attributes].some(({ value: attribute }) => attribute.includes(sentinel))
  )), value)).toBe(false)
})

test('@owner clears native workbook and in-flight export state on authority refresh', async ({ page }) => {
  await freezeTime(page)
  const requests = []
  const messages = []
  page.on('request', (request) => requests.push({
    url: request.url(), body: request.postData() ?? '',
  }))
  page.on('console', (message) => messages.push(message.text()))
  let refreshed = false
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.environment = 'staging'
    if (refreshed) body.data.authorityRevision += 1
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  await routeWorkspace(page)
  await routeRegistry(page, [registryImport({ createdByStaffId: 'stf_other_owner' })])
  await page.route('**/api/v1/workbooks/preview', (route) => (
    route.fulfill(json(previewWithConflict))
  ))
  let finishExport
  await page.route('**/api/v1/workbooks/exports', (route) => new Promise((resolve) => {
    finishExport = async () => {
      try {
        await route.fulfill({
          status: 200,
          body: Buffer.from([80, 75, 3, 4]),
          headers: {
            'cache-control': 'private, no-store',
            'content-disposition': 'attachment; filename="authority-refresh.xlsx"',
            'content-length': '4', 'content-type': XLSX,
            'x-content-type-options': 'nosniff',
          },
        })
      } catch { /* The authority reset may already have aborted the request. */ }
      resolve()
    }
  }))

  await openWorkbookTools(page, { sessionConfigured: true })
  await expect(page.getByRole('button', { name: 'Kontynuuj import' })).toHaveCount(0)
  await expect(page.getByText('wba_finance_e2e', { exact: true })).toHaveCount(0)
  await expect(page.getByText('a'.repeat(64), { exact: true })).toHaveCount(0)
  await expect(page.getByText('Parser 2 · materializator 2', { exact: true })).toHaveCount(0)
  await page.getByLabel('Wybierz plik Excel (.xlsx)').setInputFiles({
    name: 'fikcyjny.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByRole('heading', {
    name: 'Sprawdziliśmy plik. Nic jeszcze nie zostało zapisane.',
  })).toBeVisible()
  await expect(page.getByLabel('Specjalistka nr 1')).toBeVisible()
  await expect(page.getByLabel(new RegExp(AUTHORIZED_SOURCE))).toHaveCount(0)
  await expect(page.getByText(AUTHORIZED_SOURCE, { exact: true })).toBeVisible()
  expect(await page.locator('*').evaluateAll((nodes, sentinel) => nodes.some((node) => (
    [...node.attributes].some(({ value }) => value.includes(sentinel))
  )), AUTHORIZED_SOURCE)).toBe(false)
  expect(requests.some(({ url, body }) => url.includes(AUTHORIZED_SOURCE)
    || body.includes(AUTHORIZED_SOURCE))).toBe(false)
  expect(messages.some((value) => value.includes(AUTHORIZED_SOURCE))).toBe(false)
  await page.getByRole('button', { name: 'Pobierz arkusz Excel' }).click()
  await expect(page.getByRole('button', { name: 'Przygotowuję arkusz…' })).toBeDisabled()

  refreshed = true
  const sessionRefresh = page.waitForResponse('**/api/v1/session')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await sessionRefresh

  const picker = page.getByLabel('Wybierz plik Excel (.xlsx)')
  await expect(picker).toBeEnabled()
  expect(await picker.evaluate((input) => input.files.length)).toBe(0)
  await expect(page.getByRole('heading', {
    name: 'Sprawdziliśmy plik. Nic jeszcze nie zostało zapisane.',
  })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Przenieś dane' }))
    .toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Pobierz arkusz Excel' })).toBeEnabled()
  await expect(page.getByRole('main')).not.toContainText(AUTHORIZED_SOURCE)
  expect(await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    databases: typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).length : 0,
    caches: typeof window.caches === 'object' ? (await window.caches.keys()).length : 0,
    registrations: 'serviceWorker' in navigator
      ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  }))).toEqual({ local: 0, session: 0, databases: 0, caches: 0, registrations: 0 })
  await finishExport?.()
})

test('@owner downloads a whole-centre workbook with an idempotent retry', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  const entry = {
    id: 'fin_void_e2e', importId: 'wbi_finance_e2e', state: 'active', voidType: null,
    kind: 'income', recordType: 'income', accountingMonth: '2026-07',
    amountGrosze: 18_000, version: 1,
  }
  await page.route('**/api/v1/workbooks/registry?*', async (route) => {
    const section = new URL(route.request().url()).searchParams.get('section')
    await route.fulfill(json(registryPage({ entries: section === 'entries' ? [entry] : [] })))
  })
  const exportKeys = []
  let exportAttempts = 0
  await page.route('**/api/v1/workbooks/exports', (route) => {
    exportAttempts += 1
    exportKeys.push(route.request().headers()['idempotency-key'])
    if (exportAttempts === 1) return route.abort('connectionreset')
    if (exportAttempts === 2) return route.fulfill(json({ error: {
      code: 'IDEMPOTENCY_CONFLICT',
      correlationId: '99999999-9999-4999-8999-999999999999',
    } }, 409))
    return route.fulfill({
      status: 200,
      body: Buffer.from([80, 75, 3, 4]),
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': 'attachment; filename="bear-with-me-panel-v2-2026-08-15.xlsx"',
        'content-length': '4',
        'content-type': XLSX,
        'x-content-type-options': 'nosniff',
      },
    })
  })
  await openWorkbookTools(page)
  await page.getByRole('button', { name: 'Pobierz arkusz Excel' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Nie udało się przygotować arkusza',
  )
  await page.getByRole('button', { name: 'Pobierz arkusz Excel' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Dane zmieniły się w trakcie przygotowania arkusza',
  )
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Pobierz arkusz Excel' }).click()
  expect((await download).suggestedFilename())
    .toBe('bear-with-me-panel-v2-2026-08-15.xlsx')
  expect(exportKeys).toHaveLength(3)
  expect(exportKeys[0]).toBe(exportKeys[1])
  expect(exportKeys[2]).not.toBe(exportKeys[1])
})

test('@owner resolves creator-bound conflicts and continues with authoritative versions', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  const conflicted = registryImport({
    status: 'conflicts', version: 2, resolutionVersion: 0,
    summary: {
      sourceCount: 1, quarantineCount: 0, conflictCount: 1,
      duplicateCount: 0, resolutionCount: 0,
    },
  })
  await routeRegistry(page, [conflicted])
  await page.route('**/api/v1/workbooks/imports/wbi_finance_e2e', (route) => (
    route.fulfill(json({ data: {
      import: importedDto({ status: 'conflicts', version: 2 }), job: jobDto(),
      evidence: { createdRecords: 0, voidedRecords: 0, converged: false },
    } }))
  ))
  await page.route('**/api/v1/workbooks/registry/details', (route) => (
    route.fulfill(json({ data: {
      importId: 'wbi_finance_e2e', section: 'conflicts', cursor: null,
      planDigest: PLAN_DIGEST, nextCursor: null,
      specialistOptions: [{ id: specialist.id, label: specialist.displayName }],
      items: [{
        id: 'wmc_conflict_e2e', kind: 'specialist_mapping', resolved: false,
        sourceValue: 'Fikcyjna specjalistka po ponownym wczytaniu',
      }],
      complete: true,
    } }))
  ))
  const resolutionBodies = []
  const resolutionKeys = []
  let resolutionAttempts = 0
  await page.route(
    '**/api/v1/workbooks/imports/wbi_finance_e2e/resolutions',
    async (route) => {
      resolutionAttempts += 1
      resolutionBodies.push(route.request().postDataJSON())
      resolutionKeys.push(route.request().headers()['idempotency-key'])
      if (resolutionAttempts === 1) return route.abort('connectionreset')
      await route.fulfill(json({ data: {
        importId: 'wbi_finance_e2e', resolutionCount: 1,
        importVersion: 3, resolutionVersion: 1,
      } }))
    },
  )
  await page.route(
    '**/api/v1/workbooks/imports/wbi_finance_e2e/continue',
    (route) => route.fulfill(json({ data: {
      import: importedDto({ status: 'complete', version: 4, completedAt: NOW }),
      job: jobDto({
        phase: 'complete', status: 'complete', processedRecords: 1,
        version: 2, completedAt: NOW,
      }),
      evidence: { createdRecords: 1, voidedRecords: 0, converged: true },
      reconciliation: {
        accepted: 1, quarantined: 0, linked: 1, voided: 0, inserted: 1,
        accountingMonthsCorrected: 0, specialistAssignmentsCorrected: 0,
        fixedRevenuesInserted: 0, formulaGhostsVoided: 0,
        quarantinedVoided: 0, textAmountVisitsInserted: 0,
      },
    } })),
  )

  await openWorkbookTools(page)
  await page.getByRole('button', { name: 'Przypisz specjalistki' }).click()
  await expect(page.getByRole('heading', { name: 'Kto jest kim?' }))
    .toBeFocused()
  await expect(page.getByText(
    'Fikcyjna specjalistka po ponownym wczytaniu', { exact: true },
  )).toBeVisible()
  await expect(page.getByLabel(/Fikcyjna specjalistka po ponownym wczytaniu/))
    .toHaveCount(0)
  await page.getByLabel('Specjalistka nr 1').selectOption(specialist.id)
  await page.getByRole('button', {
    name: 'Zapisz i wczytuj dalej',
  }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Kliknij „Zapisz i wczytuj dalej” jeszcze raz',
  )
  await expect(page.getByLabel('Specjalistka nr 1')).toBeDisabled()
  await page.getByRole('button', {
    name: 'Zapisz i wczytuj dalej',
  }).click()
  await expect(page.getByText('Wgraj arkusz', { exact: true })).toBeVisible()
  expect(resolutionBodies).toEqual([{
    expectedVersion: 0, planDigest: PLAN_DIGEST,
    resolutions: [{ conflictId: 'wmc_conflict_e2e', specialistId: specialist.id }],
  }, {
    expectedVersion: 0, planDigest: PLAN_DIGEST,
    resolutions: [{ conflictId: 'wmc_conflict_e2e', specialistId: specialist.id }],
  }])
  expect(resolutionKeys[0]).toBe(resolutionKeys[1])
})

test('@owner continues the pending import without carrying retry state', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  const first = registryImport({
    id: 'wbi_switch_first', status: 'conflicts', version: 2,
    artifact: { ...registryImport().artifact, id: 'wba_switch_first' },
    summary: { ...registryImport().summary, conflictCount: 1 },
  })
  const second = registryImport({
    id: 'wbi_switch_second', status: 'ready', version: 1,
    artifact: { ...registryImport().artifact, id: 'wba_switch_second' },
  })
  await routeRegistry(page, [second, first])
  await page.route('**/api/v1/workbooks/imports/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)
    const selected = id === first.id ? first : second
    await route.fulfill(json({ data: {
      import: importedDto({
        id: selected.id, artifactId: selected.artifact.id,
        status: selected.status, version: selected.version,
      }),
      job: jobDto({ id: `wbj_${id}`, status: 'ready' }),
      evidence: { createdRecords: 0, voidedRecords: 0, converged: false },
    } }))
  })
  await page.route('**/api/v1/workbooks/registry/details', (route) => (
    route.fulfill(json({ data: {
      importId: first.id, section: 'conflicts', cursor: null,
      planDigest: PLAN_DIGEST, nextCursor: null,
      specialistOptions: [{ id: specialist.id, label: specialist.displayName }],
      items: [{
        id: `wmc_${'S'.repeat(43)}`, kind: 'specialist_mapping', resolved: false,
        sourceValue: 'Fikcyjna wartość pierwszego importu',
      }], complete: true,
    } }))
  ))
  let secondContinuations = 0
  await page.route(`**/api/v1/workbooks/imports/${second.id}/continue`, (route) => {
    secondContinuations += 1
    return route.fulfill(json({ data: {
      import: importedDto({
        id: second.id, artifactId: second.artifact.id,
        status: 'complete', version: 2, completedAt: NOW,
      }),
      job: jobDto({
        id: 'wbj_switch_second', phase: 'complete', status: 'complete',
        processedRecords: 1, version: 2, completedAt: NOW,
      }),
      evidence: { createdRecords: 1, voidedRecords: 0, converged: true },
      reconciliation: {
        accepted: 1, quarantined: 0, linked: 1, voided: 0, inserted: 1,
        accountingMonthsCorrected: 0, specialistAssignmentsCorrected: 0,
        fixedRevenuesInserted: 0, formulaGhostsVoided: 0,
        quarantinedVoided: 0, textAmountVisitsInserted: 0,
      },
    } }))
  })

  await openWorkbookTools(page)
  await page.getByRole('button', { name: 'Kontynuuj import' }).click()
  await expect(page.getByRole('button', { name: 'Kontynuuj import', exact: true })).toBeVisible()
  expect(secondContinuations).toBe(1)
})

test('@owner can retry a failed continuation from the workbook tools', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  const imported = registryImport({ status: 'ready', version: 1 })
  const entry = {
    id: 'fin_overlap_e2e', importId: imported.id, state: 'active', voidType: null,
    kind: 'income', recordType: 'income', accountingMonth: '2026-07',
    amountGrosze: 18_000, version: 1,
  }
  await page.route('**/api/v1/workbooks/registry?*', async (route) => {
    const section = new URL(route.request().url()).searchParams.get('section')
    await route.fulfill(json(registryPage({
      imports: section === 'imports' ? [imported] : [],
      entries: section === 'entries' ? [entry] : [],
    })))
  })
  await page.route('**/api/v1/workbooks/imports/wbi_finance_e2e', (route) => (
    route.fulfill(json({ data: {
      import: importedDto(), job: jobDto(),
      evidence: { createdRecords: 0, voidedRecords: 0, converged: false },
    } }))
  ))
  let releaseFailure
  let markFirstAttempt
  const firstAttempt = new Promise((resolve) => { markFirstAttempt = resolve })
  let attempts = 0
  const keys = []
  await page.route(
    '**/api/v1/workbooks/imports/wbi_finance_e2e/continue',
    (route) => {
      attempts += 1
      keys.push(route.request().headers()['idempotency-key'])
      if (attempts === 1) return new Promise((resolve) => {
        markFirstAttempt()
        releaseFailure = async () => {
          await route.fulfill(json({ error: {
            code: 'INTERNAL_ERROR', correlationId: '88888888-8888-4888-8888-888888888888',
          } }, 500))
          resolve()
        }
      })
      return route.fulfill(json({ data: {
        import: importedDto({ status: 'complete', version: 2, completedAt: NOW }),
        job: jobDto({
          phase: 'complete', status: 'complete', cursor: 1, processedRecords: 1,
          version: 2, completedAt: NOW,
        }),
        evidence: { createdRecords: 1, voidedRecords: 0, converged: true },
        reconciliation: {
          accepted: 1, quarantined: 0, linked: 1, voided: 0, inserted: 1,
          accountingMonthsCorrected: 0, specialistAssignmentsCorrected: 0,
          fixedRevenuesInserted: 0, formulaGhostsVoided: 0,
          quarantinedVoided: 0, textAmountVisitsInserted: 0,
        },
      } }))
    },
  )

  await openWorkbookTools(page)
  await page.getByRole('button', { name: 'Kontynuuj import' }).click()
  await firstAttempt
  await releaseFailure()
  await expect(page.getByRole('alert')).toContainText('Nie udało się kontynuować importu')
  await page.getByRole('button', { name: 'Kontynuuj import' }).click()
  await expect(page.getByRole('button', { name: 'Kontynuuj import', exact: true })).toBeVisible()
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
})

test('@owner drives every remaining materialization slice from one continuation click', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  await routeOwnPayments(page)
  await routeRegistry(page, [registryImport({
    status: 'materializing', version: 2, progress: { processed: 64, total: 192 },
  })])
  await page.route('**/api/v1/workbooks/imports/wbi_finance_e2e/historical-projection', (route) => (
    route.fulfill(json({ data: { projection: null, conflicts: [] } }))
  ))
  await page.route('**/api/v1/workbooks/imports/wbi_finance_e2e/activity-projection', (route) => (
    route.fulfill(json({ data: { job: null } }))
  ))
  await page.route('**/api/v1/finance/window?*', (route) => (
    route.fulfill(json(financeWindow('2026-07')))
  ))
  await page.route('**/api/v1/workbooks/imports/wbi_finance_e2e', (route) => (
    route.fulfill(json({ data: {
      import: importedDto({ status: 'materializing', version: 2 }),
      job: jobDto({ status: 'running', cursor: 64, processedRecords: 64, totalRecords: 192, version: 2 }),
      evidence: { createdRecords: 64, voidedRecords: 0, converged: false },
    } }))
  ))
  const keys = []
  await page.route(
    '**/api/v1/workbooks/imports/wbi_finance_e2e/continue',
    (route) => {
      keys.push(route.request().headers()['idempotency-key'])
      const attempt = keys.length
      const done = attempt === 3
      const processed = Math.min(64 * (attempt + 1), 192)
      return route.fulfill(json({ data: {
        // The server bumps the import version only on status transitions, so it
        // repeats across every slice until the run completes.
        import: importedDto({
          status: done ? 'complete' : 'materializing',
          version: done ? 3 : 2,
          completedAt: done ? NOW : null,
        }),
        job: jobDto({
          phase: done ? 'complete' : 'apply_finance',
          status: done ? 'complete' : 'running',
          cursor: processed, processedRecords: processed, totalRecords: 192,
          version: attempt + 2, completedAt: done ? NOW : null,
        }),
        evidence: { createdRecords: processed, voidedRecords: 0, converged: done },
        ...(done ? { reconciliation: {
          accepted: 192, quarantined: 0, linked: 192, voided: 0, inserted: 192,
          accountingMonthsCorrected: 0, specialistAssignmentsCorrected: 0,
          fixedRevenuesInserted: 0, formulaGhostsVoided: 0,
          quarantinedVoided: 0, textAmountVisitsInserted: 0,
        } } : {}),
      } }))
    },
  )

  let registryLoads = 0
  page.on('request', (request) => {
    if (request.url().includes('/workbooks/registry?')) registryLoads += 1
  })

  await enableStagingWorkbookTools(page)
  await page.goto('./#/payments?ym=2026-07')
  await page.getByText('Wgraj arkusz', { exact: true }).click()
  const continueButton = page.getByRole('button', { name: 'Kontynuuj import', exact: true })
  await expect(continueButton).toBeVisible()
  const settledLoads = registryLoads
  await continueButton.click()
  await expect(page.getByRole('button', { name: 'Kontynuuj import', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(keys).toHaveLength(3)
  expect(new Set(keys).size).toBe(3)
  // The run must reload the registry once when it settles, never per slice.
  expect(registryLoads - settledLoads).toBe(1)
})

test('@coordinator @specialist keeps capability-scoped finance controls', async ({ page }, testInfo) => {
  await freezeTime(page)
  await routeWorkspace(page)
  await routeOwnPayments(page)
  await routeRegistry(page, [registryImport()])
  await page.route('**/api/v1/finance/window?*', (route) => (
    route.fulfill(json(financeWindow('2026-07')))
  ))

  if (testInfo.project.name === 'coordinator') {
    await page.goto('./#/payments')
    await expect(page.getByText('Wgraj arkusz', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('Wybierz plik Excel (.xlsx)')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Kontynuuj import' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Pobierz arkusz Excel' })).toHaveCount(0)
    return
  }
  await page.goto('./#/payments')
  await expect(page.getByRole('button', { name: 'Pobierz arkusz Excel' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Przychody' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Rejestr' })).toHaveCount(0)
})

test('@owner chooses the finance surface from current capabilities rather than role', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.capabilities = body.data.capabilities.filter((value) => (
      value !== 'finance.centre.read'
    ))
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  let financeRequests = 0
  await page.route('**/api/v1/finance/window?*', (route) => {
    financeRequests += 1
    return route.fulfill(json(financeWindow('2026-07')))
  })
  await routeWorkspace(page)

  await page.goto('./#/payments')
  await expect(page.getByRole('heading', { name: 'Finanse niedostępne' })).toBeVisible()
  await expect(page.getByText('Dostęp do finansów nadaje osoba zarządzająca panelem.', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Finanse' })).toHaveCount(0)
  expect(financeRequests).toBe(0)
  await expect(page.getByRole('button', { name: 'Pobierz arkusz Excel' })).toHaveCount(0)

  await page.goto('./#/reports')
  await expect(page).toHaveURL(/#\/dashboard$/)
  await expect(page.locator('.toast').filter({ hasText: 'Nie możemy otworzyć tego widoku.' })).toHaveCount(1)

  await page.goto('./#/nieznana')
  await expect(page).toHaveURL(/#\/dashboard$/)
  await expect(page.locator('.toast').filter({ hasText: 'Nie możemy otworzyć tego widoku.' })).toHaveCount(1)
})

test('@owner with a proven specialist profile falls back to own payments after centre-read denial', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.actor.specialistId = specialist.id
    body.data.actor.professionalTitle = 'Psycholożka'
    body.data.capabilities = body.data.capabilities.filter((value) => (
      value !== 'finance.centre.read'
    ))
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  let financeRequests = 0
  await page.route('**/api/v1/finance/window?*', (route) => {
    financeRequests += 1
    return route.fulfill(json(financeWindow('2026-07')))
  })
  const workspaceRequests = []
  const ownRequests = []
  await routeWorkspace(page, workspaceRequests)
  await routeOwnPayments(page, ownRequests)

  await page.goto('./#/payments?ym=2026-07')
  await expect(page.getByRole('heading', { name: 'Finanse i płatności' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cały zespół' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Przychody' })).toHaveCount(0)
  expect(financeRequests).toBe(0)
  expect(ownRequests.length).toBeGreaterThan(0)
  expect(ownRequests.every(({ from, to }) => (
    from === '2026-07-01' && to === '2026-07-31'
  ))).toBe(true)
  expect(workspaceRequests).toEqual([{ from: '2026-08-10', to: '2026-08-16' }])
})

test('@owner keeps own payments with charge-read alone and never loads workspace', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.actor.specialistId = specialist.id
    body.data.actor.professionalTitle = 'Psycholożka'
    body.data.capabilities = body.data.capabilities.filter((value) => ![
      'client.operational.read', 'finance.centre.read', 'specialist.directory.read',
    ].includes(value))
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  let workspaceRequests = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    workspaceRequests += 1
    return route.fulfill(json(workspace('2026-07-01', '2026-07-31')))
  })
  const ownRequests = []
  await routeOwnPayments(page, ownRequests)

  await page.goto('./#/payments?ym=2026-07')
  await expect(page.getByRole('heading', { name: 'Finanse i płatności' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Finanse' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pobierz arkusz Excel' })).toHaveCount(0)
  const ownTable = page.getByRole('table', { name: 'Własne rozliczenia sesji' })
  await expect(ownTable.getByRole('button', { name: /Dodaj wpłatę.*sesja/i }).first()).toBeVisible()
  await expect(ownTable.getByRole('link', { name: 'Otwórz w Grafiku' })).toHaveCount(0)
  expect(ownRequests.length).toBeGreaterThan(0)
  expect(ownRequests.every(({ from, to }) => (
    from === '2026-07-01' && to === '2026-07-31'
  ))).toBe(true)
  expect(workspaceRequests).toBe(0)
})

test('@owner records an own-session payment through the narrow monthly window', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.actor.specialistId = specialist.id
    body.data.actor.professionalTitle = 'Psycholożka'
    body.data.capabilities = body.data.capabilities.filter((value) => value !== 'finance.centre.read')
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  let records = [...appointments]
  const calls = []
  await page.route('**/api/v1/payments/own?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(json(ownPayments(
      url.searchParams.get('from'), url.searchParams.get('to'), records,
    )))
  })
  await page.route('**/api/v1/appointments/apt_finance_e2e_0/payments', async (route) => {
    calls.push(route.request().postDataJSON())
    const receivedAt = '2026-08-15T10:00:00.000Z'
    const updated = {
      ...appointments[0], version: 2, updatedAt: '2026-08-15T10:01:00.000Z',
      payment: {
        status: 'paid', collectedGrosze: 18_000, outstandingGrosze: 0,
        latestMethod: 'card', latestReceivedAt: receivedAt,
      },
      paymentEntries: [{
        id: 'pay_finance_e2e_0', amountGrosze: 18_000, method: 'card', receivedAt,
        correctedAt: null, replacementEntryId: null,
      }],
    }
    records = [updated, ...appointments.slice(1)]
    await route.fulfill(json({ data: { appointment: updated } }))
  })

  await page.goto('./#/payments?ym=2026-07')
  const table = page.getByRole('table', { name: 'Własne rozliczenia sesji' })
  const row = table.locator('tbody tr').first()
  await expect(row).toContainText('1 lipca 2026')
  await expect(row).toContainText('10:00')
  await expect(row.getByRole('link', { name: 'Otwórz w Grafiku' })).toHaveAttribute(
    'href', '#/calendar?date=2026-07-01&highlightSessionIds=apt_finance_e2e_0',
  )
  await row.getByRole('button', { name: /Dodaj wpłatę.*sesja/i }).click()
  const entry = page.getByRole('dialog', { name: 'Dodaj wpłatę' })
  await expect(entry).toContainText('1 lipca 2026 · 10:00')
  await expect(entry.getByLabel('Kwota wpłaty')).toHaveValue('180')
  await entry.getByLabel('Forma płatności').selectOption('card')
  await entry.getByRole('button', { name: 'Zapisz wpłatę' }).click()

  await expect(entry).toHaveCount(0)
  await expect(row).toContainText('Opłacona')
  await expect(row.getByRole('button', { name: /Dodaj wpłatę/i })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Twoje sesje' })).toBeFocused()
  expect(calls).toEqual([{
    expectedVersion: 1, amountGrosze: 18_000, method: 'card',
    receivedAt: '2026-08-15T10:00:00.000Z',
  }])
})

test('@owner without payment management can read own balances but cannot record a payment', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.actor.specialistId = specialist.id
    body.data.actor.professionalTitle = 'Psycholożka'
    body.data.capabilities = body.data.capabilities.filter((value) => ![
      'client.operational.read', 'finance.centre.read', 'payment.manage', 'specialist.directory.read',
    ].includes(value))
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  await routeOwnPayments(page)

  await page.goto('./#/payments?ym=2026-07')
  const table = page.getByRole('table', { name: 'Własne rozliczenia sesji' })
  await expect(table).toContainText('180 zł')
  await expect(table.getByRole('button', { name: /Dodaj wpłatę/i })).toHaveCount(0)
})

test('@owner uses finance-owned specialist labels and import choices without workspace authority', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.environment = 'staging'
    body.data.capabilities = body.data.capabilities.filter((value) => ![
      'appointment.charge.read', 'client.operational.read', 'specialist.directory.read',
    ].includes(value))
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  let workspaceRequests = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    workspaceRequests += 1
    return route.fulfill(json(workspace('2026-07-01', '2026-07-31')))
  })
  await page.route('**/api/v1/finance/window?*', (route) => (
    route.fulfill(json(financeWindow('2026-07')))
  ))
  const pending = registryImport({ status: 'conflicts', version: 1, resolutionVersion: 0 })
  await routeRegistry(page, [pending])
  await page.route('**/api/v1/workbooks/preview', (route) => (
    route.fulfill(json(previewWithConflict))
  ))
  await page.route('**/api/v1/workbooks/imports/wbi_finance_e2e', (route) => (
    route.fulfill(json({ data: {
      import: importedDto({ status: 'conflicts' }), job: jobDto(),
      evidence: { createdRecords: 0, voidedRecords: 0, converged: false },
    } }))
  ))
  await page.route('**/api/v1/workbooks/registry/details', (route) => (
    route.fulfill(json({ data: {
      importId: pending.id, section: 'conflicts', cursor: null,
      planDigest: PLAN_DIGEST, nextCursor: null,
      specialistOptions: [{ id: specialist.id, label: specialist.displayName }],
      items: [{
        id: `wmc_${'F'.repeat(43)}`, kind: 'specialist_mapping', resolved: false,
        sourceValue: AUTHORIZED_SOURCE,
      }], complete: true,
    } }))
  ))

  await page.goto('./#/payments?ym=2026-07')
  await expect(page.getByText(specialist.displayName, { exact: true }).first()).toBeVisible()
  await page.goto('./#/reports?ym=2026-07')
  await expect(page.getByText(specialist.displayName, { exact: true })).toBeVisible()
  await openWorkbookTools(page, { sessionConfigured: true })
  await page.getByLabel('Wybierz plik Excel (.xlsx)').setInputFiles({
    name: 'fikcyjny.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByLabel('Specjalistka nr 1')
    .getByRole('option', { name: specialist.displayName })).toHaveCount(1)
  expect(workspaceRequests).toBe(0)
})

test('@owner reviews an archived Panel specialist from preview authority without workspace', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.environment = 'staging'
    body.data.capabilities = body.data.capabilities.filter((value) => ![
      'appointment.charge.read', 'client.operational.read', 'specialist.directory.read',
    ].includes(value))
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  let workspaceRequests = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    workspaceRequests += 1
    return route.fulfill(json(workspace('2026-07-01', '2026-07-31')))
  })
  await routeRegistry(page)
  const archivedId = 'sp_archived_panel_evidence'
  const archivedLabel = 'Barbara Archiwalna'
  const archivedPreview = structuredClone(panelPreview)
  archivedPreview.data.panelChanges.updates[0].values.specialistId = archivedId
  archivedPreview.data.specialistOptions = []
  archivedPreview.data.specialistLabels = [{ id: archivedId, label: archivedLabel }]
  await page.route('**/api/v1/workbooks/preview', (route) => (
    route.fulfill(json(archivedPreview))
  ))

  await openWorkbookTools(page, { sessionConfigured: true })
  await page.getByLabel('Wybierz plik Excel (.xlsx)').setInputFiles({
    name: 'fikcyjny-panel.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  const evidence = page.locator('.workbook-import__evidence li')
    .filter({ hasText: 'Pozycja do zmiany:' })
  await expect(evidence).toContainText(`specjalistka — ${archivedLabel}`)
  await expect(page.getByRole('main')).not.toContainText(archivedId)
  expect(workspaceRequests).toBe(0)
})

test('@owner keeps Task 11 grids bounded and the workbook registry out of navigation at every breakpoint', async ({ page }) => {
  await freezeTime(page)
  await enableStagingWorkbookTools(page)
  await routeWorkspace(page)
  await routeRegistry(page, [registryImport()])
  await page.route('**/api/v1/finance/window?*', (route) => (
    route.fulfill(json(financeWindow('2026-07')))
  ))
  await page.route('**/api/v1/workbooks/preview', (route) => (
    route.fulfill(json(previewWithLongConflict))
  ))

  for (const width of [320, 390, 639, 640, 641, 768, 800, 1023, 1024, 1025, 1280]) {
    const columns = width <= 1024 ? 2 : 3
    await page.setViewportSize({ width, height: 900 })
    await page.goto('./#/payments?ym=2026-07')
    await expect(page.getByRole('heading', { name: /Finanse/ })).toBeVisible()
    expect(await page.locator('.finance-window__kpis').evaluate((element) => (
      getComputedStyle(element).gridTemplateColumns.split(' ').length
    ))).toBe(columns)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    if (width <= 640) {
      await expect(page.getByRole('button', { name: 'Więcej', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Otwórz menu' })).toHaveCount(0)
    } else if (width <= 1024) {
      await expect(page.getByRole('button', { name: 'Otwórz menu' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Więcej', exact: true })).toHaveCount(0)
    } else {
      await expect(page.getByRole('link', { name: 'Rejestr' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Otwórz menu' })).toHaveCount(0)
    }
    await page.goto('./#/reports?ym=2026-07')
    await expect(page.getByRole('heading', { name: /Raport/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    await openWorkbookTools(page, { sessionConfigured: true })
    await expect(page.getByText('Wgraj arkusz', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
  }

  const navigationIcons = await page.evaluate(() => {
    const byText = (text) => [...document.querySelectorAll('a')]
      .find((link) => link.textContent.includes(text))?.querySelector('svg')?.innerHTML
    return { ledger: byText('Rejestr'), reports: byText('Raporty') }
  })
  expect(navigationIcons.ledger).toBeUndefined()
  expect(navigationIcons.reports).toBeTruthy()

  await page.setViewportSize({ width: 390, height: 900 })
  await page.getByLabel('Wybierz plik Excel (.xlsx)').setInputFiles({
    name: 'fikcyjny.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByText(LONG_AUTHORIZED_SOURCE, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true)

  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('./#/payments?ym=2026-07')
  const incomeTable = page.getByRole('table', { name: 'Lista wpływów' })
  await expect(incomeTable).toHaveClass(/table--cards/)
  await expect(incomeTable.locator('td[data-th="Płatność"]').first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.goto('./#/reports?ym=2026-07')
  const trend = page.getByRole('region', { name: 'Przewijana tabela trendu sześciu miesięcy' })
  await trend.focus()
  const trendBefore = await trend.evaluate((element) => element.scrollLeft)
  await trend.press('ArrowRight')
  expect(await trend.evaluate((element) => element.scrollLeft)).toBeGreaterThan(trendBefore)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true)

  const routeBeforeSkip = page.url()
  const skip = page.getByRole('link', { name: 'Przejdź do treści' })
  await skip.focus()
  await skip.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  expect(page.url()).toBe(routeBeforeSkip)
})

test('@owner renders Polish report counts without exposing workbook history', async ({ page }) => {
  await freezeTime(page)
  const values = [5, 2, 1].map((count) => registryImport({
    id: `wbi_plural_${count}`,
    artifact: { ...registryImport().artifact, id: `wba_plural_${count}` },
    summary: {
      sourceCount: count, quarantineCount: count, conflictCount: count,
      duplicateCount: count, resolutionCount: 0,
    },
  }))
  await routeRegistry(page, values)
  await page.route('**/api/v1/finance/window?*', (route) => (
    route.fulfill(json(financeWindow('2026-07')))
  ))

  await page.goto('./#/reports?ym=2026-07')
  await expect(page.getByText(/2 aktywności/)).toBeVisible()
  await expect(page.getByText(/5 aktywności/)).toBeVisible()
  await expect(page.getByText(/1 pozycja z arkusza nie ma przypisanego miesiąca/))
    .toBeVisible()
})

test('@coordinator cannot open hidden workbook history from Finance', async ({ page }) => {
  await freezeTime(page)
  const workspaceRequests = []
  const workbookRequests = []
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/workbooks/')) workbookRequests.push(request.url())
  })
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    workspaceRequests.push({ from, to })
    return route.fulfill(json(workspace(from, to)))
  })
  await page.goto('./#/payments')
  await expect(page.getByText('Wgraj arkusz', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Rozstrzygnięcia', { exact: true })).toHaveCount(0)
  expect(workbookRequests).toEqual([])
  expect(workspaceRequests).toContainEqual({ from: '2026-08-01', to: '2026-08-31' })
})
