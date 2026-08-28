import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  createStagingWorkbookApi,
  exactNoStore,
  WorkbookRolloutHttpError,
} from '../../scripts/workbook-rollout-staging-http.mjs'
import { runStagingWorkbookRollout } from '../../scripts/workbook-rollout-staging-lib.mjs'

const ORIGIN = 'https://staging.bearwithme-panel.app'
const PLAN_DIGEST = `v1_${'A'.repeat(43)}`
const response = (payload, status = 200, path = '/api/v1/workbooks/operator-evidence') => ({
  ok: () => status >= 200 && status < 300,
  status: () => status,
  url: () => new URL(path, `${ORIGIN}/`).href,
  body: async () => Buffer.from(JSON.stringify(payload)),
  headers: () => ({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=UTF-8',
    'x-content-type-options': 'nosniff',
  }),
})
const imported = (status = 'materializing', version = 1) => ({
  id: 'wbi_http_one', artifactId: 'wba_http_one', status,
  acceptedRecords: 2232, quarantinedRecords: 3, createdByStaffId: 'stf_http_one',
  version, createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-28T10:00:00.000Z', completedAt: null,
})
const job = {
  id: 'wmj_http_one', phase: 'apply_finance', status: 'running', cursor: 64,
  totalRecords: 2235, processedRecords: 64, version: 2,
  updatedAt: '2026-08-28T10:00:00.000Z', completedAt: null,
}

test('HTTP adapter uses only guarded creator-bound rollout endpoints and normalizes count-only DTOs', async () => {
  const calls = []
  const requestContext = {
    async get(path, options) {
      calls.push({ method: 'GET', path, options })
      if (path === '/api/v1/workbooks/operator-evidence') return response({ data: {
        artifactCount: 1, importCount: 1, sourceRecordCount: 2235,
        workbookObjectCount: 1, templateCount: 1, planCount: 1,
        quarantineCount: 3, resolutionCount: 1, resolutionSetCount: 1,
        jobCount: 1, candidateCount: 2237, decisionCount: 2235,
        financeEntryCount: 2232, historicalOccurrenceCount: 2100,
        financeLinkCount: 2232, activityChargeCount: 25, projectionLinkCount: 2125,
        workbookVoidCount: 5, manualVoidCount: 0,
        auditEventCount: 10, outboxMessageCount: 0,
        createdRecordCount: 2235, voidedRecordCount: 5,
      } }, 200, path)
      if (path.endsWith('/artifact-verification')) return response({ data: {
        artifactId: 'wba_http_one', environmentMatch: true, centreMatch: true,
        opaqueObjectKey: true, ciphertextMetadataValid: true, digestMatch: true,
        sizeMatch: true, keyVersionsMatch: true, readbackDigestMatch: true,
      } }, 200, path)
      if (path.endsWith('/reconciliation')) return response({ data: {
        activeAcceptedSourceRecords: 2232, quarantinedSourceRecords: 3,
        monthlyDateQuarantines: 2, fixedOrphanAmountQuarantines: 1,
        amountStoredAsTextWarnings: 2, correctedCombinedSheetMonths: 45,
        tusRecords: 25, englishRecords: 165, formulaGhostsExcluded: 5,
        unexplainedDroppedCandidates: 0, replayCreatedRecords: 0,
        replayVoidedRecords: 0, ledgerLinksUnique: true,
        projectionLinksUnique: true, parentTotalsReconcile: true,
      } }, 200, path)
      return response({ data: {
        import: imported(), job,
        evidence: { createdRecords: 64, voidedRecords: 0, converged: false },
      } }, 200, path)
    },
    async post(path, options) {
      calls.push({ method: 'POST', path, options })
      if (path.endsWith('/preview')) return response({ data: {
        fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
        parserVersion: 2, materializerVersion: 2, planDigest: PLAN_DIGEST,
        previewToken: 'private-token', counts: {}, warnings: [], reconciliation: {},
        proposedMappings: [], conflicts: [{
          id: 'wmc_http_one', code: 'SPECIALIST_MAPPING_REQUIRED', sourceValue: 'private',
        }], quarantine: [], workbookKind: 'legacy',
      } }, 200, path)
      if (path.endsWith('/continue')) return response({ data: {
        import: imported(), job,
        evidence: { createdRecords: 64, voidedRecords: 0, converged: false },
      } }, 200, path)
      return response({ data: {
        import: imported(),
      } }, 201, path)
    },
  }
  const api = createStagingWorkbookApi({
    requestContext, origin: ORIGIN, csrfToken: 'private-csrf',
    expectedActorId: 'stf_http_one', expectedAuthorityRevision: 7,
  })
  const workbook = Object.freeze({ buffer: Buffer.from('fictional') })
  assert.deepEqual(await api.preview(workbook), {
    fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
    parserVersion: 2, materializerVersion: 2, planDigest: PLAN_DIGEST,
    previewToken: 'private-token', conflictIds: ['wmc_http_one'], workbookKind: 'legacy',
  })
  assert.equal((await api.commit({
    workbook, previewToken: 'private-token',
    resolutions: [{ conflictId: 'wmc_http_one', specialistId: 'sp_http_one' }],
    idempotencyKey: 'commit-key',
  })).importId, 'wbi_http_one')
  await api.status('wbi_http_one')
  await api.continue({ importId: 'wbi_http_one', expectedVersion: 1, idempotencyKey: 'continue-key' })
  await api.operatorEvidence()
  await api.artifactVerification('wbi_http_one')
  await api.reconciliation('wbi_http_one')

  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'POST /api/v1/workbooks/preview',
    'POST /api/v1/workbooks/imports',
    'GET /api/v1/workbooks/imports/wbi_http_one',
    'POST /api/v1/workbooks/imports/wbi_http_one/continue',
    'GET /api/v1/workbooks/operator-evidence',
    'GET /api/v1/workbooks/imports/wbi_http_one/artifact-verification',
    'GET /api/v1/workbooks/imports/wbi_http_one/reconciliation',
  ])
  for (const call of calls.filter(({ method }) => method === 'POST')) {
    assert.equal(call.options.headers['X-CSRF-Token'], 'private-csrf')
    assert.equal(call.options.maxRedirects, 0)
  }
  assert.equal(calls.filter(({ method }) => method === 'GET')
    .every(({ options }) => options.maxRedirects === 0), true)
  assert.equal(calls[0].options.multipart.workbook.name, 'approved-workbook.xlsx')
  assert.equal(calls[1].options.multipart.resolutions,
    '[{"conflictId":"wmc_http_one","specialistId":"sp_http_one"}]')
})

test('rollout CLI refuses arguments and missing private inputs without remote calls', () => {
  for (const args of [[], ['--help']]) {
    const result = spawnSync(process.execPath, ['scripts/workbook-rollout-staging.mjs', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { PATH: process.env.PATH, APP_ENV: 'staging', DATA_MODE: 'fictional' },
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '{"status":"refused"}\n')
  }
})

test('HTTP adapter rejects oversized workbooks and non-JSON responses before DTO use', async () => {
  let posts = 0
  const oversizedApi = createStagingWorkbookApi({
    origin: ORIGIN,
    csrfToken: 'private-csrf',
    expectedActorId: 'stf_http_one', expectedAuthorityRevision: 7,
    requestContext: {
      async get() { throw new Error('unused') },
      async post() { posts += 1; throw new Error('must not post') },
    },
  })
  await assert.rejects(oversizedApi.preview({
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  assert.equal(posts, 0)

  const invalidMediaApi = createStagingWorkbookApi({
    origin: ORIGIN,
    csrfToken: 'private-csrf',
    expectedActorId: 'stf_http_one', expectedAuthorityRevision: 7,
    requestContext: {
      async post() { throw new Error('unused') },
      async get() {
        const result = response({ data: {} })
        return { ...result, headers: () => ({
          'cache-control': 'no-store',
          'content-type': 'text/html',
          'x-content-type-options': 'nosniff',
        }) }
      },
    },
  })
  await assert.rejects(invalidMediaApi.operatorEvidence(),
    /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
})

test('HTTP adapter blocks redirects/cross-origin responses and cache lookalikes', async () => {
  for (const hostile of [
    { url: `${ORIGIN}/redirected`, cache: 'no-store' },
    { url: 'https://redirect-receiver.invalid/api/v1/workbooks/operator-evidence', cache: 'no-store' },
    { url: `${ORIGIN}/api/v1/workbooks/operator-evidence`, cache: 'x-private, no-store-ish' },
    { url: `${ORIGIN}/api/v1/workbooks/operator-evidence`, cache: 'public, no-store' },
  ]) {
    let options
    const api = createStagingWorkbookApi({
      origin: ORIGIN,
      csrfToken: 'private-csrf',
      expectedActorId: 'stf_http_one', expectedAuthorityRevision: 7,
      requestContext: {
        async post() { throw new Error('unused') },
        async get(_path, input) {
          options = input
          const result = response({ data: {} })
          return {
            ...result,
            url: () => hostile.url,
            headers: () => ({
              ...result.headers(), 'cache-control': hostile.cache,
            }),
          }
        },
      },
    })
    await assert.rejects(api.operatorEvidence(), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
    assert.equal(options.maxRedirects, 0)
  }
  assert.equal(exactNoStore({ 'cache-control': 'private, no-store' }, { requirePrivate: true }), true)
  assert.equal(exactNoStore({ 'cache-control': 'x-private, no-store-ish' }, { requirePrivate: true }), false)
  assert.equal(exactNoStore({ 'cache-control': 'public, private, no-store' }, { requirePrivate: true }), false)
  assert.equal(exactNoStore({ 'cache-control': 'private, no-store, max-age=3600' }, { requirePrivate: true }), false)
  assert.equal(exactNoStore({ 'cache-control': 'no-store, immutable' }), false)
  assert.equal(exactNoStore({ 'cache-control': 'no-store, no-store' }), false)
})

test('HTTP adapter refreshes expired CSRF once and retries the exact mutation', async () => {
  const calls = []
  let responseOrdinal = 0
  const requestContext = {
    async get() { throw new Error('unused') },
    async post(path, options) {
      calls.push({ path, options })
      responseOrdinal += 1
      if (responseOrdinal === 1) {
        return response({ error: { code: 'CSRF_EXPIRED' } }, 403, path)
      }
      return response({ data: {
        import: imported(),
      } }, 201, path)
    },
  }
  const api = createStagingWorkbookApi({
    requestContext, origin: ORIGIN, csrfToken: 'expired-csrf',
    expectedActorId: 'stf_http_one', expectedAuthorityRevision: 7,
    csrfExpiresAt: '2099-01-01T00:00:00.000Z',
    refreshCsrf: async () => ({
      csrfToken: 'refreshed-csrf', csrfExpiresAt: '2099-01-01T01:00:00.000Z',
      actor: { id: 'stf_http_one' }, authorityRevision: 7,
    }),
  })
  await api.commit({
    workbook: { buffer: Buffer.from('fictional') }, previewToken: 'same-preview',
    resolutions: [{ conflictId: 'wmc_http_one', specialistId: 'sp_http_one' }],
    idempotencyKey: 'same-key',
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'same-key')
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'same-key')
  assert.deepEqual(calls[0].options.multipart, calls[1].options.multipart)
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'expired-csrf')
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'refreshed-csrf')
  assert.equal(calls.every(({ options }) => options.maxRedirects === 0), true)
})

test('HTTP adapter never retries expired preview requests or revoked authority', async () => {
  for (const [status, code] of [[400, 'WORKBOOK_PREVIEW_TOKEN_INVALID'], [403, 'ACCESS_DENIED']]) {
    let posts = 0
    let refreshes = 0
    const api = createStagingWorkbookApi({
      origin: ORIGIN, csrfToken: 'valid-csrf',
      expectedActorId: 'stf_http_one', expectedAuthorityRevision: 7,
      csrfExpiresAt: '2099-01-01T00:00:00.000Z',
      refreshCsrf: async () => {
        refreshes += 1
        return {
          csrfToken: 'replacement', csrfExpiresAt: '2099-01-01T01:00:00.000Z',
          actor: { id: 'stf_http_one' }, authorityRevision: 7,
        }
      },
      requestContext: {
        async get() { throw new Error('unused') },
        async post(path) {
          posts += 1
          return response({ error: {
            code, correlationId: 'corr-safe-one',
            ...(code === 'VERSION_CONFLICT' ? { details: { currentVersion: 4 } } : {}),
          } }, status, path)
        },
      },
    })
    await assert.rejects(api.commit({
      workbook: { buffer: Buffer.from('fictional') }, previewToken: 'expired-preview',
      resolutions: [], idempotencyKey: 'same-key',
    }), (error) => error instanceof WorkbookRolloutHttpError
      && error.code === code && error.status === status
      && error.definitivePrewrite === (code === 'WORKBOOK_PREVIEW_TOKEN_INVALID'))
    assert.equal(posts, 1)
    assert.equal(refreshes, 0)
  }
})

test('HTTP adapter rejects wrong creators and non-authoritative preview metadata', async () => {
  const basePreview = {
    fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
    parserVersion: 2, materializerVersion: 2, planDigest: PLAN_DIGEST,
    previewToken: 'private-token', counts: {}, warnings: [], reconciliation: {},
    proposedMappings: [], conflicts: [], quarantine: [], workbookKind: 'legacy',
  }
  for (const override of [
    { parserVersion: 3 },
    { materializerVersion: 3 },
    { planDigest: 'v1.digest' },
    { workbookKind: 'panel-v2' },
  ]) {
    const api = createStagingWorkbookApi({
      origin: ORIGIN, csrfToken: 'valid-csrf', expectedActorId: 'stf_http_one',
      expectedAuthorityRevision: 7,
      requestContext: {
        async get() { throw new Error('unused') },
        async post(path) {
          return response({ data: { ...basePreview, ...override } }, 200, path)
        },
      },
    })
    await assert.rejects(api.preview({ buffer: Buffer.from('fictional') }),
      /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  }

  for (const method of ['commit', 'status', 'continue']) {
    const api = createStagingWorkbookApi({
      origin: ORIGIN, csrfToken: 'valid-csrf', expectedActorId: 'stf_expected_one',
      expectedAuthorityRevision: 7,
      requestContext: {
        async get(path) {
          return response({ data: {
            import: imported(), job,
            evidence: { createdRecords: 64, voidedRecords: 0, converged: false },
          } }, 200, path)
        },
        async post(path) {
          return path.endsWith('/continue')
            ? response({ data: {
              import: imported(), job,
              evidence: { createdRecords: 64, voidedRecords: 0, converged: false },
            } }, 200, path)
            : response({ data: { import: imported() } }, 201, path)
        },
      },
    })
    const call = method === 'commit' ? api.commit({
        workbook: { buffer: Buffer.from('fictional') }, previewToken: 'private-token',
        resolutions: [], idempotencyKey: 'same-key',
      })
      : method === 'status' ? api.status('wbi_http_one')
        : api.continue({
          importId: 'wbi_http_one', expectedVersion: 1, idempotencyKey: 'same-key',
        })
    await assert.rejects(call, /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  }
})

test('HTTP adapter refuses actor or authority drift before a refreshed mutation is sent', async () => {
  for (const refresh of [
    { actor: { id: 'stf_other_owner' }, authorityRevision: 7 },
    { actor: { id: 'stf_http_one' }, authorityRevision: 8 },
  ]) {
    let posts = 0
    const api = createStagingWorkbookApi({
      origin: ORIGIN, csrfToken: 'expiring-csrf', expectedActorId: 'stf_http_one',
      expectedAuthorityRevision: 7, csrfExpiresAt: '2026-08-28T10:00:00.000Z',
      now: () => Date.parse('2026-08-28T10:00:00.000Z'),
      refreshCsrf: async () => ({
        csrfToken: 'replacement', csrfExpiresAt: '2026-08-28T11:00:00.000Z',
        ...refresh,
      }),
      requestContext: {
        async get() { throw new Error('unused') },
        async post() { posts += 1; throw new Error('must not post') },
      },
    })
    await assert.rejects(api.commit({
      workbook: { buffer: Buffer.from('fictional') }, previewToken: 'same-preview',
      resolutions: [], idempotencyKey: 'same-key',
    }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
    assert.equal(posts, 0)
  }
})

test('HTTP adapter refreshes and retries the exact staging export mutation once', async () => {
  const calls = []
  let ordinal = 0
  const api = createStagingWorkbookApi({
    origin: ORIGIN, csrfToken: 'first-csrf', expectedActorId: 'stf_http_one',
    expectedAuthorityRevision: 7,
    refreshCsrf: async () => ({
      csrfToken: 'second-csrf', csrfExpiresAt: '2099-01-01T01:00:00.000Z',
      actor: { id: 'stf_http_one' }, authorityRevision: 7,
    }),
    requestContext: {
      async get() { throw new Error('unused') },
      async post(path, options) {
        calls.push({ path, options })
        ordinal += 1
        if (ordinal === 1) return response({ error: { code: 'CSRF_EXPIRED' } }, 403, path)
        const result = response({}, 200, path)
        return { ...result, body: async () => Buffer.from('xlsx') }
      },
    },
  })
  const result = await api.exportWorkbook({ format: 'panel-v2', idempotencyKey: 'export-key' })
  assert.equal(result.status(), 200)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].options.data, calls[1].options.data)
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'export-key')
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'export-key')
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'first-csrf')
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'second-csrf')
  assert.equal(calls.every(({ options }) => options.maxRedirects === 0), true)
})

test('HTTP adapter composes with the rollout using bound actor and preview metadata', async () => {
  const safeEvidence = {
    artifactCount: 1, workbookObjectCount: 1, templateCount: 1, importCount: 1,
    planCount: 1, sourceRecordCount: 2235, quarantineCount: 3, resolutionCount: 0,
    resolutionSetCount: 1, jobCount: 1, candidateCount: 2235, decisionCount: 2235,
    financeEntryCount: 2232, financeLinkCount: 2232, historicalOccurrenceCount: 2100,
    activityChargeCount: 132, projectionLinkCount: 2232, workbookVoidCount: 0,
    manualVoidCount: 0, createdRecordCount: 2232, voidedRecordCount: 0,
    auditEventCount: 4, outboxMessageCount: 0,
  }
  const expectedReconciliation = {
    activeAcceptedSourceRecords: 2232, quarantinedSourceRecords: 3,
    monthlyDateQuarantines: 2, fixedOrphanAmountQuarantines: 1,
    amountStoredAsTextWarnings: 2, correctedCombinedSheetMonths: 45,
    tusRecords: 25, englishRecords: 165, formulaGhostsExcluded: 5,
    unexplainedDroppedCandidates: 0, ledgerLinksUnique: true,
    projectionLinksUnique: true, parentTotalsReconcile: true,
  }
  const complete = { ...imported('complete', 3), completedAt: '2026-08-28T10:05:00.000Z' }
  const requestContext = {
    async get(path) {
      if (path === '/api/v1/workbooks/operator-evidence') {
        return response({ data: safeEvidence }, 200, path)
      }
      if (path.endsWith('/artifact-verification')) return response({ data: {
        artifactId: 'wba_http_one', centreMatch: true, ciphertextMetadataValid: true,
        digestMatch: true, environmentMatch: true, keyVersionsMatch: true,
        opaqueObjectKey: true, readbackDigestMatch: true, sizeMatch: true,
      } }, 200, path)
      if (path.endsWith('/reconciliation')) return response({ data: {
        ...expectedReconciliation, replayCreatedRecords: 0, replayVoidedRecords: 0,
      } }, 200, path)
      return response({ data: {
        import: imported('materializing', 2), job,
        evidence: { createdRecords: 0, voidedRecords: 0, converged: false },
      } }, 200, path)
    },
    async post(path) {
      if (path.endsWith('/preview')) return response({ data: {
        fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
        parserVersion: 2, materializerVersion: 2, planDigest: PLAN_DIGEST,
        previewToken: 'private-token', counts: {}, warnings: [], reconciliation: {},
        proposedMappings: [], conflicts: [], quarantine: [], workbookKind: 'legacy',
      } }, 200, path)
      if (path.endsWith('/continue')) return response({ data: {
        import: complete, job: { ...job, status: 'complete', processedRecords: 2235,
          completedAt: '2026-08-28T10:05:00.000Z' },
        evidence: { createdRecords: 2232, voidedRecords: 0, converged: true },
      } }, 200, path)
      return response({ data: { import: imported('materializing', 1) } }, 201, path)
    },
  }
  const api = createStagingWorkbookApi({
    requestContext, origin: ORIGIN, csrfToken: 'private-csrf',
    expectedActorId: 'stf_http_one', expectedAuthorityRevision: 7,
  })
  const result = await runStagingWorkbookRollout({
    api, workbook: { buffer: Buffer.from('fictional') },
    approvedFingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
    resolutions: [], commitIdempotencyKey: 'commit-key',
    continueIdempotencyKey: (_version, ordinal) => `continue-${ordinal}`,
    expectedReconciliation,
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.importId, 'wbi_http_one')
})
