import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canAccessProtectedRoute,
  canPerformAction,
} from '../../src/capability-access.js'

const WORKSPACE_ROUTES = ['dashboard', 'calendar', 'clients', 'client']
const WORKSPACE_CAPABILITIES = [
  'appointment.charge.read',
  'client.operational.read',
  'specialist.directory.read',
]

const SINGLE_CAPABILITY_ROUTES = [
  ['team', 'staff.manage'],
  ['psych', 'staff.manage'],
  ['ledger', 'finance.centre.read'],
  ['reports', 'finance.centre.read'],
]

const ACTIONS = [
  ['appointment.create', 'appointment.manage'],
  ['appointment.edit', 'appointment.manage'],
  ['appointment.cancel', 'appointment.manage'],
  ['payment.record', 'payment.manage'],
  ['payment.correct', 'payment.manage'],
  ['client.create', 'client.manage'],
  ['client.edit', 'client.manage'],
  ['client.archive', 'client.manage'],
  ['client.historical.activate', 'client.manage'],
  ['specialist.create', 'staff.manage'],
  ['specialist.edit', 'staff.manage'],
  ['specialist.link', 'staff.manage'],
  ['staff.invite', 'staff.manage'],
  ['staff.role.edit', 'staff.manage'],
  ['staff.deactivate', 'staff.manage'],
  ['permissions.read', 'permissions.manage'],
  ['permissions.edit', 'permissions.manage'],
  ['operations.health.read', 'operations.health.read'],
  ['security.audit.read', 'security.audit.read'],
  ['finance.import.preview', 'finance.import'],
  ['finance.import.create', 'finance.import'],
  ['finance.import.continue', 'finance.import'],
  ['finance.import.status', 'finance.import'],
  ['workbook.export.centre', 'workbook.centre.export'],
  ['workbook.export.own', 'workbook.own.export'],
  ['activity.group.create', 'tus.manage'],
  ['activity.group.edit', 'tus.manage'],
  ['activity.participant.create', 'tus.manage'],
  ['activity.participant.edit', 'tus.manage'],
  ['activity.membership.create', 'tus.manage'],
  ['activity.membership.edit', 'tus.manage'],
  ['activity.class.create', 'tus.manage'],
  ['activity.class.edit', 'tus.manage'],
  ['activity.attendance.edit', 'tus.manage'],
]

test('protected routes require their exact mapped capability', () => {
  for (const [routeName, capability] of SINGLE_CAPABILITY_ROUTES) {
    assert.equal(
      canAccessProtectedRoute([capability], routeName),
      true,
      `${routeName} accepts ${capability}`,
    )
    assert.equal(
      canAccessProtectedRoute([], routeName),
      false,
      `${routeName} rejects an empty capability set`,
    )
    assert.equal(
      canAccessProtectedRoute(['chat.general'], routeName),
      false,
      `${routeName} rejects an unrelated capability`,
    )
  }
})

test('workspace-backed routes require every capability consumed by the workspace read', () => {
  for (const routeName of WORKSPACE_ROUTES) {
    assert.equal(canAccessProtectedRoute(WORKSPACE_CAPABILITIES, routeName), true)
    for (const missing of WORKSPACE_CAPABILITIES) {
      assert.equal(
        canAccessProtectedRoute(
          WORKSPACE_CAPABILITIES.filter((capability) => capability !== missing),
          routeName,
        ),
        false,
        `${routeName} rejects authority missing ${missing}`,
      )
    }
  }
})

test('protected activity routes stay unavailable until their UI is implemented', () => {
  for (const routeName of ['tus', 'tusGroup', 'english']) {
    assert.equal(canAccessProtectedRoute(['tus.manage'], routeName), false)
  }
})

test('payments accepts either centre-finance read or appointment-charge read', () => {
  assert.equal(canAccessProtectedRoute(['finance.centre.read'], 'payments'), true)
  assert.equal(canAccessProtectedRoute(['appointment.charge.read'], 'payments'), true)
  assert.equal(canAccessProtectedRoute(['chat.general'], 'payments'), false)
  assert.equal(canAccessProtectedRoute([], 'payments'), false)
})

test('settings requires authentication represented by a valid capability array only', () => {
  assert.equal(canAccessProtectedRoute([], 'settings'), true)
  assert.equal(canAccessProtectedRoute(['chat.general'], 'settings'), true)
})

test('catalog-ordered effective subsets preserve every mapped grant', () => {
  const capabilities = Object.freeze([
    'appointment.charge.read',
    'appointment.manage',
    'chat.general',
    'client.operational.read',
    'finance.centre.read',
    'specialist.directory.read',
    'staff.manage',
    'tus.manage',
  ])

  assert.equal(canAccessProtectedRoute(capabilities, 'dashboard'), true)
  assert.equal(canAccessProtectedRoute(capabilities, 'payments'), true)
  assert.equal(canAccessProtectedRoute(capabilities, 'reports'), true)
  assert.equal(canAccessProtectedRoute(capabilities, 'team'), true)
  assert.equal(canAccessProtectedRoute(capabilities, 'english'), false)
  assert.equal(canPerformAction(capabilities, 'appointment.create'), true)
  assert.equal(canPerformAction(capabilities, 'activity.attendance.edit'), true)
})

test('protected actions require their exact mapped capability', () => {
  for (const [actionId, capability] of ACTIONS) {
    assert.equal(
      canPerformAction([capability], actionId),
      true,
      `${actionId} accepts ${capability}`,
    )
    assert.equal(
      canPerformAction([], actionId),
      false,
      `${actionId} rejects an empty capability set`,
    )
    assert.equal(
      canPerformAction(['chat.general'], actionId),
      false,
      `${actionId} rejects an unrelated capability`,
    )
  }
})

test('unknown and malformed route and action IDs fail closed', () => {
  const invalidIds = [
    '',
    'dashboard.extra',
    'appointment',
    null,
    undefined,
    1,
    {},
    Symbol('unknown'),
  ]

  for (const invalidId of invalidIds) {
    assert.equal(canAccessProtectedRoute([], invalidId), false)
    assert.equal(canPerformAction(['appointment.manage'], invalidId), false)
  }
})

test('unknown and structurally malformed capability arrays fail closed', () => {
  const sparse = []
  sparse.length = 2
  sparse[1] = 'client.operational.read'

  const accessor = []
  Object.defineProperty(accessor, '0', {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error('must not read an accessor capability')
    },
  })

  const extraProperty = ['client.operational.read']
  extraProperty.extra = true

  const wrongPrototype = ['client.operational.read']
  Object.setPrototypeOf(wrongPrototype, null)

  const revoked = Proxy.revocable([], {})
  revoked.revoke()

  const malformedCapabilities = [
    null,
    undefined,
    'client.operational.read',
    {},
    ['unknown.capability'],
    ['client.operational.read', 1],
    ['client.operational.read', 'client.operational.read'],
    ['finance.centre.read', 'appointment.charge.read'],
    sparse,
    accessor,
    extraProperty,
    wrongPrototype,
    revoked.proxy,
  ]

  for (const capabilities of malformedCapabilities) {
    assert.equal(canAccessProtectedRoute(capabilities, 'settings'), false)
    assert.equal(canAccessProtectedRoute(capabilities, 'dashboard'), false)
    assert.equal(canPerformAction(capabilities, 'appointment.create'), false)
  }
})

test('demo role labels never stand in for protected capabilities', () => {
  assert.equal(canAccessProtectedRoute(['owner'], 'dashboard'), false)
  assert.equal(canAccessProtectedRoute(['coordinator'], 'settings'), false)
  assert.equal(canPerformAction(['therapist'], 'client.create'), false)
})
