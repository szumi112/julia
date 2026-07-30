import { describe, expect, it } from 'vitest'
import { specialistIdFor, validateInvitationInput } from '../../worker/identity/invitations.js'

describe('staff invitation input', () => {
  it('accepts the three staff roles and derives a reserved specialist id', () => {
    expect(validateInvitationInput({ displayName: 'Anna Testowa', email: 'anna@example.test', role: 'specialist' }, { dataMode: 'fictional' }))
      .toEqual({ displayName: 'Anna Testowa', email: 'anna@example.test', role: 'specialist' })
    expect(specialistIdFor('stf_opaque')).toBe('sp_opaque')
  })

  it('rejects non-fictional and malformed invitation values before encryption', () => {
    for (const input of [
      { displayName: '', email: 'anna@example.test', role: 'owner' },
      { displayName: 'Anna', email: 'anna@real.test', role: 'owner' },
      { displayName: 'Anna', email: 'anna@example.test', role: 'administrator' },
      { displayName: 'Anna', email: 'anna@example.test', role: 'owner', extra: true },
    ]) expect(() => validateInvitationInput(input, { dataMode: 'fictional' })).toThrow('VALIDATION_FAILED')
  })
})
