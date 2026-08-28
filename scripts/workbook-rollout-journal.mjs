import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  WORKBOOK_MATERIALIZER_VERSION,
  WORKBOOK_PARSER_VERSION,
} from '../src/workbook-import.js'

const MAX_BYTES = 1024 * 1024
const LOCK_MARKER = 'workbook_rollout_lock.v1\n'
const PHASES = new Set([
  'initialized', 'preview_pending', 'previewed', 'commit_pending', 'committed',
  'continue_pending', 'materialized', 'replay_commit_pending',
  'replay_continue_pending', 'complete',
])
const TOP_KEYS = Object.freeze([
  'schema', 'environment', 'fingerprint', 'rolloutIdentity', 'commitIdempotencyKey',
  'rolloutRequest', 'phase', 'preview', 'previewRecordedAtMs', 'pendingOperation',
  'commitOperation', 'importIdentity',
  'continuations', 'result',
])
const refused = () => { throw new Error('WORKBOOK_ROLLOUT_STAGING_REFUSED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const identifier = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,120}$`).test(value)
const secret = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 4096
  && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value)

function resolutionsDto(value) {
  return Array.isArray(value) && value.length <= 100
    && value.every((entry) => exact(entry, ['conflictId', 'specialistId'])
      && identifier(entry.conflictId, 'wmc') && identifier(entry.specialistId, 'sp'))
    && new Set(value.map(({ conflictId }) => conflictId)).size === value.length
}

function stateDto(value) {
  return exact(value, [
    'importId', 'artifactId', 'status', 'version', 'createdRecords', 'voidedRecords',
    'converged',
  ]) && identifier(value.importId, 'wbi') && identifier(value.artifactId, 'wba')
    && ['ready', 'materializing', 'complete', 'failed'].includes(value.status)
    && Number.isSafeInteger(value.version) && value.version >= 1
    && Number.isSafeInteger(value.createdRecords) && value.createdRecords >= 0
    && Number.isSafeInteger(value.voidedRecords) && value.voidedRecords >= 0
    && typeof value.converged === 'boolean'
}

function operationDto(value, responseKey = false) {
  const keys = ['kind', 'idempotencyKey', 'body', ...(responseKey ? ['response'] : [])]
  if (!exact(value, keys)) return false
  if (value.kind === 'preview') return !responseKey && value.idempotencyKey === null
    && exact(value.body, ['workbookFingerprint'])
    && /^[a-f0-9]{64}$/.test(value.body.workbookFingerprint ?? '')
  if (value.kind === 'commit') return secret(value.idempotencyKey)
    && exact(value.body, [
      'workbookFingerprint', 'previewToken', 'planDigest', 'resolutions',
    ])
    && /^[a-f0-9]{64}$/.test(value.body.workbookFingerprint ?? '')
    && secret(value.body.previewToken)
    && /^v1_[A-Za-z0-9_-]{43}$/.test(value.body.planDigest ?? '')
    && resolutionsDto(value.body.resolutions)
    && (!responseKey || stateDto(value.response))
  if (value.kind === 'continue') return secret(value.idempotencyKey)
    && exact(value.body, ['importId', 'expectedVersion'])
    && identifier(value.body.importId, 'wbi')
    && Number.isSafeInteger(value.body.expectedVersion) && value.body.expectedVersion >= 1
    && (!responseKey || value.response === null || stateDto(value.response))
  return false
}

function safeJson(value, depth = 0) {
  if (depth > 12) refused()
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) refused()
    return
  }
  if (typeof value === 'string') {
    if (value.length > 8192 || /[\p{Cc}\p{Cf}]/u.test(value)) refused()
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 512) refused()
    value.forEach((entry) => safeJson(entry, depth + 1))
    return
  }
  if (!plain(value) || Reflect.ownKeys(value).length > 128) refused()
  for (const [key, entry] of Object.entries(value)) {
    if (key.length < 1 || key.length > 128) refused()
    safeJson(entry, depth + 1)
  }
}

export function validateWorkbookRolloutJournal(value) {
  if (!exact(value, TOP_KEYS) || value.schema !== 'workbook_rollout_journal.v1'
    || value.environment !== 'staging' || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(value.rolloutIdentity ?? '')
    || value.commitIdempotencyKey !== `rollout-commit-${value.rolloutIdentity}`
    || !PHASES.has(value.phase) || !Array.isArray(value.continuations)
    || value.continuations.length > 256
    || !(value.previewRecordedAtMs === null
      || (Number.isSafeInteger(value.previewRecordedAtMs) && value.previewRecordedAtMs >= 0))) refused()
  if (!exact(value.rolloutRequest, ['workbookFingerprint', 'resolutions'])
    || value.rolloutRequest.workbookFingerprint !== value.fingerprint
    || !resolutionsDto(value.rolloutRequest.resolutions)
    || !(value.preview === null || (exact(value.preview, [
      'fingerprint', 'parserVersion', 'materializerVersion', 'planDigest',
      'previewToken', 'conflictIds', 'workbookKind',
    ]) && value.preview.fingerprint === value.fingerprint
      && value.preview.parserVersion === WORKBOOK_PARSER_VERSION
      && value.preview.materializerVersion === WORKBOOK_MATERIALIZER_VERSION
      && /^v1_[A-Za-z0-9_-]{43}$/.test(value.preview.planDigest ?? '')
      && value.preview.workbookKind === 'legacy'
      && secret(value.preview.previewToken) && Array.isArray(value.preview.conflictIds)
      && value.preview.conflictIds.length <= 100
      && value.preview.conflictIds.every((id) => identifier(id, 'wmc'))
      && new Set(value.preview.conflictIds).size === value.preview.conflictIds.length))
    || !(value.pendingOperation === null || operationDto(value.pendingOperation))
    || !(value.commitOperation === null || operationDto(value.commitOperation, true))
    || !(value.importIdentity === null || (exact(value.importIdentity, ['importId', 'artifactId'])
      && identifier(value.importIdentity.importId, 'wbi')
      && identifier(value.importIdentity.artifactId, 'wba')))
    || !value.continuations.every((entry) => operationDto(entry, true)
      && entry.kind === 'continue')) refused()
  const requestResolutions = value.rolloutRequest.resolutions
  const resolutionIds = requestResolutions.map(({ conflictId }) => conflictId).sort()
  if ((value.preview === null) !== (value.previewRecordedAtMs === null)
    || (value.preview !== null && !isDeepStrictEqual(
      [...value.preview.conflictIds].sort(), resolutionIds,
    ))) refused()
  if (value.commitOperation !== null) {
    const operation = value.commitOperation
    if (operation.idempotencyKey !== value.commitIdempotencyKey
      || operation.body.workbookFingerprint !== value.fingerprint
      || operation.body.previewToken !== value.preview?.previewToken
      || operation.body.planDigest !== value.preview?.planDigest
      || !isDeepStrictEqual(operation.body.resolutions, requestResolutions)
      || value.importIdentity === null
      || operation.response.importId !== value.importIdentity.importId
      || operation.response.artifactId !== value.importIdentity.artifactId) refused()
  } else if (value.importIdentity !== null) refused()
  value.continuations.forEach((entry, index) => {
    if (value.importIdentity === null
      || entry.idempotencyKey !== `rollout-continue-${value.rolloutIdentity}-${index + 1}`
      || entry.body.importId !== value.importIdentity.importId
      || (entry.response !== null && (entry.response.importId !== value.importIdentity.importId
        || entry.response.artifactId !== value.importIdentity.artifactId))) refused()
  })
  const expectedPending = value.pendingOperation?.kind === 'continue'
    ? value.continuations.find((entry) => (
      entry.idempotencyKey === value.pendingOperation.idempotencyKey
    )) : null
  if (value.pendingOperation?.kind === 'preview'
    && value.pendingOperation.body.workbookFingerprint !== value.fingerprint) refused()
  if (value.pendingOperation?.kind === 'commit') {
    const operation = value.pendingOperation
    if (operation.idempotencyKey !== value.commitIdempotencyKey
      || operation.body.workbookFingerprint !== value.fingerprint
      || operation.body.previewToken !== value.preview?.previewToken
      || operation.body.planDigest !== value.preview?.planDigest
      || !isDeepStrictEqual(operation.body.resolutions, requestResolutions)
      || (value.commitOperation !== null && !isDeepStrictEqual(
        operation,
        {
          kind: value.commitOperation.kind,
          idempotencyKey: value.commitOperation.idempotencyKey,
          body: value.commitOperation.body,
        },
      ))) refused()
  }
  if (value.pendingOperation?.kind === 'continue'
    && (value.importIdentity === null
      || value.pendingOperation.body.importId !== value.importIdentity.importId
      || expectedPending === undefined
      || !isDeepStrictEqual(value.pendingOperation, {
        kind: expectedPending.kind,
        idempotencyKey: expectedPending.idempotencyKey,
        body: expectedPending.body,
      }))) refused()
  const phaseValid = {
    initialized: value.preview === null && value.pendingOperation === null
      && value.commitOperation === null && value.continuations.length === 0,
    preview_pending: value.preview === null && value.pendingOperation?.kind === 'preview'
      && value.commitOperation === null && value.continuations.length === 0,
    previewed: value.preview !== null && value.pendingOperation === null
      && value.commitOperation === null && value.continuations.length === 0,
    commit_pending: value.preview !== null && value.pendingOperation?.kind === 'commit'
      && value.commitOperation === null && value.continuations.length === 0,
    replay_commit_pending: value.preview !== null && value.pendingOperation?.kind === 'commit'
      && value.commitOperation !== null,
    committed: value.preview !== null && value.pendingOperation === null
      && value.commitOperation !== null,
    continue_pending: value.preview !== null && value.pendingOperation?.kind === 'continue'
      && value.commitOperation !== null,
    replay_continue_pending: value.preview !== null
      && value.pendingOperation?.kind === 'continue' && value.commitOperation !== null,
    materialized: false,
    complete: value.preview !== null && value.pendingOperation === null
      && value.commitOperation !== null,
  }[value.phase]
  if (!phaseValid) refused()
  const resultKeys = [
    'artifactId', 'importId', 'acceptedCount', 'quarantinedCount',
    'previewWritesZero', 'terminalComplete', 'artifactVerified',
    'reconciliationMatched', 'replayIdentityMatch', 'replayWritesZero', 'status',
  ]
  if ((value.phase === 'complete') !== (value.result !== null)) refused()
  if (value.result !== null && (!exact(value.result, resultKeys)
    || !/^wba_[A-Za-z0-9_-]{1,120}$/.test(value.result.artifactId ?? '')
    || !/^wbi_[A-Za-z0-9_-]{1,120}$/.test(value.result.importId ?? '')
    || !Number.isSafeInteger(value.result.acceptedCount) || value.result.acceptedCount < 0
    || !Number.isSafeInteger(value.result.quarantinedCount) || value.result.quarantinedCount < 0
    || resultKeys.slice(4, -1).some((key) => value.result[key] !== true)
    || value.result.status !== 'ok'
    || value.importIdentity?.importId !== value.result.importId
    || value.importIdentity?.artifactId !== value.result.artifactId)) refused()
  safeJson(value)
  return value
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
      try {
        bytes = await descriptor.handle.readFile()
        if (bytes.length !== descriptor.stats.size) refused()
        return validateWorkbookRolloutJournal(JSON.parse(bytes.toString('utf8')))
      } catch (error) {
        if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
        refused()
      } finally {
        bytes?.fill(0)
        await descriptor.handle.close()
      }
    },
    async save(value) {
      validateWorkbookRolloutJournal(value)
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
        if (parentAfter.dev !== parentBefore.stats.dev || parentAfter.ino !== parentBefore.stats.ino) refused()
      } catch (error) {
        if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
        refused()
      } finally {
        bytes?.fill(0)
        await tempHandle?.close()
        await unlink(tempPath).catch(() => {})
        await parentBefore.handle.close()
      }
    },
  })
}
