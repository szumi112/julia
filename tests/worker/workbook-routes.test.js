import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'

const NOW_MS = Date.parse('2027-01-15T10:00:00.000Z')
const ORIGIN = 'https://bearwithme-panel.app'
const actor = Object.freeze({
  id: 'stf_workbook_route_owner', role: 'owner', specialistId: null, version: 1,
})
const principal = Object.freeze({
  kind: 'human',
  subject: 'access-workbook-route-owner',
  normalizedEmail: 'workbook-route-owner@example.test',
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
  config: {
    appEnv: 'staging', appOrigin: ORIGIN, dataMode: 'fictional',
  },
  db: { prepare: vi.fn(statement), batch: vi.fn(async () => []) },
  bucket: {},
  cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
  now: () => NOW_MS,
  resolveAccessPrincipal: vi.fn(async () => principal),
  resolveActor: vi.fn(async () => actor),
  verifyCsrfToken: vi.fn(async () => true),
  safeLog: vi.fn(),
  ...overrides,
})

const multipart = (fields, { idempotencyKey } = {}) => {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.append(key, value)
  return {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Sec-Fetch-Site': 'same-origin',
      'X-CSRF-Token': 'valid',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body,
  }
}

describe('protected workbook HTTP routes', () => {
  it('reads preview multipart once, preserves nonuniform File bytes and does not require idempotency', async () => {
    const bytes = new Uint8Array([0, 1, 17, 64, 127, 128, 254, 255])
    const previewWorkbook = vi.fn(async (input) => {
      expect(input.actor).toBe(actor)
      expect(input.bytes).toEqual(bytes)
      expect(input.filename).toBe('fikcyjny-preview.xlsx')
      expect(input).not.toHaveProperty('db')
      expect(input).not.toHaveProperty('bucket')
      return { data: { previewToken: 'signed-preview' } }
    })
    const deps = depsFor({ previewWorkbook })
    const response = await createApp(deps).request('/api/v1/workbooks/preview', multipart({
      workbook: new File([bytes], 'fikcyjny-preview.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { previewToken: 'signed-preview' } })
    expect(previewWorkbook).toHaveBeenCalledOnce()
    expect(deps.verifyCsrfToken).toHaveBeenCalledOnce()
  })

  it('commits the exact multipart workbook/token and creator-scoped idempotency key', async () => {
    const bytes = new Uint8Array([7, 3, 9, 2])
    const createWorkbookImport = vi.fn(async (input) => {
      expect(input.bytes).toEqual(bytes)
      expect(input.filename).toBe('fikcyjny-import.xlsx')
      expect(input.previewToken).toBe('v1.preview.owner-bound')
      expect(input.idempotencyKey).toBe('workbook-route-import-0001')
      expect(input.actor).toBe(actor)
      return { status: 201, body: { data: { import: { id: 'wbi_route_one' } } } }
    })
    const response = await createApp(depsFor({ createWorkbookImport })).request(
      '/api/v1/workbooks/imports',
      multipart({
        previewToken: 'v1.preview.owner-bound',
        workbook: new File([bytes], 'fikcyjny-import.xlsx'),
      }, { idempotencyKey: 'workbook-route-import-0001' }),
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { import: { id: 'wbi_route_one' } } })
    expect(createWorkbookImport).toHaveBeenCalledOnce()
  })

  it('requires a fresh Access assertion for creator-bound continuation and rejects stale reauth', async () => {
    const continueWorkbookImport = vi.fn(async (input) => ({
      status: 200,
      body: { data: { import: { id: input.importId, version: input.expectedVersion } } },
    }))
    const fresh = await createApp(depsFor({ continueWorkbookImport })).request(
      '/api/v1/workbooks/imports/wbi_route_one/continue',
      multipart({ expectedVersion: '2' }, { idempotencyKey: 'workbook-route-continue-0001' }),
    )
    expect(fresh.status).toBe(200)
    expect(continueWorkbookImport).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      expectedVersion: 2,
      importId: 'wbi_route_one',
      idempotencyKey: 'workbook-route-continue-0001',
    }))

    const staleService = vi.fn()
    const stalePrincipal = { ...principal, issuedAt: Math.floor(NOW_MS / 1_000) - 301 }
    const stale = await createApp(depsFor({
      continueWorkbookImport: staleService,
      resolveAccessPrincipal: vi.fn(async () => stalePrincipal),
    })).request(
      '/api/v1/workbooks/imports/wbi_route_one/continue',
      multipart({ expectedVersion: '2' }, { idempotencyKey: 'workbook-route-continue-0002' }),
    )
    expect(stale.status).toBe(401)
    expect((await stale.json()).error.code).toBe('REAUTH_REQUIRED')
    expect(staleService).not.toHaveBeenCalled()
  })

  it('returns count-only creator status and streams a reauthorized export with safe headers', async () => {
    const getWorkbookImport = vi.fn(async () => ({
      data: {
        import: { id: 'wbi_route_one', acceptedRecords: 2_232, quarantinedRecords: 3 },
        job: { phase: 'complete', cursor: 2_234, totalRecords: 2_234 },
      },
    }))
    const exportBytes = new Uint8Array([80, 75, 3, 4, 0, 255])
    const exportWorkbook = vi.fn(async ({ format }) => ({
      bytes: exportBytes,
      filename: format === 'panel-v2'
        ? 'bear-with-me-panel-v2-2027-01-15.xlsx'
        : 'bear-with-me-legacy-2027-01-15.xlsx',
    }))
    const app = createApp(depsFor({ getWorkbookImport, exportWorkbook }))
    const status = await app.request('/api/v1/workbooks/imports/wbi_route_one')
    expect(status.status).toBe(200)
    const statusBody = await status.json()
    expect(statusBody.data.import.acceptedRecords).toBe(2_232)
    expect(JSON.stringify(statusBody)).not.toContain('sourceKey')
    expect(JSON.stringify(statusBody)).not.toContain('plan')

    const exported = await app.request('/api/v1/workbooks/export?format=panel-v2')
    expect(exported.status).toBe(200)
    expect(new Uint8Array(await exported.arrayBuffer())).toEqual(
      new Uint8Array([80, 75, 3, 4, 0, 255]),
    )
    expect(exportBytes).toEqual(new Uint8Array(6))
    expect(exported.headers.get('cache-control')).toContain('private')
    expect(exported.headers.get('cache-control')).toContain('no-store')
    expect(exported.headers.get('x-content-type-options')).toBe('nosniff')
    expect(exported.headers.get('content-disposition')).toBe(
      'attachment; filename="bear-with-me-panel-v2-2027-01-15.xlsx"',
    )
    expect(exported.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(exportWorkbook).toHaveBeenCalledWith(expect.objectContaining({ actor, format: 'panel-v2' }))
  })

  it('rejects and wipes a generated export as soon as it exceeds the 10 MiB response cap', async () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1).fill(173)
    const response = await createApp(depsFor({
      exportWorkbook: vi.fn(async () => ({
        bytes: oversized,
        filename: 'bear-with-me-panel-v2-2027-01-15.xlsx',
      })),
    })).request('/api/v1/workbooks/export?format=panel-v2')

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('WORKBOOK_EXPORT_LIMIT')
    expect(oversized.every((value) => value === 0)).toBe(true)
  })

  it('rejects every workbook query except one canonical export format selector', async () => {
    const previewWorkbook = vi.fn()
    const createWorkbookImport = vi.fn()
    const continueWorkbookImport = vi.fn()
    const getWorkbookImport = vi.fn()
    const exportWorkbook = vi.fn()
    const app = createApp(depsFor({
      previewWorkbook,
      createWorkbookImport,
      continueWorkbookImport,
      getWorkbookImport,
      exportWorkbook,
    }))
    const requests = [
      app.request('/api/v1/workbooks/preview?filename=sekret.xlsx', multipart({
        workbook: new File([new Uint8Array([1])], 'safe.xlsx'),
      })),
      app.request('/api/v1/workbooks/imports?token=sekret', multipart({
        previewToken: 'token', workbook: new File([new Uint8Array([1])], 'safe.xlsx'),
      }, { idempotencyKey: 'workbook-query-import-0001' })),
      app.request('/api/v1/workbooks/imports/wbi_route_one/continue?cursor=1', multipart({
        expectedVersion: '1',
      }, { idempotencyKey: 'workbook-query-continue-0001' })),
      app.request('/api/v1/workbooks/imports/wbi_route_one?source=hidden'),
    ]
    for (const response of await Promise.all(requests)) expect(response.status).toBe(404)
    for (const url of [
      '/api/v1/workbooks/export',
      '/api/v1/workbooks/export?format=panel-v2&format=legacy',
      '/api/v1/workbooks/export?format=panel%2Dv2',
      '/api/v1/workbooks/export?format=panel-v2&',
      '/api/v1/workbooks/export?other=panel-v2',
    ]) {
      const response = await app.request(url)
      expect(response.status).toBe(400)
    }
    expect(previewWorkbook).not.toHaveBeenCalled()
    expect(createWorkbookImport).not.toHaveBeenCalled()
    expect(continueWorkbookImport).not.toHaveBeenCalled()
    expect(getWorkbookImport).not.toHaveBeenCalled()
    expect(exportWorkbook).not.toHaveBeenCalled()
  })
})
