import { expect, test } from '@playwright/test'

const rgb = (value) => {
  const hex = value.trim().match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
  if (hex) return hex.slice(1).map((channel) => Number.parseInt(channel, 16))
  return value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
}
const luminance = (value) => {
  const channels = rgb(value).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return channels.length === 3
    ? channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    : null
}
const contrast = (foreground, background) => {
  const foregroundLuminance = luminance(foreground)
  const backgroundLuminance = luminance(background)
  if (foregroundLuminance === null || backgroundLuminance === null) return 0
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

test('@owner enriches protected Finanse without replacing its summary, tabs or ledger', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('./#/payments')

  await expect(page.getByRole('heading', { level: 1, name: /Finanse/ })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveText([
    'Przychody', 'Płatności i zaległości', 'Wydatki', 'Faktury',
  ])
  await expect(page.locator('.finance-window__kpi')).toHaveCount(5)
  await expect(page.getByRole('region', { name: 'Rozliczenie miesiąca' })).toBeVisible()
  await expect(page.getByRole('img', { name: /Przychody w sześciu miesiącach/ })).toBeVisible()
  await expect(page.getByText('Brak należności', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Przychody według usługi' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Wpłaty według formy' })).toBeVisible()
  const backgrounds = await page.locator('.finance-window__kpi').evaluateAll((items) => (
    items.map((item) => getComputedStyle(item).backgroundColor)
  ))
  expect(new Set(backgrounds).size).toBeGreaterThanOrEqual(4)
  await expect(page.locator('.finance-window__kpi strong').first()).toHaveText(/zł/)
  await expect(page.locator('.finance-window__table')).toBeVisible()
})

test('@owner adds a chart to protected Raporty while retaining its trend table and detail cards', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('./#/reports')

  await expect(page.getByRole('heading', { level: 1, name: /Raport/ })).toBeVisible()
  await expect(page.getByRole('region', {
    name: 'Przewijana tabela trendu sześciu miesięcy',
  })).toBeVisible()
  await expect(page.getByRole('img', {
    name: /Przychody w sześciu miesiącach/,
  })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Przychody według specjalistki' }))
    .toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pokrycie czasu i dat' })).toBeVisible()
})

test('@owner themes the existing native XLSX picker without changing Registry controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./#/ledger')

  await expect(page.getByRole('heading', { level: 1, name: /Rejestr skoroszytów/ }))
    .toBeVisible()
  await expect(page.getByRole('tab')).toHaveText([
    'Importy', 'Eksporty', 'Pozycje rejestru', 'Okres nieustalony',
  ])
  const picker = page.getByLabel('Wybierz plik XLSX')
  await expect(picker).toBeVisible()
  const style = await picker.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      backgroundColor: computed.backgroundColor,
      borderRadius: computed.borderRadius,
      fontSize: Number.parseFloat(computed.fontSize),
      skyGhost: getComputedStyle(document.documentElement).getPropertyValue('--sky-ghost').trim(),
    }
  })
  expect(rgb(style.backgroundColor)).toEqual(rgb(style.skyGhost))
  expect(style.borderRadius).toBe('14px')
  expect(style.fontSize).toBeGreaterThanOrEqual(16)
})

test('@owner gives protected Team avatars a visible surface and readable initials', async ({ page }) => {
  await page.goto('./#/team')

  await expect(page.getByRole('heading', { level: 1, name: /Zespół centrum/ }))
    .toBeVisible()
  const avatar = page.locator('.team-card .avatar').first()
  await expect(avatar).toBeVisible()
  const colors = await avatar.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      foreground: style.color,
      shadow: style.textShadow,
    }
  })
  expect(contrast(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5)
  expect(colors.shadow).toBe('none')
})

test('@specialist own payments render toned, readable KPI cards', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('./#/payments')

  await expect(page.getByRole('heading', { level: 1, name: /Finanse/ })).toBeVisible()
  const kpis = page.locator('.finance-window__kpi')
  await expect(kpis).toHaveCount(3)
  await expect(kpis.first()).toHaveText(/zł/)
  const backgrounds = await kpis.evaluateAll((items) => (
    items.map((item) => getComputedStyle(item).backgroundColor)
  ))
  expect(new Set(backgrounds).size).toBe(3)
})
