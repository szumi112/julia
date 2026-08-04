import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createClient,
  digestCreateClientRequest,
  validateCreateClientBody,
} from '../../worker/core/clients.js'
import { postClient } from '../../worker/routes/clients.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { createD1QueryBudget, usageForD1QueryBudgetViews } from '../../worker/db/query-budget.js'
import { createApp } from '../../worker/app.js'

const NOW_MS = 1_800_000_000_000
const BODY = Object.freeze({
  name: 'Fikcyjna', age: 12, status: 'active', specialistId: 'sp_target',
})
const CORRELATION_ID = '00000000-0000-4000-8000-000000000015'

const ring = () => createKeyring(env, {
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
  activeBackupKekVersion: 1,
})

beforeAll(async () => {
  const instant = new Date(NOW_MS).toISOString()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_owner', 'lookup_client_owner', '{}', '{}', 'owner', 'active',
      'access-client-owner', null, 1, instant, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_target', 'lookup_client_target', '{}', '{}', 'owner', 'active',
      'access-client-target', 'sp_target', 1, instant, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_target', 'stf_client_target', 18000, 'active', 1, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'ver_client_target_specialist', 'specialist', 'sp_target', 1, '{}', null,
      instant, CORRELATION_ID,
    ),
  ])
})

describe('persistent client creation', () => {
  it('strictly captures the exact create body without invoking accessors', () => {
    expect(validateCreateClientBody(BODY)).toEqual(BODY)
    for (const [body, field] of [
      [{ ...BODY, name: ' Fikcyjna' }, 'name'],
      [{ ...BODY, name: '\uD800' }, 'name'],
      [{ ...BODY, age: 0 }, 'age'],
      [{ ...BODY, status: 'archived' }, 'status'],
      [{ ...BODY, specialistId: 'staff_target' }, 'specialistId'],
      [{ ...BODY, extra: true }, 'body'],
    ]) expect(() => validateCreateClientBody(body)).toThrow(`VALIDATION_FAILED/${field}`)

    const getter = vi.fn(() => 'Fikcyjna')
    const hostile = Object.defineProperty({
      age: 12, status: 'active', specialistId: 'sp_target',
    }, 'name', { enumerable: true, get: getter })
    expect(() => validateCreateClientBody(hostile)).toThrow('VALIDATION_FAILED/body')
    expect(getter).not.toHaveBeenCalled()

    for (const hostile of [
      Object.defineProperty({ ...BODY }, 'age', { value: 12, enumerable: false }),
      Object.assign({ ...BODY }, { [Symbol('hidden')]: true }),
      new Proxy({}, { ownKeys() { throw new Error('private-value') } }),
    ]) expect(() => validateCreateClientBody(hostile)).toThrow('VALIDATION_FAILED/body')
  })

  it('digests the normalized exact route and is stable across body key order', async () => {
    const reordered = {
      specialistId: 'sp_target', status: 'active', age: 12, name: 'Fikcyjna',
    }
    const digest = await digestCreateClientRequest(BODY)
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await digestCreateClientRequest(reordered)).toBe(digest)
    expect(await digestCreateClientRequest({ ...BODY, age: 13 })).not.toBe(digest)
  })

  it('checks stored idempotency before specialist lookup or ID generation', async () => {
    const calls = []
    const db = {
      prepare(sql) {
        calls.push(sql)
        return {
          bind(...bindings) {
            return {
              async first() { return null },
              bindings,
            }
          },
        }
      },
      batch: vi.fn(),
    }
    const idFactory = vi.fn(() => 'generated')
    await expect(createClient({
      db,
      recoveryDb: db,
      actor: { id: 'stf_owner', role: 'owner', specialistId: null },
      keyring: {},
      nowMs: NOW_MS,
      correlationId: CORRELATION_ID,
      idFactory,
      body: BODY,
      idempotencyKey: 'client-create-key-0001',
    })).rejects.toThrow('FORBIDDEN')
    expect(calls[0]).toContain('FROM idempotency_records')
    expect(calls[1]).toContain('FROM specialists')
    expect(idFactory).not.toHaveBeenCalled()
    expect(db.batch).not.toHaveBeenCalled()
  })

  it('keeps the POST adapter exact and delegates only captured route context', async () => {
    const service = vi.fn(async () => ({ status: 201, body: { data: { client: {} } } }))
    const input = {
      db: {}, recoveryDb: {}, actor: { id: 'stf_owner' }, keyring: {},
      nowMs: NOW_MS, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      body: BODY, idempotencyKey: 'client-create-key-0002', create: service,
    }
    expect(await postClient(input)).toEqual({ status: 201, body: { data: { client: {} } } })
    expect(service).toHaveBeenCalledOnce()
    expect(service).toHaveBeenCalledWith(expect.objectContaining({
      db: input.db, recoveryDb: input.recoveryDb, body: BODY,
    }))
  })

  it('creates key, client, assignment, versions, one audit, idempotency, and guard atomically', async () => {
    const values = ['client_one', 'assignment_one', 'client_version_one',
      'assignment_version_one', 'audit_one', 'data_key_one']
    const idFactory = vi.fn(() => values.shift())
    const result = await createClient({
      db: env.DB,
      recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(),
      nowMs: NOW_MS,
      correlationId: CORRELATION_ID,
      idFactory,
      body: BODY,
      idempotencyKey: 'client-create-key-success-0001',
    })

    expect(result).toEqual({
      status: 201,
      body: { data: { client: {
        id: 'cl_client_one', name: 'Fikcyjna', age: 12, status: 'active', version: 1,
        archivedAt: null, createdAt: new Date(NOW_MS).toISOString(),
        updatedAt: new Date(NOW_MS).toISOString(), readOnly: false,
        assignment: {
          id: 'asg_assignment_one', specialistId: 'sp_target',
          startsAt: new Date(NOW_MS).toISOString(), version: 1,
        },
      } } },
    })
    expect(idFactory).toHaveBeenCalledTimes(6)

    const counts = await Promise.all([
      ['data_keys', "scope_id='cl_client_one'"],
      ['clients', "id='cl_client_one'"],
      ['client_assignments', "client_id='cl_client_one'"],
      ['record_versions', "entity_id IN ('cl_client_one','asg_assignment_one')"],
      ['audit_events', "entity_id='cl_client_one' AND action='client.created'"],
      ['idempotency_records', "resource_id='cl_client_one'"],
    ].map(async ([table, where]) => (await env.DB.prepare(
      `SELECT count(*) AS count FROM ${table} WHERE ${where}`
    ).first()).count))
    expect(counts).toEqual([1, 1, 1, 2, 1, 1])

    const replayFactory = vi.fn(() => { throw new Error('must not generate') })
    const replay = await createClient({
      db: env.DB,
      recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(),
      nowMs: NOW_MS + 1000,
      correlationId: CORRELATION_ID,
      idFactory: replayFactory,
      body: BODY,
      idempotencyKey: 'client-create-key-success-0001',
    })
    expect(replay).toEqual(result)
    expect(replayFactory).not.toHaveBeenCalled()

    await expect(createClient({
      db: env.DB,
      recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(),
      nowMs: NOW_MS + 2000,
      correlationId: CORRELATION_ID,
      idFactory: replayFactory,
      body: { ...BODY, age: 13 },
      idempotencyKey: 'client-create-key-success-0001',
    })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    expect(replayFactory).not.toHaveBeenCalled()
  })

  it('builds exactly the ordered eight-statement UOW without prewrites', async () => {
    const terminals = []
    const statement = (sql, bindings = []) => ({
      sql,
      bindings,
      bind(...values) { return statement(sql, values) },
      run() { terminals.push(['run', sql]); return Promise.resolve({ success: true }) },
      all() { terminals.push(['all', sql]); return Promise.resolve({ results: [] }) },
      raw() { terminals.push(['raw', sql]); return Promise.resolve([]) },
      first() {
        terminals.push(['first', sql])
        if (sql.includes('idempotency_records')) return Promise.resolve(null)
        if (sql.includes('FROM specialists AS specialist')) {
          return Promise.resolve({ id: 'sp_target', staff_user_id: 'stf_client_target' })
        }
        return Promise.resolve(null)
      },
    })
    let batch
    const db = {
      prepare: (sql) => statement(sql),
      async batch(statements) { batch = statements; return statements.map(() => ({ success: true })) },
    }
    const values = ['ordered_client', 'ordered_assignment', 'ordered_client_ver',
      'ordered_assignment_ver', 'ordered_audit', 'ordered_key']
    await createClient({
      db, recoveryDb: db,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS, correlationId: CORRELATION_ID,
      idFactory: () => values.shift(), body: BODY,
      idempotencyKey: 'client-create-ordered-0001',
    })
    expect(terminals.map(([method]) => method)).toEqual(['first', 'first'])
    expect(batch.map(({ sql }) => sql.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringMatching(/^INSERT INTO data_keys /),
      expect.stringMatching(/^INSERT INTO clients /),
      expect.stringMatching(/^INSERT INTO client_assignments /),
      expect.stringMatching(/^INSERT INTO record_versions /),
      expect.stringMatching(/^INSERT INTO record_versions /),
      expect.stringMatching(/^INSERT INTO audit_events /),
      expect.stringMatching(/^INSERT INTO idempotency_records /),
      expect.stringMatching(/^INSERT INTO core_directory_invariant_failures /),
    ])
    expect(JSON.stringify(batch.map(({ bindings }) => bindings))).not.toContain('Fikcyjna')
  })

  it.each([
    [{ id: 'stf_owner', role: 'owner', specialistId: null }, 'sp_target', true],
    [{ id: 'stf_coord', role: 'coordinator', specialistId: null }, 'sp_target', true],
    [{ id: 'stf_spec', role: 'specialist', specialistId: 'sp_target' }, 'sp_target', true],
    [{ id: 'stf_spec', role: 'specialist', specialistId: 'sp_other' }, 'sp_target', false],
    [{ id: 'stf_owner', role: 'owner', specialistId: 'sp_owner' }, 'sp_target', true],
  ])('enforces assignment authorization for actor %o', async (actor, specialistId, allowed) => {
    const calls = []
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                calls.push(sql)
                if (sql.includes('idempotency_records')) return null
                return { id: specialistId, staff_user_id: 'stf_target' }
              },
            }
          },
        }
      },
      batch: vi.fn(async () => []),
    }
    let generated = 0
    const idFactory = vi.fn(() => `bad_after_authorization_${generated++}`)
    const operation = createClient({
      db, recoveryDb: db, actor, keyring: {}, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory,
      body: { ...BODY, specialistId }, idempotencyKey: `client-role-${actor.role}-0001`,
    })
    if (allowed) await expect(operation).rejects.toThrow('CRYPTO_FAILURE')
    else await expect(operation).rejects.toThrow('FORBIDDEN')
    expect(calls).toHaveLength(2)
    expect(idFactory).toHaveBeenCalledTimes(allowed ? 6 : 0)
  })

  it('rolls back every mutation statement position with no residue', async () => {
    const keyring = await ring()
    for (let failedAt = 0; failedAt < 8; failedAt += 1) {
      const marker = `rollback_${failedAt}`
      const values = [`client_${marker}`, `assignment_${marker}`, `client_ver_${marker}`,
        `assignment_ver_${marker}`, `audit_${marker}`, `key_${marker}`]
      const db = {
        prepare: (sql) => env.DB.prepare(sql),
        batch: (statements) => env.DB.batch(statements.map((statement, index) => (
          index === failedAt
            ? env.DB.prepare("INSERT INTO core_directory_invariant_failures (failure_kind) VALUES ('forced')")
            : statement
        ))),
      }
      await expect(createClient({
        db, recoveryDb: env.DB,
        actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
        keyring, nowMs: NOW_MS, correlationId: CORRELATION_ID,
        idFactory: () => values.shift(), body: BODY,
        idempotencyKey: `client-create-rollback-${failedAt}-0001`,
      })).rejects.toThrow()
      const residue = await Promise.all([
        ['data_keys', `scope_id='cl_client_${marker}'`],
        ['clients', `id='cl_client_${marker}'`],
        ['client_assignments', `client_id='cl_client_${marker}'`],
        ['record_versions', `entity_id IN ('cl_client_${marker}','asg_assignment_${marker}')`],
        ['audit_events', `entity_id='cl_client_${marker}'`],
        ['idempotency_records', `resource_id='cl_client_${marker}'`],
      ].map(async ([table, where]) => (await env.DB.prepare(
        `SELECT count(*) AS count FROM ${table} WHERE ${where}`
      ).first()).count))
      expect(residue).toEqual([0, 0, 0, 0, 0, 0])
    }
  })

  it('recovers a concurrent winner with exactly two sibling recovery reads', async () => {
    const keyring = await ring()
    const key = 'client-create-collision-0001'
    const winnerIds = ['winner_client', 'winner_assignment', 'winner_client_ver',
      'winner_assignment_ver', 'winner_audit', 'winner_key']
    let raced = false
    let usageBeforeRecovery
    let budget
    const rawDb = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch() {
        usageBeforeRecovery = budget.usage()
        if (!raced) {
          raced = true
          await createClient({
            db: env.DB, recoveryDb: env.DB,
            actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
            keyring, nowMs: NOW_MS, correlationId: CORRELATION_ID,
            idFactory: () => winnerIds.shift(), body: BODY, idempotencyKey: key,
          })
        }
        throw new Error('identity_collision: SQLITE_CONSTRAINT')
      },
    }
    budget = createD1QueryBudget(rawDb, { totalLimit: 50, recoveryReserve: 8 })
    const loserIds = ['loser_client', 'loser_assignment', 'loser_client_ver',
      'loser_assignment_ver', 'loser_audit', 'loser_key']
    const result = await createClient({
      db: budget.work, recoveryDb: budget.recovery,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring, nowMs: NOW_MS, correlationId: CORRELATION_ID,
      idFactory: () => loserIds.shift(), body: BODY, idempotencyKey: key,
    })
    expect(result.body.data.client.id).toBe('cl_winner_client')
    expect(usageBeforeRecovery.used).toBe(10)
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery).used).toBe(12)
    expect(await env.DB.prepare("SELECT count(*) AS count FROM clients WHERE id='cl_loser_client'").first())
      .toEqual({ count: 0 })
  })

  it('wires only POST clients through the authenticated shell and preserves future 404s', async () => {
    const create = vi.fn(async () => ({
      status: 201, body: { data: { client: { id: 'cl_shell' } } },
    }))
    const rawDb = {
      prepare() {
        return { bind() { return { first: async () => null } } }
      },
      batch: async () => [],
    }
    const app = createApp({
      config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl', dataMode: 'fictional' },
      db: rawDb,
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      resolveAccessPrincipal: vi.fn(async () => ({
        kind: 'human', subject: 'access-client-shell', normalizedEmail: 'shell@example.test',
      })),
      resolveActor: vi.fn(async () => ({
        id: 'stf_shell', role: 'owner', specialistId: null, version: 1,
      })),
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
      createClient: create,
      now: () => NOW_MS,
    })
    const headers = {
      origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
      'idempotency-key': 'client-create-shell-0001', 'x-csrf-token': 'valid',
    }
    const response = await app.request('/api/v1/clients', {
      method: 'POST', headers, body: JSON.stringify(BODY),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { client: { id: 'cl_shell' } } })
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0].db).not.toBe(rawDb)
    expect(create.mock.calls[0][0].recoveryDb).not.toBe(rawDb)
    expect(usageForD1QueryBudgetViews(
      create.mock.calls[0][0].db, create.mock.calls[0][0].recoveryDb,
    )).toEqual({
      used: 0, remaining: 50, workRemaining: 42, totalLimit: 50, recoveryReserve: 8,
    })

    const future = await app.request('/api/v1/clients/cl_shell/archive', {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: 1 }),
    })
    expect(future.status).toBe(404)
    expect(create).toHaveBeenCalledOnce()
  })

  it('maps semantic create validation to the safe field without touching D1', async () => {
    const prepare = vi.fn()
    const app = createApp({
      config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl', dataMode: 'fictional' },
      db: { prepare, batch: vi.fn() },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      resolveAccessPrincipal: vi.fn(async () => ({
        kind: 'human', subject: 'access-client-invalid', normalizedEmail: 'invalid@example.test',
      })),
      resolveActor: vi.fn(async () => ({
        id: 'stf_shell', role: 'owner', specialistId: null, version: 1,
      })),
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async () => ({ ...BODY, name: ' Fikcyjna' })),
      now: () => NOW_MS,
    })
    const response = await app.request('/api/v1/clients', {
      method: 'POST',
      headers: {
        origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
        'idempotency-key': 'client-create-invalid-0001', 'x-csrf-token': 'valid',
      },
      body: JSON.stringify({ ...BODY, name: ' Fikcyjna' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { field: 'name' } },
    })
    expect(prepare).not.toHaveBeenCalled()
  })
})
