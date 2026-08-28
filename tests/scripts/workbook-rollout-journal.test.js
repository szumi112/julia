import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { createWorkbookRolloutJournal } from '../../scripts/workbook-rollout-journal.mjs'
import { runResumableStagingWorkbookRollout } from '../../scripts/workbook-rollout-resume.mjs'
import { WorkbookRolloutHttpError } from '../../scripts/workbook-rollout-staging-http.mjs'

const initial = Object.freeze({
  schema: 'workbook_rollout_journal.v1',
  environment: 'staging',
  fingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
  rolloutIdentity: '123e4567-e89b-42d3-a456-426614174000',
  commitIdempotencyKey: 'rollout-commit-123e4567-e89b-42d3-a456-426614174000',
  rolloutRequest: {
    workbookFingerprint: 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a',
    resolutions: [],
  },
  phase: 'initialized',
  preview: null,
  previewRecordedAtMs: null,
  pendingOperation: null,
  commitOperation: null,
  importIdentity: null,
  continuations: [],
  result: null,
})
const PLAN_DIGEST = `v1_${'A'.repeat(43)}`
const previewMetadata = Object.freeze({
  parserVersion: 2, materializerVersion: 2,
  planDigest: PLAN_DIGEST, workbookKind: 'legacy',
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
const terminalResult = Object.freeze({
  artifactId: 'wba_terminal_one', importId: 'wbi_terminal_one',
  acceptedCount: 2232, quarantinedCount: 3, previewWritesZero: true,
  terminalComplete: true, artifactVerified: true, reconciliationMatched: true,
  replayIdentityMatch: true, replayWritesZero: true, status: 'ok',
})
const terminalState = Object.freeze({
  importId: terminalResult.importId, artifactId: terminalResult.artifactId,
  status: 'complete', version: 7, createdRecords: 2232,
  voidedRecords: 0, converged: true,
})

function completedJournal(result = terminalResult) {
  return {
    ...initial,
    phase: 'complete',
    preview: {
      fingerprint: initial.fingerprint, previewToken: 'private-terminal-token', conflictIds: [],
      ...previewMetadata,
    },
    previewRecordedAtMs: 1,
    commitOperation: {
      kind: 'commit', idempotencyKey: initial.commitIdempotencyKey,
      body: {
        workbookFingerprint: initial.fingerprint,
        previewToken: 'private-terminal-token', planDigest: PLAN_DIGEST, resolutions: [],
      },
      response: terminalState,
    },
    importIdentity: {
      importId: result.importId, artifactId: result.artifactId,
    },
    result,
  }
}

function terminalApi({
  status = {}, artifact = {}, reconciled = {}, calls = [],
} = {}) {
  return {
    async operatorEvidence() {
      calls.push(['operatorEvidence'])
      return evidence
    },
    async commit(input) {
      calls.push(['commit', input.idempotencyKey])
      return terminalState
    },
    async continue() { throw new Error('unexpected continuation') },
    async status(importId) {
      calls.push(['status', importId])
      return {
        importId: 'wbi_terminal_one', artifactId: 'wba_terminal_one',
        status: 'complete', version: 7, createdRecords: 2232,
        voidedRecords: 0, converged: true, ...status,
      }
    },
    async artifactVerification(importId) {
      calls.push(['artifactVerification', importId])
      return {
        artifactId: 'wba_terminal_one', centreMatch: true,
        ciphertextMetadataValid: true, digestMatch: true, environmentMatch: true,
        keyVersionsMatch: true, opaqueObjectKey: true,
        readbackDigestMatch: true, sizeMatch: true, ...artifact,
      }
    },
    async reconciliation(importId) {
      calls.push(['reconciliation', importId])
      return {
        ...reconciliation, replayCreatedRecords: 0, replayVoidedRecords: 0,
        ...reconciled,
      }
    },
  }
}

test('lost commit response resumes with the exact journaled key/body and no second preview', async () => {
  let saved = null
  const journal = {
    async load() { return saved === null ? null : structuredClone(saved) },
    async save(value) { saved = structuredClone(value) },
  }
  let previewCalls = 0
  let loseCommit = true
  const committedInputs = []
  let continuationCalls = 0
  const api = {
    async operatorEvidence() { return evidence },
    async preview() {
      previewCalls += 1
      return {
        fingerprint: initial.fingerprint,
        previewToken: 'private-token',
        conflictIds: ['wmc_resume_one'],
        ...previewMetadata,
      }
    },
    async commit(input) {
      committedInputs.push({
        key: input.idempotencyKey,
        previewToken: input.previewToken,
        resolutions: structuredClone(input.resolutions),
      })
      if (loseCommit) { loseCommit = false; throw new Error('lost response after write') }
      return {
        importId: 'wbi_resume_one', artifactId: 'wba_resume_one', status: 'ready',
        version: 1, createdRecords: 0, voidedRecords: 0, converged: false,
      }
    },
    async status() {
      return {
        importId: 'wbi_resume_one', artifactId: 'wba_resume_one',
        status: 'materializing', version: 2,
        createdRecords: 0, voidedRecords: 0, converged: false,
      }
    },
    async continue() {
      continuationCalls += 1
      return {
        importId: 'wbi_resume_one', artifactId: 'wba_resume_one', status: 'complete',
        version: 3, createdRecords: 2232, voidedRecords: 0, converged: true,
      }
    },
    async artifactVerification() {
      return {
        artifactId: 'wba_resume_one', centreMatch: true, ciphertextMetadataValid: true,
        digestMatch: true, environmentMatch: true, keyVersionsMatch: true,
        opaqueObjectKey: true, readbackDigestMatch: true, sizeMatch: true,
      }
    },
    async reconciliation() {
      return { ...reconciliation, replayCreatedRecords: 0, replayVoidedRecords: 0 }
    },
  }
  const input = {
    journal, api, workbook: { buffer: Buffer.from('fictional') },
    approvedFingerprint: initial.fingerprint,
    resolutions: [{ conflictId: 'wmc_resume_one', specialistId: 'sp_resume_one' }],
    expectedReconciliation: reconciliation,
    identityFactory: () => initial.rolloutIdentity,
  }
  await assert.rejects(runResumableStagingWorkbookRollout(input),
    /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  assert.equal(saved.phase, 'commit_pending')
  assert.equal(saved.pendingOperation.kind, 'commit')
  const result = await runResumableStagingWorkbookRollout(input)
  assert.equal(result.status, 'ok')
  assert.equal(previewCalls, 1)
  assert.equal(continuationCalls, 2)
  assert.deepEqual(committedInputs[0], committedInputs[1])
  assert.deepEqual(committedInputs[1], committedInputs[2])
  assert.equal(saved.phase, 'complete')
})

test('lost continuation response replays the pending old key/body before current-version progression', async () => {
  let saved = null
  const journal = {
    async load() { return saved === null ? null : structuredClone(saved) },
    async save(value) { saved = structuredClone(value) },
  }
  let previewCalls = 0
  let loseContinuation = true
  const continuationInputs = []
  const api = {
    async operatorEvidence() { return evidence },
    async preview() {
      previewCalls += 1
      return {
        fingerprint: initial.fingerprint, previewToken: 'private-token', conflictIds: [],
        ...previewMetadata,
      }
    },
    async commit() {
      return {
        importId: 'wbi_resume_continue', artifactId: 'wba_resume_continue', status: 'ready',
        version: 1, createdRecords: 0, voidedRecords: 0, converged: false,
      }
    },
    async status() {
      if (!loseContinuation) {
        return {
          importId: 'wbi_resume_continue', artifactId: 'wba_resume_continue', status: 'complete',
          version: 3, createdRecords: 2232, voidedRecords: 0, converged: true,
        }
      }
      return {
        importId: 'wbi_resume_continue', artifactId: 'wba_resume_continue',
        status: 'materializing', version: 2,
        createdRecords: 0, voidedRecords: 0, converged: false,
      }
    },
    async continue(input) {
      continuationInputs.push(structuredClone(input))
      if (loseContinuation) {
        loseContinuation = false
        throw new Error('lost response after continuation write')
      }
      return {
        importId: 'wbi_resume_continue', artifactId: 'wba_resume_continue', status: 'complete',
        version: 3, createdRecords: 2232, voidedRecords: 0, converged: true,
      }
    },
    async artifactVerification() {
      return {
        artifactId: 'wba_resume_continue', centreMatch: true,
        ciphertextMetadataValid: true, digestMatch: true, environmentMatch: true,
        keyVersionsMatch: true, opaqueObjectKey: true,
        readbackDigestMatch: true, sizeMatch: true,
      }
    },
    async reconciliation() {
      return { ...reconciliation, replayCreatedRecords: 0, replayVoidedRecords: 0 }
    },
  }
  const input = {
    journal, api, workbook: { buffer: Buffer.from('fictional') },
    approvedFingerprint: initial.fingerprint, resolutions: [],
    expectedReconciliation: reconciliation, identityFactory: () => initial.rolloutIdentity,
  }
  await assert.rejects(runResumableStagingWorkbookRollout(input),
    /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  assert.equal(saved.phase, 'continue_pending')
  assert.deepEqual(saved.pendingOperation, {
    kind: 'continue',
    idempotencyKey: `rollout-continue-${initial.rolloutIdentity}-1`,
    body: { importId: 'wbi_resume_continue', expectedVersion: 2 },
  })
  assert.equal((await runResumableStagingWorkbookRollout(input)).status, 'ok')
  assert.equal(previewCalls, 1)
  assert.equal(continuationInputs.length, 3)
  assert.deepEqual(continuationInputs[0], continuationInputs[1])
  assert.deepEqual(continuationInputs[1], continuationInputs[2])
})

test('completed journal refuses changed resolutions and corrupt terminal success', async () => {
  const complete = completedJournal()
  const journal = {
    async load() { return structuredClone(complete) },
    async save() { throw new Error('must not save') },
  }
  await assert.rejects(runResumableStagingWorkbookRollout({
    journal, api: {}, workbook: {}, approvedFingerprint: initial.fingerprint,
    resolutions: [{ conflictId: 'wmc_changed', specialistId: 'sp_changed' }],
    expectedReconciliation: reconciliation,
  }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)

  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-terminal-')))
  try {
    await chmod(root, 0o700)
    const disk = await createWorkbookRolloutJournal(join(root, 'resume.json'))
    await assert.rejects(disk.save({
      ...complete, result: { ...terminalResult, replayWritesZero: false },
    }), /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('completed journal returns success only after exact live terminal revalidation', async () => {
  const calls = []
  const complete = completedJournal()
  const journal = {
    async load() { return structuredClone(complete) },
    async save() { throw new Error('must not save') },
  }
  const result = await runResumableStagingWorkbookRollout({
    journal, api: terminalApi({ calls }), workbook: {},
    approvedFingerprint: initial.fingerprint, resolutions: [],
    expectedReconciliation: reconciliation,
  })
  assert.deepEqual(result, terminalResult)
  assert.deepEqual(calls, [
    ['operatorEvidence'],
    ['commit', initial.commitIdempotencyKey],
    ['operatorEvidence'],
    ['status', 'wbi_terminal_one'],
    ['artifactVerification', 'wbi_terminal_one'],
    ['reconciliation', 'wbi_terminal_one'],
  ])
})

test('completed journal rejects valid-looking altered identity, counts and live proof', async () => {
  const cases = [
    {
      result: { ...terminalResult, artifactId: 'wba_terminal_other' },
      api: terminalApi(),
    },
    {
      result: { ...terminalResult, acceptedCount: 2231 },
      api: terminalApi(),
    },
    {
      result: terminalResult,
      api: terminalApi({ status: { status: 'materializing', converged: false } }),
    },
    {
      result: terminalResult,
      api: terminalApi({ artifact: { readbackDigestMatch: false } }),
    },
    {
      result: terminalResult,
      api: terminalApi({ reconciled: { replayCreatedRecords: 1 } }),
    },
  ]
  for (const hostile of cases) {
    const journal = {
      async load() {
        return structuredClone({
          ...completedJournal(hostile.result),
        })
      },
      async save() { throw new Error('must not save') },
    }
    await assert.rejects(runResumableStagingWorkbookRollout({
      journal, api: hostile.api, workbook: {},
      approvedFingerprint: initial.fingerprint, resolutions: [],
      expectedReconciliation: reconciliation,
    }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  }
})

test('completed journal cannot skip exact idempotency replay and its zero-write evidence bracket', async () => {
  const calls = []
  let evidenceReads = 0
  const api = {
    ...terminalApi({ calls }),
    async operatorEvidence() {
      calls.push(['operatorEvidence'])
      evidenceReads += 1
      return evidenceReads === 1 ? evidence : { ...evidence, auditEventCount: 1 }
    },
    async commit(input) {
      calls.push(['commit', input.idempotencyKey])
      return terminalState
    },
    async continue() { throw new Error('unexpected continuation') },
  }
  await assert.rejects(runResumableStagingWorkbookRollout({
    journal: {
      async load() { return structuredClone(completedJournal()) },
      async save() { throw new Error('must not save') },
    },
    api, workbook: { buffer: Buffer.from('fictional') },
    approvedFingerprint: initial.fingerprint, resolutions: [],
    expectedReconciliation: reconciliation,
  }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  assert.deepEqual(calls, [
    ['operatorEvidence'], ['commit', initial.commitIdempotencyKey], ['operatorEvidence'],
  ])
})

test('resume rejects inconsistent commit/continuation relations before any API call', async () => {
  const base = {
    ...initial,
    phase: 'continue_pending',
    preview: {
      fingerprint: initial.fingerprint, previewToken: 'private-relational-token', conflictIds: [],
      ...previewMetadata,
    },
    previewRecordedAtMs: 1,
    commitOperation: {
      kind: 'commit', idempotencyKey: initial.commitIdempotencyKey,
      body: {
        workbookFingerprint: initial.fingerprint,
        previewToken: 'private-relational-token', planDigest: PLAN_DIGEST, resolutions: [],
      },
      response: {
        importId: 'wbi_relational_one', artifactId: 'wba_relational_one',
        status: 'ready', version: 1, createdRecords: 0,
        voidedRecords: 0, converged: false,
      },
    },
    importIdentity: { importId: 'wbi_relational_one', artifactId: 'wba_relational_one' },
    pendingOperation: {
      kind: 'continue',
      idempotencyKey: `rollout-continue-${initial.rolloutIdentity}-1`,
      body: { importId: 'wbi_relational_one', expectedVersion: 1 },
    },
    continuations: [{
      kind: 'continue',
      idempotencyKey: `rollout-continue-${initial.rolloutIdentity}-1`,
      body: { importId: 'wbi_relational_one', expectedVersion: 1 },
      response: null,
    }],
  }
  const hostileStates = [
    {
      ...base,
      preview: { ...base.preview, parserVersion: 3 },
    },
    {
      ...base,
      preview: { ...base.preview, planDigest: 'v1_invalid' },
    },
    {
      ...base,
      pendingOperation: {
        ...base.pendingOperation,
        body: { ...base.pendingOperation.body, importId: 'wbi_relational_other' },
      },
    },
    {
      ...base,
      continuations: [{
        ...base.continuations[0],
        idempotencyKey: `rollout-continue-${initial.rolloutIdentity}-2`,
      }],
    },
    {
      ...base,
      commitOperation: {
        ...base.commitOperation,
        body: { ...base.commitOperation.body, previewToken: 'private-wrong-token' },
      },
    },
    {
      ...base,
      commitOperation: {
        ...base.commitOperation,
        body: { ...base.commitOperation.body, planDigest: `v1_${'B'.repeat(43)}` },
      },
    },
    {
      ...base,
      continuations: [{
        ...base.continuations[0],
        response: {
          ...base.commitOperation.response, artifactId: 'wba_relational_other',
        },
      }],
    },
  ]
  for (const state of hostileStates) {
    let apiCalls = 0
    const api = Object.fromEntries([
      'operatorEvidence', 'preview', 'commit', 'status', 'continue',
      'artifactVerification', 'reconciliation',
    ].map((name) => [name, async () => { apiCalls += 1; throw new Error('must not call') }]))
    await assert.rejects(runResumableStagingWorkbookRollout({
      journal: {
        async load() { return structuredClone(state) },
        async save() { throw new Error('must not save') },
      },
      api, workbook: {}, approvedFingerprint: initial.fingerprint,
      resolutions: [], expectedReconciliation: reconciliation,
    }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
    assert.equal(apiCalls, 0)
  }
})

test('definitive expired pending commit is reconciled and reset for a fresh preview', async () => {
  const operation = {
    kind: 'commit', idempotencyKey: initial.commitIdempotencyKey,
    body: {
      workbookFingerprint: initial.fingerprint,
      previewToken: 'private-expired-token', planDigest: PLAN_DIGEST, resolutions: [],
    },
  }
  let saved = {
    ...initial,
    phase: 'commit_pending',
    preview: {
      fingerprint: initial.fingerprint, previewToken: 'private-expired-token', conflictIds: [],
      ...previewMetadata,
    },
    previewRecordedAtMs: 1,
    pendingOperation: operation,
  }
  let commitCalls = 0
  const api = {
    async operatorEvidence() { return evidence },
    async preview() { throw new Error('must use journal preview') },
    async commit() {
      commitCalls += 1
      throw new WorkbookRolloutHttpError('WORKBOOK_PREVIEW_TOKEN_INVALID', 400)
    },
    async status() { throw new Error('unused') },
    async continue() { throw new Error('unused') },
    async artifactVerification() { throw new Error('unused') },
    async reconciliation() { throw new Error('unused') },
  }
  await assert.rejects(runResumableStagingWorkbookRollout({
    journal: {
      async load() { return structuredClone(saved) },
      async save(value) { saved = structuredClone(value) },
    },
    api, workbook: {}, approvedFingerprint: initial.fingerprint,
    resolutions: [], expectedReconciliation: reconciliation,
  }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  assert.equal(commitCalls, 1)
  assert.equal(saved.phase, 'initialized')
  assert.equal(saved.preview, null)
  assert.equal(saved.pendingOperation, null)
})

test('definitive stale pending continuation reconciles live progress before abandoning it', async () => {
  const continuation = {
    kind: 'continue',
    idempotencyKey: `rollout-continue-${initial.rolloutIdentity}-1`,
    body: { importId: 'wbi_stale_one', expectedVersion: 1 },
  }
  let saved = {
    ...initial,
    phase: 'continue_pending',
    preview: {
      fingerprint: initial.fingerprint, previewToken: 'private-stale-token', conflictIds: [],
      ...previewMetadata,
    },
    previewRecordedAtMs: 1,
    commitOperation: {
      kind: 'commit', idempotencyKey: initial.commitIdempotencyKey,
      body: {
        workbookFingerprint: initial.fingerprint,
        previewToken: 'private-stale-token', planDigest: PLAN_DIGEST, resolutions: [],
      },
      response: {
        importId: 'wbi_stale_one', artifactId: 'wba_stale_one', status: 'ready',
        version: 1, createdRecords: 0, voidedRecords: 0, converged: false,
      },
    },
    importIdentity: { importId: 'wbi_stale_one', artifactId: 'wba_stale_one' },
    pendingOperation: continuation,
    continuations: [{ ...continuation, response: null }],
  }
  let continueCalls = 0
  const api = {
    async operatorEvidence() { return evidence },
    async continue() {
      continueCalls += 1
      throw new WorkbookRolloutHttpError(
        'VERSION_CONFLICT', 409, { currentVersion: 2 },
      )
    },
    async status() {
      return {
        importId: 'wbi_stale_one', artifactId: 'wba_stale_one',
        status: 'materializing', version: 2,
        createdRecords: 64, voidedRecords: 0, converged: false,
      }
    },
    async preview() { throw new Error('unused') },
    async commit() { throw new Error('unused') },
    async artifactVerification() { throw new Error('unused') },
    async reconciliation() { throw new Error('unused') },
  }
  await assert.rejects(runResumableStagingWorkbookRollout({
    journal: {
      async load() { return structuredClone(saved) },
      async save(value) { saved = structuredClone(value) },
    },
    api, workbook: {}, approvedFingerprint: initial.fingerprint,
    resolutions: [], expectedReconciliation: reconciliation,
  }), /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  assert.equal(continueCalls, 1)
  assert.equal(saved.phase, 'committed')
  assert.equal(saved.pendingOperation, null)
  assert.deepEqual(saved.continuations, [])
})

test('preview-only journal older than five minutes obtains and journals a fresh token before commit', async () => {
  let saved = null
  let nowMs = 0
  let evidenceCalls = 0
  let previewCalls = 0
  let committedToken = null
  const journal = {
    async load() { return saved === null ? null : structuredClone(saved) },
    async save(value) { saved = structuredClone(value) },
  }
  const api = {
    async operatorEvidence() {
      evidenceCalls += 1
      if (evidenceCalls === 2) throw new Error('stopped after preview')
      return evidence
    },
    async preview() {
      previewCalls += 1
      return {
        fingerprint: initial.fingerprint,
        previewToken: `private-token-${previewCalls}`,
        conflictIds: [],
        ...previewMetadata,
      }
    },
    async commit(input) {
      committedToken = input.previewToken
      throw new Error('stop after fresh commit attempt')
    },
    async status() { throw new Error('unused') },
    async continue() { throw new Error('unused') },
    async artifactVerification() { throw new Error('unused') },
    async reconciliation() { throw new Error('unused') },
  }
  const input = {
    journal, api, workbook: { buffer: Buffer.from('fictional') },
    approvedFingerprint: initial.fingerprint, resolutions: [],
    expectedReconciliation: reconciliation, identityFactory: () => initial.rolloutIdentity,
    now: () => nowMs,
  }
  await assert.rejects(runResumableStagingWorkbookRollout(input),
    /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  assert.equal(saved.phase, 'previewed')
  assert.equal(saved.preview.previewToken, 'private-token-1')
  nowMs = 300_001
  await assert.rejects(runResumableStagingWorkbookRollout(input),
    /^Error: WORKBOOK_ROLLOUT_STAGING_FAILED$/)
  assert.equal(previewCalls, 2)
  assert.equal(committedToken, 'private-token-2')
  assert.equal(saved.phase, 'commit_pending')
  assert.equal(saved.pendingOperation.body.previewToken, 'private-token-2')
})

test('journal atomically creates and replaces only a strict 0600 regular file', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-test-')))
  const path = join(root, 'resume.json')
  try {
    await chmod(root, 0o700)
    const journal = await createWorkbookRolloutJournal(path)
    assert.equal(await journal.load(), null)
    await journal.save(initial)
    assert.equal((await lstat(path)).mode & 0o777, 0o600)
    assert.deepEqual(await journal.load(), initial)
    await journal.save({
      ...initial,
      phase: 'preview_pending',
      pendingOperation: {
        kind: 'preview', idempotencyKey: null,
        body: { workbookFingerprint: initial.fingerprint },
      },
    })
    assert.equal(JSON.parse(await readFile(path, 'utf8')).phase, 'preview_pending')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('journal refuses permissive files, symlinks and non-private parents', async () => {
  for (const setup of ['permissive-file', 'symlink', 'permissive-parent']) {
    const root = await mkdtemp(join(tmpdir(), 'bwm-journal-hostile-'))
    const path = join(root, 'resume.json')
    try {
      await chmod(root, setup === 'permissive-parent' ? 0o755 : 0o700)
      if (setup === 'permissive-file') await writeFile(path, '{}', { mode: 0o644 })
      if (setup === 'symlink') {
        const target = join(root, 'target.json')
        await writeFile(target, '{}', { mode: 0o600 })
        await symlink(target, path)
      }
      await assert.rejects(createWorkbookRolloutJournal(path),
        /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test('journal exclusive run lock refuses concurrent and pre-existing lock owners', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-lock-')))
  const path = join(root, 'resume.json')
  const lockPath = `${path}.lock`
  try {
    await chmod(root, 0o700)
    const first = await createWorkbookRolloutJournal(path)
    const second = await createWorkbookRolloutJournal(path)
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let entered = false
    const running = first.runExclusive(async () => {
      entered = true
      assert.equal((await lstat(lockPath)).mode & 0o777, 0o600)
      await gate
      return 'complete'
    })
    while (!entered) await new Promise((resolve) => setImmediate(resolve))
    let secondEntered = false
    await assert.rejects(second.runExclusive(async () => {
      secondEntered = true
    }), /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
    assert.equal(secondEntered, false)
    release()
    assert.equal(await running, 'complete')
    assert.equal(await second.runExclusive(async () => 'after-release'), 'after-release')

    await writeFile(lockPath, 'workbook_rollout_lock.v1\n', { mode: 0o600, flag: 'wx' })
      .catch((error) => { if (error?.code !== 'EEXIST') throw error })
    assert.equal(await first.runExclusive(async () => 'stale-file-reused'), 'stale-file-reused')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('journal kernel lock is released when the rollout process is killed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-lock-crash-')))
  const path = join(root, 'resume.json')
  let child
  try {
    await chmod(root, 0o700)
    const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/workbook-rollout-journal.mjs')).href
    const source = `
      import { createWorkbookRolloutJournal } from ${JSON.stringify(moduleUrl)}
      const journal = await createWorkbookRolloutJournal(${JSON.stringify(path)})
      await journal.runExclusive(async () => {
        process.stdout.write('entered\\n')
        await new Promise(() => {})
      })
    `
    child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    for await (const chunk of child.stdout) {
      output += chunk.toString('utf8')
      if (output === 'entered\n') break
      if (output.length > 16) throw new Error('unexpected child output')
    }
    assert.equal(output, 'entered\n')
    child.kill('SIGKILL')
    await once(child, 'exit')
    child = null
    const journal = await createWorkbookRolloutJournal(path)
    let recovered = false
    for (let attempt = 0; attempt < 50 && !recovered; attempt += 1) {
      try {
        recovered = await journal.runExclusive(async () => true)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    assert.equal(recovered, true)
  } finally {
    child?.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('journal exclusive run lock refuses a symlink without touching its target', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bwm-journal-lock-link-')))
  const path = join(root, 'resume.json')
  const target = join(root, 'outside')
  try {
    await chmod(root, 0o700)
    await writeFile(target, 'untouched', { mode: 0o600 })
    await symlink(target, `${path}.lock`)
    const journal = await createWorkbookRolloutJournal(path)
    await assert.rejects(journal.runExclusive(async () => 'must-not-run'),
      /^Error: WORKBOOK_ROLLOUT_STAGING_REFUSED$/)
    assert.equal(await readFile(target, 'utf8'), 'untouched')
  } finally { await rm(root, { recursive: true, force: true }) }
})
