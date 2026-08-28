import { expect, test } from '@playwright/test'

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const freezeTime = async (page, iso) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript((frozen) => {
    const NativeDate = Date
    const frozenTime = new NativeDate(frozen).getTime()
    class FrozenDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [frozenTime])) }
      static now() { return frozenTime }
    }
    FrozenDate.parse = NativeDate.parse
    FrozenDate.UTC = NativeDate.UTC
    window.Date = FrozenDate
  }, iso)
}

const specialist = {
  id: 'sp_anna', displayName: 'Anna Nowak', professionalTitle: 'Specjalistka',
  standardRateGrosze: 18_000, status: 'active', version: 3, staffVersion: 4,
  accessStatus: 'enabled',
}

const activeClient = {
  id: 'cl_active', name: 'Ola Aktywna', age: 12, status: 'active', version: 2,
  archivedAt: null, createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-07-10T09:00:00.000Z', readOnly: false,
  assignment: {
    id: 'asg_active', specialistId: 'sp_anna',
    startsAt: '2026-01-10T09:00:00.000Z', version: 1,
  },
}

const appointment = {
  id: 'apt_july', clientId: 'cl_active', specialistId: 'sp_anna',
  serviceId: 'zajecia', startsAt: '2026-07-15T09:00:00.000Z',
  endsAt: '2026-07-15T09:50:00.000Z', timeZone: 'Europe/Warsaw', location: null,
  status: 'scheduled', source: 'panel', version: 1, cancelledAt: null,
  createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-01T08:00:00.000Z',
  charge: {
    id: 'chg_july', serviceId: 'zajecia', expectedAmountGrosze: 18_000,
    currency: 'PLN', version: 1,
  },
  payment: {
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
    latestMethod: null, latestReceivedAt: null,
  },
  paymentEntries: [],
}

const historicalClients = [{
  id: 'hcl_ola_source', name: 'Ola ze skoroszytu', status: 'activated',
  activeClientId: 'cl_active', version: 2,
  createdAt: '2026-01-01T08:00:00.000Z', updatedAt: '2026-02-01T08:00:00.000Z',
}, {
  id: 'hcl_zoja', name: 'Zoja Historyczna', status: 'historical', activeClientId: null,
  version: 1, createdAt: '2026-01-01T08:00:00.000Z',
  updatedAt: '2026-01-01T08:00:00.000Z',
}]

const historicalOccurrence = (overrides) => ({
  id: 'hoc_day', historicalClientId: 'hcl_zoja', counterparty: null,
  specialistId: 'sp_anna', serviceId: null, serviceLabel: 'Konsultacja historyczna',
  period: { precision: 'day', day: '2026-07-15', month: '2026-07' },
  status: 'recorded', version: 1, sourceRecordId: 'wbs_day',
  createdAt: '2026-01-01T08:00:00.000Z', updatedAt: '2026-01-01T08:00:00.000Z',
  ...overrides,
})

const historicalOccurrences = [
  historicalOccurrence({}),
  historicalOccurrence({
    id: 'hoc_linked', historicalClientId: 'hcl_ola_source',
    serviceLabel: 'Spotkanie ze skoroszytu',
    period: { precision: 'day', day: '2026-07-15', month: '2026-07' },
    sourceRecordId: 'wbs_linked',
  }),
  historicalOccurrence({
    id: 'hoc_month', serviceLabel: 'Diagnoza historyczna',
    period: { precision: 'month', day: null, month: '2026-07' },
    sourceRecordId: 'wbs_month',
  }),
  historicalOccurrence({
    id: 'hoc_unknown', historicalClientId: null,
    counterparty: { id: 'hcp_school', name: 'Szkoła Testowa' },
    serviceLabel: 'Superwizja historyczna',
    period: { precision: 'unknown', day: null, month: null },
    sourceRecordId: 'wbs_unknown',
  }),
  historicalOccurrence({
    id: 'hoc_unknown_client', serviceLabel: 'Rozmowa historyczna',
    period: { precision: 'unknown', day: null, month: null },
    sourceRecordId: 'wbs_unknown_client',
  }),
]

const workspace = (from, to) => {
  const july = from <= '2026-07-15' && to >= '2026-07-15'
  return {
    window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
    specialists: [specialist],
    clients: [activeClient],
    appointments: july ? [appointment] : [],
    historicalClients: july ? historicalClients : [],
    historicalOccurrences: july ? historicalOccurrences : [],
    latestPopulatedMonth: '2026-07',
  }
}

test('@owner keeps an empty current month until the explicit latest-source action and renders separate historical precision', async ({ page }) => {
  await freezeTime(page, '2026-08-28T08:00:00.000Z')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    await route.fulfill(json(200, { data: workspace(from, to) }))
  })

  await page.goto('./#/calendar?date=2026-08-28&ym=2026-08&mode=cal')

  await expect(page.locator('.month-nav__label')).toHaveText('Sierpień 2026')
  await expect(page.getByText('W sierpniu 2026 nie ma wpisów kalendarza ani skoroszytu.')).toBeVisible()
  await page.getByRole('button', { name: 'Pokaż lipiec 2026' }).click()

  await expect(page.locator('.month-nav__label')).toHaveText('Lipiec 2026')
  await expect(page).toHaveURL(/date=2026-07-01/)
  await page.getByRole('button', { name: /15 lipca — 3 wpisy/ }).click()
  await expect(page.getByText('Zoja Historyczna', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Godzina nieustalona', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: /Wpisy z nieustalonym dniem/ })).toBeVisible()
  await expect(page.getByText('Dzień nieustalony', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /Przejrzyj.*okres/ })).toBeVisible()

  await page.getByRole('button', { name: 'Filtry' }).click()
  await page.getByRole('group', { name: 'Płatność' })
    .getByRole('button', { name: 'Nieopłacona' }).click()
  await expect(page.locator('.historical-filter-note')).toContainText(
    'Wpisy ze skoroszytu bez statusu i płatności są ukryte przez aktywny filtr.',
  )
  await expect(page.getByText('Godzina nieustalona', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /Wpisy z nieustalonym dniem/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Wyczyść filtry' }).click()
  await expect(page.getByRole('link', { name: /Przejrzyj.*okres/ })).toBeVisible()

  await page.getByRole('link', { name: /Przejrzyj.*okres/ }).click()
  await expect(page).toHaveURL(/review=unknown/)
  const review = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Okres nieustalony' }),
  })
  await expect(review.getByRole('heading', { name: 'Okres nieustalony' })).toBeVisible()
  await expect(review.getByText('Szkoła Testowa', { exact: true })).toBeVisible()
  await expect(review.getByText('Superwizja historyczna')).toBeVisible()
  await expect(review.getByRole('button', { name: /Edytuj.*history/ })).toHaveCount(0)
  await expect(review.getByText(/zł/)).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.month-nav__label')).toHaveText('Lipiec 2026')
  await expect(page.getByRole('heading', { name: 'Okres nieustalony' })).toBeVisible()
})

test('@owner keeps historical client profiles separate from active clients and shows source-linked history', async ({ page }) => {
  await freezeTime(page, '2026-08-28T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(json(200, { data: workspace(
      url.searchParams.get('from'), url.searchParams.get('to'),
    ) }))
  })

  await page.goto('./#/clients?catalog=historical&historyPeriod=known&ym=2026-07')

  await expect(page.getByRole('heading', { name: /Klienci historyczni/ })).toBeVisible()
  const directory = page.getByRole('table', { name: 'Klienci historyczni' })
  await expect(directory.getByText('Zoja Historyczna', { exact: true })).toBeVisible()
  await expect(directory.getByText('Ola ze skoroszytu', { exact: true })).toBeVisible()
  await expect(directory).toContainText('Historyczny')
  await expect(directory).toContainText('Aktywowano')
  await expect(directory).not.toContainText('12 lat')
  await expect(directory).not.toContainText('zł')

  await directory.getByRole('link', { name: 'Otwórz historię — Zoja Historyczna' }).click()
  await expect(page.getByRole('heading', { name: 'Zoja Historyczna' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dokładne daty' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Miesiące bez dnia' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Okres nieustalony' })).toBeVisible()
  await expect(page.getByText('Godzina nieustalona', { exact: true })).toBeVisible()
  await expect(page.getByText('Dzień nieustalony', { exact: true })).toBeVisible()
  await expect(page.getByText('Rozmowa historyczna')).toBeVisible()
  await expect(page.getByText(/telefon|e-mail|wiek/i)).toHaveCount(0)

  await page.goto('./#/client?id=cl_active&ym=2026-07')
  await expect(page.getByRole('heading', { name: 'Ola Aktywna' })).toBeVisible()
  const sourceHistory = page.getByRole('region', { name: 'Historia ze skoroszytu' })
  await expect(sourceHistory).toContainText('Spotkanie ze skoroszytu')
  await expect(sourceHistory).toContainText('Widoczny zakres')

  await page.goto('./#/clients?catalog=historical&historyPeriod=unknown&ym=2026-07')
  await expect(page.getByRole('table', { name: 'Klienci historyczni' })
    .getByText('Zoja Historyczna', { exact: true })).toBeVisible()
  await expect(page.getByRole('table', { name: 'Klienci historyczni' })
    .getByText('Szkoła Testowa', { exact: true })).toHaveCount(0)
})

test('@owner @coordinator activates a historical client with an explicit specialist and exact version command', async ({ page }) => {
  await freezeTime(page, '2026-08-28T08:00:00.000Z')
  let activated = false
  const activationRequests = []
  const activatedClient = {
    ...activeClient,
    id: 'cl_zoja_activated', name: 'Zoja Historyczna', age: null, version: 1,
    createdAt: '2026-08-28T08:00:00.000Z', updatedAt: '2026-08-28T08:00:00.000Z',
    assignment: {
      id: 'asg_zoja_activated', specialistId: 'sp_anna',
      startsAt: '2026-08-28T08:00:00.000Z', version: 1,
    },
  }
  const activatedHistorical = {
    ...historicalClients[1], status: 'activated', activeClientId: activatedClient.id,
    version: 2, updatedAt: '2026-08-28T08:00:00.000Z',
  }
  await page.route('**/api/v1/historical-clients/hcl_zoja/activation', async (route) => {
    activationRequests.push(JSON.parse(route.request().postData()))
    activated = true
    await route.fulfill(json(201, {
      data: { historicalClient: activatedHistorical, client: activatedClient },
    }))
  })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const data = workspace(url.searchParams.get('from'), url.searchParams.get('to'))
    if (activated) {
      data.clients = [activeClient, activatedClient]
      data.historicalClients = [historicalClients[0], activatedHistorical]
    }
    await route.fulfill(json(200, { data }))
  })

  await page.goto('./#/client?id=hcl_zoja&ym=2026-07')
  await page.getByRole('button', { name: 'Aktywuj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Aktywuj klienta historycznego' })
  await drawer.getByRole('button', { name: 'Aktywuj klienta' }).click()
  await expect(drawer.getByText('Wybierz specjalistkę', { exact: true })).toBeVisible()
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')
  await drawer.getByRole('button', { name: 'Aktywuj klienta' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(page.locator('.historical-client-band')).toBeFocused()
  expect(activationRequests).toEqual([{
    expectedVersion: 1,
    specialistId: 'sp_anna',
  }])
  await expect(page.getByRole('link', { name: 'Otwórz aktywną kartę' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Aktywuj klienta' })).toHaveCount(0)
})

test('@owner keeps the activation draft through ordinary failure and guarded close or navigation', async ({ page }) => {
  await freezeTime(page, '2026-08-28T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(json(200, { data: workspace(
      url.searchParams.get('from'), url.searchParams.get('to'),
    ) }))
  })
  await page.route('**/api/v1/historical-clients/hcl_zoja/activation', (route) => (
    route.fulfill(json(503, { error: { code: 'INTERNAL_ERROR' } }))
  ))

  await page.goto('./#/client?id=hcl_zoja&ym=2026-07')
  await page.getByRole('button', { name: 'Aktywuj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Aktywuj klienta historycznego' })
  const specialist = drawer.getByLabel('Specjalistka prowadząca')
  await specialist.selectOption('sp_anna')
  await drawer.getByRole('button', { name: 'Aktywuj klienta' }).click()

  await expect(drawer.getByRole('alert')).toContainText('Nie udało się aktywować klienta')
  await expect(specialist).toHaveValue('sp_anna')
  await drawer.getByRole('button', { name: 'Zamknij' }).click()
  await expect(drawer.getByText('Masz niezapisane zmiany.')).toBeVisible()
  await drawer.getByRole('button', { name: 'Wróć' }).click()
  await expect(specialist).toHaveValue('sp_anna')

  await page.evaluate(() => { window.location.hash = '#/clients?catalog=historical' })
  const leave = page.getByRole('alertdialog', { name: 'Niezapisane zmiany' })
  await expect(leave).toBeVisible()
  await leave.getByRole('button', { name: 'Kontynuuj edycję' }).click()
  await expect(page).toHaveURL(/#\/client\?id=hcl_zoja/)
  await expect(specialist).toHaveValue('sp_anna')
})

test('@owner refreshes a version conflict without erasing the activation draft', async ({ page }) => {
  await freezeTime(page, '2026-08-28T08:00:00.000Z')
  let conflicted = false
  const activatedHistorical = {
    ...historicalClients[1], status: 'activated', activeClientId: 'cl_other_activation',
    version: 2, updatedAt: '2026-08-28T08:00:00.000Z',
  }
  const otherClient = {
    ...activeClient,
    id: 'cl_other_activation', name: 'Zoja Historyczna', age: null, version: 1,
    createdAt: '2026-08-28T08:00:00.000Z', updatedAt: '2026-08-28T08:00:00.000Z',
    assignment: {
      id: 'asg_other_activation', specialistId: 'sp_anna',
      startsAt: '2026-08-28T08:00:00.000Z', version: 1,
    },
  }
  await page.route('**/api/v1/historical-clients/hcl_zoja/activation', async (route) => {
    conflicted = true
    await route.fulfill(json(409, { error: { code: 'VERSION_CONFLICT' } }))
  })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const data = workspace(url.searchParams.get('from'), url.searchParams.get('to'))
    if (conflicted) {
      data.clients = [activeClient, otherClient]
      data.historicalClients = [historicalClients[0], activatedHistorical]
    }
    await route.fulfill(json(200, { data }))
  })

  await page.goto('./#/client?id=hcl_zoja&ym=2026-07')
  await page.getByRole('button', { name: 'Aktywuj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Aktywuj klienta historycznego' })
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')
  await drawer.getByRole('button', { name: 'Aktywuj klienta' }).click()

  await expect(drawer.locator('.form-warn--error')).toContainText('Profil zmienił się w innym oknie')
  await expect(drawer.getByLabel('Specjalistka prowadząca')).toHaveValue('sp_anna')
  await expect(drawer).toContainText('Wersja źródła: 2')
  await expect(drawer.getByRole('link', { name: 'Otwórz aktywną kartę' })).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Aktywuj klienta' })).toBeDisabled()
})

test('@owner closes an accepted activation whose canonical reload fails and prevents replay', async ({ page }) => {
  await freezeTime(page, '2026-08-28T08:00:00.000Z')
  let accepted = false
  let activationRequests = 0
  const activatedClient = {
    ...activeClient,
    id: 'cl_reload_failed', name: 'Zoja Historyczna', age: null, version: 1,
    createdAt: '2026-08-28T08:00:00.000Z', updatedAt: '2026-08-28T08:00:00.000Z',
    assignment: {
      id: 'asg_reload_failed', specialistId: 'sp_anna',
      startsAt: '2026-08-28T08:00:00.000Z', version: 1,
    },
  }
  const activatedHistorical = {
    ...historicalClients[1], status: 'activated', activeClientId: activatedClient.id,
    version: 2, updatedAt: '2026-08-28T08:00:00.000Z',
  }
  await page.route('**/api/v1/historical-clients/hcl_zoja/activation', async (route) => {
    activationRequests += 1
    accepted = true
    await route.fulfill(json(201, {
      data: { historicalClient: activatedHistorical, client: activatedClient },
    }))
  })
  await page.route('**/api/v1/workspace?*', async (route) => {
    if (accepted) {
      await route.abort('connectionfailed')
      return
    }
    const url = new URL(route.request().url())
    await route.fulfill(json(200, { data: workspace(
      url.searchParams.get('from'), url.searchParams.get('to'),
    ) }))
  })

  await page.goto('./#/client?id=hcl_zoja&ym=2026-07')
  await page.getByRole('button', { name: 'Aktywuj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Aktywuj klienta historycznego' })
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')
  await drawer.getByRole('button', { name: 'Aktywuj klienta' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(page.getByText('Aktywację przyjęto, ale nie udało się odświeżyć kartoteki.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Aktywuj klienta' })).toBeDisabled()
  expect(activationRequests).toBe(1)
})

test('@specialist renders scoped historical records without activation authority', async ({ page }) => {
  await freezeTime(page, '2026-08-28T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(json(200, { data: workspace(
      url.searchParams.get('from'), url.searchParams.get('to'),
    ) }))
  })

  await page.goto('./#/client?id=hcl_zoja&ym=2026-07')
  await expect(page.getByRole('heading', { name: 'Zoja Historyczna' })).toBeVisible()
  await expect(page.getByText('Konsultacja historyczna')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Aktywuj klienta' })).toHaveCount(0)
})

test('@owner authority revision closes a dirty activation and suppresses stale completion without revoking the readable route', async ({ page }) => {
  await freezeTime(page, '2026-08-28T08:00:00.000Z')
  let refreshed = false
  let sessionRequests = 0
  await page.route('**/api/v1/session', async (route) => {
    sessionRequests += 1
    const response = await route.fetch()
    const body = await response.json()
    if (refreshed) {
      body.data.authorityRevision += 1
      body.data.capabilities = body.data.capabilities.filter((value) => value !== 'client.manage')
    }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(json(200, { data: workspace(
      url.searchParams.get('from'), url.searchParams.get('to'),
    ) }))
  })

  await page.goto('./#/client?id=hcl_zoja&ym=2026-07')
  await page.getByRole('button', { name: 'Aktywuj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Aktywuj klienta historycznego' })
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')

  refreshed = true
  await page.evaluate(() => window.dispatchEvent(new Event('bwm:test-auth-refresh')))

  await expect.poll(() => sessionRequests).toBeGreaterThanOrEqual(2)
  await expect(drawer).toHaveCount(0)
  await expect(page).toHaveURL(/#\/client\?id=hcl_zoja/)
  await expect(page.getByRole('heading', { name: 'Zoja Historyczna' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Aktywuj klienta' })).toHaveCount(0)
  await expect(page.getByRole('alertdialog', { name: 'Niezapisane zmiany' })).toHaveCount(0)
})

for (const viewport of [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 800, height: 900 },
  { name: 'desktop', width: 1280, height: 900 },
]) {
  test(`@owner historical workspace fits ${viewport.name} without losing critical actions`, async ({ page }) => {
    await freezeTime(page, '2026-08-28T08:00:00.000Z')
    await page.setViewportSize(viewport)
    await page.route('**/api/v1/workspace?*', async (route) => {
      const url = new URL(route.request().url())
      await route.fulfill(json(200, { data: workspace(
        url.searchParams.get('from'), url.searchParams.get('to'),
      ) }))
    })

    await page.goto('./#/clients?catalog=historical&historyPeriod=known&ym=2026-07')
    await expect(page.getByRole('table', { name: 'Klienci historyczni' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

    await page.getByRole('link', { name: 'Otwórz historię — Zoja Historyczna' }).click()
    await page.getByRole('button', { name: 'Aktywuj klienta' }).click()
    const drawer = page.getByRole('dialog', { name: 'Aktywuj klienta historycznego' })
    const box = await drawer.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.width).toBeLessThanOrEqual(viewport.width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await drawer.getByRole('button', { name: 'Anuluj' }).click()

    await page.goto('./#/calendar?date=2026-07-15&ym=2026-07&mode=cal')
    await expect(page.getByRole('heading', { name: /Wpisy z nieustalonym dniem/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /Przejrzyj.*okres/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
}

test('@owner operates historical calendar links and the activation guard by keyboard', async ({ page }) => {
  await freezeTime(page, '2026-08-28T08:00:00.000Z')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(json(200, { data: workspace(
      url.searchParams.get('from'), url.searchParams.get('to'),
    ) }))
  })

  await page.goto('./#/calendar?date=2026-07-15&ym=2026-07&mode=cal')
  const selectedDay = page.getByRole('button', { name: /15 lipca — 3 wpisy/ })
  await selectedDay.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('button', { name: /16 lipca — 0 wpisów/ })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(selectedDay).toBeFocused()

  const count = page.locator('[aria-live="polite"]').filter({ hasText: 'wpisy w tym miesiącu' })
  await expect(count).toHaveAttribute('aria-live', 'polite')
  const clientLink = page.getByRole('link', {
    name: 'Otwórz klienta historycznego — Zoja Historyczna',
  }).first()
  await clientLink.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/client\?id=hcl_zoja&ym=2026-07/)
  await expect(page.getByRole('heading', { name: 'Zoja Historyczna' })).toBeVisible()

  await page.getByRole('button', { name: 'Aktywuj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Aktywuj klienta historycznego' })
  const specialistSelect = drawer.getByLabel('Specjalistka prowadząca')
  await expect(specialistSelect).toBeFocused()
  await specialistSelect.selectOption('sp_anna')
  await drawer.getByRole('button', { name: 'Anuluj' }).focus()
  await page.keyboard.press('Tab')
  await expect(drawer.getByRole('button', { name: 'Zamknij' })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(drawer.getByText('Masz niezapisane zmiany.')).toBeVisible()
  await drawer.getByRole('button', { name: 'Wróć' }).click()
  await expect(specialistSelect).toHaveValue('sp_anna')
})
