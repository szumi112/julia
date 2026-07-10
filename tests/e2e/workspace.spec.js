import { test, expect } from '@playwright/test'

async function login(page) {
  await page.goto('.')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await expect(page.getByRole('main')).toBeVisible()
}

test('the mock-data workspace opens after login', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('heading', { name: /Dziś|Dobry/ })).toBeVisible()
})

test('therapist demo mode narrows navigation to daily care work', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /Julia Wolanin/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Marta Zielińska/ }).click()
  await expect(page.getByRole('navigation')).toContainText('Mój dzień')
  await expect(page.getByRole('navigation')).not.toContainText('Finanse')
  await expect(page.getByRole('navigation')).not.toContainText('Raporty')
})
