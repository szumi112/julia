import { exportJWK, generateKeyPair, SignJWT } from 'jose'

export const NOW_MS = 1_800_000_000_000
export const ISSUER = 'https://team.cloudflareaccess.com'
export const AUDIENCE = 'bwm-worker-test'
export const KID = 'fixture-rsa-v1'

export const ACTORS = Object.freeze({
  coordinator: Object.freeze({ id: 'stf_coord', role: 'coordinator', specialistId: null }),
  owner: Object.freeze({ id: 'stf_owner', role: 'owner', specialistId: 'sp_owner' }),
  specialist: Object.freeze({ id: 'stf_spec', role: 'specialist', specialistId: 'sp_spec' }),
})

export const TEST_IDENTITIES = Object.freeze({
  coordinator: Object.freeze({ sub: 'access-coordinator', email: 'coordinator@example.test' }),
  owner: Object.freeze({ sub: 'access-owner', email: 'owner@example.test' }),
  specialist: Object.freeze({ sub: 'access-specialist', email: 'specialist@example.test' }),
})

const pair = await generateKeyPair('RS256', { extractable: true })
const publicJwk = await exportJWK(pair.publicKey)
export const JWKS = Object.freeze({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] })

export async function signAccessJwt(claims = {}, options = {}) {
  const issuedAt = options.issuedAt ?? Math.floor(NOW_MS / 1000)
  const expiresAt = options.expiresAt ?? issuedAt + 300
  const header = options.header ?? { alg: options.alg ?? 'RS256', typ: options.typ ?? 'JWT', kid: options.kid ?? KID }
  const jwt = new SignJWT({ type: 'app', ...claims })
    .setProtectedHeader(header)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
  if (options.nbf !== undefined) jwt.setNotBefore(options.nbf)
  return jwt.sign(pair.privateKey)
}

export const testConfig = Object.freeze({
  appEnv: 'development',
  appOrigin: 'http://127.0.0.1:5174',
  accessAudience: AUDIENCE,
  accessHealthServiceTokenId: 'fixture-health-client-id',
  accessIssuer: ISSUER,
  localAuth: true,
  activeLookupKeyVersion: 1,
})
