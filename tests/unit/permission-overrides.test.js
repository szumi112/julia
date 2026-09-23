import assert from 'node:assert/strict'
import test from 'node:test'
import * as permissionOverrides from '../../src/permission-overrides.js'
import {
  BASE_ACCESS_CAPABILITIES,
  HIDDEN_PERMISSION_CAPABILITIES,
  permissionChoicesFor,
  setPermissionEnabled,
} from '../../src/permission-overrides.js'

const coordinatorAuthority = Object.freeze({
  role: 'coordinator',
  allow: Object.freeze(['finance.import']),
  deny: Object.freeze(['client.manage']),
})

test('builds Polish editor choices only from the target role ceiling', () => {
  const choices = permissionChoicesFor(coordinatorAuthority)
  const byCapability = new Map(choices.map((choice) => [choice.capability, choice]))

  assert.deepEqual(byCapability.get('client.manage'), {
    capability: 'client.manage',
    label: 'Zarządzanie klientami',
    defaultEnabled: true,
    enabled: false,
    locked: false,
  })
  assert.deepEqual(byCapability.get('finance.import'), {
    capability: 'finance.import',
    label: 'Import danych finansowych',
    defaultEnabled: false,
    enabled: true,
    locked: false,
  })
  assert.equal(byCapability.has('staff.manage'), false)
  assert.equal(byCapability.has('client.operational.read'), false)
  assert.equal(Object.isFrozen(choices), true)
  assert.equal(choices.every(Object.isFrozen), true)
})

test('groups visible permissions in the fixed workflow order', () => {
  assert.equal(typeof permissionOverrides.permissionGroupsFor, 'function')
  const groups = permissionOverrides.permissionGroupsFor({
    role: 'coordinator',
    allow: ['finance.import'],
    deny: [],
  })

  assert.deepEqual(groups.map(({ title, choices }) => [
    title,
    choices.map(({ capability }) => capability),
  ]), [
    ['Grafik i sesje', ['appointment.manage']],
    ['Klienci', ['client.manage']],
    ['Finanse', [
      'finance.centre.read',
      'finance.import',
      'payment.manage',
      'workbook.centre.export',
    ]],
    ['Zespół', []],
    ['Administracja', ['activity.read', 'operations.health.read']],
  ])
})

test('restores a permission draft to the clean defaults of its role', () => {
  assert.equal(typeof permissionOverrides.permissionDefaultsFor, 'function')
  const restored = permissionOverrides.permissionDefaultsFor({
    role: 'coordinator',
    allow: ['finance.import'],
    deny: ['client.manage', 'finance.centre.read'],
  })

  assert.deepEqual(restored.allow, [])
  assert.deepEqual(restored.deny, [])
  assert.equal(restored.effectiveCapabilities.includes('finance.centre.read'), true)
  assert.equal(restored.effectiveCapabilities.includes('finance.import'), false)
})

test('publishes every visible owner choice after hiding base and unused overrides', () => {
  assert.deepEqual(BASE_ACCESS_CAPABILITIES, [
    'appointment.charge.read',
    'client.operational.read',
    'specialist.directory.read',
  ])
  assert.deepEqual(HIDDEN_PERMISSION_CAPABILITIES, [
    'chat.direct',
    'chat.general',
    'backup.manage',
    'restore.manage',
    'centre.manage',
    'clinical.read',
    'security.keys.manage',
  ])

  assert.deepEqual(
    permissionChoicesFor({ role: 'owner', allow: [], deny: [] })
      .map(({ capability, label }) => [capability, label]),
    [
      ['workbook.centre.export', 'Eksport arkusza centrum'],
      ['activity.read', 'Historia aktywności'],
      ['finance.import', 'Import danych finansowych'],
      ['security.audit.read', 'Podgląd dziennika bezpieczeństwa'],
      ['finance.centre.read', 'Podgląd finansów centrum'],
      ['operations.health.read', 'Podgląd stanu systemu'],
      ['payment.manage', 'Rejestrowanie płatności'],
      ['finance.centre.manage', 'Zarządzanie finansami centrum'],
      ['client.manage', 'Zarządzanie klientami'],
      ['staff.manage', 'Zarządzanie personelem'],
      ['appointment.manage', 'Zarządzanie sesjami'],
      ['tus.manage', 'Zarządzanie TUS i zajęciami grupowymi'],
      ['permissions.manage', 'Zarządzanie uprawnieniami'],
    ],
  )

  for (const role of ['owner', 'coordinator', 'specialist']) {
    const visible = permissionChoicesFor({ role, allow: [], deny: [] })
      .map(({ capability }) => capability)
    for (const capability of [...BASE_ACCESS_CAPABILITIES, ...HIDDEN_PERMISSION_CAPABILITIES]) {
      assert.equal(visible.includes(capability), false, `${role}/${capability}`)
    }
  }
  assert.equal(permissionChoicesFor({ role: 'specialist', allow: [], deny: [] })
    .find(({ capability }) => capability === 'workbook.own.export')?.label, 'Eksport własnego arkusza')
})

test('restores every base capability by removing its denial without changing other exceptions', () => {
  const denied = {
    role: 'coordinator',
    allow: ['finance.import'],
    deny: [...BASE_ACCESS_CAPABILITIES, 'client.manage'],
  }
  const restored = BASE_ACCESS_CAPABILITIES.reduce(
    (draft, capability) => setPermissionEnabled(draft, capability, true),
    denied,
  )
  assert.deepEqual(restored.deny, ['client.manage'])
  assert.deepEqual(restored.allow, ['finance.import'])
})

test('turning role defaults off and on writes only normalized deny decisions', () => {
  const disabled = setPermissionEnabled(coordinatorAuthority, 'chat.general', false)
  assert.deepEqual(disabled, {
    role: 'coordinator',
    allow: ['finance.import'],
    deny: ['chat.general', 'client.manage'],
    effectiveCapabilities: [
      'activity.read',
      'appointment.charge.read',
      'appointment.manage',
      'chat.direct',
      'client.operational.read',
      'finance.centre.read',
      'finance.import',
      'operations.health.read',
      'payment.manage',
      'specialist.directory.read',
      'tus.manage',
      'workbook.centre.export',
    ],
  })

  assert.deepEqual(setPermissionEnabled(disabled, 'chat.general', true), {
    role: 'coordinator',
    allow: ['finance.import'],
    deny: ['client.manage'],
    effectiveCapabilities: [
      'activity.read',
      'appointment.charge.read',
      'appointment.manage',
      'chat.direct',
      'chat.general',
      'client.operational.read',
      'finance.centre.read',
      'finance.import',
      'operations.health.read',
      'payment.manage',
      'specialist.directory.read',
      'tus.manage',
      'workbook.centre.export',
    ],
  })
})

test('turning optional grants on and off writes only normalized allow decisions', () => {
  const withoutImport = setPermissionEnabled(coordinatorAuthority, 'finance.import', false)
  assert.deepEqual(withoutImport.allow, [])
  assert.deepEqual(withoutImport.deny, ['client.manage'])

  const restored = setPermissionEnabled(withoutImport, 'finance.import', true)
  assert.deepEqual(restored.allow, ['finance.import'])
  assert.deepEqual(restored.deny, ['client.manage'])
  assert.equal(restored.effectiveCapabilities.includes('finance.import'), true)
})

test('keeps the owner constitutional permission enabled and immutable', () => {
  const choices = permissionChoicesFor({ role: 'owner', allow: [], deny: [] })
  assert.deepEqual(
    choices.find(({ capability }) => capability === 'permissions.manage'),
    {
      capability: 'permissions.manage',
      label: 'Zarządzanie uprawnieniami',
      defaultEnabled: true,
      enabled: true,
      locked: true,
    },
  )
  assert.throws(
    () => setPermissionEnabled(
      { role: 'owner', allow: [], deny: [] },
      'permissions.manage',
      false,
    ),
    { message: 'VALIDATION_FAILED/deny' },
  )
})

test('fails closed for unknown, over-ceiling, or malformed editor input', () => {
  for (const [authority, capability, enabled] of [
    [coordinatorAuthority, 'staff.manage', true],
    [coordinatorAuthority, 'unknown.capability', true],
    [{ role: 'unknown', allow: [], deny: [] }, 'chat.general', true],
    [{ role: 'coordinator', allow: ['staff.manage'], deny: [] }, 'chat.general', true],
    [coordinatorAuthority, 'chat.general', 'yes'],
  ]) {
    assert.throws(() => setPermissionEnabled(authority, capability, enabled), TypeError)
  }
  assert.throws(
    () => permissionChoicesFor({ role: 'coordinator', allow: [], deny: ['staff.manage'] }),
    TypeError,
  )
})
