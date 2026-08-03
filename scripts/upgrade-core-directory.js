import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { advanceCoreDirectoryUpgrade } from './upgrade-core-directory-core.js'
import {
  LOCAL_HARNESS_RUNNER_MODE,
  LOCAL_HARNESS_WRANGLER_NAME,
} from './local-harness-core.js'
import { createKeyring } from '../worker/security/keyring.js'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = realpathSync(resolve(SCRIPT_DIRECTORY, '..'))
const WRANGLER_CONFIG = realpathSync(join(PROJECT_ROOT, 'wrangler.json'))
const WRANGLER_SCRIPT = realpathSync(
  join(PROJECT_ROOT, 'node_modules/wrangler/bin/wrangler.js'),
)
const NODE_EXECUTABLE = realpathSync(process.execPath)
const CHILD_DEADLINE_MS = 30_000
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024
const RESULT_KEYS = Object.freeze(['meta', 'results', 'success'])
const SCOPE = Object.freeze({ id: 'centre_1', purpose: 'identity', type: 'staff_directory' })

const invalidInput = () => { throw new Error('CORE_DIRECTORY_UPGRADE_INPUT_INVALID') }
const ownObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const validResult = (value) => ownObject(value)
  && ['pending', 'running', 'complete'].includes(value.status)
  && Number.isSafeInteger(value.processedCount)
  && value.processedCount >= 0
  && Number.isSafeInteger(value.createdCount)
  && value.createdCount >= 0
  && value.createdCount <= value.processedCount

export function normalizeCoreDirectoryUpgradeInput(env, argv = []) {
  if (!env
    || typeof env !== 'object'
    || Array.isArray(env)
    || !Array.isArray(argv)
    || argv.length !== 0
    || env.APP_ENV !== 'development'
    || env.CLOUDFLARE_ENV === 'production'
    || env.DATA_MODE !== 'fictional') invalidInput()
  const raw = env.CORE_DIRECTORY_MAX_STEPS
  const maxSteps = raw === undefined ? 25 : Number(raw)
  if ((raw !== undefined && (!/^(?:[1-9]|[1-9]\d|100)$/.test(raw)))
    || !Number.isSafeInteger(maxSteps)
    || maxSteps < 1
    || maxSteps > 100) invalidInput()
  return Object.freeze({ maxSteps })
}

const safeChildEnv = (env, cwd) => Object.freeze({
  CI: '1',
  CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:1',
  CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  HOME: cwd,
  LANG: 'C',
  LC_ALL: 'C',
  NODE_DISABLE_COMPILE_CACHE: '1',
  NO_COLOR: '1',
  TMPDIR: cwd,
  WRANGLER_HIDE_BANNER: 'true',
  WRANGLER_LOG_SANITIZE: 'true',
  WRANGLER_SEND_ERROR_REPORTS: 'false',
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_WRITE_LOGS: 'false',
  XDG_CACHE_HOME: cwd,
  XDG_CONFIG_HOME: cwd,
  XDG_DATA_HOME: cwd,
  ...(env.BWM_APP_E2E_OWNERSHIP
    ? { BWM_APP_E2E_OWNERSHIP: env.BWM_APP_E2E_OWNERSHIP }
    : {}),
})

const validCell = (value) => value === null
  || typeof value === 'string'
  || (typeof value === 'number' && Number.isFinite(value))

const parseResults = (stdout) => {
  let parsed
  try { parsed = JSON.parse(stdout) } catch { throw new Error('CORE_DIRECTORY_D1_RESPONSE_INVALID') }
  if (!Array.isArray(parsed)
    || parsed.length < 1
    || parsed.some((entry) => !exactKeys(entry, RESULT_KEYS)
      || entry.success !== true
      || !ownObject(entry.meta)
      || !Array.isArray(entry.results)
      || entry.results.some((row) => !ownObject(row)
        || Object.values(row).some((cell) => !validCell(cell))))) {
    throw new Error('CORE_DIRECTORY_D1_RESPONSE_INVALID')
  }
  return parsed
}

export function runWranglerCommand(invocation, {
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!exactKeys(invocation, ['args', 'cwd', 'env', 'executable'])
    || !Array.isArray(invocation.args)
    || invocation.args.some((value) => typeof value !== 'string')
    || typeof invocation.cwd !== 'string'
    || !ownObject(invocation.env)
    || typeof invocation.executable !== 'string'
    || typeof spawnSyncImpl !== 'function') {
    throw new Error('CORE_DIRECTORY_D1_REFUSED')
  }
  let child
  try {
    child = spawnSyncImpl(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      encoding: 'utf8',
      env: invocation.env,
      maxBuffer: MAX_CHILD_OUTPUT_BYTES,
      shell: false,
      timeout: CHILD_DEADLINE_MS,
    })
  } catch {
    throw new Error('CORE_DIRECTORY_D1_AMBIGUOUS')
  }
  if (!child
    || child.error
    || child.signal !== null
    || !Number.isInteger(child.status)) {
    throw new Error('CORE_DIRECTORY_D1_AMBIGUOUS')
  }
  if (child.status !== 0) throw new Error('CORE_DIRECTORY_D1_REFUSED')
  if (child.stderr !== '' || typeof child.stdout !== 'string') {
    throw new Error('CORE_DIRECTORY_D1_RESPONSE_INVALID')
  }
  return parseResults(child.stdout)
}

const sqlLiteral = (value) => {
  if (value === null) return 'NULL'
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value !== 'string') throw new Error('CORE_DIRECTORY_D1_REFUSED')
  const bytes = new TextEncoder().encode(value)
  try {
    return `CAST(X'${[...bytes]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}' AS TEXT)`
  } finally {
    bytes.fill(0)
  }
}

const boundSql = ({ params, sql }) => {
  let index = 0
  const result = sql.replaceAll('?', () => {
    if (index >= params.length) throw new Error('CORE_DIRECTORY_D1_REFUSED')
    const literal = sqlLiteral(params[index])
    index += 1
    return literal
  })
  if (index !== params.length) throw new Error('CORE_DIRECTORY_D1_REFUSED')
  return result
}

const d1Target = (env) => {
  const runner = env.BWM_LOCAL_RUNNER_MODE === LOCAL_HARNESS_RUNNER_MODE
  if (env.BWM_LOCAL_RUNNER_MODE !== undefined && !runner) invalidInput()
  if (!runner) {
    return Object.freeze({
      configPath: WRANGLER_CONFIG,
      cwd: PROJECT_ROOT,
      persistencePath: null,
    })
  }
  const persistencePath = env.BWM_LOCAL_PERSISTENCE_PATH
  if (typeof persistencePath !== 'string'
    || !isAbsolute(persistencePath)
    || resolve(persistencePath) !== persistencePath
    || realpathSync(persistencePath) !== persistencePath) invalidInput()
  const root = realpathSync(dirname(persistencePath))
  const configPath = realpathSync(join(root, LOCAL_HARNESS_WRANGLER_NAME))
  return Object.freeze({ configPath, cwd: root, persistencePath })
}

export function createWranglerD1Facade(env, {
  runCommand = runWranglerCommand,
} = {}) {
  const target = d1Target(env)
  const descriptors = new WeakMap()
  const execute = (statements) => {
    const command = `${statements.map((statement) => boundSql(statement)).join(';\n')};`
    const args = [
      WRANGLER_SCRIPT,
      '--config',
      target.configPath,
      '--x-provision=false',
      '--x-auto-create=false',
      '--install-skills=false',
      'd1',
      'execute',
      'DB',
      '--local',
      ...(target.persistencePath ? ['--persist-to', target.persistencePath] : []),
      '--command',
      command,
      '--json',
    ]
    const results = runCommand({
      args,
      cwd: target.cwd,
      env: safeChildEnv(env, target.cwd),
      executable: NODE_EXECUTABLE,
    })
    if (results.length !== statements.length) {
      throw new Error('CORE_DIRECTORY_D1_RESPONSE_INVALID')
    }
    return results
  }
  const prepare = (sql) => {
    if (typeof sql !== 'string' || !sql.trim() || sql.includes(';')) {
      throw new Error('CORE_DIRECTORY_D1_REFUSED')
    }
    const descriptor = { params: [], sql }
    const statement = {
      all: async () => execute([descriptor])[0],
      bind: (...params) => {
        descriptor.params = params
        return statement
      },
      first: async () => execute([descriptor])[0].results[0] ?? null,
      run: async () => execute([descriptor])[0],
    }
    descriptors.set(statement, descriptor)
    return statement
  }
  return Object.freeze({
    batch: async (statements) => {
      if (!Array.isArray(statements)
        || statements.length < 1
        || statements.some((statement) => !descriptors.has(statement))) {
        throw new Error('CORE_DIRECTORY_D1_REFUSED')
      }
      return execute(statements.map((statement) => descriptors.get(statement)))
    },
    prepare,
  })
}

async function loadStaffDirectoryCryptoContext(db, env) {
  const keyring = await createKeyring(env, {
    activeBackupKekVersion: 1,
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
  })
  const rows = (await db.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,
            wrap_nonce_b64,kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type='staff_directory' AND scope_id='centre_1'
       AND purpose='identity' AND retired_at IS NULL
     ORDER BY dek_version DESC
     LIMIT 2`
  ).all()).results
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('CORE_DIRECTORY_UPGRADE_INVALID')
  }
  return Object.freeze({ dataKey: rows[0], keyring, scope: SCOPE })
}

const defaultIdFactory = (kind) => `${kind === 'version' ? 'ver' : 'aud'}_${randomUUID().replaceAll('-', '')}`

export async function runCoreDirectoryUpgradeCli({
  argv = process.argv.slice(2),
  env = process.env,
  stderr = process.stderr,
  stdout = process.stdout,
  deps = {},
} = {}) {
  let input
  try {
    input = normalizeCoreDirectoryUpgradeInput(env, argv)
  } catch {
    stderr.write('CORE_DIRECTORY_UPGRADE_FAILED\n')
    return 1
  }
  try {
    const db = await (deps.createDb ?? createWranglerD1Facade)(env)
    const advance = deps.advance ?? advanceCoreDirectoryUpgrade
    const loadCryptoContext = deps.loadCryptoContext ?? ((targetDb) => (
      loadStaffDirectoryCryptoContext(targetDb, env)
    ))
    const now = deps.now ?? Date.now
    const idFactory = deps.idFactory ?? defaultIdFactory
    let cryptoContext = null
    let cryptoLoaded = false
    let result = null
    for (let step = 0; step < input.maxSteps; step += 1) {
      try {
        result = await advance({
          correlationId: randomUUID(),
          cryptoContext,
          db,
          idFactory,
          nowMs: now(),
        })
      } catch (error) {
        if (error?.message !== 'CORE_DIRECTORY_CRYPTO_REQUIRED' || cryptoLoaded) throw error
        cryptoContext = await loadCryptoContext(db)
        cryptoLoaded = true
        step -= 1
        continue
      }
      if (!validResult(result)) throw new Error('CORE_DIRECTORY_UPGRADE_INVALID')
      if (result.status === 'complete') {
        stdout.write(`${JSON.stringify({
          createdCount: result.createdCount,
          processedCount: result.processedCount,
          status: result.status,
        })}\n`)
        return 0
      }
    }
    if (!validResult(result)) throw new Error('CORE_DIRECTORY_UPGRADE_INVALID')
    stdout.write(`${JSON.stringify({
      createdCount: result.createdCount,
      processedCount: result.processedCount,
      status: result.status,
    })}\n`)
    return 2
  } catch {
    stderr.write('CORE_DIRECTORY_UPGRADE_FAILED\n')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCoreDirectoryUpgradeCli()
}
