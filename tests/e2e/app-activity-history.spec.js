import { expect, test } from '@playwright/test'

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: body }) })
const csrfToken = `v1.${Date.parse('2030-01-01T00:00:00.000Z') / 1000}.${'A'.repeat(22)}.${'B'.repeat(43)}`
const nextCursor = `v1.1.A.${'B'.repeat(43)}`

const session = (role, capabilities, authorityRevision = 1) => json({
  actor: {
    id: `stf_history_${role}`,
    displayName: role === 'owner' ? 'Alicja Historia' : role === 'coordinator' ? 'Celina Historia' : 'Zofia Historia',
    email: `${role}@example.test`,
    professionalTitle: role === 'specialist' ? 'Psycholożka' : null,
    role,
    specialistId: role === 'specialist' ? 'sp_history_specialist' : null,
    version: 1,
  },
  authorityRevision,
  capabilities: role === 'owner' ? ['activity.read', 'permissions.manage'] : capabilities,
  csrfExpiresAt: '2030-01-01T00:00:00.000Z',
  csrfToken,
  dataMode: 'fictional',
  environment: 'development',
})

const filters = {
  actors: [{ id: 'stf_anna', label: 'Anna Kowalska' }],
  clients: [{ id: 'cl_ola', label: 'Ola Nowak' }],
}

const entry = (overrides = {}) => ({
  id: 'aud_1',
  occurredAt: '2026-09-22T08:15:00.000Z',
  kind: 'appointment',
  actorName: 'Anna Kowalska',
  clientName: 'Ola Nowak',
  summary: 'Zmieniono sesję',
  details: [{ field: 'Status', before: 'Zaplanowana', after: 'Odbyta' }],
  ...overrides,
})

test('@owner @coordinator filters, retries and continues the readable activity history', async ({ page }, testInfo) => {
  const role = testInfo.project.name
  let failInitialRead = true
  let failContinuationRead = true
  const requested = []
  await page.route('**/api/v1/session', (route) => route.fulfill(session(role, ['activity.read'])))
  await page.route('**/api/v1/activity?*', async (route) => {
    const query = new URL(route.request().url()).searchParams
    requested.push(Object.fromEntries(query))
    if (!query.get('cursor') && !query.get('actor') && !query.get('client') && !query.get('kind')) {
      if (failInitialRead) return route.abort('connectionfailed')
      return route.fulfill(json({ items: [entry()], nextCursor, filters }))
    }
    if (query.get('cursor') === nextCursor) {
      if (failContinuationRead) return route.abort('connectionfailed')
      return route.fulfill(json({
        items: [entry({ id: 'aud_2', occurredAt: '2026-09-21T08:15:00.000Z', kind: 'client', summary: 'Dodano klienta', details: [] })],
        nextCursor: null,
        filters,
      }))
    }
    return route.fulfill(json({
      items: [entry({ id: 'aud_filtered', kind: 'client', summary: 'Zmieniono dane klienta' })],
      nextCursor: null,
      filters,
    }))
  })

  await page.goto('./#/history')
  await expect(page.getByRole('heading', { name: 'Historia aktywności' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('group', { name: 'Centrum' })
    .getByRole('link', { name: 'Historia aktywności', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Nie udało się wczytać historii aktywności')
  failInitialRead = false
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()

  const history = page.locator('.activity-history')
  await expect(history).toContainText('Anna Kowalska')
  await expect(history.getByText('Status', { exact: true })).toBeVisible()
  await expect(history.getByText('Zaplanowana → Odbyta', { exact: true })).toBeVisible()
  await expect(history.getByText(/aud_|stf_|cl_/)).toHaveCount(0)

  await page.getByRole('button', { name: 'Pokaż więcej' }).click()
  await expect(page.getByRole('alert')).toContainText('Nie udało się wczytać kolejnych wpisów')
  failContinuationRead = false
  await expect(history).toContainText('Zmieniono sesję')
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect(history).toContainText('Dodano klienta')

  await page.getByRole('combobox', { name: 'Osoba', exact: true }).selectOption('stf_anna')
  await page.getByRole('combobox', { name: 'Klient', exact: true }).selectOption('cl_ola')
  await page.getByRole('combobox', { name: 'Rodzaj', exact: true }).selectOption('client')
  await expect(page).toHaveURL(/#\/history\?actor=stf_anna&client=cl_ola&kind=client$/)
  await expect(history).toContainText('Zmieniono dane klienta')
  expect(requested.some((query) => query.actor === 'stf_anna' && query.client === 'cl_ola' && query.kind === 'client')).toBe(true)
  await page.getByLabel('Od', { exact: true }).fill('2026-09-01')
  await page.getByLabel('Do', { exact: true }).fill('2026-09-22')
  await expect(page).toHaveURL(/from=2026-09-01&kind=client&to=2026-09-22$/)
  await expect(history).toContainText('Zmieniono dane klienta')
  expect(requested.some((query) => query.from === '2026-09-01' && query.to === '2026-09-22')).toBe(true)

  await page.getByRole('button', { name: 'Wyczyść filtry' }).click()
  await expect(page).toHaveURL(/#\/history$/)
  await expect(page.getByRole('combobox', { name: 'Osoba', exact: true })).toHaveValue('')
  if (role === 'owner') {
    await expect(history).toContainText('Zmieniono sesję')
    await page.screenshot({ path: testInfo.outputPath('history-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Filtry', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Osoba', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('history-mobile.png'), fullPage: true })
  }
  await page.goto('./#/history?actor=stf_anna')
  if (role === 'owner') await page.getByRole('button', { name: 'Filtry · 1', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Osoba', exact: true })).toHaveValue('stf_anna')
  await page.getByRole('button', { name: 'Wyczyść filtry' }).click()
  await expect(page).toHaveURL(/#\/history$/)
  await expect(page.getByRole('combobox', { name: 'Osoba', exact: true })).toHaveValue('')
})

test('@owner drops an older filtered response after a newer filter changes', async ({ page }) => {
  let resolveOlderRequest
  await page.route('**/api/v1/session', (route) => route.fulfill(session('owner', ['activity.read'])))
  await page.route('**/api/v1/activity?*', async (route) => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('actor') === 'stf_anna' && !query.get('kind')) {
      await new Promise((resolve) => { resolveOlderRequest = resolve })
      try {
        await route.fulfill(json({
          items: [entry({ id: 'aud_old', kind: 'client', summary: 'Dodano klienta' })], nextCursor: null, filters,
        }))
      } catch { /* The newer filter aborts this request. */ }
      return
    }
    const current = query.get('kind') === 'client'
      ? [entry({ id: 'aud_current', kind: 'client', summary: 'Zmieniono dane klienta' })]
      : [entry()]
    await route.fulfill(json({ items: current, nextCursor: null, filters }))
  })

  await page.goto('./#/history')
  await expect(page.locator('.activity-history')).toContainText('Zmieniono sesję')
  const olderRequest = page.waitForRequest((request) => new URL(request.url()).searchParams.get('actor') === 'stf_anna')
  await page.getByRole('combobox', { name: 'Osoba', exact: true }).selectOption('stf_anna')
  await olderRequest
  await page.getByRole('combobox', { name: 'Rodzaj', exact: true }).selectOption('client')
  await expect(page.locator('.activity-history')).toContainText('Zmieniono dane klienta')
  resolveOlderRequest?.()
  await expect(page.locator('.activity-history')).not.toContainText('Dodano klienta')
})

test('@specialist does not expose or request activity history', async ({ page }) => {
  const requests = []
  await page.route('**/api/v1/session', (route) => route.fulfill(session('specialist', [])))
  page.on('request', (request) => requests.push(new URL(request.url()).pathname))

  await page.goto('./#/history')
  await expect(page.getByRole('heading', { name: 'Mój profil' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Historia aktywności', exact: true })).toHaveCount(0)
  await expect(page.getByText('Historia aktywności', { exact: true })).toHaveCount(0)
  expect(requests).not.toContain('/api/v1/activity')
})
