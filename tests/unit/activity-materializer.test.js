import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureActivityProjectionItem,
  summarizeActivityProjection,
} from '../../worker/core/activity-materializer.js'

const item = (overrides = {}) => ({
  sourceRecordId: 'wbs_tus_one', financeEntryId: 'fin_tus_one', recordType: 'tus',
  accountingMonth: '2025-01', occurredOn: null,
  participantIdentity: 'Ola Fikcyjna', groupLabel: 'Grupa TUS — Sowy', lessonCount: null,
  specialistId: 'sp_julia', resolutionId: 'wbr_julia', ...overrides,
})

test('projection items preserve only authenticated TUS and English facts', () => {
  assert.deepEqual(captureActivityProjectionItem(item()), item())
  assert.deepEqual(captureActivityProjectionItem(item({
    sourceRecordId: 'wbs_tus_day', financeEntryId: 'fin_tus_day',
    occurredOn: '2025-01-17',
  })).occurredOn, '2025-01-17')
  const english = captureActivityProjectionItem(item({
    sourceRecordId: 'wbs_english_zero', financeEntryId: 'fin_english_zero',
    recordType: 'english', groupLabel: null, lessonCount: 0,
  }))
  assert.equal(english.lessonCount, 0)
  assert.equal(Object.isFrozen(english), true)
  for (const hostile of [
    item({ recordType: 'income' }),
    item({ accountingMonth: '2025-13' }),
    item({ occurredOn: '2025-02-01' }),
    item({ recordType: 'english', groupLabel: 'Invented', lessonCount: 2 }),
    item({ recordType: 'english', groupLabel: null, lessonCount: null }),
    { ...item(), resolvedByStaffId: 'stf_resolver' },
    { ...item(), amountGrosze: 34000 },
    { ...item(), classes: [] },
  ]) assert.throws(() => captureActivityProjectionItem(hostile), /ACTIVITY_PROJECTION_INVALID/)
})

test('projection day precision uses proleptic Gregorian years without Date remapping', () => {
  for (const [accountingMonth, occurredOn] of [
    ['0001-01', '0001-01-01'],
    ['0004-02', '0004-02-29'],
  ]) assert.equal(captureActivityProjectionItem(item({
    accountingMonth, occurredOn,
  })).occurredOn, occurredOn)
  for (const [accountingMonth, occurredOn] of [
    ['0000-01', '0000-01-01'],
    ['0001-02', '0001-02-29'],
    ['0100-02', '0100-02-29'],
  ]) assert.throws(() => captureActivityProjectionItem(item({
    accountingMonth, occurredOn,
  })), /ACTIVITY_PROJECTION_INVALID/)
})

test('reconciliation preserves exactly 25 TUS and 165 English observations', () => {
  const items = []
  for (let index = 0; index < 25; index += 1) items.push(item({
    sourceRecordId: `wbs_tus_${index}`, financeEntryId: `fin_tus_${index}`,
    accountingMonth: `2025-${String((index % 12) + 1).padStart(2, '0')}`,
    occurredOn: index < 2 ? `2025-0${index + 1}-15` : null,
    participantIdentity: `Dziecko Fikcyjne ${index}`, groupLabel: 'Grupa TUS — Sowy',
  }))
  for (let index = 0; index < 165; index += 1) items.push(item({
    sourceRecordId: `wbs_english_${index}`, financeEntryId: `fin_english_${index}`,
    recordType: 'english',
    accountingMonth: `2025-${String((index % 12) + 1).padStart(2, '0')}`,
    participantIdentity: `Uczeń Fikcyjny ${index}`, groupLabel: null,
    lessonCount: index === 0 ? 0 : (index % 8) + 1,
  }))
  const summary = summarizeActivityProjection(items)
  assert.deepEqual(summary, {
    totalRecords: 190,
    tusRecords: 25,
    tusDayRecords: 2,
    tusMonthRecords: 23,
    englishRecords: 165,
    englishMonthRecords: 165,
    explicitZeroLessonRecords: 1,
    classRecords: 0,
    attendanceRecords: 0,
    paymentRecords: 0,
  })
  assert.equal(Object.isFrozen(summary), true)
})

test('reconciliation rejects duplicate source or finance authority', () => {
  assert.throws(() => summarizeActivityProjection([
    item(), item({ sourceRecordId: 'wbs_tus_two' }),
  ]), /ACTIVITY_PROJECTION_CONFLICT/)
  assert.throws(() => summarizeActivityProjection([
    item(), item({ financeEntryId: 'fin_tus_two' }),
  ]), /ACTIVITY_PROJECTION_CONFLICT/)
})
