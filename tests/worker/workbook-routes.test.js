import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import { blindEmailIndex } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2027-01-15T10:00:00.000Z')
const ORIGIN = 'https://bearwithme-panel.app'
const actor = authorityActor({ id: 'stf_workbook_route_owner', role: 'owner' })
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
  resolvePreviewActor: vi.fn(async () => actor),
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

const jsonMutation = (body, idempotencyKey) => ({
  method: 'POST',
  headers: {
    Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin',
    'X-CSRF-Token': 'valid', 'Idempotency-Key': idempotencyKey,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
})

describe('protected workbook HTTP routes', () => {
  it.each(['development', 'production'])(
    'uniformly hides the whole workbook namespace before every HTTP boundary in %s',
    async (appEnv) => {
      const dependencyCalls = {
        access: vi.fn(async () => { throw new Error('ACCESS_MUST_NOT_RUN') }),
        actor: vi.fn(async () => { throw new Error('ACTOR_MUST_NOT_RUN') }),
        csrf: vi.fn(async () => { throw new Error('CSRF_MUST_NOT_RUN') }),
        multipart: vi.fn(async () => { throw new Error('BODY_MUST_NOT_RUN') }),
      }
      const db = {
        prepare: vi.fn(() => { throw new Error('D1_MUST_NOT_RUN') }),
        batch: vi.fn(() => { throw new Error('D1_MUST_NOT_RUN') }),
      }
      const app = createApp(depsFor({
        config: { appEnv, appOrigin: ORIGIN, dataMode: 'fictional' },
        db,
        resolveAccessPrincipal: dependencyCalls.access,
        resolveActor: dependencyCalls.actor,
        resolvePreviewActor: dependencyCalls.actor,
        verifyCsrfToken: dependencyCalls.csrf,
        readMultipartBodyOnce: dependencyCalls.multipart,
      }))
      const paths = [
        '/api/v1/workbooks/preview',
        '/api/v1/workbooks/imports',
        '/api/v1/workbooks/imports/wbi_route_one/continue',
        '/api/v1/workbooks/imports/wbi_route_one',
        '/api/v1/workbooks/registry?section=unknown',
        '/api/v1/workbooks/export?format=panel-v2',
        '/api/v1/workbooks/exports',
        '/api/v1/workbooks/unrecognized',
      ]
      for (const path of paths) {
        for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
          const response = await app.request(path, { method })
          expect(response.status, `${method} ${path}`).toBe(404)
          if (method !== 'HEAD') expect((await response.json()).error.code).toBe('NOT_FOUND')
        }
      }
      expect(dependencyCalls.access).not.toHaveBeenCalled()
      expect(dependencyCalls.actor).not.toHaveBeenCalled()
      expect(dependencyCalls.csrf).not.toHaveBeenCalled()
      expect(dependencyCalls.multipart).not.toHaveBeenCalled()
      expect(db.prepare).not.toHaveBeenCalled()
      expect(db.batch).not.toHaveBeenCalled()
    },
  )

  it('forwards the canonical bounded unknown-period registry section without extra input', async () => {
    const loadWorkbookRegistry = vi.fn(async (input) => {
      expect(input).toEqual(expect.objectContaining({
        actor, cursor: null, section: 'unknown', nowMs: NOW_MS,
      }))
      return { data: {
        cursor: null, nextCursor: null, imports: [], exports: [], entries: [], complete: true,
      } }
    })
    const response = await createApp(depsFor({ loadWorkbookRegistry })).request(
      '/api/v1/workbooks/registry?section=unknown',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual({ data: {
      cursor: null, nextCursor: null, imports: [], exports: [], entries: [], complete: true,
    } })
    expect(loadWorkbookRegistry).toHaveBeenCalledOnce()

    const paged = await createApp(depsFor({
      loadWorkbookRegistry: vi.fn(async (input) => {
        expect(input.cursor).toBe('c_20_r12')
        return { data: {
          cursor: 'c_20_r12', nextCursor: null,
          imports: [], exports: [], entries: [], complete: true,
        } }
      }),
    })).request('/api/v1/workbooks/registry?section=unknown&cursor=c_20_r12')
    expect(paged.status).toBe(200)

    const retry = await createApp(depsFor({
      loadWorkbookRegistry: async () => { throw new Error('WORKBOOK_REGISTRY_RETRY') },
    })).request('/api/v1/workbooks/registry?section=unknown')
    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({
      error: { code: 'WORKBOOK_REGISTRY_RETRY' },
    })
  })

  it('maps only reviewed registry validation failures to fixed public 400 fields', async () => {
    const registryApp = createApp(depsFor({
      loadWorkbookRegistry: async () => { throw new Error('VALIDATION_FAILED/registry') },
    }))
    const registry = await registryApp.request('/api/v1/workbooks/registry?section=invalid')
    expect(registry.status).toBe(400)
    expect(await registry.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { field: 'registry' } },
    })

    const resolutionsApp = createApp(depsFor({
      recordWorkbookResolutions: async () => {
        throw new Error('VALIDATION_FAILED/resolutions')
      },
    }))
    const resolutions = await resolutionsApp.request(
      '/api/v1/workbooks/imports/wbi_route_one/resolutions',
      jsonMutation({
        expectedVersion: 0, planDigest: `v1_${'A'.repeat(43)}`, resolutions: [],
      }, 'workbook-route-resolution-invalid'),
    )
    expect(resolutions.status).toBe(400)
    expect(await resolutions.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { field: 'resolutions' } },
    })

    const detailApp = createApp(depsFor({
      loadWorkbookRegistryDetail: async () => {
        throw new Error('VALIDATION_FAILED/registryDetail')
      },
    }))
    const detail = await detailApp.request(
      '/api/v1/workbooks/registry/details',
      jsonMutation({ importId: 'bad', section: 'source', cursor: null },
        'workbook-route-detail-invalid'),
    )
    expect(detail.status).toBe(400)
    expect(await detail.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { field: 'registryDetail' } },
    })

    const cursorApp = createApp(depsFor({
      loadWorkbookRegistry: async () => { throw new Error('VALIDATION_FAILED/cursor') },
      loadWorkbookRegistryDetail: async () => { throw new Error('VALIDATION_FAILED/cursor') },
    }))
    const cursor = await cursorApp.request(
      '/api/v1/workbooks/registry?section=imports&cursor=bad',
    )
    expect(cursor.status).toBe(400)
    expect(await cursor.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { field: 'registry' } },
    })
    const detailCursor = await cursorApp.request(
      '/api/v1/workbooks/registry/details',
      jsonMutation({ importId: 'wbi_route_one', section: 'source', cursor: 'bad' },
        'workbook-route-detail-cursor-invalid'),
    )
    expect(detailCursor.status).toBe(400)
    expect(await detailCursor.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { field: 'registryDetail' } },
    })
  })

  it('resolves preview through the active current lookup using reads only', async () => {
    const lookupKey = encodeBase64Url(new Uint8Array(32).fill(27))
    const keyring = await createKeyring({ BWM_LOOKUP_HMAC_V1: lookupKey }, {
      activeLookupKeyVersion: 1,
    })
    const emailLookup = await blindEmailIndex(principal.normalizedEmail, keyring)
    const sql = []
    const bindings = []
    const db = {
      prepare: vi.fn((query) => {
        sql.push(query)
        const prepared = {
          bind: vi.fn((...values) => {
            bindings.push(values)
            return prepared
          }),
          first: vi.fn(async () => ({
            id: actor.id,
            role: actor.role,
            specialist_id: null,
            version: actor.version,
          })),
          all: vi.fn(async () => query.includes('FROM staff_authorities AS authority')
            ? { results: [{
              authority_revision: actor.authorityRevision,
              capability: null,
              decision: null,
            }] }
            : { results: [] }),
          raw: vi.fn(async () => []),
          run: vi.fn(async () => { throw new Error('WRITE_TRAP') }),
        }
        return prepared
      }),
      batch: vi.fn(async () => { throw new Error('WRITE_TRAP') }),
    }
    const bucket = {
      delete: vi.fn(async () => { throw new Error('R2_TRAP') }),
      get: vi.fn(async () => { throw new Error('R2_TRAP') }),
      put: vi.fn(async () => { throw new Error('R2_TRAP') }),
    }
    const previewWorkbook = vi.fn(async ({ actor: resolved }) => {
      expect(resolved).toEqual(actor)
      return { data: { previewToken: 'read-only-preview' } }
    })
    const deps = depsFor({
      db,
      bucket,
      cryptoContext: { keyring, dataKey: {}, scope: {} },
      previewWorkbook,
      resolveAccessPrincipal: vi.fn(async () => principal),
      resolveActor: vi.fn(async () => { throw new Error('MUTATING_RESOLVER_TRAP') }),
      resolvePreviewActor: undefined,
    })
    const response = await createApp(deps).request('/api/v1/workbooks/preview', multipart({
      workbook: new File([new Uint8Array([1, 2, 3])], 'fikcyjny-preview.xlsx'),
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { previewToken: 'read-only-preview' } })
    expect(sql).toHaveLength(2)
    expect(sql[0]).toContain('FROM staff_users')
    expect(sql[0]).toContain("status='active'")
    expect(sql[1]).toContain('FROM staff_authorities AS authority')
    expect(bindings).toEqual([
      [emailLookup, principal.subject],
      [actor.id, actor.role, actor.specialistId, actor.version],
    ])
    expect(db.batch).not.toHaveBeenCalled()
    expect(bucket.get).not.toHaveBeenCalled()
    expect(bucket.put).not.toHaveBeenCalled()
    expect(bucket.delete).not.toHaveBeenCalled()
  })

  it('reads preview multipart once, preserves nonuniform File bytes and does not require idempotency', async () => {
    const bytes = new Uint8Array([0, 1, 17, 64, 127, 128, 254, 255])
    const previewWorkbook = vi.fn(async (input) => {
      expect(input.actor).toBe(actor)
      expect(input.bytes).toEqual(bytes)
      expect(input.filename).toBe('fikcyjny-preview.xlsx')
      expect(input.db).toBeDefined()
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

  it.each([
    ['leading whitespace', ' fikcyjny.xlsx'],
    ['trailing whitespace', 'fikcyjny.xlsx '],
    ['non-NFC', 'fikcyjne-e\u0301.xlsx'],
    ['format control', 'fikcyjny-\u202E.xlsx'],
    ['too long', `${'x'.repeat(251)}.xlsx`],
  ])('rejects a %s workbook filename before preview inspection', async (_label, filename) => {
    const previewWorkbook = vi.fn()
    const response = await createApp(depsFor({ previewWorkbook })).request(
      '/api/v1/workbooks/preview',
      multipart({ workbook: new File([new Uint8Array([1])], filename) }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { field: 'filename' } },
    })
    expect(previewWorkbook).not.toHaveBeenCalled()
  })

  it('wipes preview bytes when route-local runtime configuration fails', async () => {
    const form = new FormData()
    const file = new File([new Uint8Array([9, 8, 7])], 'fikcyjny-preview.xlsx')
    let captured
    let workbookRead = false
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => {
        const buffer = new Uint8Array([9, 8, 7]).buffer
        captured = new Uint8Array(buffer)
        workbookRead = true
        return buffer
      },
    })
    form.append('workbook', file)
    const previewWorkbook = vi.fn()
    const deps = depsFor({
      previewWorkbook,
      readMultipartBodyOnce: vi.fn(async () => form),
    })
    const config = deps.config
    Object.defineProperty(deps, 'config', {
      configurable: true,
      get() {
        if (workbookRead) throw new Error('CONFIG_FAILURE')
        return config
      },
    })

    const response = await createApp(deps).request(
      '/api/v1/workbooks/preview',
      multipart({ workbook: new File([new Uint8Array([1])], 'ignored.xlsx') }),
    )

    expect(response.status).toBe(500)
    expect(captured).toEqual(new Uint8Array(3))
    expect(previewWorkbook).not.toHaveBeenCalled()
  })

  it('commits the exact multipart workbook/token and creator-scoped idempotency key', async () => {
    const bytes = new Uint8Array([7, 3, 9, 2])
    const createWorkbookImport = vi.fn(async (input) => {
      expect(input.bytes).toEqual(bytes)
      expect(input.filename).toBe('fikcyjny-import.xlsx')
      expect(input.previewToken).toBe('v1.preview.owner-bound')
      expect(input.resolutions).toEqual([{
        conflictId: `wmc_${'a'.repeat(43)}`,
        specialistId: 'sp_fictional_route_specialist',
      }])
      expect(input.idempotencyKey).toBe('workbook-route-import-0001')
      expect(input.actor).toBe(actor)
      return { status: 201, body: { data: { import: { id: 'wbi_route_one' } } } }
    })
    const response = await createApp(depsFor({ createWorkbookImport })).request(
      '/api/v1/workbooks/imports',
      multipart({
        previewToken: 'v1.preview.owner-bound',
        resolutions: JSON.stringify([{
          conflictId: `wmc_${'a'.repeat(43)}`,
          specialistId: 'sp_fictional_route_specialist',
        }]),
        workbook: new File([bytes], 'fikcyjny-import.xlsx'),
      }, { idempotencyKey: 'workbook-route-import-0001' }),
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { import: { id: 'wbi_route_one' } } })
    expect(createWorkbookImport).toHaveBeenCalledOnce()
  })

  it.each([
    ['malformed', '{'],
    ['unknown keys', JSON.stringify([{ conflictId: `wmc_${'a'.repeat(43)}`, decision: 'accept' }])],
    ['duplicate ids', JSON.stringify([
      { conflictId: `wmc_${'a'.repeat(43)}`, specialistId: 'sp_route_one' },
      { conflictId: `wmc_${'a'.repeat(43)}`, specialistId: 'sp_route_two' },
    ])],
  ])('rejects %s multipart resolutions before the import service', async (_label, resolutions) => {
    const createWorkbookImport = vi.fn()
    const response = await createApp(depsFor({ createWorkbookImport })).request(
      '/api/v1/workbooks/imports',
      multipart({
        previewToken: 'v1.preview.owner-bound', resolutions,
        workbook: new File([new Uint8Array([1])], 'fikcyjny-import.xlsx'),
      }, { idempotencyKey: 'workbook-route-invalid-resolution' }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_FAILED')
    expect(createWorkbookImport).not.toHaveBeenCalled()
  })

  it('wipes imported workbook bytes when multipart resolutions are invalid', async () => {
    const form = new FormData()
    const file = new File([new Uint8Array([6, 5, 4])], 'fikcyjny-import.xlsx')
    let captured
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => {
        const buffer = new Uint8Array([6, 5, 4]).buffer
        captured = new Uint8Array(buffer)
        return buffer
      },
    })
    form.append('previewToken', 'v1.preview.owner-bound')
    form.append('resolutions', '{')
    form.append('workbook', file)
    const createWorkbookImport = vi.fn()
    const response = await createApp(depsFor({
      createWorkbookImport,
      readMultipartBodyOnce: vi.fn(async () => form),
    })).request(
      '/api/v1/workbooks/imports',
      multipart({
        previewToken: 'ignored', resolutions: '[]',
        workbook: new File([new Uint8Array([1])], 'ignored.xlsx'),
      }, { idempotencyKey: 'workbook-route-invalid-resolution' }),
    )

    expect(response.status).toBe(400)
    expect(captured).toEqual(new Uint8Array(3))
    expect(createWorkbookImport).not.toHaveBeenCalled()
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

  it('returns count-only creator status and streams an audited reauthorized POST export with safe headers', async () => {
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
    const recordWorkbookExport = vi.fn(async (input) => {
      expect(input).toMatchObject({
        actor, format: 'panel-v2', byteSize: 6,
        filename: 'bear-with-me-panel-v2-2027-01-15.xlsx',
        idempotencyKey: 'workbook-route-export-0001',
      })
      expect(input.fingerprint).toMatch(/^[0-9a-f]{64}$/)
      return { status: 200, body: { data: { id: 'wbe_route_one' } } }
    })
    const app = createApp(depsFor({
      getWorkbookImport, exportWorkbook, recordWorkbookExport,
    }))
    const status = await app.request('/api/v1/workbooks/imports/wbi_route_one')
    expect(status.status).toBe(200)
    const statusBody = await status.json()
    expect(statusBody.data.import.acceptedRecords).toBe(2_232)
    expect(JSON.stringify(statusBody)).not.toContain('sourceKey')
    expect(JSON.stringify(statusBody)).not.toContain('plan')

    const exported = await app.request('/api/v1/workbooks/exports', jsonMutation(
      { format: 'panel-v2' }, 'workbook-route-export-0001',
    ))
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
    expect(exported.headers.get('content-length')).toBe('6')
    expect(exported.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(exportWorkbook).toHaveBeenCalledWith(expect.objectContaining({ actor, format: 'panel-v2' }))
    expect(recordWorkbookExport).toHaveBeenCalledOnce()
    for (const format of ['csv', '', null]) {
      const invalid = await app.request('/api/v1/workbooks/exports', jsonMutation(
        { format }, `workbook-route-export-invalid-${String(format || 'empty')}`,
      ))
      expect(invalid.status).toBe(400)
      expect((await invalid.json()).error).toMatchObject({
        code: 'VALIDATION_FAILED', details: { field: 'body' },
      })
    }
    expect(exportWorkbook).toHaveBeenCalledTimes(1)
    const legacy = await app.request('/api/v1/workbooks/export?format=panel-v2')
    expect(legacy.status).toBe(404)
  })

  it('rejects and wipes a generated export as soon as it exceeds the 10 MiB response cap', async () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1).fill(173)
    const recordWorkbookExport = vi.fn()
    const response = await createApp(depsFor({
      exportWorkbook: vi.fn(async () => ({
        bytes: oversized,
        filename: 'bear-with-me-panel-v2-2027-01-15.xlsx',
      })),
      recordWorkbookExport,
    })).request('/api/v1/workbooks/exports', jsonMutation(
      { format: 'panel-v2' }, 'workbook-route-export-limit',
    ))

    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('WORKBOOK_EXPORT_LIMIT')
    expect(oversized.every((value) => value === 0)).toBe(true)
    expect(recordWorkbookExport).not.toHaveBeenCalled()
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
        previewToken: 'token', resolutions: '[]',
        workbook: new File([new Uint8Array([1])], 'safe.xlsx'),
      }, { idempotencyKey: 'workbook-query-import-0001' })),
      app.request('/api/v1/workbooks/imports/wbi_route_one/continue?cursor=1', multipart({
        expectedVersion: '1',
      }, { idempotencyKey: 'workbook-query-continue-0001' })),
      app.request('/api/v1/workbooks/imports/wbi_route_one?source=hidden'),
    ]
    for (const response of await Promise.all(requests)) expect(response.status).toBe(404)
    for (const url of ['/api/v1/workbooks/export', '/api/v1/workbooks/export?format=panel-v2']) {
      const response = await app.request(url)
      expect(response.status).toBe(404)
    }
    expect(previewWorkbook).not.toHaveBeenCalled()
    expect(createWorkbookImport).not.toHaveBeenCalled()
    expect(continueWorkbookImport).not.toHaveBeenCalled()
    expect(getWorkbookImport).not.toHaveBeenCalled()
    expect(exportWorkbook).not.toHaveBeenCalled()
  })
})
