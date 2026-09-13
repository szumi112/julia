import { expect, test } from '@playwright/test'

test('@owner keeps the current-month action inside PeriodNav at 320px', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto('./#/reports?ym=2026-07')

  await expect(page.getByRole('heading', { level: 1, name: /Raport/ })).toBeVisible()
  const actions = page.locator('.view-head__actions')
  const currentMonth = page.getByRole('button', { name: 'Bieżący miesiąc' })
  await expect(currentMonth).toBeVisible()
  const actionsBox = await actions.boundingBox()
  const currentBox = await currentMonth.boundingBox()
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth)
  expect(currentBox.x).toBeGreaterThanOrEqual(actionsBox.x)
  expect(currentBox.x + currentBox.width).toBeLessThanOrEqual(viewportWidth)
  expect(currentBox.y + currentBox.height).toBeLessThanOrEqual(actionsBox.y + actionsBox.height)
})
