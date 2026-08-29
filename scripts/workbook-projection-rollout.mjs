import { createHash } from 'node:crypto'

import {
  assertApprovedInitialHistoricalProjectionReviewProposal,
  assertHistoricalProjectionResolutionArtifactForProposal,
  assertHistoricalProjectionResolutionArtifactForResolvedProposal,
  buildHistoricalProjectionReviewGroups,
} from './workbook-historical-review-groups.mjs'
import { assertHistoricalProjectionResolutionBinding } from './workbook-historical-resolutions.mjs'

const MAX_CATALOG_PAGES = 32
const MAX_OPERATIONS = 5_000
const failed = () => { throw new Error('WORKBOOK_PROJECTION_ROLLOUT_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every((key, index) => key === keys[index])
const identifier = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$`).test(value)
const digest = (value) => createHash('sha256').update(value).digest('hex')

class ReauthenticationPause extends Error {
  constructor(outcome) {
    super('WORKBOOK_PROJECTION_REAUTH_REQUIRED')
    this.outcome = outcome
  }
}

class HistoricalRebindPause extends Error {
  constructor(outcome) {
    super('WORKBOOK_PROJECTION_REBIND_REQUIRED')
    this.outcome = outcome
  }
}

function safeJob(value, kind) {
  if (value === null) return null
  const keys = kind === 'historical'
    ? ['id', 'importId', 'status', 'afterSourceRecordId', 'totalRecords',
      'processedRecords', 'projectedRecords', 'conflictCount', 'version', 'updatedAt',
      'completedAt']
    : ['id', 'importId', 'status', 'afterSourceRecordId', 'totalRecords',
      'processedRecords', 'projectedRecords', 'version', 'updatedAt', 'completedAt']
  if (!exact(value, keys) || !identifier(value.id, kind === 'historical' ? 'hpj' : 'apj')
    || !identifier(value.importId, 'wbi')
    || !['ready', 'running', 'conflicts', 'complete', 'failed'].includes(value.status)
    || !(value.afterSourceRecordId === null || identifier(value.afterSourceRecordId, 'wbs'))
    || !Number.isSafeInteger(value.totalRecords) || value.totalRecords < 0
    || !Number.isSafeInteger(value.processedRecords) || value.processedRecords < 0
    || value.processedRecords > value.totalRecords
    || !Number.isSafeInteger(value.projectedRecords) || value.projectedRecords < 0
    || !Number.isSafeInteger(value.version) || value.version < 1
    || (kind === 'historical'
      && (!Number.isSafeInteger(value.conflictCount) || value.conflictCount < 0))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || !(value.completedAt === null || (typeof value.completedAt === 'string'
      && Number.isFinite(Date.parse(value.completedAt))))
    || (value.status === 'complete') !== (value.completedAt !== null)) failed()
  return value
}

function checkpointJob(job, kind, resolutionCount, loaded) {
  if (job === null) return null
  return Object.freeze({
    jobId: job.id,
    status: job.status,
    totalRecords: job.totalRecords,
    processedRecords: job.processedRecords,
    projectedRecords: job.projectedRecords,
    ...(kind === 'historical' ? { conflictCount: job.conflictCount, resolutionCount } : {}),
    version: job.version,
    decisionFileSha256: loaded.fileSha256,
    decisionCount: loaded.artifact.decisionCount,
    decisionDigest: loaded.artifact.decisionDigest,
  })
}

const stableKey = (operation, loaded, facts) => `wpr_${digest(JSON.stringify([
  'workbook-projection-rollout.v1', operation, loaded.artifact.artifactId,
  loaded.artifact.importId, loaded.fileSha256, loaded.artifact.decisionDigest, ...facts,
]))}`

export async function replayWorkbookProjectionTerminalOperations({
  api, importId, loadedResolutions: loaded, result,
} = {}) {
  try {
    if (!plain(api) || typeof api.continueHistoricalProjection !== 'function'
      || typeof api.continueActivityProjection !== 'function'
      || !identifier(importId, 'wbi') || !plain(loaded) || !plain(loaded.artifact)
      || loaded.artifact.importId !== importId || !plain(result)
      || result.status !== 'ok' || !plain(result.historical) || !plain(result.activity)) failed()
    const historicalExpectedVersion = result.historical.version - 1
    const activityExpectedVersion = result.activity.version - 1
    if (!Number.isSafeInteger(historicalExpectedVersion) || historicalExpectedVersion < 0
      || !Number.isSafeInteger(activityExpectedVersion) || activityExpectedVersion < 0) failed()
    const historical = safeJob(await api.continueHistoricalProjection(Object.freeze({
      importId,
      expectedVersion: historicalExpectedVersion,
      idempotencyKey: stableKey('historical.continue', loaded, [historicalExpectedVersion]),
    })), 'historical')
    const activity = safeJob(await api.continueActivityProjection(Object.freeze({
      importId,
      expectedVersion: activityExpectedVersion,
      idempotencyKey: stableKey('activity.continue', loaded, [activityExpectedVersion]),
    })), 'activity')
    if (historical.status !== 'complete' || activity.status !== 'complete'
      || historical.id !== result.historical.jobId
      || historical.version !== result.historical.version
      || historical.totalRecords !== result.historical.totalRecords
      || historical.processedRecords !== result.historical.processedRecords
      || historical.projectedRecords !== result.historical.projectedRecords
      || historical.conflictCount !== result.historical.conflictCount
      || activity.id !== result.activity.jobId || activity.version !== result.activity.version
      || activity.totalRecords !== result.activity.totalRecords
      || activity.processedRecords !== result.activity.processedRecords
      || activity.projectedRecords !== result.activity.projectedRecords) failed()
    return Object.freeze({
      historicalVersion: historical.version,
      activityVersion: activity.version,
    })
  } catch { throw new Error('WORKBOOK_PROJECTION_ROLLOUT_FAILED') }
}

function reauthOutcome(pipeline, operation, job, resolutionCount, loaded) {
  return Object.freeze({
    status: 'reauth_required', pipeline, operation,
    decisionFileSha256: loaded.fileSha256,
    decisionCount: loaded.artifact.decisionCount,
    decisionDigest: loaded.artifact.decisionDigest,
    job: checkpointJob(job, pipeline, resolutionCount, loaded),
  })
}

function rebindOutcome(operation, job, resolutionCount, loaded) {
  return Object.freeze({
    status: 'historical_rebind_required', pipeline: 'historical', operation,
    decisionFileSha256: loaded.fileSha256,
    decisionCount: loaded.artifact.decisionCount,
    decisionDigest: loaded.artifact.decisionDigest,
    job: checkpointJob(job, 'historical', resolutionCount, loaded),
  })
}

function requireHistoricalRebind(operation, job, resolutionCount, loaded) {
  throw new HistoricalRebindPause(rebindOutcome(
    operation, job, resolutionCount, loaded,
  ))
}

async function guardedMutation({ call, pipeline, operation, job, resolutionCount, loaded }) {
  let firstError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await call() } catch (error) {
      if (error?.code === 'REAUTH_REQUIRED') throw new ReauthenticationPause(
        reauthOutcome(pipeline, operation, job, resolutionCount, loaded),
      )
      if (typeof error?.code === 'string') failed()
      firstError ??= error
    }
  }
  void firstError
  failed()
}

async function loadCatalog(api, importId) {
  const items = []
  const privateItems = []
  const profiles = []
  const cursors = new Map()
  let binding = null
  let directory = null
  let afterSourceRecordId = null
  for (let pageNumber = 0; pageNumber < MAX_CATALOG_PAGES; pageNumber += 1) {
    let privatePage = null
    const page = await api.historicalReviewCatalog({
      importId, afterSourceRecordId,
      consumeReviewPage(value) { privatePage = value },
    })
    if (!plain(page) || !plain(page.binding) || !Array.isArray(page.items)
      || !Array.isArray(page.profiles)
      || page.afterSourceRecordId !== afterSourceRecordId
      || !(page.nextAfterSourceRecordId === null
        || identifier(page.nextAfterSourceRecordId, 'wbs'))) failed()
    if (!plain(privatePage) || JSON.stringify(privatePage.binding) !== JSON.stringify(page.binding)
      || privatePage.afterSourceRecordId !== page.afterSourceRecordId
      || privatePage.nextAfterSourceRecordId !== page.nextAfterSourceRecordId
      || privatePage.directoryCount !== page.directoryCount
      || privatePage.directoryDigest !== page.directoryDigest
      || !Array.isArray(privatePage.items) || privatePage.items.length !== page.items.length
      || !Array.isArray(privatePage.profiles)
      || privatePage.profiles.length !== page.profiles.length) {
      failed()
    }
    if (binding === null) binding = page.binding
    else if (JSON.stringify(binding) !== JSON.stringify(page.binding)) failed()
    const pageDirectory = JSON.stringify({
      count: page.directoryCount, digest: page.directoryDigest,
    })
    if (directory === null) directory = pageDirectory
    else if (directory !== pageDirectory) failed()
    for (let index = 0; index < page.items.length; index += 1) {
      const item = page.items[index]
      const privateItem = privatePage.items[index]
      if (!exact(item, ['sourceRecordId', 'kind', 'conflictId', 'resolution',
        'reviewContextDigest'])
        || !identifier(item.sourceRecordId, 'wbs')
        || !['classification', 'service'].includes(item.kind)
        || !(item.conflictId === null || identifier(item.conflictId, 'hcf'))
        || !(item.resolution === null || plain(item.resolution))) failed()
      if (!plain(privateItem) || privateItem.sourceRecordId !== item.sourceRecordId
        || privateItem.kind !== item.kind || privateItem.conflictId !== item.conflictId
        || JSON.stringify(privateItem.resolution) !== JSON.stringify(item.resolution)
        || privateItem.reviewContextDigest !== item.reviewContextDigest
        || digest(JSON.stringify(privateItem.context)) !== item.reviewContextDigest) failed()
      items.push(item)
      privateItems.push(privateItem)
      cursors.set(item.sourceRecordId, afterSourceRecordId)
    }
    for (let index = 0; index < page.profiles.length; index += 1) {
      const profile = page.profiles[index]
      const privateProfile = privatePage.profiles[index]
      if (!exact(profile, ['sourceRecordId', 'reviewContextDigest'])
        || !identifier(profile.sourceRecordId, 'wbs') || !plain(privateProfile)
        || privateProfile.sourceRecordId !== profile.sourceRecordId
        || privateProfile.reviewContextDigest !== profile.reviewContextDigest
        || digest(JSON.stringify(privateProfile.context)) !== profile.reviewContextDigest) failed()
      profiles.push(privateProfile)
      cursors.set(profile.sourceRecordId, afterSourceRecordId)
    }
    if (page.nextAfterSourceRecordId === null) return {
      binding, items, privateItems, profiles, cursors,
    }
    if (page.nextAfterSourceRecordId === afterSourceRecordId) failed()
    afterSourceRecordId = page.nextAfterSourceRecordId
  }
  failed()
}

async function refreshCatalogSource(api, importId, catalog, sourceRecordId) {
  const afterSourceRecordId = catalog.cursors.get(sourceRecordId)
  if (afterSourceRecordId === undefined) return null
  let privatePage = null
  const page = await api.historicalReviewCatalog({
    importId, afterSourceRecordId,
    consumeReviewPage(value) { privatePage = value },
  })
  if (!plain(page) || !plain(privatePage)
    || JSON.stringify(page.binding) !== JSON.stringify(catalog.binding)
    || page.afterSourceRecordId !== afterSourceRecordId
    || privatePage.afterSourceRecordId !== afterSourceRecordId
    || page.directoryCount !== privatePage.directoryCount
    || page.directoryDigest !== privatePage.directoryDigest
    || !Array.isArray(page.items) || !Array.isArray(privatePage.items)
    || !Array.isArray(page.profiles) || !Array.isArray(privatePage.profiles)) failed()
  const itemIndex = page.items.findIndex((item) => item.sourceRecordId === sourceRecordId)
  if (itemIndex >= 0) {
    const item = page.items[itemIndex]
    const transient = privatePage.items[itemIndex]
    if (!transient || transient.sourceRecordId !== sourceRecordId
      || transient.reviewContextDigest !== item.reviewContextDigest
      || digest(JSON.stringify(transient.context)) !== item.reviewContextDigest) failed()
    return Object.freeze({
      item: transient, directoryCount: page.directoryCount,
      directoryDigest: page.directoryDigest,
    })
  }
  const profileIndex = page.profiles.findIndex(
    (profile) => profile.sourceRecordId === sourceRecordId,
  )
  if (profileIndex < 0) failed()
  const profile = privatePage.profiles[profileIndex]
  if (!profile || digest(JSON.stringify(profile.context)) !== profile.reviewContextDigest) failed()
  return Object.freeze({
    profile, directoryCount: page.directoryCount, directoryDigest: page.directoryDigest,
  })
}

async function loadHistoricalState(api, importId) {
  let privateState = null
  const state = await api.historicalProjection(importId, {
    consumeConflictReview(value) { privateState = value },
  })
  if (!plain(state) || !Array.isArray(state.conflicts) || !plain(privateState)
    || JSON.stringify(privateState.projection) !== JSON.stringify(state.projection)
    || !Array.isArray(privateState.conflicts)
    || privateState.conflicts.length !== state.conflicts.length) failed()
  for (let index = 0; index < state.conflicts.length; index += 1) {
    const redacted = state.conflicts[index]
    const transient = privateState.conflicts[index]
    if (!plain(transient) || transient.conflictId !== redacted.conflictId
      || transient.sourceRecordId !== redacted.sourceRecordId
      || transient.kind !== redacted.kind || !plain(transient.context)) failed()
  }
  return { ...state, privateConflicts: privateState.conflicts }
}

function resolutionMatches(decision, resolution) {
  return plain(resolution)
    && resolution.classification === decision.classification
    && resolution.existingSubjectId === decision.existingSubjectId
    && resolution.serviceId === decision.serviceId
    && Reflect.ownKeys(resolution).length === 3
}

export async function runWorkbookProjectionRollout({
  api, importId, loadedResolutions, checkpoint = async () => {},
  approvalMode = 'rebind', approvalAlreadyValidated = false,
  validatedApproval = null,
  onApprovalValidated = async () => {},
} = {}) {
  try {
    const methods = [
      'historicalReviewCatalog', 'historicalProjection',
      'continueHistoricalProjection', 'resolveHistoricalProjection',
      'activityProjection', 'continueActivityProjection',
    ]
    if (!plain(api) || methods.some((name) => typeof api[name] !== 'function')
      || !identifier(importId, 'wbi') || typeof checkpoint !== 'function'
      || !['initial', 'rebind'].includes(approvalMode)
      || typeof approvalAlreadyValidated !== 'boolean'
      || !(validatedApproval === null || plain(validatedApproval))
      || typeof onApprovalValidated !== 'function') failed()
    const loaded = loadedResolutions
    const catalog = await loadCatalog(api, importId)
    assertHistoricalProjectionResolutionBinding({
      loaded,
      binding: catalog.binding,
      catalog: catalog.items.map(({ sourceRecordId, kind }) => ({ sourceRecordId, kind })),
    })
    const proposal = buildHistoricalProjectionReviewGroups({
      binding: catalog.binding,
      items: catalog.privateItems.map((item) => ({
        sourceRecordId: item.sourceRecordId, kind: item.kind,
        conflictId: item.conflictId, resolution: null, context: item.context,
      })),
      profiles: catalog.profiles.map(({ sourceRecordId, context }) => ({
        sourceRecordId, context,
      })),
    })
    const approvedContexts = new Map()
    for (const group of proposal.groups) {
      for (let index = 0; index < group.sourceRecordIds.length; index += 1) {
        approvedContexts.set(group.sourceRecordIds[index], Object.freeze({
          digest: group.memberContextDigests[index],
          subjectSensitive: group.subjectSensitive,
          profileDigest: proposal.profileDigest,
        }))
      }
    }
    if (loaded.artifact.importId !== importId) failed()
    const decisions = new Map(loaded.artifact.decisions.map((decision) => [
      decision.sourceRecordId, decision,
    ]))
    if ([...decisions.values()].some(({ classification }) => classification === 'exclude')) {
      failed()
    }
    const resolved = new Set()
    for (const item of catalog.items) {
      if (item.resolution === null) continue
      const decision = decisions.get(item.sourceRecordId)
      if (item.conflictId === null || !decision || !resolutionMatches(decision, item.resolution)) {
        failed()
      }
      resolved.add(item.sourceRecordId)
    }
    for (const decision of decisions.values()) {
      if (!resolved.has(decision.sourceRecordId)
        && approvedContexts.get(decision.sourceRecordId)?.digest
          !== decision.reviewContextDigest) {
        requireHistoricalRebind('catalog', null, resolved.size, loaded)
      }
    }
    const approval = Object.freeze({
      approvalMode,
      groupCount: proposal.groupCount,
      catalogDigest: proposal.catalogDigest,
      groupDigest: proposal.groupDigest,
    })
    if (resolved.size === 0) {
      if (approvalMode === 'initial') {
        assertApprovedInitialHistoricalProjectionReviewProposal(proposal)
      }
      assertHistoricalProjectionResolutionArtifactForProposal({ proposal, loaded })
      if (approvalAlreadyValidated && (!exact(validatedApproval, [
        'approvalMode', 'groupCount', 'catalogDigest', 'groupDigest',
      ]) || JSON.stringify(validatedApproval) !== JSON.stringify(approval))) failed()
    } else {
      try {
        assertHistoricalProjectionResolutionArtifactForResolvedProposal({
          proposal,
          loaded,
          resolvedSourceRecordIds: [...resolved].sort(),
        })
      } catch {
        if (approvalAlreadyValidated) {
          requireHistoricalRebind('catalog', null, resolved.size, loaded)
        }
        failed()
      }
      if (approvalAlreadyValidated && (!exact(validatedApproval, [
        'approvalMode', 'groupCount', 'catalogDigest', 'groupDigest',
      ]) || validatedApproval.approvalMode !== approvalMode)) failed()
    }
    if (!approvalAlreadyValidated) {
      await onApprovalValidated(Object.freeze({
        ...approval,
      }))
    }

    let historicalState = await loadHistoricalState(api, importId)
    if (!plain(historicalState) || !Array.isArray(historicalState.conflicts)) failed()
    let historical = safeJob(historicalState.projection, 'historical')
    let operationCount = 0
    while (historical?.status !== 'complete') {
      operationCount += 1
      if (operationCount > MAX_OPERATIONS || historical?.status === 'failed') failed()
      const conflicts = historicalState.conflicts
      if (conflicts.length > 0) {
        if (historical === null || historical.status !== 'conflicts' || conflicts.length !== 1) {
          failed()
        }
        const conflict = conflicts[0]
        if (!exact(conflict, ['conflictId', 'sourceRecordId', 'kind'])
          || !identifier(conflict.conflictId, 'hcf')
          || !identifier(conflict.sourceRecordId, 'wbs')
          || !['classification', 'service', 'near_match'].includes(conflict.kind)) failed()
        const decision = decisions.get(conflict.sourceRecordId)
        if (!decision) {
          requireHistoricalRebind('resolve', historical, resolved.size, loaded)
        }
        if (resolved.has(conflict.sourceRecordId)) failed()
        if (conflict.kind === 'near_match' || decision.kind !== conflict.kind) {
          requireHistoricalRebind('resolve', historical, resolved.size, loaded)
        }
        const fresh = await refreshCatalogSource(
          api, importId, catalog, conflict.sourceRecordId,
        )
        if (!fresh?.item || fresh.item.kind !== decision.kind) {
          requireHistoricalRebind('resolve', historical, resolved.size, loaded)
        }
        const approvedContext = approvedContexts.get(conflict.sourceRecordId)
        if (!approvedContext || digest(JSON.stringify({
          context: fresh.item.context,
          subjectSensitive: approvedContext.subjectSensitive,
          profileDigest: approvedContext.profileDigest,
        })) !== decision.reviewContextDigest) {
          requireHistoricalRebind('resolve', historical, resolved.size, loaded)
        }
        const input = Object.freeze({
          importId,
          expectedJobVersion: historical.version,
          conflictId: conflict.conflictId,
          classification: decision.classification,
          existingSubjectId: decision.existingSubjectId,
          serviceId: decision.serviceId,
          reviewContextDigest: fresh.item.reviewContextDigest,
          directoryCount: fresh.directoryCount,
          directoryDigest: fresh.directoryDigest,
          idempotencyKey: stableKey('historical.resolve', loaded, [
            conflict.sourceRecordId, conflict.conflictId, conflict.kind, historical.version,
            fresh.item.reviewContextDigest, fresh.directoryCount, fresh.directoryDigest,
          ]),
        })
        const advanced = safeJob(await guardedMutation({
          call: () => api.resolveHistoricalProjection(input), pipeline: 'historical',
          operation: 'resolve', job: historical, resolutionCount: resolved.size, loaded,
        }), 'historical')
        if (advanced.importId !== importId || advanced.id !== historical.id
          || advanced.version !== historical.version + 1 || advanced.status !== 'running') failed()
        resolved.add(conflict.sourceRecordId)
        historical = advanced
        historicalState = { projection: historical, conflicts: [], privateConflicts: [] }
      } else {
        if (historical?.status === 'conflicts') failed()
        const expectedVersion = historical?.version ?? 0
        const input = Object.freeze({
          importId, expectedVersion,
          idempotencyKey: stableKey('historical.continue', loaded, [expectedVersion]),
        })
        const advanced = safeJob(await guardedMutation({
          call: () => api.continueHistoricalProjection(input), pipeline: 'historical',
          operation: 'continue', job: historical, resolutionCount: resolved.size, loaded,
        }), 'historical')
        if (advanced.importId !== importId || advanced.version !== expectedVersion + 1
          || (historical !== null && advanced.id !== historical.id)) failed()
        historical = advanced
        historicalState = await loadHistoricalState(api, importId)
        if (!plain(historicalState) || !Array.isArray(historicalState.conflicts)) failed()
        const observed = safeJob(historicalState.projection, 'historical')
        if (observed === null || observed.id !== historical.id
          || observed.version !== historical.version) failed()
        historical = observed
      }
      await checkpoint(checkpointJob(historical, 'historical', resolved.size, loaded))
    }
    if (historical.totalRecords !== 2_000 || historical.processedRecords !== 2_000
      || historical.projectedRecords !== 1_997
      || historical.conflictCount !== 1_992 || resolved.size !== 1_992
      || historicalState.conflicts.length !== 0) failed()
    await checkpoint(checkpointJob(historical, 'historical', resolved.size, loaded))

    let activity = safeJob(await api.activityProjection(importId), 'activity')
    while (activity?.status !== 'complete') {
      operationCount += 1
      if (operationCount > MAX_OPERATIONS || activity?.status === 'failed'
        || activity?.status === 'conflicts') failed()
      const expectedVersion = activity?.version ?? 0
      const input = Object.freeze({
        importId, expectedVersion,
        idempotencyKey: stableKey('activity.continue', loaded, [expectedVersion]),
      })
      const advanced = safeJob(await guardedMutation({
        call: () => api.continueActivityProjection(input), pipeline: 'activity',
        operation: 'continue', job: activity, resolutionCount: resolved.size, loaded,
      }), 'activity')
      if (advanced.importId !== importId || advanced.version !== expectedVersion + 1
        || (activity !== null && advanced.id !== activity.id)) failed()
      activity = advanced
      await checkpoint(checkpointJob(activity, 'activity', resolved.size, loaded))
    }
    if (activity.totalRecords !== 190 || activity.processedRecords !== 190
      || activity.projectedRecords !== 190) failed()
    await checkpoint(checkpointJob(activity, 'activity', resolved.size, loaded))

    return Object.freeze({
      status: 'ok',
      decisionFileSha256: loaded.fileSha256,
      decisionCount: loaded.artifact.decisionCount,
      decisionDigest: loaded.artifact.decisionDigest,
      historical: Object.freeze({
        jobId: historical.id, totalRecords: historical.totalRecords,
        processedRecords: historical.processedRecords,
        projectedRecords: historical.projectedRecords,
        conflictCount: historical.conflictCount, version: historical.version,
        resolutionCount: resolved.size,
      }),
      activity: Object.freeze({
        jobId: activity.id, totalRecords: activity.totalRecords,
        processedRecords: activity.processedRecords,
        projectedRecords: activity.projectedRecords, version: activity.version,
      }),
    })
  } catch (error) {
    if (error instanceof ReauthenticationPause || error instanceof HistoricalRebindPause) {
      return error.outcome
    }
    throw new Error('WORKBOOK_PROJECTION_ROLLOUT_FAILED')
  }
}
