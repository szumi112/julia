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
  email: 'alicja@example.test',
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
      actor: { email: 'alicja@example.test', ...actor },
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

const authorityForTarget = (person, { allow = [], deny = [] } = {}) => {
  const effective = new Set([...ROLE_DEFAULT_CAPABILITIES[person.role], ...allow])
  deny.forEach((capability) => effective.delete(capability))
  return {
    ...person,
    allow,
    deny,
    effectiveCapabilities: CAPABILITIES.filter((capability) => effective.has(capability)),
  }
}

const installSession = async (page, capabilities, actor) => {
  await page.route('**/api/v1/session', (route) => (
    route.fulfill(sessionEnvelope({ capabilities, actor }))
  ))
}

test('@owner capability shell keeps direct hashes, hashchange, desktop navigation, and palette in one authority', async ({ page }) => {
  await installSession(page, ['finance.centre.read', 'permissions.manage'])
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('./#/team')

  await expect(page).toHaveURL(/#\/team(?:\?|$)/)
  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  await expect(navigation.getByRole('link')).toHaveText(['Zespół', 'Finanse', 'Raporty'])

  await page.evaluate(() => { window.location.hash = '#/unknown-shell-route' })
  await expect(page).toHaveURL(/#\/team(?:\?|$)/)
  await page.evaluate(() => { window.location.hash = '#/reports' })
  await expect(page).toHaveURL(/#\/reports(?:\?|$)/)

  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  const search = palette.getByRole('combobox', { name: 'Szukaj w panelu' })
  await search.fill('rejestr')
  await expect(palette.getByRole('option', { name: 'Rejestr' })).toHaveCount(0)

  await palette.getByRole('combobox', { name: 'Szukaj w panelu' }).fill('zespół')
  await expect(palette.getByRole('option', { name: 'Zespół' })).toHaveCount(1)
})

test('@coordinator restricted operations search does not expose owner data security', async ({ page }) => {
  await installSession(page, ['finance.centre.read', 'operations.health.read'], {
    ...DEFAULT_ACTOR,
    role: 'coordinator',
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('./#/payments')
  await expect(page.getByRole('main')).toBeVisible()

  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  const search = palette.getByRole('combobox', { name: 'Szukaj w panelu' })
  await search.fill('zaproszenie')
  await expect(palette.getByRole('option', { name: 'Zaproś do panelu' })).toHaveCount(0)
  await search.fill('uprawnienia')
  await expect(palette.getByRole('option', { name: 'Uprawnienia' })).toHaveCount(0)
  await search.fill('kopia zapasowa')
  await expect(palette.getByRole('option', { name: 'Bezpieczeństwo danych' })).toHaveCount(0)
})

test('@owner legacy settings access link falls back without requesting the staff surface', async ({ page }) => {
  await installSession(page, ['permissions.manage'])
  let staffRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/staff')) staffRequests += 1
  })

  await page.goto('./#/settings?section=staff')

  await expect(page).toHaveURL(/#\/profile(?:\?|$)/)
  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toHaveCount(0)
  expect(staffRequests).toBe(0)
})

test('@owner opens a staff member permissions from the Team access list', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const person = target({ staffId: 'stf_team_access_target' })
  await page.route('**/api/v1/staff', (route) => route.fulfill(json(200, {
    data: {
      staff: [{
        id: person.staffId,
        displayName: person.displayName,
        email: 'celina@example.test',
        role: person.role,
        status: person.status,
        version: 1,
        specialistId: null,
        invitation: null,
      }],
    },
  })))
  await page.route('**/api/v1/staff/capability-targets', (route) => (
    route.fulfill(json(200, { data: { targets: [person] } }))
  ))
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => (
    route.fulfill(json(200, { data: { authority: authorityForTarget(person) } }))
  ))

  await page.goto('./#/team?section=access')
  await page.getByRole('link', { name: 'Uprawnienia' }).click()

  await expect(page).toHaveURL(new RegExp(`#\\/team\\?section=permissions&staffId=${person.staffId}$`))
  await expect(page.getByRole('combobox', { name: 'Osoba' })).toHaveValue(person.staffId)
})

test('@owner restricted cockpit renders no inaccessible Calendar entity link', async ({ page }) => {
  await installSession(page, ['finance.centre.read', 'permissions.manage'])
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('./#/payments')

  await page.getByRole('button', { name: /^Panel dnia:/ }).click()
  const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  await expect(cockpit).toBeVisible()
  await expect(cockpit.getByRole('link', { name: 'Grafik' })).toHaveCount(0)
  await expect(cockpit.locator('a[href="#/calendar"]')).toHaveCount(0)
})

test('@owner direct spreadsheet entry is retired without mounting workbook tools', async ({ page }) => {
  await installSession(page, ['finance.centre.read', 'permissions.manage'])
  const workbookRequests = []
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/workbooks/')) workbookRequests.push(request.url())
  })
  await page.goto('./#/ledger')

  await expect(page.getByRole('heading', { name: 'Rejestr został przeniesiony' })).toBeVisible()
  await expect(page.getByText(/Wgrywanie arkusza i eksport całej bazy znajdziesz w Finansach/)).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByLabel('Wybierz plik Excel (.xlsx)')).toHaveCount(0)
  expect(workbookRequests).toEqual([])
})

test('@owner permitted cockpit keeps native modified navigation for an accessible entity link', async ({ page, context }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('./#/settings')

  await page.getByRole('button', { name: /^Panel dnia:/ }).click()
  const calendar = page.getByRole('dialog', { name: 'Panel dnia' })
    .getByRole('link', { name: 'Grafik' })
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
  await page.goto('./#/settings')

  await page.getByRole('button', { name: /^Panel dnia:/ }).click()
  const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  await expect(cockpit).toBeVisible()

  refreshed = true
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
  })

  await expect.poll(() => sessionRequests).toBeGreaterThanOrEqual(2)
  await expect(cockpit).toHaveCount(0)
  await expect(page).toHaveURL(/#\/settings(?:\?|$)/)
  await expect(page.locator('.view')).toBeFocused()
})

test('@owner incomplete workspace authority falls back to Team and omits activity routes', async ({ page }) => {
  await installSession(page, [
    'appointment.charge.read',
    'client.operational.read',
    'permissions.manage',
    'tus.manage',
  ])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./#/calendar')

  await expect(page).toHaveURL(/#\/team(?:\?|$)/)
  const tabbar = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  await expect(tabbar.getByRole('link', { name: 'Klienci' })).toHaveCount(0)
  await expect(tabbar.getByRole('link', { name: 'TUS' })).toHaveCount(0)
  await expect(tabbar.getByRole('link', { name: 'Dziś' })).toHaveCount(0)
  await expect(tabbar.getByRole('link', { name: 'Grafik' })).toHaveCount(0)

  await tabbar.getByRole('button', { name: 'Więcej' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  await expect(drawer.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link')).toHaveText(['Zespół'])
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  const search = palette.getByRole('combobox', { name: 'Szukaj w panelu' })
  await search.fill('tus')
  await expect(palette.getByRole('option', { name: 'Zajęcia TUS' })).toHaveCount(0)
  await search.fill('grafik')
  await expect(palette.getByRole('option', { name: 'Grafik' })).toHaveCount(0)
  await search.fill('konto')
  await expect(palette.getByRole('option', { name: 'Mój profil' })).toHaveCount(1)
})

test('@owner direct protected activity routes fail closed without TUS authority', async ({ page }) => {
  await installSession(page, ['finance.centre.read', 'permissions.manage'])

  for (const route of ['tus', 'tusGroup?id=agr_hidden', 'english']) {
    await page.goto(`./#/${route}`)
    await expect(page).toHaveURL(/#\/team(?:\?|$)/)
  }
  await expect(page.getByRole('heading', { name: /Grupy TUS|Angielski/ })).toHaveCount(0)
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

  await expect(page).toHaveURL(/#\/team(?:\?|$)/)
  await expect(page.getByRole('dialog', { name: 'Szukaj w panelu' })).toHaveCount(0)
  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  await expect(navigation.getByRole('link', { name: 'Zespół' }))
    .toHaveAttribute('aria-current', 'page')
})

test('@owner revoking TUS authority closes a dirty activity drawer and shows the safe empty state', async ({ page }) => {
  let refreshed = false
  await page.route('**/api/v1/session', (route) => route.fulfill(sessionEnvelope({
    authorityRevision: refreshed ? 2 : 1,
    capabilities: refreshed
      ? ['appointment.charge.read', 'client.operational.read', 'finance.centre.read', 'permissions.manage', 'specialist.directory.read']
      : ['appointment.charge.read', 'client.operational.read', 'finance.centre.read', 'permissions.manage', 'specialist.directory.read', 'tus.manage'],
  })))
  await page.goto('./#/tus')
  await expect(page.getByRole('heading', { level: 1, name: 'Grupy TUS' })).toBeVisible()

  await page.getByRole('button', { name: 'Nowa grupa' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
  await drawer.getByLabel('Nazwa grupy').fill('Fikcyjny sekret starej władzy')

  refreshed = true
  await page.evaluate(() => window.dispatchEvent(new Event('bwm:test-auth-refresh')))

  await expect(page).toHaveURL(/#\/tus(?:\?|$)/)
  await expect(drawer).toHaveCount(0)
  await expect(page.getByText('Fikcyjny sekret starej władzy')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Grupa została dodana' })).toHaveCount(0)
  await expect(page.getByText('Zajęcia TUS nie są teraz w Twoim zakresie', { exact: true })).toBeVisible()
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
  await page.goto('./#/team?section=access')

  await page.getByRole('button', { name: 'Zmień rolę' }).click()
  const drawer = page.getByRole('dialog', { name: 'Zmień rolę — Celina Widoczna' })
  await drawer.locator('input[name="staff-role"][value="owner"]').check()
  await expect(drawer.getByRole('button', { name: 'Zapisz rolę' })).toBeEnabled()

  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
  refreshed = true
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })

  await expect.poll(() => sessionRequests).toBeGreaterThanOrEqual(2)
  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('alertdialog', { name: 'Wyjść bez zapisywania?' })).toHaveCount(0)
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

  await page.goto('./#/team?section=permissions')
  await expect(page.getByRole('heading', { name: 'Uprawnienia personelu' })).toBeVisible()
  await expect(page.getByText('Wczytuję listę osób…', { exact: true })).toBeVisible()
  releaseFirstTargets()
  await expect(page.getByText('Nie udało się wczytać listy osób. Spróbuj ponownie za chwilę.', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  const targetSelect = page.getByRole('combobox', { name: 'Osoba' })
  await expect(targetSelect.locator('option')).toHaveText([
    'Celina Koordynatorka — Koordynacja i recepcja',
    'Zofia Specjalistka — Prowadzenie terapii / Zespół terapeutyczny',
  ])
  await expect(page.getByText(
    'Nie udało się pobrać uprawnień tej osoby.',
    { exact: true },
  )).toBeVisible()
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()

  await expect(page.getByRole('switch', { name: 'Może importować dane finansowe' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('switch', { name: 'Może zarządzać klientami' })).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('switch', { name: 'Może zarządzać personelem' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toHaveCount(0)
  await expect(page.getByText(/@example\.test/)).toHaveCount(0)
  expect(fullDirectoryRequests).toBe(0)
})

test('@owner shows one immutable base access row for every target role', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const targets = [
    target({ staffId: 'stf_base_owner', displayName: 'Alicja Właścicielka', role: 'owner' }),
    target({ staffId: 'stf_base_coordinator', displayName: 'Celina Koordynatorka', role: 'coordinator' }),
    target({ staffId: 'stf_base_specialist', displayName: 'Zofia Specjalistka', role: 'specialist' }),
  ]
  const authorities = new Map(targets.map((person) => [person.staffId, authorityForTarget(person)]))

  await page.route('**/api/v1/staff/capability-targets', (route) => (
    route.fulfill(json(200, { data: { targets } }))
  ))
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => {
    const staffId = route.request().url().split('/').at(-2)
    return route.fulfill(json(200, { data: { authority: authorities.get(staffId) } }))
  })

  await page.goto('./#/team?section=permissions')
  const targetSelect = page.getByRole('combobox', { name: 'Osoba' })
  for (const person of targets) {
    await targetSelect.selectOption(person.staffId)
    await expect(page.getByText('Dostęp podstawowy: grafik, klienci i sesje', { exact: true })).toBeVisible()
    await expect(page.getByText(
      person.role === 'specialist'
        ? 'Ta osoba widzi tylko własny Grafik, klientów i sesje.'
        : 'Ta osoba widzi Grafik, klientów i sesje całej poradni.',
      { exact: true },
    )).toBeVisible()
  }
  for (const label of [
    'Podgląd rozliczeń sesji',
    'Podgląd klientów i Grafiku',
    'Podgląd katalogu specjalistek',
    'Wiadomości bezpośrednie',
    'Czat ogólny',
    'Zarządzanie kopiami zapasowymi',
    'Przywracanie kopii zapasowych',
    'Zarządzanie centrum',
    'Podgląd danych klinicznych',
    'Zarządzanie kluczami bezpieczeństwa',
  ]) {
    await expect(page.getByRole('switch', { name: label })).toHaveCount(0)
  }
})

test('@owner explains role defaults without speculative access deltas', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const staff = {
    id: 'stf_role_copy_target',
    displayName: 'Celina Koordynatorka',
    email: 'celina@example.test',
    role: 'coordinator',
    status: 'active',
    version: 3,
    specialistId: null,
    invitation: null,
  }
  await page.route('**/api/v1/staff', (route) => (
    route.fulfill(json(200, { data: { staff: [staff] } }))
  ))

  await page.goto('./#/team?section=access')
  await page.getByRole('button', { name: 'Zmień rolę' }).click()
  const drawer = page.getByRole('dialog', { name: 'Zmień rolę — Celina Koordynatorka' })
  await expect(drawer.getByText(
    'Po zapisaniu roli „Koordynacja i recepcja” indywidualne wyjątki uprawnień zostaną usunięte, a domyślne uprawnienia tej roli zaczną obowiązywać.',
    { exact: true },
  )).toBeVisible()
  await drawer.locator('input[name="staff-role"][value="owner"]').check()
  await expect(drawer.getByText(
    'Po zapisaniu roli „Zarządzanie / Właścicielka” indywidualne wyjątki uprawnień zostaną usunięte, a domyślne uprawnienia tej roli zaczną obowiązywać.',
    { exact: true },
  )).toBeVisible()
  await expect(drawer).not.toContainText(/zobaczy|straci/)
})

test('@owner marks the current actor and suppresses self-management actions', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const self = {
    id: DEFAULT_ACTOR.id,
    displayName: DEFAULT_ACTOR.displayName,
    email: DEFAULT_ACTOR.email,
    role: DEFAULT_ACTOR.role,
    status: 'active',
    version: 1,
    specialistId: null,
    invitation: null,
  }
  const other = {
    ...self,
    id: 'stf_other_actor',
    displayName: 'Celina Koordynatorka',
    email: 'celina@example.test',
    role: 'coordinator',
  }
  await page.route('**/api/v1/staff', (route) => (
    route.fulfill(json(200, { data: { staff: [self, other] } }))
  ))

  await page.goto('./#/team?section=access')
  const selfRow = page.locator('.staff-access-row').filter({ hasText: DEFAULT_ACTOR.displayName })
  await expect(selfRow.getByText('To Ty', { exact: true })).toBeVisible()
  await expect(selfRow.getByRole('button', { name: 'Zmień rolę' })).toHaveCount(0)
  await expect(selfRow.getByRole('button', { name: 'Wyłącz dostęp' })).toHaveCount(0)
  const otherRow = page.locator('.staff-access-row').filter({ hasText: other.displayName })
  await expect(otherRow.getByRole('button', { name: 'Zmień rolę' })).toBeVisible()
  await expect(otherRow.getByRole('button', { name: 'Wyłącz dostęp' })).toBeVisible()
})

test('@owner deactivation confirmation states login, data, exceptions, and future invitation requirements', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const staff = {
    id: 'stf_deactivate_copy_target',
    displayName: 'Celina Koordynatorka',
    email: 'celina@example.test',
    role: 'coordinator',
    status: 'active',
    version: 3,
    specialistId: null,
    invitation: null,
  }
  await page.route('**/api/v1/staff', (route) => (
    route.fulfill(json(200, { data: { staff: [staff] } }))
  ))

  await page.goto('./#/team?section=access')
  await page.getByRole('button', { name: 'Wyłącz dostęp' }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Wyłącz dostęp' })
  await expect(confirmation).toContainText('ta osoba nie będzie mogła zalogować się do panelu')
  await expect(confirmation).toContainText('Sesje, klienci i historia pozostaną bez zmian.')
  await expect(confirmation).toContainText('Indywidualne wyjątki uprawnień zostaną usunięte.')
  await expect(confirmation).toContainText('Przyszły dostęp będzie wymagał nowego zaproszenia.')
  await expect(confirmation).not.toContainText(/przywróc|odzyska/)
})

test('@owner shows no permission toggles for a disabled target and marks it without access', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const disabledTarget = target({
    staffId: 'stf_disabled_target',
    displayName: 'Celina Wyłączona',
    status: 'disabled',
  })
  await page.route('**/api/v1/staff/capability-targets', (route) => (
    route.fulfill(json(200, { data: { targets: [disabledTarget] } }))
  ))
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => (
    route.fulfill(json(200, { data: { authority: authorityForTarget(disabledTarget) } }))
  ))

  await page.goto('./#/team?section=permissions')
  await expect(page.getByRole('combobox', { name: 'Osoba' })).toHaveText([
    'Celina Wyłączona — Koordynacja i recepcja (bez dostępu)',
  ])
  await expect(page.getByText(
    'Ta osoba nie ma dostępu do panelu. Może otrzymać nowe zaproszenie.',
    { exact: true },
  )).toBeVisible()
  await expect(page.getByRole('switch')).toHaveCount(0)
})

test('@owner restores every denied base access exception without changing the API contract', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const permissionTarget = target({ staffId: 'stf_base_damaged' })
  const deniedBaseAccess = [
    'appointment.charge.read',
    'client.operational.read',
    'specialist.directory.read',
  ]
  let mutation

  await page.route('**/api/v1/staff/capability-targets', (route) => (
    route.fulfill(json(200, { data: { targets: [permissionTarget] } }))
  ))
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => {
    if (route.request().method() === 'POST') {
      mutation = route.request().postDataJSON()
      return route.fulfill(json(200, {
        data: { authority: authorityForTarget(permissionTarget, {
          allow: ['finance.import'], deny: ['client.manage'],
        }) },
      }))
    }
    return route.fulfill(json(200, {
      data: { authority: authorityForTarget(permissionTarget, {
        allow: ['finance.import'],
        deny: ['appointment.charge.read', 'client.manage', ...deniedBaseAccess.slice(1)],
      }) },
    }))
  })

  await page.goto(`./#/team?section=permissions&staffId=${permissionTarget.staffId}`)
  await expect(page.getByText('Uprawnienia odbiegają od roli', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Przywróć ustawienia roli' }).click()

  await expect(page.getByText('Uprawnienia odbiegają od roli', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Zapisz uprawnienia' })).toBeEnabled()
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()
  await expect.poll(() => mutation).toEqual({
    expectedAuthorityRevision: 3,
    allow: [],
    deny: [],
  })
})

test('@owner can hide coordinator finances and restore the clean role defaults', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const permissionTarget = target({
    staffId: 'stf_coordinator_finances',
    displayName: 'Celina Recepcja',
  })
  const mutations = []
  let authority = authorityForTarget(permissionTarget)

  await page.route('**/api/v1/staff/capability-targets', (route) => (
    route.fulfill(json(200, { data: { targets: [permissionTarget] } }))
  ))
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON()
      mutations.push(payload)
      authority = {
        ...authorityForTarget(permissionTarget, payload),
        authorityRevision: payload.expectedAuthorityRevision + 1,
      }
    }
    return route.fulfill(json(200, { data: { authority } }))
  })

  await page.goto(`./#/team?section=permissions&staffId=${permissionTarget.staffId}`)
  await expect(page.locator('.permissions-access__group legend')).toHaveText([
    'Może: Grafik i sesje',
    'Może: Klienci',
    'Może: Finanse',
    'Może: Administracja',
  ])

  const finance = page.getByRole('switch', { name: 'Widzi finanse całej poradni' })
  await expect(finance).toHaveAttribute('aria-checked', 'true')
  await finance.click()
  await expect(page.getByText('Uprawnienia odbiegają od roli', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()
  await expect.poll(() => mutations).toEqual([{
    expectedAuthorityRevision: 3,
    allow: [],
    deny: ['finance.centre.read'],
  }])

  await expect(page.getByText('Uprawnienia odbiegają od roli', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Przywróć ustawienia roli' }).click()
  await expect(page.getByText('Uprawnienia odbiegają od roli', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()
  await expect.poll(() => mutations).toEqual([
    {
      expectedAuthorityRevision: 3,
      allow: [],
      deny: ['finance.centre.read'],
    },
    {
      expectedAuthorityRevision: 4,
      allow: [],
      deny: [],
    },
  ])
})

test('@owner refreshes permission targets behind the saved editor', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  let targetRequests = 0
  let markRefreshStarted
  let releaseRefresh
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve })
  const refreshHeld = new Promise((resolve) => { releaseRefresh = resolve })
  const firstTarget = target()
  const permissionTarget = target({
    staffId: 'stf_capability_zofia',
    displayName: 'Zofia Koordynatorka',
  })
  const insertedTarget = target({
    staffId: 'stf_capability_alicja',
    displayName: 'Alicja Nowa',
  })
  const authority = (overrides = {}) => ({
    ...coordinatorAuthority(overrides),
    staffId: permissionTarget.staffId,
    displayName: permissionTarget.displayName,
    role: permissionTarget.role,
  })

  await page.route('**/api/v1/staff/capability-targets', async (route) => {
    targetRequests += 1
    if (targetRequests === 2) {
      markRefreshStarted()
      await refreshHeld
    }
    await route.fulfill(json(200, {
      data: { targets: targetRequests === 1
        ? [firstTarget, permissionTarget]
        : [insertedTarget, firstTarget, permissionTarget] },
    }))
  })
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill(json(200, {
        data: { authority: authority({ deny: ['appointment.manage', 'client.manage'] }) },
      }))
    }
    return route.fulfill(json(200, { data: { authority: authority() } }))
  })

  await page.goto('./#/team?section=permissions')
  const targetSelect = page.getByRole('combobox', { name: 'Osoba' })
  await targetSelect.selectOption(permissionTarget.staffId)
  await expect(page).toHaveURL(`#\/team?section=permissions&staffId=${permissionTarget.staffId}`)
  const appointments = page.getByRole('switch', { name: 'Może zarządzać sesjami' })
  await appointments.click()
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()

  await refreshStarted
  await expect(appointments).toHaveAttribute('aria-checked', 'false')
  await expect(targetSelect).toHaveValue(permissionTarget.staffId)
  await expect(page.getByText('Zofia Koordynatorka', { exact: true })).toBeVisible()
  await expect(page.getByText('Wczytuję listę osób…', { exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(`#\/team?section=permissions&staffId=${permissionTarget.staffId}`)
  await expect(page.locator('.toast')).toHaveText('Uprawnienia zostały zapisane · Zofia Koordynatorka')
  releaseRefresh()
  await expect(targetSelect.locator('option')).toHaveText([
    'Alicja Nowa — Koordynacja i recepcja',
    'Celina Koordynatorka — Koordynacja i recepcja',
    'Zofia Koordynatorka — Koordynacja i recepcja',
  ])
  await expect(targetSelect).toHaveValue(permissionTarget.staffId)
  await page.goto('./#/settings')
  await expect(page).toHaveURL('#/settings')
})

test('@owner keeps permission selection visible when its background refresh fails', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  let targetRequests = 0
  const permissionTarget = target()
  const secondTarget = target({
    staffId: 'stf_capability_zofia',
    displayName: 'Zofia Specjalistka',
    role: 'specialist',
  })

  await page.route('**/api/v1/staff/capability-targets', (route) => {
    targetRequests += 1
    return targetRequests === 1
      ? route.fulfill(json(200, { data: { targets: [permissionTarget, secondTarget] } }))
      : route.fulfill(errorEnvelope(500, 'INTERNAL_ERROR'))
  })
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill(json(200, {
        data: { authority: coordinatorAuthority({ deny: ['appointment.manage', 'client.manage'] }) },
      }))
    }
    return route.fulfill(json(200, { data: { authority: coordinatorAuthority() } }))
  })

  await page.goto(`./#/team?section=permissions&staffId=${permissionTarget.staffId}`)
  const appointments = page.getByRole('switch', { name: 'Może zarządzać sesjami' })
  await appointments.click()
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()

  await expect.poll(() => targetRequests).toBe(2)
  await expect(appointments).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('combobox', { name: 'Osoba' })).toHaveValue(permissionTarget.staffId)
  await expect(page.getByText('Wczytuję listę osób…', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Nie udało się wczytać listy osób. Spróbuj ponownie za chwilę.', { exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(`#\/team?section=permissions&staffId=${permissionTarget.staffId}`)
})

test('@owner guards dirty permission edits when switching settings sections', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const permissionTarget = target()

  await page.route('**/api/v1/staff/capability-targets', (route) => (
    route.fulfill(json(200, { data: { targets: [permissionTarget] } }))
  ))
  await page.route(/\/api\/v1\/staff\/[^/]+\/capability-overrides(?:\/edits)?$/, (route) => (
    route.fulfill(json(200, { data: { authority: coordinatorAuthority() } }))
  ))

  await page.goto('./#/team?section=permissions')
  const appointments = page.getByRole('switch', { name: 'Może zarządzać sesjami' })
  await expect(appointments).toHaveAttribute('aria-checked', 'true')
  await appointments.click()

  const sections = page.getByRole('tablist', { name: 'Obszary zespołu' })
  await sections.getByRole('tab', { name: 'Dostęp' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Wyjść bez zapisywania?' })
  await expect(confirm).toBeVisible()
  const stayEditing = confirm.getByRole('button', { name: 'Wróć do edycji' })
  const leaveWithoutSaving = confirm.getByRole('button', { name: 'Wyjdź bez zapisywania' })
  await expect(stayEditing).toBeFocused()
  expect(await confirm.locator('button').evaluateAll((buttons) => buttons.map((button) => button.textContent))).toEqual([
    'Wróć do edycji',
    'Wyjdź bez zapisywania',
  ])
  await expect(page.getByRole('heading', { name: 'Uprawnienia personelu' })).toBeVisible()
  await stayEditing.click()
  await expect(appointments).toHaveAttribute('aria-checked', 'false')
  await sections.getByRole('tab', { name: 'Dostęp' }).click()
  await confirm.getByRole('button', { name: 'Wyjdź bez zapisywania' }).click()
  const staffHeading = page.getByRole('heading', { name: 'Dostęp personelu' })
  await expect(staffHeading).toBeVisible()
  await expect(staffHeading).toBeFocused()

  await sections.getByRole('tab', { name: 'Uprawnienia' }).click()
  await expect(page.getByRole('switch', { name: 'Może zarządzać sesjami' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('switch', { name: 'Może zarządzać sesjami' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const select = page.getByRole('tab', { name: 'Dostęp' })
  await select.click()
  await expect(confirm).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Uprawnienia personelu' })).toBeVisible()
  await confirm.getByRole('button', { name: 'Wróć do edycji' }).click()
  await expect(page.getByRole('switch', { name: 'Może zarządzać sesjami' })).toHaveAttribute('aria-checked', 'false')
  await select.click()
  await confirm.getByRole('button', { name: 'Wyjdź bez zapisywania' }).click()
  await expect(staffHeading).toBeVisible()
  await expect(staffHeading).toBeFocused()
})

test('@owner self-target permission save preserves its URL selection and confirmation through authority remount', async ({ page }) => {
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

  await page.goto(`./#/team?section=permissions&staffId=${actor.id}`)
  const staffPermission = page.getByRole('switch', { name: 'Może zarządzać personelem' })
  const constitutional = page.getByRole('switch', { name: 'Może zarządzać uprawnieniami' })
  await expect(page.getByText('Zmieniasz własne uprawnienia', { exact: true })).toBeVisible()
  await expect(staffPermission).toHaveAttribute('aria-checked', 'true')
  await expect(constitutional).toHaveAttribute('aria-checked', 'true')
  await expect(constitutional).toBeDisabled()

  await staffPermission.click()
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()

  await expect(page.getByRole('heading', { name: 'Uprawnienia personelu' })).toBeVisible()
  await expect(page).toHaveURL(`#\/team?section=permissions&staffId=${actor.id}`)
  await expect(page.locator('.toast')).toHaveText('Uprawnienia zostały zapisane · Alicja Uprawniona')
  await expect(page.getByText('Zapisano', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Dostęp personelu' })).toHaveCount(0)
  await expect(page.getByRole('switch', { name: 'Może zarządzać personelem' })).toHaveAttribute('aria-checked', 'false')
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
          deny: ['appointment.manage', 'client.manage'],
        }),
      },
    }))
  })

  await page.goto('./#/team?section=permissions')
  await page.getByRole('switch', { name: 'Może zarządzać sesjami' }).click()
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()
  await expect(page.getByText(
    'Nie mamy pewności, czy zmiany się zapisały. Kliknij „Spróbuj ponownie”, niczego nie zmieniając.',
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
    deny: ['appointment.manage', 'client.manage'],
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
            ? { authorityRevision: 4, deny: ['appointment.manage', 'client.manage'] }
            : { authorityRevision: 3 }),
        },
      }))
    }
    mutationBodies.push(request.postDataJSON())
    externalChange = true
    return route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
  })

  await page.goto('./#/team?section=permissions')
  const appointments = page.getByRole('switch', { name: 'Może zarządzać sesjami' })
  await expect(appointments).toHaveAttribute('aria-checked', 'true')
  await appointments.click()
  await page.getByRole('button', { name: 'Zapisz uprawnienia' }).click()

  await expect(page.getByText(
    'Ktoś w międzyczasie zmienił uprawnienia tej osoby. Twoja zmiana nie została zapisana. Widzisz teraz aktualne ustawienia.',
    { exact: true },
  )).toBeVisible()
  await expect(appointments).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('button', { name: 'Zapisz uprawnienia' })).toBeDisabled()
  expect(detailRequests).toBe(2)
  expect(mutationBodies).toEqual([{
    expectedAuthorityRevision: 3,
    allow: ['finance.import'],
    deny: ['appointment.manage', 'client.manage'],
  }])
})
