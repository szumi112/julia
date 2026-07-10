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
