import { isDeepStrictEqual } from 'node:util'

import { validateBackupRecoveryFacts } from '../worker/operations/backup-recovery.js'
import {
  WORKBOOK_MATERIALIZER_VERSION,
  WORKBOOK_PARSER_VERSION,
} from '../src/workbook-import.js'
import {
  replayWorkbookProjectionTerminalOperations,
  runWorkbookProjectionRollout,
} from './workbook-projection-rollout.mjs'

const EVIDENCE_KEYS = Object.freeze([
  'artifactCount',
  'workbookObjectCount',
  'templateCount',
  'importCount',
  'planCount',
  'sourceRecordCount',
  'quarantineCount',
  'resolutionCount',
  'resolutionSetCount',
  'jobCount',
  'candidateCount',
  'decisionCount',
  'financeEntryCount',
  'financeLinkCount',
  'historicalOccurrenceCount',
  'activityChargeCount',
  'projectionLinkCount',
  'workbookVoidCount',
  'manualVoidCount',
  'createdRecordCount',
  'voidedRecordCount',
  'auditEventCount',
  'outboxMessageCount',
])
const ARTIFACT_BOOLEAN_KEYS = Object.freeze([
  'centreMatch',
  'ciphertextMetadataValid',
  'digestMatch',
  'environmentMatch',
  'keyVersionsMatch',
  'opaqueObjectKey',
  'readbackDigestMatch',
  'sizeMatch',
])
const RECONCILIATION_INTEGER_KEYS = Object.freeze([
  'activeAcceptedSourceRecords',
  'amountStoredAsTextWarnings',
  'correctedCombinedSheetMonths',
  'englishRecords',
  'fixedOrphanAmountQuarantines',
  'formulaGhostsExcluded',
  'monthlyDateQuarantines',
  'quarantinedSourceRecords',
  'tusRecords',
  'unexplainedDroppedCandidates',
])
const RECONCILIATION_BOOLEAN_KEYS = Object.freeze([
  'ledgerLinksUnique',
  'parentTotalsReconcile',
  'projectionLinksUnique',
])
const STATE_KEYS = Object.freeze([
  'artifactId', 'converged', 'createdRecords', 'importId', 'jobId', 'jobVersion',
  'status', 'version', 'voidedRecords',
])
const IMPORT_STATUSES = new Set(['ready', 'materializing', 'complete', 'failed'])
const STAGING_ROLLOUT_SPECIALIST_ID = 'sp_staging_workbook_julia_wolanin'
const RESULT_KEYS = Object.freeze([
  'artifactId', 'importId', 'acceptedCount', 'quarantinedCount',
  'previewWritesZero', 'terminalComplete', 'artifactVerified',
  'reconciliationMatched', 'replayIdentityMatch', 'replayWritesZero', 'status',
])
const failed = () => { throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const keysAre = (value, keys) => plain(value)
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const count = (value) => Number.isSafeInteger(value) && value >= 0
const identifier = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,120}$`).test(value)
const fingerprint = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const secretText = (value) => typeof value === 'string' && value.length >= 1
  && value.length <= 4096 && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value)

function evidenceDto(value) {
  if (!keysAre(value, EVIDENCE_KEYS) || !EVIDENCE_KEYS.every((key) => count(value[key]))) failed()
  return Object.freeze(Object.fromEntries(EVIDENCE_KEYS.map((key) => [key, value[key]])))
}

function previewDto(value) {
  const keys = [
    'conflictIds', 'fingerprint', 'materializerVersion', 'parserVersion',
    'planDigest', 'previewToken', 'workbookKind',
  ]
  if (!keysAre(value, keys) || !fingerprint(value.fingerprint)
    || value.parserVersion !== WORKBOOK_PARSER_VERSION
    || value.materializerVersion !== WORKBOOK_MATERIALIZER_VERSION
    || typeof value.planDigest !== 'string'
    || !/^v1_[A-Za-z0-9_-]{43}$/.test(value.planDigest)
    || value.workbookKind !== 'legacy'
    || !secretText(value.previewToken) || !Array.isArray(value.conflictIds)
    || value.conflictIds.length > 100) failed()
  const conflictIds = value.conflictIds.map((id) => {
    if (!identifier(id, 'wmc')) failed()
    return id
  })
  if (new Set(conflictIds).size !== conflictIds.length) failed()
  return Object.freeze({
    conflictIds: Object.freeze(conflictIds),
    fingerprint: value.fingerprint,
    materializerVersion: value.materializerVersion,
    parserVersion: value.parserVersion,
    planDigest: value.planDigest,
    previewToken: value.previewToken,
    workbookKind: value.workbookKind,
  })
}

function resolutionDto(value) {
  if (!Array.isArray(value) || value.length > 100) failed()
  const resolutions = value.map((entry) => {
    const keys = ['conflictId', 'specialistId']
    if (!keysAre(entry, keys) || !identifier(entry.conflictId, 'wmc')
      || !identifier(entry.specialistId, 'sp')) failed()
    return Object.freeze({ conflictId: entry.conflictId, specialistId: entry.specialistId })
  })
  if (new Set(resolutions.map(({ conflictId }) => conflictId)).size !== resolutions.length) failed()
  return Object.freeze(resolutions)
}

function importStateDto(value) {
  if (!keysAre(value, STATE_KEYS) || !identifier(value.importId, 'wbi')
    || !identifier(value.artifactId, 'wba') || !IMPORT_STATUSES.has(value.status)
    || !Number.isSafeInteger(value.version) || value.version < 1
    || !count(value.createdRecords) || !count(value.voidedRecords)
    || !((value.jobId === null && value.jobVersion === null)
      || (identifier(value.jobId, 'wbj') && Number.isSafeInteger(value.jobVersion)
        && value.jobVersion >= 1))
    || typeof value.converged !== 'boolean') failed()
  return Object.freeze(Object.fromEntries(STATE_KEYS.map((key) => [key, value[key]])))
}

function artifactDto(value, importState) {
  const keys = ['artifactId', ...ARTIFACT_BOOLEAN_KEYS]
  if (!keysAre(value, keys) || value.artifactId !== importState.artifactId
    || !ARTIFACT_BOOLEAN_KEYS.every((key) => value[key] === true)) failed()
  return value
}

function reconciliationDto(value, expected = false) {
  const keys = [...RECONCILIATION_BOOLEAN_KEYS, ...RECONCILIATION_INTEGER_KEYS]
  if (!expected) {
    try { return validateBackupRecoveryFacts(value) } catch { failed() }
  }
  const informational = ['replayCreatedRecords', 'replayVoidedRecords']
  const hasInformational = informational.every((key) => Object.hasOwn(value ?? {}, key))
  const acceptedKeys = expected ? keys : [...keys, ...informational]
  if (!keysAre(value, acceptedKeys)
    || !RECONCILIATION_INTEGER_KEYS.every((key) => count(value[key]))
    || (!expected && (!hasInformational
      || informational.some((key) => value[key] !== 0)))
    || !RECONCILIATION_BOOLEAN_KEYS.every((key) => typeof value[key] === 'boolean')) failed()
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])))
}

function exactConflictCoverage(conflictIds, resolutions) {
  const expected = [...conflictIds].sort()
  const actual = resolutions.map(({ conflictId }) => conflictId).sort()
  if (!isDeepStrictEqual(expected, actual)) failed()
}

export function assertApprovedRolloutActorAndResolutions({ actor, resolutions }) {
  try {
    if (!plain(actor) || !identifier(actor.id, 'stf') || actor.role !== 'owner'
      || actor.displayName !== 'Julia Wolanin'
      || actor.professionalTitle !== 'Specjalistka'
      || actor.specialistId !== STAGING_ROLLOUT_SPECIALIST_ID) failed()
    const reviewed = resolutionDto(resolutions)
    if (reviewed.length !== 0) failed()
    return resolutions
  } catch {
    throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED')
  }
}

async function finishImport({ api, initial, continueIdempotencyKey, maximumContinuations }) {
  let state = initial
  const importId = initial.importId
  const artifactId = initial.artifactId
  let continuations = 0
  const operations = []
  if (!identifier(state.jobId, 'wbj') || !Number.isSafeInteger(state.jobVersion)
    || state.jobVersion < 1) failed()
  while (state.status !== 'complete') {
    if (state.status === 'failed' || continuations >= maximumContinuations) failed()
    const ordinal = continuations + 1
    const idempotencyKey = continueIdempotencyKey(
      state.jobId, state.jobVersion, state.version, ordinal,
    )
    if (!secretText(idempotencyKey)) failed()
    const operation = Object.freeze({
      importId: state.importId,
      expectedVersion: state.version,
      idempotencyKey,
    })
    operations.push(operation)
    const previous = state
    state = importStateDto(await api.continue(operation))
    if (state.importId !== importId || state.artifactId !== artifactId
      || state.jobId !== previous.jobId
      || state.jobVersion !== previous.jobVersion + 1) failed()
    continuations += 1
  }
  if (!state.converged) failed()
  return Object.freeze({ state, operations: Object.freeze(operations) })
}

export async function verifyStagingWorkbookTerminal({
  api, result, expectedReconciliation, approvedFingerprint, committedFingerprint,
}) {
  try {
    if (!plain(api) || !['status', 'artifactVerification', 'reconciliation']
      .every((name) => typeof api[name] === 'function')
      || !fingerprint(approvedFingerprint) || committedFingerprint !== approvedFingerprint
      || !keysAre(result, RESULT_KEYS) || !identifier(result.importId, 'wbi')
      || !identifier(result.artifactId, 'wba')
      || !count(result.acceptedCount) || !count(result.quarantinedCount)
      || RESULT_KEYS.slice(4, -1).some((key) => result[key] !== true)
      || result.status !== 'ok') failed()
    const expected = reconciliationDto(expectedReconciliation, true)
    const observed = importStateDto(await api.status(result.importId))
    if (observed.status !== 'complete' || observed.converged !== true
      || observed.importId !== result.importId
      || observed.artifactId !== result.artifactId) failed()
    artifactDto(await api.artifactVerification(result.importId), observed)
    const facts = reconciliationDto(await api.reconciliation(result.importId))
    const reconciled = Object.freeze(Object.fromEntries(
      [...RECONCILIATION_BOOLEAN_KEYS, ...RECONCILIATION_INTEGER_KEYS]
        .map((key) => [key, facts.reconciliation[key]]),
    ))
    if (!isDeepStrictEqual(reconciled, expected)
      || facts.import.id !== result.importId || facts.artifact.id !== result.artifactId
      || reconciled.activeAcceptedSourceRecords !== result.acceptedCount
      || reconciled.quarantinedSourceRecords !== result.quarantinedCount) failed()
    return result
  } catch {
    throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED')
  }
}

export async function replayStagingWorkbookOperations({
  api, workbook, commitOperation, continuations, importIdentity,
}) {
  try {
    if (!plain(api) || !['commit', 'continue', 'operatorEvidence']
      .every((name) => typeof api[name] === 'function')
      || workbook === null || typeof workbook !== 'object'
      || !plain(commitOperation) || !plain(commitOperation.body)
      || !secretText(commitOperation.idempotencyKey)
      || !secretText(commitOperation.body.previewToken)
      || !Array.isArray(commitOperation.body.resolutions)
      || !Array.isArray(continuations) || continuations.length > 256
      || !plain(importIdentity) || !identifier(importIdentity.importId, 'wbi')
      || !identifier(importIdentity.artifactId, 'wba')) failed()
    const before = evidenceDto(await api.operatorEvidence())
    let replay = importStateDto(await api.commit({
      workbook,
      previewToken: commitOperation.body.previewToken,
      resolutions: commitOperation.body.resolutions,
      idempotencyKey: commitOperation.idempotencyKey,
    }))
    if (replay.importId !== importIdentity.importId
      || replay.artifactId !== importIdentity.artifactId) failed()
    for (const operation of continuations) {
      if (!plain(operation) || !plain(operation.body)
        || !secretText(operation.idempotencyKey)) failed()
      replay = importStateDto(await api.continue({
        importId: operation.body.importId,
        expectedVersion: operation.body.expectedVersion,
        idempotencyKey: operation.idempotencyKey,
      }))
      if (replay.importId !== importIdentity.importId
        || replay.artifactId !== importIdentity.artifactId) failed()
    }
    const after = evidenceDto(await api.operatorEvidence())
    if (!isDeepStrictEqual(before, after)
      || replay.status !== 'complete' || replay.converged !== true) failed()
  } catch {
    throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED')
  }
}

export async function runStagingWorkbookRollout({
  api,
  workbook,
  approvedFingerprint,
  resolutions,
  commitIdempotencyKey,
  continueIdempotencyKey,
  recordedContinuations = null,
  loadedResolutions,
  projectionCheckpoint = async () => {},
  expectedReconciliation,
  maximumContinuations = 256,
}) {
  try {
    const methods = [
      'artifactVerification', 'commit', 'continue', 'operatorEvidence', 'preview',
      'reconciliation', 'status', 'historicalReviewCatalog', 'historicalProjection',
      'continueHistoricalProjection', 'resolveHistoricalProjection',
      'activityProjection', 'continueActivityProjection',
    ]
    if (!plain(api) || !methods.every((name) => typeof api[name] === 'function')
      || workbook === null || typeof workbook !== 'object'
      || !fingerprint(approvedFingerprint) || !secretText(commitIdempotencyKey)
      || typeof continueIdempotencyKey !== 'function'
      || typeof projectionCheckpoint !== 'function'
      || !(recordedContinuations === null || typeof recordedContinuations === 'function')
      || !Number.isSafeInteger(maximumContinuations) || maximumContinuations < 1
      || maximumContinuations > 256) failed()

    const reviewedResolutions = resolutionDto(resolutions)
    const expected = reconciliationDto(expectedReconciliation, true)
    const beforePreview = evidenceDto(await api.operatorEvidence())
    const preview = previewDto(await api.preview(workbook))
    if (preview.fingerprint !== approvedFingerprint) failed()
    exactConflictCoverage(preview.conflictIds, reviewedResolutions)
    const afterPreview = evidenceDto(await api.operatorEvidence())
    if (!isDeepStrictEqual(beforePreview, afterPreview)) failed()

    const commitInput = Object.freeze({
      workbook,
      previewToken: preview.previewToken,
      resolutions: reviewedResolutions,
      idempotencyKey: commitIdempotencyKey,
    })
    const committed = importStateDto(await api.commit(commitInput))
    const observed = importStateDto(await api.status(committed.importId))
    if (observed.importId !== committed.importId || observed.artifactId !== committed.artifactId) failed()
    const completed = await finishImport({
      api, initial: observed, continueIdempotencyKey, maximumContinuations,
    })
    artifactDto(await api.artifactVerification(completed.state.importId), completed.state)
    if (loadedResolutions === null) return Object.freeze({
      status: 'historical_review_required',
      artifactId: completed.state.artifactId,
      importId: completed.state.importId,
    })
    if (loadedResolutions === undefined) failed()
    const projectionResult = await runWorkbookProjectionRollout({
      api, importId: completed.state.importId, loadedResolutions,
      checkpoint: projectionCheckpoint,
    })
    if (projectionResult.status !== 'ok') return Object.freeze({
      ...projectionResult,
      artifactId: completed.state.artifactId,
      importId: completed.state.importId,
    })
    const recoveryFacts = reconciliationDto(await api.reconciliation(completed.state.importId))
    const reconciled = Object.freeze(Object.fromEntries(
      [...RECONCILIATION_BOOLEAN_KEYS, ...RECONCILIATION_INTEGER_KEYS]
        .map((key) => [key, recoveryFacts.reconciliation[key]]),
    ))
    if (!isDeepStrictEqual(reconciled, expected)
      || recoveryFacts.import.id !== completed.state.importId
      || recoveryFacts.artifact.id !== completed.state.artifactId) failed()

    const beforeReplay = evidenceDto(await api.operatorEvidence())
    const replayCommitted = importStateDto(await api.commit(commitInput))
    if (replayCommitted.importId !== completed.state.importId
      || replayCommitted.artifactId !== completed.state.artifactId) failed()
    let replayState = replayCommitted
    const replayOperations = recordedContinuations === null
      ? completed.operations : recordedContinuations()
    if (!Array.isArray(replayOperations) || replayOperations.length < 1
      || replayOperations.length > 256) failed()
    const terminalOperation = replayOperations.at(-1)
    if (!keysAre(terminalOperation, ['importId', 'expectedVersion', 'idempotencyKey'])
      || !identifier(terminalOperation.importId, 'wbi')
      || !Number.isSafeInteger(terminalOperation.expectedVersion)
      || terminalOperation.expectedVersion < 1
      || !secretText(terminalOperation.idempotencyKey)) failed()
    replayState = importStateDto(await api.continue(terminalOperation))
    if (replayState.importId !== completed.state.importId
      || replayState.artifactId !== completed.state.artifactId) failed()
    await replayWorkbookProjectionTerminalOperations({
      api, importId: completed.state.importId, loadedResolutions,
      result: projectionResult,
    })
    if (replayState.status !== 'complete' || !replayState.converged
      || replayState.importId !== completed.state.importId
      || replayState.artifactId !== completed.state.artifactId) failed()
    const afterReplay = evidenceDto(await api.operatorEvidence())
    const replayCreatedRecords = afterReplay.createdRecordCount - beforeReplay.createdRecordCount
    const replayVoidedRecords = afterReplay.voidedRecordCount - beforeReplay.voidedRecordCount
    if (replayCreatedRecords !== 0 || replayVoidedRecords !== 0
      || !isDeepStrictEqual(beforeReplay, afterReplay)) failed()
    const replayFacts = reconciliationDto(
      await api.reconciliation(completed.state.importId),
    )
    const replayReconciliation = Object.freeze(Object.fromEntries(
      [...RECONCILIATION_BOOLEAN_KEYS, ...RECONCILIATION_INTEGER_KEYS]
        .map((key) => [key, replayFacts.reconciliation[key]]),
    ))
    if (!isDeepStrictEqual(replayReconciliation, expected)) failed()

    return Object.freeze({
      artifactId: completed.state.artifactId,
      importId: completed.state.importId,
      acceptedCount: reconciled.activeAcceptedSourceRecords,
      quarantinedCount: reconciled.quarantinedSourceRecords,
      previewWritesZero: true,
      terminalComplete: true,
      artifactVerified: true,
      reconciliationMatched: true,
      replayIdentityMatch: true,
      replayWritesZero: true,
      status: 'ok',
    })
  } catch {
    throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED')
  }
}
