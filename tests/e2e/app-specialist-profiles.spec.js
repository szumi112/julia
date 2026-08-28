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
  await profile.getByRole('button', { name: 'Aktywuj dostęp' }).click()
  const accessDialog = page.getByRole('dialog', {
    name: 'Aktywuj dostęp — Anna Janowska-Kowalska',
  })
  await accessDialog.getByLabel('Adres e-mail').fill('anna-j@gmail.com')
  await accessDialog.getByRole('button', { name: 'Wyślij zaproszenie' }).click()

  await expect(profile).toContainText('Zaproszenie oczekuje')
  await expect(profile.getByRole('button', { name: 'Aktywuj dostęp' })).toHaveCount(0)
})
