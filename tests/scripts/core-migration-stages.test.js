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

  const source = [
    ...STAGE_A_NAMES.map(migration),
    migration('0010_specialist_lifecycle_assertion.sql'),
  ]
  const selected = module.selectCoreMigrationStage(source, 'stage-a')

  assert.deepEqual(selected.map(({ name }) => name), STAGE_A_NAMES)
  assert.equal(selected.every((entry, index) => entry === source[index]), true)
  assert.equal(Object.isFrozen(selected), true)
})

test('stage B selects only the exact later named migration', async () => {
  const module = await loadStageModule()
  assert.ok(module, 'core migration stage selector must exist')
  const source = [
    ...STAGE_A_NAMES.map(migration),
    ...STAGE_B_NAMES.map(migration),
  ]

  const selected = module.selectCoreMigrationStage(source, 'stage-b')

  assert.deepEqual(selected.map(({ name }) => name), STAGE_B_NAMES)
  assert.equal(selected[0], source.at(-1))
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
    [...valid, migration('0011_appointment_ledger.sql')],
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

  const generated = module.generateCoreMigrationStage({
    configPath,
    outputRoot,
    sourceDirectory,
    stage: 'stage-a',
  })

  assert.deepEqual(readdirSync(generated.migrationsDirectory).sort(), STAGE_A_NAMES)
  assert.deepEqual(generated.names, STAGE_A_NAMES)
  assert.equal(generated.migrationsDirectory.startsWith(`${outputRoot}/`), true)
  const config = JSON.parse(readFileSync(generated.configPath, 'utf8'))
  assert.equal(config.d1_databases[0].migrations_dir, generated.migrationsDirectory)
  assert.notEqual(config.d1_databases[0].migrations_dir, sourceDirectory)
})

test('stage generation replaces stage A exposure with only stage B', async (t) => {
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
  module.generateCoreMigrationStage({
    configPath,
    outputRoot,
    sourceDirectory,
    stage: 'stage-a',
  })

  const generated = module.generateCoreMigrationStage({
    configPath,
    outputRoot,
    sourceDirectory,
    stage: 'stage-b',
  })

  assert.deepEqual(readdirSync(generated.migrationsDirectory), STAGE_B_NAMES)
  assert.deepEqual(generated.names, STAGE_B_NAMES)
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

  for (const fixture of [
    [{ APP_ENV: 'production', DATA_MODE: 'fictional' }, ['stage-a']],
    [{ APP_ENV: 'development', DATA_MODE: 'real' }, ['stage-a']],
    [{ APP_ENV: 'development', DATA_MODE: 'fictional' }, ['stage-c']],
    [{ APP_ENV: 'development', DATA_MODE: 'fictional' }, ['stage-a', '--remote']],
  ]) {
    assert.throws(
      () => module.normalizeCoreMigrationStageInput(...fixture),
      /CORE_MIGRATION_STAGE_INPUT_INVALID/,
    )
  }
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

test('stage B remains unexposed until its preflight succeeds', async (t) => {
  const module = await loadApplyModule()
  assert.ok(module, 'core migration stage command must exist')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bwm-core-stage-preflight-')))
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
  module.generateCoreMigrationStage({
    configPath,
    outputRoot,
    sourceDirectory,
    stage: 'stage-a',
  })
  const active = join(outputRoot, 'active')
  let preflightCalls = 0

  assert.throws(() => module.exposeCoreMigrationStage({
    configPath,
    outputRoot,
    preflightStageB: () => {
      preflightCalls += 1
      throw new Error('CORE_MIGRATION_STAGE_PREFLIGHT_FAILED')
    },
    sourceDirectory,
    stage: 'stage-b',
  }), /CORE_MIGRATION_STAGE_PREFLIGHT_FAILED/)
  assert.equal(preflightCalls, 1)
  assert.deepEqual(readdirSync(active).sort(), STAGE_A_NAMES)

  const exposed = module.exposeCoreMigrationStage({
    configPath,
    outputRoot,
    preflightStageB: () => {
      preflightCalls += 1
      return { ready: true }
    },
    sourceDirectory,
    stage: 'stage-b',
  })
  assert.equal(preflightCalls, 2)
  assert.deepEqual(exposed.names, STAGE_B_NAMES)
  assert.deepEqual(readdirSync(active), STAGE_B_NAMES)
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

  assert.throws(() => module.generateCoreMigrationStage({
    configPath,
    outputRoot,
    sourceDirectory,
    stage: 'stage-a',
  }), /CORE_MIGRATION_STAGE_INVALID/)
  assert.deepEqual(readdirSync(external), [])
})
