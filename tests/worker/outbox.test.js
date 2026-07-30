import { describe, expect, it } from 'vitest'
import { retryDelayMs } from '../../worker/jobs/outbox.js'

describe('outbox retry schedule', () => {
  it('uses the fixed retry schedule and dead-letters after attempt eight', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelayMs)).toEqual([
      60_000, 300_000, 900_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000,
    ])
    expect(retryDelayMs(8)).toBeNull()
  })
})
