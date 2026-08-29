import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { request } from '@playwright/test'

import { createStagingWorkbookApi, readStagingSession } from './workbook-rollout-staging-http.mjs'
import {
  compilePrivateHistoricalProjectionReboundResolutions,
  compilePrivateHistoricalProjectionResolutions,
  persistHistoricalProjectionReviewGroups,
  persistHistoricalProjectionRebindGroups,
} from './workbook-historical-review-workflow.mjs'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_ACCESS_STORAGE_STATE_BYTES = 1024 * 1024
const refused = () => { throw new Error('WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED') }
const REVISION_KEYS = Object.freeze([
  'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs',
])

const sameRevision = (left, right) => REVISION_KEYS.every((key) => left[key] === right[key])

function environment(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length < 1 || value !== value.trim()
    || value.includes('\0')) refused()
  return value
}

export function validatePrivateAccessStorageStateFlags(fsConstants = constants) {
  if (!fsConstants || !Number.isInteger(fsConstants.O_RDONLY)
    || fsConstants.O_RDONLY < 0
    || !Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW <= 0
    || !Number.isInteger(fsConstants.O_DIRECTORY) || fsConstants.O_DIRECTORY <= 0) refused()
  return Object.freeze({
    directory: fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    file: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  })
}

export async function readPrivateAccessStorageState(path) {
  let directoryHandle
  let fileHandle
  let bytes
  try {
    const flags = validatePrivateAccessStorageStateFlags()
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
      || path.includes('\0') || basename(path).length < 1 || basename(path).length > 160) refused()
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
      || fileBefore.size < 1n || fileBefore.size > BigInt(MAX_ACCESS_STORAGE_STATE_BYTES)) refused()
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
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error?.message === 'WORKBOOK_HISTORICAL_REVIEW_CLI_REFUSED') throw error
    refused()
  } finally {
    bytes?.fill(0)
    try { await fileHandle?.close() } catch { /* Refusal status is already fixed. */ }
    try { await directoryHandle?.close() } catch { /* Refusal status is already fixed. */ }
  }
}

async function proposalMode(rebind = false) {
  const config = JSON.parse(await readFile(join(projectRoot, 'wrangler.json'), 'utf8'))
  const staging = config.env?.staging?.vars
  const origin = staging?.APP_ORIGIN
  if (origin !== 'https://staging.bearwithme-panel.app'
    || staging?.APP_ENV !== 'staging' || staging?.DATA_MODE !== 'fictional') refused()
  const importId = environment('BWM_WORKBOOK_IMPORT_ID')
  if (!/^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(importId)) refused()
  const storageState = await readPrivateAccessStorageState(
    environment('BWM_STAGING_OWNER_SESSION_FILE'),
  )
  if (!storageState || typeof storageState !== 'object' || Array.isArray(storageState)
    || Reflect.ownKeys(storageState).length !== 2
    || !Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)
    || storageState.cookies.length > 100 || storageState.origins.length > 20) refused()
  let context
  try {
    context = await request.newContext({
      baseURL: origin, storageState, extraHTTPHeaders: { Accept: 'application/json' },
      maxRedirects: 0,
    })
    const sessionPath = '/api/v1/session'
    const sessionUrl = new URL(sessionPath, `${origin}/`).href
    const fetchSession = async () => readStagingSession(
      await context.get(sessionPath, { maxRedirects: 0 }), 'owner', sessionUrl,
    )
    const session = await fetchSession()
    const api = createStagingWorkbookApi({
      requestContext: context, origin, csrfToken: session.csrfToken,
      csrfExpiresAt: session.csrfExpiresAt, refreshCsrf: fetchSession,
      expectedActorId: session.actor.id,
      expectedAuthorityRevision: session.authorityRevision,
    })
    const path = environment('BWM_HISTORICAL_REVIEW_PROPOSAL_FILE')
    return await (rebind ? persistHistoricalProjectionRebindGroups({
      api, importId,
      previousResolutionsPath: environment(
        'BWM_HISTORICAL_PROJECTION_PREVIOUS_RESOLUTIONS_FILE',
      ),
      path,
    }) : persistHistoricalProjectionReviewGroups({ api, importId, path }))
  } finally {
    storageState.cookies.splice(0)
    storageState.origins.splice(0)
    await context?.dispose()
  }
}

async function main() {
  if (process.argv.length !== 2) refused()
  const mode = environment('BWM_HISTORICAL_REVIEW_MODE')
  if (mode === 'proposal') return proposalMode(false)
  if (mode === 'rebind-proposal') return proposalMode(true)
  if (mode === 'compile') return compilePrivateHistoricalProjectionResolutions({
    proposalPath: environment('BWM_HISTORICAL_REVIEW_PROPOSAL_FILE'),
    approvalsPath: environment('BWM_HISTORICAL_REVIEW_APPROVALS_FILE'),
    resolutionsPath: environment('BWM_HISTORICAL_PROJECTION_RESOLUTIONS_FILE'),
  })
  if (mode === 'rebind-compile') {
    return compilePrivateHistoricalProjectionReboundResolutions({
      proposalPath: environment('BWM_HISTORICAL_REVIEW_PROPOSAL_FILE'),
      previousResolutionsPath: environment(
        'BWM_HISTORICAL_PROJECTION_PREVIOUS_RESOLUTIONS_FILE',
      ),
      approvalsPath: environment('BWM_HISTORICAL_REVIEW_APPROVALS_FILE'),
      resolutionsPath: environment('BWM_HISTORICAL_PROJECTION_RESOLUTIONS_FILE'),
    })
  }
  refused()
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const result = await main()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    process.stderr.write('{"status":"refused"}\n')
    process.exitCode = 1
  }
}
