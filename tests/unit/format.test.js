import assert from 'node:assert/strict'
import test from 'node:test'
import { fmtMoney, fmtWeekRange, isoWeek, relDayLabel, toISODate, untilLabel } from '../../src/format.js'

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
