import assert from 'node:assert/strict'
import test from 'node:test'
import { shellRoleFor } from '../../src/auth-role.js'

const AUTHORIZATION_ERROR = 'AUTHORIZATION_INVALID'

test('maps each accepted backend role to the exact shell role', () => {
  assert.deepEqual(shellRoleFor({
    displayName: 'Ola Właścicielka',
    role: 'owner',
    specialistId: 'sp_owner',
  }), {
    id: 'owner',
    label: 'Właściciel',
    name: 'Ola Właścicielka',
    psychId: 'sp_owner',
    scope: 'centre',
  })
  assert.deepEqual(shellRoleFor({
    displayName: 'Ela Koordynatorka',
    role: 'coordinator',
    specialistId: null,
  }), {
    id: 'coordinator',
    label: 'Koordynator',
    name: 'Ela Koordynatorka',
    psychId: null,
    scope: 'centre',
  })
  assert.deepEqual(shellRoleFor({
    displayName: 'Anna Specjalistka',
    role: 'specialist',
    specialistId: 'sp_specialist',
  }), {
    id: 'therapist',
    label: 'Specjalista',
    name: 'Anna Specjalistka',
    psychId: 'sp_specialist',
    scope: 'own',
  })
})

test('fails closed with one fixed authorization error for malformed actors', () => {
  const invalidActors = [
    null,
    [],
    {},
    { displayName: '', role: 'owner', specialistId: null },
    { displayName: '   ', role: 'coordinator', specialistId: null },
    { displayName: 'Anna\nNowak', role: 'specialist', specialistId: 'sp_anna' },
    { displayName: ' Anna Nowak ', role: 'specialist', specialistId: 'sp_anna' },
    { displayName: 'Anna Nowak', role: 'administrator', specialistId: null },
    { displayName: 'Anna Nowak', role: 'specialist', specialistId: null },
    { displayName: 'Anna Nowak', role: 'specialist', specialistId: '' },
    { displayName: 'Anna Nowak', role: 'specialist', specialistId: '../owner' },
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
    role: 'owner',
    specialistId: null,
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
