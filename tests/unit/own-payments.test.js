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

test('own-payment rows retain the exact Warsaw time and payment facts needed by the entry form', () => {
  const session = ownPayments.ownPaymentSession({
    id: 'apt_own_payment',
    startsAt: '2026-08-03T22:30:00.000Z',
    status: 'completed',
    cancellationReason: null,
    version: 4,
    charge: { expectedAmountGrosze: 18_000 },
    payment: {
      status: 'partial', collectedGrosze: 7_500, outstandingGrosze: 10_500,
      latestMethod: 'card', latestReceivedAt: '2026-08-04T10:00:00.000Z',
    },
  })

  assert.deepEqual(session, {
    id: 'apt_own_payment', date: '2026-08-04', time: '00:30',
    amount: 180, paidAmount: 75, method: 'card', payment: 'partial',
    status: 'completed', cancellationReason: null, version: 4,
  })
  assert.equal(Object.isFrozen(session), true)
})
