import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  buildLocalSeedBatch,
  serializeLocalSeedBatch,
} from '../../scripts/seed-core.js'
import { LOCAL_SEED_MANIFEST, runLocalSeed } from '../../scripts/seed-local.mjs'
import { createKeyring } from '../../worker/security/keyring.js'
import { materializeCoreMigrationStageA } from '../../scripts/apply-core-migration-stage.js'
import {
  buildLocalHarnessWranglerConfig,
  LOCAL_HARNESS_ACTIVE_MIGRATIONS_NAME,
  LOCAL_HARNESS_RUNNER_MODE,
  LOCAL_HARNESS_WRANGLER_NAME,
} from '../../scripts/local-harness-core.js'

const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux'
const PROJECT_ROOT = realpathSync(resolve('.'))
const NODE = realpathSync(process.execPath)
const WRANGLER = realpathSync(join(PROJECT_ROOT, 'node_modules/wrangler/bin/wrangler.js'))
const key = (character) => Buffer.alloc(32, character.charCodeAt(0)).toString('base64url')
const configPath = (root) => join(root, LOCAL_HARNESS_WRANGLER_NAME)
const persistencePath = (root) => join(root, 'state')
const UPGRADE = realpathSync(join(PROJECT_ROOT, 'scripts/upgrade-core-directory.js'))
const APPLY_STAGE = realpathSync(join(PROJECT_ROOT, 'scripts/apply-core-migration-stage.js'))

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

const seedEnv = (root) => ({
  APP_ENV: 'development',
  BWM_BACKUP_KEK_V1: key('C'),
  BWM_DATA_KEK_V1: key('A'),
  BWM_LOCAL_PERSISTENCE_PATH: persistencePath(root),
  BWM_LOOKUP_HMAC_V1: key('B'),
  CF_API_TOKEN: 'must-not-reach-child',
  DATA_MODE: 'fictional',
  HTTPS_PROXY: 'http://must-not-reach-child.invalid',
})

const applyMigrations = (root) => {
  mkdirSync(persistencePath(root), { mode: 0o700 })
  const migrationsDirectory = join(root, 'migrations')
  const activeMigrationsDirectory = join(
    migrationsDirectory,
    LOCAL_HARNESS_ACTIVE_MIGRATIONS_NAME,
  )
  materializeCoreMigrationStageA({
    sourceDirectory: join(PROJECT_ROOT, 'migrations'),
    targetDirectory: activeMigrationsDirectory,
  })
  writeFileSync(
    configPath(root),
    buildLocalHarnessWranglerConfig(PROJECT_ROOT, activeMigrationsDirectory),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )
  const child = spawnSync(NODE, [
    WRANGLER,
    '--config',
    configPath(root),
    '--x-provision=false',
    '--x-auto-create=false',
    '--install-skills=false',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--persist-to',
    persistencePath(root),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: privateChildEnv(root),
    maxBuffer: 64 * 1024,
    shell: false,
  })
  if (child.status !== 0) assert.fail('SEED_LOCAL_TEST_MIGRATION_FAILED')
  const upgrade = spawnSync(NODE, [UPGRADE], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...privateChildEnv(root),
      APP_ENV: 'development',
      BWM_LOCAL_PERSISTENCE_PATH: persistencePath(root),
      BWM_LOCAL_RUNNER_MODE: LOCAL_HARNESS_RUNNER_MODE,
      DATA_MODE: 'fictional',
    },
    maxBuffer: 64 * 1024,
    shell: false,
  })
  if (upgrade.status !== 0
    || upgrade.stderr !== ''
    || upgrade.stdout !== '{"createdCount":0,"processedCount":0,"status":"complete"}\n') {
    assert.fail('SEED_LOCAL_TEST_UPGRADE_FAILED')
  }
  const sealing = spawnSync(NODE, [APPLY_STAGE, 'stage-b', '--local'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...privateChildEnv(root),
      APP_ENV: 'development',
      BWM_LOCAL_PERSISTENCE_PATH: persistencePath(root),
      BWM_LOCAL_RUNNER_MODE: LOCAL_HARNESS_RUNNER_MODE,
      DATA_MODE: 'fictional',
    },
    maxBuffer: 64 * 1024,
    shell: false,
  })
  if (sealing.status !== 0) assert.fail('SEED_LOCAL_TEST_SEALING_FAILED')
  const finance = spawnSync(NODE, [APPLY_STAGE, 'stage-c', '--local'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...privateChildEnv(root),
      APP_ENV: 'development',
      BWM_LOCAL_PERSISTENCE_PATH: persistencePath(root),
      BWM_LOCAL_RUNNER_MODE: LOCAL_HARNESS_RUNNER_MODE,
      DATA_MODE: 'fictional',
    },
    maxBuffer: 64 * 1024,
    shell: false,
  })
  if (finance.status !== 0) assert.fail('SEED_LOCAL_TEST_FINANCE_FAILED')
}

const wranglerExecute = (root, operationArgs) => spawnSync(NODE, [
  WRANGLER,
  '--config',
  configPath(root),
  '--x-provision=false',
  '--x-auto-create=false',
  '--install-skills=false',
  'd1',
  'execute',
  'DB',
  '--local',
  '--persist-to',
  persistencePath(root),
  ...operationArgs,
  '--json',
], {
  cwd: root,
  encoding: 'utf8',
  env: privateChildEnv(root),
  maxBuffer: 64 * 1024,
  shell: false,
})

const artifactFiles = (root) => {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      if (entry.isFile() && /\.sqlite(?:-(?:shm|wal))?$/.test(entry.name)) files.push(path)
    }
  }
  visit(root)
  return files
}

test('default local seed encrypts through real Wrangler and exact rerun is a no-op', {
  skip: !SUPPORTED,
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-seed-real-')))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  assert.equal(statSync(root).mode & 0o777, 0o700)
  applyMigrations(root)

  const first = await runLocalSeed({ argv: [], env: seedEnv(root) })
  assert.deepEqual(first, { code: 'SEED_LOCAL_COMPLETE', ok: true })
  const second = await runLocalSeed({ argv: [], env: seedEnv(root) })
  assert.deepEqual(second, { code: 'SEED_LOCAL_ALREADY_COMPLETE', ok: true })

  const artifacts = artifactFiles(root)
  assert.ok(artifacts.some((path) => path.endsWith('.sqlite')))
  const buffers = artifacts.map((path) => readFileSync(path))
  for (const { displayName, email } of LOCAL_SEED_MANIFEST.staff) {
    const name = Buffer.from(displayName)
    assert.equal(buffers.some((buffer) => buffer.includes(name)), false)
    const identity = Buffer.from(email)
    const prefix = Buffer.from('local:')
    for (const buffer of buffers) {
      let offset = 0
      while ((offset = buffer.indexOf(identity, offset)) !== -1) {
        assert.equal(
          buffer.subarray(Math.max(0, offset - prefix.length), offset).equals(prefix),
          true,
        )
        offset += identity.length
      }
    }
  }
  for (const secret of [
    seedEnv(root).BWM_BACKUP_KEK_V1,
    seedEnv(root).BWM_DATA_KEK_V1,
    seedEnv(root).BWM_LOOKUP_HMAC_V1,
  ]) {
    assert.equal(buffers.some((buffer) => buffer.includes(Buffer.from(secret))), false)
    assert.equal(
      buffers.some((buffer) => buffer.includes(Buffer.from(secret, 'base64url'))),
      false,
    )
  }
  assert.equal(
    readdirSync(root, { recursive: true }).some((name) => (
      String(name).includes('.bwm-seed-')
    )),
    false,
  )
})

test('real Wrangler rolls back all seven seed writes when the final exact guard aborts', {
  skip: !SUPPORTED,
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-seed-rollback-')))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  applyMigrations(root)
  const env = seedEnv(root)
  const keyringConfig = {
    activeBackupKekVersion: 1,
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
  }
  const keyring = await createKeyring({
    BWM_BACKUP_KEK_V1: env.BWM_BACKUP_KEK_V1,
    BWM_DATA_KEK_V1: env.BWM_DATA_KEK_V1,
    BWM_LOOKUP_HMAC_V1: env.BWM_LOOKUP_HMAC_V1,
  }, keyringConfig)
  const built = await buildLocalSeedBatch({ keyring, keyringConfig })
  const guard = built.batch.at(-1)
  assert.match(guard.sql, /\(SELECT count\(\*\) FROM system_state\)=5/)
  assert.match(
    guard.sql,
    /updated_at\s*=\s*strftime\('%Y-%m-%dT%H:%M:%fZ',\s*julianday\(updated_at\)\)/,
  )
  assert.ok(guard.params.includes('outbox.drain.last_success'))
  assert.ok(guard.params.includes('{"completedAt":null}'))
  const forced = [
    ...built.batch.slice(0, -1),
    {
      ...built.batch.at(-1),
      sql: built.batch.at(-1).sql.replace(
        'WHERE NOT (',
        'WHERE 1=1 OR NOT (',
      ),
    },
  ]
  const sqlPath = join(root, '.bwm-forced-guard.sql')
  writeFileSync(sqlPath, serializeLocalSeedBatch(forced), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  const failed = wranglerExecute(root, ['--file', sqlPath])
  assert.equal(failed.status, 1)
  assert.equal(failed.stderr, '')
  assert.deepEqual(JSON.parse(failed.stdout), {
    error: {
      text: 'outbox_operation_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
    },
  })
  const counts = wranglerExecute(root, [
    '--command',
    `SELECT count(*) AS count FROM data_keys;
     SELECT count(*) AS count FROM staff_users;
     SELECT count(*) AS count FROM record_versions;
     SELECT count(*) AS count FROM system_state;`,
  ])
  assert.equal(counts.status, 0)
  assert.deepEqual(
    JSON.parse(counts.stdout).map(({ results }) => results[0].count),
    [0, 0, 0, 5],
  )
})

test('real seed guard rolls back all writes for every drain heartbeat mutation', {
  skip: !SUPPORTED,
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-seed-heartbeat-guard-')))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  applyMigrations(root)
  const localEnv = seedEnv(root)
  const keyringConfig = {
    activeBackupKekVersion: 1,
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
  }
  const keyring = await createKeyring({
    BWM_BACKUP_KEK_V1: localEnv.BWM_BACKUP_KEK_V1,
    BWM_DATA_KEK_V1: localEnv.BWM_DATA_KEK_V1,
    BWM_LOOKUP_HMAC_V1: localEnv.BWM_LOOKUP_HMAC_V1,
  }, keyringConfig)
  const built = await buildLocalSeedBatch({ keyring, keyringConfig })
  const mutation = wranglerExecute(root, [
    '--command',
    `UPDATE system_state
     SET value_json='{"completedAt":null,"extra":true}',
         version=version+1,
         updated_at='2042-07-31T10:00:00.000Z'
     WHERE key='outbox.drain.last_success';`,
  ])
  assert.equal(mutation.status, 0)

  const sqlPath = join(root, '.bwm-heartbeat-guard.sql')
  writeFileSync(sqlPath, serializeLocalSeedBatch(built.batch), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  const failed = wranglerExecute(root, ['--file', sqlPath])
  assert.equal(failed.status, 1)
  assert.equal(failed.stderr, '')
  assert.deepEqual(JSON.parse(failed.stdout), {
    error: {
      text: 'outbox_operation_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
    },
  })

  const state = wranglerExecute(root, [
    '--command',
    `SELECT count(*) AS count FROM data_keys;
     SELECT count(*) AS count FROM staff_users;
     SELECT count(*) AS count FROM record_versions;
     SELECT key,value_json,version,updated_at
     FROM system_state WHERE key='outbox.drain.last_success';`,
  ])
  assert.equal(state.status, 0)
  const results = JSON.parse(state.stdout).map(({ results }) => results)
  assert.deepEqual(results.slice(0, 3).map((rows) => rows[0].count), [0, 0, 0])
  assert.deepEqual(results[3], [{
    key: 'outbox.drain.last_success',
    updated_at: '2042-07-31T10:00:00.000Z',
    value_json: '{"completedAt":null,"extra":true}',
    version: 2,
  }])

  const impossibleTimestamp = wranglerExecute(root, [
    '--command',
    `DROP TRIGGER system_state_version_increment;
     UPDATE system_state
     SET value_json='{"completedAt":null}',
         version=1,
         updated_at='2026-02-30T12:34:56.789Z'
     WHERE key='outbox.drain.last_success';`,
  ])
  assert.equal(impossibleTimestamp.status, 0)

  const timestampFailed = wranglerExecute(root, ['--file', sqlPath])
  assert.equal(timestampFailed.status, 1)
  assert.equal(timestampFailed.stderr, '')
  assert.deepEqual(JSON.parse(timestampFailed.stdout), {
    error: {
      text: 'outbox_operation_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
    },
  })
  const timestampState = wranglerExecute(root, [
    '--command',
    `SELECT count(*) AS count FROM data_keys;
     SELECT count(*) AS count FROM staff_users;
     SELECT count(*) AS count FROM record_versions;
     SELECT key,value_json,version,updated_at
     FROM system_state WHERE key='outbox.drain.last_success';`,
  ])
  assert.equal(timestampState.status, 0)
  const timestampResults = JSON.parse(timestampState.stdout).map(({ results }) => results)
  assert.deepEqual(timestampResults.slice(0, 3).map((rows) => rows[0].count), [0, 0, 0])
  assert.deepEqual(timestampResults[3], [{
    key: 'outbox.drain.last_success',
    updated_at: '2026-02-30T12:34:56.789Z',
    value_json: '{"completedAt":null}',
    version: 1,
  }])
})
