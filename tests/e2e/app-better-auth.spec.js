import { test, expect } from '@playwright/test'

const ACTORS = {
  owner: { email: 'owner@example.test', role: 'owner' },
  coordinator: { email: 'coordinator@example.test', role: 'coordinator' },
  specialist: { email: 'specialist@example.test', role: 'specialist' },
}

test('@all signs in with a seeded Better Auth credential and signs out', async ({ browser }, testInfo) => {
  const actor = ACTORS[testInfo.project.name]
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5174/' })
  const page = await context.newPage()
  await page.route('**/*', async route => {
    const headers = await route.request().allHeaders()
    delete headers['x-bwm-local-identity']
    await route.continue({ headers })
  })
  await page.goto('.')
  await page.getByLabel('Adres e-mail').fill(actor.email)
  await page.getByLabel('Hasło').fill('correctpassword')
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Wyloguj się' })).toBeVisible()
  const authenticated = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session')
    return { status: response.status, body: await response.json() }
  })
  expect(authenticated.status).toBe(200)
  expect(authenticated.body.data.actor.role).toBe(actor.role)
  await page.getByRole('button', { name: 'Wyloguj się' }).click()
  await expect(page.getByLabel('Hasło')).toBeVisible()
  expect(await page.evaluate(async () => (await fetch('/api/v1/session')).status)).toBe(401)
  await context.close()
})

test('@all rejects a wrong Better Auth password', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5174/' })
  const page = await context.newPage()
  await page.route('**/*', async route => {
    const headers = await route.request().allHeaders()
    delete headers['x-bwm-local-identity']
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
