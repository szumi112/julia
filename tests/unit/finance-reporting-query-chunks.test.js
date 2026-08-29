import assert from 'node:assert/strict'
import test from 'node:test'

import { chunkFinanceAuthorityIds } from '../../worker/core/finance-reporting.js'

test('chunks dense finance authority IDs deterministically below D1 bind limits', () => {
  const ids = Array.from({ length: 201 }, (_, index) => `apt_chunk_${index}`)
  const chunks = chunkFinanceAuthorityIds(ids)
  assert.deepEqual(chunks.map(({ length }) => length), [80, 80, 41])
  assert.deepEqual(chunks.flat(), ids)
  assert.throws(() => chunkFinanceAuthorityIds([...ids, ids[0]]), /INTERNAL_ERROR/)
  assert.throws(() => chunkFinanceAuthorityIds(Array.from(
    { length: 1_001 }, (_, index) => `apt_over_${index}`,
  )), /FINANCE_WINDOW_LIMIT/)
})
