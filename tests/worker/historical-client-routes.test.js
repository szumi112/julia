import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import {
  areSiblingD1QueryBudgetViews,
  usageForD1QueryBudgetViews,
} from '../../worker/db/query-budget.js'
import { AppError } from '../../worker/http/errors.js'

const NOW_MS = Date.parse('2027-03-04T08:00:00.000Z')
const ORIGIN = 'https://bearwithme-panel.app'
const actor = Object.freeze({
  id: 'stf_historical_route_owner', role: 'owner', specialistId: null, version: 1,
})
const principal = Object.freeze({
  kind: 'human', subject: 'access-historical-route-owner',
  normalizedEmail: 'historical-route-owner@example.test',
  issuedAt: Math.floor(NOW_MS / 1_000) - 30,
  expiresAt: Math.floor(NOW_MS / 1_000) + 270,
})

const statement = () => {
  const value = {
    bind: vi.fn(() => value),
    all: vi.fn(async () => ({ results: [] })),
    first: vi.fn(async () => null),
    raw: vi.fn(async () => []),
    run: vi.fn(async () => ({ success: true })),
  }
  return value
}

const depsFor = (overrides = {}) => ({
  config: { appEnv: 'staging', appOrigin: ORIGIN, dataMode: 'fictional' },
  db: { prepare: vi.fn(statement), batch: vi.fn(async () => []) },
  cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
  now: () => NOW_MS,
  resolveAccessPrincipal: vi.fn(async () => principal),
  resolveActor: vi.fn(async () => actor),
  verifyCsrfToken: vi.fn(async () => true),
  safeLog: vi.fn(),
  ...overrides,
})

const mutation = (body, idempotencyKey) => ({
  method: 'POST',
  headers: {
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin',
    'X-CSRF-Token': 'valid',
    'X-Correlation-Id': 'historical_route_correlation',
    'Idempotency-Key': idempotencyKey,
  },
  body: JSON.stringify(body),
})

describe('historical workspace HTTP routes', () => {
  it('forwards exact status, continuation, resolution, and activation contracts', async () => {
    let routeUsage
    const getHistoricalProjectionStatus = vi.fn(async ({ importId }) => ({
      data: { projection: { id: 'hpj_route_one', importId, version: 1 }, conflicts: [] },
    }))
    const postHistoricalProjectionContinue = vi.fn(async (input) => {
      expect(areSiblingD1QueryBudgetViews(input.db, input.recoveryDb)).toBe(true)
      const statements = Array.from({ length: 27 }, () => input.db.prepare('SELECT 1'))
      await input.db.batch(statements)
      routeUsage = usageForD1QueryBudgetViews(input.db, input.recoveryDb)
      return {
        status: 200,
        body: { data: { projection: {
          id: 'hpj_route_one', importId: input.importId, version: input.expectedVersion,
        } } },
      }
    })
    const postHistoricalProjectionResolution = vi.fn(async (input) => ({
      status: 201,
      body: { data: { projection: {
        id: 'hpj_route_one', importId: input.importId,
        version: input.body.expectedJobVersion + 1,
      } } },
    }))
    const postHistoricalClientActivation = vi.fn(async (input) => ({
      status: 201,
      body: { data: { historicalClient: {
        id: input.historicalClientId, status: 'activated', version: 2,
      } } },
    }))
    const app = createApp(depsFor({
      getHistoricalProjectionStatus,
      postHistoricalProjectionContinue,
      postHistoricalProjectionResolution,
      postHistoricalClientActivation,
    }))

    expect((await app.request(
      '/api/v1/workbooks/imports/wbi_route_one/historical-projection',
    )).status).toBe(200)
    expect((await app.request(
      '/api/v1/workbooks/imports/wbi_route_one/historical-projection/continue',
      mutation({ expectedVersion: 1 }, 'historical-route-continue-0001'),
    )).status).toBe(200)
    expect(routeUsage).toEqual({
      used: 27, remaining: 23, workRemaining: 15,
      totalLimit: 50, recoveryReserve: 8,
    })
    expect((await app.request(
      '/api/v1/workbooks/imports/wbi_route_one/historical-projection/resolutions',
      mutation({
        expectedJobVersion: 2, conflictId: 'hcf_route_one', classification: 'person',
        existingSubjectId: null, serviceId: null,
      }, 'historical-route-resolution-0001'),
    )).status).toBe(201)
    expect((await app.request(
      '/api/v1/historical-clients/hcl_route_one/activation',
      mutation({ expectedVersion: 1, specialistId: 'sp_route_one' },
        'historical-route-activation-0001'),
    )).status).toBe(201)

    expect(getHistoricalProjectionStatus).toHaveBeenCalledWith(expect.objectContaining({
      actor, importId: 'wbi_route_one',
    }))
    expect(postHistoricalProjectionContinue).toHaveBeenCalledWith(expect.objectContaining({
      actor, expectedVersion: 1, importId: 'wbi_route_one',
      idempotencyKey: 'historical-route-continue-0001',
    }))
    expect(postHistoricalProjectionResolution).toHaveBeenCalledWith(expect.objectContaining({
      actor, body: {
        expectedJobVersion: 2, conflictId: 'hcf_route_one', classification: 'person',
        existingSubjectId: null, serviceId: null,
      },
    }))
    expect(postHistoricalClientActivation).toHaveBeenCalledWith(expect.objectContaining({
      actor, historicalClientId: 'hcl_route_one',
      body: { expectedVersion: 1, specialistId: 'sp_route_one' },
    }))
  })

  it('maps malformed historical commands to fixed 400 validation errors before core', async () => {
    const postHistoricalProjectionContinue = vi.fn()
    const postHistoricalProjectionResolution = vi.fn()
    const postHistoricalClientActivation = vi.fn()
    const app = createApp(depsFor({
      postHistoricalProjectionContinue,
      postHistoricalProjectionResolution,
      postHistoricalClientActivation,
    }))
    const requests = [
      [
        '/api/v1/workbooks/imports/wbi_route_one/historical-projection/continue',
        mutation({ expectedVersion: '1' }, 'historical-route-invalid-continue-0001'),
        'expectedVersion',
      ],
      [
        '/api/v1/workbooks/imports/wbi_route_one/historical-projection/resolutions',
        mutation({
          expectedJobVersion: 2, conflictId: 'hcf_route_one', classification: 'person',
          existingSubjectId: 'hcp_wrong_kind', serviceId: null,
        }, 'historical-route-invalid-resolution-0001'),
        'body',
      ],
      [
        '/api/v1/historical-clients/hcl_route_one/activation',
        mutation({ expectedVersion: 0, specialistId: 'sp_route_one' },
          'historical-route-invalid-activation-0001'),
        'expectedVersion',
      ],
    ]
    for (const [path, init, field] of requests) {
      const response = await app.request(path, init)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED', details: { field } },
      })
    }
    expect(postHistoricalProjectionContinue).not.toHaveBeenCalled()
    expect(postHistoricalProjectionResolution).not.toHaveBeenCalled()
    expect(postHistoricalClientActivation).not.toHaveBeenCalled()
  })

  it('conceals owner-only projection and specialist activation while allowing coordinator activation', async () => {
    const projection = vi.fn(async () => ({
      status: 200, body: { data: { projection: null } },
    }))
    const activation = vi.fn(async () => ({
      status: 201, body: { data: { historicalClient: { id: 'hcl_route_one' } } },
    }))
    const specialist = { ...actor, id: 'stf_route_specialist', role: 'specialist',
      specialistId: 'sp_route_specialist' }
    const specialistApp = createApp(depsFor({
      resolveActor: vi.fn(async () => specialist),
      getHistoricalProjectionStatus: projection,
      postHistoricalProjectionContinue: projection,
      postHistoricalProjectionResolution: projection,
      postHistoricalClientActivation: activation,
    }))
    const attempts = [
      specialistApp.request(
        '/api/v1/workbooks/imports/wbi_route_one/historical-projection',
      ),
      specialistApp.request(
        '/api/v1/workbooks/imports/wbi_route_one/historical-projection/continue',
        mutation({ expectedVersion: 1 }, 'historical-route-hidden-continue-0001'),
      ),
      specialistApp.request(
        '/api/v1/workbooks/imports/wbi_route_one/historical-projection/resolutions',
        mutation({
          expectedJobVersion: 2, conflictId: 'hcf_route_one', classification: 'exclude',
          existingSubjectId: null, serviceId: null,
        }, 'historical-route-hidden-resolution-0001'),
      ),
      specialistApp.request(
        '/api/v1/historical-clients/hcl_route_one/activation',
        mutation({ expectedVersion: 1, specialistId: 'sp_route_one' },
          'historical-route-hidden-activation-0001'),
      ),
      specialistApp.request(
        '/api/v1/workbooks/imports/wbi_route_one/historical-projection/continue',
        mutation({ expectedVersion: 'not-a-version' },
          'historical-route-hidden-malformed-continue-0001'),
      ),
      specialistApp.request(
        '/api/v1/historical-clients/hcl_route_one/activation',
        mutation({ expectedVersion: 0, specialistId: 'not-a-specialist' },
          'historical-route-hidden-malformed-activation-0001'),
      ),
    ]
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(404)
      expect((await response.json()).error.code).toBe('NOT_FOUND')
    }
    expect(projection).not.toHaveBeenCalled()
    expect(activation).not.toHaveBeenCalled()

    const coordinatorApp = createApp(depsFor({
      resolveActor: vi.fn(async () => ({
        ...actor, id: 'stf_route_coordinator', role: 'coordinator',
      })),
      getHistoricalProjectionStatus: projection,
      postHistoricalClientActivation: activation,
    }))
    expect((await coordinatorApp.request(
      '/api/v1/workbooks/imports/wbi_route_one/historical-projection',
    )).status).toBe(404)
    const malformedCoordinatorProjection = await coordinatorApp.request(
      '/api/v1/workbooks/imports/wbi_route_one/historical-projection/continue',
      mutation({ expectedVersion: 'not-a-version' },
        'historical-route-hidden-coordinator-continue-0001'),
    )
    expect(malformedCoordinatorProjection.status).toBe(404)
    expect((await malformedCoordinatorProjection.json()).error.code).toBe('NOT_FOUND')
    expect((await coordinatorApp.request(
      '/api/v1/historical-clients/hcl_route_one/activation',
      mutation({ expectedVersion: 1, specialistId: 'sp_route_one' },
        'historical-route-coordinator-activation-0001'),
    )).status).toBe(201)
    expect(activation).toHaveBeenCalledOnce()
  })

  it.each(['historicalClients', 'historicalOccurrences'])(
    'preserves the safe %s workspace result-limit details over HTTP',
    async (field) => {
      const response = await createApp(depsFor({
        getWorkspace: vi.fn(async () => {
          throw new AppError('WORKSPACE_RESULT_LIMIT', { field, limit: 1_000 })
        }),
      })).request('/api/v1/workspace?from=2027-01-01&to=2027-01-31')
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        error: { code: 'WORKSPACE_RESULT_LIMIT', details: { field, limit: 1_000 } },
      })
    },
  )
})
