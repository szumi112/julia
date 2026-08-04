import test from 'node:test'
import assert from 'node:assert/strict'
import { appModeFrom, appSurfaceFor, basePathFor } from '../../src/app-mode.js'
import { createWorkspaceAuthorityKey } from '../../src/workspace-provider.js'

test('demo is the only mode that keeps the public GitHub Pages behavior', () => {
  assert.equal(appModeFrom('demo'), 'demo')
  assert.equal(basePathFor('demo'), '/julia/')
})

test('development, staging, and production use the protected app shape', () => {
  for (const mode of ['app', 'staging', 'production']) {
    assert.equal(appModeFrom(mode), 'app')
    assert.equal(basePathFor(mode), '/')
  }
})

test('only demo mode may render the in-memory demo surface', () => {
  assert.equal(appSurfaceFor('demo'), 'demo')

  for (const mode of ['app', 'staging', 'production', undefined]) {
    assert.equal(appSurfaceFor(mode), 'protected')
  }
})

test('workspace authority identity is deterministic and covers every authority field', () => {
  const capabilities = ['payment.manage', 'appointment.manage']
  const authority = {
    repositoryMode: 'api',
    dataMode: 'fictional',
    actorId: 'stf_owner',
    actorVersion: 7,
    role: 'owner',
    specialistId: null,
    capabilities,
    demoRoleId: null,
    demoAuthGeneration: null,
  }
  const key = createWorkspaceAuthorityKey(authority)
  capabilities.reverse()
  assert.equal(createWorkspaceAuthorityKey({ ...authority, capabilities }), key)

  for (const [field, replacement] of [
    ['repositoryMode', 'demo'],
    ['dataMode', 'training'],
    ['actorId', 'stf_other'],
    ['actorVersion', 8],
    ['role', 'coordinator'],
    ['specialistId', 'sp_retained'],
    ['capabilities', ['client.manage']],
    ['demoRoleId', 'therapist'],
    ['demoAuthGeneration', 2],
  ]) {
    assert.notEqual(createWorkspaceAuthorityKey({ ...authority, [field]: replacement }), key, field)
  }
})

test('workspace authority identity rejects accessor-backed mutable session input', () => {
  const authority = {
    repositoryMode: 'api', dataMode: 'fictional', actorId: 'stf_owner', actorVersion: 1,
    role: 'owner', specialistId: null, capabilities: [], demoRoleId: null,
    demoAuthGeneration: null,
  }
  Object.defineProperty(authority, 'capabilities', { enumerable: true, get() { throw new Error('read') } })
  assert.throws(() => createWorkspaceAuthorityKey(authority), TypeError)
})
