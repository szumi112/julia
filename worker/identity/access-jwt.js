import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import { decodeBase64Url } from '../security/encoding.js'

const MAX_AGE_SECONDS = 8 * 60 * 60
const TOLERANCE_SECONDS = 5

const invalid = () => new Error('ACCESS_ASSERTION_INVALID')
const unavailable = () => new Error('ACCESS_KEYSET_UNAVAILABLE')
const integer = (value) => Number.isSafeInteger(value)
const remoteJwksByFetch = new WeakMap()
const remoteOutages = new WeakSet()
const keysetFailures = new WeakSet()

const remoteOutage = () => {
  const error = new Error('ACCESS_KEYSET_UNAVAILABLE')
  remoteOutages.add(error)
  return error
}

const keysetUnavailable = () => {
  const error = unavailable()
  keysetFailures.add(error)
  return error
}

function validRsaMaterial(key) {
  let modulus
  let exponent
  try {
    if (key?.kty !== 'RSA' || typeof key.n !== 'string' || typeof key.e !== 'string') return false
    modulus = decodeBase64Url(key.n)
    exponent = decodeBase64Url(key.e)
    return modulus.byteLength >= 256 && modulus[0] !== 0
      && exponent.byteLength > 0 && exponent.byteLength <= 8
      && exponent.some((value) => value !== 0) && (exponent.at(-1) & 1) === 1
  } catch {
    return false
  } finally {
    modulus?.fill(0)
    exponent?.fill(0)
  }
}

const matchingMalformedRsa = (jwks, protectedHeader) => jwks?.keys?.some((key) => (
  key?.kid === protectedHeader?.kid
  && key.kty === 'RSA'
  && (key.alg === undefined || key.alg === 'RS256')
  && (key.use === undefined || key.use === 'sig')
  && (key.key_ops === undefined || Array.isArray(key.key_ops) && key.key_ops.includes('verify'))
  && !validRsaMaterial(key)
))

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
    let currentJwks
    let pendingFetch
    const fetchAndValidate = async (...args) => {
      let response
      try { response = await fetchImpl(...args) } catch { throw remoteOutage() }
      if (!response?.ok) throw remoteOutage()
      try {
        const body = await response.clone().json()
        if (!body || !Array.isArray(body.keys) || body.keys.some((key) => !key || typeof key !== 'object' || typeof key.kty !== 'string')) throw remoteOutage()
        currentJwks = body
      } catch (error) {
        if (remoteOutages.has(error)) throw error
        throw remoteOutage()
      }
      return response
    }
    const guardedFetch = async (...args) => {
      pendingFetch ??= fetchAndValidate(...args).finally(() => { pendingFetch = undefined })
      return (await pendingFetch).clone()
    }
    const remote = createRemoteJWKSet(url, { [customFetch]: guardedFetch })
    const resolver = async (...args) => {
      try {
        const key = await remote(...args)
        if (matchingMalformedRsa(currentJwks, args[0])) throw remoteOutage()
        return key
      } catch (error) {
        if (remoteOutages.has(error)) throw remoteOutage()
        if (matchingMalformedRsa(currentJwks, args[0])) throw remoteOutage()
        throw error
      }
    }
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
      if (remoteOutages.has(error)) throw keysetUnavailable()
      if (error?.message === 'ACCESS_ASSERTION_INVALID') throw error
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
    const method = expected === 'human' ? verifier?.verifyHumanAccessAssertion : verifier?.verifyServiceAccessAssertion
    if (typeof method !== 'function') throw invalid()
    try {
      const principal = expected === 'human' ? await method.call(verifier, assertion) : await method.call(verifier, assertion, config)
      if (!principal || principal.kind !== expected) throw invalid()
      return principal
    } catch (error) {
      if (keysetFailures.has(error)) throw error
      throw invalid()
    }
  }
  if (expected === 'human') return localIdentity(request, config)
  throw invalid()
}
