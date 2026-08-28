import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import test from 'node:test'

import { runStagingSmoke } from '../../scripts/staging-smoke-lib.mjs'
import {
  authorityResetDomEvidence,
  apiStatusesOk,
  canonicalContentLength,
  independentRouteMatrixEvidence,
  installDomStorageMutationObserver,
  installPersistentSmokeInstrumentation,
  juliaTeamDomEvidence,
  persistentSmokeEvidence,
  settingsActorDomEvidence,
  STAGING_ROUTE_MATRIX,
  topbarActorDomEvidence,
} from '../../scripts/staging-smoke-runtime.mjs'

const successful = (role) => ({
  role,
  ...(role === 'owner' ? { authorityRefreshClearsState: true } : {}),
  routesOk: true,
  actionsOk: true,
  guardedSurfacesOk: true,
  statusesOk: true,
  countsOk: true,
  leaksAbsent: true,
  exportScopeOk: true,
  exportHeadersOk: true,
  exportInScopePresent: true,
  exportOutOfScopeAbsent: true,
})

test('three-actor smoke returns only allow-listed boolean evidence and cleans every actor', async () => {
  const cleanup = []
  const actors = Object.fromEntries(['owner', 'coordinator', 'specialist'].map((role) => [
    role,
    {
      async run() { return successful(role) },
      async cleanup() { cleanup.push(role); return true },
    },
  ]))
  const result = await runStagingSmoke({ actors })
  assert.deepEqual(result, {
    actors: [successful('owner'), successful('coordinator'), successful('specialist')],
    browserCleanup: true,
    downloadCleanup: true,
    traceCleanup: true,
    status: 'ok',
  })
  assert.deepEqual(cleanup.sort(), ['coordinator', 'owner', 'specialist'])
  assert.doesNotMatch(JSON.stringify(result), /sentinel|source|token|cookie|https?:|filename/i)
})

test('three-actor smoke fails closed and still cleans all actor resources', async () => {
  const cleanup = []
  const actors = Object.fromEntries(['owner', 'coordinator', 'specialist'].map((role) => [
    role,
    {
      async run() {
        if (role === 'coordinator') return { ...successful(role), leaksAbsent: false }
        return successful(role)
      },
      async cleanup() { cleanup.push(role); return true },
    },
  ]))
  await assert.rejects(runStagingSmoke({ actors }), /^Error: STAGING_SMOKE_FAILED$/)
  assert.deepEqual(cleanup.sort(), ['coordinator', 'owner', 'specialist'])
})

test('route evidence uses the independent complete role matrix', () => {
  for (const role of ['owner', 'coordinator', 'specialist']) {
    assert.equal(independentRouteMatrixEvidence(role, STAGING_ROUTE_MATRIX[role]), true)
  }
  assert.equal(independentRouteMatrixEvidence('specialist', {
    allowed: [...STAGING_ROUTE_MATRIX.specialist.allowed, 'ledger'],
    denied: ['team', 'reports'],
  }), false)
})

test('page API status aggregation accepts only a nonempty all-2xx set', () => {
  assert.equal(apiStatusesOk([200, 201, 204]), true)
  for (const statuses of [[], [200, 302], [200, 403], [200, 599]]) {
    assert.equal(apiStatusesOk(statuses), false)
  }
})

test('export Content-Length accepts only canonical bounded decimal bytes', () => {
  assert.equal(canonicalContentLength('42'), 42)
  for (const value of ['01', '1e3', '+42', ' 42', '42 ', '0', '10485761']) {
    assert.throws(() => canonicalContentLength(value), /^Error: STAGING_SMOKE_FAILED$/)
  }
})

test('authority reset evidence requires the remounted native workbook input to be empty', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    try {
      await context.route('https://local.test/**', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><body><input type="file" aria-label="Wybierz plik XLSX"></body>',
      }))
      const page = await context.newPage()
      await page.goto('https://local.test/')
      const input = page.getByLabel('Wybierz plik XLSX')
      await input.setInputFiles({ name: 'workbook.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') })
      assert.equal(await page.evaluate(authorityResetDomEvidence), false)
      await page.evaluate(() => {
        const replacement = document.createElement('input')
        replacement.type = 'file'
        replacement.setAttribute('aria-label', 'Wybierz plik XLSX')
        document.querySelector('input')?.replaceWith(replacement)
      })
      assert.equal(await page.evaluate(authorityResetDomEvidence), true)
    } finally { await context.close() }
  } finally { await browser.close() }
})

test('actor presentation evidence is scoped to topbar, Settings identity and Julia Team card', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<!doctype html><body>
      <div>Julia Wolanin Specjalistka Dostęp aktywny</div>
      <header class="topbar"><div class="userchip--authenticated">
        <span class="userchip__name">Inna Osoba</span><span class="userchip__role">Specjalistka</span>
      </div></header>
      <div class="settings-account-identity"><strong>Inna Osoba</strong><strong>Specjalistka</strong></div>
      <article class="team-card"><h2 class="team-card__name">Julia Wolanin</h2>
        <span class="team-card__spec">Specjalistka · 180 zł / sesja</span>
        <span class="pill">Dostęp aktywny</span></article>
    </body>`)
    const expected = { displayName: 'Julia Wolanin', presentation: 'Specjalistka' }
    assert.equal(await page.evaluate(topbarActorDomEvidence, expected), false)
    assert.equal(await page.evaluate(settingsActorDomEvidence, expected), false)
    assert.equal(await page.evaluate(juliaTeamDomEvidence), true)
    await page.locator('.userchip__name').evaluate((node) => { node.textContent = 'Julia Wolanin' })
    await page.locator('.settings-account-identity strong').first()
      .evaluate((node) => { node.textContent = 'Julia Wolanin' })
    assert.equal(await page.evaluate(topbarActorDomEvidence, expected), true)
    assert.equal(await page.evaluate(settingsActorDomEvidence, expected), true)
    await page.locator('.team-card').evaluate((node) => node.append(' Właściciel'))
    assert.equal(await page.evaluate(juliaTeamDomEvidence), false)
  } finally { await browser.close() }
})

test('CDP storage instrumentation remembers named-property writes deleted in the same turn', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    let mutated = false
    let observer
    try {
      await context.route('https://local.test/**', (route) => route.fulfill({
        status: 200, contentType: 'text/html', body: '<!doctype html><body></body>',
      }))
      const page = await context.newPage()
      observer = await installDomStorageMutationObserver({
        context, page, onMutation: () => { mutated = true },
      })
      await page.goto('https://local.test/')
      await page.evaluate(() => {
        localStorage.transient = 'x'
        delete localStorage.transient
        sessionStorage.transient = 'x'
        delete sessionStorage.transient
      })
      await page.waitForTimeout(25)
      assert.equal(mutated, true)
      assert.deepEqual(await page.evaluate(() => ({
        local: localStorage.length, session: sessionStorage.length,
      })), { local: 0, session: 0 })
    } finally {
      await observer?.close()
      await context.close()
    }
  } finally { await browser.close() }
})

test('pre-app instrumentation remembers encoded URLs, transient attributes and write-delete storage', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    for (const hostile of ['encoded-url', 'attribute', 'storage']) {
      const context = await browser.newContext()
      try {
        await context.route('https://local.test/**', (route) => route.fulfill({
          status: 200, contentType: 'text/html', body: '<!doctype html><body></body>',
        }))
        await context.addInitScript(installPersistentSmokeInstrumentation, {
          sentinels: ['secret-value'], origin: 'https://staging.bearwithme-panel.app',
        })
        const page = await context.newPage()
        await page.goto('https://local.test/')
        await page.evaluate(async (kind) => {
          if (kind === 'encoded-url') {
            history.replaceState({}, '', '#/%73%65%63%72%65%74%2D%76%61%6C%75%65')
          } else if (kind === 'attribute') {
            const node = document.createElement('div')
            document.body.append(node)
            node.setAttribute('data-proof', 'secret-value')
            node.removeAttribute('data-proof')
            await new Promise((resolve) => setTimeout(resolve, 0))
          } else {
            localStorage.setItem('temporary', 'value')
            localStorage.removeItem('temporary')
          }
        }, hostile)
        const evidence = await page.evaluate(() => globalThis.__BWM_STAGING_SMOKE_EVIDENCE__)
        assert.equal(persistentSmokeEvidence(evidence).clean, false)
        if (hostile === 'encoded-url') assert.equal(evidence.decodedUrlLeak, true)
        if (hostile === 'attribute') assert.equal(evidence.transientAttributeLeak, true)
        if (hostile === 'storage') assert.equal(evidence.storageMutation, true)
      } finally { await context.close() }
    }
  } finally { await browser.close() }
})
