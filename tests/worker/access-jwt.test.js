import { describe, expect, it } from 'vitest'
import { createLocalJWKSet } from 'jose'
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

describe('Access assertion verification', () => {
  it('accepts an exact signed human assertion and normalizes only its email', async () => {
    const assertion = await signAccessJwt({ sub: 'subject/kept-exact', email: ' Staff@Example.Test ' })
    await expect(verifier().verifyHumanAccessAssertion(assertion)).resolves.toEqual({
      kind: 'human', subject: 'subject/kept-exact', normalizedEmail: 'staff@example.test',
      issuedAt: 1_800_000_000, expiresAt: 1_800_000_300,
    })
  })

  it('rejects unsafe protected headers, claims, and timestamps as one sanitized error', async () => {
    const malformed = [
      signAccessJwt(TEST_IDENTITIES.owner, { header: { alg: 'RS256', kid: KID } }),
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

  it('brands only actual remote fetch failures as unavailable and rejects forged resolver errors', async () => {
    for (const [issuer, response] of [
      ['https://status.cloudflareaccess.com', new Response('down', { status: 503 })],
      ['https://malformed.cloudflareaccess.com', new Response('{"keys":"bad"}', { status: 200, headers: { 'content-type': 'application/json' } })],
    ]) {
      const jwks = createRemoteAccessJwks({ issuer, fetchImpl: async () => response })
      const token = await signAccessJwt(TEST_IDENTITIES.owner, { issuer })
      await expect(createAccessVerifier({ issuer, audience: AUDIENCE, jwks, now: () => new Date(NOW_MS) }).verifyHumanAccessAssertion(token))
        .rejects.toThrow(/^ACCESS_KEYSET_UNAVAILABLE$/)
    }
    const forged = createAccessVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: async () => { throw new Error('ACCESS_KEYSET_UNAVAILABLE') }, now: () => new Date(NOW_MS) })
    await expect(forged.verifyHumanAccessAssertion(await signAccessJwt(TEST_IDENTITIES.owner))).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })

  it('treats a successful JWKS refresh with an unknown kid as invalid', async () => {
    const issuer = 'https://unknown-kid.cloudflareaccess.com'
    const jwks = createRemoteAccessJwks({ issuer, fetchImpl: async () => new Response(JSON.stringify(JWKS), { headers: { 'content-type': 'application/json' } }) })
    const assertion = await signAccessJwt(TEST_IDENTITIES.owner, { issuer, kid: 'unknown-kid' })
    await expect(createAccessVerifier({ issuer, audience: AUDIENCE, jwks, now: () => new Date(NOW_MS) }).verifyHumanAccessAssertion(assertion))
      .rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
  })

  it('rejects a missing verifier method instead of returning undefined', async () => {
    const request = new Request('http://127.0.0.1:5174/api/v1/session', { headers: { 'Cf-Access-Jwt-Assertion': 'value' } })
    await expect(resolveAccessPrincipal(request, { config: testConfig, verifier: {}, expected: 'human' })).rejects.toThrow(/^ACCESS_ASSERTION_INVALID$/)
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
