import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  LOCAL_SEED_MANIFEST,
  normalizeLocalSeedInput,
  runLocalSeed,
} from '../../scripts/seed-local.mjs'
import {
  inspectLocalSeedState,
  LOCAL_SEED_MANIFEST as CORE_LOCAL_SEED_MANIFEST,
  LOCAL_SEED_SNAPSHOT_QUERIES,
} from '../../scripts/seed-core.js'
import {
  buildLocalHarnessWranglerConfig,
  LOCAL_HARNESS_MIGRATIONS_NAME,
  LOCAL_HARNESS_RUNNER_MODE,
  LOCAL_HARNESS_WRANGLER_NAME,
} from '../../scripts/local-harness-core.js'

const key = (character) => Buffer.alloc(32, character.charCodeAt(0)).toString('base64url')
const MIGRATION_STATES = [
  {
    key: 'access.applied_generation',
    updated_at: '2026-07-30T00:00:00.000Z',
    value_json: '{"fingerprint":"BYDlKyUUBNO-3cX7_bRPY-TkArudTPGjIdbwtAdLSCw","generation":0}',
    version: 1,
  },
  {
    key: 'access.desired_generation',
    updated_at: '2026-07-30T00:00:00.000Z',
    value_json: '{"generation":0}',
    version: 1,
  },
  {
    key: 'access.reconcile.lease',
    updated_at: '2026-07-30T00:00:00.000Z',
    value_json: '{"expiresAt":null,"nonce":null,"owner":null}',
    version: 1,
  },
  {
    key: 'core_directory_specialist_backfill_v1',
    updated_at: '2026-08-03T12:34:56.789Z',
    value_json: '{"afterStaffId":null,"createdCount":0,"processedCount":0,"status":"pending"}',
    version: 1,
  },
  {
    key: 'outbox.drain.last_success',
    updated_at: '2026-08-03T12:34:56.789Z',
    value_json: '{"completedAt":null}',
    version: 1,
  },
]
const stateSnapshotDb = (states) => {
  const queries = new WeakMap()
  return {
    async batch(statements) {
      return statements.map((statement) => ({
        results: queries.get(statement) === 'SELECT * FROM system_state ORDER BY key'
          ? structuredClone(states)
          : [],
      }))
    },
    prepare(sql) {
      assert.ok(LOCAL_SEED_SNAPSHOT_QUERIES.includes(sql))
      const statement = Object.freeze({})
      queries.set(statement, sql)
      return statement
    },
  }
}
const makeDirectory = (t) => {
  const path = mkdtempSync(join(tmpdir(), 'bwm-seed-test-'))
  t.after(() => rmSync(path, { force: true, recursive: true }))
  return realpathSync(path)
}
const baseEnv = (path) => ({
  APP_ENV: 'development',
  BWM_BACKUP_KEK_V1: key('C'),
  BWM_DATA_KEK_V1: key('A'),
  BWM_LOCAL_PERSISTENCE_PATH: path,
  BWM_LOOKUP_HMAC_V1: key('B'),
  DATA_MODE: 'fictional',
})
const runnerEnv = (t) => {
  const root = makeDirectory(t)
  const migrations = join(root, LOCAL_HARNESS_MIGRATIONS_NAME)
  const state = join(root, 'state')
  mkdirSync(migrations, { mode: 0o700 })
  mkdirSync(state, { mode: 0o700 })
  writeFileSync(
    join(root, LOCAL_HARNESS_WRANGLER_NAME),
    buildLocalHarnessWranglerConfig(realpathSync(resolve('.')), realpathSync(migrations)),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )
  return {
    ...baseEnv(realpathSync(state)),
    BWM_LOCAL_RUNNER_MODE: LOCAL_HARNESS_RUNNER_MODE,
  }
}

test('local seed manifest owns exactly three deterministic fictional identities', () => {
  assert.equal(LOCAL_SEED_MANIFEST, CORE_LOCAL_SEED_MANIFEST)
  assert.deepEqual(
    LOCAL_SEED_MANIFEST.staff.map(({ email, role }) => ({ email, role })),
    [
      { email: 'coordinator@example.test', role: 'coordinator' },
      { email: 'owner@example.test', role: 'owner' },
      { email: 'specialist@example.test', role: 'specialist' },
    ],
  )
  assert.equal(new Set(LOCAL_SEED_MANIFEST.staff.map(({ id }) => id)).size, 3)
  assert.equal(
    LOCAL_SEED_MANIFEST.staff.find(({ role }) => role === 'specialist').specialistId,
    'sp_local_specialist',
  )
  assert.equal(Object.isFrozen(LOCAL_SEED_MANIFEST), true)
})

test('local seed recognizes only the exact five-row stage-A migration baseline', async (t) => {
  assert.deepEqual(await inspectLocalSeedState({
    db: stateSnapshotDb(MIGRATION_STATES),
    keyring: {},
  }), { kind: 'empty' })

  const cases = [
    ['missing heartbeat', (states) => { states.pop() }],
    ['extra state', (states) => {
      states.push({
        key: 'unexpected.state',
        updated_at: '2026-08-03T12:34:56.789Z',
        value_json: '{}',
        version: 1,
      })
    }],
    ['mutated heartbeat value', (states) => {
      states[4].value_json = '{"completedAt":null,"extra":true}'
    }],
    ['mutated heartbeat version', (states) => { states[4].version = 2 }],
    ['noncanonical heartbeat timestamp', (states) => {
      states[4].updated_at = '2026-08-03T12:34:56Z'
    }],
    ['impossible heartbeat timestamp', (states) => {
      states[4].updated_at = '2026-02-30T12:34:56.789Z'
    }],
    ['extra heartbeat field', (states) => { states[4].extra = true }],
    ['mutated upgrade state', (states) => {
      states[3].value_json = '{"afterStaffId":null,"createdCount":0,"processedCount":0,"status":"complete"}'
    }],
    ['mutated access genesis', (states) => { states[1].value_json = '{"generation":1}' }],
  ]
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const states = structuredClone(MIGRATION_STATES)
      mutate(states)
      assert.deepEqual(await inspectLocalSeedState({
        db: stateSnapshotDb(states),
        keyring: {},
      }), { kind: 'refused' })
    })
  }
})

test('local seed validates exact environment, argv, canonical absolute directory, and keys', (t) => {
  const path = makeDirectory(t)
  const normalized = normalizeLocalSeedInput(baseEnv(path), [])
  assert.equal(normalized.persistencePath, resolve(path))
  assert.equal(normalized.appEnv, 'development')
  assert.equal(Object.isFrozen(normalized), true)

  for (const [name, value] of [
    ['APP_ENV', 'staging'],
    ['DATA_MODE', 'real'],
    ['BWM_LOCAL_PERSISTENCE_PATH', 'relative/path'],
    ['BWM_DATA_KEK_V1', 'short'],
  ]) {
    assert.throws(
      () => normalizeLocalSeedInput({ ...baseEnv(path), [name]: value }, []),
      /^Error: SEED_LOCAL_INPUT_INVALID$/,
    )
  }
  assert.throws(
    () => normalizeLocalSeedInput(baseEnv(path), ['--remote']),
    /^Error: SEED_LOCAL_INPUT_INVALID$/,
  )
})

test('runner-mode seed accepts only the exact private Wrangler config and mode', (t) => {
  const env = runnerEnv(t)
  const normalized = normalizeLocalSeedInput(env, [])
  assert.equal(normalized.runnerMode, true)
  assert.equal(
    normalized.wranglerConfigPath,
    join(dirname(env.BWM_LOCAL_PERSISTENCE_PATH), LOCAL_HARNESS_WRANGLER_NAME),
  )

  assert.throws(
    () => normalizeLocalSeedInput({ ...env, BWM_LOCAL_RUNNER_MODE: 'wrong' }, []),
    /^Error: SEED_LOCAL_INPUT_INVALID$/,
  )
  writeFileSync(normalized.wranglerConfigPath, '{}', { encoding: 'utf8' })
  assert.throws(
    () => normalizeLocalSeedInput(env, []),
    /^Error: SEED_LOCAL_INPUT_INVALID$/,
  )
})

test('runner-mode seed refuses a private config symlink to a FIFO without following it', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
  timeout: 2_000,
}, (t) => {
  const env = runnerEnv(t)
  const configPath = join(
    dirname(env.BWM_LOCAL_PERSISTENCE_PATH),
    LOCAL_HARNESS_WRANGLER_NAME,
  )
  const fifoPath = join(dirname(configPath), 'hostile-config.fifo')
  rmSync(configPath)
  const created = spawnSync('mkfifo', [fifoPath], {
    encoding: 'utf8',
    timeout: 500,
  })
  assert.equal(created.status, 0, created.stderr || created.error?.message)
  symlinkSync(fifoPath, configPath)

  const moduleUrl = pathToFileURL(
    join(realpathSync(resolve('.')), 'scripts', 'seed-local.mjs'),
  ).href
  const source = `
    const { normalizeLocalSeedInput } = await import(${JSON.stringify(moduleUrl)})
    try {
      normalizeLocalSeedInput(${JSON.stringify(env)}, [])
      process.exitCode = 2
    } catch (error) {
      if (error?.message !== 'SEED_LOCAL_INPUT_INVALID') process.exitCode = 3
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    timeout: 500,
  })

  assert.equal(
    result.status,
    0,
    result.error?.message ?? result.stderr,
  )
})

test('runner-mode seed refuses a config swapped to a FIFO at the descriptor open boundary', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
  timeout: 2_000,
}, (t) => {
  const env = runnerEnv(t)
  const configPath = join(
    dirname(env.BWM_LOCAL_PERSISTENCE_PATH),
    LOCAL_HARNESS_WRANGLER_NAME,
  )
  const movedPath = join(dirname(configPath), 'pre-open-wrangler.json')
  const oldAccessMs = 4_000
  const moduleUrl = pathToFileURL(
    join(realpathSync(resolve('.')), 'scripts', 'seed-local.mjs'),
  ).href
  const source = `
    import fs from 'node:fs'
    import { spawnSync } from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'

    const configPath = ${JSON.stringify(configPath)}
    const movedPath = ${JSON.stringify(movedPath)}
    const originalOpen = fs.openSync
    let sawNonblock = false
    let swapped = false
    fs.openSync = (path, flags, ...rest) => {
      if (!swapped && path === configPath) {
        swapped = true
        sawNonblock = (flags & fs.constants.O_NONBLOCK) === fs.constants.O_NONBLOCK
        fs.renameSync(configPath, movedPath)
        const fifo = spawnSync('mkfifo', [configPath], {
          encoding: 'utf8',
          timeout: 500,
        })
        if (fifo.status !== 0) throw new Error('FIFO_CREATE_FAILED')
        fs.chmodSync(configPath, 0o600)
        fs.utimesSync(configPath, new Date(${oldAccessMs}), new Date())
      }
      return originalOpen(path, flags, ...rest)
    }
    syncBuiltinESMExports()

    const { runLocalSeed } = await import(${JSON.stringify(moduleUrl)})
    let crypto = 0
    let spawns = 0
    const deps = {
      runWrangler: async () => {
        spawns += 1
      },
    }
    Object.defineProperty(deps, 'keyring', {
      get() {
        crypto += 1
        return {}
      },
    })
    const result = await runLocalSeed({
      argv: [],
      env: ${JSON.stringify(env)},
      deps,
    })
    const atimeMs = fs.statSync(configPath).atimeMs
    if (!swapped
      || !sawNonblock
      || result.code !== 'SEED_LOCAL_INPUT_INVALID'
      || result.ok !== false
      || crypto !== 0
      || spawns !== 0
      || atimeMs !== ${oldAccessMs}) process.exitCode = 2
    else process.stdout.write('SWAPPED_FIFO_REFUSED\\n')
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    timeout: 500,
  })

  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  assert.equal(result.stdout, 'SWAPPED_FIFO_REFUSED\n')
})

test('runner-mode seed refuses a direct private config FIFO without reading or starting work', async (t) => {
  const env = runnerEnv(t)
  const configPath = join(
    dirname(env.BWM_LOCAL_PERSISTENCE_PATH),
    LOCAL_HARNESS_WRANGLER_NAME,
  )
  rmSync(configPath)
  const created = spawnSync('mkfifo', [configPath], {
    encoding: 'utf8',
    timeout: 500,
  })
  assert.equal(created.status, 0, created.stderr || created.error?.message)
  chmodSync(configPath, 0o600)
  const oldAccess = new Date(5_000)
  utimesSync(configPath, oldAccess, new Date())
  let crypto = 0
  let spawns = 0
  const deps = {
    runWrangler: async () => {
      spawns += 1
    },
  }
  Object.defineProperty(deps, 'keyring', {
    get() {
      crypto += 1
      return {}
    },
  })

  const result = await runLocalSeed({ argv: [], env, deps })

  assert.deepEqual(result, { code: 'SEED_LOCAL_INPUT_INVALID', ok: false })
  assert.equal(statSync(configPath).atimeMs, oldAccess.getTime())
  assert.equal(crypto, 0)
  assert.equal(spawns, 0)
})

test('runner-mode seed rejects an oversized private config before reading it or spawning', async (t) => {
  const env = runnerEnv(t)
  const configPath = join(
    dirname(env.BWM_LOCAL_PERSISTENCE_PATH),
    LOCAL_HARNESS_WRANGLER_NAME,
  )
  const expected = Buffer.from(
    buildLocalHarnessWranglerConfig(
      realpathSync(resolve('.')),
      join(dirname(configPath), LOCAL_HARNESS_MIGRATIONS_NAME),
    ),
    'utf8',
  )
  writeFileSync(configPath, Buffer.concat([expected, Buffer.from('x')]))
  const oldAccess = new Date(1_000)
  utimesSync(configPath, oldAccess, new Date())
  let spawns = 0

  const result = await runLocalSeed({
    argv: [],
    env,
    deps: {
      runWrangler: async () => {
        spawns += 1
      },
    },
  })

  assert.deepEqual(result, { code: 'SEED_LOCAL_INPUT_INVALID', ok: false })
  assert.equal(statSync(configPath).atimeMs, oldAccess.getTime())
  assert.equal(spawns, 0)
})

test('runner-mode seed refuses a same-inode private config expansion without reading it', async (t) => {
  const env = runnerEnv(t)
  const configPath = join(
    dirname(env.BWM_LOCAL_PERSISTENCE_PATH),
    LOCAL_HARNESS_WRANGLER_NAME,
  )
  const original = statSync(configPath)
  const oldAccess = new Date(2_000)
  let spawns = 0

  const result = await runLocalSeed({
    argv: [],
    env,
    deps: {
      inspectState: async () => {
        appendFileSync(configPath, 'x')
        utimesSync(configPath, oldAccess, new Date())
        return { kind: 'empty' }
      },
      keyring: {},
      runWrangler: async () => {
        spawns += 1
      },
    },
  })

  const final = statSync(configPath)
  assert.deepEqual(result, { code: 'SEED_LOCAL_FAILED', ok: false })
  assert.equal(final.ino, original.ino)
  assert.equal(final.atimeMs, oldAccess.getTime())
  assert.equal(spawns, 0)
})

test('runner-mode seed refuses a byte-identical private config inode replacement without reading it', async (t) => {
  const env = runnerEnv(t)
  const configPath = join(
    dirname(env.BWM_LOCAL_PERSISTENCE_PATH),
    LOCAL_HARNESS_WRANGLER_NAME,
  )
  const movedPath = join(dirname(configPath), 'moved-wrangler.json')
  const original = statSync(configPath)
  const oldAccess = new Date(3_000)
  let spawns = 0

  const result = await runLocalSeed({
    argv: [],
    env,
    deps: {
      inspectState: async () => {
        renameSync(configPath, movedPath)
        writeFileSync(
          configPath,
          buildLocalHarnessWranglerConfig(
            realpathSync(resolve('.')),
            join(dirname(configPath), LOCAL_HARNESS_MIGRATIONS_NAME),
          ),
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        )
        utimesSync(configPath, oldAccess, new Date())
        return { kind: 'empty' }
      },
      keyring: {},
      runWrangler: async () => {
        spawns += 1
      },
    },
  })

  const replacement = statSync(configPath)
  assert.deepEqual(result, { code: 'SEED_LOCAL_FAILED', ok: false })
  assert.notEqual(replacement.ino, original.ino)
  assert.equal(replacement.atimeMs, oldAccess.getTime())
  assert.equal(spawns, 0)
})

test('runner-mode seed uses the private config and keeps Wrangler in its parent process group', async (t) => {
  const env = runnerEnv(t)
  const spawns = []
  const result = await runLocalSeed({
    argv: [],
    env,
    deps: {
      inspectFinalState: async () => ({ kind: 'seeded' }),
      inspectState: async () => ({ kind: 'empty' }),
      removeFile: async () => {},
      runWrangler: async (input, options) => {
        spawns.push({ input, options })
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify(Array.from({ length: 8 }, () => ({
            meta: { duration: 0 },
            results: [],
            success: true,
          }))),
        }
      },
      writeTempSql: async () => join(env.BWM_LOCAL_PERSISTENCE_PATH, 'seed.sql'),
    },
  })

  assert.deepEqual(result, { code: 'SEED_LOCAL_COMPLETE', ok: true })
  assert.equal(spawns.length, 1)
  const configIndex = spawns[0].input.args.indexOf('--config')
  assert.equal(
    spawns[0].input.args[configIndex + 1],
    join(dirname(env.BWM_LOCAL_PERSISTENCE_PATH), LOCAL_HARNESS_WRANGLER_NAME),
  )
  assert.deepEqual(spawns[0].options, { detached: false })
})

test('runner-mode seed rechecks private config bytes after final inspection', async (t) => {
  const env = runnerEnv(t)
  const configPath = join(
    dirname(env.BWM_LOCAL_PERSISTENCE_PATH),
    LOCAL_HARNESS_WRANGLER_NAME,
  )
  const result = await runLocalSeed({
    argv: [],
    env,
    deps: {
      inspectFinalState: async () => {
        writeFileSync(configPath, '{}', { encoding: 'utf8' })
        return { kind: 'seeded' }
      },
      inspectState: async () => ({ kind: 'empty' }),
      removeFile: async () => {},
      runWrangler: async () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify(Array.from({ length: 8 }, () => ({
          meta: { duration: 0 },
          results: [],
          success: true,
        }))),
      }),
      writeTempSql: async () => join(env.BWM_LOCAL_PERSISTENCE_PATH, 'seed.sql'),
    },
  })

  assert.deepEqual(result, { code: 'SEED_LOCAL_FAILED', ok: false })
})

test('local seed rejects symlinked and non-directory persistence paths', (t) => {
  const root = makeDirectory(t)
  const target = join(root, 'target')
  const link = join(root, 'linked')
  const missing = join(root, 'missing')
  mkdirSync(target)
  symlinkSync(target, link)
  assert.throws(
    () => normalizeLocalSeedInput(baseEnv(link), []),
    /^Error: SEED_LOCAL_INPUT_INVALID$/,
  )
  assert.throws(
    () => normalizeLocalSeedInput(baseEnv(missing), []),
    /^Error: SEED_LOCAL_INPUT_INVALID$/,
  )
})

test('local seed requires a private mode-0700 persistence directory', (t) => {
  const path = makeDirectory(t)
  chmodSync(path, 0o755)
  assert.throws(
    () => normalizeLocalSeedInput(baseEnv(path), []),
    /^Error: SEED_LOCAL_INPUT_INVALID$/,
  )
})

test('local seed writes a mode-0600 ciphertext-only SQL file, passes a minimal child env, and deletes it', async (t) => {
  const path = makeDirectory(t)
  const writes = []
  const removals = []
  const spawns = []
  const result = await runLocalSeed({
    argv: [],
    env: baseEnv(path),
    deps: {
      inspectState: async () => ({ kind: 'empty' }),
      writeTempSql: async (input) => {
        writes.push(input)
        return join(path, 'seed.sql')
      },
      removeFile: async (file) => {
        removals.push(file)
      },
      runWrangler: async (input) => {
        spawns.push(input)
        return {
          code: 0,
          stdout: JSON.stringify(Array.from({ length: 8 }, () => ({
            meta: { duration: 0 },
            results: [],
            success: true,
          }))),
          stderr: '',
        }
      },
      inspectFinalState: async () => ({ kind: 'seeded' }),
    },
  })

  assert.equal(result.code, 'SEED_LOCAL_COMPLETE')
  assert.equal(result.ok, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].mode, 0o600)
  assert.equal(typeof writes[0].contents, 'string')
  for (const forbidden of [
    'owner@example.test',
    'coordinator@example.test',
    'specialist@example.test',
    ...LOCAL_SEED_MANIFEST.staff.map(({ displayName }) => displayName),
    baseEnv(path).BWM_DATA_KEK_V1,
    baseEnv(path).BWM_LOOKUP_HMAC_V1,
    baseEnv(path).BWM_BACKUP_KEK_V1,
  ]) {
    assert.doesNotMatch(writes[0].contents, new RegExp(forbidden))
  }
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].shell, false)
  assert.equal(spawns[0].executable, realpathSync(process.execPath))
  assert.equal(spawns[0].cwd, path)
  assert.match(spawns[0].args[0], /node_modules\/wrangler\/bin\/wrangler\.js$/)
  assert.deepEqual(spawns[0].args.slice(-2), ['--file', join(path, 'seed.sql')])
  for (const required of [
    '--config',
    '--install-skills=false',
    '--local',
    '--persist-to',
    '--x-auto-create=false',
    '--x-provision=false',
  ]) assert.ok(spawns[0].args.includes(required), required)
  assert.equal(Object.hasOwn(spawns[0].env, 'BWM_DATA_KEK_V1'), false)
  assert.equal(Object.hasOwn(spawns[0].env, 'CF_API_TOKEN'), false)
  assert.equal(Object.hasOwn(spawns[0].env, 'PATH'), false)
  assert.equal(spawns[0].env.HOME, path)
  assert.equal(spawns[0].env.XDG_CONFIG_HOME, path)
  assert.equal(spawns[0].env.CLOUDFLARE_INCLUDE_PROCESS_ENV, 'false')
  assert.equal(spawns[0].env.CLOUDFLARE_CF_FETCH_ENABLED, 'false')
  assert.equal(spawns[0].env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, 'false')
  assert.equal(spawns[0].env.WRANGLER_HIDE_BANNER, 'true')
  assert.equal(spawns[0].env.WRANGLER_SEND_METRICS, 'false')
  assert.deepEqual(removals, [join(path, 'seed.sql')])
})

test('local seed deletes temporary SQL after Wrangler failure and emits no identity or secret', async (t) => {
  const path = makeDirectory(t)
  const removed = []
  const secret = baseEnv(path).BWM_DATA_KEK_V1
  const result = await runLocalSeed({
    argv: [],
    env: baseEnv(path),
    deps: {
      inspectState: async () => ({ kind: 'empty' }),
      writeTempSql: async () => join(path, 'seed.sql'),
      removeFile: async (file) => removed.push(file),
      runWrangler: async () => {
        throw new Error(`owner@example.test ${secret}`)
      },
    },
  })
  assert.deepEqual(result, { code: 'SEED_LOCAL_FAILED', ok: false })
  assert.deepEqual(removed, [join(path, 'seed.sql')])
  assert.doesNotMatch(JSON.stringify(result), /owner@example\.test/)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
})

test('local seed is a no-op only for the exact manifest and refuses partial state', async (t) => {
  const path = makeDirectory(t)
  let spawned = 0
  const already = await runLocalSeed({
    argv: [],
    env: baseEnv(path),
    deps: {
      inspectState: async () => ({ kind: 'seeded' }),
      runWrangler: async () => {
        spawned += 1
      },
    },
  })
  assert.deepEqual(already, { code: 'SEED_LOCAL_ALREADY_COMPLETE', ok: true })
  assert.equal(spawned, 0)

  const refused = await runLocalSeed({
    argv: [],
    env: baseEnv(path),
    deps: {
      inspectState: async () => ({ kind: 'refused' }),
      runWrangler: async () => {
        spawned += 1
      },
    },
  })
  assert.deepEqual(refused, { code: 'SEED_LOCAL_STATE_REFUSED', ok: false })
  assert.equal(spawned, 0)
})

test('local seed refuses a persistence-directory inode swap before writing SQL', async (t) => {
  const parent = makeDirectory(t)
  const path = join(parent, 'persist')
  const moved = join(parent, 'moved')
  mkdirSync(path, { mode: 0o700 })
  let writes = 0
  let spawns = 0
  const result = await runLocalSeed({
    argv: [],
    env: baseEnv(realpathSync(path)),
    deps: {
      inspectState: async () => {
        renameSync(path, moved)
        mkdirSync(path, { mode: 0o700 })
        return { kind: 'empty' }
      },
      runWrangler: async () => {
        spawns += 1
      },
      writeTempSql: async () => {
        writes += 1
        return join(path, 'seed.sql')
      },
    },
  })

  assert.deepEqual(result, { code: 'SEED_LOCAL_FAILED', ok: false })
  assert.equal(writes, 0)
  assert.equal(spawns, 0)
})

test('local seed rechecks the persistence inode before no-op or refusal returns', async (t) => {
  for (const kind of ['seeded', 'refused']) {
    const parent = makeDirectory(t)
    const path = join(parent, `persist-${kind}`)
    const moved = join(parent, `moved-${kind}`)
    mkdirSync(path, { mode: 0o700 })
    const result = await runLocalSeed({
      argv: [],
      env: baseEnv(realpathSync(path)),
      deps: {
        inspectState: async () => {
          renameSync(path, moved)
          mkdirSync(path, { mode: 0o700 })
          return { kind }
        },
      },
    })
    assert.deepEqual(result, { code: 'SEED_LOCAL_FAILED', ok: false })
  }
})
