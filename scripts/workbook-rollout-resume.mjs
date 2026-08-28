import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  runStagingWorkbookRollout,
  verifyStagingWorkbookTerminal,
} from './workbook-rollout-staging-lib.mjs'
import {
  replayWorkbookProjectionTerminalOperations,
  runWorkbookProjectionRollout,
} from './workbook-projection-rollout.mjs'
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
const hexDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function resolutionFileBinding(loaded) {
  if (loaded === null) return null
  if (!exact(loaded, ['artifact', 'fileSha256']) || !plain(loaded.artifact)
    || !hexDigest(loaded.fileSha256) || loaded.artifact.decisionCount !== 1_992
    || !hexDigest(loaded.artifact.decisionDigest)) failed()
  return Object.freeze({
    fileSha256: loaded.fileSha256,
    decisionCount: loaded.artifact.decisionCount,
    decisionDigest: loaded.artifact.decisionDigest,
  })
}

function approvedResolutionBinding(loaded, approval) {
  const file = resolutionFileBinding(loaded)
  if (file === null || !exact(approval, [
    'approvalMode', 'groupCount', 'catalogDigest', 'groupDigest',
  ]) || !['initial', 'rebind'].includes(approval.approvalMode)
    || !Number.isSafeInteger(approval.groupCount) || approval.groupCount < 1
    || approval.groupCount > 1_992 || !hexDigest(approval.catalogDigest)
    || !hexDigest(approval.groupDigest)
    || (approval.approvalMode === 'initial' && approval.groupCount !== 67)) failed()
  return Object.freeze({ ...file, ...approval })
}

function importIdentity(value) {
  if (!exact(value, ['importId', 'artifactId'])
    || !identifier(value.importId, 'wbi') || !identifier(value.artifactId, 'wba')) failed()
  return Object.freeze({ importId: value.importId, artifactId: value.artifactId })
}

function importState(value, expectedIdentity = null) {
  const keys = [
    'artifactId', 'converged', 'createdRecords', 'importId', 'jobId', 'jobVersion',
    'status', 'version', 'voidedRecords',
  ]
  if (!exact(value, keys) || !identifier(value.importId, 'wbi')
    || !identifier(value.artifactId, 'wba')
    || !['ready', 'materializing', 'complete', 'failed'].includes(value.status)
    || !Number.isSafeInteger(value.version) || value.version < 1
    || !Number.isSafeInteger(value.createdRecords) || value.createdRecords < 0
    || !Number.isSafeInteger(value.voidedRecords) || value.voidedRecords < 0
    || !((value.jobId === null && value.jobVersion === null)
      || (identifier(value.jobId, 'wbj') && Number.isSafeInteger(value.jobVersion)
        && value.jobVersion >= 1))
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

const rolloutKey = (operation, facts) => `rollout-${operation}-${createHash('sha256')
  .update(JSON.stringify(['workbook-rollout.v2', operation, ...facts])).digest('hex')}`

function canonicalMappingResolutions(value) {
  if (!Array.isArray(value) || value.length > 100) failed()
  const result = value.map((entry) => {
    if (!exact(entry, ['conflictId', 'specialistId'])
      || !identifier(entry.conflictId, 'wmc') || !identifier(entry.specialistId, 'sp')) failed()
    return { conflictId: entry.conflictId, specialistId: entry.specialistId }
  }).sort((left, right) => left.conflictId < right.conflictId ? -1
    : left.conflictId > right.conflictId ? 1 : 0)
  if (new Set(result.map(({ conflictId }) => conflictId)).size !== result.length) failed()
  return Object.freeze(result)
}

const financeCommitKey = ({ fingerprint, creatorId, resolutions }) => rolloutKey(
  'commit', [fingerprint, creatorId, canonicalMappingResolutions(resolutions)],
)
const financeContinueKey = (importId, jobId, jobVersion) => rolloutKey(
  'continue', [importId, jobId, jobVersion],
)

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

async function continueWithRecovery({ api, input, identity, previous }) {
  if (previous.importId !== identity.importId || previous.artifactId !== identity.artifactId
    || !identifier(previous.jobId, 'wbj') || !Number.isSafeInteger(previous.jobVersion)
    || previous.jobVersion < 1) failed()
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const state = importState(await api.continue(input), identity)
      if (state.jobId !== previous.jobId
        || state.jobVersion !== previous.jobVersion + 1) failed()
      return Object.freeze({ confirmed: true, state })
    } catch (error) { lastError = error }
  }
  const observed = importState(await api.status(identity.importId), identity)
  if (observed.jobId !== previous.jobId
    || observed.jobVersion !== previous.jobVersion + 1) throw lastError
  return Object.freeze({ confirmed: true, state: observed })
}

async function proveDeterministicCommitBinding({
  api, workbook, approvedFingerprint, creatorId, resolutions, identity,
}) {
  const before = operatorEvidence(await api.operatorEvidence())
  const preview = freshPreviewDto(
    await api.preview(workbook), approvedFingerprint, resolutions,
  )
  const afterPreview = operatorEvidence(await api.operatorEvidence())
  if (!isDeepStrictEqual(before, afterPreview)) failed()
  const replay = importState(await api.commit({
    workbook,
    previewToken: preview.previewToken,
    resolutions: canonicalMappingResolutions(resolutions),
    idempotencyKey: financeCommitKey({
      fingerprint: approvedFingerprint, creatorId, resolutions,
    }),
  }), identity)
  const afterCommit = operatorEvidence(await api.operatorEvidence())
  if (!isDeepStrictEqual(before, afterCommit)) failed()
  return replay
}

function freshPreviewDto(value, approvedFingerprint, resolutions) {
  if (!plain(value) || value.fingerprint !== approvedFingerprint
    || value.workbookKind !== 'legacy' || typeof value.previewToken !== 'string'
    || value.previewToken.length < 1 || value.previewToken.length > 4_096
    || !Array.isArray(value.conflictIds) || value.conflictIds.length > 100
    || value.conflictIds.some((id) => !identifier(id, 'wmc'))
    || typeof value.planDigest !== 'string' || !/^v1_[A-Za-z0-9_-]{43}$/.test(value.planDigest)
    || !Number.isSafeInteger(value.parserVersion)
    || !Number.isSafeInteger(value.materializerVersion)) failed()
  const expected = canonicalMappingResolutions(resolutions).map(({ conflictId }) => conflictId)
  const actual = [...value.conflictIds].sort()
  if (!isDeepStrictEqual(actual, expected)) failed()
  return value
}

async function resumeConfirmedImport({
  api, state, workbook, resolutions, creatorId, expectedReconciliation,
  approvedFingerprint, loadedResolutions, projectionCheckpoint,
  approvalMode, approvalAlreadyValidated, onApprovalValidated,
  validatedApproval,
  deterministicCommitAlreadyProved = false,
}) {
  const identity = importIdentity(state.importIdentity)
  const discovered = await api.discoverImport({
    fingerprint: approvedFingerprint, creatorId,
  })
  if (discovered === null) failed()
  const bound = importState(discovered, identity)
  if (bound.importId !== identity.importId || bound.artifactId !== identity.artifactId
    || (loadedResolutions !== null
      && (loadedResolutions.artifact.importId !== bound.importId
        || loadedResolutions.artifact.artifactId !== bound.artifactId))) failed()
  if (!deterministicCommitAlreadyProved) {
    await proveDeterministicCommitBinding({
      api, workbook, approvedFingerprint, creatorId, resolutions, identity,
    })
  }
  let current = importState(await api.status(identity.importId), identity)
  if (!identifier(current.jobId, 'wbj') || !Number.isSafeInteger(current.jobVersion)
    || current.jobVersion < 1) failed()
  for (let ordinal = 1; current.status !== 'complete'; ordinal += 1) {
    if (current.status === 'failed' || ordinal > 256) failed()
    const input = Object.freeze({
      importId: identity.importId,
      expectedVersion: current.version,
      idempotencyKey: financeContinueKey(
        identity.importId, current.jobId, current.jobVersion,
      ),
    })
    const advanced = await continueWithRecovery({
      api, input, identity, previous: current,
    })
    current = advanced.state
  }
  if (!current.converged) failed()

  if (loadedResolutions === null) return Object.freeze({
    status: 'historical_review_required',
    artifactId: identity.artifactId,
    importId: identity.importId,
  })
  const projectionResult = await runWorkbookProjectionRollout({
    api, importId: identity.importId, loadedResolutions, checkpoint: projectionCheckpoint,
    approvalMode, approvalAlreadyValidated, validatedApproval, onApprovalValidated,
  })
  if (projectionResult.status !== 'ok') return Object.freeze({
    ...projectionResult,
    artifactId: identity.artifactId,
    importId: identity.importId,
  })

  const beforePreview = operatorEvidence(await api.operatorEvidence())
  const preview = freshPreviewDto(
    await api.preview(workbook), approvedFingerprint, resolutions,
  )
  const afterPreview = operatorEvidence(await api.operatorEvidence())
  if (!isDeepStrictEqual(beforePreview, afterPreview)) failed()
  const beforeRecovery = await api.reconciliation(identity.importId)
  const beforeReplay = operatorEvidence(await api.operatorEvidence())
  let replay = importState(await api.commit({
    workbook,
    previewToken: preview.previewToken,
    resolutions: canonicalMappingResolutions(resolutions),
    idempotencyKey: financeCommitKey({
      fingerprint: approvedFingerprint, creatorId, resolutions,
    }),
  }), identity)
  if (!identifier(current.jobId, 'wbj') || current.jobVersion < 2
    || current.version < 2) failed()
  replay = importState(await api.continue(Object.freeze({
    importId: identity.importId,
    expectedVersion: current.version - 1,
    idempotencyKey: financeContinueKey(
      identity.importId, current.jobId, current.jobVersion - 1,
    ),
  })), identity)
  if (!isDeepStrictEqual(replay, current)) failed()
  await replayWorkbookProjectionTerminalOperations({
    api, importId: identity.importId, loadedResolutions,
    result: projectionResult,
  })
  const afterReplay = operatorEvidence(await api.operatorEvidence())
  const afterRecovery = await api.reconciliation(identity.importId)
  if (!isDeepStrictEqual(beforeReplay, afterReplay)
    || !isDeepStrictEqual(beforeRecovery, afterRecovery)
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
  loadedResolutions,
  expectedReconciliation,
}) {
  try {
    if (!journal || typeof journal.load !== 'function' || typeof journal.save !== 'function'
      || !plain(api) || !Array.isArray(resolutions)
      || !(loadedResolutions === null || plain(loadedResolutions))
      || !/^[a-f0-9]{64}$/.test(approvedFingerprint ?? '')
      || !identifier(creatorId, 'stf')) failed()
    let state = await journal.load()
    if (state !== null) validateWorkbookRolloutJournal(state)
    if (state !== null && (state.fingerprint !== approvedFingerprint
      || state.creatorId !== creatorId)) failed()
    if (state === null) {
      state = {
        schema: 'workbook_rollout_journal.v3', environment: 'staging',
        fingerprint: approvedFingerprint, creatorId, phase: 'initialized',
        importIdentity: null, resolutionArtifact: null, resolutionHistory: [],
        rebind: null, projection: null, result: null,
      }
      await journal.save(state)
    }
    const persist = async (patch) => {
      state = { ...state, ...patch }
      await journal.save(state)
    }
    const suppliedResolutionFile = resolutionFileBinding(loadedResolutions)
    const currentResolutionFile = state.resolutionArtifact === null ? null : Object.freeze({
      fileSha256: state.resolutionArtifact.fileSha256,
      decisionCount: state.resolutionArtifact.decisionCount,
      decisionDigest: state.resolutionArtifact.decisionDigest,
    })
    const suppliedMatchesCurrent = currentResolutionFile !== null
      && isDeepStrictEqual(currentResolutionFile, suppliedResolutionFile)
    if (state.resolutionArtifact !== null && suppliedResolutionFile === null) failed()
    if (state.resolutionArtifact !== null && !suppliedMatchesCurrent && state.rebind === null) {
      failed()
    }
    if (state.importIdentity !== null && loadedResolutions !== null
      && (loadedResolutions.artifact.importId !== state.importIdentity.importId
        || loadedResolutions.artifact.artifactId !== state.importIdentity.artifactId)) failed()
    const projectionCheckpoint = async (projection) => {
      if (state.resolutionArtifact === null) failed()
      await persist({ projection })
    }
    const approvalAlreadyValidated = suppliedMatchesCurrent && state.rebind === null
    const approvalMode = approvalAlreadyValidated
      ? state.resolutionArtifact.approvalMode : state.rebind === null ? 'initial' : 'rebind'
    const validatedApproval = approvalAlreadyValidated ? Object.freeze({
      approvalMode: state.resolutionArtifact.approvalMode,
      groupCount: state.resolutionArtifact.groupCount,
      catalogDigest: state.resolutionArtifact.catalogDigest,
      groupDigest: state.resolutionArtifact.groupDigest,
    }) : null
    const onApprovalValidated = async (approval) => {
      const approved = approvedResolutionBinding(loadedResolutions, approval)
      if (state.resolutionArtifact === null) {
        await persist({ resolutionArtifact: approved })
        return
      }
      if (isDeepStrictEqual(state.resolutionArtifact, approved)) return
      if (state.rebind === null) failed()
      await persist({
        resolutionArtifact: approved,
        resolutionHistory: [...state.resolutionHistory, state.resolutionArtifact],
        rebind: null,
        projection: null,
      })
    }
    const recordPause = async (result) => {
      if (result.status !== 'historical_rebind_required'
        || state.resolutionArtifact === null) return
      if (result.job !== null) await persist({ projection: result.job })
      await persist({ rebind: Object.freeze({
        previousFileSha256: state.resolutionArtifact.fileSha256,
        previousDecisionDigest: state.resolutionArtifact.decisionDigest,
        jobId: result.job?.jobId ?? null,
        version: result.job?.version ?? 0,
      }) })
    }
    if (state.phase === 'complete') {
      return verifyStagingWorkbookTerminal({
        api, result: state.result, expectedReconciliation, approvedFingerprint,
        committedFingerprint: approvedFingerprint,
      })
    }
    let deterministicCommitAlreadyProved = false
    if (state.phase === 'initialized' && loadedResolutions !== null) {
      const existing = await api.discoverImport({
        fingerprint: approvedFingerprint, creatorId,
      })
      if (existing === null) failed()
      const discovered = importState(existing)
      if (discovered.importId !== loadedResolutions.artifact.importId
        || discovered.artifactId !== loadedResolutions.artifact.artifactId) failed()
      await proveDeterministicCommitBinding({
        api, workbook, approvedFingerprint, creatorId, resolutions,
        identity: importIdentity({
          importId: discovered.importId, artifactId: discovered.artifactId,
        }),
      })
      deterministicCommitAlreadyProved = true
      await persist({
        phase: 'import_confirmed',
        importIdentity: importIdentity({
          importId: discovered.importId, artifactId: discovered.artifactId,
        }),
      })
    }
    if (state.phase === 'import_confirmed') {
      const result = await resumeConfirmedImport({
        api, state, workbook, resolutions, creatorId, expectedReconciliation,
        approvedFingerprint, loadedResolutions, projectionCheckpoint,
        approvalMode, approvalAlreadyValidated, onApprovalValidated,
        validatedApproval,
        deterministicCommitAlreadyProved,
      })
      if (result.status !== 'ok') {
        await recordPause(result)
        return result
      }
      await persist({ phase: 'complete', result })
      return result
    }

    if (loadedResolutions !== null) failed()
    const commitIdempotencyKey = financeCommitKey({
      fingerprint: approvedFingerprint, creatorId, resolutions,
    })
    let confirmedCommitInput = null
    const confirmedContinuations = []
    const continuationInputs = new Map()
    let observedFinanceState = null
    const confirmImport = async (value) => {
      const identity = importIdentity({
        importId: value?.importId,
        artifactId: value?.artifactId,
      })
      if (loadedResolutions !== null
        && (loadedResolutions.artifact.importId !== identity.importId
          || loadedResolutions.artifact.artifactId !== identity.artifactId)) failed()
      await persist({
        phase: 'import_confirmed', importIdentity: identity,
      })
      return identity
    }
    const discover = async () => {
      const value = await api.discoverImport({
        fingerprint: approvedFingerprint, creatorId,
      })
      return value === null ? null : importState(value)
    }
    const wrappedApi = Object.freeze({
      operatorEvidence: (...args) => api.operatorEvidence(...args),
      preview: (...args) => api.preview(...args),
      async status(...args) {
        observedFinanceState = importState(await api.status(...args), state.importIdentity)
        return observedFinanceState
      },
      artifactVerification: (...args) => api.artifactVerification(...args),
      reconciliation: (...args) => api.reconciliation(...args),
      historicalReviewCatalog: (...args) => api.historicalReviewCatalog(...args),
      historicalProjection: (...args) => api.historicalProjection(...args),
      continueHistoricalProjection: (...args) => api.continueHistoricalProjection(...args),
      resolveHistoricalProjection: (...args) => api.resolveHistoricalProjection(...args),
      activityProjection: (...args) => api.activityProjection(...args),
      continueActivityProjection: (...args) => api.continueActivityProjection(...args),
      async commit(input) {
        if (confirmedCommitInput !== null) {
          if (!isDeepStrictEqual(input, confirmedCommitInput)) failed()
          return importState(await api.commit(input), state.importIdentity)
        }
        const existing = await discover()
        if (existing !== null) {
          const replayed = importState(await api.commit(input))
          if (replayed.importId !== existing.importId
            || replayed.artifactId !== existing.artifactId) failed()
          const identity = await confirmImport(existing)
          confirmedCommitInput = input
          return importState(replayed, identity)
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
          const replayed = importState(await api.commit(input))
          if (replayed.importId !== recovered.importId
            || replayed.artifactId !== recovered.artifactId) failed()
          const identity = await confirmImport(recovered)
          confirmedCommitInput = input
          return importState(replayed, identity)
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
          api, input, identity: state.importIdentity, previous: observedFinanceState,
        })
        if (advanced.confirmed) {
          continuationInputs.set(input.idempotencyKey, input)
          confirmedContinuations.push(input)
        }
        observedFinanceState = advanced.state
        return advanced.state
      },
    })
    const result = await runStagingWorkbookRollout({
      api: wrappedApi,
      workbook,
      approvedFingerprint,
      resolutions,
      commitIdempotencyKey,
      continueIdempotencyKey: (jobId, jobVersion) => {
        if (state.importIdentity === null) failed()
        return financeContinueKey(state.importIdentity.importId, jobId, jobVersion)
      },
      recordedContinuations: () => confirmedContinuations,
      loadedResolutions,
      projectionCheckpoint,
      expectedReconciliation,
      maximumContinuations: 256,
    })
    if (state.phase !== 'import_confirmed' || state.importIdentity?.importId !== result.importId
      || state.importIdentity?.artifactId !== result.artifactId) failed()
    if (result.status !== 'ok') {
      await recordPause(result)
      return result
    }
    await persist({ phase: 'complete', result })
    return result
  } catch {
    throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED')
  }
}
