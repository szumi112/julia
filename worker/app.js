import { Hono } from 'hono'
import { auditEventStatement } from './audit/events.js'
import { loadConfig } from './config.js'
import { apiError, AppError, publicError } from './http/errors.js'
import {
  applyApiSecurityHeaders,
  isMutationMethod,
  isSupportedMethod,
  readJsonBodyOnce,
  validateMutationMetadata,
  validateOptionsOrigin,
} from './http/security.js'
import {
  createAccessVerifier,
  createRemoteAccessJwks,
  resolveAccessPrincipal as resolvePrincipal,
} from './identity/access-jwt.js'
import { resolveActor as resolveStaffActor } from './identity/staff.js'
import { isCorrelationId, safeLog } from './logging/safe-log.js'
import { getSession } from './routes/session.js'
import { verifyCsrfToken as verifyCsrf } from './security/csrf.js'
import { loadDataKey } from './security/envelope.js'
import { createKeyring } from './security/keyring.js'

const IDENTITY_SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const verifiers = new WeakMap()
const keyrings = new WeakMap()
const SESSION_ALLOW = 'GET, HEAD, OPTIONS'
const HEALTH_ALLOW = 'GET, HEAD'

const routeFor = (request) => {
  const url = new URL(request.url)
  const healthPath = url.pathname === '/api/v1/health/live' && url.search === ''
  const exactHealth = healthPath && ['GET', 'HEAD'].includes(request.method)
  if (exactHealth) return { id: 'health.live', expected: 'service', allow: HEALTH_ALLOW, healthPath }
  if (healthPath) return { id: 'health.live', expected: 'service', allow: HEALTH_ALLOW, healthPath }
  if (url.pathname === '/api/v1/session') return { id: 'session', expected: 'human', allow: SESSION_ALLOW, healthPath }
  return { id: 'unmatched', expected: 'human', allow: null, healthPath }
}

const runtimeConfig = (c, deps) => deps.config ?? loadConfig(c.env)

function runtimeVerifier(config, deps) {
  if (deps.accessVerifier) return deps.accessVerifier
  const fetchImpl = deps.fetch ?? fetch
  const key = `${config.accessIssuer}\n${config.accessAudience}`
  let byConfig = verifiers.get(fetchImpl)
  if (!byConfig) {
    byConfig = new Map()
    verifiers.set(fetchImpl, byConfig)
  }
  let verifier = byConfig.get(key)
  if (!verifier) {
    const jwks = (deps.createRemoteAccessJwks ?? createRemoteAccessJwks)({
      issuer: config.accessIssuer,
      fetchImpl,
    })
    verifier = (deps.createAccessVerifier ?? createAccessVerifier)({
      issuer: config.accessIssuer,
      audience: config.accessAudience,
      jwks,
      now: deps.dateNow ? () => new Date(deps.dateNow()) : undefined,
    })
    byConfig.set(key, verifier)
  }
  return verifier
}

async function runtimeKeyring(c, config, deps) {
  if (deps.keyring) return deps.keyring
  if (deps.cryptoContext?.keyring) return deps.cryptoContext.keyring
  if (!c.env || typeof c.env !== 'object') throw new Error('CRYPTO_FAILURE')
  let ring = keyrings.get(c.env)
  if (!ring) {
    ring = await (deps.createKeyring ?? createKeyring)(c.env, config)
    keyrings.set(c.env, ring)
  }
  return ring
}

async function identityCryptoContext(c, config, deps) {
  if (deps.cryptoContext) return deps.cryptoContext
  const scope = deps.identityScope ?? IDENTITY_SCOPE
  const keyring = await runtimeKeyring(c, config, deps)
  const row = await c.env.DB.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1`
  ).bind(scope.type, scope.id, scope.purpose).first()
  if (!row) throw new Error('CRYPTO_FAILURE')
  return { keyring, dataKey: row, scope }
}

const nowMs = (deps) => {
  const value = (deps.now ?? Date.now)()
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INTERNAL_ERROR')
  return value
}

const idFactory = () => crypto.randomUUID().replaceAll('-', '')

export function createApp(deps = {}) {
  const app = new Hono()

  app.use('/api/*', async (c, next) => {
    const start = performance.now()
    const requested = c.req.header('x-correlation-id')
    const correlationId = isCorrelationId(requested) ? requested : crypto.randomUUID()
    c.set('correlationId', correlationId)
    c.set('routeId', 'unmatched')
    await next()
    c.res = applyApiSecurityHeaders(c.res, correlationId)
    const mapped = c.error ? publicError(c.error) : null
    const actor = c.get('actor')
    const log = deps.safeLog ?? safeLog
    log(c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info', {
      event: c.res.status >= 400 ? 'request.failed' : 'request.completed',
      result: c.res.status >= 400 ? 'failure' : 'success',
      correlationId,
      durationMs: Math.max(0, performance.now() - start),
      method: c.req.raw.method,
      routeId: c.get('routeId'),
      status: c.res.status,
      ...(actor?.id ? { actorId: actor.id } : {}),
      ...(mapped ? { errorCode: mapped.code } : {}),
    })
  })

  app.use('/api/v1/*', async (c, next) => {
    const request = c.req.raw
    const method = request.method
    const route = routeFor(request)
    c.set('routeId', route.id)
    if (!isSupportedMethod(method)) throw new AppError('METHOD_NOT_ALLOWED')
    if (route.healthPath && !['GET', 'HEAD'].includes(method)) throw new AppError('METHOD_NOT_ALLOWED')

    const config = runtimeConfig(c, deps)
    const requestNowMs = route.expected === 'human' || isMutationMethod(method) ? nowMs(deps) : null
    c.set('nowMs', requestNowMs)
    if (isMutationMethod(method)) validateMutationMetadata(request, config)
    else if (method === 'OPTIONS') validateOptionsOrigin(request, config)

    const verifier = deps.accessVerifier ?? (deps.resolveAccessPrincipal ? null : runtimeVerifier(config, deps))
    const principal = await (deps.resolveAccessPrincipal ?? resolvePrincipal)(request, {
      config,
      verifier,
      expected: route.expected,
    })
    if (principal?.kind !== route.expected) throw new Error('ACCESS_ASSERTION_INVALID')
    c.set('principal', principal)

    let keyring
    if (isMutationMethod(method)) {
      keyring = await runtimeKeyring(c, config, deps)
      await (deps.verifyCsrfToken ?? verifyCsrf)(request.headers.get('X-CSRF-Token'), {
        subject: principal.subject,
        origin: config.appOrigin,
        keyring,
        nowMs: requestNowMs,
      })
    }

    if (route.expected === 'human') {
      const cryptoContext = await identityCryptoContext(c, config, deps)
      const actor = await (deps.resolveActor ?? resolveStaffActor)(
        c.env?.DB ?? deps.db,
        principal,
        cryptoContext,
        {
          nowMs: requestNowMs,
          correlationId: c.get('correlationId'),
          idFactory: deps.idFactory ?? idFactory,
          auditEventStatement,
        }
      )
      c.set('actor', actor)
      c.set('cryptoContext', cryptoContext)
    }

    if (isMutationMethod(method)) {
      c.set('jsonBody', await (deps.readJsonBodyOnce ?? readJsonBodyOnce)(request))
    }
    await next()
  })

  app.get('/api/v1/health/live', (c) => c.json({ data: { status: 'ok' } }))
  app.get('/api/v1/session', async (c) => {
    const config = runtimeConfig(c, deps)
    const result = deps.session
      ? await deps.session({
        db: c.env?.DB ?? deps.db,
        config,
        principal: c.get('principal'),
        actor: c.get('actor'),
        cryptoContext: c.get('cryptoContext'),
        nowMs: c.get('nowMs'),
      })
      : await getSession({
        db: c.env?.DB ?? deps.db,
        config,
        principal: c.get('principal'),
        actor: c.get('actor'),
        cryptoContext: c.get('cryptoContext'),
        nowMs: c.get('nowMs'),
      })
    return c.json(result)
  })
  app.options('/api/v1/session', (c) => new Response(null, {
    status: 204,
    headers: { Allow: SESSION_ALLOW },
  }))
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/api/v1/session', () => {
    throw new AppError('METHOD_NOT_ALLOWED')
  })

  app.notFound((c) => {
    const correlationId = c.get('correlationId') || crypto.randomUUID()
    return apiError(new AppError('NOT_FOUND'), correlationId)
  })
  app.onError((error, c) => {
    const mapped = publicError(error)
    const headers = mapped.code === 'METHOD_NOT_ALLOWED'
      ? { Allow: c.get('routeId') === 'health.live' ? HEALTH_ALLOW : c.get('routeId') === 'session' ? SESSION_ALLOW : 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE' }
      : mapped.code === 'ACCESS_KEYSET_UNAVAILABLE' ? { 'Retry-After': '5' }
        : undefined
    return apiError(mapped, c.get('correlationId') || crypto.randomUUID(), headers)
  })
  return app
}
