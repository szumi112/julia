import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildLocalSeedBatch,
  inspectLocalSeedState,
  LOCAL_SEED_MANIFEST,
  LOCAL_SEED_SNAPSHOT_QUERIES,
  serializeLocalSeedBatch,
} from './seed-core.js'
import { decodeBase64Url, encodeBase64Url } from '../worker/security/encoding.js'
import { createKeyring } from '../worker/security/keyring.js'
import {
  buildLocalHarnessWranglerConfig,
  LOCAL_HARNESS_ACTIVE_MIGRATIONS_NAME,
  LOCAL_HARNESS_MIGRATIONS_NAME,
  LOCAL_HARNESS_RUNNER_MODE,
  LOCAL_HARNESS_WRANGLER_NAME,
} from './local-harness-core.js'
import {
  CORE_MIGRATION_STAGE_A_NAMES,
  CORE_MIGRATION_STAGE_B_NAMES,
} from './core-migration-stages.js'

export { LOCAL_SEED_MANIFEST } from './seed-core.js'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = realpathSync(resolve(SCRIPT_DIRECTORY, '..'))
const WRANGLER_CONFIG_PATH = realpathSync(join(PROJECT_ROOT, 'wrangler.json'))
const WRANGLER_SCRIPT_PATH = realpathSync(
  join(PROJECT_ROOT, 'node_modules/wrangler/bin/wrangler.js'),
)
const NODE_EXECUTABLE = realpathSync(process.execPath)
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024
const CHILD_DEADLINE_MS = 30_000
const CHILD_KILL_GRACE_MS = 500
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux'])
const RESULT_KEYS = Object.freeze(['meta', 'results', 'success'])
const CORE_MIGRATION_HISTORY_SQL = 'SELECT name FROM d1_migrations ORDER BY id'
const APPLIED_CORE_MIGRATION_NAMES = Object.freeze([
  ...CORE_MIGRATION_STAGE_A_NAMES,
  ...CORE_MIGRATION_STAGE_B_NAMES,
])
const localHarnessConfig = (runnerRoot) => Buffer.from(
  buildLocalHarnessWranglerConfig(
    PROJECT_ROOT,
    join(
      runnerRoot,
      LOCAL_HARNESS_MIGRATIONS_NAME,
      LOCAL_HARNESS_ACTIVE_MIGRATIONS_NAME,
    ),
  ),
  'utf8',
)

const keyValid = (value) => {
  let raw
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false
    raw = decodeBase64Url(value)
    return raw.byteLength === 32 && encodeBase64Url(raw) === value
  } catch {
    return false
  } finally {
    raw?.fill(0)
  }
}
const fail = () => {
  throw new Error('SEED_LOCAL_INPUT_INVALID')
}

const ownObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))

const assertCanonicalComponents = (path) => {
  const root = parse(path).root
  let current = root
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component)
    const stats = lstatSync(current)
    if (stats.isSymbolicLink()) fail()
  }
}

const privateDirectoryFence = (path, expected = null) => {
  if (!SUPPORTED_PLATFORMS.has(process.platform)
    || typeof process.getuid !== 'function') fail()
  assertCanonicalComponents(path)
  const stats = lstatSync(path)
  const canonical = realpathSync(path)
  const fence = {
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
  }
  if (stats.isSymbolicLink()
    || !stats.isDirectory()
    || canonical !== path
    || (stats.mode & 0o777) !== 0o700
    || stats.uid !== process.getuid()
    || (expected && (
      expected.dev !== fence.dev
      || expected.ino !== fence.ino
      || expected.uid !== fence.uid
    ))) fail()
  return Object.freeze(fence)
}

const assertPrivateWranglerConfig = (path, expected = null) => {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)
    || !Number.isInteger(fsConstants.O_NONBLOCK)) fail()
  assertCanonicalComponents(dirname(path))
  let descriptor
  let contents
  const expectedContents = localHarnessConfig(dirname(path))
  try {
    const initialPathStats = lstatSync(path)
    if (initialPathStats.isSymbolicLink()
      || !initialPathStats.isFile()
      || realpathSync(path) !== path
      || (initialPathStats.mode & 0o777) !== 0o600
      || initialPathStats.uid !== process.getuid()
      || initialPathStats.size !== expectedContents.byteLength
      || (expected && !sameIdentity(initialPathStats, expected))) fail()
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    )
    const openedStats = fstatSync(descriptor)
    const openedPathStats = lstatSync(path)
    if (!openedStats.isFile()
      || !sameIdentity(openedStats, initialPathStats)
      || !sameIdentity(openedStats, openedPathStats)
      || (expected && !sameIdentity(openedStats, expected))
      || (openedStats.mode & 0o777) !== 0o600
      || (openedPathStats.mode & 0o777) !== 0o600
      || openedStats.uid !== process.getuid()
      || openedPathStats.uid !== process.getuid()
      || openedStats.size !== expectedContents.byteLength
      || openedPathStats.size !== expectedContents.byteLength) fail()

    contents = Buffer.alloc(expectedContents.byteLength + 1)
    let bytesRead = 0
    while (bytesRead < contents.byteLength) {
      const count = readSync(
        descriptor,
        contents,
        bytesRead,
        contents.byteLength - bytesRead,
        bytesRead,
      )
      if (count === 0) break
      bytesRead += count
    }
    if (bytesRead !== expectedContents.byteLength
      || !contents.subarray(0, bytesRead).equals(expectedContents)
      || readSync(descriptor, contents, 0, 1, bytesRead) !== 0) fail()

    const finalStats = fstatSync(descriptor)
    const finalPathStats = lstatSync(path)
    if (!finalStats.isFile()
      || finalPathStats.isSymbolicLink()
      || !finalPathStats.isFile()
      || realpathSync(path) !== path
      || !sameIdentity(finalStats, initialPathStats)
      || !sameIdentity(finalStats, finalPathStats)
      || (expected && !sameIdentity(finalStats, expected))
      || (finalStats.mode & 0o777) !== 0o600
      || (finalPathStats.mode & 0o777) !== 0o600
      || finalStats.uid !== process.getuid()
      || finalPathStats.uid !== process.getuid()
      || finalStats.size !== expectedContents.byteLength
      || finalPathStats.size !== expectedContents.byteLength) fail()
    return Object.freeze({
      dev: finalStats.dev,
      ino: finalStats.ino,
      uid: finalStats.uid,
    })
  } finally {
    contents?.fill(0)
    expectedContents.fill(0)
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

const assertPersistenceFence = (input) => {
  privateDirectoryFence(input.persistencePath, input.persistenceFence)
  if (input.runnerMode) {
    privateDirectoryFence(input.runnerRootPath, input.runnerRootFence)
    assertPrivateWranglerConfig(
      input.wranglerConfigPath,
      input.wranglerConfigFence,
    )
  }
}

const regularFile = (path) => {
  const canonical = realpathSync(path)
  const stats = lstatSync(canonical)
  if (stats.isSymbolicLink() || !stats.isFile()) fail()
  return canonical
}

export function normalizeLocalSeedInput(env, argv = []) {
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || !Array.isArray(argv) || argv.length !== 0
    || env.APP_ENV !== 'development'
    || env.DATA_MODE !== 'fictional'
    || (env.BWM_LOCAL_RUNNER_MODE !== undefined
      && env.BWM_LOCAL_RUNNER_MODE !== LOCAL_HARNESS_RUNNER_MODE)
    || !keyValid(env.BWM_DATA_KEK_V1)
    || !keyValid(env.BWM_LOOKUP_HMAC_V1)
    || !keyValid(env.BWM_BACKUP_KEK_V1)
    || typeof env.BWM_LOCAL_PERSISTENCE_PATH !== 'string'
    || !isAbsolute(env.BWM_LOCAL_PERSISTENCE_PATH)
    || resolve(env.BWM_LOCAL_PERSISTENCE_PATH) !== env.BWM_LOCAL_PERSISTENCE_PATH) fail()
  let canonical
  let persistenceFence
  let runnerRootFence = null
  let runnerRootPath = null
  let wranglerConfigFence = null
  let wranglerConfigPath = WRANGLER_CONFIG_PATH
  const runnerMode = env.BWM_LOCAL_RUNNER_MODE === LOCAL_HARNESS_RUNNER_MODE
  try {
    canonical = realpathSync(env.BWM_LOCAL_PERSISTENCE_PATH)
    persistenceFence = privateDirectoryFence(canonical)
    if (runnerMode) {
      runnerRootPath = realpathSync(dirname(canonical))
      runnerRootFence = privateDirectoryFence(runnerRootPath)
      wranglerConfigPath = join(runnerRootPath, LOCAL_HARNESS_WRANGLER_NAME)
      wranglerConfigFence = assertPrivateWranglerConfig(wranglerConfigPath)
    }
  } catch {
    fail()
  }
  if (canonical !== env.BWM_LOCAL_PERSISTENCE_PATH) fail()
  return Object.freeze({
    appEnv: 'development',
    dataMode: 'fictional',
    persistenceFence,
    persistencePath: canonical,
    runnerMode,
    runnerRootFence,
    runnerRootPath,
    wranglerConfigFence,
    wranglerConfigPath,
    keys: Object.freeze({
      backup: env.BWM_BACKUP_KEK_V1,
      data: env.BWM_DATA_KEK_V1,
      lookup: env.BWM_LOOKUP_HMAC_V1,
    }),
  })
}

const sameIdentity = (stats, identity) => stats.dev === identity.dev
  && stats.ino === identity.ino
  && stats.uid === identity.uid

const defaultWriteTempSql = async ({ directory, contents, input, mode }) => {
  assertPersistenceFence(input)
  const path = join(directory, `.bwm-seed-${randomBytes(12).toString('hex')}.sql`)
  let fd
  try {
    if (!Number.isInteger(fsConstants.O_NOFOLLOW)) fail()
    fd = openSync(
      path,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      mode,
    )
    writeFileSync(fd, contents, { encoding: 'utf8' })
    fsyncSync(fd)
    const stats = fstatSync(fd)
    const pathStats = lstatSync(path)
    if (!stats.isFile()
      || !sameIdentity(pathStats, stats)
      || (stats.mode & 0o777) !== mode
      || realpathSync(dirname(path)) !== directory) fail()
    return Object.freeze({
      fd,
      identity: Object.freeze({
        dev: stats.dev,
        ino: stats.ino,
        uid: stats.uid,
      }),
      path,
    })
  } catch (error) {
    if (fd !== undefined) {
      try {
        ftruncateSync(fd, 0)
        fsyncSync(fd)
      } catch {
        // Best-effort ciphertext removal through the still-open inode.
      }
      try { closeSync(fd) } catch { /* Already closed. */ }
    }
    try { rmSync(path, { force: true }) } catch { /* Never replace the fixed error. */ }
    throw error
  }
}

const defaultRemoveFile = async (handle) => {
  let safeToUnlink = false
  let cleanupFailed = false
  try {
    const stats = lstatSync(handle.path)
    safeToUnlink = stats.isFile()
      && sameIdentity(stats, handle.identity)
      && (stats.mode & 0o777) === 0o600
  } catch {
    cleanupFailed = true
  }
  try {
    ftruncateSync(handle.fd, 0)
    fsyncSync(handle.fd)
  } catch {
    cleanupFailed = true
  }
  if (safeToUnlink) {
    try {
      rmSync(handle.path)
    } catch {
      cleanupFailed = true
    }
  } else {
    cleanupFailed = true
  }
  try {
    closeSync(handle.fd)
  } catch {
    cleanupFailed = true
  }
  if (cleanupFailed) fail()
}

const privateChildEnv = (input) => Object.freeze({
  CI: '1',
  CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:1',
  CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  HOME: input.persistencePath,
  LANG: 'C',
  LC_ALL: 'C',
  NODE_DISABLE_COMPILE_CACHE: '1',
  NO_COLOR: '1',
  TMPDIR: input.persistencePath,
  WRANGLER_HIDE_BANNER: 'true',
  WRANGLER_LOG_SANITIZE: 'true',
  WRANGLER_SEND_ERROR_REPORTS: 'false',
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_WRITE_LOGS: 'false',
  XDG_CACHE_HOME: input.persistencePath,
  XDG_CONFIG_HOME: input.persistencePath,
  XDG_DATA_HOME: input.persistencePath,
})

const terminateChild = (child, signal, detached) => {
  if (detached) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to the leader when its owned group is already absent.
    }
  }
  try { child.kill(signal) } catch { /* The child already exited. */ }
}

const processGroupExists = (groupId) => {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const sleep = (milliseconds) => new Promise((resolveWait) => (
  setTimeout(resolveWait, milliseconds)
))

const waitForProcessGroupAbsence = async (groupId, {
  groupExistsImpl,
  sleepImpl,
}) => {
  const attempts = Math.ceil(CHILD_KILL_GRACE_MS / 25)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!groupExistsImpl(groupId)) return true
    await sleepImpl(25)
  }
  return !groupExistsImpl(groupId)
}

const removeDetachedChildGroup = async (groupId, {
  groupExistsImpl,
  signalGroupImpl,
  sleepImpl,
}) => {
  if (!groupExistsImpl(groupId)) return false
  try { signalGroupImpl(groupId, 'SIGTERM') } catch { /* Continue to the bounded proof. */ }
  if (await waitForProcessGroupAbsence(groupId, {
    groupExistsImpl,
    sleepImpl,
  })) return true
  try { signalGroupImpl(groupId, 'SIGKILL') } catch { /* Continue to the bounded proof. */ }
  await waitForProcessGroupAbsence(groupId, {
    groupExistsImpl,
    sleepImpl,
  })
  return true
}

export const runBoundedLocalChild = ({
  args,
  cwd,
  env,
  executable,
  shell,
}, {
  clearTimeoutImpl = clearTimeout,
  deadlineMs = CHILD_DEADLINE_MS,
  detached = true,
  groupExistsImpl = processGroupExists,
  onRetainedChunk = () => {},
  setTimeoutImpl = setTimeout,
  signalGroupImpl = (groupId, signal) => process.kill(-groupId, signal),
  sleep: sleepImpl = sleep,
  spawnImpl = spawn,
} = {}) => new Promise((resolveResult, rejectResult) => {
  if (typeof detached !== 'boolean') {
    rejectResult(new Error('SEED_LOCAL_CHILD_FAILED'))
    return
  }
  let child
  try {
    child = spawnImpl(executable, args, {
      cwd,
      detached,
      env,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    rejectResult(new Error('SEED_LOCAL_CHILD_FAILED'))
    return
  }
  let handleSpawnError = () => {}
  const childErrorListener = () => handleSpawnError()
  child?.once?.('error', childErrorListener)
  if (!child?.stdout?.on
    || !child?.stderr?.on
    || !Number.isSafeInteger(child.pid)
    || child.pid <= 0) {
    const invalidPid = child?.pid
    if (detached && Number.isSafeInteger(invalidPid) && invalidPid > 0) {
      try { terminateChild(child, 'SIGKILL', true) } catch { /* Prove absence below. */ }
      const rejectInvalidChild = () => {
        rejectResult(new Error('SEED_LOCAL_CHILD_FAILED'))
      }
      void removeDetachedChildGroup(invalidPid, {
        groupExistsImpl,
        signalGroupImpl,
        sleepImpl,
      }).then(rejectInvalidChild, rejectInvalidChild)
    } else {
      try { child?.kill?.('SIGKILL') } catch { /* Fixed status only. */ }
      rejectResult(new Error('SEED_LOCAL_CHILD_FAILED'))
    }
    return
  }
  let failure = null
  let finalizing = false
  let stdoutBytes = 0
  let stderrBytes = 0
  const stdout = []
  const stderr = []
  let killTimer = null
  let deadline = null
  let terminalListener = null
  const signalOwnedChild = (signal) => {
    if (detached) {
      try {
        signalGroupImpl(child.pid, signal)
        return
      } catch {
        // Fall back to the leader when its owned group is already absent.
      }
    }
    try { child.kill(signal) } catch { /* The child already exited. */ }
  }
  let finalize = () => {}
  const terminate = (code) => {
    if (failure || finalizing) return
    failure = code
    signalOwnedChild('SIGTERM')
    try {
      killTimer = setTimeoutImpl(() => {
        if (finalizing) return
        signalOwnedChild('SIGKILL')
        finalize({ code: null, signal: null, terminal: false })
      }, CHILD_KILL_GRACE_MS)
    } catch {
      signalOwnedChild('SIGKILL')
      finalize({ code: null, signal: null, terminal: false })
    }
  }
  const collect = (target, chunk, stream) => {
    if (failure) return
    if (!(chunk instanceof Buffer)) {
      terminate('SEED_LOCAL_CHILD_OUTPUT_INVALID')
      return
    }
    if (stream === 'stdout') stdoutBytes += chunk.byteLength
    else stderrBytes += chunk.byteLength
    if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES || stderrBytes > MAX_CHILD_OUTPUT_BYTES) {
      terminate('SEED_LOCAL_CHILD_OUTPUT_INVALID')
      return
    }
    target.push(chunk)
    onRetainedChunk(chunk, stream)
  }
  const stdoutListener = (chunk) => collect(stdout, chunk, 'stdout')
  const stderrListener = (chunk) => collect(stderr, chunk, 'stderr')
  child.stdout.on('data', stdoutListener)
  child.stderr.on('data', stderrListener)
  const removeRetainedListeners = () => {
    child.removeListener?.('error', childErrorListener)
    child.stdout.removeListener?.('data', stdoutListener)
    child.stderr.removeListener?.('data', stderrListener)
    if (terminalListener) {
      child.removeListener?.(detached ? 'close' : 'exit', terminalListener)
    }
  }
  finalize = ({ code, signal, terminal }) => {
    if (finalizing) return
    finalizing = true
    if (deadline !== null) {
      try { clearTimeoutImpl(deadline) } catch { /* Fixed result only. */ }
    }
    if (killTimer !== null) {
      try { clearTimeoutImpl(killTimer) } catch { /* Fixed result only. */ }
    }
    removeRetainedListeners()
    void (async () => {
      let orphaned = false
      if (detached) {
        try {
          orphaned = terminal
            ? await removeDetachedChildGroup(child.pid, {
                groupExistsImpl,
                signalGroupImpl,
                sleepImpl,
              })
            : !(await waitForProcessGroupAbsence(child.pid, {
                groupExistsImpl,
                sleepImpl,
              }))
        } catch {
          orphaned = true
        }
      }
      if (orphaned || failure || code !== 0 || signal !== null) {
        rejectResult(new Error(
          orphaned
            ? 'SEED_LOCAL_CHILD_ORPHANED'
            : (failure ?? 'SEED_LOCAL_CHILD_FAILED'),
        ))
        return
      }
      resolveResult(Object.freeze({
        code,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      }))
    })()
  }
  handleSpawnError = () => terminate('SEED_LOCAL_CHILD_FAILED')
  terminalListener = (code, signal) => finalize({ code, signal, terminal: true })
  child.once(detached ? 'close' : 'exit', terminalListener)
  try {
    deadline = setTimeoutImpl(
      () => terminate('SEED_LOCAL_CHILD_DEADLINE'),
      deadlineMs,
    )
  } catch {
    terminate('SEED_LOCAL_CHILD_FAILED')
  }
})

const defaultRunWrangler = runBoundedLocalChild

const wranglerInvocation = (input, operationArgs) => {
  assertPersistenceFence(input)
  return Object.freeze({
    args: Object.freeze([
      regularFile(WRANGLER_SCRIPT_PATH),
      '--config',
      input.runnerMode
        ? input.wranglerConfigPath
        : regularFile(WRANGLER_CONFIG_PATH),
      '--x-provision=false',
      '--x-auto-create=false',
      '--install-skills=false',
      ...operationArgs,
    ]),
    cwd: input.persistencePath,
    env: privateChildEnv(input),
    executable: regularFile(NODE_EXECUTABLE),
    shell: false,
  })
}

const parseWranglerResults = (value, expectedCount) => {
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('SEED_LOCAL_CHILD_RESPONSE_INVALID')
  }
  if (!Array.isArray(parsed)
    || parsed.length !== expectedCount
    || parsed.some((entry) => !exactKeys(entry, RESULT_KEYS)
      || entry.success !== true
      || !exactKeys(entry.meta, ['duration'])
      || typeof entry.meta.duration !== 'number'
      || !Number.isFinite(entry.meta.duration)
      || entry.meta.duration < 0
      || !Array.isArray(entry.results)
      || entry.results.some((row) => !ownObject(row)
        || Object.values(row).some((cell) => cell !== null
          && typeof cell !== 'string'
          && !(typeof cell === 'number' && Number.isFinite(cell)))))) {
    throw new Error('SEED_LOCAL_CHILD_RESPONSE_INVALID')
  }
  return parsed
}

export function parseLocalSeedMigrationPreflight(rows) {
  if (!Array.isArray(rows)
    || rows.length !== APPLIED_CORE_MIGRATION_NAMES.length
    || rows.some((row, index) => !exactKeys(row, ['name'])
      || row.name !== APPLIED_CORE_MIGRATION_NAMES[index])) {
    throw new Error('SEED_LOCAL_STATE_REFUSED')
  }
  return Object.freeze({ ready: true })
}

const createWranglerInspectionDb = ({ childOptions, input, runWrangler }) => {
  const descriptors = new WeakMap()
  return Object.freeze({
    async batch(statements) {
      if (!Array.isArray(statements)
        || statements.length !== LOCAL_SEED_SNAPSHOT_QUERIES.length
        || statements.some((entry, index) => (
          descriptors.get(entry) !== LOCAL_SEED_SNAPSHOT_QUERIES[index]
        ))) fail()
      const command = `${[
        CORE_MIGRATION_HISTORY_SQL,
        ...LOCAL_SEED_SNAPSHOT_QUERIES,
      ].join(';\n')};`
      const result = await runWrangler(wranglerInvocation(input, [
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        input.persistencePath,
        '--command',
        command,
        '--json',
      ]), childOptions)
      const parsed = parseWranglerResults(
        result.stdout,
        LOCAL_SEED_SNAPSHOT_QUERIES.length + 1,
      )
      parseLocalSeedMigrationPreflight(parsed[0].results)
      return parsed.slice(1)
    },
    prepare(sql) {
      if (!LOCAL_SEED_SNAPSHOT_QUERIES.includes(sql)) fail()
      const prepared = Object.freeze({})
      descriptors.set(prepared, sql)
      return prepared
    },
  })
}

export async function runLocalSeed({
  env = process.env,
  argv = process.argv.slice(2),
  deps = {},
} = {}) {
  let input
  try {
    input = normalizeLocalSeedInput(env, argv)
  } catch {
    return Object.freeze({ code: 'SEED_LOCAL_INPUT_INVALID', ok: false })
  }
  try {
    assertPersistenceFence(input)
    const keyringConfig = Object.freeze({
      activeBackupKekVersion: 1,
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
    })
    const keyring = deps.keyring ?? await createKeyring({
      BWM_BACKUP_KEK_V1: input.keys.backup,
      BWM_DATA_KEK_V1: input.keys.data,
      BWM_LOOKUP_HMAC_V1: input.keys.lookup,
    }, keyringConfig)
    const runWrangler = deps.runWrangler ?? defaultRunWrangler
    const childOptions = Object.freeze({ detached: !input.runnerMode })
    const inspectionDb = createWranglerInspectionDb({ childOptions, input, runWrangler })
    const defaultInspectState = () => inspectLocalSeedState({
      db: inspectionDb,
      keyring,
    })
    const inspectState = deps.inspectState ?? defaultInspectState
    const state = await inspectState(input)
    assertPersistenceFence(input)
    if (state?.kind === 'seeded') {
      return Object.freeze({ code: 'SEED_LOCAL_ALREADY_COMPLETE', ok: true })
    }
    if (state?.kind !== 'empty') {
      return Object.freeze({ code: 'SEED_LOCAL_STATE_REFUSED', ok: false })
    }
    assertPersistenceFence(input)
    const buildSeedBatch = deps.buildSeedBatch ?? buildLocalSeedBatch
    const serializeSeedBatch = deps.serializeSeedBatch ?? serializeLocalSeedBatch
    const built = await buildSeedBatch({ keyring, keyringConfig })
    const contents = serializeSeedBatch(built.batch)
    const writeTempSql = deps.writeTempSql ?? defaultWriteTempSql
    const removeFile = deps.removeFile ?? defaultRemoveFile
    const defaultWriter = !deps.writeTempSql
    const defaultRemover = !deps.removeFile
    let mutationError = null
    let sqlHandle
    let sqlPath
    try {
      sqlHandle = await writeTempSql({
        directory: input.persistencePath,
        contents,
        input,
        mode: 0o600,
      })
      sqlPath = defaultWriter ? sqlHandle?.path : sqlHandle
      if (typeof sqlPath !== 'string'
        || !isAbsolute(sqlPath)
        || dirname(sqlPath) !== input.persistencePath) fail()
      assertPersistenceFence(input)
      const response = await runWrangler(wranglerInvocation(input, [
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        input.persistencePath,
        '--json',
        '--file',
        sqlPath,
      ]), childOptions)
      parseWranglerResults(response.stdout, built.batch.length)
    } catch (error) {
      mutationError = error
    } finally {
      if (sqlPath) {
        await removeFile(defaultRemover ? sqlHandle : sqlPath)
      }
    }
    assertPersistenceFence(input)
    const inspectFinalState = deps.inspectFinalState
      ?? (deps.inspectState ? (() => deps.inspectState(input)) : defaultInspectState)
    const final = await inspectFinalState(input)
    assertPersistenceFence(input)
    if (final?.kind === 'seeded') {
      return mutationError
        ? Object.freeze({ code: 'SEED_LOCAL_ALREADY_COMPLETE', ok: true })
        : Object.freeze({ code: 'SEED_LOCAL_COMPLETE', ok: true })
    }
    if (mutationError) {
      return final?.kind === 'refused'
        ? Object.freeze({ code: 'SEED_LOCAL_STATE_REFUSED', ok: false })
        : Object.freeze({ code: 'SEED_LOCAL_FAILED', ok: false })
    }
    return Object.freeze({ code: 'SEED_LOCAL_STATE_REFUSED', ok: false })
  } catch {
    return Object.freeze({ code: 'SEED_LOCAL_FAILED', ok: false })
  }
}

const runCli = async () => {
  const result = await runLocalSeed()
  process.stdout.write(`${result.code}\n`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}
