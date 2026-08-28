import test from 'node:test'
import assert from 'node:assert/strict'
import { appModeFrom, appSurfaceFor, basePathFor } from '../../src/app-mode.js'
import { createWorkspaceAuthorityKey } from '../../src/workspace-provider.js'
import { createWorkspaceApiDependency } from '../../src/app-workspace.js'

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
    authorityRevision: 3,
    role: 'owner',
    specialistId: null,
    capabilities,
    demoRoleId: null,
    demoAuthGeneration: null,
  }
  const key = createWorkspaceAuthorityKey(authority)
  capabilities.reverse()
  assert.equal(createWorkspaceAuthorityKey({ ...authority, capabilities }), key)
  assert.notEqual(createWorkspaceAuthorityKey({
    ...authority,
    repositoryMode: 'demo',
    authorityRevision: null,
    demoRoleId: 'owner',
    demoAuthGeneration: 1,
  }), key, 'repositoryMode')

  for (const [field, replacement] of [
    ['dataMode', 'training'],
    ['actorId', 'stf_other'],
    ['actorVersion', 8],
    ['authorityRevision', 4],
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
    authorityRevision: 1,
    role: 'owner', specialistId: null, capabilities: [], demoRoleId: null,
    demoAuthGeneration: null,
  }
  Object.defineProperty(authority, 'capabilities', { enumerable: true, get() { throw new Error('read') } })
  assert.throws(() => createWorkspaceAuthorityKey(authority), TypeError)
})

test('protected specialist authority requires one canonical specialist profile', () => {
  const authority = {
    repositoryMode: 'api', dataMode: 'fictional', actorId: 'stf_specialist', actorVersion: 1,
    authorityRevision: 1,
    role: 'specialist', specialistId: 'sp_specialist', capabilities: [],
    demoRoleId: null, demoAuthGeneration: null,
  }
  assert.doesNotThrow(() => createWorkspaceAuthorityKey(authority))
  for (const specialistId of [null, '', 'staff_specialist', '../sp_specialist']) {
    assert.throws(
      () => createWorkspaceAuthorityKey({ ...authority, specialistId }),
      TypeError,
    )
  }
})

test('protected app adapts the full API client to the exact bound workspace dependency', async () => {
  const calls = []
  const methodNames = [
    'loadWorkspaceWindow', 'createClient', 'editClient', 'archiveClient',
    'activateHistoricalClient',
    'createAppointment', 'editAppointment', 'cancelAppointment', 'recordPayment',
    'correctPayment',
    'loadActivityWorkspace',
    'createActivityGroup', 'editActivityGroup',
    'createActivityParticipant', 'editActivityParticipant',
    'createActivityMembership', 'editActivityMembership',
    'createActivityClass', 'editActivityClass', 'setActivityAttendance',
    'createIdempotencyKey',
  ]
  const source = { marker: 'trusted-api', unrelatedMethod() {} }
  for (const name of methodNames) {
    source[name] = function (...args) {
      calls.push([name, this.marker, args])
      return name === 'createIdempotencyKey' ? 'workspace-key-0001' : `${name}:ok`
    }
  }
  Object.freeze(source)

  const dependency = createWorkspaceApiDependency(source)
  assert.ok(Object.isFrozen(dependency))
  assert.deepEqual(Object.keys(dependency), methodNames)
  assert.equal(dependency.loadWorkspaceWindow({ from: '2026-08-01', to: '2026-08-31' }), 'loadWorkspaceWindow:ok')
  assert.equal(dependency.createIdempotencyKey(), 'workspace-key-0001')
  assert.deepEqual(calls, [
    ['loadWorkspaceWindow', 'trusted-api', [{ from: '2026-08-01', to: '2026-08-31' }]],
    ['createIdempotencyKey', 'trusted-api', []],
  ])
})
