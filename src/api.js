import { APP_MODE } from './app-mode.js'

const API_ROOT = '/api/v1'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CSRF_TOKEN = /^v1\.([1-9]\d*)\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INVALID_TEXT = /[\p{Cc}\p{Cf}]/u

const SERVER_STATUS = Object.freeze({
  INVALID_CONTENT_LENGTH: 400,
  INVALID_JSON: 400,
  VALIDATION_FAILED: 400,
  ACCESS_ASSERTION_INVALID: 401,
  ACCESS_DENIED: 403,
  FORBIDDEN: 403,
  ORIGIN_INVALID: 403,
  FETCH_METADATA_INVALID: 403,
  CSRF_INVALID: 403,
  CSRF_EXPIRED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  IDEMPOTENCY_CONFLICT: 409,
  STAFF_INVITATION_CONFLICT: 409,
  LAST_ACTIVE_OWNER: 409,
  VERSION_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  ACCESS_KEYSET_UNAVAILABLE: 503,
})
const CLIENT_CODES = new Set([
  'CLIENT_INPUT_INVALID',
  'INVALID_RESPONSE',
  'NETWORK_ERROR',
  'SESSION_REQUIRED',
])
const AUTH_DENIAL_CODES = new Set(['ACCESS_ASSERTION_INVALID', 'ACCESS_DENIED'])
const DETAIL_FIELDS = new Set(['displayName', 'email', 'role', 'version'])
const CAPABILITIES = new Set([
  'appointment.charge.read',
  'appointment.manage',
  'centre.manage',
  'chat.direct',
  'chat.general',
  'client.operational.read',
  'clinical.read',
  'finance.centre.read',
  'operations.health.read',
  'payment.manage',
  'security.audit.read',
  'staff.manage',
  'tus.manage',
])
const ROLES = new Set(['owner', 'coordinator', 'specialist'])
const STAFF_STATUSES = new Set(['active', 'disabled', 'pending'])
const INVITATION_STATUSES = new Set(['pending', 'provisioning'])
const ENVIRONMENTS = new Set(['development', 'staging', 'production'])

const plainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const validId = (value) => typeof value === 'string' && ID.test(value)
const validText = (value, maxBytes) => typeof value === 'string' && value.length > 0
  && value === value.normalize('NFC') && value === value.trim() && !INVALID_TEXT.test(value)
  && new TextEncoder().encode(value).byteLength <= maxBytes
const validIso = (value) => {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}
const safeCode = (code) => Object.hasOwn(SERVER_STATUS, code) || CLIENT_CODES.has(code)
  ? code
  : 'INTERNAL_ERROR'

const safeDetails = (details) => {
  if (!plainObject(details)) return undefined
  const result = {}
  if (DETAIL_FIELDS.has(details.field)) result.field = details.field
  if (Number.isSafeInteger(details.currentVersion) && details.currentVersion >= 0) {
    result.currentVersion = details.currentVersion
  }
  if (Number.isSafeInteger(details.limit) && details.limit >= 0) result.limit = details.limit
  if (Number.isSafeInteger(details.retryAfterSeconds) && details.retryAfterSeconds >= 0) {
    result.retryAfterSeconds = details.retryAfterSeconds
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export class ApiError extends Error {
  constructor(code, {
    status = 0,
    details,
    correlationId,
    idempotencyKey,
  } = {}) {
    const acceptedCode = safeCode(code)
    super(acceptedCode)
    this.name = 'ApiError'
    this.code = acceptedCode
    this.status = Number.isSafeInteger(status) && status >= 0 && status <= 599 ? status : 0
    const acceptedDetails = safeDetails(details)
    if (acceptedDetails) this.details = acceptedDetails
    if (UUID.test(correlationId ?? '')) this.correlationId = correlationId
    if (IDEMPOTENCY_KEY.test(idempotencyKey ?? '')) this.idempotencyKey = idempotencyKey
  }
}

const clientError = (code, options) => new ApiError(code, options)

const acceptedActor = (value) => {
  if (!plainObject(value) || !validId(value.id) || !validText(value.displayName, 120)
    || !ROLES.has(value.role)
    || (value.specialistId !== null && !validId(value.specialistId))
    || (value.role === 'specialist' && !validId(value.specialistId))) {
    return null
  }
  return Object.freeze({
    id: value.id,
    displayName: value.displayName,
    role: value.role,
    specialistId: value.specialistId,
  })
}

const acceptedSession = (payload) => {
  const value = plainObject(payload) && plainObject(payload.data) ? payload.data : null
  const actor = acceptedActor(value?.actor)
  if (!actor || !Array.isArray(value.capabilities) || value.capabilities.length === 0
    || value.capabilities.some((capability) => (
      typeof capability !== 'string' || !CAPABILITIES.has(capability)
    ))
    || new Set(value.capabilities).size !== value.capabilities.length
    || !ENVIRONMENTS.has(value.environment) || value.dataMode !== 'fictional'
    || !validIso(value.csrfExpiresAt)) {
    return null
  }
  const match = typeof value.csrfToken === 'string' ? CSRF_TOKEN.exec(value.csrfToken) : null
  const expiresUnix = Number(match?.[1])
  if (!match || !Number.isSafeInteger(expiresUnix)
    || Date.parse(value.csrfExpiresAt) / 1000 !== expiresUnix) {
    return null
  }
  const session = Object.freeze({
    actor,
    capabilities: Object.freeze([...value.capabilities]),
    csrfExpiresAt: value.csrfExpiresAt,
    environment: value.environment,
    dataMode: value.dataMode,
  })
  return Object.freeze({
    csrfToken: value.csrfToken,
    session,
  })
}

const acceptedInvitation = (value) => {
  if (!plainObject(value) || !validId(value.id) || !INVITATION_STATUSES.has(value.status)
    || !validIso(value.expiresAt)
    || (value.emailSentAt !== null && !validIso(value.emailSentAt))
    || !Number.isSafeInteger(value.version) || value.version < 1) {
    return null
  }
  return Object.freeze({
    id: value.id,
    status: value.status,
    expiresAt: value.expiresAt,
    emailSentAt: value.emailSentAt,
    version: value.version,
  })
}

const acceptedStaff = (value, withInvitation) => {
  if (!plainObject(value) || !validId(value.id) || !validText(value.displayName, 120)
    || !validText(value.email, 320) || !ROLES.has(value.role)
    || !STAFF_STATUSES.has(value.status)
    || !Number.isSafeInteger(value.version) || value.version < 1
    || (value.specialistId !== null && !validId(value.specialistId))
    || (value.role === 'specialist' && !validId(value.specialistId))) {
    return null
  }
  const invitation = withInvitation && value.invitation !== null
    ? acceptedInvitation(value.invitation)
    : null
  if (withInvitation && value.invitation !== null && !invitation) return null
  return Object.freeze({
    id: value.id,
    displayName: value.displayName,
    email: value.email,
    role: value.role,
    status: value.status,
    version: value.version,
    specialistId: value.specialistId,
    ...(withInvitation ? { invitation } : {}),
  })
}

const acceptedStaffList = (payload) => {
  const values = plainObject(payload) && plainObject(payload.data)
    ? payload.data.staff
    : null
  if (!Array.isArray(values)) return null
  const staff = values.map((value) => acceptedStaff(value, true))
  if (staff.some((value) => value === null)) return null
  return Object.freeze({ staff: Object.freeze(staff) })
}

const acceptedInvitationResult = (payload) => {
  const value = plainObject(payload) && plainObject(payload.data) ? payload.data : null
  const staff = acceptedStaff(value?.staff, false)
  const invitation = acceptedInvitation(value?.invitation)
  return staff && invitation ? Object.freeze({ staff, invitation }) : null
}

const acceptedDeactivationResult = (payload) => {
  const value = plainObject(payload) && plainObject(payload.data) ? payload.data : null
  const staff = acceptedStaff(value?.staff, false)
  return staff ? Object.freeze({ staff }) : null
}

const acceptedInviteInput = (input) => plainObject(input)
  && Object.keys(input).length === 3
  && Object.hasOwn(input, 'displayName')
  && Object.hasOwn(input, 'email')
  && Object.hasOwn(input, 'role')
  && validText(input.displayName, 120)
  && validText(input.email, 320)
  && ROLES.has(input.role)

const acceptedKey = (value) => typeof value === 'string' && IDEMPOTENCY_KEY.test(value)

const idempotencyOptions = (options) => {
  try {
    if (!plainObject(options)) return null
    return { idempotencyKey: options.idempotencyKey }
  } catch {
    return null
  }
}

const serverError = (payload, status, idempotencyKey) => {
  const value = plainObject(payload) && plainObject(payload.error) ? payload.error : null
  if (!value || !Object.hasOwn(SERVER_STATUS, value.code) || SERVER_STATUS[value.code] !== status) {
    return clientError('INVALID_RESPONSE', { status, idempotencyKey })
  }
  return new ApiError(value.code, {
    status,
    details: value.details,
    correlationId: value.correlationId,
    idempotencyKey: status >= 500 ? idempotencyKey : undefined,
  })
}

const responseStatus = (response) => {
  const status = response?.status
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? status
    : 0
}

const defaultFetch = (...args) => globalThis.fetch(...args)
const defaultIdempotencyKey = () => globalThis.crypto?.randomUUID?.()

const makeApiClient = ({ fetchImpl, idempotencyKeyFactory, localIdentity }) => {
  if (typeof fetchImpl !== 'function' || typeof idempotencyKeyFactory !== 'function') {
    throw clientError('CLIENT_INPUT_INVALID')
  }

  let csrfToken = null
  const listeners = new Set()
  const baseHeaders = () => ({
    Accept: 'application/json',
    ...(localIdentity ? { 'X-BWM-Local-Identity': localIdentity } : {}),
  })
  const notifySession = (session) => {
    for (const listener of [...listeners]) {
      try {
        const result = listener(session)
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {})
        }
      } catch {
        // A consumer cannot change authentication or request classification.
      }
    }
  }
  const clearSession = () => {
    csrfToken = null
    notifySession(null)
  }
  const requestJson = async (path, init, {
    validate,
    idempotencyKey,
  } = {}) => {
    let response
    try {
      response = await fetchImpl(path, init)
    } catch {
      throw clientError('NETWORK_ERROR', {
        idempotencyKey,
      })
    }
    let status
    let ok
    let parseJson
    try {
      status = responseStatus(response)
      ok = response?.ok
      parseJson = response?.json
    } catch {
      throw clientError('INVALID_RESPONSE', { idempotencyKey })
    }
    if (!status || typeof ok !== 'boolean' || typeof parseJson !== 'function') {
      throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    }
    let payload
    try {
      payload = await parseJson.call(response)
    } catch {
      throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    }
    if (!ok) {
      let error
      try {
        error = serverError(payload, status, idempotencyKey)
      } catch {
        throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
      }
      if (AUTH_DENIAL_CODES.has(error.code)) clearSession()
      throw error
    }
    let result
    try {
      result = validate(payload)
    } catch {
      throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    }
    if (!result) throw clientError('INVALID_RESPONSE', { status, idempotencyKey })
    return result
  }
  const getSession = async () => {
    const accepted = await requestJson(`${API_ROOT}/session`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: baseHeaders(),
    }, {
      validate: acceptedSession,
    })
    csrfToken = accepted.csrfToken
    notifySession(accepted.session)
    return accepted.session
  }
  const listStaff = () => requestJson(`${API_ROOT}/staff`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: baseHeaders(),
  }, {
    validate: acceptedStaffList,
  })
  const createIdempotencyKey = () => {
    let value
    try {
      value = idempotencyKeyFactory()
    } catch {
      throw clientError('CLIENT_INPUT_INVALID')
    }
    if (!acceptedKey(value)) throw clientError('CLIENT_INPUT_INVALID')
    return value
  }
  const mutation = async (path, body, validate, suppliedKey) => {
    const idempotencyKey = suppliedKey === undefined
      ? createIdempotencyKey()
      : suppliedKey
    if (!acceptedKey(idempotencyKey)) throw clientError('CLIENT_INPUT_INVALID')
    if (!csrfToken) throw clientError('SESSION_REQUIRED')
    const send = () => requestJson(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        ...baseHeaders(),
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'Idempotency-Key': idempotencyKey,
      },
      body,
    }, {
      validate,
      idempotencyKey,
    })
    try {
      return await send()
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'CSRF_EXPIRED') throw error
    }
    await getSession()
    return send()
  }
  const inviteStaff = (input, options = {}) => {
    const acceptedOptions = idempotencyOptions(options)
    if (!acceptedOptions) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    const { idempotencyKey } = acceptedOptions
    if (idempotencyKey !== undefined && !acceptedKey(idempotencyKey)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    let body
    try {
      if (!acceptedInviteInput(input)) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
      body = JSON.stringify(input)
    } catch {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    return mutation(
      `${API_ROOT}/staff/invitations`,
      body,
      acceptedInvitationResult,
      idempotencyKey,
    )
  }
  const deactivateStaff = (staffId, version, options = {}) => {
    const acceptedOptions = idempotencyOptions(options)
    if (!acceptedOptions) return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    const { idempotencyKey } = acceptedOptions
    if (idempotencyKey !== undefined && !acceptedKey(idempotencyKey)) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    if (!csrfToken) return Promise.reject(clientError('SESSION_REQUIRED'))
    if (typeof staffId !== 'string' || !STAFF_ID.test(staffId)
      || !Number.isSafeInteger(version) || version < 1) {
      return Promise.reject(clientError('CLIENT_INPUT_INVALID'))
    }
    return mutation(
      `${API_ROOT}/staff/${staffId}/deactivation`,
      JSON.stringify({ version }),
      acceptedDeactivationResult,
      idempotencyKey,
    )
  }
  const subscribeSession = (listener) => {
    if (typeof listener !== 'function') throw clientError('CLIENT_INPUT_INVALID')
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return Object.freeze({
    getSession,
    listStaff,
    inviteStaff,
    deactivateStaff,
    createIdempotencyKey,
    clearSession,
    subscribeSession,
  })
}

export function createApiClient(options = {}) {
  let fetchImpl
  let idempotencyKeyFactory
  try {
    if (!plainObject(options)) throw clientError('CLIENT_INPUT_INVALID')
    fetchImpl = options.fetchImpl === undefined ? defaultFetch : options.fetchImpl
    idempotencyKeyFactory = options.idempotencyKeyFactory === undefined
      ? defaultIdempotencyKey
      : options.idempotencyKeyFactory
  } catch {
    throw clientError('CLIENT_INPUT_INVALID')
  }
  return makeApiClient({
    fetchImpl,
    idempotencyKeyFactory,
    localIdentity: null,
  })
}

const viteLocalIdentity = import.meta.env?.DEV === true
  && APP_MODE === 'app'
  && typeof import.meta.env?.VITE_BWM_LOCAL_IDENTITY === 'string'
  && import.meta.env.VITE_BWM_LOCAL_IDENTITY.trim()
  ? import.meta.env.VITE_BWM_LOCAL_IDENTITY.trim()
  : null

export const apiClient = makeApiClient({
  fetchImpl: defaultFetch,
  idempotencyKeyFactory: defaultIdempotencyKey,
  localIdentity: viteLocalIdentity,
})
