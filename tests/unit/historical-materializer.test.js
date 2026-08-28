import assert from 'node:assert/strict'
import test from 'node:test'

import {
  historicalProjectionDecision,
  exactHistoricalServiceId,
} from '../../worker/core/historical-materializer.js'

test('historical projection accepts only linked clinical income with authenticated identity', () => {
  const base = {
    recordType: 'income', counterparty: 'Ola Fikcyjna',
    sourceLabel: 'Zajęcia psychologiczne', periodPrecision: 'day',
    occurredOn: '2025-01-02', periodMonth: '2025-01', specialistId: 'sp_julia',
    financeLinked: true, voided: false,
  }
  assert.deepEqual(historicalProjectionDecision(base), {
    eligible: true, classification: 'person', serviceId: 'zajecia', conflictKind: null,
  })
  for (const override of [
    { recordType: 'expense' }, { recordType: 'tus' }, { recordType: 'english' },
    { counterparty: '' }, { financeLinked: false }, { voided: true },
  ]) assert.deepEqual(historicalProjectionDecision({ ...base, ...override }), {
    eligible: false, classification: null, serviceId: null, conflictKind: null,
  })
})

test('historical projection never guesses ambiguous subjects or non-exact catalogue services', () => {
  assert.equal(exactHistoricalServiceId('Pierwsza konsultacja'), 'konsultacja')
  assert.equal(exactHistoricalServiceId('pierwsza konsultacja'), 'konsultacja')
  assert.equal(exactHistoricalServiceId('Konsultacja pierwsza'), null)
  assert.deepEqual(historicalProjectionDecision({
    recordType: 'income', counterparty: 'Ola', sourceLabel: 'Konsultacja pierwsza',
    periodPrecision: 'unknown', occurredOn: null, periodMonth: null,
    specialistId: 'sp_julia', financeLinked: true, voided: false,
  }), {
    eligible: true, classification: 'review', serviceId: null,
    conflictKind: 'classification',
  })
  assert.deepEqual(historicalProjectionDecision({
    recordType: 'income', counterparty: 'Ola Fikcyjna',
    sourceLabel: 'Konsultacja pierwsza', periodPrecision: 'month',
    occurredOn: null, periodMonth: '2025-01', specialistId: 'sp_julia',
    financeLinked: true, voided: false,
  }), {
    eligible: true, classification: 'person', serviceId: null, conflictKind: 'service',
  })
})
