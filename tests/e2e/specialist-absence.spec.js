import { expect, test } from '@playwright/test'

test('demo marks whole-day absence and warns before adding a session', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    const NativeDate = Date
    const frozenTime = new NativeDate('2026-09-13T10:00:00.000Z').getTime()
    class FrozenDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [frozenTime])) }
      static now() { return frozenTime }
    }
    FrozenDate.parse = NativeDate.parse
    FrozenDate.UTC = NativeDate.UTC
    window.Date = FrozenDate
  })
  await page.goto('.')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await expect(page.getByRole('main')).toBeVisible()

  await page.evaluate(() => { window.location.hash = '#/calendar?date=2026-09-13' })
  await page.getByRole('button', { name: 'Zaznacz wolne' }).click()

  const absenceDialog = page.getByRole('dialog', { name: 'Zaznacz wolne' })
  await absenceDialog.getByLabel('Specjalistka').selectOption('p1')
  await absenceDialog.getByRole('button', { name: 'Zapisz wolne' }).click()
  await expect(absenceDialog).toBeHidden()
  await expect(page.getByRole('button', { name: /Anuluj wolne - Anna Maria Janowska/ })).toBeVisible()

  await page.locator('#main-content').getByRole('button', { name: 'Nowa sesja' }).click()
  const sessionDialog = page.getByRole('dialog', { name: 'Nowa sesja' })
  await sessionDialog.getByRole('combobox', { name: 'Specjalistka' }).selectOption('p1')
  await expect(sessionDialog).toContainText('Ta specjalistka ma zaznaczone wolne')
})
