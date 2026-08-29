import assert from 'node:assert/strict'
import test from 'node:test'
import { shellRoleFor } from '../../src/auth-role.js'

const AUTHORIZATION_ERROR = 'AUTHORIZATION_INVALID'

test('maps each accepted backend role to the exact shell role', () => {
  assert.deepEqual(shellRoleFor({
    id: 'stf_owner',
    displayName: 'Ola Właścicielka',
    professionalTitle: 'Psycholożka',
    role: 'owner',
    specialistId: 'sp_owner',
    version: 7,
  }), {
    authorityVersion: 7,
    id: 'owner',
    label: 'Właściciel',
    name: 'Ola Właścicielka',
    professionalTitle: 'Psycholożka',
    psychId: 'sp_owner',
    scope: 'centre',
  })
  assert.deepEqual(shellRoleFor({
    id: 'stf_coordinator',
    displayName: 'Ela Koordynatorka',
    professionalTitle: null,
    role: 'coordinator',
    specialistId: null,
    version: 4,
  }), {
    authorityVersion: 4,
    id: 'coordinator',
    label: 'Koordynator',
    name: 'Ela Koordynatorka',
    professionalTitle: null,
    psychId: null,
    scope: 'centre',
  })
  assert.deepEqual(shellRoleFor({
    id: 'stf_specialist',
    displayName: 'Anna Specjalistka',
    professionalTitle: 'Specjalistka',
    role: 'specialist',
    specialistId: 'sp_specialist',
    version: 9,
  }), {
    authorityVersion: 9,
    id: 'therapist',
    label: 'Specjalista',
    name: 'Anna Specjalistka',
    professionalTitle: 'Specjalistka',
    psychId: 'sp_specialist',
    scope: 'own',
  })
  assert.deepEqual(shellRoleFor({
    id: `stf_${'a'.repeat(124)}`,
    displayName: 'Anna Graniczna',
    professionalTitle: 'x'.repeat(120),
    role: 'specialist',
    specialistId: `sp_${'a'.repeat(125)}`,
    version: 1,
  }), {
    authorityVersion: 1,
    id: 'therapist',
    label: 'Specjalista',
    name: 'Anna Graniczna',
    professionalTitle: 'x'.repeat(120),
    psychId: `sp_${'a'.repeat(125)}`,
    scope: 'own',
  })
})

test('fails closed with one fixed authorization error for malformed actors', () => {
  const valid = { id: 'stf_owner', displayName: 'Anna Nowak', professionalTitle: null, role: 'owner', specialistId: null, version: 1 }
  const invalidActors = [
    null,
    [],
    {},
    { displayName: '', professionalTitle: null, role: 'owner', specialistId: null },
    { displayName: '   ', professionalTitle: null, role: 'coordinator', specialistId: null },
    { displayName: 'Anna\nNowak', professionalTitle: 'Specjalistka', role: 'specialist', specialistId: 'sp_anna' },
    { displayName: ' Anna Nowak ', professionalTitle: 'Specjalistka', role: 'specialist', specialistId: 'sp_anna' },
    { displayName: 'Anna Nowak', professionalTitle: null, role: 'administrator', specialistId: null },
    { displayName: 'Anna Nowak', professionalTitle: 'Specjalistka', role: 'specialist', specialistId: null },
    { displayName: 'Anna Nowak', professionalTitle: 'Specjalistka', role: 'specialist', specialistId: '' },
    { displayName: 'Anna Nowak', professionalTitle: 'Specjalistka', role: 'specialist', specialistId: '../owner' },
    { ...valid, professionalTitle: '' },
    { ...valid, professionalTitle: ' Specjalistka' },
    { ...valid, professionalTitle: 'Specjalistka\u0000' },
    { ...valid, professionalTitle: '\uD800' },
    { ...valid, professionalTitle: 'x'.repeat(121) },
    { ...valid, professionalTitle: 'Specjalistka' },
    { ...valid, specialistId: 'sp_owner_profile' },
    { ...valid, version: 0 },
    { ...valid, version: 1.5 },
    { ...valid, extra: true },
    { ...valid, id: 'sp_owner' },
    { ...valid, id: `stf_${'a'.repeat(125)}` },
    { ...valid, specialistId: 'stf_profile' },
    { ...valid, specialistId: `sp_${'a'.repeat(126)}` },
  ]

  for (const actor of invalidActors) {
    assert.throws(() => shellRoleFor(actor), {
      message: AUTHORIZATION_ERROR,
    })
  }
})

test('contains throwing actor accessors and proxies as the same authorization error', () => {
  const rawSecret = 'actor-getter anna@example.test'
  const actorWithGetter = {
    id: 'stf_owner',
    professionalTitle: null,
    role: 'owner',
    specialistId: null,
    version: 1,
  }
  Object.defineProperty(actorWithGetter, 'displayName', {
    enumerable: true,
    get() {
      throw new Error(rawSecret)
    },
  })
  const actorProxy = new Proxy({}, {
    get() {
      throw new Error(rawSecret)
    },
  })

  for (const actor of [actorWithGetter, actorProxy]) {
    assert.throws(() => shellRoleFor(actor), (error) => {
      assert.equal(error.message, AUTHORIZATION_ERROR)
      assert.doesNotMatch(error.message, /actor-getter|anna@example\.test/)
      return true
    })
  }
})

test('freezes the exact shell projection and exposes authority revision changes', () => {
  const actor = { id: 'stf_owner', displayName: 'Ola', professionalTitle: null, role: 'owner', specialistId: null, version: 2 }
  const first = shellRoleFor(actor)
  const second = shellRoleFor({ ...actor, version: 3 })
  assert.equal(Object.isFrozen(first), true)
  assert.deepEqual(Reflect.ownKeys(first).sort(), ['authorityVersion', 'id', 'label', 'name', 'professionalTitle', 'psychId', 'scope'])
  assert.equal(first.authorityVersion, 2)
  assert.equal(second.authorityVersion, 3)
})

test('keeps an owner with a professional profile centre-scoped and presents the professional title', () => {
  const role = shellRoleFor({
    id: 'stf_julia',
    displayName: 'Julia Wolanin',
    professionalTitle: 'Specjalistka',
    role: 'owner',
    specialistId: 'sp_julia',
    version: 8,
  })

  assert.equal(role.id, 'owner')
  assert.equal(role.scope, 'centre')
  assert.equal(role.psychId, 'sp_julia')
  assert.equal(role.professionalTitle, 'Specjalistka')
  assert.equal(role.label, 'Właściciel')
  assert.equal(Object.isFrozen(role), true)
})
