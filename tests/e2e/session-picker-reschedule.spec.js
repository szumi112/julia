import { expect, test } from '@playwright/test'

async function login(page) {
  await page.goto('.')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await expect(page.getByRole('main')).toBeVisible()
}

test('session client picker searches with the keyboard, keeps therapist scope, and reports no matches', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Nowa sesja' }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  const input = drawer.getByRole('combobox', { name: 'Klient' })

  await input.fill('Zofia Mazur')
  await input.press('ArrowDown')
  await input.press('Enter')
  await expect(input).toHaveValue('Zofia Mazur')

  await input.fill('Nieistniejąca osoba')
  await expect(drawer.getByText('Nie znaleziono takiego klienta', { exact: true })).toBeVisible()

  await drawer.locator('.drawer__foot').getByRole('button', { name: 'Zamknij' }).click()
  await drawer.getByRole('button', { name: 'Zamknij bez zapisywania' }).click()
  await expect(drawer).toBeHidden()
  await page.getByRole('button', { name: 'Twoje konto', exact: true }).click()
  await page.getByRole('button', { name: /Prowadzenie terapii.*Justyna Jarosz-Jarszewska/ }).click()
  await page.getByRole('button', { name: 'Nowa sesja' }).first().click()
  const scopedDrawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  const scopedInput = scopedDrawer.getByRole('combobox', { name: 'Klient' })
  await scopedInput.focus()
  await expect(scopedDrawer.getByRole('option', { name: /Gabriel Madej/ })).toBeVisible()
  await expect(scopedDrawer.getByRole('option', { name: /Zofia Mazur/ })).toHaveCount(0)
  await expect(scopedDrawer).toContainText('Prowadzi: mgr Justyna Jarosz-Jarszewska')
})

test('dirty session draft confirms before the client link leaves, and reschedule focuses the date on phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  await page.getByRole('button', { name: 'Nowa sesja' }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await drawer.getByRole('combobox', { name: 'Klient' }).fill('Zofia')
  await drawer.getByLabel('Data').fill('2026-12-31')
  await drawer.getByRole('link', { name: 'Przejdź do Klientów' }).click()
  const leave = page.getByRole('alertdialog', { name: 'Wyjść bez zapisywania?' })
  await expect(leave).toBeVisible()
  await leave.getByRole('button', { name: 'Wyjdź bez zapisywania' }).click()
  await expect(page).toHaveURL(/#\/clients$/)

  await page.getByRole('navigation', { name: 'Nawigacja dolna' }).getByRole('link', { name: 'Grafik' }).click()
  await expect(page.getByRole('button', { name: 'Przełóż' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Przełóż' }).first().click()
  const reschedule = page.getByRole('dialog', { name: 'Przełóż sesję' })
  await expect(reschedule.getByLabel('Data')).toBeFocused()
})
