import { expect, test } from '@playwright/test'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const NOW = '2026-08-15T10:00:00.000Z'
const json = (body) => ({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
})

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

test('@owner keeps an empty protected Finanse focused on one clear next step', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('./#/payments')

  await expect(page.getByRole('heading', { level: 1, name: /Finanse/ })).toBeVisible()
  await expect(page.getByText('Brak pozycji w tym miesiącu', { exact: true })).toBeVisible()
  await expect(page.getByText(
    'Pozycje pojawią się tu po odbytych sesjach albo po dodaniu wydatku.',
    { exact: true },
  )).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.locator('.finance-window__kpi')).toHaveCount(0)
  await expect(page.locator('.finance-window__trend')).toHaveCount(0)
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
  const surfaces = await page.locator('.report-window .card').evaluateAll((cards) => (
    cards.map((card) => {
      const style = getComputedStyle(card)
      return `${style.backgroundColor} ${style.borderTopColor} ${style.borderTopWidth}`
    })
  ))
  expect(new Set(surfaces).size).toBe(1)
  expect(await page.locator('.report-window .chart-frame').evaluate((element) => (
    getComputedStyle(element).backgroundImage
  ))).toBe('none')
  await expect(page.locator('.report-window__split', {
    has: page.getByRole('heading', { name: 'Faktury' }),
  })).toContainText('Brak danych')
})

test('@owner keeps workbook tools compact inside protected Finanse', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.environment = 'staging'
    body.data.capabilities = ROLE_DEFAULT_CAPABILITIES.owner
    await route.fulfill({ response, body: JSON.stringify(body) })
  })

  await page.route('**/api/v1/workbooks/registry?*', (route) => route.fulfill(json({ data: {
    cursor: null,
    nextCursor: null,
    imports: [{
      id: 'wbi_visual_import',
      artifact: {
        id: 'wba_visual_artifact', fingerprint: 'a'.repeat(64), byteSize: 4096,
        parserVersion: 2, materializerVersion: 2, createdAt: NOW,
      },
      status: 'materializing', version: 2, phase: 'index_finance',
      progress: { processed: 64, total: 2234 },
      summary: {
        sourceCount: 2235, quarantineCount: 3, conflictCount: 0,
        duplicateCount: 0, resolutionCount: 0,
      },
      resolutionVersion: 0, createdByStaffId: 'stf_local_owner',
      createdAt: NOW, updatedAt: NOW,
    }],
    exports: [],
    entries: [],
    complete: true,
  } })))
  await page.goto('./#/payments')
  await page.getByText('Wgraj arkusz', { exact: true }).click()
  await expect(page.locator('.finance-workbook-tools')).toBeVisible()
  await expect(page.locator('.registry-view')).toHaveCount(0)
  await expect(page.getByText('wbi_visual_import', { exact: true })).toHaveCount(0)
  await expect(page.getByText('wba_visual_artifact', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Odcisk SHA-256', { exact: true })).toHaveCount(0)

  const picker = page.getByLabel('Wybierz plik XLSX')
  await expect(picker).toBeVisible()
  const style = await picker.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      backgroundColor: computed.backgroundColor,
      borderColor: computed.borderColor,
      borderRadius: computed.borderRadius,
      fontSize: Number.parseFloat(computed.fontSize),
      lineStrong: getComputedStyle(document.documentElement).getPropertyValue('--line-strong').trim(),
      surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
    }
  })
  const pickerButtonStyle = await picker.evaluate((element) => {
    const computed = getComputedStyle(element, '::file-selector-button')
    const root = getComputedStyle(document.documentElement)
    return {
      backgroundColor: computed.backgroundColor,
      borderColor: computed.borderColor,
      color: computed.color,
      blush: root.getPropertyValue('--blush').trim(),
      coralDeep: root.getPropertyValue('--coral-deep').trim(),
      coralGhost: root.getPropertyValue('--coral-ghost').trim(),
    }
  })
  expect(rgb(style.backgroundColor)).toEqual(rgb(style.surface))
  expect(rgb(style.borderColor)).toEqual(rgb(style.lineStrong))
  expect(style.borderRadius).toBe('14px')
  expect(style.fontSize).toBeGreaterThanOrEqual(16)
  expect(rgb(pickerButtonStyle.backgroundColor)).toEqual(rgb(pickerButtonStyle.coralGhost))
  expect(rgb(pickerButtonStyle.borderColor)).toEqual(rgb(pickerButtonStyle.blush))
  expect(rgb(pickerButtonStyle.color)).toEqual(rgb(pickerButtonStyle.coralDeep))
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

test('@owner search uses names and professional titles without technical fallback text', async ({ page }) => {
  await page.goto('./#/team')
  const avatar = page.locator('.team-card .avatar').first()
  await expect(avatar).toBeVisible()
  await expect(avatar.locator('svg')).toBeVisible()
  expect(await avatar.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)')

  await page.keyboard.press('Control+k')
  const search = page.getByRole('combobox', { name: 'Szukaj w panelu' })
  await expect(search).toBeFocused()
  await expect(page.getByText(/^undefined\s/)).toHaveCount(0)
  await expect(page.locator('.cmd__item').filter({ hasText: 'Zofia Fikcyjna' }))
    .toContainText('Specjalistka')
})

test('@specialist own payments render readable KPI cards on one neutral surface', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('./#/payments')

  await expect(page.getByRole('heading', { level: 1, name: /Finanse/ })).toBeVisible()
  const kpis = page.locator('.finance-window__kpi')
  await expect(kpis).toHaveCount(3)
  await expect(kpis.first()).toHaveText(/zł/)
  const backgrounds = await kpis.evaluateAll((items) => (
    items.map((item) => getComputedStyle(item).backgroundColor)
  ))
  expect(new Set(backgrounds).size).toBe(2)
})
