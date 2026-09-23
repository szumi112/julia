import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dayHeadingLabel, firstSessionDayInMonth, monthSelectionDay, weekRangeLabel,
} from '../../src/calendar-dates.js'

test('week label adds the year only outside the current year', () => {
  assert.equal(weekRangeLabel('2026-09-07', '2026-09-13', 2026), '7 – 13 września')
  assert.equal(weekRangeLabel('2024-03-11', '2024-03-17', 2026), '11 – 17 marca 2024')
  assert.equal(weekRangeLabel('2024-02-26', '2024-03-03', 2026), '26 lutego – 3 marca 2024')
  assert.equal(weekRangeLabel('2025-12-29', '2026-01-04', 2026), '29 grudnia 2025 – 4 stycznia 2026')
})

test('day heading adds the year only outside the current year', () => {
  assert.equal(dayHeadingLabel('2026-09-17', 2026), 'Czwartek, 17 września')
  assert.equal(dayHeadingLabel('2024-03-14', 2026), 'Czwartek, 14 marca 2024')
})

test('a month switch selects today, then the first day with sessions, then the 1st', () => {
  const sessions = [{ date: '2026-08-19' }, { date: '2026-08-05' }, { date: '2026-07-30' }]
  assert.equal(firstSessionDayInMonth('2026-08', sessions), '2026-08-05')
  assert.equal(monthSelectionDay('2026-08', sessions, '2026-09-23'), '2026-08-05')
  assert.equal(monthSelectionDay('2026-10', sessions, '2026-09-23'), '2026-10-01')
  assert.equal(monthSelectionDay('2026-09', sessions, '2026-09-23'), '2026-09-23')
})
