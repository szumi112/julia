import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { CORE_AUDIT_SCHEMAS } from '../../src/core-audit-contract.js'

test('operations audit copy labels every activity action in Polish', async () => {
  const source = await readFile(new URL('../../src/views/Operations.jsx', import.meta.url), 'utf8')
  const actions = Object.keys(CORE_AUDIT_SCHEMAS)
    .filter((action) => action.startsWith('activity.'))
    .sort((left, right) => left.localeCompare(right))
  assert.equal(actions.length, 10)
  for (const action of actions) {
    const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(source, new RegExp(`'${escaped}': '[^']+'`))
  }
})
