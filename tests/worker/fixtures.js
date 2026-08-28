import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

export const NOW_MS = 1_800_000_000_000
export const ISSUER = 'https://team.cloudflareaccess.com'
export const AUDIENCE = 'bwm-worker-test'
export const KID = 'fixture-rsa-v1'

export const authorityActor = ({
  id,
  role,
  specialistId = role === 'specialist' ? `sp_${id.slice(4)}` : null,
  version = 1,
  authorityRevision = 1,
  capabilities = ROLE_DEFAULT_CAPABILITIES[role],
}) => Object.freeze({
  id, role, specialistId, version, authorityRevision,
  capabilities: Object.freeze([...capabilities]),
})

export const ACTORS = Object.freeze({
  coordinator: authorityActor({ id: 'stf_coord', role: 'coordinator' }),
  owner: authorityActor({ id: 'stf_owner', role: 'owner', specialistId: 'sp_owner' }),
  specialist: authorityActor({ id: 'stf_spec', role: 'specialist', specialistId: 'sp_spec' }),
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
