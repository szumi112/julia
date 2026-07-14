import assert from 'node:assert/strict'
import test from 'node:test'
import { fmtMoney } from '../../src/format.js'

test('money formatting preserves cents only for fractional złoty values', () => {
  assert.equal(fmtMoney(91.79), '91,79\u00a0zł')
  assert.equal(fmtMoney(8.21), '8,21\u00a0zł')
  assert.equal(fmtMoney(0.49), '0,49\u00a0zł')
  assert.equal(fmtMoney(220), '220\u00a0zł')
  assert.equal(fmtMoney('not-a-number'), '0\u00a0zł')
})
