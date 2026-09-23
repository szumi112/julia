import { expect, test } from '@playwright/test'

import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const json = (body, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(body),
})
const session = ({ capabilities = ROLE_DEFAULT_CAPABILITIES.owner, environment = 'staging' } = {}) => {
  const csrfExpiresAt = '2030-01-01T00:00:00.000Z'
  const csrfExpiresUnix = Date.parse(csrfExpiresAt) / 1000
  return json({ data: {
    actor: {
      id: 'stf_finance_tools_owner', displayName: 'Alicja Finansowa',
      email: 'alicja-finanse@example.test', professionalTitle: null, role: 'owner',
      specialistId: null, version: 1,
    },
    authorityRevision: 1,
    capabilities,
    csrfExpiresAt,
    csrfToken: `v1.${csrfExpiresUnix}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
    dataMode: 'fictional', environment,
  } })
}

const installSession = (page, options) => page.route('**/api/v1/session', (route) => (
  route.fulfill(session(options))
))

test('@owner staging export is retried after a quiet failure and removed after endpoint 404', async ({ page }) => {
  await installSession(page)
  let attempts = 0
  await page.route('**/api/v1/workbooks/exports', (route) => {
    attempts += 1
    if (attempts === 1) return route.fulfill(json({ error: {
      code: 'INTERNAL_ERROR', correlationId: 'cor_finance_export_retry',
    } }, 500))
    if (attempts === 3) return route.fulfill(json({ error: {
      code: 'NOT_FOUND', correlationId: 'cor_finance_export_missing',
    } }, 404))
    return route.fulfill({
      status: 200,
      body: Buffer.from([80, 75, 3, 4]),
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': 'attachment; filename="panel-v2-test.xlsx"',
        'content-length': '4',
        'content-type': XLSX,
        'x-content-type-options': 'nosniff',
      },
    })
  })

  await page.goto('./#/payments')
  const exportButton = page.getByRole('button', { name: 'Pobierz arkusz Excel' })
  await expect(exportButton).toBeVisible()
  await exportButton.click()
  await expect(page.getByRole('alert')).toContainText('Nie udało się przygotować arkusza')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  expect((await download).suggestedFilename()).toBe('panel-v2-test.xlsx')
  await exportButton.click()
  await expect(exportButton).toHaveCount(0)
  expect(attempts).toBe(3)
})

test('@owner does not see workbook tools outside staging or without import capability', async ({ page }) => {
  await installSession(page, { environment: 'development' })
  await page.goto('./#/payments')
  await expect(page.getByRole('button', { name: 'Pobierz arkusz Excel' })).toHaveCount(0)
  await expect(page.getByText('Wgraj arkusz', { exact: true })).toHaveCount(0)
})
