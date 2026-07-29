import { describe, expect, it, vi } from 'vitest'
import { decodeBase64Url, encodeBase64Url } from '../../worker/security/encoding.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { issueCsrfToken, verifyCsrfToken } from '../../worker/security/csrf.js'

const secret = (byte) => encodeBase64Url(new Uint8Array(32).fill(byte))
const config = { activeLookupKeyVersion: 1 }
const nowMs = 1_800_000_000_000
const input = { subject: 'access_subject_1', origin: 'https://staging-panel.bearwithme.pl' }
const ring = (overrides = {}, settings = config) => createKeyring({ BWM_LOOKUP_HMAC_V1: secret(2), ...overrides }, settings)
const invalid = (operation) => expect(operation).rejects.toThrow(/^CSRF_INVALID$/)

describe('CSRF tokens', () => {
  it('issues a subject- and exact-origin-bound canonical token before expiry', async () => {
    const keyring = await ring()
    const token = await issueCsrfToken({ ...input, keyring, nowMs, ttlSeconds: 900 })
    const [format, expires, nonce, signature] = token.split('.')
    expect(format).toBe('v1')
    expect(expires).toBe('1800000900')
    expect(decodeBase64Url(nonce)).toHaveLength(16)
    expect(decodeBase64Url(signature)).toHaveLength(32)
    await expect(verifyCsrfToken(token, { ...input, keyring, nowMs: nowMs + 899_000 })).resolves.toBe(true)
  })

  it.each([0, -1, 1.5, 901, Number.MAX_SAFE_INTEGER + 1])('rejects unsupported ttl %s', async (ttlSeconds) => {
    await invalid(issueCsrfToken({ ...input, keyring: await ring(), nowMs, ttlSeconds }))
  })

  it('rejects malformed, noncanonical, wrong-bound, tampered, and excessive-lifetime tokens', async () => {
    const keyring = await ring()
    const token = await issueCsrfToken({ ...input, keyring, nowMs, ttlSeconds: 900 })
    const [format, expires, nonce, signature] = token.split('.')
    const tampered = encodeBase64Url(Object.assign(decodeBase64Url(signature), { 0: decodeBase64Url(signature)[0] ^ 1 }))
    for (const candidate of [
      '', 'v1.only.two', `v2.${expires}.${nonce}.${signature}`, `v1.0${expires}.${nonce}.${signature}`,
      `v1.${expires}.A.${signature}`, `v1.${expires}.${nonce}.A`, `v1.${expires}.${nonce}.${tampered}`,
    ]) await invalid(verifyCsrfToken(candidate, { ...input, keyring, nowMs }))
    await invalid(verifyCsrfToken(token, { ...input, subject: 'access_subject_2', keyring, nowMs }))
    await invalid(verifyCsrfToken(token, { ...input, origin: 'https://attacker.example', keyring, nowMs }))
    await invalid(verifyCsrfToken(token, { ...input, keyring, nowMs: nowMs - 1_000 }))
  })

  it('rejects CR/LF-bound subjects and origins without allowing newline cross-binding', async () => {
    const keyring = await ring()
    for (const binding of [
      { subject: 'a\nb', origin: 'c' },
      { subject: 'a\rb', origin: 'c' },
      { subject: 'a', origin: 'b\nc' },
      { subject: 'a', origin: 'b\rc' },
    ]) await invalid(issueCsrfToken({ ...binding, keyring, nowMs }))
    const token = await issueCsrfToken({ subject: 'a', origin: 'b', keyring, nowMs })
    for (const binding of [
      { subject: 'a\nb', origin: 'c' },
      { subject: 'a', origin: 'b\nc' },
    ]) await invalid(verifyCsrfToken(token, { ...binding, keyring, nowMs }))
  })

  it('reports only correctly signed exact-expiry tokens as expired', async () => {
    const keyring = await ring()
    const token = await issueCsrfToken({ ...input, keyring, nowMs, ttlSeconds: 1 })
    await expect(verifyCsrfToken(token, { ...input, keyring, nowMs: nowMs + 1_000 })).rejects.toThrow(/^CSRF_EXPIRED$/)
  })

  it('validates tokens from every retained key without early verification success', async () => {
    const all = { BWM_LOOKUP_HMAC_V1: secret(2), BWM_LOOKUP_HMAC_V2: secret(3), BWM_LOOKUP_HMAC_V3: secret(4) }
    const keyrings = await Promise.all([1, 2, 3].map((activeLookupKeyVersion) => createKeyring(all, { activeLookupKeyVersion })))
    const tokens = await Promise.all(keyrings.map((keyring) => issueCsrfToken({ ...input, keyring, nowMs })))
    const verifier = keyrings[2]
    const spy = vi.spyOn(crypto.subtle, 'verify')
    for (const token of tokens) await expect(verifyCsrfToken(token, { ...input, keyring: verifier, nowMs })).resolves.toBe(true)
    expect(spy).toHaveBeenCalledTimes(9)
    spy.mockRestore()
    const withoutV1 = await createKeyring({ BWM_LOOKUP_HMAC_V2: secret(3), BWM_LOOKUP_HMAC_V3: secret(4) }, { activeLookupKeyVersion: 3 })
    await invalid(verifyCsrfToken(tokens[0], { ...input, keyring: withoutV1, nowMs }))
    await expect(verifyCsrfToken(tokens[2], { ...input, keyring: withoutV1, nowMs })).resolves.toBe(true)
  })
})
