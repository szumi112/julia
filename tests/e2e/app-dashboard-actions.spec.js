import { expect, test } from '@playwright/test'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const session = (capabilities) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    data: {
      actor: {
        id: 'stf_dashboard_action',
        displayName: 'Alicja Dziś',
        email: 'alicja@example.test',
        professionalTitle: null,
        role: 'owner',
        specialistId: null,
        version: 1,
      },
      authorityRevision: 1,
      capabilities,
      csrfExpiresAt: '2030-01-01T00:00:00.000Z',
      csrfToken: `v1.${Date.parse('2030-01-01T00:00:00.000Z') / 1000}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      dataMode: 'fictional',
      environment: 'development',
    },
  }),
})

const sessionFor = (role, capabilities) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    data: {
      actor: {
        id: `stf_dashboard_${role}`,
        displayName: role === 'owner' ? 'Alicja Dziś' : 'Celina Dziś',
        email: `${role}@example.test`,
        professionalTitle: role === 'specialist' ? 'Psycholożka' : null,
        role,
        specialistId: role === 'specialist' ? 'sp_zofia' : null,
        version: 1,
      },
      authorityRevision: 1,
      capabilities,
      csrfExpiresAt: '2030-01-01T00:00:00.000Z',
      csrfToken: `v1.${Date.parse('2030-01-01T00:00:00.000Z') / 1000}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      dataMode: 'fictional',
      environment: 'development',
    },
  }),
})

async function installSession(page, capabilities) {
  await page.route('**/api/v1/session', (route) => route.fulfill(session(capabilities)))
}

const HEALTHY_CHECKS = (lastSuccessAt = '2026-09-13T02:00:00.000Z') => [
  { id: 'outbox.processing', label: 'Kolejka zadań', status: 'ok', lastSuccessAt: '2026-09-13T11:58:00.000Z', detailCode: 'OUTBOX_HEALTHY' },
  { id: 'backup.freshness', label: 'Kopie zapasowe', status: 'ok', lastSuccessAt, detailCode: 'BACKUP_FRESH' },
  { id: 'access.reconciliation', label: 'Synchronizacja dostępu', status: 'ok', lastSuccessAt: '2026-09-13T11:57:00.000Z', detailCode: 'ACCESS_CURRENT' },
  { id: 'scheduler.runs', label: 'Zadania cykliczne', status: 'ok', lastSuccessAt: '2026-09-13T11:59:00.000Z', detailCode: 'SCHEDULER_HEALTHY' },
]

async function installDashboardSession(page, role, capabilities) {
  await page.route('**/api/v1/session', (route) => route.fulfill(sessionFor(role, capabilities)))
}

test('@owner Dashboard opens the existing new-session drawer when appointment creation is allowed', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  await page.goto('./#/dashboard')

  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  await dashboard.getByRole('button', { name: 'Nowa sesja' }).click()
  await expect(page.getByRole('dialog', { name: 'Nowa sesja' })).toBeVisible()
})

test('@owner Dashboard hides the new-session action without appointment creation', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner.filter(
    (capability) => capability !== 'appointment.manage',
  ))
  await page.goto('./#/dashboard')

  await expect(page.getByRole('region', { name: 'Pulpit dnia' })
    .getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)
})

test('@owner does not request or see a Dashboard backup banner even when backups are stale', async ({ page }) => {
  const healthRequests = []
  await installDashboardSession(page, 'owner', ROLE_DEFAULT_CAPABILITIES.owner)
  await page.route('**/api/v1/operations/health', (route) => {
    healthRequests.push(route.request())
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: {
        generatedAt: '2026-09-13T12:00:00.001Z',
        checks: HEALTHY_CHECKS('2026-09-12T00:00:00.000Z'),
      } }),
    })
  })

  await page.goto('./#/dashboard')

  await expect(page.getByRole('region', { name: 'Pulpit dnia' })).toBeVisible()
  await expect(page.getByRole('alert', { name: 'Kopia zapasowa wymaga sprawdzenia' })).toHaveCount(0)
  expect(healthRequests).toHaveLength(0)
})

test('@coordinator with health capability does not request or see the Dashboard backup status', async ({ page }) => {
  const healthRequests = []
  await installDashboardSession(page, 'coordinator', ROLE_DEFAULT_CAPABILITIES.coordinator)
  await page.route('**/api/v1/operations/health', (route) => {
    healthRequests.push(route.request())
    return route.abort()
  })

  await page.goto('./#/dashboard')
  await page.waitForTimeout(50)

  expect(healthRequests).toHaveLength(0)
  await expect(page.getByRole('alert', { name: 'Kopia zapasowa wymaga sprawdzenia' })).toHaveCount(0)
})

test('@specialist does not request or see the Dashboard backup status', async ({ page }) => {
  const healthRequests = []
  await installDashboardSession(page, 'specialist', ROLE_DEFAULT_CAPABILITIES.specialist)
  await page.route('**/api/v1/operations/health', (route) => {
    healthRequests.push(route.request())
    return route.abort()
  })

  await page.goto('./#/dashboard')
  await page.waitForTimeout(50)

  expect(healthRequests).toHaveLength(0)
  await expect(page.getByRole('alert', { name: 'Kopia zapasowa wymaga sprawdzenia' })).toHaveCount(0)
})

test('@owner without health capability does not request or see the Dashboard backup status', async ({ page }) => {
  const healthRequests = []
  await installDashboardSession(page, 'owner', ROLE_DEFAULT_CAPABILITIES.owner.filter(
    (capability) => capability !== 'operations.health.read',
  ))
  await page.route('**/api/v1/operations/health', (route) => {
    healthRequests.push(route.request())
    return route.abort()
  })

  await page.goto('./#/dashboard')
  await page.waitForTimeout(50)

  expect(healthRequests).toHaveLength(0)
  await expect(page.getByRole('alert', { name: 'Kopia zapasowa wymaga sprawdzenia' })).toHaveCount(0)
})
