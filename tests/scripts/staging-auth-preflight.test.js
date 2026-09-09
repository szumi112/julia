import test from 'node:test'
import assert from 'node:assert/strict'
import { authenticationRollbackStatements, validateStagingAuthPreflight } from '../../scripts/staging-auth-preflight.mjs'

test('staging auth preflight requires a complete secret set', () => {
  const env = { BETTER_AUTH_SECRET: 'x'.repeat(32) }
  assert.deepEqual(validateStagingAuthPreflight(env, 'staging'), { ready: true })
  delete env.BETTER_AUTH_SECRET
  assert.throws(() => validateStagingAuthPreflight(env, 'staging'), /STAGING_AUTH_PREFLIGHT_FAILED/)
  assert.throws(() => validateStagingAuthPreflight(env, 'production'), /STAGING_AUTH_PREFLIGHT_REFUSED/)
})

test('rollback cleanup is conditional on restored Better Auth tables', () => {
  assert.deepEqual(authenticationRollbackStatements([]), [])
  assert.deepEqual(authenticationRollbackStatements(['auth_session']), ['DELETE FROM auth_session'])
  assert.deepEqual(authenticationRollbackStatements(['auth_verification', 'auth_session']), [
    'DELETE FROM auth_session', 'DELETE FROM auth_verification',
  ])
})
