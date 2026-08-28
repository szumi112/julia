import { expect, test } from '@playwright/test'

test('demo settings never renders or requests protected permissions', async ({ page }) => {
  let apiRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests += 1
  })
  await page.goto('./#/settings?section=permissions')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()

  await expect(page.getByRole('heading', { name: 'Ustawienia centrum' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Uprawnienia personelu' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Zapisz uprawnienia' })).toHaveCount(0)
  expect(apiRequests).toBe(0)
})
