import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { request } from '@playwright/test'

import { validateStagingBackupConfig } from './backup-staging-lib.mjs'
import { AUTHORITATIVE_WORKBOOK_FINGERPRINT } from './audit-workbook-lib.mjs'
import {
  createStagingWorkbookApi,
  readStagingSession,
} from './workbook-rollout-staging-http.mjs'
import { createWorkbookRolloutJournal } from './workbook-rollout-journal.mjs'
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

function environmentPath(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length < 1 || value !== value.trim()
    || value.includes('\0')) refused()
  return value
}

async function privateFile(path, maximumBytes) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stats = await handle.stat()
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600
      || stats.size < 1 || stats.size > maximumBytes) refused()
    const bytes = await handle.readFile()
    if (bytes.length !== stats.size) refused()
    return Object.freeze({ bytes })
  } catch (error) {
    if (error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED') throw error
    refused()
  } finally {
    await handle?.close()
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
  try {
    workbook = await privateFile(environmentPath('BWM_WORKBOOK_PATH'), 5 * 1024 * 1024)
    session = await privateFile(
      environmentPath('BWM_STAGING_OWNER_SESSION_FILE'), 1024 * 1024,
    )
    resolutionFile = await privateFile(
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
        resolutions,
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

try {
  await main()
} catch (error) {
  const status = error?.message === 'WORKBOOK_ROLLOUT_STAGING_REFUSED'
    || error?.message === 'BACKUP_STAGING_REFUSED' ? 'refused' : 'failed'
  process.stderr.write(`${JSON.stringify({ status })}\n`)
  process.exitCode = 1
}
