import { expect, test } from '@playwright/test'

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

test('@owner aligns Registry header, navigation and cards with protected finance surfaces', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })

  await page.goto('./#/reports')
  const referenceHeader = await page.locator('.report-window > .view-head').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      borderBottom: `${style.borderBottomWidth} ${style.borderBottomStyle} ${style.borderBottomColor}`,
      borderLeft: `${style.borderLeftWidth} ${style.borderLeftStyle} ${style.borderLeftColor}`,
      borderRadius: style.borderRadius,
      borderRight: `${style.borderRightWidth} ${style.borderRightStyle} ${style.borderRightColor}`,
      borderTop: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      boxShadow: style.boxShadow,
      padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
    }
  })
  const referenceCard = await page.locator('.report-window__trend').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderBottomColor: style.borderBottomColor,
      borderLeftColor: style.borderLeftColor,
      borderRightColor: style.borderRightColor,
      boxShadow: style.boxShadow,
    }
  })

  await page.goto('./#/payments')
  const referenceTabs = await page.locator('.finance-window .tabs__list').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderBottomColor: style.borderBottomColor,
      borderLeftColor: style.borderLeftColor,
      borderRightColor: style.borderRightColor,
      borderTopColor: style.borderTopColor,
    }
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
  await page.goto('./#/ledger')

  await expect(page.getByRole('heading', { level: 1, name: /Rejestr skoroszytów/ }))
    .toBeVisible()
  await expect(page.getByRole('tab')).toHaveText([
    'Importy', 'Eksporty', 'Pozycje rejestru', 'Okres nieustalony',
  ])
  const registryHeader = await page.locator('.registry-view > .view-head').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      borderBottom: `${style.borderBottomWidth} ${style.borderBottomStyle} ${style.borderBottomColor}`,
      borderLeft: `${style.borderLeftWidth} ${style.borderLeftStyle} ${style.borderLeftColor}`,
      borderRadius: style.borderRadius,
      borderRight: `${style.borderRightWidth} ${style.borderRightStyle} ${style.borderRightColor}`,
      borderTop: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      boxShadow: style.boxShadow,
      padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
    }
  })
  const registryTabs = await page.locator('.registry-view .tabs__list').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderBottomColor: style.borderBottomColor,
      borderLeftColor: style.borderLeftColor,
      borderRightColor: style.borderRightColor,
      borderTopColor: style.borderTopColor,
    }
  })
  const workflowCards = await page.locator('.registry-view__workflows > .card')
    .evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        borderBottomColor: style.borderBottomColor,
        borderLeftColor: style.borderLeftColor,
        borderRightColor: style.borderRightColor,
        boxShadow: style.boxShadow,
      }
    }))
  expect(registryHeader).toEqual(referenceHeader)
  expect(registryTabs).toEqual(referenceTabs)
  expect(workflowCards).toEqual([referenceCard, referenceCard])

  const registryItemStyle = await page.locator('.registry-list__item').evaluate((element) => {
    const computed = getComputedStyle(element)
    const root = getComputedStyle(document.documentElement)
    return {
      backgroundColor: computed.backgroundColor,
      borderLeftColor: computed.borderLeftColor,
      borderLeftWidth: computed.borderLeftWidth,
      line: root.getPropertyValue('--line').trim(),
      surface: root.getPropertyValue('--surface').trim(),
    }
  })
  expect(rgb(registryItemStyle.backgroundColor)).toEqual(rgb(registryItemStyle.surface))
  expect(rgb(registryItemStyle.borderLeftColor)).toEqual(rgb(registryItemStyle.line))
  expect(registryItemStyle.borderLeftWidth).toBe('1px')

  const provenanceStyle = await page.locator('.registry-provenance').evaluate((element) => {
    const computed = getComputedStyle(element)
    const root = getComputedStyle(document.documentElement)
    return {
      backgroundColor: computed.backgroundColor,
      borderColor: computed.borderColor,
      borderWidth: computed.borderWidth,
      lineSoft: root.getPropertyValue('--line-soft').trim(),
      surfaceWarm: root.getPropertyValue('--surface-warm').trim(),
    }
  })
  expect(rgb(provenanceStyle.backgroundColor)).toEqual(rgb(provenanceStyle.surfaceWarm))
  expect(rgb(provenanceStyle.borderColor)).toEqual(rgb(provenanceStyle.lineSoft))
  expect(provenanceStyle.borderWidth).toBe('1px')

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
