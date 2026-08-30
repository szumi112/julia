import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKBOOK_FLOW_ACTIONS,
  createWorkbookFlowState,
  matchesWorkbookContinuationImport,
  matchesWorkbookResolutionResult,
  shouldContinueWorkbookMaterialization,
  specialistOptionsForSelect,
  workbookFlowReducer,
} from '../../src/workbook-flow.js'

const preview = Object.freeze({
  previewToken: `v1.1.${'A'.repeat(86)}.${'B'.repeat(43)}`,
  planDigest: `v1_${'C'.repeat(43)}`,
  conflicts: Object.freeze([]),
})

const imported = (overrides = {}) => ({
  id: 'wbi_flow_one', status: 'materializing', version: 2,
  createdByStaffId: 'stf_owner_one', ...overrides,
})

const event = (type, values = {}) => ({ type, generation: 7, ...values })

test('workbook specialist options expose ids only when labels are ambiguous', () => {
  assert.deepEqual(specialistOptionsForSelect([
    { id: 'sp_anna', label: 'Anna Nowak' },
    { id: 'sp_beata', label: 'Beata Kowalska' },
    { id: 'sp_anna_second', label: 'Anna Nowak' },
  ]), [
    { id: 'sp_anna', label: 'Anna Nowak', selectLabel: 'Anna Nowak · sp_anna' },
    { id: 'sp_beata', label: 'Beata Kowalska', selectLabel: 'Beata Kowalska' },
    {
      id: 'sp_anna_second', label: 'Anna Nowak',
      selectLabel: 'Anna Nowak · sp_anna_second',
    },
  ])
})

test('workbook flow follows preview/review/commit and drops file/token at acceptance', () => {
  let state = createWorkbookFlowState(7)
  assert.deepEqual(state, {
    generation: 7, phase: 'idle', hasSelectedFile: false, preview: null,
    resolutions: [], continuation: null, errorCode: null,
  })
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.FILE_SELECTED))
  assert.equal(state.phase, 'previewing')
  assert.equal(state.hasSelectedFile, true)
  state = workbookFlowReducer(state, event(
    WORKBOOK_FLOW_ACTIONS.PREVIEW_SUCCEEDED, { preview },
  ))
  assert.equal(state.phase, 'review')
  assert.equal(state.preview.previewToken, preview.previewToken)
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.RESOLUTION_CHANGED, {
    conflictId: 'wmc_first', specialistId: 'sp_anna',
  }))
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.COMMIT_STARTED))
  assert.equal(state.phase, 'committing')
  assert.equal(state.hasSelectedFile, true)
  state = workbookFlowReducer(state, event(
    WORKBOOK_FLOW_ACTIONS.COMMIT_SUCCEEDED, { imported: imported() },
  ))

  assert.equal(state.phase, 'materializing')
  assert.equal(state.hasSelectedFile, false)
  assert.equal(state.preview, null)
  assert.deepEqual(state.resolutions, [])
  assert.deepEqual(state.continuation, {
    importId: 'wbi_flow_one', importVersion: 2, resolutionVersion: null,
    createdByStaffId: 'stf_owner_one', status: 'materializing',
    planDigest: preview.planDigest, resolutionCount: null,
  })
  assert.ok(Object.isFrozen(state))
  assert.ok(Object.isFrozen(state.continuation))
})

test('workbook flow captures/removes resolutions without mutating prior state', () => {
  let state = createWorkbookFlowState(7)
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.FILE_SELECTED))
  state = workbookFlowReducer(state, event(
    WORKBOOK_FLOW_ACTIONS.PREVIEW_SUCCEEDED, { preview },
  ))
  const before = state
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.RESOLUTION_CHANGED, {
    conflictId: 'wmc_first', specialistId: 'sp_anna',
  }))
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.RESOLUTION_CHANGED, {
    conflictId: 'wmc_second', specialistId: 'sp_beata',
  }))
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.RESOLUTION_CHANGED, {
    conflictId: 'wmc_first', specialistId: null,
  }))

  assert.deepEqual(before.resolutions, [])
  assert.deepEqual(state.resolutions, [
    { conflictId: 'wmc_second', specialistId: 'sp_beata' },
  ])
  assert.ok(Object.isFrozen(state.resolutions))
  assert.ok(Object.isFrozen(state.resolutions[0]))
})

test('uncertain create failure retains the exact preview, choices and selected file for replay', () => {
  let state = createWorkbookFlowState(7)
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.FILE_SELECTED))
  state = workbookFlowReducer(state, event(
    WORKBOOK_FLOW_ACTIONS.PREVIEW_SUCCEEDED, { preview },
  ))
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.RESOLUTION_CHANGED, {
    conflictId: 'wmc_first', specialistId: 'sp_anna',
  }))
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.COMMIT_STARTED))
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.REQUEST_FAILED, {
    errorCode: 'WORKBOOK_COMMIT_FAILED',
  }))

  assert.equal(state.phase, 'review')
  assert.equal(state.hasSelectedFile, true)
  assert.equal(state.preview.previewToken, preview.previewToken)
  assert.deepEqual(state.resolutions, [{ conflictId: 'wmc_first', specialistId: 'sp_anna' }])
  assert.equal(state.errorCode, 'WORKBOOK_COMMIT_FAILED')
  assert.equal(workbookFlowReducer(state, event(
    WORKBOOK_FLOW_ACTIONS.COMMIT_STARTED,
  )).phase, 'committing')
})

test('workbook flow owns needs-resolution recording, continuation and completion', () => {
  let state = createWorkbookFlowState(7)
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.FILE_SELECTED))
  state = workbookFlowReducer(state, event(
    WORKBOOK_FLOW_ACTIONS.PREVIEW_SUCCEEDED, { preview },
  ))
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.COMMIT_STARTED))
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.COMMIT_SUCCEEDED, {
    imported: imported({ status: 'conflicts' }),
  }))
  assert.equal(state.phase, 'needs-resolution')
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.RESOLUTION_CHANGED, {
    conflictId: 'wmc_post_import', specialistId: 'sp_anna',
  }))
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.RESOLUTIONS_RECORDED, {
    result: {
      importId: 'wbi_flow_one', resolutionCount: 1,
      importVersion: 3, resolutionVersion: 1,
    },
  }))
  assert.equal(state.phase, 'materializing')
  assert.equal(state.continuation.importVersion, 3)
  assert.equal(state.continuation.resolutionVersion, 1)
  assert.equal(state.continuation.resolutionCount, 1)
  assert.deepEqual(state.resolutions, [])
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.CONTINUE_STARTED))
  assert.equal(state.phase, 'continuing')
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.STATUS_SUCCEEDED, {
    imported: imported({ status: 'complete', version: 4 }),
  }))
  assert.equal(state.phase, 'complete')
  assert.equal(state.continuation.importVersion, 4)
})

test('a continuation conflict replaces the authenticated plan digest immediately', () => {
  let state = createWorkbookFlowState(7)
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.BATCH_SELECTED, {
    imported: imported({ status: 'ready', version: 2, resolutionVersion: 0 }),
    planDigest: null,
  }))
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.CONTINUE_STARTED))
  const nextDigest = `v1_${'N'.repeat(43)}`
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.STATUS_SUCCEEDED, {
    imported: imported({ status: 'conflicts', version: 3, resolutionVersion: 1 }),
    planDigest: nextDigest,
  }))

  assert.equal(state.phase, 'needs-resolution')
  assert.equal(state.continuation.planDigest, nextDigest)
  assert.equal(state.continuation.resolutionVersion, 1)
})

test('workbook flow ignores stale completions and authority reset performs total cleanup', () => {
  let state = createWorkbookFlowState(7)
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.FILE_SELECTED))
  const unchanged = workbookFlowReducer(state, {
    type: WORKBOOK_FLOW_ACTIONS.PREVIEW_SUCCEEDED,
    generation: 6,
    preview,
  })
  assert.equal(unchanged, state)

  state = workbookFlowReducer(state, {
    type: WORKBOOK_FLOW_ACTIONS.AUTHORITY_RESET, generation: 8,
  })
  assert.deepEqual(state, {
    generation: 8, phase: 'idle', hasSelectedFile: false, preview: null,
    resolutions: [], continuation: null, errorCode: null,
  })
  assert.equal(workbookFlowReducer(state, event(
    WORKBOOK_FLOW_ACTIONS.PREVIEW_SUCCEEDED, { preview },
  )), state)
  assert.equal(workbookFlowReducer(state, {
    type: WORKBOOK_FLOW_ACTIONS.AUTHORITY_RESET, generation: 7,
  }), state)
})

test('workbook flow rejects accessor-backed events without evaluating them', () => {
  let state = createWorkbookFlowState(7)
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.FILE_SELECTED))
  const hostilePreview = []
  Object.defineProperty(hostilePreview, 0, {
    enumerable: true, get() { throw new Error('raw-preview-secret') },
  })
  hostilePreview.length = 1
  assert.throws(() => workbookFlowReducer(state, event(
    WORKBOOK_FLOW_ACTIONS.PREVIEW_SUCCEEDED, { preview: hostilePreview },
  )), { message: 'WORKBOOK_FLOW_INVALID_EVENT' })

  const hostileImported = Object.defineProperty({}, 'id', {
    enumerable: true, get() { throw new Error('raw-import-secret') },
  })
  assert.throws(() => workbookFlowReducer(createWorkbookFlowState(7), event(
    WORKBOOK_FLOW_ACTIONS.BATCH_SELECTED, { imported: hostileImported, planDigest: null },
  )), { message: 'WORKBOOK_FLOW_INVALID_EVENT' })
})

test('workbook flow resumes creator-bound server batches and fails closed on illegal transitions', () => {
  let state = createWorkbookFlowState(7)
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.BATCH_SELECTED, {
    imported: imported({ status: 'conflicts', resolutionVersion: 2 }),
    planDigest: `v1_${'D'.repeat(43)}`,
  }))
  assert.equal(state.phase, 'needs-resolution')
  assert.equal(state.continuation.createdByStaffId, 'stf_owner_one')
  assert.equal(state.continuation.resolutionVersion, 2)
  assert.throws(() => workbookFlowReducer(state, event(
    WORKBOOK_FLOW_ACTIONS.PREVIEW_SUCCEEDED, { preview },
  )), { message: 'WORKBOOK_FLOW_INVALID_TRANSITION' })

  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.REQUEST_FAILED, {
    errorCode: 'WORKBOOK_SCOPE_MISMATCH',
  }))
  assert.deepEqual(state, {
    generation: 7, phase: 'failed', hasSelectedFile: false, preview: null,
    resolutions: [], continuation: null, errorCode: 'WORKBOOK_SCOPE_MISMATCH',
  })
  state = workbookFlowReducer(state, event(WORKBOOK_FLOW_ACTIONS.RESET))
  assert.equal(state.phase, 'idle')
  assert.equal(state.errorCode, null)
})

test('workbook flow validates async results before reducer dispatch', () => {
  const continuation = {
    importId: 'wbi_async_boundary', importVersion: 4, resolutionVersion: 2,
    createdByStaffId: 'stf_owner_one', status: 'conflicts', planDigest: null,
    resolutionCount: null,
  }
  assert.equal(matchesWorkbookContinuationImport({
    id: 'wbi_async_boundary', status: 'complete', version: 5,
    createdByStaffId: 'stf_owner_one', resolutionVersion: null,
  }, continuation, { requireNewer: true }), true)
  assert.equal(matchesWorkbookContinuationImport({
    id: 'wbi_async_boundary', status: 'complete', version: 5,
    createdByStaffId: 'stf_other_owner', resolutionVersion: null,
  }, continuation, { requireNewer: true }), false)
  assert.equal(matchesWorkbookContinuationImport({
    id: 'wbi_async_boundary', status: 'complete', version: 4,
    createdByStaffId: 'stf_owner_one', resolutionVersion: null,
  }, continuation, { requireNewer: true }), false)

  assert.equal(matchesWorkbookResolutionResult({
    importId: 'wbi_async_boundary', importVersion: 5,
    resolutionVersion: 3, resolutionCount: 1,
  }, continuation), true)
  assert.equal(matchesWorkbookResolutionResult({
    importId: 'wbi_async_boundary', importVersion: 4,
    resolutionVersion: 3, resolutionCount: 1,
  }, continuation), false)
  assert.equal(matchesWorkbookResolutionResult({
    importId: 'wbi_other', importVersion: 5,
    resolutionVersion: 3, resolutionCount: 1,
  }, continuation), false)
})

test('workbook materialization keeps running only while slices remain', () => {
  for (const status of ['uploading', 'ready', 'materializing']) {
    assert.equal(
      shouldContinueWorkbookMaterialization(imported({ status })), true,
      `${status} has slices left`,
    )
  }
  for (const status of ['conflicts', 'complete', 'failed']) {
    assert.equal(
      shouldContinueWorkbookMaterialization(imported({ status })), false,
      `${status} must not be continued automatically`,
    )
  }
})

test('workbook materialization refuses to auto-continue an unreadable import', () => {
  for (const value of [null, undefined, 'materializing', [], { status: 'materializing' }]) {
    assert.equal(shouldContinueWorkbookMaterialization(value), false)
  }
})
