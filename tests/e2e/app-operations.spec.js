import { expect, test } from '@playwright/test'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const CSRF = /^v1\.[1-9]\d*\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/
const ACTION_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/

const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
const errorEnvelope = (status, code) => json(status, {
  error: { code, correlationId: `cor_operations_${status}` },
})

const actorFor = (role) => ({
  id: `stf_operations_${role}`,
  displayName: role === 'owner' ? 'Alicja Testowa'
    : role === 'coordinator' ? 'Celina Testowa' : 'Zofia Fikcyjna',
  email: `${role}@example.test`,
  professionalTitle: role === 'specialist' ? 'Psycholożka' : null,
  role,
  specialistId: role === 'specialist' ? 'sp_zofia' : null,
  version: 1,
})

const sessionEnvelope = ({ role = 'owner', capabilities }) => {
  const csrfExpiresAt = '2030-01-01T00:00:00.000Z'
  const csrfExpiresUnix = Date.parse(csrfExpiresAt) / 1000
  return json(200, {
    data: {
      actor: actorFor(role),
      authorityRevision: 1,
      capabilities,
      csrfExpiresAt,
      csrfToken: `v1.${csrfExpiresUnix}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      dataMode: 'fictional',
      environment: 'development',
    },
  })
}

const HEALTHY_CHECKS = [
  {
    id: 'outbox.processing', label: 'Kolejka zadań', status: 'ok',
    lastSuccessAt: '2026-09-13T11:58:00.000Z', detailCode: 'OUTBOX_HEALTHY',
  },
  {
    id: 'backup.freshness', label: 'Kopie zapasowe', status: 'ok',
    lastSuccessAt: '2026-09-13T02:00:00.000Z', detailCode: 'BACKUP_FRESH',
  },
  {
    id: 'access.reconciliation', label: 'Synchronizacja dostępu', status: 'ok',
    lastSuccessAt: '2026-09-13T11:57:00.000Z', detailCode: 'ACCESS_CURRENT',
  },
  {
    id: 'scheduler.runs', label: 'Zadania cykliczne', status: 'ok',
    lastSuccessAt: '2026-09-13T11:59:00.000Z', detailCode: 'SCHEDULER_HEALTHY',
  },
]

const healthEnvelope = (
  checks = HEALTHY_CHECKS,
  generatedAt = '2026-09-13T12:00:00.000Z',
) => json(200, { data: { generatedAt, checks } })

const action = ({
  id, kind, severity = 'critical', entityType, entityId, details,
  recovery = null, createdAt,
}) => ({
  id, kind, severity, entityType, entityId, details, recovery, version: 1,
  createdAt, updatedAt: createdAt,
})

const ACCESS_JOB = action({
  id: 'act_access_job', kind: 'outbox_job_failed', entityType: 'outbox_job',
  entityId: 'job_access_sync',
  details: {
    errorCode: 'OUTBOX_HANDLER_FAILURE', jobId: 'job_access_sync',
    outboxType: 'staff.access.reconcile',
  },
  recovery: { kind: 'access', status: 'available' },
  createdAt: '2026-09-13T11:55:00.000Z',
})

const DENIAL = action({
  id: 'act_denial_spike', kind: 'authorization_denial_spike', severity: 'warning',
  entityType: 'staff_user', entityId: 'stf_denial_target',
  details: {
    actorId: 'stf_denial_target', capability: 'operations.health.read', count: 12,
    errorCode: 'AUTHORIZATION_DENIAL_SPIKE', threshold: 10,
  },
  createdAt: '2026-09-13T11:54:00.000Z',
})

const BACKUP_FAILURE = action({
  id: 'act_backup_failure', kind: 'backup_failed', entityType: 'backup_run',
  entityId: 'bkp_failed_attempt',
  details: { backupId: 'bkp_failed_attempt', errorCode: 'BACKUP_FAILED' },
  createdAt: '2026-09-13T11:53:00.000Z',
})

const SCHEDULER_STALE = action({
  id: 'act_scheduler_stale', kind: 'scheduler_stale', entityType: 'scheduler_run',
  entityId: 'scheduler_run_stale',
  details: {
    errorCode: 'SCHEDULER_STALE', schedulerRunId: 'scheduler_run_stale',
    thresholdMinutes: 15,
  },
  createdAt: '2026-09-13T11:52:00.000Z',
})

const actionsEnvelope = (actions = [], truncated = false) => json(200, {
  data: { actions, truncated },
})

const recoveryEnvelope = (id, kind = 'access') => json(202, {
  data: {
    action: { id, status: 'open', version: 1 },
    recovery: { kind, status: 'queued' },
  },
})

const resolutionEnvelope = (id) => json(200, {
  data: {
    action: {
      id, status: 'resolved', version: 2,
      resolvedAt: '2026-09-13T12:05:00.000Z',
      updatedAt: '2026-09-13T12:05:00.000Z',
    },
  },
})

const installSession = (page, role, capabilities) => page.route(
  '**/api/v1/session',
  (route) => route.fulfill(sessionEnvelope({ role, capabilities })),
)

const installOperations = async (page, {
  health = (route) => route.fulfill(healthEnvelope()),
  actions = (route) => route.fulfill(actionsEnvelope()),
  resolution = (route) => route.fulfill(resolutionEnvelope('act_scheduler_stale')),
  recovery = (route) => route.fulfill(recoveryEnvelope('act_access_job')),
} = {}) => {
  await page.route('**/api/v1/operations/health', health)
  await page.route('**/api/v1/operations/actions', actions)
  await page.route('**/api/v1/operations/actions/*/resolution', resolution)
  await page.route('**/api/v1/operations/actions/*/recovery-attempts', recovery)
}

const pathname = (request) => new URL(request.url()).pathname

const openSecurity = async (page) => {
  await page.goto('./#/settings?section=security')
  await expect(page.getByRole('heading', { level: 2, name: 'Bezpieczeństwo danych' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('@owner shows one healthy summary and one native technical-details disclosure', async ({ page }) => {
  const requests = []
  page.on('request', (request) => requests.push(request))
  await installSession(page, 'owner', ['operations.health.read', 'permissions.manage'])
  await installOperations(page)

  await openSecurity(page)

  await expect(page).toHaveURL(/#\/settings\?section=security$/)
  await expect(page.getByText('Wszystko działa', { exact: true })).toBeVisible()
  await expect(page.getByText('Kopie zapasowe są wykonywane automatycznie każdej nocy.')).toBeVisible()
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(page.locator('.operations .pill')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Odśwież/ })).toHaveCount(0)
  await expect(page.locator('.operations details')).toHaveCount(1)
  await expect(page.getByText('OUTBOX_HEALTHY', { exact: true })).not.toBeVisible()

  await page.getByText('Pokaż szczegóły techniczne', { exact: true }).click()
  await expect(page.getByText('OUTBOX_HEALTHY', { exact: true })).toBeVisible()
  await expect(page.getByText('BACKUP_FRESH', { exact: true })).toBeVisible()
  await expect(page.getByText('ACCESS_CURRENT', { exact: true })).toBeVisible()
  await expect(page.getByText('SCHEDULER_HEALTHY', { exact: true })).toBeVisible()
  expect(requests.filter((request) => pathname(request) === '/api/v1/operations/health')).toHaveLength(1)
  expect(requests.filter((request) => pathname(request) === '/api/v1/operations/actions')).toHaveLength(1)
  expect(requests.filter((request) => pathname(request) === '/api/v1/security/audit')).toHaveLength(0)
})

test('@owner softens a failed attempt while the last successful backup is fresh', async ({ page }) => {
  const failedFresh = HEALTHY_CHECKS.map((item) => item.id === 'backup.freshness'
    ? { ...item, status: 'critical', detailCode: 'BACKUP_FAILED', lastSuccessAt: '2026-09-13T02:00:00.000Z' }
    : item)
  await installSession(page, 'owner', ['operations.health.read', 'permissions.manage'])
  await installOperations(page, {
    health: (route) => route.fulfill(healthEnvelope(failedFresh)),
    actions: (route) => route.fulfill(actionsEnvelope([BACKUP_FAILURE])),
  })

  await openSecurity(page)

  const summary = page.locator('.operations-summary')
  await expect(summary).toHaveAttribute('data-status', 'warning')
  await expect(summary).toContainText('Ostatnia próba kopii się nie udała')
  await expect(page.getByRole('heading', { name: /Co wymaga uwagi/ })).toHaveCount(0)
})

test('@owner sees only current problem cards with at most one permitted action', async ({ page }) => {
  const criticalChecks = HEALTHY_CHECKS.map((item) => item.id === 'outbox.processing'
    ? { ...item, status: 'critical', detailCode: 'OUTBOX_DEAD' }
    : item)
  await installSession(page, 'owner', ['operations.health.read', 'permissions.manage', 'staff.manage'])
  await installOperations(page, {
    health: (route) => route.fulfill(healthEnvelope(criticalChecks)),
    actions: (route) => route.fulfill(actionsEnvelope([ACCESS_JOB, DENIAL, BACKUP_FAILURE])),
  })

  await openSecurity(page)

  await expect(page.locator('.operations-summary')).toHaveAttribute('data-status', 'critical')
  await expect(page.getByRole('heading', { name: 'Co wymaga uwagi (2)' })).toBeVisible()
  const cards = page.locator('.operations-problem')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toContainText('Nie udało się zaktualizować dostępu')
  await expect(cards.nth(1)).toContainText('System zablokował więcej działań niż zwykle')
  await expect(cards.nth(0).locator('a, button')).toHaveCount(1)
  await expect(cards.nth(1).locator('a, button')).toHaveCount(1)
  const permissionLink = cards.nth(1).getByRole('link', { name: 'Sprawdź uprawnienia' })
  await expect(permissionLink).toHaveAttribute('href', '#/team?section=permissions')
  await expect(permissionLink).not.toHaveAttribute('href', /staffId/)
})

test('@owner queues one safe recovery and keeps the accepted result when refresh fails', async ({ page }) => {
  const requests = []
  let actionReads = 0
  page.on('request', (request) => requests.push(request))
  await installSession(page, 'owner', ['operations.health.read', 'permissions.manage', 'staff.manage'])
  await installOperations(page, {
    actions: (route) => {
      actionReads += 1
      return actionReads === 1 ? route.fulfill(actionsEnvelope([ACCESS_JOB])) : route.abort('connectionfailed')
    },
  })
  await openSecurity(page)

  await page.getByRole('button', { name: 'Ponów zadanie' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Ponowić zadanie?' })
  await dialog.getByRole('button', { name: 'Ponów zadanie' }).click()

  await expect(page.locator('.toasts')).toContainText('Ponowienie zadania zostało zlecone.')
  await expect(page.getByRole('alert')).toContainText('Działanie przyjęto, ale nie udało się odświeżyć listy problemów')
  const mutation = requests.find((request) => request.method() === 'POST'
    && pathname(request) === '/api/v1/operations/actions/act_access_job/recovery-attempts')
  expect(mutation).toBeTruthy()
  expect(await mutation.postDataJSON()).toEqual({ version: 1 })
  expect(mutation.headers()['x-csrf-token']).toMatch(CSRF)
  expect(mutation.headers()['idempotency-key']).toMatch(ACTION_KEY)
  expect(actionReads).toBe(2)
})

test('@owner hides one notification through the existing versioned mutation', async ({ page }) => {
  const requests = []
  let actionReads = 0
  page.on('request', (request) => requests.push(request))
  const schedulerCritical = HEALTHY_CHECKS.map((item) => item.id === 'scheduler.runs'
    ? { ...item, status: 'critical', detailCode: 'SCHEDULER_STALE' }
    : item)
  await installSession(page, 'owner', ['operations.health.read', 'permissions.manage'])
  await installOperations(page, {
    health: (route) => route.fulfill(healthEnvelope(schedulerCritical)),
    actions: (route) => {
      actionReads += 1
      return route.fulfill(actionsEnvelope(actionReads === 1 ? [SCHEDULER_STALE] : []))
    },
  })
  await openSecurity(page)

  await page.getByRole('button', { name: 'Ukryj powiadomienie' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Ukryć powiadomienie?' })
  await dialog.getByRole('button', { name: 'Ukryj powiadomienie' }).click()

  await expect(page.locator('.toasts')).toContainText('Powiadomienie zostało ukryte.')
  await expect(page.locator('.operations-problem')).toHaveCount(0)
  const mutation = requests.find((request) => request.method() === 'POST'
    && pathname(request) === '/api/v1/operations/actions/act_scheduler_stale/resolution')
  expect(await mutation.postDataJSON()).toEqual({ version: 1 })
  expect(mutation.headers()['idempotency-key']).toMatch(ACTION_KEY)
})

test('@owner retries only the existing safe reads after a loading error', async ({ page }) => {
  let healthReads = 0
  let actionReads = 0
  await installSession(page, 'owner', ['operations.health.read', 'permissions.manage'])
  await installOperations(page, {
    health: (route) => {
      healthReads += 1
      return route.fulfill(healthEnvelope())
    },
    actions: (route) => {
      actionReads += 1
      return actionReads === 1
        ? route.fulfill(errorEnvelope(500, 'INTERNAL_ERROR'))
        : route.fulfill(actionsEnvelope())
    },
  })

  await page.goto('./#/settings?section=security')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Nie udało się sprawdzić, czy wszystko działa')
  await expect(alert).not.toContainText('INTERNAL_ERROR')
  await alert.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect(page.getByText('Wszystko działa', { exact: true })).toBeVisible()
  expect(healthReads).toBe(2)
  expect(actionReads).toBe(2)
})

test('@owner keeps the stable security destination in settings and search', async ({ page }) => {
  await installSession(page, 'owner', ['operations.health.read', 'permissions.manage'])
  await installOperations(page)

  await page.goto('./#/settings?section=operations')
  await expect(page.getByRole('heading', { level: 2, name: 'Bezpieczeństwo danych' })).toBeVisible()
  await expect(page).not.toHaveURL(/section=operations/)

  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  await palette.getByRole('combobox', { name: 'Szukaj w panelu' }).fill('kopia zapasowa')
  await palette.getByRole('option', { name: 'Bezpieczeństwo danych' }).click()
  await expect(page).toHaveURL(/#\/settings\?section=security$/)
})

test('@coordinator with health capability has no data-security route, control, search result, or requests', async ({ page }) => {
  const requests = []
  page.on('request', (request) => requests.push(request))
  await installSession(page, 'coordinator', ['operations.health.read'])
  await installOperations(page)

  await page.goto('./#/settings?section=security')

  await expect(page).toHaveURL(/#\/profile(?:\?|$)/)
  await expect(page.getByRole('heading', { name: 'Bezpieczeństwo danych' })).toHaveCount(0)
  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  await palette.getByRole('combobox', { name: 'Szukaj w panelu' }).fill('kopia zapasowa')
  await expect(palette.getByRole('option', { name: 'Bezpieczeństwo danych' })).toHaveCount(0)
  expect(requests.filter((request) => pathname(request).startsWith('/api/v1/operations/'))).toHaveLength(0)
  expect(requests.filter((request) => pathname(request) === '/api/v1/security/audit')).toHaveLength(0)
})

test('@specialist never mounts or requests data security', async ({ page }) => {
  const requests = []
  page.on('request', (request) => requests.push(request))
  await installSession(page, 'specialist', ROLE_DEFAULT_CAPABILITIES.specialist)
  await installOperations(page)

  await page.goto('./#/settings?section=security')

  await expect(page).toHaveURL(/#\/profile(?:\?|$)/)
  await expect(page.getByRole('heading', { name: 'Bezpieczeństwo danych' })).toHaveCount(0)
  expect(requests.filter((request) => pathname(request).startsWith('/api/v1/operations/'))).toHaveLength(0)
  expect(requests.filter((request) => pathname(request) === '/api/v1/security/audit')).toHaveLength(0)
})
