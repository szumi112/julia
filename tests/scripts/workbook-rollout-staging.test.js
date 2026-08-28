import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertApprovedRolloutActorAndResolutions,
  runStagingWorkbookRollout,
} from '../../scripts/workbook-rollout-staging-lib.mjs'

const PLAN_DIGEST = `v1_${'A'.repeat(43)}`
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

const terminal = Object.freeze({
  importId: 'wbi_rollout_one',
  artifactId: 'wba_rollout_one',
  status: 'complete',
  version: 3,
  createdRecords: 2235,
  voidedRecords: 5,
  converged: true,
})

test('approved rollout actor and every reviewed resolution are bound to Julia', () => {
  const actor = {
    id: 'stf_julia', displayName: 'Julia Wolanin', professionalTitle: 'Specjalistka',
    role: 'owner', specialistId: 'sp_fictional_julia',
  }
  const resolutions = [{
    conflictId: 'wmc_mapping_one', specialistId: 'sp_fictional_julia',
  }]
  assert.deepEqual(assertApprovedRolloutActorAndResolutions({ actor, resolutions }), resolutions)
  for (const hostile of [
    { actor: { ...actor, displayName: 'Inna Osoba' }, resolutions },
    { actor: { ...actor, professionalTitle: null }, resolutions },
    { actor: { ...actor, specialistId: 'sp_other' }, resolutions },
    { actor, resolutions: [] },
    { actor, resolutions: [...resolutions, {
      conflictId: 'wmc_mapping_two', specialistId: 'sp_fictional_julia',
    }] },
    { actor, resolutions: [{ ...resolutions[0], specialistId: 'sp_other' }] },
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
        status: 'materializing', version: 1, createdRecords: 0,
        voidedRecords: 0, converged: false,
      }
    },
    async status(importId) {
      calls.push('status')
      assert.equal(importId, terminal.importId)
      return {
        importId, artifactId: terminal.artifactId, status: 'materializing',
        version: 2, createdRecords: 0, voidedRecords: 0, converged: false,
      }
    },
    async continue(input) {
      calls.push('continue')
      continuationCalls += 1
      const ordinal = continuationCalls <= 2 ? continuationCalls : continuationCalls - 2
      assert.deepEqual(input, {
        importId: terminal.importId,
        expectedVersion: 2,
        idempotencyKey: `rollout-continue-fixed-key-2-${ordinal}`,
      })
      return ordinal === 1 ? {
        importId: terminal.importId, artifactId: terminal.artifactId,
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
      return serverReconciliation
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
    continueIdempotencyKey: (version, ordinal) => (
      `rollout-continue-fixed-key-${version}-${ordinal}`
    ),
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
    'artifact', 'reconciliation', 'evidence', 'commit', 'continue', 'continue',
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
    expectedReconciliation: reconciliation,
  }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
})
