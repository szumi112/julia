import { test, expect } from '@playwright/test'

const ACTORS = {
  owner: { email: 'owner@example.test', role: 'owner' },
  coordinator: { email: 'coordinator@example.test', role: 'coordinator' },
  specialist: { email: 'specialist@example.test', role: 'specialist' },
}

const TEST_IPS = {
  owner: '192.0.2.10',
  coordinator: '192.0.2.11',
  specialist: '192.0.2.12',
}

test('@all signs in with a seeded Better Auth credential and signs out', async ({ browser }, testInfo) => {
  const actor = ACTORS[testInfo.project.name]
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5174/' })
  const page = await context.newPage()
  await page.route('**/*', async route => {
    const headers = await route.request().allHeaders()
    delete headers['x-bwm-local-identity']
    headers['cf-connecting-ip'] = TEST_IPS[testInfo.project.name]
    await route.continue({ headers })
  })
  await page.goto('.')
  await page.getByLabel('Adres e-mail').fill(actor.email)
  await page.getByLabel('Hasło').fill('correctpassword')
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click()
  await page.getByRole('button', { name: 'Twoje konto' }).click()
  const accountMenu = page.getByRole('menu', { name: 'Twoje konto' })
  await expect(accountMenu.getByRole('menuitem', { name: 'Wyloguj się' })).toBeVisible()
  const authenticated = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session')
    return { status: response.status, body: await response.json() }
  })
  expect(authenticated.status).toBe(200)
  expect(authenticated.body.data.actor.role).toBe(actor.role)
  await accountMenu.getByRole('menuitem', { name: 'Wyloguj się' }).click()
  await expect(page.getByLabel('Hasło', { exact: true })).toBeVisible()
  expect(await page.evaluate(async () => (await fetch('/api/v1/session')).status)).toBe(401)
  await context.close()
})

test('@all rejects a wrong Better Auth password', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5174/' })
  const page = await context.newPage()
  await page.route('**/*', async route => {
    const headers = await route.request().allHeaders()
    delete headers['x-bwm-local-identity']
    headers['cf-connecting-ip'] = TEST_IPS[testInfo.project.name].replace('.0.2.', '.0.3.')
    await route.continue({ headers })
  })
  await page.goto('.')
  await page.getByLabel('Adres e-mail').fill(ACTORS[testInfo.project.name].email)
  await page.getByLabel('Hasło').fill('wrongpassword123')
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Nieprawidłowy e-mail, hasło lub kod.')
  expect(await page.evaluate(async () => (await fetch('/api/v1/session')).status)).toBe(401)
  await context.close()
})

test('@owner shows the canonical login email and changes the Better Auth password', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5174/' })
  const page = await context.newPage()
  await page.route('**/*', async route => {
    const headers = await route.request().allHeaders()
    delete headers['x-bwm-local-identity']
    headers['cf-connecting-ip'] = '192.0.2.20'
    await route.continue({ headers })
  })
  await page.goto('.')
  await page.getByLabel('Adres e-mail').fill(ACTORS.owner.email)
  await page.getByLabel('Hasło').fill('correctpassword')
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click()

  await page.getByRole('button', { name: 'Twoje konto' }).click()
  const accountMenu = page.getByRole('menu', { name: 'Twoje konto' })
  await expect(accountMenu.getByText(ACTORS.owner.email, { exact: true })).toBeVisible()
  await accountMenu.getByRole('menuitem', { name: 'Mój profil' }).click()
  const identity = page.getByLabel('Tożsamość konta')
  await expect(identity).toContainText('E-mail do logowania')
  await expect(identity.getByText(ACTORS.owner.email, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Zmień hasło', exact: true }).click()
  const form = page.getByRole('form', { name: 'Zmiana hasła' })
  await form.getByLabel('Obecne hasło').fill('wrong-current-password')
  await form.getByLabel('Nowe hasło').fill('replacement-password-2026')
  await form.getByLabel('Powtórz hasło').fill('replacement-password-2026')
  await form.getByRole('button', { name: 'Zmień hasło', exact: true }).click()
  await expect(form.getByRole('alert')).toContainText('Sprawdź obecne hasło')

  await form.getByLabel('Obecne hasło').fill('correctpassword')
  await form.getByRole('button', { name: 'Zmień hasło', exact: true }).click()
  await expect(page.getByText('Hasło zostało zmienione', { exact: true })).toBeVisible()
  await expect(form).toHaveCount(0)

  await page.getByRole('button', { name: 'Zmień hasło', exact: true }).click()
  const restore = page.getByRole('form', { name: 'Zmiana hasła' })
  await restore.getByLabel('Obecne hasło').fill('replacement-password-2026')
  await restore.getByLabel('Nowe hasło').fill('correctpassword')
  await restore.getByLabel('Powtórz hasło').fill('correctpassword')
  await restore.getByRole('button', { name: 'Zmień hasło', exact: true }).click()
  await expect(restore).toHaveCount(0)
  await context.close()
})

test('@owner offers a fresh login when password change requires reauthentication', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5174/' })
  const page = await context.newPage()
  await page.route('**/*', async route => {
    const headers = await route.request().allHeaders()
    delete headers['x-bwm-local-identity']
    headers['cf-connecting-ip'] = '192.0.2.21'
    await route.continue({ headers })
  })
  await page.goto('.')
  await page.getByLabel('Adres e-mail').fill(ACTORS.owner.email)
  await page.getByLabel('Hasło').fill('correctpassword')
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click()
  await page.getByRole('button', { name: 'Twoje konto' }).click()
  await page.getByRole('menuitem', { name: 'Mój profil' }).click()
  await page.getByRole('button', { name: 'Zmień hasło', exact: true }).click()
  await page.route('**/api/auth/change-password', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'REAUTH_REQUIRED' }),
  }))
  const form = page.getByRole('form', { name: 'Zmiana hasła' })
  await form.getByLabel('Obecne hasło').fill('correctpassword')
  await form.getByLabel('Nowe hasło').fill('replacement-password-2026')
  await form.getByLabel('Powtórz hasło').fill('replacement-password-2026')
  await form.getByRole('button', { name: 'Zmień hasło', exact: true }).click()

  await expect(page.getByText(/Ze względów bezpieczeństwa/)).toBeVisible()
  await page.getByRole('button', { name: 'Zaloguj się ponownie' }).click()
  await expect(page.getByLabel('Hasło', { exact: true })).toBeVisible()
  await context.close()
})
