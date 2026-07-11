import assert from 'node:assert/strict'
import test from 'node:test'
import { pageCount, pageSlice } from '../../src/pagination.js'

test('an empty list still has one page', () => {
  assert.equal(pageCount(0, 25), 1)
})

test('page count rounds up partial pages', () => {
  assert.equal(pageCount(25, 25), 1)
  assert.equal(pageCount(26, 25), 2)
  assert.equal(pageCount(51, 25), 3)
})

test('pageSlice returns the requested 1-based page', () => {
  const items = Array.from({ length: 30 }, (_, i) => i)
  assert.deepEqual(pageSlice(items, 1, 25), items.slice(0, 25))
  assert.deepEqual(pageSlice(items, 2, 25), items.slice(25))
})

test('pageSlice beyond the last page is empty', () => {
  assert.deepEqual(pageSlice([1, 2], 5, 25), [])
})
