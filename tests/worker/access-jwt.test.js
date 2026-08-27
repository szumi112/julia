import { describe, expect, it, vi } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import {
  createAccessVerifier,
  createRemoteAccessJwks,
  resolveAccessPrincipal,
} from '../../worker/identity/access-jwt.js'
import { AUDIENCE, ISSUER, JWKS, KID, NOW_MS, signAccessJwt, testConfig, TEST_IDENTITIES } from './fixtures.js'

const verifier = () => createAccessVerifier({
  issuer: ISSUER,
  audience: AUDIENCE,
  jwks: createLocalJWKSet(JWKS),
  now: () => new Date(NOW_MS),
})

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function signWith(privateKey, kid, claims, issuer) {
  return new SignJWT({ type: 'app', ...claims })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt(1_800_000_000)
    .setExpirationTime(1_800_000_300)
    .sign(privateKey)
}

describe('Access assertion verification', () => {
  it('accepts an exact signed human assertion and normalizes only its email', async () => {
    const assertion = await signAccessJwt({ sub: 'subject/kept-exact', email: ' Staff@Example.Test ' })
    await expect(verifier().verifyHumanAccessAssertion(assertion)).resolves.toEqual({
      kind: 'human', subject: 'subject/kept-exact', normalizedEmail: 'staff@example.test',
      issuedAt: 1_800_000_000, expiresAt: 1_800_000_300,
    })
  })

  it('accepts a signed Cloudflare assertion when the optional typ header is absent', async () => {
    const assertion = await signAccessJwt(TEST_IDENTITIES.owner, {
      header: { alg: 'RS256', kid: KID },
    })

    await expect(verifier().verifyHumanAccessAssertion(assertion)).resolves.toMatchObject({
      kind: 'human',
      subject: TEST_IDENTITIES.owner.sub,
      normalizedEmail: TEST_IDENTITIES.owner.email,
    })
  })

  it('rejects unsafe protected headers, claims, and timestamps as one sanitized error', async () => {
    const malformed = [
      signAccessJwt(TEST_IDENTITIES.owner, { kid: '' }),
      signAccessJwt(TEST_IDENTITIES.owner, { issuer: 'https://other.cloudflareaccess.com' }),
      signAccessJwt(TEST_IDENTITIES.owner, { audience: 'other' }),
      signAccessJwt(TEST_IDENTITIES.owner, { expiresAt: 1_799_999_999 }),
      signAccessJwt(TEST_IDENTITIES.owner, { expiresAt: 1_800_000_000 }),
      signAccessJwt(TEST_IDENTITIES.owner, { expiresAt: 1_800_029_000 }),
      signAccessJwt({ sub: 'x', email: 'x@example.test', type: 'other' }),
      signAccessJwt({ sub: '', email: 'x@example.test' }),
      signAccessJwt({ sub: 'x', email: '' }),
      signAccessJwt({ sub: 'x', email: 'x@example.test' }, { nbf: 1_800_000_100 }),
      `${encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID })))}.${encodeBase64Url(new TextEncoder().encode(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, type: 'app', sub: 'x', email: 'x@example.test', iat: 1_800_000_000, exp: 1_800_000_300 })))}.`,
      `${encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: KID })))}.x.y`,
    ]
    for (const assertion of await Promise.all(malformed)) {
      await expect(verifier().verifyHumanAccessAssertion(assertion)).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
    }
  })

  it('keeps a non-public diagnostic category for a rejected audience', async () => {
    const assertion = await signAccessJwt(TEST_IDENTITIES.owner, { audience: 'other' })
    const error = await verifier().verifyHumanAccessAssertion(assertion).catch((reason) => reason)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('ACCESS_ASSERTION_INVALID')
    expect(error.diagnosticCode).toBe('ACCESS_JWT_AUDIENCE_INVALID')
    expect(Object.keys(error)).not.toContain('diagnosticCode')
  })

  it.each([
    ['token type', { ...TEST_IDENTITIES.owner, type: 'other' }, {}, 'ACCESS_JWT_TYPE_INVALID'],
    ['lifetime', TEST_IDENTITIES.owner, { expiresAt: 1_800_029_000 }, 'ACCESS_JWT_LIFETIME_INVALID'],
    ['subject', { ...TEST_IDENTITIES.owner, sub: '' }, {}, 'ACCESS_JWT_SUBJECT_INVALID'],
    ['email', { ...TEST_IDENTITIES.owner, email: '' }, {}, 'ACCESS_JWT_EMAIL_INVALID'],
    ['principal kind', { ...TEST_IDENTITIES.owner, common_name: null }, {}, 'ACCESS_JWT_PRINCIPAL_KIND_INVALID'],
  ])('classifies an invalid %s without exposing claim values', async (_label, claims, options, expected) => {
    const assertion = await signAccessJwt(claims, options)
    const error = await verifier().verifyHumanAccessAssertion(assertion).catch((reason) => reason)

    expect(error.message).toBe('ACCESS_ASSERTION_INVALID')
    expect(error.diagnosticCode).toBe(expected)
  })

  it('accepts an audience array containing the exact audience and rejects human-service confusion', async () => {
    await expect(verifier().verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner, { audience: ['unrelated', AUDIENCE] }))).resolves.toMatchObject({ kind: 'human' })
    const serviceWithEmail = await signAccessJwt({ common_name: testConfig.accessHealthServiceTokenId, email: 'service@example.test', sub: '' })
    const wrongService = await signAccessJwt({ common_name: 'other-client', sub: '' })
    await expect(verifier().verifyServiceAccessAssertion(serviceWithEmail, testConfig)).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
    await expect(verifier().verifyServiceAccessAssertion(wrongService, testConfig)).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })

  it('accepts a service assertion only through the service verifier', async () => {
    const assertion = await signAccessJwt({ common_name: testConfig.accessHealthServiceTokenId, sub: '' })
    await expect(verifier().verifyServiceAccessAssertion(assertion, testConfig)).resolves.toMatchObject({
      kind: 'service', serviceName: testConfig.accessHealthServiceTokenId,
    })
    await expect(verifier().verifyHumanAccessAssertion(assertion)).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })

  it('uses the exact Access certificates URL and maps a remote key outage without jose details', async () => {
    const calls = []
    const jwks = createRemoteAccessJwks({ issuer: ISSUER, fetchImpl: async (url) => {
      calls.push(String(url))
      throw new Error('network detail')
    } })
    await expect(createAccessVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks, now: () => new Date(NOW_MS) })
      .verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner)))
      .rejects.toThrow(/^ACCESS_KEYSET_UNAVAILABLE$/)
    expect(calls).toEqual([`${ISSUER}/cdn-cgi/access/certs`])
  })

  it('keeps one remote resolver for the same isolate configuration', () => {
    const fetchImpl = async () => new Response(JSON.stringify(JWKS), { headers: { 'content-type': 'application/json' } })
    expect(createRemoteAccessJwks({ issuer: ISSUER, fetchImpl })).toBe(createRemoteAccessJwks({ issuer: ISSUER, fetchImpl }))
  })

  it('brands non-200 and structurally malformed remote responses as unavailable', async () => {
    for (const [issuer, response] of [
      ['https://status.cloudflareaccess.com', new Response('down', { status: 503 })],
      ['https://malformed.cloudflareaccess.com', new Response('{"keys":"bad"}', { status: 200, headers: { 'content-type': 'application/json' } })],
    ]) {
      const jwks = createRemoteAccessJwks({ issuer, fetchImpl: async () => response })
      const token = await signAccessJwt(TEST_IDENTITIES.owner, { issuer })
      await expect(createAccessVerifier({ issuer, audience: AUDIENCE, jwks, now: () => new Date(NOW_MS) }).verifyHumanAccessAssertion(token))
        .rejects.toThrow(/^ACCESS_KEYSET_UNAVAILABLE$/)
    }
  })

  it('treats a successful JWKS refresh with an unknown kid as invalid', async () => {
    const issuer = 'https://unknown-kid.cloudflareaccess.com'
    const jwks = createRemoteAccessJwks({ issuer, fetchImpl: async () => new Response(JSON.stringify(JWKS), { headers: { 'content-type': 'application/json' } }) })
    const assertion = await signAccessJwt(TEST_IDENTITIES.owner, { issuer, kid: 'unknown-kid' })
    await expect(createAccessVerifier({ issuer, audience: AUDIENCE, jwks, now: () => new Date(NOW_MS) }).verifyHumanAccessAssertion(assertion))
      .rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })

  it.each([
    ['numeric alg', { alg: 256 }],
    ['object use', { use: { value: 'sig' } }],
    ['scalar key_ops', { key_ops: 'verify' }],
    ['non-string key_ops member', { key_ops: ['verify', 1] }],
    ['numeric kid', { kid: 7 }],
    ['empty kid', { kid: '' }],
    ['numeric RSA modulus', { n: 7 }],
  ])('brands a potentially matching member with %s as unavailable', async (label, override) => {
    const issuer = `https://${label.replaceAll(/[^a-z]+/g, '-')}.cloudflareaccess.com`
    const malformed = { keys: [{ ...JWKS.keys[0], ...override }] }
    const remote = createRemoteAccessJwks({
      issuer,
      fetchImpl: async () => new Response(JSON.stringify(malformed), { headers: { 'content-type': 'application/json' } }),
    })
    const check = createAccessVerifier({ issuer, audience: AUDIENCE, jwks: remote, now: () => new Date(NOW_MS) })
    await expect(check.verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner, { issuer })))
      .rejects.toThrow(/^ACCESS_KEYSET_UNAVAILABLE$/)
  })

  it.each([
    ['different kid', { ...JWKS.keys[0], kid: 'other-valid-kid' }],
    ['different algorithm', { ...JWKS.keys[0], alg: 'RS384' }],
    ['encryption use', { ...JWKS.keys[0], alg: undefined, use: 'enc' }],
    ['non-verification operation', { ...JWKS.keys[0], alg: undefined, use: undefined, key_ops: ['encrypt'] }],
  ])('keeps a syntactically valid member with %s on the no-match path', async (label, member) => {
    const issuer = `https://no-match-${label.replaceAll(' ', '-')}.cloudflareaccess.com`
    const remote = createRemoteAccessJwks({
      issuer,
      fetchImpl: async () => new Response(JSON.stringify({ keys: [member] }), { headers: { 'content-type': 'application/json' } }),
    })
    const check = createAccessVerifier({ issuer, audience: AUDIENCE, jwks: remote, now: () => new Date(NOW_MS) })
    await expect(check.verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner, { issuer })))
      .rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })

  it('accepts a structurally valid matching Access RSA member', async () => {
    const issuer = 'https://valid-access-rsa.cloudflareaccess.com'
    const remote = createRemoteAccessJwks({
      issuer,
      fetchImpl: async () => new Response(JSON.stringify(JWKS), { headers: { 'content-type': 'application/json' } }),
    })
    const check = createAccessVerifier({ issuer, audience: AUDIENCE, jwks: remote, now: () => new Date(NOW_MS) })
    await expect(check.verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner, { issuer })))
      .resolves.toMatchObject({ kind: 'human' })
  })

  it('rejects a missing verifier method instead of returning undefined', async () => {
    const request = new Request('http://127.0.0.1:5174/api/v1/session', { headers: { 'Cf-Access-Jwt-Assertion': 'value' } })
    await expect(resolveAccessPrincipal(request, { config: testConfig, verifier: {}, expected: 'human' })).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })

  it('does not let plain resolver or verifier errors forge remote-keyset provenance', async () => {
    const forged = createAccessVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: async () => { throw new Error('ACCESS_KEYSET_UNAVAILABLE') },
      now: () => new Date(NOW_MS),
    })
    await expect(forged.verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner)))
      .rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
    const request = new Request('http://127.0.0.1:5174/api/v1/session', { headers: { 'Cf-Access-Jwt-Assertion': 'assertion' } })
    const verifier = { verifyHumanAccessAssertion: async () => { throw new Error('ACCESS_KEYSET_UNAVAILABLE') } }
    await expect(resolveAccessPrincipal(request, { config: testConfig, verifier, expected: 'human' })).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })

  it('shares one deferred cold fetch and reports its outage to every concurrent waiter', async () => {
    const failingIssuer = 'https://cold-failure.cloudflareaccess.com'
    const entered = deferred()
    const release = deferred()
    let calls = 0
    const remote = createRemoteAccessJwks({ issuer: failingIssuer, fetchImpl: async () => {
      calls += 1
      entered.resolve()
      await release.promise
      return new Response('down', { status: 503 })
    } })
    const bad = createAccessVerifier({ issuer: failingIssuer, audience: AUDIENCE, jwks: remote, now: () => new Date(NOW_MS) })
    const assertion = await signAccessJwt(TEST_IDENTITIES.owner, { issuer: failingIssuer })
    const pending = [bad.verifyHumanAccessAssertion(assertion), bad.verifyHumanAccessAssertion(assertion)]
    await entered.promise
    await Promise.resolve()
    expect(calls).toBe(1)
    release.resolve()
    const settled = await Promise.allSettled(pending)
    expect(settled.map((entry) => entry.reason?.message)).toEqual(['ACCESS_KEYSET_UNAVAILABLE', 'ACCESS_KEYSET_UNAVAILABLE'])
    expect(calls).toBe(1)
    await expect(verifier().verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner))).resolves.toMatchObject({ kind: 'human' })
  })

  it('rejects future iat and an otherwise valid token signed by another RSA key', async () => {
    await expect(verifier().verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner, { issuedAt: 1_800_000_100, expiresAt: 1_800_000_400 }))).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
    const wrong = await generateKeyPair('RS256')
    const wrongToken = await new SignJWT({ type: 'app', ...TEST_IDENTITIES.owner }).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: KID }).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt(1_800_000_000).setExpirationTime(1_800_000_300).sign(wrong.privateKey)
    await expect(verifier().verifyHumanAccessAssertion(wrongToken)).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })

  it('rejects real signed fractional iat and exp claims after signature verification', async () => {
    const fractionalIat = await signAccessJwt(TEST_IDENTITIES.owner, { issuedAt: 1_800_000_000.5, expiresAt: 1_800_000_300 })
    const fractionalExp = await signAccessJwt(TEST_IDENTITIES.owner, { issuedAt: 1_800_000_000, expiresAt: 1_800_000_300.5 })
    await expect(verifier().verifyHumanAccessAssertion(fractionalIat)).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
    await expect(verifier().verifyHumanAccessAssertion(fractionalExp)).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })

  it('brands matching malformed RSA key material as unavailable', async () => {
    const issuer = 'https://malformed-rsa.cloudflareaccess.com'
    const malformed = { keys: [{ ...JWKS.keys[0], kid: KID, n: 'not-a-real-rsa-modulus' }] }
    const remote = createRemoteAccessJwks({ issuer, fetchImpl: async () => new Response(JSON.stringify(malformed), { headers: { 'content-type': 'application/json' } }) })
    await expect(createAccessVerifier({ issuer, audience: AUDIENCE, jwks: remote, now: () => new Date(NOW_MS) }).verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner, { issuer }))).rejects.toThrow(/^ACCESS_KEYSET_UNAVAILABLE$/)
  })

  it('uses a fresh cached K1 without a second fetch during a later outage', async () => {
    const issuer = 'https://cached-k1.cloudflareaccess.com'
    let calls = 0
    let fail = false
    const remote = createRemoteAccessJwks({ issuer, fetchImpl: async () => {
      calls += 1
      if (fail) throw new Error('offline')
      return new Response(JSON.stringify(JWKS), { headers: { 'content-type': 'application/json' } })
    } })
    const check = createAccessVerifier({ issuer, audience: AUDIENCE, jwks: remote, now: () => new Date(NOW_MS) })
    const token = await signAccessJwt(TEST_IDENTITIES.owner, { issuer })
    await expect(check.verifyHumanAccessAssertion(token)).resolves.toMatchObject({ kind: 'human' })
    fail = true
    await expect(check.verifyHumanAccessAssertion(token)).resolves.toMatchObject({ kind: 'human' })
    expect(calls).toBe(1)
  })

  it('refreshes exactly once after cooldown and verifies a rotated K2', async () => {
    const issuer = 'https://rotation.cloudflareaccess.com'
    const pair = await generateKeyPair('RS256', { extractable: true })
    const publicJwk = await exportJWK(pair.publicKey)
    const k2 = { keys: [{ ...publicJwk, kid: 'fixture-rsa-v2', alg: 'RS256', use: 'sig' }] }
    const responses = [JWKS, k2]
    let calls = 0
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000)
    const remote = createRemoteAccessJwks({
      issuer,
      fetchImpl: async () => new Response(JSON.stringify(responses[calls++]), { headers: { 'content-type': 'application/json' } }),
    })
    const check = createAccessVerifier({ issuer, audience: AUDIENCE, jwks: remote, now: () => new Date(NOW_MS) })
    try {
      await expect(check.verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner, { issuer }))).resolves.toMatchObject({ kind: 'human' })
      clock.mockReturnValue(1_900_000_031_000)
      await expect(check.verifyHumanAccessAssertion(await signWith(pair.privateKey, 'fixture-rsa-v2', TEST_IDENTITIES.owner, issuer))).resolves.toMatchObject({ kind: 'human' })
      expect(calls).toBe(2)
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps a successful refresh without the requested K2 generic invalid', async () => {
    const issuer = 'https://no-k2.cloudflareaccess.com'
    const pair = await generateKeyPair('RS256')
    let calls = 0
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_900_000_100_000)
    const remote = createRemoteAccessJwks({
      issuer,
      fetchImpl: async () => {
        calls += 1
        return new Response(JSON.stringify(JWKS), { headers: { 'content-type': 'application/json' } })
      },
    })
    const check = createAccessVerifier({ issuer, audience: AUDIENCE, jwks: remote, now: () => new Date(NOW_MS) })
    try {
      await expect(check.verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner, { issuer }))).resolves.toMatchObject({ kind: 'human' })
      clock.mockReturnValue(1_900_000_131_000)
      await expect(check.verifyHumanAccessAssertion(await signWith(pair.privateKey, 'missing-rsa-v2', TEST_IDENTITIES.owner, issuer)))
        .rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
      expect(calls).toBe(2)
    } finally {
      clock.mockRestore()
    }
  })

  it('uses assertion-header presence rather than truthiness and limits local auth to the configured loopback origin', async () => {
    const local = new Request('http://127.0.0.1:5174/api/v1/session', { headers: { 'X-BWM-Local-Identity': 'staff@example.test' } })
    await expect(resolveAccessPrincipal(local, { config: testConfig, verifier: verifier(), expected: 'human' }))
      .resolves.toMatchObject({ kind: 'human', subject: 'local:staff@example.test' })
    const empty = new Request(local, { headers: { 'Cf-Access-Jwt-Assertion': '', 'X-BWM-Local-Identity': 'staff@example.test' } })
    await expect(resolveAccessPrincipal(empty, { config: testConfig, verifier: verifier(), expected: 'human' }))
      .rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
    await expect(resolveAccessPrincipal(local, { config: { ...testConfig, appEnv: 'production', localAuth: false }, verifier: verifier(), expected: 'human' }))
      .rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
    const nonFictional = new Request('http://127.0.0.1:5174/api/v1/session', { headers: { 'X-BWM-Local-Identity': 'staff@real.example' } })
    await expect(resolveAccessPrincipal(nonFictional, { config: testConfig, verifier: verifier(), expected: 'human' })).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
    await expect(resolveAccessPrincipal(local, { config: testConfig, verifier: verifier(), expected: 'service' })).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })
})
