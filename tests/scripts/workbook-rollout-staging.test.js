import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  assertApprovedRolloutActorAndResolutions,
  runStagingWorkbookRollout,
} from '../../scripts/workbook-rollout-staging-lib.mjs'

const PLAN_DIGEST = `v1_${'A'.repeat(43)}`
const FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const projectionContext = (index) => Object.freeze({
  counterparty: 'Synthetic rollout subject',
  serviceLabel: index < 86 ? 'Synthetic classification' : 'Synthetic service',
  proposedClassification: index < 86 ? 'review' : 'person',
  proposedServiceId: null, nearSubjectIds: Object.freeze([]),
})
const projectionProfiles = Object.freeze(Array.from({ length: 5 }, (_, index) => (
  Object.freeze({
    sourceRecordId: `wbs_rollout_profile_${String(index + 1).padStart(4, '0')}`,
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
    sourceRecordId: `wbs_rollout_${String(index + 1).padStart(4, '0')}`,
    kind: index < 86 ? 'classification' : 'service', classification: 'person',
    existingSubjectId: null, serviceId: 'zajecia',
    reviewContextDigest: sha256(JSON.stringify({
      context: projectionContext(index), subjectSensitive: false,
      profileDigest: PROFILE_DIGEST,
    })),
  })
)))
const projectionArtifact = Object.freeze({
  schema: 'historical_projection_resolutions.v1', environment: 'staging',
  centreId: 'centre_1', fingerprint: FINGERPRINT,
  artifactId: 'wba_rollout_one', importId: 'wbi_rollout_one',
  creatorId: 'stf_rollout_owner', planDigest: PLAN_DIGEST,
  decisionCount: 1_992, decisionDigest: sha256(JSON.stringify(projectionDecisions)),
  decisions: projectionDecisions,
})
const loadedResolutions = Object.freeze({
  artifact: projectionArtifact, fileSha256: sha256(JSON.stringify(projectionArtifact)),
})
const previewMetadata = Object.freeze({
  parserVersion: 2,
  materializerVersion: 2,
  planDigest: PLAN_DIGEST,
  workbookKind: 'legacy',
})

const evidence = Object.freeze({
  artifactCount: 1,
  workbookObjectCount: 1,
  templateCount: 1,
  importCount: 1,
  planCount: 1,
  sourceRecordCount: 0,
  quarantineCount: 0,
  resolutionCount: 1,
  resolutionSetCount: 1,
  jobCount: 1,
  candidateCount: 0,
  decisionCount: 0,
  financeEntryCount: 0,
  financeLinkCount: 0,
  historicalOccurrenceCount: 0,
  activityChargeCount: 0,
  projectionLinkCount: 0,
  workbookVoidCount: 5,
  manualVoidCount: 0,
  auditEventCount: 7,
  createdRecordCount: 2235,
  outboxMessageCount: 0,
  voidedRecordCount: 5,
})

const reconciliation = Object.freeze({
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
const serverReconciliation = Object.freeze({
  ...reconciliation,
  replayCreatedRecords: 0,
  replayVoidedRecords: 0,
})

const recoveryFacts = Object.freeze({
  kind: 'workbook_roundtrip_v1',
  artifact: Object.freeze({
    id: 'wba_rollout_one', fingerprint: FINGERPRINT, byteSize: 4096,
    parserVersion: 2, materializerVersion: 2,
  }),
  import: Object.freeze({
    id: 'wbi_rollout_one', status: 'complete', version: 3,
    acceptedRecords: 2_232, quarantinedRecords: 3,
  }),
  finance: Object.freeze({
    jobId: 'wbj_rollout_one', status: 'complete', phase: 'complete', version: 3,
    cursor: 2_232, totalRecords: 2_232, processedRecords: 2_232, reportingRevision: 1,
  }),
  historical: Object.freeze({
    jobId: 'hpj_rollout_one', status: 'complete', version: 3_985,
    totalRecords: 2_000, processedRecords: 2_000, projectedRecords: 1_997,
    conflictCount: 1_992, resolutionCount: 1_992, occurrenceCount: 1_997,
    explicitExclusionCount: 0, automaticDeferredCount: 3, unresolvedCount: 0,
  }),
  activity: Object.freeze({
    jobId: 'apj_rollout_one', status: 'complete', version: 2,
    totalRecords: 190, processedRecords: 190, projectedRecords: 190,
    participantLinkCount: 190, chargeLinkCount: 190, groupLinkCount: 25,
    membershipObservationLinkCount: 25, physicalLinkCount: 430,
  }),
  reconciliation: Object.freeze({ ...serverReconciliation, crossProjectionOverlapCount: 0 }),
})

const terminal = Object.freeze({
  importId: 'wbi_rollout_one',
  artifactId: 'wba_rollout_one',
  jobId: 'wbj_rollout_one',
  jobVersion: 3,
  status: 'complete',
  version: 3,
  createdRecords: 2235,
  voidedRecords: 5,
  converged: true,
})

test('approved rollout actor is the linked Julia specialist and has no mapping conflicts', () => {
  const actor = {
    id: 'stf_julia', displayName: 'Julia Wolanin', professionalTitle: 'Specjalistka',
    role: 'owner', specialistId: 'sp_staging_workbook_julia_wolanin',
  }
  const resolutions = []
  assert.deepEqual(assertApprovedRolloutActorAndResolutions({ actor, resolutions }), resolutions)
  for (const hostile of [
    { actor: { ...actor, displayName: 'Inna Osoba' }, resolutions },
    { actor: { ...actor, professionalTitle: null }, resolutions },
    { actor: { ...actor, specialistId: 'sp_other' }, resolutions },
    { actor, resolutions: [{
      conflictId: 'wmc_mapping_one', specialistId: actor.specialistId,
    }] },
  ]) {
    assert.throws(() => assertApprovedRolloutActorAndResolutions(hostile),
      /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  }
})

const fixture = (overrides = {}) => {
  const calls = []
  let evidenceReads = 0
  let continuationCalls = 0
  const api = {
    async operatorEvidence() {
      calls.push('evidence')
      evidenceReads += 1
      return evidence
    },
    async preview(workbook) {
      calls.push('preview')
      assert.equal(workbook.marker, 'same-workbook-object')
      return {
        fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
        previewToken: 'must-never-escape',
        conflictIds: ['wmc_mapping_one'],
        ...previewMetadata,
      }
    },
    async commit(input) {
      calls.push('commit')
      assert.equal(input.workbook.marker, 'same-workbook-object')
      assert.equal(input.previewToken, 'must-never-escape')
      assert.deepEqual(input.resolutions, [{
        conflictId: 'wmc_mapping_one', specialistId: 'sp_fictional_julia',
      }])
      assert.equal(input.idempotencyKey, 'rollout-commit-fixed-key')
      return {
        importId: terminal.importId, artifactId: terminal.artifactId,
        jobId: null, jobVersion: null,
        status: 'materializing', version: 1, createdRecords: 0,
        voidedRecords: 0, converged: false,
      }
    },
    async status(importId) {
      calls.push('status')
      assert.equal(importId, terminal.importId)
      return {
        importId, artifactId: terminal.artifactId, status: 'materializing',
        jobId: terminal.jobId, jobVersion: 1,
        version: 2, createdRecords: 0, voidedRecords: 0, converged: false,
      }
    },
    async continue(input) {
      calls.push('continue')
      continuationCalls += 1
      const ordinal = continuationCalls <= 2 ? continuationCalls : 2
      assert.deepEqual(input, {
        importId: terminal.importId,
        expectedVersion: 2,
        idempotencyKey: `rollout-continue-fixed-key-${terminal.jobId}-${ordinal}-${ordinal}`,
      })
      return ordinal === 1 ? {
        importId: terminal.importId, artifactId: terminal.artifactId,
        jobId: terminal.jobId, jobVersion: 2,
        status: 'materializing', version: 2, createdRecords: 1200,
        voidedRecords: 2, converged: false,
      } : terminal
    },
    async artifactVerification(importId) {
      calls.push('artifact')
      return {
        artifactId: terminal.artifactId,
        environmentMatch: importId === terminal.importId,
        centreMatch: true,
        ciphertextMetadataValid: true,
        digestMatch: true,
        sizeMatch: true,
        keyVersionsMatch: true,
        opaqueObjectKey: true,
        readbackDigestMatch: true,
      }
    },
    async reconciliation(importId) {
      calls.push('reconciliation')
      assert.equal(importId, terminal.importId)
      return recoveryFacts
    },
    async historicalReviewCatalog({ afterSourceRecordId, consumeReviewPage }) {
      const offset = afterSourceRecordId === null ? 0
        : projectionDecisions.findIndex(({ sourceRecordId }) => (
          sourceRecordId === afterSourceRecordId
        )) + 1
      const page = projectionDecisions.slice(offset, offset + 100)
      const privatePage = {
        binding: {
          environment: 'staging', centreId: 'centre_1', fingerprint: FINGERPRINT,
          artifactId: terminal.artifactId, importId: terminal.importId,
          creatorId: 'stf_rollout_owner', planDigest: PLAN_DIGEST,
        },
        afterSourceRecordId,
        nextAfterSourceRecordId: offset + page.length < projectionDecisions.length
          ? page.at(-1).sourceRecordId : null,
        directoryCount: 0, directoryDigest: 'd'.repeat(64),
        items: page.map((decision, index) => ({
          sourceRecordId: decision.sourceRecordId, kind: decision.kind,
          conflictId: `hcf_rollout_${String(offset + index + 1).padStart(4, '0')}`,
          resolution: {
            classification: decision.classification,
            existingSubjectId: decision.existingSubjectId, serviceId: decision.serviceId,
          },
          reviewContextDigest: sha256(JSON.stringify(projectionContext(offset + index))),
          context: projectionContext(offset + index),
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
          id: 'hpj_rollout_one', importId: terminal.importId, status: 'complete',
          afterSourceRecordId: 'wbs_rollout_terminal', totalRecords: 2_000,
          processedRecords: 2_000, projectedRecords: 1_997, conflictCount: 1_992,
          version: 3_985, updatedAt: '2026-08-28T10:00:00.000Z',
          completedAt: '2026-08-28T10:00:00.000Z',
        },
        conflicts: [],
      }
      await consumeConflictReview(value)
      return value
    },
    async continueHistoricalProjection(input) {
      assert.equal(input.expectedVersion, 3_984)
      return {
        id: 'hpj_rollout_one', importId: terminal.importId, status: 'complete',
        afterSourceRecordId: 'wbs_rollout_terminal', totalRecords: 2_000,
        processedRecords: 2_000, projectedRecords: 1_997, conflictCount: 1_992,
        version: 3_985, updatedAt: '2026-08-28T10:00:00.000Z',
        completedAt: '2026-08-28T10:00:00.000Z',
      }
    },
    async resolveHistoricalProjection() { throw new Error('terminal') },
    async activityProjection() {
      return {
        id: 'apj_rollout_one', importId: terminal.importId, status: 'complete',
        afterSourceRecordId: 'wbs_activity_terminal', totalRecords: 190,
        processedRecords: 190, projectedRecords: 190, version: 2,
        updatedAt: '2026-08-28T10:00:00.000Z',
        completedAt: '2026-08-28T10:00:00.000Z',
      }
    },
    async continueActivityProjection(input) {
      assert.equal(input.expectedVersion, 1)
      return {
        id: 'apj_rollout_one', importId: terminal.importId, status: 'complete',
        afterSourceRecordId: 'wbs_activity_terminal', totalRecords: 190,
        processedRecords: 190, projectedRecords: 190, version: 2,
        updatedAt: '2026-08-28T10:00:00.000Z',
        completedAt: '2026-08-28T10:00:00.000Z',
      }
    },
    ...overrides,
  }
  return { api, calls, evidenceReads: () => evidenceReads }
}

test('rollout proves no-write preview, terminal continuation, artifact readback and replay convergence', async () => {
  const { api, calls, evidenceReads } = fixture()
  const result = await runStagingWorkbookRollout({
    api,
    workbook: Object.freeze({ marker: 'same-workbook-object' }),
    approvedFingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
    resolutions: Object.freeze([Object.freeze({
      conflictId: 'wmc_mapping_one', specialistId: 'sp_fictional_julia',
    })]),
    commitIdempotencyKey: 'rollout-commit-fixed-key',
    continueIdempotencyKey: (jobId, jobVersion, _version, ordinal) => (
      `rollout-continue-fixed-key-${jobId}-${jobVersion}-${ordinal}`
    ),
    loadedResolutions,
    expectedReconciliation: reconciliation,
    maximumContinuations: 10,
  })

  assert.deepEqual(result, {
    artifactId: 'wba_rollout_one',
    importId: 'wbi_rollout_one',
    acceptedCount: 2232,
    quarantinedCount: 3,
    previewWritesZero: true,
    terminalComplete: true,
    artifactVerified: true,
    reconciliationMatched: true,
    replayIdentityMatch: true,
    replayWritesZero: true,
    status: 'ok',
  })
  assert.equal(evidenceReads(), 4)
  assert.deepEqual(calls, [
    'evidence', 'preview', 'evidence', 'commit', 'status', 'continue', 'continue',
    'artifact', 'reconciliation', 'evidence', 'commit', 'continue',
    'evidence', 'reconciliation',
  ])
  assert.doesNotMatch(JSON.stringify(result), /must-never-escape|mapping|specialist|source/i)
})

test('rollout stops before commit when preview wrote or resolutions do not exactly cover conflicts', async () => {
  let driftingEvidenceReads = 0
  for (const overrides of [
    {
      async operatorEvidence() {
        driftingEvidenceReads += 1
        return driftingEvidenceReads === 1 ? evidence : { ...evidence, auditEventCount: 8 }
      },
    },
    {
      async preview() {
        return {
          fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
          previewToken: 'private-preview-token',
          conflictIds: ['wmc_unreviewed'],
          ...previewMetadata,
        }
      },
    },
    {
      async preview() {
        return {
          fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
          previewToken: 'private-preview-token', conflictIds: [], ...previewMetadata,
        }
      },
    },
  ]) {
    let commits = 0
    const { api } = fixture({
      ...overrides,
      async commit() { commits += 1; throw new Error('must not commit') },
    })
    await assert.rejects(runStagingWorkbookRollout({
      api,
      workbook: Object.freeze({ marker: 'same-workbook-object' }),
      approvedFingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
      resolutions: Object.freeze([Object.freeze({
        conflictId: 'wmc_mapping_one', specialistId: 'sp_fictional_julia',
      })]),
      commitIdempotencyKey: 'rollout-commit-fixed-key',
      continueIdempotencyKey: (version, ordinal) => (
        `rollout-continue-fixed-key-${version}-${ordinal}`
      ),
      loadedResolutions,
      expectedReconciliation: reconciliation,
      maximumContinuations: 10,
    }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
    assert.equal(commits, 0)
  }
})

test('rollout rejects non-authoritative preview versions, kind and digest before commit', async () => {
  for (const override of [
    { parserVersion: 3 },
    { materializerVersion: 3 },
    { planDigest: 'v1_invalid' },
    { workbookKind: 'panel-v2' },
  ]) {
    let commits = 0
    const { api } = fixture({
      async preview() {
        return {
          fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
          previewToken: 'private-preview-token', conflictIds: ['wmc_mapping_one'],
          ...previewMetadata, ...override,
        }
      },
      async commit() { commits += 1; throw new Error('must not commit') },
    })
    await assert.rejects(runStagingWorkbookRollout({
      api,
      workbook: Object.freeze({ marker: 'same-workbook-object' }),
      approvedFingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
      resolutions: [{ conflictId: 'wmc_mapping_one', specialistId: 'sp_fictional_julia' }],
      commitIdempotencyKey: 'rollout-commit-fixed-key',
      continueIdempotencyKey: (version, ordinal) => `continue-${version}-${ordinal}`,
      loadedResolutions,
      expectedReconciliation: reconciliation,
    }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
    assert.equal(commits, 0)
  }
})

test('rollout stops before a second continuation when a response switches import identity', async () => {
  let continuationCalls = 0
  const { api } = fixture({
    async continue() {
      continuationCalls += 1
      return {
        importId: 'wbi_foreign_one', artifactId: 'wba_foreign_one',
        jobId: terminal.jobId, jobVersion: 2,
        status: 'materializing', version: 2, createdRecords: 1,
        voidedRecords: 0, converged: false,
      }
    },
  })
  await assert.rejects(runStagingWorkbookRollout({
    api,
    workbook: Object.freeze({ marker: 'same-workbook-object' }),
    approvedFingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
    resolutions: [{ conflictId: 'wmc_mapping_one', specialistId: 'sp_fictional_julia' }],
    commitIdempotencyKey: 'rollout-commit-fixed-key',
    continueIdempotencyKey: (version, ordinal) => `continue-${version}-${ordinal}`,
    loadedResolutions,
    expectedReconciliation: reconciliation,
  }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  assert.equal(continuationCalls, 1)
})

test('rollout rejects replay when created or voided write counters change', async () => {
  let reads = 0
  const { api } = fixture({
    async operatorEvidence() {
      reads += 1
      if (reads < 4) return evidence
      return { ...evidence, createdRecordCount: evidence.createdRecordCount + 1 }
    },
  })
  await assert.rejects(runStagingWorkbookRollout({
    api,
    workbook: Object.freeze({ marker: 'same-workbook-object' }),
    approvedFingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
    resolutions: Object.freeze([Object.freeze({
      conflictId: 'wmc_mapping_one', specialistId: 'sp_fictional_julia',
    })]),
    commitIdempotencyKey: 'rollout-commit-fixed-key',
    continueIdempotencyKey: (version, ordinal) => (
      `rollout-continue-fixed-key-${version}-${ordinal}`
    ),
    loadedResolutions,
    expectedReconciliation: reconciliation,
    maximumContinuations: 10,
  }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
})

test('rollout rejects nonzero informational replay decision counts', async () => {
  const { api } = fixture({
    async reconciliation() {
      return { ...serverReconciliation, replayCreatedRecords: 1 }
    },
  })
  await assert.rejects(runStagingWorkbookRollout({
    api,
    workbook: Object.freeze({ marker: 'same-workbook-object' }),
    approvedFingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
    resolutions: Object.freeze([Object.freeze({
      conflictId: 'wmc_mapping_one', specialistId: 'sp_fictional_julia',
    })]),
    commitIdempotencyKey: 'rollout-commit-fixed-key',
    continueIdempotencyKey: (version, ordinal) => `continue-${version}-${ordinal}`,
    loadedResolutions,
    expectedReconciliation: reconciliation,
  }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
})
