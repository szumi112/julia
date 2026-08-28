import { expect, test } from '@playwright/test'
import { CAPABILITIES, ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const DEFAULT_ACTOR = Object.freeze({
  id: 'stf_capability_shell_owner',
  displayName: 'Alicja Uprawniona',
  professionalTitle: null,
  role: 'owner',
  specialistId: null,
  version: 1,
})

const sessionEnvelope = ({ authorityRevision = 1, capabilities, actor = DEFAULT_ACTOR }) => {
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
      environment: 'development',
    },
  })
}

const errorEnvelope = (status, code) => json(status, {
  error: { code, correlationId: `cor_capability_ui_${status}` },
})

const target = ({
  staffId = 'stf_capability_target',
  displayName = 'Celina Koordynatorka',
  role = 'coordinator',
  status = 'active',
  authorityRevision = 3,
} = {}) => ({ staffId, displayName, role, status, authorityRevision })

const coordinatorAuthority = ({
  authorityRevision = 3,
  allow = ['finance.import'],
  deny = ['client.manage'],
} = {}) => {
  const effective = new Set([...ROLE_DEFAULT_CAPABILITIES.coordinator, ...allow])
  deny.forEach((capability) => effective.delete(capability))
  return {
    ...target({ authorityRevision }),
    allow,
    deny,
    effectiveCapabilities: CAPABILITIES.filter((capability) => effective.has(capability)),
  }
}

const installSession = async (page, capabilities) => {
  await page.route('**/api/v1/session', (route) => (
    route.fulfill(sessionEnvelope({ capabilities }))
  ))
}

test('@owner capability shell keeps direct hashes, hashchange, desktop navigation, and palette in one authority', async ({ page }) => {
  await installSession(page, ['finance.centre.read', 'permissions.manage'])
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('./#/team')

  await expect(page).toHaveURL(/#\/payments(?:\?|$)/)
  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  await expect(navigation.getByRole('link')).toHaveText([
    'Finanse', 'Rejestr', 'Raporty', 'Ustawienia',
  ])

  await page.evaluate(() => { window.location.hash = '#/unknown-shell-route' })
  await expect(page).toHaveURL(/#\/payments(?:\?|$)/)
  await page.evaluate(() => { window.location.hash = '#/reports' })
  await expect(page).toHaveURL(/#\/reports(?:\?|$)/)

  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  const search = palette.getByRole('combobox', { name: 'Szukaj w panelu' })
  await search.fill('rejestr')
  await palette.getByRole('option', { name: 'Rejestr' }).click()
  await expect(page).toHaveURL(/#\/ledger(?:\?|$)/)

  await page.keyboard.press('Control+K')
  await palette.getByRole('combobox', { name: 'Szukaj w panelu' }).fill('zespół')
  await expect(palette.getByRole('option', { name: 'Zespół' })).toHaveCount(0)
})

test('@owner restricted cockpit renders no inaccessible Calendar entity link', async ({ page }) => {
  await installSession(page, ['finance.centre.read', 'permissions.manage'])
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('./#/payments')

  await page.getByRole('button', { name: /^Panel dnia:/ }).click()
  const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  await expect(cockpit).toBeVisible()
  await expect(cockpit.getByRole('link', { name: 'Kalendarz' })).toHaveCount(0)
  await expect(cockpit.locator('a[href="#/calendar"]')).toHaveCount(0)
})

test('@owner permitted cockpit keeps native modified navigation for an accessible entity link', async ({ page, context }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('./#/dashboard')

  await page.getByRole('button', { name: /^Panel dnia:/ }).click()
  const calendar = page.getByRole('dialog', { name: 'Panel dnia' })
    .getByRole('link', { name: 'Kalendarz' })
  await expect(calendar).toHaveAttribute('href', '#/calendar')
  const openedPage = context.waitForEvent('page')
  await calendar.click({ modifiers: ['ControlOrMeta'] })
  const modified = await openedPage
  await modified.waitForLoadState('domcontentloaded')
  await expect(modified).toHaveURL(/#\/calendar(?:\?|$)/)
  await modified.close()
})

test('@owner window focus authority refresh closes the cockpit and restores view focus', async ({ page }) => {
  let refreshed = false
  let sessionRequests = 0
  await page.route('**/api/v1/session', (route) => {
    sessionRequests += 1
    return route.fulfill(sessionEnvelope({
      authorityRevision: refreshed ? 2 : 1,
      capabilities: ROLE_DEFAULT_CAPABILITIES.owner,
    }))
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('./#/dashboard')

  await page.getByRole('button', { name: /^Panel dnia:/ }).click()
  const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  await expect(cockpit).toBeVisible()

  refreshed = true
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
  })

  await expect.poll(() => sessionRequests).toBeGreaterThanOrEqual(2)
  await expect(cockpit).toHaveCount(0)
  await expect(page).toHaveURL(/#\/dashboard(?:\?|$)/)
  await expect(page.locator('.view')).toBeFocused()
})

test('@owner capability shell keeps incomplete workspace and unfinished activity routes out of phone navigation', async ({ page }) => {
  await installSession(page, [
    'appointment.charge.read',
    'client.operational.read',
    'permissions.manage',
    'tus.manage',
  ])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./#/calendar')

  await expect(page).toHaveURL(/#\/payments(?:\?|$)/)
  const tabbar = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  await expect(tabbar.getByRole('link', { name: 'TUS' })).toHaveCount(0)
  await expect(tabbar.getByRole('link', { name: 'Dziś' })).toHaveCount(0)
  await expect(tabbar.getByRole('link', { name: 'Kalendarz' })).toHaveCount(0)

  await tabbar.getByRole('button', { name: 'Menu' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  await expect(drawer.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link')).toHaveText(['Finanse', 'Ustawienia'])
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  const search = palette.getByRole('combobox', { name: 'Szukaj w panelu' })
  await search.fill('tus')
  await expect(palette.getByRole('option', { name: 'Zajęcia TUS' })).toHaveCount(0)
  await search.fill('kalendarz')
  await expect(palette.getByRole('option', { name: 'Kalendarz' })).toHaveCount(0)
})

test('@owner capability shell redirects and closes stale overlays after authority refresh', async ({ page }) => {
  let refreshed = false
  await page.route('**/api/v1/session', (route) => route.fulfill(sessionEnvelope(
    refreshed
      ? {
          authorityRevision: 2,
          capabilities: ['finance.centre.read', 'permissions.manage'],
        }
      : {
          authorityRevision: 1,
          capabilities: ['permissions.manage', 'staff.manage'],
        },
  )))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('./#/team')

  await expect(page).toHaveURL(/#\/team$/)
  await expect(page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Zespół' })).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Control+K')
  await expect(page.getByRole('dialog', { name: 'Szukaj w panelu' })).toBeVisible()

  refreshed = true
  await page.evaluate(() => {
    window.dispatchEvent(new Event('bwm:test-auth-refresh'))
  })

  await expect(page).toHaveURL(/#\/payments(?:\?|$)/)
  await expect(page.getByRole('dialog', { name: 'Szukaj w panelu' })).toHaveCount(0)
  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  await expect(navigation.getByRole('link', { name: 'Finanse' }))
    .toHaveAttribute('aria-current', 'page')
  await expect(navigation.getByRole('link', { name: 'Zespół' })).toHaveCount(0)
})

test('@owner visibility refresh clears a dirty role drawer on a same-capability revision', async ({ page }) => {
  let refreshed = false
  let sessionRequests = 0
  let staffRequests = 0
  let roleRequests = 0
  await page.route('**/api/v1/session', (route) => {
    sessionRequests += 1
    return route.fulfill(sessionEnvelope({
      authorityRevision: refreshed ? 2 : 1,
      capabilities: ROLE_DEFAULT_CAPABILITIES.owner,
    }))
  })
  await page.route('**/api/v1/staff', (route) => {
    staffRequests += 1
    return route.fulfill(json(200, {
      data: {
        staff: [{
          id: 'stf_visibility_target',
          displayName: 'Celina Widoczna',
          email: 'celina@example.test',
          role: 'coordinator',
          status: 'active',
          version: 3,
          specialistId: null,
          invitation: null,
        }],
      },
    }))
  })
  await page.route('**/api/v1/staff/*/role', (route) => {
    roleRequests += 1
    return route.abort()
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('./#/settings?section=staff')

  await page.getByRole('button', { name: 'Zmień rolę — Celina Widoczna' }).click()
  const drawer = page.getByRole('dialog', { name: 'Zmień rolę — Celina Widoczna' })
  await drawer.getByLabel('Rola').selectOption('owner')
  await expect(drawer.getByRole('button', { name: 'Zapisz rolę' })).toBeEnabled()

  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
  refreshed = true
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })

  await expect.poll(() => sessionRequests).toBeGreaterThanOrEqual(2)
  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('alertdialog', { name: 'Niezapisane zmiany' })).toHaveCount(0)
  await expect(page.locator('.view')).toBeFocused()
  await expect.poll(() => staffRequests).toBeGreaterThanOrEqual(2)
  expect(roleRequests).toBe(0)
})

test('@owner permissions surface uses only the minimal sorted directory and recovers list and detail errors', async ({ page }) => {
  await installSession(page, ['permissions.manage'])
  let targetRequests = 0
  let detailRequests = 0
  let fullDirectoryRequests = 0
  let releaseFirstTargets
  const firstTargets = new Promise((resolve) => { releaseFirstTargets = resolve })
  const targets = [
    target(),
    target({ staffId: 'stf_capability_zofia', displayName: 'Zofia Specjalistka', role: 'specialist' }),
  ]

  await page.route('**/api/v1/staff/capability-targets', async (route) => {
    targetRequests += 1
    if (targetRequests === 1) {
      await firstTargets
      await route.fulfill(errorEnvelope(500, 'INTERNAL_ERROR'))
      return
    }
    await route.fulfill(json(200, { data: { targets } }))
  })
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => {
    detailRequests += 1
    return route.fulfill(detailRequests === 1
      ? errorEnvelope(500, 'INTERNAL_ERROR')
      : json(200, { data: { authority: coordinatorAuthority() } }))
  })
  page.on('request', (request) => {
    if (request.method() === 'GET'
      && new URL(request.url()).pathname === '/api/v1/staff') fullDirectoryRequests += 1
  })

  await page.goto('./#/settings?section=permissions')
  await expect(page.getByRole('heading', { name: 'Uprawnienia personelu' })).toBeVisible()
  await expect(page.getByText('Pobieranie listy osób…', { exact: true })).toBeVisible()
  releaseFirstTargets()
  await expect(page.getByText('Nie udało się pobrać listy osób.', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Odśwież listę osób' }).click()
  const targetSelect = page.getByRole('combobox', { name: 'Osoba' })
  await expect(targetSelect.locator('option')).toHaveText([
    'Celina Koordynatorka — Koordynator',
    'Zofia Specjalistka — Specjalista',
  ])
  await expect(page.getByText(
    'Nie udało się pobrać uprawnień tej osoby.',
    { exact: true },
  )).toBeVisible()
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()

  await expect(page.getByRole('checkbox', { name: 'Import danych finansowych' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Zarządzanie klientami' })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Zarządzanie personelem' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toHaveCount(0)
  await expect(page.getByText(/@example\.test/)).toHaveCount(0)
  expect(fullDirectoryRequests).toBe(0)
})

test('@owner self-target permission save uses optimistic replacement and remounts into the refreshed authority', async ({ page }) => {
  const actor = DEFAULT_ACTOR
  const initialCapabilities = ROLE_DEFAULT_CAPABILITIES.owner
  const refreshedCapabilities = initialCapabilities.filter((capability) => capability !== 'staff.manage')
  let saved = false
  let sessionRequests = 0
  let targetRequests = 0
  const mutations = []

  await page.route('**/api/v1/session', (route) => {
    sessionRequests += 1
    return route.fulfill(sessionEnvelope({
      actor,
      authorityRevision: saved ? 2 : 1,
      capabilities: saved ? refreshedCapabilities : initialCapabilities,
    }))
  })
  await page.route('**/api/v1/staff/capability-targets', (route) => {
    targetRequests += 1
    return route.fulfill(json(200, {
      data: {
        targets: [target({
          staffId: actor.id,
          displayName: actor.displayName,
          role: actor.role,
          authorityRevision: saved ? 2 : 1,
        })],
      },
    }))
  })
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, async (route) => {
    const request = route.request()
    if (request.method() === 'POST') {
      mutations.push({
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'],
      })
      saved = true
    }
    const authority = {
      ...target({
        staffId: actor.id,
        displayName: actor.displayName,
        role: actor.role,
        authorityRevision: saved ? 2 : 1,
      }),
      allow: [],
      deny: saved ? ['staff.manage'] : [],
      effectiveCapabilities: saved ? refreshedCapabilities : initialCapabilities,
    }
    return route.fulfill(json(200, { data: { authority } }))
  })

  await page.goto('./#/settings?section=permissions')
  const staffPermission = page.getByRole('checkbox', { name: 'Zarządzanie personelem' })
  const constitutional = page.getByRole('checkbox', { name: 'Zarządzanie uprawnieniami' })
  await expect(staffPermission).toBeChecked()
  await expect(constitutional).toBeChecked()
  await expect(constitutional).toBeDisabled()

  await staffPermission.uncheck()
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()

  await expect(page.getByRole('heading', { name: 'Uprawnienia personelu' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: 'Zarządzanie personelem' })).not.toBeChecked()
  await expect.poll(() => sessionRequests).toBe(3)
  await expect.poll(() => targetRequests).toBe(2)
  expect(mutations).toHaveLength(2)
  expect(mutations[1]).toEqual(mutations[0])
  expect(mutations[0].body).toEqual({
    expectedAuthorityRevision: 1,
    allow: [],
    deny: ['staff.manage'],
  })
  expect(mutations[0].key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/)
})

test('@owner permission save retries an uncertain response with one immutable key and payload', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  let detailRevision = 3
  let attempts = 0
  const mutations = []
  await page.route('**/api/v1/staff/capability-targets', (route) => route.fulfill(json(200, {
    data: { targets: [target()] },
  })))
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      return route.fulfill(json(200, {
        data: { authority: coordinatorAuthority({ authorityRevision: detailRevision }) },
      }))
    }
    attempts += 1
    mutations.push({
      body: request.postData(),
      key: request.headers()['idempotency-key'],
    })
    if (attempts === 1) return route.fulfill(errorEnvelope(500, 'INTERNAL_ERROR'))
    detailRevision = 4
    return route.fulfill(json(200, {
      data: {
        authority: coordinatorAuthority({
          authorityRevision: detailRevision,
          allow: ['finance.import'],
          deny: ['chat.general', 'client.manage'],
        }),
      },
    }))
  })

  await page.goto('./#/settings?section=permissions')
  await page.getByRole('checkbox', { name: 'Czat ogólny' }).uncheck()
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()
  await expect(page.getByText(
    'Nie wiadomo, czy uprawnienia zostały zapisane. Spróbuj ponownie bez zmiany ustawień.',
    { exact: true },
  )).toBeVisible()
  await page.getByLabel('Uprawnienia personelu')
    .getByRole('button', { name: 'Spróbuj ponownie' })
    .click()

  await expect.poll(() => attempts).toBe(2)
  expect(mutations[0]).toEqual(mutations[1])
  expect(JSON.parse(mutations[0].body)).toEqual({
    expectedAuthorityRevision: 3,
    allow: ['finance.import'],
    deny: ['chat.general', 'client.manage'],
  })
})

test('@owner permission save reloads the current revision after an optimistic conflict', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  let externalChange = false
  let detailRequests = 0
  const mutationBodies = []
  await page.route('**/api/v1/staff/capability-targets', (route) => route.fulfill(json(200, {
    data: { targets: [target()] },
  })))
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      detailRequests += 1
      return route.fulfill(json(200, {
        data: {
          authority: coordinatorAuthority(externalChange
            ? { authorityRevision: 4, deny: ['chat.general', 'client.manage'] }
            : { authorityRevision: 3 }),
        },
      }))
    }
    mutationBodies.push(request.postDataJSON())
    externalChange = true
    return route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
  })

  await page.goto('./#/settings?section=permissions')
  const chat = page.getByRole('checkbox', { name: 'Czat ogólny' })
  await expect(chat).toBeChecked()
  await chat.uncheck()
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()

  await expect(page.getByText(
    'Uprawnienia zmieniły się w międzyczasie. Pobraliśmy aktualną wersję.',
    { exact: true },
  )).toBeVisible()
  await expect(chat).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Zapisz uprawnienia' })).toBeDisabled()
  expect(detailRequests).toBe(2)
  expect(mutationBodies).toEqual([{
    expectedAuthorityRevision: 3,
    allow: ['finance.import'],
    deny: ['chat.general', 'client.manage'],
  }])
})
