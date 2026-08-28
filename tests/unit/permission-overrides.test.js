import assert from 'node:assert/strict'
import test from 'node:test'
import {
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
  assert.equal(Object.isFrozen(choices), true)
  assert.equal(choices.every(Object.isFrozen), true)
})

test('publishes one exact Polish label for every owner-manageable capability', () => {
  assert.deepEqual(
    permissionChoicesFor({ role: 'owner', allow: [], deny: [] })
      .map(({ capability, label }) => [capability, label]),
    [
      ['chat.general', 'Czat ogólny'],
      ['workbook.centre.export', 'Eksport skoroszytu centrum'],
      ['finance.import', 'Import danych finansowych'],
      ['clinical.read', 'Podgląd danych klinicznych'],
      ['security.audit.read', 'Podgląd dziennika bezpieczeństwa'],
      ['finance.centre.read', 'Podgląd finansów centrum'],
      ['specialist.directory.read', 'Podgląd katalogu specjalistek'],
      ['client.operational.read', 'Podgląd klientów i kalendarza'],
      ['appointment.charge.read', 'Podgląd rozliczeń wizyt'],
      ['operations.health.read', 'Podgląd stanu systemu'],
      ['restore.manage', 'Przywracanie kopii zapasowych'],
      ['payment.manage', 'Rejestrowanie płatności'],
      ['chat.direct', 'Wiadomości bezpośrednie'],
      ['centre.manage', 'Zarządzanie centrum'],
      ['finance.centre.manage', 'Zarządzanie finansami centrum'],
      ['client.manage', 'Zarządzanie klientami'],
      ['security.keys.manage', 'Zarządzanie kluczami bezpieczeństwa'],
      ['backup.manage', 'Zarządzanie kopiami zapasowymi'],
      ['staff.manage', 'Zarządzanie personelem'],
      ['tus.manage', 'Zarządzanie TUS i zajęciami grupowymi'],
      ['permissions.manage', 'Zarządzanie uprawnieniami'],
      ['appointment.manage', 'Zarządzanie wizytami'],
    ],
  )
  assert.equal(
    permissionChoicesFor({ role: 'specialist', allow: [], deny: [] })
      .find(({ capability }) => capability === 'workbook.own.export')?.label,
    'Eksport własnego skoroszytu',
  )
})

test('turning role defaults off and on writes only normalized deny decisions', () => {
  const disabled = setPermissionEnabled(coordinatorAuthority, 'chat.general', false)
  assert.deepEqual(disabled, {
    role: 'coordinator',
    allow: ['finance.import'],
    deny: ['chat.general', 'client.manage'],
    effectiveCapabilities: [
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
