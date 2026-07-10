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

test('the mock-data workspace opens after login', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('heading', { name: /Dziś|Dobry/ })).toBeVisible()
})

test('therapist demo mode narrows navigation to daily care work', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await expect(page.getByRole('navigation')).toContainText('Mój dzień')
  await expect(page.getByRole('navigation')).not.toContainText('Finanse')
  await expect(page.getByRole('navigation')).not.toContainText('Raporty')
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
  await page.getByRole('button', { name: 'Zespół →' }).click()
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

test('Today prioritises the next action above monthly metrics', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('region', { name: /Teraz lub następna sesja/ })).toBeVisible()
  await expect(page.getByRole('region', { name: /Wymaga uwagi/ })).toBeVisible()
  await expect(page.getByRole('region', { name: /Plan dnia/ })).toBeVisible()
})

test('Today limits the day plan to the therapist and keeps practice status owner-only', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('region', { name: 'Stan praktyki' })).toBeVisible()

  await switchToTherapist(page)
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await expect(plan).not.toContainText('Julia Wolanin')
  await expect(page.getByRole('region', { name: 'Stan praktyki' })).toHaveCount(0)
})

test('therapist Today omits all-team board posts and controls', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)

  await expect(page.getByText('Tablica zespołu', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Nowy wpis na tablicy')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Usuń wpis' })).toHaveCount(0)
  await expect(page.getByText(/Superwizja zespołowa/)).toHaveCount(0)
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

test('calendar combines date, payment, and attendance filters after role scope', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Nieopłacone' }).click()
  await page.getByRole('button', { name: 'Nieobecny' }).click()
  const agenda = page.getByRole('region', { name: /Plan dnia/ })
  await expect(agenda.locator('[data-payment="unpaid"][data-attendance="noshow"]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Wyczyść filtry' }).click()
  const more = agenda.getByRole('button', { name: /Jeszcze/ })
  await expect(more).toBeVisible()
  await more.click()
  await expect(more).toHaveCount(0)
  expect(await agenda.locator('.agenda__row').count()).toBeGreaterThan(4)
})

test('therapist agenda excludes other therapists and payment updates stay coherent', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /Tryb demonstracyjny/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Marta Zielińska/ }).click()
  await page.getByRole('navigation').getByRole('button', { name: 'Mój kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Mój kalendarz' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: /Plan dnia/ }).locator('[data-psych-id="p1"]')).toHaveCount(0)
})

test('custom month range dims the selected out-of-range day and filters its sessions', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('radio', { name: 'Miesiąc' }).click()

  const { dateFrom, dateTo, selectedDate } = await page.evaluate(() => {
    const format = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
    const selected = new Date()
    const start = new Date(selected)
    const end = new Date(selected)
    if (selected.getDate() <= 2) {
      start.setDate(3)
      end.setDate(4)
    } else {
      start.setDate(1)
      end.setDate(2)
    }
    return { dateFrom: format(start), dateTo: format(end), selectedDate: format(selected) }
  })

  await page.getByRole('textbox', { name: 'Od', exact: true }).fill(dateFrom)
  await page.getByRole('textbox', { name: 'Do', exact: true }).fill(dateTo)
  const selectedDay = page.locator(`.cal__day[data-iso="${selectedDate}"]`)
  await expect(selectedDay).toHaveClass(/is-filtered-out/)
  await expect(selectedDay).toHaveCSS('opacity', '0.48')
  await expect(selectedDay.locator('.cal__item')).toHaveCount(0)
})
