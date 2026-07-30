import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { constants as osConstants, tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import {
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CAPABILITIES } from '../worker/identity/policy.js'
import {
  buildLocalHarnessWranglerConfig,
  LOCAL_HARNESS_RUNNER_MODE,
  LOCAL_HARNESS_WRANGLER_NAME,
} from './local-harness-core.js'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = realpathSync(resolve(SCRIPT_DIRECTORY, '..'))
const NODE_EXECUTABLE = realpathSync(process.execPath)
const WRANGLER_SCRIPT_PATH = realpathSync(join(PROJECT_ROOT, 'node_modules/wrangler/bin/wrangler.js'))
const VITE_SCRIPT_PATH = realpathSync(join(PROJECT_ROOT, 'node_modules/vite/bin/vite.js'))
const SEED_SCRIPT_PATH = realpathSync(join(PROJECT_ROOT, 'scripts/seed-local.mjs'))
const REACT_PACKAGE_PATH = realpathSync(join(PROJECT_ROOT, 'node_modules/react'))
const REACT_DOM_PACKAGE_PATH = realpathSync(join(PROJECT_ROOT, 'node_modules/react-dom'))
const PS_EXECUTABLE = realpathSync('/bin/ps')
const REACT_PLUGIN_URL = pathToFileURL(
  realpathSync(join(PROJECT_ROOT, 'node_modules/@vitejs/plugin-react/dist/index.js')),
).href
const CLOUDFLARE_PLUGIN_URL = pathToFileURL(
  realpathSync(join(PROJECT_ROOT, 'node_modules/@cloudflare/vite-plugin/dist/index.mjs')),
).href
const VITE_MODULE_URL = pathToFileURL(
  realpathSync(join(PROJECT_ROOT, 'node_modules/vite/dist/node/index.js')),
).href
const HOST = '127.0.0.1'
const PORT = 5174
const READY_URL = 'http://127.0.0.1:5174/api/v1/session'
const READY_IDENTITY = 'owner@example.test'
const EXPECTED_CSP = "default-src 'none'"
const DEFAULT_ATTEMPTS = 120
const MAX_READINESS_BODY_BYTES = 16 * 1024
const CHILD_DEADLINE_MS = 30_000
const CHILD_KILL_GRACE_MS = 500
const OWNERSHIP_STABILITY_SCANS = 8
const OWNERSHIP_STABLE_PASSES = 2
const FETCH_DEADLINE_MS = 2_000
const PORT_PROBE_DEADLINE_MS = 500
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024
const MAX_ARTIFACT_FILES = 10_000
const MAX_ARTIFACT_DIRECTORIES = 10_000
const MAX_ARTIFACT_DEPTH = 32
const MAX_ARTIFACT_FILE_BYTES = 64 * 1024 * 1024
const MAX_ARTIFACT_TOTAL_BYTES = 512 * 1024 * 1024
const OWNERSHIP_ENV = 'BWM_APP_E2E_OWNERSHIP'
const OWNERSHIP_TOKEN = /^[a-f0-9]{48}$/
const PROCESS_SIGNALS = new Set(Object.keys(osConstants.signals))
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux'])
const PRIVATE_VITE_NAME = '.bwm-harness-vite.mjs'
const PRIVATE_INDEX_NAME = 'index.html'
const PRIVATE_STATE_NAME = 'state'
const PRIVATE_VITE_ROOT_NAME = 'vite-root'
const PRIVATE_HOME_NAME = 'home'
const PRIVATE_TMP_NAME = 'tmp'
const PRIVATE_XDG_CACHE_NAME = 'xdg-cache'
const PRIVATE_XDG_CONFIG_NAME = 'xdg-config'
const PRIVATE_XDG_DATA_NAME = 'xdg-data'
const KEY_NAMES = Object.freeze([
  'BWM_BACKUP_KEK_V1',
  'BWM_DATA_KEK_V1',
  'BWM_LOOKUP_HMAC_V1',
])
const PHASE = Object.freeze({
  init: 0,
  prepared: 1,
  migrating: 2,
  seeding: 3,
  starting: 4,
  readiness: 5,
  ready: 6,
  stopping: 7,
  closed: 8,
})
const MANAGED_CHILDREN = new WeakMap()
const CHILD_EXIT_PROMISES = new WeakMap()

const fail = (code) => {
  throw new Error(code)
}
const ownObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => ownObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))

const sameIdentity = (stats, identity) => stats.dev === identity.dev
  && stats.ino === identity.ino
  && stats.uid === identity.uid

const assertCanonicalComponents = (path) => {
  const root = parse(path).root
  let current = root
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component)
    if (lstatSync(current).isSymbolicLink()) fail('APP_E2E_HARNESS_INVALID')
  }
}

const privateDirectoryFence = (path, expected = null) => {
  if (!SUPPORTED_PLATFORMS.has(process.platform)
    || typeof process.getuid !== 'function'
    || typeof path !== 'string'
    || !path
    || resolve(path) !== path) fail('APP_E2E_HARNESS_INVALID')
  assertCanonicalComponents(path)
  const stats = lstatSync(path)
  const canonical = realpathSync(path)
  const fence = Object.freeze({ dev: stats.dev, ino: stats.ino, uid: stats.uid })
  if (!stats.isDirectory()
    || stats.isSymbolicLink()
    || canonical !== path
    || (stats.mode & 0o777) !== 0o700
    || stats.uid !== process.getuid()
    || (expected && !sameIdentity(stats, expected))) fail('APP_E2E_HARNESS_INVALID')
  return fence
}

const regularFileFence = (path, expected = null) => {
  assertCanonicalComponents(path)
  const stats = lstatSync(path)
  const fence = Object.freeze({ dev: stats.dev, ino: stats.ino, uid: stats.uid })
  if (!stats.isFile()
    || stats.isSymbolicLink()
    || realpathSync(path) !== path
    || (stats.mode & 0o777) !== 0o600
    || stats.uid !== process.getuid()
    || (expected && !sameIdentity(stats, expected))) fail('APP_E2E_HARNESS_INVALID')
  return fence
}

const regularExecutable = (path) => {
  const canonical = realpathSync(path)
  const stats = statSync(canonical)
  if (!stats.isFile()) fail('APP_E2E_HARNESS_INVALID')
  return canonical
}

const writePrivateFile = (root, name, contents) => {
  privateDirectoryFence(root)
  const path = join(root, name)
  let descriptor
  try {
    if (!Number.isInteger(fsConstants.O_NOFOLLOW)) fail('APP_E2E_HARNESS_INVALID')
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(descriptor, contents, { encoding: 'utf8' })
    fsyncSync(descriptor)
    const descriptorStats = fstatSync(descriptor)
    const pathStats = lstatSync(path)
    if (!descriptorStats.isFile()
      || !sameIdentity(descriptorStats, pathStats)
      || (descriptorStats.mode & 0o777) !== 0o600) fail('APP_E2E_HARNESS_INVALID')
    closeSync(descriptor)
    descriptor = undefined
    const bytes = Buffer.from(contents, 'utf8')
    return Object.freeze({
      digest: createHash('sha256').update(bytes).digest('hex'),
      fence: regularFileFence(path),
      path,
      size: bytes.byteLength,
    })
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* Fixed status only. */ }
    }
    throw error
  }
}

const assertPrivateFile = (file) => {
  if (!exactKeys(file, ['digest', 'fence', 'path', 'size'])
    || !/^[a-f0-9]{64}$/.test(file.digest)
    || !Number.isSafeInteger(file.size)
    || file.size < 0) fail('APP_E2E_HARNESS_INVALID')
  let descriptor
  try {
    descriptor = openSync(file.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stats = fstatSync(descriptor)
    const pathStats = lstatSync(file.path)
    if (!stats.isFile()
      || !sameIdentity(stats, file.fence)
      || !sameIdentity(stats, pathStats)
      || (stats.mode & 0o777) !== 0o600
      || stats.size !== file.size) fail('APP_E2E_HARNESS_INVALID')
    const bytes = readFileSync(descriptor)
    if (bytes.byteLength !== file.size
      || createHash('sha256').update(bytes).digest('hex') !== file.digest) {
      fail('APP_E2E_HARNESS_INVALID')
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

const privateViteConfig = ({ root, statePath, wranglerConfigPath }) => {
  return `import { Buffer } from 'node:buffer'
import { cloudflare } from ${JSON.stringify(CLOUDFLARE_PLUGIN_URL)}
import react from ${JSON.stringify(REACT_PLUGIN_URL)}
import { defineConfig } from ${JSON.stringify(VITE_MODULE_URL)}

const names = Object.freeze(${JSON.stringify(KEY_NAMES)})
const secretVars = Object.fromEntries(names.map((name) => {
  const value = process.env[name]
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('APP_E2E_VITE_SECRET_INVALID')
  }
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== value) {
    bytes.fill(0)
    throw new Error('APP_E2E_VITE_SECRET_INVALID')
  }
  bytes.fill(0)
  return [name, value]
}))

export default defineConfig({
  base: '/',
  cacheDir: ${JSON.stringify(join(root, '.vite-cache'))},
  envDir: false,
  plugins: [
    react(),
    ...cloudflare({
      configPath: ${JSON.stringify(wranglerConfigPath)},
      config: (config) => ({ vars: { ...config.vars, ...secretVars } }),
      inspectorPort: false,
      persistState: { path: ${JSON.stringify(statePath)} },
      remoteBindings: false,
    }),
  ],
  publicDir: false,
  resolve: {
    alias: {
      react: ${JSON.stringify(REACT_PACKAGE_PATH)},
      'react-dom': ${JSON.stringify(REACT_DOM_PACKAGE_PATH)},
    },
    dedupe: ['react', 'react-dom'],
  },
  root: ${JSON.stringify(root)},
  server: {
    fs: {
      allow: [${JSON.stringify(root)}, ${JSON.stringify(PROJECT_ROOT)}],
      strict: true,
    },
    host: ${JSON.stringify(HOST)},
    port: ${PORT},
    strictPort: true,
  },
})
`
}

const privateIndex = () => {
  const source = `/@fs/${join(PROJECT_ROOT, 'src/main.jsx')}`
  return `<!doctype html>
<html lang="pl">
  <head><meta charset="UTF-8"></head>
  <body><div id="root"></div><script type="module" src="${source}"></script></body>
</html>
`
}

const canonicalBase64UrlBytes = (value, byteLength) => {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return false
  try {
    const bytes = Buffer.from(value, 'base64url')
    return bytes.byteLength === byteLength && bytes.toString('base64url') === value
  } catch {
    return false
  }
}

const readBoundedJson = async (response, { deadlineMs }) => {
  const reader = response.body?.getReader()
  if (!reader) fail('APP_E2E_READINESS_INVALID')
  const chunks = []
  let bytes = 0
  let deadline
  let deadlineTimer
  try {
    deadline = new Promise((resolveDeadline, rejectDeadline) => {
      deadlineTimer = setTimeout(
        () => rejectDeadline(new Error('APP_E2E_READINESS_INVALID')),
        deadlineMs,
      )
    })
    while (true) {
      const part = await Promise.race([reader.read(), deadline])
      if (!exactKeys(part, ['value', 'done'])
        || typeof part.done !== 'boolean'
        || (!part.done && !(part.value instanceof Uint8Array))) {
        fail('APP_E2E_READINESS_INVALID')
      }
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_READINESS_BODY_BYTES) {
        try { await reader.cancel() } catch { /* Fixed status only. */ }
        fail('APP_E2E_READINESS_INVALID')
      }
      chunks.push(Buffer.from(part.value))
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    return JSON.parse(text)
  } catch {
    try { await reader.cancel() } catch { /* Fixed status only. */ }
    fail('APP_E2E_READINESS_INVALID')
  } finally {
    clearTimeout(deadlineTimer)
    try { reader.releaseLock() } catch { /* A cancelled read may retain the lock briefly. */ }
  }
}

const validCsrfProof = (token, expiresAt, nowMs) => {
  if (typeof token !== 'string' || typeof expiresAt !== 'string'
    || !Number.isSafeInteger(nowMs) || nowMs < 0) return false
  const parts = token.split('.')
  if (parts.length !== 4
    || parts[0] !== 'v1'
    || !/^[1-9]\d*$/.test(parts[1])
    || !Number.isSafeInteger(Number(parts[1]))
    || String(Number(parts[1])) !== parts[1]
    || !canonicalBase64UrlBytes(parts[2], 16)
    || !canonicalBase64UrlBytes(parts[3], 32)) return false
  const expiresUnix = Number(parts[1])
  const expectedExpiry = new Date(expiresUnix * 1000).toISOString()
  const remainingSeconds = expiresUnix - Math.floor(nowMs / 1000)
  return expiresAt === expectedExpiry
    && remainingSeconds >= 895
    && remainingSeconds <= 900
}

export async function assertReadySession(response, {
  bodyDeadlineMs = 2_000,
  nowMs = Date.now(),
} = {}) {
  if (!(response instanceof Response)
    || !Number.isSafeInteger(bodyDeadlineMs)
    || bodyDeadlineMs < 1
    || bodyDeadlineMs > 10_000
    || response.url !== READY_URL
    || response.status !== 200
    || response.redirected
    || response.headers.get('cache-control') !== 'no-store'
    || response.headers.get('content-security-policy') !== EXPECTED_CSP
    || response.headers.get('x-content-type-options') !== 'nosniff'
    || response.headers.get('referrer-policy') !== 'no-referrer'
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      response.headers.get('content-type') ?? '',
    )) {
    fail('APP_E2E_READINESS_INVALID')
  }
  let body
  try {
    body = await readBoundedJson(response, { deadlineMs: bodyDeadlineMs })
  } catch {
    fail('APP_E2E_READINESS_INVALID')
  }
  const data = body?.data
  const actor = data?.actor
  if (!exactKeys(body, ['data'])
    || !exactKeys(data, [
      'actor',
      'capabilities',
      'csrfToken',
      'csrfExpiresAt',
      'environment',
      'dataMode',
    ])
    || !exactKeys(actor, ['id', 'displayName', 'role', 'specialistId'])
    || actor.id !== 'stf_local_owner'
    || actor.displayName !== 'Alicja Testowa'
    || actor.role !== 'owner'
    || actor.specialistId !== null
    || data.environment !== 'development'
    || data.dataMode !== 'fictional'
    || !Array.isArray(data.capabilities)
    || data.capabilities.length !== CAPABILITIES.length
    || data.capabilities.some((capability, index) => capability !== CAPABILITIES[index])
    || !validCsrfProof(data.csrfToken, data.csrfExpiresAt, nowMs)
    || !ID.test(actor.id)) fail('APP_E2E_READINESS_INVALID')
  return Object.freeze({
    actorId: actor.id,
    environment: data.environment,
  })
}

const privateChildEnvironment = (harness, additions = {}) => {
  if (!harness?.home?.path
    || !harness?.tmp?.path
    || !harness?.xdgCache?.path
    || !harness?.xdgConfig?.path
    || !harness?.xdgData?.path) fail('APP_E2E_HARNESS_INVALID')
  const environment = {
    CI: '1',
    CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:1',
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    HOME: harness.home.path,
    LANG: 'C',
    LC_ALL: 'C',
    NODE_DISABLE_COMPILE_CACHE: '1',
    NO_COLOR: '1',
    TMPDIR: harness.tmp.path,
    WRANGLER_HIDE_BANNER: 'true',
    WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_WRITE_LOGS: 'false',
    XDG_CACHE_HOME: harness.xdgCache.path,
    XDG_CONFIG_HOME: harness.xdgConfig.path,
    XDG_DATA_HOME: harness.xdgData.path,
    ...additions,
  }
  if (Object.values(environment).some((value) => typeof value !== 'string')) {
    fail('APP_E2E_HARNESS_INVALID')
  }
  return Object.freeze(environment)
}

const defaultSleep = (milliseconds) => new Promise((resolveSleep) => (
  setTimeout(resolveSleep, milliseconds)
))

const processGroupExists = (groupId) => {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return false
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const markerProcessGroups = (ownershipToken) => {
  if (!OWNERSHIP_TOKEN.test(ownershipToken)) fail('APP_E2E_SHUTDOWN_FAILED')
  const snapshot = spawnSync(
    PS_EXECUTABLE,
    ['eww', '-axo', 'pid=,ppid=,pgid=,command='],
    {
      env: { LANG: 'C', LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      timeout: 250,
    },
  )
  const stdout = snapshot.stdout
  const stderr = snapshot.stderr
  const marker = Buffer.from(`${OWNERSHIP_ENV}=${ownershipToken}`, 'ascii')
  try {
    if (snapshot.error
      || snapshot.signal !== null
      || snapshot.status !== 0
      || !(stdout instanceof Buffer)
      || !(stderr instanceof Buffer)
      || stderr.byteLength !== 0) fail('APP_E2E_SHUTDOWN_FAILED')
    const groups = new Set()
    let offset = 0
    while (offset < stdout.byteLength) {
      const index = stdout.indexOf(marker, offset)
      if (index < 0) break
      const before = index > 0 ? stdout[index - 1] : 0x0a
      const afterIndex = index + marker.byteLength
      const after = afterIndex < stdout.byteLength ? stdout[afterIndex] : 0x0a
      if ((before === 0x20 || before === 0x09)
        && (after === 0x20 || after === 0x09 || after === 0x0a)) {
        const lineStart = stdout.lastIndexOf(0x0a, index - 1) + 1
        const prefix = stdout.subarray(
          lineStart,
          Math.min(index, lineStart + 96),
        ).toString('ascii')
        const match = prefix.match(/^\s*([1-9]\d*)\s+(0|[1-9]\d*)\s+([1-9]\d*)\s+/)
        if (!match) fail('APP_E2E_SHUTDOWN_FAILED')
        const groupId = Number(match[3])
        if (!Number.isSafeInteger(groupId) || groupId <= 0) {
          fail('APP_E2E_SHUTDOWN_FAILED')
        }
        groups.add(groupId)
      }
      offset = index + marker.byteLength
    }
    return groups
  } finally {
    marker.fill(0)
    stdout?.fill?.(0)
    stderr?.fill?.(0)
  }
}

const processTreeGroups = (rootPid, ownershipToken) => {
  const snapshot = spawnSync(
    PS_EXECUTABLE,
    ['-axo', 'pid=,ppid=,pgid='],
    {
      encoding: 'utf8',
      env: { LANG: 'C', LC_ALL: 'C' },
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 250,
    },
  )
  if (snapshot.error
    || snapshot.signal !== null
    || snapshot.status !== 0
    || snapshot.stderr !== ''
    || typeof snapshot.stdout !== 'string') {
    fail('APP_E2E_SHUTDOWN_FAILED')
  }
  const rows = []
  const seen = new Set()
  for (const line of snapshot.stdout.split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^\s*([1-9]\d*)\s+(0|[1-9]\d*)\s+([1-9]\d*)\s*$/)
    if (!match) fail('APP_E2E_SHUTDOWN_FAILED')
    const row = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      groupId: Number(match[3]),
    }
    if (!Number.isSafeInteger(row.pid)
      || !Number.isSafeInteger(row.ppid)
      || !Number.isSafeInteger(row.groupId)
      || seen.has(row.pid)) fail('APP_E2E_SHUTDOWN_FAILED')
    seen.add(row.pid)
    rows.push(row)
  }
  const root = rows.find(({ pid }) => pid === rootPid)
  if (root && root.groupId !== rootPid) fail('APP_E2E_SHUTDOWN_FAILED')
  const descendants = new Set([rootPid])
  const groups = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (descendants.has(row.pid) || !descendants.has(row.ppid)) continue
      descendants.add(row.pid)
      groups.add(row.groupId)
      changed = true
    }
  }
  for (const groupId of markerProcessGroups(ownershipToken)) groups.add(groupId)
  return Object.freeze([...groups].sort((left, right) => left - right))
}

const signalProcessGroup = (child, signal) => {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    fail('APP_E2E_SHUTDOWN_FAILED')
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') fail('APP_E2E_SHUTDOWN_FAILED')
  }
}

export const waitForAppE2ECondition = async (predicate, {
  attempts = 20,
  delayMs = 25,
  sleep = defaultSleep,
} = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return true
    await sleep(delayMs)
  }
  return predicate()
}

const removeOrphanedGroup = async (groupId, { sleep = defaultSleep } = {}) => {
  if (!processGroupExists(groupId)) return true
  try { process.kill(-groupId, 'SIGTERM') } catch { /* Prove absence below. */ }
  if (await waitForAppE2ECondition(() => !processGroupExists(groupId), { sleep })) return false
  try { process.kill(-groupId, 'SIGKILL') } catch { /* Prove absence below. */ }
  await waitForAppE2ECondition(() => !processGroupExists(groupId), { sleep })
  return false
}

const validChildInvocation = (input) => ownObject(input)
  && exactKeys(input, ['args', 'command', 'cwd', 'env', 'shell'])
  && Array.isArray(input.args)
  && input.args.every((argument) => typeof argument === 'string')
  && typeof input.command === 'string'
  && input.command === realpathSync(input.command)
  && typeof input.cwd === 'string'
  && input.cwd === realpathSync(input.cwd)
  && ownObject(input.env)
  && Object.values(input.env).every((value) => typeof value === 'string')
  && !Object.hasOwn(input.env, OWNERSHIP_ENV)
  && input.shell === false

const validManagedTerminal = (code, signal) => (
  (Number.isSafeInteger(code) && code >= 0 && signal === null)
  || (code === null
    && typeof signal === 'string'
    && PROCESS_SIGNALS.has(signal))
)

const createOwnedGroupSupervisor = ({
  failOnSignalError = false,
  groupExistsImpl,
  ownedGroupsImpl,
  ownershipToken,
  rootPid,
  signalGroupImpl,
  sleep,
}) => {
  const ownedGroups = new Set([rootPid])
  let ownershipUnproven = false
  const trackOwnedGroups = () => {
    let groups
    try {
      groups = ownedGroupsImpl(rootPid, ownershipToken)
    } catch {
      ownershipUnproven = true
      return
    }
    if (!Array.isArray(groups)
      || !groups.includes(rootPid)
      || groups.some((groupId) => (
        !Number.isSafeInteger(groupId) || groupId <= 0
      ))) {
      ownershipUnproven = true
      return
    }
    for (const groupId of groups) ownedGroups.add(groupId)
  }
  const signalOwnedGroups = (signal, shouldStop = () => false) => {
    for (const groupId of ownedGroups) {
      if (shouldStop()) return
      try {
        signalGroupImpl(groupId, signal)
      } catch {
        if (failOnSignalError) ownershipUnproven = true
      }
    }
  }
  const ownedGroupsAreAbsent = () => (
    [...ownedGroups].every((groupId) => !groupExistsImpl(groupId))
  )
  const boundedChildSleep = (milliseconds) => new Promise((resolveSleep, rejectSleep) => {
    let completed = false
    const fallback = setTimeout(() => {
      if (completed) return
      completed = true
      resolveSleep()
    }, milliseconds + 25)
    const complete = (callback, value) => {
      if (completed) return
      completed = true
      clearTimeout(fallback)
      callback(value)
    }
    try {
      Promise.resolve(sleep(milliseconds)).then(
        () => complete(resolveSleep),
        (error) => complete(rejectSleep, error),
      )
    } catch (error) {
      complete(rejectSleep, error)
    }
  })
  const waitForOwnedGroupsAbsence = () => waitForAppE2ECondition(
    ownedGroupsAreAbsent,
    { sleep: boundedChildSleep },
  )
  const forceTrackedGroupsAbsent = async () => {
    signalOwnedGroups('SIGKILL')
    try {
      return await waitForOwnedGroupsAbsence()
    } catch {
      return false
    }
  }
  const failUnprovenOwnership = async (observedLiveGroup) => {
    await forceTrackedGroupsAbsent()
    return Object.freeze({ observedLiveGroup, proven: false })
  }
  const proveOwnedGroupsAbsent = async ({
    graceful,
    initialSignal = 'SIGTERM',
  }) => {
    let observedLiveGroup = false
    let stablePasses = 0
    for (let scan = 0; scan < OWNERSHIP_STABILITY_SCANS; scan += 1) {
      trackOwnedGroups()
      if (ownershipUnproven) {
        return failUnprovenOwnership(observedLiveGroup)
      }
      if (ownedGroupsAreAbsent()) {
        stablePasses += 1
        if (stablePasses >= OWNERSHIP_STABLE_PASSES) {
          return Object.freeze({ observedLiveGroup, proven: true })
        }
      } else {
        observedLiveGroup = true
        stablePasses = 0
        if (graceful) {
          signalOwnedGroups(initialSignal)
          if (!(await waitForOwnedGroupsAbsence())) {
            trackOwnedGroups()
            if (ownershipUnproven) {
              return failUnprovenOwnership(observedLiveGroup)
            }
            signalOwnedGroups('SIGKILL')
            if (!(await waitForOwnedGroupsAbsence())) {
              return Object.freeze({ observedLiveGroup, proven: false })
            }
          }
        } else {
          signalOwnedGroups('SIGKILL')
          if (!(await waitForOwnedGroupsAbsence())) {
            return Object.freeze({ observedLiveGroup, proven: false })
          }
        }
      }
      await boundedChildSleep(25)
    }
    return Object.freeze({ observedLiveGroup, proven: false })
  }
  return Object.freeze({
    boundedSleep: boundedChildSleep,
    forceTrackedGroupsAbsent,
    proveOwnedGroupsAbsent,
    signalOwnedGroups,
    trackOwnedGroups,
  })
}

export const runBoundedAppChild = (input, {
  clearTimeoutImpl = clearTimeout,
  deadlineMs = CHILD_DEADLINE_MS,
  groupExistsImpl = processGroupExists,
  onRetainedChunk = () => {},
  onSettled = () => {},
  onSpawn = () => {},
  ownedGroupsImpl = processTreeGroups,
  setTimeoutImpl = setTimeout,
  signalGroupImpl = (groupId, signal) => {
    try {
      process.kill(-groupId, signal)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  },
  sleep = defaultSleep,
  spawnImpl = spawn,
} = {}) => new Promise((resolveResult, rejectResult) => {
  if (!validChildInvocation(input)
    || !Number.isSafeInteger(deadlineMs)
    || deadlineMs < 1
    || deadlineMs > 120_000
    || typeof clearTimeoutImpl !== 'function'
    || typeof groupExistsImpl !== 'function'
    || typeof onRetainedChunk !== 'function'
    || typeof onSettled !== 'function'
    || typeof onSpawn !== 'function'
    || typeof ownedGroupsImpl !== 'function'
    || typeof setTimeoutImpl !== 'function'
    || typeof signalGroupImpl !== 'function'
    || typeof sleep !== 'function'
    || typeof spawnImpl !== 'function') {
    rejectResult(new Error('APP_E2E_CHILD_INPUT_INVALID'))
    return
  }
  let child
  let ownershipToken
  try {
    ownershipToken = randomBytes(24).toString('hex')
    child = spawnImpl(input.command, input.args, {
      cwd: input.cwd,
      detached: true,
      env: {
        ...input.env,
        [OWNERSHIP_ENV]: ownershipToken,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    rejectResult(new Error('APP_E2E_CHILD_FAILED'))
    return
  }
  let pendingSpawnError = false
  let handleSpawnError = () => {
    pendingSpawnError = true
  }
  const childErrorListener = () => handleSpawnError()
  let childPid = null
  try { childPid = child?.pid } catch { /* Invalid spawn result. */ }
  const validPid = Number.isSafeInteger(childPid) && childPid > 0
  const ownershipSupervisor = validPid
    ? createOwnedGroupSupervisor({
      groupExistsImpl,
      ownedGroupsImpl,
      ownershipToken,
      rootPid: childPid,
      signalGroupImpl,
      sleep,
    })
    : null
  const forceTrackedGroupsAbsent = () => ownershipSupervisor.forceTrackedGroupsAbsent()
  const proveOwnedGroupsAbsent = (options) => (
    ownershipSupervisor.proveOwnedGroupsAbsent(options)
  )
  const signalOwnedGroups = (signal, shouldStop) => (
    ownershipSupervisor.signalOwnedGroups(signal, shouldStop)
  )
  const trackOwnedGroups = () => ownershipSupervisor.trackOwnedGroups()
  let validChildInterface = false
  try {
    const canManageErrorListener = typeof child?.once === 'function'
      && typeof child?.removeListener === 'function'
    if (canManageErrorListener) child.once('error', childErrorListener)
    validChildInterface = canManageErrorListener
      && typeof child?.stdout?.on === 'function'
      && typeof child?.stdout?.removeListener === 'function'
      && typeof child?.stderr?.on === 'function'
      && typeof child?.stderr?.removeListener === 'function'
  } catch {
    validChildInterface = false
  }
  const removeChildErrorListener = () => {
    try {
      if (typeof child?.removeListener === 'function') {
        child.removeListener('error', childErrorListener)
      }
    } catch {
      // Listener cleanup cannot change the fixed settlement result.
    }
  }
  const clearChildTimer = (timer) => {
    try { clearTimeoutImpl(timer) } catch { /* Fixed result only. */ }
  }
  if (!validChildInterface || !validPid) {
    let finalizing = false
    let cleanupTimer = null
    let cleanupTimerSet = false
    const finalizeInvalidChild = () => {
      if (finalizing) return
      finalizing = true
      if (cleanupTimerSet) {
        const timer = cleanupTimer
        cleanupTimerSet = false
        cleanupTimer = null
        clearChildTimer(timer)
      }
      removeChildErrorListener()
      void (async () => {
        let orphaned = false
        if (validPid) {
          try {
            const cleanup = await proveOwnedGroupsAbsent({ graceful: false })
            orphaned = !cleanup.proven
          } catch {
            await forceTrackedGroupsAbsent()
            orphaned = true
          }
        }
        try { onSettled(child) } catch { /* Fixed status only. */ }
        rejectResult(new Error(
          orphaned ? 'APP_E2E_CHILD_ORPHANED' : 'APP_E2E_CHILD_FAILED',
        ))
      })()
    }
    handleSpawnError = finalizeInvalidChild
    if (validPid) {
      trackOwnedGroups()
      if (!finalizing) signalOwnedGroups('SIGTERM', () => finalizing)
    } else {
      try {
        if (typeof child?.kill === 'function') child.kill('SIGKILL')
      } catch { /* Fixed status only. */ }
    }
    if (finalizing) return
    if (pendingSpawnError) {
      finalizeInvalidChild()
      return
    }
    try {
      const timer = setTimeoutImpl(finalizeInvalidChild, CHILD_KILL_GRACE_MS)
      cleanupTimer = timer
      cleanupTimerSet = true
      if (finalizing) {
        cleanupTimerSet = false
        cleanupTimer = null
        clearChildTimer(timer)
      }
    } catch {
      finalizeInvalidChild()
    }
    return
  }
  let failure = null
  let settled = false
  let stdoutBytes = 0
  let stderrBytes = 0
  const stdout = []
  const stderr = []
  let killTimer = null
  let killTimerSet = false
  let deadline = null
  let deadlineSet = false
  let terminalListener = null
  const removeRetainedListeners = () => {
    removeChildErrorListener()
    try { child.stdout.removeListener('data', stdoutListener) } catch { /* Fixed result only. */ }
    try { child.stderr.removeListener('data', stderrListener) } catch { /* Fixed result only. */ }
    try {
      if (terminalListener) child.removeListener('close', terminalListener)
    } catch { /* Fixed result only. */ }
  }
  const finalize = ({ code, signal, terminal }) => {
    if (settled) return
    settled = true
    if (deadlineSet) {
      const timer = deadline
      deadlineSet = false
      deadline = null
      clearChildTimer(timer)
    }
    if (killTimerSet) {
      const timer = killTimer
      killTimerSet = false
      killTimer = null
      clearChildTimer(timer)
    }
    removeRetainedListeners()
    void (async () => {
      let orphaned = false
      try {
        const cleanup = await proveOwnedGroupsAbsent({ graceful: terminal })
        orphaned = !cleanup.proven || (terminal && cleanup.observedLiveGroup)
      } catch {
        await forceTrackedGroupsAbsent()
        orphaned = true
      }
      try { onSettled(child) } catch { /* Fixed status only. */ }
      if (orphaned || failure || !Number.isInteger(code) || signal !== null) {
        rejectResult(new Error(
          orphaned ? 'APP_E2E_CHILD_ORPHANED' : (failure ?? 'APP_E2E_CHILD_FAILED'),
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
  const terminate = (code) => {
    if (failure || settled) return
    failure = code
    trackOwnedGroups()
    if (settled) return
    signalOwnedGroups('SIGTERM', () => settled)
    if (settled) return
    try {
      const timer = setTimeoutImpl(
        () => finalize({ code: null, signal: null, terminal: false }),
        CHILD_KILL_GRACE_MS,
      )
      killTimer = timer
      killTimerSet = true
      if (settled) {
        killTimerSet = false
        killTimer = null
        clearChildTimer(timer)
      }
    } catch {
      finalize({ code: null, signal: null, terminal: false })
    }
  }
  const collect = (target, chunk, stream) => {
    if (failure) return
    if (!(chunk instanceof Buffer)) {
      terminate('APP_E2E_CHILD_OUTPUT_INVALID')
      return
    }
    if (stream === 'stdout') stdoutBytes += chunk.byteLength
    else stderrBytes += chunk.byteLength
    if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES || stderrBytes > MAX_CHILD_OUTPUT_BYTES) {
      terminate('APP_E2E_CHILD_OUTPUT_INVALID')
      return
    }
    target.push(chunk)
    try {
      onRetainedChunk(chunk, stream)
    } catch {
      terminate('APP_E2E_CHILD_FAILED')
    }
  }
  const stdoutListener = (chunk) => collect(stdout, chunk, 'stdout')
  const stderrListener = (chunk) => collect(stderr, chunk, 'stderr')
  handleSpawnError = () => terminate('APP_E2E_CHILD_FAILED')
  if (pendingSpawnError) {
    terminate('APP_E2E_CHILD_FAILED')
    return
  }
  terminalListener = (code, signal) => finalize({ code, signal, terminal: true })
  try {
    child.once('close', terminalListener)
    if (settled || failure) return
    child.stdout.on('data', stdoutListener)
    if (settled || failure) return
    child.stderr.on('data', stderrListener)
    if (settled || failure) return
  } catch {
    terminate('APP_E2E_CHILD_FAILED')
    return
  }
  try {
    const timer = setTimeoutImpl(
      () => terminate('APP_E2E_CHILD_DEADLINE'),
      deadlineMs,
    )
    deadline = timer
    deadlineSet = true
    if (settled || failure) {
      deadlineSet = false
      deadline = null
      clearChildTimer(timer)
    }
  } catch {
    terminate('APP_E2E_CHILD_FAILED')
  }
  if (settled || failure) return
  try {
    onSpawn(child)
  } catch {
    terminate('APP_E2E_CHILD_FAILED')
  }
})

const waitForExit = (child) => {
  const managed = MANAGED_CHILDREN.get(child)
  if (managed?.exitPromise) return managed.exitPromise
  const existing = CHILD_EXIT_PROMISES.get(child)
  if (existing) return existing
  const promise = new Promise((resolveExit) => {
    let settled = false
    const finish = (code, signal, error = false) => {
      if (settled) return
      settled = true
      resolveExit(Object.freeze({ code, error, signal }))
    }
    child.once('error', () => finish(null, null, true))
    child.once('exit', (code, signal) => finish(code, signal, false))
    child.once('close', (code, signal) => finish(code, signal, false))
  })
  CHILD_EXIT_PROMISES.set(child, promise)
  return promise
}

export const startManagedAppE2EChild = (input, {
  groupExistsImpl = processGroupExists,
  ownedGroupsImpl = processTreeGroups,
  signalGroupImpl = (groupId, signal) => {
    try {
      process.kill(-groupId, signal)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  },
  sleep = defaultSleep,
  spawnImpl = spawn,
} = {}) => {
  if (!validChildInvocation(input)
    || typeof groupExistsImpl !== 'function'
    || typeof ownedGroupsImpl !== 'function'
    || typeof signalGroupImpl !== 'function'
    || typeof sleep !== 'function'
    || typeof spawnImpl !== 'function') {
    fail('APP_E2E_CHILD_INPUT_INVALID')
  }
  let child
  let ownershipToken
  try {
    ownershipToken = randomBytes(24).toString('hex')
    child = spawnImpl(input.command, input.args, {
      cwd: input.cwd,
      detached: true,
      env: {
        ...input.env,
        [OWNERSHIP_ENV]: ownershipToken,
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    fail('APP_E2E_CHILD_FAILED')
  }
  let pendingSpawnError = false
  let handleSpawnError = () => {
    pendingSpawnError = true
  }
  const errorListener = () => handleSpawnError()
  let childPid = null
  try { childPid = child?.pid } catch { /* Invalid spawn result. */ }
  const validPid = Number.isSafeInteger(childPid) && childPid > 0
  let validChildInterface = false
  try {
    const canManageListeners = typeof child?.once === 'function'
      && typeof child?.removeListener === 'function'
    if (canManageListeners) child.once('error', errorListener)
    validChildInterface = canManageListeners
      && typeof child?.kill === 'function'
      && typeof child?.stdout?.on === 'function'
      && typeof child?.stdout?.removeListener === 'function'
      && typeof child?.stderr?.on === 'function'
      && typeof child?.stderr?.removeListener === 'function'
      && validPid
  } catch {
    validChildInterface = false
  }
  if (!validChildInterface) {
    try { child?.removeListener?.('error', errorListener) } catch { /* Fixed result only. */ }
    if (!validPid) {
      try { child?.kill?.('SIGKILL') } catch { /* No owned PID can be proved. */ }
      fail('APP_E2E_CHILD_FAILED')
    }
    const invalidSupervisor = createOwnedGroupSupervisor({
      failOnSignalError: true,
      groupExistsImpl,
      ownedGroupsImpl,
      ownershipToken,
      rootPid: childPid,
      signalGroupImpl,
      sleep,
    })
    const invalidResult = Object.freeze({
      code: null,
      error: 'APP_E2E_CHILD_FAILED',
      signal: null,
    })
    const cleanupPromise = Promise.resolve().then(async () => {
      let proof
      try {
        proof = await invalidSupervisor.proveOwnedGroupsAbsent({
          graceful: true,
        })
      } catch {
        await invalidSupervisor.forceTrackedGroupsAbsent()
        fail('APP_E2E_SHUTDOWN_FAILED')
      }
      if (!proof.proven) fail('APP_E2E_SHUTDOWN_FAILED')
      return invalidResult
    })
    const exitPromise = cleanupPromise.then(() => {
      fail('APP_E2E_CHILD_FAILED')
    })
    void cleanupPromise.catch(() => {})
    void exitPromise.catch(() => {})
    MANAGED_CHILDREN.set(child, Object.freeze({
      exitPromise,
      requestStop: () => cleanupPromise,
      shutdownStarted: () => true,
      terminalObserved: () => true,
      terminalFollowedStop: () => false,
    }))
    return child
  }

  const ownershipSupervisor = createOwnedGroupSupervisor({
    failOnSignalError: true,
    groupExistsImpl,
    ownedGroupsImpl,
    ownershipToken,
    rootPid: child.pid,
    signalGroupImpl,
    sleep,
  })
  let rejectExit
  let resolveExit
  let listenerCleanupFailed = false
  let settled = false
  let shutdownMustFail = false
  let shutdownPromise = null
  let stopRequested = false
  let terminal = null
  let terminalObserved = false
  let terminalFollowedStop = false
  let outputFailure = null
  let stdoutBytes = 0
  let stderrBytes = 0
  const exitPromise = new Promise((resolveChildExit, rejectChildExit) => {
    rejectExit = rejectChildExit
    resolveExit = resolveChildExit
  })
  void exitPromise.catch(() => {})
  const removePipeListeners = () => {
    try {
      child.stdout.removeListener('data', stdoutListener)
    } catch {
      listenerCleanupFailed = true
    }
    try {
      child.stderr.removeListener('data', stderrListener)
    } catch {
      listenerCleanupFailed = true
    }
    try {
      child.stdout.resume?.()
    } catch {
      listenerCleanupFailed = true
    }
    try {
      child.stderr.resume?.()
    } catch {
      listenerCleanupFailed = true
    }
  }
  const removeListeners = () => {
    try {
      child.removeListener('error', errorListener)
    } catch {
      listenerCleanupFailed = true
    }
    try {
      child.removeListener('exit', exitListener)
    } catch {
      listenerCleanupFailed = true
    }
    try {
      child.removeListener('close', closeListener)
    } catch {
      listenerCleanupFailed = true
    }
    removePipeListeners()
  }
  const settleFailure = () => {
    if (settled) return
    settled = true
    removeListeners()
    rejectExit(new Error('APP_E2E_SHUTDOWN_FAILED'))
  }
  const settleExit = () => {
    if (settled) return
    if (!terminal) {
      settleFailure()
      return
    }
    removeListeners()
    if (listenerCleanupFailed) {
      settled = true
      rejectExit(new Error('APP_E2E_SHUTDOWN_FAILED'))
      return
    }
    settled = true
    resolveExit(Object.freeze({
      code: terminal.code,
      error: outputFailure ?? terminal.error,
      signal: terminal.signal,
    }))
  }
  const beginShutdown = (initialSignal = 'SIGTERM') => {
    if (shutdownPromise) return exitPromise
    shutdownPromise = Promise.resolve().then(async () => {
      let proof
      try {
        proof = await ownershipSupervisor.proveOwnedGroupsAbsent({
          graceful: true,
          initialSignal,
        })
      } catch {
        await ownershipSupervisor.forceTrackedGroupsAbsent()
        settleFailure()
        return
      }
      if (!proof.proven) {
        settleFailure()
        return
      }
      if (!terminalObserved) {
        let observed = false
        try {
          observed = await waitForAppE2ECondition(
            () => terminalObserved,
            { sleep: ownershipSupervisor.boundedSleep },
          )
        } catch {
          observed = false
        }
        if (!observed) {
          settleFailure()
          return
        }
      }
      if (shutdownMustFail) {
        settleFailure()
        return
      }
      settleExit()
    })
    removePipeListeners()
    void shutdownPromise.catch(() => settleFailure())
    return exitPromise
  }
  const observeTerminal = (code, signal, error = null) => {
    if (terminalObserved || settled) return
    terminalObserved = true
    if (error === null && !validManagedTerminal(code, signal)) {
      shutdownMustFail = true
      beginShutdown('SIGTERM')
      return
    }
    terminalFollowedStop = stopRequested
    terminal = Object.freeze({ code, error, signal })
    beginShutdown('SIGTERM')
  }
  const exitListener = (code, signal) => observeTerminal(code, signal)
  const closeListener = (code, signal) => observeTerminal(code, signal)
  handleSpawnError = () => observeTerminal(null, null, 'APP_E2E_CHILD_FAILED')
  const terminateOutput = () => {
    if (outputFailure || settled) return
    outputFailure = 'APP_E2E_CHILD_OUTPUT_INVALID'
    beginShutdown('SIGTERM')
  }
  const drain = (chunk, stream) => {
    if (outputFailure) return
    if (!(chunk instanceof Buffer)) {
      terminateOutput()
      return
    }
    if (stream === 'stdout') stdoutBytes += chunk.byteLength
    else stderrBytes += chunk.byteLength
    if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES || stderrBytes > MAX_CHILD_OUTPUT_BYTES) {
      terminateOutput()
    }
  }
  const stdoutListener = (chunk) => drain(chunk, 'stdout')
  const stderrListener = (chunk) => drain(chunk, 'stderr')
  try {
    child.once('exit', exitListener)
    child.once('close', closeListener)
    child.stdout.on('data', stdoutListener)
    child.stderr.on('data', stderrListener)
  } catch {
    terminalObserved = true
    terminal = Object.freeze({
      code: null,
      error: 'APP_E2E_CHILD_FAILED',
      signal: null,
    })
    beginShutdown('SIGTERM')
  }
  if (pendingSpawnError) handleSpawnError()
  const requestStop = (signal = 'SIGTERM') => {
    if (signal !== 'SIGINT' && signal !== 'SIGTERM') {
      if (settled) return Promise.reject(new Error('APP_E2E_SHUTDOWN_FAILED'))
      shutdownMustFail = true
      stopRequested = true
      beginShutdown('SIGKILL')
      return exitPromise
    }
    stopRequested = true
    return beginShutdown(signal)
  }
  MANAGED_CHILDREN.set(child, Object.freeze({
    exitPromise,
    requestStop,
    shutdownStarted: () => shutdownPromise !== null,
    terminalObserved: () => terminalObserved,
    terminalFollowedStop: () => terminalFollowedStop,
  }))
  return child
}

export const waitForManagedAppE2EChild = (child) => {
  const managed = MANAGED_CHILDREN.get(child)
  if (!managed?.exitPromise) fail('APP_E2E_CHILD_INPUT_INVALID')
  return managed.exitPromise
}

export const stopAppE2EChild = async (child, signal = 'SIGTERM') => {
  const managed = MANAGED_CHILDREN.get(child)
  if (managed?.requestStop) return managed.requestStop(signal)
  const close = waitForExit(child)
  let closeResult = null
  close.then((result) => {
    closeResult = result
  })
  signalProcessGroup(child, signal)
  const stoppedAfterTerm = await waitForAppE2ECondition(
    () => closeResult !== null && !processGroupExists(child.pid),
    { attempts: CHILD_KILL_GRACE_MS / 25 },
  )
  if (!stoppedAfterTerm) {
    signalProcessGroup(child, 'SIGKILL')
  }
  const stoppedAfterKill = stoppedAfterTerm || await waitForAppE2ECondition(
    () => closeResult !== null && !processGroupExists(child.pid),
    { attempts: CHILD_KILL_GRACE_MS / 25 },
  )
  if (!stoppedAfterKill || !closeResult) {
    fail('APP_E2E_SHUTDOWN_FAILED')
  }
  return closeResult
}

const defaultDirectory = async () => {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) fail('APP_E2E_HARNESS_INVALID')
  const base = realpathSync(tmpdir())
  const path = realpathSync(mkdtempSync(join(base, 'bwm-app-e2e-')))
  chmodSync(path, 0o700)
  return Object.freeze({
    fence: privateDirectoryFence(path),
    path,
  })
}

const defaultPrepareHarness = async (path, expectedFence) => {
  const fence = privateDirectoryFence(path, expectedFence)
  if (readdirSync(path).length !== 0) fail('APP_E2E_HARNESS_INVALID')
  const directory = (name) => {
    const directoryPath = join(path, name)
    mkdirSync(directoryPath, { mode: 0o700 })
    return Object.freeze({
      fence: privateDirectoryFence(directoryPath),
      path: directoryPath,
    })
  }
  const home = directory(PRIVATE_HOME_NAME)
  const state = directory(PRIVATE_STATE_NAME)
  const tmp = directory(PRIVATE_TMP_NAME)
  const viteRoot = directory(PRIVATE_VITE_ROOT_NAME)
  const xdgCache = directory(PRIVATE_XDG_CACHE_NAME)
  const xdgConfig = directory(PRIVATE_XDG_CONFIG_NAME)
  const xdgData = directory(PRIVATE_XDG_DATA_NAME)
  const wrangler = writePrivateFile(
    path,
    LOCAL_HARNESS_WRANGLER_NAME,
    buildLocalHarnessWranglerConfig(PROJECT_ROOT),
  )
  const vite = writePrivateFile(
    viteRoot.path,
    PRIVATE_VITE_NAME,
    privateViteConfig({
      root: viteRoot.path,
      statePath: state.path,
      wranglerConfigPath: wrangler.path,
    }),
  )
  const index = writePrivateFile(viteRoot.path, PRIVATE_INDEX_NAME, privateIndex())
  return Object.freeze({
    fence,
    home,
    index,
    path,
    state,
    tmp,
    vite,
    viteRoot,
    wrangler,
    xdgCache,
    xdgConfig,
    xdgData,
  })
}

const defaultAssertHarness = async (harness) => {
  if (!exactKeys(harness, [
    'fence',
    'home',
    'index',
    'path',
    'state',
    'tmp',
    'vite',
    'viteRoot',
    'wrangler',
    'xdgCache',
    'xdgConfig',
    'xdgData',
  ])) {
    fail('APP_E2E_HARNESS_INVALID')
  }
  privateDirectoryFence(harness.path, harness.fence)
  for (const directory of [
    harness.home,
    harness.state,
    harness.tmp,
    harness.viteRoot,
    harness.xdgCache,
    harness.xdgConfig,
    harness.xdgData,
  ]) {
    if (!exactKeys(directory, ['fence', 'path'])) fail('APP_E2E_HARNESS_INVALID')
    privateDirectoryFence(directory.path, directory.fence)
  }
  for (const file of [harness.index, harness.vite, harness.wrangler]) {
    assertPrivateFile(file)
  }
  for (const root of [harness.path, harness.viteRoot.path]) {
    if (readdirSync(root).some((name) => (
      name === '.dev.vars'
      || name.startsWith('.dev.vars.')
      || name === '.env'
      || name.startsWith('.env.')
    ))) {
      fail('APP_E2E_HARNESS_INVALID')
    }
  }
}

const defaultRemoveDirectory = async (path, harness) => {
  privateDirectoryFence(path, harness?.fence)
  rmSync(path, { recursive: true })
}

const defaultAssertRemoved = async (path) => {
  try {
    lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  fail('APP_E2E_CLEANUP_FAILED')
}

const defaultRandomKey = () => randomBytes(32).toString('base64url')

const artifactBasenameForbidden = (name) => name === '.env'
  || name.startsWith('.env.')
  || name === '.dev.vars'
  || name.startsWith('.dev.vars.')

const visitRegularFiles = (root, visitor) => {
  let directories = 0
  let files = 0
  let totalBytes = 0
  const pending = [{ depth: 0, path: root }]
  while (pending.length > 0) {
    const current = pending.pop()
    directories += 1
    if (directories > MAX_ARTIFACT_DIRECTORIES
      || current.depth > MAX_ARTIFACT_DEPTH) fail('APP_E2E_ARTIFACT_LEAK')
    const entries = readdirSync(current.path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (artifactBasenameForbidden(entry.name)) fail('APP_E2E_ARTIFACT_LEAK')
      const path = join(current.path, entry.name)
      const stats = lstatSync(path)
      if (stats.isSymbolicLink()) fail('APP_E2E_ARTIFACT_LEAK')
      if (stats.isDirectory()) {
        pending.push({ depth: current.depth + 1, path })
        continue
      }
      if (!stats.isFile()
        || stats.size > MAX_ARTIFACT_FILE_BYTES
        || files >= MAX_ARTIFACT_FILES
        || totalBytes + stats.size > MAX_ARTIFACT_TOTAL_BYTES) {
        fail('APP_E2E_ARTIFACT_LEAK')
      }
      files += 1
      totalBytes += stats.size
      let descriptor
      try {
        descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
        const descriptorStats = fstatSync(descriptor)
        const pathStats = lstatSync(path)
        if (!descriptorStats.isFile()
          || !sameIdentity(descriptorStats, pathStats)
          || descriptorStats.size !== stats.size) fail('APP_E2E_ARTIFACT_LEAK')
        const bytes = readFileSync(descriptor)
        if (bytes.byteLength !== stats.size) fail('APP_E2E_ARTIFACT_LEAK')
        visitor(path, stats, bytes)
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
      }
    }
  }
}

const defaultScanHarnessArtifacts = async ({ env, harness, keys }) => {
  privateDirectoryFence(harness.path, harness.fence)
  const patterns = []
  try {
    for (const value of Object.values(keys)) {
      patterns.push(Buffer.from(value, 'utf8'))
      patterns.push(Buffer.from(value, 'base64url'))
    }
    for (const [name, value] of Object.entries(env)) {
      if (/(?:KEY|PASSWORD|PROXY|SECRET|TOKEN)/.test(name)
        && typeof value === 'string'
        && Buffer.byteLength(value) >= 8) {
        patterns.push(Buffer.from(value, 'utf8'))
      }
    }
    visitRegularFiles(harness.path, (path, stats, bytes) => {
      if (patterns.some((pattern) => bytes.includes(pattern))) {
        fail('APP_E2E_ARTIFACT_LEAK')
      }
    })
    return true
  } finally {
    for (const pattern of patterns) pattern.fill(0)
  }
}

const EXTERNAL_ARTIFACT_PATHS = Object.freeze([
  join(PROJECT_ROOT, '.wrangler'),
  join(PROJECT_ROOT, 'node_modules/.mf'),
  join(PROJECT_ROOT, 'node_modules/.vite-temp'),
])

const defaultExternalArtifactSnapshot = async () => {
  const digest = createHash('sha256')
  for (const root of EXTERNAL_ARTIFACT_PATHS) {
    digest.update(`${relative(PROJECT_ROOT, root)}\0`)
    try {
      const rootStats = lstatSync(root, { bigint: true })
      digest.update(`root:${rootStats.mode}:${rootStats.ino}:${rootStats.mtimeNs}:${rootStats.ctimeNs}\0`)
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        fail('APP_E2E_EXTERNAL_ARTIFACT_INVALID')
      }
      visitRegularFiles(root, (path, stats, bytes) => {
        const relativePath = relative(root, path)
        const precise = lstatSync(path, { bigint: true })
        digest.update(`${relativePath}\0${stats.mode}\0${precise.ino}\0${precise.mtimeNs}\0${precise.ctimeNs}\0`)
        digest.update(bytes)
      })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        digest.update('absent\0')
        continue
      }
      throw error
    }
  }
  return digest.digest('hex')
}

const assertNoPlatformListener = async (harness) => {
  const targetPort = PORT.toString(16).toUpperCase().padStart(4, '0')
  if (process.platform === 'linux') {
    for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const contents = readFileSync(path, 'utf8')
      if (contents.trim().split('\n').slice(1).some((line) => {
        const fields = line.trim().split(/\s+/)
        return fields.length >= 4
          && fields[3] === '0A'
          && fields[1].split(':').at(-1) === targetPort
      })) fail('APP_E2E_PORT_OCCUPIED')
    }
    return
  }
  if (process.platform !== 'darwin') fail('APP_E2E_PORT_OCCUPIED')
  const result = await runBoundedAppChild({
    args: ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-Fpn'],
    command: regularExecutable('/usr/sbin/lsof'),
    cwd: harness.path,
    env: Object.freeze({ LANG: 'C', LC_ALL: 'C' }),
    shell: false,
  }, { deadlineMs: 2_000 })
  if (result.code !== 1 || result.stderr !== '' || result.stdout !== '') {
    fail('APP_E2E_PORT_OCCUPIED')
  }
}

export const probeAppE2EPort = (options = {}) => {
  if (!ownObject(options)
    || !exactKeys(options, Object.hasOwn(options, 'onListening')
      ? ['onListening']
      : [])
    || (Object.hasOwn(options, 'onListening')
      && typeof options.onListening !== 'function')) {
    return Promise.reject(new Error('APP_E2E_PORT_OCCUPIED'))
  }
  const onListening = options.onListening ?? (() => {})
  return new Promise((resolvePort, rejectPort) => {
    let server
    try {
      server = createServer()
    } catch {
      rejectPort(new Error('APP_E2E_PORT_OCCUPIED'))
      return
    }
    let settled = false
    let timer = null
    const sockets = new Set()
    const destroySockets = () => {
      for (const socket of sockets) {
        try { socket.destroy() } catch { /* Fixed status below. */ }
      }
      sockets.clear()
    }
    const removeListeners = () => {
      try { server.removeListener('connection', onConnection) } catch { /* Fixed result only. */ }
      try { server.removeListener('error', reject) } catch { /* Fixed result only. */ }
    }
    const clearDeadline = () => {
      if (!timer) return
      clearTimeout(timer)
      timer = null
    }
    const reject = () => {
      if (settled) return
      settled = true
      clearDeadline()
      destroySockets()
      removeListeners()
      try { server.close() } catch { /* Fixed status only. */ }
      rejectPort(new Error('APP_E2E_PORT_OCCUPIED'))
    }
    const onConnection = (socket) => {
      sockets.add(socket)
      try {
        socket.once('close', () => sockets.delete(socket))
        socket.destroy()
      } catch {
        reject()
      }
    }
    server.once('error', reject)
    server.on('connection', onConnection)
    timer = setTimeout(reject, PORT_PROBE_DEADLINE_MS)
    server.listen({ exclusive: true, host: HOST, port: PORT }, () => {
      const address = server.address()
      if (!address
        || typeof address === 'string'
        || address.address !== HOST
        || address.port !== PORT) {
        reject()
        return
      }
      Promise.resolve().then(onListening).then(
        () => {
          if (settled) return
          destroySockets()
          try {
            server.close((error) => {
              if (settled) return
              if (error) {
                reject()
                return
              }
              settled = true
              clearDeadline()
              removeListeners()
              resolvePort(true)
            })
          } catch {
            reject()
          }
        },
        reject,
      )
    })
  })
}

const defaultAssertPortAvailable = async (harness) => {
  await assertNoPlatformListener(harness)
  return probeAppE2EPort()
}

export const parseLinuxListenerTables = (tcp, tcp6) => {
  if (typeof tcp !== 'string'
    || typeof tcp6 !== 'string'
    || Buffer.byteLength(tcp) > 4 * 1024 * 1024
    || Buffer.byteLength(tcp6) > 4 * 1024 * 1024) return null
  const targetPort = PORT.toString(16).toUpperCase().padStart(4, '0')
  const listeners = []
  for (const [contents, family] of [[tcp, 'ipv4'], [tcp6, 'ipv6']]) {
    for (const line of contents.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 10 || fields[3] !== '0A') continue
      const [address, port] = fields[1].split(':')
      if (port !== targetPort) continue
      listeners.push({ address, family, inode: fields[9] })
    }
  }
  if (listeners.length !== 1
    || listeners[0].family !== 'ipv4'
    || listeners[0].address !== '0100007F'
    || !/^[1-9]\d*$/.test(listeners[0].inode)) return null
  return Object.freeze({ inode: listeners[0].inode })
}

export const validateLinuxListenerOwnership = ({
  after,
  before,
  listener,
  ownerNamespace,
  owners,
  tablesStable,
  viteNamespace,
  vitePid,
} = {}) => {
  if (!ownObject(listener)
    || !/^[1-9]\d*$/.test(listener.inode)
    || !Array.isArray(owners)
    || owners.length !== 1
    || !ownObject(owners[0])
    || !Number.isSafeInteger(owners[0].descriptor)
    || owners[0].descriptor < 0
    || !Number.isSafeInteger(owners[0].pid)
    || owners[0].pid <= 0
    || !ownObject(before)
    || !ownObject(after)
    || before.pid !== owners[0].pid
    || after.pid !== owners[0].pid
    || before.groupId !== vitePid
    || after.groupId !== before.groupId
    || after.startTime !== before.startTime
    || typeof before.startTime !== 'string'
    || !/^[1-9]\d*$/.test(before.startTime)
    || typeof ownerNamespace !== 'string'
    || !ownerNamespace
    || ownerNamespace !== viteNamespace
    || tablesStable !== true
    || !Number.isSafeInteger(vitePid)
    || vitePid <= 0) return null
  return createHash('sha256').update(JSON.stringify({
    descriptor: owners[0].descriptor,
    inode: listener.inode,
    namespace: ownerNamespace,
    pid: owners[0].pid,
    startTime: before.startTime,
  })).digest('hex')
}

const linuxListenerOwner = (vitePid) => {
  const startedAt = Date.now()
  let tcp
  let tcp6
  try {
    tcp = readFileSync('/proc/net/tcp', 'utf8')
    tcp6 = readFileSync('/proc/net/tcp6', 'utf8')
  } catch {
    return null
  }
  const listener = parseLinuxListenerTables(tcp, tcp6)
  if (!listener) return null
  const socket = `socket:[${listener.inode}]`
  const owners = []
  const processEntries = readdirSync('/proc', { withFileTypes: true })
  if (processEntries.length > 32_768) return null
  for (const entry of processEntries) {
    if (Date.now() - startedAt > 500) return null
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue
    const pid = Number(entry.name)
    let descriptors
    try { descriptors = readdirSync(`/proc/${pid}/fd`) } catch { continue }
    if (descriptors.length > 4_096) return null
    for (const descriptor of descriptors) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${descriptor}`) === socket) {
          owners.push({ descriptor: Number(descriptor), pid })
        }
      } catch {
        // The process or descriptor changed during the read.
      }
    }
  }
  if (owners.length !== 1
    || !Number.isSafeInteger(owners[0].descriptor)
    || owners[0].descriptor < 0) return null
  const processIdentity = (pid) => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const suffix = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (suffix.length < 20) return null
    return Object.freeze({
      groupId: Number(suffix[2]),
      pid,
      startTime: suffix[19],
    })
  }
  try {
    const before = processIdentity(owners[0].pid)
    const ownerNamespace = readlinkSync(`/proc/${owners[0].pid}/ns/net`)
    const viteNamespace = readlinkSync(`/proc/${vitePid}/ns/net`)
    const tablesStable = readFileSync('/proc/net/tcp', 'utf8') === tcp
      && readFileSync('/proc/net/tcp6', 'utf8') === tcp6
    const after = processIdentity(owners[0].pid)
    return validateLinuxListenerOwnership({
      after,
      before,
      listener,
      ownerNamespace,
      owners,
      tablesStable,
      viteNamespace,
      vitePid,
    })
  } catch {
    return null
  }
}

export const parseDarwinListenerSnapshot = (value) => {
  if (typeof value !== 'string' || !value.endsWith('\n')) return null
  const lines = value.slice(0, -1).split('\n')
  if (lines.length !== 3
    || !/^p[1-9]\d*$/.test(lines[0])
    || !/^f\d+$/.test(lines[1])
    || lines[2] !== `n${HOST}:${PORT}`) return null
  const pid = Number(lines[0].slice(1))
  const descriptor = Number(lines[1].slice(1))
  if (!Number.isSafeInteger(pid) || pid <= 0
    || !Number.isSafeInteger(descriptor) || descriptor < 0) return null
  return Object.freeze({ descriptor, pid })
}

const defaultAssertListenerOwner = async (vite, harness) => {
  if (!Number.isSafeInteger(vite?.pid) || vite.pid <= 0) fail('APP_E2E_LISTENER_INVALID')
  if (process.platform === 'linux') {
    const snapshot = linuxListenerOwner(vite.pid)
    if (!snapshot) fail('APP_E2E_LISTENER_INVALID')
    return snapshot
  }
  if (process.platform !== 'darwin') fail('APP_E2E_LISTENER_INVALID')
  const lsofInvocation = {
    args: ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-Fpn'],
    command: regularExecutable('/usr/sbin/lsof'),
    cwd: harness.path,
    env: Object.freeze({ LANG: 'C', LC_ALL: 'C' }),
    shell: false,
  }
  const first = await runBoundedAppChild(lsofInvocation, { deadlineMs: 2_000 })
  const parsed = parseDarwinListenerSnapshot(first.stdout)
  if (first.code !== 0 || first.stderr !== '' || !parsed) {
    fail('APP_E2E_LISTENER_INVALID')
  }
  const ps = await runBoundedAppChild({
    args: ['-o', 'pgid=', '-p', String(parsed.pid)],
    command: regularExecutable('/bin/ps'),
    cwd: harness.path,
    env: Object.freeze({ LANG: 'C', LC_ALL: 'C' }),
    shell: false,
  }, { deadlineMs: 2_000 })
  const second = await runBoundedAppChild(lsofInvocation, { deadlineMs: 2_000 })
  if (ps.code !== 0
    || ps.stderr !== ''
    || ps.stdout.trim() !== String(vite.pid)
    || second.code !== 0
    || second.stderr !== ''
    || second.stdout !== first.stdout) {
    fail('APP_E2E_LISTENER_INVALID')
  }
  return createHash('sha256').update(first.stdout).digest('hex')
}

const readinessAttempt = async ({
  fetchImpl,
  fetchDeadlineMs,
  now,
}) => {
  const controller = new AbortController()
  let timer
  try {
    const response = await Promise.race([
      fetchImpl(READY_URL, {
        cache: 'no-store',
        headers: { 'X-BWM-Local-Identity': READY_IDENTITY },
        redirect: 'manual',
        signal: controller.signal,
      }),
      new Promise((resolveTimeout, rejectTimeout) => {
        timer = setTimeout(
          () => rejectTimeout(new Error('APP_E2E_READINESS_INVALID')),
          fetchDeadlineMs,
        )
      }),
    ])
    clearTimeout(timer)
    return await assertReadySession(response, {
      bodyDeadlineMs: fetchDeadlineMs,
      nowMs: now(),
    })
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

const defaultLoopbackFetch = (url, init) => new Promise((resolveFetch, rejectFetch) => {
  if (url !== READY_URL
    || !ownObject(init)
    || init.cache !== 'no-store'
    || init.redirect !== 'manual'
    || !(init.signal instanceof AbortSignal)
    || !ownObject(init.headers)
    || !exactKeys(init.headers, ['X-BWM-Local-Identity'])
    || init.headers['X-BWM-Local-Identity'] !== READY_IDENTITY) {
    rejectFetch(new Error('APP_E2E_READINESS_INVALID'))
    return
  }
  let request
  try {
    request = httpRequest({
      agent: false,
      headers: init.headers,
      host: HOST,
      method: 'GET',
      path: '/api/v1/session',
      port: PORT,
      signal: init.signal,
    }, (incoming) => {
      try {
        const headers = new Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
        }
        const response = new Response(Readable.toWeb(incoming), {
          headers,
          status: incoming.statusCode,
          statusText: incoming.statusMessage,
        })
        Object.defineProperty(response, 'url', {
          configurable: true,
          value: READY_URL,
        })
        resolveFetch(response)
      } catch {
        incoming.destroy()
        rejectFetch(new Error('APP_E2E_READINESS_INVALID'))
      }
    })
  } catch {
    rejectFetch(new Error('APP_E2E_READINESS_INVALID'))
    return
  }
  request.once('error', () => rejectFetch(new Error('APP_E2E_READINESS_INVALID')))
  request.end()
})

class RunnerOutcome extends Error {
  constructor(code, ok = false) {
    super(code)
    this.code = code
    this.ok = ok
  }
}

const outcome = (code, ok = false) => {
  throw new RunnerOutcome(code, ok)
}

export async function runAppE2E({
  env = process.env,
  argv = process.argv.slice(2),
  deps = {},
} = {}) {
  if (!ownObject(env)
    || !Array.isArray(argv)
    || argv.length !== 0
    || (deps.makePersistenceDirectory && !deps.removePersistenceDirectory)) {
    return Object.freeze({ code: 'APP_E2E_INPUT_INVALID', ok: false })
  }
  const assertHarness = deps.assertHarness ?? defaultAssertHarness
  const assertListenerOwner = deps.assertListenerOwner ?? defaultAssertListenerOwner
  const assertPortAvailable = deps.assertPortAvailable ?? defaultAssertPortAvailable
  const assertRemoved = deps.assertRemoved ?? defaultAssertRemoved
  const fetchImpl = deps.fetch ?? defaultLoopbackFetch
  const makePersistenceDirectory = deps.makePersistenceDirectory ?? defaultDirectory
  const now = deps.now ?? Date.now
  const prepareHarness = deps.prepareHarness ?? defaultPrepareHarness
  const randomKey = deps.randomKey ?? defaultRandomKey
  const removePersistenceDirectory = deps.removePersistenceDirectory ?? defaultRemoveDirectory
  const runChild = deps.runChild ?? runBoundedAppChild
  const scanHarnessArtifacts = deps.scanHarnessArtifacts ?? defaultScanHarnessArtifacts
  const signals = deps.signals ?? process
  const sleep = deps.sleep ?? defaultSleep
  const startChild = deps.startChild ?? (
    (input) => startManagedAppE2EChild(input, deps.managedChildDeps)
  )
  const externalArtifactSnapshot = deps.externalArtifactSnapshot
    ?? defaultExternalArtifactSnapshot
  const stopChild = deps.stopChild ?? (
    deps.startChild
      ? async (child, signal) => {
        const exited = waitForExit(child)
        child.kill(signal)
        return exited
      }
      : stopAppE2EChild
  )
  const maxAttempts = deps.maxReadinessAttempts ?? DEFAULT_ATTEMPTS
  const fetchDeadlineMs = deps.fetchDeadlineMs ?? FETCH_DEADLINE_MS
  if (typeof fetchImpl !== 'function'
    || typeof signals?.on !== 'function'
    || typeof signals?.off !== 'function'
    || !Number.isSafeInteger(maxAttempts)
    || maxAttempts < 1
    || maxAttempts > 240
    || !Number.isSafeInteger(fetchDeadlineMs)
    || fetchDeadlineMs < 1
    || fetchDeadlineMs > 10_000) {
    return Object.freeze({ code: 'APP_E2E_INPUT_INVALID', ok: false })
  }

  let activeChild = null
  let final = Object.freeze({ code: 'APP_E2E_START_FAILED', ok: false })
  let externalArtifactsBefore = null
  let forwardedSignal = null
  let generatedKeys = null
  let harness
  let ownedFence = null
  let ownedPath = null
  let phase = PHASE.init
  let preserveHarness = false
  let vite = null
  let viteClosed = true
  let vitePortReleased = true
  const advance = (next) => {
    if (!Number.isSafeInteger(next) || next <= phase) fail('APP_E2E_STATE_INVALID')
    phase = next
  }
  const requestStop = (child, signal) => {
    if (!child) return
    const managed = MANAGED_CHILDREN.get(child)
    if (managed?.requestStop) {
      void managed.requestStop(signal).catch(() => {})
      return
    }
    if (deps.startChild && child === vite) {
      try { child.kill(signal) } catch { preserveHarness = true }
      return
    }
    try { signalProcessGroup(child, signal) } catch { preserveHarness = true }
  }
  const onSignal = (signal) => {
    if (forwardedSignal) return
    forwardedSignal = signal
    requestStop(activeChild, signal)
  }
  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')
  signals.on('SIGINT', onSigint)
  signals.on('SIGTERM', onSigterm)

  const executeStage = async (input, failureCode) => {
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
    let ownedChild = null
    try {
      const result = await runChild(input, {
        onSettled: (child) => {
          if (activeChild === child) activeChild = null
        },
        onSpawn: (child) => {
          ownedChild = child
          activeChild = child
          if (forwardedSignal) requestStop(child, forwardedSignal)
        },
      })
      if (activeChild === ownedChild) activeChild = null
      if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
      if (!exactKeys(result, ['code', 'stderr', 'stdout'])
        || result.code !== 0
        || typeof result.stderr !== 'string'
        || typeof result.stdout !== 'string') outcome(failureCode)
      return result
    } catch (error) {
      if (activeChild === ownedChild) activeChild = null
      if (error instanceof RunnerOutcome) throw error
      if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
      if (error?.message === 'APP_E2E_CHILD_ORPHANED') {
        preserveHarness = true
        outcome('APP_E2E_SHUTDOWN_FAILED')
      }
      outcome(failureCode)
    }
  }

  try {
    externalArtifactsBefore = await externalArtifactSnapshot()
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
    if (typeof externalArtifactsBefore !== 'string' || !externalArtifactsBefore) {
      outcome('APP_E2E_START_FAILED')
    }
    const created = await makePersistenceDirectory()
    ownedPath = resolve(typeof created === 'string' ? created : created?.path)
    ownedFence = created?.fence ?? null
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
    harness = await prepareHarness(ownedPath, ownedFence)
    ownedFence = harness.fence
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
    await assertHarness(harness)
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
    advance(PHASE.prepared)
    try {
      await assertPortAvailable(harness)
    } catch {
      outcome('APP_E2E_PORT_OCCUPIED')
    }
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')

    const keys = Object.fromEntries(KEY_NAMES.map((name) => {
      const key = randomKey()
      if (!canonicalBase64UrlBytes(key, 32)) outcome('APP_E2E_START_FAILED')
      return [name, key]
    }))
    if (new Set(Object.values(keys)).size !== KEY_NAMES.length) {
      outcome('APP_E2E_START_FAILED')
    }
    generatedKeys = keys
    const commonEnvironment = privateChildEnvironment(harness)
    const wranglerPrefix = [
      regularExecutable(WRANGLER_SCRIPT_PATH),
      '--config',
      harness.wrangler.path,
      '--x-provision=false',
      '--x-auto-create=false',
      '--install-skills=false',
    ]

    advance(PHASE.migrating)
    await assertHarness(harness)
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
    await executeStage({
      args: [
        ...wranglerPrefix,
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '--persist-to',
        harness.state.path,
      ],
      command: regularExecutable(NODE_EXECUTABLE),
      cwd: harness.path,
      env: commonEnvironment,
      shell: false,
    }, 'APP_E2E_MIGRATION_FAILED')

    advance(PHASE.seeding)
    await assertHarness(harness)
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
    const seedResult = await executeStage({
      args: [regularExecutable(SEED_SCRIPT_PATH)],
      command: regularExecutable(NODE_EXECUTABLE),
      cwd: harness.path,
      env: privateChildEnvironment(harness, {
        APP_ENV: 'development',
        BWM_LOCAL_PERSISTENCE_PATH: harness.state.path,
        BWM_LOCAL_RUNNER_MODE: LOCAL_HARNESS_RUNNER_MODE,
        DATA_MODE: 'fictional',
        ...keys,
      }),
      shell: false,
    }, 'APP_E2E_SEED_FAILED')
    if (seedResult.stderr !== '' || seedResult.stdout !== 'SEED_LOCAL_COMPLETE\n') {
      outcome('APP_E2E_SEED_FAILED')
    }

    advance(PHASE.starting)
    await assertHarness(harness)
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
    try {
      await assertPortAvailable(harness)
    } catch {
      outcome('APP_E2E_PORT_OCCUPIED')
    }
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
    try {
      vite = startChild({
        args: [
          regularExecutable(VITE_SCRIPT_PATH),
          '--config',
          harness.vite.path,
          '--configLoader',
          'native',
          '--logLevel',
          'silent',
          '--clearScreen=false',
          '--mode',
          'app',
          '--host',
          HOST,
          '--port',
          String(PORT),
          '--strictPort',
        ],
        command: regularExecutable(NODE_EXECUTABLE),
        cwd: harness.viteRoot.path,
        env: privateChildEnvironment(harness, keys),
        shell: false,
      })
    } catch {
      outcome('APP_E2E_START_FAILED')
    }
    const managedVite = MANAGED_CHILDREN.has(vite)
    if (!vite
      || !Number.isSafeInteger(vite.pid)
      || vite.pid <= 0
      || (!managedVite
        && (typeof vite.once !== 'function'
          || typeof vite.kill !== 'function'))) outcome('APP_E2E_START_FAILED')
    activeChild = vite
    viteClosed = false
    vitePortReleased = false
    let childExitValue = null
    const childExit = waitForExit(vite).then(
      (value) => {
        childExitValue = Object.freeze({
          childFailed: MANAGED_CHILDREN.has(vite) && value?.error !== null,
          shutdownFailed: false,
          startupFailed: false,
          value,
        })
        return childExitValue
      },
      (error) => {
        const startupFailed = error?.message === 'APP_E2E_CHILD_FAILED'
        childExitValue = Object.freeze({
          childFailed: false,
          shutdownFailed: !startupFailed,
          startupFailed,
          value: null,
        })
        return childExitValue
      },
    )
    const classifyViteExit = async (exit, failureCode) => {
      activeChild = null
      if (exit.shutdownFailed) {
        preserveHarness = true
        outcome('APP_E2E_SHUTDOWN_FAILED')
      }
      if (exit.startupFailed) {
        viteClosed = true
        outcome('APP_E2E_START_FAILED')
      }
      if (exit.childFailed) {
        viteClosed = true
        outcome(failureCode === 'APP_E2E_CHILD_EXITED'
          ? 'APP_E2E_START_FAILED'
          : 'APP_E2E_RUNTIME_FAILED')
      }
      if (!MANAGED_CHILDREN.has(vite) && processGroupExists(vite.pid)) {
        await removeOrphanedGroup(vite.pid)
        preserveHarness = true
        outcome('APP_E2E_SHUTDOWN_FAILED')
      }
      viteClosed = true
      outcome(forwardedSignal ? 'APP_E2E_INTERRUPTED' : failureCode)
    }
    const classifyManagedShutdownIfStarted = () => {
      const managed = MANAGED_CHILDREN.get(vite)
      if (managed?.shutdownStarted?.() !== true) return null
      return childExit.then((exit) => (
        classifyViteExit(exit, 'APP_E2E_CHILD_EXITED')
      ))
    }
    if (forwardedSignal) {
      requestStop(vite, forwardedSignal)
      outcome('APP_E2E_INTERRUPTED')
    }

    advance(PHASE.readiness)
    let ready = false
    let managedShutdown = null
    for (let attempt = 0; attempt < maxAttempts && !forwardedSignal; attempt += 1) {
      managedShutdown = classifyManagedShutdownIfStarted()
      if (managedShutdown) await managedShutdown
      let listenerBefore = null
      try {
        listenerBefore = await assertListenerOwner(vite, harness)
        if (typeof listenerBefore !== 'string' || !listenerBefore) {
          listenerBefore = null
        }
      } catch {
        listenerBefore = null
      }
      managedShutdown = classifyManagedShutdownIfStarted()
      if (managedShutdown) await managedShutdown
      if (forwardedSignal) break
      let raced
      if (childExitValue) {
        raced = { exit: childExitValue, kind: 'exit' }
      } else if (!listenerBefore) {
        raced = { kind: 'retry' }
      } else {
        const checked = readinessAttempt({
          fetchDeadlineMs,
          fetchImpl,
          now,
        }).then(
          (session) => ({ kind: 'session', session }),
          () => ({ kind: 'retry' }),
        )
        raced = await Promise.race([
          checked,
          childExit.then((exit) => ({ exit, kind: 'exit' })),
        ])
      }
      managedShutdown = classifyManagedShutdownIfStarted()
      if (managedShutdown) await managedShutdown
      if (raced.kind === 'exit') {
        await classifyViteExit(raced.exit, 'APP_E2E_CHILD_EXITED')
      }
      if (raced.kind === 'session') {
        let listenerAfter = null
        try {
          listenerAfter = await assertListenerOwner(vite, harness)
        } catch {
          // A valid response from a foreign listener is never readiness.
        }
        managedShutdown = classifyManagedShutdownIfStarted()
        if (managedShutdown) await managedShutdown
        if (!childExitValue
          && listenerAfter === listenerBefore) {
          ready = true
          break
        }
      }
      if (attempt + 1 < maxAttempts && !forwardedSignal) {
        const slept = await Promise.race([
          sleep(250).then(() => ({ kind: 'slept' }), () => ({ kind: 'failed' })),
          childExit.then((exit) => ({ exit, kind: 'exit' })),
        ])
        managedShutdown = classifyManagedShutdownIfStarted()
        if (managedShutdown) await managedShutdown
        if (slept.kind === 'exit') {
          await classifyViteExit(slept.exit, 'APP_E2E_CHILD_EXITED')
        }
        if (slept.kind === 'failed') break
      }
    }
    managedShutdown = classifyManagedShutdownIfStarted()
    if (managedShutdown) await managedShutdown
    if (forwardedSignal) outcome('APP_E2E_INTERRUPTED')
    if (!ready) outcome('APP_E2E_READINESS_FAILED')
    advance(PHASE.ready)

    if (deps.exitAfterReady) {
      advance(PHASE.stopping)
      let stopResult
      try {
        stopResult = await stopChild(vite, 'SIGTERM')
        if (!MANAGED_CHILDREN.has(vite) && processGroupExists(vite.pid)) {
          await removeOrphanedGroup(vite.pid)
          fail('APP_E2E_SHUTDOWN_FAILED')
        }
        activeChild = null
        viteClosed = true
      } catch {
        preserveHarness = true
        outcome('APP_E2E_SHUTDOWN_FAILED')
      }
      if (MANAGED_CHILDREN.has(vite)) {
        const managed = MANAGED_CHILDREN.get(vite)
        const cleanManagedStop = exactKeys(stopResult, ['code', 'error', 'signal'])
          && stopResult.error === null
          && managed.terminalFollowedStop()
          && (((stopResult.code === 0
            || stopResult.code === 137
            || stopResult.code === 143)
            && stopResult.signal === null)
            || (stopResult.code === null
              && (stopResult.signal === 'SIGKILL'
                || stopResult.signal === 'SIGTERM')))
        if (!cleanManagedStop) outcome('APP_E2E_RUNTIME_FAILED')
      }
      outcome('APP_E2E_READY', true)
    }

    if (typeof deps.onReady === 'function') await deps.onReady()
    const runtimeExit = await childExit
    await classifyViteExit(runtimeExit, 'APP_E2E_RUNTIME_FAILED')
  } catch (error) {
    final = error instanceof RunnerOutcome
      ? Object.freeze({ code: error.code, ok: error.ok })
      : Object.freeze({ code: 'APP_E2E_START_FAILED', ok: false })
  } finally {
    if (phase < PHASE.stopping) phase = PHASE.stopping
    if (vite && !viteClosed) {
      try {
        await stopChild(vite, forwardedSignal ?? 'SIGTERM')
        activeChild = null
        viteClosed = true
      } catch {
        preserveHarness = true
        final = Object.freeze({ code: 'APP_E2E_SHUTDOWN_FAILED', ok: false })
      }
    }
    if (vite && viteClosed) {
      try {
        await assertPortAvailable(harness)
        vitePortReleased = true
      } catch {
        preserveHarness = true
        final = Object.freeze({ code: 'APP_E2E_SHUTDOWN_FAILED', ok: false })
      }
    }
    if (ownedPath
      && !preserveHarness
      && viteClosed
      && vitePortReleased
      && activeChild === null) {
      let integrityFailure = null
      if (harness) {
        try {
          await assertHarness(harness)
        } catch {
          if (final.ok) integrityFailure = 'APP_E2E_ARTIFACT_LEAK'
        }
        try {
          await scanHarnessArtifacts({
            env,
            harness,
            keys: generatedKeys ?? Object.freeze({}),
          })
        } catch {
          integrityFailure = 'APP_E2E_ARTIFACT_LEAK'
        }
      }
      try {
        const externalArtifactsAfter = await externalArtifactSnapshot()
        if (externalArtifactsAfter !== externalArtifactsBefore) {
          integrityFailure ??= 'APP_E2E_EXTERNAL_ARTIFACT_CHANGED'
        }
      } catch {
        integrityFailure ??= 'APP_E2E_EXTERNAL_ARTIFACT_CHANGED'
      }
      try {
        if (!deps.removePersistenceDirectory) {
          privateDirectoryFence(ownedPath, ownedFence)
        }
        await removePersistenceDirectory(
          ownedPath,
          harness ?? Object.freeze({ fence: ownedFence, path: ownedPath }),
        )
        await assertRemoved(ownedPath)
      } catch {
        final = Object.freeze({ code: 'APP_E2E_CLEANUP_FAILED', ok: false })
      }
      if (integrityFailure && final.code !== 'APP_E2E_CLEANUP_FAILED') {
        final = Object.freeze({ code: integrityFailure, ok: false })
      }
    }
    phase = PHASE.closed
    signals.off('SIGINT', onSigint)
    signals.off('SIGTERM', onSigterm)
  }
  return final
}

const runCli = async () => {
  let readyReported = false
  const result = await runAppE2E({
    env: { ...process.env },
    deps: {
      onReady: () => {
        if (readyReported) return
        readyReported = true
        process.stdout.write('APP_E2E_READY\n')
      },
    },
  })
  process.stdout.write(`${result.code}\n`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}
