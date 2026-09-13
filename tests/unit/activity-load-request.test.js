import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activityWindowRetry,
  activityWindowLoadOutcome,
  clearActivityWindowRejection,
  shouldLoadActivityWindow,
  trackActivityWindowLoad,
} from '../../src/activity-load-request.js'

test('activity retry recovers read-only authority before scheduling one exact window', () => {
  const events = []
  const range = Object.freeze({ from: '2026-08', to: '2026-08' })
  activityWindowRetry({
    status: 'read-only-error',
    range,
    recover: () => events.push(['recover']),
    schedule: (receivedRange) => events.push(['schedule', receivedRange]),
  })
  assert.deepEqual(events, [['recover'], ['schedule', range]])
})

test('activity retry schedules once when authority is already usable', () => {
  let scheduled = 0
  activityWindowRetry({
    status: 'ready',
    range: { from: '2026-09', to: '2026-09' },
    recover: () => assert.fail('ready authority must not recover'),
    schedule: () => { scheduled += 1 },
  })
  assert.equal(scheduled, 1)
})

test('a forced activity retry loads one already-covered selected month', async () => {
  const key = '0|2026-09|2026-09'
  let requests = 0
  const shouldLoad = shouldLoadActivityWindow({
    enabled: true,
    hasActivities: true,
    hasRange: true,
    readOnly: false,
    covered: true,
    key,
    rejectedKey: null,
    requested: false,
    forceKey: key,
  })

  if (shouldLoad) {
    await trackActivityWindowLoad({
      key,
      requested: new Set(),
      load: () => {
        requests += 1
        return Promise.resolve('reloaded')
      },
      onRejected: () => assert.fail('successful forced retry must not reject'),
    })
  }

  assert.equal(requests, 1)
  assert.equal(shouldLoadActivityWindow({
    enabled: true,
    hasActivities: true,
    hasRange: true,
    readOnly: false,
    covered: true,
    key,
    rejectedKey: null,
    requested: false,
    forceKey: null,
  }), false)
})

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

test('retry clears only the rejection for its own activity window', () => {
  assert.equal(clearActivityWindowRejection('0|2026-08|2026-08', '0|2026-08|2026-08'), null)
  assert.equal(clearActivityWindowRejection('0|2026-08|2026-08', '0|2026-09|2026-09'), '0|2026-08|2026-08')
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
