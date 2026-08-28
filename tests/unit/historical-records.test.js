import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalHistoricalName,
  captureHistoricalClient,
  captureHistoricalOccurrence,
  captureHistoricalResolution,
  classifyHistoricalSubject,
  compareHistoricalOccurrences,
  historicalNamesMatchExactly,
  historicalNamesRequireReview,
} from '../../src/historical-records.js'

const NOW = '2027-02-10T08:00:00.000Z'

test('historical periods preserve day, month, and unknown precision without invented facts', () => {
  const base = {
    id: 'hoc_one', historicalClientId: 'hcl_one', counterparty: null,
    specialistId: 'sp_one', serviceId: null, serviceLabel: 'Niestandardowa usługa',
    status: 'recorded', version: 1, sourceRecordId: 'wbs_one', createdAt: NOW,
    updatedAt: NOW,
  }
  assert.deepEqual(captureHistoricalOccurrence({
    ...base, period: { precision: 'day', day: '2025-01-31', month: '2025-01' },
  }).period, { precision: 'day', day: '2025-01-31', month: '2025-01' })
  assert.deepEqual(captureHistoricalOccurrence({
    ...base, id: 'hoc_two', sourceRecordId: 'wbs_two',
    period: { precision: 'month', day: null, month: '2025-02' },
  }).period, { precision: 'month', day: null, month: '2025-02' })
  assert.deepEqual(captureHistoricalOccurrence({
    ...base, id: 'hoc_three', sourceRecordId: 'wbs_three',
    period: { precision: 'unknown', day: null, month: null },
  }).period, { precision: 'unknown', day: null, month: null })
  assert.throws(() => captureHistoricalOccurrence({
    ...base, period: { precision: 'month', day: '2025-02-01', month: '2025-02' },
  }), /Invalid historical period/)
  assert.equal(Object.hasOwn(captureHistoricalOccurrence({
    ...base, period: { precision: 'unknown', day: null, month: null },
  }), 'amountGrosze'), false)
})

test('historical occurrence subject is exactly one client or named counterparty', () => {
  const base = {
    id: 'hoc_subject', specialistId: 'sp_one', serviceId: 'zajecia',
    serviceLabel: 'Zajęcia psychologiczne',
    period: { precision: 'month', day: null, month: '2025-01' },
    status: 'recorded', version: 1, sourceRecordId: 'wbs_subject',
    createdAt: NOW, updatedAt: NOW,
  }
  assert.equal(captureHistoricalOccurrence({
    ...base, historicalClientId: null,
    counterparty: { id: 'hcp_school', name: 'Szkoła Fikcyjna' },
  }).counterparty.name, 'Szkoła Fikcyjna')
  assert.throws(() => captureHistoricalOccurrence({
    ...base, historicalClientId: 'hcl_one',
    counterparty: { id: 'hcp_school', name: 'Szkoła Fikcyjna' },
  }), /Invalid historical occurrence/)
})

test('canonical person equality preserves diacritics and token order', () => {
  assert.equal(canonicalHistoricalName('  Żaneta   Nowak  '), 'żaneta nowak')
  assert.equal(historicalNamesMatchExactly('Żaneta Nowak', '  żANETA  NOWAK '), true)
  assert.equal(historicalNamesMatchExactly('Żaneta Nowak', 'Zaneta Nowak'), false)
  assert.equal(historicalNamesMatchExactly('Żaneta Nowak', 'Nowak Żaneta'), false)
  assert.equal(historicalNamesRequireReview('Żaneta Nowak', 'Zaneta Nowak'), true)
  assert.equal(historicalNamesRequireReview('Żaneta Nowak', 'Nowak Żaneta'), true)
  assert.equal(historicalNamesRequireReview('Żaneta Nowak', 'Żaneta Nowakk'), true)
  assert.equal(historicalNamesRequireReview('Żaneta Nowak', 'Karolina Zielińska'), false)
})

test('classification is conservative for people, organizations, supervision, and ambiguity', () => {
  assert.equal(classifyHistoricalSubject({
    counterparty: 'Julia Fikcyjna', serviceLabel: 'Zajęcia psychologiczne',
  }), 'person')
  assert.equal(classifyHistoricalSubject({
    counterparty: 'Szkoła Podstawowa nr 1', serviceLabel: 'Konsultacja',
  }), 'counterparty')
  assert.equal(classifyHistoricalSubject({
    counterparty: 'Anna Fikcyjna', serviceLabel: 'Superwizja zespołu',
  }), 'counterparty')
  assert.equal(classifyHistoricalSubject({
    counterparty: 'Ola', serviceLabel: 'Konsultacja',
  }), 'review')
})

test('historical DTOs and resolution vocabulary are exact and deterministically sorted', () => {
  const client = captureHistoricalClient({
    id: 'hcl_one', name: 'Ola Fikcyjna', status: 'historical', activeClientId: null,
    version: 1, createdAt: NOW, updatedAt: NOW,
  })
  assert.equal(Object.isFrozen(client), true)
  assert.equal(captureHistoricalClient({
    ...client, status: 'activated', activeClientId: null,
  }).activeClientId, null)
  assert.throws(() => captureHistoricalClient({ ...client, age: 12 }), /Invalid historical client/)
  assert.deepEqual(captureHistoricalResolution({
    expectedJobVersion: 2, conflictId: 'hcf_one', classification: 'person',
    existingSubjectId: null, serviceId: null,
  }), {
    expectedJobVersion: 2, conflictId: 'hcf_one', classification: 'person',
    existingSubjectId: null, serviceId: null,
  })
  assert.throws(() => captureHistoricalResolution({
    expectedJobVersion: 2, conflictId: 'hcf_one', classification: 'patient',
    existingSubjectId: null, serviceId: null,
  }), /Invalid historical resolution/)
  assert.throws(() => captureHistoricalResolution({
    expectedJobVersion: 2, conflictId: 'hcf_one', classification: 'person',
    existingSubjectId: 'hcp_wrong_kind', serviceId: null,
  }), /Invalid historical resolution/)
  assert.throws(() => captureHistoricalResolution({
    expectedJobVersion: 2, conflictId: 'hcf_one', classification: 'exclude',
    existingSubjectId: null, serviceId: 'zajecia',
  }), /Invalid historical resolution/)
  assert.throws(() => captureHistoricalClient({
    ...client, name: 'Ola\u200b Fikcyjna',
  }), /Invalid historical client/)
  const earlier = { id: 'hoc_b', period: { precision: 'unknown', day: null, month: null } }
  const later = { id: 'hoc_a', period: { precision: 'day', day: '2025-01-01', month: '2025-01' } }
  assert.deepEqual([earlier, later].sort(compareHistoricalOccurrences).map(({ id }) => id), [
    'hoc_a', 'hoc_b',
  ])
})
