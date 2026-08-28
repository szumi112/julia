import { expect, test } from '@playwright/test'

test('@owner creates, edits, and invites one stable specialist profile', async ({ page }) => {
  await page.goto('.')
  await page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Zespół' })
    .click()

  await page.getByRole('button', { name: 'Dodaj specjalistkę' }).click()
  const createDialog = page.getByRole('dialog', { name: 'Dodaj profil specjalistki' })
  await createDialog.getByLabel('Imię i nazwisko').fill('Anna Janowska')
  await expect(createDialog.getByLabel('Tytuł zawodowy')).toHaveValue('Specjalistka')
  await createDialog.getByLabel('Tytuł zawodowy').fill('Psycholożka')
  await createDialog.getByLabel('Stawka za sesję (zł)').fill('185,50')
  await createDialog.getByRole('button', { name: 'Dodaj profil' }).click()

  let profile = page.locator('article').filter({ hasText: 'Anna Janowska' })
  await expect(profile).toContainText('Brak dostępu do panelu')
  await expect(profile).toContainText('Psycholożka')
  await expect(profile).toContainText('185,50 zł')

  await profile.getByRole('button', { name: 'Edytuj profil' }).click()
  const editDialog = page.getByRole('dialog', { name: 'Edytuj profil specjalistki' })
  await editDialog.getByLabel('Imię i nazwisko').fill('Anna Janowska-Kowalska')
  await expect(editDialog.getByLabel('Tytuł zawodowy')).toHaveValue('Psycholożka')
  await editDialog.getByLabel('Tytuł zawodowy').fill('Psychoterapeutka')
  await editDialog.getByRole('button', { name: 'Zapisz zmiany' }).click()

  profile = page.locator('article').filter({ hasText: 'Anna Janowska-Kowalska' })
  await expect(profile).toContainText('Brak dostępu do panelu')
  await expect(profile).toContainText('Psychoterapeutka')
  await expect(profile).not.toContainText('Właściciel')
  let sessionRefreshes = 0
  const invitationAttempts = []
  await page.route('**/api/v1/session', async (route) => {
    sessionRefreshes += 1
    if (sessionRefreshes === 1) {
      await route.abort('connectionfailed')
      return
    }
    await route.continue()
  })
  await page.route('**/api/v1/specialists/*/invitations', async (route) => {
    invitationAttempts.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
      url: route.request().url(),
    })
    await route.continue()
  })
  await profile.getByRole('button', { name: 'Aktywuj dostęp' }).click()
  const accessDialog = page.getByRole('dialog', {
    name: 'Aktywuj dostęp — Anna Janowska-Kowalska',
  })
  await accessDialog.getByLabel('Adres e-mail').fill('anna-j@gmail.com')
  await accessDialog.getByRole('button', { name: 'Wyślij zaproszenie' }).click()
  await expect(accessDialog.getByRole('button', { name: 'Spróbuj ponownie' })).toBeVisible()
  await expect(accessDialog).toContainText(
    'Nie wiadomo, czy zaproszenie zostało utworzone. Spróbuj ponownie bez zmiany adresu e-mail.',
  )
  await accessDialog.getByRole('button', { name: 'Spróbuj ponownie' }).click()

  await expect(profile).toContainText('Zaproszenie oczekuje')
  await expect(profile.getByRole('button', { name: 'Aktywuj dostęp' })).toHaveCount(0)
  expect(invitationAttempts).toHaveLength(2)
  expect(invitationAttempts[1]).toEqual(invitationAttempts[0])
  expect(JSON.parse(invitationAttempts[0].body)).toEqual({
    email: 'anna-j@gmail.com',
    expectedVersion: 2,
  })
  expect(invitationAttempts[0].key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/)
  expect(new URL(invitationAttempts[0].url).search).toBe('')
})
