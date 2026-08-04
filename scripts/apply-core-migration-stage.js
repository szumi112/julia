import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CORE_MIGRATION_STAGE_A_NAMES,
  CORE_MIGRATION_STAGE_B_NAMES,
  CORE_DIRECTORY_INVARIANT_FAILURE_SQL,
  selectCoreMigrationStage,
} from './core-migration-stages.js'
import {
  LOCAL_HARNESS_ACTIVE_MIGRATIONS_NAME,
  LOCAL_HARNESS_MIGRATIONS_NAME,
  LOCAL_HARNESS_RUNNER_MODE,
  LOCAL_HARNESS_WRANGLER_NAME,
} from './local-harness-core.js'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = realpathSync(resolve(SCRIPT_DIRECTORY, '..'))
const WRANGLER_SCRIPT = realpathSync(join(PROJECT_ROOT, 'node_modules/wrangler/bin/wrangler.js'))
const SOURCE_DIRECTORY = realpathSync(join(PROJECT_ROOT, 'migrations'))
const OUTPUT_ROOT = join(PROJECT_ROOT, '.core-migrations')
const LOCAL_PERSISTENCE_PATH = join(PROJECT_ROOT, '.wrangler/state')
const MAX_PREFLIGHT_OUTPUT_BYTES = 64 * 1024

const fail = (code = 'CORE_MIGRATION_STAGE_INVALID') => {
  throw new Error(code)
}

const assertPrivateDirectory = (path) => {
  const stats = lstatSync(path)
  if (!stats.isDirectory()
    || stats.isSymbolicLink()
    || realpathSync(path) !== path
    || (stats.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && stats.uid !== process.getuid())) fail()
}

const ensurePrivateDirectory = (path) => {
  if (existsSync(path)) {
    const stats = lstatSync(path)
    if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(path) !== path) fail()
    chmodSync(path, 0o700)
  } else {
    mkdirSync(path, { mode: 0o700, recursive: true })
    chmodSync(path, 0o700)
  }
  assertPrivateDirectory(path)
}

const migrationFixtures = (sourceDirectory) => readdirSync(sourceDirectory, {
  withFileTypes: true,
})
  .filter((entry) => entry.name.endsWith('.sql'))
  .map((entry) => {
    const path = join(sourceDirectory, entry.name)
    if (!entry.isFile() || entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) fail()
    return Object.freeze({
      name: entry.name,
      queries: Object.freeze([readFileSync(path, 'utf8')]),
    })
  })
  .sort((left, right) => left.name.localeCompare(right.name))

function materializeCoreMigrationStage({
  sourceDirectory,
  stage,
  targetDirectory,
}) {
  if (typeof sourceDirectory !== 'string'
    || typeof targetDirectory !== 'string'
    || !isAbsolute(sourceDirectory)
    || !isAbsolute(targetDirectory)
    || resolve(sourceDirectory) !== sourceDirectory
    || resolve(targetDirectory) !== targetDirectory
    || sourceDirectory === targetDirectory) fail()
  const source = realpathSync(sourceDirectory)
  if (source !== sourceDirectory) fail()
  if (!statSync(source).isDirectory()) fail()
  const selected = selectCoreMigrationStage(migrationFixtures(source), stage)
  const parent = dirname(targetDirectory)
  ensurePrivateDirectory(parent)
  if (existsSync(targetDirectory)) assertPrivateDirectory(targetDirectory)
  const pending = mkdtempSync(join(parent, '.pending-'))
  chmodSync(pending, 0o700)
  try {
    for (const { name } of selected) {
      const from = join(source, name)
      const to = join(pending, name)
      copyFileSync(from, to)
      chmodSync(to, 0o600)
    }
    rmSync(targetDirectory, { force: true, recursive: true })
    renameSync(pending, targetDirectory)
  } catch (error) {
    rmSync(pending, { force: true, recursive: true })
    throw error
  }
  return Object.freeze({
    migrationsDirectory: targetDirectory,
    names: Object.freeze(selected.map(({ name }) => name)),
  })
}

function generateCoreMigrationStage({
  configPath,
  outputRoot,
  sourceDirectory,
  stage,
}) {
  if (typeof configPath !== 'string'
    || typeof outputRoot !== 'string'
    || !isAbsolute(configPath)
    || !isAbsolute(outputRoot)
    || resolve(configPath) !== configPath
    || resolve(outputRoot) !== outputRoot) fail()
  const configStats = lstatSync(configPath)
  if (!configStats.isFile()
    || configStats.isSymbolicLink()
    || realpathSync(configPath) !== configPath) fail()
  const sourceConfig = JSON.parse(readFileSync(configPath, 'utf8'))
  const databases = sourceConfig?.d1_databases
  if (!Array.isArray(databases)
    || databases.length !== 1
    || databases[0]?.binding !== 'DB') fail()
  const migrationsDirectory = join(outputRoot, 'active')
  const materialized = materializeCoreMigrationStage({
    sourceDirectory,
    stage,
    targetDirectory: migrationsDirectory,
  })
  const generatedConfig = {
    ...sourceConfig,
    main: isAbsolute(sourceConfig.main)
      ? sourceConfig.main
      : resolve(dirname(configPath), sourceConfig.main),
    d1_databases: [{
      ...databases[0],
      migrations_dir: migrationsDirectory,
    }],
  }
  const generatedConfigPath = join(outputRoot, `wrangler.${stage}.json`)
  if (existsSync(generatedConfigPath)) {
    const generatedStats = lstatSync(generatedConfigPath)
    if (!generatedStats.isFile() || generatedStats.isSymbolicLink()) fail()
  }
  const pendingConfigPath = join(outputRoot, `.wrangler-${process.pid}-${Date.now()}.json`)
  writeFileSync(pendingConfigPath, `${JSON.stringify(generatedConfig, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  chmodSync(pendingConfigPath, 0o600)
  renameSync(pendingConfigPath, generatedConfigPath)
  return Object.freeze({
    configPath: generatedConfigPath,
    ...materialized,
  })
}

export function materializeCoreMigrationStageA(input) {
  if (!input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).length !== 2
    || !Object.hasOwn(input, 'sourceDirectory')
    || !Object.hasOwn(input, 'targetDirectory')) fail()
  return materializeCoreMigrationStage({
    ...input,
    stage: 'stage-a',
  })
}

export function generateCoreMigrationStageA(input) {
  if (!input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).length !== 3
    || !Object.hasOwn(input, 'configPath')
    || !Object.hasOwn(input, 'outputRoot')
    || !Object.hasOwn(input, 'sourceDirectory')) fail()
  return generateCoreMigrationStage({
    ...input,
    stage: 'stage-a',
  })
}

export function normalizeCoreMigrationStageInput(env, argv = []) {
  if (!env
    || typeof env !== 'object'
    || Array.isArray(env)
    || env.APP_ENV === 'production'
    || env.CLOUDFLARE_ENV === 'production'
    || env.DATA_MODE !== 'fictional'
    || !Array.isArray(argv)
    || (argv.length !== 1 && argv.length !== 2)
    || !['stage-a', 'stage-b'].includes(argv[0])
    || (argv.length === 2 && argv[1] !== '--local')) {
    fail('CORE_MIGRATION_STAGE_INPUT_INVALID')
  }
  return Object.freeze({
    local: argv[1] === '--local',
    stage: argv[0],
  })
}

export function parseCoreMigrationStageBPreflight(stdout) {
  let parsed
  try { parsed = JSON.parse(stdout) } catch { fail('CORE_MIGRATION_STAGE_PREFLIGHT_FAILED') }
  if (!Array.isArray(parsed)
    || parsed.length !== 1
    || !parsed[0]
    || typeof parsed[0] !== 'object'
    || Array.isArray(parsed[0])
    || Object.keys(parsed[0]).length !== 3
    || !Object.hasOwn(parsed[0], 'meta')
    || !Object.hasOwn(parsed[0], 'results')
    || !Object.hasOwn(parsed[0], 'success')
    || parsed[0].success !== true
    || !parsed[0].meta
    || typeof parsed[0].meta !== 'object'
    || Array.isArray(parsed[0].meta)
    || !Array.isArray(parsed[0].results)
    || parsed[0].results.length !== 0) {
    fail('CORE_MIGRATION_STAGE_PREFLIGHT_FAILED')
  }
  return Object.freeze({ ready: true })
}

const runnerTarget = (env, input) => {
  const runner = env.BWM_LOCAL_RUNNER_MODE === LOCAL_HARNESS_RUNNER_MODE
  if (env.BWM_LOCAL_RUNNER_MODE !== undefined && !runner) {
    fail('CORE_MIGRATION_STAGE_INPUT_INVALID')
  }
  if (!runner) {
    return Object.freeze({
      configPath: join(PROJECT_ROOT, 'wrangler.json'),
      migrationsDirectory: null,
      outputRoot: OUTPUT_ROOT,
      persistencePath: input.local ? LOCAL_PERSISTENCE_PATH : null,
    })
  }
  if (!input.local
    || typeof env.BWM_LOCAL_PERSISTENCE_PATH !== 'string'
    || !isAbsolute(env.BWM_LOCAL_PERSISTENCE_PATH)
    || resolve(env.BWM_LOCAL_PERSISTENCE_PATH) !== env.BWM_LOCAL_PERSISTENCE_PATH) {
    fail('CORE_MIGRATION_STAGE_INPUT_INVALID')
  }
  const persistencePath = realpathSync(env.BWM_LOCAL_PERSISTENCE_PATH)
  const root = realpathSync(dirname(persistencePath))
  const outputRoot = realpathSync(join(root, LOCAL_HARNESS_MIGRATIONS_NAME))
  assertPrivateDirectory(outputRoot)
  return Object.freeze({
    configPath: realpathSync(join(root, LOCAL_HARNESS_WRANGLER_NAME)),
    migrationsDirectory: join(outputRoot, LOCAL_HARNESS_ACTIVE_MIGRATIONS_NAME),
    outputRoot,
    persistencePath,
  })
}

const preflightCoreMigrationStageB = ({ configPath, env, input, persistencePath }) => {
  const args = [
    WRANGLER_SCRIPT,
    '--config',
    configPath,
    '--x-provision=false',
    '--x-auto-create=false',
    '--install-skills=false',
    'd1',
    'execute',
    'DB',
    ...(input.local ? ['--local'] : []),
    ...(persistencePath ? ['--persist-to', persistencePath] : []),
    '--command',
    CORE_DIRECTORY_INVARIANT_FAILURE_SQL,
    '--json',
  ]
  const child = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: MAX_PREFLIGHT_OUTPUT_BYTES,
    shell: false,
  })
  if (child.error
    || child.signal !== null
    || child.status !== 0
    || typeof child.stdout !== 'string') {
    fail('CORE_MIGRATION_STAGE_PREFLIGHT_FAILED')
  }
  return parseCoreMigrationStageBPreflight(child.stdout)
}

export function runCoreMigrationStage({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const input = normalizeCoreMigrationStageInput(env, argv)
  const target = runnerTarget(env, input)
  if (input.stage === 'stage-b') {
    const ready = preflightCoreMigrationStageB({
      configPath: target.configPath,
      env,
      input,
      persistencePath: target.persistencePath,
    })
    if (ready.ready !== true) fail('CORE_MIGRATION_STAGE_PREFLIGHT_FAILED')
  }
  const generated = target.migrationsDirectory
    ? {
        configPath: target.configPath,
        ...materializeCoreMigrationStage({
          sourceDirectory: SOURCE_DIRECTORY,
          stage: input.stage,
          targetDirectory: target.migrationsDirectory,
        }),
      }
    : generateCoreMigrationStage({
        configPath: target.configPath,
        outputRoot: target.outputRoot,
        sourceDirectory: SOURCE_DIRECTORY,
        stage: input.stage,
      })
  const expectedNames = input.stage === 'stage-a'
    ? CORE_MIGRATION_STAGE_A_NAMES
    : CORE_MIGRATION_STAGE_B_NAMES
  if (generated.names.length !== expectedNames.length) fail()
  const args = [
    WRANGLER_SCRIPT,
    '--config',
    generated.configPath,
    '--x-provision=false',
    '--x-auto-create=false',
    '--install-skills=false',
    'd1',
    'migrations',
    'apply',
    'DB',
    ...(input.local ? ['--local'] : []),
    ...(target.persistencePath ? ['--persist-to', target.persistencePath] : []),
  ]
  const child = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env,
    shell: false,
    stdio: 'inherit',
  })
  return Number.isInteger(child.status) ? child.status : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runCoreMigrationStage()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
