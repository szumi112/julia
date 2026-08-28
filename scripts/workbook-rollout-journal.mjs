import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_BYTES = 1024 * 1024
const LOCK_MARKER = 'workbook_rollout_lock.v1\n'
const PHASES = new Set(['initialized', 'import_confirmed', 'complete'])
const TOP_KEYS = Object.freeze([
  'schema', 'environment', 'fingerprint', 'creatorId', 'phase', 'importIdentity', 'result',
])
const RESULT_KEYS = Object.freeze([
  'artifactId', 'importId', 'acceptedCount', 'quarantinedCount',
  'previewWritesZero', 'terminalComplete', 'artifactVerified',
  'reconciliationMatched', 'replayIdentityMatch', 'replayWritesZero', 'status',
])
const RETIRED_LEGACY = Object.freeze({
  schema: 'workbook_rollout_journal.retired.v1',
  environment: 'staging',
  phase: 'retired',
})
const refused = () => { throw new Error('WORKBOOK_ROLLOUT_STAGING_REFUSED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const identifier = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,120}$`).test(value)

function importIdentityDto(value) {
  return exact(value, ['importId', 'artifactId'])
    && identifier(value.importId, 'wbi') && identifier(value.artifactId, 'wba')
}

function resultDto(value, importIdentity) {
  return exact(value, RESULT_KEYS)
    && identifier(value.artifactId, 'wba') && identifier(value.importId, 'wbi')
    && Number.isSafeInteger(value.acceptedCount) && value.acceptedCount >= 0
    && Number.isSafeInteger(value.quarantinedCount) && value.quarantinedCount >= 0
    && RESULT_KEYS.slice(4, -1).every((key) => value[key] === true)
    && value.status === 'ok'
    && value.importId === importIdentity?.importId
    && value.artifactId === importIdentity?.artifactId
}

export function validateWorkbookRolloutJournal(value) {
  if (!exact(value, TOP_KEYS) || value.schema !== 'workbook_rollout_journal.v2'
    || value.environment !== 'staging' || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')
    || !identifier(value.creatorId, 'stf') || !PHASES.has(value.phase)
    || !(value.importIdentity === null || importIdentityDto(value.importIdentity))
    || !(value.result === null || resultDto(value.result, value.importIdentity))) refused()
  const phaseValid = value.phase === 'initialized'
    ? value.importIdentity === null && value.result === null
    : value.phase === 'import_confirmed'
      ? value.importIdentity !== null && value.result === null
      : value.importIdentity !== null && value.result !== null
  if (!phaseValid) refused()
  return value
}

function retirementFor(value) {
  if (exact(value, ['schema', 'environment', 'phase'])
    && value.schema === RETIRED_LEGACY.schema
    && value.environment === RETIRED_LEGACY.environment
    && value.phase === RETIRED_LEGACY.phase) return RETIRED_LEGACY
  if (plain(value) && value.schema === 'workbook_rollout_journal.v1') return RETIRED_LEGACY
  return null
}

async function parentDescriptor(path) {
  const parent = dirname(path)
  let handle
  try {
    const stats = await lstat(parent)
    if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700) refused()
    if (await realpath(parent) !== parent) refused()
    handle = await open(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
      | (constants.O_NOFOLLOW ?? 0))
    const observed = await handle.stat()
    if (!observed.isDirectory() || observed.dev !== stats.dev || observed.ino !== stats.ino) refused()
    return { handle, stats }
  } catch (error) {
    await handle?.close()
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  }
}

async function existingDescriptor(path, required) {
  let handle
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600
      || stats.size < 1 || stats.size > MAX_BYTES) refused()
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const observed = await handle.stat()
    if (!observed.isFile() || observed.dev !== stats.dev || observed.ino !== stats.ino
      || (observed.mode & 0o777) !== 0o600) refused()
    return { handle, stats: observed }
  } catch (error) {
    await handle?.close()
    if (!required && error?.code === 'ENOENT') return null
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  }
}

async function persistentLockDescriptor(path) {
  let handle
  let created = false
  try {
    try {
      handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0), 0o600)
      created = true
      await handle.chmod(0o600)
      await handle.writeFile(LOCK_MARKER)
      await handle.sync()
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const before = await lstat(path)
      if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600
        || before.size !== Buffer.byteLength(LOCK_MARKER)) refused()
      handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      const observed = await handle.stat()
      if (!observed.isFile() || observed.dev !== before.dev || observed.ino !== before.ino
        || (observed.mode & 0o777) !== 0o600) refused()
      const bytes = await handle.readFile()
      try {
        if (bytes.toString('utf8') !== LOCK_MARKER) refused()
      } finally { bytes.fill(0) }
    }
    const stats = await handle.stat()
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600
      || stats.size !== Buffer.byteLength(LOCK_MARKER)) refused()
    return { handle, stats, created }
  } catch (error) {
    await handle?.close()
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  }
}

async function acquireKernelLock(path) {
  const command = process.platform === 'darwin' ? '/usr/bin/lockf'
    : process.platform === 'linux' ? '/usr/bin/flock' : null
  if (command === null) refused()
  const holderSource = `
    const ownerPid = ${process.pid}
    setInterval(() => {
      try { process.kill(ownerPid, 0) } catch { process.exit(0) }
    }, 100)
    process.stdout.write('locked\\n')
  `
  const args = process.platform === 'darwin'
    ? ['-t', '0', '-k', path, process.execPath, '--input-type=module', '--eval', holderSource]
    : ['-n', path, process.execPath, '--input-type=module', '--eval', holderSource]
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  try {
    await new Promise((resolveLock, rejectLock) => {
      let output = ''
      let settled = false
      const settle = (callback) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        callback()
      }
      const timeout = setTimeout(() => settle(rejectLock), 5_000)
      child.once('error', () => settle(rejectLock))
      child.once('exit', () => settle(rejectLock))
      child.stdout.on('data', (chunk) => {
        output += chunk.toString('utf8')
        if (output === 'locked\n') settle(resolveLock)
        else if (output.length > 7 || !'locked\n'.startsWith(output)) settle(rejectLock)
      })
    })
    return child
  } catch {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    refused()
  }
}

async function releaseKernelLock(child) {
  try {
    const exit = new Promise((resolveExit) => {
      const timeout = setTimeout(() => resolveExit(null), 5_000)
      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        resolveExit({ code, signal })
      })
    })
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    const observed = await exit
    if (observed === null
      || !(observed.code === 0 || observed.signal === 'SIGTERM')) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      refused()
    }
  } catch (error) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  }
}

export async function createWorkbookRolloutJournal(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path).length < 1
    || resolve(path) !== path || basename(path).length > 128 || path.includes('\0')) refused()
  const parent = await parentDescriptor(path)
  try {
    const existing = await existingDescriptor(path, false)
    await existing?.handle.close()
  } finally { await parent.handle.close() }

  const lockPath = `${path}.lock`
  const writeValue = async (value, validate) => {
    validate(value)
    let bytes
    let tempHandle
    const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    const parentBefore = await parentDescriptor(path)
    try {
      const existing = await existingDescriptor(path, false)
      await existing?.handle.close()
      bytes = Buffer.from(JSON.stringify(value))
      if (bytes.length < 1 || bytes.length > MAX_BYTES) refused()
      tempHandle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT
        | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      await tempHandle.chmod(0o600)
      const tempStats = await tempHandle.stat()
      if (!tempStats.isFile() || (tempStats.mode & 0o777) !== 0o600) refused()
      await tempHandle.writeFile(bytes)
      await tempHandle.sync()
      await tempHandle.close()
      tempHandle = null
      await rename(tempPath, path)
      await parentBefore.handle.sync()
      const saved = await existingDescriptor(path, true)
      await saved.handle.close()
      const parentAfter = await lstat(dirname(path))
      if (parentAfter.dev !== parentBefore.stats.dev || parentAfter.ino !== parentBefore.stats.ino) {
        refused()
      }
    } catch (error) {
      if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
      refused()
    } finally {
      bytes?.fill(0)
      await tempHandle?.close()
      await unlink(tempPath).catch(() => {})
      await parentBefore.handle.close()
    }
  }
  return Object.freeze({
    async runExclusive(task) {
      if (typeof task !== 'function') refused()
      const lockParent = await parentDescriptor(path)
      let lockDescriptor
      let lockStats
      let lockHolder
      let result
      let taskError
      let taskStarted = false
      try {
        lockDescriptor = await persistentLockDescriptor(lockPath)
        lockStats = lockDescriptor.stats
        await lockDescriptor.handle.close()
        lockDescriptor = null
        if (lockStats && (await lstat(lockPath)).ino !== lockStats.ino) refused()
        lockHolder = await acquireKernelLock(lockPath)
        taskStarted = true
        result = await task()
      } catch (error) {
        taskError = error
      }
      let cleanupFailed = false
      try {
        await lockDescriptor?.handle.close()
        if (lockStats) {
          const observed = await lstat(lockPath)
          if (!observed.isFile() || observed.isSymbolicLink()
            || observed.dev !== lockStats.dev || observed.ino !== lockStats.ino
            || (observed.mode & 0o777) !== 0o600
            || observed.size !== Buffer.byteLength(LOCK_MARKER)) refused()
        }
        if (lockHolder) await releaseKernelLock(lockHolder)
        await lockParent.handle.sync()
      } catch { cleanupFailed = true }
      await lockParent.handle.close()
      if (cleanupFailed) refused()
      if (taskError) {
        if (taskStarted) throw taskError
        refused()
      }
      return result
    },
    async load() {
      const descriptor = await existingDescriptor(path, false)
      if (!descriptor) return null
      let bytes
      let parsed
      try {
        bytes = await descriptor.handle.readFile()
        if (bytes.length !== descriptor.stats.size) refused()
        parsed = JSON.parse(bytes.toString('utf8'))
      } catch (error) {
        if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
        refused()
      } finally {
        bytes?.fill(0)
        await descriptor.handle.close()
      }
      const retirement = retirementFor(parsed)
      if (retirement) {
        await writeValue(retirement, (value) => {
          if (value !== RETIRED_LEGACY) refused()
        })
        return null
      }
      return validateWorkbookRolloutJournal(parsed)
    },
    async save(value) {
      await writeValue(value, validateWorkbookRolloutJournal)
    },
  })
}
