import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'

const MAX_AGE_SECONDS = 8 * 60 * 60
const TOLERANCE_SECONDS = 5

const invalid = () => new Error('ACCESS_ASSERTION_INVALID')
const unavailable = () => new Error('ACCESS_KEYSET_UNAVAILABLE')
const integer = (value) => Number.isSafeInteger(value)
const remoteJwksByFetch = new WeakMap()

export function createRemoteAccessJwks({ issuer, fetchImpl = fetch } = {}) {
  try {
    const url = new URL('/cdn-cgi/access/certs', issuer)
    if (url.origin !== issuer || typeof fetchImpl !== 'function') throw new Error('invalid')
    let byIssuer = remoteJwksByFetch.get(fetchImpl)
    if (!byIssuer) {
      byIssuer = new Map()
      remoteJwksByFetch.set(fetchImpl, byIssuer)
    }
    const cached = byIssuer.get(issuer)
    if (cached) return cached
    const guardedFetch = async (...args) => {
      try { return await fetchImpl(...args) } catch { throw unavailable() }
    }
    const remote = createRemoteJWKSet(url, { [customFetch]: guardedFetch })
    const resolver = async (...args) => remote(...args)
    byIssuer.set(issuer, resolver)
    return resolver
  } catch {
    throw invalid()
  }
}

function validatePayload(payload, protectedHeader, nowMs) {
  if (protectedHeader?.alg !== 'RS256' || protectedHeader?.typ !== 'JWT' || typeof protectedHeader?.kid !== 'string' || !protectedHeader.kid) throw invalid()
  if (payload?.type !== 'app' || !integer(payload.iat) || !integer(payload.exp) || payload.exp <= payload.iat
    || payload.exp - payload.iat > MAX_AGE_SECONDS + TOLERANCE_SECONDS || payload.iat > Math.floor(nowMs / 1000) + TOLERANCE_SECONDS) throw invalid()
  if (payload.nbf !== undefined && (!integer(payload.nbf) || payload.nbf > Math.floor(nowMs / 1000) + TOLERANCE_SECONDS)) throw invalid()
}

export function createAccessVerifier({ issuer, audience, jwks, now = () => new Date() } = {}) {
  if (typeof issuer !== 'string' || !issuer || typeof audience !== 'string' || !audience || typeof jwks !== 'function' || typeof now !== 'function') throw invalid()
  const verify = async (assertion) => {
    if (typeof assertion !== 'string' || !assertion) throw invalid()
    try {
      const current = now()
      if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw invalid()
      const verified = await jwtVerify(assertion, jwks, {
        algorithms: ['RS256'], audience, issuer, requiredClaims: ['iat', 'exp'],
        clockTolerance: TOLERANCE_SECONDS, currentDate: current,
      })
      validatePayload(verified.payload, verified.protectedHeader, current.getTime())
      return verified
    } catch (error) {
      if (error?.message === 'ACCESS_ASSERTION_INVALID' || error?.message === 'ACCESS_KEYSET_UNAVAILABLE') throw error
      throw invalid()
    }
  }
  return Object.freeze({
    async verifyHumanAccessAssertion(assertion) {
      const { payload } = await verify(assertion)
      if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.email !== 'string') throw invalid()
      const normalizedEmail = payload.email.trim().toLowerCase()
      if (!normalizedEmail || Object.hasOwn(payload, 'common_name')) throw invalid()
      return Object.freeze({ kind: 'human', subject: payload.sub, normalizedEmail, issuedAt: payload.iat, expiresAt: payload.exp })
    },
    async verifyServiceAccessAssertion(assertion, config) {
      const { payload } = await verify(assertion)
      if (typeof config?.accessHealthServiceTokenId !== 'string' || !config.accessHealthServiceTokenId
        || payload.common_name !== config.accessHealthServiceTokenId || Object.hasOwn(payload, 'email') || payload.sub !== '') throw invalid()
      return Object.freeze({ kind: 'service', serviceName: payload.common_name, issuedAt: payload.iat, expiresAt: payload.exp })
    },
  })
}

const localIdentity = (request, config) => {
  const value = request.headers.get('X-BWM-Local-Identity')
  if (value === null || config?.localAuth !== true || config?.appEnv !== 'development') throw invalid()
  const url = new URL(request.url)
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.origin !== config.appOrigin) throw invalid()
  const normalizedEmail = value.trim().toLowerCase()
  if (!/^[^@\s]+@example\.test$/.test(normalizedEmail)) throw invalid()
  return Object.freeze({ kind: 'human', subject: `local:${normalizedEmail}`, normalizedEmail, issuedAt: null, expiresAt: null })
}

export async function resolveAccessPrincipal(request, { config, verifier, expected } = {}) {
  if (!(request instanceof Request) || !['human', 'service'].includes(expected)) throw invalid()
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion')
  if (assertion !== null) {
    return expected === 'human'
      ? verifier?.verifyHumanAccessAssertion(assertion)
      : verifier?.verifyServiceAccessAssertion(assertion, config)
  }
  if (expected === 'human') return localIdentity(request, config)
  throw invalid()
}
