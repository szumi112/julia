import assert from 'node:assert/strict'
import test from 'node:test'
import { appointmentDto, paymentAggregate } from '../../src/core-records.js'
import { isBillable, paymentDisplayFor } from '../../src/format.js'
import {
  APPOINTMENT_CANCELLATION_REASONS,
  appointmentCancellationTarget,
  appointmentCancellationError,
  appointmentCancellationToastKey,
  appointmentRestorationError,
} from '../../src/appointment-cancellation.js'
import {
  digestCancelAppointmentRequest,
  digestRestoreAppointmentRequest,
  validateCancelAppointmentBody,
  validateRestoreAppointmentBody,
} from '../../worker/core/appointments.js'

const cancelledAppointment = (overrides = {}) => ({
  id: 'apt_cancelled', clientId: 'cl_child', specialistId: 'sp_anna',
  serviceId: 'zajecia', startsAt: '2026-09-14T08:00:00.000Z',
  endsAt: '2026-09-14T08:50:00.000Z', timeZone: 'Europe/Warsaw', location: null,
  status: 'cancelled', source: 'panel', version: 2,
  cancelledAt: '2026-09-13T10:00:00.000Z', cancellationReason: 'client',
  createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
  charge: {
    id: 'chg_cancelled', serviceId: 'zajecia', expectedAmountGrosze: 18_000,
    currency: 'PLN', version: 1,
  },
  paymentEntries: [], corrections: [], ...overrides,
})

test('cancellation and restoration command bodies are exact and canonical', async () => {
  for (const reason of ['client', 'centre', 'late_paid']) {
    assert.deepEqual(validateCancelAppointmentBody({ expectedVersion: 3, reason }), {
      expectedVersion: 3, reason,
    })
  }
  for (const value of [
    { expectedVersion: 3 },
    { expectedVersion: 3, reason: 'other' },
    { expectedVersion: 3, reason: 'client', extra: true },
  ]) assert.throws(() => validateCancelAppointmentBody(value), /VALIDATION_FAILED/)

  assert.deepEqual(validateRestoreAppointmentBody({ expectedVersion: 4 }), {
    expectedVersion: 4,
  })
  assert.throws(
    () => validateRestoreAppointmentBody({ expectedVersion: 4, reason: 'client' }),
    /VALIDATION_FAILED/,
  )
  assert.notEqual(
    await digestCancelAppointmentRequest('apt_cancelled', {
      expectedVersion: 3, reason: 'client',
    }),
    await digestCancelAppointmentRequest('apt_cancelled', {
      expectedVersion: 3, reason: 'centre',
    }),
  )
  assert.match(
    await digestRestoreAppointmentRequest('apt_cancelled', { expectedVersion: 4 }),
    /^[A-Za-z0-9_-]{43}$/,
  )
})

test('late-paid cancellation stays billable while other cancellation reasons do not', () => {
  assert.equal(isBillable({ status: 'cancelled', cancellationReason: 'late_paid' }), true)
  assert.equal(isBillable({ status: 'cancelled', cancellationReason: 'client' }), false)
  assert.equal(isBillable({ status: 'cancelled', cancellationReason: 'centre' }), false)
  assert.deepEqual(paymentDisplayFor({
    status: 'cancelled', cancellationReason: 'late_paid', payment: 'unpaid',
    date: '2026-09-14',
  }, '2026-09-13'), { kind: 'payment', label: 'Do zapłaty', tone: 'amber' })
  assert.deepEqual(paymentAggregate({
    appointmentId: 'apt_cancelled', status: 'cancelled', cancellationReason: 'late_paid',
    expectedAmountGrosze: 18_000, paymentEntries: [], corrections: [],
  }), {
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
    latestMethod: null, latestReceivedAt: null,
  })
})

test('appointment DTO carries a nullable validated cancellation reason', () => {
  assert.equal(appointmentDto(cancelledAppointment()).cancellationReason, 'client')
  assert.equal(appointmentDto(cancelledAppointment({
    status: 'scheduled', cancelledAt: null, cancellationReason: null,
  })).cancellationReason, null)
  assert.throws(
    () => appointmentDto(cancelledAppointment({ cancellationReason: 'private-note' })),
    /VALIDATION_FAILED\/cancellationReason/,
  )
  assert.throws(
    () => appointmentDto(cancelledAppointment({
      status: 'scheduled', cancelledAt: null, cancellationReason: 'client',
    })),
    /VALIDATION_FAILED\/appointment/,
  )
})

test('cancellation UI model has no implicit reason and stable concrete feedback', () => {
  assert.deepEqual(APPOINTMENT_CANCELLATION_REASONS, [
    { value: 'client', label: 'Odwołanie przez klienta' },
    { value: 'centre', label: 'Odwołanie przez centrum' },
    { value: 'late_paid', label: 'Późne odwołanie - płatne' },
  ])
  assert.equal(appointmentCancellationToastKey('apt_cancelled'), 'appointment-cancellation-apt_cancelled')
  assert.deepEqual(appointmentCancellationTarget({ id: 's12' }, 'demo'), {
    id: 'apt_demo_s12', version: 1,
  })
  assert.deepEqual(appointmentCancellationTarget({
    id: 's13', workspaceId: 'apt_demo_new_4', version: 3,
  }, 'demo'), { id: 'apt_demo_new_4', version: 3 })
  assert.deepEqual(appointmentCancellationTarget({ id: 'apt_one', version: 7 }, 'app'), {
    id: 'apt_one', version: 7,
  })
  assert.equal(
    appointmentCancellationError({ code: 'APPOINTMENT_PAYMENT_CONFLICT' }),
    'Nie można odwołać sesji z zaksięgowaną wpłatą.',
  )
  assert.equal(
    appointmentCancellationError({ message: 'APPOINTMENT_PAYMENT_CONFLICT/payment' }),
    'Nie można odwołać sesji z zaksięgowaną wpłatą.',
  )
  assert.equal(
    appointmentCancellationError({ code: 'VERSION_CONFLICT' }),
    'Sesja została zmieniona. Odśwież Grafik i spróbuj ponownie.',
  )
  assert.equal(
    appointmentRestorationError({ code: 'APPOINTMENT_OVERLAP' }),
    'Nie można przywrócić sesji, ponieważ ten termin jest już zajęty.',
  )
  assert.equal(
    appointmentRestorationError({ code: 'APPOINTMENT_PAYMENT_CONFLICT' }),
    'Nie można przywrócić sesji z zaksięgowaną wpłatą.',
  )
})
