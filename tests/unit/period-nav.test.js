import assert from 'node:assert/strict'
import test from 'node:test'

import {
  periodMonthOptions,
  periodNavState,
} from '../../src/period-nav.js'

test('period month options build a complete calendar year and disable months outside bounds', () => {
  const options = periodMonthOptions(2026, { min: '2026-03', max: '2026-09' })

  assert.equal(options.length, 12)
  assert.deepEqual(options[0], { month: '2026-01', disabled: true })
  assert.deepEqual(options[2], { month: '2026-03', disabled: false })
  assert.deepEqual(options[8], { month: '2026-09', disabled: false })
  assert.deepEqual(options[9], { month: '2026-10', disabled: true })
})

test('period navigation only exposes reachable adjacent and current months', () => {
  assert.deepEqual(periodNavState({
    month: '2026-03', min: '2026-03', max: '2026-09', current: '2026-09',
  }), {
    previous: '2026-02', next: '2026-04', previousDisabled: true, nextDisabled: false,
    currentDisabled: false,
  })

  assert.deepEqual(periodNavState({
    month: '2026-09', min: '2026-03', max: '2026-09', current: '2026-09',
  }), {
    previous: '2026-08', next: '2026-10', previousDisabled: false, nextDisabled: true,
    currentDisabled: true,
  })
})

test('period navigation keeps unbounded months and an available current month enabled', () => {
  assert.deepEqual(periodMonthOptions(2026), [
    ...Array.from({ length: 12 }, (_, index) => ({
      month: `2026-${String(index + 1).padStart(2, '0')}`,
      disabled: false,
    })),
  ])
  assert.equal(periodNavState({ month: '2026-06', current: '2026-09' }).currentDisabled, false)
})
