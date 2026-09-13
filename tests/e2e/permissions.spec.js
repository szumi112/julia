import { expect, test } from '@playwright/test'

test('demo settings never renders or requests protected permissions', async ({ page }) => {
  let apiRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests += 1
  })
  await page.goto('./#/settings?section=permissions')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Ustawienia', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Uprawnienia personelu' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Zapisz uprawnienia' })).toHaveCount(0)
  expect(apiRequests).toBe(0)
})

test('demo Dashboard never renders the protected backup banner', async ({ page }) => {
  let healthRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/operations/health') healthRequests += 1
  })
  await page.goto('./#/dashboard')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()

  await expect(page.getByRole('region', { name: 'Pulpit dnia' })).toBeVisible()
  await expect(page.getByRole('alert', { name: 'Kopia zapasowa wymaga sprawdzenia' })).toHaveCount(0)
  expect(healthRequests).toBe(0)
})
