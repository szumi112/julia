import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

import { AUTHORITATIVE_WORKBOOK_FINGERPRINT } from './audit-workbook-lib.mjs'
import { validateStagingBackupConfig } from './backup-staging-lib.mjs'
import {
  createStagingWorkbookApi,
  exactNoStore,
  readStagingSession,
} from './workbook-rollout-staging-http.mjs'
import { runStagingSmoke } from './staging-smoke-lib.mjs'
import {
  authorityResetDomEvidence,
  apiStatusesOk,
  scanXlsxSentinels,
  canonicalContentLength,
  independentRouteMatrixEvidence,
  installDomStorageMutationObserver,
  installPersistentSmokeInstrumentation,
  juliaTeamDomEvidence,
  persistentSmokeEvidence,
  settingsActorDomEvidence,
  smokePersistenceEvidence,
  STAGING_ROUTE_MATRIX,
  topbarActorDomEvidence,
} from './staging-smoke-runtime.mjs'

const ROLES = Object.freeze(['owner', 'coordinator', 'specialist'])
const ROLE_LABEL = Object.freeze({
  owner: 'Właściciel', coordinator: 'Koordynator', specialist: 'Specjalista',
})
const FINANCE_TABS = Object.freeze([
  'Przychody', 'Płatności i zaległości', 'Wydatki', 'Faktury',
])
const FINANCE_KPIS = Object.freeze([
  'Przychody', 'Wpłacono', 'Pozostało do zapłaty', 'Wydatki', 'Dochód',
])
const SESSION_ENV = Object.freeze({
  owner: 'BWM_STAGING_OWNER_SESSION_FILE',
  coordinator: 'BWM_STAGING_COORDINATOR_SESSION_FILE',
  specialist: 'BWM_STAGING_SPECIALIST_SESSION_FILE',
})
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const refused = () => { throw new Error('STAGING_SMOKE_REFUSED') }
const failed = () => { throw new Error('STAGING_SMOKE_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))

function polishMonth(month) {
  const [year, value] = month.split('-').map(Number)
  return new Intl.DateTimeFormat('pl-PL', {
    month: 'long', year: 'numeric', timeZone: 'Europe/Warsaw',
  }).format(new Date(Date.UTC(year, value - 1, 1)))
}

function environmentPath(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length < 1 || value !== value.trim()
    || value.includes('\0')) refused()
  return value
}

async function privateBytes(path, maximumBytes) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stats = await handle.stat()
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600
      || stats.size < 1 || stats.size > maximumBytes) refused()
    const bytes = await handle.readFile()
    if (bytes.length !== stats.size) refused()
    return bytes
  } catch (error) {
    if (error?.message === 'STAGING_SMOKE_REFUSED') throw error
    refused()
  } finally { await handle?.close() }
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  try { return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('') } finally {
    digest.fill(0)
  }
}

function cleanString(value, maximum = 200) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum
    && value === value.trim() && value === value.normalize('NFC')
    && !/[\p{Cc}\p{Cf}]/u.test(value)
}

function stringList(value, maximum = 100) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum
    || value.some((item) => !cleanString(item))) refused()
  if (new Set(value).size !== value.length) refused()
  return value
}

function assertionsDto(value) {
  if (!exact(value, ['actors', 'currentMonth', 'latestPopulatedMonth', 'storageSentinels'])
    || !exact(value.actors, ROLES)
    || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value.currentMonth ?? '')
    || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value.latestPopulatedMonth ?? '')
    || value.latestPopulatedMonth >= value.currentMonth) refused()
  const storageSentinels = stringList(value.storageSentinels)
  const actors = {}
  for (const role of ROLES) {
    const actor = value.actors[role]
    const keys = [
      'deniedApiPath', 'expectedCapabilities', 'expectedDisplayName',
      'expectedProfessionalTitle', 'inScopeSentinels', 'outOfScopeSentinels',
    ]
    if (!exact(actor, keys) || !cleanString(actor.expectedDisplayName)
      || !(actor.expectedProfessionalTitle === null
        || cleanString(actor.expectedProfessionalTitle))
      || !(actor.deniedApiPath === null || (cleanString(actor.deniedApiPath, 500)
        && actor.deniedApiPath.startsWith('/api/v1/') && !actor.deniedApiPath.includes('?')))) refused()
    actors[role] = Object.freeze({
      deniedApiPath: actor.deniedApiPath,
      expectedCapabilities: Object.freeze(stringList(actor.expectedCapabilities)),
      expectedDisplayName: actor.expectedDisplayName,
      expectedProfessionalTitle: actor.expectedProfessionalTitle,
      inScopeSentinels: Object.freeze(stringList(actor.inScopeSentinels)),
      outOfScopeSentinels: Object.freeze(stringList(actor.outOfScopeSentinels)),
    })
  }
  if (actors.owner.expectedDisplayName !== 'Julia Wolanin'
    || actors.owner.expectedProfessionalTitle !== 'Specjalistka') refused()
  return Object.freeze({
    actors: Object.freeze(actors),
    currentMonth: value.currentMonth,
    latestPopulatedMonth: value.latestPopulatedMonth,
    storageSentinels,
  })
}

function storageStateDto(value) {
  if (!exact(value, ['cookies', 'origins']) || !Array.isArray(value.cookies)
    || !Array.isArray(value.origins) || value.cookies.length > 100
    || value.origins.length > 20
    || value.origins.some((origin) => !exact(origin, ['origin', 'localStorage'])
      || !cleanString(origin.origin, 500) || !Array.isArray(origin.localStorage)
      || origin.localStorage.length !== 0)) refused()
  return value
}

function exactCapabilities(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((capability, index) => capability === expected[index])
}

function exactPageOrigin(page, origin) {
  try { return new URL(page.url()).origin === origin } catch { return false }
}

function exactApiResponse(response, origin, path) {
  return typeof response?.url === 'function'
    && response.url() === new URL(path, `${origin}/`).href
}

async function guardedGoto(page, origin, hash) {
  const response = await page.goto(`${origin}/${hash}`, {
    waitUntil: 'networkidle', timeout: 30_000,
  })
  if (!exactPageOrigin(page, origin) || (response && new URL(response.url()).origin !== origin)) failed()
  return response
}

function capabilityContract(role, capabilities) {
  const has = (capability) => capabilities.includes(capability)
  if (role === 'owner') {
    return has('finance.import') && has('workbook.centre.export')
      && !has('workbook.own.export')
  }
  if (role === 'coordinator') {
    return has('workbook.centre.export') && !has('workbook.own.export')
  }
  return has('workbook.own.export') && !has('workbook.centre.export')
    && !has('finance.import')
}

async function writeAndScanExport({ response, path, assertions, expectedUrl }) {
  const headers = response.headers()
  let contentLength = 0
  try { contentLength = canonicalContentLength(headers['content-length']) } catch { failed() }
  const headerOk = response.url() === expectedUrl && response.status() === 200
    && headers['content-type']
      === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    && exactNoStore(headers, { requirePrivate: true })
    && String(headers['x-content-type-options'] ?? '').toLowerCase() === 'nosniff'
    && /^attachment; filename="[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.xlsx"$/
      .test(headers['content-disposition'] ?? '')
  let responseBytes
  let readback
  let handle
  try {
    responseBytes = await response.body()
    if (!headerOk || !Buffer.isBuffer(responseBytes)
      || responseBytes.length !== contentLength) failed()
    handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0), 0o600)
    await handle.writeFile(responseBytes)
    await handle.sync()
    const stats = await handle.stat()
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600 || stats.size !== contentLength) failed()
    readback = Buffer.alloc(contentLength)
    const read = await handle.read(readback, 0, contentLength, 0)
    if (read.bytesRead !== contentLength) failed()
    const scan = scanXlsxSentinels(readback, assertions)
    return Object.freeze({
      byteSize: contentLength,
      sha256: await sha256(readback),
      exportHeadersOk: true,
      exportInScopePresent: scan.inScopePresent,
      exportOutOfScopeAbsent: scan.outOfScopeAbsent,
    })
  } finally {
    responseBytes?.fill(0)
    readback?.fill(0)
    await handle?.close()
  }
}

async function clearBrowserState(page, context) {
  if (!page || !context) return true
  let state
  try {
    state = await page.evaluate(async () => {
      localStorage.clear()
      sessionStorage.clear()
      const databases = typeof indexedDB.databases === 'function'
        ? await indexedDB.databases() : []
      await Promise.all(databases.map(({ name }) => new Promise((resolve) => {
        if (!name) return resolve()
        const request = indexedDB.deleteDatabase(name)
        request.onsuccess = request.onerror = request.onblocked = () => resolve()
      })))
      if (globalThis.caches) {
        await Promise.all((await caches.keys()).map((key) => caches.delete(key)))
      }
      if (navigator.serviceWorker) {
        await Promise.all((await navigator.serviceWorker.getRegistrations())
          .map((registration) => registration.unregister()))
      }
      return {
        local: localStorage.length,
        session: sessionStorage.length,
        databases: typeof indexedDB.databases === 'function'
          ? (await indexedDB.databases()).length : 0,
        caches: globalThis.caches ? (await caches.keys()).length : 0,
        workers: navigator.serviceWorker
          ? (await navigator.serviceWorker.getRegistrations()).length : 0,
      }
    })
    await context.clearCookies()
    return exact(state, ['local', 'session', 'databases', 'caches', 'workers'])
      && Object.values(state).every((count) => count === 0)
  } catch { return false }
}

async function boundedJson(response, expectedUrl) {
  const headers = response.headers()
  const mediaType = String(headers['content-type'] ?? '').toLowerCase()
  let bytes
  try {
    bytes = await response.body()
    if (response.url() !== expectedUrl || response.status() !== 200 || !Buffer.isBuffer(bytes)
      || bytes.length < 1 || bytes.length > 2 * 1024 * 1024
      || !exactNoStore(headers)
      || !['application/json', 'application/json; charset=utf-8'].includes(mediaType)
      || String(headers['x-content-type-options'] ?? '').toLowerCase() !== 'nosniff') failed()
    const payload = JSON.parse(bytes.toString('utf8'))
    if (!exact(payload, ['data']) || !plain(payload.data)) failed()
    return payload.data
  } catch { failed() } finally { bytes?.fill(0) }
}

async function financeWindowCounts(context, origin, currentMonth, latestPopulatedMonth) {
  const keys = [
    'currentMonth', 'selectedMonth', 'fromMonth', 'toMonth', 'months',
    'latestPopulatedMonth', 'kpis', 'trend', 'splits', 'rows', 'coverage',
    'unknownPeriodCount', 'complete',
  ]
  const currentPath = `/api/v1/finance/window?month=${currentMonth}`
  const latestPath = `/api/v1/finance/window?month=${latestPopulatedMonth}`
  const current = await boundedJson(await context.request.get(currentPath, { maxRedirects: 0 }),
    new URL(currentPath, `${origin}/`).href)
  const latest = await boundedJson(await context.request.get(latestPath, { maxRedirects: 0 }),
    new URL(latestPath, `${origin}/`).href)
  const valid = (value, selected) => exact(value, keys)
    && value.currentMonth === currentMonth && value.selectedMonth === selected
    && value.latestPopulatedMonth === latestPopulatedMonth
    && Array.isArray(value.months) && value.months.length === 6
    && Array.isArray(value.rows) && value.rows.length <= 500
    && exact(value.coverage, [
      'dateOnlyCount', 'monthOnlyCount', 'timedCount', 'unknownCount',
    ])
    && Object.values(value.coverage).every((count) => Number.isSafeInteger(count) && count >= 0)
    && Number.isSafeInteger(value.unknownPeriodCount) && value.unknownPeriodCount >= 0
    && value.complete === true
  return valid(current, currentMonth) && current.rows.length === 0
    && valid(latest, latestPopulatedMonth) && latest.rows.length > 0
}

async function authorityRefreshClearsInFlightState(page, origin, workbookBytes) {
  let releasePreview
  const previewGate = new Promise((resolve) => { releasePreview = resolve })
  const previewPattern = '**/api/v1/workbooks/preview'
  const sessionPattern = '**/api/v1/session'
  let sessionSynthesized = false
  let markSessionReady
  const sessionReady = new Promise((resolve) => { markSessionReady = resolve })
  try {
    await guardedGoto(page, origin, '#/ledger')
    if (!exactPageOrigin(page, origin)) return false
    await page.route(previewPattern, async (route) => {
      await previewGate
      await route.continue()
    })
    const previewRequest = page.waitForRequest((request) => (
      new URL(request.url()).pathname === '/api/v1/workbooks/preview'
    ), { timeout: 30_000 })
    await page.getByLabel('Wybierz plik XLSX').setInputFiles({
      name: 'approved-workbook.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: workbookBytes,
    })
    await previewRequest
    await page.route(sessionPattern, async (route) => {
      const response = await route.fetch({ maxRedirects: 0 })
      if (!exactApiResponse(response, origin, '/api/v1/session')) {
        await route.abort()
        return
      }
      const payload = await response.json()
      if (!exact(payload, ['data']) || !plain(payload.data)
        || !Number.isSafeInteger(payload.data.authorityRevision)) {
        await route.abort()
        return
      }
      payload.data.authorityRevision += 1
      await route.fulfill({ response, json: payload })
      sessionSynthesized = true
      markSessionReady()
    })
    const refreshRequest = page.waitForRequest((request) => (
      new URL(request.url()).pathname === '/api/v1/session'
    ), { timeout: 30_000 })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await refreshRequest
    await Promise.race([
      sessionReady,
      page.waitForTimeout(30_000).then(() => failed()),
    ])
    const previewResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/v1/workbooks/preview'
    ), { timeout: 30_000 })
    releasePreview()
    if ((await previewResponse).status() !== 200) return false
    await page.waitForFunction(authorityResetDomEvidence, null, { timeout: 30_000 })
    return sessionSynthesized
  } catch { return false } finally {
    releasePreview?.()
    try { await page.unroute(previewPattern) } catch { /* cleanup remains fail-closed */ }
    try { await page.unroute(sessionPattern) } catch { /* cleanup remains fail-closed */ }
  }
}

async function renderWorkbookPreview(page, origin, workbookBytes) {
  try {
    await guardedGoto(page, origin, '#/ledger')
    if (!exactPageOrigin(page, origin)) return false
    await page.getByLabel('Wybierz plik XLSX').setInputFiles({
      name: 'approved-workbook.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: workbookBytes,
    })
    const preview = page.getByRole('heading', {
      name: 'Podgląd — nic nie zostało zapisane', exact: true,
    })
    await preview.waitFor({ state: 'visible', timeout: 30_000 })
    return await page.getByRole('button', {
      name: 'Zapisz i rozpocznij import', exact: true,
    }).isVisible() && exactPageOrigin(page, origin)
  } catch { return false }
}

async function renderRegistryDetail(page) {
  try {
    const review = page.getByRole('button', { name: 'Przejrzyj import', exact: true }).first()
    await review.waitFor({ state: 'visible', timeout: 30_000 })
    await review.click()
    await page.getByRole('heading', { name: 'Szczegóły importu', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 })
    return true
  } catch { return false }
}

function createActorExecutor({
  role, browser, origin, storageState, assertions, tempRoot, workbookBytes,
}) {
  let context
  let page
  let storageObserver
  let exportPath
  return Object.freeze({
    async run() {
      const cookieMetadataEvidence = JSON.stringify(storageState.cookies.map((cookie) => ({
        name: cookie.name, domain: cookie.domain, path: cookie.path,
      })))
      let forbiddenLeak = assertions.storageSentinels
        .some((sentinel) => cookieMetadataEvidence.includes(sentinel))
      let crossOriginAttempt = false
      let runtimeError = false
      let domStorageMutation = false
      context = await browser.newContext({
        baseURL: origin, storageState, acceptDownloads: false, maxRedirects: 0,
      })
      await context.addInitScript(installPersistentSmokeInstrumentation, {
        sentinels: assertions.storageSentinels, origin,
      })
      await context.route('**/*', async (route) => {
        let sameOrigin = false
        try { sameOrigin = new URL(route.request().url()).origin === origin } catch { /* fail closed */ }
        if (!sameOrigin) {
          crossOriginAttempt = true
          await route.abort('blockedbyclient')
          return
        }
        await route.continue()
      })
      storageState.cookies.splice(0)
      storageState.origins.splice(0)
      page = await context.newPage()
      storageObserver = await installDomStorageMutationObserver({
        context,
        page,
        onMutation: () => { domStorageMutation = true },
      })
      const apiStatuses = []
      page.on('response', (response) => {
        try {
          if (new URL(response.url()).pathname.startsWith('/api/v1/')) {
            apiStatuses.push(response.status())
          }
        } catch { apiStatuses.push(599) }
      })
      const containsForbidden = (value) => assertions.storageSentinels
        .some((sentinel) => String(value).includes(sentinel))
      page.on('request', (request) => {
        const raw = request.url()
        let decoded = raw
        try { decoded = decodeURIComponent(raw) } catch { forbiddenLeak = true }
        if (containsForbidden(raw) || containsForbidden(decoded)) forbiddenLeak = true
      })
      page.on('console', (message) => {
        if (message.type() === 'error') runtimeError = true
        if (containsForbidden(message.text())) forbiddenLeak = true
      })
      page.on('pageerror', () => { runtimeError = true })
      const session = await readStagingSession(
        await context.request.get('/api/v1/session', { maxRedirects: 0 }), role,
        `${origin}/api/v1/session`,
      )
      let capabilitiesOk = exactCapabilities(
        session.capabilities, assertions.expectedCapabilities,
      ) && capabilityContract(role, session.capabilities)
        && session.actor.displayName === assertions.expectedDisplayName
        && session.actor.professionalTitle === assertions.expectedProfessionalTitle
      if (!capabilitiesOk) failed()
      const fetchSession = async () => readStagingSession(
        await context.request.get('/api/v1/session', { maxRedirects: 0 }), role,
        `${origin}/api/v1/session`,
      )
      const workbookApi = createStagingWorkbookApi({
        requestContext: context.request,
        origin,
        csrfToken: session.csrfToken,
        csrfExpiresAt: session.csrfExpiresAt,
        refreshCsrf: fetchSession,
        expectedActorId: session.actor.id,
        expectedAuthorityRevision: session.authorityRevision,
      })
      const operatorProbe = await context.request.get('/api/v1/workbooks/operator-evidence', {
        maxRedirects: 0,
      })
      capabilitiesOk = capabilitiesOk
        && exactApiResponse(operatorProbe, origin, '/api/v1/workbooks/operator-evidence')
        && (session.capabilities.includes('finance.import')
        ? operatorProbe.status() === 200 : [403, 404].includes(operatorProbe.status()))
      const matrix = STAGING_ROUTE_MATRIX[role]
      const permittedRoutes = matrix.allowed
      let routesOk = independentRouteMatrixEvidence(role, matrix)
      const observed = { allowed: [], denied: [] }
      for (const route of matrix.allowed) {
        await guardedGoto(page, origin, `#/${route}`)
        routesOk = routesOk && page.url().endsWith(`#/${route}`)
          && await page.locator('main h1').first().isVisible()
        if (route === 'team' && role === 'owner') {
          routesOk = routesOk && assertions.expectedDisplayName === 'Julia Wolanin'
            && assertions.expectedProfessionalTitle === 'Specjalistka'
            && await page.evaluate(juliaTeamDomEvidence)
        }
        if (route === 'settings') {
          routesOk = routesOk && await page.evaluate(settingsActorDomEvidence, {
            displayName: assertions.expectedDisplayName,
            presentation: assertions.expectedProfessionalTitle ?? 'Konto centrum',
          })
        }
        observed.allowed.push(route)
      }
      for (const deniedRoute of matrix.denied) {
        await guardedGoto(page, origin, `#/${deniedRoute}`)
        routesOk = routesOk && !page.url().endsWith(`#/${deniedRoute}`)
        observed.denied.push(deniedRoute)
      }
      routesOk = routesOk && independentRouteMatrixEvidence(role, observed)
      routesOk = routesOk && await page.evaluate(topbarActorDomEvidence, {
        displayName: assertions.expectedDisplayName,
        presentation: assertions.expectedProfessionalTitle ?? ROLE_LABEL[role],
      })
      if (permittedRoutes.includes('reports') && permittedRoutes.includes('ledger')) {
        const reportsIcon = await page.getByRole('link', { name: 'Raporty', exact: true })
          .locator('svg').evaluate((node) => node.innerHTML)
        const ledgerIcon = await page.getByRole('link', { name: 'Rejestr', exact: true })
          .locator('svg').evaluate((node) => node.innerHTML)
        routesOk = routesOk && reportsIcon !== ledgerIcon
      }

      let countsOk = apiStatuses.length >= 1
      let allowedUiActionsOk = true
      let guardedSurfacesOk = true
      if (session.capabilities.includes('finance.centre.read')) {
        countsOk = countsOk && await financeWindowCounts(
          context, origin, assertions.currentMonth, assertions.latestPopulatedMonth,
        )
      }
      if (session.capabilities.includes('finance.centre.read')) {
        await guardedGoto(page, origin, '#/payments')
        const tabs = await page.getByRole('tab').allTextContents()
        const body = await page.locator('body').innerText()
        const latestLabel = polishMonth(assertions.latestPopulatedMonth)
        const latestControl = page.getByRole('button', {
          name: `Pokaż ostatni miesiąc z danymi — ${latestLabel}`,
          exact: true,
        })
        countsOk = countsOk
          && await page.getByText('Brak danych w bieżącym miesiącu', { exact: true }).isVisible()
          && await latestControl.isVisible()
        await latestControl.click()
        await page.waitForURL((url) => (
          url.hash === `#/payments?ym=${assertions.latestPopulatedMonth}`
        ), { timeout: 30_000 })
        const selectedHeading = page.getByRole('heading', {
          level: 1, name: `Finanse — ${latestLabel}`, exact: true,
        })
        await selectedHeading.waitFor({ state: 'visible', timeout: 30_000 })
        countsOk = countsOk
          && page.url().endsWith(`#/payments?ym=${assertions.latestPopulatedMonth}`)
          && await selectedHeading.evaluate((heading) => (
            heading.tabIndex === -1 && document.activeElement === heading
          ))
        for (const label of FINANCE_TABS) {
          const tab = page.getByRole('tab', { name: label, exact: true })
          await tab.click()
          allowedUiActionsOk = allowedUiActionsOk
            && await tab.getAttribute('aria-selected') === 'true'
        }
        countsOk = countsOk && tabs.length === FINANCE_TABS.length
          && tabs.every((tab, index) => tab.trim() === FINANCE_TABS[index])
          && FINANCE_KPIS.every((label) => body.includes(label))
        await guardedGoto(page, origin, '#/ledger')
        allowedUiActionsOk = allowedUiActionsOk
          && await page.getByRole('button', { name: 'Eksportuj Panel-v2', exact: true }).isVisible()
          && await page.getByRole('button', { name: 'Eksportuj format zgodny', exact: true }).isVisible()
        guardedSurfacesOk = await renderRegistryDetail(page)
      } else if (role === 'specialist') {
        await guardedGoto(page, origin, '#/payments')
        allowedUiActionsOk = allowedUiActionsOk
          && await page.locator('.workbook-export').isVisible()
          && await page.getByRole('button', { name: 'Eksportuj własne dane', exact: true }).isVisible()
      }
      let deniedOk = assertions.deniedApiPath === null
      if (assertions.deniedApiPath !== null) {
        const denied = await context.request.get(assertions.deniedApiPath, { maxRedirects: 0 })
        deniedOk = exactApiResponse(denied, origin, assertions.deniedApiPath)
          && [403, 404].includes(denied.status())
      }

      exportPath = join(tempRoot, `${role}.xlsx`)
      await workbookApi.refreshAuthority()
      const exported = await workbookApi.exportWorkbook({
        format: 'panel-v2', idempotencyKey: `smoke-${role}-${randomUUID()}`,
      })
      const exportEvidence = await writeAndScanExport({
        response: exported,
        path: exportPath,
        expectedUrl: `${origin}/api/v1/workbooks/exports`,
        assertions: {
          inScopeSentinels: assertions.inScopeSentinels,
          outOfScopeSentinels: assertions.outOfScopeSentinels,
        },
      })
      if (role === 'owner') {
        guardedSurfacesOk = guardedSurfacesOk
          && await renderWorkbookPreview(page, origin, workbookBytes)
      }
      const authorityRefreshClearsState = role === 'owner'
        ? await authorityRefreshClearsInFlightState(page, origin, workbookBytes) : null
      const browserEvidence = await page.evaluate(async (sentinels) => {
        const attributeLeak = [...document.querySelectorAll('*')].some((element) => (
          [...element.attributes].some(({ value }) => (
            sentinels.some((sentinel) => value.includes(sentinel))
          ))
        ))
        return {
          attributeLeak,
          persistent: globalThis.__BWM_STAGING_SMOKE_EVIDENCE__,
          persistence: {
            local: localStorage.length,
            session: sessionStorage.length,
            databases: typeof indexedDB.databases === 'function'
              ? (await indexedDB.databases()).length : 0,
            caches: globalThis.caches ? (await caches.keys()).length : 0,
            workers: navigator.serviceWorker
              ? (await navigator.serviceWorker.getRegistrations()).length : 0,
          },
        }
      }, assertions.storageSentinels)
      const persistence = smokePersistenceEvidence(browserEvidence.persistence)
      const persistent = persistentSmokeEvidence(browserEvidence.persistent)
      const leaksAbsent = !forbiddenLeak && browserEvidence.attributeLeak === false
        && persistence.empty && persistent.clean && !crossOriginAttempt && !runtimeError
        && !domStorageMutation
      return Object.freeze({
        role,
        ...(role === 'owner' ? { authorityRefreshClearsState } : {}),
        exportEvidence: Object.freeze({
          actor: role,
          scope: role === 'specialist' ? 'own' : 'centre',
          status: 'verified',
          byteSize: exportEvidence.byteSize,
          sha256: exportEvidence.sha256,
        }),
        routesOk,
        actionsOk: capabilitiesOk && deniedOk && allowedUiActionsOk,
        guardedSurfacesOk,
        statusesOk: apiStatusesOk(apiStatuses),
        countsOk,
        leaksAbsent,
        exportScopeOk: exportEvidence.exportInScopePresent
          && exportEvidence.exportOutOfScopeAbsent,
        exportHeadersOk: exportEvidence.exportHeadersOk,
        exportInScopePresent: exportEvidence.exportInScopePresent,
        exportOutOfScopeAbsent: exportEvidence.exportOutOfScopeAbsent,
      })
    },
    async cleanup() {
      let ok = await clearBrowserState(page, context)
      try { if (storageObserver && await storageObserver.close() !== true) ok = false } catch { ok = false }
      try { await page?.close() } catch { ok = false }
      try { await context?.close() } catch { ok = false }
      try { if (exportPath) await rm(exportPath, { force: true }) } catch { ok = false }
      return ok
    },
  })
}

async function main() {
  if (process.argv.length !== 2) refused()
  const config = JSON.parse(await readFile(join(projectRoot, 'wrangler.json'), 'utf8'))
  validateStagingBackupConfig({ config, environment: process.env })
  const origin = config.env?.staging?.vars?.APP_ORIGIN
  if (origin !== 'https://staging.bearwithme-panel.app') refused()
  const secretBuffers = []
  const states = {}
  let assertions
  let workbookBytes
  let browser
  let tempRoot
  let result
  let cleanupOk = true
  try {
    for (const role of ROLES) {
      const bytes = await privateBytes(environmentPath(SESSION_ENV[role]), 1024 * 1024)
      secretBuffers.push(bytes)
      try { states[role] = storageStateDto(JSON.parse(bytes.toString('utf8'))) } catch { refused() }
    }
    const assertionBytes = await privateBytes(
      environmentPath('BWM_STAGING_SMOKE_ASSERTIONS_FILE'), 256 * 1024,
    )
    secretBuffers.push(assertionBytes)
    try { assertions = assertionsDto(JSON.parse(assertionBytes.toString('utf8'))) } catch { refused() }
    workbookBytes = await privateBytes(environmentPath('BWM_WORKBOOK_PATH'), 5 * 1024 * 1024)
    secretBuffers.push(workbookBytes)
    if (await sha256(workbookBytes) !== AUTHORITATIVE_WORKBOOK_FINGERPRINT) refused()
    tempRoot = await mkdtemp(join(tmpdir(), 'bwm-staging-smoke-'))
    await chmod(tempRoot, 0o700)
    browser = await chromium.launch({ headless: true })
    const actors = Object.fromEntries(ROLES.map((role) => [role, createActorExecutor({
      role, browser, origin, storageState: states[role],
      assertions: Object.freeze({
        ...assertions.actors[role],
        currentMonth: assertions.currentMonth,
        latestPopulatedMonth: assertions.latestPopulatedMonth,
        storageSentinels: assertions.storageSentinels,
      }),
      tempRoot, workbookBytes,
    })]))
    result = await runStagingSmoke({ actors })
  } finally {
    secretBuffers.forEach((bytes) => bytes.fill(0))
    Object.values(states).forEach((state) => {
      state?.cookies?.splice(0)
      state?.origins?.splice(0)
    })
    try { await browser?.close() } catch { cleanupOk = false }
    try { if (tempRoot) await rm(tempRoot, { recursive: true, force: true }) } catch {
      cleanupOk = false
    }
  }
  if (!cleanupOk || !result) failed()
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

try {
  await main()
} catch (error) {
  const status = error?.message === 'STAGING_SMOKE_REFUSED'
    || error?.message === 'BACKUP_STAGING_REFUSED' ? 'refused' : 'failed'
  process.stderr.write(`${JSON.stringify({ status })}\n`)
  process.exitCode = 1
}
