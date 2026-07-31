import { afterEach, describe, expect, it, vi } from 'vitest'
import { backupDue, partsInWarsaw } from '../../worker/operations/clock.js'

const instant = (iso) => Date.parse(iso)
const eligible = instant('2026-07-30T01:15:00.000Z')
const states = {
  none: {
    hasLiveBackupForLocalDay: false,
    hasLiveMonthlyBackupForLocalMonth: false,
    hasStoredMonthlyBackupForLocalMonth: false,
  },
  liveDaily: {
    hasLiveBackupForLocalDay: true,
    hasLiveMonthlyBackupForLocalMonth: false,
    hasStoredMonthlyBackupForLocalMonth: false,
  },
  liveMonthly: {
    hasLiveBackupForLocalDay: false,
    hasLiveMonthlyBackupForLocalMonth: true,
    hasStoredMonthlyBackupForLocalMonth: false,
  },
  storedMonthly: {
    hasLiveBackupForLocalDay: false,
    hasLiveMonthlyBackupForLocalMonth: false,
    hasStoredMonthlyBackupForLocalMonth: true,
  },
}

const due = (localDay, localMonth, retentionClass) => ({ localDay, localMonth, retentionClass })

const nativeFormatToParts = Intl.DateTimeFormat.prototype.formatToParts

const captureError = (operation) => {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error('Expected operation to throw')
}

const expectClockInvalid = (operation, sourceError) => {
  const error = captureError(operation)
  expect(error).toBeInstanceOf(TypeError)
  expect(error.message).toBe('CLOCK_INVALID')
  if (sourceError) expect(error).not.toBe(sourceError)
}

const invalidInstants = [
  undefined,
  null,
  true,
  false,
  '0',
  1.5,
  -1,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  8_640_000_000_000_001,
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('partsInWarsaw', () => {
  it('returns canonical Warsaw parts for a normal instant', () => {
    expect(partsInWarsaw(eligible)).toEqual({
      day: '2026-07-30',
      month: '2026-07',
      hour: 3,
      minute: 15,
    })
  })

  it.each([
    ['before spring forward', '2026-03-29T00:59:00.000Z', 1, 59],
    ['after spring forward', '2026-03-29T01:00:00.000Z', 3, 0],
    ['spring threshold minus one minute', '2026-03-29T01:14:00.000Z', 3, 14],
    ['spring threshold', '2026-03-29T01:15:00.000Z', 3, 15],
  ])('maps %s without fabricating skipped local time', (_, iso, hour, minute) => {
    expect(partsInWarsaw(instant(iso))).toEqual({ day: '2026-03-29', month: '2026-03', hour, minute })
  })

  it.each([
    ['first 02:15', '2026-10-25T00:15:00.000Z', 2, 15],
    ['first 02:59', '2026-10-25T00:59:00.000Z', 2, 59],
    ['second 02:00', '2026-10-25T01:00:00.000Z', 2, 0],
    ['second 02:15', '2026-10-25T01:15:00.000Z', 2, 15],
    ['fall threshold', '2026-10-25T02:15:00.000Z', 3, 15],
  ])('maps %s during fall back deterministically', (_, iso, hour, minute) => {
    expect(partsInWarsaw(instant(iso))).toEqual({ day: '2026-10-25', month: '2026-10', hour, minute })
  })

  it.each(invalidInstants)('rejects invalid instant %j', (value) => {
    expect(() => partsInWarsaw(value)).toThrow(new TypeError('CLOCK_INVALID'))
  })

  it('normalizes a formatter invocation failure', () => {
    const sourceError = new Error('HOSTILE_FORMATTER')
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(() => {
      throw sourceError
    })

    expectClockInvalid(() => partsInWarsaw(eligible), sourceError)
  })

  it.each([
    ['non-iterable output', () => null],
    ['malformed null entry', () => [null]],
    ['throwing iterator', () => ({
      [Symbol.iterator]() {
        throw new Error('HOSTILE_ITERATOR')
      },
    })],
    ['throwing part getter', () => [{
      get type() {
        throw new Error('HOSTILE_PART')
      },
    }]],
  ])('normalizes formatter %s failures', (_, output) => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(output)

    expectClockInvalid(() => partsInWarsaw(eligible))
  })
})

describe('backupDue', () => {
  it('does not run before the local 03:15 threshold', () => {
    expect(backupDue(instant('2026-07-30T01:14:00.000Z'), states.none)).toBe(false)
  })

  it.each([
    ['all false', states.none, due('2026-07-30', '2026-07', 'monthly')],
    ['live daily backup', states.liveDaily, false],
    ['live monthly backup', states.liveMonthly, false],
    ['stored monthly backup', states.storedMonthly, due('2026-07-30', '2026-07', 'daily')],
    ['stored monthly with live daily backup', { ...states.storedMonthly, hasLiveBackupForLocalDay: true }, false],
    ['stored monthly with live monthly backup', { ...states.storedMonthly, hasLiveMonthlyBackupForLocalMonth: true }, false],
  ])('applies the eligible state matrix for %s', (_, state, expected) => {
    expect(backupDue(eligible, state)).toEqual(expected)
  })

  it.each([
    ['spring', '2026-03-29T01:15:00.000Z', '2026-03-29', '2026-03'],
    ['fall', '2026-10-25T02:15:00.000Z', '2026-10-25', '2026-10'],
  ])('uses the same eligible decisions at the %s DST threshold', (_, iso, localDay, localMonth) => {
    expect(backupDue(instant(iso), states.none)).toEqual(due(localDay, localMonth, 'monthly'))
    expect(backupDue(instant(iso), states.storedMonthly)).toEqual(due(localDay, localMonth, 'daily'))
    expect(backupDue(instant(iso), states.liveDaily)).toBe(false)
    expect(backupDue(instant(iso), states.liveMonthly)).toBe(false)
    expect(backupDue(instant(iso), {
      ...states.storedMonthly,
      hasLiveBackupForLocalDay: true,
    })).toBe(false)
    expect(backupDue(instant(iso), {
      ...states.storedMonthly,
      hasLiveMonthlyBackupForLocalMonth: true,
    })).toBe(false)
  })

  it.each([
    ...invalidInstants.map((value) => [value, states.none]),
    [eligible, undefined],
    [eligible, null],
    [eligible, true],
    [eligible, []],
    [eligible, {}],
    [eligible, { ...states.none, extra: false }],
    [eligible, { hasLiveBackupForLocalDay: false, hasLiveMonthlyBackupForLocalMonth: false }],
    [eligible, Object.create(states.none)],
    [eligible, { ...states.none, hasLiveBackupForLocalDay: 0 }],
    [eligible, { ...states.none, hasLiveMonthlyBackupForLocalMonth: 'false' }],
    [eligible, { ...states.none, hasStoredMonthlyBackupForLocalMonth: null }],
  ])('rejects invalid instant or state %j', (instantMs, state) => {
    expect(() => backupDue(instantMs, state)).toThrow(new TypeError('CLOCK_INVALID'))
  })

  it.each(['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'])(
    'normalizes arbitrary errors from the state %s trap',
    (trap) => {
      const sourceError = new Error(`HOSTILE_${trap}`)
      const state = new Proxy(states.none, {
        [trap]() {
          throw sourceError
        },
      })

      expectClockInvalid(() => backupDue(eligible, state), sourceError)
    },
  )

  it('normalizes operations on a revoked state proxy to a fresh error', () => {
    const { proxy, revoke } = Proxy.revocable(states.none, {})
    revoke()

    const first = captureError(() => backupDue(eligible, proxy))
    const second = captureError(() => backupDue(eligible, proxy))
    expect(first).toBeInstanceOf(TypeError)
    expect(first.message).toBe('CLOCK_INVALID')
    expect(second).toBeInstanceOf(TypeError)
    expect(second.message).toBe('CLOCK_INVALID')
    expect(second).not.toBe(first)
  })

  it('normalizes an arbitrary error from a state getter', () => {
    const sourceError = new Error('HOSTILE_GETTER')
    const state = {
      ...states.none,
      get hasLiveBackupForLocalDay() {
        throw sourceError
      },
    }

    expectClockInvalid(() => backupDue(eligible, state), sourceError)
  })

  it('derives Warsaw parts before observing state', () => {
    const events = []
    const formatSpy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockImplementation(function formatToParts(date) {
        events.push('format')
        return nativeFormatToParts.call(this, date)
      })
    const state = new Proxy(states.none, {
      getPrototypeOf(target) {
        events.push('state')
        return Reflect.getPrototypeOf(target)
      },
    })

    expect(backupDue(eligible, state)).toEqual(due('2026-07-30', '2026-07', 'monthly'))
    expect(events[0]).toBe('format')
    expect(formatSpy).toHaveBeenCalledOnce()
  })

  it('reads each state boolean exactly once and uses that snapshot', () => {
    const reads = Object.fromEntries(Object.keys(states.none).map((key) => [key, 0]))
    const state = Object.fromEntries(Object.keys(states.none).map((key) => [key, {
      enumerable: true,
      get() {
        reads[key] += 1
        return reads[key] === 1 ? false : true
      },
    }]))
    const getterState = Object.defineProperties({}, state)

    expect(backupDue(eligible, getterState)).toEqual(due('2026-07-30', '2026-07', 'monthly'))
    expect(reads).toEqual({
      hasLiveBackupForLocalDay: 1,
      hasLiveMonthlyBackupForLocalMonth: 1,
      hasStoredMonthlyBackupForLocalMonth: 1,
    })
  })
})
