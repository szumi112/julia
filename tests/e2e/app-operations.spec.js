import { mkdirSync } from 'node:fs'
import { test, expect } from '@playwright/test'

const VISUAL_DIR = '.superpowers/visual/task-9-gate-f'
const CURSOR = `v1.1.QQ.${'A'.repeat(43)}`
const CSRF = /^v1\.[1-9]\d*\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/
const ACTION_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const errorEnvelope = (status, code, details) => json(status, {
  error: details === undefined ? { code } : { code, details },
})

const sessionEnvelope = ({
  actor = {
    id: 'stf_capability_owner',
    displayName: 'Alicja Testowa',
    professionalTitle: null,
    role: 'owner',
    specialistId: null,
    version: 1,
  },
  authorityRevision = 1,
  capabilities = ['appointment.manage'],
} = {}) => {
  const csrfExpiresAt = '2030-01-01T00:00:00.000Z'
  const csrfExpiresUnix = Date.parse(csrfExpiresAt) / 1000
  return json(200, {
    data: {
      actor,
      authorityRevision,
      capabilities,
      csrfExpiresAt,
      csrfToken: `v1.${csrfExpiresUnix}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      dataMode: 'fictional',
      environment: 'development',
    },
  })
}

const coordinatorSession = () => sessionEnvelope({
  actor: {
    id: 'stf_capability_coordinator',
    displayName: 'Celina Testowa',
    professionalTitle: null,
    role: 'coordinator',
    specialistId: null,
    version: 1,
  },
  capabilities: [
    'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
    'client.manage', 'client.operational.read', 'finance.centre.read',
    'operations.health.read', 'payment.manage', 'specialist.directory.read', 'tus.manage',
  ],
})

const specialistSession = () => sessionEnvelope({
  actor: {
    id: 'stf_capability_specialist',
    displayName: 'Zofia Fikcyjna',
    professionalTitle: 'Specjalistka',
    role: 'specialist',
    specialistId: 'sp_zofia',
    version: 1,
  },
  capabilities: [
    'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
    'client.manage', 'client.operational.read', 'clinical.read', 'payment.manage',
    'specialist.directory.read', 'tus.manage',
  ],
})

const HEALTH_CHECKS = [
  {
    id: 'outbox.processing',
    label: 'Kolejka zadań',
    status: 'ok',
    lastSuccessAt: '2026-07-31T08:15:00.000Z',
    detailCode: 'OUTBOX_HEALTHY',
  },
  {
    id: 'backup.freshness',
    label: 'Kopie zapasowe',
    status: 'warning',
    lastSuccessAt: null,
    detailCode: 'BACKUP_PENDING',
  },
  {
    id: 'access.reconciliation',
    label: 'Synchronizacja dostępu',
    status: 'critical',
    lastSuccessAt: '2026-07-31T08:05:00.000Z',
    detailCode: 'ACCESS_RECONCILIATION_LAG',
  },
  {
    id: 'scheduler.runs',
    label: 'Zadania cykliczne',
    status: 'ok',
    lastSuccessAt: '2026-07-31T08:12:00.000Z',
    detailCode: 'SCHEDULER_HEALTHY',
  },
]

const healthEnvelope = (checks = HEALTH_CHECKS, generatedAt = '2026-07-31T08:20:00.000Z') => json(200, {
  data: { generatedAt, checks },
})

const ACTION_SPECS = [
  {
    id: 'act_scheduler_stale',
    kind: 'scheduler_stale',
    severity: 'critical',
    entityType: 'scheduler_run',
    entityId: 'scheduler_run_private',
    details: {
      errorCode: 'SCHEDULER_STALE',
      schedulerRunId: 'scheduler_run_private',
      thresholdMinutes: 15,
    },
  },
  {
    id: 'act_outbox_failed',
    kind: 'outbox_job_failed',
    severity: 'critical',
    entityType: 'outbox_job',
    entityId: 'outbox_provider_reference_private',
    details: {
      errorCode: 'OUTBOX_HANDLER_FAILURE',
      jobId: 'outbox_provider_reference_private',
      outboxType: 'staff.access.reconcile',
    },
  },
  {
    id: 'act_backup_stale',
    kind: 'backup_stale',
    severity: 'critical',
    entityType: 'centre',
    entityId: 'centre_1',
    details: { errorCode: 'BACKUP_STALE', thresholdHours: 36 },
  },
  {
    id: 'act_backup_failed',
    kind: 'backup_failed',
    severity: 'critical',
    entityType: 'backup_run',
    entityId: 'bkp_private_manifest_key',
    details: { backupId: 'bkp_private_manifest_key', errorCode: 'BACKUP_FAILED' },
  },
  {
    id: 'act_denial_spike',
    kind: 'authorization_denial_spike',
    severity: 'warning',
    entityType: 'staff_user',
    entityId: 'stf_access_subject_private',
    details: {
      actorId: 'stf_access_subject_private',
      capability: 'security.audit.read',
      count: 18,
      errorCode: 'AUTHORIZATION_DENIAL_SPIKE',
      threshold: 10,
    },
  },
  {
    id: 'act_access_lag',
    kind: 'access_reconciliation_lag',
    severity: 'critical',
    entityType: 'access_group',
    entityId: 'centre_1',
    details: {
      appliedGeneration: 4,
      desiredGeneration: 5,
      errorCode: 'ACCESS_RECONCILIATION_LAG',
    },
  },
]

const makeActions = (specs = ACTION_SPECS) => specs.map((spec, index) => {
  const createdAt = new Date(Date.UTC(2026, 6, 31, 8, 19 - index)).toISOString()
  return { ...spec, details: { ...spec.details }, version: 1, createdAt, updatedAt: createdAt }
})

const actionsEnvelope = (actions = makeActions(), truncated = false) => json(200, {
  data: { actions, truncated },
})

const resolvedEnvelope = (id, version = 2) => json(200, {
  data: {
    action: {
      id,
      status: 'resolved',
      version,
      resolvedAt: '2026-07-31T08:30:00.000Z',
      updatedAt: '2026-07-31T08:30:00.000Z',
    },
  },
})

const AUDIT_SPECS = [
  ['authorization.denied', 'staff_user', 'stf_reason_private', 'denied', { version: 2 }, 'stf_actor_private'],
  ['backup.pruned', 'backup_run', 'bkp_private_backup_version', 'success', { backupVersion: 7 }, null],
  ['data_key.rewrapped', 'data_key', 'data_key_wrapped_raw_private', 'success', { newKekVersion: 3, oldKekVersion: 2 }, 'stf_actor_private'],
  ['identity.activation', 'staff_user', 'stf_identity_private', 'success', { invitationVersion: 2, staffVersion: 3 }, 'stf_actor_private'],
  ['identity.denied', 'staff_user', 'stf_identity_denied_private', 'denied', { version: 2 }, 'stf_actor_private'],
  ['identity.reindex', 'staff_invitation', 'inv_ciphertext_nonce_private', 'success', { version: 2 }, 'stf_actor_private'],
  ['operational_action.resolved', 'operational_action', 'act_resolved_private', 'success', { actionVersion: 2 }, 'stf_actor_private'],
  ['staff.access.reconciled', 'access_group', 'centre_1', 'success', { appliedGeneration: 4, desiredGeneration: 5, invitationCount: 1 }, 'stf_actor_private'],
  ['staff.bootstrap', 'staff_user', 'stf_bootstrap_private', 'success', { desiredGeneration: 1, invitationVersion: 1, staffVersion: 1 }, 'stf_actor_private'],
  ['staff.deactivated', 'staff_user', 'stf_deactivated_private', 'success', { desiredGeneration: 6, staffVersion: 2 }, 'stf_actor_private'],
  ['staff.invitation.email_accepted', 'staff_invitation', 'inv_email_private', 'success', { invitationVersion: 2 }, 'stf_actor_private'],
  ['staff.invitation.expired', 'staff_invitation', 'inv_expired_private', 'success', { desiredGeneration: 7, invitationVersion: 3, staffVersion: 2 }, 'stf_actor_private'],
  ['staff.invited', 'staff_invitation', 'inv_provider_body_private', 'success', { desiredGeneration: 8, invitationVersion: 1, staffVersion: 1 }, 'stf_actor_private'],
]

const makeAuditEvents = (count = AUDIT_SPECS.length, offset = 0) => Array.from({ length: count }, (_, index) => {
  const spec = AUDIT_SPECS[(index + offset) % AUDIT_SPECS.length]
  const occurredAt = new Date(Date.UTC(2026, 6, 31, 8, 18) - (index + offset) * 60_000).toISOString()
  return {
    id: `evt_${String(index + offset).padStart(3, '0')}`,
    occurredAt,
    actorStaffId: spec[5],
    action: spec[0],
    entityType: spec[1],
    entityId: spec[2],
    result: spec[3],
    correlationId: `corr_${String(index + offset).padStart(3, '0')}`,
    metadata: { ...spec[4] },
  }
})

const auditEnvelope = (events = makeAuditEvents(), nextCursor = null) => json(200, {
  data: { events, nextCursor },
})

const operationPath = (request) => new URL(request.url()).pathname

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

async function installOperationsRoutes(page, {
  health = (route) => route.fulfill(healthEnvelope()),
  actions = (route) => route.fulfill(actionsEnvelope()),
  resolution = (route) => route.fulfill(resolvedEnvelope('act_scheduler_stale')),
  audit = (route) => route.fulfill(auditEnvelope()),
} = {}) {
  await page.route('**/api/v1/operations/health', health)
  await page.route('**/api/v1/operations/actions', actions)
  await page.route('**/api/v1/operations/actions/*/resolution', resolution)
  await page.route('**/api/v1/security/audit*', audit)
}

async function openSettings(page) {
  await page.goto('./#/settings')
  await expect(page.getByRole('heading', { name: /^Ustawienia / })).toBeVisible()
}

async function openOperations(page) {
  await openSettings(page)
  const choice = page.getByRole('button', { name: 'Stan i bezpieczeństwo' })
  if (await choice.count()) await choice.click()
  else await page.getByLabel('Sekcja ustawień').selectOption('operations')
  await expect(page.getByRole('heading', { name: 'Stan i bezpieczeństwo' })).toBeVisible()
}

async function openActions(page) {
  await openOperations(page)
  await page.getByRole('tab', { name: 'Działania' }).click()
}

const operationRequests = (requests, method, pathname) => requests.filter((request) => (
  request.method() === method && operationPath(request) === pathname
))

test('@owner mounts operations once and loads audit only on first selection', async ({ page }) => {
  const requests = []
  page.on('request', (request) => requests.push(request))
  await installOperationsRoutes(page)

  await openOperations(page)

  await expect(page.getByText('Kolejka zadań', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Działania' })).toBeVisible()
  expect(operationRequests(requests, 'GET', '/api/v1/operations/health')).toHaveLength(1)
  expect(operationRequests(requests, 'GET', '/api/v1/operations/actions')).toHaveLength(1)
  expect(operationRequests(requests, 'GET', '/api/v1/security/audit')).toHaveLength(0)

  await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()
  await expect(page.getByText('Odmowa autoryzacji', { exact: true })).toBeVisible()
  expect(operationRequests(requests, 'GET', '/api/v1/security/audit')).toHaveLength(1)
  await page.getByRole('tab', { name: 'Stan systemu' }).click()
  await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()
  await page.waitForTimeout(250)
  expect(operationRequests(requests, 'GET', '/api/v1/security/audit')).toHaveLength(1)
  expect(operationRequests(requests, 'GET', '/api/v1/operations/health')).toHaveLength(1)
  expect(operationRequests(requests, 'GET', '/api/v1/operations/actions')).toHaveLength(1)
})

test('@owner correction retains concurrent resource announcements and repeats health mutations', async ({ page }) => {
  let releaseHealth
  let releaseActions
  let healthReads = 0
  const healthReleased = new Promise((resolve) => { releaseHealth = resolve })
  const actionsReleased = new Promise((resolve) => { releaseActions = resolve })
  await installOperationsRoutes(page, {
    health: async (route) => {
      healthReads += 1
      if (healthReads === 1) await healthReleased
      await route.fulfill(healthEnvelope())
    },
    actions: async (route) => {
      if (healthReads === 1) await actionsReleased
      await route.fulfill(actionsEnvelope())
    },
  })
  await openOperations(page)
  releaseHealth()
  releaseActions()

  const healthLive = page.getByRole('status', { name: 'Komunikaty stanu systemu' })
  const actionsLive = page.getByRole('status', { name: 'Komunikaty działań' })
  await expect(healthLive).toHaveText('Stan systemu został odświeżony.')
  await expect(actionsLive).toHaveText('Lista działań została odświeżona.')
  await healthLive.locator('span').evaluate((element) => {
    window.__bwmHealthAnnouncement = element
  })

  await page.getByRole('button', { name: 'Odśwież stan systemu' }).click()

  await expect.poll(() => healthLive.locator('span').evaluate((element) => (
    element !== window.__bwmHealthAnnouncement
  ))).toBe(true)
  await expect(healthLive).toHaveText('Stan systemu został odświeżony.')
  await expect(actionsLive).toHaveText('Lista działań została odświeżona.')
  expect(healthReads).toBe(2)
  await page.evaluate(() => { delete window.__bwmHealthAnnouncement })
})

test('@coordinator filters security authority and denial spikes before row construction', async ({ page }) => {
  const requests = []
  page.on('request', (request) => requests.push(request))
  await installOperationsRoutes(page)

  await openActions(page)

  await expect(page.getByRole('tab', { name: 'Bezpieczeństwo' })).toHaveCount(0)
  await expect(page.getByText('Wzrost odmów dostępu', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Nieaktualne zadania cykliczne', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Wzrost odmów dostępu/ })).toHaveCount(0)
  expect(operationRequests(requests, 'GET', '/api/v1/security/audit')).toHaveLength(0)
})

test('@coordinator correction derives truncation notice after denial-spike filtering', async ({ page }) => {
  const visibleSpecs = ACTION_SPECS.filter((spec) => spec.kind !== 'authorization_denial_spike')
  const pageOf = (includeHidden) => Array.from({ length: 100 }, (_, index) => {
    const base = includeHidden && index === 99
      ? ACTION_SPECS.find((spec) => spec.kind === 'authorization_denial_spike')
      : visibleSpecs[index % visibleSpecs.length]
    const createdAt = new Date(Date.UTC(2026, 6, 31, 8, 19) - index * 60_000).toISOString()
    const entityId = base.kind === 'backup_failed'
      ? `bkp_correction_${index}`
      : base.entityType === 'centre' || base.entityType === 'access_group'
        ? 'centre_1'
        : `${base.entityType}_correction_${index}`
    const details = { ...base.details }
    if (base.kind === 'backup_failed') details.backupId = entityId
    if (base.kind === 'authorization_denial_spike') details.actorId = entityId
    if (base.kind === 'outbox_job_failed') details.jobId = entityId
    if (base.kind === 'scheduler_stale') details.schedulerRunId = entityId
    return {
      ...base,
      id: `act_correction_${String(999 - index).padStart(3, '0')}`,
      entityId,
      details,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    }
  })
  let reads = 0
  await installOperationsRoutes(page, {
    actions: (route) => {
      reads += 1
      return route.fulfill(actionsEnvelope(pageOf(reads === 1), true))
    },
  })
  await openActions(page)

  await expect(page.locator('.operations-action-row')).toHaveCount(99)
  await expect(page.getByText('Wyświetlono 100 najnowszych działań.', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Odśwież działania' }).click()
  await expect(page.locator('.operations-action-row')).toHaveCount(100)
  await expect(page.getByText('Wyświetlono 100 najnowszych działań.', { exact: true })).toBeVisible()
})

test('@specialist never mounts or requests operations', async ({ page }) => {
  const requests = []
  page.on('request', (request) => requests.push(request))
  await installOperationsRoutes(page)

  await openSettings(page)

  await expect(page.getByText('Stan i bezpieczeństwo', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('tablist', { name: 'Obszary stanu i bezpieczeństwa' })).toHaveCount(0)
  expect(requests.filter((request) => operationPath(request).startsWith('/api/v1/operations'))).toHaveLength(0)
  expect(operationRequests(requests, 'GET', '/api/v1/security/audit')).toHaveLength(0)
})

test('@owner changes to coordinator authority without security or denial-spike UI', async ({ page }) => {
  const requests = []
  page.on('request', (request) => requests.push(request))
  await installOperationsRoutes(page)
  await openOperations(page)
  await expect(page.getByRole('tab', { name: 'Bezpieczeństwo' })).toBeVisible()

  await page.route('**/api/v1/session', (route) => route.fulfill(coordinatorSession()))
  await page.evaluate(() => window.dispatchEvent(new Event('bwm:test-auth-refresh')))

  await expect(page.getByRole('heading', { name: 'Stan i bezpieczeństwo' })).toBeVisible()
  await page.getByRole('tab', { name: 'Działania' }).click()
  await expect(page.getByRole('tab', { name: 'Bezpieczeństwo' })).toHaveCount(0)
  await expect(page.getByText('Wzrost odmów dostępu', { exact: true })).toHaveCount(0)
  expect(operationRequests(requests, 'GET', '/api/v1/security/audit')).toHaveLength(0)
})

test('@owner correction to coordinator revokes pending active security without stale audit publication', async ({ page }) => {
  let releaseAudit
  let auditReads = 0
  const auditReleased = new Promise((resolve) => { releaseAudit = resolve })
  await installOperationsRoutes(page, {
    audit: async (route) => {
      auditReads += 1
      await auditReleased
      await route.fulfill(auditEnvelope(makeAuditEvents(1)))
    },
  })
  await openOperations(page)
  await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()
  await expect(page.getByText('Pobieranie zdarzeń bezpieczeństwa…', { exact: true })).toBeVisible()

  await page.route('**/api/v1/session', (route) => route.fulfill(coordinatorSession()))
  await page.evaluate(() => window.dispatchEvent(new Event('bwm:test-auth-refresh')))

  await expect(page.getByRole('tab', { name: 'Stan systemu' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Bezpieczeństwo' })).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Komunikaty bezpieczeństwa' })).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Komunikaty stanu systemu' })).toHaveText('Stan systemu został odświeżony.')
  await expect(page.getByRole('status', { name: 'Komunikaty działań' })).toHaveText('Lista działań została odświeżona.')
  expect(auditReads).toBe(1)
  releaseAudit()
  await page.waitForTimeout(150)
  await expect(page.getByText('Odmowa autoryzacji', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Pobieranie zdarzeń bezpieczeństwa…', { exact: true })).toHaveCount(0)
  expect(auditReads).toBe(1)
})

test('@owner role change unmounts operations and invalidates a pending publication', async ({ page }) => {
  let releaseActions
  const actionsReleased = new Promise((resolve) => { releaseActions = resolve })
  let actionsRequests = 0
  await installOperationsRoutes(page, {
    actions: async (route) => {
      actionsRequests += 1
      await actionsReleased
      await route.fulfill(actionsEnvelope())
    },
  })
  await openOperations(page)
  await page.getByRole('tab', { name: 'Działania' }).click()
  await expect(page.getByText('Pobieranie działań…', { exact: true })).toBeVisible()

  await page.route('**/api/v1/session', (route) => route.fulfill(specialistSession()))
  await page.evaluate(() => window.dispatchEvent(new Event('bwm:test-auth-refresh')))

  await expect(page.getByRole('heading', { name: 'Stan i bezpieczeństwo' })).toHaveCount(0)
  await expect(page.getByText('Stan i bezpieczeństwo', { exact: true })).toHaveCount(0)
  releaseActions()
  await page.waitForTimeout(100)
  await expect(page.getByText('Nieaktualne zadania cykliczne', { exact: true })).toHaveCount(0)
  expect(actionsRequests).toBe(1)
  expect(page.url()).not.toContain('section=operations')
})

test('@owner shows stable delayed loading and valid actions and audit empty states', async ({ page }) => {
  let releaseHealth
  let releaseActions
  let releaseAudit
  const healthReleased = new Promise((resolve) => { releaseHealth = resolve })
  const actionsReleased = new Promise((resolve) => { releaseActions = resolve })
  const auditReleased = new Promise((resolve) => { releaseAudit = resolve })
  await installOperationsRoutes(page, {
    health: async (route) => { await healthReleased; await route.fulfill(healthEnvelope()) },
    actions: async (route) => { await actionsReleased; await route.fulfill(actionsEnvelope([])) },
    audit: async (route) => { await auditReleased; await route.fulfill(auditEnvelope([])) },
  })

  await openOperations(page)
  await expect(page.getByText('Pobieranie stanu systemu…', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Działania' }).click()
  await expect(page.getByText('Pobieranie działań…', { exact: true })).toBeVisible()
  releaseActions()
  await expect(page.getByText('Brak otwartych działań.', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()
  await expect(page.getByText('Pobieranie zdarzeń bezpieczeństwa…', { exact: true })).toBeVisible()
  releaseAudit()
  await expect(page.getByText('Brak zdarzeń bezpieczeństwa.', { exact: true })).toBeVisible()
  releaseHealth()
})

test('@owner treats zero health checks as a neutral retryable error', async ({ page }) => {
  let attempts = 0
  await installOperationsRoutes(page, {
    health: (route) => {
      attempts += 1
      return attempts === 1
        ? route.fulfill(healthEnvelope([]))
        : route.fulfill(healthEnvelope())
    },
  })

  await openOperations(page)
  await expect(page.getByRole('alert')).toContainText('Nie udało się pobrać danych.')
  await expect(page.getByText('Działa prawidłowo', { exact: true })).toHaveCount(0)
  expect(attempts).toBe(1)
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect(page.getByText('Kolejka zadań', { exact: true })).toBeVisible()
  expect(attempts).toBe(2)
})

test('@owner retries initial actions and audit failures only from their active panels', async ({ page }) => {
  let actionAttempts = 0
  let auditAttempts = 0
  await installOperationsRoutes(page, {
    actions: (route) => {
      actionAttempts += 1
      return actionAttempts === 1
        ? route.fulfill(errorEnvelope(403, 'FORBIDDEN'))
        : route.fulfill(actionsEnvelope([]))
    },
    audit: async (route) => {
      auditAttempts += 1
      return auditAttempts === 1
        ? route.fulfill(json(200, { data: {} }))
        : route.fulfill(auditEnvelope([]))
    },
  })
  await openOperations(page)
  await page.getByRole('tab', { name: 'Działania' }).click()
  await expect(page.getByRole('alert')).toContainText('Uprawnienia do tych danych uległy zmianie.')
  await page.waitForTimeout(200)
  expect(actionAttempts).toBe(1)
  expect(auditAttempts).toBe(0)
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect(page.getByText('Brak otwartych działań.', { exact: true })).toBeVisible()

  await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()
  await expect(page.getByRole('alert')).toContainText('Nie udało się pobrać danych.')
  expect(auditAttempts).toBe(1)
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect(page.getByText('Brak zdarzeń bezpieczeństwa.', { exact: true })).toBeVisible()
  expect(actionAttempts).toBe(2)
  expect(auditAttempts).toBe(2)
})

for (const failure of [
  { name: 'network', respond: (route) => route.abort('connectionfailed'), copy: 'Nie udało się pobrać danych.' },
  { name: 'malformed', respond: (route) => route.fulfill(json(200, { data: {} })), copy: 'Nie udało się pobrać danych.' },
  { name: 'server', respond: (route) => route.fulfill(errorEnvelope(500, 'INTERNAL_ERROR')), copy: 'Nie udało się pobrać danych.' },
  { name: 'forbidden', respond: (route) => route.fulfill(errorEnvelope(403, 'FORBIDDEN')), copy: 'Uprawnienia do tych danych uległy zmianie.' },
]) {
  test(`@owner uses fixed copy and explicit retry for ${failure.name} health failure`, async ({ page }) => {
    let attempts = 0
    await installOperationsRoutes(page, {
      health: (route) => {
        attempts += 1
        return attempts === 1 ? failure.respond(route) : route.fulfill(healthEnvelope())
      },
    })

    await openOperations(page)
    await expect(page.getByRole('alert')).toContainText(failure.copy)
    await expect(page.getByRole('alert')).not.toContainText(/INTERNAL_ERROR|FORBIDDEN|INVALID_RESPONSE|NETWORK_ERROR/)
    await page.waitForTimeout(250)
    expect(attempts).toBe(1)
    await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()
    await expect(page.getByText('Kolejka zadań', { exact: true })).toBeVisible()
    expect(attempts).toBe(2)
  })
}

test('@owner refreshes only the active resource and retains stale health until retry succeeds', async ({ page }) => {
  let healthRequests = 0
  let actionsRequests = 0
  let auditRequests = 0
  let releaseRefresh
  const refreshReleased = new Promise((resolve) => { releaseRefresh = resolve })
  await installOperationsRoutes(page, {
    health: async (route) => {
      healthRequests += 1
      if (healthRequests === 2) {
        await refreshReleased
        await route.abort('connectionfailed')
        return
      }
      const checks = healthRequests === 3
        ? HEALTH_CHECKS.map((check) => check.id === 'backup.freshness'
          ? { ...check, status: 'ok', detailCode: 'BACKUP_FRESH' }
          : check)
        : HEALTH_CHECKS
      await route.fulfill(healthEnvelope(checks, healthRequests === 3
        ? '2026-07-31T08:40:00.000Z'
        : '2026-07-31T08:20:00.000Z'))
    },
    actions: (route) => { actionsRequests += 1; return route.fulfill(actionsEnvelope()) },
    audit: (route) => { auditRequests += 1; return route.fulfill(auditEnvelope()) },
  })
  await openOperations(page)
  await expect(page.getByText('Kopia zapasowa oczekuje na utworzenie.', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Odśwież stan systemu' }).click()
  await expect(page.getByRole('button', { name: 'Odśwież stan systemu' })).toBeDisabled()
  await expect(page.getByText('Kopia zapasowa oczekuje na utworzenie.', { exact: true })).toBeVisible()
  expect(actionsRequests).toBe(1)
  expect(auditRequests).toBe(0)
  releaseRefresh()
  await expect(page.getByRole('alert')).toContainText('Nie udało się odświeżyć. Wyświetlane dane mogą być nieaktualne.')
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect(page.getByText('Ostatnia kopia zapasowa jest aktualna.', { exact: true })).toBeVisible()
  await expect(page.getByText('Kopia zapasowa oczekuje na utworzenie.', { exact: true })).toHaveCount(0)
  expect(healthRequests).toBe(3)
  expect(actionsRequests).toBe(1)
  expect(auditRequests).toBe(0)
})

test('@owner renders exact health order, tones, time copy, and no backend codes', async ({ page }) => {
  await installOperationsRoutes(page)
  await openOperations(page)

  const rows = page.getByRole('tabpanel', { name: 'Stan systemu' }).locator('.operations-row')
  await expect(rows).toHaveCount(4)
  await expect(rows.locator('.operations-row__title')).toHaveText([
    'Kolejka zadań',
    'Kopie zapasowe',
    'Synchronizacja dostępu',
    'Zadania cykliczne',
  ])
  await expect(rows.nth(0).getByText('Działa prawidłowo', { exact: true })).toBeVisible()
  await expect(rows.nth(1).getByText('Wymaga uwagi', { exact: true })).toBeVisible()
  await expect(rows.nth(2).getByText('Wymaga działania', { exact: true })).toBeVisible()
  await expect(rows.nth(1)).toContainText('Brak zapisanego powodzenia.')
  await expect(rows.nth(0)).toContainText('Ostatnie powodzenie:')
  await expect(page.getByText(/^Stan z /)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(/OUTBOX_|BACKUP_|ACCESS_|SCHEDULER_/)
})

test('@owner preserves action order, fixed copy, truncation notice, and privacy', async ({ page }) => {
  const actions = Array.from({ length: 100 }, (_, index) => {
    const base = ACTION_SPECS[index % ACTION_SPECS.length]
    const createdAt = new Date(Date.UTC(2026, 6, 31, 8, 19) - index * 60_000).toISOString()
    const entityId = base.kind === 'backup_failed'
      ? `bkp_private_${index}`
      : base.entityType === 'centre' || base.entityType === 'access_group'
        ? 'centre_1'
        : `${base.entityType}_${index}`
    const details = { ...base.details }
    if (base.kind === 'backup_failed') details.backupId = entityId
    if (base.kind === 'authorization_denial_spike') details.actorId = entityId
    if (base.kind === 'outbox_job_failed') details.jobId = entityId
    if (base.kind === 'scheduler_stale') details.schedulerRunId = entityId
    return {
      ...base,
      id: `act_${String(999 - index).padStart(3, '0')}`,
      entityId,
      details,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    }
  })
  await installOperationsRoutes(page, { actions: (route) => route.fulfill(actionsEnvelope(actions, true)) })
  await openActions(page)

  const rows = page.locator('.operations-action-row')
  await expect(rows).toHaveCount(100)
  await expect(rows.nth(0)).toContainText('Nieaktualne zadania cykliczne')
  await expect(rows.nth(1)).toContainText('Nieudane zadanie')
  for (const label of [
    'Nieaktualne zadania cykliczne',
    'Nieudane zadanie',
    'Nieaktualna kopia zapasowa',
    'Nieudana kopia zapasowa',
    'Wzrost odmów dostępu',
    'Opóźniona synchronizacja dostępu',
  ]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible()
  }
  await expect(page.getByText('Wyświetlono 100 najnowszych działań.', { exact: true })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(/act_|bkp_|centre_1|stf_|threshold|Generation|SCHEDULER_STALE|OUTBOX_HANDLER_FAILURE|security\.audit\.read/)
})

test('@owner tabs have roving keyboard semantics and resource-specific refresh labels', async ({ page }) => {
  await installOperationsRoutes(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openOperations(page)
  const health = page.getByRole('tab', { name: 'Stan systemu' })
  const actions = page.getByRole('tab', { name: 'Działania' })
  const security = page.getByRole('tab', { name: 'Bezpieczeństwo' })

  await health.focus()
  await page.keyboard.press('ArrowRight')
  await expect(actions).toBeFocused()
  await expect(actions).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Odśwież działania' })).toBeVisible()
  await page.keyboard.press('End')
  await expect(security).toBeFocused()
  await expect(page.getByRole('button', { name: 'Odśwież bezpieczeństwo' })).toBeVisible()
  await page.keyboard.press('Home')
  await expect(health).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(security).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(health).toBeFocused()
  await expect(page.getByRole('button', { name: 'Odśwież stan systemu' })).toBeVisible()
})

test('@owner resolution is a top-layer keyboard modal and sends one exact mutation', async ({ page }) => {
  let posts = 0
  let requestRecord
  let releasePost
  const postReleased = new Promise((resolve) => { releasePost = resolve })
  let actionsReads = 0
  await installOperationsRoutes(page, {
    actions: (route) => {
      actionsReads += 1
      return route.fulfill(actionsEnvelope(actionsReads === 1 ? makeActions([ACTION_SPECS[0]]) : []))
    },
    resolution: async (route) => {
      posts += 1
      requestRecord = route.request()
      await postReleased
      await route.fulfill(resolvedEnvelope('act_scheduler_stale'))
    },
  })
  await openActions(page)
  const opener = page.getByRole('button', { name: 'Oznacz jako rozwiązane' })
  await opener.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('alertdialog', { name: 'Oznacz działanie jako rozwiązane' })
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true)
  const back = dialog.getByRole('button', { name: 'Wróć' })
  const confirm = dialog.getByRole('button', { name: 'Oznacz jako rozwiązane' })
  await expect(back).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(confirm).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(back).toBeFocused()
  for (const shortcut of ['Control+K', 'Meta+K']) {
    await page.keyboard.press(shortcut)
    await expect(page.getByRole('dialog', { name: 'Szukaj w panelu' })).toHaveCount(0)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await opener.click()
  await expect(dialog).toBeVisible()
  await confirm.focus()
  await page.keyboard.press('Enter')
  await expect(confirm).toBeDisabled()
  await expect(back).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Enter')
  expect(posts).toBe(1)
  expect(operationPath(requestRecord)).toBe('/api/v1/operations/actions/act_scheduler_stale/resolution')
  expect(requestRecord.postDataJSON()).toEqual({ version: 1 })
  expect(requestRecord.headers()['x-csrf-token']).toMatch(CSRF)
  expect(requestRecord.headers()['idempotency-key']).toMatch(ACTION_KEY)
  releasePost()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Działanie zostało oznaczone jako rozwiązane.', { exact: true })).toBeVisible()
  await expect(opener).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Działania' })).toBeFocused()
  expect(posts).toBe(1)
  expect(actionsReads).toBe(2)
})

test('@owner correction synchronously locks duplicate resolution confirmation', async ({ page }) => {
  const keys = []
  let posts = 0
  await installOperationsRoutes(page, {
    actions: (route) => route.fulfill(actionsEnvelope(makeActions([ACTION_SPECS[0]]))),
    resolution: (route) => {
      posts += 1
      keys.push(route.request().headers()['idempotency-key'])
      return route.fulfill(errorEnvelope(429, 'RATE_LIMITED'))
    },
  })
  await openActions(page)
  await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
  const dialog = page.getByRole('alertdialog')

  await dialog.getByRole('button', { name: 'Oznacz jako rozwiązane' }).evaluate((button) => {
    button.click()
    button.click()
  })
  await page.waitForTimeout(150)

  expect(posts).toBe(1)
  expect(keys).toHaveLength(1)
  expect(keys[0]).toMatch(ACTION_KEY)
})

for (const dismissal of [
  {
    name: 'Wróć',
    run: (button) => {
      const dialog = button.closest('dialog')
      button.click()
      ;[...dialog.querySelectorAll('button')]
        .find((candidate) => candidate.textContent.trim() === 'Wróć')
        .click()
    },
  },
  {
    name: 'backdrop',
    run: (button) => {
      const dialog = button.closest('dialog')
      button.click()
      dialog.querySelector('.leave-confirm__backdrop').click()
    },
  },
  {
    name: 'native cancel',
    run: (button) => {
      const dialog = button.closest('dialog')
      button.click()
      const cancel = new Event('cancel', { cancelable: true })
      dialog.dispatchEvent(cancel)
      return cancel.defaultPrevented
    },
  },
]) {
  test(`@owner correction keeps reconciliation ownership after same-task ${dismissal.name}`, async ({ page }) => {
    let actionReads = 0
    let posts = 0
    let releasePost
    const postReleased = new Promise((resolve) => { releasePost = resolve })
    await installOperationsRoutes(page, {
      actions: (route) => {
        actionReads += 1
        return route.fulfill(actionsEnvelope(actionReads === 1 ? makeActions([ACTION_SPECS[0]]) : []))
      },
      resolution: async (route) => {
        posts += 1
        await postReleased
        await route.fulfill(resolvedEnvelope('act_scheduler_stale'))
      },
    })
    await openActions(page)
    await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
    const dialog = page.getByRole('alertdialog')
    const confirm = dialog.getByRole('button', { name: 'Oznacz jako rozwiązane' })

    const cancelPrevented = await confirm.evaluate(dismissal.run)

    if (dismissal.name === 'native cancel') expect(cancelPrevented).toBe(true)
    await expect(dialog).toBeVisible()
    expect(posts).toBe(1)
    expect(actionReads).toBe(1)

    releasePost()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('Działanie zostało oznaczone jako rozwiązane.', { exact: true })).toBeVisible()
    expect(actionReads).toBe(2)
    expect(posts).toBe(1)
  })
}

test('@owner retains confirmed success as stale when the reconciliation read fails', async ({ page }) => {
  let reads = 0
  await installOperationsRoutes(page, {
    actions: (route) => {
      reads += 1
      return reads === 1
        ? route.fulfill(actionsEnvelope(makeActions([ACTION_SPECS[0]])))
        : route.abort('connectionfailed')
    },
    resolution: (route) => route.fulfill(resolvedEnvelope('act_scheduler_stale')),
  })
  await openActions(page)
  await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()

  await expect(page.getByText('Działanie zostało oznaczone jako rozwiązane.', { exact: true })).toBeVisible()
  await expect(page.getByText('Nieaktualne zadania cykliczne', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Działanie zapisano, ale lista może być nieaktualna.')
})

test('@owner role change during resolution prevents detached reconciliation', async ({ page }) => {
  let actionReads = 0
  let posts = 0
  let markPostSeen
  let releasePost
  const postSeen = new Promise((resolve) => { markPostSeen = resolve })
  const postReleased = new Promise((resolve) => { releasePost = resolve })
  await installOperationsRoutes(page, {
    actions: (route) => {
      actionReads += 1
      return route.fulfill(actionsEnvelope(makeActions([ACTION_SPECS[0]])))
    },
    resolution: async (route) => {
      posts += 1
      markPostSeen()
      await postReleased
      await route.fulfill(resolvedEnvelope('act_scheduler_stale'))
    },
  })
  await openActions(page)
  await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
  await postSeen

  await page.route('**/api/v1/session', (route) => route.fulfill(specialistSession()))
  await page.evaluate(() => window.dispatchEvent(new Event('bwm:test-auth-refresh')))
  await expect(page.getByRole('heading', { name: 'Stan i bezpieczeństwo' })).toHaveCount(0)
  releasePost()
  await page.waitForTimeout(250)

  expect(posts).toBe(1)
  expect(actionReads).toBe(1)
  await expect(page.getByText('Działanie zostało oznaczone jako rozwiązane.', { exact: true })).toHaveCount(0)
})

test('@owner reconciles a version conflict and uses a fresh key after a new confirmation', async ({ page }) => {
  const keys = []
  let posts = 0
  let reads = 0
  await installOperationsRoutes(page, {
    actions: (route) => { reads += 1; return route.fulfill(actionsEnvelope(makeActions([ACTION_SPECS[0]]))) },
    resolution: (route) => {
      posts += 1
      keys.push(route.request().headers()['idempotency-key'])
      return route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT', { currentVersion: 99 }))
    },
  })
  await openActions(page)
  const resolve = async () => {
    await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
  }
  await resolve()
  await expect(page.getByText('Działanie nadal jest otwarte.', { exact: true })).toBeVisible()
  await resolve()

  expect(posts).toBe(2)
  expect(reads).toBe(3)
  expect(keys).toHaveLength(2)
  expect(keys[0]).not.toBe(keys[1])
})

for (const uncertain of [
  { name: 'transport', respond: (route) => route.abort('connectionfailed') },
  { name: 'malformed', respond: (route) => route.fulfill(json(200, { data: {} })) },
  { name: 'server', respond: (route) => route.fulfill(errorEnvelope(500, 'INTERNAL_ERROR')) },
]) {
  test(`@owner reconciles ${uncertain.name} uncertainty without mutation retry`, async ({ page }) => {
    let posts = 0
    let reads = 0
    await installOperationsRoutes(page, {
      actions: (route) => {
        reads += 1
        return route.fulfill(actionsEnvelope(reads === 1 ? makeActions([ACTION_SPECS[0]]) : []))
      },
      resolution: (route) => { posts += 1; return uncertain.respond(route) },
    })
    await openActions(page)
    await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()

    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.locator('.toast__message').getByText('Lista działań została odświeżona.', { exact: true })).toBeVisible()
    await expect(page.getByText('Działanie zostało oznaczone jako rozwiązane.', { exact: true })).toHaveCount(0)
    expect(posts).toBe(1)
    expect(reads).toBe(2)
  })
}

test('@owner reports still-open and failed-reconciliation uncertain outcomes neutrally', async ({ page }) => {
  let reads = 0
  let reconciliations = 0
  await installOperationsRoutes(page, {
    actions: (route) => {
      reads += 1
      if (reads === 1 || reads === 2) return route.fulfill(actionsEnvelope(makeActions([ACTION_SPECS[0]])))
      reconciliations += 1
      return route.abort('connectionfailed')
    },
    resolution: (route) => route.abort('connectionfailed'),
  })
  await openActions(page)
  const attempt = async () => {
    await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
  }
  await attempt()
  await expect(page.getByText('Działanie nadal jest otwarte.', { exact: true })).toBeVisible()
  await attempt()
  await expect(page.getByRole('alert')).toContainText('Nie udało się potwierdzić wyniku. Odśwież listę działań przed ponowieniem.')
  await expect(page.getByText('Działanie zostało oznaczone jako rozwiązane.', { exact: true })).toHaveCount(0)
  expect(reconciliations).toBe(1)
})

test('@owner correction blocks stale uncertain action until explicit refresh succeeds', async ({ page }) => {
  let reads = 0
  let posts = 0
  await installOperationsRoutes(page, {
    actions: (route) => {
      reads += 1
      if (reads === 2) return route.abort('connectionfailed')
      return route.fulfill(actionsEnvelope(makeActions([ACTION_SPECS[0]])))
    },
    resolution: (route) => {
      posts += 1
      return route.abort('connectionfailed')
    },
  })
  await openActions(page)
  await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Nie udało się potwierdzić wyniku. Odśwież listę działań przed ponowieniem.',
  )
  const resolve = page.getByRole('button', { name: 'Oznacz jako rozwiązane' })

  await expect(resolve).toBeDisabled()
  await resolve.evaluate((button) => button.click())
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(posts).toBe(1)

  await page.getByRole('button', { name: 'Odśwież działania' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(resolve).toBeEnabled()
  await resolve.click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  expect(posts).toBe(1)
})

test('@owner keeps deterministic resolution failure in the modal and creates a new key per confirmation', async ({ page }) => {
  const keys = []
  await installOperationsRoutes(page, {
    actions: (route) => route.fulfill(actionsEnvelope(makeActions([ACTION_SPECS[0]]))),
    resolution: (route) => {
      keys.push(route.request().headers()['idempotency-key'])
      return route.fulfill(errorEnvelope(429, 'RATE_LIMITED'))
    },
  })
  await openActions(page)
  await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).click()
  const dialog = page.getByRole('alertdialog')
  const confirm = dialog.getByRole('button', { name: 'Oznacz jako rozwiązane' })
  await confirm.click()
  await expect(dialog.getByRole('alert')).toContainText('Nie udało się oznaczyć działania jako rozwiązanego.')
  await confirm.click()
  expect(keys).toHaveLength(2)
  expect(keys[0]).not.toBe(keys[1])
})

test('@owner pages audit with an opaque cursor, preserves rows on failure, and renders backup pruning privately', async ({ page }) => {
  const searches = []
  let cursorAttempts = 0
  const firstPage = makeAuditEvents(50)
  const secondPage = makeAuditEvents(2, 50)
  let releaseFirstCursorAttempt
  const firstCursorAttemptReleased = new Promise((resolve) => { releaseFirstCursorAttempt = resolve })
  await installOperationsRoutes(page, {
    audit: async (route) => {
      const url = new URL(route.request().url())
      searches.push(url.search)
      if (!url.searchParams.has('cursor')) return route.fulfill(auditEnvelope(firstPage, CURSOR))
      cursorAttempts += 1
      if (cursorAttempts === 1) await firstCursorAttemptReleased
      return cursorAttempts === 1
        ? route.abort('connectionfailed')
        : route.fulfill(auditEnvelope(secondPage, null))
    },
  })
  await openOperations(page)
  await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()

  const rows = page.locator('.operations-audit-row')
  await expect(rows).toHaveCount(50)
  const pruning = rows.filter({ hasText: 'Usunięcie wygasłej kopii zapasowej' }).first()
  await expect(pruning).toContainText('Powodzenie')
  await expect(pruning).toContainText('Zdarzenie systemowe')
  await expect(pruning).not.toContainText(/bkp_|backupVersion/)
  for (const label of [
    'Odmowa autoryzacji',
    'Usunięcie wygasłej kopii zapasowej',
    'Ponowne zabezpieczenie klucza danych',
    'Aktywacja tożsamości',
    'Odmowa aktywacji tożsamości',
    'Aktualizacja indeksu tożsamości',
    'Rozwiązanie działania operacyjnego',
    'Synchronizacja dostępu personelu',
    'Utworzenie konta właściciela',
    'Wyłączenie dostępu personelu',
    'Przyjęcie wiadomości z zaproszeniem',
    'Wygaśnięcie zaproszenia',
    'Zaproszenie personelu',
  ]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible()
  }
  const older = page.getByRole('button', { name: 'Pokaż starsze' })
  await older.click()
  await expect(older).toBeDisabled()
  releaseFirstCursorAttempt()
  await expect(page.getByRole('alert')).toContainText('Nie udało się pobrać danych.')
  await expect(rows).toHaveCount(50)
  await older.click()
  await expect(rows).toHaveCount(52)
  await expect(older).toHaveCount(0)
  expect(searches).toEqual([
    '?limit=50',
    `?cursor=${CURSOR}&limit=50`,
    `?cursor=${CURSOR}&limit=50`,
  ])
  expect(page.url()).not.toContain(CURSOR)
})

test('@owner correction locks duplicate older-page requests and lets refresh supersede safely', async ({ page }) => {
  let releaseOlder
  let firstPages = 0
  let olderReads = 0
  const olderReleased = new Promise((resolve) => { releaseOlder = resolve })
  const firstPage = makeAuditEvents(50)
  const freshPage = makeAuditEvents(1, 70)
  await installOperationsRoutes(page, {
    audit: async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.has('cursor')) {
        olderReads += 1
        await olderReleased
        await route.fulfill(auditEnvelope(makeAuditEvents(2, 50), null))
        return
      }
      firstPages += 1
      await route.fulfill(firstPages === 1
        ? auditEnvelope(firstPage, CURSOR)
        : auditEnvelope(freshPage, null))
    },
  })
  await openOperations(page)
  await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()
  await expect(page.locator('.operations-audit-row')).toHaveCount(50)
  const older = page.getByRole('button', { name: 'Pokaż starsze' })

  await older.evaluate((button) => {
    button.click()
    button.click()
  })
  await page.waitForTimeout(100)
  expect(olderReads).toBe(1)
  await page.getByRole('button', { name: 'Odśwież bezpieczeństwo' }).click()
  await expect(page.locator('.operations-audit-row')).toHaveCount(1)
  releaseOlder()
  await page.waitForTimeout(150)

  await expect(page.locator('.operations-audit-row')).toHaveCount(1)
  expect(firstPages).toBe(2)
  expect(olderReads).toBe(1)
})

test('@owner refreshes audit back to a fresh first page without touching other resources', async ({ page }) => {
  let healthReads = 0
  let actionReads = 0
  let auditReads = 0
  await installOperationsRoutes(page, {
    health: (route) => { healthReads += 1; return route.fulfill(healthEnvelope()) },
    actions: (route) => { actionReads += 1; return route.fulfill(actionsEnvelope()) },
    audit: (route) => {
      auditReads += 1
      return route.fulfill(auditEnvelope(auditReads === 1 ? makeAuditEvents(50) : makeAuditEvents(1, 70), auditReads === 1 ? CURSOR : null))
    },
  })
  await openOperations(page)
  await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()
  await expect(page.locator('.operations-audit-row')).toHaveCount(50)
  await page.getByRole('button', { name: 'Odśwież bezpieczeństwo' }).click()
  await expect(page.locator('.operations-audit-row')).toHaveCount(1)
  expect(healthReads).toBe(1)
  expect(actionReads).toBe(1)
  expect(auditReads).toBe(2)
})

test('@owner operation privacy and browser persistence stay empty after tabs and reload', async ({ page }) => {
  const logs = []
  const requests = []
  page.on('console', (message) => {
    if (message.type() === 'error') logs.push(message.text())
  })
  page.on('pageerror', (error) => logs.push(error.message))
  page.on('request', (request) => requests.push(request.url()))
  await installOperationsRoutes(page)
  await openActions(page)
  await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()
  await expect(page.getByText('Odmowa autoryzacji', { exact: true })).toBeVisible()

  const leaks = await page.evaluate(() => {
    const root = document.querySelector('.operations')
    const source = root?.outerHTML || ''
    const sensitive = /(owner@example\.test|Access subject|ciphertext|nonce|envelope|provider|signed URL|R2 object|manifest|ETag|bookmark|wrapped|raw key|KEK|(?:^|[^a-z])(?:act_|evt_|corr_|bkp_|stf_|inv_)|OUTBOX_|BACKUP_|ACCESS_|SCHEDULER_|security\.audit\.read)/i
    return {
      attributes: [...(root?.querySelectorAll('*') || [])].flatMap((element) => (
        [...element.attributes].map(({ name, value }) => `${name}=${value}`)
      )).filter((value) => sensitive.test(value)),
      htmlLeak: sensitive.test(source),
      hash: location.hash,
    }
  })
  expect(leaks.attributes).toEqual([])
  expect(leaks.htmlLeak).toBe(false)
  expect(leaks.hash).not.toMatch(/act_|evt_|corr_|bkp_|cursor|version|idempotency/i)
  expect(logs).toEqual([])
  expect(requests.filter((url) => /\/api\/.*(?:owner@example\.test|ciphertext|provider|bkp_)/i.test(url))).toEqual([])

  await page.reload()
  await expect(page.getByRole('heading', { name: /^Ustawienia / })).toBeVisible()
  const storage = await page.evaluate(async () => ({
    caches: 'caches' in window ? (await caches.keys()).length : 0,
    indexedDb: 'databases' in indexedDB ? (await indexedDB.databases()).length : 0,
    local: localStorage.length,
    serviceWorkers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    session: sessionStorage.length,
  }))
  expect(storage).toEqual({ caches: 0, indexedDb: 0, local: 0, serviceWorkers: 0, session: 0 })
})

test('@owner keeps operations content and modal contained at six required viewports', async ({ page }) => {
  await installOperationsRoutes(page, {
    audit: (route) => route.fulfill(auditEnvelope(makeAuditEvents(50), CURSOR)),
  })
  for (const viewport of [
    { width: 320, height: 844 },
    { width: 390, height: 844 },
    { width: 800, height: 900 },
    { width: 1025, height: 800 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await openActions(page)
    await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).first().click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    const geometry = await page.evaluate(() => {
      const selectors = [
        '.settings-grid',
        '.operations-tabs',
        '.operations-panel:not([hidden])',
        '.operations-action-row',
        '.leave-confirm__card',
      ]
      const boxes = selectors.map((selector) => {
        const element = document.querySelector(selector)
        const rect = element?.getBoundingClientRect()
        return {
          selector,
          exists: Boolean(element),
          left: rect?.left ?? -1,
          right: rect ? rect.right - window.innerWidth : 1,
          overflow: element ? element.scrollWidth - element.clientWidth : 1,
        }
      })
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        boxes,
      }
    })
    expect(geometry.documentOverflow).toBeLessThanOrEqual(0)
    for (const box of geometry.boxes) {
      const message = `${viewport.width}x${viewport.height} ${box.selector}`
      expect.soft(box.exists, message).toBe(true)
      expect.soft(box.left, message).toBeGreaterThanOrEqual(0)
      expect.soft(box.right, message).toBeLessThanOrEqual(0)
      if (box.selector !== '.settings-grid') {
        expect.soft(box.overflow, message).toBeLessThanOrEqual(0)
      }
    }
    await dialog.getByRole('button', { name: 'Wróć' }).click()
    await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()
    await expect(page.getByRole('button', { name: 'Pokaż starsze' })).toBeVisible()
    const auditGeometry = await page.evaluate(() => {
      const panel = document.querySelector('.operations-panel:not([hidden])')
      const older = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Pokaż starsze')
      return [panel, older].map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          right: rect.right - window.innerWidth,
          overflow: element.scrollWidth - element.clientWidth,
        }
      })
    })
    for (const box of auditGeometry) {
      expect.soft(box.left).toBeGreaterThanOrEqual(0)
      expect.soft(box.right).toBeLessThanOrEqual(0)
      expect.soft(box.overflow).toBeLessThanOrEqual(0)
    }
  }
})

test('@owner captures requested owner visual evidence', async ({ page }) => {
  mkdirSync(VISUAL_DIR, { recursive: true })
  let healthReads = 0
  await installOperationsRoutes(page, {
    health: (route) => {
      healthReads += 1
      return healthReads === 2 ? route.abort('connectionfailed') : route.fulfill(healthEnvelope())
    },
    audit: (route) => route.fulfill(auditEnvelope(makeAuditEvents(13))),
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openOperations(page)
  await page.getByRole('heading', { name: 'Stan i bezpieczeństwo' }).evaluate((element) => {
    element.scrollIntoView({ block: 'start' })
  })
  await page.screenshot({ path: `${VISUAL_DIR}/owner-health-390x844.png` })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('tab', { name: 'Działania' }).click()
  await page.getByRole('button', { name: 'Oznacz jako rozwiązane' }).first().click()
  await page.screenshot({ path: `${VISUAL_DIR}/owner-resolution-1440x900.png` })
  await page.getByRole('alertdialog').getByRole('button', { name: 'Wróć' }).click()
  await page.getByRole('tab', { name: 'Bezpieczeństwo' }).click()
  await expect(page.getByText('Odmowa autoryzacji', { exact: true })).toBeVisible()
  await page.getByRole('heading', { name: 'Stan i bezpieczeństwo' }).evaluate((element) => {
    element.scrollIntoView({ block: 'start' })
  })
  await page.screenshot({ path: `${VISUAL_DIR}/owner-security-1440x900.png` })

  await page.setViewportSize({ width: 320, height: 844 })
  await page.getByRole('tab', { name: 'Stan systemu' }).click()
  await page.getByRole('button', { name: 'Odśwież stan systemu' }).click()
  await expect(page.getByText('Nie udało się odświeżyć. Wyświetlane dane mogą być nieaktualne.', { exact: true })).toBeVisible()
  await page.getByRole('heading', { name: 'Stan i bezpieczeństwo' }).evaluate((element) => {
    element.scrollIntoView({ block: 'start' })
  })
  await page.screenshot({ path: `${VISUAL_DIR}/owner-stale-320x844.png` })
})

test('@coordinator captures requested filtered actions visual evidence', async ({ page }) => {
  mkdirSync(VISUAL_DIR, { recursive: true })
  await installOperationsRoutes(page)
  await page.setViewportSize({ width: 768, height: 1024 })
  await openActions(page)
  await expect(page.getByText('Wzrost odmów dostępu', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Bezpieczeństwo' })).toHaveCount(0)
  await page.screenshot({ path: `${VISUAL_DIR}/coordinator-actions-768x1024.png` })
})
