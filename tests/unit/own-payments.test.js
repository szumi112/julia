import assert from 'node:assert/strict'
import test from 'node:test'

import * as ownPayments from '../../src/own-payments.js'

test('own-payment rows project late UTC appointments onto their Warsaw civil date', () => {
  assert.equal(typeof ownPayments.ownPaymentCivilDate, 'function')
  assert.equal(
    ownPayments.ownPaymentCivilDate('2026-08-03T22:30:00.000Z'),
    '2026-08-04',
  )
})
