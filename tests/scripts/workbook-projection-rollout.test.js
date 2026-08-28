import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  replayWorkbookProjectionTerminalOperations,
  runWorkbookProjectionRollout,
} from '../../scripts/workbook-projection-rollout.mjs'
import { buildHistoricalProjectionReviewGroups } from '../../scripts/workbook-historical-review-groups.mjs'

const FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const PLAN_DIGEST = `v1_${'A'.repeat(43)}`
const digest = (value) => createHash('sha256').update(value).digest('hex')
const reviewContext = (index, nearSubjectIds = []) => Object.freeze({
  counterparty: 'Synthetic Projection Subject',
  serviceLabel: index < 86 ? 'Synthetic Classification Service' : 'Synthetic Service',
  proposedClassification: index < 86 ? 'review' : 'person',
  proposedServiceId: null,
  nearSubjectIds: Object.freeze(nearSubjectIds),
})
const profiles = Object.freeze(Array.from({ length: 5 }, (_, index) => Object.freeze({
  sourceRecordId: `wbs_projection_profile_${String(index + 1).padStart(4, '0')}`,
  context: Object.freeze({
    counterparty: `Conflict free ${digest(`profile-${index}`).slice(0, 24)}`,
    serviceLabel: 'Zajęcia psychologiczne', proposedClassification: 'person',
    proposedServiceId: 'zajecia', nearSubjectIds: Object.freeze([]),
  }),
})))
const PROFILE_DIGEST = digest(JSON.stringify(profiles))
const decisions = Object.freeze(Array.from({ length: 1_992 }, (_, index) => Object.freeze({
  sourceRecordId: `wbs_projection_${String(index + 1).padStart(4, '0')}`,
  kind: index < 86 ? 'classification' : 'service',
  classification: 'person', existingSubjectId: null, serviceId: 'zajecia',
  reviewContextDigest: digest(JSON.stringify({
    context: reviewContext(index), subjectSensitive: false, profileDigest: PROFILE_DIGEST,
  })),
})))
const artifact = Object.freeze({
  schema: 'historical_projection_resolutions.v1', environment: 'staging',
  centreId: 'centre_1', fingerprint: FINGERPRINT,
  artifactId: 'wba_projection_rollout', importId: 'wbi_projection_rollout',
  creatorId: 'stf_projection_rollout', planDigest: PLAN_DIGEST,
  decisionCount: decisions.length, decisionDigest: digest(JSON.stringify(decisions)), decisions,
})
const loaded = Object.freeze({ artifact, fileSha256: digest(JSON.stringify(artifact)) })
const binding = Object.freeze({
  environment: artifact.environment, centreId: artifact.centreId,
  fingerprint: artifact.fingerprint, artifactId: artifact.artifactId,
  importId: artifact.importId, creatorId: artifact.creatorId, planDigest: artifact.planDigest,
})

const job = (kind, overrides = {}) => kind === 'historical' ? {
  id: 'hpj_projection_rollout', importId: artifact.importId, status: 'running',
  afterSourceRecordId: null, totalRecords: 2_000, processedRecords: 0,
  projectedRecords: 0, conflictCount: 0, version: 1,
  updatedAt: '2026-08-28T10:00:00.000Z', completedAt: null, ...overrides,
} : {
  id: 'apj_projection_rollout', importId: artifact.importId, status: 'running',
  afterSourceRecordId: null, totalRecords: 190, processedRecords: 0,
  projectedRecords: 0, version: 1, updatedAt: '2026-08-28T10:00:00.000Z',
  completedAt: null, ...overrides,
}

function completeApi({
  throwAfterFirstResolutionCommit = false, nearMatch = false, contextDrift = false,
} = {}) {
  let historical = null
  let conflictIndex = -1
  let resolvedCount = 0
  let activity = null
  let networkThrown = false
  const calls = []
  const resolutionReplays = new Map()
  const historicalContinuationReplays = new Map()
  const activityContinuationReplays = new Map()
  const currentConflict = () => conflictIndex >= resolvedCount ? [{
    conflictId: `hcf_projection_${String(conflictIndex + 1).padStart(4, '0')}`,
    sourceRecordId: decisions[conflictIndex].sourceRecordId,
    kind: nearMatch && conflictIndex === 0 ? 'near_match' : decisions[conflictIndex].kind,
  }] : []
  const api = {
    async historicalReviewCatalog({ afterSourceRecordId, consumeReviewPage = null }) {
      const offset = afterSourceRecordId === null
        ? 0 : decisions.findIndex(({ sourceRecordId }) => sourceRecordId === afterSourceRecordId) + 1
      const page = decisions.slice(offset, offset + 100)
      const drift = contextDrift && historical?.status === 'conflicts'
      const privatePage = {
        binding, afterSourceRecordId,
        nextAfterSourceRecordId: offset + page.length < decisions.length
          ? page.at(-1).sourceRecordId : null,
        directoryCount: 0, directoryDigest: 'd'.repeat(64),
        items: page.map(({ sourceRecordId, kind }, pageIndex) => {
          const context = reviewContext(offset + pageIndex,
            drift && offset + pageIndex === 0 ? ['hcl_projection_near'] : [])
          return {
          sourceRecordId, kind, conflictId: null, resolution: null,
          reviewContextDigest: digest(JSON.stringify(context)), context,
          }
        }),
        profiles: afterSourceRecordId === null ? profiles.map((profile) => ({
          ...profile, reviewContextDigest: digest(JSON.stringify(profile.context)),
        })) : [],
      }
      if (consumeReviewPage) await consumeReviewPage(privatePage)
      return {
        ...privatePage,
        items: privatePage.items.map(({ context: _context, ...item }) => item),
        profiles: privatePage.profiles.map(({ context: _context, ...profile }) => profile),
      }
    },
    async historicalProjection(_importId, { consumeConflictReview = null } = {}) {
      const privateState = {
        projection: historical,
        conflicts: currentConflict().map((conflict) => ({
          ...conflict,
          context: reviewContext(conflictIndex, (nearMatch || contextDrift) && conflictIndex === 0
            ? ['hcl_projection_near'] : []),
        })),
      }
      if (consumeConflictReview) await consumeConflictReview(privateState)
      return {
        projection: privateState.projection,
        conflicts: privateState.conflicts.map(({ context: _context, ...conflict }) => conflict),
      }
    },
    async continueHistoricalProjection(input) {
      calls.push({ operation: 'historical.continue', ...input })
      if (historicalContinuationReplays.has(input.idempotencyKey)) {
        return historicalContinuationReplays.get(input.idempotencyKey)
      }
      assert.equal(input.expectedVersion, historical?.version ?? 0)
      const nextVersion = input.expectedVersion + 1
      if (resolvedCount === decisions.length) {
        historical = job('historical', {
          status: 'complete', afterSourceRecordId: 'wbs_projection_terminal',
          totalRecords: 2_000, processedRecords: 2_000, projectedRecords: 1_997,
          conflictCount: 1_992, version: nextVersion,
          completedAt: '2026-08-28T10:01:00.000Z',
        })
      } else {
        conflictIndex = resolvedCount
        historical = job('historical', {
          status: 'conflicts', afterSourceRecordId: decisions[conflictIndex].sourceRecordId,
          processedRecords: resolvedCount, projectedRecords: resolvedCount,
          conflictCount: resolvedCount + 1, version: nextVersion,
        })
      }
      historicalContinuationReplays.set(input.idempotencyKey, historical)
      return historical
    },
    async resolveHistoricalProjection(input) {
      calls.push({ operation: 'historical.resolve', ...input })
      if (resolutionReplays.has(input.idempotencyKey)) {
        return resolutionReplays.get(input.idempotencyKey)
      }
      assert.equal(input.expectedJobVersion, historical.version)
      assert.equal(input.conflictId, currentConflict()[0].conflictId)
      const decision = decisions[conflictIndex]
      assert.deepEqual({
        classification: input.classification, existingSubjectId: input.existingSubjectId,
        serviceId: input.serviceId,
      }, {
        classification: decision.classification,
        existingSubjectId: decision.existingSubjectId, serviceId: decision.serviceId,
      })
      resolvedCount += 1
      historical = job('historical', {
        status: 'running', afterSourceRecordId: decision.sourceRecordId,
        processedRecords: resolvedCount - 1, projectedRecords: resolvedCount - 1,
        conflictCount: resolvedCount, version: input.expectedJobVersion + 1,
      })
      resolutionReplays.set(input.idempotencyKey, historical)
      if (throwAfterFirstResolutionCommit && !networkThrown) {
        networkThrown = true
        throw new Error('synthetic uncertain network')
      }
      return historical
    },
    async activityProjection() { return activity },
    async continueActivityProjection(input) {
      calls.push({ operation: 'activity.continue', ...input })
      if (activityContinuationReplays.has(input.idempotencyKey)) {
        return activityContinuationReplays.get(input.idempotencyKey)
      }
      assert.equal(input.expectedVersion, activity?.version ?? 0)
      activity = input.expectedVersion === 0
        ? job('activity', { processedRecords: 100, projectedRecords: 100, version: 1 })
        : job('activity', {
          status: 'complete', afterSourceRecordId: 'wbs_activity_terminal',
          processedRecords: 190, projectedRecords: 190, version: input.expectedVersion + 1,
          completedAt: '2026-08-28T10:02:00.000Z',
        })
      activityContinuationReplays.set(input.idempotencyKey, activity)
      return activity
    },
  }
  return { api, calls, resolved: () => resolvedCount }
}

test('drives singular historical resolutions and activity with exact versions and stable retries', async () => {
  const model = completeApi({ throwAfterFirstResolutionCommit: true })
  const checkpoints = []
  const result = await runWorkbookProjectionRollout({
    api: model.api, importId: artifact.importId, loadedResolutions: loaded,
    checkpoint(value) { checkpoints.push(value) },
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(result.historical, {
    jobId: 'hpj_projection_rollout', totalRecords: 2_000, processedRecords: 2_000,
    projectedRecords: 1_997, conflictCount: 1_992, version: 3_985,
    resolutionCount: 1_992,
  })
  assert.deepEqual(result.activity, {
    jobId: 'apj_projection_rollout', totalRecords: 190, processedRecords: 190,
    projectedRecords: 190, version: 2,
  })
  assert.equal(model.resolved(), 1_992)
  assert.equal(model.calls[0].operation, 'historical.continue')
  assert.equal(model.calls[0].expectedVersion, 0)
  const firstResolutionCalls = model.calls.filter((call) => (
    call.operation === 'historical.resolve' && call.conflictId === 'hcf_projection_0001'
  ))
  assert.equal(firstResolutionCalls.length, 2)
  assert.equal(firstResolutionCalls[0].idempotencyKey, firstResolutionCalls[1].idempotencyKey)
  assert.equal(model.calls.find((call) => call.operation === 'activity.continue').expectedVersion, 0)
  assert.equal(checkpoints.every((value) => !JSON.stringify(value).includes('wbs_')), true)
  assert.equal(checkpoints.every((value) => !JSON.stringify(value).includes('hcf_')), true)
})

test('actually replays both terminal projection continuations with their original stable identities', async () => {
  const model = completeApi()
  const result = await runWorkbookProjectionRollout({
    api: model.api, importId: artifact.importId, loadedResolutions: loaded,
  })
  const historicalOriginal = model.calls.filter(({ operation }) => (
    operation === 'historical.continue'
  )).at(-1)
  const activityOriginal = model.calls.filter(({ operation }) => (
    operation === 'activity.continue'
  )).at(-1)
  const replayed = await replayWorkbookProjectionTerminalOperations({
    api: model.api, importId: artifact.importId, loadedResolutions: loaded,
    result,
  })
  assert.deepEqual(replayed, {
    historicalVersion: result.historical.version,
    activityVersion: result.activity.version,
  })
  const historicalReplay = model.calls.filter(({ operation }) => (
    operation === 'historical.continue'
  )).at(-1)
  const activityReplay = model.calls.filter(({ operation }) => (
    operation === 'activity.continue'
  )).at(-1)
  assert.deepEqual(historicalReplay, historicalOriginal)
  assert.deepEqual(activityReplay, activityOriginal)
  assert.equal(historicalReplay.expectedVersion, result.historical.version - 1)
  assert.equal(activityReplay.expectedVersion, result.activity.version - 1)
})

test('stops with a fixed redacted resumable result at the 300-second fresh-auth boundary', async () => {
  const model = completeApi()
  model.api.continueHistoricalProjection = async () => {
    const error = new Error('sensitive remote details must not escape')
    error.code = 'REAUTH_REQUIRED'
    throw error
  }
  const result = await runWorkbookProjectionRollout({
    api: model.api, importId: artifact.importId, loadedResolutions: loaded,
  })
  assert.deepEqual(result, {
    status: 'reauth_required', pipeline: 'historical', operation: 'continue',
    decisionFileSha256: loaded.fileSha256, decisionCount: 1_992,
    decisionDigest: artifact.decisionDigest, job: null,
  })
  assert.equal(JSON.stringify(result).includes('sensitive'), false)
})

test('refuses a runtime near match rather than relabeling or submitting it', async () => {
  const model = completeApi({ nearMatch: true })
  const result = await runWorkbookProjectionRollout({
    api: model.api, importId: artifact.importId, loadedResolutions: loaded,
  })
  assert.equal(result.status, 'historical_rebind_required')
  assert.equal(result.pipeline, 'historical')
  assert.equal(result.operation, 'resolve')
  assert.equal(result.decisionFileSha256, loaded.fileSha256)
  assert.equal(result.decisionCount, 1_992)
  assert.equal(result.decisionDigest, artifact.decisionDigest)
  assert.equal(result.job.jobId, 'hpj_projection_rollout')
  assert.doesNotMatch(JSON.stringify(result), /wbs_|hcf_|counterparty|serviceLabel/)
  assert.equal(model.resolved(), 0)
})

test('refuses transient context drift even when the server conflict kind is unchanged', async () => {
  const model = completeApi({ contextDrift: true })
  const result = await runWorkbookProjectionRollout({
    api: model.api, importId: artifact.importId, loadedResolutions: loaded,
  })
  assert.equal(result.status, 'historical_rebind_required')
  assert.equal(result.operation, 'resolve')
  assert.doesNotMatch(JSON.stringify(result), /wbs_|hcf_|counterparty|serviceLabel/)
  assert.equal(model.resolved(), 0)
})

test('revalidates journal-bound group choices before any projection mutation', async () => {
  const poisonedDecisions = decisions.map((decision, index) => index === 100
    ? Object.freeze({ ...decision, serviceId: 'konsultacja' }) : decision)
  const poisonedArtifact = Object.freeze({
    ...artifact,
    decisionDigest: digest(JSON.stringify(poisonedDecisions)),
    decisions: Object.freeze(poisonedDecisions),
  })
  const poisoned = Object.freeze({
    artifact: poisonedArtifact,
    fileSha256: digest(JSON.stringify(poisonedArtifact)),
  })
  const proposal = buildHistoricalProjectionReviewGroups({
    binding,
    items: decisions.map((decision, index) => ({
      sourceRecordId: decision.sourceRecordId,
      kind: decision.kind,
      conflictId: null,
      resolution: null,
      context: reviewContext(index),
    })),
    profiles,
  })
  const model = completeApi()
  let mutationCalls = 0
  const originalContinue = model.api.continueHistoricalProjection
  model.api.continueHistoricalProjection = async (...args) => {
    mutationCalls += 1
    return originalContinue(...args)
  }
  await assert.rejects(runWorkbookProjectionRollout({
    api: model.api,
    importId: artifact.importId,
    loadedResolutions: poisoned,
    approvalMode: 'initial',
    approvalAlreadyValidated: true,
    validatedApproval: {
      approvalMode: 'initial',
      groupCount: proposal.groupCount,
      catalogDigest: proposal.catalogDigest,
      groupDigest: proposal.groupDigest,
    },
  }), /^Error: WORKBOOK_PROJECTION_ROLLOUT_FAILED$/)
  assert.equal(mutationCalls, 0)
})
