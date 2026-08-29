import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createWorkbookRolloutJournal,
  validateWorkbookRolloutJournal,
} from '../../scripts/workbook-rollout-journal.mjs'
import { runResumableStagingWorkbookRollout } from '../../scripts/workbook-rollout-resume.mjs'
import { buildHistoricalProjectionReviewGroups } from '../../scripts/workbook-historical-review-groups.mjs'

const FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const CREATOR_ID = 'stf_rollout_owner'
const IMPORT_ID = 'wbi_safe_rollout'
const ARTIFACT_ID = 'wba_safe_rollout'
const PLAN_DIGEST = `v1_${'P'.repeat(43)}`
const PREVIEW_TOKEN = 'preview-token-must-remain-in-memory'
const CONFLICT_ID = 'wmc_conflict-must-remain-in-memory'
const SPECIALIST_ID = 'sp_resolution-must-remain-in-memory'
const RESOLUTIONS = Object.freeze([{ conflictId: CONFLICT_ID, specialistId: SPECIALIST_ID }])
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const reviewContext = (index) => Object.freeze({
  counterparty: 'Synthetic journal subject',
  serviceLabel: index < 86 ? 'Synthetic classification'
    : index < 151 ? `Synthetic service ${sha256(`group-${index}`)}` : 'Synthetic service',
  proposedClassification: index < 86 ? 'review' : 'person',
  proposedServiceId: null,
  nearSubjectIds: Object.freeze([]),
})
const projectionProfiles = Object.freeze(Array.from({ length: 5 }, (_, index) => (
  Object.freeze({
    sourceRecordId: `wbs_journal_profile_${String(index + 1).padStart(4, '0')}`,
    context: Object.freeze({
      counterparty: `Conflict free ${sha256(`profile-${index}`).slice(0, 24)}`,
      serviceLabel: 'Zajęcia psychologiczne', proposedClassification: 'person',
      proposedServiceId: 'zajecia', nearSubjectIds: Object.freeze([]),
    }),
  })
)))
const PROFILE_DIGEST = sha256(JSON.stringify(projectionProfiles))
const projectionDecisions = Object.freeze(Array.from({ length: 1_992 }, (_, index) => (
  Object.freeze({
    sourceRecordId: `wbs_journal_${String(index + 1).padStart(4, '0')}`,
    kind: index < 86 ? 'classification' : 'service',
    classification: 'person', existingSubjectId: null, serviceId: 'zajecia',
    reviewContextDigest: sha256(JSON.stringify({
      context: reviewContext(index), subjectSensitive: false,
      profileDigest: PROFILE_DIGEST,
    })),
  })
)))
const projectionArtifact = Object.freeze({
  schema: 'historical_projection_resolutions.v1', environment: 'staging',
  centreId: 'centre_1', fingerprint: FINGERPRINT, artifactId: ARTIFACT_ID,
  importId: IMPORT_ID, creatorId: CREATOR_ID, planDigest: PLAN_DIGEST,
  decisionCount: 1_992, decisionDigest: sha256(JSON.stringify(projectionDecisions)),
  decisions: projectionDecisions,
})
const loadedResolutions = Object.freeze({
  artifact: projectionArtifact, fileSha256: sha256(JSON.stringify(projectionArtifact)),
})
const initialProposal = buildHistoricalProjectionReviewGroups({
  binding: {
    environment: 'staging', centreId: 'centre_1', fingerprint: FINGERPRINT,
    artifactId: ARTIFACT_ID, importId: IMPORT_ID, creatorId: CREATOR_ID,
    planDigest: PLAN_DIGEST,
  },
  items: projectionDecisions.map((decision, index) => ({
    sourceRecordId: decision.sourceRecordId, kind: decision.kind,
    conflictId: null, resolution: null, context: reviewContext(index),
  })),
  profiles: projectionProfiles,
})
const resolutionArtifactBinding = Object.freeze({
  fileSha256: loadedResolutions.fileSha256, decisionCount: 1_992,
  decisionDigest: projectionArtifact.decisionDigest,
  approvalMode: 'initial', groupCount: initialProposal.groupCount,
  catalogDigest: initialProposal.catalogDigest, groupDigest: initialProposal.groupDigest,
})

const evidence = Object.freeze(Object.fromEntries([
  'artifactCount', 'workbookObjectCount', 'templateCount', 'importCount', 'planCount',
  'sourceRecordCount', 'quarantineCount', 'resolutionCount', 'resolutionSetCount',
  'jobCount', 'candidateCount', 'decisionCount', 'financeEntryCount', 'financeLinkCount',
  'historicalOccurrenceCount', 'activityChargeCount', 'projectionLinkCount',
  'workbookVoidCount', 'manualVoidCount', 'createdRecordCount', 'voidedRecordCount',
  'auditEventCount', 'outboxMessageCount',
].map((key) => [key, 0])))
const reconciliation = Object.freeze({
  activeAcceptedSourceRecords: 2232, quarantinedSourceRecords: 3,
  monthlyDateQuarantines: 2, fixedOrphanAmountQuarantines: 1,
  amountStoredAsTextWarnings: 2, correctedCombinedSheetMonths: 45,
  tusRecords: 25, englishRecords: 165, formulaGhostsExcluded: 5,
  unexplainedDroppedCandidates: 0, ledgerLinksUnique: true,
  projectionLinksUnique: true, parentTotalsReconcile: true,
})
const terminalState = Object.freeze({
  importId: IMPORT_ID, artifactId: ARTIFACT_ID, status: 'complete', version: 3,
  jobId: 'wbj_safe_rollout', jobVersion: 3,
  createdRecords: 2232, voidedRecords: 0, converged: true,
})
const terminalResult = Object.freeze({
  artifactId: ARTIFACT_ID, importId: IMPORT_ID,
  acceptedCount: 2232, quarantinedCount: 3,
  previewWritesZero: true, terminalComplete: true, artifactVerified: true,
  reconciliationMatched: true, replayIdentityMatch: true, replayWritesZero: true,
  status: 'ok',
})
const initialized = Object.freeze({
  schema: 'workbook_rollout_journal.v3', environment: 'staging',
  fingerprint: FINGERPRINT, creatorId: CREATOR_ID, phase: 'initialized',
  importIdentity: null, resolutionArtifact: null, resolutionHistory: [],
  rebind: null, projection: null, result: null,
})
const imported = Object.freeze({
  ...initialized, phase: 'import_confirmed',
  importIdentity: Object.freeze({ importId: IMPORT_ID, artifactId: ARTIFACT_ID }),
  resolutionArtifact: resolutionArtifactBinding,
})
const importedWithoutResolutions = Object.freeze({
  ...initialized, phase: 'import_confirmed',
  importIdentity: Object.freeze({ importId: IMPORT_ID, artifactId: ARTIFACT_ID }),
})
const terminalProjectionCheckpoint = Object.freeze({
  jobId: 'apj_safe_rollout', status: 'complete', totalRecords: 190,
  processedRecords: 190, projectedRecords: 190, version: 2,
  decisionFileSha256: loadedResolutions.fileSha256, decisionCount: 1_992,
  decisionDigest: projectionArtifact.decisionDigest,
})
const complete = Object.freeze({
  ...imported, phase: 'complete', projection: terminalProjectionCheckpoint,
  result: terminalResult,
})

function preview() {
  return {
    fingerprint: FINGERPRINT, parserVersion: 2, materializerVersion: 2,
    planDigest: PLAN_DIGEST, previewToken: PREVIEW_TOKEN,
    conflictIds: [CONFLICT_ID], workbookKind: 'legacy',
  }
}

function artifactVerification() {
  return {
    artifactId: ARTIFACT_ID, centreMatch: true, ciphertextMetadataValid: true,
    digestMatch: true, environmentMatch: true, keyVersionsMatch: true,
    opaqueObjectKey: true, readbackDigestMatch: true, sizeMatch: true,
  }
}

function reconciled() {
  return {
    kind: 'workbook_roundtrip_v1',
    artifact: {
      id: ARTIFACT_ID, fingerprint: FINGERPRINT, byteSize: 4_096,
      parserVersion: 2, materializerVersion: 2,
    },
    import: {
      id: IMPORT_ID, status: 'complete', version: 3,
      acceptedRecords: 2_232, quarantinedRecords: 3,
    },
    finance: {
      jobId: 'wbj_safe_rollout', status: 'complete', phase: 'complete', version: 3,
      cursor: 2_232, totalRecords: 2_232, processedRecords: 2_232,
      reportingRevision: 1,
    },
    historical: {
      jobId: 'hpj_safe_rollout', status: 'complete', version: 3,
      totalRecords: 2_000, processedRecords: 2_000, projectedRecords: 1_997,
      conflictCount: 1_992, resolutionCount: 1_992, occurrenceCount: 1_997,
      explicitExclusionCount: 0, automaticDeferredCount: 3, unresolvedCount: 0,
    },
    activity: {
      jobId: 'apj_safe_rollout', status: 'complete', version: 2,
      totalRecords: 190, processedRecords: 190, projectedRecords: 190,
      participantLinkCount: 190, chargeLinkCount: 190, groupLinkCount: 25,
      membershipObservationLinkCount: 25, physicalLinkCount: 430,
    },
    reconciliation: {
      ...reconciliation, replayCreatedRecords: 0, replayVoidedRecords: 0,
      crossProjectionOverlapCount: 0,
    },
  }
}

function projectionApi() {
  const binding = {
    environment: 'staging', centreId: 'centre_1', fingerprint: FINGERPRINT,
    artifactId: ARTIFACT_ID, importId: IMPORT_ID, creatorId: CREATOR_ID,
    planDigest: PLAN_DIGEST,
  }
  return {
    async historicalReviewCatalog({ afterSourceRecordId, consumeReviewPage }) {
      const offset = afterSourceRecordId === null ? 0
        : projectionDecisions.findIndex(({ sourceRecordId }) => (
          sourceRecordId === afterSourceRecordId
        )) + 1
      const decisions = projectionDecisions.slice(offset, offset + 100)
      const privatePage = {
        binding, afterSourceRecordId,
        nextAfterSourceRecordId: offset + decisions.length < projectionDecisions.length
          ? decisions.at(-1).sourceRecordId : null,
        directoryCount: 0, directoryDigest: 'd'.repeat(64),
        items: decisions.map((decision, index) => ({
          sourceRecordId: decision.sourceRecordId, kind: decision.kind,
          conflictId: `hcf_journal_${String(offset + index + 1).padStart(4, '0')}`,
          resolution: {
            classification: decision.classification,
            existingSubjectId: decision.existingSubjectId,
            serviceId: decision.serviceId,
          },
          reviewContextDigest: sha256(JSON.stringify(reviewContext(offset + index))),
          context: reviewContext(offset + index),
        })),
        profiles: afterSourceRecordId === null ? projectionProfiles.map((profile) => ({
          ...profile, reviewContextDigest: sha256(JSON.stringify(profile.context)),
        })) : [],
      }
      await consumeReviewPage(privatePage)
      return {
        ...privatePage,
        items: privatePage.items.map(({ context: _context, ...item }) => item),
        profiles: privatePage.profiles.map(({ context: _context, ...profile }) => profile),
      }
    },
    async historicalProjection(_importId, { consumeConflictReview }) {
      const value = {
        projection: {
          id: 'hpj_safe_rollout', importId: IMPORT_ID, status: 'complete',
          afterSourceRecordId: 'wbs_journal_terminal', totalRecords: 2_000,
          processedRecords: 2_000, projectedRecords: 1_997, conflictCount: 1_992,
          version: 3, updatedAt: '2026-08-28T10:00:00.000Z',
          completedAt: '2026-08-28T10:00:00.000Z',
        },
        conflicts: [],
      }
      await consumeConflictReview(value)
      return value
    },
    async continueHistoricalProjection(input) {
      assert.equal(input.importId, IMPORT_ID)
      assert.equal(input.expectedVersion, 2)
      return {
        id: 'hpj_safe_rollout', importId: IMPORT_ID, status: 'complete',
        afterSourceRecordId: 'wbs_journal_terminal', totalRecords: 2_000,
        processedRecords: 2_000, projectedRecords: 1_997, conflictCount: 1_992,
        version: 3, updatedAt: '2026-08-28T10:00:00.000Z',
        completedAt: '2026-08-28T10:00:00.000Z',
      }
    },
    async resolveHistoricalProjection() { throw new Error('terminal') },
    async activityProjection() {
      return {
        id: 'apj_safe_rollout', importId: IMPORT_ID, status: 'complete',
        afterSourceRecordId: 'wbs_journal_activity_terminal', totalRecords: 190,
        processedRecords: 190, projectedRecords: 190, version: 2,
        updatedAt: '2026-08-28T10:00:00.000Z',
        completedAt: '2026-08-28T10:00:00.000Z',
      }
    },
    async continueActivityProjection(input) {
      assert.equal(input.importId, IMPORT_ID)
      assert.equal(input.expectedVersion, 1)
      return {
        id: 'apj_safe_rollout', importId: IMPORT_ID, status: 'complete',
        afterSourceRecordId: 'wbs_journal_activity_terminal', totalRecords: 190,
        processedRecords: 190, projectedRecords: 190, version: 2,
        updatedAt: '2026-08-28T10:00:00.000Z',
        completedAt: '2026-08-28T10:00:00.000Z',
      }
    },
  }
}

async function privateRoot(prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  await chmod(root, 0o700)
  return root
}

async function observedJournal(path, forbidden) {
  const disk = await createWorkbookRolloutJournal(path)
  const snapshots = []
  const inspect = async () => {
    const bytes = await readFile(path)
    try {
      const text = bytes.toString('utf8')
      snapshots.push(JSON.parse(text))
      for (const value of forbidden) assert.equal(text.includes(value), false, value)
      assert.doesNotMatch(text,
        /previewToken|planDigest|resolutions|conflictId|specialistId|idempotencyKey|pendingOperation|commitOperation|continuations|rolloutIdentity|rolloutRequest|"body"/)
    } finally { bytes.fill(0) }
  }
  return {
    snapshots,
    journal: {
      load: () => disk.load(),
      async save(value) { await disk.save(value); await inspect() },
    },
    inspect,
  }
}

function runInput(journal, api, overrides = {}) {
  return {
    journal, api: { ...projectionApi(), ...api },
    workbook: { buffer: Buffer.from('fictional workbook') },
    approvedFingerprint: FINGERPRINT, creatorId: CREATOR_ID,
    resolutions: RESOLUTIONS, loadedResolutions,
    expectedReconciliation: reconciliation,
    identityFactory: () => '123e4567-e89b-42d3-a456-426614174000',
    ...overrides,
  }
}

test('durable phases and preview failure serialize only the safe recovery allow-list', async () => {
  const root = await privateRoot('bwm-safe-journal-preview-')
  const path = join(root, 'resume.json')
  try {
    const observed = await observedJournal(path, [
      PREVIEW_TOKEN, PLAN_DIGEST, CONFLICT_ID, SPECIALIST_ID,
    ])
    let evidenceReads = 0
    const api = {
      async operatorEvidence() {
        evidenceReads += 1
        if (evidenceReads === 2) throw new Error('stop after preview')
        return evidence
      },
      async preview() { return preview() },
      async discoverImport() { throw new Error('must not discover after failed proof') },
      async commit() { throw new Error('must not commit') },
      async status() { throw new Error('must not read status') },
      async continue() { throw new Error('must not continue') },
      async artifactVerification() { throw new Error('must not verify') },
      async reconciliation() { throw new Error('must not reconcile') },
    }

    await assert.rejects(
      runResumableStagingWorkbookRollout(runInput(observed.journal, api, {
        loadedResolutions: null,
      })),
      /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/,
    )
    await observed.inspect()
    assert.deepEqual(observed.snapshots.map(({ phase }) => phase), ['initialized', 'initialized'])
    assert.deepEqual(await observed.journal.load(), initialized)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('restart after an uncertain commit obtains a fresh no-write preview and discovers the creator-bound import', async () => {
  const root = await privateRoot('bwm-safe-journal-commit-')
  const path = join(root, 'resume.json')
  try {
    const observed = await observedJournal(path, [
      PREVIEW_TOKEN, PLAN_DIGEST, CONFLICT_ID, SPECIALIST_ID,
      'rollout-commit-123e4567-e89b-42d3-a456-426614174000',
    ])
    let invocation = 1
    let committed = false
    let previewCalls = 0
    let statusCalls = 0
    const commitInputs = []
    const api = {
      async operatorEvidence() { return evidence },
      async preview() { previewCalls += 1; return preview() },
      async discoverImport({ fingerprint, creatorId }) {
        assert.equal(fingerprint, FINGERPRINT)
        assert.equal(creatorId, CREATOR_ID)
        return invocation === 2 && committed
          ? terminalState
          : null
      },
      async commit(input) {
        commitInputs.push(structuredClone({
          previewToken: input.previewToken,
          resolutions: input.resolutions,
          idempotencyKey: input.idempotencyKey,
        }))
        committed = true
        if (invocation === 1) throw new Error('response lost after commit')
        return terminalState
      },
      async status() { statusCalls += 1; return terminalState },
      async continue() { return terminalState },
      async artifactVerification() { return artifactVerification() },
      async reconciliation() { return reconciled() },
    }

    await assert.rejects(
      runResumableStagingWorkbookRollout(runInput(observed.journal, api, {
        loadedResolutions: null,
      })),
      /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/,
    )
    assert.equal(commitInputs.length, 2)
    assert.deepEqual(commitInputs[0], commitInputs[1])
    assert.deepEqual(await observed.journal.load(), initialized)

    invocation = 2
    const result = await runResumableStagingWorkbookRollout(runInput(observed.journal, api))
    assert.deepEqual(result, terminalResult)
    assert.equal(previewCalls, 3)
    assert.equal(commitInputs.length, 4)
    assert.equal(statusCalls, 2)
    assert.deepEqual(await observed.journal.load(), complete)
    await observed.inspect()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('confirmed import uses deterministic continuation keys and reconciles an ambiguous outcome after restart', async () => {
  const root = await privateRoot('bwm-safe-journal-continue-')
  const path = join(root, 'resume.json')
  try {
    const observed = await observedJournal(path, [
      PREVIEW_TOKEN, PLAN_DIGEST, CONFLICT_ID, SPECIALIST_ID,
      'rollout-continue-123e4567-e89b-42d3-a456-426614174000-1',
    ])
    await observed.journal.save(initialized)
    await observed.journal.save(importedWithoutResolutions)
    await observed.journal.save(imported)
    let invocation = 1
    let materializationStage = 0
    const continuationInputs = []
    const api = {
      async operatorEvidence() { return evidence },
      async preview() { return preview() },
      async discoverImport() {
        return materializationStage === 2 ? terminalState : {
          ...terminalState, status: 'materializing',
          version: materializationStage === 0 ? 1 : 2,
          jobVersion: materializationStage + 1,
          createdRecords: 0, converged: false,
        }
      },
      async commit() {
        const current = materializationStage === 2 ? terminalState : {
          ...terminalState, status: 'materializing',
          version: materializationStage === 0 ? 1 : 2,
          jobVersion: materializationStage + 1,
          createdRecords: 0, converged: false,
        }
        return { ...current, jobId: null, jobVersion: null }
      },
      async status() {
        if (invocation === 1 && materializationStage === 1) {
          throw new Error('status response lost')
        }
        return materializationStage === 2 ? terminalState : {
          ...terminalState, status: 'materializing',
          version: materializationStage === 0 ? 1 : 2,
          jobVersion: materializationStage + 1,
          createdRecords: 0, converged: false,
        }
      },
      async continue(input) {
        continuationInputs.push(structuredClone(input))
        if (invocation === 1) {
          materializationStage = 1
          throw new Error('continuation response lost')
        }
        materializationStage = 2
        return terminalState
      },
      async artifactVerification() { return artifactVerification() },
      async reconciliation() { return reconciled() },
    }

    await assert.rejects(
      runResumableStagingWorkbookRollout(runInput(observed.journal, api)),
      /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/,
    )
    assert.equal(continuationInputs.length, 2)
    assert.deepEqual(continuationInputs[0], continuationInputs[1])
    assert.match(continuationInputs[0].idempotencyKey, /^rollout-continue-[a-f0-9]{64}$/)
    assert.deepEqual(await observed.journal.load(), imported)

    invocation = 2
    assert.deepEqual(
      await runResumableStagingWorkbookRollout(runInput(observed.journal, api)),
      terminalResult,
    )
    assert.equal(continuationInputs.length, 4)
    assert.deepEqual(continuationInputs[2], continuationInputs[3])
    assert.deepEqual(
      continuationInputs.map(({ expectedVersion }) => expectedVersion),
      [1, 1, 2, 2],
    )
    assert.deepEqual(await observed.journal.load(), complete)
    await observed.inspect()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('two phases issue deterministic finance and projection replays with zero delta', async () => {
  let statusState = null
  const commitInputs = []
  const continuationInputs = []
  const api = {
    async operatorEvidence() { return evidence },
    async preview() { return preview() },
    async discoverImport() { return statusState === null ? null : terminalState },
    async commit(input) {
      commitInputs.push(input)
      statusState ??= {
        ...terminalState, status: 'materializing', version: 2,
        jobVersion: 2, createdRecords: 0, converged: false,
      }
      return { ...statusState, jobId: null, jobVersion: null }
    },
    async status() { return statusState },
    async continue(input) {
      continuationInputs.push(input)
      statusState = terminalState
      return terminalState
    },
    async artifactVerification() { return artifactVerification() },
    async reconciliation() { return reconciled() },
  }
  let saved = null
  const journal = {
    async load() { return saved === null ? null : structuredClone(saved) },
    async save(value) { saved = structuredClone(value) },
  }

  assert.deepEqual(await runResumableStagingWorkbookRollout(runInput(journal, api, {
    loadedResolutions: null,
  })), {
    status: 'historical_review_required', artifactId: ARTIFACT_ID, importId: IMPORT_ID,
  })
  assert.deepEqual(await runResumableStagingWorkbookRollout(runInput(journal, api)), terminalResult)
  assert.equal(commitInputs.length, 3)
  assert.equal(new Set(commitInputs.map(({ idempotencyKey }) => idempotencyKey)).size, 1)
  assert.match(commitInputs[0].idempotencyKey, /^rollout-commit-[a-f0-9]{64}$/)
  assert.equal(continuationInputs.length, 2)
  assert.deepEqual(continuationInputs[0], continuationInputs[1])
  assert.deepEqual(continuationInputs.map(({ expectedVersion }) => expectedVersion), [2, 2])
  assert.deepEqual(saved, complete)

  const terminalCalls = []
  const terminalApi = {
    async operatorEvidence() { throw new Error('terminal revalidation does not replay') },
    async preview() { throw new Error('terminal revalidation does not preview') },
    async discoverImport() { throw new Error('terminal revalidation does not discover') },
    async commit() { throw new Error('terminal revalidation has no commit key') },
    async continue() { throw new Error('terminal revalidation has no continuation key') },
    async status(importId) { terminalCalls.push(['status', importId]); return terminalState },
    async artifactVerification(importId) {
      terminalCalls.push(['artifactVerification', importId])
      return artifactVerification()
    },
    async reconciliation(importId) {
      terminalCalls.push(['reconciliation', importId])
      return reconciled()
    },
  }
  assert.deepEqual(
    await runResumableStagingWorkbookRollout(runInput(journal, terminalApi)),
    terminalResult,
  )
  assert.deepEqual(terminalCalls, [
    ['status', IMPORT_ID], ['artifactVerification', IMPORT_ID], ['reconciliation', IMPORT_ID],
  ])
})

test('same-process commit discovery exact-replays the uncertain deterministic operation', async () => {
  let committed = false
  let statusCalls = 0
  const commitInputs = []
  const api = {
    async operatorEvidence() { return evidence },
    async preview() { return preview() },
    async discoverImport() {
      return committed ? terminalState : null
    },
    async commit(input) {
      commitInputs.push(input)
      committed = true
      if (commitInputs.length <= 2) throw new Error('commit response lost')
      return terminalState
    },
    async status() { statusCalls += 1; return terminalState },
    async continue() { throw new Error('terminal import must not continue') },
    async artifactVerification() { return artifactVerification() },
    async reconciliation() { return reconciled() },
  }
  let saved = null
  const journal = {
    async load() { return saved === null ? null : structuredClone(saved) },
    async save(value) { saved = structuredClone(value) },
  }

  assert.deepEqual(await runResumableStagingWorkbookRollout(runInput(journal, api, {
    loadedResolutions: null,
  })), {
    status: 'historical_review_required', artifactId: ARTIFACT_ID, importId: IMPORT_ID,
  })
  assert.equal(commitInputs.length, 3)
  assert.equal(statusCalls, 1)
  assert.deepEqual(commitInputs[0], commitInputs[1])
  assert.deepEqual(commitInputs[1], commitInputs[2])
  assert.deepEqual(saved, importedWithoutResolutions)
})

test('same-process continuation status reconciliation exact-replays its ephemeral key', async () => {
  const materializing = {
    ...terminalState, status: 'materializing', version: 1,
    jobVersion: 1, createdRecords: 0, converged: false,
  }
  const oneSliceTerminal = { ...terminalState, version: 2, jobVersion: 2 }
  let materialized = false
  const commitInputs = []
  const continuationInputs = []
  const api = {
    async operatorEvidence() { return evidence },
    async preview() { return preview() },
    async discoverImport() { return null },
    async commit(input) {
      commitInputs.push(input)
      return { ...materializing, jobId: null, jobVersion: null }
    },
    async status() { return materialized ? oneSliceTerminal : materializing },
    async continue(input) {
      continuationInputs.push(input)
      materialized = true
      if (continuationInputs.length === 1) throw new Error('continuation response lost')
      return oneSliceTerminal
    },
    async artifactVerification() { return artifactVerification() },
    async reconciliation() { return reconciled() },
  }
  let saved = null
  const journal = {
    async load() { return saved === null ? null : structuredClone(saved) },
    async save(value) { saved = structuredClone(value) },
  }

  assert.deepEqual(await runResumableStagingWorkbookRollout(runInput(journal, api, {
    loadedResolutions: null,
  })), {
    status: 'historical_review_required', artifactId: ARTIFACT_ID, importId: IMPORT_ID,
  })
  assert.equal(commitInputs.length, 1)
  assert.equal(continuationInputs.length, 2)
  assert.deepEqual(continuationInputs[0], continuationInputs[1])
  assert.deepEqual(saved, importedWithoutResolutions)
})

test('loading a legacy secret-bearing journal atomically replaces it with a safe retirement marker', async () => {
  const root = await privateRoot('bwm-safe-journal-retire-')
  const path = join(root, 'resume.json')
  const secrets = [PREVIEW_TOKEN, PLAN_DIGEST, CONFLICT_ID, SPECIALIST_ID, 'legacy-key-secret']
  try {
    await writeFile(path, JSON.stringify({
      schema: 'workbook_rollout_journal.v1', environment: 'staging',
      fingerprint: FINGERPRINT, previewToken: PREVIEW_TOKEN, planDigest: PLAN_DIGEST,
      resolutions: RESOLUTIONS, idempotencyKey: 'legacy-key-secret',
    }), { mode: 0o600 })
    const journal = await createWorkbookRolloutJournal(path)
    assert.equal(await journal.load(), null)
    const text = await readFile(path, 'utf8')
    assert.deepEqual(JSON.parse(text), {
      schema: 'workbook_rollout_journal.retired.v1',
      environment: 'staging', phase: 'retired',
    })
    for (const value of secrets) assert.equal(text.includes(value), false)
    assert.equal(await journal.load(), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('safe journal schema rejects every operational field even when values look valid', () => {
  assert.deepEqual(validateWorkbookRolloutJournal(structuredClone(initialized)), initialized)
  for (const field of [
    'previewToken', 'planDigest', 'resolutions', 'conflictIds', 'idempotencyKey',
    'pendingOperation', 'commitOperation', 'continuations', 'rolloutIdentity',
  ]) {
    assert.throws(
      () => validateWorkbookRolloutJournal({ ...initialized, [field]: 'valid-looking' }),
      /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/,
    )
  }
  assert.throws(() => validateWorkbookRolloutJournal({
    ...imported,
    projection: { ...terminalProjectionCheckpoint, sourceRecordId: 'wbs_secret' },
  }), /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
})

test('review and fresh-auth pauses keep only safe import and digest bindings durable', async () => {
  let importExists = false
  const financeApi = {
    async operatorEvidence() { return evidence },
    async preview() { return preview() },
    async discoverImport() { return importExists ? terminalState : null },
    async commit() { importExists = true; return terminalState },
    async status() { return terminalState },
    async continue() { throw new Error('terminal finance import') },
    async artifactVerification() { return artifactVerification() },
    async reconciliation() { throw new Error('must not reconcile before projections') },
  }
  let saved = null
  const journal = {
    async load() { return saved === null ? null : structuredClone(saved) },
    async save(value) { saved = structuredClone(value) },
  }
  const review = await runResumableStagingWorkbookRollout(runInput(
    journal, financeApi, { loadedResolutions: null },
  ))
  assert.deepEqual(review, {
    status: 'historical_review_required', artifactId: ARTIFACT_ID, importId: IMPORT_ID,
  })
  assert.deepEqual(saved, importedWithoutResolutions)

  const reauthApi = {
    ...financeApi,
    ...projectionApi(),
    async historicalProjection(_importId, { consumeConflictReview }) {
      const value = { projection: null, conflicts: [] }
      await consumeConflictReview(value)
      return value
    },
    async continueHistoricalProjection() {
      const error = new Error('remote sensitive detail')
      error.code = 'REAUTH_REQUIRED'
      throw error
    },
  }
  const reauth = await runResumableStagingWorkbookRollout(runInput(journal, reauthApi))
  assert.equal(reauth.status, 'reauth_required')
  assert.equal(reauth.pipeline, 'historical')
  assert.equal(reauth.operation, 'continue')
  assert.equal(reauth.job, null)
  assert.doesNotMatch(JSON.stringify(reauth), /remote sensitive|wbs_|hcf_/)
  assert.deepEqual(saved, imported)
})
