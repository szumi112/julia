import { expect, it } from 'vitest'
import { classifyOwnerTransitionError, isD1IdentityCollision, isD1LastActiveOwner } from '../../worker/db/errors.js'

it('classifies only exact D1 identity and last-owner errors', () => {
  expect(isD1IdentityCollision(new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT'))).toBe(true)
  expect(isD1LastActiveOwner(new Error('last_active_owner: SQLITE_CONSTRAINT'))).toBe(true)
  expect(isD1IdentityCollision(new Error('transport identity_collision downstream'))).toBe(false)
  expect(isD1LastActiveOwner(new Error('last_active_owner later'))).toBe(false)
  expect(classifyOwnerTransitionError(new Error('last_active_owner: SQLITE_CONSTRAINT'))).toBe('LAST_ACTIVE_OWNER')
  expect(classifyOwnerTransitionError(new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT'))).toBe('VERSION_CONFLICT')
  expect(classifyOwnerTransitionError(new Error('unknown'))).toBeNull()
})
