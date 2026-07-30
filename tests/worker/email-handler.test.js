import { describe, expect, it } from 'vitest'
import {
  acceptCanonicalEmail,
  normalizeCanonicalEmail,
} from '../../worker/identity/canonical-email.js'

const invalidEmails = Object.freeze([
  'anna\u0000@example.test',
  '\nanna@example.test',
  'anna\u200b@example.test',
  '"anna"@example.test',
  '.anna@example.test',
  'anna.@example.test',
  'anna..test@example.test',
  'anna@-example.test',
  'anna@example-.test',
  'anna@example..test',
  'anna@exam_ple.test',
  'anna test@example.test',
])

describe('shared canonical email boundary', () => {
  it('normalizes valid invitation input before persistence', () => {
    expect(normalizeCanonicalEmail('  Z\u0307ANETA@EXAMPLE.TEST  ', {
      fictional: true,
    })).toBe('\u017caneta@example.test')
  })

  it('accepts only an already canonical fictional handler recipient', () => {
    expect(acceptCanonicalEmail('\u017caneta@example.test', {
      fictional: true,
    })).toBe('\u017caneta@example.test')
    expect(acceptCanonicalEmail('  Z\u0307ANETA@EXAMPLE.TEST  ', {
      fictional: true,
    })).toBeNull()
  })

  it('accepts a canonical generic sender but rejects a non-fictional recipient', () => {
    expect(acceptCanonicalEmail('powiadomienia@bearwithme.pl')).toBe(
      'powiadomienia@bearwithme.pl',
    )
    expect(acceptCanonicalEmail('person@sub.example.test', {
      fictional: true,
    })).toBeNull()
  })

  it.each(invalidEmails)('returns no invalid address for %j', (email) => {
    expect(normalizeCanonicalEmail(email)).toBeNull()
    expect(normalizeCanonicalEmail(email, { fictional: true })).toBeNull()
    expect(acceptCanonicalEmail(email)).toBeNull()
    expect(acceptCanonicalEmail(email, { fictional: true })).toBeNull()
  })

  it('enforces the 254-byte limit after normalization', () => {
    const overlong = `${'\u017c'.repeat(121)}@example.test`
    expect(new TextEncoder().encode(overlong).byteLength).toBeGreaterThan(254)
    expect(normalizeCanonicalEmail(overlong, { fictional: true })).toBeNull()
  })
})
