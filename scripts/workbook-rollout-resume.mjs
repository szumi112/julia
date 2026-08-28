import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  runStagingWorkbookRollout,
  verifyStagingWorkbookTerminal,
} from './workbook-rollout-staging-lib.mjs'
import { validateWorkbookRolloutJournal } from './workbook-rollout-journal.mjs'

const EVIDENCE_KEYS = Object.freeze([
  'artifactCount', 'workbookObjectCount', 'templateCount', 'importCount', 'planCount',
  'sourceRecordCount', 'quarantineCount', 'resolutionCount', 'resolutionSetCount',
  'jobCount', 'candidateCount', 'decisionCount', 'financeEntryCount', 'financeLinkCount',
  'historicalOccurrenceCount', 'activityChargeCount', 'projectionLinkCount',
  'workbookVoidCount', 'manualVoidCount', 'createdRecordCount', 'voidedRecordCount',
  'auditEventCount', 'outboxMessageCount',
])
const failed = () => { throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const identifier = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,120}$`).test(value)

function importIdentity(value) {
  if (!exact(value, ['importId', 'artifactId'])
    || !identifier(value.importId, 'wbi') || !identifier(value.artifactId, 'wba')) failed()
  return Object.freeze({ importId: value.importId, artifactId: value.artifactId })
}

function importState(value, expectedIdentity = null) {
  const keys = [
    'artifactId', 'converged', 'createdRecords', 'importId', 'status', 'version',
    'voidedRecords',
  ]
  if (!exact(value, keys) || !identifier(value.importId, 'wbi')
    || !identifier(value.artifactId, 'wba')
    || !['ready', 'materializing', 'complete', 'failed'].includes(value.status)
    || !Number.isSafeInteger(value.version) || value.version < 1
    || !Number.isSafeInteger(value.createdRecords) || value.createdRecords < 0
    || !Number.isSafeInteger(value.voidedRecords) || value.voidedRecords < 0
    || typeof value.converged !== 'boolean'
    || (expectedIdentity !== null && (value.importId !== expectedIdentity.importId
      || value.artifactId !== expectedIdentity.artifactId))) failed()
  return value
}

function operatorEvidence(value) {
  if (!exact(value, EVIDENCE_KEYS)
    || EVIDENCE_KEYS.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) failed()
  return Object.freeze(Object.fromEntries(EVIDENCE_KEYS.map((key) => [key, value[key]])))
}

function inMemoryIdentity(identityFactory) {
  if (typeof identityFactory !== 'function') failed()
  const value = identityFactory()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    .test(value ?? '')) failed()
  return value
}

function resultFor(identity, expectedReconciliation) {
  if (!plain(expectedReconciliation)) failed()
  return Object.freeze({
    artifactId: identity.artifactId,
    importId: identity.importId,
    acceptedCount: expectedReconciliation.activeAcceptedSourceRecords,
    quarantinedCount: expectedReconciliation.quarantinedSourceRecords,
    previewWritesZero: true,
    terminalComplete: true,
    artifactVerified: true,
    reconciliationMatched: true,
    replayIdentityMatch: true,
    replayWritesZero: true,
    status: 'ok',
  })
}

async function continueWithRecovery({ api, input, identity }) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return Object.freeze({
        confirmed: true,
        state: importState(await api.continue(input), identity),
      })
    } catch (error) { lastError = error }
  }
  const observed = importState(await api.status(identity.importId), identity)
  if (observed.version <= input.expectedVersion) throw lastError
  return Object.freeze({ confirmed: true, state: observed })
}

async function resumeConfirmedImport({
  api, state, expectedReconciliation, approvedFingerprint, identityFactory,
}) {
  const identity = importIdentity(state.importIdentity)
  const runIdentity = inMemoryIdentity(identityFactory)
  let current = importState(await api.status(identity.importId), identity)
  const operations = []
  for (let ordinal = 1; current.status !== 'complete'; ordinal += 1) {
    if (current.status === 'failed' || ordinal > 256) failed()
    const input = Object.freeze({
      importId: identity.importId,
      expectedVersion: current.version,
      idempotencyKey: `rollout-continue-${runIdentity}-${ordinal}`,
    })
    const advanced = await continueWithRecovery({ api, input, identity })
    if (advanced.confirmed) operations.push(input)
    current = advanced.state
  }
  if (!current.converged) failed()

  const beforeReplay = operatorEvidence(await api.operatorEvidence())
  let replay = current
  for (const operation of operations) {
    replay = importState(await api.continue(operation), identity)
  }
  const afterReplay = operatorEvidence(await api.operatorEvidence())
  if (!isDeepStrictEqual(beforeReplay, afterReplay)
    || replay.status !== 'complete' || replay.converged !== true) failed()

  const result = resultFor(identity, expectedReconciliation)
  return verifyStagingWorkbookTerminal({
    api, result, expectedReconciliation, approvedFingerprint,
    committedFingerprint: approvedFingerprint,
  })
}

export async function runResumableStagingWorkbookRollout({
  journal,
  api,
  workbook,
  approvedFingerprint,
  creatorId,
  resolutions,
  expectedReconciliation,
  identityFactory = randomUUID,
}) {
  try {
    if (!journal || typeof journal.load !== 'function' || typeof journal.save !== 'function'
      || !plain(api) || !Array.isArray(resolutions)
      || !/^[a-f0-9]{64}$/.test(approvedFingerprint ?? '')
      || !identifier(creatorId, 'stf')) failed()
    let state = await journal.load()
    if (state !== null) validateWorkbookRolloutJournal(state)
    if (state !== null && (state.fingerprint !== approvedFingerprint
      || state.creatorId !== creatorId)) failed()
    if (state === null) {
      state = {
        schema: 'workbook_rollout_journal.v2', environment: 'staging',
        fingerprint: approvedFingerprint, creatorId, phase: 'initialized',
        importIdentity: null, result: null,
      }
      await journal.save(state)
    }
    const persist = async (patch) => {
      state = { ...state, ...patch }
      await journal.save(state)
    }
    if (state.phase === 'complete') {
      return verifyStagingWorkbookTerminal({
        api, result: state.result, expectedReconciliation, approvedFingerprint,
        committedFingerprint: approvedFingerprint,
      })
    }
    if (state.phase === 'import_confirmed') {
      const result = await resumeConfirmedImport({
        api, state, expectedReconciliation, approvedFingerprint, identityFactory,
      })
      await persist({ phase: 'complete', result })
      return result
    }

    const runIdentity = inMemoryIdentity(identityFactory)
    const commitIdempotencyKey = `rollout-commit-${runIdentity}`
    let confirmedCommitInput = null
    let discovered = false
    const confirmedContinuations = []
    const continuationInputs = new Map()
    const confirmImport = async (value) => {
      const identity = importIdentity(value)
      await persist({ phase: 'import_confirmed', importIdentity: identity })
      return identity
    }
    const discover = async () => {
      const value = await api.discoverImport({
        fingerprint: approvedFingerprint, creatorId,
      })
      return value === null ? null : importIdentity(value)
    }
    const wrappedApi = Object.freeze({
      operatorEvidence: (...args) => api.operatorEvidence(...args),
      preview: (...args) => api.preview(...args),
      status: (...args) => api.status(...args),
      artifactVerification: (...args) => api.artifactVerification(...args),
      reconciliation: (...args) => api.reconciliation(...args),
      async commit(input) {
        if (confirmedCommitInput !== null) {
          if (!isDeepStrictEqual(input, confirmedCommitInput)) failed()
          return importState(await api.commit(input), state.importIdentity)
        }
        if (discovered) return importState(
          await api.status(state.importIdentity.importId), state.importIdentity,
        )
        const existing = await discover()
        if (existing !== null) {
          await confirmImport(existing)
          discovered = true
          return importState(await api.status(existing.importId), existing)
        }
        let response
        let lastError
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            response = importState(await api.commit(input))
            lastError = null
            break
          } catch (error) { lastError = error }
        }
        if (lastError) {
          const recovered = await discover()
          if (recovered === null) throw lastError
          await confirmImport(recovered)
          confirmedCommitInput = input
          return importState(await api.status(recovered.importId), recovered)
        }
        const identity = await confirmImport({
          importId: response.importId, artifactId: response.artifactId,
        })
        confirmedCommitInput = input
        return importState(response, identity)
      },
      async continue(input) {
        const existing = continuationInputs.get(input.idempotencyKey)
        if (existing) {
          if (!isDeepStrictEqual(existing, input)) failed()
          return importState(await api.continue(input), state.importIdentity)
        }
        const advanced = await continueWithRecovery({
          api, input, identity: state.importIdentity,
        })
        if (advanced.confirmed) {
          continuationInputs.set(input.idempotencyKey, input)
          confirmedContinuations.push(input)
        }
        return advanced.state
      },
    })
    const result = await runStagingWorkbookRollout({
      api: wrappedApi,
      workbook,
      approvedFingerprint,
      resolutions,
      commitIdempotencyKey,
      continueIdempotencyKey: (_version, ordinal) => (
        `rollout-continue-${runIdentity}-${ordinal}`
      ),
      recordedContinuations: () => confirmedContinuations,
      expectedReconciliation,
      maximumContinuations: 256,
    })
    if (state.phase !== 'import_confirmed' || state.importIdentity?.importId !== result.importId
      || state.importIdentity?.artifactId !== result.artifactId) failed()
    await persist({ phase: 'complete', result })
    return result
  } catch {
    throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED')
  }
}
