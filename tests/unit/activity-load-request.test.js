import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activityWindowLoadOutcome,
  trackActivityWindowLoad,
} from '../../src/activity-load-request.js'

test('a rejected activity window load releases its request key and reports unavailable', async () => {
  const key = '0|2026-08|2026-08'
  const requested = new Set()
  const failures = []
  const pendingWhenRejected = []
  const error = Object.assign(new Error('Too many results'), { code: 'ACTIVITY_RESULT_LIMIT' })

  const load = trackActivityWindowLoad({
    key,
    requested,
    load: () => Promise.reject(error),
    onRejected: (rejectedKey) => {
      failures.push(rejectedKey)
      pendingWhenRejected.push(requested.has(rejectedKey))
    },
  })

  assert.equal(requested.has(key), true)
  await assert.rejects(load, (candidate) => candidate === error)
  assert.equal(requested.has(key), false)
  assert.deepEqual(failures, [key])
  assert.deepEqual(pendingWhenRejected, [true])
  assert.equal(activityWindowLoadOutcome({
    enabled: true,
    hasActivities: true,
    hasRange: true,
    readOnly: false,
    covered: false,
    key,
    rejectedKey: failures[0],
  }), 'unavailable')
})

test('a settled activity request key can be used by a later retry', async () => {
  const key = '0|2026-08|2026-08'
  const requested = new Set()

  await assert.rejects(trackActivityWindowLoad({
    key,
    requested,
    load: () => Promise.reject(new Error('Rate limited')),
    onRejected: () => {},
  }))

  const value = await trackActivityWindowLoad({
    key,
    requested,
    load: () => Promise.resolve('loaded'),
    onRejected: () => assert.fail('successful retry must not report rejection'),
  })

  assert.equal(value, 'loaded')
  assert.equal(requested.has(key), false)
})

test('activity window outcome preserves ready and infrastructure-unavailable precedence', () => {
  const base = {
    enabled: true,
    hasActivities: true,
    hasRange: true,
    readOnly: false,
    covered: false,
    key: '0|2026-08|2026-08',
    rejectedKey: null,
  }

  assert.equal(activityWindowLoadOutcome({ ...base, covered: true }), 'ready')
  assert.equal(activityWindowLoadOutcome({
    ...base,
    covered: true,
    rejectedKey: base.key,
  }), 'ready')
  assert.equal(activityWindowLoadOutcome({ ...base, readOnly: true, covered: true }), 'unavailable')
  assert.equal(activityWindowLoadOutcome({ ...base, hasActivities: false }), 'ready')
  assert.equal(activityWindowLoadOutcome(base), 'loading')
})
