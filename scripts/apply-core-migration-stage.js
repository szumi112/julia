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
  selectCoreMigrationStage,
} from './core-migration-stages.js'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = realpathSync(resolve(SCRIPT_DIRECTORY, '..'))
const WRANGLER_SCRIPT = realpathSync(join(PROJECT_ROOT, 'node_modules/wrangler/bin/wrangler.js'))
const SOURCE_DIRECTORY = realpathSync(join(PROJECT_ROOT, 'migrations'))
const OUTPUT_ROOT = join(PROJECT_ROOT, '.core-migrations')

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

export function materializeCoreMigrationStage({
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

export function generateCoreMigrationStage({
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

export function normalizeCoreMigrationStageInput(env, argv = []) {
  if (!env
    || typeof env !== 'object'
    || Array.isArray(env)
    || env.APP_ENV === 'production'
    || env.CLOUDFLARE_ENV === 'production'
    || env.DATA_MODE !== 'fictional'
    || !Array.isArray(argv)
    || (argv.length !== 1 && argv.length !== 2)
    || argv[0] !== 'stage-a'
    || (argv.length === 2 && argv[1] !== '--local')) {
    fail('CORE_MIGRATION_STAGE_INPUT_INVALID')
  }
  return Object.freeze({
    local: argv[1] === '--local',
    stage: 'stage-a',
  })
}

export function runCoreMigrationStage({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const input = normalizeCoreMigrationStageInput(env, argv)
  const generated = generateCoreMigrationStage({
    configPath: join(PROJECT_ROOT, 'wrangler.json'),
    outputRoot: OUTPUT_ROOT,
    sourceDirectory: SOURCE_DIRECTORY,
    stage: input.stage,
  })
  if (generated.names.length !== CORE_MIGRATION_STAGE_A_NAMES.length) fail()
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
