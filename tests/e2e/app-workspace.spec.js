import { test, expect } from '@playwright/test'

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const activeSpecialist = {
  id: 'sp_anna', displayName: 'Anna Nowak', standardRateGrosze: 18_000,
  status: 'active', version: 3, staffVersion: 4,
}

const activeClient = {
  id: 'cl_active', name: 'Ola Aktywna', age: 12, status: 'active', version: 2,
  archivedAt: null, createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-07-10T09:00:00.000Z', readOnly: false,
  assignment: {
    id: 'asg_active', specialistId: 'sp_anna',
    startsAt: '2026-01-10T09:00:00.000Z', version: 1,
  },
}

const archivedClient = {
  id: 'cl_archived', name: 'Zofia Historyczna', age: 14, status: 'archived', version: 2,
  archivedAt: '2026-07-20T08:00:00.000Z', createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-07-20T08:00:00.000Z', readOnly: true, assignment: null,
}

const historicalAppointment = {
  id: 'apt_history', clientId: 'cl_archived', specialistId: 'sp_history',
  serviceId: 'zajecia', startsAt: '2026-07-15T08:30:00.000Z',
  endsAt: '2026-07-15T09:20:00.000Z', timeZone: 'Europe/Warsaw', location: null,
  status: 'completed', source: 'panel', version: 2, cancelledAt: null,
  createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-16T08:00:00.000Z',
  charge: {
    id: 'chg_history', serviceId: 'zajecia', expectedAmountGrosze: 18_000,
    currency: 'PLN', version: 1,
  },
  payment: {
    status: 'partial', collectedGrosze: 8_000, outstandingGrosze: 10_000,
    latestMethod: 'transfer', latestReceivedAt: '2026-07-16T10:00:00.000Z',
  },
  paymentEntries: [{
    id: 'pay_history', amountGrosze: 8_000, method: 'transfer',
    receivedAt: '2026-07-16T10:00:00.000Z', correctedAt: null, replacementEntryId: null,
  }],
}

const containsHistory = (from, to) => from <= '2026-07-15' && to >= '2026-07-15'

test('@owner renders only complete canonical workspace windows as read-only history', async ({ page }) => {
  const pageErrors = []
  let workspaceReads = 0
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/api/v1/workspace?*', async (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (workspaceReads === 1 || (from === '2026-04-01' && to === '2026-04-30')) {
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
    const history = containsHistory(from, to)
    await route.fulfill(json(200, {
      data: {
        window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
        specialists: [activeSpecialist],
        clients: history ? [activeClient, archivedClient] : [activeClient],
        appointments: history ? [historicalAppointment] : [],
      },
    }))
  })

  await page.goto('./#/clients')
  await expect.poll(() => pageErrors).toEqual([])
  await expect(page.getByText('Alicja Testowa', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('status', { name: 'Stan kartoteki' })).toContainText('Wczytywanie kartoteki')
  await expect(page.getByText('Ola Aktywna', { exact: true })).toBeVisible()
  await expect(page.getByText('Zofia Historyczna', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Nie powinna się pojawić', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Dodaj klienta' })).toHaveCount(0)

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await expect(plan.getByText('Zofia Historyczna', { exact: true })).toBeVisible()
  await expect(plan.getByText('Archiwalny', { exact: true })).toBeVisible()
  await expect(plan).toContainText('Specjalistka niedostępna')
  await expect(plan.getByRole('button', { name: /Edytuj sesję/ })).toHaveCount(0)
  await expect(plan.getByRole('button', { name: /Status:/ })).toHaveCount(0)
  await expect(plan.getByRole('button', { name: /Płatność:/ })).toHaveCount(0)

  await page.goto('./#/payments?ym=2026-07')
  const ledger = page.getByRole('table', { name: 'Lista rozliczeń' })
  await expect(ledger).toContainText('Zofia Historyczna')
  await expect(ledger).toContainText('Specjalistka niedostępna')
  await expect(page.getByRole('button', { name: 'Wszystkie okresy' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Zaksięguj wpłatę/ })).toHaveCount(0)

  await page.goto('./#/calendar?date=2026-04-15&ym=2026-04&mode=cal')
  await expect(page.getByRole('status', { name: 'Stan kalendarza' })).toContainText('Wczytywanie kalendarza')
  await expect(page.getByText('Brak sesji tego dnia', { exact: true })).toBeVisible()
  await expect(page.getByText('W tym kompletnym zakresie nie ma zaplanowanych sesji.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Poprzedni miesiąc' })).toBeEnabled()
  expect(pageErrors).toEqual([])
})
