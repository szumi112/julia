import { expect, test } from '@playwright/test'

async function login(page) {
  await page.goto('.')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await expect(page.getByRole('main')).toBeVisible()
}

test('client card opens the existing session drawer with its client selected', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()

  await page.locator('.id-band__actions').getByRole('button', { name: 'Umów sesję' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await expect(drawer.getByRole('combobox', { name: 'Klient' })).toHaveValue('Zofia Mazur')
})
