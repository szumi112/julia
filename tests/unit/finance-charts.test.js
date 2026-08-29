import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SERVICE_RANK_LIMIT,
  paymentMixParts,
  serviceRevenueRanks,
} from '../../src/finance-charts.js'

describe('paymentMixParts', () => {
  it('keeps positive methods sorted by amount then Polish label', () => {
    const parts = paymentMixParts({
      blik: 5000, card: 20000, cash: 0, monthly: 20000,
      other: 0, transfer: 90000, unknown: 100, outstanding: 70000,
    })
    assert.deepEqual(parts.map(({ id }) => id), ['transfer', 'card', 'monthly', 'blik', 'unknown'])
    assert.deepEqual(parts[0], {
      id: 'transfer', label: 'Przelew', tone: 'sky-deep', value: 90000,
    })
    assert.deepEqual(parts[1], { id: 'card', label: 'Karta', tone: 'coral', value: 20000 })
    assert.deepEqual(parts[2], {
      id: 'monthly', label: 'Miesięcznie', tone: 'amber', value: 20000,
    })
    assert.ok(Object.isFrozen(parts))
    assert.ok(Object.isFrozen(parts[0]))
  })

  it('returns an empty list when nothing was collected', () => {
    assert.deepEqual(paymentMixParts({ outstanding: 12300 }), [])
    assert.deepEqual(paymentMixParts({}), [])
  })

  it('rejects invalid input', () => {
    assert.throws(() => paymentMixParts(null), TypeError)
    assert.throws(() => paymentMixParts([]), TypeError)
    assert.throws(() => paymentMixParts({ voucher: 100 }), TypeError)
    assert.throws(() => paymentMixParts({ cash: 10.5 }), TypeError)
    assert.throws(() => paymentMixParts({ cash: -1 }), TypeError)
  })
})

describe('serviceRevenueRanks', () => {
  const labelFor = (id) => (id === 'konsultacja' ? 'Konsultacja psychologiczna' : id)

  it('ranks by revenue and applies the label resolver', () => {
    const ranks = serviceRevenueRanks(
      { konsultacja: 90000, superwizja: 30000, 'Nie ustalono': 5000 },
      labelFor,
    )
    assert.deepEqual(ranks, [
      { id: 'konsultacja', label: 'Konsultacja psychologiczna', value: 90000 },
      { id: 'superwizja', label: 'superwizja', value: 30000 },
      { id: 'Nie ustalono', label: 'Nie ustalono', value: 5000 },
    ])
    assert.ok(Object.isFrozen(ranks))
    assert.ok(Object.isFrozen(ranks[0]))
  })

  it('buckets everything past the limit into Pozostałe', () => {
    const split = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, index) => [id, (7 - index) * 1000]),
    )
    const ranks = serviceRevenueRanks(split, (id) => id, 5)
    assert.equal(ranks.length, 6)
    assert.deepEqual(ranks.at(-1), { id: 'rest', label: 'Pozostałe', value: 3000 })
    assert.equal(SERVICE_RANK_LIMIT, 5)
  })

  it('drops zero rows and handles an empty split', () => {
    assert.deepEqual(serviceRevenueRanks({ konsultacja: 0 }, labelFor), [])
    assert.deepEqual(serviceRevenueRanks({}, labelFor), [])
  })

  it('rejects invalid input', () => {
    assert.throws(() => serviceRevenueRanks(null, labelFor), TypeError)
    assert.throws(() => serviceRevenueRanks({}, 'not a function'), TypeError)
    assert.throws(() => serviceRevenueRanks({ konsultacja: 1 }, labelFor, 0), TypeError)
    assert.throws(() => serviceRevenueRanks({ konsultacja: 1.5 }, labelFor), TypeError)
  })
})
