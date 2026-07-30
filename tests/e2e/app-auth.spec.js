import { test, expect } from '@playwright/test'

const ACTORS = {
  owner: { name: 'Alicja Testowa', role: 'Właściciel' },
  coordinator: { name: 'Celina Testowa', role: 'Koordynator' },
  specialist: { name: 'Zofia Fikcyjna', role: 'Specjalista' },
}

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const errorEnvelope = (status, code) => json(status, {
  error: { code },
})

async function expectAuthenticated(page, projectName) {
  const actor = ACTORS[projectName]
  await expect(page.getByText(actor.name, { exact: true }).first()).toBeVisible()
  await expect(page.getByText(actor.role, { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Środowisko testowe', { exact: true })).toBeVisible()
}

async function expectNoDemoAuth(page) {
  await expect(page.getByLabel('Hasło')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Zaloguj się' })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Tryb demonstracyjny' })).toHaveCount(0)
  await expect(page.getByText('Tryb demonstracyjny', { exact: true })).toHaveCount(0)
}

test('@owner delays the fictional shell behind the loading boundary', async ({ page }) => {
  let releaseSession
  let markRequestSeen
  const requestSeen = new Promise((resolve) => { markRequestSeen = resolve })
  const sessionReleased = new Promise((resolve) => { releaseSession = resolve })

  await page.route('**/api/v1/session', async (route) => {
    markRequestSeen()
    await sessionReleased
    await route.continue()
  })

  await page.goto('.')
  await requestSeen
  await expect(page.getByRole('heading', { name: 'Sprawdzanie dostępu' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Nawigacja główna' })).toHaveCount(0)
  await expectNoDemoAuth(page)

  releaseSession()
  await expectAuthenticated(page, 'owner')
})

for (const [status, code] of [
  [401, 'ACCESS_ASSERTION_INVALID'],
  [403, 'ACCESS_DENIED'],
  [403, 'FORBIDDEN'],
]) {
  test(`@owner classifies session denial ${code}`, async ({ page }) => {
    await page.route('**/api/v1/session', (route) => route.fulfill(errorEnvelope(status, code)))

    await page.goto('.')

    await expect(page.getByRole('heading', { name: 'Brak dostępu do panelu' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Spróbuj ponownie' })).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: 'Nawigacja główna' })).toHaveCount(0)
  })
}

for (const unavailable of [
  {
    name: 'a transport failure',
    respond: (route) => route.abort('connectionfailed'),
  },
  {
    name: 'a malformed success envelope',
    respond: (route) => route.fulfill(json(200, { data: {} })),
  },
  {
    name: 'a malformed error envelope',
    respond: (route) => route.fulfill(errorEnvelope(503, 'ACCESS_DENIED')),
  },
  {
    name: 'an unavailable Access keyset',
    respond: (route) => route.fulfill(errorEnvelope(503, 'ACCESS_KEYSET_UNAVAILABLE')),
  },
  {
    name: 'another server failure',
    respond: (route) => route.fulfill(errorEnvelope(500, 'INTERNAL_ERROR')),
  },
]) {
  test(`@owner classifies ${unavailable.name} as unavailable`, async ({ page }) => {
    let attempts = 0
    await page.route('**/api/v1/session', (route) => {
      attempts += 1
      return unavailable.respond(route)
    })

    await page.goto('.')

    await expect(page.getByRole('heading', { name: 'Nie udało się połączyć z panelem' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Spróbuj ponownie' })).toBeVisible()
    await page.waitForTimeout(200)
    expect(attempts).toBe(1)
  })
}

test('@owner retries only after the explicit command', async ({ page }) => {
  let attempts = 0
  let releaseRetry
  let markRetrySeen
  const retrySeen = new Promise((resolve) => { markRetrySeen = resolve })
  const retryReleased = new Promise((resolve) => { releaseRetry = resolve })

  await page.route('**/api/v1/session', async (route) => {
    attempts += 1
    if (attempts === 1) {
      await route.fulfill(errorEnvelope(503, 'ACCESS_KEYSET_UNAVAILABLE'))
      return
    }
    markRetrySeen()
    await retryReleased
    await route.continue()
  })

  await page.goto('.')
  await expect(page.getByRole('heading', { name: 'Nie udało się połączyć z panelem' })).toBeVisible()
  await page.waitForTimeout(200)
  expect(attempts).toBe(1)

  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await retrySeen
  await expect(page.getByRole('heading', { name: 'Sprawdzanie dostępu' })).toBeVisible()
  releaseRetry()
  await expectAuthenticated(page, 'owner')
  expect(attempts).toBe(2)
})

test('@owner refreshes in place and replaces subscribed session authority', async ({ page }) => {
  await page.goto('.')
  await expectAuthenticated(page, 'owner')
  await page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Ustawienia' })
    .click()
  const reduceMotion = page.getByRole('switch', { name: 'Ogranicz animacje' })
  await expect(reduceMotion).toHaveAttribute('aria-checked', 'false')
  await reduceMotion.click()
  await expect(reduceMotion).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('Ogranicz animacje — włączone', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cofnij' })).toBeVisible()

  let releaseRefresh
  let markRefreshSeen
  const refreshSeen = new Promise((resolve) => { markRefreshSeen = resolve })
  const refreshReleased = new Promise((resolve) => { releaseRefresh = resolve })
  const csrfExpiresAt = '2030-01-01T00:00:00.000Z'
  const csrfExpiresUnix = Date.parse(csrfExpiresAt) / 1000
  await page.route('**/api/v1/session', async (route) => {
    markRefreshSeen()
    await refreshReleased
    await route.fulfill(json(200, {
      data: {
        actor: {
          id: 'stf_refreshed_specialist',
          displayName: 'Renata Odświeżona',
          role: 'specialist',
          specialistId: 'sp_refreshed_specialist',
        },
        capabilities: ['appointment.manage', 'payment.manage'],
        csrfExpiresAt,
        csrfToken: `v1.${csrfExpiresUnix}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
        dataMode: 'fictional',
        environment: 'development',
      },
    }))
  })

  await page.evaluate(() => {
    window.dispatchEvent(new Event('bwm:test-auth-refresh'))
  })
  await refreshSeen
  await expect(page.locator('.shell')).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByText('Alicja Testowa', { exact: true }).first()).toBeVisible()
  await expect(reduceMotion).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('button', { name: 'Cofnij' })).toBeVisible()

  releaseRefresh()
  await expect(page.getByText('Renata Odświeżona', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Specjalista', { exact: true }).first()).toBeVisible()
  await expect(page.locator('.shell')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('switch', { name: 'Ogranicz animacje' }))
    .toHaveAttribute('aria-checked', 'false')
  await expect(page.getByText('Ogranicz animacje — włączone', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cofnij' })).toHaveCount(0)
  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  await expect(navigation.getByRole('link', { name: 'Finanse', exact: true })).toBeVisible()
  await expect(navigation.getByRole('link', { name: 'Raporty', exact: true })).toHaveCount(0)
  await expect(navigation.getByRole('link', { name: 'Zespół', exact: true })).toHaveCount(0)
})

test('@owner keeps a newer denied notification authoritative over a stale request failure', async ({ page }) => {
  await page.goto('.')
  await expectAuthenticated(page, 'owner')

  let releaseRefresh
  let markRefreshSeen
  const refreshSeen = new Promise((resolve) => { markRefreshSeen = resolve })
  const refreshReleased = new Promise((resolve) => { releaseRefresh = resolve })
  await page.route('**/api/v1/session', async (route) => {
    markRefreshSeen()
    await refreshReleased
    await route.abort('connectionfailed')
  })

  await page.evaluate(() => {
    window.dispatchEvent(new Event('bwm:test-auth-refresh'))
  })
  await refreshSeen
  await expect(page.locator('.shell')).toHaveAttribute('aria-busy', 'true')

  await page.evaluate(async (modulePath) => {
    const { apiClient } = await import(modulePath)
    apiClient.clearSession()
  }, `/@fs${process.cwd()}/src/api.js`)
  await expect(page.getByRole('heading', { name: 'Brak dostępu do panelu' })).toBeVisible()

  const failed = page.waitForEvent('requestfailed', (request) => (
    new URL(request.url()).pathname === '/api/v1/session'
  ))
  releaseRefresh()
  await failed
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  }))

  await expect(page.getByRole('heading', { name: 'Brak dostępu do panelu' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Nie udało się połączyć z panelem' })).toHaveCount(0)
})

test('@owner constrains a max-length authenticated identity at shell breakpoints', async ({ page }) => {
  const displayName = 'A'.repeat(120)
  const csrfExpiresAt = '2030-01-01T00:00:00.000Z'
  const csrfExpiresUnix = Date.parse(csrfExpiresAt) / 1000
  await page.route('**/api/v1/session', (route) => route.fulfill(json(200, {
    data: {
      actor: {
        id: 'stf_max_name_owner',
        displayName,
        role: 'owner',
        specialistId: null,
      },
      capabilities: ['appointment.manage', 'staff.manage'],
      csrfExpiresAt,
      csrfToken: `v1.${csrfExpiresUnix}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      dataMode: 'fictional',
      environment: 'development',
    },
  })))

  await page.setViewportSize({ width: 641, height: 800 })
  await page.goto('.')

  for (const width of [641, 1025]) {
    await page.setViewportSize({ width, height: 800 })
    const identity = page.locator('.userchip--authenticated')
    const name = identity.locator('.userchip__name')
    await expect(identity).toBeVisible()
    await expect(name).toHaveText(displayName)
    await expect(page.getByRole('button', { name: 'Wyloguj się' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Panel dnia:/ })).toBeVisible()

    const geometry = await page.evaluate(() => {
      const chip = document.querySelector('.userchip--authenticated')
      const name = chip.querySelector('.userchip__name')
      const topbar = document.querySelector('.topbar')
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        nameTruncated: name.scrollWidth > name.clientWidth,
        topbarOverflow: topbar.scrollWidth - topbar.clientWidth,
      }
    })
    expect(geometry.documentOverflow).toBeLessThanOrEqual(0)
    expect(geometry.topbarOverflow).toBeLessThanOrEqual(0)
    expect(geometry.nameTruncated).toBe(true)
  }
})

test('@owner renders immutable identity and keeps browser application storage empty', async ({ page }) => {
  const clientErrors = []
  const requests = []
  page.on('console', (message) => {
    if (message.type() === 'error') clientErrors.push(message.text())
  })
  page.on('pageerror', (error) => clientErrors.push(error.message))
  page.on('request', (request) => {
    requests.push({
      authorization: request.headers().authorization,
      resourceType: request.resourceType(),
      url: request.url(),
    })
  })

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('.')
  await expectAuthenticated(page, 'owner')
  await expectNoDemoAuth(page)

  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  await navigation.getByRole('link', { name: 'Ustawienia' }).click()
  await expect(page.getByRole('heading', { name: 'Twoje konto' })).toBeVisible()
  const account = page.locator('.settings-account-identity')
  await expect(account).toContainText('Alicja Testowa')
  await expect(account).toContainText('Właściciel')
  await expect(account.getByRole('textbox')).toHaveCount(0)
  await expect(account).not.toContainText('@')
  await expect(page.getByRole('button', { name: 'Zapisz konto' })).toHaveCount(0)

  await page.reload()
  await expectAuthenticated(page, 'owner')
  const storage = await page.evaluate(async () => ({
    cacheKeys: await caches.keys(),
    databases: typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [],
    localStorage: Object.keys(localStorage),
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).map(({ scope }) => scope),
    sessionStorage: Object.keys(sessionStorage),
  }))

  expect(storage).toEqual({
    cacheKeys: [],
    databases: [],
    localStorage: [],
    serviceWorkers: [],
    sessionStorage: [],
  })
  expect(requests.filter(({ url }) => {
    const target = new URL(url)
    return target.protocol === 'http:' && target.hostname !== '127.0.0.1'
  })).toEqual([])
  expect(requests.filter(({ authorization }) => authorization !== undefined)).toEqual([])
  expect(clientErrors).toEqual([])
})

test('@owner logs out through an Access document navigation', async ({ page }) => {
  const logoutRequests = []
  await page.route('**/cdn-cgi/access/logout', async (route) => {
    logoutRequests.push({
      method: route.request().method(),
      resourceType: route.request().resourceType(),
      url: route.request().url(),
    })
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Access logout</title>',
    })
  })
  await page.goto('.')
  await expectAuthenticated(page, 'owner')

  await page.getByRole('button', { name: 'Wyloguj się' }).click()
  await expect(page).toHaveURL('http://127.0.0.1:5174/cdn-cgi/access/logout')

  expect(logoutRequests).toEqual([{
    method: 'GET',
    resourceType: 'document',
    url: 'http://127.0.0.1:5174/cdn-cgi/access/logout',
  }])
})

test('@coordinator keeps authenticated identity and gains Reports on tablet', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto('.')
  await expectAuthenticated(page, 'coordinator')
  await expectNoDemoAuth(page)

  await page.getByRole('button', { name: 'Otwórz menu' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  await expect(drawer.getByRole('link', { name: 'Raporty', exact: true })).toBeVisible()
  await expect(drawer.getByRole('group', { name: 'Tryb demonstracyjny' })).toHaveCount(0)
  await drawer.getByRole('link', { name: 'Raporty', exact: true }).click()
  await expect(page.locator('.topbar__title b')).toHaveText('Raporty')

  await page.evaluate(() => { window.location.hash = '#/team' })
  await expect(page.locator('.topbar__title b')).toHaveText('Dziś')
})

test('@specialist keeps authenticated identity, gains Finances, and stays fictionally empty on phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('.')
  await expect(page.getByText('Środowisko testowe', { exact: true })).toBeVisible()
  await expectNoDemoAuth(page)

  const bottomNavigation = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  await bottomNavigation.getByRole('button', { name: 'Menu', exact: true }).click()
  let drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  await expect(drawer.getByText('Zofia Fikcyjna', { exact: true })).toBeVisible()
  await expect(drawer.getByText('Specjalista', { exact: true })).toBeVisible()
  await expect(drawer.getByRole('group', { name: 'Tryb demonstracyjny' })).toHaveCount(0)
  await expect(drawer.getByRole('button', { name: 'Wyloguj się' })).toBeVisible()
  await expect(drawer.getByRole('link', { name: 'Finanse', exact: true })).toBeVisible()

  await drawer.getByRole('link', { name: 'Klienci', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.getByText('Kartoteka jest jeszcze pusta', { exact: true })).toBeVisible()

  await bottomNavigation.getByRole('button', { name: 'Menu', exact: true }).click()
  drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  const financesLink = drawer.getByRole('link', { name: 'Finanse', exact: true })
  await expect(financesLink).toBeVisible()
  await financesLink.click()
  await expect(page.locator('.topbar__title b')).toHaveText('Finanse')
  await expect(page.getByText('Brak rozliczeń specjalisty', { exact: true })).toBeVisible()
  await expect(page.locator('.finance-ledger, .figures, table')).toHaveCount(0)
  for (const fictionalIdentity of [
    'Anna Maria Janowska',
    'Justyna Jarosz-Jarszewska',
    'Zofia Mazur',
    'Antoni Krawczyk',
  ]) {
    await expect(page.getByText(fictionalIdentity, { exact: true })).toHaveCount(0)
  }

  await page.evaluate(() => { window.location.hash = '#/reports' })
  await expect(page.locator('.topbar__title b')).toHaveText('Dziś')
})
