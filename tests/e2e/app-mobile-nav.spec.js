import { expect, test } from '@playwright/test'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const json = (body) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const sessionFor = (capabilities) => {
  const csrfExpiresAt = '2030-01-01T00:00:00.000Z'
  return json({
    data: {
      actor: {
        id: 'stf_mobile_navigation',
        displayName: 'Alicja Nawigacja',
        email: 'alicja@example.test',
        professionalTitle: null,
        role: 'owner',
        specialistId: null,
        version: 1,
      },
      authorityRevision: 1,
      capabilities,
      csrfExpiresAt,
      csrfToken: `v1.${Date.parse(csrfExpiresAt) / 1000}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      dataMode: 'fictional',
      environment: 'development',
    },
  })
}

async function installSession(page, capabilities) {
  await page.route('**/api/v1/session', (route) => route.fulfill(sessionFor(capabilities)))
}

test('@owner phone navigation puts direct work before More and opens a session form when allowed', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./#/dashboard')

  const tabbar = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  expect(await tabbar.getByRole('link').allTextContents()).toEqual(['Dziś', 'Grafik', 'Klienci'])
  await expect(tabbar.getByRole('button', { name: 'Nowa sesja' })).toBeVisible()
  await expect(tabbar.getByRole('button', { name: 'Więcej' })).toBeVisible()

  await tabbar.getByRole('button', { name: 'Nowa sesja' }).click()
  const sessionDialog = page.getByRole('dialog', { name: 'Nowa sesja' })
  await expect(sessionDialog).toBeVisible()
  await sessionDialog.locator('.drawer__foot').getByRole('button', { name: 'Zamknij' }).click()

  await tabbar.getByRole('button', { name: 'Więcej' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  const navigation = drawer.getByRole('navigation', { name: 'Nawigacja główna' })
  await expect(navigation.getByRole('link', { name: 'Zajęcia TUS' })).toBeVisible()
  await expect(navigation.getByRole('link', { name: 'Angielski' })).toBeVisible()
  await expect(navigation.getByRole('link', { name: 'Klienci' })).toHaveCount(0)
  await expect(navigation.getByRole('link', { name: 'Rejestr' })).toHaveCount(0)
})

test('@owner phone navigation does not render a session action without appointment creation', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner.filter(
    (capability) => capability !== 'appointment.manage',
  ))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./#/dashboard')

  const tabbar = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  expect(await tabbar.getByRole('link').allTextContents()).toEqual(['Dziś', 'Grafik', 'Klienci'])
  await expect(tabbar.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)
  await expect(tabbar.getByRole('button', { name: 'Więcej' })).toBeVisible()
})

test('@owner keeps separate sectioned links at the tablet and desktop boundary', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  await page.setViewportSize({ width: 1024, height: 844 })
  await page.goto('./#/dashboard')

  await expect(page.locator('.sidebar:not(.sidebar--drawer)')).toHaveCount(0)
  await page.locator('.topbar').getByRole('button', { name: 'Otwórz menu' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  const drawerNavigation = drawer.getByRole('navigation', { name: 'Nawigacja główna' })
  await expect(drawerNavigation.getByRole('group', { name: 'Centrum' })).toBeVisible()
  for (const label of ['Zespół', 'Finanse', 'Raporty']) {
    await expect(drawerNavigation.getByRole('link', { name: label, exact: true })).toHaveCount(1)
  }
  await expect(drawerNavigation.getByRole('link', { name: 'Rejestr', exact: true })).toHaveCount(0)

  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1025, height: 844 })
  const sidebar = page.locator('.sidebar:not(.sidebar--drawer)')
  await expect(sidebar).toBeVisible()
  const navigation = sidebar.getByRole('navigation', { name: 'Nawigacja główna' })
  await expect(navigation.getByRole('group', { name: 'Centrum' })).toBeVisible()
  for (const label of ['Zespół', 'Finanse', 'Raporty']) {
    await expect(navigation.getByRole('link', { name: label, exact: true })).toHaveCount(1)
  }
})
