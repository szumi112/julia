import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { request } from '@playwright/test'

import { validateStagingBackupConfig } from './backup-staging-lib.mjs'
import { AUTHORITATIVE_WORKBOOK_FINGERPRINT } from './audit-workbook-lib.mjs'
import {
  createStagingWorkbookApi,
  readStagingSession,
} from './workbook-rollout-staging-http.mjs'
import { createWorkbookRolloutJournal } from './workbook-rollout-journal.mjs'
import { readHistoricalProjectionResolutions } from './workbook-historical-resolutions.mjs'
import { assertApprovedRolloutActorAndResolutions } from './workbook-rollout-staging-lib.mjs'
import { runResumableStagingWorkbookRollout } from './workbook-rollout-resume.mjs'

const EXPECTED_RECONCILIATION = Object.freeze({
  activeAcceptedSourceRecords: 2232,
  quarantinedSourceRecords: 3,
  monthlyDateQuarantines: 2,
  fixedOrphanAmountQuarantines: 1,
  amountStoredAsTextWarnings: 2,
  correctedCombinedSheetMonths: 45,
  tusRecords: 25,
  englishRecords: 165,
  formulaGhostsExcluded: 5,
  unexplainedDroppedCandidates: 0,
  ledgerLinksUnique: true,
  projectionLinksUnique: true,
  parentTotalsReconcile: true,
})
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const refused = () => { throw new Error('WORKBOOK_ROLLOUT_STAGING_REFUSED') }
const failed = () => { throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED') }
const REVISION_KEYS = Object.freeze([
  'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs',
])
const sameRevision = (left, right) => REVISION_KEYS.every((key) => left[key] === right[key])

function environmentPath(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length < 1 || value !== value.trim()
    || value.includes('\0')) refused()
  return value
}

function optionalEnvironmentPath(name) {
  const value = process.env[name]
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length < 1 || value !== value.trim()
    || value.includes('\0')) refused()
  return value
}

export function validatePrivateRolloutFileFlags(fsConstants = constants) {
  if (!fsConstants || !Number.isInteger(fsConstants.O_RDONLY)
    || fsConstants.O_RDONLY < 0
    || !Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW <= 0
    || !Number.isInteger(fsConstants.O_DIRECTORY) || fsConstants.O_DIRECTORY <= 0) refused()
  return Object.freeze({
    directory: fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    file: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  })
}

export async function readPrivateRolloutInput(path, maximumBytes) {
  let directoryHandle
  let fileHandle
  let bytes
  let returned = false
  try {
    const flags = validatePrivateRolloutFileFlags()
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
      || path.includes('\0') || basename(path).length < 1 || basename(path).length > 160
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) refused()
    const parent = dirname(path)
    const directoryBefore = await lstat(parent, { bigint: true })
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()
      || (directoryBefore.mode & 0o777n) !== 0o700n
      || await realpath(parent) !== parent) refused()
    directoryHandle = await open(parent, flags.directory)
    const directoryOpened = await directoryHandle.stat({ bigint: true })
    if (!directoryOpened.isDirectory() || !sameRevision(directoryOpened, directoryBefore)) refused()

    const fileBefore = await lstat(path, { bigint: true })
    if (!fileBefore.isFile() || fileBefore.isSymbolicLink()
      || (fileBefore.mode & 0o777n) !== 0o600n
      || fileBefore.size < 1n || fileBefore.size > BigInt(maximumBytes)) refused()
    fileHandle = await open(path, flags.file)
    const fileOpened = await fileHandle.stat({ bigint: true })
    if (!fileOpened.isFile() || !sameRevision(fileOpened, fileBefore)) refused()

    bytes = await fileHandle.readFile()
    if (BigInt(bytes.length) !== fileOpened.size) refused()

    const fileDescriptorFinal = await fileHandle.stat({ bigint: true })
    const filePathFinal = await lstat(path, { bigint: true })
    const directoryDescriptorFinal = await directoryHandle.stat({ bigint: true })
    const directoryPathFinal = await lstat(parent, { bigint: true })
    if (!fileDescriptorFinal.isFile() || !filePathFinal.isFile()
      || filePathFinal.isSymbolicLink()
      || !sameRevision(fileDescriptorFinal, fileOpened)
      || !sameRevision(filePathFinal, fileOpened)
      || !directoryDescriptorFinal.isDirectory() || !directoryPathFinal.isDirectory()
      || directoryPathFinal.isSymbolicLink()
      || !sameRevision(directoryDescriptorFinal, directoryOpened)
      || !sameRevision(directoryPathFinal, directoryOpened)
      || await realpath(parent) !== parent) refused()
    returned = true
    return Object.freeze({ bytes })
  } catch (error) {
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  } finally {
    if (!returned) bytes?.fill(0)
    try { await fileHandle?.close() } catch { /* Refusal status is already fixed. */ }
    try { await directoryHandle?.close() } catch { /* Refusal status is already fixed. */ }
  }
}

async function sha256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value))
  try { return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('') } finally {
    digest.fill(0)
  }
}

async function main() {
  if (process.argv.length !== 2) refused()
  const config = JSON.parse(await readFile(join(projectRoot, 'wrangler.json'), 'utf8'))
  validateStagingBackupConfig({ config, environment: process.env })
  const origin = config.env?.staging?.vars?.APP_ORIGIN
  if (origin !== 'https://staging.bearwithme-panel.app') refused()
  let workbook
  let session
  let resolutionFile
  let context
  let storageState
  let resolutions
  let loadedResolutions
  try {
    workbook = await readPrivateRolloutInput(
      environmentPath('BWM_WORKBOOK_PATH'), 5 * 1024 * 1024,
    )
    session = await readPrivateRolloutInput(
      environmentPath('BWM_STAGING_OWNER_SESSION_FILE'), 1024 * 1024,
    )
    resolutionFile = await readPrivateRolloutInput(
      environmentPath('BWM_WORKBOOK_RESOLUTIONS_FILE'), 256 * 1024,
    )
    if (await sha256(workbook.bytes) !== AUTHORITATIVE_WORKBOOK_FINGERPRINT) refused()
    try { resolutions = JSON.parse(resolutionFile.bytes.toString('utf8')) } catch { refused() }
    try { storageState = JSON.parse(session.bytes.toString('utf8')) } catch { refused() }
    if (!storageState || typeof storageState !== 'object' || Array.isArray(storageState)
      || Reflect.ownKeys(storageState).length !== 2
      || !Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)
      || storageState.cookies.length > 100 || storageState.origins.length > 20) refused()
    const journal = await createWorkbookRolloutJournal(
      environmentPath('BWM_WORKBOOK_ROLLOUT_JOURNAL'),
    )
    const historicalResolutionPath = optionalEnvironmentPath(
      'BWM_HISTORICAL_PROJECTION_RESOLUTIONS_FILE',
    )
    loadedResolutions = historicalResolutionPath === null
      ? null : await readHistoricalProjectionResolutions(historicalResolutionPath)
    context = await request.newContext({
      baseURL: origin,
      storageState,
      extraHTTPHeaders: { Accept: 'application/json' },
      maxRedirects: 0,
    })
    const sessionPath = '/api/v1/session'
    const sessionUrl = new URL(sessionPath, `${origin}/`).href
    const fetchSession = async () => readStagingSession(
      await context.get(sessionPath, { maxRedirects: 0 }), 'owner', sessionUrl,
    )
    const sessionData = await fetchSession()
    resolutions = assertApprovedRolloutActorAndResolutions({
      actor: sessionData.actor, resolutions,
    })
    const api = createStagingWorkbookApi({
      requestContext: context,
      origin,
      csrfToken: sessionData.csrfToken,
      csrfExpiresAt: sessionData.csrfExpiresAt,
      refreshCsrf: fetchSession,
      expectedActorId: sessionData.actor.id,
      expectedAuthorityRevision: sessionData.authorityRevision,
    })
    const result = await journal.runExclusive(() => runResumableStagingWorkbookRollout({
        journal,
        api,
        workbook: Object.freeze({ buffer: workbook.bytes }),
        approvedFingerprint: AUTHORITATIVE_WORKBOOK_FINGERPRINT,
        creatorId: sessionData.actor.id,
        resolutions,
        loadedResolutions,
        expectedReconciliation: EXPECTED_RECONCILIATION,
      }))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    workbook?.bytes.fill(0)
    session?.bytes.fill(0)
    resolutionFile?.bytes.fill(0)
    if (Array.isArray(resolutions)) resolutions.splice(0)
    storageState?.cookies?.splice(0)
    storageState?.origins?.splice(0)
    await context?.dispose()
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    const status = error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED'
      || error?.message === 'BACKUP_STAGING_REFUSED' ? 'refused' : 'failed'
    process.stderr.write(`${JSON.stringify({ status })}\n`)
    process.exitCode = 1
  }
}
