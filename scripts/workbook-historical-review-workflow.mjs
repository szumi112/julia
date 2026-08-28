import {
  assertApprovedInitialHistoricalProjectionReviewProposal,
  buildHistoricalProjectionReviewGroups,
  compileHistoricalProjectionReboundArtifact,
  compileHistoricalProjectionResolutionArtifact,
  historicalProjectionRebindSummary,
} from './workbook-historical-review-groups.mjs'
import { readHistoricalProjectionResolutions } from './workbook-historical-resolutions.mjs'
import {
  readPrivateHistoricalReviewJson,
  writePrivateHistoricalReviewJson,
} from './workbook-historical-review-private.mjs'

const refused = () => { throw new Error('WORKBOOK_HISTORICAL_REVIEW_WORKFLOW_REFUSED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const sourceId = (value) => typeof value === 'string'
  && /^wbs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(value)

export async function collectHistoricalProjectionReviewGroups({ api, importId } = {}) {
  try {
    if (!plain(api) || typeof api.historicalReviewCatalog !== 'function'
      || typeof importId !== 'string'
      || !/^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(importId)) refused()
    let afterSourceRecordId = null
    let binding = null
    let directory = null
    const items = []
    const profiles = []
    for (let pageNumber = 0; pageNumber < 32; pageNumber += 1) {
      let privatePage = null
      const publicPage = await api.historicalReviewCatalog({
        importId, afterSourceRecordId,
        consumeReviewPage(value) { privatePage = value },
      })
      if (!plain(publicPage) || !plain(privatePage)
        || publicPage.afterSourceRecordId !== afterSourceRecordId
        || privatePage.afterSourceRecordId !== afterSourceRecordId
        || publicPage.nextAfterSourceRecordId !== privatePage.nextAfterSourceRecordId
        || publicPage.directoryCount !== privatePage.directoryCount
        || publicPage.directoryDigest !== privatePage.directoryDigest
        || JSON.stringify(publicPage.binding) !== JSON.stringify(privatePage.binding)
        || !Array.isArray(publicPage.items) || !Array.isArray(privatePage.items)
        || publicPage.items.length !== privatePage.items.length
        || !Array.isArray(publicPage.profiles) || !Array.isArray(privatePage.profiles)
        || publicPage.profiles.length !== privatePage.profiles.length) refused()
      if (binding === null) binding = privatePage.binding
      else if (JSON.stringify(binding) !== JSON.stringify(privatePage.binding)) refused()
      const pageDirectory = JSON.stringify({
        count: privatePage.directoryCount, digest: privatePage.directoryDigest,
      })
      if (directory === null) directory = pageDirectory
      else if (directory !== pageDirectory) refused()
      for (let index = 0; index < privatePage.items.length; index += 1) {
        const redacted = publicPage.items[index]
        const transient = privatePage.items[index]
        if (!plain(redacted) || !plain(transient)
          || redacted.sourceRecordId !== transient.sourceRecordId
          || redacted.kind !== transient.kind || redacted.conflictId !== transient.conflictId
          || JSON.stringify(redacted.resolution) !== JSON.stringify(transient.resolution)
          || redacted.reviewContextDigest !== transient.reviewContextDigest
          || !plain(transient.context)) refused()
        items.push({
          sourceRecordId: transient.sourceRecordId, kind: transient.kind,
          conflictId: transient.conflictId, resolution: null, context: transient.context,
        })
      }
      for (let index = 0; index < privatePage.profiles.length; index += 1) {
        const redacted = publicPage.profiles[index]
        const transient = privatePage.profiles[index]
        if (!plain(redacted) || !plain(transient)
          || redacted.sourceRecordId !== transient.sourceRecordId
          || redacted.reviewContextDigest !== transient.reviewContextDigest
          || !plain(transient.context)) refused()
        profiles.push({
          sourceRecordId: transient.sourceRecordId, context: transient.context,
        })
      }
      if (publicPage.nextAfterSourceRecordId === null) {
        return buildHistoricalProjectionReviewGroups({ binding, items, profiles })
      }
      if (!sourceId(publicPage.nextAfterSourceRecordId)
        || publicPage.nextAfterSourceRecordId === afterSourceRecordId) refused()
      afterSourceRecordId = publicPage.nextAfterSourceRecordId
    }
    refused()
  } catch { refused() }
}

export async function persistHistoricalProjectionReviewGroups({ api, importId, path } = {}) {
  try {
    const proposal = await collectHistoricalProjectionReviewGroups({ api, importId })
    assertApprovedInitialHistoricalProjectionReviewProposal(proposal)
    await writePrivateHistoricalReviewJson(path, proposal)
    return Object.freeze({
      status: 'proposal_ready', decisionCount: proposal.catalogCount,
      groupCount: proposal.groupCount, catalogDigest: proposal.catalogDigest,
      groupDigest: proposal.groupDigest,
    })
  } catch { refused() }
}

export async function compilePrivateHistoricalProjectionResolutions({
  proposalPath, approvalsPath, resolutionsPath,
} = {}) {
  try {
    const proposal = await readPrivateHistoricalReviewJson(proposalPath)
    assertApprovedInitialHistoricalProjectionReviewProposal(proposal)
    const approvals = await readPrivateHistoricalReviewJson(approvalsPath)
    const artifact = compileHistoricalProjectionResolutionArtifact({ proposal, approvals })
    await writePrivateHistoricalReviewJson(resolutionsPath, artifact)
    return Object.freeze({
      status: 'resolutions_ready', decisionCount: artifact.decisionCount,
      decisionDigest: artifact.decisionDigest,
    })
  } catch { refused() }
}

export async function persistHistoricalProjectionRebindGroups({
  api, importId, previousResolutionsPath, path,
} = {}) {
  try {
    const previous = await readHistoricalProjectionResolutions(previousResolutionsPath)
    const proposal = await collectHistoricalProjectionReviewGroups({ api, importId })
    const summary = historicalProjectionRebindSummary({ proposal, previous })
    await writePrivateHistoricalReviewJson(path, proposal)
    return Object.freeze({ status: 'rebind_proposal_ready', ...summary })
  } catch { refused() }
}

export async function compilePrivateHistoricalProjectionReboundResolutions({
  proposalPath, previousResolutionsPath, approvalsPath, resolutionsPath,
} = {}) {
  try {
    const proposal = await readPrivateHistoricalReviewJson(proposalPath)
    const previous = await readHistoricalProjectionResolutions(previousResolutionsPath)
    const approvals = await readPrivateHistoricalReviewJson(approvalsPath)
    const artifact = compileHistoricalProjectionReboundArtifact({
      proposal, previous, approvals,
    })
    await writePrivateHistoricalReviewJson(resolutionsPath, artifact)
    return Object.freeze({
      status: 'rebound_resolutions_ready', decisionCount: artifact.decisionCount,
      decisionDigest: artifact.decisionDigest,
    })
  } catch { refused() }
}
