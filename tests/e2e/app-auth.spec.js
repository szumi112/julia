import { test, expect } from '@playwright/test'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const ACTORS = {
  owner: { name: 'Alicja Testowa', role: 'Właściciel' },
  coordinator: { name: 'Celina Testowa', role: 'Koordynator' },
  specialist: { name: 'Zofia Fikcyjna', role: 'Specjalistka' },
}

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const errorEnvelope = (status, code) => json(status, {
  error: { code },
})

const sessionEnvelope = ({
  actor = {
    id: 'stf_capability_owner',
    displayName: 'Alicja Testowa',
    professionalTitle: null,
    role: 'owner',
    specialistId: null,
    version: 1,
  },
  authorityRevision = 1,
  capabilities = ['appointment.manage'],
  environment = 'development',
} = {}) => {
  const csrfExpiresAt = '2030-01-01T00:00:00.000Z'
  const csrfExpiresUnix = Date.parse(csrfExpiresAt) / 1000
  return json(200, {
    data: {
      actor,
      authorityRevision,
      capabilities,
      csrfExpiresAt,
      csrfToken: `v1.${csrfExpiresUnix}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      dataMode: 'fictional',
      environment,
    },
  })
}

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

async function openSettings(page) {
  await page.goto('.')
  await expectAuthenticated(page, 'owner')
  await page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Ustawienia' })
    .click()
}

async function fillStaffInvitation(page, {
  displayName,
  email,
  role = 'Koordynator',
}) {
  await page.getByRole('button', { name: 'Zaproś osobę' }).click()
  const drawer = page.getByRole('dialog', { name: 'Zaproś osobę' })
  await drawer.getByLabel('Imię i nazwisko').fill(displayName)
  await drawer.getByLabel('Adres e-mail').fill(email)
  await drawer.getByLabel('Rola').selectOption({ label: role })
  return drawer
}

async function expectStaffModalOwnsShell(page, modal) {
  await expect(modal).toBeVisible()
  expect.soft(await modal.evaluate((element) => element.matches(':modal'))).toBe(true)

  const shellLink = page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Dziś', exact: true })
  expect(await shellLink.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    )
    return hit !== element && !element.contains(hit)
  })).toBe(true)
  await shellLink.evaluate((element) => element.focus())
  expect.soft(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true)

  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  for (const shortcut of ['Control+K', 'Meta+K']) {
    await page.keyboard.press(shortcut)
    await expect.soft(palette).toHaveCount(0)
    if (await palette.count()) {
      await page.keyboard.press('Escape')
      await expect(palette).toHaveCount(0)
    }
  }
}

const detachedFocusStaff = {
  id: 'stf_focus_target',
  displayName: 'Felicja Fokusowa',
  email: 'focus-target@example.test',
  role: 'coordinator',
  status: 'active',
  version: 1,
  specialistId: null,
  invitation: null,
}

const roleChangeStaff = {
  id: 'stf_role_target',
  displayName: 'Roksana Rolowa',
  email: 'role-target@example.test',
  role: 'coordinator',
  status: 'active',
  version: 3,
  specialistId: null,
  invitation: null,
}
const roleChangeResult = (overrides = {}) => {
  const { invitation: _invitation, ...person } = roleChangeStaff
  return { ...person, role: 'owner', version: 4, ...overrides }
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

test('@owner presents a linked owner as an ordinary specialist without losing owner navigation', async ({ page }) => {
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.actor = {
      ...body.data.actor,
      displayName: 'Julia Wolanin',
      professionalTitle: 'Specjalistka',
      specialistId: 'sp_julia',
    }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.specialists = [
      ...body.data.specialists,
      {
        id: 'sp_julia',
        displayName: 'Julia Wolanin',
        professionalTitle: 'Specjalistka',
        standardRateGrosze: 18_000,
        status: 'active',
        version: 1,
        staffVersion: 1,
        accessStatus: 'enabled',
      },
    ].toSorted((left, right) => left.displayName.localeCompare(right.displayName, 'pl')
      || left.id.localeCompare(right.id))
    await route.fulfill({ response, json: body })
  })

  await page.goto('.')

  const account = page.locator('.userchip').first()
  await expect(account).toContainText('Julia Wolanin')
  await expect(account).toContainText('Specjalistka')
  await expect(account).not.toContainText('Właściciel')
  await expect(page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Zespół' })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('navigation', { name: 'Nawigacja dolna' })
    .getByRole('button', { name: 'Menu', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  const mobileAccount = drawer.locator('.mobile-account__identity')
  await expect(mobileAccount).toContainText('Julia Wolanin')
  await expect(mobileAccount).toContainText('Specjalistka')
  await expect(mobileAccount).not.toContainText('Właściciel')

  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 844 })
  await page.goto('./#/team')
  const julia = page.locator('article').filter({ hasText: 'Julia Wolanin' })
  await expect(julia).toContainText('Specjalistka')
  await expect(julia).not.toContainText('Właściciel')

  await page.goto('./#/settings')
  const settingsIdentity = page.locator('.settings-account-identity')
  await expect(settingsIdentity).toContainText('Julia Wolanin')
  await expect(settingsIdentity).toContainText('Specjalistka')
  await expect(settingsIdentity).not.toContainText('Właściciel')
})

for (const [status, code] of [
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

for (const [status, code] of [
  [401, 'ACCESS_ASSERTION_INVALID'],
  [401, 'REAUTH_REQUIRED'],
]) {
  test(`@owner classifies a stale session as reauth for ${code}`, async ({ page }) => {
    await page.route('**/api/v1/session', (route) => route.fulfill(errorEnvelope(status, code)))

    await page.goto('.')

    await expect(page.getByRole('heading', { name: 'Sesja wygasła' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Zaloguj się ponownie' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Brak dostępu do panelu' })).toHaveCount(0)
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
          professionalTitle: 'Specjalistka',
          role: 'specialist',
          specialistId: 'sp_refreshed_specialist',
          version: 1,
        },
        authorityRevision: 2,
        capabilities: [
          'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
          'client.manage', 'client.operational.read', 'clinical.read', 'payment.manage',
          'specialist.directory.read', 'tus.manage',
        ],
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

  releaseRefresh()
  await expect(page.getByText('Renata Odświeżona', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Specjalistka', { exact: true }).first()).toBeVisible()
  await expect(page.locator('.shell')).toHaveAttribute('aria-busy', 'false')
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
        professionalTitle: null,
        role: 'owner',
        specialistId: null,
        version: 1,
      },
      authorityRevision: 1,
      capabilities: [
        'appointment.charge.read', 'appointment.manage', 'centre.manage', 'chat.direct',
        'chat.general', 'client.manage', 'client.operational.read', 'clinical.read',
        'finance.centre.manage', 'finance.centre.read', 'operations.health.read', 'payment.manage',
        'permissions.manage',
        'security.audit.read', 'specialist.directory.read', 'staff.manage', 'tus.manage',
      ],
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
  await page.route('**/api/v1/operations/health', (route) => route.fulfill(json(200, {
    data: {
      generatedAt: '2026-07-31T08:20:00.000Z',
      checks: [
        {
          id: 'outbox.processing',
          label: 'Kolejka zadań',
          status: 'ok',
          lastSuccessAt: '2026-07-31T08:15:00.000Z',
          detailCode: 'OUTBOX_HEALTHY',
        },
        {
          id: 'backup.freshness',
          label: 'Kopie zapasowe',
          status: 'warning',
          lastSuccessAt: null,
          detailCode: 'BACKUP_PENDING',
        },
        {
          id: 'access.reconciliation',
          label: 'Synchronizacja dostępu',
          status: 'critical',
          lastSuccessAt: '2026-07-31T08:05:00.000Z',
          detailCode: 'ACCESS_RECONCILIATION_LAG',
        },
        {
          id: 'scheduler.runs',
          label: 'Zadania cykliczne',
          status: 'ok',
          lastSuccessAt: '2026-07-31T08:12:00.000Z',
          detailCode: 'SCHEDULER_HEALTHY',
        },
      ],
    },
  })))

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('.')
  await expectAuthenticated(page, 'owner')
  await expectNoDemoAuth(page)

  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  await navigation.getByRole('link', { name: 'Ustawienia' }).click()
  await expect(page.getByRole('heading', { name: 'Twoje konto' })).toBeVisible()
  const account = page.locator('.settings-account-identity')
  await expect(account).toContainText('Alicja Testowa')
  await expect(account).toContainText('Konto centrum')
  await expect(account).not.toContainText('Właściciel')
  await expect(account).toContainText('jednorazowym kodem e-mail')
  await expect(account).toContainText('panel nie przechowuje hasła')
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

test('@owner staff access lists the server-ordered fictional directory', async ({ page }) => {
  await openSettings(page)

  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toBeVisible()
  await expect(page.locator('.staff-access-row__name')).toHaveText([
    'Alicja Testowa',
    'Celina Testowa',
    'Zofia Fikcyjna',
  ])
  await expect(page.getByText('owner@example.test', { exact: true })).toBeVisible()
  await expect(page.getByText('coordinator@example.test', { exact: true })).toBeVisible()
  await expect(page.getByText('specialist@example.test', { exact: true })).toBeVisible()
})

test('@owner staff invitation form keeps the approved role order', async ({ page }) => {
  await openSettings(page)
  await page.getByRole('button', { name: 'Zaproś osobę' }).click()

  const drawer = page.getByRole('dialog', { name: 'Zaproś osobę' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByLabel('Rola').locator('option')).toHaveText([
    'Koordynator',
    'Specjalista',
    'Właściciel',
  ])
})

test('@owner staff invitation is a native modal that owns the shell shortcuts', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openSettings(page)
  await page.getByRole('button', { name: 'Zaproś osobę' }).click()

  const drawer = page.getByRole('dialog', { name: 'Zaproś osobę' })
  await expectStaffModalOwnsShell(page, drawer)
})

test('@owner changes a staff role with optimistic data and refreshes session authority', async ({ page }) => {
  let changed = false
  let sessionRequests = 0
  const roleRequests = []
  await page.route('**/api/v1/session', (route) => {
    sessionRequests += 1
    return route.fulfill(sessionEnvelope({
      authorityRevision: sessionRequests > 1 ? 2 : 1,
      capabilities: ROLE_DEFAULT_CAPABILITIES.owner,
    }))
  })
  await page.route('**/api/v1/staff', (route) => route.fulfill(json(200, {
    data: {
      staff: [{
        ...roleChangeStaff,
        role: changed ? 'owner' : roleChangeStaff.role,
        version: changed ? roleChangeStaff.version + 1 : roleChangeStaff.version,
      }],
    },
  })))
  await page.route('**/api/v1/staff/*/role', async (route) => {
    roleRequests.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
      url: route.request().url(),
    })
    changed = true
    await route.fulfill(json(200, {
      data: {
        staff: {
          ...roleChangeResult(),
        },
      },
    }))
  })
  await openSettings(page)
  const row = page.locator('.staff-access-row').filter({ hasText: roleChangeStaff.displayName })

  await row.getByRole('button', { name: `Zmień rolę — ${roleChangeStaff.displayName}` }).click()
  const drawer = page.getByRole('dialog', { name: `Zmień rolę — ${roleChangeStaff.displayName}` })
  await drawer.getByLabel('Rola').selectOption('owner')
  await drawer.getByRole('button', { name: 'Zapisz rolę' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(row).toContainText('Właściciel')
  await expect.poll(() => sessionRequests).toBeGreaterThanOrEqual(2)
  expect(roleRequests).toHaveLength(2)
  expect(roleRequests[1]).toEqual(roleRequests[0])
  expect(new URL(roleRequests[0].url).pathname).toBe('/api/v1/staff/stf_role_target/role')
  expect(new URL(roleRequests[0].url).search).toBe('')
  expect(JSON.parse(roleRequests[0].body)).toEqual({ expectedVersion: 3, role: 'owner' })
  expect(roleRequests[0].key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/)
})

test('@owner role editor guards its draft and restores focus safely', async ({ page }) => {
  await page.route('**/api/v1/staff', (route) => route.fulfill(json(200, {
    data: { staff: [roleChangeStaff] },
  })))
  await openSettings(page)
  const opener = page.getByRole('button', { name: `Zmień rolę — ${roleChangeStaff.displayName}` })
  await opener.click()
  const drawer = page.getByRole('dialog', { name: `Zmień rolę — ${roleChangeStaff.displayName}` })

  await expect(drawer.getByLabel('Rola')).toHaveValue('coordinator')
  await drawer.getByLabel('Rola').selectOption('specialist')
  await drawer.getByRole('button', { name: 'Zamknij' }).click()
  await expect(drawer.getByText('Masz niezapisane zmiany.', { exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: 'Wróć' }).click()
  await expect(drawer.getByLabel('Rola')).toHaveValue('specialist')
  await drawer.getByRole('button', { name: 'Zamknij' }).click()
  await drawer.getByRole('button', { name: 'Odrzuć' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('@owner retries role authority uncertainty with the exact original action', async ({ page }) => {
  let sessionRequests = 0
  const attempts = []
  await page.route('**/api/v1/session', async (route) => {
    sessionRequests += 1
    if (sessionRequests === 2) {
      await route.abort('connectionfailed')
      return
    }
    await route.fulfill(sessionEnvelope({
      authorityRevision: sessionRequests > 2 ? 2 : 1,
      capabilities: ROLE_DEFAULT_CAPABILITIES.owner,
    }))
  })
  await page.route('**/api/v1/staff', (route) => route.fulfill(json(200, {
    data: { staff: [roleChangeStaff] },
  })))
  await page.route('**/api/v1/staff/*/role', (route) => {
    attempts.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
    })
    return route.fulfill(json(200, {
      data: { staff: roleChangeResult() },
    }))
  })
  await openSettings(page)
  await page.getByRole('button', { name: `Zmień rolę — ${roleChangeStaff.displayName}` }).click()
  const drawer = page.getByRole('dialog', { name: `Zmień rolę — ${roleChangeStaff.displayName}` })
  await drawer.getByLabel('Rola').selectOption('owner')

  await drawer.getByRole('button', { name: 'Zapisz rolę' }).click()
  await expect(drawer.getByRole('button', { name: 'Spróbuj ponownie' })).toBeVisible()
  await drawer.getByRole('button', { name: 'Spróbuj ponownie' }).click()

  await expect(drawer).toHaveCount(0)
  expect(attempts).toHaveLength(3)
  expect(attempts[1]).toEqual(attempts[0])
  expect(attempts[2]).toEqual(attempts[0])
})

test('@owner handles role conflict, last-owner, and forbidden responses without raw codes', async ({ page }) => {
  let responseCode = 'VERSION_CONFLICT'
  let listRequests = 0
  await page.route('**/api/v1/staff', (route) => {
    listRequests += 1
    return route.fulfill(json(200, { data: { staff: [roleChangeStaff] } }))
  })
  await page.route('**/api/v1/staff/*/role', (route) => {
    const status = responseCode === 'FORBIDDEN' ? 403 : 409
    return route.fulfill(errorEnvelope(status, responseCode))
  })
  await openSettings(page)
  const openRole = () => page.getByRole('button', {
    name: `Zmień rolę — ${roleChangeStaff.displayName}`,
  }).click()

  await openRole()
  let drawer = page.getByRole('dialog', { name: `Zmień rolę — ${roleChangeStaff.displayName}` })
  await drawer.getByLabel('Rola').selectOption('owner')
  const beforeConflict = listRequests
  await drawer.getByRole('button', { name: 'Zapisz rolę' }).click()
  await expect(drawer).toHaveCount(0)
  await expect.poll(() => listRequests).toBeGreaterThan(beforeConflict)
  await expect(page.getByText('Lista personelu została odświeżona.', { exact: true })).toBeVisible()

  responseCode = 'LAST_ACTIVE_OWNER'
  await openRole()
  drawer = page.getByRole('dialog', { name: `Zmień rolę — ${roleChangeStaff.displayName}` })
  await drawer.getByLabel('Rola').selectOption('owner')
  await drawer.getByRole('button', { name: 'Zapisz rolę' }).click()
  await expect(drawer.getByText(
    'Nie można zmienić roli ostatniego aktywnego właściciela.',
    { exact: true },
  )).toBeVisible()
  await expect(drawer).not.toContainText('LAST_ACTIVE_OWNER')
  await drawer.getByRole('button', { name: 'Anuluj' }).click()
  await drawer.getByRole('button', { name: 'Odrzuć' }).click()

  responseCode = 'FORBIDDEN'
  await openRole()
  drawer = page.getByRole('dialog', { name: `Zmień rolę — ${roleChangeStaff.displayName}` })
  await drawer.getByLabel('Rola').selectOption('owner')
  await drawer.getByRole('button', { name: 'Zapisz rolę' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.locator('.staff-access-row')).toHaveCount(0)
  await expect(page.getByText('Nie udało się pobrać listy personelu.', { exact: true })).toBeVisible()
})

test('@owner rejects an invalid staff email inline without a request', async ({ page }) => {
  let invitationRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/v1/staff/invitations') {
      invitationRequests += 1
    }
  })
  await openSettings(page)
  await page.getByRole('button', { name: 'Zaproś osobę' }).click()

  const drawer = page.getByRole('dialog', { name: 'Zaproś osobę' })
  await drawer.getByLabel('Imię i nazwisko').fill('Iga Testowa')
  await drawer.getByLabel('Adres e-mail').fill('niepoprawny-adres')
  await drawer.getByRole('button', { name: 'Wyślij zaproszenie' }).click()

  await expect(drawer.getByText('Podaj poprawny adres e-mail', { exact: true })).toBeVisible()
  expect(invitationRequests).toBe(0)
})

test('@owner submits a live team address in fictional staging', async ({ page }) => {
  const invitationRequests = []
  await page.route('**/api/v1/session', (route) => route.fulfill(sessionEnvelope({
    capabilities: ROLE_DEFAULT_CAPABILITIES.owner,
    environment: 'staging',
  })))
  await page.route('**/api/v1/staff/invitations', async (route) => {
    invitationRequests.push(route.request().postDataJSON())
    await route.fulfill(json(201, {
      data: {
        staff: {
          id: 'stf_live_staging',
          displayName: 'Staging Team Member',
          email: 'team.member@qa.invalid',
          role: 'coordinator',
          status: 'pending',
          version: 1,
          specialistId: null,
        },
        invitation: {
          id: 'inv_live_staging',
          status: 'provisioning',
          expiresAt: '2030-01-02T00:00:00.000Z',
          emailSentAt: null,
          version: 1,
        },
      },
    }))
  })
  await openSettings(page)
  const drawer = await fillStaffInvitation(page, {
    displayName: 'Staging Team Member',
    email: 'team.member@qa.invalid',
  })

  await expect(drawer.getByText(
    'Na ten adres wyślemy zaproszenie do chronionego panelu.',
    { exact: true },
  )).toBeVisible()
  await drawer.getByRole('button', { name: 'Wyślij zaproszenie' }).click()

  await expect(drawer).toHaveCount(0)
  expect(invitationRequests).toEqual([{
    displayName: 'Staging Team Member',
    email: 'team.member@qa.invalid',
    role: 'coordinator',
  }])
})

test('@owner distinguishes queued invitation mail from provider acceptance', async ({ page }) => {
  await page.route('**/api/v1/staff', (route) => route.fulfill(json(200, {
    data: {
      staff: [
        {
          id: 'stf_mail_queued',
          displayName: 'Mail Queued',
          email: 'mail.queued@example.test',
          role: 'coordinator',
          status: 'pending',
          version: 1,
          specialistId: null,
          invitation: {
            id: 'inv_mail_queued',
            status: 'pending',
            expiresAt: '2030-01-02T00:00:00.000Z',
            emailSentAt: null,
            version: 2,
          },
        },
        {
          id: 'stf_mail_accepted',
          displayName: 'Mail Accepted',
          email: 'mail.accepted@example.test',
          role: 'coordinator',
          status: 'pending',
          version: 1,
          specialistId: null,
          invitation: {
            id: 'inv_mail_accepted',
            status: 'pending',
            expiresAt: '2030-01-02T00:00:00.000Z',
            emailSentAt: '2029-12-20T12:00:00.000Z',
            version: 3,
          },
        },
      ],
    },
  })))

  await openSettings(page)

  const queued = page.locator('.staff-access-row').filter({ hasText: 'Mail Queued' })
  const accepted = page.locator('.staff-access-row').filter({ hasText: 'Mail Accepted' })
  await expect(queued).toContainText('Oczekuje na wysłanie')
  await expect(queued).not.toContainText('Przyjęte do wysłania')
  await expect(accepted).toContainText('Przyjęte do wysłania')
})

test('@owner refreshes asynchronous invitation state on focus without overlapping requests', async ({ page }) => {
  let listRequests = 0
  let releaseRefresh
  const refreshReleased = new Promise((resolve) => { releaseRefresh = resolve })
  await page.route('**/api/v1/staff', async (route) => {
    listRequests += 1
    if (listRequests === 2) await refreshReleased
    await route.fulfill(json(200, {
      data: {
        staff: [{
          id: 'stf_focus_refresh',
          displayName: 'Focus Refresh',
          email: 'focus.refresh@example.test',
          role: 'coordinator',
          status: 'pending',
          version: 1,
          specialistId: null,
          invitation: {
            id: 'inv_focus_refresh',
            status: 'pending',
            expiresAt: '2030-01-02T00:00:00.000Z',
            emailSentAt: listRequests === 1 ? null : '2029-12-20T12:00:00.000Z',
            version: listRequests === 1 ? 2 : 3,
          },
        }],
      },
    }))
  })

  try {
    await openSettings(page)
    const row = page.locator('.staff-access-row').filter({ hasText: 'Focus Refresh' })
    await expect(row).toContainText('Oczekuje na wysłanie')

    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
    })
    await expect.poll(() => listRequests, { timeout: 1_500 }).toBe(2)
    await expect(row).toContainText('Oczekuje na wysłanie')
    await expect(page.getByText('Pobieranie listy personelu…', { exact: true })).toHaveCount(0)

    releaseRefresh()
    await expect(row).toContainText('Przyjęte do wysłania')
    expect(listRequests).toBe(2)
  } finally {
    releaseRefresh()
  }
})

test('@owner keeps the current staff list when a background refresh fails', async ({ page }) => {
  let listRequests = 0
  await page.route('**/api/v1/staff', async (route) => {
    listRequests += 1
    if (listRequests > 1) {
      await route.abort('connectionfailed')
      return
    }
    await route.fulfill(json(200, {
      data: {
        staff: [{
          id: 'stf_background_failure',
          displayName: 'Background Failure',
          email: 'background.failure@example.test',
          role: 'coordinator',
          status: 'pending',
          version: 1,
          specialistId: null,
          invitation: {
            id: 'inv_background_failure',
            status: 'pending',
            expiresAt: '2030-01-02T00:00:00.000Z',
            emailSentAt: null,
            version: 2,
          },
        }],
      },
    }))
  })

  await openSettings(page)
  const row = page.locator('.staff-access-row').filter({ hasText: 'Background Failure' })
  await expect(row).toContainText('Oczekuje na wysłanie')

  const failed = page.waitForEvent('requestfailed', (request) => (
    new URL(request.url()).pathname === '/api/v1/staff'
  ))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await failed

  await expect(row).toContainText('Oczekuje na wysłanie')
  await expect(page.getByText('Nie udało się pobrać listy personelu.', { exact: true })).toHaveCount(0)
  expect(listRequests).toBe(2)
})

test('@owner staff invitation drawer guards a changed draft', async ({ page }) => {
  await openSettings(page)
  await page.getByRole('button', { name: 'Zaproś osobę' }).click()

  const drawer = page.getByRole('dialog', { name: 'Zaproś osobę' })
  await drawer.getByLabel('Imię i nazwisko').fill('Iga Testowa')
  await drawer.getByRole('button', { name: 'Zamknij' }).click()
  await expect(drawer.getByText('Masz niezapisane zmiany.', { exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: 'Odrzuć' }).click()
  await expect(drawer).toHaveCount(0)
})

test('@owner staff access performs one effective initial list request', async ({ page }) => {
  let listRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'GET'
      && new URL(request.url()).pathname === '/api/v1/staff') listRequests += 1
  })
  await openSettings(page)

  await expect(page.locator('.staff-access-row__name')).toHaveCount(3)
  await page.waitForTimeout(100)
  expect(listRequests).toBe(1)
})

test('@owner staff local navigation focuses the section heading', async ({ page }) => {
  await openSettings(page)
  const sections = page.getByRole('navigation', { name: 'Sekcje ustawień' })

  await sections.getByRole('button', { name: 'Dostęp personelu' }).click()

  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toBeFocused()
})

test('@owner dirty staff invitation blocks route navigation', async ({ page }) => {
  await openSettings(page)
  const drawer = await fillStaffInvitation(page, {
    displayName: 'Iga Niedokończona',
    email: 'gate-c-draft@example.test',
  })

  await page.evaluate(() => { window.location.hash = '#/calendar' })

  const confirm = page.getByRole('alertdialog', { name: 'Niezapisane zmiany' })
  await expect(confirm).toBeVisible()
  await expect(drawer).toBeVisible()
  expect(await drawer.evaluate((element) => element.matches(':modal'))).toBe(true)
  expect(await confirm.evaluate((element) => element.matches(':modal'))).toBe(true)
  await confirm.getByRole('button', { name: 'Odrzuć i wyjdź' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.locator('.topbar__title b')).toHaveText('Kalendarz')
})

test('@owner deactivation confirmation traps and restores focus', async ({ page }) => {
  await openSettings(page)
  const row = page.locator('.staff-access-row').filter({ hasText: 'Celina Testowa' })
  const opener = row.getByRole('button', { name: 'Wyłącz dostęp — Celina Testowa' })
  await opener.click()
  const confirm = page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })
  const back = confirm.getByRole('button', { name: 'Wróć' })
  const deactivate = confirm.getByRole('button', { name: 'Wyłącz dostęp' })

  await expect(back).toBeFocused()
  await back.press('Shift+Tab')
  await expect(deactivate).toBeFocused()
  await deactivate.press('Tab')
  await expect(back).toBeFocused()
  await back.click()
  await expect(confirm).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('@owner staff deactivation is a native modal that owns the shell shortcuts', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openSettings(page)
  const row = page.locator('.staff-access-row').filter({ hasText: 'Celina Testowa' })
  await row.getByRole('button', { name: 'Wyłącz dostęp — Celina Testowa' }).click()

  const confirm = page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })
  await expectStaffModalOwnsShell(page, confirm)
})

test('@owner rejects a malformed capability grant before requesting the directory', async ({ page }) => {
  let staffRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/staff')) staffRequests += 1
  })
  await page.route('**/api/v1/session', (route) => route.fulfill(sessionEnvelope()))

  await page.goto('./#/settings')

  await expect(page.getByRole('heading', { name: 'Nie udało się połączyć z panelem' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Zaproś osobę' })).toHaveCount(0)
  for (const email of [
    'owner@example.test',
    'coordinator@example.test',
    'specialist@example.test',
  ]) {
    await expect(page.getByText(email, { exact: true })).toHaveCount(0)
  }
  expect(staffRequests).toBe(0)
})

test('@owner role change removes the directory without another staff request', async ({ page }) => {
  let staffRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/staff') staffRequests += 1
  })
  await openSettings(page)
  await expect(page.getByText('coordinator@example.test', { exact: true })).toBeVisible()
  const requestsBeforeRefresh = staffRequests
  await page.route('**/api/v1/session', (route) => route.fulfill(sessionEnvelope({
    actor: {
      id: 'stf_capability_coordinator',
      displayName: 'Celina Testowa',
      professionalTitle: null,
      role: 'coordinator',
      specialistId: null,
      version: 1,
    },
    capabilities: [
      'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
      'client.manage', 'client.operational.read', 'finance.centre.read',
      'operations.health.read', 'payment.manage', 'specialist.directory.read', 'tus.manage',
    ],
  })))

  await page.evaluate(() => {
    window.dispatchEvent(new Event('bwm:test-auth-refresh'))
  })

  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toHaveCount(0)
  await expect(page.getByText('coordinator@example.test', { exact: true })).toHaveCount(0)
  expect(staffRequests).toBe(requestsBeforeRefresh)
})

test('@owner clears staff rows when the server forbids an invitation', async ({ page }) => {
  await page.route('**/api/v1/staff/invitations', (route) => (
    route.fulfill(errorEnvelope(403, 'FORBIDDEN'))
  ))
  await openSettings(page)
  await expect(page.getByText('Celina Testowa', { exact: true })).toBeVisible()
  const drawer = await fillStaffInvitation(page, {
    displayName: 'Fiona Zabroniona',
    email: 'gate-c-forbidden@example.test',
  })

  await drawer.getByRole('button', { name: 'Wyślij zaproszenie' }).click()

  await expect(page.locator('.staff-access-row')).toHaveCount(0)
  await expect(page.getByText('Nie udało się pobrać listy personelu.', { exact: true })).toBeVisible()
  await expect(drawer.getByText(
    'Nie masz już uprawnień do zarządzania personelem.',
    { exact: true },
  )).toBeVisible()
  await expect(drawer).not.toContainText('FORBIDDEN')
})

test('@owner keeps staff email out of URLs, attributes, labels, and logs', async ({ page }) => {
  const logs = []
  const urls = []
  page.on('console', (message) => logs.push(message.text()))
  page.on('pageerror', (error) => logs.push(error.message))
  page.on('request', (request) => urls.push(request.url()))
  await openSettings(page)
  await expect(page.getByText('owner@example.test', { exact: true })).toBeVisible()

  const leaks = await page.evaluate(() => {
    const emails = ['owner@example.test', 'coordinator@example.test', 'specialist@example.test']
    const sensitiveToken = /(?:stf_|inv_|^(?:active|disabled|pending|provisioning|owner|coordinator|specialist)$)/
    const attributes = [...document.querySelectorAll('*')].flatMap((element) => (
      [...element.attributes].map(({ name, value }) => ({ name, value }))
    ))
    return {
      emailAttributes: attributes.filter(({ value }) => emails.some((email) => value.includes(email))),
      sensitiveAttributes: attributes.filter(({ value }) => sensitiveToken.test(value)),
      sensitiveText: [...document.querySelectorAll('body *')]
        .map((element) => element.childNodes.length === 1 ? element.textContent : '')
        .filter((value) => /(?:stf_|inv_)/.test(value)),
    }
  })

  expect(leaks).toEqual({
    emailAttributes: [],
    sensitiveAttributes: [],
    sensitiveText: [],
  })
  expect(urls.filter((url) => url.includes('@example.test'))).toEqual([])
  expect(logs.filter((message) => message.includes('@example.test'))).toEqual([])
})

test('@owner keeps max-length staff content contained at 320px', async ({ page }) => {
  const displayName = 'A'.repeat(120)
  const email = `${'long'.repeat(55)}@example.test`
  await page.route('**/api/v1/staff', (route) => route.fulfill(json(200, {
    data: {
      staff: [{
        id: 'stf_long_content',
        displayName,
        email,
        role: 'coordinator',
        status: 'active',
        version: 9,
        specialistId: null,
        invitation: null,
      }],
    },
  })))
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto('./#/settings')
  await expect(page.getByText(email, { exact: true })).toBeVisible()
  const row = page.locator('.staff-access-row')

  let geometry = await page.evaluate(() => {
    const target = document.querySelector('.staff-access-row')
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rowOverflow: target.scrollWidth - target.clientWidth,
    }
  })
  expect(geometry.documentOverflow).toBeLessThanOrEqual(0)
  expect(geometry.rowOverflow).toBeLessThanOrEqual(0)

  await row.getByRole('button', { name: `Wyłącz dostęp — ${displayName}` }).click()
  await expect(page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })).toBeVisible()
  geometry = await page.evaluate(() => {
    const target = document.querySelector('.leave-confirm__card')
    const rect = target.getBoundingClientRect()
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      left: rect.left,
      right: rect.right - window.innerWidth,
    }
  })
  expect(geometry.documentOverflow).toBeLessThanOrEqual(0)
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(0)
})

test('@owner sends one fictional invitation and renders provisioning', async ({ page }) => {
  let releaseRequest
  const requestReleased = new Promise((resolve) => { releaseRequest = resolve })
  let requests = 0
  await page.route('**/api/v1/staff/invitations', async (route) => {
    requests += 1
    await requestReleased
    await route.continue()
  })
  await openSettings(page)
  const drawer = await fillStaffInvitation(page, {
    displayName: 'Beata Bramowa',
    email: 'gate-c-invite@example.test',
  })
  const requestSeen = page.waitForRequest((request) => (
    request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/v1/staff/invitations'
  ))

  await drawer.getByRole('button', { name: 'Wyślij zaproszenie' }).click()
  const request = await requestSeen
  await expect(drawer.getByRole('button', { name: 'Wyślij zaproszenie' })).toBeDisabled()
  expect(request.postDataJSON()).toEqual({
    displayName: 'Beata Bramowa',
    email: 'gate-c-invite@example.test',
    role: 'coordinator',
  })
  expect(request.postDataJSON()).not.toHaveProperty('specialistId')
  expect(request.headers()['idempotency-key']).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/)
  expect(requests).toBe(1)

  releaseRequest()
  await expect(drawer).toHaveCount(0)
  const row = page.locator('.staff-access-row').filter({ hasText: 'Beata Bramowa' })
  await expect(row).toContainText('gate-c-invite@example.test')
  await expect(row).toContainText('Konfiguracja dostępu w toku')
  await expect(page.getByText('Zaproszenie zostało utworzone.', { exact: true })).toBeVisible()
})

test('@owner retries an uncertain invitation with the exact action key', async ({ page }) => {
  const attempts = []
  await page.route('**/api/v1/staff/invitations', async (route) => {
    attempts.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
    })
    if (attempts.length === 1) {
      await route.abort('connectionfailed')
      return
    }
    await route.continue()
  })
  await openSettings(page)
  const drawer = await fillStaffInvitation(page, {
    displayName: 'Róża Ponowna',
    email: 'gate-c-retry@example.test',
    role: 'Specjalista',
  })

  await drawer.getByRole('button', { name: 'Wyślij zaproszenie' }).click()
  await expect(drawer.getByRole('button', { name: 'Spróbuj ponownie' })).toBeVisible()
  await drawer.getByRole('button', { name: 'Spróbuj ponownie' }).click()

  await expect(drawer).toHaveCount(0)
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
})

test('@owner starts a new invitation action after deterministic error or field change', async ({ page }) => {
  const keys = []
  await page.route('**/api/v1/staff/invitations', async (route) => {
    keys.push(route.request().headers()['idempotency-key'])
    if (keys.length === 2) {
      await route.abort('connectionfailed')
      return
    }
    await route.fulfill(errorEnvelope(409, 'STAFF_INVITATION_CONFLICT'))
  })
  await openSettings(page)
  const drawer = await fillStaffInvitation(page, {
    displayName: 'Maja Konfliktowa',
    email: 'gate-c-conflict@example.test',
  })
  const submit = drawer.getByRole('button', { name: 'Wyślij zaproszenie' })

  await submit.click()
  await expect(drawer.getByText('Nie można utworzyć tego zaproszenia.', { exact: true })).toBeVisible()
  await submit.click()
  await expect(drawer.getByRole('button', { name: 'Spróbuj ponownie' })).toBeVisible()
  await drawer.getByLabel('Imię i nazwisko').fill('Maja Zmieniona')
  await expect(submit).toBeVisible()
  await submit.click()
  await expect(drawer.getByText('Nie można utworzyć tego zaproszenia.', { exact: true })).toBeVisible()

  expect(keys).toHaveLength(3)
  expect(new Set(keys).size).toBe(3)
})

test('@owner confirms and retries deactivation of a dedicated invited row', async ({ page }) => {
  const attempts = []
  let releaseFirstAttempt
  const firstAttemptReleased = new Promise((resolve) => { releaseFirstAttempt = resolve })
  await page.route('**/api/v1/staff/*/deactivation', async (route) => {
    attempts.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
      url: route.request().url(),
    })
    if (attempts.length === 1) {
      await firstAttemptReleased
      await route.abort('connectionfailed')
      return
    }
    await route.continue()
  })
  await openSettings(page)
  let drawer = await fillStaffInvitation(page, {
    displayName: 'Daria Wyłączana',
    email: 'gate-c-deactivate@example.test',
  })
  await drawer.getByRole('button', { name: 'Wyślij zaproszenie' }).click()
  await expect(drawer).toHaveCount(0)

  const row = page.locator('.staff-access-row').filter({ hasText: 'Daria Wyłączana' })
  await row.getByRole('button', { name: 'Wyłącz dostęp — Daria Wyłączana' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })
  await expect(confirm).toBeVisible()
  await expect(confirm).not.toContainText('gate-c-deactivate@example.test')
  expect(attempts).toHaveLength(0)

  const requestSeen = page.waitForRequest('**/api/v1/staff/*/deactivation')
  await confirm.getByRole('button', { name: 'Wyłącz dostęp' }).click()
  await requestSeen
  await expect(confirm.getByRole('button', { name: 'Wyłącz dostęp' })).toBeDisabled()
  expect(attempts).toHaveLength(1)
  expect(JSON.parse(attempts[0].body)).toEqual({ version: 1 })
  expect(new URL(attempts[0].url).search).toBe('')

  releaseFirstAttempt()
  await expect(confirm.getByRole('button', { name: 'Spróbuj ponownie' })).toBeVisible()
  await confirm.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect(confirm).toHaveCount(0)
  expect(attempts).toHaveLength(3)
  expect(attempts[1]).toEqual(attempts[0])
  expect(attempts[2]).toEqual(attempts[0])
  await expect(row).toContainText('Wyłączone')
  await expect(row).not.toContainText('Konfiguracja dostępu w toku')
})

test('@owner closes and refreshes after a deactivation version conflict', async ({ page }) => {
  let listRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'GET'
      && new URL(request.url()).pathname === '/api/v1/staff') listRequests += 1
  })
  await page.route('**/api/v1/staff/*/deactivation', (route) => (
    route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
  ))
  await openSettings(page)
  const row = page.locator('.staff-access-row').filter({ hasText: 'Celina Testowa' })
  await expect(row).toContainText('Aktywne')
  const requestsBeforeConflict = listRequests
  await row.getByRole('button', { name: 'Wyłącz dostęp — Celina Testowa' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })
  await confirm.getByRole('button', { name: 'Wyłącz dostęp' }).click()

  await expect(confirm).toHaveCount(0)
  await expect(page.getByText('Lista personelu została odświeżona.', { exact: true })).toBeVisible()
  await expect.poll(() => listRequests).toBeGreaterThan(requestsBeforeConflict)
  await expect(row).toContainText('Aktywne')
})

test('@owner reports a failed version-conflict refresh without claiming success', async ({ page }) => {
  let listRequests = 0
  await page.route('**/api/v1/staff', async (route) => {
    listRequests += 1
    if (listRequests === 1) {
      await route.continue()
      return
    }
    await route.fulfill(errorEnvelope(500, 'INTERNAL_ERROR'))
  })
  await page.route('**/api/v1/staff/*/deactivation', (route) => (
    route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
  ))
  await openSettings(page)
  const row = page.locator('.staff-access-row').filter({ hasText: 'Celina Testowa' })
  await row.getByRole('button', { name: 'Wyłącz dostęp — Celina Testowa' }).click()

  const confirm = page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })
  await confirm.getByRole('button', { name: 'Wyłącz dostęp' }).click()

  await expect(confirm).toHaveCount(0)
  await expect(page.getByText(
    'Nie udało się odświeżyć listy personelu. Użyj przycisku „Odśwież”.',
    { exact: true },
  )).toBeVisible()
  await expect(page.getByText(
    'Lista personelu została odświeżona.',
    { exact: true },
  )).toHaveCount(0)
  await expect(page.getByText(
    'Nie udało się pobrać listy personelu.',
    { exact: true },
  )).toBeVisible()
})

test('@owner restores stable focus when deactivation success removes its row', async ({ page }) => {
  let listRequests = 0
  await page.route('**/api/v1/staff', (route) => {
    listRequests += 1
    return route.fulfill(json(200, {
      data: { staff: listRequests === 1 ? [detachedFocusStaff] : [] },
    }))
  })
  await page.route('**/api/v1/staff/*/deactivation', (route) => (
    route.fulfill(json(200, {
      data: {
        staff: {
          ...detachedFocusStaff,
          status: 'disabled',
          version: 2,
          invitation: undefined,
        },
      },
    }))
  ))
  await openSettings(page)
  const opener = page.getByRole('button', { name: 'Wyłącz dostęp — Felicja Fokusowa' })
  await opener.click()

  const confirm = page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })
  await confirm.getByRole('button', { name: 'Wyłącz dostęp' }).click()

  await expect(confirm).toHaveCount(0)
  await expect(opener).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toBeFocused()
})

test('@owner restores stable focus when a conflict refresh replaces its row', async ({ page }) => {
  let listRequests = 0
  await page.route('**/api/v1/staff', (route) => {
    listRequests += 1
    return route.fulfill(json(200, {
      data: { staff: listRequests === 1 ? [detachedFocusStaff] : [] },
    }))
  })
  await page.route('**/api/v1/staff/*/deactivation', (route) => (
    route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
  ))
  await openSettings(page)
  const opener = page.getByRole('button', { name: 'Wyłącz dostęp — Felicja Fokusowa' })
  await opener.click()

  const confirm = page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })
  await confirm.getByRole('button', { name: 'Wyłącz dostęp' }).click()

  await expect(confirm).toHaveCount(0)
  await expect(opener).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toBeFocused()
})

test('@owner restores stable focus when forbidden deactivation clears its row', async ({ page }) => {
  await page.route('**/api/v1/staff', (route) => (
    route.fulfill(json(200, { data: { staff: [detachedFocusStaff] } }))
  ))
  await page.route('**/api/v1/staff/*/deactivation', (route) => (
    route.fulfill(errorEnvelope(403, 'FORBIDDEN'))
  ))
  await openSettings(page)
  const opener = page.getByRole('button', { name: 'Wyłącz dostęp — Felicja Fokusowa' })
  await opener.click()

  const confirm = page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })
  await confirm.getByRole('button', { name: 'Wyłącz dostęp' }).click()

  await expect(confirm).toHaveCount(0)
  await expect(opener).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toBeFocused()
})

test('@owner sees a fixed last-active-owner deactivation error', async ({ page }) => {
  await page.route('**/api/v1/staff/*/deactivation', (route) => (
    route.fulfill(errorEnvelope(409, 'LAST_ACTIVE_OWNER'))
  ))
  await openSettings(page)
  const row = page.locator('.staff-access-row').filter({ hasText: 'Alicja Testowa' })
  await row.getByRole('button', { name: 'Wyłącz dostęp — Alicja Testowa' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })

  await confirm.getByRole('button', { name: 'Wyłącz dostęp' }).click()

  await expect(confirm.getByText(
    'Nie można wyłączyć ostatniego aktywnego właściciela.',
    { exact: true },
  )).toBeVisible()
  await expect(confirm).not.toContainText('LAST_ACTIVE_OWNER')
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

test('@coordinator never requests or renders staff access data', async ({ page }) => {
  let staffRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/staff')) staffRequests += 1
  })
  await page.goto('./#/settings')
  await expectAuthenticated(page, 'coordinator')
  await expect(page.getByRole('heading', { name: 'Twoje konto' })).toBeVisible()

  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Zaproś osobę' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Wyłącz dostęp/ })).toHaveCount(0)
  for (const value of [
    'owner@example.test',
    'coordinator@example.test',
    'specialist@example.test',
    'Alicja Testowa',
    'Zofia Fikcyjna',
  ]) {
    await expect(page.getByText(value, { exact: true })).toHaveCount(0)
  }
  expect(staffRequests).toBe(0)
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
  await expect(drawer.getByText('Specjalistka', { exact: true })).toBeVisible()
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
  await expect(page.getByText(
    'Brak rozliczonych sesji w tym miesiącu',
    { exact: true },
  )).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Przychody' })).toHaveCount(0)
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

test('@specialist never requests or renders staff access data', async ({ page }) => {
  let staffRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/staff')) staffRequests += 1
  })
  await page.goto('./#/settings')
  await expectAuthenticated(page, 'specialist')
  await expect(page.getByRole('heading', { name: 'Twoje konto' })).toBeVisible()

  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Zaproś osobę' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Wyłącz dostęp/ })).toHaveCount(0)
  for (const value of [
    'owner@example.test',
    'coordinator@example.test',
    'specialist@example.test',
    'Alicja Testowa',
    'Celina Testowa',
  ]) {
    await expect(page.getByText(value, { exact: true })).toHaveCount(0)
  }
  expect(staffRequests).toBe(0)
})
