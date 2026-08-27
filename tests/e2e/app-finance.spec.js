import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const fixturePath = fileURLToPath(new URL('../fixtures/fictional-finance-import.csv', import.meta.url))

test('@owner imports a fictional CSV into the protected monthly ledger', async ({ page }) => {
  await page.goto('./#/ledger?ym=2026-08')

  await expect(page.getByRole('heading', { level: 1, name: /Finanse centrum/ })).toBeVisible()
  await page.getByLabel('Importuj XLSX lub CSV').setInputFiles(fixturePath)
  const preview = page.getByRole('region', { name: 'fictional-finance-import.csv' })
  await expect(preview).toContainText('2 wierszy')
  await preview.getByRole('button', { name: 'Zaimportuj do panelu' }).click()

  const ledger = page.getByRole('table', { name: 'Rejestr finansowy miesiąca' })
  await expect(ledger).toContainText('Fikcyjna Klientka')
  await expect(ledger).toContainText('Fikcyjny Opiekun')
  await expect(page.getByText('510 zł', { exact: true }).first()).toBeVisible()
})

test('@coordinator reads the centre ledger but cannot import workbooks', async ({ page }) => {
  await page.route('**/api/v1/finance?*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: {
      entries: [{
        id: 'fin_fictional_read', recordType: 'income', kind: 'income', accountingMonth: '2026-08',
        occurredOn: '2026-08-12', amountGrosze: 18500, paidAmountGrosze: 18500,
        counterparty: 'Fikcyjny Klient Odczyt', sourceLabel: 'Fikcyjna konsultacja',
        paymentMethod: 'transfer', settlementStatus: 'paid', invoiceStatus: 'issued',
        invoiceNote: '', specialistId: null, lessonCount: null,
        source: {
          batchId: 'fib_fictional_read', sourceKey: 'fictional:1',
          sheet: 'Fikcyjny arkusz', rowNumber: 2, raw: { Klient: 'Fikcyjny Klient Odczyt' },
        },
        appointmentId: null, version: 1, createdByStaffId: 'stf_local_owner',
        createdAt: '2026-08-12T10:00:00.000Z', updatedAt: '2026-08-12T10:00:00.000Z',
      }],
      summary: {
        month: '2026-08', entryCount: 1, revenueGrosze: 18500,
        collectedGrosze: 18500, outstandingGrosze: 0, expensesGrosze: 0,
        balanceGrosze: 18500, invoiceActionCount: 0,
      },
    } }),
  }))

  await page.goto('./#/ledger?ym=2026-08')

  await expect(page.getByRole('table', { name: 'Rejestr finansowy miesiąca' }))
    .toContainText('Fikcyjny Klient Odczyt')
  await expect(page.getByRole('button', { name: 'Importuj XLSX lub CSV' })).toHaveCount(0)
})
