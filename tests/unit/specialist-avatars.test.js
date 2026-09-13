import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SPECIALIST_AVATAR_KEY,
  SPECIALIST_AVATAR_KEYS,
  isSpecialistAvatarKey,
  specialistAvatarKeyOrDefault,
} from '../../src/specialist-avatars.js'

test('exposes the stable vector avatar catalog and bloom fallback', () => {
  assert.deepEqual(SPECIALIST_AVATAR_KEYS, ['bloom', 'cross', 'orbit', 'wave'])
  assert.equal(Object.isFrozen(SPECIALIST_AVATAR_KEYS), true)
  assert.equal(DEFAULT_SPECIALIST_AVATAR_KEY, 'bloom')

  for (const key of SPECIALIST_AVATAR_KEYS) {
    assert.equal(isSpecialistAvatarKey(key), true)
    assert.equal(specialistAvatarKeyOrDefault(key), key)
  }
  for (const value of ['', 'BLOOM', 'photo', null, 1]) {
    assert.equal(isSpecialistAvatarKey(value), false)
  }
  assert.equal(specialistAvatarKeyOrDefault(), 'bloom')
  for (const value of [null, 'photo']) {
    assert.throws(() => specialistAvatarKeyOrDefault(value), /SPECIALIST_AVATAR_KEY_INVALID/)
  }
})
