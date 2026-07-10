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

async function openGroup(page, name) {
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible()
}

test('owner reviews TUS groups and toggles attendance', async ({ page }) => {
  await login(page)
  await openGroup(page, 'Grupa TUS 5–6 lat')
  const cell = page.locator('.att:not([disabled])').first()
  const pressed = await cell.getAttribute('aria-pressed')
  await cell.click()
  await expect(cell).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true')
})

test('owner books a TUS payment from the month list', async ({ page }) => {
  await login(page)
  await openGroup(page, 'Grupa TUS 5–6 lat')
  const payments = page.locator('.card').filter({ hasText: /Płatności ·/ })
  await expect(payments).toBeVisible()
  const bookButtons = payments.getByRole('button', { name: 'Zaksięguj' })
  const dueBefore = await bookButtons.count()
  test.skip(dueBefore === 0, 'seeded month happens to be fully paid')
  await bookButtons.first().click()
  await expect(page.getByText(/Płatność zaksięgowana/)).toBeVisible()
  await expect(payments.getByRole('button', { name: 'Zaksięguj' })).toHaveCount(dueBefore - 1)
})

test('therapist sees only led groups without payment controls', async ({ page }) => {
  await login(page)
  await switchToTherapist(page) // Marta Zielińska (p2) leads only Grupa TUS 5–6 lat
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await expect(page.getByText('Grupa TUS 5–6 lat')).toBeVisible()
  await expect(page.getByText('Grupa TUS 4 lata')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Nowa grupa' })).toHaveCount(0)
  await page.getByRole('button', { name: /Grupa TUS 5–6 lat/ }).click()
  await expect(page.getByRole('heading', { name: /Grupa TUS 5–6 lat/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Płatności/ })).toHaveCount(0)
  await expect(page.locator('.att:not([disabled])').first()).toBeVisible()
})

test('class reschedule flows through the drawer with a move toast', async ({ page }) => {
  await login(page)
  await openGroup(page, 'Grupa TUS 4 lata')
  await page.locator('.att-table tbody .link').first().click()
  const drawer = page.getByRole('dialog', { name: 'Edycja zajęć' })
  await expect(drawer).toBeVisible()
  const date = drawer.getByLabel('Data')
  const value = await date.inputValue()
  const moved = new Date(`${value}T12:00:00`)
  moved.setDate(moved.getDate() + 1)
  await date.fill(moved.toISOString().slice(0, 10))
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(page.getByText('Zajęcia przeniesione')).toBeVisible()
})

test('family links surface on both client records', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Renata Gawrys/ }).click()
  await page.getByRole('button', { name: /Ignacy Borkowski \(dziecko\)/ }).click()
  await expect(page.getByRole('heading', { name: /Ignacy Borkowski/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Renata Gawrys \(rodzic\)/ })).toBeVisible()
})

test('payment method is recorded from the payment picker', async ({ page }) => {
  // the popover closes on scroll and tweens on entry — keep the flow calm
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Finanse' }).click()
  // pin the row by id — `.is-due` is a live locator and jumps to the next
  // unpaid row the moment this one is settled. Fully unpaid rows are the
  // target: their method is always empty, so picking one must announce it.
  const unpaidRow = page
    .locator('tr.is-due')
    .filter({ has: page.getByRole('button', { name: 'Nieopłacona', exact: true }) })
    .first()
  const rowId = await unpaidRow.getAttribute('data-flip-id')
  const row = page.locator(`tr[data-flip-id="${rowId}"]`)
  const payPill = row.getByRole('button', { name: 'Nieopłacona', exact: true })
  await payPill.scrollIntoViewIfNeeded()
  await payPill.click()
  await page.getByRole('menuitemradio', { name: 'Opłacona', exact: true }).click()
  await expect(page.getByText(/Płatność zmieniona: opłacona/)).toBeVisible()
  const paidPill = row.getByRole('button', { name: 'Opłacona', exact: true })
  await paidPill.scrollIntoViewIfNeeded()
  await paidPill.click()
  await page.getByRole('menuitemradio', { name: 'Gotówka' }).click()
  await expect(page.getByText(/Forma płatności: gotówka/)).toBeVisible()
  await expect(row.getByText('Gotówka')).toBeVisible()
})

test('session form exposes payment method only for paid sessions', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Nowa sesja' }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await expect(drawer.getByRole('radiogroup', { name: 'Forma płatności' })).toHaveCount(0)
  await drawer.getByRole('radio', { name: 'Opłacona', exact: true }).click()
  await expect(drawer.getByRole('radiogroup', { name: 'Forma płatności' })).toBeVisible()
})

test('google calendar demo toggle connects and disconnects', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Ustawienia' }).click()
  await page.getByRole('button', { name: 'Połącz (demo)' }).click()
  await expect(page.getByText('Połączono z Google Calendar (demo)')).toBeVisible()
  const disconnect = page.getByRole('button', { name: 'Rozłącz' })
  await expect(disconnect).toBeVisible()
  await disconnect.click()
  await expect(page.getByRole('button', { name: 'Połącz (demo)' })).toBeVisible()
})
