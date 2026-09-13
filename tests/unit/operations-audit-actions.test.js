import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('data security panel does not load or render the activity audit log', async () => {
  const source = await readFile(new URL('../../src/views/Operations.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /getSecurityAudit|CORE_AUDIT|auditCursor|auditRows/)
  assert.match(source, /<details className="operations-technical">/)
})
