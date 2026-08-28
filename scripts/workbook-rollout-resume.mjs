import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  replayStagingWorkbookOperations,
  runStagingWorkbookRollout,
  verifyStagingWorkbookTerminal,
} from './workbook-rollout-staging-lib.mjs'
import { validateWorkbookRolloutJournal } from './workbook-rollout-journal.mjs'
import { WorkbookRolloutHttpError } from './workbook-rollout-staging-http.mjs'

const failed = () => { throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

export async function runResumableStagingWorkbookRollout({
  journal,
  api,
  workbook,
  approvedFingerprint,
  resolutions,
  expectedReconciliation,
  identityFactory = randomUUID,
  now = () => Date.now(),
}) {
  try {
    if (!journal || typeof journal.load !== 'function' || typeof journal.save !== 'function'
      || !plain(api) || !Array.isArray(resolutions) || typeof now !== 'function') failed()
    let state = await journal.load()
    if (state !== null) validateWorkbookRolloutJournal(state)
    if (state !== null && (state.fingerprint !== approvedFingerprint || !isDeepStrictEqual(
      state.rolloutRequest,
      { workbookFingerprint: approvedFingerprint, resolutions },
    ))) failed()
    if (state !== null && state.result !== null) {
      if (state.phase !== 'complete' || state.fingerprint !== approvedFingerprint
        || !isDeepStrictEqual(state.importIdentity, {
          importId: state.result.importId, artifactId: state.result.artifactId,
        })) failed()
      await replayStagingWorkbookOperations({
        api,
        workbook,
        commitOperation: state.commitOperation,
        continuations: state.continuations,
        importIdentity: state.importIdentity,
      })
      return verifyStagingWorkbookTerminal({
        api, result: state.result, expectedReconciliation,
        approvedFingerprint,
        committedFingerprint: state.commitOperation.body.workbookFingerprint,
      })
    }
    if (state === null) {
      const rolloutIdentity = identityFactory()
      state = {
        schema: 'workbook_rollout_journal.v1',
        environment: 'staging',
        fingerprint: approvedFingerprint,
        rolloutIdentity,
        commitIdempotencyKey: `rollout-commit-${rolloutIdentity}`,
        rolloutRequest: { workbookFingerprint: approvedFingerprint, resolutions },
        phase: 'initialized',
        preview: null,
        previewRecordedAtMs: null,
        pendingOperation: null,
        commitOperation: null,
        importIdentity: null,
        continuations: [],
        result: null,
      }
      await journal.save(state)
    }
    const persist = async (patch) => {
      state = { ...state, ...patch }
      await journal.save(state)
    }
    const operationBody = (input) => ({
      workbookFingerprint: approvedFingerprint,
      previewToken: input.previewToken,
      planDigest: state.preview?.planDigest,
      resolutions: input.resolutions,
    })
    let replayMode = false
    const wrappedApi = Object.freeze({
      operatorEvidence: (...args) => api.operatorEvidence(...args),
      async status(...args) {
        if (state.pendingOperation?.kind === 'continue') {
          const pending = state.pendingOperation
          return wrappedApi.continue({
            importId: pending.body.importId,
            expectedVersion: pending.body.expectedVersion,
            idempotencyKey: pending.idempotencyKey,
          })
        }
        return api.status(...args)
      },
      artifactVerification: (...args) => api.artifactVerification(...args),
      reconciliation: (...args) => api.reconciliation(...args),
      async preview(input) {
        if (state.preview !== null) {
          const commitAttempted = state.commitOperation !== null
            || state.pendingOperation?.kind === 'commit'
          const observedNow = now()
          if (!Number.isSafeInteger(observedNow) || observedNow < 0) failed()
          const age = observedNow - state.previewRecordedAtMs
          if (commitAttempted || (Number.isSafeInteger(age) && age >= 0 && age < 300_000)) {
            return state.preview
          }
          await persist({
            phase: 'initialized', preview: null, previewRecordedAtMs: null,
            pendingOperation: null,
          })
        }
        const operation = {
          kind: 'preview', idempotencyKey: null,
          body: { workbookFingerprint: approvedFingerprint },
        }
        await persist({ phase: 'preview_pending', pendingOperation: operation })
        const response = await api.preview(input)
        const previewRecordedAtMs = now()
        if (!Number.isSafeInteger(previewRecordedAtMs) || previewRecordedAtMs < 0) failed()
        await persist({
          phase: 'previewed', preview: response,
          previewRecordedAtMs, pendingOperation: null,
        })
        return response
      },
      async commit(input) {
        replayMode = state.commitOperation !== null
        const operation = {
          kind: 'commit', idempotencyKey: input.idempotencyKey,
          body: operationBody(input),
        }
        const expected = state.commitOperation ?? (
          state.pendingOperation?.kind === 'commit' ? state.pendingOperation : null
        )
        if (expected && !isDeepStrictEqual(
          { kind: expected.kind, idempotencyKey: expected.idempotencyKey, body: expected.body },
          operation,
        )) failed()
        const uncertainReplay = state.pendingOperation?.kind === 'commit'
        const beforeUncertainReplay = uncertainReplay ? await api.operatorEvidence() : null
        await persist({
          phase: replayMode ? 'replay_commit_pending' : 'commit_pending',
          pendingOperation: operation,
        })
        let response
        try {
          response = await api.commit(input)
        } catch (error) {
          if (uncertainReplay && error instanceof WorkbookRolloutHttpError
            && error.definitivePrewrite
            && error.code === 'WORKBOOK_PREVIEW_TOKEN_INVALID'
            && isDeepStrictEqual(beforeUncertainReplay, await api.operatorEvidence())) {
            await persist({
              phase: 'initialized', preview: null, previewRecordedAtMs: null,
              pendingOperation: null,
            })
          }
          throw error
        }
        if (uncertainReplay && !isDeepStrictEqual(
          beforeUncertainReplay, await api.operatorEvidence(),
        )) failed()
        await persist({
          phase: 'committed', pendingOperation: null,
          commitOperation: { ...operation, response },
          importIdentity: { importId: response.importId, artifactId: response.artifactId },
        })
        return response
      },
      async continue(input) {
        const operation = {
          kind: 'continue', idempotencyKey: input.idempotencyKey,
          body: { importId: input.importId, expectedVersion: input.expectedVersion },
        }
        const existingIndex = state.continuations.findIndex((entry) => (
          entry.idempotencyKey === operation.idempotencyKey
        ))
        if (existingIndex >= 0 && !isDeepStrictEqual(
          { kind: state.continuations[existingIndex].kind,
            idempotencyKey: state.continuations[existingIndex].idempotencyKey,
            body: state.continuations[existingIndex].body }, operation,
        )) failed()
        if (state.pendingOperation?.kind === 'continue'
          && state.pendingOperation.idempotencyKey === operation.idempotencyKey
          && !isDeepStrictEqual(state.pendingOperation, operation)) failed()
        const uncertainReplay = state.pendingOperation?.kind === 'continue'
        const beforeUncertainReplay = uncertainReplay ? await api.operatorEvidence() : null
        const continuations = existingIndex >= 0 ? [...state.continuations] : [
          ...state.continuations, { ...operation, response: null },
        ]
        await persist({
          phase: replayMode
            ? 'replay_continue_pending' : 'continue_pending',
          pendingOperation: operation, continuations,
        })
        let response
        try {
          response = await api.continue(input)
        } catch (error) {
          if (uncertainReplay && error instanceof WorkbookRolloutHttpError
            && error.definitivePrewrite && error.code === 'VERSION_CONFLICT'
            && isDeepStrictEqual(beforeUncertainReplay, await api.operatorEvidence())) {
            const observed = await api.status(operation.body.importId)
            const safeObserved = plain(observed)
              && observed.importId === state.importIdentity?.importId
              && observed.artifactId === state.importIdentity?.artifactId
              && ['ready', 'materializing', 'complete'].includes(observed.status)
              && Number.isSafeInteger(observed.version)
              && observed.version > operation.body.expectedVersion
              && observed.version === error.details?.currentVersion
              && Number.isSafeInteger(observed.createdRecords)
              && observed.createdRecords >= 0
              && Number.isSafeInteger(observed.voidedRecords)
              && observed.voidedRecords >= 0
              && typeof observed.converged === 'boolean'
            if (safeObserved) {
              await persist({
                phase: 'committed', pendingOperation: null,
                continuations: continuations.filter((entry) => (
                  entry.idempotencyKey !== operation.idempotencyKey
                )),
              })
            }
          }
          throw error
        }
        if (uncertainReplay && !isDeepStrictEqual(
          beforeUncertainReplay, await api.operatorEvidence(),
        )) failed()
        const index = continuations.findIndex((entry) => (
          entry.idempotencyKey === operation.idempotencyKey
        ))
        continuations[index] = { ...operation, response }
        await persist({ phase: 'committed', pendingOperation: null, continuations })
        return response
      },
    })
    let pendingContinuationUsed = false
    const continueIdempotencyKey = (_version, _runOrdinal) => {
      if (!pendingContinuationUsed && state.pendingOperation?.kind === 'continue') {
        pendingContinuationUsed = true
        return state.pendingOperation.idempotencyKey
      }
      return `rollout-continue-${state.rolloutIdentity}-${state.continuations.length + 1}`
    }
    if (state.pendingOperation?.kind === 'continue') {
      const pending = state.pendingOperation
      await wrappedApi.continue({
        importId: pending.body.importId,
        expectedVersion: pending.body.expectedVersion,
        idempotencyKey: pending.idempotencyKey,
      })
    }
    const result = await runStagingWorkbookRollout({
      api: wrappedApi,
      workbook,
      approvedFingerprint,
      resolutions,
      commitIdempotencyKey: state.commitIdempotencyKey,
      continueIdempotencyKey,
      recordedContinuations: () => state.continuations.map(({ body, idempotencyKey }) => ({
        importId: body.importId,
        expectedVersion: body.expectedVersion,
        idempotencyKey,
      })),
      expectedReconciliation,
      maximumContinuations: 256,
    })
    await persist({ phase: 'complete', pendingOperation: null, result })
    return result
  } catch {
    throw new Error('WORKBOOK_ROLLOUT_STAGING_FAILED')
  }
}
