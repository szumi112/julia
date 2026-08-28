import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_BYTES = 4 * 1024 * 1024
const refused = () => { throw new Error('WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED') }
const REVISION_KEYS = Object.freeze([
  'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs',
])
const sameRevision = (left, right) => REVISION_KEYS.every((key) => left[key] === right[key])
const LINK_STABLE_KEYS = Object.freeze([
  'dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs',
])
const PARENT_STABLE_KEYS = Object.freeze(['dev', 'ino', 'mode', 'uid', 'gid'])
const sameFields = (left, right, keys) => keys.every((key) => left[key] === right[key])

function validPath(path) {
  return typeof path === 'string' && isAbsolute(path) && resolve(path) === path
    && !path.includes('\0') && basename(path).length >= 1 && basename(path).length <= 160
}

export function validateHistoricalReviewPrivateFileFlags(fsConstants = constants) {
  if (!fsConstants || !Number.isInteger(fsConstants.O_RDONLY)
    || fsConstants.O_RDONLY < 0
    || !Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW <= 0
    || !Number.isInteger(fsConstants.O_DIRECTORY) || fsConstants.O_DIRECTORY <= 0) refused()
  return Object.freeze({
    directory: fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    file: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  })
}

async function privateParent(path) {
  const flags = validateHistoricalReviewPrivateFileFlags()
  if (!validPath(path)) refused()
  const parent = dirname(path)
  let handle
  try {
    const before = await lstat(parent, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o777n) !== 0o700n
      || await realpath(parent) !== parent) refused()
    handle = await open(parent, flags.directory)
    const after = await handle.stat({ bigint: true })
    if (!after.isDirectory() || !sameRevision(after, before)) refused()
    return { parent, before, flags, handle }
  } catch (error) {
    await handle?.close()
    if (error?.message === 'WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED') throw error
    refused()
  }
}

async function privateFile(path) {
  const parent = await privateParent(path)
  let handle
  try {
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777n) !== 0o600n
      || before.size < 1n || before.size > BigInt(MAX_BYTES)) refused()
    handle = await open(path, parent.flags.file)
    const after = await handle.stat({ bigint: true })
    if (!after.isFile() || !sameRevision(after, before)) refused()
    return { parent, before: after, handle }
  } catch (error) {
    await handle?.close()
    await parent.handle.close()
    if (error?.message === 'WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED') throw error
    refused()
  }
}

export async function readPrivateHistoricalReviewJson(path) {
  const descriptor = await privateFile(path)
  let bytes
  try {
    bytes = await descriptor.handle.readFile()
    if (BigInt(bytes.length) !== descriptor.before.size) refused()
    let value
    try { value = JSON.parse(bytes.toString('utf8')) } catch { refused() }
    if (JSON.stringify(value) !== bytes.toString('utf8')) refused()
    const descriptorFile = await descriptor.handle.stat({ bigint: true })
    const afterFile = await lstat(path, { bigint: true })
    const descriptorParent = await descriptor.parent.handle.stat({ bigint: true })
    const afterParent = await lstat(descriptor.parent.parent, { bigint: true })
    if (!descriptorFile.isFile() || !afterFile.isFile() || afterFile.isSymbolicLink()
      || !sameRevision(descriptorFile, descriptor.before)
      || !sameRevision(afterFile, descriptor.before)
      || !descriptorParent.isDirectory() || !afterParent.isDirectory()
      || afterParent.isSymbolicLink()
      || !sameRevision(descriptorParent, descriptor.parent.before)
      || !sameRevision(afterParent, descriptor.parent.before)
      || await realpath(descriptor.parent.parent) !== descriptor.parent.parent) refused()
    return value
  } catch (error) {
    if (error?.message === 'WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED') throw error
    refused()
  } finally {
    bytes?.fill(0)
    await descriptor.handle.close()
    await descriptor.parent.handle.close()
  }
}

async function unlinkCreatedDestination(path, created) {
  try {
    const current = await lstat(path, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== created.dev || current.ino !== created.ino) return false
    await unlink(path)
    return true
  } catch { return false }
}

export async function writePrivateHistoricalReviewJson(path, value) {
  const parent = await privateParent(path)
  const tempPath = join(parent.parent, `.${basename(path)}.${randomUUID()}.tmp`)
  let bytes
  let readback
  let handle
  let created
  let destinationLinked = false
  let succeeded = false
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) refused()
    bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length < 1 || bytes.length > MAX_BYTES) refused()
    if (!Number.isInteger(constants.O_RDWR)) refused()
    handle = await open(tempPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
      | constants.O_NOFOLLOW, 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    const written = await handle.stat({ bigint: true })
    if (!written.isFile() || (written.mode & 0o777n) !== 0o600n
      || written.size !== BigInt(bytes.length) || written.nlink !== 1n) refused()
    created = Object.freeze({ dev: written.dev, ino: written.ino })
    await link(tempPath, path)
    destinationLinked = true
    await unlink(tempPath)
    await parent.handle.sync()
    const linkedDescriptor = await handle.stat({ bigint: true })
    if (!linkedDescriptor.isFile() || linkedDescriptor.nlink !== 1n
      || !sameFields(linkedDescriptor, written, LINK_STABLE_KEYS)
      || linkedDescriptor.ctimeNs < written.ctimeNs) refused()

    readback = Buffer.alloc(bytes.length)
    let offset = 0
    while (offset < readback.length) {
      const { bytesRead } = await handle.read(
        readback, offset, readback.length - offset, offset,
      )
      if (bytesRead < 1) refused()
      offset += bytesRead
    }
    if (!readback.equals(bytes)) refused()

    const saved = await lstat(path, { bigint: true })
    const parentDescriptorFinal = await parent.handle.stat({ bigint: true })
    const parentPathFinal = await lstat(parent.parent, { bigint: true })
    if (!saved.isFile() || saved.isSymbolicLink()
      || !sameRevision(saved, linkedDescriptor)
      || !parentDescriptorFinal.isDirectory() || !parentPathFinal.isDirectory()
      || parentPathFinal.isSymbolicLink()
      || !sameRevision(parentDescriptorFinal, parentPathFinal)
      || !sameFields(parentDescriptorFinal, parent.before, PARENT_STABLE_KEYS)
      || parentDescriptorFinal.mtimeNs < parent.before.mtimeNs
      || parentDescriptorFinal.ctimeNs < parent.before.ctimeNs
      || await realpath(parent.parent) !== parent.parent) refused()
    succeeded = true
  } catch (error) {
    if (error?.message === 'WORKBOOK_HISTORICAL_REVIEW_PRIVATE_REFUSED') throw error
    refused()
  } finally {
    bytes?.fill(0)
    readback?.fill(0)
    if (!succeeded && destinationLinked && created
      && await unlinkCreatedDestination(path, created)) {
      try { await parent.handle.sync() } catch { /* Refusal status is already fixed. */ }
    }
    await unlink(tempPath).catch(() => {})
    try { await handle?.close() } catch { /* Refusal status is already fixed. */ }
    try { await parent.handle.close() } catch { /* Refusal status is already fixed. */ }
  }
}
