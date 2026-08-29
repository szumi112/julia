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
  version: 1, cancelledAt: null, createdAt: NOW, updatedAt: NOW,
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
const ownPayments = (from, to) => ({ data: {
  window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
  appointments: appointments.filter((item) => (
    item.startsAt.slice(0, 10) >= from && item.startsAt.slice(0, 10) <= to
  )).map((item) => ({
    id: item.id,
    serviceId: item.serviceId,
    startsAt: item.startsAt,
    status: item.status,
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
  revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0,
  expensesGrosze: 0, incomeGrosze: 0,
})
const financeRows = appointments.map((value, index) => ({
  id: `fin_panel_e2e_${index}`, sourceKind: 'panel', appointmentId: value.id,
  accountingMonth: '2026-07', occurredOn: value.startsAt.slice(0, 10), kind: 'income',
  recordType: 'income', revenueGrosze: 18_000, receivableGrosze: 18_000,
  collectedGrosze: 0, expenseGrosze: 0, specialistId: specialist.id,
  serviceId: 'zajecia', program: null, paymentMethod: 'unknown',
  invoiceStatus: 'not_required', version: 1,
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
      payment: { outstanding: total },
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
  response.data.splits.payment = { cash: 18_000, outstanding: 342_000 }
  await page.route('**/api/v1/finance/window?*', (route) => (
    route.fulfill(json(response))
  ))

  await page.goto('./#/payments?unpaidOnly=true&ym=2026-07')

  const table = page.getByRole('table', { name: 'Lista rozliczeń' })
  const filters = page.getByRole('group', { name: 'Widok rozliczeń' })
  await expect(filters.getByRole('button', { name: 'Zaległości' }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(table.getByRole('row')).toHaveCount(20)
  await expect(table.getByText('1 lip', { exact: true })).toHaveCount(0)

  await filters.getByRole('button', { name: 'Wszystkie' }).click()
  await expect(table.getByRole('row')).toHaveCount(21)
  await expect(table.getByText('1 lip', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/payments\?ym=2026-07$/)

  await filters.getByRole('button', { name: 'Zaległości' }).click()
  await page.getByRole('tab', { name: 'Przychody' }).click()
  await expect(page).toHaveURL(/#\/payments\?tab=income&ym=2026-07$/)
  await page.getByRole('tab', { name: 'Płatności i zaległości' }).click()
  await expect(filters.getByRole('button', { name: 'Zaległości' }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(table.getByRole('row')).toHaveCount(20)
  await expect(page).toHaveURL(/#\/payments\?unpaidOnly=true&ym=2026-07$/)

  await page.getByRole('link', { name: 'Raporty', exact: true }).click()
  await page.getByRole('link', { name: 'Finanse', exact: true }).click()
  await expect(filters.getByRole('button', { name: 'Zaległości' }))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(table.getByRole('row')).toHaveCount(20)
  await expect(page).toHaveURL(/#\/payments\?unpaidOnly=true&ym=2026-07$/)
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
  await expect(page.getByText('Brak danych w bieżącym miesiącu', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveText([
    'Przychody', 'Płatności i zaległości', 'Wydatki', 'Faktury',
  ])
  for (const label of [
    'Przychody', 'Wpłacono', 'Pozostało do zapłaty', 'Wydatki', 'Dochód',
  ]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: /Pokaż ostatni miesiąc z danymi/ }).click()
  await julyStarted
  await expect(page.getByRole('heading', { level: 1, name: 'Finanse centrum' }))
    .toBeVisible()
  await expect(page.getByText('Wczytywanie finansów…', { exact: true })).toBeVisible()
  await expect(page.getByText('Brak danych w bieżącym miesiącu', { exact: true }))
    .toHaveCount(0)
  releaseJuly()
  const heading = page.getByRole('heading', { level: 1, name: /Finanse — lipiec 2026/ })
  await expect(heading).toBeFocused()
  await expect(page.getByRole('table', { name: 'Lista rozliczeń' }).getByRole('row'))
    .toHaveCount(21)
  expect(workspaceRequests.filter(({ from, to }) => (
    from === '2026-07-01' && to === '2026-07-31'
  ))).toHaveLength(1)
  await expect(page.getByRole('button', { name: /Zaksięguj wpłatę/ }).first())
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
  await page.getByRole('button', {
    name: 'Przejdź do pozycji z nieustalonym okresem',
  }).click()
  await expect(page).toHaveURL(/#\/ledger\?section=unknown$/)
  await expect(page.getByRole('tab', { name: 'Okres nieustalony' }))
    .toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('table', { name: 'Pozycje rejestru finansowego' }))
    .toContainText('Okres nieustalony')
})

test('@owner preserves the exact file and idempotency key across an ambiguous create retry', async ({ page }) => {
  await freezeTime(page)
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

  await page.goto('./#/ledger')
  const picker = page.getByLabel('Wybierz plik XLSX')
  await picker.setInputFiles({
    name: 'fikcyjny.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByRole('heading', {
    name: 'Podgląd — nic nie zostało zapisane',
  })).toBeFocused()
  await expect(page.getByRole('heading', { name: 'Proponowane przypisania' })).toBeVisible()
  await expect(page.getByText('Anna N. → Anna Nowak', { exact: true })).toBeVisible()
  await expect(page.getByText('2 powtórzone pozycje źródłowe', { exact: true })).toBeVisible()
  await expect(page.getByText('1 kwota zapisana jako tekst', { exact: true })).toBeVisible()
  await expect(page.getByText('5 ostrzeżeń wymaga przeglądu', { exact: true })).toBeVisible()
  await expect(page.getByText('Fikcyjny arkusz · wiersz 4', { exact: true })).toBeVisible()
  const mappingSelect = page.getByLabel('Wybierz specjalistkę — konflikt 1')
  await expect(mappingSelect.getByRole('option', {
    name: `Anna Nowak · ${specialist.id}`, exact: true,
  })).toHaveCount(1)
  await expect(mappingSelect.getByRole('option', {
    name: `Anna Nowak · ${duplicateSpecialistId}`, exact: true,
  })).toHaveCount(1)
  await mappingSelect.selectOption(duplicateSpecialistId)
  await page.getByRole('button', { name: 'Zapisz i rozpocznij import' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Ten sam plik i klucz operacji zostały zachowane',
  )
  await expect(picker).toBeDisabled()
  await expect(mappingSelect).toBeDisabled()
  expect(await picker.evaluate((input) => input.files.length)).toBe(0)
  await page.getByRole('button', { name: 'Zapisz i rozpocznij import' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Import zapisany' }))
    .toBeVisible()
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
  expect(keys[0]).toMatch(/^workbook-import-/)
  expect(submittedResolutions).toEqual([[
    { conflictId: `wmc_${'Q'.repeat(43)}`, specialistId: duplicateSpecialistId },
  ], [
    { conflictId: `wmc_${'Q'.repeat(43)}`, specialistId: duplicateSpecialistId },
  ]])
  expect(await page.getByLabel('Wybierz plik XLSX')
    .evaluate((input) => input.files.length)).toBe(0)
  await expect(page.getByRole('main')).not.toContainText('RAW_SOURCE_MUST_NOT_RENDER')
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

  await page.goto('./#/ledger')
  await page.getByLabel('Wybierz plik XLSX').setInputFiles({
    name: 'fikcyjny.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await page.getByRole('button', { name: 'Zapisz i rozpocznij import' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Plik mógł zostać już zaimportowany albo lista specjalistek się zmieniła',
  )
  await expect(page.getByRole('button', { name: 'Zapisz i rozpocznij import' }))
    .toHaveCount(0)
  expect(await page.getByLabel('Wybierz plik XLSX')
    .evaluate((input) => input.files.length)).toBe(0)
})

test('@owner reviews exact signed Panel-v2 updates, voids and blocking conflicts', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  await routeRegistry(page)
  await page.route('**/api/v1/workbooks/preview', (route) => route.fulfill(json(panelPreview)))
  await page.goto('./#/ledger')
  await page.getByLabel('Wybierz plik XLSX').setInputFiles({
    name: 'fikcyjny-panel.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByRole('heading', { name: 'Zmiany Panel-v2' })).toBeVisible()
  const updateEvidence = page.locator('.workbook-import__evidence li')
    .filter({ hasText: 'fin_panel_review_update' })
  await expect(updateEvidence).toContainText('kwota — 190,00 zł')
  await expect(updateEvidence).toContainText('miesiąc księgowy — lipiec 2026')
  await expect(updateEvidence).toContainText('data — 15 lip')
  await expect(updateEvidence).toContainText('sposób płatności — Przelew')
  await expect(updateEvidence).toContainText('rozliczenie — Opłacona')
  await expect(updateEvidence).toContainText('faktura — Wystawiona')
  await expect(updateEvidence).toContainText('specjalistka — Anna Nowak')
  await expect(updateEvidence).not.toContainText('transfer')
  await expect(updateEvidence).not.toContainText('issued')
  await expect(updateEvidence).not.toContainText(specialist.id)
  await expect(page.getByText('fin_panel_review_void', { exact: true })).toBeVisible()
  const conflictEvidence = page.locator('.workbook-import__evidence li')
    .filter({ hasText: 'fin_panel_review_conflict' })
  await expect(conflictEvidence).toContainText(
    'obecnie: 180,00 zł · w pliku: 200,00 zł',
  )
  const dependencyEvidence = page.locator('.workbook-import__evidence li')
    .filter({ hasText: 'fin_panel_review_dependency' })
  await expect(dependencyEvidence).toContainText(
    'Pozycja ma aktywne powiązanie i nie może być zmieniona w pliku',
  )
  await expect(page.getByRole('button', { name: 'Zapisz i rozpocznij import' }))
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

  await page.goto('./#/ledger')
  await expect(page.getByRole('button', { name: 'Przejrzyj import' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Kontynuuj import' })).toHaveCount(0)
  await expect(page.getByText('wba_finance_e2e', { exact: true })).toBeVisible()
  await expect(page.getByText('a'.repeat(64), { exact: true })).toBeVisible()
  await expect(page.getByText('Parser 2 · materializator 2', { exact: true })).toBeVisible()
  await page.getByLabel('Wybierz plik XLSX').setInputFiles({
    name: 'fikcyjny.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByRole('heading', {
    name: 'Podgląd — nic nie zostało zapisane',
  })).toBeVisible()
  await expect(page.getByLabel('Wybierz specjalistkę — konflikt 1')).toBeVisible()
  await expect(page.getByLabel(new RegExp(AUTHORIZED_SOURCE))).toHaveCount(0)
  await expect(page.getByText(AUTHORIZED_SOURCE, { exact: true })).toBeVisible()
  expect(await page.locator('*').evaluateAll((nodes, sentinel) => nodes.some((node) => (
    [...node.attributes].some(({ value }) => value.includes(sentinel))
  )), AUTHORIZED_SOURCE)).toBe(false)
  expect(requests.some(({ url, body }) => url.includes(AUTHORIZED_SOURCE)
    || body.includes(AUTHORIZED_SOURCE))).toBe(false)
  expect(messages.some((value) => value.includes(AUTHORIZED_SOURCE))).toBe(false)
  await page.getByRole('button', { name: 'Eksportuj Panel-v2' }).click()
  await expect(page.getByRole('button', { name: 'Eksportuj Panel-v2' })).toBeDisabled()

  refreshed = true
  const sessionRefresh = page.waitForResponse('**/api/v1/session')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await sessionRefresh

  const picker = page.getByLabel('Wybierz plik XLSX')
  await expect(picker).toBeEnabled()
  expect(await picker.evaluate((input) => input.files.length)).toBe(0)
  await expect(page.getByRole('heading', {
    name: 'Podgląd — nic nie zostało zapisane',
  })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Zapisz i rozpocznij import' }))
    .toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Eksportuj Panel-v2' })).toBeEnabled()
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

test('@owner downloads an audited export and safely retries a manual void', async ({ page }) => {
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
  const voidKeys = []
  let voidAttempts = 0
  let releaseVoidFailure
  await page.route('**/api/v1/finance/entries/fin_void_e2e/voids', async (route) => {
    voidAttempts += 1
    voidKeys.push(route.request().headers()['idempotency-key'])
    if (voidAttempts === 1) return new Promise((resolve) => {
      releaseVoidFailure = async () => {
        await route.abort('connectionreset')
        resolve()
      }
    })
    return route.fulfill(json({ data: {
      entryId: entry.id, state: 'void', version: 1,
    } }))
  })

  await page.goto('./#/ledger')
  await page.getByRole('button', { name: 'Eksportuj Panel-v2' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Nie udało się przygotować bezpiecznego eksportu',
  )
  await page.getByRole('button', { name: 'Eksportuj Panel-v2' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Dane zmieniły się — ponów jako nowy eksport',
  )
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Eksportuj Panel-v2' }).click()
  expect((await download).suggestedFilename())
    .toBe('bear-with-me-panel-v2-2026-08-15.xlsx')
  expect(exportKeys).toHaveLength(3)
  expect(exportKeys[0]).toBe(exportKeys[1])
  expect(exportKeys[2]).not.toBe(exportKeys[1])
  await page.getByRole('tab', { name: 'Pozycje rejestru' }).click()
  const opener = page.getByRole('button', { name: 'Unieważnij pozycję' })
  await opener.click()
  await expect(page.getByRole('dialog')).toContainText(
    'Niezmienny skoroszyt i rekord źródłowy pozostają zachowane',
  )
  await page.getByRole('dialog').evaluate((dialog) => dialog.click())
  await expect(opener).toBeFocused()
  await opener.click()
  await page.getByLabel('Powód unieważnienia').fill('Fikcyjna pozycja testowa jest podwójna.')
  await page.getByRole('button', { name: 'Potwierdź unieważnienie' }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Anuluj' })).toBeDisabled()
  await expect(page.getByLabel('Powód unieważnienia')).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').evaluate((dialog) => dialog.click())
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(voidAttempts).toBe(1)
  await releaseVoidFailure()
  await expect(page.getByRole('dialog').getByRole('alert'))
    .toContainText('Nie potwierdzono zapisu')
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Anuluj' }))
    .toBeDisabled()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').evaluate((dialog) => dialog.click())
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Potwierdź unieważnienie' }).click()
  await expect(opener).toBeFocused()
  expect(voidKeys).toHaveLength(2)
  expect(voidKeys[0]).toBe(voidKeys[1])
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

  await page.goto('./#/ledger')
  const detailOpener = page.getByRole('button', { name: 'Przejrzyj import' })
  await detailOpener.click()
  await page.getByRole('tab', { name: 'Konflikty' }).click()
  await expect(page.getByText(
    'Fikcyjna specjalistka po ponownym wczytaniu', { exact: true },
  )).toBeVisible()
  await detailOpener.evaluate((element) => element.remove())
  await page.getByRole('button', { name: 'Zamknij szczegóły' }).click()
  await expect(page.getByRole('heading', { level: 1, name: /Rejestr skoroszytów/ }))
    .toBeFocused()
  await page.getByRole('button', { name: 'Rozstrzygnij konflikty' }).click()
  await expect(page.getByRole('heading', { name: 'Rozstrzygnij przypisania' }))
    .toBeFocused()
  await expect(page.getByText(
    'Fikcyjna specjalistka po ponownym wczytaniu', { exact: true },
  )).toBeVisible()
  await expect(page.getByLabel(/Fikcyjna specjalistka po ponownym wczytaniu/))
    .toHaveCount(0)
  await page.getByLabel('Konflikt przypisania 1').selectOption(specialist.id)
  await page.getByRole('button', {
    name: 'Zapisz rozstrzygnięcia i kontynuuj',
  }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Ponów dokładnie ten sam zestaw rozstrzygnięć',
  )
  await expect(page.getByLabel('Konflikt przypisania 1')).toBeDisabled()
  await page.getByRole('button', {
    name: 'Zapisz rozstrzygnięcia i kontynuuj',
  }).click()
  await expect(page.getByRole('heading', { level: 1, name: /Rejestr skoroszytów/ }))
    .toBeFocused()
  expect(resolutionBodies).toEqual([{
    expectedVersion: 0, planDigest: PLAN_DIGEST,
    resolutions: [{ conflictId: 'wmc_conflict_e2e', specialistId: specialist.id }],
  }, {
    expectedVersion: 0, planDigest: PLAN_DIGEST,
    resolutions: [{ conflictId: 'wmc_conflict_e2e', specialistId: specialist.id }],
  }])
  expect(resolutionKeys[0]).toBe(resolutionKeys[1])
})

test('@owner can switch between pending creator imports without carrying retry state', async ({ page }) => {
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

  await page.goto('./#/ledger')
  const firstCard = page.locator('article').filter({ hasText: first.id })
  const secondCard = page.locator('article').filter({ hasText: second.id })
  await firstCard.getByRole('button', { name: 'Rozstrzygnij konflikty' }).click()
  await expect(page.getByText('Fikcyjna wartość pierwszego importu', { exact: true }))
    .toBeVisible()
  await secondCard.getByRole('button', { name: 'Kontynuuj import' }).click()
  await expect(page.getByRole('heading', { level: 1, name: /Rejestr skoroszytów/ }))
    .toBeFocused()
  await expect(page.getByText('Fikcyjna wartość pierwszego importu', { exact: true }))
    .toHaveCount(0)
  expect(secondContinuations).toBe(1)
})

test('@owner can retry a failed continuation and cannot overlap it with a void', async ({ page }) => {
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
  let attempts = 0
  const keys = []
  await page.route(
    '**/api/v1/workbooks/imports/wbi_finance_e2e/continue',
    (route) => {
      attempts += 1
      keys.push(route.request().headers()['idempotency-key'])
      if (attempts === 1) return new Promise((resolve) => {
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

  await page.goto('./#/ledger')
  await page.getByRole('button', { name: 'Kontynuuj import' }).click()
  await page.getByRole('tab', { name: 'Pozycje rejestru' }).click()
  await expect(page.getByRole('button', { name: 'Unieważnij pozycję' })).toBeDisabled()
  await releaseFailure()
  await expect(page.getByRole('alert')).toContainText('Nie udało się kontynuować importu')
  await page.getByRole('tab', { name: 'Importy' }).click()
  await page.getByRole('button', { name: 'Kontynuuj import' }).click()
  await expect(page.getByRole('heading', { level: 1, name: /Rejestr skoroszytów/ }))
    .toBeFocused()
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
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
    await page.goto('./#/ledger')
    await expect(page.getByLabel('Wybierz plik XLSX')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Kontynuuj import' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Eksportuj Panel-v2' })).toBeVisible()
    return
  }
  await page.goto('./#/payments')
  await expect(page.getByRole('button', { name: 'Eksportuj własne dane' })).toBeVisible()
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
  expect(financeRequests).toBe(0)
  await expect(page.getByRole('button', { name: 'Eksportuj własne dane' })).toHaveCount(0)
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
  expect(workspaceRequests).toEqual([])
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
  await expect(page.getByRole('button', { name: 'Eksportuj własne dane' })).toHaveCount(0)
  expect(ownRequests.length).toBeGreaterThan(0)
  expect(ownRequests.every(({ from, to }) => (
    from === '2026-07-01' && to === '2026-07-31'
  ))).toBe(true)
  expect(workspaceRequests).toBe(0)
})

test('@owner uses finance-owned specialist labels and import choices without workspace authority', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
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

  await page.goto('./#/payments?ym=2026-07&tab=income')
  await expect(page.getByText(specialist.displayName, { exact: true }).first()).toBeVisible()
  await page.goto('./#/reports?ym=2026-07')
  await expect(page.getByText(specialist.displayName, { exact: true })).toBeVisible()
  await page.goto('./#/ledger')
  await page.getByLabel('Wybierz plik XLSX').setInputFiles({
    name: 'fikcyjny.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByLabel('Wybierz specjalistkę — konflikt 1')
    .getByRole('option', { name: specialist.displayName })).toHaveCount(1)
  await page.getByRole('button', { name: 'Rozstrzygnij konflikty' }).click()
  await expect(page.getByLabel('Konflikt przypisania 1')
    .getByRole('option', { name: specialist.displayName })).toHaveCount(1)
  expect(workspaceRequests).toBe(0)
})

test('@owner reviews an archived Panel specialist from preview authority without workspace', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
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

  await page.goto('./#/ledger')
  await page.getByLabel('Wybierz plik XLSX').setInputFiles({
    name: 'fikcyjny-panel.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  const evidence = page.locator('.workbook-import__evidence li')
    .filter({ hasText: 'fin_panel_review_update' })
  await expect(evidence).toContainText(`specjalistka — ${archivedLabel}`)
  await expect(page.getByRole('main')).not.toContainText(archivedId)
  expect(workspaceRequests).toBe(0)
})

test('@owner keeps Task 11 grids bounded and the ledger icon distinct at every breakpoint', async ({ page }) => {
  await freezeTime(page)
  await routeWorkspace(page)
  await routeRegistry(page, [registryImport()])
  await page.route('**/api/v1/finance/window?*', (route) => (
    route.fulfill(json(financeWindow('2026-07')))
  ))
  await page.route('**/api/v1/workbooks/preview', (route) => (
    route.fulfill(json(previewWithLongConflict))
  ))

  for (const width of [320, 390, 639, 640, 641, 768, 800, 1023, 1024, 1025, 1280]) {
    const columns = width <= 1024 ? 2 : 5
    await page.setViewportSize({ width, height: 900 })
    await page.goto('./#/payments?ym=2026-07')
    await expect(page.getByRole('heading', { name: /Finanse/ })).toBeVisible()
    expect(await page.locator('.finance-window__kpis').evaluate((element) => (
      getComputedStyle(element).gridTemplateColumns.split(' ').length
    ))).toBe(columns)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    if (width <= 640) {
      await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Otwórz menu' })).toHaveCount(0)
    } else if (width <= 1024) {
      await expect(page.getByRole('button', { name: 'Otwórz menu' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveCount(0)
    } else {
      await expect(page.getByRole('link', { name: 'Rejestr' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Otwórz menu' })).toHaveCount(0)
    }
    await page.goto('./#/reports?ym=2026-07')
    await expect(page.getByRole('heading', { name: /Raport/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    await page.goto('./#/ledger')
    await expect(page.getByRole('heading', { name: /Rejestr skoroszytów/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
  }

  const icons = await page.evaluate(() => {
    const byText = (text) => [...document.querySelectorAll('a')]
      .find((link) => link.textContent.includes(text))?.querySelector('svg')?.innerHTML
    return { ledger: byText('Rejestr'), reports: byText('Raporty') }
  })
  expect(icons.ledger).toBeTruthy()
  expect(icons.ledger).not.toBe(icons.reports)

  await page.setViewportSize({ width: 390, height: 900 })
  await page.getByLabel('Wybierz plik XLSX').setInputFiles({
    name: 'fikcyjny.xlsx', mimeType: XLSX, buffer: Buffer.from([80, 75, 3, 4]),
  })
  await expect(page.getByText(LONG_AUTHORIZED_SOURCE, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true)

  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('./#/payments?ym=2026-07&tab=income')
  for (const label of [
    'Przewijana tabela — Przychody miesiąca',
  ]) {
    const region = page.getByRole('region', { name: label })
    await region.focus()
    await expect(region).toBeFocused()
    const before = await region.evaluate((element) => element.scrollLeft)
    await region.press('ArrowRight')
    expect(await region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(before)
  }
  await page.goto('./#/reports?ym=2026-07')
  const trend = page.getByRole('region', { name: 'Przewijana tabela trendu sześciu miesięcy' })
  await trend.focus()
  const trendBefore = await trend.evaluate((element) => element.scrollLeft)
  await trend.press('ArrowRight')
  expect(await trend.evaluate((element) => element.scrollLeft)).toBeGreaterThan(trendBefore)
  await page.goto('./#/ledger?section=entries')
  const registryTable = page.getByRole('region', { name: 'Przewijana tabela pozycji rejestru' })
  await registryTable.focus()
  const registryBefore = await registryTable.evaluate((element) => element.scrollLeft)
  await registryTable.press('ArrowRight')
  expect(await registryTable.evaluate((element) => element.scrollLeft)).toBeGreaterThan(registryBefore)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true)

  const routeBeforeSkip = page.url()
  const skip = page.getByRole('link', { name: 'Przejdź do treści' })
  await skip.focus()
  await skip.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  expect(page.url()).toBe(routeBeforeSkip)
})

test('@owner renders Polish 1/2/5 registry and report counts', async ({ page }) => {
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

  await page.goto('./#/ledger')
  await expect(page.getByText(/1 pozycja · 1 pozycja w kwarantannie/)).toBeVisible()
  await expect(page.getByText(/2 pozycje · 2 pozycje w kwarantannie/)).toBeVisible()
  await expect(page.getByText(/5 pozycji · 5 pozycji w kwarantannie/)).toBeVisible()
  await expect(page.getByText(/1 konflikt · 1 duplikat/)).toBeVisible()
  await expect(page.getByText(/2 konflikty · 2 duplikaty/)).toBeVisible()
  await expect(page.getByText(/5 konfliktów · 5 duplikatów/)).toBeVisible()
  await page.goto('./#/reports?ym=2026-07')
  await expect(page.getByText(/2 aktywności/)).toBeVisible()
  await expect(page.getByText(/5 aktywności/)).toBeVisible()
  await expect(page.getByText('1 pozycja wymaga przeglądu poza wybranym miesiącem.'))
    .toBeVisible()
})

test('@coordinator reads centre resolution labels directly without workspace', async ({ page }) => {
  await freezeTime(page)
  let workspaceRequests = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    workspaceRequests += 1
    return route.fulfill(json(workspace('2026-07-01', '2026-07-31')))
  })
  await routeRegistry(page, [registryImport({ status: 'complete', phase: 'complete' })])
  await page.route('**/api/v1/workbooks/registry/details', (route) => {
    const section = route.request().postDataJSON().section
    return route.fulfill(json({ data: {
      importId: 'wbi_finance_e2e', section, cursor: null, nextCursor: null,
      ...(section === 'resolutions' ? {
        specialistLabels: [{ id: specialist.id, label: specialist.displayName }],
        items: [{
          id: 'wbr_finance_e2e_blank', kind: 'specialist_mapping',
          decision: 'blank_assigned_to_julia', specialistId: specialist.id,
          serviceId: null, targetId: null, resolvedByStaffId: 'stf_local_owner',
          sourceRecordId: null, conflictId: null, sourceValue: '',
          version: 1, createdAt: NOW, choices: [],
        }, {
          id: 'wbr_finance_e2e_resolution', kind: 'specialist_mapping',
          decision: 'explicit_match', specialistId: specialist.id,
          serviceId: null, targetId: null, resolvedByStaffId: 'stf_local_owner',
          sourceRecordId: null, conflictId: null, sourceValue: 'Anna N.',
          version: 1, createdAt: NOW, choices: [],
        }],
      } : { items: [] }), complete: true,
    } }))
  })

  await page.goto('./#/ledger')
  await page.getByRole('button', { name: 'Przejrzyj import' }).click()
  await page.getByRole('tab', { name: 'Rozstrzygnięcia' }).click()
  await expect(page.getByText(specialist.displayName, { exact: true })).toHaveCount(2)
  await expect(page.getByText('Jawnie przypisano specjalistkę', { exact: true })).toBeVisible()
  await expect(page.getByText('Przypisano pustą wartość źródłową', { exact: true }))
    .toBeVisible()
  expect(workspaceRequests).toBe(0)
})
