import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createWorkbookRolloutJournal,
  validateWorkbookRolloutJournal,
} from '../../scripts/workbook-rollout-journal.mjs'
import { runResumableStagingWorkbookRollout } from '../../scripts/workbook-rollout-resume.mjs'

const FINGERPRINT = 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a'
const CREATOR_ID = 'stf_rollout_owner'
const IMPORT_ID = 'wbi_safe_rollout'
const ARTIFACT_ID = 'wba_safe_rollout'
const PLAN_DIGEST = `v1_${'P'.repeat(43)}`
const PREVIEW_TOKEN = 'preview-token-must-remain-in-memory'
const CONFLICT_ID = 'wmc_conflict-must-remain-in-memory'
const SPECIALIST_ID = 'sp_resolution-must-remain-in-memory'
const RESOLUTIONS = Object.freeze([{ conflictId: CONFLICT_ID, specialistId: SPECIALIST_ID }])

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
  schema: 'workbook_rollout_journal.v2', environment: 'staging',
  fingerprint: FINGERPRINT, creatorId: CREATOR_ID, phase: 'initialized',
  importIdentity: null, result: null,
})
const imported = Object.freeze({
  ...initialized, phase: 'import_confirmed',
  importIdentity: Object.freeze({ importId: IMPORT_ID, artifactId: ARTIFACT_ID }),
})
const complete = Object.freeze({ ...imported, phase: 'complete', result: terminalResult })

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
  return { ...reconciliation, replayCreatedRecords: 0, replayVoidedRecords: 0 }
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
    journal, api, workbook: { buffer: Buffer.from('fictional workbook') },
    approvedFingerprint: FINGERPRINT, creatorId: CREATOR_ID,
    resolutions: RESOLUTIONS, expectedReconciliation: reconciliation,
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
      runResumableStagingWorkbookRollout(runInput(observed.journal, api)),
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
    const commitInputs = []
    const api = {
      async operatorEvidence() { return evidence },
      async preview() { previewCalls += 1; return preview() },
      async discoverImport({ fingerprint, creatorId }) {
        assert.equal(fingerprint, FINGERPRINT)
        assert.equal(creatorId, CREATOR_ID)
        return invocation === 2 && committed
          ? { importId: IMPORT_ID, artifactId: ARTIFACT_ID }
          : null
      },
      async commit(input) {
        commitInputs.push(structuredClone({
          previewToken: input.previewToken,
          resolutions: input.resolutions,
          idempotencyKey: input.idempotencyKey,
        }))
        committed = true
        throw new Error('response lost after commit')
      },
      async status() { return terminalState },
      async continue() { throw new Error('must not continue terminal import') },
      async artifactVerification() { return artifactVerification() },
      async reconciliation() { return reconciled() },
    }

    await assert.rejects(
      runResumableStagingWorkbookRollout(runInput(observed.journal, api)),
      /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/,
    )
    assert.equal(commitInputs.length, 2)
    assert.deepEqual(commitInputs[0], commitInputs[1])
    assert.deepEqual(await observed.journal.load(), initialized)

    invocation = 2
    const result = await runResumableStagingWorkbookRollout(runInput(observed.journal, api))
    assert.deepEqual(result, terminalResult)
    assert.equal(previewCalls, 2)
    assert.equal(commitInputs.length, 2)
    assert.deepEqual(await observed.journal.load(), complete)
    await observed.inspect()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('confirmed import resumes with ephemeral continuation keys and reconciles an ambiguous outcome after restart', async () => {
  const root = await privateRoot('bwm-safe-journal-continue-')
  const path = join(root, 'resume.json')
  try {
    const observed = await observedJournal(path, [
      PREVIEW_TOKEN, PLAN_DIGEST, CONFLICT_ID, SPECIALIST_ID,
      'rollout-continue-123e4567-e89b-42d3-a456-426614174000-1',
    ])
    await observed.journal.save(imported)
    let invocation = 1
    let materialized = false
    const continuationInputs = []
    const api = {
      async operatorEvidence() { return evidence },
      async preview() { throw new Error('confirmed import must not preview') },
      async discoverImport() { throw new Error('confirmed import must not discover') },
      async commit() { throw new Error('confirmed import must not commit') },
      async status() {
        if (invocation === 1 && materialized) throw new Error('status response lost')
        return materialized ? terminalState : {
          ...terminalState, status: 'materializing', version: 1,
          createdRecords: 0, converged: false,
        }
      },
      async continue(input) {
        continuationInputs.push(structuredClone(input))
        materialized = true
        throw new Error('continuation response lost')
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
    assert.deepEqual(await observed.journal.load(), imported)

    invocation = 2
    assert.deepEqual(
      await runResumableStagingWorkbookRollout(runInput(observed.journal, api)),
      terminalResult,
    )
    assert.deepEqual(await observed.journal.load(), complete)
    await observed.inspect()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('one process replays exact commit and continuation operations with zero delta, then revalidates terminal state without credentials', async () => {
  let statusState = null
  const commitInputs = []
  const continuationInputs = []
  const api = {
    async operatorEvidence() { return evidence },
    async preview() { return preview() },
    async discoverImport() { return null },
    async commit(input) {
      commitInputs.push(input)
      statusState ??= {
        ...terminalState, status: 'materializing', version: 1,
        createdRecords: 0, converged: false,
      }
      return statusState
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

  assert.deepEqual(await runResumableStagingWorkbookRollout(runInput(journal, api)), terminalResult)
  assert.equal(commitInputs.length, 2)
  assert.deepEqual(commitInputs[0], commitInputs[1])
  assert.equal(continuationInputs.length, 2)
  assert.deepEqual(continuationInputs[0], continuationInputs[1])
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

test('same-process commit discovery still exact-replays the uncertain in-memory operation', async () => {
  let committed = false
  const commitInputs = []
  const api = {
    async operatorEvidence() { return evidence },
    async preview() { return preview() },
    async discoverImport() {
      return committed ? { importId: IMPORT_ID, artifactId: ARTIFACT_ID } : null
    },
    async commit(input) {
      commitInputs.push(input)
      committed = true
      if (commitInputs.length <= 2) throw new Error('commit response lost')
      return terminalState
    },
    async status() { return terminalState },
    async continue() { throw new Error('terminal import must not continue') },
    async artifactVerification() { return artifactVerification() },
    async reconciliation() { return reconciled() },
  }
  let saved = null
  const journal = {
    async load() { return saved === null ? null : structuredClone(saved) },
    async save(value) { saved = structuredClone(value) },
  }

  assert.deepEqual(await runResumableStagingWorkbookRollout(runInput(journal, api)), terminalResult)
  assert.equal(commitInputs.length, 3)
  assert.deepEqual(commitInputs[0], commitInputs[1])
  assert.deepEqual(commitInputs[1], commitInputs[2])
  assert.deepEqual(saved, complete)
})

test('same-process continuation status reconciliation exact-replays its ephemeral key', async () => {
  const materializing = {
    ...terminalState, status: 'materializing', version: 1,
    createdRecords: 0, converged: false,
  }
  let materialized = false
  const commitInputs = []
  const continuationInputs = []
  const api = {
    async operatorEvidence() { return evidence },
    async preview() { return preview() },
    async discoverImport() { return null },
    async commit(input) { commitInputs.push(input); return materializing },
    async status() { return materialized ? terminalState : materializing },
    async continue(input) {
      continuationInputs.push(input)
      materialized = true
      if (continuationInputs.length <= 2) throw new Error('continuation response lost')
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

  assert.deepEqual(await runResumableStagingWorkbookRollout(runInput(journal, api)), terminalResult)
  assert.equal(commitInputs.length, 2)
  assert.deepEqual(commitInputs[0], commitInputs[1])
  assert.equal(continuationInputs.length, 3)
  assert.deepEqual(continuationInputs[0], continuationInputs[1])
  assert.deepEqual(continuationInputs[1], continuationInputs[2])
  assert.deepEqual(saved, complete)
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
})
