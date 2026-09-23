import test from 'node:test'
import assert from 'node:assert/strict'
import { hasActivePanelAccess, isAssignableSpecialist } from '../../src/specialist-eligibility.js'

test('only enabled or unspecified access counts as active panel access', () => {
  assert.equal(hasActivePanelAccess({ accessStatus: 'enabled' }), true)
  assert.equal(hasActivePanelAccess({}), true)
  assert.equal(hasActivePanelAccess({ accessStatus: 'unclaimed' }), false)
  assert.equal(hasActivePanelAccess({ accessStatus: 'invited' }), false)
})

test('an assignable specialist is active and has panel access', () => {
  assert.equal(isAssignableSpecialist({ status: 'active' }), true)
  assert.equal(isAssignableSpecialist({ status: 'active', accessStatus: 'enabled' }), true)
  assert.equal(isAssignableSpecialist({ status: 'active', accessStatus: 'invited' }), false)
  assert.equal(isAssignableSpecialist({ status: 'archived', accessStatus: 'enabled' }), false)
  assert.equal(isAssignableSpecialist(undefined), false)
})
