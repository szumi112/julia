import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_BYTES = 1024 * 1024
const LOCK_MARKER = 'workbook_rollout_lock.v1\n'
const PHASES = new Set(['initialized', 'import_confirmed', 'complete'])
const TOP_KEYS = Object.freeze([
  'schema', 'environment', 'fingerprint', 'creatorId', 'phase', 'importIdentity',
  'resolutionArtifact', 'resolutionHistory', 'rebind', 'projection', 'result',
])
const RESOLUTION_ARTIFACT_KEYS = Object.freeze([
  'fileSha256', 'decisionCount', 'decisionDigest', 'approvalMode', 'groupCount',
  'catalogDigest', 'groupDigest',
])
const REBIND_KEYS = Object.freeze([
  'previousFileSha256', 'previousDecisionDigest', 'jobId', 'version',
])
const HISTORICAL_PROJECTION_KEYS = Object.freeze([
  'jobId', 'status', 'totalRecords', 'processedRecords', 'projectedRecords',
  'conflictCount', 'resolutionCount', 'version', 'decisionFileSha256',
  'decisionCount', 'decisionDigest',
])
const ACTIVITY_PROJECTION_KEYS = Object.freeze([
  'jobId', 'status', 'totalRecords', 'processedRecords', 'projectedRecords',
  'version', 'decisionFileSha256', 'decisionCount', 'decisionDigest',
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
const hexDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const count = (value) => Number.isSafeInteger(value) && value >= 0

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

function resolutionArtifactDto(value) {
  return exact(value, RESOLUTION_ARTIFACT_KEYS)
    && hexDigest(value.fileSha256) && value.decisionCount === 1_992
    && hexDigest(value.decisionDigest)
    && ['initial', 'rebind'].includes(value.approvalMode)
    && Number.isSafeInteger(value.groupCount) && value.groupCount >= 1
    && value.groupCount <= 1_992 && hexDigest(value.catalogDigest)
    && hexDigest(value.groupDigest)
    && (value.approvalMode !== 'initial' || value.groupCount === 67)
}

function resolutionHistoryDto(value, current) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= 64 && value.every(resolutionArtifactDto)
    && new Set(value.map(({ fileSha256 }) => fileSha256)).size === value.length
    && (current === null || !value.some(({ fileSha256 }) => (
      fileSha256 === current.fileSha256
    )))
}

function rebindDto(value, resolutionArtifact) {
  if (value === null) return true
  return resolutionArtifactDto(resolutionArtifact) && exact(value, REBIND_KEYS)
    && value.previousFileSha256 === resolutionArtifact.fileSha256
    && value.previousDecisionDigest === resolutionArtifact.decisionDigest
    && ((value.jobId === null && value.version === 0)
      || (identifier(value.jobId, 'hpj') && Number.isSafeInteger(value.version)
        && value.version >= 1))
}

function projectionDto(value, resolutionArtifact) {
  if (value === null) return true
  const historical = exact(value, HISTORICAL_PROJECTION_KEYS)
  const activity = exact(value, ACTIVITY_PROJECTION_KEYS)
  if ((!historical && !activity) || !resolutionArtifactDto(resolutionArtifact)
    || !identifier(value.jobId, historical ? 'hpj' : 'apj')
    || !(historical
      ? ['ready', 'running', 'conflicts', 'complete'].includes(value.status)
      : ['ready', 'running', 'complete'].includes(value.status))
    || !count(value.totalRecords) || !count(value.processedRecords)
    || value.processedRecords > value.totalRecords
    || !count(value.projectedRecords) || value.projectedRecords > value.totalRecords
    || !Number.isSafeInteger(value.version) || value.version < 1
    || value.decisionFileSha256 !== resolutionArtifact.fileSha256
    || value.decisionCount !== resolutionArtifact.decisionCount
    || value.decisionDigest !== resolutionArtifact.decisionDigest
    || (historical && (!count(value.conflictCount) || !count(value.resolutionCount)
      || value.resolutionCount > value.conflictCount))) return false
  if (value.status === 'complete') return historical
    ? value.totalRecords === 2_000 && value.processedRecords === 2_000
      && value.conflictCount === 1_992 && value.resolutionCount === 1_992
    : value.totalRecords === 190 && value.processedRecords === 190
      && value.projectedRecords === 190
  return true
}

export function validateWorkbookRolloutJournal(value) {
  if (!exact(value, TOP_KEYS) || value.schema !== 'workbook_rollout_journal.v3'
    || value.environment !== 'staging' || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')
    || !identifier(value.creatorId, 'stf') || !PHASES.has(value.phase)
    || !(value.importIdentity === null || importIdentityDto(value.importIdentity))
    || !(value.resolutionArtifact === null
      || resolutionArtifactDto(value.resolutionArtifact))
    || !resolutionHistoryDto(value.resolutionHistory, value.resolutionArtifact)
    || !rebindDto(value.rebind, value.resolutionArtifact)
    || !projectionDto(value.projection, value.resolutionArtifact)
    || !(value.result === null || resultDto(value.result, value.importIdentity))) refused()
  const phaseValid = value.phase === 'initialized'
    ? value.importIdentity === null && value.resolutionArtifact === null
      && value.resolutionHistory.length === 0 && value.rebind === null
      && value.projection === null && value.result === null
    : value.phase === 'import_confirmed'
      ? value.importIdentity !== null && value.result === null
        && (value.resolutionArtifact !== null
          || (value.resolutionHistory.length === 0 && value.rebind === null
            && value.projection === null))
      : value.importIdentity !== null && value.resolutionArtifact !== null
        && value.rebind === null
        && exact(value.projection, ACTIVITY_PROJECTION_KEYS)
        && value.projection.status === 'complete' && value.result !== null
  if (!phaseValid) refused()
  return value
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const fixedBindingsMatch = (before, after) => before.environment === after.environment
  && before.fingerprint === after.fingerprint && before.creatorId === after.creatorId

function projectionTransition(before, after) {
  if (same(before, after)) return true
  if (before === null) return after !== null
  if (after === null) return false
  const beforeHistorical = Object.hasOwn(before, 'conflictCount')
  const afterHistorical = Object.hasOwn(after, 'conflictCount')
  if (beforeHistorical !== afterHistorical) return beforeHistorical
    && before.status === 'complete' && !afterHistorical
  return before.jobId === after.jobId && after.version >= before.version
    && after.totalRecords === before.totalRecords
    && after.processedRecords >= before.processedRecords
    && after.projectedRecords >= before.projectedRecords
    && (!beforeHistorical || (after.conflictCount >= before.conflictCount
      && after.resolutionCount >= before.resolutionCount))
}

function journalTransition(before, after) {
  if (before === null) return after.phase === 'initialized'
  if (!fixedBindingsMatch(before, after) || same(before, after)) return same(before, after)
  if (before.phase === 'complete') return false
  if (before.phase === 'initialized') return after.phase === 'import_confirmed'
    && after.importIdentity !== null && after.resolutionArtifact === null
    && after.resolutionHistory.length === 0 && after.rebind === null
    && after.projection === null && after.result === null
  if (!same(before.importIdentity, after.importIdentity)) return false
  if (after.phase === 'complete') return before.phase === 'import_confirmed'
    && before.resolutionArtifact !== null && before.rebind === null
    && same(before.resolutionArtifact, after.resolutionArtifact)
    && same(before.resolutionHistory, after.resolutionHistory)
  if (after.phase !== 'import_confirmed' || after.result !== null) return false
  if (before.resolutionArtifact === null) return after.resolutionArtifact !== null
    && after.resolutionArtifact.approvalMode === 'initial'
    && after.resolutionHistory.length === 0 && after.rebind === null
    && after.projection === null
  if (same(before.resolutionArtifact, after.resolutionArtifact)) {
    if (!same(before.resolutionHistory, after.resolutionHistory)) return false
    const rebindTransition = before.rebind === null && after.rebind !== null
      && same(before.projection, after.projection)
    const ordinary = same(before.rebind, after.rebind)
      && projectionTransition(before.projection, after.projection)
    return rebindTransition || ordinary
  }
  return before.rebind !== null && after.rebind === null
    && after.resolutionArtifact.approvalMode === 'rebind'
    && after.projection === null
    && after.resolutionHistory.length === before.resolutionHistory.length + 1
    && same(after.resolutionHistory.slice(0, -1), before.resolutionHistory)
    && same(after.resolutionHistory.at(-1), before.resolutionArtifact)
}

function retirementFor(value) {
  if (exact(value, ['schema', 'environment', 'phase'])
    && value.schema === RETIRED_LEGACY.schema
    && value.environment === RETIRED_LEGACY.environment
    && value.phase === RETIRED_LEGACY.phase) return RETIRED_LEGACY
  if (plain(value) && ['workbook_rollout_journal.v1', 'workbook_rollout_journal.v2']
    .includes(value.schema)) return RETIRED_LEGACY
  return null
}

const REVISION_KEYS = Object.freeze([
  'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs',
])
const sameRevision = (left, right) => REVISION_KEYS.every((key) => left[key] === right[key])
const mode = (stats) => Number(stats.mode & 0o777n)
export function validateWorkbookRolloutJournalPrivateFileFlags(fsConstants = constants) {
  if (!Number.isInteger(fsConstants?.O_NOFOLLOW) || fsConstants.O_NOFOLLOW <= 0
    || !Number.isInteger(fsConstants?.O_DIRECTORY) || fsConstants.O_DIRECTORY <= 0) refused()
  return fsConstants
}
const requiredFlag = (name) => {
  const value = validateWorkbookRolloutJournalPrivateFileFlags(constants)[name]
  return value
}
const noFollow = () => requiredFlag('O_NOFOLLOW')
const directoryOnly = () => requiredFlag('O_DIRECTORY')

async function parentDescriptor(path) {
  const parent = dirname(path)
  let handle
  try {
    const stats = await lstat(parent, { bigint: true })
    if (!stats.isDirectory() || stats.isSymbolicLink() || mode(stats) !== 0o700
      || await realpath(parent) !== parent) refused()
    handle = await open(parent, constants.O_RDONLY | directoryOnly() | noFollow())
    const observed = await handle.stat({ bigint: true })
    if (!observed.isDirectory() || !sameRevision(stats, observed)) refused()
    return { parent, handle, stats: observed }
  } catch (error) {
    await handle?.close()
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  }
}

async function refreshParent(descriptor, baseline = false) {
  const observed = await descriptor.handle.stat({ bigint: true })
  const pathStats = await lstat(descriptor.parent, { bigint: true })
  if (!observed.isDirectory() || !pathStats.isDirectory()
    || observed.isSymbolicLink() || pathStats.isSymbolicLink()
    || mode(observed) !== 0o700 || !sameRevision(observed, pathStats)
    || (baseline && !sameRevision(observed, descriptor.stats))
    || await realpath(descriptor.parent) !== descriptor.parent) refused()
  descriptor.stats = observed
  return observed
}

async function existingDescriptor(path, required) {
  let handle
  try {
    const stats = await lstat(path, { bigint: true })
    if (!stats.isFile() || stats.isSymbolicLink() || mode(stats) !== 0o600
      || stats.size < 1n || stats.size > BigInt(MAX_BYTES)) refused()
    handle = await open(path, constants.O_RDONLY | noFollow())
    const observed = await handle.stat({ bigint: true })
    if (!observed.isFile() || !sameRevision(stats, observed)) refused()
    return { handle, stats: observed }
  } catch (error) {
    await handle?.close()
    if (!required && error?.code === 'ENOENT') return null
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  }
}

async function assertExistingCurrent(path, descriptor) {
  const observed = await descriptor.handle.stat({ bigint: true })
  const pathStats = await lstat(path, { bigint: true })
  if (!observed.isFile() || !pathStats.isFile() || pathStats.isSymbolicLink()
    || mode(observed) !== 0o600 || !sameRevision(observed, descriptor.stats)
    || !sameRevision(observed, pathStats)) refused()
  return observed
}

async function assertMissing(path) {
  try { await lstat(path, { bigint: true }); refused() } catch (error) {
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    if (error?.code !== 'ENOENT') refused()
  }
}

async function readSnapshot(path, required = false) {
  const parent = await parentDescriptor(path)
  let file
  let bytes
  try {
    file = await existingDescriptor(path, required)
    if (file === null) {
      await assertMissing(path)
      await refreshParent(parent, true)
      return { parent, file: null, bytes: null }
    }
    bytes = await file.handle.readFile()
    if (BigInt(bytes.length) !== file.stats.size) refused()
    await assertExistingCurrent(path, file)
    await refreshParent(parent, true)
    return { parent, file, bytes }
  } catch (error) {
    bytes?.fill(0)
    await file?.handle.close()
    await parent.handle.close()
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  }
}

async function closeSnapshot(snapshot) {
  snapshot.bytes?.fill(0)
  await snapshot.file?.handle.close()
  await snapshot.parent.handle.close()
}

function parseSnapshot(snapshot) {
  if (snapshot.bytes === null) return null
  let parsed
  try { parsed = JSON.parse(snapshot.bytes.toString('utf8')) } catch { refused() }
  const retirement = retirementFor(parsed)
  if (retirement) return { parsed, retirement }
  const canonical = Buffer.from(JSON.stringify(parsed))
  try {
    if (!snapshot.bytes.equals(canonical)) refused()
  } finally { canonical.fill(0) }
  return { parsed: validateWorkbookRolloutJournal(parsed), retirement: null }
}

async function unlinkExact(path, expected) {
  try {
    const observed = await lstat(path, { bigint: true })
    if (!sameRevision(observed, expected)) return false
    await unlink(path)
    return true
  } catch { return false }
}

async function persistentLockDescriptor(path) {
  let handle
  let bytes
  try {
    try {
      handle = await open(path, constants.O_RDWR | noFollow())
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      handle = await open(path, constants.O_RDWR | constants.O_CREAT
        | constants.O_EXCL | noFollow(), 0o600)
      await handle.chmod(0o600)
      await handle.writeFile(LOCK_MARKER)
      await handle.sync()
    }
    const stats = await handle.stat({ bigint: true })
    const pathStats = await lstat(path, { bigint: true })
    if (!stats.isFile() || mode(stats) !== 0o600
      || stats.size !== BigInt(Buffer.byteLength(LOCK_MARKER))
      || !sameRevision(stats, pathStats)) refused()
    bytes = Buffer.alloc(Number(stats.size))
    const read = await handle.read(bytes, 0, bytes.length, 0)
    if (read.bytesRead !== bytes.length || bytes.toString('utf8') !== LOCK_MARKER) refused()
    const finalStats = await handle.stat({ bigint: true })
    const finalPath = await lstat(path, { bigint: true })
    if (!sameRevision(stats, finalStats) || !sameRevision(finalStats, finalPath)) refused()
    return { handle, stats: finalStats }
  } catch (error) {
    await handle?.close()
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  } finally { bytes?.fill(0) }
}

async function acquireKernelLock(handle) {
  const command = process.platform === 'darwin' ? '/usr/bin/lockf'
    : process.platform === 'linux' ? '/usr/bin/flock' : null
  if (command === null || !Number.isInteger(handle?.fd) || handle.fd < 0) refused()
  const holderSource = `
    process.stdin.resume()
    process.stdin.once('end', () => process.exit(0))
    process.stdin.once('error', () => process.exit(1))
    process.stdout.write('locked\\n')
  `
  const args = process.platform === 'darwin'
    ? ['-s', '-t', '0', '-k', '/dev/fd/3', process.execPath,
      '--input-type=module', '--eval', holderSource]
    : ['-n', '3', process.execPath, '--input-type=module', '--eval', holderSource]
  const child = spawn(command, args, {
    detached: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore', handle.fd],
  })
  const holder = {
    child,
    exited: false,
    code: null,
    signal: null,
  }
  child.once('exit', (code, signal) => {
    holder.exited = true
    holder.code = code
    holder.signal = signal
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
    if (holder.exited || child.exitCode !== null || child.signalCode !== null) refused()
    return holder
  } catch {
    child.stdin.destroy()
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    child.stdout.destroy()
    refused()
  }
}

function assertKernelLockAlive(holder) {
  if (holder?.exited || holder?.child?.exitCode !== null
    || holder?.child?.signalCode !== null) refused()
}

async function releaseKernelLock(holder) {
  const { child } = holder
  try {
    assertKernelLockAlive(holder)
    const exit = new Promise((resolveExit) => {
      const timeout = setTimeout(() => resolveExit(null), 5_000)
      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        resolveExit({ code, signal })
      })
    })
    child.stdin.end()
    const observed = await exit
    if (observed === null || observed.code !== 0 || observed.signal !== null) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      refused()
    }
    child.stdout.destroy()
  } catch (error) {
    child.stdin.destroy()
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    child.stdout.destroy()
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  }
}

export async function createWorkbookRolloutJournal(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path).length < 1
    || resolve(path) !== path || basename(path).length > 128 || path.includes('\0')) refused()
  const initial = await readSnapshot(path, false)
  await closeSnapshot(initial)

  const lockPath = `${path}.lock`
  const writeValue = async (value, validate, snapshot) => {
    validate(value)
    let bytes
    let tempHandle
    let targetHandle
    let tempStats = null
    let renamed = false
    const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    try {
      bytes = Buffer.from(JSON.stringify(value))
      if (bytes.length < 1 || bytes.length > MAX_BYTES) refused()
      if (snapshot.file === null) await assertMissing(path)
      else await assertExistingCurrent(path, snapshot.file)
      await refreshParent(snapshot.parent, true)
      tempHandle = await open(tempPath, constants.O_RDWR | constants.O_CREAT
        | constants.O_EXCL | noFollow(), 0o600)
      await tempHandle.chmod(0o600)
      await tempHandle.writeFile(bytes)
      await tempHandle.sync()
      tempStats = await tempHandle.stat({ bigint: true })
      if (!tempStats.isFile() || mode(tempStats) !== 0o600
        || tempStats.size !== BigInt(bytes.length)) refused()
      await refreshParent(snapshot.parent)
      if (snapshot.file === null) await assertMissing(path)
      else await assertExistingCurrent(path, snapshot.file)
      await rename(tempPath, path)
      renamed = true
      await snapshot.parent.handle.sync()
      const renamedStats = await tempHandle.stat({ bigint: true })
      const destination = await lstat(path, { bigint: true })
      if (!sameRevision(renamedStats, destination) || mode(destination) !== 0o600) refused()
      targetHandle = await open(path, constants.O_RDONLY | noFollow())
      const targetStats = await targetHandle.stat({ bigint: true })
      if (!sameRevision(renamedStats, targetStats)) refused()
      const savedBytes = await targetHandle.readFile()
      try {
        if (!savedBytes.equals(bytes)) refused()
        validate(JSON.parse(savedBytes.toString('utf8')))
      } finally { savedBytes.fill(0) }
      const finalTemp = await tempHandle.stat({ bigint: true })
      const finalTarget = await targetHandle.stat({ bigint: true })
      const finalPath = await lstat(path, { bigint: true })
      if (!sameRevision(finalTemp, finalTarget)
        || !sameRevision(finalTemp, finalPath)) refused()
      await refreshParent(snapshot.parent)
    } catch (error) {
      if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
      refused()
    } finally {
      bytes?.fill(0)
      await targetHandle?.close()
      await tempHandle?.close()
      if (!renamed && tempStats !== null) await unlinkExact(tempPath, tempStats)
    }
  }
  return Object.freeze({
    async runExclusive(task) {
      if (typeof task !== 'function') refused()
      const lockParent = await parentDescriptor(path)
      let lockDescriptor
      let lockHolder
      let result
      let taskError
      let taskStarted = false
      try {
        lockDescriptor = await persistentLockDescriptor(lockPath)
        await refreshParent(lockParent)
        lockHolder = await acquireKernelLock(lockDescriptor.handle)
        const descriptorStats = await lockDescriptor.handle.stat({ bigint: true })
        const pathStats = await lstat(lockPath, { bigint: true })
        if (!sameRevision(descriptorStats, lockDescriptor.stats)
          || !sameRevision(descriptorStats, pathStats)) refused()
        await refreshParent(lockParent)
        assertKernelLockAlive(lockHolder)
        taskStarted = true
        result = await task()
      } catch (error) {
        taskError = error
      }
      let cleanupFailed = false
      try {
        if (lockDescriptor) {
          if (lockHolder) assertKernelLockAlive(lockHolder)
          const descriptorStats = await lockDescriptor.handle.stat({ bigint: true })
          const pathStats = await lstat(lockPath, { bigint: true })
          if (!sameRevision(descriptorStats, lockDescriptor.stats)
            || !sameRevision(descriptorStats, pathStats)) refused()
          await refreshParent(lockParent)
        }
      } catch { cleanupFailed = true }
      try {
        if (lockHolder) await releaseKernelLock(lockHolder)
      } catch { cleanupFailed = true }
      await lockDescriptor?.handle.close()
      await lockParent.handle.close()
      if (cleanupFailed) refused()
      if (taskError) {
        if (taskStarted) throw taskError
        refused()
      }
      return result
    },
    async load() {
      const snapshot = await readSnapshot(path, false)
      try {
        const decoded = parseSnapshot(snapshot)
        if (decoded === null) return null
        if (decoded.retirement) {
          if (decoded.parsed.schema === RETIRED_LEGACY.schema
            && same(decoded.parsed, RETIRED_LEGACY)) return null
          await writeValue(RETIRED_LEGACY, (value) => {
            if (!same(value, RETIRED_LEGACY)) refused()
          }, snapshot)
          return null
        }
        return decoded.parsed
      } finally { await closeSnapshot(snapshot) }
    },
    async save(value) {
      validateWorkbookRolloutJournal(value)
      const snapshot = await readSnapshot(path, false)
      try {
        const decoded = parseSnapshot(snapshot)
        const current = decoded === null || decoded.retirement ? null : decoded.parsed
        if (!journalTransition(current, value)) refused()
        await writeValue(value, (candidate) => {
          validateWorkbookRolloutJournal(candidate)
          if (!same(candidate, value)) refused()
        }, snapshot)
      } finally { await closeSnapshot(snapshot) }
    },
  })
}
