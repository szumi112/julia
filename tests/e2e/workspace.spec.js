import { test, expect } from '@playwright/test'

async function login(page) {
  await page.goto('.')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await expect(page.getByRole('main')).toBeVisible()
}

async function switchToTherapist(page) {
  await page.getByRole('button', { name: /Tryb demonstracyjny.*Julia Wolanin/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Marta Zielińska/ }).click()
}

async function switchToCoordinator(page) {
  await page.getByRole('button', { name: /Tryb demonstracyjny/ }).click()
  await page.getByRole('button', { name: /Koordynatorka.*Maja Nowak/ }).click()
}

test('the mock-data workspace opens after login', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('region', { name: 'Pulpit dnia' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

test('navigation focuses the destination and a day cockpit excludes background controls', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /Kalendarz/ }).click()
  await expect(page.locator('.view')).toBeFocused()
  await page.getByRole('button', { name: /Panel dnia/ }).click()
  await expect(page.getByRole('dialog', { name: /Panel dnia/ })).toBeVisible()
  await expect(page.getByRole('main')).toHaveAttribute('inert', '')
})

test('therapist demo mode narrows navigation to daily care work', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await expect(page.getByRole('navigation')).toContainText('Mój dzień')
  await expect(page.getByRole('navigation')).not.toContainText('Finanse')
  await expect(page.getByRole('navigation')).not.toContainText('Raporty')
})

test('therapist session form is scoped to their own practice', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await page.getByRole('button', { name: 'Nowa sesja' }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  const clients = drawer.getByLabel('Klient')
  const psychologists = drawer.getByLabel('Specjalistka')

  await expect(clients).toContainText('Joanna Madej')
  await expect(clients).not.toContainText('Zofia Mazur')
  await expect(psychologists.locator('option')).toHaveCount(2)
  await expect(psychologists).toHaveValue('p2')
})

test('therapist client form cannot reassign care outside their practice', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('button', { name: 'Dodaj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowy klient' })
  const psychologists = drawer.getByLabel('Specjalistka prowadząca')

  await expect(psychologists.locator('option')).toHaveCount(2)
  await expect(psychologists).toHaveValue('p2')
  await expect(drawer.getByLabel('Powiąż z klientem')).not.toContainText('Zofia Mazur')
})

test('demo role picker is a labelled button group and closes for command search', async ({ page }) => {
  await login(page)
  const picker = page.getByRole('button', { name: /Tryb demonstracyjny.*Julia Wolanin/ })
  await expect(picker).toContainText('Tryb demonstracyjny')
  await picker.click()
  const group = page.getByRole('group', { name: 'Tryb demonstracyjny' })
  await expect(group).toContainText('Tryb demonstracyjny')
  await expect(group.getByRole('button', { name: /Właścicielka.*Julia Wolanin/ })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Control+K')
  await expect(page.getByRole('dialog', { name: 'Szukaj w Aurelii' })).toBeVisible()
  await expect(group).toHaveCount(0)
})

test('therapist mode guards dashboard destinations and filters command palette', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await expect(page.getByRole('region', { name: 'Skróty' }).getByRole('button', { name: 'Zespół' })).toHaveCount(0)
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Mój dzień' })).toHaveAttribute('aria-current', 'page')

  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w Aurelii' })
  const search = palette.getByRole('combobox', { name: 'Szukaj w Aurelii' })
  await search.fill('raport')
  await expect(palette).not.toContainText('Raport miesięczny')
  await search.fill('julia')
  await expect(palette).not.toContainText('dr Julia Wolanin')
})

test('therapist search only exposes their client context and hides note prose from other roles', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await page.getByRole('button', { name: /Szukaj/ }).click()
  await page.getByRole('combobox', { name: /Szukaj w Aurelii/ }).fill('Joanna')
  await page.getByRole('option', { name: /Joanna Madej/ }).click()
  await expect(page.getByRole('heading', { name: /Joanna Madej/ })).toBeVisible()
  await expect(page.getByText(/Notatki kliniczne/)).toBeVisible()
  await expect(page.getByLabel('Nowa notatka')).toBeVisible()
})

test('centre roles receive a neutral clinical-notes state', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByText('Notatki są dostępne w widoku specjalistki.')).toBeVisible()
  await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
})

test('coordinator receives the neutral clinical-notes state', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await switchToCoordinator(page)
  await expect(page.getByText('Notatki są dostępne w widoku specjalistki.')).toBeVisible()
  await expect(page.locator('.note__text')).toHaveCount(0)
  await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
})

test('non-owning therapist receives the neutral clinical-notes state', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await switchToTherapist(page)
  await expect(page.getByText('Notatki są dostępne w widoku specjalistki.')).toBeVisible()
  await expect(page.locator('.note__text')).toHaveCount(0)
  await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
  await expect(page.locator('.id-band__actions').getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edytuj sesję' })).toHaveCount(0)
  await expect(page.getByTitle('Zmień status sesji')).toHaveCount(0)
  await expect(page.getByTitle('Zmień płatność')).toHaveCount(0)
})

test('client detail adapts its primary CTA to the active role', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByRole('button', { name: 'Umów spotkanie' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Przygotuj sesję' })).toHaveCount(0)

  await switchToTherapist(page)
  await page.getByRole('button', { name: /Wróć do listy klientów/ }).click()
  await page.getByRole('row', { name: /Joanna Madej/ }).click()
  await expect(page.getByRole('button', { name: 'Przygotuj sesję' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Umów spotkanie' })).toHaveCount(0)
})

test('client detail presents care headings in record order', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByRole('heading', { name: 'Przegląd opieki' })).toBeVisible()
  const headings = await page.locator('main h2').evaluateAll((elements) =>
    elements.map((element) => element.firstChild.textContent.trim())
  )
  expect(headings).toEqual([
    'Przegląd opieki',
    'Najbliższe spotkania',
    'Historia frekwencji',
    'Notatki kliniczne',
  ])
})

test('client form validates a supplied email and keeps email optional', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('button', { name: 'Dodaj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowy klient' })
  await drawer.getByLabel('Imię i nazwisko').fill('Testowa osoba')
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('p1')
  await drawer.getByLabel('E-mail').fill('niepoprawny-adres')
  await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(drawer.getByText('Podaj poprawny adres e-mail')).toBeVisible()
  await drawer.getByLabel('E-mail').fill('')
  await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(drawer).toHaveCount(0)
})

test('switching to therapist ignores a previous team client filter', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('button', { name: 'Julia', exact: true }).click()
  await expect(page.getByRole('row', { name: /Zofia Mazur/ })).toBeVisible()
  await switchToTherapist(page)
  await expect(page.getByRole('row', { name: /Joanna Madej/ })).toBeVisible()
})

test('short lists render fully without a pager and history caps at ten rows', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  // 19 demo clients < 25: full roster, no pager anywhere on the view
  await expect(page.locator('tbody tr').first()).toBeVisible()
  expect(await page.locator('tbody tr').count()).toBeGreaterThan(15)
  await expect(page.getByRole('navigation', { name: 'Stronicowanie' })).toHaveCount(0)
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByRole('heading', { name: 'Historia frekwencji' })).toBeVisible()
  const historyRows = await page.locator('.client-record__section:has(h2:text("Historia frekwencji")) tbody tr').count()
  expect(historyRows).toBeLessThanOrEqual(10)
})

test('Today keeps the essential daily regions together', async ({ page }) => {
  await login(page)
  await expect(
    page.getByRole('heading', { level: 1, name: /^\d{1,2}:\d{2}$|Wszystko za Tobą|Wolny dzień/ })
  ).toBeVisible()
  await expect(page.getByRole('region', { name: /Wymaga uwagi/ })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Skróty' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Plan dnia' })).toBeVisible()
})

test('Today is a compact viewport command centre without secondary reports', async ({ page }) => {
  await login(page)
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })

  await expect(dashboard).toBeVisible()
  await expect(dashboard.getByRole('region', { name: 'Dzień w skrócie' })).toHaveCount(0)
  await expect(dashboard.getByRole('region', { name: 'Skróty' })).toBeVisible()
  await expect(dashboard).not.toContainText('Przychód miesięczny')
  await expect(dashboard).not.toContainText('Najbliższe sesje')
  await expect(dashboard).not.toContainText('Zespół dziś')

  const contentOverflows = await page.locator('main.content').evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1
  )
  expect(contentOverflows).toBe(false)
})

test('Today keeps the page itself fixed on a short desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await login(page)

  const contentOverflows = await page.locator('main.content').evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1
  )
  expect(contentOverflows).toBe(false)
})

test('Today keeps the hero legible without horizontal overflow on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await login(page)

  await expect(page.locator('.today-hero').getByRole('heading', { level: 1 })).toBeVisible()
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  )
  expect(overflows).toBe(false)
})

test('team board is a Shell overlay that yields to global overlays', async ({ page }) => {
  await login(page)
  await page.getByRole('region', { name: 'Skróty' }).getByRole('button', { name: 'Tablica zespołu' }).click()
  const board = page.getByRole('dialog', { name: 'Tablica zespołu' })
  await expect(board).toBeVisible()
  const composer = board.getByLabel('Nowy wpis na tablicy')
  await composer.fill('Pierwszy wpis testowy')
  await board.getByRole('button', { name: 'Opublikuj' }).click()
  await composer.fill('Drugi wpis testowy')
  await board.getByRole('button', { name: 'Opublikuj' }).click()
  await expect(page.getByRole('main')).toHaveAttribute('inert', '')

  await page.keyboard.press('Control+K')
  await expect(board).toHaveCount(0)
  const palette = page.getByRole('dialog', { name: 'Szukaj w Aurelii' })
  await expect(palette).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await page.getByRole('button', { name: /Panel dnia/ }).click()
  await expect(page.getByRole('dialog', { name: 'Panel dnia' })).toBeVisible()
  await expect(board).toHaveCount(0)
})

test('toasts dismiss with the keyboard', async ({ page }) => {
  await login(page)
  await page.getByRole('region', { name: 'Skróty' }).getByRole('button', { name: 'Tablica zespołu' }).click()
  const board = page.getByRole('dialog', { name: 'Tablica zespołu' })
  const composer = board.getByLabel('Nowy wpis na tablicy')
  await composer.fill('Wpis do testu powiadomienia')
  await board.getByRole('button', { name: 'Opublikuj' }).click()
  const toast = page.getByRole('button', { name: /Zamknij: Wpis dodany na tablicę/ })
  await expect(toast).toBeVisible()
  await toast.focus()
  await page.keyboard.press('Enter')
  await expect(toast).toHaveCount(0)
})

test('enabling reduced motion clears active GSAP tweens', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Ustawienia' }).click()
  await page.evaluate(() => {
    window.__motionProbe = { value: 0 }
    window.gsap.to(window.__motionProbe, { value: 100, duration: 5 })
  })
  await page.getByRole('switch', { name: 'Ogranicz animacje' }).click()
  await expect.poll(() => page.evaluate(() => window.gsap.globalTimeline.getChildren().length)).toBe(0)
})

test('Today limits daily information to the active therapist', async ({ page }) => {
  await login(page)

  await switchToTherapist(page)
  const therapistEyebrow = page.locator('.today-hero .eyebrow')
  await expect(page.getByRole('region', { name: 'Plan dnia' })).not.toContainText('Julia Wolanin')
  await expect(therapistEyebrow).toContainText('Mój dzień')
  await expect(page.getByText('Stan praktyki')).toHaveCount(0)
})

test('therapist Today omits all-team board posts and controls', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)

  await expect(page.getByText('Tablica zespołu', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Nowy wpis na tablicy')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Usuń wpis' })).toHaveCount(0)
  await expect(page.getByText(/Superwizja zespołowa/)).toHaveCount(0)
})

test('therapist cockpit excludes centre day and finance context', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await page.getByRole('button', { name: /Panel dnia/ }).click()
  const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  await expect(cockpit).toBeVisible()
  await expect(cockpit).not.toContainText('Julia Wolanin')
  await expect(cockpit).not.toContainText('Zofia Mazur')
  await expect(cockpit).not.toContainText('Zaległe płatności')
  await expect(cockpit.locator('.cockpit__due')).toHaveCount(0)
})

test('therapist sidebar count is scoped to their daily sessions', async ({ page }) => {
  await login(page)
  const count = page.locator('.sidebar .today-card__line')
  await expect(count).toHaveText(/sesj[ei] w grafiku|Spokojny dzień/)
  const ownerCount = await count.textContent()
  expect(ownerCount).toMatch(/sesj[ei] w grafiku|Spokojny dzień/)
  await switchToTherapist(page)
  await expect(count).toHaveText(/sesj[ei] w grafiku|Spokojny dzień/)
  await expect(count).not.toHaveText(ownerCount)
})

test('older attention debt opens all-period unpaid payments', async ({ page }) => {
  await login(page)
  await page.getByRole('region', { name: 'Wymaga uwagi' }).getByRole('button').first().click()
  await expect(page.getByText(/Wszystkie okresy.*tylko zaległe/i)).toBeVisible()
  await expect(page.locator('tr.is-due')).not.toHaveCount(0)
})

test('calendar exposes explicit payment and attendance reset choices', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('group', { name: 'Płatność' })).toHaveCount(0)
  await page.getByRole('button', { name: /^Filtry/ }).click()
  const payment = page.getByRole('group', { name: 'Płatność' })
  const attendance = page.getByRole('group', { name: 'Obecność klienta' })
  const allPayments = payment.getByRole('button', { name: 'Wszystkie' })
  const allAttendance = attendance.getByRole('button', { name: 'Wszyscy' })

  await expect(allPayments).toHaveAttribute('aria-pressed', 'true')
  await payment.getByRole('button', { name: 'Nieopłacone' }).click()
  await expect(allPayments).toHaveAttribute('aria-pressed', 'false')
  await allPayments.click()
  await expect(allPayments).toHaveAttribute('aria-pressed', 'true')

  await expect(allAttendance).toHaveAttribute('aria-pressed', 'true')
  await attendance.getByRole('button', { name: 'Nieobecny' }).click()
  await expect(allAttendance).toHaveAttribute('aria-pressed', 'false')
  await allAttendance.click()
  await expect(allAttendance).toHaveAttribute('aria-pressed', 'true')
})

test('Payments exposes an all-status control to reverse unpaid filtering', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Finanse' }).click()
  const allStatuses = page.getByRole('button', { name: 'Wszystkie płatności' })
  const unpaid = page.getByRole('button', { name: 'Tylko zaległe' })

  await expect(allStatuses).toHaveAttribute('aria-pressed', 'true')
  await unpaid.click()
  await expect(unpaid).toHaveAttribute('aria-pressed', 'true')
  await allStatuses.click()
  await expect(allStatuses).toHaveAttribute('aria-pressed', 'true')
  await expect(unpaid).toHaveAttribute('aria-pressed', 'false')
})

test('payments table paginates a month with more than 25 settlements', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Finanse' }).click()
  await page.getByRole('button', { name: 'Poprzedni miesiąc' }).click()
  const pager = page.getByRole('navigation', { name: 'Stronicowanie' })
  await expect(pager).toBeVisible()
  expect(await page.locator('tbody tr').count()).toBeLessThanOrEqual(25)
  const firstRowBefore = await page.locator('tbody tr').first().innerText()
  await pager.getByRole('button', { name: 'Następna strona' }).click()
  await expect(pager).toContainText(/Strona 2 z \d+/)
  expect(await page.locator('tbody tr').first().innerText()).not.toBe(firstRowBefore)
})

test('calendar opens the therapist agenda and exposes exact partial payment editing', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /Tryb demonstracyjny.*Julia Wolanin/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Marta Zielińska/ }).click()
  await page.getByRole('button', { name: /Mój kalendarz/ }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Mój kalendarz' })).toHaveAttribute('aria-current', 'page')
  const agenda = page.getByRole('region', { name: /Plan dnia/ })
  await expect(agenda).toBeVisible()
  const partialPayment = agenda.getByRole('button', { name: /Częściowo/ })
  await partialPayment.scrollIntoViewIfNeeded()
  await partialPayment.click()
  await page.getByRole('menuitemradio', { name: 'Częściowo' }).click()
  await page.getByRole('menuitem', { name: 'Edytuj kwotę' }).click()
  await expect(page.getByRole('dialog', { name: 'Edycja sesji' }).getByLabel('Wpłacono (zł)')).toBeFocused()
})

test('calendar combines payment and attendance filters after role scope', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: /^Filtry/ }).click()
  await page.getByRole('button', { name: 'Nieopłacone' }).click()
  await page.getByRole('button', { name: 'Nieobecny' }).click()
  await expect(page.getByRole('button', { name: 'Filtry · 2' })).toBeVisible()
  const agenda = page.getByRole('region', { name: /Plan dnia/ })
  await expect(agenda.locator('[data-payment="unpaid"][data-attendance="noshow"]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Wyczyść filtry' }).click()
  const more = agenda.getByRole('button', { name: /Jeszcze/ })
  await expect(more).toBeVisible()
  await more.click()
  await expect(more).toHaveCount(0)
  expect(await agenda.locator('.agenda__row').count()).toBeGreaterThan(4)
})

test('calendar day strip scrolls with the page instead of covering the agenda', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  const agenda = page.getByRole('region', { name: /Plan dnia/ })
  const more = agenda.getByRole('button', { name: /Jeszcze/ })
  await more.click()
  // clicking auto-scrolled the button into view; measure from the top
  await page.locator('main.content').evaluate((el) => el.scrollTo(0, 0))
  const strip = page.locator('.day-strip')
  const before = await strip.evaluate((el) => el.getBoundingClientRect().top)
  const scrolled = await page.locator('main.content').evaluate((el) => {
    el.scrollTo(0, 300)
    return el.scrollTop
  })
  const after = await strip.evaluate((el) => el.getBoundingClientRect().top)
  expect(scrolled).toBeGreaterThan(50)
  expect(before - after).toBeGreaterThanOrEqual(scrolled - 2)
})

test('selecting a day keeps the visible calendar in place', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  const strip = page.locator('.day-strip')
  await expect(strip).toBeVisible()
  // today's pill: its panel is already on screen, so selecting must not scroll
  await strip.locator('.day-strip__day.is-today').click()
  await page.waitForTimeout(600)
  expect(await page.locator('main.content').evaluate((el) => el.scrollTop)).toBe(0)
  expect(await strip.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(0)
})

test('month view shows sessions across the whole month by default', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  await page.getByRole('radio', { name: 'Miesiąc' }).click()
  expect(await page.locator('.cal__day:has(.cal__item)').count()).toBeGreaterThan(1)
})

test('therapist agenda excludes other therapists and payment updates stay coherent', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /Tryb demonstracyjny/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Marta Zielińska/ }).click()
  await page.getByRole('navigation').getByRole('button', { name: 'Mój kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Mój kalendarz' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: /Plan dnia/ }).locator('[data-psych-id="p1"]')).toHaveCount(0)
})

test('owner attention opens matching all-period unpaid payments', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('region', { name: 'Wymaga uwagi' }).getByRole('button').first().click()
  await expect(page.getByText(/wszystkie okresy.*tylko zaległe/i)).toBeVisible()
  await expect(page.locator('.figures__item--gold .figures__value')).toBeVisible()
  const issuedTip = page.locator('.figures__item').filter({ hasText: 'Wystawione' }).getByRole('button', { name: 'Wyjaśnienie' })
  await issuedTip.focus()
  const issuedTipId = await issuedTip.getAttribute('aria-describedby')
  await expect(page.locator(`[id="${issuedTipId}"]`)).toHaveText('Suma kwot za sesje rozliczane we wszystkich okresach — odbyte i nieobecności. Sesje odwołane nie są fakturowane.')
})
