import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STAGE_A_NAMES = Object.freeze([
  '0001_security_primitives.sql',
  '0002_identity_operations.sql',
  '0003_rate_limit_guard.sql',
  '0004_staff_provisioning_state.sql',
  '0005_outbox_operation_guard.sql',
  '0006_delivery_attempt_uniqueness.sql',
  '0007_operational_health_indexes.sql',
  '0008_outbox_drain_heartbeat.sql',
  '0009_core_directory_expand.sql',
])
const STAGE_B_NAMES = Object.freeze([
  '0010_specialist_lifecycle_assertion.sql',
  '0011_appointment_ledger.sql',
])
const STAGE_C_NAMES = Object.freeze([
  '0012_finance_ledger.sql',
  '0013_finance_source_deduplication.sql',
  '0014_finance_import_recovery.sql',
])
const STAGE_D_NAMES = Object.freeze([
  '0015_unclaimed_specialist_profiles.sql',
])
const STAGE_E_NAMES = Object.freeze([
  '0016_workbook_source_records.sql',
  '0017_historical_workspace.sql',
  '0018_activity_workspace.sql',
  '0019_dual_role_specialists.sql',
])

const migration = (name) => Object.freeze({
  name,
  queries: Object.freeze([`SELECT ${Number.parseInt(name, 10)}`]),
})

const loadStageModule = async () => {
  try {
    return await import('../../scripts/core-migration-stages.js')
  } catch {
    return null
  }
}

const loadApplyModule = async () => {
  try {
    return await import('../../scripts/apply-core-migration-stage.js')
  } catch {
    return null
  }
}

test('stage A selects the exact named D1 migrations and never exposes stage B', async () => {
  const module = await loadStageModule()
  assert.ok(module, 'core migration stage selector must exist')
  assert.deepEqual(module.CORE_MIGRATION_STAGE_A_NAMES, STAGE_A_NAMES)
  assert.deepEqual(module.CORE_MIGRATION_STAGE_B_NAMES, STAGE_B_NAMES)
  assert.deepEqual(module.CORE_MIGRATION_STAGE_C_NAMES, STAGE_C_NAMES)
  assert.deepEqual(module.CORE_MIGRATION_STAGE_D_NAMES, STAGE_D_NAMES)

  const source = [
    ...STAGE_A_NAMES.map(migration),
    migration('0010_specialist_lifecycle_assertion.sql'),
    migration('0011_appointment_ledger.sql'),
    migration('0012_finance_ledger.sql'),
    migration('0013_finance_source_deduplication.sql'),
    migration('0014_finance_import_recovery.sql'),
    migration('0015_unclaimed_specialist_profiles.sql'),
  ]
  const selected = module.selectCoreMigrationStage(source, 'stage-a')

  assert.deepEqual(selected.map(({ name }) => name), STAGE_A_NAMES)
  assert.equal(selected.every((entry, index) => entry === source[index]), true)
  assert.equal(Object.isFrozen(selected), true)
})

test('stage B selects only the exact ordered later migrations', async () => {
  const module = await loadStageModule()
  assert.ok(module, 'core migration stage selector must exist')
  const source = [
    ...STAGE_A_NAMES.map(migration),
    ...STAGE_B_NAMES.map(migration),
    ...STAGE_C_NAMES.map(migration),
  ]

  const selected = module.selectCoreMigrationStage(source, 'stage-b')

  assert.deepEqual(selected.map(({ name }) => name), STAGE_B_NAMES)
  assert.equal(selected[0], source[STAGE_A_NAMES.length])
  assert.equal(selected[1], source[STAGE_A_NAMES.length + 1])
  assert.equal(Object.isFrozen(selected), true)
})

test('stage C selects only the finance ledger migrations', async () => {
  const module = await loadStageModule()
  assert.ok(module, 'core migration stage selector must exist')
  const source = [
    ...STAGE_A_NAMES.map(migration),
    ...STAGE_B_NAMES.map(migration),
    ...STAGE_C_NAMES.map(migration),
    ...STAGE_D_NAMES.map(migration),
  ]

  const selected = module.selectCoreMigrationStage(source, 'stage-c')

  assert.deepEqual(selected.map(({ name }) => name), STAGE_C_NAMES)
  assert.equal(selected.at(-1), source.at(-2))
  assert.equal(Object.isFrozen(selected), true)
})

test('stage D selects only the unclaimed specialist profile migration', async () => {
  const module = await loadStageModule()
  assert.ok(module, 'core migration stage selector must exist')
  const source = [
    ...STAGE_A_NAMES.map(migration),
    ...STAGE_B_NAMES.map(migration),
    ...STAGE_C_NAMES.map(migration),
    ...STAGE_D_NAMES.map(migration),
  ]

  const selected = module.selectCoreMigrationStage(source, 'stage-d')

  assert.deepEqual(selected.map(({ name }) => name), STAGE_D_NAMES)
  assert.equal(selected[0], source.at(-1))
  assert.equal(Object.isFrozen(selected), true)
})

test('stage E selects the ordered workbook workspace migrations', async () => {
  const module = await loadStageModule()
  assert.ok(module, 'core migration stage selector must exist')
  const source = [
    ...STAGE_A_NAMES.map(migration),
    ...STAGE_B_NAMES.map(migration),
    ...STAGE_C_NAMES.map(migration),
    ...STAGE_D_NAMES.map(migration),
    ...STAGE_E_NAMES.map(migration),
  ]

  const selected = module.selectCoreMigrationStage(source, 'stage-e')

  assert.deepEqual(module.CORE_MIGRATION_STAGE_E_NAMES, STAGE_E_NAMES)
  assert.deepEqual(selected.map(({ name }) => name), STAGE_E_NAMES)
  assert.equal(selected.at(-1), source.at(-1))
  assert.equal(Object.isFrozen(selected), true)
})

test('stage selection fails closed on missing, duplicate, unordered, or unknown source names', async () => {
  const module = await loadStageModule()
  assert.ok(module, 'core migration stage selector must exist')
  const valid = STAGE_A_NAMES.map(migration)
  const cases = [
    valid.slice(0, -1),
    [...valid, valid.at(-1)],
    [valid[1], valid[0], ...valid.slice(2)],
    [...valid, migration('0012_unknown.sql')],
  ]

  for (const source of cases) {
    assert.throws(
      () => module.selectCoreMigrationStage(source, 'stage-a'),
      /CORE_MIGRATION_STAGE_INVALID/,
    )
  }
  assert.throws(
    () => module.selectCoreMigrationStage(valid, 'unknown'),
    /CORE_MIGRATION_STAGE_INVALID/,
  )
})

test('stage generation configures only a private directory containing stage A files', async (t) => {
  const module = await loadApplyModule()
  assert.ok(module, 'core migration stage generator must exist')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-core-stage-')))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const sourceDirectory = join(root, 'source')
  const outputRoot = join(root, 'private')
  mkdirSync(sourceDirectory)
  for (const name of STAGE_A_NAMES) {
    writeFileSync(join(sourceDirectory, name), `-- ${name}\nSELECT 1;\n`)
  }
  writeFileSync(join(sourceDirectory, '0010_specialist_lifecycle_assertion.sql'), '-- later\n')
  const configPath = join(root, 'wrangler.json')
  writeFileSync(configPath, JSON.stringify({
    d1_databases: [{
      binding: 'DB',
      database_id: '00000000-0000-0000-0000-000000000001',
      database_name: 'fictional',
      migrations_dir: 'migrations',
    }],
    main: './worker/index.js',
    name: 'fixture',
    vars: { APP_ENV: 'development', DATA_MODE: 'fictional' },
  }))

  const generated = module.generateCoreMigrationStageA({
    configPath,
    outputRoot,
    sourceDirectory,
  })

  assert.deepEqual(readdirSync(generated.migrationsDirectory).sort(), STAGE_A_NAMES)
  assert.deepEqual(generated.names, STAGE_A_NAMES)
  assert.equal(generated.migrationsDirectory.startsWith(`${outputRoot}/`), true)
  const config = JSON.parse(readFileSync(generated.configPath, 'utf8'))
  assert.equal(config.d1_databases[0].migrations_dir, generated.migrationsDirectory)
  assert.notEqual(config.d1_databases[0].migrations_dir, sourceDirectory)
})

test('public fixture helpers can expose only stage A', async (t) => {
  const module = await loadApplyModule()
  assert.ok(module, 'core migration stage generator must exist')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-core-stage-b-')))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const sourceDirectory = join(root, 'source')
  const outputRoot = join(root, 'private')
  mkdirSync(sourceDirectory)
  for (const name of [...STAGE_A_NAMES, ...STAGE_B_NAMES]) {
    writeFileSync(join(sourceDirectory, name), `-- ${name}\nSELECT 1;\n`)
  }
  const configPath = join(root, 'wrangler.json')
  writeFileSync(configPath, JSON.stringify({
    d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
    main: './worker/index.js',
    vars: { APP_ENV: 'development', DATA_MODE: 'fictional' },
  }))
  const generated = module.generateCoreMigrationStageA({
    configPath,
    outputRoot,
    sourceDirectory,
  })
  assert.deepEqual(readdirSync(generated.migrationsDirectory).sort(), STAGE_A_NAMES)
  assert.deepEqual(generated.names, STAGE_A_NAMES)
  assert.equal(module.materializeCoreMigrationStage, undefined)
  assert.equal(module.generateCoreMigrationStage, undefined)
  assert.equal(module.exposeCoreMigrationStage, undefined)
  assert.equal(typeof module.materializeCoreMigrationStageA, 'function')
  assert.equal(typeof module.generateCoreMigrationStageA, 'function')
  assert.throws(() => module.generateCoreMigrationStageA({
    configPath,
    outputRoot,
    sourceDirectory,
    stage: 'stage-b',
  }), /CORE_MIGRATION_STAGE_INVALID/)
  assert.throws(() => module.materializeCoreMigrationStageA({
    sourceDirectory,
    stage: 'stage-b',
    targetDirectory: join(outputRoot, 'bypass'),
  }), /CORE_MIGRATION_STAGE_INVALID/)
  assert.deepEqual(readdirSync(generated.migrationsDirectory).sort(), STAGE_A_NAMES)
})

test('stage commands accept only fictional non-production execution', async () => {
  const module = await loadApplyModule()
  assert.ok(module, 'core migration stage command must exist')
  assert.deepEqual(module.normalizeCoreMigrationStageInput({
    APP_ENV: 'development',
    DATA_MODE: 'fictional',
  }, ['stage-a', '--local']), {
    local: true,
    stage: 'stage-a',
  })
  assert.deepEqual(module.normalizeCoreMigrationStageInput({
    APP_ENV: 'development',
    DATA_MODE: 'fictional',
  }, ['stage-b', '--local']), {
    local: true,
    stage: 'stage-b',
  })
  assert.deepEqual(module.normalizeCoreMigrationStageInput({
    APP_ENV: 'development',
    DATA_MODE: 'fictional',
  }, ['stage-c', '--local']), {
    local: true,
    stage: 'stage-c',
  })
  assert.deepEqual(module.normalizeCoreMigrationStageInput({
    APP_ENV: 'development',
    DATA_MODE: 'fictional',
  }, ['stage-d', '--local']), {
    local: true,
    stage: 'stage-d',
  })
  assert.deepEqual(module.normalizeCoreMigrationStageInput({
    APP_ENV: 'development',
    DATA_MODE: 'fictional',
  }, ['stage-e', '--local']), {
    local: true,
    stage: 'stage-e',
  })

  for (const fixture of [
    [{ APP_ENV: 'production', DATA_MODE: 'fictional' }, ['stage-a']],
    [{ APP_ENV: 'development', DATA_MODE: 'real' }, ['stage-a']],
    [{ APP_ENV: 'development', DATA_MODE: 'fictional' }, ['stage-a', '--remote']],
  ]) {
    assert.throws(
      () => module.normalizeCoreMigrationStageInput(...fixture),
      /CORE_MIGRATION_STAGE_INPUT_INVALID/,
    )
  }
})

test('remote stage input accepts explicit envs and keeps every local guard', async () => {
  const module = await loadApplyModule()
  assert.ok(module, 'core migration stage command must exist')
  assert.deepEqual(module.normalizeCoreMigrationStageInput({
    DATA_MODE: 'fictional',
  }, ['stage-a', '--remote', '--env', 'staging']), {
    envName: 'staging',
    local: false,
    stage: 'stage-a',
  })
  assert.deepEqual(module.normalizeCoreMigrationStageInput({
    CLOUDFLARE_ENV: 'production',
    DATA_MODE: 'fictional',
  }, ['stage-b', '--remote', '--env', 'production']), {
    envName: 'production',
    local: false,
    stage: 'stage-b',
  })
  assert.deepEqual(module.normalizeCoreMigrationStageInput({
    DATA_MODE: 'fictional',
  }, ['stage-c', '--remote', '--env', 'staging']), {
    envName: 'staging',
    local: false,
    stage: 'stage-c',
  })
  assert.deepEqual(module.normalizeCoreMigrationStageInput({
    DATA_MODE: 'fictional',
  }, ['stage-d', '--remote', '--env', 'staging']), {
    envName: 'staging',
    local: false,
    stage: 'stage-d',
  })
  assert.deepEqual(module.normalizeCoreMigrationStageInput({
    DATA_MODE: 'fictional',
  }, ['stage-e', '--remote', '--env', 'staging']), {
    envName: 'staging',
    local: false,
    stage: 'stage-e',
  })

  for (const fixture of [
    [{ DATA_MODE: 'real' }, ['stage-a', '--remote', '--env', 'staging']],
    [{ APP_ENV: 'production', DATA_MODE: 'fictional' }, ['stage-a', '--remote', '--env', 'staging']],
    [{ CLOUDFLARE_ENV: 'production', DATA_MODE: 'fictional' }, ['stage-a', '--remote', '--env', 'staging']],
    [{ DATA_MODE: 'fictional' }, ['stage-a', '--remote', '--env', 'demo']],
    [{ DATA_MODE: 'fictional' }, ['stage-a', '--env', 'staging', '--remote']],
    [{ DATA_MODE: 'fictional' }, ['stage-a', '--remote', '--env']],
    [{ APP_ENV: 'development', DATA_MODE: 'fictional' }, ['stage-a']],
  ]) {
    assert.throws(
      () => module.normalizeCoreMigrationStageInput(...fixture),
      /CORE_MIGRATION_STAGE_INPUT_INVALID/,
    )
  }
})

test('remote target selection requires a named env block and exact production confirmation', async () => {
  const module = await loadStageModule()
  assert.ok(module, 'core migration stage selector must exist')
  assert.equal(module.CORE_MIGRATION_PRODUCTION_ACK_VARIABLE, 'BWM_CONFIRM_PRODUCTION_DATABASE')
  const config = {
    d1_databases: [{ binding: 'DB', database_name: 'bearwithme-panel-local' }],
    env: {
      production: {
        d1_databases: [{
          binding: 'DB',
          database_id: '00000000-0000-0000-0000-000000000003',
          database_name: 'bearwithme-panel-production',
        }],
      },
      staging: {
        d1_databases: [{
          binding: 'DB',
          database_id: '00000000-0000-0000-0000-000000000002',
          database_name: 'bearwithme-panel-staging',
        }],
      },
    },
  }

  const staging = module.selectCoreMigrationRemoteTarget(config, 'staging')
  assert.deepEqual(staging, {
    databaseName: 'bearwithme-panel-staging',
    envName: 'staging',
  })
  assert.equal(Object.isFrozen(staging), true)
  const production = module.selectCoreMigrationRemoteTarget(config, 'production')
  assert.deepEqual(production, {
    databaseName: 'bearwithme-panel-production',
    envName: 'production',
  })

  assert.throws(
    () => module.selectCoreMigrationRemoteTarget({ d1_databases: config.d1_databases }, 'staging'),
    /CORE_MIGRATION_REMOTE_ENV_MISSING/,
  )
  assert.throws(
    () => module.selectCoreMigrationRemoteTarget({ env: { production: config.env.production } }, 'staging'),
    /CORE_MIGRATION_REMOTE_ENV_MISSING/,
  )
  for (const block of [
    {},
    { d1_databases: [] },
    { d1_databases: [...config.env.staging.d1_databases, ...config.env.staging.d1_databases] },
    { d1_databases: [{ ...config.env.staging.d1_databases[0], binding: 'DATA' }] },
    { d1_databases: [{ ...config.env.staging.d1_databases[0], database_name: '' }] },
  ]) {
    assert.throws(
      () => module.selectCoreMigrationRemoteTarget({ env: { staging: block } }, 'staging'),
      /CORE_MIGRATION_REMOTE_ENV_INVALID/,
    )
  }
  assert.throws(
    () => module.selectCoreMigrationRemoteTarget(config, 'demo'),
    /CORE_MIGRATION_STAGE_INVALID/,
  )

  assert.equal(module.confirmCoreMigrationRemoteTarget({}, staging), staging)
  assert.equal(module.confirmCoreMigrationRemoteTarget({
    BWM_CONFIRM_PRODUCTION_DATABASE: 'bearwithme-panel-production',
  }, production), production)
  for (const env of [
    {},
    { BWM_CONFIRM_PRODUCTION_DATABASE: 'bearwithme-panel-prod' },
    { BWM_CONFIRM_PRODUCTION_DATABASE: 'bearwithme-panel-production ' },
    { BWM_CONFIRM_PRODUCTION_DATABASE: '' },
    { BWM_CONFIRM_PRODUCTION_DATABASE: 'bearwithme-panel-staging' },
  ]) {
    assert.throws(
      () => module.confirmCoreMigrationRemoteTarget(env, production),
      /CORE_MIGRATION_REMOTE_PRODUCTION_UNCONFIRMED/,
    )
  }
})

test('remote stage generation rewrites only the named env block onto a fresh active directory', async (t) => {
  const module = await loadApplyModule()
  assert.ok(module, 'core migration stage generator must exist')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-core-stage-remote-')))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const sourceDirectory = join(root, 'source')
  const outputRoot = join(root, 'private')
  mkdirSync(sourceDirectory)
  for (const name of STAGE_A_NAMES) {
    writeFileSync(join(sourceDirectory, name), `-- ${name}\nSELECT 1;\n`)
  }
  mkdirSync(outputRoot, { mode: 0o700 })
  mkdirSync(join(outputRoot, 'active'), { mode: 0o700 })
  writeFileSync(join(outputRoot, 'active', '9999_foreign.sql'), '-- foreign\n', { mode: 0o600 })
  const configPath = join(root, 'wrangler.json')
  writeFileSync(configPath, JSON.stringify({
    d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
    env: {
      production: {
        d1_databases: [{ binding: 'DB', database_name: 'bearwithme-panel-production' }],
      },
      staging: {
        d1_databases: [{ binding: 'DB', database_name: 'bearwithme-panel-staging' }],
      },
    },
    main: './worker/index.js',
    vars: { DATA_MODE: 'fictional' },
  }))

  const generated = module.generateCoreMigrationStageA({
    configPath,
    envName: 'staging',
    outputRoot,
    sourceDirectory,
  })

  assert.deepEqual(readdirSync(generated.migrationsDirectory).sort(), STAGE_A_NAMES)
  assert.deepEqual(generated.names, STAGE_A_NAMES)
  assert.equal(generated.configPath, join(outputRoot, 'wrangler.stage-a.staging.json'))
  const config = JSON.parse(readFileSync(generated.configPath, 'utf8'))
  assert.equal(config.env.staging.d1_databases[0].migrations_dir, generated.migrationsDirectory)
  assert.equal(config.env.staging.d1_databases[0].database_name, 'bearwithme-panel-staging')
  assert.equal(config.env.production.d1_databases[0].migrations_dir, undefined)

  const missingPath = join(root, 'wrangler.missing.json')
  writeFileSync(missingPath, JSON.stringify({
    d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
    main: './worker/index.js',
  }))
  assert.throws(() => module.generateCoreMigrationStageA({
    configPath: missingPath,
    envName: 'staging',
    outputRoot,
    sourceDirectory,
  }), /CORE_MIGRATION_REMOTE_ENV_MISSING/)
  assert.deepEqual(readdirSync(generated.migrationsDirectory).sort(), STAGE_A_NAMES)
})

test('stage-B preflight accepts only an exact empty Wrangler result', async () => {
  const module = await loadApplyModule()
  assert.ok(module, 'core migration stage command must exist')
  const clean = JSON.stringify([{
    meta: { duration: 1 },
    results: [],
    success: true,
  }])
  assert.deepEqual(module.parseCoreMigrationStageBPreflight(clean), {
    ready: true,
  })

  for (const result of [
    [{ meta: { duration: 1 }, results: [{ failure_kind: 'missing_profile' }], success: true }],
    [{ meta: { duration: 1 }, results: [{ failure_kind: 'upgrade_incomplete' }], success: true }],
    [{ meta: { duration: 1 }, results: [], success: false }],
    [{ meta: { duration: 1 }, results: [{ failure_kind: 'private-id' }], success: true }],
  ]) {
    assert.throws(
      () => module.parseCoreMigrationStageBPreflight(JSON.stringify(result)),
      /CORE_MIGRATION_STAGE_PREFLIGHT_FAILED/,
    )
  }
  assert.throws(
    () => module.parseCoreMigrationStageBPreflight('not-json'),
    /CORE_MIGRATION_STAGE_PREFLIGHT_FAILED/,
  )
})

test('stage generation rejects a symlinked private output root', async (t) => {
  const module = await loadApplyModule()
  assert.ok(module, 'core migration stage generator must exist')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-core-stage-symlink-')))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const sourceDirectory = join(root, 'source')
  const external = join(root, 'external')
  const outputRoot = join(root, 'private')
  mkdirSync(sourceDirectory)
  mkdirSync(external)
  for (const name of STAGE_A_NAMES) {
    writeFileSync(join(sourceDirectory, name), `-- ${name}\nSELECT 1;\n`)
  }
  symlinkSync(external, outputRoot)
  const configPath = join(root, 'wrangler.json')
  writeFileSync(configPath, JSON.stringify({
    d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
    main: './worker/index.js',
    vars: { APP_ENV: 'development', DATA_MODE: 'fictional' },
  }))

  assert.throws(() => module.generateCoreMigrationStageA({
    configPath,
    outputRoot,
    sourceDirectory,
  }), /CORE_MIGRATION_STAGE_INVALID/)
  assert.deepEqual(readdirSync(external), [])
})
