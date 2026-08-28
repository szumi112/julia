import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPABILITIES,
  NON_DENIABLE_CAPABILITIES,
  OWNER_ONLY_CAPABILITIES,
  ROLE_CAPABILITY_CEILINGS,
  ROLE_DEFAULT_CAPABILITIES,
  acceptEffectiveCapabilities,
  effectiveCapabilitiesFor,
  isCapability,
  normalizeCapabilityOverrides,
} from '../../src/capabilities.js'

const CATALOG = [
  'appointment.charge.read',
  'appointment.manage',
  'backup.manage',
  'centre.manage',
  'chat.direct',
  'chat.general',
  'client.manage',
  'client.operational.read',
  'clinical.read',
  'finance.centre.manage',
  'finance.centre.read',
  'finance.import',
  'operations.health.read',
  'payment.manage',
  'permissions.manage',
  'restore.manage',
  'security.audit.read',
  'security.keys.manage',
  'specialist.directory.read',
  'staff.manage',
  'tus.manage',
  'workbook.centre.export',
  'workbook.own.export',
]

const DEFAULTS = {
  owner: [
    'appointment.charge.read',
    'appointment.manage',
    'backup.manage',
    'centre.manage',
    'chat.direct',
    'chat.general',
    'client.manage',
    'client.operational.read',
    'clinical.read',
    'finance.centre.manage',
    'finance.centre.read',
    'finance.import',
    'operations.health.read',
    'payment.manage',
    'permissions.manage',
    'restore.manage',
    'security.audit.read',
    'security.keys.manage',
    'specialist.directory.read',
    'staff.manage',
    'tus.manage',
    'workbook.centre.export',
  ],
  coordinator: [
    'appointment.charge.read',
    'appointment.manage',
    'chat.direct',
    'chat.general',
    'client.manage',
    'client.operational.read',
    'finance.centre.read',
    'operations.health.read',
    'payment.manage',
    'specialist.directory.read',
    'tus.manage',
    'workbook.centre.export',
  ],
  specialist: [
    'appointment.charge.read',
    'appointment.manage',
    'chat.direct',
    'chat.general',
    'client.manage',
    'client.operational.read',
    'clinical.read',
    'payment.manage',
    'specialist.directory.read',
    'tus.manage',
    'workbook.own.export',
  ],
}

const CEILINGS = {
  owner: [...DEFAULTS.owner],
  coordinator: [
    'appointment.charge.read',
    'appointment.manage',
    'chat.direct',
    'chat.general',
    'client.manage',
    'client.operational.read',
    'finance.centre.read',
    'finance.import',
    'operations.health.read',
    'payment.manage',
    'specialist.directory.read',
    'tus.manage',
    'workbook.centre.export',
  ],
  specialist: [...DEFAULTS.specialist],
}

const OWNER_ONLY = [
  'backup.manage',
  'centre.manage',
  'finance.centre.manage',
  'permissions.manage',
  'restore.manage',
  'security.audit.read',
  'security.keys.manage',
  'staff.manage',
]

const NON_DENIABLE = {
  owner: ['permissions.manage'],
  coordinator: [],
  specialist: [],
}

const ROLES = ['owner', 'coordinator', 'specialist']
const invalid = (field) => ({
  name: 'TypeError',
  message: `VALIDATION_FAILED/${field}`,
})

test('publishes the exact frozen, unique, alphabetically ordered capability vocabulary', () => {
  assert.deepEqual(CAPABILITIES, CATALOG)
  assert.equal(new Set(CAPABILITIES).size, 23)
  assert.deepEqual(CAPABILITIES, [...CAPABILITIES].sort())
  assert.equal(Object.isFrozen(CAPABILITIES), true)
  for (const capability of CATALOG) assert.equal(isCapability(capability), true)
  for (const value of [null, undefined, '', 'finance', 'finance.*', 'Finance.import']) {
    assert.equal(isCapability(value), false)
  }
})

test('publishes exact deeply frozen role defaults, ceilings, owner-only, and non-deniable sets', () => {
  assert.deepEqual(ROLE_DEFAULT_CAPABILITIES, DEFAULTS)
  assert.deepEqual(ROLE_CAPABILITY_CEILINGS, CEILINGS)
  assert.deepEqual(OWNER_ONLY_CAPABILITIES, OWNER_ONLY)
  assert.deepEqual(NON_DENIABLE_CAPABILITIES, NON_DENIABLE)
  for (const value of [
    ROLE_DEFAULT_CAPABILITIES,
    ROLE_CAPABILITY_CEILINGS,
    OWNER_ONLY_CAPABILITIES,
    NON_DENIABLE_CAPABILITIES,
    ...Object.values(ROLE_DEFAULT_CAPABILITIES),
    ...Object.values(ROLE_CAPABILITY_CEILINGS),
    ...Object.values(NON_DENIABLE_CAPABILITIES),
  ]) assert.equal(Object.isFrozen(value), true)
  for (const lists of [DEFAULTS, CEILINGS, NON_DENIABLE]) {
    for (const list of Object.values(lists)) {
      assert.equal(new Set(list).size, list.length)
      assert.deepEqual(list, [...list].sort())
    }
  }
})

test('normalizes duplicate and contradictory overrides in catalog order without mutating input', () => {
  const input = {
    role: 'coordinator',
    allow: [
      'finance.import', 'appointment.manage', 'finance.import', 'chat.direct',
    ],
    deny: [
      'client.manage', 'appointment.manage', 'client.manage',
    ],
  }
  const before = structuredClone(input)
  const normalized = normalizeCapabilityOverrides(input)
  assert.deepEqual(normalized, {
    allow: ['finance.import'],
    deny: ['appointment.manage', 'client.manage'],
  })
  assert.deepEqual(input, before)
  assert.equal(Object.isFrozen(normalized), true)
  assert.equal(Object.isFrozen(normalized.allow), true)
  assert.equal(Object.isFrozen(normalized.deny), true)
  assert.deepEqual(effectiveCapabilitiesFor(input), [
    'appointment.charge.read',
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
  ])
})

test('deny wins over the coordinator-only additional allow', () => {
  const input = {
    role: 'coordinator',
    allow: ['finance.import', 'finance.import'],
    deny: ['finance.import', 'finance.import'],
  }
  assert.deepEqual(normalizeCapabilityOverrides(input), {
    allow: [], deny: ['finance.import'],
  })
  assert.deepEqual(effectiveCapabilitiesFor(input), DEFAULTS.coordinator)
})

test('keeps permissions.manage constitutional for owners', () => {
  assert.throws(
    () => normalizeCapabilityOverrides({
      role: 'owner', allow: [], deny: ['permissions.manage'],
    }),
    invalid('deny'),
  )
  assert.throws(
    () => effectiveCapabilitiesFor({
      role: 'owner', allow: ['permissions.manage'], deny: ['permissions.manage'],
    }),
    invalid('deny'),
  )
  const ownerDeniable = DEFAULTS.owner.filter((value) => value !== 'permissions.manage')
  assert.deepEqual(effectiveCapabilitiesFor({
    role: 'owner', allow: [], deny: ownerDeniable,
  }), ['permissions.manage'])
  assert.deepEqual(acceptEffectiveCapabilities('owner', ['permissions.manage']), [
    'permissions.manage',
  ])
  assert.equal(acceptEffectiveCapabilities('owner', []), null)
})

test('rejects unknown roles, unknown capabilities, ceiling escapes, and malformed override inputs', () => {
  assert.throws(
    () => normalizeCapabilityOverrides({ role: 'admin', allow: [], deny: [] }),
    invalid('role'),
  )
  for (const field of ['allow', 'deny']) {
    assert.throws(
      () => normalizeCapabilityOverrides({
        role: 'owner', allow: field === 'allow' ? ['unknown.capability'] : [],
        deny: field === 'deny' ? ['unknown.capability'] : [],
      }),
      invalid(field),
    )
  }
  for (const [role, capability] of [
    ['owner', 'workbook.own.export'],
    ['coordinator', 'clinical.read'],
    ['coordinator', 'staff.manage'],
    ['specialist', 'finance.import'],
    ['specialist', 'workbook.centre.export'],
  ]) {
    for (const field of ['allow', 'deny']) {
      assert.throws(
        () => normalizeCapabilityOverrides({
          role,
          allow: field === 'allow' ? [capability] : [],
          deny: field === 'deny' ? [capability] : [],
        }),
        invalid(field),
      )
    }
  }
  for (const input of [
    null,
    { role: 'owner', allow: [], deny: [], extra: true },
    { role: 'owner', allow: [] },
    { role: 'owner', allow: null, deny: [] },
    { role: 'owner', allow: [, 'staff.manage'], deny: [] },
  ]) assert.throws(() => normalizeCapabilityOverrides(input), TypeError)
})

for (const role of ROLES) {
  test(`${role} default capability matrix is exact`, () => {
    const effective = effectiveCapabilitiesFor({ role, allow: [], deny: [] })
    assert.deepEqual(effective, DEFAULTS[role])
    assert.equal(Object.isFrozen(effective), true)
    for (const capability of CATALOG) {
      assert.equal(effective.includes(capability), DEFAULTS[role].includes(capability))
    }
  })

  test(`${role} allow matrix enforces the ceiling and removes default-redundant allows`, () => {
    for (const capability of CATALOG) {
      const input = { role, allow: [capability], deny: [] }
      if (!CEILINGS[role].includes(capability)) {
        assert.throws(() => normalizeCapabilityOverrides(input), invalid('allow'))
        assert.throws(() => effectiveCapabilitiesFor(input), invalid('allow'))
        continue
      }
      const normalized = normalizeCapabilityOverrides(input)
      assert.deepEqual(
        normalized.allow,
        DEFAULTS[role].includes(capability) ? [] : [capability],
      )
      assert.deepEqual(normalized.deny, [])
      assert.deepEqual(
        effectiveCapabilitiesFor(input),
        CATALOG.filter((value) => (
          DEFAULTS[role].includes(value) || value === capability
        )),
      )
    }
  })

  test(`${role} deny matrix enforces the ceiling, removes access, and preserves redundant denies`, () => {
    for (const capability of CATALOG) {
      const input = { role, allow: [], deny: [capability] }
      if (!CEILINGS[role].includes(capability)
        || (role === 'owner' && capability === 'permissions.manage')) {
        assert.throws(() => normalizeCapabilityOverrides(input), invalid('deny'))
        assert.throws(() => effectiveCapabilitiesFor(input), invalid('deny'))
        continue
      }
      assert.deepEqual(normalizeCapabilityOverrides(input), {
        allow: [], deny: [capability],
      })
      assert.deepEqual(
        effectiveCapabilitiesFor(input),
        DEFAULTS[role].filter((value) => value !== capability),
      )
    }
  })
}

test('accepts only unique catalog-ordered effective subsets inside each role ceiling', () => {
  for (const role of ROLES) {
    const input = [...DEFAULTS[role]]
    const accepted = acceptEffectiveCapabilities(role, input)
    assert.deepEqual(accepted, DEFAULTS[role])
    assert.notEqual(accepted, input)
    assert.equal(Object.isFrozen(accepted), true)
  }
  assert.deepEqual(acceptEffectiveCapabilities('coordinator', [
    'finance.centre.read', 'finance.import',
  ]), ['finance.centre.read', 'finance.import'])
  for (const [role, values] of [
    ['unknown', []],
    ['owner', ['permissions.manage', 'permissions.manage']],
    ['owner', ['staff.manage', 'permissions.manage']],
    ['owner', ['permissions.manage', 'workbook.own.export']],
    ['coordinator', ['clinical.read']],
    ['specialist', ['finance.import']],
    ['specialist', ['unknown.capability']],
    ['specialist', null],
  ]) assert.equal(acceptEffectiveCapabilities(role, values), null)
})

test('contains accessor, sparse-array, prototype, and proxy inputs without invoking them', () => {
  let reads = 0
  const accessor = {}
  Object.defineProperty(accessor, 'role', {
    enumerable: true,
    get() { reads += 1; return 'owner' },
  })
  Object.defineProperty(accessor, 'allow', { enumerable: true, value: [] })
  Object.defineProperty(accessor, 'deny', { enumerable: true, value: [] })
  assert.throws(() => normalizeCapabilityOverrides(accessor), invalid('body'))
  assert.equal(reads, 0)
  assert.throws(
    () => normalizeCapabilityOverrides(Object.create(null)),
    invalid('body'),
  )
  assert.equal(acceptEffectiveCapabilities('owner', [, 'permissions.manage']), null)
  const hostile = new Proxy({}, { ownKeys() { throw new Error('private-value') } })
  assert.throws(() => normalizeCapabilityOverrides(hostile), invalid('body'))
  assert.equal(acceptEffectiveCapabilities('owner', hostile), null)
  const revoked = Proxy.revocable([], {})
  revoked.revoke()
  assert.throws(
    () => normalizeCapabilityOverrides({
      role: 'owner', allow: revoked.proxy, deny: [],
    }),
    invalid('allow'),
  )
  assert.equal(acceptEffectiveCapabilities('owner', revoked.proxy), null)
})
