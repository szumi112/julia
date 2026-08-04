import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appointmentCompatibilityDto,
  appointmentDto,
  addElapsedMinutes,
  assertClientArchivable,
  assertAppointmentTransition,
  assertClientStatusTransition,
  assertCorrection,
  assertEffectiveAssignment,
  assertExactObject,
  assertNfcTrimmed,
  assertServiceSnapshot,
  hasSpecialistOverlap,
  isAppointmentId,
  isClientId,
  paymentAggregate,
  clientDto,
  validateAppointmentInput,
  validateClientInput,
  validateCorrectionInput,
  validatePaymentInput,
  validateWarsawDateWindow,
  warsawDateTimeToUtc,
  warsawDateFromUtc,
  warsawDateTimeFromUtc,
  warsawNoonToUtc,
} from '../../src/core-records.js'

test('core records reject unknown object keys and entity-mismatched identifiers', () => {
  assert.doesNotThrow(() => assertExactObject({ name: 'Ada' }, ['name']))
  assert.throws(() => assertExactObject({ name: 'Ada', phone: '' }, ['name']), /VALIDATION_FAILED\/object/)
  assert.equal(isClientId('cl_abc-123'), true)
  assert.equal(isClientId('sp_abc-123'), false)
  assert.equal(isAppointmentId('apt_abc-123'), true)
  assert.equal(isAppointmentId('cl_abc-123'), false)
})

test('command inputs have closed keys and canonical core values', () => {
  assert.deepEqual(validateClientInput({ name: 'Ada', age: 8, status: 'active', specialistId: 'sp_one' }), {
    name: 'Ada', age: 8, status: 'active', specialistId: 'sp_one',
  })
  assert.throws(() => validateClientInput({ name: 'Ada', age: 8, status: 'active', specialistId: 'sp_one', email: '' }), /VALIDATION_FAILED\/object/)
  assert.deepEqual(validateAppointmentInput({
    clientId: 'cl_one', specialistId: 'sp_one', serviceId: 'zajecia', date: '2026-08-04', time: '09:15', durationMinutes: 50,
    expectedAmountGrosze: 18000, location: null, status: 'completed',
  }), {
    clientId: 'cl_one', specialistId: 'sp_one', serviceId: 'zajecia', startsAt: '2026-08-04T07:15:00.000Z', endsAt: '2026-08-04T08:05:00.000Z',
    durationMinutes: 50, expectedAmountGrosze: 18000, location: null, status: 'completed', timeZone: 'Europe/Warsaw',
  })
  assert.throws(() => validatePaymentInput({ amountGrosze: 1, method: 'monthly', receivedAt: '2026-08-04T10:00:00.000Z', paidDate: '2026-08-04' }), /VALIDATION_FAILED\/object/)
})

test('core records require already trimmed NFC strings and bounded snapshots', () => {
  assert.equal(assertNfcTrimmed('Żaneta', { field: 'name', minBytes: 1, maxBytes: 120 }), 'Żaneta')
  assert.throws(() => assertNfcTrimmed(' Żaneta', { field: 'name', minBytes: 1, maxBytes: 120 }), /VALIDATION_FAILED\/name/)
  assert.throws(() => assertNfcTrimmed('Z\u0307aneta', { field: 'name', minBytes: 1, maxBytes: 120 }), /VALIDATION_FAILED\/name/)
  assert.throws(() => assertNfcTrimmed('x'.repeat(121), { field: 'name', minBytes: 1, maxBytes: 120 }), /VALIDATION_FAILED\/name/)
  assert.deepEqual(assertServiceSnapshot({ serviceId: 'zajecia', durationMinutes: 50, expectedAmountGrosze: 18000 }), {
    serviceId: 'zajecia', durationMinutes: 50, expectedAmountGrosze: 18000,
  })
  assert.throws(() => assertServiceSnapshot({ serviceId: 'zajecia', durationMinutes: 60, expectedAmountGrosze: 18000 }), /VALIDATION_FAILED\/durationMinutes/)
})

test('core record status transitions preserve archival and cancellation terminality', () => {
  assert.doesNotThrow(() => assertClientStatusTransition('active', 'paused'))
  assert.throws(() => assertClientStatusTransition('archived', 'active'), /CLIENT_STATUS_CONFLICT/)
  assert.doesNotThrow(() => assertAppointmentTransition('scheduled', 'completed'))
  assert.doesNotThrow(() => assertAppointmentTransition('scheduled', 'cancelled', { cancellation: true }))
  assert.throws(() => assertAppointmentTransition('scheduled', 'cancelled'), /VALIDATION_FAILED\/status/)
  assert.throws(() => assertAppointmentTransition('cancelled', 'completed'), /APPOINTMENT_STATUS_CONFLICT/)
})

test('specialist intervals are half-open so back-to-back appointments remain valid', () => {
  const appointments = [{ id: 'apt_first', specialistId: 'sp_one', startsAt: '2026-08-04T08:00:00.000Z', endsAt: '2026-08-04T08:50:00.000Z', status: 'scheduled' }]
  assert.equal(hasSpecialistOverlap(appointments, { specialistId: 'sp_one', startsAt: '2026-08-04T08:50:00.000Z', endsAt: '2026-08-04T09:40:00.000Z' }), false)
  assert.equal(hasSpecialistOverlap(appointments, { specialistId: 'sp_one', startsAt: '2026-08-04T08:49:59.999Z', endsAt: '2026-08-04T09:40:00.000Z' }), true)
  assert.equal(hasSpecialistOverlap(appointments, { specialistId: 'sp_one', startsAt: '2026-08-04T08:10:00.000Z', endsAt: '2026-08-04T08:20:00.000Z', status: 'cancelled' }), false)
})

test('assignment and client archive rules retain effective history', () => {
  const assignment = { id: 'asg_one', clientId: 'cl_one', specialistId: 'sp_one', startsAt: '2026-08-01T10:00:00.000Z', endsAt: null, version: 1 }
  assert.equal(assertEffectiveAssignment([assignment], 'cl_one', 'sp_one', '2026-08-02T10:00:00.000Z'), assignment)
  assert.doesNotThrow(() => assertClientArchivable([{ status: 'cancelled', startsAt: '2026-08-03T10:00:00.000Z' }], '2026-08-02T10:00:00.000Z'))
  assert.throws(() => assertClientArchivable([{ status: 'scheduled', startsAt: '2026-08-03T10:00:00.000Z' }], '2026-08-02T10:00:00.000Z'), /CLIENT_STATUS_CONFLICT/)
  assert.throws(() => validateAppointmentInput({ clientId: 'cl_one', specialistId: 'sp_one', serviceId: 'zajecia', date: '2026-03-29', time: '02:10', durationMinutes: 50, expectedAmountGrosze: 18000, location: null, status: 'scheduled' }), /VALIDATION_FAILED\/dateTime/)
  assert.throws(() => assertClientStatusTransition('paused', 'paused'), /VALIDATION_FAILED\/status/)
})

test('payment aggregate excludes reversed entries, uses the last effective entry, and bounds collection', () => {
  const aggregate = paymentAggregate({
    status: 'completed',
    expectedAmountGrosze: 18000,
    paymentEntries: [
      { id: 'pay_first', appointmentId: 'apt_one', amountGrosze: 5000, method: 'cash', receivedAt: '2026-08-01T10:00:00.000Z' },
      { id: 'pay_replacement', appointmentId: 'apt_one', amountGrosze: 18000, method: 'transfer', receivedAt: '2026-08-02T10:00:00.000Z' },
    ],
    corrections: [{ reversedEntryId: 'pay_first', replacementEntryId: 'pay_replacement' }],
  })
  assert.deepEqual(aggregate, {
    status: 'paid', collectedGrosze: 18000, outstandingGrosze: 0,
    latestMethod: 'transfer', latestReceivedAt: '2026-08-02T10:00:00.000Z',
  })
  assert.throws(() => paymentAggregate({ status: 'completed', expectedAmountGrosze: 100, paymentEntries: [{ id: 'pay_one', appointmentId: 'apt_one', amountGrosze: 101, method: 'cash', receivedAt: '2026-08-01T10:00:00.000Z' }], corrections: [] }), /PAYMENT_AMOUNT_CONFLICT/)
  assert.throws(() => assertCorrection({ reason: ' ', reversedEntry: { id: 'pay_one', appointmentId: 'apt_one' }, replacement: null }), /VALIDATION_FAILED\/reason/)
  assert.throws(() => assertCorrection({ reason: 'Zwrot', reversedEntry: { id: 'pay_one', appointmentId: 'apt_one' }, replacement: { id: 'pay_two', appointmentId: 'apt_other' } }), /VALIDATION_FAILED\/replacement/)
  assert.deepEqual(validateCorrectionInput({ reason: 'Zwrot', replacement: { amountGrosze: 5000, method: 'card', receivedAt: '2026-08-03T10:00:00.000Z' } }), {
    reason: 'Zwrot', replacement: { amountGrosze: 5000, method: 'card', receivedAt: '2026-08-03T10:00:00.000Z' },
  })
})

test('Warsaw date conversion handles ordinary time and UTC rollover', () => {
  assert.equal(warsawDateTimeToUtc('2026-08-04', '09:15'), '2026-08-04T07:15:00.000Z')
  assert.deepEqual(warsawDateTimeFromUtc('2026-08-03T22:30:00.000Z'), { date: '2026-08-04', time: '00:30' })
  assert.equal(warsawDateFromUtc('2026-08-03T22:30:00.000Z'), '2026-08-04')
})

test('Warsaw date conversion rejects nonexistent and ambiguous DST wall times', () => {
  assert.throws(() => warsawDateTimeToUtc('2026-03-29', '02:30'), /VALIDATION_FAILED\/dateTime/)
  assert.throws(() => warsawDateTimeToUtc('2026-10-25', '02:30'), /VALIDATION_FAILED\/dateTime/)
  assert.equal(warsawDateTimeToUtc('2026-03-29', '03:30'), '2026-03-29T01:30:00.000Z')
  assert.equal(warsawDateTimeToUtc('2026-10-25', '03:30'), '2026-10-25T02:30:00.000Z')
  assert.equal(addElapsedMinutes(warsawDateTimeToUtc('2026-03-29', '01:30'), 60), '2026-03-29T01:30:00.000Z')
})

test('Warsaw inclusive date windows have exact 1..93 day bounds', () => {
  assert.deepEqual(validateWarsawDateWindow('2026-03-29', '2026-03-29'), {
    from: '2026-03-29', to: '2026-03-29', startsAt: '2026-03-28T23:00:00.000Z', endsAt: '2026-03-29T22:00:00.000Z', timeZone: 'Europe/Warsaw',
  })
  assert.doesNotThrow(() => validateWarsawDateWindow('2026-01-01', '2026-04-03'))
  assert.throws(() => validateWarsawDateWindow('2026-01-01', '2026-04-04'), /VALIDATION_FAILED\/window/)
})

test('paid dates use unambiguous Warsaw noon and compatibility DTOs mark archived clients readonly', () => {
  assert.equal(warsawNoonToUtc('2026-08-04'), '2026-08-04T10:00:00.000Z')
  assert.equal(warsawNoonToUtc('2026-01-04'), '2026-01-04T11:00:00.000Z')
  assert.deepEqual(appointmentCompatibilityDto({
    id: 'apt_one', clientId: 'cl_one', specialistId: 'sp_one', serviceId: 'zajecia', startsAt: '2026-08-04T07:15:00.000Z', endsAt: '2026-08-04T08:05:00.000Z',
    status: 'completed', expectedAmountGrosze: 18000, paymentEntries: [], corrections: [], client: { id: 'cl_one', name: 'Ada', age: 8, status: 'archived', version: 2, archivedAt: '2026-08-01T10:00:00.000Z', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z' },
  }).client.readOnly, true)
  const client = { id: 'cl_one', name: 'Ada', age: 8, status: 'archived', version: 2, archivedAt: '2026-08-01T10:00:00.000Z', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z' }
  assert.deepEqual(Object.keys(clientDto(client)).sort(), ['age', 'archivedAt', 'assignment', 'createdAt', 'id', 'name', 'readOnly', 'status', 'updatedAt', 'version'])
  assert.deepEqual(Object.keys(appointmentDto({ id: 'apt_one', clientId: 'cl_one', specialistId: 'sp_one', serviceId: 'zajecia', startsAt: '2026-08-04T07:15:00.000Z', endsAt: '2026-08-04T08:05:00.000Z', status: 'scheduled', expectedAmountGrosze: 18000 })).sort(), ['cancelledAt', 'charge', 'clientId', 'createdAt', 'endsAt', 'id', 'location', 'payment', 'paymentEntries', 'serviceId', 'source', 'specialistId', 'startsAt', 'status', 'timeZone', 'updatedAt', 'version'])
})
