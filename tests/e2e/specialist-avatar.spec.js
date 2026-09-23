import { expect, test } from '@playwright/test'

async function login(page) {
  await page.goto('.')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await expect(page.getByRole('main')).toBeVisible()
}

test('demo keeps a selected specialist avatar in memory when creating and editing a profile', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Zespół' }).click()
  await page.getByRole('button', { name: 'Dodaj specjalistkę' }).click()

  const createDialog = page.getByRole('dialog', { name: 'Nowa specjalistka' })
  await createDialog.getByLabel('Imię i nazwisko').fill('Ada Awatarowa')
  await createDialog.getByLabel('Stawka za 60 min (zł)').fill('190')
  await createDialog.getByRole('radio', { name: 'Orbita' }).check()
  await createDialog.getByRole('button', { name: 'Dodaj do zespołu' }).click()

  let card = page.locator('.team-card').filter({ hasText: 'Ada Awatarowa' })
  await expect(card.locator('.avatar__art--orbit')).toBeVisible()
  await card.getByRole('link', { name: 'Otwórz profil — Ada Awatarowa' }).click()
  await page.getByRole('button', { name: 'Edytuj profil' }).click()

  const editDialog = page.getByRole('dialog', { name: 'Edycja profilu specjalistki' })
  await expect(editDialog.getByRole('radio', { name: 'Orbita' })).toBeChecked()
  await editDialog.getByRole('radio', { name: 'Fala' }).check()
  await editDialog.getByRole('button', { name: 'Zapisz zmiany' }).click()

  await page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Zespół' }).click()
  card = page.locator('.team-card').filter({ hasText: 'Ada Awatarowa' })
  await expect(card.locator('.avatar__art--wave')).toBeVisible()
})
