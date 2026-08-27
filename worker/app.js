import { Hono } from 'hono'
import { isCoreAuditAction } from '../src/core-audit-contract.js'
import { auditEventStatement } from './audit/events.js'
import { loadConfig } from './config.js'
import { createD1QueryBudget } from './db/query-budget.js'
import { apiError, AppError, publicError } from './http/errors.js'
import {
  applyApiSecurityHeaders,
  isMutationMethod,
  isSupportedMethod,
  readMultipartBodyOnce,
  readJsonBodyOnce,
  validateMutationMetadata,
  validateOptionsOrigin,
} from './http/security.js'
import {
  createAccessVerifier,
  createRemoteAccessJwks,
  resolveAccessPrincipal as resolvePrincipal,
} from './identity/access-jwt.js'
import {
  resolveActiveActorReadOnly,
  resolveActor as resolveStaffActor,
} from './identity/staff.js'
import { isCorrelationId, safeLog } from './logging/safe-log.js'
import {
  getOperationalHealth,
  listOpenOperationalActions,
  listSecurityAudit,
  resolveOperationalAction,
} from './routes/operations.js'
import { getSession } from './routes/session.js'
import {
  getStaff,
  postDeactivation,
  postInvitation,
  postSpecialistInvitation,
} from './routes/staff.js'
import { getWorkspace } from './routes/workspace.js'
import { postClient, postClientArchive, postClientEdit } from './routes/clients.js'
import {
  postAppointment,
  postAppointmentCancellation,
  postAppointmentEdit,
  postAppointmentPayment,
} from './routes/appointments.js'
import { postPaymentCorrection } from './routes/payments.js'
import {
  postSpecialistProfile,
  postSpecialistProfileEdit,
} from './routes/specialists.js'
import {
  getFinance,
  postFinanceImport,
  postFinanceImportChunk,
  postFinanceImportCommit,
} from './routes/finance.js'
import { verifyCsrfToken as verifyCsrf } from './security/csrf.js'
import { loadDataKey } from './security/envelope.js'
import { createKeyring } from './security/keyring.js'
import {
  createWorkbookImport,
  continueWorkbookImport,
  exportWorkbook,
  getWorkbookImport,
  loadWorkbookPanelState,
  previewWorkbook,
} from './core/workbooks.js'

const IDENTITY_SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const verifiers = new WeakMap()
const keyrings = new WeakMap()
const SESSION_ALLOW = 'GET, HEAD, OPTIONS'
const HEALTH_ALLOW = 'GET, HEAD'
const STAFF_MUTATION_ALLOW = 'POST, OPTIONS'
const OPERATIONS_READ_ALLOW = 'GET, HEAD, OPTIONS'
const OPERATIONS_MUTATION_ALLOW = 'POST, OPTIONS'
const HEALTH_PATH = '/api/v1/health/live'
const STAFF_PATH = '/api/v1/staff'
const STAFF_INVITATIONS_PATH = '/api/v1/staff/invitations'
const STAFF_ID = /^\/api\/v1\/staff\/stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}\/deactivation$/
const SPECIALIST_INVITATION_ID = /^\/api\/v1\/specialists\/sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}\/invitations$/
const ACTION_RESOLUTION_PATH = /^\/api\/v1\/operations\/actions\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/resolution$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CLIENT_PATH_ID = 'cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}'
const APPOINTMENT_PATH_ID = 'apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}'
const PAYMENT_PATH_ID = 'pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}'
const FINANCE_BATCH_PATH_ID = 'fib_[A-Za-z0-9][A-Za-z0-9_-]{0,123}'
const WORKBOOK_IMPORT_PATH_ID = 'wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}'
const CORE_COMMAND_ALLOW = 'POST, OPTIONS'
const CORE_READ_ALLOW = 'GET, HEAD, OPTIONS'
const CORE_BUDGET = Object.freeze({ totalLimit: 50, recoveryReserve: 8 })
const coreRouteMatchers = new WeakMap()
const descriptor = (value) => {
  const route = Object.freeze({
    ...value,
    methods: Object.freeze([...value.methods]),
    auditActions: Object.freeze([...value.auditActions]),
    bodyKeys: value.bodyKeys ? Object.freeze([...value.bodyKeys]) : null,
    bodyMode: value.bodyMode ?? 'json',
    freshAuth: value.freshAuth === true,
    idempotency: value.idempotency !== false,
    queryMode: value.queryMode ?? (value.bodyKeys === null ? 'any' : 'none'),
    sharedBudget: CORE_BUDGET,
    core: true,
    expected: 'human',
  })
  const matcher = value.path
    ? (pathname) => pathname === value.path
    : new RegExp(value.pathPattern)
  coreRouteMatchers.set(route, matcher)
  return route
}
const CORE_ROUTES = Object.freeze([
  descriptor({ id: 'workspace', path: '/api/v1/workspace', methods: ['GET', 'HEAD', 'OPTIONS'], allow: CORE_READ_ALLOW, capability: 'client.operational.read', auditActions: [], bodyKeys: null }),
  descriptor({ id: 'specialists.create', path: '/api/v1/specialists', methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'staff.manage', auditActions: ['specialist.profile.created'], bodyKeys: ['displayName', 'standardRateGrosze'] }),
  descriptor({ id: 'specialists.edit', pathPattern: `^/api/v1/specialists/sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}/edits$`, methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'staff.manage', auditActions: ['specialist.profile.updated'], bodyKeys: ['expectedVersion', 'displayName', 'standardRateGrosze'] }),
  descriptor({ id: 'clients.create', path: '/api/v1/clients', methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'client.manage', auditActions: ['client.created'], bodyKeys: ['name', 'age', 'status', 'specialistId'] }),
  descriptor({ id: 'clients.edit', pathPattern: `^/api/v1/clients/${CLIENT_PATH_ID}/edits$`, methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'client.manage', auditActions: ['client.updated', 'client.assignment.changed'], bodyKeys: ['expectedVersion', 'name', 'age', 'status', 'specialistId'] }),
  descriptor({ id: 'clients.archive', pathPattern: `^/api/v1/clients/${CLIENT_PATH_ID}/archive$`, methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'client.manage', auditActions: ['client.archived'], bodyKeys: ['expectedVersion'] }),
  descriptor({ id: 'appointments.create', path: '/api/v1/appointments', methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'appointment.manage', auditActions: ['appointment.created'], bodyKeys: ['clientId', 'specialistId', 'serviceId', 'date', 'time', 'durationMinutes', 'expectedAmountGrosze', 'location', 'status'] }),
  descriptor({ id: 'appointments.edit', pathPattern: `^/api/v1/appointments/${APPOINTMENT_PATH_ID}/edits$`, methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'appointment.manage', auditActions: ['appointment.updated'], bodyKeys: ['expectedVersion', 'specialistId', 'serviceId', 'date', 'time', 'durationMinutes', 'expectedAmountGrosze', 'location', 'status'] }),
  descriptor({ id: 'appointments.cancel', pathPattern: `^/api/v1/appointments/${APPOINTMENT_PATH_ID}/cancellation$`, methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'appointment.manage', auditActions: ['appointment.cancelled'], bodyKeys: ['expectedVersion'] }),
  descriptor({ id: 'appointments.payment', pathPattern: `^/api/v1/appointments/${APPOINTMENT_PATH_ID}/payments$`, methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'payment.manage', auditActions: ['payment.recorded'], bodyKeys: ['expectedVersion', 'amountGrosze', 'method', 'receivedAt'] }),
  descriptor({ id: 'payments.correct', pathPattern: `^/api/v1/payments/${PAYMENT_PATH_ID}/corrections$`, methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'payment.manage', auditActions: ['payment.corrected'], bodyKeys: ['expectedVersion', 'reason', 'replacement'] }),
  descriptor({ id: 'finance.list', path: '/api/v1/finance', methods: ['GET', 'HEAD', 'OPTIONS'], allow: CORE_READ_ALLOW, capability: 'finance.centre.read', auditActions: [], bodyKeys: null }),
  descriptor({ id: 'finance.import.start', path: '/api/v1/finance/imports', methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'finance.centre.manage', auditActions: ['finance.import.started'], bodyKeys: ['filename', 'fingerprint', 'formatVersion', 'totalRows'] }),
  descriptor({ id: 'finance.import.chunk', pathPattern: `^/api/v1/finance/imports/${FINANCE_BATCH_PATH_ID}/chunks$`, methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'finance.centre.manage', auditActions: ['finance.import.chunk.accepted'], bodyKeys: ['sequence', 'entries'] }),
  descriptor({ id: 'finance.import.commit', pathPattern: `^/api/v1/finance/imports/${FINANCE_BATCH_PATH_ID}/commit$`, methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'finance.centre.manage', auditActions: ['finance.import.committed'], bodyKeys: ['expectedVersion'] }),
  descriptor({ id: 'workbooks.preview', path: '/api/v1/workbooks/preview', methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'finance.centre.manage', auditActions: [], bodyKeys: null, bodyMode: 'workbook-multipart', idempotency: false, queryMode: 'none' }),
  descriptor({ id: 'workbooks.import', path: '/api/v1/workbooks/imports', methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'finance.centre.manage', auditActions: ['workbook.import.created'], bodyKeys: null, bodyMode: 'workbook-multipart', freshAuth: true, queryMode: 'none' }),
  descriptor({ id: 'workbooks.continue', pathPattern: `^/api/v1/workbooks/imports/${WORKBOOK_IMPORT_PATH_ID}/continue$`, methods: ['POST', 'OPTIONS'], allow: CORE_COMMAND_ALLOW, capability: 'finance.centre.manage', auditActions: ['workbook.import.materialized'], bodyKeys: null, bodyMode: 'workbook-multipart', freshAuth: true, queryMode: 'none' }),
  descriptor({ id: 'workbooks.status', pathPattern: `^/api/v1/workbooks/imports/${WORKBOOK_IMPORT_PATH_ID}$`, methods: ['GET', 'HEAD', 'OPTIONS'], allow: CORE_READ_ALLOW, capability: 'finance.centre.manage', auditActions: [], bodyKeys: null, queryMode: 'none' }),
  descriptor({ id: 'workbooks.export', path: '/api/v1/workbooks/export', methods: ['GET', 'HEAD', 'OPTIONS'], allow: CORE_READ_ALLOW, capability: 'finance.centre.manage', auditActions: [], bodyKeys: null, freshAuth: true, queryMode: 'handler' }),
])
export const CORE_ROUTE_DESCRIPTORS = CORE_ROUTES
if (CORE_ROUTES.some((route) => route.auditActions.some((action) => !isCoreAuditAction(action)))) {
  throw new Error('CORE_ROUTE_REGISTRY_INVALID')
}
const OPERATION_SERVICES = Object.freeze({
  getOperationalHealth,
  listOpenOperationalActions,
  listSecurityAudit,
  resolveOperationalAction,
})

const routeFor = (request) => {
  const url = new URL(request.url)
  if (url.pathname === HEALTH_PATH && url.search === '') {
    return { id: 'health.live', expected: 'service', methods: ['GET', 'HEAD'] }
  }
  if (url.pathname === '/api/v1/session') {
    return { id: 'session', expected: 'human', methods: ['GET', 'HEAD', 'OPTIONS'] }
  }
  for (const route of CORE_ROUTES) {
    const matcher = coreRouteMatchers.get(route)
    const pathMatches = typeof matcher === 'function'
      ? matcher(url.pathname)
      : matcher.test(url.pathname)
    if (pathMatches) {
      if (route.queryMode === 'none' && url.search !== '') {
        return { id: 'unmatched', expected: 'human', methods: null, queryRejected: true }
      }
      return route
    }
  }
  if (url.search === '' && url.pathname === STAFF_PATH) return { id: 'staff.list', expected: 'human', methods: ['GET', 'HEAD', 'OPTIONS'] }
  if (url.search === '' && url.pathname === STAFF_INVITATIONS_PATH) return { id: 'staff.invitations', expected: 'human', methods: ['POST', 'OPTIONS'] }
  if (url.search === '' && SPECIALIST_INVITATION_ID.test(url.pathname)) return { id: 'specialists.invitations', expected: 'human', methods: ['POST', 'OPTIONS'] }
  if (url.search === '' && STAFF_ID.test(url.pathname)) return { id: 'staff.deactivation', expected: 'human', methods: ['POST', 'OPTIONS'] }
  if (url.search === '' && url.pathname === '/api/v1/operations/health') {
    return { id: 'operations.health', expected: 'human', methods: ['GET', 'HEAD', 'OPTIONS'], allow: OPERATIONS_READ_ALLOW, service: 'getOperationalHealth' }
  }
  if (url.search === '' && url.pathname === '/api/v1/operations/actions') {
    return { id: 'operations.actions', expected: 'human', methods: ['GET', 'HEAD', 'OPTIONS'], allow: OPERATIONS_READ_ALLOW, service: 'listOpenOperationalActions' }
  }
  if (url.pathname === '/api/v1/security/audit') {
    return { id: 'security.audit', expected: 'human', methods: ['GET', 'HEAD', 'OPTIONS'], allow: OPERATIONS_READ_ALLOW, service: 'listSecurityAudit' }
  }
  const resolution = url.search === '' ? ACTION_RESOLUTION_PATH.exec(url.pathname) : null
  if (resolution) {
    return { id: 'operations.action-resolution', expected: 'human', methods: ['POST', 'OPTIONS'], allow: OPERATIONS_MUTATION_ALLOW, service: 'resolveOperationalAction', actionId: resolution[1] }
  }
  return { id: 'unmatched', expected: 'human', methods: null }
}

const isWorkbookNamespace = (request) => {
  const pathname = new URL(request.url).pathname
  return pathname === '/api/v1/workbooks' || pathname.startsWith('/api/v1/workbooks/')
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

async function identityCryptoContext(c, config, deps, db) {
  if (deps.cryptoContext) return deps.cryptoContext
  const scope = deps.identityScope ?? IDENTITY_SCOPE
  const keyring = await runtimeKeyring(c, config, deps)
  const row = await db.prepare(
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

const validateResolutionIdempotency = (request) => {
  const value = request.headers.get('Idempotency-Key')
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new AppError('VALIDATION_FAILED')
  }
}

const requireRecentHumanPrincipal = (principal, requestNowMs) => {
  const nowSeconds = Math.floor(requestNowMs / 1_000)
  if (!Number.isSafeInteger(principal?.issuedAt)
    || !Number.isSafeInteger(principal?.expiresAt)
    || principal.issuedAt > nowSeconds
    || nowSeconds - principal.issuedAt > 300
    || principal.expiresAt <= nowSeconds) throw new AppError('REAUTH_REQUIRED')
}

const workbookForm = (value, keys) => {
  if (!(value instanceof FormData)) throw new AppError('INVALID_MULTIPART')
  const entries = [...value.entries()]
  if (entries.length !== keys.length
    || new Set(entries.map(([key]) => key)).size !== entries.length
    || keys.some((key) => !entries.some(([actual]) => actual === key))) {
    throw new AppError('VALIDATION_FAILED', { field: 'body' })
  }
  return Object.freeze(Object.fromEntries(entries))
}

const workbookFile = async (value) => {
  if (!(value instanceof File) || value.size < 1 || value.size > 5 * 1024 * 1024
    || typeof value.name !== 'string' || !value.name.toLowerCase().endsWith('.xlsx')
    || value.name.includes('/') || value.name.includes('\\')) {
    throw new AppError('VALIDATION_FAILED', { field: 'filename' })
  }
  return Object.freeze({
    bytes: new Uint8Array(await value.arrayBuffer()),
    filename: value.name,
  })
}

const workbookStream = (source) => {
  if (!(source instanceof Uint8Array) || source.byteLength < 1) throw new Error('INTERNAL_ERROR')
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= source.byteLength) {
        source.fill(0)
        controller.close()
        return
      }
      const end = Math.min(source.byteLength, offset + 64 * 1024)
      controller.enqueue(source.slice(offset, end))
      offset = end
    },
    cancel() { source.fill(0) },
  })
}

const readResponse = (c, result) => {
  const response = c.json(result)
  return c.req.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response
}

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
    const mapped = c.error ? publicError(c.error)
      : c.get('errorCode') ? new AppError(c.get('errorCode')) : null
    const jwtDiagnostic = typeof c.error?.diagnosticCode === 'string'
      && /^ACCESS_JWT_[A-Z0-9_]{1,48}$/.test(c.error.diagnosticCode)
      ? c.error.diagnosticCode
      : null
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
      ...(mapped ? { errorCode: jwtDiagnostic ?? mapped.code } : {}),
    })
  })

  app.use('/api/v1/*', async (c, next) => {
    const request = c.req.raw
    const method = request.method
    const route = routeFor(request)
    c.set('routeId', route.id)
    c.set('routeAllow', route.allow)
    c.set('routeActionId', route.actionId)
    const config = runtimeConfig(c, deps)
    if (isWorkbookNamespace(request)
      && !(config.appEnv === 'staging' && config.dataMode === 'fictional')) {
      throw new AppError('NOT_FOUND')
    }
    if (route.queryRejected) throw new AppError('NOT_FOUND')
    if (!isSupportedMethod(method)) throw new AppError('METHOD_NOT_ALLOWED')
    if (route.methods && !route.methods.includes(method)) throw new AppError('METHOD_NOT_ALLOWED')

    if (route.core) {
      const rawDb = c.env?.DB ?? deps.db
      const budget = createD1QueryBudget(rawDb, CORE_BUDGET)
      c.set('coreD1Budget', budget)
      c.set('coreWorkDb', budget.work)
      c.set('coreRecoveryDb', budget.recovery)
    }

    const requestNowMs = route.expected === 'human' || isMutationMethod(method) ? nowMs(deps) : null
    c.set('nowMs', requestNowMs)
    if (isMutationMethod(method)) {
      validateMutationMetadata(request, config, { bodyMode: route.bodyMode ?? 'json' })
      if (route.id === 'operations.action-resolution'
        || (route.core && route.idempotency !== false)) validateResolutionIdempotency(request)
    }
    else if (method === 'OPTIONS') validateOptionsOrigin(request, config)

    const verifier = deps.accessVerifier ?? (deps.resolveAccessPrincipal ? null : runtimeVerifier(config, deps))
    const principal = await (deps.resolveAccessPrincipal ?? resolvePrincipal)(request, {
      config,
      verifier,
      expected: route.expected,
    })
    if (principal?.kind !== route.expected) throw new Error('ACCESS_ASSERTION_INVALID')
    c.set('principal', principal)
    if (route.freshAuth) requireRecentHumanPrincipal(principal, requestNowMs)

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

    if (route.service && method !== 'OPTIONS') {
      const service = Object.hasOwn(deps, route.service)
        ? deps[route.service]
        : OPERATION_SERVICES[route.service]
      if (typeof service !== 'function') throw new Error('OPERATIONS_INVALID')
      c.set('operationService', service)
    }

    if (route.expected === 'human') {
      const actorDb = route.core ? c.get('coreWorkDb') : c.env?.DB ?? deps.db
      const cryptoContext = await identityCryptoContext(c, config, deps, actorDb)
      const actorResolver = route.id === 'workbooks.preview'
        ? deps.resolvePreviewActor ?? resolveActiveActorReadOnly
        : deps.resolveActor ?? resolveStaffActor
      const actor = await actorResolver(
        actorDb,
        principal,
        cryptoContext,
        {
          nowMs: requestNowMs,
          correlationId: c.get('correlationId'),
          idFactory: deps.idFactory ?? idFactory,
          auditEventStatement,
          ...(route.core ? { recoveryDb: c.get('coreRecoveryDb') } : {}),
        }
      )
      c.set('actor', actor)
      c.set('cryptoContext', cryptoContext)
    }

    if (isMutationMethod(method)) {
      if (route.bodyMode === 'workbook-multipart') {
        c.set('multipartBody', await (deps.readMultipartBodyOnce
          ?? readMultipartBodyOnce)(request))
      } else {
        c.set('jsonBody', await (deps.readJsonBodyOnce ?? readJsonBodyOnce)(request, {
          rejectDuplicateTopLevelKeys: route.core || route.id === 'staff.invitations'
            || route.id === 'specialists.invitations'
            || route.id === 'staff.deactivation'
            || route.id === 'operations.action-resolution',
        }))
      }
      if (route.core && route.bodyMode === 'json') {
        let descriptors
        try { descriptors = Object.getOwnPropertyDescriptors(c.get('jsonBody')) } catch {
          throw new AppError('VALIDATION_FAILED', { field: 'body' })
        }
        const keys = Reflect.ownKeys(descriptors)
        if (keys.length !== route.bodyKeys.length || keys.some((key) => (
          typeof key !== 'string' || !route.bodyKeys.includes(key)
          || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable
        ))) throw new AppError('VALIDATION_FAILED', { field: 'body' })
      }
    }
    await next()
  })

  app.get('/api/v1/health/live', (c) => {
    if (c.get('routeId') !== 'health.live') throw new AppError('NOT_FOUND')
    return c.json({ data: { status: 'ok' } })
  })
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
  app.get('/api/v1/workspace', async (c) => {
    if (c.get('routeId') !== 'workspace') throw new AppError('NOT_FOUND')
    const result = await (deps.getWorkspace ?? getWorkspace)({
      db: c.get('coreWorkDb'),
      actor: c.get('actor'),
      cryptoContext: c.get('cryptoContext'),
      url: c.req.url,
    })
    return readResponse(c, result)
  })
  app.post('/api/v1/clients', async (c) => {
    if (c.get('routeId') !== 'clients.create') throw new AppError('NOT_FOUND')
    const input = {
      db: c.get('coreWorkDb'),
      recoveryDb: c.get('coreRecoveryDb'),
      actor: c.get('actor'),
      keyring: c.get('cryptoContext')?.keyring,
      nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
      body: c.get('jsonBody'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.createClient ? { create: deps.createClient } : {}),
    }
    const result = await (deps.postClient ?? postClient)(input)
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/specialists', async (c) => {
    if (c.get('routeId') !== 'specialists.create') throw new AppError('NOT_FOUND')
    const result = await (deps.postSpecialistProfile ?? postSpecialistProfile)({
      db: c.get('coreWorkDb'), recoveryDb: c.get('coreRecoveryDb'),
      actor: c.get('actor'), keyring: c.get('cryptoContext')?.keyring,
      nowMs: c.get('nowMs'), correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory, body: c.get('jsonBody'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.createSpecialistProfile ? { create: deps.createSpecialistProfile } : {}),
    })
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/specialists/:specialistId/edits', async (c) => {
    if (c.get('routeId') !== 'specialists.edit') throw new AppError('NOT_FOUND')
    const result = await (deps.postSpecialistProfileEdit ?? postSpecialistProfileEdit)({
      db: c.get('coreWorkDb'), recoveryDb: c.get('coreRecoveryDb'),
      actor: c.get('actor'), keyring: c.get('cryptoContext')?.keyring,
      nowMs: c.get('nowMs'), correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory, specialistId: c.req.param('specialistId'),
      body: c.get('jsonBody'), idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.updateSpecialistProfile ? { edit: deps.updateSpecialistProfile } : {}),
    })
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/clients/:clientId/edits', async (c) => {
    if (c.get('routeId') !== 'clients.edit') throw new AppError('NOT_FOUND')
    const input = {
      db: c.get('coreWorkDb'),
      recoveryDb: c.get('coreRecoveryDb'),
      actor: c.get('actor'),
      keyring: c.get('cryptoContext')?.keyring,
      nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
      clientId: c.req.param('clientId'),
      body: c.get('jsonBody'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.editClient ? { edit: deps.editClient } : {}),
    }
    const result = await (deps.postClientEdit ?? postClientEdit)(input)
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/clients/:clientId/archive', async (c) => {
    if (c.get('routeId') !== 'clients.archive') throw new AppError('NOT_FOUND')
    const input = {
      db: c.get('coreWorkDb'), recoveryDb: c.get('coreRecoveryDb'),
      actor: c.get('actor'), keyring: c.get('cryptoContext')?.keyring,
      nowMs: c.get('nowMs'), correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory, clientId: c.req.param('clientId'),
      body: c.get('jsonBody'), idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.archiveClient ? { archive: deps.archiveClient } : {}),
    }
    const result = await (deps.postClientArchive ?? postClientArchive)(input)
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/appointments', async (c) => {
    if (c.get('routeId') !== 'appointments.create') throw new AppError('NOT_FOUND')
    const input = {
      db: c.get('coreWorkDb'), recoveryDb: c.get('coreRecoveryDb'),
      actor: c.get('actor'), keyring: c.get('cryptoContext')?.keyring,
      nowMs: c.get('nowMs'), correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory, body: c.get('jsonBody'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.createAppointment ? { create: deps.createAppointment } : {}),
    }
    const result = await (deps.postAppointment ?? postAppointment)(input)
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/appointments/:appointmentId/edits', async (c) => {
    if (c.get('routeId') !== 'appointments.edit') throw new AppError('NOT_FOUND')
    const input = {
      db: c.get('coreWorkDb'), recoveryDb: c.get('coreRecoveryDb'),
      actor: c.get('actor'), keyring: c.get('cryptoContext')?.keyring,
      nowMs: c.get('nowMs'), correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
      appointmentId: c.req.param('appointmentId'), body: c.get('jsonBody'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.editAppointment ? { edit: deps.editAppointment } : {}),
    }
    const result = await (deps.postAppointmentEdit ?? postAppointmentEdit)(input)
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/appointments/:appointmentId/cancellation', async (c) => {
    if (c.get('routeId') !== 'appointments.cancel') throw new AppError('NOT_FOUND')
    const input = {
      db: c.get('coreWorkDb'), recoveryDb: c.get('coreRecoveryDb'),
      actor: c.get('actor'), keyring: c.get('cryptoContext')?.keyring,
      nowMs: c.get('nowMs'), correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
      appointmentId: c.req.param('appointmentId'), body: c.get('jsonBody'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.cancelAppointment ? { cancel: deps.cancelAppointment } : {}),
    }
    const result = await (deps.postAppointmentCancellation
      ?? postAppointmentCancellation)(input)
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/appointments/:appointmentId/payments', async (c) => {
    if (c.get('routeId') !== 'appointments.payment') throw new AppError('NOT_FOUND')
    const input = {
      db: c.get('coreWorkDb'), recoveryDb: c.get('coreRecoveryDb'),
      actor: c.get('actor'), keyring: c.get('cryptoContext')?.keyring,
      nowMs: c.get('nowMs'), correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
      appointmentId: c.req.param('appointmentId'), body: c.get('jsonBody'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.recordAppointmentPayment
        ? { recordPayment: deps.recordAppointmentPayment } : {}),
    }
    const result = await (deps.postAppointmentPayment ?? postAppointmentPayment)(input)
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/payments/:paymentId/corrections', async (c) => {
    if (c.get('routeId') !== 'payments.correct') throw new AppError('NOT_FOUND')
    const input = {
      db: c.get('coreWorkDb'), recoveryDb: c.get('coreRecoveryDb'),
      actor: c.get('actor'), keyring: c.get('cryptoContext')?.keyring,
      nowMs: c.get('nowMs'), correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
      paymentId: c.req.param('paymentId'), body: c.get('jsonBody'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.correctAppointmentPayment
        ? { correctPayment: deps.correctAppointmentPayment } : {}),
    }
    const result = await (deps.postPaymentCorrection ?? postPaymentCorrection)(input)
    return c.json(result.body, result.status)
  })
  app.get('/api/v1/finance', async (c) => {
    if (c.get('routeId') !== 'finance.list') throw new AppError('NOT_FOUND')
    const result = await (deps.getFinance ?? getFinance)({
      db: c.get('coreWorkDb'), actor: c.get('actor'),
      keyring: c.get('cryptoContext')?.keyring, nowMs: c.get('nowMs'), url: c.req.url,
      ...(deps.listFinanceEntries ? { list: deps.listFinanceEntries } : {}),
    })
    return readResponse(c, result)
  })
  app.post('/api/v1/finance/imports', async (c) => {
    if (c.get('routeId') !== 'finance.import.start') throw new AppError('NOT_FOUND')
    const result = await (deps.postFinanceImport ?? postFinanceImport)({
      db: c.get('coreWorkDb'), actor: c.get('actor'),
      keyring: c.get('cryptoContext')?.keyring, nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'), idFactory: deps.idFactory ?? idFactory,
      body: c.get('jsonBody'), idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.startFinanceImport ? { start: deps.startFinanceImport } : {}),
    })
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/finance/imports/:batchId/chunks', async (c) => {
    if (c.get('routeId') !== 'finance.import.chunk') throw new AppError('NOT_FOUND')
    const result = await (deps.postFinanceImportChunk ?? postFinanceImportChunk)({
      db: c.get('coreWorkDb'), actor: c.get('actor'),
      keyring: c.get('cryptoContext')?.keyring, nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'), idFactory: deps.idFactory ?? idFactory,
      batchId: c.req.param('batchId'), body: c.get('jsonBody'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.appendFinanceImportChunk ? { append: deps.appendFinanceImportChunk } : {}),
    })
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/finance/imports/:batchId/commit', async (c) => {
    if (c.get('routeId') !== 'finance.import.commit') throw new AppError('NOT_FOUND')
    const result = await (deps.postFinanceImportCommit ?? postFinanceImportCommit)({
      db: c.get('coreWorkDb'), actor: c.get('actor'),
      keyring: c.get('cryptoContext')?.keyring, nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'), idFactory: deps.idFactory ?? idFactory,
      batchId: c.req.param('batchId'), body: c.get('jsonBody'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      ...(deps.commitFinanceImport ? { commit: deps.commitFinanceImport } : {}),
    })
    return c.json(result.body, result.status)
  })
  app.post('/api/v1/workbooks/preview', async (c) => {
    if (c.get('routeId') !== 'workbooks.preview') throw new AppError('NOT_FOUND')
    const form = workbookForm(c.get('multipartBody'), ['workbook'])
    const file = await workbookFile(form.workbook)
    const config = runtimeConfig(c, deps)
    try {
      const stateLoader = deps.loadWorkbookPanelState ?? loadWorkbookPanelState
      const result = await (deps.previewWorkbook ?? previewWorkbook)({
        ...file,
        actor: c.get('actor'),
        keyring: c.get('cryptoContext')?.keyring,
        config,
        centreId: 'centre_1',
        nowMs: c.get('nowMs'),
        loadPanelState: (input) => stateLoader({
          db: c.get('coreWorkDb'),
          keyring: c.get('cryptoContext')?.keyring,
          ...input,
        }),
      })
      return c.json(result)
    } finally {
      file.bytes.fill(0)
    }
  })
  app.post('/api/v1/workbooks/imports', async (c) => {
    if (c.get('routeId') !== 'workbooks.import') throw new AppError('NOT_FOUND')
    const form = workbookForm(c.get('multipartBody'), ['previewToken', 'workbook'])
    if (typeof form.previewToken !== 'string') {
      throw new AppError('VALIDATION_FAILED', { field: 'body' })
    }
    const file = await workbookFile(form.workbook)
    const config = runtimeConfig(c, deps)
    try {
      const stateLoader = deps.loadWorkbookPanelState ?? loadWorkbookPanelState
      const result = await (deps.createWorkbookImport ?? createWorkbookImport)({
        db: c.get('coreWorkDb'),
        bucket: c.env?.ARCHIVE ?? deps.bucket,
        actor: c.get('actor'),
        keyring: c.get('cryptoContext')?.keyring,
        config,
        centreId: 'centre_1',
        nowMs: c.get('nowMs'),
        correlationId: c.get('correlationId'),
        idFactory: deps.idFactory ?? idFactory,
        ...file,
        previewToken: form.previewToken,
        idempotencyKey: c.req.header('Idempotency-Key'),
        loadPanelState: (input) => stateLoader({
          db: c.get('coreWorkDb'),
          keyring: c.get('cryptoContext')?.keyring,
          ...input,
        }),
      })
      return c.json(result.body, result.status)
    } finally {
      file.bytes.fill(0)
    }
  })
  app.post('/api/v1/workbooks/imports/:importId/continue', async (c) => {
    if (c.get('routeId') !== 'workbooks.continue') throw new AppError('NOT_FOUND')
    const form = workbookForm(c.get('multipartBody'), ['expectedVersion'])
    if (typeof form.expectedVersion !== 'string' || !/^[1-9]\d*$/.test(form.expectedVersion)) {
      throw new AppError('VALIDATION_FAILED', { field: 'expectedVersion' })
    }
    const expectedVersion = Number(form.expectedVersion)
    if (!Number.isSafeInteger(expectedVersion)) {
      throw new AppError('VALIDATION_FAILED', { field: 'expectedVersion' })
    }
    const result = await (deps.continueWorkbookImport ?? continueWorkbookImport)({
      db: c.get('coreWorkDb'),
      actor: c.get('actor'),
      keyring: c.get('cryptoContext')?.keyring,
      config: runtimeConfig(c, deps),
      centreId: 'centre_1',
      nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
      importId: c.req.param('importId'),
      expectedVersion,
      idempotencyKey: c.req.header('Idempotency-Key'),
    })
    return c.json(result.body, result.status)
  })
  app.get('/api/v1/workbooks/imports/:importId', async (c) => {
    if (c.get('routeId') !== 'workbooks.status') throw new AppError('NOT_FOUND')
    const result = await (deps.getWorkbookImport ?? getWorkbookImport)({
      db: c.get('coreWorkDb'),
      actor: c.get('actor'),
      nowMs: c.get('nowMs'),
      importId: c.req.param('importId'),
    })
    return readResponse(c, result)
  })
  app.get('/api/v1/workbooks/export', async (c) => {
    if (c.get('routeId') !== 'workbooks.export') throw new AppError('NOT_FOUND')
    const url = new URL(c.req.url)
    const keys = [...url.searchParams.keys()]
    if (keys.length !== 1 || keys[0] !== 'format') {
      throw new AppError('VALIDATION_FAILED', { field: 'body' })
    }
    const format = url.searchParams.get('format')
    if (!['legacy', 'panel-v2'].includes(format)) {
      throw new AppError('VALIDATION_FAILED', { field: 'body' })
    }
    if (url.search !== `?format=${format}`) {
      throw new AppError('VALIDATION_FAILED', { field: 'body' })
    }
    const result = await (deps.exportWorkbook ?? exportWorkbook)({
      db: c.get('coreWorkDb'),
      bucket: c.env?.ARCHIVE ?? deps.bucket,
      actor: c.get('actor'),
      keyring: c.get('cryptoContext')?.keyring,
      config: runtimeConfig(c, deps),
      centreId: 'centre_1',
      nowMs: c.get('nowMs'),
      format,
    })
    if (result?.bytes instanceof Uint8Array && result.bytes.byteLength > 10 * 1024 * 1024) {
      result.bytes.fill(0)
      throw new Error('WORKBOOK_EXPORT_LIMIT')
    }
    if (!(result?.bytes instanceof Uint8Array)
      || result.bytes.byteLength < 1
      || typeof result.filename !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.xlsx$/.test(result.filename)) {
      throw new Error('INTERNAL_ERROR')
    }
    const headers = {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'X-Content-Type-Options': 'nosniff',
    }
    if (c.req.method === 'HEAD') {
      result.bytes.fill(0)
      return new Response(null, { status: 200, headers })
    }
    return new Response(workbookStream(result.bytes), { status: 200, headers })
  })
  app.options('/api/v1/session', (c) => new Response(null, {
    status: 204,
    headers: { Allow: SESSION_ALLOW },
  }))
  app.get('/api/v1/staff', async (c) => {
    if (c.get('routeId') !== 'staff.list') throw new AppError('NOT_FOUND')
    const result = await (deps.getStaff ?? getStaff)({ db: c.env?.DB ?? deps.db, cryptoContext: c.get('cryptoContext'), actor: c.get('actor'), nowMs: c.get('nowMs'), correlationId: c.get('correlationId'), idFactory: deps.idFactory ?? idFactory })
    return c.req.method === 'HEAD' ? new Response(null, { status: 200 }) : c.json(result)
  })
  app.post('/api/v1/staff/invitations', async (c) => {
    if (c.get('routeId') !== 'staff.invitations') throw new AppError('NOT_FOUND')
    const result = await (deps.postInvitation ?? postInvitation)({ db: c.env?.DB ?? deps.db, cryptoContext: c.get('cryptoContext'), actor: c.get('actor'), nowMs: c.get('nowMs'), correlationId: c.get('correlationId'), idFactory: deps.idFactory ?? idFactory, idempotencyKey: c.req.header('Idempotency-Key'), body: c.get('jsonBody'), config: runtimeConfig(c, deps) })
    return c.json(result, 201)
  })
  app.post('/api/v1/staff/:staffId/deactivation', async (c) => {
    if (c.get('routeId') !== 'staff.deactivation') throw new AppError('NOT_FOUND')
    const result = await (deps.postDeactivation ?? postDeactivation)({ db: c.env?.DB ?? deps.db, cryptoContext: c.get('cryptoContext'), actor: c.get('actor'), nowMs: c.get('nowMs'), correlationId: c.get('correlationId'), idFactory: deps.idFactory ?? idFactory, idempotencyKey: c.req.header('Idempotency-Key'), body: c.get('jsonBody'), staffId: c.req.param('staffId'), config: runtimeConfig(c, deps) })
    return c.json(result)
  })
  app.post('/api/v1/specialists/:specialistId/invitations', async (c) => {
    if (c.get('routeId') !== 'specialists.invitations') throw new AppError('NOT_FOUND')
    const result = await (deps.postSpecialistInvitation ?? postSpecialistInvitation)({
      db: c.env?.DB ?? deps.db, cryptoContext: c.get('cryptoContext'),
      actor: c.get('actor'), nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'), idFactory: deps.idFactory ?? idFactory,
      idempotencyKey: c.req.header('Idempotency-Key'), body: c.get('jsonBody'),
      specialistId: c.req.param('specialistId'), config: runtimeConfig(c, deps),
    })
    return c.json(result, 201)
  })
  app.options('/api/v1/staff', (c) => {
    if (c.get('routeId') !== 'staff.list') throw new AppError('NOT_FOUND')
    return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, OPTIONS' } })
  })
  app.options('/api/v1/staff/invitations', (c) => {
    if (c.get('routeId') !== 'staff.invitations') throw new AppError('NOT_FOUND')
    return new Response(null, { status: 204, headers: { Allow: STAFF_MUTATION_ALLOW } })
  })
  app.options('/api/v1/staff/:staffId/deactivation', (c) => {
    if (c.get('routeId') !== 'staff.deactivation') throw new AppError('NOT_FOUND')
    return new Response(null, { status: 204, headers: { Allow: STAFF_MUTATION_ALLOW } })
  })
  app.options('/api/v1/specialists/:specialistId/invitations', (c) => {
    if (c.get('routeId') !== 'specialists.invitations') throw new AppError('NOT_FOUND')
    return new Response(null, { status: 204, headers: { Allow: STAFF_MUTATION_ALLOW } })
  })
  app.get('/api/v1/operations/health', async (c) => {
    if (c.get('routeId') !== 'operations.health') throw new AppError('NOT_FOUND')
    const result = await c.get('operationService')({
      db: c.env?.DB ?? deps.db,
      cryptoContext: c.get('cryptoContext'),
      actor: c.get('actor'),
      nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
    })
    return readResponse(c, result)
  })
  app.get('/api/v1/operations/actions', async (c) => {
    if (c.get('routeId') !== 'operations.actions') throw new AppError('NOT_FOUND')
    const result = await c.get('operationService')({
      db: c.env?.DB ?? deps.db,
      cryptoContext: c.get('cryptoContext'),
      actor: c.get('actor'),
      nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
    })
    return readResponse(c, result)
  })
  app.post('/api/v1/operations/actions/:actionId/resolution', async (c) => {
    if (c.get('routeId') !== 'operations.action-resolution') throw new AppError('NOT_FOUND')
    const result = await c.get('operationService')({
      db: c.env?.DB ?? deps.db,
      cryptoContext: c.get('cryptoContext'),
      actor: c.get('actor'),
      nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
      actionId: c.get('routeActionId'),
      idempotencyKey: c.req.header('Idempotency-Key'),
      body: c.get('jsonBody'),
    })
    return c.json(result)
  })
  app.get('/api/v1/security/audit', async (c) => {
    if (c.get('routeId') !== 'security.audit') throw new AppError('NOT_FOUND')
    const result = await c.get('operationService')({
      db: c.env?.DB ?? deps.db,
      cryptoContext: c.get('cryptoContext'),
      actor: c.get('actor'),
      nowMs: c.get('nowMs'),
      correlationId: c.get('correlationId'),
      idFactory: deps.idFactory ?? idFactory,
      query: new URL(c.req.url).searchParams,
    })
    return readResponse(c, result)
  })
  for (const path of [
    '/api/v1/operations/health',
    '/api/v1/operations/actions',
    '/api/v1/security/audit',
  ]) {
    app.options(path, (c) => {
      if (!['operations.health', 'operations.actions', 'security.audit'].includes(c.get('routeId'))) {
        throw new AppError('NOT_FOUND')
      }
      return new Response(null, { status: 204, headers: { Allow: OPERATIONS_READ_ALLOW } })
    })
  }
  app.options('/api/v1/operations/actions/:actionId/resolution', (c) => {
    if (c.get('routeId') !== 'operations.action-resolution') throw new AppError('NOT_FOUND')
    return new Response(null, { status: 204, headers: { Allow: OPERATIONS_MUTATION_ALLOW } })
  })
  app.options('/api/v1/*', (c) => {
    const route = CORE_ROUTES.find(({ id }) => id === c.get('routeId'))
    if (!route) throw new AppError('NOT_FOUND')
    return new Response(null, { status: 204, headers: { Allow: route.allow } })
  })
  app.notFound((c) => {
    const correlationId = c.get('correlationId') || crypto.randomUUID()
    c.set('errorCode', 'NOT_FOUND')
    return apiError(new AppError('NOT_FOUND'), correlationId)
  })
  app.onError((error, c) => {
    const mapped = publicError(error)
    const headers = mapped.code === 'METHOD_NOT_ALLOWED'
      ? { Allow: c.get('routeAllow') ?? (c.get('routeId') === 'health.live' ? HEALTH_ALLOW : c.get('routeId') === 'session' ? SESSION_ALLOW : c.get('routeId') === 'staff.list' ? 'GET, HEAD, OPTIONS' : c.get('routeId') === 'staff.invitations' || c.get('routeId') === 'staff.deactivation' ? STAFF_MUTATION_ALLOW : 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE') }
      : mapped.code === 'ACCESS_KEYSET_UNAVAILABLE' ? { 'Retry-After': '5' }
        : undefined
    return apiError(mapped, c.get('correlationId') || crypto.randomUUID(), headers)
  })
  return app
}
