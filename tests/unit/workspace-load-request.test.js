import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWorkspaceRangeLoadCoordinator,
  finishWorkspaceRangePending,
  isWorkspaceRangePending,
  startWorkspaceRangePending,
  workspaceLoadRequestKey,
  workspacePendingRangeKeys,
} from '../../src/workspace-load-request.js'

const current = { from: '2026-08-01', to: '2026-08-31' }
const other = { from: '2026-09-01', to: '2026-09-30' }

test('workspace pending state is scoped to the exact rendered range', () => {
  const pending = new Set([workspaceLoadRequestKey(other)])

  assert.equal(isWorkspaceRangePending(pending, current), false)
  assert.equal(isWorkspaceRangePending(pending, other), true)
})

test('workspace pending state clears only after the final same-range request completes', () => {
  const key = workspaceLoadRequestKey(current)
  const started = startWorkspaceRangePending(startWorkspaceRangePending(new Map(), key), key)
  const afterOne = finishWorkspaceRangePending(started, key)

  assert.equal(isWorkspaceRangePending(workspacePendingRangeKeys(afterOne), current), true)

  const afterBoth = finishWorkspaceRangePending(afterOne, key)
  assert.equal(isWorkspaceRangePending(workspacePendingRangeKeys(afterBoth), current), false)
})

test('one exact workspace range shares one in-flight request across callers', async () => {
  const coordinator = createWorkspaceRangeLoadCoordinator()
  const events = []
  let resolveRequest
  let calls = 0
  const request = () => {
    calls += 1
    return new Promise((resolve) => { resolveRequest = resolve })
  }
  const options = {
    range: current,
    request,
    onStart: (key) => events.push(['start', key]),
    onFulfilled: (key) => events.push(['fulfilled', key]),
    onRejected: () => assert.fail('fulfilled request must not be marked failed'),
    onSettled: (key) => events.push(['settled', key]),
  }

  const first = coordinator.load(options)
  const second = coordinator.load(options)

  assert.strictEqual(second, first)
  assert.equal(calls, 0)
  await Promise.resolve()
  assert.equal(calls, 1)
  resolveRequest('loaded')
  assert.equal(await first, 'loaded')
  assert.deepEqual(events, [
    ['start', '2026-08-01|2026-08-31'],
    ['fulfilled', '2026-08-01|2026-08-31'],
    ['settled', '2026-08-01|2026-08-31'],
  ])
})

test('a failed exact workspace range can be requested explicitly again', async () => {
  const coordinator = createWorkspaceRangeLoadCoordinator()
  const events = []
  const failure = new Error('offline')

  await assert.rejects(coordinator.load({
    range: current,
    request: () => Promise.reject(failure),
    onStart: () => events.push('start'),
    onFulfilled: () => assert.fail('failed request must not clear its failure'),
    onRejected: () => events.push('rejected'),
    onSettled: () => events.push('settled'),
  }), (error) => error === failure)

  await coordinator.load({
    range: current,
    request: () => Promise.resolve('retry loaded'),
    onStart: () => events.push('retry start'),
    onFulfilled: () => events.push('fulfilled'),
    onRejected: () => assert.fail('successful retry must not be marked failed'),
    onSettled: () => events.push('retry settled'),
  })

  assert.deepEqual(events, ['start', 'rejected', 'settled', 'retry start', 'fulfilled', 'retry settled'])
})

test('an authority reset keeps an old same-range completion from settling the new authority request', async () => {
  const coordinator = createWorkspaceRangeLoadCoordinator()
  const events = []
  let resolveOld
  let resolveNew
  const oldLoad = coordinator.load({
    range: current,
    request: () => new Promise((resolve) => { resolveOld = resolve }),
    onStart: () => events.push('old start'),
    onFulfilled: () => events.push('old fulfilled'),
    onRejected: () => assert.fail('old request must not fail'),
    onSettled: () => events.push('old settled'),
  })
  await Promise.resolve()
  coordinator.reset()
  const newLoad = coordinator.load({
    range: current,
    request: () => new Promise((resolve) => { resolveNew = resolve }),
    onStart: () => events.push('new start'),
    onFulfilled: () => events.push('new fulfilled'),
    onRejected: () => assert.fail('new request must not fail'),
    onSettled: () => events.push('new settled'),
  })
  await Promise.resolve()

  resolveOld('old')
  assert.equal(await oldLoad, 'old')
  assert.deepEqual(events, ['old start', 'new start'])
  resolveNew('new')
  assert.equal(await newLoad, 'new')
  assert.deepEqual(events, ['old start', 'new start', 'new fulfilled', 'new settled'])
})
