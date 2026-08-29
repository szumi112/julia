import { createHash } from 'node:crypto'

import { compareUtf16CodeUnits } from '../src/code-unit-order.js'
import { historicalNamesRequireReview } from '../src/historical-records.js'
import { SERVICES } from '../src/services.js'
import { validateHistoricalProjectionResolutionArtifact } from './workbook-historical-resolutions.mjs'

const APPROVED_FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const BINDING_KEYS = Object.freeze([
  'environment', 'centreId', 'fingerprint', 'artifactId', 'importId', 'creatorId',
  'planDigest',
])
const CATALOG_KEYS = Object.freeze(['binding', 'items', 'profiles'])
const ITEM_KEYS = Object.freeze([
  'sourceRecordId', 'kind', 'conflictId', 'resolution', 'context',
])
const CONTEXT_KEYS = Object.freeze([
  'counterparty', 'serviceLabel', 'proposedClassification', 'proposedServiceId',
  'nearSubjectIds',
])
const PROFILE_KEYS = Object.freeze(['sourceRecordId', 'context'])
const PROPOSAL_KEYS = Object.freeze([
  'schema', ...BINDING_KEYS, 'catalogCount', 'catalogDigest', 'profileCount',
  'profileDigest', 'groupCount', 'groupDigest', 'groups',
])
const GROUP_KEYS = Object.freeze([
  'groupId', 'catalogKind', 'decisionKind', 'reviewSignatureDigest',
  'membershipCount', 'membershipDigest', 'sourceRecordIds', 'memberContextDigests',
  'subjectSensitive', 'context',
])
const APPROVALS_KEYS = Object.freeze([
  'schema', ...BINDING_KEYS, 'catalogDigest', 'groupDigest', 'approvalCount',
  'approvals',
])
const APPROVAL_KEYS = Object.freeze([
  'groupId', 'reviewSignatureDigest', 'membershipCount', 'membershipDigest',
  'classification', 'existingSubjectId', 'serviceId',
])
const REBIND_APPROVALS_KEYS = Object.freeze([
  'schema', ...BINDING_KEYS, 'previousFileSha256', 'previousDecisionDigest',
  'catalogDigest', 'groupDigest', 'approvalCount', 'approvals',
])
const SERVICE_IDS = new Set(SERVICES.map(({ id }) => id))
const ID = Object.freeze({
  artifact: /^wba_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  import: /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  creator: /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  source: /^wbs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  conflict: /^hcf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  client: /^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  counterparty: /^hcp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  group: /^hrg_[a-f0-9]{32}$/,
})

const refused = () => { throw new Error('WORKBOOK_HISTORICAL_GROUP_APPROVAL_REFUSED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const orderedExact = (value, keys) => plain(value)
  && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every((key, index) => key === keys[index])
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const hexDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const safeReviewText = (value, maximum) => {
  if (typeof value !== 'string' || value !== value.normalize('NFC')
    || value !== value.trim() || !value.isWellFormed()
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false
  const bytes = new TextEncoder().encode(value)
  const valid = bytes.byteLength >= 1 && bytes.byteLength <= maximum
  bytes.fill(0)
  return valid
}

function bindingDto(value) {
  if (!orderedExact(value, BINDING_KEYS)
    || value.environment !== 'staging' || value.centreId !== 'centre_1'
    || value.fingerprint !== APPROVED_FINGERPRINT
    || !ID.artifact.test(value.artifactId ?? '') || !ID.import.test(value.importId ?? '')
    || !ID.creator.test(value.creatorId ?? '')
    || !/^v1_[A-Za-z0-9_-]{43}$/.test(value.planDigest ?? '')) refused()
  return Object.freeze(Object.fromEntries(BINDING_KEYS.map((key) => [key, value[key]])))
}

function contextDto(value) {
  if (!orderedExact(value, CONTEXT_KEYS)
    || !safeReviewText(value.counterparty, 160) || !safeReviewText(value.serviceLabel, 240)
    || !['person', 'counterparty', 'review'].includes(value.proposedClassification)
    || !(value.proposedServiceId === null || SERVICE_IDS.has(value.proposedServiceId))
    || !Array.isArray(value.nearSubjectIds)
    || Object.getPrototypeOf(value.nearSubjectIds) !== Array.prototype
    || value.nearSubjectIds.length > 100) refused()
  const nearSubjectIds = value.nearSubjectIds.map((id) => {
    if (!ID.client.test(id ?? '') && !ID.counterparty.test(id ?? '')) refused()
    return id
  })
  for (let index = 1; index < nearSubjectIds.length; index += 1) {
    if (compareUtf16CodeUnits(nearSubjectIds[index - 1], nearSubjectIds[index]) >= 0) refused()
  }
  return Object.freeze({
    counterparty: value.counterparty,
    serviceLabel: value.serviceLabel,
    proposedClassification: value.proposedClassification,
    proposedServiceId: value.proposedServiceId,
    nearSubjectIds: Object.freeze(nearSubjectIds),
  })
}

function itemDto(value) {
  if (!orderedExact(value, ITEM_KEYS) || !ID.source.test(value.sourceRecordId ?? '')
    || !['classification', 'service'].includes(value.kind)
    || !(value.conflictId === null || ID.conflict.test(value.conflictId ?? ''))
    || value.resolution !== null) refused()
  return Object.freeze({
    sourceRecordId: value.sourceRecordId,
    kind: value.kind,
    conflictId: value.conflictId,
    resolution: null,
    context: contextDto(value.context),
  })
}

function reviewSignature(item) {
  if (item.kind === 'service') return item.subjectSensitive ? Object.freeze({
    catalogKind: item.kind,
    counterparty: item.context.counterparty,
    serviceLabel: item.context.serviceLabel,
    proposedClassification: item.context.proposedClassification,
    proposedServiceId: item.context.proposedServiceId,
    nearSubjectIds: item.context.nearSubjectIds,
    subjectSensitive: true,
  }) : Object.freeze({
    catalogKind: item.kind,
    serviceLabel: item.context.serviceLabel,
    proposedClassification: item.context.proposedClassification,
    proposedServiceId: item.context.proposedServiceId,
    subjectSensitive: false,
  })
  return Object.freeze({
    catalogKind: item.kind,
    counterparty: item.context.counterparty,
    serviceLabel: item.context.serviceLabel,
    proposedClassification: item.context.proposedClassification,
    proposedServiceId: item.context.proposedServiceId,
    nearSubjectIds: item.context.nearSubjectIds,
    subjectSensitive: item.subjectSensitive,
  })
}

const groupable = (item) => item.kind !== 'near_match'
  && (item.kind !== 'service' || item.context.proposedClassification !== 'review')

function groupReviewContext(signature) {
  return Object.freeze({
    counterparty: signature.catalogKind === 'service' && !signature.subjectSensitive
      ? null : signature.counterparty,
    serviceLabel: signature.serviceLabel,
    proposedClassification: signature.proposedClassification,
    proposedServiceId: signature.proposedServiceId,
    nearSubjectIds: Object.freeze(signature.nearSubjectIds ?? []),
  })
}

function groupIdentifier(binding, reviewSignatureDigest, membershipDigest) {
  return `hrg_${sha256(JSON.stringify([
    1, binding.fingerprint, binding.artifactId, binding.importId, binding.creatorId,
    binding.planDigest, reviewSignatureDigest, membershipDigest,
  ])).slice(0, 32)}`
}

function groupDto(binding, signature, members, profileDigest) {
  const sourceRecordIds = Object.freeze(members.map(({ sourceRecordId }) => sourceRecordId))
  const memberContextDigests = Object.freeze(members.map(({ context, subjectSensitive }) => (
    sha256(JSON.stringify({ context, subjectSensitive, profileDigest }))
  )))
  const reviewSignatureDigest = sha256(JSON.stringify(signature))
  const membershipDigest = sha256(JSON.stringify(sourceRecordIds.map(
    (sourceRecordId, index) => ({ sourceRecordId, contextDigest: memberContextDigests[index] }),
  )))
  const groupId = groupIdentifier(binding, reviewSignatureDigest, membershipDigest)
  return Object.freeze({
    groupId,
    catalogKind: signature.catalogKind,
    decisionKind: signature.catalogKind === 'service' ? 'service' : 'classification',
    reviewSignatureDigest,
    membershipCount: sourceRecordIds.length,
    membershipDigest,
    sourceRecordIds,
    memberContextDigests,
    subjectSensitive: members[0].subjectSensitive,
    context: groupReviewContext(signature),
  })
}

function groupContextDto(value, catalogKind, subjectSensitive) {
  if (!orderedExact(value, CONTEXT_KEYS)
    || !safeReviewText(value.serviceLabel, 240)
    || !(catalogKind === 'service' && !subjectSensitive ? value.counterparty === null
      : safeReviewText(value.counterparty, 160))
    || !['person', 'counterparty', 'review'].includes(value.proposedClassification)
    || !(value.proposedServiceId === null || SERVICE_IDS.has(value.proposedServiceId))
    || !Array.isArray(value.nearSubjectIds)
    || Object.getPrototypeOf(value.nearSubjectIds) !== Array.prototype
    || value.nearSubjectIds.length > 100) refused()
  const nearSubjectIds = value.nearSubjectIds.map((id) => {
    if (!ID.client.test(id ?? '') && !ID.counterparty.test(id ?? '')) refused()
    return id
  })
  for (let index = 1; index < nearSubjectIds.length; index += 1) {
    if (compareUtf16CodeUnits(nearSubjectIds[index - 1], nearSubjectIds[index]) >= 0) refused()
  }
  return Object.freeze({ ...value, nearSubjectIds: Object.freeze(nearSubjectIds) })
}

function validateProposal(value) {
  if (!orderedExact(value, PROPOSAL_KEYS)
    || value.schema !== 'historical_projection_review_groups.v1') refused()
  const binding = bindingDto(Object.fromEntries(
    BINDING_KEYS.map((key) => [key, value[key]]),
  ))
  if (value.catalogCount !== 1_992 || !hexDigest(value.catalogDigest)
    || value.profileCount !== 5 || !hexDigest(value.profileDigest)
    || !Number.isSafeInteger(value.groupCount) || value.groupCount < 1
    || value.groupCount > value.catalogCount || !hexDigest(value.groupDigest)
    || !Array.isArray(value.groups) || value.groups.length !== value.groupCount) refused()
  const groups = value.groups.map((group) => {
    if (!orderedExact(group, GROUP_KEYS) || !ID.group.test(group.groupId ?? '')
      || !['classification', 'service'].includes(group.catalogKind)
      || group.decisionKind !== (group.catalogKind === 'service'
        ? 'service' : 'classification')
      || !hexDigest(group.reviewSignatureDigest)
      || !Number.isSafeInteger(group.membershipCount) || group.membershipCount < 1
      || !hexDigest(group.membershipDigest)
      || !Array.isArray(group.sourceRecordIds)
      || group.sourceRecordIds.length !== group.membershipCount
      || !Array.isArray(group.memberContextDigests)
      || group.memberContextDigests.length !== group.membershipCount
      || group.memberContextDigests.some((digest) => !hexDigest(digest))
      || typeof group.subjectSensitive !== 'boolean') refused()
    const context = groupContextDto(group.context, group.catalogKind, group.subjectSensitive)
    const sourceRecordIds = group.sourceRecordIds.map((id) => {
      if (!ID.source.test(id ?? '')) refused()
      return id
    })
    for (let index = 1; index < sourceRecordIds.length; index += 1) {
      if (compareUtf16CodeUnits(sourceRecordIds[index - 1], sourceRecordIds[index]) >= 0) {
        refused()
      }
    }
    const signature = group.catalogKind === 'service' && !group.subjectSensitive ? {
      catalogKind: group.catalogKind,
      serviceLabel: context.serviceLabel,
      proposedClassification: context.proposedClassification,
      proposedServiceId: context.proposedServiceId,
      subjectSensitive: false,
    } : {
      catalogKind: group.catalogKind,
      counterparty: context.counterparty,
      serviceLabel: context.serviceLabel,
      proposedClassification: context.proposedClassification,
      proposedServiceId: context.proposedServiceId,
      nearSubjectIds: context.nearSubjectIds,
      subjectSensitive: group.subjectSensitive,
    }
    if (sha256(JSON.stringify(signature)) !== group.reviewSignatureDigest
      || sha256(JSON.stringify(sourceRecordIds.map((sourceRecordId, index) => ({
        sourceRecordId, contextDigest: group.memberContextDigests[index],
      })))) !== group.membershipDigest
      || groupIdentifier(binding, group.reviewSignatureDigest, group.membershipDigest)
        !== group.groupId) refused()
    return group
  })
  for (let index = 1; index < groups.length; index += 1) {
    if (compareUtf16CodeUnits(groups[index - 1].groupId, groups[index].groupId) >= 0) refused()
  }
  const allSources = groups.flatMap(({ sourceRecordIds }) => sourceRecordIds)
    .sort(compareUtf16CodeUnits)
  if (allSources.length !== 1_992
    || new Set(allSources).size !== allSources.length
    || sha256(JSON.stringify(groups)) !== value.groupDigest) refused()
  return { binding, groups }
}

export function buildHistoricalProjectionReviewGroups(value) {
  try {
    if (!orderedExact(value, CATALOG_KEYS)) refused()
    const binding = bindingDto(value.binding)
    if (!Array.isArray(value.items) || Object.getPrototypeOf(value.items) !== Array.prototype
      || value.items.length !== 1_992 || !Array.isArray(value.profiles)
      || Object.getPrototypeOf(value.profiles) !== Array.prototype
      || value.profiles.length !== 5) refused()
    const capturedItems = value.items.map(itemDto)
    const capturedProfiles = value.profiles.map((profile) => {
      if (!orderedExact(profile, PROFILE_KEYS) || !ID.source.test(profile.sourceRecordId ?? '')) {
        refused()
      }
      const capturedContext = contextDto(profile.context)
      if (capturedContext.proposedClassification === 'review'
        || capturedContext.proposedServiceId === null) refused()
      return Object.freeze({
        sourceRecordId: profile.sourceRecordId, context: capturedContext,
      })
    })
    for (let index = 1; index < capturedItems.length; index += 1) {
      if (compareUtf16CodeUnits(
        capturedItems[index - 1].sourceRecordId, capturedItems[index].sourceRecordId,
      ) >= 0) refused()
    }
    for (let index = 1; index < capturedProfiles.length; index += 1) {
      if (compareUtf16CodeUnits(
        capturedProfiles[index - 1].sourceRecordId, capturedProfiles[index].sourceRecordId,
      ) >= 0) refused()
    }
    const itemSourceIds = new Set(capturedItems.map(({ sourceRecordId }) => sourceRecordId))
    if (capturedProfiles.some(({ sourceRecordId }) => itemSourceIds.has(sourceRecordId))) refused()
    const profileDomains = new Map()
    for (const { context: capturedContext } of [...capturedItems, ...capturedProfiles]) {
      const domains = capturedContext.proposedClassification === 'review'
        ? ['counterparty', 'person'] : [capturedContext.proposedClassification]
      const existing = profileDomains.get(capturedContext.counterparty)
      if (existing) for (const domain of domains) existing.add(domain)
      else profileDomains.set(capturedContext.counterparty, new Set(domains))
    }
    const subjects = [...profileDomains.entries()].map(([name, domains]) => ({ name, domains }))
    const sensitive = new Set()
    for (let left = 0; left < subjects.length; left += 1) {
      for (let right = left + 1; right < subjects.length; right += 1) {
        const overlapping = [...subjects[left].domains].some(
          (domain) => subjects[right].domains.has(domain),
        )
        if (overlapping
          && historicalNamesRequireReview(subjects[left].name, subjects[right].name)) {
          sensitive.add(subjects[left].name)
          sensitive.add(subjects[right].name)
        }
      }
    }
    const items = capturedItems.map((item) => Object.freeze({
      ...item,
      subjectSensitive: item.context.nearSubjectIds.length > 0
        || sensitive.has(item.context.counterparty),
    }))
    if (capturedProfiles.some(({ context }) => context.nearSubjectIds.length > 0
      || sensitive.has(context.counterparty))) refused()
    const classificationCount = items.filter(({ kind }) => kind === 'classification').length
    const serviceCount = items.filter(({ kind }) => kind === 'service').length
    if (classificationCount !== 86 || serviceCount !== 1_906
      || classificationCount + serviceCount !== items.length) refused()
    const catalogFacts = items.map(({ sourceRecordId, kind, context, subjectSensitive }) => ({
      sourceRecordId, kind, context, subjectSensitive,
    }))
    const profileFacts = capturedProfiles.map(({ sourceRecordId, context }) => ({
      sourceRecordId, context,
    }))
    const profileDigest = sha256(JSON.stringify(profileFacts))
    const grouped = new Map()
    for (const item of items) {
      const signature = reviewSignature(item)
      const signatureJson = JSON.stringify(signature)
      const key = groupable(item) ? signatureJson : `${signatureJson}:${item.sourceRecordId}`
      const current = grouped.get(key)
      if (current) current.members.push(item)
      else grouped.set(key, { signature, members: [item] })
    }
    const groups = [...grouped.values()].map(({ signature, members }) => groupDto(
      binding, signature, members, profileDigest,
    )).sort((left, right) => compareUtf16CodeUnits(left.groupId, right.groupId))
    if (new Set(groups.map(({ groupId }) => groupId)).size !== groups.length) refused()
    const proposal = Object.freeze({
      schema: 'historical_projection_review_groups.v1',
      ...binding,
      catalogCount: items.length,
      catalogDigest: sha256(JSON.stringify({ items: catalogFacts, profiles: profileFacts })),
      profileCount: profileFacts.length,
      profileDigest,
      groupCount: groups.length,
      groupDigest: sha256(JSON.stringify(groups)),
      groups: Object.freeze(groups),
    })
    validateProposal(proposal)
    return proposal
  } catch { refused() }
}

export function assertApprovedInitialHistoricalProjectionReviewProposal(value) {
  try {
    const validated = validateProposal(value)
    if (value.groupCount !== 67 || value.profileCount !== 5
      || validated.groups.length !== 67) refused()
    return value
  } catch { refused() }
}

function decisionApproval(value, group) {
  if (!orderedExact(value, APPROVAL_KEYS) || value.groupId !== group.groupId
    || value.reviewSignatureDigest !== group.reviewSignatureDigest
    || value.membershipCount !== group.membershipCount
    || value.membershipDigest !== group.membershipDigest
    || !['person', 'counterparty', 'exclude'].includes(value.classification)
    || !(value.existingSubjectId === null
      || ID.client.test(value.existingSubjectId ?? '')
      || ID.counterparty.test(value.existingSubjectId ?? ''))
    || !(value.serviceId === null || SERVICE_IDS.has(value.serviceId))
    || (value.classification === 'person' && value.existingSubjectId !== null
      && !ID.client.test(value.existingSubjectId))
    || (value.classification === 'counterparty' && value.existingSubjectId !== null
      && !ID.counterparty.test(value.existingSubjectId))
    || (value.classification === 'exclude'
      && (value.existingSubjectId !== null || value.serviceId !== null))
    || (value.classification !== 'exclude' && value.serviceId === null)
    || (value.existingSubjectId !== null
      && !group.context.nearSubjectIds.includes(value.existingSubjectId))
    || (group.membershipCount > 1 && !group.subjectSensitive
      && value.existingSubjectId !== null)
    || (group.catalogKind === 'service'
      && value.classification !== group.context.proposedClassification)) refused()
  return value
}

function previousArtifactDto(previous, validated) {
  if (!orderedExact(previous, ['artifact', 'fileSha256'])
    || !hexDigest(previous.fileSha256)) refused()
  const artifact = validateHistoricalProjectionResolutionArtifact(previous.artifact)
  if (sha256(JSON.stringify(artifact)) !== previous.fileSha256
    || BINDING_KEYS.some((key) => artifact[key] !== validated.binding[key])) refused()
  const decisions = new Map(artifact.decisions.map((decision) => [
    decision.sourceRecordId, decision,
  ]))
  if (decisions.size !== 1_992) refused()
  for (const group of validated.groups) {
    for (const sourceRecordId of group.sourceRecordIds) {
      const decision = decisions.get(sourceRecordId)
      if (!decision || decision.kind !== group.decisionKind) refused()
    }
  }
  return { artifact, decisions }
}

const decisionChoice = (decision) => JSON.stringify([
  decision.classification, decision.existingSubjectId, decision.serviceId,
])

const approvalFromDecision = (group, decision) => ({
  groupId: group.groupId,
  reviewSignatureDigest: group.reviewSignatureDigest,
  membershipCount: group.membershipCount,
  membershipDigest: group.membershipDigest,
  classification: decision.classification,
  existingSubjectId: decision.existingSubjectId,
  serviceId: decision.serviceId,
})

function groupRequiresReapproval(group, decisions) {
  const members = group.sourceRecordIds.map((sourceRecordId) => decisions.get(sourceRecordId))
  if (members.some((decision, index) => !decision
    || decision.reviewContextDigest !== group.memberContextDigests[index])) return true
  if (new Set(members.map(decisionChoice)).size !== 1) return true
  try { decisionApproval(approvalFromDecision(group, members[0]), group) } catch { return true }
  return false
}

function changedRebindGroups(validated, decisions) {
  return validated.groups.filter((group) => groupRequiresReapproval(group, decisions))
}

export function assertHistoricalProjectionResolutionArtifactForProposal({
  proposal, loaded,
} = {}) {
  try {
    const validated = validateProposal(proposal)
    const current = previousArtifactDto(loaded, validated)
    const expected = []
    for (const group of validated.groups) {
      const members = group.sourceRecordIds.map((sourceRecordId) => (
        current.decisions.get(sourceRecordId)
      ))
      if (members.some((decision, index) => !decision
        || decision.kind !== group.decisionKind
        || decision.reviewContextDigest !== group.memberContextDigests[index])
        || new Set(members.map(decisionChoice)).size !== 1) refused()
      decisionApproval(approvalFromDecision(group, members[0]), group)
      for (let index = 0; index < members.length; index += 1) {
        expected.push(Object.freeze({
          sourceRecordId: group.sourceRecordIds[index],
          kind: group.decisionKind,
          classification: members[0].classification,
          existingSubjectId: members[0].existingSubjectId,
          serviceId: members[0].serviceId,
          reviewContextDigest: group.memberContextDigests[index],
        }))
      }
    }
    expected.sort((left, right) => compareUtf16CodeUnits(
      left.sourceRecordId, right.sourceRecordId,
    ))
    if (JSON.stringify(expected) !== JSON.stringify(current.artifact.decisions)) refused()
    return loaded
  } catch { refused() }
}

export function assertHistoricalProjectionResolutionArtifactForResolvedProposal({
  proposal, loaded, resolvedSourceRecordIds,
} = {}) {
  try {
    const validated = validateProposal(proposal)
    const current = previousArtifactDto(loaded, validated)
    if (!Array.isArray(resolvedSourceRecordIds)
      || Object.getPrototypeOf(resolvedSourceRecordIds) !== Array.prototype
      || resolvedSourceRecordIds.some((sourceRecordId) => !ID.source.test(sourceRecordId ?? ''))
      || new Set(resolvedSourceRecordIds).size !== resolvedSourceRecordIds.length) refused()
    const resolved = new Set(resolvedSourceRecordIds)
    for (const group of validated.groups) {
      const members = group.sourceRecordIds.map((sourceRecordId) => (
        current.decisions.get(sourceRecordId)
      ))
      if (members.some((decision) => !decision || decision.kind !== group.decisionKind)) refused()
      const unresolvedIndexes = group.sourceRecordIds.flatMap((sourceRecordId, index) => (
        resolved.has(sourceRecordId) ? [] : [index]
      ))
      if (unresolvedIndexes.length === 0) continue
      if (unresolvedIndexes.some((index) => (
        members[index].reviewContextDigest !== group.memberContextDigests[index]
      )) || new Set(members.map(decisionChoice)).size !== 1) refused()
      decisionApproval(approvalFromDecision(group, members[0]), group)
    }
    return loaded
  } catch { refused() }
}

export function historicalProjectionRebindSummary({ proposal, previous } = {}) {
  try {
    const validated = validateProposal(proposal)
    const prior = previousArtifactDto(previous, validated)
    const groups = changedRebindGroups(validated, prior.decisions)
    return Object.freeze({
      decisionCount: prior.artifact.decisionCount,
      groupCount: proposal.groupCount,
      rebindGroupCount: groups.length,
      catalogDigest: proposal.catalogDigest,
      groupDigest: proposal.groupDigest,
      previousFileSha256: previous.fileSha256,
      previousDecisionDigest: prior.artifact.decisionDigest,
    })
  } catch { refused() }
}

export function compileHistoricalProjectionReboundArtifact({
  proposal, previous, approvals,
} = {}) {
  try {
    const validated = validateProposal(proposal)
    const prior = previousArtifactDto(previous, validated)
    const changedGroups = changedRebindGroups(validated, prior.decisions)
    if (!orderedExact(approvals, REBIND_APPROVALS_KEYS)
      || approvals.schema !== 'historical_projection_rebind_approvals.v1') refused()
    const approvalBinding = bindingDto(Object.fromEntries(
      BINDING_KEYS.map((key) => [key, approvals[key]]),
    ))
    if (BINDING_KEYS.some((key) => approvalBinding[key] !== validated.binding[key])
      || approvals.previousFileSha256 !== previous.fileSha256
      || approvals.previousDecisionDigest !== prior.artifact.decisionDigest
      || approvals.catalogDigest !== proposal.catalogDigest
      || approvals.groupDigest !== proposal.groupDigest
      || approvals.approvalCount !== changedGroups.length
      || !Array.isArray(approvals.approvals)
      || Object.getPrototypeOf(approvals.approvals) !== Array.prototype
      || approvals.approvals.length !== approvals.approvalCount) refused()
    const reboundApprovals = new Map()
    for (let index = 0; index < changedGroups.length; index += 1) {
      const group = changedGroups[index]
      reboundApprovals.set(group.groupId, decisionApproval(approvals.approvals[index], group))
    }
    const decisions = []
    for (const group of validated.groups) {
      const approval = reboundApprovals.get(group.groupId)
      for (let index = 0; index < group.sourceRecordIds.length; index += 1) {
        const sourceRecordId = group.sourceRecordIds[index]
        if (approval === undefined) {
          const existing = prior.decisions.get(sourceRecordId)
          if (existing.reviewContextDigest !== group.memberContextDigests[index]) refused()
          decisions.push(existing)
        } else {
          decisions.push(Object.freeze({
            sourceRecordId,
            kind: group.decisionKind,
            classification: approval.classification,
            existingSubjectId: approval.existingSubjectId,
            serviceId: approval.serviceId,
            reviewContextDigest: group.memberContextDigests[index],
          }))
        }
      }
    }
    decisions.sort((left, right) => compareUtf16CodeUnits(
      left.sourceRecordId, right.sourceRecordId,
    ))
    const artifact = Object.freeze({
      schema: 'historical_projection_resolutions.v1',
      ...validated.binding,
      decisionCount: decisions.length,
      decisionDigest: sha256(JSON.stringify(decisions)),
      decisions: Object.freeze(decisions),
    })
    return validateHistoricalProjectionResolutionArtifact(artifact)
  } catch { refused() }
}

export function compileHistoricalProjectionResolutionArtifact({ proposal, approvals } = {}) {
  try {
    const validated = validateProposal(proposal)
    if (!orderedExact(approvals, APPROVALS_KEYS)
      || approvals.schema !== 'historical_projection_group_approvals.v1') refused()
    const approvalBinding = bindingDto(Object.fromEntries(
      BINDING_KEYS.map((key) => [key, approvals[key]]),
    ))
    if (BINDING_KEYS.some((key) => approvalBinding[key] !== validated.binding[key])
      || approvals.catalogDigest !== proposal.catalogDigest
      || approvals.groupDigest !== proposal.groupDigest
      || approvals.approvalCount !== proposal.groupCount
      || !Array.isArray(approvals.approvals)
      || Object.getPrototypeOf(approvals.approvals) !== Array.prototype
      || approvals.approvals.length !== approvals.approvalCount) refused()
    const decisions = []
    for (let index = 0; index < validated.groups.length; index += 1) {
      const group = validated.groups[index]
      const approval = decisionApproval(approvals.approvals[index], group)
      for (let memberIndex = 0; memberIndex < group.sourceRecordIds.length; memberIndex += 1) {
        const sourceRecordId = group.sourceRecordIds[memberIndex]
        decisions.push(Object.freeze({
          sourceRecordId,
          kind: group.decisionKind,
          classification: approval.classification,
          existingSubjectId: approval.existingSubjectId,
          serviceId: approval.serviceId,
          reviewContextDigest: group.memberContextDigests[memberIndex],
        }))
      }
    }
    decisions.sort((left, right) => compareUtf16CodeUnits(
      left.sourceRecordId, right.sourceRecordId,
    ))
    if (decisions.length !== 1_992 || new Set(decisions.map(
      ({ sourceRecordId }) => sourceRecordId,
    )).size !== decisions.length
      || decisions.filter(({ kind }) => kind === 'classification').length !== 86
      || decisions.filter(({ kind }) => kind === 'service').length !== 1_906) refused()
    return Object.freeze({
      schema: 'historical_projection_resolutions.v1',
      ...validated.binding,
      decisionCount: decisions.length,
      decisionDigest: sha256(JSON.stringify(decisions)),
      decisions: Object.freeze(decisions),
    })
  } catch { refused() }
}
