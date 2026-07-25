import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SERVICES, SERVICE_BY_ID, STANDARD_SERVICE,
  amountFor, durationFor, serviceBadge, serviceLabel, serviceShort,
} from '../../src/services.js'

test('every catalogue position has a unique id, a positive price and a slot length', () => {
  const ids = SERVICES.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique')
  for (const service of SERVICES) {
    assert.ok(service.label.trim(), `${service.id} needs a label`)
    assert.ok(Number.isInteger(service.price) && service.price > 0, `${service.id} needs a price`)
    assert.ok(Number.isInteger(service.duration) && service.duration > 0, `${service.id} needs a duration`)
  }
})

test('the catalogue matches the published cennik', () => {
  // spot-checks against bearwithme.pl/Cennik — these are the client's numbers
  assert.equal(SERVICE_BY_ID.konsultacja.price, 250)
  assert.equal(SERVICE_BY_ID.konsultacja.duration, 90)
  assert.equal(SERVICE_BY_ID.zajecia.price, 180)
  assert.equal(SERVICE_BY_ID.zajecia.duration, 50)
  assert.equal(SERVICE_BY_ID['terapia-rodzinna'].price, 220)
  assert.equal(SERVICE_BY_ID['terapia-rodzinna'].duration, 60)
  assert.equal(SERVICE_BY_ID.asrs.price, 400)
  assert.equal(SERVICE_BY_ID.conners.price, 600)
  assert.equal(SERVICE_BY_ID['obserwacja-placowka'].price, 450)
  assert.equal(SERVICE_BY_ID['obserwacja-dom'].price, 450)
  assert.equal(SERVICE_BY_ID.warsztaty.price, 120)
})

test('the standard session bills at the specialist rate, everything else at catalogue price', () => {
  assert.equal(amountFor(STANDARD_SERVICE, { rate: 200 }), 200)
  assert.equal(amountFor(STANDARD_SERVICE, { rate: 0 }), 180, 'a zero rate falls back to the cennik')
  assert.equal(amountFor(STANDARD_SERVICE, undefined), 180)
  // a fixed position ignores the specialist's own rate
  assert.equal(amountFor('conners', { rate: 200 }), 600)
  assert.equal(amountFor('asrs', undefined), 400)
})

test('unknown service ids fall back instead of throwing', () => {
  assert.equal(amountFor('nie-ma-takiej', { rate: 210 }), 210)
  assert.equal(amountFor('nie-ma-takiej', undefined), 180)
  assert.equal(durationFor('nie-ma-takiej'), 50)
  assert.equal(serviceLabel('nie-ma-takiej'), 'Zajęcia psychologiczne')
})

test('labels shorten for dense rows and the standard session stays unbadged', () => {
  assert.equal(serviceShort('asrs'), 'Diagnoza ASRS')
  assert.equal(serviceShort('conners'), 'Test Conners 3')
  assert.equal(serviceShort(STANDARD_SERVICE), 'Zajęcia psychologiczne')

  assert.equal(serviceBadge(STANDARD_SERVICE), '')
  assert.equal(serviceBadge(undefined), '')
  assert.equal(serviceBadge('konsultacja'), 'Pierwsza konsultacja')
})
