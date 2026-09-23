import assert from 'node:assert/strict'
import test from 'node:test'
import {
  METHOD_LABELS, PAY_LABELS, PAY_PILL, STATUS_PILL, calendarCountLabel, fmtMonthNameWithYearOutsideCurrent, fmtMoney, fmtWeekRange, isoWeek,
  paymentDisplayFor, relDayLabel, sessionsWord, toISODate, untilLabel, warsawDateTimeFromUtc,
} from '../../src/format.js'

test('payment method labels include the canonical monthly settlement method', () => {
  assert.equal(METHOD_LABELS.monthly, 'Miesięcznie')
})

test('calendar counters decline sessions and keep workbook entries and absences separate', () => {
  assert.equal(sessionsWord(1), 'sesja')
  assert.equal(sessionsWord(2), 'sesje')
  assert.equal(sessionsWord(5), 'sesji')
  assert.equal(calendarCountLabel(3, 2, 1), '3 sesje · 2 wpisy z arkusza · 1 nieobecność')
  assert.equal(calendarCountLabel(0, 1), '0 sesji · 1 wpis z arkusza')
})

test('calendar month picker omits the current year', () => {
  assert.equal(fmtMonthNameWithYearOutsideCurrent('2026-07', 2026), 'lipiec')
  assert.equal(fmtMonthNameWithYearOutsideCurrent('2027-07', 2026), 'lipiec 2027')
})

test('formats UTC instants in the Warsaw civil date and wall-clock time', () => {
  assert.deepEqual(warsawDateTimeFromUtc('2026-08-04T22:30:00.000Z'), {
    date: '2026-08-05', time: '00:30', second: '00',
  })
})

test('payment display only shows due pills when a session is billable or has a prepayment', () => {
  assert.deepEqual(paymentDisplayFor({ status: 'completed', payment: 'unpaid', date: '2026-09-14' }, '2026-09-13'), {
    kind: 'payment', label: 'Do zapłaty', tone: 'amber',
  })
  assert.deepEqual(paymentDisplayFor({ status: 'noshow', payment: 'unpaid', date: '2026-09-14' }, '2026-09-13'), {
    kind: 'payment', label: 'Do zapłaty', tone: 'amber',
  })
  assert.deepEqual(paymentDisplayFor({ status: 'cancelled', payment: 'unpaid', date: '2026-09-14' }, '2026-09-13'), {
    kind: 'quiet', label: 'bez opłaty', tone: 'ink',
  })
  assert.equal(paymentDisplayFor({ status: 'scheduled', payment: 'unpaid', date: '2026-09-14' }, '2026-09-13'), null)
  assert.equal(paymentDisplayFor({
    status: 'scheduled', payment: 'unpaid', date: '2026-09-13', time: '15:00',
  }, new Date('2026-09-13T14:59:00+02:00')), null)
  assert.deepEqual(paymentDisplayFor({
    status: 'scheduled', payment: 'unpaid', date: '2026-09-13', time: '15:00',
  }, new Date('2026-09-13T15:00:00+02:00')), {
    kind: 'payment', label: 'Do zapłaty', tone: 'amber',
  })
  assert.deepEqual(paymentDisplayFor({ status: 'scheduled', payment: 'partial', date: '2026-09-14' }, '2026-09-13'), {
    kind: 'payment', label: 'Częściowo opłacona', tone: 'amber',
  })
  assert.equal(PAY_LABELS.unpaid, 'Do zapłaty')
  assert.equal(PAY_PILL.unpaid, 'pill--amber')
})

test('session pill colors distinguish neutral states from completed and missed sessions', () => {
  assert.equal(STATUS_PILL.scheduled, 'pill--ink')
  assert.equal(STATUS_PILL.cancelled, 'pill--ink')
  assert.equal(STATUS_PILL.completed, 'pill--sage')
  assert.equal(STATUS_PILL.noshow, 'pill--pink')
})

test('money formatting preserves cents only for fractional złoty values', () => {
  assert.equal(fmtMoney(91.79), '91,79\u00a0zł')
  assert.equal(fmtMoney(8.21), '8,21\u00a0zł')
  assert.equal(fmtMoney(0.49), '0,49\u00a0zł')
  assert.equal(fmtMoney(220), '220\u00a0zł')
  assert.equal(fmtMoney('not-a-number'), '0\u00a0zł')
})

test('isoWeek numbers ISO-8601 weeks within the year', () => {
  assert.equal(isoWeek('2026-01-01'), 1) // Thursday — week 1 of 2026
  assert.equal(isoWeek('2026-01-04'), 1) // Sunday still belongs to week 1
  assert.equal(isoWeek('2026-01-05'), 2)
  assert.equal(isoWeek('2026-07-22'), 30)
})

test('isoWeek rolls across year boundaries', () => {
  assert.equal(isoWeek('2025-12-29'), 1) // Monday of ISO week 1/2026
  assert.equal(isoWeek('2026-12-31'), 53) // 2026 starts on a Thursday → 53 weeks
  assert.equal(isoWeek('2027-01-01'), 53) // Friday still in the last week of 2026
})

test('fmtWeekRange names the month once inside a month and twice across one', () => {
  assert.equal(fmtWeekRange('2026-07-20', '2026-07-26'), '20 – 26 lipca')
  assert.equal(fmtWeekRange('2026-06-29', '2026-07-05'), '29 czerwca – 5 lipca')
  assert.equal(fmtWeekRange('2026-12-28', '2027-01-03'), '28 grudnia – 3 stycznia')
})

test('relDayLabel keeps the short voice for today and yesterday', () => {
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const older = new Date()
  older.setDate(older.getDate() - 10)
  assert.equal(relDayLabel(toISODate(today)), 'dziś')
  assert.equal(relDayLabel(toISODate(yesterday)), 'wczoraj')
  assert.notEqual(relDayLabel(toISODate(older)), 'wczoraj')
})

test('untilLabel formats compact countdowns', () => {
  assert.equal(untilLabel(0), 'za chwilę')
  assert.equal(untilLabel(45), 'za 45 min')
  assert.equal(untilLabel(60), 'za 1 h')
  assert.equal(untilLabel(125), 'za 2 h 5 min')
})

test('month prose uses the locative with the right preposition', async () => {
  const { inMonthYear } = await import('../../src/format.js')
  assert.equal(inMonthYear('2026-09'), 'we wrześniu 2026')
  assert.equal(inMonthYear('2026-07'), 'w lipcu 2026')
})
