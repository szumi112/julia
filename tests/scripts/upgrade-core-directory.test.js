import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { materializeCoreMigrationStageA } from '../../scripts/apply-core-migration-stage.js'
import {
  buildLocalHarnessWranglerConfig,
  LOCAL_HARNESS_RUNNER_MODE,
  LOCAL_HARNESS_WRANGLER_NAME,
} from '../../scripts/local-harness-core.js'
import {
  createWranglerD1Facade,
  normalizeCoreDirectoryUpgradeInput,
  runCoreDirectoryUpgradeCli,
  runWranglerCommand,
} from '../../scripts/upgrade-core-directory.js'

const BASE_ENV = Object.freeze({
  APP_ENV: 'development',
  DATA_MODE: 'fictional',
})
const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux'
const PROJECT_ROOT = realpathSync(resolve('.'))
const NODE = realpathSync(process.execPath)
const WRANGLER = realpathSync(join(PROJECT_ROOT, 'node_modules/wrangler/bin/wrangler.js'))
const UPGRADE = realpathSync(join(PROJECT_ROOT, 'scripts/upgrade-core-directory.js'))

const privateChildEnv = (root) => ({
  CI: '1',
  CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:1',
  CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  HOME: root,
  LANG: 'C',
  LC_ALL: 'C',
  NO_COLOR: '1',
  TMPDIR: root,
  WRANGLER_HIDE_BANNER: 'true',
  WRANGLER_LOG_SANITIZE: 'true',
  WRANGLER_SEND_ERROR_REPORTS: 'false',
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_WRITE_LOGS: 'false',
  XDG_CACHE_HOME: root,
  XDG_CONFIG_HOME: root,
  XDG_DATA_HOME: root,
})

test('upgrade CLI accepts no row input and normalizes the exact bounded step range', () => {
  assert.deepEqual(normalizeCoreDirectoryUpgradeInput(BASE_ENV, []), { maxSteps: 25 })
  for (const maxSteps of [1, 25, 100]) {
    assert.deepEqual(normalizeCoreDirectoryUpgradeInput({
      ...BASE_ENV,
      CORE_DIRECTORY_MAX_STEPS: String(maxSteps),
    }, []), { maxSteps })
  }
  for (const value of ['0', '101', '1.5', '01', ' 1', '', 'fictional-row']) {
    assert.throws(
      () => normalizeCoreDirectoryUpgradeInput({
        ...BASE_ENV,
        CORE_DIRECTORY_MAX_STEPS: value,
      }, []),
      /^Error: CORE_DIRECTORY_UPGRADE_INPUT_INVALID$/,
    )
  }
  for (const argv of [['staff-row'], ['--row', 'fictional']]) {
    assert.throws(
      () => normalizeCoreDirectoryUpgradeInput(BASE_ENV, argv),
      /^Error: CORE_DIRECTORY_UPGRADE_INPUT_INVALID$/,
    )
  }
})

test('upgrade CLI requires fictional mode and refuses every production marker', () => {
  for (const env of [
    { APP_ENV: 'development', DATA_MODE: 'real' },
    { APP_ENV: 'production', DATA_MODE: 'fictional' },
    { CLOUDFLARE_ENV: 'production', DATA_MODE: 'fictional' },
    { DATA_MODE: 'fictional' },
  ]) {
    assert.throws(
      () => normalizeCoreDirectoryUpgradeInput(env, []),
      /^Error: CORE_DIRECTORY_UPGRADE_INPUT_INVALID$/,
    )
  }
})

test('upgrade CLI accepts explicit remote envs with unchanged local guards', () => {
  assert.deepEqual(
    normalizeCoreDirectoryUpgradeInput({ DATA_MODE: 'fictional' }, ['--remote', '--env', 'staging']),
    { envName: 'staging', maxSteps: 25 },
  )
  assert.deepEqual(
    normalizeCoreDirectoryUpgradeInput({
      CLOUDFLARE_ENV: 'production',
      CORE_DIRECTORY_MAX_STEPS: '5',
      DATA_MODE: 'fictional',
    }, ['--remote', '--env', 'production']),
    { envName: 'production', maxSteps: 5 },
  )
  for (const fixture of [
    [{ DATA_MODE: 'real' }, ['--remote', '--env', 'staging']],
    [{ APP_ENV: 'production', DATA_MODE: 'fictional' }, ['--remote', '--env', 'staging']],
    [{ CLOUDFLARE_ENV: 'production', DATA_MODE: 'fictional' }, ['--remote', '--env', 'staging']],
    [{ DATA_MODE: 'fictional' }, ['--remote', '--env', 'demo']],
    [{ DATA_MODE: 'fictional' }, ['--remote']],
    [{ DATA_MODE: 'fictional' }, ['--remote', '--env']],
    [{ DATA_MODE: 'fictional' }, ['--env', 'staging', '--remote']],
  ]) {
    assert.throws(
      () => normalizeCoreDirectoryUpgradeInput(...fixture),
      /^Error: CORE_DIRECTORY_UPGRADE_INPUT_INVALID$/,
    )
  }
})

const runCli = async ({ advance, env = BASE_ENV, loadCryptoContext } = {}) => {
  let stdout = ''
  let stderr = ''
  const exitCode = await runCoreDirectoryUpgradeCli({
    argv: [],
    env,
    stderr: { write: (value) => { stderr += value } },
    stdout: { write: (value) => { stdout += value } },
    deps: {
      advance,
      createDb: async () => Object.freeze({}),
      idFactory: (kind) => `${kind === 'version' ? 'ver' : 'aud'}_cli_test`,
      loadCryptoContext,
      now: () => Date.parse('2031-04-05T06:07:08.009Z'),
    },
  })
  return { exitCode, stderr, stdout }
}

test('upgrade CLI exits 0 only on complete and emits aggregate fields only', async () => {
  const secret = 'Zofia Fikcyjna specialist@example.test stf_secret sp_secret'
  const outcome = await runCli({
    advance: async () => ({ createdCount: 2, processedCount: 7, status: 'complete', secret }),
  })
  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.stderr, '')
  assert.deepEqual(JSON.parse(outcome.stdout), {
    createdCount: 2,
    processedCount: 7,
    status: 'complete',
  })
  assert.equal(outcome.stdout.includes(secret), false)
  assert.equal(outcome.stdout.includes('stf_'), false)
  assert.equal(outcome.stdout.includes('sp_'), false)
})

test('upgrade CLI exits 2 with the last aggregates after its exact step bound', async () => {
  let calls = 0
  const outcome = await runCli({
    env: { ...BASE_ENV, CORE_DIRECTORY_MAX_STEPS: '2' },
    advance: async () => {
      calls += 1
      return { createdCount: calls, processedCount: calls, status: 'running' }
    },
  })
  assert.equal(calls, 2)
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.stderr, '')
  assert.deepEqual(JSON.parse(outcome.stdout), {
    createdCount: 2,
    processedCount: 2,
    status: 'running',
  })
})

test('upgrade CLI loads crypto only after a nonempty core step requires it', async () => {
  const contexts = []
  let loads = 0
  const cryptoContext = Object.freeze({ dataKey: {}, keyring: {}, scope: {} })
  const outcome = await runCli({
    advance: async ({ cryptoContext: context }) => {
      contexts.push(context)
      if (context === null) throw new Error('CORE_DIRECTORY_CRYPTO_REQUIRED')
      return { createdCount: 1, processedCount: 1, status: 'complete' }
    },
    loadCryptoContext: async () => {
      loads += 1
      return cryptoContext
    },
  })
  assert.equal(outcome.exitCode, 0)
  assert.equal(loads, 1)
  assert.deepEqual(contexts, [null, cryptoContext])
})

test('upgrade CLI does not load keys on fresh zero-row completion', async () => {
  let loads = 0
  const outcome = await runCli({
    advance: async ({ cryptoContext }) => {
      assert.equal(cryptoContext, null)
      return { createdCount: 0, processedCount: 0, status: 'complete' }
    },
    loadCryptoContext: async () => {
      loads += 1
      throw new Error('must not load a key')
    },
  })
  assert.equal(outcome.exitCode, 0)
  assert.equal(loads, 0)
})

test('upgrade CLI maps failures to exit 1 without raw D1, identity, key, or plaintext output', async () => {
  const secret = 'D1 raw failure stf_private sp_private BWM_DATA_KEK_V1=secret Zofia Fikcyjna'
  const outcome = await runCli({
    advance: async () => { throw new Error(secret) },
  })
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.stdout, '')
  assert.equal(outcome.stderr, 'CORE_DIRECTORY_UPGRADE_FAILED\n')
  assert.equal(`${outcome.stdout}${outcome.stderr}`.includes(secret), false)
})

test('Wrangler command applies a fixed deadline and classifies missing terminal proof as ambiguous', () => {
  const calls = []
  assert.throws(() => runWranglerCommand({
    args: ['wrangler.js'],
    cwd: '/tmp',
    env: {},
    executable: process.execPath,
  }, {
    spawnSyncImpl: (...args) => {
      calls.push(args)
      return { error: Object.assign(new Error('secret timeout'), { code: 'ETIMEDOUT' }), status: null }
    },
  }), /^Error: CORE_DIRECTORY_D1_AMBIGUOUS$/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].timeout, 30_000)
  assert.equal(calls[0][2].maxBuffer, 64 * 1024)
  assert.equal(calls[0][2].shell, false)
})

test('Wrangler command accepts only a clean exact JSON success envelope', () => {
  const result = runWranglerCommand({
    args: ['wrangler.js'],
    cwd: '/tmp',
    env: {},
    executable: process.execPath,
  }, {
    spawnSyncImpl: () => ({
      error: undefined,
      signal: null,
      status: 0,
      stderr: '',
      stdout: '[{"results":[],"success":true,"meta":{"duration":1}}]',
    }),
  })
  assert.deepEqual(result, [{ results: [], success: true, meta: { duration: 1 } }])

  assert.throws(() => runWranglerCommand({
    args: ['wrangler.js'],
    cwd: '/tmp',
    env: {},
    executable: process.execPath,
  }, {
    spawnSyncImpl: () => ({
      error: undefined,
      signal: null,
      status: 1,
      stderr: '',
      stdout: '{"error":{"text":"secret row"}}',
    }),
  }), /^Error: CORE_DIRECTORY_D1_REFUSED$/)
})

test('Wrangler facade targets the named remote env and passes operator auth through', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-directory-remote-')))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const configPath = join(root, 'wrangler.json')
  writeFileSync(configPath, JSON.stringify({
    d1_databases: [{ binding: 'DB', database_name: 'bearwithme-panel-local' }],
    env: {
      production: {
        d1_databases: [{ binding: 'DB', database_name: 'bearwithme-panel-production' }],
      },
      staging: {
        d1_databases: [{ binding: 'DB', database_name: 'bearwithme-panel-staging' }],
      },
    },
  }))
  const calls = []
  const runCommand = (invocation) => {
    calls.push(invocation)
    return [{ meta: { duration: 1 }, results: [], success: true }]
  }
  const env = {
    CLOUDFLARE_API_TOKEN: 'fictional-operator-token',
    DATA_MODE: 'fictional',
  }

  const db = createWranglerD1Facade(env, { configPath, envName: 'staging', runCommand })
  await db.prepare('SELECT 1 AS one').all()
  assert.equal(calls.length, 1)
  const { args, env: childEnv } = calls[0]
  assert.deepEqual(args.slice(args.indexOf('DB') + 1, args.indexOf('DB') + 4), [
    '--env',
    'staging',
    '--remote',
  ])
  assert.equal(args.includes('--local'), false)
  assert.equal(args.includes('--persist-to'), false)
  assert.equal(args[args.indexOf('--config') + 1], configPath)
  assert.equal(childEnv.CLOUDFLARE_API_TOKEN, 'fictional-operator-token')
  assert.equal(childEnv.CLOUDFLARE_API_BASE_URL, undefined)
  assert.equal(childEnv.WRANGLER_SEND_METRICS, 'false')

  assert.throws(
    () => createWranglerD1Facade(env, { configPath, envName: 'production', runCommand }),
    /^Error: CORE_MIGRATION_REMOTE_PRODUCTION_UNCONFIRMED$/,
  )
  const confirmed = createWranglerD1Facade({
    ...env,
    BWM_CONFIRM_PRODUCTION_DATABASE: 'bearwithme-panel-production',
  }, { configPath, envName: 'production', runCommand })
  await confirmed.prepare('SELECT 1 AS one').all()
  assert.deepEqual(
    calls[1].args.slice(calls[1].args.indexOf('DB') + 1, calls[1].args.indexOf('DB') + 4),
    ['--env', 'production', '--remote'],
  )

  const missingPath = join(root, 'wrangler.missing.json')
  writeFileSync(missingPath, JSON.stringify({
    d1_databases: [{ binding: 'DB', database_name: 'bearwithme-panel-local' }],
  }))
  assert.throws(
    () => createWranglerD1Facade(env, { configPath: missingPath, envName: 'staging', runCommand }),
    /^Error: CORE_MIGRATION_REMOTE_ENV_MISSING$/,
  )
})

test('Wrangler facade never forwards KEK secrets or unrelated parent env to remote children', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-directory-remote-env-')))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const configPath = join(root, 'wrangler.json')
  writeFileSync(configPath, JSON.stringify({
    d1_databases: [{ binding: 'DB', database_name: 'bearwithme-panel-local' }],
    env: {
      staging: {
        d1_databases: [{ binding: 'DB', database_name: 'bearwithme-panel-staging' }],
      },
    },
  }))
  const calls = []
  const runCommand = (invocation) => {
    calls.push(invocation)
    return [{ meta: { duration: 1 }, results: [], success: true }]
  }
  const env = {
    BWM_BACKUP_KEK_V1: 'fictional-backup-kek',
    BWM_DATA_KEK_V1: 'fictional-data-kek',
    BWM_LOOKUP_HMAC_V1: 'fictional-lookup-hmac',
    CLOUDFLARE_ACCOUNT_ID: 'fictional-account-id',
    CLOUDFLARE_API_TOKEN: 'fictional-operator-token',
    DATA_MODE: 'fictional',
    HOME: '/home/fictional-operator',
    PATH: '/usr/bin:/bin',
    UNRELATED_PARENT_VALUE: 'must-not-leak',
  }

  const db = createWranglerD1Facade(env, { configPath, envName: 'staging', runCommand })
  await db.prepare('SELECT 1 AS one').all()
  assert.equal(calls.length, 1)
  const childEnv = calls[0].env
  assert.deepEqual(Object.keys(childEnv).filter((name) => name.startsWith('BWM_')), [])
  assert.equal(childEnv.UNRELATED_PARENT_VALUE, undefined)
  assert.equal(childEnv.DATA_MODE, undefined)
  assert.equal(childEnv.CLOUDFLARE_ACCOUNT_ID, 'fictional-account-id')
  assert.equal(childEnv.CLOUDFLARE_API_TOKEN, 'fictional-operator-token')
  assert.equal(childEnv.HOME, '/home/fictional-operator')
  assert.equal(childEnv.PATH, '/usr/bin:/bin')
  assert.equal(childEnv.CLOUDFLARE_INCLUDE_PROCESS_ENV, 'false')
  assert.equal(childEnv.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, 'false')
  assert.equal(childEnv.WRANGLER_LOG_SANITIZE, 'true')
})

test('upgrade CLI completes a fresh remote database with aggregate-only output', async () => {
  const targets = []
  let stdout = ''
  let stderr = ''
  const exitCode = await runCoreDirectoryUpgradeCli({
    argv: ['--remote', '--env', 'staging'],
    env: { DATA_MODE: 'fictional' },
    stderr: { write: (value) => { stderr += value } },
    stdout: { write: (value) => { stdout += value } },
    deps: {
      advance: async ({ cryptoContext }) => {
        assert.equal(cryptoContext, null)
        return { createdCount: 0, processedCount: 0, status: 'complete' }
      },
      createDb: async (childEnv, options) => {
        targets.push(options)
        return Object.freeze({})
      },
      idFactory: (kind) => `${kind === 'version' ? 'ver' : 'aud'}_cli_test`,
      now: () => Date.parse('2031-04-05T06:07:08.009Z'),
    },
  })
  assert.equal(exitCode, 0)
  assert.equal(stderr, '')
  assert.equal(stdout, '{"createdCount":0,"processedCount":0,"status":"complete"}\n')
  assert.deepEqual(targets, [{ envName: 'staging' }])
})

test('upgrade CLI surfaces remote env misconfiguration with a fixed clear code', async () => {
  let stdout = ''
  let stderr = ''
  const exitCode = await runCoreDirectoryUpgradeCli({
    argv: ['--remote', '--env', 'staging'],
    env: { DATA_MODE: 'fictional' },
    stderr: { write: (value) => { stderr += value } },
    stdout: { write: (value) => { stdout += value } },
    deps: {
      createDb: async () => { throw new Error('CORE_MIGRATION_REMOTE_ENV_MISSING') },
    },
  })
  assert.equal(exitCode, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, 'CORE_MIGRATION_REMOTE_ENV_MISSING\n')
})

test('real fictional CLI completes fresh stage A and reruns as an aggregate-only no-op', {
  skip: !SUPPORTED,
}, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-directory-upgrade-')))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const statePath = join(root, 'state')
  const migrationsPath = join(root, 'migrations')
  const configPath = join(root, LOCAL_HARNESS_WRANGLER_NAME)
  mkdirSync(statePath, { mode: 0o700 })
  materializeCoreMigrationStageA({
    sourceDirectory: join(PROJECT_ROOT, 'migrations'),
    targetDirectory: migrationsPath,
  })
  writeFileSync(
    configPath,
    buildLocalHarnessWranglerConfig(PROJECT_ROOT, migrationsPath),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )
  const migration = spawnSync(NODE, [
    WRANGLER,
    '--config',
    configPath,
    '--x-provision=false',
    '--x-auto-create=false',
    '--install-skills=false',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--persist-to',
    statePath,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: privateChildEnv(root),
    maxBuffer: 64 * 1024,
    shell: false,
  })
  assert.equal(migration.status, 0, 'stage-A migration must succeed')

  const run = () => spawnSync(NODE, [UPGRADE], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...privateChildEnv(root),
      APP_ENV: 'development',
      BWM_LOCAL_PERSISTENCE_PATH: statePath,
      BWM_LOCAL_RUNNER_MODE: LOCAL_HARNESS_RUNNER_MODE,
      DATA_MODE: 'fictional',
    },
    maxBuffer: 64 * 1024,
    shell: false,
  })
  for (const attempt of [run(), run()]) {
    assert.equal(attempt.status, 0)
    assert.equal(attempt.stderr, '')
    assert.equal(
      attempt.stdout,
      '{"createdCount":0,"processedCount":0,"status":"complete"}\n',
    )
    assert.deepEqual(Object.keys(JSON.parse(attempt.stdout)), [
      'createdCount',
      'processedCount',
      'status',
    ])
  }
})
