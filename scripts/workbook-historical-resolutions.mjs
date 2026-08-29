import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

import { compareUtf16CodeUnits } from '../src/code-unit-order.js'
import { SERVICES } from '../src/services.js'

const MAX_BYTES = 1024 * 1024
const APPROVED_FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const TOP_KEYS = Object.freeze([
  'schema', 'environment', 'centreId', 'fingerprint', 'artifactId', 'importId',
  'creatorId', 'planDigest', 'decisionCount', 'decisionDigest', 'decisions',
])
const DECISION_KEYS = Object.freeze([
  'sourceRecordId', 'kind', 'classification', 'existingSubjectId', 'serviceId',
  'reviewContextDigest',
])
const BINDING_KEYS = Object.freeze([
  'environment', 'centreId', 'fingerprint', 'artifactId', 'importId', 'creatorId',
  'planDigest',
])
const CATALOG_KEYS = Object.freeze(['sourceRecordId', 'kind'])
const SERVICE_IDS = new Set(SERVICES.map(({ id }) => id))
const ID = Object.freeze({
  artifact: /^wba_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  import: /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  creator: /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  source: /^wbs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  client: /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  counterparty: /^hcp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
})

const refused = () => { throw new Error('WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const orderedExact = (value, keys) => plain(value)
  && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every((key, index) => key === keys[index])
const hexDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const REVISION_KEYS = Object.freeze([
  'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs',
])
const sameRevision = (left, right) => REVISION_KEYS.every((key) => left[key] === right[key])

function decisionDto(value) {
  if (!orderedExact(value, DECISION_KEYS) || !ID.source.test(value.sourceRecordId ?? '')
    || !['classification', 'service'].includes(value.kind)
    || !['person', 'counterparty', 'exclude'].includes(value.classification)
    || !(value.existingSubjectId === null
      || ID.client.test(value.existingSubjectId ?? '')
      || ID.counterparty.test(value.existingSubjectId ?? ''))
    || !(value.serviceId === null || SERVICE_IDS.has(value.serviceId))
    || !hexDigest(value.reviewContextDigest)
    || (value.classification === 'person' && value.existingSubjectId !== null
      && !ID.client.test(value.existingSubjectId))
    || (value.classification === 'counterparty' && value.existingSubjectId !== null
      && !ID.counterparty.test(value.existingSubjectId))
    || (value.classification === 'exclude'
      && (value.existingSubjectId !== null || value.serviceId !== null))
    || (value.classification !== 'exclude' && value.serviceId === null)) refused()
  return Object.freeze(Object.fromEntries(DECISION_KEYS.map((key) => [key, value[key]])))
}

function artifactDto(value) {
  if (!orderedExact(value, TOP_KEYS)
    || value.schema !== 'historical_projection_resolutions.v1'
    || value.environment !== 'staging' || value.centreId !== 'centre_1'
    || value.fingerprint !== APPROVED_FINGERPRINT || !ID.artifact.test(value.artifactId ?? '')
    || !ID.import.test(value.importId ?? '') || !ID.creator.test(value.creatorId ?? '')
    || typeof value.planDigest !== 'string' || !/^v1_[A-Za-z0-9_-]{43}$/.test(value.planDigest)
    || value.decisionCount !== 1_992 || !hexDigest(value.decisionDigest)
    || !Array.isArray(value.decisions)
    || Object.getPrototypeOf(value.decisions) !== Array.prototype
    || value.decisions.length !== value.decisionCount) refused()
  const decisions = value.decisions.map(decisionDto)
  for (let index = 1; index < decisions.length; index += 1) {
    if (compareUtf16CodeUnits(
      decisions[index - 1].sourceRecordId, decisions[index].sourceRecordId,
    ) >= 0) refused()
  }
  if (decisions.filter(({ kind }) => kind === 'classification').length !== 86
    || decisions.filter(({ kind }) => kind === 'service').length !== 1_906
    || sha256(JSON.stringify(decisions)) !== value.decisionDigest) refused()
  return Object.freeze({
    ...Object.fromEntries(TOP_KEYS.slice(0, -1).map((key) => [key, value[key]])),
    decisions: Object.freeze(decisions),
  })
}

export function validateHistoricalProjectionResolutionArtifact(value) {
  try { return artifactDto(value) } catch { refused() }
}

export function validateHistoricalResolutionPrivateFileFlags(fsConstants = constants) {
  if (!fsConstants || !Number.isInteger(fsConstants.O_RDONLY)
    || fsConstants.O_RDONLY < 0
    || !Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW <= 0
    || !Number.isInteger(fsConstants.O_DIRECTORY) || fsConstants.O_DIRECTORY <= 0) refused()
  return Object.freeze({
    directory: fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    file: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  })
}

async function openPrivateFile(path) {
  const flags = validateHistoricalResolutionPrivateFileFlags()
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
    || basename(path).length < 1 || basename(path).length > 160 || path.includes('\0')) refused()
  const parent = dirname(path)
  let directoryHandle
  let fileHandle
  let bytes
  let returned = false
  try {
    const directoryBefore = await lstat(parent, { bigint: true })
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()
      || (directoryBefore.mode & 0o777n) !== 0o700n || await realpath(parent) !== parent) refused()
    directoryHandle = await open(parent, flags.directory)
    const directoryAfter = await directoryHandle.stat({ bigint: true })
    if (!directoryAfter.isDirectory() || !sameRevision(directoryAfter, directoryBefore)) refused()

    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777n) !== 0o600n
      || before.size < 1n || before.size > BigInt(MAX_BYTES)) refused()
    fileHandle = await open(path, flags.file)
    const after = await fileHandle.stat({ bigint: true })
    if (!after.isFile() || !sameRevision(after, before)) refused()
    bytes = await fileHandle.readFile()
    if (BigInt(bytes.length) !== after.size) refused()
    const directoryDescriptorFinal = await directoryHandle.stat({ bigint: true })
    const directoryFinal = await lstat(parent, { bigint: true })
    const fileDescriptorFinal = await fileHandle.stat({ bigint: true })
    const fileFinal = await lstat(path, { bigint: true })
    if (!directoryDescriptorFinal.isDirectory() || !directoryFinal.isDirectory()
      || directoryFinal.isSymbolicLink()
      || !sameRevision(directoryDescriptorFinal, directoryAfter)
      || !sameRevision(directoryFinal, directoryAfter) || await realpath(parent) !== parent
      || !fileDescriptorFinal.isFile() || !fileFinal.isFile() || fileFinal.isSymbolicLink()
      || !sameRevision(fileDescriptorFinal, after) || !sameRevision(fileFinal, after)) refused()
    returned = true
    return bytes
  } catch (error) {
    if (error?.message === 'WORKBOOK_HISTORICAL_RESOLUTIONS_REFUSED') throw error
    refused()
  } finally {
    if (!returned) bytes?.fill(0)
    try { await fileHandle?.close() } catch { /* Refusal status is already fixed. */ }
    try { await directoryHandle?.close() } catch { /* Refusal status is already fixed. */ }
  }
}

export async function readHistoricalProjectionResolutions(path) {
  let bytes
  try {
    bytes = await openPrivateFile(path)
    let parsed
    try { parsed = JSON.parse(bytes.toString('utf8')) } catch { refused() }
    const artifact = artifactDto(parsed)
    if (JSON.stringify(artifact) !== bytes.toString('utf8')) refused()
    return Object.freeze({ artifact, fileSha256: sha256(bytes) })
  } catch {
    refused()
  } finally { bytes?.fill(0) }
}

export function assertHistoricalProjectionResolutionBinding({ loaded, binding, catalog } = {}) {
  try {
    if (!orderedExact(loaded, ['artifact', 'fileSha256']) || !hexDigest(loaded.fileSha256)
      || !orderedExact(binding, BINDING_KEYS) || !Array.isArray(catalog)
      || Object.getPrototypeOf(catalog) !== Array.prototype || catalog.length !== 1_992) refused()
    const artifact = artifactDto(loaded.artifact)
    if (sha256(JSON.stringify(artifact)) !== loaded.fileSha256
      || BINDING_KEYS.some((key) => artifact[key] !== binding[key])) refused()
    for (let index = 0; index < catalog.length; index += 1) {
      const item = catalog[index]
      if (!orderedExact(item, CATALOG_KEYS)
        || item.sourceRecordId !== artifact.decisions[index].sourceRecordId
        || item.kind !== artifact.decisions[index].kind) refused()
    }
    return loaded
  } catch { refused() }
}
