import assert from 'node:assert/strict'
import test from 'node:test'

import { canAccessProtectedRoute } from '../../src/capability-access.js'
import { canAccessShellRoute, resolveShellRoute } from '../../src/shell-ctx.js'
import { permissionGroupsFor } from '../../src/permission-overrides.js'

test('admits the activity history only for an app authority carrying activity.read', () => {
  assert.equal(canAccessProtectedRoute(['activity.read'], 'history'), true)
  assert.equal(canAccessProtectedRoute([], 'history'), false)
  assert.equal(canAccessShellRoute({
    appMode: 'app', roleId: 'owner', capabilities: ['activity.read'],
  }, 'history'), true)
  assert.equal(canAccessShellRoute({
    appMode: 'demo', roleId: 'owner', capabilities: [],
  }, 'history'), false)
  assert.deepEqual(resolveShellRoute({
    appMode: 'app', roleId: 'specialist', capabilities: [],
  }, { name: 'history' }), { name: 'profile' })
})

test('presents activity history access in the administration permission group', () => {
  const groups = permissionGroupsFor({ role: 'coordinator', allow: [], deny: [] })
  const administration = groups.find((group) => group.title === 'Administracja')
  assert.deepEqual(administration?.choices.find((choice) => choice.capability === 'activity.read'), {
    capability: 'activity.read',
    label: 'Historia aktywności',
    defaultEnabled: true,
    enabled: true,
    locked: false,
  })
})
