import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  createD1DatabaseFacade,
  createD1RestClient,
  normalizeBootstrapInput,
  runBootstrapOwner,
} from '../../scripts/bootstrap-owner.mjs'
import { inspectBootstrapEntryState } from '../../scripts/bootstrap-core.js'
import { isD1OutboxOperationGuardFailure } from '../../worker/db/errors.js'

const key = (character) => Buffer.alloc(32, character.charCodeAt(0)).toString('base64url')
const baseEnv = () => ({
  APP_ENV: 'staging',
  APP_ORIGIN: 'https://staging.bearwithme-panel.app',
  BOOTSTRAP_OWNER_DISPLAY_NAME: 'Alicja Testowa',
  BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
  BOOTSTRAP_TARGET: 'staging',
  BWM_BACKUP_KEK_V1: key('C'),
  BWM_DATA_KEK_V1: key('A'),
  BWM_LOOKUP_HMAC_V1: key('B'),
  CF_ACCESS_GROUP_ID: '11111111-1111-4111-8111-111111111111',
  CF_ACCESS_GROUP_NAME: 'Bear with me - panel - staging',
  CF_ACCESS_GROUP_TOKEN: 'access-token',
  CF_ACCOUNT_ID: 'a'.repeat(32),
  CF_D1_BOOTSTRAP_TOKEN: 'd1-token',
  CF_D1_DATABASE_ID: '22222222-2222-4222-8222-222222222222',
  DATA_MODE: 'fictional',
})

const okResult = (results = []) => ({
  errors: [],
  messages: [],
  result: [{
    meta: {},
    results,
    success: true,
  }],
  success: true,
})

const EMPTY_BOOTSTRAP_STATES = Object.freeze([
  Object.freeze({
    key: 'access.applied_generation',
    value_json: '{"fingerprint":"BYDlKyUUBNO-3cX7_bRPY-TkArudTPGjIdbwtAdLSCw","generation":0}',
    version: 1,
    updated_at: '2026-07-30T00:00:00.000Z',
  }),
  Object.freeze({
    key: 'access.desired_generation',
    value_json: '{"generation":0}',
    version: 1,
    updated_at: '2026-07-30T00:00:00.000Z',
  }),
  Object.freeze({
    key: 'access.reconcile.lease',
    value_json: '{"expiresAt":null,"nonce":null,"owner":null}',
    version: 1,
    updated_at: '2026-07-30T00:00:00.000Z',
  }),
  Object.freeze({
    key: 'core_directory_specialist_backfill_v1',
    value_json: '{"afterStaffId":null,"createdCount":0,"processedCount":0,"status":"complete"}',
    version: 2,
    updated_at: '2026-07-31T00:00:00.000Z',
  }),
  Object.freeze({
    key: 'outbox.drain.last_success',
    value_json: '{"completedAt":null}',
    version: 1,
    updated_at: '2026-07-31T00:00:00.000Z',
  }),
])

const EMPTY_BOOTSTRAP_AUDITS = Object.freeze([
  Object.freeze({
    action: 'core_directory.upgrade.advanced',
    actor_staff_id: null,
    correlation_id: '00000000-0000-4000-8000-000000000099',
    entity_id: 'core_directory_specialist_backfill_v1',
    entity_type: 'system_state',
    id: 'aud_core_directory_bootstrap_fixture',
    metadata_json: '{"createdCount":0,"processedCount":0,"stateVersion":2}',
    occurred_at: '2026-07-31T00:00:00.000Z',
    reason_envelope: null,
    result: 'success',
  }),
])

const bootstrapEntryDb = (states, audits = EMPTY_BOOTSTRAP_AUDITS) => ({
  prepare: () => ({}),
  batch: async (statements) => statements.map((_, index) => ({
    results: index === 4
      ? structuredClone(audits)
      : index === 7
        ? structuredClone(states)
        : [],
  })),
})

test('bootstrap entry inspection accepts only the fixed core state and heartbeat beside access genesis', async () => {
  const input = {
    db: bootstrapEntryDb(EMPTY_BOOTSTRAP_STATES),
    keyring: {},
    nowMs: Date.parse('2026-07-31T00:05:00.000Z'),
    ownerDisplayName: 'Alicja Testowa',
    ownerEmail: 'owner@example.test',
  }
  assert.deepEqual(await inspectBootstrapEntryState(input), { kind: 'empty' })

  const advanced = structuredClone(EMPTY_BOOTSTRAP_STATES)
  advanced[4] = {
    key: 'outbox.drain.last_success',
    value_json: '{"completedAt":"2026-07-31T00:04:00.000Z"}',
    version: 2,
    updated_at: '2026-07-31T00:04:00.000Z',
  }
  assert.deepEqual(await inspectBootstrapEntryState({
    ...input,
    db: bootstrapEntryDb(advanced),
  }), { kind: 'empty' })

  const malformed = structuredClone(EMPTY_BOOTSTRAP_STATES)
  malformed[4] = { ...malformed[4], value_json: '{"completedAt":null,"extra":true}' }
  assert.deepEqual(await inspectBootstrapEntryState({
    ...input,
    db: bootstrapEntryDb(malformed),
  }), { kind: 'refused' })
  assert.deepEqual(await inspectBootstrapEntryState({
    ...input,
    db: bootstrapEntryDb([...EMPTY_BOOTSTRAP_STATES, {
      key: 'unexpected.state', value_json: '{}', version: 1,
      updated_at: '2026-07-31T00:00:00.000Z',
    }]),
  }), { kind: 'refused' })
  assert.deepEqual(await inspectBootstrapEntryState({
    ...input,
    db: bootstrapEntryDb(EMPTY_BOOTSTRAP_STATES, []),
  }), { kind: 'refused' })
})

test('production is blocked before argv, identity, key, or provider validation', async () => {
  let touched = false
  const result = await runBootstrapOwner({
    argv: ['secret-on-argv'],
    env: {
      APP_ENV: 'production',
      BOOTSTRAP_TARGET: 'not-even-valid',
      BOOTSTRAP_OWNER_EMAIL: 'real@example.com',
    },
    deps: {
      fetch: async () => {
        touched = true
        throw new Error('must not run')
      },
    },
  })

  assert.deepEqual(result, { code: 'BOOTSTRAP_PRODUCTION_BLOCKED', ok: false })
  assert.equal(touched, false)
})

test('production target is blocked even when the application environment is malformed', async () => {
  const result = await runBootstrapOwner({
    argv: [],
    env: { APP_ENV: 'broken', BOOTSTRAP_TARGET: 'production' },
  })
  assert.deepEqual(result, { code: 'BOOTSTRAP_PRODUCTION_BLOCKED', ok: false })
})

test('bootstrap default environment reaches preflight with valid native process variables', async (t) => {
  const env = baseEnv()
  const previous = new Map(Object.keys(env).map((name) => [name, process.env[name]]))
  for (const [name, value] of Object.entries(env)) process.env[name] = value
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  let schemaReads = 0

  const result = await runBootstrapOwner({
    argv: [],
    deps: {
      db: {
        batch: async () => {
          throw new Error('must not mutate')
        },
        prepare: () => {
          throw new Error('must not query')
        },
      },
      inspectSchema: async () => {
        schemaReads += 1
        return { kind: 'refused' }
      },
      keyring: {},
    },
  })

  assert.deepEqual(result, { code: 'BOOTSTRAP_SCHEMA_REFUSED', ok: false })
  assert.equal(schemaReads, 1)
})

test('bootstrap input accepts only the exact staging, fictional, provider-bound shape', () => {
  const normalized = normalizeBootstrapInput(baseEnv(), [])
  assert.equal(normalized.ownerEmail, 'owner@example.test')
  assert.equal(normalized.ownerDisplayName, 'Alicja Testowa')
  assert.equal(normalized.accountId, 'a'.repeat(32))
  assert.equal(normalized.activeDataKekVersion, 1)
  assert.equal(normalized.activeLookupKeyVersion, 1)
  assert.equal(normalized.activeBackupKekVersion, 1)
  assert.equal(Object.isFrozen(normalized), true)

  const stagingOwner = normalizeBootstrapInput({
    ...baseEnv(),
    BOOTSTRAP_OWNER_EMAIL: 'kontakt@bearwithme.pl',
  }, [])
  assert.equal(stagingOwner.ownerEmail, 'kontakt@bearwithme.pl')

  for (const [name, value] of [
    ['APP_ENV', 'development'],
    ['APP_ORIGIN', 'https://bearwithme-panel.app'],
    ['BOOTSTRAP_TARGET', 'staging '],
    ['DATA_MODE', 'real'],
    ['BOOTSTRAP_OWNER_EMAIL', 'Owner@example.test'],
    ['BOOTSTRAP_OWNER_EMAIL', 'owner@example.com'],
    ['BOOTSTRAP_OWNER_EMAIL', 'another@bearwithme-panel.app'],
    ['BOOTSTRAP_OWNER_DISPLAY_NAME', ' Alicja Testowa'],
    ['CF_ACCOUNT_ID', 'A'.repeat(32)],
    ['CF_D1_DATABASE_ID', '22222222-2222-4222-8222-22222222222A'],
    ['CF_ACCESS_GROUP_ID', '11111111-1111-4111-8111-11111111111A'],
    ['CF_D1_BOOTSTRAP_TOKEN', 'access-token'],
    ['BWM_DATA_KEK_V1', 'short'],
  ]) {
    assert.throws(
      () => normalizeBootstrapInput({ ...baseEnv(), [name]: value }, []),
      /^Error: BOOTSTRAP_INPUT_INVALID$/,
      `${name}=${value}`,
    )
  }
  assert.throws(
    () => normalizeBootstrapInput(baseEnv(), ['owner@example.test']),
    /^Error: BOOTSTRAP_INPUT_INVALID$/,
  )
})

test('D1 REST client uses only the exact query URL, Bearer header, and string params', async () => {
  const calls = []
  const env = baseEnv()
  const client = createD1RestClient({
    accountId: env.CF_ACCOUNT_ID,
    databaseId: env.CF_D1_DATABASE_ID,
    token: env.CF_D1_BOOTSTRAP_TOKEN,
    fetch: async (...args) => {
      calls.push(args)
      return new Response(JSON.stringify(okResult([{ value: 'ok' }])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const result = await client.query({
    sql: 'SELECT ? AS value',
    params: ['ok'],
  })
  assert.deepEqual(result, [{ value: 'ok' }])
  assert.equal(calls.length, 1)
  const [url, request] = calls[0]
  assert.equal(
    url,
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_D1_DATABASE_ID}/query`,
  )
  assert.equal(request.method, 'POST')
  assert.equal(request.redirect, 'error')
  assert.deepEqual(Object.fromEntries(new Headers(request.headers)), {
    authorization: 'Bearer d1-token',
    'content-type': 'application/json',
  })
  assert.deepEqual(JSON.parse(request.body), {
    sql: 'SELECT ? AS value',
    params: ['ok'],
  })
  assert.doesNotMatch(request.body, /d1-token|access-token/)

  await assert.rejects(
    client.query({ sql: 'SELECT ?', params: [1] }),
    /^Error: D1_REST_INPUT_INVALID$/,
  )
  await assert.rejects(
    client.query({ sql: 'SELECT ?', params: [null] }),
    /^Error: D1_REST_INPUT_INVALID$/,
  )
})

test('D1 REST client applies the fixed deadline through the injected signal boundary', async () => {
  const controller = new AbortController()
  const deadlines = []
  let requestSignal
  const client = createD1RestClient({
    accountId: 'a'.repeat(32),
    databaseId: '22222222-2222-4222-8222-222222222222',
    token: 'd1-token',
    deadlineSignal: (milliseconds) => {
      deadlines.push(milliseconds)
      return controller.signal
    },
    fetch: async (_url, request) => {
      requestSignal = request.signal
      return Response.json(okResult())
    },
  })

  await client.query({ sql: 'SELECT 1', params: [] })
  assert.deepEqual(deadlines, [15_000])
  assert.equal(requestSignal, controller.signal)
})

test('D1 REST deadline also cancels a response body that stops producing bytes', { timeout: 1_000 }, async () => {
  const controller = new AbortController()
  let cancelCalled = false
  let started
  const bodyStarted = new Promise((resolve) => { started = resolve })
  const client = createD1RestClient({
    accountId: 'a'.repeat(32),
    databaseId: '22222222-2222-4222-8222-222222222222',
    token: 'd1-token',
    deadlineSignal: () => controller.signal,
    fetch: async () => new Response(new ReadableStream({
      cancel() {
        cancelCalled = true
      },
      pull() {
        started()
        return new Promise(() => {})
      },
    })),
  })

  const pending = client.query({ sql: 'SELECT 1', params: [] })
  await bodyStarted
  controller.abort()
  await assert.rejects(pending, /^Error: D1_REST_AMBIGUOUS$/)
  assert.equal(cancelCalled, true)
})

test('D1 REST client reads at most 64 KiB of raw response bytes', async () => {
  const raw = JSON.stringify(okResult())
  const clientFor = (size) => createD1RestClient({
    accountId: 'a'.repeat(32),
    databaseId: '22222222-2222-4222-8222-222222222222',
    token: 'd1-token',
    fetch: async () => new Response(`${raw}${' '.repeat(size - raw.length)}`),
  })

  assert.deepEqual(
    await clientFor(65_536).query({ sql: 'SELECT 1', params: [] }),
    [],
  )
  await assert.rejects(
    clientFor(65_537).query({ sql: 'SELECT 1', params: [] }),
    /^Error: D1_REST_RESPONSE_INVALID$/,
  )
})

test('D1 REST client caps each serialized parameter and the complete JSON request', async () => {
  let calls = 0
  const client = createD1RestClient({
    accountId: 'a'.repeat(32),
    databaseId: '22222222-2222-4222-8222-222222222222',
    token: 'd1-token',
    fetch: async () => {
      calls += 1
      return Response.json(okResult())
    },
  })

  await assert.rejects(
    client.query({ sql: 'SELECT ?', params: ['x'.repeat(16_385)] }),
    /^Error: D1_REST_INPUT_INVALID$/,
  )
  await assert.rejects(
    client.batch(Array.from({ length: 5 }, (_, index) => ({
      sql: `SELECT ? AS value_${index}`,
      params: ['x'.repeat(14_000)],
    }))),
    /^Error: D1_REST_INPUT_INVALID$/,
  )
  assert.equal(calls, 0)
})

test('D1 REST client rejects duplicate JSON keys at every response depth', async () => {
  const duplicateBodies = [
    '{"errors":[],"messages":[],"result":[{"meta":{},"results":[],"success":true}],"success":true,"success":true}',
    '{"errors":[],"messages":[],"result":[{"meta":{},"meta":{},"results":[],"success":true}],"success":true}',
    '{"errors":[],"messages":[],"result":[{"meta":{},"results":[{"value":"one","value":"two"}],"success":true}],"success":true}',
  ]
  for (const body of duplicateBodies) {
    const client = createD1RestClient({
      accountId: 'a'.repeat(32),
      databaseId: '22222222-2222-4222-8222-222222222222',
      token: 'd1-token',
      fetch: async () => new Response(body),
    })
    await assert.rejects(
      client.query({ sql: 'SELECT 1', params: [] }),
      /^Error: D1_REST_RESPONSE_INVALID$/,
    )
  }
})

test('D1 REST client rejects unknown or nested response shapes', async () => {
  const invalidResponses = [
    { ...okResult(), unknown: true },
    {
      ...okResult(),
      result: [{ meta: {}, results: [], success: true, unknown: true }],
    },
    okResult([{ nested: { unsafe: true } }]),
    okResult([{ unsupported: true }]),
    {
      ...okResult(),
      messages: [{ code: 1000, message: 'unexpected' }],
    },
  ]
  for (const response of invalidResponses) {
    const client = createD1RestClient({
      accountId: 'a'.repeat(32),
      databaseId: '22222222-2222-4222-8222-222222222222',
      token: 'd1-token',
      fetch: async () => Response.json(response),
    })
    await assert.rejects(
      client.query({ sql: 'SELECT 1', params: [] }),
      /^Error: D1_REST_RESPONSE_INVALID$/,
    )
  }
})

test('D1 REST client accepts exactly the documented optional query metadata fields', async () => {
  const client = createD1RestClient({
    accountId: 'a'.repeat(32),
    databaseId: '22222222-2222-4222-8222-222222222222',
    token: 'd1-token',
    fetch: async () => Response.json({
      errors: [],
      messages: [],
      result: [{
        meta: {
          changed_db: false,
          changes: 0,
          duration: 0.25,
          last_row_id: 0,
          rows_read: 1,
          rows_written: 0,
          served_by: 'v3-prod',
          served_by_colo: 'WAW',
          served_by_primary: true,
          served_by_region: 'WEUR',
          size_after: 16_384,
          timings: { sql_duration_ms: 0.25 },
          total_attempts: 1,
        },
        results: [{ proof: 'ok' }],
        success: true,
      }],
      success: true,
    }),
  })

  assert.deepEqual(
    await client.query({ sql: 'SELECT 1 AS proof', params: [] }),
    [{ proof: 'ok' }],
  )
})

test('D1 REST batch validates exact result count and every statement result', async () => {
  const responses = [
    {
      errors: [],
      messages: [],
      result: [
        { meta: {}, results: [], success: true },
        { meta: {}, results: [{ proof: 'ok' }], success: true },
      ],
      success: true,
    },
    {
      errors: [],
      messages: [],
      result: [{ meta: {}, results: [], success: true }],
      success: true,
    },
    {
      errors: [],
      messages: [],
      result: [
        { meta: {}, results: [], success: true },
        { meta: {}, results: [], success: false },
      ],
      success: true,
    },
  ]
  const client = createD1RestClient({
    accountId: 'a'.repeat(32),
    databaseId: '22222222-2222-4222-8222-222222222222',
    token: 'd1-token',
    fetch: async () => Response.json(responses.shift()),
  })
  const batch = [
    { sql: 'SELECT ? AS first', params: ['one'] },
    { sql: 'SELECT ? AS proof', params: ['ok'] },
  ]

  assert.deepEqual(await client.batch(batch), [
    [],
    [{ proof: 'ok' }],
  ])
  await assert.rejects(client.batch(batch), /^Error: D1_REST_RESPONSE_INVALID$/)
  await assert.rejects(client.batch(batch), /^Error: D1_REST_RESPONSE_INVALID$/)
})

test('D1 REST maps only the exact outbox guard provider sentinel to the fixed D1 classifier error', async () => {
  const secret = 'provider-detail-must-not-leak'
  const responseFor = (message) => new Response(JSON.stringify({
    errors: [{
      code: 7500,
      message,
    }],
    messages: [],
    result: null,
    success: false,
  }), { status: 400 })
  const clientFor = (message) => createD1RestClient({
    accountId: 'a'.repeat(32),
    databaseId: '22222222-2222-4222-8222-222222222222',
    token: 'd1-token',
    fetch: async () => responseFor(message),
  })

  let guardError
  try {
    await clientFor(
      'D1_ERROR: outbox_operation_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
    ).query({ sql: 'SELECT 1', params: [] })
  } catch (error) {
    guardError = error
  }
  assert.ok(isD1OutboxOperationGuardFailure(guardError))
  assert.equal(
    guardError.message,
    'D1_ERROR: outbox_operation_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
  )

  let otherError
  try {
    await clientFor(
      `D1_ERROR: ${secret}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`,
    ).query({ sql: 'SELECT 1', params: [] })
  } catch (error) {
    otherError = error
  }
  assert.equal(otherError.message, 'D1_REST_REFUSED')
  assert.doesNotMatch(otherError.message, new RegExp(secret))
})

test('D1 REST failures are fixed and never disclose a token or provider body', async () => {
  const secret = 'd1-token-sensitive'
  const bodyMarker = 'raw-provider-diagnostic'
  for (const response of [
    async () => {
      throw new Error(`${secret}:${bodyMarker}`)
    },
    async () => new Response(bodyMarker, { status: 500 }),
    async () => new Response('{', { status: 200 }),
    async () => Response.json({
      errors: [{ code: 9999, message: bodyMarker }],
      messages: [],
      result: [],
      success: false,
    }),
  ]) {
    const client = createD1RestClient({
      accountId: 'a'.repeat(32),
      databaseId: '22222222-2222-4222-8222-222222222222',
      token: secret,
      fetch: response,
    })
    let error
    try {
      await client.query({ sql: 'SELECT 1', params: [] })
    } catch (caught) {
      error = caught
    }
    assert.ok(error)
    assert.match(error.message, /^D1_REST_(?:AMBIGUOUS|REFUSED|RESPONSE_INVALID)$/)
    assert.doesNotMatch(error.message, new RegExp(`${secret}|${bodyMarker}`))
  }
})

test('D1 database facade preserves binding types without rewriting quoted or commented question marks', async () => {
  const calls = []
  const db = createD1DatabaseFacade({
    query: async (statement) => {
      calls.push(statement)
      return [{ nil: null, number: 42.5, text: 'owner' }]
    },
    batch: async () => {
      throw new Error('unexpected batch')
    },
  })
  const sql = `SELECT
    ? AS text,
    ? AS number,
    ? AS nil,
    '?' AS single_quoted,
    "?" AS double_quoted,
    \`?\` AS backtick_quoted,
    [?] AS bracket_quoted
    -- ? line comment
    /* ? block comment */`

  const result = await db.prepare(sql).bind('owner', 42.5, null).all()

  assert.deepEqual(calls, [{
    sql: `SELECT
    json_extract(?, '$') AS text,
    json_extract(?, '$') AS number,
    json_extract(?, '$') AS nil,
    '?' AS single_quoted,
    "?" AS double_quoted,
    \`?\` AS backtick_quoted,
    [?] AS bracket_quoted
    -- ? line comment
    /* ? block comment */`,
    params: ['"owner"', '42.5', 'null'],
  }])
  assert.deepEqual(result, {
    meta: {},
    results: [{ nil: null, number: 42.5, text: 'owner' }],
    success: true,
  })
})

test('D1 database facade follows SQLite quote escaping when a backslash precedes the closing quote', async () => {
  const calls = []
  const db = createD1DatabaseFacade({
    query: async (statement) => {
      calls.push(statement)
      return []
    },
    batch: async () => [],
  })

  await db.prepare(String.raw`SELECT '\' AS slash, ? AS value`).bind('ok').all()
  assert.deepEqual(calls, [{
    params: ['"ok"'],
    sql: String.raw`SELECT '\' AS slash, json_extract(?, '$') AS value`,
  }])
})

test('D1 database facade supports first, run, and an atomic prepared-statement batch', async () => {
  const calls = []
  const db = createD1DatabaseFacade({
    query: async (statement) => {
      calls.push({ kind: 'query', statement })
      return statement.sql.startsWith('SELECT')
        ? [{ value: statement.params[0] }]
        : []
    },
    batch: async (statements) => {
      calls.push({ kind: 'batch', statements })
      return statements.map((_statement, index) => [{ index }])
    },
  })

  assert.deepEqual(
    await db.prepare('SELECT ? AS value').bind('one').first(),
    { value: '"one"' },
  )
  assert.deepEqual(
    await db.prepare('UPDATE fixture SET value=?').bind(2).run(),
    { meta: {}, results: [], success: true },
  )
  assert.deepEqual(await db.batch([
    db.prepare('SELECT ?').bind('one'),
    db.prepare('SELECT ?').bind(null),
  ]), [
    { meta: {}, results: [{ index: 0 }], success: true },
    { meta: {}, results: [{ index: 1 }], success: true },
  ])
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2], {
    kind: 'batch',
    statements: [
      { sql: "SELECT json_extract(?, '$')", params: ['"one"'] },
      { sql: "SELECT json_extract(?, '$')", params: ['null'] },
    ],
  })
})

test('D1 database facade rejects unsupported values, bind count mismatch, and malformed SQL', async () => {
  const db = createD1DatabaseFacade({
    query: async () => [],
    batch: async () => [],
  })

  for (const value of [true, false, {}, [], Number.NaN, Infinity, -Infinity, undefined, 1n]) {
    assert.throws(
      () => db.prepare('SELECT ?').bind(value),
      /^Error: D1_FACADE_INPUT_INVALID$/,
    )
  }
  assert.throws(
    () => db.prepare('SELECT ?, ?').bind('only-one'),
    /^Error: D1_FACADE_INPUT_INVALID$/,
  )
  assert.throws(
    () => db.prepare('SELECT 1').bind('extra'),
    /^Error: D1_FACADE_INPUT_INVALID$/,
  )
  for (const sql of [
    "SELECT 'unterminated",
    'SELECT /* unterminated',
    'SELECT ?1',
  ]) {
    assert.throws(
      () => db.prepare(sql),
      /^Error: D1_FACADE_INPUT_INVALID$/,
    )
  }
  await assert.rejects(
    db.batch([{ sql: 'SELECT 1', params: [] }]),
    /^Error: D1_FACADE_INPUT_INVALID$/,
  )
})

test('orchestration preflights before IDs and rereads exactly once after every creation error', async () => {
  const errors = [
    ['D1_REST_AMBIGUOUS', 'BOOTSTRAP_STATE_REFUSED'],
    ['D1_REST_REFUSED', 'BOOTSTRAP_FAILED'],
    ['D1_REST_RESPONSE_INVALID', 'BOOTSTRAP_FAILED'],
    ['D1_FACADE_INPUT_INVALID', 'BOOTSTRAP_FAILED'],
    [
      'D1_ERROR: outbox_operation_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
      'BOOTSTRAP_STATE_REFUSED',
    ],
  ]
  for (const [message, expectedCode] of errors) {
    const events = []
    let batchCalls = 0
    let aggregateReads = 0
    let targetCalls = 0
    const statement = {
      bind() {
        return this
      },
    }
    const result = await runBootstrapOwner({
      argv: [],
      env: baseEnv(),
      deps: {
        buildCreationBatch: async (input) => {
          events.push('build')
          input.idFactory()
          return { batch: [{ params: [], sql: 'SELECT 1' }] }
        },
        correlationIdFactory: () => {
          events.push('correlation')
          return '90000000-0000-4000-8000-000000000001'
        },
        db: {
          async batch() {
            events.push('create')
            batchCalls += 1
            throw new Error(message)
          },
          prepare() {
            return statement
          },
        },
        idFactory: () => {
          events.push('id')
          return 'opaque_id'
        },
        inspectAggregate: async () => {
          events.push('aggregate')
          aggregateReads += 1
          return { kind: 'refused' }
        },
        inspectEntryState: async () => {
          events.push('entry')
          return { kind: 'empty' }
        },
        inspectSchema: async () => {
          events.push('schema')
          return { kind: 'ready' }
        },
        keyring: {},
        now: () => {
          events.push('now')
          return 1_800_000_000_000
        },
        processTarget: async () => {
          targetCalls += 1
          throw new Error('must not run')
        },
      },
    })

    assert.deepEqual(result, { code: expectedCode, ok: false }, message)
    assert.deepEqual(
      events,
      [
        'schema',
        'now',
        'entry',
        'correlation',
        'build',
        'id',
        'create',
        'now',
        'aggregate',
      ],
      message,
    )
    assert.equal(batchCalls, 1, message)
    assert.equal(aggregateReads, 1, message)
    assert.equal(targetCalls, 0, message)
  }
})

test('orchestration rejects a malformed final creation proof after one exact reread', async () => {
  let aggregateReads = 0
  let creationCalls = 0
  const proof = {
    audit_id: 'audit',
    data_key_id: 'key',
    expiry_job_id: 'expiry',
    invitation_id: 'invitation',
    invitation_version_id: 'invitation_version',
    reconcile_job_id: 'reconcile',
    staff_id: 'staff',
    staff_version_id: 'staff_version',
    state: 'pre-reconcile',
  }
  const statement = {
    bind() {
      return this
    },
  }
  const result = await runBootstrapOwner({
    argv: [],
    env: baseEnv(),
    deps: {
      buildCreationBatch: async () => ({
        batch: [{ params: [], sql: 'SELECT 1' }],
        proof,
      }),
      correlationIdFactory: () => 'a0000000-0000-4000-8000-000000000001',
      db: {
        async batch() {
          creationCalls += 1
          return [{
            extra: true,
            meta: {},
            results: [proof],
            success: true,
          }]
        },
        prepare() {
          return statement
        },
      },
      inspectAggregate: async () => {
        aggregateReads += 1
        return { kind: 'refused' }
      },
      inspectEntryState: async () => ({ kind: 'empty' }),
      inspectSchema: async () => ({ kind: 'ready' }),
      keyring: {},
      now: () => 1_800_000_000_000,
    },
  })

  assert.deepEqual(result, { code: 'BOOTSTRAP_FAILED', ok: false })
  assert.equal(creationCalls, 1)
  assert.equal(aggregateReads, 1)
})

test('orchestration reports retry-required for an exact target that is not yet due', async () => {
  const ids = {
    auditId: 'audit',
    dataKeyId: 'key',
    expiryJobId: 'expiry',
    invitationId: 'invitation',
    invitationVersionId: 'invitation_version',
    reconcileJobId: 'reconcile',
    staffId: 'staff',
    staffVersionId: 'staff_version',
  }
  let aggregateReads = 0
  let targetCalls = 0
  const prepared = {
    bind() {
      return this
    },
    async first() {
      return { id: ids.dataKeyId }
    },
  }
  const result = await runBootstrapOwner({
    argv: [],
    env: baseEnv(),
    deps: {
      db: {
        async batch() {
          throw new Error('must not create')
        },
        prepare() {
          return prepared
        },
      },
      inspectAggregate: async () => {
        aggregateReads += 1
        return { ids, kind: 'pre-reconcile', reconcileState: 'queued-retry' }
      },
      inspectEntryState: async () => ({
        ids,
        kind: 'pre-reconcile',
        reconcileState: 'queued-retry',
      }),
      inspectSchema: async () => ({ kind: 'ready' }),
      keyring: {},
      now: () => 1_800_000_000_000,
      processTarget: async () => {
        targetCalls += 1
        return { jobId: ids.reconcileJobId, result: 'retry' }
      },
    },
  })

  assert.deepEqual(result, {
    code: 'BOOTSTRAP_RETRY_REQUIRED',
    ids,
    ok: false,
  })
  assert.equal(aggregateReads, 1)
  assert.equal(targetCalls, 1)
})

test('targeted mutation errors always trigger one exact reread without a resend', async () => {
  const ids = {
    auditId: 'audit',
    dataKeyId: 'key',
    expiryJobId: 'expiry',
    invitationId: 'invitation',
    invitationVersionId: 'invitation_version',
    reconcileJobId: 'reconcile',
    staffId: 'staff',
    staffVersionId: 'staff_version',
  }
  for (const [message, expectedCode] of [
    ['D1_REST_AMBIGUOUS', 'BOOTSTRAP_RETRY_REQUIRED'],
    ['D1_REST_REFUSED', 'BOOTSTRAP_FAILED'],
    ['D1_REST_RESPONSE_INVALID', 'BOOTSTRAP_FAILED'],
    ['D1_FACADE_INPUT_INVALID', 'BOOTSTRAP_FAILED'],
  ]) {
    let aggregateReads = 0
    let createCalls = 0
    const prepared = {
      bind() {
        return this
      },
      async first() {
        return { id: ids.dataKeyId }
      },
    }
    const result = await runBootstrapOwner({
      argv: [],
      env: baseEnv(),
      deps: {
        db: {
          async batch() {
            createCalls += 1
            throw new Error('must not create')
          },
          prepare() {
            return prepared
          },
        },
        inspectAggregate: async () => {
          aggregateReads += 1
          return { ids, kind: 'pre-reconcile', reconcileState: 'queued-retry' }
        },
        inspectEntryState: async () => ({
          ids,
          kind: 'pre-reconcile',
          reconcileState: 'queued-retry',
        }),
        inspectSchema: async () => ({ kind: 'ready' }),
        keyring: {},
        now: () => 1_800_000_000_000,
        processTarget: async () => {
          throw new Error(message)
        },
      },
    })

    assert.equal(result.code, expectedCode, message)
    assert.equal(aggregateReads, 1, message)
    assert.equal(createCalls, 0, message)
  }
})

test('post-creation recovery samples a fresh clock before accepting concurrent state', async () => {
  const ids = {
    auditId: 'audit',
    dataKeyId: 'key',
    expiryJobId: 'expiry',
    invitationId: 'invitation',
    invitationVersionId: 'invitation_version',
    reconcileJobId: 'reconcile',
    staffId: 'staff',
    staffVersionId: 'staff_version',
  }
  const clock = [1_800_000_000_000, 1_800_000_001_000, 1_800_000_002_000, 1_800_000_003_000]
  const aggregateTimes = []
  const statement = {
    bind() {
      return this
    },
    async first() {
      return { id: ids.dataKeyId }
    },
  }
  const result = await runBootstrapOwner({
    argv: [],
    env: baseEnv(),
    deps: {
      buildCreationBatch: async () => ({
        batch: [{ params: [], sql: 'SELECT 1' }],
      }),
      correlationIdFactory: () => 'b0000000-0000-4000-8000-000000000001',
      db: {
        async batch() {
          throw new Error('D1_REST_AMBIGUOUS')
        },
        prepare() {
          return statement
        },
      },
      inspectAggregate: async ({ nowMs }) => {
        aggregateTimes.push(nowMs)
        return { ids, kind: 'pre-reconcile', reconcileState: 'queued-initial' }
      },
      inspectEntryState: async () => ({ kind: 'empty' }),
      inspectSchema: async () => ({ kind: 'ready' }),
      keyring: {},
      now: () => clock.shift(),
      processTarget: async () => ({ jobId: ids.reconcileJobId, result: 'retry' }),
    },
  })

  assert.deepEqual(result, {
    code: 'BOOTSTRAP_RETRY_REQUIRED',
    ids,
    ok: false,
  })
  assert.deepEqual(aggregateTimes, [
    1_800_000_001_000,
    1_800_000_003_000,
  ])
})

test('CLI import is inert and noninteractive failures print one fixed code only', () => {
  const minimalEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
  }
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "await import('./scripts/bootstrap-owner.mjs')"],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: minimalEnv,
    },
  )
  assert.equal(imported.status, 0)
  assert.equal(imported.stdout, '')
  assert.equal(imported.stderr, '')

  const marker = 'must-not-echo-this-owner-secret'
  const blocked = spawnSync(process.execPath, ['scripts/bootstrap-owner.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...minimalEnv,
      APP_ENV: 'production',
      BOOTSTRAP_OWNER_DISPLAY_NAME: marker,
      BOOTSTRAP_TARGET: 'production',
    },
  })
  assert.equal(blocked.status, 1)
  assert.equal(blocked.stdout, 'BOOTSTRAP_PRODUCTION_BLOCKED\n')
  assert.equal(blocked.stderr, '')
  assert.doesNotMatch(`${blocked.stdout}${blocked.stderr}`, new RegExp(marker))

  const missing = spawnSync(process.execPath, ['scripts/bootstrap-owner.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: minimalEnv,
  })
  assert.equal(missing.status, 1)
  assert.equal(missing.stdout, 'BOOTSTRAP_INPUT_INVALID\n')
  assert.equal(missing.stderr, '')
})
