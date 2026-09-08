import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLocalAuthSeedSql } from '../../scripts/seed-local-auth.mjs'

test('builds fictional verified Better Auth credential rows for every app role', async () => {
  const sql = await buildLocalAuthSeedSql()
  for (const value of ['owner@example.test', 'coordinator@example.test', 'specialist@example.test',
    'stf_local_owner', 'stf_local_coordinator', 'stf_local_specialist']) assert.match(sql, new RegExp(value))
  assert.equal((sql.match(/emailVerified,image/g) || []).length, 3)
  assert.equal((sql.match(/'credential'/g) || []).length, 3)
  assert.doesNotMatch(sql, /correctpassword/)
})
