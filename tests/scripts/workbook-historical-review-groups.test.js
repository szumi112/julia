import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  assertApprovedInitialHistoricalProjectionReviewProposal,
  assertHistoricalProjectionResolutionArtifactForProposal,
  buildHistoricalProjectionReviewGroups,
  compileHistoricalProjectionReboundArtifact,
  compileHistoricalProjectionResolutionArtifact,
  historicalProjectionRebindSummary,
} from '../../scripts/workbook-historical-review-groups.mjs'
import { collectHistoricalProjectionReviewGroups } from '../../scripts/workbook-historical-review-workflow.mjs'

const FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const PLAN_DIGEST = `v1_${'A'.repeat(43)}`
const digest = (value) => createHash('sha256').update(value).digest('hex')
const binding = Object.freeze({
  environment: 'staging',
  centreId: 'centre_1',
  fingerprint: FINGERPRINT,
  artifactId: 'wba_group_review',
  importId: 'wbi_group_review',
  creatorId: 'stf_group_review',
  planDigest: PLAN_DIGEST,
})

const context = (overrides = {}) => Object.freeze({
  counterparty: 'Synthetic recurring subject',
  serviceLabel: 'Synthetic recurring service',
  proposedClassification: 'person',
  proposedServiceId: 'zajecia',
  nearSubjectIds: Object.freeze([]),
  ...overrides,
})

const items = Object.freeze(Array.from({ length: 1_992 }, (_, index) => {
  const sourceRecordId = `wbs_group_${String(index + 1).padStart(4, '0')}`
  if (index < 80) return Object.freeze({
    sourceRecordId, kind: 'classification', conflictId: null, resolution: null,
    context: context({ proposedClassification: 'review', proposedServiceId: null }),
  })
  if (index < 85) return Object.freeze({
    sourceRecordId, kind: 'classification', conflictId: null, resolution: null,
    context: context({
      counterparty: index === 80 ? 'Synthetic Near Subject'
        : index === 81 ? 'Synthetic Near Subjecu'
          : `Synthetic distinct ${digest(`classification-${index}`).slice(0, 12)}`,
      proposedClassification: 'review', proposedServiceId: null,
    }),
  })
  if (index === 85) return Object.freeze({
    sourceRecordId, kind: 'classification', conflictId: 'hcf_group_near', resolution: null,
    context: context({ nearSubjectIds: Object.freeze(['hcl_group_near']) }),
  })
  return Object.freeze({
    sourceRecordId, kind: 'service', conflictId: null, resolution: null,
    context: context({ counterparty: `Synthetic service ${digest(String(index % 50)).slice(0, 12)}` }),
  })
}))
const profiles = Object.freeze(Array.from({ length: 5 }, (_, index) => Object.freeze({
  sourceRecordId: `wbs_profile_${String(index + 1).padStart(4, '0')}`,
  context: context({
    counterparty: `Conflict free ${digest(`profile-${index}`).slice(0, 24)}`,
    serviceLabel: 'Zajęcia psychologiczne',
    proposedClassification: 'person', proposedServiceId: 'zajecia',
  }),
})))

const catalog = () => ({ binding, items, profiles })

const approvedInitialCatalog = () => {
  const value = structuredClone(catalog())
  for (let index = 86; index < 145; index += 1) {
    value.items[index].context.serviceLabel = `Service ${digest(`service-label-${index}`)}`
  }
  return value
}

const approvalsFor = (proposal) => Object.freeze({
  schema: 'historical_projection_group_approvals.v1',
  environment: proposal.environment,
  centreId: proposal.centreId,
  fingerprint: proposal.fingerprint,
  artifactId: proposal.artifactId,
  importId: proposal.importId,
  creatorId: proposal.creatorId,
  planDigest: proposal.planDigest,
  catalogDigest: proposal.catalogDigest,
  groupDigest: proposal.groupDigest,
  approvalCount: proposal.groupCount,
  approvals: Object.freeze(proposal.groups.map((group) => Object.freeze({
    groupId: group.groupId,
    reviewSignatureDigest: group.reviewSignatureDigest,
    membershipCount: group.membershipCount,
    membershipDigest: group.membershipDigest,
    classification: group.context.proposedClassification === 'review'
      ? 'person' : group.context.proposedClassification,
    existingSubjectId: group.context.nearSubjectIds.length ? 'hcl_group_near' : null,
    serviceId: group.context.proposedServiceId ?? 'zajecia',
  }))),
})

test('groups only complete identical authenticated review signatures and compiles 1,992 decisions', () => {
  const proposal = buildHistoricalProjectionReviewGroups(catalog())

  assert.equal(proposal.schema, 'historical_projection_review_groups.v1')
  assert.equal(proposal.catalogCount, 1_992)
  assert.equal(proposal.groups.flatMap(({ sourceRecordIds }) => sourceRecordIds).length, 1_992)
  assert.equal(new Set(proposal.groups.flatMap(({ sourceRecordIds }) => sourceRecordIds)).size, 1_992)
  const near = proposal.groups.find(({ context: value }) => value.nearSubjectIds.length > 0)
  assert.equal(near.membershipCount, 1)
  assert.deepEqual(near.context.nearSubjectIds, ['hcl_group_near'])
  const futureSensitive = proposal.groups.filter(({ subjectSensitive, context: value }) => (
    subjectSensitive && value.nearSubjectIds.length === 0
  ))
  assert.equal(futureSensitive.length, 2)
  assert.equal(futureSensitive.every(({ membershipCount }) => membershipCount === 1), true)
  assert.equal(proposal.groups.filter(({ membershipCount }) => membershipCount > 1).length, 2)
  assert.equal(proposal.groups.some((group) => group.membershipCount === 80), true)
  assert.equal(proposal.groups.some((group) => group.membershipCount === 1_906), true)
  const recurringService = proposal.groups.find((group) => group.membershipCount === 1_906)
  assert.equal(recurringService.context.counterparty, null)
  assert.equal(recurringService.memberContextDigests.length, 1_906)

  const result = compileHistoricalProjectionResolutionArtifact({
    proposal, approvals: approvalsFor(proposal),
  })
  assert.equal(result.schema, 'historical_projection_resolutions.v1')
  assert.equal(result.decisionCount, 1_992)
  assert.equal(result.decisions.filter(({ kind }) => kind === 'classification').length, 86)
  assert.equal(result.decisions.filter(({ kind }) => kind === 'service').length, 1_906)
  assert.deepEqual(Object.keys(result.decisions[0]), [
    'sourceRecordId', 'kind', 'classification', 'existingSubjectId', 'serviceId',
    'reviewContextDigest',
  ])
  assert.equal(JSON.stringify(result).includes('Synthetic recurring'), false)
  assert.equal(JSON.stringify(result).includes('nearSubjectIds'), false)
  assert.equal(assertHistoricalProjectionResolutionArtifactForProposal({
    proposal,
    loaded: { artifact: result, fileSha256: digest(JSON.stringify(result)) },
  }).artifact, result)
})

test('pins the approved empty-staging initial workflow to exactly 67 groups and five profiles', () => {
  const approved = buildHistoricalProjectionReviewGroups(approvedInitialCatalog())
  assert.equal(approved.groupCount, 67)
  assert.equal(assertApprovedInitialHistoricalProjectionReviewProposal(approved), approved)
  assert.throws(() => assertApprovedInitialHistoricalProjectionReviewProposal(
    buildHistoricalProjectionReviewGroups(catalog()),
  ), /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)
})

test('rejects a schema-valid artifact that bypasses exact group approval choices', () => {
  const proposal = buildHistoricalProjectionReviewGroups(catalog())
  const artifact = compileHistoricalProjectionResolutionArtifact({
    proposal, approvals: approvalsFor(proposal),
  })
  const hostile = structuredClone(artifact)
  const grouped = proposal.groups.find(({ membershipCount }) => membershipCount === 1_906)
  const target = hostile.decisions.find(({ sourceRecordId }) => (
    sourceRecordId === grouped.sourceRecordIds[0]
  ))
  target.serviceId = 'konsultacja'
  hostile.decisionDigest = digest(JSON.stringify(hostile.decisions))
  assert.throws(() => assertHistoricalProjectionResolutionArtifactForProposal({
    proposal,
    loaded: { artifact: hostile, fileSha256: digest(JSON.stringify(hostile)) },
  }), /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)
})

test('collector hands transient contexts directly to the compiler and returns only a proposal', async () => {
  const partiallyResolved = structuredClone(items)
  partiallyResolved[0].conflictId = 'hcf_group_resolved'
  partiallyResolved[0].resolution = {
    classification: 'person', existingSubjectId: null, serviceId: 'zajecia',
  }
  const proposal = await collectHistoricalProjectionReviewGroups({
    importId: binding.importId,
    api: {
      async historicalReviewCatalog({ afterSourceRecordId, consumeReviewPage }) {
        assert.equal(afterSourceRecordId, null)
        const privatePage = {
          binding, afterSourceRecordId: null, nextAfterSourceRecordId: null,
          items: partiallyResolved,
          profiles,
        }
        await consumeReviewPage(privatePage)
        return {
          ...privatePage,
          items: partiallyResolved.map(({ context: _context, ...item }) => item),
          profiles: profiles.map(({ sourceRecordId }) => ({ sourceRecordId })),
        }
      },
    },
  })
  assert.equal(proposal.catalogCount, 1_992)
  assert.equal(proposal.groupCount > 1, true)
})

test('requires ambiguous and subject-link-sensitive rows to remain singleton approvals', () => {
  const proposal = buildHistoricalProjectionReviewGroups(catalog())
  const near = proposal.groups.find(({ context: value }) => value.nearSubjectIds.length > 0)
  assert.equal(near.membershipCount, 1)

  const approvals = approvalsFor(proposal)
  const groupedIndex = approvals.approvals.findIndex(({ membershipCount }) => membershipCount > 1)
  const hostile = structuredClone(approvals)
  hostile.approvals[groupedIndex].existingSubjectId = 'hcl_group_subject'
  assert.throws(() => compileHistoricalProjectionResolutionArtifact({
    proposal, approvals: hostile,
  }), /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)

  const changedNear = structuredClone(catalog())
  changedNear.items[85].context.nearSubjectIds = []
  const changedProposal = buildHistoricalProjectionReviewGroups(changedNear)
  assert.notEqual(changedProposal.catalogDigest, proposal.catalogDigest)
  assert.notEqual(changedProposal.groupDigest, proposal.groupDigest)
})

test('refuses near-match substitution and non-canonical or separator-bearing review text', () => {
  const hostileNear = structuredClone(catalog())
  hostileNear.items[85].kind = 'near_match'
  assert.throws(() => buildHistoricalProjectionReviewGroups(hostileNear),
    /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)

  for (const counterparty of [
    ' leading', 'e\u0301', 'bad\u2028line', '\ud800', 'x'.repeat(161),
  ]) {
    const hostile = structuredClone(catalog())
    hostile.items[0].context.counterparty = counterparty
    assert.throws(() => buildHistoricalProjectionReviewGroups(hostile),
      /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)
  }
  const longService = structuredClone(catalog())
  longService.items[0].context.serviceLabel = 'x'.repeat(241)
  assert.throws(() => buildHistoricalProjectionReviewGroups(longService),
    /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)

  const unsafeConflictFree = structuredClone(catalog())
  unsafeConflictFree.profiles[0].context.counterparty = 'Synthetic recurring subjecu'
  assert.throws(() => buildHistoricalProjectionReviewGroups(unsafeConflictFree),
    /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)
  const existingNear = structuredClone(catalog())
  existingNear.profiles[0].context.nearSubjectIds = ['hcl_group_near']
  assert.throws(() => buildHistoricalProjectionReviewGroups(existingNear),
    /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)
})

test('rejects wildcard/default approvals and any omitted, extra, reordered, or drifted membership', () => {
  const proposal = buildHistoricalProjectionReviewGroups(catalog())
  const approvals = approvalsFor(proposal)
  const hostile = [
    { ...approvals, default: { classification: 'person' } },
    { ...approvals, wildcard: '*' },
    { ...approvals, approvalCount: approvals.approvalCount - 1,
      approvals: approvals.approvals.slice(1) },
    { ...approvals, approvalCount: approvals.approvalCount + 1,
      approvals: [...approvals.approvals, approvals.approvals[0]] },
    { ...approvals, approvals: [
      approvals.approvals[1], approvals.approvals[0], ...approvals.approvals.slice(2),
    ] },
    { ...approvals, catalogDigest: '0'.repeat(64) },
    { ...approvals, groupDigest: '0'.repeat(64) },
    { ...approvals, approvals: approvals.approvals.map((approval, index) => index === 0
      ? { ...approval, membershipDigest: '0'.repeat(64) } : approval) },
  ]
  for (const value of hostile) {
    assert.throws(() => compileHistoricalProjectionResolutionArtifact({
      proposal, approvals: value,
    }), /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)
  }

  const changed = structuredClone(catalog())
  changed.items[0].context.serviceLabel = 'Changed authenticated signature'
  const changedProposal = buildHistoricalProjectionReviewGroups(changed)
  assert.throws(() => compileHistoricalProjectionResolutionArtifact({
    proposal: changedProposal, approvals,
  }), /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)
})

test('rebinds only drifted exact-context groups while preserving all enumerated decisions', () => {
  const originalProposal = buildHistoricalProjectionReviewGroups(catalog())
  const previousArtifact = compileHistoricalProjectionResolutionArtifact({
    proposal: originalProposal, approvals: approvalsFor(originalProposal),
  })
  const previous = Object.freeze({
    artifact: previousArtifact,
    fileSha256: digest(JSON.stringify(previousArtifact)),
  })
  const changedCatalog = structuredClone(catalog())
  for (const index of [86, 136]) {
    changedCatalog.items[index].context.nearSubjectIds = ['hcl_group_rebind']
  }
  const proposal = buildHistoricalProjectionReviewGroups(changedCatalog)
  const previousBySource = new Map(previousArtifact.decisions.map((decision) => [
    decision.sourceRecordId, decision,
  ]))
  const changedGroups = proposal.groups.filter((group) => group.sourceRecordIds.some(
    (sourceRecordId, index) => previousBySource.get(sourceRecordId)?.reviewContextDigest
      !== group.memberContextDigests[index],
  ))
  assert.equal(changedGroups.length, 1)
  assert.equal(changedGroups[0].membershipCount, 2)
  assert.equal(changedGroups[0].subjectSensitive, true)
  const approvals = Object.freeze({
    schema: 'historical_projection_rebind_approvals.v1',
    environment: proposal.environment,
    centreId: proposal.centreId,
    fingerprint: proposal.fingerprint,
    artifactId: proposal.artifactId,
    importId: proposal.importId,
    creatorId: proposal.creatorId,
    planDigest: proposal.planDigest,
    previousFileSha256: previous.fileSha256,
    previousDecisionDigest: previousArtifact.decisionDigest,
    catalogDigest: proposal.catalogDigest,
    groupDigest: proposal.groupDigest,
    approvalCount: changedGroups.length,
    approvals: Object.freeze(changedGroups.map((group) => Object.freeze({
      groupId: group.groupId,
      reviewSignatureDigest: group.reviewSignatureDigest,
      membershipCount: group.membershipCount,
      membershipDigest: group.membershipDigest,
      classification: 'person',
      existingSubjectId: 'hcl_group_rebind',
      serviceId: 'zajecia',
    }))),
  })
  assert.deepEqual(historicalProjectionRebindSummary({ proposal, previous }), {
    decisionCount: 1_992,
    groupCount: proposal.groupCount,
    rebindGroupCount: 1,
    catalogDigest: proposal.catalogDigest,
    groupDigest: proposal.groupDigest,
    previousFileSha256: previous.fileSha256,
    previousDecisionDigest: previousArtifact.decisionDigest,
  })
  const rebound = compileHistoricalProjectionReboundArtifact({
    proposal, previous, approvals,
  })
  assert.equal(rebound.decisionCount, 1_992)
  assert.equal(rebound.decisions.filter(({ kind }) => kind === 'classification').length, 86)
  assert.equal(rebound.decisions.filter(({ kind }) => kind === 'service').length, 1_906)
  const reboundBySource = new Map(rebound.decisions.map((decision) => [
    decision.sourceRecordId, decision,
  ]))
  for (const decision of previousArtifact.decisions) {
    const observed = reboundBySource.get(decision.sourceRecordId)
    if (['wbs_group_0087', 'wbs_group_0137'].includes(decision.sourceRecordId)) {
      assert.equal(observed.existingSubjectId, 'hcl_group_rebind')
      assert.notEqual(observed.reviewContextDigest, decision.reviewContextDigest)
    } else assert.deepEqual(observed, decision)
  }
  for (const hostile of [
    { ...approvals, wildcard: '*' },
    { ...approvals, previousFileSha256: '0'.repeat(64) },
    { ...approvals, approvalCount: 0, approvals: [] },
    { ...approvals, approvals: approvals.approvals.map((approval) => ({
      ...approval, membershipDigest: '0'.repeat(64),
    })) },
  ]) {
    assert.throws(() => compileHistoricalProjectionReboundArtifact({
      proposal, previous, approvals: hostile,
    }), /^Error: WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED$/)
  }
})

test('requires reapproval when a current group contains divergent preserved choices', () => {
  const proposal = buildHistoricalProjectionReviewGroups(catalog())
  const artifact = structuredClone(compileHistoricalProjectionResolutionArtifact({
    proposal, approvals: approvalsFor(proposal),
  }))
  const grouped = proposal.groups.find(({ membershipCount }) => membershipCount === 1_906)
  artifact.decisions.find(({ sourceRecordId }) => (
    sourceRecordId === grouped.sourceRecordIds[0]
  )).serviceId = 'konsultacja'
  artifact.decisionDigest = digest(JSON.stringify(artifact.decisions))
  const previous = {
    artifact,
    fileSha256: digest(JSON.stringify(artifact)),
  }
  assert.equal(historicalProjectionRebindSummary({ proposal, previous }).rebindGroupCount, 1)
})
