import test from 'node:test'
import assert from 'node:assert/strict'
import {
  captureSpecialistAbsence,
  captureSpecialistAbsenceInput,
} from '../../src/specialist-absences.js'

test('specialist absence input accepts only all-day inclusive civil date ranges', () => {
  assert.deepEqual(captureSpecialistAbsenceInput({
    specialistId: 'sp_absence_test', dateFrom: '2026-09-13', dateTo: '2026-09-15', allDay: true,
  }), {
    specialistId: 'sp_absence_test', dateFrom: '2026-09-13', dateTo: '2026-09-15', allDay: true,
  })
  assert.throws(() => captureSpecialistAbsenceInput({
    specialistId: 'sp_absence_test', dateFrom: '2026-09-15', dateTo: '2026-09-13', allDay: true,
  }), /VALIDATION_FAILED\/dateRange/)
  assert.throws(() => captureSpecialistAbsenceInput({
    specialistId: 'sp_absence_test', dateFrom: '2026-09-13', dateTo: '2026-09-15', allDay: false,
  }), /VALIDATION_FAILED\/allDay/)
})

test('specialist absence DTO captures active and softly cancelled records', () => {
  const value = captureSpecialistAbsence({
    id: 'abs_absence_test', specialistId: 'sp_absence_test',
    dateFrom: '2026-09-13', dateTo: '2026-09-15', allDay: true,
    version: 2, createdAt: '2026-09-13T08:00:00.000Z',
    cancelledAt: '2026-09-13T09:00:00.000Z',
  })
  assert.equal(value.cancelledAt, '2026-09-13T09:00:00.000Z')
  assert.throws(() => captureSpecialistAbsence({ ...value, dateTo: '2026-09-12' }), /VALIDATION_FAILED\/dateRange/)
})
